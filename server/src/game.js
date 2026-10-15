// 伺服器端遊戲邏輯（純函式，方便測試）。
// 防作弊重點：
// 1. 行情隨機性由 256-bit 伺服器秘密的 HMAC-SHA256 決定；不把秘密送往瀏覽器。
//    在秘密安全且 HMAC 安全的前提下，不能由已公開行情恢復亂數狀態；不保證市場無統計訊號。
// 2. 開倉、平倉、強平都在伺服器算，瀏覽器送不出「我的現金是多少」這種資料。
// 3. 行情依「真實經過時間」前進，不能暫停、倒轉或快轉。
import * as E from "../../engine.mjs";
import { ensureProgress, recordOpen, recordClose, resetProgress, progressView } from "./progress.js";
import { createMarketState, secureMarketState, stepMarket, publicNews, PAIRS, NEWS_SETTLE } from "../../market.mjs";

export const TICK_MS = 1500;          // 每 1.5 秒一根 K 線
export const MAX_CATCHUP = 600;       // 每請求最多補算 600 根（15 分鐘），不是免計風險的離線暫停。
// 超過 15 分鐘的積欠時間不丟棄；每次請求存回進度，完全追平前禁止交易。
export const PERSIST_EVERY = 40;      // 單純查看時，累積 40 根以上才寫回資料庫
export const EQ_EVERY = 10, EQ_KEEP = 300;
export const START_CASH = 10000;
export const MAX_POSITIONS = 20;
const LOG_KEEP = 200;

function newSecret() {
  // Fail closed without a CSPRNG; never fall back to Math.random or a 32-bit seed.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// Call before advance and persist if true, including GETs. Legacy future biases
// and phases were derivable from the old seed, so replace those too, not balances.
export function ensureSecureGame(g) {
  if (g.market.rngVersion !== undefined) {
    if (g.market.rngVersion !== "hmac-sha256-v1" || !/^[0-9a-f]{64}$/.test(g.market.secret || "")) throw new Error("Invalid secure game");
    return false;
  }
  const fresh = createMarketState(undefined, { secret: newSecret(), warmup: 0 });
  secureMarketState(g.market, fresh.secret);
  g.market.phase = fresh.phase;
  for (const p of Object.keys(PAIRS)) g.market.bias[p] = { v: 0, left: 0 };
  g.market.news = [];
  return true;
}

export function newGame(now) {
  const market = createMarketState(undefined, { secret: newSecret() });
  const account = E.createAccount(START_CASH);
  account.eq = [];
  const g = { market, account, lastStepAt: now, resets: 0 };
  ensureProgress(g, now, true);
  return g;
}

// 依經過時間推進行情，逐根檢查強平。回傳這次推進產生的事件。
// 結果只取決於存檔內容與 now，所以同一份存檔重算幾次結果都一樣（沒寫回也不會出錯）。
export function advance(g, now) {
  if (!Number.isFinite(now) || !Number.isFinite(g.lastStepAt)) throw new Error("Invalid game clock");
  ensureProgress(g, now);
  const due = Math.max(0, Math.floor((now - g.lastStepAt) / TICK_MS));
  const n = Math.min(due, MAX_CATCHUP);
  if (n === 0) return { steps: 0, events: [], skipped: false, pendingSteps: 0 };
  // Keep the original tick grid, including fractional remainder. Never discard
  // elapsed ticks or anchor to request time: polling cannot alter market history.
  const pendingSteps = due - n;
  const skipped = pendingSteps > 0; // historical field means batch-limited, NOT dropped
  const events = [];
  const a = g.account;
  for (let i = 0; i < n; i++) {
    const t = g.lastStepAt + (i + 1) * TICK_MS;
    const { prices } = stepMarket(g.market);
    const step = g.market.step;
    // Snapshot position metadata before settleTick removes liquidated positions.
    const positions = new Map(a.positions.map(pos => [pos.id, pos]));
    for (const ev of E.settleTick(a, prices, t)) {
      if (ev.type === "liquidated") {
        const pos = positions.get(ev.id);
        recordClose(g, pos, E.unrealizedPnl(pos, prices[pos.pair]), "liquidated", t);
      }
      events.push({ ...ev, step });
    }
    if (step % EQ_EVERY === 0) {
      a.eq.push(Math.round(E.equity(a, prices) * 100) / 100);
      if (a.eq.length > EQ_KEEP) a.eq.splice(0, a.eq.length - EQ_KEEP);
    }
  }
  if (a.log.length > LOG_KEEP) a.log.splice(0, a.log.length - LOG_KEEP);
  g.lastStepAt += n * TICK_MS;
  return { steps: n, events, skipped, pendingSteps };
}

export class GameError extends Error { constructor(msg) { super(msg); } }

function requireCaughtUp(g, now) {
  if (!Number.isFinite(now) || now - g.lastStepAt >= TICK_MS) throw new GameError("行情補算中，請追平後再交易");
}

export function openOrder(g, { pair, side, leverage, margin }, now) {
  requireCaughtUp(g, now);
  if (!Object.prototype.hasOwnProperty.call(PAIRS, pair)) throw new GameError("不支援的貨幣對");
  if (side !== 1 && side !== -1) throw new GameError("方向錯誤");
  if (!Number.isInteger(leverage)) throw new GameError("槓桿必須是整數");
  if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 10 || margin > 1e9) throw new GameError("保證金至少 $10");
  if (g.account.positions.length >= MAX_POSITIONS) throw new GameError(`最多同時持有 ${MAX_POSITIONS} 筆`);
  margin = Math.floor(margin * 100) / 100;
  const r = E.openPosition(g.account, { ...g.market.prices }, { pair, side, leverage, notional: margin * leverage, time: now });
  if (!r.ok) throw new GameError(r.error);
  recordOpen(g, r.position, now);
  if (g.account.log.length > LOG_KEEP) g.account.log.splice(0, g.account.log.length - LOG_KEEP);
  return r.position;
}

export function closeOrder(g, id, now) {
  requireCaughtUp(g, now);
  const pos = g.account.positions.find(p => p.id === id);
  if (!pos) throw new GameError("找不到持倉（可能已被強制平倉）");
  const r = E.closePosition(g.account, id, g.market.prices[pos.pair], now);
  recordClose(g, pos, r.pnl, "manual", now);
  if (g.account.log.length > LOG_KEEP) g.account.log.splice(0, g.account.log.length - LOG_KEEP);
  return r.pnl;
}

export function resetGame(g, now = g.lastStepAt) {
  resetProgress(g, now);
  E.resetAccount(g.account);
  g.account.eq = [];
  g.resets = (g.resets || 0) + 1;
}

// 給瀏覽器看的資料：只有已發生的 K 線、公開新聞、自己的帳戶。
// since = 瀏覽器已經有的最後一根 K 線編號；-1 或太舊則給完整資料。
export function view(g, since, events = [], now = Date.now()) {
  const m = g.market, step = m.step;
  const full = !(Number.isInteger(since) && since >= 0 && since <= step && step - since < m.history);
  const candles = {};
  for (const p of Object.keys(m.candles)) candles[p] = full ? m.candles[p] : m.candles[p].filter(c => c.t > since);
  const newsFrom = full ? -Infinity : since - NEWS_SETTLE - 1;
  const a = g.account;
  return {
    step, full, tickMs: TICK_MS,
    catchingUp: now - g.lastStepAt >= TICK_MS,
    remainingTicks: Math.max(0, Math.floor((now - g.lastStepAt) / TICK_MS)),
    catchupBatchTicks: MAX_CATCHUP,
    nextTickIn: Math.max(0, g.lastStepAt + TICK_MS - now),
    prices: { ...m.prices },
    candles,
    news: m.news.filter(n => n.step > newsFrom).map(n => publicNews(n, step)),
    account: {
      cash: a.cash, startingCash: a.startingCash, nextId: a.nextId,
      positions: a.positions,
      log: a.log.filter(l => l.type === "close").slice(-15),
      eq: a.eq,
    },
    events: events.filter(e => !Number.isInteger(since) || e.step > since),
    resets: g.resets || 0,
    progress: progressView(g, now),
  };
}
