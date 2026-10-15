import { initExtras } from "./extras.mjs";
import { initLeaderboard } from "./leaderboard-ui.mjs";
import * as E from "./engine.mjs";
import { createMarket, PAIR_NAMES, NEWS_SETTLE } from "./market.mjs";
import * as Store from "./store.mjs";
import { drawCandles, drawSpark, drawEquity } from "./charts.mjs";
import * as Cloud from "./cloud.mjs";
import { createRemoteMarket } from "./remote.mjs";

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

function enterGuest() {
  modeEpoch++; busy = false; catchingUp = false; lastOk = 0;
  progress = null; resets = 0; settledPrices = null; accountSettledAt = null; remainingTicks = 0; serverMarketMode = "shared"; switchStatus = "ready"; lastMarketMode = null;
  mode = "guest";
  market = createMarket(Date.now() & 0x7fffffff);
  state = Store.load() || E.createAccount(10000);
  state.positions = state.positions.filter(p => market.get(p.pair) != null);
  equityPts.length = 0; equityPts.push(E.equity(state, market.prices()));
}

function enterServer() {
  modeEpoch++; busy = false; catchingUp = false; lastOk = 0;
  progress = null; resets = 0; settledPrices = null; accountSettledAt = null; remainingTicks = 0; serverMarketMode = "shared"; switchStatus = "ready"; lastMarketMode = null;
  mode = "server";
  market = createRemoteMarket();
  state = E.createAccount(10000);
  equityPts.length = 0;
}

const ui = { pair: "EUR/USD", margin: 500, leverage: 5, paused: false, showMA: true, showNews: true, showPos: true, historyOpen: false };
const equityPts = [];       // 淨值曲線：guest 每 tick 一點；server 用伺服器每 10 根記一次的紀錄
let newsTimer = 0, toastTimer = 0, lastNewsStep = -1;

const $ = id => document.getElementById(id);
const digits = p => (p.includes("JPY") ? 3 : 4);
const money = v => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedMoney = v => (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = v => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const signCls = v => (v > 0 ? "positive" : v < 0 ? "negative" : "");
const spaced = p => p.replace("/", " / ");
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

/* ---------- 左欄：貨幣對 ---------- */
function renderPairs() {
  const list = $("pairList");
  if (!list.dataset.built) {
    list.innerHTML = market.pairs().map(p => `
      <button type="button" class="pair-row" role="option" data-pair="${p}">
        <span><strong>${p}</strong><small>${PAIR_NAMES[p]}</small></span>
        <span class="pair-numbers"><strong data-f="price"></strong><small data-f="chg"></small></span>
        <canvas data-spark="${p}" aria-hidden="true"></canvas>
      </button>`).join("");
    list.dataset.built = "1";
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
  return m;
}

/* ---------- 圖表 ---------- */
function renderChart() {
  const p = ui.pair, cs = market.candles(p), last = cs[cs.length - 1], ch = change(p);
  $("pairTitle").textContent = spaced(p);
  $("pairName").textContent = PAIR_NAMES[p];
  $("currentPrice").textContent = last.c.toFixed(digits(p));
  $("currentPrice").className = signCls(last.c - last.o);
  $("priceChange").textContent = pct(ch); $("priceChange").className = signCls(ch);

  const lines = [];
  if (ui.showPos) for (const pos of state.positions.filter(x => x.pair === p)) {
    lines.push({ price: pos.entry, kind: "entry", label: `#${pos.id} ${pos.side > 0 ? "多" : "空"} 進場` });
    lines.push({ price: E.liquidationPrice(pos), kind: "liq", label: `#${pos.id} 強平` });
  }
  const step = market.step();
  const marks = ui.showNews ? market.news().filter(n => n.pair === p).map(n => ({ t: n.step, reversed: (n.settled != null ? n.settled : step - n.step >= NEWS_SETTLE) && !!n.reversed })) : [];
  drawCandles($("chart"), cs, { theme: theme(), digits: digits(p), lines, marks, showMA: ui.showMA });
}

/* ---------- 下單 ---------- */
function renderOrder(prices, m) {
  const p = ui.pair, price = prices[p], lev = ui.leverage, margin = ui.margin;
  const notional = margin * lev;
  $("orderPair").textContent = spaced(p);
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
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.open({ pair: ui.pair, side, leverage: ui.leverage, margin }, market.step()));
    const pos = r && r.result && r.result.opened;
    if (pos) toast(`已${side > 0 ? "做多" : "做空"} ${ui.pair}・進場 ${pos.entry.toFixed(digits(ui.pair))}・手續費 ${money(pos.feePaid)}`);
    return;
  }
  const r = E.openPosition(state, market.prices(), { pair: ui.pair, side, leverage: ui.leverage, notional: margin * ui.leverage, time: Date.now() });
  if (!r.ok) { toast(r.error, true); return; }
  toast(`已${side > 0 ? "做多" : "做空"} ${ui.pair}・名目 ${money(r.position.notional)}・手續費 ${money(r.position.feePaid)}`);
  afterChange();
}

async function closePos(id, pair) {
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.close(id, market.step()));
    if (r && r.result) toast(`已平倉・${r.result.pnl >= 0 ? "獲利" : "虧損"} ${signedMoney(r.result.pnl)}`, r.result.pnl < 0);
    return;
  }
  const r = E.closePosition(state, id, market.get(pair), Date.now());
  if (r.ok) toast(`已平倉・${r.pnl >= 0 ? "獲利" : "虧損"} ${signedMoney(r.pnl)}`, r.pnl < 0);
  afterChange();
}

async function resetAll() {
  $("confirmModal").classList.add("hidden");
  if (mode === "server") {
    const r = await serverCall(() => Cloud.game.reset(market.step()));
    if (r) { equityPts.length = 0; toast("帳戶已重置為 $10,000（行情不會重新開始）"); }
    return;
  }
  E.resetAccount(state); Store.clear(); equityPts.length = 0;
  toast("帳戶已重置為 $10,000"); afterChange();
}

/* ---------- 持倉 ---------- */
function renderPositions(prices) {
  const root = $("positions");
  $("positionCount").textContent = state.positions.length;
  $("riskHint").textContent = state.positions.length ? `合計 ${money(E.usedMargin(state))} 保證金` : "暫無持倉";
  if (!state.positions.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-icon">♡</div>還沒有持倉，選一個貨幣對開始吧</div>';
    return;
  }
  root.innerHTML = state.positions.map(pos => {
    const price = prices[pos.pair], pnl = E.unrealizedPnl(pos, price), d = digits(pos.pair);
    const risk = E.lossPct(pos, price), riskW = Math.min(100, risk / E.LIQ_LOSS * 100);
    const riskColor = risk >= E.WARN_LOSS ? cssVar("--down") : risk >= 0.3 ? "#e9a35a" : cssVar("--accent");
    return `<div class="position-row${risk >= E.WARN_LOSS ? " risky" : ""}">
      <div class="pos-name"><strong>${pos.pair}<span class="direction ${pos.side > 0 ? "long" : "short"}">${pos.side > 0 ? "做多" : "做空"}</span>${risk >= E.WARN_LOSS ? '<span class="risk-tag">風險偏高</span>' : ""}</strong>
        <small>${money(pos.margin)} 保證金・${pos.leverage}×・${money(pos.notional)} 倉位</small></div>
      <div class="pos-cell pos-entry"><small>進場價</small><strong>${pos.entry.toFixed(d)}</strong></div>
      <div class="pos-cell"><small>現價</small><strong>${price.toFixed(d)}</strong></div>
      <div class="pos-cell pos-liq"><small>強平價</small><strong>${E.liquidationPrice(pos).toFixed(d)}</strong></div>
      <div class="pos-cell"><small>浮動盈虧</small><strong class="${signCls(pnl)}">${signedMoney(pnl)}</strong>
        <div class="risk-bar" title="距離強平"><i style="width:${riskW}%;background:${riskColor}"></i></div></div>
      <button class="close-btn" type="button" data-close="${pos.id}" data-pair="${pos.pair}">平倉</button>
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

function showNews(n) {
  const bull = n.claimed > 0;
  $("tickerTag").textContent = `${n.pair} ${bull ? "利多" : "利空"}`;
  $("tickerTag").className = "ticker-tag" + (bull ? "" : " bear");
  const track = $("tickerTrack");
  track.textContent = `${n.text}　——　${n.pair} 可能${bull ? "走高" : "走低"}，但市場不一定照劇本走。`;
  track.className = "ticker-track";
  $("nfTag").textContent = `${n.pair}・${bull ? "利多" : "利空"}`;
  $("nfTag").className = "nf-tag" + (bull ? "" : " bear");
  $("nfTitle").textContent = n.text;
  $("nfBody").textContent = `新聞通常推動 ${n.pair} ${bull ? "上漲" : "下跌"}，但約四分之一的情況市場會反向。點左側貨幣對可查看走勢。`;
  $("newsFloat").classList.add("show");
  clearTimeout(newsTimer); newsTimer = setTimeout(() => $("newsFloat").classList.remove("show"), 5200);
}

function renderNewsCenter() {
  const step = market.step();
  const list = market.news().slice().reverse();
  $("newsCenterList").innerHTML = list.length ? list.map(n => {
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
}

function afterChange() { Store.save(state); equityPts.push(E.equity(state, market.prices())); renderAll(); }

function showEvents(events) {
  for (const ev of events) {
    if (ev.type === "liquidated") toast(`#${ev.id} ${ev.pair} 虧損達保證金 80%，已強制平倉`, true);
    if (ev.type === "expired") toast(`#${ev.id} ${ev.pair} 持倉滿 7 天，到期已自動平倉`);
  }
}

function loop() {
  if (mode === "server") { poll(); return; }
  if (ui.paused) return;
  const { prices, news } = market.tick();
  const events = E.settleTick(state, prices, Date.now());
  showEvents(events);
  if (news && news.step !== lastNewsStep) { lastNewsStep = news.step; showNews(news); }
  equityPts.push(E.equity(state, prices));
  if (equityPts.length > 500) equityPts.shift();
  Store.save(state);
  renderAll();
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
  equityPts.length = 0; equityPts.push(...(a.eq || []), E.equity(state, settledPrices || market.prices()));
  showEvents(v.events || []);
  const latest = fresh[fresh.length - 1];
  if (latest) showNews(latest);
  lastOk = Date.now();
  setSyncUi("ok", catchingUp
    ? `共同行情正在補算；帳戶僅結算至 ${new Date(accountSettledAt || Date.now()).toLocaleString("zh-TW")}，尚差 ${remainingTicks} 根，不能交易。`
    : serverMarketMode === "legacy" ? "舊持倉仍用原本的個人行情，請結清後切換到全場共用虛構行情。" : "已連線。登入玩家共用同一組虛構行情。");
  renderAll();
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
    const b = e.target.closest("[data-close]"); if (!b) return;
    closePos(Number(b.dataset.close), b.dataset.pair);
  };
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
  getContext: () => ({ mode, username: Cloud.user(), account: state, prices: market.prices(), progress, resets, catchingUp, equityPoints: equityPts.slice() }),
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
