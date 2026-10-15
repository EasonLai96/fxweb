import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PAIRS, hmacSha256 } from '../../market.mjs';
import { TICK_MS, SHARED_MARKET_ALGORITHM, absoluteTick, tickAt, sharedPrice, sharedCandle, sharedNews, makeSharedMarket } from '../src/shared-market.js';
const secret='6c'.repeat(32), other='e4'.repeat(32), pairs=Object.keys(PAIRS);
test('absolute UTC tick and validated inputs',()=>{
  assert.equal(TICK_MS,1500); assert.equal(tickAt(1499),0); assert.equal(absoluteTick(1499),0); assert.equal(absoluteTick(1500),1);
  assert.equal(absoluteTick(Date.UTC(2026,0,1)),Date.UTC(2026,0,1)/1500);
  assert.throws(()=>absoluteTick(NaN),RangeError);
  assert.throws(()=>makeSharedMarket('bad',1),/256-bit/);
  assert.throws(()=>sharedPrice(secret,-1,pairs[0]),RangeError);
  assert.throws(()=>sharedPrice(secret,1,'__proto__'),RangeError);
  assert.throws(()=>makeSharedMarket(secret,1,{history:0}),RangeError);
});
test('HMAC standard vector, secret isolation and stable algorithm ID',()=>{
  const enc=new TextEncoder();
  assert.equal(Buffer.from(hmacSha256(enc.encode('key'),enc.encode('The quick brown fox jumps over the lazy dog'))).toString('hex'), 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  assert.equal(SHARED_MARKET_ALGORITHM,'fxweb/shared/hmac-sha256-causal-v1');
  assert.notEqual(sharedPrice(secret,1000000,pairs[0]),sharedPrice(other,1000000,pairs[0]));
});
test('random access, price/candle shapes and deterministic 600x6 history',()=>{
  const head=1180000000, view=makeSharedMarket(secret,head,{history:600});
  assert.equal(view.step,head); assert.equal(view.history,600);
  assert.deepEqual(Object.keys(view.prices),pairs);
  for(const p of pairs) {
    assert.equal(view.candles[p].length,600);
    assert.equal(view.prices[p],sharedPrice(secret,head,p));
    for(const i of [0,1,63,64,187,599]) {
      const b=view.candles[p][i];
      assert.deepEqual(b,sharedCandle(secret,head-599+i,p));
      assert.ok(b.o>0&&b.l>0&&b.h>=b.o&&b.h>=b.c&&b.l<=b.o&&b.l<=b.c);
    }
    assert.ok(Math.abs(view.prices[p]/PAIRS[p]-1)<0.025);
  }
  assert.ok(!JSON.stringify(view).includes(secret));
  assert.deepEqual(makeSharedMarket(secret,head,{history:600}),view);
});
test('at and before anchor boundaries prices only use historical HMAC ticks',()=>{
  const key=Uint8Array.from(secret.match(/../g),h=>parseInt(h,16)),enc=new TextEncoder();
  for(const t of [0,1,63,64,65,127,128,1180000063,1180000064]) for(const p of pairs) {
    const seen=[];
    const get=(domain,tick)=>{
      seen.push(tick);
      const d=hmacSha256(key,enc.encode(`${SHARED_MARKET_ALGORITHM}|${domain}|${tick}|${p}`));
      return new DataView(d.buffer).getUint32(0)/4294967296;
    };
    const start=Math.floor(t/64)*64, anchor=at=>at<0?0:(get('anchor',at)*2-1)*0.012;
    const x=(t-start)/64,s=x*x*(3-2*x);
    const trend=anchor(start-64)*(1-s)+anchor(start)*s;
    let jitter=0;
    for(let lag=0;lag<3;lag++) if(t>=lag) jitter += [0.5,0.32,0.18][lag]*(get('noise',t-lag)*2-1);
    assert.ok(seen.every(at=>at<=t),`future anchor at ${t}`);
    assert.equal(sharedPrice(secret,t,p),PAIRS[p]*Math.exp(trend+jitter*0.0014));
  }
});
test('news releases only at its tick; reversal is delayed until settlement',()=>{
  const head=500000,view=makeSharedMarket(secret,head,{history:600});
  assert.ok(view.news.length>0&&view.news.length<=50);
  for(const n of view.news) {
    assert.ok(n.step<=head);
    const atRelease=sharedNews(secret,n.step);
    assert.ok(atRelease); assert.equal(atRelease.reversed,null); assert.equal(atRelease.settled,false);
    assert.equal(n.settled,head-n.step>=8);
    assert.equal(n.settled?typeof n.reversed:n.reversed,n.settled?'boolean':null);
  }
});
test('600x6 performance smoke',()=>{
  const start=performance.now(),view=makeSharedMarket(secret,1180000000,{history:600});
  const ms=performance.now()-start;
  assert.equal(view.candles[pairs[0]].length*pairs.length,3600);
  assert.ok(ms<10000,`600x6 generation took ${ms.toFixed(1)}ms`);
  console.log(`shared market 600x6: ${ms.toFixed(1)}ms`);
});
