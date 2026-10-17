import test from 'node:test';
import assert from 'node:assert/strict';
import {sizeRisk,closeMidThreshold,estimatedFriction} from '../risk-budget.mjs';
import {unrealizedPnl,feeFor,LIQ_LOSS} from '../engine.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8*Math.max(1,Math.abs(b)),`${a} != ${b}`);
for(const pair of ['EUR/USD','USD/JPY','BTC']) for(const side of [1,-1]) for(const frictionEnabled of [false,true]) {
 test(`risk sizing independently verifies ${pair} ${side} costs=${frictionEnabled}`,()=>{
  const kind=pair==='BTC'?'crypto':'fx',price=pair==='USD/JPY'?150:100,stop=price*(1-side*.02),leverage=10;
  const r=sizeRisk({pair,kind,side,price,stop,leverage,netWorth:10000,free:7000,riskPct:1,hours:24,frictionEnabled});
  assert.equal(r.ok,true);
  assert.ok(r.loss<=100+1e-8); assert.ok(r.margin+r.fee<=7000+1e-8);
  const spread=frictionEnabled?estimatedFriction(kind,r.notional):0;
  const entry=price*(1+side*spread),fill=stop*(1-side*spread);
  const expectedGross=pair==='USD/JPY'?side*(fill-entry)*r.notional/fill:side*(fill-entry)*r.notional/entry;
  near(r.loss,-expectedGross+feeFor(r.notional,leverage)+r.carry);
  assert.ok(r.gapLoss>r.loss);
  const pos={pair,side,notional:r.notional,margin:r.margin,entry};
  near(unrealizedPnl(pos,r.threshold*(1-side*spread)),-LIQ_LOSS*r.margin);
  near(r.threshold,closeMidThreshold(pos,spread));
 });
}
test('USD-base inverse price sizing differs from quote-base linear approximation',()=>{
 const common={kind:'fx',side:1,price:150,stop:135,leverage:5,netWorth:10000,free:10000,riskPct:1,hours:0};
 const base=sizeRisk({...common,pair:'USD/JPY'}), quote=sizeRisk({...common,pair:'EUR/USD'});
 assert.equal(base.ok,true); assert.equal(quote.ok,true);
 assert.ok(base.notional<quote.notional);
 near(base.loss,base.notional*(150-135)/135+base.fee);
});
test('liquidation warning and free margin constraint',()=>{
 const r=sizeRisk({pair:'BTC',side:1,price:100,stop:90,leverage:100,netWorth:100000,free:1000});
 assert.equal(r.ok,true); assert.equal(r.liquidatedBeforeStop,true);
 const limited=sizeRisk({pair:'BTC',side:1,price:100,stop:99.9,leverage:5,netWorth:100000,free:20,riskPct:1});
 assert.equal(limited.ok,true); assert.ok(limited.margin+limited.fee<=20+1e-8);
});
test('invalid inputs and subminimum budget cannot produce an order',()=>{
 const base={pair:'EUR/USD',side:1,price:1,stop:.99,leverage:5,netWorth:10000,free:10000};
 for(const patch of [{side:0},{price:NaN},{stop:1.1},{stop:0},{riskPct:0},{riskPct:101},{hours:-1},{free:0},{netWorth:0}]) assert.equal(sizeRisk({...base,...patch}).ok,false);
 assert.equal(sizeRisk({...base,free:5}).ok,false);
});
