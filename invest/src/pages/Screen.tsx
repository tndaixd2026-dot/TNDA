// 現場大螢幕（65 吋橫式）：開盤中顯示走勢與排行，暗盤顯示倒數，封盤後揭曉結果。
// 網址加 ?course=wed 或 ?course=thu 可固定顯示某一場，否則跟著管理員目前的場次。
import { useEffect } from 'preact/hooks';
import { clockTime, countdown, wan } from '../../shared/format.ts';
import { splitGroupLabel } from '../../shared/roster.ts';
import { courseLabel, type CourseId, type HistoryPoint, type PublicCourse } from '../../shared/types.ts';
import { useLive, useNow } from '../api.ts';
import { Chart } from '../ui/Chart.tsx';
import { GroupName, PhaseBadge, QrCode, Swatch, groupIndexMap } from '../ui/common.tsx';

export function Screen() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = 'dark';
    root.classList.add('screen-mode');
    return () => root.classList.remove('screen-mode');
  }, []);

  const live = useLive({ history: true });
  const now = useNow(live.offset, 250);
  const forced = new URLSearchParams(location.search).get('course');

  if (!live.pub) return <div class="screen screen-loading">連線中…</div>;

  const course: CourseId = forced === 'wed' || forced === 'thu' ? forced : live.pub.active;
  const pc = live.pub.courses[course];
  const points = live.history?.[course] ?? [];
  const joinUrl = `${location.origin}/`;

  return (
    <div class="screen">
      <header class="screen-header">
        <div class="screen-title">
          <span class="screen-course">{courseLabel(course)}</span>
          <span>期末提報・即時投資</span>
        </div>
        <PhaseBadge phase={pc.phase} remainingMs={pc.darkEndsAt ? pc.darkEndsAt - now : undefined} />
        <div class="screen-stats">
          <span>
            已登入 <strong>{pc.joined}</strong> / {pc.students}
          </span>
          <span>
            已投完 <strong>{pc.fullyInvested}</strong> / {pc.students}
          </span>
          <span class="screen-clock">{clockTime(now)}</span>
          {!live.connected && <span class="screen-offline">重新連線中…</span>}
        </div>
      </header>

      {pc.phase === 'pending' && <PendingView pc={pc} joinUrl={joinUrl} darkMs={live.pub.darkMs} />}
      {pc.phase === 'open' && <LiveView pc={pc} points={points} now={now} joinUrl={joinUrl} />}
      {pc.phase === 'dark' && <DarkView pc={pc} now={now} joinUrl={joinUrl} />}
      {pc.phase === 'closed' && <ResultsView pc={pc} points={points} now={now} />}
    </div>
  );
}

function JoinBox({ joinUrl, big }: { joinUrl: string; big?: boolean }) {
  return (
    <div class={`join${big ? ' join-big' : ''}`}>
      <QrCode text={joinUrl} label="掃描加入投資" />
      <div class="join-text">
        <div class="join-title">手機掃碼加入</div>
        <div class="join-url">{joinUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</div>
        <div class="join-hint">輸入姓名即可，不用密碼</div>
      </div>
    </div>
  );
}

function PendingView({ pc, joinUrl, darkMs }: { pc: PublicCourse; joinUrl: string; darkMs: number }) {
  const idx = groupIndexMap(pc);
  const dark = darkMs % 60_000 === 0 ? `${darkMs / 60_000} 分鐘` : `${Math.round(darkMs / 1000)} 秒`;
  return (
    <main class="screen-pending">
      <div class="pending-main">
        <div class="pending-kicker">等待開盤</div>
        <h1 class="pending-title">用 100 萬，投給你看好的組</h1>
        <ul class="pending-rules">
          <li>每人 100 萬虛擬資金，只能投別組</li>
          <li>單一組最多 50 萬</li>
          <li>沒投完的錢，封盤時從自己那組倒扣</li>
          <li>最後 {dark}暗盤：金額與排名隱藏</li>
          <li>封盤後第 1、2、3 名的組 ×3、×2、×1.5 計算你的報酬</li>
        </ul>
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

function LiveView({ pc, points, now, joinUrl }: { pc: PublicCourse; points: HistoryPoint[]; now: number; joinUrl: string }) {
  const idx = groupIndexMap(pc);
  const ids = pc.groups.map((g) => g.id);
  const before = totalsAt(points, now - 60_000) ?? points[0]?.totals ?? {};
  const ranked = [...pc.groups].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0));
  return (
    <main class="screen-live">
      <section class="screen-chart-panel">
        <Chart groups={ids} points={points} now={now} live label="各組獲得金額的即時走勢" />
      </section>
      <aside class="screen-board">
        <h2 class="board-title">目前排行</h2>
        <ol class="board">
          {ranked.map((g) => {
            const delta = (g.total ?? 0) - (before[g.id] ?? 0);
            return (
              <li key={g.id} class="board-row">
                <span class="board-rank">{g.rank}</span>
                <GroupName id={g.id} index={idx.get(g.id) ?? 0} stacked />
                <span class="board-value">
                  <span class="board-total">
                    {wan(g.total ?? 0)}
                    <small>萬</small>
                  </span>
                  <span class="board-delta">
                    {delta === 0 ? '— 1 分鐘內' : `${delta > 0 ? '▲' : '▼'} ${wan(Math.abs(delta))} 萬 / 1 分鐘`}
                  </span>
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
  const idx = groupIndexMap(pc);
  const left = pc.darkEndsAt ? pc.darkEndsAt - now : 0;
  return (
    <main class="screen-dark">
      <div class="dark-main">
        <div class="dark-kicker">暗盤中 · 金額與排名已隱藏</div>
        <div class="dark-countdown" role="timer" aria-live="off">
          {countdown(left)}
        </div>
        <div class="dark-hint">倒數結束自動封盤 · 還沒投完的同學快調整！</div>
        <div class="pending-groups">
          {pc.groups.map((g) => (
            <span class="group-chip" key={g.id}>
              <GroupName id={g.id} index={idx.get(g.id) ?? 0} />
              <span class="lock" aria-label="已隱藏">
                🔒
              </span>
            </span>
          ))}
        </div>
      </div>
      <JoinBox joinUrl={joinUrl} />
    </main>
  );
}

function ResultsView({ pc, points, now }: { pc: PublicCourse; points: HistoryPoint[]; now: number }) {
  const results = pc.results;
  const idx = groupIndexMap(pc);
  if (!results) return <main class="screen-loading">結算中…</main>;
  const ids = pc.groups.map((g) => g.id);
  const rocket = results.groups.filter((g) => results.rocket.includes(g.group));
  const gods = results.investors.filter((i) => results.stockGods.includes(i.name));
  const top = results.investors.slice(0, 5);
  return (
    <main class="screen-results">
      <section class="awards">
        <div class="award">
          <div class="award-title">🚀 一飛沖天獎</div>
          <div class="award-winners">
            {rocket.map((g) => (
              <div key={g.group} class="award-winner">
                <GroupName id={g.group} index={idx.get(g.group) ?? 0} stacked />
                <span class="award-amount">{wan(g.final)} 萬</span>
              </div>
            ))}
          </div>
        </div>
        <div class="award">
          <div class="award-title">🏆 股神獎</div>
          <div class="award-winners">
            {gods.slice(0, 6).map((i) => (
              <div key={i.name} class="award-winner">
                <span class="award-name">{i.name}</span>
                <span class="award-sub">{splitGroupLabel(i.group).short}</span>
                <span class="award-amount">報酬 {wan(i.payout)} 萬</span>
              </div>
            ))}
            {gods.length > 6 && <div class="award-sub">…等 {gods.length} 人並列</div>}
          </div>
          <ol class="top-investors">
            {top
              .filter((i) => !results.stockGods.includes(i.name))
              .slice(0, 4)
              .map((i) => (
                <li key={i.name}>
                  <span class="ti-rank">{i.rank}</span>
                  <span class="ti-name">{i.name}</span>
                  <span class="ti-amount">{wan(i.payout)} 萬</span>
                </li>
              ))}
          </ol>
        </div>
      </section>
      <section class="final-table-panel">
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
                <td class="ft-rank">{g.rank}</td>
                <td>
                  <GroupName id={g.group} index={idx.get(g.group) ?? 0} />
                </td>
                <td class="num">{wan(g.raw)}</td>
                <td class="num">
                  {g.penalty > 0 ? `−${wan(g.penalty)}` : '0'}
                  {g.deductions.length > 0 && (
                    <div class="ft-deductions">{g.deductions.map((d) => `${d.name} ${wan(d.unspent)}`).join('、')}</div>
                  )}
                </td>
                <td class="num ft-final">{wan(g.final)}</td>
                <td class="num">×{g.multiplier}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="ft-note">單位：萬　倒扣 = 組員封盤時沒投完的錢</div>
      </section>
      <section class="final-chart-panel">
        <Chart
          groups={ids}
          points={points}
          now={now}
          live={false}
          shadeFrom={pc.darkAt}
          shadeTo={pc.closedAt}
          label="完整走勢（含暗盤期間與倒扣）"
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
