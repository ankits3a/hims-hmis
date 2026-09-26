const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const p = await br.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const clear = async () => { await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); };
  const c = async sel => { await clear(); await p.click(sel, { force: true }); await p.waitForTimeout(160); };
  const shot = async n => { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/s-${n}.png` }); };
  const ref = async () => (await p.$('.refuse code')) ? await p.textContent('.refuse code') : '-';
  const txt = async sel => (await p.$(sel)) ? (await p.textContent(sel)).replace(/\s+/g, ' ').trim().slice(0, 140) : '(none)';
  await p.goto('file://' + require('path').resolve(__dirname, '../lab-stations.html')); await p.waitForTimeout(300);
  await c('[data-do="station"][data-arg="supervisor"]'); await shot('1-now'); await p.screenshot({ path: SHOTS + '/s-1-now-full.png', fullPage: true });
  const rows = await p.$$eval('.prow[data-do="supOpen"]', r => r.map(x => x.textContent.replace(/\s+/g, ' ').trim().slice(0, 90))); console.log('escalated:', rows.length); rows.forEach(r => console.log('  ', r));
  // accept one with a reason, refused first without
  await c('.prow[data-do="supOpen"]'); await shot('2-esc'); await c('[data-do="supAccept"]'); console.log('accept no reason:', await ref());
  await p.selectOption('#sa-why', { index: 1 }); await c('[data-do="supAccept"]'); console.log('accepted:', await ref());
  for (let i = 0; i < 8; i++) { const r = await p.$('.prow[data-do="supOpen"]'); if (!r) break; await c('.prow[data-do="supOpen"]'); const h = await txt('.chead h1'); await p.keyboard.press('Enter'); await p.waitForTimeout(250); console.log('acted on:', h, '|', await ref()); await c('[data-do="station"][data-arg="supervisor"]'); }
  await shot('3-after');
  await c('[data-do="supMove"]'); await p.waitForTimeout(8500); await clear(); await shot('4-move');
  await c('.nav [data-do="view"][data-arg="sapprove"]'); await shot('5-approvals');
  await c('[data-do="supDisc"][data-arg="AP-0430|no"]'); console.log('decline no reason:', await ref()); await c('[data-do="supDisc"][data-arg="AP-0430|yes"]'); console.log('approve:', await ref());
  const st = await p.$('[data-do="supStock"]'); if (st) await c('[data-do="supStock"]');
  await c('[data-do="supBench"][data-arg="CP-1"]'); await c('[data-do="supDownAsk"]'); await c('[data-do="supDown"]'); await c('[data-do="station"][data-arg="reception"]'); console.log('reception downtime banner:', !!(await p.$('.downbar')));
  await c('[data-do="station"][data-arg="supervisor"]'); await c('.nav [data-do="view"][data-arg="sapprove"]'); await c('[data-do="supDownAsk"]'); await c('[data-do="supDown"]'); await shot('6-approvals-after');
  await c('.nav [data-do="view"][data-arg="week"]'); await shot('7-week'); await c('[data-do="supExport"]');
  await c('.nav [data-do="view"][data-arg="roster"]'); await c('[data-do="supPageP"]'); await shot('8-roster');
  await c('.nav [data-do="view"][data-arg="counter"]');
  for (const w of [1920, 1440, 1280, 1100, 1024, 768, 390]) { await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(150); const o1 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); await p.screenshot({ path: `${SHOTS}/s-w${w}.png` }); console.log('width', w, 'overflow', o1); }
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await br.close();
})();
