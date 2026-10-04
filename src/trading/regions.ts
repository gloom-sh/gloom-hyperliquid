import type { RegionStatus } from "./types";
/** Hyperliquid Interface Terms §1.6, verified 2026-10-04, terms updated 2026-06-15.
 * Country lookup cannot resolve Ontario or sanctioned Ukrainian territories: fail closed
 * for CA/UA until a province-aware lookup is adopted. Counsel should review this list.
 */
export const REGION_POLICY = {
  source: "https://app.hyperliquid.xyz/terms",
  blockedCountries: [
    "US",
    "CA",
    "CU",
    "IR",
    "KP",
    "SY",
    "RU",
    "BY",
    "UA",
  ] as readonly string[],
  lookup: "https://www.cloudflare.com/cdn-cgi/trace",
  maxAgeMs: 5 * 60_000,
};
export async function checkRegion(
  fetcher: typeof fetch = fetch,
): Promise<RegionStatus> {
  const checkedAt = Date.now();
  try {
    const response = await fetcher(REGION_POLICY.lookup, {
      signal: AbortSignal.timeout(7000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Country lookup failed.");
    const country = (await response.text()).match(/^loc=([A-Z]{2})$/m)?.[1];
    if (!country || country === "XX")
      throw new Error("Country could not be verified.");
    return {
      allowed: !REGION_POLICY.blockedCountries.includes(country),
      country,
      checkedAt,
      ...(REGION_POLICY.blockedCountries.includes(country)
        ? {
            reason:
              "Trading is unavailable in this jurisdiction. Market data and watch-only remain available.",
          }
        : {}),
    };
  } catch {
    return {
      allowed: false,
      checkedAt,
      reason:
        "Location could not be verified. Trading stays disabled; market data remains available.",
    };
  }
}
