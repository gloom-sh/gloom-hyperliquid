import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useCapabilityInvoker, usePaneVisible, usePaneSettingValue, usePluginConfigState } from 'gloomberb/react';
import { usePaneFooter, type PaneHint } from 'gloomberb/components';
import { getCapabilityStreamClient } from 'gloomberb/capabilities';
import { getMarketService, getLocalMarketService } from '../runtime';
import type { CandleInterval, LiveStatus } from '../market';
import type { AccountSnapshot, Network, TradingOperation, TradingStatus } from '../trading/types';
import { AccountStore } from '../trading/account';
import { shortAddress, time } from './format';

export function useNetwork(): [Network, (value: Network) => void] {
  const [configured, setConfigured] = usePluginConfigState<Network>('network', 'mainnet');
  const [override] = usePaneSettingValue<Network | ''>('network', '');
  return [override || configured, setConfigured];
}
export function useBoard() {
  const [network] = useNetwork();
  const service = getMarketService(network);
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  return { ...snapshot, service, network };
}
export function useMarket(coin: string, interval: CandleInterval = '15m', nSigFigs?: 2 | 3 | 4 | 5 | null, mantissa?: 1 | 2 | 5) {
  const [network] = useNetwork();
  const service = getMarketService(network);
  const session = useMemo(() => service.getMarket(coin, { interval, nSigFigs, mantissa }), [service, coin, interval, nSigFigs, mantissa]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return { ...snapshot, session, network };
}

interface AccountState { status: TradingStatus | null; account: AccountSnapshot | null; error: string | null; loading: boolean }
const initialAccount: AccountState = { status: null, account: null, error: null, loading: true };
type Invoker = ReturnType<typeof useCapabilityInvoker>;
const accountStores = new WeakMap<Invoker, Map<string, ReturnType<typeof createAccountStore>>>();
function createAccountStore(invoker: Invoker, network: Network, watchAddress = '') {
  let watch: AccountStore | null = null;
  let stopMarket: (() => void) | null = null;
  let snapshot = initialAccount;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopStream: (() => void) | undefined;
  let pending: Promise<void> | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  const invoke = <T,>(operation: TradingOperation, payload: Record<string, unknown> = {}) => invoker.invokeCapability<T>('hyperliquid.trading', operation, { ...payload, network });
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    const currentGeneration = generation;
    const request: Promise<void> = Promise.resolve().then(async () => {
      try {
        if (watchAddress && !getCapabilityStreamClient()) {
          if (currentGeneration !== generation) return;
          if (!watch) { const service = getLocalMarketService(network); stopMarket = service.subscribe(() => {}); watch = new AccountStore(network, service); await watch.setAddress(watchAddress as `0x${string}`); }
          if (currentGeneration !== generation) return;
          const account = watch?.getSnapshot() ?? null;
          snapshot = { status: { network, mode: 'watch', address: watchAddress as `0x${string}`, riskAcknowledged: false, eligibleAcknowledged: false }, account, loading: false, error: account?.error ?? (account ? null : snapshot.error) };
          return;
        }
        if (watchAddress) {
          const result = await invoke<{ status: TradingStatus; account: AccountSnapshot; error?: string }>('watchSnapshot' as TradingOperation, { address: watchAddress });
          if (currentGeneration !== generation) return;
          snapshot = { ...result, loading: false, error: result.error ?? result.account?.error ?? result.status.error ?? null }; return;
        }
        if (!getCapabilityStreamClient() && !invoker.capabilityManifests().some(manifest => manifest.id === 'hyperliquid.trading')) {
          if (currentGeneration !== generation) return;
          snapshot = { status: { network, mode: 'disconnected', riskAcknowledged: false, eligibleAcknowledged: false }, account: null, loading: false, error: null };
          return;
        }
        const status = await invoke<TradingStatus>('status');
        const account = status.address ? await invoke<AccountSnapshot>('account') : null;
        if (currentGeneration !== generation) return;
        snapshot = { status, account, loading: false, error: account?.error ?? status.error ?? null };
      } catch (error) { if (currentGeneration === generation) snapshot = { ...snapshot, loading: false, error: error instanceof Error ? error.message : String(error) }; }
      finally {
        if (pending === request) pending = null;
        if (currentGeneration === generation) for (const listener of listeners) listener();
      }
    });
    pending = request;
    return request;
  };
  const tick = async (currentGeneration: number) => { await refresh(); if (listeners.size && currentGeneration === generation) timer = setTimeout(() => void tick(currentGeneration), 1000); };
  return { invoke, refresh, getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      const currentGeneration = generation;
      const client = getCapabilityStreamClient();
      if (client) stopStream = client.subscribe({ capabilityId: 'hyperliquid.trading', operationId: watchAddress ? 'watchStream' : 'accountStream', payload: { network, ...(watchAddress ? { address: watchAddress } : {}) },
        onEvent: event => { if (currentGeneration !== generation) return; const data = event as { status: TradingStatus; account?: AccountSnapshot; error?: string }; snapshot = { status: data.status, account: data.account ?? null, error: data.error ?? data.account?.error ?? data.status.error ?? null, loading: false }; for (const listener of listeners) listener(); },
        onError: error => { if (currentGeneration !== generation) return; snapshot = { ...snapshot, error: String(error), loading: false }; for (const listener of listeners) listener(); },
      });
      else void tick(currentGeneration);
    }
    return () => { listeners.delete(listener); if (!listeners.size) { generation++; pending = null; clearTimeout(timer); stopStream?.(); stopStream = undefined; watch?.stop(); watch = null; stopMarket?.(); stopMarket = null; snapshot = initialAccount; } };
  } };
}
export function useAccount() {
  const [network] = useNetwork();
  const invoker = useCapabilityInvoker();
  const [watchAddress] = usePaneSettingValue<string>('watchAddress', '');
  const storeKey = `${network}:${watchAddress}`;
  let networks = accountStores.get(invoker);
  if (!networks) { networks = new Map(); accountStores.set(invoker, networks); }
  let store = networks.get(storeKey);
  if (!store) { store = createAccountStore(invoker, network, watchAddress); networks.set(storeKey, store); }
  const visible = usePaneVisible();
  const subscribe = useCallback((listener: () => void) => visible ? store!.subscribe(listener) : () => {}, [store, visible]);
  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
  return { ...snapshot, invoke: store.invoke, refresh: store.refresh, network };
}

export function useLiveFooter(id: string, state: { network: Network; status?: LiveStatus | string; asOf?: number | null; error?: string | null }, hints: PaneHint[] = [], auth?: TradingStatus | null, enabled = true) {
  const authLabel = auth?.mode === 'watch' ? 'Watch-only' : auth?.mode === 'trading' ? 'Trading' : auth?.mode === 'pending' ? 'Approval pending' : 'Read-only';
  usePaneFooter(id, () => !enabled ? null : ({
    info: [
      ...(state.network === 'testnet' ? [{ id: 'testnet', parts: [{ text: 'TESTNET', tone: 'warning' as const }] }] : []),
      ...(!auth || state.status?.toLowerCase() !== authLabel.toLowerCase() || state.asOf ? [{ id: 'live', parts: [{ text: `${state.status ?? 'connecting'}${state.asOf ? ` · ${time(state.asOf)} UTC` : ''}`, tone: state.status === 'live' ? 'positive' as const : 'muted' as const }] }] : []),
      ...(auth ? [{ id: 'auth', parts: [{ text: `${authLabel}${auth.address ? ` ${shortAddress(auth.address)}` : ''}`, tone: 'muted' as const }] }] : []),
      ...(state.error ? [{ id: 'error', parts: [{ text: state.error, tone: 'negative' as const }] }] : []),
    ], hints,
  }), [state.network, state.status, state.asOf, state.error, hints, auth, authLabel, enabled]);
}
export function useClock() {
  const [now, setNow] = useState(Date.now());
  const visible = usePaneVisible();
  useEffect(() => { if (!visible) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [visible]);
  return now;
}
