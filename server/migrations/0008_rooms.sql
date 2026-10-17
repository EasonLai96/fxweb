-- 好友房（私人排行榜）。只存公開欄位：房名、邀請碼、成員在房內自選的暱稱。
-- 不存帳號名稱；成績從 games.state.netScore 讀（伺服器存檔時順便更新）。
-- 帳號刪除時 ON DELETE CASCADE：房主刪帳 → 房間與成員一起刪；成員刪帳 → 只刪他的成員列。
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS room_members (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_room_members_nick ON room_members (room_id, nickname);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members (user_id);
