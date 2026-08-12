import { describe, expect, it, vi } from "vitest";

import { createGeoResolver, type GeoLookup } from "../src/geo/factory";
import { resolveJurisdiction } from "../src/jurisdiction";

describe("createGeoResolver (task 4.3 geo pillar)", () => {
  it("returns a none resolver that resolves no country", async () => {
    const resolver = createGeoResolver({ provider: "none", maxmindDbPath: "", ipstackApiKey: "" });

    expect(await resolver.resolveCountry("8.8.8.8")).toBeUndefined();
  });

  it("returns an ipstack resolver that calls the API and keeps only the country code", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ country_code: "CO" }), { status: 200 })
    );
    const resolver = createGeoResolver(
      {
        provider: "ipstack",
        maxmindDbPath: "",
        ipstackApiKey: "key-123",
      },
      { fetchImpl: fetchMock as unknown as typeof fetch }
    );

    expect(await resolver.resolveCountry("190.0.0.1")).toBe("CO");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("ipstack.com/190.0.0.1");
    expect(url).toContain("access_key=key-123");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("degrades to unknown when the ipstack call fails", async () => {
    const resolver = createGeoResolver(
      {
        provider: "ipstack",
        maxmindDbPath: "",
        ipstackApiKey: "key-123",
      },
      {
        fetchImpl: vi.fn().mockRejectedValue(new Error("network")) as unknown as typeof fetch,
      }
    );

    expect(await resolver.resolveCountry("190.0.0.1")).toBeUndefined();
  });

  it("returns a maxmind resolver backed by the injected reader", async () => {
    const lookup: GeoLookup = async () => "MX";
    const resolver = createGeoResolver(
      { provider: "maxmind", maxmindDbPath: "/data/GeoLite2.mmdb", ipstackApiKey: "" },
      { lookup }
    );

    expect(await resolver.resolveCountry("187.0.0.1")).toBe("MX");
    expect(await resolver.resolveCountry("unknown")).toBeUndefined();
  });
});

describe("resolveJurisdiction (REQ-CONSENT-1/6 mapping)", () => {
  it("maps a supported country code to its legal framework", () => {
    const resolved = resolveJurisdiction("CO");
    expect(resolved).toMatchObject({ jurisdiction: "CO", frameworkCode: "COL-1581" });
    expect(resolved.isDefault).toBe(false);
  });

  it("maps EU member states to the GDPR framework", () => {
    const resolved = resolveJurisdiction("DE");
    expect(resolved).toMatchObject({ jurisdiction: "EU", frameworkCode: "EU-GDPR" });
    expect(resolved.isDefault).toBe(false);
  });

  it("applies the conservative default for unknown countries and flags review", () => {
    const resolved = resolveJurisdiction("CN");
    expect(resolved).toMatchObject({ jurisdiction: "DEFAULT", frameworkCode: "DEFAULT" });
    expect(resolved.isDefault).toBe(true);
  });

  it("applies the conservative default when no country was resolved", () => {
    const resolved = resolveJurisdiction(undefined);
    expect(resolved).toMatchObject({ jurisdiction: "DEFAULT", frameworkCode: "DEFAULT" });
    expect(resolved.isDefault).toBe(true);
  });
});
