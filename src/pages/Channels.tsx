import { useMemo, useState } from 'preact/hooks';
import type { Audience, Channel, ChannelKind } from '../core/types.ts';
import { groupChannels, mergeChannels, parseWebhookBlock } from '../core/channels.ts';
import { maskWebhook, parseWebhook } from '../core/discord.ts';
import { saveChannels, testChannel, toast, useApp, verifyChannel } from '../data/store.ts';
import { fmtRelative } from '../core/time.ts';
import { Btn, Empty, Modal, askConfirm } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';

export const KIND_LABEL: Record<ChannelKind, string> = {
  announce: '公告',
  homework: '作業',
  makeup: '補課',
  form: '表單',
  resource: '資源',
  discuss: '討論',
  chat: '交流',
  staff: '內部',
  test: '測試',
  other: '其他',
};

const AUDIENCE_LABEL: Record<Audience, string> = { student: '學員', staff: '非學員', test: '測試' };

export function Channels() {
  const { channels, posts, mode } = useApp((s) => ({ channels: s.channels, posts: s.posts, mode: s.config.mode }));
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const groups = groupChannels(channels);
  const missing = channels.filter((c) => !c.webhook).length;

  const stats = useMemo(() => {
    const m = new Map<string, { sent: number; last?: number; queued: number }>();
    for (const p of posts) {
      for (const cid of p.channels) {
        const s = m.get(cid) ?? { sent: 0, queued: 0 };
        const d = p.deliveries[cid];
        if (d?.status === 'sent') {
          s.sent++;
          const t = Date.parse(d.sentAt ?? p.sentAt ?? p.sendAt);
          if (!s.last || t > s.last) s.last = t;
        }
        if (p.status === 'scheduled') s.queued++;
        m.set(cid, s);
      }
    }
    return m;
  }, [posts]);

  async function remove(c: Channel) {
    const queued = stats.get(c.id)?.queued ?? 0;
    const ok = await askConfirm({
      title: `刪除「${c.name}」？`,
      body: queued ? `還有 ${queued} 則排程會發到這個頻道，刪除後這些排程在這個頻道會發送失敗。` : '刪除後，這個頻道的 Webhook 也會一併移除。',
      confirmLabel: '刪除頻道',
      danger: true,
    });
    if (ok) await saveChannels(channels.filter((x) => x.id !== c.id), '已刪除頻道');
  }

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">TNDA RELAY / CHANNELS</div>
          <h1 class="page-title">頻道</h1>
          <p class="page-sub">要發送的 Discord 聊天室。Webhook 網址等同發文權限，會加密後才存到 GitHub。</p>
        </div>
        <div class="page-actions">
          <Btn icon="upload" variant="primary" onClick={() => setImporting(true)}>
            批次匯入 Webhook
          </Btn>
          <Btn icon="plus" onClick={() => setEditing('new')}>
            新增頻道
          </Btn>
        </div>
      </div>

      {missing ? (
        <div class="callout callout-warn" style={{ marginBottom: 16 }}>
          <Icon name="alert" />
          <span>
            還有 {missing} 個頻道沒有設定 Webhook。用「批次匯入」可以一次貼上所有群組的連結（格式就是你整理好的那份清單）。
          </span>
        </div>
      ) : null}
      {mode === 'demo' ? (
        <div class="callout" style={{ marginBottom: 16 }}>
          <Icon name="info" />
          <span>Demo 模式中的 Webhook 是假的，測試與驗證都是模擬結果。</span>
        </div>
      ) : null}

      {channels.length === 0 ? (
        <div class="card">
          <Empty icon="hash" title="還沒有頻道">
            <Btn variant="primary" icon="upload" onClick={() => setImporting(true)}>
              批次匯入 Webhook
            </Btn>
          </Empty>
        </div>
      ) : (
        <div class="ch-groups">
          {groups.map((g) => (
            <section key={g.code} class="card">
              <div class="ch-group-head">
                <span class="cp-code">{g.code}</span>
                <h3>{g.name}</h3>
                <span class={`pill ${g.audience === 'staff' ? 'pill-warn' : g.audience === 'test' ? '' : 'pill-ok'}`}>{AUDIENCE_LABEL[g.audience]}</span>
              </div>
              {g.channels.map((c) => {
                const st = stats.get(c.id);
                return (
                  <div key={c.id} class="ch-row">
                    <div style={{ minWidth: 0 }}>
                      <div class="ch-name">
                        <span class="hash">#</span>
                        {c.name}
                        <span class="pill" style={{ fontWeight: 400 }}>
                          {KIND_LABEL[c.kind]}
                        </span>
                      </div>
                      <div class="ch-meta">
                        <span class={c.webhook ? '' : 'pill pill-warn'} style={c.webhook ? { fontFamily: 'var(--font-mono)' } : undefined}>
                          {c.webhook ? maskWebhook(c.webhook) : '尚未設定 Webhook'}
                        </span>
                        {st?.sent ? <span>已發 {st.sent} 則</span> : null}
                        {st?.last ? <span>最近 {fmtRelative(st.last)}</span> : null}
                        {st?.queued ? <span>排程 {st.queued} 則</span> : null}
                      </div>
                    </div>
                    <div class="ch-actions">
                      <Btn
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="shield"
                        disabled={!c.webhook}
                        busy={busyId === `v-${c.id}`}
                        onClick={async () => {
                          setBusyId(`v-${c.id}`);
                          const name = await verifyChannel(c.id);
                          setBusyId(null);
                          if (name) toast('ok', `Webhook 有效（Discord 上的名稱：${name}）`);
                        }}
                      >
                        驗證 Webhook
                      </Btn>
                      <Btn
                        size="sm"
                        variant="ghost"
                        iconOnly
                        icon="send"
                        disabled={!c.webhook}
                        busy={busyId === `t-${c.id}`}
                        onClick={async () => {
                          if (c.audience !== 'test' && !(await askConfirm({ title: `送出測試訊息到「${c.name}」？`, body: '這個頻道的成員會看到一則「連線測試」訊息。', confirmLabel: '送出測試' }))) return;
                          setBusyId(`t-${c.id}`);
                          await testChannel(c.id);
                          setBusyId(null);
                        }}
                      >
                        送出測試訊息
                      </Btn>
                      <Btn size="sm" variant="ghost" iconOnly icon="edit" onClick={() => setEditing(c)}>
                        編輯
                      </Btn>
                      <Btn size="sm" variant="ghost" iconOnly icon="trash" onClick={() => void remove(c)}>
                        刪除
                      </Btn>
                    </div>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      )}

      {importing ? <ImportModal onClose={() => setImporting(false)} /> : null}
      {editing ? <EditModal channel={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function ImportModal({ onClose }: { onClose: () => void }) {
  const channels = useApp((s) => s.channels);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const result = useMemo(() => (text.trim() ? parseWebhookBlock(text, channels) : null), [text, channels]);
  const existing = new Set(channels.map((c) => c.id));
  return (
    <Modal title="批次匯入 Webhook" onClose={onClose} wide>
      <p class="muted small">
        直接貼上整理好的清單：群組標題用【】包起來，下一行寫頻道名稱，再下一行貼 Webhook 網址。已存在的頻道會更新網址，新的頻道會自動加入。
      </p>
      <textarea
        id="import-text"
        class="textarea mono"
        rows={9}
        style={{ fontSize: 13, marginTop: 8 }}
        placeholder={'【B｜課程名稱】\n課程公告\nhttps://discord.com/api/webhooks/…\n課後作業\nhttps://discord.com/api/webhooks/…'}
        value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
      />
      {result ? (
        <div class="stack-sm" style={{ marginTop: 12 }}>
          {result.warnings.map((w, i) => (
            <div key={i} class="callout callout-warn">
              <Icon name="alert" />
              <span>{w}</span>
            </div>
          ))}
          {result.channels.length ? (
            <div class="table-wrap" style={{ maxHeight: 260 }}>
              <table class="table">
                <thead>
                  <tr>
                    <th>群組</th>
                    <th>頻道</th>
                    <th>類型</th>
                    <th>狀態</th>
                  </tr>
                </thead>
                <tbody>
                  {result.channels.map((c) => (
                    <tr key={c.id} style={{ cursor: 'default' }}>
                      <td>
                        <span class="mono">{c.group}</span> {c.groupName}
                      </td>
                      <td>{c.name}</td>
                      <td>{KIND_LABEL[c.kind]}</td>
                      <td>{existing.has(c.id) ? <span class="pill pill-wait">更新網址</span> : <span class="pill pill-ok">新增</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
      <div class="modal-actions">
        <Btn onClick={onClose}>取消</Btn>
        <Btn
          variant="primary"
          icon="check"
          busy={busy}
          disabled={!result?.channels.length}
          onClick={async () => {
            setBusy(true);
            const ok = await saveChannels(mergeChannels(channels, result!.channels), `已匯入 ${result!.channels.length} 個頻道`);
            setBusy(false);
            if (ok) onClose();
          }}
        >
          匯入 {result?.channels.length ?? 0} 個頻道
        </Btn>
      </div>
    </Modal>
  );
}

function EditModal({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const channels = useApp((s) => s.channels);
  const [c, setC] = useState<Channel>(
    channel ?? { id: '', name: '', group: 'E', groupName: '', audience: 'student', kind: 'announce', webhook: '' },
  );
  const [reveal, setReveal] = useState(!channel);
  const [busy, setBusy] = useState(false);
  const groups = groupChannels(channels);
  const urlOk = !c.webhook || !!parseWebhook(c.webhook);
  const valid = c.name.trim() && c.group.trim() && c.groupName.trim() && urlOk;
  const set = (patch: Partial<Channel>) => setC((x) => ({ ...x, ...patch }));
  return (
    <Modal title={channel ? `編輯「${channel.name}」` : '新增頻道'} onClose={onClose}>
      <div class="stack" style={{ marginTop: 10 }}>
        <div class="grid-2">
          <div class="field">
            <label for="ch-name">頻道名稱</label>
            <input id="ch-name" class="input" value={c.name} onInput={(e) => set({ name: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="field">
            <label for="ch-kind">用途</label>
            <select id="ch-kind" class="select" value={c.kind} onChange={(e) => set({ kind: (e.currentTarget as HTMLSelectElement).value as ChannelKind })}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div class="field">
          <label for="ch-group">群組</label>
          <select
            id="ch-group"
            class="select"
            value={groups.some((g) => g.code === c.group) ? c.group : '__new'}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              const g = groups.find((x) => x.code === v);
              if (g) set({ group: g.code, groupName: g.name, audience: g.audience });
              else set({ group: '', groupName: '' });
            }}
          >
            {groups.map((g) => (
              <option key={g.code} value={g.code}>
                {g.code}｜{g.name}
              </option>
            ))}
            <option value="__new">＋ 新群組</option>
          </select>
        </div>
        {!groups.some((g) => g.code === c.group) ? (
          <div class="grid-2">
            <div class="field">
              <label for="ch-gcode">群組代碼</label>
              <input id="ch-gcode" class="input mono" maxLength={3} value={c.group} onInput={(e) => set({ group: (e.currentTarget as HTMLInputElement).value.toUpperCase() })} placeholder="例如 E" />
            </div>
            <div class="field">
              <label for="ch-gname">群組名稱</label>
              <input id="ch-gname" class="input" value={c.groupName} onInput={(e) => set({ groupName: (e.currentTarget as HTMLInputElement).value })} placeholder="例如：五-新課程" />
            </div>
          </div>
        ) : null}
        <div class="field">
          <label for="ch-aud">對象</label>
          <select id="ch-aud" class="select" value={c.audience} onChange={(e) => set({ audience: (e.currentTarget as HTMLSelectElement).value as Audience })}>
            <option value="student">學員</option>
            <option value="staff">非學員（業師、助理）</option>
            <option value="test">測試</option>
          </select>
        </div>
        <div class="field">
          <label for="ch-hook">
            Webhook 網址
            <button type="button" class="btn btn-ghost btn-sm" style={{ marginLeft: 'auto', minHeight: 22 }} onClick={() => setReveal(!reveal)}>
              {reveal ? '隱藏' : '顯示'}
            </button>
          </label>
          <input
            id="ch-hook"
            class="input mono"
            type={reveal ? 'text' : 'password'}
            autocomplete="off"
            value={c.webhook ?? ''}
            placeholder="https://discord.com/api/webhooks/…"
            onInput={(e) => set({ webhook: (e.currentTarget as HTMLInputElement).value.trim() })}
          />
          <span class="help">
            在 Discord 頻道的「編輯頻道 → 整合 → Webhook → 複製 Webhook 網址」取得。
            {!urlOk ? <b style={{ color: 'var(--danger-text)' }}> 這不是有效的 Discord Webhook 網址。</b> : null}
          </span>
        </div>
      </div>
      <div class="modal-actions">
        <Btn onClick={onClose}>取消</Btn>
        <Btn
          variant="primary"
          busy={busy}
          disabled={!valid}
          onClick={async () => {
            setBusy(true);
            const id = channel?.id ?? `${c.group.toLowerCase()}-${Date.now().toString(36)}`;
            const next: Channel = { ...c, id, name: c.name.trim(), webhook: c.webhook || undefined };
            const list = channel ? channels.map((x) => (x.id === channel.id ? next : x)) : [...channels, next];
            const ok = await saveChannels(list, channel ? '已更新頻道' : '已新增頻道');
            setBusy(false);
            if (ok) onClose();
          }}
        >
          儲存
        </Btn>
      </div>
    </Modal>
  );
}
