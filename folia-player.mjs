// Browser streams radio directly; Folia is an optional, isolated, on-demand app.
export const FOLIA_URL = 'https://fxweb-folia.1090340.workers.dev/';
export const STATIONS = [
  { id: 'groovesalad', name: 'Groove Salad · 氛圍節拍', url: 'https://ice2.somafm.com/groovesalad-128-mp3' },
  { id: 'dronezone', name: 'Drone Zone · 專注環境音', url: 'https://ice2.somafm.com/dronezone-128-mp3' },
];
export function initFoliaPlayer() {
  if (document.getElementById('foliaDock')) return;
  const root = document.createElement('section');
  root.id = 'foliaDock'; root.className = 'folia-dock'; root.setAttribute('aria-label', '俱樂部音樂與 Folia');
  root.innerHTML = `<button class="folia-launch" type="button" aria-expanded="false" aria-controls="foliaPanel"><span aria-hidden="true">♫</span><span>音樂 <small>Folia</small></span></button>
    <section id="foliaPanel" class="folia-panel" hidden aria-label="俱樂部音樂面板">
      <header><div><small>CLUB SOUNDTRACK</small><strong>音樂休息室 <span>讓交易有自己的節奏。</span></strong></div><button class="folia-fold" type="button" aria-label="收合音樂面板">−</button></header>
      <div class="club-radio"><label for="clubStation">免登入電台</label><select id="clubStation">${STATIONS.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
        <div class="radio-controls"><button class="radio-play" type="button">播放電台</button><label>音量 <input class="radio-volume" type="range" min="0" max="1" step="0.05" value="0.35" aria-label="電台音量"></label></div>
        <p class="radio-status" role="status" aria-live="polite">按播放才連線，不需登入。</p><small>音源由 <a href="https://somafm.com/" target="_blank" rel="noopener noreferrer">SomaFM</a> 提供，瀏覽器直接串流，本站不轉送音訊。128 kbps 約 58 MB／小時；行動網路請留意流量。第三方電台可能因地區或網路暫停供應。</small>
      </div>
      <div class="folia-intro"><p>想整理自己的音樂或使用完整歌詞播放器？按需開啟 Folia。QQ 曲庫須自行登入；本地資料夾匯入請「獨立開啟」。</p><button class="folia-start" type="button">開啟完整 Folia ↗</button><small>完整播放器較耗記憶體；收合仍會保留，停止並關閉才會卸載。</small></div>
      <div class="folia-frame-wrap" hidden></div>
      <footer><span class="folia-status" role="status">Folia 尚未載入</span><a href="${FOLIA_URL}" target="_blank" rel="noopener noreferrer">獨立開啟 Folia ↗</a><button class="folia-stop" type="button">停止並關閉</button></footer>
    </section>`;
  document.body.append(root);
  const launch = root.querySelector('.folia-launch'), panel = root.querySelector('.folia-panel');
  const wrap = root.querySelector('.folia-frame-wrap'), intro = root.querySelector('.folia-intro');
  const status = root.querySelector('.folia-status');
  const audio = document.createElement('audio'); audio.preload = 'none'; audio.volume = 0.35;
  audio.hidden = true; root.append(audio);
  const select = root.querySelector('#clubStation'), volume = root.querySelector('.radio-volume');
  const play = root.querySelector('.radio-play'), radioStatus = root.querySelector('.radio-status');
  try {
    const saved = JSON.parse(localStorage.getItem('fxweb.music.v1') || 'null');
    if (saved && typeof saved.volume === 'number' && Number.isFinite(saved.volume)) audio.volume = Math.max(0, Math.min(1, saved.volume));
    if (STATIONS.some(s => s.id === saved?.station)) select.value = saved.station;
  } catch { /* preference storage is optional */ }
  volume.value = audio.volume;
  const persist = () => { try { localStorage.setItem('fxweb.music.v1', JSON.stringify({ volume: audio.volume, station: select.value })); } catch {} };
  let frame = null, generation = 0;
  const stopRadio = () => {
    generation++; audio.pause(); audio.removeAttribute('src'); audio.load();
    play.textContent = '播放電台'; root.classList.remove('is-playing');
  };
  const startRadio = async () => {
    stopRadio();
    const epoch = generation;
    audio.src = STATIONS.find(s => s.id === select.value).url;
    play.textContent = '停止電台'; radioStatus.textContent = '連線中…';
    try { await audio.play(); if (epoch !== generation) return; radioStatus.textContent = '播放中 · 收合不會中斷'; root.classList.add('is-playing'); }
    catch { if (epoch !== generation) return; stopRadio(); radioStatus.textContent = '無法播放，請切換電台或稍後手動重試。'; }
  };
  play.onclick = () => { if (audio.hasAttribute('src')) { stopRadio(); radioStatus.textContent = '已停止串流'; } else startRadio(); };
  audio.addEventListener('error', () => { if (!audio.hasAttribute('src')) return; stopRadio(); radioStatus.textContent = '電台連線中斷，請手動重試；不會自動連續重連。'; });
  audio.addEventListener('waiting', () => { if (audio.hasAttribute('src')) radioStatus.textContent = '音訊緩衝中…'; });
  audio.addEventListener('playing', () => { radioStatus.textContent = '播放中 · 收合不會中斷'; });
  volume.oninput = () => { audio.volume = Number(volume.value); persist(); };
  select.onchange = () => { const active = audio.hasAttribute('src'); stopRadio(); persist(); radioStatus.textContent = '已選擇電台，按播放才連線。'; if (active) startRadio(); };
  const toggle = expanded => {
    panel.hidden = !expanded; launch.setAttribute('aria-expanded', String(expanded));
    root.classList.toggle('is-open', expanded);
    if (!expanded) launch.focus({ preventScroll: true });
  };
  launch.onclick = () => toggle(panel.hidden);
  root.querySelector('.folia-fold').onclick = () => toggle(false);
  root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); toggle(false); } });
  root.querySelector('.folia-start').onclick = () => {
    if (frame) return;
    stopRadio(); radioStatus.textContent = '電台已停止，避免與 Folia 同時播放。';
    frame = document.createElement('iframe'); frame.title = 'Folia 獨立音樂播放器'; frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    frame.allow = 'autoplay; fullscreen'; frame.src = FOLIA_URL;
    frame.onload = () => { status.textContent = 'Folia 已開啟 · 收合不卸載'; };
    wrap.append(frame); wrap.hidden = false; intro.hidden = true;
    root.querySelector('.club-radio').hidden = true;
    status.textContent = '載入中；無法顯示時請獨立開啟'; root.classList.add('is-loaded');
  };
  root.querySelector('.folia-stop').onclick = () => {
    stopRadio(); radioStatus.textContent = '已停止串流';
    if (frame) { frame.onload = null; frame.remove(); frame = null; }
    wrap.hidden = true; intro.hidden = false; root.querySelector('.club-radio').hidden = false;
    status.textContent = '已停止並卸載'; root.classList.remove('is-loaded'); toggle(false);
  };
  // No autoplay, no polling, no reconnect timers, no player state or tokens sent to game APIs.
}
initFoliaPlayer();
