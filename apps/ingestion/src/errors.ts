import type { ErrorCode } from "@chatcap/shared-types";

/**
 * RFC 7807 problem+json helpers (mirrors apps/notifications/src/errors.ts and
 * design §3.2). Ingestion is an internal service, but the dashboard and
 * supervisor endpoints still receive stable `code` values from shared-types.
 */

const PROBLEM_BASE = "https://api.chatcap.app/errors";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ErrorCode;
}

export { PROBLEM_BASE };

import type { Response } from "express";

export function problemResponse(res: Response, problem: ProblemDetails): void {
  res.status(problem.status).json({
    type: `${PROBLEM_BASE}/${problem.code}`,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    code: problem.code,
  });
}

export function notFoundHandler(_req: unknown, res: Response): void {
  problemResponse(res, {
    type: `${PROBLEM_BASE}/not_found`,
    title: "Not Found",
    status: 404,
    detail: "The requested resource does not exist.",
    code: "not_found",
  });
}
