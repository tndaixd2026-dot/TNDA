// 發車時刻表的一列：時間、標題、類型、頻道、狀態。

import type { JSX } from 'preact';
import type { Channel, Post } from '../core/types.ts';
import { TYPE_META } from '../format/composer.ts';
import { fmtCountdown, fmtDate, fmtTime } from '../core/time.ts';
import { ChannelChips, StatusPill, TypeTag } from './kit.tsx';
import { Icon } from './icons.tsx';
import { openDetail } from '../data/store.ts';

export function PostRow({
  post,
  channels,
  now,
  showDate,
  highlight,
  actions,
}: {
  post: Post;
  channels: Channel[];
  now: number;
  showDate?: boolean;
  highlight?: boolean;
  actions?: JSX.Element | null;
}) {
  const at = Date.parse(post.sendAt);
  const soon = post.status === 'scheduled' && at - now < 86400000 && at > now;
  return (
    <div
      class={`board-row ${highlight ? 'hl' : ''}`}
      style={{ '--c': TYPE_META[post.type].hex } as JSX.CSSProperties}
      role="button"
      tabIndex={0}
      onClick={() => openDetail(post.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDetail(post.id);
        }
      }}
    >
      <div class="board-time">
        {fmtTime(at)}
        <small>{showDate ? fmtDate(at) : soon ? fmtCountdown(at - now) : post.status === 'draft' ? '草稿' : ''}</small>
      </div>
      <div class="board-info">
        <div class="board-title">{post.title}</div>
        <div class="board-sub">
          <TypeTag type={post.type} />
          <ChannelChips ids={post.channels} channels={channels} max={3} />
          {post.seriesLabel ? (
            <span class="pill">
              <Icon name="bell" style={{ width: 13, height: 13 }} />
              {post.seriesLabel}
            </span>
          ) : null}
          {post.repeat ? (
            <span class="pill">
              <Icon name="repeat" style={{ width: 13, height: 13 }} />
              每{post.repeat.freq === 'daily' ? '天' : '週'}
            </span>
          ) : null}
        </div>
      </div>
      <div class="board-side" onClick={(e) => e.stopPropagation()}>
        <StatusPill post={post} />
        {actions ? <div class="board-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
