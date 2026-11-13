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
import type { AdminOverview, HistoryPoint, MeState, PublicState, Results, RosterEntry } from '../shared/types.ts';

const W = 10_000;
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
    truncate invest.alloc, invest.presence, invest.history, invest.roster restart identity;
    update invest.course set phase = 'pending', opened_at = null, dark_at = null, dark_ends_at = null,
      closed_at = null, dark_history_id = null, closed_from = null, dark_left_ms = null, results = null;
    update invest.config set active = 'wed', version = version + 1;
  `);
  await db.pg.query('update invest.config set dark_ms = $1 where id = 1', [opts.darkMs ?? 60_000]);
  await db.pg.query(
    `insert into invest.roster (course, name_key, name, grp)
     select e ->> 'course', invest.name_key(e ->> 'name'), invest.norm_name(e ->> 'name'), e ->> 'group'
     from jsonb_array_elements($1::jsonb) e`,
    [JSON.stringify(opts.roster ?? ROSTER)],
  );
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
const me = (name: string, at = base) => call<MeState & Err>('invest_me', { name }, at);
const invest = (name: string, grp: string, amount: number, course = 'wed') =>
  call<MeState & Err>('invest_invest', { name, course, grp, amount });
const phase = (course: string, action: string, at = base) =>
  call<AdminOverview & Err>('invest_admin_phase', { pw: PW, course, action }, at);
const adminResults = (course: string) => call<Results>('invest_admin_results', { pw: PW, course });
const history = () => call<Record<string, HistoryPoint[]>>('invest_history', {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  it('單一組上限 50 萬（剛好 50 萬可以，多 1 元就擋下），金額必須是非負整數、最小 1 元', async () => {
    await phase('wed', 'open');
    expect((await invest('甲', '第2組', 50 * W + 1)).error).toBe('over_limit');
    expect((await invest('甲', '第2組', 50 * W)).error).toBeUndefined();
    expect((await invest('甲', '第2組', 60 * W)).error).toBe('over_limit');
    expect((await invest('甲', '第2組', -1)).error).toBe('bad_amount');
    expect((await invest('甲', '第2組', 1.5)).error).toBe('bad_amount');
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
    // 甲同時對兩組各送 10 筆 50 萬：最後兩組都是 50 萬、總共不超過 100 萬
    const reqs = Array.from({ length: 20 }, (_, i) => invest('甲', i % 2 ? '第2組' : '第3組', 50 * W));
    await Promise.all(reqs);
    const m = await me('甲');
    expect(m.courses.wed?.invested).toBe(100 * W);
    // 再同時送 10 筆超額的，全部被擋
    const over = await Promise.all(Array.from({ length: 10 }, () => invest('乙', '第1組', 50 * W + 1)));
    expect(over.every((r) => r.error === 'over_limit')).toBe(true);
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
    const json = JSON.stringify(s);
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
          const r = await invest(m.name, g, amount);
          expect(r.error).toBeUndefined();
          (allocs[m.name] ??= {})[g] = amount;
          left -= amount;
        }
      }
      await phase('wed', 'close');
      const sql = await adminResults('wed');
      const ts = computeResults(groups, members, allocs, (n) => present.has(n));
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
    const closed = await state();
    expect(closed.courses.wed.groups.every((g) => g.total !== null && g.rank !== null)).toBe(true);
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
    expect(s.courses.wed.results!.rocket.length).toBeGreaterThan(0);
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
      const a = await openDb({ dataDir: dir, adminPassword: PW, darkMs: 600, seed: ROSTER });
      const sa = await startServer(a);
      await phase('wed', 'open', sa.base);
      await call('invest_invest', { name: '甲', course: 'wed', grp: '第2組', amount: 30 * W }, sa.base);
      await phase('wed', 'dark', sa.base);
      sa.server.closeAllConnections();
      await new Promise((r) => sa.server.close(r));
      await a.close();

      await sleep(800);
      const b = await openDb({ dataDir: dir, adminPassword: PW, seed: ROSTER });
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
    expect(closed.courses.wed.results!.groups.find((g) => g.group === '第3組')?.raw).toBe(10 * W);
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
