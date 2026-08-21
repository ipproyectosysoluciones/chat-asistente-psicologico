import { describe, expect, it } from "vitest";

import { SESSION_STATE } from "@chatcap/shared-types";

import { messageFrom } from "../src/provider/mock";
import {
  CHOOSE_OPTION_TEXT,
  createMenuFlow,
  isMenuKeyword,
  MENU_TEXT,
  TOPIC_ENTRY_TEXT,
  WELCOME_TEXT,
} from "../src/flow/menu";
import { type FlowContext } from "../src/flow/flow";

/**
 * Welcome/menu flow (task 4.2, REQ-CHATBOT-3): first contact presents the
 * welcome + menu options; the menu keyword re-enters the menu from ANY flow
 * without losing session context (jurisdiction/geoCountry). The flow is
 * PURE — no effects, no DB writes, nothing persisted before consent.
 */

function contextWith(overrides: Partial<FlowContext>): FlowContext {
  return {
    sessionId: "s1",
    contactKeyAnon: "hash-contact",
    state: { state: SESSION_STATE.INITIAL },
    ...overrides,
  };
}

describe("createMenuFlow (task 4.2, REQ-CHATBOT-3)", () => {
  it("sends welcome + menu on first contact and does not persist data", async () => {
    const flow = createMenuFlow();

    const output = await flow.handle(
      messageFrom("5491100000000", "Hola"),
      contextWith({})
    );

    expect(output.replies).toHaveLength(2);
    expect(output.replies[0]?.body).toBe(WELCOME_TEXT);
    expect(output.replies[1]?.body).toBe(MENU_TEXT);
    expect(output.effects).toEqual([]);
    expect(output.nextState).toEqual({ state: SESSION_STATE.MENU });
  });

  it("presents only the menu on menu-keyword re-entry, keeping jurisdiction", async () => {
    const flow = createMenuFlow();
    const priorState = {
      state: SESSION_STATE.TOPIC,
      jurisdiction: "EU-GDPR",
      geoCountry: "DE",
    };

    const output = await flow.handle(
      messageFrom("5491100000000", "menú"),
      contextWith({ state: priorState })
    );

    expect(output.replies).toHaveLength(1);
    expect(output.replies[0]?.body).toBe(MENU_TEXT);
    expect(output.nextState).toEqual({ state: SESSION_STATE.MENU, jurisdiction: "EU-GDPR", geoCountry: "DE" });
  });

  it("re-enters the menu from a crisis state without losing session context", async () => {
    const flow = createMenuFlow();
    const priorState = {
      state: SESSION_STATE.CRISIS,
      jurisdiction: "CO",
    };

    const output = await flow.handle(
      messageFrom("5491100000000", "Menu"),
      contextWith({ state: priorState })
    );

    expect(output.nextState).toEqual({ state: SESSION_STATE.MENU, jurisdiction: "CO" });
    expect(output.effects).toEqual([]);
  });

  it("prompts to choose an option for a non-keyword message while in the menu", async () => {
    const flow = createMenuFlow();
    const priorState = { state: SESSION_STATE.MENU };

    const output = await flow.handle(
      messageFrom("5491100000000", "hola, necesito ayuda"),
      contextWith({ state: priorState })
    );

    expect(output.replies).toHaveLength(1);
    expect(output.replies[0]?.body).toBe(CHOOSE_OPTION_TEXT);
    expect(output.nextState).toEqual(priorState);
    expect(output.effects).toEqual([]);
  });

  it("routes the support-topics option into the topic state (task 4.6)", async () => {
    const flow = createMenuFlow();
    const priorState = { state: SESSION_STATE.MENU, jurisdiction: "CO" };

    const output = await flow.handle(
      messageFrom("5491100000000", "1"),
      contextWith({ state: priorState })
    );

    expect(output.replies).toHaveLength(1);
    expect(output.replies[0]?.body).toBe(TOPIC_ENTRY_TEXT);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.TOPIC, jurisdiction: "CO" });
    expect(output.effects).toEqual([]);
  });
});

describe("isMenuKeyword", () => {
  it("recognizes the menu keyword with case and whitespace variants", () => {
    expect(isMenuKeyword("menú")).toBe(true);
    expect(isMenuKeyword("menu")).toBe(true);
    expect(isMenuKeyword("  MENU  ")).toBe(true);
    expect(isMenuKeyword("MENÚ")).toBe(true);
  });

  it("rejects ordinary messages", () => {
    expect(isMenuKeyword("Hola")).toBe(false);
    expect(isMenuKeyword("necesito ayuda")).toBe(false);
  });
});
