import type { CapabilityOperation, PluginCapability } from 'gloomberb/capabilities';
import type { GloomPluginContext } from 'gloomberb/types/plugin';
import { join } from 'node:path';
import { createTradingService } from './native/service';
import { getLocalMarketService, MARKET_CAPABILITY } from './runtime';
import { readSettings, tradingSettings } from './settings';
import type { TradingOperation } from './trading/types';
import { CANDLE_INTERVALS, type MarketOptions, type Network } from './market/types';
import { AccountStore } from './trading/account';
import type { Address } from './trading/types';

function networkOf(input: Record<string, unknown>): Network {
  if (input.network !== 'mainnet' && input.network !== 'testnet') throw new Error('Choose mainnet or testnet explicitly.');
  return input.network;
}
function marketOf(input: Record<string, unknown>): string {
  if (typeof input.coin !== 'string' || input.coin.length < 1 || input.coin.length > 128 || /[\x00-\x1f\x7f]/.test(input.coin)) throw new Error('A valid market is required.');
  return input.coin;
}
function optionsOf(input: Record<string, unknown>): MarketOptions {
  const options = input.options as MarketOptions | undefined;
  if (!options) return {};
  if (options.interval && !CANDLE_INTERVALS.includes(options.interval)) throw new Error('Unsupported candle interval.');
  if (options.nSigFigs != null && ![2, 3, 4, 5].includes(options.nSigFigs)) throw new Error('Unsupported book precision.');
  if (options.mantissa != null && ![1, 2, 5].includes(options.mantissa)) throw new Error('Unsupported book aggregation.');
  return { interval: options.interval, nSigFigs: options.nSigFigs, mantissa: options.mantissa };
}
export function registerNativeCapabilities(ctx: GloomPluginContext): () => void {
  const services = new Map<Network, ReturnType<typeof createTradingService>>();
  const watches = new Map<string, { store: AccountStore; refs: number; release?: () => void }>();
  const configValues = () => Object.fromEntries(ctx.configState.keys().map(key => [key, ctx.configState.get(key)]));
  const trading = (network: Network) => {
    let service = services.get(network);
    if (!service) {
      service = createTradingService({ network, dataDir: join(ctx.getConfig().dataDir, 'hyperliquid'), shared: getLocalMarketService(network), settings: () => tradingSettings(configValues()), approvalPort: () => readSettings(configValues()).approvalPort });
      services.set(network, service);
    }
    return service;
  };
  const reads = new Set<TradingOperation>(['status', 'account', 'preview', 'connectionStatus', 'history', 'region']);
  const local = new Set<TradingOperation>(['watch', 'connect', 'import', 'disconnect', 'acknowledge', 'wallet']);
  // Key import is native CLI only: renderer and generic capability inputs may be recorded.
  const operationNames: TradingOperation[] = ['status', 'watch', 'connect', 'disconnect', 'account', 'preview', 'submit', 'cancel', 'modify', 'leverage', 'margin', 'wallet', 'connectionStatus', 'acknowledge', 'region', 'close', 'reverse', 'closeAll', 'twapCancel', 'twapResume', 'history'];
  const operations: Record<string, CapabilityOperation> = {};
  for (const name of operationNames) operations[name] = {
    kind: reads.has(name) ? 'query' : 'action', rendererSafe: true,
    handler: input => {
      const payload = input as Record<string, unknown>;
      const network = networkOf(payload);
      const { network: _network, ...value } = payload;
      return trading(network).invoke(name, value);
    },
    cli: { summary: `Hyperliquid ${name}`, inputShape: '{ network: "mainnet" | "testnet", ...parameters }', outputShape: 'Operation result', formats: ['json'], sideEffectLevel: reads.has(name) ? 'none' : local.has(name) ? 'local-write' : 'external-trade', safety: ['Signing requires a local trading key, current region eligibility, and risk acknowledgement.'] },
  };
  operations.accountStream = {
    kind: 'stream', rendererSafe: true,
    subscribe(input, emit) {
      const service = trading(networkOf(input as Record<string, unknown>));
      const release = service.subscribe(() => emit(service.getSnapshot()));
      emit(service.getSnapshot());
      return release;
    },
  };
  const watch = (input: Record<string, unknown>) => {
    const network = networkOf(input);
    if (typeof input.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new Error('A valid watch-only address is required.');
    const address = input.address as Address;
    const key = `${network}:${address.toLowerCase()}`;
    let entry = watches.get(key);
    if (!entry) { entry = { store: new AccountStore(network, getLocalMarketService(network)), refs: 0 }; watches.set(key, entry); }
    const snapshot = () => ({ status: { network, address, mode: 'watch', riskAcknowledged: false, eligibleAcknowledged: false }, account: entry!.store.getSnapshot() ?? null });
    return { entry, address, network, snapshot };
  };
  operations.watchSnapshot = {
    kind: 'query', rendererSafe: true,
    async handler(input) {
      const { entry, address, network, snapshot } = watch(input as Record<string, unknown>);
      entry.refs++;
      if (entry.refs === 1) entry.release = getLocalMarketService(network).subscribe(() => {});
      try { await entry.store.setAddress(address); return snapshot(); }
      finally { if (--entry.refs === 0) { entry.release?.(); entry.release = undefined; entry.store.stop(); } }
    },
  };
  operations.watchStream = {
    kind: 'stream', rendererSafe: true,
    subscribe(input, emit) {
      const { entry, address, network, snapshot } = watch(input as Record<string, unknown>);
      entry.refs++;
      if (entry.refs === 1) entry.release = getLocalMarketService(network).subscribe(() => {});
      const releaseListener = entry.store.subscribe(() => emit(snapshot()));
      let active = true;
      void entry.store.setAddress(address).then(() => { if (active) emit(snapshot()); }).catch(error => { if (active) emit({ ...snapshot(), error: error instanceof Error ? error.message : String(error) }); });
      emit(snapshot());
      return () => { active = false; releaseListener(); if (--entry.refs === 0) { entry.release?.(); entry.release = undefined; entry.store.stop(); } };
    },
  };
  ctx.registerCapability({ id: 'hyperliquid.trading', name: 'Hyperliquid Trading', kind: 'plugin-service', operations });
  const marketCapability: PluginCapability = {
    id: MARKET_CAPABILITY, name: 'Hyperliquid Markets', kind: 'plugin-service', operations: {
      boardSnapshot: { kind: 'query', rendererSafe: true, handler: async input => { const service = getLocalMarketService(networkOf(input)); await service.refresh(); return service.getSnapshot(); } },
      marketSnapshot: { kind: 'query', rendererSafe: true, handler: async input => { const service = getLocalMarketService(networkOf(input)); await service.refresh(); const session = service.getMarket(marketOf(input), optionsOf(input)); await session.refresh(); return session.getSnapshot(); } },
      boardStream: { kind: 'stream', rendererSafe: true, subscribe: (input, emit) => { const service = getLocalMarketService(networkOf(input)); const release = service.subscribe(() => emit(service.getSnapshot())); emit(service.getSnapshot()); return release; } },
      marketStream: { kind: 'stream', rendererSafe: true, subscribe: (input, emit) => { const session = getLocalMarketService(networkOf(input)).getMarket(marketOf(input), optionsOf(input)); const release = session.subscribe(() => emit(session.getSnapshot())); emit(session.getSnapshot()); return release; } },
      aggregation: { kind: 'action', rendererSafe: true, handler: input => { getLocalMarketService(networkOf(input)).setBookAggregation(marketOf(input), optionsOf(input)); return { ok: true }; } },
    },
  };
  ctx.registerCapability(marketCapability);
  return () => { for (const entry of watches.values()) { entry.release?.(); entry.store.stop(); } watches.clear(); for (const service of services.values()) service.dispose(); services.clear(); };
}
