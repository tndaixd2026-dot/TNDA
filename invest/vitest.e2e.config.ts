import { defineConfig } from 'vitest/config';

// 瀏覽器端對端測試：啟動正式伺服器（node server/main.ts）並用 Chromium 操作三個頁面。
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
