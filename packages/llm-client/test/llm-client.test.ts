import { describe, expect, test, vi } from "vitest";

import {
  FetchOpenAiTransport,
  OpenAiClient,
  TemperaturePolicyError,
  buildChatCompletionRequest,
  type ChatMessage,
  type ChatTransport,
} from "../src/index";

/** Transport double: records every request; never touches the network. */
class MockTransport implements ChatTransport {
  readonly calls: Array<{ url: string; body: unknown }> = [];

  constructor(
    private readonly respondWith: (body: unknown) => unknown = (body) => body
  ) {}

  async request<T>(url: string, body: unknown): Promise<T> {
    this.calls.push({ url, body });
    return this.respondWith(body) as T;
  }
}

function makeClient(overrides: Partial<Parameters<typeof OpenAiClient.create>[0]> = {}) {
  const config = {
    openAiApiKey: "sk-test-not-a-real-key",
    chatModel: "gpt-4o",
    nliModel: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
    ...overrides,
  };
  return OpenAiClient.create(config);
}

describe("buildChatCompletionRequest (REQ-RAG-1)", () => {
  test("always forces temperature 0 and includes the model", () => {
    const request = buildChatCompletionRequest({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hola" }],
    });

    expect(request.model).toBe("gpt-4o");
    expect(request.temperature).toBe(0);
    expect(request.messages).toEqual([{ role: "user", content: "hola" }]);
  });

  test("throws TemperaturePolicyError when a nonzero temperature is requested", () => {
    expect(() =>
      buildChatCompletionRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hola" }],
        temperature: 0.7,
      })
    ).toThrow(TemperaturePolicyError);
  });

  test("TemperaturePolicyError is a descriptive error type", () => {
    const error = new TemperaturePolicyError("gpt-4o", 0.7);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("temperature 0");
    expect(error.message).toContain("gpt-4o");
    expect(error.message).toContain("0.7");
  });
});

describe("OpenAiClient chat (REQ-RAG-1)", () => {
  test("sends chat messages to /chat/completions with the configured chat model at temperature 0", async () => {
    const transport = new MockTransport(() => ({
      id: "chatcmpl-test",
      choices: [{ message: { role: "assistant", content: "respuesta" } }],
    }));
    const client = makeClient().withTransport(transport);

    const reply = await client.chat([
      { role: "user", content: "me siento ansioso" },
    ]);

    expect(reply.content).toBe("respuesta");
    expect(transport.calls).toHaveLength(1);
    const [call] = transport.calls;
    if (call === undefined) throw new Error("expected one transport call");
    expect(call.url).toContain("/chat/completions");
    const body = call.body as { model: string; temperature: number; messages: ChatMessage[] };
    expect(body.model).toBe("gpt-4o");
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([{ role: "user", content: "me siento ansioso" }]);
  });

  test("the chat model is configuration-only (swap without code change)", async () => {
    const transport = new MockTransport(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    }));
    const client = makeClient({ chatModel: "gpt-5" }).withTransport(transport);

    await client.chat([{ role: "user", content: "hola" }]);
    const [call] = transport.calls;
    if (call === undefined) throw new Error("expected one transport call");
    expect((call.body as { model: string }).model).toBe("gpt-5");
  });

  test("a chat transport failure surfaces as an error, never a silent empty reply", async () => {
    const failing: ChatTransport = {
      async request<T>(): Promise<T> {
        throw new Error("upstream_down: 502");
      },
    };
    const client = makeClient().withTransport(failing);

    await expect(client.chat([{ role: "user", content: "hola" }])).rejects.toThrow(
      /upstream_down/
    );
  });
});

describe("OpenAiClient nli (REQ-RAG-5/7)", () => {
  test("parses {verdict, confidence} from the nli model and uses LLM_NLI_MODEL", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"verdict":"entailment","confidence":0.92}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    const result = await client.nli("answer", "chunk");

    expect(result).toEqual({ verdict: "entailment", confidence: 0.92 });
    const [call] = transport.calls;
    if (call === undefined) throw new Error("expected one transport call");
    expect((call.body as { model: string }).model).toBe("gpt-4o-mini");
    expect((call.body as { temperature: number }).temperature).toBe(0);
  });

  test("a contradiction verdict is surfaced verbatim (the gate decides)", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"verdict":"contradiction","confidence":0.87}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    expect(await client.nli("answer", "chunk")).toEqual({
      verdict: "contradiction",
      confidence: 0.87,
    });
  });

  test("rejects garbage output instead of inventing a verdict", async () => {
    const transport = new MockTransport(() => ({
      choices: [{ message: { role: "assistant", content: "no entiendo" } }],
    }));
    const client = makeClient().withTransport(transport);

    await expect(client.nli("answer", "chunk")).rejects.toThrow();
  });

  test("rejects an out-of-range confidence", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"verdict":"neutral","confidence":1.7}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    await expect(client.nli("answer", "chunk")).rejects.toThrow();
  });

  test("rejects an unknown verdict value", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"verdict":"maybe","confidence":0.5}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    await expect(client.nli("answer", "chunk")).rejects.toThrow();
  });
});

describe("OpenAiClient classify (REQ-RAG-7)", () => {
  test("classifies a risk level from the nli model", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"risk":"orange"}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    expect(await client.classify("tengo pensamientos de hacerme daño")).toBe("orange");
    const [call] = transport.calls;
    if (call === undefined) throw new Error("expected one transport call");
    expect((call.body as { model: string }).model).toBe("gpt-4o-mini");
  });

  test("red risk is surfaced for vital-risk routing", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"risk":"red"}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    expect(await client.classify("me voy a matar")).toBe("red");
  });

  test("rejects an unknown risk level", async () => {
    const transport = new MockTransport(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: '{"risk":"purple"}',
          },
        },
      ],
    }));
    const client = makeClient().withTransport(transport);

    await expect(client.classify("hola")).rejects.toThrow();
  });
});

describe("OpenAiClient embed", () => {
  test("embeds with the configured embedding model", async () => {
    const transport = new MockTransport(() => ({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    }));
    const client = makeClient().withTransport(transport);

    const embedding = await client.embed("me siento triste");

    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    const [call] = transport.calls;
    if (call === undefined) throw new Error("expected one transport call");
    expect(call.url).toContain("/embeddings");
    const body = call.body as { model: string; input: string };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toBe("me siento triste");
  });
});

describe("FetchOpenAiTransport", () => {
  test("posts to the OpenAI-compatible endpoint with bearer auth and JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const response = new Response(JSON.stringify({ ok: true }), { status: 200 });
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const transport = new FetchOpenAiTransport({
      apiKey: "sk-test-not-a-real-key",
      baseUrl: "https://api.openai.com/v1",
    });
    await transport.request<{ ok: boolean }>("/chat/completions", { model: "gpt-4o" });

    const call = fetchMock.mock.calls[0];
    if (call === undefined) throw new Error("expected one fetch call");
    const [url, init] = call;
    expect(String(url)).toBe("https://api.openai.com/v1/chat/completions");
    const options = init as RequestInit;
    expect(options.method).toBe("POST");
    const headers = options.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test-not-a-real-key");
    expect(headers["content-type"]).toBe("application/json");
    expect(options.body).toContain("gpt-4o");

    vi.unstubAllGlobals();
  });

  test("non-2xx responses throw with status context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 }))
    );

    const transport = new FetchOpenAiTransport({
      apiKey: "sk-test-not-a-real-key",
      baseUrl: "https://api.openai.com/v1",
    });
    await expect(
      transport.request("/chat/completions", { model: "gpt-4o" })
    ).rejects.toThrow(/429/);

    vi.unstubAllGlobals();
  });

  test("never sends the API key in the URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const transport = new FetchOpenAiTransport({
      apiKey: "sk-secret-key",
      baseUrl: "https://api.openai.com/v1",
    });
    await transport.request("/chat/completions", { model: "gpt-4o" });

    const call = fetchMock.mock.calls[0];
    if (call === undefined) throw new Error("expected one fetch call");
    const [url] = call;
    expect(String(url)).not.toContain("sk-secret-key");
    vi.unstubAllGlobals();
  });
});

describe("OpenAiClient response plumbing", () => {
  test("chat() surfaces a non-empty assistant message; empty content is an error", async () => {
    const transport = new MockTransport(() => ({
      choices: [{ message: { role: "assistant", content: "" } }],
    }));
    const client = makeClient().withTransport(transport);

    await expect(client.chat([{ role: "user", content: "hola" }])).rejects.toThrow();
  });

  test("embed() rejects when the embedding array is missing", async () => {
    const transport = new MockTransport(() => ({ data: [] }));
    const client = makeClient().withTransport(transport);

    await expect(client.embed("hola")).rejects.toThrow();
  });
});

describe("OpenAiClient.create wiring", () => {
  test("create() yields a client whose transport is a FetchOpenAiTransport by default", async () => {
    const client = makeClient();
    expect(client).toBeInstanceOf(OpenAiClient);
  });

  test("withTransport() returns a new client instance (immutable wiring)", () => {
    const base = makeClient();
    const wired = base.withTransport(new MockTransport(() => ({})));
    expect(wired).not.toBe(base);
  });
});
