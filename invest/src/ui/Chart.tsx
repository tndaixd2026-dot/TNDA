// 各組金額走勢圖（SVG）。顏色依組別順序固定；線尾有直接標籤，擠在一起時用引線拉開。
import { useEffect, useRef, useState } from 'preact/hooks';
import { clockTime, wan } from '../../shared/format.ts';
import { splitGroupLabel } from '../../shared/roster.ts';
import type { HistoryPoint } from '../../shared/types.ts';
import { seriesColor } from './common.tsx';

interface ChartProps {
  groups: string[];
  points: HistoryPoint[];
  now: number;
  /** 開盤中：線延伸到現在 */
  live: boolean;
  /** 標出暗盤期間 */
  shadeFrom?: number | null;
  shadeTo?: number | null;
  label: string;
}

function niceStep(range: number, count: number): number {
  const raw = Math.max(range, 1) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

export function Chart({ groups, points, now, live, shadeFrom, shadeTo, label }: ChartProps) {
  const { ref, size } = useSize<HTMLDivElement>();
  const rem = typeof document === 'undefined' ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

  if (points.length === 0) {
    return (
      <div class="chart" ref={ref}>
        <div class="chart-empty">開盤後這裡會出現各組的走勢</div>
      </div>
    );
  }

  const { w, h } = size;
  const margin = { top: rem * 1.2, right: rem * 12, bottom: rem * 2.4, left: rem * 4.6 };
  const iw = Math.max(10, w - margin.left - margin.right);
  const ih = Math.max(10, h - margin.top - margin.bottom);

  const t0 = points[0].t;
  let t1 = live ? Math.max(now, points[points.length - 1].t) : points[points.length - 1].t;
  // 剛開盤時至少顯示 15 秒寬，線條不會擠在最左邊
  if (t1 - t0 < 15_000) t1 = t0 + 15_000;

  let lo = 0;
  let hi = 100_000;
  for (const p of points) {
    for (const g of groups) {
      const v = p.totals[g] ?? 0;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;

  const x = (t: number) => margin.left + ((t - t0) / (t1 - t0)) * iw;
  const y = (v: number) => margin.top + (1 - (v - lo) / (hi - lo)) * ih;

  const yTicks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) yTicks.push(v);

  const minute = 60_000;
  const interval = [1, 2, 5, 10, 15, 30, 60].map((m) => m * minute).find((iv) => (t1 - t0) / iv <= 6) ?? 120 * minute;
  const xTicks: number[] = [];
  for (let t = Math.ceil(t0 / interval) * interval; t <= t1; t += interval) xTicks.push(t);

  const last = points[points.length - 1];
  const series = groups.map((g, i) => {
    // 階梯線：金額在兩次交易之間維持不變，交易當下才跳動（封盤倒扣也是瞬間跳下）
    let d = '';
    points.forEach((p, k) => {
      const px = x(p.t).toFixed(1);
      const py = y(p.totals[g] ?? 0).toFixed(1);
      d += k ? `H${px}V${py}` : `M${px},${py}`;
    });
    const endValue = last.totals[g] ?? 0;
    const endT = live ? t1 : last.t;
    if (live) d += `H${x(endT).toFixed(1)}`;
    return { g, i, d, endX: x(endT), endY: y(endValue), endValue };
  });

  // 線尾標籤：依高度排序後保持最小間距，必要時往上推；偏離線尾就畫引線
  const fontPx = rem * 1.05;
  const gap = fontPx * 1.3;
  const labels = [...series].sort((a, b) => a.endY - b.endY).map((s) => ({ ...s, ly: s.endY }));
  for (let k = 1; k < labels.length; k++) labels[k].ly = Math.max(labels[k].ly, labels[k - 1].ly + gap);
  const bottom = margin.top + ih;
  if (labels.length && labels[labels.length - 1].ly > bottom) {
    labels[labels.length - 1].ly = bottom;
    for (let k = labels.length - 2; k >= 0; k--) labels[k].ly = Math.min(labels[k].ly, labels[k + 1].ly - gap);
  }
  const labelX = margin.left + iw + rem * 1.6;

  return (
    <div class="chart" ref={ref}>
      {w > 0 && h > 0 && (
        <svg width={w} height={h} role="img" aria-label={label}>
          {shadeFrom && (
            <g class="chart-shade">
              <rect
                x={x(shadeFrom)}
                y={margin.top}
                width={Math.max(0, x(shadeTo ?? t1) - x(shadeFrom))}
                height={ih}
              />
              <text x={x(shadeFrom) + rem * 0.5} y={margin.top + rem * 1.2}>
                暗盤
              </text>
            </g>
          )}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line class={v === 0 ? 'chart-baseline' : 'chart-grid'} x1={margin.left} x2={margin.left + iw} y1={y(v)} y2={y(v)} />
              <text class="chart-tick" x={margin.left - rem * 0.6} y={y(v)} text-anchor="end" dominant-baseline="middle">
                {wan(v)}萬
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} class="chart-tick" x={x(t)} y={margin.top + ih + rem * 1.6} text-anchor="middle">
              {clockTime(t)}
            </text>
          ))}
          {series.map((s) => (
            <path
              key={s.g}
              d={s.d}
              fill="none"
              stroke={seriesColor(s.i)}
              stroke-width={rem * 0.2}
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          ))}
          {labels.map((s) => (
            <g key={`l${s.g}`}>
              {Math.abs(s.ly - s.endY) > 1 && (
                <polyline
                  class="chart-leader"
                  points={`${s.endX + rem * 0.5},${s.endY} ${labelX - rem * 0.9},${s.endY} ${labelX - rem * 0.3},${s.ly}`}
                  fill="none"
                />
              )}
              <circle cx={s.endX} cy={s.endY} r={rem * 0.38} fill={seriesColor(s.i)} class="chart-dot" stroke-width={rem * 0.15} />
              <text class="chart-label" x={labelX} y={s.ly} dominant-baseline="middle" style={{ fontSize: `${fontPx}px` }}>
                <tspan class="chart-label-name">{splitGroupLabel(s.g).short}</tspan>
                <tspan class="chart-label-value" dx={rem * 0.5}>
                  {wan(s.endValue)}萬
                </tspan>
              </text>
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
