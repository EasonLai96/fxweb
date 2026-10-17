import { equity } from './engine.mjs?v=20261017b';

// Standalone renderer: it never fetches data, synthesizes history, or encodes a QR code.
// context.equityPoints must be an array of actual account-equity samples (USD), in time order.
// For server callers, the raw game.account.eq is also accepted when supplied as account.eq.
const SITE = 'https://easonlai96.github.io/fxweb/';
const finite = n => typeof n === 'number' && Number.isFinite(n);
// ≥ 1 億改用億 / 兆 / 京簡寫，天文數字也不會超出卡片。
const absAmt = a => {
  if (a >= 1e20) return a.toExponential(2).replace('e+', 'e');
  for (const [n, u] of [[1e16, '京'], [1e12, '兆'], [1e8, '億']]) if (a >= n) return `${(a / n).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${u}`;
  return a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmt = n => finite(n) ? `${n < 0 ? '-' : ''}$${absAmt(Math.abs(n))}` : '—';
const signed = n => finite(n) ? `${n >= 0 ? '+' : '-'}$${absAmt(Math.abs(n))}` : '—';
const count = n => Number.isSafeInteger(n) && n >= 0 ? n.toLocaleString('en-US') : '—';
const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

export async function drawShareCard(context, options = {}) {
  const c = context || {}, o = options || {};
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1600;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas 2D unavailable');
  const ink = '#183b37', muted = '#607c76', green = '#19836d';
  function rounded(x, y, w, h, radius, color) {
    g.beginPath(); g.roundRect(x, y, w, h, radius); g.fillStyle = color; g.fill();
  }
  function text(value, x, y, size, color = ink, weight = 500, maxWidth = 880, align = 'left') {
    const s = String(value ?? '—');
    g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    let px = size;
    do { g.font = `${weight} ${px}px ${FONT}`; if (g.measureText(s).width <= maxWidth) break; px -= 1; } while (px > 16);
    // Canvas maxWidth is the final guard even for extremely large values / unbroken text.
    g.fillText(s, x, y, maxWidth);
    g.textAlign = 'left';
  }
  const bg = g.createLinearGradient(0, 0, 1080, 1600);
  bg.addColorStop(0, '#e4fbef'); bg.addColorStop(0.5, '#d4f3e7'); bg.addColorStop(1, '#f2f9ed');
  g.fillStyle = bg; g.fillRect(0, 0, 1080, 1600);
  g.fillStyle = '#ffffff55';
  g.beginPath(); g.arc(1030, 45, 300, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(-75, 790, 225, 0, Math.PI * 2); g.fill();

  // Identity/avatar: a user-supplied image or a neutral geometric monogram, never a third-party asset.
  g.save(); g.beginPath(); g.arc(133, 133, 65, 0, Math.PI * 2); g.clip();
  const avatar = o.avatar;
  if (typeof HTMLImageElement !== 'undefined' && avatar instanceof HTMLImageElement && avatar.complete && avatar.naturalWidth > 0) {
    const side = Math.min(avatar.naturalWidth, avatar.naturalHeight);
    g.drawImage(avatar, (avatar.naturalWidth - side) / 2, (avatar.naturalHeight - side) / 2, side, side, 68, 68, 130, 130);
  } else {
    const fill = g.createLinearGradient(68, 68, 198, 198);
    fill.addColorStop(0, '#80d8ba'); fill.addColorStop(1, '#379b87');
    g.fillStyle = fill; g.fillRect(68, 68, 130, 130);
    text('F', 109, 157, 72, '#ffffff', 700, 70);
  }
  g.restore();
  text('MINT / FX', 229, 122, 32, ink, 800, 730);
  text('虛構行情 · 槓桿交易練習', 229, 164, 25, muted, 500, 730);
  rounded(72, 243, 270, 55, 27, '#ffffffcb');
  const server = c.mode === 'server', battle = c.mode === 'battle';
  text(server ? '伺服器練習帳戶' : battle ? '經典戰役回放' : '訪客本機練習', 99, 281, 24, green, 700, 224);
  text(o.includeName && server && c.username ? `帳號：${String(c.username)}` : '帳號名稱不公開', 72, 348, 28, muted, 500, 936);
  text('帳戶總權益  /  USD', 72, 438, 31, muted, 700, 936);
  let total;
  try {
    if (c.account && finite(c.account.cash) && Array.isArray(c.account.positions) && c.account.positions.every(p => finite(c.prices?.[p.pair]) && c.prices[p.pair] > 0)) {
      total = equity(c.account, c.prices || {});
    }
  } catch { /* insufficient account/prices: leave the value unspecified */ }
  text(fmt(total), 72, 556, 95, ink, 800, 936);
  rounded(72, 595, 454, 142, 26, '#ffffffd9');
  rounded(544, 595, 464, 142, 26, '#ffffffd9');
  text('累積已實現淨損益', 100, 644, 24, muted, 600, 395);
  text(signed(server ? c.progress?.lifetimeStats?.netRealizedPnl : undefined), 100, 702, 45, ink, 750, 395);
  text('本回合權益損益', 572, 644, 24, muted, 600, 408);
  text(signed(finite(total) && finite(c.account?.startingCash) ? total - c.account.startingCash : undefined), 572, 702, 45, ink, 750, 408);
  text(server ? '累積：伺服器追蹤之已平倉淨損益，重置後保留' : battle ? '經典戰役獨立帳戶，不計伺服器成績' : '訪客無伺服器累積紀錄', 72, 781, 21, muted, 500, 936);

  const stats = server ? c.progress?.stats : null;
  const closes = !server && Array.isArray(c.account?.log) ? c.account.log.filter(x => x?.type === 'close' && finite(x.pnl)) : [];
  const closed = server ? stats?.closedTrades : closes.length;
  let wins = server ? stats?.wins : undefined;
  if (!server) {
    const entries = new Map((Array.isArray(c.account?.log) ? c.account.log : []).filter(x => x?.type === 'open' && finite(x.fee)).map(x => [x.id, x.fee]));
    if (closes.every(x => entries.has(x.id))) wins = closes.filter(x => x.pnl - entries.get(x.id) > 1e-9).length;
  }
  const rate = Number.isSafeInteger(closed) && closed > 0 && Number.isSafeInteger(wins) && !(stats?.missingEntryFeeCloses > 0)
    ? `${(wins / closed * 100).toFixed(1)}%` : '—';
  const unlocked = c.book && typeof c.book.count === 'function' ? c.book.count() : server && Array.isArray(c.progress?.achievements) ? c.progress.achievements.filter(a => a?.unlockedAt != null).length : undefined;
  rounded(72, 817, 936, 171, 28, '#ffffffef');
  const columns = [['近期勝率 · 本回合', rate], ['已解鎖成就', count(unlocked)], ['本回合平倉筆數', count(closed)]];
  for (let i = 0; i < 3; i++) {
    const x = 98 + i * 310;
    if (i) { g.fillStyle = '#e3eee9'; g.fillRect(x - 14, 847, 2, 110); }
    text(columns[i][0], x, 868, 21, muted, 600, 278);
    text(columns[i][1], x, 945, 48, ink, 800, 278);
  }
  rounded(72, 1014, 936, 363, 28, '#ffffffef');
  text('淨值樣本曲線', 102, 1074, 32, ink, 750, 840);
  text(server ? '伺服器每 10 根 K 線記錄一次 · 非歷史市場報價' : battle ? '每個交易日一點 · 歐洲央行歷史參考匯率回放' : '訪客本機淨值樣本 · 非歷史市場報價', 102, 1109, 21, muted, 500, 840);
  const history = Array.isArray(c.equityPoints) ? c.equityPoints : server && Array.isArray(c.account?.eq) ? c.account.eq : null;
  // Require at least two real finite samples. Never append present-day equity to fabricate a curve.
  if (!history || history.length < 2 || history.some(v => !finite(v))) {
    text('無記錄 · 尚無可用的淨值歷史樣本', 540, 1260, 30, muted, 600, 820, 'center');
  } else {
    const points = history.slice(-500), min = Math.min(...points), max = Math.max(...points);
    const low = min - Math.max((max - min) * .14, 1), high = max + Math.max((max - min) * .14, 1);
    for (let i = 0; i < 3; i++) {
      const y = 1150 + i * 85;
      g.strokeStyle = '#e7f0eb'; g.lineWidth = 2; g.beginPath(); g.moveTo(105, y); g.lineTo(975, y); g.stroke();
    }
    g.save(); g.beginPath(); g.rect(104, 1140, 873, 218); g.clip();
    g.beginPath(); points.forEach((value, i) => {
      const x = 107 + i / (points.length - 1) * 866;
      const y = 1345 - (value - low) / (high - low) * 196;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.strokeStyle = points.at(-1) >= points[0] ? '#299e7e' : '#cf735e';
    g.lineWidth = 5; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke(); g.restore();
  }

  // QR matrix is supplied by the caller (e.g. qrcode-generator result created for SITE).
  // The URL printed alongside it is the authoritative destination, not inferred from QR contents.
  text('練習場入口', 72, 1434, 27, ink, 750, 700);
  text(SITE, 72, 1475, 23, green, 600, 730);
  const qr = o.qr;
  if (qr && typeof qr.getModuleCount === 'function' && typeof qr.isDark === 'function') {
    const n = qr.getModuleCount();
    if (Number.isSafeInteger(n) && n >= 21 && n <= 177) {
      rounded(814, 1390, 194, 190, 14, '#ffffff');
      const module = 168 / (n + 8), extent = module * (n + 8);
      const left = 911 - extent / 2, top = 1485 - extent / 2;
      g.fillStyle = ink;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (qr.isDark(y, x)) g.fillRect(left + (x + 4) * module, top + (y + 4) * module, module + .03, module + .03);
      }
    }
  }
  const stamp = o.stamp instanceof Date && Number.isFinite(o.stamp.getTime()) ? o.stamp.toLocaleString('zh-TW', { hour12: false }) : '未提供';
  const freshness = c.catchingUp ? '伺服器補算中 · 未確認最新狀態' : String(o.freshness || '快照狀態未提供');
  text(`產生：${stamp}  ·  ${freshness}`, 72, 1522, 19, muted, 500, 700);
  text('虛構模擬行情，非真實歷史報價；僅供遊戲，不構成投資建議。', 72, 1567, 20, muted, 500, 936);
  return canvas;
}
