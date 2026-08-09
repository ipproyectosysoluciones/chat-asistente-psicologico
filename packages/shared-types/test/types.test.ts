import { describe, expect, expectTypeOf, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTOR_TYPE,
  AI_STATE,
  ALERT_LEVEL,
  ALERT_STATUS,
  BATCH_STATUS,
  CONSENT_STATE,
  DOCUMENT_STATUS,
  ERROR_CODE,
  EVENT_TYPE,
  GATE_VERDICT,
  GUARDRAIL_LEVEL,
  JOB_STATUS,
  KEY_STATUS,
  NLI_VERDICT,
  OTP_STATUS,
  PERSISTENCE_CLASS,
  QR_SIGNATURE_STATUS,
  RISK_LEVEL,
  ROLE,
} from "../src/index";
import type {
  AccessTokenClaims,
  AlertEvent,
  AlertStateMachine,
  ApiErrorBody,
  ConsentFlowState,
  ConsentRecord,
  EncryptedPayload,
  GateResult,
  GuardrailResult,
  NliResult,
  QrPayload,
  RagTrace,
  ReEncryptionState,
  RetrievedChunk,
  Role,
} from "../src/index";

describe("shared-types: as-const runtime constants", () => {
  test("role values are plain strings, not enums", () => {
    expect(ROLE.ANONYMOUS).toBe("anonymous");
    expect(ROLE.PATIENT).toBe("patient");
    expect(ROLE.SUPERVISOR).toBe("supervisor");
    expect(ROLE.ADMIN).toBe("admin");
    expect(typeof ROLE.ADMIN).toBe("string");
  });

  test("alert levels and risk levels are the three-level model + normal", () => {
    expect(ALERT_LEVEL.RED).toBe("red");
    expect(ALERT_LEVEL.ORANGE).toBe("orange");
    expect(ALERT_LEVEL.YELLOW).toBe("yellow");
    expect(RISK_LEVEL.NORMAL).toBe("normal");
  });

  test("error codes are the stable RFC 7807 codes from the design", () => {
    expect(ERROR_CODE.VALIDATION_ERROR).toBe("validation_error");
    expect(ERROR_CODE.UNAUTHORIZED).toBe("unauthorized");
    expect(ERROR_CODE.FORBIDDEN).toBe("forbidden");
    expect(ERROR_CODE.NOT_FOUND).toBe("not_found");
    expect(ERROR_CODE.CONFLICT).toBe("conflict");
    expect(ERROR_CODE.RATE_LIMITED).toBe("rate_limited");
    expect(ERROR_CODE.GATE_BLOCKED).toBe("gate_blocked");
    expect(ERROR_CODE.OTP_INVALID).toBe("otp_invalid");
    expect(ERROR_CODE.OTP_EXPIRED).toBe("otp_expired");
    expect(ERROR_CODE.ROTATION_IN_PROGRESS).toBe("rotation_in_progress");
    expect(ERROR_CODE.UPSTREAM_FAILED).toBe("upstream_failed");
    expect(ERROR_CODE.INTERNAL_ERROR).toBe("internal_error");
  });

  test("state machines expose the full transition vocabulary", () => {
    expect(CONSENT_STATE.NOTICE_SHOWN).toBe("notice_shown");
    expect(CONSENT_STATE.ACCEPTED).toBe("accepted");
    expect(CONSENT_STATE.RENEWED).toBe("renewed");
    expect(CONSENT_STATE.REVOKED).toBe("revoked");

    expect(ALERT_STATUS.OPEN).toBe("open");
    expect(ALERT_STATUS.ACKNOWLEDGED).toBe("acknowledged");
    expect(ALERT_STATUS.RESOLVED).toBe("resolved");

    expect(BATCH_STATUS.PENDING).toBe("pending");
    expect(BATCH_STATUS.RUNNING).toBe("running");
    expect(BATCH_STATUS.VERIFIED).toBe("verified");
    expect(BATCH_STATUS.ROLLED_BACK).toBe("rolled_back");

    expect(KEY_STATUS.ACTIVE).toBe("active");
    expect(KEY_STATUS.RETIRED).toBe("retired");
    expect(KEY_STATUS.EXPIRED).toBe("expired");
    expect(KEY_STATUS.COMPROMISED).toBe("compromised");
  });

  test("no source file declares a TypeScript enum", () => {
    const srcDir = join(__dirname, "..", "src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(srcDir, file), "utf8");
      expect(source).not.toMatch(/export\s+enum\s+\w+|\benum\s+[A-Z]\w+\s*\{/);
    }
  });
});

describe("shared-types: type-level smoke", () => {
  test("Role is exactly the four-role union", () => {
    expectTypeOf<Role>().toEqualTypeOf<
      "anonymous" | "patient" | "supervisor" | "admin"
    >();
  });

  test("GateVerdict is the gate outcome union", () => {
    expectTypeOf<
      (typeof GATE_VERDICT)[keyof typeof GATE_VERDICT]
    >().toEqualTypeOf<"emit" | "retry" | "yellow_flag" | "orange_block">();
  });

  test("NliVerdict is entailment | neutral | contradiction", () => {
    expectTypeOf<
      (typeof NLI_VERDICT)[keyof typeof NLI_VERDICT]
    >().toEqualTypeOf<"entailment" | "neutral" | "contradiction">();
  });

  test("GateResult carries cosine, nli, guardrail and exact grounding chunks", () => {
    expectTypeOf<GateResult>().toMatchTypeOf<{
      verdict: "emit" | "retry" | "yellow_flag" | "orange_block";
      cosine: number;
      nli: NliResult;
      guardrail: GuardrailResult;
      chunks: RetrievedChunk[];
    }>();
    expectTypeOf<GateResult["cosine"]>().toBeNumber();
    expectTypeOf<RetrievedChunk["score"]>().toBeNumber();
    expectTypeOf<RetrievedChunk["legalFramework"]>().toBeString();
  });

  test("EncryptedPayload carries keyVersion + buffers for dual-read", () => {
    expectTypeOf<EncryptedPayload>().toMatchTypeOf<{
      keyVersion: number;
      iv: Buffer;
      ciphertext: Buffer;
      hmac: Buffer;
    }>();
  });

  test("ApiErrorBody is RFC 7807 with stable error code", () => {
    expectTypeOf<ApiErrorBody>().toMatchTypeOf<{
      type: string;
      title: string;
      status: number;
      detail: string;
      instance: string;
      trace_id: string;
      code: (typeof ERROR_CODE)[keyof typeof ERROR_CODE];
    }>();
  });

  test("AccessTokenClaims only allows supervisor|admin roles", () => {
    expectTypeOf<AccessTokenClaims["role"]>().toEqualTypeOf<
      "supervisor" | "admin"
    >();
    expectTypeOf<AccessTokenClaims["exp"]>().toBeNumber();
  });

  test("AlertEvent carries the dedupe key used by the escalation service", () => {
    expectTypeOf<AlertEvent>().toMatchTypeOf<{
      alertId: string;
      sessionId: string;
      level: "red" | "orange" | "yellow";
      category: string;
      dedupeKey: string;
      status: "open" | "acknowledged" | "resolved";
      createdAt: string;
    }>();
  });

  test("QrPayload is the versioned canonical payload", () => {
    expectTypeOf<QrPayload["v"]>().toEqualTypeOf<1>();
    expectTypeOf<QrPayload["consentId"]>().toBeString();
    expectTypeOf<QrPayload["keyVersion"]>().toBeNumber();
  });
});

describe("shared-types: discriminated unions for state machines", () => {
  test("alert lifecycle is a discriminated union on status", () => {
    const open: AlertStateMachine = { status: "open", createdAt: "t0" };
    const acknowledged: AlertStateMachine = {
      status: "acknowledged",
      createdAt: "t0",
      acknowledgedBy: "user_1",
      acknowledgedAt: "t1",
    };
    const resolved: AlertStateMachine = {
      status: "resolved",
      createdAt: "t0",
      resolvedAt: "t2",
      resolvedBy: "user_1",
      reason: "handled",
    };
    expect(open.status).toBe("open");
    expect(acknowledged.status).toBe("acknowledged");
    expect(resolved.status).toBe("resolved");
    // Narrowing: a resolved alert always exposes resolvedBy.
    if (resolved.status === "resolved") {
      expect(resolved.resolvedBy).toBe("user_1");
    }
  });

  test("consent flow is a discriminated union on state", () => {
    const shown: ConsentFlowState = { state: "notice_shown" };
    const accepted: ConsentFlowState = {
      state: "accepted",
      acceptedAt: "t0",
      termsVersion: 1,
      keyVersion: 1,
    };
    expect(shown.state).toBe("notice_shown");
    if (accepted.state === "accepted") {
      expect(accepted.termsVersion).toBe(1);
      expect(accepted.keyVersion).toBe(1);
    }
  });

  test("re-encryption batch is a discriminated union on status", () => {
    const verified: ReEncryptionState = {
      status: "verified",
      completedAt: "t1",
      rowsCount: 200,
      integrityHash: "abc",
    };
    const rolledBack: ReEncryptionState = {
      status: "rolled_back",
      completedAt: "t1",
      error: "hash mismatch",
    };
    expect(verified.status).toBe("verified");
    if (rolledBack.status === "rolled_back") {
      expect(rolledBack.error).toContain("mismatch");
    }
  });
});

describe("shared-types: event vocabulary used by telemetry", () => {
  test("event types cover alert, takeover, rag, rotation and purge", () => {
    expect(EVENT_TYPE.ALERT_RAISED).toBe("alert_raised");
    expect(EVENT_TYPE.CHAT_TAKEOVER).toBe("chat_takeover");
    expect(EVENT_TYPE.TELEMETRY_RAG).toBe("telemetry_rag");
    expect(EVENT_TYPE.REENCRYPTION_PROGRESS).toBe("reencryption_progress");
    expect(EVENT_TYPE.KEY_ROTATED).toBe("key_rotated");
    expect(EVENT_TYPE.PURGE_RUN).toBe("purge_run");
  });

  test("actor types cover RBAC roles plus system actors", () => {
    expect(ACTOR_TYPE.SUPERVISOR).toBe("supervisor");
    expect(ACTOR_TYPE.ADMIN).toBe("admin");
    expect(ACTOR_TYPE.SYSTEM).toBe("system");
  });
});

describe("shared-types: entity shapes consumed across services", () => {
  test("RagTrace exposes the full grounding trace for the dashboard", () => {
    expectTypeOf<RagTrace>().toMatchTypeOf<{
      traceId: string;
      sessionId: string;
      emitted: boolean;
      gate: GateResult;
    }>();
    expectTypeOf<RagTrace["retrieval"]["chunks"]>().toMatchTypeOf<
      RetrievedChunk[]
    >();
  });

  test("ConsentRecord carries key_version and integrity hash (REQ-CONSENT-4)", () => {
    expectTypeOf<ConsentRecord>().toMatchTypeOf<{
      sessionId: string;
      jurisdiction: string;
      termsVersion: number;
      keyVersion: number;
      integrityHash: string;
    }>();
  });

  test("guardrail result exposes deviation terms and block decision", () => {
    const blocked: GuardrailResult = {
      level: "orange",
      deviationTerms: ["diagnóstico"],
      blocked: true,
    };
    expect(blocked.blocked).toBe(true);
    expect(blocked.deviationTerms[0]).toBe("diagnóstico");
    expect(GUARDRAIL_LEVEL.ORANGE).toBe("orange");
    expect(GUARDRAIL_LEVEL.YELLOW).toBe("yellow");
  });

  test("persistence/ai/otp/qr vocabulary matches the schema design", () => {
    expect(PERSISTENCE_CLASS.ANONYMOUS).toBe("anonymous");
    expect(PERSISTENCE_CLASS.HC).toBe("hc");
    expect(AI_STATE.AUTO).toBe("auto");
    expect(AI_STATE.TAKEOVER).toBe("takeover");
    expect(OTP_STATUS.LOCKED).toBe("locked");
    expect(QR_SIGNATURE_STATUS.ARCHIVED).toBe("archived");
    expect(DOCUMENT_STATUS.BLACKLISTED).toBe("blacklisted");
    expect(JOB_STATUS.QUEUED).toBe("queued");
  });
});
