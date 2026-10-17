// 本機訪客存檔。帳戶與行情必須同份儲存，不能把舊持倉接到新行情。
import { exportMarketState, restoreMarketState } from "./market.mjs";
export const SAVE_KEY = "fxweb.save.v1"; // retain the old key so legacy saves can be identified
export const BACKUP_KEY = `${SAVE_KEY}.backup`;
export const SAVE_VERSION = 2;

// 帳戶格式仍供 cloud 使用，勿將私有行情混入雲端帳戶。
export function snapshot(state) {
  const s = { cash: state.cash, positions: state.positions, nextId: state.nextId, startingCash: state.startingCash, log: state.log.slice(-200) };
  if (state.loan) s.loan = state.loan;
  return s;
}

function validLoan(l) {
  return l && typeof l === "object" && typeof l.principal === "number" && Number.isFinite(l.principal) && l.principal > 0
    && typeof l.accrued === "number" && Number.isFinite(l.accrued) && l.accrued >= 0
    && typeof l.rateDaily === "number" && Number.isFinite(l.rateDaily) && l.rateDaily > 0;
}

export function normalize(d) {
  if (!d || typeof d.cash !== "number" || !Number.isFinite(d.cash) || !Array.isArray(d.positions) || (d.log !== undefined && !Array.isArray(d.log))) return null;
  const out = { cash: d.cash, positions: d.positions, log: d.log || [], nextId: d.nextId || 1, startingCash: d.startingCash || 10000 };
  if (validLoan(d.loan)) out.loan = { principal: d.loan.principal, accrued: d.loan.accrued, rateDaily: d.loan.rateDaily, openedAt: d.loan.openedAt || 0 };
  return out;
}

function preserve(raw) {
  // First backup is immutable: repeated saves/reset must not destroy the original.
  if (localStorage.getItem(BACKUP_KEY) === null) localStorage.setItem(BACKUP_KEY, raw);
  return BACKUP_KEY;
}

// No automatic migration or writes to the source key. A legacy account is DATA for
// the app's explicit recovery dialog, never permission to trade at new prices.
export function loadGuest() {
  let raw;
  try {
    raw = localStorage.getItem(SAVE_KEY);
    if (raw === null) return { status: "empty" };
    const d = JSON.parse(raw);
    if (d && d.version === SAVE_VERSION) {
      const account = normalize(d.account);
      if (!account) throw new Error("Invalid account snapshot");
      const market = restoreMarketState(d.market);
      if (account.positions.some(p => !p || !Object.hasOwn(market.prices, p.pair))) throw new Error("Position missing market quote");
      return { status: "ready", account, market, version: SAVE_VERSION };
    }
    if (d && d.version !== undefined) throw new Error("Unsupported save version");
    const account = normalize(d);
    if (!account) throw new Error("Invalid legacy account");
    return { status: "legacy-missing-market", account, backupKey: preserve(raw) };
  } catch (e) {
    let backupKey = null;
    try { if (raw !== undefined && raw !== null) backupKey = preserve(raw); } catch {}
    return { status: "invalid", backupKey, error: String(e.message || e) };
  }
}

export function guestSnapshot(state, market) {
  const account = normalize(snapshot(state));
  if (!account) throw new Error("Invalid account snapshot");
  const ms = exportMarketState(typeof market?.exportState === "function" ? market.exportState() : market);
  if (account.positions.some(p => !p || !Object.hasOwn(ms.prices, p.pair))) throw new Error("Position missing market quote");
  return { version: SAVE_VERSION, account, market: ms };
}

export function save(state, market) {
  try {
    const text = JSON.stringify(guestSnapshot(state, market));
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw !== null) {
      let prior;
      try { prior = JSON.parse(raw); } catch {}
      if (prior?.version !== SAVE_VERSION) preserve(raw);
    }
    localStorage.setItem(SAVE_KEY, text); // one atomic write, never split account/market
    return true;
  } catch { return false; }
}

// Compatibility helper is intentionally fail-closed for open positions. Only
// loadGuest() supplies enough information to safely resume a trading account.
export function load() {
  const result = loadGuest();
  return result.status === "ready" && result.account.positions.length === 0 ? result.account : null;
}

// Explicit reset clears the active save only. Original recovery backup survives.
export function clear() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw !== null) {
      let prior;
      try { prior = JSON.parse(raw); } catch {}
      if (prior?.version !== SAVE_VERSION) preserve(raw);
    }
    localStorage.removeItem(SAVE_KEY);
  } catch {}
}

export function exportText(state, market) {
  return JSON.stringify(market === undefined ? state : guestSnapshot(state, market), null, 2);
}

// Explicit recovery APIs for the app's download/confirmation UI. Never discard
// the first backup, even if reset fails due to storage quota/security errors.
export function archiveGuest() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw !== null) preserve(raw);
    const text = localStorage.getItem(BACKUP_KEY);
    return text === null ? { ok: false, error: "No save to archive" } : { ok: true, backupKey: BACKUP_KEY, text };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

export function resetGuest(state, market) {
  // Caller must obtain explicit consent before invoking; this API never carries
  // old positions over and refuses non-fresh account data.
  if (!state || !Array.isArray(state.positions) || state.positions.length !== 0) return false;
  try {
    const text = JSON.stringify(guestSnapshot(state, market));
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw !== null) preserve(raw);
    localStorage.setItem(SAVE_KEY, text);
    return true;
  } catch { return false; }
}
