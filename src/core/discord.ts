// Discord Webhook：驗證、發送、編輯、撤回。

import type { DiscordPayload } from './types.ts';

export const WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,22})\/([\w-]{20,})\/?$/;

export function parseWebhook(url: string): { id: string; token: string } | null {
  const m = WEBHOOK_RE.exec(url.trim());
  return m ? { id: m[1], token: m[2] } : null;
}

export function maskWebhook(url?: string): string {
  const w = url ? parseWebhook(url) : null;
  if (!w) return '未設定';
  return `…/webhooks/${w.id.slice(0, 4)}…${w.id.slice(-4)}/${w.token.slice(0, 4)}••••`;
}

export const LIMITS = {
  content: 2000,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  author: 256,
  embedTotal: 6000,
  embeds: 10,
  username: 80,
  pollQuestion: 300,
  pollAnswer: 55,
  pollAnswers: 10,
  pollHours: 768,
  /** Discord 未加成的伺服器，每則訊息的附檔上限 */
  files: 10,
  filesBytes: 10 * 1024 * 1024,
};

export interface SendFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** 附檔的問題（數量、總大小） */
export function attachmentProblems(files: Array<{ size: number }>): string[] {
  const errors: string[] = [];
  if (files.length > LIMITS.files) errors.push(`附檔最多 ${LIMITS.files} 個`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > LIMITS.filesBytes) errors.push(`附檔總大小超過 10 MB（目前 ${(total / 1024 / 1024).toFixed(1)} MB），Discord 會拒收`);
  return errors;
}

const SINGLE_EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F|\u20E3|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*$/u;

export function payloadLength(p: DiscordPayload): number {
  let total = 0;
  for (const e of p.embeds ?? []) {
    total += (e.title ?? '').length + (e.description ?? '').length + (e.footer?.text ?? '').length;
    total += (e.author?.name ?? '').length;
    for (const f of e.fields ?? []) total += f.name.length + f.value.length;
  }
  return total;
}

/** 回傳所有不符合 Discord 限制的問題（中文說明）。空陣列代表可以發送。 */
export function validatePayload(p: DiscordPayload): string[] {
  const errors: string[] = [];
  const content = p.content ?? '';
  const embeds = p.embeds ?? [];
  if (!content.trim() && embeds.length === 0 && !p.poll) errors.push('訊息內容是空的');
  if (p.poll) {
    const poll = p.poll;
    if (!poll.question.text.trim()) errors.push('投票還沒有填問題');
    if (poll.question.text.length > LIMITS.pollQuestion) errors.push(`投票問題超過 ${LIMITS.pollQuestion} 字`);
    if (poll.answers.length < 2) errors.push('投票至少要有 2 個選項');
    if (poll.answers.length > LIMITS.pollAnswers) errors.push(`投票最多 ${LIMITS.pollAnswers} 個選項`);
    for (const a of poll.answers) {
      if (!a.poll_media.text.trim()) errors.push('有投票選項沒有文字');
      if (a.poll_media.text.length > LIMITS.pollAnswer) errors.push(`投票選項「${a.poll_media.text.slice(0, 10)}…」超過 ${LIMITS.pollAnswer} 字`);
      if (a.poll_media.emoji && !SINGLE_EMOJI.test(a.poll_media.emoji.name)) errors.push(`投票選項的圖示只能放一個 emoji（目前是「${a.poll_media.emoji.name}」）`);
    }
    if (!Number.isInteger(poll.duration) || poll.duration < 1 || poll.duration > LIMITS.pollHours) errors.push('投票時間要在 1 小時到 32 天之間');
    if (embeds.length) errors.push('投票不能和卡片樣式一起發，請把樣式改成「純文字」或「原文」');
  }
  if (content.length > LIMITS.content) errors.push(`訊息文字超過 ${LIMITS.content} 字（目前 ${content.length}）`);
  if (embeds.length > LIMITS.embeds) errors.push(`卡片數量超過 ${LIMITS.embeds} 張`);
  if (p.username && p.username.length > LIMITS.username) errors.push(`發送者名稱超過 ${LIMITS.username} 字`);
  if (p.username && /discord|clyde/i.test(p.username)) errors.push('發送者名稱不能包含「discord」或「clyde」');
  for (const e of embeds) {
    if ((e.title ?? '').length > LIMITS.title) errors.push(`標題超過 ${LIMITS.title} 字`);
    if ((e.description ?? '').length > LIMITS.description) errors.push(`內文超過 ${LIMITS.description} 字`);
    if ((e.fields ?? []).length > LIMITS.fields) errors.push(`欄位超過 ${LIMITS.fields} 個`);
    for (const f of e.fields ?? []) {
      if (!f.name.trim() || !f.value.trim()) errors.push('有欄位的名稱或內容是空的');
      if (f.name.length > LIMITS.fieldName) errors.push(`欄位名稱「${f.name.slice(0, 10)}…」太長`);
      if (f.value.length > LIMITS.fieldValue) errors.push(`欄位「${f.name}」內容超過 ${LIMITS.fieldValue} 字`);
    }
    if ((e.footer?.text ?? '').length > LIMITS.footer) errors.push('頁尾文字太長');
    for (const u of [e.url, e.image?.url, e.thumbnail?.url]) {
      if (u && !/^https?:\/\//.test(u)) errors.push(`網址格式不正確：${u}`);
    }
  }
  if (payloadLength(p) > LIMITS.embedTotal) errors.push(`卡片總字數超過 ${LIMITS.embedTotal} 字`);
  return [...new Set(errors)];
}

export interface SendResult {
  ok: boolean;
  status?: number;
  messageId?: string;
  error?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  /** 請求根本沒有送到 Discord（網路中斷、瀏覽器阻擋） */
  networkError?: boolean;
}

type FetchLike = typeof fetch;

function describe(status: number, body: { message?: string; code?: number; retry_after?: number } | null): string {
  if (status === 404 || body?.code === 10015) return 'Webhook 不存在或已被刪除，請到「頻道」重新設定。';
  if (status === 401 || body?.code === 50027) return 'Webhook 金鑰無效，請重新複製連結。';
  if (status === 403) return 'Discord 拒絕這則訊息（權限不足）。';
  if (status === 400) return `Discord 回報訊息格式錯誤：${body?.message ?? ''}`.trim();
  if (status === 413) return '訊息內容太大。';
  if (status === 429) return 'Discord 發送太頻繁，稍後會自動重試。';
  if (status >= 500) return `Discord 暫時無法服務（${status}），稍後會自動重試。`;
  return `Discord 錯誤 ${status}：${body?.message ?? ''}`.trim();
}

/** 有附檔時用 multipart/form-data：payload_json + files[n] */
export function webhookBody(payload: DiscordPayload, files?: SendFile[]): { body: string | FormData; headers: Record<string, string> } {
  if (!files?.length) return { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } };
  const form = new FormData();
  const withAttachments = { ...payload, attachments: files.map((f, i) => ({ id: i, filename: f.name })) };
  form.append('payload_json', JSON.stringify(withAttachments));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes as BlobPart], { type: f.type || 'application/octet-stream' }), f.name));
  return { body: form, headers: {} };
}

export async function executeWebhook(url: string, payload: DiscordPayload, fetchImpl: FetchLike = fetch, files?: SendFile[]): Promise<SendResult> {
  if (!parseWebhook(url)) return { ok: false, error: 'Webhook 網址格式不正確', retryable: false };
  let res: Response;
  try {
    const { body, headers } = webhookBody(payload, files);
    res = await fetchImpl(`${url.replace(/\/$/, '')}?wait=true`, { method: 'POST', headers, body });
  } catch (err) {
    return { ok: false, error: `無法連線到 Discord：${(err as Error).message}`, retryable: true, networkError: true };
  }
  let body: { id?: string; message?: string; code?: number; retry_after?: number } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) return { ok: true, status: res.status, messageId: body?.id };
  const retryAfter = body?.retry_after ?? Number(res.headers.get('retry-after') ?? NaN);
  return {
    ok: false,
    status: res.status,
    error: describe(res.status, body),
    retryable: res.status === 429 || res.status >= 500,
    retryAfterMs: Number.isFinite(retryAfter) ? Math.ceil(retryAfter * 1000) : undefined,
  };
}

export async function deleteWebhookMessage(url: string, messageId: string, fetchImpl: FetchLike = fetch): Promise<SendResult> {
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/messages/${messageId}`, { method: 'DELETE' });
  if (res.ok || res.status === 404) return { ok: true, status: res.status };
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 沒有內容 */
  }
  return { ok: false, status: res.status, error: describe(res.status, body) };
}

export async function editWebhookMessage(
  url: string,
  messageId: string,
  payload: DiscordPayload,
  fetchImpl: FetchLike = fetch,
): Promise<SendResult> {
  // 編輯時不能修改發送者名稱、頭像與投票
  const { username: _u, avatar_url: _a, poll: _p, ...rest } = payload;
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/messages/${messageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rest),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 沒有內容 */
  }
  if (res.ok) return { ok: true, status: res.status, messageId };
  return { ok: false, status: res.status, error: describe(res.status, body) };
}

export interface WebhookInfo {
  name: string;
  channel_id: string;
  guild_id?: string;
  avatar?: string | null;
}

export async function getWebhookInfo(url: string, fetchImpl: FetchLike = fetch): Promise<WebhookInfo> {
  if (!parseWebhook(url)) throw new Error('Webhook 網址格式不正確');
  const res = await fetchImpl(url, { method: 'GET' });
  if (!res.ok) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 沒有內容 */
    }
    throw new Error(describe(res.status, body));
  }
  return res.json();
}
