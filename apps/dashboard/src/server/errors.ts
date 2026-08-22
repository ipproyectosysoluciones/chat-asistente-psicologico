import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

import type { ErrorCode } from "@chatcap/shared-types";
import type { Logger } from "@chatcap/telemetry";

/**
 * RFC 7807 problem+json helpers (design §3.2). Stable `code` values live in
 * shared-types ERROR_CODE — consumers match on them, so they never change.
 * `AppError` lets service code throw a precise status/code that the app-level
 * errorHandler turns into a problem+json body.
 */

export const PROBLEM_BASE = "https://api.chatcap.app/errors";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  traceId?: string;
  code: ErrorCode;
}

export function problemResponse(res: Response, problem: ProblemDetails): void {
  const body: Record<string, unknown> = {
    type: `${PROBLEM_BASE}/${problem.code}`,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    code: problem.code,
  };
  if (problem.instance !== undefined) {
    body.instance = problem.instance;
  }
  if (problem.traceId !== undefined) {
    body.trace_id = problem.traceId;
  }
  res.status(problem.status).json(body);
}

export function notFoundHandler(_req: Request, res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/not_found`,
    title: "Not Found",
    status: 404,
    detail: "The requested resource does not exist.",
    code: "not_found",
  });
}

/** Service-level error: throw it, the errorHandler maps it to problem+json. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string;

  constructor(input: {
    status: number;
    code: ErrorCode;
    title: string;
    detail: string;
  }) {
    super(input.title);
    this.name = "AppError";
    this.status = input.status;
    this.code = input.code;
    this.detail = input.detail;
  }
}

/**
 * Express error middleware (last in the chain). AppErrors become precise
 * problem+json bodies; anything else is a generic 500 with no internals leaked
 * (design §3.2 error model). Unexpected errors are logged with the full error
 * object — never the request body or headers (PII-safe).
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof AppError) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/${error.code}`,
        title: error.message,
        status: error.status,
        detail: error.detail,
        code: error.code,
      });
      return;
    }
    logger.error("unhandled error", error);
    problemResponse(res, {
      type: `${PROBLEM_BASE}/internal_error`,
      title: "Internal Server Error",
      status: 500,
      detail: "An unexpected error occurred.",
      code: "internal_error",
    });
  };
}

/**
 * Async route handler wrapper: express 5 already forwards rejected promises
 * to the error middleware, so this exists only to keep handler signatures
 * explicit and uniform across the routers.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}
