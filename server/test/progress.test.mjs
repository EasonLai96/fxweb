import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, openOrder, closeOrder, resetGame, advance, view, TICK_MS } from '../src/game.js';
import { ensureProgress, emptyStats } from '../src/progress.js';
import { PAIRS } from '../../market.mjs';
import { unrealizedPnl } from '../../engine.mjs';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
const t = 1800000000000;
const clone = x => JSON.parse(JSON.stringify(x));
const order = { pair: 'EUR/USD', side: 1, leverage: 2, margin: 100 };
const near = (a,b) => assert.ok(Math.abs(a-b) < 1e-8, `${a} != ${b}`);
const achievement = (g,id) => view(g,-1,[],g.lastStepAt).progress.achievements.find(a=>a.id===id);
function profitable(g, pair = order.pair, side = 1) {
  const pos = openOrder(g,{...order,pair,side},g.lastStepAt);
  g.market.prices[pair] *= side === 1 ? 1.01 : .99;
  closeOrder(g,pos.id,g.lastStepAt);
  return pos;
}

test('fresh progress is self-contained, 12 bounded achievements and no secrets in full/delta',()=>{
  const g=newGame(t);
  for (const since of [-1,g.market.step]) {
    const p=view(g,since,[],t).progress;
    assert.equal(p.version,1); assert.equal(p.trackingSince,t); assert.equal(p.roundStartedAt,t);
    assert.equal(p.historyComplete,true); assert.deepEqual(p.stats,emptyStats());
    assert.equal(p.achievements.length,12); assert.equal(new Set(p.achievements.map(a=>a.id)).size,12);
    assert.ok(p.achievements.every(a=>a.unlockedAt===null && a.progress===0 && a.target>0 && a.description && a.title));
    assert.ok(!JSON.stringify(p).includes(g.market.secret));
    p.stats.pairsTraded.push('fake'); assert.deepEqual(g.progress.stats.pairsTraded,[]);
  }
});

test('manual closes separate gross, net, paid fees and cash flow; profit is after fees',()=>{
  const g=newGame(t),p=openOrder(g,order,t);
  assert.equal(g.progress.stats.openedTrades,1); near(g.progress.stats.feesPaid,p.feePaid);
  assert.equal(achievement(g,'first_open').unlockedAt,t);
  g.market.prices[p.pair] = p.entry * (1+p.feePaid/p.notional/2);
  const gross=closeOrder(g,p.id,t);
  assert.ok(gross>0); assert.equal(g.progress.stats.wins,0); assert.equal(g.progress.stats.losses,1);
  near(g.progress.stats.netRealizedPnl,gross-p.feePaid);
  near(g.progress.stats.cashFlowPnl,g.account.cash-g.account.startingCash);
  profitable(g); profitable(g,order.pair,-1);
  assert.equal(g.progress.stats.wins,2); assert.equal(g.progress.stats.lowLeverageWins,2);
  for(const id of ['first_close','first_profit','both_sides','low_leverage_profit','long_profit','short_profit']) assert.equal(achievement(g,id).unlockedAt,t);
  const before=clone(g.progress);
  assert.throws(()=>closeOrder(g,p.id,t)); assert.throws(()=>openOrder(g,{...order,margin:1},t));
  assert.deepEqual(g.progress,before);
});

test('cumulative stats survive log truncation and persistence; every achievement can unlock',()=>{
  let g=newGame(t);
  const pairs=Object.keys(PAIRS);
  for(let i=0;i<125;i++) {
    profitable(g,pairs[i%pairs.length],i%2 ? -1:1);
    if(i===70)g=clone(g);
  }
  assert.equal(g.account.log.length,200);
  assert.equal(g.progress.stats.closedTrades,125); assert.equal(g.progress.lifetimeStats.openedTrades,125);
  assert.equal(g.progress.stats.pairsTraded.length,pairs.length);
  assert.ok(view(g,-1,[],t).progress.achievements.every(a=>a.unlockedAt===t && a.progress===a.target));
  const p=clone(g.progress); advance(g,t); view(g,-1,[],t); assert.deepEqual(g.progress,p);
});

test('reset clears round only, keeps lifetime unlock timestamps and exposes reset count',()=>{
  const g=newGame(t); profitable(g); openOrder(g,order,t);
  const lifetime=clone(g.progress.lifetimeStats), unlocked=clone(g.progress.unlocked);
  resetGame(g,t+100);
  assert.deepEqual(g.progress.stats,emptyStats()); assert.deepEqual(g.progress.lifetimeStats,lifetime);
  assert.deepEqual(g.progress.unlocked,unlocked); assert.equal(g.progress.roundStartedAt,t+100);
  assert.equal(g.account.positions.length,0); assert.equal(view(g,-1,[],t).progress.resets,1);
  profitable(g); assert.equal(g.progress.stats.closedTrades,1); assert.equal(g.progress.lifetimeStats.closedTrades,2);
  assert.equal(achievement(g,'first_profit').unlockedAt,t);
});

test('liquidation counts exact engine PnL and fees once; deterministic checkpoint replay',()=>{
  const g=newGame(t),pos=openOrder(g,{...order,leverage:10},t);
  pos.entry*=2;
  const saved=clone(g),a=clone(g),b=clone(g);
  const events=advance(a,t+TICK_MS).events;
  assert.equal(events.filter(e=>e.type==='liquidated').length,1);
  const gross=unrealizedPnl(saved.account.positions[0],a.market.prices[pos.pair]);
  const s=a.progress.stats;
  assert.equal(s.closedTrades,1); assert.equal(s.liquidations,1); assert.equal(s.manualCloses,0);
  near(s.grossRealizedPnl,gross); near(s.netRealizedPnl,gross-pos.feePaid);
  near(s.cashFlowPnl,a.account.cash-a.account.startingCash);
  advance(b,t+TICK_MS); assert.deepEqual(b,a);
  advance(a,t+TICK_MS); assert.equal(a.progress.stats.closedTrades,1);
  assert.equal(achievement(a,'first_profit').unlockedAt,null);
});

test('legacy upgrade ignores retained log, preserves account and identifies incomplete history',()=>{
  const g=newGame(t); profitable(g); const old=openOrder(g,order,t); delete g.progress;
  g.resets=4; const account=clone(g.account);
  assert.equal(ensureProgress(g,t+100),true); assert.equal(ensureProgress(g,t+200),false);
  assert.deepEqual(g.account,account); assert.deepEqual(g.progress.stats,emptyStats());
  assert.equal(g.progress.trackingSince,t+100); assert.equal(g.progress.historyComplete,false);
  assert.match(view(g,-1,[],t).progress.trackingNote,/不回推/);
  g.market.prices[old.pair]*=1.01; closeOrder(g,old.id,t+100);
  assert.equal(g.progress.stats.openedTrades,0); assert.equal(g.progress.stats.closedTrades,1);
  assert.equal(g.progress.stats.feesPaid,0); near(g.progress.stats.closedEntryFees,old.feePaid);
  assert.equal(achievement(g,'first_open').unlockedAt,null);
  assert.equal(achievement(g,'first_profit').unlockedAt,t+100);
});

test('unknown legacy entry fee is disclosed and cannot earn a profit achievement',()=>{
  const g=newGame(t),p=openOrder(g,order,t); delete p.feePaid; delete g.progress;
  ensureProgress(g,t); g.market.prices[p.pair]*=1.01; closeOrder(g,p.id,t);
  assert.equal(g.progress.stats.missingEntryFeeCloses,1); assert.equal(g.progress.stats.wins,0);
  assert.equal(g.progress.stats.losses,0); assert.equal(achievement(g,'first_profit').unlockedAt,null);
});

test('legacy offline liquidation is tracked from activation without backdating unlocks',()=>{
  const g=newGame(t); openOrder(g,{...order,leverage:10},t).entry*=2; delete g.progress;
  ensureProgress(g,t+10*TICK_MS); advance(g,t+10*TICK_MS);
  assert.equal(g.progress.stats.liquidations,1);
  assert.equal(achievement(g,'first_close').unlockedAt,t+10*TICK_MS);
});

test('API persists first legacy GET upgrade, CAS retries and request replay do not double count',async()=>{
  const env={DB:createD1(new URL('../migrations',import.meta.url).pathname),MARKET_TEST_ALLOW_LEGACY:true};
  let token;
  const call=async(path,body)=>{
    const res=await worker.fetch(new Request('https://api.test/api/'+path,{
      method:body===undefined?'GET':'POST', headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      body:body===undefined?undefined:JSON.stringify(body),
    }),env);
    const data=await res.json(); assert.equal(res.status,path==='register'?201:200,JSON.stringify(data)); return data;
  };
  token=(await call('register',{username:'progress_test',password:'12345678'})).token;
  await call('game');
  let row=env.DB.raw.prepare('SELECT * FROM games').get(); let saved=JSON.parse(row.state);
  delete saved.progress;
  env.DB.raw.prepare('UPDATE games SET state=?').run(JSON.stringify(saved));
  const v=await call('game'); row=env.DB.raw.prepare('SELECT * FROM games').get();
  assert.equal(JSON.parse(row.state).progress.trackingSince,v.progress.trackingSince);
  assert.equal(v.progress.historyComplete,false);
  const prepare=env.DB.prepare; let failures=0;
  env.DB.prepare=sql=>{
    const stmt=prepare(sql);
    if(!sql.startsWith('UPDATE games SET state')) return stmt;
    return {bind(...args){const bound=stmt.bind(...args); return {...bound,first:async()=>{if(failures++===0)return null;return bound.first();}};}};
  };
  const body={...order,requestId:'open-once'};
  const opened=await call('game/open',body); const replay=await call('game/open',body);
  assert.equal(opened.progress.stats.openedTrades,1); assert.equal(replay.progress.stats.openedTrades,1);
  assert.ok(failures>=2); near(replay.progress.stats.feesPaid,opened.result.opened.feePaid);
  const closeBody={id:opened.result.opened.id,requestId:'close-once'};
  await call('game/close',closeBody); const closed=await call('game/close',closeBody);
  assert.equal(closed.progress.stats.closedTrades,1);
  await call('game/reset',{requestId:'reset-once'}); const reset=await call('game/reset',{requestId:'reset-once'});
  assert.equal(reset.progress.resets,1); assert.deepEqual(reset.progress.stats,emptyStats());
  assert.equal(reset.progress.lifetimeStats.openedTrades,1); assert.equal(reset.progress.lifetimeStats.closedTrades,1);
});
