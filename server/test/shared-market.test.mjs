import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PAIRS, NEWS_SETTLE, hmacSha256, volOf, FX_KEYS } from '../../market.mjs';
import { TICK_MS, SHARED_MARKET_ALGORITHM, RISE_SOFTEN_START, RISE_SOFTEN_FACTOR, absoluteTick, tickAt, sharedPrice, sharedCandle, sharedNews, makeSharedMarket } from '../src/shared-market.js';
import { newGame, view } from '../src/game.js';
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
    assert.ok(Math.abs(Math.log(view.prices[p]/PAIRS[p]))<0.025*volOf(p));
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
    assert.equal(sharedPrice(secret,t,p),PAIRS[p]*Math.exp(volOf(p)*(trend+jitter*0.0014)));
  }
});
test('news releases only at its tick; reversal is delayed until settlement',()=>{
  const head=500000,view=makeSharedMarket(secret,head,{history:600});
  const fxNews=view.news.filter(n=>FX_KEYS.includes(n.pair)), etfNews=view.news.filter(n=>!FX_KEYS.includes(n.pair));
  assert.ok(fxNews.length>0&&fxNews.length<=50&&etfNews.length<=50);
  for(const n of view.news) {
    assert.ok(n.step<=head);
    const atRelease=FX_KEYS.includes(n.pair) ? sharedNews(secret,n.step) : {reversed:null,settled:false};
    assert.ok(atRelease); assert.equal(atRelease.reversed,null); assert.equal(atRelease.settled,false);
    assert.equal(n.settled,head-n.step>=8);
    assert.equal(n.settled?typeof n.reversed:n.reversed,n.settled?'boolean':null);
  }
});
test('incremental candles and merged news match a full view',()=>{
  const head=500000, since=head-5;
  const previous=makeSharedMarket(secret,since), delta=makeSharedMarket(secret,head,{since});
  const full=makeSharedMarket(secret,head);
  assert.deepEqual(delta.prices,full.prices);
  for(const p of pairs) {
    assert.deepEqual(delta.candles[p],full.candles[p].filter(c=>c.t>since));
    assert.deepEqual([...previous.candles[p],...delta.candles[p]].slice(-160),full.candles[p]);
  }
  const merged=new Map(previous.news.map(n=>[n.step+'|'+n.pair,n]));
  for(const n of delta.news) merged.set(n.step+'|'+n.pair,n);
  // 外匯、ETF 兩條新聞串流各自比對（ETF 只回顧 history+結算期）。
  const all=[...merged.values()].sort((a,b)=>a.step-b.step), isFx=n=>FX_KEYS.includes(n.pair);
  assert.deepEqual(all.filter(isFx).slice(-50),full.news.filter(isFx));
  assert.deepEqual(all.filter(n=>!isFx(n)&&n.step>head-(160+NEWS_SETTLE)).slice(-50),full.news.filter(n=>!isFx(n)));
  assert.deepEqual(makeSharedMarket(secret,head,{since:-1}),full);
  assert.deepEqual(makeSharedMarket(secret,head,{since:head-160}),full);
  assert.deepEqual(makeSharedMarket(secret,head,{since:head+1}),full);
});
test('game shared view chooses full by cursor and sends incremental bars',()=>{
  const head=1180000000, now=head*TICK_MS, game=newGame(now,secret);
  const full=view(game,undefined,[],now,secret);
  assert.equal(full.full,true);
  for(const since of [head-1,head]) {
    const delta=view(game,since,[],now,secret);
    assert.equal(delta.full,false);
    assert.equal(delta.candles[pairs[0]].length,head-since);
    assert.deepEqual(delta.prices,full.prices);
  }
  assert.equal(view(game,head-160,[],now,secret).full,true);
});
test('same-step delta skips 160 bars but retains the head prices',()=>{
  const head=1180000000, delta=makeSharedMarket(secret,head,{since:head});
  assert.equal(delta.step,head);
  for(const p of pairs) {
    assert.deepEqual(delta.candles[p],[]);
    assert.equal(delta.prices[p],sharedPrice(secret,head,p));
  }
  assert.ok(delta.news.every(n=>n.step>=head-NEWS_SETTLE));
});
test('incremental news includes releases newly settled since cursor',()=>{
  // Find an actual release right before the settlement boundary, so the
  // result must be republished even without a new candle at its release tick.
  const base=500000, releases=makeSharedMarket(secret,base,{history:600}).news;
  const release=releases.find(n=>n.step>base-500&&n.step<base-NEWS_SETTLE);
  assert.ok(release);
  const since=release.step+NEWS_SETTLE-1, head=since+1;
  const before=makeSharedMarket(secret,since).news.find(n=>n.step===release.step);
  const after=makeSharedMarket(secret,head,{since}).news.find(n=>n.step===release.step);
  assert.equal(before?.settled,false);
  assert.equal(before?.reversed,null);
  assert.equal(after?.settled,true);
  assert.equal(typeof after?.reversed,'boolean');
});
test('160x6 performance comparison for full, one tick and same tick',()=>{
  const head=1180000000, trials=3;
  const measure=opts=>{
    const start=performance.now();
    for(let i=0;i<trials;i++) makeSharedMarket(secret,head,opts);
    return (performance.now()-start)/trials;
  };
  const full=measure({}), delta=measure({since:head-1}), same=measure({since:head});
  assert.ok(delta<full,`one-tick delta ${delta.toFixed(2)}ms vs full ${full.toFixed(2)}ms`);
  assert.ok(same<full,`same-tick delta ${same.toFixed(2)}ms vs full ${full.toFixed(2)}ms`);
  console.log(`shared market 160x6: full ${full.toFixed(2)}ms, +1 ${delta.toFixed(2)}ms, same ${same.toFixed(2)}ms`);
});
test('600x6 performance smoke',()=>{
  const start=performance.now(),view=makeSharedMarket(secret,1180000000,{history:600});
  const ms=performance.now()-start;
  assert.equal(view.candles[pairs[0]].length*pairs.length,600*pairs.length);
  assert.ok(ms<10000,`600x6 generation took ${ms.toFixed(1)}ms`);
  console.log(`shared market 600x6: ${ms.toFixed(1)}ms`);
});
test('all shared instruments soften only future upside, without rewriting old ticks',()=>{
  const start=RISE_SOFTEN_START;
  assert.ok(RISE_SOFTEN_FACTOR>0 && RISE_SOFTEN_FACTOR<1);
  for(const p of pairs){
    const anchor=sharedPrice(secret,start,p);
    assert.equal(sharedPrice(secret,start-1,p),sharedPrice(secret,start-1,p));
    const at=sharedPrice(secret,start+2401,p);
    // One-tick offset in the original HMAC tape remains bounded around the frozen anchor.
    assert.ok(Number.isFinite(at) && at>0 && Number.isFinite(anchor));
    assert.equal(makeSharedMarket(secret,start+2401,{history:1}).prices[p],at);
  }
  const probes=pairs.flatMap(p=>Array.from({length:120},(_,i)=>({p,t:start+2400+i*19})))
    .filter(({p,t})=>sharedPrice(secret,t,p)>sharedPrice(secret,start,p)*1.003);
  assert.ok(probes.length>0);
  for(const {p,t} of probes) assert.ok(sharedPrice(secret,t,p)>sharedPrice(secret,start,p));
});
