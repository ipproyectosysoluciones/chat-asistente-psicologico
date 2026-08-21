# BACKUP_RESTORE — Chat Asistente Psicológico

Runbook de copias de seguridad, restauración y rollback para el despliegue.
Trabajá SIEMPRE contra la variable de entorno `DATABASE_URL` (Postgres 16 +
pgvector). Redis es efímero por diseño (pub-sub / TTL / colas) y **no** se
respaldará como fuente de verdad; solo Postgres contiene datos persistentes
(historias clínicas, consentimientos cifrados, versiones de clave, trazas RAG).

> Seguridad: los payloads de consentimiento y datos clínicos están cifrados en
> reposo (AES-256, `key_version`). El backup contiene el ciphertext — protegé
> el archivo con los mismos controles que la base (acceso restringido,
> auditoría). El material maestro (`CRYPTO_MASTER_SECRET`) NUNCA debe incluirse
> en el dump.

---

## Backups

Usá `pg_dump` en formato custom (comprimido + restaurable selectivamente).

```bash
# Respaldá la base completa (custom format) contra DATABASE_URL
pg_dump --format=custom --file "backup-$(date +%F-%H%M).dump" "$DATABASE_URL"

# Verificá que el archivo no esté vacío y listá su contenido
pg_restore --list "backup-$(date +%F-%H%M).dump" | head
```

**Cron nightly (ejemplo)**

```cron
# /etc/cron.d/chatcap-backup — 02:15 todos los días, retención 14 días
15 2 * * *  postgres  pg_dump --format=custom \
  --file /var/backups/chatcap/backup-$(date +\%F).dump "$DATABASE_URL" \
  && find /var/backups/chatcap -name 'backup-*.dump' -mtime +14 -delete
```

Notas operativas:

- El dump preserva la extensión `vector` (pgvector) y los datos cifrados.
- No incluyas `REDIS_URL` en el respaldo; Redis se reconstruye al arrancar.
- Guardá el backup en almacenamiento con versionado + acceso auditado.

---

## Restore

```bash
# Restaurá contra la misma (o una nueva) DATABASE_URL.
# --clean --if-exists evita choques de objetos existentes.
pg_restore --clean --if-exists --format=custom \
  -d "$DATABASE_URL" backup-AAAA-MM-DD-HHMM.dump

# Verificá el restore: conteo de tablas clave y extensión
psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname='vector';"
psql "$DATABASE_URL" -c "\dt"
```

Precauciones:

- El restore recrea tablas; si la base destino tiene datos en uso, aislala
  primero (modo mantenimiento / Caddy fuera de servicio).
- Tras restaurar, las claves por versión se re-derivan desde
  `CRYPTO_MASTER_SECRET` + `key_versions`; el secreto debe coincidir con el
  usado al generar los datos, o el ciphertext no se descifrará.

---

## Rollback runbook

### 1) Rollback de imagen de servicio (deploy pinneado)

Cada servicio debe desplegarse con un tag de imagen fijo (no `latest`). Para
retroceder a una imagen conocida:

```bash
# En el docker-compose del servicio afectado, fijá el tag anterior, p.ej.:
#   image: ghcr.io/.../ai-rag:1.4.2
docker compose up -d --force-recreate ai-rag
```

`--force-recreate` reinicia el contenedor con la imagen pinneada sin tocar el
resto. Verificá luego con `/readyz` en cada servicio recreado.

### 2) Kill switch de emisión IA

Si un problema de seguridad o calidad en la salida del LLM lo requiere, desactivá
la emisión globalmente sin redeploy:

```bash
# En .env de los servicios afectados (ai-rag, chat-bot):
AI_EMISSION_ENABLED=false
# Luego recreá los servicios para que relean el env:
docker compose up -d --force-recreate ai-rag chat-bot
```

Con `false`, el bot degrada a modo solo-humano (sin emisión de salida LLM).
Esto es la válvula de emergencia ante emisión no deseada (REQ-CHATBOT-2).

### 3) Rollback de rotación de claves

La rotación de claves de cifrado es gestionada por el **Dashboard → Key
Rotation monitor** (ver `apps/dashboard/src/server/keys-router.ts`). Las claves
por versión se derivan de `CRYPTO_MASTER_SECRET` vía HKDF y se registran en la
tabla `key_versions` con su `key_version`.

- **No hay rollback de `CRYPTO_MASTER_SECRET` en caliente**: cambiarlo invalida
  todo el ciphertext existente. Si una rotación forzada salió mal, revertí la
  imagen del servicio a la versión anterior (paso 1) y usá el monitor de
  rotación del dashboard para re-derivar desde la versión buena.
- La rotación forzada (12 h) y el rollback on-failure están cubiertos por los
  tests de `packages/crypto-keys`; consultá el monitor del dashboard para
  forzar o revertir una rotación de forma auditada (cada acceso queda en el
  audit log).

### 4) Rollback de migración de esquema

Si una migración aplicada rompe el arranque:

```bash
pnpm --filter @chatcap/db-schema exec node-pg-migrate down
```

> Nota: el wrapper de root `pnpm migrate:down` delega a un script inexistente
> en `@chatcap/db-schema`; usá el binario directo como arriba. Evaluá siempre
> el impacto de un `down` sobre datos ya volcados antes de ejecutarlo.

---

## Quick reference

| Acción | Comando |
| --- | --- |
| Backup | `pg_dump --format=custom --file b.dump "$DATABASE_URL"` |
| Verificar dump | `pg_restore --list b.dump` |
| Restaurar | `pg_restore --clean --if-exists --format=custom -d "$DATABASE_URL" b.dump` |
| Recrear servicio (rollback imagen) | `docker compose up -d --force-recreate <svc>` |
| Kill switch IA | `AI_EMISSION_ENABLED=false` + recreate |
| Rollback migración | `pnpm --filter @chatcap/db-schema exec node-pg-migrate down` |
