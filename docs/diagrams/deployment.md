# Despliegue — Topología docker-compose

Contenedores, puertos expuestos y enrutamiento en el edge. notifications es internal-only.

```mermaid
flowchart TD
    EXT["Trafico externo"] --> CADDY["caddy:2 (edge TLS / rate limit)\nExpuesto: 80/443"]

    CADDY -->|"/webhook*"| BOT["chat-bot\npuerto 4001"]
    CADDY -->|"/api/v1/rag/process, /internal/*"| RAG["ai-rag\npuerto 4003"]
    CADDY -->|"/api/v1/documents*"| ING["ingestion\npuerto 4004"]
    CADDY -->|"else (SPA + API)"| DASH["dashboard\npuerto 3000"]

    CADDY -. "Sin ruta publica" .-> NOT["notifications\npuerto 4002 (internal-only)"]

    BOT --> PG["postgres (pg16 + pgvector)\npuerto 5432"]
    BOT --> RD["redis:7\npuerto 6379"]
    RAG --> PG
    RAG --> RD
    ING --> PG
    ING --> RD
    NOT --> PG
    NOT --> RD
    DASH --> PG
    DASH --> RD

    PG --> VOL1["(volumen) data postgres"]
    RD --> VOL2["(volumen) data redis"]
```

## Notas de despliegue

- `Caddyfile` enruta por prefijo: `/webhook*` a chat-bot, `/api/v1/rag/process` y `/internal/*` a ai-rag, `/api/v1/documents*` a ingestion, el resto a dashboard.
- `notifications` no tiene ruta pública en Caddy (internal-only); recibe alertas vía Redis pub-sub y Socket.io interno.
- Rate limit edge por IP (100 req / 10s); `/healthz` y `/readyz` exentos.
- Imágenes construidas desde `apps/<app>/Dockerfile` (multi-stage, pnpm deploy --prod, non-root, tsx).
