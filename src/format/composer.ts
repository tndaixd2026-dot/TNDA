// 把結構化內容組成 Discord Webhook 訊息（卡片或純文字兩種樣式）。

import type { ComposeDraft, DiscordEmbed, DiscordEmbedField, DiscordPayload, DiscordPoll, PollDraft, PostType, Settings } from '../core/types.ts';
import { DAY_MS, atTime, fmtDate, fmtTime, unix } from '../core/time.ts';
import type { ParseResult } from './parser.ts';

export interface TypeMeta {
  label: string;
  emoji: string;
  color: number;
  hex: string;
}

export const TYPE_META: Record<PostType, TypeMeta> = {
  class: { label: '上課提醒', emoji: '📚', color: 0x4c8bf5, hex: '#4c8bf5' },
  homework: { label: '作業提醒', emoji: '📝', color: 0xf2a33a, hex: '#f2a33a' },
  makeup: { label: '補課資訊', emoji: '🔁', color: 0x9b6cf2, hex: '#9b6cf2' },
  form: { label: '表單填寫', emoji: '📋', color: 0x2fb36d, hex: '#2fb36d' },
  resource: { label: '學習資源', emoji: '📎', color: 0x17a8a0, hex: '#17a8a0' },
  announce: { label: '一般公告', emoji: '📢', color: 0xe85a71, hex: '#e85a71' },
};

export const POST_TYPES = Object.keys(TYPE_META) as PostType[];

function eventLabel(type: PostType): string {
  if (type === 'class') return '上課時間';
  if (type === 'makeup') return '補課時間';
  return '時間';
}

function deadlineLabel(type: PostType): string {
  if (type === 'homework') return '繳交期限';
  if (type === 'form') return '填寫期限';
  return '截止時間';
}

function linksLabel(type: PostType): string {
  if (type === 'homework') return '繳交連結';
  if (type === 'form') return '表單連結';
  if (type === 'resource') return '資源連結';
  return '相關連結';
}

function timeValue(start: string, end: string | undefined, countdown: boolean): string {
  let v = `<t:${unix(start)}:F>`;
  if (end) v += ` – <t:${unix(end)}:t>`;
  if (countdown) v += `\n<t:${unix(start)}:R>`;
  return v;
}

export function draftFields(d: ComposeDraft): DiscordEmbedField[] {
  const fields: DiscordEmbedField[] = [];
  if (d.eventAt) {
    fields.push({ name: `🕒 ${eventLabel(d.type)}`, value: timeValue(d.eventAt, d.eventEnd, d.showCountdown), inline: true });
  }
  if (d.location?.trim()) fields.push({ name: '📍 地點', value: d.location.trim(), inline: true });
  if (d.deadline) {
    fields.push({ name: `⏰ ${deadlineLabel(d.type)}`, value: timeValue(d.deadline, undefined, d.showCountdown), inline: true });
  }
  if (d.notes?.trim()) fields.push({ name: '📌 注意事項', value: d.notes.trim(), inline: false });
  const links = d.links.filter((l) => l.url.trim());
  if (links.length) {
    fields.push({
      name: `🔗 ${linksLabel(d.type)}`,
      value: links.map((l) => `• [${(l.label || '連結').replace(/[[\]]/g, '')}](${l.url.trim()})`).join('\n'),
      inline: false,
    });
  }
  return fields;
}

/** 只通知原文裡明確標註的身分組與成員（@everyone／@here 也照原文） */
export function mentionsIn(content: string): NonNullable<DiscordPayload['allowed_mentions']> {
  const ids = (re: RegExp) => [...new Set([...content.matchAll(re)].map((m) => m[1]))].slice(0, 100);
  const roles = ids(/<@&(\d+)>/g);
  const users = ids(/<@!?(\d+)>/g);
  return {
    parse: /@(everyone|here)\b/.test(content) ? ['everyone'] : [],
    ...(roles.length ? { roles } : {}),
    ...(users.length ? { users } : {}),
  };
}

/** 投票可選的開放時間（小時），與 Discord 介面相同 */
export const POLL_DURATIONS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: '1 小時' },
  { hours: 4, label: '4 小時' },
  { hours: 8, label: '8 小時' },
  { hours: 24, label: '1 天' },
  { hours: 72, label: '3 天' },
  { hours: 168, label: '1 週' },
  { hours: 336, label: '2 週' },
];

export function pollDurationLabel(hours: number): string {
  const preset = POLL_DURATIONS.find((d) => d.hours === hours);
  if (preset) return preset.label;
  return hours % 24 === 0 ? `${hours / 24} 天` : `${hours} 小時`;
}

export function emptyPoll(): PollDraft {
  return { question: '', answers: [{ text: '' }, { text: '' }], hours: 24, multi: false };
}

const EMOJI_LEAD = /^(\p{Extended_Pictographic}(?:\uFE0F|\u20E3|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*/u;

/** 「🛠️ 有使用 TD 做過專案」→ { emoji: '🛠️', text: '有使用 TD 做過專案' } */
export function splitAnswer(raw: string): { text: string; emoji?: string } {
  const s = raw.trim();
  const m = EMOJI_LEAD.exec(s);
  if (m && s.length > m[0].length) return { emoji: m[1], text: s.slice(m[0].length).trim() };
  return { text: s };
}

export function isSingleEmoji(s: string): boolean {
  const m = EMOJI_LEAD.exec(s.trim());
  return !!m && m[0].trim() === s.trim();
}

function pollPayload(p: PollDraft | undefined): DiscordPoll | undefined {
  if (!p) return undefined;
  return {
    question: { text: p.question.trim() },
    answers: p.answers
      .filter((a) => a.text.trim() || a.emoji?.trim())
      .map((a) => ({ poll_media: { text: a.text.trim(), ...(a.emoji?.trim() ? { emoji: { name: a.emoji.trim() } } : {}) } })),
    duration: p.hours,
    allow_multiselect: p.multi,
    layout_type: 1,
  };
}

export function composePayload(d: ComposeDraft, settings: Settings): DiscordPayload {
  const payload = composeMessage(d, settings);
  const poll = pollPayload(d.poll);
  if (poll) {
    payload.poll = poll;
    if (!payload.content) delete payload.content;
  }
  return payload;
}

function composeMessage(d: ComposeDraft, settings: Settings): DiscordPayload {
  const meta = TYPE_META[d.type];
  const mentionText = d.mention === 'everyone' ? '@everyone' : d.mention === 'here' ? '@here' : '';
  const title = d.title.trim() || meta.label;
  const payload: DiscordPayload = {
    username: settings.senderName || undefined,
    avatar_url: settings.avatarUrl || undefined,
    allowed_mentions: { parse: mentionText ? ['everyone'] : [] },
  };

  if (d.style === 'raw') {
    const text = d.raw.trim();
    payload.content = mentionText ? `${mentionText}\n${text}` : text;
    payload.allowed_mentions = mentionsIn(payload.content);
    return payload;
  }

  if (d.style === 'text') {
    const parts: string[] = [];
    if (mentionText) parts.push(mentionText);
    parts.push(`## ${meta.emoji} ${title}`);
    if (d.body.trim()) parts.push(d.body.trim());
    const lines: string[] = [];
    for (const f of draftFields(d)) {
      const value = f.value.replace(/\n/g, '　');
      lines.push(f.name.startsWith('🔗') ? `**${f.name}**\n${value.replace(/　/g, '\n')}` : `**${f.name}**　${value}`);
    }
    if (lines.length) parts.push(lines.join('\n'));
    if (d.imageUrl?.trim()) parts.push(d.imageUrl.trim());
    if (settings.footer) parts.push(`-# ${settings.footer}`);
    payload.content = parts.join('\n\n');
    return payload;
  }

  const embed: DiscordEmbed = {
    title: `${meta.emoji} ${title}`.slice(0, 256),
    color: meta.color,
  };
  if (d.body.trim()) embed.description = d.body.trim();
  const fields = draftFields(d);
  if (fields.length) embed.fields = fields;
  if (d.imageUrl?.trim()) embed.image = { url: d.imageUrl.trim() };
  if (settings.footer) embed.footer = { text: settings.footer };
  payload.embeds = [embed];
  if (mentionText) payload.content = mentionText;
  return payload;
}

export function draftFromParse(p: ParseResult, raw: string, settings: Settings): ComposeDraft {
  return {
    raw,
    type: p.type,
    style: 'embed',
    title: p.title,
    body: p.body,
    eventAt: p.eventAt,
    eventEnd: p.eventEnd,
    deadline: p.deadline,
    location: p.location,
    links: p.links,
    notes: p.notes,
    mention: p.mention !== 'none' ? p.mention : settings.defaultMention,
    showCountdown: true,
  };
}

export function emptyDraft(settings: Settings): ComposeDraft {
  return {
    raw: '',
    type: 'announce',
    style: 'embed',
    title: '',
    body: '',
    links: [],
    mention: settings.defaultMention,
    showCountdown: true,
  };
}

// ───────────────────────── 建議的發送時間（提醒鏈） ─────────────────────────

export interface ReminderOption {
  key: string;
  label: string;
  at: string;
  recommended?: boolean;
}

export function suggestReminders(d: Pick<ComposeDraft, 'type' | 'eventAt' | 'deadline'>, now: Date = new Date()): ReminderOption[] {
  const nowMs = now.getTime();
  const opts: ReminderOption[] = [];
  const add = (key: string, label: string, at: Date, recommended = false) => {
    if (at.getTime() > nowMs + 60000) opts.push({ key, label, at: at.toISOString(), recommended });
  };
  const anchor = d.type === 'homework' || d.type === 'form' ? d.deadline ?? d.eventAt : d.eventAt ?? d.deadline;
  if (anchor) {
    const a = new Date(anchor);
    const isDeadline = anchor === d.deadline;
    const what = isDeadline ? '截止' : d.type === 'makeup' ? '補課' : '開始';
    if (isDeadline) {
      add('d-3', `${what}前 3 天早上（${fmtDate(a.getTime() - 3 * DAY_MS)} 09:00）`, atTime(a.getTime() - 3 * DAY_MS, 9));
      add('d-1', `${what}前 1 天晚上（${fmtDate(a.getTime() - DAY_MS)} 20:00）`, atTime(a.getTime() - DAY_MS, 20), true);
      add('d-0', `${what}當天早上（${fmtDate(a)} 09:00）`, atTime(a, 9));
      add('h-3', `${what}前 3 小時（${fmtTime(a.getTime() - 3 * 3600000)}）`, new Date(a.getTime() - 3 * 3600000));
    } else {
      add('d-7', `${what}前一週（${fmtDate(a.getTime() - 7 * DAY_MS)} 20:00）`, atTime(a.getTime() - 7 * DAY_MS, 20));
      add('d-1', `${what}前 1 天晚上（${fmtDate(a.getTime() - DAY_MS)} 20:00）`, atTime(a.getTime() - DAY_MS, 20), true);
      add('d-0', `當天早上（${fmtDate(a)} 09:00）`, atTime(a, 9));
      add('h-1', `${what}前 1 小時（${fmtTime(a.getTime() - 3600000)}）`, new Date(a.getTime() - 3600000));
    }
  }
  // 若推薦時間已過，改推薦最近的一個
  if (opts.length && !opts.some((o) => o.recommended)) opts[0].recommended = true;
  return opts.filter((o, i, arr) => arr.findIndex((x) => x.at === o.at) === i);
}
