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
    const key = generateSyncKey();
    const repo = await GitHubDataRepo.initialize(client, key, { channels });
    const ref = await repo.putAttachment({ name: '行程.png', type: 'image/png', bytes: PNG });
    expect(ref).toMatchObject({ name: '行程.png', type: 'image/png', size: PNG.length, enc: 'bin' });
    const blob = gh.readBytes('tnda-data', `files/${ref.id}.bin`)!;
    expect(blob.subarray(0, 6).toString()).toBe('TNDAF1');
    // 二進位儲存：只比原檔多檔頭、IV 與驗證碼，不像 base64 會多 1/3
    expect(blob.length).toBe(PNG.length + 6 + 12 + 16);
    expect(blob.includes(Buffer.from(PNG))).toBe(false);
    expect((await repo.getAttachment(ref)).bytes).toEqual(PNG);
    // 重新開啟（從 tree 取得 sha）也讀得到
    const again = await GitHubDataRepo.open(client, key);
    await again.load();
    expect((await again.getAttachment(ref)).bytes).toEqual(PNG);
  });

  it('附檔換了別的路徑就解不開（路徑綁在密文裡）', async () => {
    const gh = createFakeGitHub();
    const client = new GitHubClient({ owner: 'demo', repo: 'TNDA', token: 't', fetch: gh.fetch });
    const key = generateSyncKey();
    const repo = await GitHubDataRepo.initialize(client, key, { channels });
    const a = await repo.putAttachment({ name: 'a.png', type: 'image/png', bytes: PNG });
    const b = await repo.putAttachment({ name: 'b.png', type: 'image/png', bytes: PNG });
    const branch = gh.branches.get('tnda-data')!;
    branch.files.set(`files/${b.id}.bin`, branch.files.get(`files/${a.id}.bin`)!);
    const fresh = await GitHubDataRepo.open(client, key);
    await fresh.load();
    await expect(fresh.getAttachment(b)).rejects.toThrow();
  });

  it('仍讀得到舊版（JSON + base64）附檔', async () => {
    const gh = createFakeGitHub();
    const client = new GitHubClient({ owner: 'demo', repo: 'TNDA', token: 't', fetch: gh.fetch });
    const key = generateSyncKey();
    const repo = await GitHubDataRepo.initialize(client, key, { channels });
    await repo.write('files/fold.json', { name: '舊.png', type: 'image/png', data: Buffer.from(PNG).toString('base64') }, 'old');
    const ref = { id: 'fold', name: '舊.png', type: 'image/png', size: PNG.length };
    expect((await repo.getAttachment(ref)).bytes).toEqual(PNG);
    const fresh = await GitHubDataRepo.open(client, key);
    await fresh.load();
    expect((await fresh.getAttachment(ref)).bytes).toEqual(PNG);
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

  it('舊版匯入檔的 base64 附檔仍可使用', async () => {
    const b64 = Buffer.from(PNG).toString('base64');
    const bundle = { tnda: 'import', v: 1, posts: [{ title: 't', at: '2026-10-22T12:00:00+08:00', to: [{ id: 'a' }], content: 'x', attachments: [{ name: '01.webp', data: b64 }, { name: 'b.png', type: 'image/png', data: `data:image/png;base64,${b64}` }] }] };
    const files = parseImportBundle(JSON.stringify(bundle)).posts[0].attachments!;
    expect(files[0]).toMatchObject({ name: '01.webp', type: 'image/webp', size: PNG.length });
    expect(await files[0].source.read()).toEqual(PNG);
    // 內容相同的檔案共用同一個來源，只上傳一次
    expect(files[1].source).toBe(files[0].source);
    expect(() => parseImportBundle(JSON.stringify({ ...bundle, posts: [{ ...bundle.posts[0], attachments: [{ name: 'x' }] }] }))).toThrow('格式不正確');
  });
});
