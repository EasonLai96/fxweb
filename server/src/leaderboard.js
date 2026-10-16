// Part of games.state: update exclusively inside the player's versioned game CAS.
import { equity, netWorth, loanOwed } from '../../engine.mjs';
import { GameError, START_CASH } from './game.js';

const NICKNAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} _-]*[\p{L}\p{N}])?$/u;
// 賽季預設每季（UTC）一輪。營運可在季中「重開賽季」：在 RESTARTS 加一筆未來的開始時間，
// 從那一刻起到該季結束改用新的賽季 ID（例如 2026-Q4-2）。舊賽季的參賽紀錄自然失效，
// 帳戶本身不動；要上新榜須自行重置後再報名。只能加「未來」的時間，不可改動已生效的紀錄。
export const SEASON_RESTARTS = [
  { id: '2026-Q4-2', start: Date.UTC(2026, 9, 16, 18, 0, 0) },   // 台灣時間 10/17 02:00 重開
];
function quarterOf(now) {
  const d = new Date(now), y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3) + 1;
  return { id: `${y}-Q${q}`, start: Date.UTC(y, (q - 1) * 3, 1), end: Date.UTC(y, q * 3, 1) };
}
export function currentSeason(now) {
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) throw new GameError('無效的賽季時間');
  return seasonInfo(now).id;
}
// 回傳 now 所在賽季的 { id, start, end }。
export function seasonInfo(now) {
  const q = quarterOf(now);
  let cur = { id: q.id, start: q.start, end: q.end };
  for (const r of SEASON_RESTARTS) if (r.start <= now && r.start >= cur.start && r.start < q.end) cur = { id: r.id, start: r.start, end: q.end };
  return cur;
}
export function previousSeason(now) { return seasonInfo(seasonInfo(now).start - 1); }

// Explicit opt-in: never derive nickname from username. A reset BEFORE join
// can restore a fresh account; a reset AFTER join MUST leave a tombstone.
export function joinSeason(g, nickname, now) {
  const season = currentSeason(now);
  if (g.seasonParticipation?.season === season) throw new GameError('本季已參賽或退出，不可再次加入');
  if (typeof nickname !== 'string') throw new GameError('請自行選擇公開暱稱並確認參賽');
  const name = nickname.trim().normalize('NFKC');
  if (Array.from(name).length < 1 || Array.from(name).length > 16 || !NICKNAME_RE.test(name))
    throw new GameError('暱稱需為 1～16 字元，僅可使用文字、數字、空格、底線或連字號，首尾須為文字或數字');
  const a = g.account;
  if (g.seasonResetRequired || !a || a.startingCash !== START_CASH || a.cash !== START_CASH ||
      !Array.isArray(a.positions) || a.positions.length !== 0 ||
      !Array.isArray(a.log) || a.log.length !== 0 || a.nextId !== 1 || loanOwed(a) > 0)
    throw new GameError('只能以全新回合參賽；請自願重置並清空帳戶後再加入');
  g.seasonParticipation = { season, status: 'active', nickname: name, score: 0, scoreUpdatedAt: now };
  return seasonParticipationView(g, now);
}

// Call before every voluntary reset, as well as explicit withdrawal. Never
// delete participation on reset: it is the same-season re-entry tombstone.
export function leaveSeason(g, now) {
  const season = currentSeason(now), p = g.seasonParticipation;
  if (p?.season !== season || p.status !== 'active') return false;
  p.status = 'withdrawn';
  p.withdrawnAt = now;
  return true;
}

// Calculate after server advance/settle and before the player's own CAS write;
// replay on CAS conflict. Never use client quotes, cash alone, or eq chart.
export function updateSeasonScore(g, prices, now) {
  const season = currentSeason(now), p = g.seasonParticipation;
  if (p?.season !== season || p.status !== 'active') return false;
  for (const pos of g.account.positions) {
    if (typeof prices?.[pos.pair] !== 'number' || !Number.isFinite(prices[pos.pair]) || prices[pos.pair] <= 0)
      throw new GameError('無法計算參賽淨值');
  }
  // 成績以淨資產（權益 − 未償還借款）計算，借錢不會虛胖排名報酬率。
  const score = netWorth(g.account, prices) / START_CASH - 1;
  if (!Number.isFinite(score)) throw new GameError('無法計算參賽淨值');
  p.score = score;
  p.scoreUpdatedAt = now;
  return true;
}

export function seasonParticipationView(g, now) {
  const season = currentSeason(now), p = g.seasonParticipation;
  if (p?.season !== season) return { season, status: 'not_joined' };
  return p.status === 'active'
    ? { season, status: 'active', nickname: p.nickname, score: p.score, scoreUpdatedAt: p.scoreUpdatedAt }
    : { season, status: 'withdrawn' };
}

// Strict SQL and response allowlists: don't project username/token/state.
// Other players are never advanced on a public read: stale timestamps disclose it.
export async function publicLeaderboard(env, now) {
  const info = seasonInfo(now), season = info.id;
  const endsAt = new Date(info.end).toISOString();
  const prev = previousSeason(now);
  const { results } = await env.DB.prepare(`SELECT
      json_extract(state, '$.seasonParticipation.nickname') AS nickname,
      json_extract(state, '$.seasonParticipation.score') AS score,
      json_extract(state, '$.seasonParticipation.scoreUpdatedAt') AS scoreUpdatedAt,
      json_extract(state, '$.progress.stats.closedTrades') AS closedTrades,
      json_extract(state, '$.resets') AS resetCount
    FROM games
    WHERE json_extract(state, '$.seasonParticipation.status') = 'active'
      AND json_extract(state, '$.seasonParticipation.season') = ?
    ORDER BY json_extract(state, '$.seasonParticipation.score') DESC, user_id ASC
    LIMIT 100`).bind(season).all();
  return {
    season, startsAt: new Date(info.start).toISOString(), endsAt, updatedAt: new Date(now).toISOString(), previousSeason: prev.id,
    entries: results.map(({ nickname, score, scoreUpdatedAt, closedTrades, resetCount }, i) => ({
      rank: i + 1, nickname, returnPct: score, equity: START_CASH * (1 + score),
      closedTrades: closedTrades ?? 0, resetCount: resetCount ?? 0,
      scoreUpdatedAt: new Date(scoreUpdatedAt).toISOString(),
    })),
    note: '分數包含上次儲存時的浮動盈虧，只在玩家自己的遊戲狀態經伺服器推進並成功儲存時更新；即使同一行情 tick 也可能尚未更新，不代表即時淨值。請查看 scoreUpdatedAt。',
  };
}

// 把已結束賽季的最終排名寫進 season_archive（只寫一次；已封存就跳過）。
// 舊賽季結束後分數不再更新（updateSeasonScore 只更新當季），所以此時的快照就是最終成績。
export async function archiveSeason(env, season, now) {
  if (season === currentSeason(now)) return 0;
  const done = await env.DB.prepare('SELECT 1 FROM season_archive WHERE season = ? LIMIT 1').bind(season).first();
  if (done) return 0;
  const { results } = await env.DB.prepare(`SELECT
      json_extract(state, '$.seasonParticipation.nickname') AS nickname,
      json_extract(state, '$.seasonParticipation.score') AS score,
      json_extract(state, '$.seasonParticipation.scoreUpdatedAt') AS scoreUpdatedAt,
      json_extract(state, '$.progress.stats.closedTrades') AS closedTrades,
      json_extract(state, '$.resets') AS resetCount
    FROM games
    WHERE json_extract(state, '$.seasonParticipation.status') = 'active'
      AND json_extract(state, '$.seasonParticipation.season') = ?
    ORDER BY json_extract(state, '$.seasonParticipation.score') DESC, user_id ASC
    LIMIT 100`).bind(season).all();
  if (!results.length) return 0;
  await env.DB.batch(results.map((r, i) => env.DB.prepare(
    'INSERT OR IGNORE INTO season_archive (season, rank, nickname, score, closed_trades, reset_count, score_updated_at, archived_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind(season, i + 1, r.nickname, r.score, r.closedTrades ?? 0, r.resetCount ?? 0, r.scoreUpdatedAt, now)));
  return results.length;
}

export async function archivedLeaderboard(env, season) {
  if (typeof season !== 'string' || !/^\d{4}-Q[1-4](?:-\d{1,2})?$/.test(season)) throw new GameError('賽季格式錯誤');
  const { results } = await env.DB.prepare(
    'SELECT rank, nickname, score, closed_trades, reset_count, score_updated_at, archived_at FROM season_archive WHERE season = ? ORDER BY rank').bind(season).all();
  return {
    season, archived: true, updatedAt: results[0] ? new Date(results[0].archived_at).toISOString() : null, endsAt: null,
    entries: results.map(r => ({
      rank: r.rank, nickname: r.nickname, returnPct: r.score, equity: START_CASH * (1 + r.score),
      closedTrades: r.closed_trades, resetCount: r.reset_count, scoreUpdatedAt: new Date(r.score_updated_at).toISOString(),
    })),
    note: '已結束賽季的最終排名（封存後不再變動）。',
  };
}
