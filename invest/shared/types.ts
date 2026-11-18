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

/** 一筆投資（下單時決定時段加權）。撤回時先扣最晚的。 */
export interface Lot {
  group: string;
  amount: number;
  /** 下單當下的時段加權：2、1.5、1.2 或 1 */
  weight: number;
  /** 從該組開始報告到下單的毫秒數（同分比快慢用；報告時段以外 = 16 分鐘） */
  delayMs: number;
}

export interface HistoryPoint {
  /** 資料庫裡的流水號（增量更新用） */
  id?: number;
  t: number;
  /** 組別 → 當下總額（元）。封盤點的值是含倒扣的最終金額。 */
  totals: Record<string, number>;
  mark?: 'open' | 'dark' | 'close';
}

export interface GroupResult {
  group: string;
  /** 大家投進來的總額（每筆 × 時段加權） */
  raw: number;
  /** 組員沒花完、要倒扣的總額 */
  penalty: number;
  final: number;
  rank: number;
  multiplier: number;
  deductions: { name: string; unspent: number }[];
}

export interface OtherInvestorResult {
  name: string;
  invested: number;
  payout: number;
}

export interface InvestorResult {
  name: string;
  group: string;
  invested: number;
  unspent: number;
  payout: number;
  /** 下注快慢：從各組開始報告到下單的時間（依金額加權平均，毫秒）；同分時小者勝 */
  delayMs: number;
  rank: number;
}

/** 完整結算（含學生姓名），只給管理員（CSV／管理員 API）。 */
export interface Results {
  /** 依名次排序 */
  groups: GroupResult[];
  /** 只列有投資的人（個人名次的分母），依名次排序 */
  investors: InvestorResult[];
  /** 業師、老師、訪客：投資算進各組總額，但不參加股神獎與個人名次 */
  others?: OtherInvestorResult[];
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

export interface GroupShowcase {
  /** 作品題目／slogan（管理員頁填寫） */
  slogan: string;
  /** 封面照片的版本；沒有封面為 null。照片本身用 invest_group_cover 另外抓 */
  coverVer: number | null;
  /** 組員（學生）姓名 */
  memberNames: string[];
}

export interface PublicGroup extends GroupShowcase {
  id: string;
  /** 暗盤期間、封盤後頒獎揭曉前為 null */
  total: number | null;
  /** 暗盤期間、封盤後頒獎揭曉前為 null */
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
  /** 封盤後，頒獎已揭曉這一場第一名（之後各組金額、結果才公開） */
  revealed: boolean;
  /** 正在報告的組與開始時間（時段加權用）；沒有組在報告、或已封盤時為 null */
  presenting: { group: string; startedAt: number } | null;
  /** 各組最近一次開始報告的時間（組別 → 毫秒） */
  presented: Record<string, number>;
  /** 依組別順序（第 1 組、第 2 組…） */
  groups: PublicGroup[];
  students: number;
  /** 這一場有登入過的人數 */
  joined: number;
  fullyInvested: number;
  results: PublicResults | null;
}

export interface PublicState {
  /** 每次公開狀態變動都會 +1 */
  version: number;
  /** 伺服器時間，用來校正倒數 */
  now: number;
  active: CourseId;
  darkMs: number;
  courses: Record<CourseId, PublicCourse>;
  stage: Stage;
}

/** 頒獎的一步（伺服器依兩場的結果產生） */
export type AwardScene =
  | { kind: 'title'; label: string }
  | { kind: 'intro'; label: string; course: CourseId; groups: number; investors: number; students: number }
  | { kind: 'podium' | 'rocket'; label: string; course: CourseId; rank: number; groups: (PublicGroupResult & GroupShowcase)[] }
  | { kind: 'stockgod'; label: string; course: CourseId; winners: { name: string; group: string; payout: number }[]; investors: number }
  | { kind: 'ranking'; label: string; course: CourseId; results: PublicResults }
  | { kind: 'finale'; label: string; courses: { course: CourseId; rocket: string[]; stockGods: { name: string; group: string; payout: number }[] }[] };

export interface RecapCourse {
  course: CourseId;
  students: number;
  joined: number;
  invested: number;
  investors: number;
  rocket: string[] | null;
  stockGods: { name: string; group: string; payout: number }[] | null;
}

/** 業師總結的一頁 */
export interface SlideScene {
  kind: 'title' | 'text' | 'recap';
  id: number;
  label: string;
  title: string;
  subtitle: string;
  body: string;
  imageVer: number | null;
  recap?: RecapCourse[];
}

/** 大螢幕舞台：盤況 → 頒獎 → 業師總結（管理員一步一步切換） */
export type Stage =
  | { mode: 'market'; step: number; total: number; scene: null }
  | { mode: 'awards'; step: number; total: number; scene: AwardScene }
  | { mode: 'summary'; step: number; total: number; scene: SlideScene };

export type Role = 'student' | 'mentor' | 'guest';

export interface MyCourse {
  course: CourseId;
  /** 學生自己的組；業師、老師、訪客沒有組（null） */
  group: string | null;
  alloc: Allocation;
  /** 各組的加權後金額（每筆 × 下單當下的時段加權） */
  weighted: Record<string, number>;
  invested: number;
  remaining: number;
  /** 封盤後：有投資才有個人名次（分母只算有投資的人） */
  /** 業師、老師、來賓：rank、of 為 null（不參加股神獎） */
  result: { payout: number; rank: number | null; of: number | null } | null;
  /** 封盤後：因為自己沒投完而從自己那組倒扣的金額；沒登入過的人不倒扣 */
  deducted: number | null;
  /** 已封盤、等待頒獎揭曉 */
  awaiting: boolean;
}

export interface MeState {
  name: string;
  role: Role;
  courses: Partial<Record<CourseId, MyCourse>>;
}

export interface LoginResult {
  token: string;
  me: MeState;
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
  /** 登入動畫的出席率看板 */
  board: { visible: boolean; wed: { students: number; weeks: number }; thu: { students: number; weeks: number } };
  stage: Stage & { awardLabels: string[]; slideLabels: string[] };
  groupInfo: Record<CourseId, { group: string; slogan: string; coverVer: number | null }[]>;
  slides: AdminSlide[];
  accounts: { name: string; role: Role; hasPassword: boolean; locked: boolean }[];
}

export interface AdminSlide {
  id?: number;
  kind: 'title' | 'text' | 'recap';
  title: string;
  subtitle: string;
  body: string;
  imageVer?: number | null;
  /** 只在要換圖時送出：data URL，或 null 刪除圖片 */
  image?: string | null;
}

export interface AttendancePreview {
  ok: boolean;
  applied: boolean;
  errors: string[];
  records: number;
  summary: { course: CourseId; students: number; weeks: number }[];
  /** 名單上找不到的姓名（不會匯入） */
  unmatched: { course: CourseId; name: string }[];
}

export interface RosterPreview {
  ok: boolean;
  /** 是否已經寫入（apply 且沒有錯誤） */
  applied: boolean;
  errors: string[];
  entries: RosterEntry[];
  /** CSV 裡出現的課堂，匯入時只會取代這些課堂的名單 */
  courses: CourseId[];
  summary: { course: CourseId; students: number; groups: { group: string; count: number }[] }[];
  /** 匯入後會被移除的既有投資 */
  dropped: { name: string; course: CourseId; reason: string }[];
}
