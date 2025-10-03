import { Router } from "express";
import { getClient, sendMessageSafe } from "../sessions/baileysManager.js";

const router = Router();

router.post("/send", async (req, res) => {
  const { clientId, phone, message, image } = req.body || {};
  if (!clientId || !phone || (!message && !image)) {
    return res
      .status(400)
      .json({ error: "Faltan datos: mínimo mensaje o imagen" });
  }
  const client = getClient(clientId);
  if (!client) return res.status(404).json({ error: "Sesión no encontrada" });
  try {
    const result = await sendMessageSafe(clientId, { phone, message, image });
    res.json({ status: "sent", ...result });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

export default router;
