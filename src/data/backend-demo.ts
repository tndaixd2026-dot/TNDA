// Demo 後端：資料只存在這個瀏覽器，發送 Discord 是模擬的（不會真的送出）。

import type { AttachmentRef, Channel, DiscordPayload, Post, Settings } from '../core/types.ts';
import type { SendFile, SendResult, WebhookInfo } from '../core/discord.ts';
import { randomId } from '../core/crypto.ts';
import type { WorkflowRun } from '../core/github.ts';
import type { Backend, Snapshot } from './backend.ts';
import { DEMO_SETTINGS, demoChannels, demoPosts } from './seed.ts';

const KEY = 'tnda-relay:demo';
const VERSION = 3;

interface DemoState {
  version: number;
  seededAt: string;
  channels: Channel[];
  settings: Settings;
  posts: Post[];
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Demo 的附檔只放在記憶體（重新整理後預覽圖會消失） */
const demoFiles = new Map<string, SendFile>();

export class DemoBackend implements Backend {
  kind = 'demo' as const;
  private state: DemoState;

  async putAttachment(file: SendFile): Promise<AttachmentRef> {
    const id = randomId('f', 16);
    demoFiles.set(id, file);
    return { id, name: file.name, type: file.type, size: file.bytes.length };
  }

  async getAttachment(ref: AttachmentRef): Promise<SendFile> {
    const f = demoFiles.get(ref.id);
    if (!f) throw new Error('Demo 的附檔只保留到重新整理前');
    return f;
  }

  constructor() {
    this.state = this.read() ?? this.fresh();
    this.persist();
  }

  private fresh(): DemoState {
    return { version: VERSION, seededAt: new Date().toISOString(), channels: demoChannels(), settings: { ...DEMO_SETTINGS }, posts: demoPosts() };
  }

  private read(): DemoState | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as DemoState;
      if (s.version !== VERSION) return null;
      // 範例資料放太久，時間都過期了，就重新產生
      if (Date.now() - Date.parse(s.seededAt) > 10 * 86400000) return null;
      return s;
    } catch {
      return null;
    }
  }

  private persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* 無法儲存時只保留在記憶體 */
    }
  }

  reset() {
    this.state = this.fresh();
    this.persist();
  }

  get seededAt() {
    return this.state.seededAt;
  }

  async load(): Promise<Snapshot> {
    await wait(120);
    const s = structuredClone(this.state);
    return { channels: s.channels, settings: s.settings, posts: s.posts, skipped: [] };
  }

  async createPost(post: Post): Promise<Post> {
    this.state.posts.push(structuredClone(post));
    this.persist();
    return post;
  }

  async updatePost(id: string, fn: (latest: Post) => Post | null): Promise<Post | null> {
    const idx = this.state.posts.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const next = fn(structuredClone(this.state.posts[idx]));
    if (!next) return null;
    this.state.posts[idx] = structuredClone(next);
    this.persist();
    return next;
  }

  async deletePost(id: string): Promise<void> {
    this.state.posts = this.state.posts.filter((p) => p.id !== id);
    this.persist();
  }

  async saveChannels(channels: Channel[]): Promise<void> {
    this.state.channels = structuredClone(channels);
    this.persist();
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.state.settings = { ...settings };
    this.persist();
  }

  async send(_url: string, _payload: DiscordPayload): Promise<SendResult> {
    await wait(350 + Math.random() * 450);
    return { ok: true, status: 200, messageId: String(1290000000000000000 + Math.floor(Math.random() * 1e12)) };
  }

  async deleteMessage(): Promise<SendResult> {
    await wait(300);
    return { ok: true, status: 204 };
  }

  async editMessage(_url: string, messageId: string): Promise<SendResult> {
    await wait(300);
    return { ok: true, status: 200, messageId };
  }

  async webhookInfo(url: string): Promise<WebhookInfo> {
    await wait(300);
    const ch = this.state.channels.find((c) => c.webhook === url);
    return { name: 'TNDA 課務小幫手', channel_id: '0', guild_id: '0', avatar: null, ...(ch ? { name: `${ch.name} Webhook` } : {}) };
  }

  async schedulerRuns(): Promise<WorkflowRun[]> {
    const last = Math.floor(Date.now() / 300000) * 300000;
    return [0, 1, 2].map((i) => ({
      id: i,
      status: 'completed',
      conclusion: 'success',
      event: 'schedule',
      created_at: new Date(last - i * 300000).toISOString(),
      updated_at: new Date(last - i * 300000 + 21000).toISOString(),
      html_url: '#',
    }));
  }

  async runScheduler(): Promise<void> {
    await wait(300);
  }
}
