import { pino, type Logger as PinoLogger } from "pino";

import { isRecord, redactPii, redactPiiObject } from "./redactor";

/**
 * Structured JSON logger (pino) with an unconditional PII-stripping wrapper
 * (design §2.2: logs shipped to stdout for Docker; REQ-ALERT-6/REQ-DASH-8:
 * no PII in log payloads). Every message and context object passes through the
 * redactor before pino sees it, so a developer cannot forget a serializer.
 *
 * The `Logger` interface is structural: services depend on it, never on pino.
 */

export interface LoggerOptions {
  level?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  /** Test hook: custom pino destination (defaults to stdout). */
  destination?: { write(chunk: string | Buffer): unknown };
}

export interface Logger {
  fatal(msg: string, context?: unknown): void;
  error(msg: string, context?: unknown): void;
  warn(msg: string, context?: unknown): void;
  info(msg: string, context?: unknown): void;
  debug(msg: string, context?: unknown): void;
  trace(msg: string, context?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
  readonly level: string;
}

type PinoLevelMethod = (obj: unknown, msg?: string, ...args: unknown[]) => void;

class RedactingLogger implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  fatal(msg: string, context?: unknown): void {
    this.emit(this.pino.fatal.bind(this.pino), msg, context);
  }

  error(msg: string, context?: unknown): void {
    this.emit(this.pino.error.bind(this.pino), msg, context);
  }

  warn(msg: string, context?: unknown): void {
    this.emit(this.pino.warn.bind(this.pino), msg, context);
  }

  info(msg: string, context?: unknown): void {
    this.emit(this.pino.info.bind(this.pino), msg, context);
  }

  debug(msg: string, context?: unknown): void {
    this.emit(this.pino.debug.bind(this.pino), msg, context);
  }

  trace(msg: string, context?: unknown): void {
    this.emit(this.pino.trace.bind(this.pino), msg, context);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new RedactingLogger(this.pino.child(redactPiiObject(bindings)));
  }

  get level(): string {
    return this.pino.level;
  }

  /** pino merges the FIRST argument when it is an object. */
  private emit(
    method: PinoLevelMethod,
    msg: string,
    context?: unknown
  ): void {
    const safeMsg = redactPii(msg);
    if (context === undefined) {
      method(safeMsg);
      return;
    }
    if (isRecord(context)) {
      method(redactPiiObject(context), safeMsg);
      return;
    }
    method({ context: redactPii(String(context)) }, safeMsg);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  // `options.destination` is structurally a pino destination stream
  // (write(chunk) => void-compatible), so no cast is needed.
  const pinoLogger: PinoLogger = pino(
    { level: options.level ?? "info" },
    options.destination
  );
  return new RedactingLogger(pinoLogger);
}
