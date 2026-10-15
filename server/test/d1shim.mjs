// 用 node:sqlite 模擬 Cloudflare D1 的 API（prepare/bind/first/run/all/batch），只供本機測試。
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// 傳入 migrations 資料夾（依檔名順序全部執行）或單一 .sql 檔
export function createD1(migrations) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = statSync(migrations).isDirectory() ? readdirSync(migrations).filter(f => f.endsWith(".sql")).sort().map(f => join(migrations, f)) : [migrations];
  for (const f of files) db.exec(readFileSync(f, "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    _exec() { return db.prepare(sql).run(...args); },
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { const out = list.map(s => s._exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    raw: db,
  };
}
