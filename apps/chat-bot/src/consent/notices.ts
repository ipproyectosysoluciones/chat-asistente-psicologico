/**
 * Privacy notices (task 4.4, REQ-CONSENT-6): six legal frameworks plus the
 * conservative default, each with its own notice text and terms version.
 * Shown BEFORE any support topic — no data is stored before acceptance
 * (REQ-CONSENT-2). Copy is user-facing Spanish; framework codes are the
 * stable identifiers used across consent_records and the QR chain.
 */

export interface PrivacyNotice {
  jurisdiction: string;
  frameworkCode: string;
  termsVersion: number;
  text: string;
}

const DEFAULT_TERMS_VERSION = 1;

export const PRIVACY_NOTICES: readonly PrivacyNotice[] = [
  {
    jurisdiction: "CO",
    frameworkCode: "CO-L1581-2012",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "Según la Ley 1581 de 2012 y sus decretos reglamentarios, tus datos personales " +
      "de salud serán tratados de forma confidencial, con finalidades exclusivamente " +
      "relacionadas con tu acompañamiento y bajo tu consentimiento explícito. " +
      "Podés solicitar la consulta, rectificación, supresión y revocación de tu " +
      "información en cualquier momento.",
  },
  {
    jurisdiction: "MX",
    frameworkCode: "MX-LFPDPPP",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "Con fundamento en la Ley Federal de Protección de Datos Personales en Posesión " +
      "de los Particulares (LFPDPPP), tus datos de salud serán tratados de manera " +
      "confidencial y solo para los fines del acompañamiento, previa aceptación del " +
      "presente aviso de privacidad. Puedes ejercer tus derechos ARCO en cualquier " +
      "momento.",
  },
  {
    jurisdiction: "US",
    frameworkCode: "US-HIPAA",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "Under the Health Insurance Portability and Accountability Act (HIPAA) and " +
      "applicable state privacy laws, your health information is kept confidential, " +
      "used only to provide this support service and never disclosed without your " +
      "authorization. You may request access, correction and deletion of your data.",
  },
  {
    jurisdiction: "EU",
    frameworkCode: "EU-GDPR",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "De conformidad con el Reglamento (UE) 2016/679 (RGPD), tus datos de salud son " +
      "datos especialmente protegidos. Se tratarán con finalidad de acompañamiento " +
      "solo tras tu consentimiento explícito, con derecho de acceso, rectificación, " +
      "supresión y portabilidad en cualquier momento.",
  },
  {
    jurisdiction: "AR",
    frameworkCode: "AR-L25326",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "Conforme a la Ley 25.326 de Protección de los Datos Personales y la Ley " +
      "26.529 de Derechos del Paciente, tus datos de salud serán tratados con " +
      "confidencialidad y solo para tu acompañamiento, previo consentimiento " +
      "informado. Podés ejercer los derechos de acceso, rectificación y supresión.",
  },
  {
    jurisdiction: "CL",
    frameworkCode: "CL-L19628",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "De acuerdo con la Ley 19.628 sobre Protección de la Vida Privada, tus datos " +
      "personales de salud serán tratados de forma confidencial, previo " +
      "consentimiento explícito y para las finalidades propias del acompañamiento. " +
      "Tienes derecho a solicitar información, modificación y cancelación de tus datos.",
  },
  {
    jurisdiction: "DEFAULT",
    frameworkCode: "DEFAULT",
    termsVersion: DEFAULT_TERMS_VERSION,
    text:
      "No pudimos determinar un marco legal específico para tu ubicación, por lo que " +
      "aplicamos el estándar más conservador de protección de datos: tus mensajes y " +
      "datos de salud se tratan con la máxima confidencialidad, no se almacenan por " +
      "más del tiempo mínimo necesario y jamás se comparten sin tu consentimiento " +
      "explícito. Podés solicitar el borrado de tu información en cualquier momento.",
  },
];

/** Resolves the notice for a jurisdiction, falling back to the DEFAULT. */
export function noticeForJurisdiction(jurisdiction: string): PrivacyNotice {
  const known = PRIVACY_NOTICES.find(
    (notice) => notice.jurisdiction === jurisdiction
  );
  if (known !== undefined) {
    return known;
  }
  const fallback = PRIVACY_NOTICES.find(
    (notice) => notice.jurisdiction === "DEFAULT"
  );
  if (fallback === undefined) {
    throw new Error("PRIVACY_NOTICES is missing the DEFAULT framework");
  }
  return fallback;
}
