// 管理員：大螢幕舞台控制（頒獎、業師總結）、各組作品、帳號、總結投影片
import { useEffect, useState } from 'preact/hooks';
import { splitGroupLabel } from '../../shared/roster.ts';
import { COURSE_IDS, courseLabel, type AdminOverview, type AdminSlide, type CourseId, type Role } from '../../shared/types.ts';
import { rpc } from '../api.ts';
import { Card, Eyebrow, pad2 } from '../ui/common.tsx';
import { imageToDataUrl } from '../ui/image.ts';
import { Cover } from '../ui/Showcase.tsx';

type Act = (fn: string, args: Record<string, unknown>, done?: string) => Promise<void>;
type Notify = (text: string, tone?: 'info' | 'error') => void;

const ROLE_LABEL: Record<Role, string> = { student: '學生', mentor: '業師／老師', guest: '來賓' };

// ---------- 舞台控制 ----------

export function StageCard({ ov, act, busy }: { ov: AdminOverview; act: Act; busy: boolean }) {
  const st = ov.stage;
  const labels = st.mode === 'awards' ? st.awardLabels : st.mode === 'summary' ? st.slideLabels : [];
  const closed = COURSE_IDS.filter((c) => ov.courses[c].phase === 'closed');

  // 簡報筆／鍵盤：→、PageDown、空白鍵＝下一步；←、PageUp＝上一步
  useEffect(() => {
    if (st.mode === 'market') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        void act('invest_admin_stage', { action: 'next' });
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        void act('invest_admin_stage', { action: 'prev' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [st.mode]);

  function startAwards() {
    const open = COURSE_IDS.filter((c) => ov.courses[c].phase !== 'closed');
    const warn = open.length
      ? `${open.map(courseLabel).join('、')}還沒封盤，頒獎只會包含已封盤的場次。\n`
      : '';
    if (!confirm(`${warn}開始頒獎？大螢幕會切到頒獎典禮開場，按「下一步」一步一步揭曉。`)) return;
    void act('invest_admin_stage', { action: 'awards' }, '大螢幕：頒獎典禮');
  }

  return (
    <Card class="stage-card">
      <Eyebrow>Stage · 大螢幕舞台</Eyebrow>
      <h2 class="card-title">
        大螢幕：{st.mode === 'market' ? '盤況畫面' : st.mode === 'awards' ? '頒獎典禮' : '業師總結'}
        {st.mode !== 'market' && (
          <span class="stage-now">
            {pad2(st.step + 1)} / {pad2(st.total)}　{labels[st.step]}
          </span>
        )}
      </h2>
      <div class="btn-row">
        <button class={`btn ${st.mode === 'market' ? 'btn-solid' : ''}`} disabled={busy} onClick={() => act('invest_admin_stage', { action: 'market' }, '大螢幕：盤況畫面')}>
          盤況畫面
        </button>
        <button class={`btn ${st.mode === 'awards' ? 'btn-solid' : 'btn-accent'}`} disabled={busy} onClick={startAwards}>
          {st.mode === 'awards' ? '從頭開始頒獎' : '開始頒獎'}
        </button>
        <button
          class={`btn ${st.mode === 'summary' ? 'btn-solid' : ''}`}
          disabled={busy}
          onClick={() => {
            if (confirm('切到業師總結？大螢幕會顯示第一頁總結投影片。')) void act('invest_admin_stage', { action: 'summary' }, '大螢幕：業師總結');
          }}
        >
          {st.mode === 'summary' ? '總結從第一頁開始' : '業師總結'}
        </button>
      </div>
      {st.mode !== 'market' && (
        <>
          <div class="stage-nav">
            <button class="btn btn-lg" disabled={busy || st.step === 0} onClick={() => act('invest_admin_stage', { action: 'prev' })}>
              ← 上一步
            </button>
            <button class="btn btn-lg btn-accent stage-next" disabled={busy || st.step >= st.total - 1} onClick={() => act('invest_admin_stage', { action: 'next' })}>
              下一步 →<small>{labels[st.step + 1] ?? '（已是最後）'}</small>
            </button>
          </div>
          <p class="muted">也可以用鍵盤或簡報筆：→／PageDown 下一步，←／PageUp 上一步。</p>
          <ol class="stage-steps">
            {labels.map((l, i) => (
              <li key={i} class={i === st.step ? 'on' : i < st.step ? 'done' : ''}>
                <button class="stage-step-btn" disabled={busy} onClick={() => act('invest_admin_stage', { action: 'goto', step: i })}>
                  <span class="rule-num">{pad2(i + 1)}</span>
                  {l}
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {st.mode === 'market' && (
        <p class="muted">
          封盤後各組金額與結果先不公開（大螢幕輪播各組作品、學生手機顯示「等待頒獎」）。兩場都封盤後按「開始頒獎」，揭曉到某一場的第 1 名時，該場結果才同步公開到學生手機。
          {closed.length > 0 && ` 已封盤：${closed.map(courseLabel).join('、')}。`}
        </p>
      )}
    </Card>
  );
}

// ---------- 各組作品：封面與 slogan ----------

export function GroupsCard({ ov, act, busy, notify }: { ov: AdminOverview; act: Act; busy: boolean; notify: Notify }) {
  const [course, setCourse] = useState<CourseId>(ov.active);
  const list = ov.groupInfo[course];
  return (
    <Card>
      <h2 class="card-title">
        <Eyebrow>Showcase · 各組作品</Eyebrow>
      </h2>
      <p class="muted">每組的作品封面照片與題目 slogan，會在暗盤倒數時輪播，頒獎時和組員名單一起顯示。照片會自動縮小（建議 16:9 橫式）。</p>
      <div class="btn-row">
        {COURSE_IDS.map((c) => (
          <button key={c} class={`seg${c === course ? ' seg-on' : ''}`} onClick={() => setCourse(c)}>
            {courseLabel(c)}
          </button>
        ))}
      </div>
      <div class="group-admin-list">
        {list.map((g, i) => (
          <GroupRow key={`${course}|${g.group}`} course={course} index={i} info={g} act={act} busy={busy} notify={notify} />
        ))}
        {list.length === 0 && <p class="muted">這一場還沒有名單。</p>}
      </div>
    </Card>
  );
}

function GroupRow({
  course,
  index,
  info,
  act,
  busy,
  notify,
}: {
  course: CourseId;
  index: number;
  info: { group: string; slogan: string; coverVer: number | null };
  act: Act;
  busy: boolean;
  notify: Notify;
}) {
  const [slogan, setSlogan] = useState(info.slogan);
  useEffect(() => setSlogan(info.slogan), [info.slogan]);
  const { short, nick } = splitGroupLabel(info.group);

  async function upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const cover = await imageToDataUrl(file);
      await act('invest_admin_group', { course, grp: info.group, cover }, `${short} 封面已更新`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <div class="group-admin">
      <div class="group-admin-cover">
        <Cover course={course} group={info.group} ver={info.coverVer} index={index} />
      </div>
      <div class="group-admin-body">
        <div class="group-admin-name">
          <strong>{short}</strong> {nick && <span class="muted">{nick}</span>}
        </div>
        <label class="field-label">題目／slogan</label>
        <div class="amount-editor-row">
          <input class="text-input" value={slogan} maxLength={200} placeholder="例如：讓每一次觸碰都被看見" onInput={(e) => setSlogan((e.target as HTMLInputElement).value)} />
          <button class="btn btn-primary" disabled={busy || slogan === info.slogan} onClick={() => act('invest_admin_group', { course, grp: info.group, slogan }, `${short} slogan 已儲存`)}>
            儲存
          </button>
        </div>
        <div class="btn-row">
          <label class="btn file-btn">
            {info.coverVer === null ? '上傳封面照片' : '更換封面照片'}
            <input type="file" accept="image/*" onChange={upload} />
          </label>
          {info.coverVer !== null && (
            <button
              class="btn btn-danger"
              disabled={busy}
              onClick={() => confirm(`刪除${short}的封面？`) && act('invest_admin_group', { course, grp: info.group, clear_cover: true }, '已刪除封面')}
            >
              刪除封面
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 帳號 ----------

interface SaveResult {
  ok: boolean;
  applied: boolean;
  errors: string[];
  created: number;
  updated: number;
}

export function AccountsCard({ ov, pw, onChanged, notify }: { ov: AdminOverview; pw: string; onChanged: () => Promise<void>; notify: Notify }) {
  const [names, setNames] = useState('');
  const [role, setRole] = useState<Role>('mentor');
  const [pwCsv, setPwCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const accounts = ov.accounts;
  const students = accounts.filter((a) => a.role === 'student');
  const noPw = students.filter((a) => !a.hasPassword);
  const others = accounts.filter((a) => a.role !== 'student');

  async function save(entries: { name: string; role: Role; password?: string }[], done: string) {
    setBusy(true);
    try {
      const preview = await rpc<SaveResult>('invest_admin_account_save', { pw, entries, apply: false });
      if (!preview.ok) {
        notify(preview.errors.slice(0, 3).join('；'), 'error');
        return false;
      }
      await rpc<SaveResult>('invest_admin_account_save', { pw, entries, apply: true });
      await onChanged();
      notify(done);
      return true;
    } catch (err) {
      notify((err as Error).message, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addAccounts() {
    const list = names.split(/[\n,，、]/).map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return;
    if (await save(list.map((name) => ({ name, role })), `已新增／更新 ${list.length} 個${ROLE_LABEL[role]}帳號（密碼 TNDA）`)) setNames('');
  }

  async function importPasswords() {
    const entries: { name: string; role: Role; password: string }[] = [];
    for (const line of pwCsv.split(/\r?\n/)) {
      const [name, password] = line.split(/[\t,，]/).map((s) => s?.trim() ?? '');
      if (!name || !password || name === '姓名') continue;
      entries.push({ name, role: 'student', password });
    }
    if (entries.length === 0) return notify('沒有讀到「姓名, 密碼」', 'error');
    if (await save(entries, `已設定 ${entries.length} 位學生的密碼`)) setPwCsv('');
  }

  function resetPassword(name: string, r: Role) {
    const next = prompt(`設定「${name}」的新密碼${r === 'student' ? '（學生：生日後四碼）' : '（預設 TNDA）'}：`, r === 'student' ? '' : 'TNDA');
    if (!next) return;
    void save([{ name, role: r, password: next }], `已重設「${name}」的密碼，舊的登入會被登出`);
  }

  async function remove(name: string) {
    if (!confirm(`刪除「${name}」的帳號？他在進行中場次的投資也會一起刪除。`)) return;
    setBusy(true);
    try {
      await rpc('invest_admin_account_delete', { pw, name });
      await onChanged();
      notify(`已刪除「${name}」`);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 class="card-title">
        <Eyebrow>Accounts · 帳號密碼</Eyebrow>
      </h2>
      <p class="muted">
        學生：帳號＝姓名，密碼＝生日月日四碼（4 月 3 日 → 0403）。業師、老師、來賓：帳號＝姓名，密碼預設 TNDA；兩場都能投、每場 100 萬，投資算進各組總額，但不倒扣、不參加股神獎。連續輸錯 5 次會鎖 1 分鐘。
      </p>
      <div class="stat-row">
        <div class="stat">
          <div class="stat-label">學生</div>
          <div class="stat-value">{students.length - noPw.length}</div>
          <div class="muted">/ {students.length} 位已設密碼</div>
        </div>
        <div class="stat">
          <div class="stat-label">業師／老師</div>
          <div class="stat-value">{others.filter((a) => a.role === 'mentor').length}</div>
        </div>
        <div class="stat">
          <div class="stat-label">來賓</div>
          <div class="stat-value">{others.filter((a) => a.role === 'guest').length}</div>
        </div>
      </div>
      {noPw.length > 0 && (
        <p class="form-error">還沒設定密碼（不能登入）：{noPw.map((a) => a.name).join('、')}</p>
      )}

      <h3 class="sub-title">業師、老師、來賓</h3>
      <ul class="account-list">
        {others.map((a) => (
          <li key={a.name}>
            <span class="account-name">{a.name}</span>
            <span class="role-tag">{ROLE_LABEL[a.role]}</span>
            {a.locked && <span class="form-error">鎖定中</span>}
            <button class="link-btn" disabled={busy} onClick={() => resetPassword(a.name, a.role)}>
              改密碼
            </button>
            <button class="link-btn" disabled={busy} onClick={() => remove(a.name)}>
              刪除
            </button>
          </li>
        ))}
      </ul>
      <label class="field-label">新增帳號（一行一個姓名）</label>
      <textarea class="text-area" rows={3} value={names} placeholder={'例如：\n王老師\n陳業師'} onInput={(e) => setNames((e.target as HTMLTextAreaElement).value)} />
      <div class="btn-row">
        <button class={`seg${role === 'mentor' ? ' seg-on' : ''}`} onClick={() => setRole('mentor')}>
          業師／老師
        </button>
        <button class={`seg${role === 'guest' ? ' seg-on' : ''}`} onClick={() => setRole('guest')}>
          來賓
        </button>
        <button class="btn btn-primary" disabled={busy || !names.trim()} onClick={addAccounts}>
          新增（密碼 TNDA）
        </button>
      </div>

      <h3 class="sub-title">學生密碼</h3>
      <details class="roster-course">
        <summary>學生名單（{students.length} 位）· 點姓名旁的「改密碼」單獨設定</summary>
        <ul class="account-list">
          {students.map((a) => (
            <li key={a.name}>
              <span class="account-name">{a.name}</span>
              {!a.hasPassword && <span class="form-error">未設定</span>}
              {a.locked && <span class="form-error">鎖定中</span>}
              <button class="link-btn" disabled={busy} onClick={() => resetPassword(a.name, 'student')}>
                改密碼
              </button>
            </li>
          ))}
        </ul>
      </details>
      <label class="field-label">批次設定（每行「姓名, 密碼」）</label>
      <textarea class="text-area" rows={3} value={pwCsv} placeholder={'王小明, 0403\n李小華, 1103'} onInput={(e) => setPwCsv((e.target as HTMLTextAreaElement).value)} />
      <div class="btn-row">
        <button class="btn btn-primary" disabled={busy || !pwCsv.trim()} onClick={importPasswords}>
          設定密碼
        </button>
      </div>
    </Card>
  );
}

// ---------- 業師總結投影片 ----------

type DraftSlide = AdminSlide & { key: string; preview?: string | null };

let seq = 0;
const toDraft = (s: AdminSlide): DraftSlide => ({ ...s, key: `s${s.id ?? `n${++seq}`}` });

export function SlidesCard({ ov, act, busy, notify }: { ov: AdminOverview; act: Act; busy: boolean; notify: Notify }) {
  const sig = JSON.stringify(ov.slides);
  const [draft, setDraft] = useState<DraftSlide[]>(() => ov.slides.map(toDraft));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(ov.slides.map(toDraft));
  }, [sig]);

  function update(i: number, patch: Partial<DraftSlide>) {
    setDraft((d) => d.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    setDirty(true);
  }
  function move(i: number, dir: -1 | 1) {
    setDraft((d) => {
      const next = d.slice();
      const j = i + dir;
      if (j < 0 || j >= next.length) return d;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    setDirty(true);
  }
  async function pickImage(i: number, e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const data = await imageToDataUrl(file);
      update(i, { image: data, preview: data });
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }
  async function saveAll() {
    const slides = draft.map(({ key: _k, preview: _p, imageVer: _v, ...s }) => s);
    await act('invest_admin_slides', { slides }, '總結投影片已儲存');
    setDirty(false);
  }

  return (
    <Card>
      <h2 class="card-title">
        <Eyebrow>Summary · 業師總結投影片</Eyebrow>
      </h2>
      <p class="muted">頒獎結束後按「業師總結」，大螢幕一頁一頁顯示這些投影片（和頒獎一樣用「下一步」切換）。「數字回顧」頁會自動帶入兩場的參與人數、投資總額與得獎者。內文一行一點。</p>
      <ol class="slide-admin-list">
        {draft.map((s, i) => (
          <li key={s.key} class="slide-admin">
            <div class="slide-admin-head">
              <span class="rule-num">{pad2(i + 1)}</span>
              <select value={s.kind} onChange={(e) => update(i, { kind: (e.target as HTMLSelectElement).value as AdminSlide['kind'] })}>
                <option value="title">標題頁</option>
                <option value="text">內容頁</option>
                <option value="recap">數字回顧（自動）</option>
              </select>
              <span class="slide-admin-tools">
                <button class="link-btn" onClick={() => move(i, -1)} disabled={i === 0}>
                  上移
                </button>
                <button class="link-btn" onClick={() => move(i, 1)} disabled={i === draft.length - 1}>
                  下移
                </button>
                <button
                  class="link-btn"
                  onClick={() => {
                    setDraft((d) => d.filter((_, j) => j !== i));
                    setDirty(true);
                  }}
                >
                  刪除
                </button>
              </span>
            </div>
            <input class="text-input" value={s.title} placeholder="標題" maxLength={200} onInput={(e) => update(i, { title: (e.target as HTMLInputElement).value })} />
            <input class="text-input" value={s.subtitle} placeholder="副標（例如業師姓名、公司）" maxLength={300} onInput={(e) => update(i, { subtitle: (e.target as HTMLInputElement).value })} />
            {s.kind !== 'recap' && (
              <textarea class="text-area" rows={4} value={s.body} placeholder="內文，一行一點" maxLength={3000} onInput={(e) => update(i, { body: (e.target as HTMLTextAreaElement).value })} />
            )}
            {s.kind === 'text' && (
              <div class="btn-row">
                <label class="btn file-btn">
                  {s.preview || (s.imageVer !== null && s.imageVer !== undefined && s.image !== null) ? '更換圖片' : '加入圖片'}
                  <input type="file" accept="image/*" onChange={(e) => pickImage(i, e)} />
                </label>
                {(s.preview || (s.imageVer != null && s.image !== null)) && (
                  <button class="btn btn-danger" onClick={() => update(i, { image: null, preview: null })}>
                    移除圖片
                  </button>
                )}
                {s.preview && <img class="slide-admin-thumb" src={s.preview} alt="" />}
              </div>
            )}
          </li>
        ))}
      </ol>
      <div class="btn-row">
        <button
          class="btn"
          onClick={() => {
            setDraft((d) => [...d, toDraft({ kind: 'text', title: '', subtitle: '', body: '' })]);
            setDirty(true);
          }}
        >
          新增一頁
        </button>
        <button class="btn btn-primary" disabled={busy || !dirty} onClick={saveAll}>
          {dirty ? '儲存投影片' : '已儲存'}
        </button>
      </div>
    </Card>
  );
}
