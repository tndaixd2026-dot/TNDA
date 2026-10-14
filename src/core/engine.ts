// 發送一則貼文的完整流程（排程器與瀏覽器共用）：
// 認領（CAS 寫入）→ 發送 → 寫回結果 → 若為重複貼文則建立下一次。

import type { Channel, Post, Settings } from './types.ts';
import { claim, deliverClaimed, mergeDeliveries, nextOccurrence, type DeliverContext } from './delivery.ts';
import { randomId } from './crypto.ts';

export interface PostRepo {
  updatePost(id: string, fn: (latest: Post) => Post | null): Promise<Post | null>;
  createPost(post: Post): Promise<Post>;
}

export interface SendOptions {
  /** 不檢查是否到時間（立即發送、重送） */
  force?: boolean;
  /** 只發送這些頻道 */
  onlyChannels?: string[];
  /** 允許的提早秒數（排程器等待後可能早幾毫秒） */
  graceMs?: number;
}

export interface SendOutcome {
  post: Post;
  next?: Post;
}

export async function sendPost(
  repo: PostRepo,
  postId: string,
  actor: string,
  ctx: DeliverContext,
  opts: SendOptions = {},
): Promise<SendOutcome | null> {
  const now = () => (ctx.now ? ctx.now() : new Date());
  const grace = opts.graceMs ?? 5000;

  const claimed = await repo.updatePost(postId, (latest) => {
    if (!opts.force && Date.parse(latest.sendAt) > now().getTime() + grace) return null;
    return claim(latest, actor, now().getTime(), opts.onlyChannels);
  });
  if (!claimed) return null;

  const delivered = await deliverClaimed(claimed, actor, ctx);
  const saved = (await repo.updatePost(postId, (latest) => mergeDeliveries(latest, delivered, actor))) ?? delivered;

  let next: Post | undefined;
  if (saved.repeat && (saved.status === 'sent' || saved.status === 'partial')) {
    const n = nextOccurrence(saved, randomId('p'), now().getTime());
    if (n) next = await repo.createPost(n);
  }
  return { post: saved, next };
}

export function channelMap(channels: Channel[]): Map<string, Channel> {
  return new Map(channels.map((c) => [c.id, c]));
}

export type { DeliverContext, Settings };
