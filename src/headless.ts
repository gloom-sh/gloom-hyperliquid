import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneOptionDef } from 'gloomberb/types/plugin';
import { getLocalMarketService } from './runtime';
import { resolveMarket } from './market/normalize';
import { CANDLE_INTERVALS, type AssetClass, type CandleInterval } from './market/types';
import { AccountStore } from './trading/account';
import type { AccountSnapshot, Address, TradingStatus } from './trading/types';
import { configuredBuilder } from './trading/builder';
import { getCloudPerpsClient, RANKING_SECTIONS, type CloudHistoryQuery } from './market/cloud-history';

const numeric = (value: unknown) => value == null ? '--' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 });
const percent = (value: unknown) => value == null ? '--' : `${(Number(value) * 100).toFixed(4)}%`;
export const marketColumns: HeadlessPaneColumn[] = [
  { key: 'coin', header: 'Market' }, { key: 'dex', header: 'Dex' }, { key: 'assetClass', header: 'Class' },
  { key: 'mark', header: 'Mark', align: 'right', format: numeric },
  { key: 'oracle', header: 'Oracle', align: 'right', format: numeric },
  { key: 'premium', header: 'Premium', align: 'right', format: percent },
  { key: 'change24h', header: 'Rolling 24h', align: 'right', format: percent },
  { key: 'fundingHourly', header: 'Current / 1h', align: 'right', format: percent },
  { key: 'funding8h', header: 'Current / 8h', align: 'right', format: percent },
  { key: 'fundingApr', header: 'Simple APR', align: 'right', format: percent },
  { key: 'oiUsd', header: 'OI USD', align: 'right', format: numeric },
  { key: 'oiCoin', header: 'OI coin', align: 'right', format: numeric },
  { key: 'volume24h', header: 'Volume 24h USD', align: 'right', format: numeric },
  { key: 'oiVolume', header: 'OI / volume', align: 'right', format: numeric },
  { key: 'maxLeverage', header: 'Max leverage', align: 'right' },
  { key: 'collateral', header: 'Collateral' }, { key: 'onlyIsolated', header: 'Isolated only' },
];
export const reportOptions: HeadlessPaneOptionDef[] = [
  { key: 'network', type: 'enum', values: [{ value: 'mainnet' }, { value: 'testnet' }], defaultValue: 'mainnet', description: 'Exchange network', settingKey: 'network' },
  { key: 'class', type: 'enum', values: ['All', 'Stocks', 'Indices', 'Energy', 'Metals', 'FX', 'Crypto', 'Other'].map(value => ({ value })), defaultValue: 'All', description: 'Asset class', settingKey: 'assetClass' },
  { key: 'min-volume', type: 'integer', minimum: 0, description: 'Minimum 24h notional volume in USD', defaultValue: 0, settingKey: 'minVolumeUsd' },
  { key: 'min-oi', type: 'integer', minimum: 0, description: 'Minimum open interest in USD', defaultValue: 0, settingKey: 'minOiUsd' },
  { key: 'limit', type: 'integer', minimum: 1, maximum: 5000, defaultValue: 100, description: 'Maximum markets' },
  { key: 'interval', type: 'enum', values: CANDLE_INTERVALS.map(value => ({ value })), defaultValue: '15m', description: 'Candle interval', settingKey: 'interval' },
  { key: 'days', type: 'integer', minimum: 1, maximum: 3650, defaultValue: 7, description: 'Pro history lookback in days' },
  { key: 'resolution', type: 'enum', values: ['auto', 'minute', 'hour', 'day'].map(value => ({ value })), defaultValue: 'auto', description: 'Pro history resolution' },
  { key: 'tab', type: 'string', description: 'Initial pane tab', settingKey: 'defaultTab' },
  { key: 'watch-address', type: 'string', description: 'Read-only account address for account views', settingKey: 'watchAddress' },
];

export const hyperliquidHeadless: HeadlessPaneDefinition<'bundle'> = {
  shape: 'bundle',
  argument: { kind: 'free-text', placeholder: 'market', optional: true, description: 'Native coin (BTC, xyz:TSLA) or underlying ticker (TSLA).' },
  options: reportOptions,
  discovery: { id: 'hyperliquid.perpetuals', aliases: ['HLP'], screenshotReadiness: 'live-dom', limitations: ['Durable analytics require Gloom Pro and a host with plugin cloud authentication.', 'Trading requires the native account service.'] },
  async load(args, ctx) {
    const network = args.options.network === 'testnet' ? 'testnet' : 'mainnet';
    const service = getLocalMarketService(network);
    ctx.signal.throwIfAborted();
    await service.refresh();
    ctx.signal.throwIfAborted();
    const board = service.getSnapshot();
    const query = typeof args.argument === 'string' ? args.argument.trim() : '';
    if (query) {
      const market = resolveMarket(board.markets, query);
      if (!market) return { sections: [], complete: false, unavailableSymbols: [query], errors: [`No active perpetual market matches ${query}.`, ...(board.error ? [board.error] : [])] };
      const session = service.getMarket(market.coin, { interval: args.options.interval as CandleInterval ?? '15m' });
      const [, history] = await Promise.all([session.refresh(), getCloudPerpsClient(network).history(market.coin, {
        days: Number(args.options.days ?? 7), resolution: args.options.resolution as CloudHistoryQuery['resolution'] ?? 'auto', signal: ctx.signal,
      })]);
      ctx.signal.throwIfAborted();
      const detail = session.getSnapshot();
      return {
        sections: [
          { title: market.coin, columns: marketColumns, rows: [{ ...market }] },
          { title: 'Order book', rows: [...(detail.book?.bids ?? []).map(level => ({ side: 'bid', ...level })), ...(detail.book?.asks ?? []).map(level => ({ side: 'ask', ...level }))], columns: [{ key: 'side', header: 'Side' }, { key: 'price', header: 'Price', align: 'right' }, { key: 'size', header: 'Size', align: 'right' }, { key: 'totalSize', header: 'Cumulative', align: 'right' }] },
          { title: 'Cloud server-observed funding history', rows: (history.data?.funding ?? []).map(point => ({ ...point })), columns: [{ key: 'time', header: 'UTC', format: value => new Date(Number(value)).toISOString() }, { key: 'rate', header: 'Historical rate', align: 'right', format: percent }, { key: 'intervalHours', header: 'Interval hours', align: 'right' }, { key: 'premium', header: 'Funding premium', align: 'right', format: percent }] },
          { title: 'Cloud OI and premium history', rows: (history.data?.points ?? []).map(point => ({ ...point })), columns: [{ key: 'time', header: 'UTC', format: value => new Date(Number(value)).toISOString() }, { key: 'oiCoin', header: 'OI coin', align: 'right', format: numeric }, { key: 'oiUsd', header: 'OI USD', align: 'right', format: numeric }, { key: 'premium', header: 'Premium', align: 'right', format: percent }, { key: 'resolution', header: 'Resolution' }, { key: 'sampleCount', header: 'Samples', align: 'right' }] },
        ],
        symbols: [market.coin], complete: !detail.error && !board.error && history.state === 'ready' && !history.data?.truncated,
        errors: [board.error, detail.error, history.error].filter((error): error is string => Boolean(error)),
        metadata: { network, asOf: board.asOf, candleInterval: args.options.interval, candles: detail.candles, trades: detail.trades, annotation: detail.annotation, cloudHistory: history },
      };
    }
    const rows = board.markets.filter(market => (args.options.class === 'All' || !args.options.class || market.assetClass === args.options.class as AssetClass)
      && (market.volume24h ?? 0) >= Number(args.options['min-volume'] ?? 0)
      && (market.oiUsd ?? 0) >= Number(args.options['min-oi'] ?? 0))
      .sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1)).slice(0, Number(args.options.limit ?? 100));
    return {
      sections: [{ title: network === 'testnet' ? 'TESTNET perpetuals' : 'Perpetuals', columns: marketColumns, rows: rows.map(row => ({ ...row })) }],
      complete: !board.error, errors: board.error ? [board.error] : [],
      metadata: { network, asOf: board.asOf, dexes: board.dexes, fundingIntervalHours: 1, annualization: 'simple, hourly rate × 8760', changeDefinition: 'mark / prevDayPx - 1', oiUsdDefinition: 'open interest in coin × mark', ratesAreFractions: true },
    };
  },
};

export const analyticsHeadless: HeadlessPaneDefinition<'bundle'> = {
  ...hyperliquidHeadless,
  discovery: { id: 'hyperliquid.analytics', screenshotReadiness: 'live-dom' },
  async load(args, ctx) {
    if (typeof args.argument === 'string' && args.argument.trim()) return hyperliquidHeadless.load(args, ctx);
    const network = args.options.network === 'testnet' ? 'testnet' : 'mainnet';
    const service = getLocalMarketService(network);
    const [, rankings] = await Promise.all([service.refresh(), getCloudPerpsClient(network).rankings({ signal: ctx.signal })]);
    ctx.signal.throwIfAborted();
    const snapshot = service.getSnapshot();
    const titles: Record<typeof RANKING_SECTIONS[number], string> = { fundingPositive: 'Cloud positive funding', fundingNegative: 'Cloud negative funding', oiSurges: 'Cloud OI surges', premiumDislocations: 'Cloud premium dislocations', closedMarketDislocations: 'Cloud closed-market dislocations' };
    const columns: HeadlessPaneColumn[] = [
      { key: 'coin', header: 'Market' }, { key: 'assetClass', header: 'Class' },
      { key: 'fundingRate', header: 'Funding rate', align: 'right', format: percent }, { key: 'fundingIntervalHours', header: 'Interval hours', align: 'right' }, { key: 'fundingKind', header: 'Funding kind' },
      ...marketColumns.filter(column => ['funding8h', 'fundingApr', 'oiUsd', 'volume24h', 'premium'].includes(column.key)),
      { key: 'oiChange1h', header: 'OI coin 1h', align: 'right', format: percent }, { key: 'oiChange24h', header: 'OI coin 24h', align: 'right', format: percent },
      { key: 'oiChange1hUsd', header: 'OI USD 1h', align: 'right', format: percent }, { key: 'oiChange24hUsd', header: 'OI USD 24h', align: 'right', format: percent },
      { key: 'closedMarketPremium', header: 'Closed cash premium', align: 'right', format: percent },
    ];
    return { sections: [
      ...RANKING_SECTIONS.map(section => ({ title: titles[section], columns, rows: (rankings.data?.[section] ?? []).filter(market => (!args.options.class || args.options.class === 'All' || market.assetClass === args.options.class)
        && (market.volume24h ?? 0) >= Number(args.options['min-volume'] ?? 0) && (market.oiUsd ?? 0) >= Number(args.options['min-oi'] ?? 0)).slice(0, Number(args.options.limit ?? 100)).map(row => ({ ...row })) })),
      { title: 'Predicted funding reported by Hyperliquid', columns: [{ key: 'coin', header: 'Market' }, { key: 'venue', header: 'Reported venue' }, { key: 'rate', header: 'Reported rate', format: percent }, { key: 'intervalHours', header: 'Interval hours' }, { key: 'per8h', header: 'Per 8h', format: percent }, { key: 'apr', header: 'Simple APR', format: percent }], rows: snapshot.predictedFundings.map(row => ({ ...row })) },
    ], complete: !snapshot.error && rankings.state === 'ready', errors: [snapshot.error, rankings.error].filter((error): error is string => Boolean(error)), metadata: { asOf: snapshot.asOf, network, cloudRankings: { ...rankings, data: undefined }, historyMethod: 'Gloom Pro cloud observations. No local history reconstruction.', ratesAreFractions: true } };
  },
};

export const accountHeadless: HeadlessPaneDefinition<'bundle'> = {
  ...hyperliquidHeadless,
  argument: { kind: 'none' },
  discovery: { id: 'hyperliquid.account', screenshotReadiness: 'live-dom' },
  async load(args, ctx) {
    const network = args.options.network === 'testnet' ? 'testnet' : 'mainnet';
    const watchAddress = args.options['watch-address'];
    let snapshot: AccountSnapshot;
    if (typeof watchAddress === 'string' && /^0x[0-9a-fA-F]{40}$/.test(watchAddress)) {
      const store = new AccountStore(network, getLocalMarketService(network));
      try { snapshot = await store.setAddress(watchAddress as Address); } finally { store.stop(); }
    } else {
      if (watchAddress) throw new Error('Enter a valid watch-only address.');
      if (!ctx.capabilities) throw new Error('Use --watch-address or connect an account in the native app.');
      const status = await ctx.capabilities.invokeCapability<TradingStatus>('hyperliquid.trading', 'status', { network });
      if (!status.address) return { sections: [], errors: ['No account connected. Use HLS or --watch-address.'], complete: false };
      snapshot = await ctx.capabilities.invokeCapability<AccountSnapshot>('hyperliquid.trading', 'account', { network });
    }
    ctx.signal.throwIfAborted();
    return { sections: [
      { title: 'Account', entries: [{ label: 'Address', value: snapshot.address }, { label: 'Network', value: network }, { label: 'Mode', value: snapshot.abstraction }, { label: 'USDC account value', value: snapshot.accountValue }, { label: 'Available USDC', value: snapshot.available }, { label: 'Margin used USDC', value: snapshot.marginUsed }] },
      { title: 'Positions', rows: snapshot.positions.map(position => ({ ...position })), columns: [{ key: 'coin', header: 'Market' }, { key: 'szi', header: 'Size' }, { key: 'entryPx', header: 'Entry' }, { key: 'unrealizedPnl', header: 'Unrealized PnL' }, { key: 'liquidationPx', header: 'Liquidation' }, { key: 'marginUsed', header: 'Margin' }] },
      { title: 'Open orders', rows: snapshot.orders.map(order => ({ ...order })) },
      { title: 'Balances by dex', rows: snapshot.balances.map(balance => ({ ...balance })) },
    ], metadata: { asOf: snapshot.updatedAt, network, fills: snapshot.fills, orderHistory: snapshot.orderHistory, funding: snapshot.funding, ledger: snapshot.ledger, spot: snapshot.spot, fees: snapshot.fees }, complete: !snapshot.stale && !snapshot.error, errors: snapshot.error ? [snapshot.error] : [] };
  },
};

export const setupHeadless: HeadlessPaneDefinition<'bundle'> = {
  shape: 'bundle', argument: { kind: 'none' }, options: reportOptions,
  discovery: { id: 'hyperliquid.connection', screenshotReadiness: 'live-dom' },
  load(args) {
    const network = args.options.network === 'testnet' ? 'testnet' : 'mainnet';
    return { sections: [{ title: 'Connection', entries: [
      { label: 'Network', value: network }, { label: 'Builder fee active', value: Boolean(configuredBuilder(network)) },
      { label: 'Connect', value: 'Open HLS in the app. API wallet credentials stay in the native process.' },
    ] }] };
  },
};
