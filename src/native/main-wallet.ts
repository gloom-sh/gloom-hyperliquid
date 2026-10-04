import { ExchangeClient, type IRequestTransport } from "@nktkas/hyperliquid";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import {
  configuredBuilder,
  GLOOM_BUILDER_MAX_FEE_RATE,
} from "../trading/builder";
import type { Address, Network } from "../trading/types";
import { singleAttemptExchangeTransport } from "./exchange-transport";

/** Main-wallet approval only. The caller owns key input; this function never stores it. */
export async function approveApiWallet(options: {
  network: Network;
  wallet: AbstractWallet;
  agentAddress: Address;
  agentName: string;
  nonceManager: () => Promise<number>;
  transport?: IRequestTransport;
}): Promise<void> {
  const transport =
    options.transport ?? singleAttemptExchangeTransport(options.network);
  if (transport.isTestnet !== (options.network === "testnet"))
    throw new Error("Signing network and transport do not match.");
  const exchange = new ExchangeClient({
    transport,
    wallet: options.wallet,
    nonceManager: options.nonceManager,
    signatureChainId: "0x66eee",
  });
  await exchange.approveAgent({
    agentAddress: options.agentAddress,
    agentName: options.agentName,
  });
  const builder = configuredBuilder(options.network);
  if (builder)
    await exchange.approveBuilderFee({
      builder: builder.address,
      maxFeeRate: GLOOM_BUILDER_MAX_FEE_RATE,
    });
}
