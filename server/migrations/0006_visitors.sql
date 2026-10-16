-- 歷史來訪人數：每個瀏覽器一個隨機 ID（存在 localStorage），不存 IP 或帳號。
CREATE TABLE IF NOT EXISTS visitors (
  visitor_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO site_stats(key, value) VALUES ('visitors', 0);
