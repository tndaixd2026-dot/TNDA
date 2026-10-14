// 測試用的假 GitHub API 與假 Discord（以 fetch 介面模擬，不需要網路）。

import { createHash } from 'node:crypto';

interface Branch {
  files: Map<string, string>; // path -> blob sha
  commits: number;
}

export interface FakeGitHub {
  fetch: typeof fetch;
  blobs: Map<string, string>;
  branches: Map<string, Branch>;
  secrets: Map<string, string>;
  dispatches: Array<{ workflow: string; ref: string }>;
  calls: string[];
  /** 下一次 PUT 這個路徑時，模擬「別人剛好先改了」 */
  injectConflict(path: string, mutate?: (text: string) => string): void;
  readText(branch: string, path: string): string | undefined;
}

function sha(text: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createFakeGitHub(owner = 'demo', repo = 'TNDA'): FakeGitHub {
  const blobs = new Map<string, string>();
  const branches = new Map<string, Branch>();
  const secrets = new Map<string, string>();
  const dispatches: Array<{ workflow: string; ref: string }> = [];
  const calls: string[] = [];
  const conflicts = new Map<string, ((t: string) => string) | undefined>();
  const pendingTrees = new Map<string, Map<string, string>>();
  const pendingCommits = new Map<string, Map<string, string>>();
  branches.set('main', { files: new Map([['README.md', putBlob('# TNDA')]]), commits: 1 });

  function putBlob(text: string): string {
    const s = sha(text);
    blobs.set(s, text);
    return s;
  }

  const prefix = `/repos/${owner}/${repo}`;

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = decodeURIComponent(url.pathname);
    calls.push(`${method} ${path}`);
    if (!path.startsWith(prefix)) return json(404, { message: 'Not Found' });
    const rest = path.slice(prefix.length);

    if (rest === '' && method === 'GET') {
      return json(200, { full_name: `${owner}/${repo}`, default_branch: 'main', private: false, permissions: { admin: true, push: true, pull: true } });
    }
    let m = /^\/branches\/(.+)$/.exec(rest);
    if (m && method === 'GET') {
      const b = branches.get(m[1]);
      return b ? json(200, { name: m[1], commit: { sha: `c${b.commits}` } }) : json(404, { message: 'Branch not found' });
    }
    m = /^\/git\/trees\/(.+)$/.exec(rest);
    if (m && method === 'GET') {
      const b = branches.get(m[1]);
      if (!b) return json(404, { message: 'Not Found' });
      return json(200, { tree: [...b.files].map(([p, s]) => ({ path: p, sha: s, type: 'blob' })), truncated: false });
    }
    m = /^\/git\/blobs\/(\w+)$/.exec(rest);
    if (m && method === 'GET') {
      const text = blobs.get(m[1]);
      if (text === undefined) return json(404, { message: 'Not Found' });
      return json(200, { content: Buffer.from(text).toString('base64'), encoding: 'base64' });
    }
    m = /^\/contents\/(.+)$/.exec(rest);
    if (m) {
      const filePath = m[1];
      const branchName = (method === 'GET' ? url.searchParams.get('ref') : body?.branch) ?? 'main';
      const b = branches.get(branchName);
      if (!b) return json(404, { message: 'No commit found for the ref' });
      const current = b.files.get(filePath);
      if (method === 'GET') {
        if (!current) return json(404, { message: 'Not Found' });
        return json(200, { sha: current, content: Buffer.from(blobs.get(current)!).toString('base64'), encoding: 'base64' });
      }
      if (conflicts.has(filePath)) {
        const mutate = conflicts.get(filePath);
        conflicts.delete(filePath);
        if (current && mutate) b.files.set(filePath, putBlob(mutate(blobs.get(current)!)));
        else if (current) b.files.set(filePath, putBlob(blobs.get(current)! + ' '));
        b.commits++;
        return json(409, { message: `${filePath} does not match` });
      }
      if (method === 'PUT') {
        if (current && body.sha !== current) {
          return json(body.sha ? 409 : 422, { message: body.sha ? `${filePath} does not match ${body.sha}` : 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        }
        if (!current && body.sha) return json(409, { message: 'sha does not match' });
        const text = Buffer.from(body.content, 'base64').toString('utf8');
        const s = putBlob(text);
        b.files.set(filePath, s);
        b.commits++;
        return json(current ? 200 : 201, { content: { sha: s, path: filePath }, commit: { sha: `c${b.commits}` } });
      }
      if (method === 'DELETE') {
        if (!current) return json(404, { message: 'Not Found' });
        if (body.sha !== current) return json(409, { message: 'sha does not match' });
        b.files.delete(filePath);
        b.commits++;
        return json(200, { commit: { sha: `c${b.commits}` } });
      }
    }
    if (rest === '/git/trees' && method === 'POST') {
      const files = new Map<string, string>();
      for (const e of body.tree) files.set(e.path, putBlob(e.content));
      const id = `t${pendingTrees.size + 1}`;
      pendingTrees.set(id, files);
      return json(201, { sha: id });
    }
    if (rest === '/git/commits' && method === 'POST') {
      const id = `k${pendingCommits.size + 1}`;
      pendingCommits.set(id, pendingTrees.get(body.tree)!);
      return json(201, { sha: id });
    }
    if (rest === '/git/refs' && method === 'POST') {
      const name = String(body.ref).replace('refs/heads/', '');
      if (branches.has(name)) return json(422, { message: 'Reference already exists' });
      branches.set(name, { files: new Map(pendingCommits.get(body.sha)!), commits: 1 });
      return json(201, { ref: body.ref });
    }
    m = /^\/actions\/workflows\/(.+)\/dispatches$/.exec(rest);
    if (m && method === 'POST') {
      dispatches.push({ workflow: m[1], ref: body.ref });
      return new Response(null, { status: 204 });
    }
    m = /^\/actions\/workflows\/(.+)\/runs$/.exec(rest);
    if (m && method === 'GET') {
      return json(200, {
        workflow_runs: [
          { id: 1, status: 'completed', conclusion: 'success', event: 'schedule', created_at: new Date(Date.now() - 180000).toISOString(), updated_at: new Date(Date.now() - 150000).toISOString(), html_url: 'https://github.com/x/y/actions/runs/1' },
        ],
      });
    }
    if (rest === '/actions/secrets/public-key' && method === 'GET') {
      return json(200, { key_id: 'kid', key: Buffer.alloc(32, 7).toString('base64') });
    }
    m = /^\/actions\/secrets\/(\w+)$/.exec(rest);
    if (m && method === 'PUT') {
      secrets.set(m[1], body.encrypted_value);
      return new Response(null, { status: 201 });
    }
    if (m && method === 'GET') {
      return secrets.has(m[1]) ? json(200, { name: m[1] }) : json(404, { message: 'Not Found' });
    }
    return json(404, { message: `fake: no route for ${method} ${rest}` });
  };

  return {
    fetch: handler as typeof fetch,
    blobs,
    branches,
    secrets,
    dispatches,
    calls,
    injectConflict(path, mutate) {
      conflicts.set(path, mutate);
    },
    readText(branch, path) {
      const s = branches.get(branch)?.files.get(path);
      return s ? blobs.get(s) : undefined;
    },
  };
}

export interface FakeDiscord {
  fetch: typeof fetch;
  sent: Array<{ url: string; body: any }>;
  /** 依 webhook id 設定回應，例如 { status: 404 } */
  responses: Map<string, Array<{ status: number; body?: unknown }>>;
}

export function createFakeDiscord(): FakeDiscord {
  const sent: Array<{ url: string; body: any }> = [];
  const responses = new Map<string, Array<{ status: number; body?: unknown }>>();
  let n = 1000;
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const id = /webhooks\/(\d+)/.exec(url)?.[1] ?? '';
    const queue = responses.get(id);
    const next = queue?.shift();
    if (next) return json(next.status, next.body ?? { message: 'error', code: 0 });
    sent.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json(200, { id: String(++n), channel_id: '1' });
  };
  return { fetch: handler as typeof fetch, sent, responses };
}

export function webhook(id: number): string {
  return `https://discord.com/api/webhooks/${String(id).padStart(18, '1')}/${'tok'.padEnd(68, 'x')}`;
}

export function webhookId(id: number): string {
  return String(id).padStart(18, '1');
}
