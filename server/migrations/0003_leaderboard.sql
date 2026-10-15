-- No separate enrollments table: participation (including a withdrawal
-- tombstone) is inside games.state and is atomically committed with game CAS.
-- Avoid STORED generated columns: adding them to existing D1/SQLite games
-- rows is not portable. A partial expression index only covers opt-in rows.
-- Never use an index that extracts username, credentials, or market state.
CREATE INDEX IF NOT EXISTS idx_games_leaderboard_active
ON games (
  json_extract(state, '$.seasonParticipation.season'),
  json_extract(state, '$.seasonParticipation.score') DESC
)
WHERE json_extract(state, '$.seasonParticipation.status') = 'active';
