import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "node:crypto";
import { fetchJson, isStackUp, SERVICE_URLS } from "./helpers";

/**
 * Phase 7.3 — CONSENT QR validation e2e.
 *
 * Exercises the supervisor/dashboard QR validity probe:
 *   GET /api/v1/qr/validate?payload=<json>&signature=<hex>
 *
 * The dashboard verifies the QR with a pure HMAC-SHA256 over the canonical
 * payload (apps/dashboard/src/server/index.ts → QrValidatorService.validate →
 * verifyQrPayload, apps/chat-bot/src/consent/consent-service.ts uses the same
 * signer). So a pre-signed fixture built with the shared QR_KEY validates as
 * `valid: true` WITHOUT needing the chat-bot's signature-chain store — which
 * is exactly what lets e2e assert the happy path standalone.
 *
 * The true issuance path (chat-bot ConsentService.accept → QrSigner.sign) is
 * NOT reachable from e2e: it runs inside the chat-bot and has no inbound HTTP
 * surface. That half is `it.skip`'d with the real skeleton; we still exercise
 * the dashboard probe with a locally pre-signed payload.
 */

const QR_KEY = process.env.QR_KEY ?? "";
const ADMIN_JWT = process.env.ADMIN_JWT ?? "";

// Liveness resolved in beforeAll so `vitest list` can still collect this file.
let stackUp = false;
beforeAll(async () => {
  stackUp = await isStackUp();
}, 120_000);

/** Local mirror of @chatcap/crypto-keys QrPayload (REQ-CONSENT-3 shape). */
interface QrPayload {
  v: 1;
  consentId: string;
  termsVersion: number;
  keyVersion: number;
  iat: number;
}

/** Canonical serialization — field order is part of the signing contract. */
function canonicalQrPayload(p: QrPayload): string {
  return (
    `v=${p.v}` +
    `;consent_id=${p.consentId}` +
    `;terms_version=${p.termsVersion}` +
    `;key_version=${p.keyVersion}` +
    `;iat=${p.iat}`
  );
}

/** Mirror of @chatcap/crypto-keys signQrPayload (HMAC-SHA256, hex). */
function signQrPayload(payload: QrPayload, key: Buffer): string {
  return createHmac("sha256", key)
    .update(canonicalQrPayload(payload), "utf8")
    .digest("hex");
}

/** Build a consent QR payload + signature with the shared QR_KEY. */
function buildSignedConsentQr(): { payload: QrPayload; signature: string } {
  const keyVersion = Math.max(1, Number(process.env.QR_KEY_VERSION ?? "1") || 1);
  const payload: QrPayload = {
    v: 1,
    consentId: "00000000-0000-4000-8000-0000000000aa",
    termsVersion: 1,
    keyVersion,
    iat: Math.floor(Date.now() / 1000),
  };
  const signature = signQrPayload(payload, Buffer.from(QR_KEY, "utf8"));
  return { payload, signature };
}

interface QrValidateResult {
  valid: boolean;
  reason: string;
  keyVersion?: number;
}
interface QrValidateResponse {
  result: QrValidateResult;
}

describe("Phase 7.3 — CONSENT QR: issuance + dashboard validation", () => {
  it.skip(
    "chat-bot ConsentService issues a signed consent QR",
    async () => {
      /**
       * SKIPPED ON PURPOSE — no inbound issuance surface reachable from e2e.
       *
       * The real path (apps/chat-bot/src/consent/consent-service.ts) is:
       *
       *   const service = new ConsentService({
       *     db, encryptor, qrSignatureStore, qrKey: Buffer.from(QR_KEY),
       *     renderQr, otp, auditQr,
       *   });
       *   const { consentId, qrContent } = await service.accept({
       *     sessionId, contactKeyAnon, jurisdiction, termsVersion,
       *   });
       *   // qrContent === `${canonical(payload)}|${signature}`
       *   // decode via QrSigner.decode(qrContent) → { payload, signature }
       *
       * e2e cannot call this: it needs the chat-bot's DB + signature store and
       * there is no public inbound webhook for consent acceptance (task 4.4).
       */
      expect.unreachable("consent issuance needs chat-bot inbound (task 4.4)");
    }
  );

  it(
    "dashboard validates a pre-signed consent QR → 200 + valid",
    async () => {
      if (!stackUp) {
        console.warn("[e2e:consent] validate step skipped — stack not reachable.");
        return;
      }
      if (QR_KEY.length === 0) {
        console.warn("[e2e:consent] validate step skipped — QR_KEY not provided.");
        return;
      }
      if (ADMIN_JWT.length === 0) {
        console.warn("[e2e:consent] validate step skipped — ADMIN_JWT not provided.");
        return;
      }

      const { payload, signature } = buildSignedConsentQr();
      const params = new URLSearchParams({
        payload: JSON.stringify(payload),
        signature,
      });

      const res = await fetchJson<QrValidateResponse>(
        `${SERVICE_URLS.dashboard}/api/v1/qr/validate?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${ADMIN_JWT}` },
          expectStatus: 200,
        }
      );

      expect(res.result).toBeDefined();
      expect(typeof res.result.valid).toBe("boolean");
      // The dashboard probe reports a valid QR for a correctly signed payload.
      expect(res.result.valid).toBe(true);
      expect(res.result.reason).toBe("signature_match");
    },
    60_000
  );
});
