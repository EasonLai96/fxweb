import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../engine.mjs';
import { sharedPrice, absoluteTick } from '../src/shared-market.js';
import { newGame, advance, openOrder, setPositionStops, view, TICK_MS } from '../src/game.js';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';

const secret = 'cd'.repeat(32);
const start = 1800000000000;
const pair = 'EUR/USD';

// ---------- 引擎：驗證 ----------
test('止損止盈：方向驗證', () => {
  assert.ok(E.normalizeStops(1, 1.1, 1.0, 1.2).ok);
  assert.ok(E.normalizeStops(-1, 1.1, 1.2, 1.0).ok);
  assert.ok(E.normalizeStops(1, 1.1, null, null).ok);
  assert.ok(E.normalizeStops(1, 1.1, undefined, '').ok, '空值視為不設');
  assert.match(E.normalizeStops(1, 1.1, 1.2, null).error, /做多的止損價要低於現價/);
  assert.match(E.normalizeStops(1, 1.1, null, 1.05).error, /做多的止盈價要高於現價/);
  assert.match(E.normalizeStops(-1, 1.1, 1.0, null).error, /做空的止損價要高於現價/);
  assert.match(E.normalizeStops(-1, 1.1, null, 1.2).error, /做空的止盈價要低於現價/);
  for (const bad of [0, -1, NaN, Infinity, '1.0', 1e13]) assert.equal(E.normalizeStops(1, 1.1, bad, null).ok, false);
});

test('止損止盈：觸發判斷', () => {
  const long = { side: 1, sl: 1.0, tp: 1.2 }, short = { side: -1, sl: 1.2, tp: 1.0 };
  assert.equal(E.stopHit(long, 1.1), null);
  assert.equal(E.stopHit(long, 1.0), 'sl'); assert.equal(E.stopHit(long, 0.9), 'sl');
  assert.equal(E.stopHit(long, 1.2), 'tp'); assert.equal(E.stopHit(long, 1.3), 'tp');
  assert.equal(E.stopHit(short, 1.2), 'sl'); assert.equal(E.stopHit(short, 1.0), 'tp');
  assert.equal(E.stopHit({ side: 1 }, 0.1), null, '沒設就不觸發');
});

test('訪客本機：開倉帶止損止盈、觸發平倉、強平優先', () => {
  const s = E.createAccount(10000);
  const bad = E.openPosition(s, { [pair]: 1.1 }, { pair, side: 1, leverage: 2, notional: 1000, time: 1, sl: 1.15 });
  assert.equal(bad.ok, false); assert.equal(s.positions.length, 0, '止損不合理就不開倉、不收手續費');
  assert.equal(s.cash, 10000);
  const r = E.openPosition(s, { [pair]: 1.1 }, { pair, side: 1, leverage: 2, notional: 1000, time: 1, sl: 1.09, tp: 1.12 });
  assert.ok(r.ok); assert.equal(r.position.sl, 1.09); assert.equal(r.position.tp, 1.12);
  assert.deepEqual(E.settleTick(s, { [pair]: 1.1 }, 2), []);
  const ev = E.settleTick(s, { [pair]: 1.125 }, 3);
  assert.equal(ev[0].type, 'stop'); assert.equal(ev[0].kind, 'tp'); assert.ok(ev[0].pnl > 0);
  assert.equal(s.positions.length, 0); assert.equal(s.log.at(-1).reason, 'take_profit');
  // 高槓桿：強平價比止損價近，同一根同時越過兩條線 → 強平（強平線先觸及）
  const h = E.openPosition(s, { [pair]: 1.1 }, { pair, side: 1, leverage: 100, notional: 10000, time: 4, sl: 1.0 });
  assert.ok(h.ok);
  const ev2 = E.settleTick(s, { [pair]: 0.99 }, 5);
  assert.deepEqual(ev2.map(e => e.type), ['liquidated']); assert.equal(s.log.at(-1).reason, 'liquidated');
});

test('修改與清除止損止盈', () => {
  const s = E.createAccount(10000);
  const { position } = E.openPosition(s, { [pair]: 1.1 }, { pair, side: -1, leverage: 2, notional: 1000, time: 1 });
  assert.equal(position.sl, undefined);
  assert.ok(E.setStops(s, position.id, 1.1, 1.15, 1.05, 2).ok);
  assert.equal(position.sl, 1.15); assert.equal(position.tp, 1.05);
  assert.equal(E.setStops(s, position.id, 1.1, 1.05, null, 3).ok, false, '做空止損不能低於現價');
  assert.equal(position.sl, 1.15, '失敗不改原值');
  assert.ok(E.setStops(s, position.id, 1.1, null, null, 4).ok);
  assert.ok(!('sl' in position) && !('tp' in position), '清除後不留欄位');
  assert.equal(E.setStops(s, 999, 1.1, null, null, 5).ok, false);
});

// ---------- 伺服器：共同行情逐根結算 ----------
function firstCrossing(side, entryTick, kind) {
  // 從開倉價往後找第一根讓價格移動 0.01% 以上的 tick，設成止損/止盈門檻
  const p0 = sharedPrice(secret, entryTick, pair);
  for (let k = 1; k < 4000; k++) {
    const p = sharedPrice(secret, entryTick + k, pair), move = (p - p0) / p0;
    if (Math.abs(move) > 0.0001) return { k, p0, p, up: move > 0 };
  }
  throw new Error('no move');
}

test('伺服器：止損止盈在歷史 tick 觸發，以該根價格平倉並記錄原因', () => {
  const g = newGame(start, secret), t0 = absoluteTick(start);
  const { k, p0, p, up } = firstCrossing(1, t0);
  // 做多：價格往上走就設止盈在路徑上；往下走就設止損在路徑上
  const level = (p0 + p) / 2;
  const pos = openOrder(g, { pair, side: 1, leverage: 2, margin: 100, ...(up ? { tp: level } : { sl: level }) }, start, secret);
  const r = advance(g, start + (k + 5) * TICK_MS, secret);
  const ev = r.events.find(e => e.type === 'stop');
  assert.ok(ev, '要有止損止盈事件');
  assert.equal(ev.kind, up ? 'tp' : 'sl'); assert.equal(ev.id, pos.id);
  assert.equal(ev.step, t0 + k, '在第一個越過門檻的 tick 觸發，不是在現在');
  assert.equal(g.account.positions.length, 0);
  const log = g.account.log.at(-1);
  assert.equal(log.reason, up ? 'take_profit' : 'stop_loss');
  assert.equal(g.progress.stats.liquidations, 0, '止損止盈不算強平');
  assert.equal(g.progress.stats.manualCloses, 1);
  const v = view(g, -1, r.events, start + (k + 5) * TICK_MS, secret);
  assert.ok(v.events.some(e => e.type === 'stop'), '事件要回傳給前端');
});

test('伺服器：開倉時止損止盈以中間價驗證；修改止損止盈', () => {
  const g = newGame(start, secret), mid = sharedPrice(secret, absoluteTick(start), pair);
  assert.throws(() => openOrder(g, { pair, side: 1, leverage: 2, margin: 100, sl: mid * 1.01 }, start, secret), /止損價要低於現價/);
  assert.equal(g.account.positions.length, 0);
  const pos = openOrder(g, { pair, side: 1, leverage: 2, margin: 100, sl: mid * 0.99, tp: mid * 1.01 }, start, secret);
  assert.equal(pos.sl, mid * 0.99);
  const r = setPositionStops(g, pos.id, mid * 0.98, null, start, secret);
  assert.equal(r.sl, mid * 0.98); assert.equal(pos.tp, undefined);
  assert.throws(() => setPositionStops(g, pos.id, mid * 1.5, null, start, secret), /止損價要低於現價/);
  assert.throws(() => setPositionStops(g, 999, null, null, start, secret), /找不到持倉/);
});

test('舊持倉沒有 sl/tp 欄位照常結算', () => {
  const g = newGame(start, secret);
  openOrder(g, { pair, side: 1, leverage: 2, margin: 100 }, start, secret);
  const r = advance(g, start + 50 * TICK_MS, secret);
  assert.ok(!r.events.some(e => e.type === 'stop'));
  assert.equal(g.account.positions.length, 1);
});

// ---------- API 端對端 ----------
test('API：開倉帶止損止盈、/api/game/stops 修改、錯誤回 400', async () => {
  const ORIGIN = 'https://easonlai96.github.io';
  const realNow = Date.now; let clock = start + 10_000_000; Date.now = () => clock;
  try {
    const env = { DB: createD1(new URL('../migrations', import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN, SHARED_MARKET_SECRET: secret };
    const call = async (method, path, body, token) => {
      const headers = { Origin: ORIGIN, 'CF-Connecting-IP': '7.7.7.7' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await worker.fetch(new Request('https://api.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const { token } = (await call('POST', '/api/register', { username: 'stopper', password: '12345678' })).body;
    const g = await call('GET', '/api/game?since=-1', undefined, token);
    const mid = g.body.prices[pair];
    const bad = await call('POST', '/api/game/open', { pair, side: -1, leverage: 2, margin: 100, sl: mid * 0.9 }, token);
    assert.equal(bad.status, 400); assert.match(bad.body.message, /做空的止損價要高於現價/);
    const ok = await call('POST', '/api/game/open', { pair, side: -1, leverage: 2, margin: 100, sl: mid * 1.05, tp: mid * 0.95 }, token);
    assert.equal(ok.status, 200);
    const pos = ok.body.result.opened;
    assert.equal(pos.sl, mid * 1.05); assert.equal(pos.tp, mid * 0.95);
    const upd = await call('POST', '/api/game/stops', { id: pos.id, sl: null, tp: mid * 0.97 }, token);
    assert.equal(upd.status, 200);
    const p2 = upd.body.account.positions.find(p => p.id === pos.id);
    assert.equal(p2.sl, undefined); assert.equal(p2.tp, mid * 0.97);
    const badUpd = await call('POST', '/api/game/stops', { id: pos.id, sl: 'abc' }, token);
    assert.equal(badUpd.status, 400);
  } finally { Date.now = realNow; }
});
