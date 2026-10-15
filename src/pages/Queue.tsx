import { useState } from 'preact/hooks';
import type { Post } from '../core/types.ts';
import { cancelPost, clearHighlight, deletePost, navigate, promoteDraft, restorePost, sendNow, useApp, useNow } from '../data/store.ts';
import { DAY_MS, dayKey, fmtDate, sameTpDay, startOfTpDay } from '../core/time.ts';
import { Btn, Empty, Seg, askConfirm } from '../ui/kit.tsx';
import { PostRow } from '../ui/PostRow.tsx';
import { Icon } from '../ui/icons.tsx';
import { useEffect } from 'preact/hooks';

type Filter = 'upcoming' | 'today' | 'week' | 'draft' | 'canceled';

function relDay(at: number, now: number): string {
  const diff = Math.round((startOfTpDay(at).getTime() - startOfTpDay(now).getTime()) / DAY_MS);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '後天';
  if (diff < 0) return `${-diff} 天前（逾時）`;
  if (diff < 7) return `${diff} 天後`;
  return `${Math.round(diff / 7)} 週後`;
}

export function Queue() {
  const now = useNow(1000);
  const { posts, channels, highlight, sending } = useApp((s) => ({ posts: s.posts, channels: s.channels, highlight: s.highlight, sending: s.sending }));
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(clearHighlight, 3000);
    return () => clearTimeout(t);
  }, []);

  const base = posts.filter((p) => {
    if (filter === 'draft') return p.status === 'draft';
    if (filter === 'canceled') return p.status === 'canceled';
    if (p.status !== 'scheduled' && p.status !== 'sending') return false;
    const at = Date.parse(p.sendAt);
    if (filter === 'today') return sameTpDay(at, now);
    if (filter === 'week') return at < now + 7 * DAY_MS;
    return true;
  });
  const list = base
    .filter((p) => !q.trim() || `${p.title} ${p.draft?.body ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (filter === 'canceled' ? Date.parse(b.sendAt) - Date.parse(a.sendAt) : Date.parse(a.sendAt) - Date.parse(b.sendAt)));

  const groups = new Map<string, Post[]>();
  for (const p of list) {
    const k = dayKey(p.sendAt);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const counts = {
    upcoming: posts.filter((p) => p.status === 'scheduled' || p.status === 'sending').length,
    draft: posts.filter((p) => p.status === 'draft').length,
    canceled: posts.filter((p) => p.status === 'canceled').length,
  };

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">TNDA RELAY / SCHEDULE</div>
          <h1 class="page-title">發送排程</h1>
          <p class="page-sub">時間到會自動發到 Discord。所有時間皆為台北時間。</p>
        </div>
        <div class="page-actions">
          <Btn icon="calendar" onClick={() => navigate('calendar')}>
            行事曆
          </Btn>
          <Btn variant="primary" icon="pen" onClick={() => navigate('compose')}>
            撰寫新貼文
          </Btn>
        </div>
      </div>

      <div class="toolbar">
        <Seg
          label="篩選"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'upcoming', label: `全部 ${counts.upcoming}` },
            { value: 'today', label: '今天' },
            { value: 'week', label: '7 天內' },
            { value: 'draft', label: `草稿 ${counts.draft}` },
            { value: 'canceled', label: `已取消 ${counts.canceled}` },
          ]}
        />
        <div class="search grow">
          <Icon name="filter" />
          <input class="input" placeholder="搜尋標題或內容" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} aria-label="搜尋排程" />
        </div>
      </div>

      {list.length === 0 ? (
        <div class="card">
          <Empty icon={filter === 'draft' ? 'file' : 'clock'} title={filter === 'draft' ? '沒有草稿' : filter === 'canceled' ? '沒有取消的貼文' : '沒有排程中的貼文'}>
            {filter === 'upcoming' ? (
              <Btn variant="primary" icon="pen" onClick={() => navigate('compose')}>
                撰寫新貼文
              </Btn>
            ) : null}
          </Empty>
        </div>
      ) : (
        <div class="board">
          {[...groups.entries()].map(([k, items]) => (
            <section key={k}>
              <div class="board-day">
                {fmtDate(items[0].sendAt, true)}
                <span class="rel">{relDay(Date.parse(items[0].sendAt), now)} · {items.length} 則</span>
              </div>
              {items.map((p) => (
                <PostRow
                  key={p.id}
                  post={p}
                  channels={channels}
                  now={now}
                  highlight={highlight.includes(p.id)}
                  actions={<RowActions post={p} busy={!!sending[p.id]} />}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function RowActions({ post, busy }: { post: Post; busy: boolean }) {
  if (post.status === 'canceled') {
    return (
      <>
        <Btn size="sm" icon="undo" onClick={() => void restorePost(post.id)}>
          恢復
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          iconOnly
          icon="trash"
          onClick={async () => {
            if (await askConfirm({ title: '刪除這則貼文？', body: '刪除後無法復原。', confirmLabel: '刪除', danger: true })) void deletePost(post.id);
          }}
        >
          刪除
        </Btn>
      </>
    );
  }
  if (post.status === 'draft') {
    return (
      <>
        <Btn size="sm" icon="clock" onClick={() => void promoteDraft(post.id, Date.parse(post.sendAt) < Date.now() ? new Date(Date.now() + 10 * 60000).toISOString() : undefined)}>
          加入排程
        </Btn>
        <Btn size="sm" variant="ghost" iconOnly icon="edit" onClick={() => navigate('compose', { editId: post.id })}>
          編輯
        </Btn>
      </>
    );
  }
  return (
    <>
      <Btn
        size="sm"
        variant="ghost"
        iconOnly
        icon="zap"
        busy={busy || post.status === 'sending'}
        onClick={async () => {
          if (await askConfirm({ title: '現在就發送？', body: `「${post.title}」會立刻發到 ${post.channels.length} 個頻道。`, confirmLabel: '立即發送' })) void sendNow(post.id);
        }}
      >
        立即發送
      </Btn>
      <Btn size="sm" variant="ghost" iconOnly icon="edit" disabled={post.status === 'sending'} onClick={() => navigate('compose', { editId: post.id })}>
        編輯
      </Btn>
      <Btn
        size="sm"
        variant="ghost"
        iconOnly
        icon="x"
        disabled={post.status === 'sending'}
        onClick={async () => {
          if (await askConfirm({ title: '取消這則排程？', body: '取消後不會發送，之後可以在「已取消」中恢復。', confirmLabel: '取消排程', danger: true })) void cancelPost(post.id);
        }}
      >
        取消排程
      </Btn>
    </>
  );
}
