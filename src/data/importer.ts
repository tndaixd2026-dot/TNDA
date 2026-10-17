// 批次匯入：把整理好的多則貼文（檔案或連結）一次排進發送排程。
// 匯入內容只指定「群組／頻道名稱的關鍵字」，對應到實際頻道由使用者在畫面上確認，
// 所以不需要知道 Webhook，也不需要同步金鑰。

import { base64ToBytes, bytesToBase64 } from '../core/crypto.ts';
import type { Channel, Post, PostType } from '../core/types.ts';
import { POST_TYPES } from '../format/composer.ts';

export interface ChannelRef {
  /** 直接指定頻道代號 */
  id?: string;
  /** 群組名稱的關鍵字，例如「VSAI」 */
  group?: string;
  /** 頻道名稱的關鍵字，例如「課程公告」 */
  channel?: string;
}

export interface ImportItem {
  title: string;
  type: PostType;
  /** 發送時間（ISO 8601，含時區） */
  at: string;
  to: ChannelRef[];
  /** 照原樣發送的 Discord 訊息內容 */
  content: string;
  /** 匯入前要提醒使用者的事 */
  note?: string;
}

export interface ImportBundle {
  name?: string;
  posts: ImportItem[];
}

export class ImportError extends Error {}

export const MAX_IMPORT = 200;
const LINK_PREFIX = 'z.';

/** 讀取並檢查匯入內容（JSON 文字） */
export function parseImportBundle(text: string): ImportBundle {
  let data: unknown;
  try {
    data = JSON.parse(text.trim().replace(/^﻿/, ''));
  } catch {
    throw new ImportError('看不懂這份內容：不是有效的匯入檔（JSON 格式錯誤）。');
  }
  const obj = data as { tnda?: unknown; name?: unknown; posts?: unknown };
  if (!obj || typeof obj !== 'object' || obj.tnda !== 'import' || !Array.isArray(obj.posts)) {
    throw new ImportError('這不是 TNDA Relay 的匯入檔。');
  }
  if (obj.posts.length === 0) throw new ImportError('匯入檔裡沒有任何貼文。');
  if (obj.posts.length > MAX_IMPORT) throw new ImportError(`一次最多匯入 ${MAX_IMPORT} 則，這份有 ${obj.posts.length} 則。`);
  const posts = obj.posts.map((raw, i): ImportItem => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const n = `第 ${i + 1} 則`;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    if (!content) throw new ImportError(`${n}沒有內容。`);
    const at = typeof p.at === 'string' ? p.at : '';
    if (!at || Number.isNaN(Date.parse(at))) throw new ImportError(`${n}的發送時間格式不正確。`);
    const to = Array.isArray(p.to) ? (p.to as unknown[]).map(toRef).filter((r): r is ChannelRef => !!r) : [];
    if (!to.length) throw new ImportError(`${n}沒有指定頻道。`);
    const title = (typeof p.title === 'string' && p.title.trim()) || firstLine(content);
    const type = POST_TYPES.includes(p.type as PostType) ? (p.type as PostType) : 'announce';
    const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : undefined;
    return { title: title.slice(0, 120), type, at: new Date(at).toISOString(), to, content, note };
  });
  return { name: typeof obj.name === 'string' ? obj.name : undefined, posts };
}

function toRef(raw: unknown): ChannelRef | null {
  if (typeof raw === 'string') return raw.trim() ? { id: raw.trim() } : null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pick = (k: string) => (typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim() : undefined);
  const ref: ChannelRef = { id: pick('id'), group: pick('group'), channel: pick('channel') };
  return ref.id || ref.group || ref.channel ? ref : null;
}

function firstLine(content: string): string {
  const line = content.split('\n').find((l) => l.trim() && !/^<@[&!]?\d+>$/.test(l.trim())) ?? '';
  return line.replace(/^#+\s*|^-#\s*/, '').replace(/\*\*/g, '').trim() || '匯入的貼文';
}

export function refKey(ref: ChannelRef): string {
  return ref.id ? `id:${ref.id}` : `${ref.group ?? ''}｜${ref.channel ?? ''}`;
}

export function refLabel(ref: ChannelRef): string {
  if (ref.id) return ref.id;
  return [ref.group, ref.channel].filter(Boolean).join(' ／ ');
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** 找出符合關鍵字的頻道；剛好一個才算自動對應成功 */
export function matchChannels(ref: ChannelRef, channels: Channel[]): Channel[] {
  if (ref.id) return channels.filter((c) => c.id === ref.id);
  const g = ref.group ? norm(ref.group) : '';
  const n = ref.channel ? norm(ref.channel) : '';
  const hits = channels.filter((c) => (!g || norm(c.groupName).includes(g) || norm(c.group) === g) && (!n || norm(c.name).includes(n)));
  // 名稱完全相同的優先，例如「業師群組」群組裡同時有「業師群組」「助理群組」
  const exact = hits.filter((c) => !n || norm(c.name) === n);
  return exact.length ? exact : hits;
}

/** 依目前的頻道對應，把每則貼文的頻道換成實際的頻道代號 */
export function resolveTargets(item: ImportItem, mapping: Record<string, string>): string[] | null {
  const ids = item.to.map((r) => mapping[refKey(r)]);
  if (ids.some((id) => !id)) return null;
  return [...new Set(ids)];
}

/** 已經有一樣的排程（同時間、同內容、同頻道）就視為重複 */
export function findDuplicate(content: string, at: string, channelIds: string[], posts: Post[]): Post | undefined {
  const t = Date.parse(at);
  return posts.find(
    (p) =>
      p.status !== 'canceled' &&
      Math.abs(Date.parse(p.sendAt) - t) < 60000 &&
      (p.payload.content ?? '').trim() === content.trim() &&
      p.channels.some((c) => channelIds.includes(c)),
  );
}

// ───────────────────────── 匯入連結 ─────────────────────────

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const toUrlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrlSafe = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);

/** 把匯入內容壓縮成網址可用的字串（放在 #import= 後面） */
export async function encodeImportData(json: string): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  return LINK_PREFIX + toUrlSafe(bytesToBase64(packed));
}

export async function decodeImportData(data: string): Promise<string> {
  const value = decodeURIComponent(data.trim());
  if (!value.startsWith(LINK_PREFIX)) throw new ImportError('匯入連結格式不正確。');
  try {
    const bytes = await pipe(base64ToBytes(fromUrlSafe(value.slice(LINK_PREFIX.length))), new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(bytes);
  } catch {
    throw new ImportError('匯入連結不完整，可能複製時被截斷了。請重新複製完整連結。');
  }
}
