// Active browser tabs (including guest mode) within the last ONLINE_WINDOW_MS.
// An authenticated account with several tabs counts once; guest tabs count individually.
// 前端心跳改為每 60 秒一次，視窗必須明顯大於心跳間隔，否則準時送出的分頁會被誤判離線。
export const ONLINE_WINDOW_MS = 150_000;
const TAB_ID = /^[a-f0-9]{32}$/;
export async function presence(env, tabId, accountId, t = Date.now(), visitorId = null) {
  if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw new Error('invalid_tab_id');
  if (visitorId !== null && (typeof visitorId !== 'string' || !TAB_ID.test(visitorId))) throw new Error('invalid_visitor_id');
  const threshold = t - ONLINE_WINDOW_MS;
  // 寫 presence 與讀在線統計本來要多次往返 D1；除了「新瀏覽器累計 +1」以外全部併成一次 batch。
  // 新瀏覽器第一次出現才把累計 +1；同一瀏覽器之後再來不重複計算。
  const stmts = [];
  const visitorIdx = visitorId ? stmts.push(env.DB.prepare('INSERT OR IGNORE INTO visitors(visitor_id,first_seen) VALUES(?,?)').bind(visitorId, t)) - 1 : -1;
  // Unauthenticated callers cannot impersonate a user id: it is obtained from the bearer session server-side.
  stmts.push(env.DB.prepare(`INSERT INTO online_presence(tab_id,last_seen,account_id) VALUES(?,?,?)
    ON CONFLICT(tab_id) DO UPDATE SET last_seen=excluded.last_seen,account_id=excluded.account_id`)
    .bind(tabId, t, accountId));
  const countIdx = stmts.push(env.DB.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN account_id IS NOT NULL THEN account_id END) AS players,
      SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS guests
    FROM online_presence WHERE last_seen >= ?`).bind(threshold)) - 1;
  const res = await env.DB.batch(stmts);
  let total;
  if (visitorId && res?.[visitorIdx]?.meta?.changes) {
    // 這個瀏覽器第一次來：原子遞增並取得新值（只在這裡多一次往返）。
    total = (await env.DB.prepare("UPDATE site_stats SET value=value+1 WHERE key='visitors' RETURNING value").first())?.value || 0;
  } else {
    total = (await env.DB.prepare("SELECT value FROM site_stats WHERE key='visitors'").first())?.value || 0;
  }
  const row = res?.[countIdx]?.results?.[0];
  const players = row?.players || 0, guests = row?.guests || 0;
  return { online: players + guests, players, guests, windowSeconds: ONLINE_WINDOW_MS / 1000, totalVisitors: total };
}
export async function prunePresence(env, t = Date.now()) {
  await env.DB.prepare('DELETE FROM online_presence WHERE last_seen < ?').bind(t - ONLINE_WINDOW_MS).run();
}
