// 發送引擎：決定哪些貼文該發、先「認領」再發送、記錄每個頻道的結果。
// 排程器（GitHub Actions）與瀏覽器（立即發送、準時代發）都走這一套流程。

import type { Channel, Delivery, DiscordPayload, Post, PostStatus, Settings } from './types.ts';
import type { SendFile, SendResult } from './discord.ts';
import type { AttachmentRef } from './types.ts';

export const MAX_ATTEMPTS = 3;
/** 「發送中」超過這個時間仍沒有結果，就視為狀態不明，交給使用者確認，避免重複發送。 */
export const STALE_CLAIM_MS = 15 * 60 * 1000;
/** 失敗後重試的間隔 */
export const RETRY_DELAY_MS = 4 * 60 * 1000;

export interface DeliverContext {
  channels: Map<string, Channel>;
  settings?: Settings;
  send: (url: string, payload: DiscordPayload, files?: SendFile[]) => Promise<SendResult>;
  /** 讀取並解密附檔 */
  loadFiles?: (refs: AttachmentRef[]) => Promise<SendFile[]>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

function nowIso(now?: () => Date): string {
  return (now ? now() : new Date()).toISOString();
}

export function deliveryOf(post: Post, channelId: string): Delivery {
  return post.deliveries[channelId] ?? { status: 'pending', attempts: 0 };
}

/** 這個頻道目前是否還需要發送 */
export function needsSend(d: Delivery, nowMs: number): boolean {
  if (d.status === 'pending') return true;
  if (d.status === 'failed' && d.retryable && d.attempts < MAX_ATTEMPTS) {
    const last = d.claimedAt ? Date.parse(d.claimedAt) : 0;
    return nowMs - last >= RETRY_DELAY_MS;
  }
  return false;
}

export function pendingChannels(post: Post, nowMs: number): string[] {
  return post.channels.filter((c) => needsSend(deliveryOf(post, c), nowMs));
}

/** 根據各頻道結果推算貼文狀態 */
export function computeStatus(post: Post): PostStatus {
  if (post.status === 'draft' || post.status === 'canceled') return post.status;
  const ds = post.channels.map((c) => deliveryOf(post, c));
  if (ds.length === 0) return 'scheduled';
  if (ds.some((d) => d.status === 'sending')) return 'sending';
  const willRetry = ds.some(
    (d) => d.status === 'pending' || (d.status === 'failed' && d.retryable && d.attempts < MAX_ATTEMPTS),
  );
  if (willRetry) return 'scheduled';
  const sent = ds.filter((d) => d.status === 'sent').length;
  if (sent === ds.length) return 'sent';
  if (sent === 0) return 'failed';
  return 'partial';
}

export function isDue(post: Post, nowMs: number, lookaheadMs = 0): boolean {
  if (post.status !== 'scheduled') return false;
  if (Date.parse(post.sendAt) > nowMs + lookaheadMs) return false;
  return pendingChannels(post, nowMs).length > 0;
}

/** 把卡在「發送中」太久的頻道標成狀態不明；回傳 null 代表不需要變更。 */
export function recoverStale(post: Post, nowMs: number): Post | null {
  let changed = false;
  const deliveries = { ...post.deliveries };
  for (const [ch, d] of Object.entries(deliveries)) {
    if (d.status === 'sending' && d.claimedAt && nowMs - Date.parse(d.claimedAt) > STALE_CLAIM_MS) {
      deliveries[ch] = {
        ...d,
        status: 'failed',
        retryable: false,
        error: '發送狀態不明（發送端中斷）。請到 Discord 確認是否已送出，必要時手動重送。',
      };
      changed = true;
    }
  }
  if (!changed) return null;
  const next = { ...post, deliveries };
  next.status = computeStatus(next);
  next.updatedAt = new Date(nowMs).toISOString();
  return next;
}

/**
 * 認領：把需要發送的頻道標為「發送中」。
 * 呼叫端必須用 sha 比對（CAS）寫回 GitHub，寫入成功才能真的發送；
 * 這樣排程器與多個瀏覽器同時在跑時，也只有一方會發出訊息。
 * 回傳 null 代表沒有需要發送的頻道（可能已被別人認領）。
 */
export function claim(post: Post, actor: string, nowMs: number, onlyChannels?: string[]): Post | null {
  if (post.status !== 'scheduled') return null;
  const targets = pendingChannels(post, nowMs).filter((c) => !onlyChannels || onlyChannels.includes(c));
  if (targets.length === 0) return null;
  const at = new Date(nowMs).toISOString();
  const deliveries = { ...post.deliveries };
  for (const ch of targets) {
    const d = deliveryOf(post, ch);
    deliveries[ch] = { ...d, status: 'sending', claimedAt: at, claimedBy: actor, error: undefined };
  }
  return { ...post, deliveries, status: 'sending', updatedAt: at };
}

/** 套用發送者名稱、頭像等預設值 */
export function finalPayload(post: Post, settings?: Settings): DiscordPayload {
  const p: DiscordPayload = { ...post.payload };
  if (!p.username && settings?.senderName) p.username = settings.senderName;
  if (!p.avatar_url && settings?.avatarUrl) p.avatar_url = settings.avatarUrl;
  if (!p.allowed_mentions) p.allowed_mentions = { parse: [] };
  return p;
}

/**
 * 對已認領（status = sending 且 claimedBy = actor）的頻道實際發送。
 * 回傳更新後的貼文；呼叫端負責寫回。
 */
export async function deliverClaimed(post: Post, actor: string, ctx: DeliverContext): Promise<Post> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const payload = finalPayload(post, ctx.settings);
  const deliveries = { ...post.deliveries };
  let files: SendFile[] | undefined;
  let fileError: string | undefined;
  if (post.attachments?.length) {
    try {
      if (!ctx.loadFiles) throw new Error('這個發送端無法讀取附檔');
      files = await ctx.loadFiles(post.attachments);
    } catch (err) {
      fileError = `附檔讀取失敗：${(err as Error).message}`;
    }
  }
  for (const ch of post.channels) {
    const d = deliveryOf(post, ch);
    if (d.status !== 'sending' || d.claimedBy !== actor) continue;
    const channel = ctx.channels.get(ch);
    if (!channel?.webhook) {
      deliveries[ch] = {
        ...d,
        status: 'failed',
        attempts: d.attempts + 1,
        retryable: false,
        error: '這個頻道還沒有設定 Webhook。',
      };
      continue;
    }
    if (fileError) {
      deliveries[ch] = { ...d, status: 'failed', attempts: d.attempts + 1, retryable: true, error: fileError };
      ctx.log?.(`  ✗ ${ch}：附檔讀取失敗`);
      continue;
    }
    let result: SendResult = { ok: false, error: '尚未發送' };
    // 遇到 429 時在同一次執行內等待後重試（最多 3 次）
    for (let i = 0; i < 3; i++) {
      result = await ctx.send(channel.webhook, payload, files);
      if (result.ok || result.status !== 429) break;
      await sleep(Math.min(result.retryAfterMs ?? 2000, 30000));
    }
    const at = nowIso(ctx.now);
    if (result.ok) {
      deliveries[ch] = {
        ...d,
        status: 'sent',
        attempts: d.attempts + 1,
        messageId: result.messageId,
        sentAt: at,
        error: undefined,
        retryable: undefined,
      };
      ctx.log?.(`  ✓ ${ch}`);
    } else if (result.networkError && actor.startsWith('browser:')) {
      // 這台裝置連不到 Discord（訊息沒有送出），直接交還給排程器，下一輪就會發送
      deliveries[ch] = { ...d, status: 'pending', claimedAt: undefined, claimedBy: undefined, error: '這台裝置無法連到 Discord，已交給排程器發送。' };
      ctx.log?.(`  → ${ch}：交給排程器`);
    } else {
      deliveries[ch] = {
        ...d,
        status: 'failed',
        attempts: d.attempts + 1,
        retryable: !!result.retryable,
        error: result.error,
      };
      ctx.log?.(`  ✗ ${ch}：${result.error}`);
    }
  }
  const next: Post = { ...post, deliveries, updatedAt: nowIso(ctx.now) };
  next.status = computeStatus(next);
  if (next.status === 'sent' || next.status === 'partial') {
    next.sentAt = next.sentAt ?? nowIso(ctx.now);
  }
  return next;
}

/** 合併：以 latest 為底，套入 mine 中由 actor 處理過的頻道結果（寫回時遇到衝突用）。 */
export function mergeDeliveries(latest: Post, mine: Post, actor: string): Post {
  const deliveries = { ...latest.deliveries };
  for (const [ch, d] of Object.entries(mine.deliveries)) {
    if (d.claimedBy === actor) deliveries[ch] = d;
  }
  const next: Post = { ...latest, deliveries, updatedAt: mine.updatedAt };
  const anySent = Object.values(deliveries).some((d) => d.status === 'sent');
  // 發送途中被取消：若訊息其實已送出，仍如實記錄為已發送
  if ((latest.status === 'canceled' || latest.status === 'draft') && !anySent) next.status = latest.status;
  else next.status = computeStatus({ ...next, status: 'scheduled' });
  if (mine.sentAt && !next.sentAt) next.sentAt = mine.sentAt;
  return next;
}

/** 重複發送：算出下一次的貼文（若已超過結束日期則回傳 null）。 */
export function nextOccurrence(post: Post, newId: string, nowMs: number): Post | null {
  if (!post.repeat) return null;
  const step = (post.repeat.freq === 'daily' ? 1 : 7) * Math.max(1, post.repeat.interval) * 86400000;
  let t = Date.parse(post.sendAt) + step;
  // 若排程器停擺很久，跳過已經過去的場次
  while (t < nowMs - 60000) t += step;
  if (post.repeat.until && t > Date.parse(post.repeat.until)) return null;
  const at = new Date(nowMs).toISOString();
  return {
    ...post,
    id: newId,
    sendAt: new Date(t).toISOString(),
    status: 'scheduled',
    deliveries: {},
    sentAt: undefined,
    createdAt: at,
    updatedAt: at,
    series: post.series ?? post.id,
    draft: post.draft ? shiftDraft(post.draft, t - Date.parse(post.sendAt)) : undefined,
    payload: shiftPayload(post.payload, t - Date.parse(post.sendAt)),
  };
}

function shiftIso(iso: string | undefined, deltaMs: number): string | undefined {
  return iso ? new Date(Date.parse(iso) + deltaMs).toISOString() : iso;
}

function shiftDraft<T extends { eventAt?: string; eventEnd?: string; deadline?: string }>(d: T, deltaMs: number): T {
  return { ...d, eventAt: shiftIso(d.eventAt, deltaMs), eventEnd: shiftIso(d.eventEnd, deltaMs), deadline: shiftIso(d.deadline, deltaMs) };
}

/** 把訊息中的 Discord 時間戳 <t:unix:x> 一起往後推，讓每週提醒的時間正確。 */
export function shiftPayload(p: DiscordPayload, deltaMs: number): DiscordPayload {
  const sec = Math.round(deltaMs / 1000);
  const json = JSON.stringify(p).replace(/<t:(\d+)(:[tTdDfFR])?>/g, (_m, ts: string, style: string | undefined) => {
    return `<t:${Number(ts) + sec}${style ?? ''}>`;
  });
  return JSON.parse(json);
}

export function summarize(post: Post): { sent: number; failed: number; pending: number; total: number } {
  let sent = 0;
  let failed = 0;
  let pending = 0;
  for (const ch of post.channels) {
    const d = deliveryOf(post, ch);
    if (d.status === 'sent') sent++;
    else if (d.status === 'failed') failed++;
    else pending++;
  }
  return { sent, failed, pending, total: post.channels.length };
}
