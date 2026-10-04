import { getCapabilityStreamClient } from 'gloomberb/capabilities';
import { MarketDataService } from './market/service';
import type { BoardSnapshot, MarketOptions, MarketSession, MarketSnapshot, Network } from './market/types';

export const MARKET_CAPABILITY = 'hyperliquid.markets';
export type MarketServiceView = Pick<MarketDataService, 'getSnapshot' | 'subscribe' | 'refresh' | 'getMarket' | 'setBookAggregation'>;
const localServices = new Map<Network, MarketDataService>();
const remoteServices = new Map<Network, MarketServiceView>();
const remoteDisposers: (() => void)[] = [];

/** Native account and market capabilities share this exact service instance. */
export function getLocalMarketService(network: Network): MarketDataService {
  let service = localServices.get(network);
  if (!service) {
    service = new MarketDataService({ network });
    localServices.set(network, service);
  }
  return service;
}

function remoteStore<T extends { status: string; error: string | null }>(network: Network, scope: 'board' | 'market', initial: T, details: Record<string, unknown> = {}) {
  let snapshot = initial;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: T) => { snapshot = next; for (const listener of listeners) listener(); };
  const payload = { network, ...details };
  const client = getCapabilityStreamClient()!;
  const dispose = () => { stop?.(); stop = undefined; listeners.clear(); };
  remoteDisposers.push(dispose);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (!stop) stop = client.subscribe({ capabilityId: MARKET_CAPABILITY, operationId: `${scope}Stream`, payload,
        onEvent: (next) => publish(next as T),
        onError: (error) => publish({ ...snapshot, status: 'error', error: error instanceof Error ? error.message : String(error) }),
      });
      return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
    },
    async refresh() { publish(await client.invoke<T>(MARKET_CAPABILITY, `${scope}Snapshot`, payload)); },
  };
}

function createRemoteService(network: Network): MarketServiceView {
  const board = remoteStore<BoardSnapshot>(network, 'board', { markets: [], dexes: [], predictedFundings: [], status: 'connecting', asOf: null, error: null });
  const sessions = new Map<string, MarketSession>();
  return {
    ...board,
    getMarket(coin, options = {}) {
      const key = JSON.stringify([coin, options]);
      let session = sessions.get(key);
      if (!session) {
        session = remoteStore<MarketSnapshot>(network, 'market', { market: null, book: null, candles: [], trades: [], annotation: null, status: 'connecting', asOf: null, error: null }, { coin, options });
        sessions.set(key, session);
      }
      return session;
    },
    setBookAggregation(coin: string, options: MarketOptions) {
      void getCapabilityStreamClient()!.invoke(MARKET_CAPABILITY, 'aggregation', { network, coin, options }).catch(() => board.refresh().catch(() => {}));
    },
  };
}

export function getMarketService(network: Network): MarketServiceView {
  if (!getCapabilityStreamClient()) return getLocalMarketService(network);
  let service = remoteServices.get(network);
  if (!service) { service = createRemoteService(network); remoteServices.set(network, service); }
  return service;
}

export function disposeRuntime(): void {
  for (const dispose of remoteDisposers.splice(0)) dispose();
  for (const service of localServices.values()) service.dispose();
  localServices.clear(); remoteServices.clear();
}
