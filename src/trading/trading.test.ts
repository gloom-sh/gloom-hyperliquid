import { describe, expect, test } from "bun:test";
import { ExchangeClient } from "@nktkas/hyperliquid";
import {
  OrderRequest,
  ApproveAgentTypes,
} from "@nktkas/hyperliquid/api/exchange";
import {
  canonicalize,
  createL1ActionHash,
  signUserSignedAction,
} from "@nktkas/hyperliquid/signing";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSignature, zeroAddress } from "viem";
import { configuredBuilder } from "./builder";
import { perpFeeRates } from "./fees";
import {
  roundPrice,
  roundSize,
  isolatedLiquidation,
  maintenanceTier,
  estimateFill,
} from "./math";
import { previewTicket, clientOrderId } from "./orders";
import { AccountStore, normalizeBalances, availableForMarket } from "./account";
import { checkRegion } from "./regions";
import { walletAction, userSignedTypedData } from "./wallet-actions";
import {
  DEFAULT_TRADING_SETTINGS,
  type TradingMarket,
  type TicketRequest,
  type AccountSnapshot,
} from "./types";

const market: TradingMarket = {
  coin: "BTC",
  assetId: 0,
  dex: "",
  szDecimals: 5,
  maxLeverage: 40,
  onlyIsolated: false,
  mark: 60_000,
  collateral: "USDC",
};
const base: TicketRequest = {
  market,
  side: "buy",
  kind: "market",
  size: "0.01",
  sizeUnit: "coin",
  leverage: 10,
  marginMode: "cross",
  clientId: "test-intent",
};
const context = { available: 1000, makerRate: 0.00015, takerRate: 0.00045 };

describe("order safety and exchange precision", () => {
  test("floors size and keeps both buy and sell price caps with integer exception", () => {
    expect(roundSize("0.100009999999", 5)).toBe("0.1");
    expect(roundPrice("123456.9", 0)).toBe("123450");
    expect(roundPrice("123456", 0)).toBe("123456");
    expect(Number(roundPrice("123456.9", 0, "up"))).toBeGreaterThanOrEqual(
      123456.9,
    );
    expect(roundPrice("1.234567", 3, "down")).toBe("1.234");
    expect(roundPrice("1.234567", 3, "up")).toBe("1.235");
    expect(() => roundSize("0.000000001", 5)).toThrow();
    expect(() => roundPrice(Infinity, 5)).toThrow();
  });
  test("IOC market request, margin at mark, deterministic distinct cloids, attached reduce-only TP/SL", () => {
    const p = previewTicket(
      { ...base, takeProfit: 65_000, stopLoss: 55_000 },
      context,
    );
    expect(p.errors).toEqual([]);
    expect(p.marginRequired).toBe(60);
    expect(p.order?.grouping).toBe("normalTpsl");
    expect(p.order?.orders[0]?.t).toEqual({ limit: { tif: "Ioc" } });
    expect(p.order?.orders.slice(1).every((o) => o.r && !o.b)).toBe(true);
    expect(new Set(p.order?.orders.map((o) => o.c)).size).toBe(3);
    expect(p.order?.orders[0]?.c).toBe(clientOrderId(base.clientId));
    expect(p.order?.builder).toBeUndefined();
  });
  test("validates balance, reduce-only direction, invalid size and leverage", () => {
    expect(
      previewTicket({ ...base, size: 100 }, context).errors.join(),
    ).toContain("Insufficient");
    expect(
      previewTicket(
        { ...base, reduceOnly: true },
        { ...context, positionSize: 0.1 },
      ).errors.join(),
    ).toContain("side");
    expect(
      previewTicket(
        { ...base, side: "sell", reduceOnly: true, size: 0.2 },
        { ...context, positionSize: 0.1 },
      ).errors.join(),
    ).toContain("exceeds");
    expect(
      previewTicket({ ...base, size: "NaN" }, context).errors.length,
    ).toBeGreaterThan(0);
    expect(
      previewTicket({ ...base, leverage: 41 }, context).errors.length,
    ).toBeGreaterThan(0);
  });
  test("position brackets, scale per-leg minimum, TWAP constraints and fat finger warnings", () => {
    const position = previewTicket(
      { ...base, positionTpsl: true, takeProfit: 70_000, stopLoss: 50_000 },
      { ...context, positionSize: 0.01 },
    );
    expect(position.errors).toEqual([]);
    expect(position.order?.grouping).toBe("positionTpsl");
    expect(position.order?.orders.length).toBe(2);
    expect(
      previewTicket(
        {
          ...base,
          kind: "scale",
          size: 0.005,
          scaleStart: 60_000,
          scaleEnd: 61_000,
          scaleCount: 50,
        },
        context,
      ).errors,
    ).toContain("Each scale order must be at least $10.");
    expect(
      previewTicket({ ...base, kind: "twap", twapMinutes: 4 }, context).errors
        .length,
    ).toBeGreaterThan(0);
    expect(
      previewTicket({ ...base, kind: "limit", limitPrice: 90_000 }, context)
        .warnings.length,
    ).toBeGreaterThan(0);
  });
  test("scale USD budget includes every rung and stop trigger cannot fire immediately", () => {
    const small = { ...market, mark: 100, szDecimals: 2 };
    const scale = previewTicket(
      {
        ...base,
        market: small,
        kind: "scale",
        size: 1000,
        sizeUnit: "usd",
        scaleStart: 100,
        scaleEnd: 200,
        scaleCount: 5,
      },
      context,
    );
    expect(scale.errors).toEqual([]);
    expect(scale.notional).toBeLessThanOrEqual(1000);
    expect(scale.notional).toBeGreaterThan(990);
    expect(
      previewTicket(
        { ...base, kind: "stop-market", triggerPrice: 55_000 },
        context,
      ).errors.join(),
    ).toContain("trigger immediately");
    expect(
      previewTicket(
        { ...base, side: "sell", kind: "stop-market", triggerPrice: 65_000 },
        context,
      ).errors.join(),
    ).toContain("trigger immediately");
    const reverse = previewTicket(
      { ...base, side: "sell", size: 0.02 },
      { ...context, available: 1, positionSize: 0.01 },
    );
    expect(reverse.marginRequired).toBe(0);
    expect(reverse.errors).toEqual([]);
  });
  test("fee calculation preserves maker rebates and incorporates growth, referrals and aligned discounts", () => {
    const rates = perpFeeRates({
      maker: -0.00002,
      taker: 0.00045,
      referralDiscount: 0.1,
      deployerFeeScale: 2,
      growthMode: true,
      alignedCollateral: true,
    });
    expect(rates.maker).toBeCloseTo(-0.0000025, 10);
    expect(rates.taker).toBeCloseTo(0.0001458, 10);
  });
  test("builder cannot charge a placeholder, zero or testnet; valid address charges exactly 10bps", () => {
    const publicAddress = privateKeyToAccount(generatePrivateKey()).address;
    expect(configuredBuilder("mainnet")?.feeTenthsBps).toBe(100);
    expect(
      configuredBuilder("mainnet", "BUILDER_ADDRESS_PENDING"),
    ).toBeUndefined();
    expect(configuredBuilder("mainnet", "invalid")).toBeUndefined();
    expect(configuredBuilder("mainnet", zeroAddress)).toBeUndefined();
    expect(configuredBuilder("testnet", publicAddress)).toBeUndefined();
    const builder = configuredBuilder("mainnet", publicAddress)!;
    expect(builder.feeTenthsBps).toBe(100);
    const preview = previewTicket(base, context, {
      ...DEFAULT_TRADING_SETTINGS,
      builder,
    });
    expect(preview.builderFee).toBeCloseTo(preview.notional * 0.001, 10);
    expect(preview.order?.builder?.f).toBe(100);
  });
  test("liquidation uses maintenance tiers and order-book estimate stops at cap", () => {
    expect(isolatedLiquidation(60_000, 0.1, 600, true, market)).toBeCloseTo(
      (6000 - 600) / (0.1 * (1 - 1 / 80)),
      6,
    );
    const tiered = {
      ...market,
      marginTiers: [
        { lowerBound: 0, maxLeverage: 40 },
        { lowerBound: 100_000, maxLeverage: 20 },
      ],
    };
    expect(maintenanceTier(150_000, tiered)).toEqual({
      rate: 0.025,
      deduction: 1250,
    });
    expect(
      estimateFill(
        [
          { px: "100", sz: "2" },
          { px: "101", sz: "2" },
          { px: "103", sz: "9" },
        ],
        6,
        102,
        true,
      ),
    ).toEqual({ average: 100.5, unfilled: 2 });
  });
});

test("standard dex collateral stays isolated; unified collateral is shared without double-counting", () => {
  const state = (value: number, margin: number, maintenance: number) =>
    ({
      marginSummary: {
        accountValue: String(value),
        totalMarginUsed: String(margin),
      },
      crossMarginSummary: {
        accountValue: String(value),
        totalMarginUsed: String(margin),
      },
      crossMaintenanceMarginUsed: String(maintenance),
      withdrawable: String(value - margin),
      assetPositions: [],
      time: 1,
    }) as any;
  const states = new Map([
    ["", state(100, 10, 2)],
    ["xyz", state(100, 20, 3)],
    ["cash", state(900, 50, 10)],
  ]);
  const spot = {
    balances: [
      { coin: "USDC", token: 0, total: "200", hold: "30", entryNtl: "200" },
      { coin: "USDT", token: 1, total: "900", hold: "50", entryNtl: "900" },
    ],
  };
  const collateral = new Map([
    ["", "USDC"],
    ["xyz", "USDC"],
    ["cash", "USDT"],
  ]);
  const constrained = state(100, 25, 10);
  constrained.withdrawable = "0";
  const liquid = normalizeBalances(
    new Map([["", constrained]]),
    spot,
    "disabled",
  );
  expect(liquid.available).toBe(75);
  expect(liquid.withdrawable).toBe(0);
  const standard = normalizeBalances(states, spot, "disabled", collateral);
  expect(standard.accountValue).toBe(200);
  expect(standard.available).toBe(170);
  const unified = normalizeBalances(states, spot, "unifiedAccount", collateral);
  expect(unified.accountValue).toBe(200);
  expect(unified.available).toBe(170);
  expect(unified.crossMarginRatio).toBeCloseTo(5 / 200);
  expect(
    availableForMarket(
      { ...standard, abstraction: "disabled", spot } as AccountSnapshot,
      { ...market, dex: "xyz" },
    ),
  ).toBe(80);
  expect(
    availableForMarket(
      { ...unified, abstraction: "unifiedAccount", spot } as AccountSnapshot,
      { ...market, dex: "xyz" },
    ),
  ).toBe(170);
});

test("country gate fails closed for lookup failures and restricted locations", async () => {
  for (const country of ["US", "CA", "IR"])
    expect(
      (await checkRegion((async () => new Response(`loc=${country}\n`)) as any))
        .allowed,
    ).toBe(false);
  expect(
    (await checkRegion((async () => new Response("loc=DE\n")) as any)).allowed,
  ).toBe(true);
  expect(
    (
      await checkRegion((async () => {
        throw new Error("offline");
      }) as any)
    ).allowed,
  ).toBe(false);
});

test("concurrent views share account initialization without restarting subscriptions", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stateRequests = 0,
    subscriptions = 0;
  const state = {
    marginSummary: { accountValue: "100", totalMarginUsed: "0" },
    crossMarginSummary: { accountValue: "100", totalMarginUsed: "0" },
    crossMaintenanceMarginUsed: "0",
    withdrawable: "100",
    assetPositions: [],
    time: 1,
  };
  const store = new AccountStore("testnet", {
    info: {
      request: async (body) => {
        await barrier;
        if (body.type === "clearinghouseState") {
          stateRequests++;
          return state as any;
        }
        if (body.type === "spotClearinghouseState")
          return { balances: [] } as any;
        if (body.type === "userAbstraction") return "default" as any;
        return [] as any;
      },
    },
    ws: {
      subscribe: () => {
        subscriptions++;
        return () => {};
      },
    },
  });
  try {
    const address = "0x1111111111111111111111111111111111111111";
    const first = store.setAddress(address),
      before = subscriptions,
      second = store.setAddress(address);
    expect(subscriptions).toBe(before);
    release();
    const snapshots = await Promise.all([first, second]);
    expect(stateRequests).toBe(1);
    expect(snapshots[0].accountValue).toBe(100);
    expect(snapshots[1].error).toBeUndefined();
  } finally {
    store.stop();
  }
});

test("L1 submitted order signature matches independently signed EIP712 payload byte for byte", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const nonce = 1_770_000_000_001;
  let sent: any;
  const client = new ExchangeClient({
    wallet,
    nonceManager: () => nonce,
    transport: {
      isTestnet: true,
      async request<T>(_endpoint: string, payload: unknown) {
        sent = payload;
        return {
          status: "ok",
          response: {
            type: "order",
            data: { statuses: [{ resting: { oid: 1 } }] },
          },
        } as T;
      },
    },
  });
  const request = previewTicket(base, context).order!;
  await client.order(request);
  const action = canonicalize(OrderRequest.entries.action, {
    type: "order",
    ...request,
  });
  const connectionId = createL1ActionHash({ action, nonce });
  const signature = parseSignature(
    await wallet.signTypedData({
      domain: {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: zeroAddress,
      },
      types: {
        Agent: [
          { name: "source", type: "string" },
          { name: "connectionId", type: "bytes32" },
        ],
      },
      primaryType: "Agent",
      message: { source: "b", connectionId },
    }),
  );
  expect(sent.signature).toEqual({
    r: signature.r,
    s: signature.s,
    v: Number(signature.v),
  });
  expect(sent.action).toEqual(action);
  expect(sent.nonce).toBe(nonce);
});

test("main-wallet typed action matches SDK user-signed output without transmitting a signed request", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey()),
    agent = privateKeyToAccount(generatePrivateKey());
  const action = walletAction(
    "approveAgent",
    {
      agentAddress: agent.address.toLowerCase(),
      agentName: "gloom valid_until 1800000000000",
    },
    "testnet",
    1_770_000_000_001,
  );
  const ours = parseSignature(
    await wallet.signTypedData(userSignedTypedData(action, ApproveAgentTypes)),
  );
  const reference = await signUserSignedAction({
    wallet,
    action,
    types: ApproveAgentTypes,
  });
  expect(reference).toEqual({
    r: ours.r,
    s: ours.s,
    v: Number(ours.v) as 27 | 28,
  });
});
