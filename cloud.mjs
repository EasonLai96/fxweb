// 雲端帳號與存檔。token 存在 localStorage，以 Authorization: Bearer 傳給後端。
import { API_BASE } from "./config.mjs";

const AUTH_KEY = "fxweb.auth.v1";
export const enabled = () => !!API_BASE;

let auth = null;
try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); } catch { auth = null; }

function persist() {
  try { auth ? localStorage.setItem(AUTH_KEY, JSON.stringify(auth)) : localStorage.removeItem(AUTH_KEY); } catch {}
}

export const user = () => (auth ? auth.username : null);
export const version = () => (auth ? auth.version || 0 : 0);
export function setVersion(v) { if (auth) { auth.version = v; persist(); } }

export class ApiError extends Error {
  constructor(status, body) { super((body && body.message) || `連線失敗（${status}）`); this.status = status; this.body = body || {}; }
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) headers.Authorization = "Bearer " + auth.token;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { message: "連不上伺服器，請檢查網路" });
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && auth && path !== "/api/login") { auth = null; persist(); }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export async function register(username, password) {
  const r = await api("POST", "/api/register", { username, password });
  auth = { token: r.token, username: r.user.username, version: 0 }; persist();
  return r.user;
}

export async function login(username, password) {
  const r = await api("POST", "/api/login", { username, password });
  auth = { token: r.token, username: r.user.username, version: 0 }; persist();
  return r.user;
}

export async function logout() {
  try { await api("POST", "/api/logout"); } catch {}
  auth = null; persist();
}

export async function fetchSave() {
  const r = await api("GET", "/api/save");
  return r.save; // { data, version, updatedAt } 或 null
}

export async function pushSave(data, { force = false } = {}) {
  const r = await api("PUT", "/api/save", force ? { force: true, data } : { baseVersion: version(), data });
  setVersion(r.version);
  return r;
}

export async function deleteAccount(password) {
  await api("DELETE", "/api/account", { password });
  auth = null; persist();
}
