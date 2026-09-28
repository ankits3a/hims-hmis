// Walk every station and screen at several widths: page errors, render_error blocks, "No handler" toasts, sideways overflow.
// Also clicks every [data-act] button once per screen at 1440 (skipping navigation) to catch handler errors.
const pw = require(process.env.PLAYWRIGHT_CORE || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const path = require('path');
const CHROME = process.env.CHROME || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const FILE = 'file://' + path.resolve(__dirname, '..', 'radiology.html');
const WIDTHS = (process.env.WIDTHS || '1440,1280,1024,768,390').split(',').map(Number);
const CLICK = process.env.CLICK !== '0';
(async () => {
  const b = await pw.chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const problems = [];
  for (const w of WIDTHS) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } });
    p.on('pageerror', e => problems.push(`[${w}] pageerror ${e.message}`));
    p.on('console', m => { if (m.type() === 'error') problems.push(`[${w}] console ${m.text()}`); });
    await p.goto(FILE); await p.waitForTimeout(300);
    const screens = await p.evaluate(() => ORDER.map(id => ST[id].navs.map(n => id + ':' + n.id)).flat());
    for (const s of screens) {
      await p.evaluate(a => { const [st, v] = a.split(':'); S.modal = null; go(st, v); }, s);
      await p.waitForTimeout(60);
      const r = await p.evaluate(() => ({
        errs: Array.from(document.querySelectorAll('.refuse code')).filter(c => c.textContent === 'render_error').map(c => c.parentElement.textContent),
        over: document.documentElement.scrollWidth - window.innerWidth,
        centreOver: (() => { const c = document.getElementById('centre'); return c ? c.scrollWidth - c.clientWidth : 0; })(),
        len: document.getElementById('centre').innerText.length,
      }));
      if (r.errs.length) problems.push(`[${w}] ${s} ${r.errs.join(' | ')}`);
      if (r.over > 0) problems.push(`[${w}] ${s} page overflow ${r.over}px`);
      if (r.centreOver > 2) problems.push(`[${w}] ${s} centre overflow ${r.centreOver}px`);
      if (r.len < 200) problems.push(`[${w}] ${s} centre nearly empty (${r.len} chars)`);
      if (CLICK && w === 1440) {
        const n = await p.evaluate(() => document.querySelectorAll('[data-act]').length);
        for (let i = 0; i < Math.min(n, 60); i++) {
          const res = await p.evaluate(({ i, s }) => {
            const [st, v] = s.split(':');
            if (S.st !== st || S.view[st] !== v) go(st, v);
            const els = Array.from(document.querySelectorAll('[data-act]')).filter(e => !['go', 'nav', 'navToggle', 'listToggle'].includes(e.dataset.act) && !e.closest('.top'));
            const e = els[i]; if (!e) return null;
            const before = document.querySelectorAll('.toast.err').length;
            try { e.click(); } catch (x) { return 'throw ' + e.dataset.act + ' ' + x.message; }
            const errs = Array.from(document.querySelectorAll('.refuse code')).filter(c => c.textContent === 'render_error').map(c => c.parentElement.textContent);
            const noH = Array.from(document.querySelectorAll('.toast.err')).slice(before).map(t => t.textContent).filter(t => t.includes('No handler'));
            S.modal = null;
            return (errs.length ? 'render_error after ' + e.dataset.act + ': ' + errs.join('|') : '') + (noH.length ? ' ' + noH.join('|') : '');
          }, { i, s });
          if (res === null) break;
          if (res) problems.push(`[click] ${s} #${i} ${res}`);
        }
      }
    }
    await p.close();
  }
  await b.close();
  const uniq = [...new Set(problems)];
  console.log(uniq.length ? uniq.join('\n') : 'ERRORS: none');
  console.log('problems', uniq.length);
})();
