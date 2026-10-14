import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` 產出 GitHub Pages 用的正式版；
// `vite build --mode demo` 產出單一 HTML 的 Demo（資料只存在瀏覽器）。
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    base: './',
    define: {
      __DEMO_ONLY__: JSON.stringify(demo),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    plugins: demo ? [viteSingleFile()] : [],
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      target: 'es2022',
      sourcemap: false,
    },
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
