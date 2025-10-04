// src/sessions/baileysManager.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

const SESSIONS = {}; // clientId -> sock
const SESSION_STATE = {}; // clientId -> { status, reason, lastQrAt, lastReadyAt, me }
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

export async function getOrCreateClient({ clientId, io }) {
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
    browser: ["ZybizoBackend", "Chrome", "1.0"],
  });

  SESSIONS[clientId] = sock;
  setState(clientId, { status: "connecting", reason: "" });
  emitStatus(io, clientId, "connecting");

  // persistir cada cambio de creds
  sock.ev.on("creds.update", saveCreds);

  // info "me" cuando esté disponible
  (async () => {
    try {
      // Baileys suele tener sock.user cuando abre
      if (sock.user) setState(clientId, { me: sock.user });
    } catch {}
  })();

  // eventos de conexión
  let lastQrEmitted = null;
  let lastQrSeq = 0;

  sock.ev.on("connection.update", (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr && qr !== lastQrEmitted) {
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

      logger.info(
        `[${clientId}] QR #${seq} (${qrId}) emitido; reemplaza=${replacesPrevious}`
      );
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
      logger.warn(
        `[${clientId}] closed code=${code} reconnect=${willReconnect}`
      );
      if (willReconnect) {
        setTimeout(() => {
          // recrear socket
          delete SESSIONS[clientId];
          getOrCreateClient({ clientId, io }).catch(() => {});
        }, 1500);
      }
    }
  });

  // vista rápida para admin (opcional)
  globalThis.__SESSIONS_VIEW = globalThis.__SESSIONS_VIEW || {};
  globalThis.__SESSIONS_VIEW[clientId] = { startedAt: Date.now() };

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

// Exporta helpers para admin routes
export const __state = { getState, getSessionView, SESSIONS };
