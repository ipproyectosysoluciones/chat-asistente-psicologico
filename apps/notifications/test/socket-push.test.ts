import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";
import { Server } from "socket.io";
import { io as createClient, type Socket } from "socket.io-client";

import type { AlertPushPayload } from "../src/push-channel";
import {
  attachSupervisorRoom,
  SocketIoPushChannel,
  SUPERVISORS_ROOM,
} from "../src/socket-push";

/**
 * Socket.io push (task 2.3, REQ-ALERT-2): red alerts reach the supervisor
 * dashboard over Socket.io in under 1 second. The room is RBAC-gated — only
 * clients presenting a valid internal token on the handshake may join — and a
 * push is only considered delivered when at least one supervisor is connected
 * (zero connected supervisors is a delivery failure that triggers the
 * fallback).
 */

const SUPERVISOR_TOKEN = "supervisor-token";

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

interface Harness {
  httpServer: HttpServer;
  io: Server;
  url: string;
  clients: Socket[];
}

const harnesses: Harness[] = [];

function startHarness(): Harness {
  const httpServer = createServer();
  const io = new Server(httpServer, { cors: { origin: false } });
  attachSupervisorRoom(io, [SUPERVISOR_TOKEN]);
  httpServer.listen(0);
  const port = (httpServer.address() as AddressInfo).port;
  const harness: Harness = { httpServer, io, url: `http://127.0.0.1:${port}`, clients: [] };
  harnesses.push(harness);
  return harness;
}

async function connectClient(harness: Harness, token: string = SUPERVISOR_TOKEN): Promise<Socket> {
  const client = createClient(harness.url, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
    auth: { token },
  });
  harness.clients.push(client);
  await waitForEvent<void>(client, "connect");
  return client;
}

/** Typed once()-style helper (socket.io-client Socket is not a Node EventEmitter type). */
function waitForEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise<T>((resolve) => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await Promise.allSettled(harness.clients.map((client) => client.close()));
    // io.close() closes the attached http server itself (socket.io v4).
    await new Promise<void>((resolve) => harness.io.close(() => resolve()));
  }
});

describe("SocketIoPushChannel", () => {
  it("emits the alert event to every connected supervisor", async () => {
    const harness = startHarness();
    const first = await connectClient(harness);
    const second = await connectClient(harness);
    const channel = new SocketIoPushChannel(harness.io);

    const firstReceived = waitForEvent<AlertPushPayload>(first, "alert:event");
    const secondReceived = waitForEvent<AlertPushPayload>(second, "alert:event");
    const result = await channel.push(PAYLOAD);
    const [firstPayload, secondPayload] = await Promise.all([firstReceived, secondReceived]);

    expect(result).toEqual({ ok: true, deliveredTo: 2 });
    expect(firstPayload).toEqual(PAYLOAD);
    expect(secondPayload).toEqual(PAYLOAD);
  });

  it("fails the push when no supervisor is connected (triggers fallback)", async () => {
    const harness = startHarness();
    const channel = new SocketIoPushChannel(harness.io);

    const result = await channel.push(PAYLOAD);

    expect(result).toEqual({ ok: false, error: "no_supervisor_connected" });
  });

  it("reaches a connected supervisor in under 1 second (REQ-ALERT-2)", async () => {
    const harness = startHarness();
    const client = await connectClient(harness);
    const channel = new SocketIoPushChannel(harness.io);

    const started = performance.now();
    const received = waitForEvent<AlertPushPayload>(client, "alert:event");
    await channel.push(PAYLOAD);
    await received;
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("supervisor room auth (RBAC at the data boundary)", () => {
  it("rejects connections without a token and with a wrong token", async () => {
    const harness = startHarness();
    const anonymous = createClient(harness.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    const imposter = createClient(harness.url, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: { token: "wrong-token" },
    });
    harness.clients.push(anonymous, imposter);

    await Promise.all([
      waitForEvent<Error>(anonymous, "connect_error"),
      waitForEvent<Error>(imposter, "connect_error"),
    ]);

    const supervisors = await harness.io.in(SUPERVISORS_ROOM).fetchSockets();
    expect(supervisors).toHaveLength(0);
  });

  it("lets a valid internal token through and join the supervisors room", async () => {
    const harness = startHarness();
    const client = await connectClient(harness, SUPERVISOR_TOKEN);

    const supervisors = await harness.io.in(SUPERVISORS_ROOM).fetchSockets();
    expect(supervisors).toHaveLength(1);
    expect(supervisors[0]?.id).toBe(client.id);
  });
});
