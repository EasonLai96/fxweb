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
const NEWS_KEEP = 50;
export const NEWS_SETTLE = 8;   // 新聞影響持續 8 根 K 線；之後才公開「是否反向」

// SHA-256 / HMAC-SHA256 (FIPS 180-4 / RFC 2104), synchronous in Workers and browsers.
// Byte-oriented primitives are exported for independent standard-vector tests.
const K256 = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256(bytes) {
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(size); data.set(bytes); data[bytes.length] = 0x80;
  const dv = new DataView(data.buffer);
  dv.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
  dv.setUint32(size - 4, (bytes.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (rotr(x,7) ^ rotr(x,18) ^ (x >>> 3)) + w[i - 7] + (rotr(y,17) ^ rotr(y,19) ^ (y >>> 10));
    }
    let [a,b,c,d,e,f,g,j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      j=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,j].forEach((v,i) => { h[i] = (h[i] + v) >>> 0; });
  }
  const out = new Uint8Array(32), result = new DataView(out.buffer);
  h.forEach((v,i) => result.setUint32(i * 4, v));
  return out;
}
export function hmacSha256(key, message) {
  if (key.length > 64) key = sha256(key);
  const inner = new Uint8Array(64 + message.length), outer = new Uint8Array(96);
  for (let i = 0; i < 64; i++) { inner[i] = (key[i] || 0) ^ 0x36; outer[i] = (key[i] || 0) ^ 0x5c; }
  inner.set(message, 64); outer.set(sha256(inner), 64);
  return sha256(outer);
}
const enc = new TextEncoder();
const streams = new WeakMap(); // ephemeral only; never serialized or returned by public view
function validSecret(secret) { return typeof secret === "string" && /^[0-9a-f]{64}$/.test(secret); }
export function secureMarketState(ms, secret) {
  if (!validSecret(secret)) throw new Error("Market requires a 256-bit hexadecimal secret");
  ms.rngVersion = "hmac-sha256-v1"; ms.secret = secret; delete ms.r;
  streams.delete(ms);
  return ms;
}
// Server PRF: HMAC(secret, UTF8(domain | tick | block)), eight independent 32-bit
// uniform draws per digest, NOT a 32-bit seed fed into a predictable PRNG.
// All entropy consumed inside one tick; JSON checkpoints are valid at tick boundaries.
function nextRand(ms) {
  if (ms.rngVersion !== undefined) {
    if (ms.rngVersion !== "hmac-sha256-v1" || !validSecret(ms.secret)) throw new Error("Invalid secure market state");
    let stream = streams.get(ms);
    if (!stream || stream.step !== ms.step || stream.secret !== ms.secret) {
      stream = { step: ms.step, secret: ms.secret, key: Uint8Array.from(ms.secret.match(/../g), x => parseInt(x,16)), block: 0, index: 8 };
      streams.set(ms, stream);
    }
    if (stream.index === 8) {
      const digest = hmacSha256(stream.key, enc.encode(`fxweb/market/hmac-sha256-v1|${ms.step}|${stream.block++}`));
      stream.words = new DataView(digest.buffer); stream.index = 0;
    }
    return stream.words.getUint32(stream.index++ * 4) / 4294967296;
  }
  // Guest-only legacy mulberry32. This is deliberately reproducible, not secure.
  ms.r = (ms.r + 0x6D2B79F5) | 0;
  let t = Math.imul(ms.r ^ (ms.r >>> 15), 1 | ms.r);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// 可序列化的行情狀態（純資料）。伺服器存它；瀏覽器訪客模式也用它。
export function createMarketState(seed = 20261015, { warmup = 90, history = HISTORY, secret } = {}) {
  const ms = { r: seed | 0, step: 0, history, prices: {}, phase: {}, bias: {}, candles: {}, news: [] };
  if (secret !== undefined) secureMarketState(ms, secret);
  for (const [p, base] of Object.entries(PAIRS)) {
    ms.prices[p] = base; ms.phase[p] = nextRand(ms) * Math.PI * 2; ms.candles[p] = []; ms.bias[p] = { v: 0, left: 0 };
  }
  for (let i = 0; i < warmup; i++) stepMarket(ms);
  ms.news = [];
  return ms;
}

function maybeNews(ms) {
  if (nextRand(ms) >= 0.035) return null;
  const pairs = Object.keys(PAIRS);
  const pair = pairs[Math.floor(nextRand(ms) * pairs.length)];
  const list = HEADLINES[pair];
  const [text, claimed] = list[Math.floor(nextRand(ms) * list.length)];
  const reversed = nextRand(ms) < 0.24;
  const actual = reversed ? -claimed : claimed;
  ms.bias[pair] = { v: actual * 0.0009, left: NEWS_SETTLE };
  const item = { step: ms.step, pair, text, claimed, reversed };
  ms.news.push(item);
  if (ms.news.length > NEWS_KEEP) ms.news.shift();
  return item;
}

function candleFor(ms, p) {
  const prevClose = ms.prices[p];
  let open = prevClose;
  if (nextRand(ms) < 0.018) open *= 1 + (nextRand(ms) < 0.5 ? -1 : 1) * 0.0095;
  let x = open, hi = open, lo = open;
  const b = ms.bias[p];
  for (let k = 0; k < 4; k++) {
    x *= 1 + Math.sin((ms.step + k / 4) / 40 + ms.phase[p]) * 0.0001;
    x *= 1 + (nextRand(ms) * 2 - 1) * 0.00105;
    if (b.left > 0) x *= 1 + b.v / 4;
    if (x > hi) hi = x;
    if (x < lo) lo = x;
  }
  if (b.left > 0) b.left--;
  x = Math.max(0.0001, x); lo = Math.max(0.0001, lo);
  ms.prices[p] = x;
  // K 線只用來顯示，四捨五入到 7 位有效數字以縮小存檔；真正的價格 ms.prices 保持完整精度。
  const r7 = v => Number(v.toPrecision(7));
  const c = { t: ms.step, o: r7(open), h: r7(hi), l: r7(lo), c: r7(x) };
  ms.candles[p].push(c);
  if (ms.candles[p].length > ms.history) ms.candles[p].shift();
  return c;
}

// 前進一根 K 線，回傳 { prices, news }。
export function stepMarket(ms) {
  ms.step++;
  const n = maybeNews(ms);
  for (const p of Object.keys(PAIRS)) candleFor(ms, p);
  return { prices: { ...ms.prices }, news: n };
}

// 新聞對外版本：影響期間結束前不透露是否反向（否則等於洩漏未來走勢）。
export function publicNews(item, step) {
  const settled = step - item.step >= NEWS_SETTLE;
  return { step: item.step, pair: item.pair, text: item.text, claimed: item.claimed, settled, reversed: settled ? item.reversed : null };
}

// 本機用的包裝（訪客模式、測試）。介面與舊版相同。
export function createMarket(seed = 20261015, opts = {}) {
  const ms = createMarketState(seed, opts);
  return {
    state: ms,
    prices: () => ({ ...ms.prices }),
    get: (p) => ms.prices[p],
    pairs: () => Object.keys(PAIRS),
    candles: (p) => ms.candles[p],
    news: () => ms.news,
    step: () => ms.step,
    tick: () => stepMarket(ms),
  };
}
