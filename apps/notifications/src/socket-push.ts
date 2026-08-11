import { createHash, timingSafeEqual } from "node:crypto";

import type { Server } from "socket.io";

import type { AlertPushPayload, PushChannel, PushResult } from "./push-channel";

/**
 * Socket.io push channel (task 2.3, REQ-ALERT-2): emits the alert event to the
 * `supervisors` room. Delivery is only confirmed when at least one supervisor
 * is connected — zero connected supervisors is a failure so the pusher can
 * fall back (REQ-ALERT-4: escalation must not depend on any single channel).
 *
 * The room is RBAC-gated: only clients that present one of the service's
 * internal tokens (`X_INTERNAL_TOKENS`) on the handshake are allowed to join.
 * Every connected supervisor receives the PII-stripped alert payload — no
 * keyword, no message content, no contact data.
 */

export const SUPERVISORS_ROOM = "supervisors";
export const ALERT_EVENT = "alert:event";

/** Constant-time token comparison (sha256 both sides to hide length). */
function tokensEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Attaches the supervisors room with an authentication gate: the handshake
 * must carry `auth.token` matching one of the internal tokens, otherwise the
 * connection is rejected before it can join (RBAC at the data boundary).
 */
export function attachSupervisorRoom(io: Server, internalTokens: readonly string[]): void {
  io.use((socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token === "string" && internalTokens.some((expected) => tokensEqual(token, expected))) {
      next();
      return;
    }
    next(new Error("unauthorized"));
  });

  io.on("connection", (socket) => {
    void socket.join(SUPERVISORS_ROOM);
  });
}

export class SocketIoPushChannel implements PushChannel {
  readonly name = "socket.io";

  constructor(private readonly io: Server) {}

  async push(payload: AlertPushPayload): Promise<PushResult> {
    const supervisors = await this.io.in(SUPERVISORS_ROOM).fetchSockets();
    if (supervisors.length === 0) {
      return { ok: false, error: "no_supervisor_connected" };
    }
    this.io.to(SUPERVISORS_ROOM).emit(ALERT_EVENT, payload);
    return { ok: true, deliveredTo: supervisors.length };
  }
}
