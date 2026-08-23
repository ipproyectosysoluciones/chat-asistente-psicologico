# Manual del supervisor

Este manual describe cómo operar el **dashboard de supervisión** de Chat Asistente
Psicológico. Está dirigido a **supervisores** y **administradores** (roles RBAC
`supervisor` y `admin`) que monitorizan conversaciones, gestionan alertas, toman
control de sesiones y administran consentimiento y claves criptográficas.

> El sistema maneja datos de salud sensibles. Toda acción relevante queda registrada
> en `audit_logs` (metadatos sin PII). No compartas capturas de conversaciones fuera
> de los canales autorizados.

---

## 1. Acceso y roles (RBAC)

El dashboard no tiene registro público de usuarios. Las cuentas se provisionan con
rol `supervisor` o `admin` (restricción `CHECK` en la tabla `users`).

1. Inicia sesión con tu correo y contraseña. El backend emite un **JWT HS256** de
   **15 minutos** (`DASHBOARD_JWT_TTL_MINUTES`, pin de algoritmo, verificación en
   tiempo constante).
2. El middleware aplica tres capas en orden:
   - **authenticate** — valida el JWT.
   - **authorize** — lista blanca de roles; las denegaciones se auditan.
   - **audit** — registra quién/cuándo/por-qué en respuestas `2xx`.

Si tu rol no tiene permiso para una ruta, la denegación aparece en la bitácora de
auditoría aunque no veas la pantalla.

---

## 2. Bandeja de alertas

Las alertas se generan por el motor de crisis/escalado y se enrutan vía
`notifications` (Socket.io) al dashboard.

### Niveles

| Nivel | Significado | Throttle (re-push) |
| --- | --- | --- |
| `red` | Riesgo vital / crisis inmediata | 60 s |
| `orange` | Desviación de rol o contenido no grounding | 300 s |
| `yellow` | Bandera de baja confianza (p.ej. reintento de gate) | 900 s |

El throttle evita duplicados: una alerta repetida dentro de la ventana por nivel no
se vuelve a empujar (se usa `FALLBACK_PUSH_URL` como canal secundario si el push
Socket.io no se confirma).

### Estado

Cada alerta transita por:

```
open ──▶ acknowledged ──▶ resolved
```

- `open`: recién generada, sin atención.
- `acknowledged`: un supervisor la tomó (la marca como "en curso").
- `resolved`: cerrada tras acción o triaje.

Existe **una sola alerta abierta por clave de dedupe** (`UNIQUE` en `alerts`):
alertas repetidas de la misma clave actualizan la existente en lugar de duplicarse.

---

## 3. Takeover (toma de control de sesión)

El **takeover** transfiere una sesión de paciente del bot a un humano.

- **Cuándo:** ante una alerta `red` (riesgo vital), desviación de rol, o cuando el
  supervisor determina que la conversación requiere intervención humana inmediata.
  En caso de fallo de publicación de la alerta roja sobre Redis, la sesión es
  **forzada a takeover humano** automáticamente.
- **Cómo:** desde la bandeja, selecciona la sesión y ejecuta la acción de takeover.
  El dashboard envía la respuesta del supervisor vía
  `POST /api/v1/messages/ingest` al `chat-bot` usando un token interno
  (`DASHBOARD_CHATBOT_INTERNAL_TOKEN`, debe estar en `X_INTERNAL_TOKENS`).
- **Auditoría:** toda toma de control queda registrada en `audit_logs`
  (quién, cuándo, qué sesión).

---

## 4. Consentimiento (QR + renovación con OTP)

Antes de persistir datos, el flujo de jurisdicción propone un marco legal según el
país (geolocalización) y **requiere confirmación explícita del paciente** antes de
guardar nada.

- El consentimiento se almacena **cifrado AES** con `terms_version`,
  `jurisdiction`, `key_version` e `integrity_hash` (en `consent_records`, tipo
  `BYTEA`).
- Se entrega al paciente como **QR (media)** firmado (`qr_signatures`).
- **Renovación:** al expirar o pedirse, se genera un **OTP de 6 dígitos válido por
  10 minutos**. La renovación del QR solo se completa tras validar el OTP. La emisión
  y validación de QR también se auditan.

---

## 5. Rotación de claves

El sistema usa **AES-256-CBC encrypt-then-MAC** (HMAC-SHA256) con claves
por-versión derivadas por **HKDF-SHA256** + sal por fila; lectura dual por
`key_version`.

- **Cuándo:** ciclo de **7 días** con un **margen forzado de 12 h**; si se supera,
  existe una ruta forzada de 12 h. El scheduler elige una **ventana de bajo
  tráfico** para re-encriptar.
- **Cómo:** la rotación dispara un **coordinador de re-encriptación** que trabaja por
  **lotes de 100–500 filas**, cada lote con `integrity_hash` y capacidad de
  **rollback** (`re_encryption_batches`).
- **Auditoría:** el acceso a claves y cada rotación/re-encriptación quedan en
  `audit_logs`.

---

## 6. Auditoría y trazabilidad

Tabla `audit_logs` (metadatos **sin PII**). Se registra:

- Denegaciones de autorización (RBAC).
- Emisión y validación de QR de consentimiento.
- Acceso a claves y rotación.
- Takeover de sesiones.
- Re-encriptación por lotes.

Esto permite trazabilidad completa: para cualquier acción sensible se sabe
**quién** la ejecutó, **cuándo** y **por qué**, sin exponer datos clínicos en la
bitácora.

---

## 7. Marco legal (geolocalización + confirmación)

- El servicio de geo resuelve **solo el código ISO de país**; la IP cruda nunca se
  almacena ni se registra.
- El flujo propone un marco legal entre: `CO-1581`, `MX-LFPDPPP`, `US-HIPAA`,
  `EU-GDPR`, `AR-25326`, `CL-19628`, o `DEFAULT`.
- La **confirmación del paciente es obligatoria** antes de persistir. Si no se
  resuelve la jurisdicción, se aplica `DEFAULT` (discrepancia de VPN se registra sin
  PII).

---

## 8. Flujo de crisis (alerta roja)

Cuando el matcher de palabras clave de crisis (insensible a acentos, conservador)
detecta riesgo vital:

1. Se envía **texto de crisis con grounding** inmediato + **línea de emergencia
   local** según el país.
2. Se eleva `raise_red_alert` sobre **Redis**.
3. El supervisor ve en el dashboard una alerta `red` en estado `open`, con la sesión
   marcada para takeover.
4. Si la publicación de la alerta roja falla, la sesión es **forzada a takeover
   humano** como salvaguarda.

El supervisor debe `acknowledged` → triaje → `resolved`, y puede tomar la sesión en
cualquier momento. Recuerda: el sistema **nunca diagnostica ni receta**; si el gate
de coherencia bloquea (coseno < 0.75, contradicción NLI o desviación de rol), solo se
emite respuesta segura o se bloquea (`AI_EMISSION_ENABLED` es el kill switch global).
