// 跨裝置顯示檢查：用 Chromium 模擬各種手機、平板、電腦的螢幕大小、像素密度與觸控，
// 走過學生會看到的每個畫面，自動找出「水平捲動」「超出畫面」「被裁切的文字」「太小的按鈕」，並存截圖。
//
//   npm run build:local && DARK_SECONDS=600 ADMIN_PASSWORD=測試老師 PORT=8857 npm start
//   node scripts/device-check.cjs http://127.0.0.1:8857 測試老師 ./device-report
//
// 注意：iPhone／iPad 是用 Chromium 模擬尺寸與觸控，不是真的 Safari 引擎；真機仍建議彩排時實際試一次。
const { chromium, devices } = require('playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [base = 'http://127.0.0.1:8857', pw = '測試老師', out = './device-report'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const DEVICES = [
  ['iPhone SE (1st, 320)', devices['iPhone SE']],
  ['iPhone SE (3rd)', devices['iPhone SE (3rd gen)']],
  ['iPhone 12 mini', devices['iPhone 12 Mini']],
  ['iPhone 15', devices['iPhone 15']],
  ['iPhone 15 Pro Max', devices['iPhone 15 Pro Max']],
  ['iPhone 15 橫向', devices['iPhone 15 landscape']],
  ['Galaxy S9+ (320)', devices['Galaxy S9+']],
  ['Galaxy A55', devices['Galaxy A55']],
  ['Galaxy S24', devices['Galaxy S24']],
  ['Pixel 8', devices['Pixel 8']],
  ['Galaxy Z Fold 7 外螢幕', devices['Galaxy Z Fold 7 Cover']],
  ['Galaxy Z Fold 7 展開', devices['Galaxy Z Fold 7']],
  ['iPad mini', devices['iPad Mini']],
  ['iPad Pro 11', devices['iPad Pro 11']],
  ['Galaxy Tab S9', devices['Galaxy Tab S9']],
  ['筆電 1366×768', { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 }],
  ['桌機 1920×1080', { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }],
];

const rpc = (fn, body) =>
  fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const admin = (fn, a) => rpc(fn, { pw, ...a });

/** 在頁面裡找版面問題 */
function audit() {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const label = (el) => {
    const c = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : el.tagName;
    const t = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}「${t}」`;
  };
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`整頁可以左右捲動（內容寬 ${document.documentElement.scrollWidth}px > 螢幕 ${vw}px）`);
  const skip = (el) => el.closest('.ticker, .bs-list, .sparkle, .deco-spark, .intro-spark, svg');
  for (const el of document.querySelectorAll('body *')) {
    if (skip(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed' && el.closest('.intro')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) issues.push(`超出畫面：${label(el)}（${Math.round(r.left)}～${Math.round(r.right)}px）`);
    // 被裁切的文字（不含刻意用 … 省略的姓名與小組暱稱）
    const clips = /hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis';
    if (clips && el.scrollWidth > el.clientWidth + 1 && !el.matches('.bs-name, .bs-title-en, .group-nick, .win-title, .join-url')) {
      issues.push(`文字被切掉：${label(el)}`);
    }
    // 文字溢出父層（沒被裁切但壓到別的東西）
    if (el.children.length === 0 && el.textContent.trim() && el.scrollWidth > el.clientWidth + 2 && cs.display !== 'inline' && cs.overflowX === 'visible') {
      issues.push(`文字溢出：${label(el)}（${el.scrollWidth}>${el.clientWidth}）`);
    }
  }
  // 觸控目標（Apple 建議 44pt、Google 48dp；小於 36px 才算問題）
  for (const el of document.querySelectorAll('button, a[href], input, [role=button]')) {
    if (el.closest('.intro') && !el.matches('.intro-skip')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.height < 36 || r.width < 36) {
      if (el.matches('.link-btn')) continue; // 「不是我」文字連結
      issues.push(`按鈕太小：${label(el)}（${Math.round(r.width)}×${Math.round(r.height)}）`);
    }
  }
  return [...new Set(issues)];
}

(async () => {
  const browser = await chromium.launch();
  const report = [];
  const roster = (await admin('invest_admin_overview', {})).roster.filter((r) => r.course === 'wed');
  await admin('invest_admin_set_active', { course: 'wed' });
  await admin('invest_admin_reset', { course: 'wed' });
  await admin('invest_admin_stage', { action: 'market' });
  await admin('invest_admin_phase', { course: 'wed', action: 'open' });
  // 讓第 2 組在報告中（簡報 ×2），檢查「報告中」橫條與加權標示的版面
  const g2 = [...new Set(roster.map((r) => r.group))].sort()[1];
  await admin('invest_admin_present', { course: 'wed', grp: g2 });

  let n = 0;
  for (const [name, dev] of DEVICES) {
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const student = roster[n++ % roster.length];
    const slug = String(n).padStart(2, '0');
    const states = {};
    const snap = async (state, full = false) => {
      await page.waitForTimeout(250);
      states[state] = await page.evaluate(audit);
      await page.screenshot({ path: join(out, `${slug}-${state}.png`), fullPage: full });
    };

    // 1. 進場動畫（出席率看板）
    await page.goto(base + '/?intro=1');
    await page.locator('.intro-stage-hold').waitFor({ timeout: 15000 });
    await snap('intro');
    await page.getByRole('button', { name: /Skip/ }).click();
    await page.locator('.intro').waitFor({ state: 'detached' });
    // 2. 登入
    await page.waitForTimeout(700);
    await snap('login');
    await page.getByLabel('你的姓名').fill(student.name);
    await page.getByLabel('密碼').fill('1234');
    await page.getByRole('button', { name: '進入' }).click();
    await page.getByText('可用餘額').waitFor();
    await page.waitForTimeout(900);
    // 3. 投資：按幾下＋、打開輸入金額
    const stocks = page.locator('.stock:not(.stock-own)');
    await stocks.nth(0).getByRole('button', { name: /增加/ }).click();
    await stocks.nth(1).getByRole('button', { name: /增加/ }).click();
    await stocks.nth(0).locator('.hold-amount').click();
    await page.evaluate(() => scrollTo(0, 0));
    await snap('market', true);
    // 超過餘額：提示直接顯示在輸入框下方（手機鍵盤打開時也看得到）
    await stocks.nth(0).locator('.amount-editor input').fill('200');
    await stocks.nth(0).getByRole('button', { name: '確定' }).click();
    await stocks.nth(0).locator('.amount-editor .form-error').waitFor();
    await snap('toast');
    // 按「＋」超過餘額的提示（畫面底部）
    await stocks.nth(0).getByRole('button', { name: '取消' }).click();
    await page.getByRole('button', { name: '10 萬', exact: true }).click();
    for (let i = 0; i < 11; i++) await stocks.nth(0).getByRole('button', { name: /增加/ }).click();
    await page.locator('.toast').waitFor();
    await snap('toast2');
    report.push({ name, viewport: dev.viewport, student: '(假名單)', states, errors });
    await ctx.close();
  }

  // 暗盤與結算畫面
  await admin('invest_admin_phase', { course: 'wed', action: 'dark' });
  n = 0;
  for (const [name, dev] of DEVICES) {
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    const student = roster[n++ % roster.length];
    const slug = String(n).padStart(2, '0');
    await page.goto(base + '/?intro=0');
    await page.getByLabel('你的姓名').fill(student.name);
    await page.getByLabel('密碼').fill('1234');
    await page.getByRole('button', { name: '進入' }).click();
    await page.getByText('暗盤隱藏').first().waitFor();
    await page.waitForTimeout(600);
    const r = report.find((x) => x.name === name);
    r.states.dark = await page.evaluate(audit);
    await page.screenshot({ path: join(out, `${slug}-dark.png`) });
    await ctx.close();
  }
  await admin('invest_admin_phase', { course: 'wed', action: 'close' });
  // 封盤後結果要等頒獎揭曉：直接跳到頒獎最後一步再回到盤況畫面
  await admin('invest_admin_stage', { action: 'awards' });
  await admin('invest_admin_stage', { action: 'goto', step: 999 });
  await admin('invest_admin_stage', { action: 'market' });
  n = 0;
  for (const [name, dev] of DEVICES) {
    const ctx = await browser.newContext({ ...dev });
    const page = await ctx.newPage();
    const student = roster[n++ % roster.length];
    const slug = String(n).padStart(2, '0');
    await page.goto(base + '/?intro=0');
    await page.getByLabel('你的姓名').fill(student.name);
    await page.getByLabel('密碼').fill('1234');
    await page.getByRole('button', { name: '進入' }).click();
    await page.getByText('你的報酬').waitFor();
    await page.waitForTimeout(1600);
    const r = report.find((x) => x.name === name);
    r.states.result = await page.evaluate(audit);
    await page.screenshot({ path: join(out, `${slug}-result.png`), fullPage: true });
    await ctx.close();
  }
  await browser.close();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  let total = 0;
  for (const r of report) {
    const issues = Object.entries(r.states).flatMap(([s, list]) => list.map((i) => `  [${s}] ${i}`));
    total += issues.length + r.errors.length;
    console.log(`${issues.length || r.errors.length ? '✗' : '✓'} ${r.name}（${r.viewport.width}×${r.viewport.height}）`);
    for (const i of issues) console.log(i);
    for (const e of r.errors) console.log(`  [JS 錯誤] ${e}`);
  }
  console.log(total ? `共 ${total} 個問題` : '全部裝置、全部畫面都沒有發現問題');
  process.exit(total ? 1 : 0);
})();
