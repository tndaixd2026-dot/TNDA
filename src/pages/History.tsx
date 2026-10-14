import { useMemo, useState } from 'preact/hooks';
import type { Post, PostStatus, PostType } from '../core/types.ts';
import { openDetail, useApp } from '../data/store.ts';
import { fmtDate, fmtDateTime, fmtTime, tpParts } from '../core/time.ts';
import { summarize } from '../core/delivery.ts';
import { POST_TYPES, TYPE_META } from '../format/composer.ts';
import { groupChannels } from '../core/channels.ts';
import { ChannelChips, Empty, STATUS_LABEL, Seg, StatusPill, TypeTag, downloadText, Btn } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { DEMO_ONLY } from '../data/config.ts';

type StatusFilter = 'past' | 'all' | 'sent' | 'problem' | 'scheduled' | 'draft' | 'canceled';

const STATUS_GROUPS: Record<StatusFilter, PostStatus[]> = {
  past: ['sent', 'partial', 'failed'],
  all: ['draft', 'scheduled', 'sending', 'sent', 'partial', 'failed', 'canceled'],
  sent: ['sent'],
  problem: ['failed', 'partial'],
  scheduled: ['scheduled', 'sending'],
  draft: ['draft'],
  canceled: ['canceled'],
};

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function History() {
  const { posts, channels } = useApp((s) => ({ posts: s.posts, channels: s.channels }));
  const [status, setStatus] = useState<StatusFilter>('past');
  const [type, setType] = useState<PostType | ''>('');
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const groups = groupChannels(channels);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return posts
      .filter((p) => STATUS_GROUPS[status].includes(p.status))
      .filter((p) => !type || p.type === type)
      .filter((p) => !group || p.channels.some((c) => channels.find((x) => x.id === c)?.group === group))
      .filter((p) => !term || `${p.title}\n${p.draft?.body ?? ''}\n${p.draft?.raw ?? ''}`.toLowerCase().includes(term))
      .sort((a, b) => Date.parse(b.sentAt ?? b.sendAt) - Date.parse(a.sentAt ?? a.sendAt));
  }, [posts, status, type, group, q, channels]);

  const rows: Array<{ month: string } | { post: Post }> = [];
  let lastMonth = '';
  for (const p of list) {
    const t = tpParts(p.sentAt ?? p.sendAt);
    const m = `${t.y} 年 ${t.m} 月`;
    if (m !== lastMonth) {
      rows.push({ month: m });
      lastMonth = m;
    }
    rows.push({ post: p });
  }

  const problems = posts.filter((p) => p.status === 'failed' || p.status === 'partial').length;

  function exportCsv() {
    const name = new Map(channels.map((c) => [c.id, `${c.group}·${c.name}`]));
    const lines = [['發送時間', '標題', '類型', '頻道', '狀態', '成功', '失敗'].join(',')];
    for (const p of list) {
      const s = summarize(p);
      lines.push(
        [fmtDateTime(p.sentAt ?? p.sendAt, true), p.title, TYPE_META[p.type].label, p.channels.map((c) => name.get(c) ?? c).join('、'), STATUS_LABEL[p.status], String(s.sent), String(s.failed)]
          .map(csvCell)
          .join(','),
      );
    }
    downloadText(`tnda-relay-紀錄-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + lines.join('\n'), 'text/csv');
  }

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <h1 class="page-title">發文紀錄</h1>
          <p class="page-sub">所有貼文與每個頻道的發送結果。點一列可以查看內容、重送或撤回。</p>
        </div>
        <div class="page-actions">
          {!DEMO_ONLY ? (
            <Btn icon="download" onClick={exportCsv} disabled={!list.length}>
              匯出 CSV
            </Btn>
          ) : null}
        </div>
      </div>

      <div class="toolbar">
        <Seg
          label="狀態"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'past', label: '已發出' },
            { value: 'problem', label: problems ? `需處理 ${problems}` : '需處理' },
            { value: 'scheduled', label: '排程中' },
            { value: 'draft', label: '草稿' },
            { value: 'canceled', label: '已取消' },
            { value: 'all', label: '全部' },
          ]}
        />
        <select class="select" style={{ width: 'auto' }} value={type} onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value as PostType | '')} aria-label="類型">
          <option value="">所有類型</option>
          {POST_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_META[t].label}
            </option>
          ))}
        </select>
        <select class="select" style={{ width: 'auto' }} value={group} onChange={(e) => setGroup((e.currentTarget as HTMLSelectElement).value)} aria-label="群組">
          <option value="">所有群組</option>
          {groups.map((g) => (
            <option key={g.code} value={g.code}>
              {g.code}｜{g.name}
            </option>
          ))}
        </select>
        <div class="search grow">
          <Icon name="filter" />
          <input class="input" placeholder="搜尋標題、內文、原始文字" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} aria-label="搜尋紀錄" />
        </div>
      </div>

      {list.length === 0 ? (
        <div class="card">
          <Empty icon="list" title="沒有符合條件的貼文" />
        </div>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>時間</th>
                <th>貼文</th>
                <th>頻道</th>
                <th>狀態</th>
                <th>結果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) =>
                'month' in r ? (
                  <tr key={`m${i}`} class="month-row">
                    <td colSpan={5}>{r.month}</td>
                  </tr>
                ) : (
                  <HistoryRow key={r.post.id} post={r.post} />
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      <p class="small faint" style={{ marginTop: 10 }}>
        共 {list.length} 則
      </p>
    </>
  );
}

function HistoryRow({ post }: { post: Post }) {
  const channels = useApp((s) => s.channels);
  const at = post.sentAt ?? post.sendAt;
  const s = summarize(post);
  return (
    <tr
      tabIndex={0}
      onClick={() => openDetail(post.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') openDetail(post.id);
      }}
    >
      <td class="t-when mono">
        {fmtDate(at)} {fmtTime(at)}
      </td>
      <td>
        <div class="t-title">{post.title}</div>
        <TypeTag type={post.type} />
      </td>
      <td>
        <ChannelChips ids={post.channels} channels={channels} max={3} />
      </td>
      <td>
        <StatusPill post={post} />
      </td>
      <td class="mono small">
        {post.status === 'draft' || post.status === 'canceled' || (post.status === 'scheduled' && s.sent + s.failed === 0) ? (
          <span class="faint">—</span>
        ) : (
          <>
            <span style={{ color: 'var(--post-text)' }}>{s.sent}✓</span>
            {s.failed ? <span style={{ color: 'var(--express-text)', marginLeft: 6 }}>{s.failed}✗</span> : null}
            <span class="faint"> / {s.total}</span>
          </>
        )}
      </td>
    </tr>
  );
}
