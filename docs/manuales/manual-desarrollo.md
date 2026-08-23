# Manual de desarrollo

Este manual describe el flujo de trabajo para **desarrolladores** del monorepo
Chat Asistente Psicológico. Cubre entorno local, ejecución de servicios, tests y el
modelo de ramas.

> Reglas de cumplimiento y code review vivas en `AGENTS.md`. El repo maneja datos de
> salud sensibles: sin secretos en el código, sin `console.log` de PII, TS strict.

---

## 1. Estructura del monorepo

- **`apps/`** (5 apps + e2e):
  - `ai-rag` (puerto 4003) — pipeline RAG + coherence gate.
  - `chat-bot` (4001) — servicio WhatsApp (BuilderBot).
  - `dashboard` (3000) — SPA de supervisión + API.
  - `e2e` — suite de integración (vitest + socket.io-client).
  - `ingestion` (4004) — ingesta de documentos clínicos.
  - `notifications` (4002) — enrutado de alertas (solo interna).
  - Todos bajo el scope `@chatcap/*`, privados.
- **`packages/`** (7):
  - `config` — esquema Zod de env + `KeyProvider`.
  - `crypto-keys` — AES-256-CBC, HKDF, OTP, QR, rotación.
  - `db-schema` — migraciones node-pg-migrate, repos, seed.
  - `llm-client` — cliente OpenAI-compatible.
  - `shared-types` — vocabulario de dominio `as const` (sin enums).
  - `telemetry` — Pino + redactor PII + RedisEventEmitter.
  - `validation` — coherence gate.
- **`openspec/changes/`** — propuestas SDD (`chat-asistencia-psicologica`,
  `residual-security`).
- **Raíz:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`,
  `docker-compose.yml`, `Caddyfile`, `.env.example`.

Catálogo compartido (pnpm catalog): TypeScript ^5.9.3, Vitest ^3.2.7, Zod ^4.0.0,
Pino ^9.6.0, ioredis ^5.4.0, pg ^8.13.0, node-pg-migrate ^7.9.0, node-cron ^3.0.3,
express ^5.2.1, socket.io ^4.8.3, React ^19.2.0, Vite ^7.3.0, bcryptjs ^3.0.0.

---

## 2. Entorno local

Requisitos: **pnpm 11.1.1**, **Node >= 22**.

```bash
# 1. Instalar dependencias del workspace
pnpm install

# 2. Aplicar migraciones (db-schema)
pnpm --filter @chatcap/db-schema exec node-pg-migrate up

# 3. Levantar infra (postgres + redis + servicios) en segundo plano
docker compose up -d
```

Levantar solo la infra base (sin build de apps) también es válido si corres los
servicios localmente (ver sección 4).

---

## 3. Tests

```bash
# Typecheck en todo el workspace
pnpm -r typecheck

# Tests unitarios/integración en todo el workspace
pnpm -r test

# Build en todo el workspace
pnpm -r build
```

La suite **e2e** (`apps/e2e`) cubre rotación, alerta, purge, consent, flow y
takeover con vitest + socket.io-client. Nota: `apps/e2e/tests/flow.test.ts:62`
marca el path de webhook inbound como "not implemented yet (task 4.6)"; el ingest de
respuesta del supervisor y el webhook inbound no están totalmente ejercitados en e2e.

---

## 4. Cómo correr un servicio

Usa el filtro de workspace para ejecutar una app concreta:

```bash
# Ejemplo: correr ai-rag
pnpm --filter @chatcap/ai-rag <script>

# Ejemplo: correr dashboard
pnpm --filter @chatcap/dashboard dev
```

Sustituye `<script>` por el script definido en el `package.json` de la app (p.ej.
`dev`, `start`, `build`). Cada servicio necesita su bloque de variables de entorno
(ver `.env.example`); en local puedes exportarlas o usar un `.env` en la raíz.

Para correr todos los servicios vía Docker:

```bash
docker compose up -d --build
```

---

## 5. Modelo de ramas (dev-first)

El desarrollo es **dev-first**:

1. **TODO vive en `dev`.** Nunca trabajes directo sobre `main`.
2. Crea ramas **desde `dev`** con prefijo por tipo:
   - `feat/*` — nueva funcionalidad.
   - `fix/*` — corrección de bug.
   - `chore/*` — mantenimiento / configuración.
3. Haz merge de tu rama a **`dev`**.
4. `dev` se mergea a **`main`** (por ejemplo en release).

```bash
git switch dev
git pull
git switch -c feat/mi-funcionalidad
# ... trabajo ...
git switch dev
git merge feat/mi-funcionalidad
# release: dev -> main
```

---

## 6. Convenciones de commit

- **Commits convencionales:** `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, etc.
- **Sin `Co-Authored-By`** ni atribución de IA.
- **Sin secretos** en el diff (ni en comentarios ni en ejemplos).
- TypeScript en modo **strict** (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `isolatedModules`); respeta las reglas de `AGENTS.md`.

---

## 7. Notas de madurez

- Fuertemente implementado con tests unit + integración reales: pipeline RAG + gate,
  flujos de chat-bot, crypto-keys, notifications, dashboard, ingestion, db-schema.
- Sin marcadores `TODO`/`FIXME`/`placeholder` en producción.
- Discrepancia conocida: Dockerfiles fijan `node:20-slim` mientras el repo requiere
  `node >= 22` — reconciliar antes de prod (ver manual de despliegue).
