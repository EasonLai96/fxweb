import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../engine.mjs';
import { newGame, advance, borrowLoan, repayLoan, openOrder, closeOrder, resetGame, view, GameError, TICK_MS } from '../src/game.js';

const secret = 'cd'.repeat(32);
const start = 1800000000000;
const pair = 'EUR/USD';
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/* ---------- engine 純邏輯 ---------- */

test('loanRate 分四級', () => {
  assert.equal(E.loanRate(10000), 0.0001);
  assert.equal(E.loanRate(10000.01), 0.0002);
  assert.equal(E.loanRate(50000), 0.0002);
  assert.equal(E.loanRate(50000.01), 0.0003);
  assert.equal(E.loanRate(100000), 0.0003);
  assert.equal(E.loanRate(100000.01), 0.0004);
  assert.equal(E.loanRate(200000), 0.0004);
});

test('無借款的帳戶：loanOwed 0、netWorth = equity、accrueLoan 無副作用', () => {
  const a = E.createAccount(10000);
  const before = JSON.stringify(a);
  assert.equal(E.loanOwed(a), 0);
  assert.equal(E.netWorth(a, {}), 10000);
  E.accrueLoan(a, 1000);
  assert.equal(JSON.stringify(a), before, '不應改動沒借款的帳戶');
});

test('borrow 把現金加進帳戶、設定利率、記 log', () => {
  const a = E.createAccount(10000);
  const r = E.borrow(a, 50000, start);
  assert.ok(r.ok);
  assert.equal(a.cash, 60000);
  assert.equal(r.rateDaily, 0.0002);
  assert.equal(E.loanOwed(a), 50000);
  assert.equal(E.netWorth(a, {}), 10000, '借款當下淨資產不變');
  assert.equal(a.log.at(-1).type, 'borrow');
});

test('borrow 邊界：上限、重複借、金額過小', () => {
  const a = E.createAccount(10000);
  assert.equal(E.borrow(a, 200001, start).ok, false);
  assert.equal(E.borrow(a, 0, start).ok, false);
  assert.ok(E.borrow(a, 200000, start).ok);
  assert.equal(E.borrow(a, 1, start).ok, false, '有未償還借款時不能再借');
});

test('accrueLoan 單利：50000 @ 0.02%/天，20 ticks = 1 天 = 10 利息', () => {
  const a = E.createAccount(10000);
  E.borrow(a, 50000, start);
  E.accrueLoan(a, E.LOAN_DAY_TICKS);
  near(a.loan.accrued, 10);
  near(E.loanOwed(a), 50010);
  E.accrueLoan(a, E.LOAN_DAY_TICKS);
  near(E.loanOwed(a), 50020, 0.02);
});

test('netWorth 扣掉未償還借款', () => {
  const a = E.createAccount(10000);
  E.borrow(a, 10000, start);        // cash 20000，利率 0.01%
  E.accrueLoan(a, E.LOAN_DAY_TICKS);  // 利息 1
  near(E.equity(a, {}), 20000);
  near(E.netWorth(a, {}), 9999, 0.01);  // 20000 - 10001
});

test('repay 先利息後本金、部分與全額', () => {
  const a = E.createAccount(10000);
  E.borrow(a, 10000, start);
  E.accrueLoan(a, E.LOAN_DAY_TICKS);   // accrued 1
  const p1 = E.repay(a, 5000, start);
  assert.ok(p1.ok && !p1.cleared);
  near(a.loan.accrued, 0);             // 先還利息
  near(a.loan.principal, 10000 - (5000 - 1));
  const p2 = E.repay(a, 1e9, start);   // 超額 → 夾到欠款
  assert.ok(p2.ok && p2.cleared);
  assert.equal(a.loan, undefined);
  assert.equal(E.loanOwed(a), 0);
});

test('repay 現金不足被擋', () => {
  const a = E.createAccount(10000);
  E.borrow(a, 10000, start);
  a.cash = 500;
  assert.equal(E.repay(a, 10000, start).ok, false);
});

test('resetAccount 清除借款', () => {
  const a = E.createAccount(10000);
  E.borrow(a, 10000, start);
  E.resetAccount(a);
  assert.equal(a.loan, undefined);
  assert.equal(E.loanOwed(a), 0);
  assert.equal(a.cash, 10000);
});

/* ---------- 伺服器整合（shared 模式） ---------- */

test('server borrow/repay 經由 game.js、view 帶出 loan', () => {
  const g = newGame(start, secret);
  borrowLoan(g, 50000, start);
  assert.equal(g.account.cash, 60000);
  const v = view(g, -1, [], start, secret);
  assert.equal(v.account.loanOwed, 50000);
  assert.equal(v.account.loan.principal, 50000);
  near(v.accountValuation.loanOwed, 50000);
  near(v.accountValuation.netWorth, v.accountValuation.equity - 50000);
  // 重複借被擋
  assert.throws(() => borrowLoan(g, 1, start), GameError);
});

test('server advance 自動累計利息', () => {
  const g = newGame(start, secret);
  borrowLoan(g, 50000, start);
  advance(g, start + E.LOAN_DAY_TICKS * TICK_MS, secret);
  near(E.loanOwed(g.account), 50010, 0.1);
});

test('server reset 清掉借款', () => {
  const g = newGame(start, secret);
  borrowLoan(g, 10000, start);
  resetGame(g, start, secret);
  assert.equal(g.account.loan, undefined);
  assert.equal(E.loanOwed(g.account), 0);
});

test('無借款帳戶 view 的 loan 欄位為 null、loanOwed 0', () => {
  const g = newGame(start, secret);
  const v = view(g, -1, [], start, secret);
  assert.equal(v.account.loan, null);
  assert.equal(v.account.loanOwed, 0);
  assert.equal(v.accountValuation.loanOwed, 0);
  near(v.accountValuation.netWorth, v.accountValuation.equity);
});
