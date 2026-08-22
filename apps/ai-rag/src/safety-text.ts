/**
 * Fixed safe-response texts (task 3.4/3.5). These are the ONLY strings that
 * bypass the coherence gate — they are policy, not model output:
 * - STANDARD_MEDICATION_REFUSAL: REQ-RAG-9 medication standard-refusal.
 * - SAFE_FALLBACK_BLOCKED: role-deviation / low-coherence (orange block).
 * - SAFE_FALLBACK_FLAGGED: yellow flag awaiting supervisor review.
 * - CRISIS_BASE_RESPONSE: red-level vital risk; the chat-bot appends local
 *   help lines by geolocation (design §2.2).
 * Keep them free of drug names, doses and any clinical guidance.
 */

/** REQ-RAG-9: standard refusal for medication/dosage queries. */
export const STANDARD_MEDICATION_REFUSAL =
  "No puedo recomendar dosis ni indicar medicación. Si necesitas orientación " +
  "sobre un tratamiento, te recomiendo consultar con un profesional de la salud.";

/** Neutral fallback when the coherence gate blocks the answer (orange). */
export const SAFE_FALLBACK_BLOCKED =
  "No tengo una respuesta suficientemente respaldada para esto. Te " +
  "recomiendo consultar con un profesional de la salud.";

/** Neutral fallback for yellow-flagged answers (supervisor review pending). */
export const SAFE_FALLBACK_FLAGGED =
  "Tu consulta fue derivada a revisión. Mientras tanto, te recomiendo cuidar " +
  "tu bienestar y buscar apoyo si lo necesitas.";

/** Red-level crisis base response; the chat-bot appends local hotlines. */
export const CRISIS_BASE_RESPONSE =
  "Estás pasando por un momento muy difícil y tu seguridad es lo más " +
  "importante. Por favor, comunícate ahora mismo con una línea de ayuda local.";
