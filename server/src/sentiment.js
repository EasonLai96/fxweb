// 玩家持倉每帳號、每商品一票。同商品多空張數互抵；平手棄權。
import { PAIRS, isCrypto, isEtf } from '../../market.mjs';
export const SENTIMENT_START = Date.UTC(2026, 9, 16, 6, 0, 0) / 1500;
export const SENTIMENT_BUCKET = 200; // five minutes
export const MIN_VOTERS = 3;
const keys = Object.keys(PAIRS);
export function probability(long, short) {
  const total = long + short;
  return total < MIN_VOTERS ? 0.5 : 0.5 - 0.05 * (long - short) / total;
}
export function parseSnapshots(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!Number.isSafeInteger(r.bucket)) continue;
    try {
      const obj = JSON.parse(r.counts), counts = {};
      for (const p of keys) {
        const c = obj[p];
        counts[p] = { long: Number.isSafeInteger(c?.long) && c.long >= 0 ? c.long : 0,
          short: Number.isSafeInteger(c?.short) && c.short >= 0 ? c.short : 0 };
      }
      out.set(r.bucket, counts);
    } catch { /* corrupted rows must not modify a price */ }
  }
  return out;
}
export function sentimentAt(snapshots, tick, pair) {
  const bucket = Math.floor(tick / SENTIMENT_BUCKET), c = snapshots?.get(bucket - 1)?.[pair];
  const long = c?.long || 0, short = c?.short || 0;
  return { long, short, upProbability: probability(long, short), snapshotBucket: c ? bucket - 1 : null };
}
// Draw one secret direction per bucket at its first tick. UpProbability is the
// actual probability of this ADDITIONAL move, not a prediction of total returns.
// The bump starts/ends at zero, avoiding a permanent drift or boundary jump.
export function sentimentLog(snapshots, tick, pair, draw = 0.5) {
  if (tick < SENTIMENT_START) return 0;
  const { long, short, upProbability } = sentimentAt(snapshots, tick, pair);
  if (long + short < MIN_VOTERS) return 0;
  const amplitude = isCrypto(pair) ? 0.0008 : isEtf(pair) ? 0.0003 : 0.0002;
  const x = (tick % SENTIMENT_BUCKET) / SENTIMENT_BUCKET;
  return amplitude * (draw < upProbability ? 1 : -1) * Math.sin(Math.PI * x);
}
export async function captureSentiment(env, time) {
  const bucket = Math.floor(time / (SENTIMENT_BUCKET * 1500));
  if (bucket * SENTIMENT_BUCKET < SENTIMENT_START - SENTIMENT_BUCKET) return false;
  // Aggregate on cron, never in the hot polling path. Dormant or legacy accounts excluded.
  const result = await env.DB.prepare(`WITH votes AS (
    SELECT g.user_id AS uid, j.value ->> '$.pair' AS pair,
      SUM(CAST(j.value ->> '$.side' AS INTEGER)) AS net
    FROM games g, json_each(g.state, '$.account.positions') j
    WHERE json_extract(g.state, '$.marketMode') = 'shared' AND g.updated_at >= ?
    GROUP BY g.user_id, j.value ->> '$.pair'
  ) SELECT pair, SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END) AS longs,
      SUM(CASE WHEN net < 0 THEN 1 ELSE 0 END) AS shorts
    FROM votes WHERE net <> 0 GROUP BY pair`).bind(time - 86400000).all();
  const counts = Object.fromEntries(keys.map(p => [p, { long: 0, short: 0 }]));
  for (const r of result.results || []) if (Object.hasOwn(counts, r.pair))
    counts[r.pair] = { long: r.longs, short: r.shorts };
  // Atomic deadline forbids a late cron from backfilling a previously served price.
  await env.DB.prepare(`INSERT INTO sentiment_snapshots (bucket, counts, captured_at)
    SELECT ?, ?, ? WHERE ? < (? + 1) * ? * 1500
    ON CONFLICT(bucket) DO NOTHING`).bind(bucket, JSON.stringify(counts), time, Date.now(), bucket, SENTIMENT_BUCKET).run();
  return true;
}
export async function loadSnapshots(env, fromTick, toTick) {
  if (toTick < SENTIMENT_START) return new Map();
  const lo = Math.floor(Math.max(0, fromTick) / SENTIMENT_BUCKET) - 1;
  const hi = Math.floor(toTick / SENTIMENT_BUCKET) - 1;
  const rows = await env.DB.prepare('SELECT bucket, counts FROM sentiment_snapshots WHERE bucket BETWEEN ? AND ? ORDER BY bucket')
    .bind(lo, hi).all();
  return parseSnapshots(rows.results);
}
