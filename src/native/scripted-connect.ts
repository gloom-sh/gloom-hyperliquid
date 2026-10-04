import { createTradingService, type TradingServiceOptions } from "./service";
import type { TradingStatus } from "../trading/types";

/** Native-only script entry. Read key from owner-only file/stdin, never CLI arguments or config. */
export async function connectWithMainWallet(
  options: TradingServiceOptions,
  privateKey: `0x${string}`,
  acknowledgements: { risk: true; eligible: true },
): Promise<TradingStatus> {
  const service = createTradingService(options);
  try {
    await service.invoke("acknowledge", acknowledgements);
    return await service.connectMainWallet(privateKey);
  } finally {
    await service.dispose();
  }
}
