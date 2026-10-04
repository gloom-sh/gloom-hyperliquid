import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTradingService } from "./service";

const user = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";

async function closeFixture(
  operation = "close",
  positionSize = "0.002",
  percent = 50,
) {
  const folder = await mkdtemp(join(tmpdir(), "hyperliquid-close-race-"));
  const pendingRisk = Promise.withResolvers<void>();
  const releaseRisk = Promise.withResolvers<void>();
  const sent: any[] = [];
  const handlers = new Map<string, (data: any) => void>();
  let reads = 0,
    subscribes = 0,
    releases = 0;
  const state = {
    marginSummary: { accountValue: "100", totalMarginUsed: "12" },
    crossMarginSummary: { accountValue: "100", totalMarginUsed: "12" },
    crossMaintenanceMarginUsed: "1.2",
    withdrawable: "88",
    assetPositions: [
      {
        position: {
          coin: "BTC",
          szi: positionSize,
          entryPx: "60000",
          positionValue: "120",
          leverage: { type: "cross", value: 10 },
        },
      },
    ],
    time: Date.now(),
  };
  const market = {
    coin: "BTC",
    assetId: 0,
    dex: "",
    szDecimals: 5,
    maxLeverage: 50,
    mark: 60000,
    collateral: "USDC",
    asOf: Date.now(),
  };
  const service = createTradingService({
    network: "testnet",
    dataDir: folder,
    shared: {
      info: {
        request: async (body) => {
          if (body.type === "clearinghouseState") {
            // Initialization, full position refresh, then the pre-send risk read.
            if (++reads === (operation === "submit" ? 2 : 3)) {
              pendingRisk.resolve();
              await releaseRisk.promise;
            }
            return state as any;
          }
          if (body.type === "spotClearinghouseState")
            return { balances: [] } as any;
          if (body.type === "userAbstraction") return "default" as any;
          if (body.type === "l2Book")
            return {
              levels: [[{ px: "59999", sz: "1" }], [{ px: "60001", sz: "1" }]],
            } as any;
          if (body.type === "userFees")
            return { userAddRate: "0.00015", userCrossRate: "0.00045" } as any;
          return [] as any;
        },
      },
      ws: {
        subscribe: (subscription, handler) => {
          handlers.set(String(subscription.type), handler);
          return () => handlers.delete(String(subscription.type));
        },
      },
      subscribe: () => {
        subscribes++;
        return () => {
          releases++;
        };
      },
      refresh: async () => {},
      getSnapshot: () =>
        ({
          markets: [market],
          dexes: [{ name: "", collateral: "USDC" }],
          asOf: Date.now(),
          status: "live",
        }) as any,
    },
  });
  await service.invoke("status");
  // No keys or network: keep the real lifecycle, AccountStore, preview and journal.
  const native = service as any;
  native.status.address = user;
  native.guard = async () => native.assertOpen();
  native.exchange = async () => {
    native.assertOpen();
    return {
      order: async (order: any) => {
        sent.push({
          address: service.getSnapshot().account?.address,
          ...order,
        });
        return {
          status: "ok",
          response: { type: "order", data: { statuses: [] } },
        };
      },
    };
  };
  await service.invoke("account");
  return {
    service,
    native,
    sent,
    pendingRisk,
    releaseRisk,
    releases: () => releases,
    subscribes: () => subscribes,
    update: () =>
      handlers.get("allDexsClearinghouseState")?.({
        clearinghouseStates: [["", { ...state, time: Date.now() }]],
      }),
    close: (clientId = "close-race") =>
      service.invoke(operation, {
        coin: "BTC",
        percent,
        kind: "market",
        expectedAddress: user,
        confirmed: true,
        clientId,
        ticket: {
          market,
          side: "sell",
          kind: "market",
          size: "0.001",
          sizeUnit: "coin",
          leverage: 10,
          marginMode: "cross",
          reduceOnly: true,
          clientId,
        },
      }),
    cleanup: async () => {
      releaseRisk.resolve();
      await service.dispose();
      await rm(folder, { recursive: true, force: true });
    },
  };
}

// Run the service's actual idle callback deterministically, without slowing the
// suite by 15 seconds. All other timers retain their normal behavior.
function idleClock() {
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const set = globalThis.setTimeout,
    clear = globalThis.clearTimeout;
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: any[]) => void,
    delay?: number,
    ...args: any[]
  ) => {
    const timer = set(callback, delay, ...args);
    if (delay === 15_000) timers.set(timer, () => callback(...args));
    return timer;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(
    (timer) => {
      timers.delete(timer as ReturnType<typeof setTimeout>);
      clear(timer as ReturnType<typeof setTimeout> | undefined);
    },
  );
  return {
    expire: () => {
      for (const [timer, callback] of [...timers]) {
        timers.delete(timer);
        clear(timer);
        callback();
      }
    },
    restore: () => {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

for (const [operation, idle] of [
  ["close", true],
  ["submit", true],
  ["closeAll", true],
  ["close", false],
  ["closeAll", false],
] as const) {
  test(`${operation} retains its account through ${idle ? "idle expiry" : "last pane removal"} and live updates`, async () => {
    const clock = idleClock();
    const f = await closeFixture(operation);
    try {
      const unsubscribe = idle ? undefined : f.service.subscribe(() => {});
      const closing = f.close();
      await f.pendingRisk.promise;
      await expect(
        f.service.invoke("watch", { address: other }),
      ).rejects.toThrow("before changing accounts");
      f.update();
      if (unsubscribe) unsubscribe();
      clock.expire();
      f.releaseRisk.resolve();
      expect((await closing).state).toBe("accepted");
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0].address).toBe(user);
      expect(f.sent[0].orders[0]).toMatchObject({
        b: false,
        r: true,
        s: operation === "closeAll" ? "0.002" : "0.001",
      });
      expect(f.releases()).toBe(0);
      // Completion must restore idle cleanup instead of retaining sockets forever.
      clock.expire();
      expect(f.releases()).toBe(1);
      expect(f.service.getSnapshot().account).toBeNull();
    } finally {
      await f.cleanup();
      clock.restore();
    }
  });
}

test("pending close still rejects a replaced account or forced shutdown without sending", async () => {
  for (const shutdown of [false, true]) {
    const f = await closeFixture();
    try {
      const closing = f.close();
      await f.pendingRisk.promise;
      if (shutdown) await f.service.dispose();
      else await f.native.accounts.setAddress(other);
      f.releaseRisk.resolve();
      await expect(closing).rejects.toThrow(
        "Account changed while checking collateral",
      );
      expect(f.sent).toHaveLength(0);
      expect(f.service.getSnapshot().account?.address).toBe(
        shutdown ? undefined : other,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("idle cleanup waits for the last concurrent request even when it fails", async () => {
  const clock = idleClock();
  const f = await closeFixture();
  try {
    const first = f.close();
    await f.pendingRisk.promise;
    expect((await f.close("second-close")).state).toBe("accepted");
    clock.expire();
    expect(f.releases()).toBe(0);
    expect(f.service.getSnapshot().account?.address).toBe(user);
    f.releaseRisk.reject(new Error("Collateral request failed"));
    await expect(first).rejects.toThrow("Collateral request failed");
    expect(f.sent).toHaveLength(1);
    clock.expire();
    expect(f.releases()).toBe(1);
    expect(f.service.getSnapshot().account).toBeNull();
  } finally {
    await f.cleanup();
    clock.restore();
  }
});

test("opening an account pane cancels an earlier headless idle timeout", async () => {
  const clock = idleClock();
  const f = await closeFixture();
  try {
    const unsubscribe = f.service.subscribe(() => {});
    clock.expire();
    expect(f.service.getSnapshot().account?.address).toBe(user);
    expect(f.releases()).toBe(0);
    unsubscribe();
    expect(f.releases()).toBe(1);
    // The queued subscription activation must not reopen an abandoned pane.
    await f.service.invoke("status");
    expect(f.subscribes()).toBe(1);
    expect(f.service.getSnapshot().account).toBeNull();
  } finally {
    await f.cleanup();
    clock.restore();
  }
});

test("full and partial closes preserve exact BTC lots for long and short positions", async () => {
  for (const [size, percent] of [
    ["0.00035", 100],
    ["0.0007", 50],
    ["-0.00035", 100],
  ] as const) {
    const f = await closeFixture("close", size, percent);
    try {
      const closing = f.close();
      await f.pendingRisk.promise;
      f.releaseRisk.resolve();
      expect((await closing).state).toBe("accepted");
      expect(f.sent[0].orders[0]).toMatchObject({
        b: size.startsWith("-"),
        r: true,
        s: "0.00035",
      });
    } finally {
      await f.cleanup();
    }
  }
});
