// Demo 範例資料：以「現在」為基準，產生過去幾週的發文紀錄與接下來的排程。
// 內容是示範用的範例，不是真實公告。

import type { Audience, Channel, ChannelKind, ComposeDraft, Post, PostType, Settings } from '../core/types.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';
import { DAY_MS, atTime, tpParts } from '../core/time.ts';
import { composePayload } from '../format/composer.ts';
import { randomId } from '../core/crypto.ts';

export const DEMO_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  senderName: 'TNDA 課務小幫手',
  footer: 'TNDA｜有問題請在討論室發問',
};

// 示範用的虛構群組與頻道（正式使用時，名稱來自你匯入的 Webhook 清單）
const DEMO_CHANNELS: Array<[string, string, string, string, Audience, ChannelKind]> = [
  ['a-announce', 'A', '學程大群組', '公告欄', 'student', 'announce'],
  ['a-chat', 'A', '學程大群組', '交流區', 'student', 'chat'],
  ['b-announce', 'B', '三-互動設計實作', '課程公告', 'student', 'announce'],
  ['b-homework', 'B', '三-互動設計實作', '課後作業', 'student', 'homework'],
  ['b-makeup', 'B', '三-互動設計實作', '補課資訊', 'student', 'makeup'],
  ['b-form', 'B', '三-互動設計實作', '課後表單', 'student', 'form'],
  ['b-resource', 'B', '三-互動設計實作', '學習資源', 'student', 'resource'],
  ['b-discuss', 'B', '三-互動設計實作', '討論室', 'student', 'discuss'],
  ['c-announce', 'C', '四-數位內容製作 DC101', '課程公告', 'student', 'announce'],
  ['c-homework', 'C', '四-數位內容製作 DC101', '課後作業', 'student', 'homework'],
  ['c-makeup', 'C', '四-數位內容製作 DC101', '補課資訊', 'student', 'makeup'],
  ['c-form', 'C', '四-數位內容製作 DC101', '課後表單', 'student', 'form'],
  ['c-resource', 'C', '四-數位內容製作 DC101', '學習資源', 'student', 'resource'],
  ['c-discuss', 'C', '四-數位內容製作 DC101', '討論室', 'student', 'discuss'],
  ['d-mentor', 'D', '講師與助理（非學員）', '講師群組', 'staff', 'staff'],
  ['d-assistant', 'D', '講師與助理（非學員）', '助理群組', 'staff', 'staff'],
  ['test', 'T', '測試區', '測試區', 'test', 'test'],
];

export function demoChannels(): Channel[] {
  return DEMO_CHANNELS.map(([id, group, groupName, name, audience, kind], i) => ({
    id,
    group,
    groupName,
    name,
    audience,
    kind,
    webhook: `https://discord.com/api/webhooks/1000000000000000${String(i + 10).padStart(2, '0')}/demo-${id}-token-not-real-0000000000`,
  }));
}

/** 從 now 往前/往後找第 n 個星期 dow 的日期（台北時間） */
function weekday(now: Date, dow: number, weekOffset: number): Date {
  const p = tpParts(now);
  const delta = dow - p.dow + weekOffset * 7;
  return new Date(now.getTime() + delta * DAY_MS);
}

interface SeedSpec {
  type: PostType;
  title: string;
  body: string;
  channels: string[];
  sendAt: Date;
  eventAt?: Date;
  eventEnd?: Date;
  deadline?: Date;
  location?: string;
  notes?: string;
  links?: Array<{ label: string; url: string }>;
  mention?: 'none' | 'everyone';
  status?: 'sent' | 'scheduled' | 'draft' | 'partial' | 'failed';
  failChannel?: { id: string; error: string };
  series?: string;
  seriesLabel?: string;
  repeat?: Post['repeat'];
  raw?: string;
}

function build(spec: SeedSpec, now: Date): Post {
  const draft: ComposeDraft = {
    raw: spec.raw ?? spec.body,
    type: spec.type,
    style: 'embed',
    title: spec.title,
    body: spec.body,
    eventAt: spec.eventAt?.toISOString(),
    eventEnd: spec.eventEnd?.toISOString(),
    deadline: spec.deadline?.toISOString(),
    location: spec.location,
    notes: spec.notes,
    links: spec.links ?? [],
    mention: spec.mention ?? 'none',
    showCountdown: true,
  };
  const status = spec.status ?? (spec.sendAt.getTime() < now.getTime() ? 'sent' : 'scheduled');
  const deliveries: Post['deliveries'] = {};
  const sentAt = new Date(spec.sendAt.getTime() + 40000 + Math.round(Math.random() * 90000)).toISOString();
  if (status === 'sent' || status === 'partial' || status === 'failed') {
    for (const ch of spec.channels) {
      const fail = spec.failChannel?.id === ch || status === 'failed';
      deliveries[ch] = fail
        ? { status: 'failed', attempts: 3, retryable: false, error: spec.failChannel?.error ?? 'Discord 暫時無法服務（503）', claimedAt: sentAt, claimedBy: 'scheduler:demo' }
        : { status: 'sent', attempts: 1, sentAt, messageId: String(1290000000000000000 + Math.floor(Math.random() * 1e12)), claimedBy: 'scheduler:demo', claimedAt: sentAt };
    }
  }
  const created = new Date(Math.min(spec.sendAt.getTime(), now.getTime()) - 2 * DAY_MS).toISOString();
  return {
    id: randomId('p'),
    title: spec.title,
    type: spec.type,
    channels: spec.channels,
    sendAt: spec.sendAt.toISOString(),
    status,
    payload: composePayload(draft, DEMO_SETTINGS),
    draft,
    series: spec.series,
    seriesLabel: spec.seriesLabel,
    repeat: spec.repeat ?? null,
    deliveries,
    createdAt: created,
    updatedAt: status === 'scheduled' || status === 'draft' ? created : sentAt,
    sentAt: status === 'sent' || status === 'partial' ? sentAt : undefined,
  };
}

const ROOM_B = '3F 301 教室';
const ROOM_C = '2F 202 教室';

export function demoPosts(now: Date = new Date()): Post[] {
  const specs: SeedSpec[] = [];
  // 互動設計實作：週三 18:30–21:30
  for (const w of [-3, -2, -1, 0, 1]) {
    const day = weekday(now, 3, w);
    const ev = atTime(day, 18, 30);
    const sendAt = atTime(day.getTime() - DAY_MS, 20);
    if (w === 1 && sendAt.getTime() - now.getTime() > 9 * DAY_MS) continue;
    const n = 6 + w;
    specs.push({
      type: 'class',
      title: `互動設計 第 ${n} 週上課提醒`,
      body: w === 0 ? '這週進入感測器實作，會用到上週焊好的模組，請一定要帶來。' : '這週會延續上週的互動裝置原型，請把進度帶來課堂討論。',
      channels: ['b-announce'],
      sendAt,
      eventAt: ev,
      eventEnd: atTime(day, 21, 30),
      location: ROOM_B,
      notes: w === 0 ? '請攜帶 筆電、Arduino 套件與上週的感測器模組' : '請攜帶 筆電與充電器',
      mention: 'everyone',
    });
  }
  // 數位內容製作：週四 18:30–21:30
  for (const w of [-2, -1, 0, 1]) {
    const day = weekday(now, 4, w);
    const sendAt = atTime(day.getTime() - DAY_MS, 20, 30);
    specs.push({
      type: 'class',
      title: `數位內容 第 ${5 + w} 週上課提醒`,
      body: '本週主題：團隊合作的製作流程與分工。上課前請先看過學習資源區的影片。',
      channels: ['c-announce'],
      sendAt,
      eventAt: atTime(day, 18, 30),
      eventEnd: atTime(day, 21, 30),
      location: ROOM_C,
      notes: '請攜帶 筆電',
    });
  }
  // 作業
  const hw1 = atTime(weekday(now, 2, -1), 23, 59);
  specs.push({
    type: 'homework',
    title: '互動設計 作業一繳交提醒',
    body: '作業一：互動裝置概念草圖與使用情境說明。\n- 格式：PDF，一頁即可\n- 檔名：學號_姓名_作業一',
    channels: ['b-homework'],
    sendAt: atTime(hw1.getTime() - 3 * DAY_MS, 9),
    deadline: hw1,
    links: [{ label: '繳交表單', url: 'https://forms.gle/demo-hw1' }],
  });
  const hw2 = atTime(weekday(now, 2, 1), 23, 59);
  const series = randomId('s');
  for (const [label, offset, hh] of [
    ['截止前 3 天', 3, 9],
    ['截止前 1 天', 1, 20],
    ['截止當天', 0, 9],
  ] as Array<[string, number, number]>) {
    const at = atTime(hw2.getTime() - offset * DAY_MS, hh);
    specs.push({
      type: 'homework',
      title: '互動設計 作業二繳交提醒',
      body: '作業二：感測器互動原型影片（30 秒內）。\n- 上傳到雲端資料夾\n- 影片中請說明互動方式',
      channels: ['b-homework'],
      sendAt: at,
      deadline: hw2,
      links: [{ label: '上傳資料夾', url: 'https://drive.google.com/drive/folders/demo-hw2' }],
      series,
      seriesLabel: label,
      mention: offset === 0 ? 'everyone' : 'none',
    });
  }
  const tnHw = atTime(weekday(now, 0, 1), 23, 59);
  specs.push({
    type: 'homework',
    title: '數位內容 期中提案上傳',
    body: '請各組上傳期中提案簡報，下週課堂每組報告 5 分鐘。',
    channels: ['c-homework'],
    sendAt: atTime(tnHw.getTime() - 2 * DAY_MS, 20),
    deadline: tnHw,
    links: [{ label: '上傳到 GitHub Classroom', url: 'https://github.com/demo-classroom/midterm' }],
  });
  // 補課
  const makeup = weekday(now, 6, 1);
  specs.push({
    type: 'makeup',
    title: '數位內容 補課通知',
    body: '上上週因颱風停課的進度，改到這個時間補課，補課內容同樣會錄影放在學習資源。',
    channels: ['c-makeup', 'c-announce'],
    sendAt: atTime(now.getTime() + 2 * DAY_MS, 12),
    eventAt: atTime(makeup, 13, 30),
    eventEnd: atTime(makeup, 16, 30),
    location: ROOM_C,
    mention: 'everyone',
  });
  // 表單
  const formDl = atTime(weekday(now, 5, 1), 23, 59);
  specs.push({
    type: 'form',
    title: '期中課程回饋表單',
    body: '花 3 分鐘填寫，幫助我們調整下半學期的課程安排。匿名填寫。',
    channels: ['b-form', 'c-form'],
    sendAt: atTime(now.getTime() + DAY_MS, 9),
    deadline: formDl,
    links: [{ label: '填寫表單', url: 'https://forms.gle/demo-midterm-feedback' }],
  });
  specs.push({
    type: 'form',
    title: '第二週課後回饋',
    body: '請填寫本週課後回饋，作為出席參考。',
    channels: ['b-form'],
    sendAt: atTime(weekday(now, 3, -2), 21, 40),
    deadline: atTime(weekday(now, 0, -1), 23, 59),
    links: [{ label: '填寫表單', url: 'https://forms.gle/demo-week2' }],
  });
  // 學習資源
  specs.push({
    type: 'resource',
    title: '數位內容 第四週簡報與錄影',
    body: '課堂簡報與錄影已整理好，沒來的同學記得補看。',
    channels: ['c-resource'],
    sendAt: atTime(weekday(now, 4, -1), 22, 10),
    links: [
      { label: '簡報', url: 'https://docs.google.com/presentation/d/demo-week4' },
      { label: '錄影', url: 'https://youtu.be/demo-week4' },
    ],
  });
  specs.push({
    type: 'resource',
    title: '互動設計 每週資源整理',
    body: '本週提到的範例程式、零件清單與延伸閱讀都整理在這裡。',
    channels: ['b-resource'],
    sendAt: atTime(weekday(now, 5, now.getTime() < atTime(weekday(now, 5, 0), 21).getTime() ? 0 : 1), 21),
    links: [{ label: '資源整理', url: 'https://hackmd.io/demo-weekly' }],
    repeat: { freq: 'weekly', interval: 1 },
  });
  // 大群組
  specs.push({
    type: 'announce',
    title: '期中成果展報名開始',
    body: '期中成果展開放各班報名展位，每組一個展位，名額有限。',
    channels: ['a-announce', 'a-chat'],
    sendAt: atTime(now.getTime() - 5 * DAY_MS, 10),
    links: [{ label: '報名表單', url: 'https://forms.gle/demo-expo' }],
    status: 'partial',
    failChannel: { id: 'a-chat', error: 'Webhook 不存在或已被刪除，請到「頻道」重新設定。' },
  });
  specs.push({
    type: 'announce',
    title: '學程說明會直播',
    body: '說明會即將開始，沒辦法到現場的同學可以看直播。',
    channels: ['a-announce'],
    sendAt: new Date(Math.ceil((now.getTime() + 2 * 60000) / 60000) * 60000),
    eventAt: new Date(Math.ceil((now.getTime() + 32 * 60000) / 60000) * 60000),
    links: [{ label: '直播連結', url: 'https://youtube.com/live/demo-briefing' }],
    location: '線上（YouTube 直播）',
  });
  // 業師
  specs.push({
    type: 'announce',
    title: '業師會議',
    body: '討論期末評分標準與成果展評審分工，會議記錄會放在共用文件。',
    channels: ['d-mentor'],
    sendAt: atTime(now.getTime() - 3 * DAY_MS, 14),
    eventAt: atTime(now.getTime() + 4 * DAY_MS, 12, 0),
    location: '線上（Google Meet）',
    links: [{ label: 'Google Meet', url: 'https://meet.google.com/demo-mentor' }],
  });
  specs.push({
    type: 'announce',
    title: '期末成果展場地確認',
    body: '請助理協助確認期末成果展的場地、電源與投影設備。',
    channels: ['d-assistant'],
    sendAt: atTime(now.getTime() + 5 * DAY_MS, 10),
    status: 'draft',
  });
  return specs.map((s) => build(s, now)).sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
}
