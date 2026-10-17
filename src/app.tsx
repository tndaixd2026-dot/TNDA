import { Fragment } from 'preact';
import { useEffect } from 'preact/hooks';
import { boot, navigate, refresh, useApp, useNow, dismissToast, type Page } from './data/store.ts';
import { fmtRelative } from './core/time.ts';
import { BrandMark, Icon, type IconName } from './ui/icons.tsx';
import { ConfirmHost } from './ui/kit.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Compose } from './pages/Compose.tsx';
import { Queue } from './pages/Queue.tsx';
import { History } from './pages/History.tsx';
import { CalendarPage } from './pages/Calendar.tsx';
import { Channels } from './pages/Channels.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { About } from './pages/About.tsx';
import { ImportPage } from './pages/Import.tsx';
import { PostDetail } from './pages/PostDetail.tsx';
import { Welcome, LinkConfirm, ErrorScreen, Loader } from './pages/Welcome.tsx';
import { Setup } from './pages/Setup.tsx';
import { DEMO_ONLY } from './data/config.ts';

const NAV: Array<{ page: Page; label: string; icon: IconName }> = [
  { page: 'dashboard', label: '總覽', icon: 'home' },
  { page: 'queue', label: '發送排程', icon: 'clock' },
  { page: 'history', label: '發文紀錄', icon: 'list' },
  { page: 'calendar', label: '行事曆', icon: 'calendar' },
  { page: 'channels', label: '頻道', icon: 'hash' },
  { page: 'settings', label: '設定', icon: 'sliders' },
];

function SyncStatus() {
  useNow(30000);
  const { sync, mode } = useApp((s) => ({ sync: s.sync, mode: s.config.mode }));
  if (mode === 'demo') {
    return (
      <span class="pill pill-warn" title="資料只存在這個瀏覽器">
        <span class="dot" />
        Demo 模式
      </span>
    );
  }
  const busy = sync.state === 'syncing';
  return (
    <button
      type="button"
      class={`pill ${sync.state === 'error' ? 'pill-bad' : 'pill-ok'}`}
      style={{ border: 0, cursor: 'pointer' }}
      onClick={() => void refresh()}
      title="立即同步"
    >
      {busy ? <Icon name="loader" class="spin" style={{ width: 13, height: 13 }} /> : <span class="dot" />}
      {busy ? '同步中' : sync.state === 'error' ? '同步失敗' : sync.at ? `已同步 · ${fmtRelative(sync.at)}` : '已連線'}
    </button>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'info' ? 'info' : 'check'} />
          <span class="t-text">{t.text}</span>
          {t.action ? (
            <button
              type="button"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button type="button" aria-label="關閉" onClick={() => dismissToast(t.id)}>
            <Icon name="x" style={{ width: 15, height: 15 }} />
          </button>
        </div>
      ))}
    </div>
  );
}

function DemoBanner() {
  return (
    <div class="demo-banner">
      <Icon name="info" />
      <span class="db-text">
        <strong>Demo 模式</strong>：資料只存在這個瀏覽器，「發送」是模擬的，不會真的送到 Discord。
      </span>
      {DEMO_ONLY ? (
        <button type="button" class="btn btn-sm" onClick={() => navigate('about')}>
          了解正式版
        </button>
      ) : (
        <button type="button" class="btn btn-sm" onClick={() => navigate('settings')}>
          連接 GitHub 正式使用
        </button>
      )}
    </div>
  );
}

function Shell() {
  const { route, detailId, counts, mode } = useApp((s) => ({
    mode: s.config.mode,
    route: s.route,
    detailId: s.detailId,
    counts: {
      queue: s.posts.filter((p) => p.status === 'scheduled' || p.status === 'sending' || p.status === 'draft').length,
      failed: s.posts.filter((p) => p.status === 'failed' || p.status === 'partial').length,
    },
  }));
  const page = route.page;
  const go = (p: Page) => (e: Event) => {
    e.preventDefault();
    navigate(p);
  };

  return (
    <div class="shell">
      <nav class="sidebar" aria-label="主要選單">
        <a class="brand" href="#dashboard" onClick={go('dashboard')}>
          <BrandMark />
          <span>
            <div class="brand-name">課務發報台</div>
            <div class="brand-sub">TNDA RELAY</div>
          </span>
        </a>
        <button type="button" class="btn btn-primary nav-compose" onClick={() => navigate('compose')}>
          <Icon name="pen" />
          撰寫新貼文
        </button>
        {NAV.map((n, i) => (
          <Fragment key={n.page}>
            {i === 4 ? <div class="nav-sep" /> : null}
            <a class="nav-item" href={`#${n.page}`} aria-current={page === n.page ? 'page' : undefined} onClick={go(n.page)}>
              <Icon name={n.icon} />
              {n.label}
              {n.page === 'queue' && counts.queue ? <span class="count">{counts.queue}</span> : null}
              {n.page === 'history' && counts.failed ? (
                <span class="count alert" title="需要處理">
                  {counts.failed}
                </span>
              ) : null}
            </a>
          </Fragment>
        ))}
        <div class="sidebar-foot">
          <a class="nav-item" href="#about" aria-current={page === 'about' ? 'page' : undefined} onClick={go('about')}>
            <Icon name="info" />
            關於這個平台
          </a>
          <div style={{ padding: '0 8px' }}>
            <SyncStatus />
          </div>
        </div>
      </nav>

      <header class="topbar">
        <a class="brand" href="#dashboard" onClick={go('dashboard')}>
          <BrandMark />
          <span class="brand-name">課務發報台</span>
        </a>
        <span class="spacer" />
        <SyncStatus />
        <button type="button" class="btn btn-ghost btn-icon" aria-label="頻道" onClick={() => navigate('channels')}>
          <Icon name="hash" />
        </button>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="設定" onClick={() => navigate('settings')}>
          <Icon name="sliders" />
        </button>
      </header>

      <main class="main" id="main">
        {mode === 'demo' && page !== 'about' ? <DemoBanner /> : null}
        {page === 'dashboard' && <Dashboard />}
        {page === 'compose' && <Compose key={`${route.editId ?? ''}${route.cloneId ?? ''}${route.presetAt ?? ''}`} />}
        {page === 'queue' && <Queue />}
        {page === 'history' && <History />}
        {page === 'calendar' && <CalendarPage />}
        {page === 'channels' && <Channels />}
        {page === 'settings' && <SettingsPage />}
        {page === 'about' && <About />}
        {page === 'import' && <ImportPage />}
      </main>

      <nav class="tabbar" aria-label="分頁">
        {(
          [
            ['dashboard', '總覽', 'home'],
            ['queue', '排程', 'clock'],
            ['compose', '撰寫', 'plus'],
            ['history', '紀錄', 'list'],
            ['calendar', '行事曆', 'calendar'],
          ] as Array<[Page, string, IconName]>
        ).map(([p, label, icon]) => (
          <button
            key={p}
            type="button"
            class={`tab ${p === 'compose' ? 'tab-compose' : ''}`}
            aria-current={page === p ? 'page' : undefined}
            onClick={() => navigate(p)}
          >
            {p === 'compose' ? (
              <span class="tab-bubble">
                <Icon name="plus" />
              </span>
            ) : (
              <Icon name={icon} />
            )}
            {label}
          </button>
        ))}
      </nav>

      {detailId ? <PostDetail id={detailId} /> : null}
    </div>
  );
}

export function App() {
  const phase = useApp((s) => s.phase);
  useEffect(() => {
    void boot();
  }, []);
  return (
    <>
      {phase === 'boot' && <Loader />}
      {phase === 'welcome' && <Welcome />}
      {phase === 'setup' && <Setup />}
      {phase === 'link' && <LinkConfirm />}
      {phase === 'error' && <ErrorScreen />}
      {phase === 'ready' && <Shell />}
      <Toasts />
      <ConfirmHost />
    </>
  );
}
