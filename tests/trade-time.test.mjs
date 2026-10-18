import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTradeTime } from '../trade-time.mjs';

test('結算時間包含完整日期與秒數，個位數補零', () => {
  const t = new Date(2026, 9, 17, 3, 4, 5, 987).getTime();
  assert.equal(formatTradeTime(t), '2026-10-17 03:04:05');
});
test('缺少或無效時間不顯示假日期', () => {
  for (const t of [undefined, null, '', '123', NaN, Infinity, 9e99]) {
    assert.equal(formatTradeTime(t), '時間未記錄');
  }
});
test('Unix 零點也是有效時間', () => {
  assert.match(formatTradeTime(0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
