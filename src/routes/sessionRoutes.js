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

router.post("/session/pairing", async (req, res) => {
  const { clientId, phone } = req.body || {};
  if (!clientId || !phone) {
    return res.status(400).json({ error: "Faltan clientId y phone" });
  }

  await getOrCreateClient({
    clientId,
    io: req.io,
    phoneNumber: phone, // E.164, preferible ya normalizado desde el backend agenda
  });

  res.json({ status: "pending", clientId, mode: "pairing" });
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
