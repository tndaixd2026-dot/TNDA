import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/core/github.ts';
import { GitHubDataRepo, PATHS, DEFAULT_DATA_BRANCH } from '../src/core/repo.ts';
import { generateSyncKey } from '../src/core/crypto.ts';
import { executeWebhook } from '../src/core/discord.ts';
import type { Channel, Post } from '../src/core/types.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';
import { runScheduler } from '../scripts/scheduler.ts';
import { createFakeDiscord, createFakeGitHub, webhook, webhookId } from './fakes.ts';

const T0 = new Date('2026-10-14T12:00:00Z');

function channels(): Channel[] {
  return [
    { id: 'b-homework', name: '課後作業', group: 'B', groupName: 'VSAI', audience: 'student', kind: 'homework', webhook: webhook(1) },
    { id: 'c-homework', name: '課後作業', group: 'C', groupName: 'TN0006', audience: 'student', kind: 'homework', webhook: webhook(2) },
    { id: 'no-hook', name: '沒設定', group: 'C', groupName: 'TN0006', audience: 'student', kind: 'other' },
  ];
}

function post(id: string, sendAt: Date, extra: Partial<Post> = {}): Post {
  return {
    id,
    title: '作業提醒',
    type: 'homework',
    channels: ['b-homework', 'c-homework'],
    sendAt: sendAt.toISOString(),
    status: 'scheduled',
    payload: { embeds: [{ title: '📝 作業提醒', description: '記得交作業' }] },
    deliveries: {},
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...extra,
  };
}

async function setup(posts: Post[]) {
  const gh = createFakeGitHub();
  const dc = createFakeDiscord();
  const key = generateSyncKey();
  const client = new GitHubClient({ owner: 'demo', repo: 'TNDA', token: 't', fetch: gh.fetch });
  const repo = await GitHubDataRepo.initialize(client, key, { channels: channels(), settings: { ...DEFAULT_SETTINGS, senderName: '課務小幫手' } });
  for (const p of posts) await repo.createPost(p);
  let clock = T0.getTime();
  const run = (extra: Partial<Parameters<typeof runScheduler>[0]> = {}) =>
    runScheduler({
      client,
      syncKey: key,
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      send: (url, payload) => executeWebhook(url, payload, dc.fetch),
      log: () => {},
      runId: '42',
      ...extra,
    });
  const reload = async () => (await (await GitHubDataRepo.open(client, key)).load()).posts;
  return { gh, dc, key, client, repo, run, reload, advance: (ms: number) => (clock += ms) };
}

describe('排程器', () => {
  it('到期的貼文會發到每個頻道並記錄 messageId', async () => {
    const s = await setup([post('p_due', new Date(T0.getTime() - 60000)), post('p_later', new Date(T0.getTime() + 3600000))]);
    const r = await s.run();
    expect(r.due).toBe(1);
    expect(r.sent).toBe(1);
    expect(s.dc.sent).toHaveLength(2);
    expect(s.dc.sent[0].body.username).toBe('課務小幫手');
    expect(s.dc.sent[0].body.allowed_mentions).toEqual({ parse: [] });
    const posts = await s.reload();
    const sent = posts.find((p) => p.id === 'p_due')!;
    expect(sent.status).toBe('sent');
    expect(sent.deliveries['b-homework'].messageId).toBeTruthy();
    expect(sent.sentAt).toBeTruthy();
    expect(posts.find((p) => p.id === 'p_later')!.status).toBe('scheduled');
  });

  it('不會重複發送：第二次執行不再發', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000))]);
    await s.run();
    await s.run();
    expect(s.dc.sent).toHaveLength(2);
  });

  it('lookahead 內的貼文會等待到時間才發送', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() + 120000))]);
    const r = await s.run({ lookaheadMs: 290000 });
    expect(r.sent).toBe(1);
    const p = (await s.reload())[0];
    expect(Date.parse(p.deliveries['b-homework'].sentAt!)).toBeGreaterThanOrEqual(T0.getTime() + 120000);
  });

  it('草稿與已取消的貼文不會發送', async () => {
    const s = await setup([
      post('p_draft', new Date(T0.getTime() - 60000), { status: 'draft' }),
      post('p_cancel', new Date(T0.getTime() - 60000), { status: 'canceled' }),
    ]);
    const r = await s.run();
    expect(r.due).toBe(0);
    expect(s.dc.sent).toHaveLength(0);
  });

  it('Webhook 已刪除（404）→ 該頻道失敗、不重試，其他頻道照發 → partial', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000))]);
    s.dc.responses.set(webhookId(2), [{ status: 404, body: { message: 'Unknown Webhook', code: 10015 } }]);
    const r = await s.run();
    expect(r.partial).toBe(1);
    const p = (await s.reload())[0];
    expect(p.status).toBe('partial');
    expect(p.deliveries['c-homework'].status).toBe('failed');
    expect(p.deliveries['c-homework'].retryable).toBe(false);
    expect(p.deliveries['c-homework'].error).toContain('Webhook 不存在');
  });

  it('Discord 暫時故障（500）→ 稍後自動重試成功', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000))]);
    s.dc.responses.set(webhookId(1), [{ status: 500 }]);
    const r1 = await s.run();
    expect(r1.retrying).toBe(1);
    expect((await s.reload())[0].status).toBe('scheduled');
    // 重試間隔前不會再試
    await s.run();
    expect(s.dc.sent).toHaveLength(1);
    s.advance(5 * 60000);
    const r3 = await s.run();
    expect(r3.sent).toBe(1);
    expect(s.dc.sent).toHaveLength(2);
    const p = (await s.reload())[0];
    expect(p.deliveries['b-homework'].attempts).toBe(2);
    expect(p.status).toBe('sent');
  });

  it('429 會等待 retry_after 後在同一次執行內重試', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000))]);
    s.dc.responses.set(webhookId(1), [{ status: 429, body: { message: 'rate limited', retry_after: 1.5 } }]);
    const r = await s.run();
    expect(r.sent).toBe(1);
    expect(s.dc.sent).toHaveLength(2);
  });

  it('沒有 Webhook 的頻道記錄為失敗', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000), { channels: ['no-hook'] })]);
    const r = await s.run();
    expect(r.failed).toBe(1);
    expect((await s.reload())[0].deliveries['no-hook'].error).toContain('還沒有設定 Webhook');
  });

  it('寫回時遇到衝突會重新讀取再合併', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000))]);
    s.gh.injectConflict(PATHS.post('p1'));
    const r = await s.run();
    expect(r.sent).toBe(1);
    expect((await s.reload())[0].status).toBe('sent');
    expect(s.dc.sent).toHaveLength(2);
  });

  it('使用者在發送前改了時間 → 不發送', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() - 60000))]);
    // 在排程器讀完資料、準備認領前，使用者把時間改到明天
    const tomorrow = new Date(T0.getTime() + 86400000).toISOString();
    s.gh.injectConflict(PATHS.post('p1'));
    const repo = await GitHubDataRepo.open(s.client, s.key);
    await repo.load();
    await repo.updatePost('p1', (p) => ({ ...p, sendAt: tomorrow }));
    // 重新建立一個排程器（它讀到的是舊的快照也沒關係，認領時會讀最新）
    const r = await s.run();
    expect(r.sent).toBe(0);
    expect(s.dc.sent).toHaveLength(0);
  });

  it('每週重複的貼文：發送後建立下週的貼文，並把時間戳往後推', async () => {
    const at = new Date(T0.getTime() - 60000);
    const ev = Math.floor((T0.getTime() + 86400000) / 1000);
    const s = await setup([
      post('p1', at, {
        repeat: { freq: 'weekly', interval: 1 },
        payload: { embeds: [{ title: 'x', fields: [{ name: '時間', value: `<t:${ev}:F>` }] }] },
      }),
    ]);
    const r = await s.run();
    expect(r.created).toBe(1);
    const posts = await s.reload();
    expect(posts).toHaveLength(2);
    const next = posts.find((p) => p.id !== 'p1')!;
    expect(Date.parse(next.sendAt) - at.getTime()).toBe(7 * 86400000);
    expect(next.status).toBe('scheduled');
    expect(next.series).toBe('p1');
    expect(next.payload.embeds![0].fields![0].value).toBe(`<t:${ev + 7 * 86400}:F>`);
  });

  it('重複貼文超過結束日期就停止', async () => {
    const at = new Date(T0.getTime() - 60000);
    const s = await setup([post('p1', at, { repeat: { freq: 'weekly', interval: 1, until: new Date(T0.getTime() + 86400000).toISOString() } })]);
    const r = await s.run();
    expect(r.created).toBe(0);
  });

  it('卡在發送中超過 15 分鐘 → 標記狀態不明，不自動重發', async () => {
    const claimedAt = new Date(T0.getTime() - 20 * 60000).toISOString();
    const s = await setup([
      post('p1', new Date(T0.getTime() - 30 * 60000), {
        status: 'sending',
        deliveries: {
          'b-homework': { status: 'sending', attempts: 0, claimedAt, claimedBy: 'browser:x' },
          'c-homework': { status: 'sent', attempts: 1, sentAt: claimedAt, messageId: '9' },
        },
      }),
    ]);
    const r = await s.run();
    expect(r.recovered).toBe(1);
    expect(s.dc.sent).toHaveLength(0);
    const p = (await s.reload())[0];
    expect(p.status).toBe('partial');
    expect(p.deliveries['b-homework'].error).toContain('狀態不明');
  });

  it('資料分支不存在時回報 not-initialized', async () => {
    const gh = createFakeGitHub();
    const client = new GitHubClient({ owner: 'demo', repo: 'TNDA', token: 't', fetch: gh.fetch });
    const r = await runScheduler({ client, syncKey: generateSyncKey(), log: () => {} });
    expect(r.status).toBe('not-initialized');
  });

  it('金鑰錯誤時回報 key-mismatch', async () => {
    const s = await setup([]);
    const r = await runScheduler({ client: s.client, syncKey: generateSyncKey(), log: () => {} });
    expect(r.status).toBe('key-mismatch');
  });

  it('存在 repo 裡的檔案全部是密文', async () => {
    const s = await setup([post('p1', new Date(T0.getTime() + 60000))]);
    const text = s.gh.readText(DEFAULT_DATA_BRANCH, PATHS.post('p1'))!;
    expect(text).not.toContain('作業');
    expect(s.gh.readText(DEFAULT_DATA_BRANCH, PATHS.channels)).not.toContain('discord.com');
  });
});

describe('瀏覽器連不到 Discord', () => {
  it('交還給排程器，排程器下一輪發送，不重複', async () => {
    const { deliverClaimed, claim } = await import('../src/core/delivery.ts');
    const { channelMap } = await import('../src/core/engine.ts');
    const p = post('p1', new Date(T0.getTime() - 1000));
    const claimed = claim(p, 'browser:abc', T0.getTime())!;
    const out = await deliverClaimed(claimed, 'browser:abc', {
      channels: channelMap(channels()),
      send: async () => ({ ok: false, error: '無法連線', retryable: true, networkError: true }),
    });
    expect(out.status).toBe('scheduled');
    expect(out.deliveries['b-homework'].status).toBe('pending');
    expect(out.deliveries['b-homework'].attempts).toBe(0);
  });
});
