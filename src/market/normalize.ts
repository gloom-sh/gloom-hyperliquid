import type { AssetClass, BookLevel, Candle, Dex, FundingPoint, Market, OrderBook, PredictedFunding, RawContext, RawMeta, Trade } from './types.ts';
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
const product = (a: number | null, b: number | null) => a === null || b === null ? null : a * b;
const ratio = (a: number | null, b: number | null) => a === null || b === null || b <= 0 ? null : a / b;
const metals = new Set(['GOLD','SILVER','COPPER','PLATINUM','PALLADIUM','ALUMINIUM','ALUMINUM','XAU','XAG']);
const energy = new Set(['OIL','USOIL','BRENTOIL','BRENT','WTI','CL','GAS','NATGAS','TTF','HO','URANIUM']);
/** Venue categories take precedence. Unknown HIP-3 listings remain Other. */
export function assetClass(coin: string, category?: string | null): AssetClass {
  const symbol = coin.split(':').at(-1)!.toUpperCase();
  if (metals.has(symbol)) return 'Metals';
  if (energy.has(symbol)) return 'Energy';
  switch (category?.toLowerCase()) {
    case 'stock': case 'stocks': case 'equity': case 'equities': case 'preipo': return 'Stocks';
    case 'index': case 'indices': return 'Indices';
    case 'fx': case 'forex': return 'FX';
    case 'crypto': case 'cryptocurrency': return 'Crypto';
    case 'energy': return 'Energy'; case 'metals': return 'Metals';
  }
  return coin.includes(':') ? 'Other' : 'Crypto';
}
export function applyContext(market: Market, ctx: RawContext, time: number): Market {
  const mark = numberOrNull(ctx.markPx), oracle = numberOrNull(ctx.oraclePx), oiCoin = numberOrNull(ctx.openInterest);
  const fundingHourly = numberOrNull(ctx.funding), prevDayPrice = numberOrNull(ctx.prevDayPx), volume24h = numberOrNull(ctx.dayNtlVlm);
  const oiUsd = product(oiCoin, mark), premium = ratio(mark, oracle), change = ratio(mark, prevDayPrice);
  return { ...market, mark, oracle, mid: numberOrNull(ctx.midPx), premium: premium === null ? null : premium - 1,
    fundingPremium: numberOrNull(ctx.premium), prevDayPrice, change24h: change === null ? null : change - 1,
    fundingHourly, funding8h: product(fundingHourly, 8), fundingApr: product(fundingHourly, 8760), oiCoin, oiUsd, volume24h,
    oiVolume: ratio(oiUsd, volume24h), asOf: time, priceTime: mark !== market.mark ? time : market.priceTime,
    tickDirection: mark !== null && market.mark !== null ? mark > market.mark ? 1 : mark < market.mark ? -1 : market.tickDirection : 0 };
}
const cashIndices: Record<string,string> = {SP500:'^GSPC',US500:'^GSPC',USA500:'^GSPC',USTECH:'^NDX',USA100:'^NDX',SMALL2000:'^RUT',VIX:'^VIX',JP225:'^N225',DXY:'DX-Y.NYB'};
const cashStocks = new Set('AAPL AAOI AMAT AMD AMZN ARM ASML AVGO BABA BB BE BMNR BX CIEN CIFR COHR COIN COST CRCL CRDO CRWD CRWV CVX DELL DKNG EBAY GEV GLW GME GOOGL GPRO HIMS HOOD IBM INTC IONQ IREN LITE LLY LRCX MELI META MRNA MRVL MSFT MSTR MU NBIS NET NFLX NOK NOW NVDA ORCL PLTR QCOM RDDT RIVN RKLB RTX SMCI SNDK SOFI STX TER TSLA TSM TTWO USAR VST WDC ZM'.split(' '));
function underlyingSymbol(symbol:string,klass:AssetClass,category:string|null):string|null { if(category==='preipo')return null;if(klass==='Indices')return cashIndices[symbol]??null;if(klass==='Stocks'&&cashStocks.has(symbol))return symbol;return null }
export function normalizeMarkets(meta: RawMeta, contexts: RawContext[], dex: Dex, categories: Map<string, string>, now: number): Market[] {
  const tables = new Map(meta.marginTables ?? []);
  return meta.universe.flatMap((asset, index) => {
    if (asset.isDelisted) return [];
    const category = categories.get(asset.name) ?? null, klass = assetClass(asset.name, category);
    const market: Market = { coin: asset.name, symbol: asset.name.split(':').at(-1)!, dex: dex.name,
      assetId: dex.index === 0 ? index : 100_000 + dex.index * 10_000 + index, universeIndex: index,
      assetClass: klass, category, underlyingSymbol:underlyingSymbol(asset.name.split(':').at(-1)!,klass,category), alwaysOpen: ['Stocks','Indices','Energy','Metals','FX'].includes(klass), maxLeverage: asset.maxLeverage,
      onlyIsolated: !!asset.onlyIsolated || asset.marginMode === 'strictIsolated' || asset.marginMode === 'noCross', marginMode: asset.marginMode ?? null,
      collateral: dex.collateral, collateralToken: dex.collateralToken, szDecimals: asset.szDecimals,
      marginTiers: (tables.get(asset.marginTableId ?? asset.maxLeverage)?.marginTiers ?? [{lowerBound:'0', maxLeverage:asset.maxLeverage}]).map(t => ({lowerBound: Number(t.lowerBound), maxLeverage:t.maxLeverage})),
      deployer: dex.deployer, oracleUpdater: dex.oracleUpdater, fundingCap: 0.04, fundingMultiplier: dex.fundingMultipliers[asset.name] ?? null,
      growthMode: asset.growthMode ?? null, deployerFeeScale: numberOrNull(asset.deployerFeeScale),
      mark:null, oracle:null, mid:null, premium:null, fundingPremium:null, change24h:null, prevDayPrice:null,
      fundingHourly:null, funding8h:null, fundingApr:null, oiCoin:null, oiUsd:null, volume24h:null, oiVolume:null,
      oiChange1h:null, oiChange24h:null, oiChange1hUsd:null, oiChange24hUsd:null, asOf:now, priceTime:now, tickDirection:0 };
    return [applyContext(market, contexts[index] ?? {}, now)];
  });
}
export function normalizeBook(raw: any): OrderBook {
  const levels = (rows: any[]): BookLevel[] => {
    let totalSize = 0, totalUsd = 0;
    return rows.flatMap(row => { const price = numberOrNull(row.px), size = numberOrNull(row.sz);
      if (price === null || price <= 0 || size === null || size < 0) return [];
      totalSize += size; totalUsd += price * size;
      return [{price,size,orders:Number(row.n) || 0,totalSize,totalUsd}]; });
  };
  const bids = levels(raw.levels?.[0] ?? []), asks = levels(raw.levels?.[1] ?? []);
  const bestBid = bids[0]?.price, bestAsk = asks[0]?.price;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
  return {coin:raw.coin,bids,asks,spread,spreadBps:spread !== null && mid ? spread / mid * 10000 : null,mid,time:Number(raw.time)};
}
export function normalizeCandle(raw: any): Candle | null {
  const values = [raw.t,raw.T,raw.o,raw.h,raw.l,raw.c,raw.v,raw.n].map(numberOrNull);
  if (values.some(v => v === null)) return null;
  const [time,endTime,open,high,low,close,volume,trades] = values as [number,number,number,number,number,number,number,number];
  return {time,endTime,open,high,low,close,volume,trades};
}
export function normalizeTrade(raw: any): Trade | null {
  const price = numberOrNull(raw.px), size = numberOrNull(raw.sz), time = numberOrNull(raw.time);
  if (price === null || size === null || time === null || !['B','A'].includes(raw.side)) return null;
  return {id:`${raw.coin}:${time}:${raw.tid ?? raw.hash}`,coin:raw.coin,side:raw.side === 'B' ? 'buy' : 'sell',price,size,time};
}
export function normalizeFunding(raw: any): FundingPoint | null {
  const time = numberOrNull(raw.time), rate = numberOrNull(raw.fundingRate);
  return time === null || rate === null ? null : {time,rate,premium:numberOrNull(raw.premium)};
}
export function normalizePredicted(raw: unknown): PredictedFunding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(([coin, venues]) => Array.isArray(venues) ? venues.flatMap(([venue, data]) => {
    if (!data) return [];
    const rate = numberOrNull(data.fundingRate), intervalHours = numberOrNull(data.fundingIntervalHours), nextFundingTime = numberOrNull(data.nextFundingTime);
    return rate === null || intervalHours === null || intervalHours <= 0 || nextFundingTime === null ? [] : [{coin,venue,rate,intervalHours,nextFundingTime,per8h:rate*8/intervalHours,apr:rate*8760/intervalHours}];
  }) : []);
}
export function resolveMarket(markets: Market[], query: string): Market | undefined {
  const normalized = query.trim().replace(/-PERP$/i,'').toUpperCase();
  return markets.find(m => m.coin.toUpperCase() === normalized) ?? markets.filter(m => m.symbol.toUpperCase() === normalized).sort((a,b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))[0];
}
export function nextFundingTime(now = Date.now()): number { return (Math.floor(now / 3_600_000) + 1) * 3_600_000 }
