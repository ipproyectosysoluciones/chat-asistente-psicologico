import { describe, expect, it } from "vitest";

import { noticeForJurisdiction, PRIVACY_NOTICES } from "../src/consent/notices";

/**
 * Privacy notices (task 4.4, REQ-CONSENT-6): six legal frameworks plus the
 * conservative default, each with its own notice text and terms version.
 * Shown BEFORE any support topic — no data is stored before acceptance
 * (REQ-CONSENT-2).
 */

describe("privacy notices (REQ-CONSENT-6)", () => {
  it("covers the six supported frameworks plus the default", () => {
    const jurisdictions = PRIVACY_NOTICES.map((notice) => notice.jurisdiction);
    expect(jurisdictions).toEqual([
      "CO",
      "MX",
      "US",
      "EU",
      "AR",
      "CL",
      "DEFAULT",
    ]);
  });

  it("every notice has a terms version and a non-empty text", () => {
    for (const notice of PRIVACY_NOTICES) {
      expect(notice.termsVersion).toBeGreaterThanOrEqual(1);
      expect(notice.text.length).toBeGreaterThan(50);
      expect(notice.frameworkCode.length).toBeGreaterThan(0);
    }
  });

  it("resolves the LFPDPPP notice for Mexico", () => {
    const notice = noticeForJurisdiction("MX");
    expect(notice.frameworkCode).toBe("MX-LFPDPPP");
    expect(notice.text.toLowerCase()).toContain("lfpdppp");
  });

  it("falls back to the conservative default for unknown jurisdictions", () => {
    const notice = noticeForJurisdiction("ZZ");
    expect(notice.jurisdiction).toBe("DEFAULT");
    expect(notice.frameworkCode).toBe("DEFAULT");
  });
});
