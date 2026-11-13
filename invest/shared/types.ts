// 前後端共用的型別。伺服器是唯一的真實來源，前端只顯示伺服器給的資料。

export type CourseId = 'wed' | 'thu';
export const COURSE_IDS: readonly CourseId[] = ['wed', 'thu'];
export const COURSE_INFO: Record<CourseId, { half: string; day: string }> = {
  wed: { half: '上半場', day: '週三' },
  thu: { half: '下半場', day: '週四' },
};
export function courseLabel(course: CourseId): string {
  const info = COURSE_INFO[course];
  return `${info.half}・${info.day}`;
}

export type Phase = 'pending' | 'open' | 'dark' | 'closed';
export const PHASE_LABEL: Record<Phase, string> = {
  pending: '未開盤',
  open: '開盤中',
  dark: '暗盤倒數',
  closed: '已封盤',
};

export interface RosterEntry {
  name: string;
  course: CourseId;
  group: string;
}

/** 某位學生在某堂課的投資：組別 → 金額（元）。金額為 0 的組不會出現。 */
export type Allocation = Record<string, number>;

export interface HistoryPoint {
  t: number;
  /** 組別 → 當下總額（元）。封盤點的值是含倒扣的最終金額。 */
  totals: Record<string, number>;
  mark?: 'open' | 'dark' | 'close';
}

export interface GroupResult {
  group: string;
  /** 大家投進來的總額 */
  raw: number;
  /** 組員沒花完、要倒扣的總額 */
  penalty: number;
  final: number;
  rank: number;
  multiplier: number;
  deductions: { name: string; unspent: number }[];
}

export interface InvestorResult {
  name: string;
  group: string;
  invested: number;
  unspent: number;
  payout: number;
  rank: number;
}

/** 完整結算（含學生姓名），只給管理員（CSV／管理員 API）。 */
export interface Results {
  /** 依名次排序 */
  groups: GroupResult[];
  /** 只列有投資的人（個人名次的分母），依名次排序 */
  investors: InvestorResult[];
  /** 一飛沖天獎（可並列；最高的組即使是負數也得獎） */
  rocket: string[];
  /** 股神獎（可並列） */
  stockGods: string[];
}

/** 公開的組別結果：只有各組金額，不列學生姓名。 */
export interface PublicGroupResult {
  group: string;
  raw: number;
  penalty: number;
  final: number;
  rank: number;
  multiplier: number;
}

/** 公開的結算結果（大螢幕、學生端）。 */
export interface PublicResults {
  groups: PublicGroupResult[];
  rocket: string[];
  stockGods: { name: string; group: string; payout: number }[];
  /** 有投資的人數（個人名次的分母） */
  investorCount: number;
}

export interface PublicGroup {
  id: string;
  /** 暗盤期間為 null */
  total: number | null;
  /** 暗盤期間為 null */
  rank: number | null;
  members: number;
}

export interface PublicCourse {
  course: CourseId;
  phase: Phase;
  openedAt: number | null;
  darkAt: number | null;
  darkEndsAt: number | null;
  closedAt: number | null;
  /** 依組別順序（第 1 組、第 2 組…） */
  groups: PublicGroup[];
  students: number;
  /** 這一場有登入過的人數 */
  joined: number;
  fullyInvested: number;
  results: PublicResults | null;
}

export interface PublicState {
  /** 伺服器時間，用來校正倒數 */
  now: number;
  active: CourseId;
  darkMs: number;
  courses: Record<CourseId, PublicCourse>;
}

export interface MyCourse {
  course: CourseId;
  group: string;
  alloc: Allocation;
  invested: number;
  remaining: number;
  /** 封盤後：有投資才有個人名次（分母只算有投資的人） */
  result: { payout: number; rank: number; of: number } | null;
  /** 封盤後：因為自己沒投完而從自己那組倒扣的金額；沒登入過的人不倒扣 */
  deducted: number | null;
}

export interface MeState {
  name: string;
  courses: Partial<Record<CourseId, MyCourse>>;
}

export interface AdminStudent {
  name: string;
  group: string;
  invested: number;
  remaining: number;
  /** 這一場有沒有登入過（沒登入過的人不倒扣） */
  joined: boolean;
}

export interface AdminCourse {
  phase: Phase;
  groups: string[];
  students: AdminStudent[];
  /** 取消封盤後會回到哪個狀態（只有已封盤時有值） */
  reopenTo: 'open' | 'dark' | null;
  /** 回到暗盤時剩下的倒數 */
  reopenDarkLeftMs: number | null;
}

export interface AdminOverview {
  active: CourseId;
  darkMs: number;
  roster: RosterEntry[];
  courses: Record<CourseId, AdminCourse>;
}

export interface RosterPreview {
  ok: boolean;
  errors: string[];
  entries: RosterEntry[];
  /** CSV 裡出現的課堂，匯入時只會取代這些課堂的名單 */
  courses: CourseId[];
  summary: { course: CourseId; students: number; groups: { group: string; count: number }[] }[];
  /** 匯入後會被移除的既有投資 */
  dropped: { name: string; course: CourseId; reason: string }[];
}
