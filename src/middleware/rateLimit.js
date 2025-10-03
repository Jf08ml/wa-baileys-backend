import rateLimit from "express-rate-limit";
import { env } from "../config/env.js";

export const limiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const ip = req.ip || req.connection?.remoteAddress || "";
    const key = req.header("x-api-key");
    return ip === "127.0.0.1" || ip === "::1" || key === env.API_KEY;
  },
});
