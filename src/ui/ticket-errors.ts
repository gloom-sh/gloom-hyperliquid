// Preview errors come from the order builder as sentences. The ticket shows
// each one where it belongs and gives the action button a few words for it.

import type { TicketRequest } from "../trading/types";

export type FieldId =
  | "trigger"
  | "limit"
  | "twap"
  | "scaleStart"
  | "scaleEnd"
  | "scaleCount"
  | "size"
  | "tp"
  | "sl";
export type Place = FieldId | "margin" | "reduceOnly" | null;

/**
 * Where a preview error belongs and the few words the action button says for
 * it. `quiet` errors only describe what is still empty, so they never show
 * under a field.
 */
const ERROR_PLACES: [RegExp, Place, string, boolean?][] = [
  [/^Enter a positive size/, "size", "Enter a size", true],
  [/^Enter a positive limit price/, "limit", "Enter a limit price", true],
  [/^Enter a positive trigger price/, "trigger", "Enter a trigger price", true],
  [/^A current market price/, null, "No live price", true],
  [/^Minimum order value/, "size", "Below $10 minimum"],
  [/^Each scale order must be/, "size", "Below $10 per order"],
  [/^A local TWAP needs/, "size", "Below $24 TWAP minimum"],
  [/^Insufficient/, "size", "Not enough margin"],
  [/^Buying power percentage/, "size", "Above 100%"],
  [/^Reduce-only size exceeds/, "size", "Larger than the position"],
  [/^Reduce-only side must/, "reduceOnly", "Nothing to reduce"],
  [/^Leverage must be/, "margin", "Check leverage"],
  [/^This market only supports isolated/, "margin", "Isolated only"],
  [/^This position size allows at most/, "margin", "Lower the leverage"],
  [/^Trigger price is on the wrong side/, "trigger", "Trigger on wrong side"],
  [/^Take-profit price/, "tp", "Check take profit"],
  [/^Stop-loss price/, "sl", "Check stop loss"],
  [/^TP\/SL prices must be positive/, "tp", "Check TP/SL"],
  [/^Attach TP\/SL|^Set position TP\/SL/, "tp", "Remove TP/SL"],
  [/^TWAP duration/, "twap", "Check duration"],
  [/^Scale requires/, "scaleStart", "Check scale prices"],
];
export function placeError(
  error: string,
  kind?: TicketRequest["kind"],
): { place: Place; short: string; quiet: boolean } {
  // A scale order's first price stands in for the limit price.
  if (kind === "scale" && /^Enter a positive limit price/.test(error))
    return { place: "scaleStart", short: "Enter scale prices", quiet: true };
  const match = ERROR_PLACES.find(([pattern]) => pattern.test(error));
  return match
    ? { place: match[1], short: match[2], quiet: match[3] ?? false }
    : { place: null, short: "Cannot place order", quiet: false };
}
