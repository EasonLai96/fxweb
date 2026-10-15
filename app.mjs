import * as E from "./engine.mjs";
import { createMarket } from "./market.mjs";
import * as Store from "./store.mjs";
import { drawCandles, drawSpark, drawEquity } from "./charts.mjs";

const market = createMarket(Date.now() & 0x7fffffff);
let state = Store.load() || E.createAccount(10000);
let paused = false;
let activePair = market.pairs()[0];
const equityPts = [];
const EQUITY_MAX = 400;

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const digits = (p) => (p.includes("JPY") ? 3 : 4);
const dirCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const pct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function sessionChange(p) {
  const cs = market.candles(p);
  if (!cs.length) return 0;
  return cs[cs.length - 1].c / cs[0].o - 1;
}

function buildQuotes() {
  $("quotes").innerHTML = market.pairs().map(p => `
    <div class="qcard" data-pair="${p}">
      <span class="qp">${p}</span>
      <span class="price" data-q="price"></span>
      <span class="chg" data-q="chg"></span>
      <canvas data-q="spark"></canvas>
    </div>`).join("");
  $("quotes").querySelectorAll(".qcard").forEach(el => el.onclick = () => selectPair(el.dataset.pair));
  $("pair").innerHTML = market.pairs().map(p => `<option>${p}</option>`).join("");
  $("pair").onchange = () => selectPair($("pair").value);
}

function selectPair(p) {
  activePair = p;
  $("pair").value = p;
  renderAll();
}

function renderQuotes() {
  document.querySelectorAll(".qcard").forEach(el => {
    const p = el.dataset.pair;
    const cs = market.candles(p);
    const last = cs[cs.length - 1];
    const chg = sessionChange(p);
    el.classList.toggle("active", p === activePair);
    const pe = el.querySelector('[data-q="price"]');
    pe.textContent = fmt(last.c, digits(p));
    pe.className = "price " + dirCls(last.c - last.o);
    const ce = el.querySelector('[data-q="chg"]');
    ce.textContent = pct(chg);
    ce.className = "chg " + dirCls(chg);
    drawSpark(el.querySelector('[data-q="spark"]'), cs.slice(-60).map(c => c.c));
  });
}

function renderChart() {
  const p = activePair, d = digits(p);
  const cs = market.candles(p);
  const last = cs[cs.length - 1];
  $("chartPair").textContent = p;
  $("chartPrice").textContent = fmt(last.c, d);
  $("chartPrice").className = "price " + dirCls(last.c - last.o);
  const chg = sessionChange(p);
  $("chartChg").textContent = pct(chg);
  $("chartChg").className = "chg " + dirCls(chg);

  const lines = [];
  for (const pos of state.positions.filter(x => x.pair === p)) {
    lines.push({ price: pos.entry, color: "#7aa7ff", label: `#${pos.id} ${pos.side > 0 ? "多" : "空"} 進場` });
    lines.push({ price: E.liquidationPrice(pos), color: "#ff9f43", label: `#${pos.id} 強平` });
  }
  const marks = market.news().filter(n => n.pair === p).map(n => ({ t: n.step, reversed: n.reversed }));
  drawCandles($("kline"), cs, { digits: d, lines, marks });
}

function renderAccount(prices) {
  const m = E.metrics(state, prices);
  const ret = m.equity / state.startingCash - 1;
  $("equity").textContent = fmt(m.equity);
  $("equity").className = dirCls(ret);
  $("retPct").textContent = pct(ret);
  $("retPct").className = dirCls(ret);
  $("cash").textContent = fmt(m.cash);
  $("used").textContent = fmt(m.usedMargin);
  $("free").textContent = fmt(m.freeMargin);
  const usage = m.equity > 0 ? m.usedMargin / m.equity : 1;
  $("usage").textContent = (usage * 100).toFixed(1) + "%";
  const bar = $("meterBar");
  bar.style.width = Math.min(100, usage * 100) + "%";
  bar.className = usage >= 0.8 ? "danger" : usage >= 0.5 ? "warn" : "";
  $("frozen").classList.toggle("hidden", !m.frozen);
}

function renderPositions(prices) {
  const tb = $("posTable").querySelector("tbody");
  $("noPos").classList.toggle("hidden", state.positions.length > 0);
  tb.innerHTML = state.positions.map(p => {
    const price = prices[p.pair];
    const pnl = E.unrealizedPnl(p, price);
    const d = digits(p.pair);
    const lp = E.lossPct(p, price);
    return `<tr class="${lp >= E.WARN_LOSS ? "warnrow" : ""}">
      <td>${p.pair}</td><td class="${p.side > 0 ? "up" : "down"}">${p.side > 0 ? "多" : "空"}</td>
      <td>${fmt(p.notional, 0)}</td><td>${p.leverage}x</td>
      <td>${fmt(p.entry, d)}</td><td>${fmt(price, d)}</td>
      <td>${fmt(E.liquidationPrice(p), d)}</td>
      <td class="${dirCls(pnl)}">${fmt(pnl)}</td>
      <td><button data-close="${p.id}" data-pair="${p.pair}">平倉</button></td>
    </tr>`;
  }).join("");
  tb.querySelectorAll("button[data-close]").forEach(b =>
    b.onclick = () => { E.closePosition(state, Number(b.dataset.close), market.get(b.dataset.pair), Date.now()); afterChange(); });
}

function renderNews() {
  const list = market.news().slice().reverse().slice(0, 12);
  if (!list.length) return;
  $("newsList").innerHTML = list.map((n, i) => `
    <li class="${i === 0 && n.step === market.step() ? "news-new" : ""}">
      <span class="tag">${n.pair}</span>
      <span>${esc(n.text)} <span class="${n.claimed > 0 ? "up" : "down"}">${n.claimed > 0 ? "利多" : "利空"}</span></span>
      ${n.reversed ? '<span class="tag rev">市場反向</span>' : ""}
    </li>`).join("");
}

function renderHistory() {
  const closes = state.log.filter(l => l.type === "close").slice(-10).reverse();
  if (!closes.length) { $("histList").innerHTML = '<li class="empty">還沒有成交紀錄</li>'; return; }
  const reason = { manual: "手動平倉", liquidated: "強制平倉" };
  $("histList").innerHTML = closes.map(l => `
    <li><span class="tag ${l.reason === "liquidated" ? "rev" : ""}">${reason[l.reason] || l.reason}</span>
    <span>#${l.id} ${l.pair} @ ${fmt(l.price, digits(l.pair))}</span>
    <b class="${dirCls(l.pnl)}" style="margin-left:auto">${fmt(l.pnl)}</b></li>`).join("");
}

function renderOrderInfo(prices) {
  const notional = Number($("notional").value) || 0;
  const lev = Number($("lev").value);
  const price = prices[$("pair").value];
  const margin = notional / lev, fee = E.feeFor(notional, lev);
  const longLiq = price * (1 - E.LIQ_LOSS / lev), shortLiq = price * (1 + E.LIQ_LOSS / lev);
  const d = digits($("pair").value);
  $("orderInfo").textContent = `保證金 ${fmt(margin)}・手續費 ${fmt(fee)}・強平價 多 ${fmt(longLiq, d)} / 空 ${fmt(shortLiq, d)}`;
}

function renderAll() {
  const prices = market.prices();
  renderQuotes();
  renderChart();
  renderAccount(prices);
  renderPositions(prices);
  renderOrderInfo(prices);
  renderNews();
  renderHistory();
  drawEquity($("equityChart"), equityPts, state.startingCash);
}

function afterChange() { Store.save(state); renderAll(); }

function order(side) {
  const pair = $("pair").value;
  const notional = Number($("notional").value);
  const leverage = Number($("lev").value);
  const r = E.openPosition(state, market.prices(), { pair, side, leverage, notional, time: Date.now() });
  const msg = $("orderMsg");
  if (!r.ok) { msg.textContent = r.error; msg.classList.add("err"); }
  else { msg.textContent = `已開${side > 0 ? "多" : "空"} ${pair} ${fmt(notional, 0)} @${leverage}x`; msg.classList.remove("err"); activePair = pair; afterChange(); }
}

function loop() {
  if (paused) return;
  const { prices } = market.tick();
  const events = E.settleTick(state, prices, Date.now());
  if (events.some(e => e.type === "liquidated")) { const m = $("orderMsg"); m.textContent = "有持倉被強制平倉"; m.classList.add("err"); }
  equityPts.push(E.equity(state, prices));
  if (equityPts.length > EQUITY_MAX) equityPts.shift();
  Store.save(state);
  renderAll();
}

$("long").onclick = () => order(1);
$("short").onclick = () => order(-1);
$("notional").oninput = () => renderOrderInfo(market.prices());
$("lev").onchange = () => renderOrderInfo(market.prices());
$("menuBtn").onclick = () => $("menu").showModal();
$("colorToggle").onclick = (e) => {
  document.body.classList.toggle("intl");
  e.target.textContent = document.body.classList.contains("intl") ? "綠漲紅跌" : "紅漲綠跌";
  renderAll();
};
$("resetBtn").onclick = () => { E.resetAccount(state); Store.clear(); Store.save(state); equityPts.length = 0; $("menu").close(); afterChange(); };
$("exportBtn").onclick = () => { const a = $("exportArea"); a.classList.remove("hidden"); a.value = Store.exportText(state); a.select(); };
$("pauseBtn").onclick = () => { paused = !paused; $("pauseBtn").textContent = paused ? "繼續" : "暫停/繼續"; };
window.addEventListener("resize", renderAll);

buildQuotes();
equityPts.push(E.equity(state, market.prices()));
renderAll();
setInterval(loop, 1500);
