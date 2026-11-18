// 加權與倍率說明：開盤前、開盤中、暗盤都要讓大家清楚看到
// 1. 時段加權（下單當下決定）：該組簡報 ×2、Demo ×1.5、業師講評 ×1.2、其他時間 ×1
// 2. 名次倍率（封盤後決定）：第 1 名 ×3、第 2 名 ×2、第 3 名 ×1.5、其餘 ×1
import { multiplierForRank, PRESENT_STAGES } from '../../shared/rules.ts';

const RANK_TIERS = [
  { label: '第 1 名', mult: multiplierForRank(1) },
  { label: '第 2 名', mult: multiplierForRank(2) },
  { label: '第 3 名', mult: multiplierForRank(3) },
  { label: '第 4 名起', mult: multiplierForRank(4) },
];

const STAGE_TIERS: { label: string; sub?: string; mult: number }[] = [
  ...PRESENT_STAGES.map((s) => ({ label: s.label, sub: `${s.ms / 60_000} 分鐘`, mult: s.weight })),
  { label: '其他時間', mult: 1 },
];

function Tiers({ items }: { items: { label: string; sub?: string; mult: number }[] }) {
  return (
    <ol class="payout-tiers">
      {items.map((t, i) => (
        <li key={t.label} class={`payout-tier tier-${i + 1}`}>
          <span class="payout-rank">{t.label}</span>
          <span class="payout-mult">×{t.mult}</span>
          {t.sub && <span class="payout-tier-sub">{t.sub}</span>}
        </li>
      ))}
    </ol>
  );
}

/**
 * size="screen"：大螢幕（rem，跟著螢幕縮放）；size="phone"：學生手機。
 * compact：只顯示兩排倍率，不顯示公式與舉例。
 */
export function PayoutTable({ size = 'phone', compact = false }: { size?: 'screen' | 'phone'; compact?: boolean }) {
  return (
    <section class={`payout payout-${size}${compact ? ' payout-compact' : ''}`} aria-label="加權與倍率">
      <div class="payout-head">
        <span class="payout-title">① 時段加權</span>
        <span class="payout-sub">在某組報告時投給「那一組」，下單當下決定</span>
      </div>
      <Tiers items={STAGE_TIERS} />
      <div class="payout-head payout-head-2">
        <span class="payout-title">② 名次倍率</span>
        <span class="payout-sub">封盤後依各組加權後總額排名</span>
      </div>
      <Tiers items={RANK_TIERS} />
      {!compact && (
        <p class="payout-formula">
          各組總額 ＝ 每筆投資 × 時段加權（決定<strong>一飛沖天獎</strong>）
          <br />
          你的報酬 ＝ 每筆投資 × 時段加權 × 名次倍率，最高的人拿<strong>股神獎</strong>
          <span class="payout-eg">例：在第 1 名那組簡報時投 50 萬 → 50 × 2 × 3 ＝ 300 萬。同分時，下注越快的人勝出</span>
        </p>
      )}
    </section>
  );
}
