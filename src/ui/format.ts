import { colors } from "gloomberb/theme";

export const missing = "--";
const finite = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value);
export const number = (value: number | null | undefined, decimals = 2) =>
  !finite(value)
    ? missing
    : value.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
/** A signed amount, so gains and losses line up in a right-aligned column. */
export const signed = (value: number | null | undefined, decimals = 2) => {
  if (!finite(value)) return missing;
  const rounded = Number(value.toFixed(decimals));
  return `${rounded > 0 ? "+" : ""}${number(rounded === 0 ? 0 : rounded, decimals)}`;
};
/** Table and figure abbreviation with fixed decimals: 3.14B, 90.90M, 12.40K. */
export const compact = (value: number | null | undefined, decimals = 2) =>
  !finite(value)
    ? missing
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        minimumFractionDigits: Math.abs(value) >= 1000 ? decimals : 0,
        maximumFractionDigits: Math.abs(value) >= 1000 ? decimals : 0,
      }).format(value);
/** Axis ticks keep only the decimals they need: 2K, 2.5K. */
export const compactAxis = (value: number | null | undefined) =>
  !finite(value)
    ? missing
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
export const usdCompact = (value: number | null | undefined) =>
  !finite(value)
    ? missing
    : `${value < 0 ? "-" : ""}$${compact(Math.abs(value))}`;
export const usd = (value: number | null | undefined) =>
  !finite(value) ? missing : `${value < 0 ? "-" : ""}$${number(Math.abs(value))}`;
/** Rounds to the shown precision first, so -0.00001 reads 0.00% and not -0.00%. */
const shown = (value: number, decimals: number) => {
  const rounded = Number(value.toFixed(decimals));
  return rounded === 0 ? 0 : rounded;
};
export const percent = (
  value: number | null | undefined,
  decimals = 2,
  signed = true,
) => {
  if (!finite(value)) return missing;
  const scaled = shown(value * 100, decimals);
  return `${signed && scaled > 0 ? "+" : ""}${number(scaled, decimals)}%`;
};
/** Hourly and 8h funding rates read in four decimals everywhere. */
export const fundingRate = (value: number | null | undefined) =>
  percent(value, 4);
export const fundingTone = (value: number | null | undefined) =>
  tone(value, 4);
/** Tone of an amount shown with `decimals`, so +0.00 is never green. */
export const amountTone = (value: number | null | undefined, decimals = 2) =>
  tone(finite(value) ? Number(value.toFixed(decimals)) : value);
/** Up/down colour; with `percentDecimals`, a value that prints as zero stays dim. */
export const tone = (
  value: number | null | undefined,
  percentDecimals?: number,
) => {
  const v =
    value != null && percentDecimals != null
      ? shown(value * 100, percentDecimals)
      : value;
  return v == null || v === 0
    ? colors.textDim
    : v > 0
      ? colors.positive
      : colors.negative;
};
/** Hyperliquid quotes five significant figures, at most `6 - szDecimals` decimals. */
export const priceDecimals = (
  reference: number | null | undefined,
  szDecimals = 0,
) =>
  !finite(reference)
    ? Math.max(0, 6 - szDecimals)
    : Math.max(
        0,
        Math.min(
          6 - szDecimals,
          4 - Math.floor(Math.log10(Math.abs(reference) || 1)),
        ),
      );
export const price = (value: number | null | undefined, szDecimals = 0) =>
  !finite(value) ? missing : number(value, priceDecimals(value, szDecimals));
/** A price difference (spread, distance) in the decimals of the price it belongs to. */
export const tick = (
  value: number | null | undefined,
  reference: number | null | undefined,
  szDecimals = 0,
) =>
  !finite(value) || !finite(reference)
    ? missing
    : number(value, priceDecimals(reference, szDecimals));
/** A contract size in the market's lot decimals. */
export const size = (value: number | null | undefined, szDecimals?: number) =>
  number(
    value,
    szDecimals ?? (finite(value) && Number.isInteger(value) ? 0 : 4),
  );
export const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  // mm:ss at a fixed width so the figure beside it never shifts.
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
export const time = (value: number | null | undefined) =>
  value ? new Date(value).toISOString().slice(11, 19) : missing;
export const dateTime = (value: number | null | undefined) =>
  value
    ? new Date(value).toISOString().replace("T", " ").slice(0, 19)
    : missing;
export const shortAddress = (value?: string) =>
  value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Disconnected";
const PRECISION_VALUES = ["raw", "5:1", "5:2", "5:5", "4", "3", "2"];
const describePrecision = (value: string) =>
  value === "raw"
    ? "Full precision"
    : value.startsWith("5:")
      ? `5 digits, step ${value.slice(2)}`
      : `${value} significant digits`;
/**
 * Grouping choices named by the price step they produce at the current price,
 * the way traders read a book (1, 2, 5, 10, 100). Before a price exists the
 * choices keep their descriptive names.
 */
export function bookTickOptions(
  reference: number | null | undefined,
  szDecimals: number | undefined,
  current: string,
) {
  if (reference == null || !(reference > 0) || szDecimals == null)
    return PRECISION_VALUES.map((value) => ({
      value,
      label: describePrecision(value),
    }));
  const rawDecimals = priceDecimals(reference, szDecimals);
  const magnitude = Math.floor(Math.log10(reference)) + 1;
  const seen = new Set<string>();
  return PRECISION_VALUES.flatMap((value) => {
    const [digits, step] = value.split(":");
    const decimals =
      value === "raw"
        ? rawDecimals
        : Math.min(rawDecimals, Math.max(0, Number(digits) - magnitude));
    const tick =
      value === "raw"
        ? 10 ** -rawDecimals
        : Math.max(
            10 ** -rawDecimals,
            10 ** (magnitude - Number(digits)) * Number(step ?? 1),
          );
    const label = number(tick, decimals);
    if (seen.has(label) && value !== current) return [];
    seen.add(label);
    return [{ value, label }];
  });
}
