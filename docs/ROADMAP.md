# ROADMAP — Chat Asistente Psicológico

> Hoja de ruta basada en el factsheet del repositorio. Las fases 1–7 están completadas y la plataforma está integrada en `main` con suite e2e. Los próximos pasos derivan de los gaps documentados.

## Estado actual

Plataforma **integrada en `main`** con suite de tests e2e (rotación, alerta, purga, consentimiento, flujo, takeover). Monorepo pnpm con 5 servicios de producto (`chat-bot`, `ai-rag`, `ingestion`, `notifications`, `dashboard`) + app de tests `e2e`, y 7 packages compartidos (`config`, `crypto-keys`, `db-schema`, `llm-client`, `shared-types`, `telemetry`, `validation`).

## Tabla de fases

| Fase | Nombre | Alcance | Estado |
|------|--------|---------|--------|
| 1 | Fundación | Monorepo pnpm, TS strict, base de datos (`db-schema`), 7 packages compartidos, configuración de entorno y `crypto-keys` (AES-256-CBC + HKDF + rotación). | ✅ COMPLETADO |
| 2 | Notifications | `notifications` (4002, internal-only): alert routing, dedupe/throttle por nivel, push Socket.io, fallback `FALLBACK_PUSH_URL`. | ✅ COMPLETADO |
| 3 | ai-rag | `ai-rag` (4003): pipeline RAG (classify → retrieve → generate → coherence gate), pgvector, gate de coherencia obligatorio. | ✅ COMPLETADO |
| 4 | chat-bot | `chat-bot` (4001): WhatsApp (BuilderBot 3-pillar), onboarding de jurisdicción, emisión RAG fundamentada, flujo de crisis, consentimiento + QR, geo, purga. | ✅ COMPLETADO |
| 5 | Dashboard | `dashboard` (3000): SPA React 19/Vite + API Express 5/Socket.io, JWT RBAC, auditoría, takeover, QR, rotación de claves, alertas. | ✅ COMPLETADO |
| 6 | Ingestion | `ingestion` (4004): ingesta de documentos clínicos (blacklist, chunking, embeddings, upsert pgvector). | ✅ COMPLETADO |
| 7 | Integración / Deployment / Seed | docker-compose (postgres + redis + servicios + caddy), Caddyfile con rutas y rate-limit edge, migraciones, seed script, e2e suite. | ✅ COMPLETADO |

## Próximos pasos (futuro, derivado de gaps del factsheet)

| # | Iniciativa | Origen / Gap | Notas |
|---|-----------|--------------|-------|
| 1 | **Webhook inbound (task 4.6)** | `e2e/tests/flow.test.ts:62`: "not implemented yet (task 4.6)". | Completar el path de webhook entrante en `chat-bot`; ejercitarlo en e2e. |
| 2 | **Ingesta de respuesta de supervisor** | Gap: supervisor-reply ingest + webhook inbound no fully exercised en e2e. | Permitir que la respuesta del supervisor vuelva al pipeline / sesión. |
| 3 | **Hardening de Dockerfiles (node:20-slim vs node>=22)** | Discrepancia: `engines.node >=22` pero Dockerfiles fijan `node:20-slim`. | Reconciliar antes de producción (alinear imagen base al runtime requerido). |
| 4 | **Más integraciones de geo** | `GEOIP_PROVIDER=none` → default conservador; ipstack/MaxMind opcionales. | Ampliar resolución de jurisdicción más allá de ISO país básico. |
| 5 | **i18n** | No documentado como implementado. | Internacionalización de UI del dashboard y copy del bot por jurisdicción. |
| 6 | **App móvil** | Fuera del alcance actual (solo WhatsApp + dashboard web). | Canal nativo para pacientes/supervisores. |
| 7 | **Expansión de marcos legales** | Marcos actuales: CO-1581, MX-LFPDPPP, US-HIPAA, EU-GDPR, AR-25326, CL-19628, DEFAULT. | Añadir jurisdicciones adicionales según despliegue. |
| 8 | **Observabilidad / tracing avanzado** | `telemetry` (Pino + redactor PII + RedisEventEmitter) presente; tracing distribuido no detallado. | Tracing end-to-end, métricas de gate, dashboards de SLO. |

## Visión a largo plazo

Consolidar el asistente como una **capa segura de acceso y triage psicológico** multi-jurisdicción, con:
- Escalado a humano robusto e independiente del canal (no solo WhatsApp).
- Cobertura legal ampliable por país con consentimiento siempre versionado y auditable.
- Fundamentación RAG verificable como estándar (gate de coherencia ≥ 0.85) con cero emisiones de diagnóstico/receta.
- Movilidad (app nativa) e i18n para ampliar alcance sin sacrificar privacidad ni cumplimiento.
- Observabilidad de grado producción para auditoría continua de datos sensibles.

## Restricciones de madurez (no bloqueantes)

- Sin marcadores `TODO`/`FIXME`/`placeholder` en producción.
- Dockerfiles deben reconciliarse con `node>=22` antes del paso a producción.
- Dependencias críticas: OpenAI (único LLM/embeddings), Redis (pub-sub/OTP/colas), Postgres 16 + pgvector.
