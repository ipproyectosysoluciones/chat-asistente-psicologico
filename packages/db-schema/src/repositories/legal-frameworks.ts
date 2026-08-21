import type { DbQueryable, QueryResultRow } from "./db";

/**
 * Legal-framework terms versions (consent legal-framework selection).
 * `framework_code` is UNIQUE, so publishing a new version upserts the single
 * row for that framework and bumps `terms_version`. `effective_at` is NOT NULL
 * on the table, so it is set via `now()` on every publish.
 */

export interface LegalFrameworkRow {
  id: string;
  countryCode: string;
  frameworkCode: string;
  noticeText: string;
  termsVersion: number;
  active: boolean;
  createdAt: string;
}

interface LegalFrameworkDbRow extends QueryResultRow {
  id: string;
  country_code: string;
  framework_code: string;
  notice_text: string;
  terms_version: number;
  active: boolean;
  created_at: Date;
}

function mapLegalFramework(row: LegalFrameworkDbRow): LegalFrameworkRow {
  return {
    id: row.id,
    countryCode: row.country_code,
    frameworkCode: row.framework_code,
    noticeText: row.notice_text,
    termsVersion: row.terms_version,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listLegalFrameworks(
  db: DbQueryable
): Promise<LegalFrameworkRow[]> {
  const result = await db.query<LegalFrameworkDbRow>(
    `SELECT id, country_code, framework_code, notice_text, terms_version,
             active, created_at
        FROM legal_frameworks
       ORDER BY created_at DESC;`
  );
  return result.rows.map(mapLegalFramework);
}

export interface PublishTermsInput {
  countryCode: string;
  frameworkCode: string;
  noticeText: string;
  version?: number;
}

export async function publishTermsVersion(
  db: DbQueryable,
  input: PublishTermsInput
): Promise<LegalFrameworkRow> {
  const result = await db.query<LegalFrameworkDbRow>(
    `INSERT INTO legal_frameworks (country_code, framework_code, notice_text,
                                  terms_version, active, effective_at)
     VALUES ($1, $2, $3,
             CASE WHEN $4 IS NOT NULL THEN $4
                  ELSE (SELECT COALESCE(MAX(terms_version), 0) + 1
                          FROM legal_frameworks
                         WHERE country_code = $1 AND framework_code = $2)
             END,
             true, now())
     ON CONFLICT (framework_code) DO UPDATE
       SET terms_version = EXCLUDED.terms_version,
           notice_text = EXCLUDED.notice_text,
           active = true,
           effective_at = now(),
           updated_at = now()
     RETURNING id, country_code, framework_code, notice_text, terms_version,
               active, created_at;`,
    [input.countryCode, input.frameworkCode, input.noticeText, input.version ?? null]
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("legal-frameworks: publish returned no row");
  }
  return mapLegalFramework(row);
}
