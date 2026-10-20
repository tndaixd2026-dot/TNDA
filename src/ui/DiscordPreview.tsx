// 模擬 Discord 訊息的樣子，讓老師在發送前就看到學生會看到什麼。

import type { JSX } from 'preact';
import type { Channel, DiscordEmbed, DiscordPayload, DiscordPoll } from '../core/types.ts';
import { pollDurationLabel } from '../format/composer.ts';
import { DiscordMarkdown } from '../format/markdown.tsx';
import { fmtTime, sameTpDay, addDays, fmtDate } from '../core/time.ts';

function stamp(at: number): string {
  const now = Date.now();
  if (sameTpDay(at, now)) return `今天 ${fmtTime(at)}`;
  if (sameTpDay(at, addDays(now, -1))) return `昨天 ${fmtTime(at)}`;
  if (sameTpDay(at, addDays(now, 1))) return `明天 ${fmtTime(at)}`;
  return `${fmtDate(at)} ${fmtTime(at)}`;
}

function Fields({ embed, refTime }: { embed: DiscordEmbed; refTime: number }) {
  const fields = embed.fields ?? [];
  // Discord 會把連續的 inline 欄位排成一列（最多 3 個）
  const rows: Array<typeof fields> = [];
  let run: typeof fields = [];
  for (const f of fields) {
    if (f.inline) {
      run.push(f);
      if (run.length === 3) {
        rows.push(run);
        run = [];
      }
    } else {
      if (run.length) rows.push(run);
      run = [];
      rows.push([f]);
    }
  }
  if (run.length) rows.push(run);
  return (
    <div class="dc-fields">
      {rows.flatMap((row, ri) => {
        const span = row.length === 1 && !row[0].inline ? 12 : 12 / row.length;
        return row.map((f, i) => (
          <div key={`${ri}-${i}`} class="dc-field" style={{ gridColumn: `span ${span}` }}>
            <div class="dc-field-name">
              <DiscordMarkdown text={f.name} refTime={refTime} compact />
            </div>
            <DiscordMarkdown text={f.value} refTime={refTime} compact />
          </div>
        ));
      })}
    </div>
  );
}

function Poll({ poll }: { poll: DiscordPoll }) {
  return (
    <div class="dc-poll">
      <div class="dc-poll-q">{poll.question.text || '（還沒有填問題）'}</div>
      <div class="dc-poll-hint">{poll.allow_multiselect ? '選擇一個或多個答案' : '選擇一個答案'}</div>
      <div class="dc-poll-opts">
        {poll.answers.map((a, i) => (
          <div key={i} class="dc-poll-opt">
            {a.poll_media.emoji ? <span class="emo">{a.poll_media.emoji.name}</span> : null}
            <span class="txt">{a.poll_media.text}</span>
            <span class={`mark ${poll.allow_multiselect ? 'multi' : ''}`} aria-hidden="true" />
          </div>
        ))}
      </div>
      <div class="dc-poll-foot">0 票 · 剩餘 {pollDurationLabel(poll.duration)}</div>
    </div>
  );
}

function Embed({ embed, refTime }: { embed: DiscordEmbed; refTime: number }) {
  const color = embed.color !== undefined ? `#${embed.color.toString(16).padStart(6, '0')}` : undefined;
  return (
    <div class="dc-embed" style={{ '--ec': color } as JSX.CSSProperties}>
      {embed.author ? <div class="dc-footer">{embed.author.name}</div> : null}
      {embed.title ? (
        <div class="dc-embed-title">
          {embed.url ? (
            <a class="dc-link" href={embed.url} target="_blank" rel="noopener noreferrer">
              {embed.title}
            </a>
          ) : (
            <DiscordMarkdown text={embed.title} refTime={refTime} compact />
          )}
        </div>
      ) : null}
      {embed.description ? (
        <div class="dc-embed-desc">
          <DiscordMarkdown text={embed.description} refTime={refTime} />
        </div>
      ) : null}
      {embed.fields?.length ? <Fields embed={embed} refTime={refTime} /> : null}
      {embed.image?.url ? <img class="dc-embed-img" src={embed.image.url} alt="" loading="lazy" /> : null}
      {embed.footer?.text ? <div class="dc-footer">{embed.footer.text}</div> : null}
    </div>
  );
}

export function DiscordPreview({
  payload,
  channel,
  at,
  theme = 'dark',
  edited,
}: {
  payload: DiscordPayload;
  channel?: Channel;
  at: number;
  theme?: 'dark' | 'light';
  edited?: boolean;
}) {
  const name = payload.username || 'TNDA 課務小幫手';
  return (
    <div class={`dc ${theme === 'light' ? 'light' : ''}`} aria-label="Discord 預覽">
      <div class="dc-channel">
        <span class="hash">#</span>
        {channel?.name ?? '頻道'}
        {channel ? <span class="g">{channel.groupName}</span> : null}
      </div>
      <div class="dc-msg">
        {payload.avatar_url ? (
          <img class="dc-avatar" src={payload.avatar_url} alt="" />
        ) : (
          <div class="dc-avatar" aria-hidden="true">
            <svg viewBox="0 0 40 40" width="40" height="40">
              <rect width="40" height="40" fill="#fe5732" />
              <path d="M15 27V13h5.5a4 4 0 0 1 0 8H15M20.5 21l4.5 6" fill="none" stroke="#111" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        )}
        <div class="dc-body">
          <div class="dc-head">
            <span class="dc-name">{name}</span>
            <span class="dc-app">APP</span>
            <span class="dc-stamp">{stamp(at)}</span>
          </div>
          {payload.content ? <DiscordMarkdown text={payload.content} refTime={at} /> : null}
          {payload.poll ? <Poll poll={payload.poll} /> : null}
          {(payload.embeds ?? []).map((e, i) => (
            <Embed key={i} embed={e} refTime={at} />
          ))}
          {edited ? <span class="dc-edited">（已編輯）</span> : null}
        </div>
      </div>
    </div>
  );
}
