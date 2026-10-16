import { feeFor, LEVERAGES } from './engine.mjs?v=20261016c';
import { getAvatar, saveAvatar, removeAvatar, avatarImage, DEFAULT_AVATAR_URL } from './avatar.mjs?v=20261016c';

function defaultAvatarImg() {
  const img = document.createElement('img'); img.alt = '預設分享頭像'; img.src = DEFAULT_AVATAR_URL; return img;
}
import { drawShareCard } from './share-card.mjs?v=20261016c';
import makeQR from './qr-code.mjs?v=20261016c';

const qr = makeQR(0, 'M');
qr.addData('https://easonlai96.github.io/fxweb/');
qr.make();

const WELCOME_KEY = 'fxweb.extras.welcome.v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const money = value => finite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : '—';
const number = value => finite(value) ? value.toLocaleString('zh-TW') : '—';
const date = value => {
  const d = new Date(value);
  return value != null && Number.isFinite(d.getTime()) ? d.toLocaleString('zh-TW', { hour12: false }) : '未提供';
};
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function button(text, action, primary = false) {
  const b = el('button', `fx-extra-button${primary ? ' fx-extra-primary' : ''}`, text);
  b.type = 'button'; b.addEventListener('click', action); return b;
}
function note(text) { return el('p', 'fx-extra-note', text); }

// Server stats are authoritative; absent fields are deliberately not inferred from cash.
function statsFor(context) {
  if (context.mode === 'server') {
    const s = context.progress?.stats || {};
    return { closed: s.closedTrades, wins: s.wins, net: s.netRealizedPnl, fees: s.feesPaid, resets: context.resets ?? context.progress?.resets };
  }
  const log = Array.isArray(context.account?.log) ? context.account.log : [];
  const closes = log.filter(x => x.type === 'close' && finite(x.pnl));
  const fees = log.reduce((total, x) => total + (finite(x.fee) ? x.fee : 0), 0);
  const entryFees = new Map(log.filter(x => x.type === 'open' && finite(x.fee)).map(x => [x.id, x.fee]));
  const closedIds = new Set(closes.map(x => x.id));
  const closedFees = log.reduce((total, x) => total + (x.type === 'open' && closedIds.has(x.id) && finite(x.fee) ? x.fee : 0), 0);
  return { closed: closes.length, wins: closes.filter(x => entryFees.has(x.id) && x.pnl - entryFees.get(x.id) > 1e-9).length,
    net: closes.reduce((total, x) => total + x.pnl, 0) - closedFees, fees, resets: context.resets };
}
function statRows(context) {
  const s = statsFor(context);
  return [['平倉數', number(s.closed)], ['勝率', finite(s.closed) && s.closed > 0 && finite(s.wins) ? `${(s.wins / s.closed * 100).toFixed(1)}%` : '—'],
    ['淨已實現損益', money(s.net)], ['費用', money(s.fees)], ['重置次數', number(s.resets)]];
}

export function initExtras({ getContext, refresh, onToast = () => {} }) {
  if (typeof getContext !== 'function') throw new TypeError('initExtras 需要 getContext');
  if (document.getElementById('fx-extras')) return { update() {} };
  if (!document.querySelector('link[data-fx-extras]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet';
    link.href = new URL('./extras.css', import.meta.url).href; link.dataset.fxExtras = '1'; document.head.append(link);
  }
  const root = el('section', 'fx-extras'); root.id = 'fx-extras'; root.setAttribute('aria-label', '練習工具');
  const toolbar = el('nav', 'fx-extra-toolbar'); toolbar.setAttribute('aria-label', '練習工具'); root.append(toolbar);
  const main = document.querySelector('main');
  if (main) main.before(root); else (document.querySelector('.topbar') || document.body.lastElementChild)?.after(root);
  const dialog = el('dialog', 'fx-extra-dialog'); dialog.setAttribute('aria-labelledby', 'fx-extra-title');
  const header = el('div', 'fx-extra-heading');
  const title = el('h2', '', ''); title.id = 'fx-extra-title'; title.tabIndex = -1;
  const closeButton = button('關閉', () => close()); closeButton.setAttribute('aria-label', '關閉對話框');
  header.append(title, closeButton);
  const body = el('div', 'fx-extra-body'); dialog.append(header, body); document.body.append(dialog);
  let active = '', opener = null, generation = 0, shareURL = '', shareIdentity = '', shareFile = null;
  let tutorialStep = 0, leverage = 5, quizAnswer = null, statsSignature = '';
  const context = () => getContext() || {};
  const identity = c => `${c.mode}|${c.username || ''}`;
  function otherOverlay() {
    return [...document.querySelectorAll('[role="dialog"],dialog')].some(n => n !== dialog && !dialog.contains(n) &&
      !n.closest('[hidden],.hidden') && (n.tagName !== 'DIALOG' || n.open) && n.getClientRects().length > 0);
  }
  function releaseImage() {
    if (shareURL) URL.revokeObjectURL(shareURL);
    shareURL = ''; shareFile = null;
  }
  function close(restore = true) {
    if (!dialog.open) return;
    generation++; active = ''; dialog.close(); releaseImage();
    if (restore && !otherOverlay()) (opener?.isConnected ? opener : toolbar.lastElementChild)?.focus({ preventScroll: true });
  }
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('click', e => { if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
  } });
  dialog.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const list = [...dialog.querySelectorAll('button,a[href],input,select,textarea,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === title)) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  });
  function open(kind) {
    if (otherOverlay()) { onToast('請先完成或關閉目前的視窗。'); return; }
    opener = document.activeElement; active = kind; generation++; releaseImage(); body.replaceChildren();
    title.textContent = { achievements: '成就冊', stats: '練習統計', share: '分享練習快照', tutorial: '六步認識交易' }[kind];
    if (!dialog.open) dialog.showModal();
    if (kind === 'achievements') renderAchievements();
    if (kind === 'stats') renderStats();
    if (kind === 'share') renderShare();
    if (kind === 'tutorial') { tutorialStep = 0; renderTutorial(); }
    title.focus({ preventScroll: true });
  }
  [['成就', 'achievements'], ['統計', 'stats'], ['分享', 'share'], ['新手', 'tutorial']].forEach(([label, kind]) => toolbar.append(button(label, () => open(kind))));
  let welcomed = false;
  try { welcomed = localStorage.getItem(WELCOME_KEY) === '1'; } catch { /* storage may be disabled */ }
  const welcome = el('div', 'fx-extra-welcome');
  function dismissWelcome() { try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* optional persistence */ } welcome.remove(); }
  if (!welcomed) {
    const copy = el('div'); copy.append(el('strong', '', '第一次來？先用 2 分鐘認識風險。'), note('純教學，不會操作你的帳戶；也可以隨時從「新手」重新開始。'));
    const actions = el('div', 'fx-extra-actions'); actions.append(button('開始導覽', () => { open('tutorial'); dismissWelcome(); }, true), button('略過', dismissWelcome));
    welcome.append(copy, actions); root.append(welcome);
  }
  function renderStats() {
    const c = context(); body.replaceChildren();
    body.append(note(c.mode === 'server' ? '伺服器本回合紀錄（重置後重新計算）。未提供的欄位以「—」顯示。' : c.mode === 'battle' ? '經典戰役獨立帳戶的紀錄，不計成績；僅依目前保留的交易紀錄統計。' : '訪客本機練習，不計成績；僅依目前保留的交易紀錄統計，並非完整歷史。'));
    const grid = el('dl', 'fx-extra-stats');
    for (const [label, value] of statRows(c)) { const item = el('div'); item.append(el('dt', '', label), el('dd', '', value)); grid.append(item); }
    body.append(grid, note('淨已實現損益扣除已平倉交易對應的開倉費，不包含持倉浮動損益；費用欄包含本回合所有開倉費（含未平倉），不再重複扣除。勝率以扣除對應開倉費後的獲利平倉筆數／全部平倉數計，無平倉時不計勝率。缺少開倉費資料的平倉不計勝負，但仍列入平倉總數。'));
    if (c.mode === 'server') body.append(note(`開始追蹤：${date(c.progress?.trackingSince)}。追蹤前的歷史不一定包含在內。`));
    if (c.mode === 'server' && c.progress?.stats?.missingEntryFeeCloses > 0) body.append(note(`有 ${number(c.progress.stats.missingEntryFeeCloses)} 筆平倉缺少開倉費，勝率並非完整可比較紀錄。`));
    if (c.mode === 'server' && c.progress?.trackingNote) body.append(note(c.progress.trackingNote));
    if (navigator.onLine === false || c.catchingUp) body.append(note('目前離線或伺服器補算中，以上為已取得的紀錄，並非最新確認值。'));
  }
  function renderBook(book) {
    const n = book.count(), summary = el('div', 'ach-summary');
    const bar = el('div', 'ach-bar'), fill = el('i'); fill.style.width = `${n / book.total * 100}%`; bar.append(fill);
    summary.append(el('strong', '', `已解鎖 ${n} / ${book.total}`), bar);
    const grid = el('div', 'ach-grid'), got = book.unlocked();
    for (const def of book.list) {
      const ts = got[def.id], card = el('div', `ach-card ${ts ? 'unlocked' : 'locked'}`);
      card.append(el('span', 'ach-medal', ts ? '🏅' : '❔'), el('span', 'ach-name', ts ? def.name : '？？？'), el('span', 'ach-desc', ts ? def.desc : def.hint));
      if (ts) card.append(el('span', 'ach-date', ts.slice(0, 10)));
      else if (def.follow) {
        const b = el('button', 'ach-follow-btn', '去脆關注'); b.type = 'button';
        b.addEventListener('click', () => { window.open(book.followUrl, '_blank', 'noopener'); book.unlock(def.id); renderAchievements(); });
        card.append(b);
      }
      grid.append(card);
    }
    body.append(summary, grid, note('成就冊記錄在這台裝置（訪客、各登入帳號分開保存），訪客、登入與經典戰役都能解鎖。'));
  }
  function renderAchievements() {
    const c = context(); body.replaceChildren();
    if (c.book) renderBook(c.book);
    if (c.mode !== 'server') {
      body.append(el('h3', '', '練習里程碑'), note('里程碑由伺服器記錄，登入後才會累積；訪客與經典戰役不計。')); return;
    }
    const achievements = c.progress?.achievements;
    body.append(el('h3', '', '練習里程碑'), note('由伺服器記錄，僅供遊戲練習；不是交易能力或收益的保證。'));
    if (!Array.isArray(achievements) || !achievements.length) { body.append(el('div', 'fx-extra-callout', '尚無里程碑資料，請稍後再查看。')); return; }
    const list = el('ul', 'fx-extra-achievements');
    for (const a of achievements) {
      const item = el('li', a.unlockedAt ? 'fx-extra-unlocked' : '');
      item.append(el('span', 'fx-extra-tag', a.unlockedAt ? '已解鎖' : '進行中'), el('h3', '', a.title || '未命名成就'), note(a.description || ''));
      if (finite(a.target) && a.target > 0 && finite(a.progress)) {
        const meter = el('progress'); meter.max = a.target; meter.value = Math.max(0, Math.min(a.target, a.progress)); meter.setAttribute('aria-label', `${a.title || '成就'}進度`);
        item.append(meter, note(`${number(a.progress)} / ${number(a.target)}`));
      }
      if (a.unlockedAt) item.append(note(`解鎖時間：${date(a.unlockedAt)}`));
      list.append(item);
    }
    body.append(list);
  }
  function renderShare() {
    const c = context(); shareIdentity = identity(c);
    body.replaceChildren(note('先更新帳戶，再產生不含登入憑證的資料卡。圖片只是快照，不是驗證憑證。'));
    const label = el('label', 'fx-extra-check'); const check = el('input'); check.type = 'checkbox'; check.checked = false; check.disabled = c.mode !== 'server';
    label.append(check, document.createTextNode('公開帳號名稱（預設不公開）')); body.append(label);
    const avatarRow = el('div', 'fx-avatar-row');
    const avatarPreview = el('div', 'fx-avatar-preview');
    const avatarDescription = el('div');
    avatarDescription.append(el('strong', '', '自訂分享頭像'), note('只存在這台裝置。選圖後會裁成正方形並移除原檔附帶資訊；不會傳到伺服器。'));
    const avatarActions = el('div', 'fx-extra-actions');
    const upload = button('選擇圖片', () => avatarInput.click());
    const remove = button('移除頭像', () => {
      const live = context();
      if (!removeAvatar(live.mode, live.username)) { onToast('無法存取本機頭像。', true); return; }
      generation++; releaseImage(); preview.replaceChildren(); output.replaceChildren();
      avatarPreview.replaceChildren(defaultAvatarImg());
      status.textContent = '已改回預設頭像，請重新產生圖片。';
      onToast('已移除本機頭像。');
    });
    const avatarInput = el('input', 'fx-avatar-input');
    avatarInput.type = 'file'; avatarInput.accept = 'image/jpeg,image/png,image/webp';
    avatarInput.setAttribute('aria-label', '選擇分享卡頭像圖片');
    avatarInput.addEventListener('change', async () => {
      const file = avatarInput.files?.[0];
      avatarInput.value = '';
      if (!file) return;
      const before = identity(context());
      try {
        const data = await saveAvatar(file, context().mode, context().username);
        if (active !== 'share' || before !== identity(context())) return;
        const img = el('img'); img.alt = '目前的分享頭像'; img.src = data;
        avatarPreview.replaceChildren(img);
        generation++; releaseImage(); preview.replaceChildren(); output.replaceChildren();
        status.textContent = '頭像已保存在這台裝置；請重新產生圖片。';
        onToast('頭像已更新，只保存在這台裝置。');
      } catch (e) { onToast(e.message, true); }
    });
    avatarActions.append(upload, remove);
    avatarDescription.append(avatarActions, avatarInput);
    avatarRow.append(avatarPreview, avatarDescription); body.append(avatarRow);
    const prior = getAvatar(c.mode, c.username);
    if (prior) { const img = el('img'); img.alt = '目前的分享頭像'; img.src = prior; avatarPreview.append(img); }
    else avatarPreview.append(defaultAvatarImg());
    const status = el('p', 'fx-extra-note', '準備產生快照。'); status.setAttribute('role', 'status');
    const preview = el('div', 'fx-extra-preview'); const output = el('div', 'fx-extra-actions');
    const generate = button('更新並產生 PNG', () => generateCard(check.checked, status, preview, output, generate), true);
    check.addEventListener('change', () => { generation++; releaseImage(); preview.replaceChildren(); output.replaceChildren(); status.textContent = '公開設定已變更，請重新產生圖片。'; generate.disabled = false; });
    const copy = button('複製網站連結', async () => {
      // Never propagate search/hash: they can contain recovery codes or credentials.
      const url = new URL(location.href); url.search = ''; url.hash = '';
      try { await navigator.clipboard.writeText(url.href); onToast('已複製網站連結（不含登入資訊）。'); }
      catch { const field = el('input', 'fx-extra-link'); field.readOnly = true; field.value = url.href; field.setAttribute('aria-label', '網站連結，請手動複製'); output.append(field); field.focus(); field.select(); status.textContent = '無法自動複製，請複製下方已選取的網站連結。'; }
    });
    const actions = el('div', 'fx-extra-actions'); actions.append(generate, copy); body.append(actions, status, preview, output);
  }
  async function generateCard(includeName, status, preview, output, generate) {
    const ticket = ++generation, before = identity(context()); generate.disabled = true; releaseImage(); preview.replaceChildren(); output.replaceChildren(); status.textContent = '正在更新帳戶…';
    let confirmed = false;
    try { if (typeof refresh === 'function') { const result = await refresh(); confirmed = result != null && result !== false && result.ok !== false; } }
    catch { confirmed = false; }
    if (ticket !== generation || active !== 'share') return;
    const c = context();
    if (before !== identity(c)) { renderShare(); onToast('帳戶已切換，請重新產生快照。'); return; }
    if (c.mode === 'server' && (!confirmed || navigator.onLine === false)) { status.textContent = '未能確認伺服器最新狀態，請連線後重試；未產生新圖片。'; generate.disabled = false; return; }
    if (c.catchingUp) { status.textContent = '伺服器仍在補算，請完成同步後再產生圖片。'; generate.disabled = false; return; }
    const stamp = new Date();
    const freshness = navigator.onLine === false ? '離線快照・未確認最新狀態' : c.catchingUp ? '伺服器補算中・未確認最新狀態' : c.mode === 'guest' ? '本機練習快照・非伺服器成績' : confirmed ? '已完成更新請求・僅代表產生時快照' : '更新未確認・使用目前已取得資料';
    try {
      const avatar = await avatarImage(getAvatar(c.mode, c.username) || DEFAULT_AVATAR_URL);
      if (ticket !== generation || active !== 'share' || identity(context()) !== before) return;
      const canvas = await drawShareCard(c, { includeName, avatar, stamp, freshness, qr });
      const blob = await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG 產生失敗')), 'image/png'));
      if (ticket !== generation || active !== 'share') return;
      shareURL = URL.createObjectURL(blob);
      const filename = `fx-practice-${stamp.toISOString().slice(0, 10)}.png`;
      shareFile = typeof File === 'function' ? new File([blob], filename, { type: 'image/png' }) : null;
      const image = el('img'); image.src = shareURL; image.alt = `${c.mode === 'server' ? '伺服器帳戶快照' : '訪客練習'}；${freshness}；圖片非驗證憑證`;
      preview.append(image);
      const download = el('a', 'fx-extra-button fx-extra-primary', '下載 PNG'); download.href = shareURL; download.download = filename; output.append(download);
      if (shareFile && navigator.share && navigator.canShare?.({ files: [shareFile] })) {
        output.append(button('分享圖片', async () => {
          if (!shareFile) return;
          try { await navigator.share({ files: [shareFile], title: '槓桿交易練習場', text: '虛構行情練習快照，圖片非驗證憑證。' }); }
          catch (error) { if (error.name !== 'AbortError') onToast('無法分享圖片，請改用下載 PNG。', true); }
        }));
      }
      status.textContent = `${freshness}。產生時間：${date(stamp)}。`;
    } catch { status.textContent = '圖片產生失敗，請稍後重試。'; }
    finally { if (ticket === generation) generate.disabled = false; }
  }
  function renderTutorial() {
    body.replaceChildren();
    const steps = [
      ['多與空，先看方向', '做多是在價格上漲時獲利；做空是在價格下跌時獲利。方向相反就會虧損，新聞也不保證價格走向。'],
      ['保證金與槓桿', '保證金不是購買倉位的全額。名目倉位＝保證金 × 槓桿；槓桿同時放大獲利與虧損風險。'],
      ['費用與強制平倉', '本遊戲開倉即收費，槓桿越高手續費越高。50× 時反向約 1.6% 即達強平門檻，100× 時約 0.8%；虧損達保證金 80% 時會強平。跳空可能穿過強平價，帳戶權益甚至可能為負。'],
      ['平倉才結算', '持倉中的浮動損益會隨價格變動。按下持倉卡的「平倉」才結束該筆交易並結算；已支付的開倉費不會退回。'],
      ['登入與救援碼', '訪客只在本機練習，不計成績。登入後由伺服器計算。救援碼只顯示一次，請另存安全處，切勿放進分享圖片、連結或傳給他人。'],
      ['離線不是暫停風險', '伺服器行情會繼續前進，關閉分頁不會停止持倉風險。回來時可能需要補算並發生強平；離線、補算中或更新失敗時，不要把舊畫面當成最新狀態。'],
    ];
    const progress = el('p', 'fx-extra-step', `新手導覽 ${tutorialStep + 1} / 6`);
    body.append(progress, el('h3', '', steps[tutorialStep][0]), el('p', 'fx-extra-prose', steps[tutorialStep][1]), el('div', 'fx-extra-callout', '這是教學，不操作真帳戶、不送出訂單，也不更改你的練習帳戶。'));
    if (tutorialStep === 1) {
      const label = el('label', 'fx-extra-range-label', '試算：固定保證金 $100，選擇 1–10、50 或 100 倍'); label.htmlFor = 'fx-extra-leverage';
      const range = el('input', 'fx-extra-range'); range.type = 'range'; range.min = '0'; range.max = String(LEVERAGES.length - 1); range.step = '1'; range.value = String(LEVERAGES.indexOf(leverage)); range.id = 'fx-extra-leverage';
      const result = el('output', 'fx-extra-calculation'); result.htmlFor = range.id;
      const recalc = () => { leverage = LEVERAGES[Number(range.value)]; result.textContent = `${leverage}× → 名目倉位 ${money(100 * leverage)}，開倉費 ${money(feeFor(100 * leverage, leverage))}；反向約 ${(80 / leverage).toFixed(2)}% 就可能強平。以 EUR/USD 做多為例，價格反向 1% 約虧 ${money(leverage)}（不含費用）；跳空會更嚴重。`; };
      range.addEventListener('input', recalc); recalc(); body.append(label, range, result);
    }
    if (tutorialStep === 3) {
      const fieldset = el('fieldset', 'fx-extra-quiz'); fieldset.append(el('legend', '', '小練習：做空後價格上漲，未計費用時會？'));
      const feedback = el('p', 'fx-extra-note'); feedback.setAttribute('role', 'status');
      const feedbackText = answer => answer === '虧損' ? '答對了。做空遇到上漲會虧損；槓桿不會改變方向，只會放大影響。' : '再想想：做空期待價格下跌，價格上漲會產生虧損。';
      for (const answer of ['獲利', '虧損']) {
        const label = el('label', 'fx-extra-check'), input = el('input'); input.type = 'radio'; input.name = 'fx-extra-quiz'; input.value = answer; input.checked = quizAnswer === answer;
        input.addEventListener('change', () => { quizAnswer = answer; feedback.textContent = feedbackText(answer); }); label.append(input, document.createTextNode(answer)); fieldset.append(label);
      }
      if (quizAnswer) feedback.textContent = feedbackText(quizAnswer);
      body.append(fieldset, feedback);
    }
    const actions = el('div', 'fx-extra-actions'); const prev = button('上一步', () => { tutorialStep--; renderTutorial(); title.focus(); }); prev.disabled = tutorialStep === 0;
    actions.append(prev, button(tutorialStep === 5 ? '完成導覽' : '下一步', () => { if (tutorialStep === 5) { dismissWelcome(); close(); } else { tutorialStep++; renderTutorial(); title.focus(); } }, true), button('退出教學', () => close())); body.append(actions);
  }
  function update() {
    if (dialog.open && otherOverlay()) { close(false); return; }
    const c = context();
    if (active === 'share' && identity(c) !== shareIdentity) { generation++; releaseImage(); renderShare(); }
    if (active === 'stats' || active === 'achievements') {
      const signature = JSON.stringify([active, c.mode, c.progress, c.resets, c.account?.log, c.catchingUp, navigator.onLine, c.book?.owner, c.book?.unlocked()]);
      if (signature !== statsSignature) { statsSignature = signature; active === 'stats' ? renderStats() : renderAchievements(); }
    }
  }
  // Auth/recovery always take priority, including overlays opened by an async response.
  const observer = new MutationObserver(() => { if (dialog.open && otherOverlay()) close(false); });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
  return { update };
}
