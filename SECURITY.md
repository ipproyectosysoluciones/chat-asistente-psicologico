# Política de Seguridad — Chat Asistente Psicológico

Este proyecto maneja **datos clínicos sensibles** (historias clínicas, alertas de crisis).
La seguridad y privacidad son requisitos de diseño, no opcionales.

## Versiones soportadas

Solo se dan parches de seguridad para la **última versión en `main`/`dev`**. No se
mantienen ramas de versiones anteriores.

| Rama   | Soportada |
| ------ | --------- |
| `main` | ✅ Sí      |
| `dev`  | ✅ Sí      |
| otras  | ❌ No      |

## Cómo reportar una vulnerabilidad

**No abras un issue público** para reportar una vulnerabilidad.

Reporta de forma privada:

- Envía un correo a **security@chatcap.example**, o
- Abre un *security advisory* confidencial en el repositorio (GitHub Security Advisories).

Incluye, si es posible:

- Descripción del problema y su impacto.
- Pasos de reproducción.
- Versiones/rama afectadas.
- Cualquier mitigación conocida.

**Tiempo de respuesta esperado:** ~72 horas para un acuse de recibido. Trabajaremos
contigo en la validación y el plan de corrección. Te mantendremos informado del
progreso mientras el advisory permanezca confidencial.

## Resumen del modelo de seguridad

### Consentimiento + marcos legales
El flujo de onboarding propone el marco legal según el país (geolocalización) y
**requiere confirmación explícita** del usuario antes de persistir. Países/marcos:
CO-1581, MX-LFPDPPP, US-HIPAA, EU-GDPR, AR-25326, CL-19628, y `DEFAULT` si no se
resuelve. El consentimiento se almacena **cifrado AES-256** con `terms_version`,
`jurisdiction`, `key_version` e `integrity_hash`. La renovación vía QR requiere un
OTP de 6 dígitos verificado dentro de 10 minutos.

### Encriptación en reposo + rotación
AES-256-CBC *encrypt-then-MAC* (HMAC-SHA256 cubre `iv||ciphertext`, verificación
en tiempo constante). Claves por versión vía HKDF-SHA256 con *salt* por fila;
lectura dual por `key_version`. Rotación en ciclo de 7 días con margen forzado de
12 h, re-encriptación en ventana de bajo tráfico, **por lotes (100–500 filas)** con
hash de integridad y *rollback*.

### RBAC de supervisión
`users.role` restringido a `supervisor|admin`. El middleware del dashboard aplica:
`authenticate` (JWT HS256, 15 min, algoritmo fijo) → `authorize` (allow-list de rol,
denegaciones auditadas) → `audit` (quién/cuándo/por qué en 2xx). Los roles de chat
(`anonymous`/`patient`) son por sesión, no en `users`.

### Rate limiting
En el edge por IP en Caddy (100 req/10 s, exentos `/healthz` y `/readyz`), y en el
dashboard vía `express-rate-limit` + `rate-limiter-flexible`.

### Escalado de crisis a humano
Matcher de palabras clave de crisis (insensible a acentos) → texto de crisis
fundamentado + línea de emergencia local por país + `raise_red_alert`. La alerta
roja viaja por Redis; si la publicación falla, la sesión es **tomada por un humano**
(*takeover*). Alertas: `open → acknowledged → resolved`, una abierta por *dedupe key*,
con *throttle* por nivel (roja 60 s / naranja 300 s / amarilla 900 s).

### Auditoría
`audit_logs` con metadatos sin PII. Se auditan denegaciones, emisión/validación de QR,
acceso/rotación de claves, *takeover* y re-encriptación.

### RAG grounding gate
La *blacklist* elimina nombres de fármacos y dosis/posología. El *coherence gate*
bloquea si coseno < 0.75 (naranja), contradicción NLI, o desviación de rol
(`diagnóstico`, `receto`, términos de medicación/dosis). Piso de emisión: coseno ≥ 0.85;
un reintento en [0.75, 0.85) → `yellow_flag`. Riesgo rojo corta a crisis (sin
generación); recuperación vacía o *kill-switch* → bloqueado. `AI_EMISSION_ENABLED`
es el *kill switch* global.

### Regla no-diagnóstico / no-prescripción
Aplicada en la **capa de salida**: el output del LLM nunca se emite si hay bloqueo;
solo se entrega un *fallback* seguro. El sistema no diagnostica, no receta ni
recomienda medicación.

## Política de divulgación

Tras confirmar y corregir la vulnerabilidad en privado, coordinaremos la divulgación
(con tu acuerdo) en el *security advisory*. No publicaremos detalles que comprometan
a usuarios hasta que exista un parche disponible. Agradecemos el crédito a quien
reporta, salvo que prefiera el anonimato.

## Nunca incluyas secretos reales

Los reportes, issues y PR **nunca deben contener** secretos, API keys, tokens,
contraseñas ni datos clínicos de producción. Usa siempre datos de prueba.
