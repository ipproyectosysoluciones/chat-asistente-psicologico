import type { AlertPushPayload, PushChannel, PushResult } from "./push-channel";

/**
 * HTTP fallback push channel (task 2.3, REQ-ALERT-4): POSTs the PII-stripped
 * alert payload to a configured endpoint (Telegram bot API or internal
 * webhook) when the Socket.io push cannot be confirmed. Non-2xx responses and
 * network errors are delivery failures. The fallback is config-only in the
 * pilot (`FALLBACK_PUSH_URL`); no provider SDK is coupled here.
 */

export interface HttpFallbackOptions {
  timeoutMs?: number;
}

export class HttpFallbackChannel implements PushChannel {
  readonly name = "http-fallback";

  constructor(
    private readonly url: string,
    private readonly options: HttpFallbackOptions = {}
  ) {}

  async push(payload: AlertPushPayload): Promise<PushResult> {
    const timeoutMs = this.options.timeoutMs ?? 3_000;
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        return { ok: false, error: `http_error_${response.status}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: "unreachable" };
    }
  }
}
