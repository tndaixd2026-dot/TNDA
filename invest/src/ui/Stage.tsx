// 大螢幕舞台：頒獎（一步一步揭曉）與業師總結投影片。由管理員頁按「下一步」切換。
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { wan } from '../../shared/format.ts';
import { splitGroupLabel } from '../../shared/roster.ts';
import { courseLabel, type AwardScene, type CourseId, type PublicState, type SlideScene } from '../../shared/types.ts';
import { rpc } from '../api.ts';
import { THEME, ThemeTag, groupIndexMap, pad2 } from './common.tsx';
import { reducedMotion } from './motion.ts';
import { GroupShowcaseCard, usePreloadCovers } from './Showcase.tsx';
import { Sparkle, Wan } from './y2k.tsx';

const MULT_TEXT: Record<number, string> = { 1: '一飛沖天獎', 2: '第 2 名', 3: '第 3 名' };

/** 灑星星：揭曉時從中間往外噴 */
function Burst({ count = 18 }: { count?: number }) {
  return (
    <div class="burst" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        const dist = 30 + (i % 3) * 12;
        return (
          <Sparkle
            key={i}
            class="burst-star"
            size={`${2 + (i % 4)}rem`}
            color={i % 3 === 0 ? '#fff' : i % 3 === 1 ? 'var(--tnda-orange)' : '#000'}
            style={{
              '--dx': `${Math.cos(angle) * dist}vw`,
              '--dy': `${Math.sin(angle) * dist * 0.6}vh`,
              animationDelay: `${(i % 6) * 40}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

/** 第一名揭曉前的倒數（3、2、1） */
function useDrumroll(ms = 2700): boolean {
  const [done, setDone] = useState(() => reducedMotion());
  useEffect(() => {
    if (done) return;
    const id = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(id);
  }, []);
  return done;
}

function Drumroll({ course, kicker = '第 1 名 · 一飛沖天獎' }: { course: CourseId; kicker?: string }) {
  const [n, setN] = useState(3);
  useEffect(() => {
    const id = setInterval(() => setN((x) => Math.max(1, x - 1)), 900);
    return () => clearInterval(id);
  }, []);
  return (
    <div class="drumroll">
      <div class="drumroll-kicker">
        {courseLabel(course)} · {kicker}
      </div>
      <div class="drumroll-num" key={n}>
        {n}
      </div>
    </div>
  );
}

export function AwardsView({ scene, pub }: { scene: AwardScene; pub: PublicState }) {
  // 先把這一場的封面抓好
  const pc = 'course' in scene ? pub.courses[scene.course] : undefined;
  usePreloadCovers(pc);
  switch (scene.kind) {
    case 'title':
      return (
        <main class="stage stage-title">
          <Sparkle class="stage-spark s1" size="7rem" color="#fff" />
          <Sparkle class="stage-spark s2" size="3.5rem" color="#000" />
          <Sparkle class="stage-spark s3" size="5rem" color="#fff" />
          <ThemeTag size="lg" />
          <h1 class="stage-hero">
            <span class="display">Awards</span>
            <span class="stage-hero-zh">頒獎典禮</span>
          </h1>
          <p class="stage-lead">一飛沖天獎 · 股神獎 · TNDA 天使投資獎</p>
        </main>
      );
    case 'intro':
      return (
        <main class="stage stage-intro">
          <div class="stage-kicker">Results · 結果揭曉</div>
          <h1 class="stage-course">{courseLabel(scene.course)}</h1>
          <div class="stage-facts">
            <span>
              <strong>{scene.groups}</strong> 組
            </span>
            <span>
              <strong>{scene.investors}</strong> 人投資
            </span>
          </div>
          <p class="stage-lead">先頒天使投資獎 →</p>
        </main>
      );
    case 'podium':
    case 'rocket':
      return <PodiumView scene={scene} pub={pub} />;
    case 'stockgod':
      return (
        <main class="stage stage-god">
          <Burst />
          <div class="stage-kicker">
            {courseLabel(scene.course)} · Top Investor
          </div>
          <h1 class="stage-award-title">股神獎</h1>
          <div class="god-list">
            {scene.winners.length === 0 && <p class="stage-lead">無人投資</p>}
            {scene.winners.slice(0, 6).map((w) => (
              <div class="god" key={w.name}>
                <span class="god-name">{w.name}</span>
                <span class="god-group">{splitGroupLabel(w.group).short}</span>
                <span class="god-payout">
                  報酬 <Wan value={w.payout} ms={1800} from={0} /> 萬
                </span>
              </div>
            ))}
            {scene.winners.length > 6 && <p class="stage-lead">…等 {scene.winners.length} 人並列</p>}
          </div>
          <p class="stage-note">共 {scene.investors} 人投資 · 同分比下注快慢</p>
        </main>
      );
    case 'angel':
      return <AngelView scene={scene} pub={pub} />;
    case 'finale':
      return (
        <main class="stage stage-finale">
          <Sparkle class="stage-spark s1" size="6rem" color="#fff" />
          <Sparkle class="stage-spark s3" size="4rem" color="#000" />
          <h1 class="stage-hero">
            <span class="display">Congrats</span>
            <span class="stage-hero-zh">恭喜所有組別！</span>
          </h1>
          <div class="finale-grid">
            {scene.courses.map((c) => (
              <div class="finale-card" key={c.course}>
                <div class="finale-course">{courseLabel(c.course)}</div>
                <div class="finale-line">
                  <span class="finale-label">一飛沖天</span>
                  {c.rocket.map((g) => splitGroupLabel(g).short).join('、')}
                </div>
                <div class="finale-line">
                  <span class="finale-label">股神</span>
                  {c.stockGods.length ? c.stockGods.map((g) => g.name).join('、') : '從缺'}
                </div>
                {c.angel?.length > 0 && (
                  <div class="finale-line">
                    <span class="finale-label">天使投資</span>
                    {c.angel.map((g) => splitGroupLabel(g).short).join('、')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </main>
      );
    default:
      return null;
  }
}

function PodiumView({ scene, pub }: { scene: Extract<AwardScene, { kind: 'podium' | 'rocket' }>; pub: PublicState }) {
  const isFirst = scene.kind === 'rocket';
  const revealed = useDrumroll(isFirst ? 2700 : 0);
  const idx = groupIndexMap(pub.courses[scene.course]);
  if (isFirst && !revealed) {
    return (
      <main class="stage stage-drum">
        <Drumroll course={scene.course} />
      </main>
    );
  }
  const many = scene.groups.length > 1;
  return (
    <main class={`stage stage-podium${isFirst ? ' stage-first' : ''}${many ? ' stage-many' : ''}`}>
      {isFirst && <Burst count={24} />}
      <div class="podium-head">
        <span class="podium-rank">No.{pad2(scene.rank)}</span>
        <span class="podium-title">
          <span class="podium-course">{courseLabel(scene.course)}</span>
          <span class="podium-award">{MULT_TEXT[scene.rank] ?? `第 ${scene.rank} 名`}</span>
        </span>
        <span class="podium-mult">×{scene.groups[0]?.multiplier}</span>
      </div>
      <div class="podium-cards">
        {scene.groups.map((g) => (
          <GroupShowcaseCard key={g.group} course={scene.course} group={g.group} index={idx.get(g.group) ?? 0} info={g}>
            <div class="showcase-amount">
              最終金額 <Wan value={g.final} ms={1600} from={0} /> 萬
              {g.penalty > 0 && <small>（倒扣 {wan(g.penalty)} 萬）</small>}
            </div>
          </GroupShowcaseCard>
        ))}
      </div>
    </main>
  );
}

/** TNDA 天使投資獎：業師評分選出的組。3、2、1 倒數後揭曉；還沒選得獎組別時顯示「業師評分中」 */
function AngelView({ scene, pub }: { scene: Extract<AwardScene, { kind: 'angel' }>; pub: PublicState }) {
  const has = scene.groups.length > 0;
  const revealed = useDrumroll(has ? 2700 : 0);
  const idx = groupIndexMap(pub.courses[scene.course]);
  if (!has) {
    return (
      <main class="stage stage-angel stage-angel-wait">
        <div class="stage-kicker">{courseLabel(scene.course)} · Angel Award</div>
        <h1 class="stage-award-title">TNDA 天使投資獎</h1>
        <p class="stage-lead">業師評分中…</p>
      </main>
    );
  }
  if (!revealed) {
    return (
      <main class="stage stage-drum stage-angel">
        <Drumroll course={scene.course} kicker="TNDA 天使投資獎 · 業師評分" />
      </main>
    );
  }
  const many = scene.groups.length > 1;
  return (
    <main class={`stage stage-podium stage-first stage-angel${many ? ' stage-many' : ''}`}>
      <Burst count={24} />
      <div class="podium-head">
        <span class="podium-rank">Angel</span>
        <span class="podium-title">
          <span class="podium-course">{courseLabel(scene.course)} · 業師評分</span>
          <span class="podium-award">TNDA 天使投資獎</span>
        </span>
      </div>
      <div class="podium-cards">
        {scene.groups.map((g) => (
          <GroupShowcaseCard key={g.group} course={scene.course} group={g.group} index={idx.get(g.group) ?? 0} info={g} />
        ))}
      </div>
    </main>
  );
}

// ---------- 業師總結投影片 ----------

const slideImages = new Map<string, Promise<string | null>>();
function useSlideImage(id: number, ver: number | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (ver === null) return;
    const key = `${id}|${ver}`;
    let p = slideImages.get(key);
    if (!p) {
      p = rpc<{ image: string | null }>('invest_slide_image', { id }).then((r) => r.image).catch(() => null);
      slideImages.set(key, p);
    }
    let alive = true;
    void p.then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [id, ver]);
  return src;
}

function Lines({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return (
    <ul class="slide-lines">
      {lines.map((l, i) => (
        <li key={i} style={{ animationDelay: `${150 + i * 90}ms` }}>
          <span class="rule-num">{pad2(i + 1)}</span>
          {l.replace(/^[-•・*]\s*/, '')}
        </li>
      ))}
    </ul>
  );
}

export function SlideView({ scene, step, total }: { scene: SlideScene; step: number; total: number }) {
  const img = useSlideImage(scene.id, scene.imageVer);
  let body: ComponentChildren;
  if (scene.kind === 'title') {
    body = (
      <div class="slide-titlepage">
        <Sparkle class="stage-spark s1" size="6rem" color="#fff" />
        <Sparkle class="stage-spark s2" size="3rem" color="#000" />
        <ThemeTag size="lg" />
        <h1 class="slide-hero">{scene.title}</h1>
        {scene.subtitle && <p class="slide-sub">{scene.subtitle}</p>}
        {scene.body && <p class="slide-sub">{scene.body}</p>}
      </div>
    );
  } else if (scene.kind === 'recap') {
    body = (
      <div class="slide-recap">
        <h1 class="slide-title">{scene.title || '數字回顧'}</h1>
        {scene.subtitle && <p class="slide-sub">{scene.subtitle}</p>}
        <div class="recap-grid">
          {(scene.recap ?? []).map((c) => (
            <div class="recap-card" key={c.course}>
              <div class="recap-course">{courseLabel(c.course)}</div>
              <div class="recap-stats">
                <span>
                  <strong>
                    {c.joined}
                    <small> / {c.students}</small>
                  </strong>
                  <em>人參與</em>
                </span>
                <span>
                  <strong>{wan(c.invested)}</strong>
                  <em>萬 總投資</em>
                </span>
              </div>
              {c.rocket && (
                <div class="recap-line">
                  <span class="finale-label">一飛沖天</span>
                  {c.rocket.map((g) => splitGroupLabel(g).short).join('、')}
                </div>
              )}
              {c.stockGods && (
                <div class="recap-line">
                  <span class="finale-label">股神</span>
                  {c.stockGods.length ? c.stockGods.map((g) => g.name).join('、') : '從缺'}
                </div>
              )}
              {c.angel && c.angel.length > 0 && (
                <div class="recap-line">
                  <span class="finale-label">天使投資</span>
                  {c.angel.map((g) => splitGroupLabel(g).short).join('、')}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <div class={`slide-text${img ? ' with-image' : ''}`}>
        <div class="slide-text-main">
          <h1 class="slide-title">{scene.title}</h1>
          {scene.subtitle && <p class="slide-sub">{scene.subtitle}</p>}
          <Lines text={scene.body} />
        </div>
        {img && <img class="slide-image" src={img} alt="" />}
      </div>
    );
  }
  return (
    <main class={`stage stage-slide slide-${scene.kind}`}>
      {body}
      <footer class="slide-foot">
        <span>期末提報「{THEME}」 · 業師總結</span>
        <span class="slide-page">
          {pad2(step + 1)} / {pad2(total)}
        </span>
      </footer>
    </main>
  );
}
