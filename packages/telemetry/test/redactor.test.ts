import { describe, expect, it } from "vitest";

import {
  isPiiKey,
  redactPii,
  redactPiiObject,
  redactPiiValue,
} from "../src/redactor";

describe("redactor: phone patterns (REQ-ALERT-6, REQ-DASH-8)", () => {
  it("strips international E.164 phone with plus", () => {
    expect(redactPii("call +5491155551234 now")).toBe("call [PHONE] now");
  });

  it("strips international phone with spaces and dashes", () => {
    expect(redactPii("tel +54 9 11 5555-1234")).toBe("tel [PHONE]");
  });

  it("strips local phone formats", () => {
    expect(redactPii("mi numero es 11 5555-1234")).toBe("mi numero es [PHONE]");
    expect(redactPii("sos 5555-1234?")).toBe("sos [PHONE]?");
  });

  it("strips a bare 8-15 digit phone", () => {
    expect(redactPii("whatsapp: 5491155551234")).toBe("whatsapp: [PHONE]");
  });

  it("does not redact short numbers (years, counts)", () => {
    expect(redactPii("2026 in 10 days")).toBe("2026 in 10 days");
  });
});

describe("redactor: email patterns", () => {
  it("strips plain emails", () => {
    expect(redactPii("contact user@example.com pls")).toBe("contact [EMAIL] pls");
  });

  it("strips emails with dots and plus tags", () => {
    expect(redactPii("mail maria.lopez+tag@sub.example.co.ar")).toBe(
      "mail [EMAIL]"
    );
  });
});

describe("redactor: webhook payload keys (design §2.2)", () => {
  it("flags WhatsApp identity keys as PII", () => {
    for (const key of ["wa_id", "pushName", "notifyName", "phone_number", "from", "body", "text", "caption"]) {
      expect(isPiiKey(key)).toBe(true);
    }
  });

  it("keeps trace/entity id keys on the allowlist", () => {
    for (const key of ["traceId", "trace_id", "sessionId", "alertId", "jobId", "correlationId"]) {
      expect(isPiiKey(key)).toBe(false);
    }
  });

  it("redacts the whole value of a PII key", () => {
    expect(redactPiiValue("5491155551234", "wa_id")).toBe("[REDACTED]");
  });

  it("pattern-redacts values of allowed keys instead", () => {
    expect(redactPiiValue("trace-abc-5491155551234", "traceId")).toBe("trace-abc-[PHONE]");
  });
});

describe("redactor: object deep redaction", () => {
  it("redacts nested webhook payloads and preserves keys", () => {
    const webhook = {
      id: "msg-1",
      from: "5491155551234",
      text: { body: "hola, mi numero es 11 5555-1234" },
      metadata: { traceId: "trace-abc", pushName: "Maria" },
    };
    const result = redactPiiObject(webhook);
    expect(result).toEqual({
      id: "msg-1",
      from: "[REDACTED]",
      text: { body: "[REDACTED]" },
      metadata: { traceId: "trace-abc", pushName: "[REDACTED]" },
    });
  });

  it("does not mutate the input object", () => {
    const input = { from: "5491155551234", nested: { note: "x" } };
    const result = redactPiiObject(input);
    expect(result).not.toBe(input);
    expect(input.from).toBe("5491155551234");
    expect(result.from).toBe("[REDACTED]");
  });

  it("redacts emails inside nested arrays of strings", () => {
    const result = redactPiiObject({ list: ["a@b.com", "ok"] });
    expect(result.list).toEqual(["[EMAIL]", "ok"]);
  });
});
