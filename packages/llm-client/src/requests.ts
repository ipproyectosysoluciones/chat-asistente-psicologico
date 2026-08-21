export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  /**
   * REQ-RAG-1: generation MUST be at temperature 0. Anything else is a
   * policy violation — fail loudly rather than silently degrading.
   */
  temperature?: number;
}

/**
 * Raised when a caller attempts a non-zero temperature. Exported as an error
 * TYPE so service boundaries can discriminate it from upstream failures.
 */
export class TemperaturePolicyError extends Error {
  constructor(model: string, temperature: number) {
    super(
      `Temperature policy violation: model "${model}" must be generated at ` +
        `temperature 0, got ${temperature} (REQ-RAG-1)`
    );
    this.name = "TemperaturePolicyError";
  }
}

export function buildChatCompletionRequest(
  options: ChatCompletionOptions
): ChatCompletionRequest {
  const temperature = options.temperature ?? 0;
  if (temperature !== 0) {
    throw new TemperaturePolicyError(options.model, temperature);
  }
  return {
    model: options.model,
    messages: options.messages,
    temperature,
  };
}
