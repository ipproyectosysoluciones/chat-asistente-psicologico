import {
  ACTOR_TYPE,
  AI_STATE,
  ALERT_LEVEL,
  ALERT_STATUS,
  BATCH_STATUS,
  CONSENT_STATE,
  DOCUMENT_STATUS,
  ERROR_CODE,
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
} from "./constants";

export type Role = (typeof ROLE)[keyof typeof ROLE];
export type AlertLevel = (typeof ALERT_LEVEL)[keyof typeof ALERT_LEVEL];
export type RiskLevel = (typeof RISK_LEVEL)[keyof typeof RISK_LEVEL];
export type PersistenceClass =
  (typeof PERSISTENCE_CLASS)[keyof typeof PERSISTENCE_CLASS];
export type AiState = (typeof AI_STATE)[keyof typeof AI_STATE];
export type ConsentState =
  (typeof CONSENT_STATE)[keyof typeof CONSENT_STATE];
export type GateVerdict = (typeof GATE_VERDICT)[keyof typeof GATE_VERDICT];
export type NliVerdict = (typeof NLI_VERDICT)[keyof typeof NLI_VERDICT];
export type GuardrailLevel =
  (typeof GUARDRAIL_LEVEL)[keyof typeof GUARDRAIL_LEVEL];
export type KeyStatus = (typeof KEY_STATUS)[keyof typeof KEY_STATUS];
export type AlertStatus = (typeof ALERT_STATUS)[keyof typeof ALERT_STATUS];
export type BatchStatus = (typeof BATCH_STATUS)[keyof typeof BATCH_STATUS];
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];
export type DocumentStatus =
  (typeof DOCUMENT_STATUS)[keyof typeof DOCUMENT_STATUS];
export type OtpStatus = (typeof OTP_STATUS)[keyof typeof OTP_STATUS];
export type QrSignatureStatus =
  (typeof QR_SIGNATURE_STATUS)[keyof typeof QR_SIGNATURE_STATUS];
export type ActorType = (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];
export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** NLI verdict produced by the GPT-4o-mini side-task (REQ-RAG-5). */
export interface NliResult {
  verdict: NliVerdict;
  confidence: number;
}

/** Role-deviation scan of a generated answer (REQ-RAG-6). */
export interface GuardrailResult {
  level: GuardrailLevel;
  deviationTerms: string[];
  blocked: boolean;
}

/** A single retrieved chunk with mandatory metadata (REQ-RAG-3). */
export interface RetrievedChunk {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  content: string;
  category: string;
  source: string;
  language: string;
  legalFramework: string;
  /** Cosine similarity of the generated answer against this chunk. */
  score: number;
}

/**
 * Coherence-gate evaluation result (REQ-RAG-4/5/6). `chunks` is the exact
 * grounding trace surfaced to the supervisor dashboard (REQ-RAG-8).
 */
export interface GateResult {
  verdict: GateVerdict;
  /** 0..1 cosine similarity between answer and best source chunk. */
  cosine: number;
  nli: NliResult;
  guardrail: GuardrailResult;
  chunks: RetrievedChunk[];
}

/**
 * Encrypted payload (REQ-CONSENT-4). `keyVersion` drives dual-read: the
 * decryptor derives the row's key from its own version (REQ-KEY-8).
 */
export interface EncryptedPayload {
  keyVersion: number;
  iv: Buffer;
  ciphertext: Buffer;
  hmac: Buffer;
}

/** RFC 7807 problem+json body (design §3.2). */
export interface ApiErrorBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  trace_id: string;
  code: ErrorCode;
}

/** JWT access-token claims (design §3.3): dashboard roles only. */
export interface AccessTokenClaims {
  sub: string;
  role: "supervisor" | "admin";
  exp: number;
  iat?: number;
}

/**
 * Alert event published over Redis pub-sub (REQ-ALERT-1/5). Deliberately
 * PII-free: no message content, no phone, no raw payload (REQ-ALERT-6).
 */
export interface AlertEvent {
  alertId: string;
  sessionId: string;
  level: AlertLevel;
  category: string;
  dedupeKey: string;
  status: AlertStatus;
  createdAt: string;
  keyword?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  traceId?: string;
}

/** Canonical QR payload (design §6.1): versioned, signed with QR_KEY. */
export interface QrPayload {
  v: 1;
  consentId: string;
  termsVersion: number;
  keyVersion: number;
  iat: number;
}

/** Archived QR signature for the chain of trust (REQ-KEY-7). */
export interface QrSignature {
  id: string;
  consentId: string;
  keyVersion: number;
  signature: string;
  status: QrSignatureStatus;
  createdAt: string;
}

/**
 * Full RAG grounding trace (REQ-RAG-8): classification, retrieval,
 * generation and gate results for the supervisor dashboard.
 */
export interface RagTrace {
  traceId: string;
  sessionId: string;
  risk: RiskLevel;
  classification: {
    model: string;
    risk: RiskLevel;
    confidence: number;
  };
  retrieval: {
    model: string;
    topK: number;
    hnsw: { efSearch: number };
    chunks: RetrievedChunk[];
  };
  generation: {
    model: string;
    temperature: number;
    promptCharCount?: number;
  };
  gate: GateResult;
  emitted: boolean;
  latencyMs?: number;
  createdAt: string;
}

export interface Session {
  id: string;
  contactKeyAnon: string;
  jurisdiction?: string;
  persistenceClass: PersistenceClass;
  consentState: ConsentState;
  aiState: AiState;
  createdAt: string;
  lastActivityAt: string;
  purgeAt?: string;
}

export interface ConsentRecord {
  id: string;
  sessionId: string;
  jurisdiction: string;
  termsVersion: number;
  keyVersion: number;
  integrityHash: string;
  active: boolean;
  createdAt: string;
}

export interface KeyVersionInfo {
  keyVersion: number;
  algorithm: string;
  salt: string;
  status: KeyStatus;
  createdAt: string;
  expiresAt: string;
  forcedRotationDueAt: string;
}

export interface ReEncryptionBatch {
  id: string;
  keyFrom: number;
  keyTo: number;
  status: BatchStatus;
  rowsCount?: number;
  integrityHash?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface AuditLogEntry {
  id: string;
  actorType: ActorType;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason?: string;
  /** Non-PII detail only (REQ-DASH-8): never message content/phone/payload. */
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface VectorChunk {
  id: string;
  docId: string;
  chunkIndex: number;
  content: string;
  category: string;
  source: string;
  language: string;
  legalFramework: string;
  createdAt: string;
}

export interface LegalFramework {
  id: string;
  countryCode: string;
  frameworkCode: string;
  noticeText: string;
  termsVersion: number;
  effectiveAt: string;
  active: boolean;
}

export interface IngestionJob {
  id: string;
  jobType: string;
  status: JobStatus;
  chunksTotal: number;
  chunksDone: number;
  error?: string;
  createdAt: string;
}

export interface Document {
  id: string;
  title: string;
  sourceUrl?: string;
  sourceType: string;
  language: string;
  legalFramework: string;
  status: DocumentStatus;
  blacklistHits: number;
  createdAt: string;
}

export interface OtpRecord {
  id: string;
  consentId: string;
  otpHash: string;
  attempts: number;
  expiresAt: string;
  status: OtpStatus;
}

/** Gate thresholds resolved from env (design §6.2, calibrated in verify). */
export interface GateThresholds {
  cosineEmit: number;
  cosineRetry: number;
  maxRetries: number;
  nliEnabled: boolean;
}

/* ---------------------------------------------------------------------------
 * Discriminated unions for state machines (AGENTS.md: no enums, unions are
 * the state-machine contract).
 * ------------------------------------------------------------------------- */

export type AlertStateMachine =
  | { status: "open"; createdAt: string }
  | {
      status: "acknowledged";
      createdAt: string;
      acknowledgedBy: string;
      acknowledgedAt: string;
    }
  | {
      status: "resolved";
      createdAt: string;
      acknowledgedBy?: string;
      resolvedAt: string;
      resolvedBy: string;
      reason?: string;
    };

export type ConsentFlowState =
  | { state: "notice_shown" }
  | {
      state: "accepted";
      acceptedAt: string;
      termsVersion: number;
      keyVersion: number;
    }
  | { state: "renewed"; renewedAt: string; keyVersion: number }
  | { state: "revoked"; revokedAt: string };

export type ReEncryptionState =
  | { status: "pending" }
  | { status: "running"; startedAt: string }
  | {
      status: "verified";
      completedAt: string;
      rowsCount: number;
      integrityHash: string;
    }
  | { status: "rolled_back"; completedAt: string; error: string };
