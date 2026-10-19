// Server-owned account settlement. Legacy private tapes are kept only while they
// have open positions; new accounts use the one deterministic global tape.
import * as E from "../../engine.mjs";
import { ensureProgress, recordOpen, recordClose, resetProgress, progressView } from "./progress.js";
import { createMarketState, secureMarketState, stepMarket, publicNews, PAIRS, NEWS_SETTLE } from "../../market.mjs";
import { absoluteTick, makeSharedMarket, sharedPricer } from "./shared-market.js";
import { SENTIMENT_START, sentimentAt } from "./sentiment.js";
import { EXECUTION_START, EXECUTION_VERSION, executionPrice, carryCharge } from "./execution.js";

export const TICK_MS = 1500;
// Bound per-request settlement CPU; pending ticks are persisted and replayed
// by the next request, never skipped while any position remains open.
export const MAX_CATCHUP = 120;
export const PERSIST_EVERY = 40;
export const EQ_EVERY = 10, EQ_KEEP = 300;
export const START_CASH = 10000;
export const MAX_POSITIONS = 20;
export const MAX_HOLD_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_KEEP = 200;
const pairs = Object.keys(PAIRS);
// 某份私有（舊）行情實際有的商品。舊行情建立於加入 ETF 之前，只有外匯。
const marketPairs = m => pairs.filter(p => Object.prototype.hasOwnProperty.call(m.prices, p));

function newSecret() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
function secretRequired(secret) {
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) throw new Error('Shared market secret required');
}
function shared(g) { return g.marketMode === 'shared'; }
function cursor(g) { return shared(g) ? g.cursor : g.market.step; }
function tickPrices(secret, tick, only = pairs, pricer = null, sentiment = null) {
  const at = pricer || sharedPricer(secret, sentiment);
  return Object.fromEntries(only.map(pair => [pair, at(tick, pair)]));
}
// 帳戶結算只需要「有持倉的商品」的價格；其他商品不影響保證金、強平或淨值。
// Worker 免費方案每個請求只有約 10ms CPU，補算時全部 14 檔都算會超時。
function heldPairs(a) { return [...new Set(a.positions.map(p => p.pair))]; }
function trimAccount(a) {
  if (a.log.length > LOG_KEEP) a.log.splice(0, a.log.length - LOG_KEEP);
}
// 只影響新規則版本的倉位；舊倉仍以舊進出場價、舊收費方式結算。
function closeFill(pos, mid, t) {
  return pos.executionVersion === EXECUTION_VERSION
    ? executionPrice(mid, pos.pair, pos.side, pos.notional, t, true) : mid;
}
function settleCarry(a, t) {
  for (const pos of a.positions) {
    if (pos.executionVersion !== EXECUTION_VERSION) continue;
    // Preserve incomplete legacy cost basis even after collecting new carry.
    if (!Number.isFinite(pos.carryPaid) || pos.carryPaid < 0) pos.carryUnknown = true;
    const from = pos.carryAt ?? pos.openedAt;
    const charge = carryCharge(pos, from, t);
    if (charge > 0) { a.cash -= charge; pos.carryPaid = (pos.carryPaid || 0) + charge; }
    pos.carryAt = t;
  }
}
function saveEquity(a, prices, step) {
  if (step % EQ_EVERY === 0) {
    a.eq.push(Math.round(E.equity(a, prices) * 100) / 100);
    if (a.eq.length > EQ_KEEP) a.eq.splice(0, a.eq.length - EQ_KEEP);
  }
}
function settle(g, prices, t, step, events, expire = false) {
  const a = g.account;
  settleCarry(a, t);
  // 新倉的每筆強平各自按反向 bid/ask＋滑價成交；權益圖仍以中間價估值。
  // 同商品不同名目可能有不同滑價，不能共用一個 riskPrices[pair]。
  for (const pos of [...a.positions]) {
    if (!(prices[pos.pair] > 0)) continue; // 缺價不能用 undefined 計算損益、寫壞帳戶現金
    const fill = closeFill(pos, prices[pos.pair], t);
    const loss = E.lossPct(pos, fill);
    if (loss >= E.LIQ_LOSS - 1e-9) {
      const borrowed = !!pos.borrowed, refused = !!pos.refusedHelp;
      const result = E.closePosition(a, pos.id, fill, t, 'liquidated');
      recordClose(g, pos, result.pnl, 'liquidated', t);
      events.push({ type: 'liquidated', id: pos.id, pair: pos.pair, borrowed, refused, step });
    } else if (loss >= E.WARN_LOSS - 1e-9) {
      events.push({ type: 'warning', id: pos.id, pair: pos.pair, lossPct: loss, step });
    }
  }
  // 止損／止盈：強平之後檢查（同一根若強平線先到就已強平，不會再走到這裡）。
  // 用中間價判斷是否觸發，按實際成交價（含價差／滑價）平倉。
  for (const pos of [...a.positions]) {
    const mid = prices[pos.pair];
    const hit = E.stopHit(pos, mid);
    if (!hit) continue;
    const fill = closeFill(pos, mid, t), reason = E.STOP_REASONS[hit];
    const result = E.closePosition(a, pos.id, fill, t, reason);
    recordClose(g, pos, result.pnl, reason, t);
    events.push({ type: 'stop', kind: hit, id: pos.id, pair: pos.pair, price: fill, pnl: result.pnl, step });
  }
  if (expire) {
    for (const pos of [...a.positions]) {
      if (!Number.isFinite(pos.openedAt) || pos.openedAt < 0 || pos.openedAt > t)
        throw new Error('Invalid shared position opening time');
      if (t >= pos.openedAt + MAX_HOLD_MS) {
        const result = E.closePosition(a, pos.id, closeFill(pos, prices[pos.pair], t), t, 'expired');
        recordClose(g, pos, result.pnl, 'expired', t);
        events.push({ type: 'expired', id: pos.id, pair: pos.pair, pnl: result.pnl, step });
      }
    }
  }
  saveEquity(a, prices, step);
}

// Existing insecure private seeds are rekeyed without changing historical prices.
export function ensureSecureGame(g) {
  if (shared(g)) return false;
  if (g.market.rngVersion !== undefined) {
    if (g.market.rngVersion !== 'hmac-sha256-v1' || !/^[0-9a-f]{64}$/.test(g.market.secret || '')) throw new Error('Invalid secure game');
    return false;
  }
  const fresh = createMarketState(undefined, { secret: newSecret(), warmup: 0 });
  secureMarketState(g.market, fresh.secret);
  // 只重設這份舊行情原本就有的商品（舊行情沒有 ETF），不要替它憑空加入新商品。
  const own = marketPairs(g.market);
  g.market.phase = Object.fromEntries(own.map(p => [p, fresh.phase[p]]));
  for (const p of own) g.market.bias[p] = { v: 0, left: 0 };
  g.market.news = [];
  return true;
}

// A secret is mandatory for production shared accounts; no implicit per-user
// fallback is permitted. No global secret or globally generated tape is persisted.
export function newGame(now, marketSecret) {
  if (!Number.isFinite(now) || now < 0) throw new Error('Invalid game clock');
  const account = E.createAccount(START_CASH);
  account.eq = [];
  let g;
  if (marketSecret !== undefined) {
    secretRequired(marketSecret);
    g = { marketMode: 'shared', cursor: absoluteTick(now), account, resets: 0, seasonResetRequired: false };
  } else {
    // Historical pure-unit-test compatibility only; index must require env secret.
    g = { market: createMarketState(undefined, { secret: newSecret() }), account, lastStepAt: now, resets: 0 };
  }
  ensureProgress(g, now, true);
  return g;
}

// Do not carry a single position onto a different price curve. Flat accounts
// can change on the next request, retaining money, statistics and receipts.
export function ensureMarketMode(g, now, marketSecret) {
  if (shared(g)) { secretRequired(marketSecret); return false; }
  if (marketSecret === undefined) return false;
  secretRequired(marketSecret);
  if (g.account.positions.length) {
    // Never move active legacy positions; even when months behind, their own
    // private tape is the sole source of valuation and liquidation.
    if (g.marketMode !== 'legacy') { g.marketMode = 'legacy'; return true; }
    return false;
  }
  const head = absoluteTick(now);
  delete g.market;
  delete g.lastStepAt;
  g.marketMode = 'shared';
  g.cursor = head;
  g.seasonResetRequired = true;
  return true;
}

function advanceLegacy(g, now) {
  if (!Number.isFinite(g.lastStepAt)) throw new Error('Invalid game clock');
  const due = Math.max(0, Math.floor((now - g.lastStepAt) / TICK_MS));
  const n = Math.min(due, MAX_CATCHUP), events = [];
  if (!n) return { steps: 0, events, skipped: false, pendingSteps: 0 };
  const a = g.account;
  for (let i = 0; i < n; i++) {
    const t = g.lastStepAt + (i + 1) * TICK_MS;
    const { prices } = stepMarket(g.market);
    settle(g, prices, t, g.market.step, events);
    // Existing test-only private fixtures retain historical replay behavior.
    // Production calls ensureMarketMode after advance; once the final position
    // settles, no later private price can affect money or progress.
    if (!a.positions.length && g.marketMode === 'legacy') {
      g.lastStepAt = t;
      trimAccount(a);
      return { steps: i + 1, fastForwarded: due - i - 1, events, skipped: false, pendingSteps: 0 };
    }
  }
  trimAccount(a);
  g.lastStepAt += n * TICK_MS;
  return { steps: n, events, skipped: due > n, pendingSteps: due - n };
}
function advanceShared(g, now, marketSecret, sentiment) {
  secretRequired(marketSecret);
  if (!Number.isSafeInteger(g.cursor) || g.cursor < 0) throw new Error('Invalid shared cursor');
  const head = absoluteTick(now), due = Math.max(0, head - g.cursor);
  const events = [], a = g.account;
  if (!a.positions.length) {
    // With no exposure, price history before head cannot change the account.
    g.cursor = head;
    // 沒有持倉時淨值 = 現金，不需要任何價格。
    if (due) saveEquity(a, {}, head);
    return { steps: 0, fastForwarded: due, events, skipped: false, pendingSteps: 0 };
  }
  const n = Math.min(due, MAX_CATCHUP), pricer = sharedPricer(marketSecret, sentiment);
  for (let i = 1; i <= n; i++) {
    const tick = g.cursor + i;
    // 只算持倉商品；結算中途被強平的商品下一根自然就不再計算。
    settle(g, tickPrices(marketSecret, tick, heldPairs(a), pricer, sentiment), tick * TICK_MS, tick, events, true);
    if (!a.positions.length) {
      // All positions have just settled at their historical tick. Skipping the
      // remainder now is safe, but never settle them at today's head price.
      g.cursor = head;
      trimAccount(a);
      return { steps: i, fastForwarded: due - i, events, skipped: false, pendingSteps: 0 };
    }
  }
  g.cursor += n;
  trimAccount(a);
  return { steps: n, events, skipped: due > n, pendingSteps: due - n };
}
export function advance(g, now, marketSecret, sentiment) {
  if (!Number.isFinite(now) || now < 0) throw new Error('Invalid game clock');
  ensureProgress(g, now);
  // 借款利息按帳戶實際推進的 K 線根數累加（與帳戶結算同步）。無借款時為 no-op。
  const before = cursor(g);
  let result;
  if (shared(g)) result = advanceShared(g, now, marketSecret, sentiment);
  else { ensureSecureGame(g); result = advanceLegacy(g, now); }
  E.accrueLoan(g.account, cursor(g) - before);
  return result;
}

export class GameError extends Error { constructor(msg) { super(msg); } }
function remaining(g, now) {
  return shared(g) ? Math.max(0, absoluteTick(now) - g.cursor)
    : Math.max(0, Math.floor((now - g.lastStepAt) / TICK_MS));
}
function requireCaughtUp(g, now) {
  if (!Number.isFinite(now) || remaining(g, now) > 0) throw new GameError('行情補算中，請追平後再交易');
}
// extra：除了持倉商品外還需要的商品（例如要開倉的那一檔）。
function accountPrices(g, secret, extra = [], sentiment) {
  if (shared(g)) { secretRequired(secret); return tickPrices(secret, g.cursor, [...new Set([...heldPairs(g.account), ...extra])], null, sentiment); }
  return { ...g.market.prices };
}
export function openOrder(g, { pair, side, leverage, margin, max = false, sl = null, tp = null }, now, marketSecret, sentiment) {
  requireCaughtUp(g, now);
  if (!shared(g) && marketSecret !== undefined) throw new GameError('舊市場停止開倉；請先平掉舊持倉以切換全球市場');
  if (typeof pair !== 'string' || !Object.prototype.hasOwnProperty.call(PAIRS, pair)) throw new GameError('不支援的商品');
  if (side !== 1 && side !== -1) throw new GameError('方向錯誤');
  if (!Number.isInteger(leverage)) throw new GameError('槓桿必須是整數');
  // 上限不另外設：下面的「可用保證金不足」檢查已經保證不會超過玩家實際擁有的錢。
  // （以前寫死 1e9 上限卻回「至少 $10」，資產破 10 億的玩家就無法下單。）
  if (typeof margin !== 'number' || !Number.isFinite(margin)) throw new GameError('保證金金額無效');
  if (margin < 10) throw new GameError('保證金至少 $10');
  if (g.account.positions.length >= MAX_POSITIONS) throw new GameError(`最多同時持有 ${MAX_POSITIONS} 筆`);
  margin = Math.floor(margin * 100) / 100;
  const prices = accountPrices(g, marketSecret, [pair], sentiment);
  // MAX 用即時伺服器估值計算；送單與前端按 MAX 間可能已過數根行情，
  // 不能拿舊顯示值直接當保證金，尤其是高槓桿、大額持倉。
  const realistic = shared(g) && now >= EXECUTION_START;
  if (max === true) {
    const affordable = E.maxAffordableMargin(E.freeMargin(g.account, prices), leverage);
    // MAX = 全部可用保證金；不設單筆最大金額。
    // 開倉檢查會以成交價重估同商品舊倉，所以要按成交價反覆收斂，否則大帳戶 MAX 會誤報不足。
    margin = affordable;
    if (realistic) for (let i = 0; i < 4 && margin >= 10; i++) {
      const fill = { ...prices, [pair]: executionPrice(prices[pair], pair, side, margin * leverage, now) };
      const next = E.maxAffordableMargin(E.freeMargin(g.account, fill), leverage);
      if (next >= margin) break;
      margin = Math.floor(next * 0.999999 * 100) / 100;
    }
    if (margin < 10) throw new GameError('可用保證金不足');
  }
  const notional = margin * leverage;
  // Preserve the exact order time: expiry occurs on the first historical tick
  // at/after openedAt + seven days, never up to 1499 ms early.
  const fillPrices = realistic ? { ...prices, [pair]: executionPrice(prices[pair], pair, side, notional, now) } : prices;
  const r = E.openPosition(g.account, fillPrices, { pair, side, leverage, notional, time: now, sl, tp, refPrice: prices[pair] });
  if (!r.ok) throw new GameError(r.error);
  if (realistic) {
    r.position.executionVersion = EXECUTION_VERSION;
    r.position.carryAt = now;
    r.position.carryPaid = 0;
    r.position.midAtOpen = prices[pair];
  }
  recordOpen(g, r.position, now);
  trimAccount(g.account);
  return r.position;
}
export function closeOrder(g, id, now, marketSecret, sentiment) {
  requireCaughtUp(g, now);
  const pos = g.account.positions.find(p => p.id === id);
  if (!pos) throw new GameError('找不到持倉（可能已被強制平倉）');
  const prices = accountPrices(g, marketSecret, [], sentiment);
  settleCarry(g.account, now);
  const r = E.closePosition(g.account, id, closeFill(pos, prices[pos.pair], now), now);
  recordClose(g, pos, r.pnl, 'manual', now);
  trimAccount(g.account);
  return r.pnl;
}
// Fraction applies to the currently remaining exposure. CAS in withGame commits
// account, proportional costs, progress and the receipt in one state write.
export function closeOrderPartial(g, id, fraction, now, marketSecret, sentiment) {
  requireCaughtUp(g, now);
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction <= 0 || fraction > 1)
    throw new GameError('平倉比例必須大於 0 且不超過 1');
  if (!Number.isSafeInteger(id)) throw new GameError('持倉編號無效');
  const pos = g.account.positions.find(p => p.id === id);
  if (!pos) throw new GameError('找不到持倉（可能已被平倉）');
  const prices = accountPrices(g, marketSecret, [], sentiment);
  settleCarry(g.account, now);
  const portion = { ...pos, margin: pos.margin * fraction, notional: pos.notional * fraction };
  if (pos.feePaid !== undefined) portion.feePaid = pos.feePaid * fraction;
  if (pos.carryPaid !== undefined) portion.carryPaid = pos.carryPaid * fraction;
  const fill = closeFill(portion, prices[pos.pair], now);
  const r = E.closePositionPartial(g.account, id, fill, now, fraction);
  if (!r.ok) throw new GameError(r.error);
  recordClose(g, portion, r.pnl, 'manual', now);
  trimAccount(g.account);
  return { closed: id, partial: fraction < 1, fraction, pnl: r.pnl,
    netPnl: portion.carryUnknown || !Number.isFinite(portion.feePaid) ? null : r.netPnl, closedMargin: portion.margin, closedNotional: portion.notional,
    closedEntryFee: portion.feePaid ?? null, closedCarryPaid: portion.carryPaid ?? (portion.executionVersion === undefined ? 0 : null),
    remaining: r.remaining ? { ...r.remaining } : null };
}
export function borrowLoan(g, amount, now, marketSecret, sentiment) {
  requireCaughtUp(g, now);
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new GameError('借款金額無效');
  // 上限依伺服器結算點的淨資產計算，前端無法虛報。
  const r = E.borrow(g.account, amount, now, E.loanLimit(g.account, accountPrices(g, marketSecret, [], sentiment)));
  if (!r.ok) throw new GameError(r.error);
  trimAccount(g.account);
  return r;
}
export function repayLoan(g, amount, now) {
  requireCaughtUp(g, now);
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new GameError('還款金額無效');
  const r = E.repay(g.account, amount, now);
  if (!r.ok) throw new GameError(r.error);
  trimAccount(g.account);
  return r;
}

// 風險提醒的三個選項：補保證金（source='cash'，從可用保證金撥入）、借款補倉（source='loan'）、暫不處理。
export function addPositionMargin(g, id, amount, source, now, marketSecret, sentiment) {
  requireCaughtUp(g, now);
  if (!Number.isSafeInteger(id)) throw new GameError('持倉編號無效');
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new GameError('補倉金額無效');
  if (source !== 'cash' && source !== 'loan') throw new GameError('補倉來源錯誤');
  const prices = accountPrices(g, marketSecret, [], sentiment);
  const r = source === 'loan'
    ? E.borrowToMargin(g.account, prices, id, amount, now)
    : E.addMargin(g.account, prices, id, amount, now);
  if (!r.ok) throw new GameError(r.error);
  trimAccount(g.account);
  return r;
}
// 修改持倉的止損止盈（傳 null 清除）。以帳戶結算點的中間價驗證方向。
export function setPositionStops(g, id, sl, tp, now, marketSecret, sentiment) {
  requireCaughtUp(g, now);
  if (!Number.isSafeInteger(id)) throw new GameError('持倉編號無效');
  const pos = g.account.positions.find(p => p.id === id);
  if (!pos) throw new GameError('找不到持倉（可能已被平倉）');
  const prices = accountPrices(g, marketSecret, [], sentiment);
  const r = E.setStops(g.account, id, prices[pos.pair], sl, tp, now);
  if (!r.ok) throw new GameError(r.error);
  trimAccount(g.account);
  return r;
}
export function refuseHelp(g, id, now) {
  requireCaughtUp(g, now);
  if (!Number.isSafeInteger(id)) throw new GameError('持倉編號無效');
  const pos = g.account.positions.find(p => p.id === id);
  if (!pos) throw new GameError('找不到持倉（可能已被強制平倉）');
  pos.refusedHelp = true;
  return { id, refused: true };
}

export function resetGame(g, now = g.lastStepAt, marketSecret) {
  resetProgress(g, now);
  E.resetAccount(g.account);
  g.account.eq = [];
  g.resets = (g.resets || 0) + 1;
  if (shared(g)) g.seasonResetRequired = false;
  else if (marketSecret !== undefined) ensureMarketMode(g, now, marketSecret);
  if (shared(g)) g.seasonResetRequired = false;
}

// Head tape is live even while the account is still processing historical
// ticks. accountValuation uses the SETTLED cursor, never the head quote.
export function view(g, since, events = [], now = Date.now(), marketSecret, sentiment) {
  const isShared = shared(g);
  const m = isShared ? makeSharedMarket(marketSecret, absoluteTick(now), { since, sentiment }) : g.market;
  const step = m.step, full = !(Number.isSafeInteger(since) && since >= 0 && since <= step && step - since < m.history);
  const candles = {};
  // 舊私有行情沒有 ETF：只回傳它實際有的商品，避免對 undefined 呼叫 filter 而整個 API 500。
  for (const p of isShared ? pairs : marketPairs(m)) candles[p] = isShared || full ? m.candles[p] : m.candles[p].filter(c => c.t > since);
  const a = g.account, pending = remaining(g, now);
  const settledStep = cursor(g);
  // 補算中（帳戶落後行情）時，帳戶估值只需要持倉商品在結算點的價格。
  const settledPrices = isShared ? (settledStep === step ? m.prices : tickPrices(marketSecret, settledStep, heldPairs(a), null, sentiment)) : m.prices;
  const headPrices = { ...m.prices };
  const newsFrom = full ? -Infinity : since - NEWS_SETTLE - 1;
  return {
    step, full, tickMs: TICK_MS,
    marketMode: isShared ? 'shared' : 'legacy',
    switchStatus: isShared ? (g.seasonResetRequired ? 'reset_required' : 'ready') : 'close_legacy_positions',
    seasonResetRequired: !!g.seasonResetRequired,
    accountCursor: settledStep, accountSettledAt: isShared ? settledStep * TICK_MS : g.lastStepAt,
    accountValuation: { step: settledStep, prices: { ...settledPrices }, ...E.metrics(a, settledPrices), loanOwed: E.loanOwed(a), netWorth: E.netWorth(a, settledPrices) },
    headStep: step, headPrices,
    catchingUp: pending > 0, remainingTicks: pending, catchupBatchTicks: MAX_CATCHUP,
    nextTickIn: isShared ? Math.max(0, (step + 1) * TICK_MS - now) : Math.max(0, g.lastStepAt + TICK_MS - now),
    prices: headPrices, candles,
    sentiment: isShared && step >= SENTIMENT_START ? Object.fromEntries(pairs.map(p => [p, sentimentAt(sentiment, step, p)])) : null,
    execution: isShared && now >= EXECUTION_START ? {
      mode: '示意市價成交', version: EXECUTION_VERSION,
      note: '價格有買賣價差及大單滑價，借用槓桿資金按真實時間計息。不設單筆最大金額，大單滑價較多。非真實券商費率。',
    } : null,
    news: isShared ? m.news.filter(n => n.step > newsFrom) : m.news.filter(n => n.step > newsFrom).map(n => publicNews(n, step)),
    account: { cash: a.cash, startingCash: a.startingCash, nextId: a.nextId,
      positions: a.positions, log: a.log.filter(l => l.type === 'close' || l.type === 'partial_close').slice(-15).map(l => {
        const side = l.side ?? a.log.find(o => o.type === 'open' && o.id === l.id && o.pair === l.pair)?.side;
        return side === 1 || side === -1 ? { ...l, side } : l;
      }), eq: a.eq,
      loan: a.loan ? { ...a.loan } : null, loanOwed: E.loanOwed(a), loanLimit: E.loanLimit(a, settledPrices) },
    // Shared candles may already be at head while account events originate at
    // an older cursor. Do not hide newly settled expiry/liquidation by since.
    events: isShared ? events : events.filter(e => !Number.isInteger(since) || e.step > since),
    resets: g.resets || 0, progress: progressView(g, now),
  };
}
