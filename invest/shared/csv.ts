// 管理員下載的結果 CSV（含姓名明細）。Excel 開啟用 UTF-8 BOM。
import { courseLabel, type CourseId, type Results } from './types.ts';

function cell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsCsv(course: CourseId, r: Results): string {
  const rows: (string | number)[][] = [
    [`${courseLabel(course)} 組別排名`],
    ['名次', '組別', '投資總額（時段加權後）', '倒扣', '最終金額', '倍率', '倒扣明細（有登入但沒投完的人）'],
    ...r.groups.map((g) => [
      g.rank,
      g.group,
      g.raw,
      g.penalty,
      g.final,
      g.multiplier,
      g.deductions.map((d) => `${d.name} ${d.unspent}`).join('；'),
    ]),
    [],
    [`${courseLabel(course)} 個人報酬`],
    ['名次（只算有投資的人）', '姓名', '組別', '已投資', '未花完', '報酬', '下注快慢（秒，同分時小者勝）'],
    ...r.investors.map((i) => [i.rank, i.name, i.group, i.invested, i.unspent, i.payout, Math.round((i.delayMs ?? 0) / 100) / 10]),
    [],
    ['一飛沖天獎', r.rocket.join('、')],
    ['股神獎', r.stockGods.join('、')],
  ];
  return '﻿' + rows.map((row) => row.map(cell).join(',')).join('\n') + '\n';
}
