// 本機版資料庫：用 PGlite（WebAssembly 版的 Postgres）執行和 Supabase 完全相同的 supabase/schema.sql，
// 並模擬 Supabase（PostgREST）的 RPC 呼叫方式。用於本機開發、自動化測試，以及現場備援（筆電＋熱點）。
import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RosterEntry } from '../shared/types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_SQL = readFileSync(join(root, 'supabase', 'schema.sql'), 'utf8');

export interface DbOptions {
  /** null = 只在記憶體（測試用） */
  dataDir: string | null;
  adminPassword: string;
  /** 暗盤長度；不給就用資料庫裡的設定（預設 5 分鐘） */
  darkMs?: number;
  /** 名單是空的時候放入的假資料 */
  seed?: RosterEntry[];
  /** 假名單學生的密碼（只在放入 seed 名單時設定） */
  seedPassword?: string;
  /** 假的業師帳號（密碼 TNDA） */
  seedMentors?: string[];
  /** 假的各組 slogan：「場次|組別」→ slogan */
  seedSlogans?: Record<string, string>;
  /** 假的出席紀錄：只在名單是空的、正在放入 seed 名單時一起放入 */
  seedAttendance?: { course: string; name: string; week: number; status: string }[];
}

export class RpcError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Signature {
  args: string[];
  types: string[];
}

export type Db = Awaited<ReturnType<typeof openDb>>;

export async function openDb(opts: DbOptions) {
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  const pg = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
  await pg.waitReady;
  await pg.exec(SCHEMA_SQL);
  await pg.query('select invest.set_admin_password($1)', [opts.adminPassword]);
  if (opts.darkMs) await pg.query('update invest.config set dark_ms = $1 where id = 1', [opts.darkMs]);
  if (opts.seed?.length) {
    const { rows } = await pg.query<{ n: number }>('select count(*)::int as n from invest.roster');
    if (rows[0].n === 0) {
      await pg.query(
        `insert into invest.roster (course, name_key, name, grp)
         select e ->> 'course', invest.name_key(e ->> 'name'), invest.norm_name(e ->> 'name'), e ->> 'group'
         from jsonb_array_elements($1::jsonb) e
         on conflict do nothing`,
        [JSON.stringify(opts.seed)],
      );
      await pg.query('select invest.ensure_student_accounts()');
      if (opts.seedPassword) {
        await pg.query(
          `select invest.set_password(a.name_key, $1) from invest.account a where a.role = 'student' and a.pw_hash is null`,
          [opts.seedPassword],
        );
      }
      for (const m of opts.seedMentors ?? []) {
        await pg.query(
          `insert into invest.account (name_key, name, role) values (invest.name_key($1), invest.norm_name($1), 'mentor') on conflict do nothing`,
          [m],
        );
        await pg.query(`select invest.set_password(invest.name_key($1), 'TNDA')`, [m]);
      }
      for (const [k, slogan] of Object.entries(opts.seedSlogans ?? {})) {
        const [course, grp] = k.split('|');
        await pg.query(
          `insert into invest.group_info (course, grp, slogan) values ($1, $2, $3) on conflict (course, grp) do update set slogan = excluded.slogan`,
          [course, grp, slogan],
        );
      }
      if (opts.seedAttendance?.length) {
        await pg.query(
          `insert into invest.attendance (course, name_key, week, status)
           select e ->> 'course', invest.name_key(e ->> 'name'), (e ->> 'week')::int, e ->> 'status'
           from jsonb_array_elements($1::jsonb) e
           on conflict do nothing`,
          [JSON.stringify(opts.seedAttendance)],
        );
      }
    }
  }

  // 讀出 public.invest_* 函式的參數，模擬 PostgREST 的具名參數呼叫
  const sigRows = await pg.query<{ name: string; args: string[] | null; types: string[] }>(
    `select p.proname as name, p.proargnames as args,
            array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'invest\\_%'`,
  );
  const signatures = new Map<string, Signature>();
  for (const r of sigRows.rows) signatures.set(r.name, { args: r.args ?? [], types: r.types });

  async function rpc(fn: string, body: unknown): Promise<unknown> {
    const sig = signatures.get(fn);
    if (!sig) throw new RpcError(404, `找不到函式 ${fn}`);
    const params = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const keys = Object.keys(params);
    const parts: string[] = [];
    const values: unknown[] = [];
    for (const key of keys) {
      const idx = sig.args.indexOf(key);
      if (idx < 0) throw new RpcError(404, `函式 ${fn} 沒有參數 ${key}`);
      const type = sig.types[idx];
      const v = params[key];
      values.push(v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
      parts.push(`${key} => $${values.length}::${type}`);
    }
    try {
      const { rows } = await pg.query<{ r: unknown }>(`select public.${fn}(${parts.join(', ')}) as r`, values);
      return rows[0]?.r ?? null;
    } catch (err) {
      throw new RpcError(400, (err as Error).message);
    }
  }

  return {
    rpc,
    pg,
    async close() {
      await pg.close();
    },
  };
}
