const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const c = async sel => { await p.click(sel, { force: true }); await p.waitForTimeout(160); };
  const shot = async n => { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/v10-${n}.png` }); };
  await p.goto('file://' + require('path').resolve(__dirname, '../lab-stations.html')); await p.waitForTimeout(300);
  await c('.prow[data-arg="farida"]'); await p.waitForTimeout(400); await shot('1-today');
  await c('.vrow[data-arg="farida|V2609250039"]'); await shot('2-eye-visit');
  await c('[data-do="startVisit"][data-arg="farida|V2609250039"]'); await shot('3-eye-order');
  await c('[data-do="check"][data-arg="farida|id"]'); await c('[data-do="check"][data-arg="farida|fast"]'); await c('[data-do="wallet"]'); await c('[data-do="collect"]'); await c('[data-do="raise"]'); await shot('4-eye-token');
  await c('[data-do="visit"][data-arg="farida|V2609250044"]'); await shot('5-med-visit');
  await c('[data-do="startVisit"][data-arg="farida|V2609250044"]'); await shot('6-med-order');
  await c('[data-do="raise"]'); await shot('7-med-token');
  console.log('status:', await p.evaluate(() => document.querySelector('#lane').innerText.slice(0, 400).replace(/\n/g, ' | ')));
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
