/* 好友房：用 6 碼邀請碼組私人排行榜。沿用排行榜對話框的樣式（leaderboard-ui.css）。
 * request(action, data)：list / create{name,nickname} / join{code,nickname} / leave{code} / board{code}
 * 全部只用 textContent 輸出，回應中只會有房名、邀請碼、成員自選暱稱與成績，沒有帳號名稱。 */
const el = (tag, cls = '', text) => { const n = document.createElement(tag); n.className = cls; if (text != null) n.textContent = String(text); return n; };
const btn = (text, fn, cls = '') => { const n = el('button', `fx-leader-button ${cls}`, text); n.type = 'button'; n.addEventListener('click', fn); return n; };
const finite = n => typeof n === 'number' && Number.isFinite(n);
const pct = x => finite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%` : '尚無成績';
const ago = x => { const t = x ? new Date(x).getTime() : NaN; if (!Number.isFinite(t)) return '尚未更新'; const s = (Date.now() - t) / 1000;
  return s < 90 ? '剛剛' : s < 3600 ? `${Math.round(s / 60)} 分鐘前` : s < 86400 ? `${Math.round(s / 3600)} 小時前` : `${Math.round(s / 86400)} 天前`; };
const CODE_RE = /^[A-HJKMNP-Z2-9]{6}$/;
const NICK_KEY = 'fxweb.roomNick';

export function initRooms({ request, onToast = () => {}, getContext, onNeedLogin = () => {} } = {}) {
  if (document.getElementById('fx-room-dialog')) return { update() {} };
  const ctx = () => getContext() || {}, signed = () => ctx().mode === 'server' && !!ctx().username;
  const toolbar = document.querySelector('#fx-extras .fx-extra-toolbar');
  const launch = btn('好友', () => open(), 'fx-leader-launcher fx-room-launcher'); launch.setAttribute('aria-haspopup', 'dialog');
  if (toolbar) toolbar.append(launch);
  const dialog = el('dialog', 'fx-leader-dialog fx-room-dialog'); dialog.id = 'fx-room-dialog'; dialog.setAttribute('aria-labelledby', 'fx-room-title');
  const head = el('div', 'fx-leader-heading'), title = el('h2', '', '好友房'); title.id = 'fx-room-title'; title.tabIndex = -1;
  head.append(title, btn('關閉', () => close())); const body = el('div', 'fx-leader-body'); dialog.append(head, body); document.body.append(dialog);
  let rooms = null, board = null, current = null, loading = false, busy = false, error = '', pending = null, epoch = 0;

  function close() { if (!dialog.open) return; epoch++; dialog.close(); launch.focus({ preventScroll: true }); }
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  dialog.addEventListener('click', e => { if (e.target !== dialog) return; const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); });

  function open(code) {
    if (code) pending = code;
    if (!dialog.open) dialog.showModal();
    if (!signed()) { rooms = null; board = null; current = null; render(); return; }
    current = null; board = null; loadList();
    title.focus({ preventScroll: true });
  }
  async function guard(fn) {
    const ticket = ++epoch; loading = true; error = ''; render();
    try { await fn(() => ticket === epoch && dialog.open); }
    catch (e) { if (ticket === epoch) { error = e instanceof Error ? e.message : '暫時無法連線'; } }
    finally { if (ticket === epoch) { loading = false; render(); } }
  }
  const loadList = () => guard(async ok => {
    const r = await request('list'); if (!ok()) return; rooms = Array.isArray(r?.rooms) ? r.rooms : [];
    // 從 ?room=CODE 進來：已在房內就直接打開；否則預填邀請碼。
    if (pending && rooms.some(x => x.code === pending)) { const c = pending; pending = null; loadBoard(c); }
  });
  const loadBoard = code => guard(async ok => {
    current = code; board = null; const r = await request('board', { code }); if (!ok()) return; board = r?.board || null;
  });
  async function act(action, data, done) {
    if (busy) return; busy = true; error = ''; render();
    try { const r = await request(action, data); if (!dialog.open) return; await done(r); }
    catch (e) { error = e instanceof Error ? e.message : '操作失敗'; onToast(error, true); }
    finally { busy = false; render(); }
  }

  function field(labelText, opts) {
    const wrap = el('label', 'fx-room-field'), input = el('input');
    wrap.append(el('span', '', labelText), input); Object.assign(input, opts); input.autocomplete = 'off'; return [wrap, input];
  }
  function inviteLink(code) {
    const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('room', code); return u.toString();
  }
  async function share(code, name) {
    const link = inviteLink(code), text = `來「槓桿交易練習場」好友房「${name}」比賽！邀請碼 ${code}`;
    try { if (navigator.share) { await navigator.share({ title: '好友房邀請', text, url: link }); return; } } catch (e) { if (e?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(`${text}\n${link}`); onToast('已複製邀請連結'); }
    catch { onToast(`邀請碼：${code}`); }
  }

  function renderList() {
    body.append(el('p', 'fx-leader-intro', '建一個房間，把邀請碼給朋友，就能在私人排行比誰的報酬率高。只顯示你在房內自選的暱稱，不會顯示登入帳號。'));
    if (rooms?.length) {
      const list = el('ol', 'fx-leader-list fx-room-list');
      for (const r of rooms) {
        const row = el('li', 'fx-leader-row fx-room-row'), person = el('div', 'fx-leader-person');
        person.append(el('strong', 'fx-leader-rank', r.isOwner ? '房主' : '成員'), el('span', 'fx-leader-name', r.name));
        const meta = el('small', 'fx-leader-detail', `邀請碼 ${r.code} · ${r.members} 人 · 我的暱稱 ${r.nickname}`);
        const view = btn('看排行', () => loadBoard(r.code), 'fx-leader-primary'); view.disabled = busy || loading;
        row.append(person, view, meta); list.append(row);
      }
      body.append(list);
    } else if (rooms && !loading) body.append(el('p', 'fx-leader-state', '你還沒有加入任何好友房。'));
    const saved = (() => { try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; } })();
    // 加入
    const join = el('form', 'fx-leader-participant fx-room-form'); join.append(el('h3', '', '用邀請碼加入'));
    const [jc, codeIn] = field('邀請碼', { maxLength: 8, placeholder: '例如 K7QM2P', value: pending || '' }); codeIn.style.textTransform = 'uppercase';
    const [jn, nickIn] = field('在房內的暱稱（1–16 字）', { maxLength: 32, placeholder: '朋友認得出你的名字', value: saved });
    const jb = btn('加入', () => {}, 'fx-leader-primary'); jb.type = 'submit'; jb.disabled = busy || loading;
    join.append(jc, jn, jb);
    join.addEventListener('submit', e => { e.preventDefault(); const code = codeIn.value.trim().toUpperCase().replace(/[\s-]/g, ''), nickname = nickIn.value.trim();
      if (!CODE_RE.test(code)) { onToast('邀請碼是 6 個英數字', true); return; }
      if (!nickname) { onToast('請輸入暱稱', true); return; }
      try { localStorage.setItem(NICK_KEY, nickname); } catch {}
      act('join', { code, nickname }, async r => { pending = null; onToast(`已加入「${r.room.name}」`); await loadList(); loadBoard(r.room.code); }); });
    // 建立
    const make = el('form', 'fx-leader-participant fx-room-form'); make.append(el('h3', '', '建立新房間'));
    const [mn, nameIn] = field('房間名稱（1–20 字）', { maxLength: 40, placeholder: '例如 三年二班' });
    const [mk, nick2] = field('你在房內的暱稱', { maxLength: 32, placeholder: '朋友認得出你的名字', value: saved });
    const mb = btn('建立', () => {}, 'fx-leader-primary'); mb.type = 'submit'; mb.disabled = busy || loading;
    make.append(mn, mk, mb);
    make.addEventListener('submit', e => { e.preventDefault(); const name = nameIn.value.trim(), nickname = nick2.value.trim();
      if (!name || !nickname) { onToast('請填房間名稱和暱稱', true); return; }
      try { localStorage.setItem(NICK_KEY, nickname); } catch {}
      act('create', { name, nickname }, async r => { onToast(`已建立「${r.room.name}」・邀請碼 ${r.room.code}`); await loadList(); loadBoard(r.room.code); }); });
    body.append(pending ? join : make, pending ? make : join);
    body.append(el('p', 'fx-leader-foot', '每人最多 5 個房間，每房最多 50 人。請勿在暱稱或房名填入個資。'));
  }

  function renderBoard() {
    const back = btn('← 我的房間', () => { current = null; board = null; render(); loadList(); });
    const controls = el('div', 'fx-leader-controls'); controls.append(back);
    if (board) {
      const refresh = btn('重新整理', () => loadBoard(board.code)); refresh.disabled = loading || busy;
      const inv = btn('邀請朋友', () => share(board.code, board.name), 'fx-leader-primary');
      controls.append(refresh, inv);
    }
    body.append(controls);
    if (!board) return;
    body.append(el('h3', 'fx-leader-season', board.name), el('p', 'fx-leader-time', `邀請碼 ${board.code} · ${board.entries.length}/${board.max} 人`));
    const list = el('ol', 'fx-leader-list');
    for (const e of board.entries) {
      const row = el('li', 'fx-leader-row' + (e.isMe ? ' fx-room-me' : '')), person = el('div', 'fx-leader-person'), metric = el('div', 'fx-leader-metric');
      person.append(el('strong', 'fx-leader-rank', Number.isInteger(e.rank) ? `#${e.rank}` : '—'),
        el('span', 'fx-leader-name', (typeof e.nickname === 'string' ? e.nickname : '成員') + (e.isMe ? '（你）' : '') + (e.isOwner ? '（房主）' : '')));
      metric.append(el('strong', finite(e.returnPct) ? e.returnPct > 0 ? 'fx-leader-up' : e.returnPct < 0 ? 'fx-leader-down' : '' : '', pct(e.returnPct)));
      row.append(person, metric, el('small', 'fx-leader-detail', `平倉 ${e.closedTrades ?? 0} · 重置 ${e.resetCount ?? 0} · 成績 ${ago(e.scoreUpdatedAt)}`));
      list.append(row);
    }
    body.append(list);
    if (board.note) body.append(el('p', 'fx-leader-note', board.note));
    const leave = btn(board.isOwner ? '解散房間' : '退出房間', () => {
      if (!confirm(board.isOwner ? `確定解散「${board.name}」？所有成員都會被移出。` : `確定退出「${board.name}」？`)) return;
      act('leave', { code: board.code }, async r => { onToast(r.result?.deleted ? '已解散房間' : '已退出房間'); current = null; board = null; await loadList(); });
    }, 'fx-leader-danger'); leave.disabled = busy || loading;
    body.append(leave);
  }

  function render() {
    if (!dialog.open) return;
    body.replaceChildren();
    if (!signed()) {
      body.append(el('p', 'fx-leader-intro', '好友房是登入玩家的私人排行：建一個房間、把邀請碼給朋友，大家在同一組共用行情比報酬率。'));
      if (pending) body.append(el('p', 'fx-leader-callout', `你收到邀請碼 ${pending}，登入後就能加入。`));
      body.append(btn('登入／註冊', () => { close(); onNeedLogin(); }, 'fx-leader-primary'));
      return;
    }
    if (loading) { const p = el('p', 'fx-leader-state', '載入中…'); p.setAttribute('role', 'status'); body.append(p); }
    if (error) { const p = el('p', 'fx-leader-state fx-leader-error', error); p.setAttribute('role', 'alert'); body.append(p); }
    if (current) renderBoard(); else renderList();
  }

  // 登入狀態變了（例如從邀請連結進來後登入），房間清單要重載
  let who = `${ctx().mode}|${ctx().username || ''}`;
  function update() {
    const id = `${ctx().mode}|${ctx().username || ''}`;
    if (id === who) return; who = id; epoch++; rooms = null; board = null; current = null;
    if (dialog.open) open(); else if (pending && signed()) open();
  }

  // ?room=CODE 深連結：打開好友房並預填邀請碼，然後把網址列清乾淨
  try {
    const u = new URL(location.href), code = (u.searchParams.get('room') || '').toUpperCase().replace(/[\s-]/g, '');
    if (CODE_RE.test(code)) {
      pending = code; u.searchParams.delete('room'); history.replaceState(null, '', u.pathname + u.search + u.hash);
      setTimeout(() => open(), 600);
    }
  } catch {}
  return { update, open };
}
