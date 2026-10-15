import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import type { Post } from '../core/types.ts';
import { navigate, openDetail, reschedule, toast, useApp, useNow } from '../data/store.ts';
import { DAY_MS, WEEKDAYS, atTime, dayKey, fmtDate, fmtTime, fromTp, tpParts } from '../core/time.ts';
import { TYPE_META } from '../format/composer.ts';
import { Btn, StatusPill, TypeTag } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';

interface Item {
  key: string;
  kind: 'post' | 'event' | 'deadline';
  at: number;
  post: Post;
  label: string;
}

export function CalendarPage() {
  const now = useNow(60000);
  const { posts } = useApp((s) => ({ posts: s.posts }));
  const today = tpParts(now);
  const [ym, setYm] = useState({ y: today.y, m: today.m });
  const [selected, setSelected] = useState(dayKey(now));
  const [layers, setLayers] = useState({ post: true, event: true, deadline: true });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const items = useMemo(() => {
    const byDay = new Map<string, Item[]>();
    const add = (it: Item) => {
      const k = dayKey(it.at);
      byDay.set(k, [...(byDay.get(k) ?? []), it]);
    };
    const seenEvent = new Set<string>();
    for (const p of posts) {
      if (p.status !== 'canceled') add({ key: `p-${p.id}`, kind: 'post', at: Date.parse(p.sendAt), post: p, label: p.title });
      if (p.status === 'canceled') continue;
      // 同一組提醒共用同一個活動時間，只顯示一次
      const sig = `${p.series ?? p.id}|${p.draft?.eventAt}|${p.draft?.deadline}`;
      if (seenEvent.has(sig)) continue;
      seenEvent.add(sig);
      if (p.draft?.eventAt) add({ key: `e-${p.id}`, kind: 'event', at: Date.parse(p.draft.eventAt), post: p, label: p.title.replace(/提醒$/, '') });
      if (p.draft?.deadline) add({ key: `d-${p.id}`, kind: 'deadline', at: Date.parse(p.draft.deadline), post: p, label: `截止：${p.title.replace(/(繳交)?提醒$/, '')}` });
    }
    for (const list of byDay.values()) list.sort((a, b) => a.at - b.at);
    return byDay;
  }, [posts]);

  const first = fromTp(ym.y, ym.m, 1, 12);
  const startDow = tpParts(first).dow;
  const gridStart = first.getTime() - startDow * DAY_MS;
  const days = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY_MS);
  const visible = (it: Item) => layers[it.kind];

  const move = (delta: number) => {
    const m = ym.m + delta;
    setYm({ y: ym.y + Math.floor((m - 1) / 12), m: ((m - 1 + 1200) % 12) + 1 });
  };

  const selItems = (items.get(selected) ?? []).filter(visible);
  const selDate = Date.parse(`${selected}T12:00:00+08:00`);

  async function onDrop(day: number) {
    setDropKey(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const p = posts.find((x) => x.id === id);
    if (!p) return;
    const t = tpParts(p.sendAt);
    const target = atTime(day, t.hh, t.mm);
    if (dayKey(target) === dayKey(p.sendAt)) return;
    if (target.getTime() < Date.now()) {
      toast('error', '不能改到已經過去的時間');
      return;
    }
    await reschedule(id, target.toISOString());
  }

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">TNDA RELAY / CALENDAR</div>
          <h1 class="page-title">行事曆</h1>
          <p class="page-sub">看每天要發的貼文，以及上課、截止的時間。桌機上可以把排程拖到其他天改期。</p>
        </div>
        <div class="page-actions">
          <Btn variant="primary" icon="pen" onClick={() => navigate('compose')}>
            撰寫新貼文
          </Btn>
        </div>
      </div>

      <div class="cal-layout">
        <section>
          <div class="cal-head">
            <Btn variant="ghost" iconOnly icon="left" onClick={() => move(-1)}>
              上個月
            </Btn>
            <h2>
              {ym.y} 年 {ym.m} 月
            </h2>
            <Btn variant="ghost" iconOnly icon="right" onClick={() => move(1)}>
              下個月
            </Btn>
            <Btn
              size="sm"
              onClick={() => {
                setYm({ y: today.y, m: today.m });
                setSelected(dayKey(now));
              }}
            >
              今天
            </Btn>
            <div class="cal-legend">
              {(
                [
                  ['post', '發文'],
                  ['event', '上課／活動'],
                  ['deadline', '截止'],
                ] as Array<[keyof typeof layers, string]>
              ).map(([k, label]) => (
                <label key={k} class="check small" for={`layer-${k}`}>
                  <input id={`layer-${k}`} type="checkbox" checked={layers[k]} onChange={() => setLayers({ ...layers, [k]: !layers[k] })} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <div class="cal" role="grid" aria-label={`${ym.y} 年 ${ym.m} 月`}>
            {WEEKDAYS.map((w) => (
              <div key={w} class="cal-dow" role="columnheader">
                {w}
              </div>
            ))}
            {days.map((d) => {
              const k = dayKey(d);
              const p = tpParts(d);
              const list = (items.get(k) ?? []).filter(visible);
              const shown = list.slice(0, 3);
              return (
                <div
                  key={k}
                  tabIndex={0}
                  role="gridcell"
                  class={`cal-day ${p.m !== ym.m ? 'other' : ''} ${k === dayKey(now) ? 'today' : ''} ${k === selected ? 'selected' : ''} ${dropKey === k ? 'drop' : ''}`}
                  onClick={() => setSelected(k)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(k);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    setDropKey(k);
                  }}
                  onDragLeave={() => setDropKey((x) => (x === k ? null : x))}
                  onDrop={(e) => {
                    e.preventDefault();
                    void onDrop(d);
                  }}
                  aria-label={`${p.m} 月 ${p.d} 日，${list.length} 個項目`}
                >
                  <span class="cal-num">
                    <span>{p.d}</span>
                  </span>
                  {shown.map((it) => (
                    <Chip key={it.key} it={it} onDragStart={(id) => setDragId(id)} onDragEnd={() => setDragId(null)} />
                  ))}
                  {list.length > 3 ? <span class="cal-more">還有 {list.length - 3} 項</span> : null}
                </div>
              );
            })}
          </div>
        </section>

        <aside class="card card-pad">
          <div class="row" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 16, flex: 1 }}>{fmtDate(selDate)}</h3>
            <Btn
              size="sm"
              icon="plus"
              onClick={() => {
                const at = atTime(selDate, 20);
                navigate('compose', { presetAt: (at.getTime() > Date.now() ? at : new Date(Math.ceil((Date.now() + 3600000) / 1800000) * 1800000)).toISOString() });
              }}
            >
              這天發文
            </Btn>
          </div>
          {selItems.length ? (
            <div class="agenda">
              {selItems.map((it) => (
                <button key={it.key} type="button" class="agenda-item" style={{ '--c': it.kind === 'deadline' ? 'var(--danger)' : TYPE_META[it.post.type].hex } as JSX.CSSProperties} onClick={() => openDetail(it.post.id)}>
                  <span class="bar" />
                  <span class="a-time">{fmtTime(it.at)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{it.label}</span>
                    <span class="row" style={{ gap: 8, marginTop: 2 }}>
                      {it.kind === 'post' ? <StatusPill post={it.post} /> : <span class="pill">{it.kind === 'event' ? '上課／活動' : '截止'}</span>}
                      <TypeTag type={it.post.type} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p class="small muted">這天沒有安排。</p>
          )}
          <p class="small faint" style={{ marginTop: 14 }}>
            <Icon name="info" style={{ width: 14, height: 14, verticalAlign: '-2px' }} /> 實心標籤是發文時間，虛線是上課或活動時間，紅色是截止時間。
          </p>
        </aside>
      </div>
    </>
  );
}

function Chip({ it, onDragStart, onDragEnd }: { it: Item; onDragStart: (id: string) => void; onDragEnd: () => void }) {
  const p = it.post;
  const draggable = it.kind === 'post' && (p.status === 'scheduled' || p.status === 'draft');
  const color = it.kind === 'deadline' ? 'var(--danger)' : TYPE_META[p.type].hex;
  const cls = it.kind === 'post' ? `${['sent', 'partial'].includes(p.status) ? 'done' : ''} ${['failed', 'partial'].includes(p.status) ? 'bad' : ''}` : 'event';
  return (
    <span
      class={`cal-chip ${cls}`}
      style={{ '--c': color } as JSX.CSSProperties}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', p.id);
        onDragStart(p.id);
      }}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        e.stopPropagation();
        openDetail(p.id);
      }}
      title={`${fmtTime(it.at)} ${it.label}`}
    >
      <span class="mono">{fmtTime(it.at)}</span>
      <span class="cal-chip-label">
        {it.kind === 'deadline' ? '⏰ ' : ''}
        {it.label}
      </span>
    </span>
  );
}
