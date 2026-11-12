// 投資規則與結算。純函式、無副作用：伺服器用它做權威驗證，前端只拿來做即時提示。
import type { Allocation, GroupResult, InvestorResult, Phase, Results } from './types.ts';

/** 每人每堂課的虛擬資金 */
export const BUDGET = 1_000_000;
/** 單一組投資上限 */
export const MAX_PER_GROUP = 500_000;
/** 暗盤長度：進入暗盤後倒數結束自動封盤 */
export const DEFAULT_DARK_MS = 5 * 60 * 1000;

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
  | 'over_limit'
  | 'over_budget';

export const INVEST_ERROR_MESSAGE: Record<InvestError, string> = {
  not_open: '還沒開盤，開盤後才能投資',
  closed: '已經封盤，不能再調整',
  unknown_group: '沒有這個組別',
  own_group: '不能投資自己那組',
  bad_amount: '金額必須是 0 以上的整數',
  over_limit: '單一組最多只能投 50 萬',
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
  if (c.amount > MAX_PER_GROUP) return 'over_limit';
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
 * 封盤結算。
 * - 各組最終金額 = 投進來的總額 − 自己組員沒花完的錢
 * - 依最終金額排名（同分同名次、下一名順延），決定倍率
 * - 個人報酬 = Σ（投在該組的金額 × 該組倍率），沒花完的錢不計入
 */
export function computeResults(
  groups: readonly string[],
  members: readonly Member[],
  allocs: Readonly<Record<string, Allocation>>,
): Results {
  const order = new Map(groups.map((g, i) => [g, i]));
  const raw: Record<string, number> = {};
  const penalty: Record<string, number> = {};
  const deductions: Record<string, { name: string; unspent: number }[]> = {};
  for (const g of groups) {
    raw[g] = 0;
    penalty[g] = 0;
    deductions[g] = [];
  }

  const invested = new Map<string, number>();
  for (const m of members) {
    const alloc = allocs[m.name] ?? {};
    let sum = 0;
    for (const [g, amount] of Object.entries(alloc)) {
      // 防禦性：只計入合法的組（存在、且不是自己那組）
      if (!(g in raw) || g === m.group) continue;
      raw[g] += amount;
      sum += amount;
    }
    invested.set(m.name, sum);
  }

  for (const m of members) {
    const unspent = BUDGET - (invested.get(m.name) ?? 0);
    if (unspent > 0 && m.group in penalty) {
      penalty[m.group] += unspent;
      deductions[m.group].push({ name: m.name, unspent });
    }
  }

  const finals = groups.map((g) => raw[g] - penalty[g]);
  const ranks = competitionRanks(finals);
  const groupResults: GroupResult[] = groups.map((g, i) => ({
    group: g,
    raw: raw[g],
    penalty: penalty[g],
    final: finals[i],
    rank: ranks[i],
    multiplier: multiplierForRank(ranks[i]),
    deductions: deductions[g].sort((a, b) => b.unspent - a.unspent || a.name.localeCompare(b.name)),
  }));
  const mult = new Map(groupResults.map((r) => [r.group, r.multiplier]));

  const payouts = members.map((m) => {
    const alloc = allocs[m.name] ?? {};
    let payout = 0;
    for (const [g, amount] of Object.entries(alloc)) {
      if (g === m.group) continue;
      payout += amount * (mult.get(g) ?? 0);
    }
    return payout;
  });
  const investorRanks = competitionRanks(payouts);
  const investors: InvestorResult[] = members.map((m, i) => {
    const inv = invested.get(m.name) ?? 0;
    return {
      name: m.name,
      group: m.group,
      invested: inv,
      unspent: BUDGET - inv,
      payout: payouts[i],
      rank: investorRanks[i],
    };
  });

  groupResults.sort((a, b) => a.rank - b.rank || (order.get(a.group) ?? 0) - (order.get(b.group) ?? 0));
  investors.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, 'zh-Hant'));

  return {
    groups: groupResults,
    investors,
    rocket: groupResults.filter((r) => r.rank === 1).map((r) => r.group),
    // 規格：報酬最高者獲獎、同分並列（所有人都是 0 時也照此並列，見 README「待確認」）
    stockGods: investors.filter((r) => r.rank === 1).map((r) => r.name),
  };
}
