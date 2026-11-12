// 名單：姓名正規化、CSV 解析／匯出、組別排序與顯示。
import type { CourseId, RosterEntry } from './types.ts';

/** 去掉前後空白與零寬字元、全形半形統一，讓「王小明 」和「王小明」視為同一人。 */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 比對用的鍵（英文名不分大小寫）。 */
export function nameKey(input: string): string {
  return normalizeName(input).toLowerCase();
}

const COURSE_ALIASES: Record<string, CourseId> = {
  週三: 'wed',
  周三: 'wed',
  星期三: 'wed',
  禮拜三: 'wed',
  三: 'wed',
  上半場: 'wed',
  上: 'wed',
  wed: 'wed',
  wednesday: 'wed',
  週四: 'thu',
  周四: 'thu',
  星期四: 'thu',
  禮拜四: 'thu',
  四: 'thu',
  下半場: 'thu',
  下: 'thu',
  thu: 'thu',
  thursday: 'thu',
};

export function parseCourse(input: string): CourseId | null {
  const key = input.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
  return COURSE_ALIASES[key] ?? null;
}

export const COURSE_CSV_LABEL: Record<CourseId, string> = { wed: '週三', thu: '週四' };

/** 解析一行 CSV（支援雙引號欄位）。 */
function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function detectDelimiter(line: string): string {
  if (line.includes('\t')) return '\t';
  if (line.includes(',')) return ',';
  if (line.includes('，')) return '，';
  return ',';
}

export interface ParsedRoster {
  entries: RosterEntry[];
  errors: string[];
}

/**
 * 解析名單 CSV：每行「姓名, 課堂, 組別」。
 * 第一行若是標題（含「姓名」或 name）會自動略過；也接受從試算表直接貼上的 Tab 分隔。
 */
export function parseRosterCsv(text: string): ParsedRoster {
  const entries: RosterEntry[] = [];
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const firstContent = lines.find((l) => l.trim() !== '') ?? '';
  const delimiter = detectDelimiter(firstContent);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.trim() === '') return;
    const cells = splitCsvLine(line, delimiter);
    if (cells.every((c) => c === '')) return;
    const head = cells[0]?.normalize('NFKC').toLowerCase() ?? '';
    if (line === firstContent && (head.includes('姓名') || head === 'name')) return;
    if (cells.length < 3) {
      errors.push(`第 ${lineNo} 行：欄位不足，需要「姓名, 課堂, 組別」`);
      return;
    }
    const name = normalizeName(cells[0]);
    const course = parseCourse(cells[1]);
    const group = cells[2].replace(/\s+/g, ' ').trim();
    if (!name) {
      errors.push(`第 ${lineNo} 行：姓名是空的`);
      return;
    }
    if (name.length > 40) {
      errors.push(`第 ${lineNo} 行：姓名太長`);
      return;
    }
    if (!course) {
      errors.push(`第 ${lineNo} 行：看不懂課堂「${cells[1]}」，請填 週三 或 週四`);
      return;
    }
    if (!group) {
      errors.push(`第 ${lineNo} 行：組別是空的`);
      return;
    }
    if (group.length > 60) {
      errors.push(`第 ${lineNo} 行：組別名稱太長`);
      return;
    }
    const key = `${course}:${nameKey(name)}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      errors.push(`第 ${lineNo} 行：「${name}」在${COURSE_CSV_LABEL[course]}重複出現（第 ${prev} 行已有）`);
      return;
    }
    seen.set(key, lineNo);
    entries.push({ name, course, group });
  });

  if (entries.length === 0 && errors.length === 0) errors.push('沒有讀到任何名單資料');
  return { entries, errors };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function rosterToCsv(entries: readonly RosterEntry[]): string {
  const rows = ['姓名,課堂,組別'];
  for (const e of entries) {
    rows.push([e.name, COURSE_CSV_LABEL[e.course], e.group].map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function parseChineseNumber(s: string): number | null {
  if (s === '十') return 10;
  const m = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  if ([...s].every((c) => c in CN_DIGITS)) {
    return [...s].reduce((acc, c) => acc * 10 + CN_DIGITS[c], 0);
  }
  return null;
}

/** 從「第3組」「第三組」「3」「G3」之類的組名取出組號；取不到回傳 null。 */
export function groupNumber(label: string): number | null {
  const s = label.normalize('NFKC').trim();
  const m = /^第?\s*([0-9]+|[零〇一二兩三四五六七八九十]+)\s*組/.exec(s) ?? /^(?:group|g)?\s*([0-9]+)\b/i.exec(s);
  if (!m) return null;
  return /^[0-9]+$/.test(m[1]) ? Number(m[1]) : parseChineseNumber(m[1]);
}

export function sortGroups(groups: Iterable<string>): string[] {
  return [...new Set(groups)].sort((a, b) => {
    const na = groupNumber(a) ?? Number.POSITIVE_INFINITY;
    const nb = groupNumber(b) ?? Number.POSITIVE_INFINITY;
    return na - nb || a.localeCompare(b, 'zh-Hant');
  });
}

/** 「第2組：看到太陽就知道完蛋了」→ { short: '第2組', nick: '看到太陽就知道完蛋了' } */
export function splitGroupLabel(label: string): { short: string; nick: string } {
  const m = /^(.+?)[：:](.+)$/.exec(label);
  if (m) return { short: m[1].trim(), nick: m[2].trim() };
  if (/^[0-9]+$/.test(label.trim())) return { short: `第${label.trim()}組`, nick: '' };
  return { short: label, nick: '' };
}
