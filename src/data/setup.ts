// 初始設定精靈用到的 GitHub 操作。

import { GitHubClient, GitHubError } from '../core/github.ts';
import { DEFAULT_DATA_BRANCH, GitHubDataRepo, SECRET_NAME } from '../core/repo.ts';
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
