import test from 'node:test';import assert from 'node:assert/strict';
import {createReadBackoff} from '../cloud.mjs';
test('read backoff escalates, respects platform retry minimum and resets only on success',()=>{const b=createReadBackoff();let t=0;for(const wait of [15000,30000,60000,120000,300000,300000]){const until=b.fail({},t);assert.equal(until-t,wait);assert.equal(b.ready(until-1),false);assert.equal(b.ready(until),true);t=until;}b.success();assert.equal(b.ready(0),true);assert.equal(b.fail({retryAfterMs:400000},0),400000);});
