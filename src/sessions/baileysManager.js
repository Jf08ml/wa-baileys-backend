// src/sessions/baileysManager.js
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WAMessageStatus,
} from "baileys";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Registro central de sesiones
// ---------------------------------------------------------------------------
const SESSIONS = {};        // clientId -> sock (socket activo)
const SESSION_STATE = {};   // clientId -> { status, reason, lastQrAt, lastReadyAt, me, pairingCode? }
const CREATING = new Map(); // clientId -> Promise  — MUTEX anti-socket-duplicado
const DESTROYING = new Set(); // clientIds en destrucción intencional — bloquea reconexión automática
const BACKOFF = new Map();  // clientId -> número de intento actual (backoff exponencial)

// clientId -> Map<messageId, { errorCode, ts }> — acks de error (ej. "463"
// account restricted) que WhatsApp envía de forma ASÍNCRONA después de que
// sock.sendMessage() ya resolvió con éxito (el socket solo confirma que el
// mensaje se puso en curso, no que WhatsApp lo haya aceptado de verdad).
// bulkManager.js consulta esto tras un breve margen para no contar como
// "enviado" un mensaje que en realidad fue rechazado.
const MESSAGE_ACK_ERRORS = new Map();
const ACK_ERROR_TTL_MS = 5 * 60 * 1000;

function recordAckError(clientId, messageId, errorCode) {
  if (!MESSAGE_ACK_ERRORS.has(clientId)) MESSAGE_ACK_ERRORS.set(clientId, new Map());
  MESSAGE_ACK_ERRORS.get(clientId).set(messageId, { errorCode, ts: Date.now() });
}

export function getAckError(clientId, messageId) {
  return MESSAGE_ACK_ERRORS.get(clientId)?.get(messageId) || null;
}

setInterval(() => {
  const cutoff = Date.now() - ACK_ERROR_TTL_MS;
  for (const [clientId, byMsg] of MESSAGE_ACK_ERRORS) {
    for (const [msgId, v] of byMsg) {
      if (v.ts < cutoff) byMsg.delete(msgId);
    }
    if (byMsg.size === 0) MESSAGE_ACK_ERRORS.delete(clientId);
  }
}, 60_000).unref();

// clientId -> Map<messageId, { externalRef, ts }> — correlación entre un
// mensaje enviado y la referencia externa del caller (ej. "confirmation:<id>"
// o "reminder:<id1>,<id2>"), para poder reenviarle el ack real de entrega
// (SERVER_ACK/DELIVERY_ACK) cuando llegue. TTL más largo que el de errores:
// un DELIVERY_ACK puede tardar horas si el destinatario está sin señal.
const MESSAGE_CONTEXT = new Map();
const MESSAGE_CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;

function setMessageContext(clientId, messageId, externalRef) {
  if (!messageId || !externalRef) return;
  if (!MESSAGE_CONTEXT.has(clientId)) MESSAGE_CONTEXT.set(clientId, new Map());
  MESSAGE_CONTEXT.get(clientId).set(messageId, { externalRef, ts: Date.now() });
}

function getMessageContext(clientId, messageId) {
  return MESSAGE_CONTEXT.get(clientId)?.get(messageId) || null;
}

setInterval(() => {
  const cutoff = Date.now() - MESSAGE_CONTEXT_TTL_MS;
  for (const [clientId, byMsg] of MESSAGE_CONTEXT) {
    for (const [msgId, v] of byMsg) {
      if (v.ts < cutoff) byMsg.delete(msgId);
    }
    if (byMsg.size === 0) MESSAGE_CONTEXT.delete(clientId);
  }
}, 5 * 60_000).unref();

// SERVER_ACK (✓, aceptado por el server de WA) / DELIVERY_ACK (✓✓, entregado
// al dispositivo) / ERROR → estados simples que le interesan al backend de
// AgenditApp para depurar entregas reales. READ/PLAYED se ignoran a propósito.
const DELIVERY_STATUS_BY_ACK = {
  [WAMessageStatus.SERVER_ACK]: "sent",
  [WAMessageStatus.DELIVERY_ACK]: "delivered",
  [WAMessageStatus.ERROR]: "failed",
};

/**
 * Reenvía el status real de entrega de un mensaje al backend de AgenditApp.
 * Fire-and-forget, mismo patrón/timeout que forwardToAgent.
 */
async function forwardStatusToBackend(payload) {
  if (!env.AGENDITAPP_BACKEND_URL || !env.WA_AGENT_SECRET) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(`${env.AGENDITAPP_BACKEND_URL}/api/wa-agent/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WA-Agent-Secret": env.WA_AGENT_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

let BAILEYS_VERSION;
const QR_TTL_MS = 20_000;

// Backoff exponencial: 2 s → 5 s → 10 s → 30 s (máximo)
const BACKOFF_DELAYS = [2_000, 5_000, 10_000, 30_000];

// DisconnectReasons que NO deben disparar reconexión automática
const NO_RECONNECT_REASONS = new Set([
  DisconnectReason.loggedOut,           // 401 — sesión cerrada por el usuario en el teléfono
  DisconnectReason.badSession,          // 500 — estado Signal corrompido
  DisconnectReason.multideviceMismatch, // 411 — conflicto entre dispositivos
  DisconnectReason.connectionReplaced,  // 440 — otra instancia tomó la sesión
]);

// Subset que además necesita borrar el auth del disco antes de detenerse
const CLEAN_AUTH_REASONS = new Set([
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
]);

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function deleteAuthDir(clientId) {
  const dir = path.join(env.AUTH_ROOT, clientId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.warn("[session] auth dir eliminado por sesión inválida", { clientId });
  } catch (e) {
    logger.error("[session] no se pudo eliminar auth dir", { clientId, error: e?.message });
  }
}

// Pool de fingerprints [os, browser, osVersion] — evita Linux/Ubuntu (más asociado
// a bots/farms por la protección anti-abuso de WhatsApp) y evita reusar siempre el
// mismo fingerprint desde la misma IP, lo cual es en sí una señal de tráfico no humano.
const BROWSER_FINGERPRINT_POOL = [
  ["Windows", "Chrome", "10.0.19045"],
  ["Windows", "Chrome", "10.0.22631"],
  ["Windows", "Edge", "10.0.22631"],
  ["Mac OS", "Chrome", "14.4.1"],
  ["Mac OS", "Chrome", "13.6.6"],
  ["Mac OS", "Safari", "17.4.1"],
];

/**
 * Devuelve el fingerprint de navegador para `clientId`, eligiendo uno al azar la
 * primera vez y persistiéndolo junto a las credenciales — debe mantenerse estable
 * entre reconexiones de una misma sesión ya vinculada (cambiarlo en cada reconexión
 * sería, otra vez, una señal de bot).
 */
function getBrowserFingerprint(clientId, authDir) {
  const filePath = path.join(authDir, "fingerprint.json");
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (Array.isArray(saved) && saved.length === 3) return saved;
  } catch {}

  const picked = BROWSER_FINGERPRINT_POOL[Math.floor(Math.random() * BROWSER_FINGERPRINT_POOL.length)];
  try {
    fs.writeFileSync(filePath, JSON.stringify(picked));
  } catch (e) {
    logger.warn("[session] no se pudo persistir el fingerprint de navegador", { clientId, error: e?.message });
  }
  return picked;
}

function getBackoffDelay(clientId) {
  const attempt = BACKOFF.get(clientId) || 0;
  const delay = BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)];
  BACKOFF.set(clientId, attempt + 1);
  return delay;
}

function resetBackoff(clientId) {
  BACKOFF.delete(clientId);
}

function setState(clientId, patch) {
  SESSION_STATE[clientId] = { ...(SESSION_STATE[clientId] || {}), ...patch };
}

export function getState(clientId) {
  return SESSION_STATE[clientId] || { status: "disconnected" };
}

function emitStatus(io, clientId, code, reason = "") {
  setState(clientId, { status: code, reason });
  io.to(clientId).emit("status", { clientId, code, reason, ts: Date.now() });
}

/**
 * Reenvía un mensaje al backend de AgenditApp para que el agente lo procese.
 * Fire-and-forget: el caller debe manejar el .catch() — nunca await aquí.
 */
async function forwardToAgent(payload) {
  if (!env.AGENDITAPP_BACKEND_URL || !env.WA_AGENT_SECRET) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(`${env.AGENDITAPP_BACKEND_URL}/api/wa-agent/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-WA-Agent-Secret": env.WA_AGENT_SECRET,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Corre `promise` con un timeout en ms.
 * Protege sendMessage de cuelgues indefinidos (FASE 6).
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Versión Baileys
// ---------------------------------------------------------------------------

// Build de WA Web fijada manualmente: fetchLatestBaileysVersion() puede devolver
// builds nuevas que WhatsApp rechaza con 405 "Connection Failure" al registrar
// dispositivos nuevos (bug reportado en WhiskeySockets/Baileys#2370). Se fija una
// build estable confirmada por la comunidad hasta que se resuelva upstream.
const PINNED_WA_VERSION = [2, 3000, 1033893291];

export async function initBaileysVersion() {
  if (!BAILEYS_VERSION) {
    BAILEYS_VERSION = PINNED_WA_VERSION;
    logger.info("[session] Baileys version fijada (workaround 405)", { version: BAILEYS_VERSION.join(".") });
  }
  return BAILEYS_VERSION;
}

// ---------------------------------------------------------------------------
// Creación de sesión con MUTEX (FASE 4)
// ---------------------------------------------------------------------------

/**
 * Retorna el socket activo para `clientId`, o crea uno nuevo.
 *
 * MUTEX: si ya hay una creación en curso para el mismo clientId,
 * la siguiente llamada espera esa promesa en lugar de crear un segundo socket.
 * Elimina la race condition de sockets duplicados con el mismo auth state.
 */
export async function getOrCreateClient({ clientId, io, phoneNumber }) {
  // 1. Socket activo → retornar directamente
  if (SESSIONS[clientId]) return SESSIONS[clientId];

  // 2. Creación ya en curso → esperar la misma promesa (mutex)
  if (CREATING.has(clientId)) {
    logger.warn("[session] creación ya en curso, esperando promesa existente", { clientId });
    return CREATING.get(clientId);
  }

  // 3. Registrar promesa en el mutex y ejecutar
  const promise = _doCreate({ clientId, io, phoneNumber });
  CREATING.set(clientId, promise);
  try {
    return await promise;
  } finally {
    CREATING.delete(clientId);
  }
}

async function _doCreate({ clientId, io, phoneNumber }) {
  const authDir = path.join(env.AUTH_ROOT, clientId);
  ensureDir(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const version = await initBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    // Fingerprint aleatorio (y estable por sesión, ver getBrowserFingerprint) — un
    // fingerprint fijo ["Ubuntu","Chrome","20.0.04"] con versión de OS inexistente
    // contribuía al 405 "Connection Failure" en registros nuevos (WhiskeySockets/Baileys#2370).
    browser: getBrowserFingerprint(clientId, authDir),
  });

  SESSIONS[clientId] = sock;
  setState(clientId, { status: "connecting", reason: "", lastQrPayload: null, lastPairingPayload: null });
  emitStatus(io, clientId, "connecting");

  // Capturar "me" si ya está disponible al momento de crear
  try {
    if (sock.user) setState(clientId, { me: sock.user });
  } catch {}

  // Variables de control locales al closure de este socket específico
  let lastQrEmitted = null;
  let lastQrSeq = 0;
  let pairingRequested = false;

  // -------------------------------------------------------------------------
  // LISTENER: creds.update — persistir credenciales (FASE 2)
  // -------------------------------------------------------------------------
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
    } catch (e) {
      logger.error("[session] creds.update: error al persistir credenciales", {
        clientId,
        error: e?.message,
        stack: e?.stack,
      });
    }
  });

  // -------------------------------------------------------------------------
  // LISTENER: connection.update — gestión de reconexión (FASES 2, 3, 5)
  // -------------------------------------------------------------------------
  sock.ev.on("connection.update", async (u) => {
    try {
      const { connection, lastDisconnect, qr } = u;
      const statusCode = lastDisconnect?.error?.output?.statusCode;

      // Log estructurado de cada cambio de estado (FASE 5)
      logger.info("[session] connection.update", {
        clientId,
        connection: connection ?? "n/a",
        statusCode: statusCode ?? "n/a",
        ts: new Date().toISOString(),
      });

      // --- Pairing code (phoneNumber en lugar de QR) ---
      if (qr && phoneNumber && !pairingRequested && !sock.authState?.creds?.registered) {
        pairingRequested = true;
        const normalized = String(phoneNumber).replace(/\D/g, "");
        logger.info("[session] solicitando pairing code", { clientId, phone: normalized });

        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(normalized);
            const pretty = code?.match(/.{1,4}/g)?.join("-") || code || "";
            const pairingPayload = { code: pretty, raw: code, phone: normalized };
            setState(clientId, { pairingCode: pretty, lastPairingPayload: pairingPayload });
            io.to(clientId).emit("pairing_code", pairingPayload);
            logger.info("[session] pairing code emitido", { clientId, code: pretty });
          } catch (e) {
            pairingRequested = false; // permitir reintento si falla
            logger.error("[session] error al pedir pairing code", {
              clientId,
              error: e?.message,
            });
            io.to(clientId).emit("pairing_error", { error: e?.message });
          }
        }, 2_000);
      }

      // --- QR tradicional ---
      if (qr && qr !== lastQrEmitted && !phoneNumber) {
        lastQrSeq += 1;
        const issuedAt = Date.now();
        const expiresAt = issuedAt + QR_TTL_MS;
        const seq = lastQrSeq;
        const replacesPrevious = Boolean(lastQrEmitted);
        const qrId = crypto
          .createHash("sha1")
          .update(qr)
          .digest("hex")
          .slice(0, 8);

        lastQrEmitted = qr;
        const qrPayload = {
          clientId, qr, issuedAt, expiresAt, ttlMs: QR_TTL_MS, seq, replacesPrevious, qrId,
        };
        setState(clientId, { lastQrAt: issuedAt, lastQrPayload: qrPayload });
        emitStatus(io, clientId, "waiting_qr");
        io.to(clientId).emit("qr", qrPayload);
      }

      // --- Conexión abierta ---
      if (connection === "open") {
        resetBackoff(clientId); // reconexión exitosa → contador de backoff a cero
        setState(clientId, {
          lastReadyAt: Date.now(),
          me: sock.user || null,
          lastQrPayload: null,
          lastPairingPayload: null,
        });
        emitStatus(io, clientId, "ready");
        logger.info("[session] sesión ready", { clientId });
      }

      // --- Conexión cerrada (FASE 3) ---
      if (connection === "close") {
        // Cierre intencional (logout / restart manual) → no reconectar
        if (DESTROYING.has(clientId)) {
          logger.info("[session] cierre intencional detectado, sin reconexión", { clientId });
          return;
        }

        // Auth corrompido → limpiar disco, no reconectar
        if (CLEAN_AUTH_REASONS.has(statusCode)) {
          logger.warn("[session] auth inválido, eliminando credenciales y deteniendo sesión", {
            clientId,
            statusCode,
          });
          delete SESSIONS[clientId];
          deleteAuthDir(clientId);
          emitStatus(io, clientId, "disconnected", String(statusCode));
          return;
        }

        // Razón fatal sin posibilidad de corrección automática → no reconectar
        if (NO_RECONNECT_REASONS.has(statusCode)) {
          logger.warn("[session] desconexión sin reconexión automática", { clientId, statusCode });
          delete SESSIONS[clientId];
          emitStatus(io, clientId, "disconnected", String(statusCode));
          return;
        }

        // Desconexión recuperable → reconexión con backoff exponencial
        const delay = getBackoffDelay(clientId);
        logger.info("[session] desconexión recuperable, reconectando con backoff", {
          clientId,
          statusCode: statusCode ?? "undefined",
          delayMs: delay,
        });
        emitStatus(io, clientId, "reconnecting", String(statusCode ?? ""));
        delete SESSIONS[clientId];

        setTimeout(() => {
          // Guardia final: si alguien ya recreó la sesión durante el backoff, no crear otra
          if (SESSIONS[clientId] || CREATING.has(clientId) || DESTROYING.has(clientId)) {
            logger.info("[session] sesión ya gestionada durante backoff, skip", { clientId });
            return;
          }
          getOrCreateClient({ clientId, io, phoneNumber }).catch((e) => {
            logger.error("[session] error en reconexión automática", {
              clientId,
              error: e?.message,
              stack: e?.stack,
            });
          });
        }, delay);
      }
    } catch (e) {
      // Ninguna excepción en un listener puede propagarse hacia arriba (FASE 2)
      logger.error("[session] excepción no controlada en connection.update", {
        clientId,
        error: e?.message,
        stack: e?.stack,
      });
    }
  });

  // -------------------------------------------------------------------------
  // LISTENER: messages.update — capturar acks de error (ej. 463 "account
  // restricted") que llegan async DESPUÉS de que sendMessage() ya resolvió.
  // Sin esto, un bulk send puede contar como "sent" un mensaje que WhatsApp
  // rechazó en el acto (ver baileysManager.js#getAckError / bulkManager.js).
  // -------------------------------------------------------------------------
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates || []) {
      const messageId = u.key?.id;
      if (!messageId) continue;

      if (u.update?.status === WAMessageStatus.ERROR) {
        const errorCode = u.update?.messageStubParameters?.[0];
        recordAckError(clientId, messageId, errorCode);
        logger.warn("[session] ack de error recibido para mensaje enviado", {
          clientId,
          messageId,
          errorCode,
        });
      }

      // Tracking real de entrega (ver MESSAGE_CONTEXT arriba) — solo reenvía si
      // este mensaje fue registrado con un externalRef al enviarse (envío
      // individual o bulk de reminders/confirmaciones); el resto de statuses
      // de messages.update (ej. mensajes de otro dispositivo de la misma
      // cuenta) se ignora sin costo, no matchea nada en el mapa.
      const deliveryStatus = DELIVERY_STATUS_BY_ACK[u.update?.status];
      if (!deliveryStatus) continue;
      const ctx = getMessageContext(clientId, messageId);
      if (!ctx) continue;

      forwardStatusToBackend({
        externalRef: ctx.externalRef,
        status: deliveryStatus,
        messageId,
      }).catch((err) =>
        logger.warn("[session] error al reenviar status de entrega al backend", {
          clientId,
          messageId,
          error: err?.message,
        })
      );
    }
  });

  // -------------------------------------------------------------------------
  // LISTENER: messages.upsert — reenvío al agente AgenditApp
  // -------------------------------------------------------------------------
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    if (!env.AGENDITAPP_BACKEND_URL || !env.WA_AGENT_SECRET) return;

    const meId = getState(clientId).me?.id;
    const orgPhone = meId
      ? "+" + meId.replace(/@s\.whatsapp\.net$/, "").replace(/:\d+$/, "")
      : null;

    for (const msg of messages) {
      // remoteJidAlt tiene el JID telefónico cuando WhatsApp usa direccionamiento LID (@lid)
      const jid = msg.key?.remoteJidAlt || msg.key?.remoteJid;
      if (!jid || jid.endsWith("@g.us")) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        null;
      if (!text) continue;

      const clientPhone = "+" + jid.replace("@s.whatsapp.net", "");

      forwardToAgent({
        clientId,
        orgPhone,
        clientPhone,
        fromMe: Boolean(msg.key.fromMe),
        body: text,
        timestamp: Number(msg.messageTimestamp),
      }).catch((err) =>
        logger.warn("[agent] error al reenviar mensaje al backend", {
          clientId,
          error: err?.message,
        })
      );
    }
  });

  return sock;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export function getClient(clientId) {
  return SESSIONS[clientId] || null;
}

export function getSessionView(clientId) {
  const st = getState(clientId);

  // Fecha de creación del creds.json = momento en que se escaneó el QR o se usó pairing code.
  // Las reconexiones no modifican este archivo, solo un logout + nuevo vínculo lo recrea.
  let linkedAt = 0;
  try {
    const credsPath = path.join(env.AUTH_ROOT, clientId, "creds.json");
    linkedAt = fs.statSync(credsPath).birthtimeMs;
  } catch {}

  return {
    clientId,
    status: st.status,
    reason: st.reason || "",
    lastReadyAt: st.lastReadyAt || 0,
    lastQrAt: st.lastQrAt || 0,
    linkedAt,
  };
}

/**
 * Retorna todas las sesiones: las activas en memoria + las que tienen creds.json
 * en disco pero no están conectadas (huérfanas o desconectadas tras 401).
 */
export function getAllSessions() {
  const result = {};

  // 1. Sesiones activas en memoria
  for (const clientId of Object.keys(SESSIONS)) {
    result[clientId] = getSessionView(clientId);
  }

  // 2. Sesiones con credenciales en disco que no están en memoria
  try {
    const dirs = fs.readdirSync(env.AUTH_ROOT, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const clientId = d.name;
      if (result[clientId]) continue; // ya está incluida
      const credsPath = path.join(env.AUTH_ROOT, clientId, "creds.json");
      if (!fs.existsSync(credsPath)) continue;
      result[clientId] = getSessionView(clientId); // status será "disconnected"
    }
  } catch (e) {
    logger.error("[session] error escaneando AUTH_ROOT", { error: e?.message });
  }

  return Object.values(result);
}

/**
 * Elimina los archivos de credenciales del disco para una sesión desconectada.
 * No permite borrar sesiones activas.
 */
export function deleteSessionFiles(clientId) {
  if (SESSIONS[clientId]) {
    return { ok: false, reason: "La sesión está activa. Haz logout primero." };
  }
  const dir = path.join(env.AUTH_ROOT, clientId);
  if (!fs.existsSync(dir)) {
    return { ok: false, reason: "No existe directorio para este clientId." };
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    delete SESSION_STATE[clientId];
    logger.info("[session] archivos de sesión eliminados desde monitor", { clientId });
    return { ok: true };
  } catch (e) {
    logger.error("[session] error eliminando archivos de sesión", { clientId, error: e?.message });
    return { ok: false, reason: e?.message };
  }
}

export async function restartClient(clientId, io) {
  // Marcar destrucción intencional para que connection.update no dispare reconexión
  DESTROYING.add(clientId);
  const sock = SESSIONS[clientId];
  if (sock) {
    try { await sock.end(); } catch {}
    delete SESSIONS[clientId];
  }
  resetBackoff(clientId);     // restart manual = backoff desde cero
  DESTROYING.delete(clientId); // liberar antes de crear el nuevo socket
  emitStatus(io, clientId, "reconnecting", "manual_restart");
  return getOrCreateClient({ clientId, io });
}

export async function logoutClient(clientId, io) {
  // Marcar destrucción intencional durante todo el proceso de cierre
  DESTROYING.add(clientId);
  try {
    const sock = SESSIONS[clientId];
    if (sock) {
      try { await sock.logout(); } catch {}
      try { await sock.end(); } catch {}
      delete SESSIONS[clientId];
    }
    const dir = path.join(env.AUTH_ROOT, clientId);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    resetBackoff(clientId);
    setState(clientId, { status: "disconnected", reason: "logout_manual" });
    io.to(clientId).emit("session_cleaned", { status: "cleaned", motivo: "logout_manual" });
  } finally {
    // Retardar la limpieza para absorber connection.update tardíos del socket viejo
    setTimeout(() => DESTROYING.delete(clientId), 5_000);
  }
}

export async function sendMessageSafe(clientId, { phone, message, image, externalRef }) {
  const sock = getClient(clientId);
  if (!sock) throw new Error("Sesión no encontrada");

  const st = getState(clientId);
  if (st.status !== "ready") {
    const err = new Error("not_ready");
    err.code = 409;
    throw err;
  }

  const clean = String(phone).replace(/\s/g, "");
  const jid = clean.endsWith("@s.whatsapp.net")
    ? clean
    : `${clean}@s.whatsapp.net`;

  const track = (result) => {
    if (externalRef && result?.id) setMessageContext(clientId, result.id, externalRef);
    return result;
  };

  if (image) {
    if (typeof image === "string" && image.startsWith("http")) {
      // withTimeout protege contra URLs externas que cuelguen indefinidamente (FASE 6)
      // linkPreview: null evita que Baileys intente generar preview del caption
      // (usa link-preview-js, dependencia con SSRF conocido sin parche — ver
      // GHSA-4gp8-rjrq-ch6q — y que además puede fallar/tardar sin bloquear el
      // envío, solo dejando ruido en logs).
      const r = await withTimeout(
        sock.sendMessage(jid, { image: { url: image }, caption: message || undefined, linkPreview: null }),
        30_000
      );
      return track({ id: r.key?.id, kind: "image_url" });
    }
    if (typeof image === "string" && image.startsWith("data:")) {
      const m = image.match(/^data:(.+);base64,(.+)$/);
      if (!m) throw new Error("Imagen base64 inválida");
      const mimetype = m[1];
      const buffer = Buffer.from(m[2], "base64");
      const r = await withTimeout(
        sock.sendMessage(jid, { image: buffer, mimetype, caption: message || undefined, linkPreview: null }),
        30_000
      );
      return track({ id: r.key?.id, kind: "image_base64" });
    }
    throw new Error("Formato de imagen no soportado");
  }

  // linkPreview: null desactiva la generación de preview (link-preview-js) —
  // ver nota de seguridad arriba. Nuestras plantillas suelen incluir enlaces
  // (cancelación, gestión de cita, sitio del negocio) y sin esto cada envío
  // con URL disparaba un fetch externo de hasta 3s que siempre fallaba en
  // producción (dependencia no resuelta) sin bloquear el envío, solo ruido.
  const r = await withTimeout(sock.sendMessage(jid, { text: message, linkPreview: null }), 30_000);
  return track({ id: r.key?.id, kind: "text" });
}

/**
 * Al arrancar el servidor, reconecta todas las sesiones que tienen credenciales
 * persistidas en disco (creds.json). Así los reinicios de PM2 no dejan sesiones
 * huérfanas — las credentials en AUTH_ROOT sobreviven al proceso, el socket no.
 */
export async function reconnectPersistedSessions(io) {
  if (!fs.existsSync(env.AUTH_ROOT)) return;

  let entries;
  try {
    entries = fs.readdirSync(env.AUTH_ROOT, { withFileTypes: true });
  } catch (e) {
    logger.error("[session] no se pudo leer AUTH_ROOT al iniciar", { error: e?.message });
    return;
  }

  const clientIds = entries
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) =>
      fs.existsSync(path.join(env.AUTH_ROOT, id, "creds.json"))
    );

  if (clientIds.length === 0) {
    logger.info("[session] sin sesiones persistidas para reconectar al arranque");
    return;
  }

  logger.info("[session] reconectando sesiones persistidas", {
    count: clientIds.length,
    clientIds,
  });

  for (const clientId of clientIds) {
    // Escalonar las reconexiones para no saturar la CPU/red al arrancar
    await new Promise((r) => setTimeout(r, 2_000));
    getOrCreateClient({ clientId, io }).catch((e) => {
      logger.error("[session] error reconectando sesión persistida", {
        clientId,
        error: e?.message,
      });
    });
  }
}

export const __state = { getState, getSessionView, SESSIONS };
