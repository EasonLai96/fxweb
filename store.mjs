// 本機存檔（localStorage）。登入後另外同步到雲端。內容由瀏覽器產生，可被修改，不是可信成績。
const KEY = "fxweb.save.v1";

// 要存的欄位（本機與雲端共用同一格式）
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
  if (!d || typeof d.cash !== "number" || !Array.isArray(d.positions)) return null;
  const out = { cash: d.cash, positions: d.positions, log: d.log || [], nextId: d.nextId || 1, startingCash: d.startingCash || 10000 };
  if (validLoan(d.loan)) out.loan = { principal: d.loan.principal, accrued: d.loan.accrued, rateDaily: d.loan.rateDaily, openedAt: d.loan.openedAt || 0 };
  return out;
}

export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(snapshot(state))); return true; } catch { return false; }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw));
  } catch { return null; }
}

export function clear() { try { localStorage.removeItem(KEY); } catch {} }

export function exportText(state) { return JSON.stringify(state, null, 2); }
