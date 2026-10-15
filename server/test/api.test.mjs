import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createD1 } from "./d1shim.mjs";

const ORIGIN = "https://easonlai96.github.io";
function setup() {
  const env = { DB: createD1(new URL("../migrations/0001_init.sql", import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN + ",http://127.0.0.1:8799" };
  const call = async (method, path, { body, token, origin = ORIGIN, ip = "1.1.1.1" } = {}) => {
    const headers = { Origin: origin, "CF-Connecting-IP": ip };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    const res = await worker.fetch(new Request("https://api.test" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { env, call };
}
const SAVE = { cash: 10000, positions: [], log: [], nextId: 1, startingCash: 10000 };

test("註冊、登入、取得自己", async () => {
  const { call } = setup();
  const r = await call("POST", "/api/register", { body: { username: "Eason_1", password: "correct horse" } });
  assert.equal(r.status, 201); assert.ok(r.body.token); assert.equal(r.body.user.username, "Eason_1");
  const l = await call("POST", "/api/login", { body: { username: "eason_1", password: "correct horse" } });
  assert.equal(l.status, 200, "帳號不分大小寫");
  const m = await call("GET", "/api/me", { token: l.body.token });
  assert.equal(m.status, 200); assert.equal(m.body.user.username, "Eason_1"); assert.equal(m.body.save, null);
});

test("密碼不以明文儲存", async () => {
  const { env, call } = setup();
  await call("POST", "/api/register", { body: { username: "alice", password: "s3cret-pass" } });
  const row = env.DB.raw.prepare("SELECT * FROM users").get();
  assert.ok(!JSON.stringify(row).includes("s3cret-pass"));
  assert.equal(row.pw_iter, 100000);
  const sess = env.DB.raw.prepare("SELECT token_hash FROM sessions").get();
  assert.match(sess.token_hash, /^[0-9a-f]{64}$/);
});

test("重複帳號、格式錯誤", async () => {
  const { call } = setup();
  await call("POST", "/api/register", { body: { username: "bob", password: "12345678" } });
  assert.equal((await call("POST", "/api/register", { body: { username: "BOB", password: "12345678" }, ip: "2.2.2.2" })).status, 409);
  assert.equal((await call("POST", "/api/register", { body: { username: "a", password: "12345678" } })).status, 400);
  assert.equal((await call("POST", "/api/register", { body: { username: "carol", password: "short" } })).status, 400);
  assert.equal((await call("POST", "/api/register", { body: { username: "有中文", password: "12345678" } })).status, 400);
});

test("錯誤密碼與不存在帳號回同一訊息", async () => {
  const { call } = setup();
  await call("POST", "/api/register", { body: { username: "dave", password: "12345678" } });
  const a = await call("POST", "/api/login", { body: { username: "dave", password: "wrongpass" } });
  const b = await call("POST", "/api/login", { body: { username: "nobody", password: "wrongpass" } });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.message, b.body.message);
});

test("登入失敗 10 次後鎖定", async () => {
  const { call } = setup();
  await call("POST", "/api/register", { body: { username: "erin", password: "12345678" } });
  for (let i = 0; i < 10; i++) assert.equal((await call("POST", "/api/login", { body: { username: "erin", password: "badbadbad" } })).status, 401);
  const locked = await call("POST", "/api/login", { body: { username: "erin", password: "12345678" } });
  assert.equal(locked.status, 429, "鎖定期間正確密碼也擋");
  const otherIp = await call("POST", "/api/login", { body: { username: "erin", password: "12345678" }, ip: "9.9.9.9" });
  assert.equal(otherIp.status, 200, "鎖定只針對該 IP");
});

test("存檔、讀檔、版本衝突", async () => {
  const { call } = setup();
  const { body: { token } } = await call("POST", "/api/register", { body: { username: "frank", password: "12345678" } });
  const s1 = await call("PUT", "/api/save", { token, body: { baseVersion: 0, data: SAVE } });
  assert.equal(s1.status, 200); assert.equal(s1.body.version, 1);
  const s2 = await call("PUT", "/api/save", { token, body: { baseVersion: 1, data: { ...SAVE, cash: 12345 } } });
  assert.equal(s2.body.version, 2);
  const g = await call("GET", "/api/save", { token });
  assert.equal(g.body.save.data.cash, 12345); assert.equal(g.body.save.version, 2);
  const stale = await call("PUT", "/api/save", { token, body: { baseVersion: 1, data: { ...SAVE, cash: 1 } } });
  assert.equal(stale.status, 409); assert.equal(stale.body.server.data.cash, 12345);
  const again0 = await call("PUT", "/api/save", { token, body: { baseVersion: 0, data: SAVE } });
  assert.equal(again0.status, 409, "已有存檔時 baseVersion 0 也算衝突");
  const forced = await call("PUT", "/api/save", { token, body: { force: true, data: { ...SAVE, cash: 7 } } });
  assert.equal(forced.body.version, 3);
});

test("存檔格式與大小檢查", async () => {
  const { call } = setup();
  const { body: { token } } = await call("POST", "/api/register", { body: { username: "gina", password: "12345678" } });
  assert.equal((await call("PUT", "/api/save", { token, body: { baseVersion: 0, data: { positions: [] } } })).status, 400);
  assert.equal((await call("PUT", "/api/save", { token, body: { baseVersion: 0, data: { cash: 1, positions: "x" } } })).status, 400);
  const big = { ...SAVE, log: Array.from({ length: 3000 }, (_, i) => ({ t: i, note: "x".repeat(30) })) };
  assert.equal((await call("PUT", "/api/save", { token, body: { baseVersion: 0, data: big } })).status, 413);
});

test("使用者之間資料隔離", async () => {
  const { call } = setup();
  const a = (await call("POST", "/api/register", { body: { username: "henry", password: "12345678" } })).body.token;
  const b = (await call("POST", "/api/register", { body: { username: "ivy", password: "12345678" }, ip: "3.3.3.3" })).body.token;
  await call("PUT", "/api/save", { token: a, body: { baseVersion: 0, data: { ...SAVE, cash: 999 } } });
  const gb = await call("GET", "/api/save", { token: b });
  assert.equal(gb.body.save, null);
});

test("未登入、假 token、登出後失效", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/save")).status, 401);
  assert.equal((await call("GET", "/api/save", { token: "x".repeat(43) })).status, 401);
  const t = (await call("POST", "/api/register", { body: { username: "jack", password: "12345678" } })).body.token;
  assert.equal((await call("POST", "/api/logout", { token: t })).status, 200);
  assert.equal((await call("GET", "/api/me", { token: t })).status, 401);
});

test("session 過期", async () => {
  const { env, call } = setup();
  const t = (await call("POST", "/api/register", { body: { username: "kate", password: "12345678" } })).body.token;
  env.DB.raw.exec("UPDATE sessions SET expires_at = 1");
  assert.equal((await call("GET", "/api/me", { token: t })).status, 401);
});

test("刪除帳號需要密碼，並清掉資料", async () => {
  const { env, call } = setup();
  const t = (await call("POST", "/api/register", { body: { username: "leo", password: "12345678" } })).body.token;
  await call("PUT", "/api/save", { token: t, body: { baseVersion: 0, data: SAVE } });
  assert.equal((await call("DELETE", "/api/account", { token: t, body: { password: "nope" } })).status, 401);
  assert.equal((await call("DELETE", "/api/account", { token: t, body: { password: "12345678" } })).status, 200);
  for (const tbl of ["users", "saves", "sessions"]) assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) n FROM ${tbl}`).get().n, 0, tbl);
});

test("CORS 只允許指定網站", async () => {
  const { call } = setup();
  const ok = await call("GET", "/api/health");
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const bad = await call("GET", "/api/health", { origin: "https://evil.example" });
  assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
  const pre = await worker.fetch(new Request("https://api.test/api/save", { method: "OPTIONS", headers: { Origin: ORIGIN } }), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(pre.status, 204); assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("未知路徑與壞 JSON", async () => {
  const { env } = setup();
  const r = await worker.fetch(new Request("https://api.test/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" }), env);
  assert.equal(r.status, 400);
  const n = await worker.fetch(new Request("https://api.test/api/nope"), env);
  assert.equal(n.status, 404);
});
