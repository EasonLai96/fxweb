// 伺服器端完整流程：暫不處理／借款補倉 → 共同行情推進到強平 → 平倉紀錄與事件帶 refused / borrowed。
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createD1 } from "./d1shim.mjs";

const ORIGIN = "https://easonlai96.github.io";
const START = 1_800_000_000_000;
let clock = START;
Date.now = () => clock;
const env = { DB: createD1(new URL("../migrations", import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN, SHARED_MARKET_SECRET: "0123456789abcdef".repeat(4) };
async function call(method, path, body, token) {
  const headers = { Origin: ORIGIN, "CF-Connecting-IP": "8.8.4.4" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  const res = await worker.fetch(new Request("https://api.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 開多空各一筆 100x：行情只要走一個方向，其中一筆就會先被強平。
async function runUntilLiquidation(token, flag) {
  let g = await call("GET", "/api/game?since=-1", undefined, token);
  const ids = [];
  for (const side of [1, -1]) {
    const o = await call("POST", "/api/game/open", { pair: "EUR/USD", side, leverage: 100, margin: 200, requestId: `o${flag}${side}`, since: g.body.step }, token);
    assert.equal(o.status, 200, JSON.stringify(o.body));
    ids.push(o.body.result.opened.id); g = o;
  }
  // 兩筆都標記：refuse 或 borrow（借款補倉只能借一次，借給第一筆）
  if (flag === "refuse") {
    for (const id of ids) assert.equal((await call("POST", "/api/game/refuse-help", { id, requestId: `r${id}` }, token)).status, 200);
  } else {
    const m = await call("POST", "/api/game/margin", { id: ids[0], amount: 1, source: "loan", requestId: "b1" }, token);
    assert.equal(m.status, 200, JSON.stringify(m.body));
    const m2 = await call("POST", "/api/game/margin", { id: ids[1], amount: 1, source: "cash", requestId: "c1" }, token);
    assert.equal(m2.status, 200);
  }
  const events = [];
  for (let i = 0; i < 400; i++) {
    clock += 1500 * 5;
    const s = await call("GET", "/api/game?since=-1", undefined, token);
    assert.equal(s.status, 200);
    events.push(...(s.body.events || []).filter(e => e.type === "liquidated"));
    const closes = s.body.account.log.filter(l => l.type === "close" && l.reason === "liquidated");
    if (closes.length) return { closes, events, ids };
  }
  throw new Error("行情推進 400 次都沒有強平");
}

test("伺服器：選了暫不處理的倉位被強平時，平倉紀錄與事件帶 refused", async () => {
  const { token } = (await call("POST", "/api/register", { username: "liqrefuse", password: "12345678" })).body;
  const { closes, events } = await runUntilLiquidation(token, "refuse");
  assert.ok(closes.every(c => c.refused === true), JSON.stringify(closes));
  assert.ok(events.length && events.every(e => e.refused === true), JSON.stringify(events));
});

test("伺服器：借款補倉過的倉位被強平時帶 borrowed，沒借過的不帶", async () => {
  const { token } = (await call("POST", "/api/register", { username: "liqborrow", password: "12345678" })).body;
  let all = [];
  let r = await runUntilLiquidation(token, "borrow");
  all.push(...r.closes);
  // 等另一筆也爆（或最多再推進一段）
  for (let i = 0; i < 400 && all.length < 2; i++) {
    clock += 1500 * 5;
    const s = await call("GET", "/api/game?since=-1", undefined, token);
    all = s.body.account.log.filter(l => l.type === "close" && l.reason === "liquidated");
    if (!s.body.account.positions.length) break;
  }
  for (const c of all) assert.equal(!!c.borrowed, c.id === r.ids[0], `#${c.id} borrowed 旗標錯誤：${JSON.stringify(c)}`);
});
