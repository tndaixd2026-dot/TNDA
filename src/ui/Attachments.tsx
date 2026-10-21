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
  /** 本機已有的網址（例如匯入檔裡的圖片） */
  url?: string;
  ref?: AttachmentRef;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isImage = (type: string) => /^image\//.test(type);

/** 需要時才解密的圖片 */
function useFileUrl(file: PreviewFile): string | undefined {
  const [url, setUrl] = useState(file.url);
  useEffect(() => {
    if (file.url || !file.ref || !isImage(file.type)) return;
    let alive = true;
    attachmentUrl(file.ref)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [file.ref?.id, file.url]);
  return url ?? file.url;
}

function Thumb({ file }: { file: PreviewFile }) {
  const url = useFileUrl(file);
  if (isImage(file.type) && url) return <img class="att-thumb" src={url} alt={file.name} />;
  return (
    <span class="att-thumb att-icon" aria-hidden="true">
      <Icon name="file" />
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

/** Discord 預覽裡的附檔 */
export function PreviewAttachments({ files }: { files: PreviewFile[] }) {
  const images = files.filter((f) => isImage(f.type));
  const others = files.filter((f) => !isImage(f.type));
  return (
    <div class="dc-files">
      {images.length ? (
        <div class={`dc-gallery n${Math.min(images.length, 4)}`}>
          {images.map((f, i) => (
            <PreviewImage key={i} file={f} />
          ))}
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
  const url = useFileUrl(file);
  return url ? <img src={url} alt={file.name} loading="lazy" /> : <div class="dc-img-loading">{file.name}</div>;
}
