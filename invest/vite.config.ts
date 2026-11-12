import { defineConfig } from 'vitest/config';

// 前端由 Vite 打包到 dist/，正式環境由 server/main.ts 一併提供。
// 開發時 `npm run dev` 會同時啟動 API（:8787）與 Vite，/api 由 Vite 代理過去。
export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:8787' },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // 瀏覽器端對端測試另外用 `npm run test:e2e` 執行
    exclude: ['tests/e2e/**', 'node_modules/**'],
    environment: 'node',
  },
});
