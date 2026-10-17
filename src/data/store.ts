// 全站狀態與操作。畫面只透過這裡讀寫資料。

import { useEffect, useState } from 'preact/hooks';
import type { Channel, ComposeDraft, Post, Repeat, Settings } from '../core/types.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';
import type { WorkflowRun } from '../core/github.ts';
import { GitHubError } from '../core/github.ts';
import { KeyMismatchError, NotInitializedError } from '../core/repo.ts';
import { computeStatus, isDue, deliveryOf } from '../core/delivery.ts';
import { channelMap, sendPost } from '../core/engine.ts';
import { randomId } from '../core/crypto.ts';
import { composePayload, TYPE_META } from '../format/composer.ts';
import { validatePayload } from '../core/discord.ts';
import type { Backend } from './backend.ts';
import { DemoBackend } from './backend-demo.ts';
import { GitHubBackend } from './backend-github.ts';
import { DEMO_ONLY, clearConfig, loadConfig, parseDeviceLink, saveConfig, type DeviceConfig } from './config.ts';
import { IdbBlobCache } from './idb.ts';

export type Page = 'dashboard' | 'compose' | 'queue' | 'history' | 'calendar' | 'channels' | 'settings' | 'about' | 'import';

export interface Route {
  page: Page;
  editId?: string;
  cloneId?: string;
  /** 從行事曆點某一天新增時，預設的發送時間 */
  presetAt?: string;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info';
  text: string;
  action?: { label: string; run: () => void };
}

export type Phase = 'boot' | 'welcome' | 'setup' | 'link' | 'ready' | 'error';

export interface AppState {
  phase: Phase;
  config: DeviceConfig;
  error?: { title: string; detail: string; kind?: 'key' | 'token' | 'branch' | 'network' };
  channels: Channel[];
  settings: Settings;
  posts: Post[];
  skipped: string[];
  sync: { state: 'idle' | 'syncing' | 'error'; at?: number; error?: string };
  scheduler: { runs: WorkflowRun[]; at?: number; error?: string };
  route: Route;
  detailId: string | null;
  toasts: Toast[];
  sending: Record<string, true>;
  linkOffer?: Pick<DeviceConfig, 'owner' | 'repo' | 'branch' | 'token' | 'syncKey'>;
  /** 剛排程/更新的貼文，畫面用來做提示 */
  highlight: string[];
}

const PAGES: Page[] = ['dashboard', 'compose', 'queue', 'history', 'calendar', 'channels', 'settings', 'about', 'import'];

const IMPORT_KEY = 'tnda-relay:pending-import';

/** 匯入連結的內容先暫存起來（重新整理也不會不見），網址改回短的 #import */
function stashImport(data: string) {
  try {
    sessionStorage.setItem(IMPORT_KEY, data);
  } catch {
    /* 無法使用 sessionStorage 時只留在網址上 */
  }
  try {
    history.replaceState(null, '', location.pathname + location.search + '#import');
  } catch {
    /* 忽略 */
  }
}

export function pendingImport(): string | null {
  try {
    return sessionStorage.getItem(IMPORT_KEY);
  } catch {
    return null;
  }
}

export function clearPendingImport() {
  try {
    sessionStorage.removeItem(IMPORT_KEY);
  } catch {
    /* 忽略 */
  }
}

function routeFromHash(): Route {
  let hash = '';
  try {
    hash = location.hash.replace(/^#/, '');
  } catch {
    /* 無法讀取網址 */
  }
  if (hash.startsWith('import=')) {
    stashImport(hash.slice('import='.length));
    return { page: 'import' };
  }
  const edit = /^edit-([\w-]+)$/.exec(hash);
  if (edit) return { page: 'compose', editId: edit[1] };
  if ((PAGES as string[]).includes(hash)) return { page: hash as Page };
  return { page: 'dashboard' };
}

type Listener = () => void;

let state: AppState = {
  phase: 'boot',
  config: loadConfig(),
  channels: [],
  settings: { ...DEFAULT_SETTINGS },
  posts: [],
  skipped: [],
  sync: { state: 'idle' },
  scheduler: { runs: [] },
  route: routeFromHash(),
  detailId: null,
  toasts: [],
  sending: {},
  highlight: [],
};
const listeners = new Set<Listener>();
let backend: Backend | null = null;

export function getState(): AppState {
  return state;
}

function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function useApp<T>(select: (s: AppState) => T): T {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return select(state);
}

export function useNow(intervalMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return Date.now();
}

export function getBackend(): Backend | null {
  return backend;
}

// ───────────────────────── 路由 ─────────────────────────

function hashFor(r: Route): string {
  if (r.page === 'compose' && r.editId) return `#edit-${r.editId}`;
  return r.page === 'dashboard' ? '#dashboard' : `#${r.page}`;
}

export function navigate(page: Page, extra: Omit<Route, 'page'> = {}) {
  const route: Route = { page, ...extra };
  setState({ route, detailId: null });
  try {
    const h = hashFor(route);
    if (location.hash !== h) history.pushState(null, '', h);
  } catch {
    /* 某些內嵌環境不允許修改網址 */
  }
  try {
    window.scrollTo({ top: 0 });
  } catch {
    /* 忽略 */
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => setState({ route: routeFromHash(), detailId: null }));
}

// ───────────────────────── 提示訊息 ─────────────────────────

let toastSeq = 0;
export function toast(kind: Toast['kind'], text: string, action?: Toast['action']) {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, action }] }));
  setTimeout(() => dismissToast(id), kind === 'error' ? 8000 : 4500);
}

export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function openDetail(id: string | null) {
  setState({ detailId: id });
}

// ───────────────────────── 啟動與連線 ─────────────────────────

export function updateConfig(patch: Partial<DeviceConfig>) {
  const config = { ...state.config, ...patch };
  saveConfig(config);
  setState({ config });
  applyTheme(config.theme);
}

export function applyTheme(theme: DeviceConfig['theme']) {
  try {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  } catch {
    /* 忽略 */
  }
}

export async function boot() {
  applyTheme(state.config.theme);
  let hash = '';
  try {
    hash = location.hash;
  } catch {
    /* 忽略 */
  }
  const offer = !DEMO_ONLY ? parseDeviceLink(hash) : null;
  if (offer) {
    setState({ phase: 'link', linkOffer: offer });
    return;
  }
  const cfg = state.config;
  if (DEMO_ONLY || cfg.mode === 'demo') return startDemo();
  if (cfg.mode === 'github' && cfg.token && cfg.syncKey) return connectGitHub();
  setState({ phase: 'welcome' });
}

export async function acceptLink() {
  const offer = state.linkOffer;
  if (!offer) return;
  updateConfig({ ...offer, mode: 'github' });
  try {
    history.replaceState(null, '', location.pathname + '#dashboard');
  } catch {
    /* 忽略 */
  }
  setState({ linkOffer: undefined, route: { page: 'dashboard' } });
  await connectGitHub();
}

export function rejectLink() {
  try {
    history.replaceState(null, '', location.pathname + '#dashboard');
  } catch {
    /* 忽略 */
  }
  setState({ linkOffer: undefined, phase: 'welcome' });
  void boot();
}

export async function startDemo() {
  updateConfig({ mode: 'demo' });
  backend = new DemoBackend();
  setState({ phase: 'ready', error: undefined });
  await refresh();
  startLoops();
}

export function resetDemo() {
  if (backend instanceof DemoBackend) {
    backend.reset();
    void refresh();
    toast('ok', '已重設範例資料');
  }
}

export function demoSeededAt(): string | null {
  return backend instanceof DemoBackend ? backend.seededAt : null;
}

export function beginSetup() {
  setState({ phase: 'setup' });
}

export function backToWelcome() {
  setState({ phase: 'welcome' });
}

export async function connectGitHub() {
  setState({ phase: 'boot', error: undefined });
  try {
    backend = await GitHubBackend.connect(state.config);
    const snap = await backend.load();
    setState({
      phase: 'ready',
      channels: snap.channels,
      settings: snap.settings,
      posts: snap.posts,
      skipped: snap.skipped,
      sync: { state: 'idle', at: Date.now() },
    });
    startLoops();
    void refreshScheduler();
  } catch (err) {
    backend = null;
    setState({ phase: 'error', error: describeBootError(err) });
  }
}

function describeBootError(err: unknown): AppState['error'] {
  if (err instanceof KeyMismatchError)
    return { title: '同步金鑰不正確', detail: '這組金鑰解不開資料。請確認是不是從其他裝置複製錯了，或重新用「連結裝置」功能設定。', kind: 'key' };
  if (err instanceof NotInitializedError)
    return { title: '還沒有建立資料空間', detail: err.message, kind: 'branch' };
  if (err instanceof GitHubError && (err.status === 401 || err.status === 403))
    return { title: 'GitHub Token 無法使用', detail: err.message, kind: 'token' };
  if (err instanceof GitHubError && err.status === 0) return { title: '連不上 GitHub', detail: err.message, kind: 'network' };
  return { title: '載入失敗', detail: (err as Error).message ?? String(err) };
}

export async function disconnect() {
  stopLoops();
  backend = null;
  clearConfig();
  await IdbBlobCache.clear();
  try {
    localStorage.removeItem('tnda-relay:demo');
  } catch {
    /* 忽略 */
  }
  const fresh = loadConfig();
  setState({ config: fresh, phase: 'welcome', posts: [], channels: [], settings: { ...DEFAULT_SETTINGS }, error: undefined });
}

export async function refresh(silent = false) {
  if (!backend) return;
  if (!silent) setState((s) => ({ sync: { ...s.sync, state: 'syncing' } }));
  try {
    const snap = await backend.load();
    setState({ channels: snap.channels, settings: snap.settings, posts: snap.posts, skipped: snap.skipped, sync: { state: 'idle', at: Date.now() } });
  } catch (err) {
    setState((s) => ({ sync: { ...s.sync, state: 'error', error: (err as Error).message } }));
    if (!silent) toast('error', `同步失敗：${(err as Error).message}`);
  }
}

export async function refreshScheduler() {
  if (!backend) return;
  try {
    const runs = await backend.schedulerRuns();
    setState({ scheduler: { runs, at: Date.now() } });
  } catch (err) {
    setState({ scheduler: { runs: [], at: Date.now(), error: (err as Error).message } });
  }
}

export async function runSchedulerNow() {
  if (!backend) return;
  if (backend.kind === 'demo') {
    await precisionTick();
    toast('ok', 'Demo：已檢查並發送所有到期的貼文');
    return;
  }
  try {
    await backend.runScheduler();
    toast('ok', '已請排程器立即執行，約 30 秒後會開始處理。');
    setTimeout(() => void refreshScheduler(), 8000);
  } catch (err) {
    toast('error', `無法啟動排程器：${(err as Error).message}`);
  }
}

let timers: ReturnType<typeof setInterval>[] = [];

function startLoops() {
  stopLoops();
  // 準時代發：每 10 秒檢查有沒有到期的貼文
  timers.push(setInterval(() => void precisionTick(), 10000));
  setTimeout(() => void precisionTick(), 1500);
  if (backend?.kind === 'github') {
    timers.push(
      setInterval(() => {
        if (document.visibilityState === 'visible') void refresh(true);
      }, 60000),
    );
    timers.push(setInterval(() => void refreshScheduler(), 120000));
    window.addEventListener('focus', onFocus);
  } else {
    void refreshScheduler();
  }
}

function onFocus() {
  void refresh(true);
}

function stopLoops() {
  timers.forEach(clearInterval);
  timers = [];
  if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
}

// ───────────────────────── 發送 ─────────────────────────

function actor() {
  return `browser:${state.config.deviceId}`;
}

function deliverContext() {
  return {
    channels: channelMap(state.channels),
    settings: state.settings,
    send: (url: string, payload: Post['payload']) => backend!.send(url, payload),
  };
}

function upsertLocal(posts: Post[]) {
  setState((s) => {
    const map = new Map(s.posts.map((p) => [p.id, p]));
    for (const p of posts) map.set(p.id, p);
    return { posts: [...map.values()] };
  });
}

function removeLocal(id: string) {
  setState((s) => ({ posts: s.posts.filter((p) => p.id !== id) }));
}

async function runSend(id: string, opts: { force?: boolean; onlyChannels?: string[] } = {}) {
  if (!backend || state.sending[id]) return null;
  setState((s) => ({ sending: { ...s.sending, [id]: true } }));
  try {
    const outcome = await sendPost(backend, id, actor(), deliverContext(), opts);
    if (outcome) {
      upsertLocal([outcome.post, ...(outcome.next ? [outcome.next] : [])]);
      // 瀏覽器發不出去的頻道已交還排程器：請排程器立刻跑一次
      const handedOff = outcome.post.channels.some((c) => deliveryOf(outcome.post, c).status === 'pending');
      if (handedOff) {
        // 這台裝置暫時連不到 Discord：30 分鐘內不再代發，全部交給排程器
        discordBlockedUntil = Date.now() + 30 * 60000;
        if (backend.kind === 'github') void backend.runScheduler().catch(() => {});
      }
    }
    return outcome;
  } finally {
    setState((s) => {
      const sending = { ...s.sending };
      delete sending[id];
      return { sending };
    });
  }
}

let discordBlockedUntil = 0;

async function precisionTick() {
  if (!backend || state.phase !== 'ready' || Date.now() < discordBlockedUntil) return;
  if (backend.kind === 'github' && !state.config.precision) return;
  const now = Date.now();
  const due = state.posts.filter((p) => isDue(p, now) && !state.sending[p.id]);
  for (const p of due) {
    try {
      const outcome = await runSend(p.id);
      if (outcome) reportOutcome(outcome.post, true);
    } catch (err) {
      console.warn('準時代發失敗', err);
    }
  }
}

function reportOutcome(post: Post, auto = false) {
  const prefix = auto ? '已準時發送' : '已發送';
  if (post.status === 'sent') toast('ok', `${prefix}「${post.title}」到 ${post.channels.length} 個頻道`);
  else if (post.status === 'partial') toast('error', `「${post.title}」有部分頻道發送失敗`, { label: '查看', run: () => openDetail(post.id) });
  else if (post.status === 'failed') toast('error', `「${post.title}」發送失敗`, { label: '查看', run: () => openDetail(post.id) });
  else if (post.status === 'scheduled') {
    const handedOff = post.channels.some((c) => deliveryOf(post, c).status === 'pending');
    toast('info', handedOff ? `「${post.title}」已交給排程器，約 1 分鐘內送出` : `「${post.title}」暫時無法發送，系統稍後會自動重試`);
  }
}

// ───────────────────────── 貼文操作 ─────────────────────────

export interface SchedulePlan {
  draft: ComposeDraft;
  channels: string[];
  /** 每個時間會建立一則貼文 */
  times: Array<{ at: string; label?: string }>;
  repeat?: Repeat | null;
  mode: 'schedule' | 'now' | 'draft';
}

export function buildPost(draft: ComposeDraft, channels: string[], sendAt: string, extra: Partial<Post> = {}): Post {
  const now = new Date().toISOString();
  return {
    id: randomId('p'),
    title: draft.title.trim() || TYPE_META[draft.type].label,
    type: draft.type,
    channels,
    sendAt,
    status: 'scheduled',
    payload: composePayload(draft, state.settings),
    draft,
    repeat: null,
    deliveries: {},
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

export async function submitPlan(plan: SchedulePlan): Promise<boolean> {
  if (!backend) return false;
  const payload = composePayload(plan.draft, state.settings);
  const errors = validatePayload(payload);
  if (errors.length && plan.mode !== 'draft') {
    toast('error', errors[0]);
    return false;
  }
  if (plan.mode !== 'draft' && plan.channels.length === 0) {
    toast('error', '請至少選擇一個頻道');
    return false;
  }
  const series = plan.times.length > 1 ? randomId('s') : undefined;
  const times = plan.mode === 'now' ? [{ at: new Date().toISOString() }] : plan.times;
  const posts = times.map((t) =>
    buildPost(plan.draft, plan.channels, t.at, {
      status: plan.mode === 'draft' ? 'draft' : 'scheduled',
      series,
      seriesLabel: t.label,
      repeat: plan.mode === 'schedule' && times.length === 1 ? plan.repeat ?? null : null,
    }),
  );
  try {
    for (const p of posts) await backend.createPost(p);
    upsertLocal(posts);
    setState({ highlight: posts.map((p) => p.id) });
  } catch (err) {
    toast('error', `儲存失敗：${(err as Error).message}`);
    return false;
  }
  if (plan.mode === 'now') {
    const outcome = await runSend(posts[0].id, { force: true });
    if (outcome) reportOutcome(outcome.post);
    navigate('history');
    openDetail(posts[0].id);
  } else if (plan.mode === 'draft') {
    toast('ok', '已存成草稿');
    navigate('queue');
  } else {
    toast('ok', posts.length > 1 ? `已建立 ${posts.length} 則排程（提醒鏈）` : '已排程，時間到會自動發送');
    navigate('queue');
  }
  return true;
}

/** 批次匯入：依序建立貼文；中途失敗時保留已建立的，並回報建立了幾則 */
export async function importPosts(posts: Post[], onProgress: (done: number) => void): Promise<{ created: number; error?: string }> {
  if (!backend) return { created: 0, error: '尚未連線' };
  const created: Post[] = [];
  let error: string | undefined;
  for (const p of posts) {
    try {
      await backend.createPost(p);
      created.push(p);
      onProgress(created.length);
    } catch (err) {
      error = (err as Error).message;
      break;
    }
  }
  if (created.length) {
    upsertLocal(created);
    setState({ highlight: created.map((p) => p.id) });
  }
  return { created: created.length, error };
}

/** 更新尚未發送的貼文 */
export async function updatePlan(id: string, plan: SchedulePlan): Promise<boolean> {
  if (!backend) return false;
  const payload = composePayload(plan.draft, state.settings);
  const errors = validatePayload(payload);
  if (errors.length && plan.mode !== 'draft') {
    toast('error', errors[0]);
    return false;
  }
  try {
    const next = await backend.updatePost(id, (latest) => {
      if (!['scheduled', 'draft', 'failed', 'canceled'].includes(latest.status) || latest.status === 'sending') return null;
      const sendAt = plan.mode === 'now' ? new Date().toISOString() : plan.times[0]?.at ?? latest.sendAt;
      return {
        ...latest,
        title: plan.draft.title.trim() || TYPE_META[plan.draft.type].label,
        type: plan.draft.type,
        channels: plan.channels,
        sendAt,
        draft: plan.draft,
        payload,
        status: plan.mode === 'draft' ? 'draft' : 'scheduled',
        repeat: plan.repeat ?? null,
        deliveries: Object.fromEntries(Object.entries(latest.deliveries).filter(([ch, d]) => plan.channels.includes(ch) && d.status === 'sent')),
        updatedAt: new Date().toISOString(),
      };
    });
    if (!next) {
      toast('error', '這則貼文已經發送或正在發送，無法修改。');
      await refresh(true);
      return false;
    }
    upsertLocal([next]);
    setState({ highlight: [id] });
    if (plan.mode === 'now') {
      const outcome = await runSend(id, { force: true });
      if (outcome) reportOutcome(outcome.post);
      navigate('history');
      openDetail(id);
    } else {
      toast('ok', '已更新');
      navigate('queue');
    }
    return true;
  } catch (err) {
    toast('error', `更新失敗：${(err as Error).message}`);
    return false;
  }
}

async function mutate(id: string, fn: (p: Post) => Post | null, okText?: string): Promise<Post | null> {
  if (!backend) return null;
  try {
    const next = await backend.updatePost(id, fn);
    if (next) {
      upsertLocal([next]);
      if (okText) toast('ok', okText);
    } else {
      toast('error', '狀態已改變，請重新整理後再試。');
      await refresh(true);
    }
    return next;
  } catch (err) {
    toast('error', (err as Error).message);
    return null;
  }
}

export function cancelPost(id: string) {
  return mutate(
    id,
    (p) => (p.status === 'scheduled' || p.status === 'draft' ? { ...p, status: 'canceled', updatedAt: new Date().toISOString() } : null),
    '已取消排程',
  );
}

export function restorePost(id: string) {
  return mutate(
    id,
    (p) => {
      if (p.status !== 'canceled') return null;
      const sendAt = Date.parse(p.sendAt) < Date.now() ? new Date(Date.now() + 10 * 60000).toISOString() : p.sendAt;
      return { ...p, status: 'scheduled', sendAt, updatedAt: new Date().toISOString() };
    },
    '已恢復排程',
  );
}

export function reschedule(id: string, sendAt: string) {
  return mutate(
    id,
    (p) => (p.status === 'scheduled' || p.status === 'draft' ? { ...p, sendAt, updatedAt: new Date().toISOString() } : null),
    '已改期',
  );
}

export function promoteDraft(id: string, sendAt?: string) {
  return mutate(
    id,
    (p) => (p.status === 'draft' ? { ...p, status: 'scheduled', sendAt: sendAt ?? p.sendAt, updatedAt: new Date().toISOString() } : null),
    '已加入排程',
  );
}

export async function deletePost(id: string) {
  if (!backend) return;
  try {
    await backend.deletePost(id);
    removeLocal(id);
    setState({ detailId: null });
    toast('ok', '已刪除紀錄');
  } catch (err) {
    toast('error', (err as Error).message);
  }
}

export async function sendNow(id: string) {
  const p = await mutate(id, (latest) =>
    latest.status === 'scheduled' || latest.status === 'draft' ? { ...latest, status: 'scheduled', sendAt: new Date().toISOString(), updatedAt: new Date().toISOString() } : null,
  );
  if (!p) return;
  const outcome = await runSend(id, { force: true });
  if (outcome) reportOutcome(outcome.post);
}

/** 重送失敗的頻道 */
export async function retryFailed(id: string) {
  const p = await mutate(id, (latest) => {
    const deliveries = { ...latest.deliveries };
    let changed = false;
    for (const ch of latest.channels) {
      const d = deliveryOf(latest, ch);
      if (d.status === 'failed') {
        deliveries[ch] = { ...d, status: 'pending', error: undefined, retryable: undefined };
        changed = true;
      }
    }
    if (!changed) return null;
    return { ...latest, deliveries, status: 'scheduled', updatedAt: new Date().toISOString() };
  });
  if (!p) return;
  const outcome = await runSend(id, { force: true });
  if (outcome) reportOutcome(outcome.post);
}

/** 狀態不明時，使用者到 Discord 確認後手動標記 */
export function markDelivered(id: string, channelId: string) {
  return mutate(
    id,
    (p) => {
      const d = deliveryOf(p, channelId);
      if (d.status !== 'failed') return null;
      const deliveries = { ...p.deliveries, [channelId]: { ...d, status: 'sent' as const, error: undefined, sentAt: d.claimedAt ?? new Date().toISOString() } };
      const next = { ...p, deliveries, updatedAt: new Date().toISOString() };
      next.status = computeStatus({ ...next, status: 'scheduled' });
      if (!next.sentAt) next.sentAt = new Date().toISOString();
      return next;
    },
    '已標記為已送出',
  );
}

/** 從 Discord 撤回已發送的訊息 */
export async function recallPost(id: string) {
  if (!backend) return;
  const post = state.posts.find((p) => p.id === id);
  if (!post) return;
  const channels = channelMap(state.channels);
  const results: Record<string, string | null> = {};
  for (const ch of post.channels) {
    const d = deliveryOf(post, ch);
    const url = channels.get(ch)?.webhook;
    if (d.status !== 'sent' || !d.messageId || d.deletedAt || !url) continue;
    const r = await backend.deleteMessage(url, d.messageId);
    results[ch] = r.ok ? null : r.error ?? '撤回失敗';
  }
  const failed = Object.values(results).filter(Boolean);
  const at = new Date().toISOString();
  await mutate(id, (p) => {
    const deliveries = { ...p.deliveries };
    for (const [ch, err] of Object.entries(results)) if (!err) deliveries[ch] = { ...deliveries[ch], deletedAt: at };
    return { ...p, deliveries, updatedAt: at };
  });
  if (Object.keys(results).length === 0) toast('info', '沒有可以撤回的訊息');
  else if (failed.length) toast('error', `有 ${failed.length} 個頻道撤回失敗：${failed[0]}`);
  else toast('ok', '已從 Discord 撤回訊息');
}

/** 修改已發送的訊息內容（Discord 上會顯示「已編輯」） */
export async function editSentPost(id: string, draft: ComposeDraft): Promise<boolean> {
  if (!backend) return false;
  const post = state.posts.find((p) => p.id === id);
  if (!post) return false;
  const payload = composePayload(draft, state.settings);
  const errors = validatePayload(payload);
  if (errors.length) {
    toast('error', errors[0]);
    return false;
  }
  const channels = channelMap(state.channels);
  const edited: string[] = [];
  let firstError = '';
  for (const ch of post.channels) {
    const d = deliveryOf(post, ch);
    const url = channels.get(ch)?.webhook;
    if (d.status !== 'sent' || !d.messageId || d.deletedAt || !url) continue;
    const r = await backend.editMessage(url, d.messageId, payload);
    if (r.ok) edited.push(ch);
    else firstError ||= r.error ?? '更新失敗';
  }
  const at = new Date().toISOString();
  await mutate(id, (p) => {
    const deliveries = { ...p.deliveries };
    for (const ch of edited) deliveries[ch] = { ...deliveries[ch], editedAt: at };
    return { ...p, draft, payload, title: draft.title.trim() || TYPE_META[draft.type].label, type: draft.type, deliveries, updatedAt: at };
  });
  if (firstError) toast('error', `部分頻道更新失敗：${firstError}`);
  else toast('ok', `已更新 Discord 上的 ${edited.length} 則訊息`);
  navigate('history');
  openDetail(id);
  return !firstError;
}

// ───────────────────────── 頻道與設定 ─────────────────────────

export async function saveChannels(channels: Channel[], okText = '已儲存頻道設定') {
  if (!backend) return false;
  try {
    await backend.saveChannels(channels);
    setState({ channels });
    toast('ok', okText);
    return true;
  } catch (err) {
    toast('error', `儲存失敗：${(err as Error).message}`);
    return false;
  }
}

export async function saveSettings(settings: Settings) {
  if (!backend) return false;
  try {
    await backend.saveSettings(settings);
    setState({ settings });
    toast('ok', '已儲存發送設定');
    return true;
  } catch (err) {
    toast('error', `儲存失敗：${(err as Error).message}`);
    return false;
  }
}

export async function testChannel(channelId: string): Promise<boolean> {
  const ch = state.channels.find((c) => c.id === channelId);
  if (!backend || !ch?.webhook) {
    toast('error', '這個頻道還沒有設定 Webhook');
    return false;
  }
  const r = await backend.send(ch.webhook, {
    username: state.settings.senderName || undefined,
    avatar_url: state.settings.avatarUrl || undefined,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: '✅ 連線測試',
        description: `TNDA Relay 已成功連上「${ch.groupName}／${ch.name}」。\n之後排程的公告會從這裡發出。`,
        color: 0x2fb36d,
        footer: { text: state.settings.footer || 'TNDA Relay' },
      },
    ],
  });
  if (r.ok) toast('ok', `已送出測試訊息到「${ch.name}」`);
  else toast('error', r.error ?? '測試失敗');
  return r.ok;
}

export async function verifyChannel(channelId: string): Promise<string | null> {
  const ch = state.channels.find((c) => c.id === channelId);
  if (!backend || !ch?.webhook) return null;
  try {
    const info = await backend.webhookInfo(ch.webhook);
    return info.name;
  } catch (err) {
    toast('error', (err as Error).message);
    return null;
  }
}

export function clearHighlight() {
  if (state.highlight.length) setState({ highlight: [] });
}
