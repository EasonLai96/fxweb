-- 已結束賽季的排行榜封存（只存公開欄位：暱稱與練習統計，不存帳號）。
-- 由排程在賽季結束後寫入一次；之後不再修改。
CREATE TABLE IF NOT EXISTS season_archive (
  season TEXT NOT NULL,
  rank INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  score REAL NOT NULL,
  closed_trades INTEGER NOT NULL DEFAULT 0,
  reset_count INTEGER NOT NULL DEFAULT 0,
  score_updated_at INTEGER NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (season, rank)
);
