import { describe, expect, it } from "vitest";

import { SESSION_STATE } from "@chatcap/shared-types";

import { type FlowContext } from "../src/flow/flow";
import { createJurisdictionFlow } from "../src/flow/jurisdiction";
import { createMenuFlow, MENU_TEXT, WELCOME_TEXT } from "../src/flow/menu";
import { createSessionFlow } from "../src/flow/session";
import { type GeoResolver } from "../src/geo/resolver";
import { messageFrom } from "../src/provider/mock";

/**
 * Session flow composition (task 4.3): routes by state — first contact and
 * the jurisdiction conversation go to the jurisdiction flow (no data stored
 * before confirmation), everything else falls back to the menu flow.
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
      jurisdiction: createJurisdictionFlow({ geoResolver: geoResolver(country) }),
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
});
