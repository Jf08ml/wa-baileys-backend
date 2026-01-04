// src/bulk/bulkManager.js
import Bottleneck from "bottleneck";
import { customAlphabet } from "nanoid";
import { sendMessageSafe } from "../sessions/baileysManager.js";
import { logger } from "../utils/logger.js";

const nanoid = customAlphabet("123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 10);

// Config “conservadora” (ajusta según warming-up del número)
const BASE_MIN_DELAY_MS = 6000; // 6s
const BASE_MAX_DELAY_MS = 10000; // 10s
const DAILY_CAP_PER_CLIENT = 400; // límite diario por línea (ajústalo bajo)
const MAX_RETRIES = 2; // reintentos leves
const QUIET_HOURS = null; // desactívalo para probar

// Listas (migrables a DB)
const optInSet = new Set(); // "57300..." (E.164 sin '+')
const optOutSet = new Set(); // "57300..."
const blacklistSet = new Set();

// Contadores diarios en memoria (resetéalo con cron a medianoche Bogotá)
const dailyCount = new Map(); // key: clientId -> number

function inQuietHoursBogota() {
  return false;
}

function jitteredDelay() {
  const base =
    BASE_MIN_DELAY_MS + Math.random() * (BASE_MAX_DELAY_MS - BASE_MIN_DELAY_MS);
  // micro-jitter adicional
  return Math.round(base + (Math.random() - 0.5) * 700);
}

function normalizePhone(p) {
  return String(p || "").replace(/\D/g, "");
}

// Estado por campaña
const BULKS = new Map(); // bulkId -> { meta, items[], stats, status, createdAt }

function getDaily(clientId) {
  return dailyCount.get(clientId) || 0;
}
function incDaily(clientId, n = 1) {
  dailyCount.set(clientId, getDaily(clientId) + n);
}

export function resetDailyCounters() {
  dailyCount.clear();
}

export function getDailyStats(clientId) {
  const used = getDaily(clientId);
  const limit = DAILY_CAP_PER_CLIENT;
  return {
    clientId,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percentage: limit > 0 ? Math.round((used / limit) * 100) : 0,
  };
}

// Cola/limiters por clientId
const perClientLimiter = new Map();
function getLimiter(clientId) {
  if (!perClientLimiter.has(clientId)) {
    const limiter = new Bottleneck({
      minTime: BASE_MIN_DELAY_MS, // base, pero usaremos señales “jittered” manuales
      maxConcurrent: 1,
      reservoir: 999999, // no usamos aquí, controlamos por lógica
    });
    perClientLimiter.set(clientId, limiter);
  }
  return perClientLimiter.get(clientId);
}

// API pública para opt-in/out
export const consent = {
  addOptIn: (phones = []) =>
    phones.map(normalizePhone).forEach((p) => optInSet.add(p)),
  addOptOut: (phones = []) =>
    phones.map(normalizePhone).forEach((p) => optOutSet.add(p)),
  getOptInAll: () => Array.from(optInSet),
  getOptOutAll: () => Array.from(optOutSet),
  removeOptIn: (phones = []) =>
    phones.map(normalizePhone).forEach((p) => optInSet.delete(p)),
  removeOptOut: (phones = []) =>
    phones.map(normalizePhone).forEach((p) => optOutSet.delete(p)),
};

export function listBulks() {
  return Array.from(BULKS.values()).map((b) => ({
    bulkId: b.meta.bulkId,
    clientId: b.meta.clientId,
    title: b.meta.title,
    createdAt: b.createdAt,
    status: b.status,
    stats: b.stats,
  }));
}

export function getBulk(bulkId) {
  return BULKS.get(bulkId) || null;
}

export async function cancelBulk(bulkId) {
  const b = BULKS.get(bulkId);
  if (!b) return false;
  b.status = "cancelled";
  return true;
}

function emit(io, clientId, bulkId, type, payload = {}) {
  io.to(clientId).emit("bulk_update", { bulkId, type, ...payload });
}

function classifyError(e) {
  const msg = String(e?.message || e);
  // Señales heurísticas
  if (msg.includes("not_ready")) return "not_ready";
  if (msg.includes("spam") || msg.includes("blocked")) return "spammy";
  if (msg.includes("too many") || msg.includes("rate")) return "rate";
  if (msg.includes("timed out") || msg.includes("timeout")) return "timeout";
  return "generic";
}

export async function startBulk({
  io,
  clientId,
  title,
  items,
  messageTpl,
  image,
  dryRun = false,
}) {
  // items: [{ phone: "57300...", vars: { name: "Ana", ... } }, ...]
  // messageTpl: string con placeholders {{name}}, {{...}}
  const bulkId = nanoid();
  const createdAt = Date.now();
  const limiter = getLimiter(clientId);

  // Filtrado inicial
  const prepared = [];
  for (const it of items) {
    const phone = normalizePhone(it.phone);
    if (!phone) continue;
    if (!optInSet.has(phone)) {
      prepared.push({ phone, skip: true, skipReason: "no_opt_in" });
      continue;
    }
    if (optOutSet.has(phone)) {
      prepared.push({ phone, skip: true, skipReason: "opted_out" });
      continue;
    }
    if (blacklistSet.has(phone)) {
      prepared.push({ phone, skip: true, skipReason: "blacklisted" });
      continue;
    }
    prepared.push({ phone, vars: it.vars || {}, skip: false });
  }

  const bulk = {
    meta: { bulkId, clientId, title: title || `Bulk ${bulkId}` },
    createdAt,
    status: "running",
    items: prepared,
    stats: {
      total: prepared.length,
      sent: 0,
      skipped: 0,
      failed: 0,
      retried: 0,
    },
  };
  BULKS.set(bulkId, bulk);

  emit(io, clientId, bulkId, "started", { meta: bulk.meta, stats: bulk.stats });

  // Loop controlado
  (async () => {
    for (let i = 0; i < bulk.items.length; i++) {
      if (bulk.status !== "running") break;

      const it = bulk.items[i];
      // Quiet hours
      if (inQuietHoursBogota()) {
        emit(io, clientId, bulkId, "paused_quiet_hours", { index: i });
        bulk.status = "paused";
        break;
      }

      // cupo diario
      if (getDaily(clientId) >= DAILY_CAP_PER_CLIENT) {
        emit(io, clientId, bulkId, "paused_daily_cap", { index: i });
        bulk.status = "paused";
        break;
      }

      if (it.skip) {
        bulk.stats.skipped++;
        emit(io, clientId, bulkId, "skipped", {
          index: i,
          phone: it.phone,
          reason: it.skipReason,
        });
        continue;
      }

      const text = renderTemplate(messageTpl, it.vars);

      // Encola con jitter manual entre tareas
      await sleep(jitteredDelay());

      const task = async () => {
        if (dryRun) {
          bulk.stats.sent++;
          incDaily(clientId);
          emit(io, clientId, bulkId, "dry_run", {
            index: i,
            phone: it.phone,
            text,
          });
          return;
        }

        // Intentos con backoff sencillo
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            await sendMessageSafe(clientId, {
              phone: it.phone,
              message: text,
              image,
            });
            bulk.stats.sent++;
            incDaily(clientId);
            emit(io, clientId, bulkId, "sent", { index: i, phone: it.phone });
            return;
          } catch (e) {
            const kind = classifyError(e);
            logger.warn(
              `[bulk ${bulkId}] send fail ${it.phone} kind=${kind} msg=${e?.message}`
            );
            if (kind === "spammy") {
              // Señal fuerte, paramos campaña y metemos a blacklist
              blacklistSet.add(it.phone);
              bulk.stats.failed++;
              emit(io, clientId, bulkId, "failed_spammy", {
                index: i,
                phone: it.phone,
                error: String(e?.message || e),
              });
              bulk.status = "paused";
              emit(io, clientId, bulkId, "paused_spam_signal", { index: i });
              return;
            }
            if (attempt < MAX_RETRIES) {
              bulk.stats.retried++;
              emit(io, clientId, bulkId, "retry", {
                index: i,
                phone: it.phone,
                attempt: attempt + 1,
              });
              await sleep(15000 + Math.random() * 10000); // backoff 15–25s
              continue;
            }
            bulk.stats.failed++;
            emit(io, clientId, bulkId, "failed", {
              index: i,
              phone: it.phone,
              error: String(e?.message || e),
            });
            return;
          }
        }
      };

      // Ejecuta serial por limiter
      await limiter.schedule(task);
    }

    if (bulk.status === "running") {
      bulk.status = "done";
      emit(io, clientId, bulkId, "done", { stats: bulk.stats });
    } else {
      emit(io, clientId, bulkId, "stopped", {
        status: bulk.status,
        stats: bulk.stats,
      });
    }
  })().catch((e) => {
    bulk.status = "error";
    emit(io, clientId, bulkId, "error", { error: String(e?.message || e) });
  });

  return { bulkId, prepared: prepared.length };
}

function renderTemplate(tpl, vars = {}) {
  if (!tpl) return "";
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
