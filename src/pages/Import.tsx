import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Channel, Post } from '../core/types.ts';
import { validatePayload } from '../core/discord.ts';
import { fmtDate, fmtTime } from '../core/time.ts';
import { composePayload, emptyDraft } from '../format/composer.ts';
import {
  ImportError,
  type ImportBundle,
  type ImportItem,
  decodeImportData,
  findDuplicate,
  matchChannels,
  parseImportBundle,
  refKey,
  refLabel,
  resolveTargets,
} from '../data/importer.ts';
import { buildPost, clearPendingImport, importPosts, navigate, pendingImport, toast, useApp, useNow } from '../data/store.ts';
import { DiscordPreview } from '../ui/DiscordPreview.tsx';
import { Icon } from '../ui/icons.tsx';
import { Btn, ChannelChips, TypeTag, askConfirm } from '../ui/kit.tsx';

interface Row {
  index: number;
  item: ImportItem;
  targets: string[] | null;
  post: Post | null;
  /** 不能匯入的原因 */
  blocked?: string;
  duplicate?: Post;
}

async function readSource(input: string): Promise<ImportBundle> {
  const text = input.trim();
  const link = /#import=([^\s#]+)/.exec(text)?.[1] ?? (text.startsWith('z.') ? text : null);
  return parseImportBundle(link ? await decodeImportData(link) : text);
}

export function ImportPage() {
  const now = useNow(60000);
  const { channels, posts, settings, previewTheme } = useApp((s) => ({
    channels: s.channels,
    posts: s.posts,
    settings: s.settings,
    previewTheme: s.config.previewTheme,
  }));
  const [source, setSource] = useState('');
  const [bundle, setBundle] = useState<ImportBundle | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function load(input: string) {
    setLoading(true);
    setError('');
    try {
      const b = await readSource(input);
      const map: Record<string, string> = {};
      for (const item of b.posts) {
        for (const ref of item.to) {
          const key = refKey(ref);
          if (key in map) continue;
          const hits = matchChannels(ref, channels);
          map[key] = hits.length === 1 ? hits[0].id : '';
        }
      }
      setMapping(map);
      setOverrides({});
      setBundle(b);
    } catch (err) {
      setError(err instanceof ImportError ? err.message : `讀取失敗：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  // 從匯入連結進來的，自動讀取
  useEffect(() => {
    const data = pendingImport();
    if (data && channels.length) void load(data);
  }, [channels.length]);

  const rows = useMemo<Row[]>(() => {
    if (!bundle) return [];
    return bundle.posts.map((item, index) => {
      const targets = resolveTargets(item, mapping);
      const draft = { ...emptyDraft(settings), raw: item.content, type: item.type, style: 'raw' as const, title: item.title, mention: 'none' as const, showCountdown: false, poll: item.poll };
      const post = targets ? buildPost(draft, targets, item.at) : null;
      const row: Row = { index, item, targets, post };
      const errors = validatePayload(composePayload(draft, settings));
      if (!targets) row.blocked = '還沒對應頻道';
      else if (errors.length) row.blocked = errors[0];
      else if (Date.parse(item.at) < now) row.blocked = '時間已經過了';
      if (targets && !row.blocked) row.duplicate = findDuplicate(item.content, item.at, targets, posts);
      return row;
    });
  }, [bundle, mapping, settings, posts, now]);

  const isChecked = (r: Row) => !r.blocked && (overrides[r.index] ?? !r.duplicate);
  const chosen = rows.filter(isChecked);
  const refs = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; count: number; hits: number }>();
    for (const item of bundle?.posts ?? []) {
      for (const ref of item.to) {
        const key = refKey(ref);
        const cur = seen.get(key);
        if (cur) cur.count++;
        else seen.set(key, { key, label: refLabel(ref), count: 1, hits: matchChannels(ref, channels).length });
      }
    }
    return [...seen.values()];
  }, [bundle, channels]);
  const unmapped = refs.filter((r) => !mapping[r.key]).length;

  async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) {
      setError('檔案太大了，匯入檔通常只有幾十 KB。');
      return;
    }
    await load(await file.text());
  }

  async function submit() {
    if (!chosen.length || progress) return;
    const ok = await askConfirm({
      title: `排程 ${chosen.length} 則貼文？`,
      body: `會依各自的時間自動發到 Discord，第一則在 ${fmtDate(chosen[0].item.at)} ${fmtTime(chosen[0].item.at)}。之後可以在「發送排程」修改或取消。`,
      confirmLabel: `排程 ${chosen.length} 則`,
    });
    if (!ok) return;
    const list = [...chosen].sort((a, b) => Date.parse(a.item.at) - Date.parse(b.item.at)).map((r) => r.post!);
    setProgress({ done: 0, total: list.length });
    const res = await importPosts(list, (done) => setProgress({ done, total: list.length }));
    setProgress(null);
    if (res.error) {
      toast('error', `已建立 ${res.created} 則，其餘失敗：${res.error}。重新整理後再匯入一次，已建立的會自動標成重複並略過。`);
      return;
    }
    clearPendingImport();
    toast('ok', `已排程 ${res.created} 則貼文`);
    navigate('queue');
  }

  function reset() {
    clearPendingImport();
    setBundle(null);
    setSource('');
    setError('');
  }

  return (
    <>
      <div class="page-head">
        <div class="titles">
          <div class="eyebrow">TNDA RELAY / IMPORT</div>
          <h1 class="page-title">批次匯入排程</h1>
          <p class="page-sub">一次排好整學期的公告：確認頻道與內容後，按一下就全部排進發送排程。</p>
        </div>
        <div class="page-actions">
          {bundle ? (
            <Btn variant="ghost" icon="x" onClick={reset} disabled={!!progress}>
              換一份
            </Btn>
          ) : (
            <Btn variant="ghost" icon="left" onClick={() => navigate('compose')}>
              返回
            </Btn>
          )}
        </div>
      </div>

      {!bundle ? (
        <section class="card card-pad stack" style={{ maxWidth: 760 }}>
          <h3>讀取匯入檔</h3>
          <p class="small muted">匯入檔可以請 Claude 依你的課表與公告內容產生。選擇檔案、拖曳到下面，或直接貼上匯入連結／內容。</p>
          <label
            class="imp-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer?.files?.[0]);
            }}
          >
            <Icon name="inbox" />
            <span>
              <b>選擇匯入檔</b>或拖曳到這裡（.json）
            </span>
            <input type="file" accept=".json,application/json,text/plain" class="sr-only" onChange={(e) => void onFile((e.currentTarget as HTMLInputElement).files?.[0])} />
          </label>
          <div class="field">
            <label for="imp-text">或貼上匯入連結／內容</label>
            <textarea id="imp-text" class="textarea mono" rows={4} value={source} placeholder="https://…#import=z.…" onInput={(e) => setSource((e.currentTarget as HTMLTextAreaElement).value)} />
          </div>
          {error ? (
            <div class="callout callout-bad" role="alert">
              <Icon name="alert" />
              <span>{error}</span>
            </div>
          ) : null}
          <div class="row">
            <Btn variant="primary" icon="download" busy={loading} disabled={!source.trim()} onClick={() => void load(source)}>
              讀取
            </Btn>
          </div>
        </section>
      ) : (
        <div class="stack" style={{ gap: 18 }}>
          <section class="card card-pad stack">
            <div class="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3>{bundle.name || '匯入的貼文'}</h3>
                <p class="small muted">
                  共 {rows.length} 則，{fmtDate(bundle.posts.reduce((m, p) => (p.at < m ? p.at : m), bundle.posts[0].at))} ～{' '}
                  {fmtDate(bundle.posts.reduce((m, p) => (p.at > m ? p.at : m), bundle.posts[0].at))}。內容會照原樣發送（原文模式）。
                </p>
              </div>
            </div>
            <div>
              <h4 class="imp-h">1. 確認頻道對應</h4>
              <div class="imp-map">
                {refs.map((r) => (
                  <div key={r.key} class={`imp-map-row ${mapping[r.key] ? '' : 'bad'}`}>
                    <span class="imp-map-from">
                      <b>{r.label}</b>
                      <span class="small faint">{r.count} 則</span>
                    </span>
                    <Icon name="right" />
                    <select
                      class="input"
                      aria-label={`${r.label} 要發到哪個頻道`}
                      value={mapping[r.key] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [r.key]: (e.currentTarget as HTMLSelectElement).value })}
                    >
                      <option value="">{r.hits > 1 ? '有多個符合，請選擇…' : '找不到符合的頻道，請選擇…'}</option>
                      {groupChannels(channels).map(([groupName, list]) => (
                        <optgroup key={groupName} label={groupName}>
                          {list.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.groupName}・{c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section class="card card-pad stack">
            <div class="row" style={{ justifyContent: 'space-between' }}>
              <h4 class="imp-h" style={{ margin: 0 }}>
                2. 確認要排程的貼文
              </h4>
              <div class="row" style={{ gap: 6 }}>
                <Btn size="sm" variant="ghost" onClick={() => setOverrides(Object.fromEntries(rows.map((r) => [r.index, true])))}>
                  全選
                </Btn>
                <Btn size="sm" variant="ghost" onClick={() => setOverrides(Object.fromEntries(rows.map((r) => [r.index, false])))}>
                  全不選
                </Btn>
              </div>
            </div>
            <ol class="imp-list">
              {rows.map((r) => (
                <ImportRow
                  key={r.index}
                  row={r}
                  checked={isChecked(r)}
                  onToggle={(v) => setOverrides({ ...overrides, [r.index]: v })}
                  channels={channels}
                  theme={previewTheme}
                />
              ))}
            </ol>
          </section>

          <div class="imp-bar">
            <span class="small">
              {unmapped ? (
                <span class="pill pill-bad">還有 {unmapped} 個頻道沒有對應</span>
              ) : (
                <>
                  已選 <b>{chosen.length}</b> / {rows.length} 則
                </>
              )}
            </span>
            <Btn variant="primary" icon="clock" busy={!!progress} disabled={!chosen.length} onClick={() => void submit()}>
              {progress ? `建立中 ${progress.done}/${progress.total}…` : `排程 ${chosen.length} 則`}
            </Btn>
          </div>
        </div>
      )}
    </>
  );
}

function groupChannels(channels: Channel[]): Array<[string, Channel[]]> {
  const map = new Map<string, Channel[]>();
  for (const c of channels) map.set(c.groupName, [...(map.get(c.groupName) ?? []), c]);
  return [...map.entries()];
}

function ImportRow({ row, checked, onToggle, channels, theme }: { row: Row; checked: boolean; onToggle: (v: boolean) => void; channels: Channel[]; theme: 'dark' | 'light' }) {
  const [open, setOpen] = useState(false);
  const { item } = row;
  const id = `imp-${row.index}`;
  return (
    <li class={`imp-row ${checked ? '' : 'off'}`}>
      <input id={id} type="checkbox" class="imp-check" checked={checked} disabled={!!row.blocked} onChange={(e) => onToggle((e.currentTarget as HTMLInputElement).checked)} />
      <label for={id} class="imp-when">
        <b>{fmtDate(item.at)}</b>
        <span class="mono">{fmtTime(item.at)}</span>
      </label>
      <div class="imp-main">
        <div class="imp-title">
          <label for={id}>{item.title}</label>
          <TypeTag type={item.type} />
        </div>
        <div class="imp-meta">
          {row.targets ? <ChannelChips ids={row.targets} channels={channels} /> : <span class="small faint">{item.to.map(refLabel).join('、')}</span>}
          {row.blocked ? <span class="pill pill-bad">{row.blocked}</span> : null}
          {row.duplicate ? <span class="pill pill-warn">已經排過，預設略過</span> : null}
          {item.poll ? <span class="pill">📊 投票・{item.poll.multi ? '可複選' : '單選'}</span> : null}
        </div>
        {item.note ? (
          <div class="callout callout-warn small">
            <Icon name="alert" />
            <span>{item.note}</span>
          </div>
        ) : null}
        <button type="button" class="imp-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="eye" />
          {open ? '收起預覽' : '預覽'}
        </button>
        {open && row.post ? (
          <DiscordPreview payload={row.post.payload} channel={channels.find((c) => c.id === row.targets?.[0])} at={Date.parse(item.at)} theme={theme} />
        ) : open ? (
          <pre class="imp-raw">{item.content}</pre>
        ) : null}
      </div>
    </li>
  );
}
