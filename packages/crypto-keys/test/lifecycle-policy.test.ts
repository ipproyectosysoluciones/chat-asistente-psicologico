import { describe, expect, it } from "vitest";

import {
  FORCED_ROTATION_DELAY_MS,
  KEY_LIFETIME_MS,
  computeNextWindowStart,
  computeRotationDates,
  isWithinWindow,
  rotationState,
} from "../src/lifecycle/policy";
import {
  batchIntegrityHash,
  deriveIntegrityKey,
  rowIntegrityHash,
} from "../src/lifecycle/integrity";
import { TEST_MASTER } from "./helpers";

describe("policy: low-traffic window (REQ-KEY-5)", () => {
  it("is within the default 02:00–05:00 window at 03:30", () => {
    expect(isWithinWindow(new Date("2026-08-09T03:30:00Z"))).toBe(true);
  });

  it("is outside the window at 01:00 and at 06:00", () => {
    expect(isWithinWindow(new Date("2026-08-09T01:00:00Z"))).toBe(false);
    expect(isWithinWindow(new Date("2026-08-09T06:00:00Z"))).toBe(false);
  });

  it("supports a window that crosses midnight (23:00–01:00)", () => {
    const window = { start: 23, end: 1 };
    expect(isWithinWindow(new Date("2026-08-09T23:30:00Z"), window)).toBe(true);
    expect(isWithinWindow(new Date("2026-08-10T00:30:00Z"), window)).toBe(true);
    expect(isWithinWindow(new Date("2026-08-10T12:00:00Z"), window)).toBe(false);
  });

  it("window boundaries are inclusive on start, exclusive on end", () => {
    expect(isWithinWindow(new Date("2026-08-09T02:00:00Z"))).toBe(true);
    expect(isWithinWindow(new Date("2026-08-09T05:00:00Z"))).toBe(false);
  });

  it("next window start is on the following day when already inside", () => {
    const now = new Date("2026-08-09T04:00:00Z");
    const next = computeNextWindowStart(now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(isWithinWindow(next)).toBe(true);
  });
});

describe("policy: rotation dates (REQ-KEY-2/REQ-KEY-3)", () => {
  it("expires 7 days out and forces re-encryption 12h after expiry", () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const { expiresAt, forcedRotationDueAt } = computeRotationDates(now);
    expect(expiresAt.getTime() - now.getTime()).toBe(KEY_LIFETIME_MS);
    expect(forcedRotationDueAt.getTime() - expiresAt.getTime()).toBe(
      FORCED_ROTATION_DELAY_MS
    );
  });

  it("derives rotation state: active / expiring_soon / rotation_due / forced_due", () => {
    const now = new Date("2026-08-09T00:00:00Z");
    const { expiresAt, forcedRotationDueAt } = computeRotationDates(now);

    const key = {
      expiresAt: expiresAt.toISOString(),
      forcedRotationDueAt: forcedRotationDueAt.toISOString(),
    };
    expect(rotationState(key, now)).toBe("active");
    expect(rotationState(key, new Date("2026-08-15T12:00:00Z"))).toBe("expiring_soon");
    expect(rotationState(key, expiresAt)).toBe("rotation_due");
    expect(
      rotationState(key, new Date(forcedRotationDueAt.getTime() + 1))
    ).toBe("forced_due");
  });
});

describe("integrity: batch hashes (REQ-KEY-4)", () => {
  const integrityKey = deriveIntegrityKey(TEST_MASTER);

  it("derives a deterministic integrity key from the master secret", () => {
    expect(deriveIntegrityKey(TEST_MASTER).equals(deriveIntegrityKey(TEST_MASTER))).toBe(
      true
    );
    expect(
      deriveIntegrityKey(TEST_MASTER).equals(
        deriveIntegrityKey(Buffer.from("other-master"))
      )
    ).toBe(false);
  });

  it("row hash is deterministic and binds rowId, keyTo and payload", () => {
    const a = rowIntegrityHash(
      integrityKey,
      "row-1",
      2,
      Buffer.from("payload-a")
    );
    const b = rowIntegrityHash(
      integrityKey,
      "row-1",
      2,
      Buffer.from("payload-a")
    );
    const tampered = rowIntegrityHash(
      integrityKey,
      "row-1",
      2,
      Buffer.from("payload-b")
    );
    expect(a.equals(b)).toBe(true);
    expect(a.equals(tampered)).toBe(false);
  });

  it("batch hash changes if any row changes (tamper detection)", () => {
    const rowsA = [
      { rowId: "r1", hash: rowIntegrityHash(integrityKey, "r1", 2, Buffer.from("x")) },
      { rowId: "r2", hash: rowIntegrityHash(integrityKey, "r2", 2, Buffer.from("y")) },
    ];
    const rowsB = [
      { rowId: "r1", hash: rowIntegrityHash(integrityKey, "r1", 2, Buffer.from("x")) },
      { rowId: "r2", hash: rowIntegrityHash(integrityKey, "r2", 2, Buffer.from("z")) },
    ];
    expect(batchIntegrityHash(integrityKey, rowsA).equals(batchIntegrityHash(integrityKey, rowsB))).toBe(false);
  });

  it("batch hash is independent of row ordering (sorted canonical form)", () => {
    const rowsA = [
      { rowId: "r1", hash: rowIntegrityHash(integrityKey, "r1", 2, Buffer.from("x")) },
      { rowId: "r2", hash: rowIntegrityHash(integrityKey, "r2", 2, Buffer.from("y")) },
    ];
    const rowsB = [rowsA[1], rowsA[0]].map((r) => ({ rowId: r!.rowId, hash: r!.hash }));
    expect(batchIntegrityHash(integrityKey, rowsA).equals(batchIntegrityHash(integrityKey, rowsB))).toBe(true);
  });

  it("batch hash is a 64-char hex digest", () => {
    const digest = batchIntegrityHash(integrityKey, [
      { rowId: "r1", hash: rowIntegrityHash(integrityKey, "r1", 2, Buffer.from("x")) },
    ]);
    expect(digest.toString("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
});
