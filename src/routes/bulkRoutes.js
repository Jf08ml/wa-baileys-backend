// src/routes/bulkRoutes.js
import { Router } from "express";
import {
  startBulk,
  listBulks,
  getBulk,
  cancelBulk,
  consent,
  getDailyStats,
} from "../bulk/bulkManager.js";

const router = Router();

// Crear campaña bulk
router.post("/bulk/send", async (req, res) => {
  const { clientId, title, items, messageTpl, image, dryRun } = req.body || {};
  if (!clientId || !Array.isArray(items) || !messageTpl) {
    return res
      .status(400)
      .json({ error: "Faltan datos: clientId, items[], messageTpl" });
  }
  try {
    const r = await startBulk({
      io: req.io,
      clientId,
      title,
      items,
      messageTpl,
      image,
      dryRun: Boolean(dryRun),
    });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Listar campañas
router.get("/bulk/list", (_req, res) => {
  res.json(listBulks());
});

// Detalle campaña
router.get("/bulk/:bulkId", (req, res) => {
  const b = getBulk(req.params.bulkId);
  if (!b) return res.status(404).json({ error: "not_found" });
  res.json(b);
});

// Cancelar campaña
router.post("/bulk/:bulkId/cancel", async (req, res) => {
  const ok = await cancelBulk(req.params.bulkId);
  res.json({ ok });
});

// Opt-in/out
router.post("/bulk/optin", (req, res) => {
  const { phones } = req.body || {};
  consent.addOptIn(phones || []);
  res.json({ ok: true, count: (phones || []).length });
});
router.post("/bulk/optout", (req, res) => {
  const { phones } = req.body || {};
  consent.addOptOut(phones || []);
  res.json({ ok: true, count: (phones || []).length });
});
router.get("/bulk/consent", (_req, res) => {
  res.json({ optIn: consent.getOptInAll(), optOut: consent.getOptOutAll() });
});

// Consultar límite diario de un cliente
router.get("/bulk/daily-limit/:clientId", (req, res) => {
  const stats = getDailyStats(req.params.clientId);
  res.json(stats);
});

export default router;
