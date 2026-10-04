/** Explicit smoke check: ephemeral, unfunded keys, testnet endpoints only. Never persists keys. */
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { roundPrice, roundSize } from "../trading/math";

if (import.meta.main) {
  const transport = new HttpTransport({ isTestnet: true });
  const master = privateKeyToAccount(generatePrivateKey()),
    agent = privateKeyToAccount(generatePrivateKey());
  const exchange = new ExchangeClient({ transport, wallet: master });
  const info = new InfoClient({ transport });
  const report: {
    network: string;
    funded: boolean;
    checks: Record<string, unknown>;
  } = { network: "testnet", funded: false, checks: {} };
  const attempt = async (name: string, send: () => Promise<unknown>) => {
    try {
      report.checks[name] = { outcome: "accepted", response: await send() };
    } catch (error) {
      report.checks[name] = {
        outcome: "rejected",
        message:
          error instanceof Error
            ? error.message.replace(/0x[0-9a-fA-F]{64}/g, "[redacted]")
            : "Request rejected",
      };
    }
  };
  const [meta, contexts] = await info.metaAndAssetCtxs();
  const asset = meta.universe.findIndex((m) => m.name === "BTC");
  const btc = meta.universe[asset]!,
    mark = Number(contexts[asset]!.markPx);
  await attempt("userSignedApproveAgent", () =>
    exchange.approveAgent({
      agentAddress: agent.address,
      agentName: `gloom testnet valid_until ${Date.now() + 3_600_000}`,
    }),
  );
  await attempt("l1UnfundedOrder", () =>
    exchange.order({
      orders: [
        {
          a: asset,
          b: true,
          p: roundPrice(mark * 0.99, btc.szDecimals),
          s: roundSize(20 / mark, btc.szDecimals),
          r: false,
          t: { limit: { tif: "Alo" } },
        },
      ],
      grouping: "na",
    }),
  );
  console.log(JSON.stringify(report, null, 2));
}
