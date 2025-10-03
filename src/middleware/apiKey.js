// src/middleware/apiKey.js
import { env } from "../config/env.js";

export function apiKeyMiddleware(req, res, next) {
  const key = req.header("x-api-key");
  if (!key || key !== env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}
