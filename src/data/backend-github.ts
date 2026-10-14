// GitHub 後端：資料加密後存在 repo 的資料分支；Discord 直接由瀏覽器發送。

import type { Channel, DiscordPayload, Post, Settings } from '../core/types.ts';
import { deleteWebhookMessage, editWebhookMessage, executeWebhook, getWebhookInfo } from '../core/discord.ts';
import type { SendResult, WebhookInfo } from '../core/discord.ts';
import { GitHubClient, type WorkflowRun } from '../core/github.ts';
import { GitHubDataRepo, SCHEDULER_WORKFLOW } from '../core/repo.ts';
import type { Backend, Snapshot } from './backend.ts';
import type { DeviceConfig } from './config.ts';
import { IdbBlobCache } from './idb.ts';

/** 剛寫入的資料在這段時間內，以本機版本為準（GitHub 讀取有短暫延遲） */
const LOCAL_WINS_MS = 30000;

export class GitHubBackend implements Backend {
  kind = 'github' as const;
  client: GitHubClient;
  repo: GitHubDataRepo;
  private local = new Map<string, { post: Post | null; at: number }>();
  private defaultBranch: string | null = null;

  constructor(client: GitHubClient, repo: GitHubDataRepo) {
    this.client = client;
    this.repo = repo;
  }

  static async connect(cfg: DeviceConfig): Promise<GitHubBackend> {
    const client = new GitHubClient({ owner: cfg.owner, repo: cfg.repo, token: cfg.token });
    const repo = await GitHubDataRepo.open(client, cfg.syncKey, { branch: cfg.branch, cache: new IdbBlobCache() });
    return new GitHubBackend(client, repo);
  }

  private remember(id: string, post: Post | null) {
    this.local.set(id, { post, at: Date.now() });
  }

  async load(): Promise<Snapshot> {
    const snap = await this.repo.load();
    const now = Date.now();
    const byId = new Map(snap.posts.map((p) => [p.id, p]));
    for (const [id, entry] of this.local) {
      if (now - entry.at > LOCAL_WINS_MS) {
        this.local.delete(id);
        continue;
      }
      if (entry.post === null) byId.delete(id);
      else {
        const remote = byId.get(id);
        if (!remote || Date.parse(remote.updatedAt) <= Date.parse(entry.post.updatedAt)) byId.set(id, entry.post);
      }
    }
    return { ...snap, posts: [...byId.values()] };
  }

  async createPost(post: Post): Promise<Post> {
    await this.repo.createPost(post);
    this.remember(post.id, post);
    return post;
  }

  async updatePost(id: string, fn: (latest: Post) => Post | null): Promise<Post | null> {
    const next = await this.repo.updatePost(id, fn);
    if (next) this.remember(id, next);
    return next;
  }

  async deletePost(id: string): Promise<void> {
    await this.repo.deletePost(id);
    this.remember(id, null);
  }

  saveChannels(channels: Channel[]): Promise<void> {
    return this.repo.saveChannels(channels);
  }

  saveSettings(settings: Settings): Promise<void> {
    return this.repo.saveSettings(settings);
  }

  send(url: string, payload: DiscordPayload): Promise<SendResult> {
    return executeWebhook(url, payload);
  }

  deleteMessage(url: string, messageId: string): Promise<SendResult> {
    return deleteWebhookMessage(url, messageId);
  }

  editMessage(url: string, messageId: string, payload: DiscordPayload): Promise<SendResult> {
    return editWebhookMessage(url, messageId, payload);
  }

  webhookInfo(url: string): Promise<WebhookInfo> {
    return getWebhookInfo(url);
  }

  schedulerRuns(): Promise<WorkflowRun[]> {
    return this.client.listWorkflowRuns(SCHEDULER_WORKFLOW, 5);
  }

  async runScheduler(): Promise<void> {
    if (!this.defaultBranch) this.defaultBranch = (await this.client.getRepo()).default_branch;
    await this.client.dispatchWorkflow(SCHEDULER_WORKFLOW, this.defaultBranch, { reason: 'manual' });
  }
}
