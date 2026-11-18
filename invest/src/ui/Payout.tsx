// 股神獎倍率表：開盤前、開盤中、暗盤都要讓大家清楚看到「第幾名的組乘幾倍」
import { multiplierForRank } from '../../shared/rules.ts';

const TIERS: { label: string; mult: number }[] = [
  { label: '第 1 名', mult: multiplierForRank(1) },
  { label: '第 2 名', mult: multiplierForRank(2) },
  { label: '第 3 名', mult: multiplierForRank(3) },
  { label: '第 4 名起', mult: multiplierForRank(4) },
];

/**
 * size="screen"：大螢幕（rem，跟著螢幕縮放）；size="phone"：學生手機的精簡版。
 * compact：只顯示四個倍率，不顯示公式與舉例（暗盤大螢幕空間小時用）。
 */
export function PayoutTable({ size = 'phone', compact = false }: { size?: 'screen' | 'phone'; compact?: boolean }) {
  return (
    <section class={`payout payout-${size}${compact ? ' payout-compact' : ''}`} aria-label="股神獎倍率">
      <div class="payout-head">
        <span class="payout-title">股神獎倍率</span>
        <span class="payout-sub">封盤後依各組最終金額排名</span>
      </div>
      <ol class="payout-tiers">
        {TIERS.map((t, i) => (
          <li key={t.label} class={`payout-tier tier-${i + 1}`}>
            <span class="payout-rank">{t.label}</span>
            <span class="payout-mult">×{t.mult}</span>
          </li>
        ))}
      </ol>
      {!compact && (
        <p class="payout-formula">
          你的報酬 ＝ 投資金額 × 該組倍率（各組加總），報酬最高的人拿<strong>股神獎</strong>
          <span class="payout-eg">例：投 50 萬給第 1 名的組 → 報酬 150 萬</span>
        </p>
      )}
    </section>
  );
}
