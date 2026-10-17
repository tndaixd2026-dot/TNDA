// 初始設定精靈用到的 GitHub 操作。

import { GitHubClient, GitHubError, type WorkflowRun } from '../core/github.ts';
import { DEFAULT_DATA_BRANCH, GitHubDataRepo, SCHEDULER_WORKFLOW, SECRET_NAME } from '../core/repo.ts';
import type { Channel } from '../core/types.ts';
import { DEFAULT_SETTINGS } from '../core/types.ts';

export interface TokenCheck {
  ok: boolean;
  message: string;
  defaultBranch?: string;
  dataState?: 'missing' | 'exists';
  canSecrets?: boolean;
}

export function makeClient(owner: string, repo: string, token: string): GitHubClient {
  return new GitHubClient({ owner: owner.trim(), repo: repo.trim(), token: token.trim() });
}

export async function checkToken(client: GitHubClient, branch = DEFAULT_DATA_BRANCH): Promise<TokenCheck> {
  try {
    const info = await client.getRepo();
    if (info.permissions && !info.permissions.push) {
      return { ok: false, message: '這個 Token 沒有寫入權限。請確認 Contents 權限設為「Read and write」。' };
    }
    const state = await GitHubDataRepo.inspect(client, null, branch);
    let canSecrets = false;
    try {
      await client.getActionsPublicKey();
      canSecrets = true;
    } catch {
      canSecrets = false;
    }
    return {
      ok: true,
      message: `已連上 ${info.full_name}`,
      defaultBranch: info.default_branch,
      dataState: state === 'missing' ? 'missing' : 'exists',
      canSecrets,
    };
  } catch (err) {
    if (err instanceof GitHubError && err.status === 404) {
      return { ok: false, message: '找不到這個 repo。請確認帳號／repo 名稱，以及 Token 的 Repository access 有選到它。' };
    }
    return { ok: false, message: (err as Error).message };
  }
}

export async function checkSyncKey(client: GitHubClient, syncKey: string, branch = DEFAULT_DATA_BRANCH) {
  return GitHubDataRepo.inspect(client, syncKey, branch);
}

export async function createDataSpace(client: GitHubClient, syncKey: string, channels: Channel[], branch = DEFAULT_DATA_BRANCH) {
  await GitHubDataRepo.initialize(client, syncKey, { channels, settings: DEFAULT_SETTINGS, branch });
}

/** 把同步金鑰存成 GitHub Actions Secret，讓排程器能解開資料 */
export async function storeSyncKeySecret(client: GitHubClient, syncKey: string): Promise<void> {
  const { encryptSecretValue } = await import('./sealedbox.ts');
  const pk = await client.getActionsPublicKey();
  await client.putActionsSecret(SECRET_NAME, encryptSecretValue(syncKey, pk.key), pk.key_id);
}

/** 外部定時器專用的 Token：只有觸發排程器的權限，就算外洩也碰不到資料 */
export function cronTokenUrl(owner: string, repo: string): string {
  const params = new URLSearchParams({
    name: `TNDA Relay 定時器（${repo}）`,
    description: '只用來每 5 分鐘觸發 TNDA Relay 排程器',
    target_name: owner,
    actions: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}

export function dispatchUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/actions/workflows/scheduler.yml/dispatches`;
}

export function dispatchBody(branch: string): string {
  return JSON.stringify({ ref: branch, inputs: { reason: 'cron' } });
}

/** 排程器多久沒跑就算延遲（外部定時器每 5 分鐘一次） */
export const SCHEDULER_STALE_MS = 20 * 60 * 1000;

export type RunSource = 'schedule' | 'cron' | 'test' | 'manual' | 'dispatch';

/** 從執行紀錄判斷是誰叫醒排程器（scheduler.yml 的 run-name 會標上觸發來源） */
export function runSource(run: Pick<WorkflowRun, 'event' | 'display_title'>): RunSource {
  if (run.event === 'schedule') return 'schedule';
  const title = run.display_title ?? '';
  if (title.includes('外部定時器')) return 'cron';
  if (title.includes('定時器測試')) return 'test';
  if (title.includes('手動')) return 'manual';
  return 'dispatch';
}

export const RUN_SOURCE_LABEL: Record<RunSource, string> = {
  schedule: 'GitHub 定時',
  cron: '外部定時器',
  test: '定時器測試',
  manual: '手動執行',
  dispatch: '外部定時器／手動',
};

/** 去掉貼上時多帶的空白與「Bearer 」前綴 */
export function bareToken(raw: string): string {
  return raw.trim().replace(/^Bearer(\s+|$)/i, '');
}

/** 用定時器 Token 實際叫醒排程器一次，確認 Token 的權限與 repo 都設對了 */
export async function testCronToken(owner: string, repo: string, rawToken: string, branch: string): Promise<{ ok: boolean; message: string }> {
  const token = bareToken(rawToken);
  if (!token) return { ok: false, message: '請先貼上 Token。' };
  try {
    await makeClient(owner, repo, token).dispatchWorkflow(SCHEDULER_WORKFLOW, branch, { reason: 'test' });
    return { ok: true, message: '成功！這個 Token 可以叫醒排程器。接下來照下面的表格填到 cron-job.org。' };
  } catch (err) {
    const status = err instanceof GitHubError ? err.status : -1;
    const repoName = `${owner}/${repo}`;
    const hints: Record<number, string> = {
      401: 'Token 無效或已過期。請確認貼上的是完整、github_pat_ 開頭的字串。',
      403: `Token 權限不足：Repository access 要選到 ${repoName}，Repository permissions 的「Actions」要設成「Read and write」。`,
      404: `這個 Token 看不到 ${repoName}：Repository access 要選「Only select repositories」並勾選它。`,
      422: '分支名稱不對，請重新整理頁面再試一次。',
    };
    return { ok: false, message: hints[status] ?? (err as Error).message };
  }
}

export function tokenCreateUrl(owner: string, repo: string): string {
  const params = new URLSearchParams({
    name: `TNDA Relay（${repo}）`,
    description: 'TNDA Relay 課務發報台：讀寫排程資料、設定排程器金鑰、啟動排程器',
    target_name: owner,
    contents: 'write',
    secrets: 'write',
    actions: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}
