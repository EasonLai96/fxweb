import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './d1shim.mjs';
import { captureSentiment, loadSnapshots, SENTIMENT_START, SENTIMENT_BUCKET, sentimentAt, sentimentLog, probability } from '../src/sentiment.js';
import { sharedPrice, sharedPricer, makeSharedMarket } from '../src/shared-market.js';
import { hmacKey } from '../../market.mjs';
import { PAIRS } from '../../market.mjs';
const secret = '77'.repeat(32);
const bucket = Math.floor(SENTIMENT_START / SENTIMENT_BUCKET);
test('one vote per account and pair; opposite positions cancel', async () => {
  const DB = createD1(new URL('../migrations', import.meta.url).pathname);
  const t = bucket * SENTIMENT_BUCKET * 1500 + 1000;
  const positions = [{pair:'BTC',side:1},{pair:'BTC',side:1},{pair:'EUR/USD',side:1}];
  const insert = (id, ps, mode='shared') => DB.prepare('INSERT INTO games(user_id,state,updated_at) VALUES(?,?,?)')
    .bind(id, JSON.stringify({marketMode:mode,account:{positions:ps}}), t).run();
  for (let i=1;i<=4;i++) await DB.prepare('INSERT INTO users(id,username,pw_hash,pw_salt,pw_iter,created_at) VALUES(?,?,?,?,?,?)')
    .bind(i,'player'+i,'x','y',1,t).run();
  await insert(1,positions);
  await insert(2,[{pair:'BTC',side:-1},{pair:'EUR/USD',side:1}]);
  await insert(3,[{pair:'BTC',side:1},{pair:'BTC',side:-1},{pair:'EUR/USD',side:-1}]);
  await insert(4,[{pair:'BTC',side:-1}], 'legacy');
  const oldNow=Date.now; Date.now=()=>t;
  try { await captureSentiment({DB},t); } finally { Date.now=oldNow; }
  const snap=await loadSnapshots({DB},(bucket+1)*SENTIMENT_BUCKET,(bucket+1)*SENTIMENT_BUCKET);
  assert.deepEqual(snap.get(bucket)['BTC'],{long:1,short:1});
  assert.deepEqual(snap.get(bucket)['EUR/USD'],{long:2,short:1});
  assert.equal(sentimentAt(snap,(bucket+1)*SENTIMENT_BUCKET,'EUR/USD').upProbability, probability(2,1));
  assert.equal(sentimentAt(snap,(bucket+1)*SENTIMENT_BUCKET,'BTC').upProbability,0.5);
  // Conflicting later cron never replaces the first seal.
  await DB.prepare('UPDATE games SET state = ? WHERE user_id = 1').bind(JSON.stringify({marketMode:'shared',account:{positions:[]}})).run();
  Date.now=()=>t+5000;
  try { await captureSentiment({DB},t+5000); } finally { Date.now=oldNow; }
  assert.deepEqual((await loadSnapshots({DB},(bucket+1)*SENTIMENT_BUCKET,(bucket+1)*SENTIMENT_BUCKET)).get(bucket),snap.get(bucket));
  // A late seal of a past bucket is forbidden, even if the row is absent.
  await DB.prepare('DELETE FROM sentiment_snapshots WHERE bucket = ?').bind(bucket).run();
  Date.now=()=>t+SENTIMENT_BUCKET*1500;
  try { await captureSentiment({DB},t+5000); } finally { Date.now=oldNow; }
  assert.equal((await loadSnapshots({DB},(bucket+1)*SENTIMENT_BUCKET,(bucket+1)*SENTIMENT_BUCKET)).size,0);
});
test('future counts only affect their future bucket; bounded inverse tilt and old goldens', () => {
  const prev=bucket, active=(prev+1)*SENTIMENT_BUCKET;
  const counts=Object.fromEntries(Object.keys(PAIRS).map(p=>[p,{long:5,short:0}]));
  const snap=new Map([[prev,counts]]);
  const old=SENTIMENT_START-5;
  assert.equal(sharedPricer(secret,snap)(old,'EUR/USD'),sharedPrice(secret,old,'EUR/USD'));
  assert.equal(sharedPricer(secret,snap)(active-1,'BTC'),sharedPrice(secret,active-1,'BTC'));
  assert.ok(sentimentLog(snap,active,'BTC') === 0);
  assert.ok(sentimentLog(snap,active+1,'BTC',0.01)>0);
  assert.ok(sentimentLog(snap,active+1,'BTC',0.99)<0);
  assert.ok(Math.abs(sentimentLog(snap,active+100,'BTC',0.01))<=0.0008+1e-12);
  const p=sharedPricer(secret,snap);
  const mac=hmacKey(Uint8Array.from(secret.match(/../g),x=>parseInt(x,16)));
  const d=mac(new TextEncoder().encode(`fxweb/shared/hmac-sha256-causal-v1|sentiment-direction|${active}|EUR/USD`));
  const draw=(d[0]*16777216+d[1]*65536+d[2]*256+d[3])/4294967296;
  assert.equal(p(active+100,'EUR/USD'),sharedPrice(secret,active+100,'EUR/USD')*Math.exp(sentimentLog(snap,active+100,'EUR/USD',draw)));
  assert.equal(makeSharedMarket(secret,active+100,{history:1,sentiment:snap}).prices.BTC,p(active+100,'BTC'));
  assert.equal(probability(1,1),0.5);
  assert.equal(probability(5,0),0.45);
  assert.equal(probability(0,5),0.55);
  assert.equal(probability(2,0),0.5);
});
