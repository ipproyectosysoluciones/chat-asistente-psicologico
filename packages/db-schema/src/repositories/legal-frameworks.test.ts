import { describe, expect, it } from "vitest";

import type { QueryResultRow } from "pg";

import {
  listLegalFrameworks,
  publishTermsVersion,
} from "./legal-frameworks";
import type { DbQueryable } from "./db";

/** Self-contained fake: returns queued rows per query call (no real DB). */
function fakeDb(
  responses: Array<{ rows?: QueryResultRow[]; rowCount?: number | null }>
): { db: DbQueryable } {
  let cursor = 0;
  const db: DbQueryable = {
    async query<T extends QueryResultRow>(_text: string, _values?: unknown[]) {
      const response =
        responses.length > 0
          ? responses[Math.min(cursor, responses.length - 1)]
          : undefined;
      cursor += 1;
      return {
        rows: (response?.rows ?? []) as T[],
        rowCount: response?.rowCount ?? null,
      };
    },
  };
  return { db };
}

/** DB-shaped row (snake_case, Date) the repository maps into LegalFrameworkRow. */
function dbRow(over: Record<string, unknown> = {}): QueryResultRow {
  return {
    id: "lf-1",
    country_code: "AR",
    framework_code: "AR-PROV",
    notice_text: "Aviso de privacidad",
    terms_version: 1,
    active: true,
    created_at: new Date("2026-08-13T00:00:00.000Z"),
    ...over,
  };
}

describe("legal-frameworks repository", () => {
  it("publishTermsVersion returns the mapped row", async () => {
    const { db } = fakeDb([{ rows: [dbRow()], rowCount: 1 }]);
    const result = await publishTermsVersion(db, {
      countryCode: "AR",
      frameworkCode: "AR-PROV",
      noticeText: "Aviso",
    });
    expect(result.id).toBe("lf-1");
    expect(result.countryCode).toBe("AR");
    expect(result.frameworkCode).toBe("AR-PROV");
    expect(result.termsVersion).toBe(1);
    expect(result.active).toBe(true);
    expect(result.createdAt).toBe("2026-08-13T00:00:00.000Z");
  });

  it("increments terms_version across publishes of the same framework", async () => {
    const { db } = fakeDb([
      { rows: [dbRow({ terms_version: 1 })], rowCount: 1 },
      { rows: [dbRow({ terms_version: 2 })], rowCount: 1 },
    ]);
    const first = await publishTermsVersion(db, {
      countryCode: "AR",
      frameworkCode: "AR-PROV",
      noticeText: "v1",
    });
    const second = await publishTermsVersion(db, {
      countryCode: "AR",
      frameworkCode: "AR-PROV",
      noticeText: "v2",
    });
    expect(first.termsVersion).toBe(1);
    expect(second.termsVersion).toBe(2);
  });

  it("honors an explicit version when provided", async () => {
    const { db } = fakeDb([{ rows: [dbRow({ id: "lf-9", terms_version: 7 })], rowCount: 1 }]);
    const result = await publishTermsVersion(db, {
      countryCode: "BR",
      frameworkCode: "BR-FED",
      noticeText: "Termos",
      version: 7,
    });
    expect(result.termsVersion).toBe(7);
  });

  it("listLegalFrameworks returns the published framework", async () => {
    const { db } = fakeDb([{ rows: [dbRow()], rowCount: 1 }]);
    const frameworks = await listLegalFrameworks(db);
    expect(frameworks).toHaveLength(1);
    expect(frameworks[0]?.frameworkCode).toBe("AR-PROV");
    expect(frameworks[0]?.termsVersion).toBe(1);
    expect(frameworks[0]?.active).toBe(true);
  });
});
