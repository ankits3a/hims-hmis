const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const url = 'file://' + require('path').resolve(__dirname, '../lab-stations.html');
  for (const w of [1920, 1440, 1280, 1024, 768, 390]) {
    const p = await b.newPage({ viewport: { width: w, height: w === 390 ? 844 : 900 } });
    p.on('pageerror', e => errs.push(w + ' ' + e.message));
    await p.goto(url); await p.waitForTimeout(300);
    await p.evaluate(() => { const r = document.querySelector('.prow[data-arg="farida"]'); r && r.click(); }); await p.waitForTimeout(500);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth); if (sw > w) errs.push(w + ' overflow ' + sw);
    await p.screenshot({ path: `${SHOTS}/v3-${w}-farida.png` });
    if (w === 1024) { await p.click('[data-do="listToggle"]', { force: true }); await p.waitForTimeout(300); await p.screenshot({ path: `${SHOTS}/v3-1024-drawer.png` }); }
    await p.close();
  }
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push('walk ' + e.message));
  const c = async sel => { await p.click(sel, { force: true }); await p.waitForTimeout(150); };
  await p.goto(url); await p.waitForTimeout(300);
  await c('.prow[data-arg="suresh"]'); await p.waitForTimeout(400); await c('[data-do="startVisit"]'); await p.screenshot({ path: SHOTS + '/v3-suresh.png' });
  await c('[data-do="applyPkg"]'); await c('[data-do="qask"]'); await p.screenshot({ path: SHOTS + '/v3-suresh-pkg.png' });
  await c('[data-do="lang"][data-arg="en"]');
  await c('[data-do="check"][data-arg="suresh|id"]'); await c('[data-do="check"][data-arg="suresh|cont"]'); await c('[data-do="collect"]');
  await p.evaluate(() => document.querySelector('#centre').scrollTo(0, 99999)); await p.waitForTimeout(150); await p.screenshot({ path: SHOTS + '/v3-suresh-paid.png' });
  await c('[data-do="raise"]'); await p.screenshot({ path: SHOTS + '/v3-suresh-token.png' });
  await c('[data-do="listExp"]'); await p.screenshot({ path: SHOTS + '/v3-listexp.png' });
  await c('[data-do="back"]'); await p.screenshot({ path: SHOTS + '/v3-dash.png' });
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
