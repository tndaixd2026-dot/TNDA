// TNDA Relay 排程器：由 GitHub Actions 每 5 分鐘執行一次。
// 讀取加密的資料分支 → 找出該發送的貼文 → 發到 Discord → 把結果寫回。
// 注意：公開 repo 的 Actions 紀錄所有人都看得到，所以這裡只印出貼文代號與狀態，不印內容。

import { GitHubClient } from '../src/core/github.ts';
import { type BlobCache, DEFAULT_DATA_BRANCH, GitHubDataRepo, KeyMismatchError, NotInitializedError } from '../src/core/repo.ts';
import { executeWebhook, type SendResult } from '../src/core/discord.ts';
import { isDue, recoverStale } from '../src/core/delivery.ts';
import { channelMap, sendPost } from '../src/core/engine.ts';
import type { DiscordPayload } from '../src/core/types.ts';
import { blobCacheFromDir } from './local-cache.ts';

export interface SchedulerOptions {
  client: GitHubClient;
  syncKey: string;
  branch?: string;
  /** 會等待並準時發送未來這段時間內到期的貼文 */
  lookaheadMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  send?: (url: string, payload: DiscordPayload) => Promise<SendResult>;
  log?: (msg: string) => void;
  runId?: string;
  /** 預先讀好的加密檔（依 blob sha），可以省下 API 呼叫 */
  cache?: BlobCache;
}

export interface SchedulerReport {
  status: 'ok' | 'not-initialized' | 'key-mismatch';
  scanned: number;
  due: number;
  sent: number;
  partial: number;
  failed: number;
  retrying: number;
  recovered: number;
  created: number;
  skipped: string[];
}

export async function runScheduler(opts: SchedulerOptions): Promise<SchedulerReport> {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.log(m));
  const lookahead = opts.lookaheadMs ?? 0;
  const actor = `scheduler:${opts.runId ?? 'local'}`;
  const report: SchedulerReport = {
    status: 'ok',
    scanned: 0,
    due: 0,
    sent: 0,
    partial: 0,
    failed: 0,
    retrying: 0,
    recovered: 0,
    created: 0,
    skipped: [],
  };

  const repo = await GitHubDataRepo.open(opts.client, opts.syncKey, { branch: opts.branch ?? DEFAULT_DATA_BRANCH, cache: opts.cache });
  let snapshot;
  try {
    snapshot = await repo.load();
  } catch (err) {
    if (err instanceof NotInitializedError) return { ...report, status: 'not-initialized' };
    if (err instanceof KeyMismatchError) return { ...report, status: 'key-mismatch' };
    throw err;
  }
  report.scanned = snapshot.posts.length;
  report.skipped = snapshot.skipped;
  const channels = channelMap(snapshot.channels);

  // 1. 卡在「發送中」太久的，標記為狀態不明，避免重複發送
  for (const post of snapshot.posts) {
    if (recoverStale(post, now().getTime())) {
      const r = await repo.updatePost(post.id, (latest) => recoverStale(latest, now().getTime()));
      if (r) {
        report.recovered++;
        log(`⚠ ${post.id} 發送狀態不明，已標記待確認`);
      }
    }
  }

  // 2. 找出到期（或即將到期）的貼文，依時間排序
  const due = snapshot.posts
    .filter((p) => isDue(p, now().getTime(), lookahead))
    .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
  report.due = due.length;
  if (due.length === 0) log('沒有需要發送的貼文。');

  for (const post of due) {
    const wait = Date.parse(post.sendAt) - now().getTime();
    if (wait > 0) {
      log(`… 等待 ${Math.round(wait / 1000)} 秒後準時發送 ${post.id}`);
      await sleep(wait);
    }
    log(`→ 發送 ${post.id}（${post.channels.length} 個頻道）`);
    const outcome = await sendPost(
      repo,
      post.id,
      actor,
      {
        channels,
        settings: snapshot.settings,
        send: opts.send ?? ((url, payload) => executeWebhook(url, payload)),
        now,
        sleep,
        log,
      },
    );
    if (!outcome) {
      log(`  略過 ${post.id}（已被其他裝置發送、取消或改期）`);
      continue;
    }
    const s = outcome.post.status;
    if (s === 'sent') report.sent++;
    else if (s === 'partial') report.partial++;
    else if (s === 'failed') report.failed++;
    else if (s === 'scheduled') report.retrying++;
    log(`  結果：${s}`);
    if (outcome.next) {
      report.created++;
      log(`  已建立下一次重複貼文 ${outcome.next.id}`);
    }
  }
  return report;
}

function summaryMarkdown(r: SchedulerReport): string {
  return [
    '### TNDA Relay 排程器',
    '',
    '| 項目 | 數量 |',
    '| --- | --- |',
    `| 掃描貼文 | ${r.scanned} |`,
    `| 本次到期 | ${r.due} |`,
    `| 發送成功 | ${r.sent} |`,
    `| 部分失敗 | ${r.partial} |`,
    `| 失敗 | ${r.failed} |`,
    `| 稍後重試 | ${r.retrying} |`,
    `| 狀態不明 | ${r.recovered} |`,
    `| 新建重複貼文 | ${r.created} |`,
  ].join('\n');
}

async function main() {
  const env = process.env;
  const syncKey = env.TNDA_SYNC_KEY?.trim();
  const [owner, repoName] = (env.GITHUB_REPOSITORY ?? '').split('/');
  if (!syncKey) {
    console.log('::notice title=TNDA Relay::尚未設定 TNDA_SYNC_KEY，請先在網站完成初始設定。這次先略過。');
    return;
  }
  if (!owner || !repoName || !env.GITHUB_TOKEN) {
    console.log('::error::缺少 GITHUB_REPOSITORY 或 GITHUB_TOKEN 環境變數');
    process.exitCode = 1;
    return;
  }
  const client = new GitHubClient({ owner, repo: repoName, token: env.GITHUB_TOKEN, baseUrl: env.GITHUB_API_URL });
  let cache: BlobCache | undefined;
  if (env.TNDA_DATA_DIR) {
    const local = await blobCacheFromDir(env.TNDA_DATA_DIR);
    if (local.files) cache = local.cache;
  }
  const report = await runScheduler({
    client,
    syncKey,
    branch: env.TNDA_DATA_BRANCH || DEFAULT_DATA_BRANCH,
    lookaheadMs: Number(env.TNDA_LOOKAHEAD_SECONDS ?? 0) * 1000,
    runId: env.GITHUB_RUN_ID,
    cache,
  });
  if (report.status === 'not-initialized') {
    console.log('::notice title=TNDA Relay::資料分支尚未建立，請先在網站完成初始設定。');
  } else if (report.status === 'key-mismatch') {
    console.log('::error title=TNDA Relay::TNDA_SYNC_KEY 與資料不符。請到網站「設定 → 排程器」重新同步金鑰。');
    process.exitCode = 1;
  }
  if (report.skipped.length) console.log(`::warning::有 ${report.skipped.length} 個檔案無法解密，已略過`);
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(env.GITHUB_STEP_SUMMARY, summaryMarkdown(report) + '\n');
  }
  console.log(JSON.stringify({ ...report, skipped: report.skipped.length }));
  if (report.failed > 0 || report.partial > 0) {
    console.log('::warning title=TNDA Relay::有貼文發送失敗，請到網站「發文紀錄」查看原因。');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.log(`::error title=TNDA Relay::${(err as Error).message}`);
    process.exitCode = 1;
  });
}
