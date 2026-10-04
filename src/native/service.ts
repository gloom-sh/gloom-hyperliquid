import { ExchangeClient } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, isAddress } from "viem";
import type {
  OrderParameters,
  ModifyParameters,
} from "@nktkas/hyperliquid/api/exchange";
import { AccountStore, availableForMarket } from "../trading/account";
import { configuredBuilder } from "../trading/builder";
import { previewTicket } from "../trading/orders";
import { checkRegion, REGION_POLICY } from "../trading/regions";
import {
  DEFAULT_TRADING_SETTINGS,
  type AccountSnapshot,
  type Address,
  type Network,
  type SharedTransport,
  type TicketRequest,
  type TradingMarket,
  type TradingOperation,
  type TradingResult,
  type TradingSettings,
  type TradingStatus,
} from "../trading/types";
import { KeyStore } from "./storage";
import { LocalTwapScheduler, type LocalTwapJob } from "./twap";
import { approveApiWallet } from "./main-wallet";
import { singleAttemptExchangeTransport } from "./exchange-transport";
import { startWalletPage } from "./wallet-page";

export interface TradingServiceOptions {
  network: Network;
  dataDir: string;
  shared: SharedTransport;
  settings?: () => TradingSettings;
  approvalPort?: number | (() => number);
}
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/0x[0-9a-fA-F]{64}/g, "[redacted]").slice(0, 600)
    : "Trading request failed.";
const address = (value: unknown): Address => {
  if (typeof value !== "string" || !isAddress(value))
    throw new Error("Enter a valid 0x wallet address.");
  return getAddress(value);
};

export function createTradingService(options: TradingServiceOptions) {
  return new TradingService(options);
}
export class TradingService {
  private store: KeyStore;
  private accounts: AccountStore;
  private status: TradingStatus;
  private ready: Promise<void>;
  private twaps: LocalTwapScheduler;
  private lastSnapshotAccount?: AccountSnapshot | null;
  private walletPage?: ReturnType<typeof startWalletPage>;
  private results = new Map<string, TradingResult>();
  private pending = new Map<string, Promise<TradingResult>>();
  private listeners = new Set<() => void>();
  private closed = false;
  private markets = new Map<string, TradingMarket>();
  private marketTime = 0;
  private marketAsOf = new Map<string, number>();
  private poll?: ReturnType<typeof setInterval>;
  private lastRoleCheck = 0;
  private roleCheck?: Promise<TradingStatus>;
  private marketRelease?: () => void;
  private lease?: ReturnType<typeof setTimeout>;
  private signedInFlight = 0;
  private transitioning = false;
  private builderChecked = 0;
  private snapshotCache?: {
    status: TradingStatus;
    account: AccountSnapshot | null;
  };
  constructor(private options: TradingServiceOptions) {
    this.store = new KeyStore(options.dataDir, options.network);
    this.accounts = new AccountStore(options.network, options.shared);
    this.status = {
      network: options.network,
      mode: "disconnected",
      riskAcknowledged: false,
      eligibleAcknowledged: false,
    };
    this.accounts.subscribe(() => this.emit());
    this.twaps = new LocalTwapScheduler({
      read: () => this.store.readJson<LocalTwapJob[]>("local-twaps.json", []),
      write: (jobs) => this.store.writeJson("local-twaps.json", jobs),
      acquire: (id) => this.store.acquireTwapLease(id),
      execute: (ticket) =>
        this.invoke("submit", {
          ticket,
          confirmed: true,
          expectedAddress: ticket.accountAddress,
        }),
      mark: async (coin) => (await this.market(coin)).mark,
      onChange: () => {
        this.emit();
        if (this.twaps?.getJobs().some((j) => j.status === "running"))
          void this.activate()?.catch((error) => {
            this.status.error = errorText(error);
            this.emit();
          });
        else if (!this.listeners.size && !this.lease) this.suspend();
      },
    });
    this.ready = Promise.all([this.initialize(), this.twaps.ready]).then(
      () => {},
    );
  }
  private async initialize() {
    const profile = await this.store.readProfile();
    Object.assign(this.status, profile);
    this.results = new Map(
      (
        await this.store.readJson<[string, TradingResult][]>("intents.json", [])
      ).slice(-500),
    );
    this.emit();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    void this.ready
      .then(() => this.activate())
      .catch((error) => {
        this.status.error = errorText(error);
        this.emit();
      });
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.suspend();
    };
  }
  private withTwaps(account: AccountSnapshot) {
    return {
      ...account,
      twaps: [...account.twaps, ...this.twaps.rows(account.address)],
    };
  }
  getSnapshot() {
    const account = this.accounts.getSnapshot() ?? null;
    if (this.lastSnapshotAccount !== account) this.snapshotCache = undefined;
    this.lastSnapshotAccount = account;
    return (
      this.snapshotCache ??
      (this.snapshotCache = {
        status: { ...this.status },
        account: account ? this.withTwaps(account) : null,
      })
    );
  }
  private assertOpen() {
    if (this.closed) {
      const error = new Error(
        "Trading service is closed. Reopen the plugin before submitting another request.",
      );
      error.name = "RequestNotSentError";
      throw error;
    }
  }
  private activate() {
    if (this.closed || !this.status.address) return;
    if (!this.marketRelease)
      this.marketRelease = this.options.shared.subscribe?.(() => {});
    if (this.status.address)
      return this.accounts.setAddress(this.status.address);
  }
  private suspend(force = false) {
    if (!force && this.twaps?.getJobs().some((j) => j.status === "running"))
      return;
    if (this.lease) clearTimeout(this.lease);
    this.lease = undefined;
    this.marketRelease?.();
    this.marketRelease = undefined;
    this.accounts.stop();
  }
  private touch() {
    this.assertOpen();
    if (!this.listeners.size) {
      if (this.lease) clearTimeout(this.lease);
      this.lease = setTimeout(() => this.suspend(), 15_000);
      this.lease.unref();
    }
    return this.activate();
  }
  private emit() {
    this.snapshotCache = undefined;
    for (const listener of this.listeners) listener();
  }
  private settings(): TradingSettings {
    return {
      ...DEFAULT_TRADING_SETTINGS,
      ...this.options.settings?.(),
      builder: configuredBuilder(this.options.network),
    };
  }
  private async persist() {
    const { network, region, error, ...profile } = this.status;
    await this.store.writeProfile({ version: 1, ...profile });
    this.emit();
  }
  private async region() {
    if (
      !this.status.region ||
      Date.now() - this.status.region.checkedAt > REGION_POLICY.maxAgeMs
    )
      this.status.region = await checkRegion();
    return this.status.region;
  }
  private async guard(requireKey = true) {
    this.assertOpen();
    if (!this.status.riskAcknowledged)
      throw new Error(
        "Acknowledge leveraged trading risks before enabling trading.",
      );
    if (!this.status.eligibleAcknowledged)
      throw new Error(
        "Confirm you are not a restricted person under Hyperliquid terms.",
      );
    const region = await this.region();
    this.assertOpen();
    if (!region.allowed)
      throw new Error(region.reason ?? "Trading unavailable in this region.");
    if (requireKey) {
      if (this.status.mode !== "trading" || !this.status.storage)
        throw new Error("Connect an approved trading wallet first.");
      if (!this.status.expiresAt || this.status.expiresAt <= Date.now())
        throw new Error("Trading approval expired. Reconnect your wallet.");
      const builder = this.settings().builder;
      if (builder && Date.now() - this.builderChecked > 60_000) {
        const fee = await this.options.shared.info.request<number>({
          type: "maxBuilderFee",
          user: this.status.address,
          builder: builder.address,
        });
        if (fee < builder.feeTenthsBps)
          throw new Error(
            "Approve Gloom's 0.1% builder fee from Wallet management before trading.",
          );
        this.builderChecked = Date.now();
      }
    }
  }
  private async exchange() {
    await this.guard();
    const key = await this.store.readKey(this.status.storage!);
    this.assertOpen();
    const wallet = privateKeyToAccount(key);
    if (
      wallet.address.toLowerCase() !== this.status.agentAddress?.toLowerCase()
    )
      throw new Error(
        "The local API wallet changed in another process. Reopen the connection before trading.",
      );
    const network = this.options.network;
    return new ExchangeClient({
      wallet,
      nonceManager: () => this.store.nextNonce(),
      defaultExpiresAfter: () => Date.now() + 30_000,
      transport: singleAttemptExchangeTransport(network, () =>
        this.assertOpen(),
      ),
    });
  }

  private async loadMarkets(force = false) {
    const shared = this.options.shared;
    if (!shared.getSnapshot || !shared.refresh)
      throw new Error("Shared market service is unavailable.");
    let snapshot = shared.getSnapshot();
    if (
      !snapshot.markets.length ||
      !snapshot.asOf ||
      Date.now() - snapshot.asOf > 60_000
    ) {
      await shared.refresh();
      snapshot = shared.getSnapshot();
    }
    if (
      !snapshot.markets.length ||
      !snapshot.asOf ||
      Date.now() - snapshot.asOf > 60_000
    )
      throw new Error(
        "Market data is stale. Wait for live prices before trading.",
      );
    this.markets = new Map(
      snapshot.markets
        .filter((m) => m.mark !== null)
        .map((m) => [
          m.coin,
          {
            coin: m.coin,
            assetId: m.assetId,
            dex: m.dex,
            szDecimals: m.szDecimals,
            maxLeverage: m.maxLeverage,
            onlyIsolated: m.onlyIsolated,
            marginMode: m.marginMode,
            mark: m.mark!,
            collateral: m.collateral,
            marginTiers: m.marginTiers,
            deployerFeeScale: m.deployerFeeScale ?? (m.dex ? 1 : 0),
            growthMode: m.growthMode === "enabled",
            alignedCollateral: (m as any).alignedCollateral ?? false,
          },
        ]),
    );
    this.marketAsOf = new Map(snapshot.markets.map((m) => [m.coin, m.asOf]));
    if (["stale", "reconnecting", "error"].includes(snapshot.status))
      throw new Error(
        "Market connection is stale or reconnecting. Wait before trading.",
      );
    this.marketTime = Date.now();
  }
  private async market(coin: string) {
    await this.loadMarkets();
    const result = this.markets.get(coin);
    if (!result) throw new Error("Market is unavailable or delisted.");
    if (Date.now() - (this.marketAsOf.get(coin) ?? 0) > 60_000)
      throw new Error(
        "This market price is stale. Wait for a new market update.",
      );
    return result;
  }
  private async account() {
    await this.touch();
    if (!this.status.address)
      throw new Error("Add a watch-only address or connect your wallet.");
    return this.withTwaps(
      this.accounts.getSnapshot() ??
        (await this.accounts.setAddress(this.status.address)),
    );
  }
  private async preview(input: TicketRequest, force = false) {
    if (force) await this.loadMarkets(true);
    const market = await this.market(input.market.coin);
    await this.account();
    const snapshot = force
      ? await this.accounts.refreshRisk(market.dex)
      : await this.account();
    const position = snapshot.positions.find((p) => p.coin === market.coin);
    const book = await this.options.shared.info.request<any>({
      type: "l2Book",
      coin: market.coin,
    });
    const ticket = { ...input, market };
    const active =
      force && !ticket.reduceOnly && !ticket.positionTpsl
        ? await this.options.shared.info.request<any>({
            type: "activeAssetData",
            user: snapshot.address,
            coin: market.coin,
          })
        : undefined;
    const buyingPower =
      active?.availableToTrade?.[ticket.side === "buy" ? 0 : 1];
    const preview = previewTicket(
      ticket,
      {
        available:
          buyingPower !== undefined
            ? Math.max(0, Number(buyingPower))
            : availableForMarket(snapshot, market),
        makerRate: Number(snapshot.fees?.userAddRate ?? 0.00015),
        takerRate: Number(snapshot.fees?.userCrossRate ?? 0.00045),
        referralDiscount: Number(snapshot.fees?.activeReferralDiscount ?? 0),
        positionSize: Number(position?.szi ?? 0),
        accountValue: snapshot.accountValue,
        book: book?.levels,
        crossMaintenanceMargin: snapshot.maintenanceMargin,
      },
      this.settings(),
    );
    if (
      active?.leverage?.value === ticket.leverage &&
      active?.leverage?.type === ticket.marginMode &&
      Number(preview.size) >
        Number(active.maxTradeSzs?.[ticket.side === "buy" ? 0 : 1] ?? Infinity)
    )
      preview.errors.push(
        "Order exceeds the exchange-reported maximum trade size.",
      );
    if (snapshot.stale)
      preview.errors.push(
        "Account data is stale. Wait for the connection to recover.",
      );
    if (snapshot.abstraction === "portfolioMargin" && !ticket.reduceOnly)
      preview.errors.push(
        "Opening orders in portfolio margin mode is not supported. Use standard or unified account mode.",
      );
    if (!snapshot.fees)
      preview.warnings.push(
        "Using base fee estimates until your fee tier is available.",
      );
    return { ticket, preview, snapshot };
  }
  private confirm(confirmed: boolean | undefined, warnings: string[] = []) {
    if ((this.settings().confirmations || warnings.length) && !confirmed)
      throw new Error(
        warnings.length
          ? `Confirmation required: ${warnings.join(" ")}`
          : "Confirm the order before submitting.",
      );
  }
  private async saveResults() {
    await this.store.writeJson("intents.json", [...this.results].slice(-500));
  }
  private async once(
    id: string,
    cloids: string[],
    send: () => Promise<unknown>,
  ): Promise<TradingResult> {
    if (!id || id.length > 200)
      throw new Error("A stable client intent id is required.");
    const pending = this.pending.get(id);
    if (pending) return pending;
    const previous = this.results.get(id);
    if (previous)
      return previous.state === "unknown" ? this.reconcile(previous) : previous;
    const task = this.store.tradingLock(async () => {
      this.results = new Map(
        await this.store.readJson<[string, TradingResult][]>(
          "intents.json",
          [],
        ),
      );
      const known = this.results.get(id);
      if (known)
        return known.state === "unknown" ? this.reconcile(known) : known;
      const initial: TradingResult = {
        clientId: id,
        state: "unknown",
        message: "Submission pending. Do not submit again.",
        cloids,
        at: Date.now(),
      };
      this.results.set(id, initial);
      await this.saveResults();
      let result: TradingResult;
      try {
        const response = await send();
        const serialized = JSON.stringify(response);
        const errors: string[] = [];
        const walk = (value: any) => {
          if (value && typeof value === "object") {
            if (typeof value.error === "string") errors.push(value.error);
            for (const child of Object.values(value)) walk(child);
          }
        };
        walk(response);
        result = {
          ...initial,
          state: errors.length ? "rejected" : "accepted",
          message: errors.length
            ? `Some or all orders were rejected: ${errors.join("; ")}. Inspect each order before resubmitting.`
            : (response as any)?.response?.type === "localTwap"
              ? "Local TWAP scheduled. Keep Gloom running; each slice includes the builder fee."
              : "Accepted by Hyperliquid.",
          response: JSON.parse(serialized),
        };
      } catch (error) {
        // API-level rejection is definitive. All transport failures remain unknown.
        const definitive =
          error instanceof Error &&
          ["ApiRequestError", "RequestNotSentError"].includes(error.name);
        result = {
          ...initial,
          state: definitive ? "rejected" : "unknown",
          message: errorText(error),
          ...(definitive ? { response: (error as any).response } : {}),
        };
      }
      this.results.set(id, result);
      await this.saveResults();
      void this.accounts.refresh().catch(() => {});
      return result.state === "unknown" ? this.reconcile(result) : result;
    });
    this.pending.set(id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(id);
    }
  }
  private async reconcile(previous: TradingResult): Promise<TradingResult> {
    if (!previous.cloids?.length || !this.status.address)
      return {
        ...previous,
        message:
          previous.message +
          " Outcome is unknown. Inspect account history; this action will not be resent.",
      };
    try {
      const statuses = await Promise.all(
        previous.cloids.map((oid) =>
          this.options.shared.info.request<any>({
            type: "orderStatus",
            user: this.status.address,
            oid,
          }),
        ),
      );
      if (statuses.every((status) => status.status === "order")) {
        const result: TradingResult = {
          ...previous,
          state: "accepted",
          message:
            "Exchange order records found. Check each order status and any unfilled remainder.",
          response: statuses,
        };
        this.results.set(previous.clientId, result);
        await this.saveResults();
        return result;
      }
    } catch {}
    return {
      ...previous,
      message:
        "Exchange outcome is still unknown. No automatic resend. Inspect Orders and Fills before creating another intent.",
    };
  }
  private async submit(
    ticket: TicketRequest,
    confirmed?: boolean,
  ): Promise<TradingResult> {
    await this.guard();
    const previous = this.results.get(ticket.clientId);
    if (previous)
      return previous.state === "unknown" ? this.reconcile(previous) : previous;
    const built = await this.preview(ticket, true);
    if (built.preview.errors.length)
      throw new Error(built.preview.errors.join(" "));
    this.confirm(confirmed, built.preview.warnings);
    const cloids =
      built.preview.order?.orders.flatMap((o) => (o.c ? [o.c] : [])) ?? [];
    return this.once(ticket.clientId, cloids, async () => {
      if (built.preview.twap && this.settings().builder) {
        const job = await this.twaps.start(
          { ...built.ticket, accountAddress: this.status.address },
          built.preview.size,
          built.preview.notional,
        );
        return {
          status: "ok",
          response: { type: "localTwap", data: { twapId: job.id } },
        };
      }
      const exchange = await this.exchange();
      // Leverage is set explicitly before entry; a timeout here prevents the order from being sent.
      if (!ticket.reduceOnly && !ticket.positionTpsl)
        await exchange.updateLeverage({
          asset: built.ticket.market.assetId,
          isCross: ticket.marginMode === "cross",
          leverage: ticket.leverage,
        });
      return built.preview.twap
        ? exchange.twapOrder(built.preview.twap)
        : exchange.order(built.preview.order!);
    });
  }
  private async connectionStatus() {
    this.assertOpen();
    if (!this.status.agentAddress || this.status.mode !== "pending")
      return this.status;
    if (this.roleCheck) return this.roleCheck;
    if (Date.now() - this.lastRoleCheck < 15_000) return this.status;
    this.lastRoleCheck = Date.now();
    const expectedAgent = this.status.agentAddress;
    this.roleCheck = (async () => {
      const role = await this.options.shared.info.request<any>({
        type: "userRole",
        user: expectedAgent,
      });
      this.assertOpen();
      if (
        this.status.agentAddress !== expectedAgent ||
        this.status.mode !== "pending"
      )
        return this.status;
      if (role.role === "agent" && role.data?.user) {
        this.status.address = address(role.data.user);
        const builder = this.settings().builder;
        if (builder) {
          const allowance = await this.options.shared.info.request<number>({
            type: "maxBuilderFee",
            user: this.status.address,
            builder: builder.address,
          });
          this.assertOpen();
          if (
            this.status.agentAddress !== expectedAgent ||
            this.status.mode !== "pending"
          )
            return this.status;
          if (allowance < builder.feeTenthsBps) {
            this.status.error =
              "Approve Gloom's 0.1% builder fee in the browser to finish connecting.";
            await this.persist();
            return this.status;
          }
        }
        this.status.error = undefined;
        this.status.mode = "trading";
        await this.persist();
        await this.touch();
        if (this.poll) clearInterval(this.poll);
        this.poll = undefined;
      }
      return this.status;
    })();
    try {
      return await this.roleCheck;
    } finally {
      this.roleCheck = undefined;
    }
  }
  private async openWallet(generate: boolean) {
    await this.guard(false);
    this.walletPage?.close();
    if (generate) {
      if (this.status.storage) await this.store.disconnect();
      const key = generatePrivateKey(),
        agent = privateKeyToAccount(key);
      this.status = {
        ...this.status,
        mode: "pending",
        address: undefined,
        agentAddress: agent.address,
        expiresAt: Date.now() + 90 * 86_400_000,
        storage: await this.store.saveKey(key),
      };
      this.status.agentName = `gloom valid_until ${this.status.expiresAt}`;
      await this.persist();
      this.accounts.stop();
      if (this.poll) clearInterval(this.poll);
      this.poll = setInterval(
        () => void this.connectionStatus().catch(() => {}),
        15000,
      );
      this.poll.unref();
    }
    const configuredPort =
      typeof this.options.approvalPort === "function"
        ? this.options.approvalPort()
        : this.options.approvalPort;
    const port =
      configuredPort ||
      Number(process.env.GLOOM_HYPERLIQUID_APPROVAL_PORT ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Approval port must be 0 or a valid TCP port.");
    this.walletPage = startWalletPage({
      network: this.options.network,
      agentAddress: this.status.agentAddress,
      agentName: this.status.agentName,
      address: this.status.address,
      builder: this.settings().builder,
      approvalPort: port,
      checkRegion: () => this.region(),
    });
    const { close, ...session } = this.walletPage;
    return session;
  }
  /** Native-only approval path for scripts. Never registered as a renderer capability. */
  async connectMainWallet(privateKey: `0x${string}`): Promise<TradingStatus> {
    await this.ready;
    this.assertOpen();
    if (this.transitioning || this.signedInFlight || this.pending.size)
      throw new Error(
        "Wait for the current trading request before connecting a wallet.",
      );
    this.transitioning = true;
    try {
      for (const job of this.twaps.getJobs())
        if (job.status === "running" || job.status === "paused")
          await this.twaps.cancel(job.id);
      return await this.store.tradingLock(async () => {
        await this.guard(false);
        let wallet;
        try {
          wallet = privateKeyToAccount(privateKey);
        } catch {
          throw new Error("Invalid main-wallet key.");
        }
        const reusable =
          this.status.mode === "pending" &&
          this.status.address?.toLowerCase() === wallet.address.toLowerCase() &&
          this.status.agentAddress &&
          this.status.storage &&
          this.status.expiresAt &&
          this.status.expiresAt > Date.now();
        if (!reusable) {
          this.walletPage?.close();
          this.accounts.stop();
          await this.store.disconnect();
          const key = generatePrivateKey(),
            apiWallet = privateKeyToAccount(key),
            expiresAt = Date.now() + 90 * 86_400_000;
          this.status = {
            ...this.status,
            mode: "pending",
            address: wallet.address,
            agentAddress: apiWallet.address,
            agentName: `gloom valid_until ${expiresAt}`,
            expiresAt,
            storage: await this.store.saveKey(key),
            error: undefined,
          };
          await this.persist();
        }
        // A failed or timed-out approval is never automatically resent. Pending state
        // retains the same local API wallet for deliberate later reconciliation/retry.
        await approveApiWallet({
          network: this.options.network,
          wallet,
          agentAddress: this.status.agentAddress!,
          agentName: this.status.agentName!,
          nonceManager: () => this.store.nextNonce(),
          transport: singleAttemptExchangeTransport(this.options.network, () =>
            this.assertOpen(),
          ),
        });
        this.lastRoleCheck = 0;
        await this.connectionStatus();
        if (this.status.mode !== "trading")
          throw new Error(
            "Approval submitted but not yet confirmed. Check connectionStatus before retrying.",
          );
        return { ...this.status };
      });
    } catch (error) {
      this.status.error = errorText(error);
      await this.persist();
      throw new Error(this.status.error);
    } finally {
      this.transitioning = false;
    }
  }
  async invoke(
    operation: TradingOperation | string,
    payload: any = {},
  ): Promise<any> {
    await this.ready;
    this.assertOpen();
    const transitions = ["watch", "connect", "import", "disconnect"].includes(
        operation,
      ),
      signed = [
        "submit",
        "cancel",
        "modify",
        "leverage",
        "margin",
        "close",
        "reverse",
        "closeAll",
        "twapCancel",
        "twapResume",
      ].includes(operation);
    if (transitions && (this.transitioning || this.signedInFlight > 0))
      throw new Error(
        "Wait for the current trading request before changing accounts.",
      );
    if (
      signed &&
      payload.expectedAddress &&
      String(payload.expectedAddress).toLowerCase() !==
        this.status.address?.toLowerCase()
    )
      throw new Error("The connected account changed. Review the order again.");
    if ((signed || operation === "preview") && this.transitioning)
      throw new Error("Wait for the wallet change to finish.");
    if (transitions) {
      this.transitioning = true;
      this.builderChecked = 0;
    }
    if (signed) this.signedInFlight++;
    try {
      if (transitions) {
        for (const job of this.twaps.getJobs())
          if (job.status === "running" || job.status === "paused")
            await this.twaps.cancel(job.id);
        return await this.store.tradingLock(() =>
          this.execute(operation, payload),
        );
      }
      if (signed && this.status.address) await this.touch();
      return await this.execute(operation, payload);
    } finally {
      if (transitions) this.transitioning = false;
      if (signed) this.signedInFlight--;
    }
  }
  private async execute(
    operation: TradingOperation | string,
    payload: any = {},
  ): Promise<any> {
    switch (operation) {
      case "status":
        return {
          ...this.status,
          ...(this.status.expiresAt && this.status.expiresAt < Date.now()
            ? { error: "Trading approval expired. Reconnect your wallet." }
            : {}),
        };
      case "account":
        return this.account();
      case "region":
        return this.region();
      case "acknowledge":
        if (payload.risk !== true || payload.eligible !== true)
          throw new Error(
            "Both trading risk and eligibility acknowledgements are required.",
          );
        this.status.riskAcknowledged = true;
        this.status.eligibleAcknowledged = true;
        await this.persist();
        return this.status;
      case "watch": {
        const user = address(payload.address);
        await this.store.disconnect();
        this.walletPage?.close();
        this.status = {
          network: this.options.network,
          mode: "watch",
          address: user,
          riskAcknowledged: false,
          eligibleAcknowledged: false,
        };
        await this.persist();
        await this.touch();
        return this.status;
      }
      case "connect":
        return this.openWallet(true);
      case "wallet":
        return this.openWallet(false);
      case "connectionStatus":
        return this.connectionStatus();
      case "disconnect": {
        this.walletPage?.close();
        if (this.poll) clearInterval(this.poll);
        this.suspend();
        await this.store.disconnect();
        this.status = {
          network: this.options.network,
          mode: "disconnected",
          riskAcknowledged: false,
          eligibleAcknowledged: false,
        };
        this.emit();
        return this.status;
      }
      case "import": {
        await this.guard(false);
        const user = address(payload.address);
        if (
          typeof payload.privateKey !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(payload.privateKey)
        )
          throw new Error("Enter a valid API wallet private key.");
        let wallet;
        try {
          wallet = privateKeyToAccount(payload.privateKey);
        } catch {
          throw new Error("Invalid API wallet private key.");
        }
        if (wallet.address.toLowerCase() === user.toLowerCase())
          throw new Error(
            "Import an API wallet key, never the main wallet key.",
          );
        const role = await this.options.shared.info.request<any>({
          type: "userRole",
          user: wallet.address,
        });
        if (
          role.role !== "agent" ||
          role.data?.user?.toLowerCase() !== user.toLowerCase()
        )
          throw new Error(
            "This API wallet is not approved for the account on this network.",
          );
        const agents = await this.options.shared.info.request<any[]>({
          type: "extraAgents",
          user,
        });
        const known = agents.find(
          (a) => a.address?.toLowerCase() === wallet.address.toLowerCase(),
        );
        const expiresAt = Number(known?.validUntil ?? payload.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
          throw new Error("A valid future API wallet expiry is required.");
        const builder = this.settings().builder;
        const approved =
          !builder ||
          (await this.options.shared.info.request<number>({
            type: "maxBuilderFee",
            user,
            builder: builder.address,
          })) >= builder.feeTenthsBps;
        await this.store.disconnect();
        this.status = {
          ...this.status,
          mode: approved ? "trading" : "pending",
          error: approved
            ? undefined
            : "Approve Gloom's 0.1% builder fee from Wallet management to finish importing.",
          address: user,
          agentAddress: wallet.address,
          expiresAt,
          agentName: known?.name,
          storage: await this.store.saveKey(payload.privateKey),
        };
        await this.persist();
        await this.touch();
        return this.status;
      }
      case "preview":
        return (await this.preview(payload.ticket)).preview;
      case "submit":
        return this.submit(payload.ticket, payload.confirmed);
      case "leverage": {
        await this.guard();
        const market = await this.market(payload.coin);
        if (
          !Number.isInteger(payload.leverage) ||
          payload.leverage < 1 ||
          payload.leverage > market.maxLeverage
        )
          throw new Error("Invalid leverage.");
        if (market.onlyIsolated && payload.marginMode !== "isolated")
          throw new Error("Market requires isolated margin.");
        const exchange = await this.exchange();
        return this.once(payload.clientId ?? crypto.randomUUID(), [], () =>
          exchange.updateLeverage({
            asset: market.assetId,
            isCross: payload.marginMode === "cross",
            leverage: payload.leverage,
          }),
        );
      }
      case "margin": {
        await this.guard();
        const market = await this.market(payload.coin),
          amount = Number(payload.amount);
        if (!Number.isFinite(amount) || !amount)
          throw new Error("Enter a nonzero margin change in USD.");
        const position = (await this.account()).positions.find(
          (p) => p.coin === market.coin,
        );
        if (position?.leverage.type !== "isolated")
          throw new Error("Only isolated positions support margin changes.");
        if (amount < 0 && market.marginMode === "strictIsolated")
          throw new Error(
            "Strict isolated markets do not allow margin removal.",
          );
        this.confirm(payload.confirmed);
        const exchange = await this.exchange();
        return this.once(payload.clientId ?? crypto.randomUUID(), [], () =>
          exchange.updateIsolatedMargin({
            asset: market.assetId,
            isBuy: Number(position.szi) > 0,
            ntli: Math.trunc(amount * 1e6),
          }),
        );
      }
      case "cancel": {
        await this.guard();
        this.confirm(payload.confirmed);
        const snapshot = await this.accounts.refresh();
        const selected = snapshot.orders.filter(
          (o) =>
            (!payload.coin || o.coin === payload.coin) &&
            (payload.oid === undefined || o.oid === Number(payload.oid)),
        );
        if (!selected.length) throw new Error("No matching open orders.");
        await this.loadMarkets();
        const cancels = selected.map((o) => {
          const m = this.markets.get(o.coin);
          if (!m) throw new Error("Cannot resolve market for order.");
          return { a: m.assetId, o: o.oid };
        });
        const exchange = await this.exchange();
        return this.once(payload.clientId ?? crypto.randomUUID(), [], () =>
          exchange.cancel({ cancels }),
        );
      }
      case "modify": {
        await this.guard();
        const built = await this.preview(payload.ticket, true);
        if (built.preview.errors.length)
          throw new Error(built.preview.errors.join(" "));
        if (!built.preview.order || built.preview.order.orders.length !== 1)
          throw new Error("Modify supports one order at a time.");
        this.confirm(payload.confirmed, built.preview.warnings);
        const existing = (await this.account()).orders.find(
          (o) => o.oid === Number(payload.oid),
        );
        if (!existing || existing.coin !== built.ticket.market.coin)
          throw new Error("Order is no longer open in this market.");
        const order = built.preview.order.orders[0]!;
        if (existing.isTrigger && !("trigger" in order.t))
          throw new Error(
            "Modifying a trigger order must preserve its trigger type and price.",
          );
        if (existing.isPositionTpsl)
          throw new Error(
            "Use position TP/SL to replace a position-level bracket.",
          );
        const exchange = await this.exchange();
        return this.once(
          payload.ticket.clientId,
          order.c ? [order.c] : [],
          () =>
            exchange.modify({
              oid: Number(payload.oid),
              order,
            } as ModifyParameters),
        );
      }
      case "twapResume": {
        await this.guard();
        this.confirm(payload.confirmed);
        const job = this.twaps.getJobs().find((j) => j.id === payload.twapId);
        if (!job) throw new Error("Local TWAP not found.");
        if (
          job.ticket.accountAddress?.toLowerCase() !==
          this.status.address?.toLowerCase()
        )
          throw new Error(
            "Reconnect the original TWAP account before resuming.",
          );
        const resumed = await this.twaps.resume(job.id);
        return {
          state: "accepted",
          message: "Local TWAP resumed. Keep Gloom running.",
          twapId: resumed.id,
        };
      }
      case "twapCancel": {
        this.confirm(payload.confirmed);
        if (
          typeof payload.twapId === "string" &&
          payload.twapId.startsWith("local:")
        ) {
          const job = await this.twaps.cancel(payload.twapId);
          return { state: "accepted", message: job.reason, twapId: job.id };
        }
        await this.guard();
        const market = await this.market(payload.coin),
          exchange = await this.exchange();
        if (!Number.isInteger(payload.twapId))
          throw new Error("Invalid TWAP id.");
        return this.once(payload.clientId ?? crypto.randomUUID(), [], () =>
          exchange.twapCancel({ a: market.assetId, t: payload.twapId }),
        );
      }
      case "close":
      case "reverse": {
        await this.guard();
        const snapshot = await this.accounts.refresh(),
          position = snapshot.positions.find((p) => p.coin === payload.coin);
        if (!position) throw new Error("Position is no longer open.");
        const market = await this.market(position.coin);
        const percent =
          operation === "reverse" ? 200 : Number(payload.percent ?? 100);
        if (
          !Number.isFinite(percent) ||
          percent <= 0 ||
          percent > (operation === "reverse" ? 200 : 100)
        )
          throw new Error(
            "Close percentage must be greater than 0 and at most 100.",
          );
        return this.submit(
          {
            market,
            side: Number(position.szi) > 0 ? "sell" : "buy",
            kind: payload.kind ?? "market",
            limitPrice: payload.limitPrice,
            size: (Math.abs(Number(position.szi)) * percent) / 100,
            sizeUnit: "coin",
            leverage: position.leverage.value,
            marginMode: position.leverage.type,
            reduceOnly: operation === "close",
            clientId: payload.clientId,
          },
          payload.confirmed,
        );
      }
      case "closeAll": {
        await this.guard();
        this.confirm(payload.confirmed);
        if (!payload.clientId)
          throw new Error("A stable close-all intent id is required.");
        let snapshot = await this.accounts.refresh();
        for (const dex of new Set(snapshot.positions.map((p) => p.dex)))
          snapshot = await this.accounts.refreshRisk(dex);
        await this.loadMarkets();
        const orders: OrderParameters["orders"] = [];
        for (const position of snapshot.positions) {
          const market = await this.market(position.coin);
          if (!market)
            throw new Error(
              `Cannot resolve ${position.coin}; close it separately.`,
            );
          const ticket: TicketRequest = {
            market,
            side: Number(position.szi) > 0 ? "sell" : "buy",
            kind: "market",
            size: Math.abs(Number(position.szi)),
            sizeUnit: "coin",
            leverage: position.leverage.value,
            marginMode: position.leverage.type,
            reduceOnly: true,
            clientId: `${payload.clientId}:${position.coin}`,
          };
          const preview = previewTicket(
            ticket,
            {
              available: 0,
              makerRate: Number(snapshot.fees?.userAddRate ?? 0.00015),
              takerRate: Number(snapshot.fees?.userCrossRate ?? 0.00045),
              referralDiscount: Number(
                snapshot.fees?.activeReferralDiscount ?? 0,
              ),
              positionSize: Number(position.szi),
            },
            this.settings(),
          );
          if (preview.errors.length)
            throw new Error(`${position.coin}: ${preview.errors.join(" ")}`);
          orders.push(...preview.order!.orders);
        }
        if (!orders.length) throw new Error("There are no positions to close.");
        const exchange = await this.exchange();
        return this.once(
          payload.clientId,
          orders.flatMap((o) => (o.c ? [o.c] : [])),
          () =>
            exchange.order({
              orders,
              grouping: "na",
              ...(this.settings().builder
                ? {
                    builder: {
                      b: this.settings().builder!.address,
                      f: this.settings().builder!.feeTenthsBps,
                    },
                  }
                : {}),
            }),
        );
      }
      case "history":
        return this.accounts.history(
          payload.kind,
          Number(payload.startTime),
          payload.endTime,
        );
      default:
        throw new Error("Unknown trading operation.");
    }
  }
  dispose() {
    return this.shutdown();
  }
  shutdown() {
    this.closed = true;
    this.suspend(true);
    const stopped = this.twaps.dispose();
    this.walletPage?.close();
    if (this.poll) clearInterval(this.poll);
    this.accounts.stop();
    this.listeners.clear();
    return stopped;
  }
}
