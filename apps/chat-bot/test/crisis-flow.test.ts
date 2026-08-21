import { describe, expect, it } from "vitest";

import { SESSION_STATE } from "@chatcap/shared-types";

import { messageFrom } from "../src/provider/mock";
import {
  createCrisisFlow,
  crisisLinesFor,
  isCrisisKeyword,
} from "../src/flow/crisis";
import type { FlowContext } from "../src/flow/flow";

/**
 * Crisis flow (task 4.5, REQ-CHATBOT-5, REQ-ALERT-3): OMS/mhGAP-derived
 * crisis keywords matched at ANY state trigger the immediate crisis response
 * (grounded text + local emergency lines by geolocation) and request a
 * PII-free red alert through the `raise_red_alert` effect. The flow stays
 * pure — the orchestrator publishes the alert and, on failure, forces human
 * takeover (REQ-ALERT-4).
 */

function contextWith(overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    sessionId: "s1",
    contactKeyAnon: "anon-1",
    state: { state: SESSION_STATE.MENU },
    ...overrides,
  };
}

describe("isCrisisKeyword (OMS/mhGAP-derived list)", () => {
  it("matches suicidality phrases with and without accents", () => {
    expect(isCrisisKeyword("me quiero morir")).toBe(true);
    expect(isCrisisKeyword("no quiero vivir más")).toBe(true);
    expect(isCrisisKeyword("estoy pensando en suicidarme")).toBe(true);
    expect(isCrisisKeyword("autolesión grave")).toBe(true);
    expect(isCrisisKeyword("quiero hacerme daño")).toBe(true);
    expect(isCrisisKeyword("ya no puedo más")).toBe(true);
    expect(isCrisisKeyword("quiero desaparecer")).toBe(true);
  });

  it("matches crisis tokens anywhere in the message", () => {
    expect(isCrisisKeyword("hola, tengo una crisis")).toBe(true);
    expect(isCrisisKeyword("es una emergencia, ayúdame")).toBe(true);
    expect(isCrisisKeyword("siento que quiero lastimarme")).toBe(true);
  });

  it("ignores ordinary messages", () => {
    expect(isCrisisKeyword("hola, ¿cómo estás?")).toBe(false);
    expect(isCrisisKeyword("quiero un café")).toBe(false);
    expect(isCrisisKeyword("¿qué opciones de apoyo hay?")).toBe(false);
  });
});

describe("createCrisisFlow", () => {
  it("returns the crisis response with local lines and requests a red alert", async () => {
    const flow = createCrisisFlow();
    const output = await flow.handle(
      messageFrom("5491100000000", "me quiero morir"),
      contextWith({
        state: { state: SESSION_STATE.MENU, geoCountry: "CO" },
      })
    );

    expect(output.replies).toHaveLength(1);
    expect(output.replies[0]?.body).toContain(crisisLinesFor("CO"));
    expect(output.effects).toEqual([
      { kind: "raise_red_alert", sessionId: "s1", keyword: "me quiero morir" },
    ]);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.CRISIS });
  });

  it("uses the geolocated country for the local help lines", async () => {
    const flow = createCrisisFlow();
    const output = await flow.handle(
      messageFrom("5491100000000", "tengo una crisis"),
      contextWith({ state: { state: SESSION_STATE.MENU, geoCountry: "MX" } })
    );
    expect(output.replies[0]?.body).toContain(crisisLinesFor("MX"));
  });

  it("falls back to the jurisdiction when geolocation is unknown", async () => {
    const flow = createCrisisFlow();
    const output = await flow.handle(
      messageFrom("5491100000000", "quiero hacerme daño"),
      contextWith({
        jurisdiction: "AR",
        state: { state: SESSION_STATE.TOPIC },
      })
    );
    expect(output.replies[0]?.body).toContain(crisisLinesFor("AR"));
  });

  it("uses the conservative international line with no location context", async () => {
    const flow = createCrisisFlow();
    const output = await flow.handle(
      messageFrom("5491100000000", "crisis"),
      contextWith()
    );
    expect(output.replies[0]?.body).toContain(crisisLinesFor("DEFAULT"));
  });

  it("triggers at the INITIAL first-contact state too", async () => {
    const flow = createCrisisFlow();
    const output = await flow.handle(
      messageFrom("5491100000000", "quiero morir"),
      contextWith({ state: { state: SESSION_STATE.INITIAL } })
    );
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.CRISIS });
    expect(output.effects).toEqual([
      { kind: "raise_red_alert", sessionId: "s1", keyword: "quiero morir" },
    ]);
  });

  it("is a pass-through for non-crisis messages", async () => {
    const flow = createCrisisFlow();
    const output = await flow.handle(
      messageFrom("5491100000000", "hola, quiero saber más"),
      contextWith()
    );
    expect(output).toEqual({ replies: [], effects: [] });
  });
});
