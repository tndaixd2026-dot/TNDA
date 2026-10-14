// 頻道清單：預設的群組結構、批次匯入解析、依貼文類型建議頻道。

import type { Audience, Channel, ChannelKind, PostType } from './types.ts';
import { parseWebhook } from './discord.ts';

/** 預設頻道（不含 Webhook 網址；網址只會加密後存在資料分支）。 */
export const DEFAULT_CHANNELS: Channel[] = [
  ch('a-announce', 'A', '互動學程大群組', '公告欄', 'student', 'announce'),
  ch('a-chat', 'A', '互動學程大群組', '交流區', 'student', 'chat'),
  ch('b-announce', 'B', '三-VSAI 互動機台', '課程公告', 'student', 'announce'),
  ch('b-homework', 'B', '三-VSAI 互動機台', '課後作業', 'student', 'homework'),
  ch('b-makeup', 'B', '三-VSAI 互動機台', '補課資訊', 'student', 'makeup'),
  ch('b-form', 'B', '三-VSAI 互動機台', '課後表單', 'student', 'form'),
  ch('b-resource', 'B', '三-VSAI 互動機台', '學習資源', 'student', 'resource'),
  ch('b-discuss', 'B', '三-VSAI 互動機台', '討論室', 'student', 'discuss'),
  ch('c-announce', 'C', '四-跨域數位製作 TN0006', '課程公告', 'student', 'announce'),
  ch('c-homework', 'C', '四-跨域數位製作 TN0006', '課後作業', 'student', 'homework'),
  ch('c-makeup', 'C', '四-跨域數位製作 TN0006', '補課資訊', 'student', 'makeup'),
  ch('c-form', 'C', '四-跨域數位製作 TN0006', '課後表單', 'student', 'form'),
  ch('c-resource', 'C', '四-跨域數位製作 TN0006', '學習資源', 'student', 'resource'),
  ch('c-discuss', 'C', '四-跨域數位製作 TN0006', '討論室', 'student', 'discuss'),
  ch('d-mentor', 'D', '業師群組（非學員）', '業師群組', 'staff', 'staff'),
  ch('d-assistant', 'D', '業師群組（非學員）', '助理群組', 'staff', 'staff'),
  ch('test', 'T', '測試區', '測試區', 'test', 'test'),
];

function ch(id: string, group: string, groupName: string, name: string, audience: Audience, kind: ChannelKind): Channel {
  return { id, group, groupName, name, audience, kind };
}

export function guessKind(name: string, groupName = ''): ChannelKind {
  const s = `${groupName} ${name}`;
  if (/測試|test/i.test(name) || /測試/.test(groupName)) return 'test';
  if (/業師|助理|講師|老師群|staff/i.test(name)) return 'staff';
  if (/作業|homework/i.test(name)) return 'homework';
  if (/補課|調課|停課/.test(name)) return 'makeup';
  if (/表單|問卷|回饋|form/i.test(name)) return 'form';
  if (/資源|教材|講義|resource/i.test(name)) return 'resource';
  if (/討論|問答|Q&A/i.test(name)) return 'discuss';
  if (/交流|閒聊|聊天|chat/i.test(name)) return 'chat';
  if (/公告|announce|通知/i.test(name)) return 'announce';
  if (/業師|非學員/.test(s)) return 'staff';
  return 'other';
}

export function guessAudience(name: string, groupName: string): Audience {
  if (/測試|test/i.test(groupName) || /測試/.test(name)) return 'test';
  if (/非學員|業師|助理|staff/i.test(groupName) || /業師|助理/.test(name)) return 'staff';
  return 'student';
}

export interface ImportResult {
  channels: Channel[];
  warnings: string[];
}

const URL_RE = /https?:\/\/\S+/;

/**
 * 解析一段「群組標題 / 頻道名稱 / Webhook 網址」的文字，例如：
 *
 * 【B｜三-VSAI 互動機台】
 * 課程公告
 * https://discord.com/api/webhooks/...
 *
 * 會盡量對應到預設頻道的 id，讓既有貼文的頻道設定不會跑掉。
 */
export function parseWebhookBlock(text: string, existing: Channel[] = DEFAULT_CHANNELS): ImportResult {
  const warnings: string[] = [];
  const channels: Channel[] = [];
  let group = { code: '', name: '' };
  let pendingName: string | null = null;
  let autoCode = 0;
  const usedIds = new Set<string>();

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const header = /^[【\[]\s*(?:([A-Za-z0-9]{1,3})\s*[｜|:：.、-]\s*)?(.+?)\s*[】\]]\s*(.*)$/.exec(line);
    if (header) {
      const name = header[2].trim();
      const code = (header[1] ?? '').toUpperCase() || codeForGroupName(name, existing) || `G${++autoCode}`;
      group = { code, name };
      pendingName = null;
      const tail = header[3]?.trim();
      if (tail && URL_RE.test(tail)) {
        addChannel(name, tail.match(URL_RE)![0]);
      }
      continue;
    }
    const urlMatch = line.match(URL_RE);
    if (urlMatch) {
      const before = line.slice(0, urlMatch.index).replace(/[:：\s]+$/, '').trim();
      addChannel(before || pendingName || group.name || '未命名頻道', urlMatch[0]);
      pendingName = null;
      continue;
    }
    pendingName = line.replace(/[:：]$/, '');
  }

  function addChannel(name: string, url: string) {
    if (!parseWebhook(url)) {
      warnings.push(`「${name}」的網址不是 Discord Webhook，已略過。`);
      return;
    }
    const groupName = group.name || '未分類';
    const code = group.code || 'X';
    const match = existing.find(
      (c) => (c.group === code || c.groupName === groupName) && c.name === name && !usedIds.has(c.id),
    );
    let id = match?.id ?? `${code.toLowerCase()}-${slug(name)}`;
    while (usedIds.has(id)) id = `${id}-2`;
    usedIds.add(id);
    channels.push({
      id,
      name,
      group: code,
      groupName,
      audience: match?.audience ?? guessAudience(name, groupName),
      kind: match?.kind ?? guessKind(name, groupName),
      webhook: url,
    });
  }

  if (channels.length === 0) warnings.push('沒有找到任何 Discord Webhook 網址。');
  return { channels, warnings };
}

function codeForGroupName(name: string, existing: Channel[]): string | null {
  const hit = existing.find((c) => c.groupName === name || c.groupName.includes(name) || name.includes(c.groupName));
  if (hit) return hit.group;
  if (/測試/.test(name)) return 'T';
  return null;
}

function slug(name: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (ascii) return ascii;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/** 合併匯入結果：同 id 更新名稱與網址，新頻道加到最後。 */
export function mergeChannels(current: Channel[], incoming: Channel[]): Channel[] {
  const out = current.map((c) => ({ ...c }));
  for (const inc of incoming) {
    const idx = out.findIndex((c) => c.id === inc.id);
    if (idx >= 0) out[idx] = { ...out[idx], ...inc };
    else out.push(inc);
  }
  return out;
}

export interface ChannelGroup {
  code: string;
  name: string;
  audience: Audience;
  channels: Channel[];
}

export function groupChannels(channels: Channel[]): ChannelGroup[] {
  const map = new Map<string, ChannelGroup>();
  for (const c of channels) {
    let g = map.get(c.group);
    if (!g) {
      g = { code: c.group, name: c.groupName, audience: c.audience, channels: [] };
      map.set(c.group, g);
    }
    g.channels.push(c);
  }
  return [...map.values()];
}

const KIND_FOR_TYPE: Record<PostType, ChannelKind[]> = {
  class: ['announce'],
  homework: ['homework'],
  makeup: ['makeup'],
  form: ['form'],
  resource: ['resource'],
  announce: ['announce'],
};

/** 依貼文類型與課程建議要發送的頻道 */
export function suggestChannels(type: PostType, channels: Channel[], courseGroup?: string): string[] {
  // 沒有辨識出課程時不自動勾選，避免發錯群組
  if (!courseGroup) return [];
  const scoped = channels.filter((c) => c.group === courseGroup);
  const hits = scoped.filter((c) => KIND_FOR_TYPE[type].includes(c.kind));
  if (hits.length) return hits.map((c) => c.id);
  const fallback = scoped.find((c) => c.kind === 'announce') ?? scoped[0];
  return fallback ? [fallback.id] : [];
}

/** 列出所有課程中與貼文類型相符的頻道（用來在選單上標示「建議」） */
export function matchingChannels(type: PostType, channels: Channel[]): string[] {
  return channels.filter((c) => c.audience === 'student' && KIND_FOR_TYPE[type].includes(c.kind)).map((c) => c.id);
}

/** 從文字判斷是哪一門課（對應群組代碼）。 */
export function detectCourse(text: string, channels: Channel[]): string | undefined {
  const rules: Array<[RegExp, (c: Channel) => boolean]> = [
    [/VSAI|互動機台|機台/i, (c) => /VSAI|互動機台/i.test(c.groupName)],
    [/TN0006|跨域|數位製作/i, (c) => /TN0006|跨域|數位製作/i.test(c.groupName)],
    [/業師|講師會議|助理/, (c) => c.audience === 'staff'],
  ];
  for (const [re, pick] of rules) {
    if (re.test(text)) {
      const hit = channels.find(pick);
      if (hit) return hit.group;
    }
  }
  return undefined;
}
