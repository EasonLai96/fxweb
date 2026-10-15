import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createD1 } from "./d1shim.mjs";
import { TICK_MS } from "../src/game.js";

// 端對端：經過真正的 Worker 路由 + D1，模擬瀏覽器的借款 / 等待 / 還款流程。
const ORIGIN = "https://easonlai96.github.io";
let clock = 1_800_000_000_000;
Date.now = () => clock;

function setup(shared) {
  const env = { DB: createD1(new URL("../migrations", import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN };
  if (shared) env.SHARED_MARKET_SECRET = "0123456789abcdef".repeat(4); else env.MARKET_TEST_ALLOW_LEGACY = true;
  const call = async (method, path, body, token) => {
    const headers = { Origin: ORIGIN, "CF-Connecting-IP": "9.9.9.9" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const res = await worker.fetch(new Request("https://api.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return call;
}

for (const shared of [true, false]) {
  test(`借款 → 經過時間 → 部分還 → 全還（${shared ? "共同行情" : "舊版行情"}）`, async () => {
    const call = setup(shared);
    const { token } = (await call("POST", "/api/register", { username: shared ? "loanS" : "loanL", password: "12345678" })).body;
    const g0 = await call("GET", "/api/game?since=-1", undefined, token);
    assert.equal(g0.status, 200);
    assert.equal(g0.body.account.loanOwed, 0);

    const b = await call("POST", "/api/game/borrow", { amount: 50000, since: g0.body.step, requestId: "b1" }, token);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.result.borrowed.amount, 50000);
    assert.equal(b.body.account.cash, 60000);
    assert.equal(b.body.account.loanOwed, 50000);

    const again = await call("POST", "/api/game/borrow", { amount: 1, since: b.body.step, requestId: "b2" }, token);
    assert.equal(again.status, 400, "有借款時不能再借");

    clock += 20 * TICK_MS;   // 一天
    const g1 = await call("GET", `/api/game?since=${b.body.step}`, undefined, token);
    assert.equal(g1.status, 200);
    assert.ok(Math.abs(g1.body.account.loanOwed - 50010) < 0.05, `一天利息應約 10，得到 ${g1.body.account.loanOwed}`);

    const p1 = await call("POST", "/api/game/repay", { amount: 20000, since: g1.body.step, requestId: "r1" }, token);
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.body.result.repaid.cleared, false);

    const owed = p1.body.account.loanOwed;
    const p2 = await call("POST", "/api/game/repay", { amount: owed, since: p1.body.step, requestId: "r2" }, token);
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(p2.body.result.repaid.cleared, true);
    assert.equal(p2.body.account.loanOwed, 0);
    assert.equal(p2.body.account.loan, null);

    const replay = await call("POST", "/api/game/repay", { amount: owed, since: p2.body.step, requestId: "r2" }, token);
    assert.equal(replay.status, 200, "相同 requestId 重送不重複扣款");
    assert.equal(replay.body.account.cash, p2.body.account.cash);
  });
}

test("借款金額非數字 / 未登入", async () => {
  const call = setup(true);
  assert.equal((await call("POST", "/api/game/borrow", { amount: 100 })).status, 401);
  const { token } = (await call("POST", "/api/register", { username: "loanX", password: "12345678" })).body;
  assert.equal((await call("POST", "/api/game/borrow", { amount: "100", requestId: "x" }, token)).status, 400);
  assert.equal((await call("POST", "/api/game/borrow", { amount: 200001, requestId: "y" }, token)).status, 400);
});
