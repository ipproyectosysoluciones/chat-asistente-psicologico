import { createHash } from "node:crypto";

import type { AlertLevel } from "@chatcap/shared-types";

/**
 * Dedupe key derivation (REQ-ALERT-5): the stable identity of an alert
 * episode. Same level + session + category + keyword MUST hash to the same
 * key so PostgreSQL's one-open-alert semantics collapse repeats; a missing
 * keyword normalizes to the empty string so presence/absence of the optional
 * field cannot split an episode.
 */

export interface DedupeKeyInput {
  level: AlertLevel;
  sessionId: string;
  category: string;
  keyword?: string;
}

export function buildDedupeKey(input: DedupeKeyInput): string {
  const canonical = [
    input.level,
    input.sessionId,
    input.category,
    input.keyword ?? "",
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
