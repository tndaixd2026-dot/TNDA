import { describe, expect, it } from 'vitest';
import {
  BUDGET,
  checkInvest,
  competitionRanks,
  computeResults,
  multiplierForRank,
  type InvestCheck,
} from '../shared/rules.ts';

const W = 10_000;

describe('competitionRanks', () => {
  it('同分同名次，下一名順延', () => {
    expect(competitionRanks([100, 100, 50, 10])).toEqual([1, 1, 3, 4]);
    expect(competitionRanks([5, 9, 9, 9, 1])).toEqual([4, 1, 1, 1, 5]);
    expect(competitionRanks([-3, 0, -3])).toEqual([2, 1, 2]);
  });

  it('倍率：第 1 名 ×3、第 2 名 ×2、第 3 名 ×1.5、其餘 ×1', () => {
    expect([1, 2, 3, 4, 7].map(multiplierForRank)).toEqual([3, 2, 1.5, 1, 1]);
  });
});

describe('checkInvest', () => {
  const base: InvestCheck = {
    phase: 'open',
    groups: ['A', 'B', 'C'],
    ownGroup: 'A',
    current: {},
    group: 'B',
    amount: 30 * W,
  };

  it('合法的投資', () => {
    expect(checkInvest(base)).toBeNull();
    expect(checkInvest({ ...base, phase: 'dark' })).toBeNull();
    expect(checkInvest({ ...base, amount: 0 })).toBeNull();
    expect(checkInvest({ ...base, amount: 50 * W })).toBeNull();
  });

  it('只有開盤中與暗盤可以投資', () => {
    expect(checkInvest({ ...base, phase: 'pending' })).toBe('not_open');
    expect(checkInvest({ ...base, phase: 'closed' })).toBe('closed');
  });

  it('不能投自己那組、也不能投不存在的組', () => {
    expect(checkInvest({ ...base, group: 'A' })).toBe('own_group');
    expect(checkInvest({ ...base, group: 'Z' })).toBe('unknown_group');
  });

  it('單一組上限 50 萬', () => {
    expect(checkInvest({ ...base, amount: 50 * W + 1 })).toBe('over_limit');
  });

  it('金額必須是非負整數', () => {
    expect(checkInvest({ ...base, amount: -1 })).toBe('bad_amount');
    expect(checkInvest({ ...base, amount: 1.5 })).toBe('bad_amount');
    expect(checkInvest({ ...base, amount: Number.NaN })).toBe('bad_amount');
  });

  it('餘額不足時擋下；調整同一組時以新金額計算', () => {
    const current = { B: 50 * W, C: 40 * W };
    expect(checkInvest({ ...base, current, group: 'C', amount: 50 * W })).toBeNull();
    const four = { ...base, groups: ['A', 'B', 'C', 'D'], current: { B: 50 * W, C: 40 * W } };
    expect(checkInvest({ ...four, group: 'D', amount: 10 * W })).toBeNull();
    expect(checkInvest({ ...four, group: 'D', amount: 10 * W + 1 })).toBe('over_budget');
  });
});

describe('computeResults', () => {
  const groups = ['A', 'B', 'C', 'D'];

  it('沒花完的錢從自己那組倒扣，組別總額可以是負數', () => {
    const members = [
      { name: 'a1', group: 'A' },
      { name: 'b1', group: 'B' },
      { name: 'c1', group: 'C' },
      { name: 'd1', group: 'D' },
    ];
    const allocs = {
      a1: { B: 50 * W, C: 50 * W },
      b1: { A: 50 * W, C: 30 * W }, // 沒花完 20 萬 → B 倒扣
      c1: {}, // 完全沒投 → C 倒扣 100 萬
      d1: { A: 50 * W, B: 50 * W },
    };
    const r = computeResults(groups, members, allocs);
    const byGroup = Object.fromEntries(r.groups.map((g) => [g.group, g]));
    expect(byGroup.A).toMatchObject({ raw: 100 * W, penalty: 0, final: 100 * W, rank: 1, multiplier: 3 });
    expect(byGroup.B).toMatchObject({ raw: 100 * W, penalty: 20 * W, final: 80 * W, rank: 2, multiplier: 2 });
    expect(byGroup.C).toMatchObject({ raw: 80 * W, penalty: BUDGET, final: -20 * W, rank: 4, multiplier: 1 });
    expect(byGroup.D).toMatchObject({ raw: 0, penalty: 0, final: 0, rank: 3, multiplier: 1.5 });
    expect(byGroup.B.deductions).toEqual([{ name: 'b1', unspent: 20 * W }]);
    expect(r.rocket).toEqual(['A']);
    expect(r.groups.map((g) => g.group)).toEqual(['A', 'B', 'D', 'C']);

    const payout = Object.fromEntries(r.investors.map((i) => [i.name, i.payout]));
    expect(payout.a1).toBe(50 * W * 2 + 50 * W * 1);
    expect(payout.b1).toBe(50 * W * 3 + 30 * W * 1); // 沒花完的 20 萬不計入
    expect(payout.c1).toBe(0);
    expect(payout.d1).toBe(50 * W * 3 + 50 * W * 2);
    expect(r.stockGods).toEqual(['d1']);
  });

  it('同分並列：兩組並列第 1 都 ×3，下一組是第 3 名 ×1.5', () => {
    const members = [
      { name: 'x', group: 'D' },
      { name: 'y', group: 'D' },
    ];
    const allocs = {
      x: { A: 50 * W, B: 30 * W, C: 20 * W },
      y: { A: 30 * W, B: 50 * W, C: 20 * W },
    };
    const r = computeResults(groups, members, allocs);
    const byGroup = Object.fromEntries(r.groups.map((g) => [g.group, g]));
    expect(byGroup.A).toMatchObject({ final: 80 * W, rank: 1, multiplier: 3 });
    expect(byGroup.B).toMatchObject({ final: 80 * W, rank: 1, multiplier: 3 });
    expect(byGroup.C).toMatchObject({ final: 40 * W, rank: 3, multiplier: 1.5 });
    expect(byGroup.D).toMatchObject({ final: 0, rank: 4, multiplier: 1 });
    expect(r.rocket).toEqual(['A', 'B']);
    // 兩人報酬相同 → 股神並列
    expect(r.investors.map((i) => [i.name, i.payout, i.rank])).toEqual([
      ['x', 80 * W * 3 + 20 * W * 1.5, 1],
      ['y', 80 * W * 3 + 20 * W * 1.5, 1],
    ]);
    expect(r.stockGods).toEqual(['x', 'y']);
  });

  it('沒有人投資時沒有股神，但仍有一飛沖天（全部並列）', () => {
    const r = computeResults(['A', 'B'], [], {});
    expect(r.stockGods).toEqual([]);
    expect(r.rocket).toEqual(['A', 'B']);
  });

  it('忽略投給自己組或不存在組的髒資料', () => {
    const r = computeResults(['A', 'B'], [{ name: 'm', group: 'A' }], { m: { A: 50 * W, B: 50 * W, Z: 10 * W } });
    const a = r.groups.find((g) => g.group === 'A')!;
    expect(a.raw).toBe(0);
    expect(a.penalty).toBe(50 * W);
    expect(r.investors[0].payout).toBe(50 * W * 3);
  });
});
