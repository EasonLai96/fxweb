import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../engine.mjs";
import { createMarket, createMarketState, exportMarketState, stepMarket } from "../market.mjs";
import * as S from "../store.mjs";
const near = (a,b) => assert.ok(Math.abs(a-b) <= 1e-8 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
function storage() {
  const data = new Map();
  globalThis.localStorage = { getItem:k=>data.has(k)?data.get(k):null, setItem:(k,v)=>data.set(k,String(v)), removeItem:k=>data.delete(k) };
  return data;
}

test("guest checkpoint round-trip preserves all future draws, active events, news and candles", () => {
  const a = createMarket(1234);
  for(let i=0;i<800;i++) a.tick();
  a.state.ev.push({step:a.step(),logs:{BTC:Math.log(0.6)}});
  const snapshot = a.exportState();
  const b = createMarket(999,{state:JSON.parse(JSON.stringify(snapshot))});
  snapshot.prices.BTC = 1;
  assert.notEqual(b.get("BTC"),1);
  for(let i=0;i<700;i++) assert.deepEqual(b.tick(),a.tick());
  assert.deepEqual(b.exportState(),a.exportState());
  const prior = b.exportState();
  assert.throws(()=>b.restoreState({...prior,r:NaN}));
  assert.deepEqual(b.exportState(),prior);
});

test("old market algorithms and instrument lists are not silently upgraded", () => {
  const ms = createMarketState(42);
  delete ms.etfStable; delete ms.ev;
  for(const p of Object.keys(ms.prices).filter(p=>!p.includes("/"))) {
    for(const field of ["prices","phase","bias","candles"]) delete ms[field][p];
  }
  const a = createMarket(0,{state:ms});
  for(let i=0;i<100;i++) assert.deepEqual(a.tick(),stepMarket(ms));
  assert.equal(a.pairs().length,6);
  assert.equal(exportMarketState(ms).etfStable,undefined);
});

test("versioned storage is paired, detached and resumes account at exact quote", () => {
  storage(); const m = createMarket(77), a = E.createAccount();
  E.openPosition(a,m.prices(),{pair:"BTC",side:1,leverage:2,notional:1000,time:m.step()});
  m.tick();
  assert.equal(S.save(a,m),true);
  const loaded = S.loadGuest();
  assert.equal(loaded.status,"ready");
  assert.deepEqual(loaded.account,S.snapshot(a));
  assert.deepEqual(loaded.market,m.exportState());
  assert.equal(S.load(),null); // no unsafe compatibility resume of open positions
  const resumed = createMarket(0,{state:loaded.market});
  near(E.equity(loaded.account,resumed.prices()),E.equity(a,m.prices()));
  assert.deepEqual(resumed.tick(),m.tick());
  assert.equal(S.save(a),false);
});

test("legacy recovery preserves byte-for-byte original backup across reset/clear", () => {
  const data = storage(), a = E.createAccount(), raw = JSON.stringify(a,null,2);
  data.set(S.SAVE_KEY,raw);
  const r = S.loadGuest();
  assert.equal(r.status,"legacy-missing-market");
  assert.equal(data.get(S.SAVE_KEY),raw);
  assert.equal(S.archiveGuest().text,raw);
  assert.equal(S.resetGuest(E.createAccount(),createMarket(12)),true);
  assert.equal(S.loadGuest().status,"ready");
  S.clear();
  assert.equal(data.get(S.BACKUP_KEY),raw);
  assert.equal(S.loadGuest().status,"empty");
});

test("invalid/unknown versions are identifiable and remain untouched", () => {
  const data = storage();
  for(const raw of ["{bad",JSON.stringify({version:999}),JSON.stringify({version:2,account:E.createAccount(),market:{}})]) {
    data.set(S.SAVE_KEY,raw);
    assert.equal(S.loadGuest().status,"invalid");
    assert.equal(data.get(S.SAVE_KEY),raw);
  }
});

for(const pair of ["EUR/USD","USD/JPY","BTC"]) for(const side of [1,-1]) {
  test(`partial close conservation ${pair} side ${side}`,()=>{
    const entry=pair==="USD/JPY"?150:100, price=entry*1.02;
    const a=E.createAccount(100000), opened=E.openPosition(a,{[pair]:entry},{pair,side,leverage:10,notional:10000,time:1,sl:side===1?entry*.9:entry*1.1,tp:side===1?entry*1.1:entry*.9});
    assert.equal(opened.ok,true);
    const p=opened.position; p.margin+=123; p.carryPaid=12; a.cash-=12;
    const original={...p}, cash=a.cash, eq=E.equity(a,{[pair]:price});
    const gross=E.unrealizedPnl(p,price);
    const r=E.closePositionPartial(a,p.id,price,2,.25);
    assert.equal(r.ok,true); assert.equal(r.closed,p.id); assert.equal(r.remaining,p);
    near(r.pnl,gross*.25); near(a.cash,cash+gross*.25);
    near(E.equity(a,{[pair]:price}),eq);
    for(const key of ["margin","notional","units","feePaid","carryPaid"]) near(p[key],original[key]*.75);
    assert.equal(p.sl,original.sl); assert.equal(p.tp,original.tp); assert.equal(p.id,original.id);
    near(r.netPnl,r.pnl-original.feePaid*.25-3);
    const r2=E.closePositionPartial(a,p.id,price,3,1);
    assert.equal(r2.remaining,null); assert.equal(r2.partial,false);
    assert.equal(a.positions.length,0); near(a.cash,cash+gross);
  });
}

test("bad fraction/price are atomic; legacy units are scaled; full API unchanged",()=>{
  const a=E.createAccount();
  E.openPosition(a,{"EUR/USD":1},{pair:"EUR/USD",side:1,leverage:2,notional:1000,time:1});
  delete a.positions[0].units;
  const before=JSON.stringify(a);
  for(const f of [0,-1,1.1,NaN,Infinity,"0.5",null]) assert.equal(E.closePositionPartial(a,1,1.1,2,f).ok,false);
  assert.equal(E.closePositionPartial(a,1,Infinity,2,.5).ok,false);
  assert.equal(JSON.stringify(a),before);
  E.closePositionPartial(a,1,1.1,2,.5);
  near(a.positions[0].units,500);
  const r=E.closePosition(a,1,1.1,3);
  assert.deepEqual(Object.keys(r).sort(),["ok","pnl"]);
});


test("storage failures never replace legacy source without a backup",()=>{
  const data=storage(), raw=JSON.stringify(E.createAccount());
  data.set(S.SAVE_KEY,raw);
  globalThis.localStorage.setItem=()=>{throw new Error("quota");};
  assert.equal(S.save(E.createAccount(),createMarket(1)),false);
  assert.equal(S.resetGuest(E.createAccount(),createMarket(1)),false);
  S.clear();
  assert.equal(data.get(S.SAVE_KEY),raw);
});

test("multiple partial closes conserve units and paid costs",()=>{
  const a=E.createAccount(100000);
  const p=E.openPosition(a,{BTC:100},{pair:"BTC",side:1,leverage:10,notional:10000,time:1}).position;
  p.carryPaid=27; a.cash-=27;
  const before={...p}, startCash=a.cash;
  let entryFee=0, carry=0, margin=0, notional=0;
  for(const f of [.13,.7,.09,1]) {
    const r=E.closePositionPartial(a,p.id,101,2,f);
    entryFee+=r.closedEntryFee; carry+=r.closedCarryPaid;
    margin+=r.closedMargin; notional+=r.closedNotional;
  }
  near(entryFee,before.feePaid); near(carry,27);
  near(margin,before.margin); near(notional,before.notional);
  near(a.cash,startCash+100); assert.equal(a.positions.length,0);
});


test("all close logs carry exact cost attribution including automatic stops",()=>{
 const a=E.createAccount();
 const p=E.openPosition(a,{BTC:100},{pair:'BTC',side:1,leverage:2,notional:1000,time:1,tp:110}).position;
 p.carryPaid=8;
 E.closePositionPartial(a,p.id,105,2,.25);
 E.settleTick(a,{BTC:111},3);
 const exits=a.log.filter(l=>['close','partial_close'].includes(l.type));
 assert.equal(exits.length,2);
 for(const l of exits) {assert.equal(l.costsComplete,true);near(l.netPnl,l.pnl-l.feePaid-l.carryPaid);}
 near(exits.reduce((sum,l)=>sum+l.carryPaid,0),8);
 near(exits.reduce((sum,l)=>sum+l.feePaid,0),E.feeFor(1000,2));
});

test("unknown legacy cost basis is explicit, never invented as zero",()=>{
 for(const f of [.5,1]) {
  const a=E.createAccount();
  E.openPosition(a,{BTC:100},{pair:'BTC',side:1,leverage:2,notional:1000,time:1});
  delete a.positions[0].feePaid;
  const result=E.closePositionPartial(a,1,101,2,f), log=a.log.at(-1);
  assert.equal(result.netPnl,null); assert.equal(result.costsComplete,false);
  assert.equal(log.netPnl,null); assert.equal(log.costsComplete,false); assert.equal(log.feePaid,null);
 }
});


test("server carryUnknown and absent financing basis remain unknown across exits",()=>{
 for(const patch of [{executionVersion:1,carryUnknown:true,carryPaid:12},{executionVersion:1}]) {
  const a=E.createAccount();
  const p=E.openPosition(a,{BTC:100},{pair:'BTC',side:1,leverage:2,notional:1000,time:1}).position;
  Object.assign(p,patch);
  const partial=E.closePositionPartial(a,p.id,101,2,.5);
  assert.equal(partial.netPnl,null); assert.equal(partial.costsComplete,false); assert.equal(partial.closedCarryPaid,null);
  assert.equal(a.log.at(-1).netPnl,null); assert.equal(a.log.at(-1).costsComplete,false);
  E.closePosition(a,p.id,102,3);
  assert.equal(a.log.at(-1).netPnl,null); assert.equal(a.log.at(-1).costsComplete,false);
 }
 const guest=E.createAccount();
 E.openPosition(guest,{BTC:100},{pair:'BTC',side:1,leverage:2,notional:1000,time:1});
 E.closePosition(guest,1,101,2);
 assert.equal(guest.log.at(-1).costsComplete,true); assert.equal(guest.log.at(-1).carryPaid,0);
});
