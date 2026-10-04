import { afterEach, describe, expect, test } from 'bun:test';
import { CloudPerpsClient, cloudMarketId, configureCloudPerpsClient, getCloudPerpsClient, normalizeCloudHistory, normalizeCloudRankings } from './cloud-history.ts';

const time = '2026-10-04T10:00:00.000Z';
const marketId = 'hyperliquid:default:BTC';
const observedAt = '2026-10-04T10:59:00.000Z';
function history(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok', marketId, asOf: observedAt, from: time, to: observedAt, resolution: 'hour', truncated: true, access: 'pro', locked: false,
    rows: [{ time, resolution: 'day', markPrice: 101_000, oraclePrice: 100_000, premium: 0.01, fundingRate: 0.0001,
      fundingIntervalHours: 1, openInterestBase: 50, openInterestUsd: 5_050_000, sampleCount: 58, firstObservedAt: time, lastObservedAt: observedAt }],
    funding: [{ marketId, time, rate: 0.00005, intervalHours: 1, premium: 0.0002, observedAt, sourceUrl: 'https://api.hyperliquid.xyz/info' }],
    candles: [{ marketId, time, interval: '1h', open: 100_000, high: 102_000, low: 99_000, close: 101_000, volumeBase: 3, trades: 7, observedAt, sourceUrl: 'https://api.hyperliquid.xyz/info' }],
    ...overrides,
  };
}
function ranked(coin: string, overrides: Record<string, unknown> = {}) {
  return { marketId: cloudMarketId(coin), venue: 'hyperliquid', dex: coin.includes(':') ? coin.split(':')[0] : 'default', baseAsset: coin.split(':').at(-1),
    assetClass: 'crypto', markPrice: 101_000, oraclePrice: 100_000, premium: 0.01, fundingRate: 0.0001, fundingIntervalHours: 1, fundingKind: 'current',
    fundingRate8h: 0.0008, fundingApr: 0.876, openInterestBase: 50, openInterestUsd: 5_050_000, volume24hUsd: 20_000_000,
    oiChange1h: 0.02, oiChange24h: 0.1, oiUsdChange1h: 0.03, oiUsdChange24h: 0.12, observedAt, sourceAsOf: null,
    sourceUrl: 'https://api.hyperliquid.xyz/info', confidence: 'high', qualityFlags: ['non-usdc-collateral'], marginCurrency: 'USDH', stale: false, ...overrides };
}
const ranks = (overrides: Record<string, unknown> = {}) => ({ status: 'ok', asOf: observedAt, access: 'pro', locked: false,
  fundingPositive: [ranked('BTC'), ranked('xyz:TSLA', { assetClass: 'stocks' })], fundingNegative: [], oiSurges: [], premiumDislocations: [], closedMarketDislocations: [], ...overrides });
afterEach(() => configureCloudPerpsClient(null));

describe('cloud history contract and financial semantics', () => {
  test('identifiers preserve exact native and HIP-3 contract identity', () => {
    expect(cloudMarketId(' BTC ')).toBe(marketId);
    expect(cloudMarketId('xyz:TSLA')).toBe('hyperliquid:xyz:TSLA');
    expect(cloudMarketId('hyperliquid:xyz:TSLA')).toBe('hyperliquid:xyz:TSLA');
    expect(() => cloudMarketId('a:b:c:d')).toThrow();
    expect(() => cloudMarketId('BTC?marketId=ETH')).toThrow();
  });
  test('rollups keep true resolution, sample counts, observation bounds, truncation and fractional rates', () => {
    const result = normalizeCloudHistory(history());
    expect(result.resolution).toBe('hour');
    expect(result.points[0]).toEqual({ time: Date.parse(time), resolution: 'day', mark: 101_000, oracle: 100_000, premium: 0.01,
      fundingRate: 0.0001, fundingIntervalHours: 1, oiCoin: 50, oiUsd: 5_050_000, sampleCount: 58, firstObservedAt: Date.parse(time), lastObservedAt: Date.parse(observedAt) });
    expect(result.truncated).toBe(true);
    expect(result.funding[0]?.rate).toBe(0.00005);
    expect(result.funding[0]?.premium).toBe(0.0002);
    expect(result.candles[0]?.volume).toBe(3);
    expect(result.funding[0]?.sourceUrl).toBe('https://api.hyperliquid.xyz/info');
  });
  test('missing history remains missing and cannot be reconstructed from funding or candles', () => {
    const result = normalizeCloudHistory(history({ rows: [] }));
    expect(result.points).toEqual([]);
    expect(result.funding).toHaveLength(1);
    expect(result.candles).toHaveLength(1);
  });
  test('nested funding/candle rows from another contract are rejected', () => {
    const data = history();
    expect(normalizeCloudHistory(history({ funding: [{ ...data.funding[0], marketId: 'hyperliquid:xyz:BTC' }], candles: [{ ...data.candles[0], marketId: 'hyperliquid:xyz:BTC' }] })).funding).toEqual([]);
    expect(normalizeCloudHistory(history({ candles: [{ ...data.candles[0], marketId: 'hyperliquid:xyz:BTC' }] })).candles).toEqual([]);
  });
  test('rankings keep server order, exact units and provenance while excluding other venues', () => {
    const result = normalizeCloudRankings(ranks({ fundingPositive: [ranked('xyz:TSLA', { assetClass: 'stocks' }), ranked('BTC'), ranked('ETH', { venue: 'binance' })] }));
    expect(result.fundingPositive.map(row => row.coin)).toEqual(['xyz:TSLA', 'BTC']);
    expect(result.fundingPositive[0]).toMatchObject({ dex: 'xyz', assetClass: 'Stocks', funding8h: 0.0008, fundingApr: 0.876,
      oiChange1h: 0.02, oiChange24h: 0.1, oiChange1hUsd: 0.03, oiChange24hUsd: 0.12, sourceAsOf: null, collateral: 'USDH', confidence: 'high', qualityFlags: ['non-usdc-collateral'] });
  });
});

describe('cloud transport, entitlement and availability', () => {
  test('history sends a bounded UTC query and forwards cancellation', async () => {
    const controller = new AbortController();
    let requested = '';
    const client = new CloudPerpsClient({ request: async (path, options) => { requested = path; expect(options?.signal).toBe(controller.signal); return { status: 200, body: history() }; } });
    expect((await client.history('BTC', { from: time, to: observedAt, resolution: 'hour', limit: 123, signal: controller.signal })).state).toBe('ready');
    const query = new URL(requested, 'https://example.invalid').searchParams;
    expect(query.get('marketId')).toBe(marketId);
    expect(query.get('from')).toBe(time);
    expect(query.get('to')).toBe(observedAt);
    expect(query.get('resolution')).toBe('hour');
    expect(query.get('limit')).toBe('123');
  });
  test('preview never exposes history, even if rows incorrectly arrive in the response', async () => {
    const request = async () => ({ status: 200, body: history({ access: 'preview', locked: true }) });
    const anonymous = await new CloudPerpsClient({ request }).history('BTC');
    const free = await new CloudPerpsClient({ request, signedIn: () => true }).history('BTC');
    expect(anonymous).toMatchObject({ state: 'sign-in', locked: true, data: null });
    expect(free).toMatchObject({ state: 'pro-required', locked: true, data: null });
  });
  test('anonymous ranking preview retains allowed rows and reports the host auth gap honestly', async () => {
    const client = new CloudPerpsClient({ request: async () => ({ status: 200, body: ranks({ access: 'preview', locked: true }) }), authenticationAvailable: false });
    const result = await client.rankings();
    expect(result.state).toBe('host-unavailable');
    expect(result.locked).toBe(true);
    expect(result.data?.fundingPositive).toHaveLength(2);
    expect(result.error).toContain('cannot share your Cloud login');
  });
  test('history without host authentication and testnet make no cloud request', async () => {
    let calls = 0;
    const request = async () => { calls++; return { status: 200, body: history() }; };
    expect((await new CloudPerpsClient({ request, authenticationAvailable: false }).history('BTC')).state).toBe('host-unavailable');
    const testnet = new CloudPerpsClient({ request, network: 'testnet' });
    expect((await testnet.history('BTC')).state).toBe('testnet');
    expect((await testnet.history('i<3fl:TEST')).state).toBe('testnet');
    expect((await testnet.rankings()).state).toBe('testnet');
    expect(calls).toBe(0);
  });
  test('missing or unavailable server routes have no direct or local history fallback', async () => {
    for (const status of [404, 503]) {
      let calls = 0;
      const result = await new CloudPerpsClient({ request: async () => { calls++; return { status, body: {} }; } }).history('BTC');
      expect(result).toMatchObject({ state: 'unavailable', data: null });
      expect(calls).toBe(1);
    }
  });
  test('collecting and partial responses retain the reported state', async () => {
    expect((await new CloudPerpsClient({ request: async () => ({ status: 200, body: history({ status: 'collecting', rows: [] }) }) }).history('BTC')).state).toBe('collecting');
    expect((await new CloudPerpsClient({ request: async () => ({ status: 200, body: ranks({ status: 'partial' }) }) }).rankings()).state).toBe('partial');
  });
  test('different market, malformed history and absent entitlement are explicit errors', async () => {
    for (const body of [history({ marketId: 'hyperliquid:xyz:BTC' }), history({ from: 'invalid' }), history({ access: undefined })]) {
      const result = await new CloudPerpsClient({ request: async () => ({ status: 200, body }) }).history('BTC');
      expect(result).toMatchObject({ state: 'error', data: null });
    }
  });
  test('aborted requests reject and obsolete data cannot complete', async () => {
    const controller = new AbortController();
    const client = new CloudPerpsClient({ request: async () => { controller.abort(new Error('Obsolete market')); return { status: 200, body: history() }; } });
    await expect(client.history('BTC', { signal: controller.signal })).rejects.toThrow('Obsolete market');
    let calls = 0;
    await expect(new CloudPerpsClient({ request: async () => { calls++; return { status: 200, body: ranks() }; } }).rankings({ signal: controller.signal })).rejects.toThrow('Obsolete market');
    expect(calls).toBe(0);
  });
  test('supported injected transport replaces the default without exposing credentials', async () => {
    configureCloudPerpsClient({ request: async () => ({ status: 200, body: history() }), signedIn: () => true });
    expect((await getCloudPerpsClient('mainnet').history('BTC')).state).toBe('ready');
    expect((await getCloudPerpsClient('testnet').history('BTC')).state).toBe('testnet');
    configureCloudPerpsClient(null);
    expect((await getCloudPerpsClient('mainnet').history('BTC')).state).toBe('host-unavailable');
  });
});
