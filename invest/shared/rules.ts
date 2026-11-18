// 投資規則與結算。純函式、無副作用：伺服器用它做權威驗證，前端只拿來做即時提示。
import type { Allocation, GroupResult, InvestorResult, Lot, Phase, PublicResults, Results } from './types.ts';

/** 每人每堂課的虛擬資金 */
export const BUDGET = 1_000_000;
/** 暗盤長度：進入暗盤後倒數結束自動封盤 */
export const DEFAULT_DARK_MS = 5 * 60 * 1000;

/**
 * 報告時段加權：管理員在某組上台時按「開始報告」，三個時段自動計時。
 * 在這段期間投給「正在報告的組」的錢，依下單當下的時段加權；其他時間 ×1。
 */
export interface PresentStage {
  key: 'pitch' | 'demo' | 'review';
  label: string;
  ms: number;
  weight: number;
}
export const PRESENT_STAGES: readonly PresentStage[] = [
  { key: 'pitch', label: '簡報', ms: 3 * 60_000, weight: 1.4 },
  { key: 'demo', label: 'Demo', ms: 7 * 60_000, weight: 1.2 },
  { key: 'review', label: '業師講評', ms: 6 * 60_000, weight: 1.1 },
];
/** 三個時段加起來 16 分鐘；之後（或不在報告時段）下單 ×1 */
export const PRESENT_WINDOW_MS = PRESENT_STAGES.reduce((s, x) => s + x.ms, 0);

export interface StageNow {
  /** 目前時段；null = 加權時段已結束 */
  stage: PresentStage | null;
  weight: number;
  /** 這個時段還剩多久（已結束為 0） */
  leftMs: number;
}

/** 某組開始報告後經過 elapsedMs，現在是哪個時段、加權多少 */
export function stageAt(elapsedMs: number): StageNow {
  let start = 0;
  if (elapsedMs >= 0) {
    for (const st of PRESENT_STAGES) {
      if (elapsedMs < start + st.ms) return { stage: st, weight: st.weight, leftMs: start + st.ms - elapsedMs };
      start += st.ms;
    }
  }
  return { stage: null, weight: 1, leftMs: 0 };
}

/** 同分比快慢用：從該組開始報告到下單的時間；不在報告時段內下單一律算 16 分鐘 */
export function delayFor(elapsedMs: number | null): number {
  if (elapsedMs === null || elapsedMs < 0) return PRESENT_WINDOW_MS;
  return Math.min(elapsedMs, PRESENT_WINDOW_MS);
}

/** 名次 → 倍率：第 1 名 ×3、第 2 名 ×2、第 3 名 ×1.5、其餘 ×1 */
export function multiplierForRank(rank: number): number {
  if (rank === 1) return 3;
  if (rank === 2) return 2;
  if (rank === 3) return 1.5;
  return 1;
}

/**
 * 同分同名次、下一名順延（1, 1, 3, …）。
 * 回傳的陣列與輸入一一對應。
 */
export function competitionRanks(values: readonly number[]): number[] {
  return values.map((v) => 1 + values.filter((o) => o > v).length);
}

export function sumAlloc(alloc: Allocation | undefined): number {
  if (!alloc) return 0;
  let sum = 0;
  for (const v of Object.values(alloc)) sum += v;
  return sum;
}

export type InvestError =
  | 'not_open'
  | 'closed'
  | 'unknown_group'
  | 'own_group'
  | 'bad_amount'
  | 'over_budget';

export const INVEST_ERROR_MESSAGE: Record<InvestError, string> = {
  not_open: '還沒開盤，開盤後才能投資',
  closed: '已經封盤，不能再調整',
  unknown_group: '沒有這個組別',
  own_group: '不能投資自己那組',
  bad_amount: '金額必須是 0 以上的整數',
  over_budget: '餘額不足',
};

export interface InvestCheck {
  phase: Phase;
  groups: readonly string[];
  ownGroup: string;
  /** 這位學生目前在這堂課的投資 */
  current: Allocation;
  group: string;
  /** 要把這一組設成的金額（絕對值，不是增減量） */
  amount: number;
}

/** 檢查「把某組的投資設為 amount」是否合法；合法回傳 null。 */
export function checkInvest(c: InvestCheck): InvestError | null {
  if (c.phase === 'pending') return 'not_open';
  if (c.phase === 'closed') return 'closed';
  if (!c.groups.includes(c.group)) return 'unknown_group';
  if (c.group === c.ownGroup) return 'own_group';
  if (!Number.isSafeInteger(c.amount) || c.amount < 0) return 'bad_amount';
  const others = sumAlloc(c.current) - (c.current[c.group] ?? 0);
  if (others + c.amount > BUDGET) return 'over_budget';
  return null;
}

/** 目前各組獲得的投資總額（不含倒扣）。 */
export function groupTotals(
  groups: readonly string[],
  allocs: Readonly<Record<string, Allocation>>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const g of groups) totals[g] = 0;
  for (const alloc of Object.values(allocs)) {
    for (const [g, amount] of Object.entries(alloc)) {
      if (g in totals) totals[g] += amount;
    }
  }
  return totals;
}

export interface Member {
  name: string;
  group: string;
}

/**
 * 封盤結算（與 supabase/schema.sql 的 invest.compute_results 相同，測試會逐一比對）。
 * - 每一筆投資（lot）在下單當下決定時段加權 ×1.4／×1.2／×1.1／×1
 * - 各組最終金額 = Σ（每筆金額 × 加權）− 自己組員沒花完的錢
 *   （只倒扣這一場有登入過的人；整場沒登入的缺席者不倒扣。有投資的人一定算有登入）
 * - 依最終金額排名（同分同名次、下一名順延），決定倍率；最高的組即使是負數也得一飛沖天獎
 * - 個人報酬 = Σ（每筆金額 × 加權 × 該組倍率），沒花完的錢不計入
 * - 個人名次：報酬高者在前；同分比下注快慢（金額加權平均的 delayMs，小者在前）；仍相同才並列
 * - 個人名次只在有投資的人之間排（分母只算有投資的人）
 *
 * 為了和資料庫的十進位運算完全一致，加權（×10）與倍率（×2）先換成整數相乘，最後只除一次。
 * lots 沒給的人，用 allocs 當成 ×1、在報告時段以外下單。
 */
export function computeResults(
  groups: readonly string[],
  members: readonly Member[],
  allocs: Readonly<Record<string, Allocation>>,
  present: (name: string) => boolean = () => true,
  lots: Readonly<Record<string, readonly Lot[]>> = {},
): Results {
  const order = new Map(groups.map((g, i) => [g, i]));
  const rawNum: Record<string, number> = {}; // Σ 金額 × 加權×10
  const penalty: Record<string, number> = {};
  const deductions: Record<string, { name: string; unspent: number }[]> = {};
  for (const g of groups) {
    rawNum[g] = 0;
    penalty[g] = 0;
    deductions[g] = [];
  }

  // 防禦性：只計入合法的組（存在、且不是自己那組）
  const valid = new Map<string, Lot[]>();
  for (const m of members) {
    const mine =
      lots[m.name] ?? Object.entries(allocs[m.name] ?? {}).map(([group, amount]) => ({ group, amount, weight: 1, delayMs: PRESENT_WINDOW_MS }));
    valid.set(
      m.name,
      mine.filter((l) => l.group in rawNum && l.group !== m.group && l.amount > 0),
    );
  }
  const w10 = (w: number) => Math.round(w * 10);

  const invested = new Map<string, number>();
  for (const m of members) {
    let sum = 0;
    for (const l of valid.get(m.name) ?? []) {
      rawNum[l.group] += l.amount * w10(l.weight);
      sum += l.amount;
    }
    invested.set(m.name, sum);
  }

  for (const m of members) {
    const inv = invested.get(m.name) ?? 0;
    const unspent = BUDGET - inv;
    if (inv === 0 && !present(m.name)) continue; // 缺席、沒登入 → 不倒扣
    if (unspent > 0 && m.group in penalty) {
      penalty[m.group] += unspent;
      deductions[m.group].push({ name: m.name, unspent });
    }
  }

  const finalNum = groups.map((g) => rawNum[g] - penalty[g] * 10);
  const ranks = competitionRanks(finalNum);
  const groupResults: GroupResult[] = groups.map((g, i) => ({
    group: g,
    raw: rawNum[g] / 10,
    penalty: penalty[g],
    final: finalNum[i] / 10,
    rank: ranks[i],
    multiplier: multiplierForRank(ranks[i]),
    deductions: deductions[g].sort((a, b) => b.unspent - a.unspent || a.name.localeCompare(b.name)),
  }));
  const mult2 = new Map(groupResults.map((r) => [r.group, Math.round(r.multiplier * 2)]));

  const investing = members.filter((m) => (invested.get(m.name) ?? 0) > 0);
  const scored = investing.map((m) => {
    let payNum = 0; // Σ 金額 × 加權×10 × 倍率×2
    let delaySum = 0;
    for (const l of valid.get(m.name) ?? []) {
      payNum += l.amount * w10(l.weight) * (mult2.get(l.group) ?? 0);
      delaySum += l.amount * l.delayMs;
    }
    return { payNum, delay: Math.round(delaySum / (invested.get(m.name) ?? 1)) };
  });
  const investors: InvestorResult[] = investing.map((m, i) => {
    const inv = invested.get(m.name) ?? 0;
    const me = scored[i];
    const better = scored.filter((o) => o.payNum > me.payNum || (o.payNum === me.payNum && o.delay < me.delay)).length;
    return {
      name: m.name,
      group: m.group,
      invested: inv,
      unspent: BUDGET - inv,
      payout: me.payNum / 20,
      delayMs: me.delay,
      rank: better + 1,
    };
  });

  groupResults.sort((a, b) => a.rank - b.rank || (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0));
  investors.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'zh-Hant'));

  return {
    groups: groupResults,
    investors,
    rocket: groupResults.filter((r) => r.rank === 1).map((r) => r.group),
    // 報酬最高者獲獎；同分比下注快慢；仍相同才並列
    stockGods: investors.filter((r) => r.rank === 1).map((r) => r.name),
  };
}

/** 去掉學生姓名明細，給大螢幕與學生端。 */
export function toPublicResults(r: Results): PublicResults {
  const byName = new Map(r.investors.map((i) => [i.name, i]));
  return {
    groups: r.groups.map(({ group, raw, penalty, final, rank, multiplier }) => ({ group, raw, penalty, final, rank, multiplier })),
    rocket: r.rocket,
    stockGods: r.stockGods.map((name) => ({
      name,
      group: byName.get(name)?.group ?? '',
      payout: byName.get(name)?.payout ?? 0,
    })),
    investorCount: r.investors.length,
  };
}
