// Active browser tabs (including guest mode) within the last 75 seconds.
// An authenticated account with several tabs counts once; guest tabs count individually.
export const ONLINE_WINDOW_MS = 75_000;
const TAB_ID = /^[a-f0-9]{32}$/;
export async function presence(env, tabId, accountId, t = Date.now()) {
  if (typeof tabId !== 'string' || !TAB_ID.test(tabId)) throw new Error('invalid_tab_id');
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
  return { online: players + guests, players, guests, windowSeconds: ONLINE_WINDOW_MS / 1000 };
}
export async function prunePresence(env, t = Date.now()) {
  await env.DB.prepare('DELETE FROM online_presence WHERE last_seen < ?').bind(t - ONLINE_WINDOW_MS).run();
}
