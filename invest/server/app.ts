// HTTP 層：JSON API、Server-Sent Events 即時推播、靜態檔案。
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { isCourseId, type Store } from './store.ts';
import type { CourseId, HistoryPoint } from '../shared/types.ts';

export interface AppOptions {
  adminPassword: string;
  /** 前端打包後的目錄（dist）；不存在時只提供 API */
  staticDir: string | null;
  /** 推播節流間隔 */
  broadcastMs?: number;
  heartbeatMs?: number;
}

interface Client {
  res: ServerResponse;
  /** 學生端的正式姓名，用來推播個人資料 */
  name: string | null;
  /** 大螢幕需要完整走勢 */
  history: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJson(res, status, { error: code, message });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, '資料太大');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 落到下面
  }
  throw new HttpError(400, '資料格式錯誤');
}

/** 密碼比對前先正規化：去掉前後空白、全形半形統一（中文密碼也可以）。 */
function normalizePassword(s: string): string {
  return s.normalize('NFKC').trim();
}

function digest(s: string): Buffer {
  return createHash('sha256').update(normalizePassword(s)).digest();
}

/** HTTP 標頭只能放 ASCII，前端會把密碼 encodeURIComponent 後再送。 */
function decodeHeader(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createApp(store: Store, opts: AppOptions): Server {
  const broadcastMs = opts.broadcastMs ?? 150;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const adminDigest = digest(opts.adminPassword);
  const clients = new Set<Client>();

  function isAdmin(req: IncomingMessage): boolean {
    const header = req.headers['x-admin-password'];
    const given = Array.isArray(header) ? header[0] : header;
    if (!given) return false;
    return timingSafeEqual(digest(decodeHeader(given)), adminDigest);
  }

  /** 目前開著學生頁的人都算出席這一場（切換場次、重置後呼叫） */
  function markConnectedPresent() {
    const names: string[] = [];
    for (const c of clients) if (c.name) names.push(c.name);
    store.markPresent(names);
  }

  // ---- SSE ----
  function write(client: Client, event: string, data: unknown) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function historyPayload(): Record<CourseId, HistoryPoint[]> {
    return { wed: store.visibleHistory('wed'), thu: store.visibleHistory('thu') };
  }

  let stateTimer: ReturnType<typeof setTimeout> | null = null;
  function broadcastState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      if (clients.size === 0) return;
      const payload = `event: state\ndata: ${JSON.stringify(store.getPublic())}\n\n`;
      for (const c of clients) c.res.write(payload);
    }, broadcastMs);
  }

  store.subscribe((e) => {
    switch (e.type) {
      case 'state':
        broadcastState();
        break;
      case 'me':
        for (const c of clients) {
          if (!c.name || (e.names !== 'all' && !e.names.includes(c.name))) continue;
          const me = store.getMe(c.name);
          if (me) write(c, 'me', me);
        }
        break;
      case 'point': {
        const payload = `event: point\ndata: ${JSON.stringify({ course: e.course, point: e.point })}\n\n`;
        for (const c of clients) if (c.history) c.res.write(payload);
        break;
      }
      case 'history': {
        const payload = `event: history\ndata: ${JSON.stringify(historyPayload())}\n\n`;
        for (const c of clients) if (c.history) c.res.write(payload);
        break;
      }
    }
  });

  const heartbeat = setInterval(() => {
    const payload = `event: ping\ndata: ${Date.now()}\n\n`;
    for (const c of clients) c.res.write(payload);
  }, heartbeatMs);
  heartbeat.unref();

  function openStream(req: IncomingMessage, res: ServerResponse, url: URL) {
    const nameParam = url.searchParams.get('name');
    const client: Client = {
      res,
      name: nameParam ? store.resolveName(nameParam) : null,
      history: url.searchParams.get('history') === '1',
    };
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    write(client, 'state', store.getPublic());
    if (client.name) {
      const me = store.getMe(client.name);
      if (me) write(client, 'me', me);
    }
    if (client.history) write(client, 'history', historyPayload());
    clients.add(client);
    if (client.name) store.markPresent([client.name]);
    const drop = () => clients.delete(client);
    req.on('close', drop);
    res.on('error', drop);
  }

  // ---- 靜態檔案 ----
  function serveStatic(res: ServerResponse, pathname: string, head: boolean) {
    const dir = opts.staticDir;
    if (!dir || !existsSync(join(dir, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('前端尚未建置：請先執行 npm run build');
      return;
    }
    let file = normalize(join(dir, decodeURIComponent(pathname)));
    const inside = file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
    let isFile = false;
    if (inside && existsSync(file)) {
      try {
        isFile = statSync(file).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!isFile) {
      // 沒有副檔名的路徑（/、/screen、/admin）都交給前端路由
      if (extname(pathname)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      file = join(dir, 'index.html');
    }
    const ext = extname(file);
    const immutable = pathname.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (head) {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  }

  // ---- 路由 ----
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method', 'Method not allowed');
        return;
      }
      serveStatic(res, path, method === 'HEAD');
      return;
    }

    // ---- 公開 API ----
    if (method === 'GET' && path === '/api/events') {
      openStream(req, res, url);
      return;
    }
    if (method === 'GET' && path === '/api/state') {
      sendJson(res, 200, store.getPublic());
      return;
    }
    if (method === 'GET' && path === '/api/history') {
      sendJson(res, 200, historyPayload());
      return;
    }
    if (method === 'GET' && path === '/api/me') {
      const me = store.getMe(url.searchParams.get('name') ?? '');
      if (!me) sendError(res, 404, 'not_in_roster', '名單中找不到這個名字');
      else sendJson(res, 200, me);
      return;
    }
    if (method === 'POST' && path === '/api/login') {
      const body = await readJson(req);
      const r = store.login(body.name);
      if (r.ok) sendJson(res, 200, r.value);
      else sendError(res, r.status, r.code, r.message);
      return;
    }
    if (method === 'POST' && path === '/api/invest') {
      const body = await readJson(req);
      const r = store.invest(body.name, body.course, body.group, body.amount);
      if (r.ok) sendJson(res, 200, r.value);
      else sendError(res, r.status, r.code, r.message);
      return;
    }

    // ---- 管理員 API ----
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req)) {
        sendError(res, 401, 'unauthorized', '管理員密碼錯誤');
        return;
      }
      if (method === 'POST' && path === '/api/admin/check') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === 'GET' && path === '/api/admin/overview') {
        sendJson(res, 200, store.adminOverview());
        return;
      }
      if (method === 'POST' && path === '/api/admin/active') {
        const body = await readJson(req);
        const r = store.setActive(body.course);
        if (r.ok) markConnectedPresent();
        if (r.ok) sendJson(res, 200, store.adminOverview());
        else sendError(res, r.status, r.code, r.message);
        return;
      }
      if (method === 'POST' && path === '/api/admin/phase') {
        const body = await readJson(req);
        const r = store.phaseAction(body.course, body.action);
        if (r.ok) sendJson(res, 200, store.adminOverview());
        else sendError(res, r.status, r.code, r.message);
        return;
      }
      if (method === 'POST' && path === '/api/admin/reset') {
        const body = await readJson(req);
        const r = store.reset(body.course);
        if (r.ok) markConnectedPresent();
        if (r.ok) sendJson(res, 200, store.adminOverview());
        else sendError(res, r.status, r.code, r.message);
        return;
      }
      if (method === 'POST' && path === '/api/admin/roster/preview') {
        const body = await readJson(req);
        sendJson(res, 200, store.previewRoster(body.csv));
        return;
      }
      if (method === 'POST' && path === '/api/admin/roster') {
        const body = await readJson(req);
        const r = store.applyRoster(body.csv);
        if (r.ok) sendJson(res, 200, store.adminOverview());
        else sendError(res, r.status, r.code, r.message);
        return;
      }
      if (method === 'GET' && path === '/api/admin/results') {
        const results = store.results(url.searchParams.get('course'));
        if (!results) sendError(res, 404, 'no_results', '這一場還沒有結算結果');
        else sendJson(res, 200, results);
        return;
      }
      if (method === 'GET' && path === '/api/admin/results.csv') {
        const course = url.searchParams.get('course');
        const csv = store.resultsCsv(course);
        if (!csv || !isCourseId(course)) {
          sendError(res, 404, 'no_results', '這一場還沒有結算結果');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="results-${course}.csv"`,
          'cache-control': 'no-store',
        });
        res.end(csv);
        return;
      }
    }

    sendError(res, 404, 'not_found', '找不到這個 API');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) sendError(res, err.status, 'bad_request', err.message);
      else {
        console.error(err);
        sendError(res, 500, 'internal', '伺服器發生錯誤');
      }
    });
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    if (stateTimer) clearTimeout(stateTimer);
    for (const c of clients) c.res.end();
    clients.clear();
  });

  return server;
}
