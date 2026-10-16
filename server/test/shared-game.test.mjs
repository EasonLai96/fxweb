import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketState } from '../../market.mjs';
import { absoluteTick, sharedPrice } from '../src/shared-market.js';
import { EXECUTION_START, executionPrice } from '../src/execution.js';
import { newGame, ensureMarketMode, advance, openOrder, closeOrder, view, resetGame, TICK_MS, MAX_CATCHUP, MAX_HOLD_MS } from '../src/game.js';

const secret = 'ab'.repeat(32);
const start = 1800000000000;
const clone = value => JSON.parse(JSON.stringify(value));
const pair = 'EUR/USD';
const order = { pair, side: 1, leverage: 2, margin: 100 };

test('shared accounts store no personal market or global secret, candles show same head', () => {
  const a = newGame(start, secret), b = newGame(start, secret);
  assert.equal(a.market, undefined);
  assert.equal(a.cursor, absoluteTick(start));
  assert.ok(!JSON.stringify(a).includes(secret));
  openOrder(a, order, start, secret);
  const v = view(a, -1, [], start, secret), w = view(b, -1, [], start, secret);
  assert.equal(v.marketMode, 'shared');
  assert.deepEqual(v.candles, w.candles);
  assert.equal(v.prices[pair], w.prices[pair]);
  assert.equal(v.account.positions[0].midAtOpen, sharedPrice(secret, a.cursor, pair));
  assert.ok(v.account.positions[0].entry > v.account.positions[0].midAtOpen, '市價做多以 ask 成交');
  assert.equal(v.switchStatus, 'ready');
});

test('新規則只影響生效後新倉：方向價差、滑價、分批流動性、融資及舊倉不變', () => {
  const before = EXECUTION_START - TICK_MS, old = newGame(before, secret);
  const oldPos = openOrder(old, {pair, side:1, leverage:100, margin:100}, before, secret);
  assert.equal(oldPos.entry, sharedPrice(secret, absoluteTick(before), pair));
  assert.equal(oldPos.executionVersion, undefined);
  const t = EXECUTION_START + TICK_MS;
  const g = newGame(t, secret), mid = sharedPrice(secret, absoluteTick(t), pair);
  const long = openOrder(g, {pair, side:1, leverage:100, margin:100}, t, secret);
  const short = openOrder(g, {pair, side:-1, leverage:100, margin:100}, t, secret);
  assert.ok(long.entry > mid && short.entry < mid);
  assert.ok(executionPrice(mid, pair, 1, 1e8, t) > long.entry, '大單比小單成交較差');
  // 不設單筆最大金額：超大單仍可成交，只是滑價封頂 0.12%。
  const rich = newGame(t, secret); rich.account.cash = 1e15;
  const huge = openOrder(rich, {pair, side:1, leverage:100, margin:1e10}, t, secret);
  assert.ok(huge.notional === 1e12 && huge.entry <= mid * 1.0012 + 1e-12, '遠超舊上限仍可成交');
  const maxed = openOrder(rich, {pair, side:-1, leverage:100, margin:10, max:true}, t, secret);
  assert.ok(maxed.margin > 1e13, 'MAX 使用全部可用保證金，不再被單筆上限截斷');
  const later=t+TICK_MS;
  advance(g, later, secret);
  assert.ok(long.carryPaid>0 && short.carryPaid>0);
  const pnl=closeOrder(g,long.id,later,secret);
  assert.ok(g.account.log.at(-1).price < sharedPrice(secret,absoluteTick(later),pair), '多單以 bid 賣出');
  assert.ok(Number.isFinite(pnl));
  assert.ok(executionPrice(100,'BTC',1,1e6,t) > executionPrice(100,pair,1,1e6,t), '虛擬幣滑價大於外匯');
});

test('behind account values at cursor, but displays head tape separately and disallows trading', () => {
  const a = newGame(start, secret);
  openOrder(a, order, start, secret);
  const now = start + (MAX_CATCHUP + 23) * TICK_MS;
  const r = advance(a, now, secret), v = view(a, -1, [], now, secret);
  assert.equal(r.steps, MAX_CATCHUP);
  assert.equal(v.remainingTicks, 23);
  assert.equal(v.accountCursor, absoluteTick(start) + MAX_CATCHUP);
  assert.equal(v.headStep, absoluteTick(now));
  assert.equal(v.accountValuation.prices[pair], sharedPrice(secret, a.cursor, pair));
  assert.equal(v.headPrices[pair], sharedPrice(secret, absoluteTick(now), pair));
  assert.throws(() => closeOrder(a, 1, now, secret), /補算/);
  assert.throws(() => openOrder(a, order, now, secret), /補算/);
});

test('7-day shared expiry settles at historical tick, original entry and PnL, then skips unused backlog', () => {
  const a = newGame(start, secret), pos = openOrder(a, { ...order, leverage: 1 }, start, secret);
  // Checkpoint just before expiry; replay exactly the terminal tick with a months-ahead now.
  a.cursor = absoluteTick(start + MAX_HOLD_MS - TICK_MS);
  const t = start + MAX_HOLD_MS, now = t + 30 * 86400000;
  const r = advance(a, now, secret);
  assert.equal(r.steps, 1);
  assert.ok(r.fastForwarded > MAX_CATCHUP);
  assert.equal(r.pendingSteps, 0);
  assert.equal(a.cursor, absoluteTick(now));
  assert.equal(a.account.positions.length, 0);
  const last = a.account.log.at(-1);
  assert.equal(last.reason, 'expired');
  assert.equal(last.t, t);
  assert.ok(last.price < sharedPrice(secret, absoluteTick(t), pair), '買進倉位以 bid 平倉');
  assert.equal(a.account.cash, 10000 - pos.feePaid + last.pnl);
  assert.equal(r.events.at(-1).type, 'expired');
  assert.equal(a.progress.stats.closedTrades, 1);
});

test('expiry is no earlier than exact seven-day opening timestamp', () => {
  const opened = start + 321;
  const a = newGame(opened, secret);
  const pos = openOrder(a, { ...order, leverage: 1 }, opened, secret);
  a.cursor = absoluteTick(opened + MAX_HOLD_MS) - 1;
  assert.equal(advance(a, opened + MAX_HOLD_MS, secret).steps, 1);
  assert.equal(a.account.positions[0].id, pos.id);
  assert.equal(advance(a, opened + MAX_HOLD_MS + TICK_MS, secret).steps, 1);
  assert.equal(a.account.log.at(-1).reason, 'expired');
  assert.ok(a.account.log.at(-1).t >= opened + MAX_HOLD_MS);
});

test('legacy positions preserve private price and cannot open; cash and progress survive mode switch', () => {
  const a = newGame(start);
  a.market = createMarketState(undefined, { secret: 'cd'.repeat(32) });
  const pos = openOrder(a, order, start);
  const oldPrice = a.market.prices[pair];
  assert.equal(ensureMarketMode(a, start, secret), true);
  assert.equal(a.marketMode, 'legacy');
  assert.throws(() => openOrder(a, order, start, secret), /舊市場/);
  assert.equal(view(a, -1, [], start, secret).accountValuation.prices[pair], oldPrice);
  assert.equal(closeOrder(a, pos.id, start, secret), 0);
  const cash = a.account.cash, progress = clone(a.progress);
  assert.equal(ensureMarketMode(a, start + 100 * TICK_MS, secret), true);
  assert.equal(a.market, undefined);
  assert.equal(a.marketMode, 'shared');
  assert.equal(a.account.cash, cash);
  assert.deepEqual(a.progress, progress);
  assert.equal(a.seasonResetRequired, true);
  assert.ok(openOrder(a, order, start + 100 * TICK_MS, secret));
  assert.equal(a.seasonResetRequired, true);
  resetGame(a, start + 100 * TICK_MS, secret);
  assert.equal(a.seasonResetRequired, false);
  assert.ok(!JSON.stringify(a).includes('cd'.repeat(32)));
});

test('legacy offline risk advances only through last position, then may switch without replaying idle months', () => {
  const a = newGame(start);
  const pos = openOrder(a, order, start);
  ensureMarketMode(a, start, secret);
  pos.entry *= 5; // forcibly adverse, should liquidate at first historical tick
  const far = start + 90 * 86400000;
  const r = advance(a, far, secret);
  assert.equal(r.steps, 1);
  assert.ok(r.fastForwarded > 0);
  assert.equal(a.account.log.at(-1).reason, 'liquidated');
  assert.equal(a.account.log.at(-1).t, start + TICK_MS);
  assert.equal(ensureMarketMode(a, far, secret), true);
  assert.equal(a.marketMode, 'shared');
  assert.equal(a.market, undefined);
});

test('shared state rejects missing secret instead of silently switching to a private tape', () => {
  assert.throws(() => newGame(start, 'bad'), /secret/);
  const a = newGame(start, secret);
  assert.throws(() => advance(a, start + TICK_MS), /secret/);
  assert.throws(() => view(a, -1, [], start), /secret/);
});
