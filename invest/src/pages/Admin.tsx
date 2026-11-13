// 管理員：切換場次、開盤／暗盤／封盤、看誰還沒投完、匯入名單、重置（彩排用）。
import { useEffect, useRef, useState } from 'preact/hooks';
import { countdown, wan } from '../../shared/format.ts';
import { COURSE_CSV_LABEL, rosterToCsv, splitGroupLabel } from '../../shared/roster.ts';
import {
  COURSE_IDS,
  courseLabel,
  type AdminOverview,
  type CourseId,
  type PublicCourse,
  type RosterPreview,
} from '../../shared/types.ts';
import { ApiError, adminHeaders, api, storageGet, storageSet, useLive, useNow } from '../api.ts';
import { Card, ConnectionDot, PhaseBadge, useToast } from '../ui/common.tsx';

const PW_KEY = 'invest.admin';

export function Admin() {
  const [pw, setPw] = useState<string | null>(() => storageGet(PW_KEY));
  if (!pw) {
    return (
      <AdminLogin
        onOk={(p) => {
          storageSet(PW_KEY, p);
          setPw(p);
        }}
      />
    );
  }
  return (
    <AdminPanel
      pw={pw}
      onLogout={() => {
        storageSet(PW_KEY, null);
        setPw(null);
      }}
    />
  );
}

function AdminLogin({ onOk }: { onOk: (pw: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  async function submit(e: Event) {
    e.preventDefault();
    try {
      await api('/api/admin/check', { body: {}, admin: value });
      onOk(value);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div class="admin">
      <form class="card login-card" onSubmit={submit}>
        <h1 class="card-title">管理員登入</h1>
        <input
          class="text-input"
          type="password"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder="管理員密碼"
          autocomplete="current-password"
          autoFocus
        />
        {error && <p class="form-error">{error}</p>}
        <button class="btn btn-primary btn-block" type="submit" disabled={!value}>
          登入
        </button>
      </form>
    </div>
  );
}

async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AdminPanel({ pw, onLogout }: { pw: string; onLogout: () => void }) {
  const live = useLive({});
  const now = useNow(live.offset, 250);
  const toast = useToast();
  const [ov, setOv] = useState<AdminOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh() {
    try {
      setOv(await api<AdminOverview>('/api/admin/overview', { admin: pw }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onLogout();
    }
  }

  // 公開狀態一變就（節流後）重新抓管理員資料
  useEffect(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, ov ? 1000 : 0);
  }, [live.pub]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  async function act(path: string, body: unknown, done?: string) {
    setBusy(true);
    try {
      setOv(await api<AdminOverview>(path, { body, admin: pw }));
      if (done) toast.show(done);
    } catch (err) {
      toast.show((err as Error).message, 'error');
      if (err instanceof ApiError && err.status === 401) onLogout();
    } finally {
      setBusy(false);
    }
  }

  if (!live.pub || !ov) {
    return (
      <div class="admin">
        <div class="loading">載入中…</div>
      </div>
    );
  }

  const pub = live.pub;
  const course = pub.active;
  const pc = pub.courses[course];
  const darkMin = Math.round(pub.darkMs / 60_000);
  const darkLabel = pub.darkMs % 60_000 === 0 ? `${darkMin} 分鐘` : `${Math.round(pub.darkMs / 1000)} 秒`;

  function switchCourse(c: CourseId) {
    if (c === course) return;
    const cur = pub.courses[course];
    if ((cur.phase === 'open' || cur.phase === 'dark') && !confirm(`${courseLabel(course)}還在進行中，切換後學生端與大螢幕都會改顯示${courseLabel(c)}。確定切換？`)) return;
    void act('/api/admin/active', { course: c }, `已切換到${courseLabel(c)}`);
  }

  const reopenTo = ov.courses[course].reopenTo;
  const reopenLeft = ov.courses[course].reopenDarkLeftMs;
  const reopenLabel = reopenTo === 'dark' && reopenLeft ? `暗盤（剩 ${countdown(reopenLeft)}）` : '開盤中';

  function phase(action: 'open' | 'dark' | 'close' | 'reopen') {
    const msg = {
      open: `${courseLabel(course)}開盤？開盤後學生就能開始投資。`,
      dark: `進入暗盤？${darkLabel}後自動封盤，期間大螢幕與學生端都會隱藏各組金額與排名。`,
      close: `立即封盤並揭曉${courseLabel(course)}的結果？封盤後無法再投資。`,
      reopen: `取消封盤？已揭曉的結果會撤回，回到「${reopenLabel}」，所有人的投資都保留。`,
    }[action];
    if (!confirm(msg)) return;
    void act(
      '/api/admin/phase',
      { course, action },
      { open: '已開盤', dark: '已進入暗盤', close: '已封盤，結果已揭曉', reopen: `已取消封盤，回到${reopenLabel}` }[action],
    );
  }

  function reset() {
    const typed = prompt(`重置${courseLabel(course)}會清除這一場所有投資、走勢與結果（名單保留），回到未開盤。\n確定請輸入「重置」：`);
    if (typed !== '重置') return;
    void act('/api/admin/reset', { course }, '已重置');
  }

  async function downloadResults() {
    try {
      const res = await fetch(`/api/admin/results.csv?course=${course}`, { headers: adminHeaders(pw) });
      if (!res.ok) throw new Error('下載失敗');
      await downloadBlob(await res.blob(), `投資結果-${COURSE_CSV_LABEL[course]}.csv`);
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
  }

  const students = ov.courses[course].students;
  const pending = students.filter((s) => s.remaining > 0).sort((a, b) => b.remaining - a.remaining || a.name.localeCompare(b.name, 'zh-Hant'));
  const notJoined = students.filter((s) => !s.joined);

  return (
    <div class="admin">
      <header class="admin-header">
        <h1>管理員</h1>
        <nav class="admin-links">
          <a href="/" target="_blank" rel="noreferrer">
            學生端 ↗
          </a>
          <a href="/screen" target="_blank" rel="noreferrer">
            大螢幕 ↗
          </a>
          <ConnectionDot connected={live.connected} />
          <button class="link-btn" onClick={onLogout}>
            登出
          </button>
        </nav>
      </header>

      <Card>
        <h2 class="card-title">目前場次</h2>
        <p class="muted">學生端與大螢幕會顯示這裡選的場次。</p>
        <div class="course-switch">
          {COURSE_IDS.map((c) => (
            <button key={c} class={`course-btn${c === course ? ' course-on' : ''}`} disabled={busy} onClick={() => switchCourse(c)} aria-pressed={c === course}>
              <span class="course-name">{courseLabel(c)}</span>
              <PhaseBadge phase={pub.courses[c].phase} />
              <span class="muted">
                {pub.courses[c].students} 人 · {pub.courses[c].groups.length} 組
              </span>
            </button>
          ))}
        </div>
      </Card>

      <Card class="control-card">
        <h2 class="card-title">盤況控制：{courseLabel(course)}</h2>
        <div class="control-status">
          <PhaseBadge phase={pc.phase} remainingMs={pc.darkEndsAt ? pc.darkEndsAt - now : undefined} />
          {pc.phase === 'dark' && pc.darkEndsAt && <span class="big-countdown">{countdown(pc.darkEndsAt - now)}</span>}
        </div>
        <div class="control-buttons">
          <button class="btn btn-primary btn-lg" disabled={busy || pc.phase !== 'pending'} onClick={() => phase('open')}>
            ▶ 開盤
          </button>
          <button class="btn btn-dark btn-lg" disabled={busy || pc.phase !== 'open'} onClick={() => phase('dark')}>
            ◐ 進入暗盤（{darkLabel}後自動封盤）
          </button>
          <button class="btn btn-danger btn-lg" disabled={busy || (pc.phase !== 'open' && pc.phase !== 'dark')} onClick={() => phase('close')}>
            ■ 立即封盤
          </button>
          <button class="btn btn-lg" disabled={busy || pc.phase !== 'closed'} onClick={() => phase('reopen')}>
            ↺ 取消封盤{pc.phase === 'closed' ? `（回到${reopenLabel}）` : ''}
          </button>
        </div>
        {pc.phase === 'closed' && (
          <div class="control-results">
            <ResultSummary pc={pc} />
            <button class="btn" onClick={downloadResults}>
              下載結果 CSV
            </button>
          </div>
        )}
      </Card>

      <Card>
        <h2 class="card-title">參與狀況</h2>
        <div class="stat-row">
          <div class="stat">
            <div class="stat-label">名單</div>
            <div class="stat-value">{students.length}</div>
          </div>
          <div class="stat">
            <div class="stat-label">已登入</div>
            <div class="stat-value">{students.length - notJoined.length}</div>
          </div>
          <div class="stat">
            <div class="stat-label">已投完</div>
            <div class="stat-value">{students.length - pending.length}</div>
          </div>
        </div>
        {pending.length > 0 && (
          <>
            <h3 class="sub-title">還沒投完（有登入的人封盤時會從自己組倒扣；沒登入過的不倒扣）</h3>
            <table class="data-table">
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>組別</th>
                  <th class="num">剩餘</th>
                  <th>登入</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td>{splitGroupLabel(s.group).short}</td>
                    <td class="num">{wan(s.remaining)} 萬</td>
                    <td>{s.joined ? '✔ 會倒扣' : <span class="muted">未登入・不倒扣</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <RosterCard ov={ov} pw={pw} onApplied={(next) => setOv(next)} notify={toast.show} />

      <Card class="danger-card">
        <h2 class="card-title">彩排工具</h2>
        <p class="muted">清除{courseLabel(course)}的所有投資、走勢與結果，回到「未開盤」。名單不受影響。</p>
        <button class="btn btn-danger" disabled={busy} onClick={reset}>
          重置{courseLabel(course)}資料
        </button>
      </Card>
      {toast.node}
    </div>
  );
}

function ResultSummary({ pc }: { pc: PublicCourse }) {
  const r = pc.results;
  if (!r) return null;
  const rocket = r.rocket.map((g) => splitGroupLabel(g).short).join('、');
  const gods = r.stockGods;
  return (
    <div class="result-summary">
      <div>
        🚀 一飛沖天獎：<strong>{rocket}</strong>
      </div>
      <div>
        🏆 股神獎：
        <strong>{gods.length ? gods.map((i) => `${i.name}（${wan(i.payout)} 萬）`).join('、') : '沒有人投資'}</strong>
      </div>
    </div>
  );
}

function RosterCard({
  ov,
  pw,
  onApplied,
  notify,
}: {
  ov: AdminOverview;
  pw: string;
  onApplied: (ov: AdminOverview) => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<RosterPreview | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    setCsv(await file.text());
    setPreview(null);
  }

  async function doPreview() {
    setBusy(true);
    try {
      setPreview(await api<RosterPreview>('/api/admin/roster/preview', { body: { csv }, admin: pw }));
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview?.ok) return;
    const label = preview.courses.map((c) => COURSE_CSV_LABEL[c]).join('、');
    if (!confirm(`用這份 CSV 取代${label}的名單？`)) return;
    setBusy(true);
    try {
      onApplied(await api<AdminOverview>('/api/admin/roster', { body: { csv }, admin: pw }));
      notify('名單已匯入');
      setCsv('');
      setPreview(null);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    void downloadBlob(new Blob(['﻿' + rosterToCsv(ov.roster)], { type: 'text/csv;charset=utf-8' }), '名單.csv');
  }

  return (
    <Card>
      <h2 class="card-title">名單</h2>
      <div class="roster-courses">
        {COURSE_IDS.map((c) => (
          <details key={c} class="roster-course">
            <summary>
              {courseLabel(c)}：{ov.courses[c].students.length} 人、{ov.courses[c].groups.length} 組
            </summary>
            {ov.courses[c].groups.map((g) => (
              <div key={g} class="roster-group">
                <strong>{g}</strong>
                <span>
                  {ov.courses[c].students
                    .filter((s) => s.group === g)
                    .map((s) => s.name)
                    .join('、')}
                </span>
              </div>
            ))}
          </details>
        ))}
      </div>
      <button class="btn" onClick={exportCsv}>
        下載目前名單 CSV
      </button>

      <h3 class="sub-title">匯入名單</h3>
      <p class="muted">
        格式：每行「姓名, 課堂, 組別」，課堂填 週三 或 週四。可以上傳 CSV 檔，或從試算表直接複製貼上。CSV 裡有出現的課堂才會被取代。
      </p>
      <input type="file" accept=".csv,text/csv,text/plain" onChange={loadFile} />
      <textarea
        class="text-area"
        rows={6}
        value={csv}
        placeholder={'姓名,課堂,組別\n王小明,週三,第1組\n王小明,週四,第3組'}
        onInput={(e) => {
          setCsv((e.target as HTMLTextAreaElement).value);
          setPreview(null);
        }}
      />
      <div class="btn-row">
        <button class="btn" disabled={busy || !csv.trim()} onClick={doPreview}>
          預覽
        </button>
        <button class="btn btn-primary" disabled={busy || !preview?.ok} onClick={apply}>
          確認匯入
        </button>
      </div>
      {preview && (
        <div class="preview">
          {preview.errors.length > 0 && (
            <ul class="form-error">
              {preview.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {preview.summary.map((s) => (
            <div key={s.course}>
              <strong>{courseLabel(s.course)}</strong>：{s.students} 人 ·{' '}
              {s.groups.map((g) => `${splitGroupLabel(g.group).short} ${g.count} 人`).join('、')}
            </div>
          ))}
          {preview.dropped.length > 0 && (
            <ul class="warn-list">
              {preview.dropped.map((d, i) => (
                <li key={i}>
                  ⚠️ {d.name}（{COURSE_CSV_LABEL[d.course]}）：{d.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
