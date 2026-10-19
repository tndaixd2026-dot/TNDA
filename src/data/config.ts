// 這台裝置的設定（存在瀏覽器 localStorage）。
// Token 與同步金鑰只存在你自己的裝置上，不會上傳到任何地方。

import { DEFAULT_DATA_BRANCH } from '../core/repo.ts';

declare const __DEMO_ONLY__: boolean;
export const DEMO_ONLY: boolean = typeof __DEMO_ONLY__ !== 'undefined' && __DEMO_ONLY__;

export type Mode = 'demo' | 'github';
export type ThemePref = 'system' | 'light' | 'dark';

export interface DeviceConfig {
  mode: Mode | null;
  owner: string;
  repo: string;
  branch: string;
  token: string;
  syncKey: string;
  /** 這個裝置開著網站時，到時間就直接發送（比 GitHub 排程準時） */
  precision: boolean;
  theme: ThemePref;
  deviceId: string;
  previewTheme: 'dark' | 'light';
  /** false：只在這次瀏覽期間記住（公用電腦），關掉瀏覽器就登出 */
  remember: boolean;
}

const KEY = 'tnda-relay:config';

function detectRepo(): { owner: string; repo: string } {
  if (typeof location === 'undefined') return { owner: '', repo: '' };
  const host = location.hostname;
  const m = /^([\w-]+)\.github\.io$/i.exec(host);
  const seg = location.pathname.split('/').filter(Boolean)[0] ?? '';
  if (m) return { owner: m[1], repo: seg || `${m[1]}.github.io` };
  return { owner: 'tndaixd2026-dot', repo: 'TNDA' };
}

function randomDeviceId(): string {
  const a = crypto.getRandomValues(new Uint8Array(4));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function defaultConfig(): DeviceConfig {
  const { owner, repo } = detectRepo();
  return {
    mode: DEMO_ONLY ? 'demo' : null,
    owner,
    repo,
    branch: DEFAULT_DATA_BRANCH,
    token: '',
    syncKey: '',
    precision: true,
    theme: 'system',
    deviceId: randomDeviceId(),
    previewTheme: 'dark',
    remember: true,
  };
}

function readStored(): string | null {
  try {
    const persistent = localStorage.getItem(KEY);
    if (persistent) return persistent;
  } catch {
    /* 忽略 */
  }
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function loadConfig(): DeviceConfig {
  const base = defaultConfig();
  try {
    const raw = readStored();
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<DeviceConfig>;
    const merged = { ...base, ...saved };
    if (DEMO_ONLY) merged.mode = 'demo';
    return merged;
  } catch {
    return base;
  }
}

export function saveConfig(cfg: DeviceConfig): void {
  const [keep, drop] = cfg.remember === false ? ['sessionStorage', 'localStorage'] as const : ['localStorage', 'sessionStorage'] as const;
  try {
    window[drop].removeItem(KEY);
  } catch {
    /* 忽略 */
  }
  try {
    window[keep].setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* 私密瀏覽等情況無法儲存，僅在本次使用 */
  }
}

export function clearConfig(): void {
  for (const store of ['localStorage', 'sessionStorage'] as const) {
    try {
      window[store].removeItem(KEY);
    } catch {
      /* 忽略 */
    }
  }
}

// ───────────── 裝置連結（把設定透過網址片段帶到另一台裝置）─────────────

interface LinkPayload {
  o: string;
  r: string;
  b: string;
  t: string;
  k: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function buildDeviceLink(cfg: DeviceConfig): string {
  const payload: LinkPayload = { o: cfg.owner, r: cfg.repo, b: cfg.branch, t: cfg.token, k: cfg.syncKey };
  const base = typeof location !== 'undefined' ? location.href.split('#')[0] : '';
  return `${base}#connect.${toBase64Url(JSON.stringify(payload))}`;
}

export function parseDeviceLink(hash: string): Pick<DeviceConfig, 'owner' | 'repo' | 'branch' | 'token' | 'syncKey'> | null {
  const m = /^#?connect\.([\w-]+)$/.exec(hash);
  if (!m) return null;
  try {
    const p = JSON.parse(fromBase64Url(m[1])) as LinkPayload;
    if (!p.o || !p.r || !p.t || !p.k) return null;
    return { owner: p.o, repo: p.r, branch: p.b || DEFAULT_DATA_BRANCH, token: p.t, syncKey: p.k };
  } catch {
    return null;
  }
}
