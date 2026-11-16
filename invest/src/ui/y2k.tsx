// 一點 Y2K：像素字視窗標題列、四角星芒、跑馬燈、閃爍游標。
// 仍然只用 TNDA 的橘、黑、白，不用漸層與金屬質感（品牌規範）。
import type { ComponentChildren } from 'preact';
import { wan } from '../../shared/format.ts';
import { useTween } from './motion.ts';

/** 四角星芒（Y2K 的 sparkle）。純裝飾。 */
export function Sparkle({
  size = 24,
  color = 'currentColor',
  class: cls,
  style,
}: {
  size?: number | string;
  color?: string;
  class?: string;
  style?: Record<string, string | number>;
}) {
  return (
    <svg
      class={`sparkle${cls ? ` ${cls}` : ''}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      style={style}
    >
      <path d="M12 0 C13 7.5 16.5 11 24 12 C16.5 13 13 16.5 12 24 C11 16.5 7.5 13 0 12 C7.5 11 11 7.5 12 0 Z" fill={color} />
    </svg>
  );
}

/** 舊式作業系統的視窗標題列：像素字標題＋三個方塊按鈕（裝飾用）。 */
export function WinBar({ title, tone = 'black' }: { title: string; tone?: 'black' | 'orange' | 'white' }) {
  return (
    <div class={`win-bar win-bar-${tone}`} aria-hidden="true">
      <span class="win-title">{title}</span>
      <span class="win-btns">
        <i>_</i>
        <i class="win-max" />
        <i>×</i>
      </span>
    </div>
  );
}

/** 跑馬燈：內容重複兩次，無縫循環。 */
export function Ticker({ items, speed = 90, class: cls }: { items: ComponentChildren[]; speed?: number; class?: string }) {
  const row = (hidden: boolean) => (
    <span class="ticker-run" aria-hidden={hidden ? 'true' : undefined}>
      {items.map((it, i) => (
        <span class="ticker-item" key={i}>
          {it}
          <Sparkle size="0.8em" class="ticker-star" />
        </span>
      ))}
    </span>
  );
  // 速度以「每個項目的秒數」換算，項目多就跑久一點
  const seconds = Math.max(18, (items.length * 600) / speed);
  return (
    <div class={`ticker${cls ? ` ${cls}` : ''}`}>
      <div class="ticker-track" style={{ animationDuration: `${seconds}s` }}>
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}

/** 金額（萬）：改變時平滑滑到新數字。 */
/** step：滑動途中取整的單位（元）。手機錢包用 1 萬，途中不會出現一長串小數把版面撐寬。 */
export function Wan({ value, ms = 700, from, step = 100 }: { value: number; ms?: number; from?: number; step?: number }) {
  const shown = useTween(value, ms, step, from);
  return <>{wan(shown)}</>;
}

/** 平滑變化的整數（例如人數） */
export function Count({ value, ms = 500 }: { value: number; ms?: number }) {
  const shown = useTween(value, ms, 1);
  return <>{Math.round(shown)}</>;
}

export function Cursor() {
  return (
    <span class="cursor" aria-hidden="true">
      _
    </span>
  );
}
