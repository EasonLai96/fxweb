// 交易引擎：純邏輯，不碰 DOM / localStorage，方便測試。
// 帳戶幣別固定 USD。支援兩種貨幣對：XXX/USD（計價為 USD）與 USD/XXX（基準為 USD）。
// price(pair) = 1 個 BASE 值多少 QUOTE。prices 是 { pair: number } 的現價表。
// notional 一律以 USD 計。

export const LEVERAGES = [...Array.from({ length: 10 }, (_, i) => i + 1), 50, 100];
export const MAX_LEVERAGE = LEVERAGES.at(-1);
export const WARN_LOSS = 0.60;   // 虧損達保證金 60% 警告
export const LIQ_LOSS = 0.80;    // 虧損達保證金 80% 強制平倉
const EPS = 1e-9;

// ===== 周轉小金庫（銀行借款） =====
// 參考 bilibili「FX 简单!」的 Emergency Fund：單筆上限 $200,000，日利率依借款金額分四級，
// 有未償還借款時不能再借。本遊戲每 LOAN_DAY_TICKS 根 K 線（= 30 秒）計一天利息，
// 利息以單利累加在原始本金上（不複利），不隨行情變動。借來的現金進入帳戶可動用餘額，
// 但未償還的本金＋利息會從淨資產（排行榜成績）中扣除。
export const LOAN_MAX = 200000;          // 最低可借額度
export const LOAN_NET_RATIO = 0.5;       // 可借額度隨淨資產上升：淨資產的 50%，但不低於 LOAN_MAX
export const LOAN_DAY_TICKS = 20;        // 20 根 × 1.5 秒 = 30 秒算一天
export const LOAN_TIERS = [
  [10000, 0.0001],    // ≤ $10,000：日息 0.01%
  [50000, 0.0002],    // ≤ $50,000：日息 0.02%
  [100000, 0.0003],   // ≤ $100,000：日息 0.03%
  [Infinity, 0.0004], // > $100,000：日息 0.04%
];

// 借越多、日息越高：≤ $200,000 照原四級；超過後每多借 10 倍，日息再加 0.02%，
// 例如 200 萬 0.06%、2 億 0.10%、2 兆 0.18%，最高 0.50%。
// 已存在的借款在借入當下就記下 rateDaily，不會被改。
export const LOAN_RATE_STEP = 0.0002, LOAN_RATE_CAP = 0.005;
export function loanRate(amount) {
  if (amount > LOAN_MAX) {
    const r = LOAN_TIERS.at(-1)[1] + LOAN_RATE_STEP * Math.log10(amount / LOAN_MAX);
    return Math.min(LOAN_RATE_CAP, Math.round(r * 1e6) / 1e6);
  }
  for (const [cap, rate] of LOAN_TIERS) if (amount <= cap) return rate;
  return LOAN_TIERS.at(-1)[1];
}

const cents = n => Math.round(n * 100) / 100;

// 目前欠款：本金 + 已累積利息。沒有借款時為 0。
export function loanOwed(state) {
  const l = state && state.loan;
  return l ? cents(l.principal + l.accrued) : 0;
}

// 淨資產 = 帳戶權益 − 未償還借款。排行榜成績以此計算，借錢不會虛胖成績。
export function netWorth(state, prices) {
  return equity(state, prices) - loanOwed(state);
}

// 依經過的 K 線根數累加利息（單利，對本金計息）。無借款或根數 ≤ 0 時不做事，
// 因此對沒借過款的帳戶完全無副作用。
export function accrueLoan(state, ticks) {
  const l = state && state.loan;
  if (!l || !(ticks > 0)) return;
  // 不在這裡四捨五入：玩家正常遊玩時每次只推進 1 根，逐根捨入到分會讓
  // 小額借款（< $1,000）的每根利息被捨成 0（永遠免息），其他金額則被多收或少收。
  // 金額只在 loanOwed() 顯示／還款時才取到分。
  l.accrued = l.accrued + l.principal * l.rateDaily / LOAN_DAY_TICKS * ticks;
}

// 可借上限：max($200,000, 淨資產 × 50%)。淨資產已扣除欠款，負值時仍保底 $200,000。
export function loanLimit(state, prices) {
  const nw = prices ? netWorth(state, prices) : NaN;
  return Number.isFinite(nw) ? Math.max(LOAN_MAX, Math.floor(nw * LOAN_NET_RATIO * 100) / 100) : LOAN_MAX;
}

export function borrow(state, amount, time, limit = LOAN_MAX) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return { ok: false, error: "借款金額無效" };
  amount = Math.floor(amount * 100) / 100;
  if (amount < 1) return { ok: false, error: "借款金額至少 $1" };
  if (amount > limit) return { ok: false, error: `目前可借上限 ${limit.toLocaleString("en-US")}（淨資產的 50%，最低 200,000）` };
  if (loanOwed(state) > 0) return { ok: false, error: "尚有未償還借款，請先還清才能再借" };
  state.loan = { principal: amount, accrued: 0, rateDaily: loanRate(amount), openedAt: time };
  state.cash = cents(state.cash + amount);
  state.log.push({ t: time, type: "borrow", amount, rateDaily: state.loan.rateDaily });
  return { ok: true, amount, rateDaily: state.loan.rateDaily, owed: loanOwed(state) };
}

// 還款：金額可低於欠款（部分還款）。先償還利息再償還本金；還清後清除借款。
export function repay(state, amount, time) {
  const l = state && state.loan;
  if (!l) return { ok: false, error: "目前沒有借款" };
  const owed = loanOwed(state);
  if (typeof amount !== "number" || !Number.isFinite(amount)) return { ok: false, error: "還款金額無效" };
  amount = Math.min(cents(amount), owed);
  if (amount < 0.01) return { ok: false, error: "還款金額至少 $0.01" };
  if (state.cash + EPS < amount) return { ok: false, error: "可動用現金不足以還款" };
  state.cash = cents(state.cash - amount);
  let rest = amount;
  const payInterest = Math.min(l.accrued, rest); l.accrued = cents(l.accrued - payInterest); rest = cents(rest - payInterest);
  l.principal = cents(l.principal - rest);
  const cleared = loanOwed(state) <= 0;
  if (cleared) delete state.loan;
  state.log.push({ t: time, type: "repay", amount, cleared });
  return { ok: true, amount, cleared, owed: loanOwed(state) };
}

// ===== 補倉 =====
// 追加保證金：從可用保證金撥入指定持倉，降低虧損佔保證金的比例、把強平價推遠。
// 本遊戲的保證金不從現金扣出（權益 = 現金 + 浮動盈虧），所以追加只會減少可用保證金。
export function addMargin(state, prices, id, amount, time) {
  const pos = state.positions.find(p => p.id === id);
  if (!pos) return { ok: false, error: "找不到持倉（可能已被強制平倉）" };
  if (typeof amount !== "number" || !Number.isFinite(amount)) return { ok: false, error: "補倉金額無效" };
  amount = Math.floor(amount * 100) / 100;
  if (amount < 1) return { ok: false, error: "補倉金額至少 $1" };
  if (amount > freeMargin(state, prices) + EPS) return { ok: false, error: "可用保證金不足，可改用借款補倉" };
  pos.margin += amount;
  state.log.push({ t: time, type: "margin", id, amount });
  return { ok: true, amount, margin: pos.margin };
}

// 借款補倉：向周轉小金庫借款，整筆直接加進該持倉的保證金，並標記這筆倉位「借錢救過」。
export function borrowToMargin(state, prices, id, amount, time) {
  const pos = state.positions.find(p => p.id === id);
  if (!pos) return { ok: false, error: "找不到持倉（可能已被強制平倉）" };
  const b = borrow(state, amount, time, loanLimit(state, prices));
  if (!b.ok) return b;
  pos.margin += b.amount;
  pos.borrowed = true;
  state.log.push({ t: time, type: "margin", id, amount: b.amount, borrowed: true });
  return { ok: true, amount: b.amount, margin: pos.margin, rateDaily: b.rateDaily };
}

export function createAccount(startingCash = 10000) {
  return { cash: startingCash, positions: [], log: [], nextId: 1, startingCash };
}

export function feeFor(notional, leverage) {
  return notional * (0.00005 + leverage * 0.000005);
}

// MAX 下單：保證金和手續費都會占用可用額度。大數字的浮點運算可能把
// free / perMargin 四捨五入到「超過」實際餘額，需依開倉時完全相同的
// 運算順序回頭驗算；預留少量浮點安全餘額，避免萬億以上金額進位。
export function maxAffordableMargin(free, leverage) {
  if (!Number.isFinite(free) || free <= 0 || !LEVERAGES.includes(leverage)) return 0;
  const perMargin = 1 + leverage * (0.00005 + leverage * 0.000005);
  let margin = Math.floor(free / perMargin * 100) / 100;
  for (let i = 0; i < 8 && margin > 0; i++) {
    const notional = margin * leverage;
    if (Number.isFinite(notional) && notional / leverage + feeFor(notional, leverage) <= free) break;
    margin = Math.max(0, Math.floor((margin - Math.max(0.01, margin * Number.EPSILON * 16)) * 100) / 100);
  }
  return margin;
}

export function isUsdBase(pair) {
  return pair.startsWith("USD/");
}

// 持有的 BASE 數量：XXX/USD 為 notional/entry；USD/XXX 的 BASE 就是 USD，等於 notional。
export function baseUnits(pos) {
  if (pos.units != null) return pos.units;
  return isUsdBase(pos.pair) ? pos.notional : pos.notional / pos.entry;
}

// 損益（USD）。USD/XXX 的損益原本是 QUOTE 幣，用現價換回 USD。
export function unrealizedPnl(pos, price) {
  const quotePnl = pos.side * (price - pos.entry) * baseUnits(pos);
  return isUsdBase(pos.pair) ? quotePnl / price : quotePnl;
}

export function lossPct(pos, price) {
  const pnl = unrealizedPnl(pos, price);
  return pnl >= 0 ? 0 : (-pnl) / pos.margin;
}

export function usedMargin(state) {
  return state.positions.reduce((s, p) => s + p.margin, 0);
}

export function equity(state, prices) {
  const up = state.positions.reduce((s, p) => s + unrealizedPnl(p, prices[p.pair]), 0);
  return state.cash + up;
}

export function freeMargin(state, prices) {
  return equity(state, prices) - usedMargin(state);
}

export function isFrozen(state, prices) {
  return equity(state, prices) <= 0;
}

export function metrics(state, prices) {
  return {
    cash: state.cash,
    equity: equity(state, prices),
    usedMargin: usedMargin(state),
    freeMargin: freeMargin(state, prices),
    frozen: isFrozen(state, prices),
  };
}

export function openPosition(state, prices, { pair, side, leverage, notional, time, sl = null, tp = null, refPrice }) {
  if (!LEVERAGES.includes(leverage)) return { ok: false, error: "槓桿不在允許範圍" };
  if (!(notional > 0)) return { ok: false, error: "名目價值必須大於 0" };
  if (side !== 1 && side !== -1) return { ok: false, error: "方向錯誤" };
  const price = prices[pair];
  if (!(price > 0)) return { ok: false, error: "沒有有效報價" };
  if (isFrozen(state, prices)) return { ok: false, error: "帳戶已凍結（淨值 <= 0），請先平倉或重置" };

  // 止損止盈以「中間價」（refPrice，伺服器新倉的成交價含價差，不能拿來比）驗證
  const stops = normalizeStops(side, refPrice > 0 ? refPrice : price, sl, tp);
  if (!stops.ok) return stops;

  const margin = notional / leverage;
  const fee = feeFor(notional, leverage);
  if (freeMargin(state, prices) < margin + fee) return { ok: false, error: "可用保證金不足" };

  const units = isUsdBase(pair) ? notional : notional / price;
  const pos = { id: state.nextId++, pair, side, leverage, notional, units, entry: price, margin, feePaid: fee, openedAt: time };
  applyStops(pos, stops.sl, stops.tp);
  state.cash -= fee;
  state.positions.push(pos);
  state.log.push({ t: time, type: "open", id: pos.id, pair, side, notional, leverage, price, fee });
  return { ok: true, position: pos };
}

export function closePosition(state, id, price, time, reason = "manual") {
  const idx = state.positions.findIndex(p => p.id === id);
  if (idx < 0) return { ok: false, error: "找不到持倉" };
  const pos = state.positions[idx];
  const pnl = unrealizedPnl(pos, price);
  state.cash += pnl;
  state.positions.splice(idx, 1);
  const entry = { t: time, type: "close", id, pair: pos.pair, price, pnl, reason };
  if (pos.borrowed) entry.borrowed = true;       // 這筆倉位曾借款補倉（成就判定用）
  if (pos.refusedHelp) entry.refused = true;     // 風險提醒時選了「暫不處理」
  state.log.push(entry);
  return { ok: true, pnl };
}

// 每根 tick：先檢查強平（價格可能跳空），回傳事件清單。先收集要強平的，再平，避免邊走邊改陣列。
export function settleTick(state, prices, time) {
  const events = [];
  const toLiquidate = [];
  for (const pos of state.positions) {
    const price = prices[pos.pair];
    if (price == null) continue;
    const lp = lossPct(pos, price);
    if (lp >= LIQ_LOSS - EPS) toLiquidate.push(pos.id);
    else if (lp >= WARN_LOSS - EPS) events.push({ type: "warning", id: pos.id, pair: pos.pair, lossPct: lp });
  }
  for (const id of toLiquidate) {
    const pos = state.positions.find(p => p.id === id);
    const borrowed = !!pos.borrowed, refused = !!pos.refusedHelp;
    closePosition(state, id, prices[pos.pair], time, "liquidated");
    events.push({ type: "liquidated", id, pair: pos.pair, borrowed, refused });
  }
  for (const pos of [...state.positions]) {
    const hit = stopHit(pos, prices[pos.pair]);
    if (!hit) continue;
    const r = closePosition(state, pos.id, prices[pos.pair], time, STOP_REASONS[hit]);
    events.push({ type: "stop", kind: hit, id: pos.id, pair: pos.pair, price: prices[pos.pair], pnl: r.pnl });
  }
  return events;
}

// ===== 止損／止盈 =====
// 每筆持倉可帶 sl（止損價）與 tp（止盈價），兩者都可省略。觸發判斷用「中間價」，
// 成交價由呼叫端決定（伺服器新倉含價差／滑價）。同一根先檢查強平，強平線先到就強平。
//   做多：價格 <= 止損 或 >= 止盈；做空：價格 >= 止損 或 <= 止盈。
export const STOP_REASONS = { sl: "stop_loss", tp: "take_profit" };
const stopValue = v => v === null || v === undefined || v === "" ? null : v;

// 驗證並正規化止損止盈。price 是目前中間價。回傳 { ok, sl, tp } 或 { ok:false, error }。
export function normalizeStops(side, price, sl, tp) {
  sl = stopValue(sl); tp = stopValue(tp);
  for (const [v, name] of [[sl, "止損價"], [tp, "止盈價"]]) {
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1e12)) return { ok: false, error: `${name}格式錯誤` };
  }
  if (side !== 1 && side !== -1) return { ok: false, error: "方向錯誤" };
  if (!(price > 0)) return { ok: false, error: "沒有有效報價" };
  if (side === 1) {
    if (sl !== null && sl >= price) return { ok: false, error: "做多的止損價要低於現價" };
    if (tp !== null && tp <= price) return { ok: false, error: "做多的止盈價要高於現價" };
  } else {
    if (sl !== null && sl <= price) return { ok: false, error: "做空的止損價要高於現價" };
    if (tp !== null && tp >= price) return { ok: false, error: "做空的止盈價要低於現價" };
  }
  return { ok: true, sl, tp };
}

function applyStops(pos, sl, tp) {
  if (sl === null) delete pos.sl; else pos.sl = sl;
  if (tp === null) delete pos.tp; else pos.tp = tp;
}

// 修改（或清除：傳 null）既有持倉的止損止盈。
export function setStops(state, id, price, sl, tp, time) {
  const pos = state.positions.find(p => p.id === id);
  if (!pos) return { ok: false, error: "找不到持倉（可能已被平倉）" };
  const r = normalizeStops(pos.side, price, sl, tp);
  if (!r.ok) return r;
  applyStops(pos, r.sl, r.tp);
  state.log.push({ t: time, type: "stops", id, sl: r.sl, tp: r.tp });
  return { ok: true, id, sl: r.sl, tp: r.tp };
}

// 這個價格是否觸發止損止盈：回傳 "sl" / "tp" / null。兩者同時成立（理論上不會）時以止損為準。
export function stopHit(pos, price) {
  if (!(price > 0)) return null;
  const sl = pos.sl, tp = pos.tp;
  if (pos.side === 1) {
    if (sl > 0 && price <= sl) return "sl";
    if (tp > 0 && price >= tp) return "tp";
  } else {
    if (sl > 0 && price >= sl) return "sl";
    if (tp > 0 && price <= tp) return "tp";
  }
  return null;
}

export function resetAccount(state) {
  const fresh = createAccount(state.startingCash);
  state.cash = fresh.cash;
  state.positions = fresh.positions;
  state.log = fresh.log;
  state.nextId = fresh.nextId;
  delete state.loan;   // 重置回到乾淨的 $10,000，清除所有未償還借款
}

// 強平價：虧損達保證金 80% 時的價格，k = LIQ_LOSS × 保證金 / 名目（未補倉時等於 LIQ_LOSS / leverage）。
// XXX/USD：side*(P-entry)*(N/entry) = -k*N  => P = entry*(1 - side*k)
// USD/XXX：side*(P-entry)*N/P      = -k*N  => P = entry/(1 + side*k)
export function liquidationPrice(pos) {
  const k = LIQ_LOSS * (pos.margin > 0 && pos.notional > 0 ? pos.margin / pos.notional : 1 / pos.leverage);
  return isUsdBase(pos.pair) ? pos.entry / (1 + pos.side * k) : pos.entry * (1 - pos.side * k);
}
