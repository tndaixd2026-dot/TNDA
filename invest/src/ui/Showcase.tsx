// 各組作品展示：封面照片、題目 slogan、組員。用在暗盤輪播、封盤後等待頒獎、頒獎畫面。
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { splitGroupLabel } from '../../shared/roster.ts';
import type { CourseId, GroupShowcase, PublicCourse } from '../../shared/types.ts';
import { rpc } from '../api.ts';
import { seriesColor } from './common.tsx';
import { reducedMotion } from './motion.ts';
import { Sparkle } from './y2k.tsx';

// 封面照片另外抓（檔案大），依「場次｜組別｜版本」快取；換照片時版本會變
const covers = new Map<string, Promise<string | null>>();

function loadCover(course: CourseId, group: string, ver: number): Promise<string | null> {
  const key = `${course}|${group}|${ver}`;
  let p = covers.get(key);
  if (!p) {
    p = rpc<{ cover: string | null }>('invest_group_cover', { course, grp: group })
      .then((r) => r.cover)
      .catch(() => {
        covers.delete(key);
        return null;
      });
    covers.set(key, p);
  }
  return p;
}

export function useCover(course: CourseId, group: string, ver: number | null): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (ver === null) return;
    let alive = true;
    void loadCover(course, group, ver).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [course, group, ver]);
  return src;
}

/** 進入暗盤／頒獎前先把這一場的封面都抓好，輪播時不會等 */
export function usePreloadCovers(pc: PublicCourse | undefined) {
  const sig = pc ? pc.groups.map((g) => `${g.id}:${g.coverVer}`).join('|') : '';
  useEffect(() => {
    if (!pc) return;
    for (const g of pc.groups) if (g.coverVer !== null) void loadCover(pc.course, g.id, g.coverVer);
  }, [sig]);
}

/** 封面：有照片顯示照片，沒有就用組別色塊＋大字 */
export function Cover({ course, group, ver, index }: { course: CourseId; group: string; ver: number | null; index: number }) {
  const src = useCover(course, group, ver);
  const { short } = splitGroupLabel(group);
  return (
    <div class={`cover${src ? ' cover-photo' : ' cover-blank'}`} style={{ '--group-color': seriesColor(index) }}>
      {src ? (
        <img src={src} alt={`${short} 作品封面`} />
      ) : (
        <>
          <Sparkle class="cover-spark" size="18%" color="#fff" />
          <span class="cover-blank-text">{short}</span>
        </>
      )}
    </div>
  );
}

export function Members({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div class="members">
      <span class="members-label">組員</span>
      {names.map((n) => (
        <span key={n} class="member">
          {n}
        </span>
      ))}
    </div>
  );
}

/** 一組的展示卡（大螢幕用，rem 為單位會跟著螢幕縮放） */
export function GroupShowcaseCard({
  course,
  group,
  index,
  info,
  children,
}: {
  course: CourseId;
  group: string;
  index: number;
  info: GroupShowcase;
  children?: ComponentChildren;
}) {
  const { short, nick } = splitGroupLabel(group);
  return (
    <article class="showcase">
      <Cover course={course} group={group} ver={info.coverVer} index={index} />
      <div class="showcase-body">
        <div class="showcase-name">
          <span class="showcase-swatch" style={{ background: seriesColor(index) }} />
          <span class="showcase-short">{short}</span>
          {nick && <span class="showcase-nick">{nick}</span>}
        </div>
        {info.slogan && <p class="showcase-slogan">「{info.slogan}」</p>}
        {children}
        <Members names={info.memberNames} />
      </div>
    </article>
  );
}

/** 各組輪播（暗盤、封盤後等待頒獎） */
export function GroupCarousel({ pc, intervalMs = 6000 }: { pc: PublicCourse; intervalMs?: number }) {
  const [i, setI] = useState(0);
  const n = pc.groups.length;
  usePreloadCovers(pc);
  useEffect(() => {
    if (n <= 1 || reducedMotion()) return;
    const id = setInterval(() => setI((x) => (x + 1) % n), intervalMs);
    return () => clearInterval(id);
  }, [n, intervalMs]);
  if (n === 0) return null;
  const k = i % n;
  const g = pc.groups[k];
  return (
    <section class="carousel" aria-label="各組作品輪播">
      <div class="carousel-stage" key={g.id}>
        <GroupShowcaseCard course={pc.course} group={g.id} index={k} info={g} />
      </div>
      <div class="carousel-dots" aria-hidden="true">
        {pc.groups.map((x, j) => (
          <i key={x.id} class={j === k ? 'on' : ''} />
        ))}
      </div>
    </section>
  );
}
