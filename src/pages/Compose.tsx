import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Channel, ComposeDraft, LinkItem, PostType } from '../core/types.ts';
import { parseAnnouncement, type Detection } from '../format/parser.ts';
import { POST_TYPES, TYPE_META, composePayload, draftFromParse, emptyDraft, suggestReminders } from '../format/composer.ts';
import { detectCourse, groupChannels, matchingChannels, suggestChannels } from '../core/channels.ts';
import { LIMITS, attachmentProblems, payloadLength, validatePayload } from '../core/discord.ts';
import { DAY_MS, atTime, fmtDateTime, fmtLong, fromInputValue, toInputValue, tpParts, pad, fromTp } from '../core/time.ts';
import { editSentPost, navigate, submitPlan, updateConfig, updatePlan, useApp, useNow } from '../data/store.ts';
import { Btn, Seg, Switch, askConfirm } from '../ui/kit.tsx';
import { Icon } from '../ui/icons.tsx';
import { PollEditor } from '../ui/PollEditor.tsx';
import { AttachmentsEditor } from '../ui/Attachments.tsx';
import { DiscordPreview } from '../ui/DiscordPreview.tsx';

type WhenMode = 'at' | 'chain' | 'now';

const TEMPLATES: Array<{ type: PostType; label: string; text: string }> = [
  {
    type: 'class',
    label: '上課提醒',
    text: '【互動設計 上課提醒】\n下週三 18:30-21:30 上課\n地點：3F 301 教室\n請攜帶 筆電、Arduino 套件\n本週會做感測器實作，上課前請先看學習資源區的影片。',
  },
  {
    type: 'homework',
    label: '作業提醒',
    text: '互動設計 作業二：互動原型影片\n請在下週二 23:59 前上傳到 https://drive.google.com/drive/folders/your-folder\n- 影片 30 秒內\n- 檔名：學號_姓名_作業二',
  },
  {
    type: 'makeup',
    label: '補課資訊',
    text: '數位內容 補課通知\n原本這週四的課因颱風停課，改到下週六下午 1:30～4:30 補課，地點不變：2F 202 教室。',
  },
  {
    type: 'form',
    label: '表單填寫',
    text: '期中課程回饋表單\n花 3 分鐘填寫，幫助我們調整下半學期的課程，匿名填寫。\n請在下週五前填寫 https://forms.gle/your-form',
  },
  {
    type: 'resource',
    label: '學習資源',
    text: '數位內容 第五週簡報與錄影\n簡報：https://docs.google.com/presentation/d/your-slides\n錄影：https://youtu.be/your-video\n沒來的同學記得補看！',
  },
  {
    type: 'announce',
    label: '一般公告',
    text: '@everyone 期中成果展報名開始\n每組一個展位，名額有限，請組長在下週一前完成報名 https://forms.gle/your-form',
  },
];

function defaultSendAt(): string {
  // 一小時後，再往後取到整點或半點
  const t = Date.now() + 60 * 60000;
  return new Date(Math.ceil(t / 1800000) * 1800000).toISOString();
}

function quickTimes(now: number): Array<{ label: string; at: string }> {
  const out: Array<{ label: string; at: string }> = [];
  const p = tpParts(now);
  const add = (label: string, d: Date) => {
    if (d.getTime() > now + 60000) out.push({ label, at: d.toISOString() });
  };
  add('今晚 20:00', atTime(now, 20));
  add('明早 08:00', atTime(now + DAY_MS, 8));
  add('明晚 20:00', atTime(now + DAY_MS, 20));
  add('1 小時後', fromTp(p.y, p.m, p.d, p.hh + 1, p.mm));
  return out;
}

export function Compose() {
  const now = useNow(30000);
  const { route, channels, settings, posts, previewTheme } = useApp((s) => ({
    route: s.route,
    channels: s.channels,
    settings: s.settings,
    posts: s.posts,
    previewTheme: s.config.previewTheme,
  }));
  const source = route.editId ? posts.find((p) => p.id === route.editId) : route.cloneId ? posts.find((p) => p.id === route.cloneId) : undefined;
  const editing = route.editId ? source : undefined;
  const editSent = !!editing && ['sent', 'partial'].includes(editing.status);

  const [draft, setDraft] = useState<ComposeDraft>(() => (source?.draft ? structuredClone(source.draft) : emptyDraft(settings)));
  const [detections, setDetections] = useState<Detection[]>([]);
  const [fieldsDirty, setFieldsDirty] = useState(!!source);
  const [typeLocked, setTypeLocked] = useState(!!source);
  const [selected, setSelected] = useState<string[]>(source ? [...source.channels] : []);
  const [channelsTouched, setChannelsTouched] = useState(!!source);
  const [when, setWhen] = useState<WhenMode>('at');
  const [sendAt, setSendAt] = useState<string>(() =>
    editing ? editing.sendAt : route.presetAt ?? defaultSendAt(),
  );
  const [sendAtTouched, setSendAtTouched] = useState(!!editing || !!route.presetAt);
  const [chain, setChain] = useState<string[] | null>(null);
  const [repeatOn, setRepeatOn] = useState(!!editing?.repeat);
  const [repeatUntil, setRepeatUntil] = useState(editing?.repeat?.until ? toInputValue(editing.repeat.until).slice(0, 10) : '');
  const [previewCh, setPreviewCh] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const rawRef = useRef<HTMLTextAreaElement>(null);

  // 文字改變後自動整理（使用者還沒手動改欄位時）
  useEffect(() => {
    if (fieldsDirty) return;
    const t = setTimeout(() => applyParse(draft.raw, false), 250);
    return () => clearTimeout(t);
  }, [draft.raw]);

  function applyParse(raw: string, force: boolean) {
    if (!raw.trim()) {
      setDetections([]);
      return;
    }
    const parsed = parseAnnouncement(raw, new Date(), typeLocked && !force ? draft.type : undefined);
    const next = draftFromParse(parsed, raw, settings);
    // 附檔與投票不是從文字整理出來的，重新整理時保留
    setDraft((d) => ({
      ...next,
      style: d.style,
      showCountdown: d.showCountdown,
      imageUrl: d.imageUrl,
      mention: parsed.mention !== 'none' ? parsed.mention : d.mention,
      poll: d.poll,
      attachments: d.attachments,
    }));
    setDetections(parsed.detections);
    if (force) setFieldsDirty(false);
    const course = detectCourse(raw, channels);
    if (!channelsTouched) setSelected(suggestChannels(next.type, channels, course));
    if (!sendAtTouched) {
      const rec = suggestReminders(next, new Date()).find((r) => r.recommended);
      setSendAt(rec?.at ?? defaultSendAt());
    }
    setChain(null);
  }

  const set = <K extends keyof ComposeDraft>(key: K, value: ComposeDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key !== 'raw') setFieldsDirty(true);
  };

  const payload = useMemo(() => composePayload(draft, settings), [draft, settings]);
  const reminders = useMemo(() => suggestReminders(draft, new Date(now)), [draft.type, draft.eventAt, draft.deadline, now]);
  const chainSel = chain ?? reminders.filter((r) => r.recommended).map((r) => r.key);
  const chainTimes = reminders.filter((r) => chainSel.includes(r.key));
  const previewAt = when === 'now' ? now : when === 'chain' ? Date.parse(chainTimes[0]?.at ?? new Date(now).toISOString()) : Date.parse(sendAt);
  const suggested = useMemo(() => new Set(matchingChannels(draft.type, channels)), [draft.type, channels]);
  const previewChannel = channels.find((c) => c.id === (selected.includes(previewCh) ? previewCh : selected[0]));
  const hasContent = !!(draft.title.trim() || draft.body.trim() || draft.raw.trim());

  const issues = useMemo(() => {
    const list: Array<{ level: 'bad' | 'warn'; text: string }> = [];
    if (!hasContent) return list;
    for (const e of validatePayload(payload)) list.push({ level: 'bad', text: e });
    for (const e of attachmentProblems(draft.attachments ?? [])) list.push({ level: 'bad', text: e });
    if (!editSent) {
      if (selected.length === 0) list.push({ level: 'bad', text: '還沒有選擇要發到哪些頻道' });
      const chosen = channels.filter((c) => selected.includes(c.id));
      if (chosen.some((c) => c.audience === 'staff') && chosen.some((c) => c.audience === 'student'))
        list.push({ level: 'warn', text: '同時選了「學員」與「業師／助理」頻道，請確認內容適合兩邊' });
      const noHook = chosen.filter((c) => !c.webhook);
      if (noHook.length) list.push({ level: 'warn', text: `「${noHook.map((c) => c.name).join('、')}」還沒設定 Webhook，發送會失敗` });
      if (when === 'at' && Date.parse(sendAt) < now - 60000) list.push({ level: 'warn', text: '發送時間已經過了，排程後會立刻發出' });
      if (when === 'chain' && chainTimes.length === 0) list.push({ level: 'bad', text: '提醒鏈至少要選一個時間' });
    }
    for (const d of detections) if (d.kind === 'assumption' && /不是星期/.test(d.label)) list.push({ level: 'warn', text: d.label });
    return list;
  }, [payload, selected, channels, when, sendAt, chainTimes.length, detections, hasContent, editSent, now, draft.attachments]);
  const blocking = issues.some((i) => i.level === 'bad');

  async function submit(mode: 'schedule' | 'now' | 'draft') {
    if (busy) return;
    if (mode === 'now') {
      const ok = await askConfirm({
        title: '現在就發送？',
        body: `會立刻發到 ${selected.length} 個頻道：${channels.filter((c) => selected.includes(c.id)).map((c) => `${c.group}·${c.name}`).join('、')}`,
        confirmLabel: '立即發送',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const repeat = repeatOn && when === 'at' ? { freq: 'weekly' as const, interval: 1, until: repeatUntil ? fromInputValue(`${repeatUntil}T23:59`) : undefined } : null;
      if (editSent && editing) {
        await editSentPost(editing.id, draft);
        return;
      }
      const times = when === 'chain' ? chainTimes.map((r) => ({ at: r.at, label: r.label.replace(/（.*）/, '') })) : [{ at: sendAt }];
      const plan = { draft, channels: selected, times, repeat, mode };
      if (editing) await updatePlan(editing.id, plan);
      else await submitPlan(plan);
    } finally {
      setBusy(false);
    }
  }

  // Ctrl/⌘ + Enter 送出
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !blocking && hasContent) {
        e.preventDefault();
        void submit(when === 'now' ? 'now' : 'schedule');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const title = editSent ? '修改已發送的訊息' : editing ? '編輯排程' : source ? '複製為新貼文' : '撰寫新貼文';
  const submitLabel = editSent
    ? '更新 Discord 上的訊息'
    : when === 'now'
      ? '立即發送'
      : when === 'chain'
        ? `建立 ${chainTimes.length} 則提醒`
        : editing
          ? '儲存變更'
          : '排程發送';

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">TNDA RELAY / COMPOSE</div>
          <h1 class="page-title">{title}</h1>
          <p class="page-sub">
            {editSent ? 'Discord 上的訊息會直接更新，並標示「已編輯」。' : '貼上原始文字，系統會自動整理成 Discord 格式，確認後排程發送。'}
          </p>
        </div>
        <div class="page-actions">
          {!source ? (
            <Btn variant="ghost" icon="upload" onClick={() => navigate('import')}>
              批次匯入
            </Btn>
          ) : null}
          <Btn variant="ghost" icon="left" onClick={() => history.length > 1 ? history.back() : navigate('queue')}>
            返回
          </Btn>
        </div>
      </div>

      <div class="compose">
        <div class="stack">
          {/* 1. 貼上內容 */}
          <section class="card card-pad">
            <div class="section-title">
              <span class="step">01</span>
              貼上內容
              <span class="hint">{draft.style === 'raw' ? '原文模式：這段文字會照原樣發送' : '隨手貼上就好，日期、時間、地點、連結會自動辨識'}</span>
            </div>
            <textarea
              ref={rawRef}
              id="raw"
              class="textarea raw-input"
              placeholder={'例如：\n提醒大家明天晚上 7 點上課，地點在 302 教室，記得帶筆電！\n作業一請在 10/20 23:59 前上傳 https://forms.gle/…'}
              value={draft.raw}
              onInput={(e) => set('raw', (e.currentTarget as HTMLTextAreaElement).value)}
              aria-label="原始公告內容"
            />
            <div class="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
              <div class="templates">
                <span class="small faint" style={{ alignSelf: 'center' }}>
                  範本：
                </span>
                {TEMPLATES.map((t) => (
                  <button
                    key={t.type}
                    type="button"
                    class="btn btn-sm"
                    onClick={() => {
                      setFieldsDirty(false);
                      setTypeLocked(false);
                      setDraft((d) => ({ ...d, raw: t.text }));
                      applyParse(t.text, true);
                      rawRef.current?.focus();
                    }}
                  >
                    {TYPE_META[t.type].emoji} {t.label}
                  </button>
                ))}
              </div>
              {fieldsDirty && draft.raw.trim() ? (
                <Btn size="sm" variant="primary" icon="sparkles" onClick={() => applyParse(draft.raw, true)}>
                  重新整理
                </Btn>
              ) : null}
            </div>
            {detections.length ? (
              <div class="detect" aria-live="polite">
                <span class="small faint">
                  <Icon name="sparkles" style={{ width: 14, height: 14, verticalAlign: '-2px' }} /> 已辨識：
                </span>
                {detections.map((d, i) => (
                  <span key={i} class={`pill ${d.kind === 'assumption' ? 'pill-warn' : d.kind === 'type' ? 'pill-ok' : ''}`}>
                    {d.label}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          {/* 2. 整理結果 */}
          <section class="card card-pad">
            <div class="section-title">
              <span class="step">02</span>
              整理結果
              <span class="hint">可以直接修改，右側預覽會即時更新</span>
            </div>
            <div class="stack">
              <div class="type-picker" role="group" aria-label="貼文類型">
                {POST_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    class="type-opt"
                    aria-pressed={draft.type === t}
                    style={{ '--c': TYPE_META[t].hex } as JSX.CSSProperties}
                    onClick={() => {
                      set('type', t);
                      setTypeLocked(true);
                      if (!channelsTouched) setSelected(suggestChannels(t, channels, detectCourse(draft.raw, channels)));
                    }}
                  >
                    <span class="emo">{TYPE_META[t].emoji}</span>
                    {TYPE_META[t].label}
                  </button>
                ))}
              </div>
              <div class="field">
                <label for="f-title">
                  {draft.style === 'raw' ? '名稱（只顯示在網站上，不會發出）' : '標題'} <span class="char-count">{draft.title.length}/{LIMITS.title - 3}</span>
                </label>
                <input id="f-title" class="input" value={draft.title} placeholder={TYPE_META[draft.type].label} onInput={(e) => set('title', (e.currentTarget as HTMLInputElement).value)} />
              </div>
              {draft.style === 'raw' ? (
                <div class="callout">
                  <Icon name="info" />
                  <span>原文模式：上方「貼上內容」會照原樣發到 Discord，不加標題與欄位。內文裡的身分組標註（例如 {'<@&123…>'}）會照常通知。</span>
                </div>
              ) : (
                <>
                  <div class="field">
                    <label for="f-body">內文</label>
                    <textarea id="f-body" class="textarea" rows={4} value={draft.body} onInput={(e) => set('body', (e.currentTarget as HTMLTextAreaElement).value)} />
                    <span class="help">支援 Discord 格式：**粗體**、*斜體*、- 清單、[文字](網址)</span>
                  </div>
                  <div class="grid-3">
                    <DateField id="f-event" label={draft.type === 'makeup' ? '補課時間' : draft.type === 'class' ? '上課時間' : '活動時間'} value={draft.eventAt} onChange={(v) => set('eventAt', v)} />
                    <TimeField id="f-end" label="結束時間" base={draft.eventAt} value={draft.eventEnd} onChange={(v) => set('eventEnd', v)} />
                    <DateField id="f-deadline" label={draft.type === 'form' ? '填寫期限' : '截止時間'} value={draft.deadline} onChange={(v) => set('deadline', v)} />
                  </div>
                  <div class="grid-2">
                    <div class="field">
                      <label for="f-loc">地點</label>
                      <input id="f-loc" class="input" value={draft.location ?? ''} placeholder="例如：302 教室、線上" onInput={(e) => set('location', (e.currentTarget as HTMLInputElement).value)} />
                    </div>
                    <div class="field">
                      <label for="f-notes">注意事項</label>
                      <input id="f-notes" class="input" value={draft.notes ?? ''} placeholder="例如：請攜帶筆電" onInput={(e) => set('notes', (e.currentTarget as HTMLInputElement).value)} />
                    </div>
                  </div>
                  <LinksEditor links={draft.links} onChange={(l) => set('links', l)} />
                </>
              )}
              <AttachmentsEditor refs={draft.attachments ?? []} locked={editSent} onChange={(refs) => set('attachments', refs.length ? refs : undefined)} />
              <PollEditor
                poll={draft.poll}
                locked={editSent}
                onChange={(p) => {
                  set('poll', p);
                  // 投票不能和卡片一起發
                  if (p && draft.style === 'embed') set('style', 'text');
                }}
              />
              <details>
                <summary class="small" style={{ cursor: 'pointer', color: 'var(--ink-2)' }}>
                  更多選項（樣式、標註、圖片）
                </summary>
                <div class="stack" style={{ marginTop: 12 }}>
                  <div class="row">
                    <span class="small muted" style={{ minWidth: 56 }}>
                      樣式
                    </span>
                    <Seg label="訊息樣式" value={draft.style} onChange={(v) => set('style', v)} options={[{ value: 'embed', label: '卡片' }, { value: 'text', label: '純文字' }, { value: 'raw', label: '原文' }]} />
                  </div>
                  <div class="row">
                    <span class="small muted" style={{ minWidth: 56 }}>
                      標註
                    </span>
                    <Seg
                      label="標註對象"
                      value={draft.mention}
                      onChange={(v) => set('mention', v)}
                      options={[
                        { value: 'none', label: '不標註' },
                        { value: 'everyone', label: '@everyone' },
                        { value: 'here', label: '@here' },
                      ]}
                    />
                  </div>
                  {draft.style !== 'raw' ? (
                    <>
                      <Switch id="f-countdown" checked={draft.showCountdown} onChange={(v) => set('showCountdown', v)}>
                        在時間下方顯示倒數（例如「3 天後」，Discord 會自動更新）
                      </Switch>
                      <div class="field">
                        <label for="f-img">圖片網址（選填）</label>
                        <input id="f-img" class="input mono" value={draft.imageUrl ?? ''} placeholder="https://…" onInput={(e) => set('imageUrl', (e.currentTarget as HTMLInputElement).value)} />
                      </div>
                    </>
                  ) : null}
                </div>
              </details>
            </div>
          </section>

          {/* 3. 發送設定 */}
          <section class="card card-pad">
            <div class="section-title">
              <span class="step">03</span>
              發到哪裡、什麼時候
            </div>
            {editSent ? (
              <div class="callout">
                <Icon name="info" />
                <span>這則貼文已經發送，只能修改內容。頻道與時間無法變更，如需重發請用「複製為新貼文」。</span>
              </div>
            ) : (
              <div class="stack">
                <ChannelPicker
                  channels={channels}
                  selected={selected}
                  suggested={suggested}
                  onChange={(ids) => {
                    setSelected(ids);
                    setChannelsTouched(true);
                  }}
                />
                <div class="field">
                  <span class="label">發送時間</span>
                  <div class="when-opts" role="group" aria-label="發送方式">
                    <button type="button" class="when-opt" aria-pressed={when === 'at'} onClick={() => setWhen('at')}>
                      <b>
                        <Icon name="clock" /> 指定時間
                      </b>
                      <span>到時間自動發送</span>
                    </button>
                    <button type="button" class="when-opt" aria-pressed={when === 'chain'} onClick={() => setWhen('chain')} disabled={!reminders.length || !!editing}>
                      <b>
                        <Icon name="bell" /> 提醒鏈
                      </b>
                      <span>{editing ? '編輯時無法使用' : reminders.length ? '截止或上課前分次提醒' : '需要有時間或截止日'}</span>
                    </button>
                    <button type="button" class="when-opt express" aria-pressed={when === 'now'} onClick={() => setWhen('now')}>
                      <b>
                        <Icon name="zap" /> 立即發送
                      </b>
                      <span>現在就送出</span>
                    </button>
                  </div>
                </div>
                {when === 'at' ? (
                  <div class="stack-sm">
                    <div class="row">
                      <input
                        id="f-sendat"
                        type="datetime-local"
                        class="input mono"
                        style={{ maxWidth: 260 }}
                        value={toInputValue(sendAt)}
                        onInput={(e) => {
                          const v = fromInputValue((e.currentTarget as HTMLInputElement).value);
                          if (v) {
                            setSendAt(v);
                            setSendAtTouched(true);
                          }
                        }}
                        aria-label="發送時間（台北時間）"
                      />
                      <span class="small muted">{fmtLong(sendAt)}（台北時間）</span>
                    </div>
                    <div class="quick-times">
                      {quickTimes(now).map((q) => (
                        <button
                          key={q.label}
                          type="button"
                          class="btn btn-sm"
                          onClick={() => {
                            setSendAt(q.at);
                            setSendAtTouched(true);
                          }}
                        >
                          {q.label}
                        </button>
                      ))}
                      {reminders.slice(0, 3).map((r) => (
                        <button
                          key={r.key}
                          type="button"
                          class="btn btn-sm"
                          onClick={() => {
                            setSendAt(r.at);
                            setSendAtTouched(true);
                          }}
                        >
                          {r.label.replace(/（.*）/, '')}
                        </button>
                      ))}
                    </div>
                    <div class="row" style={{ marginTop: 4 }}>
                      <Switch id="f-repeat" checked={repeatOn} onChange={setRepeatOn}>
                        每週同一時間重複發送
                      </Switch>
                      {repeatOn ? (
                        <label class="row small muted" for="f-until">
                          直到
                          <input id="f-until" type="date" class="input mono" style={{ width: 170 }} value={repeatUntil} onInput={(e) => setRepeatUntil((e.currentTarget as HTMLInputElement).value)} />
                          <span>（留空代表一直重複）</span>
                        </label>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {when === 'chain' ? (
                  <div class="reminder-list">
                    {reminders.map((r) => (
                      <label key={r.key} class="check" for={`rem-${r.key}`}>
                        <input
                          id={`rem-${r.key}`}
                          type="checkbox"
                          checked={chainSel.includes(r.key)}
                          onChange={(e) => {
                            const on = (e.currentTarget as HTMLInputElement).checked;
                            setChain(on ? [...new Set([...chainSel, r.key])] : chainSel.filter((k) => k !== r.key));
                          }}
                        />
                        <span>
                          {r.label}
                          {r.recommended ? <span class="pill pill-ok" style={{ marginLeft: 6 }}>推薦</span> : null}
                        </span>
                      </label>
                    ))}
                    <span class="small faint">每個時間都會建立一則貼文。訊息裡的倒數由 Discord 自動計算，所以每次提醒都會顯示正確的剩餘時間。</span>
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </div>

        <aside class="compose-side">
          <div class="preview-head">
            <h3 style={{ fontSize: 15, flex: 1 }}>Discord 預覽</h3>
            {selected.length > 1 ? (
              <select class="select" style={{ width: 'auto', minHeight: 30, padding: '2px 8px', fontSize: 13 }} value={previewChannel?.id} onChange={(e) => setPreviewCh((e.currentTarget as HTMLSelectElement).value)} aria-label="預覽的頻道">
                {channels
                  .filter((c) => selected.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.group}·{c.name}
                    </option>
                  ))}
              </select>
            ) : null}
            <Seg label="預覽主題" value={previewTheme} onChange={(v) => updateConfig({ previewTheme: v })} options={[{ value: 'dark', label: '深色' }, { value: 'light', label: '淺色' }]} />
          </div>
          {hasContent ? (
            <DiscordPreview payload={payload} channel={previewChannel} at={previewAt} theme={previewTheme} edited={editSent} files={draft.attachments?.map((r) => ({ ...r, ref: r }))} />
          ) : (
            <div class={`dc ${previewTheme === 'light' ? 'light' : ''}`}>
              <div class="dc-channel">
                <span class="hash">#</span>頻道
              </div>
              <div style={{ padding: '34px 20px', textAlign: 'center', color: 'var(--dc-muted)', fontSize: 14 }}>
                貼上內容後，這裡會顯示學生在 Discord 上看到的樣子。
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    class="btn btn-sm"
                    onClick={() => {
                      const t = TEMPLATES[1];
                      setDraft((d) => ({ ...d, raw: t.text }));
                      applyParse(t.text, true);
                    }}
                  >
                    用範例試試看
                  </button>
                </div>
              </div>
            </div>
          )}
          <div class="row small faint" style={{ justifyContent: 'space-between' }}>
            <span>
              {when === 'now' ? '以現在的時間預覽' : `以 ${fmtDateTime(previewAt)} 發送時的樣子預覽`}
            </span>
            <span class="char-count">
              {draft.style === 'embed' ? `卡片 ${payloadLength(payload)}/${LIMITS.embedTotal}` : `文字 ${(payload.content ?? '').length}/${LIMITS.content}`}
            </span>
          </div>
          {issues.length ? (
            <div class="stack-sm">
              {issues.map((i, n) => (
                <div key={n} class={`callout ${i.level === 'bad' ? 'callout-bad' : 'callout-warn'}`}>
                  <Icon name="alert" />
                  <span>{i.text}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div class="action-bar compose-actions">
            {!editSent ? (
              <Btn onClick={() => void submit('draft')} disabled={busy || !hasContent} icon="file">
                {editing?.status === 'draft' ? '存草稿' : '存成草稿'}
              </Btn>
            ) : null}
            <span class="grow" />
            <Btn
              variant={when === 'now' && !editSent ? 'express' : 'primary'}
              icon={editSent ? 'refresh' : when === 'now' ? 'zap' : 'send'}
              busy={busy}
              disabled={blocking || !hasContent}
              onClick={() => void submit(when === 'now' && !editSent ? 'now' : 'schedule')}
              title="Ctrl / ⌘ + Enter"
            >
              {submitLabel}
            </Btn>
          </div>
        </aside>
      </div>
    </>
  );
}

function DateField({ id, label, value, onChange }: { id: string; label: string; value?: string; onChange: (v: string | undefined) => void }) {
  return (
    <div class="field">
      <label for={id}>
        {label}
        {value ? (
          <button type="button" class="btn btn-ghost btn-sm btn-icon" style={{ minHeight: 20, width: 20, marginLeft: 'auto' }} aria-label={`清除${label}`} onClick={() => onChange(undefined)}>
            <Icon name="x" style={{ width: 13, height: 13 }} />
          </button>
        ) : null}
      </label>
      <input id={id} type="datetime-local" class="input mono" value={toInputValue(value)} onInput={(e) => onChange(fromInputValue((e.currentTarget as HTMLInputElement).value))} />
    </div>
  );
}

function TimeField({ id, label, base, value, onChange }: { id: string; label: string; base?: string; value?: string; onChange: (v: string | undefined) => void }) {
  const p = value ? tpParts(value) : null;
  return (
    <div class="field">
      <label for={id}>{label}</label>
      <input
        id={id}
        type="time"
        class="input mono"
        disabled={!base}
        value={p ? `${pad(p.hh)}:${pad(p.mm)}` : ''}
        onInput={(e) => {
          const v = (e.currentTarget as HTMLInputElement).value;
          if (!v || !base) return onChange(undefined);
          const b = tpParts(base);
          const [hh, mm] = v.split(':').map(Number);
          onChange(fromTp(b.y, b.m, b.d, hh, mm).toISOString());
        }}
      />
    </div>
  );
}

function LinksEditor({ links, onChange }: { links: LinkItem[]; onChange: (l: LinkItem[]) => void }) {
  const update = (i: number, patch: Partial<LinkItem>) => onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  return (
    <div class="field">
      <span class="label">連結</span>
      <div class="stack-sm">
        {links.map((l, i) => (
          <div key={i} class="link-row">
            <input class="input" value={l.label} placeholder="顯示文字" aria-label={`連結 ${i + 1} 的文字`} onInput={(e) => update(i, { label: (e.currentTarget as HTMLInputElement).value })} />
            <input class="input mono" value={l.url} placeholder="https://…" aria-label={`連結 ${i + 1} 的網址`} onInput={(e) => update(i, { url: (e.currentTarget as HTMLInputElement).value })} />
            <Btn variant="ghost" iconOnly icon="trash" size="sm" onClick={() => onChange(links.filter((_, n) => n !== i))}>
              移除連結
            </Btn>
          </div>
        ))}
        <div>
          <Btn size="sm" icon="plus" onClick={() => onChange([...links, { label: '', url: '' }])}>
            新增連結
          </Btn>
        </div>
      </div>
    </div>
  );
}

export function ChannelPicker({ channels, selected, suggested, onChange }: { channels: Channel[]; selected: string[]; suggested: Set<string>; onChange: (ids: string[]) => void }) {
  const groups = groupChannels(channels);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  if (!channels.length) {
    return (
      <div class="callout callout-warn">
        <Icon name="alert" />
        <span>
          還沒有任何頻道。請先到「頻道」頁匯入 Discord Webhook。{' '}
          <a href="#channels" onClick={(e) => (e.preventDefault(), navigate('channels'))}>
            前往設定
          </a>
        </span>
      </div>
    );
  }
  return (
    <div class="field">
      <span class="label">
        發送頻道 <span class="faint">（已選 {selected.length} 個，虛線為建議頻道）</span>
      </span>
      <div class="channel-picker">
        {groups.map((g) => {
          const ids = g.channels.map((c) => c.id);
          const all = ids.every((id) => selected.includes(id));
          return (
            <div key={g.code}>
              <div class="cp-group-head">
                <span class="cp-code">{g.code}</span>
                <span class="g-name">{g.name}</span>
                {g.audience === 'staff' ? <span class="pill pill-warn">非學員</span> : g.audience === 'test' ? <span class="pill">測試</span> : null}
                {g.channels.length > 1 ? (
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => onChange(all ? selected.filter((x) => !ids.includes(x)) : [...new Set([...selected, ...ids])])}>
                    {all ? '取消全選' : '全選'}
                  </button>
                ) : null}
              </div>
              <div class="cp-chans">
                {g.channels.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    class={`cp-chan ${suggested.has(c.id) ? 'suggest' : ''}`}
                    aria-pressed={selected.includes(c.id)}
                    onClick={() => toggle(c.id)}
                    title={c.webhook ? `${g.name}／${c.name}` : `${c.name}：尚未設定 Webhook`}
                  >
                    {selected.includes(c.id) ? <Icon name="check" style={{ width: 14, height: 14 }} /> : <span style={{ opacity: 0.6 }}>#</span>}
                    {c.name}
                    {!c.webhook ? <span class="no-hook" aria-label="尚未設定 Webhook" /> : null}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
