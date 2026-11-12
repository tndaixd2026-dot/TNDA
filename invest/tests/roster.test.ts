import { describe, expect, it } from 'vitest';
import {
  groupNumber,
  nameKey,
  normalizeName,
  parseCourse,
  parseRosterCsv,
  rosterToCsv,
  sortGroups,
  splitGroupLabel,
} from '../shared/roster.ts';

describe('姓名正規化', () => {
  it('去掉空白、零寬字元並統一全形', () => {
    expect(normalizeName('  王小明​ ')).toBe('王小明');
    expect(normalizeName('Amy　 Lin')).toBe('Amy Lin');
    expect(nameKey('AMY LIN')).toBe(nameKey('amy lin'));
  });
});

describe('parseCourse', () => {
  it('接受常見寫法', () => {
    expect(['週三', '周三', '三', '上半場', 'Wed'].map(parseCourse)).toEqual(['wed', 'wed', 'wed', 'wed', 'wed']);
    expect(['週四', '星期四', '下半場', 'THU'].map(parseCourse)).toEqual(['thu', 'thu', 'thu', 'thu']);
    expect(parseCourse('週五')).toBeNull();
  });
});

describe('parseRosterCsv', () => {
  it('解析含標題、BOM、CRLF 的 CSV', () => {
    const r = parseRosterCsv('﻿姓名,課堂,組別\r\n王小明,週三,第1組\r\n王小明,週四,第3組\r\n\r\n李小華, 週三 , 第2組\r\n');
    expect(r.errors).toEqual([]);
    expect(r.entries).toEqual([
      { name: '王小明', course: 'wed', group: '第1組' },
      { name: '王小明', course: 'thu', group: '第3組' },
      { name: '李小華', course: 'wed', group: '第2組' },
    ]);
  });

  it('支援試算表貼上的 Tab 分隔與雙引號欄位', () => {
    const tab = parseRosterCsv('王小明\t週三\t第1組：很棒, 真的\n');
    expect(tab.entries[0].group).toBe('第1組：很棒, 真的');
    const quoted = parseRosterCsv('"王小明",週三,"第2組：說""好"""\n');
    expect(quoted.entries[0]).toEqual({ name: '王小明', course: 'wed', group: '第2組：說"好"' });
  });

  it('回報錯誤行', () => {
    const r = parseRosterCsv('王小明,週五,第1組\n李小華,週三\n,週三,第1組\n張大同,週三,第1組\n張大同,週三,第2組\n');
    expect(r.entries).toHaveLength(1);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]).toContain('第 1 行');
    expect(r.errors[3]).toContain('重複');
  });

  it('空內容視為錯誤', () => {
    expect(parseRosterCsv('\n\n').errors).toHaveLength(1);
  });

  it('匯出後可以再匯入', () => {
    const entries = [
      { name: '王小明', course: 'wed' as const, group: '第1組：A,B' },
      { name: '李小華', course: 'thu' as const, group: '第7組' },
    ];
    expect(parseRosterCsv(rosterToCsv(entries)).entries).toEqual(entries);
  });
});

describe('組別', () => {
  it('取出組號（阿拉伯數字或中文數字）', () => {
    expect(groupNumber('第3組：這組有誠意')).toBe(3);
    expect(groupNumber('第三組：兩億五千萬Token')).toBe(3);
    expect(groupNumber('第十二組')).toBe(12);
    expect(groupNumber('12')).toBe(12);
    expect(groupNumber('企劃')).toBeNull();
  });

  it('依組號排序', () => {
    expect(sortGroups(['第10組', '第2組', '第一組', '第二組：組', '第2組'])).toEqual(['第一組', '第2組', '第二組：組', '第10組']);
  });

  it('拆出短名與暱稱', () => {
    expect(splitGroupLabel('第2組：看到太陽就知道完蛋了')).toEqual({ short: '第2組', nick: '看到太陽就知道完蛋了' });
    expect(splitGroupLabel('第五組')).toEqual({ short: '第五組', nick: '' });
    expect(splitGroupLabel('3')).toEqual({ short: '第3組', nick: '' });
  });
});
