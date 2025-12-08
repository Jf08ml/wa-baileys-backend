// src/server.js
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

import { env } from "./config/env.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { apiKeyMiddleware } from "./middleware/apiKey.js";
import { limiter } from "./middleware/rateLimit.js";

import healthRoute from "./health/healthRoute.js";
import sessionRoutes from "./routes/sessionRoutes.js";
import messageRoutes from "./routes/messageRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import bulkRoutes from "./routes/bulkRoutes.js";
import reminderJob from "./jobs/reminderJob.js";

const app = express();
app.set("trust proxy", 1);

// --- CORS (lista de orígenes; si viniera "*" en .env, refleja el Origin) ---
const ORIGINS =
  env.FRONTEND_ORIGIN.length === 1 && env.FRONTEND_ORIGIN[0] === "*"
    ? true
    : env.FRONTEND_ORIGIN;

const corsOptions = {
  origin: ORIGINS,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["x-api-key", "content-type", "authorization"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // preflight global

// --- Body parser + headers de seguridad ---
app.use(express.json({ limit: "2mb" }));
app.use(securityHeaders());

// --- Logger simple para depurar cuelgues ---
app.use((req, res, next) => {
  const t0 = Date.now();
  // No imprimas la API key; solo indica si viene o no
  console.log(
    `[REQ] ${req.method} ${req.path} origin=${
      req.headers.origin ?? ""
    } x-api-key=${Boolean(req.headers["x-api-key"])}`
  );
  res.on("finish", () => {
    console.log(
      `[RES] ${req.method} ${req.path} -> ${res.statusCode} (${
        Date.now() - t0
      }ms)`
    );
  });
  next();
});

// --- Rutas públicas (sin API key) ---
app.use(healthRoute);

// --- Protege /api con API key + rate limit (permite OPTIONS en middleware) ---
app.use("/api", apiKeyMiddleware, limiter);

// --- Endpoints de ping para pruebas rápidas (reales, no solo OPTIONS) ---
app.get("/api/ping", (req, res) => res.json({ ok: true, t: Date.now() }));
app.post("/api/ping", (req, res) =>
  res.json({ ok: true, body: req.body || null })
);

// --- HTTP server + Socket.IO con CORS alineado ---
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ORIGINS,
    methods: ["GET", "POST"],
    allowedHeaders: ["x-api-key", "authorization"],
    credentials: true,
  },
});

// --- Auth para sockets: acepta API key (auth.apiKey o header) o JWT efímero (auth.token) ---
io.use((socket, next) => {
  const { apiKey, token } = socket.handshake.auth || {};
  const headerKey = socket.handshake.headers["x-api-key"];

  // 1) Compatibilidad: API key directa (como ya tenías)
  if ((apiKey && apiKey === env.API_KEY) || headerKey === env.API_KEY) {
    return next();
  }

  // 2) JWT efímero emitido por agenda-backend (issueWsToken)
  if (token) {
    try {
      const payload = jwt.verify(token, env.WS_JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "agenda-backend",
      });
      // Guarda datos útiles para el ciclo de vida del socket
      socket.data.ws = {
        sub: payload.sub,
        orgId: payload.orgId,
        clientId: payload.clientId,
        scope: payload.scope,
      };
      return next();
    } catch (e) {
      return next(new Error("unauthorized"));
    }
  }

  return next(new Error("unauthorized"));
});

// --- Inyectar io en req para usarlo dentro de rutas /api ---
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// --- Rutas API (protegidas) ---
app.use("/api", sessionRoutes);
app.use("/api", messageRoutes);
app.use("/api", adminRoutes);
app.use("/api", bulkRoutes);

// --- Socket.IO rooms por clientId ---
io.on("connection", (socket) => {
  const tokenClientId = socket.data.ws?.clientId;
  if (tokenClientId) {
    // Auto-join usando el clientId del JWT
    socket.join(tokenClientId);
    socket.emit("status", { code: "connecting", ts: Date.now() });
  } else {
    // Fallback: permite 'join' manual (valida que no contradiga el JWT si existiera)
    socket.on("join", ({ clientId }) => {
      if (!clientId) return;
      if (socket.data.ws?.clientId && socket.data.ws.clientId !== clientId) {
        return; // ignora intentos cruzados
      }
      socket.join(clientId);
      socket.emit("status", { code: "connecting", ts: Date.now() });
    });
  }
});

// --- Fallback error handler ---
app.use((err, _req, res, _next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: err?.message || "Server error" });
});

// --- Arrancar ---
httpServer.listen(env.PORT, () => {
  console.log(`🚀 API lista en http://localhost:${env.PORT}`);

  reminderJob();
});
