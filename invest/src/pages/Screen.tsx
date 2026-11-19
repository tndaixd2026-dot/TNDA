// 現場大螢幕（65 吋橫式）：開盤中顯示走勢與排行，暗盤顯示倒數，封盤後揭曉結果。
// 網址加 ?course=wed 或 ?course=thu 可固定顯示某一場，否則跟著管理員目前的場次。
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { clockTime, countdown, wan } from '../../shared/format.ts';
import { splitGroupLabel } from '../../shared/roster.ts';
import { multiplierForRank } from '../../shared/rules.ts';
import { courseLabel, type CourseId, type HistoryPoint, type PublicCourse } from '../../shared/types.ts';
import { useLive, useNow } from '../api.ts';
import { Chart } from '../ui/Chart.tsx';
import { Eyebrow, GroupName, Logo, PhaseBadge, QrCode, Swatch, THEME, ThemeTag, groupIndexMap, pad2 } from '../ui/common.tsx';
import { useFlip } from '../ui/motion.ts';
import { PayoutTable } from '../ui/Payout.tsx';
import { PresentingBar, presentingNow } from '../ui/Presenting.tsx';
import { GroupCarousel } from '../ui/Showcase.tsx';
import { AwardsView, SlideView } from '../ui/Stage.tsx';
import { Count, Sparkle, Ticker, Wan, WinBar } from '../ui/y2k.tsx';

export function Screen() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    root.classList.add('screen-mode');
    return () => root.classList.remove('screen-mode');
  }, []);

  const live = useLive({ history: true, intervalMs: 700 });
  const now = useNow(live.offset, 250);
  const forced = new URLSearchParams(location.search).get('course');

  if (!live.pub) return <div class="screen screen-loading">連線中…</div>;

  const course: CourseId = forced === 'wed' || forced === 'thu' ? forced : live.pub.active;
  const pc = live.pub.courses[course];
  const points = live.history?.[course] ?? [];
  // 學生頁在大螢幕頁的上一層（/…/screen/ → /…/）
  const joinUrl = new URL('../', `${location.origin}${location.pathname}`).href;

  // 頒獎與業師總結：同一個網址，由管理員頁切換
  const stage = live.pub.stage;
  if (stage.mode !== 'market') {
    const sc = stage.scene;
    const title = stage.mode === 'awards' ? 'Awards · 頒獎典禮' : 'Summary · 業師總結';
    return (
      <div class={`screen screen-stage stage-mode-${stage.mode} scene-${sc.kind}`}>
        <header class="screen-header">
          <div class="screen-title">
            <Logo tone="white" size={56} />
            <span class="screen-title-text">
              <span class="screen-kicker">期末提報「{THEME}」</span>
              <span class="screen-course">{title}</span>
            </span>
          </div>
          <div class="screen-stats">
            <span class="stage-progress">
              {pad2(stage.step + 1)} / {pad2(stage.total)}
            </span>
            <span class="screen-clock">{clockTime(now)}</span>
            {!live.connected && <span class="screen-offline">重新連線中…</span>}
          </div>
        </header>
        {stage.mode === 'awards' && stage.scene.kind === 'ranking' ? (
          <ResultsView
            key={stage.step}
            pc={live.pub.courses[stage.scene.course]}
            points={live.history?.[stage.scene.course] ?? []}
            now={now}
          />
        ) : stage.mode === 'awards' ? (
          <AwardsView key={stage.step} scene={stage.scene} pub={live.pub} />
        ) : (
          <SlideView key={stage.step} scene={stage.scene} step={stage.step} total={stage.total} />
        )}
      </div>
    );
  }

  return (
    <div class={`screen screen-phase-${pc.phase}${pc.phase !== 'closed' ? ' has-ticker' : ''}`}>
      <header class="screen-header">
        <div class="screen-title">
          <Logo tone={pc.phase === 'pending' ? 'black' : 'white'} size={56} />
          <span class="screen-title-text">
            <span class="screen-kicker">
              期末提報「{THEME}」 · Live Market 即時投資
            </span>
            <span class="screen-course">{courseLabel(course)}</span>
          </span>
        </div>
        <PhaseBadge phase={pc.phase} remainingMs={pc.darkEndsAt ? pc.darkEndsAt - now : undefined} />
        <div class="screen-stats">
          <span>
            已登入{' '}
            <strong>
              <Count value={pc.joined} />
            </strong>{' '}
            / {pc.students}
          </span>
          <span>
            已投完{' '}
            <strong>
              <Count value={pc.fullyInvested} />
            </strong>{' '}
            / {pc.students}
          </span>
          <span class="screen-clock">{clockTime(now)}</span>
          {!live.connected && <span class="screen-offline">重新連線中…</span>}
        </div>
      </header>

      {pc.phase === 'pending' && <PendingView pc={pc} joinUrl={joinUrl} darkMs={live.pub.darkMs} />}
      {pc.phase === 'open' && <LiveView pc={pc} points={points} now={now} offset={live.offset} joinUrl={joinUrl} />}
      {pc.phase === 'dark' && <DarkView pc={pc} now={now} joinUrl={joinUrl} />}
      {pc.phase === 'closed' && pc.revealed && <ResultsView pc={pc} points={points} now={now} />}
      {pc.phase === 'closed' && !pc.revealed && <WaitingView pc={pc} />}
      {pc.phase !== 'closed' && <ScreenTicker pc={pc} />}
    </div>
  );
}

const PAYOUT_TICKER = ['簡報 ×1.4', 'Demo ×1.2', '講評 ×1.1', '第 1 名 ×3', '第 2 名 ×2', '第 3 名 ×1.5'];

/** 底部跑馬燈：未開盤跑規則、開盤中跑各組金額、暗盤只跑提示（不含任何金額） */
function ScreenTicker({ pc }: { pc: PublicCourse }) {
  let items: ComponentChildren[];
  if (pc.phase === 'open') {
    const ranked = [...pc.groups].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    items = ranked.map((g) => (
      <span>
        <span class="tk-rank">No.{pad2(g.rank ?? 0)}</span> {splitGroupLabel(g.id).short}{' '}
        <span class="tk-value">{wan(g.total ?? 0)} 萬</span>
      </span>
    ));
    items.push(...PAYOUT_TICKER);
  } else if (pc.phase === 'dark') {
    items = ['Dark Mode', '暗盤中', '金額隱藏', '倒數結束自動封盤', '快投完', ...PAYOUT_TICKER];
  } else {
    items = ['Live Market', '掃碼加入', '每人 100 萬', '只能投別組', '可以 all in', ...PAYOUT_TICKER, '等待開盤'];
  }
  return <Ticker items={items} class={`screen-ticker ticker-${pc.phase}`} />;
}

function JoinBox({ joinUrl, big }: { joinUrl: string; big?: boolean }) {
  return (
    <div class={`join${big ? ' join-big' : ''}`}>
      {big && <WinBar title="JOIN.EXE" />}
      <QrCode text={joinUrl} label="掃碼加入" />
      <div class="join-text">
        <div class="join-title">手機掃碼加入</div>
        <div class="join-url">{joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</div>
        <div class="join-hint">姓名＋生日四碼</div>
      </div>
    </div>
  );
}

function PendingView({ pc, joinUrl, darkMs }: { pc: PublicCourse; joinUrl: string; darkMs: number }) {
  const idx = groupIndexMap(pc);
  const dark = darkMs % 60_000 === 0 ? `${darkMs / 60_000} 分鐘` : `${Math.round(darkMs / 1000)} 秒`;
  return (
    <main class="screen-pending">
      <Sparkle class="deco-spark p1" size="5rem" color="#fff" />
      <Sparkle class="deco-spark p2" size="2.4rem" color="#000" />
      <Sparkle class="deco-spark p3" size="3.2rem" color="#fff" />
      <div class="pending-main">
        <ThemeTag size="lg" />
        <div class="pending-kicker">Standby · 等待開盤</div>
        <h1 class="pending-title">
          <span class="display">Live Market</span>
          <span class="pending-title-zh">用 100 萬，投你看好的組</span>
        </h1>
        <div class="pending-info">
        <ol class="pending-rules">
          {[
            '每人 100 萬，只能投別組',
            '沒有上限，可以 all in',
            '沒投完的錢，從自己組扣',
            `最後 ${dark}暗盤，金額隱藏`,
          ].map((t, i) => (
            <li key={t}>
              <span class="rule-num">{pad2(i + 1)}</span>
              {t}
            </li>
          ))}
        </ol>
        <PayoutTable size="screen" />
        </div>
        <div class="pending-groups">
          {pc.groups.map((g) => (
            <span class="group-chip" key={g.id}>
              <GroupName id={g.id} index={idx.get(g.id) ?? 0} />
            </span>
          ))}
        </div>
      </div>
      <JoinBox joinUrl={joinUrl} big />
    </main>
  );
}

/** 某時間點各組的金額（取該時間之前最後一個點） */
function totalsAt(points: HistoryPoint[], t: number): Record<string, number> | null {
  let found: HistoryPoint | null = null;
  for (const p of points) {
    if (p.t <= t) found = p;
    else break;
  }
  return found?.totals ?? null;
}

function LiveView({
  pc,
  points,
  now,
  offset,
  joinUrl,
}: {
  pc: PublicCourse;
  points: HistoryPoint[];
  now: number;
  offset: number;
  joinUrl: string;
}) {
  const idx = groupIndexMap(pc);
  const boardRef = useRef<HTMLOListElement>(null);
  useFlip(boardRef);
  const ids = pc.groups.map((g) => g.id);
  const before = totalsAt(points, now - 60_000) ?? points[0]?.totals ?? {};
  const live = presentingNow(pc, now);
  const ranked = [...pc.groups].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0));
  return (
    <main class="screen-live">
      <section class="screen-chart-panel">
        <WinBar title="MARKET_CHART.EXE" />
        <PresentingBar pc={pc} now={now} size="screen" />
        <Chart groups={ids} points={points} now={now} offset={offset} live label="各組獲得金額的即時走勢" />
      </section>
      <aside class="screen-board">
        <WinBar title="RANKING.EXE" tone="orange" />
        <h2 class="board-title">
          <Eyebrow>Ranking · 目前排行</Eyebrow>
        </h2>
        <div class="board-head" aria-hidden="true">
          <span>名次</span>
          <span>組別</span>
          <span>金額 · 1 分鐘變化</span>
        </div>
        <ol class="board" ref={boardRef}>
          {ranked.map((g) => {
            const delta = (g.total ?? 0) - (before[g.id] ?? 0);
            const name = splitGroupLabel(g.id);
            return (
              <li key={g.id} data-key={g.id} class={`board-row${g.rank === 1 ? ' board-top' : ''}`}>
                <span class="board-rank">{pad2(g.rank ?? 0)}</span>
                <span class="board-name">
                  <Swatch index={idx.get(g.id) ?? 0} />
                  <span class="group-short">{name.short}</span>
                  {live?.group === g.id && live.weight > 1 && <span class="board-live">報告中 ×{live.weight}</span>}
                </span>
                <span class="board-total">
                  <Wan value={g.total ?? 0} ms={350} />
                  <small>萬</small>
                </span>
                <span class="board-mult">×{multiplierForRank(g.rank ?? 99)}</span>
                <span class="board-nick">{name.nick}</span>
                <span class={`board-delta${delta > 0 ? ' up' : delta < 0 ? ' down' : ''}`}>
                  {delta === 0 ? '—' : `${delta > 0 ? '↑' : '↓'} ${wan(Math.abs(delta))} 萬`}
                </span>
              </li>
            );
          })}
        </ol>
        <JoinBox joinUrl={joinUrl} />
      </aside>
    </main>
  );
}

function DarkView({ pc, now, joinUrl }: { pc: PublicCourse; now: number; joinUrl: string }) {
  const left = pc.darkEndsAt ? pc.darkEndsAt - now : 0;
  return (
    <main class="screen-dark">
      <div class="dark-main">
        <Sparkle class="dark-spark" size="3rem" color="var(--tnda-orange)" />
        <div class="dark-kicker">
          <span class="display">Dark</span> 暗盤中 · 金額隱藏
        </div>
        <div class={`dark-countdown${left <= 10_000 ? ' dark-final' : ''}`} role="timer" aria-live="off">
          <span key={Math.ceil(left / 1000)} class="tick">
            {countdown(left)}
          </span>
        </div>
        <div class="dark-hint">倒數結束自動封盤</div>
        {presentingNow(pc, now) ? <PresentingBar pc={pc} now={now} size="screen" /> : <PayoutTable size="screen" compact />}
        <JoinBox joinUrl={joinUrl} />
      </div>
      <GroupCarousel pc={pc} />
    </main>
  );
}

/** 封盤後、頒獎揭曉前：不顯示任何金額，輪播各組作品 */
function WaitingView({ pc }: { pc: PublicCourse }) {
  return (
    <main class="screen-dark screen-waiting">
      <div class="dark-main">
        <Sparkle class="dark-spark" size="3rem" color="var(--tnda-orange)" />
        <div class="dark-kicker">
          <span class="display">Closed</span> 已封盤
        </div>
        <div class="waiting-title">等待頒獎揭曉</div>
        <div class="dark-hint">{courseLabel(pc.course)} · 封盤時間 {pc.closedAt ? clockTime(pc.closedAt) : '—'}</div>
      </div>
      <GroupCarousel pc={pc} />
    </main>
  );
}

export function ResultsView({ pc, points, now }: { pc: PublicCourse; points: HistoryPoint[]; now: number }) {
  const results = pc.results;
  const idx = groupIndexMap(pc);
  if (!results) return <main class="screen-loading">結算中…</main>;
  const ids = pc.groups.map((g) => g.id);
  const rocket = results.groups.filter((g) => results.rocket.includes(g.group));
  const gods = results.stockGods;
  return (
    <main class="screen-results">
      <section class="awards">
        <div class="award award-rocket">
          <WinBar title="TOP_GROUP.EXE" />
          <Sparkle class="award-spark a1" size="3.4rem" color="#fff" />
          <Sparkle class="award-spark a2" size="1.8rem" color="#000" />
          <div class="award-title">
            <span class="display">Top Group</span>
            <span class="award-title-zh">一飛沖天獎</span>
          </div>
          <div class="award-winners">
            {rocket.map((g) => (
              <div key={g.group} class="award-winner">
                <GroupName id={g.group} index={idx.get(g.group) ?? 0} stacked />
                <span class="award-amount">
                  <Wan value={g.final} ms={1600} from={0} /> 萬
                </span>
              </div>
            ))}
          </div>
        </div>
        <div class="award award-god">
          <WinBar title="TOP_INVESTOR.EXE" tone="orange" />
          <Sparkle class="award-spark a1" size="3.4rem" color="var(--tnda-orange)" />
          <Sparkle class="award-spark a2" size="1.8rem" color="#000" />
          <div class="award-title">
            <span class="display">Top Investor</span>
            <span class="award-title-zh">股神獎</span>
          </div>
          <div class="award-winners">
            {gods.slice(0, 6).map((i) => (
              <div key={i.name} class="award-winner">
                <span class="award-name">{i.name}</span>
                <span class="award-sub">{splitGroupLabel(i.group).short}</span>
                <span class="award-amount">
                  報酬 <Wan value={i.payout} ms={1600} from={0} /> 萬
                </span>
              </div>
            ))}
            {gods.length > 6 && <div class="award-sub">…等 {gods.length} 人並列</div>}
            {gods.length === 0 && <div class="award-sub">無人投資</div>}
          </div>
          <div class="award-note">共 {results.investorCount} 人投資</div>
        </div>
      </section>
      <section class="final-table-panel">
        <WinBar title="FINAL_RESULTS.EXE" />
        <table class="final-table">
          <thead>
            <tr>
              <th>名次</th>
              <th>組別</th>
              <th class="num">投資總額</th>
              <th class="num">倒扣</th>
              <th class="num">最終金額</th>
              <th class="num">倍率</th>
            </tr>
          </thead>
          <tbody>
            {results.groups.map((g) => (
              <tr key={g.group} class={results.rocket.includes(g.group) ? 'row-win' : ''}>
                <td class="ft-rank">{pad2(g.rank)}</td>
                <td>
                  <GroupName id={g.group} index={idx.get(g.group) ?? 0} />
                </td>
                <td class="num">{wan(g.raw)}</td>
                <td class="num">{g.penalty > 0 ? `−${wan(g.penalty)}` : '0'}</td>
                <td class="num ft-final">{wan(g.final)}</td>
                <td class="num">×{g.multiplier}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="ft-note">單位：萬　倒扣＝組員沒投完的錢</div>
      </section>
      <section class="final-chart-panel">
        <WinBar title="MARKET_CHART.EXE" />
        <Chart
          groups={ids}
          points={points}
          now={now}
          live={false}
          shadeFrom={pc.darkAt}
          shadeTo={pc.closedAt}
          label="完整走勢"
        />
      </section>
      <div class="swatch-legend" aria-hidden="true">
        {pc.groups.map((g) => (
          <span key={g.id}>
            <Swatch index={idx.get(g.id) ?? 0} />
            {splitGroupLabel(g.id).short}
          </span>
        ))}
      </div>
    </main>
  );
}
