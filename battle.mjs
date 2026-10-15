// 經典戰役：用真實歷史日收盤價（ECB 參考匯率，經 Frankfurter 取得後內建在 battle-data.mjs）回放。
// 介面和 market.mjs 的 createMarket 相同，畫面程式不用分兩套；一根 K 線 = 一個交易日。
// 只有日收盤價，沒有盤中高低點：K 線開盤 = 前一日收盤，高 / 低 = 開收的較大 / 較小值。
import { BATTLE_DATA } from "./battle-data.mjs?v=20261016b";
import { PAIRS } from "./market.mjs?v=20261016b";

export const BATTLES = [
  { id: "franc-2015", title: "瑞郎脫鉤黑天鵝", pair: "USD/CHF", event: "2015-01-15", start: "2014-12-01",
    description: "瑞士央行突然取消歐元兌瑞郎 1.20 的最低匯率，瑞郎一天內暴漲。",
    source: "https://www.snb.ch/en/the-snb/organisation/history/geld-und-waehrungspolitische-chronik",
    news: [
      { date: "2014-12-18", tag: "央行政策", title: "瑞士央行宣布負利率", body: "瑞士央行對活期存款實施負利率，並重申會守住 1 歐元兌 1.20 瑞郎的最低匯率。" },
      { date: "2015-01-12", tag: "市場觀察", title: "市場仍把 1.20 當作政策底線", body: "交易者普遍圍繞最低匯率布置倉位，瑞郎的波動被政策承諾壓住。" },
      { date: "2015-01-15", tag: "突發決議", title: "瑞士央行取消最低匯率", body: "瑞士央行停止維持 1.20 下限，並把活期存款利率降到 -0.75%。市場流動性瞬間蒸發。" },
    ] },
  { id: "brexit-2016", title: "英國脫歐公投", pair: "GBP/USD", event: "2016-06-24", start: "2016-05-16",
    description: "英國公投結果出爐，選擇離開歐盟，英鎊應聲重挫。",
    source: "https://www.bankofengland.co.uk/news/2016/june/statement-from-the-governor-of-the-boe-following-the-eu-referendum-result",
    news: [
      { date: "2016-06-14", tag: "風險提示", title: "英國央行警示公投風險", body: "英國央行把脫歐公投視為顯著的短期金融穩定風險，市場開始提高英鎊波動預期。" },
      { date: "2016-06-23", tag: "投票日", title: "英國舉行歐盟成員資格公投", body: "投票結束後各地結果陸續公布，市場對最終結果仍有明顯分歧。" },
      { date: "2016-06-24", tag: "結果公布", title: "英國投票決定離開歐盟", body: "脫歐陣營勝出。英國央行表示準備提供超過 2,500 億英鎊的額外資金支持市場運作。" },
    ] },
  { id: "parity-2022", title: "歐元跌破平價", pair: "EUR/USD", event: "2022-07-12", start: "2022-06-01",
    description: "美元強勢，歐元兌美元二十年來首次逼近 1:1。",
    source: "https://www.ecb.europa.eu/press/pr/date/2022/html/ecb.mp220721~53e5bdd317.en.html",
    news: [
      { date: "2022-06-09", tag: "政策預告", title: "歐洲央行預告結束負利率", body: "歐洲央行計畫 7 月升息 1 碼，並表示若通膨前景惡化，9 月可能升得更多。" },
      { date: "2022-07-12", tag: "關鍵價位", title: "歐元兌美元觸及平價", body: "能源風險、成長疑慮與美元走強疊加，1 歐元幾乎只能換 1 美元。" },
      { date: "2022-07-21", tag: "利率決議", title: "歐洲央行升息 2 碼", body: "歐洲央行以高於先前指引的幅度升息，並推出傳導保護工具 TPI。" },
    ] },
  { id: "yen-2022", title: "日圓干預時刻", pair: "USD/JPY", event: "2022-09-22", start: "2022-08-15",
    description: "日本當局進場買入日圓，美元兌日圓劇烈震盪。",
    source: "https://www.mof.go.jp/english/policy/international_policy/reference/feio/index.html",
    news: [
      { date: "2022-09-07", tag: "口頭干預", title: "日本當局關注日圓單邊走勢", body: "美元兌日圓快速上衝，日本官員對單邊、急速的匯率變動表達擔憂。" },
      { date: "2022-09-22", tag: "市場干預", title: "日本實施買入日圓干預", body: "日本央行維持寬鬆後，日本當局進場買入日圓，24 年來首見。" },
      { date: "2022-10-21", tag: "劇烈波動", title: "美元兌日圓高位急速回落", body: "匯率在 150 以上急轉直下，市場隨後確認日本再次進場干預。" },
    ] },
];

export const battleById = id => BATTLES.find(b => b.id === id) || null;
export const dateAt = (id, i) => BATTLE_DATA[id]?.dates[i] || "";

// 戰役開始的索引：第一個 >= start 的交易日（前面的資料當作歷史 K 線）。
export function startIndex(id) {
  const d = BATTLE_DATA[id], b = battleById(id);
  if (!d || !b) return 0;
  const i = d.dates.findIndex(x => x >= b.start);
  return i < 0 ? 0 : i;
}

export function createBattleMarket(id, cursor) {
  const b = battleById(id), d = BATTLE_DATA[id];
  if (!b || !d) throw new Error("找不到這場戰役");
  const last = d.dates.length - 1;
  let at = Math.max(0, Math.min(last, Number.isInteger(cursor) ? cursor : startIndex(id)));
  const pairs = Object.keys(PAIRS);
  const candleCache = {};
  for (const p of pairs) {
    const s = d.prices[p];
    candleCache[p] = s.map((c, i) => { const o = i ? s[i - 1] : c; return { t: i, o, h: Math.max(o, c), l: Math.min(o, c), c }; });
  }
  const newsItems = b.news.map(n => ({ ...n, step: d.dates.findIndex(x => x >= n.date), pair: b.pair, text: n.title, battle: true, settled: true, reversed: false, claimed: 0 }))
    .filter(n => n.step >= 0);
  const prices = () => Object.fromEntries(pairs.map(p => [p, d.prices[p][at]]));
  return {
    battle: true, id, info: b,
    prices,
    get: p => d.prices[p] ? d.prices[p][at] : undefined,
    pairs: () => pairs,
    candles: p => candleCache[p].slice(0, at + 1),
    news: () => newsItems.filter(n => n.step <= at),
    step: () => at,
    ready: () => true,
    date: () => d.dates[at],
    dates: () => d.dates,
    cursor: () => at,
    atEnd: () => at >= last,
    remaining: () => last - at,
    progress: () => { const s = startIndex(id); return { day: at - s, days: last - s }; },
    // 推進一個交易日，回傳當天新出現的戰役新聞。
    next() {
      if (at >= last) return { prices: prices(), news: [] };
      at++;
      return { prices: prices(), news: newsItems.filter(n => n.step === at) };
    },
  };
}

/* ---------- 戰役存檔（本機） ---------- */
const KEY = "fxweb.battle.v1";
export function loadBattleSave() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!s || !battleById(s.id) || !Number.isInteger(s.cursor) || !s.account || typeof s.account.cash !== "number" || !Array.isArray(s.account.positions)) return null;
    return s;
  } catch { return null; }
}
export function saveBattle(id, cursor, account) {
  try { localStorage.setItem(KEY, JSON.stringify({ id, cursor, account: { cash: account.cash, positions: account.positions, nextId: account.nextId, startingCash: account.startingCash, log: account.log.slice(-200), ...(account.loan ? { loan: account.loan } : {}) } })); } catch {}
}
export function clearBattleSave() { try { localStorage.removeItem(KEY); } catch {} }
