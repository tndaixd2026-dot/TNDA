import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// 正式版（npm run build）：連 deploy.config.json 裡的 Supabase，放到 GitHub Pages。
// 本機版（npm run build:local，mode = standalone）：連同一台主機的 server/main.ts（開發、測試、現場備援）。
// 環境變數 VITE_SUPABASE_URL／VITE_SUPABASE_ANON_KEY 可以覆蓋 deploy.config.json。
export default defineConfig(({ mode }) => {
  const local = mode === 'standalone' || mode === 'development';
  const deploy = JSON.parse(readFileSync(resolve(__dirname, 'deploy.config.json'), 'utf8')) as {
    supabaseUrl: string;
    supabaseAnonKey: string;
  };
  const url = local ? '' : (process.env.VITE_SUPABASE_URL ?? deploy.supabaseUrl);
  const key = local ? '' : (process.env.VITE_SUPABASE_ANON_KEY ?? deploy.supabaseAnonKey);
  return {
    base: './',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(key),
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
      sourcemap: false,
      rollupOptions: {
        input: {
          student: resolve(__dirname, 'index.html'),
          screen: resolve(__dirname, 'screen/index.html'),
          admin: resolve(__dirname, 'admin/index.html'),
        },
      },
    },
    server: {
      host: true,
      proxy: {
        '/rest': { target: 'http://localhost:8787' },
      },
    },
    test: {
      include: ['tests/**/*.test.ts'],
      // 瀏覽器端對端測試另外用 `npm run test:e2e` 執行
      exclude: ['tests/e2e/**', 'node_modules/**'],
      environment: 'node',
      testTimeout: 20_000,
      hookTimeout: 30_000,
    },
  };
});
