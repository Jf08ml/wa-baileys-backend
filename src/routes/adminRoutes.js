import { Router } from "express";
import os from "os";
import { __state, getAllSessions, deleteSessionFiles } from "../sessions/baileysManager.js";
import { getRecentLogs } from "../utils/logBuffer.js";

const router = Router();

router.get("/status/:clientId", (req, res) => {
  const { clientId } = req.params;
  const st = __state.getState(clientId);
  if (!st || st.status === "disconnected") {
    return res.json({
      code: "disconnected",
      reason: st?.reason || "not_found",
    });
  }
  const QR_TTL_MS = 20_000;
  const age = st.lastQrAt ? Date.now() - st.lastQrAt : null;
  const qrExpiresInMs = age != null ? Math.max(QR_TTL_MS - age, 0) : null;
  res.json({
    code: st.status,
    reason: st.reason || "",
    lastReadyAt: st.lastReadyAt || 0,
    lastQrAt: st.lastQrAt || 0,
    qrAgeMs: age,
    qrExpiresInMs,
    me: st.me || null,
  });
});

router.get("/sessions", (_req, res) => {
  res.json(getAllSessions());
});

router.delete("/session/:clientId", (req, res) => {
  const { clientId } = req.params;
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  const result = deleteSessionFiles(clientId);
  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ status: "deleted", clientId });
});

router.get("/metrics", (_req, res) => {
  const mem = process.memoryUsage();
  const load = os.loadavg();
  res.json({
    uptime: process.uptime(),
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
    },
    load: { avg1: load[0], avg5: load[1], avg15: load[2] },
    maxHeapBytes: 1400 * 1024 * 1024,
  });
});

router.get("/logs", (_req, res) => {
  res.json(getRecentLogs());
});

export default router;
