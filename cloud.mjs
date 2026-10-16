// 帳號與伺服器端遊戲 API。token 存在 localStorage，以 Authorization: Bearer 傳給後端。
import { API_BASE } from "./config.mjs?v=20261016i";

const AUTH_KEY = "fxweb.auth.v1";
export const enabled = () => !!API_BASE;

let auth = null;
try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { auth = null; }
function persist() { try { auth ? localStorage.setItem(AUTH_KEY, JSON.stringify({ token: auth.token, username: auth.username })) : localStorage.removeItem(AUTH_KEY); } catch {} }

export const user = () => (auth ? auth.username : null);

export class ApiError extends Error {
  constructor(status, body) { super((body && body.message) || `連線失敗（${status}）`); this.status = status; this.body = body || {}; }
}

let onLogout = () => {};
export function onSessionLost(fn) { onLogout = fn; }

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const sentToken = auth?.token;
  if (sentToken) headers.Authorization = "Bearer " + sentToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let res;
  try { res = await fetch(API_BASE + path, { method, headers, signal: controller.signal, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new ApiError(0, { message: "連線失敗或逾時。交易結果可能尚未確認，請先重新整理帳戶，不要重複下單。" }); }
  finally { clearTimeout(timeout); }
  const responseType = res.headers.get("content-type") || "";
  if (!responseType.includes("application/json")) {
    throw new ApiError(res.status, { message: res.status === 503 || res.status === 429
      ? "伺服器暫時超出運算額度，請稍候重試；帳戶資料仍保存在伺服器。"
      : `伺服器回傳異常格式（HTTP ${res.status}），請稍候再試。` });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "unauthorized" && auth?.token === sentToken && sentToken) { auth = null; persist(); onLogout(); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function setAuth(r) { auth = { token: r.token, username: r.user.username }; persist(); }

export async function register(username, password) { const r = await api("POST", "/api/register", { username, password }); setAuth(r); return r.recoveryCode; }
export async function login(username, password) { const r = await api("POST", "/api/login", { username, password }); setAuth(r); }
export async function resetPassword(username, recoveryCode, newPassword) {
  const r = await api("POST", "/api/reset-password", { username, recoveryCode, newPassword }); setAuth(r); return r.recoveryCode;
}
export async function newRecoveryCode(password) { return (await api("POST", "/api/recovery-code", { password })).recoveryCode; }
export async function logout() { try { await api("POST", "/api/logout"); } catch {} auth = null; persist(); }
export async function deleteAccount(password) { await api("DELETE", "/api/account", { password }); auth = null; persist(); }

export const me = () => api("GET", "/api/me");
export const online = tabId => api("POST", "/api/online", { tabId });
export const leaderboard = {
  list: () => api("GET", "/api/leaderboard"),
  me: () => api("GET", "/api/leaderboard/me"),
  join: nickname => api("POST", "/api/leaderboard/join", { nickname }),
  leave: () => api("POST", "/api/leaderboard/leave", {}),
};
export const game = {
  state: since => api("GET", `/api/game?since=${since}`),
  open: (order, since) => api("POST", "/api/game/open", { ...order, since, requestId: crypto.randomUUID() }),
  close: (id, since) => api("POST", "/api/game/close", { id, since, requestId: crypto.randomUUID() }),
  reset: since => api("POST", "/api/game/reset", { since, requestId: crypto.randomUUID() }),
  borrow: (amount, since) => api("POST", "/api/game/borrow", { amount, since, requestId: crypto.randomUUID() }),
  repay: (amount, since) => api("POST", "/api/game/repay", { amount, since, requestId: crypto.randomUUID() }),
  margin: (id, amount, source, since) => api("POST", "/api/game/margin", { id, amount, source, since, requestId: crypto.randomUUID() }),
  refuseHelp: (id, since) => api("POST", "/api/game/refuse-help", { id, since, requestId: crypto.randomUUID() }),
};
