import { describe, it, expect, beforeAll } from "vitest";
import { fetchJson, isStackUp, SERVICE_URLS } from "./helpers";

/**
 * Phase 7.3 — KEY ROTATION e2e.
 *
 * Exercises the admin-only on-demand rotation:
 *   POST /api/v1/keys/rotation/rotate   (body: { forced?, dryRun? })
 *
 * Auth: admin only (RBAC, apps/dashboard/src/server/keys-router.ts). The e2e
 * runner authenticates with ADMIN_JWT from the environment; a real admin login
 * helper (auth-router) could replace this, but the env token is the supported
 * path here. A successful rotation advances the active key version: `keyFrom`
 * is the previous active version and `keyTo` is the newly created one
 * (apps/dashboard/src/server/index.ts).
 */

const ADMIN_JWT = process.env.ADMIN_JWT ?? "";

let stackUp = false;
beforeAll(async () => {
  stackUp = await isStackUp();
}, 120_000);

interface RotateResult {
  dryRun: boolean;
  keyFrom: number;
  keyTo: number;
  wouldRetire?: number;
  processed?: number;
  remaining?: number;
  retired?: boolean;
}
interface RotateResponse {
  result: RotateResult;
}

describe("Phase 7.3 — KEY ROTATION: admin-triggered rotation", () => {
  it(
    "rotates keys on demand → 200 + new active key_version",
    async () => {
      if (!stackUp) {
        console.warn("[e2e:rotation] rotation step skipped — stack not reachable.");
        return;
      }
      if (ADMIN_JWT.length === 0) {
        console.warn("[e2e:rotation] rotation step skipped — ADMIN_JWT not provided.");
        return;
      }

      const res = await fetchJson<RotateResponse>(
        `${SERVICE_URLS.dashboard}/api/v1/keys/rotation/rotate`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_JWT}`,
            "Content-Type": "application/json",
          },
          body: { forced: true },
          expectStatus: 200,
        }
      );

      expect(res.result).toBeDefined();
      expect(typeof res.result.keyFrom).toBe("number");
      expect(typeof res.result.keyTo).toBe("number");
      // Rotation must advance the active key version.
      expect(res.result.keyTo).toBeGreaterThan(res.result.keyFrom);
      // We requested a real (non-dry-run) rotation.
      expect(res.result.dryRun).toBe(false);

      // Optional cross-service guarantee: data encrypted under keyFrom must
      // still decrypt after rotation. That read-back needs a re-encryption
      // decrypt probe (crypto-keys) and is covered by the lifecycle unit
      // suites; left as a follow-up e2e assertion.
    },
    60_000
  );
});
