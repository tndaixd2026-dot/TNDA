import { describe, expect, it } from 'vitest';
import { parseAttendanceCsv } from '../shared/attendance.ts';
import { pickSteps } from '../src/ui/Intro.tsx';

describe('出席紀錄 CSV', () => {
  it('Notion「出勤紀錄」匯出：學生欄的網址會去掉，VSAI＝週三、跨域＝週四，未紀錄略過', () => {
    const csv = [
      '紀錄,學生,課程,週次,狀態,上課日期',
      'W2 王小明,王小明 (https://www.notion.so/abc123),VSAI,2,參,2026/09/16',
      'W2 李小華,"李小華 (https://www.notion.so/def456)",跨域,2,遲,2026/09/17',
      'W3 李小華,李小華 (https://www.notion.so/def456),跨域,3,未紀錄,2026/09/24',
      'W3 張大同,張大同,跨域,第3週,缺,2026/09/24',
    ].join('\n');
    const r = parseAttendanceCsv(csv);
    expect(r.errors).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.entries).toEqual([
      { course: 'wed', name: '王小明', week: 2, status: '參' },
      { course: 'thu', name: '李小華', week: 2, status: '遲' },
      { course: 'thu', name: '張大同', week: 3, status: '缺' },
    ]);
  });

  it('沒有標題時依序是「課堂, 姓名, 週次, 狀態」；看不懂的狀態或課堂會指出行數', () => {
    const r = parseAttendanceCsv('週三,王小明,2,假\n週五,李小華,2,參\n週四,張大同,2,翹課');
    expect(r.entries).toEqual([{ course: 'wed', name: '王小明', week: 2, status: '假' }]);
    expect(r.errors).toEqual([
      '第 2 行：看不懂課堂「週五」，請填 週三／VSAI 或 週四／跨域',
      '第 3 行：看不懂狀態「翹課」，請用 參、遲、假、缺',
    ]);
  });

  it('進場動畫快轉的週次：最多 14 格，保留第一週與最後一週', () => {
    expect(pickSteps(5)).toEqual([0, 1, 2, 3, 4]);
    const s = pickSteps(30);
    expect(s.length).toBe(14);
    expect(s[0]).toBe(0);
    expect(s[13]).toBe(29);
  });
});
