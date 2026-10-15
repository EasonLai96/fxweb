import * as E from "./engine.mjs";
import { createMarket, PAIR_NAMES } from "./market.mjs";
import * as Store from "./store.mjs";
import { drawCandles, drawSpark, drawEquity } from "./charts.mjs";
import * as Cloud from "./cloud.mjs";

const THEME_KEY = "fxweb.theme";
const market = createMarket(Date.now() & 0x7fffffff);
let state = Store.load() || E.createAccount(10000);
// 舊存檔可能有不在目前清單裡的貨幣對：沒有報價就無法結算，直接移除並退回保證金（不計損益）。
state.positions = state.positions.filter(p => market.get(p.pair) != null);

const ui = { pair: market.pairs()[0], margin: 500, leverage: 5, paused: false, showMA: true, showNews: true, showPos: true, historyOpen: false };
const equityPts = [];
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
  const m = E.metrics(state, prices);
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
  const marks = ui.showNews ? market.news().filter(n => n.pair === p).map(n => ({ t: n.step, reversed: step - n.step >= 8 && n.reversed })) : [];
  drawCandles($("chart"), cs, { theme: theme(), digits: digits(p), lines, marks, showMA: ui.showMA });
}

/* ---------- 下單 ---------- */
function renderOrder(prices, m) {
  const p = ui.pair, price = prices[p], lev = ui.leverage, margin = ui.margin;
  const notional = margin * lev;
  $("orderPair").textContent = spaced(p);
  $("leverageValue").textContent = lev + "×";
  $("leverageRange").value = lev;
  $("leverageRange").style.setProperty("--progress", `${(lev - 1) / (E.MAX_LEVERAGE - 1) * 100}%`);
  $("notional").textContent = money(notional);
  $("tradeFee").textContent = money(E.feeFor(notional, lev));
  $("riskPercent").textContent = (E.LIQ_LOSS / lev * 100).toFixed(2) + "%";
  const fake = side => E.liquidationPrice({ pair: p, side, leverage: lev, entry: price });
  $("liqPreview").textContent = `${fake(1).toFixed(digits(p))} / ${fake(-1).toFixed(digits(p))}`;
  const frozen = m.frozen;
  $("longBtn").disabled = frozen; $("shortBtn").disabled = frozen;
}

function maxMargin(prices) {
  const lev = ui.leverage, free = E.freeMargin(state, prices);
  const perMargin = 1 + lev * (0.00005 + lev * 0.000005); // 保證金 + 手續費 占用
  return Math.max(0, Math.floor(free / perMargin * 100) / 100);
}

function order(side) {
  const prices = market.prices();
  const margin = Number($("marginInput").value);
  if (!(margin >= 10)) { toast("保證金至少 $10", true); return; }
  ui.margin = margin;
  const r = E.openPosition(state, prices, { pair: ui.pair, side, leverage: ui.leverage, notional: margin * ui.leverage, time: Date.now() });
  if (!r.ok) { toast(r.error, true); return; }
  toast(`已${side > 0 ? "做多" : "做空"} ${ui.pair}・名目 ${money(r.position.notional)}・手續費 ${money(r.position.feePaid)}`);
  afterChange();
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
    const bull = n.claimed > 0, settled = step - n.step >= 8;
    return `<div class="news-item"><span class="nf-tag${bull ? "" : " bear"}">${n.pair}・${bull ? "利多" : "利空"}</span>${settled && n.reversed ? '<span class="rev-tag">市場反向</span>' : ""}
      <h4>${esc(n.text)}</h4><small>${settled ? (n.reversed ? "結果：市場走出相反方向" : "結果：市場照新聞方向走") : "行情發酵中…"}・${step - n.step} 根 K 線前</small></div>`;
  }).join("") : '<div class="empty-state"><div class="empty-icon">✦</div>還沒有新聞，稍等一下</div>';
}

/* ---------- 主流程 ---------- */
function renderAll() {
  const prices = market.prices();
  renderPairs();
  const m = renderAccount(prices);
  renderChart();
  renderOrder(prices, m);
  renderPositions(prices);
  renderEquity();
  renderHistory();
}

function afterChange() { persist(true); equityPts.push(E.equity(state, market.prices())); renderAll(); }

function loop() {
  if (ui.paused) return;
  const { prices, news } = market.tick();
  const events = E.settleTick(state, prices, Date.now());
  for (const ev of events) if (ev.type === "liquidated") toast(`#${ev.id} ${ev.pair} 虧損達保證金 80%，已強制平倉`, true);
  if (news && news.step !== lastNewsStep) { lastNewsStep = news.step; showNews(news); }
  equityPts.push(E.equity(state, prices));
  if (equityPts.length > 500) equityPts.shift();
  persist(events.length > 0);
  renderAll();
  if (!$("newsCenter").classList.contains("hidden")) renderNewsCenter();
}

function bind() {
  $("longBtn").onclick = () => order(1);
  $("shortBtn").onclick = () => order(-1);
  $("marginInput").oninput = e => { const v = Number(e.target.value); if (v > 0) { ui.margin = v; renderOrder(market.prices(), E.metrics(state, market.prices())); } };
  $("leverageRange").oninput = e => { ui.leverage = Number(e.target.value); renderOrder(market.prices(), E.metrics(state, market.prices())); };
  $("maxBtn").onclick = () => { const v = maxMargin(market.prices()); ui.margin = v; $("marginInput").value = v; renderOrder(market.prices(), E.metrics(state, market.prices())); };
  $("positions").onclick = e => {
    const b = e.target.closest("[data-close]"); if (!b) return;
    const r = E.closePosition(state, Number(b.dataset.close), market.get(b.dataset.pair), Date.now());
    if (r.ok) toast(`已平倉・${r.pnl >= 0 ? "獲利" : "虧損"} ${signedMoney(r.pnl)}`, r.pnl < 0);
    afterChange();
  };
  const toggle = (id, key) => { $(id).onclick = () => { ui[key] = !ui[key]; $(id).classList.toggle("active", ui[key]); renderChart(); }; };
  toggle("maBtn", "showMA"); toggle("newsMarkBtn", "showNews"); toggle("posLineBtn", "showPos");
  $("pauseBtn").onclick = () => { ui.paused = !ui.paused; $("pauseBtn").textContent = ui.paused ? "繼續" : "暫停"; $("dataStatus").textContent = ui.paused ? "已暫停" : "每 1.5 秒更新"; };
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
  $("confirmOk").onclick = () => {
    E.resetAccount(state); Store.clear(); equityPts.length = 0; dirty = true;
    $("confirmModal").classList.add("hidden"); toast("帳戶已重置為 $10,000"); afterChange();
  };
  window.addEventListener("resize", renderAll);
}

/* ---------- 雲端同步 ---------- */
// 本機每 tick 都存；雲端只在「有交易變動」後 4 秒存一次，加上每 60 秒保底，避免一直打 API。
let dirty = false, syncTimer = 0, syncing = false, lastSyncAt = 0, syncError = "";
const SYNC_DELAY = 4000, SYNC_INTERVAL = 60000;

function persist(changed) {
  Store.save(state);
  if (changed) dirty = true;
  if (!Cloud.user()) return;
  if (changed) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, SYNC_DELAY); }
  else if (Date.now() - lastSyncAt > SYNC_INTERVAL) syncNow();
}

function setSyncUi(kind, text) {
  $("syncDot").className = "sync-dot " + kind;
  if (text != null) $("authSyncText").textContent = text;
}

function summary(d) {
  const n = Store.normalize(d);
  if (!n) return "（無法讀取）";
  const last = n.log.length ? n.log[n.log.length - 1] : null;
  const lastTxt = last && last.t ? new Date(last.t).toLocaleTimeString("zh-TW", { hour12: false }) : "—";
  return `現金 ${money(n.cash)}\n持倉 ${n.positions.length} 筆・交易 ${n.log.length} 筆\n最後交易 ${lastTxt}`;
}

function adopt(data) {
  const n = Store.normalize(data);
  if (!n) return false;
  n.positions = n.positions.filter(p => market.get(p.pair) != null);
  Object.assign(state, n);
  Store.save(state);
  equityPts.length = 0; equityPts.push(E.equity(state, market.prices()));
  renderAll();
  return true;
}

async function syncNow({ force = false } = {}) {
  if (!Cloud.user() || syncing) return;
  if (!dirty && !force && Date.now() - lastSyncAt < SYNC_INTERVAL) return;
  syncing = true; setSyncUi("busy", "同步中…");
  try {
    await Cloud.pushSave(Store.snapshot(state), { force });
    dirty = false; lastSyncAt = Date.now(); syncError = "";
    setSyncUi("ok", `已同步到雲端（${new Date().toLocaleTimeString("zh-TW", { hour12: false })}）`);
  } catch (e) {
    if (e.status === 409) { syncing = false; return resolveConflict(e.body.server); }
    if (e.status === 401) { toast("登入已過期，請重新登入", true); renderAccountBtn(); }
    syncError = e.message; lastSyncAt = Date.now();
    setSyncUi("err", "同步失敗：" + e.message + "（進度仍保存在這台裝置）");
  } finally { syncing = false; }
}

function resolveConflict(server) {
  if (!server) { Cloud.setVersion(0); return syncNow(); }
  return new Promise(resolve => {
    $("cloudSummary").textContent = summary(server.data) + "\n上傳於 " + new Date(server.updatedAt).toLocaleTimeString("zh-TW", { hour12: false });
    $("localSummary").textContent = summary(Store.snapshot(state)) + "\n目前畫面";
    $("conflictModal").classList.remove("hidden");
    const done = async useCloud => {
      $("conflictModal").classList.add("hidden");
      $("useCloudBtn").onclick = $("useLocalBtn").onclick = null;
      if (useCloud) { adopt(server.data); Cloud.setVersion(server.version); dirty = false; lastSyncAt = Date.now(); setSyncUi("ok", "已改用雲端存檔"); toast("已載入雲端存檔"); }
      else { await syncNow({ force: true }); toast("已用這台裝置的進度覆蓋雲端"); }
      resolve();
    };
    $("useCloudBtn").onclick = () => done(true);
    $("useLocalBtn").onclick = () => done(false);
  });
}

// 登入後：雲端沒有存檔 -> 上傳本機；有存檔且本機是全新帳戶 -> 直接載入；兩邊都有進度 -> 讓玩家選。
async function afterLogin() {
  setSyncUi("busy", "讀取雲端存檔…");
  try {
    const server = await Cloud.fetchSave();
    const local = Store.snapshot(state);
    const localFresh = local.positions.length === 0 && local.log.length === 0 && local.cash === local.startingCash;
    if (!server) { Cloud.setVersion(0); dirty = true; await syncNow(); }
    else if (localFresh) { adopt(server.data); Cloud.setVersion(server.version); lastSyncAt = Date.now(); setSyncUi("ok", "已載入雲端存檔"); }
    else if (JSON.stringify(server.data) === JSON.stringify(local)) { Cloud.setVersion(server.version); lastSyncAt = Date.now(); setSyncUi("ok", "存檔已是最新"); }
    else await resolveConflict(server);
  } catch (e) {
    setSyncUi("err", "讀取雲端存檔失敗：" + e.message);
  }
  renderAccountBtn();
}

function renderAccountBtn() {
  const btn = $("accountBtn");
  btn.classList.toggle("hidden", !Cloud.enabled());
  const u = Cloud.user();
  $("accountLabel").textContent = u || "登入";
  if (!u) $("syncDot").className = "sync-dot";
}

let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  $("tabLogin").classList.toggle("active", mode === "login");
  $("tabRegister").classList.toggle("active", mode === "register");
  $("authTitle").textContent = mode === "login" ? "登入帳號" : "建立新帳號";
  $("authSubmit").textContent = mode === "login" ? "登入" : "註冊並登入";
  $("authPass2Wrap").classList.toggle("hidden", mode !== "register");
  $("authPass").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("authError").textContent = "";
}

function openAuth() {
  const u = Cloud.user();
  $("authForm").classList.toggle("hidden", !!u);
  $("authInfo").classList.toggle("hidden", !u);
  if (u) $("authName").textContent = u;
  else { setAuthMode(authMode); $("authPass").value = ""; $("authPass2").value = ""; }
  $("authModal").classList.remove("hidden");
  if (!u) setTimeout(() => $("authUser").focus(), 50);
}

function bindAuth() {
  $("accountBtn").onclick = openAuth;
  $("authClose").onclick = () => $("authModal").classList.add("hidden");
  $("tabLogin").onclick = () => setAuthMode("login");
  $("tabRegister").onclick = () => setAuthMode("register");
  $("authFormEl").onsubmit = async e => {
    e.preventDefault();
    const username = $("authUser").value.trim(), password = $("authPass").value;
    const err = msg => { $("authError").textContent = msg; };
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return err("帳號需為 3~20 個英文字母、數字或底線");
    if (password.length < 8) return err("密碼至少 8 個字元");
    if (authMode === "register" && password !== $("authPass2").value) return err("兩次輸入的密碼不一樣");
    $("authSubmit").disabled = true; err("");
    try {
      if (authMode === "login") await Cloud.login(username, password); else await Cloud.register(username, password);
      $("authModal").classList.add("hidden");
      toast(authMode === "login" ? `歡迎回來，${Cloud.user()}` : `帳號 ${Cloud.user()} 建立完成`);
      renderAccountBtn();
      await afterLogin();
    } catch (ex) { err(ex.message); }
    finally { $("authSubmit").disabled = false; }
  };
  $("syncNowBtn").onclick = () => { dirty = true; syncNow(); };
  $("logoutBtn").onclick = async () => {
    await syncNow();
    await Cloud.logout();
    $("authModal").classList.add("hidden");
    renderAccountBtn(); toast("已登出，進度仍保留在這台裝置");
  };
  $("deleteAccountBtn").onclick = async () => {
    const pw = prompt("刪除後無法復原。請輸入密碼確認：");
    if (!pw) return;
    try { await Cloud.deleteAccount(pw); $("authModal").classList.add("hidden"); renderAccountBtn(); toast("帳號與雲端存檔已刪除"); }
    catch (ex) { toast(ex.message, true); }
  };
  window.addEventListener("pagehide", () => { if (dirty && Cloud.user()) syncNow(); });
}

try { const t = localStorage.getItem(THEME_KEY); if (t === "night") { document.documentElement.dataset.theme = "night"; $("themeBtn").textContent = "白天"; } } catch {}
$("marginInput").value = ui.margin;
bind();
bindAuth();
renderAccountBtn();
if (Cloud.user()) afterLogin();
equityPts.push(E.equity(state, market.prices()));
renderAll();
setInterval(loop, 1500);
