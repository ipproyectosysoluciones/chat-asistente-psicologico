import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { HttpFallbackChannel } from "../src/http-fallback";
import type { AlertPushPayload } from "../src/push-channel";

/**
 * HTTP fallback channel (task 2.3, REQ-ALERT-4): when the Socket.io push
 * cannot be confirmed, the PII-stripped payload is POSTed to a configured
 * fallback endpoint (Telegram bot API or internal webhook). Non-2xx responses
 * and network errors are delivery failures.
 */

const PAYLOAD: AlertPushPayload = {
  alertId: "alert-1",
  level: "red",
  category: "suicide",
  sessionId: "sess-1",
  status: "open",
  dedupeKey: "a".repeat(64),
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  eventKind: "created",
};

interface CapturedRequest {
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const targets: HttpServer[] = [];

function startTarget(statusCode: number): { url: string; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      captured.push({ method: req.method, headers: req.headers, body: raw });
      res.writeHead(statusCode);
      res.end();
    });
  });
  server.listen(0);
  targets.push(server);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/alert`, captured };
}

afterEach(async () => {
  for (const server of targets.splice(0)) {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

describe("HttpFallbackChannel", () => {
  it("POSTs the PII-stripped payload as JSON and resolves ok on 2xx", async () => {
    const { url, captured } = startTarget(204);
    const channel = new HttpFallbackChannel(url);

    const result = await channel.push(PAYLOAD);

    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (request === undefined) {
      throw new Error("expected the fallback request to be captured");
    }
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(request.body)).toEqual(PAYLOAD);
    // The wire body must not contain crisis keywords, message text or contacts.
    const serialized = JSON.stringify(PAYLOAD);
    for (const forbidden of ["keyword", "message", "phone", "contact"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("fails the push on a non-2xx response", async () => {
    const { url } = startTarget(500);
    const channel = new HttpFallbackChannel(url);

    const result = await channel.push(PAYLOAD);

    expect(result).toEqual({ ok: false, error: "http_error_500" });
  });

  it("fails the push when the endpoint is unreachable", async () => {
    const channel = new HttpFallbackChannel("http://127.0.0.1:1/alert", { timeoutMs: 500 });

    const result = await channel.push(PAYLOAD);

    expect(result).toEqual({ ok: false, error: "unreachable" });
  });
});
