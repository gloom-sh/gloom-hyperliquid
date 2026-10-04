import { formatPrice, formatSize } from '@nktkas/hyperliquid/utils';
import type { BookLevel, TradingMarket } from './types';

export function finitePositive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
export function roundSize(size: number | string, decimals: number): string {
  if (!finitePositive(Number(size)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error('Size must be positive and use valid lot precision.');
  return formatSize(size, decimals);
}
/** Floor buys and ceil sells so rounding cannot exceed the user's price cap. */
export function roundPrice(price: number | string, decimals: number, direction: 'down' | 'up' = 'down'): string {
  const n = Number(price);
  if (!finitePositive(n)) throw new Error('Price must be positive.');
  const down = formatPrice(price, decimals);
  if (direction === 'down' || Number(down) === n) return down;
  const places = Math.max(0, Math.min(6 - decimals, 4 - Math.floor(Math.log10(n))));
  const tick = 10 ** -places;
  // Integers are exempt from the significant-figure rule; ceiling the original
  // price matters when the SDK rounded a >5-digit fractional value by tens.
  const upper=Math.ceil(n/tick)*tick;
  return formatPrice(upper.toFixed(places), decimals);
}
export function maintenanceTier(notional: number, market: TradingMarket): { rate: number; deduction: number } {
  const tiers = [...(market.marginTiers?.length ? market.marginTiers : [{lowerBound: 0, maxLeverage: market.maxLeverage}])].sort((a,b) => a.lowerBound-b.lowerBound);
  let rate = 1 / (2 * tiers[0]!.maxLeverage), deduction = 0;
  for (const tier of tiers.slice(1)) {
    if (notional < tier.lowerBound) break;
    const next = 1 / (2 * tier.maxLeverage);
    deduction += tier.lowerBound * (next - rate); rate = next;
  }
  return {rate, deduction};
}
/** Isolated new-position estimate. Existing/cross positions use the exchange's liquidationPx. */
export function isolatedLiquidation(entry: number, size: number, margin: number, buy: boolean, market: TradingMarket): number | null {
  if (![entry,size,margin].every(finitePositive)) return null;
  let result = entry;
  for (let i=0; i<8; i++) {
    const {rate,deduction} = maintenanceTier(result*size, market);
    const next = buy ? (size*entry-margin-deduction)/(size*(1-rate)) : (size*entry+margin+deduction)/(size*(1+rate));
    if (next <= 0) return null;
    if (Math.abs(result-next)<1e-8) return next;
    result = next;
  }
  return result;
}
export function estimateFill(levels: BookLevel[], size: number, cap: number, buy: boolean) {
  let remaining = size, notional = 0;
  for (const level of levels) {
    const px=Number(level.px), available=Number(level.sz);
    if (!finitePositive(px) || !finitePositive(available)) continue;
    if (buy ? px > cap : px < cap) break;
    const fill=Math.min(remaining,available); notional+=fill*px; remaining-=fill;
    if (remaining < 1e-12) break;
  }
  return { average: size > remaining ? notional/(size-remaining) : null, unfilled: Math.max(0,remaining) };
}
