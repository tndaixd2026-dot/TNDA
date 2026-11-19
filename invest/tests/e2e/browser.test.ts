// 瀏覽器端對端測試：用 `npm start` 啟動本機版伺服器（PGlite 跑和 Supabase 相同的 schema.sql；
// `npm run test:e2e` 會先 `vite build --mode local`），再用 Chromium 打開學生頁、大螢幕頁、管理員頁，
// 驗證畫面與同步（大螢幕每 1 秒、手機每 2 秒查詢一次）。
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

async function rpcJson(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pw: ADMIN, ...args }),
  });
  return res.json();
}

async function admin(fn: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pw: ADMIN, ...args }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { error?: string };
  expect(data.error).toBeUndefined();
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
  // ?intro=0：跳過進場動畫（進場動畫另外測）
  await page.goto(base + '/?intro=0');
  await page.getByLabel('你的姓名').fill(name);
  // 本機版假名單的學生密碼都是 1234
  await page.getByLabel('密碼').fill('1234');
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
    expect(serverLog).toContain('/screen/');
    expect(serverLog).toContain('/admin/');
  });

  it('學生頁：登入表單 → 輸入姓名後看到錢包與各組', async () => {
    const page = await openPhone();
    const res = await page.goto(base + '/?intro=0');
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
    const res = await page.goto(base + '/screen/');
    expect(res?.status()).toBe(200);
    await page.locator('.pending-kicker', { hasText: '等待開盤' }).waitFor();
    // QR code 指向學生頁
    expect(await page.locator('.join-url').innerText()).toBe(base.replace(/^https?:\/\//, ''));
    await expect(page.locator('svg.qr').count()).resolves.toBe(1);
    await page.context().close();
  });

  it('管理員頁：密碼登入後看到盤況控制', async () => {
    const page = await openScreen();
    const res = await page.goto(base + '/admin');
    // /admin 會導到 /admin/（和 GitHub Pages 一樣）
    expect(page.url()).toBe(`${base}/admin/`);
    expect(res?.status()).toBe(200);
    await page.getByPlaceholder('管理員密碼').fill(ADMIN);
    await page.getByRole('button', { name: '登入' }).click();
    await page.getByText('盤況控制：上半場・週三').waitFor();
    await expect(page.getByRole('button', { name: '開盤', exact: true }).isEnabled()).resolves.toBe(true);
    await page.context().close();
  });
});

describe('學生登入頁的進場動畫：出席率行情看板', () => {
  it('第一次開啟會播：目前場次每位學生一列、數字從第一週快轉到最近一週；播完才能登入；同一分頁不再播', async () => {
    const page = await openPhone();
    await page.goto(base + '/');
    await page.locator('.intro').waitFor();
    await expect(page.locator('.login-inner').getAttribute('inert')).resolves.not.toBeNull();
    // 本機版的假名單：週三 20 人、第 2～17 週
    await page.locator('.bs-row').first().waitFor();
    await expect(page.locator('.bs-row').count()).resolves.toBe(20);
    const firstWeek = await page.locator('.bs-week').innerText();
    await page.locator('.intro-stamp .intro-title').waitFor({ timeout: 8000 });
    expect(firstWeek).toBe('W02');
    await expect(page.locator('.bs-week').innerText()).resolves.toBe('W17');
    // 最後一週的出席／應到次數
    await expect(page.locator('.bs-vol').first().innerText()).resolves.toMatch(/^\d+\/\d+$/);
    await page.locator('.intro').waitFor({ state: 'detached', timeout: 4000 });
    await expect(page.locator('.login-inner').getAttribute('inert')).resolves.toBeNull();
    await page.getByLabel('你的姓名').fill('王小明');
    await page.reload();
    await expect(page.locator('.intro').count()).resolves.toBe(0);
    await page.context().close();
  });

  it('可以按 Skip 跳過', async () => {
    const page = await openPhone();
    await page.goto(base + '/?intro=1');
    await page.locator('.bs-row').first().waitFor();
    await page.getByRole('button', { name: /Skip/ }).click();
    await page.locator('.intro').waitFor({ state: 'detached', timeout: 2000 });
    await page.getByLabel('你的姓名').waitFor();
    await page.context().close();
  });

  it('管理員關閉看板後，只播標題，頁面上沒有任何學生姓名', async () => {
    await admin('invest_admin_board', { visible: false });
    const page = await openPhone();
    await page.goto(base + '/?intro=1');
    await page.locator('.intro-title').waitFor();
    await expect(page.locator('.bs-row').count()).resolves.toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('王小明');
    await page.locator('.intro').waitFor({ state: 'detached', timeout: 4000 });
    await page.context().close();
    await admin('invest_admin_board', { visible: true });
  });

  it('系統設定「減少動態效果」時不播', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.getByLabel('你的姓名').waitFor();
    await expect(page.locator('.intro').count()).resolves.toBe(0);
    await ctx.close();
  });
});

describe('瀏覽器實測：學生下單 → 大螢幕', () => {
  it('學生在手機頁按「＋」後，大螢幕畫面 2 秒內顯示新金額；暗盤隱藏金額；倒數結束自動封盤', async () => {
    await admin('invest_admin_phase', { course: 'wed', action: 'open' });
    const screen = await openScreen();
    await screen.goto(base + '/screen/');
    await screen.getByText('目前排行').waitFor();

    const phone = await openPhone();
    await loginStudent(phone, '王小明'); // 週三第1組
    const row = phone.locator('.stock', { hasText: '第2組' });
    const plus = row.getByRole('button', { name: /第2組 增加/ });

    const latencies: number[] = [];
    for (const expected of ['10萬', '20萬', '30萬']) {
      // 先等按鈕停止進場動畫（Playwright 會等元素不再移動才點），從真正按下的那一刻開始計時
      await plus.click({ trial: true });
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
    // 餘額數字會滑動到新值，等它停下來
    await expect.poll(() => phone.locator('.wallet-value').innerText(), { timeout: 2000 }).toContain('70');

    // 沒有單組上限：可以 all in 100 萬；超過餘額才擋下並提示，金額不變
    await phone.getByRole('button', { name: '10 萬', exact: true }).click();
    for (let i = 0; i < 7; i++) await plus.click();
    await expect(row.locator('.hold-amount').innerText()).resolves.toContain('100');
    await plus.click();
    await phone.getByText('餘額不足', { exact: true }).waitFor();
    await expect(row.locator('.hold-amount').innerText()).resolves.toContain('100');
    const minus = row.getByRole('button', { name: /第2組 減少/ });
    for (let i = 0; i < 5; i++) await minus.click();
    await expect.poll(() => phone.locator('.wallet-value').innerText(), { timeout: 2000 }).toContain('50');
    await phone.getByRole('button', { name: '5 萬', exact: true }).click();

    // 第3組上台報告：大螢幕與手機都顯示「報告中 ×1.4」，投給第3組的錢加權 ×1.4
    await admin('invest_admin_present', { course: 'wed', grp: '第3組' });
    await screen.locator('.presenting').getByText('第3組').waitFor({ timeout: 2000 });
    await phone.locator('.stock-boost-tag').getByText('現在投', { exact: false }).waitFor({ timeout: 4000 });

    // 進入暗盤：大螢幕只剩倒數，沒有任何金額；學生端隱藏各組金額但看得到自己的
    await admin('invest_admin_phase', { course: 'wed', action: 'dark' });
    await screen.getByText('暗盤中 · 金額隱藏').waitFor({ timeout: 2000 });
    await expect(screen.locator('.board-total').count()).resolves.toBe(0);
    expect(await screen.evaluate(() => document.body.innerText)).not.toContain('萬');
    await phone.getByText('暗盤隱藏').first().waitFor({ timeout: 4000 });
    await expect(phone.locator('.quote-total').count()).resolves.toBe(0);
    const third = phone.locator('.stock', { hasText: '第3組' });
    await third.getByRole('button', { name: /第3組 增加/ }).click();
    await expect(third.locator('.hold-amount').innerText()).resolves.toContain('5');
    await expect.poll(() => phone.locator('.wallet-value').innerText(), { timeout: 2000 }).toContain('45');
    await phone.getByText('加權後 7 萬').waitFor({ timeout: 4000 });
    await screen.locator('.presenting').waitFor();

    // 倒數結束自動封盤：結果先不公開，大螢幕輪播各組作品，學生手機等待頒獎
    await screen.getByText('等待頒獎揭曉').waitFor({ timeout: (DARK_SECONDS + 3) * 1000 });
    expect(await screen.evaluate(() => document.body.innerText)).not.toContain('萬');
    await screen.locator('.carousel .showcase-slogan').waitFor();
    await phone.locator('.awaiting-text').getByText('等待頒獎揭曉').waitFor({ timeout: 4000 });
    await expect(phone.locator('.result-card').count()).resolves.toBe(0);

    // 管理員開始頒獎，一步一步揭曉（也可以用鍵盤／簡報筆的 →）
    const adminPage = await openScreen();
    adminPage.on('dialog', (d) => void d.accept());
    await adminPage.goto(base + '/admin/');
    await adminPage.getByPlaceholder('管理員密碼').fill(ADMIN);
    await adminPage.getByRole('button', { name: '登入' }).click();
    await adminPage.getByRole('button', { name: '開始頒獎' }).click();
    await screen.getByText('頒獎典禮', { exact: true }).waitFor({ timeout: 3000 });
    await adminPage.keyboard.press('ArrowRight');
    await screen.getByText('結果揭曉', { exact: false }).waitFor({ timeout: 3000 });
    const labels: string[] = await rpcJson('invest_admin_overview', {}).then((o) => o.stage.awardLabels);
    const goto = (label: string) => admin('invest_admin_stage', { action: 'goto', step: labels.indexOf(label) });
    // 第 1 名揭曉前，手機還看不到報酬
    await expect(phone.locator('.result-card').count()).resolves.toBe(0);
    await goto('上半場・週三：第 1 名・一飛沖天獎');
    await screen.locator('.drumroll').waitFor({ timeout: 3000 });
    await screen.getByText('一飛沖天獎', { exact: true }).waitFor({ timeout: 6000 });
    await screen.locator('.stage-first .showcase-slogan').waitFor();
    await screen.locator('.stage-first .member').first().waitFor();
    // 揭曉第 1 名的同時，學生手機出現自己的報酬
    await phone.locator('.result-card').waitFor({ timeout: 4000 });
    await expect(phone.locator('.result-rank').innerText()).resolves.toMatch(/第 1 名 \/ 1 人/);
    await phone.getByText('45 萬沒投完').waitFor();
    await goto('上半場・週三：股神獎');
    await screen.getByText('股神獎', { exact: true }).waitFor({ timeout: 3000 });
    await goto('上半場・週三：完整排名');
    await screen.locator('.final-table').waitFor({ timeout: 3000 });
    // 排行榜只列各組金額，不列學生姓名
    const table = await screen.locator('.final-table').innerText();
    expect(table).toContain('−45');
    expect(table).not.toContain('王小明');

    // 回到盤況畫面，管理員按「取消封盤」：倒數已結束，所以回到開盤中；大螢幕回到走勢與排行，學生又能下單
    await adminPage.getByRole('button', { name: '盤況畫面' }).click();
    await adminPage.getByRole('button', { name: '取消封盤' }).click();
    await screen.getByText('目前排行').waitFor({ timeout: 2000 });
    await expect(boardTotal(screen, '第2組')).resolves.toBe('50萬');
    await phone.locator('.btn-plus').first().waitFor({ timeout: 4000 });
    await expect(phone.locator('.btn-plus').first().isEnabled()).resolves.toBe(true);
    await expect(phone.locator('.result-card').count()).resolves.toBe(0);
    await adminPage.context().close();
    await screen.context().close();
    await phone.context().close();
  });
});
