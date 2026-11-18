// 端對端：用 PGlite 跑真正的 supabase/schema.sql，透過和 Supabase 相同的 RPC 網址（/rest/v1/rpc/…）驗證所有規則。
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { openDb, type Db } from '../server/db.ts';
import { BUDGET, computeResults } from '../shared/rules.ts';
import type { AdminOverview, HistoryPoint, Lot, MeState, PublicState, Results, RosterEntry } from '../shared/types.ts';

const W = 10_000;
const STUDENT_PW = '0101';
/** 登入後的憑證，依「伺服器｜姓名」快取 */
const tokens = new Map<string, string>();
// 管理員密碼可以是中文
const PW = '測試老師';

// 甲同時修兩堂課，且兩堂課組別不同
const ROSTER: RosterEntry[] = [
  { name: '甲', course: 'wed', group: '第1組' },
  { name: '乙', course: 'wed', group: '第2組' },
  { name: '丙', course: 'wed', group: '第3組' },
  { name: '甲', course: 'thu', group: '第2組' },
  { name: '丁', course: 'thu', group: '第1組' },
  { name: '戊', course: 'thu', group: '第3組' },
];

let db: Db;
let server: Server;
let base = '';

async function startServer(d: Db): Promise<{ server: Server; base: string }> {
  const s = createApp(d, { staticDir: null });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  db = await openDb({ dataDir: null, adminPassword: PW });
  ({ server, base } = await startServer(db));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await db.close();
});

/** 每個測試從乾淨的資料開始 */
async function reset(opts: { darkMs?: number; roster?: RosterEntry[] } = {}) {
  await db.pg.exec(`
    truncate invest.alloc, invest.lot, invest.presence, invest.history, invest.roster, invest.attendance, invest.session restart identity;
    delete from invest.account a where a.role <> 'guest';
    truncate invest.group_info;
    truncate invest.slide restart identity;
    insert into invest.slide (pos, kind, title, subtitle, body) values
      (1, 'title', '業師總結', '期末提報「這個殼以！」', ''), (2, 'recap', '數字回顧', '', ''), (3, 'text', '謝謝大家', 'TNDA · Next D', '');
    update invest.course set phase = 'pending', opened_at = null, dark_at = null, dark_ends_at = null,
      closed_at = null, dark_history_id = null, closed_from = null, dark_left_ms = null, results = null, revealed = false,
      presenting = null, presenting_at = null, presented = '{}'::jsonb;
    update invest.config set active = 'wed', board_visible = true, stage_mode = 'market', stage_step = 0, version = version + 1;
  `);
  await db.pg.query('update invest.config set dark_ms = $1 where id = 1', [opts.darkMs ?? 60_000]);
  await db.pg.query(
    `insert into invest.roster (course, name_key, name, grp)
     select e ->> 'course', invest.name_key(e ->> 'name'), invest.norm_name(e ->> 'name'), e ->> 'group'
     from jsonb_array_elements($1::jsonb) e`,
    [JSON.stringify(opts.roster ?? ROSTER)],
  );
  // 測試用：每位學生的密碼都是 0101
  await db.pg.exec(`select invest.ensure_student_accounts();
    select invest.set_password(a.name_key, '${STUDENT_PW}') from invest.account a where a.role = 'student';`);
  tokens.clear();
}
beforeEach(() => reset());

async function call<T = Record<string, unknown>>(fn: string, args: Record<string, unknown> = {}, at = base): Promise<T> {
  const res = await fetch(`${at}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}
type Err = { error?: string; message?: string };
const state = (at = base) => call<PublicState>('invest_state', {}, at);
/** 用姓名＋密碼登入，回傳憑證；登入失敗回傳錯誤 */
async function login(name: string, at = base, password = STUDENT_PW): Promise<{ token?: string } & Err> {
  const k = `${at}|${name}`;
  const cached = tokens.get(k);
  if (cached) return { token: cached };
  const r = await call<{ token?: string; me?: MeState } & Err>('invest_login', { name, password }, at);
  if (r.token) tokens.set(k, r.token);
  return r;
}
const me = async (name: string, at = base) => {
  const l = await login(name, at);
  if (!l.token) return l as MeState & Err;
  return call<MeState & Err>('invest_me', { token: l.token }, at);
};
/** 頒獎揭曉某一場（測試結算時直接公開，頒獎流程另外測） */
async function reveal(course: string) {
  await db.pg.query('update invest.course set revealed = true where course = $1', [course]);
  await db.pg.exec('update invest.config set version = version + 1 where id = 1');
}
const invest = async (name: string, grp: string, amount: number, course = 'wed') => {
  const l = await login(name);
  if (!l.token) return l as MeState & Err;
  return call<MeState & Err>('invest_invest', { token: l.token, course, grp, amount });
};
const phase = (course: string, action: string, at = base) =>
  call<AdminOverview & Err>('invest_admin_phase', { pw: PW, course, action }, at);
const adminResults = (course: string) => call<Results>('invest_admin_results', { pw: PW, course });
const history = () => call<Record<string, HistoryPoint[]>>('invest_history', {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const present = (course: string, grp: string | null) => call<AdminOverview & Err>('invest_admin_present', { pw: PW, course, grp });
/** 測試用：讓某組「已經開始報告 elapsedMs 毫秒」（null = 沒有組在報告） */
async function presentAt(grp: string | null, elapsedMs: number, course = 'wed') {
  await db.pg.query(
    `update invest.course set presenting = $2::text,
       presenting_at = case when $2::text is null then null else now() - make_interval(secs => $3::double precision / 1000) end
     where course = $1`,
    [course, grp, elapsedMs],
  );
}
/** 資料庫裡每個人的每一筆投資（給 TypeScript 參考實作比對） */
async function lotsByName(course = 'wed'): Promise<Record<string, Lot[]>> {
  const { rows } = await db.pg.query<{ name: string; grp: string; amount: string; weight: string; delay_ms: string }>(
    `select r.name, l.grp, l.amount, l.weight, l.delay_ms from invest.lot l
     join invest.roster r on r.course = l.course and r.name_key = l.name_key where l.course = $1 order by l.id`,
    [course],
  );
  const out: Record<string, Lot[]> = {};
  for (const r of rows) (out[r.name] ??= []).push({ group: r.grp, amount: Number(r.amount), weight: Number(r.weight), delayMs: Number(r.delay_ms) });
  return out;
}

describe('登入與名單', () => {
  it('只認名單上的姓名（去空白、全形半形），回傳兩堂課各自的組別與錢包', async () => {
    const m = await me(' 甲　');
    expect(m.name).toBe('甲');
    expect(m.courses.wed).toMatchObject({ group: '第1組', remaining: 100 * W, alloc: {} });
    expect(m.courses.thu).toMatchObject({ group: '第2組', remaining: 100 * W, alloc: {} });
    expect((await me('路人')).error).toBe('not_in_roster');
  });
});

describe('投資規則（全部在資料庫端驗證）', () => {
  it('不能投自己那組，也不能投其他堂課或不存在的組', async () => {
    await phase('wed', 'open');
    expect((await invest('甲', '第1組', 10 * W)).error).toBe('own_group');
    expect((await invest('甲', '第9組', 10 * W)).error).toBe('unknown_group');
    expect((await invest('丁', '第2組', 10 * W)).error).toBe('not_in_course');
    expect((await invest('路人', '第2組', 10 * W)).error).toBe('not_in_roster');
    expect((await me('甲')).courses.wed?.alloc).toEqual({});
  });

  it('沒有單一組上限：可以 all in 100 萬，超過 100 萬才擋；金額必須是非負整數、最小 1 元', async () => {
    await phase('wed', 'open');
    expect((await invest('甲', '第2組', 60 * W)).error).toBeUndefined();
    expect((await invest('甲', '第2組', BUDGET)).error).toBeUndefined();
    expect((await invest('甲', '第2組', BUDGET + 1)).error).toBe('over_budget');
    expect((await invest('甲', '第2組', -1)).error).toBe('bad_amount');
    expect((await invest('甲', '第2組', 1.5)).error).toBe('bad_amount');
    expect((await invest('甲', '第3組', 1)).error).toBe('over_budget');
    expect((await invest('甲', '第2組', 50 * W)).courses.wed?.alloc).toEqual({ 第2組: 50 * W });
    expect((await invest('甲', '第3組', 1)).courses.wed?.alloc).toEqual({ 第2組: 50 * W, 第3組: 1 });
  });

  it('未開盤不能投；開盤中與暗盤可以；封盤後不能投（撤回也不行）', async () => {
    expect((await invest('甲', '第2組', 10 * W)).error).toBe('not_open');
    await phase('wed', 'open');
    expect((await invest('甲', '第2組', 10 * W)).error).toBeUndefined();
    await phase('wed', 'dark');
    expect((await invest('甲', '第2組', 20 * W)).error).toBeUndefined();
    await phase('wed', 'close');
    expect((await invest('甲', '第2組', 30 * W)).error).toBe('closed');
    expect((await invest('甲', '第2組', 0)).error).toBe('closed');
    expect((await me('甲')).courses.wed?.alloc).toEqual({ 第2組: 20 * W });
  });

  it('追加、撤回、調整後餘額正確', async () => {
    await phase('wed', 'open');
    const wallet = (m: MeState) => {
      const c = m.courses.wed!;
      return [c.alloc, c.invested, c.remaining];
    };
    expect(wallet(await invest('甲', '第2組', 30 * W))).toEqual([{ 第2組: 30 * W }, 30 * W, 70 * W]);
    expect(wallet(await invest('甲', '第2組', 50 * W))).toEqual([{ 第2組: 50 * W }, 50 * W, 50 * W]);
    expect(wallet(await invest('甲', '第3組', 50 * W))).toEqual([{ 第2組: 50 * W, 第3組: 50 * W }, 100 * W, 0]);
    expect(wallet(await invest('甲', '第2組', 20 * W))).toEqual([{ 第2組: 20 * W, 第3組: 50 * W }, 70 * W, 30 * W]);
    expect(wallet(await invest('甲', '第3組', 0))).toEqual([{ 第2組: 20 * W }, 20 * W, 80 * W]);
    const totals = Object.fromEntries((await state()).courses.wed.groups.map((g) => [g.id, g.total]));
    expect(totals).toEqual({ 第1組: 0, 第2組: 20 * W, 第3組: 0 });
  });

  it('餘額不足時擋下（四組的課）', async () => {
    await reset({ roster: [
      { name: '己', course: 'thu', group: 'A' },
      { name: '庚', course: 'thu', group: 'B' },
      { name: '辛', course: 'thu', group: 'C' },
      { name: '壬', course: 'thu', group: 'D' },
    ] });
    await phase('thu', 'open');
    await invest('己', 'B', 50 * W, 'thu');
    await invest('己', 'C', 40 * W, 'thu');
    expect((await invest('己', 'D', 20 * W, 'thu')).error).toBe('over_budget');
    expect((await invest('己', 'D', 10 * W, 'thu')).courses.thu?.remaining).toBe(0);
  });

  it('同時大量下單也不會超過餘額（資料庫逐筆鎖定）', async () => {
    await phase('wed', 'open');
    // 甲同時對兩組各送 10 筆 60 萬：只有其中一組成功、總共不超過 100 萬
    const reqs = Array.from({ length: 20 }, (_, i) => invest('甲', i % 2 ? '第2組' : '第3組', 60 * W));
    await Promise.all(reqs);
    const m = await me('甲');
    expect(m.courses.wed?.invested).toBe(60 * W);
    // 再同時送 10 筆超額的，全部被擋
    const over = await Promise.all(Array.from({ length: 10 }, () => invest('乙', '第1組', BUDGET + 1)));
    expect(over.every((r) => r.error === 'over_budget')).toBe(true);
  });

  it('重疊學生上下半場錢包獨立：各 100 萬，互不相通', async () => {
    await phase('wed', 'open');
    await phase('thu', 'open');
    await invest('甲', '第2組', 50 * W, 'wed');
    await invest('甲', '第3組', 50 * W, 'wed');
    let m = await me('甲');
    expect(m.courses.wed?.remaining).toBe(0);
    expect(m.courses.thu).toMatchObject({ remaining: 100 * W, alloc: {} });
    // 週四甲是第2組：可以投第1、3組，不能投第2組（週三的第2組卻可以投）
    expect((await invest('甲', '第1組', 50 * W, 'thu')).error).toBeUndefined();
    expect((await invest('甲', '第3組', 50 * W, 'thu')).error).toBeUndefined();
    expect((await invest('甲', '第2組', 10 * W, 'thu')).error).toBe('own_group');
    m = await me('甲');
    expect(m.courses.wed).toMatchObject({ group: '第1組', alloc: { 第2組: 50 * W, 第3組: 50 * W }, remaining: 0 });
    expect(m.courses.thu).toMatchObject({ group: '第2組', alloc: { 第1組: 50 * W, 第3組: 50 * W }, remaining: 0 });
    await invest('甲', '第1組', 0, 'thu');
    m = await me('甲');
    expect(m.courses.thu?.remaining).toBe(50 * W);
    expect(m.courses.wed?.remaining).toBe(0);
    // 結算也分開：週三甲投完不倒扣；週四甲剩 50 萬 → 週四第2組倒扣
    await phase('wed', 'close');
    await phase('thu', 'close');
    expect((await adminResults('wed')).groups.find((g) => g.group === '第1組')!.deductions).toEqual([]);
    expect((await adminResults('thu')).groups.find((g) => g.group === '第2組')!.deductions).toEqual([{ name: '甲', unspent: 50 * W }]);
  });
});

describe('封盤結算', () => {
  it('未花完從自己那組倒扣（可為負），倍率與個人報酬正確，公開結果不含學生姓名', async () => {
    await phase('wed', 'open');
    await invest('甲', '第2組', 50 * W);
    await invest('甲', '第3組', 50 * W);
    await invest('乙', '第1組', 50 * W);
    await invest('乙', '第3組', 30 * W); // 乙剩 20 萬 → 第2組倒扣
    await me('丙'); // 丙有登入但沒投 → 第3組倒扣 100 萬
    await phase('wed', 'close');
    await reveal('wed');

    const r = await adminResults('wed');
    expect(r.groups.map((g) => [g.group, g.raw, g.penalty, g.final, g.rank, g.multiplier])).toEqual([
      ['第1組', 50 * W, 0, 50 * W, 1, 3],
      ['第2組', 50 * W, 20 * W, 30 * W, 2, 2],
      ['第3組', 80 * W, 100 * W, -20 * W, 3, 1.5],
    ]);
    expect(r.groups[1].deductions).toEqual([{ name: '乙', unspent: 20 * W }]);
    expect(r.groups[2].deductions).toEqual([{ name: '丙', unspent: 100 * W }]);
    expect(r.rocket).toEqual(['第1組']);
    // 甲 = 50×2 + 50×1.5 = 175 萬；乙 = 50×3 + 30×1.5 = 195 萬；丙沒投資不列入個人排名
    expect(r.investors.map((i) => [i.name, i.payout, i.rank])).toEqual([
      ['乙', 195 * W, 1],
      ['甲', 175 * W, 2],
    ]);
    expect(r.stockGods).toEqual(['乙']);
    expect((await me('甲')).courses.wed).toMatchObject({ result: { payout: 175 * W, rank: 2, of: 2 }, deducted: 0 });
    expect((await me('乙')).courses.wed?.deducted).toBe(20 * W);
    expect((await me('丙')).courses.wed).toMatchObject({ result: null, deducted: 100 * W });

    const s = await state();
    expect(s.courses.wed.results!.groups.map((g) => [g.group, g.penalty, g.final])).toEqual([
      ['第1組', 0, 50 * W],
      ['第2組', 20 * W, 30 * W],
      ['第3組', 100 * W, -20 * W],
    ]);
    expect(s.courses.wed.results!.stockGods).toEqual([{ name: '乙', group: '第2組', payout: 195 * W }]);
    expect(s.courses.wed.results!.investorCount).toBe(2);
    // 排行榜與結果只有各組金額（組員名單是頒獎展示用，另外放在 memberNames）
    const json = JSON.stringify({
      results: s.courses.wed.results,
      groups: s.courses.wed.groups.map(({ memberNames: _m, ...g }) => g),
    });
    expect(json).not.toContain('丙');
    expect(json).not.toContain('甲');
  });

  it('規格範例：兩組並列第 1 都是 ×3，下一組是第 3 名 ×1.5；個人報酬同分並列', async () => {
    await phase('wed', 'open');
    await invest('甲', '第2組', 50 * W);
    await invest('甲', '第3組', 30 * W); // 甲剩 20 → 第1組倒扣 20
    await invest('乙', '第1組', 50 * W);
    await invest('乙', '第3組', 30 * W); // 乙剩 20 → 第2組倒扣 20
    await invest('丙', '第1組', 50 * W);
    await invest('丙', '第2組', 50 * W);
    await phase('wed', 'close');
    const r = await adminResults('wed');
    expect(r.groups.map((g) => [g.group, g.final, g.rank, g.multiplier])).toEqual([
      ['第1組', 80 * W, 1, 3],
      ['第2組', 80 * W, 1, 3],
      ['第3組', 60 * W, 3, 1.5],
    ]);
    expect(r.rocket).toEqual(['第1組', '第2組']);
    // 丙 = 300；甲、乙 = 50×3 + 30×1.5 = 195（並列第 2）
    expect(r.investors.map((i) => [i.payout, i.rank])).toEqual([
      [300 * W, 1],
      [195 * W, 2],
      [195 * W, 2],
    ]);
    expect(r.stockGods).toEqual(['丙']);
  });

  it('全部同分時一飛沖天與股神都全部並列；最高的組即使是負數也得獎', async () => {
    await phase('thu', 'open');
    await invest('甲', '第1組', 50 * W, 'thu');
    await invest('甲', '第3組', 50 * W, 'thu');
    await invest('丁', '第2組', 50 * W, 'thu');
    await invest('丁', '第3組', 50 * W, 'thu');
    await invest('戊', '第1組', 50 * W, 'thu');
    await invest('戊', '第2組', 50 * W, 'thu');
    await phase('thu', 'close');
    const r = await adminResults('thu');
    expect(r.groups.every((g) => g.final === 100 * W && g.rank === 1 && g.multiplier === 3)).toBe(true);
    expect(r.rocket).toEqual(['第1組', '第2組', '第3組']);
    expect([...r.stockGods].sort()).toEqual(['丁', '戊', '甲'].sort());

    await reset();
    await phase('wed', 'open');
    await me('甲');
    await me('乙');
    await me('丙');
    await phase('wed', 'close');
    const neg = await adminResults('wed');
    // 三人都登入但沒投 → 三組都是 −100 萬，全部並列第 1 拿一飛沖天；沒人投資 → 股神從缺
    expect(neg.groups.every((g) => g.final === -100 * W && g.rank === 1)).toBe(true);
    expect(neg.rocket).toHaveLength(3);
    expect(neg.investors).toEqual([]);
    expect(neg.stockGods).toEqual([]);
  });

  it('缺席、整場沒登入的同學不倒扣；切換到這一場時頁面開著（查詢自己的資料）就算出席', async () => {
    await phase('thu', 'open');
    await me('丁'); // 還在週三，丁只修週四 → 不算出席週四
    expect((await state()).courses.thu.joined).toBe(0);
    await call('invest_admin_set_active', { pw: PW, course: 'thu' });
    await me('丁'); // 頁面開著，切換場次後回報 → 算出席
    expect((await state()).courses.thu.joined).toBe(1);
    await invest('甲', '第1組', 50 * W, 'thu');
    await invest('甲', '第3組', 50 * W, 'thu');
    await phase('thu', 'close');
    await reveal('thu');
    const r = await adminResults('thu');
    const g = Object.fromEntries(r.groups.map((x) => [x.group, x]));
    expect(g['第1組']).toMatchObject({ raw: 50 * W, penalty: 100 * W, final: -50 * W }); // 丁出席沒投
    expect(g['第3組']).toMatchObject({ raw: 50 * W, penalty: 0, final: 50 * W }); // 戊缺席不扣
    expect(r.investors.map((i) => i.name)).toEqual(['甲']);
    expect((await me('戊')).courses.thu).toMatchObject({ result: null, deducted: 0 });
    // 重置會清掉出席紀錄
    await call('invest_admin_reset', { pw: PW, course: 'thu' });
    expect((await state()).courses.thu.joined).toBe(0);
  });

  it('和 TypeScript 參考實作（shared/rules.ts）逐一比對：40 組隨機盤面結果完全相同', async () => {
    let seed = 20260114;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 40; round++) {
      const nGroups = 2 + Math.floor(rand() * 6);
      const members = Array.from({ length: 3 + Math.floor(rand() * 10) }, (_, i) => ({
        name: `學生${round}-${i}`,
        group: `第${1 + Math.floor(rand() * nGroups)}組`,
      }));
      // 組別由名單決定（沒有組員的組不存在），依組號排序
      const groups = [...new Set(members.map((m) => m.group))].sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
      if (groups.length < 2) continue;
      await reset({ roster: members.map((m) => ({ name: m.name, course: 'wed' as const, group: m.group })) });
      await phase('wed', 'open');
      const allocs: Record<string, Record<string, number>> = {};
      const present = new Set<string>();
      for (const m of members) {
        const roll = rand();
        if (roll < 0.15) continue; // 缺席
        await me(m.name);
        present.add(m.name);
        if (roll < 0.3) continue; // 出席但沒投
        let left = BUDGET;
        for (const g of groups) {
          if (g === m.group || left === 0) continue;
          // 金額有整萬、也有零碎到 1 元的
          const amount = Math.min(left, rand() < 0.5 ? Math.floor(rand() * 6) * 10 * W : Math.floor(rand() * 50 * W));
          if (amount === 0) continue;
          // 隨機讓某組在報告中（不同時段 ×1.4／×1.2／×1.1／×1）
          await presentAt(rand() < 0.6 ? g : null, Math.floor(rand() * 20 * 60_000));
          const r = await invest(m.name, g, amount);
          expect(r.error).toBeUndefined();
          left -= amount;
          // 有時候再調低（先扣最晚投的）或追加
          if (rand() < 0.3) {
            await presentAt(rand() < 0.6 ? g : null, Math.floor(rand() * 20 * 60_000));
            const next = rand() < 0.5 ? Math.floor(amount / 3) : Math.min(amount + left, amount + Math.floor(rand() * 20 * W));
            expect((await invest(m.name, g, next)).error).toBeUndefined();
            left -= next - amount;
          }
        }
      }
      await phase('wed', 'close');
      const sql = await adminResults('wed');
      const ts = computeResults(groups, members, allocs, (n) => present.has(n), await lotsByName());
      const norm = (r: Results) => ({
        groups: r.groups.map((g) => ({ ...g, deductions: [...g.deductions].sort((a, b) => a.name.localeCompare(b.name)) })),
        investors: [...r.investors].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)),
        rocket: r.rocket,
        stockGods: [...r.stockGods].sort(),
      });
      expect(norm(sql)).toEqual(norm(ts));
    }
  }, 60_000);
});

describe('登入身分', () => {
  it('只修其中一堂課的學生，姓名也正確顯示（不會被另一堂課的查詢清空）', async () => {
    expect((await me('乙')).name).toBe('乙');
    expect((await me('丁')).name).toBe('丁');
    expect((await me('甲')).name).toBe('甲');
  });
});

describe('報告時段加權', () => {
  const MIN = 60_000;
  const totals = async () => Object.fromEntries((await state()).courses.wed.groups.map((g) => [g.id, g.total]));

  it('按「開始報告」後投給報告中的組：簡報 ×1.4、Demo ×1.2、講評 ×1.1、之後 ×1；別組 ×1', async () => {
    expect((await present('wed', '第2組')).error).toBeUndefined();
    const pub = (await state()).courses.wed;
    expect(pub.presenting?.group).toBe('第2組');
    expect(pub.presented['第2組']).toBeGreaterThan(0);
    await phase('wed', 'open');
    // 簡報中（剛開始）
    await invest('甲', '第2組', 10 * W);
    expect((await totals())['第2組']).toBe(14 * W);
    // 同時投給沒在報告的第3組 ×1
    await invest('甲', '第3組', 10 * W);
    expect((await totals())['第3組']).toBe(10 * W);
    // Demo（4 分鐘）、講評（12 分鐘）、結束後（17 分鐘）
    await presentAt('第2組', 4 * MIN);
    await invest('甲', '第2組', 20 * W); // +10 萬 ×1.2
    await presentAt('第2組', 12 * MIN);
    await invest('甲', '第2組', 30 * W); // +10 萬 ×1.1
    await presentAt('第2組', 17 * MIN);
    await invest('甲', '第2組', 40 * W); // +10 萬 ×1
    expect((await totals())['第2組']).toBe((14 + 12 + 11 + 10) * W);
    const mine = (await me('甲')).courses.wed!;
    expect(mine.alloc).toEqual({ 第2組: 40 * W, 第3組: 10 * W });
    expect(mine.weighted).toEqual({ 第2組: 47 * W, 第3組: 10 * W });
    expect(mine.invested).toBe(50 * W);
  });

  it('撤回或調低時先扣最晚投的（早投的高加權保留）；撤光再投用新的時段', async () => {
    await phase('wed', 'open');
    await present('wed', '第2組');
    await invest('甲', '第2組', 30 * W); // ×1.4
    await presentAt('第2組', 17 * MIN);
    await invest('甲', '第2組', 50 * W); // +20 萬 ×1
    await invest('甲', '第2組', 20 * W); // 扣 30 萬：先扣 ×1 的 20 萬，再扣 ×1.4 的 10 萬
    expect((await totals())['第2組']).toBe(28 * W);
    await invest('甲', '第2組', 0);
    expect((await totals())['第2組']).toBe(0);
    expect((await lotsByName())['甲']).toBeUndefined();
    await present('wed', '第2組');
    await invest('甲', '第2組', 10 * W);
    expect((await totals())['第2組']).toBe(14 * W);
  });

  it('換下一組上台，上一組的加權時段立即結束；停止計時後全部 ×1', async () => {
    await phase('wed', 'open');
    await present('wed', '第2組');
    await present('wed', '第3組');
    await invest('甲', '第2組', 10 * W);
    await invest('甲', '第3組', 10 * W);
    expect(await totals()).toMatchObject({ 第2組: 10 * W, 第3組: 14 * W });
    const pub = (await state()).courses.wed;
    expect(Object.keys(pub.presented).sort()).toEqual(['第2組', '第3組']);
    await present('wed', null);
    expect((await state()).courses.wed.presenting).toBeNull();
    await invest('甲', '第3組', 20 * W);
    expect((await totals())['第3組']).toBe(24 * W);
  });

  it('加權算進一飛沖天與股神；報酬同分時比下注快慢，快的人拿股神獎', async () => {
    await reset({ roster: [
      { name: '快', course: 'wed', group: 'A' },
      { name: '慢', course: 'wed', group: 'A' },
      { name: '乙', course: 'wed', group: 'B' },
      { name: '丙', course: 'wed', group: 'C' },
    ] });
    await phase('wed', 'open');
    await presentAt('B', 20_000);
    await invest('快', 'B', BUDGET); // all in，簡報 20 秒時 ×1.4
    await presentAt('B', 100_000);
    await invest('慢', 'B', BUDGET); // 簡報 100 秒時，也是 ×1.4
    await presentAt('C', 5 * MIN);
    await invest('乙', 'C', BUDGET); // Demo ×1.2
    await invest('丙', 'B', BUDGET); // B 沒在報告 ×1
    await phase('wed', 'close');
    const r = await adminResults('wed');
    expect(r.groups.map((g) => [g.group, g.raw, g.rank])).toEqual([['B', 380 * W, 1], ['C', 120 * W, 2], ['A', 0, 3]]);
    const byName = Object.fromEntries(r.investors.map((i) => [i.name, i]));
    expect(byName.快.payout).toBe(420 * W);
    expect(byName.慢.payout).toBe(420 * W);
    expect(byName.快.delayMs).toBeLessThan(byName.慢.delayMs);
    // 押中第 1 名但晚投（丙：100×1×3 = 300 萬）勝過押第 2 名但早投（乙：100×1.2×2 = 240 萬）：眼光優先
    expect(byName.丙.payout).toBe(300 * W);
    expect(byName.乙.payout).toBe(240 * W);
    expect([byName.快.rank, byName.慢.rank, byName.丙.rank, byName.乙.rank]).toEqual([1, 2, 3, 4]);
    expect(r.stockGods).toEqual(['快']);
    expect(byName.丙.delayMs).toBe(16 * MIN);
  });

  it('只有學生的錢吃時段加權；業師、老師、來賓一律 ×1（仍算進總額）', async () => {
    await call('invest_admin_account_save', { pw: PW, entries: [{ name: '測試業師', role: 'mentor' }], apply: true });
    const mentor = await call<{ token: string }>('invest_login', { name: '測試業師', password: 'TNDA' });
    await phase('wed', 'open');
    await present('wed', '第2組');
    await call('invest_invest', { token: mentor.token, course: 'wed', grp: '第2組', amount: 50 * W });
    await invest('甲', '第2組', 50 * W);
    expect((await totals())['第2組']).toBe(50 * W + 70 * W);
    const m = await call<MeState>('invest_me', { token: mentor.token });
    expect(m.courses.wed?.weighted).toEqual({ 第2組: 50 * W });
  });

  it('開始報告需要管理員密碼；不存在的組、已封盤都擋下；重置會清除', async () => {
    expect((await call<Err>('invest_admin_present', { pw: 'x', course: 'wed', grp: '第2組' })).error).toBe('unauthorized');
    expect((await present('wed', '第9組')).error).toBe('unknown_group');
    await present('wed', '第2組');
    await phase('wed', 'open');
    await phase('wed', 'close');
    expect((await present('wed', '第3組')).error).toBe('bad_phase');
    expect((await state()).courses.wed.presenting).toBeNull();
    await call('invest_admin_reset', { pw: PW, course: 'wed' });
    const pub = (await state()).courses.wed;
    expect(pub.presenting).toBeNull();
    expect(pub.presented).toEqual({});
  });
});

describe('暗盤', () => {
  it('暗盤期間各組金額、排名與暗盤後的走勢都不外洩，學生仍看得到自己的投資', async () => {
    await phase('wed', 'open');
    await invest('甲', '第2組', 30 * W);
    await invest('乙', '第1組', 40 * W);
    await phase('wed', 'dark');
    const histAtDark = (await history()).wed;

    const during = await invest('甲', '第3組', 50 * W);
    expect(during.courses.wed?.alloc).toEqual({ 第2組: 30 * W, 第3組: 50 * W });
    await invest('乙', '第3組', 50 * W);

    const s = await state();
    expect(s.courses.wed.phase).toBe('dark');
    expect(s.courses.wed.groups.every((g) => g.total === null && g.rank === null)).toBe(true);
    expect(s.courses.wed.results).toBeNull();
    expect((await history()).wed).toEqual(histAtDark);
    // 自己的資料只有自己的投資
    const m = await me('乙');
    expect(m.courses.wed).toMatchObject({ alloc: { 第1組: 40 * W, 第3組: 50 * W }, remaining: 10 * W });
    expect(JSON.stringify(m)).not.toContain('第2組": 30');

    await phase('wed', 'close');
    // 封盤後、頒獎揭曉前：金額、名次、暗盤後的走勢與封盤點都還不公開
    const closed = await state();
    expect(closed.courses.wed.groups.every((g) => g.total === null && g.rank === null)).toBe(true);
    expect(closed.courses.wed.results).toBeNull();
    expect((await history()).wed).toEqual(histAtDark);
    expect((await me('乙')).courses.wed).toMatchObject({ result: null, deducted: null, awaiting: true });
    await reveal('wed');
    const shown = await state();
    expect(shown.courses.wed.groups.every((g) => g.total !== null && g.rank !== null)).toBe(true);
    expect((await history()).wed.length).toBeGreaterThan(histAtDark.length);
  });

  it('進入暗盤開始倒數，倒數結束自動封盤並結算（不需要任何人操作）', async () => {
    await reset({ darkMs: 500 });
    await phase('wed', 'open');
    await invest('甲', '第2組', 50 * W);
    await invest('甲', '第3組', 50 * W);
    await phase('wed', 'dark');
    const dark = await state();
    expect(dark.courses.wed.darkEndsAt! - dark.courses.wed.darkAt!).toBe(500);
    await sleep(700);
    // 大螢幕下一次查詢就會看到已封盤；封盤時間就是倒數結束的時間
    const s = await state();
    expect(s.courses.wed.phase).toBe('closed');
    expect(s.courses.wed.closedAt).toBe(s.courses.wed.darkEndsAt);
    // 封盤後結果先不公開，等頒獎揭曉
    expect(s.courses.wed.results).toBeNull();
    expect(s.courses.wed.groups.every((g) => g.total === null)).toBe(true);
    expect((await adminResults('wed')).rocket.length).toBeGreaterThan(0);
    expect((await invest('甲', '第2組', 0)).error).toBe('closed');
  });

  it('倒數結束後就不能再下單（即使還沒有人查詢狀態）', async () => {
    await reset({ darkMs: 300 });
    await phase('wed', 'open');
    await invest('甲', '第2組', 10 * W);
    await phase('wed', 'dark');
    await sleep(450);
    expect((await invest('甲', '第2組', 20 * W)).error).toBe('closed');
    expect((await adminResults('wed')).groups.find((g) => g.group === '第2組')?.raw).toBe(10 * W);
  });

  it('資料存在磁碟：重啟後還原；重啟期間倒數已結束 → 開起來就是已封盤', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invest-pg-'));
    try {
      const a = await openDb({ dataDir: dir, adminPassword: PW, darkMs: 600, seed: ROSTER, seedPassword: STUDENT_PW });
      const sa = await startServer(a);
      await phase('wed', 'open', sa.base);
      const t = await login('甲', sa.base);
      await call('invest_invest', { token: t.token, course: 'wed', grp: '第2組', amount: 30 * W }, sa.base);
      await phase('wed', 'dark', sa.base);
      sa.server.closeAllConnections();
      await new Promise((r) => sa.server.close(r));
      await a.close();

      await sleep(800);
      const b = await openDb({ dataDir: dir, adminPassword: PW, seed: ROSTER, seedPassword: STUDENT_PW });
      const sb = await startServer(b);
      const s = await state(sb.base);
      expect(s.courses.wed.phase).toBe('closed');
      expect((await me('甲', sb.base)).courses.wed?.alloc).toEqual({ 第2組: 30 * W });
      sb.server.closeAllConnections();
      await new Promise((r) => sb.server.close(r));
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('取消封盤', () => {
  it('開盤中誤按封盤 → 回到開盤中，投資保留、可繼續投，再封盤重新結算', async () => {
    await phase('wed', 'open');
    await invest('甲', '第2組', 30 * W);
    await phase('wed', 'close');
    expect((await invest('甲', '第2組', 40 * W)).error).toBe('closed');
    const ov = await phase('wed', 'reopen');
    expect(ov.error).toBeUndefined();
    const s = await state();
    expect(s.courses.wed).toMatchObject({ phase: 'open', results: null, closedAt: null });
    expect((await me('甲')).courses.wed).toMatchObject({ alloc: { 第2組: 30 * W }, result: null, deducted: null });
    expect((await history()).wed.some((p) => p.mark === 'close')).toBe(false);
    await invest('甲', '第2組', 50 * W);
    await phase('wed', 'close');
    expect((await adminResults('wed')).groups.find((g) => g.group === '第2組')?.raw).toBe(50 * W);
  });

  it('暗盤中誤按立即封盤 → 回到暗盤、接續剩餘倒數，金額重新隱藏，時間到照樣自動封盤', async () => {
    await reset({ darkMs: 1500 });
    await phase('wed', 'open');
    await invest('甲', '第2組', 30 * W);
    await phase('wed', 'dark');
    await invest('乙', '第3組', 20 * W);
    await sleep(200);
    const closedOv = await phase('wed', 'close');
    expect(closedOv.courses.wed.reopenTo).toBe('dark');
    expect(closedOv.courses.wed.reopenDarkLeftMs).toBeGreaterThan(1000);
    expect(closedOv.courses.wed.reopenDarkLeftMs).toBeLessThanOrEqual(1300);

    await phase('wed', 'reopen');
    const s = await state();
    expect(s.courses.wed.phase).toBe('dark');
    expect(s.courses.wed.groups.every((g) => g.total === null)).toBe(true);
    const left = s.courses.wed.darkEndsAt! - s.now;
    expect(left).toBeGreaterThan(900);
    expect(left).toBeLessThanOrEqual(1300);
    expect((await history()).wed.every((p) => p.totals['第3組'] === 0)).toBe(true);
    expect((await invest('乙', '第3組', 10 * W)).error).toBeUndefined();
    await sleep(left + 200);
    const closed = await state();
    expect(closed.courses.wed.phase).toBe('closed');
    expect((await adminResults('wed')).groups.find((g) => g.group === '第3組')?.raw).toBe(10 * W);
  });

  it('倒數結束自動封盤後取消 → 回到開盤中；只有已封盤才能取消', async () => {
    await reset({ darkMs: 200 });
    expect((await phase('wed', 'reopen')).error).toBe('bad_phase');
    await phase('wed', 'open');
    expect((await phase('wed', 'reopen')).error).toBe('bad_phase');
    await phase('wed', 'dark');
    await sleep(350);
    expect((await state()).courses.wed.phase).toBe('closed');
    await phase('wed', 'reopen');
    const s = await state();
    expect(s.courses.wed).toMatchObject({ phase: 'open', darkEndsAt: null });
    expect((await phase('wed', 'dark')).error).toBeUndefined();
  });
});

describe('即時同步', () => {
  it('大螢幕每秒查詢一次：學生投資後 2 秒內看到新的各組金額；沒變動時只回一小段', async () => {
    await phase('wed', 'open');
    // 模擬大螢幕：每 1 秒呼叫一次 invest_state（帶上手上的版本）
    let version: number | null = null;
    let total2: number | null = null;
    let stop = false;
    let unchangedBytes = 0;
    const screen = (async () => {
      while (!stop) {
        const res = await fetch(`${base}/rest/v1/rpc/invest_state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ since: version }),
        });
        const text = await res.text();
        const s = JSON.parse(text) as PublicState & { unchanged?: boolean };
        if (s.unchanged) unchangedBytes = text.length;
        else {
          version = s.version;
          total2 = s.courses.wed.groups.find((g) => g.id === '第2組')?.total ?? null;
        }
        await sleep(1000);
      }
    })();
    await sleep(1500);

    const latencies: number[] = [];
    for (const amount of [10, 25, 50]) {
      const t0 = Date.now();
      await invest('甲', '第2組', amount * W);
      while (total2 !== amount * W && Date.now() - t0 < 3000) await sleep(10);
      latencies.push(Date.now() - t0);
      await sleep(Math.random() * 900);
    }
    stop = true;
    await screen;
    console.log(`大螢幕看到新金額的延遲（毫秒，每秒查詢一次）：${latencies.join(', ')}；沒變動時回應 ${unchangedBytes} bytes`);
    expect(Math.max(...latencies)).toBeLessThan(2000);
    expect(unchangedBytes).toBeGreaterThan(0);
    expect(unchangedBytes).toBeLessThan(100);
  });
});

describe('管理員', () => {
  it('管理員功能需要密碼（中文、前後空白不影響）', async () => {
    expect(await call('invest_admin_check', { pw: PW })).toEqual({ ok: true });
    expect(await call('invest_admin_check', { pw: ` ${PW}　` })).toEqual({ ok: true });
    expect((await call<Err>('invest_admin_check', { pw: '測試' })).error).toBe('unauthorized');
    expect((await call<Err>('invest_admin_phase', { pw: 'x', course: 'wed', action: 'open' })).error).toBe('unauthorized');
    expect((await call<Err>('invest_admin_overview', { pw: '' })).error).toBe('unauthorized');
    expect((await state()).courses.wed.phase).toBe('pending');
  });

  it('切換場次、匯入名單（預覽→寫入、只取代出現的課堂）、重置', async () => {
    await call('invest_admin_set_active', { pw: PW, course: 'thu' });
    expect((await state()).active).toBe('thu');
    await phase('wed', 'open');
    await invest('甲', '第2組', 30 * W);
    await invest('乙', '第3組', 30 * W);

    const entries = [
      { name: '甲', course: 'wed', group: '第1組' },
      { name: '乙', course: 'wed', group: '第3組' }, // 乙換組 → 投給第3組的錢退回
      { name: '己', course: 'wed', group: '第2組' },
    ];
    const preview = await call<{ ok: boolean; applied: boolean; courses: string[]; dropped: unknown[] }>(
      'invest_admin_roster', { pw: PW, entries, apply: false });
    expect(preview).toMatchObject({ ok: true, applied: false, courses: ['wed'] });
    expect(preview.dropped).toHaveLength(1);
    expect((await me('乙')).courses.wed?.alloc).toEqual({ 第3組: 30 * W }); // 預覽不會改資料

    const applied = await call<{ applied: boolean }>('invest_admin_roster', { pw: PW, entries, apply: true });
    expect(applied.applied).toBe(true);
    expect((await me('乙')).courses.wed?.alloc).toEqual({});
    expect((await me('丙')).error).toBe('not_in_roster');
    expect((await me('丁')).courses.thu?.group).toBe('第1組'); // 週四不受影響

    const bad = await call<{ ok: boolean; errors: string[] }>('invest_admin_roster', {
      pw: PW, entries: [{ name: '甲', course: 'fri', group: '第1組' }, { name: '', course: 'wed', group: 'X' }], apply: true });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toHaveLength(2);

    await call('invest_admin_reset', { pw: PW, course: 'wed' });
    const s = await state();
    expect(s.courses.wed.phase).toBe('pending');
    expect(s.courses.wed.groups.every((g) => g.total === 0)).toBe(true);
  });

  it('已封盤的場次不能改名單；名單少於兩組不能開盤', async () => {
    await phase('wed', 'open');
    await phase('wed', 'close');
    const r = await call<{ ok: boolean; errors: string[] }>('invest_admin_roster', {
      pw: PW, entries: [{ name: '甲', course: 'wed', group: '第1組' }, { name: '乙', course: 'wed', group: '第2組' }], apply: true });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('已封盤');

    await reset({ roster: [{ name: '甲', course: 'wed', group: '第1組' }] });
    expect((await phase('wed', 'open')).error).toBe('no_groups');
  });

  it('組別依組號排序（阿拉伯數字或中文數字）', async () => {
    await reset({ roster: [
      { name: 'a', course: 'wed', group: '第三組：兩億五千萬Token' },
      { name: 'b', course: 'wed', group: '第一組' },
      { name: 'c', course: 'wed', group: '第10組' },
      { name: 'd', course: 'wed', group: '第二組：組' },
    ] });
    expect((await state()).courses.wed.groups.map((g) => g.id)).toEqual([
      '第一組', '第二組：組', '第三組：兩億五千萬Token', '第10組',
    ]);
  });
});

describe('登入動畫：出席率行情看板', () => {
  type Board = { course: string; weeks: number[]; rows: { name: string; group: string; series: (number | null)[]; attended: number; total: number }[] };
  const board = () => call<Board>('invest_intro_board', {});
  const importAtt = (entries: unknown[], apply = true) =>
    call<{ ok: boolean; applied: boolean; records: number; unmatched: { name: string }[]; errors: string[] } & Err>(
      'invest_admin_attendance', { pw: PW, entries, apply });

  it('出席率 = (參＋遲) ÷ (參＋遲＋假＋缺)，請假也算未出席；每週累計成走勢；只顯示目前場次', async () => {
    const r = await importAtt([
      { course: 'wed', name: '甲', week: 2, status: '參' },
      { course: 'wed', name: '甲', week: 3, status: '缺' },
      { course: 'wed', name: '甲', week: 4, status: '假' },
      { course: 'wed', name: '甲', week: 5, status: '遲' },
      { course: 'wed', name: '乙', week: 3, status: '參' },
      { course: 'thu', name: '丁', week: 2, status: '缺' },
    ]);
    expect(r.applied).toBe(true);
    expect(r.records).toBe(6);
    const b = await board();
    expect(b.course).toBe('wed');
    expect(b.weeks).toEqual([2, 3, 4, 5]);
    const jia = b.rows.find((x) => x.name === '甲')!;
    expect(jia.series).toEqual([100, 50, 33.3, 50]);
    expect([jia.attended, jia.total]).toEqual([2, 4]);
    const yi = b.rows.find((x) => x.name === '乙')!;
    expect(yi.series).toEqual([null, 100, 100, 100]);
    // 丙沒有紀錄：列出但沒有數字；丁是週四的學生，不在週三看板上
    expect(b.rows.find((x) => x.name === '丙')!.series).toEqual([null, null, null, null]);
    expect(b.rows.some((x) => x.name === '丁')).toBe(false);

    await call('invest_admin_set_active', { pw: PW, course: 'thu' });
    const t = await board();
    expect(t.course).toBe('thu');
    expect(t.rows.find((x) => x.name === '丁')!.series).toEqual([0]);
  });

  it('名單上找不到的姓名不匯入；未紀錄略過；預覽不寫入；匯入會取代舊資料', async () => {
    const preview = await importAtt([
      { course: 'wed', name: '甲', week: 2, status: '參' },
      { course: 'wed', name: '路人', week: 2, status: '參' },
      { course: 'wed', name: '乙', week: 2, status: '未紀錄' },
    ], false);
    expect(preview.ok).toBe(true);
    expect(preview.applied).toBe(false);
    expect(preview.records).toBe(1);
    expect(preview.unmatched.map((u) => u.name)).toEqual(['路人']);
    expect((await board()).rows).toEqual([]);

    await importAtt([{ course: 'wed', name: '甲', week: 2, status: '參' }]);
    await importAtt([{ course: 'wed', name: '乙', week: 7, status: '缺' }]);
    const b = await board();
    expect(b.weeks).toEqual([7]);
    expect(b.rows.find((x) => x.name === '甲')!.series).toEqual([null]);
  });

  it('沒有出席資料或管理員關閉看板時，不回傳任何姓名；管理功能需要密碼', async () => {
    expect((await board()).rows).toEqual([]);
    await importAtt([{ course: 'wed', name: '甲', week: 2, status: '參' }]);
    expect((await board()).rows.length).toBe(3);

    expect((await call<Err>('invest_admin_board', { pw: 'x', visible: false })).error).toBe('unauthorized');
    expect((await call<Err>('invest_admin_attendance', { pw: 'x', entries: [], apply: true })).error).toBe('unauthorized');
    await call('invest_admin_board', { pw: PW, visible: false });
    const hidden = await board();
    expect(hidden.rows).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain('甲');
    const ov = await call<AdminOverview>('invest_admin_overview', { pw: PW });
    expect(ov.board).toEqual({ visible: false, wed: { students: 1, weeks: 1 }, thu: { students: 0, weeks: 0 } });

    await call('invest_admin_board', { pw: PW, visible: true });
    await importAtt([], true);
    expect((await board()).rows).toEqual([]);
  });
});

describe('帳號與密碼', () => {
  it('學生要輸入姓名＋密碼（生日後四碼）；錯 5 次鎖 1 分鐘；憑證失效要重新登入', async () => {
    const ok = await call<{ token?: string; me?: MeState } & Err>('invest_login', { name: ' 甲 ', password: STUDENT_PW });
    expect(ok.token).toMatch(/^[0-9a-f]{64}$/);
    expect(ok.me?.role).toBe('student');
    const bad = await call<Err>('invest_login', { name: '甲', password: '9999' });
    expect(bad.error).toBe('bad_password');
    expect(bad.message).toContain('生日後四碼');
    expect((await call<Err>('invest_login', { name: '路人', password: '0101' })).error).toBe('not_in_roster');
    // 沒有憑證不能投資、不能看自己的資料
    expect((await call<Err>('invest_me', { token: 'x'.repeat(64) })).error).toBe('bad_session');
    await phase('wed', 'open');
    expect((await call<Err>('invest_invest', { token: 'x'.repeat(64), course: 'wed', grp: '第2組', amount: 10 * W })).error).toBe('bad_session');
    // 錯 5 次 → 鎖住，連正確密碼也暫時不能登入
    for (let i = 0; i < 4; i++) await call('invest_login', { name: '乙', password: '1111' });
    expect((await call<Err>('invest_login', { name: '乙', password: '1111' })).error).toBe('bad_password');
    expect((await call<Err>('invest_login', { name: '乙', password: STUDENT_PW })).error).toBe('locked');
    // 管理員重設密碼：解鎖，而且舊的登入失效
    const s1 = await call<{ ok: boolean }>('invest_admin_account_save', {
      pw: PW, entries: [{ name: '甲', role: 'student', password: '0403' }], apply: true });
    expect(s1.ok).toBe(true);
    expect((await call<Err>('invest_me', { token: ok.token })).error).toBe('bad_session');
    expect((await call<{ token?: string }>('invest_login', { name: '甲', password: '0403' })).token).toBeTruthy();
    expect((await call<Err>('invest_admin_account_save', { pw: 'x', entries: [], apply: true })).error).toBe('unauthorized');
  });

  it('業師、老師、來賓：密碼預設 TNDA（大小寫不拘）；兩場都能投、每場 100 萬；算進各組總額但不倒扣、不參加股神獎', async () => {
    const add = await call<{ ok: boolean; created: number }>('invest_admin_account_save', {
      pw: PW, entries: [{ name: '王業師', role: 'mentor' }], apply: true });
    expect(add).toMatchObject({ ok: true, created: 1 });
    // 學生不能被改成業師
    expect((await call<{ ok: boolean }>('invest_admin_account_save', {
      pw: PW, entries: [{ name: '甲', role: 'mentor' }], apply: false })).ok).toBe(false);
    const mentor = await call<{ token: string; me: MeState }>('invest_login', { name: '王業師', password: 'tnda' });
    expect(mentor.me.role).toBe('mentor');
    expect(Object.keys(mentor.me.courses).sort()).toEqual(['thu', 'wed']);
    expect(mentor.me.courses.wed?.group).toBeNull();
    // 預設的 5 個來賓帳號
    const guest = await call<{ token: string; me: MeState }>('invest_login', { name: 'TNDA3', password: 'TNDA' });
    expect(guest.me.role).toBe('guest');

    await phase('wed', 'open');
    const inv = (t: string, grp: string, amount: number, course = 'wed') =>
      call<MeState & Err>('invest_invest', { token: t, course, grp, amount });
    expect((await inv(mentor.token, '第1組', 50 * W)).error).toBeUndefined();
    expect((await inv(mentor.token, '第1組', BUDGET + 1)).error).toBe('over_budget');
    expect((await inv(guest.token, '第3組', 40 * W)).error).toBeUndefined();
    await invest('甲', '第2組', 50 * W);
    await invest('甲', '第3組', 50 * W);
    expect((await state()).courses.wed.groups.find((g) => g.id === '第1組')?.total).toBe(50 * W);
    // 業師、來賓不算學生人數
    expect((await state()).courses.wed.students).toBe(3);
    await phase('wed', 'close');

    const r = await adminResults('wed');
    const g = Object.fromEntries(r.groups.map((x) => [x.group, x]));
    expect(g['第1組']).toMatchObject({ raw: 50 * W, penalty: 0 });
    expect(g['第3組']).toMatchObject({ raw: 90 * W, penalty: 0 });
    // 股神只比學生
    expect(r.investors.map((i) => i.name)).toEqual(['甲']);
    expect(r.stockGods).toEqual(['甲']);
    expect(r.others?.map((o) => o.name).sort()).toEqual(['TNDA3', '王業師'].sort());
    await reveal('wed');
    const m = await call<MeState>('invest_me', { token: mentor.token });
    expect(m.courses.wed?.result).toMatchObject({ rank: null, of: null });
    expect(m.courses.wed?.result?.payout).toBe(50 * W * g['第1組'].multiplier);
    // 刪除業師帳號：已封盤場次有投資就不能刪
    expect((await call<Err>('invest_admin_account_delete', { pw: PW, name: '王業師' })).error).toBe('closed');
  });
});

describe('頒獎與業師總結（大螢幕舞台）', () => {
  const stageAct = (action: string, step?: number) =>
    call<AdminOverview & Err>('invest_admin_stage', { pw: PW, action, step });

  it('兩場封盤後由管理員一步一步揭曉；走到某場第 1 名時該場結果才公開到學生手機', async () => {
    await phase('wed', 'open');
    await invest('甲', '第2組', 50 * W);
    await invest('甲', '第3組', 50 * W);
    await invest('乙', '第1組', 50 * W);
    await invest('乙', '第3組', 50 * W);
    await phase('wed', 'close');
    await call('invest_admin_set_active', { pw: PW, course: 'thu' });
    await phase('thu', 'open');
    await invest('甲', '第1組', 50 * W, 'thu');
    await invest('甲', '第3組', 50 * W, 'thu');
    await phase('thu', 'close');

    expect((await state()).stage.mode).toBe('market');
    expect((await me('甲')).courses.wed).toMatchObject({ result: null, awaiting: true });

    const ov = await stageAct('awards');
    const labels = ov.stage.awardLabels;
    expect(labels[0]).toBe('頒獎典禮開場');
    expect(labels).toContain('上半場・週三：第 1 名・一飛沖天獎');
    expect(labels).toContain('下半場・週四：股神獎');
    expect(labels[labels.length - 1]).toBe('頒獎結束');
    // 第 1 名之前（開場、週三第 3、2 名）都還沒公開
    const firstWed = labels.indexOf('上半場・週三：第 1 名・一飛沖天獎');
    for (let i = 0; i < firstWed - 1; i++) await stageAct('next');
    let s = await state();
    expect(s.stage.mode).toBe('awards');
    expect(s.courses.wed.revealed).toBe(false);
    expect(s.courses.wed.results).toBeNull();
    // 第 2 名那一步有作品資訊與組員
    const podium = s.stage.scene as { kind: string; groups: { memberNames: string[]; slogan: string }[] };
    expect(podium.kind).toBe('podium');
    expect(podium.groups[0].memberNames.length).toBeGreaterThan(0);

    await stageAct('next');
    s = await state();
    expect(s.stage.scene).toMatchObject({ kind: 'rocket', course: 'wed', rank: 1 });
    expect(s.courses.wed.revealed).toBe(true);
    expect(s.courses.thu.revealed).toBe(false);
    expect((await me('甲')).courses.wed?.result?.rank).toBeGreaterThan(0);
    expect((await me('甲')).courses.thu?.result).toBeNull();

    // 往回走不會收回已公開的結果；跳到最後也會公開週四
    await stageAct('prev');
    expect((await state()).courses.wed.revealed).toBe(true);
    await stageAct('goto', 999);
    s = await state();
    expect(s.stage.scene?.kind).toBe('finale');
    expect(s.courses.thu.revealed).toBe(true);

    // 業師總結：預設三頁，數字回顧帶入兩場資料
    const sum = await stageAct('summary');
    expect(sum.stage.slideLabels).toEqual(['業師總結', '數字回顧', '謝謝大家']);
    await stageAct('next');
    s = await state();
    expect(s.stage).toMatchObject({ mode: 'summary', step: 1, total: 3 });
    const recap = (s.stage.scene as { recap: { course: string; invested: number }[] }).recap;
    expect(recap.find((c) => c.course === 'wed')?.invested).toBe(200 * W);
    expect((await stageAct('next', undefined)).stage.step).toBe(2);
    expect((await stageAct('next', undefined)).stage.step).toBe(2); // 已是最後一頁
    expect((await stageAct('market')).stage.mode).toBe('market');
    expect((await call<Err>('invest_admin_stage', { pw: 'x', action: 'awards' })).error).toBe('unauthorized');
  });

  it('取消封盤、重置會收回揭曉；各組封面與 slogan；總結投影片可編輯', async () => {
    await phase('wed', 'open');
    await phase('wed', 'close');
    await stageAct('awards');
    await stageAct('goto', 999);
    expect((await state()).courses.wed.revealed).toBe(true);
    await stageAct('market');
    await phase('wed', 'reopen');
    expect((await state()).courses.wed.revealed).toBe(false);

    const cover = 'data:image/jpeg;base64,' + 'A'.repeat(100);
    const g = await call<AdminOverview & Err>('invest_admin_group', { pw: PW, course: 'wed', grp: '第2組', slogan: ' 讓光說話 ', cover });
    expect(g.groupInfo.wed.find((x) => x.group === '第2組')).toMatchObject({ slogan: '讓光說話', coverVer: 1 });
    const pub = (await state()).courses.wed.groups.find((x) => x.id === '第2組')!;
    expect(pub).toMatchObject({ slogan: '讓光說話', coverVer: 1, memberNames: ['乙'] });
    expect((await call<{ cover: string }>('invest_group_cover', { course: 'wed', grp: '第2組' })).cover).toBe(cover);
    expect((await call<Err>('invest_admin_group', { pw: PW, course: 'wed', grp: '第2組', cover: 'javascript:alert(1)' })).error).toBe('bad_cover');
    expect((await call<Err>('invest_admin_group', { pw: PW, course: 'wed', grp: '第9組', slogan: 'x' })).error).toBe('unknown_group');
    const cleared = await call<AdminOverview>('invest_admin_group', { pw: PW, course: 'wed', grp: '第2組', clear_cover: true });
    expect(cleared.groupInfo.wed.find((x) => x.group === '第2組')?.coverVer).toBeNull();

    const before = (await call<AdminOverview>('invest_admin_overview', { pw: PW })).slides;
    const img = 'data:image/png;base64,' + 'B'.repeat(50);
    const saved = await call<AdminOverview>('invest_admin_slides', {
      pw: PW,
      slides: [
        { id: before[2].id, kind: 'text', title: '謝謝大家', subtitle: '', body: '' },
        { kind: 'text', title: '蔡宏賢老師', subtitle: '超維度', body: '第一點\n第二點', image: img },
      ],
    });
    expect(saved.slides.map((x) => x.title)).toEqual(['謝謝大家', '蔡宏賢老師']);
    expect(saved.slides[0].id).toBe(before[2].id);
    expect(saved.slides[1].imageVer).toBe(1);
    expect((await call<{ image: string }>('invest_slide_image', { id: saved.slides[1].id })).image).toBe(img);
    // 沒有給 image 欄位 → 保留原本的圖
    const kept = await call<AdminOverview>('invest_admin_slides', {
      pw: PW, slides: saved.slides.map(({ imageVer: _v, ...x }) => x) });
    expect(kept.slides[1].imageVer).toBe(1);
  });
});
