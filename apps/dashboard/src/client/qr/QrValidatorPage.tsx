"use client";

import { useState, type JSX } from "react";

import {
  fetchQrValidation,
  qrErrorMessage,
  type QrValidationResult,
} from "./api";

/**
 * QR validator page (task 5.7 frontend, REQ-KEY-7): supervisor enters the QR
 * payload (JSON) and its hex signature, then probes /api/v1/qr/validate and
 * renders a Válido/Inválido badge with the reason + key version. No payload or
 * signature content is ever logged (AGENTS.md, clinical data). A failed probe
 * (auth/transport) surfaces the RFC 7807 detail as an error notice.
 */

type PageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "result"; result: QrValidationResult }
  | { status: "error"; message: string };

export interface QrValidatorPageProps {
  token: string;
}

export function QrValidatorPage({ token }: QrValidatorPageProps): JSX.Element {
  const [payload, setPayload] = useState("");
  const [signature, setSignature] = useState("");
  const [state, setState] = useState<PageState>({ status: "idle" });

  async function handleValidate(): Promise<void> {
    if (payload.trim().length === 0 || signature.trim().length === 0) {
      setState({ status: "error", message: "Complete el payload y la firma." });
      return;
    }
    setState({ status: "loading" });
    try {
      const result = await fetchQrValidation(token, payload, signature);
      setState({ status: "result", result });
    } catch (caught: unknown) {
      setState({ status: "error", message: qrErrorMessage(caught) });
    }
  }

  return (
    <section className="qr-validator" aria-label="Validador de QR">
      <h2>Validador de QR</h2>

      <label htmlFor="qr-payload">Payload del QR (JSON)</label>
      <textarea
        id="qr-payload"
        value={payload}
        onChange={(event) => setPayload(event.target.value)}
        rows={5}
        placeholder='{"v":1,"consentId":"...","termsVersion":1,"keyVersion":1,"iat":0}'
        aria-label="Payload del QR en formato JSON"
      />

      <label htmlFor="qr-signature">Firma (hex)</label>
      <input
        id="qr-signature"
        type="text"
        value={signature}
        onChange={(event) => setSignature(event.target.value)}
        placeholder="firma hexadecimal"
        aria-label="Firma del QR en hexadecimal"
      />

      <button type="button" onClick={() => void handleValidate()}>
        Validar
      </button>

      {state.status === "loading" && (
        <p className="qr-validator__status" aria-live="polite">
          Validando…
        </p>
      )}

      {state.status === "error" && (
        <p className="qr-validator__error" role="alert">
          {state.message}
        </p>
      )}

      {state.status === "result" && (
        <div className="qr-validator__result" role="status" aria-live="polite">
          <span
            className={
              state.result.valid
                ? "qr-validator__badge qr-validator__badge--valid"
                : "qr-validator__badge qr-validator__badge--invalid"
            }
          >
            {state.result.valid ? "Válido" : "Inválido"}
          </span>
          <dl className="qr-validator__details">
            <dt>Motivo</dt>
            <dd>{state.result.reason}</dd>
            {state.result.keyVersion !== undefined && (
              <>
                <dt>Versión de clave</dt>
                <dd>{state.result.keyVersion}</dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  );
}
