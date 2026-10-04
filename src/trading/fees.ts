/** Hyperliquid fee formula, trading/fees.md, verified 2026-10-04. Fractions, not percentages. */
export function perpFeeRates(input:{maker:number;taker:number;referralDiscount:number;deployerFeeScale:number;growthMode:boolean;alignedCollateral:boolean}) {
  const {deployerFeeScale:s}=input;
  const hip3=s<1?s+1:s*2,share=s<1?s/(1+s):0.5,growth=input.growthMode?0.1:1;
  const maker=input.maker*growth*(input.maker>0?hip3*(1-input.referralDiscount):input.alignedCollateral?(1-share)*1.5+share:1);
  const taker=input.taker*hip3*growth*(1-input.referralDiscount)*(input.alignedCollateral?(1-share)*0.8+share:1);
  return {maker,taker};
}
