// 開發模式：同時啟動 API 伺服器（自動重啟）與 Vite 前端。
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const procs = [
  spawn(process.execPath, ['--watch', 'server/main.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '8787' },
  }),
  spawn(isWin ? 'npx.cmd' : 'npx', ['vite'], { stdio: 'inherit', shell: isWin }),
];

function stop() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);
