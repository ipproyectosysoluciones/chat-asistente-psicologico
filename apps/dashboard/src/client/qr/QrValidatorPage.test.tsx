// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QrValidatorPage } from "./QrValidatorPage";
import type { QrValidationResult } from "./api";

/**
 * QR validator page (task 5.7 frontend, REQ-KEY-7): mirrors
 * VectorSearchPage.test.tsx — stubs `global.fetch`, types the payload + hex
 * signature, clicks "Validar", and asserts the GET was sent with both params
 * URL-encoded plus the Bearer header, then the result badge text renders.
 */

const TOKEN = "jwt-token";

const VALID_PAYLOAD = JSON.stringify({
  v: 1,
  consentId: "consent-1",
  termsVersion: 1,
  keyVersion: 2,
  iat: 1_700_000_000,
});
const VALID_SIGNATURE = "deadbeef";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  result: QrValidationResult
): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(jsonResponse(200, { result }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QrValidatorPage", () => {
  it("sends a GET with both params URL-encoded and renders the Válido badge", async () => {
    const fetchMock = stubFetch({
      valid: true,
      reason: "signature_match",
      keyVersion: 2,
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<QrValidatorPage token={TOKEN} />);

    // The payload is JSON (contains `{`/`}`), so set the values via fireEvent
    // rather than userEvent.type (which treats `{` as special syntax).
    fireEvent.change(screen.getByLabelText(/Payload del QR/i), {
      target: { value: VALID_PAYLOAD },
    });
    fireEvent.change(screen.getByLabelText(/Firma del QR/i), {
      target: { value: VALID_SIGNATURE },
    });
    await user.click(screen.getByRole("button", { name: "Validar" }));

    const [calledUrl, options] = (await waitFor(() =>
      fetchMock.mock.calls[0]
    )) as [string, RequestInit];
    expect(calledUrl).toBe(
      `/api/v1/qr/validate?payload=${encodeURIComponent(VALID_PAYLOAD)}&signature=${encodeURIComponent(VALID_SIGNATURE)}`
    );
    expect(options.method).toBe("GET");
    expect(options.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });

    expect(await screen.findByText("Válido")).toBeInTheDocument();
    expect(screen.getByText("signature_match")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the Inválido badge for an invalid QR still returning 200", async () => {
    const fetchMock = stubFetch({
      valid: false,
      reason: "invalid_signature",
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<QrValidatorPage token={TOKEN} />);

    // The payload is JSON (contains `{`/`}`), so set the values via fireEvent
    // rather than userEvent.type (which treats `{` as special syntax).
    fireEvent.change(screen.getByLabelText(/Payload del QR/i), {
      target: { value: VALID_PAYLOAD },
    });
    fireEvent.change(screen.getByLabelText(/Firma del QR/i), {
      target: { value: VALID_SIGNATURE },
    });
    await user.click(screen.getByRole("button", { name: "Validar" }));

    expect(await screen.findByText("Inválido")).toBeInTheDocument();
    expect(screen.getByText("invalid_signature")).toBeInTheDocument();
  });
});
