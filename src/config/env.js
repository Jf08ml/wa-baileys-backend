import dotenv from "dotenv";
dotenv.config();

const required = (key) => {
  if (!process.env[key] || process.env[key] === "") {
    console.error(`❌ Falta variable de entorno: ${key}`);
    process.exit(1);
  }
  return process.env[key];
};

export const env = {
  PORT: process.env.PORT || 3001,
  NODE_ENV: process.env.NODE_ENV || "production",
  API_KEY: required("API_KEY"),
  WS_JWT_SECRET: required("WS_JWT_SECRET"),
  FRONTEND_ORIGIN: (process.env.FRONTEND_ORIGIN || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
  AUTH_ROOT: process.env.AUTH_ROOT || "/opt/wa/auth",
};
