// Part of games.state: update exclusively inside the player's versioned game CAS.
import { equity, netWorth, loanOwed } from '../../engine.mjs';
import { GameError, START_CASH } from './game.js';

const NICKNAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} _-]*[\p{L}\p{N}])?$/u;
export function currentSeason(now) {
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) throw new GameError('無效的賽季時間');
  const d = new Date(now);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

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
  const season = currentSeason(now);
  const year = Number(season.slice(0, 4)), quarter = Number(season.slice(-1));
  const endsAt = new Date(Date.UTC(year, quarter * 3, 1)).toISOString();
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
    season, endsAt, updatedAt: new Date(now).toISOString(),
    entries: results.map(({ nickname, score, scoreUpdatedAt, closedTrades, resetCount }, i) => ({
      rank: i + 1, nickname, returnPct: score, equity: START_CASH * (1 + score),
      closedTrades: closedTrades ?? 0, resetCount: resetCount ?? 0,
      scoreUpdatedAt: new Date(scoreUpdatedAt).toISOString(),
    })),
    note: '分數包含上次儲存時的浮動盈虧，只在玩家自己的遊戲狀態經伺服器推進並成功儲存時更新；即使同一行情 tick 也可能尚未更新，不代表即時淨值。請查看 scoreUpdatedAt。',
  };
}
