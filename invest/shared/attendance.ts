// 出席紀錄 CSV（給登入動畫的「出席率行情看板」）。
// 接受兩種：
// 1. Notion「出勤紀錄」資料庫匯出的 CSV（欄位：紀錄、學生、課程、週次、狀態…；「學生」欄可能帶網址，會自動去掉）
// 2. 自己整理的四欄：課堂, 姓名, 週次, 狀態
// 課堂：週三／VSAI → 上半場；週四／跨域 → 下半場。狀態：參、遲、假、缺（未紀錄、尚未加入會略過）。
import { normalizeName, parseCourse } from './roster.ts';
import type { CourseId } from './types.ts';

export interface AttendanceEntry {
  course: CourseId;
  name: string;
  week: number;
  status: string;
}

export interface ParsedAttendance {
  entries: AttendanceEntry[];
  errors: string[];
  skipped: number;
}

const STATUS = new Set(['參', '出席', '到', '遲', '遲到', '假', '請假', '缺', '缺席', '曠']);
const SKIP = new Set(['未紀錄', '尚未加入', '']);

function attendanceCourse(raw: string): CourseId | null {
  const s = raw.normalize('NFKC').trim().toLowerCase();
  if (s.includes('vsai')) return 'wed';
  if (s.includes('跨域')) return 'thu';
  return parseCourse(raw);
}

function splitLine(line: string, delimiter: string): string[] {
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
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === delimiter) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 「王小明 (https://www.notion.so/…)」→「王小明」；多個關聯只取第一個 */
function cleanName(raw: string): string {
  const first = raw.split(/,(?![^(]*\))/)[0] ?? '';
  return normalizeName(first.replace(/\s*\((https?:[^)]*)\)\s*/g, '').replace(/https?:\S+/g, ''));
}

function parseWeek(raw: string): number | null {
  const m = raw.normalize('NFKC').match(/\d{1,2}/);
  if (!m) return null;
  const n = Number(m[0]);
  return n >= 0 && n <= 60 ? n : null;
}

export function parseAttendanceCsv(text: string): ParsedAttendance {
  const entries: AttendanceEntry[] = [];
  const errors: string[] = [];
  let skipped = 0;
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const first = lines.find((l) => l.trim() !== '') ?? '';
  const delimiter = first.includes('\t') ? '\t' : ',';
  const head = splitLine(first, delimiter).map((h) => h.normalize('NFKC').toLowerCase());
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  let col = { course: find('課程', '課堂', 'course'), name: find('學生', '姓名', 'name'), week: find('週次', 'week'), status: find('狀態', '出缺席', 'status') };
  const hasHeader = Object.values(col).every((i) => i >= 0);
  if (!hasHeader) col = { course: 0, name: 1, week: 2, status: 3 };

  lines.forEach((line, index) => {
    if (line.trim() === '' || (hasHeader && line === first)) return;
    const lineNo = index + 1;
    const cells = splitLine(line, delimiter);
    if (cells.every((c) => c === '')) return;
    const status = (cells[col.status] ?? '').trim();
    if (SKIP.has(status)) {
      skipped++;
      return;
    }
    if (!STATUS.has(status)) {
      errors.push(`第 ${lineNo} 行：看不懂狀態「${status}」，請用 參、遲、假、缺`);
      return;
    }
    const course = attendanceCourse(cells[col.course] ?? '');
    if (!course) {
      errors.push(`第 ${lineNo} 行：看不懂課堂「${cells[col.course] ?? ''}」，請填 週三／VSAI 或 週四／跨域`);
      return;
    }
    const name = cleanName(cells[col.name] ?? '');
    if (!name) {
      errors.push(`第 ${lineNo} 行：姓名是空的`);
      return;
    }
    const week = parseWeek(cells[col.week] ?? '');
    if (week === null) {
      errors.push(`第 ${lineNo} 行：週次要是數字`);
      return;
    }
    entries.push({ course, name, week, status });
  });
  if (entries.length === 0 && errors.length === 0) errors.push('沒有讀到任何出席紀錄');
  return { entries, errors: errors.slice(0, 20), skipped };
}
