import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { LEGAL_FRAMEWORKS } from "@chatcap/shared-types";
import { publishTermsVersion } from "../src/repositories/legal-frameworks";
import {
  createNextKeyVersion,
  currentActiveKeyVersion,
} from "../src/repositories/key-versions";

/**
 * Phase 7.2 seed (REQ-CONSENT-6, REQ-KEY-1): idempotently publishes an initial
 * terms version for every real legal framework and ensures exactly one active
 * `key_version` exists for consent encryption.
 *
 * The `XX/DEFAULT` entry in `LEGAL_FRAMEWORKS` is a client-side fallback and
 * is intentionally excluded: it has no jurisdiction row in `legal_frameworks`
 * and the consent flow resolves it in code, not from the DB.
 *
 * Idempotency: `publishTermsVersion` upserts on `framework_code`, and the key
 * version is only created when no active key exists. Re-running never rotates a
 * live credential or duplicates rows.
 */

// Key rotation policy mirrors packages/crypto-keys/src/lifecycle/policy.ts
// (KEY_LIFETIME_MS + FORCED_ROTATION_DELAY_MS) but is inlined here to keep
// db-schema free of an upward dependency on crypto-keys.
const KEY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const FORCED_ROTATION_DELAY_MS = 12 * 60 * 60 * 1000;
const SALT_LENGTH_BYTES = 32;

/**
 * Conservative default privacy notices (Spanish, user-facing). Inlined rather
 * than imported from the chat-bot package to avoid an upward dependency; the
 * copy follows the same conservative tone as the chat-bot `PRIVACY_NOTICES`.
 */
const CONSERVATIVE_NOTICES: Record<string, string> = {
  "COL-1581":
    "Conforme a la Ley 1581 de 2012 y su Decreto Reglamentario 1377 de 2013, " +
    "tus datos personales de salud se tratan de forma confidencial y únicamente " +
    "para tu acompañamiento, previo a tu consentimiento. Puedes solicitar en " +
    "cualquier momento la consulta, rectificación, actualización, supresión y " +
    "revocación de tu información.",
  "MX-LFPDPPP":
    "En términos de la Ley Federal de Protección de Datos Personales en Posesión " +
    "de los Particulares (LFPDPPP), tus datos de salud se tratan con confidencialidad " +
    "y solo para los fines del acompañamiento, previa aceptación de este aviso. " +
    "Puedes ejercer tus derechos ARCO en cualquier momento.",
  "US-HIPAA":
    "Con sujeción a la Ley de Portabilidad y Responsabilidad de Seguros de Salud " +
    "(HIPAA), tu información de salud se mantiene confidencial, se usa únicamente " +
    "para brindarte este acompañamiento y no se comparte sin tu autorización. " +
    "Puedes solicitar en cualquier momento el acceso, corrección y supresión de tus datos.",
  "EU-GDPR":
    "De conformidad con el Reglamento (UE) 2016/679 (RGPD), tus datos de salud tienen " +
    "categoría de datos especialmente protegidos y se tratan solo tras tu consentimiento " +
    "explícito, con fines de acompañamiento. Tienes derecho de acceso, rectificación, " +
    "supresión y portabilidad en cualquier momento.",
  "AR-25326":
    "Conforme a la Ley 25.326 de Protección de Datos Personales y la Ley 26.529 de " +
    "Derechos del Paciente, tus datos de salud se tratan con confidencialidad y solo " +
    "para tu acompañamiento, previo consentimiento informado. Puedes ejercer los " +
    "derechos de acceso, rectificación y supresión.",
  "CL-19628":
    "De acuerdo con la Ley 19.628 sobre Protección de la Vida Privada, tus datos " +
    "personales de salud se tratan de forma confidencial, previo consentimiento " +
    "explícito y para las finalidades del acompañamiento. Tienes derecho a solicitar " +
    "información, modificación y cancelación de tus datos.",
};

async function seedFrameworks(db: Pool): Promise<string[]> {
  const frameworks = LEGAL_FRAMEWORKS.filter(
    (framework) => framework.jurisdiction !== "DEFAULT"
  );

  const seeded: string[] = [];
  for (const framework of frameworks) {
    const noticeText = CONSERVATIVE_NOTICES[framework.frameworkCode];
    if (noticeText === undefined) {
      throw new Error(
        `No conservative notice configured for framework '${framework.frameworkCode}'. ` +
          `Add it to CONSERVATIVE_NOTICES in seed/seed.ts.`
      );
    }
    const row = await publishTermsVersion(db, {
      countryCode: framework.countryCode,
      frameworkCode: framework.frameworkCode,
      noticeText,
    });
    seeded.push(`${framework.frameworkCode} (v${row.termsVersion})`);
  }
  return seeded;
}

async function ensureFirstKeyVersion(db: Pool): Promise<number> {
  const active = await currentActiveKeyVersion(db);
  if (active !== undefined) {
    return active.keyVersion;
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + KEY_LIFETIME_MS);
  const forcedRotationDueAt = new Date(
    expiresAt.getTime() + FORCED_ROTATION_DELAY_MS
  );
  const created = await createNextKeyVersion(db, {
    salt: randomBytes(SALT_LENGTH_BYTES).toString("hex"),
    expiresAt,
    forcedRotationDueAt,
  });
  return created.keyVersion;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error(
      "DATABASE_URL is required to run the seed (set it in the environment)."
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const frameworks = await seedFrameworks(pool);
    const keyVersion = await ensureFirstKeyVersion(pool);
    console.log(
      `Seed complete — frameworks: [${frameworks.join(", ")}]; active key_version=${keyVersion}`
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    "Seed failed:",
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
