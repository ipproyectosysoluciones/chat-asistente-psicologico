# Chat Asistente Psicológico

Asistente psicológico por WhatsApp con **RAG (Retrieval-Augmented Generation)**, un dashboard de
supervisión para profesionales y cumplimiento legal multi-jurisdicción. Maneja **datos clínicos
sensibles**, por lo que la privacidad, el cifrado y la trazabilidad son requisitos de diseño, no
aparte opcional.

## Qué es

Un sistema que acompaña a personas vía WhatsApp mediante un asistente conversacional fundamentado
en documentos clínicos propios (RAG). Cuando la conversación entra en zona de riesgo, el sistema
activa un **flujo de crisis** con escalado a humano y líneas de emergencia locales. Todo el
almacenamiento de consentimiento y datos clínicos cifra en reposo (AES-256) con rotación de claves,
y el acceso de supervisión está gobernado por RBAC.

## Características clave

- **RAG con coherencia obligatoria**: antes de emitir cualquier respuesta del LLM, un *coherence
  gate* valida que el texto esté fundamentado en los fragmentos recuperados (similitud de coseno,
  NLI y ausencia de desviación de rol). Sin grounding, no hay emisión.
- **Flujo de crisis con escalado a humano**: matcher de palabras clave de crisis (insensible a
  acentos) que dispara texto de crisis fundamentado, línea de emergencia por país y alerta roja;
  si el canal falla, la sesión es tomada por un humano.
- **Consentimiento + marco legal por geolocalización**: el flujo de onboarding propone el marco
  legal según el país (geo) y **requiere confirmación explícita** del usuario antes de persistir.
- **Encriptación AES-256 + rotación de claves**: cifrado *encrypt-then-MAC* (HMAC-SHA256), claves
  por versión (`key_version`) y rotación en ciclo de 7 días con re-encriptación por lotes y rollback.
- **RBAC de supervisión**: roles `supervisor` y `admin` con JWT (HS256, 15 min), autorización por
  allow-list y auditoría de cada acceso.
- **Dashboard de supervisión**: SPA React 19 + API Express 5/Socket.io para feed de alertas,
  *takeover* de sesiones, monitoreo de rotación de claves y validación de QR.
- **Ingesta de documentos clínicos**: filtrado de *blacklist* (nombres de fármacos/dosis),
  *chunking*, embeddings y upsert en `pgvector`.
- **Notificaciones/alertas**: enrutamiento, *dedupe/throttle* y *push* vía Socket.io con *fallback*.

## Arquitectura

Ver el diagrama y la descripción detallada en [`docs/diagrams/architecture.md`](docs/diagrams/architecture.md).

En resumen: servicios `ai-rag` (pipeline RAG + gate), `chat-bot` (WhatsApp/BuilderBot), `dashboard`
(SPA + API), `ingestion` (documentos clínicos), `notifications` (alertas internas), `e2e` (pruebas de
integración), sobre un workspace de paquetes compartidos (`crypto-keys`, `db-schema`, `llm-client`,
`shared-types`, `validation`, `telemetry`, `config`).

## Stack

- **pnpm monorepo** (pnpm@11.1.1, Node >= 22)
- **Node/TypeScript** (TS strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`)
- **React 19** (Vite) en el dashboard
- **Express 5** en las APIs
- **PostgreSQL 16 + pgvector** (índice HNSW)
- **Redis 7** (pub-sub, TTL de OTP, colas de alertas)
- **Caddy 2** (reverse proxy / TLS en el edge)
- **Docker** (multi-stage, imágenes no-root)

## Inicio rápido

```bash
# 1. Instalar dependencias del workspace
pnpm install

# 2. Aplicar migraciones de base de datos
pnpm --filter @chatcap/db-schema exec node-pg-migrate up

# 3. Levantar servicios (Postgres, Redis, apps, Caddy)
docker compose up -d
```

La API expone `/healthz` (liveness) y `/readyz` (dependencias; `ai-rag` verifica el índice vectorial).
Usa `CHATBOT_PROVIDER` y `GEOIP_PROVIDER` para cambiar proveedor de WhatsApp y geo por configuración.

## Seguridad y cumplimiento

Este proyecto trata datos de salud sensibles. El modelo de seguridad incluye consentimiento +
marcos legales, cifrado en reposo con rotación, RBAC, *rate limiting*, escalado de crisis a humano,
auditoría y la regla de **no diagnóstico / no prescripción** aplicada en la capa de salida.

Detalles en [`SECURITY.md`](SECURITY.md). Reglas de revisión en [`AGENTS.md`](AGENTS.md).

## Enlaces útiles

- [PRD.md](PRD.md) — Product Requirements Document
- [ROADMAP.md](ROADMAP.md) — hoja de ruta
- [docs/manuales/](docs/manuales/) — manuales
- [CONTRIBUTING.md](CONTRIBUTING.md) — cómo contribuir
- [SECURITY.md](SECURITY.md) — política de seguridad
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — código de conducta

---

Copyright (c) 2026 ipproyectosysoluciones. Véase [LICENSE](LICENSE).
