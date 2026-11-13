// 共用的小元件。
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { encode } from 'uqr';
import { splitGroupLabel } from '../../shared/roster.ts';
import { countdown } from '../../shared/format.ts';
import { PHASE_LABEL, type Phase, type PublicCourse } from '../../shared/types.ts';

/** 組別顏色依「組別順序」固定，不隨名次改變。 */
export function seriesColor(index: number): string {
  return `var(--series-${(index % 8) + 1})`;
}

export function groupIndexMap(course: PublicCourse | undefined): Map<string, number> {
  return new Map((course?.groups ?? []).map((g, i) => [g.id, i]));
}

export function Swatch({ index }: { index: number }) {
  return <span class="swatch" style={{ background: seriesColor(index) }} aria-hidden="true" />;
}

export function GroupName({ id, index, stacked }: { id: string; index?: number; stacked?: boolean }) {
  const { short, nick } = splitGroupLabel(id);
  return (
    <span class={`group-name${stacked ? ' stacked' : ''}`}>
      {index !== undefined && <Swatch index={index} />}
      <span class="group-text">
        <span class="group-short">{short}</span>
        {nick && <span class="group-nick">{nick}</span>}
      </span>
    </span>
  );
}

const PHASE_ICON: Record<Phase, string> = {
  pending: '◷',
  open: '●',
  dark: '◐',
  closed: '■',
};

export function PhaseBadge({ phase, remainingMs }: { phase: Phase; remainingMs?: number }) {
  return (
    <span class={`phase-badge phase-${phase}`}>
      <span class="phase-icon" aria-hidden="true">
        {PHASE_ICON[phase]}
      </span>
      {PHASE_LABEL[phase]}
      {phase === 'dark' && remainingMs !== undefined && <span class="phase-timer">{countdown(remainingMs)}</span>}
    </span>
  );
}

export function QrCode({ text, label }: { text: string; label?: string }) {
  const path = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { d, size: qr.size };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label ?? text} shape-rendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), text, tone });
    timer.current = setTimeout(() => setToast(null), 2800);
  }, []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const node = toast ? (
    <div key={toast.id} class={`toast toast-${toast.tone}`} role="status" aria-live="polite">
      {toast.text}
    </div>
  ) : null;
  return { show, node };
}

export function Card({ children, class: cls }: { children: ComponentChildren; class?: string }) {
  return <section class={`card${cls ? ` ${cls}` : ''}`}>{children}</section>;
}

export function ConnectionDot({ connected }: { connected: boolean }) {
  return (
    <span class={`conn ${connected ? 'conn-on' : 'conn-off'}`} title={connected ? '已連線' : '重新連線中…'}>
      <span aria-hidden="true">{connected ? '●' : '○'}</span>
      {connected ? '已連線' : '重新連線中…'}
    </span>
  );
}
