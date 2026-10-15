import test from "node:test";
import assert from "node:assert/strict";
import * as E from "../../engine.mjs";
import worker from "../src/index.js";
import { createD1 } from "./d1shim.mjs";

// localStorage shim（成就冊、戰役存檔用）
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { createAchievementBook, ACHIEVEMENTS, NEVER_SELL_MS } = await import("../../achievements.mjs");
const { BATTLES, createBattleMarket, startIndex } = await import("../../battle.mjs");

const T = 1_800_000_000_000;
function opened(pair = "EUR/USD", side = 1, lev = 10, margin = 1000) {
  const s = E.createAccount(10000), px = { [pair]: 1 };
  const r = E.openPosition(s, px, { pair, side, leverage: lev, notional: margin * lev, time: T });
  return { s, pos: r.position };
}

test("補保證金：佔用可用餘額、推遠強平價、不夠時拒絕", () => {
  const { s, pos } = opened();
  const before = E.liquidationPrice(pos);
  const r = E.addMargin(s, { "EUR/USD": 1 }, pos.id, 1000, T);
  assert.ok(r.ok); assert.equal(pos.margin, 2000);
  assert.ok(E.liquidationPrice(pos) < before, "做多補倉後強平價應下移");
  assert.ok(Math.abs(E.liquidationPrice(pos) - (1 - 0.8 * 2000 / 10000)) < 1e-12);
  assert.equal(E.addMargin(s, { "EUR/USD": 1 }, pos.id, 1e6, T).ok, false);
  assert.equal(E.addMargin(s, { "EUR/USD": 1 }, 999, 10, T).ok, false);
  assert.equal(E.addMargin(s, { "EUR/USD": 1 }, pos.id, 0.5, T).ok, false);
});

test("借款補倉：建立借款、加進該倉保證金、標記 borrowed；強平事件與紀錄帶旗標", () => {
  const { s, pos } = opened();
  const cash = s.cash;
  const r = E.borrowToMargin(s, { "EUR/USD": 1 }, pos.id, 5000, T);
  assert.ok(r.ok); assert.equal(pos.margin, 6000); assert.equal(pos.borrowed, true);
  assert.equal(E.loanOwed(s), 5000); assert.equal(s.cash, cash + 5000);
  assert.equal(E.borrowToMargin(s, { "EUR/USD": 1 }, pos.id, 1, T).ok, false, "有借款不能再借");
  const ev = E.settleTick(s, { "EUR/USD": E.liquidationPrice(pos) - 0.001 }, T + 1);
  const liq = ev.find(e => e.type === "liquidated");
  assert.ok(liq && liq.borrowed === true && liq.refused === false);
  assert.equal(s.log.at(-1).borrowed, true);
});

test("暫不處理標記會帶進強平事件", () => {
  const { s, pos } = opened("USD/JPY", -1, 50, 200);
  pos.refusedHelp = true;
  const ev = E.settleTick(s, { "USD/JPY": E.liquidationPrice(pos) * 1.001 }, T + 1);
  assert.equal(ev.find(e => e.type === "liquidated").refused, true);
  assert.equal(s.log.at(-1).refused, true);
});

test("未補倉時強平價與舊公式一致", () => {
  for (const pair of ["EUR/USD", "USD/JPY"]) for (const side of [1, -1]) {
    const { pos } = opened(pair, side, 50, 300);
    const k = E.LIQ_LOSS / 50;
    const old = pair.startsWith("USD/") ? pos.entry / (1 + side * k) : pos.entry * (1 - side * k);
    assert.ok(Math.abs(E.liquidationPrice(pos) - old) < 1e-12);
  }
});

test("成就冊：12 個、各判定、只解鎖一次、依身分分開保存", () => {
  mem.clear();
  const got = [];
  const book = createAchievementBook({ onUnlock: d => got.push(d.id) });
  assert.equal(ACHIEVEMENTS.length, 12); assert.equal(book.count(), 0);
  book.checkAccount({ netWorth: 110000, startingCash: 10000 });
  assert.ok(book.has("fx-simple") && !book.has("sure-win"));
  book.checkAccount({ netWorth: -90000, startingCash: 10000, loanPrincipal: 100000 });
  assert.ok(book.has("rooftop") && book.has("sorry-family"));
  book.checkAccount({ netWorth: 1010000, startingCash: 10000 }); assert.ok(book.has("sure-win"));
  const candles = Array.from({ length: 50 }, (_, i) => ({ h: 1 + i * 0.001 }));
  book.checkOpen({ side: -1, entry: 1.049, candles }); assert.ok(!book.has("buy-top"));
  book.checkOpen({ side: 1, entry: 1.02, candles }); assert.ok(!book.has("buy-top"));
  book.checkOpen({ side: 1, entry: 1.047, candles }); assert.ok(book.has("buy-top"));
  book.checkClose({ pnl: -1 }); assert.ok(!book.has("honest-work"));
  book.checkClose({ pnl: 0.01 }); assert.ok(book.has("honest-work"));
  book.checkLiquidation({ borrowed: false, refused: false });
  assert.ok(book.has("innocent-cat") && !book.has("finger-support") && !book.has("just-kill-me"));
  book.checkLiquidation({ borrowed: true, refused: true });
  assert.ok(book.has("finger-support") && book.has("just-kill-me"));
  // 浮虧計時：轉正會中斷累計？不會，累計的是浮虧時間；平倉後清除
  const pos = { id: 1 }; let pnl = -1;
  for (let ms = 0; ms < NEVER_SELL_MS - 1500; ms += 1500) book.trackLosses("guest", [pos], () => pnl, { ms: 1500 });
  assert.ok(!book.has("never-sell"));
  pnl = 5; book.trackLosses("guest", [pos], () => pnl, { ms: 1500 }); assert.ok(!book.has("never-sell"), "賺錢時不計時");
  pnl = -1; book.trackLosses("guest", [pos], () => pnl, { ms: 1500 }); assert.ok(book.has("never-sell"));
  book.unlock("killed-by-chf"); book.unlock("thanks-meow");
  assert.equal(book.count(), 12);
  assert.equal(new Set(got).size, 12, "每個只觸發一次 onUnlock");
  book.unlock("fx-simple"); assert.equal(got.length, 12);
  book.setOwner("user:alice"); assert.equal(book.count(), 0, "其他身分分開保存");
  book.setOwner("guest"); assert.equal(book.count(), 12, "重新載入後仍在");
});

test("戰役回放天數：15 個交易日浮虧", () => {
  mem.clear();
  const book = createAchievementBook();
  for (let d = 0; d < 14; d++) book.trackLosses("battle:x", [{ id: 3 }], () => -1, { days: 1 });
  assert.ok(!book.has("never-sell"));
  book.trackLosses("battle:x", [{ id: 3 }], () => -1, { days: 1 });
  assert.ok(book.has("never-sell"));
});

test("經典戰役：資料完整、瑞郎事件日 USD/CHF 暴跌、推進到底", () => {
  for (const b of BATTLES) {
    const m = createBattleMarket(b.id);
    assert.ok(startIndex(b.id) >= 40, `${b.id} 要有足夠的暖身 K 線`);
    assert.ok(m.date() >= b.start);
    for (const p of m.pairs()) assert.ok(m.get(p) > 0, `${b.id} ${p}`);
    assert.ok(m.dates().includes(b.event) || m.dates().some(d => d > b.event));
    let n = 0; while (!m.atEnd()) { m.next(); n++; } assert.ok(n > 20);
    assert.equal(m.news().length, b.news.length);
  }
  const m = createBattleMarket("franc-2015");
  while (m.date() < "2015-01-15") m.next();
  assert.equal(m.date(), "2015-01-15");
  const c = m.candles("USD/CHF").at(-1);
  assert.ok(c.c / c.o < 0.9, "瑞郎脫鉤當天 USD/CHF 跌超過 10%");
});

/* ---------- API ---------- */
const ORIGIN = "https://easonlai96.github.io";
let clock = T;
function setup() {
  Date.now = () => clock;
  const env = { DB: createD1(new URL("../migrations", import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN, SHARED_MARKET_SECRET: "0123456789abcdef".repeat(4) };
  return async (method, path, body, token) => {
    const headers = { Origin: ORIGIN, "CF-Connecting-IP": "8.8.8.8" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const res = await worker.fetch(new Request("https://api.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

test("API：補保證金 / 借款補倉 / 暫不處理", async () => {
  const call = setup();
  const { token } = (await call("POST", "/api/register", { username: "rescue1", password: "12345678" })).body;
  const g0 = await call("GET", "/api/game?since=-1", undefined, token);
  const o = await call("POST", "/api/game/open", { pair: "EUR/USD", side: 1, leverage: 10, margin: 500, requestId: "o1", since: g0.body.step }, token);
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const id = o.body.result.opened.id;

  const a = await call("POST", "/api/game/margin", { id, amount: 300, source: "cash", requestId: "m1", since: o.body.step }, token);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.account.positions[0].margin, 800);
  assert.equal(a.body.account.loanOwed, 0);

  const l = await call("POST", "/api/game/margin", { id, amount: 100000, source: "loan", requestId: "m2", since: a.body.step }, token);
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.equal(l.body.account.positions[0].margin, 100800);
  assert.equal(l.body.account.positions[0].borrowed, true);
  assert.equal(l.body.account.loanOwed, 100000);
  assert.equal(l.body.result.margin.amount, 100000);

  const again = await call("POST", "/api/game/margin", { id, amount: 1, source: "loan", requestId: "m3" }, token);
  assert.equal(again.status, 400, "有借款時不能借款補倉");
  const replay = await call("POST", "/api/game/margin", { id, amount: 100000, source: "loan", requestId: "m2" }, token);
  assert.equal(replay.status, 200); assert.equal(replay.body.account.loanOwed, 100000, "相同 requestId 不重複借");

  assert.equal((await call("POST", "/api/game/margin", { id, amount: 1e9, source: "cash", requestId: "m4" }, token)).status, 400);
  assert.equal((await call("POST", "/api/game/margin", { id, amount: 10, source: "magic", requestId: "m5" }, token)).status, 400);
  assert.equal((await call("POST", "/api/game/margin", { id: "1", amount: 10, source: "cash", requestId: "m6" }, token)).status, 400);
  assert.equal((await call("POST", "/api/game/margin", { id: 999, amount: 10, source: "cash", requestId: "m7" }, token)).status, 400);

  const r = await call("POST", "/api/game/refuse-help", { id, requestId: "r1" }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.positions[0].refusedHelp, true);
  assert.equal((await call("POST", "/api/game/refuse-help", { id: 999, requestId: "r2" }, token)).status, 400);
  assert.equal((await call("POST", "/api/game/refuse-help", { id, requestId: "r3" })).status, 401);
});
