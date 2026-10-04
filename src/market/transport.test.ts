import { describe, expect, test } from "bun:test";
import { InfoClient, InfoError, SharedWebSocket, infoWeight } from "./transport.ts";
import type { InfoClock, SocketLike, StreamClock } from "./transport.ts";
class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  sent: any[] = [];
  send(data: string) {
    const m = JSON.parse(data);
    this.sent.push(m);
    if (m.method === "subscribe") this.receive("subscriptionResponse", m);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(channel: string, data: any) {
    this.onmessage?.({ data: JSON.stringify({ channel, data }) });
  }
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
class FakeClock implements StreamClock {
  time = 1000;
  next = 1;
  jobs = new Map<
    number,
    { callback: () => void; at: number; repeat: number }
  >();
  now = () => this.time;
  timeout = (callback: () => void, ms: number) => {
    const id = this.next++;
    this.jobs.set(id, { callback, at: this.time + ms, repeat: 0 });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  interval = (callback: () => void, ms: number) => {
    const id = this.next++;
    this.jobs.set(id, { callback, at: this.time + ms, repeat: ms });
    return id as unknown as ReturnType<typeof setInterval>;
  };
  clearTimeout = (id: ReturnType<typeof setTimeout>) => {
    this.jobs.delete(id as unknown as number);
  };
  clearInterval = (id: ReturnType<typeof setInterval>) => {
    this.jobs.delete(id as unknown as number);
  };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const first = [...this.jobs]
        .filter(([, job]) => job.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      const [id, job] = first;
      this.time = job.at;
      if (job.repeat) job.at += job.repeat;
      else this.jobs.delete(id);
      job.callback();
    }
    this.time = end;
  }
}
function makeHub(
  timings = { heartbeat: 1000, stale: 2000, reconnect: 1, maxReconnect: 2 },
) {
  const sockets: FakeSocket[] = [];
  const clock = new FakeClock();
  const hub = new SharedWebSocket(
    "testnet",
    () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    timings,
    clock,
  );
  return { hub, sockets, clock };
}
function restClock(clock: FakeClock): InfoClock {
  return {
    now: clock.now,
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const abort = () => {
          clock.clearTimeout(timer);
          reject(signal?.reason);
        };
        const timer = clock.timeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
      }),
  };
}
async function flushMicrotasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
async function advanceRestClock(clock: FakeClock, ms: number) {
  const end = clock.time + ms;
  await flushMicrotasks();
  for (;;) {
    const next = Math.min(...[...clock.jobs.values()].map((job) => job.at));
    if (next > end) break;
    clock.advance(next - clock.time);
    await flushMicrotasks();
  }
  clock.advance(end - clock.time);
  await flushMicrotasks();
}
describe("shared WebSocket lifecycle", () => {
  test("deduplicates subscriptions and unsubscribes only when final listener closes", () => {
    const { hub, sockets } = makeHub();
    const received: number[] = [];
    const a = hub.subscribe({ type: "trades", coin: "BTC" }, () =>
      received.push(1),
    );
    const b = hub.subscribe({ coin: "BTC", type: "trades" }, () =>
      received.push(2),
    );
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.sent).toHaveLength(1);
    sockets[0]!.receive("trades", [{ coin: "BTC" }]);
    expect(received).toEqual([1, 2]);
    a();
    expect(sockets[0]!.sent).toHaveLength(1);
    b();
    expect(sockets[0]!.sent.at(-1)?.method).toBe("unsubscribe");
    expect(hub.getStatus()).toBe("idle");
    expect(sockets[0]!.readyState).toBe(3);
    hub.dispose();
  });
  test("reconnects, resubscribes, refetches and ignores superseded sockets", () => {
    const { hub, sockets, clock } = makeHub();
    let refetched = 0,
      updates = 0;
    const release = hub.subscribe(
      { type: "allDexsAssetCtxs" },
      () => updates++,
      () => refetched++,
    );
    sockets[0]!.open();
    expect(refetched).toBe(0);
    sockets[0]!.close();
    expect(hub.getStatus()).toBe("reconnecting");
    clock.advance(12);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(sockets[1]!.sent).toEqual([
      { method: "subscribe", subscription: { type: "allDexsAssetCtxs" } },
    ]);
    expect(refetched).toBe(1);
    sockets[0]!.receive("allDexsAssetCtxs", {});
    expect(updates).toBe(0);
    sockets[1]!.receive("allDexsAssetCtxs", {});
    expect(updates).toBe(1);
    release();
    hub.dispose();
  });
  test("rejects stale book timestamps and routes by coin without losing sibling streams", () => {
    const { hub, sockets } = makeHub();
    const times: number[] = [];
    let eth = 0;
    hub.subscribe({ type: "l2Book", coin: "BTC" }, (d) => times.push(d.time));
    hub.subscribe({ type: "l2Book", coin: "ETH" }, () => eth++);
    sockets[0]!.open();
    for (const time of [100, 99, 101])
      sockets[0]!.receive("l2Book", { coin: "BTC", time });
    expect(times).toEqual([100, 101]);
    expect(eth).toBe(0);
    hub.dispose();
  });
  test("book aggregation waits for the matching subscription acknowledgement", () => {
    const { hub, sockets } = makeHub();
    let updates = 0;
    const close = hub.subscribe(
      { type: "l2Book", coin: "BTC", nSigFigs: 3 },
      () => updates++,
    );
    sockets[0]!.open();
    sockets[0]!.receive("l2Book", { coin: "BTC", time: 1 });
    expect(updates).toBe(1);
    // Keep a different feed open while replacing the aggregation.
    hub.subscribe({ type: "trades", coin: "BTC" }, () => {});
    close();
    sockets[0]!.send = (data) => sockets[0]!.sent.push(JSON.parse(data));
    hub.subscribe(
      { type: "l2Book", coin: "BTC", nSigFigs: 5 },
      () => updates++,
    );
    sockets[0]!.receive("l2Book", { coin: "BTC", time: 2 });
    expect(updates).toBe(1);
    sockets[0]!.receive("subscriptionResponse", {
      method: "subscribe",
      subscription: {
        type: "l2Book",
        coin: "BTC",
        nSigFigs: 5,
        mantissa: null,
        fast: false,
      },
    });
    sockets[0]!.receive("l2Book", { coin: "BTC", time: 3 });
    expect(updates).toBe(2);
    hub.dispose();
  });
  test("silence triggers ping then reconnect, and final unsubscribe cancels backoff", () => {
    const { hub, sockets, clock } = makeHub({
      heartbeat: 5,
      stale: 12,
      reconnect: 10,
      maxReconnect: 10,
    });
    const release = hub.subscribe({ type: "allMids" }, () => {});
    sockets[0]!.open();
    clock.advance(22);
    expect(sockets[0]!.sent.some((m) => m.method === "ping")).toBe(true);
    expect(sockets[0]!.readyState).toBe(3);
    release();
    const count = sockets.length;
    clock.advance(25);
    expect(sockets).toHaveLength(count);
    hub.dispose();
  });
  test("prevents indistinguishable books and account packets being cross-routed", () => {
    const { hub } = makeHub();
    hub.subscribe({ type: "l2Book", coin: "BTC", nSigFigs: 3 }, () => {});
    expect(() =>
      hub.subscribe({ type: "l2Book", coin: "BTC", nSigFigs: 5 }, () => {}),
    ).toThrow("aggregation");
    hub.subscribe({ type: "orderUpdates", user: "0x1" }, () => {});
    expect(() =>
      hub.subscribe({ type: "orderUpdates", user: "0x2" }, () => {}),
    ).toThrow("another address");
    hub.dispose();
  });
});
describe("public REST transport", () => {
  const rateLimitMessage =
    "Hyperliquid rate limited the request. Retry in a minute.";
  test("uses documented weight classes and deduplicates concurrent reads", async () => {
    expect(infoWeight({ type: "l2Book" })).toBe(2);
    expect(infoWeight({ type: "userRole" })).toBe(60);
    expect(infoWeight({ type: "metaAndAssetCtxs" })).toBe(20);
    let requests = 0;
    const client = new InfoClient("testnet", (async (url: any) => {
      requests++;
      expect(String(url)).toBe("https://api.hyperliquid-testnet.xyz/info");
      await delay(5);
      return Response.json({ ok: true });
    }) as unknown as typeof fetch);
    const [a, b] = await Promise.all([
      client.request({ type: "meta" }),
      client.request({ type: "meta" }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(a).toBe(b);
    expect(requests).toBe(1);
  });
  test("aborted requests cannot wait forever in the local weight queue", async () => {
    const client = new InfoClient(
      "testnet",
      (async () => Response.json({})) as unknown as typeof fetch,
      20,
    );
    await client.request({ type: "meta" });
    const controller = new AbortController();
    const promise = client.request(
      { type: "spotMeta" },
      { signal: controller.signal },
    );
    controller.abort(new Error("Cancelled queue"));
    await expect(promise).rejects.toThrow("Cancelled queue");
  });
  for (const header of ["seconds", "date"] as const) {
    test(`recovers after 429 and honors Retry-After ${header}`, async () => {
      const clock = new FakeClock();
      const requests: number[] = [];
      const client = new InfoClient(
        "testnet",
        (async () => {
          requests.push(clock.now());
          return requests.length === 1
            ? new Response("busy", {
                status: 429,
                headers: {
                  "retry-after": header === "seconds"
                    ? "7"
                    : new Date(clock.now() + 7000).toUTCString(),
                },
              })
            : Response.json({ ok: true });
        }) as unknown as typeof fetch,
        900,
        restClock(clock),
      );
      const result = client.request({ type: "meta" });
      await advanceRestClock(clock, 6999);
      expect(requests).toEqual([1000]);
      await advanceRestClock(clock, 1);
      expect(await result).toEqual({ ok: true });
      expect(requests).toEqual([1000, 8000]);
    });
  }
  test("exhausts three attempts with bounded backoff and an actionable 429", async () => {
    const clock = new FakeClock();
    const requests: number[] = [];
    const client = new InfoClient(
      "testnet",
      (async () => {
        requests.push(clock.now());
        return new Response("provider details", {
          status: 429,
          headers: { "retry-after": "invalid" },
        });
      }) as unknown as typeof fetch,
      900,
      restClock(clock),
    );
    const result = client.request({ type: "meta" }).catch((error) => error);
    await advanceRestClock(clock, 6000);
    const error = await result;
    expect(error).toBeInstanceOf(InfoError);
    if (!(error instanceof InfoError)) throw error;
    expect(error.status).toBe(429);
    expect(error.message).toBe(rateLimitMessage);
    expect(requests).toEqual([1000, 3000, 7000]);
    expect(clock.jobs.size).toBe(0);
  });
  test("does not retry before a server cooldown beyond the bounded retry window", async () => {
    const clock = new FakeClock();
    let requests = 0;
    const client = new InfoClient(
      "testnet",
      (async () => {
        requests++;
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "120" },
        });
      }) as unknown as typeof fetch,
      900,
      restClock(clock),
    );
    await expect(client.request({ type: "meta" })).rejects.toThrow(rateLimitMessage);
    await expect(client.request({ type: "spotMeta" })).rejects.toThrow(rateLimitMessage);
    expect(requests).toBe(1);
    expect(clock.jobs.size).toBe(0);
  });
  test("allows a full minute Retry-After even when its timer wakes late", async () => {
    const clock = new FakeClock();
    const requests: number[] = [];
    const client = new InfoClient(
      "testnet",
      (async () => {
        requests.push(clock.now());
        return requests.length === 1
          ? new Response(null, {
              status: 429,
              headers: { "retry-after": "60" },
            })
          : Response.json({ ok: true });
      }) as unknown as typeof fetch,
      900,
      restClock(clock),
    );
    const result = client.request({ type: "meta" });
    await advanceRestClock(clock, 59_000);
    // Emulate a timer dispatched 5ms late, without rewinding the clock to its due time.
    clock.time += 1005;
    for (const [id, job] of [...clock.jobs]) {
      if (job.at > clock.time) continue;
      clock.jobs.delete(id);
      job.callback();
    }
    expect(await result).toEqual({ ok: true });
    expect(requests).toEqual([1000, 61005]);
  });
  test("local weight queueing before the first 429 does not consume the retry window", async () => {
    const clock = new FakeClock();
    const requests: number[] = [];
    const client = new InfoClient(
      "testnet",
      (async () => {
        requests.push(clock.now());
        return requests.length === 2
          ? new Response(null, { status: 429 })
          : Response.json({ ok: true });
      }) as unknown as typeof fetch,
      40,
      restClock(clock),
    );
    await client.request({ type: "bootstrap" }, { weight: 40 });
    const result = client.request({ type: "meta" });
    await advanceRestClock(clock, 60_000);
    expect(requests).toEqual([1000, 61000]);
    await advanceRestClock(clock, 2000);
    expect(await result).toEqual({ ok: true });
    expect(requests).toEqual([1000, 61000, 63000]);
  });
  test("a concurrent 429 cannot shorten a longer shared cooldown", async () => {
    const clock = new FakeClock();
    const requests: { type: string; time: number }[] = [];
    const client = new InfoClient(
      "testnet",
      (async (_url: unknown, init: RequestInit) => {
        const { type } = JSON.parse(String(init.body));
        const first = !requests.some((request) => request.type === type);
        requests.push({ type, time: clock.now() });
        return first
          ? new Response(null, {
              status: 429,
              headers: { "retry-after": type === "meta" ? "10" : "2" },
            })
          : Response.json({ type });
      }) as unknown as typeof fetch,
      900,
      restClock(clock),
    );
    const results = Promise.all([
      client.request({ type: "meta" }),
      client.request({ type: "spotMeta" }),
    ]);
    await advanceRestClock(clock, 9999);
    expect(requests).toHaveLength(2);
    await advanceRestClock(clock, 1);
    expect(await results).toEqual([{ type: "meta" }, { type: "spotMeta" }]);
    expect(requests.map((request) => request.time)).toEqual([1000, 1000, 11000, 11000]);
  });
  test("aborting during a rate-limit cooldown prevents another fetch", async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    let requests = 0;
    const client = new InfoClient(
      "testnet",
      (async () => {
        requests++;
        return new Response(null, { status: 429 });
      }) as unknown as typeof fetch,
      900,
      restClock(clock),
    );
    const result = client.request(
      { type: "meta" },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    expect(clock.jobs.size).toBe(1);
    controller.abort(new Error("Cancelled cooldown"));
    await expect(result).rejects.toThrow("Cancelled cooldown");
    await advanceRestClock(clock, 10_000);
    expect(requests).toBe(1);
    expect(clock.jobs.size).toBe(0);
  });
  test("does not retry other HTTP failures", async () => {
    let requests = 0;
    const client = new InfoClient("testnet", (async () => {
      requests++;
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch);
    await expect(client.request({ type: "meta" })).rejects.toThrow("503 unavailable");
    expect(requests).toBe(1);
  });
});
