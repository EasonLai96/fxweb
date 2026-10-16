import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../engine.mjs';
import { PAIRS, ETF_KEYS, FX_KEYS, isEtf, priceDigits, createMarketState, stepMarket } from '../../market.mjs';
import { makeSharedMarket, sharedPrice, ETF_SWITCH, EVENT_START } from '../src/shared-market.js';
import { newGame, advance, openOrder, closeOrder, view, TICK_MS } from '../src/game.js';

const secret = 'ef'.repeat(32);
const start = 1800000000000;

test('ETF 清單：四檔、排在外匯之後、小數兩位', () => {
  assert.deepEqual(ETF_KEYS, ['0050', '00878', 'SPY', 'QQQ']);
  assert.deepEqual(FX_KEYS, ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'USD/CAD']);
  assert.deepEqual(Object.keys(PAIRS).slice(6, 10), ETF_KEYS);
  for (const p of ETF_KEYS) { assert.ok(isEtf(p)); assert.equal(priceDigits(p), 2); assert.equal(E.isUsdBase(p), false); }
  assert.equal(priceDigits('USD/JPY'), 3); assert.equal(priceDigits('EUR/USD'), 4);
});

test('ETF 損益：漲 1% 做多賺名目的 1%（新台幣計價也直接以美元名目結算）', () => {
  for (const p of ETF_KEYS) {
    const a = E.createAccount(10000);
    const r = E.openPosition(a, { [p]: 100 }, { pair: p, side: 1, leverage: 10, notional: 5000, time: 0 });
    assert.ok(r.ok);
    assert.ok(Math.abs(E.unrealizedPnl(r.position, 101) - 50) < 1e-9);
    assert.ok(Math.abs(E.unrealizedPnl({ ...r.position, side: -1 }, 101) + 50) < 1e-9);
    assert.ok(Math.abs(E.liquidationPrice(r.position) - 92) < 1e-9);   // 10× 反向 8% 強平
  }
});

test('共用行情：ETF 有價格、K 線，波動比外匯大', () => {
  const head = 1_200_000, m = makeSharedMarket(secret, head);
  const spread = p => { const cs = m.candles[p]; return cs.reduce((s, c) => s + Math.abs(Math.log(c.c / c.o)), 0) / cs.length; };
  for (const p of ETF_KEYS) {
    assert.equal(m.candles[p].length, 160);
    assert.ok(m.prices[p] > PAIRS[p] * 0.8 && m.prices[p] < PAIRS[p] * 1.2);
    assert.ok(spread(p) > spread('EUR/USD'), `${p} 波動應大於 EUR/USD`);
  }
});

test('ETF 切換前報價不回溯改寫；切換後價格連續、波動接近真實日曆', () => {
  const key = '77'.repeat(32);
  const oldAtSwitch = { '0050': 52.20048960639996, '00878': 21.253364397703162,
    SPY: 654.6357608718295, QQQ: 614.5267492093564 };
  const DAY = 57600;
  for (const p of ETF_KEYS) {
    assert.equal(sharedPrice(key, ETF_SWITCH, p), oldAtSwitch[p]);
    const next = sharedPrice(key, ETF_SWITCH + 1, p);
    assert.ok(Math.abs(next / oldAtSwitch[p] - 1) < 0.001, `${p} 切換時不應跳空`);
    const at = t => sharedPrice(key, t, p);
    let worst = 0;
    for (let t = ETF_SWITCH + 1; t < ETF_SWITCH + 2400; t++)
      worst = Math.max(worst, Math.abs(Math.log(at(t) / at(t - 1))));
    assert.ok(worst < 0.002, `${p} 平常單根價格不應大幅跳空：${worst}`);
    const daily = [];
    for (let d = 0; d <= 365; d++) daily.push(Math.log(at(ETF_SWITCH + d * DAY)));
    const diffs = daily.slice(1).map((x, i) => x - daily[i]);
    const mean = diffs.reduce((a,b) => a+b, 0) / diffs.length;
    const annualVol = Math.sqrt(diffs.reduce((a,b) => a+(b-mean)**2,0) / diffs.length) * Math.sqrt(365);
    assert.ok(annualVol < 0.40, `${p} 年化波動不能像幣圈：${annualVol}`);
  }
  assert.ok(ETF_SWITCH * 1500 > Date.UTC(2026, 9, 16, 2, 0), '切換點須晚於改版上線時間');
  assert.ok(EVENT_START > ETF_SWITCH);
});

test('登入帳戶可交易 ETF：開倉、推進、平倉', () => {
  const g = newGame(start, secret);
  const pos = openOrder(g, { pair: 'QQQ', side: 1, leverage: 5, margin: 1000 }, start, secret);
  assert.equal(pos.pair, 'QQQ');
  const later = start + 20 * TICK_MS;
  advance(g, later, secret);
  const pnl = closeOrder(g, pos.id, later, secret);
  const oldMid = sharedPrice(secret, Math.floor(later / TICK_MS), 'QQQ');
  assert.ok(g.account.log.at(-1).price < oldMid, '新倉做多按 bid 成交，不能免費平倉');
  const expect = (g.account.log.at(-1).price / pos.entry - 1) * pos.notional;
  assert.ok(Math.abs(pnl - expect) < 1e-6);
  assert.throws(() => openOrder(g, { pair: 'TSLA', side: 1, leverage: 5, margin: 100 }, later, secret), /不支援/);
});

test('舊私有行情（加入 ETF 前建立）仍只有外匯，view 不會因缺 ETF 而出錯', () => {
  const fxOnly = createMarketState(undefined, { secret: 'aa'.repeat(32) });
  for (const p of Object.keys(PAIRS).filter(q => !FX_KEYS.includes(q))) { delete fxOnly.prices[p]; delete fxOnly.candles[p]; delete fxOnly.phase[p]; delete fxOnly.bias[p]; }
  const g = newGame(start); g.market = fxOnly; g.lastStepAt = start;
  stepMarket(g.market);
  assert.deepEqual(Object.keys(g.market.prices), FX_KEYS);
  const v = view(g, g.market.step - 1, [], start);
  assert.deepEqual(Object.keys(v.candles), FX_KEYS);
});
