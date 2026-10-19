import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1shim.mjs';
import { ONLINE_WINDOW_MS, presence, prunePresence } from '../src/presence.js';
const db=()=>createD1(new URL('../migrations', import.meta.url).pathname);
const id = n => n.toString(16).padStart(32,'0');
test('guests count by tab and multiple authenticated tabs count once', async () => {
  const DB=db(), env={DB}, time=1_000_000;
  await DB.prepare('INSERT INTO users(id,username,pw_hash,pw_salt,pw_iter,created_at) VALUES(1,?,?,?,?,?)')
    .bind('player','x','salt',1,time).run();
  assert.deepEqual(await presence(env,id(1),null,time),{online:1,players:0,guests:1,windowSeconds:300,totalVisitors:0});
  assert.equal((await presence(env,id(2),null,time)).online,2);
  assert.deepEqual(await presence(env,id(1),1,time),{online:2,players:1,guests:1,windowSeconds:300,totalVisitors:0});
  assert.deepEqual(await presence(env,id(3),1,time),{online:2,players:1,guests:1,windowSeconds:300,totalVisitors:0});
  assert.equal((await presence(env,id(2),null,time+ONLINE_WINDOW_MS+1)).online,1);
  await prunePresence(env,time+ONLINE_WINDOW_MS+1);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM online_presence').first()).n,1);
});
test('presence refuses malformed identifiers and never needs IP or username', async () => {
  await assert.rejects(()=>presence({DB:db()},'bad',null),/invalid_tab_id/);
});

test('歷史來訪：同一瀏覽器只算一次，不同瀏覽器累加', async () => {
  const env={DB:db()}, t=5_000_000;
  assert.equal((await presence(env,id(1),null,t,id(100))).totalVisitors,1);
  assert.equal((await presence(env,id(2),null,t,id(100))).totalVisitors,1,'同瀏覽器新分頁不重複');
  assert.equal((await presence(env,id(3),null,t+9e9,id(100))).totalVisitors,1,'隔很久回訪也不重複');
  assert.equal((await presence(env,id(4),null,t,id(101))).totalVisitors,2);
  assert.equal((await presence(env,id(5),null,t)).totalVisitors,2,'舊版前端沒帶 ID 不影響');
  await assert.rejects(()=>presence(env,id(6),null,t,'bad'),/invalid_visitor_id/);
});
