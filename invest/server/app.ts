// 本機版 HTTP 伺服器：模擬 Supabase 的 RPC 網址（POST /rest/v1/rpc/<函式>），並提供打包後的網頁。
// 前端呼叫方式和連 Supabase 時完全相同，只是網址換成同一台主機。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { RpcError, type Db } from './db.ts';

export interface AppOptions {
  /** 前端打包後的目錄（dist）；不存在時只提供 API */
  staticDir: string | null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new RpcError(413, '資料太大');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RpcError(400, '資料格式錯誤');
  }
}

export function createApp(db: Db, opts: AppOptions): Server {
  function serveStatic(res: ServerResponse, pathname: string, head: boolean) {
    const dir = opts.staticDir;
    if (!dir || !existsSync(join(dir, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('前端尚未建置：請先執行 npm run build:local');
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    let file = normalize(join(dir, decoded));
    const inside = file === dir || file.startsWith(dir.endsWith(sep) ? dir : dir + sep);
    if (!inside) {
      res.writeHead(404).end();
      return;
    }
    let stat = existsSync(file) ? statSync(file) : null;
    if (stat?.isDirectory()) {
      // /screen → /screen/（和 GitHub Pages 一樣）
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { location: `${pathname}/` });
        res.end();
        return;
      }
      file = join(file, 'index.html');
      stat = existsSync(file) ? statSync(file) : null;
    }
    if (!stat?.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': pathname.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (head) res.end();
    else createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    const rpc = /^\/rest\/v1\/rpc\/(invest_[a-z_]+)$/.exec(path);
    if (rpc) {
      if (method !== 'POST') {
        sendJson(res, 405, { message: '請用 POST' });
        return;
      }
      const body = await readBody(req);
      sendJson(res, 200, await db.rpc(rpc[1], body));
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return;
    }
    serveStatic(res, path, method === 'HEAD');
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof RpcError) sendJson(res, err.status, { message: err.message });
      else {
        console.error(err);
        sendJson(res, 500, { message: '伺服器發生錯誤' });
      }
    });
  });
}
