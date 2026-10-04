export type Network = 'mainnet' | 'testnet';
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stale' | 'error';
export type AssetClass = 'Stocks' | 'Indices' | 'Energy' | 'Metals' | 'FX' | 'Crypto' | 'Other';
export const CANDLE_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'] as const;
export type CandleInterval = typeof CANDLE_INTERVALS[number];
export interface LocalStore { get<T>(key: string): T | undefined; set<T>(key: string, value: T): void }
export interface MarginTier { lowerBound: number; maxLeverage: number }
export interface Dex {
  name: string; fullName: string; index: number; deployer: string | null; oracleUpdater: string | null;
  collateral: string; collateralToken: number; fundingMultipliers: Record<string, number>;
}
/** All rates/changes/premiums are fractions, never percent points. Missing data stays null. */
export interface Market {
  coin: string; symbol: string; dex: string; assetId: number; universeIndex: number;
  assetClass: AssetClass; category: string | null; alwaysOpen: boolean; underlyingSymbol: string | null;
  maxLeverage: number; onlyIsolated: boolean; marginMode: string | null;
  collateral: string; collateralToken: number; szDecimals: number; marginTiers: MarginTier[];
  deployer: string | null; oracleUpdater: string | null; fundingCap: number;
  fundingMultiplier: number | null; growthMode: string | null; deployerFeeScale: number | null;
  mark: number | null; oracle: number | null; mid: number | null; premium: number | null;
  /** Venue funding premium differs from the simple mark/oracle premium. */
  fundingPremium: number | null; change24h: number | null; prevDayPrice: number | null;
  fundingHourly: number | null; funding8h: number | null; fundingApr: number | null;
  oiCoin: number | null; oiUsd: number | null; volume24h: number | null; oiVolume: number | null;
  oiChange1h: number | null; oiChange24h: number | null; oiChange1hUsd: number | null; oiChange24hUsd: number | null;
  asOf: number; priceTime: number; tickDirection: -1 | 0 | 1;
}
export interface PredictedFunding { coin: string; venue: string; rate: number; intervalHours: number; per8h: number; apr: number; nextFundingTime: number }
export interface BoardSnapshot { markets: Market[]; dexes: Dex[]; status: LiveStatus; asOf: number | null; error: string | null; predictedFundings: PredictedFunding[] }
export interface Candle { time: number; endTime: number; open: number; high: number; low: number; close: number; volume: number; trades: number }
export interface BookLevel { price: number; size: number; orders: number; totalSize: number; totalUsd: number }
export interface OrderBook { coin: string; bids: BookLevel[]; asks: BookLevel[]; spread: number | null; spreadBps: number | null; mid: number | null; time: number; nSigFigs?: 2 | 3 | 4 | 5 | null; mantissa?: 1 | 2 | 5 | null }
export interface Trade { id: string; coin: string; side: 'buy' | 'sell'; price: number; size: number; time: number }
export interface FundingPoint { time: number; rate: number; premium: number | null }
export interface OiPoint { time: number; coin: number; usd: number }
export interface PerpAnnotation { category?: string; description?: string; displayName?: string; keywords?: string[] }
export interface MarketSnapshot { market: Market | null; book: OrderBook | null; candles: Candle[]; trades: Trade[]; funding: FundingPoint[]; oiHistory: OiPoint[]; annotation: PerpAnnotation | null; status: LiveStatus; asOf: number | null; error: string | null }
export interface MarketOptions { interval?: CandleInterval; nSigFigs?: 2 | 3 | 4 | 5 | null; mantissa?: 1 | 2 | 5 }
export interface MarketSession { getSnapshot(): MarketSnapshot; subscribe(listener: () => void): () => void; refresh(): Promise<void> }
export interface RawAsset { name: string; szDecimals: number; maxLeverage: number; marginTableId?: number; isDelisted?: boolean; onlyIsolated?: boolean; marginMode?: string; growthMode?: string; deployerFeeScale?: string }
export interface RawMeta { universe: RawAsset[]; collateralToken?: number; marginTables?: [number, { marginTiers: { lowerBound: string; maxLeverage: number }[] }][] }
export interface RawContext { markPx?: string | number; oraclePx?: string | number; midPx?: string | number | null; funding?: string | number; premium?: string | number; openInterest?: string | number; prevDayPx?: string | number; dayNtlVlm?: string | number }
export interface RawDex { name: string; fullName: string; deployer?: string | null; oracleUpdater?: string | null; assetToFundingMultiplier?: [string, string][] }

export interface MarketDataServiceLike { readonly network:Network; getSnapshot():BoardSnapshot; subscribe(listener:()=>void):()=>void; refresh():Promise<void>; getMarket(coin:string,options?:MarketOptions):MarketSession; setBookAggregation(coin:string,config:Pick<MarketOptions,'nSigFigs'|'mantissa'>):void; dispose():void }
