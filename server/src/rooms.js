// 好友房：用 6 碼邀請碼加入的私人排行榜。
// 隱私：回應只含房名、邀請碼、成員自選暱稱與成績，絕不回傳 user_id／帳號名稱。
import { GameError, START_CASH } from './game.js';

export const ROOM_MAX_MEMBERS = 50;
export const ROOM_MAX_PER_USER = 5;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉 I、L、O、0、1 這些容易看錯的字
const NAME_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} _\-'!?.&+#]*[\p{L}\p{N}!?])?$/u;
const NICK_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N} _-]*[\p{L}\p{N}])?$/u;

function clean(text, re, max, label) {
  if (typeof text !== 'string') throw new GameError(`請輸入${label}`);
  const v = text.trim().normalize('NFKC').replace(/\s+/g, ' ');
  const len = Array.from(v).length;
  if (len < 1 || len > max || !re.test(v)) throw new GameError(`${label}需為 1～${max} 字，可用文字、數字與空格，首尾須為文字或數字`);
  return v;
}
export const cleanRoomName = name => clean(name, NAME_RE, 20, '房間名稱');
export const cleanNickname = nick => clean(nick, NICK_RE, 16, '暱稱');
export function normalizeCode(code) {
  if (typeof code !== 'string') throw new GameError('請輸入邀請碼');
  const c = code.trim().toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== 6 || [...c].some(ch => !CODE_ALPHABET.includes(ch))) throw new GameError('邀請碼是 6 個英數字');
  return c;
}
function newCode() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

// 伺服器存檔時呼叫：記錄「淨資產報酬率」（同季排行的算法：權益 − 借款），給好友房排名。
export function netScore(netWorth, now) {
  const score = netWorth / START_CASH - 1;
  return Number.isFinite(score) ? { score, at: now } : null;
}

async function roomByCode(env, code) {
  const room = await env.DB.prepare('SELECT id, code, name, owner_id FROM rooms WHERE code = ?').bind(code).first();
  if (!room) throw new GameError('找不到這個房間，請確認邀請碼');
  return room;
}

// 單一 SQL 原子檢查「每人房數上限」與「每房人數上限」，避免並行請求一起超過上限。
async function insertMember(env, roomId, userId, nickname, now) {
  try {
    const r = await env.DB.prepare(`INSERT INTO room_members (room_id, user_id, nickname, joined_at)
      SELECT ?1, ?2, ?3, ?4
      WHERE (SELECT COUNT(*) FROM room_members WHERE user_id = ?2) < ?5
        AND (SELECT COUNT(*) FROM room_members WHERE room_id = ?1) < ?6
      RETURNING room_id`).bind(roomId, userId, nickname, now, ROOM_MAX_PER_USER, ROOM_MAX_MEMBERS).first();
    return !!r;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e?.message || e))) {
      const mine = await env.DB.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').bind(roomId, userId).first();
      throw new GameError(mine ? '你已經在這個房間裡了' : '這個暱稱在房間裡已經有人用了，換一個吧');
    }
    throw e;
  }
}
async function explainFull(env, roomId, userId) {
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?').bind(userId).first();
  if (mine.n >= ROOM_MAX_PER_USER) return new GameError(`每人最多加入 ${ROOM_MAX_PER_USER} 個房間，先退出一個吧`);
  return new GameError(`這個房間已滿（最多 ${ROOM_MAX_MEMBERS} 人）`);
}

export async function createRoom(env, userId, name, nickname, now) {
  name = cleanRoomName(name); nickname = cleanNickname(nickname);
  const mine = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?').bind(userId).first();
  if (mine.n >= ROOM_MAX_PER_USER) throw new GameError(`每人最多加入 ${ROOM_MAX_PER_USER} 個房間，先退出一個吧`);
  for (let i = 0; i < 6; i++) {
    const code = newCode();
    let room;
    try {
      room = await env.DB.prepare('INSERT INTO rooms (code, name, owner_id, created_at) VALUES (?, ?, ?, ?) RETURNING id')
        .bind(code, name, userId, now).first();
    } catch (e) { if (/UNIQUE|constraint/i.test(String(e?.message || e))) continue; throw e; }
    if (!(await insertMember(env, room.id, userId, nickname, now))) {
      await env.DB.prepare('DELETE FROM rooms WHERE id = ?').bind(room.id).run();
      throw await explainFull(env, room.id, userId);
    }
    return { code, name, isOwner: true, members: 1, nickname };
  }
  throw new GameError('建立房間失敗，請再試一次');
}

export async function joinRoom(env, userId, code, nickname, now) {
  code = normalizeCode(code); nickname = cleanNickname(nickname);
  const room = await roomByCode(env, code);
  if (!(await insertMember(env, room.id, userId, nickname, now))) throw await explainFull(env, room.id, userId);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').bind(room.id).first();
  return { code: room.code, name: room.name, isOwner: room.owner_id === userId, members: n.n, nickname };
}

// 房主「退出」＝解散房間（成員一起移除）；一般成員只移除自己。
export async function leaveRoom(env, userId, code) {
  code = normalizeCode(code);
  const room = await roomByCode(env, code);
  if (room.owner_id === userId) {
    await env.DB.prepare('DELETE FROM rooms WHERE id = ? AND owner_id = ?').bind(room.id, userId).run();
    return { code, deleted: true };
  }
  const r = await env.DB.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ? RETURNING room_id').bind(room.id, userId).first();
  if (!r) throw new GameError('你不在這個房間裡');
  return { code, left: true };
}

export async function myRooms(env, userId) {
  const { results } = await env.DB.prepare(`SELECT r.code, r.name, r.owner_id = ?1 AS isOwner, m.nickname,
      (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS members
    FROM room_members m JOIN rooms r ON r.id = m.room_id
    WHERE m.user_id = ?1 ORDER BY m.joined_at ASC`).bind(userId).all();
  return results.map(r => ({ code: r.code, name: r.name, isOwner: !!r.isOwner, nickname: r.nickname, members: r.members }));
}

export async function roomBoard(env, userId, code) {
  code = normalizeCode(code);
  const room = await roomByCode(env, code);
  const me = await env.DB.prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?').bind(room.id, userId).first();
  if (!me) throw new GameError('要先加入這個房間才能看排行');
  const { results } = await env.DB.prepare(`SELECT m.nickname, m.user_id = ?2 AS isMe, m.user_id = ?3 AS isOwner,
      json_extract(g.state, '$.netScore.score') AS score,
      json_extract(g.state, '$.netScore.at') AS scoreAt,
      json_extract(g.state, '$.progress.stats.closedTrades') AS closedTrades,
      json_extract(g.state, '$.resets') AS resets
    FROM room_members m LEFT JOIN games g ON g.user_id = m.user_id
    WHERE m.room_id = ?1
    ORDER BY score IS NULL, score DESC, m.joined_at ASC`).bind(room.id, userId, room.owner_id).all();
  return {
    code: room.code, name: room.name, isOwner: room.owner_id === userId, max: ROOM_MAX_MEMBERS,
    entries: results.map((r, i) => ({
      rank: r.score == null ? null : i + 1, nickname: r.nickname, isMe: !!r.isMe, isOwner: !!r.isOwner,
      returnPct: r.score, scoreUpdatedAt: r.scoreAt ? new Date(r.scoreAt).toISOString() : null,
      closedTrades: r.closedTrades ?? 0, resetCount: r.resets ?? 0,
    })),
    note: '報酬率＝淨資產（權益－借款）相對 $10,000，於玩家自己的帳戶被伺服器存檔時更新，不是即時淨值。',
  };
}
