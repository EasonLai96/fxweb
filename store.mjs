// 本機存檔。資料存在瀏覽器 localStorage，不上傳。可任意改，所以不可信——UI 要標明。
const KEY = "fxweb.save.v1";

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cash: state.cash, positions: state.positions, nextId: state.nextId, startingCash: state.startingCash, log: state.log.slice(-200) }));
    return true;
  } catch { return false; }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (typeof d.cash !== "number" || !Array.isArray(d.positions)) return null;
    return { cash: d.cash, positions: d.positions, log: d.log || [], nextId: d.nextId || 1, startingCash: d.startingCash || 10000 };
  } catch { return null; }
}

export function clear() { try { localStorage.removeItem(KEY); } catch {} }

export function exportText(state) { return JSON.stringify(state, null, 2); }
