// 批次匯入：把整理好的多則貼文（檔案或連結）一次排進發送排程。
// 匯入內容只指定「群組／頻道名稱的關鍵字」，對應到實際頻道由使用者在畫面上確認，
// 所以不需要知道 Webhook，也不需要同步金鑰。
// 有照片或影片時用 .zip（posts.json＋原始檔案），或把 .json 和檔案一起選取。

import { base64ToBytes, bytesToBase64 } from '../core/crypto.ts';
import type { Channel, PollDraft, Post, PostType } from '../core/types.ts';
import { POST_TYPES, splitAnswer } from '../format/composer.ts';
import { ZipError, isJunkPath, looksLikeZip, normalizePath, readZip } from './zip.ts';

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
  /** 附加的投票 */
  poll?: PollDraft;
  /** 附檔，排程時才加密上傳 */
  attachments?: ImportFile[];
}

/** 附檔的原始檔案：壓縮檔裡的檔案、一起選取的檔案，或舊版匯入檔裡的 base64 */
export interface ImportBlob {
  path: string;
  size: number;
  type?: string;
  read(): Promise<Uint8Array>;
}

export interface ImportFile {
  /** 發到 Discord 的檔名 */
  name: string;
  type: string;
  size: number;
  /** 多則貼文用到同一個檔案時是同一個物件，只需上傳一次 */
  source: ImportBlob;
}

export interface ImportBundle {
  name?: string;
  posts: ImportItem[];
}

export class ImportError extends Error {}

export const MAX_IMPORT = 200;
const LINK_PREFIX = 'z.';

/**
 * 讀取並檢查匯入內容（JSON 文字）。
 * files：可被附檔引用的檔案；base：匯入檔所在的資料夾（附檔路徑相對於它）。
 */
export function parseImportBundle(text: string, files: ImportBlob[] = [], base = ''): ImportBundle {
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
  const toFile = fileResolver(files, base);
  const posts = obj.posts.map((raw, i): ImportItem => {
    const p = (raw ?? {}) as Record<string, unknown>;
    const n = `第 ${i + 1} 則`;
    const content = typeof p.content === 'string' ? p.content.trim() : '';
    const poll = p.poll === undefined || p.poll === null ? undefined : toPoll(p.poll, n);
    if (!content && !poll) throw new ImportError(`${n}沒有內容。`);
    const at = typeof p.at === 'string' ? p.at : '';
    if (!at || Number.isNaN(Date.parse(at))) throw new ImportError(`${n}的發送時間格式不正確。`);
    const to = Array.isArray(p.to) ? (p.to as unknown[]).map(toRef).filter((r): r is ChannelRef => !!r) : [];
    if (!to.length) throw new ImportError(`${n}沒有指定頻道。`);
    const title = (typeof p.title === 'string' && p.title.trim()) || (content ? firstLine(content) : `📊 ${poll!.question}`);
    const type = POST_TYPES.includes(p.type as PostType) ? (p.type as PostType) : 'announce';
    const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : undefined;
    const attachments = Array.isArray(p.attachments) ? p.attachments.map((a, j) => toFile(a, `${n}的第 ${j + 1} 個附檔`)) : [];
    return {
      title: title.slice(0, 120),
      type,
      at: new Date(at).toISOString(),
      to,
      content,
      note,
      ...(poll ? { poll } : {}),
      ...(attachments.length ? { attachments } : {}),
    };
  });
  return { name: typeof obj.name === 'string' ? obj.name : undefined, posts };
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(h|hr|hours?|小時|d|days?|天|w|weeks?|週|周)$/i;

/** 投票：answers 可以是字串（開頭的 emoji 會自動拆出來）或 { text, emoji }；時間用 hours 或 duration（例如 "3d"、"24h"、"1週"） */
function toPoll(raw: unknown, n: string): PollDraft {
  const p = (raw ?? {}) as Record<string, unknown>;
  const question = typeof p.question === 'string' ? p.question.trim() : '';
  if (!question) throw new ImportError(`${n}的投票沒有問題。`);
  const answers = (Array.isArray(p.answers) ? p.answers : []).map((a) => {
    if (typeof a === 'string') return splitAnswer(a);
    const o = (a ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    const emoji = typeof o.emoji === 'string' && o.emoji.trim() ? o.emoji.trim() : undefined;
    return emoji ? { text, emoji } : splitAnswer(text);
  });
  if (answers.length < 2) throw new ImportError(`${n}的投票至少要有 2 個選項。`);
  let hours = 24;
  if (typeof p.hours === 'number') hours = p.hours;
  else if (typeof p.duration === 'number') hours = p.duration;
  else if (typeof p.duration === 'string') {
    const m = DURATION_RE.exec(p.duration.trim());
    if (!m) throw new ImportError(`${n}的投票時間看不懂：${p.duration}（例如 24h、3d、1w）`);
    const unit = m[2].toLowerCase();
    const mult = /^(d|day|days|天)$/.test(unit) ? 24 : /^(w|week|weeks|週|周)$/.test(unit) ? 168 : 1;
    hours = Number(m[1]) * mult;
  }
  hours = Math.round(hours);
  if (hours < 1 || hours > 768) throw new ImportError(`${n}的投票時間要在 1 小時到 32 天之間。`);
  const multi = p.multi === true || p.multiselect === true || p.allow_multiselect === true;
  return { question, answers, hours, multi };
}

/** 附檔可以寫成路徑字串、{ file, name } 或舊版的 { name, data(base64) } */
function fileResolver(files: ImportBlob[], base: string) {
  const byPath = new Map(files.map((f) => [normalizePath(f.path), f]));
  const inline = new Map<string, ImportBlob>();
  const find = (ref: string, label: string): ImportBlob => {
    const path = normalizePath(ref);
    const hit = byPath.get(normalizePath(base ? `${base}/${ref}` : ref)) ?? byPath.get(path);
    if (hit) return hit;
    // 打包方式不同時資料夾可能不一樣，檔名唯一就用它
    const name = path.split('/').pop()!;
    const same = files.filter((f) => normalizePath(f.path).split('/').pop() === name);
    if (same.length === 1) return same[0];
    if (same.length > 1) throw new ImportError(`${label}「${ref}」有好幾個同名的檔案，請寫出完整路徑。`);
    throw new ImportError(
      files.length
        ? `${label}找不到檔案「${ref}」，請確認它在 .zip 裡（或和匯入檔一起選取）。`
        : `${label}「${ref}」需要和匯入檔放在同一個 .zip 裡（或一起選取）。`,
    );
  };
  return (raw: unknown, label: string): ImportFile => {
    if (typeof raw === 'string' && raw.trim()) {
      const source = find(raw.trim(), label);
      const name = source.path.split('/').pop()!;
      return { name, type: source.type || guessType(name) || 'application/octet-stream', size: source.size, source };
    }
    const f = (raw ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string).trim() : '');
    const ref = str('file') || str('path');
    if (ref) {
      const source = find(ref, label);
      const name = str('name') || source.path.split('/').pop()!;
      return { name, type: str('type') || guessType(name) || source.type || guessType(source.path) || 'application/octet-stream', size: source.size, source };
    }
    const name = str('name');
    const data = str('data').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!name || !data || !/^[A-Za-z0-9+/]+=*$/.test(data)) throw new ImportError(`${label}格式不正確（需要檔案路徑，或 name 與 base64 的 data）。`);
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    let source = inline.get(data);
    if (!source) {
      source = { path: name, size, read: async () => base64ToBytes(data) };
      inline.set(data, source);
    }
    return { name, type: str('type') || guessType(name) || 'application/octet-stream', size, source };
  };
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  txt: 'text/plain',
  zip: 'application/zip',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** 依副檔名判斷檔案類型；不認得時回傳空字串 */
export function guessType(name: string): string {
  return TYPES[name.toLowerCase().split('.').pop() ?? ''] ?? '';
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

// ───────────────────────── 讀取檔案 ─────────────────────────

export const MAX_MANIFEST_BYTES = 40_000_000;

export interface ImportSource {
  text: string;
  files: ImportBlob[];
  base: string;
}

const isJson = (name: string) => /\.json$/i.test(name);
const blobOf = (f: File): ImportBlob => ({ path: f.webkitRelativePath || f.name, size: f.size, type: f.type || undefined, read: async () => new Uint8Array(await f.arrayBuffer()) });

/** 使用者選取（或拖曳）的檔案：一個 .zip、一個 .json，或 .json 加上要附的檔案 */
export async function loadImportFiles(list: File[]): Promise<ImportSource> {
  const picked = list.filter((f) => !isJunkPath(f.name));
  if (!picked.length) throw new ImportError('沒有選到檔案。');
  const zips: File[] = [];
  // .pptx、.docx 其實也是 zip，所以只有副檔名不明的單一檔案才看檔頭
  for (const f of picked) if (/\.zip$/i.test(f.name) || (picked.length === 1 && !guessType(f.name) && !isJson(f.name) && (await looksLikeZip(f)))) zips.push(f);
  if (zips.length) {
    if (picked.length > 1) throw new ImportError('選 .zip 時請只選那一個檔案。');
    return loadZip(zips[0]);
  }
  const manifests = picked.filter((f) => isJson(f.name));
  if (manifests.length !== 1) {
    throw new ImportError(manifests.length ? '一次只能選一個匯入檔（.json）。' : '請一起選取匯入檔（.json），或改選整包 .zip。');
  }
  const manifest = manifests[0];
  if (manifest.size > MAX_MANIFEST_BYTES) throw new ImportError('匯入檔太大了（超過 40 MB）。有照片或影片時請改用 .zip。');
  return { text: await manifest.text(), files: picked.filter((f) => f !== manifest).map(blobOf), base: '' };
}

async function loadZip(file: File): Promise<ImportSource> {
  let entries;
  try {
    entries = await readZip(file);
  } catch (err) {
    throw new ImportError(err instanceof ZipError ? err.message : `讀取 .zip 失敗：${(err as Error).message}`);
  }
  const depth = (p: string) => p.split('/').length;
  const jsons = entries.filter((e) => isJson(e.path)).sort((a, b) => depth(a.path) - depth(b.path));
  let manifest = jsons.find((e) => /(^|\/)posts\.json$/i.test(e.path));
  let text = '';
  if (!manifest) {
    // 沒有 posts.json 時，找內容是匯入檔的那一個
    for (const e of jsons) {
      if (e.size > MAX_MANIFEST_BYTES) continue;
      const t = new TextDecoder().decode(await e.read());
      if (/"tnda"\s*:\s*"import"/.test(t)) {
        if (manifest) throw new ImportError('壓縮檔裡有好幾個匯入檔，請只留一個 posts.json。');
        manifest = e;
        text = t;
      }
    }
  }
  if (!manifest) throw new ImportError('壓縮檔裡找不到匯入檔（posts.json）。');
  if (manifest.size > MAX_MANIFEST_BYTES) throw new ImportError('posts.json 太大了（超過 40 MB）。');
  if (!text) text = new TextDecoder().decode(await manifest.read());
  const base = manifest.path.includes('/') ? manifest.path.slice(0, manifest.path.lastIndexOf('/')) : '';
  return { text, files: entries.filter((e) => e !== manifest), base };
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
