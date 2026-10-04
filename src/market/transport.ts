import type { LiveStatus, Network } from "./types.ts";
export const ENDPOINTS = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
} as const;
const lowWeight = new Set([
  "l2Book",
  "allMids",
  "clearinghouseState",
  "orderStatus",
  "spotClearinghouseState",
  "exchangeStatus",
]);
const historyWeight = new Set([
  "recentTrades",
  "historicalOrders",
  "userFills",
  "userFillsByTime",
  "fundingHistory",
  "userFunding",
  "nonUserFundingUpdates",
  "twapHistory",
  "userTwapSliceFills",
  "userTwapSliceFillsByTime",
  "delegatorHistory",
  "delegatorRewards",
  "validatorStats",
]);
export function infoWeight(body: Record<string, unknown>): number {
  return body.type === "userRole"
    ? 60
    : lowWeight.has(String(body.type))
      ? 2
      : 20;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export class InfoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InfoError";
  }
}
/** One sliding-window budget for all market and account reads. Keeps 300 weight/min for other clients. */
export class InfoClient {
  private spent: { time: number; weight: number }[] = [];
  private inFlight = 0;
  private cooldownUntil = 0;
  private pending = new Map<string, Promise<unknown>>();
  constructor(
    readonly network: Network,
    private fetcher: typeof fetch = fetch,
    private budget = 900,
  ) {}
  request<T>(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; weight?: number } = {},
  ): Promise<T> {
    const key = JSON.stringify(body);
    const existing = !options.signal && this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const promise = this.perform<T>(body, options);
    if (!options.signal) {
      this.pending.set(key, promise);
      void promise
        .finally(() => {
          if (this.pending.get(key) === promise) this.pending.delete(key);
        })
        .catch(() => {});
    }
    return promise;
  }
  private async reserve(weight: number, signal?: AbortSignal) {
    if (weight > this.budget)
      throw new Error("Request exceeds local REST weight budget");
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      const now = Date.now();
      this.spent = this.spent.filter((s) => now - s.time < 60_000);
      const used = this.spent.reduce((sum, s) => sum + s.weight, 0);
      if (
        this.inFlight < 3 &&
        used + weight <= this.budget &&
        now >= this.cooldownUntil
      ) {
        this.spent.push({ time: now, weight });
        this.inFlight++;
        return;
      }
      const wait =
        now < this.cooldownUntil
          ? this.cooldownUntil - now
          : used + weight > this.budget
            ? 60_010 - (now - (this.spent[0]?.time ?? now))
            : 25;
      await sleep(Math.max(25, Math.min(wait, 1000)), signal);
    }
  }
  private async perform<T>(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; weight?: number },
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.reserve(options.weight ?? infoWeight(body), options.signal);
      try {
        const timeout = AbortSignal.timeout(20_000);
        const response = await this.fetcher(`${ENDPOINTS[this.network]}/info`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: options.signal
            ? AbortSignal.any([options.signal, timeout])
            : timeout,
        });
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get("retry-after"));
          this.cooldownUntil =
            Date.now() +
            Math.max(
              Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
              2_000 * 2 ** attempt,
            );
          if (attempt < 2) continue;
        }
        if (!response.ok)
          throw new InfoError(
            `Hyperliquid ${String(body.type)}: ${response.status} ${(await response.text()).slice(0, 240)}`,
            response.status,
          );
        const result: T = await response.json();
        if (Array.isArray(result)) {
          const divisor =
            body.type === "candleSnapshot"
              ? 60
              : historyWeight.has(String(body.type))
                ? 20
                : 0;
          if (divisor)
            this.spent.push({
              time: Date.now(),
              weight: Math.ceil(result.length / divisor),
            });
        }
        return result;
      } finally {
        this.inFlight--;
      }
    }
    throw new InfoError("Hyperliquid rate limit exceeded", 429);
  }
}
export interface SocketLike {
  readyState: number;
  onopen: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsSubscription = { type: string; [key: string]: unknown };
type Subscriber = { handler: (data: any) => void; reconnect?: () => void };
type Entry = {
  subscription: WsSubscription;
  listeners: Set<Subscriber>;
  lastReceived: number;
  lastTimestamp: number;
  acknowledged: boolean;
};
function stableKey(subscription: WsSubscription): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(subscription)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
export interface StreamClock {
  now(): number;
  timeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  interval(callback: () => void, ms: number): ReturnType<typeof setInterval>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
  clearInterval(id: ReturnType<typeof setInterval>): void;
}
const streamClock: StreamClock = {
  now: () => Date.now(),
  timeout: (fn, ms) => setTimeout(fn, ms),
  interval: (fn, ms) => setInterval(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  clearInterval: (id) => clearInterval(id),
};
/** Single ref-counted socket. Public feed messages have no sequence numbers; timestamped snapshots reject regressions. */
export class SharedWebSocket {
  private entries = new Map<string, Entry>();
  private socket: SocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private opened = false;
  private lastMessage = 0;
  private connectedAt = 0;
  private status: LiveStatus = "idle";
  private statusListeners = new Set<() => void>();
  private lastError: string | null = null;
  constructor(
    readonly network: Network,
    private factory: (url: string) => SocketLike = (url) => new WebSocket(url),
    private timings = {
      heartbeat: 15_000,
      stale: 35_000,
      reconnect: 750,
      maxReconnect: 30_000,
    },
    private clock: StreamClock = streamClock,
  ) {}
  getStatus(): LiveStatus {
    return this.status;
  }
  getError(): string | null {
    return this.lastError;
  }
  getSubscriptionTime(subscription: WsSubscription): number | null {
    return this.entries.get(stableKey(subscription))?.lastReceived || null;
  }
  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  subscribe(
    subscription: WsSubscription,
    handler: (data: any) => void,
    onReconnect?: () => void,
  ): () => void {
    const key = stableKey(subscription);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 950)
        throw new Error("Hyperliquid subscription limit reached");
      const users = new Set(
        [...this.entries.values()]
          .map((e) => e.subscription.user)
          .filter(Boolean),
      );
      if (
        subscription.user &&
        !users.has(subscription.user) &&
        users.size >= 10
      )
        throw new Error("Hyperliquid supports at most 10 users per connection");
      // These payloads lack a user identifier. Mixing accounts would misroute private account data.
      if (
        ["orderUpdates", "userEvents", "notification"].includes(
          subscription.type,
        ) &&
        [...this.entries.values()].some(
          (e) =>
            e.subscription.type === subscription.type &&
            e.subscription.user !== subscription.user,
        )
      )
        throw new Error("This account stream already watches another address");
      if (
        subscription.type === "l2Book" &&
        [...this.entries.values()].some(
          (e) =>
            e.subscription.type === "l2Book" &&
            e.subscription.coin === subscription.coin,
        )
      )
        throw new Error("Book aggregation must be shared for this market");
      entry = {
        subscription,
        listeners: new Set(),
        lastReceived: 0,
        lastTimestamp: 0,
        acknowledged: false,
      };
      this.entries.set(key, entry);
      if (this.socket?.readyState === 1) this.send("subscribe", subscription);
    }
    const listener = { handler, reconnect: onReconnect };
    entry.listeners.add(listener);
    if (!this.socket && !this.reconnectTimer) this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(key);
      current?.listeners.delete(listener);
      if (current?.listeners.size === 0) {
        this.send("unsubscribe", subscription);
        this.entries.delete(key);
      }
      if (this.entries.size === 0) this.stop();
    };
  }
  /** Used by diagnostics and network recovery, never sends a trading action. */
  reconnect(): void {
    if (!this.entries.size) return;
    const old = this.socket;
    this.socket = null;
    old?.close();
    this.scheduleReconnect();
  }
  dispose(): void {
    this.entries.clear();
    this.stop();
    this.statusListeners.clear();
  }
  private setStatus(status: LiveStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const f of this.statusListeners) {
      try {
        f();
      } catch {}
    }
  }
  private send(method: string, subscription?: WsSubscription): void {
    if (this.socket?.readyState === 1) {
      try {
        this.socket.send(
          JSON.stringify(subscription ? { method, subscription } : { method }),
        );
      } catch {
        this.reconnect();
      }
    }
  }
  private connect(): void {
    if (!this.entries.size) return;
    this.setStatus(this.opened ? "reconnecting" : "connecting");
    let socket: SocketLike;
    try {
      socket = this.factory(
        `${ENDPOINTS[this.network].replace("https:", "wss:")}/ws`,
      );
    } catch (error) {
      this.lastError = String(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      const isReconnect = this.opened;
      this.opened = true;
      this.connectedAt = this.clock.now();
      this.lastMessage = this.clock.now();
      this.lastError = null;
      this.setStatus("live");
      for (const entry of this.entries.values()) {
        entry.lastTimestamp = 0;
        entry.acknowledged = false;
        this.send("subscribe", entry.subscription);
        if (isReconnect)
          for (const listener of entry.listeners) {
            try {
              listener.reconnect?.();
            } catch {}
          }
      }
      if (this.heartbeat) this.clock.clearInterval(this.heartbeat);
      this.heartbeat = this.clock.interval(() => {
        if (this.clock.now() - this.lastMessage > this.timings.stale) {
          this.setStatus("stale");
          this.reconnect();
        } else this.send("ping");
      }, this.timings.heartbeat);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.lastMessage = this.clock.now();
      if (this.lastMessage - this.connectedAt > 60_000) this.attempts = 0;
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.channel === "error") {
        this.lastError = String(message.data);
        this.setStatus("error");
        return;
      }
      if (message.channel === "pong") return;
      if (message.channel === "subscriptionResponse") {
        if (message.data?.method === "subscribe")
          for (const entry of this.entries.values()) {
            const actual = message.data.subscription;
            if (
              actual &&
              Object.entries(entry.subscription).every(
                ([key, value]) => (actual[key] ?? null) === (value ?? null),
              )
            )
              entry.acknowledged = true;
          }
        return;
      }
      const channel =
          message.channel === "user" ? "userEvents" : message.channel,
        data = message.data;
      for (const entry of this.entries.values()) {
        const s = entry.subscription;
        if (s.type !== channel) continue;
        // Book payloads do not identify aggregation. Ignore in-flight old snapshots until
        // the server acknowledges the replacement subscription.
        if (s.type === "l2Book" && !entry.acknowledged) continue;
        const coin =
          data?.coin ??
          data?.s ??
          (Array.isArray(data) ? data[0]?.coin : undefined);
        if (s.coin !== undefined && coin !== s.coin) continue;
        const interval =
          data?.i ?? (Array.isArray(data) ? data[0]?.i : undefined);
        if (s.interval !== undefined && interval !== s.interval) continue;
        if (
          s.user !== undefined &&
          data?.user !== undefined &&
          String(s.user).toLowerCase() !== String(data.user).toLowerCase()
        )
          continue;
        if (
          s.dex !== undefined &&
          data?.dex !== undefined &&
          s.dex !== data.dex
        )
          continue;
        const stamp = Number(data?.time ?? 0);
        if (stamp && stamp < entry.lastTimestamp) continue;
        if (stamp) entry.lastTimestamp = stamp;
        entry.lastReceived = this.clock.now();
        for (const listener of entry.listeners) {
          try {
            listener.handler(data);
          } catch (error) {
            this.lastError = `Stream data: ${String(error)}`;
          }
        }
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) {
        this.lastError = "Hyperliquid WebSocket connection failed";
        this.reconnect();
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleReconnect();
      }
    };
  }
  private scheduleReconnect(): void {
    if (this.heartbeat) {
      this.clock.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (!this.entries.size) {
      this.setStatus("idle");
      return;
    }
    if (this.reconnectTimer) return;
    this.setStatus("reconnecting");
    const delay =
      Math.min(
        this.timings.maxReconnect,
        this.timings.reconnect * 2 ** Math.min(this.attempts++, 8),
      ) *
      (0.8 + Math.random() * 0.4);
    this.reconnectTimer = this.clock.timeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  private stop(): void {
    if (this.reconnectTimer) this.clock.clearTimeout(this.reconnectTimer);
    if (this.heartbeat) this.clock.clearInterval(this.heartbeat);
    this.reconnectTimer = null;
    this.heartbeat = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.opened = false;
    this.attempts = 0;
    this.setStatus("idle");
  }
}
