import type { Request, Response } from "express";

import type { ErrorCode } from "@chatcap/shared-types";

/**
 * RFC 7807 problem+json helpers (design §3.2). Stable `code` values live in
 * shared-types ERROR_CODE; consumers match on them, so they never change.
 * Unlike notifications, the ai-rag router sends the proper
 * `application/problem+json` media type (task 3.1 AC: "RFC 7807
 * problem+json (application/problem+json)").
 */

const PROBLEM_BASE = "https://api.chatcap.app/errors";

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
  res.type("application/problem+json").status(problem.status).json(body);
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

/**
 * Thrown when an upstream dependency (OpenAI or pgvector) is degraded or
 * unreachable. The router maps it to 502 `upstream_failed` so the chat-bot
 * can distinguish "try again later" from a bug. Never carries user content.
 */
export class UpstreamDependencyError extends Error {
  readonly code = "UPSTREAM_DEPENDENCY_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "UpstreamDependencyError";
  }
}
