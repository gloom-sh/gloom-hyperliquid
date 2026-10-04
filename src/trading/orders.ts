import Decimal from 'decimal.js';
import { keccak256, stringToHex } from 'viem';
import type { OrderParameters } from '@nktkas/hyperliquid/api/exchange';
import { perpFeeRates } from './fees';
import { estimateFill, finitePositive, isolatedLiquidation, roundPrice, roundSize } from './math';
import { DEFAULT_TRADING_SETTINGS, type TicketContext, type TicketPreview, type TicketRequest, type TradingSettings } from './types';

export function clientOrderId(intent: string, leg = 0): `0x${string}` {
  if (!intent || intent.length > 200) throw new Error('An order intent id is required.');
  return keccak256(stringToHex(`gloom-hyperliquid:${intent}:${leg}`)).slice(0,34) as `0x${string}`;
}
export function previewTicket(ticket: TicketRequest, context: TicketContext, settings: TradingSettings = DEFAULT_TRADING_SETTINGS): TicketPreview {
  const result: TicketPreview = { size:'0',price:'0',notional:0,marginRequired:0,fee:0,builderFee:0,liquidationPrice:null,averageFill:null,slippagePercent:null,unfilledSize:0,errors:[],warnings:[] };
  try {
    const m=ticket.market, buy=ticket.side==='buy', reduce=Boolean(ticket.reduceOnly || ticket.positionTpsl);
    if (!finitePositive(m.mark)) throw new Error('A current market price is required.');
    if (!Number.isInteger(m.assetId) || m.assetId < 0) throw new Error('Invalid market asset id.');
    if (!Number.isInteger(ticket.leverage) || ticket.leverage < 1 || ticket.leverage > m.maxLeverage) result.errors.push(`Leverage must be between 1 and ${m.maxLeverage}x.`);
    if (m.onlyIsolated && ticket.marginMode!=='isolated') result.errors.push('This market only supports isolated margin.');
    const input=Number(ticket.size);
    if (!finitePositive(input)) throw new Error('Enter a positive size.');
    if (ticket.sizeUnit==='percent' && input>100) result.errors.push('Buying power percentage must be at most 100.');
    const trigger=ticket.kind.startsWith('stop-') || ticket.kind.startsWith('take-profit-');
    const marketOrder=ticket.kind==='market' || ticket.kind.endsWith('-market');
    const reference=trigger ? ticket.triggerPrice : m.mark;
    if (trigger && !finitePositive(reference)) throw new Error('Enter a positive trigger price.');
    if (!finitePositive(settings.slippagePercent) || settings.slippagePercent > 20) throw new Error('Slippage must be greater than 0 and at most 20%.');
    const rawPrice=marketOrder ? reference!*(1+(buy?1:-1)*settings.slippagePercent/100) : ticket.kind==='scale' ? ticket.scaleStart : ticket.kind==='twap' ? m.mark : ticket.limitPrice;
    if (!finitePositive(rawPrice)) throw new Error('Enter a positive limit price.');
    result.price=roundPrice(rawPrice,m.szDecimals,buy?'down':'up');
    let sizingPrice=marketOrder ? Number(result.price) : rawPrice;
    if(ticket.kind==='scale'){const count=ticket.scaleCount??0;if(Number.isInteger(count)&&count>=2&&count<=50&&finitePositive(ticket.scaleStart)&&finitePositive(ticket.scaleEnd))sizingPrice=Array.from({length:count},(_,i)=>Number(roundPrice(ticket.scaleStart!+(ticket.scaleEnd!-ticket.scaleStart!)*i/(count-1),m.szDecimals,buy?'down':'up'))).reduce((a,b)=>a+b,0)/count;}
    if(trigger){const shouldAbove=ticket.kind.startsWith('stop-')?buy:!buy;if(shouldAbove?ticket.triggerPrice!<=m.mark:ticket.triggerPrice!>=m.mark)result.errors.push('Trigger price is on the wrong side of mark and would trigger immediately.');}
    const rates=perpFeeRates({maker:context.makerRate,taker:context.takerRate,referralDiscount:context.referralDiscount??0,deployerFeeScale:m.deployerFeeScale??(m.dex?1:0),growthMode:m.growthMode??false,alignedCollateral:m.alignedCollateral??false});
    const feeRate=ticket.tif==='Alo'&&!marketOrder?rates.maker:rates.taker;
    const builder=settings.builder && settings.builder.feeTenthsBps > 0 ? settings.builder : undefined;
    if (builder && (!/^0x[0-9a-fA-F]{40}$/.test(builder.address) || !Number.isInteger(builder.feeTenthsBps) || builder.feeTenthsBps>100)) throw new Error('Invalid builder fee configuration.');
    const builderRate=(builder?.feeTenthsBps ?? 0)/100_000;
    const budgetSize=context.available*(input/100)/(m.mark/ticket.leverage+sizingPrice*(Math.max(feeRate,0)+builderRate));
    let rawSize=ticket.sizeUnit==='coin' ? input : ticket.sizeUnit==='usd' ? input/sizingPrice : budgetSize;
    if (reduce && ticket.sizeUnit==='percent') rawSize=Math.abs(context.positionSize??0)*input/100;
    result.size=roundSize(rawSize,m.szDecimals);
    const size=Number(result.size), px=Number(result.price);
    result.notional=new Decimal(result.size).mul(ticket.kind==='twap'?m.mark:result.price).toNumber();
    result.builderFee=result.notional*builderRate; result.fee=result.notional*feeRate+result.builderFee;
    const resultingNotional=Math.abs((context.positionSize??0)+(buy?size:-size))*m.mark;
    const tier=[...(m.marginTiers??[])].sort((a,b)=>a.lowerBound-b.lowerBound).filter(t=>t.lowerBound<=resultingNotional).at(-1);
    if(!reduce&&tier&&ticket.leverage>tier.maxLeverage)result.errors.push(`This position size allows at most ${tier.maxLeverage}x leverage in its margin tier.`);
    const netIncrease=Math.max(0,Math.abs((context.positionSize??0)+(buy?size:-size))-Math.abs(context.positionSize??0));
    result.marginRequired=reduce ? 0 : new Decimal(netIncrease).mul(m.mark).div(ticket.leverage).toNumber();
    if (result.notional<10 && !reduce) result.errors.push('Minimum order value is $10.');
    if(ticket.positionTpsl&&Math.sign(context.positionSize??0)!==(buy?1:-1))result.errors.push('TP/SL side must match the position being protected.');
    if (reduce && !ticket.positionTpsl && (!(context.positionSize??0) || Math.sign(context.positionSize!)===(buy?1:-1))) result.errors.push('Reduce-only side must reduce an existing position.');
    if (reduce && size>Math.abs(context.positionSize??0)+1e-12) result.errors.push('Reduce-only size exceeds the position.');
    if (!reduce && result.marginRequired+Math.max(result.fee,0)>context.available+1e-8) result.errors.push('Insufficient available collateral for margin and estimated fees.');
    if (result.notional>settings.maxOrderNotional) result.warnings.push(`Order value exceeds the $${settings.maxOrderNotional.toLocaleString()} guard.`);
    if (!marketOrder && Math.abs(px/m.mark-1)*100>settings.maxPriceDistancePercent) result.warnings.push(`Price is more than ${settings.maxPriceDistancePercent}% from mark.`);
    if (ticket.marginMode==='isolated' && !context.positionSize && !reduce) result.liquidationPrice=isolatedLiquidation(px,size,result.marginRequired-Math.max(result.fee,0),buy,m);
    if (context.book && marketOrder && !trigger) {
      const fill=estimateFill(context.book[buy?1:0],size,px,buy);
      result.averageFill=fill.average; result.unfilledSize=fill.unfilled;
      if (fill.average) result.slippagePercent=(fill.average/m.mark-1)*(buy?1:-1)*100;
      if (fill.unfilled>1e-10) result.warnings.push('Visible book cannot fill the full size within the slippage cap.');
    }
    const orders: OrderParameters['orders']=[];
    const add=(price:string, quantity:string, side:boolean, ro:boolean, type:OrderParameters['orders'][number]['t'])=>orders.push({a:m.assetId,b:side,p:price,s:quantity,r:ro,t:type,c:clientOrderId(ticket.clientId,orders.length)});
    const attach=(value:number,kind:'tp'|'sl',side:boolean)=> {
      if (!finitePositive(value)) throw new Error('TP/SL prices must be positive.');
      const shouldAbove=kind==='tp' ? buy : !buy;
      if (shouldAbove ? value<=m.mark : value>=m.mark) result.errors.push(`${kind==='tp'?'Take-profit':'Stop-loss'} price is on the wrong side of mark.`);
      add(roundPrice(value*(1+(side?1:-1)*settings.slippagePercent/100),m.szDecimals,side?'down':'up'),ticket.positionTpsl?'0':result.size,side,true,{trigger:{triggerPx:roundPrice(value,m.szDecimals),isMarket:true,tpsl:kind}});
    };
    if (ticket.kind==='twap') {
      if (!Number.isInteger(ticket.twapMinutes) || ticket.twapMinutes!<5 || ticket.twapMinutes!>1440) result.errors.push('TWAP duration must be 5 to 1440 whole minutes.');
      if (ticket.takeProfit || ticket.stopLoss || ticket.positionTpsl) result.errors.push('Attach TP/SL to the position after the TWAP begins.');
      if (builder) result.errors.push('TWAP does not support a builder fee.');
      result.twap={twap:{a:m.assetId,b:buy,s:result.size,r:reduce,m:ticket.twapMinutes??5,t:ticket.twapRandomize??true}};
    } else {
      if (ticket.positionTpsl) {
        if (!ticket.takeProfit && !ticket.stopLoss) result.errors.push('Enter a take-profit or stop-loss price.');
      } else if (ticket.kind==='scale') {
        const count=ticket.scaleCount??0;
        if (!Number.isInteger(count)||count<2||count>50||!finitePositive(ticket.scaleEnd)||!finitePositive(ticket.scaleStart)) throw new Error('Scale requires 2 to 50 orders and positive start/end prices.');
        if (ticket.takeProfit || ticket.stopLoss) result.errors.push('Set position TP/SL separately from a scale order.');
        const slice=roundSize(new Decimal(result.size).div(count).toFixed(),m.szDecimals);
        for (let i=0;i<count;i++) {
          const price=roundPrice(ticket.scaleStart+(ticket.scaleEnd-ticket.scaleStart)*i/(count-1),m.szDecimals,buy?'down':'up');
          if (Number(slice)*Number(price)<10 && !reduce) result.errors.push('Each scale order must be at least $10.');
          add(price,slice,buy,reduce,{limit:{tif:ticket.tif??'Gtc'}});
        }
        result.size=roundSize(new Decimal(slice).mul(count).toFixed(),m.szDecimals);
        result.notional=orders.reduce((total,order)=>total+Number(order.p)*Number(order.s),0);
        const netScaleIncrease=Math.max(0,Math.abs((context.positionSize??0)+(buy?1:-1)*Number(result.size))-Math.abs(context.positionSize??0));
        result.marginRequired=reduce?0:netScaleIncrease*m.mark/ticket.leverage;
        result.builderFee=result.notional*builderRate;result.fee=result.notional*feeRate+result.builderFee;
        if (!reduce && result.marginRequired+Math.max(result.fee,0)>context.available) result.errors.push('Insufficient collateral for the scale orders.');
      } else if (trigger) {
        add(result.price,result.size,buy,reduce,{trigger:{triggerPx:roundPrice(ticket.triggerPrice!,m.szDecimals),isMarket:marketOrder,tpsl:ticket.kind.startsWith('stop-')?'sl':'tp'}});
      } else add(result.price,result.size,buy,reduce,{limit:{tif:marketOrder?'Ioc':ticket.tif??'Gtc'}});
      // Position TP/SL ticket side describes the position being protected.
      if (ticket.takeProfit) attach(ticket.takeProfit,'tp',!buy);
      if (ticket.stopLoss) attach(ticket.stopLoss,'sl',!buy);
      result.order={orders,grouping:ticket.positionTpsl?'positionTpsl':ticket.takeProfit||ticket.stopLoss?'normalTpsl':'na',...(builder?{builder:{b:builder.address.toLowerCase() as `0x${string}`,f:builder.feeTenthsBps}}:{})};
    }
  } catch(error) { result.errors.push(error instanceof Error?error.message:'Invalid order.'); }
  if(result.notional>settings.maxOrderNotional&&!result.warnings.some(w=>w.startsWith('Order value')))result.warnings.push(`Order value exceeds the $${settings.maxOrderNotional.toLocaleString()} guard.`);
  result.errors=[...new Set(result.errors)];
  return result;
}
