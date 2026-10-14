// 智慧整理引擎：把老師隨手貼上的文字，辨識出類型、時間、截止日、地點、連結與注意事項。
// 純規則式（不需要 AI、不需要網路、完全免費），全部以台北時間計算。

import type { LinkItem, MentionMode, PostType } from '../core/types.ts';
import { DAY_MS, WEEKDAYS, fromTp, tpParts, fmtDateTime } from '../core/time.ts';

export interface Detection {
  kind: 'type' | 'event' | 'deadline' | 'location' | 'link' | 'notes' | 'mention' | 'assumption' | 'rewrite';
  label: string;
}

export interface ParseResult {
  type: PostType;
  title: string;
  body: string;
  eventAt?: string;
  eventEnd?: string;
  deadline?: string;
  location?: string;
  links: LinkItem[];
  notes?: string;
  mention: MentionMode;
  detections: Detection[];
}

export const TYPE_LABELS: Record<PostType, string> = {
  class: '上課提醒',
  homework: '作業提醒',
  makeup: '補課資訊',
  form: '表單填寫',
  resource: '學習資源',
  announce: '一般公告',
};

// ───────────────────────── 中文數字 ─────────────────────────

const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function cnToNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  const ten = s.indexOf('十');
  if (ten >= 0) {
    const tens = ten === 0 ? 1 : CN_DIGITS[s[ten - 1]] ?? 0;
    const ones = ten === s.length - 1 ? 0 : CN_DIGITS[s[ten + 1]] ?? 0;
    return tens * 10 + ones;
  }
  let n = 0;
  for (const ch of s) n = n * 10 + (CN_DIGITS[ch] ?? 0);
  return n;
}

const NUM = '(\\d{1,2}|[零〇一二兩三四五六七八九十]{1,3})';

// ───────────────────────── 日期與時間 token ─────────────────────────

interface DateTok {
  start: number;
  end: number;
  y: number;
  m: number;
  d: number;
  explicit: boolean;
  period?: 'am' | 'pm';
}

interface TimeTok {
  start: number;
  end: number;
  hh: number;
  mm: number;
  endHh?: number;
  endMm?: number;
  /** 是否明確寫出上午/下午等字樣 */
  hasPeriod: boolean;
}

const PM_WORDS = /^(下午|晚上|傍晚|晚間|夜間|夜晚|晚|pm|p\.m\.)$/i;
const AM_WORDS = /^(上午|早上|清晨|早|凌晨|am|a\.m\.)$/i;

function applyPeriod(h: number, period: string | undefined, implied?: 'am' | 'pm'): { h: number; has: boolean } {
  if (period) {
    if (PM_WORDS.test(period)) return { h: h < 12 ? h + 12 : h, has: true };
    if (period === '中午') return { h: h < 6 ? h + 12 : h, has: true };
    if (AM_WORDS.test(period)) return { h: h === 12 ? 0 : h, has: true };
  }
  if (implied === 'pm') return { h: h < 12 ? h + 12 : h, has: true };
  // 沒寫上下午時，1～6 點幾乎都是指下午
  if (h >= 1 && h <= 6) return { h: h + 12, has: false };
  return { h, has: false };
}

function weekdayIndex(ch: string): number {
  const map: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 };
  return map[ch] ?? -1;
}

function inferYear(m: number, d: number, now: Date): number {
  const p = tpParts(now);
  const candidate = fromTp(p.y, m, d).getTime();
  // 超過 60 天前的日期，視為明年
  return candidate < now.getTime() - 60 * DAY_MS ? p.y + 1 : p.y;
}

function collectDates(scan: string, now: Date, warnings: string[] = []): DateTok[] {
  const toks: DateTok[] = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const push = (t: DateTok) => {
    if (overlaps(t.start, t.end)) return;
    if (t.m < 1 || t.m > 12 || t.d < 1 || t.d > 31) return;
    taken.push([t.start, t.end]);
    toks.push(t);
  };
  const today = tpParts(now);

  for (const m of scan.matchAll(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})(?:\s*[日號])?/g)) {
    push({ start: m.index!, end: m.index! + m[0].length, y: +m[1], m: +m[2], d: +m[3], explicit: true });
  }
  for (const m of scan.matchAll(new RegExp(`${NUM}\\s*月\\s*${NUM}\\s*[日號]`, 'g'))) {
    const mo = cnToNumber(m[1]);
    const d = cnToNumber(m[2]);
    push({ start: m.index!, end: m.index! + m[0].length, y: inferYear(mo, d, now), m: mo, d, explicit: true });
  }
  for (const m of scan.matchAll(/(?<![\d\/.])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d\/])/g)) {
    const mo = +m[1];
    const d = +m[2];
    push({ start: m.index!, end: m.index! + m[0].length, y: inferYear(mo, d, now), m: mo, d, explicit: true });
  }
  const rel: Record<string, [number, 'am' | 'pm' | undefined]> = {
    今天: [0, undefined], 今日: [0, undefined], 今晚: [0, 'pm'], 今早: [0, 'am'],
    明天: [1, undefined], 明日: [1, undefined], 明晚: [1, 'pm'], 明早: [1, 'am'],
    後天: [2, undefined], 大後天: [3, undefined],
  };
  for (const m of scan.matchAll(/大後天|後天|明天|明日|明晚|明早|今天|今日|今晚|今早/g)) {
    const [offset, period] = rel[m[0]];
    const p = tpParts(now.getTime() + offset * DAY_MS);
    push({ start: m.index!, end: m.index! + m[0].length, y: p.y, m: p.m, d: p.d, explicit: false, period });
  }
  for (const m of scan.matchAll(/(下下(?:個)?|下個?|這個?|本|上個?)?\s*(?:週|周|星期|禮拜)\s*([一二三四五六日天1-7])/g)) {
    const start = m.index!;
    // 緊跟在明確日期後面的（週三），只是補充說明
    const owner = toks.find((t) => t.explicit && start >= t.end && start - t.end <= 3);
    if (owner) {
      taken.push([start, start + m[0].length]);
      const actual = tpParts(fromTp(owner.y, owner.m, owner.d, 12)).dow;
      const written = weekdayIndex(m[2]);
      if (written >= 0 && written !== actual) {
        warnings.push(`${owner.m}/${owner.d} 是星期${'日一二三四五六'[actual]}，不是星期${'日一二三四五六'[written]}，請確認日期`);
      }
      continue;
    }
    const target = weekdayIndex(m[2]);
    if (target < 0) continue;
    const prefix = m[1] ?? '';
    // 以週一為一週的開始
    const todayMon = (today.dow + 6) % 7;
    const targetMon = (target + 6) % 7;
    let offset: number;
    if (prefix.startsWith('下下')) offset = 14 - todayMon + targetMon;
    else if (prefix.startsWith('下')) offset = 7 - todayMon + targetMon;
    else if (prefix.startsWith('上')) offset = -7 - todayMon + targetMon;
    else if (prefix.startsWith('這') || prefix === '本') offset = targetMon - todayMon;
    else offset = (target - today.dow + 7) % 7;
    const p = tpParts(now.getTime() + offset * DAY_MS);
    push({ start, end: start + m[0].length, y: p.y, m: p.m, d: p.d, explicit: false });
  }
  for (const m of scan.matchAll(/[（(]\s*([一二三四五六日天])\s*[)）]/g)) {
    const start = m.index!;
    const owner = toks.find((t) => t.explicit && start >= t.end && start - t.end <= 2);
    if (!owner) continue;
    const actual = tpParts(fromTp(owner.y, owner.m, owner.d, 12)).dow;
    const written = weekdayIndex(m[1]);
    if (written >= 0 && written !== actual) {
      warnings.push(`${owner.m}/${owner.d} 是星期${'日一二三四五六'[actual]}，不是星期${'日一二三四五六'[written]}，請確認日期`);
    }
  }
  return toks.sort((a, b) => a.start - b.start);
}

function collectTimes(scan: string, dates: DateTok[]): TimeTok[] {
  const toks: TimeTok[] = [];
  const taken: Array<[number, number]> = dates.map((d) => [d.start, d.end]);
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const impliedAt = (pos: number) => {
    const d = [...dates].reverse().find((t) => t.end <= pos && pos - t.end <= 8);
    return d?.period;
  };

  const raw: Array<{ start: number; end: number; h: number; mm: number; period?: string }> = [];
  const periodRe = '(上午|早上|清晨|中午|下午|晚上|傍晚|晚間|夜間|夜晚|凌晨)?\\s*';
  for (const m of scan.matchAll(new RegExp(`${periodRe}(\\d{1,2})\\s*[:：]\\s*(\\d{2})(?:\\s*(am|pm|a\\.m\\.|p\\.m\\.))?`, 'gi'))) {
    const h = +m[2];
    const mm = +m[3];
    if (h > 24 || mm > 59) continue;
    const lead = m[0].length - m[0].trimStart().length;
    raw.push({ start: m.index! + lead, end: m.index! + m[0].length, h, mm, period: m[1] ?? m[4] });
  }
  for (const m of scan.matchAll(new RegExp(`${periodRe}${NUM}\\s*[點点時](?![點点])(?:\\s*(半|整|${NUM}\\s*分))?`, 'g'))) {
    const start = m.index! + (m[0].length - m[0].trimStart().length);
    if (scan[start - 1] === '第' || /[小鐘]/.test(scan[m.index! + m[0].length] ?? '')) continue;
    const isCn = !/^\d/.test(m[2]);
    // 中文數字（例如「一點」）容易誤判，需要有上下午字樣、分鐘或日期在前
    if (isCn && !m[1] && !m[3] && !dates.some((d) => d.end <= start && start - d.end <= 6)) continue;
    const h = cnToNumber(m[2]);
    let mm = 0;
    if (m[3] === '半') mm = 30;
    else if (m[4]) mm = cnToNumber(m[4]);
    if (h > 24 || mm > 59) continue;
    raw.push({ start, end: m.index! + m[0].length, h, mm, period: m[1] });
  }
  raw.sort((a, b) => a.start - b.start);

  for (const r of raw) {
    if (overlaps(r.start, r.end)) continue;
    const { h, has } = applyPeriod(r.h, r.period, impliedAt(r.start));
    taken.push([r.start, r.end]);
    toks.push({ start: r.start, end: r.end, hh: h % 24, mm: r.mm, hasPeriod: has });
  }

  // 合併「19:00-22:00」這類時間區間
  const merged: TimeTok[] = [];
  for (const t of toks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.endHh === undefined) {
      const between = scan.slice(prev.end, t.start);
      if (/^\s*[-~～〜至到–—]\s*$/.test(between)) {
        let endH = t.hh;
        if (!t.hasPeriod && prev.hh >= 12 && endH < 12) endH += 12;
        if (!t.hasPeriod && endH < prev.hh && endH + 12 < 24) endH += 12;
        prev.endHh = endH;
        prev.endMm = t.mm;
        prev.end = t.end;
        continue;
      }
    }
    merged.push({ ...t });
  }
  return merged;
}

interface Candidate {
  start: number;
  end: number;
  at: Date;
  endAt?: Date;
  hasTime: boolean;
  hasDate: boolean;
  relative: boolean;
  kind: 'event' | 'deadline';
  score: number;
}

const DEADLINE_AFTER = /^\s*(?:\(|（)?[^\n]{0,3}?(?:前|之前|以前|為止|截止|止)/;
const DEADLINE_BEFORE = /(截止|期限|deadline|due|繳交|上傳|提交|填寫|完成|交件|收件)/i;
const EVENT_BEFORE = /(上課|課程|補課|集合|活動|講座|會議|開會|開始|見面|分享會|工作坊|展覽|發表)/;

function best(cands: Candidate[]): Candidate | undefined {
  let pick: Candidate | undefined;
  for (const c of cands) if (!pick || c.score > pick.score) pick = c;
  return pick;
}

function lineBounds(text: string, pos: number): [number, number] {
  const s = text.lastIndexOf('\n', pos - 1) + 1;
  const e = text.indexOf('\n', pos);
  return [s, e < 0 ? text.length : e];
}

function buildCandidates(scan: string, dates: DateTok[], times: TimeTok[], now: Date): Candidate[] {
  const out: Candidate[] = [];
  const usedDates = new Set<DateTok>();
  for (const t of times) {
    // 找最近的前一個日期；同一行沒有的話，往前找最近的
    let date = [...dates].reverse().find((d) => d.end <= t.start);
    if (!date) date = dates.find((d) => d.start >= t.end && d.start - t.end <= 6);
    let y: number;
    let mo: number;
    let d: number;
    let hasDate = true;
    if (date) {
      usedDates.add(date);
      ({ y, m: mo, d } = date);
    } else {
      hasDate = false;
      // 沒寫日期：取下一個會出現的這個時刻
      const p = tpParts(now);
      const todayAt = fromTp(p.y, p.m, p.d, t.hh, t.mm);
      const base = todayAt.getTime() > now.getTime() ? todayAt : new Date(todayAt.getTime() + DAY_MS);
      const bp = tpParts(base);
      y = bp.y;
      mo = bp.m;
      d = bp.d;
    }
    const at = fromTp(y, mo, d, t.hh, t.mm);
    const endAt = t.endHh !== undefined ? fromTp(y, mo, d, t.endHh, t.endMm ?? 0) : undefined;
    const start = date && date.start < t.start ? date.start : t.start;
    out.push({ start, end: t.end, at, endAt, hasTime: true, hasDate, relative: !date?.explicit, kind: 'event', score: 0 });
  }
  for (const date of dates) {
    if (usedDates.has(date)) continue;
    out.push({
      start: date.start,
      end: date.end,
      at: fromTp(date.y, date.m, date.d, 9, 0),
      hasTime: false,
      hasDate: true,
      relative: !date.explicit,
      kind: 'event',
      score: 0,
    });
  }
  for (const c of out) {
    const [ls] = lineBounds(scan, c.start);
    const before = scan.slice(ls, c.start);
    const after = scan.slice(c.end, c.end + 12);
    // 「原 10/15」是舊日期；「改到 10/18」是新日期
    c.score = (c.hasTime ? 2 : 0) + (c.hasDate ? 1 : 0);
    if (/(原本|原訂|原定|原先|原)\s*$/.test(before)) c.score -= 4;
    if (/(改到|改至|改為|改成|延到|延至|順延至|順延到|補課於|移到|移至)\s*$/.test(before)) c.score += 3;
    if (DEADLINE_AFTER.test(after) || (DEADLINE_BEFORE.test(before) && !EVENT_BEFORE.test(before))) {
      c.kind = 'deadline';
      if (!c.hasTime) {
        const p = tpParts(c.at);
        c.at = fromTp(p.y, p.m, p.d, 23, 59);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ───────────────────────── 連結、地點、其他 ─────────────────────────

const URL_RE = /https?:\/\/[^\s<>()（）「」，。、；]+[^\s<>()（）「」，。、；.,!?！？:：'"]/g;
const HAS_URL = /https?:\/\/\S/;

export function labelForUrl(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '連結';
  }
  if (/forms\.gle|docs\.google\.com\/forms|surveycake|typeform|forms\.office/.test(url)) return '填寫表單';
  if (/docs\.google\.com\/presentation/.test(url)) return '簡報';
  if (/docs\.google\.com\/spreadsheets/.test(url)) return '試算表';
  if (/docs\.google\.com\/document/.test(url)) return '文件';
  if (/drive\.google\.com/.test(url)) return '雲端硬碟';
  if (/youtu\.?be/.test(host)) return '影片';
  if (/meet\.google\.com/.test(host)) return 'Google Meet';
  if (/zoom\.us/.test(host)) return 'Zoom 會議';
  if (/teams\.microsoft/.test(host)) return 'Teams 會議';
  if (/github\.com/.test(host)) return 'GitHub';
  if (/figma\.com/.test(host)) return 'Figma';
  if (/canva\.com/.test(host)) return 'Canva';
  if (/notion\.(so|site)/.test(host)) return 'Notion';
  if (/hackmd\.io/.test(host)) return 'HackMD';
  if (/padlet\.com/.test(host)) return 'Padlet';
  if (/miro\.com/.test(host)) return 'Miro';
  return host;
}

const LABEL_LINE =
  /^\s*[-•・●○◆▪*]?\s*(時間|日期|上課時間|補課時間|活動時間|地點|教室|上課地點|補課地點|集合地點|場地|截止|截止時間|截止日期|繳交期限|期限|連結|網址|表單|表單連結|繳交連結|資料|注意事項|備註|攜帶物品|請攜帶)\s*[:：]\s*(.*)$/;

function cleanLabel(s: string): string {
  return s.replace(/[\s:：\-–—>→👉🔗]+$/u, '').replace(/^[\s\-•・●○◆▪*]+/, '').trim();
}

function isLinkLine(line: string): boolean {
  const matches = [...line.matchAll(URL_RE)];
  if (matches.length === 0) return false;
  const last = matches[matches.length - 1];
  const after = line.slice(last.index! + last[0].length).replace(/[\s。.!！]/g, '');
  const before = cleanLabel(line.slice(0, matches[0].index).replace(LABEL_PREFIX, ''));
  return after.length === 0 && before.length <= 12 && !/[。，,！!？?]/.test(before);
}

const LABEL_PREFIX = /^\s*(連結|網址|表單|資料)\s*[:：]\s*/;

function extractLinks(text: string): LinkItem[] {
  const links: LinkItem[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(URL_RE)) {
      const url = m[0];
      if (seen.has(url)) continue;
      seen.add(url);
      let label = cleanLabel(line.slice(0, m.index));
      const labelled = LABEL_LINE.exec(line);
      if (labelled && /連結|網址|表單|資料/.test(labelled[1])) label = labelled[1] === '連結' || labelled[1] === '網址' ? '' : labelled[1];
      if (label.length > 12 || label.length === 0 || /[。，,！!？?]|^(請|大家|記得)/.test(label)) label = labelForUrl(url);
      links.push({ label, url });
    }
  }
  return links;
}

function extractLocation(text: string, original: string): string | undefined {
  const labelled = /(?:上課地點|補課地點|集合地點|地點|教室|場地|地址)\s*[:：]\s*([^\n，,。；;]+)/.exec(text);
  if (labelled) return labelled[1].trim();
  const room = /在\s*([^\s，,。；;、]{1,24}?(?:教室|會議室|演講廳|講堂|館|大樓|中心|實驗室|工作室|空間|基地|\d{2,4}\s*室))/.exec(text);
  if (room) return room[1].trim();
  const code = /(?<![\w/.])([A-Z]{0,3}\d{3,4})\s*(教室|室)/.exec(text);
  if (code) return `${code[1]} ${code[2]}`;
  if (/meet\.google\.com/.test(original)) return '線上（Google Meet）';
  if (/zoom\.us/.test(original)) return '線上（Zoom）';
  if (/teams\.microsoft/.test(original)) return '線上（Teams）';
  if (/線上|遠距|視訊/.test(text)) return '線上';
  return undefined;
}

function extractNotes(text: string): string | undefined {
  const labelled = /(?:注意事項|備註|攜帶物品)\s*[:：]\s*([^\n]+)/.exec(text);
  if (labelled) return labelled[1].trim();
  const bring = /(?:請|記得|務必|需)?\s*(?:攜帶|帶上|帶著|帶)\s*([^\n。！!；;]{2,40})/.exec(text);
  if (bring && !/帶領|帶來的|帶到/.test(bring[0])) {
    const items = bring[1].replace(/[，,]?\s*(?:來|到|喔|唷|哦|哈).*$/, '').trim();
    if (items) return `請攜帶：${items}`;
  }
  return undefined;
}

function scoreTypes(text: string, hasEvent: boolean, hasDeadline: boolean, links: LinkItem[]): Record<PostType, number> {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const s: Record<PostType, number> = {
    class: count(/上課|課程|教室|出席|點名|筆電|課堂|開課|第.{1,3}週|第.{1,3}堂/g) * 1.5 + (hasEvent ? 1 : 0),
    homework: count(/作業|繳交|上傳|報告|作品|提交|功課|HW\d*|homework|assignment/gi) * 2 + (hasDeadline ? 1.5 : 0),
    makeup: count(/補課|調課|停課|改期|延期|補上課|順延|改到/g) * 3,
    form: count(/表單|問卷|填寫|回饋|簽到|報名|調查/g) * 2 + (links.some((l) => l.label === '填寫表單') ? 3 : 0),
    resource: count(/資源|講義|簡報|教材|投影片|參考資料|錄影|影片|延伸閱讀|下載|筆記|範例檔/g) * 2,
    announce: 0.5 + count(/公告|通知|重要|宣布|注意|會議|開會|講座|活動|說明會|分享會|工作坊/g),
  };
  if (s.makeup > 0) s.class *= 0.5;
  return s;
}

function pickType(scores: Record<PostType, number>): PostType {
  let best: PostType = 'announce';
  for (const [k, v] of Object.entries(scores) as Array<[PostType, number]>) {
    if (v > scores[best]) best = k;
  }
  return best;
}

function normalizeBody(lines: string[]): string {
  const out: string[] = [];
  for (let line of lines) {
    line = line.replace(/\s+$/, '');
    // 統一各種項目符號為 Discord 清單
    line = line.replace(/^\s*[•・●○◆▪‧►→✓✔︎☐]\s*/, '- ');
    line = line.replace(/^\s*\*\s+/, '- ');
    line = line.replace(/^\s*[（(](\d{1,2})[)）]\s*/, '$1. ');
    line = line.replace(/^\s*(\d{1,2})[、.．]\s*(?=\S)/, '$1. ');
    line = line.replace(/^\s*([一二三四五六七八九十])[、.．]\s*/, (_m, n: string) => `${cnToNumber(n)}. `);
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function guessTitle(type: PostType, firstLine: string, text: string, firstLineHasTime: boolean): { title: string; fromText: boolean } {
  const bracket = /^\s*[【\[]([^】\]]{2,40})[】\]]\s*$/.exec(firstLine) ?? /^\s*[【\[]([^】\]]{2,40})[】\]]/.exec(firstLine);
  if (bracket) return { title: bracket[1].trim(), fromText: true };
  const line = firstLine.trim().replace(/^#+\s*/, '').replace(/[：:。！!～~]+$/, '');
  const plain = line.replace(URL_RE, '').trim();
  if (
    !firstLineHasTime &&
    plain.length >= 3 &&
    plain.length <= 28 &&
    plain === line &&
    !LABEL_LINE.test(firstLine) &&
    (plain.match(/[，,。；]/g) ?? []).length === 0
  ) {
    return { title: plain, fromText: true };
  }
  const hw = /(作業\s*[一二三四五六七八九十\d]+|HW\s*\d+|期末(?:報告|作品|專題)|期中(?:報告|作品|專題)|第\s*[一二三四五六七八九十\d]+\s*次作業)/i.exec(text);
  const lesson = /第\s*[一二三四五六七八九十\d]+\s*[週堂次]/.exec(text);
  switch (type) {
    case 'class':
      return { title: lesson ? `${lesson[0].replace(/\s/g, '')}上課提醒` : '上課提醒', fromText: false };
    case 'homework':
      return { title: hw ? `${hw[1].replace(/\s/g, '')}繳交提醒` : '作業繳交提醒', fromText: false };
    case 'makeup':
      return { title: '補課通知', fromText: false };
    case 'form':
      return { title: '表單填寫提醒', fromText: false };
    case 'resource':
      return { title: '學習資源分享', fromText: false };
    default: {
      const ev = /([\p{Script=Han}A-Za-z0-9]{2,10}?(?:會議|講座|工作坊|說明會|分享會|成果展|發表會|活動|聚會))/u.exec(text);
      return { title: ev ? ev[1] : '公告', fromText: false };
    }
  }
}

/**
 * 把「明天」「下週三」這類相對日期改寫成實際日期。
 * 排程在之後才發送時，學生看到的日期才不會跑掉。
 */
function absolutize(text: string, dates: DateTok[]): { text: string; rewrites: string[] } {
  let out = text;
  const rewrites: string[] = [];
  for (const d of dates.filter((t) => !t.explicit).sort((a, b) => b.start - a.start)) {
    const original = text.slice(d.start, d.end);
    const lead = /^\s*/.exec(original)![0];
    const dow = WEEKDAYS[tpParts(fromTp(d.y, d.m, d.d, 12)).dow];
    let rep = `${d.m}/${d.d}（${dow}）`;
    if (/晚/.test(original)) rep += '晚上';
    else if (/早/.test(original)) rep += '早上';
    out = out.slice(0, d.start) + lead + rep + out.slice(d.end);
    rewrites.unshift(`「${original.trim()}」→ ${rep}`);
  }
  return { text: out, rewrites };
}

// ───────────────────────── 主函式 ─────────────────────────

export function parseAnnouncement(raw: string, now: Date = new Date(), typeHint?: PostType): ParseResult {
  const text = raw.replace(/\r\n?/g, '\n').replace(/　/g, ' ').trim();
  const detections: Detection[] = [];
  if (!text) {
    return { type: typeHint ?? 'announce', title: '', body: '', links: [], mention: 'none', detections };
  }

  // 把網址換成等長空白再分析，避免網址裡的數字被當成日期
  const scan = text.replace(URL_RE, (m) => ' '.repeat(m.length));
  const warnings: string[] = [];
  const dates = collectDates(scan, now, warnings);
  const times = collectTimes(scan, dates);
  const candidates = buildCandidates(scan, dates, times, now);
  const links = extractLinks(text);
  const plain = scan.replace(/@everyone|@here|@全體|@所有人/g, (m) => ' '.repeat(m.length));
  const location = extractLocation(plain, text);
  const notes = extractNotes(plain)?.replace(/\s+$/, '');
  let mention: MentionMode = 'none';
  if (/@everyone|@全體|@所有人/.test(text)) mention = 'everyone';
  else if (/@here/.test(text)) mention = 'here';

  const hasEvent = candidates.some((c) => c.kind === 'event' && (c.hasTime || !c.relative));
  const hasDeadline = candidates.some((c) => c.kind === 'deadline');
  const type = typeHint ?? pickType(scoreTypes(text, hasEvent, hasDeadline, links));
  // 分享資源時的「今天上課的簡報」只是描述，不是活動時間
  const eventPool = candidates.filter(
    (c) => c.kind === 'event' && !(c.relative && !c.hasTime && (type === 'resource' || type === 'announce')),
  );
  const event = best(eventPool);
  const deadline = best(candidates.filter((c) => c.kind === 'deadline'));

  const lines = text.split('\n');
  const firstLineHasTime = candidates.some((c) => c.start < lines[0].length);
  const { title, fromText } = guessTitle(type, lines[0], text, firstLineHasTime);
  const abs = absolutize(text, dates);
  const absLines = abs.text.split('\n');
  const bodyLines = (fromText ? absLines.slice(1) : absLines).filter((line) => {
    const labelled = LABEL_LINE.exec(line);
    if (labelled) {
      // 已整理到欄位的「時間：」「地點：」「連結：」等行，不重複放在內文
      const key = labelled[1];
      if (/時間|日期|截止|期限/.test(key)) return !(event || deadline);
      if (/地點|教室|場地/.test(key)) return !location;
      if (/連結|網址|表單|資料/.test(key)) return !HAS_URL.test(labelled[2]);
      if (/注意|備註|攜帶/.test(key)) return !notes;
    }
    // 只有「標籤＋網址」的行移到「連結」欄位
    return !isLinkLine(line);
  });
  const labelOf = new Map(links.map((l) => [l.url, l.label]));
  const body = normalizeBody(
    bodyLines.map((l) =>
      l
        .replace(/@everyone|@here|@全體|@所有人/g, '')
        // 句子中的網址改成「可點的文字連結」
        .replace(URL_RE, (url) => `[${labelOf.get(url) ?? labelForUrl(url)}](${url})`)
        .replace(/\s+$/, ''),
    ),
  );

  detections.push({ kind: 'type', label: TYPE_LABELS[type] });
  if (event) {
    const end = event.endAt ? `–${String(tpParts(event.endAt).hh).padStart(2, '0')}:${String(tpParts(event.endAt).mm).padStart(2, '0')}` : '';
    detections.push({ kind: 'event', label: `時間 ${fmtDateTime(event.at)}${end}` });
    if (!event.hasTime) detections.push({ kind: 'assumption', label: '沒寫幾點，先設為 09:00' });
    if (!event.hasDate) detections.push({ kind: 'assumption', label: '沒寫日期，推測為最近的一次' });
  }
  if (deadline) {
    detections.push({ kind: 'deadline', label: `截止 ${fmtDateTime(deadline.at)}` });
    if (!deadline.hasTime) detections.push({ kind: 'assumption', label: '截止沒寫幾點，設為 23:59' });
  }
  for (const w of warnings) detections.push({ kind: 'assumption', label: w });
  if (abs.rewrites.length) detections.push({ kind: 'rewrite', label: `內文日期改成實際日期：${abs.rewrites.slice(0, 2).join('、')}` });
  if (location) detections.push({ kind: 'location', label: `地點 ${location}` });
  if (links.length) detections.push({ kind: 'link', label: `${links.length} 個連結` });
  if (notes) detections.push({ kind: 'notes', label: '注意事項' });
  if (mention !== 'none') detections.push({ kind: 'mention', label: `@${mention}` });

  return {
    type,
    title,
    body,
    eventAt: event?.at.toISOString(),
    eventEnd: event?.endAt?.toISOString(),
    deadline: deadline?.at.toISOString(),
    location,
    links,
    notes,
    mention,
    detections,
  };
}
