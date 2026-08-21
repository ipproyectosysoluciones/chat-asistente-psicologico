import { io, type Socket } from "socket.io-client";

export { io };

import { alertItemSchema, type AlertItem } from "./api";

/**
 * Live alert feed socket (task 5.4, REQ-DASH-4/9): socket.io-client wrapper
 * connecting per the socket-push.ts contract (handshake `auth.token`) to the
 * dashboard's Socket.io server. Supervisors room membership (SUPERVISORS_ROOM)
 * is granted server-side on a valid handshake — connecting with the JWT is
 * what joins the room. Incoming payloads are zod-validated so a malformed
 * event is never rendered; `connect_error` is surfaced through `onError`.
 * The caller owns lifecycle: `disconnect()` MUST run on unmount (REQ-DASH-9).
 */

export const ALERT_EVENT = "alert:event";
export const ALERT_UPDATED_EVENT = "alert:updated";
export const SUPERVISORS_ROOM = "supervisors";

export interface AlertSocket {
  /** New alert pushed live (created / re-raised after resolve). */
  onAlert(callback: (alert: AlertItem) => void): void;
  /** Alert state transition (acknowledged / resolved). */
  onAlertUpdated(callback: (alert: AlertItem) => void): void;
  /** Connection-level failure (network drop, handshake rejection). */
  onError(callback: (error: Error) => void): void;
  disconnect(): void;
}

export function connectAlertSocket(token: string): AlertSocket {
  const handlers = {
    alert: (_alert: AlertItem) => {},
    alertUpdated: (_alert: AlertItem) => {},
    error: (_error: Error) => {},
  };

  const socket: Socket = io(undefined, {
    auth: { token },
  });

  socket.on(ALERT_EVENT, (payload: unknown) => {
    const parsed = alertItemSchema.safeParse(payload);
    if (parsed.success) {
      handlers.alert(parsed.data);
    }
  });

  socket.on(ALERT_UPDATED_EVENT, (payload: unknown) => {
    const parsed = alertItemSchema.safeParse(payload);
    if (parsed.success) {
      handlers.alertUpdated(parsed.data);
    }
  });

  socket.on("connect_error", (error: Error) => {
    handlers.error(error);
  });

  return {
    onAlert(callback) {
      handlers.alert = callback;
    },
    onAlertUpdated(callback) {
      handlers.alertUpdated = callback;
    },
    onError(callback) {
      handlers.error = callback;
    },
    disconnect() {
      socket.disconnect();
    },
  };
}
