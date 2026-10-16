// 伺服器行情的本機鏡像：介面和 market.mjs 的 createMarket 一樣，畫面程式不用分兩套。
// 這裡只存伺服器給的資料，不會自己產生價格。
import { PAIRS } from "./market.mjs?v=20261016l";

const HISTORY = 160;

export function createRemoteMarket() {
  let prices = {}, candles = {}, news = [], step = -1;
  for (const p of Object.keys(PAIRS)) candles[p] = [];
  return {
    remote: true,
    prices: () => ({ ...prices }),
    get: p => prices[p],
    pairs: () => Object.keys(PAIRS),
    candles: p => candles[p],
    news: () => news,
    step: () => step,
    ready: () => step >= 0,
    // 套用伺服器回應，回傳新出現的新聞
    apply(v) {
      const fresh = [];
      if (v.full) { for (const p of Object.keys(PAIRS)) candles[p] = (v.candles[p] || []).slice(); }
      else for (const p of Object.keys(PAIRS)) {
        const add = (v.candles[p] || []).filter(c => !candles[p].length || c.t > candles[p][candles[p].length - 1].t);
        candles[p].push(...add);
        if (candles[p].length > HISTORY) candles[p].splice(0, candles[p].length - HISTORY);
      }
      prices = { ...v.prices };
      const key = n => n.step + n.pair + (n.event || "");
      const known = new Map(news.map(n => [key(n), n]));
      for (const n of v.news) {
        const k = key(n);
        if (known.has(k)) Object.assign(known.get(k), n);
        else { news.push(n); if (step >= 0 && n.step > step - 2) fresh.push(n); }
      }
      news.sort((a, b) => a.step - b.step);
      if (news.length > 50) news.splice(0, news.length - 50);
      step = v.step;
      return fresh;
    },
  };
}
