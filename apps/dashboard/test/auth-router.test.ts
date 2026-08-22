import { afterEach, describe, expect, it } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

import type { DashboardUser } from "@chatcap/db-schema";

import { createAuthRouter, type AuthDeps } from "../src/server/auth/auth-router";
import type { JwtConfig } from "../src/server/auth/jwt";
import { hashPassword } from "../src/server/auth/password";
import { signAccessToken } from "../src/server/auth/jwt";

/**
 * Auth endpoints (task 5.1, design §3.3): POST /auth/login exchanges
 * env-bootstrapped credentials for a 15-min JWT; GET /auth/me resolves the
 * current user. Wrong credentials and deleted subjects both fail with 401 —
 * never 500, never leaking which part was wrong.
 */

const JWT: JwtConfig = { secret: "j".repeat(32), ttlSeconds: 900 };
const ADMIN_ID = "00000000-0000-7000-8000-0000000000aa";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

async function startServer(deps: AuthDeps): Promise<string> {
  const app: Express = express();
  app.use(express.json());
  app.use(createAuthRouter(deps));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a bound TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function adminUser(): DashboardUser {
  return {
    id: ADMIN_ID,
    email: "admin@example.com",
    passwordHash: "precomputed",
    role: "admin",
    createdAt: "2026-08-13T00:00:00.000Z",
  };
}

function makeDeps(users: DashboardUser[] = [adminUser()]): AuthDeps {
  const byId = new Map(users.map((user) => [user.id, user]));
  const byEmail = new Map(users.map((user) => [user.email, user]));
  return {
    jwt: JWT,
    users: {
      async findByEmail(email) {
        return byEmail.get(email);
      },
      async findById(id) {
        return byId.get(id);
      },
    },
  };
}

describe("POST /auth/login", () => {
  it("returns a JWT + user for valid admin credentials", async () => {
    const hash = await hashPassword("s3cret-admin", 4);
    const baseUrl = await startServer(makeDeps([{ ...adminUser(), passwordHash: hash }]));

    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "s3cret-admin" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      token: string;
      expiresIn: number;
      user: { id: string; email: string; role: string };
    };
    expect(body.expiresIn).toBe(900);
    expect(body.user).toMatchObject({ id: ADMIN_ID, email: "admin@example.com", role: "admin" });
    expect(body.token.split(".")).toHaveLength(3);
  });

  it("rejects a wrong password with 401", async () => {
    const hash = await hashPassword("s3cret-admin", 4);
    const baseUrl = await startServer(makeDeps([{ ...adminUser(), passwordHash: hash }]));

    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "wrong" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("rejects an unknown email with 401 (same shape as wrong password)", async () => {
    const baseUrl = await startServer(makeDeps());

    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ghost@example.com", password: "whatever" }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("rejects a malformed body with 400", async () => {
    const baseUrl = await startServer(makeDeps());

    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_error" });
  });

  it("rejects a password when the stored hash is corrupted (401, not 500)", async () => {
    const baseUrl = await startServer(
      makeDeps([{ ...adminUser(), passwordHash: "garbage-hash" }])
    );

    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "anything" }),
    });

    expect(response.status).toBe(401);
  });
});

describe("GET /auth/me", () => {
  it("returns the current user for a valid token", async () => {
    const token = signAccessToken(JWT, { sub: ADMIN_ID, role: "admin" });
    const baseUrl = await startServer(makeDeps());

    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: ADMIN_ID,
      email: "admin@example.com",
      role: "admin",
    });
  });

  it("rejects a request without a token (401)", async () => {
    const baseUrl = await startServer(makeDeps());

    const response = await fetch(`${baseUrl}/auth/me`);
    expect(response.status).toBe(401);
  });

  it("rejects a token whose subject no longer exists (401)", async () => {
    const token = signAccessToken(JWT, { sub: ADMIN_ID, role: "admin" });
    const baseUrl = await startServer(makeDeps([]));

    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(401);
  });
});
