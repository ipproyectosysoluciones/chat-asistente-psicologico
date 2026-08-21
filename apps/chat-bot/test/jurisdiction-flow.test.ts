import { describe, expect, it } from "vitest";

import { SESSION_STATE } from "@chatcap/shared-types";

import { createJurisdictionFlow, JURISDICTION_CONFIRMED } from "../src/flow/jurisdiction";
import { type FlowContext } from "../src/flow/flow";
import { type GeoResolver } from "../src/geo/resolver";
import { messageFrom } from "../src/provider/mock";

/**
 * Jurisdiction flow (task 4.3, REQ-CONSENT-1/6): when a session reaches the
 * AWAITING_JURISDICTION state it proposes a framework from the geo-resolved
 * country, waits for explicit confirmation, handles the VPN-discrepancy case
 * (stated country != geo country, PII-stripped log) and falls back to the
 * conservative DEFAULT framework (flagged for legal review) when nothing can
 * be resolved. The geo pillar is injected so the flow stays swappable.
 */

function geoResolver(country: string | undefined): GeoResolver {
  return { resolveCountry: async () => country };
}

function contextWith(overrides: Partial<FlowContext>): FlowContext {
  return {
    sessionId: "s1",
    contactKeyAnon: "hash-contact",
    state: { state: SESSION_STATE.AWAITING_JURISDICTION },
    ...overrides,
  };
}

describe("createJurisdictionFlow (task 4.3)", () => {
  it("proposes the geo-derived jurisdiction when the session reaches the state", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver("CO") });

    const output = await flow.handle(
      messageFrom("5491100000000", "hola", "190.0.0.1"),
      contextWith({})
    );

    expect(output.replies[0]?.body).toContain("tu jurisdicción");
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.AWAITING_JURISDICTION,
      geoCountry: "CO",
      proposedJurisdiction: "CO",
    });
    expect(output.effects).toEqual([]);
  });

  it("persists the proposed jurisdiction when the user confirms", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver(undefined) });

    const output = await flow.handle(
      messageFrom("5491100000000", "sí, confirmo"),
      contextWith({
        state: {
          state: SESSION_STATE.AWAITING_JURISDICTION,
          geoCountry: "CO",
          proposedJurisdiction: "CO",
        },
      })
    );

    expect(output.effects).toEqual([
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "CO" },
    ]);
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.MENU,
      jurisdiction: "CO",
    });
    expect(output.replies[0]?.body).toContain(JURISDICTION_CONFIRMED);
  });

  it("logs a VPN discrepancy when the stated country differs from the geo country", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver(undefined) });

    const output = await flow.handle(
      messageFrom("5491100000000", "soy de México"),
      contextWith({
        state: {
          state: SESSION_STATE.AWAITING_JURISDICTION,
          geoCountry: "AR",
        },
      })
    );

    expect(output.effects).toEqual([
      { kind: "log_vpn_discrepancy", sessionId: "s1", geoCountry: "AR", statedCountry: "MX" },
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "MX" },
    ]);
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.MENU,
      jurisdiction: "MX",
    });
  });

  it("applies the conservative default and flags legal review when nothing resolves", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver(undefined) });

    const output = await flow.handle(
      messageFrom("5491100000000", "no sé"),
      contextWith({
        state: { state: SESSION_STATE.AWAITING_JURISDICTION },
      })
    );

    expect(output.effects).toEqual([
      { kind: "flag_legal_review", sessionId: "s1", jurisdiction: "DEFAULT" },
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "DEFAULT" },
    ]);
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.MENU,
      jurisdiction: "DEFAULT",
    });
  });

  it("never treats a refusal as consent (no estoy de acuerdo) — falls back to DEFAULT", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver(undefined) });

    const output = await flow.handle(
      messageFrom("5491100000000", "no estoy de acuerdo"),
      contextWith({
        state: {
          state: SESSION_STATE.AWAITING_JURISDICTION,
          geoCountry: "CO",
          proposedJurisdiction: "CO",
        },
      })
    );

    expect(output.effects).toEqual([
      { kind: "flag_legal_review", sessionId: "s1", jurisdiction: "DEFAULT" },
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "DEFAULT" },
    ]);
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.MENU,
      jurisdiction: "DEFAULT",
    });
  });

  it("routes a bare no refusal to the DEFAULT path instead of the retry loop", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver(undefined) });

    const output = await flow.handle(
      messageFrom("5491100000000", "no"),
      contextWith({
        state: {
          state: SESSION_STATE.AWAITING_JURISDICTION,
          geoCountry: "CO",
          proposedJurisdiction: "CO",
        },
      })
    );

    expect(output.effects).toEqual([
      { kind: "flag_legal_review", sessionId: "s1", jurisdiction: "DEFAULT" },
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "DEFAULT" },
    ]);
    expect(output.nextState).toMatchObject({
      state: SESSION_STATE.MENU,
      jurisdiction: "DEFAULT",
    });
  });

  it("confirms a stated country without a VPN log when it matches the geo country", async () => {
    const flow = createJurisdictionFlow({ geoResolver: geoResolver(undefined) });

    const output = await flow.handle(
      messageFrom("5491100000000", "colombia"),
      contextWith({
        state: {
          state: SESSION_STATE.AWAITING_JURISDICTION,
          geoCountry: "CO",
        },
      })
    );

    expect(output.effects).toEqual([
      { kind: "persist_jurisdiction", sessionId: "s1", jurisdiction: "CO" },
    ]);
    expect(output.nextState).toMatchObject({ state: SESSION_STATE.MENU, jurisdiction: "CO" });
  });
});
