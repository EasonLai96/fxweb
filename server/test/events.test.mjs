import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../engine.mjs';
import { PAIRS, CRYPTO_KEYS, FX_KEYS, EVENT_TYPES, pickEvent, eventShape, EVENT_SPAN, priceDigits, createMarket, createMarketState, stepMarket, makeRng } from '../../market.mjs';
import { makeSharedMarket, sharedPricer, EVENT_START, EVENT_BUCKET, WHALE_START, WHALE_CAPITAL, RISE_SOFTEN_START, RISE_SOFTEN_FACTOR } from '../src/shared-market.js';
import { newGame, advance, openOrder, TICK_MS } from '../src/game.js';

const secret = '77'.repeat(32);
const findEvents = (from, to) => {
  const out = [];
  for (let t = from; t <= to; t += 1999) for (const n of makeSharedMarket(secret, Math.min(to, t + 1998), { history: 1 }).news) if (n.event && !out.some(e => e.step === n.step)) out.push(n);
  return out;
};

test('虛擬幣：四檔、小數位數', () => {
  assert.deepEqual(CRYPTO_KEYS, ['BTC', 'ETH', 'SOL', 'DOGE']);
  assert.equal(priceDigits('BTC'), 1); assert.equal(priceDigits('DOGE'), 4);
  assert.equal(E.isUsdBase('BTC'), false);
});

test('pickEvent：每種事件都抽得到、漲跌方向與範圍正確', () => {
  const r = makeRng(1), seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const ev = pickEvent(r);
    seen.add(ev.id);
    const def = EVENT_TYPES.find(t => t.id === ev.id);
    for (const [p, m] of Object.entries(ev.moves)) { assert.ok(Object.hasOwn(PAIRS, p)); assert.ok(m > -0.8 && m < 1.6, `${ev.id} ${p} ${m}`); }
    if (!def.hits.some(h => h[3])) assert.equal(Math.sign(ev.moves[ev.pair]), ev.claimed);
  }
  assert.equal(seen.size, EVENT_TYPES.length);
  // 舊行情只有外匯：事件只會影響存在的商品
  for (let i = 0; i < 500; i++) { const ev = pickEvent(r, FX_KEYS); if (ev) assert.ok(Object.keys(ev.moves).every(p => FX_KEYS.includes(p))); }
});

test('外匯不被重大事件改寫：開始後一年的黃金對照報價不變', () => {
  const at = sharedPricer(secret);
  // 由舊版（5d1f62b）的純外匯公式算出，改版事件不應改寫它們。
  const historical = { 'EUR/USD': 1.0870474973570807, 'AUD/USD': 0.659758067234897, 'USD/JPY': 149.8237980364051 };
  for (const [pair, oldPrice] of Object.entries(historical)) {
    const anchor = at(RISE_SOFTEN_START, pair);
    const expected = oldPrice > anchor ? anchor + (oldPrice-anchor)*RISE_SOFTEN_FACTOR : oldPrice;
    assert.equal(at(EVENT_START + 2500, pair), expected);
  }
  for (const e of findEvents(EVENT_START, EVENT_START + 57600))
    if (e.event !== 'whale-sweep') assert.ok(!Object.keys(e.moves).some(p => FX_KEYS.includes(p)), `舊事件不可改寫外匯`);
});

test('大戶掃盤：資金高於舊榜首、尚未開始時無訊號，開始後短暫洗價且不洩漏未來', () => {
  assert.ok(WHALE_CAPITAL > 1.3e15);
  assert.equal(findEvents(WHALE_START - 1000, WHALE_START - 1).filter(e => e.event === 'whale-sweep').length, 0);
  const e = findEvents(WHALE_START, WHALE_START + 57600).find(n => n.event === 'whale-sweep');
  assert.ok(e && FX_KEYS.includes(e.pair));
  assert.ok(!makeSharedMarket(secret,e.step-1,{history:1}).news.some(n=>n.event==='whale-sweep'&&n.step===e.step));
  const at=sharedPricer(secret);
  assert.ok(Math.abs(at(e.step,e.pair)/at(e.step-1,e.pair)-1) > .004);
  assert.ok(Math.abs(Math.log(at(e.step+100,e.pair)/at(e.step+99,e.pair))) < .01);
  // 反方向的散戶開 100× 空單，先被提醒，下一根可能被洗出場。
  if (e.moves[e.pair] > 0) {
    const openedAt=(e.step-1)*TICK_MS,g=newGame(openedAt,secret);
    openOrder(g,{pair:e.pair,side:-1,leverage:100,margin:1000},openedAt,secret);
    const r=advance(g,(e.step+2)*TICK_MS,secret);
    assert.ok(r.events.some(v=>v.type==='liquidated'&&v.pair===e.pair));
  }
});

test('事件形狀：瞬間跳到底、維持、再回到 0', () => {
  assert.equal(eventShape(-1), 0); assert.equal(eventShape(0), 0.6); assert.equal(eventShape(2), 1); assert.equal(eventShape(39), 1);
  assert.ok(eventShape(300) > 0 && eventShape(300) < 1); assert.equal(eventShape(EVENT_SPAN), 0);
});

test('共用行情：事件開始前的價格完全不變；之後約每 11 分鐘一次', () => {
  const at = sharedPricer(secret);
  // EVENT_START 之前沒有任何事件
  assert.equal(findEvents(EVENT_START - 4000, EVENT_START - 1).length, 0);
  const evs = findEvents(EVENT_START, EVENT_START + 57600);   // 一天
  const perMin = 24 * 60 / evs.length;
  assert.ok(perMin > 6 && perMin < 20, `平均 ${perMin.toFixed(1)} 分鐘一次`);
  // 事件當根跳空方向正確、幅度接近 6 成
  for (const e of evs.slice(0, 20)) {
    const p = e.pair, m = e.moves[p], jump = at(e.step, p) / at(e.step - 1, p) - 1;
    assert.equal(Math.sign(jump), Math.sign(m), e.text);
    assert.ok(Math.abs(Math.log(1 + jump)) > Math.abs(Math.log(1 + m)) * 0.45, `${e.text} 跳 ${jump}`);
  }
});

test('事件不洩漏未來：還沒發生的事件不會出現在行情裡', () => {
  const evs = findEvents(EVENT_START, EVENT_START + 20000), e = evs[3];
  const before = makeSharedMarket(secret, e.step - 1, { history: 50 });
  assert.ok(!before.news.some(n => n.event && n.step === e.step));
  const at = makeSharedMarket(secret, e.step, { since: e.step - 1 });
  assert.ok(at.news.some(n => n.event && n.step === e.step));
});

test('瞬間破產：100× 做多遇到崩盤，下一根就被強平，虧到保證金以上', () => {
  const evs = findEvents(EVENT_START, EVENT_START + 57600);
  const crash = evs.find(e => e.moves.BTC != null && e.moves.BTC < -0.2);
  assert.ok(crash, '找不到 BTC 崩盤事件');
  const t0 = (crash.step - 1) * TICK_MS, g = newGame(t0, secret);
  const pos = openOrder(g, { pair: 'BTC', side: 1, leverage: 100, margin: 1000 }, t0, secret);
  const r = advance(g, crash.step * TICK_MS, secret);
  const liq = r.events.find(e => e.type === 'liquidated' && e.id === pos.id);
  assert.ok(liq, '應被強平');
  const closed = g.account.log.find(l => l.type === 'close' && l.id === pos.id);
  assert.ok(closed.pnl < -1000 * 5, `跳空穿倉，虧損 ${closed.pnl}`);   // 跳 -20% 以上 × 100 倍 ≫ 保證金
});

test('瞬間致富：100× 做多遇到暴漲，一根 K 線賺好幾倍', () => {
  const evs = findEvents(EVENT_START, EVENT_START + 57600);
  const moon = evs.find(e => Object.entries(e.moves).some(([p, m]) => CRYPTO_KEYS.includes(p) && m > 0.2));
  const p = Object.entries(moon.moves).find(([q, m]) => CRYPTO_KEYS.includes(q) && m > 0.2)[0];
  const at = sharedPricer(secret), entry = at(moon.step - 1, p), now = at(moon.step, p);
  const pnl = E.unrealizedPnl({ pair: p, side: 1, notional: 100000, entry, units: 100000 / entry }, now);
  assert.ok(pnl > 1000 * 10, `$1000 保證金 100× 賺 ${pnl.toFixed(0)}`);
});

test('本機行情：舊存檔（沒有事件欄位）推進結果與改版前相同；新行情會出現事件', () => {
  const old = createMarketState(5); delete old.ev;
  const a = JSON.parse(JSON.stringify(old)), b = JSON.parse(JSON.stringify(old));
  for (let i = 0; i < 2000; i++) { const r = stepMarket(a); stepMarket(b); assert.equal(r.event, null); }
  assert.deepEqual(a, b);
  const m = createMarket(11); let n = 0;
  for (let i = 0; i < 6000; i++) if (m.tick().event) n++;
  assert.ok(n >= 8 && n <= 40, `6000 根 ${n} 次`);
});

test('舊訪客存檔保留 ETF 舊行情節奏，新建存檔改採較穩定波動', () => {
  const old = createMarketState(19, { warmup: 90 });
  delete old.etfStable;
  const fresh = createMarketState(19, { warmup: 90 });
  assert.equal(fresh.etfStable, 1);
  let changed = false;
  for (let i = 0; i < 200; i++) {
    stepMarket(old); stepMarket(fresh);
    if (old.prices.SPY !== fresh.prices.SPY) changed = true;
    assert.equal(old.prices['EUR/USD'], fresh.prices['EUR/USD']);
  }
  assert.ok(changed, '新建 ETF 行情應更穩定');
});

test('大額 MAX：浮點進位後仍不會超過可用保證金', () => {
  for (const free of [10, 10000, 1e9, 1e12, 1e14, 1e16, 1e18]) for (const lev of E.LEVERAGES) {
    const margin = E.maxAffordableMargin(free, lev), notional = margin * lev;
    assert.ok(notional / lev + E.feeFor(notional, lev) <= free, `${free} × ${lev}：餘額不足`);
  }
});

test('登入帳戶 MAX：依送單當刻的真實可用額度重算，多空均可下單', () => {
  const t0 = 1800000000000;
  for (const side of [1, -1]) for (const lev of [1, 5, 100]) {
    const g = newGame(t0, secret); g.account.cash = 1e14;
    // 模擬前端按 MAX 後到送單的時間差：舊顯示值已經超過即時餘額。
    const stale = 1e14;
    const pos = openOrder(g, { pair: 'BTC', side, leverage: lev, margin: stale, max: true }, t0, secret);
    assert.ok(pos.margin < stale);
    assert.equal(g.account.positions.length, 1);
    assert.ok(E.freeMargin(g.account, { BTC: pos.entry }) >= 0);
  }
  const g = newGame(t0, secret); g.account.cash = 9;
  assert.throws(() => openOrder(g, { pair: 'BTC', side: 1, leverage: 100, margin: 11, max: true }, t0, secret), /可用保證金不足/);
});

test('資產超過 10 億時仍可下單（以前會誤報「保證金至少 $10」）', () => {
  const t0 = Date.UTC(2026, 9, 16, 3, 0), g = newGame(t0, secret);
  g.account.cash = 5e9; g.account.startingCash = 10000;
  const pos = openOrder(g, { pair: 'EUR/USD', side: 1, leverage: 2, margin: 2e9 }, t0, secret);
  assert.equal(pos.margin, 2e9);
  assert.throws(() => openOrder(g, { pair: 'SPY', side: 1, leverage: 1, margin: 9e9 }, t0, secret), /可用保證金不足/);
  assert.throws(() => openOrder(g, { pair: 'SPY', side: 1, leverage: 1, margin: 5 }, t0, secret), /至少 \$10/);
  assert.throws(() => openOrder(g, { pair: 'SPY', side: 1, leverage: 1, margin: Infinity }, t0, secret), /金額無效/);
});
