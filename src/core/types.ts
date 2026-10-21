// 共用資料型別：瀏覽器與排程器（Node）都會用到。

export type PostType = 'class' | 'homework' | 'makeup' | 'form' | 'resource' | 'announce';

export type PostStatus =
  | 'draft' // 草稿，不會被發送
  | 'scheduled' // 等待發送（含重試中）
  | 'sending' // 已被某個發送端認領，正在發送
  | 'sent' // 全部頻道成功
  | 'partial' // 部分頻道失敗
  | 'failed' // 全部失敗
  | 'canceled'; // 已取消

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface Delivery {
  status: DeliveryStatus;
  attempts: number;
  messageId?: string;
  sentAt?: string;
  claimedAt?: string;
  claimedBy?: string;
  error?: string;
  retryable?: boolean;
  /** 已從 Discord 撤回的時間 */
  deletedAt?: string;
  /** 已更新 Discord 上訊息內容的時間 */
  editedAt?: string;
}

export type Audience = 'student' | 'staff' | 'test';

export type ChannelKind =
  | 'announce'
  | 'homework'
  | 'makeup'
  | 'form'
  | 'resource'
  | 'discuss'
  | 'chat'
  | 'staff'
  | 'test'
  | 'other';

export interface Channel {
  id: string;
  name: string;
  /** 群組代碼，例如 A、B、C、D、T */
  group: string;
  groupName: string;
  audience: Audience;
  kind: ChannelKind;
  webhook?: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: DiscordEmbedField[];
}

/** Discord 投票（Webhook 的 poll 欄位） */
export interface DiscordPoll {
  question: { text: string };
  answers: Array<{ poll_media: { text: string; emoji?: { name: string } } }>;
  /** 開放幾小時，最多 768（32 天） */
  duration: number;
  allow_multiselect: boolean;
  layout_type?: number;
}

export interface DiscordPayload {
  content?: string;
  poll?: DiscordPoll;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: { parse: Array<'everyone' | 'roles' | 'users'>; roles?: string[]; users?: string[] };
}

export interface LinkItem {
  label: string;
  url: string;
}

export type MentionMode = 'none' | 'everyone' | 'here';

/** 附檔（圖片、PDF、影片）：內容加密存在資料分支的 files/{id}.json */
export interface AttachmentRef {
  id: string;
  name: string;
  type: string;
  size: number;
  /** bin：files/{id}.bin（二進位加密）；沒有這個欄位是舊格式 files/{id}.json */
  enc?: 'bin';
}

export interface PollDraft {
  question: string;
  answers: Array<{ text: string; emoji?: string }>;
  hours: number;
  multi: boolean;
}

/** 編輯器的結構化內容；發送用的 payload 由它產生。 */
export interface ComposeDraft {
  raw: string;
  type: PostType;
  /** embed：卡片；text：純文字；raw：原文照發（不加標題與欄位） */
  style: 'embed' | 'text' | 'raw';
  title: string;
  body: string;
  eventAt?: string;
  eventEnd?: string;
  deadline?: string;
  location?: string;
  links: LinkItem[];
  notes?: string;
  imageUrl?: string;
  mention: MentionMode;
  showCountdown: boolean;
  /** 附加的投票（沒有就是 undefined） */
  poll?: PollDraft;
  attachments?: AttachmentRef[];
}

export interface Repeat {
  freq: 'daily' | 'weekly';
  interval: number;
  /** 最後一次發送不晚於此時間（ISO） */
  until?: string;
}

export interface Post {
  id: string;
  title: string;
  type: PostType;
  channels: string[];
  sendAt: string;
  status: PostStatus;
  payload: DiscordPayload;
  draft?: ComposeDraft;
  /** 同一組提醒（提醒鏈 / 重複發送）共用的代號 */
  series?: string;
  /** 提醒鏈中的說明，例如「截止前 1 天」 */
  seriesLabel?: string;
  repeat?: Repeat | null;
  /** 跟訊息一起上傳到 Discord 的檔案 */
  attachments?: AttachmentRef[];
  deliveries: Record<string, Delivery>;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

export interface Settings {
  senderName: string;
  avatarUrl: string;
  footer: string;
  defaultMention: MentionMode;
}

export interface Envelope {
  tnda: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
}

export interface RepoMeta {
  app: 'tnda-relay';
  schema: 1;
  createdAt: string;
  keyCheck: Envelope;
}

export const DEFAULT_SETTINGS: Settings = {
  senderName: 'TNDA 課務小幫手',
  avatarUrl: '',
  footer: '',
  defaultMention: 'none',
};
