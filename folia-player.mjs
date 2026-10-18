// Featured song and Folia load on demand on separate origins.
export const FOLIA_URL = 'https://fxweb-folia.1090340.workers.dev/';
export function initFoliaPlayer() {
  if (document.getElementById('foliaDock')) return;
  const root = document.createElement('section');
  root.id = 'foliaDock'; root.className = 'folia-dock'; root.setAttribute('aria-label', '俱樂部音樂與 Folia');
  root.innerHTML = `<button class="folia-launch" type="button" aria-expanded="false" aria-controls="foliaPanel"><span aria-hidden="true">♫</span><span>音樂 <small>Folia</small></span></button>
    <section id="foliaPanel" class="folia-panel" hidden aria-label="俱樂部音樂面板">
      <header><div><small>CLUB SOUNDTRACK</small><strong>音樂休息室 <span>讓交易有自己的節奏。</span></strong></div><button class="folia-fold" type="button" aria-label="收合音樂面板">−</button></header>
      <div class="club-featured"><small>DEFAULT TRACK / 預設歌曲</small><h3>真英雄 <span>姜姜</span></h3><p>DJ 循環歌單版 · 完整公開影片，非 90 秒試聽</p><button class="featured-play" type="button">載入完整歌曲 ▶</button><a href="https://www.bilibili.com/video/BV1cwDbBGEN3/" target="_blank" rel="noopener noreferrer">B 站原影片 ↗</a><p class="featured-note">由 B 站官方播放器提供，點擊才載入。可收合畫面聽歌，但仍可能下載影片，並非純音訊省流量模式；平台可用性依地區與政策變動。</p><div class="featured-frame" hidden></div></div>
      <div class="folia-intro"><p>想整理自己的音樂或使用完整歌詞播放器？按需開啟 Folia。QQ 曲庫須自行登入；本地資料夾匯入請「獨立開啟」。</p><button class="folia-start" type="button">開啟完整 Folia ↗</button><small>完整播放器較耗記憶體；收合仍會保留，停止並關閉才會卸載。</small></div>
      <div class="folia-frame-wrap" hidden></div>
      <footer><span class="folia-status" role="status">Folia 尚未載入</span><a href="${FOLIA_URL}" target="_blank" rel="noopener noreferrer">獨立開啟 Folia ↗</a><button class="folia-stop" type="button">停止並關閉</button></footer>
    </section>`;
  document.body.append(root);
  const launch = root.querySelector('.folia-launch'), panel = root.querySelector('.folia-panel');
  const wrap = root.querySelector('.folia-frame-wrap'), intro = root.querySelector('.folia-intro');
  const status = root.querySelector('.folia-status');
  let frame = null, featured = null;
  const featuredWrap = root.querySelector('.featured-frame');
  const unloadFeatured = () => { featured?.remove(); featured = null; featuredWrap.hidden = true; root.querySelector('.featured-play').hidden = false; };
  root.querySelector('.featured-play').onclick = () => {
    featured = document.createElement('iframe');
    featured.title = '真英雄 — 姜姜，B站 DJ循環歌單完整影片';
    featured.src = 'https://player.bilibili.com/player.html?bvid=BV1cwDbBGEN3&p=1&autoplay=0';
    featured.allow = 'autoplay *; encrypted-media *; fullscreen *';
    featured.referrerPolicy = 'no-referrer';
    featuredWrap.replaceChildren(featured); featuredWrap.hidden = false;
    root.querySelector('.featured-play').hidden = true;
    status.textContent = 'B站播放器已載入 · 請按播放；無法使用時可開原影片';
  };
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
