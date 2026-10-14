// 時間工具：全部以台北時間（UTC+8，無日光節約）計算，
// 即使你人在國外打開網站，看到與排定的也都是台灣時間。

export const TZ_OFFSET_MS = 8 * 3600 * 1000;
export const DAY_MS = 86400000;
export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export interface TpParts {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  dow: number; // 0 = 週日
}

export function tpParts(input: Date | string | number): TpParts {
  const t = new Date(typeof input === 'string' ? Date.parse(input) : input).getTime() + TZ_OFFSET_MS;
  const u = new Date(t);
  return {
    y: u.getUTCFullYear(),
    m: u.getUTCMonth() + 1,
    d: u.getUTCDate(),
    hh: u.getUTCHours(),
    mm: u.getUTCMinutes(),
    ss: u.getUTCSeconds(),
    dow: u.getUTCDay(),
  };
}

/** 由台北時間的年月日時分建立 Date */
export function fromTp(y: number, m: number, d: number, hh = 0, mm = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - TZ_OFFSET_MS);
}

export function startOfTpDay(input: Date | string | number): Date {
  const p = tpParts(input);
  return fromTp(p.y, p.m, p.d);
}

export function dayKey(input: Date | string | number): string {
  const p = tpParts(input);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtTime(input: Date | string | number): string {
  const p = tpParts(input);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export function fmtDate(input: Date | string | number, withYear = false): string {
  const p = tpParts(input);
  return `${withYear ? `${p.y}/` : ''}${p.m}/${p.d}（${WEEKDAYS[p.dow]}）`;
}

export function fmtDateTime(input: Date | string | number, withYear = false): string {
  return `${fmtDate(input, withYear)} ${fmtTime(input)}`;
}

export function fmtLong(input: Date | string | number): string {
  const p = tpParts(input);
  return `${p.y} 年 ${p.m} 月 ${p.d} 日 星期${WEEKDAYS[p.dow]} ${pad(p.hh)}:${pad(p.mm)}`;
}

/** Discord 時間戳在繁體中文介面的大致樣子，用於預覽 */
export function fmtDiscordTimestamp(unixSec: number, style: string, ref: number): string {
  const ms = unixSec * 1000;
  const p = tpParts(ms);
  switch (style) {
    case 't':
      return `${pad(p.hh)}:${pad(p.mm)}`;
    case 'T':
      return `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}`;
    case 'd':
      return `${p.y}/${pad(p.m)}/${pad(p.d)}`;
    case 'D':
      return `${p.y}年${p.m}月${p.d}日`;
    case 'F':
      return `${p.y}年${p.m}月${p.d}日星期${WEEKDAYS[p.dow]} ${pad(p.hh)}:${pad(p.mm)}`;
    case 'R':
      return fmtRelative(ms, ref);
    case 'f':
    default:
      return `${p.y}年${p.m}月${p.d}日 ${pad(p.hh)}:${pad(p.mm)}`;
  }
}

/** 相對時間，例如「3 天後」、「2 小時前」 */
export function fmtRelative(target: number, ref: number = Date.now()): string {
  const diff = target - ref;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '後' : '前';
  if (abs < 45 * 1000) return diff >= 0 ? '幾秒後' : '剛剛';
  const min = Math.round(abs / 60000);
  if (min < 60) return `${min} 分鐘${suffix}`;
  const hr = Math.round(abs / 3600000);
  if (hr < 24) return `${hr} 小時${suffix}`;
  const day = Math.round(abs / DAY_MS);
  if (day < 30) return `${day} 天${suffix}`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon} 個月${suffix}`;
  return `${Math.round(day / 365)} 年${suffix}`;
}

/** 倒數：1 天 3 小時 / 2:05:09 */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return '即將發送';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} 天 ${h} 小時`;
  return `${h}:${pad(m)}:${pad(sec)}`;
}

/** 轉成 <input type="datetime-local"> 用的台北時間字串 */
export function toInputValue(iso: string | undefined): string {
  if (!iso) return '';
  const p = tpParts(iso);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}`;
}

export function fromInputValue(value: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return undefined;
  return fromTp(+m[1], +m[2], +m[3], +m[4], +m[5]).toISOString();
}

export function addDays(input: Date | string | number, days: number): Date {
  return new Date(new Date(typeof input === 'string' ? Date.parse(input) : input).getTime() + days * DAY_MS);
}

/** 台北時間某天的某個時刻 */
export function atTime(day: Date | string | number, hh: number, mm = 0): Date {
  const p = tpParts(day);
  return fromTp(p.y, p.m, p.d, hh, mm);
}

export function sameTpDay(a: Date | string | number, b: Date | string | number): boolean {
  return dayKey(a) === dayKey(b);
}

export function unix(iso: string | Date): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}
