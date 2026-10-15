// 虛構行情產生器。固定種子 -> 可重播。這不是真實市場報價。
// 每 tick 產生一根 K 線；參考 fx-simple 的觀察值（±0.21%、1.8% 跳空、新聞 24% 反向），但這是自己的實作。

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAIRS = {
  "EUR/USD": 1.0874,
  "GBP/USD": 1.2712,
  "USD/JPY": 149.82,
  "USD/CHF": 0.8846,
  "AUD/USD": 0.6631,
  "USD/CAD": 1.3684,
};

export const PAIR_NAMES = {
  "EUR/USD": "歐元 / 美元",
  "GBP/USD": "英鎊 / 美元",
  "USD/JPY": "美元 / 日圓",
  "USD/CHF": "美元 / 瑞郎",
  "AUD/USD": "澳元 / 美元",
  "USD/CAD": "美元 / 加元",
};

const HEADLINES = {
  "EUR/USD": [["歐洲央行官員暗示將再升息", 1], ["歐元區製造業 PMI 意外疲軟", -1], ["德國通膨數據高於預期", 1], ["美國非農就業強勁，美元走高", -1]],
  "GBP/USD": [["英國央行維持鷹派立場", 1], ["英國零售銷售大幅下滑", -1], ["英國薪資成長超出預期", 1], ["英國政局不確定性升溫", -1]],
  "AUD/USD": [["中國刺激政策提振澳元", 1], ["鐵礦砂價格重挫", -1], ["澳洲央行意外升息", 1], ["全球避險情緒升溫", -1]],
  "USD/JPY": [["日本央行維持超寬鬆政策", 1], ["日本財務省暗示進場干預", -1], ["美債殖利率攀升", 1], ["避險資金湧入日圓", -1]],
  "USD/CHF": [["聯準會官員發言偏鷹", 1], ["地緣政治緊張，資金湧入瑞郎", -1], ["美國零售銷售超出預期", 1], ["瑞士央行意外升息", -1]],
  "USD/CAD": [["國際油價大跌，加元承壓", 1], ["加拿大就業數據亮眼", -1], ["美國 CPI 高於預期", 1], ["加拿大央行釋出鷹派訊號", -1]],
};

const HISTORY = 160;

export function createMarket(seed = 20261015, { warmup = 90 } = {}) {
  const rng = makeRng(seed);
  const prices = {}, phase = {}, candles = {}, bias = {};
  for (const [p, base] of Object.entries(PAIRS)) {
    prices[p] = base; phase[p] = rng() * Math.PI * 2; candles[p] = []; bias[p] = { v: 0, left: 0 };
  }
  const news = [];
  let step = 0;

  function maybeNews() {
    if (rng() >= 0.035) return null;
    const pairs = Object.keys(PAIRS);
    const pair = pairs[Math.floor(rng() * pairs.length)];
    const list = HEADLINES[pair];
    const [text, claimed] = list[Math.floor(rng() * list.length)];
    const reversed = rng() < 0.24;
    const actual = reversed ? -claimed : claimed;
    bias[pair] = { v: actual * 0.0009, left: 8 };
    const item = { step, pair, text, claimed, reversed };
    news.push(item);
    if (news.length > 50) news.shift();
    return item;
  }

  function candleFor(p) {
    const prevClose = prices[p];
    let open = prevClose;
    if (rng() < 0.018) open *= 1 + (rng() < 0.5 ? -1 : 1) * 0.0095;
    let x = open, hi = open, lo = open;
    const b = bias[p];
    for (let k = 0; k < 4; k++) {
      x *= 1 + Math.sin((step + k / 4) / 40 + phase[p]) * 0.0001;
      x *= 1 + (rng() * 2 - 1) * 0.00105;
      if (b.left > 0) x *= 1 + b.v / 4;
      if (x > hi) hi = x;
      if (x < lo) lo = x;
    }
    if (b.left > 0) b.left--;
    x = Math.max(0.0001, x); lo = Math.max(0.0001, lo);
    prices[p] = x;
    const c = { t: step, o: open, h: hi, l: lo, c: x };
    candles[p].push(c);
    if (candles[p].length > HISTORY) candles[p].shift();
    return c;
  }

  function tick() {
    step++;
    const n = maybeNews();
    for (const p of Object.keys(PAIRS)) candleFor(p);
    return { prices: { ...prices }, news: n };
  }

  for (let i = 0; i < warmup; i++) tick();
  news.length = 0;

  return {
    prices: () => ({ ...prices }),
    get: (p) => prices[p],
    pairs: () => Object.keys(PAIRS),
    candles: (p) => candles[p],
    news: () => news,
    step: () => step,
    tick,
  };
}
