import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createD1 } from './d1shim.mjs';
import { ROOM_MAX_PER_USER } from '../src/rooms.js';

const ORIGIN = 'https://easonlai96.github.io';
const secret = 'ef'.repeat(32);
let clock = 1_800_000_000_000;
const realNow = Date.now;
test.before(() => { Date.now = () => clock; });
test.after(() => { Date.now = realNow; });

function setup() {
  const env = { DB: createD1(new URL('../migrations', import.meta.url).pathname), ALLOWED_ORIGINS: ORIGIN, SHARED_MARKET_SECRET: secret };
  let ip = 0;
  const call = async (method, path, body, token) => {
    const headers = { Origin: ORIGIN, 'CF-Connecting-IP': '10.0.0.' + (ip++ % 250) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await worker.fetch(new Request('https://api.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const user = async name => (await call('POST', '/api/register', { username: name, password: '12345678' })).body.token;
  return { env, call, user };
}

test('建房 → 朋友用邀請碼加入 → 房內排行只顯示暱稱', async () => {
  const { call, user } = setup();
  const a = await user('roomOwnerA'), b = await user('roomFriendB');
  const c = await call('POST', '/api/rooms', { name: '三年二班', nickname: '小明' }, a);
  assert.equal(c.status, 200);
  const code = c.body.room.code;
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  const j = await call('POST', '/api/rooms/join', { code: code.toLowerCase().slice(0, 3) + '-' + code.slice(3), nickname: '阿華' }, b);
  assert.equal(j.status, 200, JSON.stringify(j.body)); assert.equal(j.body.room.members, 2); assert.equal(j.body.room.isOwner, false);
  // B 開一筆倉位，讓成績有變化
  await call('GET', '/api/game?since=-1', undefined, b);
  const board = await call('GET', '/api/rooms/board?code=' + code, undefined, a);
  assert.equal(board.status, 200);
  const text = JSON.stringify(board.body);
  assert.ok(!text.includes('roomOwnerA') && !text.includes('roomFriendB'), '不能洩漏帳號名稱');
  assert.ok(!/user_?id/i.test(text), '不能洩漏 user id');
  assert.deepEqual(board.body.board.entries.map(e => e.nickname).sort(), ['小明', '阿華'].sort());
  const me = board.body.board.entries.find(e => e.isMe);
  assert.equal(me.nickname, '小明'); assert.equal(me.isOwner, true);
  assert.equal(typeof me.returnPct, 'number', '建房時有先存一次成績');
  const list = await call('GET', '/api/rooms', undefined, b);
  assert.equal(list.body.rooms.length, 1); assert.equal(list.body.rooms[0].nickname, '阿華');
});

test('非成員不能看排行；暱稱重複、重複加入、錯誤邀請碼', async () => {
  const { call, user } = setup();
  const a = await user('ownerX'), b = await user('friendY'), c = await user('outsiderZ');
  const code = (await call('POST', '/api/rooms', { name: 'Room', nickname: 'Same' }, a)).body.room.code;
  const peek = await call('GET', '/api/rooms/board?code=' + code, undefined, c);
  assert.equal(peek.status, 400); assert.match(peek.body.message, /先加入/);
  const dup = await call('POST', '/api/rooms/join', { code, nickname: 'Same' }, b);
  assert.equal(dup.status, 400); assert.match(dup.body.message, /暱稱/);
  assert.equal((await call('POST', '/api/rooms/join', { code, nickname: 'Other' }, b)).status, 200);
  const again = await call('POST', '/api/rooms/join', { code, nickname: 'Third' }, b);
  assert.equal(again.status, 400); assert.match(again.body.message, /已經在/);
  const bad = await call('POST', '/api/rooms/join', { code: 'IIIIII', nickname: 'X' }, c);
  assert.equal(bad.status, 400); assert.match(bad.body.message, /6 個英數字/);
  const none = await call('POST', '/api/rooms/join', { code: 'ZZZZZZ', nickname: 'X' }, c);
  assert.equal(none.status, 400); assert.match(none.body.message, /找不到/);
  const badName = await call('POST', '/api/rooms', { name: '   ', nickname: 'ok' }, c);
  assert.equal(badName.status, 400);
  const badNick = await call('POST', '/api/rooms', { name: 'ok', nickname: '<script>' }, c);
  assert.equal(badNick.status, 400);
});

test('成員退出、房主解散、每人房數上限', async () => {
  const { call, user } = setup();
  const a = await user('ownerM'), b = await user('memberN');
  const codes = [];
  for (let i = 0; i < ROOM_MAX_PER_USER; i++) {
    const r = await call('POST', '/api/rooms', { name: 'R' + i, nickname: 'Boss' }, a);
    assert.equal(r.status, 200, JSON.stringify(r.body)); codes.push(r.body.room.code);
  }
  const over = await call('POST', '/api/rooms', { name: 'too many', nickname: 'Boss' }, a);
  assert.equal(over.status, 400); assert.match(over.body.message, /最多加入 5 個/);
  await call('POST', '/api/rooms/join', { code: codes[0], nickname: 'Mem' }, b);
  const left = await call('POST', '/api/rooms/leave', { code: codes[0] }, b);
  assert.equal(left.status, 200); assert.equal(left.body.result.left, true);
  assert.equal((await call('GET', '/api/rooms', undefined, b)).body.rooms.length, 0);
  await call('POST', '/api/rooms/join', { code: codes[0], nickname: 'Mem' }, b);
  const del = await call('POST', '/api/rooms/leave', { code: codes[0] }, a);
  assert.equal(del.body.result.deleted, true);
  assert.equal((await call('GET', '/api/rooms', undefined, b)).body.rooms.length, 0, '房主解散後成員也被移除');
  assert.equal((await call('POST', '/api/rooms/join', { code: codes[0], nickname: 'Mem' }, b)).status, 400);
});

test('刪除帳號會連帶移除房間與成員資格', async () => {
  const { call, user, env } = setup();
  const a = await user('ownerDel'), b = await user('memberDel');
  const code = (await call('POST', '/api/rooms', { name: 'Gone', nickname: 'A' }, a)).body.room.code;
  await call('POST', '/api/rooms/join', { code, nickname: 'B' }, b);
  assert.equal((await call('DELETE', '/api/account', { password: '12345678' }, b)).status, 200);
  const board = await call('GET', '/api/rooms/board?code=' + code, undefined, a);
  assert.equal(board.body.board.entries.length, 1);
  assert.equal((await call('DELETE', '/api/account', { password: '12345678' }, a)).status, 200);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM rooms').first();
  assert.equal(n.n, 0);
});

test('未登入不能用好友房', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/api/rooms')).status, 401);
});
