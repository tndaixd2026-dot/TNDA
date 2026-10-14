import { describe, expect, it } from 'vitest';
import { parseWebhookBlock, suggestChannels, detectCourse, mergeChannels, groupKeywords } from '../src/core/channels.ts';
import { validatePayload, parseWebhook, maskWebhook } from '../src/core/discord.ts';
import { composePayload, draftFromParse, suggestReminders } from '../src/format/composer.ts';
import { parseAnnouncement } from '../src/format/parser.ts';
import { DEFAULT_SETTINGS } from '../src/core/types.ts';

const h = (n: number) => `https://discord.com/api/webhooks/15458${String(n).padStart(14, '0')}/AbC_def-${'x'.repeat(60)}${n}`;

const BLOCK = `【A｜學程大群組】
公告欄
${h(1)}
交流區
${h(2)}

【B｜三-互動設計實作】
課程公告
${h(3)}
課後作業
${h(4)}

【C｜四-數位內容製作 DC101】
課程公告
${h(8)}

【D｜講師與助理（非學員）】
講師群組
${h(5)}
助理群組
${h(10)}

【測試區】
${h(6)}`;

describe('批次匯入 Webhook', () => {
  it('解析群組、頻道名稱與網址，依用途產生 id', () => {
    const { channels, warnings } = parseWebhookBlock(BLOCK);
    expect(warnings).toEqual([]);
    expect(channels.map((c) => c.id)).toEqual(['a-announce', 'a-chat', 'b-announce', 'b-homework', 'c-announce', 'd-staff', 'd-staff-2', 't-test']);
    expect(channels[3]).toMatchObject({ group: 'B', groupName: '三-互動設計實作', name: '課後作業', kind: 'homework', audience: 'student', webhook: h(4) });
    expect(channels[5].audience).toBe('staff');
    expect(channels[7]).toMatchObject({ group: 'T', name: '測試區', audience: 'test' });
  });
  it('「名稱：網址」寫在同一行也可以', () => {
    const { channels } = parseWebhookBlock(`【B｜三-互動設計實作】\n討論室：${h(9)}`);
    expect(channels[0]).toMatchObject({ id: 'b-discuss', name: '討論室' });
  });
  it('非 Discord 網址會警告並略過', () => {
    const { channels, warnings } = parseWebhookBlock('【X｜新群組】\n公告\nhttps://example.com/hook');
    expect(channels).toHaveLength(0);
    expect(warnings[0]).toContain('不是 Discord Webhook');
  });
  it('再次匯入時沿用既有頻道的 id，只更新網址', () => {
    const first = parseWebhookBlock(BLOCK).channels;
    const again = parseWebhookBlock(`【B｜三-互動設計實作】\n課後作業\n${h(11)}\n新頻道\n${h(12)}`, first);
    expect(again.channels[0]).toMatchObject({ id: 'b-homework', webhook: h(11) });
    const merged = mergeChannels(first, again.channels);
    expect(merged).toHaveLength(first.length + 1);
    expect(merged.find((c) => c.id === 'b-homework')!.webhook).toBe(h(11));
    expect(merged.find((c) => c.id === 'a-announce')!.webhook).toBe(h(1));
  });
  it('新頻道的 id 不會和既有頻道衝突', () => {
    const first = parseWebhookBlock(BLOCK).channels;
    const again = parseWebhookBlock(`【B｜三-互動設計實作】\n第二公告\n${h(13)}`, first);
    expect(again.channels[0].id).toBe('b-announce-2');
  });
});

describe('課程辨識與頻道建議', () => {
  const channels = parseWebhookBlock(BLOCK).channels;
  it('從群組名稱取出關鍵字', () => {
    expect(groupKeywords('三-互動設計實作')).toEqual(['互動設計實作', '互動設計', '設計實作']);
    expect(groupKeywords('四-數位內容製作 DC101')).toEqual(['數位內容製作', '數位內容', '內容製作', 'DC101']);
    expect(groupKeywords('講師與助理（非學員）')).toEqual(['講師與助理', '講師與助', '師與助理']);
    expect(groupKeywords('學程大群組')).toEqual([]);
  });
  it('依匯入的群組名稱辨識課程', () => {
    expect(detectCourse('互動設計 作業一', channels)).toBe('B');
    expect(detectCourse('dc101 期末', channels)).toBe('C');
    expect(detectCourse('數位內容 補課', channels)).toBe('C');
    expect(detectCourse('下週三上課', channels)).toBeUndefined();
    expect(detectCourse('講師會議', channels)).toBe('D');
  });
  it('辨識課程後建議對應頻道', () => {
    expect(suggestChannels('homework', channels, 'B')).toEqual(['b-homework']);
    expect(suggestChannels('class', channels, 'C')).toEqual(['c-announce']);
  });
  it('沒有辨識出課程時不自動勾選', () => {
    expect(suggestChannels('homework', channels)).toEqual([]);
  });
});

describe('Discord 工具', () => {
  it('辨識 Webhook 網址', () => {
    expect(parseWebhook(h(1))).not.toBeNull();
    expect(parseWebhook('https://discord.com/api/webhooks/123/abc')).toBeNull();
    expect(maskWebhook(h(1))).not.toContain('AbC_def');
  });
  it('檢查訊息限制', () => {
    expect(validatePayload({})).toContain('訊息內容是空的');
    expect(validatePayload({ content: 'x'.repeat(2001) })[0]).toContain('2000');
    expect(validatePayload({ embeds: [{ title: 'a', fields: [{ name: 'n', value: '' }] }] })).toContain('有欄位的名稱或內容是空的');
    expect(validatePayload({ content: 'ok', username: 'Discord Bot' })[0]).toContain('discord');
  });
});

describe('組成 Discord 訊息', () => {
  const NOW = new Date('2026-10-14T10:00:00+08:00');
  const parsed = parseAnnouncement('@everyone 作業一請在 10/20 23:59 前上傳 https://forms.gle/abc', NOW);
  const draft = draftFromParse(parsed, 'x', DEFAULT_SETTINGS);

  it('卡片樣式：標題、顏色、Discord 時間戳、連結', () => {
    const p = composePayload(draft, DEFAULT_SETTINGS);
    const e = p.embeds![0];
    expect(e.title).toBe('📝 作業一繳交提醒');
    expect(e.color).toBe(0xf2a33a);
    const deadline = e.fields!.find((f) => f.name.includes('繳交期限'))!;
    const ts = Math.floor(Date.parse('2026-10-20T23:59:00+08:00') / 1000);
    expect(deadline.value).toBe(`<t:${ts}:F>\n<t:${ts}:R>`);
    expect(e.fields!.find((f) => f.name.includes('繳交連結'))!.value).toBe('• [填寫表單](https://forms.gle/abc)');
    expect(p.content).toBe('@everyone');
    expect(p.allowed_mentions).toEqual({ parse: ['everyone'] });
    expect(validatePayload(p)).toEqual([]);
  });
  it('純文字樣式', () => {
    const p = composePayload({ ...draft, style: 'text' }, { ...DEFAULT_SETTINGS, footer: 'TNDA 課務' });
    expect(p.embeds).toBeUndefined();
    expect(p.content).toMatch(/^@everyone\n\n## 📝 作業一繳交提醒/);
    expect(p.content).toContain('-# TNDA 課務');
  });
  it('建議提醒時間（截止前 3 天、1 天、當天）', () => {
    const r = suggestReminders(draft, NOW);
    expect(r.map((o) => o.key)).toEqual(['d-3', 'd-1', 'd-0', 'h-3']);
    expect(r.find((o) => o.recommended)!.key).toBe('d-1');
  });
});
