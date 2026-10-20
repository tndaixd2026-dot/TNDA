import { describe, expect, it } from 'vitest';
import {
  ImportError,
  decodeImportData,
  encodeImportData,
  findDuplicate,
  matchChannels,
  parseImportBundle,
  refKey,
  resolveTargets,
} from '../src/data/importer.ts';
import type { Channel, Post } from '../src/core/types.ts';

const ch = (id: string, group: string, groupName: string, name: string): Channel => ({ id, group, groupName, name, audience: 'student', kind: 'announce' });
const CHANNELS: Channel[] = [
  ch('A-announce', 'A', '互動學程大群組', '公告欄'),
  ch('B-announce', 'B', '三-VSAI 互動機台', '課程公告'),
  ch('B-homework', 'B', '三-VSAI 互動機台', '課後作業'),
  ch('C-announce', 'C', '四-跨域數位製作 TN0006', '課程公告'),
  ch('D-staff', 'D', '業師群組（非學員）', '業師群組'),
  ch('D-staff-2', 'D', '業師群組（非學員）', '助理群組'),
];

const bundle = (posts: unknown[]) => JSON.stringify({ tnda: 'import', v: 1, name: '測試', posts });
const item = { title: 'W7 上課提醒', type: 'class', at: '2026-10-19T12:00:00+08:00', to: [{ group: 'VSAI', channel: '課程公告' }], content: '## 📢 本週上課提醒｜W7' };

describe('parseImportBundle', () => {
  it('讀取並正規化時間', () => {
    const b = parseImportBundle(bundle([item]));
    expect(b.name).toBe('測試');
    expect(b.posts[0].at).toBe('2026-10-19T04:00:00.000Z');
    expect(b.posts[0].type).toBe('class');
  });

  it('沒有標題時取第一行（略過身分組標註）', () => {
    const b = parseImportBundle(bundle([{ ...item, title: '', content: '<@&1538724579508232212>\n## ⏰ Suno 補助表單明天截止\n內容' }]));
    expect(b.posts[0].title).toBe('⏰ Suno 補助表單明天截止');
  });

  it('格式錯誤時給出可以看懂的訊息', () => {
    expect(() => parseImportBundle('不是 JSON')).toThrow(ImportError);
    expect(() => parseImportBundle(JSON.stringify({ posts: [] }))).toThrow('不是 TNDA Relay 的匯入檔');
    expect(() => parseImportBundle(bundle([{ ...item, at: '下週一' }]))).toThrow('第 1 則的發送時間');
    expect(() => parseImportBundle(bundle([{ ...item, to: [] }]))).toThrow('沒有指定頻道');
    expect(() => parseImportBundle(bundle([{ ...item, content: ' ' }]))).toThrow('沒有內容');
  });
});

describe('頻道對應', () => {
  it('依群組與頻道名稱的關鍵字對應', () => {
    expect(matchChannels({ group: 'VSAI', channel: '課程公告' }, CHANNELS).map((c) => c.id)).toEqual(['B-announce']);
    expect(matchChannels({ group: 'tn0006', channel: '課程公告' }, CHANNELS).map((c) => c.id)).toEqual(['C-announce']);
    expect(matchChannels({ group: 'B', channel: '課後作業' }, CHANNELS).map((c) => c.id)).toEqual(['B-homework']);
  });

  it('名稱完全相同的優先', () => {
    expect(matchChannels({ group: '業師', channel: '群組' }, CHANNELS)).toHaveLength(2);
    expect(matchChannels({ group: '業師群組', channel: '業師群組' }, CHANNELS).map((c) => c.id)).toEqual(['D-staff']);
  });

  it('全部對應好才算可以發送', () => {
    const it2 = { ...parseImportBundle(bundle([item])).posts[0], to: [{ group: 'VSAI', channel: '課程公告' }, { id: 'C-announce' }] };
    expect(resolveTargets(it2, { [refKey(it2.to[0])]: 'B-announce' })).toBeNull();
    expect(resolveTargets(it2, { [refKey(it2.to[0])]: 'B-announce', [refKey(it2.to[1])]: 'C-announce' })).toEqual(['B-announce', 'C-announce']);
  });
});

describe('重複偵測', () => {
  const post = { id: 'p1', status: 'scheduled', sendAt: '2026-10-19T04:00:20.000Z', channels: ['B-announce'], payload: { content: '## 內容\n' } } as unknown as Post;
  it('同時間、同內容、同頻道算重複', () => {
    expect(findDuplicate('## 內容', '2026-10-19T04:00:00.000Z', ['B-announce'], [post])?.id).toBe('p1');
    expect(findDuplicate('## 內容', '2026-10-19T04:00:00.000Z', ['C-announce'], [post])).toBeUndefined();
    expect(findDuplicate('## 不同', '2026-10-19T04:00:00.000Z', ['B-announce'], [post])).toBeUndefined();
    expect(findDuplicate('## 內容', '2026-10-19T04:00:00.000Z', ['B-announce'], [{ ...post, status: 'canceled' }])).toBeUndefined();
  });
});

describe('匯入連結', () => {
  it('壓縮後可以完整還原（含中文與 emoji）', async () => {
    const json = bundle([item, { ...item, content: '<@&1>\n```\n地址：深中路58號\n```\n🙏 '.repeat(20) }]);
    const data = await encodeImportData(json);
    expect(data.startsWith('z.')).toBe(true);
    expect(data).toMatch(/^z\.[\w-]+$/);
    expect(data.length).toBeLessThan(json.length);
    expect(await decodeImportData(data)).toBe(json);
  });

  it('連結被截斷時給出提示', async () => {
    const data = await encodeImportData(bundle([item]));
    await expect(decodeImportData(data.slice(0, 20))).rejects.toThrow('不完整');
    await expect(decodeImportData('abc')).rejects.toThrow('格式不正確');
  });
});

describe('匯入投票', () => {
  const poll = { question: '你對 TouchDesigner 的熟悉程度？', answers: ['🛠️ 有使用 TD 做過專案', { emoji: '🏫', text: '過去學校有上過 TD 相關課程' }, '❓ 這是啥？'], duration: '3d' };
  it('讀取投票，字串選項自動拆出 emoji', () => {
    const b = parseImportBundle(bundle([{ ...item, poll }]));
    expect(b.posts[0].poll).toEqual({
      question: '你對 TouchDesigner 的熟悉程度？',
      answers: [{ emoji: '🛠️', text: '有使用 TD 做過專案' }, { emoji: '🏫', text: '過去學校有上過 TD 相關課程' }, { emoji: '❓', text: '這是啥？' }],
      hours: 72,
      multi: false,
    });
  });
  it('時間可以寫小時或「1週」，可複選', () => {
    expect(parseImportBundle(bundle([{ ...item, poll: { ...poll, duration: undefined, hours: 8, multi: true } }])).posts[0].poll).toMatchObject({ hours: 8, multi: true });
    expect(parseImportBundle(bundle([{ ...item, poll: { ...poll, duration: '1週' } }])).posts[0].poll?.hours).toBe(168);
  });
  it('只有投票沒有內文也可以，標題用問題', () => {
    const b = parseImportBundle(bundle([{ ...item, title: '', content: '', poll }]));
    expect(b.posts[0].title).toBe('📊 你對 TouchDesigner 的熟悉程度？');
  });
  it('投票格式錯誤時說明原因', () => {
    expect(() => parseImportBundle(bundle([{ ...item, poll: { ...poll, question: '' } }]))).toThrow('沒有問題');
    expect(() => parseImportBundle(bundle([{ ...item, poll: { ...poll, answers: ['只有一個'] } }]))).toThrow('至少要有 2 個選項');
    expect(() => parseImportBundle(bundle([{ ...item, poll: { ...poll, duration: '下週' } }]))).toThrow('看不懂');
    expect(() => parseImportBundle(bundle([{ ...item, poll: { ...poll, duration: '40d' } }]))).toThrow('32 天');
  });
});
