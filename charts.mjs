// 純 Canvas 繪圖，無外部函式庫。顏色從 CSS 變數讀，跟著紅漲綠跌切換。

function css(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function sma(candles, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= n) sum -= candles[i - n].c;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

export function drawCandles(canvas, candles, { digits = 4, lines = [], marks = [] } = {}) {
  const { ctx, w, h } = setup(canvas);
  if (!candles.length) return;
  const up = css("--up"), down = css("--down"), grid = css("--line"), mut = css("--mut");
  const axisW = 58, padT = 10, padB = 18;
  const plotW = w - axisW, plotH = h - padT - padB;

  let hi = -Infinity, lo = Infinity;
  for (const c of candles) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
  for (const l of lines) { if (l.price > hi) hi = l.price; if (l.price < lo) lo = l.price; }
  const pad = (hi - lo) * 0.08 || hi * 0.001;
  hi += pad; lo -= pad;
  const y = (p) => padT + (hi - p) / (hi - lo) * plotH;

  ctx.font = "10px system-ui";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * i / 4, yy = y(p);
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.fillStyle = mut; ctx.fillText(p.toFixed(digits), plotW + 4, yy);
  }

  const n = candles.length;
  const slot = plotW / n;
  const bw = Math.max(1, slot * 0.65);
  const xAt = (i) => i * slot + slot / 2;

  candles.forEach((c, i) => {
    const color = c.c >= c.o ? up : down;
    const x = xAt(i);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
    const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
    ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
  });

  const drawMA = (vals, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (v == null) return;
      if (!started) { ctx.moveTo(xAt(i), y(v)); started = true; } else ctx.lineTo(xAt(i), y(v));
    });
    ctx.stroke();
  };
  drawMA(sma(candles, 10), "#f5c542");
  drawMA(sma(candles, 30), "#7aa7ff");

  for (const m of marks) {
    const i = candles.findIndex(c => c.t === m.t);
    if (i < 0) continue;
    const x = xAt(i);
    ctx.fillStyle = m.reversed ? "#ff9f43" : "#c9d6e8";
    ctx.beginPath(); ctx.moveTo(x, padT + 2); ctx.lineTo(x - 5, padT - 6 + 14); ctx.lineTo(x + 5, padT - 6 + 14); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(201,214,232,0.25)"; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, padT + 10); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const l of lines) {
    const yy = y(l.price);
    ctx.strokeStyle = l.color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = l.color; ctx.fillText(l.label, 4, yy - 7);
  }

  const last = candles[n - 1];
  const ly = y(last.c);
  const lc = last.c >= last.o ? up : down;
  ctx.fillStyle = lc;
  ctx.fillRect(plotW, ly - 8, axisW, 16);
  ctx.fillStyle = "#fff";
  ctx.fillText(last.c.toFixed(digits), plotW + 4, ly);

  ctx.fillStyle = mut;
  ctx.fillText("MA10", 4, h - 8);
  ctx.fillStyle = "#f5c542"; ctx.fillRect(34, h - 10, 10, 3);
  ctx.fillStyle = mut;
  ctx.fillText("MA30", 52, h - 8);
  ctx.fillStyle = "#7aa7ff"; ctx.fillRect(82, h - 10, 10, 3);
}

export function drawSpark(canvas, values) {
  const { ctx, w, h } = setup(canvas);
  if (values.length < 2) return;
  const hi = Math.max(...values), lo = Math.min(...values);
  const rng = hi - lo || 1;
  const color = values[values.length - 1] >= values[0] ? css("--up") : css("--down");
  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
  values.forEach((v, i) => {
    const x = i / (values.length - 1) * w;
    const yy = h - 2 - (v - lo) / rng * (h - 4);
    i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
  });
  ctx.stroke();
}

export function drawEquity(canvas, points, start) {
  const { ctx, w, h } = setup(canvas);
  if (points.length < 2) {
    ctx.fillStyle = css("--mut"); ctx.font = "12px system-ui"; ctx.textAlign = "center";
    ctx.fillText("交易一段時間後會出現淨值曲線", w / 2, h / 2); ctx.textAlign = "start";
    return;
  }
  let hi = Math.max(start, ...points), lo = Math.min(start, ...points);
  const pad = (hi - lo) * 0.1 || 1; hi += pad; lo -= pad;
  const y = (v) => 6 + (hi - v) / (hi - lo) * (h - 12);
  const last = points[points.length - 1];
  const color = last >= start ? css("--up") : css("--down");

  ctx.strokeStyle = css("--mut"); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y(start)); ctx.lineTo(w, y(start)); ctx.stroke(); ctx.setLineDash([]);

  ctx.beginPath();
  points.forEach((v, i) => { const x = i / (points.length - 1) * w; i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v)); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
}
