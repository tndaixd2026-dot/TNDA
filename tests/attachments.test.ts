import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/core/github.ts';
import { GitHubDataRepo } from '../src/core/repo.ts';
import { generateSyncKey } from '../src/core/crypto.ts';
import { attachmentProblems, executeWebhook, webhookBody } from '../src/core/discord.ts';
import { deliverClaimed, claim } from '../src/core/delivery.ts';
import { channelMap } from '../src/core/engine.ts';
import { parseImportBundle } from '../src/data/importer.ts';
import { runScheduler } from '../scripts/scheduler.ts';
import type { Channel, Post } from '../src/core/types.ts';
import { createFakeGitHub, webhook } from './fakes.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
const channels: Channel[] = [{ id: 'a', name: '公告欄', group: 'A', groupName: '大群組', audience: 'student', kind: 'announce', webhook: webhook(1) }];

describe('附檔', () => {
  it('有附檔時用 multipart 送出，payload_json 標示每個檔案', async () => {
    const { body } = webhookBody({ content: 'hi' }, [{ name: 'a.png', type: 'image/png', bytes: PNG }, { name: 'b.pdf', type: 'application/pdf', bytes: PNG }]);
    const form = body as FormData;
    expect(JSON.parse(String(form.get('payload_json')))).toEqual({ content: 'hi', attachments: [{ id: 0, filename: 'a.png' }, { id: 1, filename: 'b.pdf' }] });
    const f0 = form.get('files[0]') as File;
    expect(f0.name).toBe('a.png');
    expect(new Uint8Array(await f0.arrayBuffer())).toEqual(PNG);
    expect(webhookBody({ content: 'hi' }).headers['Content-Type']).toBe('application/json');
  });

  it('executeWebhook 帶附檔時不設定 JSON Content-Type', async () => {
    let init: RequestInit | undefined;
    const fake = (async (_u: string, i: RequestInit) => {
      init = i;
      return new Response('{"id":"9"}', { status: 200 });
    }) as typeof fetch;
    const r = await executeWebhook(webhook(1), { content: 'x' }, fake, [{ name: 'a.png', type: 'image/png', bytes: PNG }]);
    expect(r.ok).toBe(true);
    expect(init!.body).toBeInstanceOf(FormData);
    expect((init!.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('檢查數量與總大小', () => {
    expect(attachmentProblems([{ size: 9 * 1024 * 1024 }])).toEqual([]);
    expect(attachmentProblems([{ size: 6e6 }, { size: 6e6 }]).join()).toMatch('10 MB');
    expect(attachmentProblems(Array.from({ length: 11 }, () => ({ size: 1 }))).join()).toMatch('最多 10 個');
  });

  it('加密存到資料分支，讀回來內容相同', async () => {
    const gh = createFakeGitHub();
    const client = new GitHubClient({ owner: 'demo', repo: 'TNDA', token: 't', fetch: gh.fetch });
    const repo = await GitHubDataRepo.initialize(client, generateSyncKey(), { channels });
    const ref = await repo.putAttachment({ name: '行程.png', type: 'image/png', bytes: PNG });
    expect(ref).toMatchObject({ name: '行程.png', type: 'image/png', size: PNG.length });
    const text = gh.readText('tnda-data', `files/${ref.id}.json`)!;
    expect(text).not.toContain('行程');
    expect(text).toContain('"ct"');
    expect((await repo.getAttachment(ref)).bytes).toEqual(PNG);
  });

  it('發送時讀取附檔一起送；讀不到時標記失敗並稍後重試', async () => {
    const post = { id: 'p', title: 't', type: 'announce', channels: ['a'], sendAt: new Date().toISOString(), status: 'scheduled', payload: { content: 'x' }, deliveries: {}, createdAt: '', updatedAt: '', attachments: [{ id: 'f1', name: 'a.png', type: 'image/png', size: 9 }] } as Post;
    const claimed = claim(post, 'me', Date.now())!;
    const sent: unknown[] = [];
    const ok = await deliverClaimed(claimed, 'me', {
      channels: channelMap(channels),
      send: async (_u, _p, files) => {
        sent.push(files);
        return { ok: true, messageId: '1' };
      },
      loadFiles: async () => [{ name: 'a.png', type: 'image/png', bytes: PNG }],
    });
    expect(ok.status).toBe('sent');
    expect(sent[0]).toEqual([{ name: 'a.png', type: 'image/png', bytes: PNG }]);
    const bad = await deliverClaimed(claimed, 'me', {
      channels: channelMap(channels),
      send: async () => ({ ok: true }),
      loadFiles: async () => {
        throw new Error('壞掉');
      },
    });
    expect(bad.deliveries.a).toMatchObject({ status: 'failed', retryable: true });
    expect(bad.deliveries.a.error).toMatch('附檔讀取失敗');
  });

  it('排程器會把附檔一起發到 Discord', async () => {
    const gh = createFakeGitHub();
    const client = new GitHubClient({ owner: 'demo', repo: 'TNDA', token: 't', fetch: gh.fetch });
    const key = generateSyncKey();
    const repo = await GitHubDataRepo.initialize(client, key, { channels });
    const ref = await repo.putAttachment({ name: 'a.png', type: 'image/png', bytes: PNG });
    const t0 = new Date('2026-10-21T13:40:00Z');
    await repo.createPost({ id: 'p1', title: 't', type: 'announce', channels: ['a'], sendAt: t0.toISOString(), status: 'scheduled', payload: { content: '參訪行程' }, deliveries: {}, createdAt: '', updatedAt: '', attachments: [ref] });
    const calls: Array<{ files?: unknown[] }> = [];
    const r = await runScheduler({ client, syncKey: key, now: () => t0, log: () => {}, send: async (_u, _p, files) => (calls.push({ files }), { ok: true, messageId: '1' }) });
    expect(r.sent).toBe(1);
    expect(calls[0].files).toEqual([{ name: 'a.png', type: 'image/png', bytes: PNG }]);
  });

  it('匯入檔可以附 base64 檔案', () => {
    const b64 = Buffer.from(PNG).toString('base64');
    const bundle = { tnda: 'import', v: 1, posts: [{ title: 't', at: '2026-10-22T12:00:00+08:00', to: [{ id: 'a' }], content: 'x', attachments: [{ name: '01.webp', data: b64 }, { name: 'b.png', type: 'image/png', data: `data:image/png;base64,${b64}` }] }] };
    const files = parseImportBundle(JSON.stringify(bundle)).posts[0].attachments!;
    expect(files[0]).toEqual({ name: '01.webp', type: 'image/webp', data: b64, size: PNG.length });
    expect(files[1].data).toBe(b64);
    expect(() => parseImportBundle(JSON.stringify({ ...bundle, posts: [{ ...bundle.posts[0], attachments: [{ name: 'x' }] }] }))).toThrow('格式不正確');
  });
});
