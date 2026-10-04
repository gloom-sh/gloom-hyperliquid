import { expect,test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore } from './storage';
import { startWalletPage } from './wallet-page';

test('monotonic nonce persists across service restarts and networks, credentials directory stays private',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'hyperliquid-storage-'));
  try {
    const a=new KeyStore(folder,'testnet'),b=new KeyStore(folder,'testnet');
    const nonces=await Promise.all([a.nextNonce(),b.nextNonce(),a.nextNonce()]);
    expect(new Set(nonces).size).toBe(3);expect(await b.nextNonce()).toBeGreaterThan(Math.max(...nonces));
    expect((await stat(a.directory)).mode&0o777).toBe(0o700);expect((await stat(join(a.directory,'nonce.json'))).mode&0o777).toBe(0o600);
    const main=new KeyStore(folder,'mainnet');expect(main.directory).not.toBe(a.directory);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('loopback wallet approval serves only unguessable token, rejects foreign origins, binds configured port, contains no key material',async()=>{
  const page=startWalletPage({network:'testnet',approvalPort:0,checkRegion:async()=>({allowed:true})});
  try {
    const response=await fetch(page.url);expect(response.status).toBe(200);expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(response.headers.get('cache-control')).toBe('no-store');
    const html=await response.text();expect(html).toContain('TESTNET');expect(html).not.toContain('privateKey');expect(html).not.toContain('maxFeeRate:\"0.1%\",builder:');
    const url=new URL(page.url);expect(url.hostname).toBe('127.0.0.1');expect(url.pathname).toMatch(/^\/[0-9a-f]{64}\/$/);
    expect((await fetch(url.origin+'/')).status).toBe(404);
    expect((await fetch(page.url,{headers:{'sec-fetch-site':'cross-site'}})).status).toBe(403);
    expect((await fetch(page.url,{method:'POST'})).status).toBe(403);
  }finally{page.close();}
});

test('unknown intent is persisted and never resent after timeout or process restart',async()=>{
  const {createTradingService}=await import('./service');
  const folder=await mkdtemp(join(tmpdir(),'hyperliquid-intent-'));
  const shared={info:{request:async()=>({status:'unknownOid'}) as any},ws:{subscribe:()=>()=>{}}};
  let sends=0;const service=createTradingService({network:'testnet',dataDir:folder,shared});
  try {
    await service.invoke('status');
    const submit=()=>(service as any).once('persistent-intent',['0x12345678901234567890123456789012'],async()=>{sends++;throw new Error('Network timeout');});
    const [first,second]=await Promise.all([submit(),submit()]);expect(first.state).toBe('unknown');expect(second.state).toBe('unknown');expect(sends).toBe(1);
    await service.dispose();
    const restarted=createTradingService({network:'testnet',dataDir:folder,shared});
    try{await restarted.invoke('status');const retry=await (restarted as any).once('persistent-intent',[],async()=>{sends++;return {};});expect(retry.state).toBe('unknown');expect(sends).toBe(1);}finally{await restarted.dispose();}
  }finally{await service.dispose();await rm(folder,{recursive:true,force:true});}
});

test('service setup, status and disconnected account stream stay offline',async()=>{
  const {createTradingService}=await import('./service');const folder=await mkdtemp(join(tmpdir(),'hyperliquid-lifecycle-'));
  let subscribes=0,releases=0,requests=0;
  const service=createTradingService({network:'testnet',dataDir:folder,shared:{info:{request:async()=>{requests++;return {} as any;}},ws:{subscribe:()=>()=>{}},subscribe:()=>{subscribes++;return()=>{releases++;};}}});
  try {
    await service.invoke('status');expect(subscribes).toBe(0);expect(requests).toBe(0);
    const release=service.subscribe(()=>{});await Bun.sleep(1);expect(subscribes).toBe(0);release();expect(releases).toBe(0);
    await service.dispose();expect(releases).toBe(0);
  }finally{await service.dispose();await rm(folder,{recursive:true,force:true});}
});

test('scripted API-wallet approval signs with main wallet, skips testnet builder and never retries',async()=>{
  const {approveApiWallet}=await import('./main-wallet');const {generatePrivateKey,privateKeyToAccount}=await import('viem/accounts');
  const wallet=privateKeyToAccount(generatePrivateKey()),agent=privateKeyToAccount(generatePrivateKey());const sent:any[]=[];
  await approveApiWallet({network:'testnet',wallet,agentAddress:agent.address,agentName:'gloom test valid_until 1900000000000',nonceManager:async()=>1770000000000,transport:{isTestnet:true,request:async(_endpoint,payload)=>{sent.push(payload);return {status:'ok',response:{type:'default'}} as any;}}});
  expect(sent.length).toBe(1);expect(sent[0].action.type).toBe('approveAgent');expect(sent[0].action.hyperliquidChain).toBe('Testnet');expect(sent[0].action.agentAddress.toLowerCase()).toBe(agent.address.toLowerCase());
  let attempts=0;
  await expect(approveApiWallet({network:'testnet',wallet,agentAddress:agent.address,agentName:'gloom',nonceManager:async()=>1770000000001,transport:{isTestnet:true,request:async()=>{attempts++;throw new Error('timeout');}}})).rejects.toThrow('timeout');expect(attempts).toBe(1);
});

test('scripted builder approval uses exact official address and cap on an offline transport',async()=>{
  const {approveApiWallet}=await import('./main-wallet');const {GLOOM_BUILDER_ADDRESS}=await import('../trading/builder');const {generatePrivateKey,privateKeyToAccount}=await import('viem/accounts');
  const wallet=privateKeyToAccount(generatePrivateKey()),agent=privateKeyToAccount(generatePrivateKey()),sent:any[]=[];
  await approveApiWallet({network:'mainnet',wallet,agentAddress:agent.address,agentName:'gloom test',nonceManager:async()=>1770000000002,transport:{isTestnet:false,request:async(_endpoint,payload)=>{sent.push(payload);return {status:'ok',response:{type:'default'}} as any;}}});
  expect(sent.map(s=>s.action.type)).toEqual(['approveAgent','approveBuilderFee']);expect(sent[1].action.builder.toLowerCase()).toBe(GLOOM_BUILDER_ADDRESS.toLowerCase());expect(sent[1].action.maxFeeRate).toBe('0.1%');
});
