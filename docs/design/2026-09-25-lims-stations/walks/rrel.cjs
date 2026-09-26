const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const p = await br.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const clear = async () => { await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); };
  const c = async sel => { await clear(); await p.click(sel, { force: true }); await p.waitForTimeout(160); };
  const shot = async n => { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/g-${n}.png` }); };
  const ref = async () => (await p.$('.refuse code')) ? await p.textContent('.refuse code') : '-';
  const esc = async () => { await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.keyboard.press('Escape'); await p.waitForTimeout(150); };
  await p.goto('file://' + require('path').resolve(__dirname, '../lab-stations.html')); await p.waitForTimeout(300);
  await c('.nav [data-do="view"][data-arg="reports"]'); await shot('1-register');
  await c('[data-do="relSms"][data-arg="rbablu|L2609250041"]'); await c('[data-do="relCall"][data-arg="rirfan|L2609240093"]'); await c('[data-do="relChase"][data-arg="rpratima|L2609250019"]'); await shot('2-register-acted');
  // held: release without payment
  await c('[data-do="relOpen"][data-arg="shivnath"]'); await shot('3-shivnath');
  await c('[data-do="row"][data-arg="shivnath|release:L2609250071"]'); await p.selectOption('#rl-by', { index: 2 }); await p.selectOption('#rl-why', { index: 1 }); await c('[data-do="relRelease"]'); console.log('supervisor release:', await ref());
  await p.selectOption('#rl-by', { index: 1 }); await p.selectOption('#rl-why', { index: 1 }); await c('[data-do="relRelease"]'); console.log('billing manager release:', await ref());
  await c('[data-do="row"][data-arg="shivnath|print:L2609250071"]'); await c('[data-do="print"]'); console.log('no collector:', await ref());
  await c('[data-do="relWho"][data-arg="Relative"]'); await c('[data-do="idok"][data-arg="ID card seen"]'); await c('[data-do="print"]'); console.log('no relative name:', await ref());
  await p.fill('#rel-n', 'Sita Ram'); await p.fill('#rel-r', 'Son'); await c('[data-do="print"]'); console.log('relative without OTP:', await ref());
  await c('[data-do="idok"][data-arg^="OTP"]'); await shot('4-relative'); await c('[data-do="print"]'); console.log('relative print:', await ref());
  // restricted
  await esc(); await c('.nav [data-do="view"][data-arg="reports"]'); await c('[data-do="relOpen"][data-arg="rrestr"]');
  await c('[data-do="row"][data-arg="rrestr|print:L2609200033"]'); await c('[data-do="print"]'); console.log('no counselling:', await ref());
  await c('[data-do="relCounsel"]'); await c('[data-do="relWho"][data-arg="Someone else"]'); await c('[data-do="print"]'); console.log('someone else:', await ref());
  await c('[data-do="relWho"][data-arg="Patient"]'); await c('[data-do="idok"][data-arg="ID card seen"]'); await shot('5-hiv'); await c('[data-do="print"]'); console.log('hiv handover:', await ref());
  // verify signs Geeta → the register
  await esc(); await c('[data-do="station"][data-arg="verify"]'); await c('.prow[data-arg="vg"]'); await p.fill('#vpin', '2468'); await c('.dock [data-do="vSign"][data-arg="vg|publish"]'); console.log('verify sign:', await ref());
  await c('[data-do="station"][data-arg="reception"]'); await c('.nav [data-do="view"][data-arg="reports"]'); await p.waitForTimeout(16000); await shot('6-register-geeta');
  await c('[data-do="relOpen"][data-arg="vgeeta"]'); await shot('7-geeta-counter');
  console.log('copilot:', (await p.textContent('.cop')).replace(/\s+/g, ' ').slice(0, 300));
  for (const w of [1920, 1280, 1024, 768, 390]) { await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(150); const o1 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); await p.screenshot({ path: `${SHOTS}/g-w${w}.png` }); console.log('width', w, 'overflow', o1); }
  await esc(); await c('.nav [data-do="view"][data-arg="reports"]').catch(() => {}); 
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await br.close();
})();
