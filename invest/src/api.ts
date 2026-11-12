// 前端與伺服器溝通：JSON API + Server-Sent Events 即時同步（斷線自動重連）。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CourseId, HistoryPoint, MeState, PublicState } from '../shared/types.ts';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; admin?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts.admin ? { 'x-admin-password': opts.admin } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'network', '連線失敗，請檢查網路後再試一次');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `伺服器錯誤（${res.status}）`);
  }
  return data as T;
}

export type HistoryMap = Record<CourseId, HistoryPoint[]>;

export interface Live {
  pub: PublicState | null;
  me: MeState | null;
  history: HistoryMap | null;
  /** 伺服器時間 − 本機時間 */
  offset: number;
  connected: boolean;
  setMe: (me: MeState) => void;
}

const STALE_MS = 35_000;

/**
 * 訂閱伺服器推播。name 有值時會收到自己的投資資料；history 為 true 時會收到完整走勢（大螢幕用）。
 */
export function useLive(opts: { name?: string | null; history?: boolean }): Live {
  const [pub, setPub] = useState<PublicState | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [history, setHistory] = useState<HistoryMap | null>(null);
  const [offset, setOffset] = useState(0);
  const [connected, setConnected] = useState(false);
  const lastSeen = useRef(Date.now());

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const params = new URLSearchParams();
    if (opts.name) params.set('name', opts.name);
    if (opts.history) params.set('history', '1');
    const url = `/api/events?${params.toString()}`;

    const touch = () => {
      lastSeen.current = Date.now();
    };

    const connect = () => {
      if (disposed) return;
      es?.close();
      es = new EventSource(url);
      touch();
      es.addEventListener('open', () => {
        touch();
        setConnected(true);
      });
      es.addEventListener('error', () => {
        setConnected(false);
        // 伺服器回錯誤時瀏覽器不會自動重連，這裡補上
        if (es?.readyState === EventSource.CLOSED && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            connect();
          }, 3000);
        }
      });
      es.addEventListener('state', (e) => {
        touch();
        const s = JSON.parse((e as MessageEvent<string>).data) as PublicState;
        const next = s.now - Date.now();
        setOffset((prev) => (Math.abs(prev - next) > 500 ? next : prev));
        setPub(s);
      });
      es.addEventListener('me', (e) => {
        touch();
        setMe(JSON.parse((e as MessageEvent<string>).data) as MeState);
      });
      es.addEventListener('history', (e) => {
        touch();
        setHistory(JSON.parse((e as MessageEvent<string>).data) as HistoryMap);
      });
      es.addEventListener('point', (e) => {
        touch();
        const { course, point } = JSON.parse((e as MessageEvent<string>).data) as { course: CourseId; point: HistoryPoint };
        setHistory((h) => {
          if (!h) return h;
          const list = h[course].slice();
          const last = list[list.length - 1];
          if (last && last.t === point.t) list[list.length - 1] = point;
          else list.push(point);
          return { ...h, [course]: list };
        });
      });
      es.addEventListener('ping', touch);
    };

    connect();

    // 太久沒收到任何訊息（例如手機休眠、代理伺服器斷線）就重新連線
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen.current > STALE_MS) connect();
    }, 5000);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastSeen.current > 5000) connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      es?.close();
      clearInterval(watchdog);
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [opts.name, opts.history]);

  return { pub, me, history, offset, connected, setMe };
}

/** 以伺服器時間為準、每 intervalMs 更新一次的「現在」。 */
export function useNow(offset: number, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const id = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(id);
  }, [offset, intervalMs]);
  return now;
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 私密瀏覽等情況無法存，忽略
  }
}
