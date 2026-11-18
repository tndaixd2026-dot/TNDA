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
  type LoginResult,
  type MeState,
  type MyCourse,
  type Role,
  type PublicCourse,
} from '../../shared/types.ts';
import { rpc, storageGet, storageSet, useLive, useNow } from '../api.ts';
import { Card, ConnectionDot, Eyebrow, GroupName, Logo, PhaseBadge, ThemeTag, groupIndexMap, pad2, useToast } from '../ui/common.tsx';
import { Intro, shouldPlayIntro } from '../ui/Intro.tsx';
import { Cursor, Sparkle, Wan, WinBar } from '../ui/y2k.tsx';

// 登入後的憑證（不是密碼）；舊版只存姓名的紀錄會被清掉
const TOKEN_KEY = 'invest.token';
const STEP_KEY = 'invest.step';
const STEPS = [10_000, 50_000, 100_000];

export function Student() {
  const [token, setToken] = useState<string | null>(() => {
    storageSet('invest.name', null);
    return storageGet(TOKEN_KEY);
  });
  const [notice, setNotice] = useState<string | null>(null);
  if (!token) {
    return (
      <Login
        notice={notice}
        onLogin={(t) => {
          storageSet(TOKEN_KEY, t);
          setNotice(null);
          setToken(t);
        }}
      />
    );
  }
  return (
    <Market
      key={token}
      token={token}
      onLogout={(msg) => {
        storageSet(TOKEN_KEY, null);
        setNotice(msg ?? null);
        setToken(null);
      }}
    />
  );
}

function Login({ onLogin, notice }: { onLogin: (token: string) => void; notice: string | null }) {
  const [value, setValue] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const [intro, setIntro] = useState(() => !notice && shouldPlayIntro());

  async function submit(e: Event) {
    e.preventDefault();
    if (!value.trim() || !password.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await rpc<LoginResult>('invest_login', { name: value, password });
      onLogin(res.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class={`login-page${intro ? ' login-waiting' : ' login-ready'}`}>
      {intro && <Intro onDone={() => setIntro(false)} />}
      <Sparkle class="deco-spark d1" size={46} color="#fff" />
      <Sparkle class="deco-spark d2" size={20} color="#000" />
      <Sparkle class="deco-spark d3" size={28} color="#fff" />
      <div class="login-inner" inert={intro || undefined}>
      <header class="login-head">
        <Logo tone="white" size={48} />
        <ThemeTag />
        <Eyebrow>Next D · 期末提報即時投資</Eyebrow>
        <h1 class="login-title">
          <span class="display">Live Market</span>
          <span class="login-title-zh">
            即時投資
            <Cursor />
          </span>
        </h1>
        <p class="login-lead">用 100 萬虛擬資金，投給你看好的組。</p>
      </header>
      <form class="card login-card" onSubmit={submit}>
        <WinBar title="LOGIN.EXE" />
        <label for="name" class="field-label">
          你的姓名
        </label>
        <input
          id="name"
          class="text-input"
          value={value}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          placeholder="例如：王小明"
          autocomplete="username"
          autoFocus={!intro}
          maxLength={40}
        />
        <label for="password" class="field-label">
          密碼
        </label>
        <input
          id="password"
          class="text-input"
          type="password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          placeholder="學生：生日後四碼（例如 0403）"
          autocomplete="current-password"
          maxLength={40}
        />
        <p class="login-hint">學生：生日月日四碼（4 月 3 日 → 0403）· 業師、老師、來賓：TNDA</p>
        {error && (
          <p class="form-error" role="alert">
            {error}
          </p>
        )}
        <button class="btn btn-solid btn-block btn-lg" type="submit" disabled={busy || !value.trim() || !password.trim()}>
          {busy ? '登入中…' : '進入'}
        </button>
      </form>
      <ol class="rules">
        {[
          '每堂課各有 100 萬，只能投給同堂課的其他組',
          '單一組最多 50 萬，所以至少要投兩組',
          '封盤時沒投完的錢，會從你們組的總額倒扣',
          '最後 5 分鐘是暗盤：看不到各組金額，但還能調整',
        ].map((t, i) => (
          <li key={t}>
            <span class="rule-num">{pad2(i + 1)}</span>
            {t}
          </li>
        ))}
      </ol>
      </div>
    </div>
  );
}

function Market({ token, onLogout }: { token: string; onLogout: (msg?: string) => void }) {
  const { pub, me, meError, setMe, offset, connected } = useLive({ token });
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

  // 登入失效（密碼被重設、名單更新）→ 回到登入頁
  useEffect(() => {
    if (meError) onLogout(meError.message);
  }, [meError]);

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
        lastGood.current = await rpc<MeState>('invest_invest', { token, course, grp: group, amount });
      } catch (err) {
        failed.current = true;
        toast.show((err as Error).message, 'error');
      } finally {
        inflight.current--;
        if (inflight.current === 0) {
          if (failed.current) {
            failed.current = false;
            try {
              setMe(await rpc<MeState>('invest_me', { token }));
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
          <Logo tone="white" size={34} />
          <span key={pc.phase} class="badge-swap">
            <PhaseBadge phase={pc.phase} remainingMs={pc.darkEndsAt ? pc.darkEndsAt - now : undefined} />
          </span>
        </div>
        <div class="topbar-row topbar-sub">
          <div>
            <div class="topbar-title">Live Market · 即時投資</div>
            <div class="topbar-course">{courseLabel(course)}</div>
          </div>
        </div>
      </header>
      <div class="identity">
        <span>
          <span class="identity-label">登入身分</span> {me.name}
          {me.role !== 'student' && <span class="role-tag">{me.role === 'mentor' ? '業師／老師' : '來賓'}</span>}
          <button class="link-btn" onClick={() => onLogout()}>
            登出
          </button>
        </span>
        <ConnectionDot connected={connected} />
      </div>

      {mine ? (
        <CourseMarket
          name={me.name}
          role={me.role}
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
  role: Role;
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
  // 業師、老師、來賓沒有自己的組
  const own = mine.group ? splitGroupLabel(mine.group).short : null;

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

  /** 直接輸入金額：成功回傳 null，失敗回傳說明（顯示在輸入框下方，手機鍵盤打開時也看得到） */
  function setExact(group: string, amount: number): string | null {
    const cur = alloc[group] ?? 0;
    if (amount > MAX_PER_GROUP) return '單一組最多只能投 50 萬';
    if (amount - cur > remaining) return `餘額不足，這組最多可以投到 ${wan(Math.min(MAX_PER_GROUP, cur + remaining))} 萬`;
    if (amount !== cur) p.submit(p.course, group, amount);
    return null;
  }

  return (
    <>
      {pc.phase === 'closed' && !pc.revealed && (
        <Card class="awaiting-card">
          <WinBar title="WAITING.EXE" tone="orange" />
          <Eyebrow>Closed · 已封盤</Eyebrow>
          <p class="awaiting-text">
            等待大螢幕頒獎揭曉
            <Cursor />
          </p>
          <p class="muted">各組最終金額與你的報酬，會在頒獎時和大螢幕同步公開。</p>
        </Card>
      )}
      {pc.phase === 'closed' && pc.revealed && <MyResult pc={pc} mine={mine} name={p.name} role={p.role} />}

      <Card class="wallet">
        <WinBar title="WALLET.EXE" />
        <div class="wallet-row">
          <span class="wallet-label">Wallet · 可用餘額</span>
          <span class="wallet-value">
            <Wan value={remaining} ms={450} step={10_000} />
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
          已投資 {wan(invested)} / 100 萬 · {own ? `你是${own}` : '業師、來賓不參加股神獎'}
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
          還有 <strong>{wan(remaining)} 萬</strong>沒投。
          {own ? `封盤時沒投完的錢會從${own}倒扣。` : '沒投完的錢不會倒扣，但也不會有報酬。'}
        </div>
      )}
      {canTrade && remaining === 0 && <div class="banner banner-good">全部投完了，封盤前都還能調整。</div>}

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

      <ul class={`stocks stocks-${pc.phase}`}>
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
                  {pc.phase === 'dark' && <span class="quote-muted">暗盤隱藏</span>}
                  {pc.phase === 'closed' && g.total === null && <span class="quote-muted">頒獎揭曉</span>}
                  {(pc.phase === 'open' || pc.phase === 'closed') && g.total !== null && (
                    <>
                      <span class="quote-total">
                        <span key={g.total} class="bump">
                          {wan(g.total)}
                        </span>
                        <small>萬</small>
                      </span>
                      <span class="quote-rank">
                        No.{pad2(g.rank ?? 0)}
                        {result ? ` · ×${result.multiplier}` : ''}
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
                    <span key={cur} class="bump">
                      {wan(cur)}
                    </span>
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
                    const err = setExact(g.id, amount);
                    if (!err) p.setEditing(null);
                    return err;
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

function AmountEditor(p: { initial: number; max: number; onSave: (amount: number) => string | null; onCancel: () => void }) {
  const [value, setValue] = useState(wan(p.initial));
  const [error, setError] = useState<string | null>(null);
  const parsed = parseWanInput(value);
  function save(e: Event) {
    e.preventDefault();
    if (parsed === null) {
      setError('請輸入 0 以上的金額（單位：萬，小數點後最多 4 位，最小 1 元）');
      return;
    }
    setError(p.onSave(parsed));
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
      {error && (
        <p class="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function MyResult({ pc, mine, name, role }: { pc: PublicCourse; mine: MyCourse; name: string; role: Role }) {
  const results = pc.results;
  if (!results) return null;
  const idx = groupIndexMap(pc);
  const isGod = results.stockGods.some((g) => g.name === name);
  const lines = results.groups.filter((g) => (mine.alloc[g.group] ?? 0) > 0);
  return (
    <>
      <Card class="result-card">
        <WinBar title="PAYOUT.EXE" tone="orange" />
        <Sparkle class="result-spark" size={36} color="var(--tnda-orange)" />
        <div class="result-label">
          <Eyebrow>Payout · 你的報酬</Eyebrow>
        </div>
        {mine.result ? (
          <>
            <div class="result-value">
              <Wan value={mine.result.payout} ms={1400} from={0} />
              <small> 萬</small>
            </div>
            <div class="result-rank">
              {mine.result.rank !== null
                ? `第 ${mine.result.rank} 名 / ${mine.result.of} 位有投資的同學`
                : '業師、老師、來賓不列入股神獎排名'}
              {role === 'student' && isGod && <span class="award-tag">股神獎</span>}
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
            你有 {wan(mine.deducted ?? 0)} 萬沒投完，已從{splitGroupLabel(mine.group ?? '').short}倒扣，也不計入報酬。
          </p>
        )}
      </Card>
      <Card>
        <h2 class="card-title">
          <Eyebrow>Final Ranking · 各組最終排名</Eyebrow>
        </h2>
        <ol class="final-list">
          {results.groups.map((g) => (
            <li key={g.group}>
              <span class="final-rank">{pad2(g.rank)}</span>
              <GroupName id={g.group} index={idx.get(g.group) ?? 0} />
              <span class="final-amount">
                {wan(g.final)} 萬{g.penalty > 0 && <small class="muted">倒扣 {wan(g.penalty)}</small>}
              </span>
              <span class="final-mult">×{g.multiplier}</span>
              {results.rocket.includes(g.group) && <span class="award-tag">一飛沖天</span>}
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
      {courseLabel(course)}結果：報酬 <strong>{wan(mine.result.payout)} 萬</strong>
      {mine.result.rank !== null && `，第 ${mine.result.rank} 名 / ${mine.result.of} 人`}
    </Card>
  );
}
