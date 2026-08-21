# DEPLOY — Chat Asistente Psicológico (pnpm monorepo)

Documentación de operación para el despliegue del monorepo. Cubre únicamente
**documentación + esquema de entorno**. El Docker/Compose, Caddy y el seed de
datos son responsabilidad de otros workers (Fase 7.4).

Todos los servicios derivan su configuración de un único esquema zod en
`packages/config/src/schema.ts`. El arranque falla rápido (`ConfigError`) si
falta o es inválida alguna variable requerida — no hay parsing local por
servicio. Copiá `.env.example` → `.env` (git-ignored) y completá los valores
reales. **Nunca commitees secretos.**

---

## Prerequisites

- **Docker Engine** + **Docker Compose v2** (`docker compose`, NO el binario
  heredado `docker-compose`).
- Imagen de **PostgreSQL 16 con la extensión `vector` (pgvector)**. La
  aplicación ejecuta `assertVectorIndexPresent()` al arrancar `ai-rag`; si la
  extensión no está, el servicio no pasa el readiness (ver Troubleshooting).
- **Redis 7** (pub-sub, TTL de OTP, colas de alertas).
- `pnpm` >= 11 (ver `packageManager` en `package.json`). Node >= 22.
- Acceso a la API de OpenAI (`OPENAI_API_KEY` válido).

---

## Bring up

Los manifiestos Docker/Compose/Caddy son entregados por otro worker. Una vez
presentes en el repo:

```bash
# Compose v2 — no usar "docker-compose"
docker compose up -d
```

### Servicios esperados (nombres sugeridos en la red interna de Docker)

| Servicio      | Rol                                                        | Dependencias probadas en `/readyz`        |
| ------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `postgres`    | PostgreSQL 16 + pgvector (fuente de verdad)                | —                                         |
| `redis`       | Pub-sub / TTL / colas                                      | —                                         |
| `ai-rag`      | Pipeline RAG + coherence gate (pg, redis)                  | `database`, `redis`                       |
| `chat-bot`    | WhatsApp (Baileys/Meta) + jurisdicción + crisis flow       | `database`, `ai-rag`                      |
| `ingestion`   | Embeddings + ingesta de chunks (pg, OpenAI)                | `database`                                |
| `notifications` | Push de alertas + Socket.io supervisor (pg, redis)       | `database`, `redis`                       |
| `dashboard`   | Panel supervisor (auth, takeover, QR, key-rotation)        | `database`, `chat-bot`                    |
| `caddy`       | TLS + reverse proxy (entrega del worker Caddy)             | —                                         |

### Healthchecks y readiness

Cada servicio expone (vía Express, definido en `apps/*/src/app.ts`):

- `GET /healthz` → `200 { "status": "ok" }` (liveness pura, no toca deps).
- `GET /readyz` → `200 { "status": "ready" }` cuando todas las dependencias
  responden; `503 { "status": "unready" }` si alguna falla.

**Los healthchecks de Docker deben usar `/readyz`** para gating de
preparación: un contenedor no se marca `healthy` hasta que pg/redis (y
`chat-bot` para `dashboard`) responden. `ai-rag` además requiere el índice
vectorial presente (boot check `assertVectorIndexPresent`).

---

## Configuration

Fuente de verdad: `packages/config/src/schema.ts`. La tabla lista **cada**
variable de entorno real del código.

| Variable | Propósito | ¿Requerida? | Ejemplo |
| --- | --- | --- | --- |
| `NODE_ENV` | Entorno de ejecución | No (def: `development`) | `production` |
| `LOG_LEVEL` | Nivel de log | No (def: `info`) | `info` |
| `PORT` | Puerto del servicio (cada servicio mapea el suyo) | No (def: `3000`) | `3000` |
| `DATABASE_URL` | Conexión Postgres 16 + pgvector | **Sí** | `postgres://chatcap:***@postgres:5432/chatcap` |
| `REDIS_URL` | Conexión Redis 7 | **Sí** | `redis://redis:6379` |
| `OPENAI_API_KEY` | API key OpenAI (embeddings, chat, NLI) | **Sí** | `sk-...` |
| `AI_EMISSION_ENABLED` | **Kill switch** de emisión IA (false → solo humano) | No (def: `true`) | `true` |
| `LLM_CHAT_MODEL` | Modelo de chat (siempre temp 0) | No (def: `gpt-4o`) | `gpt-4o` |
| `LLM_NLI_MODEL` | Modelo NLI/clasificación (barato) | No (def: `gpt-4o-mini`) | `gpt-4o-mini` |
| `EMBEDDING_MODEL` | Modelo de embeddings | No (def: `text-embedding-3-small`) | `text-embedding-3-small` |
| `CRYPTO_MASTER_SECRET` | Material maestro (min 32 chars); las claves por versión se derivan vía HKDF | **Sí** | `CHANGE_ME_min_32_chars_random` |
| `JWT_SECRET` | Secreto JWT firma de tokens | **Sí** (min 32) | `CHANGE_ME_min_32_chars_random` |
| `QR_KEY` | Clave de firma de payloads QR | **Sí** (min 32) | `CHANGE_ME_min_32_chars_random` |
| `ADMIN_EMAIL` | Email del admin bootstrap del dashboard | **Sí** | `admin@example.com` |
| `ADMIN_PASSWORD_HASH` | Hash bcrypt del admin | **Sí** | `CHANGE_ME_bcrypt_hash` |
| `X_INTERNAL_TOKENS` | Tokens service-to-service (red Docker privada), separados por coma | **Sí** | `tok_a,tok_b` |
| `GATE_COSINE_EMIT` | Umbral coseno para emitir (coherence gate) | No (def: `0.85`) | `0.85` |
| `GATE_COSINE_RETRY` | Umbral coseno para reintentar | No (def: `0.75`) | `0.75` |
| `GATE_MAX_RETRIES` | Reintentos del gate | No (def: `1`) | `1` |
| `GATE_NLI_ENABLED` | Habilita chequeo NLI del gate | No (def: `true`) | `true` |
| `RAG_TOP_K` | Chunks recuperados por query RAG | No (def: `5`) | `5` |
| `ALERT_THROTTLE_RED_SECONDS` | Ventana throttle alerta roja | No (def: `60`) | `60` |
| `ALERT_THROTTLE_ORANGE_SECONDS` | Ventana throttle alerta naranja | No (def: `300`) | `300` |
| `ALERT_THROTTLE_YELLOW_SECONDS` | Ventana throttle alerta amarilla | No (def: `900`) | `900` |
| `FALLBACK_PUSH_URL` | Endpoint push de fallback (REQ-ALERT-4); vacío = sin fallback | No (def: `""`) | `""` |
| `DASHBOARD_ORIGIN` | Origin permitido para Socket.io del dashboard; vacío = same-origin | No (def: `""`) | `""` |
| `GEOIP_PROVIDER` | `maxmind` \| `ipstack` \| `none` | No (def: `none`) | `none` |
| `MAXMIND_DB_PATH` | Ruta a DB MaxMind (si `GEOIP_PROVIDER=maxmind`) | Condicional | `""` |
| `IPSTACK_API_KEY` | API key IPStack (si `GEOIP_PROVIDER=ipstack`) | Condicional | `""` |
| `CHATBOT_PROVIDER` | `baileys` \| `meta` (swap config-only) | No (def: `baileys`) | `baileys` |
| `CHATBOT_BAILEYS_SESSION_DIR` | Dir de sesiones Baileys (si `baileys`) | Condicional | `""` |
| `CHATBOT_META_ACCESS_TOKEN` | Token Meta Cloud API (si `meta`) | Condicional | `""` |
| `CHATBOT_META_PHONE_NUMBER_ID` | Phone Number ID Meta (si `meta`) | Condicional | `""` |
| `CHATBOT_AI_RAG_BASE_URL` | Base URL de `ai-rag` en red interna | No (def: `http://ai-rag:3000`) | `http://ai-rag:3000` |
| `CHATBOT_INTERNAL_TOKEN` | Token de `chat-bot` a `ai-rag`; **debe estar en `X_INTERNAL_TOKENS`** | **Sí** | `tok_b` |
| `CONTACT_KEY_SALT` | Pepper para hash de contactos (min 16) | **Sí** | `CHANGE_ME_min_16_chars_random` |
| `DASHBOARD_JWT_TTL_MINUTES` | TTL del JWT del dashboard (min) | No (def: `15`) | `15` |
| `DASHBOARD_CHATBOT_BASE_URL` | Base URL de `chat-bot` para takeover | No (def: `http://chat-bot:3000`) | `http://chat-bot:3000` |
| `DASHBOARD_CHATBOT_INTERNAL_TOKEN` | Token dashboard→chat-bot ingest; **debe estar en `X_INTERNAL_TOKENS`**; vacío = ingest deshabilitado | No (def: `""`) | `tok_a` |

### Validaciones cruzadas (boot falla si no se cumple)

- `CHATBOT_INTERNAL_TOKEN` ∈ `X_INTERNAL_TOKENS`.
- `DASHBOARD_CHATBOT_INTERNAL_TOKEN` ∈ `X_INTERNAL_TOKENS` (si no vacío).
- `GATE_COSINE_EMIT` > `GATE_COSINE_RETRY`.
- `CRYPTO_MASTER_SECRET`, `JWT_SECRET`, `QR_KEY` ≥ 32 chars; `CONTACT_KEY_SALT` ≥ 16.

---

## First run

```bash
# 1) Variables de entorno
cp .env.example .env          # luego completá los valores reales en .env
export $(grep -v '^#' .env | xargs)   # o dejá que cada servicio lea .env

# 2) Migraciones de esquema (comando REAL verificado)
#    Nota: el wrapper de root `pnpm migrate:up` delega a un script que NO
#    existe en @chatcap/db-schema; usá el binario node-pg-migrate vía pnpm:
pnpm --filter @chatcap/db-schema exec node-pg-migrate up

# Rollback de la última migración si hiciera falta:
pnpm --filter @chatcap/db-schema exec node-pg-migrate down
```

El binario `node-pg-migrate` está en `packages/db-schema/node_modules/.bin` y
usa `DATABASE_URL` + el directorio `packages/db-schema/migrations` por defecto.
Migraciones actuales: `0001_initial_schema.sql`, `0002_qr_signature_payload.sql`,
`0003_rag_traces.sql`.

```bash
# 3) Seed de datos iniciales (entregado por el SEED WORKER, Fase 7.4)
#    Comando convencional — confirmá el nombre exacto con ese worker:
pnpm --filter @chatcap/db-schema seed
```

```bash
# 4) Bootstrap de admin del dashboard (ocurre en el arranque del servicio,
#    apps/dashboard/src/server/index.ts -> bootstrapAdmin con ADMIN_EMAIL /
#    ADMIN_PASSWORD_HASH). No requiere paso manual.
```

---

## Health & verification

Una vez que `docker compose up -d` estabiliza los healthchecks:

```bash
# Contra Caddy (origen TLS único) o directo al puerto del servicio:
for svc in ai-rag chat-bot ingestion notifications dashboard; do
  echo "== $svc =="
  curl -fsS http://localhost:PORT/healthz && echo "  healthz OK"
  curl -fsS http://localhost:PORT/readyz  && echo "  readyz OK"
done
```

**Verde significa:**

- `/healthz` → `200 { "status": "ok" }`: el proceso está vivo.
- `/readyz` → `200 { "status": "ready" }`: todas las dependencias de ese
  servicio responden (pg, redis; para `dashboard` también `chat-bot`; para
  `ai-rag` además el índice vectorial existe). Cualquier `503` indica una
  dependencia caída y el contenedor NO debe considerarse `healthy`.

Verificación mínima de negocio:

- `dashboard`: login con `ADMIN_EMAIL` funciona → JWT emitido.
- `ai-rag`: `/readyz` verde implica índice pgvector presente.
- `chat-bot`: conecta al proveedor configurado (`CHATBOT_PROVIDER`).

---

## Troubleshooting

| Síntoma | Causa probable | Acción |
| --- | --- | --- |
| Servicio no arranca, `ConfigError: Invalid environment configuration` | Falta/inválida variable requerida o validación cruzada | Leé la lista de `issues` en el mensaje; completá `.env`. Verificá `CHATBOT_INTERNAL_TOKEN` ∈ `X_INTERNAL_TOKENS` y `GATE_COSINE_EMIT > GATE_COSINE_RETRY`. |
| `ai-rag` en `unready` / falla al boot | Extensión `vector` (pgvector) ausente en Postgres | Recreá Postgres con imagen que incluya pgvector; verificá con `SELECT * FROM pg_extension WHERE extname='vector';`. |
| `readyz` 503 en `database` | Postgres no healthy todavía o `DATABASE_URL` mal | Esperá a que el healthcheck de `postgres` esté green; revisá credenciales/host (`postgres:5432` en red Docker). |
| `readyz` 503 en `redis` | Redis caído o `REDIS_URL` mal | Verificá contenedor `redis` y URL (`redis://redis:6379`). |
| `dashboard` `readyz` 503 | `chat-bot` no responde | `chat-bot` debe estar healthy; revisá su `readyz`. |
| Mensajes no se emiten / bot mudo | `AI_EMISSION_ENABLED=false` (kill switch) o `OPENAI_API_KEY` inválido | Poné `AI_EMISSION_ENABLED=true` para reactivar; validá la key OpenAI. |
| Alertas no llegan | `FALLBACK_PUSH_URL` vacío y Socket.io no confirma | Configurá `FALLBACK_PUSH_URL` (REQ-ALERT-4) o revisá `DASHBOARD_ORIGIN`. |
| Migración no corre | Usaste `pnpm migrate:up` (wrapper roto) | Usá `pnpm --filter @chatcap/db-schema exec node-pg-migrate up`. |
