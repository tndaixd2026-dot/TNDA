import { describe, expect, it } from 'vitest';
import {
  BUDGET,
  checkInvest,
  competitionRanks,
  computeResults,
  multiplierForRank,
  toPublicResults,
  type InvestCheck,
} from '../shared/rules.ts';
import { parseWanInput, wan } from '../shared/format.ts';

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
    // 個人名次只算有投資的人：c1 沒投資，不在排名裡
    expect(payout.c1).toBeUndefined();
    expect(r.investors).toHaveLength(3);
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

  it('並列第 2 名時倍率都是 ×2，下一組名次順延（不會拿到 ×1.5）', () => {
    const five = ['A', 'B', 'C', 'D', 'E'];
    const members = [
      { name: 'u', group: 'E' },
      { name: 'v', group: 'E' },
      { name: 'w', group: 'A' },
    ];
    const allocs = {
      u: { A: 50 * W, B: 30 * W, C: 20 * W },
      v: { A: 40 * W, B: 10 * W, C: 20 * W, D: 30 * W },
      w: { B: 30 * W, C: 30 * W, D: 40 * W },
    };
    const r = computeResults(five, members, allocs);
    const byGroup = Object.fromEntries(r.groups.map((g) => [g.group, g]));
    // A = 90、B = 70、C = 70、D = 70、E = 0（組員都投完，不倒扣）
    expect(byGroup.A).toMatchObject({ final: 90 * W, rank: 1, multiplier: 3 });
    expect(byGroup.B).toMatchObject({ final: 70 * W, rank: 2, multiplier: 2 });
    expect(byGroup.C).toMatchObject({ final: 70 * W, rank: 2, multiplier: 2 });
    expect(byGroup.D).toMatchObject({ final: 70 * W, rank: 2, multiplier: 2 });
    expect(byGroup.E).toMatchObject({ final: 0, rank: 5, multiplier: 1 });

    // 三組並列第 2 → 下一組是第 5 名。再看兩組並列第 2 → 下一組是第 4 名 ×1（不是第 3 名 ×1.5）
    const r2 = computeResults(
      ['A', 'B', 'C', 'D'],
      [{ name: 'z', group: 'D' }],
      { z: { A: 40 * W, B: 25 * W, C: 25 * W } },
    );
    const g2 = Object.fromEntries(r2.groups.map((g) => [g.group, g]));
    // z 沒投完 10 萬 → D 倒扣 10 萬 = −10 萬
    expect(g2.A).toMatchObject({ final: 40 * W, rank: 1, multiplier: 3 });
    expect(g2.B).toMatchObject({ final: 25 * W, rank: 2, multiplier: 2 });
    expect(g2.C).toMatchObject({ final: 25 * W, rank: 2, multiplier: 2 });
    expect(g2.D).toMatchObject({ final: -10 * W, penalty: 10 * W, rank: 4, multiplier: 1 });
    // 個人報酬 = 40×3 + 25×2 + 25×2 = 220 萬（沒花完的 10 萬不計入）
    expect(r2.investors[0]).toMatchObject({ name: 'z', invested: 90 * W, unspent: 10 * W, payout: 220 * W, rank: 1 });
  });

  it('個人報酬 = Σ 投入 × 該組倍率，並依報酬排名（同分同名次、下一名順延）', () => {
    const members = [
      { name: 'p', group: 'D' },
      { name: 'q', group: 'D' },
      { name: 'r', group: 'D' },
      { name: 's', group: 'C' },
    ];
    const allocs = {
      p: { A: 50 * W, B: 50 * W },
      q: { A: 50 * W, B: 50 * W },
      r: { B: 50 * W, C: 50 * W },
      s: { A: 50 * W, D: 50 * W },
    };
    // 各組：A = 150、B = 150（並列第 1，×3）；C = 50、D = 50（並列第 3，×1.5）
    const r = computeResults(groups, members, allocs);
    expect(r.groups.map((g) => [g.group, g.final, g.rank, g.multiplier])).toEqual([
      ['A', 150 * W, 1, 3],
      ['B', 150 * W, 1, 3],
      ['C', 50 * W, 3, 1.5],
      ['D', 50 * W, 3, 1.5],
    ]);
    // p、q = 50×3 + 50×3 = 300 萬（並列第 1）；r = 50×3 + 50×1.5 = 225；s = 50×3 + 50×1.5 = 225（並列第 3）
    expect(r.investors.map((i) => [i.name, i.payout, i.rank])).toEqual([
      ['p', 300 * W, 1],
      ['q', 300 * W, 1],
      ['r', 225 * W, 3],
      ['s', 225 * W, 3],
    ]);
    expect(r.stockGods).toEqual(['p', 'q']);
  });

  it('缺席、沒登入的人不倒扣；有登入但沒投完的人照樣倒扣；有投資的人一定算有登入', () => {
    const members = [
      { name: 'present', group: 'A' }, // 有登入、沒投 → 倒扣 100 萬
      { name: 'absent', group: 'A' }, // 沒登入 → 不倒扣
      { name: 'partial', group: 'B' }, // 有投 30 萬（即使出席紀錄沒有，也算有登入）→ 倒扣 70 萬
    ];
    const allocs = { partial: { A: 30 * W } };
    const loggedIn = new Set(['present']);
    const r = computeResults(['A', 'B'], members, allocs, (name) => loggedIn.has(name));
    const byGroup = Object.fromEntries(r.groups.map((g) => [g.group, g]));
    expect(byGroup.A).toMatchObject({ raw: 30 * W, penalty: 100 * W, final: -70 * W });
    expect(byGroup.A.deductions).toEqual([{ name: 'present', unspent: 100 * W }]);
    expect(byGroup.B).toMatchObject({ raw: 0, penalty: 70 * W, final: -70 * W });
    // 兩組同為 −70 萬 → 並列第 1，負數也照樣拿一飛沖天
    expect(r.rocket).toEqual(['A', 'B']);
    expect(byGroup.A.multiplier).toBe(3);
  });

  it('個人名次的分母只算有投資的人；沒人投資時股神從缺，一飛沖天仍全部並列', () => {
    const members = [
      { name: 'x', group: 'A' },
      { name: 'y', group: 'B' },
      { name: 'z', group: 'B' },
    ];
    // 只有 x 登入並投了 1 元給 B；y、z 沒登入不倒扣 → B = 1 元第 1 名 ×3，A = −999,999 元
    const r = computeResults(['A', 'B'], members, { x: { B: 1 } }, (n) => n === 'x');
    expect(r.groups.map((g) => [g.group, g.final, g.rank])).toEqual([
      ['B', 1, 1],
      ['A', -(BUDGET - 1), 2],
    ]);
    expect(r.investors.map((i) => [i.name, i.payout, i.rank])).toEqual([['x', 3, 1]]);
    expect(r.stockGods).toEqual(['x']);

    const none = computeResults(['A', 'B'], members, {}, () => false);
    expect(none.investors).toEqual([]);
    expect(none.stockGods).toEqual([]);
    expect(none.rocket).toEqual(['A', 'B']);
    expect(none.groups.every((g) => g.penalty === 0)).toBe(true);
  });

  it('公開結果只有各組金額，不含學生姓名', () => {
    const r = computeResults(
      ['A', 'B', 'C'],
      [
        { name: '王小明', group: 'A' },
        { name: '李小華', group: 'B' },
      ],
      { 王小明: { B: 50 * W, C: 50 * W }, 李小華: { A: 20 * W } },
    );
    const pub = toPublicResults(r);
    expect(Object.keys(pub.groups[0]).sort()).toEqual(['final', 'group', 'multiplier', 'penalty', 'rank', 'raw']);
    const json = JSON.stringify(pub.groups);
    expect(json).not.toContain('李小華');
    expect(json).not.toContain('王小明');
    expect(pub.stockGods).toEqual([{ name: '王小明', group: 'A', payout: r.investors[0].payout }]);
    expect(pub.investorCount).toBe(2);
  });

  it('金額可以到 1 元，×1.5 的報酬可以有 0.5 元', () => {
    const r = computeResults(['A', 'B', 'C', 'D'], [{ name: 'm', group: 'D' }], { m: { A: 3, B: 2, C: 1 } });
    // A=3 第 1 ×3、B=2 第 2 ×2、C=1 第 3 ×1.5 → 9 + 4 + 1.5
    expect(r.investors[0].payout).toBe(14.5);
    expect(r.groups.find((g) => g.group === 'D')).toMatchObject({ penalty: BUDGET - 6, final: -(BUDGET - 6) });
  });

  it('忽略投給自己組或不存在組的髒資料', () => {
    const r = computeResults(['A', 'B'], [{ name: 'm', group: 'A' }], { m: { A: 50 * W, B: 50 * W, Z: 10 * W } });
    const a = r.groups.find((g) => g.group === 'A')!;
    expect(a.raw).toBe(0);
    expect(a.penalty).toBe(50 * W);
    expect(r.investors[0].payout).toBe(50 * W * 3);
  });
});

describe('金額格式（最小單位 1 元）', () => {
  it('以萬顯示且精確到 1 元', () => {
    expect(wan(350_000)).toBe('35');
    expect(wan(525_000)).toBe('52.5');
    expect(wan(123_456)).toBe('12.3456');
    expect(wan(1)).toBe('0.0001');
    expect(wan(14.5)).toBe('0.00145');
    expect(wan(-120_000)).toBe('−12');
    expect(wan(0)).toBe('0');
  });

  it('解析學生輸入的萬元金額', () => {
    expect(parseWanInput('12.3456')).toBe(123_456);
    expect(parseWanInput('0.0001')).toBe(1);
    expect(parseWanInput(' 50 ')).toBe(500_000);
    expect(parseWanInput('５')).toBe(50_000);
    expect(parseWanInput('1.')).toBe(10_000);
    expect(parseWanInput('0.00001')).toBeNull();
    expect(parseWanInput('-1')).toBeNull();
    expect(parseWanInput('abc')).toBeNull();
    expect(parseWanInput('')).toBeNull();
  });
});
