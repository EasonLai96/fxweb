// 純 Canvas 繪圖，無外部函式庫。主圖配色沿用原版的深青圖表底色。

export const CHART_THEMES = {
  day:   { bg: "#24383c", grid: "#3c5254", vgrid: "#32494b", axis: "#91a9a8", date: "#7f9999", up: "#8fddb1", down: "#f19aa8", dash: "#d5e1b3" },
  night: { bg: "#0e2023", grid: "#24413c", vgrid: "#1c3436", axis: "#7e9a94", date: "#5f7d78", up: "#8fddb1", down: "#f19aa8", dash: "#c9d8a8" },
};
const MA10 = "#f3d27a", MA30 = "#8ec5ff", ENTRY = "#8ec5ff", LIQ = "#f2a76b";

function setup(canvas) {
  const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: canvas.clientWidth, height: canvas.clientHeight };
  const w = rect.width || canvas.clientWidth, h = rect.height || canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function sma(candles, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= n) sum -= candles[i - n].c;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function drawCandles(canvas, all, { theme = "day", digits = 4, lines = [], marks = [], showMA = true } = {}) {
  const s = setup(canvas); if (!s) return;
  const { ctx, w, h } = s;
  const T = CHART_THEMES[theme] || CHART_THEMES.day;
  ctx.fillStyle = T.bg; ctx.fillRect(0, 0, w, h);
  const left = 16, right = w - 62, top = 23, bottom = h - 28;
  const visible = Math.max(30, Math.min(80, Math.floor((right - left) / 8)));
  const start = Math.max(0, all.length - visible);
  const candles = all.slice(start);
  if (candles.length < 2) return;
  const ma10 = sma(all, 10).slice(start), ma30 = sma(all, 30).slice(start);

  const vals = candles.flatMap(c => [c.h, c.l]);
  if (showMA) for (const v of [...ma10, ...ma30]) if (v != null) vals.push(v);
  let min = Math.min(...vals), max = Math.max(...vals);
  const pad = Math.max((max - min) * 0.18, min * 0.0006); min -= pad; max += pad;
  const inRange = lines.filter(l => l.price >= min && l.price <= max);
  const yOf = v => top + (max - v) / (max - min) * (bottom - top);

  ctx.lineWidth = 1; ctx.font = "10px 'DM Mono', monospace"; ctx.textAlign = "left";
  for (let i = 0; i < 5; i++) {
    const y = top + i * (bottom - top) / 4;
    ctx.strokeStyle = T.grid; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = T.axis; ctx.fillText((max - i * (max - min) / 4).toFixed(digits), right + 7, y + 3);
  }
  ctx.strokeStyle = T.vgrid;
  for (let i = 0; i < 6; i++) {
    const x = left + i * (right - left) / 5;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  }

  const step = (right - left) / candles.length;
  const xAt = i => left + step * (i + 0.5);

  for (const m of marks) {
    const i = candles.findIndex(c => c.t === m.t);
    if (i < 0) continue;
    const x = xAt(i);
    if (m.event) {   // 重大事件：整條紅/綠色帶 + 閃電圖示
      const col = m.up ? T.up : T.down;
      ctx.fillStyle = col; ctx.globalAlpha = 0.14; ctx.fillRect(x - step / 2, top, step, bottom - top); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, top + 7, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = T.bg; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("⚡", x, top + 10.5); ctx.textAlign = "left"; ctx.font = "10px 'DM Mono', monospace";
      continue;
    }
    ctx.strokeStyle = m.reversed ? "rgba(242,167,107,.45)" : "rgba(213,225,179,.28)";
    ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, top + 12); ctx.lineTo(x, bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = m.reversed ? LIQ : T.dash;
    ctx.beginPath(); ctx.arc(x, top + 6, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = T.bg; ctx.font = "bold 7px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("N", x, top + 8.5); ctx.textAlign = "left"; ctx.font = "10px 'DM Mono', monospace";
  }

  candles.forEach((c, i) => {
    const x = xAt(i), rising = c.c >= c.o;
    ctx.strokeStyle = rising ? T.up : T.down; ctx.fillStyle = rising ? T.up : T.down;
    ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l)); ctx.stroke();
    const yt = yOf(Math.max(c.o, c.c)), yb = yOf(Math.min(c.o, c.c));
    const bw = Math.max(3, step * 0.6);
    ctx.fillRect(x - bw / 2, yt, bw, Math.max(2, yb - yt));
    const move = c.c / c.o - 1;
    if (Math.abs(move) >= 0.004) {
      const y = move > 0 ? Math.min(bottom - 3, yOf(c.l) + 9) : Math.max(top + 3, yOf(c.h) - 9);
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  });

  if (showMA) {
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    const drawMA = (arr, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath(); let on = false;
      arr.forEach((v, i) => { if (v == null) return; const x = xAt(i), y = yOf(v); on ? ctx.lineTo(x, y) : ctx.moveTo(x, y); on = true; });
      ctx.stroke();
    };
    drawMA(ma10, MA10); drawMA(ma30, MA30);
    ctx.restore();
  }

  for (const l of inRange) {
    const y = yOf(l.price), color = l.kind === "liq" ? LIQ : ENTRY;
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = "bold 10px sans-serif"; const tw = ctx.measureText(l.label).width;
    ctx.fillStyle = color; ctx.fillRect(left + 2, y - 15, tw + 10, 14);
    ctx.fillStyle = T.bg; ctx.fillText(l.label, left + 7, y - 4.5);
    ctx.font = "10px 'DM Mono', monospace";
  }
  const offscreen = lines.length - inRange.length;
  if (offscreen > 0) { ctx.fillStyle = T.date; ctx.fillText(`另有 ${offscreen} 條持倉線在畫面外`, left + 4, top - 8); }

  ctx.fillStyle = T.date;
  ctx.fillText("← 過去", left, h - 9); ctx.textAlign = "right"; ctx.fillText("現在 →", right, h - 9); ctx.textAlign = "left";

  const last = candles[candles.length - 1], y = yOf(last.c);
  ctx.setLineDash([4, 5]); ctx.strokeStyle = T.dash; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = last.c >= last.o ? T.up : T.down;
  ctx.fillRect(right + 2, y - 8, w - right - 4, 16);
  ctx.fillStyle = T.bg; ctx.font = "bold 10px 'DM Mono', monospace";
  ctx.fillText(last.c.toFixed(digits), right + 6, y + 3.5);
}

export function drawSpark(canvas, values, color) {
  const s = setup(canvas); if (!s || values.length < 2) return;
  const { ctx, w, h } = s;
  const hi = Math.max(...values), lo = Math.min(...values), r = hi - lo || 1;
  const pts = values.map((v, i) => [i / (values.length - 1) * w, h - 3 - (v - lo) / r * (h - 6)]);
  ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color + "40"); g.addColorStop(1, color + "00");
  ctx.fillStyle = g; ctx.fill();
}

export function drawEquity(canvas, points, startValue, { up, down, muted, text }) {
  const s = setup(canvas); if (!s) return;
  const { ctx, w, h } = s;
  if (points.length < 2) {
    ctx.fillStyle = muted; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("交易一段時間後會出現淨值曲線", w / 2, h / 2 + 4); ctx.textAlign = "left"; return;
  }
  const padL = 10, padR = 58, padT = 16, padB = 16;
  let hi = Math.max(startValue, ...points), lo = Math.min(startValue, ...points);
  const pad = Math.max((hi - lo) * 0.15, startValue * 0.002); hi += pad; lo -= pad;
  const yOf = v => padT + (hi - v) / (hi - lo) * (h - padT - padB);
  const xOf = i => padL + i / (points.length - 1) * (w - padL - padR);
  const last = points[points.length - 1], color = last >= startValue ? up : down;

  ctx.strokeStyle = muted; ctx.globalAlpha = 0.6; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, yOf(startValue)); ctx.lineTo(w - padR, yOf(startValue)); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  // 起始標籤放左側，避免和右側目前淨值標籤重疊
  const sy = yOf(startValue), ly0 = yOf(points[points.length - 1]);
  const above = ly0 > sy - 4;   // 目前淨值在起始線下方或接近時，起始標籤放線上方
  ctx.fillStyle = muted; ctx.font = "10px 'DM Mono', monospace";
  ctx.fillText("起始 " + Math.round(startValue).toLocaleString("en-US"), padL + 2, above ? sy - 5 : sy + 13);

  ctx.beginPath(); points.forEach((v, i) => i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
  ctx.lineTo(xOf(points.length - 1), h); ctx.lineTo(padL, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, color + "38"); g.addColorStop(1, color + "00");
  ctx.fillStyle = g; ctx.fill();

  const lx = xOf(points.length - 1), ly = yOf(last);
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = text; ctx.font = "bold 11px 'DM Mono', monospace";
  ctx.fillText(shortNum(last), lx + 8, ly + 4);
}

// 圖上標籤只有 ~50px 寬：超過 6 位數就用 萬 / 億 / 兆 / 京 簡寫。
function shortNum(v) {
  const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (!Number.isFinite(a)) return "∞";
  if (a >= 1e20) return s + a.toExponential(1).replace("e+", "e");
  for (const [n, u] of [[1e16, "京"], [1e12, "兆"], [1e8, "億"], [1e6, "萬"]]) if (a >= n) {
    const q = a / (u === "萬" ? 1e4 : n);
    return s + (q >= 100 ? Math.round(q).toLocaleString("en-US") : q.toFixed(1)) + u;
  }
  return s + Math.round(a).toLocaleString("en-US");
}
