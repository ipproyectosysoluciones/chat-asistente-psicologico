# Manual de despliegue

Este manual describe cómo desplegar y operar Chat Asistente Psicológico en
infraestructura propia. Está dirigido a **operaciones / infraestructura**.

> No ejecutes comandos con secretos reales en scripts compartidos. Usa `.env`
> (git-ignored) con valores de `.env.example`. El esquema de `packages/config`
> valida cada variable con Zod al arranque y **falla rápido** si falta alguna.

---

## 1. Prerrequisitos

- **Docker** + **Docker Compose v2** (`docker compose`, no el legacy `docker-compose`).
- **pnpm** `11.1.1` (gestor de workspaces).
- **Node.js** — *ver nota de discrepancia en la sección 8*.
- **PostgreSQL 16 + pgvector** (imagen `pgvector/pgvector:pg16` en el compose).
- **Redis 7** (pub-sub, TTL de OTP, colas de alertas).

El compose levanta Postgres, Redis y todos los servicios; solo necesitas Docker y
pnpm disponibles en el host.

---

## 2. Despliegue con Docker Compose

El contexto de build es la raíz del monorepo; cada servicio construye su
`apps/<app>/Dockerfile` (multi-stage, `pnpm deploy --prod`, no-root, `tsx`).

Servicios y puertos internos:

| Servicio | Puerto | Rol |
| --- | --- | --- |
| `postgres` | 5432 | PostgreSQL 16 + pgvector |
| `redis` | 6379 | Redis 7 |
| `chat-bot` | 4001 | Servicio WhatsApp (BuilderBot) |
| `notifications` | 4002 | Enrutado de alertas (solo red interna) |
| `ai-rag` | 4003 | Pipeline RAG + coherence gate |
| `ingestion` | 4004 | Ingesta de documentos clínicos |
| `dashboard` | 3000 | SPA de supervisión + API |
| `caddy` | 80 / 443 | Edge TLS / reverse proxy |

Levantar:

```bash
docker compose up -d --build
```

`caddy` depende de los demás servicios; cada servicio tiene `healthcheck` y
`restart: unless-stopped`.

---

## 3. Caddy como edge TLS / reverse proxy

El `Caddyfile` expone TLS y enruta por prefijo (primera coincida gana):

1. `/api/v1/rag/process` y `/internal/*` → `ai-rag:4003`
2. `/api/v1/documents*` → `ingestion:4004`
3. `/webhook*` → `chat-bot:4001`
4. todo lo demás (UI + API del dashboard) → `dashboard:3000`

`notifications` es **solo red interna** (sin ruta pública Caddy); otros servicios lo
alcanzan por la red Docker privada.

- Por defecto corre **offline** con certificados autofirmados (`tls internal` en
  `:443`). Para dominio público, reemplaza `:80`/`:443` por tu dominio y quita
  `tls internal` (Caddy obtiene certificado Let's Encrypt).
- **Rate limiting edge por IP:** 100 req / 10 s (`RATE_LIMIT_REQUESTS` /
  `RATE_LIMIT_WINDOW`). `/healthz` y `/readyz` están exentos.

---

## 4. Variables de entorno críticas

Copia `.env.example` a `.env` y completa los placeholders. **Nunca commits secretos
reales.** Variables clave (placeholders, no valores reales):

```dotenv
# Runtime
NODE_ENV=production
LOG_LEVEL=info

# PostgreSQL 16 + pgvector
DATABASE_URL=postgres://chatcap:${POSTGRES_PASSWORD}@postgres:5432/chatcap

# Redis 7
REDIS_URL=redis://redis:6379

# OpenAI (modelo por configuración; swap config-only)
OPENAI_API_KEY=sk-${OPENAI_API_KEY}
LLM_CHAT_MODEL=gpt-4o
LLM_NLI_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
AI_EMISSION_ENABLED=true

# Material criptográfico maestro (mín. 32 chars; NUNCA se almacena)
CRYPTO_MASTER_SECRET=${CRYPTO_MASTER_SECRET}
JWT_SECRET=${JWT_SECRET}
QR_KEY=${QR_KEY}

# Bootstrap admin dashboard
ADMIN_EMAIL=${ADMIN_EMAIL}
ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}

# Auth servicio-a-servicio (red Docker privada)
X_INTERNAL_TOKENS=${TOKEN_A},${TOKEN_B}

# Umbrales del coherence gate
GATE_COSINE_EMIT=0.85
GATE_COSINE_RETRY=0.75
GATE_MAX_RETRIES=1
GATE_NLI_ENABLED=true

# Throttle de alertas por nivel (segundos)
ALERT_THROTTLE_RED_SECONDS=60
ALERT_THROTTLE_ORANGE_SECONDS=300
ALERT_THROTTLE_YELLOW_SECONDS=900
FALLBACK_PUSH_URL=

# Geolocalización
GEOIP_PROVIDER=none   # maxmind | ipstack | none
MAXMIND_DB_PATH=
IPSTACK_API_KEY=

# chat-bot (proveedor WhatsApp + jurisdicción)
CHATBOT_PROVIDER=baileys   # baileys | meta
CHATBOT_BAILEYS_SESSION_DIR=
CHATBOT_META_ACCESS_TOKEN=
CHATBOT_META_PHONE_NUMBER_ID=
CHATBOT_AI_RAG_BASE_URL=http://ai-rag:4003
CHATBOT_INTERNAL_TOKEN=${TOKEN_B}
CONTACT_KEY_SALT=${CONTACT_KEY_SALT}

# dashboard
DASHBOARD_JWT_TTL_MINUTES=15
DASHBOARD_CHATBOT_BASE_URL=http://chat-bot:4001
DASHBOARD_CHATBOT_INTERNAL_TOKEN=${TOKEN_A}
```

`CHATBOT_INTERNAL_TOKEN` y `DASHBOARD_CHATBOT_INTERNAL_TOKEN` **deben** coincidir con
valores en `X_INTERNAL_TOKENS` (se verifican al arranque).

---

## 5. Migraciones

Las migraciones viven en `packages/db-schema` (node-pg-migrate). Aplicarlas:

```bash
pnpm --filter @chatcap/db-schema exec node-pg-migrate up
```

Esto crea tablas (`legal_frameworks`, `key_versions`, `sessions`, `consent_records`,
`qr_signatures`, `users`, `alerts`, `documents`/`vector_chunks`/`ingestion_jobs`,
`otp_codes`, `re_encryption_batches`, `audit_logs`) y el índice HNSW sobre
`vector_chunks.embedding`. Al arrancar, `assertVectorIndexPresent` valida que el
índice existe.

---

## 6. Backups y restauración

La estrategia de respaldo y recuperación de Postgres/Redis y los pasos de
restauración están documentados en **`BACKUP_RESTORE.md`** (raíz del repo). Consúltalo
antes de cualquier mantenimiento que toque volúmenes (`pgdata`, `redisdata`).

---

## 7. Rotación operativa de claves y OTP

- **Claves maestras:** el material se deriva por HKDF-SHA256; la rotación es cada
  **7 días** con margen forzado de **12 h**, en ventana de bajo tráfico, por lotes de
  100–500 filas con rollback (`re_encryption_batches`). No almacenes el secreto
  maestro en el repo; en producción usa Vault/KMS (`KeyProvider` es swappable).
- **OTP de consentimiento:** 6 dígitos, 10 minutos de validez (TTL en Redis). La
  renovación de QR requiere OTP verificado.
- Cualquier acceso/rotación queda en `audit_logs`.

---

## 8. Health checks

Cada servicio expone:

- `/healthz` — liveness.
- `/readyz` — dependencias (para `ai-rag` incluye la aserción del índice vectorial).

Ambas rutas están **exentas** del rate limit de Caddy. Los `healthcheck` de compose
usan estos endpoints con `curl -f http://localhost:<puerto>/healthz`.

---

## 9. ⚠️ Discrepancia de versiones de Node (reconciliar antes de prod)

- `package.json` (raíz) declara `engines.node >= 22`.
- Los `Dockerfile` de los servicios fijan **`node:20-slim`**.

Esta discrepancia debe reconciliarse **antes de producción**: o bien se sube la
imagen base de los Dockerfiles a `node:22-slim` (recomendado, para coincidir con
`engines`), o bien se ajusta `engines` — pero mantener `20-slim` con `engines >= 22`
es inconsistente y riesgoso. No llevar a prod hasta alinear ambos.
