# Chat Asistente Psicológico — Manuales

Colección de manuales operativos del sistema Chat Asistente Psicológico, un asistente
de salud mental por chat (WhatsApp) con RAG, supervisión humana y cumplimiento de
marcos legales por jurisdicción. El sistema maneja **datos de salud sensibles**, por
lo que los manuales enfatizan seguridad, auditoría y trazabilidad.

| Manual | Dirigido a | Qué cubre |
| --- | --- | --- |
| [Manual del supervisor](./manual-supervisor.md) | Supervisores y administradores que usan el dashboard | Acceso y RBAC, bandeja de alertas, takeover de sesiones, emisión y renovación de QR de consentimiento, rotación de claves, auditoría, marco legal y flujo de crisis. |
| [Manual de despliegue](./manual-despliegue.md) | Operaciones / infraestructura | Prerrequisitos, despliegue con Docker Compose, Caddy como edge TLS/reverse proxy, variables de entorno, migraciones, backups, rotación operativa de claves, health checks y la discrepancia de versiones de Node. |
| [Manual de desarrollo](./manual-desarrollo.md) | Desarrolladores | Entorno local, ejecución de servicios y tests, modelo de ramas dev-first, estructura del monorepo y convenciones de commit. |

## Lectura recomendada por rol

- **Supervisor clínico / admin:** empieza en `manual-supervisor.md`. No necesitas
  tocar la infraestructura ni el código.
- **Ops / infra:** usa `manual-despliegue.md` para levantar y operar el sistema.
- **Desarrollador:** usa `manual-desarrollo.md` para el entorno local y el flujo de
  trabajo de ramas/tests.

## Documentos relacionados en el repo

- `.env.example` — esquema de variables de entorno (placeholders).
- `docker-compose.yml` — definición de servicios.
- `Caddyfile` — edge TLS / reverse proxy.
- `BACKUP_RESTORE.md` — respaldos y restauración (referenciado por el manual de despliegue).
- `AGENTS.md` — reglas de code review y cumplimiento (referencia para developers).
