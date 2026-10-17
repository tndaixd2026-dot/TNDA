import { describe, expect, it } from 'vitest';
import { composePayload, emptyDraft, mentionsIn } from '../src/format/composer.ts';
import { validatePayload } from '../src/core/discord.ts';
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
