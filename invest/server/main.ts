// 伺服器進入點：`npm start`（需先 `npm run build`）。
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { seedRoster } from './seed.ts';
import { createStore } from './store.ts';
import { DEFAULT_DARK_MS } from '../shared/rules.ts';

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
const darkSeconds = env.DARK_SECONDS ? Number(env.DARK_SECONDS) : DEFAULT_DARK_MS / 1000;
if (!Number.isFinite(darkSeconds) || darkSeconds <= 0) {
  console.error('❌ DARK_SECONDS 必須是正數（秒）');
  process.exit(1);
}

const store = createStore({ dataDir, darkMs: darkSeconds * 1000, seed: seedRoster() });
const server = createApp(store, { adminPassword, staticDir: join(root, 'dist') });

server.listen(port, host, () => {
  console.log(`\n期末提報 即時投資 已啟動（暗盤 ${darkSeconds} 秒，資料存在 ${dataDir}）`);
  const urls = [`http://localhost:${port}`];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${port}`);
    }
  }
  for (const u of urls) console.log(`  學生端 ${u}/    大螢幕 ${u}/screen    管理員 ${u}/admin`);
});

function shutdown(signal: string) {
  console.log(`\n收到 ${signal}，存檔後關閉`);
  try {
    store.flush();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
