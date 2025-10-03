import { Router } from "express";
import {
  getOrCreateClient,
  logoutClient,
  restartClient,
} from "../sessions/baileysManager.js";

const router = Router();

router.post("/session", async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  await getOrCreateClient({ clientId, io: req.io });
  res.json({ status: "pending", clientId });
});

router.post("/logout", async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  await logoutClient(clientId, req.io);
  res.json({ status: "logout", clientId });
});

router.post("/restart", async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  await restartClient(clientId, req.io);
  res.json({ status: "restarting", clientId });
});

export default router;
