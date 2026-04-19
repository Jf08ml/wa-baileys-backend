// src/sessions/baileysManager.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
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

function getState(clientId) {
  return SESSION_STATE[clientId] || { status: "disconnected" };
}

function emitStatus(io, clientId, code, reason = "") {
  setState(clientId, { status: code, reason });
  io.to(clientId).emit("status", { clientId, code, reason, ts: Date.now() });
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

export async function initBaileysVersion() {
  if (!BAILEYS_VERSION) {
    const { version } = await fetchLatestBaileysVersion();
    BAILEYS_VERSION = version;
    logger.info("[session] Baileys version negociada", { version: BAILEYS_VERSION.join(".") });
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
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  SESSIONS[clientId] = sock;
  setState(clientId, { status: "connecting", reason: "" });
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
            setState(clientId, { pairingCode: pretty });
            io.to(clientId).emit("pairing_code", { code: pretty, raw: code, phone: normalized });
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
        setState(clientId, { lastQrAt: issuedAt });
        emitStatus(io, clientId, "waiting_qr");
        io.to(clientId).emit("qr", {
          clientId, qr, issuedAt, expiresAt, ttlMs: QR_TTL_MS, seq, replacesPrevious, qrId,
        });
      }

      // --- Conexión abierta ---
      if (connection === "open") {
        resetBackoff(clientId); // reconexión exitosa → contador de backoff a cero
        setState(clientId, { lastReadyAt: Date.now(), me: sock.user || null });
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
  return {
    clientId,
    status: st.status,
    reason: st.reason || "",
    lastReadyAt: st.lastReadyAt || 0,
    lastQrAt: st.lastQrAt || 0,
  };
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

export async function sendMessageSafe(clientId, { phone, message, image }) {
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

  if (image) {
    if (typeof image === "string" && image.startsWith("http")) {
      // withTimeout protege contra URLs externas que cuelguen indefinidamente (FASE 6)
      const r = await withTimeout(
        sock.sendMessage(jid, { image: { url: image }, caption: message || undefined }),
        30_000
      );
      return { id: r.key?.id, kind: "image_url" };
    }
    if (typeof image === "string" && image.startsWith("data:")) {
      const m = image.match(/^data:(.+);base64,(.+)$/);
      if (!m) throw new Error("Imagen base64 inválida");
      const mimetype = m[1];
      const buffer = Buffer.from(m[2], "base64");
      const r = await withTimeout(
        sock.sendMessage(jid, { image: buffer, mimetype, caption: message || undefined }),
        30_000
      );
      return { id: r.key?.id, kind: "image_base64" };
    }
    throw new Error("Formato de imagen no soportado");
  }

  const r = await withTimeout(sock.sendMessage(jid, { text: message }), 30_000);
  return { id: r.key?.id, kind: "text" };
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
