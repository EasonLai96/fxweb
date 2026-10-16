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

// ⚠️ 順序很重要：外匯必須排在前面。行情的隨機數是依這個順序逐檔消耗的，
// 新商品一律加在最後，既有外匯的價格序列才不會被打亂。
export const PAIRS = {
  "EUR/USD": 1.0874,
  "GBP/USD": 1.2712,
  "USD/JPY": 149.82,
  "USD/CHF": 0.8846,
  "AUD/USD": 0.6631,
  "USD/CAD": 1.3684,
  // 股票 ETF（2026-10-16 新增）。行情一樣是虛構模擬，只是起始價格與波動大小參考真實標的。
  "0050": 52.80,     // 新台幣計價
  "00878": 21.35,    // 新台幣計價
  "SPY": 662.40,     // 美元計價
  "QQQ": 598.70,     // 美元計價
  // 虛擬幣（2026-10-16 新增）。同樣是虛構模擬，波動遠大於外匯，且會遇到「重大事件」瞬間跳空。
  "BTC": 67250,
  "ETH": 2480,
  "SOL": 152.3,
  "DOGE": 0.1185,
};

export const PAIR_NAMES = {
  "EUR/USD": "歐元 / 美元",
  "GBP/USD": "英鎊 / 美元",
  "USD/JPY": "美元 / 日圓",
  "USD/CHF": "美元 / 瑞郎",
  "AUD/USD": "澳元 / 美元",
  "USD/CAD": "美元 / 加元",
  "0050": "元大台灣50",
  "00878": "國泰永續高股息",
  "SPY": "標普500 ETF",
  "QQQ": "那斯達克100 ETF",
  "BTC": "比特幣",
  "ETH": "以太幣",
  "SOL": "Solana",
  "DOGE": "狗狗幣",
};

// 商品分類與計價。ETF／虛擬幣的損益 = 方向 ×（現價 / 進場價 − 1）× 名目（美元），
// 和 XXX/USD 的公式完全相同，所以新台幣計價的 ETF 不需要換匯，帳戶仍以美元結算。
// vol：相對外匯的波動倍數（外匯 = 1，數值完全不變）。digits：報價小數位數。
export const INSTRUMENTS = {
  "0050":  { kind: "etf", ccy: "TWD", vol: 1.8, digits: 2 },
  "00878": { kind: "etf", ccy: "TWD", vol: 1.2, digits: 2 },
  "SPY":   { kind: "etf", ccy: "USD", vol: 1.5, digits: 2 },
  "QQQ":   { kind: "etf", ccy: "USD", vol: 2.2, digits: 2 },
  "BTC":   { kind: "crypto", ccy: "USD", vol: 6, digits: 1 },
  "ETH":   { kind: "crypto", ccy: "USD", vol: 7, digits: 2 },
  "SOL":   { kind: "crypto", ccy: "USD", vol: 9, digits: 2 },
  "DOGE":  { kind: "crypto", ccy: "USD", vol: 12, digits: 4 },
};
export const kindOf = p => INSTRUMENTS[p]?.kind ?? "fx";
export const isEtf = p => kindOf(p) === "etf";
export const isCrypto = p => kindOf(p) === "crypto";
export const volOf = p => INSTRUMENTS[p]?.vol ?? 1;
export const FX_KEYS = Object.keys(PAIRS).filter(p => kindOf(p) === "fx");
export const ETF_KEYS = Object.keys(PAIRS).filter(isEtf);
export const CRYPTO_KEYS = Object.keys(PAIRS).filter(isCrypto);
// 外匯以外的新商品（ETF＋虛擬幣）。共用行情把它們打包成一次 HMAC 計算，最多 8 檔。
export const NEW_KEYS = Object.keys(PAIRS).filter(p => kindOf(p) !== "fx");
export const priceDigits = p => INSTRUMENTS[p]?.digits ?? (p.includes("JPY") ? 3 : 4);
export const currencyOf = p => INSTRUMENTS[p]?.ccy ?? null;
export const KIND_LABEL = { fx: "外匯", etf: "股票 ETF", crypto: "虛擬幣" };

// ===== 重大事件：瞬間跳空的崩盤／暴漲 =====
// 一般新聞只是「推一把」；重大事件會讓價格在一根 K 線內直接跳空，高槓桿可能瞬間暴富或破產。
// 事件之後價格會在約 10 分鐘內慢慢回到原本的走勢（V 型反轉／衝高回落）。
// hits：[目標, 最小漲跌幅, 最大漲跌幅, 是否隨機方向]。目標 'crypto'/'etf' = 整組，'crypto1'/'fx1' = 隨機一檔。
export const EVENT_TYPES = [
  { id: "crypto-crash", w: 3, text: "幣圈黑天鵝：大型交易所暫停提領，引發連環清算", hits: [["crypto", -0.45, -0.25]] },
  { id: "crypto-moon",  w: 3, text: "現貨 ETF 資金狂灌，幣圈全面噴出", hits: [["crypto", 0.25, 0.6]] },
  { id: "coin-rug",     w: 2, text: "{p} 核心團隊傳出捲款跑路，幣價瞬間腰斬", hits: [["crypto1", -0.75, -0.45]] },
  { id: "coin-pump",    w: 2, text: "馬斯克深夜發文力挺 {p}，散戶瘋狂湧入", hits: [["crypto1", 0.5, 1.5]] },
  { id: "stock-crash",  w: 2, text: "美股盤中熔斷！程式交易引發連環賣壓", hits: [["etf", -0.14, -0.07], ["crypto", -0.2, -0.1]] },
  { id: "stock-rally",  w: 2, text: "聯準會意外降息兩碼，股市狂飆", hits: [["etf", 0.05, 0.1], ["crypto", 0.08, 0.2]] },
  { id: "fx-swan",      w: 2, text: "{p} 央行無預警放棄匯率目標，匯價瞬間跳空", hits: [["fx1", 0.03, 0.08, true]] },
  { id: "meltdown",     w: 1, text: "全球金融海嘯：系統性風險全面爆發", hits: [["crypto", -0.6, -0.35], ["etf", -0.18, -0.1], ["AUD/USD", -0.05, -0.03], ["USD/JPY", -0.06, -0.03]] },
];
const EVENT_W = EVENT_TYPES.reduce((s, e) => s + e.w, 0);
// 依序取用均勻亂數 r() 決定事件內容；共用行情（HMAC）與本機行情（nextRand）共用同一份規則。
// keys：這份行情實際有的商品（舊行情沒有新商品時，事件只會影響存在的商品）。
export function pickEvent(r, keys = Object.keys(PAIRS)) {
  let x = r() * EVENT_W, type = EVENT_TYPES[EVENT_TYPES.length - 1];
  for (const e of EVENT_TYPES) { if (x < e.w) { type = e; break; } x -= e.w; }
  const has = p => keys.includes(p);
  const group = { crypto: CRYPTO_KEYS.filter(has), etf: ETF_KEYS.filter(has), fx: FX_KEYS.filter(has) };
  const pickOne = list => list[Math.min(list.length - 1, Math.floor(r() * list.length))];
  const moves = {}; let named = null;
  for (const [target, lo, hi, randomSign] of type.hits) {
    let list;
    if (target === "crypto1" || target === "fx1") { const one = pickOne(group[target.slice(0, -1)]); list = one ? [one] : []; named = named || one; }
    else list = group[target] || (has(target) ? [target] : []);
    for (const p of list) {
      let m = lo + (hi - lo) * r();
      if (randomSign && r() < 0.5) m = -m;
      moves[p] = m;
    }
  }
  const affected = Object.keys(moves);
  if (!affected.length) return null;
  const pair = named || affected[0];
  return { id: type.id, pair, text: type.text.replace("{p}", pair), claimed: moves[pair] > 0 ? 1 : -1, moves };
}
// 事件發生後第 k 根的影響比例（0..1）：3 根內跳到底，維持 40 根（1 分鐘），再用 560 根（14 分鐘）慢慢回到原本走勢。
const EVENT_HOLD = 40, EVENT_DECAY = 560;
export const EVENT_SPAN = EVENT_HOLD + EVENT_DECAY;
export function eventShape(k) {
  if (k < 0) return 0;
  if (k < 3) return [0.6, 0.85, 1][k];
  if (k < EVENT_HOLD) return 1;
  if (k >= EVENT_SPAN) return 0;
  const x = (k - EVENT_HOLD) / EVENT_DECAY;
  return 1 - x * x * (3 - 2 * x);
}
// 訪客（本機）行情：平均每 300 根（約 7.5 分鐘）一次重大事件。
const LOCAL_EVENT_CHANCE = 1 / 300;

const HEADLINES = {
  "EUR/USD": [["歐洲央行官員暗示將再升息", 1], ["歐元區製造業 PMI 意外疲軟", -1], ["德國通膨數據高於預期", 1], ["美國非農就業強勁，美元走高", -1]],
  "GBP/USD": [["英國央行維持鷹派立場", 1], ["英國零售銷售大幅下滑", -1], ["英國薪資成長超出預期", 1], ["英國政局不確定性升溫", -1]],
  "AUD/USD": [["中國刺激政策提振澳元", 1], ["鐵礦砂價格重挫", -1], ["澳洲央行意外升息", 1], ["全球避險情緒升溫", -1]],
  "USD/JPY": [["日本央行維持超寬鬆政策", 1], ["日本財務省暗示進場干預", -1], ["美債殖利率攀升", 1], ["避險資金湧入日圓", -1]],
  "USD/CHF": [["聯準會官員發言偏鷹", 1], ["地緣政治緊張，資金湧入瑞郎", -1], ["美國零售銷售超出預期", 1], ["瑞士央行意外升息", -1]],
  "USD/CAD": [["國際油價大跌，加元承壓", 1], ["加拿大就業數據亮眼", -1], ["美國 CPI 高於預期", 1], ["加拿大央行釋出鷹派訊號", -1]],
  "0050":  [["台積電法說會釋出樂觀展望", 1], ["外資連續賣超台股", -1], ["AI 伺服器出貨創新高", 1], ["台幣急升壓抑電子股", -1]],
  "00878": [["高股息成分股宣布加碼配息", 1], ["殖利率走升，高股息族群承壓", -1], ["央行降息預期升溫", 1], ["成分股季度調整引發賣壓", -1]],
  "SPY":   [["美國企業財報優於預期", 1], ["聯準會暗示延後降息", -1], ["美國消費數據強勁", 1], ["美國經濟衰退疑慮升溫", -1]],
  "QQQ":   [["科技巨頭財報亮眼", 1], ["晶片出口管制升級", -1], ["AI 需求帶動科技股反彈", 1], ["美債殖利率大漲，科技股重挫", -1]],
  "BTC":   [["比特幣減半行情發酵", 1], ["美國監管機構起訴大型交易所", -1], ["上市公司宣布買進比特幣", 1], ["巨鯨錢包大量轉入交易所", -1]],
  "ETH":   [["以太坊升級順利完成", 1], ["DeFi 協議遭駭，以太幣承壓", -1], ["以太幣現貨 ETF 獲批", 1], ["質押解鎖潮湧現賣壓", -1]],
  "SOL":   [["Solana 迷因幣交易量創新高", 1], ["Solana 網路再度當機", -1], ["大型支付商宣布支援 SOL", 1], ["創投基金大舉拋售 SOL", -1]],
  "DOGE":  [["馬斯克推文提到狗狗幣", 1], ["狗狗幣巨鯨疑似出貨", -1], ["電商平台宣布接受狗狗幣付款", 1], ["迷因幣熱潮退燒", -1]],
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

// ===== 快速 HMAC-SHA256（結果與 hmacSha256 逐位元相同）=====
// 同一把金鑰會被呼叫上千次：先把 (key⊕ipad)、(key⊕opad) 這兩個 64 位元組區塊壓縮好存起來，
// 之後每次只需壓縮訊息本身與外層的 1 個區塊，且不配置新陣列。Worker 免費方案 CPU 很緊，這是主要熱點。
const W64 = new Uint32Array(64);
function compress(h, words) {   // words: 16 個 32-bit 字；就地更新 h
  const w = W64;
  for (let i = 0; i < 16; i++) w[i] = words[i];
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    w[i] = (w[i - 16] + (rotr(x,7) ^ rotr(x,18) ^ (x >>> 3)) + w[i - 7] + (rotr(y,17) ^ rotr(y,19) ^ (y >>> 10))) | 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], j = h[7];
  for (let i = 0; i < 64; i++) {
    const t1 = (j + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
    const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    j = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + j) | 0;
}
const IV = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
export function hmacKey(key) {
  if (key.length > 64) key = sha256(key);
  const pad = x => { const words = new Int32Array(16), h = Int32Array.from(IV);
    for (let i = 0; i < 64; i++) words[i >> 2] |= ((key[i] || 0) ^ x) << (24 - 8 * (i & 3));
    compress(h, words); return h; };
  const inner = pad(0x36), outer = pad(0x5c);
  const h = new Int32Array(8), blk = new Int32Array(16), o = new Int32Array(16);
  // 回傳 (message: Uint8Array) => Uint8Array(32)
  return function mac(message) {
    h.set(inner);
    const n = message.length, total = 64 + n, blocks = Math.ceil((n + 9) / 64);
    for (let bi = 0; bi < blocks; bi++) {
      blk.fill(0);
      for (let k = 0; k < 64; k++) {
        const pos = bi * 64 + k;
        const byte = pos < n ? message[pos] : pos === n ? 0x80 : 0;
        if (byte) blk[k >> 2] |= byte << (24 - 8 * (k & 3));
      }
      if (bi === blocks - 1) { blk[14] = Math.floor(total / 0x20000000); blk[15] = (total * 8) | 0; }
      compress(h, blk);
    }
    o.fill(0);
    for (let i = 0; i < 8; i++) o[i] = h[i];
    o[8] = 0x80000000 | 0; o[15] = (64 + 32) * 8;
    h.set(outer); compress(h, o);
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) { const v = h[i]; out[i*4] = v >>> 24; out[i*4+1] = (v >>> 16) & 255; out[i*4+2] = (v >>> 8) & 255; out[i*4+3] = v & 255; }
    return out;
  };
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
  ms.ev = [];   // 進行中的重大事件（暖機後才開啟，開場不會馬上崩盤）
  return ms;
}

// 這份行情狀態實際有的商品。伺服器裡還在跑的舊私有行情是在加入 ETF 之前建立的，
// 只有 6 個外匯；用它自己的清單推進，舊持倉的價格序列就和以前逐位元相同。
const statePairs = ms => Object.keys(PAIRS).filter(p => Object.prototype.hasOwnProperty.call(ms.prices, p));

function maybeNews(ms) {
  if (nextRand(ms) >= 0.035) return null;
  const pairs = statePairs(ms);
  const pair = pairs[Math.floor(nextRand(ms) * pairs.length)];
  const list = HEADLINES[pair];
  const [text, claimed] = list[Math.floor(nextRand(ms) * list.length)];
  const reversed = nextRand(ms) < 0.24;
  const actual = reversed ? -claimed : claimed;
  ms.bias[pair] = { v: actual * 0.0009 * volOf(pair), left: NEWS_SETTLE };
  const item = { step: ms.step, pair, text, claimed, reversed };
  ms.news.push(item);
  if (ms.news.length > NEWS_KEEP) ms.news.shift();
  return item;
}

// 這一根新發生的重大事件（或 null）。只有新版行情（有 ms.ev）才會呼叫，舊行情的亂數序列不受影響。
function maybeEvent(ms) {
  ms.ev = ms.ev.filter(e => ms.step - e.step < EVENT_SPAN);
  if (nextRand(ms) >= LOCAL_EVENT_CHANCE) return null;
  const picked = pickEvent(() => nextRand(ms), statePairs(ms));
  if (!picked) return null;
  const item = { step: ms.step, pair: picked.pair, text: picked.text, claimed: picked.claimed, reversed: false, event: picked.id, moves: picked.moves };
  ms.ev.push({ step: ms.step, logs: Object.fromEntries(Object.entries(picked.moves).map(([q, m]) => [q, Math.log(1 + m)])) });
  ms.news.push(item);
  if (ms.news.length > NEWS_KEEP) ms.news.shift();
  return item;
}
// 這一根因事件造成的價格倍數變化（影響比例的差值）。
function eventFactor(ms, p) {
  if (!ms.ev) return 1;
  let s = 0;
  for (const e of ms.ev) { const L = e.logs[p]; if (L !== undefined) { const k = ms.step - e.step; s += L * (eventShape(k) - eventShape(k - 1)); } }
  return s ? Math.exp(s) : 1;
}

function candleFor(ms, p) {
  const prevClose = ms.prices[p];
  let open = prevClose * eventFactor(ms, p);   // 重大事件 = 開盤直接跳空
  const vol = volOf(p);   // 外匯 = 1，算式結果與加入 ETF 前完全相同
  if (nextRand(ms) < 0.018) open *= 1 + (nextRand(ms) < 0.5 ? -1 : 1) * 0.0095 * vol;
  let x = open, hi = open, lo = open;
  const b = ms.bias[p];
  for (let k = 0; k < 4; k++) {
    x *= 1 + Math.sin((ms.step + k / 4) / 40 + ms.phase[p]) * 0.0001 * vol;
    x *= 1 + (nextRand(ms) * 2 - 1) * 0.00105 * vol;
    if (b.left > 0) x *= 1 + b.v / 4;
    if (x > hi) hi = x;
    if (x < lo) lo = x;
  }
  if (b.left > 0) b.left--;
  // ETF／虛擬幣：每根輕微拉回基準價（半衰期約 350 根），避免高波動商品越漂越遠。外匯不套用，數值不變。
  if (vol !== 1) { const pull = Math.exp(-0.002 * Math.log(x / PAIRS[p])); x *= pull; hi *= pull; lo *= pull; }
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
  const ev = ms.ev ? maybeEvent(ms) : null;
  for (const p of statePairs(ms)) candleFor(ms, p);
  return { prices: { ...ms.prices }, news: n, event: ev };
}

// 新聞對外版本：影響期間結束前不透露是否反向（否則等於洩漏未來走勢）。
export function publicNews(item, step) {
  const settled = step - item.step >= NEWS_SETTLE;
  if (item.event) return { step: item.step, pair: item.pair, text: item.text, claimed: item.claimed, settled: true, reversed: false, event: item.event, moves: item.moves };
  return { step: item.step, pair: item.pair, text: item.text, claimed: item.claimed, settled, reversed: settled ? item.reversed : null };
}

// 本機用的包裝（訪客模式、測試）。介面與舊版相同。
export function createMarket(seed = 20261015, opts = {}) {
  const ms = createMarketState(seed, opts);
  return {
    state: ms,
    prices: () => ({ ...ms.prices }),
    get: (p) => ms.prices[p],
    pairs: () => statePairs(ms),
    candles: (p) => ms.candles[p],
    news: () => ms.news,
    step: () => ms.step,
    tick: () => stepMarket(ms),
  };
}
