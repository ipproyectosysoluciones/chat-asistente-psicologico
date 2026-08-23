# PRD — Chat Asistente Psicológico

> Documento de requisitos de producto. Toda afirmación técnica se basa en el factsheet del repositorio (`/tmp/opencode/chatcap-factsheet.md`). No se inventa funcionalidad fuera de lo allí descrito.

---

## 1. Visión del producto

Un asistente psicológico conversacional accesible por **WhatsApp** que ofrece apoyo emocional de primera línea, **siempre con supervisión humana** y un **cumplimiento legal estricto** sobre datos de salud sensibles. El sistema combina un pipeline de RAG (retrieval-augmented generation) anclado a fuentes clínicas verificadas con una arquitectura de "gate de coherencia" que impide que el modelo diagnostique, recete o emita contenido no fundamentado. Ante una crisis vital, el asistente escala inmediatamente a un humano y a líneas de emergencia locales.

El producto no pretende reemplazar al profesional de salud mental: es una capa de acceso, contención y triage que opera dentro de un marco legal por jurisdicción.

## 2. Problema que resuelve

- **Barrera de acceso**: muchas personas no tienen acceso inmediato a apoyo psicológico por costo, estigma o geografía. WhatsApp ya está instalado y es familiar.
- **Riesgo de desinformación**: un LLM sin anclaje puede "alucinar" consejo clínico peligroso. El gate de coherencia y el blacklist clínico lo previenen.
- **Datos sensibles sin gobernanza**: la salud mental es dato especialmente protegido. Se exige encriptación en reposo, rotación de claves, consentimiento versionado y auditoría.
- **Crisis no detectadas**: un flujo de crisis con escalado a humano y líneas de emergencia salva vidas cuando el riesgo es rojo.
- **Multi-jurisdicción legal**: distintos países (CO, MX, US, EU, AR, CL) tienen marcos distintos; el onboarding propone el marco por geolocalización y exige confirmación explícita.

## 3. Usuarios / Patientas

| Rol | Descripción | Persistencia |
|-----|-------------|--------------|
| **Paciente anónimo** | Usuario de WhatsApp sin historia clínica. Sesión efímera con contrato de limpieza 24–48 h. | Sesión (no en tabla `users`); datos anónimos purgables. |
| **Paciente con Historia Clínica (HC)** | Usuario con HC ingresada vía pipeline de ingesta; requiere consentimiento cifrado + marco legal. | `sessions` (dual persistence), `consent_records`, `documents`/`vector_chunks`. |
| **Supervisor** | Profesional que monitorea alertas, toma el control (takeover) de conversaciones y emite respuestas. | `users.role = supervisor`; RBAC estricto. |
| **Admin** | Gestión de rotación de claves, auditoría y configuración. | `users.role = admin`; RBAC estricto. |
| **Operador de salud** | Personal que carga documentos clínicos en el pipeline de ingesta. | Acceso vía ingestion service / flujo de ingesta. |

> Nota: los roles de chat `anonymous`/`patient` son **session-scoped** y NO existen en la tabla `users`; solo `supervisor` y `admin` son usuarios persistentes (`users.role CHECK`).

## 4. Objetivos y métricas de éxito

| Objetivo | Métrica | Meta (referencial) |
|----------|---------|--------------------|
| Tiempo a primera respuesta | Latencia `chat-bot` → `ai-rag` → emisión | Primera respuesta fundamentada en segundos (RAG + gate). |
| Tasa de escalado a crisis humano | `% sesiones que levantan red_alert y son tomadas por humano` | 100% de crisis rojas escaladas (no dependen solo de WhatsApp). |
| Cobertura de marco legal | `% sesiones con `legal_framework` confirmado` | 100% con confirmación explícita; `DEFAULT` solo si irresoluble. |
| Ausencia de diagnóstico/receta | `% emisiones bloqueadas por role-deviation` | 0 emisiones de diagnóstico/receta/farmacológico (bloqueo en output layer). |
| Calidad de fundamentación | `% respuestas con cosine ≥ 0.85` | Piso de emisión ≥ 0.85; `yellow_flag` en `[0.75, 0.85)`. |
| Privacidad | `% logs sin PII / sin IP cruda` | 100% (redactor PII en Pino; IP nunca almacenada). |
| Disponibilidad de deps | `readyz` (ai-rag exige índice vectorial) | Servicios saludables tras migraciones. |

## 5. Alcance (In)

- **RAG con gate de coherencia obligatorio** (`ai-rag`): classify de riesgo → retrieve pgvector → generación GPT-4o → gate de coherencia (cosine ≥ 0.85, NLI sin contradicción, sin role-deviation). Kill-switch `AI_EMISSION_ENABLED`.
- **Flujo de crisis con escalado** (`chat-bot` + `notifications`): matcher de keywords de crisis (insensible a acentos, conservador) → texto de crisis fundamentado + línea de emergencia local por país + `raise_red_alert`; en fallo de publicación Redis, la sesión es forzada a takeover humano.
- **Consentimiento + marco legal por geolocalización** (`chat-bot` + `db-schema`): `geo/factory` resuelve solo país ISO; el flujo de jurisdicción propone el marco y **requiere confirmación explícita** antes de persistir; IP cruda nunca se guarda. Marcos: `CO-1581`, `MX-LFPDPPP`, `US-HIPAA`, `EU-GDPR`, `AR-25326`, `CL-19628`, `DEFAULT`.
- **Dashboard de supervisión** (`dashboard`): alertas (open→acknowledged→resolved), takeover de sesión, emisión/renewal de QR, monitoreo de rotación de claves, auditoría. SPA React 19/Vite + API Express 5/Socket.io.
- **Ingesta de documentos clínicos** (`ingestion`): blacklist filter (droga/dosis), chunking, embeddings OpenAI, upsert pgvector.
- **Notificaciones / alertas** (`notifications`, internal-only): alert routing, dedupe/throttle por nivel, push Socket.io, fallback `FALLBACK_PUSH_URL`.
- **Encriptación + rotación** (`crypto-keys`): AES-256-CBC encrypt-then-MAC (HMAC-SHA256), HKDF por versión, dual-read por `key_version`; rotación 7 días + margen forzado 12 h, re-encriptación en ventana de bajo tráfico, por lotes (100–500 filas) con hash de integridad y rollback (`re_encryption_batches`).
- **RBAC** (`dashboard` + `config`): middleware `authenticate` (JWT HS256 15-min, alg-pinned, constant-time) → `authorize` (allow-list, denegaciones audit-logged) → `audit` (who/when/why en 2xx).
- **Rate limiting**: edge IP en Caddy (100 req/10s, exentos `/healthz`+`/readyz`) + `express-rate-limit` + `rate-limiter-flexible` en dashboard.
- **Auditoría**: `audit_logs` (meta sin PII) para denegaciones, QR, acceso/rotación de claves, takeover y re-encriptación.

## 6. Alcance (Out / No-Go)

- **NO diagnóstico** ni **NO receta** ni **consejo farmacológico**: bloqueado en la capa de salida; el output del LLM nunca se emite si hay bloqueo (solo fallback seguro). El gate detecta `diagnóstico`, `receto`, `padeces`, términos de fármaco/dosis.
- **Sin almacenamiento de IP cruda**: la IP nunca se guarda ni se loguea; `geo/factory` resuelve solo país ISO.
- **Sin PII en logs**: redactor PII en Pino; los logs de auditoría son meta no-PII.
- **Sin alucinación clínica**: retrieval vacío o kill-switch → respuesta bloqueada (no se genera).
- **Sin modelos no anclados**: solo OpenAI (`gpt-4o` chat, `gpt-4o-mini` NLI/classify, `text-embedding-3-small`); base fija `https://api.openai.com/v1`, swap de modelo solo por config.

## 7. Requisitos funcionales (por servicio)

### 7.1 chat-bot (puerto 4001)
- Servicio WhatsApp sobre BuilderBot (3 pilares: Flow / Provider / Database swappable).
- Onboarding de jurisdicción: propone marco legal por país y exige confirmación explícita antes de persistir.
- Emisión de RAG fundamentada: solo emite tras pasar el gate de coherencia (integración con `ai-rag`).
- Flujo de crisis: matcher conservador → texto fundamentado + línea de emergencia local + `raise_red_alert`.
- Consentimiento: checkbox → AES-256 → Base64 → QR (media); renovación requiere OTP de 6 dígitos verificado dentro de 10 min.
- Geolocalización + confirmación obligatoria; IP cruda nunca almacenada.
- Purga de datos anónimos (ventana 24–48 h).
- Provider swappable: Baileys (local) o Meta Cloud API (`CHATBOT_PROVIDER`); reconexión graceful de Baileys.

### 7.2 ai-rag (puerto 4003)
- Pipeline RAG: `risk classify` → `pgvector retrieve` → `GPT-4o generate` → `coherence gate` (obligatorio).
- Gate de coherencia: cosine < 0.75 → naranja (bloqueado); contradicción NLI → bloqueado; role-deviation → bloqueado. Piso de emisión cosine ≥ 0.85; 1 reintento en `[0.75, 0.85)` → `yellow_flag`.
- Riesgo rojo: cortocircuita a crisis (sin generación).
- Retrieval vacío o kill-switch → bloqueado.
- Endpoints: `/api/v1/rag/process`, `/internal/*`.

### 7.3 ingestion (puerto 4004)
- Ingesta de documentos clínicos: blacklist filter (nombres de fármacos + dosis/posología), chunking, embeddings OpenAI, upsert pgvector.
- Endpoint: `/api/v1/documents*`.

### 7.4 notifications (puerto 4002, internal-only)
- Enrutado de alertas, dedupe por `dedupe_key` (UNIQUE, una abierta por clave), throttle por nivel (rojo 60s / naranja 300s / amarillo 900s).
- Push Socket.io + fallback `FALLBACK_PUSH_URL`.
- Sin ruta pública en Caddy.

### 7.5 dashboard (puerto 3000)
- SPA supervisor + API: React 19/Vite + Express 5/Socket.io.
- JWT RBAC, auditoría, takeover de sesión, firma/validación de QR, monitoreo de rotación de claves.
- Estados de alerta: open → acknowledged → resolved.
- Rate limiting (`express-rate-limit` + `rate-limiter-flexible`).

## 8. Requisitos no funcionales

- **Seguridad**: AES-256-CBC encrypt-then-MAC (HMAC-SHA256), HKDF por versión, dual-read por `key_version`; OTP 6 dígitos/10 min; RBAC JWT HS256 15-min alg-pinned constant-time; rate limiting en edge y dashboard.
- **Privacidad**: IP cruda nunca almacenada/logueada; redactor PII en Pino; consentimiento cifrado (`consent_records`: BYTEA + `key_version` + `integrity_hash`); persistencia dual anónimo/HC con purga 24–48 h.
- **Cumplimiento multi-jurisdicción**: `CO-1581`, `MX-LFPDPPP`, `US-HIPAA`, `EU-GDPR`, `AR-25326`, `CL-19628`, `DEFAULT`; consentimiento con `terms_version`, jurisdicción, `key_version`, `integrity_hash`; confirmación explícita obligatoria.
- **Disponibilidad**: `/healthz` (liveness) y `/readyz` (deps; ai-rag exige índice vectorial); re-encriptación en ventana de bajo tráfico con rollback; reconexión graceful Baileys.
- **Observabilidad**: Pino + redactor PII + `RedisEventEmitter` (pub-sub); `telemetry`; `audit_logs` (meta no-PII).
- **Rendimiento**: gate de cosine en capa de validación; `pgvector` HNSW (`vector(1536)`, `ef_construction=64`); `assertVectorIndexPresent` al arranque.

## 9. Restricciones y riesgos

- **Datos sensibles de salud mental**: máximo nivel de protección; cualquier fuga es crítica.
- **Crisis vital**: el escalado a humano no puede depender solo de WhatsApp; el failure-mode de Redis fuerza takeover.
- **Marcos legales**: diferencias por país; si la geo es irresoluble → `DEFAULT` (comportamiento conservador).
- **Discrepancia de runtime (riesgo pre-producción)**: `engines.node >=22` en repo pero Dockerfiles fijan `node:20-slim`. Debe reconciliarse antes de producción.
- ** Dependencia única de OpenAI**: base hardcoded `https://api.openai.com/v1`; sin alternativa de proveedor de LLM (solo swap de modelo por config).
- **No-diagnose / no-prescribe**: hard requirement en output layer; el modelo nunca emite en bloqueo.

## 10. Definición de éxito

El producto es exitoso cuando:
1. **100% de sesiones** con marco legal confirmado (o `DEFAULT` por irresolubilidad, logueado sin PII).
2. **0 emisiones** de diagnóstico/receta/consejo farmacológico (bloqueo demostrado por tests del gate).
3. **100% de crisis rojas** escaladas a humano con línea de emergencia local entregada.
4. **Piso de emisión cosine ≥ 0.85** sostenido; `yellow_flag` trazado en el rango inferior.
5. **Sin PII ni IP cruda** en logs o almacenamiento; consentimiento siempre cifrado y versionado.
6. **Rotación de claves** funcional (7 días + margen 12 h) con re-encriptación por lotes y rollback verificable.
7. **Suite e2e** (rotación, alerta, purga, consentimiento, flujo, takeover) en verde en `main`.
