import type { ClearinghouseStateResponse, SpotClearinghouseStateResponse } from '@nktkas/hyperliquid/api/info';
import type { AccountSnapshot, Address, DexBalance, Network, SharedTransport, TradingMarket } from './types';

const number=(value: unknown)=>Number.isFinite(Number(value))?Number(value):0;
export function normalizeBalances(states: Map<string,ClearinghouseStateResponse>, spot: SpotClearinghouseStateResponse, abstraction: AccountSnapshot['abstraction'], collateralByDex:Map<string,string>=new Map()) {
  const balances: DexBalance[]=[...states].map(([dex,s])=>({dex,collateral:collateralByDex.get(dex)??'USDC',accountValue:number(s.marginSummary.accountValue),withdrawable:Math.max(0,number(s.withdrawable)),available:Math.max(0,number(s.marginSummary.accountValue)-number(s.marginSummary.totalMarginUsed)),marginUsed:number(s.marginSummary.totalMarginUsed),maintenanceMargin:number(s.crossMaintenanceMarginUsed),crossAccountValue:number(s.crossMarginSummary.accountValue),crossMarginUsed:number(s.crossMarginSummary.totalMarginUsed)}));
  const positions=[...states].flatMap(([dex,s])=>s.assetPositions.filter(p=>number(p.position.szi)!==0).map(p=>({...p.position,dex})));
  const sum=(field: keyof Omit<DexBalance,'dex'|'collateral'|'withdrawable'>)=>balances.filter(b=>b.collateral==='USDC').reduce((v,b)=>v+b[field],0);
  const unified=abstraction==='unifiedAccount'||abstraction==='portfolioMargin';
  const usd=spot.balances.find(b=>b.coin==='USDC');
  const available=unified ? Math.max(0,number(usd?.total)-number(usd?.hold)) : sum('available');
  const crossAccountValue=sum('crossAccountValue'),maintenanceMargin=sum('maintenanceMargin');
  const ratios=[...new Set(balances.map(b=>b.collateral??'USDC'))].map(token=>{const group=balances.filter(b=>b.collateral===token);const isolated=positions.filter(p=>(collateralByDex.get(p.dex)??'USDC')===token&&p.leverage.type==='isolated').reduce((n,p)=>n+number(p.marginUsed),0);const total=number(spot.balances.find(b=>b.coin===token)?.total)-isolated;return total>0?group.reduce((n,b)=>n+b.maintenanceMargin,0)/total:0;});
  return { balances,positions,accountValue:unified?number(usd?.total):sum('accountValue'),available,withdrawable:unified?available:(balances.find(b=>b.dex==='')?.withdrawable??0),marginUsed:sum('marginUsed'),maintenanceMargin,crossMarginRatio:abstraction==='portfolioMargin'?number(spot.portfolioMarginRatio):unified?Math.max(0,...ratios):balances.some(b=>b.crossAccountValue>0)?Math.max(...balances.filter(b=>b.crossAccountValue>0).map(b=>b.maintenanceMargin/b.crossAccountValue)):null,unrealizedPnl:positions.filter(p=>(collateralByDex.get(p.dex)??'USDC')==='USDC').reduce((n,p)=>n+number(p.unrealizedPnl),0) };
}
export function availableForMarket(snapshot: AccountSnapshot, market: TradingMarket): number {
  if (snapshot.abstraction==='portfolioMargin') return 0; // Risk-weighted collateral requires venue portfolio-margin solver.
  if (snapshot.abstraction==='unifiedAccount') {
    const balance=snapshot.spot.balances.find(b=>b.coin===(market.collateral??'USDC'));
    return Math.max(0,number(balance?.total)-number(balance?.hold));
  }
  return snapshot.balances.find(b=>b.dex===market.dex)?.available??0;
}
export class AccountStore {
  private address?: Address; private snapshot?: AccountSnapshot; private states=new Map<string,ClearinghouseStateResponse>();
  private unsubs:(()=>void)[]=[]; private interval?: ReturnType<typeof setInterval>; private refreshTimer?: ReturnType<typeof setTimeout>;
  private listeners=new Set<()=>void>(); private inflight?:Promise<AccountSnapshot>; private lastRefresh=0; private generation=0;private collateralByDex=new Map<string,string>();private subscribedDexes=new Set<string>();private ordersByDex=new Map<string,AccountSnapshot['orders']>();private twapsByDex=new Map<string,unknown[]>();private emitTimer?:ReturnType<typeof setTimeout>;private health?:ReturnType<typeof setInterval>;
  constructor(private network: Network, private shared: SharedTransport) {}
  subscribe(listener:()=>void) { this.listeners.add(listener);return()=>this.listeners.delete(listener); }
  getSnapshot() {if(this.snapshot){const connection=this.shared.ws.getStatus?.();const stale=Boolean(this.snapshot.error)||(connection!==undefined&&connection!=='live')||Date.now()-this.snapshot.updatedAt>150_000;if(stale!==this.snapshot.stale)this.snapshot={...this.snapshot,stale};}return this.snapshot;}
  private emit() {if(this.snapshot)this.snapshot={...this.snapshot};if(!this.emitTimer)this.emitTimer=setTimeout(()=>{this.emitTimer=undefined;for(const listener of this.listeners)listener();},200);}
  async setAddress(address:Address) {
    if(this.address?.toLowerCase()===address.toLowerCase()) return this.inflight??this.getSnapshot()??this.refresh();
    this.stop();this.address=address;this.states.clear();this.snapshot=undefined;const generation=++this.generation;
    const schedule=()=>{ if(!this.refreshTimer)this.refreshTimer=setTimeout(()=>{this.refreshTimer=undefined;void this.refresh().catch(()=>{});},Math.max(250,120_000-(Date.now()-this.lastRefresh))); };
    const subscribe=(type:string,handler:(data:any)=>void)=>this.unsubs.push(this.shared.ws.subscribe({type,user:address},data=>{if(generation===this.generation)handler(data);},()=>{void this.refresh().catch(()=>{});}));
    subscribe('allDexsClearinghouseState',data=>{ if(!Array.isArray(data.clearinghouseStates))return; for(const [dex,state] of data.clearinghouseStates) {if(!this.states.has(dex)||number(state.time)>=number(this.states.get(dex)?.time))this.states.set(dex,state);}this.rebuild(); });
    subscribe('webData3',data=>{if(this.snapshot&&data.userState?.abstraction){this.snapshot.abstraction=data.userState.abstraction;this.rebuild();}});
    subscribe('orderUpdates',schedule);
    subscribe('userHistoricalOrders',data=>{if(this.snapshot&&Array.isArray(data.orderHistory)){this.snapshot.orderHistory=[...new Map([...data.orderHistory,...this.snapshot.orderHistory].map(o=>[o.order.oid,o])).values()].slice(0,2000);this.emit();}});
    subscribe('spotState',data=>{if(this.snapshot&&data.spotState){this.snapshot.spot=data.spotState;this.rebuild();}});
    subscribe('userFundings',data=>{if(this.snapshot&&Array.isArray(data.fundings)){this.snapshot.funding=[...new Map([...data.fundings,...this.snapshot.funding].map(f=>[`${f.hash}:${f.delta.coin}:${f.time}`,f])).values()].slice(0,2000);this.emit();}});
    subscribe('userNonFundingLedgerUpdates',data=>{if(this.snapshot&&Array.isArray(data.nonFundingLedgerUpdates)){this.snapshot.ledger=[...new Map([...data.nonFundingLedgerUpdates,...this.snapshot.ledger].map(f=>[f.hash,f])).values()].slice(0,2000);this.emit();}});
    subscribe('userFills',data=>{if(this.snapshot&&Array.isArray(data.fills)){const fills=[...data.fills,...this.snapshot.fills];this.snapshot.fills=[...new Map(fills.map(f=>[`${f.tid}:${f.hash}`,f])).values()].slice(0,2000);this.emit();}schedule();});
    subscribe('userEvents',schedule);
    subscribe('notification',data=>{if(this.snapshot){this.snapshot.notifications=[String(data.notification??data).slice(0,500),...this.snapshot.notifications].slice(0,20);this.emit();}});
    this.health=setInterval(()=>{const previous=this.snapshot;if(this.getSnapshot()!==previous)this.emit();},5000);
    this.interval=setInterval(()=>void this.refresh().catch(()=>{}),120_000);
    return this.refresh();
  }
  private rebuild() { if(!this.snapshot)return;Object.assign(this.snapshot,normalizeBalances(this.states,this.snapshot.spot,this.snapshot.abstraction,this.collateralByDex),{updatedAt:Date.now()});this.emit(); }
  async refresh():Promise<AccountSnapshot> {
    if(this.inflight)return this.inflight;
    const address=this.address,generation=this.generation;if(!address)throw new Error('Connect a wallet or add a watch-only address.');
    this.lastRefresh=Date.now();
    this.inflight=(async()=>{
      const request=<T>(type:string,extra:Record<string,unknown>={})=>this.shared.info.request<T>({type,user:address,...extra});
      try {
        if(this.shared.refresh&&!this.shared.getSnapshot?.().dexes.length)await this.shared.refresh();
        if(generation!==this.generation)throw new Error('Account changed.');
        const board=this.shared.getSnapshot?.();
        const dexes=board?.dexes;
        const names=dexes?.length?dexes.map(d=>d.name):[''];
        this.collateralByDex=new Map(dexes?.map(d=>[d.name,d.collateral])??[['','USDC']]);
        for(const dex of names)if(!this.subscribedDexes.has(dex)){this.subscribedDexes.add(dex);this.unsubs.push(this.shared.ws.subscribe({type:'openOrders',user:address,dex},data=>{if(generation===this.generation&&Array.isArray(data.orders)){this.ordersByDex.set(dex,data.orders);if(this.snapshot){this.snapshot.orders=[...this.ordersByDex.values()].flat();this.emit();}}}));this.unsubs.push(this.shared.ws.subscribe({type:'twapStates',user:address,dex},data=>{if(generation===this.generation&&Array.isArray(data.states)){this.twapsByDex.set(dex,data.states.map(([twapId,state]:any)=>({twapId,state,dex})));if(this.snapshot){this.snapshot.twaps=[...this.twapsByDex.values()].flat();this.emit();}}}));}
        const [stateResults,orderResults,spot,abstraction,fills,orderHistory,funding,ledger,fees]=await Promise.all([
          Promise.all((names.length<30?names:names.filter(dex=>dex===''||this.states.get(dex)?.assetPositions.length)).map(async dex=>[dex,await request<ClearinghouseStateResponse>('clearinghouseState',{dex})] as const)),
          request<AccountSnapshot['orders']>('frontendOpenOrders').then(orders=>[orders]),
          request<AccountSnapshot['spot']>('spotClearinghouseState'),request<AccountSnapshot['abstraction']>('userAbstraction'),
          request<AccountSnapshot['fills']>('userFills'),request<AccountSnapshot['orderHistory']>('historicalOrders'),
          request<AccountSnapshot['funding']>('userFunding',{startTime:Date.now()-30*86_400_000}),
          request<AccountSnapshot['ledger']>('userNonFundingLedgerUpdates',{startTime:Date.now()-30*86_400_000}),
          request<AccountSnapshot['fees']>('userFees'),
        ]);
        if(generation!==this.generation)throw new Error('Account changed.');
        for(const [dex,state] of stateResults)if(!this.states.has(dex)||number(state.time)>=number(this.states.get(dex)?.time))this.states.set(dex,state);
        this.snapshot={address,network:this.network,updatedAt:Date.now(),stale:false,abstraction,...normalizeBalances(this.states,spot,abstraction,this.collateralByDex),orders:[...new Map([...orderResults.flat(),...[...this.ordersByDex.values()].flat()].map(o=>[o.oid,o])).values()],fills,orderHistory,funding,ledger,spot,fees,twaps:[...this.twapsByDex.values()].flat(),notifications:this.snapshot?.notifications??[]};this.emit();return this.snapshot;
      } catch(error) { if(generation===this.generation&&this.snapshot){this.snapshot.error=error instanceof Error?error.message:'Account refresh failed.';this.snapshot.stale=true;this.emit();}throw error; }
      finally{if(generation===this.generation)this.inflight=undefined;}
    })();return this.inflight;
  }
  async refreshRisk(dex:string):Promise<AccountSnapshot>{
    const user=this.address,generation=this.generation;if(!user)throw new Error('No account selected.');if(!this.snapshot)await this.refresh();
    const [spot,state,abstraction]=await Promise.all([this.shared.info.request<AccountSnapshot['spot']>({type:'spotClearinghouseState',user}),this.shared.info.request<ClearinghouseStateResponse>({type:'clearinghouseState',user,dex}),this.shared.info.request<AccountSnapshot['abstraction']>({type:'userAbstraction',user})]);
    if(generation!==this.generation||!this.snapshot)throw new Error('Account changed while checking collateral.');
    this.states.set(dex,state);this.snapshot={...this.snapshot,spot,abstraction,...normalizeBalances(this.states,spot,abstraction,this.collateralByDex),updatedAt:Date.now(),stale:false,error:undefined};this.emit();return this.snapshot;
  }
  async history(kind:'funding'|'ledger'|'fills',startTime:number,endTime?:number) {
    if(!this.address)throw new Error('No account selected.');
    const types={funding:'userFunding',ledger:'userNonFundingLedgerUpdates',fills:'userFillsByTime'};
    return this.shared.info.request({type:types[kind],user:this.address,startTime,...(endTime?{endTime}:{})});
  }
  stop() {if(this.health)clearInterval(this.health);this.health=undefined;if(this.emitTimer)clearTimeout(this.emitTimer);this.emitTimer=undefined;this.generation++;for(const unsub of this.unsubs)unsub();this.unsubs=[];if(this.interval)clearInterval(this.interval);if(this.refreshTimer)clearTimeout(this.refreshTimer);this.interval=undefined;this.refreshTimer=undefined;this.address=undefined;this.subscribedDexes.clear();this.ordersByDex.clear();this.twapsByDex.clear();this.snapshot=undefined;this.inflight=undefined;}
}
