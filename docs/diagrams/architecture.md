# Arquitectura del Sistema — Chat Asistente Psicológico

Diagrama de componentes por capa: Edge (entrada/proxy), Servicios (aplicaciones) y Datos (almacenamiento).

```mermaid
flowchart TD
    subgraph Edge["Capa Edge"]
        U["Usuario WhatsApp"]
        C["Caddy (edge TLS / rate limit)"]
    end

    subgraph Servicios["Capa de Servicios"]
        BOT["chat-bot (4001)"]
        RAG["ai-rag (4003)"]
        ING["ingestion (4004)"]
        NOT["notifications (4002, internal)"]
        DASH["dashboard (3000)"]
    end

    subgraph Datos["Capa de Datos"]
        PG["Postgres + pgvector"]
        RD["Redis"]
    end

    U --> C
    C --> BOT
    BOT --> RAG
    BOT --> ING
    BOT --> NOT
    DASH -. "supervisión de" .-> BOT
    DASH -. "supervisión de" .-> RAG
    DASH -. "supervisión de" .-> NOT
    BOT --> PG
    BOT --> RD
    RAG --> PG
    RAG --> RD
    ING --> PG
    ING --> RD
    NOT --> PG
    NOT --> RD
    DASH --> PG
    DASH --> RD
```

notifications es internal-only: no tiene ruta pública en Caddy. dashboard supervisa chat-bot, ai-rag y notifications vía Socket.io / API interna.
