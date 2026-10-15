// 虛構行情產生器。固定種子 -> 可重播。這不是真實市場報價。
// 數值參考 bilibili fx-simple 的觀察值，但這是我們自己的實作，不是它的原碼。

// mulberry32：小而穩的種子亂數，同種子同序列。
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// MVP 只用計價貨幣為 USD 的貨幣對，損益直接是 USD。
export const PAIRS = {
  "EUR/USD": 1.08,
  "GBP/USD": 1.27,
  "AUD/USD": 0.66,
};

export function createMarket(seed = 20261015) {
  const rng = makeRng(seed);
  const prices = {};
  const phase = {};
  for (const [p, base] of Object.entries(PAIRS)) { prices[p] = base; phase[p] = rng() * Math.PI * 2; }
  let step = 0;
  return {
    prices: () => ({ ...prices }),
    get: (p) => prices[p],
    pairs: () => Object.keys(PAIRS),
    tick() {
      step++;
      for (const p of Object.keys(PAIRS)) {
        let x = prices[p];
        x *= 1 + Math.sin(step / 40 + phase[p]) * 0.0004;   // 緩慢正弦漂移
        x *= 1 + (rng() * 2 - 1) * 0.0021;                  // 每根 ±0.21%
        if (rng() < 0.018) x *= 1 + (rng() < 0.5 ? -1 : 1) * 0.0095;  // 1.8% 跳空 ±0.95%
        prices[p] = Math.max(0.0001, x);
      }
      return this.prices();
    },
  };
}
