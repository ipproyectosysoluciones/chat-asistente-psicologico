import {
  decodePayload,
  parsePayload,
  type Encryptor,
} from "@chatcap/crypto-keys";
import {
  findActiveConsentWithPayload,
  getSession,
  insertAuditEntry,
  listHistoryForExport,
  type DbQueryable,
  type NewAuditEntry,
} from "@chatcap/db-schema";
import type { ActorType } from "@chatcap/shared-types";

/**
 * Clinical-history export (task 4.9, REQ-CONSENT-5, REQ-DASH-8): hands an
 * hc session its decrypted conversation as a portable snapshot, proving the
 * acceptance by decrypting the stored consent envelope first. Every export is
 * audit-logged with who/when/why and zero message content — the audit row
 * never carries health data.
 *
 * Denied for anonymous sessions (their history is transient by design) and
 * for sessions without an active consent record.
 */

/** Raised when the export is attempted for a non-hc session. */
export class ExportAccessError extends Error {
  readonly code = "export_not_permitted" as const;

  constructor(message: string) {
    super(message);
    this.name = "ExportAccessError";
  }
}

/** Raised when the session has no active consent to prove the export. */
export class ExportConsentMissingError extends Error {
  readonly code = "export_consent_missing" as const;

  constructor(message: string) {
    super(message);
    this.name = "ExportConsentMissingError";
  }
}

export interface HistoryExportEntry {
  sender: "user" | "bot";
  createdAt: string;
  text: string;
}

export interface ClinicalHistoryExport {
  consentId: string;
  sessionId: string;
  jurisdiction: string;
  termsVersion: number;
  keyVersion: number;
  exportedAt: string;
  history: HistoryExportEntry[];
}

export interface ExportServiceOptions {
  db: DbQueryable;
  encryptor: Encryptor;
  /** Audit sink (REQ-DASH-8); defaults to insertAuditEntry over the same db. */
  audit?: (entry: NewAuditEntry) => Promise<unknown>;
}

export class ExportService {
  private readonly db: DbQueryable;
  private readonly encryptor: Encryptor;
  private readonly audit: (entry: NewAuditEntry) => Promise<unknown>;

  constructor(options: ExportServiceOptions) {
    this.db = options.db;
    this.encryptor = options.encryptor;
    this.audit =
      options.audit ?? ((entry) => insertAuditEntry(this.db, entry));
  }

  async exportClinicalHistory(input: {
    sessionId: string;
    actorType: ActorType;
    actorId?: string;
    reason?: string;
  }): Promise<ClinicalHistoryExport> {
    const session = await getSession(this.db, input.sessionId);
    if (session === undefined || session.persistenceClass !== "hc") {
      throw new ExportAccessError(
        "clinical history export requires an hc (historia clínica) session"
      );
    }

    // RBAC (AGENTS.md): only the session owner (the patient, by anonymized
    // contact key) or a supervisor/admin with a documented reason may access
    // an HC history. No other role reaches the encrypted records.
    const isOwner =
      input.actorType === "patient" && input.actorId === session.contactKeyAnon;
    const isSupervisorOrAdmin =
      input.actorType === "supervisor" || input.actorType === "admin";
    if (!isOwner && !isSupervisorOrAdmin) {
      throw new ExportAccessError(
        "clinical history export requires the session owner or a supervisor/admin"
      );
    }
    if (isSupervisorOrAdmin && input.reason === undefined) {
      throw new ExportAccessError(
        "supervisor/admin exports require a documented reason"
      );
    }

    const consent = await findActiveConsentWithPayload(this.db, input.sessionId);
    if (consent === undefined) {
      throw new ExportConsentMissingError(
        `no active consent record for session ${input.sessionId}`
      );
    }
    // decrypt verifies the HMAC — a tampered or corrupted consent fails here.
    await this.encryptor.decrypt(
      decodePayload(consent.keyVersion, consent.encryptedPayload)
    );

    const rows = await listHistoryForExport(this.db, input.sessionId);
    const history: HistoryExportEntry[] = [];
    for (const row of rows) {
      let text: string;
      if (row.keyVersion !== null && row.message.encrypted !== undefined) {
        const decrypted = await this.encryptor.decrypt(
          parsePayload(row.keyVersion, row.message.encrypted)
        );
        const parsed: unknown = JSON.parse(decrypted.toString("utf8"));
        text =
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as { text?: unknown }).text === "string"
            ? (parsed as { text: string }).text
            : decrypted.toString("utf8");
      } else {
        text = row.message.text ?? "";
      }
      history.push({ sender: row.sender, createdAt: row.createdAt, text });
    }

    const exportedAt = new Date().toISOString();
    await this.audit({
      actorType: input.actorType,
      actorId: input.actorId,
      action: "hc_history_export",
      resourceType: "consent",
      resourceId: consent.id,
      reason: input.reason ?? "hc_history_export",
      // Non-PII only: counts and timestamps, never message content.
      meta: { entryCount: history.length, exportedAt },
    });

    return {
      consentId: consent.id,
      sessionId: input.sessionId,
      jurisdiction: consent.jurisdiction,
      termsVersion: consent.termsVersion,
      keyVersion: consent.keyVersion,
      exportedAt,
      history,
    };
  }
}
