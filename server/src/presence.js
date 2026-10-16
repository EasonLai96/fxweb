// Active browser tabs (including guest mode) within the last 75 seconds.
// An authenticated account with several tabs counts once; guest tabs count individually.
export const ONLINE_WINDOW_MS = 75_000;
const TAB_ID = /^[a-f0-9]{32}$/;
export async function presence(env, tabId, accountId, t = Date.now(), visitorId = null) {
  if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw new Error('invalid_tab_id');
  if (visitorId !== null && (typeof visitorId !== 'string' || !TAB_ID.test(visitorId))) throw new Error('invalid_visitor_id');
  // 新瀏覽器第一次出現才把累計 +1；同一瀏覽器之後再來不重複計算。
  if (visitorId) {
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO visitors(visitor_id,first_seen) VALUES(?,?)').bind(visitorId,t).run();
    if (ins.meta?.changes) await env.DB.prepare("UPDATE site_stats SET value=value+1 WHERE key='visitors'").run();
  }
  // Unauthenticated callers cannot impersonate a user id: it is obtained from the bearer session server-side.
  await env.DB.prepare(`INSERT INTO online_presence(tab_id,last_seen,account_id) VALUES(?,?,?)
    ON CONFLICT(tab_id) DO UPDATE SET last_seen=excluded.last_seen,account_id=excluded.account_id`)
    .bind(tabId,t,accountId).run();
  const threshold = t - ONLINE_WINDOW_MS;
  const row = await env.DB.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN account_id IS NOT NULL THEN account_id END) AS players,
      SUM(CASE WHEN account_id IS NULL THEN 1 ELSE 0 END) AS guests
    FROM online_presence WHERE last_seen >= ?`).bind(threshold).first();
  const players = row?.players || 0, guests = row?.guests || 0;
  const total = (await env.DB.prepare("SELECT value FROM site_stats WHERE key='visitors'").first())?.value || 0;
  return { online: players + guests, players, guests, windowSeconds: ONLINE_WINDOW_MS / 1000, totalVisitors: total };
}
export async function prunePresence(env, t = Date.now()) {
  await env.DB.prepare('DELETE FROM online_presence WHERE last_seen < ?').bind(t - ONLINE_WINDOW_MS).run();
}
