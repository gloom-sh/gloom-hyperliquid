import type { Quote } from "gloomberb/types/financials";
import type { DataProvider } from "gloomberb/types/data-provider";

export interface CashReference {
  symbol: string;
  price: number;
  asOf: number;
  label: "Last cash close" | "Last cash price";
  premium: number;
  currency: "USD";
  sessionDate?: string;
  stale: boolean;
}

/** A dated USD cash observation, never a currency conversion or proxy price. */
export function projectCashReference(
  quote: Quote,
  mark: number,
  symbol: string,
): CashReference | null {
  if (
    quote.symbol.toUpperCase() !== symbol.toUpperCase() ||
    quote.currency !== "USD" ||
    quote.priceBasis === "percent-of-par" ||
    !(quote.lastUpdated > 0) ||
    !Number.isFinite(mark) ||
    mark <= 0
  )
    return null;
  const hasDatedClose =
    quote.marketState !== "REGULAR" &&
    Boolean(quote.regularCloseSessionDate?.match(/^\d{4}-\d{2}-\d{2}$/)) &&
    Number.isFinite(quote.regularClose) &&
    quote.regularClose! > 0;
  const price = hasDatedClose ? quote.regularClose! : quote.price;
  if (!Number.isFinite(price) || price <= 0) return null;
  return {
    symbol,
    price,
    asOf: quote.lastUpdated,
    label: hasDatedClose ? "Last cash close" : "Last cash price",
    premium: mark / price - 1,
    currency: "USD",
    ...(hasDatedClose ? { sessionDate: quote.regularCloseSessionDate } : {}),
    stale: quote.stale === true,
  };
}

export async function loadCashReference(
  provider: Pick<DataProvider, "getQuote">,
  symbol: string,
  mark: number,
  signal?: AbortSignal,
): Promise<CashReference | null> {
  signal?.throwIfAborted();
  const quote = await provider.getQuote(symbol);
  signal?.throwIfAborted();
  return projectCashReference(quote, mark, symbol);
}
