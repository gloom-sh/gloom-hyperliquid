import { describe, expect, test } from "bun:test";
import { MarketDataService } from "./service.ts";
import { InfoClient, SharedWebSocket } from "./transport.ts";
import type { SocketLike } from "./transport.ts";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dexes = [null, { name: "xyz", fullName: "XYZ" }];
const context = {
  markPx: "100",
  oraclePx: "101",
  midPx: "102",
  funding: "0.00001",
  openInterest: "3",
  prevDayPx: "99",
  dayNtlVlm: "1000",
};
const metadata = (dex: string) => ({
  universe: [
    { name: dex ? "xyz:TSLA" : "BTC", maxLeverage: 20, szDecimals: 3 },
  ],
  collateralToken: dex ? 8 : 0,
});
function setup(count = 2) {
  const availableDexes =
    count === 2
      ? dexes
      : [
          null,
          ...Array.from({ length: count - 1 }, (_, i) => ({
            name: `dex${i}`,
            fullName: `Dex ${i}`,
          })),
        ];
  const requests: Record<string, unknown>[] = [];
  const sockets: FakeSocket[] = [];
  const info = new InfoClient("testnet", (async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    let response: any;
    switch (body.type) {
      case "perpDexs":
        response = availableDexes;
        break;
      case "allPerpMetas":
        response = availableDexes.map((d) => metadata(d?.name ?? ""));
        break;
      case "spotMeta":
        response = {
          tokens: [
            { index: 8, name: "USDH" },
            { index: 0, name: "USDC" },
          ],
        };
        break;
      case "perpCategories":
        response = [["xyz:TSLA", "stocks"]];
        break;
      case "metaAndAssetCtxs":
        response = [metadata(body.dex), [context]];
        break;
      case "predictedFundings":
        response = [];
        break;
      case "l2Book":
        response = {
          coin: body.coin,
          time: 100,
          levels: [
            [{ px: "99", sz: "3", n: 1 }],
            [{ px: "101", sz: "4", n: 1 }],
          ],
        };
        break;
      case "candleSnapshot":
        response = [
          {
            t: 0,
            T: 60_000,
            o: "100",
            h: "101",
            l: "98",
            c: "99",
            v: "5",
            n: 2,
          },
        ];
        break;
      case "recentTrades":
        response = [
          { coin: body.coin, time: 5, tid: 1, px: "99", sz: "2", side: "B" },
        ];
        break;
      case "perpAnnotation":
        response = {
          category: "stocks",
          description: "Public venue description",
        };
        break;
      default:
        throw new Error("Unexpected request " + body.type);
    }
    return Response.json(response);
  }) as unknown as typeof fetch);
  const ws = new SharedWebSocket("testnet", () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const service = new MarketDataService({
    network: "testnet",
    info,
    ws,
    batchMs: 5,
  });
  return { service, sockets, requests };
}
describe("market service data integration", () => {
  test("headless board/detail snapshots need no socket and collateral resolves token index, not array position", async () => {
    const { service, sockets } = setup();
    await service.refresh();
    const board = service.getSnapshot();
    expect(board.markets).toHaveLength(2);
    expect(board.markets[1]?.collateral).toBe("USDH");
    expect(board.markets[1]?.assetId).toBe(110000);
    const detail = service.getMarket("xyz:TSLA");
    await detail.refresh();
    const state = detail.getSnapshot();
    expect(state.market?.coin).toBe("xyz:TSLA");
    expect(state.candles[0]?.close).toBe(99);
    expect(state.book?.spread).toBe(2);
    expect(sockets).toHaveLength(0);
    service.dispose();
  });
  test("true mark ticks update OI USD while allMids changes only mid", async () => {
    const { service, sockets } = setup();
    const stop = service.subscribe(() => {});
    sockets[0]!.open();
    await service.refresh();
    sockets[0]!.receive("allMids", { mids: { BTC: "500", "xyz:TSLA": "600" } });
    expect(service.getSnapshot().markets[0]?.mark).toBe(100);
    expect(service.getSnapshot().markets[0]?.mid).toBe(500);
    sockets[0]!.receive("allDexsAssetCtxs", {
      ctxs: [
        ["", [{ ...context, markPx: "200", openInterest: "4" }]],
        ["xyz", [{ ...context, markPx: "300" }]],
      ],
    });
    expect(service.getSnapshot().markets[0]?.mark).toBe(200);
    expect(service.getSnapshot().markets[0]?.oiUsd).toBe(800);
    expect(service.getSnapshot().markets[1]?.mark).toBe(300);
    stop();
    service.dispose();
  });
  test("large dex universes bootstrap via aggregate contexts without per-dex REST fanout", async () => {
    const { service, sockets, requests } = setup(40);
    const stop = service.subscribe(() => {});
    sockets[0]!.open();
    sockets[0]!.receive("allDexsAssetCtxs", {
      ctxs: [
        ["", [context]],
        ...Array.from({ length: 39 }, (_, i) => [`dex${i}`, [context]]),
      ],
    });
    await service.refresh();
    expect(service.getSnapshot().dexes).toHaveLength(40);
    expect(service.getSnapshot().markets).toHaveLength(40);
    expect(requests.filter((r) => r.type === "metaAndAssetCtxs")).toHaveLength(
      0,
    );
    expect(requests.filter((r) => r.type === "allPerpMetas")).toHaveLength(1);
    stop();
    service.dispose();
  });
  test("two detail panes share one book, emit batches, dedupe trades and stop on last close", async () => {
    const { service, sockets } = setup();
    await service.refresh();
    let firstUpdates = 0,
      secondUpdates = 0;
    const first = service.getMarket("BTC", { interval: "1m" }),
      second = service.getMarket("BTC", { interval: "15m" });
    const closeFirst = first.subscribe(() => firstUpdates++),
      closeSecond = second.subscribe(() => secondUpdates++);
    sockets[0]!.open();
    await Promise.all([first.refresh(), second.refresh()]);
    expect(
      sockets[0]!.sent.filter(
        (m) => m.method === "subscribe" && m.subscription.type === "l2Book",
      ),
    ).toHaveLength(1);
    const trade = {
      coin: "BTC",
      time: 10,
      tid: 2,
      px: "101",
      sz: "1",
      side: "A",
    };
    sockets[0]!.receive("trades", [trade, trade]);
    sockets[0]!.receive("trades", [trade]);
    for (let i = 0; i < 20; i++)
      sockets[0]!.receive("l2Book", {
        coin: "BTC",
        time: 101 + i,
        levels: [[{ px: "99", sz: "3", n: 1 }], [{ px: "101", sz: "4", n: 1 }]],
      });
    await sleep(20);
    expect(first.getSnapshot().trades).toHaveLength(2);
    expect(firstUpdates).toBeLessThan(5);
    expect(secondUpdates).toBeLessThan(5);
    closeFirst();
    expect(sockets[0]!.readyState).toBe(1);
    closeSecond();
    expect(sockets[0]!.readyState).toBe(3);
    service.dispose();
  });
  test("book aggregation switches all same-market sessions together", async () => {
    const { service, sockets } = setup();
    await service.refresh();
    const first = service.getMarket("BTC", { interval: "1m" }),
      second = service.getMarket("BTC", { interval: "15m" });
    const a = first.subscribe(() => {}),
      b = second.subscribe(() => {});
    sockets[0]!.open();
    await first.refresh();
    service.setBookAggregation("BTC", { nSigFigs: 5, mantissa: 2 });
    await sleep(20);
    const subscriptions = sockets[0]!.sent.filter(
      (m) => m.subscription?.type === "l2Book",
    );
    expect(subscriptions.at(-2)?.method).toBe("unsubscribe");
    expect(subscriptions.at(-1)?.subscription.mantissa).toBe(2);
    expect(first.getSnapshot().book?.mantissa).toBe(2);
    expect(second.getSnapshot().book?.mantissa).toBe(2);
    a();
    b();
    service.dispose();
  });
});
