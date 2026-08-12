import type { GeoResolver } from "./resolver";

/**
 * Geo provider factory (task 4.3): none | ipstack | maxmind, swapped via
 * config only. Providers keep PII to a minimum — the ipstack call returns
 * only the country code and the maxmind reader is injected as a `GeoLookup`
 * so the GeoLite2 DB stays off this module's hot path. Failures degrade to
 * `undefined` (the jurisdiction resolver applies the conservative default).
 */

export type GeoLookup = (ip: string) => Promise<string | undefined>;

export interface GeoProviderConfig {
  provider: "none" | "ipstack" | "maxmind";
  maxmindDbPath?: string;
  ipstackApiKey?: string;
}

export interface GeoResolverDeps {
  fetchImpl?: typeof fetch;
  lookup?: GeoLookup;
}

const IPSTACK_BASE_URL = "https://api.ipstack.com";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Lightweight IPv4/IPv6 format check — prevents junk reaching external lookups. */
function isIpLike(value: string): boolean {
  const ipv4 = IPV4_RE.exec(value);
  if (ipv4 !== null) {
    return ipv4.slice(1).every((octet) => Number(octet) <= 255);
  }
  return value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value);
}

export function createGeoResolver(
  config: GeoProviderConfig,
  deps: GeoResolverDeps = {}
): GeoResolver {
  switch (config.provider) {
    case "none":
      return { resolveCountry: async () => undefined };
    case "ipstack": {
      const fetchImpl = deps.fetchImpl ?? fetch;
      return {
        resolveCountry: async (ip: string) => {
          if (!isIpLike(ip)) {
            return undefined;
          }
          try {
            const url = `${IPSTACK_BASE_URL}/${ip}?access_key=${config.ipstackApiKey ?? ""}`;
            const response = await fetchImpl(url, {
              headers: { "Content-Type": "application/json" },
            });
            if (!response.ok) {
              return undefined;
            }
            // Cast from unknown JSON body: only country_code is read; the
            // stringness check below guards against a non-string payload
            // before the value flows into resolveJurisdiction.
            const data = (await response.json()) as { country_code?: unknown };
            return typeof data.country_code === "string" ? data.country_code : undefined;
          } catch {
            return undefined;
          }
        },
      };
    }
    case "maxmind": {
      const lookup = deps.lookup;
      return {
        resolveCountry: async (ip: string) => {
          if (!isIpLike(ip)) {
            return undefined;
          }
          if (lookup === undefined) {
            return undefined;
          }
          try {
            return await lookup(ip);
          } catch {
            return undefined;
          }
        },
      };
    }
  }
}
