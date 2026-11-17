// 學生登入頁的進場動畫：「出席率行情看板」。
// 像證券交易所的報價看板一樣，每位學生是一檔股票，價格是到那一週為止的累計出席率；
// 從第一週快轉到最近一週，數字一路跳動（漲＝橘、跌＝綠、平盤＝白），最後收在「LIVE MARKET 即時投資」。
//
// 資料：invest_intro_board()（目前場次；管理員可在後台關閉）。沒有資料或連不上時，只播很短的標題。
// 體驗與安全：
// - 隨時可以按「Skip」或點畫面跳過；每個分頁只播一次
// - 系統設定「減少動態效果」時不播；漲跌只用文字顏色和淡淡的底色，不會整片高對比閃爍
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { splitGroupLabel } from '../../shared/roster.ts';
import { rpc } from '../api.ts';
import { Logo, THEME } from './common.tsx';
import { reducedMotion } from './motion.ts';
import { Sparkle } from './y2k.tsx';

const SEEN_KEY = 'invest.introSeen';
const TRADE_MS = 2800;
const HOLD_MS = 900;
const TITLE_MS = 1150;
const MAX_STEPS = 14;

export interface BoardRow {
  name: string;
  group: string;
  /** 每一週結束時的累計出席率（%）；還沒有應到紀錄時是 null */
  series: (number | null)[];
  attended: number;
  total: number;
}
export interface IntroBoard {
  course: 'wed' | 'thu';
  weeks: number[];
  rows: BoardRow[];
}

export function shouldPlayIntro(): boolean {
  const q = new URLSearchParams(location.search).get('intro');
  if (q === '0') return false;
  if (q === '1') return true;
  if (reducedMotion()) return false;
  try {
    return sessionStorage.getItem(SEEN_KEY) !== '1';
  } catch {
    return true;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // 私密瀏覽：下次再播一次也沒關係
  }
}

/** 週次太多時平均挑選（保留第一週與最後一週），讓快轉的節奏固定 */
export function pickSteps(n: number, max = MAX_STEPS): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: max }, (_, i) => Math.round((i * (n - 1)) / (max - 1)));
}

/** 某一週（含）以前最後一個有數字的出席率 */
function valueAt(series: (number | null)[], idx: number): number | null {
  for (let i = Math.min(idx, series.length - 1); i >= 0; i--) if (series[i] !== null && series[i] !== undefined) return series[i];
  return null;
}

function average(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(1));
const fmtChange = (d: number | null) => (d === null ? '—' : d === 0 ? '0.0' : `${d > 0 ? '▲' : '▼'}${Math.abs(d).toFixed(1)}`);
const dir = (d: number | null) => (d === null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down');

type Stage = 'loading' | 'trade' | 'hold' | 'title' | 'out';

export function Intro({ onDone }: { onDone: () => void }) {
  const [board, setBoard] = useState<IntroBoard | null>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [step, setStep] = useState(0);
  const [scroll, setScroll] = useState(0);
  const done = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  function finish() {
    if (done.current) return;
    done.current = true;
    markSeen();
    setStage('out');
    setTimeout(onDone, 520);
  }

  // 1. 取得看板資料（最多等 2.5 秒）
  useEffect(() => {
    let cancelled = false;
    Promise.race([
      rpc<IntroBoard>('invest_intro_board'),
      new Promise<null>((r) => setTimeout(() => r(null), 2500)),
    ])
      .catch(() => null)
      .then((b) => {
        if (cancelled) return;
        if (b && b.rows.length > 0 && b.weeks.length > 0) {
          setBoard(b);
          setStage('trade');
        } else {
          setStage('title');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = useMemo(() => pickSteps(board?.weeks.length ?? 0), [board]);

  // 2. 快轉每一週
  useEffect(() => {
    if (stage !== 'trade' || steps.length === 0) return;
    const per = TRADE_MS / steps.length;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.floor((t - start) / per);
      if (k >= steps.length) {
        setStep(steps.length - 1);
        setStage('hold');
        return;
      }
      setStep(k);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // 列數超過一個畫面時，跟著快轉往下捲
    const vp = viewport.current;
    const ls = list.current;
    if (vp && ls) setScroll(Math.max(0, ls.scrollHeight - vp.clientHeight));
    return () => cancelAnimationFrame(raf);
  }, [stage, steps]);

  // 3. 停一下 → 標題 → 淡出
  useEffect(() => {
    if (stage === 'hold') {
      const id = setTimeout(() => setStage('title'), HOLD_MS);
      return () => clearTimeout(id);
    }
    if (stage === 'title') {
      const id = setTimeout(finish, TITLE_MS);
      return () => clearTimeout(id);
    }
  }, [stage]);

  const weeks = board?.weeks ?? [];
  const idx = steps[step] ?? 0;
  const prevIdx = stage === 'trade' ? (step > 0 ? steps[step - 1] : -1) : idx - 1;
  const rows = (board?.rows ?? []).map((r) => {
    const v = valueAt(r.series, idx);
    const p = prevIdx >= 0 ? valueAt(r.series, prevIdx) : null;
    const d = v !== null && p !== null ? Math.round((v - p) * 10) / 10 : null;
    return { ...r, v, d };
  });
  const index = average(rows.map((r) => r.v));
  const indexPrev = prevIdx >= 0 ? average((board?.rows ?? []).map((r) => valueAt(r.series, prevIdx))) : null;
  const indexD = index !== null && indexPrev !== null ? Math.round((index - indexPrev) * 10) / 10 : null;
  const tradeOn = stage === 'trade';

  return (
    <div class={`intro intro-stage-${stage}${board ? ' intro-has-board' : ''}`} onClick={finish} role="presentation">
      {board && (
        <div class="board-screen">
          <header class="bs-top">
            <Logo tone="white" size={26} />
            <span class="bs-title">
              <span class="bs-title-en">Attendance Exchange</span>
              <span class="bs-title-zh">出席率行情</span>
            </span>
            <span class="bs-week">W{String(weeks[idx] ?? 0).padStart(2, '0')}</span>
          </header>
          <div class="bs-index">
            <span class="bs-index-label">加權出席指數</span>
            <span class={`bs-index-value ${dir(indexD)}`}>{fmt(index)}</span>
            <span class={`bs-index-change ${dir(indexD)}`}>{fmtChange(indexD)}</span>
          </div>
          <div class="bs-head" aria-hidden="true">
            <span>代號</span>
            <span>名稱</span>
            <span class="r">出席率</span>
            <span class="r">漲跌</span>
            <span class="r">出席</span>
          </div>
          <div class="bs-viewport" ref={viewport}>
            <div
              class="bs-list"
              ref={list}
              style={{
                transform: `translateY(${tradeOn || stage === 'hold' || stage === 'title' || stage === 'out' ? -scroll : 0}px)`,
                transitionDuration: `${TRADE_MS}ms`,
              }}
            >
              {rows.map((r, i) => (
                <div class={`bs-row ${dir(r.d)}`} key={`${r.group}|${r.name}`} style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }}>
                  <span class="bs-code">{groupCode(r.group)}</span>
                  <span class="bs-name">{r.name}</span>
                  {/* key 讓數字每次變動都重播一次底色閃動 */}
                  <span class={`bs-rate ${dir(r.d)}`} key={`${r.name}-${r.v}`}>
                    {fmt(r.v)}
                  </span>
                  <span class={`bs-change ${dir(r.d)}`}>{fmtChange(r.d)}</span>
                  <span class="bs-vol">
                    {stage === 'trade' ? '' : `${r.attended}/${r.total}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {(stage === 'title' || stage === 'out' || stage === 'loading') && (
        <div class={`intro-stamp${stage === 'loading' ? ' intro-stamp-wait' : ''}`}>
          {stage === 'loading' ? (
            <Sparkle size={40} color="var(--tnda-orange)" class="spin" />
          ) : (
            <div class="intro-title">
              <Sparkle size={44} color="var(--tnda-orange)" class="pop" />
              <span class="intro-theme">期末提報「{THEME}」</span>
              <span class="display">Live Market</span>
              <span class="intro-title-zh">即時投資</span>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        class="intro-skip"
        onClick={(e) => {
          e.stopPropagation();
          finish();
        }}
      >
        Skip →
      </button>
    </div>
  );
}

/** 「第3組：兩億五千萬Token」→「G03」 */
function groupCode(group: string): string {
  const short = splitGroupLabel(group).short;
  const m = short.match(/\d+/);
  if (m) return `G${m[0].padStart(2, '0')}`;
  const cn = '〇一二三四五六七八九十'.indexOf(short.replace(/^第|組$/g, ''));
  return cn > 0 ? `G${String(cn).padStart(2, '0')}` : short.slice(0, 3);
}
