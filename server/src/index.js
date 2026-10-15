// fxweb 後端：Cloudflare Worker + D1。帳號密碼登入、雲端存檔。
// 密碼：PBKDF2-SHA256（Workers 上限 100000 次迭代）+ 每人隨機 salt。
// 登入憑證：隨機 token，以 Authorization: Bearer 傳遞；資料庫只存 token 的 SHA-256。
// 前端在 github.io、API 在 workers.dev，跨站 cookie 常被瀏覽器擋，所以用 Bearer token 而不是 cookie。

const PBKDF2_ITER = 100000;
const SESSION_DAYS = 30;
const MAX_SAVE_BYTES = 64 * 1024;
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

async function readJson(req, limit = MAX_SAVE_BYTES + 1024) {
  const len = Number(req.headers.get("Content-Length") || 0);
  if (len > limit) throw new HttpError(413, "too_large", "資料太大");
  const text = await req.text();
  if (enc.encode(text).length > limit) throw new HttpError(413, "too_large", "資料太大");
  try { return JSON.parse(text || "{}"); } catch { throw new HttpError(400, "bad_json", "格式錯誤"); }
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

/* ---------- Session ---------- */
async function createSession(env, userId) {
  const token = b64(randomBytes(32)).replace(/[+/=]/g, c => ({ "+": "-", "/": "_", "=": "" }[c]));
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256hex(token), userId, t, t + SESSION_DAYS * 86400000).run();
  // 順手清掉過期 session
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(t).run();
  return token;
}

async function requireUser(req, env) {
  const m = (req.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
  if (!m) throw new HttpError(401, "unauthorized", "請先登入");
  const th = await sha256hex(m[1]);
  const row = await env.DB.prepare(`SELECT s.user_id, s.expires_at, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(th).first();
  if (!row || row.expires_at < now()) throw new HttpError(401, "unauthorized", "登入已過期，請重新登入");
  return { id: row.user_id, username: row.username, tokenHash: th };
}

/* ---------- 驗證輸入 ---------- */
function validateCreds(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!USERNAME_RE.test(username)) throw new HttpError(400, "bad_username", "帳號需為 3~20 個英文字母、數字或底線");
  if (password.length < 8 || password.length > 128) throw new HttpError(400, "bad_password", "密碼長度需為 8~128 個字元");
  return { username, password };
}

// 存檔只檢查基本結構與大小；內容由玩家瀏覽器產生，不可當成可信成績。
function validateSave(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "bad_save", "存檔格式錯誤");
  if (typeof data.cash !== "number" || !Number.isFinite(data.cash)) throw new HttpError(400, "bad_save", "存檔缺少 cash");
  if (!Array.isArray(data.positions) || data.positions.length > 200) throw new HttpError(400, "bad_save", "持倉格式錯誤");
  const text = JSON.stringify(data);
  if (enc.encode(text).length > MAX_SAVE_BYTES) throw new HttpError(413, "too_large", "存檔太大");
  return text;
}

/* ---------- 路由 ---------- */
async function register(req, env) {
  const { username, password } = validateCreds(await readJson(req, 4096));
  const ip = req.headers.get("CF-Connecting-IP") || "local";
  await checkRate(env, "reg:" + ip);
  const salt = randomBytes(16);
  const hash = b64(await pbkdf2(password, salt, PBKDF2_ITER));
  try {
    const r = await env.DB.prepare("INSERT INTO users (username, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(username, hash, b64(salt), PBKDF2_ITER, now()).run();
    await recordFail(env, "reg:" + ip); // 註冊次數也算進節流，避免大量灌帳號
    const userId = r.meta.last_row_id;
    return { status: 201, body: { token: await createSession(env, userId), user: { username } } };
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
  const u = await env.DB.prepare("SELECT id, username, pw_hash, pw_salt, pw_iter FROM users WHERE username = ?").bind(username).first();
  const calc = b64(await pbkdf2(password, u ? unb64(u.pw_salt) : DUMMY_SALT, u ? u.pw_iter : PBKDF2_ITER));
  if (!u || !safeEqual(calc, u.pw_hash)) {
    await recordFail(env, key);
    throw new HttpError(401, "bad_credentials", "帳號或密碼錯誤");
  }
  await clearFails(env, key);
  return { status: 200, body: { token: await createSession(env, u.id), user: { username: u.username } } };
}

async function logout(req, env) {
  const user = await requireUser(req, env);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
  return { status: 200, body: { ok: true } };
}

async function me(req, env) {
  const user = await requireUser(req, env);
  const s = await env.DB.prepare("SELECT version, updated_at FROM saves WHERE user_id = ?").bind(user.id).first();
  return { status: 200, body: { user: { username: user.username }, save: s ? { version: s.version, updatedAt: s.updated_at } : null } };
}

async function getSave(req, env) {
  const user = await requireUser(req, env);
  const s = await env.DB.prepare("SELECT data, version, updated_at FROM saves WHERE user_id = ?").bind(user.id).first();
  if (!s) return { status: 200, body: { save: null } };
  return { status: 200, body: { save: { data: JSON.parse(s.data), version: s.version, updatedAt: s.updated_at } } };
}

// 樂觀鎖：前端帶上它最後看到的 version（第一次存為 0）。版本對不上表示別的裝置先存過，回 409 讓前端決定。
async function putSave(req, env) {
  const user = await requireUser(req, env);
  const body = await readJson(req);
  const base = Number.isInteger(body.baseVersion) ? body.baseVersion : -1;
  const force = body.force === true;
  const text = validateSave(body.data);
  const t = now();
  if (force) {
    const r = await env.DB.prepare(`INSERT INTO saves (user_id, data, version, updated_at) VALUES (?1, ?2, 1, ?3)
      ON CONFLICT(user_id) DO UPDATE SET data = ?2, version = version + 1, updated_at = ?3 RETURNING version`).bind(user.id, text, t).first();
    return { status: 200, body: { version: r.version, updatedAt: t } };
  }
  let r;
  if (base === 0) {
    r = await env.DB.prepare(`INSERT INTO saves (user_id, data, version, updated_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(user_id) DO NOTHING RETURNING version`).bind(user.id, text, t).first();
  } else {
    r = await env.DB.prepare(`UPDATE saves SET data = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ? RETURNING version`)
      .bind(text, t, user.id, base).first();
  }
  if (!r) {
    const cur = await env.DB.prepare("SELECT data, version, updated_at FROM saves WHERE user_id = ?").bind(user.id).first();
    throw new HttpError(409, "conflict", "雲端存檔已被其他裝置更新", cur ? { server: { data: JSON.parse(cur.data), version: cur.version, updatedAt: cur.updated_at } } : { server: null });
  }
  return { status: 200, body: { version: r.version, updatedAt: t } };
}

async function deleteAccount(req, env) {
  const user = await requireUser(req, env);
  const body = await readJson(req, 4096);
  const u = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter FROM users WHERE id = ?").bind(user.id).first();
  const calc = b64(await pbkdf2(String(body.password || ""), unb64(u.pw_salt), u.pw_iter));
  if (!safeEqual(calc, u.pw_hash)) throw new HttpError(401, "bad_credentials", "密碼錯誤");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM saves WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  return { status: 200, body: { ok: true } };
}

const ROUTES = {
  "POST /api/register": register,
  "POST /api/login": login,
  "POST /api/logout": logout,
  "GET /api/me": me,
  "GET /api/save": getSave,
  "PUT /api/save": putSave,
  "DELETE /api/account": deleteAccount,
};

export default {
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
