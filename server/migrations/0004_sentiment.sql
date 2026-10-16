-- Immutable 5-minute position snapshots; a missing bucket is neutral forever.
CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  bucket INTEGER PRIMARY KEY,
  counts TEXT NOT NULL,
  captured_at INTEGER NOT NULL
);
