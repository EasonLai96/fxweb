import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createD1 } from "./d1shim.mjs";
import { TICK_MS, MAX_CATCHUP } from "../src/game.js";

const ORIGIN = "https://easonlai96.github.io";
// 用假時鐘控制「經過時間」，測試行情推進與防作弊
let clock = 1_800_000_000_000;
Date.now = () => clock;
const wait = ms => { clock += ms; };

function setup() {
  const env = { DB: createD1(new URL("../migrations", import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN, MARKET_TEST_ALLOW_LEGACY: true };
  const call = async (method, path, { body, token, origin = ORIGIN, ip = "1.1.1.1" } = {}) => {
    const headers = { Origin: origin, "CF-Connecting-IP": ip };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const res = await worker.fetch(new Request("https://api.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const reg = async (username, password = "12345678", ip = "1.1.1.1") => (await call("POST", "/api/register", { body: { username, password }, ip })).body;
  return { env, call, reg };
}

/* ---------- 帳號 ---------- */
test("註冊回傳救援碼，登入不分大小寫", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/register", { body: { username: "Eason_1", password: "correct horse" } });
  assert.equal(r.status, 201); assert.ok(r.body.token);
  assert.match(r.body.recoveryCode, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
  const l = await call("POST", "/api/login", { body: { username: "eason_1", password: "correct horse" } });
  assert.equal(l.status, 200); assert.equal(l.body.recoveryCode, undefined, "登入不會再給救援碼");
  assert.equal((await call("GET", "/api/me", { token: l.body.token })).body.user.username, "Eason_1");
});

test("密碼與救援碼都不以明文儲存", async () => {
  const { env, reg } = setup();
  const { recoveryCode } = await reg("alice", "s3cret-pass");
  const row = env.DB.raw.prepare("SELECT * FROM users").get();
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes("s3cret-pass")); assert.ok(!dump.includes(recoveryCode.replace(/-/g, ""))); assert.ok(!dump.includes(recoveryCode));
});

test("重複帳號、格式錯誤", async () => {
  const { call, reg } = setup();
  await reg("bob");
  assert.equal((await call("POST", "/api/register", { body: { username: "BOB", password: "12345678" }, ip: "2.2.2.2" })).status, 409);
  assert.equal((await call("POST", "/api/register", { body: { username: "a", password: "12345678" } })).status, 400);
  assert.equal((await call("POST", "/api/register", { body: { username: "carol", password: "short" } })).status, 400);
});

test("錯誤密碼與不存在帳號回同一訊息；失敗 10 次鎖定", async () => {
  const { call, reg } = setup();
  await reg("dave");
  const a = await call("POST", "/api/login", { body: { username: "dave", password: "wrongpass" } });
  const b = await call("POST", "/api/login", { body: { username: "nobody", password: "wrongpass" } });
  assert.equal(a.body.message, b.body.message);
  for (let i = 0; i < 9; i++) await call("POST", "/api/login", { body: { username: "dave", password: "badbadbad" } });
  assert.equal((await call("POST", "/api/login", { body: { username: "dave", password: "12345678" } })).status, 429);
  assert.equal((await call("POST", "/api/login", { body: { username: "dave", password: "12345678" }, ip: "9.9.9.9" })).status, 200);
  wait(16 * 60 * 1000);
  assert.equal((await call("POST", "/api/login", { body: { username: "dave", password: "12345678" } })).status, 200, "15 分鐘後解鎖");
});

/* ---------- 忘記密碼 ---------- */
test("用救援碼重設密碼：舊密碼失效、舊登入全部登出、救援碼換新", async () => {
  const { call, reg } = setup();
  const { token: oldToken, recoveryCode } = await reg("frank", "old-password");
  const r = await call("POST", "/api/reset-password", { body: { username: "FRANK", recoveryCode: recoveryCode.toLowerCase().replace(/-/g, " "), newPassword: "new-password" } });
  assert.equal(r.status, 200, "救援碼不分大小寫、可省略連字號");
  assert.ok(r.body.token); assert.notEqual(r.body.recoveryCode, recoveryCode);
  assert.equal((await call("GET", "/api/me", { token: oldToken })).status, 401, "舊裝置被登出");
  assert.equal((await call("GET", "/api/me", { token: r.body.token })).status, 200);
  assert.equal((await call("POST", "/api/login", { body: { username: "frank", password: "old-password" } })).status, 401);
  assert.equal((await call("POST", "/api/login", { body: { username: "frank", password: "new-password" } })).status, 200);
  const again = await call("POST", "/api/reset-password", { body: { username: "frank", recoveryCode, newPassword: "another-pass" } });
  assert.equal(again.status, 401, "舊救援碼只能用一次");
});

test("錯誤救援碼：訊息一致、會被鎖定、換 IP 也有總上限", async () => {
  const { call, reg } = setup();
  await reg("gina");
  const bad = { username: "gina", recoveryCode: "2222-2222-2222-2222", newPassword: "whatever123" };
  const a = await call("POST", "/api/reset-password", { body: bad });
  const b = await call("POST", "/api/reset-password", { body: { ...bad, username: "ghost" } });
  assert.equal(a.status, 401); assert.equal(a.body.message, b.body.message);
  assert.equal((await call("POST", "/api/reset-password", { body: { ...bad, recoveryCode: "short" } })).status, 400);
  for (let i = 0; i < 9; i++) await call("POST", "/api/reset-password", { body: bad, ip: `5.5.5.${i}` });
  assert.equal((await call("POST", "/api/reset-password", { body: bad, ip: "7.7.7.7" })).status, 429, "同帳號跨 IP 總共 10 次");
});

test("登入後可重新產生救援碼（需要密碼）", async () => {
  const { call, reg } = setup();
  const { token, recoveryCode } = await reg("henry");
  assert.equal((await call("POST", "/api/recovery-code", { token, body: { password: "wrongpass" } })).status, 401);
  const r = await call("POST", "/api/recovery-code", { token, body: { password: "12345678" } });
  assert.equal(r.status, 200); assert.notEqual(r.body.recoveryCode, recoveryCode);
  assert.equal((await call("POST", "/api/reset-password", { body: { username: "henry", recoveryCode, newPassword: "xxxxxxxx" } })).status, 401, "舊碼作廢");
  assert.equal((await call("POST", "/api/reset-password", { body: { username: "henry", recoveryCode: r.body.recoveryCode, newPassword: "xxxxxxxx" } })).status, 200);
});

/* ---------- 遊戲：伺服器端計算 ---------- */
test("新遊戲：$10,000、外匯＋ETF＋虛擬幣共 14 檔、K 線、不洩漏亂數與新聞方向", async () => {
  const { call, reg } = setup();
  const { token } = await reg("ivy");
  const g = await call("GET", "/api/game", { token });
  assert.equal(g.status, 200);
  assert.equal(g.body.account.cash, 10000);
  assert.equal(Object.keys(g.body.prices).length, 14);
  assert.ok(g.body.prices.BTC > 0 && g.body.candles.DOGE.length > 50);
  assert.ok(g.body.candles["SPY"].length > 50 && g.body.prices["0050"] > 0);
  assert.ok(g.body.candles["EUR/USD"].length > 50);
  const text = JSON.stringify(g.body);
  assert.ok(!/"r":/.test(text) && !/"phase"/.test(text) && !/"bias"/.test(text), "不送出亂數狀態與新聞偏移");
  wait(TICK_MS * 400);
  const later = await call("GET", "/api/game", { token });
  for (const n of later.body.news) {
    if (!n.settled) assert.equal(n.reversed, null, "影響期間內不透露是否反向");
  }
});

test("行情依真實時間前進，不能快轉", async () => {
  const { call, reg } = setup();
  const { token } = await reg("jack");
  const s0 = (await call("GET", "/api/game", { token })).body.step;
  for (let i = 0; i < 20; i++) await call("GET", "/api/game", { token });
  assert.equal((await call("GET", "/api/game", { token })).body.step, s0, "狂刷也不會前進");
  wait(TICK_MS * 3 + 10);
  assert.equal((await call("GET", "/api/game", { token })).body.step, s0 + 3);
  wait(TICK_MS * 5000);
  // 只前進 3 根且沒有事件時不寫回資料庫（省寫入）；所以補算從上次寫入的 s0 起算，最多 MAX_CATCHUP 根。
  // 行情是確定性的，重算出的 K 線和剛才看到的一模一樣。
  assert.equal((await call("GET", "/api/game", { token })).body.step, s0 + MAX_CATCHUP, "離線太久最多補算上限");
});

test("開倉、平倉由伺服器計算；無法自己指定價格或現金", async () => {
  const { call, reg } = setup();
  const { token } = await reg("kate");
  const g0 = (await call("GET", "/api/game", { token })).body;
  const o = await call("POST", "/api/game/open", { token, body: { pair: "EUR/USD", side: 1, leverage: 5, margin: 1000, price: 0.0001, cash: 1e9, entry: 0.0001 } });
  assert.equal(o.status, 200);
  const pos = o.body.result.opened;
  assert.equal(pos.entry, g0.prices["EUR/USD"], "進場價是伺服器價格，忽略瀏覽器送來的 price");
  assert.equal(pos.notional, 5000);
  assert.ok(Math.abs(o.body.account.cash - (10000 - pos.feePaid)) < 1e-9);
  wait(TICK_MS * 20);
  const c = await call("POST", "/api/game/close", { token, body: { id: pos.id, price: 999, pnl: 1e9 } });
  assert.equal(c.status, 200);
  assert.ok(Math.abs(c.body.result.pnl) < 500, "損益由伺服器價格決定");
  assert.equal(c.body.account.positions.length, 0);
});

test("下單檢查：槓桿、保證金、貨幣對、方向、餘額", async () => {
  const { call, reg } = setup();
  const { token } = await reg("leo");
  const open = body => call("POST", "/api/game/open", { token, body: { pair: "EUR/USD", side: 1, leverage: 5, margin: 100, ...body } });
  for (const leverage of [0, 11, 49, 51, 99, 101, 2.5, "100"]) assert.equal((await open({ leverage })).status, 400);
  for (const leverage of [50, 100]) {
    const order = await open({ leverage, margin: 20 });
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.result.opened.leverage, leverage);
    assert.equal(order.body.result.opened.notional, leverage * 20);
  }
  assert.equal((await open({ margin: 5 })).status, 400);
  assert.equal((await open({ margin: "100" })).status, 400);
  assert.equal((await open({ margin: Infinity })).status, 400);
  assert.equal((await open({ pair: "BTC/USD" })).status, 400);
  assert.equal((await open({ pair: "__proto__" })).status, 400);
  assert.equal((await open({ side: 2 })).status, 400);
  const tooBig = await open({ margin: 20000 });
  assert.equal(tooBig.status, 400); assert.match(tooBig.body.message, /保證金不足/);
  assert.equal((await call("POST", "/api/game/close", { token, body: { id: 999 } })).status, 400);
});

test("強平在伺服器發生（即使玩家沒開網頁）", async () => {
  const { call, reg, env } = setup();
  const { token } = await reg("mia");
  await call("POST", "/api/game/open", { token, body: { pair: "GBP/USD", side: 1, leverage: 10, margin: 2000 } });
  // 直接把伺服器上的進場價改高，模擬行情大跌（測試用）
  const row = env.DB.raw.prepare("SELECT state FROM games").get();
  const g = JSON.parse(row.state); g.account.positions[0].entry *= 1.2; g.account.positions[0].units = g.account.positions[0].notional / g.account.positions[0].entry;
  env.DB.raw.prepare("UPDATE games SET state = ?").run(JSON.stringify(g));
  wait(TICK_MS * 2);
  const r = await call("GET", "/api/game", { token });
  assert.equal(r.body.account.positions.length, 0);
  assert.ok(r.body.events.some(e => e.type === "liquidated"));
  assert.ok(r.body.account.log.some(l => l.reason === "liquidated"));
});

test("增量更新：since 只回傳新 K 線", async () => {
  const { call, reg } = setup();
  const { token } = await reg("nina");
  const full = (await call("GET", "/api/game", { token })).body;
  assert.equal(full.full, true);
  wait(TICK_MS * 4);
  const inc = (await call("GET", `/api/game?since=${full.step}`, { token })).body;
  assert.equal(inc.full, false);
  assert.equal(inc.candles["EUR/USD"].length, 4);
  assert.equal(inc.candles["EUR/USD"][0].t, full.step + 1);
});

test("重新開始：回到 $10,000，行情不重置（不能靠重開找好行情）", async () => {
  const { call, reg } = setup();
  const { token } = await reg("oscar");
  await call("POST", "/api/game/open", { token, body: { pair: "EUR/USD", side: -1, leverage: 3, margin: 500 } });
  wait(TICK_MS * 10);
  const before = (await call("GET", "/api/game", { token })).body;
  const r = await call("POST", "/api/game/reset", { token, body: {} });
  assert.equal(r.body.account.cash, 10000); assert.equal(r.body.account.positions.length, 0);
  assert.equal(r.body.step, before.step, "行情繼續，不重新產生");
  assert.equal(r.body.resets, 1);
});

test("使用者之間遊戲隔離；未登入不能玩", async () => {
  const { call, reg } = setup();
  const a = (await reg("pat")).token, b = (await reg("quinn", "12345678", "3.3.3.3")).token;
  await call("POST", "/api/game/open", { token: a, body: { pair: "EUR/USD", side: 1, leverage: 2, margin: 300 } });
  assert.equal((await call("GET", "/api/game", { token: b })).body.account.positions.length, 0);
  assert.equal((await call("GET", "/api/game")).status, 401);
  assert.equal((await call("POST", "/api/game/open", { body: { pair: "EUR/USD", side: 1, leverage: 2, margin: 300 } })).status, 401);
});

test("舊的存檔上傳 API 已移除", async () => {
  const { call, reg } = setup();
  const { token } = await reg("rita");
  assert.equal((await call("PUT", "/api/save", { token, body: { baseVersion: 0, data: { cash: 1e9, positions: [] } } })).status, 404);
});

test("刪除帳號需要密碼，並清掉遊戲資料", async () => {
  const { env, call, reg } = setup();
  const { token } = await reg("sam");
  await call("GET", "/api/game", { token });
  assert.equal((await call("DELETE", "/api/account", { token, body: { password: "wrongpass" } })).status, 401);
  assert.equal((await call("DELETE", "/api/account", { token, body: { password: "12345678" } })).status, 200);
  for (const tbl of ["users", "games", "sessions"]) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n, 0, tbl);
});

test("CORS 只允許指定網站；未知路徑與壞 JSON", async () => {
  const { call, env } = setup();
  assert.equal((await call("GET", "/api/health")).headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal((await call("GET", "/api/health", { origin: "https://evil.example" })).headers.get("Access-Control-Allow-Origin"), null);
  const r = await worker.fetch(new Request("https://api.test/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" }), env);
  assert.equal(r.status, 400);
  assert.equal((await worker.fetch(new Request("https://api.test/api/nope"), env)).status, 404);
});

test("沒寫回時重算結果完全一致（不會因重算而看到不同行情）", async () => {
  const { call, reg } = setup();
  const { token } = await reg("tina");
  const s0 = (await call("GET", "/api/game", { token })).body;
  wait(TICK_MS * 5);
  const a = (await call("GET", `/api/game?since=${s0.step}`, { token })).body;
  const b = (await call("GET", `/api/game?since=${s0.step}`, { token })).body;
  assert.deepEqual(a.candles, b.candles);
  assert.deepEqual(a.prices, b.prices);
});


/* ---------- 安全與並行回歸 ---------- */
test("JSON 必須是 object（null、array 與 primitive 拒絕）", async () => {
  const { call, reg } = setup();
  const { token } = await reg("json_user");
  for (const body of [null, [], "hello", 42, true]) {
    for (const [method, path] of [["POST", "/api/login"], ["POST", "/api/register"], ["POST", "/api/reset-password"], ["POST", "/api/recovery-code"], ["DELETE", "/api/account"], ["POST", "/api/game/reset"]]) {
      assert.equal((await call(method, path, { token, body })).status, 400, path);
    }
  }
});

test("重設救援碼原子消耗：並行只能一次成功，同毫秒 session 也撤銷", async () => {
  const { env, call, reg } = setup();
  const { token, recoveryCode } = await reg("cas_user");
  const body = { username: "cas_user", recoveryCode, newPassword: "changed-pass" };
  const results = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/api/reset-password", { body })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401, 401, 401]);
  const winner = results.find(r => r.status === 200).body;
  assert.equal((await call("GET", "/api/me", { token })).status, 401);
  assert.equal((await call("GET", "/api/me", { token: winner.token })).status, 200);
  const firstVersion = env.DB.raw.prepare("SELECT pw_changed_at FROM users").get().pw_changed_at;
  const second = await call("POST", "/api/reset-password", { body: { ...body, recoveryCode: winner.recoveryCode } });
  assert.equal(second.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT pw_changed_at FROM users").get().pw_changed_at, firstVersion + 1);
  assert.equal((await call("GET", "/api/me", { token: winner.token })).status, 401);
  assert.equal((await call("GET", "/api/me", { token: second.body.token })).status, 200);
});

// 在指定 SQL 執行前暫停單一請求，精準重現跨 PBKDF2 / DB await 的競態。
function pauseQuery(env, matches) {
  const prepare = env.DB.prepare.bind(env.DB);
  let release, reached;
  const paused = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let used = false;
  env.DB.prepare = sql => {
    const wrap = stmt => ({
      ...stmt,
      bind: (...args) => wrap(stmt.bind(...args)),
      first: async () => {
        if (!used && matches(sql)) { used = true; reached(); await gate; }
        return stmt.first();
      },
      run: async () => {
        if (!used && matches(sql)) { used = true; reached(); await gate; }
        return stmt.run();
      },
    });
    return wrap(prepare(sql));
  };
  return { paused, release };
}

test("舊密碼登入在重設後才寫 session 時拒絕；不會復活登入", async () => {
  const { env, call, reg } = setup();
  const { recoveryCode } = await reg("race_login");
  const gate = pauseQuery(env, sql => sql.startsWith("INSERT INTO sessions"));
  const login = call("POST", "/api/login", { body: { username: "race_login", password: "12345678" } });
  await gate.paused;
  const reset = await call("POST", "/api/reset-password", { body: { username: "race_login", recoveryCode, newPassword: "new-pass123" } });
  assert.equal(reset.status, 200);
  gate.release();
  assert.equal((await login).status, 401);
  assert.equal((await call("GET", "/api/me", { token: reset.body.token })).status, 200);
});

test("延遲的舊重設清理不能撤銷更新版本的 session", async () => {
  const { env, call, reg } = setup();
  const { recoveryCode } = await reg("cleanup_race");
  const gate = pauseQuery(env, sql => sql.startsWith("DELETE FROM sessions WHERE user_id"));
  const reset = call("POST", "/api/reset-password", { body: { username: "cleanup_race", recoveryCode, newPassword: "new-pass123" } });
  await gate.paused;
  const login = await call("POST", "/api/login", { body: { username: "cleanup_race", password: "new-pass123" } });
  assert.equal(login.status, 200);
  const rc = await call("POST", "/api/recovery-code", { token: login.body.token, body: { password: "new-pass123" } });
  const newer = await call("POST", "/api/reset-password", { body: { username: "cleanup_race", recoveryCode: rc.body.recoveryCode, newPassword: "newer-pass123" } });
  assert.equal(newer.status, 200);
  gate.release();
  assert.equal((await reset).status, 401, "已被後續重設取代的請求不能建立 session");
  assert.equal((await call("GET", "/api/me", { token: newer.body.token })).status, 200);
});

test("驗密後重設不能被過期的重新產碼或刪帳請求覆蓋", async () => {
  for (const [method, path, marker, expected] of [
    ["POST", "/api/recovery-code", "UPDATE users SET rc_hash", 409],
    ["DELETE", "/api/account", "DELETE FROM users", 401],
  ]) {
    const { env, call, reg } = setup();
    const { token, recoveryCode } = await reg("race_account");
    const gate = pauseQuery(env, sql => sql.startsWith(marker));
    const action = call(method, path, { token, body: { password: "12345678" } });
    await gate.paused;
    const reset = await call("POST", "/api/reset-password", { body: { username: "race_account", recoveryCode, newPassword: "new-pass123" } });
    assert.equal(reset.status, 200);
    gate.release();
    assert.equal((await action).status, expected);
    assert.equal((await call("GET", "/api/me", { token: reset.body.token })).status, 200);
  }
});

test("重新產碼與刪帳有長度驗證及共享原子節流（跨 IP）", async () => {
  const { call, reg } = setup();
  const { token } = await reg("rate_account");
  for (const password of ["short", "x".repeat(129), 12345678, null]) {
    for (const [method, path] of [["POST", "/api/recovery-code"], ["DELETE", "/api/account"]])
      assert.equal((await call(method, path, { token, body: { password } })).status, 400);
  }
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => call(i % 2 ? "POST" : "DELETE", i % 2 ? "/api/recovery-code" : "/api/account", { token, body: { password: "wrongpass" }, ip: `8.0.0.${i}` })));
  assert.equal(results.filter(r => r.status === 401).length, 10);
  assert.equal(results.filter(r => r.status === 429).length, 5);
  assert.equal((await call("POST", "/api/recovery-code", { token, body: { password: "12345678" } })).status, 429);
  wait(16 * 60000);
  assert.equal((await call("POST", "/api/recovery-code", { token, body: { password: "12345678" } })).status, 200);
});

test("migration 保留舊 saves，刪帳透過 cascade 清除", async () => {
  const db = createD1(new URL("../migrations/0001_init.sql", import.meta.url).pathname);
  db.raw.exec("INSERT INTO users VALUES (1, 'legacy', 'hash', 'salt', 100000, 0); INSERT INTO saves VALUES (1, '{\"legacy\":true}', 7, 123);");
  db.raw.exec(readFileSync(new URL("../migrations/0002_game.sql", import.meta.url), "utf8"));
  assert.deepEqual({ ...db.raw.prepare("SELECT * FROM saves").get() }, { user_id: 1, data: '{"legacy":true}', version: 7, updated_at: 123 });
  const { env, call, reg } = setup();
  const { token } = await reg("delete_legacy");
  env.DB.raw.exec("INSERT INTO saves SELECT id, '{}', 1, 0 FROM users");
  assert.equal((await call("DELETE", "/api/account", { token, body: { password: "12345678" } })).status, 200);
  assert.equal(env.DB.raw.prepare("SELECT count(*) n FROM saves").get().n, 0);
});

test("me 提供舊帳戶是否有救援碼的旗標", async () => {
  const { env, call, reg } = setup();
  const { token } = await reg("recovery_flag");
  assert.equal((await call("GET", "/api/me", { token })).body.hasRecoveryCode, true);
  env.DB.raw.exec("UPDATE users SET rc_hash = NULL, rc_salt = NULL");
  assert.equal((await call("GET", "/api/me", { token })).body.hasRecoveryCode, false);
});

test("game requestId：並行重送只開倉一次、同 ID 不同 payload 或路徑拒絕", async () => {
  const { env, call, reg } = setup();
  const { token } = await reg("idempotent");
  const body = { requestId: "order-1", pair: "EUR/USD", side: 1, leverage: 2, margin: 100 };
  const results = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/api/game/open", { token, body })));
  assert.ok(results.every(r => r.status === 200));
  assert.ok(results.every(r => r.body.account.positions.length === 1));
  assert.ok(results.every(r => r.body.result.opened.id === results[0].body.result.opened.id));
  const original = results[0].body.result;
  const again = await call("POST", "/api/game/open", { token, body: { margin: 100, leverage: 2, side: 1, pair: "EUR/USD", requestId: "order-1", since: 0 } });
  assert.deepEqual(again.body.result, original);
  assert.equal((await call("POST", "/api/game/open", { token, body: { ...body, margin: 200 } })).status, 409);
  assert.equal((await call("POST", "/api/game/reset", { token, body: { requestId: "order-1" } })).status, 409);
  const close = { id: original.opened.id, requestId: "close-1" };
  const closed = await call("POST", "/api/game/close", { token, body: close });
  const replay = await call("POST", "/api/game/close", { token, body: close });
  assert.equal(replay.status, 200); assert.deepEqual(replay.body.result, closed.body.result);
  assert.equal(replay.body.account.positions.length, 0);
  assert.equal(JSON.parse(env.DB.raw.prepare("SELECT state FROM games").get().state).requests.length, 2);
  for (const requestId of [null, 123, "", "x".repeat(65), "invalid/id"])
    assert.equal((await call("POST", "/api/game/reset", { token, body: { requestId } })).status, 400);
});

test("game requestId 歷史跨重置保留且有上限；不同帳戶可共用 ID", async () => {
  const { env, call, reg } = setup();
  const { token } = await reg("history_user");
  const other = (await reg("history_other")).token;
  const body = { requestId: "initial", pair: "EUR/USD", side: 1, leverage: 2, margin: 100 };
  assert.equal((await call("POST", "/api/game/open", { token, body })).status, 200);
  assert.equal((await call("POST", "/api/game/open", { token: other, body })).status, 200);
  const row = env.DB.raw.prepare("SELECT state FROM games WHERE user_id = 1").get();
  const g = JSON.parse(row.state);
  g.requests = [...Array.from({ length: 127 }, (_, i) => ({ id: `old-${i}`, fingerprint: "test", result: {} })), ...g.requests];
  env.DB.raw.prepare("UPDATE games SET state = ? WHERE user_id = 1").run(JSON.stringify(g));
  const reset = await call("POST", "/api/game/reset", { token, body: { requestId: "reset-1" } });
  assert.equal(reset.status, 200);
  const replay = await call("POST", "/api/game/reset", { token, body: { requestId: "reset-1" } });
  assert.equal(replay.body.resets, 1);
  const stored = JSON.parse(env.DB.raw.prepare("SELECT state FROM games WHERE user_id = 1").get().state);
  assert.equal(stored.requests.length, 128);
  assert.equal(stored.requests[0].id, "old-1");
  const retried = await call("POST", "/api/game/open", { token, body });
  assert.equal(retried.status, 200); assert.equal(retried.body.account.positions.length, 0, "重置不能讓舊開倉重送再次執行");
});

test("補算期間禁止新操作但持久化進度，追平後相同 requestId 可成功", async () => {
  const { env, call, reg } = setup();
  const { token } = await reg("backlog_user");
  const initial = await call("GET", "/api/game", { token });
  wait(TICK_MS * (MAX_CATCHUP * 2 + 3));
  const body = { requestId: "backlog-reset" };
  const blocked = await call("POST", "/api/game/reset", { token, body });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "catching_up");
  assert.equal(blocked.body.remainingTicks, MAX_CATCHUP + 3);
  let stored = JSON.parse(env.DB.raw.prepare("SELECT state FROM games").get().state);
  assert.equal(stored.market.step, initial.body.step + MAX_CATCHUP);
  assert.equal(stored.resets, 0); assert.equal(stored.requests, undefined);
  const next = await call("GET", "/api/game", { token });
  assert.equal(next.body.catchingUp, true); assert.equal(next.body.remainingTicks, 3);
  const done = await call("POST", "/api/game/reset", { token, body });
  assert.equal(done.status, 200); assert.equal(done.body.catchingUp, false);
  assert.equal(done.body.step, initial.body.step + MAX_CATCHUP * 2 + 3);
  assert.equal(done.body.resets, 1);
  assert.equal((await call("POST", "/api/game/reset", { token, body })).body.resets, 1);
});

test("舊行情升級安全亂數必須存回，且 API 不洩漏秘密或請求歷史", async () => {
  const { env, call, reg } = setup();
  const { token } = await reg("legacy_market");
  await call("GET", "/api/game", { token });
  const row = env.DB.raw.prepare("SELECT state, version FROM games").get();
  const legacy = JSON.parse(row.state);
  delete legacy.market.rngVersion; delete legacy.market.secret;
  legacy.market.r = 12345;
  env.DB.raw.prepare("UPDATE games SET state = ?").run(JSON.stringify(legacy));
  const response = await call("GET", "/api/game", { token });
  assert.equal(response.status, 200);
  const updated = env.DB.raw.prepare("SELECT state, version FROM games").get();
  const upgraded = JSON.parse(updated.state);
  assert.equal(updated.version, row.version + 1);
  assert.equal(upgraded.market.rngVersion, "hmac-sha256-v1");
  assert.match(upgraded.market.secret, /^[0-9a-f]{64}$/);
  assert.equal(upgraded.account.cash, legacy.account.cash);
  const again = await call("GET", "/api/game", { token });
  assert.deepEqual(again.body.prices, response.body.prices);
  assert.equal(JSON.parse(env.DB.raw.prepare("SELECT state FROM games").get().state).market.secret, upgraded.market.secret);
  assert.ok(!JSON.stringify(response.body).includes(upgraded.market.secret));
  for (const key of ["secret", "rngVersion", "requests", "phase", "bias"]) assert.ok(!JSON.stringify(response.body).includes(`"${key}":`));
});

test("遊戲操作、讀取和重置各有節流", async () => {
  const { call, reg } = setup();
  const { token } = await reg("game_rate");
  for (let i = 0; i < 60; i++) assert.equal((await call("POST", "/api/game/close", { token, body: { id: -1 } })).status, 400);
  assert.equal((await call("POST", "/api/game/close", { token, body: { id: -1 } })).status, 429);
  wait(60001);
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/game/reset", { token, body: {} })).status, 200);
  assert.equal((await call("POST", "/api/game/reset", { token, body: {} })).status, 429);
  for (let i = 0; i < 120; i++) assert.equal((await call("GET", "/api/game", { token })).status, 200);
  assert.equal((await call("GET", "/api/game", { token })).status, 429);
});
test('online API includes anonymous guests, deduplicates authenticated tabs and rejects bad bearer', async () => {
  const { call, reg } = setup(), tab = n => n.toString(16).padStart(32,'0');
  let r = await call('POST','/api/online',{body:{tabId:tab(1)}});
  assert.equal(r.status,200); assert.deepEqual([r.body.online,r.body.guests,r.body.players],[1,1,0]);
  const user=await reg('onlineuser');
  r = await call('POST','/api/online',{body:{tabId:tab(2)},token:user.token});
  assert.deepEqual([r.body.online,r.body.guests,r.body.players],[2,1,1]);
  r = await call('POST','/api/online',{body:{tabId:tab(3)},token:user.token});
  assert.deepEqual([r.body.online,r.body.guests,r.body.players],[2,1,1]);
  r = await call('POST','/api/online',{body:{tabId:tab(1)},token:user.token});
  assert.deepEqual([r.body.online,r.body.guests,r.body.players],[1,0,1]);
  assert.equal((await call('POST','/api/online',{body:{tabId:'bad'}})).status,400);
  assert.equal((await call('POST','/api/online',{body:{tabId:tab(4)},token:'invalidtokenwithlengthok'})).status,401);
});
