# REPORTE TÉCNICO DE AUDITORÍA — wa-baileys-backend

**Fecha:** 2026-02-27
**Versión analizada:** commit `a9d93ec`
**Auditor:** Claude Sonnet 4.6 (arquitecto senior Node.js/Baileys/multi-tenant)

---

## 1️⃣ Arquitectura General

### Estructura del proyecto
```
src/
├── server.js              ← Punto de entrada único
├── config/env.js          ← Variables de entorno
├── sessions/
│   └── baileysManager.js  ← Motor central (sockets, auth, envío)
├── routes/
│   ├── sessionRoutes.js   ← CRUD de sesiones
│   ├── messageRoutes.js   ← Envío de mensajes
│   ├── adminRoutes.js     ← Estado y listado
│   └── bulkRoutes.js      ← Campañas masivas
├── bulk/
│   └── bulkManager.js     ← Lógica de campañas
├── middleware/
│   ├── apiKey.js          ← Autenticación
│   ├── rateLimit.js       ← Rate limiting
│   └── securityHeaders.js ← Helmet
├── jobs/
│   └── reminderJob.js     ← Cron jobs
├── health/healthRoute.js  ← Health check
└── utils/logger.js        ← Logger custom
```

### Punto de entrada
`src/server.js`: Express + Socket.IO sobre un `http.createServer`. Todos los routers montados bajo `/api` con `apiKeyMiddleware + limiter`. El `io` (Socket.IO) se inyecta en `req.io` vía middleware global.

### Organización por capas
Existe una separación razonable: la capa de routing delega en el manager. No hay capa de servicios intermedia entre routes y el manager; las routes llaman directamente a `baileysManager.js`. Para el tamaño actual del proyecto es aceptable, pero crea acoplamiento directo.

### Flujo general al enviar un mensaje
```
POST /api/send
  → messageRoutes.js
    → getClient(clientId)         // lookup en SESSIONS{}
    → sendMessageSafe(clientId, …)
      → getState(clientId)        // verifica status === "ready"
      → sock.sendMessage(jid, …)  // llamada Baileys
  → res.json({status:"sent", id})
```

---

## 2️⃣ Gestión de Sesiones (Baileys)

### Registro central
`src/sessions/baileysManager.js` líneas 14-15:
```js
const SESSIONS = {};       // clientId -> sock
const SESSION_STATE = {};  // clientId -> { status, reason, … }
```
Dos objetos planos, module-level, actuando como singleton. Correcta aproximación para proceso único.

### Creación de sesiones
`getOrCreateClient({ clientId, io, phoneNumber })` — línea 52:
1. Guard check: `if (SESSIONS[clientId]) return SESSIONS[clientId]`
2. `useMultiFileAuthState(authDir)` → **await** (cede el event loop)
3. `makeWASocket(…)`
4. `SESSIONS[clientId] = sock`

### ⚠️ RIESGO CRÍTICO — Race Condition en creación
**Entre el paso 1 (check) y el paso 4 (assign) hay dos `await` que ceden el event loop.** Si dos requests HTTP llegan simultáneamente para el mismo `clientId`:

```
Request A: if(SESSIONS[id]) → null → pasa
Request B: if(SESSIONS[id]) → null → pasa  ← slips through
Request A: await useMultiFileAuthState(…)   ← cede event loop
Request B: await useMultiFileAuthState(…)   ← también entra
Request A: SESSIONS[id] = sockA
Request B: SESSIONS[id] = sockB             ← SOBRESCRIBE sockA
```
Resultado: **dos sockets activos con el mismo auth state** antes de que `SESSIONS[id]` se fije en uno solo. `sockA` queda "huérfano" (sin referencia en SESSIONS), pero sigue activo, conectado a WA, compitiendo por el mismo canal Signal.

### Eliminación de sesiones
- **logout**: elimina de SESSIONS, borra directorio de auth en disco
- **reconnect interno**: `delete SESSIONS[clientId]` + setTimeout 1500ms → `getOrCreateClient`
- **restart manual**: `sock.end()` → `delete SESSIONS[clientId]` → `getOrCreateClient`

### ⚠️ RIESGO CRÍTICO — Socket zombie en reconexión
Cuando `sock.end()` se llama en `restartClient` (línea 213), Baileys internamente dispara `connection.update` con `connection: "close"`. El listener de `connection.update` del socket viejo **sigue activo** y ejecuta:
```js
setTimeout(() => {
  delete SESSIONS[clientId];
  getOrCreateClient({ clientId, io, phoneNumber }); // ← segunda creación
}, 1500);
```
`restartClient` ya inició la primera `getOrCreateClient`. La del setTimeout inicia la segunda. **Dos sockets para el mismo clientId, mismo auth folder.**

---

## 3️⃣ Manejo de Auth State

### Mecanismo
`useMultiFileAuthState(authDir)` es el mecanismo estándar de Baileys. Correcto. Ruta determinada por `path.join(env.AUTH_ROOT, clientId)`.

### Listener `creds.update`
`baileysManager.js` línea 73: `sock.ev.on("creds.update", saveCreds)` — correcto. Se registra inmediatamente tras crear el socket.

### ⚠️ RIESGO ALTO — Acceso concurrente al mismo directorio de auth
Cuando hay dos sockets para el mismo `clientId` (por la race condition descrita), **ambos sockets comparten el mismo `authDir`**. Ambos tienen su propio `saveCreds` llamando `fs.writeFile` sobre los mismos archivos. El resultado es una escritura concurrente no controlada:

- Socket A autentica → escribe `creds.json` con keys del Signal Session A
- Socket B autentica → sobrescribe `creds.json` con keys del Signal Session B
- Socket A intenta enviar un mensaje usando el estado antiguo → WA responde **"identity changed"** o **"No session found to decrypt"**

### Acceso directo a internals de Baileys
`baileysManager.js` línea 103:
```js
!sock.authState?.creds?.registered
```
Acceso a propiedad interna de Baileys. Puede romperse en actualizaciones de la librería.

### Protección contra corrupción
No existe ningún mecanismo de lock de archivos, mutex, ni validación de integridad de las credenciales al leer. Si `saveCreds` falla silenciosamente (disco lleno, permisos), la sesión quedará corrompida sin log visible.

---

## 4️⃣ Lógica de Reconexión

### Handler `connection.update`
`baileysManager.js` líneas 89-190:

```js
if (connection === "close") {
  const code = lastDisconnect?.error?.output?.statusCode;
  const willReconnect = code !== DisconnectReason.loggedOut;
  // …
  if (willReconnect) {
    setTimeout(() => {
      delete SESSIONS[clientId];
      getOrCreateClient({ clientId, io, phoneNumber }).catch(() => {});
    }, 1500);
  }
}
```

### ⚠️ RIESGO CRÍTICO — Solo `loggedOut` se maneja explícitamente
Baileys v7 tiene múltiples `DisconnectReason`. Solo `loggedOut` está diferenciado. Los siguientes casos críticos **no se manejan** y disparan `willReconnect = true` (reconexión infinita):

| DisconnectReason        | Comportamiento actual      | Comportamiento correcto            |
|-------------------------|----------------------------|------------------------------------|
| `loggedOut`             | ✅ No reconecta            | Correcto                           |
| `badSession`            | ❌ Reconecta en loop       | Eliminar auth, detener             |
| `multideviceMismatch`   | ❌ Reconecta en loop       | Eliminar auth, detener             |
| `connectionReplaced`    | ❌ Reconecta en loop       | Detener (otra instancia tomó sesión) |
| `timedOut`              | ❌ Reconecta (OK)          | Correcto, pero sin backoff         |
| `undefined` (sin error) | ❌ Reconecta siempre       | Depende del contexto               |

Cuando `code === undefined` (desconexión limpia sin error), `willReconnect = undefined !== DisconnectReason.loggedOut = true`. **Siempre reconecta**, incluso en casos donde no debería.

### ⚠️ RIESGO ALTO — Ventana de race condition durante reconexión
El `delete SESSIONS[clientId]` ocurre dentro del setTimeout (1500ms después del cierre). Durante esos 1500ms, `SESSIONS[clientId]` es el socket viejo (cerrado). Si llega una petición `/api/send` en ese intervalo, `getClient(clientId)` retorna el socket muerto → error de envío. Si llega `/api/session`, pasa el guard check y crea un nuevo socket. El setTimeout luego **también** crea uno. Dos sockets.

### Sin backoff exponencial
El delay fijo de 1500ms es insuficiente para disrupciones de red largas. Si WA está caído, el sistema creará y destruirá sockets cada ~1.5 segundos de forma agresiva.

---

## 5️⃣ Manejo de Eventos

### Eventos implementados
- `creds.update` → `saveCreds` ✅
- `connection.update` → handler completo ✅
- `messages.upsert` → **NO implementado** (diseño outbound-only, aparentemente intencional)

### Ausencia de try/catch en eventos async
`baileysManager.js` línea 89: el handler de `connection.update` es `async (u) => {}` sin try/catch envolvente. Si cualquier instrucción lanza, el error no es capturado a nivel del event listener.

### El pairing code tiene su propio try/catch
`baileysManager.js` líneas 113-132: el `setTimeout` interno tiene try/catch, correcto. Pero el `pairingRequested = false` en el catch permite reintento, lo que puede crear una cadena de pairing requests si el QR se renueva repetidamente.

### Loop del bulk manager sin cancelación limpia
`bulkManager.js` línea 182: el IIFE async interno no tiene forma de ser interrumpido externamente (no hay AbortController, no hay señal de cancelación). `cancelBulk` solo cambia `bulk.status = "cancelled"`, pero si el loop está en medio de un `await sleep(jitteredDelay())` (puede ser hasta 10 segundos), seguirá esperando antes de detectar el cambio. Pueden enviarse mensajes después del cancel.

---

## 6️⃣ Riesgos Estructurales Detectados

### 🔴 Riesgo: Múltiples sockets por organization — CRÍTICO
**Tres vectores de aparición:**

1. **Dos HTTP requests concurrentes a `/api/session` o `/api/session/pairing`** para el mismo `clientId` → ambas pasan el guard check durante los awaits de `useMultiFileAuthState`.

2. **`restartClient` + `connection.update` del socket terminado** → el `sock.end()` dispara el evento de cierre que activa el reconectador, mientras `restartClient` ya inició el nuevo socket.

3. **Reconexión automática + request HTTP durante la ventana de 1500ms** → `SESSIONS[clientId]` fue borrado por la reconexión pero el nuevo socket aún no se asignó.

### 🔴 Riesgo: Corrupción del estado Signal — CRÍTICO
Consecuencia directa del punto anterior. Dos sockets con el mismo auth state compiten por el canal Signal. WhatsApp solo acepta una instancia activa por sesión. La segunda instancia activa provoca que WA revoque las claves del primero → errores de tipo **"identity changed"** o **"No session found to decrypt message"**. El ciclo es autoalimentado: el error provoca un cierre → reconexión → nuevo socket → mismo problema.

### 🟠 Riesgo: Pérdida de sesión — ALTO
Si `saveCreds` falla silenciosamente (excepción tragada por Baileys internamente, permisos de disco, etc.), las credenciales no se actualizan. En la próxima reconexión, el estado de auth está desincronizado con WA → sesión perdida sin log claro.

### 🟠 Riesgo: Race condition en reconexión — ALTO
Descrito en §4. La ventana de 1500ms entre `delete SESSIONS[clientId]` y la creación del nuevo socket es un agujero donde entran solicitudes externas.

### 🟡 Riesgo: Memory leak lógico — MEDIO
- `SESSION_STATE` nunca se limpia de clientIds inactivos
- `perClientLimiter` en `bulkManager.js` acumula Bottleneck instances indefinidamente
- `BULKS` Map nunca elimina campañas terminadas
- Listeners del socket viejo permanecen activos tras `delete SESSIONS[clientId]`

### 🟡 Riesgo: Reconexión agresiva — MEDIO
Sin backoff exponencial, delay fijo 1500ms, sin límite de intentos, sin manejo de `badSession`/`multideviceMismatch`. En una disrupción seria puede crear decenas de sockets en pocos minutos.

---

## 7️⃣ Diseño Multi-tenant

### Aislamiento por organization
El aislamiento se basa en `clientId` como clave en `SESSIONS{}` y `SESSION_STATE{}`. Cada clientId tiene:
- Su propio socket Baileys
- Su propio directorio de auth (`AUTH_ROOT/clientId/`)
- Su propia "room" en Socket.IO (join por clientId)
- Su propio limiter en `perClientLimiter`

### ¿Puede una organization afectar a otra?
Teóricamente no por diseño, pero en la práctica **sí** por los siguientes vectores:

1. **Proceso compartido**: Un crash no capturado en un socket podría afectar el proceso entero.
2. **Sets globales de consentimiento**: `optInSet`, `optOutSet`, `blacklistSet` son **globales**, no por clientId. El opt-out de un número aplica a **todas** las organizations. Esto es probablemente un bug de diseño.
3. **`dailyCount` Map**: Los contadores diarios sí están por clientId. Correcto.
4. **`BULKS` Map global**: Las campañas de un clientId son visibles para otro (`GET /api/bulk/list` devuelve todas las campañas sin filtrar por clientId).

### ¿Escala correctamente?
No. El modelo en memoria (SESSIONS, SESSION_STATE, BULKS, optInSet) es de proceso único. No puede escalar horizontalmente. Si se agregan más instancias del proceso, cada una tendría su propio estado sin sincronización. Para escalar correctamente se requeriría persistencia externa (Redis, DB).

### ¿Preparado para CRM + bot?
Estructuralmente sí, pero requiere:
- Implementar `messages.upsert` para mensajes entrantes
- Enrutar eventos por clientId hacia el sistema CRM
- El Socket.IO ya está listo (rooms por clientId)

---

## 8️⃣ Nivel de Madurez Arquitectónica

| Dimensión              | Puntuación | Justificación                                                                                                                                         |
|------------------------|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Diseño actual**      | 4/10       | Estructura clara pero race condition crítica en el componente más importante. El guard check `if (SESSIONS[clientId])` no es seguro en contexto async. |
| **Estabilidad potencial** | 3/10    | La combinación de race conditions en creación + reconexión + `sock.end()` triggerando el handler viejo hace que bajo carga moderada aparezcan sesiones duplicadas y corrupción Signal. |
| **Escalabilidad**      | 2/10       | Todo en memoria de proceso único. No hay persistencia de sesiones, campañas ni opt-ins. Reiniciar el proceso = perder todo el estado activo. No es horizontalmente escalable. |
| **Claridad estructural** | 6/10     | Separación de archivos razonable para el tamaño del proyecto. Naming consistente. Código legible. Logger funcional. Puntos bajos: `globalThis.__SESSIONS_VIEW` sin contexto, exposición de `__state` con doble guión bajo sin razón clara. |

---

## 9️⃣ Problemas Críticos (Alta Prioridad)

### CRÍTICO-1: Race condition en `getOrCreateClient`
**Archivo:** `src/sessions/baileysManager.js` líneas 52-68

El guard `if (SESSIONS[clientId]) return` no protege contra llamadas concurrentes porque el `await useMultiFileAuthState()` cede el event loop. Dos requests simultáneas crean dos sockets para el mismo clientId. **Este es el origen más probable de "identity changed" y "No session found to decrypt message".**

### CRÍTICO-2: `sock.end()` dispara el reconectador automático
**Archivo:** `src/sessions/baileysManager.js` líneas 210-220 y 183-189

`restartClient` y `logoutClient` llaman `sock.end()`. Esto dispara `connection.update` con `connection: "close"` en el socket viejo, cuyo handler **todavía está vivo**. El reconectador automático se activa. La función que llamó `restartClient` también crea un nuevo socket. Resultado: dos sockets.

### CRÍTICO-3: Solo `loggedOut` diferenciado en `DisconnectReason`
**Archivo:** `src/sessions/baileysManager.js` línea 175

`badSession`, `multideviceMismatch`, `connectionReplaced` activan reconexión infinita en lugar de detener y limpiar. Esto crea loops que aceleran la corrupción de credenciales.

### CRÍTICO-4: `optInSet`/`optOutSet`/`blacklistSet` son globales entre tenants
**Archivo:** `src/bulk/bulkManager.js` líneas 17-19

Un opt-out registrado para el tenant A afecta al tenant B. En un sistema multi-tenant esto es un bug de aislamiento de datos.

---

## 🔟 Problemas Medios

### MEDIO-1: Sin backoff exponencial en reconexión
Delay fijo de 1500ms sin límite de intentos. En disrupciones largas = decenas de sockets/minuto.

### MEDIO-2: `cancelBulk` no detiene mensajes en-flight
`bulk.status = "cancelled"` es detectado solo al inicio de cada iteración. Si el loop está en `await sleep(jitteredDelay())`, puede continuar enviando hasta 10 segundos.

### MEDIO-3: `perClientLimiter` y `BULKS` crecen indefinidamente
Sin limpieza de Bottleneck instances ni campañas terminadas. En producción con muchos clientes = leak de memoria gradual.

### MEDIO-4: Todo el estado está en memoria volátil
Campañas, opt-ins, opt-outs, sesiones activas: todo se pierde en un reinicio. Las sesiones en disco se recuperan (Baileys auth), pero el estado de campañas activas no.

### MEDIO-5: Rate limiter bypasseado por API key válida
`src/middleware/rateLimit.js` línea 12: `key === env.API_KEY` → skip del limiter. Si la API key se filtra, no hay protección de throttling.

### MEDIO-6: `reminderJob` no tiene retry ni circuit breaker
`src/jobs/reminderJob.js` líneas 21-28: si `agenda-backend` está caído, el error se loguea y se ignora. No hay alertas ni acumulación de estado.

### MEDIO-7: Body limit de 2MB para imágenes base64
`src/server.js` línea 40: `express.json({ limit: "2mb" })`. Las imágenes base64 de 1.5MB reales ocupan ~2MB en base64. Límite muy ajustado, y el body parser las mantiene en memoria.

### MEDIO-8: `globalThis.__SESSIONS_VIEW` en `logoutClient`
`src/sessions/baileysManager.js` línea 243: referencia a una variable global que nunca se inicializa en este codebase. Es código muerto de una versión anterior que nunca se limpió.

---

## 1️⃣1️⃣ Buenas Prácticas Ya Implementadas

1. **ESM nativo** (`"type": "module"`) — módulos modernos, sin CommonJS.
2. **Validación de env al arranque** — `required()` en `env.js` aborta el proceso si faltan variables críticas. Correcto.
3. **Helmet + CORS configurado** — headers de seguridad presentes.
4. **JWT efímero para WebSocket** — autenticación dual (API key + JWT) en Socket.IO es una buena práctica para frontend temporal.
5. **Socket.IO rooms por clientId** — el modelo pub/sub por tenant está correctamente diseñado.
6. **`jitteredDelay()` en bulk** — delays aleatorios entre mensajes para evitar detección de bot. Correcto.
7. **Bottleneck con `maxConcurrent: 1` por cliente** — serialización correcta de envíos por tenant.
8. **`dryRun` en campañas** — permite validar sin enviar.
9. **`classifyError()` en bulk** — clasificación heurística de errores de WA para decisiones de pausa.
10. **Pairing code como alternativa a QR** — la arquitectura lo soporta limpiamente.
11. **Logger con niveles y output estructurado** — formato compatible con log aggregation.
12. **Health endpoint sin auth** — `/health` sin API key es correcto para load balancers.
13. **`syncFullHistory: false`** — reduce tráfico inicial de Baileys.

---

## 1️⃣2️⃣ Conclusión Técnica

**El backend está bien organizado estructuralmente** para su tamaño, con buenas elecciones en librerías, separación de rutas y un diseño de campañas bulk que muestra criterio técnico. Sin embargo, **el componente más crítico del sistema — la gestión de sockets Baileys — tiene una vulnerabilidad arquitectónica grave** que probablemente explica los síntomas observados en producción.

---

### Hipótesis técnica sobre los errores observados

**"identity changed" y "No session found to decrypt message"** son errores del protocolo Signal de WhatsApp. Ocurren cuando WA recibe mensajes firmados con claves de identidad que ya no son las autorizadas para esa sesión.

**Secuencia más probable de cómo ocurre:**

```
T+0ms    Reconexión normal → connection.update {connection:"close"}
T+0ms    willReconnect = true → setTimeout(1500ms, reconectar)
T+0ms    SESSIONS[id] permanece con sock viejo (cerrado)

T+200ms  Request HTTP /api/session/pairing llega (retry del frontend)
T+200ms  if(SESSIONS[id]) → sock viejo existe → return sock viejo
         ← el frontend asume que hay sesión activa

T+1500ms setTimeout → delete SESSIONS[id] → await getOrCreateClient
         → useMultiFileAuthState(authDir) → crea SOCK-2
T+1500ms SESSIONS[id] = SOCK-2
T+1600ms SOCK-2 conecta a WA con el auth del disco
T+1600ms WA registra las claves de identidad de SOCK-2

[Alternativa — dos requests simultáneas a /api/session]
T+0ms    SOCK-A y SOCK-B se crean concurrentemente
T+100ms  SOCK-A conecta, WA registra sus claves
T+150ms  SOCK-B conecta con MISMO auth → WA revoca claves de SOCK-A
T+200ms  SOCK-A intenta enviar → "identity changed"
```

**El ciclo se amplifica** porque cada error de Signal provoca una desconexión, que activa el reconectador, que puede crear otro socket duplicado, que vuelve a corromper el estado Signal.

**La causa raíz es una sola**: el guard check en `getOrCreateClient` no es atómico en un contexto asíncrono. Todo lo demás son consecuencias en cascada.

---

*Fin del reporte — Estado del backend pre-refactor documentado.*
