# Flujos de Datos — Chat Asistente Psicológico

Tres diagramas: consulta RAG con rama de crisis, flujo de consentimiento y escalado de crisis.

## (a) Consulta RAG y rama de crisis

Secuencia de una consulta del usuario: clasificación de riesgo, recuperación de pgvector, generación y coherence gate antes de emitir.

```mermaid
sequenceDiagram
    participant U as Usuario WhatsApp
    participant BOT as chat-bot
    participant RAG as ai-rag
    participant PG as Postgres + pgvector
    participant H as Humano (supervisor)

    U->>BOT: Mensaje entrante
    BOT->>RAG: Solicita process (RAG)
    RAG->>RAG: classify riesgo (risk classify)
    alt Riesgo rojo (crisis)
        RAG->>BOT: Short-circuit a crisis
        BOT->>BOT: Flujo de crisis (texto + linea local)
        BOT->>H: raise_red_alert (takeover humano)
    else Riesgo amarillo / naranja / verde
        RAG->>PG: retrieve pgvector (chunks)
        PG-->>RAG: Chunks relevantes
        RAG->>RAG: generate (gpt-4o, temp 0)
        RAG->>RAG: coherence gate (cosine / NLI / guardrail)
        alt Gate rechaza (no grounded / role-deviation)
            RAG->>BOT: Bloqueado -> fallback seguro
        else Gate aprueba
            RAG->>BOT: Respuesta grounded
            BOT->>U: Emitir al usuario
        end
    end
```

## (b) Flujo de consentimiento

Resolución de jurisdicción, propuesta de marco legal, confirmación explícita y persistencia encriptada.

```mermaid
flowchart TD
    START["Inicio de sesion"] --> GEO["geo/factory resuelve pais (ISO)"]
    GEO --> FRAME["Propone marco legal (LEGAL_FRAMEWORKS)"]
    GEO --> DEFAULT["Si no resoluble -> DEFAULT"]
    FRAME --> CONF{"Usuario confirma marco?"}
    DEFAULT --> CONF
    CONF -->|"No"| REPLAY["Reintentar / DEFAULT"]
    CONF -->|"Si"| STORE["Persistir consentimiento"]
    STORE --> ENC["Encriptar AES-256-CBC + key_version + terms_version"]
    ENC --> QR["Generar QR (media firmada)"]
    QR --> RENEW["Renovacion requiere OTP 6-digit / 10 min"]
    RENEW --> VALID["Validar OTP -> emitir QR renovado"]
```

## (c) Escalado de crisis

Detección de keyword, texto de crisis, alerta roja y fallback a toma de control humano.

```mermaid
flowchart TD
    MSG["Mensaje entrante"] --> KW{"Keyword de crisis?"}
    KW -->|"No"| NORMAL["Flujo normal RAG"]
    KW -->|"Si"| CRISIS["Texto de crisis + linea de emergencia local"]
    CRISIS --> RED["raise_red_alert (riesgo rojo)"]
    RED --> PUB["Publicar en Redis (red alert)"]
    PUB --> CHECK{"Publicacion exitosa?"}
    CHECK -->|"Si"| ACK["Alerta open -> acknowledged -> resolved"]
    CHECK -->|"No"| TAKE["Fallback: takeover forzado a humano"]
    TAKE --> HUMAN["Supervisor asume la sesion"]
```
