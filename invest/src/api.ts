// 前端與資料庫溝通：呼叫 Supabase（或本機版）的 RPC 函式，並用定時查詢保持同步。
// 不用 WebSocket：現場網路不穩時，每次查詢都是獨立的請求，斷線後下一次查詢就自動補上最新狀態。
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CourseId, HistoryPoint, MeState, PublicState } from '../shared/types.ts';

/** 建置時決定：有設定就連 Supabase；空字串表示同一台主機（本機版） */
const BASE = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 新版 publishable key（sb_publishable_…）只放 apikey；舊版 anon key 是 JWT，另外放 Authorization
        ...(KEY ? { apikey: KEY } : {}),
        ...(KEY.startsWith('eyJ') ? { authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify(args),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', '連線失敗，請檢查網路後再試一次');
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new ApiError(res.status, 'server', typeof data?.message === 'string' ? data.message : `伺服器錯誤（${res.status}）`);
  }
  if (data && typeof data === 'object' && typeof data.error === 'string' && typeof data.message === 'string') {
    throw new ApiError(400, data.error, data.message);
  }
  return data as T;
}

export type HistoryMap = Record<CourseId, HistoryPoint[]>;

interface Unchanged {
  unchanged: true;
  version: number;
  now: number;
}

export interface Live {
  pub: PublicState | null;
  me: MeState | null;
  /** 名字不在名單上（例如名單更新了） */
  meError: ApiError | null;
  history: HistoryMap | null;
  /** 伺服器時間 − 本機時間 */
  offset: number;
  connected: boolean;
  setMe: (me: MeState) => void;
}

/** 盤況有沒有「階段性」變化（換場、開盤、暗盤、封盤、取消封盤、重置） */
function phaseKey(s: PublicState): string {
  const c = (x: PublicState['courses']['wed']) => `${x.phase}:${x.darkEndsAt ?? ''}:${x.closedAt ?? ''}`;
  return `${s.active}|${c(s.courses.wed)}|${c(s.courses.thu)}`;
}

function mergePoints(old: HistoryPoint[], fresh: HistoryPoint[]): HistoryPoint[] {
  if (fresh.length === 0) return old;
  const next = old.slice();
  for (const p of fresh) {
    const i = next.findIndex((q) => q.id === p.id);
    if (i >= 0) next[i] = p;
    else next.push(p);
  }
  return next;
}

/**
 * 定時查詢公開狀態。
 * - name：學生端，另外取得自己的投資，並每 15 秒回報一次「我在線上」（出席紀錄）
 * - history：大螢幕，另外取得走勢
 * - intervalMs：查詢間隔（大螢幕 0.7 秒、學生與管理員 2 秒）
 */
export function useLive(opts: { name?: string | null; history?: boolean; intervalMs?: number }): Live {
  const [pub, setPub] = useState<PublicState | null>(null);
  const [me, setMe] = useState<MeState | null>(null);
  const [meError, setMeError] = useState<ApiError | null>(null);
  const [history, setHistory] = useState<HistoryMap | null>(null);
  const [offset, setOffset] = useState(0);
  const [connected, setConnected] = useState(true);
  const failures = useRef(0);
  const interval = opts.intervalMs ?? 2000;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let version: number | null = null;
    let lastKey = '';
    let hist: HistoryMap | null = null;
    let polling = false;

    const noteTime = (serverNow: number) => {
      const next = serverNow - Date.now();
      setOffset((prev) => (Math.abs(prev - next) > 500 ? next : prev));
    };

    async function refreshMe() {
      if (!opts.name) return;
      try {
        setMe(await rpc<MeState>('invest_me', { name: opts.name }));
        setMeError(null);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_in_roster') setMeError(err);
      }
    }

    async function loadHistory(full: boolean) {
      const lastId = (c: CourseId) => (full || !hist ? 0 : (hist[c][hist[c].length - 1]?.id ?? 0));
      const fresh = await rpc<HistoryMap>('invest_history', { after_wed: lastId('wed'), after_thu: lastId('thu') });
      hist = full || !hist ? fresh : { wed: mergePoints(hist.wed, fresh.wed), thu: mergePoints(hist.thu, fresh.thu) };
      setHistory(hist);
    }

    async function poll() {
      if (polling || stopped) return;
      polling = true;
      if (timer) clearTimeout(timer);
      try {
        const s = await rpc<PublicState | Unchanged>('invest_state', { since: version });
        failures.current = 0;
        setConnected(true);
        noteTime(s.now);
        if (!('unchanged' in s)) {
          const key = phaseKey(s);
          const changed = key !== lastKey;
          lastKey = key;
          version = s.version;
          setPub(s);
          if (changed) void refreshMe();
          if (opts.history) await loadHistory(changed || !hist);
        }
      } catch {
        failures.current++;
        if (failures.current >= 2) setConnected(false);
      } finally {
        polling = false;
        if (!stopped) timer = setTimeout(poll, document.visibilityState === 'hidden' ? 5000 : interval);
      }
    }

    void poll();
    void refreshMe();
    const heartbeat = opts.name ? setInterval(() => void refreshMe(), 15_000) : null;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void poll();
        void refreshMe();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [opts.name, opts.history, interval]);

  return { pub, me, meError, history, offset, connected, setMe };
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
