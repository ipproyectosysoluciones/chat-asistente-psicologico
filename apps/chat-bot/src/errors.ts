import type { Request, Response } from "express";

import type { ErrorCode } from "@chatcap/shared-types";

/**
 * RFC 7807 problem+json helpers (design §3.2), mirroring the ai-rag service.
 * Stable `code` values live in shared-types ERROR_CODE.
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
