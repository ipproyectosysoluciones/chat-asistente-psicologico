/**
 * Geo provider pillar (task 4.3, design §8): a swappable country resolver that
 * turns a remote IP into an ISO-3166 alpha-2 country code. Only the country
 * code leaves this module — the raw IP is never persisted or logged as PII.
 * Providers are swapped configuration-only (none | ipstack | maxmind).
 */

export interface GeoResolver {
  resolveCountry(ip: string): Promise<string | undefined>;
}
