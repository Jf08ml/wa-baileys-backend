// src/routes/adminRoutes.js
import { Router } from "express";
import { __state } from "../sessions/baileysManager.js";

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
  const QR_TTL_MS = 20_000; // informativo
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
  const all = Object.keys(__state.SESSIONS).map((id) =>
    __state.getSessionView(id)
  );
  res.json(all);
});

export default router;
