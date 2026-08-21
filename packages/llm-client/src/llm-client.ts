import { NLI_VERDICT, RISK_LEVEL, type NliResult, type NliVerdict, type RiskLevel } from "@chatcap/shared-types";

import { buildChatCompletionRequest, type ChatMessage } from "./requests";
import { FetchOpenAiTransport, type ChatTransport } from "./transport";

export type { ChatTransport } from "./transport";

export interface ChatReply {
  content: string;
}

export interface OpenAiClientOptions {
  openAiApiKey: string;
  chatModel: string;
  nliModel: string;
  embeddingModel: string;
}

/** Guard: a JSON object literal (non-null, non-array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Guard: a JSON string in one of a known set of literals — narrows to the union. */
function isOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  // Narrowed to `string` by the typeof check above; `as T` only asserts
  // membership, which `allowed.has` verifies at runtime.
  return typeof value === "string" && allowed.has(value as T);
}

const NLI_VALID: ReadonlySet<NliVerdict> = new Set(Object.values(NLI_VERDICT));
const RISK_VALID: ReadonlySet<RiskLevel> = new Set(Object.values(RISK_LEVEL));

function isConfidence(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

function parseNliContent(content: string): NliResult {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error("NLI model returned a non-object payload");
  }
  const { verdict, confidence } = parsed;
  if (!isOneOf(verdict, NLI_VALID)) {
    throw new Error(`NLI model returned an invalid verdict: ${String(verdict)}`);
  }
  if (!isConfidence(confidence)) {
    throw new Error(`NLI model returned an invalid confidence: ${String(confidence)}`);
  }
  return { verdict, confidence };
}

function parseRiskContent(content: string): RiskLevel {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error("Classifier returned a non-object payload");
  }
  const { risk } = parsed;
  if (!isOneOf(risk, RISK_VALID)) {
    throw new Error(`Classifier returned an invalid risk level: ${String(risk)}`);
  }
  return risk;
}

function parseEmbedding(data: unknown): number[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Embedding endpoint returned no embedding vector");
  }
  const first = data[0];
  const embedding = isRecord(first) ? first.embedding : undefined;
  if (!isEmbeddingVector(embedding)) {
    throw new Error("Embedding endpoint returned a malformed payload");
  }
  return embedding;
}

function parseChatContent(choices: unknown): string {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("Chat endpoint returned no choices");
  }
  const first = choices[0];
  const content = isRecord(first) ? first.message : undefined;
  const text = isRecord(content) ? content.content : undefined;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Chat endpoint returned an empty assistant message");
  }
  return text;
}

/**
 * OpenAI-compatible client for the RAG pipeline (REQ-RAG-1/5/7).
 *
 * - `chat` — main generation on the chat model, ALWAYS temperature 0.
 * - `nli` / `classify` — side-tasks on the NLI model (GPT-4o-mini class).
 * - `embed` — embeddings for pgvector retrieval.
 *
 * Models are read from validated config: swapping providers or models is a
 * configuration-only change (BuilderBot three-pillar contract).
 */
export class OpenAiClient {
  private readonly transport: ChatTransport;
  private readonly options: OpenAiClientOptions;

  private constructor(options: OpenAiClientOptions, transport: ChatTransport) {
    this.options = options;
    this.transport = transport;
  }

  static create(options: OpenAiClientOptions): OpenAiClient {
    return new OpenAiClient(options, new FetchOpenAiTransport({
      apiKey: options.openAiApiKey,
      baseUrl: "https://api.openai.com/v1",
    }));
  }

  /** Immutable wiring: returns a NEW client using the given transport. */
  withTransport(transport: ChatTransport): OpenAiClient {
    return new OpenAiClient(this.options, transport);
  }

  async chat(messages: ChatMessage[]): Promise<ChatReply> {
    const request = buildChatCompletionRequest({
      model: this.options.chatModel,
      messages,
    });
    const response = await this.transport.request<{ choices: unknown }>(
      "/chat/completions",
      request
    );
    return { content: parseChatContent(response.choices) };
  }

  /** NLI side-task: does the answer follow from the retrieved chunk? */
  async nli(answer: string, chunkText: string): Promise<NliResult> {
    const request = buildChatCompletionRequest({
      model: this.options.nliModel,
      messages: [
        {
          role: "system",
          content:
            "You are an NLI validator. Given a source text and an answer, " +
            'answer with JSON only: {"verdict":"entailment|neutral|contradiction","confidence":0-1}.',
        },
        { role: "user", content: `Source: ${chunkText}\nAnswer: ${answer}` },
      ],
    });
    const response = await this.transport.request<{ choices: unknown }>(
      "/chat/completions",
      request
    );
    return parseNliContent(parseChatContent(response.choices));
  }

  /** Risk classification side-task (red/orange/yellow/normal). */
  async classify(message: string): Promise<RiskLevel> {
    const request = buildChatCompletionRequest({
      model: this.options.nliModel,
      messages: [
        {
          role: "system",
          content:
            "You classify mental-health chat risk. Answer with JSON only: " +
            '{"risk":"red|orange|yellow|normal"}.',
        },
        { role: "user", content: message },
      ],
    });
    const response = await this.transport.request<{ choices: unknown }>(
      "/chat/completions",
      request
    );
    return parseRiskContent(parseChatContent(response.choices));
  }

  async embed(input: string): Promise<number[]> {
    const response = await this.transport.request<{ data: unknown }>("/embeddings", {
      model: this.options.embeddingModel,
      input,
    });
    return parseEmbedding(response.data);
  }
}
