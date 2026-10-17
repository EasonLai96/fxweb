// 帳號與伺服器端遊戲 API。token 存在 localStorage，以 Authorization: Bearer 傳給後端。
import { API_BASE } from "./config.mjs?v=20261017lab1";

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
    throw new ApiError(res.status, { outcomeUnknown: true, message: res.status === 503 || res.status === 429
      ? "伺服器暫時超出運算額度，請稍候重試；帳戶資料仍保存在伺服器。"
      : `伺服器回傳異常格式（HTTP ${res.status}），請稍候再試。` });
  }
  let data;
  try { data = await res.json(); }
  catch { throw new ApiError(res.status, { error: "invalid_response", outcomeUnknown: true, message: "伺服器回傳無效 JSON，交易結果尚未確認。" }); }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ApiError(res.status, { error: "invalid_response", outcomeUnknown: true, message: "伺服器回傳異常資料，交易結果尚未確認。" });
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
export const online = (tabId, visitorId) => api("POST", "/api/online", { tabId, visitorId });
export const rooms = {
  list: () => api("GET", "/api/rooms"),
  create: (name, nickname) => api("POST", "/api/rooms", { name, nickname }),
  join: (code, nickname) => api("POST", "/api/rooms/join", { code, nickname }),
  leave: code => api("POST", "/api/rooms/leave", { code }),
  board: code => api("GET", "/api/rooms/board?code=" + encodeURIComponent(code)),
};
export const leaderboard = {
  list: season => api("GET", "/api/leaderboard" + (season ? "?season=" + encodeURIComponent(season) : "")),
  me: () => api("GET", "/api/leaderboard/me"),
  join: nickname => api("POST", "/api/leaderboard/join", { nickname }),
  leave: () => api("POST", "/api/leaderboard/leave", {}),
};
// Receipt storage is deliberately separate from credentials. Never store headers/tokens.
const RECEIPTS_KEY = "fxweb.receipts.v1:";
const activeReceipts = new Set();
const unsettled = r => r.status === "pending" || r.status === "unknown";
const copy = value => JSON.parse(JSON.stringify(value));
function receiptError(error, message, id) {
  return new ApiError(0, { error, message, ...(id ? { receiptId: id } : {}) });
}
function accountName() {
  if (!auth?.username) throw receiptError("unauthorized", "請先登入帳號。");
  return auth.username;
}
function readReceipts(account) {
  try {
    const value = JSON.parse(localStorage.getItem(RECEIPTS_KEY + encodeURIComponent(account)) || "[]");
    if (!Array.isArray(value) || value.some(r => !r || r.id !== r.requestId || !r.body || r.body.requestId !== r.id ||
        typeof r.action !== "string" || !["pending", "unknown", "confirmed", "rejected", "acknowledged"].includes(r.status))) throw new Error();
    return value;
  } catch { throw receiptError("receipt_storage", "無法讀取交易回執，為避免重複操作，請先修復瀏覽器儲存空間。"); }
}
function writeReceipts(account, receipts) {
  // Only terminal receipts may be pruned. Uncertain operations must never disappear.
  while (receipts.length > 128) {
    const index = receipts.findIndex(r => !unsettled(r));
    if (index < 0) throw receiptError("receipt_storage", "待確認回執過多，無法安全送出交易。");
    receipts.splice(index, 1);
  }
  try { localStorage.setItem(RECEIPTS_KEY + encodeURIComponent(account), JSON.stringify(receipts)); }
  catch { throw receiptError("receipt_storage", "無法保存交易回執，已停止送出交易。"); }
}
function updateReceipt(account, id, fields) {
  const receipts = readReceipts(account);
  const receipt = receipts.find(r => r.id === id);
  if (!receipt) throw receiptError("receipt_missing", "找不到此帳號的交易回執。", id);
  Object.assign(receipt, fields, { updatedAt: Date.now() });
  writeReceipts(account, receipts);
  return receipt;
}
function findReceipt(account, id) {
  const receipt = readReceipts(account).find(r => r.id === id);
  if (!receipt) throw receiptError("receipt_missing", "找不到此帳號的交易回執。", id);
  return receipt;
}
export function listReceipts() {
  return auth?.username ? copy(readReceipts(auth.username)).map(r => ({ ...r,
    status: r.status === "pending" && !activeReceipts.has(r.id) ? "unknown" : r.status })) : [];
}
// UI-safe inspection retains an explicit blocked flag on storage failure; never
// interpret an unreadable receipt store as an empty/unlocked account.
export function receiptState() {
  try {
    const receipts = listReceipts();
    return { receipts, blocked: receipts.some(unsettled), error: null };
  } catch (error) {
    return { receipts: [], blocked: true, error: { code: error.body?.error || "receipt_storage", message: error.message } };
  }
}
// Only explicit JSON business rejections establish failure. Transport/proxy errors do not.
function isRejected(error) {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 &&
    ![408, 429].includes(error.status) && !error.body.outcomeUnknown && typeof error.body.error === "string";
}
function containsSecret(value) {
  return value && typeof value === "object" && Object.entries(value).some(([key, child]) =>
    /token|password|authorization|recoverycode/i.test(key) || containsSecret(child));
}
async function mutate(action, input) {
  const account = accountName();
  const sentToken = auth.token;
  // Do not queue a second click/tab into a new trade after the first succeeds.
  // Hold the account lock through settlement, so all tabs observe its durable
  // pending receipt or receive an immediate busy error. HTTP polling is unlocked.
  const run = () => {
    if (auth?.username !== account || auth?.token !== sentToken)
      throw receiptError("receipt_session_changed", "登入帳號已變更，已停止送出交易。");
    return mutateLocked(account, action, input);
  };
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request("fxweb.game.mutate:" + encodeURIComponent(account),
      { mode: "exclusive", ifAvailable: true }, lock => {
        if (!lock) throw receiptError("receipt_pending", "此帳號在其他分頁有交易處理中，請先確認交易結果。");
        return run();
      });
  }
  // Older browsers retain durable fail-closed checks, but localStorage itself
  // is not atomic across simultaneous tabs. Web Locks provide that guarantee.
  return run();
}
async function mutateLocked(account, action, input) {
  const receipts = readReceipts(account);
  const pending = receipts.find(unsettled);
  if (pending) throw receiptError("receipt_pending", "此帳號有尚未確認的交易，請先查詢回執及核對帳戶，不要重複下單。", pending.id);
  if (containsSecret(input)) throw receiptError("receipt_sensitive_body", "交易內容不可包含登入憑證。");
  const id = crypto.randomUUID();
  // Capture the actual wire JSON, not references the caller can mutate later.
  const body = copy({ ...input, requestId: id });
  const now = Date.now();
  receipts.push({ id, requestId: id, action, body, status: "pending", createdAt: now, updatedAt: now });
  writeReceipts(account, receipts); // Must complete before fetch starts.
  activeReceipts.add(id);
  try {
    const result = await api("POST", "/api/game/" + action, body);
    updateReceipt(account, id, { status: "confirmed", error: null });
    return result;
  } catch (error) {
    // A failed receipt write also leaves the previously saved pending record locked.
    updateReceipt(account, id, { status: isRejected(error) ? "rejected" : "unknown",
      error: { status: error.status || 0, code: error.body?.error || "unknown", message: error.message } });
    if (error instanceof ApiError) error.body.receiptId = id;
    throw error;
  } finally { activeReceipts.delete(id); }
}
export async function checkReceipt(id) {
  const account = accountName();
  findReceipt(account, id);
  const result = await api("GET", "/api/game/receipt?requestId=" + encodeURIComponent(id));
  if (result.receiptProtocolVersion !== 1 || result.retention?.maxReceipts !== 128 || result.retention?.bounded !== true ||
      !["confirmed", "unknown"].includes(result.status) || (result.status === "confirmed" && !result.result))
    throw receiptError("receipt_protocol", "伺服器尚未提供相容的交易回執協議；請勿重送。", id);
  if (result.status === "confirmed") updateReceipt(account, id, { status: "confirmed", error: null });
  else {
    const receipt = findReceipt(account, id);
    if (unsettled(receipt)) updateReceipt(account, id, { status: "unknown" });
  }
  return result;
}
export async function retryReceipt(id) {
  // The server retains only 128 receipts, with no safe time window. Missing may
  // mean evicted, not unexecuted: never POST an unknown ID, even if seconds old.
  // Confirmation reuses the original request ID and returns its recorded result.
  const receipt = await checkReceipt(id);
  if (receipt.status === "confirmed") return receipt.result;
  throw receiptError("receipt_unknown", "回執未知可能是紀錄已淘汰，無法安全重送；請先核對帳戶。", id);
}
export function acknowledgeReceipt(id) {
  // UI must require explicit user confirmation after checking account state.
  const account = accountName();
  const receipt = findReceipt(account, id);
  if (activeReceipts.has(id)) throw receiptError("receipt_pending", "交易仍在送出中，請稍候。", id);
  if (!unsettled(receipt)) return copy(receipt);
  return copy(updateReceipt(account, id, { status: "acknowledged", acknowledgedAt: Date.now() }));
}
export const game = {
  state: since => api("GET", `/api/game?since=${since}`),
  open: (order, since) => mutate("open", { ...order, since }),
  close: (id, since) => mutate("close", { id, since }),
  partialClose: (id, fraction, since) => mutate("close", { id, fraction, since }),
  reset: since => mutate("reset", { since }),
  borrow: (amount, since) => mutate("borrow", { amount, since }),
  repay: (amount, since) => mutate("repay", { amount, since }),
  margin: (id, amount, source, since) => mutate("margin", { id, amount, source, since }),
  stops: (id, sl, tp, since) => mutate("stops", { id, sl, tp, since }),
  refuseHelp: (id, since) => mutate("refuse-help", { id, since }),
};
