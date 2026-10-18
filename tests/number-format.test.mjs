import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAmount, compactPercent } from '../number-format.mjs';
test('大額用中文單位，保留符號由呼叫端處理',()=>{
 assert.equal(compactAmount(3.69455509433438e22),'369.46 垓');
 assert.equal(compactAmount(-3.69455509433438e22),'369.46 垓');
 assert.equal(compactAmount(1e24),'1 秭');
 assert.equal(compactAmount(1e8),'1 億');
 assert.equal(compactAmount(1234.5),'1,234.50');
 assert.equal(compactAmount(9.999999e19),'1 垓');
});
test('報酬率不再顯示 e20%',()=>{
 assert.equal(compactPercent(3.69455509433438e18),'+3.69 垓%');
 assert.equal(compactPercent(-0.1234),'-12.34%');
 assert.equal(compactPercent(Infinity),'—');
 assert.equal(compactAmount(NaN),'—');
 assert.equal(compactAmount(1e60),'1.00 × 10^60');
});
