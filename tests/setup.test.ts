import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSource, testCronToken } from '../src/data/setup.ts';

describe('runSource', () => {
  it('依 run-name 判斷觸發來源', () => {
    expect(runSource({ event: 'schedule', display_title: '排程發送（GitHub 定時）' })).toBe('schedule');
    expect(runSource({ event: 'workflow_dispatch', display_title: '排程發送（外部定時器）' })).toBe('cron');
    expect(runSource({ event: 'workflow_dispatch', display_title: '排程發送（定時器測試）' })).toBe('test');
    expect(runSource({ event: 'workflow_dispatch', display_title: '排程發送（手動）' })).toBe('manual');
    // 加上 run-name 之前的舊紀錄分不出來源
    expect(runSource({ event: 'workflow_dispatch', display_title: '排程發送' })).toBe('dispatch');
  });
});

describe('testCronToken', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (status: number) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 204 ? null : JSON.stringify({ message: 'x' }), { status });
    });
    return calls;
  };

  it('用貼上的 Token 觸發排程器（自動去掉 Bearer 前綴）', async () => {
    const calls = stub(204);
    const res = await testCronToken('me', 'TNDA', '  Bearer github_pat_abc ', 'main');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/repos/me/TNDA/actions/workflows/scheduler.yml/dispatches');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer github_pat_abc');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ref: 'main', inputs: { reason: 'test' } });
  });

  it('把常見錯誤翻成可以照著修的說明', async () => {
    stub(401);
    expect((await testCronToken('me', 'TNDA', 'bad', 'main')).message).toMatch(/無效或已過期/);
    stub(403);
    expect((await testCronToken('me', 'TNDA', 'tok', 'main')).message).toMatch(/Actions/);
    stub(404);
    expect((await testCronToken('me', 'TNDA', 'tok', 'main')).message).toMatch(/me\/TNDA/);
  });

  it('沒有貼 Token 時不送出請求', async () => {
    const calls = stub(204);
    expect((await testCronToken('me', 'TNDA', ' Bearer ', 'main')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
