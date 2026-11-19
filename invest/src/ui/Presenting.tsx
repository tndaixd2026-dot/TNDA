// 「現在報告中」：哪一組在台上、在哪個時段、現在投給它的加權、這個時段還剩多久
import { countdown } from '../../shared/format.ts';
import { splitGroupLabel } from '../../shared/roster.ts';
import { PRESENT_STAGES, PRESENT_WINDOW_MS, stageAt, type StageNow } from '../../shared/rules.ts';
import type { PublicCourse } from '../../shared/types.ts';
import { groupIndexMap, seriesColor } from './common.tsx';

export interface PresentingNow extends StageNow {
  group: string;
  elapsedMs: number;
}

/** 目前在報告的組與時段；沒有組在報告（或已封盤）回傳 null */
export function presentingNow(pc: PublicCourse, now: number): PresentingNow | null {
  if (!pc.presenting || pc.phase === 'closed') return null;
  const elapsedMs = Math.max(0, now - pc.presenting.startedAt);
  return { group: pc.presenting.group, elapsedMs, ...stageAt(elapsedMs) };
}

/** 某組現在投下去的加權（只有報告中的組在時段內才大於 1） */
export function weightNow(p: PresentingNow | null, group: string): number {
  return p && p.group === group ? p.weight : 1;
}

export function PresentingBar({
  pc,
  now,
  size = 'phone',
  nonStudent = false,
}: {
  pc: PublicCourse;
  now: number;
  size?: 'phone' | 'screen';
  /** 業師、老師、來賓：自己的錢一律 ×1，只顯示學生的加權 */
  nonStudent?: boolean;
}) {
  const p = presentingNow(pc, now);
  if (!p) return null;
  const { short, nick } = splitGroupLabel(p.group);
  const color = seriesColor(groupIndexMap(pc).get(p.group) ?? 0);
  const i = p.stage ? PRESENT_STAGES.indexOf(p.stage) : PRESENT_STAGES.length;
  const next = p.stage ? (PRESENT_STAGES[i + 1] ?? null) : null;
  return (
    <section class={`presenting presenting-${size}${p.stage ? ` stage-${p.stage.key}` : ' stage-done'}`} aria-live="polite">
      <div class="presenting-who">
        <span class="presenting-kicker">Now · 報告中</span>
        <span class="presenting-group">
          <span class="swatch" style={{ background: color }} aria-hidden="true" />
          {short}
          {nick && <small>{nick}</small>}
        </span>
      </div>
      <div class="presenting-stage">
        <span class="presenting-stage-name">{p.stage ? p.stage.label : '講評結束'}</span>
        <span class="presenting-weight">
          {nonStudent ? '學生投' : '現在投'} <strong>×{p.weight}</strong>
          {nonStudent && <small>（你 ×1）</small>}
        </span>
        {p.stage && (
          <span class="presenting-left">
            剩 <span class="presenting-clock">{countdown(p.leftMs)}</span>
            {next ? ` → ${next.label} ×${next.weight}` : ' → ×1'}
          </span>
        )}
      </div>
      {/* 三個時段的進度條 */}
      <ol class="presenting-track" aria-hidden="true">
        {PRESENT_STAGES.map((st, j) => {
          const start = PRESENT_STAGES.slice(0, j).reduce((s, x) => s + x.ms, 0);
          const fill = Math.min(1, Math.max(0, (p.elapsedMs - start) / st.ms));
          return (
            <li key={st.key} class={j === i ? 'on' : j < i ? 'done' : ''} style={{ flexGrow: st.ms / PRESENT_WINDOW_MS }}>
              <span class="presenting-fill" style={{ width: `${fill * 100}%` }} />
              <span class="presenting-seg">
                {st.label} ×{st.weight}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
