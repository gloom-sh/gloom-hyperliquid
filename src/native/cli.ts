import type { CliCommandDef } from "gloomberb/types/plugin";
import { join } from "node:path";
import { createTradingService } from "./service";
import { connectWithMainWallet } from "./scripted-connect";
import {
  parseCliArgs,
  readSecretKey,
  redactCliError,
  type CliArgs,
} from "./cli-input";
import { MarketDataService } from "../market/service";
import { resolveMarket } from "../market/normalize";
import { configuredBuilder } from "../trading/builder";
import { readSettings, tradingSettings } from "../settings";
import type {
  TicketRequest,
  TradingResult,
  TradingStatus,
} from "../trading/types";

function required(flags: CliArgs["flags"], key: string): string {
  const value = flags[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing --${key}.`);
  return value;
}
function number(
  flags: CliArgs["flags"],
  key: string,
  fallback?: number,
): number {
  const value = flags[key] === undefined ? fallback : Number(flags[key]);
  if (value === undefined || !Number.isFinite(value))
    throw new Error(`Enter a valid --${key}.`);
  return value;
}
function choice<T extends string>(
  flags: CliArgs["flags"],
  key: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = flags[key] ?? fallback;
  if (!values.includes(value as T))
    throw new Error(`Choose --${key} ${values.join("|")}.`);
  return value as T;
}
const emit = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
function checkResult(result: unknown) {
  if (
    result &&
    typeof result === "object" &&
    "state" in result &&
    (result as TradingResult).state !== "accepted"
  )
    process.exitCode = 1;
}

export const hyperliquidCli: CliCommandDef = {
  name: "hyperliquid",
  description: "Manage a local Hyperliquid API wallet and trade explicitly",
  help: {
    usage: [
      "hyperliquid <status|account|import-key|connect-key|connect|wallet|disconnect|preview|order|cancel|close> --network <mainnet|testnet> [options]",
    ],
    options: [
      {
        flags: "--key-file PATH | --key-stdin",
        description:
          "Read secret only from an owner-only file or piped stdin. import-key: API wallet; connect-key: main wallet.",
      },
      {
        flags: "--address ADDRESS",
        description:
          "Required account address for import and every signed trading command.",
      },
      {
        flags: "--yes --acknowledge-risk --eligible",
        description:
          "Explicit consent for connection/import; --yes also required for orders, cancels, closes and disconnect.",
      },
      {
        flags:
          "--market COIN --side buy|sell --kind market|limit --size NUMBER --unit coin|usd|percent",
        description: "Preview/order ticket. Limit orders also require --price.",
      },
      {
        flags:
          "--tif Gtc|Alo|Ioc --leverage NUMBER --margin-mode cross|isolated --reduce-only",
        description: "Order policy (defaults: Alo, 1x, cross).",
      },
      {
        flags: "--client-id ID",
        description:
          "Required stable intent ID for order/cancel/close. Reuse after timeout; never blindly resend with a new ID.",
      },
      {
        flags: "--oid NUMBER | --all",
        description:
          "Cancel exactly one order, or explicitly all (optionally --market).",
      },
      {
        flags: "--percent NUMBER",
        description:
          "Close percentage, default 100. --kind limit requires --price.",
      },
      {
        flags: "--approval-port NUMBER",
        description:
          "Loopback approval server port (0=random); full token URL is printed.",
      },
      {
        flags: "--slippage-bps NUMBER",
        description: "IOC cap, otherwise the saved plugin setting.",
      },
    ],
    examples: [
      "hyperliquid status --network testnet",
      "hyperliquid preview --network testnet --market BTC --side buy --kind limit --price 10000 --size 20 --unit usd",
    ],
  },
  async execute(args, ctx) {
    let resources: Awaited<ReturnType<typeof ctx.initConfigData>> | undefined;
    let service: ReturnType<typeof createTradingService> | undefined;
    let shared: MarketDataService | undefined;
    try {
      const parsed = parseCliArgs(args),
        { command, flags, network } = parsed;
      const yes = flags.yes === true || ctx.cliOptions.yes === true;
      const connection = ["import-key", "connect-key", "connect"].includes(
        command,
      );
      if (
        ["order", "cancel", "close", "disconnect", "wallet"].includes(
          command,
        ) &&
        !yes
      )
        throw new Error(
          "This operation requires --yes after reviewing its parameters.",
        );
      if (
        connection &&
        (!yes || flags["acknowledge-risk"] !== true || flags.eligible !== true)
      )
        throw new Error(
          "Connection requires --yes --acknowledge-risk --eligible after reading the risks and Hyperliquid terms.",
        );
      if (["order", "cancel", "close"].includes(command)) {
        required(flags, "client-id");
        required(flags, "address");
      }
      resources = await ctx.initConfigData();
      const values = { ...resources.config.pluginConfig?.hyperliquid };
      if (flags["slippage-bps"] !== undefined) {
        const bps = number(flags, "slippage-bps");
        if (bps < 1 || bps > 2000)
          throw new Error("Slippage must be 1 to 2000 basis points.");
        values.slippageBps = bps;
      }
      const port = number(
        flags,
        "approval-port",
        readSettings(values).approvalPort,
      );
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error("Approval port must be 0 to 65535.");
      shared = new MarketDataService({ network });
      const options = {
        network,
        dataDir: join(resources.dataDir, "hyperliquid"),
        shared,
        settings: () => tradingSettings(values),
        approvalPort: port,
      };
      if (command === "connect-key") {
        const builder = configuredBuilder(network);
        process.stderr.write(
          `${network}: approve a new local trading API wallet${builder ? ` and Gloom's 0.1% builder fee (${builder.address})` : "; builder fee skipped"}. Main wallet key is not stored.\n`,
        );
        const key = await readSecretKey(flags);
        emit(
          await connectWithMainWallet(options, key, {
            risk: true,
            eligible: true,
          }),
        );
        return { kind: "handled" };
      }
      service = createTradingService(options);
      if (connection)
        await service.invoke("acknowledge", { risk: true, eligible: true });
      if (command === "import-key") {
        const address = required(flags, "address");
        const key = await readSecretKey(flags);
        emit(
          await service.invoke("import", {
            privateKey: key,
            address,
            ...(flags["expires-at"]
              ? { expiresAt: number(flags, "expires-at") }
              : {}),
          }),
        );
      } else if (command === "connect" || command === "wallet") {
        const session = await service.invoke(command);
        emit(session);
        process.stderr.write(
          "Approval page is bound to 127.0.0.1. Keep this command running while approving. Ctrl+C closes the page.\n",
        );
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        try {
          while (!controller.signal.aborted && Date.now() < session.expiresAt) {
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, 2000);
              controller.signal.addEventListener("abort", done, { once: true });
            });
            if (command === "connect") {
              const status = (await service.invoke(
                "connectionStatus",
              )) as TradingStatus;
              if (status.mode === "trading") {
                emit(status);
                break;
              }
            }
          }
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
      } else if (["status", "account", "disconnect"].includes(command))
        emit(await service.invoke(command));
      else {
        const status = (await service.invoke("status")) as TradingStatus;
        if (
          flags.address &&
          String(flags.address).toLowerCase() !== status.address?.toLowerCase()
        )
          throw new Error(
            "The requested account differs from the local connected account.",
          );
        const base = {
          clientId: flags["client-id"],
          confirmed: yes,
          expectedAddress: flags.address,
        };
        if (command === "cancel") {
          if (Boolean(flags.oid) === Boolean(flags.all))
            throw new Error(
              "Cancel requires exactly one of --oid NUMBER or --all.",
            );
          const oid = flags.oid ? number(flags, "oid") : undefined;
          if (oid !== undefined && (!Number.isSafeInteger(oid) || oid < 0))
            throw new Error("Invalid order id.");
          const result = await service.invoke("cancel", {
            ...base,
            oid,
            coin: flags.market,
          });
          emit(result);
          checkResult(result);
        } else {
          await shared.refresh();
          const market = resolveMarket(
            shared.getSnapshot().markets,
            required(flags, "market"),
          );
          if (!market || market.mark == null)
            throw new Error("No active market matches.");
          const kind = choice(
            flags,
            "kind",
            ["market", "limit"] as const,
            command === "close" ? "market" : "limit",
          );
          const limitPrice =
            kind === "limit" ? number(flags, "price") : undefined;
          if (command === "close") {
            const result = await service.invoke("close", {
              ...base,
              coin: market.coin,
              percent: number(flags, "percent", 100),
              kind,
              limitPrice,
            });
            emit(result);
            checkResult(result);
          } else {
            const ticket: TicketRequest = {
              market: {
                coin: market.coin,
                assetId: market.assetId,
                dex: market.dex,
                szDecimals: market.szDecimals,
                maxLeverage: market.maxLeverage,
                onlyIsolated: market.onlyIsolated,
                mark: market.mark,
              },
              side: choice(flags, "side", ["buy", "sell"]),
              kind,
              size: number(flags, "size"),
              sizeUnit: choice(
                flags,
                "unit",
                ["coin", "usd", "percent"],
                "usd",
              ),
              leverage: number(flags, "leverage", 1),
              marginMode: choice(
                flags,
                "margin-mode",
                ["cross", "isolated"],
                market.onlyIsolated ? "isolated" : "cross",
              ),
              limitPrice,
              tif: choice(flags, "tif", ["Gtc", "Alo", "Ioc"] as const, "Alo"),
              reduceOnly: flags["reduce-only"] === true,
              clientId:
                typeof flags["client-id"] === "string"
                  ? flags["client-id"]
                  : `preview-${crypto.randomUUID()}`,
            };
            const result = await service.invoke(
              command === "preview" ? "preview" : "submit",
              { ...base, ticket },
            );
            emit(result);
            checkResult(result);
          }
        }
      }
      return { kind: "handled" };
    } catch (error) {
      process.stderr.write(`${redactCliError(error)}\n`);
      process.exitCode = 1;
      return { kind: "handled" };
    } finally {
      await service?.dispose();
      shared?.dispose();
      resources?.persistence.close();
    }
  },
};
