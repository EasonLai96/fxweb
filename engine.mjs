// 交易引擎：純邏輯，不碰 DOM / localStorage，方便測試。
// 帳戶幣別固定 USD。MVP 只交易「計價貨幣為 USD」的貨幣對，損益直接是 USD。
// price(pair) = 1 個 BASE 值多少 QUOTE。prices 是 { pair: number } 的現價表。

export const LEVERAGES = [1, 2, 5, 10];
export const WARN_LOSS = 0.60;   // 虧損達保證金 60% 警告
export const LIQ_LOSS = 0.80;    // 虧損達保證金 80% 強制平倉
const EPS = 1e-9;

export function createAccount(startingCash = 10000) {
  return { cash: startingCash, positions: [], log: [], nextId: 1, startingCash };
}

export function feeFor(notional, leverage) {
  return notional * (0.00005 + leverage * 0.000005);
}

export function unrealizedPnl(pos, price) {
  return pos.side * (price - pos.entry) * (pos.notional / pos.entry);
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

export function openPosition(state, prices, { pair, side, leverage, notional, time }) {
  if (!LEVERAGES.includes(leverage)) return { ok: false, error: "槓桿不在允許範圍" };
  if (!(notional > 0)) return { ok: false, error: "名目價值必須大於 0" };
  if (side !== 1 && side !== -1) return { ok: false, error: "方向錯誤" };
  const price = prices[pair];
  if (!(price > 0)) return { ok: false, error: "沒有有效報價" };
  if (isFrozen(state, prices)) return { ok: false, error: "帳戶已凍結（淨值 <= 0），請先平倉或重置" };

  const margin = notional / leverage;
  const fee = feeFor(notional, leverage);
  if (freeMargin(state, prices) < margin + fee) return { ok: false, error: "可用保證金不足" };

  const pos = { id: state.nextId++, pair, side, leverage, notional, entry: price, margin, feePaid: fee, openedAt: time };
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
  state.log.push({ t: time, type: "close", id, pair: pos.pair, price, pnl, reason });
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
    closePosition(state, id, prices[pos.pair], time, "liquidated");
    events.push({ type: "liquidated", id, pair: pos.pair });
  }
  return events;
}

export function resetAccount(state) {
  const fresh = createAccount(state.startingCash);
  state.cash = fresh.cash;
  state.positions = fresh.positions;
  state.log = fresh.log;
  state.nextId = fresh.nextId;
}
