// Drive every journey in SPINE.md through the spine functions and check each seat shows the hand-off.
const pw = require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const path = require('path');
(async () => {
  const b = await pw.chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('file://' + path.resolve(__dirname, '..', 'radiology.html')); await p.waitForTimeout(300);
  const res = await p.evaluate(() => {
    const out = []; let cur = '';
    const J = n => { cur = n; };
    const see = (sv, sel, label, extra) => {
      const [st, v] = sv.split(':'); if (!ST[st]) { out.push([cur, 'FAIL', label, 'no station ' + st]); return false; }
      if (ST[st].drop) try { ST[st].drop(); } catch (e) {}
      if (extra) extra(); go(st, v);
      const ok = !!document.querySelector(sel); out.push([cur, ok ? 'ok' : 'FAIL', label, sv + ' ' + sel]); return ok;
    };
    const must = (r, label) => { out.push([cur, r ? 'FAIL' : 'ok', label, r ? r.code + ': ' + r.msg : '']); };
    const closeAll = (acc, kinds) => (kinds || Object.keys(study(acc).gates || {})).forEach(k => { if (study(acc).gates[k] === 'open') closeGate(acc, k, 'satisfied'); });
    const PREP = k => !['identity_two_factor', 'laterality_confirm'].includes(k);
    try {
      J('J1 OPD CECT');
      const s1 = orderStudy({ pt: 'mohan', svc: 'RAD-CT-ABD-CECT', n: 'CECT abdomen and pelvis', st: 'CT-ABDO-CONTRAST', mod: 'CT', pri: 'routine', src: 'OPD', doc: 'rao', q: 'Weight loss, raised CA 19-9.', price: 6500, contrast: true });
      see('desk:counter', `[data-acc="${s1.acc}"]`, 'order reaches the counter');
      must(bookStudy(s1.acc, 'CT-1', at(13, 10)), 'booked on CT-1');
      see('desk:schedule', `[data-acc="${s1.acc}"]`, 'booking in the diary');
      see('room:console', `[data-acc="${s1.acc}"]`, 'booking on the CT-1 worklist', () => { S.room = 'CT-1'; });
      checkIn(s1.acc);
      see('prep:bay', `[data-acc="${s1.acc}"]`, 'checked-in contrast study in the prep bay');
      closeAll(s1.acc, Object.keys(study(s1.acc).gates).filter(PREP));
      see('room:console', `[data-acc="${s1.acc}"]`, 'prepped study on the room worklist', () => { S.room = 'CT-1'; });
      closeAll(s1.acc); must(startScan(s1.acc), 'scan starts'); acquire(s1.acc, { ctdi: 14.2, dlp: 690 });
      see('read:worklist', `[data-acc="${s1.acc}"]`, 'acquired study on the reading worklist');
      see('rso:patientdose', `[data-acc="${s1.acc}"]`, 'dose in the patient dose register');
      must(signReport(s1.acc, 'mehta'), 'signed'); must(releaseReport(s1.acc), 'released');
      see('desk:reports', `[data-acc="${s1.acc}"]`, 'release register row');
      see('doc:results', `[data-acc="${s1.acc}"]`, 'doctor inbox row');
      readReport(s1.acc); must(actedUpon(s1.acc, 'Referred to surgical oncology.'), 'acted upon');
      see('doc:results', `[data-acc="${s1.acc}"][data-state="acted"]`, 'inbox shows acted');

      J('J2 ER STAT');
      const s2 = orderStudy({ pt: 'bablu', svc: 'RAD-CT-HEAD', n: 'CT brain, plain', st: 'CT-HEAD-PLAIN', mod: 'CT', dev: 'CT-1', pri: 'stat', src: 'ER', doc: 'chandra', q: 'Fall, GCS 13.', price: 2200, stat: true });
      see('room:console', `[data-acc="${s2.acc}"]`, 'ER order straight on the room worklist', () => { S.room = 'CT-1'; });
      checkIn(s2.acc); closeAll(s2.acc); must(startScan(s2.acc), 'scan starts'); acquire(s2.acc, { ctdi: 55, dlp: 950 });
      see('read:worklist', `[data-acc="${s2.acc}"]`, 'STAT on the reading worklist');
      const c2 = raiseCritical(s2.acc, 'red', 'Acute subdural haematoma with midline shift');
      see('read:critical', `[data-crit="${c2.id}"]`, 'critical call open');
      see('hod:escalations', `[data-crit="CR1"]`, 'red critical at rung 2 escalated to HOD');
      const bad = ackCritical(c2.id, 'yes noted'); out.push([cur, bad && bad.code === 'read_back_mismatch' ? 'ok' : 'FAIL', 'wrong read-back refused', '']);
      must(ackCritical(c2.id, 'Acute subdural haematoma, midline shift, neurosurgery called'), 'read-back accepted');
      see('read:critical', `[data-crit="${c2.id}"][data-state="acked"]`, 'acknowledged log');

      J('J3 IPD portable');
      const s3 = orderStudy({ pt: 'sunil', svc: 'RAD-XR-CHEST-PORT', n: 'X-ray chest AP, portable', st: 'XR-CHEST', mod: 'XR', dev: 'PX-1', pri: 'urgent', src: 'IPD', doc: 'rao', q: 'Post-op day 2, breathless.', price: 600, bed: 'Ward 3 · bed 12' });
      see('doc:ward', `[data-acc="${s3.acc}"]`, 'ward view tracks the order');
      see('room:portable', `[data-acc="${s3.acc}"]`, 'on the portable round');
      checkIn(s3.acc); closeAll(s3.acc); must(startScan(s3.acc), 'exposed at bedside'); acquire(s3.acc, { dap: 0.8 });
      see('read:worklist', `[data-acc="${s3.acc}"]`, 'portable film to read');

      J('J4 obstetric USG');
      const s4 = orderStudy({ pt: 'salma', svc: 'RAD-US-OB-EARLY', n: 'USG obstetric, early pregnancy', st: 'USG-OBS-EARLY', mod: 'US', pri: 'routine', src: 'OPD', doc: 'kujur', q: 'Missed period, UPT positive.', price: 1200, pndt: true });
      must(bookStudy(s4.acc, 'US-2', at(12, 40)), 'booked on US-2'); checkIn(s4.acc);
      see('usg:room', `[data-acc="${s4.acc}"]`, 'on the ultrasound list');
      out.push([cur, startScan(s4.acc) && startScan(s4.acc).code === 'gate_open' ? 'ok' : 'FAIL', 'no scan before Form F', '']);
      must(closeGate(s4.acc, 'form_f', 'satisfied'), 'Form F verified'); closeAll(s4.acc); must(startScan(s4.acc), 'scan starts'); acquire(s4.acc);
      must(signReport(s4.acc, 'farah'), 'signed in the room'); must(releaseReport(s4.acc), 'released');
      see('desk:reports', `[data-acc="${s4.acc}"]`, 'release register row');
      const w = closeGate(s4.acc, 'form_f', 'overridden', 'emergency evening case'); out.push([cur, w && w.code === 'gate_not_overridable' ? 'ok' : 'FAIL', 'Form F override refused', '']);

      J('J5 kidney override');
      see('hod:approvals', `[data-appr="AP1"]`, 'override request with the HOD');
      must(decideApproval('AP1', true, 'Hydrate 1 ml/kg/h, half-dose iso-osmolar contrast.'), 'approved');
      out.push([cur, study('I2609280049').gates.renal_function === 'overridden' ? 'ok' : 'FAIL', 'gate overridden on the study', '']);

      J('J6 licence');
      see('rso:licences', `[data-gap="MG-1"]`, 'MG-1 in the gaps block');
      const m = study('I2609280050'); out.push([cur, startScan(m.acc) && startScan(m.acc).code === 'device_not_licensed' ? 'ok' : 'FAIL', 'unlicensed machine refuses', '']);
      fileLicence('MG-1', 'eLORA licence · valid to 27 Sep 2031');
      see('rso:licences', `[data-gap="MG-1"]`, 'MG-1 still listed as a gap (should be gone)') ; out[out.length - 1][1] = out[out.length - 1][1] === 'ok' ? 'FAIL' : 'ok';
      closeAll(m.acc); must(startScan(m.acc), 'mammogram starts after filing');

      J('J7 outside CD');
      const s7 = orderStudy({ pt: 'priti', svc: 'RAD-2ND-OPINION', n: 'Second opinion, outside MRI brain (CD)', st: 'OUTSIDE-READ', mod: 'MR', pri: 'routine', src: 'OUT', doc: 'rao', q: 'Outside MRI: ?demyelination.', price: 1500 });
      acquire(s7.acc);
      see('read:worklist', `[data-acc="${s7.acc}"]`, 'outside read on the worklist');

      J('J8 repeat no charge');
      const b8 = raiseBill('I2609280033', 'repeat_no_charge', 0, 'Rotated PA, repeat');
      see('room:rejects', `[data-bill="${b8.id}"]`, 'bill decision in the rejects queue');
      see('hod:approvals', `[data-bill="${b8.id}"]`, 'bill decision with the HOD');

      J('J9 follow-up');
      const f9 = addFollowup('I2609280033', 'Repeat chest X-ray in 6 weeks after treatment', 'in 6 weeks', 42);
      see('read:followups', `[data-fu="${f9.id}"]`, 'follow-up tracked');
      see('doc:results', `[data-fu="${f9.id}"]`, 'doctor sees the follow-up to book');
      const n9 = bookFollowup(f9.id, { svc: 'RAD-XR-CHEST-PA', n: 'X-ray chest PA', st: 'XR-CHEST', mod: 'XR', price: 450 });
      see('desk:counter', `[data-acc="${n9.acc}"]`, 'booked follow-up reaches the counter');

      J('J10 downtime');
      setDevice('CT-1', 'down', 'gantry error E-214');
      see('desk:schedule', `[data-down="CT-1"]`, 'diary banner');
      see('room:downtime', `[data-down="CT-1"]`, 'downtime board');
      see('hod:floor', `[data-down="CT-1"]`, 'floor shows the room down');
      setDevice('CT-1', 'up');

      J('J11 access log');
      viewImages('I2609280041', 'reporting');
      see('hod:audit', `[data-alog]`, 'image opening in the access log');
    } catch (e) { out.push([cur, 'FAIL', 'threw', e.message + ' ' + (e.stack || '').split('\n')[1]]); }
    return out;
  });
  let f = 0; res.forEach(r => { if (r[1] !== 'ok') f++; console.log(r[1].padEnd(4), r[0].padEnd(18), r[2], r[1] !== 'ok' ? '· ' + r[3] : ''); });
  console.log('pageerrors', errs.length ? errs.join(' | ') : 0); console.log('steps', res.length, 'failed', f);
  await b.close();
})();
