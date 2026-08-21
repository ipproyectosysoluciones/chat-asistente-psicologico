// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatDetailPage } from "./ChatDetailPage";

/**
 * Dual chat view (task 5.2 frontend, REQ-DASH-2/9): messages + RAG context
 * side by side, alert banner, loading/error-with-retry states. Encrypted
 * messages render as such — the dashboard never carries decryption keys.
 */

const SESSION_ID = "11111111-1111-7111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunkFixture(): Record<string, unknown> {
  return {
    chunkId: "chunk-1",
    docId: "doc-1",
    chunkIndex: 0,
    content: "Técnica de respiración diafragmática.",
    category: "clinical",
    source: "protocolo-ansiedad",
    language: "es",
    legalFramework: "COL-1581",
    score: 0.87,
  };
}

function detailBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    session: {
      id: SESSION_ID,
      contactKeyAnon: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      jurisdiction: "CO",
      persistenceClass: "anonymous",
      consentState: "notice_shown",
      aiState: "auto",
      createdAt: "2026-08-14T08:00:00.000Z",
      lastActivityAt: "2026-08-14T12:00:00.000Z",
    },
    messages: [
      {
        id: "m-1",
        sessionId: SESSION_ID,
        sender: "user",
        text: "Me siento muy ansioso",
        encrypted: false,
        createdAt: "2026-08-14T12:00:00.000Z",
      },
      {
        id: "m-2",
        sessionId: SESSION_ID,
        sender: "bot",
        text: "Entiendo. ¿Quieres practicar una técnica de respiración?",
        encrypted: false,
        createdAt: "2026-08-14T12:01:00.000Z",
      },
    ],
    ragTraces: [
      {
        traceId: "tr-1",
        sessionId: SESSION_ID,
        risk: "orange",
        classification: { model: "gpt-4o-mini", risk: "orange", confidence: 0.91 },
        retrieval: {
          model: "text-embedding-3-small",
          topK: 3,
          hnsw: { efSearch: 40 },
          chunks: [chunkFixture()],
        },
        generation: { model: "gpt-4o", temperature: 0 },
        gate: {
          verdict: "orange_block",
          cosine: 0.83,
          nli: { verdict: "entailment", confidence: 0.9 },
          guardrail: { level: "orange", deviationTerms: ["suicidio"], blocked: true },
          chunks: [chunkFixture()],
        },
        emitted: false,
        createdAt: "2026-08-14T12:02:00.000Z",
      },
    ],
    alertLevel: "orange",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatDetailPage", () => {
  it("renders the messages and the RAG context side by side", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, detailBody())));

    render(<ChatDetailPage token="jwt-token" sessionId={SESSION_ID} onBack={vi.fn()} />);

    expect(screen.getByText(/Cargando conversación/)).toBeInTheDocument();
    expect(await screen.findByText("Me siento muy ansioso")).toBeInTheDocument();
    expect(screen.getByText("Entiendo. ¿Quieres practicar una técnica de respiración?")).toBeInTheDocument();
    expect(screen.getByText("Contexto RAG")).toBeInTheDocument();
    expect(screen.getByText("Respuesta bloqueada")).toBeInTheDocument();
    expect(screen.getByText("suicidio")).toBeInTheDocument();
    expect(screen.getByText("Técnica de respiración diafragmática.")).toBeInTheDocument();
    expect(screen.getByText(/protocolo-ansiedad/)).toBeInTheDocument();
  });

  it("shows the alert banner when an alert is open", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, detailBody())));

    render(<ChatDetailPage token="jwt-token" sessionId={SESSION_ID} onBack={vi.fn()} />);

    expect(await screen.findByText(/Alerta activa/)).toHaveTextContent("orange");
  });

  it("marks encrypted messages as not visible in the panel", async () => {
    const body = detailBody();
    (body.messages as Record<string, unknown>[])[1] = {
      id: "m-2",
      sessionId: SESSION_ID,
      sender: "bot",
      encrypted: true,
      createdAt: "2026-08-14T12:01:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));

    render(<ChatDetailPage token="jwt-token" sessionId={SESSION_ID} onBack={vi.fn()} />);

    expect(await screen.findByText(/Mensaje cifrado/)).toBeInTheDocument();
  });

  it("shows an error state with retry that recovers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(404, {
          type: "https://api.chatcap.app/errors/not_found",
          title: "Not Found",
          status: 404,
          detail: "The chat session does not exist.",
          code: "not_found",
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, detailBody()));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<ChatDetailPage token="jwt-token" sessionId={SESSION_ID} onBack={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The chat session does not exist."
    );
    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(await screen.findByText("Me siento muy ansioso")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("calls onBack when the back button is pressed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, detailBody())));
    const onBack = vi.fn();
    const user = userEvent.setup();

    render(<ChatDetailPage token="jwt-token" sessionId={SESSION_ID} onBack={onBack} />);

    await screen.findByText("Me siento muy ansioso");
    await user.click(screen.getByRole("button", { name: /Volver/ }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
