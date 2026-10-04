import { getAddress, isAddress, zeroAddress } from "viem";
import type { Network, TradingSettings } from "./types";

/** Official Gloom builder address supplied by Vince. Testnet always disables builder fees. */
export const GLOOM_BUILDER_ADDRESS =
  "0x84085f25eDDdFc86D8b66343f97D68e4D5Bd1096";
export const GLOOM_BUILDER_FEE_TENTHS_BPS = 100;
export const GLOOM_BUILDER_MAX_FEE_RATE = "0.1%";
export function configuredBuilder(
  network: Network,
  address: string = GLOOM_BUILDER_ADDRESS,
): TradingSettings["builder"] {
  if (
    network !== "mainnet" ||
    !isAddress(address) ||
    address.toLowerCase() === zeroAddress
  )
    return undefined;
  return {
    address: getAddress(address),
    feeTenthsBps: GLOOM_BUILDER_FEE_TENTHS_BPS,
  };
}
