import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hyperliquidCli } from "./cli";
import { KeyStore } from "./storage";
import { InfoClient, InfoError } from "../market/transport";
import { singleAttemptExchangeTransport } from "./exchange-transport";

test("preview, order and close distinguish failed or incomplete catalogs from an unknown market", async () => {
  const folder = await mkdtemp(join(tmpdir(), "hyperliquid-cli-catalog-"));
  const address = "0x1111111111111111111111111111111111111111";
  const rateLimit = "Hyperliquid rate limited the request. Retry in a minute.";
  const exitCode = process.exitCode ?? 0;
  let stderr = "",
    closed = 0;
  const err = spyOn(process.stderr, "write").mockImplementation((value) => {
    stderr += String(value);
    return true;
  });
  const network = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request"),
  );
  let mode = "limited";
  const info = spyOn(InfoClient.prototype, "request").mockImplementation(
    async (body) => {
      if (
        (mode === "limited" && body.type === "perpDexs") ||
        (mode === "unknown-predictions" && body.type === "predictedFundings") ||
        (mode === "partial" &&
          body.type === "metaAndAssetCtxs" &&
          body.dex === "xyz")
      )
        throw new InfoError(rateLimit, 429);
      if (body.type === "perpDexs")
        return (
          mode === "empty"
            ? []
            : mode === "partial"
              ? [null, { name: "xyz" }]
              : [null]
        ) as any;
      if (body.type === "spotMeta") return { tokens: [] } as any;
      if (body.type === "metaAndAssetCtxs")
        return [
          { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] },
          mode === "no-price" ? [] : [{ markPx: "60000" }],
        ] as any;
      return [] as any;
    },
  );
  try {
    await new KeyStore(join(folder, "hyperliquid"), "testnet").writeProfile({
      version: 1,
      mode: "watch",
      address,
    });
    for (const command of ["preview", "order", "close"]) {
      for (const [scenario, expected] of [
        ["limited", rateLimit],
        ["empty", "market catalog is unavailable"],
        ["partial", rateLimit],
        ["no-price", "price is unavailable"],
        ["unknown", "No active market matches"],
        ["unknown-predictions", "No active market matches"],
      ]) {
        mode = scenario!;
        stderr = "";
        process.exitCode = 0;
        await hyperliquidCli.execute(
          [
            command,
            "--network",
            "testnet",
            "--market",
            mode === "partial"
              ? "xyz:TSLA"
              : mode.startsWith("unknown")
                ? "MISSING"
                : "BTC",
            "--address",
            address,
            "--client-id",
            "catalog-test",
            "--yes",
          ],
          {
            cliOptions: {},
            initConfigData: async () => ({
              dataDir: folder,
              config: {},
              persistence: {
                close: () => {
                  closed++;
                },
              },
            }),
          } as any,
        );
        expect(stderr).toContain(expected!);
        expect(process.exitCode).toBe(1);
      }
    }
    expect(network).not.toHaveBeenCalled();
    expect(closed).toBe(18);
  } finally {
    process.exitCode = exitCode;
    err.mockRestore();
    network.mockRestore();
    info.mockRestore();
    await rm(folder, { recursive: true, force: true });
  }
});

test("HTTP 429 never retries the signed exchange transport", async () => {
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("Rate limited", {
      status: 429,
      headers: { "retry-after": "1" },
    }),
  );
  try {
    await expect(
      singleAttemptExchangeTransport("testnet").request("exchange", {}),
    ).rejects.toThrow("Exchange HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.hyperliquid-testnet.xyz/exchange",
    );
  } finally {
    fetcher.mockRestore();
  }
});
