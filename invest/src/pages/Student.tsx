// 學生端：輸入姓名登入，像買賣股票一樣把 100 萬分配給其他組。
import { useEffect, useRef, useState } from 'preact/hooks';
import { BUDGET, MAX_PER_GROUP } from '../../shared/rules.ts';
import { countdown, parseWanInput, wan, yuanText } from '../../shared/format.ts';
import { splitGroupLabel } from '../../shared/roster.ts';
import {
  COURSE_IDS,
  courseLabel,
  type Allocation,
  type CourseId,
  type MeState,
  type MyCourse,
  type PublicCourse,
} from '../../shared/types.ts';
import { ApiError, api, storageGet, storageSet, useLive, useNow } from '../api.ts';
import { Card, ConnectionDot, GroupName, PhaseBadge, groupIndexMap, useToast } from '../ui/common.tsx';

const NAME_KEY = 'invest.name';
const STEP_KEY = 'invest.step';
const STEPS = [10_000, 50_000, 100_000];

export function Student() {
  const [name, setName] = useState<string | null>(() => storageGet(NAME_KEY));
  const [notice, setNotice] = useState<string | null>(null);
  if (!name) {
    return (
      <Login
        notice={notice}
        onLogin={(n) => {
          storageSet(NAME_KEY, n);
          setNotice(null);
          setName(n);
        }}
      />
    );
  }
  return (
    <Market
      key={name}
      name={name}
      onLogout={(msg) => {
        storageSet(NAME_KEY, null);
        setNotice(msg ?? null);
        setName(null);
      }}
    />
  );
}

function Login({ onLogin, notice }: { onLogin: (name: string) => void; notice: string | null }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  async function submit(e: Event) {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const me = await api<MeState>('/api/login', { body: { name: value } });
      onLogin(me.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="student login-page">
      <header class="brand">
        <span class="brand-mark" aria-hidden="true">📈</span>
        <div>
          <div class="brand-title">期末提報 即時投資</div>
          <div class="brand-sub">用 100 萬虛擬資金，投給你看好的組</div>
        </div>
      </header>
      <form class="card login-card" onSubmit={submit}>
        <label for="name" class="field-label">
          你的姓名
        </label>
        <input
          id="name"
          class="text-input"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder="例如：王小明"
          autocomplete="name"
          autoFocus
          maxLength={40}
        />
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button class="btn btn-primary btn-block" type="submit" disabled={busy || !value.trim()}>
          {busy ? '登入中…' : '進入'}
        </button>
      </form>
      <ul class="rules">
        <li>每堂課各有 100 萬，只能投給同堂課的其他組</li>
        <li>單一組最多 50 萬，所以至少要投兩組</li>
        <li>封盤時沒投完的錢，會從你們組的總額倒扣</li>
        <li>最後 5 分鐘是暗盤：看不到各組金額，但還能調整</li>
      </ul>
    </div>
  );
}

function Market({ name, onLogout }: { name: string; onLogout: (msg?: string) => void }) {
  const { pub, me, setMe, offset, connected } = useLive({ name });
  const now = useNow(offset, 250);
  const toast = useToast();
  const [step, setStepState] = useState(() => {
    const saved = Number(storageGet(STEP_KEY));
    return STEPS.includes(saved) ? saved : 100_000;
  });
  const [overlay, setOverlay] = useState<Allocation>({});
  const [editing, setEditing] = useState<string | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const inflight = useRef(0);
  const failed = useRef(false);
  const lastGood = useRef<MeState | null>(null);

  // 重新開啟頁面時也記錄一次登入，順便確認名字還在名單上
  useEffect(() => {
    api<MeState>('/api/login', { body: { name } })
      .then(setMe)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) onLogout('名單已更新，找不到你的名字，請重新輸入');
      });
  }, [name]);

  function setStep(s: number) {
    setStepState(s);
    storageSet(STEP_KEY, String(s));
  }

  if (!pub || !me) {
    return (
      <div class="student">
        <div class="loading">連線中…</div>
      </div>
    );
  }

  const course = pub.active;
  const pc = pub.courses[course];
  const mine = me.courses[course];
  const other = COURSE_IDS.find((c) => c !== course)!;

  function submit(course: CourseId, group: string, amount: number) {
    setOverlay((o) => ({ ...o, [group]: amount }));
    inflight.current++;
    chain.current = chain.current.then(async () => {
      try {
        lastGood.current = await api<MeState>('/api/invest', { body: { name, course, group, amount } });
      } catch (err) {
        failed.current = true;
        toast.show((err as Error).message, 'error');
      } finally {
        inflight.current--;
        if (inflight.current === 0) {
          if (failed.current) {
            failed.current = false;
            try {
              setMe(await api<MeState>(`/api/me?name=${encodeURIComponent(name)}`));
            } catch {
              // 推播會補上最新狀態
            }
          } else if (lastGood.current) {
            setMe(lastGood.current);
          }
          lastGood.current = null;
          setOverlay({});
        }
      }
    });
  }

  return (
    <div class="student">
      <header class="topbar">
        <div class="topbar-row">
          <div>
            <div class="topbar-title">期末提報 即時投資</div>
            <div class="topbar-course">{courseLabel(course)}</div>
          </div>
          <PhaseBadge phase={pc.phase} remainingMs={pc.darkEndsAt ? pc.darkEndsAt - now : undefined} />
        </div>
        <div class="topbar-row topbar-meta">
          <span>
            👤 {me.name}
            <button class="link-btn" onClick={() => onLogout()}>
              不是我
            </button>
          </span>
          <ConnectionDot connected={connected} />
        </div>
      </header>

      {mine ? (
        <CourseMarket
          name={me.name}
          course={course}
          pc={pc}
          mine={mine}
          overlay={overlay}
          now={now}
          step={step}
          setStep={setStep}
          editing={editing}
          setEditing={setEditing}
          submit={submit}
          notify={toast.show}
        />
      ) : (
        <Card class="notice-card">
          <p>
            <strong>{courseLabel(course)}</strong>的名單裡沒有你，這一場不用投資。
          </p>
          {me.courses[other] && <p class="muted">你在{courseLabel(other)}，輪到那一場時這裡會自動切換。</p>}
        </Card>
      )}

      {mine && me.courses[other]?.result && <OtherResult course={other} mine={me.courses[other]!} />}
      {toast.node}
    </div>
  );
}

interface CourseMarketProps {
  name: string;
  course: CourseId;
  pc: PublicCourse;
  mine: MyCourse;
  overlay: Allocation;
  now: number;
  step: number;
  setStep: (s: number) => void;
  editing: string | null;
  setEditing: (g: string | null) => void;
  submit: (course: CourseId, group: string, amount: number) => void;
  notify: (text: string, tone?: 'info' | 'error') => void;
}

function CourseMarket(p: CourseMarketProps) {
  const { pc, mine, now } = p;
  const idx = groupIndexMap(pc);
  const alloc: Allocation = { ...mine.alloc, ...p.overlay };
  let invested = 0;
  for (const v of Object.values(alloc)) invested += v;
  const remaining = BUDGET - invested;
  const darkLeft = pc.darkEndsAt ? pc.darkEndsAt - now : 0;
  const canTrade = pc.phase === 'open' || (pc.phase === 'dark' && darkLeft > 0);
  const own = splitGroupLabel(mine.group).short;

  function change(group: string, delta: number) {
    const cur = alloc[group] ?? 0;
    if (delta > 0) {
      // 規格：超過 50 萬上限或餘額不足時擋下並提示（伺服器也會再驗證一次）
      if (cur + delta > MAX_PER_GROUP) {
        p.notify(
          cur >= MAX_PER_GROUP ? '這組已達單組上限 50 萬' : `超過單組上限 50 萬，這組最多還能加 ${wan(MAX_PER_GROUP - cur)} 萬`,
          'error',
        );
        return;
      }
      if (delta > remaining) {
        p.notify(remaining > 0 ? `餘額不足，只剩 ${wan(remaining)} 萬` : '餘額不足，先從別組撤回一些', 'error');
        return;
      }
    } else {
      delta = Math.max(delta, -cur);
      if (delta === 0) return;
    }
    p.submit(p.course, group, cur + delta);
  }

  function setExact(group: string, amount: number) {
    const cur = alloc[group] ?? 0;
    if (amount > MAX_PER_GROUP) {
      p.notify('單一組最多只能投 50 萬', 'error');
      return false;
    }
    if (amount - cur > remaining) {
      p.notify(`餘額不足，這組最多可以投到 ${wan(Math.min(MAX_PER_GROUP, cur + remaining))} 萬`, 'error');
      return false;
    }
    if (amount !== cur) p.submit(p.course, group, amount);
    return true;
  }

  return (
    <>
      {pc.phase === 'closed' && <MyResult pc={pc} mine={mine} name={p.name} />}

      <Card class="wallet">
        <div class="wallet-row">
          <span class="wallet-label">可用餘額</span>
          <span class="wallet-value">
            {wan(remaining)}
            <small> 萬</small>
          </span>
        </div>
        <div
          class="meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={BUDGET}
          aria-valuenow={invested}
          aria-label="已投資比例"
        >
          <div class="meter-fill" style={{ width: `${Math.min(100, (invested / BUDGET) * 100)}%` }} />
        </div>
        <div class="wallet-sub">
          已投資 {wan(invested)} / 100 萬 · 你是{own}
        </div>
      </Card>

      {pc.phase === 'pending' && <div class="banner banner-info">還沒開盤，老師開盤後就能下單。</div>}
      {pc.phase === 'dark' && (
        <div class="banner banner-dark">
          <strong>暗盤 {countdown(darkLeft)}</strong> 後封盤 · 各組金額與排名已隱藏，你仍可調整投資
        </div>
      )}
      {canTrade && remaining > 0 && (
        <div class="banner banner-warn">
          ⚠️ 還有 <strong>{wan(remaining)} 萬</strong>沒投。封盤時沒投完的錢會從{own}倒扣！
        </div>
      )}
      {canTrade && remaining === 0 && <div class="banner banner-good">✔ 全部投完了，封盤前都還能調整。</div>}

      {canTrade && (
        <div class="stepper" role="group" aria-label="每按一次的金額">
          <span class="stepper-label">每按一次</span>
          {STEPS.map((s) => (
            <button key={s} class={`seg${p.step === s ? ' seg-on' : ''}`} aria-pressed={p.step === s} onClick={() => p.setStep(s)}>
              {wan(s)} 萬
            </button>
          ))}
        </div>
      )}

      <ul class="stocks">
        {pc.groups.map((g) => {
          const i = idx.get(g.id) ?? 0;
          const isOwn = g.id === mine.group;
          const cur = alloc[g.id] ?? 0;
          const short = splitGroupLabel(g.id).short;
          const result = pc.results?.groups.find((r) => r.group === g.id);
          return (
            <li key={g.id} class={`stock${isOwn ? ' stock-own' : ''}`}>
              <div class="stock-head">
                <GroupName id={g.id} index={i} />
                <div class="stock-quote">
                  {pc.phase === 'pending' && <span class="quote-muted">—</span>}
                  {pc.phase === 'dark' && <span class="quote-muted">🔒 隱藏</span>}
                  {(pc.phase === 'open' || pc.phase === 'closed') && g.total !== null && (
                    <>
                      <span class="quote-total">
                        {wan(g.total)}
                        <small>萬</small>
                      </span>
                      <span class="quote-rank">
                        第 {g.rank} 名{result ? ` · ×${result.multiplier}` : ''}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {isOwn ? (
                <div class="stock-own-note">自己的組 · 不能投資</div>
              ) : pc.phase === 'closed' ? (
                <div class="stock-trade">
                  <span class="hold-label">我投</span>
                  <span class="hold-final">
                    {wan(cur)}
                    <small> 萬</small>
                  </span>
                </div>
              ) : (
                <div class="stock-trade">
                  <span class="hold-label">我投</span>
                  <button
                    class="btn-round"
                    disabled={!canTrade || cur === 0}
                    onClick={() => change(g.id, -p.step)}
                    aria-label={`${short} 減少 ${wan(p.step)} 萬`}
                  >
                    −
                  </button>
                  <button
                    class={`hold-amount${cur > 0 ? ' hold-on' : ''}`}
                    disabled={!canTrade}
                    onClick={() => p.setEditing(p.editing === g.id ? null : g.id)}
                    aria-label={`${short} 目前投 ${wan(cur)} 萬，點一下輸入金額`}
                  >
                    {wan(cur)}
                    <small> 萬</small>
                  </button>
                  <button
                    class="btn-round btn-plus"
                    disabled={!canTrade}
                    onClick={() => change(g.id, p.step)}
                    aria-label={`${short} 增加 ${wan(p.step)} 萬`}
                  >
                    +
                  </button>
                </div>
              )}
              {!isOwn && canTrade && p.editing === g.id && (
                <AmountEditor
                  initial={cur}
                  max={Math.min(MAX_PER_GROUP, cur + remaining)}
                  onCancel={() => p.setEditing(null)}
                  onSave={(amount) => {
                    if (setExact(g.id, amount)) p.setEditing(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function AmountEditor(p: { initial: number; max: number; onSave: (amount: number) => void; onCancel: () => void }) {
  const [value, setValue] = useState(wan(p.initial));
  const [error, setError] = useState<string | null>(null);
  const parsed = parseWanInput(value);
  function save(e: Event) {
    e.preventDefault();
    if (parsed === null) {
      setError('請輸入 0 以上的金額（單位：萬，小數點後最多 4 位，最小 1 元）');
      return;
    }
    setError(null);
    p.onSave(parsed);
  }
  return (
    <form class="amount-editor" onSubmit={save}>
      <div class="amount-editor-row">
        <input
          class="text-input"
          type="text"
          inputMode="decimal"
          autocomplete="off"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          aria-label="金額（萬）"
          autoFocus
        />
        <span class="unit">萬</span>
        <button class="btn btn-primary" type="submit">
          確定
        </button>
        <button class="btn" type="button" onClick={p.onCancel}>
          取消
        </button>
      </div>
      <div class="amount-quick">
        {[0, 10, 20, 30, 40, 50].map((w) => (
          <button
            key={w}
            type="button"
            class="chip"
            disabled={w * 10_000 > p.max}
            onClick={() => setValue(String(w))}
          >
            {w}
          </button>
        ))}
        <button type="button" class="chip" onClick={() => setValue(wan(p.max))}>
          最多 {wan(p.max)}
        </button>
      </div>
      <p class="amount-preview muted">{parsed !== null ? `= ${yuanText(parsed)}` : '單位：萬（例如 12.3456 萬 = 123,456 元）'}</p>
      {error && <p class="form-error">{error}</p>}
    </form>
  );
}

function MyResult({ pc, mine, name }: { pc: PublicCourse; mine: MyCourse; name: string }) {
  const results = pc.results;
  if (!results) return null;
  const idx = groupIndexMap(pc);
  const isGod = results.stockGods.some((g) => g.name === name);
  const lines = results.groups.filter((g) => (mine.alloc[g.group] ?? 0) > 0);
  return (
    <>
      <Card class="result-card">
        <div class="result-label">你的報酬</div>
        {mine.result ? (
          <>
            <div class="result-value">
              {wan(mine.result.payout)}
              <small> 萬</small>
            </div>
            <div class="result-rank">
              第 {mine.result.rank} 名 / {mine.result.of} 位有投資的同學
              {isGod && <span class="award-tag">🏆 股神獎</span>}
            </div>
          </>
        ) : (
          <p class="muted">你這一場沒有投資，不列入個人排名。</p>
        )}
        {lines.length > 0 && (
          <table class="mini-table">
            <thead>
              <tr>
                <th>組別</th>
                <th>投入</th>
                <th>倍率</th>
                <th>報酬</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((g) => (
                <tr key={g.group}>
                  <td>
                    <GroupName id={g.group} index={idx.get(g.group) ?? 0} />
                  </td>
                  <td class="num">{wan(mine.alloc[g.group] ?? 0)}</td>
                  <td class="num">×{g.multiplier}</td>
                  <td class="num">{wan((mine.alloc[g.group] ?? 0) * g.multiplier)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(mine.deducted ?? 0) > 0 && (
          <p class="muted">
            你有 {wan(mine.deducted ?? 0)} 萬沒投完，已從{splitGroupLabel(mine.group).short}倒扣，也不計入報酬。
          </p>
        )}
      </Card>
      <Card>
        <h2 class="card-title">各組最終排名</h2>
        <ol class="final-list">
          {results.groups.map((g) => (
            <li key={g.group}>
              <span class="final-rank">{g.rank}</span>
              <GroupName id={g.group} index={idx.get(g.group) ?? 0} />
              <span class="final-amount">
                {wan(g.final)} 萬{g.penalty > 0 && <small class="muted">（倒扣 {wan(g.penalty)}）</small>}
              </span>
              <span class="final-mult">×{g.multiplier}</span>
              {results.rocket.includes(g.group) && <span class="award-tag">🚀 一飛沖天</span>}
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

function OtherResult({ course, mine }: { course: CourseId; mine: MyCourse }) {
  if (!mine.result) return null;
  return (
    <Card class="other-result">
      {courseLabel(course)}結果：報酬 <strong>{wan(mine.result.payout)} 萬</strong>，第 {mine.result.rank} 名 / {mine.result.of} 人
    </Card>
  );
}
