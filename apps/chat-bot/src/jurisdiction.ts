import { LEGAL_FRAMEWORKS } from "@chatcap/shared-types";

/**
 * Jurisdiction resolution (task 4.3, REQ-CONSENT-1/6): maps an ISO-3166
 * alpha-2 country code to the matching LEGAL_FRAMEWORKS entry. EU member
 * states bucket to the GDPR framework; anything unknown or unresolved maps to
 * the conservative DEFAULT framework with `isDefault: true` so the flow can
 * flag the session for legal review. Pure function — no I/O.
 */

const EU_MEMBER_COUNTRY_CODES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

/**
 * Every country code that resolves to a real (non-DEFAULT) framework: the
 * directly mapped codes plus EU member states. Used by the jurisdiction flow
 * to accept a 2-letter code reply without guessing.
 */
export const KNOWN_COUNTRY_CODES = new Set([
  "CO",
  "MX",
  "US",
  "AR",
  "CL",
  ...EU_MEMBER_COUNTRY_CODES,
]);

export interface ResolvedJurisdiction {
  countryCode: string;
  jurisdiction: string;
  frameworkCode: string;
  name: string;
  isDefault: boolean;
}

function toEntry(countryCode: string): ResolvedJurisdiction {
  const entry = LEGAL_FRAMEWORKS.find((f) => f.countryCode === countryCode);
  if (entry === undefined) {
    throw new Error(`No legal framework entry for countryCode ${countryCode}`);
  }
  return {
    countryCode: entry.countryCode,
    jurisdiction: entry.jurisdiction,
    frameworkCode: entry.frameworkCode,
    name: entry.name,
    isDefault: false,
  };
}

function defaultEntry(): ResolvedJurisdiction {
  const entry = LEGAL_FRAMEWORKS.find((f) => f.countryCode === "XX");
  if (entry === undefined) {
    throw new Error("LEGAL_FRAMEWORKS is missing the XX default entry");
  }
  return {
    countryCode: entry.countryCode,
    jurisdiction: entry.jurisdiction,
    frameworkCode: entry.frameworkCode,
    name: entry.name,
    isDefault: true,
  };
}

export function resolveJurisdiction(countryCode?: string): ResolvedJurisdiction {
  if (countryCode === undefined) {
    return defaultEntry();
  }

  const code = countryCode.toUpperCase();
  if (EU_MEMBER_COUNTRY_CODES.has(code)) {
    return toEntry("EU");
  }
  const known = LEGAL_FRAMEWORKS.find((f) => f.countryCode === code);
  if (known !== undefined) {
    return toEntry(code);
  }
  return defaultEntry();
}
