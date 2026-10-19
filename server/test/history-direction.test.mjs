import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../engine.mjs';
import { newGame, view } from '../src/game.js';

for (const side of [1, -1]) {
  test(`full and partial close retain direction ${side}`, () => {
    const a = E.createAccount(10000);
    const r = E.openPosition(a, {'EUR/USD':1}, {pair:'EUR/USD',side,notional:1000,leverage:5,time:1000});
    assert.ok(r.ok);
    E.closePositionPartial(a,r.position.id,1.01,2000,0.5);
    E.closePosition(a,r.position.id,1.02,3000);
    assert.deepEqual(a.log.filter(l=>l.type==='close'||l.type==='partial_close').map(l=>l.side),[side,side]);
  });
}
test('server history includes partial closes and recovers legacy direction without mutating data', () => {
  const now=1800000000000, secret='0123456789abcdef'.repeat(4);
  const g=newGame(now,secret);
  g.account.log=[
    {type:'open',id:1,pair:'BTC',side:-1,t:now-3},
    {type:'partial_close',id:1,pair:'BTC',price:100,pnl:10,t:now-2},
    {type:'close',id:1,pair:'BTC',price:100,pnl:20,t:now-1},
    {type:'close',id:2,pair:'BTC',price:100,pnl:30,t:now}
  ];
  const log=view(g,-1,[],now,secret).account.log;
  assert.equal(log.length,3);
  assert.equal(log[0].type,'partial_close');
  assert.equal(log[0].side,-1);assert.equal(log[1].side,-1);
  assert.equal(log[2].side,undefined);
  assert.equal(g.account.log[1].side,undefined);
});
