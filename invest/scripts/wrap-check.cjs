// 文字折行檢查：手機（320、393）、筆電 1366、電視 1920 走過每個畫面，列出「一句話折成兩行以上」的文字。
// 文案原則：一句話一行。改文案後跑一次：
//   npm run build:local && DARK_SECONDS=600 ADMIN_PASSWORD=測試老師 PORT=8857 npm start
//   node scripts/wrap-check.cjs
// 標題、slogan、組員、表格、使用者輸入的內容會略過（本來就可能多行）。
const { chromium, devices } = require('playwright');
const [base = 'http://127.0.0.1:8857', pw = '測試老師'] = process.argv.slice(2);
const rpc = (fn, b) => fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const admin = (fn, a = {}) => rpc(fn, { pw, ...a });
const found = new Map();
function wrapped() {
  const out = [];
  const skip = (el) => el.closest('textarea, input, select, .ticker, .chart, svg, .bs-list, .showcase-slogan, .members, .slide-lines, .mini-table, .data-table, .final-table, .roster-preview, .intro, .login-title, .stage-hero, .pending-title, .dark-countdown, .drumroll');
  const inlineOnly = (el) => [...el.children].every((c) => /^inline/.test(getComputedStyle(c).display));
  const lineCount = (nodes) => {
    const lines = [];
    for (const n of nodes) {
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const rect of r.getClientRects()) {
        if (rect.width < 2 || rect.height < 2) continue;
        const hit = lines.find((l) => rect.top < l.bottom - 2 && rect.bottom > l.top + 2);
        if (hit) { hit.top = Math.min(hit.top, rect.top); hit.bottom = Math.max(hit.bottom, rect.bottom); }
        else lines.push({ top: rect.top, bottom: rect.bottom });
      }
    }
    return lines.length;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (skip(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // 1) 單一段文字自己折行
    for (const t of el.childNodes) {
      if (t.nodeType === 3 && t.textContent.trim() && lineCount([t]) > 1) out.push((el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 70));
    }
    if (cs.display === 'inline') continue;
    if (!el.innerText || !el.innerText.trim() || !inlineOnly(el)) continue;
    if (el.innerText.includes('\n')) { /* 刻意的換行（<br>）另外處理 */ }
    const r = document.createRange();
    r.selectNodeContents(el);
    const lines = [];
    for (const rect of r.getClientRects()) {
      if (rect.width < 2 || rect.height < 2) continue;
      const hit = lines.find((l) => rect.top < l.bottom - 2 && rect.bottom > l.top + 2);
      if (hit) { hit.top = Math.min(hit.top, rect.top); hit.bottom = Math.max(hit.bottom, rect.bottom); }
      else lines.push({ top: rect.top, bottom: rect.bottom });
    }
    const brs = el.querySelectorAll('br').length;
    if (lines.length > 1 + brs) out.push(el.innerText.trim().replace(/\s+/g, ' ').slice(0, 70));
  }
  return [...new Set(out)];
}
async function check(page, view) {
  await page.waitForTimeout(900);
  for (const t of await page.evaluate(wrapped)) {
    if (!found.has(t)) found.set(t, new Set());
    found.get(t).add(view);
  }
}
(async () => {
  const ov = await admin('invest_admin_overview');
  const roster = ov.roster.filter((r) => r.course === 'wed');
  const groups = ov.courses.wed.groups;
  await admin('invest_admin_set_active', { course: 'wed' });
  await admin('invest_admin_reset', { course: 'wed' });
  await admin('invest_admin_stage', { action: 'market' });
  const b = await chromium.launch();
  const phones = [['320', devices['iPhone SE']], ['393', devices['iPhone 15']]];
  const screens = [['TV1920', { width: 1920, height: 1080 }], ['筆電1366', { width: 1366, height: 768 }]];
  const st = roster[0];
  const mkPhone = async ([n, d]) => {
    const p = await (await b.newContext({ ...d })).newPage();
    await p.goto(base + '/?intro=0');
    await check(p, `手機${n}/登入`);
    await p.getByLabel('你的姓名').fill(st.name);
    await p.getByLabel('密碼').fill('1234');
    await p.getByRole('button', { name: '進入' }).click();
    await p.getByText('可用餘額').waitFor();
    return [n, p];
  };
  const P = await Promise.all(phones.map(mkPhone));
  const S = await Promise.all(screens.map(async ([n, vp]) => { const p = await b.newPage({ viewport: vp }); await p.goto(base + '/screen/'); return [n, p]; }));
  const A = await b.newPage({ viewport: { width: 1366, height: 900 } });
  await A.goto(base + '/admin/');
  await A.getByPlaceholder('管理員密碼').fill(pw);
  await A.getByRole('button', { name: '登入' }).click();
  await A.locator('.angel-card').waitFor();
  const all = async (view) => { for (const [n, p] of P) await check(p, `手機${n}/${view}`); for (const [n, p] of S) await check(p, `${n}/${view}`); };
  await all('未開盤');
  await check(A, '管理員/未開盤');
  await admin('invest_admin_phase', { course: 'wed', action: 'open' });
  await admin('invest_admin_present', { course: 'wed', grp: groups[1] });
  for (const [i, s] of roster.slice(0, 6).entries()) {
    const { token } = await rpc('invest_login', { name: s.name, password: '1234' });
    const gs = groups.filter((g) => g !== s.group);
    await rpc('invest_invest', { token, course: 'wed', grp: gs[i % gs.length], amount: 500000 });
  }
  { const { token } = await rpc('invest_login', { name: st.name, password: '1234' }); const g = groups.find((x) => x !== st.group); await rpc('invest_invest', { token, course: 'wed', grp: g, amount: 300000 }); }
  await all('開盤＋報告中');
  await check(A, '管理員/開盤');
  await admin('invest_admin_phase', { course: 'wed', action: 'dark' });
  await all('暗盤');
  await admin('invest_admin_phase', { course: 'wed', action: 'close' });
  await all('封盤等待');
  await admin('invest_admin_angel', { course: 'wed', groups: [groups[2]] });
  const sa = await admin('invest_admin_stage', { action: 'awards' });
  for (let i = 0; i < sa.stage.awardLabels.length; i++) {
    await admin('invest_admin_stage', { action: 'goto', step: i });
    await new Promise((r) => setTimeout(r, 3200));
    for (const [n, p] of S) await check(p, `${n}/頒獎:${sa.stage.awardLabels[i]}`);
  }
  for (const [n, p] of P) await check(p, `手機${n}/結果`);
  await check(A, '管理員/頒獎');
  const ss = await admin('invest_admin_stage', { action: 'summary' });
  for (let i = 0; i < ss.stage.slideLabels.length; i++) {
    await admin('invest_admin_stage', { action: 'goto', step: i });
    for (const [n, p] of S) await check(p, `${n}/總結:${ss.stage.slideLabels[i]}`);
  }
  await admin('invest_admin_stage', { action: 'market' });
  await b.close();
  for (const [t, v] of found) console.log(`「${t}」  ← ${[...v].slice(0, 4).join('、')}${v.size > 4 ? ` 等 ${v.size} 處` : ''}`);
  console.log(found.size ? `共 ${found.size} 段文字折行` : '沒有折行的句子');
  process.exit(found.size ? 1 : 0);
})();
