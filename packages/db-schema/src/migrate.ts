import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";

/**
 * Programmatic migration runner (node-pg-migrate). Services invoke this on
 * boot so the schema is always in sync; the `.sql` migrations live in
 * `migrations/` (Up/Down markers).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export interface RunMigrationsOptions {
  databaseUrl: string;
  direction?: "up" | "down";
  count?: number;
}

export async function runMigrations(
  options: RunMigrationsOptions
): Promise<void> {
  await runner({
    databaseUrl: options.databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: "pgmigrations",
    direction: options.direction ?? "up",
    count: options.count ?? Infinity,
    log: () => {
      // Migrations run at boot; keep service logs clean (telemetry owns logging).
    },
  });
}
