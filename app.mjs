import { initExtras } from "./extras.mjs?v=20261016d";
import { initLeaderboard } from "./leaderboard-ui.mjs?v=20261016d";
import * as E from "./engine.mjs?v=20261016d";
import { createMarket, PAIR_NAMES, NEWS_SETTLE, isEtf, isCrypto, kindOf, KIND_LABEL, priceDigits, currencyOf } from "./market.mjs?v=20261016d";
import * as Store from "./store.mjs?v=20261016d";
import { drawCandles, drawSpark, drawEquity } from "./charts.mjs?v=20261016d";
import * as Cloud from "./cloud.mjs?v=20261016d";
import { createRemoteMarket } from "./remote.mjs?v=20261016d";
import { createAchievementBook } from "./achievements.mjs?v=20261016d";
import { BATTLES, createBattleMarket, loadBattleSave, saveBattle, dateAt } from "./battle.mjs?v=20261016d";

const THEME_KEY = "fxweb.theme";
// 兩種模式：
//   guest  = 訪客，行情與帳戶都在瀏覽器裡算（可被修改，不計成績）
//   server = 已登入，行情與帳戶都由伺服器計算，瀏覽器只負責顯示與送出下單指令
let mode = "guest";
let market = null;
let state = null;
let busy = false;           // 伺服器請求進行中
let lastOk = 0;             // 上次成功連上伺服器的時間
let modeEpoch = 0, catchingUp = false;
let progress = null, resets = 0, extras = null, leaderUI = null;
let serverMarketMode = "shared", switchStatus = "ready", settledPrices = null, accountSettledAt = null, remainingTicks = 0, lastMarketMode = null;
// 切換帳戶/登出後，舊請求不可覆蓋新畫面。
const currentRequest = epoch => epoch === modeEpoch && mode === "server";

// 三種模式：guest / server / battle（經典戰役：真實歷史日收盤回放，本機獨立帳戶）
let battleAuto = false;     // 戰役自動播放
let risk = null;            // 目前開著的風險提醒 { id, pair, auto }
const warned = new Set();   // 已提醒過的持倉（虧損回到 50% 以下才會再提醒）
let lastLossTrack = 0;
const achOwner = () => (Cloud.user() ? "user:" + Cloud.user() : "guest");
const book = createAchievementBook({ onUnlock: def => showAchievement(def) });

function resetModeFlags() {
  // 不同模式的商品清單不同（戰役只有外匯），切換時要重建左側清單。
  const list = document.getElementById("pairList"); if (list) delete list.dataset.built;
  modeEpoch++; busy = false; catchingUp = false; lastOk = 0;
  progress = null; resets = 0; settledPrices = null; accountSettledAt = null; remainingTicks = 0; serverMarketMode = "shared"; switchStatus = "ready"; lastMarketMode = null;
  battleAuto = false; lastLossTrack = 0; warned.clear(); closeRisk();
}

function enterGuest() {
  resetModeFlags();
  mode = "guest";
  book.setOwner(achOwner());
  market = createMarket(Date.now() & 0x7fffffff);
  state = Store.load() || E.createAccount(10000);
  state.positions = state.positions.filter(p => market.get(p.pair) != null);
  equityPts.length = 0; equityPts.push(E.equity(state, market.prices()));
  scanLog(state.log);
}

function enterServer() {
  resetModeFlags();
  mode = "server";
  book.setOwner(achOwner());
  market = createRemoteMarket();
  state = E.createAccount(10000);
  equityPts.length = 0;
}

// 經典戰役：獨立的 $10,000 帳戶，不影響訪客存檔或伺服器帳戶。resume=true 時接續本機存檔。
function enterBattle(id, resume) {
  const saved = loadBattleSave();
  resetModeFlags();
  mode = "battle";
  book.setOwner(achOwner());
  const cont = resume && saved && saved.id === id;
  market = createBattleMarket(id, cont ? saved.cursor : undefined);
  state = cont ? Store.normalize(saved.account) || E.createAccount(10000) : E.createAccount(10000);
  ui.pair = market.info.pair;
  equityPts.length = 0; equityPts.push(E.equity(state, market.prices()));
  saveBattle(id, market.cursor(), state);
  lastNewsStep = market.step();
  showBattleNews(market.news().at(-1));
  checkBattleDate();
}

function leaveBattle() {
  battleAuto = false;
  if (Cloud.enabled() && Cloud.user()) switchToServer(); else { enterGuest(); renderAll(); }
  toast("已回到即時行情，戰役進度保存在這台裝置");
}

const ui = { pair: "EUR/USD", margin: 500, leverage: 5, paused: false, showMA: true, showNews: true, showPos: true, historyOpen: false };
const equityPts = [];       // 淨值曲線：guest 每 tick 一點；server 用伺服器每 10 根記一次的紀錄
let newsTimer = 0, toastTimer = 0, lastNewsStep = -1;

const $ = id => document.getElementById(id);
const digits = priceDigits;
// 金額 ≥ 1 億改用中文大數單位簡寫，避免天文數字撐爆版面。
const BIG_UNITS = [[1e16, "京"], [1e12, "兆"], [1e8, "億"]];
function absMoney(v) {
  const a = Math.abs(v);
  if (!Number.isFinite(a)) return "∞";
  if (a >= 1e20) return a.toExponential(2).replace("e+", "e");
  for (const [n, u] of BIG_UNITS) if (a >= n) return (a / n).toLocaleString("en-US", { maximumFractionDigits: 2 }) + " " + u;
  return a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const money = v => (v < 0 ? "-$" : "$") + absMoney(v);
const signedMoney = v => (v >= 0 ? "+" : "-") + "$" + absMoney(v);
const pct = v => Math.abs(v) >= 1e4 ? `${v >= 0 ? "+" : "-"}${absMoney(Math.abs(v * 100)).replace(/\.00$/, "")}%` : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const signCls = v => (v > 0 ? "positive" : v < 0 ? "negative" : "");
const spaced = p => p.replace("/", " / ");
// 價格旁的計價單位：ETF 標示 NT$ 或 US$，外匯維持原樣（報價本身就是匯率）。
const ccyTag = p => ({ TWD: "NT$", USD: "US$" }[currencyOf(p)] || "");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const theme = () => document.documentElement.dataset.theme || "day";

function change(p) {
  const cs = market.candles(p);
  const ref = cs[Math.max(0, cs.length - 40)];
  return cs[cs.length - 1].c / ref.o - 1;
}

function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = "toast" + (bad ? " bad" : ""); }, 2600);
}

/* ---------- 左欄：商品（外匯＋股票 ETF） ---------- */
function renderPairs() {
  const list = $("pairList");
  // 伺服器剛連上、還沒收到某商品的資料時先不畫，下一輪再建清單。
  const ready = market.pairs().filter(p => market.get(p) != null && market.candles(p)?.length);
  if (!ready.includes(ui.pair) && ready.length) ui.pair = ready[0];
  if (!list.dataset.built || list.dataset.built !== ready.join(",")) {
    const row = p => `
      <button type="button" class="pair-row${isEtf(p) ? " etf" : isCrypto(p) ? " crypto" : ""}" role="option" data-pair="${p}">
        <span><strong>${p}</strong><small>${PAIR_NAMES[p]}</small></span>
        <span class="pair-numbers"><strong data-f="price"></strong><small data-f="chg"></small></span>
        <canvas data-spark="${p}" aria-hidden="true"></canvas>
      </button>`;
    const groups = ["fx", "etf", "crypto"].map(k => [k, ready.filter(p => kindOf(p) === k)]).filter(([, l]) => l.length);
    list.innerHTML = groups.length > 1
      ? groups.map(([k, l]) => `<div class="pair-group-label" role="presentation">${KIND_LABEL[k]}</div>${l.map(row).join("")}`).join("")
      : ready.map(row).join("");
    list.dataset.built = ready.join(",");
    list.onclick = e => { const b = e.target.closest("[data-pair]"); if (b) selectPair(b.dataset.pair); };
  }
  const up = cssVar("--up"), down = cssVar("--down");
  list.querySelectorAll(".pair-row").forEach(row => {
    const p = row.dataset.pair, ch = change(p);
    row.classList.toggle("selected", p === ui.pair);
    row.setAttribute("aria-selected", String(p === ui.pair));
    row.querySelector('[data-f="price"]').textContent = market.get(p).toFixed(digits(p));
    const c = row.querySelector('[data-f="chg"]');
    c.textContent = pct(ch); c.className = signCls(ch);
    drawSpark(row.querySelector("canvas"), market.candles(p).slice(-40).map(k => k.c), ch >= 0 ? up : down);
  });
}

function selectPair(p) { ui.pair = p; renderAll(); }

/* ---------- 帳戶 ---------- */
function renderAccount(prices) {
  const m = mode === "server" && settledPrices ? E.metrics(state, settledPrices) : E.metrics(state, prices);
  const floating = m.equity - state.cash;
  const ret = m.equity / state.startingCash - 1;
  $("equity").textContent = money(m.equity);
  $("retPct").textContent = pct(ret); $("retPct").className = signCls(ret);
  $("free").textContent = money(m.freeMargin);
  $("floating").textContent = signedMoney(floating); $("floating").className = signCls(floating);
  $("usedMargin").textContent = money(m.usedMargin);
  const usage = m.equity > 0 ? m.usedMargin / m.equity : (m.usedMargin > 0 ? 1 : 0);
  $("usage").textContent = (usage * 100).toFixed(1) + "%";
  const bar = $("meterBar");
  bar.style.width = Math.min(100, usage * 100) + "%";
  bar.className = usage >= 0.8 ? "danger" : usage >= 0.5 ? "warn" : "";
  const owed = E.loanOwed(state);
  $("netWorthRow").classList.toggle("hidden", owed <= 0);
  if (owed > 0) $("netWorth").textContent = money(m.equity - owed);
  return m;
}

/* ---------- 周轉小金庫顯示 ---------- */
function renderBank() {
  // 舊版快取的 index.html 可能沒有新的金庫元素；缺元素時跳過，不讓整頁 render 中斷。
  if (!$("bankPanel") || !$("bankHeroValue")) return;
  const owed = E.loanOwed(state);
  const hasLoan = owed > 0;
  const l = state.loan;
  $("bankPanel").classList.toggle("has-loan", hasLoan);
  $("bankStatus").textContent = hasLoan ? "借款中" : "無借款";
  $("bankHeroLabel").textContent = hasLoan ? "目前欠款（本金＋利息）" : "可借額度";
  $("bankHeroValue").textContent = money(hasLoan ? owed : E.LOAN_MAX);
  $("bankMeter").style.width = (hasLoan ? Math.min(100, owed / E.LOAN_MAX * 100) : 100) + "%";
  $("loanOwedRow").classList.toggle("hidden", !hasLoan);
  if (l) { $("loanPrincipal").textContent = money(l.principal); $("loanOwed").textContent = money(l.accrued); }
  $("loanRate").textContent = l ? (l.rateDaily * 100).toFixed(2) + "% / 天" : "依金額分級";
  $("loanBorrowBtn").disabled = hasLoan;
  $("loanRepayBtn").disabled = !hasLoan;
  document.querySelectorAll(".bank-tier").forEach(b => { b.disabled = hasLoan; });
  updateBankPreview();
}

// 依輸入金額即時顯示：對應利率級距、每天利息；有借款時顯示還款後剩餘。
function updateBankPreview() {
  const p = $("bankPreview");
  if (!p || !$("loanAmount")) return;
  const raw = $("loanAmount").value, v = Number(raw);
  const owed = E.loanOwed(state), l = state.loan;
  let tier = -1;
  p.classList.remove("bad");
  if (owed > 0) {
    const pay = Math.min(v, owed);
    if (raw === "" || !(v > 0)) p.innerHTML = `不填金額＝全額還清 <b>${money(owed)}</b>`;
    else if (pay > state.cash + 1e-9) { p.textContent = `現金不足：可用現金 ${money(state.cash)}`; p.classList.add("bad"); }
    else if (v > owed + 1e-9) { p.innerHTML = `超過欠款，按還款會確認改為全額 <b>${money(owed)}</b>`; p.classList.add("bad"); }
    else p.innerHTML = v >= owed ? `還款 <b>${money(owed)}</b> 後即還清` : `還款後剩餘欠款 <b>${money(owed - v)}</b>`;
    tier = E.LOAN_TIERS.findIndex(([, r]) => r === l.rateDaily);
  } else if (raw === "" || !(v > 0)) {
    p.textContent = "每 30 秒計一天，利息只算本金、不利滾利。";
  } else if (v > E.LOAN_MAX) {
    p.textContent = `超過單筆上限 ${money(E.LOAN_MAX)}`; p.classList.add("bad");
  } else {
    const rate = E.loanRate(v);
    tier = E.LOAN_TIERS.findIndex(([, r]) => r === rate);
    p.innerHTML = `日息 <b>${(rate * 100).toFixed(2)}%</b>・每天約 <b>${money(v * rate)}</b>・10 天約 <b>${money(v * rate * 10)}</b>`;
  }
  document.querySelectorAll(".bank-tier").forEach(b => b.classList.toggle("active", Number(b.dataset.tier) === tier));
}

/* ---------- 圖表 ---------- */
function renderChart() {
  const p = ui.pair, cs = market.candles(p), last = cs[cs.length - 1], ch = change(p);
  $("pairTitle").textContent = spaced(p);
  $("pairName").textContent = PAIR_NAMES[p] + (kindOf(p) !== "fx" ? `・${ccyTag(p)} 計價` : "");
  $("currentPrice").textContent = last.c.toFixed(digits(p));
  $("currentPrice").className = signCls(last.c - last.o);
  $("priceChange").textContent = pct(ch); $("priceChange").className = signCls(ch);

  const lines = [];
  if (ui.showPos) for (const pos of state.positions.filter(x => x.pair === p)) {
    lines.push({ price: pos.entry, kind: "entry", label: `#${pos.id} ${pos.side > 0 ? "多" : "空"} 進場` });
    lines.push({ price: E.liquidationPrice(pos), kind: "liq", label: `#${pos.id} 強平` });
  }
  const step = market.step();
  const marks = ui.showNews ? market.news().filter(n => n.pair === p || n.moves?.[p] != null).map(n => n.event
    ? { t: n.step, event: true, up: (n.moves?.[p] ?? n.claimed) > 0 }
    : { t: n.step, reversed: (n.settled != null ? n.settled : step - n.step >= NEWS_SETTLE) && !!n.reversed }) : [];
  drawCandles($("chart"), cs, { theme: theme(), digits: digits(p), lines, marks, showMA: ui.showMA });
}

/* ---------- 下單 ---------- */
function renderOrder(prices, m) {
  const p = ui.pair, price = prices[p], lev = ui.leverage, margin = ui.margin;
  const notional = margin * lev;
  $("orderPair").textContent = kindOf(p) !== "fx" ? `${p} ${PAIR_NAMES[p]}` : spaced(p);
  $("orderPairLabel").textContent = kindOf(p) !== "fx" ? "交易商品" : "交易貨幣對";
  $("leverageValue").textContent = lev + "×";
  const levIndex = E.LEVERAGES.indexOf(lev);
  $("leverageRange").value = levIndex;
  $("leverageRange").style.setProperty("--progress", `${levIndex / (E.LEVERAGES.length - 1) * 100}%`);
  $("leverageNotice").classList.toggle("hidden", lev < 50);
  $("notional").textContent = money(notional);
  $("tradeFee").textContent = money(E.feeFor(notional, lev));
  $("riskPercent").textContent = (E.LIQ_LOSS / lev * 100).toFixed(2) + "%";
  const fake = side => E.liquidationPrice({ pair: p, side, leverage: lev, entry: price });
  $("liqPreview").textContent = `${fake(1).toFixed(digits(p))} / ${fake(-1).toFixed(digits(p))}`;
  const frozen = m.frozen || mode === "server" && (serverMarketMode === "legacy" || catchingUp || Date.now() - lastOk > 6000);
  $("longBtn").disabled = frozen; $("shortBtn").disabled = frozen;
}

function maxMargin(prices) {
  const lev = ui.leverage, free = E.freeMargin(state, prices);
  const perMargin = 1 + lev * (0.00005 + lev * 0.000005); // 保證金 + 手續費 占用
  return Math.max(0, Math.floor(free / perMargin * 100) / 100);
}

async function order(side) {
  const margin = Number($("marginInput").value);
  if (!(margin >= 10)) { toast("保證金至少 $10", true); return; }
  ui.margin = margin;
  const pair = ui.pair, candles = market.candles(pair).slice();
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.open({ pair, side, leverage: ui.leverage, margin }, market.step()));
    const pos = r && r.result && r.result.opened;
    if (pos) {
      toast(`已${side > 0 ? "做多" : "做空"} ${pair}・進場 ${pos.entry.toFixed(digits(pair))}・手續費 ${money(pos.feePaid)}`);
      book.checkOpen({ side, entry: pos.entry, candles });
    }
    return;
  }
  const r = E.openPosition(state, market.prices(), { pair, side, leverage: ui.leverage, notional: margin * ui.leverage, time: Date.now() });
  if (!r.ok) { toast(r.error, true); return; }
  toast(`已${side > 0 ? "做多" : "做空"} ${pair}・名目 ${money(r.position.notional)}・手續費 ${money(r.position.feePaid)}`);
  book.checkOpen({ side, entry: r.position.entry, candles });
  afterChange();
}

async function closePos(id, pair) {
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.close(id, market.step()));
    if (r && r.result) {
      toast(`已平倉・${r.result.pnl >= 0 ? "獲利" : "虧損"} ${signedMoney(r.result.pnl)}`, r.result.pnl < 0);
      book.checkClose({ pnl: r.result.pnl });
    }
    return;
  }
  const r = E.closePosition(state, id, market.get(pair), Date.now());
  if (r.ok) {
    toast(`已平倉・${r.pnl >= 0 ? "獲利" : "虧損"} ${signedMoney(r.pnl)}`, r.pnl < 0);
    book.checkClose({ pnl: r.pnl });
  }
  if (risk && risk.id === id) closeRisk();
  afterChange();
}

async function resetAll() {
  $("confirmModal").classList.add("hidden");
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.reset(market.step()));
    if (r) { equityPts.length = 0; toast("帳戶已重置為 $10,000（行情不會重新開始）"); }
    return;
  }
  if (mode === "battle") {
    // 戰役的「重新開始」= 從戰役第一天重新打
    enterBattle(market.id, false); toast(`「${market.info.title}」從頭開始`); renderAll(); return;
  }
  E.resetAccount(state); Store.clear(); equityPts.length = 0; warned.clear(); book.resetTimers();
  toast("帳戶已重置為 $10,000"); afterChange();
}

/* ---------- 周轉小金庫（銀行借款） ---------- */
async function doBorrow() {
  const amount = Number($("loanAmount").value);
  if (!(amount >= 1)) { toast("借款金額至少 $1", true); return; }
  if (amount > E.LOAN_MAX) { toast(`單筆借款上限 ${money(E.LOAN_MAX)}`, true); return; }
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.borrow(amount, market.step()));
    const b = r && r.result && r.result.borrowed;
    if (b) { clearLoanInput(); toast(`已借入 ${money(b.amount)}・日息 ${(b.rateDaily * 100).toFixed(2)}%`); book.checkAccount({ loanPrincipal: b.amount }); }
    return;
  }
  const r = E.borrow(state, amount, Date.now());
  if (!r.ok) { toast(r.error, true); return; }
  book.checkAccount({ loanPrincipal: r.amount });
  clearLoanInput();
  toast(`已借入 ${money(r.amount)}・日息 ${(r.rateDaily * 100).toFixed(2)}%`);
  afterChange();
}

function clearLoanInput() { $("loanAmount").value = ""; updateBankPreview(); }

async function doRepay() {
  const owed = E.loanOwed(state);
  if (!(owed > 0)) { toast("目前沒有借款", true); return; }
  const raw = $("loanAmount").value.trim();
  const field = Number(raw);
  if (raw !== "" && !(field >= 0.01)) { toast("還款金額無效", true); return; }
  const amount = raw === "" ? owed : field;   // 不填金額 = 全額還清
  // 輸入比欠款多：不默默改成全額，先確認
  if (raw !== "" && field > owed + 1e-9 && !confirm(`輸入金額 ${money(field)} 超過欠款，要改為全額還清 ${money(owed)} 嗎？`)) return;
  const pay = Math.min(amount, owed);
  if (pay > state.cash + 1e-9) { toast(`現金不足：還款 ${money(pay)}，可用現金 ${money(state.cash)}`, true); return; }
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.repay(pay, market.step()));
    const p = r && r.result && r.result.repaid;
    if (p) { clearLoanInput(); toast(p.cleared ? `已還清借款・還款 ${money(p.amount)}` : `已還款 ${money(p.amount)}・剩餘欠款 ${money(p.owed)}`); }
    return;
  }
  const r = E.repay(state, pay, Date.now());
  if (!r.ok) { toast(r.error, true); return; }
  clearLoanInput();
  toast(r.cleared ? `已還清借款・還款 ${money(r.amount)}` : `已還款 ${money(r.amount)}・剩餘欠款 ${money(r.owed)}`);
  afterChange();
}

/* ---------- 持倉 ---------- */
function renderPositions(prices) {
  const root = $("positions");
  $("positionCount").textContent = state.positions.length;
  $("riskHint").textContent = state.positions.length ? `合計 ${money(E.usedMargin(state))} 保證金` : "暫無持倉";
  if (!state.positions.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">♡</div>還沒有持倉，選一個商品開始吧</div>';
    return;
  }
  root.innerHTML = state.positions.map(pos => {
    const price = prices[pos.pair], pnl = E.unrealizedPnl(pos, price), d = digits(pos.pair);
    const risk = E.lossPct(pos, price), riskW = Math.min(100, risk / E.LIQ_LOSS * 100);
    const riskColor = risk >= E.WARN_LOSS ? cssVar("--down") : risk >= 0.3 ? "#e9a35a" : cssVar("--accent");
    return `<div class="position-row${risk >= E.WARN_LOSS ? " risky" : ""}">
      <div class="pos-name"><strong>${pos.pair}<span class="direction ${pos.side > 0 ? "long" : "short"}">${pos.side > 0 ? "做多" : "做空"}</span>${risk >= E.WARN_LOSS ? '<span class="risk-tag">風險偏高</span>' : ""}${pos.borrowed ? '<span class="risk-tag loan-tag">借款補倉</span>' : ""}</strong>
        <small>${money(pos.margin)} 保證金・${pos.leverage}×・${money(pos.notional)} 倉位</small></div>
      <div class="pos-cell pos-entry"><small>進場價</small><strong>${pos.entry.toFixed(d)}</strong></div>
      <div class="pos-cell"><small>現價</small><strong>${price.toFixed(d)}</strong></div>
      <div class="pos-cell pos-liq"><small>強平價</small><strong>${E.liquidationPrice(pos).toFixed(d)}</strong></div>
      <div class="pos-cell"><small>浮動盈虧</small><strong class="${signCls(pnl)}">${signedMoney(pnl)}</strong>
        <div class="risk-bar" title="距離強平"><i style="width:${riskW}%;background:${riskColor}"></i></div></div>
      <div class="pos-actions"><button class="close-btn help-btn" type="button" data-help="${pos.id}" title="追加保證金或借款補倉">補倉</button><button class="close-btn" type="button" data-close="${pos.id}" data-pair="${pos.pair}">平倉</button></div>
    </div>`;
  }).join("");
}

/* ---------- 淨值、紀錄、新聞 ---------- */
function renderEquity() {
  drawEquity($("equityChart"), equityPts, state.startingCash, { up: cssVar("--up"), down: cssVar("--down"), muted: cssVar("--text-muted"), text: cssVar("--text-deep") });
}

function renderHistory() {
  $("historyToggle").textContent = ui.historyOpen ? "收起紀錄" : "展開紀錄";
  $("history").classList.toggle("hidden", !ui.historyOpen);
  if (!ui.historyOpen) return;
  const closes = state.log.filter(l => l.type === "close").slice(-15).reverse();
  $("history").innerHTML = closes.length ? closes.map(l => `
    <div class="history-row"><span>${l.reason === "liquidated" ? '<b class="liq-tag">強平</b>' : ""}#${l.id} ${l.pair} @ ${l.price.toFixed(digits(l.pair))}</span>
    <strong class="${signCls(l.pnl)}">${signedMoney(l.pnl)}</strong></div>`).join("")
    : '<div class="empty-state">還沒有結算紀錄</div>';
}

const pctTxt = m => `${m > 0 ? "+" : ""}${(m * 100).toFixed(0)}%`;
function eventSummary(n) {
  return Object.entries(n.moves || {}).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5).map(([p, m]) => `${p} ${pctTxt(m)}`).join("、");
}
function showEvent(n) {
  const up = n.claimed > 0;
  $("tickerTag").textContent = up ? "▲ 暴漲" : "▼ 崩盤";
  $("tickerTag").className = "ticker-tag event" + (up ? "" : " bear");
  const track = $("tickerTrack");
  track.textContent = `【重大事件】${n.text}　——　${eventSummary(n)}，約 15 分鐘內逐步回穩。`;
  track.className = "ticker-track";
  $("nfTag").textContent = up ? "▲ 重大事件・暴漲" : "▼ 重大事件・崩盤";
  $("nfTag").className = "nf-tag event" + (up ? "" : " bear");
  $("nfTitle").textContent = n.text;
  $("nfBody").textContent = `${eventSummary(n)}。價格已瞬間跳空，高槓桿可能一根 K 線就強平；之後約 15 分鐘慢慢回到原本走勢。`;
  $("newsFloat").classList.add("show", "event");
  document.body.classList.remove("shock-up", "shock-down"); void document.body.offsetWidth;
  document.body.classList.add(up ? "shock-up" : "shock-down");
  clearTimeout(newsTimer); newsTimer = setTimeout(() => { $("newsFloat").classList.remove("show", "event"); document.body.classList.remove("shock-up", "shock-down"); }, 9000);
  // 有持倉被影響時，跟玩家說一聲
  const hit = state.positions.filter(pos => n.moves?.[pos.pair] != null);
  if (hit.length) {
    const good = hit.filter(pos => pos.side * n.moves[pos.pair] > 0).length;
    toast(good === hit.length ? `🚀 你的 ${hit.length} 筆持倉站在對的一邊！` : good ? `⚡ 事件影響你 ${hit.length} 筆持倉，其中 ${good} 筆受惠` : `💥 重大事件打到你的 ${hit.length} 筆持倉！`, good < hit.length);
  }
}
function showNews(n) {
  if (n.event) { showEvent(n); return; }
  const bull = n.claimed > 0;
  $("tickerTag").textContent = `${n.pair} ${bull ? "利多" : "利空"}`;
  $("tickerTag").className = "ticker-tag" + (bull ? "" : " bear");
  const track = $("tickerTrack");
  track.textContent = `${n.text}　——　${n.pair} 可能${bull ? "走高" : "走低"}，但市場不一定照劇本走。`;
  track.className = "ticker-track";
  $("nfTag").textContent = `${n.pair}・${bull ? "利多" : "利空"}`;
  $("nfTag").className = "nf-tag" + (bull ? "" : " bear");
  $("nfTitle").textContent = n.text;
  $("nfBody").textContent = `新聞通常推動 ${n.pair} ${bull ? "上漲" : "下跌"}，但約四分之一的情況市場會反向。點左側商品可查看走勢。`;
  $("newsFloat").classList.add("show");
  clearTimeout(newsTimer); newsTimer = setTimeout(() => $("newsFloat").classList.remove("show"), 5200);
}

function renderNewsCenter() {
  const step = market.step();
  const list = market.news().slice().reverse();
  if (mode === "battle") {
    $("newsCenterList").innerHTML = list.length ? list.map(n => `<div class="news-item"><span class="nf-tag battle">${esc(n.date)}・${esc(n.tag)}</span>
      <h4>${esc(n.title)}</h4><small>${esc(n.body)}</small></div>`).join("")
      : '<div class="empty-state"><div class="empty-icon">✦</div>戰役新聞會在對應日期出現</div>';
    return;
  }
  $("newsCenterList").innerHTML = list.length ? list.map(n => {
    if (n.event) return `<div class="news-item event"><span class="nf-tag event${n.claimed > 0 ? "" : " bear"}">${n.claimed > 0 ? "▲ 重大事件・暴漲" : "▼ 重大事件・崩盤"}</span>
      <h4>${esc(n.text)}</h4><small>${esc(eventSummary(n))}・${step - n.step} 根 K 線前</small></div>`;
    const bull = n.claimed > 0, settled = n.settled != null ? n.settled : step - n.step >= NEWS_SETTLE;
    return `<div class="news-item"><span class="nf-tag${bull ? "" : " bear"}">${n.pair}・${bull ? "利多" : "利空"}</span>${settled && n.reversed ? '<span class="rev-tag">市場反向</span>' : ""}
      <h4>${esc(n.text)}</h4><small>${settled ? (n.reversed ? "結果：市場走出相反方向" : "結果：市場照新聞方向走") : "行情發酵中…"}・${step - n.step} 根 K 線前</small></div>`;
  }).join("") : '<div class="empty-state"><div class="empty-icon">✦</div>還沒有新聞，稍等一下</div>';
}

/* ---------- 主流程 ---------- */
function renderAll() {
  renderModeBadge();
  extras?.update();
  if (mode === "server" && !market.ready()) return;
  const prices = market.prices();
  renderPairs();
  const m = renderAccount(prices);
  renderChart();
  renderOrder(prices, m);
  renderPositions(mode === "server" && catchingUp && settledPrices ? settledPrices : prices);
  renderEquity();
  renderHistory();
  renderBank();
}

function afterChange() { saveCurrent(); checkAccountAch(mode === "server" && settledPrices ? settledPrices : market.prices()); equityPts.push(E.equity(state, market.prices())); renderAll(); }

function showEvents(events) {
  for (const ev of events) {
    if (ev.type === "liquidated") {
      toast(`#${ev.id} ${ev.pair} 虧損達保證金 80%，已強制平倉`, true);
      book.checkLiquidation(ev);
      warned.delete(ev.id);
      if (risk && risk.id === ev.id) closeRisk();
    }
    if (ev.type === "expired") toast(`#${ev.id} ${ev.pair} 持倉滿 7 天，到期已自動平倉`);
  }
}

/* ---------- 成就判定 ---------- */
function showAchievement(def) {
  toast(`🏆 達成成就「${def.name}」`);
  $("nfTag").textContent = "🏆 成就"; $("nfTag").className = "nf-tag ach";
  $("nfTitle").textContent = `達成「${def.name}」`;
  $("nfBody").textContent = def.desc;
  $("newsFloat").classList.add("show");
  clearTimeout(newsTimer); newsTimer = setTimeout(() => $("newsFloat").classList.remove("show"), 5200);
  extras?.update();
}

// 從平倉紀錄補判定（伺服器帳戶在別台裝置被強平、或改版前的紀錄都會被算到）。
function scanLog(log) {
  for (const l of log || []) {
    if (l.type !== "close") continue;
    if (l.reason === "liquidated") book.checkLiquidation(l);
    else if (l.reason !== "expired" && l.pnl > 0) book.checkClose(l);
  }
}

function checkAccountAch(prices) {
  if (!prices || state.positions.some(p => !(prices[p.pair] > 0))) return;
  book.checkAccount({ netWorth: E.netWorth(state, prices), startingCash: state.startingCash, loanPrincipal: state.loan ? state.loan.principal : 0 });
}

function trackLossTime(prices, opts) {
  if (!prices) return;
  book.trackLosses(mode === "battle" ? "battle:" + market.id : mode, state.positions,
    pos => prices[pos.pair] > 0 ? E.unrealizedPnl(pos, prices[pos.pair]) : 0, opts);
}

/* ---------- 風險提醒（虧損達保證金 60%） ---------- */
function checkRisk(prices) {
  if (!prices) return;
  for (const pos of state.positions) {
    const price = prices[pos.pair];
    if (!(price > 0)) continue;
    const lp = E.lossPct(pos, price);
    if (lp < 0.5) warned.delete(pos.id);
    // 不檢查 busy：登入模式的 applyServer 是在 poll() 的 busy 期間呼叫的。按鈕送出時 serverCall 自己會擋重複請求。
    else if (lp >= E.WARN_LOSS && !warned.has(pos.id) && !risk) {
      warned.add(pos.id);
      if (mode === "battle") battleAuto = false;
      openRisk(pos.id, true);
      return;
    }
  }
}

function riskPrices() { return mode === "server" && settledPrices ? settledPrices : market.prices(); }

function openRisk(id, auto) {
  const pos = state.positions.find(p => p.id === id);
  if (!pos) return;
  if (!$("authModal").classList.contains("hidden") || !$("rcModal").classList.contains("hidden")) return;
  risk = { id, pair: pos.pair, auto };
  const price = riskPrices()[pos.pair], pnl = E.unrealizedPnl(pos, price), lp = E.lossPct(pos, price);
  $("riskTitle").textContent = auto ? (lp >= E.LIQ_LOSS ? "倉位已觸及強平線" : "倉位接近強平線") : `補倉：#${pos.id} ${pos.pair}`;
  $("riskMsg").textContent = auto
    ? `#${pos.id} ${pos.pair} ${pos.side > 0 ? "做多" : "做空"} 已虧掉保證金的 ${(lp * 100).toFixed(1)}%，到 80% 會被強制平倉。你可以補保證金、借款補倉，或暫不處理。${mode === "server" ? "（登入帳戶的行情不會因此暫停）" : "（行情已暫停，處理完才會繼續）"}`
    : "追加保證金可以把強平價推遠。補保證金會佔用可用餘額；借款補倉會向周轉小金庫借錢，整筆加進這筆倉位。";
  $("riskDetail").innerHTML = `浮動盈虧 <b class="${signCls(pnl)}">${signedMoney(pnl)}</b>・保證金 <b>${money(pos.margin)}</b>・目前強平價 <b>${E.liquidationPrice(pos).toFixed(digits(pos.pair))}</b>`;
  // 建議補到虧損只佔保證金 55%；已經低於 55%（手動補倉時常見）就建議補保證金的一半。
  const toTarget = Math.ceil(-pnl / 0.55 - pos.margin);
  $("riskAmount").value = toTarget >= 1 ? toTarget : Math.max(1, Math.round(pos.margin / 2));
  $("riskIgnoreBtn").textContent = auto ? "暫不處理" : "取消";
  $("riskModal").classList.remove("hidden");
  if (mode === "battle") renderBattleBar();
  updateRiskPreview();
  setTimeout(() => $("riskAmount").focus(), 30);
}

function updateRiskPreview() {
  if (!risk) return;
  const pos = state.positions.find(p => p.id === risk.id);
  if (!pos) { closeRisk(); return; }
  const amt = Math.floor(Number($("riskAmount").value) * 100) / 100;
  const free = E.freeMargin(state, riskPrices()), owed = E.loanOwed(state);
  const p = $("riskPreview");
  if (!(amt >= 1)) p.textContent = "請輸入至少 $1。";
  else {
    const lp = E.liquidationPrice({ ...pos, margin: pos.margin + amt });
    p.innerHTML = `補 <b>${money(amt)}</b> 後強平價 → <b>${lp.toFixed(digits(pos.pair))}</b>`
      + (amt <= E.LOAN_MAX ? `・借款日息 ${(E.loanRate(amt) * 100).toFixed(2)}%` : "");
  }
  $("riskAddBtn").disabled = !(amt >= 1) || amt > free + 1e-9;
  $("riskAddBtn").title = amt > free + 1e-9 ? `可用餘額只有 ${money(Math.max(0, free))}` : "";
  $("riskLoanBtn").disabled = !(amt >= 1) || amt > E.LOAN_MAX || owed > 0;
  $("riskLoanBtn").title = owed > 0 ? "已有未還借款，請先在周轉小金庫還清" : "";
  $("riskFree").textContent = `可用餘額 ${money(Math.max(0, free))}${owed > 0 ? `・尚欠 ${money(owed)}（不能再借）` : `・可借上限 ${money(E.LOAN_MAX)}`}`;
}

function closeRisk() {
  risk = null;
  const m = $("riskModal"); if (m) m.classList.add("hidden");
  if (mode === "battle" && market) renderBattleBar();   // 「下一天」在彈窗開著時停用，關閉後要恢復
}

async function riskAdd(source) {
  if (!risk) return;
  const id = risk.id, amt = Math.floor(Number($("riskAmount").value) * 100) / 100;
  if (!(amt >= 1)) { toast("補倉金額至少 $1", true); return; }
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.margin(id, amt, source, market.step()));
    const m = r && r.result && r.result.margin;
    if (m) {
      closeRisk();
      toast(`${source === "loan" ? "已借款" : "已追加"} ${money(m.amount)} 到 #${id} 保證金`);
      if (source === "loan") book.checkAccount({ loanPrincipal: m.amount });
    }
    return;
  }
  const r = source === "loan" ? E.borrowToMargin(state, market.prices(), id, amt, Date.now()) : E.addMargin(state, market.prices(), id, amt, Date.now());
  if (!r.ok) { toast(r.error, true); return; }
  closeRisk();
  toast(`${source === "loan" ? "已借款" : "已追加"} ${money(r.amount)} 到 #${id} 保證金`);
  if (source === "loan") book.checkAccount({ loanPrincipal: r.amount });
  saveCurrent(); afterChange();
}

async function riskIgnore() {
  if (!risk) return;
  const { id, auto } = risk;
  closeRisk();
  if (!auto) return;
  if (mode === "server") { await serverCall(() => Cloud.game.refuseHelp(id, market.step())); return; }
  const pos = state.positions.find(p => p.id === id);
  if (pos) pos.refusedHelp = true;
  saveCurrent(); renderAll();
}

function bindRisk() {
  $("riskAmount").addEventListener("input", updateRiskPreview);
  $("riskAddBtn").onclick = () => riskAdd("cash");
  $("riskLoanBtn").onclick = () => riskAdd("loan");
  $("riskIgnoreBtn").onclick = riskIgnore;
  $("riskClose").onclick = riskIgnore;
}

function saveCurrent() {
  if (mode === "guest") Store.save(state);
  else if (mode === "battle") saveBattle(market.id, market.cursor(), state);
}

/* ---------- 經典戰役 ---------- */
function showBattleNews(n) {
  if (!n) return;
  $("tickerTag").textContent = `${n.date}・${n.tag}`; $("tickerTag").className = "ticker-tag battle";
  $("tickerTrack").textContent = `${n.title}　——　${n.body}`; $("tickerTrack").className = "ticker-track";
  $("nfTag").textContent = `${n.date}・${n.tag}`; $("nfTag").className = "nf-tag battle";
  $("nfTitle").textContent = n.title; $("nfBody").textContent = n.body;
  $("newsFloat").classList.add("show");
  clearTimeout(newsTimer); newsTimer = setTimeout(() => $("newsFloat").classList.remove("show"), 6500);
}

function checkBattleDate() {
  if (mode === "battle" && market.id === "franc-2015" && market.date() >= "2015-01-15") book.unlock("killed-by-chf");
}

function nextBattleDay() {
  if (mode !== "battle" || risk) return;
  if (market.atEnd()) { battleAuto = false; toast("戰役已到最後一天，可以平倉結算或重新開始"); renderAll(); return; }
  const { prices, news } = market.next();
  E.accrueLoan(state, E.LOAN_DAY_TICKS);            // 一個交易日 = 一天利息
  showEvents(E.settleTick(state, prices, Date.now()));
  for (const n of news) showBattleNews(n);
  equityPts.push(E.equity(state, prices));
  trackLossTime(prices, { days: 1 });
  checkBattleDate();
  checkAccountAch(prices);
  scanLog(state.log.slice(-5));
  saveBattle(market.id, market.cursor(), state);
  if (market.atEnd()) {
    battleAuto = false;
    const nw = E.netWorth(state, prices) - state.startingCash;
    toast(`「${market.info.title}」回放結束・淨資產變化 ${signedMoney(nw)}`, nw < 0);
  }
  renderAll();
  checkRisk(prices);
  if (!$("newsCenter").classList.contains("hidden")) renderNewsCenter();
}

function renderBattleBar() {
  const bar = $("battleBar"), on = mode === "battle";
  bar.classList.toggle("hidden", !on);
  document.body.classList.toggle("in-battle", on);
  if (!on) return;
  const p = market.progress();
  $("battleTitle").textContent = market.info.title;
  $("battleDate").textContent = market.date();
  $("battleDay").textContent = p.day >= 0 ? `第 ${p.day + 1} / ${p.days + 1} 個交易日` : "暖身資料";
  $("battleEvent").textContent = market.date() >= market.info.event ? `事件日 ${market.info.event} 已過` : `距事件日 ${market.info.event}`;
  $("battleMeter").style.width = `${Math.max(0, Math.min(100, (p.day + 1) / (p.days + 1) * 100))}%`;
  $("battleNextBtn").disabled = market.atEnd() || !!risk;
  $("battleAutoBtn").textContent = battleAuto ? "暫停播放" : "自動播放";
  $("battleAutoBtn").disabled = market.atEnd();
}

function renderBattlePicker() {
  const saved = loadBattleSave();
  $("battleList").innerHTML = BATTLES.map(b => {
    const cont = saved && saved.id === b.id;
    return `<div class="battle-card">
      <div class="battle-card-head"><strong>${esc(b.title)}</strong><span class="battle-pair">${b.pair}</span></div>
      <p>${esc(b.description)}</p>
      <small>事件日 ${b.event}・從 ${b.start} 開始・<a href="${b.source}" target="_blank" rel="noopener">官方資料</a></small>
      <div class="battle-card-actions">
        ${cont ? `<button type="button" class="primary-button" data-battle="${b.id}" data-resume="1">繼續（${esc(dateAt(b.id, saved.cursor))}）</button>` : ""}
        <button type="button" class="${cont ? "outline-button" : "primary-button"}" data-battle="${b.id}">${cont ? "重新開始" : "開始戰役"}</button>
      </div></div>`;
  }).join("");
}

function bindBattle() {
  const openPicker = () => { renderBattlePicker(); $("battleModal").classList.remove("hidden"); };
  const closePicker = () => $("battleModal").classList.add("hidden");
  $("battleBtn").onclick = openPicker;
  $("battleModalClose").onclick = closePicker;
  $("battleList").onclick = e => {
    const b = e.target.closest("[data-battle]"); if (!b) return;
    const saved = loadBattleSave(), resume = !!b.dataset.resume;
    if (!resume && saved && saved.id !== b.dataset.battle && saved.account.positions.length
      && !confirm("另一場戰役還有持倉，開始新戰役會覆蓋那場的進度。確定嗎？")) return;
    closePicker();
    enterBattle(b.dataset.battle, resume);
    renderAccountBtn(); renderAll();
    toast(`進入經典戰役「${market.info.title}」・按「下一天」推進`);
  };
  $("battleNextBtn").onclick = nextBattleDay;
  $("battleAutoBtn").onclick = () => { battleAuto = !battleAuto; renderBattleBar(); };
  $("battleExitBtn").onclick = leaveBattle;
}

function loop() {
  if (mode === "server") { poll(); return; }
  if (mode === "battle") { if (battleAuto && !risk) nextBattleDay(); return; }
  if (ui.paused || (risk && risk.auto)) return;
  const { prices, news: plain, event } = market.tick();
  const news = event || plain;
  E.accrueLoan(state, 1);
  const events = E.settleTick(state, prices, Date.now());
  showEvents(events);
  if (news && news.step !== lastNewsStep) { lastNewsStep = news.step; showNews(news); }
  equityPts.push(E.equity(state, prices));
  if (equityPts.length > 500) equityPts.shift();
  trackLossTime(prices, { ms: 1500 });
  checkAccountAch(prices);
  Store.save(state);
  renderAll();
  checkRisk(prices);
  if (!$("newsCenter").classList.contains("hidden")) renderNewsCenter();
}

/* ---------- 伺服器模式 ---------- */
// 套用伺服器回傳的完整畫面資料
function applyServer(v) {
  catchingUp = !!v.catchingUp;
  remainingTicks = v.remainingTicks || 0;
  serverMarketMode = v.marketMode || "legacy";
  switchStatus = v.switchStatus || "ready";
  settledPrices = v.accountValuation?.prices || null;
  accountSettledAt = v.accountSettledAt || null;
  if (lastMarketMode === "legacy" && serverMarketMode === "shared") toast("舊持倉已結束，現在使用與其他玩家相同的虛構行情。參賽需自願重置新回合。");
  lastMarketMode = serverMarketMode;
  progress = v.progress || null; resets = v.resets || 0;
  const fresh = market.apply(v);
  const a = v.account;
  state.cash = a.cash; state.startingCash = a.startingCash; state.nextId = a.nextId;
  state.positions = a.positions; state.log = a.log;
  if (a.loan) state.loan = a.loan; else delete state.loan;
  equityPts.length = 0; equityPts.push(...(a.eq || []), E.equity(state, settledPrices || market.prices()));
  showEvents(v.events || []);
  if (!catchingUp && market.ready()) {
    const px = settledPrices || market.prices(), now = Date.now();
    // 浮虧計時用實際經過時間；分頁隱藏或斷線造成的大空檔最多算 5 秒。
    if (lastLossTrack) trackLossTime(px, { ms: Math.min(5000, Math.max(0, now - lastLossTrack)) });
    lastLossTrack = now;
    scanLog(a.log);
    checkAccountAch(px);
  }
  const latest = fresh.filter(n => n.event).at(-1) || fresh[fresh.length - 1];
  if (latest) showNews(latest);
  lastOk = Date.now();
  setSyncUi("ok", catchingUp
    ? `共同行情正在補算；帳戶僅結算至 ${new Date(accountSettledAt || Date.now()).toLocaleString("zh-TW")}，尚差 ${remainingTicks} 根，不能交易。`
    : serverMarketMode === "legacy" ? "舊持倉仍用原本的個人行情，請結清後切換到全場共用虛構行情。" : "已連線。登入玩家共用同一組虛構行情。");
  renderAll();
  if (!catchingUp && market.ready()) checkRisk(settledPrices || market.prices());
  if (!$("newsCenter").classList.contains("hidden")) renderNewsCenter();
}

async function serverCall(fn) {
  if (busy) { toast("上一個操作還在處理中", true); return null; }
  if (!market.ready() || catchingUp) { toast("伺服器正在載入或結算離線行情，請稍候", true); return null; }
  if (Date.now() - lastOk > 6000) { toast("報價已超過 6 秒未更新，請等待重新連線", true); poll(); return null; }
  const epoch = modeEpoch;
  busy = true; setTradeBusy(true);
  try { const r = await fn(); if (!currentRequest(epoch)) return null; applyServer(r); return r; }
  catch (e) { if (currentRequest(epoch)) handleServerError(e); return null; }
  finally { if (epoch === modeEpoch) { busy = false; setTradeBusy(false); } }
}

async function poll() {
  if (mode !== "server" || busy || document.hidden) return;
  const epoch = modeEpoch;
  busy = true;
  try { const result = await Cloud.game.state(market.ready() ? market.step() : -1); if (currentRequest(epoch)) applyServer(result); }
  catch (e) { if (currentRequest(epoch)) handleServerError(e, true); }
  finally { if (epoch === modeEpoch) busy = false; }
}

function handleServerError(e, quiet = false) {
  if (e.status === 401) return; // onSessionLost 會處理
  setSyncUi("err", "連線問題：" + e.message);
  if (!quiet || Date.now() - lastOk > 10000) toast(e.message, true);
  renderModeBadge();
}

function setTradeBusy(on) {
  for (const id of ["longBtn", "shortBtn"]) $(id).classList.toggle("is-busy", on);
}

function renderModeBadge() {
  renderBattleBar();
  if (mode === "battle") {
    $("modeBadge").textContent = `經典戰役・${market.date()}`; $("modeBadge").className = "mode-badge battle";
    $("accountModeChip").textContent = "經典戰役・獨立帳戶";
    $("guestNote").classList.add("hidden"); $("pauseBtn").classList.add("hidden");
    $("dataStatus").textContent = "真實歷史日收盤・一根 = 一個交易日";
    return;
  }
  const server = mode === "server";
  const offline = server && Date.now() - lastOk > 6000;
  $("modeBadge").textContent = server ? (!lastOk ? "連線中…" : catchingUp ? `補算中・差${remainingTicks}根` : offline ? "連線中斷" : serverMarketMode === "legacy" ? "舊帳戶個人行情" : "全場共同行情") : "訪客・本機練習";
  $("modeBadge").className = "mode-badge " + (server ? (offline ? "warn" : "server") : "guest");
  $("accountModeChip").textContent = server ? serverMarketMode === "legacy" ? "舊持倉・暫停新開倉" : catchingUp ? "共同行情・帳戶補算中" : "共同行情・登入帳戶" : "訪客模式・不計成績";
  $("guestNote").classList.toggle("hidden", server);
  $("pauseBtn").classList.toggle("hidden", server);
  $("dataStatus").textContent = server ? catchingUp ? `帳戶已結算至 ${accountSettledAt ? new Date(accountSettledAt).toLocaleString("zh-TW") : "較早時段"}，尚差 ${remainingTicks} 根` : serverMarketMode === "legacy" ? "舊持倉沿用個人行情" : "所有登入玩家同價・1.5 秒更新" : (ui.paused ? "已暫停" : "每 1.5 秒更新");
}

function bind() {
  $("longBtn").onclick = () => order(1);
  $("shortBtn").onclick = () => order(-1);
  $("marginInput").oninput = e => { const v = Number(e.target.value); if (v > 0) { ui.margin = v; renderOrder(market.prices(), E.metrics(state, market.prices())); } };
  $("leverageRange").oninput = e => { ui.leverage = E.LEVERAGES[Number(e.target.value)]; renderOrder(market.prices(), E.metrics(state, market.prices())); };
  $("maxBtn").onclick = () => { const v = maxMargin(market.prices()); ui.margin = v; $("marginInput").value = v; renderOrder(market.prices(), E.metrics(state, market.prices())); };
  $("positions").onclick = e => {
    const h = e.target.closest("[data-help]");
    if (h) { openRisk(Number(h.dataset.help), false); return; }
    const b = e.target.closest("[data-close]"); if (!b) return;
    closePos(Number(b.dataset.close), b.dataset.pair);
  };
  bindRisk();
  bindBattle();
  const toggle = (id, key) => { $(id).onclick = () => { ui[key] = !ui[key]; $(id).classList.toggle("active", ui[key]); renderChart(); }; };
  toggle("maBtn", "showMA"); toggle("newsMarkBtn", "showNews"); toggle("posLineBtn", "showPos");
  $("pauseBtn").onclick = () => { ui.paused = !ui.paused; $("pauseBtn").textContent = ui.paused ? "繼續" : "暫停"; renderModeBadge(); };
  document.addEventListener("visibilitychange", () => { if (!document.hidden && mode === "server") poll(); });
  $("historyToggle").onclick = () => { ui.historyOpen = !ui.historyOpen; renderHistory(); };
  $("themeBtn").onclick = () => {
    const next = theme() === "night" ? "day" : "night";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    $("themeBtn").textContent = next === "night" ? "白天" : "夜間";
    renderAll();
  };
  const openNews = () => { renderNewsCenter(); $("newsCenter").classList.remove("hidden"); };
  const closeNews = () => $("newsCenter").classList.add("hidden");
  $("newsCenterBtn").onclick = openNews; $("newsCenterBtn2").onclick = openNews;
  $("newsCenterClose").onclick = closeNews; $("newsCenterOk").onclick = closeNews;
  $("newsFloatClose").onclick = () => $("newsFloat").classList.remove("show");
  $("resetBtn").onclick = () => $("confirmModal").classList.remove("hidden");
  $("confirmCancel").onclick = () => $("confirmModal").classList.add("hidden");
  $("confirmOk").onclick = resetAll;
  $("loanBorrowBtn").onclick = doBorrow;
  $("loanRepayBtn").onclick = doRepay;
  $("loanMaxBtn").onclick = () => {
    const owed = E.loanOwed(state);
    $("loanAmount").value = owed > 0 ? Math.min(owed, Math.floor(state.cash * 100) / 100) : E.LOAN_MAX;
    updateBankPreview();
  };
  $("loanAmount").addEventListener("input", updateBankPreview);
  document.querySelectorAll(".bank-tier").forEach(b => b.addEventListener("click", () => {
    $("loanAmount").value = b.dataset.amount; updateBankPreview();
  }));
  window.addEventListener("resize", renderAll);
}

/* ---------- 帳號 ---------- */
function setSyncUi(kind, text) {
  $("syncDot").className = "sync-dot " + kind;
  if (text != null) $("authSyncText").textContent = text;
}

function switchToServer() {
  enterServer();
  setSyncUi("busy", "連線中…");
  renderAll();
  poll();
}

function switchToGuest(msg) {
  enterGuest();
  renderAccountBtn();
  renderAll();
  if (msg) toast(msg);
}

function renderAccountBtn() {
  $("accountBtn").classList.toggle("hidden", !Cloud.enabled());
  const u = Cloud.user();
  $("accountLabel").textContent = u || "登入";
  if (!u) $("syncDot").className = "sync-dot";
}

let authMode = "login";
const AUTH_TEXT = {
  login: ["登入帳號", "登入", "登入後由伺服器計算行情與帳戶，成績才算數。"],
  register: ["建立新帳號", "註冊並登入", "註冊後會給你一組救援碼，忘記密碼時用它重設。"],
  reset: ["忘記密碼", "重設密碼並登入", "輸入註冊時拿到的救援碼，設定新密碼。"],
};
function setAuthMode(mode) {
  authMode = mode;
  $("tabLogin").classList.toggle("active", mode === "login");
  $("tabRegister").classList.toggle("active", mode === "register");
  const [title, submit, desc] = AUTH_TEXT[mode];
  $("authTitle").textContent = title; $("authSubmit").textContent = submit; $("authDesc").textContent = desc;
  $("authPassLabel").textContent = mode === "reset" ? "新密碼" : "密碼";
  $("authPass2Wrap").classList.toggle("hidden", mode === "login");
  $("authCodeWrap").classList.toggle("hidden", mode !== "reset");
  $("forgotLink").classList.toggle("hidden", mode !== "login");
  $("backToLogin").classList.toggle("hidden", mode !== "reset");
  $("authPass").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}

function openAuth() {
  const u = Cloud.user();
  $("authForm").classList.toggle("hidden", !!u);
  $("authInfo").classList.toggle("hidden", !u);
  if (u) {
    $("authName").textContent = u;
    Cloud.me().then(info => {
      if (Cloud.user() === u && !info.hasRecoveryCode) $("authSyncText").textContent = "你還沒有救援碼。請按「產生新救援碼」，以便忘記密碼時恢復帳號。";
    }).catch(() => {});
  }
  else { setAuthMode(authMode === "reset" ? "login" : authMode); $("authPass").value = ""; $("authPass2").value = ""; $("authCode").value = ""; }
  $("authModal").classList.remove("hidden");
  if (!u) setTimeout(() => $("authUser").focus(), 50);
}

// 顯示救援碼（只出現這一次），要勾選「已記下」才能關閉
function showRecoveryCode(code, title) {
  $("rcTitle").textContent = title;
  $("rcCode").textContent = code;
  $("rcAck").checked = false; $("rcDone").disabled = true;
  $("rcCopy").textContent = "複製";
  $("rcModal").classList.remove("hidden");
  return new Promise(resolve => { $("rcDone").onclick = () => { $("rcModal").classList.add("hidden"); resolve(); }; });
}

function bindAuth() {
  Cloud.onSessionLost(() => switchToGuest("登入已過期，請重新登入。現在是訪客模式。"));
  $("accountBtn").onclick = openAuth;
  $("guestLoginLink").onclick = () => { authMode = "login"; openAuth(); };
  $("authClose").onclick = () => $("authModal").classList.add("hidden");
  $("tabLogin").onclick = () => setAuthMode("login");
  $("tabRegister").onclick = () => setAuthMode("register");
  $("forgotLink").onclick = () => setAuthMode("reset");
  $("backToLogin").onclick = () => setAuthMode("login");
  $("rcAck").onchange = () => { $("rcDone").disabled = !$("rcAck").checked; };
  $("rcCopy").onclick = async () => {
    try { await navigator.clipboard.writeText($("rcCode").textContent); $("rcCopy").textContent = "已複製"; }
    catch { $("rcCopy").textContent = "請手動抄寫"; }
  };
  $("authFormEl").onsubmit = async e => {
    e.preventDefault();
    const username = $("authUser").value.trim(), password = $("authPass").value;
    const err = msg => { $("authError").textContent = msg; };
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return err("帳號需為 3~20 個英文字母、數字或底線");
    if (password.length < 8) return err("密碼至少 8 個字元");
    if (authMode !== "login" && password !== $("authPass2").value) return err("兩次輸入的密碼不一樣");
    if (authMode === "reset" && $("authCode").value.replace(/[^0-9A-Za-z]/g, "").length !== 16) return err("救援碼是 16 個英數字");
    $("authSubmit").disabled = true; err("");
    try {
      let code = null;
      if (authMode === "login") await Cloud.login(username, password);
      else if (authMode === "register") code = await Cloud.register(username, password);
      else code = await Cloud.resetPassword(username, $("authCode").value, password);
      $("authModal").classList.add("hidden");
      renderAccountBtn();
      if (code) await showRecoveryCode(code, authMode === "register" ? "帳號建立完成，請記下救援碼" : "密碼已重設，這是新的救援碼");
      toast(authMode === "login" ? `歡迎回來，${Cloud.user()}` : authMode === "register" ? `帳號 ${Cloud.user()} 建立完成` : "密碼已重設，其他裝置都已登出");
      switchToServer();
    } catch (ex) { err(ex.message); }
    finally { $("authSubmit").disabled = false; }
  };
  $("newCodeBtn").onclick = async () => {
    const pw = prompt("產生新的救援碼後，舊的會失效。請輸入密碼確認：");
    if (!pw) return;
    try { const code = await Cloud.newRecoveryCode(pw); $("authModal").classList.add("hidden"); await showRecoveryCode(code, "新的救援碼"); }
    catch (ex) { toast(ex.message, true); }
  };
  $("logoutBtn").onclick = async () => {
    await Cloud.logout();
    $("authModal").classList.add("hidden");
    switchToGuest("已登出。你的成績保存在伺服器，現在是訪客模式。");
  };
  $("deleteAccountBtn").onclick = async () => {
    const pw = prompt("刪除後帳號與成績都無法復原。請輸入密碼確認：");
    if (!pw) return;
    try { await Cloud.deleteAccount(pw); $("authModal").classList.add("hidden"); switchToGuest("帳號已刪除"); }
    catch (ex) { toast(ex.message, true); }
  };
}

try { const t = localStorage.getItem(THEME_KEY); if (t === "night") { document.documentElement.dataset.theme = "night"; $("themeBtn").textContent = "白天"; } } catch {}
$("marginInput").value = ui.margin;
bind();
bindAuth();
renderAccountBtn();
if (Cloud.enabled() && Cloud.user()) switchToServer(); else { enterGuest(); renderAll(); }
extras = initExtras({
  getContext: () => ({ mode, username: Cloud.user(), account: state, prices: market.prices(), progress, resets, catchingUp, equityPoints: equityPts.slice(), book }),
  refresh: async () => {
    if (mode !== "server") return true;
    if (busy) throw new Error("正在處理交易或更新行情，請稍後再試");
    const epoch = modeEpoch;
    busy = true;
    try {
      const result = await Cloud.game.state(market.ready() ? market.step() : -1);
      if (!currentRequest(epoch)) throw new Error("帳戶已切換，請重新開啟分享");
      applyServer(result);
      if (catchingUp) throw new Error("離線行情結算中，請完成後再分享");
      return true;
    } finally { if (epoch === modeEpoch) busy = false; }
  },
  onToast: toast,
});
leaderUI = initLeaderboard({
  request: (action, data) => {
    if (action === "list") return Cloud.leaderboard.list();
    if (action === "me") return Cloud.leaderboard.me();
    if (action === "join") return Cloud.leaderboard.join(data.nickname);
    if (action === "leave") return Cloud.leaderboard.leave();
    throw new Error("未知的排行榜操作");
  },
  onToast: toast,
  getContext: () => ({ mode, username: Cloud.user() }),
});
setInterval(loop, 1500);
