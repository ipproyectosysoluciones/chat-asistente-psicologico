import { Router } from "express";
import { z } from "zod";

import type { DashboardUser } from "@chatcap/db-schema";

import { PROBLEM_BASE, problemResponse } from "../errors";
import { signAccessToken, type JwtConfig } from "./jwt";
import { verifyPassword } from "./password";
import { createAuthenticate } from "./middleware";

/**
 * Auth router (task 5.1, design §3.3): POST /auth/login and GET /auth/me.
 * Credentials are the env-bootstrapped admin/supervisor users seeded by
 * admin-bootstrap. Both failure modes (wrong password / unknown email) answer
 * 401 with the same body — no account enumeration.
 */

export interface AuthUsers {
  findByEmail(email: string): Promise<DashboardUser | undefined>;
  findById(id: string): Promise<DashboardUser | undefined>;
}

export interface AuthDeps {
  jwt: JwtConfig;
  users: AuthUsers;
}

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

export function createAuthRouter(deps: AuthDeps): Router {
  const router = Router();
  const authenticate = createAuthenticate({
    jwt: deps.jwt,
    findUserById: async (id) => {
      const user = await deps.users.findById(id);
      if (user === undefined) {
        return null;
      }
      return { id: user.id, role: user.role };
    },
  });

  router.post("/auth/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/validation_error`,
        title: "Validation Error",
        status: 400,
        detail: "Email and password are required.",
        code: "validation_error",
      });
      return;
    }

    const user = await deps.users.findByEmail(parsed.data.email);
    if (user === undefined || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Invalid credentials.",
        code: "unauthorized",
      });
      return;
    }

    const token = signAccessToken(deps.jwt, { sub: user.id, role: user.role });
    res.status(200).json({
      token,
      expiresIn: deps.jwt.ttlSeconds,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });

  router.get("/auth/me", authenticate, async (req, res) => {
    const principal = req.principal;
    if (principal === undefined) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Authentication required.",
        code: "unauthorized",
      });
      return;
    }
    const user = await deps.users.findById(principal.userId);
    if (user === undefined) {
      problemResponse(res, {
        type: `${PROBLEM_BASE}/unauthorized`,
        title: "Unauthorized",
        status: 401,
        detail: "Account no longer active.",
        code: "unauthorized",
      });
      return;
    }
    res.status(200).json({ id: user.id, email: user.email, role: user.role });
  });

  return router;
}
