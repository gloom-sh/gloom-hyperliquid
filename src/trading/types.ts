import type {
  ClearinghouseStateResponse,
  FrontendOpenOrdersResponse,
  HistoricalOrdersResponse,
  UserFillsResponse,
  UserFundingResponse,
  UserNonFundingLedgerUpdatesResponse,
  SpotClearinghouseStateResponse,
  UserFeesResponse,
} from "@nktkas/hyperliquid/api/info";
import type {
  OrderParameters,
  TwapOrderParameters,
} from "@nktkas/hyperliquid/api/exchange";

export type Network = "mainnet" | "testnet";
export type Address = `0x${string}`;
export type AccountMode = "disconnected" | "watch" | "pending" | "trading";
export interface TradingStatus {
  network: Network;
  mode: AccountMode;
  address?: Address;
  agentAddress?: Address;
  expiresAt?: number;
  agentName?: string;
  storage?: "keychain" | "file";
  riskAcknowledged: boolean;
  eligibleAcknowledged: boolean;
  region?: RegionStatus;
  error?: string;
}
export interface RegionStatus {
  allowed: boolean;
  country?: string;
  checkedAt: number;
  reason?: string;
}
export interface TradingMarket {
  coin: string;
  assetId: number;
  dex: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  marginMode?: string | null;
  mark: number;
  collateral?: string;
  feeMultiplier?: number;
  deployerFeeScale?: number;
  growthMode?: boolean;
  alignedCollateral?: boolean;
  marginTiers?: { lowerBound: number; maxLeverage: number }[];
}
export interface TicketRequest {
  accountAddress?: Address;
  market: TradingMarket;
  side: "buy" | "sell";
  kind:
    | "market"
    | "limit"
    | "stop-market"
    | "stop-limit"
    | "take-profit-market"
    | "take-profit-limit"
    | "twap"
    | "scale";
  size: number | string;
  sizeUnit: "coin" | "usd" | "percent";
  leverage: number;
  marginMode: "cross" | "isolated";
  limitPrice?: number;
  triggerPrice?: number;
  tif?: "Gtc" | "Alo" | "Ioc";
  reduceOnly?: boolean;
  takeProfit?: number;
  stopLoss?: number;
  positionTpsl?: boolean;
  twapMinutes?: number;
  twapRandomize?: boolean;
  scaleStart?: number;
  scaleEnd?: number;
  scaleCount?: number;
  /** Stable per user intent. Reuse to reconcile; never regenerate after a timeout. */
  clientId: string;
}
export interface TradingSettings {
  slippagePercent: number;
  confirmations: boolean;
  maxOrderNotional: number;
  maxPriceDistancePercent: number;
  builder?: { address: Address; feeTenthsBps: number };
}
export const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  slippagePercent: 1,
  confirmations: true,
  maxOrderNotional: 100_000,
  maxPriceDistancePercent: 10,
};
export interface BookLevel {
  px: string;
  sz: string;
}
export interface TicketContext {
  available: number;
  makerRate: number;
  takerRate: number;
  referralDiscount?: number;
  positionSize?: number;
  accountValue?: number;
  book?: [BookLevel[], BookLevel[]];
  /** Cross liquidation needs the whole account; no single-position estimate is presented. */
  crossMaintenanceMargin?: number;
}
export interface TicketPreview {
  size: string;
  price: string;
  notional: number;
  marginRequired: number;
  fee: number;
  builderFee: number;
  liquidationPrice: number | null;
  averageFill: number | null;
  slippagePercent: number | null;
  unfilledSize: number;
  errors: string[];
  warnings: string[];
  order?: OrderParameters;
  twap?: TwapOrderParameters;
}
export interface TradingResult {
  clientId: string;
  state: "accepted" | "rejected" | "unknown";
  message: string;
  response?: unknown;
  cloids?: string[];
  at: number;
}
export type Position =
  ClearinghouseStateResponse["assetPositions"][number]["position"] & {
    dex: string;
  };
export interface DexBalance {
  dex: string;
  collateral?: string;
  accountValue: number;
  withdrawable?: number;
  available: number;
  marginUsed: number;
  maintenanceMargin: number;
  crossAccountValue: number;
  crossMarginUsed: number;
}
export interface AccountSnapshot {
  address: Address;
  network: Network;
  updatedAt: number;
  error?: string;
  stale: boolean;
  abstraction: "unifiedAccount" | "portfolioMargin" | "disabled" | "default";
  accountValue: number;
  available: number;
  withdrawable: number;
  marginUsed: number;
  maintenanceMargin: number;
  crossMarginRatio: number | null;
  unrealizedPnl: number;
  balances: DexBalance[];
  positions: Position[];
  orders: FrontendOpenOrdersResponse;
  fills: UserFillsResponse;
  orderHistory: HistoricalOrdersResponse;
  funding: UserFundingResponse;
  ledger: UserNonFundingLedgerUpdatesResponse;
  spot: SpotClearinghouseStateResponse;
  fees: UserFeesResponse | null;
  twaps: unknown[];
  notifications: string[];
}
export interface WalletSession {
  url: string;
  expiresAt: number;
  agentAddress?: Address;
}
export interface SharedTransport {
  getSnapshot?(): import("../market/types").BoardSnapshot;
  refresh?(): Promise<void>;
  subscribe?(listener: () => void): () => void;
  info: {
    request<T>(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal; weight?: number },
    ): Promise<T>;
  };
  ws: {
    getStatus?(): string;
    subscribe(
      subscription: Record<string, unknown>,
      handler: (data: any) => void,
      onReconnect?: () => void,
    ): () => void;
  };
}
export type TradingOperation =
  | "status"
  | "watch"
  | "connect"
  | "import"
  | "disconnect"
  | "account"
  | "preview"
  | "submit"
  | "cancel"
  | "modify"
  | "leverage"
  | "margin"
  | "wallet"
  | "connectionStatus"
  | "acknowledge"
  | "region"
  | "close"
  | "reverse"
  | "closeAll"
  | "twapCancel"
  | "twapResume"
  | "history";
