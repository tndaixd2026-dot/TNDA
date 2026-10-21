// 精簡的 GitHub REST API 用戶端，瀏覽器與排程器共用。

import { base64ToBytes, base64ToUtf8, bytesToBase64, utf8ToBase64 } from './crypto.ts';

export class GitHubError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export interface TreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  event: string;
  display_title?: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

export class GitHubClient {
  owner: string;
  repo: string;
  token?: string;
  baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetch ?? fetch.bind(globalThis);
  }

  get repoPath(): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    // 瀏覽器會快取 GET 回應最多 60 秒，會讀到舊資料，所以停用快取。
    if (isBrowser) init.cache = 'no-store';
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch (err) {
      throw new GitHubError(0, `無法連線到 GitHub：${(err as Error).message}`);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = (data as { message?: string })?.message ?? res.statusText;
      throw new GitHubError(res.status, describeError(res.status, msg), data);
    }
    return data as T;
  }

  getRepo() {
    return this.request<{
      full_name: string;
      default_branch: string;
      private: boolean;
      permissions?: { admin: boolean; push: boolean; pull: boolean };
    }>('GET', this.repoPath);
  }

  async getBranch(branch: string): Promise<{ name: string; commit: { sha: string } } | null> {
    try {
      return await this.request('GET', `${this.repoPath}/branches/${encodeURIComponent(branch)}`);
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async getTree(branch: string): Promise<TreeEntry[]> {
    const data = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      'GET',
      `${this.repoPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    return data.tree.filter((e) => e.type === 'blob');
  }

  async getBlobText(sha: string): Promise<string> {
    const data = await this.request<{ content: string; encoding: string }>(
      'GET',
      `${this.repoPath}/git/blobs/${sha}`,
    );
    if (data.encoding !== 'base64') return data.content;
    return base64ToUtf8(data.content);
  }

  async getBlobBytes(sha: string): Promise<Uint8Array> {
    const data = await this.request<{ content: string; encoding: string }>('GET', `${this.repoPath}/git/blobs/${sha}`);
    return data.encoding === 'base64' ? base64ToBytes(data.content) : new TextEncoder().encode(data.content);
  }

  async getFileBytes(path: string, branch: string): Promise<{ sha: string; bytes: Uint8Array } | null> {
    try {
      const data = await this.request<{ sha: string; content?: string }>(
        'GET',
        `${this.repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      );
      return { sha: data.sha, bytes: data.content ? base64ToBytes(data.content) : await this.getBlobBytes(data.sha) };
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  async getFile(path: string, branch: string): Promise<{ sha: string; text: string } | null> {
    try {
      const data = await this.request<{ sha: string; content?: string; encoding?: string }>(
        'GET',
        `${this.repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`,
      );
      // 超過 1MB 的檔案 contents API 不回傳內容，改用 blob API
      const text = data.content ? base64ToUtf8(data.content) : await this.getBlobText(data.sha);
      return { sha: data.sha, text };
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
  }

  putFile(path: string, text: string, opts: { branch: string; message: string; sha?: string }): Promise<{ sha: string; commit: string }> {
    return this.putContent(path, utf8ToBase64(text), opts);
  }

  putFileBytes(path: string, bytes: Uint8Array, opts: { branch: string; message: string; sha?: string }): Promise<{ sha: string; commit: string }> {
    return this.putContent(path, bytesToBase64(bytes), opts);
  }

  private async putContent(
    path: string,
    base64: string,
    opts: { branch: string; message: string; sha?: string },
  ): Promise<{ sha: string; commit: string }> {
    const data = await this.request<{ content: { sha: string }; commit: { sha: string } }>(
      'PUT',
      `${this.repoPath}/contents/${encodePath(path)}`,
      {
        message: opts.message,
        content: base64,
        branch: opts.branch,
        ...(opts.sha ? { sha: opts.sha } : {}),
      },
    );
    return { sha: data.content.sha, commit: data.commit.sha };
  }

  async deleteFile(path: string, opts: { branch: string; message: string; sha: string }): Promise<void> {
    await this.request('DELETE', `${this.repoPath}/contents/${encodePath(path)}`, {
      message: opts.message,
      sha: opts.sha,
      branch: opts.branch,
    });
  }

  /** 建立一個沒有歷史的獨立分支（只放資料），並一次寫入多個檔案。 */
  async createOrphanBranch(branch: string, files: Record<string, string>, message: string): Promise<void> {
    const tree = await this.request<{ sha: string }>('POST', `${this.repoPath}/git/trees`, {
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    const commit = await this.request<{ sha: string }>('POST', `${this.repoPath}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [],
    });
    await this.request('POST', `${this.repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  async dispatchWorkflow(workflowFile: string, ref: string, inputs?: Record<string, string>): Promise<void> {
    await this.request('POST', `${this.repoPath}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`, {
      ref,
      ...(inputs ? { inputs } : {}),
    });
  }

  async listWorkflowRuns(workflowFile: string, perPage = 5): Promise<WorkflowRun[]> {
    const data = await this.request<{ workflow_runs: WorkflowRun[] }>(
      'GET',
      `${this.repoPath}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`,
    );
    return data.workflow_runs;
  }

  getActionsPublicKey() {
    return this.request<{ key_id: string; key: string }>('GET', `${this.repoPath}/actions/secrets/public-key`);
  }

  async putActionsSecret(name: string, encryptedValue: string, keyId: string): Promise<void> {
    await this.request('PUT', `${this.repoPath}/actions/secrets/${encodeURIComponent(name)}`, {
      encrypted_value: encryptedValue,
      key_id: keyId,
    });
  }

  async hasActionsSecret(name: string): Promise<boolean> {
    try {
      await this.request('GET', `${this.repoPath}/actions/secrets/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return false;
      throw err;
    }
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function describeError(status: number, message: string): string {
  switch (status) {
    case 401:
      return 'GitHub Token 無效或已過期，請到「設定」重新輸入。';
    case 403:
      if (/rate limit/i.test(message)) return 'GitHub API 使用次數暫時用完，請稍後再試。';
      return `GitHub 拒絕存取：Token 權限不足（${message}）`;
    case 404:
      return `找不到資源（${message}）。請確認 repo 名稱與 Token 權限。`;
    case 409:
      return '資料已被其他裝置或排程器更新，請重新整理後再試。';
    case 422:
      return `GitHub 無法處理這個請求（${message}）`;
    default:
      return `GitHub 錯誤 ${status}：${message}`;
  }
}

export function isConflict(err: unknown): boolean {
  if (!(err instanceof GitHubError)) return false;
  if (err.status === 409) return true;
  // 檔案 sha 不符時，GitHub 有時回 422
  return err.status === 422 && /sha/i.test(String((err.body as { message?: string })?.message ?? ''));
}
