import { navigate, openDetail, runSchedulerNow, sendNow, updateConfig, useApp, useNow } from '../data/store.ts';
import { DAY_MS, WEEKDAYS, fmtCountdown, fmtDateTime, fmtLong, fmtRelative, sameTpDay, tpParts } from '../core/time.ts';
import { Btn, ChannelChips, Empty, StatusPill, TypeTag, askConfirm } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { PostRow } from '../ui/PostRow.tsx';
import { SCHEDULER_STALE_MS } from '../data/setup.ts';
import { deliveryOf } from '../core/delivery.ts';
import type { Post } from '../core/types.ts';

function greeting(hh: number): string {
  if (hh < 5) return '夜深了';
  if (hh < 11) return '早安';
  if (hh < 14) return '午安';
  if (hh < 18) return '下午好';
  return '晚安';
}

export function Dashboard() {
  const now = useNow(1000);
  const { posts, channels, scheduler, mode, repo, precision, sending } = useApp((s) => ({
    posts: s.posts,
    channels: s.channels,
    scheduler: s.scheduler,
    mode: s.config.mode,
    repo: `${s.config.owner}/${s.config.repo}`,
    precision: s.config.precision,
    sending: s.sending,
  }));
  const p = tpParts(now);
  const upcoming = posts
    .filter((x) => x.status === 'scheduled' || x.status === 'sending')
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
  const next = upcoming[0];
  const week = upcoming.filter((x) => Date.parse(x.sendAt) < now + 7 * DAY_MS);
  const today = posts.filter((x) => x.status !== 'canceled' && x.status !== 'draft' && sameTpDay(x.sendAt, now));
  const sentWeek = posts.filter((x) => x.sentAt && Date.parse(x.sentAt) > now - 7 * DAY_MS && (x.status === 'sent' || x.status === 'partial'));
  const attention = posts.filter((x) => x.status === 'failed' || x.status === 'partial');
  const recent = posts
    .filter((x) => x.sentAt)
    .sort((a, b) => Date.parse(b.sentAt!) - Date.parse(a.sentAt!))
    .slice(0, 5);
  const lastRun = scheduler.runs[0];
  // 外部定時器每 5 分鐘觸發一次；超過 20 分鐘沒有執行，代表貼文可能會延遲
  const stale = mode === 'github' && !!lastRun && now - Date.parse(lastRun.created_at) > SCHEDULER_STALE_MS;
  const configured = channels.filter((c) => c.webhook).length;

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">
            {p.y} 年 {p.m} 月 {p.d} 日 星期{WEEKDAYS[p.dow]}
          </div>
          <h1 class="page-title">
            {greeting(p.hh)}，<span class="accent">今天要發什麼？</span>
          </h1>
          <p class="page-sub">
            接下來 7 天有 <b>{week.length}</b> 則貼文會自動發送{attention.length ? `，有 ${attention.length} 則需要處理` : ''}。
          </p>
        </div>
        <div class="page-actions">
          <Btn variant="primary" icon="pen" onClick={() => navigate('compose')}>
            撰寫新貼文
          </Btn>
        </div>
      </div>

      {next ? <NextTicket post={next} now={now} busy={!!sending[next.id]} /> : (
        <div class="card card-pad">
          <Empty icon="send" title="目前沒有排程中的貼文">
            <p class="small">把上課提醒、作業通知貼進來，系統會整理好並在指定時間發到 Discord。</p>
            <Btn variant="primary" icon="pen" onClick={() => navigate('compose')}>
              撰寫第一則
            </Btn>
          </Empty>
        </div>
      )}

      <div class="stats">
        <button type="button" class="stat" onClick={() => navigate('queue')}>
          <span class="n">{upcoming.length}</span>
          <span class="l">待發送</span>
        </button>
        <button type="button" class="stat" onClick={() => navigate('calendar')}>
          <span class="n">{today.length}</span>
          <span class="l">今天的貼文</span>
        </button>
        <button type="button" class="stat" onClick={() => navigate('history')}>
          <span class="n">{sentWeek.length}</span>
          <span class="l">近 7 天已發送</span>
        </button>
        <button type="button" class={`stat ${attention.length ? 'alert' : ''}`} onClick={() => navigate('history')}>
          <span class="n">{attention.length}</span>
          <span class="l">需要處理</span>
        </button>
      </div>

      <div class="dash-grid">
        <section>
          <div class="row" style={{ marginBottom: 4 }}>
            <h3 style={{ fontSize: 16, flex: 1 }}>接下來 7 天</h3>
            <Btn variant="ghost" size="sm" onClick={() => navigate('queue')}>
              全部排程 <Icon name="right" />
            </Btn>
          </div>
          {week.length ? (
            <div class="board" style={{ marginTop: 8 }}>
              {week.slice(0, 7).map((x) => (
                <PostRow key={x.id} post={x} channels={channels} now={now} showDate />
              ))}
            </div>
          ) : (
            <div class="card">
              <Empty icon="calendar" title="這週還沒有排程">
                <p class="small">可以先排好下週的上課提醒。</p>
              </Empty>
            </div>
          )}
          {attention.length ? (
            <>
              <h3 style={{ fontSize: 16, margin: '22px 0 8px' }}>需要處理</h3>
              <div class="board">
                {attention.slice(0, 4).map((x) => (
                  <PostRow key={x.id} post={x} channels={channels} now={now} showDate />
                ))}
              </div>
            </>
          ) : null}
        </section>

        <aside class="stack">
          <div class="card">
            <div class="panel-head">
              <h3>最近發送</h3>
              <Btn variant="ghost" size="sm" onClick={() => navigate('history')}>
                紀錄
              </Btn>
            </div>
            {recent.length ? (
              <div style={{ padding: '0 6px 8px' }}>
                {recent.map((x) => (
                  <RecentItem key={x.id} post={x} />
                ))}
              </div>
            ) : (
              <p class="small muted" style={{ padding: '0 18px 16px' }}>
                還沒有發送紀錄。
              </p>
            )}
          </div>

          <div class="card health">
            <div class="panel-head">
              <h3>系統狀態</h3>
              {mode === 'github' ? (
                <Btn variant="ghost" size="sm" icon="play" onClick={() => void runSchedulerNow()}>
                  立即執行排程器
                </Btn>
              ) : null}
            </div>
            <div class="health-row">
              <Icon name={mode === 'github' ? 'cloud' : 'phone'} />
              <div class="h-main">
                <div class="h-title">{mode === 'github' ? '雲端同步' : '本機 Demo'}</div>
                <div class="h-desc">{mode === 'github' ? `資料加密存在 GitHub：${repo}` : '資料只存在這個瀏覽器'}</div>
              </div>
              <span class="pill pill-ok">
                <span class="dot" />
                正常
              </span>
            </div>
            <div class="health-row">
              <Icon name="activity" />
              <div class="h-main">
                <div class="h-title">排程器（GitHub Actions）</div>
                <div class="h-desc">
                  {lastRun
                    ? `上次執行 ${fmtRelative(Date.parse(lastRun.updated_at), now)}${lastRun.status !== 'completed' ? '（執行中）' : ''}`
                    : scheduler.error
                      ? '讀不到執行紀錄（Token 可能沒有 Actions 權限）'
                      : '還沒有執行紀錄'}
                  {stale ? '。間隔太久，排程貼文可能會晚發，請到「設定」完成「準時發送設定」。' : ''}
                </div>
              </div>
              {lastRun ? (
                <span class={`pill ${lastRun.status === 'completed' && lastRun.conclusion !== 'success' ? 'pill-bad' : stale ? 'pill-warn' : 'pill-ok'}`}>
                  <span class="dot" />
                  {lastRun.status !== 'completed' ? '執行中' : lastRun.conclusion !== 'success' ? '失敗' : stale ? '延遲' : '正常'}
                </span>
              ) : (
                <span class="pill">
                  <span class="dot" />
                  未知
                </span>
              )}
            </div>
            {stale ? (
              <div class="health-row" style={{ paddingTop: 0, borderTop: 0 }}>
                <span style={{ width: 18 }} />
                <Btn size="sm" icon="sliders" onClick={() => navigate('settings')}>
                  前往準時發送設定
                </Btn>
              </div>
            ) : null}
            <div class="health-row">
              <Icon name="zap" />
              <div class="h-main">
                <div class="h-title">準時代發</div>
                <div class="h-desc">網站開著時，到時間就由這台裝置直接發送，不用等排程器。</div>
              </div>
              {mode === 'github' ? (
                <button type="button" class={`pill ${precision ? 'pill-ok' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => updateConfig({ precision: !precision })}>
                  <span class="dot" />
                  {precision ? '開啟' : '關閉'}
                </button>
              ) : (
                <span class="pill pill-ok">
                  <span class="dot" />
                  開啟
                </span>
              )}
            </div>
            <div class="health-row">
              <Icon name="hash" />
              <div class="h-main">
                <div class="h-title">Discord 頻道</div>
                <div class="h-desc">
                  {configured} / {channels.length} 個頻道已設定 Webhook
                </div>
              </div>
              <Btn variant="ghost" size="sm" onClick={() => navigate('channels')}>
                管理
              </Btn>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

function NextTicket({ post, now, busy }: { post: Post; now: number; busy: boolean }) {
  const channels = useApp((s) => s.channels);
  const at = Date.parse(post.sendAt);
  const late = at <= now;
  return (
    <div class="ticket">
      <div class="ticket-main">
        <div class="row" style={{ gap: 8 }}>
          <span class="eyebrow">下一則自動發送</span>
          <TypeTag type={post.type} />
          {post.seriesLabel ? <span class="pill">{post.seriesLabel}</span> : null}
        </div>
        <h2>{post.title}</h2>
        <div class="meta">
          <span>
            <Icon name="clock" />
            {fmtLong(at)}
          </span>
          {post.draft?.eventAt ? (
            <span>
              <Icon name="calendar" />
              活動 {fmtDateTime(post.draft.eventAt)}
            </span>
          ) : null}
          {post.draft?.deadline ? (
            <span>
              <Icon name="bell" />
              截止 {fmtDateTime(post.draft.deadline)}
            </span>
          ) : null}
        </div>
        <ChannelChips ids={post.channels} channels={channels} max={6} />
        <div class="row" style={{ marginTop: 14, gap: 8 }}>
          <Btn size="sm" icon="eye" onClick={() => openDetail(post.id)}>
            預覽
          </Btn>
          <Btn size="sm" icon="edit" onClick={() => navigate('compose', { editId: post.id })} disabled={post.status === 'sending'}>
            編輯
          </Btn>
          <Btn
            size="sm"
            variant="ghost"
            icon="zap"
            busy={busy}
            disabled={post.status === 'sending'}
            onClick={async () => {
              if (await askConfirm({ title: '現在就發送？', body: `「${post.title}」會立刻發到 ${post.channels.length} 個頻道。`, confirmLabel: '立即發送' })) void sendNow(post.id);
            }}
          >
            立即發送
          </Btn>
        </div>
      </div>
      <div class="ticket-stub">
        <span class="eyebrow">{late || post.status === 'sending' ? '狀態' : '倒數'}</span>
        <span class="countdown">{post.status === 'sending' || busy ? '發送中…' : late ? '即將發送' : fmtCountdown(at - now)}</span>
        <span class="small">
          {late ? '排程器會在幾分鐘內處理' : `${fmtDateTime(at)} 發出`}
        </span>
      </div>
    </div>
  );
}

function RecentItem({ post }: { post: Post }) {
  const failed = post.channels.filter((c) => deliveryOf(post, c).status === 'failed').length;
  return (
    <button type="button" class="agenda-item" style={{ border: 0, background: 'none' }} onClick={() => openDetail(post.id)}>
      <span class="bar" style={{ background: failed ? 'var(--danger)' : 'var(--ok)' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{post.title}</span>
        <span class="small faint">{fmtRelative(Date.parse(post.sentAt!))} · {post.channels.length} 個頻道</span>
      </span>
      <StatusPill post={post} />
    </button>
  );
}
