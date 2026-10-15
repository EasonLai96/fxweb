import * as E from "./engine.mjs";
import { createMarket } from "./market.mjs";
import * as Store from "./store.mjs";

const market = createMarket(Date.now() & 0x7fffffff);
let state = Store.load() || E.createAccount(10000);
let prev = market.prices();
let paused = false;

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const priceDigits = (p) => (p.includes("JPY") ? 3 : 4);

function fillPairs() {
  const sel = $("pair");
  sel.innerHTML = market.pairs().map(p => `<option>${p}</option>`).join("");
}

function renderQuotes(prices) {
  const box = $("quotes");
  box.innerHTML = market.pairs().map(p => {
    const d = priceDigits(p);
    const dir = prices[p] > prev[p] ? "up" : prices[p] < prev[p] ? "down" : "";
    return `<div class="quote"><span>${p}</span><span class="price ${dir}">${fmt(prices[p], d)}</span></div>`;
  }).join("");
}

function renderAccount(prices) {
  const m = E.metrics(state, prices);
  $("equity").textContent = fmt(m.equity);
  $("cash").textContent = fmt(m.cash);
  $("used").textContent = fmt(m.usedMargin);
  $("free").textContent = fmt(m.freeMargin);
  $("frozen").classList.toggle("hidden", !m.frozen);
}

function renderPositions(prices) {
  const tb = $("posTable").querySelector("tbody");
  $("noPos").classList.toggle("hidden", state.positions.length > 0);
  tb.innerHTML = state.positions.map(p => {
    const price = prices[p.pair];
    const pnl = E.unrealizedPnl(p, price);
    const cls = pnl > 0 ? "up" : pnl < 0 ? "down" : "";
    const d = priceDigits(p.pair);
    return `<tr>
      <td>${p.pair}</td><td>${p.side > 0 ? "多" : "空"}</td>
      <td>${fmt(p.notional, 0)}</td><td>${p.leverage}x</td>
      <td>${fmt(p.entry, d)}</td><td>${fmt(price, d)}</td>
      <td class="${cls}">${fmt(pnl)}</td>
      <td><button data-close="${p.id}" data-pair="${p.pair}">平倉</button></td>
    </tr>`;
  }).join("");
  tb.querySelectorAll("button[data-close]").forEach(b =>
    b.onclick = () => { E.closePosition(state, Number(b.dataset.close), market.get(b.dataset.pair), Date.now()); afterChange(); });
}

function renderAll(prices) { renderQuotes(prices); renderAccount(prices); renderPositions(prices); }

function afterChange() { Store.save(state); renderAll(market.prices()); }

function order(side) {
  const pair = $("pair").value;
  const notional = Number($("notional").value);
  const leverage = Number($("lev").value);
  const r = E.openPosition(state, market.prices(), { pair, side, leverage, notional, time: Date.now() });
  const msg = $("orderMsg");
  if (!r.ok) { msg.textContent = r.error; msg.classList.add("err"); }
  else { msg.textContent = `已開${side > 0 ? "多" : "空"} ${pair} ${notional} @${leverage}x`; msg.classList.remove("err"); afterChange(); }
}

function loop() {
  if (!paused) {
    prev = market.prices();
    const prices = market.tick();
    const events = E.settleTick(state, prices, Date.now());
    if (events.some(e => e.type === "liquidated")) { const m = $("orderMsg"); m.textContent = "有持倉被強制平倉"; m.classList.add("err"); }
    Store.save(state);
    renderAll(prices);
  }
}

$("long").onclick = () => order(1);
$("short").onclick = () => order(-1);
$("menuBtn").onclick = () => $("menu").showModal();
$("colorToggle").onclick = (e) => {
  document.body.classList.toggle("intl");
  e.target.textContent = document.body.classList.contains("intl") ? "綠漲紅跌" : "紅漲綠跌";
};
$("resetBtn").onclick = () => { E.resetAccount(state); Store.clear(); Store.save(state); $("menu").close(); afterChange(); };
$("exportBtn").onclick = () => { const a = $("exportArea"); a.classList.remove("hidden"); a.value = Store.exportText(state); a.select(); };
$("pauseBtn").onclick = () => { paused = !paused; $("pauseBtn").textContent = paused ? "繼續" : "暫停/繼續"; };

fillPairs();
renderAll(market.prices());
setInterval(loop, 1500);
