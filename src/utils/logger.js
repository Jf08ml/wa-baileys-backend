const levels = ["fatal", "error", "warn", "info", "debug", "trace"];
const level = process.env.LOG_LEVEL || "info";
const allow = levels.indexOf(level);

function log(kind, obj) {
  const ts = new Date().toISOString();
  // Log estructurado compatible con PM2
  console[kind === "fatal" ? "error" : kind]({ ts, level: kind, ...obj });
}

export const logger = {
  fatal: (msg, meta = {}) => {
    if (allow >= 0) log("fatal", { msg, ...meta });
  },
  error: (msg, meta = {}) => {
    if (allow >= 1) log("error", { msg, ...meta });
  },
  warn: (msg, meta = {}) => {
    if (allow >= 2) log("warn", { msg, ...meta });
  },
  info: (msg, meta = {}) => {
    if (allow >= 3) log("info", { msg, ...meta });
  },
  debug: (msg, meta = {}) => {
    if (allow >= 4) log("debug", { msg, ...meta });
  },
  trace: (msg, meta = {}) => {
    if (allow >= 5) log("trace", { msg, ...meta });
  },
};
