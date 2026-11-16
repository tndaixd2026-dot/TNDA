// 本機測試用的 PGlite 沒有 Supabase 的 safeupdate 擴充，這裡另外檢查：每個 DELETE／UPDATE 都要有 WHERE。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

describe('schema.sql 能在 Supabase 執行', () => {
  it('每個 DELETE、UPDATE 都有 WHERE（Supabase 的 safeupdate 會擋下沒有 WHERE 的語句）', () => {
    const stmts = sql.match(/\b(delete\s+from|update)\s+invest\.[\s\S]*?;/gi) ?? [];
    expect(stmts.length).toBeGreaterThan(10);
    const bad = stmts.filter((s) => !/\bwhere\b/i.test(s));
    expect(bad).toEqual([]);
  });
});
