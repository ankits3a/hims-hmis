const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const SHOTS = process.env.SHOTS || require('path').join(require('os').tmpdir(), 'lims-stations-shots'); require('fs').mkdirSync(SHOTS, { recursive: true });
(async () => {
  const br = await chromium.launch({ executablePath: process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const errs = []; const p = await br.newPage({ viewport: { width: 1440, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const clear = async () => { await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove())); };
  const c = async sel => { await clear(); await p.click(sel, { force: true }); await p.waitForTimeout(160); };
  const shot = async n => { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/r-${n}.png` }); };
  const ref = async () => (await p.$('.refuse code')) ? await p.textContent('.refuse code') : '-';
  const esc = async () => { await p.keyboard.press('Escape'); await p.waitForTimeout(150); };
  const txt = async sel => (await p.$(sel)) ? (await p.textContent(sel)).replace(/\s+/g, ' ').trim().slice(0, 140) : '(none)';
  await p.goto('file://' + require('path').resolve(__dirname, '../lab-stations.html')); await p.waitForTimeout(300);
  await c('[data-do="station"][data-arg="bench"]'); await shot('1-dash');
  await c('.nav [data-do="view"][data-arg="runs"]'); await shot('2-runs');
  // EL-120: build run sheet 13 with Deepak, start, complete
  await c('[data-do="bRunOpen"][data-arg="el120"]'); await shot('3-el120');
  await c('[data-do="bSheetAdd"]'); await c('[data-do="bSheetStart"]'); await p.waitForTimeout(11500); await clear(); await shot('4-el120-landed');
  await c('.dock [data-do="bRunComplete"]'); console.log('el120 complete:', await ref(), '|', await txt('.dock .amt'));
  // AU480 batch
  await esc(); await c('[data-do="bRunOpen"][data-arg="au480"]'); await shot('5-au480');
  await c('.dock [data-do="bRunComplete"]'); console.log('au480 complete:', await ref(), '|', await txt('.dock .amt'));
  // Z3: hold Mohan back, complete the rest
  await esc(); await c('[data-do="bRunOpen"][data-arg="z3"]'); await c('[data-do="bRunSel"][data-arg="z3|b19"]'); await shot('6-z3');
  await c('.dock [data-do="bRunComplete"]'); console.log('z3 complete:', await ref(), '|', await txt('.dock .amt'));
  // ESR: name the unread position, complete
  await esc(); await c('[data-do="bRunOpen"][data-arg="esr"]'); await shot('7-esr'); await c('[data-do="bName"]'); await c('.dock [data-do="bRunComplete"]'); console.log('esr complete:', await ref(), '|', await txt('.dock .amt'));
  // patient by patient: Mohan PT typed from the coag printout, with an absurd INR
  await c('.nav [data-do="view"][data-arg="counter"]'); await c('.prow[data-arg="b19"]'); await shot('8-mohan');
  await p.fill('#tv-S2609250276-PTS', '30.1'); await p.fill('#tv-S2609250276-INR', '26'); await c('[data-do="bTypeGroup"]'); console.log('absurd:', await ref());
  await p.selectOption('#ab-S2609250276-INR', 'Abha Rani'); await c('[data-do="bConfirm"]'); console.log('self confirm:', await ref());
  await c('[data-do="bRetype"]'); await p.fill('#tv-S2609250276-INR', '2.6'); await p.press('#tv-S2609250276-INR', 'Enter'); await p.waitForTimeout(200); await shot('9-mohan-typed');
  await c('.dock [data-do="bSend"]'); console.log('mohan send:', await ref());
  // Sunita: EXR port down, HbA1c typed
  await c('.prow[data-arg="b25"]'); await p.fill('#tv-S2609250280-A1C', '7.2'); await p.press('#tv-S2609250280-A1C', 'Enter'); await p.waitForTimeout(200); await c('.dock [data-do="bSend"]'); console.log('sunita send:', await ref());
  // Shreya: C5000 locked, no backup → refused
  await c('.prow[data-arg="b34"]'); await c('[data-do="bSrc"][data-arg="S2609250292~c5000|type"]'); console.log('no backup:', await ref());
  // collection → bench: Dilip STAT; type electrolytes on Curio while EL-120 waits, troponin typed (EXR port down)
  await esc(); await c('[data-do="station"][data-arg="collection"]'); await p.fill('#cscan', '41'); await p.keyboard.press('Enter'); await p.waitForTimeout(250);
  await c('[data-do="colFill"][data-arg="c41|0"]'); await c('[data-do="colFill"][data-arg="c41|1"]'); await c('[data-do="colSend"]');
  await c('[data-do="station"][data-arg="bench"]'); await c('.prow[data-arg="bc41"]');
  for (let i = 0; i < 3; i++) { if (!(await p.$('.dock [data-do="bReceive"]'))) break; await c('.dock [data-do="bReceive"]'); }
  await shot('10-dilip');
  const sst = await p.evaluate(() => { const b = document.querySelector('[data-do="bSrc"][data-arg*="~el120|type"]'); return b ? b.dataset.arg : null; });
  console.log('el120 group:', sst);
  if (sst) { const g = sst.split('|')[0], sn = g.split('~')[0];
    await c(`[data-do="bSrc"][data-arg="${g}|curio"]`); console.log('moved to curio:', await txt('.dock .sub'));
    await p.fill(`#tv-${sn}-TNI`, '846'); await c(`[data-do="bTypeGroup"][data-arg="${sn}~exr"]`);
    await c('[data-do="bRunOpen"][data-arg="curio"]'); await shot('12-curio-sheet'); await c('[data-do="bSheetAdd"]'); await c('[data-do="bSheetStart"]'); await p.waitForTimeout(11500); await clear(); await shot('13-curio-landed');
    await c('.dock [data-do="bRunComplete"]'); console.log('curio complete:', await ref(), '|', await txt('.dock .amt'));
    await esc(); await c('.prow[data-arg="bc41"]'); }
  // Anita: dock takes you to the control that needs you
  await esc(); await c('.prow[data-arg="b26"]'); console.log('anita dock:', await txt('.dock button')); await p.keyboard.press('Enter'); await p.waitForTimeout(200); console.log('focused:', await p.evaluate(() => document.activeElement.id));
  await p.evaluate(() => document.activeElement.blur()); await esc(); await c('.prow[data-arg="bc41"]');
  await clear(); await shot('11-dilip-typed');
  console.log('dilip crit:', await txt('.crit-h'));
  // widths
  for (const w of [1920, 1280, 1024, 768, 390]) { await p.setViewportSize({ width: w, height: 900 }); await p.waitForTimeout(150); const o1 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth); await p.screenshot({ path: `${SHOTS}/r-w${w}-patient.png` });
    await p.evaluate(() => { const b = document.querySelector('[data-do="bRunOpen"][data-arg="z3"]') || document.querySelector('.nav [data-arg="runs"]'); }); await esc(); await c('[data-do="navToggle"]').catch(() => {}); await esc();
    console.log('width', w, 'overflow', o1); }
  console.log('ERRORS:', errs.length ? errs.join('\n') : 'none'); await br.close();
})();
