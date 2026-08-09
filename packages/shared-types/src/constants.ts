/**
 * Runtime constants for the domain vocabulary. Single source of truth:
 * every type below is derived from these `as const` objects — no enums.
 */

export const ROLE = {
  ANONYMOUS: "anonymous",
  PATIENT: "patient",
  SUPERVISOR: "supervisor",
  ADMIN: "admin",
} as const;

export const ALERT_LEVEL = {
  RED: "red",
  ORANGE: "orange",
  YELLOW: "yellow",
} as const;

export const RISK_LEVEL = {
  RED: "red",
  ORANGE: "orange",
  YELLOW: "yellow",
  NORMAL: "normal",
} as const;

export const PERSISTENCE_CLASS = {
  ANONYMOUS: "anonymous",
  HC: "hc",
} as const;

export const AI_STATE = {
  AUTO: "auto",
  TAKEOVER: "takeover",
} as const;

export const CONSENT_STATE = {
  NOTICE_SHOWN: "notice_shown",
  ACCEPTED: "accepted",
  RENEWED: "renewed",
  REVOKED: "revoked",
} as const;

export const GATE_VERDICT = {
  EMIT: "emit",
  RETRY: "retry",
  YELLOW_FLAG: "yellow_flag",
  ORANGE_BLOCK: "orange_block",
} as const;

export const NLI_VERDICT = {
  ENTAILMENT: "entailment",
  NEUTRAL: "neutral",
  CONTRADICTION: "contradiction",
} as const;

export const GUARDRAIL_LEVEL = {
  NONE: "none",
  YELLOW: "yellow",
  ORANGE: "orange",
} as const;

export const KEY_STATUS = {
  ACTIVE: "active",
  RETIRED: "retired",
  EXPIRED: "expired",
  COMPROMISED: "compromised",
} as const;

export const ALERT_STATUS = {
  OPEN: "open",
  ACKNOWLEDGED: "acknowledged",
  RESOLVED: "resolved",
} as const;

export const BATCH_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  VERIFIED: "verified",
  ROLLED_BACK: "rolled_back",
} as const;

export const JOB_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
} as const;

export const DOCUMENT_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  VECTORIZED: "vectorized",
  BLACKLISTED: "blacklisted",
  FAILED: "failed",
} as const;

export const OTP_STATUS = {
  PENDING: "pending",
  VERIFIED: "verified",
  EXPIRED: "expired",
  LOCKED: "locked",
} as const;

export const QR_SIGNATURE_STATUS = {
  ACTIVE: "active",
  ARCHIVED: "archived",
  REVOKED: "revoked",
} as const;

export const ACTOR_TYPE = {
  ANONYMOUS: "anonymous",
  PATIENT: "patient",
  SUPERVISOR: "supervisor",
  ADMIN: "admin",
  SYSTEM: "system",
} as const;

/**
 * Stable RFC 7807 error codes (design §3.2). Must never change: consumers
 * match on these values.
 */
export const ERROR_CODE = {
  VALIDATION_ERROR: "validation_error",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  RATE_LIMITED: "rate_limited",
  GATE_BLOCKED: "gate_blocked",
  OTP_INVALID: "otp_invalid",
  OTP_EXPIRED: "otp_expired",
  ROTATION_IN_PROGRESS: "rotation_in_progress",
  UPSTREAM_FAILED: "upstream_failed",
  INTERNAL_ERROR: "internal_error",
} as const;

/** Telemetry event types published over Redis pub-sub (design §2.2). */
export const EVENT_TYPE = {
  ALERT_RAISED: "alert_raised",
  ALERT_UPDATED: "alert_updated",
  CHAT_TAKEOVER: "chat_takeover",
  TELEMETRY_RAG: "telemetry_rag",
  REENCRYPTION_PROGRESS: "reencryption_progress",
  KEY_ROTATED: "key_rotated",
  PURGE_RUN: "purge_run",
} as const;

/** Default coherence-gate thresholds (calibrated on pilot data during verify). */
export const GATE_THRESHOLDS_DEFAULT = {
  COSINE_EMIT: 0.85,
  COSINE_RETRY: 0.75,
  MAX_RETRIES: 1,
  NLI_ENABLED: true,
} as const;
