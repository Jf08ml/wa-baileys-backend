# REFACTOR DE ESTABILIDAD — Comparativa Antes / Después

**Fecha:** 2026-02-27
**Archivos modificados:** `src/server.js`, `src/sessions/baileysManager.js`
**Objetivo:** Crash-safe + reconnection-safe sin cambiar arquitectura ni lógica de negocio

---

## Resumen ejecutivo

| Métrica | Antes | Después |
|---|---|---|
| Crashes por `unhandledRejection` | Proceso muere silenciosamente | Loggeado, proceso sobrevive |
| Crashes por `uncaughtException` | Proceso muere silenciosamente | Loggeado, proceso sobrevive |
| Sockets duplicados por race condition | Posible con 2 requests concurrentes | Bloqueado por mutex `CREATING` |
| Sockets duplicados por `sock.end()` | Garantizado en restart/logout | Bloqueado por set `DESTROYING` |
| Reconexión con `badSession` | Loop infinito | Para + limpia auth en disco |
| Reconexión con `connectionReplaced` | Loop infinito | Para sin tocar auth |
| Delay de reconexión | Fijo 1500 ms siempre | Backoff 2 s → 5 s → 10 s → 30 s |
| `creds.update` sin catch | `unhandledRejection` si falla | Try/catch con log de stack |
| `connection.update` sin catch | Excepción sube al proceso | Try/catch total en el handler |
| `sendMessage` sin timeout | Puede colgar indefinidamente | Timeout 30 s en todos los envíos |
| Logging | Strings ad-hoc con `console.log` | Objetos estructurados con timestamp |
| Código muerto | `globalThis.__SESSIONS_VIEW` nunca definido | Eliminado |

---

## FASE 1 — Blindaje global del proceso (`server.js`)

### Antes
```js
// No existía ningún handler global.
// Un unhandledRejection o uncaughtException mataba el proceso
// → PM2 hacía restart → todas las sesiones activas se perdían.
```

### Después
```js
process.on("unhandledRejection", (reason, _promise) => {
  const mem = process.memoryUsage();
  logger.error("unhandledRejection — promesa sin .catch()", {
    reason: reason?.message ?? String(reason),
    stack: reason?.stack ?? "",
    memHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    ts: new Date().toISOString(),
  });
});

process.on("uncaughtException", (err, origin) => {
  const mem = process.memoryUsage();
  logger.error("uncaughtException — excepción no capturada", {
    message: err?.message ?? String(err),
    stack: err?.stack ?? "",
    origin,
    memHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    ts: new Date().toISOString(),
  });
  // NO process.exit — PM2 gestiona reinicios
});
```

**Problema eliminado:** Las 27 sesiones que morían simultáneamente en PM2 eran consecuencia de un crash del proceso. Ahora cualquier error no capturado se loggea con stack trace y uso de memoria, y el proceso continúa.

---

## FASE 2 — Listener `creds.update` blindado (`baileysManager.js`)

### Antes
```js
// Si saveCreds() lanzaba una excepción, la promesa quedaba sin .catch()
// → unhandledRejection → en algunos entornos, crash del proceso
sock.ev.on("creds.update", saveCreds);
```

### Después
```js
sock.ev.on("creds.update", async () => {
  try {
    await saveCreds();
  } catch (e) {
    logger.error("[session] creds.update: error al persistir credenciales", {
      clientId,
      error: e?.message,
      stack: e?.stack,
    });
  }
});
```

**Problema eliminado:** Error de escritura en disco (permisos, disco lleno) ya no genera `unhandledRejection`. El error queda registrado con contexto.

---

## FASE 2 — Listener `connection.update` blindado (`baileysManager.js`)

### Antes
```js
// Handler async sin try/catch envolvente.
// Cualquier excepción dentro del handler subía sin captura.
sock.ev.on("connection.update", async (u) => {
  const { connection, lastDisconnect, qr } = u;
  // ... lógica sin try/catch global ...
});
```

### Después
```js
sock.ev.on("connection.update", async (u) => {
  try {
    const { connection, lastDisconnect, qr } = u;
    // ... toda la lógica aquí ...
  } catch (e) {
    // Ninguna excepción en un listener puede propagarse hacia arriba
    logger.error("[session] excepción no controlada en connection.update", {
      clientId,
      error: e?.message,
      stack: e?.stack,
    });
  }
});
```

**Problema eliminado:** Cualquier bug interno del handler (acceso a propiedad nula, error de Baileys, etc.) queda contenido y loggeado. No puede matar el proceso.

---

## FASE 3 — Reconexión inteligente con backoff (`baileysManager.js`)

### Antes
```js
if (connection === "close") {
  const code = lastDisconnect?.error?.output?.statusCode;
  // ❌ Solo diferenciaba loggedOut. Todo lo demás reconectaba.
  // ❌ badSession, multideviceMismatch, connectionReplaced → loop infinito
  // ❌ code === undefined → willReconnect = true siempre
  const willReconnect = code !== DisconnectReason.loggedOut;

  if (willReconnect) {
    // ❌ Delay fijo 1500 ms sin importar cuántas veces haya fallado
    setTimeout(() => {
      delete SESSIONS[clientId];
      getOrCreateClient({ clientId, io, phoneNumber }).catch(() => {});
    }, 1500);
  }
}
```

### Después
```js
if (connection === "close") {
  // ✅ Cierre intencional → no reconectar
  if (DESTROYING.has(clientId)) return;

  // ✅ Auth corrompido → limpiar disco y detener
  if (CLEAN_AUTH_REASONS.has(statusCode)) {
    delete SESSIONS[clientId];
    deleteAuthDir(clientId);
    emitStatus(io, clientId, "disconnected", String(statusCode));
    return;
  }

  // ✅ Razón fatal → detener sin tocar auth
  if (NO_RECONNECT_REASONS.has(statusCode)) {
    delete SESSIONS[clientId];
    emitStatus(io, clientId, "disconnected", String(statusCode));
    return;
  }

  // ✅ Backoff exponencial: 2s → 5s → 10s → 30s
  const delay = getBackoffDelay(clientId);
  delete SESSIONS[clientId];

  setTimeout(() => {
    // ✅ Guardia triple: no reconectar si ya hay sesión/creación/destrucción en curso
    if (SESSIONS[clientId] || CREATING.has(clientId) || DESTROYING.has(clientId)) return;
    getOrCreateClient({ clientId, io, phoneNumber }).catch((e) => {
      logger.error("[session] error en reconexión automática", { clientId, error: e?.message });
    });
  }, delay);
}
```

**Tabla de cambios por `DisconnectReason`:**

| Razón | Código | Antes | Después |
|---|---|---|---|
| `loggedOut` | 401 | No reconecta | No reconecta ✅ |
| `badSession` | 500 | Loop infinito 🔴 | Para + borra auth ✅ |
| `multideviceMismatch` | 411 | Loop infinito 🔴 | Para + borra auth ✅ |
| `connectionReplaced` | 440 | Loop infinito 🔴 | Para sin borrar auth ✅ |
| `connectionClosed` | 428 | Reconecta 1.5 s | Backoff 2→5→10→30 s ✅ |
| `timedOut` | 408 | Reconecta 1.5 s | Backoff 2→5→10→30 s ✅ |
| `restartRequired` | 515 | Reconecta 1.5 s | Backoff 2→5→10→30 s ✅ |
| `undefined` | — | Reconecta siempre 🟠 | Backoff aplicado ✅ |

**Problema eliminado:** Loops de reconexión agresivos que generaban decenas de sockets/minuto, acelerando la corrupción Signal.

---

## FASE 4 — Mutex de creación de sesión (`baileysManager.js`)

### Antes
```js
export async function getOrCreateClient({ clientId, io, phoneNumber }) {
  // ❌ Guard no atómico: entre este check y SESSIONS[clientId] = sock
  //    hay dos await que ceden el event loop.
  //    Dos requests concurrentes pasan ambas y crean dos sockets.
  if (SESSIONS[clientId]) return SESSIONS[clientId];

  // await useMultiFileAuthState(authDir)  ← event loop cede aquí
  // await initBaileysVersion()            ← y aquí también
  // ... segunda request ya pasó el guard ...
  SESSIONS[clientId] = sock;
}
```

**Secuencia del problema:**
```
Request A: if(SESSIONS[id]) → null → pasa
Request B: if(SESSIONS[id]) → null → pasa   ← slips through
Request A: await useMultiFileAuthState...   ← cede event loop
Request B: await useMultiFileAuthState...   ← también entra
Request A: SESSIONS[id] = sockA
Request B: SESSIONS[id] = sockB             ← SOBRESCRIBE sockA
→ sockA queda huérfano con el mismo auth → Signal corruption → "identity changed"
```

### Después
```js
// MUTEX: Map que guarda la Promise en curso
const CREATING = new Map(); // clientId -> Promise

export async function getOrCreateClient({ clientId, io, phoneNumber }) {
  // Activo → retornar
  if (SESSIONS[clientId]) return SESSIONS[clientId];

  // ✅ En creación → esperar la MISMA promesa, no crear otra
  if (CREATING.has(clientId)) {
    return CREATING.get(clientId);
  }

  // Registrar promesa en el mutex
  const promise = _doCreate({ clientId, io, phoneNumber });
  CREATING.set(clientId, promise);
  try {
    return await promise;
  } finally {
    CREATING.delete(clientId); // limpiar siempre, incluso si falla
  }
}
```

**Secuencia corregida:**
```
Request A: CREATING[id] = promise → await...
Request B: CREATING.has(id) = true → return CREATING.get(id)
→ Ambas resuelven con el MISMO socket. Cero duplicados.
```

**Problema eliminado:** Principal causa de `"identity changed"` y `"No session found to decrypt message"`.

---

## FASE 4 — Set `DESTROYING` para cierres intencionales (`baileysManager.js`)

### Antes
```js
export async function restartClient(clientId, io) {
  const sock = SESSIONS[clientId];
  if (sock) {
    // ❌ sock.end() dispara connection.update "close" internamente.
    //    El handler viejo sigue activo y programa setTimeout → getOrCreateClient.
    //    restartClient también llama getOrCreateClient.
    //    Resultado: dos sockets.
    try { await sock.end(); } catch {}
    delete SESSIONS[clientId];
  }
  return getOrCreateClient({ clientId, io }); // ← primera creación
  // ... setTimeout del handler viejo → segunda creación 1500ms después
}
```

### Después
```js
const DESTROYING = new Set(); // clientIds bajo destrucción intencional

export async function restartClient(clientId, io) {
  DESTROYING.add(clientId); // ✅ marcar antes de end()
  const sock = SESSIONS[clientId];
  if (sock) {
    try { await sock.end(); } catch {}
    // → connection.update "close" se dispara, pero:
    //   if (DESTROYING.has(clientId)) return; ← handler sale sin reconectar
    delete SESSIONS[clientId];
  }
  resetBackoff(clientId);
  DESTROYING.delete(clientId); // ✅ limpiar antes de crear el nuevo
  emitStatus(io, clientId, "reconnecting", "manual_restart");
  return getOrCreateClient({ clientId, io }); // única creación
}

export async function logoutClient(clientId, io) {
  DESTROYING.add(clientId);
  try {
    // ... sock.logout() + sock.end() + limpiar disco ...
  } finally {
    // ✅ Retardar 5s para absorber connection.update tardíos del socket viejo
    setTimeout(() => DESTROYING.delete(clientId), 5_000);
  }
}
```

**Problema eliminado:** `restartClient` y `logoutClient` ya no generan sockets duplicados al terminar el socket viejo.

---

## FASE 5 — Logging estructurado (`baileysManager.js`)

### Antes
```js
logger.info(`[${clientId}] ready`);
logger.info(`[${clientId}] Solicitando pairing code para ${normalized}...`);
logger.error(`[${clientId}] Error pairing code: ${e.message}`);
// Sin timestamp explícito, sin statusCode en desconexiones
```

### Después
```js
// Cada connection.update loggea estado completo
logger.info("[session] connection.update", {
  clientId,
  connection: connection ?? "n/a",
  statusCode: statusCode ?? "n/a",
  ts: new Date().toISOString(),
});

// Errores incluyen stack trace
logger.error("[session] creds.update: error al persistir credenciales", {
  clientId,
  error: e?.message,
  stack: e?.stack,
});

// Reconexión con contexto de backoff
logger.info("[session] desconexión recuperable, reconectando con backoff", {
  clientId,
  statusCode: statusCode ?? "undefined",
  delayMs: delay,
});
```

**Mejora:** Los logs de PM2 ahora permiten diagnosticar exactamente qué `statusCode` está causando cada desconexión, cuántas veces ha reconectado (visible por el backoff), y qué sesión específica está fallando.

---

## FASE 6 — Timeout en envíos (`baileysManager.js`)

### Antes
```js
// ❌ Sin timeout. Si WA tarda en aceptar una imagen por URL
//    (o la URL externa no responde), sendMessage cuelga indefinidamente.
//    La petición HTTP queda abierta hasta que Express agote su timeout.
const r = await sock.sendMessage(jid, { image: { url: image }, ... });
const r = await sock.sendMessage(jid, { text: message });
```

### Después
```js
// ✅ Timeout de 30s en todos los tipos de envío
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    ),
  ]);
}

const r = await withTimeout(
  sock.sendMessage(jid, { image: { url: image }, caption: message || undefined }),
  30_000
);
const r = await withTimeout(sock.sendMessage(jid, { text: message }), 30_000);
```

**Problema eliminado:** Requests que cuelgan indefinidamente por imágenes en URLs externas lentas o inalcanzables.

---

## Código muerto eliminado

### Antes
```js
// En logoutClient — referencia a variable global que NUNCA se inicializa en el codebase
if (globalThis.__SESSIONS_VIEW) delete globalThis.__SESSIONS_VIEW[clientId];
```

### Después
```js
// Eliminado completamente
```

---

## Riesgos que siguen existiendo (no abordados en este refactor)

| Riesgo | Severidad | Motivo de no abordar |
|---|---|---|
| `SESSION_STATE` no se limpia de clientIds inactivos | Baja | Leak de memoria muy lento, no causa crashes |
| `perClientLimiter` en bulk acumula instancias Bottleneck | Media | Scope del bulk manager, fuera del objetivo de este refactor |
| `optInSet`/`optOutSet` globales entre todos los tenants | Media | Bug de negocio, no causa inestabilidad del proceso |
| Sin persistencia en DB del estado de sesiones | Media | Cambio arquitectónico mayor, fuera del alcance |
| `cancelBulk` no interrumpe un `sleep()` en curso | Baja | Puede enviar hasta ~10 s después del cancel |

---

## Nivel de estabilidad estimado

| Dimensión | Antes | Después | Cambio |
|---|---|---|---|
| **Proceso crash-safe** | 3/10 | 8/10 | +5 |
| **Resistencia a sockets duplicados** | 2/10 | 9/10 | +7 |
| **Reconexión controlada** | 3/10 | 8/10 | +5 |
| **Observabilidad (logs)** | 4/10 | 7/10 | +3 |
| **Protección de envíos** | 4/10 | 7/10 | +3 |

### Hipótesis sobre los 27 restarts en 10 horas

Los crashes de PM2 eran muy probablemente causados por esta cadena:

```
1. badSession o connectionReplaced → reconexión en loop (1.5s fijo)
2. Loop crea socket nuevo → mismo auth dir → Signal corruption
3. "identity changed" → nueva desconexión → nuevo loop
4. En algún punto, una promesa dentro de connection.update lanza sin catch
5. → unhandledRejection → proceso muere → PM2 restart
6. Todas las sesiones activas se pierden simultáneamente
7. Ciclo comienza de nuevo
```

Los tres puntos de entrada de ese ciclo están ahora bloqueados:
- `badSession`/`connectionReplaced` ya no reconectan
- El mutex `CREATING` previene sockets duplicados
- `connection.update` y `creds.update` tienen try/catch totales

---

*Fin del reporte de refactor.*
