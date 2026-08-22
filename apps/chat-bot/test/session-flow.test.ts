import { describe, expect, it } from "vitest";

import { SESSION_STATE } from "@chatcap/shared-types";

import { type FlowContext } from "../src/flow/flow";
import { createCrisisFlow } from "../src/flow/crisis";
import { createJurisdictionFlow } from "../src/flow/jurisdiction";
import { createMenuFlow, MENU_TEXT, WELCOME_TEXT } from "../src/flow/menu";
import { createSessionFlow } from "../src/flow/session";
import { createTopicFlow } from "../src/flow/topic";
import { type GeoResolver } from "../src/geo/resolver";
import { messageFrom } from "../src/provider/mock";

/**
 * Session flow composition (task 4.3, extended 4.5): routes by state — first
 * contact and the jurisdiction conversation go to the jurisdiction flow (no
 * data stored before confirmation), everything else falls back to the menu
 * flow. The crisis guard runs FIRST at every state (REQ-CHATBOT-5).
 */

function geoResolver(country: string | undefined): GeoResolver {
  return { resolveCountry: async () => country };
}

function contextWith(state: FlowContext["state"], overrides: Partial<FlowContext> = {}): FlowContext {
  return {
    sessionId: "s1",
    contactKeyAnon: "hash-contact",
    state,
    ...overrides,
  };
}

describe("createSessionFlow (task 4.3 composition)", () => {
  const session = (country?: string) =>
    createSessionFlow({
      menu: createMenuFlow(),
      crisis: createCrisisFlow(),
      jurisdiction: createJurisdictionFlow({ geoResolver: geoResolver(country) }),
      topic: createTopicFlow(),
    });

  it("routes first contact to welcome, menu and the jurisdiction proposal", async () => {
    const output = await session("CO").handle(
      messageFrom("5491100000000", "hola", "190.0.0.1"),
      contextWith({ state: SESSION_STATE.INITIAL })
    );

    const bodies = output.replies.map((reply) => reply.body);
    expect(bodies[0]).toBe(WELCOME_TEXT);
    expect(bodies[1]).toBe(MENU_TEXT);
    expect(bodies[2]).toContain("tu jurisdicción");
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.AWAITING_JURISDICTION,
      geoCountry: "CO",
      proposedJurisdiction: "CO",
    });
  });

  it("routes the confirmation back through the jurisdiction flow", async () => {
    const output = await session().handle(
      messageFrom("5491100000000", "sí, confirmo"),
      contextWith({
        state: SESSION_STATE.AWAITING_JURISDICTION,
        geoCountry: "CO",
        proposedJurisdiction: "CO",
      })
    );

    expect(output.effects).toEqual([
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "CO" },
    ]);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.MENU, jurisdiction: "CO" });
  });

  it("falls back to the menu flow for any other state", async () => {
    const output = await session().handle(
      messageFrom("5491100000000", "menú"),
      contextWith({
        state: SESSION_STATE.TOPIC,
        jurisdiction: "CO",
      })
    );

    expect(output.replies[0]?.body).toBe(MENU_TEXT);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.MENU, jurisdiction: "CO" });
  });

  it("crisis keyword wins over the menu flow at any state (REQ-CHATBOT-5)", async () => {
    const output = await session().handle(
      messageFrom("5491100000000", "me quiero morir"),
      contextWith({
        state: SESSION_STATE.TOPIC,
        geoCountry: "MX",
      })
    );

    expect(output.nextState).toMatchObject({ state: SESSION_STATE.CRISIS });
    expect(output.effects).toEqual([
      { kind: "raise_red_alert", sessionId: "s1", keyword: "me quiero morir" },
    ]);
    expect(output.replies[0]?.body).toContain("Línea de la Vida (México)");
  });

  it("crisis keyword wins over the jurisdiction confirmation", async () => {
    const output = await session().handle(
      messageFrom("5491100000000", "no sé, tengo una crisis"),
      contextWith({
        state: SESSION_STATE.AWAITING_JURISDICTION,
        proposedJurisdiction: "CO",
        geoCountry: "CO",
      })
    );

    expect(output.nextState).toMatchObject({ state: SESSION_STATE.CRISIS });
    expect(output.effects[0]).toMatchObject({ kind: "raise_red_alert" });
  });

  it("routes TOPIC-state messages to the topic flow (task 4.6, REQ-CHATBOT-2)", async () => {
    const output = await session().handle(
      messageFrom("5491100000000", "¿qué es la ansiedad?"),
      contextWith({ state: SESSION_STATE.TOPIC, jurisdiction: "CO" })
    );

    expect(output.effects).toEqual([
      {
        kind: "rag_process",
        sessionId: "s1",
        to: "5491100000000",
        message: "¿qué es la ansiedad?",
      },
    ]);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.TOPIC, jurisdiction: "CO" });
  });

  it("menu keyword in TOPIC state re-enters the menu, not RAG (task 4.6)", async () => {
    const output = await session().handle(
      messageFrom("5491100000000", "menú"),
      contextWith({ state: SESSION_STATE.TOPIC, jurisdiction: "CO" })
    );

    expect(output.replies[0]?.body).toBe(MENU_TEXT);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.MENU, jurisdiction: "CO" });
    expect(output.effects).toEqual([]);
  });
});
