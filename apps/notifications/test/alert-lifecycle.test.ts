import { describe, expect, it } from "vitest";

import type { AlertStatus } from "@chatcap/shared-types";

import {
  InvalidTransitionError,
  nextAlertStatus,
} from "../src/alert-lifecycle";

/**
 * Alert lifecycle state machine (task 2.4, REQ-ALERT-6): alerts follow a
 * strict `open → acknowledged → resolved` path. A supervisor acknowledges
 * (takeover), then resolves. Invalid transitions are rejected loudly — an
 * alert can never skip a step or be re-transitioned.
 */

describe("nextAlertStatus", () => {
  it("acknowledge moves an open alert to acknowledged", () => {
    expect(nextAlertStatus("open", "acknowledge")).toBe("acknowledged");
  });

  it("resolve moves an acknowledged alert to resolved", () => {
    expect(nextAlertStatus("acknowledged", "resolve")).toBe("resolved");
  });

  it("rejects resolving an open alert (takeover must happen first)", () => {
    expect(() => nextAlertStatus("open", "resolve")).toThrow(InvalidTransitionError);
  });

  it("rejects acknowledging an already-acknowledged alert", () => {
    expect(() => nextAlertStatus("acknowledged", "acknowledge")).toThrow(
      InvalidTransitionError
    );
  });

  it("rejects any transition of a resolved alert", () => {
    expect(() => nextAlertStatus("resolved", "acknowledge")).toThrow(
      InvalidTransitionError
    );
    expect(() => nextAlertStatus("resolved", "resolve")).toThrow(
      InvalidTransitionError
    );
  });

  it("exposes the offending status and action on the error", () => {
    let caught: InvalidTransitionError | undefined;
    try {
      nextAlertStatus("open", "resolve");
    } catch (error) {
      caught = error as InvalidTransitionError;
    }
    expect(caught?.current).toBe("open");
    expect(caught?.action).toBe("resolve");
  });

  it("is total over every status/action combination", () => {
    const statuses: AlertStatus[] = ["open", "acknowledged", "resolved"];
    const actions = ["acknowledge", "resolve"] as const;
    for (const status of statuses) {
      for (const action of actions) {
        if (action === "acknowledge" && status === "open") {
          expect(nextAlertStatus(status, action)).toBe("acknowledged");
        } else if (action === "resolve" && status === "acknowledged") {
          expect(nextAlertStatus(status, action)).toBe("resolved");
        } else {
          expect(() => nextAlertStatus(status, action)).toThrow(InvalidTransitionError);
        }
      }
    }
  });
});
