// 附檔：撰寫頁的上傳清單，以及 Discord 預覽裡的圖片／檔案。

import { useEffect, useRef, useState } from 'preact/hooks';
import type { AttachmentRef } from '../core/types.ts';
import { LIMITS, attachmentProblems } from '../core/discord.ts';
import { attachmentUrl, toast, uploadAttachment } from '../data/store.ts';
import { Icon } from './icons.tsx';
import { Btn } from './kit.tsx';

export interface PreviewFile {
  name: string;
  type: string;
  size: number;
  /** 本機已有的網址 */
  url?: string;
  /** 本機的檔案內容（例如匯入的 .zip 裡的照片），需要時才讀 */
  read?: () => Promise<Uint8Array>;
  ref?: AttachmentRef;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (type: string) => /^image\//.test(type);
const isVideo = (type: string) => /^video\//.test(type);

const localUrls = new WeakMap<() => Promise<Uint8Array>, Promise<string>>();

function localUrl(file: PreviewFile & { read: () => Promise<Uint8Array> }): Promise<string> {
  let url = localUrls.get(file.read);
  if (!url) {
    url = file.read().then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.type })));
    localUrls.set(file.read, url);
  }
  return url;
}

/** 需要時才讀取／解密；影片要等使用者按下播放才載入 */
function useFileUrl(file: PreviewFile, enabled: boolean): string | undefined {
  const [url, setUrl] = useState(file.url);
  useEffect(() => {
    if (file.url || !enabled) return;
    const load = file.read ? localUrl({ ...file, read: file.read }) : file.ref ? attachmentUrl(file.ref) : null;
    if (!load) return;
    let alive = true;
    load.then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [file.ref?.id, file.read, file.url, enabled]);
  return url ?? file.url;
}

function Thumb({ file }: { file: PreviewFile }) {
  const url = useFileUrl(file, isImage(file.type));
  if (isImage(file.type) && url) return <img class="att-thumb" src={url} alt={file.name} />;
  return (
    <span class="att-thumb att-icon" aria-hidden="true">
      <Icon name={isVideo(file.type) ? 'play' : 'file'} />
    </span>
  );
}

export function AttachmentsEditor({ refs, onChange, locked }: { refs: AttachmentRef[]; onChange: (refs: AttachmentRef[]) => void; locked?: boolean }) {
  const [busy, setBusy] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(refs);
  latest.current = refs;
  const problems = attachmentProblems(refs);

  async function add(list: FileList | null) {
    if (!list?.length) return;
    const files = [...list];
    if (refs.length + files.length > LIMITS.files) {
      toast('error', `附檔最多 ${LIMITS.files} 個`);
      return;
    }
    setBusy((n) => n + files.length);
    for (const f of files) {
      try {
        const ref = await uploadAttachment({ name: f.name, type: f.type || 'application/octet-stream', bytes: new Uint8Array(await f.arrayBuffer()) });
        latest.current = [...latest.current, ref];
        onChange(latest.current);
      } catch (err) {
        toast('error', `「${f.name}」上傳失敗：${(err as Error).message}`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
    if (input.current) input.current.value = '';
  }

  if (locked) {
    return refs.length ? <p class="small muted">這則訊息附有 {refs.length} 個檔案。已發出的訊息無法更換附檔，只會更新文字內容。</p> : null;
  }

  return (
    <div class="att-editor stack">
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <span class="label" style={{ margin: 0 }}>
          附檔（圖片、PDF、影片）
        </span>
        <label class={`btn btn-sm ${busy ? 'is-busy' : ''}`}>
          <Icon name={busy ? 'loader' : 'upload'} class={busy ? 'spin' : undefined} />
          {busy ? `上傳中（${busy}）…` : '選擇檔案'}
          <input ref={input} type="file" multiple class="sr-only" accept="image/*,video/*,application/pdf" onChange={(e) => void add((e.currentTarget as HTMLInputElement).files)} />
        </label>
      </div>
      {refs.length ? (
        <ul class="att-list">
          {refs.map((r) => (
            <li key={r.id} class="att-item">
              <Thumb file={{ ...r, ref: r }} />
              <span class="att-name">
                <b>{r.name}</b>
                <span class="small faint">{fmtSize(r.size)}</span>
              </span>
              <Btn size="sm" variant="ghost" iconOnly icon="x" onClick={() => onChange(refs.filter((x) => x.id !== r.id))}>
                移除 {r.name}
              </Btn>
            </li>
          ))}
        </ul>
      ) : (
        <p class="small faint">最多 {LIMITS.files} 個，總共 10 MB 以內。檔案會加密後存在 GitHub，到時間跟文字一起發出。</p>
      )}
      {problems.map((p) => (
        <p key={p} class="small" role="alert" style={{ color: 'var(--danger-text)' }}>
          {p}
        </p>
      ))}
    </div>
  );
}

/** Discord 預覽裡的附檔：圖片與影片排成相簿，其他檔案顯示成下載卡片 */
export function PreviewAttachments({ files }: { files: PreviewFile[] }) {
  const media = files.filter((f) => isImage(f.type) || isVideo(f.type));
  const others = files.filter((f) => !media.includes(f));
  return (
    <div class="dc-files">
      {media.length ? (
        <div class={`dc-gallery n${Math.min(media.length, 4)}`}>
          {media.map((f, i) => (isVideo(f.type) ? <PreviewVideo key={i} file={f} /> : <PreviewImage key={i} file={f} />))}
        </div>
      ) : null}
      {others.map((f, i) => (
        <div key={i} class="dc-file">
          <Icon name="file" />
          <span>
            <span class="dc-link">{f.name}</span>
            <span class="dc-file-size">{fmtSize(f.size)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function PreviewImage({ file }: { file: PreviewFile }) {
  const url = useFileUrl(file, true);
  return url ? <img src={url} alt={file.name} loading="lazy" /> : <div class="dc-img-loading">{file.name}</div>;
}

function PreviewVideo({ file }: { file: PreviewFile }) {
  const [play, setPlay] = useState(false);
  const url = useFileUrl(file, play);
  if (play && url) return <video src={url} controls autoPlay playsInline aria-label={file.name} />;
  return (
    <button type="button" class="dc-video" onClick={() => setPlay(true)} aria-label={`播放 ${file.name}`}>
      <span class="dc-video-play">
        <Icon name={play ? 'loader' : 'play'} class={play ? 'spin' : undefined} />
      </span>
      <span class="dc-video-name">
        {file.name}・{fmtSize(file.size)}
      </span>
    </button>
  );
}
