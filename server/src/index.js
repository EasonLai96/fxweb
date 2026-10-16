import { ensureProgress } from "./progress.js";
import { joinSeason, leaveSeason, updateSeasonScore, seasonParticipationView, publicLeaderboard } from "./leaderboard.js";
import { sharedPricer, absoluteTick } from "./shared-market.js";
import { captureSentiment, loadSnapshots, SENTIMENT_START } from "./sentiment.js";
import { presence, prunePresence } from "./presence.js";
// fxweb 後端：Cloudflare Worker + D1。帳號密碼登入、救援碼重設密碼、伺服器端計算的遊戲。
// 密碼：PBKDF2-SHA256（Workers 上限 100000 次迭代）+ 每人隨機 salt。
// 登入憑證：隨機 token，以 Authorization: Bearer 傳遞；資料庫只存 token 的 SHA-256。
// 前端在 github.io、API 在 workers.dev，跨站 cookie 常被瀏覽器擋，所以用 Bearer token 而不是 cookie。

import { newGame, advance, openOrder, closeOrder, resetGame, borrowLoan, repayLoan, addPositionMargin, refuseHelp, view, GameError, PERSIST_EVERY, ensureSecureGame, ensureMarketMode } from "./game.js";

const PBKDF2_ITER = 100000;
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const now = () => Date.now();

function randomBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256);
}

async function sha256hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }

// 救援碼：16 個字元（去掉易混淆的 0 O 1 I L），約 80 bits，顯示成 XXXX-XXXX-XXXX-XXXX。
const RC_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function newRecoveryCode() {
  const b = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += RC_ALPHABET[b[i] % RC_ALPHABET.length];
  return s.match(/.{4}/g).join("-");
}
const normRc = s => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
async function hashRc(code, salt) { return b64(await pbkdf2(normRc(code), salt, 20000)); }

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// 帳號不存在時也跑一次 PBKDF2，讓回應時間跟密碼錯誤差不多，避免被用來猜帳號是否存在。
const DUMMY_SALT = new Uint8Array(16);

/* ---------- HTTP 工具 ---------- */
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const h = { "Vary": "Origin" };
  if (allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}

class HttpError extends Error { constructor(status, code, msg, extra) { super(msg); this.status = status; this.code = code; this.extra = extra; } }

function json(data, status, req, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(req, env) },
  });
}

async function readJson(req, limit = 8192) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > limit) throw new HttpError(413, "too_large", "資料太大");
  const text = await req.text();
  if (enc.encode(text).length > limit) throw new HttpError(413, "too_large", "資料太大");
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
    return body;
  } catch { throw new HttpError(400, "bad_json", "格式錯誤（需要 JSON object）"); }
}

/* ---------- 登入節流 ---------- */
async function checkRate(env, key) {
  const row = await env.DB.prepare("SELECT count, window_start FROM login_attempts WHERE key = ?").bind(key).first();
  if (row && now() - row.window_start < LOGIN_WINDOW_MS && row.count >= LOGIN_MAX_FAILS) {
    const wait = Math.ceil((row.window_start + LOGIN_WINDOW_MS - now()) / 60000);
    throw new HttpError(429, "rate_limited", `嘗試次數過多，請 ${wait} 分鐘後再試`);
  }
}
async function recordFail(env, key) {
  await env.DB.prepare(`INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`)
    .bind(key, now(), LOGIN_WINDOW_MS).run();
}
async function clearFails(env, key) { await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run(); }

// 原子預留額度：並行請求不能一起通過 check-then-increment。
async function consumeRate(env, key, max = 10, window = LOGIN_WINDOW_MS) {
  const row = await env.DB.prepare(`INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END
    WHERE ?2 - window_start >= ?3 OR count < ?4 RETURNING count`)
    .bind(key, now(), window, max).first();
  if (!row) throw new HttpError(429, "rate_limited", "操作太頻繁，請稍後再試");
}

/* ---------- Session ---------- */
async function createSession(env, userId, pwHash, authVersion) {
  const token = b64(randomBytes(32)).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
  const t = now();
  // 密碼驗證與 session 寫入之間可能重設密碼；只允許相同憑證版本建立 session。
  const inserted = await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at, auth_version)
    SELECT ?, id, ?, ?, pw_changed_at FROM users WHERE id = ? AND pw_hash = ? AND pw_changed_at = ? RETURNING token_hash`)
    .bind(await sha256hex(token), t, t + SESSION_DAYS * 86400000, userId, pwHash, authVersion).first();
  if (!inserted) throw new HttpError(401, "unauthorized", "憑證已變更，請重新登入");
  // 順手清掉過期 session
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t).run();
  return token;
}

async function requireUser(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!m) throw new HttpError(401, "unauthorized", "請先登入");
  const th = await sha256hex(m[1]);
  const row = await env.DB.prepare(`SELECT s.user_id, s.expires_at, s.created_at, s.auth_version, u.username, u.pw_changed_at, u.rc_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(th).first();
  if (!row || row.expires_at < now() || row.auth_version !== row.pw_changed_at) throw new HttpError(401, "unauthorized", "登入已過期，請重新登入");
  return { id: row.user_id, username: row.username, tokenHash: th, authVersion: row.auth_version, hasRecoveryCode: !!row.rc_hash };
}

/* ---------- 驗證輸入 ---------- */
function validateCreds(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "bad_username", "帳號需為 3~20 個英文字母、數字或底線");
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "bad_password", "密碼長度需為 8~128 個字元");
  return { username, password };
}

/* ---------- 路由 ---------- */
async function register(req, env) {
  const { username, password } = validateCreds(await readJson(req, 4096));
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  await checkRate(env, "reg:" + ip);
  const salt = randomBytes(16);
  const hash = b64(await pbkdf2(password, salt, PBKDF2_ITER));
  const rc = newRecoveryCode(), rcSalt = randomBytes(16);
  try {
    const r = await env.DB.prepare("INSERT INTO users (username, pw_hash, pw_salt, pw_iter, created_at, rc_hash, rc_salt, pw_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
      .bind(username, hash, b64(salt), PBKDF2_ITER, now(), await hashRc(rc, rcSalt), b64(rcSalt)).run();
    await recordFail(env, "reg:" + ip); // 註冊次數也算進節流，避免大量灌帳號
    const userId = r.meta.last_row_id;
    // 救援碼只在這裡出現一次，伺服器之後無法再查到原文
    return { status: 201, body: { token: await createSession(env, userId, hash, 0), user: { username }, recoveryCode: rc } };
  } catch (e) {
    if (String(e.message || e).includes("UNIQUE")) throw new HttpError(409, "username_taken", "這個帳號已經有人使用");
    throw e;
  }
}

async function login(req, env) {
  const { username, password } = validateCreds(await readJson(req, 4096));
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const key = "login:" + username.toLowerCase() + ":" + ip;
  await checkRate(env, key);
  const u = await env.DB.prepare("SELECT id, username, pw_hash, pw_salt, pw_iter, pw_changed_at FROM users WHERE username = ?").bind(username).first();
  const calc = b64(await pbkdf2(password, u ? unb64(u.pw_salt) : DUMMY_SALT, u ? u.pw_iter : PBKDF2_ITER));
  if (!u || !safeEqual(calc, u.pw_hash)) {
    await recordFail(env, key);
    throw new HttpError(401, "bad_credentials", "帳號或密碼錯誤");
  }
  await clearFails(env, key);
  return { status: 200, body: { token: await createSession(env, u.id, u.pw_hash, u.pw_changed_at), user: { username: u.username } } };
}

async function logout(req, env) {
  const user = await requireUser(req, env);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
  return { status: 200, body: { ok: true } };
}

async function me(req, env) {
  const user = await requireUser(req, env);
  return { status: 200, body: { user: { username: user.username }, hasRecoveryCode: user.hasRecoveryCode } };
}

/* ---------- 忘記密碼（救援碼） ---------- */
async function resetPassword(req, env) {
  const body = await readJson(req, 4096);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "bad_username", "帳號格式錯誤");
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "bad_password", "新密碼長度需為 8~128 個字元");
  if (typeof body.recoveryCode !== "string" || body.recoveryCode.length > 64 || normRc(body.recoveryCode).length !== 16) throw new HttpError(400, "bad_code", "救援碼格式錯誤（16 個英數字）");
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  const key = "reset:" + username.toLowerCase() + ":" + ip;
  await checkRate(env, key);
  await checkRate(env, "reset-user:" + username.toLowerCase()); // 不分 IP 的總次數，防止換 IP 暴力猜
  const u = await env.DB.prepare("SELECT id, username, rc_hash, rc_salt, pw_changed_at FROM users WHERE username = ?").bind(username).first();
  const calc = await hashRc(body.recoveryCode, u && u.rc_salt ? unb64(u.rc_salt) : DUMMY_SALT);
  if (!u || !u.rc_hash || !safeEqual(calc, u.rc_hash)) {
    await recordFail(env, key); await recordFail(env, "reset-user:" + username.toLowerCase());
    throw new HttpError(401, "bad_code", "帳號或救援碼錯誤");
  }
  // 重設成功：換新密碼、換新救援碼（舊的作廢）、登出所有裝置
  const salt = randomBytes(16), rc = newRecoveryCode(), rcSalt = randomBytes(16), t = now();
  const pwHash = b64(await pbkdf2(password, salt, PBKDF2_ITER));
  // 比對讀取時的救援碼與版本，在同一 UPDATE 原子消耗，只有一個重設能成功。
  const updated = await env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, rc_hash = ?, rc_salt = ?,
    pw_changed_at = MAX(pw_changed_at + 1, ?) WHERE id = ? AND rc_hash = ? AND pw_changed_at = ? RETURNING pw_changed_at`)
    .bind(pwHash, b64(salt), PBKDF2_ITER, await hashRc(rc, rcSalt), b64(rcSalt), t, u.id, u.rc_hash, u.pw_changed_at).first();
  if (!updated) throw new HttpError(401, "bad_code", "帳號或救援碼錯誤");
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND auth_version < ?").bind(u.id, updated.pw_changed_at).run();
  await clearFails(env, key);
  return { status: 200, body: { token: await createSession(env, u.id, pwHash, updated.pw_changed_at), user: { username: u.username }, recoveryCode: rc } };
}

// 高風險操作共享每帳戶額度，成功和失敗均計入，不可換 IP 或端點繞過。
async function verifyCurrentPassword(env, user, body) {
  if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128)
    throw new HttpError(400, "bad_password", "密碼長度需為 8~128 個字元");
  await consumeRate(env, "account:" + user.id);
  const u = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter, pw_changed_at, rc_hash FROM users WHERE id = ?").bind(user.id).first();
  if (!u || u.pw_changed_at !== user.authVersion) throw new HttpError(401, "unauthorized", "請重新登入");
  if (!safeEqual(b64(await pbkdf2(body.password, unb64(u.pw_salt), u.pw_iter)), u.pw_hash))
    throw new HttpError(401, "bad_credentials", "密碼錯誤");
  return u;
}

// 已登入時重新產生救援碼（需要目前密碼），舊的作廢。
async function newRecovery(req, env) {
  const user = await requireUser(req, env);
  const u = await verifyCurrentPassword(env, user, await readJson(req, 4096));
  const rc = newRecoveryCode(), rcSalt = randomBytes(16);
  const updated = await env.DB.prepare(`UPDATE users SET rc_hash = ?, rc_salt = ?
    WHERE id = ? AND pw_hash = ? AND pw_changed_at = ? AND rc_hash IS ? RETURNING id`)
    .bind(await hashRc(rc, rcSalt), b64(rcSalt), user.id, u.pw_hash, u.pw_changed_at, u.rc_hash).first();
  if (!updated) throw new HttpError(409, "credentials_changed", "憑證已變更，請重新嘗試");
  return { status: 200, body: { recoveryCode: rc } };
}

/* ---------- 遊戲（伺服器端計算） ---------- */
// 讀取 -> 依時間推進 -> 執行動作 -> 寫回。用 version 做樂觀鎖，同時兩個請求時後到的重試。
function sharedSecret(env) {
  // Production must never fall back to a per-user private market.
  // Test fixtures explicitly pass MARKET_TEST_ALLOW_LEGACY=true.
  if ((!env.SHARED_MARKET_SECRET || !/^[0-9a-f]{64}$/.test(env.SHARED_MARKET_SECRET)) && env.MARKET_TEST_ALLOW_LEGACY !== true)
    throw new Error("Shared market secret is not configured");
  return env.SHARED_MARKET_SECRET;
}
function serverPrices(g, secret, sentiment) {
  if (g.marketMode !== 'shared') return g.market.prices;
  // 排行榜成績只需要持倉商品的價格（updateSeasonScore 只檢查持倉商品）。
  const at = sharedPricer(secret, sentiment), held = [...new Set(g.account.positions.map(p => p.pair))];
  return Object.fromEntries(held.map(pair => [pair, at(g.cursor, pair)]));
}
async function withGame(env, userId, mutate, request = null) {
  const secret = sharedSecret(env);
  const head = absoluteTick(now());
  // Head candles and historical settlement may be far apart; load two small ranges.
  const sentiment = head >= SENTIMENT_START ? await loadSnapshots(env, Math.max(0, head - 180), head) : new Map();
  for (let attempt = 0; attempt < 4; attempt++) {
    const t = now();
    const row = await env.DB.prepare("SELECT state, version FROM games WHERE user_id = ?").bind(userId).first();
    let g, version = 0;
    if (row) { g = JSON.parse(row.state); version = row.version; }
    else g = newGame(t, secret);
    if (g.marketMode === 'shared' && g.account.positions.length && g.cursor < head - 180) {
      const older = await loadSnapshots(env, g.cursor, Math.min(head, g.cursor + 601));
      for (const [bucket, counts] of older) sentiment.set(bucket, counts);
    }
    const progressUpgraded = ensureProgress(g, t);
    const modeUpgraded = ensureMarketMode(g, t, secret);
    const secureUpgraded = ensureSecureGame(g);
    let upgraded = modeUpgraded || secureUpgraded || progressUpgraded;
    const history = Array.isArray(g.requests) ? g.requests : [];
    const previous = request && history.find(r => r.id === request.id);
    if (previous && previous.fingerprint !== request.fingerprint)
      throw new HttpError(409, "request_conflict", "requestId 已用於不同操作");
    const before = g.marketMode === 'shared' ? g.cursor : g.market.step;
    const adv = advance(g, t, secret, sentiment);
    upgraded = ensureMarketMode(g, t, secret) || upgraded;
    const catchingUp = adv.pendingSteps > 0;
    const result = previous ? previous.result : mutate && !catchingUp ? mutate(g, t, secret, sentiment) : null;
    upgraded = ensureMarketMode(g, t, secret) || upgraded;
    if (request && !previous && !catchingUp) {
      // 深拷貝結果，不讓之後行情或平倉更動已提交的回執。
      g.requests = [...history, { ...request, result: JSON.parse(JSON.stringify(result)) }].slice(-128);
    }
    const after = g.marketMode === 'shared' ? g.cursor : g.market.step;
    // Shared flat accounts may jump over years in one read; persist the new cursor
    // instead of rebuilding from their creation tick on every subsequent request.
    const changed = !row || upgraded || catchingUp || (!!mutate && !previous) || adv.events.length > 0 || after - before >= PERSIST_EVERY;
    if (changed) {
      if (!catchingUp && g.seasonParticipation?.status === 'active') updateSeasonScore(g, serverPrices(g, secret, sentiment), t);
      const text = JSON.stringify(g);
      let ok;
      if (!row) ok = await env.DB.prepare("INSERT INTO games (user_id, state, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING RETURNING version").bind(userId, text, t).first();
      else ok = await env.DB.prepare("UPDATE games SET state = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ? RETURNING version").bind(text, t, userId, version).first();
      if (!ok) continue; // 被另一個請求搶先寫入，重新讀取再算一次
    }
    if (mutate && !previous && catchingUp) throw new HttpError(409, "catching_up", "行情補算中，請稍後用相同 requestId 重試", { remainingTicks: adv.pendingSteps });
    return { g, events: adv.events, result, t, sentiment };
  }
  throw new HttpError(409, "busy", "操作太頻繁，請再試一次");
}

const sinceOf = req => { const v = new URL(req.url).searchParams.get("since"); return v == null ? -1 : Number.parseInt(v, 10); };

async function gameState(req, env) {
  const user = await requireUser(req, env);
  await consumeRate(env, "game-read:" + user.id, 120, 60000);
  const since = sinceOf(req);
  const { g, events, t, sentiment } = await withGame(env, user.id, null);
  return { status: 200, body: view(g, since, events, t, sharedSecret(env), sentiment) };
}

async function gameAction(req, env, fn) {
  const user = await requireUser(req, env);
  const body = await readJson(req, 4096);
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.requestId)))
    throw new HttpError(400, "bad_request_id", "requestId 需為 1~64 個英數字、底線或連字號");
  await consumeRate(env, "game-action:" + user.id, 60, 60000);
  const path = new URL(req.url).pathname;
  if (path.endsWith("/reset")) await consumeRate(env, "game-reset:" + user.id, 5, 60000);
  const since = Number.isInteger(body.since) ? body.since : -1;
  // since 只影響回應的增量視圖，不是動作 payload。排序後雜湊避免物件鍵順序造成假衝突。
  const payload = { ...body }; delete payload.requestId; delete payload.since;
  const request = body.requestId === undefined ? null : {
    id: body.requestId, fingerprint: await sha256hex(path + ":" + canonicalJson(payload)),
  };
  try {
    const { g, events, result, t, sentiment } = await withGame(env, user.id, (g, t, secret, crowd) => fn(g, body, t, secret, crowd), request);
    return { status: 200, body: { ...view(g, since, events, t, sharedSecret(env), sentiment), result } };
  } catch (e) {
    if (e instanceof GameError) throw new HttpError(400, "game_error", e.message);
    throw e;
  }
}

const gameOpen = (req, env) => gameAction(req, env, (g, b, t, secret, sentiment) => {
  const pos = openOrder(g, { pair: b.pair, side: b.side, leverage: b.leverage, margin: b.margin, max: b.max === true }, t, secret, sentiment);
  return { opened: pos };
});
const gameClose = (req, env) => gameAction(req, env, (g, b, t, secret, sentiment) => ({ closed: b.id, pnl: closeOrder(g, b.id, t, secret, sentiment) }));
const gameReset = (req, env) => gameAction(req, env, (g, b, t, secret) => {
  leaveSeason(g, t);
  resetGame(g, t, secret);
  return { reset: true };
});
const gameBorrow = (req, env) => gameAction(req, env, (g, b, t) => ({ borrowed: borrowLoan(g, b.amount, t) }));
const gameRepay = (req, env) => gameAction(req, env, (g, b, t) => ({ repaid: repayLoan(g, b.amount, t) }));
const gameMargin = (req, env) => gameAction(req, env, (g, b, t, secret, sentiment) => ({ margin: addPositionMargin(g, b.id, b.amount, b.source, t, secret, sentiment) }));
const gameRefuse = (req, env) => gameAction(req, env, (g, b, t) => ({ refused: refuseHelp(g, b.id, t) }));
async function leaderboardList(req, env) {
  await consumeRate(env, "board-ip:" + (req.headers.get("CF-Connecting-IP") || "local"), 90, 60000);
  return { status: 200, body: { leaderboard: await publicLeaderboard(env, now()) } };
}
async function leaderboardMe(req, env) {
  const user = await requireUser(req, env);
  const { g, t } = await withGame(env, user.id, null);
  const own = seasonParticipationView(g, t);
  return { status: 200, body: { optIn: own.status === 'active', nickname: own.nickname || null, myEntry: own.status === 'active' ? own : null, status: own.status, season: own.season } };
}
async function leaderboardJoin(req, env) {
  return leaderboardAction(req, env, (g, body, t) => joinSeason(g, body.nickname, t));
}
async function leaderboardLeave(req, env) {
  return leaderboardAction(req, env, (g, body, t) => { if (!leaveSeason(g, t)) throw new GameError('本季尚未參賽或已退出'); return seasonParticipationView(g, t); });
}
async function leaderboardAction(req, env, fn) {
  const user = await requireUser(req, env);
  const body = await readJson(req, 4096);
  await consumeRate(env, "board-action:" + user.id, 5, 60000);
  try {
    const { g, t } = await withGame(env, user.id, (g, t, secret) => {
      if (g.marketMode !== 'shared') throw new GameError('請先平掉舊市場持倉再加入排行榜');
      return fn(g, body, t, secret);
    });
    const own = seasonParticipationView(g, t);
    return { status: 200, body: { optIn: own.status === 'active', nickname: own.nickname || null, myEntry: own.status === 'active' ? own : null, status: own.status, season: own.season } };
  } catch (e) {
    if (e instanceof GameError) throw new HttpError(400, 'game_error', e.message);
    throw e;
  }
}

async function deleteAccount(req, env) {
  const user = await requireUser(req, env);
  const u = await verifyCurrentPassword(env, user, await readJson(req, 4096));
  // FK ON DELETE CASCADE 原子刪除 games、sessions、舊 saves；CAS 防止驗密後重設競態。
  const deleted = await env.DB.prepare("DELETE FROM users WHERE id = ? AND pw_hash = ? AND pw_changed_at = ? RETURNING id")
    .bind(user.id, u.pw_hash, u.pw_changed_at).first();
  if (!deleted) throw new HttpError(401, "unauthorized", "憑證已變更，請重新登入");
  return { status: 200, body: { ok: true } };
}

async function onlineHeartbeat(req, env) {
  const body = await readJson(req, 256);
  if (typeof body.tabId !== 'string' || !/^[a-f0-9]{32}$/.test(body.tabId))
    throw new HttpError(400, 'bad_tab_id', '瀏覽器識別碼格式錯誤');
  // A token, if supplied, must be valid. Guest requests without a token remain anonymous.
  const user = req.headers.has('Authorization') ? await requireUser(req, env) : null;
  const data = await presence(env, body.tabId, user?.id ?? null);
  return { status: 200, body: data };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  return JSON.stringify(value);
}

const ROUTES = {
  "POST /api/online": onlineHeartbeat,
  "POST /api/register": register,
  "POST /api/login": login,
  "POST /api/logout": logout,
  "GET /api/me": me,
  "POST /api/reset-password": resetPassword,
  "POST /api/recovery-code": newRecovery,
  "GET /api/game": gameState,
  "POST /api/game/open": gameOpen,
  "POST /api/game/close": gameClose,
  "POST /api/game/reset": gameReset,
  "POST /api/game/borrow": gameBorrow,
  "POST /api/game/repay": gameRepay,
  "POST /api/game/margin": gameMargin,
  "POST /api/game/refuse-help": gameRefuse,
  "GET /api/leaderboard": leaderboardList,
  "GET /api/leaderboard/me": leaderboardMe,
  "POST /api/leaderboard/join": leaderboardJoin,
  "POST /api/leaderboard/leave": leaderboardLeave,
  "DELETE /api/account": deleteAccount,
};

export default {
  async scheduled(event, env) { await captureSentiment(env, event.scheduledTime); await prunePresence(env, event.scheduledTime); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    if (url.pathname === "/" || url.pathname === "/api/health") return json({ ok: true, service: "fxweb-api" }, 200, req, env);
    const handler = ROUTES[`${req.method} ${url.pathname}`];
    if (!handler) return json({ error: "not_found", message: "找不到這個 API" }, 404, req, env);
    try {
      const { status, body } = await handler(req, env);
      return json(body, status, req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message, ...(e.extra || {}) }, e.status, req, env);
      console.error(e);
      return json({ error: "server_error", message: "伺服器錯誤" }, 500, req, env);
    }
  },
};
