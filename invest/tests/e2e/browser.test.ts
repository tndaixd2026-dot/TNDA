// 瀏覽器端對端測試：用 `npm start` 啟動正式伺服器（需先 `npm run build`，`npm run test:e2e` 會自動建置），
// 再用 Chromium 打開學生頁、大螢幕頁、管理員頁，驗證畫面與即時同步。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// 中文管理員密碼（從管理員頁的輸入框打進去）
const ADMIN = '測試老師';
const DARK_SECONDS = 4;

let server: ChildProcess;
let base = '';
let dataDir = '';
let browser: Browser;
let serverLog = '';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolvePort(port));
    });
  });
}

async function admin(path: string, body: unknown) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-password': encodeURIComponent(ADMIN) },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'invest-e2e-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const isWin = process.platform === 'win32';
  server = spawn(isWin ? 'npm.cmd' : 'npm', ['start'], {
    cwd: root,
    shell: isWin,
    detached: !isWin,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: ADMIN,
      DATA_DIR: dataDir,
      DARK_SECONDS: String(DARK_SECONDS),
    },
  });
  server.stdout!.on('data', (d: Buffer) => (serverLog += d.toString()));
  server.stderr!.on('data', (d: Buffer) => (serverLog += d.toString()));
  const deadline = Date.now() + 20_000;
  while (!serverLog.includes('已啟動')) {
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`伺服器沒有啟動：\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  if (server?.pid) {
    try {
      if (process.platform === 'win32') server.kill();
      else process.kill(-server.pid, 'SIGTERM');
    } catch {
      // 已結束
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
});

async function openPhone(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  return ctx.newPage();
}

async function openScreen(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  return ctx.newPage();
}

async function loginStudent(page: Page, name: string) {
  await page.goto(base + '/');
  await page.getByLabel('你的姓名').fill(name);
  await page.getByRole('button', { name: '進入' }).click();
  await page.getByText('可用餘額').waitFor();
}

/** 大螢幕排行中某組顯示的金額文字，例如「10萬」 */
function boardTotal(page: Page, group: string) {
  return page.evaluate((g) => {
    for (const row of document.querySelectorAll('.board-row')) {
      if (row.querySelector('.group-short')?.textContent === g) return row.querySelector('.board-total')?.textContent ?? null;
    }
    return null;
  }, group);
}

describe('npm start 啟動後三個頁面都能開', () => {
  it('伺服器啟動並印出三個頁面的網址', () => {
    expect(serverLog).toContain('已啟動');
    expect(serverLog).toContain('/screen');
    expect(serverLog).toContain('/admin');
  });

  it('學生頁：登入表單 → 輸入姓名後看到錢包與各組', async () => {
    const page = await openPhone();
    const res = await page.goto(base + '/');
    expect(res?.status()).toBe(200);
    await expect(page.getByLabel('你的姓名').isVisible()).resolves.toBe(true);
    await loginStudent(page, '王小明');
    await expect(page.getByText('上半場・週三').first().isVisible()).resolves.toBe(true);
    await expect(page.locator('.stock').count()).resolves.toBe(5);
    await expect(page.locator('.stock-own').innerText()).resolves.toContain('自己的組');
    await page.context().close();
  });

  it('大螢幕頁：未開盤畫面與 QR code', async () => {
    const page = await openScreen();
    const res = await page.goto(base + '/screen');
    expect(res?.status()).toBe(200);
    await page.getByText('等待開盤').waitFor();
    await expect(page.locator('svg.qr').count()).resolves.toBe(1);
    await page.context().close();
  });

  it('管理員頁：密碼登入後看到盤況控制', async () => {
    const page = await openScreen();
    const res = await page.goto(base + '/admin');
    expect(res?.status()).toBe(200);
    await page.getByPlaceholder('管理員密碼').fill(ADMIN);
    await page.getByRole('button', { name: '登入' }).click();
    await page.getByText('盤況控制：上半場・週三').waitFor();
    await expect(page.getByRole('button', { name: '▶ 開盤' }).isEnabled()).resolves.toBe(true);
    await page.context().close();
  });
});

describe('瀏覽器實測：學生下單 → 大螢幕', () => {
  it('學生在手機頁按「＋」後，大螢幕畫面 2 秒內顯示新金額；暗盤隱藏金額；倒數結束自動封盤', async () => {
    await admin('/api/admin/phase', { course: 'wed', action: 'open' });
    const screen = await openScreen();
    await screen.goto(base + '/screen');
    await screen.getByText('目前排行').waitFor();

    const phone = await openPhone();
    await loginStudent(phone, '王小明'); // 週三第1組
    const row = phone.locator('.stock', { hasText: '第2組' });
    const plus = row.getByRole('button', { name: /第2組 增加/ });

    const latencies: number[] = [];
    for (const expected of ['10萬', '20萬', '30萬']) {
      const t0 = Date.now();
      await plus.click();
      await screen.waitForFunction(
        (want) => {
          for (const r of document.querySelectorAll('.board-row')) {
            if (r.querySelector('.group-short')?.textContent === '第2組') return r.querySelector('.board-total')?.textContent === want;
          }
          return false;
        },
        expected,
        { timeout: 2000, polling: 20 },
      );
      latencies.push(Date.now() - t0);
    }
    console.log(`瀏覽器實測：手機按下「＋」到大螢幕顯示新金額（毫秒）：${latencies.join(', ')}`);
    expect(Math.max(...latencies)).toBeLessThan(2000);
    await expect(boardTotal(screen, '第2組')).resolves.toBe('30萬');
    await expect(row.locator('.hold-amount').innerText()).resolves.toContain('30');
    await expect(phone.locator('.wallet-value').innerText()).resolves.toContain('70');

    // 超過單組上限：擋下並提示，金額不變
    await phone.getByRole('button', { name: '5 萬', exact: true }).click();
    for (let i = 0; i < 4; i++) await plus.click();
    await expect(row.locator('.hold-amount').innerText()).resolves.toContain('50');
    await plus.click();
    await phone.getByText('這組已達單組上限 50 萬').waitFor();
    await expect(row.locator('.hold-amount').innerText()).resolves.toContain('50');

    // 進入暗盤：大螢幕只剩倒數，沒有任何金額；學生端隱藏各組金額但看得到自己的
    await admin('/api/admin/phase', { course: 'wed', action: 'dark' });
    await screen.getByText('暗盤中 · 金額與排名已隱藏').waitFor({ timeout: 2000 });
    await expect(screen.locator('.board-total').count()).resolves.toBe(0);
    expect(await screen.evaluate(() => document.body.innerText)).not.toContain('萬');
    await phone.getByText('🔒 隱藏').first().waitFor({ timeout: 2000 });
    await expect(phone.locator('.quote-total').count()).resolves.toBe(0);
    const third = phone.locator('.stock', { hasText: '第3組' });
    await third.getByRole('button', { name: /第3組 增加/ }).click();
    await expect(third.locator('.hold-amount').innerText()).resolves.toContain('5');
    await expect(phone.locator('.wallet-value').innerText()).resolves.toContain('45');

    // 倒數結束自動封盤，大螢幕揭曉結果，學生看到自己的報酬
    await screen.getByText('🏆 股神獎').waitFor({ timeout: (DARK_SECONDS + 3) * 1000 });
    await screen.getByText('🚀 一飛沖天獎').waitFor();
    await phone.getByText('你的報酬').waitFor({ timeout: 3000 });
    await expect(phone.locator('.result-rank').innerText()).resolves.toMatch(/第 1 名 \/ 1 位有投資的同學/);
    // 王小明沒投完 45 萬（有登入）→ 從第1組倒扣；排行榜只列各組金額，不列學生姓名
    await phone.getByText('你有 45 萬沒投完').waitFor();
    const table = await screen.locator('.final-table').innerText();
    expect(table).toContain('−45');
    expect(table).not.toContain('王小明');

    // 管理員按「取消封盤」：倒數已結束，所以回到開盤中；大螢幕回到走勢與排行，學生又能下單
    const adminPage = await openScreen();
    adminPage.on('dialog', (d) => void d.accept());
    await adminPage.goto(base + '/admin');
    await adminPage.getByPlaceholder('管理員密碼').fill(ADMIN);
    await adminPage.getByRole('button', { name: '登入' }).click();
    await adminPage.getByRole('button', { name: /取消封盤（回到開盤中）/ }).click();
    await screen.getByText('目前排行').waitFor({ timeout: 2000 });
    await expect(boardTotal(screen, '第2組')).resolves.toBe('50萬');
    await phone.locator('.btn-plus').first().waitFor({ timeout: 2000 });
    await expect(phone.locator('.btn-plus').first().isEnabled()).resolves.toBe(true);
    await expect(phone.getByText('你的報酬').count()).resolves.toBe(0);
    await adminPage.context().close();
    await screen.context().close();
    await phone.context().close();
  });
});
