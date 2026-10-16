import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { sha256, hmacSha256, createMarketState, createMarket, stepMarket, publicNews, NEWS_SETTLE } from '../../market.mjs';
import { newGame, ensureSecureGame, advance, view, openOrder, closeOrder, TICK_MS, MAX_CATCHUP } from '../src/game.js';
const bytes = s => new TextEncoder().encode(s);
const hex = b => Buffer.from(b).toString('hex');
const clone = o => JSON.parse(JSON.stringify(o));
const start = 1800000000000;
const secret = '0123456789abcdef'.repeat(4);
function fixture() { const g = newGame(start); g.market = createMarketState(undefined, { secret }); return g; }

test('SHA256 FIPS vectors, million a, and padding boundaries', () => {
  assert.equal(hex(sha256(bytes(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(bytes('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(sha256(bytes('a'.repeat(1000000)))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  for (const n of [1,31,55,56,63,64,65,119,120,127,128,129,4096]) {
    const data=randomBytes(n); assert.equal(hex(sha256(data)),createHash('sha256').update(data).digest('hex'));
  }
});
test('HMAC RFC4231 and Node crypto differential vectors', () => {
  const cases = [
    [Buffer.alloc(20,0x0b),bytes('Hi There'),'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'],
    [bytes('Jefe'),bytes('what do ya want for nothing?'),'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'],
    [Buffer.alloc(131,0xaa),bytes('Test Using Larger Than Block-Size Key - Hash Key First'),'60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54'],
  ];
  for(const [k,m,v] of cases) assert.equal(hex(hmacSha256(k,m)),v);
  for(const kl of [0,1,32,63,64,65,131]) for(const ml of [0,55,56,64,200]) {
    const k=randomBytes(kl),m=randomBytes(ml);
    assert.equal(hex(hmacSha256(k,m)),createHmac('sha256',k).update(m).digest('hex'));
  }
});
test('server secrets are independent 256bit and HMAC output is used directly', () => {
  const a=newGame(start),b=newGame(start);
  assert.match(a.market.secret,/^[0-9a-f]{64}$/); assert.notEqual(a.market.secret,b.market.secret);
  assert.equal(a.market.r,undefined); assert.notDeepEqual(a.market.prices,b.market.prices);
  const ms=createMarketState(undefined,{secret,warmup:0});
  const d=createHmac('sha256',Buffer.from(secret,'hex')).update('fxweb/market/hmac-sha256-v1|0|0').digest();
  Object.keys(ms.phase).slice(0,8).forEach((p,i)=>assert.equal(ms.phase[p],d.readUInt32BE(i*4)/4294967296*Math.PI*2));
  assert.notDeepEqual(ms.phase,createMarketState(undefined,{secret:secret.slice(0,-1)+'0',warmup:0}).phase);
  assert.throws(()=>createMarketState(1,{secret:'1234'}));
});
test('JSON checkpoints reproduce prices, news, equity and liquidation times regardless of polling', () => {
  const g=fixture(); openOrder(g,{pair:'EUR/USD',side:1,leverage:10,margin:500},start);
  // Force an already-adverse position so event/time equivalence is non-vacuous.
  g.account.positions[0].entry *= 1.2;
  const a=clone(g),b=clone(g),end=start+550*TICK_MS+721;
  const one=advance(a,end),events=[];
  for(let i=1;i<=550;i++){events.push(...advance(b,start+i*TICK_MS+(i%7)*41).events);b.market=clone(b.market);}
  assert.deepEqual(b,a);assert.deepEqual(events,one.events);
  assert.ok(one.events.some(e=>e.type==='liquidated'));
  const c=clone(g);assert.deepEqual(advance(c,end),one);assert.deepEqual(c,a);
});
test('600 tick batch retains all offline risk and fractional time; stale-price trades rejected', () => {
  const a=fixture(),b=clone(a),end=start+(MAX_CATCHUP*2+3)*TICK_MS+777;
  const first=advance(a,end);
  assert.equal(first.steps,MAX_CATCHUP);assert.equal(first.pendingSteps,MAX_CATCHUP+3);
  assert.equal(a.lastStepAt,start+MAX_CATCHUP*TICK_MS);
  assert.equal(view(a,-1,[],end).catchingUp,true);assert.equal(view(a,-1,[],end).remainingTicks,MAX_CATCHUP+3);
  assert.throws(()=>openOrder(a,{pair:'EUR/USD',side:1,leverage:10,margin:20},end),/補算/);
  assert.throws(()=>closeOrder(a,1,end),/補算/);
  assert.equal(advance(a,end).pendingSteps,3);assert.equal(advance(a,end).pendingSteps,0);
  for(let i=1;i<=MAX_CATCHUP*2+3;i++)advance(b,start+i*TICK_MS);
  assert.deepEqual(a,b);assert.equal(view(a,-1,[],end).nextTickIn,TICK_MS-777);
  const saved=clone(a);assert.equal(advance(a,start).steps,0);assert.deepEqual(a,saved);
});
test('public full and delta views expose neither secret state nor unsettled reversal', () => {
  const g=fixture();advance(g,start+400*TICK_MS);
  g.market.news.push({step:g.market.step,pair:'EUR/USD',text:'test',claimed:1,reversed:true});
  for(const since of [-1,g.market.step-1]){
    const v=view(g,since,[],g.lastStepAt),text=JSON.stringify(v);
    assert.ok(!text.includes(g.market.secret));
    for(const key of ['secret','rngVersion','phase','bias','r','key','words'])assert.ok(!text.includes('"'+key+'":'));
    assert.equal(v.news.at(-1).reversed,null);
  }
  const n=g.market.news.at(-1);
  assert.equal(publicNews(n,n.step+NEWS_SETTLE-1).reversed,null);
  assert.equal(publicNews(n,n.step+NEWS_SETTLE).reversed,true);
});
test('legacy migration preserves balances and prices, removes predictable future state', () => {
  const g=fixture();g.market=createMarketState(42);const old=clone(g);
  assert.equal(ensureSecureGame(g),true);assert.deepEqual(g.account,old.account);
  assert.deepEqual(g.market.prices,old.market.prices);assert.deepEqual(g.market.candles,old.market.candles);
  assert.equal(g.market.r,undefined);assert.notDeepEqual(g.market.phase,old.market.phase);
  assert.deepEqual(g.market.news,[]);assert.ok(Object.values(g.market.bias).every(b=>b.left===0));
  assert.equal(ensureSecureGame(g),false);
  g.market.secret='bad';assert.throws(()=>ensureSecureGame(g));assert.throws(()=>advance(g,start+TICK_MS));
});
test('guest mulberry32 remains deterministic and serializable without secrets', () => {
  const a=createMarket(42),b=createMarket(42);
  for(let i=0;i<200;i++){a.tick();b.tick();}assert.deepEqual(a.state,b.state);assert.equal(a.state.secret,undefined);
  const c=clone(a.state);a.tick();stepMarket(c);assert.deepEqual(a.state,c);
});
