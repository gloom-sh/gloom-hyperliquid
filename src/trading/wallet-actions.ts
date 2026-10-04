import {
  ApproveAgentTypes,
  ApproveBuilderFeeTypes,
  Withdraw3Types,
  UsdClassTransferTypes,
  SendAssetTypes,
  UserSetAbstractionTypes,
} from "@nktkas/hyperliquid/api/exchange";
import type { Address, Network } from "./types";
export const WALLET_TYPES = {
  approveAgent: ApproveAgentTypes,
  approveBuilderFee: ApproveBuilderFeeTypes,
  withdraw3: Withdraw3Types,
  usdClassTransfer: UsdClassTransferTypes,
  sendAsset: SendAssetTypes,
  userSetAbstraction: UserSetAbstractionTypes,
};
export function userSignedTypedData(
  action: Record<string, unknown>,
  types: Record<string, readonly { name: string; type: string }[]>,
) {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: Number(action.signatureChainId),
      verifyingContract:
        "0x0000000000000000000000000000000000000000" as Address,
    },
    types,
    primaryType: Object.keys(types)[0]!,
    message: action,
  };
}
export function walletAction(
  type: keyof typeof WALLET_TYPES,
  fields: Record<string, unknown>,
  network: Network,
  nonce: number,
) {
  return {
    type,
    signatureChainId: "0x66eee" as const,
    hyperliquidChain: network === "testnet" ? "Testnet" : "Mainnet",
    ...fields,
    ...(type === "withdraw3" ? { time: nonce } : { nonce }),
  };
}
