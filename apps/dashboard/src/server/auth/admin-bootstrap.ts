import type { AppConfig } from "@chatcap/config";
import type { DbQueryable } from "@chatcap/db-schema";
import { upsertAdminUser } from "@chatcap/db-schema";

/**
 * Bootstraps the initial admin user (task 5.1, design §3.3). The admin is
 * seeded from ADMIN_EMAIL + ADMIN_PASSWORD_HASH at startup via an idempotent
 * upsert that preserves an existing password — re-running never rotates a
 * live credential. Password rotation itself is out of the 5.1 slice.
 */

export async function bootstrapAdmin(config: AppConfig, db: DbQueryable): Promise<void> {
  await upsertAdminUser(db, config.adminEmail, config.adminPasswordHash);
}
