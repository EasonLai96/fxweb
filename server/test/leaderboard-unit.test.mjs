import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, resetGame, openOrder, GameError } from '../src/game.js';
import { currentSeason, joinSeason, leaveSeason, updateSeasonScore, publicLeaderboard, seasonParticipationView } from '../src/leaderboard.js';
import { equity } from '../../engine.mjs';
import { createD1 } from './d1shim.mjs';

const jan = Date.UTC(2026, 0, 1), apr = Date.UTC(2026, 3, 1);
const game = () => newGame(jan);
const env = () => ({ DB: createD1(new URL('../migrations', import.meta.url).pathname) });
function insert(e, id, username, g) {
  e.DB.raw.prepare('INSERT INTO users (id, username, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, 'private-password-hash', 'private-salt', 1, jan);
  e.DB.raw.prepare('INSERT INTO games (user_id, state, version, updated_at) VALUES (?, ?, 1, ?)')
    .run(id, JSON.stringify(g), jan);
}

test('UTC Q1 through Q4 and season turnover', () => {
  assert.equal(currentSeason(jan - 1), '2025-Q4');
  assert.equal(currentSeason(jan), '2026-Q1');
  assert.equal(currentSeason(apr - 1), '2026-Q1');
  assert.equal(currentSeason(apr), '2026-Q2');
  assert.equal(currentSeason(Date.UTC(2026, 6, 1)), '2026-Q3');
  assert.equal(currentSeason(Date.UTC(2026, 9, 1)), '2026-Q4');
  const g = game();
  joinSeason(g, 'Player One', jan);
  assert.equal(updateSeasonScore(g, g.market.prices, apr), false);
  assert.equal(seasonParticipationView(g, apr).status, 'not_joined');
  assert.equal(joinSeason(g, 'Player Two', apr).season, '2026-Q2');
});

test('nickname opt-in, fresh round requirement and voluntary pre-enrollment reset', () => {
  const g = game();
  for (const nickname of [undefined, '<script>', 'abc\u202e', 'x'.repeat(17)]) assert.throws(() => joinSeason(g, nickname, jan), GameError);
  assert.equal(g.seasonParticipation, undefined);
  openOrder(g, { pair: 'EUR/USD', side: 1, leverage: 2, margin: 100 }, jan);
  assert.throws(() => joinSeason(g, 'player', jan), GameError);
  g.account.positions = [];
  assert.throws(() => joinSeason(g, 'player', jan), GameError);
  resetGame(g, jan);
  assert.equal(joinSeason(g, 'player', jan).status, 'active');
  assert.throws(() => joinSeason(g, 'renamed', jan), GameError);
  const migrated = game();
  migrated.seasonResetRequired = true;
  assert.throws(() => joinSeason(migrated, 'player', jan), GameError);
  migrated.seasonResetRequired = false; // resetGame(shared, jan, secret) clears this guard.
  resetGame(migrated, jan);
  assert.equal(joinSeason(migrated, 'player', jan).status, 'active');
});

test('withdraw and reset retain tombstone, including across reset; new quarter can enter', async () => {
  const g = game(), e = env();
  joinSeason(g, 'trader', jan);
  assert.equal(leaveSeason(g, jan + 1), true);
  assert.equal(leaveSeason(g, jan + 2), false);
  assert.equal(updateSeasonScore(g, g.market.prices, jan + 2), false);
  resetGame(g, jan + 3);
  assert.equal(g.seasonParticipation.status, 'withdrawn');
  assert.throws(() => joinSeason(g, 'trader', jan + 4), GameError);
  insert(e, 1, 'private-user', g);
  assert.deepEqual((await publicLeaderboard(e, jan)).entries, []);
  assert.equal(joinSeason(g, 'new-quarter', apr).status, 'active');
});

test('score includes floating PnL, not just cash or capped eq chart; nonfinite quote rejected', () => {
  const g = game();
  joinSeason(g, 'Trader', jan);
  const p = openOrder(g, { pair: 'EUR/USD', side: 1, leverage: 3, margin: 100 }, jan);
  const prices = { ...g.market.prices, [p.pair]: p.entry * 1.01 };
  assert.equal(updateSeasonScore(g, prices, jan + 1), true);
  assert.equal(g.seasonParticipation.score, equity(g.account, prices) / 10000 - 1);
  assert.ok(g.seasonParticipation.score > 0);
  assert.notEqual(g.seasonParticipation.score, g.account.cash / 10000 - 1);
  assert.equal(g.seasonParticipation.scoreUpdatedAt, jan + 1);
  assert.throws(() => updateSeasonScore(g, { [p.pair]: 0 }, jan + 2), GameError);
  assert.equal(g.seasonParticipation.scoreUpdatedAt, jan + 1);
});

test('public query exposes only opted-in current-season allowlisted rows with stale warning', async () => {
  const e = env(), a = game(), b = game();
  joinSeason(a, 'Visible', jan);
  a.seasonParticipation.score = .123;
  a.seasonParticipation.scoreUpdatedAt = jan + 456;
  joinSeason(b, 'Next season', apr);
  insert(e, 1, 'never-expose-username', a);
  insert(e, 2, 'another-private-user', b);
  insert(e, 3, 'not-opted-in', game());
  const result = await publicLeaderboard(e, jan + 1000);
  assert.equal(result.season, '2026-Q1');
  assert.deepEqual(result.entries, [{ rank: 1, nickname: 'Visible', returnPct: .123, equity: 11230,
    closedTrades: 0, resetCount: 0, scoreUpdatedAt: new Date(jan + 456).toISOString() }]);
  assert.equal(result.endsAt, new Date(apr).toISOString());
  assert.equal(result.updatedAt, new Date(jan + 1000).toISOString());
  assert.match(result.note, /尚未更新/);
  const text = JSON.stringify(result);
  for (const secret of ['never-expose-username', 'another-private-user', 'private-password-hash', 'private-salt', 'market', 'secret', 'state', 'token', 'user_id'])
    assert.ok(!text.includes(secret), secret);
  assert.deepEqual((await publicLeaderboard(e, apr)).entries, [{ rank: 1, nickname: 'Next season', returnPct: 0,
    equity: 10000, closedTrades: 0, resetCount: 0, scoreUpdatedAt: new Date(apr).toISOString() }]);
  leaveSeason(a, jan + 1);
  e.DB.raw.prepare('UPDATE games SET state = ? WHERE user_id = 1').run(JSON.stringify(a));
  assert.deepEqual((await publicLeaderboard(e, jan)).entries, []);
});

test('季中重開賽季：新賽季 ID、舊參賽失效、帳戶不動，重置後可報名新賽季', async () => {
  const { SEASON_RESTARTS, seasonInfo, previousSeason, archiveSeason, archivedLeaderboard } = await import('../src/leaderboard.js');
  const r = SEASON_RESTARTS.at(-1), before = r.start - 1;
  assert.equal(currentSeason(before), '2026-Q4');
  assert.equal(currentSeason(r.start), r.id);
  assert.equal(seasonInfo(r.start).end, Date.UTC(2027, 0, 1));
  assert.equal(previousSeason(r.start).id, '2026-Q4');
  assert.equal(currentSeason(Date.UTC(2027, 0, 1)), '2027-Q1', '下一季照常');
  assert.equal(previousSeason(Date.UTC(2027, 0, 1)).id, r.id);

  const e = env(), g = newGame(before);
  joinSeason(g, 'old-king', before);
  g.seasonParticipation.score = 99;
  const cashBefore = g.account.cash;
  insert(e, 7, 'private-user', g);
  // 重開後：舊參賽不再計分、顯示未參賽，帳戶金額不變
  assert.equal(updateSeasonScore(g, g.market.prices, r.start), false);
  assert.equal(seasonParticipationView(g, r.start).status, 'not_joined');
  assert.equal(g.account.cash, cashBefore);
  const live = await publicLeaderboard(e, r.start);
  assert.equal(live.season, r.id); assert.equal(live.entries.length, 0); assert.equal(live.previousSeason, '2026-Q4');
  // 封存上季（只寫一次）
  assert.equal(await archiveSeason(e, '2026-Q4', before), 0, '還沒結束不封存');
  assert.equal(await archiveSeason(e, '2026-Q4', r.start), 1);
  e.DB.raw.prepare("UPDATE games SET state = json_set(state, '$.seasonParticipation.score', 5)").run();
  assert.equal(await archiveSeason(e, '2026-Q4', r.start + 60000), 0, '已封存不重寫');
  const old = await archivedLeaderboard(e, '2026-Q4');
  assert.equal(old.entries[0].nickname, 'old-king'); assert.equal(old.entries[0].returnPct, 99);
  assert.ok(!JSON.stringify(old).includes('private-user'));
  await assert.rejects(() => archivedLeaderboard(e, "x' OR 1"), GameError);
  // 想上新榜：要先重置成全新回合
  resetGame(g, r.start);
  assert.equal(joinSeason(g, 'new-season', r.start).season, r.id);
});
