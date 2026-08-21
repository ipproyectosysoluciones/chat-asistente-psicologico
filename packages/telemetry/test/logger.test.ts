import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger";

/** Collects pino JSON lines in memory (pino writes one JSON line per record). */
function collectDestination() {
  const lines: string[] = [];
  const destination = {
    write(chunk: string | Buffer) {
      lines.push(chunk.toString());
      return true;
    },
  };
  return { lines, destination };
}

function parseLogs(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function singleRecord(lines: string[]): Record<string, unknown> {
  const record = parseLogs(lines)[0];
  if (record === undefined) {
    throw new Error("expected at least one log line");
  }
  return record;
}

describe("logger: PII-stripped structured logging (AGENTS.md)", () => {
  it("emits valid JSON lines to the destination", () => {
    const { lines, destination } = collectDestination();
    const logger = createLogger({ level: "info", destination });
    logger.info("hello");
    expect(lines).toHaveLength(1);
    const record = singleRecord(lines);
    expect(record).toMatchObject({ level: 30, msg: "hello" });
    expect(record.time).toBeTypeOf("number");
  });

  it("redacts phone numbers in the message string", () => {
    const { lines, destination } = collectDestination();
    const logger = createLogger({ level: "info", destination });
    logger.info("incoming from +5491155551234");
    expect(singleRecord(lines).msg).toBe("incoming from [PHONE]");
  });

  it("redacts PII keys in the context object", () => {
    const { lines, destination } = collectDestination();
    const logger = createLogger({ level: "info", destination });
    logger.info("webhook received", {
      wa_id: "5491155551234",
      text: { body: "contenido privado" },
    });
    const record = singleRecord(lines);
    expect(record.wa_id).toBe("[REDACTED]");
    expect(record.text).toEqual({ body: "[REDACTED]" });
  });

  it("keeps allowlisted trace ids intact", () => {
    const { lines, destination } = collectDestination();
    const logger = createLogger({ level: "info", destination });
    logger.info("gate ok", { traceId: "trace-abc-123", gate: "pass" });
    const record = singleRecord(lines);
    expect(record.traceId).toBe("trace-abc-123");
    expect(record.gate).toBe("pass");
  });

  it("child loggers inherit redaction and bindings", () => {
    const { lines, destination } = collectDestination();
    const logger = createLogger({ level: "info", destination });
    const child = logger.child({ traceId: "trace-xyz", wa_id: "5491155551234" });
    child.info("child log");
    const record = singleRecord(lines);
    expect(record.traceId).toBe("trace-xyz");
    expect(record.wa_id).toBe("[REDACTED]");
    expect(record.msg).toBe("child log");
  });

  it("respects the configured level", () => {
    const { lines, destination } = collectDestination();
    const logger = createLogger({ level: "warn", destination });
    logger.debug("should be dropped");
    logger.warn("kept");
    const records = parseLogs(lines);
    expect(records).toHaveLength(1);
    expect(singleRecord(lines).msg).toBe("kept");
  });
});
