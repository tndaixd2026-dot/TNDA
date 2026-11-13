// 本機版伺服器進入點：`npm run build:local && npm start`。
// 正式活動用 Supabase + GitHub Pages；這個版本用於開發、測試與現場備援（筆電＋手機熱點）。
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { openDb } from './db.ts';
import { seedRoster } from './seed.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const production = env.NODE_ENV === 'production';

let adminPassword = env.ADMIN_PASSWORD ?? '';
if (!adminPassword) {
  if (production) {
    console.error('❌ 正式環境必須設定環境變數 ADMIN_PASSWORD（管理員密碼）');
    process.exit(1);
  }
  adminPassword = 'admin';
  console.warn('⚠️ 未設定 ADMIN_PASSWORD，開發模式使用預設密碼「admin」');
}

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? '0.0.0.0';
const dataDir = resolve(env.DATA_DIR ?? join(root, 'data'));
const darkSeconds = env.DARK_SECONDS ? Number(env.DARK_SECONDS) : undefined;
if (darkSeconds !== undefined && (!Number.isFinite(darkSeconds) || darkSeconds <= 0)) {
  console.error('❌ DARK_SECONDS 必須是正數（秒）');
  process.exit(1);
}

const db = await openDb({
  dataDir: join(dataDir, 'pgdata'),
  adminPassword,
  darkMs: darkSeconds ? darkSeconds * 1000 : undefined,
  seed: seedRoster(),
});
const server = createApp(db, { staticDir: join(root, 'dist') });

server.listen(port, host, () => {
  console.log(`\n期末提報 即時投資（本機版）已啟動${darkSeconds ? `（暗盤 ${darkSeconds} 秒）` : ''}，資料存在 ${dataDir}`);
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  for (const u of urls) console.log(`  學生端 ${u}/    大螢幕 ${u}/screen/    管理員 ${u}/admin/`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n收到 ${signal}，關閉中`);
  server.closeAllConnections();
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
