// 端對端：啟動真的 HTTP 伺服器，驗證伺服器端規則、暗盤保密、自動封盤、即時推播與存檔。
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app.ts';
import { createStore, type Store } from '../server/store.ts';
import type { MeState, PublicState, RosterEntry } from '../shared/types.ts';

const W = 10_000;
const ADMIN = 'secret';

const roster: RosterEntry[] = [
  { name: '甲', course: 'wed', group: '第1組' },
  { name: '乙', course: 'wed', group: '第2組' },
  { name: '丙', course: 'wed', group: '第3組' },
  { name: '甲', course: 'thu', group: '第2組' },
  { name: '丁', course: 'thu', group: '第1組' },
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
  const server = createApp(store, { adminPassword: ADMIN, staticDir: null, broadcastMs: 20 });
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

async function getState(ctx: Ctx): Promise<PublicState> {
  return (await (await fetch(ctx.base + '/api/state')).json()) as PublicState;
}

const invest = (ctx: Ctx, name: string, group: string, amount: number, course = 'wed') =>
  post(ctx, '/api/invest', { name, course, group, amount });

describe('伺服器', () => {
  it('登入：只認名單上的姓名，並回傳所屬課堂', async () => {
    const ctx = await start();
    const ok = await post(ctx, '/api/login', { name: ' 甲 ' });
    expect(ok.status).toBe(200);
    const me = ok.body as unknown as MeState;
    expect(me.name).toBe('甲');
    expect(me.courses.wed?.group).toBe('第1組');
    expect(me.courses.thu?.group).toBe('第2組');
    expect(me.courses.wed?.remaining).toBe(100 * W);
    const bad = await post(ctx, '/api/login', { name: '路人' });
    expect(bad.status).toBe(404);
  });

  it('所有投資規則都在伺服器端驗證', async () => {
    const ctx = await start();
    expect((await invest(ctx, '甲', '第2組', 10 * W)).body.error).toBe('not_open');
    await post(ctx, '/api/admin/phase', { course: 'wed', action: 'open' }, true);

    expect((await invest(ctx, '甲', '第1組', 10 * W)).body.error).toBe('own_group');
    expect((await invest(ctx, '甲', '第2組', 50 * W + 1)).body.error).toBe('over_limit');
    expect((await invest(ctx, '甲', '第2組', -5)).body.error).toBe('bad_amount');
    expect((await invest(ctx, '甲', '第9組', 10 * W)).body.error).toBe('unknown_group');
    expect((await invest(ctx, '丁', '第2組', 10 * W)).body.error).toBe('not_in_course');
    expect((await invest(ctx, '路人', '第2組', 10 * W)).status).toBe(404);

    const r1 = await invest(ctx, '甲', '第2組', 50 * W);
    expect(r1.status).toBe(200);
    const r2 = await invest(ctx, '甲', '第3組', 50 * W);
    expect((r2.body as unknown as MeState).courses.wed?.remaining).toBe(0);
    // 撤回、調整
    const r3 = await invest(ctx, '甲', '第2組', 20 * W);
    expect((r3.body as unknown as MeState).courses.wed?.alloc).toEqual({ 第2組: 20 * W, 第3組: 50 * W });

    // 兩堂課的錢互不相通：週四仍是 100 萬（週四還沒開盤）
    expect((await invest(ctx, '甲', '第1組', 10 * W, 'thu')).body.error).toBe('not_open');

    const state = await getState(ctx);
    const totals = Object.fromEntries(state.courses.wed.groups.map((g) => [g.id, g.total]));
    expect(totals).toEqual({ 第1組: 0, 第2組: 20 * W, 第3組: 50 * W });
  });

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

  it('暗盤隱藏金額與排名，學生仍可調整，倒數結束自動封盤並結算', async () => {
    const ctx = await start({ darkMs: 300 });
    await post(ctx, '/api/admin/phase', { course: 'wed', action: 'open' }, true);
    await invest(ctx, '甲', '第2組', 50 * W);
    await invest(ctx, '甲', '第3組', 50 * W);
    await invest(ctx, '乙', '第1組', 50 * W);
    expect((await post(ctx, '/api/admin/phase', { course: 'wed', action: 'dark' }, true)).status).toBe(200);

    const dark = await getState(ctx);
    expect(dark.courses.wed.phase).toBe('dark');
    expect(dark.courses.wed.groups.every((g) => g.total === null && g.rank === null)).toBe(true);
    expect(dark.courses.wed.darkEndsAt! - dark.courses.wed.darkAt!).toBe(300);
    // 暗盤期間公開的走勢不含暗盤後的變動
    const histBefore = (await (await fetch(ctx.base + '/api/history')).json()) as Record<string, unknown[]>;

    const during = await invest(ctx, '乙', '第3組', 30 * W);
    expect(during.status).toBe(200);
    expect((during.body as unknown as MeState).courses.wed?.alloc).toEqual({ 第1組: 50 * W, 第3組: 30 * W });
    const histDuring = (await (await fetch(ctx.base + '/api/history')).json()) as Record<string, unknown[]>;
    expect(histDuring.wed).toEqual(histBefore.wed);

    await new Promise((r) => setTimeout(r, 450));
    const closed = await getState(ctx);
    expect(closed.courses.wed.phase).toBe('closed');
    const results = closed.courses.wed.results!;
    // 第1組：乙投 50 萬；甲全投完 → 不倒扣 = 50 萬
    // 第2組：甲投 50 萬；乙剩 20 萬 → 倒扣 = 30 萬
    // 第3組：甲 50 + 乙 30 = 80 萬；丙完全沒投 → 倒扣 100 萬 = −20 萬
    expect(results.groups.map((g) => [g.group, g.final, g.rank, g.multiplier])).toEqual([
      ['第1組', 50 * W, 1, 3],
      ['第2組', 30 * W, 2, 2],
      ['第3組', -20 * W, 3, 1.5],
    ]);
    expect(results.rocket).toEqual(['第1組']);
    // 甲 = 50×2 + 50×1.5 = 175 萬；乙 = 50×3 + 30×1.5 = 195 萬
    expect(results.stockGods).toEqual(['乙']);

    // 封盤後不能再投
    expect((await invest(ctx, '甲', '第2組', 0)).body.error).toBe('closed');
    const me = (await (await fetch(ctx.base + '/api/me?name=' + encodeURIComponent('甲'))).json()) as MeState;
    expect(me.courses.wed?.result).toEqual({ payout: 175 * W, rank: 2, of: 3 });

    // 封盤後揭曉完整走勢（含暗盤期間）
    const histAfter = (await (await fetch(ctx.base + '/api/history')).json()) as Record<string, unknown[]>;
    expect(histAfter.wed.length).toBeGreaterThan(histBefore.wed.length);

    const csv = await (await fetch(ctx.base + '/api/admin/results.csv?course=wed', { headers: { 'x-admin-password': ADMIN } })).text();
    expect(csv).toContain('第3組');
    expect(csv).toContain('股神獎,乙');
  });

  it('學生操作後透過 SSE 推播到大螢幕（2 秒內）', async () => {
    const ctx = await start();
    await post(ctx, '/api/admin/phase', { course: 'wed', action: 'open' }, true);
    const controller = new AbortController();
    const res = await fetch(ctx.base + '/api/events?history=1', { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const waitFor = async (pred: (event: string, data: string) => boolean, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
          const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
          if (pred(event, data)) return true;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
        ]);
        if (!chunk || chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return false;
    };
    expect(await waitFor((e) => e === 'history', 1000)).toBe(true);

    const t0 = Date.now();
    await invest(ctx, '甲', '第2組', 40 * W);
    const gotState = await waitFor((e, d) => {
      if (e !== 'state') return false;
      const s = JSON.parse(d) as PublicState;
      return s.courses.wed.groups.find((g) => g.id === '第2組')?.total === 40 * W;
    }, 2000);
    expect(gotState).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    controller.abort();
  });

  it('切換場次、匯入名單、重置', async () => {
    const ctx = await start();
    await post(ctx, '/api/admin/active', { course: 'thu' }, true);
    expect((await getState(ctx)).active).toBe('thu');

    await post(ctx, '/api/admin/phase', { course: 'wed', action: 'open' }, true);
    await invest(ctx, '甲', '第2組', 30 * W);
    await invest(ctx, '乙', '第3組', 30 * W);

    // 只匯入週三：乙改到第3組 → 投給第3組的錢退回；丙被移除；週四名單不受影響
    const csv = '姓名,課堂,組別\n甲,週三,第1組\n乙,週三,第3組\n戊,週三,第2組\n';
    const preview = await post(ctx, '/api/admin/roster/preview', { csv }, true);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.courses).toEqual(['wed']);
    expect((preview.body.dropped as unknown[]).length).toBe(1);
    const applied = await post(ctx, '/api/admin/roster', { csv }, true);
    expect(applied.status).toBe(200);
    const me = (await post(ctx, '/api/login', { name: '乙' })).body as unknown as MeState;
    expect(me.courses.wed?.alloc).toEqual({});
    expect((await post(ctx, '/api/login', { name: '丙' })).status).toBe(404);
    expect(((await post(ctx, '/api/login', { name: '丁' })).body as unknown as MeState).courses.thu?.group).toBe('第1組');

    const bad = await post(ctx, '/api/admin/roster', { csv: '甲,週五,第1組' }, true);
    expect(bad.status).toBe(400);

    await post(ctx, '/api/admin/reset', { course: 'wed' }, true);
    const s = await getState(ctx);
    expect(s.courses.wed.phase).toBe('pending');
    expect(s.courses.wed.groups.every((g) => g.total === 0)).toBe(true);
  });

  it('資料寫入磁碟，重啟後還原（含進行中的暗盤倒數）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'invest-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const a = await start({ dataDir: dir, darkMs: 60_000 });
    await post(a, '/api/admin/phase', { course: 'wed', action: 'open' }, true);
    await invest(a, '甲', '第2組', 30 * W);
    await post(a, '/api/admin/phase', { course: 'wed', action: 'dark' }, true);
    await a.close();
    cleanups.splice(cleanups.indexOf(a.close), 1);

    const b = await start({ dataDir: dir, darkMs: 60_000 });
    const s = await getState(b);
    expect(s.courses.wed.phase).toBe('dark');
    const me = (await post(b, '/api/login', { name: '甲' })).body as unknown as MeState;
    expect(me.courses.wed?.alloc).toEqual({ 第2組: 30 * W });
  });
});
