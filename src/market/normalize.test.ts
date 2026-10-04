import {describe,expect,test} from 'bun:test';
import {applyContext,assetClass,normalizeBook,normalizeMarkets,normalizePredicted,normalizeTrade,numberOrNull,resolveMarket} from './normalize.ts';
import type {Dex,Market,RawMeta} from './types.ts';
const dex:Dex={name:'xyz',fullName:'Trade[XYZ]',index:1,deployer:null,oracleUpdater:null,collateral:'USDC',collateralToken:0,fundingMultipliers:{}};
const meta:RawMeta={universe:[{name:'xyz:OLD',szDecimals:2,maxLeverage:5,isDelisted:true},{name:'xyz:TSLA',szDecimals:3,maxLeverage:20,marginMode:'noCross'}]};
const context={markPx:'250',oraclePx:'200',midPx:'251',prevDayPx:'240',funding:'0.00001',openInterest:'100',dayNtlVlm:'5000',premium:'0.03'};
const market=()=>normalizeMarkets(meta,[{},context],dex,new Map([['xyz:TSLA','stocks']]),1000)[0]!;
describe('venue financial normalization',()=>{
  test('asset ids retain original dex and universe indices after delisted markets are removed',()=>{const m=market();expect(m.assetId).toBe(110001);expect(m.universeIndex).toBe(1);expect(m.onlyIsolated).toBe(true);expect(m.underlyingSymbol).toBe('TSLA')});
  test('OI uses mark, not oracle or mids; hourly funding is annualized simply',()=>{
    const m=market();expect(m.oiUsd).toBe(25_000);expect(m.oiVolume).toBe(5);expect(m.premium).toBe(.25);expect(m.fundingPremium).toBe(.03);
    expect(m.change24h).toBeCloseTo(250/240-1);expect(m.funding8h).toBeCloseTo(.00008);expect(m.fundingApr).toBeCloseTo(.0876);expect(m.mid).toBe(251);
  });
  test('unavailable inputs remain blank and denominators do not create infinity',()=>{
    const m=applyContext(market(),{markPx:'0',oraclePx:'0',openInterest:'0',dayNtlVlm:'0',funding:'NaN'},2000);
    expect(m.premium).toBeNull();expect(m.change24h).toBeNull();expect(m.oiVolume).toBeNull();expect(m.fundingApr).toBeNull();expect(m.oiUsd).toBe(0);
    expect(numberOrNull(null)).toBeNull();expect(numberOrNull('')).toBeNull();expect(numberOrNull(false)).toBeNull();
  });
  test('venue categories preserve unknown HIP-3 identity and special asset classes',()=>{
    expect(assetClass('xyz:NEWCO')).toBe('Other');expect(assetClass('xyz:TSLA','stocks')).toBe('Stocks');expect(assetClass('hyna:BTC','crypto')).toBe('Crypto');expect(assetClass('xyz:GOLD','commodities')).toBe('Metals');expect(assetClass('xyz:CL','commodities')).toBe('Energy');
    expect(normalizeMarkets({universe:[{name:'io:ANTH',szDecimals:2,maxLeverage:2}]},[context],dex,new Map([['io:ANTH','preipo']]),0)[0]?.underlyingSymbol).toBeNull();
  });
  test('reported predicted rates retain each venue interval and absent venues',()=>{
    const rows=normalizePredicted([['BTC',[['HlPerp',{fundingRate:'0.00001',fundingIntervalHours:1,nextFundingTime:123}],['BinPerp',{fundingRate:'-0.00008',fundingIntervalHours:8,nextFundingTime:456}],['Missing',null]]]]);
    expect(rows).toHaveLength(2);expect(rows[0]?.per8h).toBeCloseTo(.00008);expect(rows[1]?.apr).toBeCloseTo(-.0876);expect(rows[1]?.nextFundingTime).toBe(456);
  });
  test('unqualified symbols resolve exact native crypto then the most liquid HIP-3 listing',()=>{
    const m=market(),other={...m,coin:'cash:TSLA',dex:'cash',volume24h:10_000};expect(resolveMarket([m,other],'tsla')?.coin).toBe('cash:TSLA');expect(resolveMarket([m,other],'xyz:tsla')?.coin).toBe('xyz:TSLA');
  });
  test('book cumulative depth and spread are in matching units',()=>{
    const b=normalizeBook({coin:'BTC',time:1,levels:[[{px:'99',sz:'2',n:1},{px:'98',sz:'3',n:2}],[{px:'101',sz:'4',n:1}]]});
    expect(b.bids[1]?.totalSize).toBe(5);expect(b.bids[1]?.totalUsd).toBe(492);expect(b.spread).toBe(2);expect(b.spreadBps).toBe(200);
    expect(normalizeTrade({coin:'BTC',time:1,tid:2,side:'A',px:'100',sz:'2'})?.side).toBe('sell');
  });
});
