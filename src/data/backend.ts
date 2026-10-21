// 資料後端介面：Demo（只存在瀏覽器）與 GitHub（加密同步）共用同一組操作。

import type { AttachmentRef, Channel, DiscordPayload, Post, Settings } from '../core/types.ts';
import type { SendFile, SendResult, WebhookInfo } from '../core/discord.ts';
import type { WorkflowRun } from '../core/github.ts';
import type { Mode } from './config.ts';

export interface Snapshot {
  channels: Channel[];
  settings: Settings;
  posts: Post[];
  skipped: string[];
}

export interface Backend {
  kind: Mode;
  load(): Promise<Snapshot>;
  createPost(post: Post): Promise<Post>;
  updatePost(id: string, fn: (latest: Post) => Post | null): Promise<Post | null>;
  deletePost(id: string): Promise<void>;
  saveChannels(channels: Channel[]): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;
  send(url: string, payload: DiscordPayload, files?: SendFile[]): Promise<SendResult>;
  putAttachment(file: SendFile): Promise<AttachmentRef>;
  getAttachment(ref: AttachmentRef): Promise<SendFile>;
  deleteMessage(url: string, messageId: string): Promise<SendResult>;
  editMessage(url: string, messageId: string, payload: DiscordPayload): Promise<SendResult>;
  webhookInfo(url: string): Promise<WebhookInfo>;
  schedulerRuns(): Promise<WorkflowRun[]>;
  runScheduler(): Promise<void>;
}
