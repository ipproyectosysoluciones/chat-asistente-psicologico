import type { OtpStatus } from "@chatcap/shared-types";
import type { DbQueryable, QueryResultRow } from "@chatcap/db-schema";

import type { OtpStore, StoredOtp } from "./otp-service";

/**
 * PostgreSQL {@link OtpStore} over the `otp_codes` table (migration 0001,
 * REQ-KEY-6). `otp_codes.status` is CHECK-constrained to the four OtpStatus
 * literals and `id` is a uuid column, so ids issued by OtpService (uuid v4)
 * round-trip. Storage is hash-only — the plaintext code never crosses this
 * boundary.
 */
interface OtpRow extends QueryResultRow {
  id: string;
  consent_id: string;
  otp_hash: string;
  attempts: number;
  expires_at: Date;
  status: string;
}

export class PgOtpStore implements OtpStore {
  constructor(private readonly db: DbQueryable) {}

  async insert(record: StoredOtp): Promise<void> {
    await this.db.query(
      `INSERT INTO otp_codes (id, consent_id, otp_hash, attempts, expires_at, status)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [
        record.id,
        record.consentId,
        record.otpHash,
        record.attempts,
        new Date(record.expiresAt),
        record.status,
      ]
    );
  }

  async findById(id: string): Promise<StoredOtp | undefined> {
    const result = await this.db.query<OtpRow>(
      `SELECT id, consent_id, otp_hash, attempts, expires_at, status
         FROM otp_codes
        WHERE id = $1;`,
      [id]
    );
    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      id: row.id,
      consentId: row.consent_id,
      otpHash: row.otp_hash,
      attempts: row.attempts,
      expiresAt: row.expires_at.toISOString(),
      // safe: otp_codes.status is CHECK-constrained to the four OtpStatus
      // literals, so the row cannot carry a value outside the type.
      status: row.status as OtpStatus,
    };
  }

  async update(record: StoredOtp): Promise<void> {
    await this.db.query(
      `UPDATE otp_codes
          SET otp_hash = $2, attempts = $3, expires_at = $4, status = $5
        WHERE id = $1;`,
      [
        record.id,
        record.otpHash,
        record.attempts,
        new Date(record.expiresAt),
        record.status,
      ]
    );
  }
}
