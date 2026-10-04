import { describe, expect, test } from "bun:test";
import { previewTicket } from "../trading/orders";
import type { TicketRequest, TradingMarket } from "../trading/types";
import { placeError } from "./ticket-errors";

const market: TradingMarket = {
  coin: "BTC",
  assetId: 0,
  dex: "",
  szDecimals: 5,
  maxLeverage: 40,
  onlyIsolated: false,
  mark: 60_000,
  collateral: "USDC",
  marginTiers: [{ lowerBound: 0, maxLeverage: 40 }],
};
const base: TicketRequest = {
  market,
  side: "buy",
  kind: "market",
  size: 100,
  sizeUnit: "usd",
  leverage: 10,
  marginMode: "cross",
  clientId: "test-intent",
};
const context = { available: 1000, makerRate: 0.00015, takerRate: 0.00045 };

// The ticket finds where an error goes by the order builder's wording. If that
// wording changes, the error falls back to a generic button label and loses
// its field, so every message the ticket can produce must still match.
describe("ticket error placement", () => {
  const cases: [string, Partial<TicketRequest>][] = [
    ["empty size", { size: 0 }],
    ["below the minimum", { size: 5 }],
    ["more than the collateral", { size: 50_000 }],
    ["over 100% of buying power", { sizeUnit: "percent", size: 150 }],
    ["missing limit price", { kind: "limit", limitPrice: 0 }],
    ["missing trigger", { kind: "stop-market", triggerPrice: 0 }],
    [
      "trigger on the wrong side",
      { kind: "stop-market", triggerPrice: 50_000 },
    ],
    ["take profit below a long", { takeProfit: 50_000 }],
    ["stop loss above a long", { stopLoss: 70_000 }],
    ["reduce only without a position", { reduceOnly: true }],
    ["leverage above the market", { leverage: 50 }],
    ["isolated-only market", { market: { ...market, onlyIsolated: true } }],
    ["short TWAP", { kind: "twap", twapMinutes: 1 }],
    ["TP/SL on a TWAP", { kind: "twap", twapMinutes: 30, takeProfit: 70_000 }],
    ["scale without prices", { kind: "scale", scaleCount: 5 }],
    [
      "TP/SL on a scale",
      {
        kind: "scale",
        scaleStart: 59_000,
        scaleEnd: 58_000,
        scaleCount: 5,
        takeProfit: 70_000,
      },
    ],
  ];
  test.each(cases)("%s has a place", (_, change) => {
    const ticket = { ...base, ...change };
    const { errors } = previewTicket(ticket, context);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors)
      expect(placeError(error, ticket.kind).short).not.toBe(
        "Cannot place order",
      );
  });

  test("a scale order asks for its prices, not a limit price", () => {
    const { errors } = previewTicket(
      { ...base, kind: "scale", scaleCount: 5 },
      context,
    );
    expect(placeError(errors[0]!, "scale")).toEqual({
      place: "scaleStart",
      short: "Enter scale prices",
      quiet: true,
    });
  });
});
