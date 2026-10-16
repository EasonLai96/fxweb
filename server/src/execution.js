// 共用行情的成交摩擦；數字是遊戲示意，不代表特定券商報價。
// FINRA 市價單與買賣價差：https://www.finra.org/investors/investing/investment-products/stocks/order-types
// BIS 大單拆單與市場衝擊：https://www.bis.org/publ/mktc13.htm
// 衝擊平方根近似：https://arxiv.org/abs/1105.1694
// 融資費率依券商與時點變動：https://www.interactivebrokers.com/en/trading/margin-rates.php
import { kindOf } from '../../market.mjs';
export const EXECUTION_START = Date.UTC(2026, 9, 16, 4, 30, 0); // 台灣時間 12:30
export const EXECUTION_VERSION = 1;
const LIQUIDITY = {
  fx: { halfSpread: .00003, depth: 5e7, impact: .00014, annualCarry: .06 },
  etf: { halfSpread: .00008, depth: 8e6, impact: .00028, annualCarry: .065 },
  crypto: { halfSpread: .00025, depth: 1e6, impact: .00065, annualCarry: .10 },
};
// 單筆最多吃 10 倍示意深度；帳戶總資產無上限，可以拆成多單。
export const maxMarketNotional = pair => LIQUIDITY[kindOf(pair)].depth * 10;
export function friction(pair, notional, time) {
  const p = LIQUIDITY[kindOf(pair)];
  if (!(Number.isFinite(notional) && notional > 0)) throw new RangeError('名目金額無效');
  if (notional > maxMarketNotional(pair)) throw new RangeError('超過單筆流動性，請拆單');
  const stress = Math.floor(time / 1500) % 20 < 2 ? 1.7 : 1;
  // 成本隨訂單增大，但封頂以免 100× 幣圈 MAX 因成本直接接近 80% 強平。
  // 仍有價差及深度限制，不是免費成交；示意上限是每腿名目的 0.12%。
  return Math.min(0.0012, (p.halfSpread + p.impact * Math.sqrt(notional / p.depth)) * stress);
}
export function executionPrice(mid, pair, side, notional, time, close = false) {
  if (!(mid > 0) || (side !== 1 && side !== -1)) throw new RangeError('報價或方向無效');
  return mid * (1 + (close ? -side : side) * friction(pair, notional, time));
}
export function carryCharge(pos, from, to) {
  if (pos.executionVersion !== EXECUTION_VERSION || !(to > from)) return 0;
  return Math.max(0, pos.notional - pos.margin) * LIQUIDITY[kindOf(pos.pair)].annualCarry * (to - from) / (365 * 86400000);
}
