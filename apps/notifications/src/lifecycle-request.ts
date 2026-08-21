import { z } from "zod";

/**
 * Lifecycle action request body (task 2.4): who acts and why. `actorId` is
 * the authenticated supervisor/admin uuid; `reason` is free-text context for
 * the audit trail (who/when/why, REQ-DASH-8) and stays PII-scrubbed — it is
 * stored in the audit `reason` column, never logged raw.
 */

export const lifecycleActionRequestSchema = z.object({
  actorId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export type LifecycleActionRequest = z.infer<typeof lifecycleActionRequestSchema>;
