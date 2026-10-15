-- 救援碼（忘記密碼用）：只存雜湊
ALTER TABLE users ADD COLUMN rc_hash TEXT;
ALTER TABLE users ADD COLUMN rc_salt TEXT;
-- 改密碼 / 重設時單調遞增的版本（不依賴時鐘精度），舊 session 全部失效
ALTER TABLE users ADD COLUMN pw_changed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;

-- 伺服器端遊戲狀態（行情 + 帳戶），由伺服器計算，玩家無法直接寫入
CREATE TABLE IF NOT EXISTS games (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

-- 舊的「瀏覽器上傳存檔」API 已停用，但保留 saves 資料，不自動刪除。
-- 使用者刪除帳戶時仍透過 ON DELETE CASCADE 刪除其舊存檔。
