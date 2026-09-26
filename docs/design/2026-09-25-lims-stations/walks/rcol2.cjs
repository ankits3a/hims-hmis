const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const p = await b.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const c = async sel => { await p.click(sel, { force: true }); await p.waitForTimeout(160); };
  const shot = async n => { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/d-${n}.png` }); };
  const clear = async () => { await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); };
  await p.goto('file://' + require('path').resolve(__dirname, '../lab-stations.html')); await p.waitForTimeout(300);
  await c('[data-do="station"][data-arg="collection"]'); await shot('1-dash');
  // scan the slip: token 41 → opens and identifies in one go
  await p.fill('#cscan', '41'); await p.keyboard.press('Enter'); await p.waitForTimeout(300); await shot('2-scanned');
  await c('.bell'); await clear();
  await c('[data-do="colFill"][data-arg="c41|0"]'); await c('[data-do="colFill"][data-arg="c41|1"]'); await c('[data-do="colSend"]'); await clear();
  // from the queue: opens in the chair, identity still to confirm
  await c('.prow[data-arg="c39"]'); await shot('3-from-queue');
  await c('[data-do="colId"][data-arg="c39|verbal"]'); await c('[data-do="colArm"][data-arg="c39|L"]'); await shot('4-arm');
  await p.keyboard.press('Escape'); await p.waitForTimeout(150); await clear();
  await p.fill('#cscan', 'Sanjana'); await p.keyboard.press('Enter'); await p.waitForTimeout(250); await c('[data-do="colId"][data-arg="c37|scan"]'); await c('[data-do="colHold"][data-arg="c37|hold"]'); await clear(); await shot('5-held');
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await b.close();
})();
