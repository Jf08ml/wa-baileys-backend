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

const SESSIONS = {}; // clientId -> sock
const SESSION_STATE = {}; // clientId -> { status, reason, lastQrAt, lastReadyAt, me, pairingCode? }
let BAILEYS_VERSION;
const QR_TTL_MS = 20_000;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export async function initBaileysVersion() {
  if (!BAILEYS_VERSION) {
    const { version } = await fetchLatestBaileysVersion();
    BAILEYS_VERSION = version;
    logger.info("Baileys version negociada", {
      version: BAILEYS_VERSION.join("."),
    });
  }
  return BAILEYS_VERSION;
}

function setState(clientId, patch) {
  SESSION_STATE[clientId] = { ...(SESSION_STATE[clientId] || {}), ...patch };
}

function getState(clientId) {
  return SESSION_STATE[clientId] || { status: "disconnected" };
}

function emitStatus(io, clientId, code, reason = "") {
  setState(clientId, { status: code, reason });
  io.to(clientId).emit("status", { code, reason, ts: Date.now() });
}

/**
 * Crea o reutiliza un socket Baileys
 * - Si se pasa phoneNumber => intentamos pairing code
 * - Si no => QR normal
 */
export async function getOrCreateClient({ clientId, io, phoneNumber }) {
  if (SESSIONS[clientId]) return SESSIONS[clientId];

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

  // persistir creds
  sock.ev.on("creds.update", saveCreds);

  // Info "me"
  (async () => {
    try {
      if (sock.user) setState(clientId, { me: sock.user });
    } catch {}
  })();

  // --- VARIABLES DE CONTROL LOCALES ---
  let lastQrEmitted = null;
  let lastQrSeq = 0;
  // 1. Definimos la bandera aquí para que exista en el closure
  let pairingRequested = false;

  // --- EVENTO PRINCIPAL ---
  sock.ev.on("connection.update", async (u) => {
    // 2. Extraemos las variables 'qr' y 'connection' del evento
    const { connection, lastDisconnect, qr } = u;

    // ------------------ LÓGICA DE PAIRING CODE (MOVIDA AQUÍ) ------------------
    // Se ejecuta cuando:
    // a) Tenemos un phoneNumber
    // b) Recibimos un QR (significa que el socket conectó a WA y espera auth)
    // c) No estamos registrados aún
    // d) No hemos pedido el código ya
    if (
      qr &&
      phoneNumber &&
      !pairingRequested &&
      !sock.authState?.creds?.registered
    ) {
      pairingRequested = true; // Marcamos para no repetir
      const normalized = String(phoneNumber).replace(/\D/g, "");

      logger.info(
        `[${clientId}] Solicitando pairing code para ${normalized}...`
      );

      // Esperamos un momento para asegurar estabilidad del socket antes de pedir
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(normalized);
          const pretty = code?.match(/.{1,4}/g)?.join("-") || code || "";

          setState(clientId, { pairingCode: pretty });

          io.to(clientId).emit("pairing_code", {
            code: pretty,
            raw: code,
            phone: normalized,
          });

          logger.info(`[${clientId}] Pairing code: ${pretty}`);
        } catch (e) {
          pairingRequested = false; // Permitir reintento si falla
          logger.error(`[${clientId}] Error pairing code: ${e.message}`);
          io.to(clientId).emit("pairing_error", { error: e.message });
        }
      }, 2000);
    }
    // ---------------- FIN LÓGICA DE PAIRING CODE ----------------

    // --- LÓGICA DE QR TRADICIONAL (Solo si NO estamos usando pairing) ---
    // Si usas pairing, generalmente ignoras mostrar el QR al usuario,
    // pero si quieres soportar ambos, puedes dejarlo.
    if (qr && qr !== lastQrEmitted && !phoneNumber) {
      // <-- Sugerencia: !phoneNumber para no mezclar UI
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
        qr,
        issuedAt,
        expiresAt,
        ttlMs: QR_TTL_MS,
        seq,
        replacesPrevious,
        qrId,
      });
    }

    if (connection === "open") {
      setState(clientId, { lastReadyAt: Date.now(), me: sock.user || null });
      emitStatus(io, clientId, "ready");
      logger.info(`[${clientId}] ready`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const willReconnect = code !== DisconnectReason.loggedOut;
      emitStatus(
        io,
        clientId,
        willReconnect ? "reconnecting" : "disconnected",
        String(code || "")
      );

      if (willReconnect) {
        setTimeout(() => {
          delete SESSIONS[clientId];
          getOrCreateClient({ clientId, io, phoneNumber }).catch(() => {}); // Pasamos phoneNumber al reconectar
        }, 1500);
      }
    }
  });

  return sock;
}

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
  const sock = SESSIONS[clientId];
  if (sock) {
    try {
      await sock.end();
    } catch {}
    delete SESSIONS[clientId];
  }
  emitStatus(io, clientId, "reconnecting", "manual_restart");
  return getOrCreateClient({ clientId, io });
}

export async function logoutClient(clientId, io) {
  const sock = SESSIONS[clientId];
  if (sock) {
    try {
      await sock.logout();
    } catch {}
    try {
      await sock.end();
    } catch {}
    delete SESSIONS[clientId];
  }
  // borrar credenciales en disco
  const dir = path.join(env.AUTH_ROOT, clientId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
  setState(clientId, { status: "disconnected", reason: "logout_manual" });
  io.to(clientId).emit("session_cleaned", {
    status: "cleaned",
    motivo: "logout_manual",
  });
  if (globalThis.__SESSIONS_VIEW) delete globalThis.__SESSIONS_VIEW[clientId];
}

// sendMessageSafe se queda igual
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
      const r = await sock.sendMessage(jid, {
        image: { url: image },
        caption: message || undefined,
      });
      return { id: r.key?.id, kind: "image_url" };
    }
    if (typeof image === "string" && image.startsWith("data:")) {
      const m = image.match(/^data:(.+);base64,(.+)$/);
      if (!m) throw new Error("Imagen base64 inválida");
      const mimetype = m[1];
      const buffer = Buffer.from(m[2], "base64");
      const r = await sock.sendMessage(jid, {
        image: buffer,
        mimetype,
        caption: message || undefined,
      });
      return { id: r.key?.id, kind: "image_base64" };
    }
    throw new Error("Formato de imagen no soportado");
  }

  const r = await sock.sendMessage(jid, { text: message });
  return { id: r.key?.id, kind: "text" };
}

export const __state = { getState, getSessionView, SESSIONS };
