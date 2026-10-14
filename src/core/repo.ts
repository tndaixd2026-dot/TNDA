// 資料層：把貼文、頻道、設定加密後存到 GitHub repo 的資料分支（預設 tnda-data）。
// 每則貼文一個檔案，寫入時用 sha 比對避免覆蓋別人的更新。

import type { Channel, Envelope, Post, RepoMeta, Settings } from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { decryptJSON, encryptJSON, importSyncKey, isEnvelope } from './crypto.ts';
import { GitHubClient, GitHubError, isConflict } from './github.ts';

export const DEFAULT_DATA_BRANCH = 'tnda-data';
export const SCHEDULER_WORKFLOW = 'scheduler.yml';
export const SECRET_NAME = 'TNDA_SYNC_KEY';

export const PATHS = {
  meta: 'meta.json',
  channels: 'channels.json',
  settings: 'settings.json',
  post: (id: string) => `posts/${id}.json`,
};

const KEY_CHECK = 'tnda-relay-key-ok';

export class KeyMismatchError extends Error {
  constructor() {
    super('同步金鑰不正確，無法解開資料。');
    this.name = 'KeyMismatchError';
  }
}

export class NotInitializedError extends Error {
  constructor(branch: string) {
    super(`資料分支 ${branch} 還不存在，請先完成初始設定。`);
    this.name = 'NotInitializedError';
  }
}

export interface Snapshot {
  channels: Channel[];
  settings: Settings;
  posts: Post[];
  /** 無法解密或格式錯誤而略過的檔案 */
  skipped: string[];
}

export interface BlobCache {
  get(sha: string): Promise<string | undefined>;
  set(sha: string, text: string): Promise<void>;
}

export class MemoryBlobCache implements BlobCache {
  private map = new Map<string, string>();
  async get(sha: string) {
    return this.map.get(sha);
  }
  async set(sha: string, text: string) {
    this.map.set(sha, text);
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const DATA_README = `# TNDA Relay 資料分支

這個分支由 TNDA Relay 自動管理，請不要手動修改。

- 所有貼文、頻道（含 Discord Webhook）與設定都以 AES-256-GCM 加密。
- 解密需要「同步金鑰」，只存在你的裝置與 GitHub Actions Secret（TNDA_SYNC_KEY）中。
- 檔名只是隨機代號，不包含貼文內容。
`;

export class GitHubDataRepo {
  client: GitHubClient;
  branch: string;
  private key: CryptoKey;
  private cache: BlobCache;
  /** 路徑 → 目前已知的 blob sha */
  shas = new Map<string, string>();

  constructor(client: GitHubClient, key: CryptoKey, opts: { branch?: string; cache?: BlobCache } = {}) {
    this.client = client;
    this.key = key;
    this.branch = opts.branch ?? DEFAULT_DATA_BRANCH;
    this.cache = opts.cache ?? new MemoryBlobCache();
  }

  static async open(
    client: GitHubClient,
    syncKey: string,
    opts: { branch?: string; cache?: BlobCache } = {},
  ): Promise<GitHubDataRepo> {
    return new GitHubDataRepo(client, await importSyncKey(syncKey), opts);
  }

  /** 檢查資料分支狀態：不存在 / 金鑰錯誤 / 正常 */
  static async inspect(client: GitHubClient, syncKey: string | null, branch = DEFAULT_DATA_BRANCH) {
    const meta = await client.getFile(PATHS.meta, branch);
    if (!meta) return 'missing' as const;
    if (!syncKey) return 'exists' as const;
    try {
      const key = await importSyncKey(syncKey);
      const parsed = JSON.parse(meta.text) as RepoMeta;
      const check = await decryptJSON<{ ok: string }>(key, parsed.keyCheck, PATHS.meta);
      return check.ok === KEY_CHECK ? ('ok' as const) : ('wrong-key' as const);
    } catch {
      return 'wrong-key' as const;
    }
  }

  /** 第一次使用：建立資料分支並寫入加密的初始資料 */
  static async initialize(
    client: GitHubClient,
    syncKey: string,
    init: { channels: Channel[]; settings?: Settings; branch?: string },
  ): Promise<GitHubDataRepo> {
    const branch = init.branch ?? DEFAULT_DATA_BRANCH;
    const key = await importSyncKey(syncKey);
    const meta: RepoMeta = {
      app: 'tnda-relay',
      schema: 1,
      createdAt: new Date().toISOString(),
      keyCheck: await encryptJSON(key, { ok: KEY_CHECK }, PATHS.meta),
    };
    const files: Record<string, string> = {
      'README.md': DATA_README,
      [PATHS.meta]: JSON.stringify(meta, null, 2) + '\n',
      [PATHS.channels]: JSON.stringify(await encryptJSON(key, init.channels, PATHS.channels)) + '\n',
      [PATHS.settings]:
        JSON.stringify(await encryptJSON(key, init.settings ?? DEFAULT_SETTINGS, PATHS.settings)) + '\n',
    };
    await client.createOrphanBranch(branch, files, 'relay: 初始化加密資料分支');
    return new GitHubDataRepo(client, key, { branch });
  }

  private async readBlob(sha: string): Promise<string> {
    const cached = await this.cache.get(sha);
    if (cached !== undefined) return cached;
    const text = await this.client.getBlobText(sha);
    await this.cache.set(sha, text);
    return text;
  }

  private async decode<T>(path: string, text: string): Promise<T> {
    const parsed = JSON.parse(text);
    if (!isEnvelope(parsed)) throw new Error(`${path} 不是加密檔案`);
    return decryptJSON<T>(this.key, parsed as Envelope, path);
  }

  async load(): Promise<Snapshot> {
    let tree;
    try {
      tree = await this.client.getTree(this.branch);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 409)) {
        throw new NotInitializedError(this.branch);
      }
      throw err;
    }
    const wanted = tree.filter(
      (e) =>
        e.path === PATHS.meta ||
        e.path === PATHS.channels ||
        e.path === PATHS.settings ||
        /^posts\/[\w-]+\.json$/.test(e.path),
    );
    const metaEntry = wanted.find((e) => e.path === PATHS.meta);
    if (!metaEntry) throw new NotInitializedError(this.branch);

    const meta = JSON.parse(await this.readBlob(metaEntry.sha)) as RepoMeta;
    try {
      const check = await decryptJSON<{ ok: string }>(this.key, meta.keyCheck, PATHS.meta);
      if (check.ok !== KEY_CHECK) throw new KeyMismatchError();
    } catch {
      throw new KeyMismatchError();
    }

    this.shas = new Map(wanted.map((e) => [e.path, e.sha]));
    const skipped: string[] = [];
    let channels: Channel[] = [];
    let settings: Settings = { ...DEFAULT_SETTINGS };

    const decoded = await mapLimit(
      wanted.filter((e) => e.path !== PATHS.meta),
      8,
      async (e) => {
        try {
          return { path: e.path, data: await this.decode<unknown>(e.path, await this.readBlob(e.sha)) };
        } catch {
          skipped.push(e.path);
          return { path: e.path, data: null };
        }
      },
    );
    const posts: Post[] = [];
    for (const { path, data } of decoded) {
      if (data == null) continue;
      if (path === PATHS.channels) channels = data as Channel[];
      else if (path === PATHS.settings) settings = { ...DEFAULT_SETTINGS, ...(data as Settings) };
      else posts.push(data as Post);
    }
    return { channels, settings, posts, skipped };
  }

  /** 直接讀最新版本（不經快取），寫入前比對用 */
  async read<T>(path: string): Promise<{ sha: string; data: T } | null> {
    const file = await this.client.getFile(path, this.branch);
    if (!file) return null;
    this.shas.set(path, file.sha);
    return { sha: file.sha, data: await this.decode<T>(path, file.text) };
  }

  async write(path: string, data: unknown, message: string, sha?: string | null): Promise<string> {
    const env = await encryptJSON(this.key, data, path);
    const text = JSON.stringify(env) + '\n';
    const knownSha = sha === undefined ? this.shas.get(path) : sha ?? undefined;
    const res = await this.client.putFile(path, text, { branch: this.branch, message, sha: knownSha });
    this.shas.set(path, res.sha);
    await this.cache.set(res.sha, text);
    return res.sha;
  }

  async savePost(post: Post, message = `relay: 更新 ${post.id}`): Promise<Post> {
    await this.write(PATHS.post(post.id), post, message);
    return post;
  }

  async createPost(post: Post): Promise<Post> {
    await this.write(PATHS.post(post.id), post, `relay: 新增 ${post.id}`, null);
    return post;
  }

  /**
   * 以「讀最新 → 修改 → 帶 sha 寫回」的方式更新；遇到衝突自動重來。
   * fn 回傳 null 代表放棄修改。
   */
  async updatePost(id: string, fn: (latest: Post) => Post | null, maxTries = 5): Promise<Post | null> {
    const path = PATHS.post(id);
    for (let attempt = 0; attempt < maxTries; attempt++) {
      const latest = await this.read<Post>(path);
      if (!latest) return null;
      const next = fn(latest.data);
      if (!next) return null;
      try {
        await this.write(path, next, `relay: 更新 ${id}`, latest.sha);
        return next;
      } catch (err) {
        if (!isConflict(err) || attempt === maxTries - 1) throw err;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    return null;
  }

  async deletePost(id: string): Promise<void> {
    const path = PATHS.post(id);
    let sha = this.shas.get(path);
    if (!sha) {
      const file = await this.client.getFile(path, this.branch);
      if (!file) return;
      sha = file.sha;
    }
    try {
      await this.client.deleteFile(path, { branch: this.branch, sha, message: `relay: 刪除 ${id}` });
    } catch (err) {
      if (!isConflict(err)) throw err;
      const file = await this.client.getFile(path, this.branch);
      if (!file) return;
      await this.client.deleteFile(path, { branch: this.branch, sha: file.sha, message: `relay: 刪除 ${id}` });
    }
    this.shas.delete(path);
  }

  async saveChannels(channels: Channel[]): Promise<void> {
    await this.writeFresh(PATHS.channels, channels, 'relay: 更新頻道設定');
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.writeFresh(PATHS.settings, settings, 'relay: 更新發送設定');
  }

  /** 設定檔只有使用者會改，衝突時以這次的內容為準 */
  private async writeFresh(path: string, data: unknown, message: string): Promise<void> {
    try {
      await this.write(path, data, message);
    } catch (err) {
      if (!isConflict(err)) throw err;
      const file = await this.client.getFile(path, this.branch);
      await this.write(path, data, message, file?.sha ?? null);
    }
  }
}
