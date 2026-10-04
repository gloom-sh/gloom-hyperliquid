import type { IRequestTransport } from '@nktkas/hyperliquid';
import type { Network } from '../trading/types';

/** Signed requests get exactly one HTTP attempt. Callers reconcile uncertain outcomes. */
export function singleAttemptExchangeTransport(network:Network):IRequestTransport {
  return {isTestnet:network==='testnet',async request<T>(endpoint:'info'|'exchange',payload:unknown,signal?:AbortSignal):Promise<T>{
    if(endpoint!=='exchange')throw new Error('Unexpected signed transport endpoint.');
    const response=await fetch((network==='testnet'?'https://api.hyperliquid-testnet.xyz':'https://api.hyperliquid.xyz')+'/exchange',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12_000)]):AbortSignal.timeout(12_000),
    });
    if(!response.ok)throw new Error(`Exchange HTTP ${response.status}. Check the account before submitting another request.`);
    return response.json() as Promise<T>;
  }};
}
