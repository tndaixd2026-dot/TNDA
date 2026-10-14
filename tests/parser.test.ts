import { describe, expect, it } from 'vitest';
import { parseAnnouncement, cnToNumber } from '../src/format/parser.ts';
import { fmtDateTime } from '../src/core/time.ts';

// 2026/10/14（三）10:00 台北時間
const NOW = new Date('2026-10-14T10:00:00+08:00');
const p = (text: string) => parseAnnouncement(text, NOW);
const dt = (iso?: string) => (iso ? fmtDateTime(iso) : undefined);

describe('中文數字', () => {
  it('轉換常見寫法', () => {
    expect(cnToNumber('七')).toBe(7);
    expect(cnToNumber('十')).toBe(10);
    expect(cnToNumber('十一')).toBe(11);
    expect(cnToNumber('二十')).toBe(20);
    expect(cnToNumber('二十三')).toBe(23);
    expect(cnToNumber('兩')).toBe(2);
    expect(cnToNumber('12')).toBe(12);
  });
});

describe('日期與時間', () => {
  it('明天晚上 7 點', () => {
    const r = p('明天晚上7點上課');
    expect(dt(r.eventAt)).toBe('10/15（四） 19:00');
  });
  it('今晚 7:30 會推到晚上', () => {
    expect(dt(p('今晚 7:30 上課').eventAt)).toBe('10/14（三） 19:30');
  });
  it('沒寫上下午的 1～6 點視為下午', () => {
    expect(dt(p('明天 3 點上課').eventAt)).toBe('10/15（四） 15:00');
  });
  it('早上 9 點維持上午', () => {
    expect(dt(p('明天早上9點集合').eventAt)).toBe('10/15（四） 09:00');
  });
  it('中午 12 點與下午 2 點半', () => {
    expect(dt(p('10/16 中午12點上課').eventAt)).toBe('10/16（五） 12:00');
    expect(dt(p('10/16 下午兩點半上課').eventAt)).toBe('10/16（五） 14:30');
  });
  it('完整日期 2026/11/03 09:30', () => {
    expect(dt(p('上課日期 2026/11/03 09:30').eventAt)).toBe('11/3（二） 09:30');
  });
  it('11月5日（四）早上9點', () => {
    expect(dt(p('11月5日（四）早上9點上課').eventAt)).toBe('11/5（四） 09:00');
  });
  it('時間區間 19:00-22:00', () => {
    const r = p('10/21 19:00-22:00 上課');
    expect(dt(r.eventAt)).toBe('10/21（三） 19:00');
    expect(dt(r.eventEnd)).toBe('10/21（三） 22:00');
  });
  it('下午 1:30～4:30 區間後段自動補成下午', () => {
    const r = p('10/18 下午 1:30～4:30 補課');
    expect(dt(r.eventAt)).toBe('10/18（日） 13:30');
    expect(dt(r.eventEnd)).toBe('10/18（日） 16:30');
  });
  it('分開兩行的日期與時間', () => {
    const r = p('日期：10/21（三）\n時間：19:00');
    expect(dt(r.eventAt)).toBe('10/21（三） 19:00');
  });
  it('週X、下週X、這週X、下下週X', () => {
    expect(dt(p('週五 19:00 上課').eventAt)).toBe('10/16（五） 19:00');
    expect(dt(p('下週二 19:00 上課').eventAt)).toBe('10/20（二） 19:00');
    expect(dt(p('這週日 10:00 上課').eventAt)).toBe('10/18（日） 10:00');
    expect(dt(p('下下週一 19:00 上課').eventAt)).toBe('10/26（一） 19:00');
    expect(dt(p('星期三 19:00 上課').eventAt)).toBe('10/14（三） 19:00');
  });
  it('過去很久的月份視為明年', () => {
    expect(p('1/5 19:00 上課').eventAt?.startsWith('2027-01-05')).toBe(true);
  });
  it('補課：選新的日期，不選「原」日期', () => {
    const r = p('原 10/15 課程改到 10/18 下午 2 點補課');
    expect(dt(r.eventAt)).toBe('10/18（日） 14:00');
    expect(r.type).toBe('makeup');
  });
  it('網址中的數字不會被當成日期', () => {
    const r = p('資料 https://example.com/2026/10/15/19:00 請看');
    expect(r.eventAt).toBeUndefined();
  });
  it('「第一點」不是時間', () => {
    expect(p('第一點：檔名要寫學號').eventAt).toBeUndefined();
  });
  it('寫錯星期會提醒', () => {
    const r = p('10/18（六）補課');
    expect(r.detections.some((d) => d.label.includes('是星期日'))).toBe(true);
  });
});

describe('截止時間', () => {
  it('10/20 23:59 前繳交', () => {
    const r = p('作業請於 10/20 23:59 前繳交');
    expect(dt(r.deadline)).toBe('10/20（二） 23:59');
    expect(r.eventAt).toBeUndefined();
  });
  it('截止日期沒寫時間 → 23:59', () => {
    expect(dt(p('作業截止日期：10/25').deadline)).toBe('10/25（日） 23:59');
  });
  it('週五前填寫', () => {
    expect(dt(p('請在週五前填寫表單').deadline)).toBe('10/16（五） 23:59');
  });
  it('同時有上課時間與截止時間', () => {
    const r = p('明天 19:00 上課，作業 10/20 前上傳');
    expect(dt(r.eventAt)).toBe('10/15（四） 19:00');
    expect(dt(r.deadline)).toBe('10/20（二） 23:59');
  });
});

describe('類型判斷', () => {
  it.each([
    ['明天晚上 7 點上課，記得帶筆電', 'class'],
    ['作業一請在 10/20 前上傳', 'homework'],
    ['因颱風停課，改到 10/18 補課', 'makeup'],
    ['請填寫期中回饋問卷 https://forms.gle/abc', 'form'],
    ['今天的簡報與錄影放在雲端 https://drive.google.com/x', 'resource'],
    ['下週一系統維護，請注意', 'announce'],
  ])('%s → %s', (text, type) => {
    expect(p(text).type).toBe(type);
  });
});

describe('地點、連結、注意事項', () => {
  it('地點：', () => {
    expect(p('地點：創意實驗室 B1').location).toBe('創意實驗室 B1');
  });
  it('在 302 教室', () => {
    expect(p('明天在 302 教室上課').location).toBe('302 教室');
  });
  it('線上會議連結', () => {
    expect(p('線上 https://meet.google.com/abc-defg-hij').location).toBe('線上（Google Meet）');
  });
  it('連結標籤：前面的文字或網域', () => {
    const r = p('簡報：https://docs.google.com/presentation/d/1/edit\nhttps://youtu.be/abc');
    expect(r.links).toEqual([
      { label: '簡報', url: 'https://docs.google.com/presentation/d/1/edit' },
      { label: '影片', url: 'https://youtu.be/abc' },
    ]);
  });
  it('句子裡的網址變成文字連結', () => {
    const r = p('請上傳到 https://forms.gle/abc 繳交作業');
    expect(r.body).toContain('[填寫表單](https://forms.gle/abc)');
  });
  it('攜帶物品', () => {
    expect(p('記得帶筆電和充電器！').notes).toBe('請攜帶：筆電和充電器');
  });
  it('注意事項不包含標註', () => {
    expect(p('請攜帶筆電 @everyone').notes).toBe('請攜帶：筆電');
  });
  it('@everyone', () => {
    const r = p('@everyone 明天上課');
    expect(r.mention).toBe('everyone');
    expect(r.body).not.toContain('@everyone');
  });
});

describe('相對日期改寫', () => {
  it('內文中的「下週三晚上」「今晚」改成實際日期', () => {
    expect(p('下週三晚上 7 點上課').body).toBe('10/21（三）晚上 7 點上課');
    expect(p('今晚記得交作業').body).toBe('10/14（三）晚上記得交作業');
    expect(p('提醒：這週五 截止').body).toContain('10/16（五） 截止');
  });
  it('明確日期不改動', () => {
    expect(p('10/21（三）上課').body).toBe('10/21（三）上課');
  });
  it('會在辨識結果中說明', () => {
    expect(p('明天上課').detections.some((d) => d.kind === 'rewrite')).toBe(true);
  });
});

describe('標題與內文', () => {
  it('【】標題', () => {
    const r = p('【互動設計 第六週上課提醒】\n明天 19:00 上課');
    expect(r.title).toBe('互動設計 第六週上課提醒');
    expect(r.body).toBe('10/15（四） 19:00 上課');
  });
  it('短的第一行當標題', () => {
    expect(p('期中作品發表\n10/28 19:00 在大教室').title).toBe('期中作品發表');
  });
  it('長句子不當標題，改用類型產生', () => {
    expect(p('作業一請在 10/20 前上傳，格式為 PDF，檔名請寫學號姓名').title).toBe('作業一繳交提醒');
  });
  it('已整理成欄位的「地點：」行不重複出現在內文', () => {
    const r = p('期中發表\n地點：大教室\n請準時');
    expect(r.body).toBe('請準時');
  });
  it('統一項目符號', () => {
    expect(p('注意\n• 帶筆電\n・ 帶滑鼠\n1、準時').body).toBe('注意\n- 帶筆電\n- 帶滑鼠\n1. 準時');
  });
  it('第一行有日期時間時不當標題', () => {
    const r = p('明天晚上7點上課');
    expect(r.title).toBe('上課提醒');
    expect(r.body).toBe('10/15（四）晚上7點上課');
  });
  it('只有網址的行移到連結欄位，句子中的保留', () => {
    const r = p('期中回饋\n表單：https://forms.gle/a\n請在週五前填寫 https://forms.gle/b 謝謝');
    expect(r.body).toBe('請在10/16（五）前填寫 [填寫表單](https://forms.gle/b) 謝謝');
    expect(r.links.map((l) => l.url)).toEqual(['https://forms.gle/a', 'https://forms.gle/b']);
  });
  it('空白輸入', () => {
    const r = p('   ');
    expect(r.title).toBe('');
    expect(r.links).toEqual([]);
  });
});
