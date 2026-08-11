import { describe, expect, test, vi } from "vitest";

import { createLogger } from "@chatcap/telemetry";
import type { RiskLevel } from "@chatcap/shared-types";

import { classifyRisk, routeByRisk } from "../src/classify";
import { UpstreamDependencyError } from "../src/errors";

/**
 * Risk classification (task 3.2, REQ-RAG-7): GPT-4o-mini classifies the
 * incoming message red/orange/yellow/normal and the decision drives routing
 * BEFORE retrieval (design §2.2). Red short-circuits to the crisis path; the
 * rest proceed so retrieval can attach chunks (orange needs exact chunks for
 * supervisor review, but emission is blocked later in the orchestrator).
 */

const silentLogger = createLogger({ level: "silent", destination: { write: () => {} } });

describe("classifyRisk", () => {
  test("returns the level reported by the side-task model (mock classify)", async () => {
    const client = { classify: vi.fn(async () => "red" as RiskLevel) };
    const risk = await classifyRisk({ client, logger: silentLogger }, "Quiero hacerme daño.");

    expect(client.classify).toHaveBeenCalledWith("Quiero hacerme daño.");
    expect(risk).toBe("red");
  });

  test("treats an unexpected model output as normal instead of trusting it", async () => {
    const warnSpy = vi.fn();
    const logger = { ...silentLogger, warn: warnSpy };
    const client = { classify: vi.fn(async () => "severe" as unknown as RiskLevel) };

    const risk = await classifyRisk({ client, logger }, "hola");

    expect(risk).toBe("normal");
    expect(warnSpy).toHaveBeenCalled();
  });

  test("wraps upstream failures in UpstreamDependencyError (router maps to 502)", async () => {
    const client = {
      classify: vi.fn(async () => {
        throw new Error("upstream timeout");
      }),
    };

    await expect(
      classifyRisk({ client, logger: silentLogger }, "hola")
    ).rejects.toThrow(UpstreamDependencyError);
  });
});

describe("routeByRisk (routing before retrieval)", () => {
  test("red risk short-circuits to the crisis path (no retrieval)", () => {
    expect(routeByRisk("red")).toEqual({ action: "short_circuit", level: "red" });
  });

  test("orange proceeds so chunks are available for supervisor review", () => {
    expect(routeByRisk("orange")).toEqual({ action: "proceed", level: "orange" });
  });

  test("yellow and normal proceed to retrieval", () => {
    expect(routeByRisk("yellow")).toEqual({ action: "proceed", level: "yellow" });
    expect(routeByRisk("normal")).toEqual({ action: "proceed", level: "normal" });
  });
});
