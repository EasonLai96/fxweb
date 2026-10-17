import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { newGame } from '../src/game.js';
import { recordClose, ensureProgress } from '../src/progress.js';

function setup() {
  const env = { DB: createD1(new URL('../migrations', import.meta.url).pathname), MARKET_TEST_ALLOW_LEGACY: true };
  const call = async (method, path, body, token) => {
    const headers = { 'CF-Connecting-IP': 'test-ip', 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await worker.fetch(new Request('https://test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, body: await r.json() };
  };
  return { env, call };
}

test('registration reserves before PBKDF; duplicate and concurrent attempts consume quota', async () => {
  const { env, call } = setup();
  const responses = await Promise.all(Array.from({length: 24}, (_, i) => call('POST', '/api/register', {username: 'user_' + i, password: '12345678'})));
  assert.equal(responses.filter(r => r.status === 201).length, 10);
  assert.equal(responses.filter(r => r.status === 429).length, 14);
  assert.equal(env.DB.raw.prepare('SELECT count(*) AS n FROM users').get().n, 10);
  assert.equal(env.DB.raw.prepare("SELECT count FROM login_attempts WHERE key='reg:test-ip'").get().count, 10);
});

test('parallel failed login has a strict budget; successful login refunds only its reservation', async () => {
  const { env, call } = setup();
  await call('POST', '/api/register', {username:'alice', password:'12345678'});
  for (let i=0; i<15; i++) assert.equal((await call('POST', '/api/login', {username:'alice', password:'12345678'})).status, 200);
  const rs = await Promise.all(Array.from({length:24}, () => call('POST', '/api/login', {username:'ALICE', password:'wrongpass'})));
  assert.equal(rs.filter(r => r.status === 401).length,10);
  assert.equal(rs.filter(r => r.status === 429).length,14);
  assert.equal(env.DB.raw.prepare("SELECT count FROM login_attempts WHERE key='login:alice:test-ip'").get().count,10);
});

test('a concurrent successful login cannot erase other failed reservations', async () => {
  const { env, call } = setup();
  await call('POST', '/api/register', {username:'alice', password:'12345678'});
  const rs = await Promise.all([call('POST','/api/login',{username:'alice',password:'12345678'}), ...Array.from({length:9},()=>call('POST','/api/login',{username:'alice',password:'wrongpass'}))]);
  assert.equal(rs[0].status,200);
  assert.equal(rs.slice(1).filter(r=>r.status===401).length,9);
  assert.equal(env.DB.raw.prepare("SELECT count FROM login_attempts WHERE key='login:alice:test-ip'").get().count,9);
});

test('carry affects net PnL, wins and achievements; old stats are not reconstructed', () => {
  const g = newGame(Date.now());
  recordClose(g, {feePaid:1,carryPaid:3,executionVersion:1,side:1,leverage:2},3,'manual',Date.now());
  assert.equal(g.progress.stats.netRealizedPnl,-1);
  assert.equal(g.progress.stats.wins,0);
  assert.equal(g.progress.stats.losses,1);
  assert.equal(g.progress.unlocked.first_profit,undefined);
  recordClose(g, {feePaid:0,executionVersion:1,side:1,leverage:2},100,'manual',Date.now());
  assert.equal(g.progress.stats.missingCarryCloses,1);
  assert.equal(g.progress.stats.wins,0);
  delete g.progress.carryAccountingSince;
  delete g.progress.stats.closedCarryPaid;
  delete g.progress.lifetimeStats.closedCarryPaid;
  const before=g.progress.stats.netRealizedPnl;
  ensureProgress(g,Date.now());
  assert.equal(g.progress.carryHistoryComplete,false);
  assert.equal(g.progress.stats.netRealizedPnl,before);
});

test('partial close allocates costs, retains stops, deduplicates concurrent submissions and isolates receipts', async () => {
  const { env, call } = setup();
  const alice = (await call('POST','/api/register',{username:'alice',password:'12345678'})).body.token;
  const bob = (await call('POST','/api/register',{username:'bobby',password:'12345678'})).body.token;
  const opened = await call('POST','/api/game/open',{pair:'EUR/USD',side:1,leverage:2,margin:1000,requestId:'open-1'},alice);
  assert.equal(opened.status,200);
  const id=opened.body.result.opened.id;
  const row=env.DB.raw.prepare('SELECT user_id,state FROM games').get();
  const g=JSON.parse(row.state), p=g.account.positions[0];
  p.sl=p.entry*.5; p.tp=p.entry*2; p.carryPaid=12;
  env.DB.raw.prepare('UPDATE games SET state=? WHERE user_id=?').run(JSON.stringify(g),row.user_id);
  const payload={id,fraction:.25,requestId:'partial-1'};
  const rs=await Promise.all([call('POST','/api/game/close',payload,alice),call('POST','/api/game/close',payload,alice)]);
  assert.ok(rs.every(r=>r.status===200));
  assert.deepEqual(rs[0].body.result,rs[1].body.result);
  const r=rs[0].body.result;
  assert.equal(r.closedMargin,250); assert.equal(r.closedNotional,500); assert.equal(r.closedCarryPaid,3);
  assert.equal(r.remaining.margin,750); assert.equal(r.remaining.carryPaid,9);
  assert.equal(r.remaining.sl,p.sl); assert.equal(r.remaining.tp,p.tp);
  assert.equal(r.closedEntryFee+r.remaining.feePaid,p.feePaid);
  const receipt=await call('GET','/api/game/receipt?requestId=partial-1',undefined,alice);
  assert.equal(receipt.body.status,'confirmed'); assert.deepEqual(receipt.body.result,r);
  assert.equal(receipt.body.receiptProtocolVersion,1);
  assert.equal((await call('GET','/api/game/receipt?requestId=partial-1',undefined,bob)).body.status,'unknown');
  assert.equal((await call('GET','/api/game/receipt?requestId=partial-1')).status,401);
  assert.equal((await call('POST','/api/game/close',{...payload,fraction:.5},alice)).status,409);
  assert.equal((await call('POST','/api/game/close',{id,fraction:0,requestId:'invalid'},alice)).status,400);
  assert.equal((await call('GET','/api/game/receipt?requestId=invalid',undefined,alice)).body.status,'unknown');
  assert.equal((await call('POST','/api/game/close',{id,fraction:.5},alice)).status,400);
  const final=await call('POST','/api/game/close',{id,requestId:'final'},alice);
  assert.equal(final.status,200); assert.equal(final.body.account.positions.length,0);
  assert.equal(final.body.progress.stats.closedCarryPaid,12);
  // The bounded receipt store cannot prove an expired id was never committed.
  const saved=env.DB.raw.prepare('SELECT state FROM games WHERE user_id=?').get(row.user_id);
  const state=JSON.parse(saved.state);
  state.requests=Array.from({length:128},(_,i)=>({id:'new-'+i,fingerprint:'test',result:{i}}));
  env.DB.raw.prepare('UPDATE games SET state=? WHERE user_id=?').run(JSON.stringify(state),row.user_id);
  const expired=await call('GET','/api/game/receipt?requestId=partial-1',undefined,alice);
  assert.equal(expired.body.status,'unknown');
  assert.equal(expired.body.retention.bounded,true);
});
