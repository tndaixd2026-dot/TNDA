// 動畫用的小工具：數字補間、排行換位（FLIP）、平滑時鐘。
// 使用者在系統設定「減少動態效果」時，全部直接跳到結果。
import { useEffect, useLayoutEffect, useRef, useState, type MutableRef } from 'preact/hooks';

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const easeOut = (k: number) => 1 - (1 - k) ** 3;

/**
 * 數字從目前顯示的值平滑滑到新的值。動畫途中以 `step` 為單位取整（避免小數亂跳），
 * 最後一定停在精確的目標值。
 */
export function useTween(target: number, ms = 600, step = 1, from?: number): number {
  const initial = from === undefined || reducedMotion() ? target : from;
  const [shown, setShown] = useState(initial);
  const cur = useRef(initial);
  useEffect(() => {
    if (cur.current === target) return;
    if (ms <= 0 || reducedMotion()) {
      cur.current = target;
      setShown(target);
      return;
    }
    const a = cur.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const x = a + (target - a) * easeOut(k);
      cur.current = k >= 1 ? target : x;
      setShown(k >= 1 ? target : Math.round(x / step) * step);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // 被新的目標打斷時，從目前的位置接著滑
    };
  }, [target, ms, step]);
  return shown;
}

/** 一組數字（例如各組金額）一起補間；新出現的鍵直接用目標值。 */
export function useTweenMap(target: Record<string, number>, ms = 600): Record<string, number> {
  const sig = Object.entries(target)
    .map(([k, v]) => `${k}:${v}`)
    .join('|');
  const [shown, setShown] = useState(target);
  const cur = useRef<Record<string, number>>(target);
  useEffect(() => {
    const from = cur.current;
    const changed = Object.keys(target).some((k) => from[k] !== target[k]) || Object.keys(from).length !== Object.keys(target).length;
    if (!changed) return;
    if (ms <= 0 || reducedMotion()) {
      cur.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = easeOut(k);
      const next: Record<string, number> = {};
      for (const key of Object.keys(target)) {
        const a = from[key] ?? target[key];
        next[key] = k >= 1 ? target[key] : a + (target[key] - a) * e;
      }
      cur.current = next;
      setShown(next);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sig, ms]);
  return shown;
}

/**
 * 清單重新排序時，每一列從舊位置滑到新位置（FLIP）。
 * 子元素要有 data-key；用 offsetTop 量位置，不受進行中的動畫影響。
 */
export function useFlip(container: MutableRef<HTMLElement | null>, ms = 650) {
  const prev = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const next = new Map<string, number>();
    const skip = reducedMotion();
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const key = child.dataset.key;
      if (!key) continue;
      const top = child.offsetTop;
      next.set(key, top);
      const old = prev.current.get(key);
      if (!skip && old !== undefined && old !== top && typeof child.animate === 'function') {
        child.animate([{ transform: `translateY(${old - top}px)` }, { transform: 'translateY(0)' }], {
          duration: ms,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        });
      }
    }
    prev.current = next;
  });
}

/** 平滑時鐘：每一個畫面更新一次（最多約 30 次／秒），走勢圖往右延伸不會一格一格跳。 */
export function useSmoothNow(offset: number, enabled: boolean, fallback: number): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  const off = useRef(offset);
  off.current = offset;
  useEffect(() => {
    if (!enabled || reducedMotion()) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last >= 33) {
        last = t;
        setNow(Date.now() + off.current);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
  return enabled && !reducedMotion() ? now : fallback;
}
