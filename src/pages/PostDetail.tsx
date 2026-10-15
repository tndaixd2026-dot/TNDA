import type { JSX } from 'preact';
import type { Post } from '../core/types.ts';
import {
  cancelPost,
  deletePost,
  markDelivered,
  navigate,
  openDetail,
  promoteDraft,
  recallPost,
  restorePost,
  retryFailed,
  sendNow,
  useApp,
} from '../data/store.ts';
import { deliveryOf } from '../core/delivery.ts';
import { fmtDateTime, fmtLong, fmtRelative } from '../core/time.ts';
import { Btn, Drawer, StatusPill, TypeTag, askConfirm, copyText } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { DiscordPreview } from '../ui/DiscordPreview.tsx';
import { useState } from 'preact/hooks';

export function PostDetail({ id }: { id: string }) {
  const { post, channels, posts, previewTheme, busy } = useApp((s) => ({
    post: s.posts.find((p) => p.id === id),
    channels: s.channels,
    posts: s.posts,
    previewTheme: s.config.previewTheme,
    busy: !!s.sending[id],
  }));
  const [working, setWorking] = useState(false);
  if (!post) {
    return (
      <Drawer onClose={() => openDetail(null)} head={<h2 style={{ fontSize: 18 }}>找不到這則貼文</h2>}>
        <p class="muted">它可能已經被刪除了。</p>
      </Drawer>
    );
  }
  const chMap = new Map(channels.map((c) => [c.id, c]));
  const sentLike = post.status === 'sent' || post.status === 'partial';
  const at = Date.parse(post.sentAt ?? post.sendAt);
  const series = post.series ? posts.filter((p) => p.series === post.series && p.id !== post.id).sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt)) : [];
  const edited = post.channels.some((c) => deliveryOf(post, c).editedAt);
  const canRecall = post.channels.some((c) => {
    const d = deliveryOf(post, c);
    return d.status === 'sent' && d.messageId && !d.deletedAt;
  });
  const hasFailed = post.channels.some((c) => deliveryOf(post, c).status === 'failed');
  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
    }
  };

  const foot = (
    <>
      {post.status === 'scheduled' ? (
        <>
          <Btn
            variant="primary"
            icon="zap"
            busy={busy}
            onClick={async () => {
              if (await askConfirm({ title: '現在就發送？', body: `會立刻發到 ${post.channels.length} 個頻道。`, confirmLabel: '立即發送' })) void run(() => sendNow(post.id));
            }}
          >
            立即發送
          </Btn>
          <Btn icon="edit" onClick={() => navigate('compose', { editId: post.id })}>
            編輯
          </Btn>
          <Btn
            variant="danger"
            icon="x"
            onClick={async () => {
              if (await askConfirm({ title: '取消這則排程？', body: '取消後不會發送，之後可以恢復。', confirmLabel: '取消排程', danger: true })) void run(() => cancelPost(post.id));
            }}
          >
            取消排程
          </Btn>
        </>
      ) : null}
      {post.status === 'draft' ? (
        <>
          <Btn variant="primary" icon="clock" onClick={() => void run(() => promoteDraft(post.id, Date.parse(post.sendAt) < Date.now() ? new Date(Date.now() + 10 * 60000).toISOString() : undefined))}>
            加入排程
          </Btn>
          <Btn icon="edit" onClick={() => navigate('compose', { editId: post.id })}>
            編輯
          </Btn>
        </>
      ) : null}
      {post.status === 'canceled' ? (
        <Btn variant="primary" icon="undo" onClick={() => void run(() => restorePost(post.id))}>
          恢復排程
        </Btn>
      ) : null}
      {hasFailed && post.status !== 'scheduled' ? (
        <Btn variant="primary" icon="refresh" busy={busy || working} onClick={() => void run(() => retryFailed(post.id))}>
          重送失敗的頻道
        </Btn>
      ) : null}
      {sentLike ? (
        <Btn icon="edit" onClick={() => navigate('compose', { editId: post.id })}>
          修改內容
        </Btn>
      ) : null}
      {canRecall ? (
        <Btn
          variant="danger"
          icon="undo"
          busy={working}
          onClick={async () => {
            if (await askConfirm({ title: '從 Discord 撤回？', body: '會刪除這則貼文在各頻道的訊息，學生將看不到。發文紀錄會保留。', confirmLabel: '撤回訊息', danger: true })) void run(() => recallPost(post.id));
          }}
        >
          撤回訊息
        </Btn>
      ) : null}
      <Btn icon="copy" onClick={() => navigate('compose', { cloneId: post.id })}>
        複製為新貼文
      </Btn>
      {post.status !== 'scheduled' && post.status !== 'sending' ? (
        <Btn
          variant="ghost"
          icon="trash"
          onClick={async () => {
            if (await askConfirm({ title: '刪除這筆紀錄？', body: sentLike ? '只會刪除平台上的紀錄，Discord 上的訊息不受影響。' : '刪除後無法復原。', confirmLabel: '刪除', danger: true })) void deletePost(post.id);
          }}
        >
          刪除
        </Btn>
      ) : null}
    </>
  );

  return (
    <Drawer
      onClose={() => openDetail(null)}
      head={
        <>
          <div class="row" style={{ gap: 8 }}>
            <TypeTag type={post.type} />
            <StatusPill post={post} />
            {post.seriesLabel ? <span class="pill">{post.seriesLabel}</span> : null}
          </div>
          <h2 style={{ fontSize: 19, marginTop: 6, lineHeight: 1.35 }}>{post.title}</h2>
          <div class="small muted">
            {sentLike ? `已於 ${fmtLong(at)} 發送` : post.status === 'draft' ? '草稿' : `預定 ${fmtLong(post.sendAt)} 發送`}
          </div>
        </>
      }
      foot={foot}
    >
      <div class="stack">
        <DiscordPreview payload={post.payload} channel={chMap.get(post.channels[0])} at={at} theme={previewTheme} edited={edited} />

        <section>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>各頻道的發送結果</h3>
          <div class="delivery-list">
            {post.channels.map((cid) => {
              const c = chMap.get(cid);
              const d = deliveryOf(post, cid);
              const unknown = d.status === 'failed' && /狀態不明/.test(d.error ?? '');
              const icon = d.deletedAt ? 'undo' : d.status === 'sent' ? 'check' : d.status === 'failed' ? 'x' : 'clock';
              const tone = d.deletedAt ? 'gone' : d.status === 'sent' ? 'ok' : d.status === 'failed' ? 'bad' : 'wait';
              return (
                <div key={cid} class="delivery">
                  <span class={`d-icon ${tone}`}>
                    <Icon name={icon} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      <span class="faint mono">{c?.group ?? '?'}</span> {c?.groupName ? `${c.groupName}／` : ''}
                      {c?.name ?? cid}
                    </div>
                    <div class="small muted">
                      {d.deletedAt
                        ? `已於 ${fmtDateTime(d.deletedAt)} 撤回`
                        : d.status === 'sent'
                          ? `${fmtDateTime(d.sentAt ?? post.sentAt ?? post.sendAt)} 送達${d.editedAt ? `，${fmtDateTime(d.editedAt)} 已編輯` : ''}`
                          : d.status === 'sending'
                            ? '發送中…'
                            : d.status === 'failed'
                              ? `嘗試 ${d.attempts} 次${d.retryable && d.attempts < 3 ? '，稍後會自動重試' : ''}`
                              : post.status === 'canceled'
                                ? '已取消'
                                : post.status === 'draft'
                                  ? '草稿，不會發送'
                                  : `等待發送（${fmtRelative(Date.parse(post.sendAt))}）`}
                    </div>
                    {d.error ? <div class="d-err">{d.error}</div> : null}
                  </div>
                  <div>
                    {unknown ? (
                      <Btn size="sm" onClick={() => void markDelivered(post.id, cid)}>
                        已確認送出
                      </Btn>
                    ) : d.messageId ? (
                      <Btn size="sm" variant="ghost" iconOnly icon="copy" onClick={() => void copyText(d.messageId!)} title="複製 Discord 訊息 ID">
                        複製訊息 ID
                      </Btn>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>時間軸</h3>
          <div class="timeline">
            <div class="on">{fmtDateTime(post.createdAt)} 建立</div>
            {post.status !== 'draft' ? <div class={post.status !== 'canceled' ? 'on' : ''}>{fmtDateTime(post.sendAt)} 排定發送</div> : null}
            {post.sentAt ? <div class="on">{fmtDateTime(post.sentAt)} 發送完成</div> : null}
            {post.status === 'canceled' ? <div class="on">{fmtDateTime(post.updatedAt)} 已取消</div> : null}
            {post.draft?.deadline ? <div>{fmtDateTime(post.draft.deadline)} 截止</div> : null}
            {post.draft?.eventAt ? <div>{fmtDateTime(post.draft.eventAt)} 上課／活動開始</div> : null}
          </div>
        </section>

        {series.length ? (
          <section>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>同一組提醒</h3>
            <div class="agenda">
              {series.map((s: Post) => (
                <button key={s.id} type="button" class="agenda-item" onClick={() => openDetail(s.id)} style={{ '--c': 'var(--brand)' } as JSX.CSSProperties}>
                  <span class="bar" />
                  <span class="a-time">{fmtDateTime(s.sendAt)}</span>
                  <span style={{ flex: 1 }}>{s.seriesLabel ?? s.title}</span>
                  <StatusPill post={s} />
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {post.repeat ? (
          <div class="callout">
            <Icon name="repeat" />
            <span>
              每{post.repeat.freq === 'daily' ? '天' : '週'}重複發送{post.repeat.until ? `，直到 ${fmtDateTime(post.repeat.until)}` : ''}。發送後會自動建立下一次的排程。
            </span>
          </div>
        ) : null}

        {post.draft?.raw ? (
          <details>
            <summary class="small" style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>
              原始貼上的文字
            </summary>
            <pre class="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 12, borderRadius: 8, marginTop: 8, fontFamily: 'inherit' }}>
              {post.draft.raw}
            </pre>
          </details>
        ) : null}
      </div>
    </Drawer>
  );
}
