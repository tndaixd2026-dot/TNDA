// 端對端：啟動真的 HTTP 伺服器，透過 API 與 SSE 驗證 SPEC.md 的規則都在伺服器端成立。
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createStore, type Store } from '../server/store.ts';
import type { HistoryPoint, MeState, PublicState, RosterEntry } from '../shared/types.ts';

const W = 10_000;
const ADMIN = 'secret';

// 甲同時修兩堂課，且兩堂課組別不同
const roster: RosterEntry[] = [
  { name: '甲', course: 'wed', group: '第1組' },
  { name: '乙', course: 'wed', group: '第2組' },
  { name: '丙', course: 'wed', group: '第3組' },
  { name: '甲', course: 'thu', group: '第2組' },
  { name: '丁', course: 'thu', group: '第1組' },
  { name: '戊', course: 'thu', group: '第3組' },
];

interface Ctx {
  base: string;
  store: Store;
  close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start(opts: { darkMs?: number; dataDir?: string | null } = {}): Promise<Ctx> {
  const store = createStore({
    dataDir: opts.dataDir ?? null,
    darkMs: opts.darkMs ?? 60_000,
    seed: roster,
    log: () => {},
  });
  const server = createApp(store, { adminPassword: ADMIN, staticDir: null });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.dispose();
  };
  cleanups.push(close);
  return { base: `http://127.0.0.1:${port}`, store, close };
}

async function post(ctx: Ctx, path: string, body: unknown, admin = false) {
  const res = await fetch(ctx.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-password': ADMIN } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const getJson = async <T>(ctx: Ctx, path: string) => (await (await fetch(ctx.base + path)).json()) as T;
const getState = (ctx: Ctx) => getJson<PublicState>(ctx, '/api/state');
const getMe = (ctx: Ctx, name: string) => getJson<MeState>(ctx, `/api/me?name=${encodeURIComponent(name)}`);
const phase = (ctx: Ctx, course: string, action: string) => post(ctx, '/api/admin/phase', { course, action }, true);
const invest = (ctx: Ctx, name: string, group: string, amount: number, course = 'wed') =>
  post(ctx, '/api/invest', { name, course, group, amount });
const asMe = (r: { body: Record<string, unknown> }) => r.body as unknown as MeState;

interface SseEvent {
  event: string;
  data: string;
  at: number;
}

/** 開一條 SSE 連線，持續收集事件 */
async function sse(ctx: Ctx, query: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.base}/api/events?${query}`, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data !== undefined) events.push({ event, data, at: Date.now() });
        }
      }
    } catch {
      // 連線被關閉
    }
  })();
  cleanups.push(async () => controller.abort());
  const waitFor = async (pred: (e: SseEvent) => boolean, timeoutMs: number): Promise<SseEvent | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    return events.find(pred) ?? null;
  };
  return { events, waitFor };
}

describe('登入與名單', () => {
  it('只認名單上的姓名，並回傳所屬課堂與組別', async () => {
    const ctx = await start();
    const ok = await post(ctx, '/api/login', { name: ' 甲 ' });
    expect(ok.status).toBe(200);
    const me = asMe(ok);
    expect(me.name).toBe('甲');
    expect(me.courses.wed?.group).toBe('第1組');
    expect(me.courses.thu?.group).toBe('第2組');
    expect((await post(ctx, '/api/login', { name: '路人' })).status).toBe(404);
  });
});

describe('投資規則（伺服器端驗證）', () => {
  it('不能投自己那組，也不能投其他堂課或不存在的組', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    const own = await invest(ctx, '甲', '第1組', 10 * W);
    expect(own.status).toBe(400);
    expect(own.body.error).toBe('own_group');
    expect((await invest(ctx, '甲', '第9組', 10 * W)).body.error).toBe('unknown_group');
    // 丁只修週四，不能投週三
    expect((await invest(ctx, '丁', '第2組', 10 * W)).body.error).toBe('not_in_course');
    expect((await invest(ctx, '路人', '第2組', 10 * W)).status).toBe(404);
    expect((await getMe(ctx, '甲')).courses.wed?.alloc).toEqual({});
  });

  it('單一組上限 50 萬（剛好 50 萬可以，多 1 元就擋下）', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    const over = await invest(ctx, '甲', '第2組', 50 * W + 1);
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('over_limit');
    expect((await invest(ctx, '甲', '第2組', 50 * W)).status).toBe(200);
    expect((await invest(ctx, '甲', '第2組', 60 * W)).body.error).toBe('over_limit');
    expect((await getMe(ctx, '甲')).courses.wed?.alloc).toEqual({ 第2組: 50 * W });
    expect((await invest(ctx, '甲', '第2組', -1)).body.error).toBe('bad_amount');
    expect((await invest(ctx, '甲', '第2組', 1.5)).body.error).toBe('bad_amount');
  });

  it('未開盤不能投；開盤中與暗盤可以；封盤後不能投', async () => {
    const ctx = await start();
    const before = await invest(ctx, '甲', '第2組', 10 * W);
    expect(before.status).toBe(409);
    expect(before.body.error).toBe('not_open');

    await phase(ctx, 'wed', 'open');
    expect((await invest(ctx, '甲', '第2組', 10 * W)).status).toBe(200);
    await phase(ctx, 'wed', 'dark');
    expect((await invest(ctx, '甲', '第2組', 20 * W)).status).toBe(200);
    await phase(ctx, 'wed', 'close');

    const after = await invest(ctx, '甲', '第2組', 30 * W);
    expect(after.status).toBe(409);
    expect(after.body.error).toBe('closed');
    // 撤回也不行
    expect((await invest(ctx, '甲', '第2組', 0)).body.error).toBe('closed');
    expect((await getMe(ctx, '甲')).courses.wed?.alloc).toEqual({ 第2組: 20 * W });
  });

  it('追加、撤回、調整後餘額正確，餘額不足時擋下', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    const wallet = (r: { body: Record<string, unknown> }) => {
      const c = asMe(r).courses.wed!;
      return { alloc: c.alloc, invested: c.invested, remaining: c.remaining };
    };

    expect(wallet(await invest(ctx, '甲', '第2組', 30 * W))).toEqual({ alloc: { 第2組: 30 * W }, invested: 30 * W, remaining: 70 * W });
    // 追加到 50 萬
    expect(wallet(await invest(ctx, '甲', '第2組', 50 * W))).toEqual({ alloc: { 第2組: 50 * W }, invested: 50 * W, remaining: 50 * W });
    expect(wallet(await invest(ctx, '甲', '第3組', 50 * W))).toEqual({
      alloc: { 第2組: 50 * W, 第3組: 50 * W },
      invested: 100 * W,
      remaining: 0,
    });
    // 撤回部分
    expect(wallet(await invest(ctx, '甲', '第2組', 20 * W))).toEqual({
      alloc: { 第2組: 20 * W, 第3組: 50 * W },
      invested: 70 * W,
      remaining: 30 * W,
    });
    // 全部撤回
    expect(wallet(await invest(ctx, '甲', '第3組', 0))).toEqual({ alloc: { 第2組: 20 * W }, invested: 20 * W, remaining: 80 * W });

    // 再投滿：兩組各 50 萬
    expect(wallet(await invest(ctx, '甲', '第3組', 50 * W)).remaining).toBe(30 * W);
    expect(wallet(await invest(ctx, '甲', '第2組', 50 * W)).remaining).toBe(0);

    // 公開的組別總額也跟著正確
    const totals = Object.fromEntries((await getState(ctx)).courses.wed.groups.map((g) => [g.id, g.total]));
    expect(totals).toEqual({ 第1組: 0, 第2組: 50 * W, 第3組: 50 * W });
  });

  it('餘額不足時擋下（四組的課）', async () => {
    const ctx = await start();
    // 臨時名單：一堂四組的課
    await post(
      ctx,
      '/api/admin/roster',
      { csv: '己,週四,A\n庚,週四,B\n辛,週四,C\n壬,週四,D' },
      true,
    );
    await phase(ctx, 'thu', 'open');
    await invest(ctx, '己', 'B', 50 * W, 'thu');
    await invest(ctx, '己', 'C', 40 * W, 'thu');
    const r = await invest(ctx, '己', 'D', 20 * W, 'thu');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('over_budget');
    expect((await invest(ctx, '己', 'D', 10 * W, 'thu')).status).toBe(200);
    expect((await getMe(ctx, '己')).courses.thu?.remaining).toBe(0);
  });

  it('重疊學生上下半場錢包獨立：各 100 萬，互不相通', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    await phase(ctx, 'thu', 'open');

    // 甲把週三的 100 萬投完
    await invest(ctx, '甲', '第2組', 50 * W, 'wed');
    await invest(ctx, '甲', '第3組', 50 * W, 'wed');
    let me = await getMe(ctx, '甲');
    expect(me.courses.wed?.remaining).toBe(0);
    expect(me.courses.thu?.remaining).toBe(100 * W);
    expect(me.courses.thu?.alloc).toEqual({});

    // 週四仍可投滿 100 萬（甲週四是第2組，所以投第1、3組）
    expect((await invest(ctx, '甲', '第1組', 50 * W, 'thu')).status).toBe(200);
    expect((await invest(ctx, '甲', '第3組', 50 * W, 'thu')).status).toBe(200);
    // 週四的自己組是第2組（週三的第2組可以投，週四不行）
    expect((await invest(ctx, '甲', '第2組', 10 * W, 'thu')).body.error).toBe('own_group');
    me = await getMe(ctx, '甲');
    expect(me.courses.wed).toMatchObject({ group: '第1組', alloc: { 第2組: 50 * W, 第3組: 50 * W }, remaining: 0 });
    expect(me.courses.thu).toMatchObject({ group: '第2組', alloc: { 第1組: 50 * W, 第3組: 50 * W }, remaining: 0 });

    // 週四撤回不影響週三
    await invest(ctx, '甲', '第1組', 0, 'thu');
    me = await getMe(ctx, '甲');
    expect(me.courses.thu?.remaining).toBe(50 * W);
    expect(me.courses.wed?.remaining).toBe(0);

    // 各場總額分開計算；封盤結算也分開（週三封盤時甲不倒扣，週四封盤時甲倒扣 50 萬給週四第2組）
    const s = await getState(ctx);
    expect(s.courses.wed.groups.find((g) => g.id === '第2組')?.total).toBe(50 * W);
    expect(s.courses.thu.groups.find((g) => g.id === '第3組')?.total).toBe(50 * W);
    await phase(ctx, 'wed', 'close');
    await phase(ctx, 'thu', 'close');
    const closed = await getState(ctx);
    const wed1 = closed.courses.wed.results!.groups.find((g) => g.group === '第1組')!;
    const thu2 = closed.courses.thu.results!.groups.find((g) => g.group === '第2組')!;
    expect(wed1.deductions.find((d) => d.name === '甲')).toBeUndefined();
    expect(thu2.deductions.find((d) => d.name === '甲')).toEqual({ name: '甲', unspent: 50 * W });
  });
});

describe('封盤結算', () => {
  it('未花完金額從自己那組倒扣（可為負），同分並列，倍率與個人報酬正確', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    await invest(ctx, '甲', '第2組', 50 * W);
    await invest(ctx, '甲', '第3組', 50 * W);
    await invest(ctx, '乙', '第1組', 50 * W);
    await invest(ctx, '乙', '第3組', 30 * W); // 乙剩 20 萬 → 第2組倒扣 20 萬
    // 丙完全沒投 → 第3組倒扣 100 萬
    await phase(ctx, 'wed', 'close');

    const r = (await getState(ctx)).courses.wed.results!;
    expect(r.groups.map((g) => [g.group, g.raw, g.penalty, g.final, g.rank, g.multiplier])).toEqual([
      ['第1組', 50 * W, 0, 50 * W, 1, 3],
      ['第2組', 50 * W, 20 * W, 30 * W, 2, 2],
      ['第3組', 80 * W, 100 * W, -20 * W, 3, 1.5],
    ]);
    expect(r.groups[1].deductions).toEqual([{ name: '乙', unspent: 20 * W }]);
    expect(r.groups[2].deductions).toEqual([{ name: '丙', unspent: 100 * W }]);
    expect(r.rocket).toEqual(['第1組']);
    // 甲 = 50×2 + 50×1.5 = 175 萬；乙 = 50×3 + 30×1.5 = 195 萬（沒花完的 20 萬不計入）；丙 = 0
    expect(r.investors.map((i) => [i.name, i.payout, i.rank])).toEqual([
      ['乙', 195 * W, 1],
      ['甲', 175 * W, 2],
      ['丙', 0, 3],
    ]);
    expect(r.stockGods).toEqual(['乙']);
    expect((await getMe(ctx, '甲')).courses.wed?.result).toEqual({ payout: 175 * W, rank: 2, of: 3 });

    const csv = await (await fetch(ctx.base + '/api/admin/results.csv?course=wed', { headers: { 'x-admin-password': ADMIN } })).text();
    expect(csv).toContain('股神獎,乙');
  });

  it('規格範例：兩組並列第 1 都是 ×3，下一組是第 3 名 ×1.5；個人報酬同分並列', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    // 週三：甲(第1組)、乙(第2組)、丙(第3組)
    await invest(ctx, '甲', '第2組', 50 * W);
    await invest(ctx, '甲', '第3組', 30 * W); // 甲剩 20 萬 → 第1組倒扣 20
    await invest(ctx, '乙', '第1組', 50 * W);
    await invest(ctx, '乙', '第3組', 30 * W); // 乙剩 20 萬 → 第2組倒扣 20
    await invest(ctx, '丙', '第1組', 50 * W);
    await invest(ctx, '丙', '第2組', 50 * W);
    await phase(ctx, 'wed', 'close');
    const r = (await getState(ctx)).courses.wed.results!;
    // 第1組 = 100 − 20 = 80、第2組 = 100 − 20 = 80（並列第 1）、第3組 = 60（第 3 名）
    expect(r.groups.map((g) => [g.group, g.raw, g.penalty, g.final, g.rank, g.multiplier])).toEqual([
      ['第1組', 100 * W, 20 * W, 80 * W, 1, 3],
      ['第2組', 100 * W, 20 * W, 80 * W, 1, 3],
      ['第3組', 60 * W, 0, 60 * W, 3, 1.5],
    ]);
    expect(r.rocket).toEqual(['第1組', '第2組']);
    // 丙 = 50×3 + 50×3 = 300；甲 = 50×3 + 30×1.5 = 195；乙 = 50×3 + 30×1.5 = 195（並列第 2）
    expect(r.investors.map((i) => [i.name, i.payout, i.rank])).toEqual([
      ['丙', 300 * W, 1],
      ['乙', 195 * W, 2],
      ['甲', 195 * W, 2],
    ].sort((a, b) => (a[2] as number) - (b[2] as number) || String(a[0]).localeCompare(String(b[0]), 'zh-Hant')));
    expect(r.stockGods).toEqual(['丙']);
  });

  it('全部同分時一飛沖天與股神都全部並列', async () => {
    const ctx = await start();
    await phase(ctx, 'thu', 'open');
    // 週四：甲(第2組)、丁(第1組)、戊(第3組)，每組都拿到 100 萬
    await invest(ctx, '甲', '第1組', 50 * W, 'thu');
    await invest(ctx, '甲', '第3組', 50 * W, 'thu');
    await invest(ctx, '丁', '第2組', 50 * W, 'thu');
    await invest(ctx, '丁', '第3組', 50 * W, 'thu');
    await invest(ctx, '戊', '第1組', 50 * W, 'thu');
    await invest(ctx, '戊', '第2組', 50 * W, 'thu');
    await phase(ctx, 'thu', 'close');
    const r = (await getState(ctx)).courses.thu.results!;
    expect(r.groups.every((g) => g.final === 100 * W && g.rank === 1 && g.multiplier === 3)).toBe(true);
    expect(r.rocket).toEqual(['第1組', '第2組', '第3組']);
    expect(r.investors.every((i) => i.payout === 300 * W && i.rank === 1)).toBe(true);
    expect([...r.stockGods].sort()).toEqual(['丁', '戊', '甲'].sort());
  });
});

describe('暗盤', () => {
  it('暗盤期間各組金額與排名不外洩（API 與所有 SSE 推播），學生仍看得到自己的投資', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    await invest(ctx, '甲', '第2組', 30 * W);
    await invest(ctx, '乙', '第1組', 40 * W);
    await phase(ctx, 'wed', 'dark');
    const histAtDark = (await getJson<Record<string, HistoryPoint[]>>(ctx, '/api/history')).wed;

    // 暗盤期間才連上的：大螢幕、匿名、學生乙
    const screen = await sse(ctx, 'history=1');
    const anon = await sse(ctx, '');
    const student = await sse(ctx, `name=${encodeURIComponent('乙')}`);
    await screen.waitFor((e) => e.event === 'history', 1000);

    // 暗盤期間有人調整
    const during = await invest(ctx, '甲', '第3組', 50 * W);
    expect(during.status).toBe(200);
    expect(asMe(during).courses.wed?.alloc).toEqual({ 第2組: 30 * W, 第3組: 50 * W });
    expect((await invest(ctx, '乙', '第3組', 50 * W)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 400)); // 等推播送出

    // 1) 公開 API
    const s = await getState(ctx);
    expect(s.courses.wed.phase).toBe('dark');
    for (const g of s.courses.wed.groups) {
      expect(g.total).toBeNull();
      expect(g.rank).toBeNull();
    }
    expect(s.courses.wed.results).toBeNull();
    expect((await getJson<Record<string, HistoryPoint[]>>(ctx, '/api/history')).wed).toEqual(histAtDark);

    // 2) 所有 SSE 連線：state 不含金額與排名；不送暗盤後的走勢點；history 只到暗盤開始
    for (const conn of [screen, anon, student]) {
      const states = conn.events.filter((e) => e.event === 'state');
      expect(states.length).toBeGreaterThan(0);
      for (const e of states) {
        const st = JSON.parse(e.data) as PublicState;
        expect(st.courses.wed.groups.every((g) => g.total === null && g.rank === null)).toBe(true);
        expect(st.courses.wed.results).toBeNull();
      }
      expect(conn.events.filter((e) => e.event === 'point')).toEqual([]);
    }
    for (const e of screen.events.filter((x) => x.event === 'history')) {
      expect((JSON.parse(e.data) as Record<string, HistoryPoint[]>).wed).toEqual(histAtDark);
    }
    expect(anon.events.some((e) => e.event === 'me' || e.event === 'history')).toBe(false);

    // 3) 學生只收到自己的投資，而且是即時的
    const mine = student.events.filter((e) => e.event === 'me').map((e) => JSON.parse(e.data) as MeState);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((m) => m.name === '乙')).toBe(true);
    expect(mine[mine.length - 1].courses.wed?.alloc).toEqual({ 第1組: 40 * W, 第3組: 50 * W });
    expect(mine[mine.length - 1].courses.wed?.remaining).toBe(10 * W);

    // 4) 封盤後才揭曉，含暗盤期間的走勢
    await phase(ctx, 'wed', 'close');
    const closed = await getState(ctx);
    expect(closed.courses.wed.groups.every((g) => g.total !== null && g.rank !== null)).toBe(true);
    expect((await getJson<Record<string, HistoryPoint[]>>(ctx, '/api/history')).wed.length).toBeGreaterThan(histAtDark.length);
  });

  it('進入暗盤開始倒數，倒數結束自動封盤並結算', async () => {
    const ctx = await start({ darkMs: 400 });
    await phase(ctx, 'wed', 'open');
    await invest(ctx, '甲', '第2組', 50 * W);
    await invest(ctx, '甲', '第3組', 50 * W);
    const screen = await sse(ctx, 'history=1');
    await phase(ctx, 'wed', 'dark');

    const dark = await getState(ctx);
    expect(dark.courses.wed.phase).toBe('dark');
    expect(dark.courses.wed.darkEndsAt! - dark.courses.wed.darkAt!).toBe(400);

    // 不需要任何人操作，時間到就自動封盤並推播結果
    const closedEvent = await screen.waitFor((e) => {
      if (e.event !== 'state') return false;
      return (JSON.parse(e.data) as PublicState).courses.wed.phase === 'closed';
    }, 2000);
    expect(closedEvent).not.toBeNull();
    const closedAt = (JSON.parse(closedEvent!.data) as PublicState).courses.wed;
    expect(closedAt.closedAt! - closedAt.darkEndsAt!).toBeGreaterThanOrEqual(0);
    expect(closedAt.closedAt! - closedAt.darkEndsAt!).toBeLessThan(500);
    expect(closedAt.results?.rocket).toBeDefined();
    expect((await invest(ctx, '甲', '第2組', 0)).body.error).toBe('closed');
  });

  it('暗盤倒數在伺服器重啟後接續（資料寫入磁碟）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invest-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const a = await start({ dataDir: dir, darkMs: 60_000 });
    await phase(a, 'wed', 'open');
    await invest(a, '甲', '第2組', 30 * W);
    await phase(a, 'wed', 'dark');
    await a.close();
    cleanups.splice(cleanups.indexOf(a.close), 1);

    const b = await start({ dataDir: dir, darkMs: 60_000 });
    const s = await getState(b);
    expect(s.courses.wed.phase).toBe('dark');
    expect((await getMe(b, '甲')).courses.wed?.alloc).toEqual({ 第2組: 30 * W });
  });
});

describe('即時同步', () => {
  it('學生投資後，大螢幕（SSE）在 2 秒內收到新的各組金額', async () => {
    const ctx = await start();
    await phase(ctx, 'wed', 'open');
    const screen = await sse(ctx, 'history=1');
    expect(await screen.waitFor((e) => e.event === 'history', 1000)).not.toBeNull();

    const latencies: number[] = [];
    const amounts = [10, 20, 35, 50, 5];
    for (const a of amounts) {
      const t0 = Date.now();
      expect((await invest(ctx, '甲', '第2組', a * W)).status).toBe(200);
      const got = await screen.waitFor((e) => {
        if (e.event !== 'state' || e.at < t0) return false;
        const st = JSON.parse(e.data) as PublicState;
        return st.courses.wed.groups.find((g) => g.id === '第2組')?.total === a * W;
      }, 2000);
      expect(got).not.toBeNull();
      latencies.push(got!.at - t0);
      // 走勢點也同步推送
      expect(
        await screen.waitFor((e) => e.event === 'point' && e.at >= t0 && JSON.parse(e.data).point.totals['第2組'] === a * W, 2000),
      ).not.toBeNull();
    }
    console.log(`大螢幕更新延遲（毫秒）：${latencies.join(', ')}；最大 ${Math.max(...latencies)}`);
    expect(Math.max(...latencies)).toBeLessThan(2000);
  });
});

describe('管理員', () => {
  it('管理員 API 需要密碼', async () => {
    const ctx = await start();
    const res = await fetch(ctx.base + '/api/admin/phase', {
      method: 'POST',
      headers: { 'x-admin-password': 'wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ course: 'wed', action: 'open' }),
    });
    expect(res.status).toBe(401);
    expect((await getState(ctx)).courses.wed.phase).toBe('pending');
  });

  it('切換場次、匯入名單、重置', async () => {
    const ctx = await start();
    await post(ctx, '/api/admin/active', { course: 'thu' }, true);
    expect((await getState(ctx)).active).toBe('thu');

    await phase(ctx, 'wed', 'open');
    await invest(ctx, '甲', '第2組', 30 * W);
    await invest(ctx, '乙', '第3組', 30 * W);

    // 只匯入週三：乙改到第3組 → 投給第3組的錢退回；丙被移除；週四名單不受影響
    const csv = '姓名,課堂,組別\n甲,週三,第1組\n乙,週三,第3組\n己,週三,第2組\n';
    const preview = await post(ctx, '/api/admin/roster/preview', { csv }, true);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.courses).toEqual(['wed']);
    expect((preview.body.dropped as unknown[]).length).toBe(1);
    expect((await post(ctx, '/api/admin/roster', { csv }, true)).status).toBe(200);
    expect((await getMe(ctx, '乙')).courses.wed?.alloc).toEqual({});
    expect((await post(ctx, '/api/login', { name: '丙' })).status).toBe(404);
    expect((await getMe(ctx, '丁')).courses.thu?.group).toBe('第1組');

    expect((await post(ctx, '/api/admin/roster', { csv: '甲,週五,第1組' }, true)).status).toBe(400);

    await post(ctx, '/api/admin/reset', { course: 'wed' }, true);
    const s = await getState(ctx);
    expect(s.courses.wed.phase).toBe('pending');
    expect(s.courses.wed.groups.every((g) => g.total === 0)).toBe(true);
  });
});
