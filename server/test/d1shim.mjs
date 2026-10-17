// 用 node:sqlite 模擬 Cloudflare D1 的 API（prepare/bind/first/run/all/batch），只供本機測試。
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// 傳入 migrations 資料夾（依檔名順序全部執行）或單一 .sql 檔
// Windows 上 new URL(..).pathname 會變成 "/C:/..."，去掉開頭那條斜線才是合法路徑。
function normalizePath(p) {
  return typeof p === "string" && /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p;
}
export function createD1(migrationsPath) {
  const migrations = normalizePath(migrationsPath);
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = statSync(migrations).isDirectory() ? readdirSync(migrations).filter(f => f.endsWith(".sql")).sort().map(f => join(migrations, f)) : [migrations];
  for (const f of files) db.exec(readFileSync(f, "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
    // 和 D1 的 batch 一樣：SELECT/RETURNING 回傳 { results }，寫入回傳 { meta }。
    _exec() {
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql))
        return { results: db.prepare(sql).all(...args), success: true, meta: { changes: 0 } };
      const r = db.prepare(sql).run(...args);
      return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
    },
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { const out = list.map(s => s._exec()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    raw: db,
  };
}
