-- Ephemeral browser-tab presence. Store only a random per-tab token, not IPs or usernames.
CREATE TABLE IF NOT EXISTS online_presence (
  tab_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  account_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_seen ON online_presence(last_seen);
