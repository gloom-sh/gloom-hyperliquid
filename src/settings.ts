import type { PluginConfigField } from 'gloomberb/types/plugin';
import type { TradingSettings } from './trading/types';

export const configSchema: PluginConfigField[] = [
  { key: 'network', label: 'Network', type: 'select', required: false, defaultValue: 'mainnet', options: [{ label: 'Mainnet', value: 'mainnet' }, { label: 'TESTNET', value: 'testnet' }] },
  { key: 'approvalPort', label: 'Wallet approval port (0 = random)', type: 'number', required: false, defaultValue: '0', description: 'For SSH tunnels, choose an unused local port and forward the same port to this machine.' },
  { key: 'slippageBps', label: 'Market slippage cap (basis points)', type: 'number', required: false, defaultValue: '50' },
  { key: 'confirmations', label: 'Confirm orders', type: 'select', required: false, defaultValue: 'true', options: [{ label: 'Always', value: 'true' }, { label: 'Only warnings', value: 'false' }] },
  { key: 'sizeUnit', label: 'Default size unit', type: 'select', required: false, defaultValue: 'usd', options: [{ label: 'USD', value: 'usd' }, { label: 'Coin', value: 'coin' }, { label: '% buying power', value: 'percent' }] },
  { key: 'defaultLeverage', label: 'Default leverage', type: 'number', required: false, defaultValue: '3' },
  { key: 'leverageBehavior', label: 'Leverage selection', type: 'select', required: false, defaultValue: 'position', options: [{ label: 'Use existing position, otherwise default', value: 'position' }, { label: 'Use default', value: 'default' }] },
  { key: 'minVolumeUsd', label: 'Minimum 24h volume (USD)', type: 'number', required: false, defaultValue: '0' },
  { key: 'minOiUsd', label: 'Minimum open interest (USD)', type: 'number', required: false, defaultValue: '0' },
  { key: 'fatFingerPercent', label: 'Warn if price differs from mark (%)', type: 'number', required: false, defaultValue: '5' },
  { key: 'maxOrderUsd', label: 'Warn above order notional (USD)', type: 'number', required: false, defaultValue: '10000' },
];

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  if (value === '' || value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

export function readSettings(values: Record<string, unknown>) {
  return {
    network: values.network === 'testnet' ? 'testnet' as const : 'mainnet' as const,
    approvalPort: Math.floor(bounded(values.approvalPort, 0, 0, 65535)),
    slippageBps: bounded(values.slippageBps, 50, 1, 5000),
    confirmations: values.confirmations !== false && values.confirmations !== 'false',
    sizeUnit: values.sizeUnit === 'coin' ? 'coin' as const : values.sizeUnit === 'percent' ? 'percent' as const : 'usd' as const,
    defaultLeverage: Math.floor(bounded(values.defaultLeverage, 3, 1, 100)),
    leverageBehavior: values.leverageBehavior === 'default' ? 'default' as const : 'position' as const,
    minVolumeUsd: bounded(values.minVolumeUsd, 0, 0, 1e15),
    minOiUsd: bounded(values.minOiUsd, 0, 0, 1e15),
    fatFingerPercent: bounded(values.fatFingerPercent, 5, 0.1, 100),
    maxOrderUsd: bounded(values.maxOrderUsd, 10_000, 10, 1e12),
  };
}

export function tradingSettings(values: Record<string, unknown>): TradingSettings {
  const settings = readSettings(values);
  return {
    slippagePercent: settings.slippageBps / 100,
    confirmations: settings.confirmations,
    maxOrderNotional: settings.maxOrderUsd,
    maxPriceDistancePercent: settings.fatFingerPercent,
  };
}
