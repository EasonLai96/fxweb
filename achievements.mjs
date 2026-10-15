// 成就冊：12 個成就，對應 bilibili「FX 简单!」的成就（名稱改寫為繁體）。
// 判定在瀏覽器進行（訪客、登入、經典戰役共用），解鎖紀錄存在這台裝置，依身分分開保存。
// 這是好玩的紀念冊，不是伺服器認證的成績；伺服器的練習里程碑另外計算。

export const FOLLOW_URL = "https://space.bilibili.com/443211651";
export const NEVER_SELL_MS = 3 * 60 * 1000;   // 即時行情：單筆持續浮虧 3 分鐘
export const NEVER_SELL_DAYS = 15;            // 經典戰役：單筆持續浮虧 15 個交易日
export const BUY_TOP_WINDOW = 40;             // 近 40 根 K 線
export const BUY_TOP_RANGE = 0.998;           // 最高價 0.2% 以內

export const ACHIEVEMENTS = [
  { id: "fx-simple", name: "fx，簡單！", desc: "淨資產比初始資金多出 $100,000（浮盈也算，借款要扣掉）。", hint: "讓淨資產比 $10,000 高出十萬" },
  { id: "buy-top", name: "現在買入，一定爆賺", desc: "在近 40 根 K 線最高價的 0.2% 以內做多。", hint: "在近期最高價附近做多" },
  { id: "finger-support", name: "手指支撐線", desc: "借款補倉救過的倉位，最後還是被強制平倉。", hint: "借款補倉後仍被強制平倉" },
  { id: "never-sell", name: "不賣就不算虧", desc: "單筆倉位累計浮虧 3 分鐘（經典戰役為 15 個交易日）仍不平倉。", hint: "長時間抱著虧損單不放手" },
  { id: "just-kill-me", name: "殺就殺吧", desc: "風險提醒選了「暫不處理」，隨後被強制平倉。", hint: "拒絕補倉，直到爆倉" },
  { id: "killed-by-chf", name: "被瑞士殺死了", desc: "在「瑞郎脫鉤」經典戰役裡親歷 2015-01-15 事件日。", hint: "把瑞郎脫鉤戰役推進到事件日" },
  { id: "innocent-cat", name: "本喵明明沒做壞事", desc: "第一次被強制平倉。", hint: "經歷一次爆倉" },
  { id: "sorry-family", name: "最對不起的就是家人", desc: "單筆借款本金達到 $100,000。", hint: "一次借入十萬" },
  { id: "sure-win", name: "我有必勝法", desc: "淨資產比初始資金多出 $1,000,000。", hint: "收益達到一百萬" },
  { id: "honest-work", name: "老實賺錢，很枯燥吧", desc: "完成第一次獲利平倉。", hint: "獲利平倉一次" },
  { id: "rooftop", name: "天台見", desc: "淨資產比初始資金少了 $100,000。", hint: "淨資產比 $10,000 低十萬" },
  { id: "thanks-meow", name: "感謝支持喵", desc: "去 bilibili 關注原作 UP 主「-會飛的蟈蟈-」。", hint: "點「去關注」打開 UP 主主頁", follow: true },
];

const KEY = "fxweb.achievements.v1";
const DEF = new Map(ACHIEVEMENTS.map(a => [a.id, a]));

function readAll() {
  try { const d = JSON.parse(localStorage.getItem(KEY) || "null"); return d && typeof d === "object" && !Array.isArray(d) ? d : {}; }
  catch { return {}; }
}

// onUnlock(def, iso) 在第一次解鎖時呼叫一次（用來顯示提示）。
export function createAchievementBook({ onUnlock = () => {} } = {}) {
  let owner = "guest";
  let unlocked = {};
  const load = () => {
    const all = readAll(), mine = all[owner];
    unlocked = {};
    if (mine && typeof mine === "object") for (const [id, ts] of Object.entries(mine)) if (DEF.has(id) && typeof ts === "string") unlocked[id] = ts;
  };
  const persist = () => {
    try { const all = readAll(); all[owner] = unlocked; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* 無痕模式等情況：只在記憶體 */ }
  };
  load();

  // 浮虧計時：key = 模式 + 持倉編號，只記在記憶體。
  const losing = new Map();

  const book = {
    get owner() { return owner; },
    setOwner(next) { next = next || "guest"; if (next === owner) return; owner = next; load(); losing.clear(); },
    resetTimers() { losing.clear(); },
    has: id => !!unlocked[id],
    unlocked: () => ({ ...unlocked }),
    count: () => ACHIEVEMENTS.filter(a => unlocked[a.id]).length,
    total: ACHIEVEMENTS.length,
    list: ACHIEVEMENTS,
    followUrl: FOLLOW_URL,
    unlock(id) {
      const def = DEF.get(id);
      if (!def || unlocked[id]) return false;
      const iso = new Date().toISOString();
      unlocked[id] = iso; persist();
      onUnlock(def, iso);
      return true;
    },

    /* ---------- 各種判定 ---------- */
    // 帳戶狀態：淨資產門檻、借款本金。
    checkAccount({ netWorth, startingCash = 10000, loanPrincipal = 0 }) {
      if (Number.isFinite(netWorth)) {
        const profit = netWorth - startingCash;
        if (profit >= 100000) book.unlock("fx-simple");
        if (profit >= 1000000) book.unlock("sure-win");
        if (profit <= -100000) book.unlock("rooftop");
      }
      if (loanPrincipal >= 100000) book.unlock("sorry-family");
    },
    // 開多：進場價在近 40 根最高價 0.2% 內。
    checkOpen({ side, entry, candles }) {
      if (side !== 1 || !Array.isArray(candles) || !candles.length || !(entry > 0)) return;
      const top = Math.max(...candles.slice(-BUY_TOP_WINDOW).map(c => c.h));
      if (Number.isFinite(top) && entry >= top * BUY_TOP_RANGE) book.unlock("buy-top");
    },
    // 手動平倉。
    checkClose({ pnl }) { if (pnl > 0) book.unlock("honest-work"); },
    // 強制平倉事件：{ borrowed, refused }。
    checkLiquidation(ev) {
      book.unlock("innocent-cat");
      if (ev && ev.borrowed) book.unlock("finger-support");
      if (ev && ev.refused) book.unlock("just-kill-me");
    },
    // 浮虧計時。scope 區分模式，positions/pnlOf 由呼叫端提供；ms 與 days 擇一。
    trackLosses(scope, positions, pnlOf, { ms = 0, days = 0 } = {}) {
      const alive = new Set();
      for (const pos of positions) {
        const key = `${scope}:${pos.id}`;
        alive.add(key);
        const pnl = pnlOf(pos);
        if (!(pnl < 0)) continue;
        const cur = losing.get(key) || { ms: 0, days: 0 };
        cur.ms += ms; cur.days += days;
        losing.set(key, cur);
        if (cur.ms >= NEVER_SELL_MS || cur.days >= NEVER_SELL_DAYS) book.unlock("never-sell");
      }
      for (const key of [...losing.keys()]) if (key.startsWith(scope + ":") && !alive.has(key)) losing.delete(key);
    },
    lossTime(scope, id) { return losing.get(`${scope}:${id}`) || { ms: 0, days: 0 }; },
  };
  return book;
}
