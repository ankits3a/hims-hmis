const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const p = await br.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const clear = async () => { await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); };
  const c = async sel => { await clear(); await p.click(sel, { force: true }); await p.waitForTimeout(160); };
  const shot = async n => { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/v-${n}.png` }); };
  const ref = async () => (await p.$('.refuse code')) ? await p.textContent('.refuse code') : '-';
  const esc = async () => { await p.evaluate(() => document.activeElement && document.activeElement.blur()); await p.keyboard.press('Escape'); await p.waitForTimeout(150); };
  const txt = async sel => (await p.$(sel)) ? (await p.textContent(sel)).replace(/\s+/g, ' ').trim().slice(0, 160) : '(none)';
  await p.goto('file://' + require('path').resolve(__dirname, '../lab-stations.html')); await p.waitForTimeout(300);
  await c('[data-do="station"][data-arg="verify"]'); await shot('1-dash');
  await c('[data-do="vBatch"]'); console.log('no pin:', await ref());
  await p.fill('#vpin', '1111'); await c('[data-do="vBatch"]'); console.log('wrong pin:', await ref());
  await p.fill('#vpin', '2468'); await p.press('#vpin', 'Enter'); await p.waitForTimeout(200); console.log('batch:', await ref()); await clear(); await shot('2-after-batch');
  // Geeta: critical called, delta explained, comment draft, preview, sign
  await c('.prow[data-arg="vg"]'); await shot('3-geeta');
  await c('[data-do="vPreview"]'); await shot('4-geeta-report'); await c('[data-do="vPreview"]');
  await c('[data-do="vDraft"]'); await c('.dock [data-do="vSign"][data-arg="vg|publish"]'); console.log('geeta sign:', await ref());
  // Suresh: notifiable, send platelets back to the bench
  await c('.prow[data-arg="vs"]'); await c('[data-do="vIdsp"]'); await c('[data-do="vBackOpen"][data-arg="S2609250240-PLT"]'); await shot('5-suresh-back'); await c('[data-do="vBack"]');
  await c('[data-do="station"][data-arg="bench"]'); console.log('bench pill:', !!(await p.$('.prow[data-arg="vs"]')));
  await c('.prow[data-arg="vs"]'); await p.waitForTimeout(10500); await clear(); await shot('6-bench-rerun');
  const ch = await p.$('[data-do="bChoose"][data-arg="S2609250240-PLT|2"]'); if (ch) await c('[data-do="bChoose"][data-arg="S2609250240-PLT|2"]');
  await c('.dock [data-do="bSend"]'); console.log('bench resend:', await ref());
  await c('[data-do="station"][data-arg="verify"]'); await c('.prow[data-arg="vs"]'); await c('.dock [data-do="vSign"][data-arg="vs|publish"]'); console.log('suresh sign:', await ref());
  // restricted HIV
  await c('.prow[data-arg="vh"]'); await shot('7-hiv'); await c('[data-do="vPreview"]'); await shot('8-hiv-report'); await c('.dock [data-do="vSign"][data-arg="vh|publish"]'); console.log('hiv sign:', await ref());
  // Bimal partial, then QC passes, FT4 lands, amendment
  await c('.prow[data-arg="vb"]'); await shot('9-bimal-partial'); await c('.dock [data-do="vSign"][data-arg="vb|publish"]'); console.log('bimal partial:', await ref());
  await c('[data-do="station"][data-arg="bench"]'); await c('.nav [data-do="view"][data-arg="analysers"]'); await c('[data-do="bQc"]'); await p.waitForTimeout(9000); await p.waitForTimeout(15000);
  await c('[data-do="station"][data-arg="verify"]'); await shot('10-amend-queue'); console.log('amend row:', !!(await p.$('.prow[data-arg="vb"]')));
  await c('.prow[data-arg="vb"]'); await shot('11-bimal-amend'); await c('.dock [data-do="vSign"]'); console.log('amend sign:', await ref());
  // correction from Signed today
  await c('.nav [data-do="view"][data-arg="signed"]'); await c('[data-do="vAmendOpen"][data-arg="vr"]'); await c('[data-do="vAmend"]'); console.log('amend no reason:', await ref());
  await p.selectOption('#va-why', 'Comment added or changed'); await p.fill('#va-note', 'Added: no abnormal cells seen'); await c('[data-do="vAmend"]'); console.log('amend:', await ref()); await shot('12-signed');
  await c('.nav [data-do="view"][data-arg="counter"]'); await shot('13-dash-end');
  for (const w of [1920, 1280, 1024, 768, 390]) { await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(150); const o1 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); await p.screenshot({ path: `${SHOTS}/v-w${w}.png` }); console.log('width', w, 'overflow', o1); }
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await br.close();
})();
