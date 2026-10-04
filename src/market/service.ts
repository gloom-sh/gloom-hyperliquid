import {
  applyContext,
  normalizeBook,
  normalizeCandle,
  normalizeMarkets,
  normalizePredicted,
  normalizeTrade,
  numberOrNull,
  resolveMarket,
} from "./normalize.ts";
import { InfoClient, SharedWebSocket } from "./transport.ts";
import type {
  AssetClass,
  BoardSnapshot,
  Candle,
  CandleInterval,
  Dex,
  Market,
  MarketOptions,
  MarketSession,
  MarketSnapshot,
  Network,
  OrderBook,
  PerpAnnotation,
  RawContext,
  RawDex,
  RawMeta,
  Trade,
} from "./types.ts";
export interface MarketServiceOptions {
  network: Network;
  fetch?: typeof fetch;
  info?: InfoClient;
  ws?: SharedWebSocket;
  pollIntervalMs?: number;
  batchMs?: number;
}
type BookConfig = { nSigFigs?: 2 | 3 | 4 | 5 | null; mantissa?: 1 | 2 | 5 };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const intervalMs = (interval: CandleInterval) => {
  const count = parseInt(interval);
  return (
    count *
    ({
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
      M: 2_678_400_000,
    }[interval.at(-1)!] ?? 60_000)
  );
};
export class MarketDataService {
  readonly network: Network;
  readonly info: InfoClient;
  readonly ws: SharedWebSocket;
  private snapshot: BoardSnapshot = {
    markets: [],
    dexes: [],
    status: "idle",
    asOf: null,
    error: null,
    predictedFundings: [],
  };
  private listeners = new Set<() => void>();
  private metas = new Map<string, RawMeta>();
  private categories = new Map<string, string>();
  private rawDexes: (RawDex | null)[] = [];
  private tokens = new Map<number, string>();
  private latestContexts = new Map<string, RawContext[]>();
  private contextTime = 0;
  private discoveryTime = 0;
  private predictionTime = 0;
  private refreshing: Promise<void> | null = null;
  private releases: (() => void)[] = [];
  private midReleases = new Map<string, () => void>();
  private poll: ReturnType<typeof setTimeout> | null = null;
  private health: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Map<string, DetailSession>();
  private books = new Map<string, BookResource>();
  private disposed = false;
  private readonly pollInterval: number;
  private readonly batchMs: number;
  constructor(options: MarketServiceOptions) {
    this.network = options.network;
    this.info = options.info ?? new InfoClient(options.network, options.fetch);
    this.ws = options.ws ?? new SharedWebSocket(options.network);
    this.pollInterval = options.pollIntervalMs ?? 30_000;
    this.batchMs = options.batchMs ?? 200;
  }
  getSnapshot = (): BoardSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) throw new Error("Market data service was disposed");
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetchBoard().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  getMarket(coin: string, options: MarketOptions = {}): MarketSession {
    const resolved = resolveMarket(this.snapshot.markets, coin)?.coin ?? coin;
    const interval = options.interval ?? "15m",
      key = `${resolved}|${interval}`;
    let session = this.sessions.get(key);
    if (!session) {
      session = new DetailSession(this, resolved, interval, this.batchMs);
      this.sessions.set(key, session);
    }
    if (options.nSigFigs !== undefined || options.mantissa !== undefined)
      this.setBookAggregation(resolved, options);
    return session;
  }
  setBookAggregation(coin: string, config: BookConfig): void {
    this.book(coin).setConfig(config);
  }
  book(coin: string): BookResource {
    let book = this.books.get(coin);
    if (!book) {
      book = new BookResource(this, coin);
      this.books.set(coin, book);
    }
    return book;
  }
  dispose(): void {
    this.disposed = true;
    for (const s of this.sessions.values()) s.dispose();
    for (const b of this.books.values()) b.dispose();
    this.listeners.clear();
    this.stop();
    this.ws.dispose();
  }
  private start(): void {
    this.patch({ status: "connecting" });
    this.releases.push(this.ws.onStatus(() => this.updateHealth()));
    this.releases.push(
      this.ws.subscribe(
        { type: "allDexsAssetCtxs" },
        (data) => this.receiveContexts(data),
        () => {
          void this.refresh();
        },
      ),
    );
    this.syncMids();
    void this.refresh().then(() => this.schedulePoll());
    this.health = setInterval(() => {
      this.updateHealth();
    }, 5_000);
  }
  private stop(): void {
    if (this.poll) clearTimeout(this.poll);
    if (this.health) clearInterval(this.health);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.poll = null;
    this.health = null;
    this.notifyTimer = null;
    for (const release of this.releases) release();
    this.releases = [];
    for (const release of this.midReleases.values()) release();
    this.midReleases.clear();
    this.snapshot = { ...this.snapshot, status: "idle" };
  }
  private schedulePoll(): void {
    if (!this.listeners.size || this.disposed) return;
    if (this.poll) clearTimeout(this.poll);
    // Discovery growth cannot silently exhaust the shared IP budget.
    const interval = Math.max(
      this.pollInterval,
      ((this.rawDexes.length * 20) / 450) * 60_000,
    );
    this.poll = setTimeout(() => {
      this.poll = null;
      void this.refresh().finally(() => this.schedulePoll());
    }, interval);
  }
  private updateHealth(): void {
    if (!this.listeners.size) return;
    const connection = this.ws.getStatus();
    const streamTime = this.ws.getSubscriptionTime({
      type: "allDexsAssetCtxs",
    });
    const stale =
      this.snapshot.asOf !== null &&
      (Date.now() - this.snapshot.asOf > 60_000 ||
        (streamTime !== null && Date.now() - streamTime > 60_000));
    const status =
      connection === "live"
        ? stale
          ? "stale"
          : this.snapshot.asOf === null
            ? "connecting"
            : "live"
        : connection;
    this.patch({
      status,
      ...(this.ws.getError() ? { error: this.ws.getError() } : {}),
    });
  }
  private patch(patch: Partial<BoardSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.notify();
  }
  private notify(): void {
    if (this.notifyTimer || !this.listeners.size) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      for (const fn of this.listeners) {
        try {
          fn();
        } catch {}
      }
    }, this.batchMs);
  }
  private async discover(): Promise<void> {
    const results = await Promise.allSettled([
      this.info.request<(RawDex | null)[]>({ type: "perpDexs" }),
      this.info.request<{ tokens: { index: number; name: string }[] }>({
        type: "spotMeta",
      }),
      this.info.request<[string, string][]>({ type: "perpCategories" }),
      this.info.request<RawMeta[]>({ type: "allPerpMetas" }),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    this.rawDexes = results[0].value;
    if (results[1].status === "fulfilled")
      this.tokens = new Map(
        results[1].value.tokens.map((t) => [t.index, t.name]),
      );
    if (results[2].status === "fulfilled")
      this.categories = new Map(results[2].value);
    if (results[3].status === "fulfilled")
      results[3].value.forEach((meta, index) => {
        const dex = this.rawDexes[index];
        if (dex !== undefined) this.metas.set(dex?.name ?? "", meta);
      });
    this.discoveryTime = Date.now();
    this.syncMids();
  }
  private syncMids(): void {
    if (!this.listeners.size) return;
    const wanted = new Set(this.rawDexes.map((d) => d?.name ?? ""));
    for (const [dex, release] of this.midReleases)
      if (!wanted.has(dex)) {
        release();
        this.midReleases.delete(dex);
      }
    for (const dex of wanted)
      if (!this.midReleases.has(dex)) {
        this.midReleases.set(
          dex,
          this.ws.subscribe({ type: "allMids", dex }, (data) => {
            if (!data?.mids) return;
            let changed = false;
            const markets = this.snapshot.markets.map((m) => {
              if (m.dex !== dex) return m;
              const mid = numberOrNull(data.mids[m.coin]);
              if (mid === null || mid === m.mid) return m;
              changed = true;
              return { ...m, mid };
            });
            if (changed) this.patch({ markets });
          }),
        );
      }
  }
  private async fetchBoard(): Promise<void> {
    try {
      if (!this.rawDexes.length || Date.now() - this.discoveryTime > 600_000)
        await this.discover();
      if (
        this.rawDexes.length > 20 &&
        this.metas.size === this.rawDexes.length
      ) {
        // Testnet has hundreds of deployer dexes. One aggregate stream snapshot is the only
        // way to discover all quotes promptly without spending several minutes of REST weight.
        await this.aggregateSnapshot();
        const now = Date.now();
        const dexes = this.rawDexes.map((raw, index) =>
          this.makeDex(raw, index, this.metas.get(raw?.name ?? "")!),
        );
        const markets = dexes.flatMap((dex) =>
          normalizeMarkets(
            this.metas.get(dex.name)!,
            this.latestContexts.get(dex.name) ?? [],
            dex,
            this.categories,
            now,
          ),
        );
        this.patch({
          markets,
          dexes,
          asOf: this.contextTime,
          error: null,
          status: this.listeners.size ? this.ws.getStatus() : "idle",
        });
        await this.fetchPredicted();
        return;
      }
      const started = Date.now();
      const results = await Promise.allSettled(
        this.rawDexes.map(async (raw, index) => {
          const name = raw?.name ?? "";
          const [meta, contexts] = await this.info.request<
            [RawMeta, RawContext[]]
          >({ type: "metaAndAssetCtxs", dex: name });
          this.metas.set(name, meta);
          const dex = this.makeDex(raw, index, meta);
          const previous = new Map(
            this.snapshot.markets
              .filter((m) => m.dex === name)
              .map((m) => [m.coin, m]),
          );
          const markets = normalizeMarkets(
            meta,
            contexts,
            dex,
            this.categories,
            Date.now(),
          ).map((m) => {
            const live = previous.get(m.coin);
            return live && live.asOf > started
              ? applyContext(
                  m,
                  {
                    markPx: live.mark ?? undefined,
                    oraclePx: live.oracle ?? undefined,
                    midPx: live.mid,
                    funding: live.fundingHourly ?? undefined,
                    premium: live.fundingPremium ?? undefined,
                    openInterest: live.oiCoin ?? undefined,
                    prevDayPx: live.prevDayPrice ?? undefined,
                    dayNtlVlm: live.volume24h ?? undefined,
                  },
                  live.asOf,
                )
              : m;
          });
          return { dex, markets };
        }),
      );
      const dexes: Dex[] = [],
        markets: Market[] = [],
        errors: string[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          dexes.push(r.value.dex);
          markets.push(...r.value.markets);
        } else {
          const name = this.rawDexes[i]?.name ?? "";
          errors.push(`${name || "Hyperliquid"}: ${message(r.reason)}`);
          const previous = this.snapshot.dexes.find((d) => d.name === name);
          if (previous) dexes.push(previous);
          markets.push(...this.snapshot.markets.filter((m) => m.dex === name));
        }
      });
      if (!markets.length && errors.length) throw new Error(errors.join("; "));
      this.patch({
        markets,
        dexes,
        asOf: markets.length
          ? Math.max(...markets.map((m) => m.asOf))
          : Date.now(),
        error: errors.length ? errors.join("; ") : null,
        status: this.listeners.size
          ? this.ws.getStatus() === "live"
            ? "live"
            : this.ws.getStatus()
          : "idle",
      });
      await this.fetchPredicted();
    } catch (error) {
      this.patch({
        error: message(error),
        status: this.snapshot.markets.length ? "stale" : "error",
      });
    }
  }
  private makeDex(raw: RawDex | null, index: number, meta: RawMeta): Dex {
    const token = meta.collateralToken ?? 0;
    return {
      name: raw?.name ?? "",
      fullName: raw?.fullName ?? "Hyperliquid",
      index,
      deployer: raw?.deployer ?? null,
      oracleUpdater: raw?.oracleUpdater ?? null,
      collateralToken: token,
      collateral: this.tokens.get(token) ?? `Token #${token}`,
      fundingMultipliers: Object.fromEntries(
        (raw?.assetToFundingMultiplier ?? []).map(([coin, m]) => [
          coin,
          Number(m),
        ]),
      ),
    };
  }
  private async fetchPredicted(): Promise<void> {
    if (Date.now() - this.predictionTime <= 60_000) return;
    try {
      const predicted = await this.info.request<unknown>({
        type: "predictedFundings",
      });
      this.predictionTime = Date.now();
      this.patch({ predictedFundings: normalizePredicted(predicted) });
    } catch (error) {
      this.patch({ error: `Predicted funding: ${message(error)}` });
    }
  }
  private async aggregateSnapshot(): Promise<void> {
    if (this.contextTime && Date.now() - this.contextTime < 15_000) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        release();
        reject(
          new Error(
            "Waiting for the aggregate market snapshot. The connection will retry.",
          ),
        );
      }, 20_000);
      const release = this.ws.subscribe(
        { type: "allDexsAssetCtxs" },
        (data) => {
          if (!Array.isArray(data?.ctxs)) return;
          this.receiveContexts(data);
          clearTimeout(timer);
          release();
          resolve();
        },
      );
    });
  }
  private receiveContexts(data: any): void {
    if (!Array.isArray(data?.ctxs)) return;
    const contexts = new Map<string, RawContext[]>(data.ctxs),
      now = Date.now();
    this.latestContexts = contexts;
    this.contextTime = now;
    const markets = this.snapshot.markets.map((m) => {
      const ctx = contexts.get(m.dex)?.[m.universeIndex];
      return ctx ? applyContext(m, ctx, now) : m;
    });
    if (markets.length) this.patch({ markets, asOf: now, status: "live" });
  }
}
class BookResource {
  private config: BookConfig = {};
  private value: OrderBook | null = null;
  private listeners = new Set<() => void>();
  private release: (() => void) | null = null;
  private generation = 0;
  error: string | null = null;
  constructor(
    private service: MarketDataService,
    private coin: string,
  ) {}
  getSnapshot(): OrderBook | null {
    return this.value;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.release?.();
        this.release = null;
      }
    };
  }
  setConfig(config: BookConfig): void {
    if (config.mantissa !== undefined && config.nSigFigs !== 5)
      throw new Error("Book mantissa requires 5 significant figures");
    const next = {
      nSigFigs: config.nSigFigs ?? null,
      ...(config.mantissa !== undefined ? { mantissa: config.mantissa } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(this.config)) return;
    this.config = next;
    this.generation++;
    this.value = null;
    this.release?.();
    this.release = null;
    if (this.listeners.size) this.start();
    this.emit();
  }
  async refresh(): Promise<void> {
    const generation = this.generation;
    try {
      const data = await this.service.info.request<any>({
        type: "l2Book",
        coin: this.coin,
        ...this.config,
      });
      if (generation === this.generation) this.accept(data);
    } catch (error) {
      this.error = message(error);
      this.emit();
    }
  }
  dispose(): void {
    this.release?.();
    this.release = null;
    this.listeners.clear();
  }
  private start(): void {
    const generation = this.generation;
    this.release = this.service.ws.subscribe(
      { type: "l2Book", coin: this.coin, ...this.config },
      (data) => {
        if (generation === this.generation) this.accept(data);
      },
      () => {
        void this.refresh();
      },
    );
    void this.refresh();
  }
  private accept(data: any): void {
    if (!data || data.coin !== this.coin) return;
    const book = normalizeBook(data);
    if (this.value && book.time < this.value.time) return;
    this.error = null;
    this.value = {
      ...book,
      nSigFigs: this.config.nSigFigs ?? null,
      mantissa: this.config.mantissa ?? null,
    };
    this.emit();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
class DetailSession implements MarketSession {
  private snapshot: MarketSnapshot = {
    market: null,
    book: null,
    candles: [],
    trades: [],
    annotation: null,
    status: "idle",
    asOf: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private releases: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<void> | null = null;
  private candleVersions = new Map<number, number>();
  constructor(
    private service: MarketDataService,
    private coin: string,
    private interval: CandleInterval,
    private batchMs: number,
  ) {}
  getSnapshot = (): MarketSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  dispose(): void {
    this.listeners.clear();
    this.stop();
  }
  private start(): void {
    const update = () => {
      const board = this.service.getSnapshot();
      this.patch({
        market: board.markets.find((m) => m.coin === this.coin) ?? null,
        status: board.status,
        asOf: board.asOf,
      });
    };
    this.releases.push(this.service.subscribe(update));
    update();
    const book = this.service.book(this.coin);
    this.releases.push(
      book.subscribe(() =>
        this.patch({
          book: book.getSnapshot(),
          ...(book.error ? { error: book.error } : {}),
        }),
      ),
    );
    this.releases.push(
      this.service.ws.subscribe(
        { type: "candle", coin: this.coin, interval: this.interval },
        (data) => {
          const rows = (Array.isArray(data) ? data : [data])
            .map(normalizeCandle)
            .filter((c): c is Candle => c !== null);
          const byTime = new Map(this.snapshot.candles.map((c) => [c.time, c]));
          for (const candle of rows) {
            const existing = byTime.get(candle.time);
            if (existing && candle.trades < existing.trades) continue;
            byTime.set(candle.time, candle);
            this.candleVersions.set(candle.time, Date.now());
          }
          this.patch({
            candles: [...byTime.values()]
              .sort((a, b) => a.time - b.time)
              .slice(-600),
          });
        },
        () => {
          void this.refresh();
        },
      ),
    );
    this.releases.push(
      this.service.ws.subscribe(
        { type: "trades", coin: this.coin },
        (data) => this.acceptTrades(data),
        () => {
          void this.refresh();
        },
      ),
    );
    void this.refresh();
  }
  private stop(): void {
    for (const release of this.releases) release();
    this.releases = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private patch(patch: Partial<MarketSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.timer || !this.listeners.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const listener of this.listeners) listener();
    }, this.batchMs);
  }
  private acceptTrades(data: any): void {
    if (!Array.isArray(data)) return;
    const trades = data
      .map(normalizeTrade)
      .filter((t): t is Trade => t !== null);
    const byId = new Map(
      [...this.snapshot.trades, ...trades].map((t) => [t.id, t]),
    );
    this.patch({
      trades: [...byId.values()]
        .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
        .slice(0, 120),
    });
  }
  private async fetch(): Promise<void> {
    if (!this.service.getSnapshot().markets.length)
      await this.service.refresh();
    const board = this.service.getSnapshot();
    this.patch({
      market: board.markets.find((m) => m.coin === this.coin) ?? null,
      status: board.status,
      asOf: board.asOf,
    });
    const started = Date.now();
    const results = await Promise.allSettled([
      this.service.info.request<any[]>({
        type: "candleSnapshot",
        req: {
          coin: this.coin,
          interval: this.interval,
          startTime: started - 600 * intervalMs(this.interval),
          endTime: started,
        },
      }),
      this.service.info.request<any[]>({
        type: "recentTrades",
        coin: this.coin,
      }),
      this.service.info.request<PerpAnnotation | null>({
        type: "perpAnnotation",
        coin: this.coin,
      }),
      this.service.book(this.coin).refresh(),
    ]);
    const errors: string[] = [];
    const candles = results[0];
    if (candles.status === "fulfilled") {
      const byTime = new Map(
        candles.value
          .map(normalizeCandle)
          .filter((c): c is Candle => c !== null)
          .map((c) => [c.time, c]),
      );
      for (const candle of this.snapshot.candles)
        if ((this.candleVersions.get(candle.time) ?? 0) >= started)
          byTime.set(candle.time, candle);
      this.patch({
        candles: [...byTime.values()]
          .sort((a, b) => a.time - b.time)
          .slice(-600),
      });
    } else errors.push(`Candles: ${message(candles.reason)}`);
    const trades = results[1];
    if (trades.status === "fulfilled") this.acceptTrades(trades.value);
    else errors.push(`Trades: ${message(trades.reason)}`);
    const annotation = results[2];
    if (annotation.status === "fulfilled")
      this.patch({ annotation: annotation.value });
    if (this.service.book(this.coin).error)
      errors.push(this.service.book(this.coin).error!);
    this.patch({
      book: this.service.book(this.coin).getSnapshot(),
      error: errors.length ? errors.join("; ") : null,
    });
  }
}
