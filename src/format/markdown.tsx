// Discord Markdown 的預覽渲染（只用於畫面預覽，實際格式由 Discord 處理）。

import type { ComponentChildren, VNode } from 'preact';
import { fmtDiscordTimestamp, fmtLong } from '../core/time.ts';

interface Ctx {
  ref: number;
  key: number;
}

type Rule = { re: RegExp; render: (m: RegExpExecArray, ctx: Ctx) => ComponentChildren };

const RULES: Rule[] = [
  { re: /^\\([\\*_~`|>#[\]()-])/, render: (m) => m[1] },
  { re: /^`([^`\n]+)`/, render: (m, c) => <code key={c.key++} class="dc-code">{m[1]}</code> },
  { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, render: (m, c) => <strong key={c.key++}>{inline(m[1], c)}</strong> },
  { re: /^__([\s\S]+?)__(?!_)/, render: (m, c) => <u key={c.key++}>{inline(m[1], c)}</u> },
  { re: /^~~([\s\S]+?)~~/, render: (m, c) => <s key={c.key++}>{inline(m[1], c)}</s> },
  { re: /^\|\|([\s\S]+?)\|\|/, render: (m, c) => <Spoiler key={c.key++}>{inline(m[1], c)}</Spoiler> },
  { re: /^\*([^*\n]+?)\*(?!\*)/, render: (m, c) => <em key={c.key++}>{inline(m[1], c)}</em> },
  { re: /^_([^_\n]+?)_(?![_\w])/, render: (m, c) => <em key={c.key++}>{inline(m[1], c)}</em> },
  {
    re: /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/,
    render: (m, c) => (
      <a key={c.key++} class="dc-link" href={m[2]} target="_blank" rel="noopener noreferrer" title={m[2]}>
        {inline(m[1], c)}
      </a>
    ),
  },
  {
    re: /^<t:(-?\d+)(?::([tTdDfFR]))?>/,
    render: (m, c) => (
      <span key={c.key++} class="dc-time" title={fmtLong(Number(m[1]) * 1000)}>
        {fmtDiscordTimestamp(Number(m[1]), m[2] ?? 'f', c.ref)}
      </span>
    ),
  },
  {
    re: /^https?:\/\/[^\s<]+[^\s<.,:;"')\]!?。，]/,
    render: (m, c) => (
      <a key={c.key++} class="dc-link" href={m[0]} target="_blank" rel="noopener noreferrer">
        {m[0]}
      </a>
    ),
  },
  { re: /^@(everyone|here)/, render: (m, c) => <span key={c.key++} class="dc-mention">@{m[1]}</span> },
];

const SPECIAL = /[\\`*_~|[<h@]/;

function inline(text: string, ctx: Ctx): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (SPECIAL.test(ch)) {
      const rest = text.slice(i);
      let matched = false;
      for (const rule of RULES) {
        const m = rule.re.exec(rest);
        if (m) {
          if (buf) {
            out.push(buf);
            buf = '';
          }
          out.push(rule.render(m, ctx));
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    buf += ch;
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

function Spoiler({ children }: { children: ComponentChildren }) {
  return (
    <span class="dc-spoiler" onClick={(e) => (e.currentTarget as HTMLElement).classList.add('open')}>
      {children}
    </span>
  );
}

function withBreaks(lines: string[], ctx: Ctx): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push(<br key={ctx.key++} />);
    out.push(...inline(l, ctx));
  });
  return out;
}

/** 把 Discord Markdown 轉成預覽用的 VNode */
export function DiscordMarkdown({ text, refTime, compact }: { text: string; refTime: number; compact?: boolean }): VNode {
  const ctx: Ctx = { ref: refTime, key: 0 };
  const blocks: ComponentChildren[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(
        <div key={ctx.key++} class="dc-p">
          {withBreaks(para, ctx)}
        </div>,
      );
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      blocks.push(
        <pre key={ctx.key++} class="dc-pre">
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith('>>> ')) {
      flush();
      const rest = [line.slice(4), ...lines.slice(i + 1)];
      blocks.push(
        <blockquote key={ctx.key++} class="dc-quote">
          {withBreaks(rest, ctx)}
        </blockquote>,
      );
      break;
    }
    if (/^> /.test(line) || line === '>') {
      flush();
      const q: string[] = [];
      while (i < lines.length && (/^> /.test(lines[i]) || lines[i] === '>')) q.push(lines[i++].slice(2));
      i--;
      blocks.push(
        <blockquote key={ctx.key++} class="dc-quote">
          {withBreaks(q, ctx)}
        </blockquote>,
      );
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h && !compact) {
      flush();
      const Tag = (`h${h[1].length}` as unknown) as 'h1';
      blocks.push(
        <Tag key={ctx.key++} class={`dc-h dc-h${h[1].length}`}>
          {inline(h[2], ctx)}
        </Tag>,
      );
      continue;
    }
    const sub = /^-# (.+)$/.exec(line);
    if (sub) {
      flush();
      blocks.push(
        <div key={ctx.key++} class="dc-sub">
          {inline(sub[1], ctx)}
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(line)) {
      flush();
      const ordered = /^\s*\d+\. /.test(line);
      const items: Array<{ depth: number; text: string; n?: number }> = [];
      while (i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i]) && /^\s*\d+\. /.test(lines[i]) === ordered) {
        const m = /^(\s*)([-*]|(\d+)\.) (.*)$/.exec(lines[i])!;
        items.push({ depth: m[1].length >= 2 ? 1 : 0, text: m[4], n: m[3] ? Number(m[3]) : undefined });
        i++;
      }
      i--;
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={ctx.key++} class="dc-list" start={ordered ? items[0].n : undefined}>
          {items.map((it) => (
            <li key={ctx.key++} class={it.depth ? 'nested' : undefined}>
              {inline(it.text, ctx)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return <div class="dc-md">{blocks}</div>;
}
