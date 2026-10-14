// 共用的小元件：按鈕、狀態標籤、對話框、側邊面板、確認視窗。

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Channel, Post, PostStatus, PostType } from '../core/types.ts';
import { TYPE_META } from '../format/composer.ts';
import { deliveryOf } from '../core/delivery.ts';
import { Icon, type IconName } from './icons.tsx';

type BtnProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'express' | 'ghost' | 'danger' | 'default';
  size?: 'sm' | 'md';
  icon?: IconName;
  iconOnly?: boolean;
  busy?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
};

export function Btn({ variant = 'default', size = 'md', icon, iconOnly, busy, children, class: cls, disabled, type = 'button', ...rest }: BtnProps) {
  const classes = ['btn', variant !== 'default' && `btn-${variant}`, size === 'sm' && 'btn-sm', iconOnly && 'btn-icon', cls].filter(Boolean).join(' ');
  return (
    <button type={type} class={classes} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <Icon name="loader" class="spin" /> : icon ? <Icon name={icon} /> : null}
      {iconOnly ? <span class="sr-only">{children}</span> : children}
    </button>
  );
}

export const STATUS_LABEL: Record<PostStatus, string> = {
  draft: '草稿',
  scheduled: '排程中',
  sending: '發送中',
  sent: '已發送',
  partial: '部分失敗',
  failed: '失敗',
  canceled: '已取消',
};

export function isRetrying(post: Post): boolean {
  return post.status === 'scheduled' && post.channels.some((c) => deliveryOf(post, c).status === 'failed');
}

export function StatusPill({ post }: { post: Post }) {
  const s = post.status;
  if (isRetrying(post)) {
    return (
      <span class="pill pill-warn">
        <span class="dot" />
        重試中
      </span>
    );
  }
  const cls =
    s === 'sent' ? 'pill-ok' : s === 'scheduled' ? 'pill-wait' : s === 'sending' ? 'pill-wait pill-live' : s === 'partial' ? 'pill-warn' : s === 'failed' ? 'pill-bad' : '';
  const allDeleted = s === 'sent' && post.channels.every((c) => deliveryOf(post, c).deletedAt);
  return (
    <span class={`pill ${allDeleted ? '' : cls}`}>
      <span class="dot" />
      {allDeleted ? '已撤回' : STATUS_LABEL[s]}
    </span>
  );
}

export function TypeTag({ type }: { type: PostType }) {
  const m = TYPE_META[type];
  return (
    <span class="type-tag" style={{ '--c': m.hex } as JSX.CSSProperties}>
      <i />
      {m.label}
    </span>
  );
}

export function ChannelChips({ ids, channels, max = 4 }: { ids: string[]; channels: Channel[]; max?: number }) {
  const map = new Map(channels.map((c) => [c.id, c]));
  const shown = ids.slice(0, max);
  return (
    <span class="chips">
      {shown.map((id) => {
        const c = map.get(id);
        return (
          <span key={id} class={`chip ${c?.audience === 'staff' ? 'staff' : ''}`} title={c ? `${c.groupName}／${c.name}` : id}>
            <b>{c?.group ?? '?'}</b>
            {c?.name ?? id}
          </span>
        );
      })}
      {ids.length > max ? <span class="chip">+{ids.length - max}</span> : null}
    </span>
  );
}

export function Empty({ icon = 'inbox', title, children }: { icon?: IconName; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}

function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('input, textarea, select, button');
    target?.focus({ preventScroll: true });
  }, []);
  return ref;
}

export function Modal({ title, onClose, children, wide, labelId = 'modal-title' }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean; labelId?: string }) {
  useEscape(onClose);
  const ref = useAutoFocus<HTMLDivElement>();
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <div class={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref}>
        <h2 id={labelId}>{title}</h2>
        {children}
      </div>
    </>
  );
}

export function Drawer({ onClose, head, children, foot }: { onClose: () => void; head: ComponentChildren; children: ComponentChildren; foot?: ComponentChildren }) {
  useEscape(onClose);
  const ref = useAutoFocus<HTMLDivElement>();
  return (
    <>
      <div class="scrim" onClick={onClose} />
      <aside class="drawer" role="dialog" aria-modal="true" ref={ref}>
        <div class="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>{head}</div>
          <Btn variant="ghost" iconOnly icon="x" onClick={onClose} data-autofocus>
            關閉
          </Btn>
        </div>
        <div class="drawer-body">{children}</div>
        {foot ? <div class="drawer-foot">{foot}</div> : null}
      </aside>
    </>
  );
}

// ───────────── 確認視窗（取代瀏覽器的 confirm()） ─────────────

interface ConfirmReq {
  title: string;
  body?: ComponentChildren;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

let current: ConfirmReq | null = null;
const confirmListeners = new Set<() => void>();

export function askConfirm(opts: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    current = { ...opts, resolve };
    confirmListeners.forEach((l) => l());
  });
}

export function ConfirmHost() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    confirmListeners.add(l);
    return () => {
      confirmListeners.delete(l);
    };
  }, []);
  if (!current) return null;
  const req = current;
  const done = (ok: boolean) => {
    current = null;
    req.resolve(ok);
    confirmListeners.forEach((l) => l());
  };
  return (
    <Modal title={req.title} onClose={() => done(false)} labelId="confirm-title">
      {req.body ? <div class="muted">{req.body}</div> : null}
      <div class="modal-actions">
        <Btn onClick={() => done(false)}>返回</Btn>
        <Btn variant={req.danger ? 'express' : 'primary'} onClick={() => done(true)} data-autofocus>
          {req.confirmLabel ?? '確定'}
        </Btn>
      </div>
    </Modal>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ComponentChildren }>; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ComponentChildren }) {
  return (
    <label class="switch" for={id}>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>{children}</span>
    </label>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, type = 'text/plain') {
  try {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    /* 某些內嵌環境不允許下載 */
  }
}
