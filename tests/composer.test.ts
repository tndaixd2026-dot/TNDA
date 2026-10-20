import { describe, expect, it } from 'vitest';
import { composePayload, emptyDraft, mentionsIn, splitAnswer } from '../src/format/composer.ts';
import { editWebhookMessage, validatePayload } from '../src/core/discord.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';

describe('原文模式', () => {
  const raw = '<@&1538724579508232212>\n## ⏰ 表單明天截止\n・**10/25（日）23:59**\n```\n地址第 1 行：深中路58號\n```\n會議連結：<https://meet.google.com/abc-defg-hij>';

  it('內容照原樣送出，不加標題與欄位', () => {
    const d = { ...emptyDraft(DEFAULT_SETTINGS), style: 'raw' as const, raw: `\n${raw}\n\n`, title: '內部名稱', location: '302 教室' };
    const p = composePayload(d, { ...DEFAULT_SETTINGS, footer: '頁尾' });
    expect(p.content).toBe(raw);
    expect(p.embeds).toBeUndefined();
    expect(p.username).toBe(DEFAULT_SETTINGS.senderName);
    expect(validatePayload(p)).toEqual([]);
  });

  it('只通知原文裡標註的身分組', () => {
    const p = composePayload({ ...emptyDraft(DEFAULT_SETTINGS), style: 'raw', raw }, DEFAULT_SETTINGS);
    expect(p.allowed_mentions).toEqual({ parse: [], roles: ['1538724579508232212'] });
  });

  it('辨識成員、@everyone，並去除重複', () => {
    expect(mentionsIn('<@123> <@!123> <@&9> <@&9> @here')).toEqual({ parse: ['everyone'], roles: ['9'], users: ['123'] });
    expect(mentionsIn('沒有標註')).toEqual({ parse: [] });
  });

  it('另外選了 @everyone 時加在最前面', () => {
    const p = composePayload({ ...emptyDraft(DEFAULT_SETTINGS), style: 'raw', raw: '上課囉', mention: 'everyone' }, DEFAULT_SETTINGS);
    expect(p.content).toBe('@everyone\n上課囉');
    expect(p.allowed_mentions).toEqual({ parse: ['everyone'] });
  });
});

describe('投票', () => {
  const base = { ...emptyDraft(DEFAULT_SETTINGS), style: 'raw' as const, raw: '<@&1> <@&2>\n## 🎨 TouchDesigner 熟悉度調查' };
  const poll = {
    question: '你對 TouchDesigner 的熟悉程度？',
    answers: [{ emoji: '🛠️', text: '有使用 TD 做過專案' }, { emoji: '🏫', text: '過去學校有上過 TD 相關課程' }, { emoji: '❓', text: '這是啥？' }],
    hours: 72,
    multi: false,
  };

  it('組成 Discord 的 poll 欄位', () => {
    const p = composePayload({ ...base, poll }, DEFAULT_SETTINGS);
    expect(p.poll).toEqual({
      question: { text: '你對 TouchDesigner 的熟悉程度？' },
      answers: [
        { poll_media: { text: '有使用 TD 做過專案', emoji: { name: '🛠️' } } },
        { poll_media: { text: '過去學校有上過 TD 相關課程', emoji: { name: '🏫' } } },
        { poll_media: { text: '這是啥？', emoji: { name: '❓' } } },
      ],
      duration: 72,
      allow_multiselect: false,
      layout_type: 1,
    });
    expect(p.allowed_mentions).toEqual({ parse: [], roles: ['1', '2'] });
    expect(validatePayload(p)).toEqual([]);
  });

  it('只有投票、沒有文字也可以發', () => {
    const p = composePayload({ ...base, raw: '', poll }, DEFAULT_SETTINGS);
    expect(p.content).toBeUndefined();
    expect(validatePayload(p)).toEqual([]);
  });

  it('檢查 Discord 的投票限制', () => {
    const errs = (patch: object) => validatePayload(composePayload({ ...base, poll: { ...poll, ...patch } }, DEFAULT_SETTINGS));
    expect(errs({ question: ' ' })).toContain('投票還沒有填問題');
    expect(errs({ answers: [{ text: '只有一個' }] })).toContain('投票至少要有 2 個選項');
    expect(errs({ answers: Array.from({ length: 11 }, (_, i) => ({ text: `選項${i}` })) })).toContain('投票最多 10 個選項');
    expect(errs({ answers: [{ text: '好' }, { text: 'x'.repeat(56) }] }).join()).toMatch('超過 55 字');
    expect(errs({ answers: [{ text: '好', emoji: '讚' }, { text: '不好' }] }).join()).toMatch('只能放一個 emoji');
    expect(errs({ hours: 769 })).toContain('投票時間要在 1 小時到 32 天之間');
    const card = validatePayload(composePayload({ ...base, style: 'embed', poll }, DEFAULT_SETTINGS));
    expect(card.join()).toMatch('不能和卡片樣式一起發');
  });

  it('把開頭的 emoji 拆出來', () => {
    expect(splitAnswer('🛠️ 有使用 TD 做過專案')).toEqual({ emoji: '🛠️', text: '有使用 TD 做過專案' });
    expect(splitAnswer('❓這是啥？')).toEqual({ emoji: '❓', text: '這是啥？' });
    expect(splitAnswer('👩‍💻 工程師')).toEqual({ emoji: '👩‍💻', text: '工程師' });
    expect(splitAnswer('沒有 emoji')).toEqual({ text: '沒有 emoji' });
    expect(splitAnswer('🙂')).toEqual({ text: '🙂' });
  });

  it('修改已發出的訊息時不送出投票（Discord 不允許）', async () => {
    let sent: Record<string, unknown> = {};
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const p = composePayload({ ...base, poll }, DEFAULT_SETTINGS);
    await editWebhookMessage(`https://discord.com/api/webhooks/123456789012345678/${'t'.repeat(68)}`, '1', p, fake);
    expect(sent.poll).toBeUndefined();
    expect(sent.content).toBe(p.content);
  });
});
