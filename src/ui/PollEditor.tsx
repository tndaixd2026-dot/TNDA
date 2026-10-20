// 撰寫頁的投票設定：問題、選項（可加 emoji）、開放時間、單選／複選。

import type { PollDraft } from '../core/types.ts';
import { LIMITS } from '../core/discord.ts';
import { POLL_DURATIONS, emptyPoll, pollDurationLabel, splitAnswer } from '../format/composer.ts';
import { Btn, Switch } from './kit.tsx';

export function PollEditor({ poll, onChange, locked }: { poll?: PollDraft; onChange: (p: PollDraft | undefined) => void; locked?: boolean }) {
  if (locked) {
    return poll ? <p class="small muted">這則訊息附有投票。Discord 不允許修改已發出的投票，只會更新文字內容。</p> : null;
  }
  const update = (patch: Partial<PollDraft>) => poll && onChange({ ...poll, ...patch });
  const setAnswer = (i: number, a: PollDraft['answers'][number]) => poll && update({ answers: poll.answers.map((x, j) => (j === i ? a : x)) });
  const durations = poll && !POLL_DURATIONS.some((d) => d.hours === poll.hours) ? [...POLL_DURATIONS, { hours: poll.hours, label: pollDurationLabel(poll.hours) }] : POLL_DURATIONS;
  return (
    <div class="poll-editor stack">
      <Switch id="f-poll" checked={!!poll} onChange={(v) => onChange(v ? emptyPoll() : undefined)}>
        加入投票（學員在 Discord 上直接點選）
      </Switch>
      {poll ? (
        <>
          <div class="field">
            <label for="f-poll-q">
              投票問題 <span class="char-count">{poll.question.length}/{LIMITS.pollQuestion}</span>
            </label>
            <input id="f-poll-q" class="input" value={poll.question} placeholder="例如：你對 TouchDesigner 的熟悉程度？" onInput={(e) => update({ question: (e.currentTarget as HTMLInputElement).value })} />
          </div>
          <div class="field">
            <span class="label">選項（左邊可以放一個 emoji）</span>
            <div class="stack" style={{ gap: 6 }}>
              {poll.answers.map((a, i) => (
                <div key={i} class="poll-row">
                  <input
                    class="input poll-emoji"
                    aria-label={`選項 ${i + 1} 的 emoji`}
                    placeholder="🙂"
                    value={a.emoji ?? ''}
                    onInput={(e) => setAnswer(i, { ...a, emoji: (e.currentTarget as HTMLInputElement).value })}
                  />
                  <input
                    class="input"
                    aria-label={`選項 ${i + 1}`}
                    placeholder={`選項 ${i + 1}`}
                    maxLength={LIMITS.pollAnswer + 20}
                    value={a.text}
                    onInput={(e) => {
                      const value = (e.currentTarget as HTMLInputElement).value;
                      // 貼上「🛠️ 有使用 TD 做過專案」時，自動把 emoji 拆到左邊
                      const split = a.emoji ? { text: value } : splitAnswer(value);
                      setAnswer(i, split.emoji ? { emoji: split.emoji, text: split.text } : { ...a, text: value });
                    }}
                  />
                  <Btn size="sm" variant="ghost" iconOnly icon="x" disabled={poll.answers.length <= 2} onClick={() => update({ answers: poll.answers.filter((_, j) => j !== i) })}>
                    移除選項 {i + 1}
                  </Btn>
                </div>
              ))}
            </div>
            <div>
              <Btn size="sm" variant="ghost" icon="plus" disabled={poll.answers.length >= LIMITS.pollAnswers} onClick={() => update({ answers: [...poll.answers, { text: '' }] })}>
                新增選項
              </Btn>
            </div>
          </div>
          <div class="grid-2">
            <div class="field">
              <label for="f-poll-hours">投票時間</label>
              <select id="f-poll-hours" class="input" value={String(poll.hours)} onChange={(e) => update({ hours: Number((e.currentTarget as HTMLSelectElement).value) })}>
                {durations.map((d) => (
                  <option key={d.hours} value={String(d.hours)}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div class="field" style={{ justifyContent: 'flex-end' }}>
              <Switch id="f-poll-multi" checked={poll.multi} onChange={(v) => update({ multi: v })}>
                可以複選
              </Switch>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
