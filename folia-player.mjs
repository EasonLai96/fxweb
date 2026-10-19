// Featured song and Folia load on demand on separate origins.
export const FOLIA_URL = 'https://fxweb-folia.1090340.workers.dev/';
export function initFoliaPlayer() {
  if (document.getElementById('foliaDock')) return;
  const root = document.createElement('section');
  root.id = 'foliaDock'; root.className = 'folia-dock'; root.setAttribute('aria-label', '俱樂部音樂與 Folia');
  root.innerHTML = `<button class="folia-launch" type="button" aria-expanded="false" aria-controls="foliaPanel"><span aria-hidden="true">♫</span><span>音樂 <small>Folia</small></span></button>
    <section id="foliaPanel" class="folia-panel" hidden aria-label="俱樂部音樂面板">
      <header><div><small>CLUB SOUNDTRACK</small><strong>音樂休息室 <span>讓交易有自己的節奏。</span></strong></div><button class="folia-fold" type="button" aria-label="收合音樂面板">−</button></header>
      <div class="club-featured"><small>DEFAULT TRACK / 預設歌曲</small><h3>真英雄 <span>曹浩然／姜姜</span></h3><p>熱血版 · 完整純音訊 3:04 · 免登入</p><button class="featured-play" type="button">播放完整歌曲 ▶</button><a href="https://music.163.com/song?id=3328209995" target="_blank" rel="noopener noreferrer">網易雲歌曲來源 ↗</a><p class="featured-note">不是姜姜獨唱版。由網易雲公開音源直接播放，沒有影片、不經本站伺服器。點播放才連線；音源供應可能隨地區及平台政策改變。</p><audio class="featured-audio" controls preload="none" aria-label="真英雄（熱血版）曹浩然／姜姜"></audio><label class="featured-loop"><input type="checkbox" checked> 單曲循環</label></div>
      <div class="folia-intro"><p>想整理自己的音樂或使用完整歌詞播放器？按需開啟 Folia。QQ 曲庫須自行登入；本地資料夾匯入請「獨立開啟」。</p><button class="folia-start" type="button">開啟完整 Folia ↗</button><small>完整播放器較耗記憶體；收合仍會保留，停止並關閉才會卸載。</small></div>
      <div class="folia-frame-wrap" hidden></div>
      <footer><span class="folia-status" role="status">Folia 尚未載入</span><a href="${FOLIA_URL}" target="_blank" rel="noopener noreferrer">獨立開啟 Folia ↗</a><button class="folia-stop" type="button">停止並關閉</button></footer>
    </section>`;
  document.body.append(root);
  const launch = root.querySelector('.folia-launch'), panel = root.querySelector('.folia-panel');
  const wrap = root.querySelector('.folia-frame-wrap'), intro = root.querySelector('.folia-intro');
  const status = root.querySelector('.folia-status');
  let frame = null, generation = 0;
  const featured = root.querySelector('.featured-audio');
  const playButton = root.querySelector('.featured-play');
  featured.loop = true;
  featured.volume = 0.35;
  root.querySelector('.featured-loop input').onchange = e => { featured.loop = e.target.checked; };
  const unloadFeatured = () => {
    generation++; featured.pause(); featured.removeAttribute('src'); featured.load();
    playButton.hidden = false; root.classList.remove('is-playing');
  };
  playButton.onclick = async () => {
    const epoch = ++generation;
    // Stable official external endpoint resolves the current CDN URL; never persist expiring URLs.
    featured.src = 'https://music.163.com/song/media/outer/url?id=3328209995.mp3';
    playButton.hidden = true; status.textContent = '歌曲載入中…';
    try { await featured.play(); if (epoch === generation) status.textContent = '播放中 · 純音訊 · 收合不停止'; }
    catch { if (epoch === generation) { unloadFeatured(); status.textContent = '音源暫不可用，請重試或開啟歌曲來源。'; } }
  };
  featured.addEventListener('playing', () => { status.textContent = '播放中 · 純音訊 · 收合不停止'; root.classList.add('is-playing'); });
  featured.addEventListener('pause', () => { root.classList.remove('is-playing'); });
  featured.addEventListener('error', () => {
    if (!featured.hasAttribute('src')) return;
    unloadFeatured(); status.textContent = '音源無法連線，請手動重試；本站不代理或繞過限制。';
  });
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
    unloadFeatured();
    frame = document.createElement('iframe'); frame.title = 'Folia 獨立音樂播放器'; frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    frame.allow = 'autoplay; fullscreen'; frame.src = FOLIA_URL;
    frame.onload = () => { status.textContent = 'Folia 已開啟 · 收合不卸載'; };
    wrap.append(frame); wrap.hidden = false; intro.hidden = true;
    root.querySelector('.club-featured').hidden = true;
    status.textContent = '載入中；無法顯示時請獨立開啟'; root.classList.add('is-loaded');
  };
  root.querySelector('.folia-stop').onclick = () => {
    unloadFeatured(); root.querySelector('.club-featured').hidden = false;
    if (frame) { frame.onload = null; frame.remove(); frame = null; }
    wrap.hidden = true; intro.hidden = false;
    status.textContent = '已停止並卸載'; root.classList.remove('is-loaded'); toggle(false);
  };
  // No autoplay, no polling, no reconnect timers, no player state or tokens sent to game APIs.
}
initFoliaPlayer();
