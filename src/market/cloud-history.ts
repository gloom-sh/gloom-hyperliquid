import type { AssetClass, Network } from "./types.ts";
import { numberOrNull } from "./normalize.ts";

/** Public response contract pinned to cloud PR 626, 057f23788b6bd85a3843ab407b47d43f23e72545.
 * An authenticated connection must be supplied by a supported host API. This module never reads session tokens.
 * Historical analytics have no direct-exchange or locally reconstructed fallback.
 */
export type CloudState =
  | "ready"
  | "partial"
  | "collecting"
  | "sign-in"
  | "pro-required"
  | "host-unavailable"
  | "unavailable"
  | "error"
  | "testnet";
export type HistoryResolution = "minute" | "hour" | "day";
export interface CloudResult<T> {
  state: CloudState;
  data: T | null;
  asOf: number | null;
  error: string | null;
  access: "pro" | "preview" | null;
  locked: boolean;
}
export type CloudRequest = (
  path: string,
  options?: { signal?: AbortSignal },
) => Promise<{ status: number; body: unknown }>;
export interface CloudClientOptions {
  request?: CloudRequest;
  signedIn?: () => boolean;
  network?: Network;
  authenticationAvailable?: boolean;
}
export interface CloudHistoryPoint {
  time: number;
  resolution: HistoryResolution;
  mark: number | null;
  oracle: number | null;
  premium: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  oiCoin: number | null;
  oiUsd: number | null;
  sampleCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
}
export interface CloudFundingPoint {
  time: number;
  rate: number;
  intervalHours: number;
  premium: number | null;
  observedAt: number;
  sourceUrl: string;
}
export interface CloudCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  trades: number | null;
  interval: "1h";
  observedAt: number;
  sourceUrl: string;
}
export interface CloudHistory {
  marketId: string;
  from: number;
  to: number;
  resolution: HistoryResolution;
  points: CloudHistoryPoint[];
  funding: CloudFundingPoint[];
  candles: CloudCandle[];
  truncated: boolean;
}
export interface CloudRankedMarket {
  marketId: string;
  coin: string;
  symbol: string;
  dex: string;
  assetClass: AssetClass;
  displayName: string;
  mark: number | null;
  oracle: number | null;
  premium: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  fundingKind: "current" | "last-paid" | "continuous";
  funding8h: number | null;
  fundingApr: number | null;
  oiCoin: number | null;
  oiUsd: number | null;
  volume24h: number | null;
  oiChange1h: number | null;
  oiChange24h: number | null;
  oiChange1hUsd: number | null;
  oiChange24hUsd: number | null;
  underlyingPremium: number | null;
  closedMarketPremium: number | null;
  collateral: string;
  observedAt: number;
  sourceAsOf: number | null;
  sourceUrl: string;
  qualityFlags: string[];
  confidence: "high" | "medium" | "low";
  stale: boolean;
}
export const RANKING_SECTIONS = [
  "fundingPositive",
  "fundingNegative",
  "oiSurges",
  "premiumDislocations",
  "closedMarketDislocations",
] as const;
export type CloudRankings = Record<
  (typeof RANKING_SECTIONS)[number],
  CloudRankedMarket[]
>;
export interface CloudHistoryQuery {
  days?: number;
  from?: number | string;
  to?: number | string;
  resolution?: "auto" | HistoryResolution;
  limit?: number;
  signal?: AbortSignal;
}
export interface CloudPerpsClientLike {
  history(
    coin: string,
    query?: CloudHistoryQuery,
  ): Promise<CloudResult<CloudHistory>>;
  rankings(options?: {
    signal?: AbortSignal;
  }): Promise<CloudResult<CloudRankings>>;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const timestamp = (value: unknown): number | null => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(n) ? n : null;
};
const resolutionOf = (value: unknown): HistoryResolution | null =>
  ["minute", "hour", "day"].includes(String(value))
    ? (value as HistoryResolution)
    : null;
const classes: Record<string, AssetClass> = {
  stocks: "Stocks",
  indices: "Indices",
  energy: "Energy",
  metals: "Metals",
  fx: "FX",
  crypto: "Crypto",
  other: "Other",
};

export function cloudMarketId(coin: string): string {
  const value = coin.trim();
  if (!value || value.length > 160 || !/^[A-Za-z0-9_.,:/-]+$/.test(value))
    throw new Error("This market is not supported by cloud history.");
  if (value.startsWith("hyperliquid:")) {
    if (value.split(":").length !== 3)
      throw new Error("Invalid cloud market identifier.");
    return value;
  }
  if (value.includes(":")) {
    if (value.split(":").length !== 2)
      throw new Error("Invalid Hyperliquid market.");
    return `hyperliquid:${value}`;
  }
  return `hyperliquid:default:${value}`;
}
function coinFromId(id: string): string | null {
  const match = /^hyperliquid:([^:]+):(.+)$/.exec(id);
  return match
    ? match[1] === "default"
      ? match[2]!
      : `${match[1]}:${match[2]}`
    : null;
}
export function normalizeCloudHistory(raw: unknown): CloudHistory {
  const data = object(raw),
    from = timestamp(data.from),
    to = timestamp(data.to),
    resolution = resolutionOf(data.resolution);
  if (
    !text(data.marketId) ||
    from === null ||
    to === null ||
    from > to ||
    !resolution
  )
    throw new Error("Cloud history returned an invalid time range.");
  const points = rows(data.rows)
    .flatMap((value) => {
      const p = object(value),
        time = timestamp(p.time),
        firstObservedAt = timestamp(p.firstObservedAt),
        lastObservedAt = timestamp(p.lastObservedAt),
        actualResolution = resolutionOf(p.resolution);
      if (
        time === null ||
        firstObservedAt === null ||
        lastObservedAt === null ||
        !actualResolution
      )
        return [];
      return [
        {
          time,
          resolution: actualResolution,
          mark: numberOrNull(p.markPrice),
          oracle: numberOrNull(p.oraclePrice),
          premium: numberOrNull(p.premium),
          fundingRate: numberOrNull(p.fundingRate),
          fundingIntervalHours: numberOrNull(p.fundingIntervalHours),
          oiCoin: numberOrNull(p.openInterestBase),
          oiUsd: numberOrNull(p.openInterestUsd),
          sampleCount: Math.max(
            0,
            Math.trunc(numberOrNull(p.sampleCount) ?? 0),
          ),
          firstObservedAt,
          lastObservedAt,
        },
      ];
    })
    .sort((a, b) => a.time - b.time);
  const funding = rows(data.funding)
    .flatMap((value) => {
      const p = object(value),
        time = timestamp(p.time),
        rate = numberOrNull(p.rate),
        intervalHours = numberOrNull(p.intervalHours),
        observedAt = timestamp(p.observedAt);
      if (
        p.marketId !== data.marketId ||
        time === null ||
        rate === null ||
        intervalHours === null ||
        intervalHours <= 0 ||
        observedAt === null
      )
        return [];
      return [
        {
          time,
          rate,
          intervalHours,
          premium: numberOrNull(p.premium),
          observedAt,
          sourceUrl: text(p.sourceUrl),
        },
      ];
    })
    .sort((a, b) => a.time - b.time);
  const candles = rows(data.candles)
    .flatMap((value) => {
      const p = object(value),
        time = timestamp(p.time),
        observedAt = timestamp(p.observedAt);
      const open = numberOrNull(p.open),
        high = numberOrNull(p.high),
        low = numberOrNull(p.low),
        close = numberOrNull(p.close);
      if (
        p.marketId !== data.marketId ||
        time === null ||
        observedAt === null ||
        open === null ||
        high === null ||
        low === null ||
        close === null ||
        p.interval !== "1h"
      )
        return [];
      return [
        {
          time,
          observedAt,
          open,
          high,
          low,
          close,
          interval: "1h" as const,
          volume: numberOrNull(p.volumeBase),
          trades: numberOrNull(p.trades),
          sourceUrl: text(p.sourceUrl),
        },
      ];
    })
    .sort((a, b) => a.time - b.time);
  return {
    marketId: text(data.marketId),
    from,
    to,
    resolution,
    points,
    funding,
    candles,
    truncated: data.truncated === true,
  };
}
export function normalizeCloudRankings(raw: unknown): CloudRankings {
  const data = object(raw);
  const normalize = (value: unknown): CloudRankedMarket[] =>
    rows(value).flatMap((value) => {
      const p = object(value),
        marketId = text(p.marketId),
        coin = coinFromId(marketId),
        observedAt = timestamp(p.observedAt);
      // Optional cloud venues are independent integrations. This plugin displays Hyperliquid contracts only.
      if (p.venue !== "hyperliquid" || !coin || observedAt === null) return [];
      return [
        {
          marketId,
          coin,
          symbol: text(p.baseAsset) || coin.split(":").at(-1)!,
          dex: p.dex === "default" ? "" : text(p.dex),
          assetClass: classes[text(p.assetClass)] ?? "Other",
          displayName: text(p.displayName),
          mark: numberOrNull(p.markPrice),
          oracle: numberOrNull(p.oraclePrice),
          premium: numberOrNull(p.premium),
          fundingRate: numberOrNull(p.fundingRate),
          fundingIntervalHours: numberOrNull(p.fundingIntervalHours),
          fundingKind:
            p.fundingKind === "last-paid" || p.fundingKind === "continuous"
              ? p.fundingKind
              : ("current" as const),
          funding8h: numberOrNull(p.fundingRate8h),
          fundingApr: numberOrNull(p.fundingApr),
          oiCoin: numberOrNull(p.openInterestBase),
          oiUsd: numberOrNull(p.openInterestUsd),
          volume24h: numberOrNull(p.volume24hUsd),
          oiChange1h: numberOrNull(p.oiChange1h),
          oiChange24h: numberOrNull(p.oiChange24h),
          oiChange1hUsd: numberOrNull(p.oiUsdChange1h),
          oiChange24hUsd: numberOrNull(p.oiUsdChange24h),
          underlyingPremium: numberOrNull(p.underlyingPremium),
          closedMarketPremium: numberOrNull(p.closedMarketPremium),
          collateral: text(p.marginCurrency),
          observedAt,
          sourceAsOf: timestamp(p.sourceAsOf),
          sourceUrl: text(p.sourceUrl),
          qualityFlags: rows(p.qualityFlags).filter(
            (v): v is string => typeof v === "string",
          ),
          confidence:
            p.confidence === "high" || p.confidence === "medium"
              ? p.confidence
              : ("low" as const),
          stale: p.stale === true,
        },
      ];
    });
  return Object.fromEntries(
    RANKING_SECTIONS.map((key) => [
      key,
      normalize(data[key]).slice(0, data.access === "preview" ? 3 : undefined),
    ]),
  ) as CloudRankings;
}
/** Requests go through an injected transport; historical access is checked independently. */
export class CloudPerpsClient implements CloudPerpsClientLike {
  constructor(private options: CloudClientOptions = {}) {}
  async history(
    coin: string,
    query: CloudHistoryQuery = {},
  ): Promise<CloudResult<CloudHistory>> {
    if (query.signal?.aborted)
      throw (
        query.signal.reason ??
        new DOMException("Request cancelled", "AbortError")
      );
    if (this.options.network === "testnet")
      return this.failure(
        "testnet",
        "Cloud historical analytics cover mainnet. Live testnet trading data remains available.",
      );
    try {
      const marketId = cloudMarketId(coin),
        end = query.to === undefined ? Date.now() : timestamp(query.to),
        days = query.days ?? 7;
      if (!Number.isFinite(days) || days <= 0 || end === null)
        throw new Error("Choose a valid history range.");
      const start =
        query.from === undefined
          ? end - days * 86_400_000
          : timestamp(query.from);
      if (start === null || start > end)
        throw new Error("History start must precede its end.");
      const resolution = query.resolution ?? "auto",
        limit = query.limit ?? 2000;
      if (
        !["auto", "minute", "hour", "day"].includes(resolution) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 5000
      )
        throw new Error("Invalid history resolution or point limit.");
      const params = new URLSearchParams({
        marketId,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
        resolution,
        limit: String(limit),
      });
      return await this.load(
        `/cloud/perps/history?${params}`,
        normalizeCloudHistory,
        query.signal,
        true,
        marketId,
      );
    } catch (error) {
      if (query.signal?.aborted) throw error;
      return this.failure(
        "error",
        error instanceof Error
          ? error.message
          : "Could not load historical analytics.",
      );
    }
  }
  rankings(
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudResult<CloudRankings>> {
    return this.load(
      "/cloud/perps/rankings",
      normalizeCloudRankings,
      options.signal,
      false,
    );
  }
  private failure<T>(state: CloudState, error: string): CloudResult<T> {
    return {
      state,
      data: null,
      asOf: null,
      error,
      access: null,
      locked: state === "sign-in" || state === "pro-required",
    };
  }
  private async load<T>(
    path: string,
    normalize: (raw: unknown) => T,
    signal: AbortSignal | undefined,
    history: boolean,
    marketId?: string,
  ): Promise<CloudResult<T>> {
    if (signal?.aborted)
      throw (
        signal.reason ?? new DOMException("Request cancelled", "AbortError")
      );
    if (this.options.network === "testnet")
      return this.failure(
        "testnet",
        "Cloud historical analytics cover mainnet. Live testnet trading data remains available.",
      );
    if (!this.options.request)
      return this.failure(
        "host-unavailable",
        "This version of Gloom cannot connect plugins to Pro historical analytics yet.",
      );
    if (history && this.options.authenticationAvailable === false)
      return this.failure(
        "host-unavailable",
        "This version of Gloom cannot share your Cloud login with plugins. Pro history is unavailable here.",
      );
    try {
      const response = await this.options.request(path, { signal });
      if (signal?.aborted)
        throw signal.reason ?? new Error("Request cancelled");
      const raw = object(response.body),
        signedIn = this.options.signedIn?.() ?? false;
      if (
        [401, 402, 403].includes(response.status) &&
        this.options.authenticationAvailable === false
      )
        return this.failure(
          "host-unavailable",
          "This version of Gloom cannot share your Cloud login with plugins.",
        );
      if (response.status === 401)
        return this.failure(
          "sign-in",
          "Sign in to Gloom for Pro historical analytics.",
        );
      if (response.status === 402 || response.status === 403)
        return this.failure(
          signedIn ? "pro-required" : "sign-in",
          signedIn
            ? "Historical analytics require Gloom Pro."
            : "Sign in to Gloom for Pro historical analytics.",
        );
      if (
        response.status === 404 ||
        response.status === 503 ||
        raw.status === "unavailable"
      )
        return this.failure(
          "unavailable",
          "Cloud perpetual analytics are not available on this server yet.",
        );
      if (response.status < 200 || response.status >= 300)
        return this.failure(
          "error",
          `Cloud perpetual analytics request failed (${response.status}).`,
        );
      if (!["ok", "partial", "collecting"].includes(String(raw.status)))
        return this.failure(
          "unavailable",
          "Cloud perpetual analytics returned an unsupported response.",
        );
      const access =
        raw.access === "pro"
          ? "pro"
          : raw.access === "preview"
            ? "preview"
            : null;
      if (access === null)
        return this.failure(
          "error",
          "Cloud analytics did not report an entitlement.",
        );
      if (access === "pro" && this.options.authenticationAvailable === false)
        return this.failure(
          "error",
          "The anonymous cloud connection returned an unexpected entitlement.",
        );
      const locked = access !== "pro" || raw.locked === true;
      const hostUnavailable =
        locked && this.options.authenticationAvailable === false;
      const state: CloudState = hostUnavailable
        ? "host-unavailable"
        : locked
          ? signedIn
            ? "pro-required"
            : "sign-in"
          : raw.status === "collecting"
            ? "collecting"
            : raw.status === "partial"
              ? "partial"
              : "ready";
      if (history && marketId && raw.marketId !== marketId)
        return this.failure(
          "error",
          "Cloud history returned a different market.",
        );
      let data: T | null = null;
      try {
        data = history && locked ? null : normalize(raw);
      } catch {
        return this.failure(
          "error",
          "Cloud analytics returned invalid market data.",
        );
      }
      return {
        state,
        data,
        asOf: timestamp(raw.asOf),
        access,
        locked,
        error: hostUnavailable
          ? "Ranking preview. This version of Gloom cannot share your Cloud login with plugins."
          : locked
            ? signedIn
              ? "Historical analytics require Gloom Pro."
              : "Sign in to Gloom for Pro historical analytics."
            : raw.status === "collecting"
              ? "Cloud history is still collecting for this market."
              : null,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.failure(
        "unavailable",
        "Could not reach Gloom cloud historical analytics.",
      );
    }
  }
}

const anonymousRequest: CloudRequest = async (path, options) => {
  const { httpFetch } = await import("gloomberb/utils");
  const timeout = AbortSignal.timeout(10_000);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await httpFetch(`https://api.gloom.sh${path}`, {
    method: "GET",
    signal,
    credentials: "omit",
    redirect: "error",
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
};
const defaultConnection: Omit<CloudClientOptions, "network"> = {
  request: anonymousRequest,
  authenticationAvailable: false,
};
let connection = defaultConnection;
const clients = new Map<Network, CloudPerpsClient>();

/** A supported host connection can be installed without exposing its credentials. */
export function configureCloudPerpsClient(
  options: Omit<CloudClientOptions, "network"> | null,
): void {
  connection = options ?? defaultConnection;
  clients.clear();
}

/** Safe default until the host exposes an authenticated external-plugin request API. */
export function getCloudPerpsClient(network: Network): CloudPerpsClientLike {
  let client = clients.get(network);
  if (!client) {
    client = new CloudPerpsClient({ ...connection, network });
    clients.set(network, client);
  }
  return client;
}
