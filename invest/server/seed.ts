// 沒有匯入正式名單前使用的假資料（彩排／開發用）。正式名單請由管理員頁匯入 CSV。
import type { RosterEntry } from '../shared/types.ts';

const WED = [
  '王小明', '李小華', '張大同', '陳美玲', '林志明', '黃雅婷', '吳建宏', '劉佳穎', '蔡宗翰', '楊淑芬',
  '許家豪', '鄭怡君', '謝承翰', '郭品妤', '洪俊傑', '曾郁婷', '邱冠宇', '廖婉婷', '賴柏翰', '周詩涵',
];
// 前 10 位同時修兩堂課，用來測試「同一人兩堂課組別不同」
const THU = [
  ...WED.slice(0, 10),
  '徐子軒', '孫語彤', '馬浩然', '朱心怡', '胡承恩', '高敏慧', '林子晴', '何冠廷', '羅宇辰', '宋佳慧',
  '葉書豪', '潘思妤', '杜宏毅', '蕭雅文', '呂哲維', '江采潔', '范育誠', '沈依庭',
];

export function seedRoster(): RosterEntry[] {
  return [
    ...WED.map((name, i) => ({ name, course: 'wed' as const, group: `第${(i % 5) + 1}組` })),
    ...THU.map((name, i) => ({ name, course: 'thu' as const, group: `第${((i * 3) % 7) + 1}組` })),
  ];
}

export interface AttendanceSeed {
  course: 'wed' | 'thu';
  name: string;
  week: number;
  status: 'present' | 'late' | 'leave' | 'absent';
}

/** 假的出席紀錄（第 2～17 週），讓登入動畫的出席率看板在本機版也有東西可以跑。每個人的出席習慣不同。 */
export function seedAttendance(): AttendanceSeed[] {
  let s = 20260114;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: AttendanceSeed[] = [];
  for (const [course, names] of [['wed', WED], ['thu', THU]] as const) {
    names.forEach((name) => {
      const habit = 0.55 + rand() * 0.45; // 55%～100% 的出席傾向
      for (let week = 2; week <= 17; week++) {
        const r = rand();
        const status = r < habit ? (rand() < 0.12 ? 'late' : 'present') : rand() < 0.3 ? 'leave' : 'absent';
        out.push({ course, name, week, status });
      }
    });
  }
  return out;
}
