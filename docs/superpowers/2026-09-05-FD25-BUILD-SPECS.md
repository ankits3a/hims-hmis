# FD-25 — build specs, derived 2026-09-04 by an 8-agent workflow
**Companion to `2026-09-05-HANDOFF-front-desk-FD25-screens.md`. Read the handoff first.**

Produced by a Workflow run: six agents each read one signed-off artboard plus the live code and the
server routes; one derived the shared-file plan; one criticised the lot against the repo. 8 agents,
1.26 M tokens, 520 tool calls, ~30 minutes.

**Treat the specs as a strong draft and the CRITIQUE as the corrections** — the critic re-checked
every claim against the tree and caught several wrong ones. Where they disagree, the critique wins;
where you can, verify before building.

---

## registration — `/registration`
**Complexity:** large

### What exists today

NOTHING EXISTS AT /registration — the route is absent from apps/web/src/router.tsx and its absence is actively ASSERTED in three test files. It was deleted at commit 7455c1c (FD-9), which removed registration-screen.tsx (401 lines), registration-counter.tsx (2289), appointment-seat.tsx and appointment-workspace.tsx together with ~4000 lines of their tests. Do NOT resurrect them from git: `git show 7455c1c^:apps/web/src/screens/registration.tsx` is empty, the surviving files are the pre-Desk-One design the owner rejected by name, and their money path predates FD-14/FD-18/FD-23. THE REUSABLE ASSET IS DESK ONE'S REGISTRATION STAGE. apps/web/src/screens/desk-one/stages.tsx:346-870 (`StageRegister`) is a production-quality SUPERSET of the artboard's form: the four fast-path fields, an age/DOB toggle with a load-bearing React key, the guardian Fold that opens itself off `formNeedsGuardian`, ABHA with a real capability probe, seven more Folds, the duplicate-warning panel and the enrol button. apps/web/src/screens/desk-one/stages.tsx:84-251 (`StageFind`) is the artboard's search box, debounce, hit rows and match-reason pills already built. THE CORRECT MOVE IS EXTRACTION, NOT A COPY: lift `StageFind`, `StageRegister` and the `Field`/`Picker`/`Fold` helpers (stages.tsx:252-345) into a shared module both /counter and /registration mount, so the guardian rule, the dob key fix and the duplicate override cannot drift into two versions. WHAT MUST BE WRITTEN FRESH: the 290px rail (Desk One's apps/web/src/screens/desk-one/dossier.tsx:82 calls `useDesk()` and is welded to the five-stage session — it cannot be mounted here as-is), the 'Their card' panel, the inline two-doors + proposal block (today that lives in `StageAppointment`, stages.tsx:889+, as a separate stage), and the guardian Authority toggles. THE ROUTE'S REASON FOR EXISTING: FD-9 collapsed three routes into /counter for the ONE-user case; per the FD-8 memory both flows are authorised — three users = three routes, one user = Desk One stages. /registration is the single-seat door for a clerk who holds `patients.register` and NOT billing, and that is why re-adding it is not a reversal of the owner's ruling. Say so in the route docstring, because router.tsx:497-540 currently argues the opposite at length.

### What the artboard specifies

- ARTBOARD IS 1440x980 (canvas.json:artboards[1]), four regions top to bottom: a 44px header bar, then a flex row of a FIXED 290px left rail + a flex-grow workspace (gap 16, padding 18px 22px), then the dark agent dock across the foot. Header: 'CRK | Registration' + mono '/registration'; right side carries a green pill reading 'drawer not needed here' and a secondary button 'Search — the cursor starts here [Esc]'.

- LEFT RAIL (290px, two .box cards). Card 1 tag 'Patient in hand': name 16px/600, Hindi name in .dev (फ़रीदा ख़ातून), UHID mono 12.5, facts 'female · 51y · Hajipur', then flag pills ('guardian on file' green, 'no ABHA' plain). Empty state is one line: 'Nobody at the counter yet.' Card 2 tag 'Their card': a 52px dashed-border camera placeholder, the next UHID in mono 15px/600, caption 'the next number this hospital will issue', and a left-aligned secondary button 'Take a photo'.

- WORKSPACE BOX 1 — SEARCH FIRST. Heading 15px/600 'Who is in front of you?'. Input placeholder 'name, mobile or UHID — any part of the name'. Helper 11.5px: 'Search before you type a single form field — a duplicate stopped here costs nothing. A surname works: Kumar finds every Kumar.' Then up to 3 hit rows (.hit): line 1 name 14/600 + UHID mono; line 2 facts + phone mono + last-seen faint ('last seen 14-Aug' / 'never returned'); right-hand pill is the WHY — 'same mobile', 'same name', 'approximate'. Footer row above a line2 rule: 'None of these is the person in front of you?' + a green-outlined 'Register new [F4]'.

- WORKSPACE BOX 2 — THE FORM. Header 'New patient' + faint 'four fields open a visit — the rest is only asked when it applies'. 2-col grid (.grd, gap 13): Name spans both columns; Mobile (mono); Age (mono); Sex as three 40px-tall pill buttons Female / Male / Other with Female selected. NOTE: the artboard shows Age only — no age/DOB toggle, no address row.

- THE TWO DOORS TO A DOCTOR, inline in the form above a line2 rule. Header 'Who will see them?' + faint 'a doctor by name, or the complaint and we route it'. A 1fr 1fr grid: left label 'A doctor, by name' with a mono 'Tab 9' hint, placeholder 'type a name…'; right label 'Or what brings them in' with 'Tab 10', placeholder 'seene mein dard · fever · sugar-BP…'. Neither is the fallback — the comment is explicit that Tab lands on whichever door the clerk starts typing in.

- THE PROPOSAL CARD (green-line border, green-soft ground, 7px radius, 11px 13px padding), never a silent assignment. Row 1: a green .tag naming the RULE — 'Rule 1 · continuity of care' or 'Rule 2 · nobody has seen them here' — and a right-aligned green pill 'seen her before' / 'shortest wait'. Row 2: doctor 15/600, department 11.5 dim, room mono faint (G-12 / C-08), and a right-aligned mono wait '6 ahead · ~72m · 10:24' / '1 ahead · ~12m · 09:24'. Row 3 is the reason in prose: 'Dr Rao consulted her on 14-Aug for the same complaint. He is 4 ahead of the shortest line — continuity wins that trade, and the history does not have to be taken again. Overrule it on the routing screen if she asks for someone else.'

- GUARDIAN BLOCK — gold-line border, gold-soft ground, RENDERED ONLY WHEN age < 18 and never before. Header: a user icon, '{age} years old — a guardian is required' in gold 13/600, and a right-aligned gold pill 'DPDP §9'. 2-col grid: Guardian's name; Relationship as three 40px pills Father / Mother / Other (Mother selected); Guardian's mobile (mono); and 'Authority' as four toggle pills — messages (on), bills (on), consents (off), records (off). Footnote 11px: 'What the guardian may do on this child's behalf is recorded now, and it is revocable. Consent is not the same as billing — the two are separate switches on purpose.'

- THE OTHER THREE, FOLDED (closed by default, one open at a time via the openFold prop). Each fold header is icon + name + faint note + a right-aligned state pill; the open body is a var(--wash) panel with a 2-col grid of two mono fields plus a prose paragraph. (a) ABHA — note 'the national health id, if they have one', state 'not linked'/'open', fields 'ABHA address' (farida.khatoon@abdm) and 'ABHA number' (12-3456-7890-1234), body 'One OTP links it. Verification status is recorded — self-declared and verified are different facts and the record keeps them apart.' (b) Photograph — 'taken at the counter, attached to the card', state 'none on file', fields 'Captured' and 'Attached to', body 'The photo is confirmed against the demographics before it attaches — large, side by side, an explicit yes. A photo on the wrong record is worse than no photo.' (c) Confidential record — 'a VIP, a staff member, a sensitive context', state 'ordinary record', gold pill when open, fields 'Alias shown on every screen' (Patient 44) and 'Reason (recorded)' (staff member), body 'The alias replaces the name on furniture — the strip, the board, the queue display — for everyone, including people who may read the real name. Sealing is revocable; a UHID is not, which is why status never lives in the number.'

- FOOTER OF THE FORM (above a line2 rule): primary green 'Register and open the visit [Ctrl ⏎]', secondary 'Cancel [Esc]', and right-aligned faint 'issues U00110012 · prints the card and the token'.

- AGENT DOCK, full-width foot, --agent ink #132420 on --agent-fg #d9efe4: 'Assistant' in white bold, the ticker in --agent-dim, a mint 'Show me' action right-aligned, and a dark [F2] keycap labelled 'pull up'. Two ticker strings are specified: adult — 'Three people on file share this mobile. They may be one family, or one duplicate.'; minor — 'This child was here in June with a different guardian on the form — worth a look.'

- THREE INTERACTIVE PROPS drive every state: age (int 0-110, default 8) drives the guardian block AND flips the whole routing proposal between Rule 1/Rule 2 wording; stage (empty|searched|inhand, default searched) drives the rail's empty state and whether hits render; openFold (none|abha|photo|confidential, default abha). Tokens are Desk One's exactly — paper #f4f7f4, pine #0e6b4e, gold #dd8f1c, red #b23a30, mint #35c48f — and the canvas brief says they were 'lifted from desk-one.html, not re-invented'.

### Server endpoints

**Existing:**
- `GET /patients/search?q=&limit= — patients.controller.ts:305-306, patients.read. The search box; returns WirePatientHit with `matchedOn` lanes that render the artboard's 'same mobile'/'same name'/'approximate' pills`
- `POST /patients — patients.controller.ts:394-395, patients.register. The whole form is already on the wire: registerBody (:120-166) accepts name, phone, altPhone, dob OR ageYears, sex, addressLine, district, stateName, pincode, language, bloodGroup, isConfidential, alias, sensitiveContext, abhaAddress, abhaNumber, abhaVerificationStatus, legacyUhid, guardian (with all four authority booleans, :91-94), title, fatherHusbandName, maritalStatus, nationality, nationalIdType, nationalIdMasked, religion, occupation, monthlyIncomePaise, referredBy*, coverages[], promotionalOptIn, acknowledgedDuplicates. Refuses once with `duplicate_suspected` + candidates, and with `minor_needs_guardian` (registration.ts:184-186) and `alias_required` (:179-180)`
- `GET /patients/abha/capability — patients.controller.ts:299-300, patients.register. Decides whether the ABHA fold's create/verify buttons are live or disabled-with-a-reason`
- `PUT /patients/:id/photo — patients.controller.ts:482-483, patients.update. The rail's Take-a-photo, AFTER a UHID exists`
- `GET /patients/:id/photo — patients.controller.ts:495-496, patients.read`
- `GET /patients/:id/qr — patients.controller.ts:503-504, patients.read. Feeds the 'Their card' preview`
- `GET /patients/:id — patients.controller.ts:421-422, patients.read. The rail's facts line when a hit is taken`
- `POST /patients/:id/guardians — patients.controller.ts:561-562, patients.update. For adding a guardian to an EXISTING patient; a new registration carries the guardian inline in registerBody instead`
- `GET /opd/departments — opd-masters.controller.ts:270-271, opd.masters.read`
- `GET /opd/doctors — opd-masters.controller.ts:334-335, opd.masters.read. The 'A doctor, by name' door`
- `POST /opd/triage — opd-visits.controller.ts:231-232, opd.visits.open. The 'Or what brings them in' door: free text (including Hinglish, per the artboard's 'seene mein dard') to a department`
- `GET /opd/continuity?patientId=&departmentId= — opd-visits.controller.ts:244-245, opd.visits.open. Rule 1's server answer; returns the anchor `proposeWalkIn` needs`
- `GET /opd/queues/summary?serviceDate= — opd-queue.controller.ts:107-108, opd.queue.read. The ONLY source of '6 ahead · ~72m · 10:24'; `waitMinutes`/`etaClock` in desk-one/model.ts:238/:316 do the arithmetic`
- `POST /opd/walk-in — opd-visits.controller.ts:340-341, opd.visits.open. Registers-and-seats in one call; note the docstring at :334-339 that it asserts patients.register INSIDE the service rather than via a second decorator. Supports join:'queue' (token now) and join:'defer' (bill-first) with two different result shapes (opd-api.ts:438-441)`
- `POST /opd/visits/:id/join-queue — opd-visits.controller.ts:357-358, opd.visits.open. Idempotent; the second half of a deferred walk-in`
- `GET /print/jobs?encounterId= — printing.controller.ts:155-156, opd.visits.open. The footer's print status`
- `POST /print/reprint — printing.controller.ts:192-193, opd.visits.open. F9's destination if this seat binds it`
- `GET /opd/patients/:patientId/timeline — opd-visits.controller.ts:589-590, opd.visits.read. Optional: the rail's 'have they been here' line, five rows deep as Dossier's History does`

**Claimed missing (VERIFY — the critic corrected several):**
- `GET /patients/next-uhid (or equivalent) — NOTHING serves the rail's '{{nextUhid}} · the next number this hospital will issue' or the footer's 'issues U00110012'. Verified: apps/core/src/modules/patients/patients.controller.ts declares no such route, and `allocateUhid` (uhid.ts:186) is an internal transactional function with no HTTP surface. RECOMMEND NOT BUILDING IT: the allocation is serial (uhid.test.ts:99-110 proves 20 concurrent calls get 20 distinct numbers), so any preview is a number a peer at the next counter may take first, and the artboard shows the same value twice. Show the UHID after registration instead, or caption it honestly.`
- `A `patient_uhid_card` PRINT DOCUMENT KIND — not an endpoint but a genuine server gap behind the artboard's 'prints the card and the token'. apps/core/src/kernel/printing/enqueue.ts:26-30 declares exactly four kinds (opd_token_slip, opd_payment_receipt, opd_prescription, vitals_slip); render.ts:445 dispatches on them; DESTINATION_OF (enqueue.ts:54-59) maps each to a logical printer. Adding the card is a code change plus a template plus a destination row — the file says explicitly 'never a migration'.`
- `A RECORDED FREE-TEXT REASON FOR SEALING A RECORD — the Confidential fold draws 'Reason (recorded)' with the value 'staff member'. registerBody (patients.controller.ts:135-137) accepts `isConfidential`, `alias` and the boolean `sensitiveContext`, but no reason string, and apps/core/src/kernel/db/schema/patients.ts:103-104 has only `is_confidential` + `alias`. Either drop the field from the build, map it onto `sensitiveContext` as a two-state control, or add a column — the last is a migration and therefore its own PR (CLAUDE.md: additive, one per PR, numbered at rebase time).`

### Reuse, do not reinvent

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/desk-one/stages.tsx — `StageRegister` (:346-870) and `StageFind` (:84-251) are the form and the search box already built; extract them plus the `Field` (:252), `Picker` (:273) and `Fold` (:305) helpers and the `GRID3`/`GRID4` constants (:343-344) into a shared module rather than copying

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/desk-one/session.ts — `Form`/`EMPTY_FORM` (:93-157), `CoverageDraft`/`EMPTY_COVERAGE` (:61-91), `Person` (:16), and above all `formAgeYears` (:320) + `MAJORITY_AGE` (:335) + `formNeedsGuardian` (:337), which are the ONLY correct implementation of the artboard's age<18 rule and must not be re-derived

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/desk-one/desk-one.css — `.pp` scope carries every primitive the artboard draws (.tag :61, .kb :67, .pri :75, .sec :81, .box :89, .in :90, .pill/.on/.gd :97-103, .agchip/.agdo :122-131, .drow :141) for a screen that lives INSIDE the app shell; `.d1` layout rules are deliberately not shared. This file is imported only from desk-one.tsx:28 — the new screen must import it too

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/styles/paper-pine.css — the palette, defined once at :28-31. SEE RISKS: `.pp` is not in its selector list

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/components/agent-dock.tsx — `AgentDock` (:33) is the props-driven dock built in FD-23 exactly so a non-Desk-One screen can carry the bar; it binds F2 locally (:63-70) and exports `AgentLine` and `logged`. Props: {answer, log, onAsk, placeholder, idle}

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/desk-one/photo.tsx — `PhotoPanel` (:86), `downscaleToDataUrl` (:43), `base64Of` (:64), `cameraAvailable` (:82); this is the artboard's 'Take a photo' and Photograph fold, including the confirm-against-demographics step

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/lib/patients-api.ts — `searchPatients` (:106), `registerPatient` (:226), `duplicateCandidates` (:234), `abhaCapability` (:210), `putPatientPhoto` (:251), and `matchReasonKeys` (:74) + `matchReasonsDiscriminate` (:95), which produce the artboard's 'same mobile' / 'same name' / 'approximate' pills

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/lib/walk-in-routing.ts — `proposeWalkIn` (:88) returns exactly the artboard's proposal card: {rule: 'continuity'|'shortest_wait'|'department_queue', doctor, waitMinutes, delayed, alternative, anchor, anchorUnavailable, anchorOnLeave}. `DELAY_HIGHLIGHT_MINUTES` (:37) is the gold threshold

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/desk-one/model.ts — `ageOf` (:385), `sexLetter` (:404), `initialsOf` (:411), `waitMinutes` (:238), `etaClock` (:316), `tokenLabel` (:368), `deptQueues` (:257), `istClock`/`istDateLabel` (:302/:309) for the rail and the wait line

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/components/submit-button.tsx — `SubmitButton` (:25), already used by StageRegister's siblings for the Ctrl+Enter commit

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/components/patient-photo.tsx — `PatientPhoto` (:12) for the rail thumbnail once a UHID exists

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/components/qr-card.tsx — `QrCard` (:9) for the 'Their card' preview, fed by GET /patients/:id/qr

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/lib/print-api.ts — `listPrintJobs` (:32), `reprintJob` (:43), `printSummary` (:66), `PRINT_DOCUMENT_LABEL` (:48) for the footer's 'prints the card and the token' status

- /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/opd-appointments.tsx:499 and /opt/hmis-lanes/front-desk/hmis/apps/web/src/screens/patient-detail.tsx:857 — the two existing precedents for a `.pp` screen inside the shell; copy their wrapper shape (className="pp", minHeight: calc(100vh - 96px)) and their AgentDock wiring (opd-appointments.tsx:601)

### Permissions

- patients.register — the route guard, and what POST /patients and GET /patients/abha/capability require (patients.controller.ts:299, :394). Held by front_office (seed-roles.ts:96), front_office_supervisor (:122), billing_manager (:451) and one more role at :973

- patients.read — GET /patients/search, GET /patients/:id, GET /patients/:id/qr, GET /patients/:id/photo (patients.controller.ts:305, :421, :503, :495)

- patients.update — PUT /patients/:id/photo and POST /patients/:id/guardians (patients.controller.ts:482, :561); needed for the rail's Take-a-photo once a UHID exists

- opd.masters.read — GET /opd/departments and GET /opd/doctors for the 'A doctor, by name' door (opd-masters.controller.ts:270, :334)

- opd.queue.read — GET /opd/queues/summary, the only source of the proposal card's '6 ahead · ~72m' (opd-queue.controller.ts:107)

- opd.visits.open — POST /opd/triage, GET /opd/continuity, POST /opd/walk-in, POST /opd/visits/:id/join-queue, GET /print/jobs, POST /print/reprint (opd-visits.controller.ts:231, :244, :340, :357; printing.controller.ts:155, :192)

- NOT NEEDED and must not be demanded: billing.session.own, billing.invoice.read, billing.invoice.issue. front_office (seed-roles.ts:84-102) holds none of them — see the DeskProvider risk below

- NO NEW PERMISSION STRING IS REQUIRED. Do not touch apps/core/scripts/seed-roles.ts or apps/core/test/seed-roles.test.ts — the seat is fully covered by grants front_office already has, and that test pins permission counts against README tables in both directions

### Keyboard

- Tab / Shift+Tab — THE PRIMARY INSTRUMENT. Keymap.dc.html pins the exact /registration order: 1 Search (focused on arrival), 2 Name, 3 Mobile, 4 Age, [5-7 Guardian's name / Relationship / Guardian's mobile — INSERTED at position 5 the moment the age reads under 18, never before], 8 Sex, 9 Doctor-or-complaint. The artboard's own field hints say 'Tab 9' and 'Tab 10' for the two doors. The Keymap's rule: 'Tab must never stop at a field that is not on screen, and it must never skip one that is' — so the closed folds must carry tabIndex -1 or not be rendered

- Esc — once returns the cursor to the search box, twice clears the desk. The header button 'Search — the cursor starts here [Esc]' must actually do this; a keycap that lies is the rule this design system states explicitly (agent-dock.tsx:50-53)

- Ctrl+Enter — commit: register and open the visit. A CHORD deliberately, because Keymap law 4 is 'nothing destructive on a bare key'

- Enter — do the obvious next thing: take the highlighted search hit

- F4 — register a new patient. Was Ctrl+N, which Chrome never delivers. MUST BE BOUND LOCALLY on this screen and must stopPropagation, because lib/keyboard.tsx:98-120 binds F4 globally to navigate({to: '/counter', search: {new: true}}) — see risks

- F2 — focus the agent ask box. Already bound inside components/agent-dock.tsx:63-70, local and per-screen; lib/keyboard.tsx deliberately leaves F2 unbound globally and its reservation comment (:133-148) must stay untouched

- Up / Down — move through the search hits

- DO NOT BIND: Ctrl+K (Chrome's address bar — the Keymap moves it to 'nothing at all' because the search box is already focused), Ctrl+N (Chrome non-overridable), F1/F3/F5/F6/F10/F11/F12, and bare 1/2/3 (tender lanes, and this seat takes no money). BROWSER_FREE_FUNCTION_KEYS in lib/keyboard.tsx:44 is the allowlist: F2, F4, F7, F8, F9 only

### Risks

- apps/web/src/styles/paper-pine.css:28-31 — the ONLY definition of --paper/--ink/--line/--dim/--green/--gold in the whole web app is scoped to `.d1, .lg, .dash, .shell`, and `.pp` IS NOT IN THAT LIST. `.shell` is on the <header> only (router.tsx:282), not on an ancestor of the outlet. So every `var(--green)` / `var(--dim)` / `var(--line)` inside a `.pp` subtree resolves to nothing. This is ALREADY LIVE on /opd/appointments (opd-appointments.tsx:499) and /patients/:id (patient-detail.tsx:857) shipped in FD-23. Verified: `grep -rn -- '--paper:' apps/web/src` returns exactly one hit. Build /registration on `.pp` without adding `.pp` to that selector list and the whole artboard renders colourless — and no vitest run will catch it, because jsdom does not compute CSS variables.

- apps/web/src/screens/desk-one/desk-one.tsx:417 sends `...(f.isConfidential ? { isConfidential: true } : {})` and NEVER sends `alias`; apps/core/src/modules/patients/registration.ts:179-180 throws PatientError('alias_required') for exactly that body. Ticking the confidential box on Desk One today 400s at the counter. The artboard FIXES this by drawing 'Alias shown on every screen' as a field — the new screen must send `alias`, and the extraction must carry the fix back to /counter or the two will disagree. Second-order: registration.ts:156-177 documents that POST /patients accepts isConfidential under `patients.register` ALONE, while `patients.confidential.read` is held by ZERO roles — so a patient flagged here is a record nobody can read back by name.

- apps/core/test/caddyfile-parity.test.ts:385-387 fails TWICE: `expect(routes).toHaveLength(48)` becomes 49, and `expect(routes).not.toContain("/registration")` is a direct negative assertion of this exact route. The file's own docstring demands the number be MEASURED by running the test against the tree, never predicted — run it, read the reported length, raise the pin to that, and replace the negative with a positive plus a comment recording the three-user/one-user reason.

- apps/web/src/shell-nav.test.tsx:91 and :182 both assert `expect(hrefs).not.toContain("/registration")`, and :53 / :191 build their fixtures on the premise that `patients.register` opens NO nav row at all. Adding a nav row for this seat invalidates the fixture at :191 (which deliberately switched to `patients.merge` to keep a group non-empty) as well as the two assertions.

- apps/web/src/lib/keyboard.tsx:98-120 — the global F4 handler navigates to `/counter?new=true` unconditionally. A clerk on /registration who presses F4 (the artboard's own 'Register new [F4]' button) is yanked to Desk One mid-patient. Either bind F4 locally with stopPropagation before the provider's window listener, or make the global handler route-aware. keyboard.test.tsx pins the current behaviour, so this is a shared-file edit.

- REUSING DeskProvider WHOLESALE 403s TWICE PER PATIENT. desk-one.tsx:133 fires `fetchCurrentSession` (GET /billing/sessions/current, billing.controller.ts:854 = billing.session.own) unconditionally, and :150-153 fires `listDues` (GET /billing/patients/:id/dues, billing.controller.ts:737 = billing.invoice.read) whenever a person is in hand. front_office (seed-roles.ts:84-102) holds NEITHER. Either give the extracted stages a slimmer provider, or gate both queries on `can(...)` the way :160 already gates the membership recognition query.

- apps/core/test/nav-parity.test.ts:108-118 compares router.tsx's NAV table to the module manifests' `menu` arrays in BOTH directions and fails on any permission drift. `patientsManifest.menu` is `[]` (apps/core/src/modules/patients/manifest.ts:21, with a docstring explaining why), and opdManifest.menu (opd/manifest.ts:13-30) argues at length that /counter is now the only front-desk row. A NAV row for /registration needs a matching manifest entry with an IDENTICAL permission string, plus that docstring amended — otherwise CI reds on a file every lane touches.

- apps/core/src/kernel/printing/enqueue.ts:26-30 — `PrintDocument` is exactly four kinds: opd_token_slip, opd_payment_receipt, opd_prescription, vitals_slip. There is NO patient-card document. The artboard's footer copy 'prints the card and the token' is therefore half-true today: the token prints, the card does not. Either add the kind + a template + a DESTINATION_OF row (enqueue.ts:54-59), or change the copy. Do not ship the sentence over a capability that does not exist.

- THE RAIL'S 'Their card / {{nextUhid}} — the next number this hospital will issue' HAS NO SOURCE AND ARGUABLY CANNOT. `allocateUhid` (apps/core/src/modules/patients/uhid.ts:186) is transactional and serial; uhid.test.ts:104 proves 20 concurrent allocations get 20 distinct numbers. Any preview endpoint would show a number a peer at the next counter takes first, and the artboard shows the SAME value in the rail and in the footer's 'issues U00110012'. Recommend: render the panel with the photo slot and 'Take a photo' but show the UHID only AFTER registration, or make the caption honestly say 'approximately'.

- apps/web/src/screens/desk-one/desk-one.css is imported only from desk-one.tsx:28. A `.pp` screen that never mounts Desk One in its route tree gets none of the primitives under code-splitting. Import it explicitly (or move the `.pp` half into styles/paper-pine.css alongside the palette, which is the cleaner fix and kills the previous risk too).

- apps/web/src/screens/desk-one/dossier.tsx:82 calls `useDesk()` on its first line and dereferences the five-stage session (STEPS, tokenStateOf, the live bill). It CANNOT be dropped into this screen's 290px rail. The artboard's rail is a different, smaller thing — two cards, no step rail, no bill — so write it fresh rather than trying to parameterise Dossier and dragging the billing coupling in with it.

- apps/web/src/screens/desk-one/sidebars.test.tsx:487 asserts the rail contains no raw `registrationCounter.[a-zA-Z.]+` substring — i.e. it catches a missing i18n key by its key name leaking into rendered text. Reusing that namespace on a NEW rail without adding every key makes this test fail in a way whose message points at Desk One, not at your screen.

- GUARDIAN 'Authority' IS ON THE WIRE AND NOBODY SENDS IT. patients.controller.ts:91-94 accepts authorityMessages / authorityConsents / authorityDsr / authorityBills, and apps/core/src/kernel/db/schema/patients.ts:312-315 stores all four (defaults true/true/FALSE/true). The artboard's four pills are messages·bills on, consents·records off — which does NOT match the server defaults (consents defaults TRUE, records/dsr defaults FALSE). Send all four explicitly; do not rely on defaults, and do not let the pills' initial state disagree with what gets posted.

- KNOWN LANE FLAKES — do not chase these into your own diff. `desk-appointments.test.ts` P5 (not.toContain over ULID-laden card JSON), `kernel/worker/jobs.test.ts` V12 (wall-clock scheduler window), `partners/accrual.test.ts` F11(a) (300 ms lock-settle budget), `lab-reports` D9. All four are recorded lane-wide; re-run and check CI on the same SHA before freezing anything.

### Locale

Two namespaces, both in apps/web/src/locales/en.json AND hi.json (apps/web/src/lib/i18n.test.ts:11 pins them key-for-key; both files are currently at 2657 leaves exactly). REUSE `registrationCounter.register.*` (36 existing keys: fullName, mobile, age, dob, sex, address, optional, guardian.*, abha.*, more.*, where.*, id.*, cover.*, ref.*, flags.*) for every shared form field — that namespace has 274 leaves and is the extracted StageRegister's home, so re-keying it would touch Desk One. ADD a new sibling namespace `registrationSeat` for this screen's own chrome, roughly 60 new leaves per file (~120 total): header (2 — title, drawerPill), rail (7 — inHand, nobodyYet, theirCard, nextUhid, nextUhidWhy, takePhoto, flags), search (4 — heading, placeholder, helper, surnameExample), hits (4 — lastSeen, neverReturned, noneOfThese, registerNew), form (2 — newPatient, fourFields), doors (5 — heading, hint, byName, byNamePlaceholder, complaint, complaintPlaceholder), proposal (7 — ruleContinuity, ruleShortest, badgeSeenBefore, badgeShortest, waitLine, reasonContinuity, reasonFirstVisit), guardian authority (5 — authority, messages, bills, consents, records), fold states (9 — notLinked, open, noneOnFile, ordinaryRecord, plus the three body paragraphs and the alias/reason labels), footer (4 — submit, cancel, issuesLine, printsLine), agent (4 — idle, placeholder, tickerSharedMobile, tickerDifferentGuardian). WARNING on the Hindi half: apps/web/src/screens/desk-one/sidebars.test.tsx:487 asserts the rail renders no raw `registrationCounter.[a-zA-Z.]+` string, i.e. a missing key leaks its key name into the UI; and desk-one.css:217-220 carries `[data-lang=\"hi\"]` overrides for `.tag` (Devanagari has no case and no letter-spacing) that a `.pp` screen inherits only if it sets data-lang on its root the way `.d1` does.

### Shared files this screen touches

SEVEN HARD SERIALIZATION POINTS, and five of them are the same files the sibling /appointment and /billing screens in this three-seat series must also edit — so these tasks cannot be merged in parallel and must be STACKED (see the lane's stacked-PR practice; never resolve --ours on a shared file). (1) apps/web/src/router.tsx — the import, the NAV row, and the route object; every screen in the series adds one, and the file is on the coordinate-before-editing list in CLAUDE.md. (2) apps/web/src/locales/en.json AND hi.json — ~60 new leaves each, and i18n.test.ts:11 fails on any key present in one and not the other; three screens adding keys to one JSON object is the classic three-way conflict. (3) apps/core/test/caddyfile-parity.test.ts — ONE integer (`toHaveLength(48)`, line 385) that all three screens increment, plus this screen's own `not.toContain(\"/registration\")` at :387 and /appointment's twin at :388. Its docstring is explicit that a task moving the number joins the Files list of every other task that moves it. (4) apps/core/test/nav-parity.test.ts + the module manifest the NAV row is declared in (apps/core/src/modules/opd/manifest.ts:13-30 or apps/core/src/modules/patients/manifest.ts:21) — the two lists are compared in both directions, so the router edit and the manifest edit must land in the SAME commit. (5) apps/web/src/shell-nav.test.tsx (:53, :91, :182, :191) and apps/web/src/components/command-palette.tsx:62 + command-palette.test.tsx (:27, :49, :144, :154) — all six sites currently encode 'there is exactly one front-desk row and /registration is deleted'. (6) apps/web/src/lib/keyboard.tsx (F4 at :98) and its keyboard.test.tsx — shared with any seat that wants a screen-local function key. (7) apps/web/src/styles/paper-pine.css:28-31 and apps/web/src/screens/desk-one/desk-one.css — adding `.pp` to the palette selector fixes /opd/appointments and /patients/:id at the same time, so whichever lane lands it first, the others must rebase rather than re-fix. ALSO SHARED, if the extraction is done properly: apps/web/src/screens/desk-one/stages.tsx and session.ts — /counter keeps importing them, so any signature change there breaks Desk One's four test files (registration-fields.test.tsx, appointment-panels.test.tsx, corrections.test.tsx, sidebars.test.tsx). SAFE TO OWN ALONE: the new screen file and its test, the new `registrationSeat` locale subtree, and the extracted shared module's own new test file. NOT TOUCHED AT ALL: apps/core/scripts/seed-roles.ts, apps/core/test/seed-roles.test.ts, apps/core/drizzle/** — no new permission and no migration.

---

## appointment — `/appointment`
**Complexity:** large

### What the artboard specifies

- LAYOUT: three bands. (1) Top bar, 11px/22px padding, white on --line: `CRK | Appointments` + mono `/appointment`, then right-aligned a leave pill and a `.sec` button reading exactly "Search — the cursor starts here" with an `Esc` keycap. (2) Body `display:flex; gap:16px; padding:18px 22px` — a 290px fixed rail on the left, a flex-grow workspace. (3) Agent bar on --agent (#132420) pinned to the bottom, with a mint `.agdo` action button and an `F2 / pull up` keycap.

- RAIL BOX 1 — "Booking for": tag `Booking for`, then name 16px/600 ("Ramesh Kumar"), mono UHID ("U00110012"), and "male · 41y · Hajipur". Divider, then tag `Their history` with 3 rows of `{when 56px mono} {what} {state pill right-aligned}` — e.g. `14-Aug | Dr Iyer · Paediatrics | seen`, `19-Jun | Dr Iyer · Paediatrics | missed` (gold pill).

- RAIL BOX 2 — "Need rebooking": tag + a RED count pill on the right showing `5 patients` (or `none` when no leave is declared). Rows are BUTTONS: name 12.5px/500, a mono sub-line `Mon 07-Sep 10:00 · Dr Rao`, and a right-aligned mono PHONE NUMBER `98351 20114`. The comment calls this "the leave cascade's landing place… the only screen in the product that can answer 'the doctor is away — who do I have to call?'"

- WORKSPACE BOX 1 — "Book a slot", subtitle verbatim: "a booking is a promise about a time — the board only shows times that exist". Three fields on a `1.4fr 1fr 1fr` grid: Doctor ("Dr Meera Iyer · Paediatrics"), Day (mono, "Fri 04-Sep"), Room ("OPD-1 · Ground"). Room is DISPLAY, derived from the schedule — the artboard never offers a room choice.

- SLOT BOARD: header `Morning · 09:00–13:00` (a session band, not the whole day) + a note that reads "10-minute slots · nothing held yet" and becomes "10-minute slots · 10:20 held for this patient" once picked. A three-swatch legend on the right: free (white/solid border), taken (wash/DASHED border), yours (solid green). Grid is `repeat(8, minmax(0,1fr))`, gap 7px, 24 chips for 09:00–13:00 at 10 minutes. Three visual states are explicitly three different things — the comment: "a greyed slot that might be either is how a desk double-books". Taken chips are `cursor:not-allowed`.

- COMMIT ROW: a `.pri` button whose label is stateful — "Pick a time first" with nothing selected, "Book 10:20 with Dr Iyer" once picked — carrying a `Ctrl ⏎` keycap. Beside it a `.sec` "Book without leaving registration" with an `F7` keycap. Right-aligned note: "a slot is not held until it is booked" → "confirms by SMS in Hindi · no token until they arrive".

- WORKSPACE BOX 2 — "Today's book", subtitle `Thu 03-Sep · Dr Meera Iyer`, and THREE count pills top-right: green `55 checked in`, gold `9 to arrive`, red `3 missed`. Column header strip on --wash: Time (52px) · Patient (grow) · Status (96px) · Action (120px, right-aligned).

- BOOK ROWS: mono time, patient name + a sub-line `U00110054 · new` / `· revisit`, a status pill (`seen` plain, `in consult`/`waiting` green, `booked` gold, `missed` red), then EITHER an action button OR a mono `token 4`. Actions are exactly two: green-outlined bold "Check in" on a `booked` row, plain "Rebook" on a `missed` row. A row that already has a token shows the token and NO button. Note the sample includes an 08:50 row listed AFTER 09:40 — a missed row sorted to the bottom, not by time.

- STATES the artboard toggles on a `leave` boolean: leave ON → gold pill "Dr Rao on leave from Mon 07-Sep", rebooking count `5 patients`, agent ticker "Dr Rao's Monday list is 5 people. Dr Iyer has 5 free slots that morning — shall I draft the calls?" with a mint action button "Draft the calls". Leave OFF → green pill "no leave declared this week", count `none`, ticker "Nothing needs moving today."

- Keymap.dc.html §appointment gives the Tab order for THIS seat, five stops: 1 Search ("which patient?", focused on arrival) → 2 Doctor → 3 Day → 4 Slot grid ("↑↓ ←→ inside") → 5 Confirm the booking (Ctrl+⏎). Laws: no chord the browser answers; a key means one thing on every seat; bare keys only outside a field; nothing destructive on a bare key (commits are Ctrl+⏎).

### Server endpoints

**Existing:**
- `GET /api/patients/search?q&limit — patients.read; returns WirePatientHit WITH `phone`, `district`, `registeredOn`, `matchedOn` (apps/web/src/lib/patients-api.ts:35). This is the rail's search door.`
- `GET /api/opd/patients/:patientId/timeline — opd.visits.read; the rail's "Their history" (client `patientTimeline`, opd-api.ts:729). Already rendered by desk-one/dossier.tsx's private `History`.`
- `GET /api/opd/departments — opd.masters.read (listDepartments)`
- `GET /api/opd/doctors — opd.masters.read (listDoctors); the doctor MASTER incl. `departmentId` + `active`. FD-22 already proved this is the right source for a FUTURE booking, not `/opd/queues/summary` (which is today's board only).`
- `GET /api/opd/rooms — opd.masters.read (listRooms); resolves `slot.roomId` → the artboard's "OPD-1 · Ground".`
- `GET /api/opd/slots?doctorId&date — opd.appointments.read; returns `{start,end,roomId,scheduleId,booked,past}`. `scheduleId` is what lets you group the grid into the artboard's "Morning · 09:00–13:00" bands (one template = one band). Returns [] for a doctor on scheduled leave (slots.ts:15).`
- `GET /api/opd/appointments?doctorId&serviceDate — opd.appointments.read; today's book, rows carry `patient` (PatientSummary, restricted/alias aware). Client `listDayAppointments` (opd-api.ts:738).`
- `GET /api/opd/appointments?patientId&status=booked — the patient's own upcoming bookings. Client `listPatientAppointments` (opd-api.ts:501).`
- `GET /api/opd/appointments?needsRebooking=true — the rebooking rail. Filter already implemented (opd-visits.controller.ts:264 → appointments.ts:217). NO web client wrapper exists; opd-appointments.tsx:371 calls `api()` raw.`
- `GET /api/opd/leaves?from&to&status=scheduled — opd.masters.read; `doctorId` is OPTIONAL (opd-masters.controller.ts:160-165), so a hospital-wide leave read for the top-bar pill works today. The web client `listLeaves(doctorId)` (opd-api.ts:373) hardcodes doctorId and must be widened — a client change, not a server one.`
- `POST /api/opd/appointments — opd.appointments.manage; body {patientId, doctorId, slotStart, source?, note?}. Refuses `slot_in_past`, `doctor_inactive`, leave days (`assertNotOnLeave`), and `slot_taken` on the insert race.`
- `POST /api/opd/appointments/:id/reschedule — opd.appointments.manage; `doctorId` optional, so a move ACROSS doctors uses the same route (client `rescheduleAppointment`, opd-api.ts:764).`
- `POST /api/opd/appointments/:id/cancel — opd.appointments.manage; reason REQUIRED.`
- `POST /api/opd/appointments/:id/check-in — opd.visits.open (NOT appointments.manage); turns the booking into the visit and returns OpenVisitResult with `tokenNo`.`
- `GET /api/opd/visits?doctorId&serviceDate — opd.visits.read; each item carries `queueEntry.tokenNo`. This is how the artboard's `token 4` column on an already-checked-in row is rendered — join on `appointment.encounterId === visit.id`. One extra query, not one per row.`
- `GET /api/patients/:id — patients.read; the only route that returns a phone for a known id, and it writes a PHI-access row per call (patients.controller.ts:429).`

**Claimed missing (VERIFY — the critic corrected several):**
- `NO endpoint returns a PHONE NUMBER for a batch of appointment rows. `PatientSummary` (apps/core/src/modules/patients/registration.ts:776-785) carries requestedId/id/uhid/name/alias/restricted/administrativeGender/dob and deliberately no contact field, and `withPatients` (opd-visits.controller.ts:639) is the only decoration the appointments list gets. The artboard's rebooking rail shows a phone per row. Three ways out, all needing a decision before code: (a) add an opt-in `?contact=true` to GET /opd/appointments that adds `phone` only for `needs_rebooking` rows and records a PHI access — narrow, auditable; (b) widen PatientSummary — touches every queue/desk/board consumer and is a privacy-surface change (§14); (c) drop the phone column from the rail. Do NOT solve it with N× GET /patients/:id: that is N PHI-log rows every 15-second poll.`
- `NO date bound on the needs-rebooking read. `listAppointments` (appointments.ts:207-220) supports only an EXACT `serviceDate`, so `?needsRebooking=true` returns every historical needs_rebooking row hospital-wide, capped at 500. The desk tile does the right thing server-side with `gte(serviceDate, today)` (desk-provider.ts:296) and the SPA cannot express it. Either add `serviceDateFrom` to `appointmentsQuery`, or filter client-side and say so in a comment.`

### Reuse, do not reinvent

- apps/web/src/screens/desk-one/desk-one.css — THE design system. Wear `.pp`, not `.d1`: `.d1` is `position:fixed;inset:0` and covers the shell (desk-one.css:38-49); `.pp` scopes the same primitives (`.box .in .pri .sec .pill .tag .mo .kb .drow .agchip .agdo`) for a screen that keeps the topbar. Precedent set by FD-23 on /opd/appointments (opd-appointments.tsx:490-493). CAUTION: desk-one.css is imported ONLY by desk-one.tsx:28 — add an explicit `import "./desk-one/desk-one.css";` rather than relying on bundle order.

- apps/web/src/components/agent-dock.tsx — AgentDock + `logged()`. Mandatory. It already binds F2 locally (agent-dock.tsx:63-70), so do NOT bind F2 again. It has NO action-button prop today — the artboard's mint "Draft the calls" needs an optional `action?: {label, onAct, busy?}` added here (see parallelSafe).

- apps/web/src/screens/desk-one/stages.tsx:1219-1789 `FutureTab` — the closest thing to the artboard's whole workspace already written and tested: department/doctor/date pickers, the slot grid with free/taken/yours and its legend, a pick-then-confirm commit (NOT click-to-book), the moving banner, the cancel-with-reason confirmation, inline per-row refusals keyed by appointment id, the day's book with move/cancel/check-in. Lift the logic; it is bound to `useDesk()` so it must be prop-driven or re-hosted, exactly as AgentDock was.

- apps/web/src/screens/desk-one/stages.tsx:1213 `slotClock(iso)` — one IST clock face for chips, the confirm button and the book, so the three cannot disagree. Copy it or export it.

- apps/web/src/lib/format.ts — `dayMonthIst` (:84), `fmtIst` (:55), `useDebounced` (:92).

- apps/web/src/lib/patient-in-hand.tsx — `usePatientInHand()`; ids only, sessionStorage, already mounted by the shell and by `renderWithProviders`. This is how the rail keeps "Booking for" across a route change and how /counter hands a patient here.

- apps/web/src/components/patient-picker.tsx — `PatientPicker({onPick, autoFocus})`, already wired to `searchPatients`. Cheapest way to serve the top bar's "Search — the cursor starts here" without rebuilding Desk One's StageFind.

- apps/web/src/screens/desk-one/dossier.tsx:32-80 `History` — the exact rail history the artboard draws (timeline read, 5 rows, dayMonthIst + department · doctor + status). It is PRIVATE and reads `useDesk()` only for the surrounding Dossier; extract it as `History({patientId})`.

- apps/web/src/lib/opd-api.ts — every client but two already exists: getSlots, bookAppointment, listPatientAppointments, listDayAppointments, rescheduleAppointment, cancelAppointment, checkInAppointment, listDoctors, listRooms, listDepartments, patientTimeline, opdErrorMessage, todayIst. Add `listNeedsRebooking()` and widen `listLeaves` to optional doctorId + from/to.

- apps/web/src/components/token-slip.tsx — the printed slip check-in produces; /opd/appointments already prints it on check-in (opd-appointments.test.tsx asserts "Room: 12").

- apps/web/src/test-utils.tsx — `renderWithProviders` + `stubFetch`.

### Permissions

- opd.appointments.manage — the seat's own key. Held by `front_office` (seed-roles.ts:90) and `front_office_supervisor` (:117). This is what the deleted FD-7 T2 route gated on and what the NAV row should carry. It is the WRITE grant, which is what distinguishes this seat from /opd/appointments' read-gated supervisor view.

- opd.appointments.read — GET /opd/appointments and GET /opd/slots (front_office :89).

- opd.visits.open — POST /opd/appointments/:id/check-in. NOT the same key as booking; a clerk holding manage-but-not-open can book and cannot check in, so the Check-in button must be permission-aware, not assumed (front_office :92).

- opd.visits.read — GET /opd/patients/:id/timeline (the rail history) and GET /opd/visits (the token column) (front_office :91).

- opd.masters.read — GET /opd/doctors, /departments, /rooms, /leaves (front_office :88).

- patients.read — GET /patients/search and GET /patients/:id (front_office :97).

- DO NOT mint an `appointments_clerk` role. seed-roles.ts is pinned cell-for-cell against README.md's two markdown tables in BOTH directions by apps/core/test/seed-roles.test.ts; a row that is neither table-derived nor one of the twenty-five named exceptions FAILS. A new role means editing README.md's tables in the same commit — a cross-lane serialization cost for no capability, since front_office already holds the full set.

### Keyboard

- Esc — return the cursor to the search box; a second Esc releases the patient in hand. This is the top bar's advertised key and the reason Ctrl+K is NOT bound (Keymap: "a shortcut for a field that already has the cursor is a shortcut nobody presses").

- Tab / Shift+Tab — the five-stop order Keymap.dc.html pins for this seat: Search → Doctor → Day → Slot grid → Confirm. Tab must never stop at a control that is not on screen (the cancel-reason field and the moving banner appear and disappear).

- Ctrl+Enter — commit the booking. The artboard draws this keycap on the primary button. A chord because it is the irreversible one; nothing destructive on a bare key.

- Enter — the obvious next thing on the focused row: check in the highlighted booking. Note Desk One's FutureTab currently draws a bare `⏎` keycap on its confirm button (stages.tsx:1668) while the artboard says Ctrl+⏎ — resolve to Ctrl+⏎ here and fix the keycap, do not ship two meanings.

- ↑ ↓ (and ← → inside the slot grid) — move through search hits and free slots. Keymap explicitly gives the slot grid arrow navigation.

- F2 — the agent. ALREADY BOUND by components/agent-dock.tsx:63-70 via a window listener. Mount the dock and do not add a second handler.

- F7 — the appointment book. lib/keyboard.tsx:123-130 currently navigates F7 to `/opd/appointments`; it must land on `/appointment` once this seat exists, and lib/keyboard.test.tsx:99-103 pins the old destination. The artboard also draws F7 on a secondary button ("Book without leaving registration") — that copy predates the three-seat split and needs an owner-free decision: keep F7 as the global nav key to this screen, and either delete that button or relabel it "back to registration".

- NOT F8, NOT F9, NOT F4 on this screen. keyboard.tsx:149-155 states the rule verbatim: a keycap that lies is worse than none. F9 (reprint the last document) becomes legitimate here ONLY if check-in's TokenSlip reprint is actually implemented; if it is not built, no keycap.

### Risks

- apps/core/src/modules/opd/appointments.ts:235 — the no-show sweep only claims rows with `serviceDate < today`. NOTHING sets `no_show` on today's date. So the artboard's red `3 missed` pill and its `08:50 Lakshmi Prasad · missed · Rebook` row will be PERMANENTLY ZERO if you derive them from `status === "no_show"`. The correct derivation already exists server-side: desk-provider.ts:293 counts `status === "booked" AND slotEnd < now` as missed-so-far, and its own comment says so. Derive missed the same way, client-side, and add `no_show` for rows carried over from a previous day.

- apps/web/src/screens/opd-appointments.tsx:371 — `GET /opd/appointments?needsRebooking=true` with no date bound. `listAppointments` (appointments.ts:207-220) has no from/to, so this returns every needs_rebooking row ever created, up to the 500 cap, oldest first (`orderBy asc(slotStart)`). A rail built on it will fill with last month's cancelled leave and the artboard's `5 patients` count will be wrong. Filter `serviceDate >= today` client-side (matching desk-provider.ts:296) or add the server param — but do not copy the existing screen's call verbatim.

- apps/core/src/modules/patients/registration.ts:776-785 + opd-visits.controller.ts:639 — no phone on the rebooking rows. Building the rail against `apt.patient` will silently render a blank column; the failure is invisible because PatientSummary has no phone FIELD to be null. Decide the approach (see serverEndpoints.missing) before writing the rail, not after.

- apps/web/src/lib/keyboard.tsx:130 navigates F7 to `/opd/appointments`, and apps/web/src/lib/keyboard.test.tsx:99-103 asserts exactly that. Re-pointing F7 breaks that test by design; leaving it means the front desk's book key opens the SUPERVISOR's screen and the new seat has no key at all. Change both in one commit and say why in the test.

- apps/core/test/caddyfile-parity.test.ts:373 `expect(routes).toHaveLength(48)` and :375 `expect(routes).not.toContain("/appointment")`. Both fail the moment the route is declared. The file's own discipline: raise the number to what the run REPORTS, never to what arithmetic predicts, and flip :375 to `toContain`. The comment block at :352-372 already carries FD-7's 48→49 history — extend it, do not rewrite it.

- apps/web/src/shell-nav.test.tsx:92 and :183 both assert `expect(hrefs).not.toContain("/appointment")`, under the heading "one door to the front desk, not three". Adding a NAV row breaks both. This is the FD-9 ruling written into a test: re-adding the row is re-opening a door the owner closed for the SINGLE-user flow. FD-8 authorised BOTH flows (3 users = 3 routes; 1 user = Desk One stages) — cite that when you change these lines, and check with main before assuming it still holds.

- apps/core/src/modules/opd/manifest.ts:23-24 — the `{ label: "Appointment", path: "/appointment", permission: "opd.appointments.manage" }` menu entry was deleted by FD-9 and its removal is explained in a comment at :18-22. apps/core/test/nav-parity.test.ts compares router NAV against manifest menus for paths in BOTH lists: a NAV row with no manifest entry passes, but a manifest entry whose permission differs from the NAV row's FAILS. If you restore the manifest entry, it must read `opd.appointments.manage` — the same string as the NAV row.

- apps/web/src/test-utils.tsx:29-40 — `stubFetch` keys on `METHOD path` with the query string STRIPPED. This screen makes THREE different reads of `/opd/appointments` (day book, this patient's bookings, needs-rebooking) plus one of `/opd/visits`. They all collide on one stub entry. Handlers receive the full url as their second argument and must branch on it, or the tests will assert against whichever body was registered last and pass vacuously.

- apps/core/src/modules/opd/appointments.ts:187 — check-in refuses `appointment_not_today` with a good message, and FD-22 already ruled the PLACEMENT: the refusal belongs inline under the row, never in a page banner (stages.tsx:1310-1326). Hold rowError per appointment id so two rows cannot show each other's answer. Same for cancel, which requires a non-empty reason and is two deliberate acts.

- POST /opd/appointments takes no idempotency key (contrast walkIn, opd-api.ts:438). A double-click on the confirm button fires two bookings; the second gets `slot_taken` from `onConflictDoNothing` (appointments.ts:69). Disable the button while in flight — the artboard's stateful label ("holding…") is where that state shows.

- The rail's "Their history" reads `GET /opd/patients/:id/timeline` on `opd.visits.read`. The patient in hand is stored as an ID ONLY, never a name (patient-in-hand.tsx:14-20, and the comment explains why: a cached name survives a merge and becomes a wrong-patient risk). Render every rail field live from the id; do not stash the name from the search hit.

- apps/web/src/screens/desk-one/desk-one.css is imported only at desk-one.tsx:28. /opd/appointments wears `.pp` and gets styled today purely because router.tsx statically imports DeskOne into the same bundle. That is load-bearing by accident — import the stylesheet from the new screen explicitly.

- `slotsForDate` returns [] for a doctor on scheduled leave (slots.ts:15), and `bookAppointment` calls `assertNotOnLeave` (appointments.ts:54). So the leave pill in the top bar and the empty slot board are two renderings of one fact; make the empty state say WHICH ("Dr Rao is on leave that day" vs "no session that day"), which FutureTab already distinguishes with `no-session` / `day-full` testids (stages.tsx:1602-1610).

- The artboard's Today's-book rows show only Check in and Rebook. FD-22 added move + cancel + check-in to Desk One's book on the owner's own reports (stages.tsx:1717-1760). Dropping them here to match the artboard would REMOVE shipped behaviour the owner asked for; keeping them means the row is wider than the artboard's 120px action column. Decide deliberately and record it — this is exactly the class of silent regression the FD-23 comment warns about.

### Locale

Namespace `appointmentSeat` — and it is ALREADY THERE, orphaned. FD-9 deleted appointment-seat.tsx and `nav.appointmentSeat` but left the top-level `appointmentSeat` block intact in BOTH apps/web/src/locales/en.json:2997 and hi.json — 35 keys, zero references in apps/web/src (grep confirms). Roughly 20 of them are reusable verbatim (`title`, `walkIn`, `future`, `doctor`, `date`, `checkIn`, `alreadyBooked`, `noSlots`, `pickDoctorFirst`, `forbidden`, `rule.*`, `seenOn`, `anchorOnLeave`…). Add ~25 new: `nav.appointmentSeat` (deleted, must return), the leave pill (`leaveOn` with {{doctor}}+{{from}} / `leaveNone`), the rebooking rail (`needRebooking`, `rebookCount_one/_other`, `wasBooked`), the slot-board band header + legend (`free`/`taken`/`yours`), the stateful commit label (`pickTimeFirst`, `bookWith` {{time}}{{doctor}}), the two book notes, today's-book counts (`checkedIn`, `toArrive`, `missed`), the `Rebook` row action, `askPlaceholder` and `agentIdle` for the dock. Reuse `registrationCounter.book.*` (15 keys: move/cancel/cancelTitle/cancelWhy/cancelReasonHint/cancelReasonRequired/cancelConfirm/cancelAbort/moving/movingHint/theirs/theirsHint/alreadyBooked/alreadyBookedHint/checkIn) rather than duplicating — Desk One's FutureTab already uses them and two copies of one sentence will drift. apps/web/src/lib/i18n.test.ts enforces hi.json mirrors en.json key-for-key, so every addition lands in both files in the same commit; it does NOT flag unused keys, which is why the orphan survived.

### Shared files this screen touches

Serialization points, every one of them a file another front-desk screen also edits — take them in ONE commit each, rebase before touching them, and never resolve a conflict with --ours: (1) apps/web/src/router.tsx — the `NAV` table (add `{ to: "/appointment", label: "nav.appointmentSeat", permission: "opd.appointments.manage", group: "desk" }`, the FD-7 T2 shape) plus a new `appointmentSeatRoute` and its entry in `rootRoute.addChildren`; /registration is being re-created in the same series and will collide here. (2) apps/web/src/locales/en.json AND hi.json — both, same commit, or i18n.test.ts fails; the whole-file JSON is a conflict magnet, so add the `appointmentSeat` keys inside the block that already exists rather than at the end. (3) apps/core/test/caddyfile-parity.test.ts:373-376 — the route count and the two `not.toContain` lines; every screen in this series moves this number, so measure it against the merged tree, never predict it. (4) apps/web/src/shell-nav.test.tsx:92 and :183 — the two "not three doors" assertions; /registration's spec will edit the neighbouring lines. (5) apps/web/src/components/agent-dock.tsx — adding the optional `action` prop for "Draft the calls" changes a component /opd/appointments and /patients/:id both mount, plus agent-dock.test.tsx; make it OPTIONAL and default-absent so those two screens are untouched. (6) apps/core/src/modules/opd/manifest.ts — the menu entry, if restored. (7) apps/web/src/lib/keyboard.tsx:123-130 + keyboard.test.tsx:99-103 — the F7 destination is global, so this is a whole-app change made from one lane. (8) apps/web/src/lib/opd-api.ts — widening `listLeaves` (:373) and adding `listNeedsRebooking`; every front-desk screen edits this file. NOT touched, and keep it that way: apps/core/scripts/seed-roles.ts and README.md (front_office already holds every permission this seat needs), apps/core/drizzle/** (no migration — every table and column exists), and apps/web/src/screens/desk-one/** (extract `History` and `slotClock` by copy-with-attribution rather than refactoring a file the /counter work is actively editing).

---

## billing — `/billing`
**Complexity:** large

### What exists today

/billing EXISTS and is wired: router.tsx:35 imports BillingCounter, router.tsx:787-796 defines the route (with validateSearch for ?encounterId, the OPD desk's hand-off), router.tsx:113 gates nav on billing.invoice.issue. The screen is apps/web/src/screens/billing-counter.tsx — 744 lines, with a 16-test suite at billing-counter.test.tsx. VERDICT: KEEP THE DATA LAYER, REWRITE THE VIEW ENTIRELY. The logic underneath is mature and hard-won and must NOT be thrown away — it already does the fee quote, the debounced server-priced preview (250 ms), integer-paise money end to end, mixed tenders, credit extension, PAN/Form-60 capture, the draft-id approval subject, the 15 s dues poll, and FD-7 T6's coupon + attribution fields. Several of its comments encode rulings paid for in review findings (the fee branch is never re-derived client-side; the server is authoritative; no client permission model). But the PRESENTATION is the wrong design system outright: 76 className sites of Tailwind/shadcn (`space-y-4 p-6`, `text-neutral-600`, `rounded border px-2 py-1`, Button/Badge from @/components/ui), and ZERO desk-one primitives — I grepped, the count of `.d1`/`.pp`-scoped classes in the file is 0. It is a three-column `grid lg:grid-cols-3` of stacked form sections; the artboard is a 290px rail + workspace + 296px scheme rail with a bill TABLE, a contest panel and three tender lanes. Nothing about the visual layer survives. This is precisely the FD-2/FD-9 situation the owner has now ruled on twice — 'all five defects were the SCREEN, not the server', and 117 testid-based tests passing over an unreadable row. So: gut the JSX, keep the hooks/queries/mutations and the wire calls, re-mount under `className=\"pp\"` following the opd-appointments.tsx:499 pattern, and add the AgentDock the file does not currently carry.

### What the artboard specifies

- LAYOUT — three columns inside a full-height flex column (min-height 980px). Header bar (card bg, 1px bottom line, padding 11px 22px): 'CRK' 700 / faint pipe / 'Billing' 600 / mono 11px '/billing'; pushed right, a `pill on` reading 'drawer open · ₹2,250 float' and a `sec` button 'Search — the cursor starts here' carrying an `Esc` keycap. Body row gap 16px, padding 18px 22px: LEFT RAIL 290px fixed, CENTER workspace flex-grow, SCHEME RAIL 296px fixed. Agent dock is a full-width dark bar pinned at the bottom.

- LEFT RAIL card 1 'Paying' (tag): name 16px/600 'Ramesh Kumar'; mono 12.5px UHID 'U00110012'; 11.5px 'male · 41y'; mono 11px faint 'V2609030004 · 03-Sep'. Below, a `--wash` block: tag 'Token', mono 30px/700 token number '7', then a `stamp` — 'UNPAID' (stamp.un, gold outline) or 'PANEL' (stamp.pd, green outline) on a corporate payer. Stamps are OUTLINED never filled (desk-one.css §3 rule).

- LEFT RAIL card 2 'On their account': mono 19px/600 '₹0.00' + 11.5px 'outstanding', then faint 11px note 'Nothing carried forward. Dues from an earlier visit would show here and travel onto this bill.'

- CENTER card 'The bill' with the subtitle that is the screen's whole thesis: 'every figure is the server's — nothing is added up on this screen'. Column head tags: Service (flex) / Qty (38px, right) / Gross (88px, right) / Benefit (88px, right) / Net (88px, right). Each line row (`.lrow`, border-top --line2): service name 13px over mono 10px faint 'SAC 999312 · exempt'; qty, gross, benefit, net all mono 12.5px right-aligned; benefit ink is green when non-zero and --faint '—' when zero; net is 600.

- CENTER 'Why this price' panel — renders ONLY when a benefit exists. Green-soft bg, green-line border. Tag 'Why this price' in green. One row per CONTESTANT: winner in green, LOSER in --faint WITH line-through, e.g. 'Sampoorna membership · 20%' −₹90.00 (green) above 'camp slip · 10% — a bigger benefit won' −₹30.00 (struck). Footer note when a membership wins: 'Best single benefit — they do not stack. The loser is shown so the clerk can answer "what about my camp slip?" without opening another screen.' Otherwise: 'One benefit applied. Anything else the patient is holding would contest here and the winner would be named.'

- CENTER net-payable row (border-top, margin-top 11px): 'Net payable' 14px/600, then faint 11px 'GST exempt · healthcare services', then mono 22px/700 amount pushed right.

- CENTER card 'Take payment' + faint subtitle 'the keys are the lanes — 1 cash, 2 UPI, 3 card'. A 3-column grid of `.lane` buttons (44px tall): keycap '1'/'2'/'3', label Cash/UPI/Card (600 when selected, 500 otherwise), and the amount mono right-aligned — the SELECTED lane shows the payable, the others show '—'. Selected lane gets `.lane.on` (green border, green-soft bg).

- CENTER tender fields — a 2-column grid: 'Tendered' and a label that CHANGES: 'Change handed back' on cash, plain 'Change' otherwise. Both `.in .mo`. On cash-with-surplus a gold banner appears: 'Whatever is not handed back stays on the patient's account as an advance. Say which — the drawer is counted on it.'

- CENTER action row: primary `.pri` 'Take ₹360.00' (the live payable interpolated into the label) carrying a transparent-bordered 'Ctrl ⏎' keycap; secondary `.sec` 'Bill to account'; right-aligned faint note 'prints the receipt and stamps the token PAID'.

- SCHEME RAIL header: tag 'Schemes' + faint 'attach before you take the money'. Five cards, each a full `.box` BUTTON (clickable to toggle): icon in the card's ink colour, name 12.5px/600, a state `pill` pushed right, an 11px --dim detail line, and — only when applied — a mono 12.5px/600 GREEN effect line. Order is fixed: Membership, Coupon, Package, Corporate / TPA, Channel partner.

- SCHEME CARD copy, exactly: Membership — state 'applied' | 'card on file', detail 'Sampoorna · valid to 31-Mar-27 · holder Ramesh Kumar', effect '−₹90.00 on this bill'. Coupon — state 'applied' | '1 presented', detail 'HEALTH-CAMP-09 · village camp, 28-Aug · one visit', effect '−₹30.00 on the consult'. Package — state 'none', detail 'no bundle running for this patient', effect 'consult drawn from the bundle'. Corporate / TPA — state 'panel payer' | 'self-pay', detail 'East Central Railway · employee 41129 · pre-auth not needed under ₹5,000', effect 'nothing to collect at this counter'. Channel partner — state 'attributed' (always `pill gd`, gold — it is never a toggle), detail 'Dr Ashok clinic, Mahnar · slip MHN-2209 · commission accrues on settlement', NO effect line.

- SCHEME RAIL footer note: 'Only the best single benefit applies — they do not stack. The contest is shown on the bill so the clerk can say why, and the loser is named rather than hidden.'

- THE NUMBERS the artboard is built on: OPD Consultation (New) gross ₹300.00, Dressing small gross ₹150.00, both SAC 999312 exempt. Membership = 20% OPD → −₹90 (fee −₹60, proc −₹30), payable ₹360.00. Coupon = 10% consult only → −₹30, payable ₹420.00. Package = consult drawn down → −₹300, payable ₹150.00, balance reads 'consult 3 of 8'. Corporate = panel pays in full → −₹450, payable ₹0.00 and the stamp flips to PANEL. Cash lane tenders ₹500.00 → change ₹50.00 and the gold advance banner appears; UPI/card tender exactly the payable and show no banner.

- AGENT DOCK (dark, --agent bg): 'Assistant' chip, then the tick text — membership case: 'Their membership beats the camp slip by ₹60. Both are on file; only the better one is applied.'; corporate case: 'This patient is on the Railway panel — nothing is collected here, and the claim is raised at close.' A mint `.agdo` button 'Apply it' pushed right, then an `F2` dark keycap + 'pull up'.

- STATE MATRIX the artboard enumerates via its two props: scheme ∈ {none, membership, coupon, package, corporate} × lane ∈ {cash, upi, card}. 'none' shows no 'Why this price' panel at all and every Benefit cell reads '—'. 'corporate' is the special one: payable ₹0.00, stamp PANEL, tendered '—', no change, no surplus banner.

### Server endpoints

**Existing:**
- `POST /billing/invoices/preview — billing.invoice.issue — apps/core/src/modules/billing/billing.controller.ts:490. Returns PricedDraft + balances[]. THIS ONE ENDPOINT SERVES THE WHOLE BILL TABLE AND THE CONTEST: WirePricedLine carries qty/grossPaise/discountPaise/netPaise, gst.sacCode + gst.exempt (the 'SAC 999312 · exempt' line), and — critically — candidates[] AND winner (lib/billing-api.ts:49-70). The 'Why this price' loser is candidates.filter(c => c !== winner && c.rejected === null); a candidate with rejected != null is a DIFFERENT thing (over_cap / unknown_category) and must not be drawn as a losing contestant.`
- `POST /billing/invoices — billing.invoice.issue — billing.controller.ts:468. Issue + receipt + credit in one call. Body already carries couponCodes[], attributionCode, receipt.tenders[], receipt.changeGivenPaise, credit{reason,approvalId}, discountApprovals. Result carries unallocatedPaise — that is the artboard's 'stays on the patient's account as an advance' lane, and it is never an error.`
- `GET /billing/worklist?serviceDate — billing.invoice.read — billing.controller.ts:508. THE CASHIER'S FRONT DOOR and the source for the 'Paying' rail. CollectionRow (worklist.ts:32-44) = {encounterId, visitNo, patientId, patientName, uhid, isConfidential, tokenNo, departmentId, doctorId, serviceDate}. It carries the TOKEN NUMBER, so the rail's token block needs no OPD call. Lists unsettled visits only.`
- `GET /billing/patients/:patientId/balance — billing.invoice.read — billing.controller.ts:728. Returns {patientId, advancePaise, outstandingPaise, dues[]} (receipts.ts:915). This is exactly the 'On their account · ₹0.00 outstanding' card, and advancePaise is what the surplus banner is promising.`
- `GET /billing/patients/:patientId/dues — billing.invoice.read — billing.controller.ts:738.`
- `GET /billing/visits/:encounterId/fee-quote — billing.invoice.read — billing.controller.ts:606. Carries free + freeReason, attributionCode (pre-fills the partner slip), and intendedPayer ('self'|'tpa'|'pmjay'|'corporate') — the ONLY signal that drives the Corporate/TPA card's 'panel payer' vs 'self-pay' state and the PANEL stamp.`
- `GET /billing/invoices/:id/print — billing.invoice.read — billing.controller.ts:538. Receipt print after settle; its WireBillingPatient is the only billing-permission surface carrying administrativeGender + dob, and only AFTER the invoice exists.`
- `GET /billing/sessions/current — billing.session.own — billing.controller.ts:855. The header's 'drawer open · ₹2,250 float' pill. Already wrapped as fetchCurrentSession() in lib/billing-api.ts:346.`
- `POST /billing/receipts — billing.receipt.record — billing.controller.ts:626 (standalone receipt / advance).`
- `GET /membership/recognition?patientId=&codes= — membership.instrument.recognise — membership.controller.ts:259. SERVES THE MEMBERSHIP AND COUPON SCHEME CARDS. WireRecognition (lib/membership-api.ts) = memberships[]{planTitle, cardCode, status, origin, verified, usable, validFrom, validTo, queuePerk, benefits[]} + coupons[]{code, title, unusableReason} + disclosure. 'Sampoorna · valid to 31-Mar-27' is planTitle + validTo. unusableReason is a NAMED union (retired|not_yet_valid|expired|off_weekday|outside_window|min_bill_not_met) — that is how a coupon fails visibly. `disclosure` MUST be rendered verbatim as a string, never a locale key (E-32).`
- `GET /membership/instruments/lookup?q= — membership.instrument.read — membership.controller.ts:162. Rate-limited and audited; sets Retry-After and throws 429 lookup_rate_limited. Only needed if the clerk types a card code the patient is not linked to.`
- `POST /membership/grace-honor — membership.grace_honor.request — membership.controller.ts:284. Honour a lapsed card at the counter.`
- `GET /partners/attributions/:code — partners.receivable.operate — partners.controller.ts:148. The Channel-partner card's detail ('Dr Ashok clinic, Mahnar · slip MHN-2209'). EXISTS, but see risks: neither `cashier` nor `front_office` holds partners.receivable.operate, so this 403s for the seat as seeded today.`
- `GET /opd/visits/:id/counter-state — opd.visits.open — opd-visits.controller.ts:404. {status, serviceDate, feeStatus: 'free'|'settled'|'credit'|'unsettled', everJoined, tokenNo} (encounters.ts:826-834). PHI-free and cheap — the correct poll for flipping the token stamp UNPAID→PAID. Needs opd.visits.open, which `front_office` holds and `cashier` does not.`
- `GET /tariff/services — tariff.read — tariff.controller.ts:145. The service picker that lets the clerk add the artboard's 'Dressing, small' line. See risks: tariff.read is held ONLY by doctor, owner and tariff_editor.`
- `GET /patients/search and GET /patients/:id — patients.read — patients.controller.ts:306 / :422. The only pre-invoice source of 'male · 41y'.`

**Claimed missing (VERIFY — the critic corrected several):**
- `GET /billing/payers/:encounterId (or an object grafted onto the fee-quote response) — THE CORPORATE / TPA PANEL DETAIL. Verified absent: `intendedPayer` is a bare string column read straight off the encounter (invoices.ts:332-358) and nothing anywhere returns the panel's NAME, the employee/member number, or a pre-auth threshold. I grepped every *.controller.ts in all 14 modules for payer|panel|tpa|corporate — the only hit is POST /ot/encounters/:encounterId/payer-class, which SETS a class and returns no directory. So the artboard's 'East Central Railway · employee 41129 · pre-auth not needed under ₹5,000' cannot be rendered at all. Without it the Corporate card can honestly show only 'panel payer' / 'self-pay' + 'nothing to collect at this counter'. Either build this or cut that detail line from the card — do not invent a panel name client-side.`
- `GET /billing/patients/:patientId/summary — an alias-safe {uhid, name|alias, restricted, administrativeGender, dob} readable under billing.invoice.read. The 'Paying' rail's 'male · 41y' has NO source a pure `cashier` can call: CollectionRow (worklist.ts:32-44) has no dob/gender, PatientBalance (receipts.ts:915) has none, and the only surface that carries administrativeGender+dob is GET /billing/invoices/:id/print — which requires the invoice to already exist, i.e. after the money is taken. billing.controller.ts:503-507 states the constraint in the codebase's own words: the cashier 'holds no patients.read'. CONDITIONAL: if the seat is granted front_office alongside cashier, GET /patients/:id covers this and nothing new is needed — decide the role question first, because it decides whether this endpoint is real work.`

### Reuse, do not reinvent

- apps/web/src/components/agent-dock.tsx — AgentDock + the `logged` helper and the AgentLine type. MANDATORY on this screen. It already binds F2 itself (agent-dock.tsx:63-70), so do NOT bind F2 again in the screen or the two handlers will both fire. It renders its own dark bar and is the artboard's bottom dock verbatim.

- apps/web/src/lib/billing-api.ts — the ENTIRE wire contract already exists and needs no new types for the bill or the contest: WireAdjustmentCandidate (:49), WirePricedLine (:59, with candidates/winner/gst.sacCode), WireBenefitBalance (:73), WireFeeQuote (:88), WireIssueInvoiceBody (:127), previewInvoice (:287), issueInvoice (:295), fetchFeeQuote (:272), listDues (:306), fetchCurrentSession (:346), fmtPaise. Reuse it wholesale; do not restate money types in the screen.

- apps/web/src/lib/membership-api.ts — fetchRecognition({patientId, codes}) + WireRecognition/WireRecognisedMembership/WireRecognisedCoupon. Drives the Membership and Coupon scheme cards including unusableReason and the mandatory `disclosure` string.

- apps/web/src/screens/desk-one/desk-one.css — THE DESIGN SYSTEM. Every artboard class already exists here scoped to BOTH `.d1` and `.pp`: .mo .tag .kb .kb.dk .pri .sec .box .in .pill(.on/.gd/.rd) .stamp(.un/.pd) .agchip .agdo .drow. The artboard's inline <style> block is a verbatim copy of these rules — do not re-declare them in the screen.

- apps/web/src/screens/opd-appointments.tsx:499 — THE TEMPLATE for an in-shell paper-pine screen: `<div className="pp" style={{display:'flex',flexDirection:'column',minHeight:'calc(100vh - 96px)'}}>` with AgentDock as the last child. Copy this shell exactly; /billing lives INSIDE the app shell and must NOT wear `.d1` (desk-one.css:38 makes .d1 `position:fixed; inset:0`, which would cover the topbar).

- apps/web/src/screens/desk-one/stages.tsx:2251-2360 — the existing recognition-driven scheme panel (memberships, coupons, usable/unusableReason, the disclosure line). The closest working precedent for the scheme rail's semantics; port the logic, restyle to the card layout.

- apps/web/src/components/money-input.tsx and components/tender-editor.tsx — integer-paise inputs for Tendered/Change. They already yield integers; the K38 rule (money is integer paise end to end, no float on the path) depends on using them rather than parseFloat.

- apps/web/src/components/invoice-print.tsx — the receipt the 'Take payment' button prints ('prints the receipt and stamps the token PAID').

- apps/web/src/components/patient-picker.tsx — the existing search box, ONLY if the seat holds patients.read. If the seat is cashier-only, the header search must instead read GET /billing/worklist and this component cannot be used.

- apps/web/src/components/submit-button.tsx — in-flight/disabled handling for the irreversible Ctrl+Enter commit.

- apps/web/src/lib/keyboard.tsx — BROWSER_FREE_FUNCTION_KEYS (:44) and isTypingTarget(). Use isTypingTarget to gate the bare 1/2/3 lane keys; the Keymap's law is that bare digits act ONLY when the cursor is not in a field.

### Permissions

- billing.invoice.issue — gates POST /billing/invoices AND POST /billing/invoices/preview, and is the nav gate on router.tsx:113. Held by `cashier`.

- billing.invoice.read — gates the worklist, the balance/dues cards, the fee quote and the receipt print. Held by `cashier`.

- billing.receipt.record — POST /billing/receipts. Held by `cashier`.

- billing.credit.extend — the 'Bill to account' button. Held by `cashier` (seed-roles.ts:376).

- billing.session.own — GET /billing/sessions/current, the drawer/float pill. Held by `cashier`.

- membership.instrument.recognise — GET /membership/recognition, the Membership + Coupon cards. Held by `cashier` AND `front_office` (seed-roles.ts:384, :100).

- membership.instrument.read — GET /membership/instruments/lookup. Held by both.

- membership.grace_honor.request — held by both; approving a grace honor is billing_manager and deliberately NOT this seat.

- opd.visits.open — REQUIRED for GET /opd/visits/:id/counter-state (the token stamp poll). Held by `front_office`, NOT by `cashier`.

- patients.read — REQUIRED for /patients/search and /patients/:id (the 'male · 41y' line). Held by `front_office`, NOT by `cashier` — billing.controller.ts:503-507 says so explicitly.

- tariff.read — REQUIRED for GET /tariff/services (adding the 'Dressing, small' line). Held ONLY by `doctor`, `owner`, `tariff_editor` (seed-roles.ts:208/:522/:662). Held by NEITHER `cashier` NOR `front_office`.

- partners.receivable.operate — REQUIRED for GET /partners/attributions/:code (the Channel-partner card detail). Held by neither front-desk role.

- NOT this seat: billing.allocation.reverse, billing.eie.mark, billing.reports.read, billing.config.write, membership.instrument.enrol (front_office_supervisor, and gated behind MEMBERSHIP_SALES_ENABLED).

### Keyboard

- Esc — return the cursor to the header search box; pressed a second time, clear the desk (release the patient, drop the draft). The artboard draws this keycap in the header, so it must be bound or the keycap lies.

- Tab / Shift+Tab — THE primary instrument. Keymap fixes the /billing order exactly: 1 Search (focused on arrival) → 2 Scheme rail → 3 Tender lane → 4 Tendered → 5 Change handed back (cash only) → 6 Take the payment. The Change field must leave and re-enter the tab order with the cash lane; Tab must never stop at a field that is not on screen.

- 1 / 2 / 3 — select the Cash / UPI / Card tender lane. BARE digits, and they must act ONLY when the cursor is not in a field — gate on isTypingTarget() from lib/keyboard.tsx, or a phone number becomes a tender lane. Ctrl+1..9 is browser tab-switching and is unavailable at any price.

- Ctrl+Enter — commit: take the money. A chord because it is the irreversible one. The artboard prints this keycap inside the primary button.

- Enter — do the obvious next thing (select the highlighted search hit, accept the lane, advance) — never the settle itself.

- F8 — take payment. Keymap law: 'a key means one thing everywhere — F8 takes payment on every seat that can take payment.' lib/keyboard.tsx:149-154 records that F8 and F9 are deliberately UNBOUND globally because they are seat actions nothing implemented yet; THIS is the seat that implements them, so bind F8 locally here and update that comment rather than leaving it stale.

- F9 — reprint the last document (the receipt just printed). Same reservation as F8; bind locally.

- F2 — the assistant. DO NOT bind this in the screen: components/agent-dock.tsx:63-70 already binds F2 to focus its ask box, and a second window-level handler would double-fire. Mounting AgentDock is what makes the artboard's F2 keycap true.

- Up / Down — move through the search-hit list.

- DELIBERATELY NOT BOUND: Ctrl+K and Ctrl+N (Chrome owns both; Ctrl+N is on the non-overridable list and never reaches the page), and F1/F3/F5/F6/F10/F11/F12. F4 (new patient) and F7 (the book) stay GLOBAL in lib/keyboard.tsx — do not re-bind them locally.

### Risks

- THE SCHEME RAIL IS DEAD BY DEFAULT. apps/core/src/modules/billing/invoices.ts:414 — `MEMBER_BENEFITS_ENABLED` parses with `.default("false")`, and I found the variable set in NO .env anywhere in the tree. invoices.ts:558 then computes `benefitsApply = memberBenefitsEnabled() && encounter.intendedPayer === 'self'`. So with stock config every Benefit column reads '—', the 'Why this price' panel never renders, and the entire right-hand rail — the artboard's centrepiece — prices nothing. The screen will look finished and be inert. Set the flag in the dev/preview env BEFORE building, and make at least one test assert the flag-off branch renders honestly rather than silently blank.

- A MISTYPED COUPON VANISHES WITHOUT A WORD. apps/core/src/modules/billing/invoices.ts:499 — `if (found.memberships.length === 0 && found.coupons.length === 0) return { ctx: withRegistered(ctx), benefits: null }`. An unknown coupon code resolves to nothing, so preview returns no candidate, no rejection and no error: the clerk types HEALTH-CAMP-O9, sees the same total, and has no way to learn why. billing-counter.tsx:110-120's own comment claims 'a coupon that fails its rule must fail visibly (the server names the rule)' — that claim is false on this path. THE FIX IS CLIENT-SIDE AND CHEAP: call GET /membership/recognition with the same codes and render `coupons[].unusableReason`, and treat a code that comes back in neither coupons[] nor any candidate as 'not recognised'. Do not rely on preview to report it.

- THE SEAT AS SEEDED CANNOT SERVE ITS OWN ARTBOARD. `cashier` (seed-roles.ts:373-390) holds billing.* + membership.* and NOTHING else — no patients.read, no opd.visits.open, no tariff.read. `front_office` (seed-roles.ts:86-105) holds patients/opd/membership and NO billing.*. Consequences, each concrete: GET /tariff/services 403s for BOTH roles (tariff.controller.ts:145 requires tariff.read, held only by doctor/owner/tariff_editor) so the clerk cannot add the artboard's 'Dressing, small' line at all — and billing-counter.tsx already calls listServices() unconditionally, meaning this is a live defect on the shipped screen today, not a new one. GET /partners/attributions/:code 403s for both (partners.controller.ts:148 requires partners.receivable.operate) so the Channel-partner card has no detail. GET /opd/visits/:id/counter-state 403s for cashier. Decide the role composition FIRST — it changes which of the two 'missing' endpoints is real work — and if a grant is made, seed-roles.ts and test/seed-roles.test.ts (which pins permission counts) both move.

- `.pp` STYLING RESTS ON AN UNDECLARED IMPORT. apps/web/src/screens/desk-one/desk-one.tsx:28 is the ONLY `import "./desk-one.css"` in the tree, yet opd-appointments.tsx:499 and patient-detail.tsx wear `className="pp"` and import no CSS at all — I checked, they have zero css imports. It works solely because router.tsx imports every screen statically (no lazy(), no dynamic import()), so desk-one.css always lands in the bundle. The moment anyone code-splits DeskOne, /billing and both FD-23 screens lose every border, pill and stamp at once, with no error. Import desk-one.css explicitly from the billing screen rather than inheriting this.

- TWO ARTBOARD PRIMITIVES DO NOT EXIST YET. The artboard uses `.lane` (44px selectable tender button, plus `.lane.on`) and `.lrow` (the bill line row: padding 9px 0, border-top --line2). Neither is in desk-one.css — I listed every selector; `.drow` is close to `.lrow` but has padding 9px 12px AND a hover background, which is wrong for a static bill line. Add both to desk-one.css under BOTH the `.d1` and `.pp` scopes, matching the file's own convention (desk-one.css:26-35 argues explicitly against duplicating rules into a second file). This makes desk-one.css a shared-file edit.

- REWRITING THE VIEW WILL SILENTLY BREAK 16 TESTS. apps/web/src/screens/billing-counter.test.tsx asserts against data-testids and Tailwind-era DOM: `dues-sidebar`, `counter-balances`, `balance-<key>`, `balance-left-<key>`, `line-row-<id>`, `fee-amount`, `fee-free`, `issued-invoice-no`, `unallocated-banner`, `warning-<w>`. Carry every one of these testids onto the new markup or rewrite the assertions deliberately — do not discover them one red run at a time. Note also billing-counter.tsx:36-38's rule that this screen OWNS the 15 s polling convention's teeth: its dues poll is the one place the fake-timer re-fetch assertion lives, so the redesign must keep a 15 s interval on the dues/balance read or that guard evaporates.

- 'CHANGE HANDED BACK' IS A LEDGER FIELD, NOT A DISPLAY. WireIssueInvoiceBody.receipt.changeGivenPaise (lib/billing-api.ts:141-143) exists precisely because RC-1 T1 found the counter spreading it in as an excess property that the controller's zod silently stripped — the money disagreed. The artboard's gold banner ('Whatever is not handed back stays on the patient's account as an advance. Say which — the drawer is counted on it.') is the UI for that field. If the redesign renders the input but does not send changeGivenPaise, the surplus banks as an advance the drawer was never told about and the cash count fails at close. Assert the ISSUED AMOUNT in the test, never the intermediate field — that is the exact FD-7 CRITICAL ('a balance is not a cap': the value lane discounted nothing because an over-cap ask is rejected, not clamped).

- THE CORPORATE BRANCH INVERTS THE WHOLE SCREEN AND HAS THE THINNEST DATA. On intendedPayer != 'self': payable is ₹0.00, the stamp is PANEL not UNPAID, tendered shows '—', no lane may be selected, no change, no surplus banner — AND invoices.ts:558 stops member/coupon/referral benefits entirely, so the other four scheme cards must visibly explain their own absence rather than just render empty. Meanwhile the panel's name and employee number have no endpoint at all. This is the state most likely to ship half-built.

- A CONFIDENTIAL PATIENT MUST NOT BE NAMED. CollectionRow carries `isConfidential` (worklist.ts:36) and DueRow carries `restricted` with `name: null` + `alias` (receipts.ts:836-843). The 'Paying' rail renders a 16px name in the largest type on the screen; bind it to alias-when-restricted or this becomes a PHI leak on the most-read element. Plan 07a closed exactly this class of leak on four routes.

- NO OPEN DRAWER = NO CASH. sessions.ts:60 throws BillingError('no_open_session') when the acting cashier has none. The artboard only ever draws the happy 'drawer open · ₹2,250 float' pill and specifies no closed state. Design the refusal inline at the action (FD-22's rule: refusals land where the action was, never at the top) — and note the cash-law gate too (cash-law.ts:23-60): cash tenders can come back `pan_required` above the PAN threshold or `cash_threshold_blocked` at the block threshold, both with a CashThresholdDetail the clerk needs to read. billing-counter.tsx already has panRequired/form60 state for this; do not drop it in the rewrite.

- THE HEADER SEARCH HAS TWO POSSIBLE SOURCES AND THEY BEHAVE DIFFERENTLY. If the seat holds patients.read, PatientPicker over /patients/search finds anyone. If it does not, the only door is GET /billing/worklist, which lists TODAY'S UNSETTLED VISITS ONLY (worklist.ts:46-53 — free, settled and credit are deliberately excluded so the cashier never calls someone who has already paid). Those are different products: the second cannot find a patient who wants to pay an old due. Pick one knowingly.

- TEST-GREEN IS NOT SCREEN-CORRECT ON THIS LANE. FD-2's finding was that 117 testid-based tests passed over an unreadable search row, and FD-9 found three money/data defects that only a live browser caught while every suite stayed green. Drive this one in the real browser (playwright chromium + the hmis_fd_dev preview on :8443, per the FD-7 preview notes) with MEMBER_BENEFITS_ENABLED on and the demo package/coupon/partner data on Ramesh Kumar U00110012, and step all five scheme states × three lanes before calling it done.

### Locale

Namespace `billing.counter.*` in apps/web/src/locales/en.json AND hi.json. 36 keys exist there today (84 under `billing.*`, 2657 total in en.json). The redesign needs roughly 60–75 new keys and can retire perhaps 15 of the existing ones: column heads (5), the two subtitle theses ('every figure is the server's…', 'the keys are the lanes…'), rail labels (Paying / Token / On their account / outstanding + the carried-forward note), the 'Why this price' tag and its TWO alternative footer notes, 'Net payable' + 'GST exempt · healthcare services', three lane names, 'Tendered' + the two change labels, the surplus advance banner, 'Take {{amount}}' + 'Bill to account' + 'prints the receipt and stamps the token PAID', the Schemes tag + 'attach before you take the money' + the five card names + their state pills (applied / card on file / 1 presented / none / panel payer / self-pay / attributed) + the do-not-stack footer, the stamps (UNPAID / PAID / PANEL), the drawer pill, the agent idle/placeholder/tick strings, and one message per membership status and per coupon unusableReason value (6 reasons × 1 sentence — the wire sends a union member, the screen must not print the raw enum). CRITICAL: apps/web/src/lib/i18n.test.ts:11-12 asserts hi.json mirrors en.json key-for-key, so every key lands in BOTH files in the same commit or web tests go red. Note the two strings that must NOT become locale keys: the server's `disclosure` from GET /membership/recognition (E-32 — rendered verbatim as sent) and any server error message, which arrives already-worded on the ratified {statusCode,message,code,detail} body.

### Shared files this screen touches

SERIALIZE ON THESE — every one is a file another front-desk screen in this series also edits: (1) apps/web/src/locales/en.json AND hi.json — ~60-75 new billing.counter.* keys; apps/web/src/lib/i18n.test.ts:11-12 pins the two files key-for-key, so a partial landing reddens web tests for EVERY lane, and two lanes appending keys in the same region will conflict on every rebase. Land both files in one commit. (2) apps/web/src/screens/desk-one/desk-one.css — the new `.lane` and `.lrow` primitives must go here under both `.d1` and `.pp`, per the file's own no-second-file argument (desk-one.css:26-35). This file is the Desk One / RC lane's home; coordinate before editing, and add rules only, never restyle an existing primitive. (3) apps/core/scripts/seed-roles.ts + apps/core/test/seed-roles.test.ts — ONLY if the tariff.read / partners.receivable.operate / patients.read grants are made; the test pins permission counts, so both move together and every other lane's core suite sees it. (4) apps/web/src/lib/billing-api.ts — shared by billing-counter, billing-dues, billing-session, billing-office AND desk-one.tsx:12; additive types only, and a signature change there breaks Desk One. LOW RISK BUT NON-ZERO: (5) apps/web/src/router.tsx — /billing already exists (router.tsx:787-796) and the redesign should need NO route change; touch it only if the nav label or staticData changes, and never reformat it. (6) apps/core/test/caddyfile-parity.test.ts:373 pins `expect(routes).toHaveLength(48)` — a REDESIGN IN PLACE must leave this untouched. If you find yourself editing this number you have added a route and should stop: FD-9's whole ruling was that three front-desk routes collapse into one, and /billing/dues, /billing/session, /billing/office already exist for everything that is not the counter. SAFE TO OWN ALONE: apps/web/src/screens/billing-counter.tsx and billing-counter.test.tsx, plus components/agent-dock.tsx (additive props only — opd-appointments.tsx and patient-detail.tsx both mount it).

---

## Vitals — Bay One — `/opd/vitals`
**Complexity:** large

### What exists today

A large, working Bay One already serves this route and it is NOT a throwaway — but its SCREEN must be rewritten. `apps/web/src/screens/vitals-bay.tsx` (503 lines) + `vitals-bay-capture.tsx` (613) + `vitals-bay-protocol.tsx` (204) + `vitals-bay-amend.tsx` (208) are wired end-to-end to the real server: bench polling with realtime invalidation, pre-stage, the three identify doors, server-driven ranges/gates, the danger protocol with the 10-second cancel, rest-and-recheck, chips, the lane toggle, the keystroke counter, the amend trail and the bold-✓ banner. 49 tests across five suites cover it and they assert SEMANTIC testids (`tile-bp`, `input-bp`, `chip-fasting`, `bench-row-118`, `mirror-retake`), so most survive a re-skin. KEEP the logic, the hooks and the exported helpers wholesale. What must go is the presentation and the shell: the file speaks Tailwind/shadcn (`rounded border border-border px-2 py-1 text-muted-foreground`, `vitals-bay.tsx:441` down), it is a two-column `flex lg:flex-row` with the bench on the LEFT — not the artboard's session|stage|bench triptych — the header has none of the artboard's furniture (no clock, no device strip, no command surface, keysPill exiled to a footer at `vitals-bay.tsx:495`), the tiles are a generic bordered grid with no big value, no source pill, no delta, no ✎ and no range label (`vitals-bay-capture.tsx:474-539`), and there is NO agent dock at all. This is the exact FD-2/FD-9 shape the owner has now called out twice: the server was right, the screen was the defect. Treat it as a re-skin plus five unwired features, not a rewrite: budget the risk in the assembly (`vitals-bay.tsx`), which is where every CRITICAL in RC-3, RC-4 and FD-9 was found.

### What the artboard specifies

- LAYOUT (docs/design/2026-08-31-vitals-desk/bay-one.html — body is JS-generated; the structural HTML sits between </style> and <script>). Four regions, full viewport, `height:100vh; display:flex; flex-direction:column`: header 46px | body flex | agent dock 54px. Body is three columns: `aside#session` 294px fixed, border-right; `main#stage` flex-grow, `padding:22px 28px 30px`; `aside#bench` 238px fixed, border-left. Each column scrolls independently (`overflow-y:auto`). Desk One's `.d1 .frame` pins `min-width:1220px` — the same floor applies here.

- HEADER (left→right): a 10px green ring + `BAY ONE` in mono 12.5px letterspaced .08em; `/`; "Vitals · Bay 01 · **Sister Kavita Kisku** · 08:00–14:00"; `#devstrip` (serial-lane pill, then one pill per device when serial is ON); spacer; keysPill "{n} keys · {n} device reads" (title: "the zero-typing proof"); clock "MON 31 AUG · 09:52"; valvePill "bench {n} · Dr. Rao callable {n}" (gold, title: "this bench is the doctors' wait time"); buttons `₹ devices`, `design schema`, `⌘ command  Ctrl K`.

- AGENT DOCK (bottom, pine #132420 on #d9efe4): pulsing mint dot, `bay agent` tag, a one-line ticker showing the newest log entry as "HH:MM  text", a 360px ask form (placeholder "ask — “bump kyon hua?” · “muac kya hai?”", keycap F2), and a `▲ LOG` / `▼ HIDE` toggle opening a max-height 250px drawer. Log lines are `{time} {dot} {text}` with four kinds colouring the dot: ok=mint, warn=gold, you=white, did=agent-dim. Drawer footer: "every unlock, override and auto-bump lands here, timestamped — undo where reversible".

- STAGE STATE 1 — IDENTIFY (no patient). H1 "Who sits on the stool?"; sub "Three doors, one lane (owner ruling): the barcode is fastest — a typed token number or UHID starts exactly the same session."; a dashed-green 2px barcode button "scan the token slip [S]" / "no typing, no asking a feverish person to spell their name"; a 46px mono input placeholder "…or type token no. / UHID — 121 · UH-23-04417 · ⏎ starts the same lane"; a `pre-staged — before they reach the stool` card (token, name·ageSex, the staging sentence); one agent card per resting patient with a `recall` action; a `walk a story` pill row.

- STAGE STATE 2 — CAPTURE. Title flips with the lane: serial ON = "Measure — the screen types for you" / "[Space] fires the next device · numbers land themselves"; serial OFF = "Type fast — ⏎ commits and jumps" / "[1–8] jump to a field · the gates catch the slips, not you". Primary button right-aligned: "save → next [Ctrl ⏎]" (or "save amendment"), opacity .55 while anything required is missing. Below: a 4-column tile grid, gap 11px.

- TILES (8, order fixed by `tileDefs()`): HEIGHT (LENGTH for a child) cm · WEIGHT kg · [MUAC cm, child only] · BLOOD PRESSURE mmHg · PULSE /min ("rides the cuff — one capture, two vitals") · SpO₂ % · TEMP °C · RESP RATE /min. Each tile: uppercase label tinted by level, the band range in mono top-right, a big value, a source pill `AUTO`/`TYPED`/`RODE THE CUFF`, a `✎` re-enter button, and a delta line "Jun 132/84 → +26/+12" (gold when |Δsys|>15 or |Δdia|>10). Weight carries "🔇 never said aloud — it's on the slip".

- BANDS AND REQUIRED SETS. Adult required = wt, bp, pulse, spo2, temp. Child 1–5 required = wt, temp, pulse, spo2, muac (BP "not routine under 5 — capture only when the doctor asks", with a "capture anyway — logs why" escape that logs the decision). Emergency (esc≥2) trims to bp, pulse, spo2 — "a crashing patient is not a form". Band pill reads "CHILD 1–5 · small cuff · MUAC due".

- RANGES AS DRAWN (reference only — the shipped screen must render `preStage.ranges`, which the server sends). Adult: sbp 90–140 (danger ≤80 / ≥180), dbp 60–90 (≤40/≥120), pulse 60–100 (≤45/≥130), SpO₂ 94–100 (≤90), temp 36.1–37.3 (≤35/≥39.5), RR 12–20 (≤8/≥30). Child: sbp 80–110 (≤70/≥140), dbp 50–75, pulse 80–140, temp 36.1–37.5, RR 20–30. MUAC: <11.5 SAM ("its own emergency lane"), <12.5 MAM ("nutrition counter flagged"), else green ≥12.5.

- THREE SANITY GATES, each a card with the offending number in 20px mono. probe: SpO₂ <75 → "A talking patient at {v}% is a probe problem until proven otherwise." … "The {v} stays in the log, never on the chart, unless it repeats." [re-clip & retake]. digit: adult weight <25 kg → "{v} kg on a {age}-year-old — a slipped digit? One keystroke away from a chart fact and a wrong drug dose downstream." [it's {v*10} kg] [it's real — flag it hard]. shrink: |Δheight| ≥3 cm → "{last} cm in {month} → {v} now." … "Heels together, head level, re-measure once." [re-measured — it holds] [go back].

- DANGER PROTOCOL, the one place the agent acts alone. ONE danger BP → recheck demanded NOW, other arm: "{s}/{d} is stroke territory — machine or man? … This is not a rest-and-recheck number; rest is for maybes." TWO confirmed → queue class → 0, doctor flashed, ECG room told, wheelchair called, and a **10-second CANCEL** window (owner ruling 31-Aug) rendered as a live countdown in two places (`CANCEL · {n}s` button and the `was {cls} · agent · CANCEL {n}s` pill). The artboard's tick handler deliberately updates ONLY the countdown text — "a full repaint would wipe whatever is mid-typed". After the window: "cancel window closed — class 0 stands. Reversing now is a supervisor action, not a keystroke." Emergency strip copy: "Do not let him walk alone. Height and weight can wait — this man is not a form."

- REST AND RECHECK: elevated-but-not-dangerous first BP with a history to compare against → "Stairs, chai, a missed morning dose — half of these settle in five minutes. Ask the chips on the left, then rest her." Actions [rest 5 min · recheck [R]] and a ghost [keep it — my call] which logs "your call, logged with your name on it". REST_MINUTES = 5. Both readings are always kept as a PAIR — "never averaged, never overwritten".

- SESSION COLUMN (left, per patient): initials avatar 44px, name, `{age}{sex} · {uhid}`, token in 21px mono, class pill (0 EMERGENCY / 1 urgent / 2 booked / 3 walk-in / 4 review), the visit reason, band pill, `ask these — one tap` chips each with ✓/✗/? buttons, `+ allergy heard at the bench`, `last visit · {date}` mono block, an optional `say this` card (Devanagari, white-on-pine), `this patient` counters (device reads / typed keys), and `clear desk [Esc]`. Empty state carries the shift figures (through the bay 40, avg per patient 1m 41s, rechecks caught 3, typed keystrokes 112), the key legend, and "dignity, standing — This screen faces you. The patient display shows a token and a direction — never a weight, never a number."

- BENCH RAIL (right, `always in sight — timers die in drawers`). Six row states: `next` (green, carries the staging sentence), `waiting`, `resting · recall {HH:MM}` + ` · DUE` once past, `stepped out — turn held`, `on the stool`, and `✓ with doctor · tap to amend`. Footer: "**The valve:** Dr. Rao has 1 callable patient left. Every minute here is a minute a doctor waits downstream."

- AMEND: tapping a ✓ row re-opens the saved chart. Banner copy: "**Amending a saved chart** — owner ruling: a wrong save is fixable at this desk. Press ✎ on any value; the old number stays in the trail with your name and the clock, and the doctor's board refreshes on save. Esc abandons it untouched."

- SAVE CONFIRMATION (owner ruling 6, the "bold ✓"): a 46px green disc with a heavy ✓, "{token} {name} — SAVED & SENT to {doctor}", sub "went NOW as class 0, with an escort · on the doctor's board at {time} — the bench row wears the same tick". Incomplete save: "**The doctor can't be handed a half-chart.** Still owed: {LIST} — the band decides what's required, not habit."

- FOUR UNLOCK REASONS for a carried-forward height, exactly: "yearly re-measure due", "patient disputes the old value", "posture / device changed", "surgical or limb change". Locked tile shows the carried value greyed with "cm · carried {date}" and a padlock button "locked — unlock needs a reason".

- PALETTE (identical to Desk One, already published): paper #f4f7f4, card #ffffff, ink #132420, line #dfe7e1, line2 #ecf1ed, dim #5c6f66, faint #8ea69a, wash #eef3ef, green #0e6b4e, gold #dd8f1c, red #b23a30, agent #132420, agent-fg #d9efe4, mint #35c48f. Type: IBM Plex Sans 13.5/19, Plex Mono for every number, Plex Sans Devanagari for the say-this lines.

- TWO OVERLAYS THAT ARE DESIGN ARTEFACTS, NOT FEATURES: `₹ devices` is an owner procurement table (manual ≈₹16,110/bay vs serial ≈₹70,960, Δ ₹54,850) and `design schema` is the rationale sheet. Neither belongs in the shipped screen; the schema sheet is the authority for the DECIDED/RULED list and should be read, not built.

### Server endpoints

**Existing:**
- `GET /opd/bench?doctorId&serviceDate — opd-visits.controller.ts:504, opd.queue.read (returns tokenNo, seq, patient, benchState, recallAt, recallDue, vitalsDone, vitalsId, escalation, cancelMsRemaining)`
- `GET /opd/visits/:id/prestage — opd-visits.controller.ts:527, opd.vitals.history.read (band, ranges, noticeRanges, gates, muacBands, required, notRoutine, last, carryCandidates, expectedFlags, sealed)`
- `POST /opd/visits/:id/vitals — opd-visits.controller.ts:457, opd.vitals.record (takes emergency + contextChips + overrides)`
- `GET /opd/vitals/:vitalsId — opd-visits.controller.ts:476, opd.vitals.record`
- `POST /opd/vitals/:vitalsId/amend — opd-visits.controller.ts:488, opd.vitals.record`
- `POST /opd/visits/:id/bench-state — opd-visits.controller.ts:515, opd.vitals.record (state: 'resting' | 'away' | null, restMinutes, note)`
- `GET /opd/visits/:id/escalation — opd-visits.controller.ts:537, opd.vitals.record`
- `POST /opd/visits/:id/escalation/recheck — opd-visits.controller.ts:544, opd.vitals.record`
- `POST /opd/visits/:id/escalation/escalate — opd-visits.controller.ts:555, opd.vitals.record`
- `POST /opd/visits/:id/escalation/cancel — opd-visits.controller.ts:572, opd.vitals.record (the ten seconds)`
- `GET /opd/queues/summary?serviceDate — opd-queue.controller.ts:108, opd.queue.read (the valve pill's `waitingVitalsCount`)`
- `POST /patients/qr/verify — patients.controller.ts:317, patients.read (the scan door; a photographed or reissued card fails here)`
- `POST /patients/:id/allergies — patients.controller.ts:523, patients.update (body accepts source: 'vitals' — this is the artboard's '+ allergy heard at the bench')`
- `GET /opd/patients/:patientId/vitals — opd-visits.controller.ts:627, opd.visits.read`

**Claimed missing (VERIFY — the critic corrected several):**

### Reuse, do not reinvent

- apps/web/src/screens/desk-one/desk-one.css — THE design system. The `.pp` scope already publishes .box .pri .sec .in .pill (.on/.gd/.rd) .tag .mo .dev .kb (.dk) .agchip .agdo .drow .stamp .spin. Read it before writing a single style.

- apps/web/src/components/agent-dock.tsx — the co-pilot bar every screen must carry; already binds F2 to focus the ask box (agent-dock.tsx:63-70) and exports `AgentLine` + `logged`. Props are `{answer, log, onAsk, placeholder, idle}` — deterministic, no LLM, and each answer must name its source.

- apps/web/src/screens/opd-appointments.tsx:499 and :601 — the FD-23 reference conversion. Copy its root shape verbatim: `<div className="pp" style={{display:'flex',flexDirection:'column',minHeight:'calc(100vh - 96px)'}}>` … `<AgentDock/>` last child.

- apps/web/src/screens/desk-one/stages.tsx and dossier.tsx — the language for a stage body and a left identity column; the tile/big-value/source-pill idiom to imitate.

- apps/web/src/screens/vitals-bay-capture.tsx — KEEP: parseTake, flagOf, bandFor, rangesFrom, buildBody, readLane/writeLane, istClock, humanDate, CaptureCore's whole state machine, the 1–8 binding at :295-311.

- apps/web/src/screens/vitals-bay-protocol.tsx — KEEP: useDangerProtocol, isElevated, readingFrom, holdFirstTake/heldFirstTake/releaseFirstTake, REST_MINUTES.

- apps/web/src/screens/vitals-bay-amend.tsx — KEEP: AmendPanel, AmendTrail.

- apps/web/src/lib/opd-api.ts — every call already exists (fetchBench :576, fetchPreStage :608, postVitals :643, demandRecheck :653, escalateVisit :656, cancelEscalation :659, fetchEscalation :662, setBenchState :665, amendVitals :679, listQueueSummary :695). Write no new fetch wrapper.

- apps/web/src/lib/patient-in-hand.tsx (usePatientInHand) and lib/realtime (useRealtime) — the cross-screen session and the queue push topics.

- apps/web/src/screens/login-verses.ts — the PATTERN for the 'say this' Devanagari lines: a frozen source-verified table in a .ts file, never in the locale JSONs.

### Permissions

- opd.vitals.record — gates the route (router.tsx:110), the save, the amend, bench-state and all four escalation endpoints

- opd.queue.read — GET /opd/bench and GET /opd/queues/summary

- opd.vitals.history.read — GET /opd/visits/:id/prestage (the whole left column: band, ranges, gates, last visit, carry candidates)

- opd.visits.read — GET /opd/patients/:patientId/vitals

- patients.read — POST /patients/qr/verify (the scan door)

- patients.update — POST /patients/:id/allergies with source:'vitals'

### Keyboard

- Esc — clear the desk / close an overlay. ALREADY BOUND at vitals-bay.tsx:428-437, and it correctly lets Escape in a non-empty input clear the box first.

- 1–8 — jump to a tile. ALREADY BOUND at vitals-bay-capture.tsx:295-311, correctly guarded against firing inside an input and against Alt/Ctrl/Meta.

- Enter — commit the field and jump to the next empty one. ALREADY BOUND per-input at vitals-bay-capture.tsx:521.

- Ctrl+Enter — save → next. TO BIND. Legal: the keymap marks Enter 'ours' and Ctrl+Enter is the map's designated irreversible-commit chord ('a chord, because it is the irreversible one').

- F2 — focus the agent ask box. Comes free the moment AgentDock is mounted (agent-dock.tsx:63-70). Keep lib/keyboard.tsx's global F2 reservation untouched; the binding is local, as it is on Desk One and on /opd/appointments.

- S — scan/take the next in line. TO BIND, bare, only when nothing is focused (keymap law: 'Bare keys only outside a field').

- R — rest & recheck. TO BIND, bare, same guard, and only while the rest offer is on screen.

- Space — first empty field (typing lane) / fire the next device (serial lane). TO BIND, bare, same guard.

- Ctrl+K — DO NOT BIND. The artboard draws a 'Ctrl K' keycap for the command palette and it is unbindable: Keymap.dc.html's `ctrlTaken = "ADEFGHJKLNOPRSTUW"` includes K, Chrome consumes it for the address bar, and preventDefault never sees it. Desk One already hit this (FD-9: 'Ctrl+K/Ctrl+N unbindable'). Either drop the command surface or give it a free function key — and per agent-dock.tsx:47, a keycap that lies is worse than no keycap.

### Risks

- apps/web/src/router.tsx:567-571 — `vitalsBayRoute` has NO `staticData`. Only `/counter` carries `staticData: { fullViewport: true }` (router.tsx:549). If the rebuild adopts `.d1` (which is `position:fixed; inset:0`) without adding that line, it reproduces FD-11's exact bug verbatim: the app shell renders its header and sixteen nav links UNDERNEATH the bay — invisible, unclickable, and still in the tab order. Safer default: use `.pp` inside the shell like FD-23 did, with `minHeight: calc(100vh - 96px)`, and leave fullViewport alone.

- apps/web/src/screens/desk-one/desk-one.css:135,143,146,149,153 — `.ovl`, `.lock`, `.frame`, `.top` and `.rail` are scoped to `.d1` ONLY; the `.pp` half of each rule does not exist. The artboard needs all five (overlays, the padlock on carried height, the 1220px frame, the header bar, the bench rail). There is also NO `.tile` class anywhere in the repo — grep returns nothing. Promoting those selectors to `.pp` edits the file FD-23 owns; adding a bay-local stylesheet instead is the second palette this file's own header argues against. Decide it on purpose, in one place.

- apps/web/src/styles.css:254-255 — `[data-seat="vitals-bay"]` remaps the shadcn TOKENS to paper-and-pine but nothing else. If the rebuild moves to `.pp` classes and drops the attribute, any shadcn component left behind silently reverts to greyscale. If it keeps the attribute AND adds `.pp`, both systems paint the same element. Pick one and strip the other; the file's own close-review note at :217-224 warns that Radix portals escape `[data-seat]` entirely — every Dialog/Select opened from this bay renders greyscale unless the class is passed onto the portal container, which is precisely what opd-appointments.tsx:111 does with `<DialogContent className="pp">`.

- desk-one.css is imported ONLY by screens/desk-one/desk-one.tsx:28. It reaches /opd/appointments and /patients/:id purely because router.tsx:24 statically imports DeskOne, so the CSS is unconditionally in the bundle. A `.pp` Bay One inherits that same invisible dependency: the day anyone code-splits DeskOne, three screens lose their stylesheet at once and nothing in the test suite notices. Import `./desk-one/desk-one.css` from the bay explicitly.

- vitals-bay.tsx:359 is the ONLY setBenchState caller and it passes `state: "resting"`. The `away` state is fully built server-side (bench.ts:43 `BENCH_STATES = ["resting","away"]`) and READ by the rail at vitals-bay.tsx:143 — but nothing can ever SET it and nothing can bring the patient back. Salma's story ("stepped out — the agent holds her turn, nobody re-queues her by hand") is unreachable today. This is the same server-built-never-wired pattern the OPD counter diagnosis already recorded three times.

- The artboard's `rng()` hardcodes 90–140 / 60–100 / 94–100. DO NOT copy those numbers. The server sends `preStage.ranges`, `noticeRanges`, `gates` and `muacBands` per band (opd-api.ts WirePreStage), and vitals-bay.tsx's own close-review comment records WHY: the bay cannot read GET /opd/config, a permission `vitals_desk` does not hold. A hardcoded band table would mis-tint every child in the hospital and no test would catch it.

- The 10-second cancel countdown. The artboard's own comment is the warning: its tick handler updates ONLY the two countdown text nodes because "a full repaint would wipe whatever is mid-typed". A React rebuild that puts `cancelMsRemaining` in state and re-renders the tree once a second will blow away half-typed tile input during the single most time-critical moment on the screen. Drive the countdown from a ref into a leaf node, or memoise the tile grid against it.

- 49 tests across five suites (vitals-bay.test.tsx 10, -capture 17, -protocol 12, -amend 8, -stories 2) assert semantic testids and will mostly survive — but the memory note on the front-desk lane stands: `not.toContain("P5")` over a card JSON full of ULIDs flakes, and it failed a radiology PR's CI on 2026-09-02. Any new assertion that greps rendered JSON for a short token will do the same.

- vitals-bay.tsx:441 renders `min-h-screen` with no horizontal floor. Desk One pins `min-width:1220px` on `.d1 .frame` because a three-column triptych at 294+238 fixed plus a 4-up tile grid cannot fold. FD-11 already had to go back and make Desk One responsive below 1220px. Set the floor and the overflow-x in the same edit as the columns, not after a screenshot.

- The header's "Bay 01 · Sister Kavita Kisku · 08:00–14:00" has no data behind it. `useAuth().actor` gives the name; there is no bay number and no shift window anywhere on the wire. Render the actor and drop the rest — do not invent a shift string, and do not add an endpoint for it.

### Locale

Namespace `vitalsBay` already exists and is complete at 145 keys in BOTH apps/web/src/locales/en.json and hi.json (verified equal), across 23 groups: allDepartments, allDoctors, amend, band, bench, capture, chips, clearDesk, department, doctor, gate, identify, lane, protocol, rest, saved, session, tile, title, unit, unlock, valve, vital. The rebuild ADDS roughly 25–35 keys per file, not a new namespace: the agent dock's ticker/idle/placeholder and its log lines (~12), the header furniture — bay label, shift line, clock, device-strip pills (~6), the empty-session shift figures and key legend (~8), the away/step-out row and its return (~3), and the tile source pills AUTO/TYPED/RODE-THE-CUFF plus the delta line (~5). Both files must move in the same commit — a key present in en and absent in hi renders the raw key path on a Hindi desk. The Devanagari 'say this' coaching lines do NOT go in the locale files: freeze them in a .ts table beside the screen, the login-verses.ts ruling.

### Shared files this screen touches

Four shared files, and only two are genuinely contended. (1) apps/web/src/locales/en.json + hi.json — unavoidable; the `vitalsBay` namespace is exclusively this screen's so the CONTENT never collides, but the FILE does. Land both files in one commit, by pathspec, and rebase before the PR. (2) apps/web/src/screens/desk-one/desk-one.css — the real collision. FD-23 owns this file and just finished a sweep through it ("the inner panels stop speaking Tailwind"); promoting `.rail`/`.top`/`.ovl`/`.lock` from `.d1` to `.pp` touches the same lines. Coordinate before editing, or take the bay-local-stylesheet route and say why. (3) apps/web/src/router.tsx — ONE line, and only if the fullViewport decision goes that way; the route, the nav row and the component binding all already exist. (4) apps/web/src/styles.css:254-255 — one selector, only if `[data-seat="vitals-bay"]` is retired. NOT TOUCHED, and each verified: apps/core/scripts/seed-roles.ts (all six permissions already held by `vitals_desk` at :155-173 — no grant, so no seed-roles.test.ts count change); apps/core/test/caddyfile-parity.test.ts (pinned at 48 routes on :373 and already asserts `/opd/vitals` on :381 — a re-skin adds no route, so do not touch the pin); apps/core/drizzle/** (no migration — the server is complete); every apps/core module. This screen is safe to build in parallel with any core-side lane.

---

## consult — the doctor's seat (FD-25 screen 5 of 6) — `/opd/consult (already in router.tsx:771-775 and the 48-route census; the path does NOT change)`
**Complexity:** very-large

### What the artboard specifies

- NO ARTBOARD EXISTS. The FD-25 handoff says so explicitly at docs/superpowers/2026-09-05-HANDOFF-front-desk-FD25-screens.md §4: 'There is no artboard for the doctor's screen or the admin dashboard — for those, extend the established language rather than inventing a second one, and consider asking for a design pass first.' Do not invent a second visual system.

- THE LANGUAGE IS apps/web/src/screens/desk-one/desk-one.css, and its own header states the law: primitives carry BOTH `.d1` and `.pp`; LAYOUT rules (`.frame`, `.top`, `.rail`, `.ovl`, `.pi`, `.lock`, `.sw`) carry `.d1` ALONE. One definition — if the consult screen needs a new primitive it is ADDED THERE, never forked into a second file.

- Palette (from styles/paper-pine.css, shared by `.d1`, `.lg`, `.shell`): paper #f4f7f4, card #ffffff, pine ink #132420, line #dfe7e1, line2 #ecf1ed, dim #5c6f66, faint #8ea69a, wash #eef3ef, hospital green #0e6b4e, marigold #dd8f1c, brick #b23a30, agent #132420 / agent-fg #d9efe4 / agent-dim #7fa392 / mint #35c48f.

- Primitives available to `.pp` verbatim: `.mo` (tabular mono), `.dev` (Devanagari), `.tag` (9.5px uppercase mono label), `.kb` / `.kb.dk` (keycaps), `.pri` (40px green primary), `.sec` / `.sec.grn` (34px secondary), `.box` (card+line+8px radius), `.in` (40px field, green focus ring), `.pill` / `.pill.on` / `.pill.gd` / `.pill.rd`, `.stamp.un` / `.stamp.pd` (OUTLINED never filled — 'thermal heads wear, paper curls, and a hollow stamp survives both'), `.agchip` + `.agdo` (speaks-on-dark), `.drow` (list row with top hairline + wash hover).

- THE SPEAKS-ON-DARK RULE is design law, not a style choice: 'anything the AI says or does sits on pine ink.' There is NO light variant of `.agchip` and there must not be one. Every suggestion the scribe or the co-pilot makes renders on pine; anything on paper is a fact the hospital recorded.

- THE SHELL QUESTION IS ALREADY DECIDED BY PRECEDENT: `/opd/consult` lives inside the application shell and keeps its topbar, so it wears `.pp` and NOT `.d1` (which is `position: fixed; inset: 0; z-index: 40` and covers the chrome). router.tsx:549 shows `staticData: { fullViewport: true }` is set on `/counter` and nowhere else. Follow opd-appointments.tsx:499 — `<div className="pp" style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 96px)' }}>` with the AgentDock as the last child.

- Responsive floor: desk-one.css's @media (max-width: 1220px) block is scoped to `.d1` only. A `.pp` screen inherits NO narrow story — the consult screen must write its own, or it breaks silently on a 1024x768 lobby terminal (FD-11 measured exactly this failure on the desk).

- The keyboard artboard docs/design/2026-09-03-front-desk-three-seats/Keymap.dc.html IS signed off and does apply. Its ruling: 'no shortcut may overlap a browser shortcut.' Ctrl+N and Ctrl+K are DEAD (Chrome non-overridable / address bar). Struck letters = Ctrl+ADEFGHJKLNOPRSTUW. Ctrl+1..9 switches browser tabs so bare 1/2/3 are used instead. Free function keys: F2, F4, F7, F8, F9 only. F1/F3/F5/F6/F10/F11/F12 deliberately unused. The map is: Tab (next field, the instrument the desk is played on), Enter (do the obvious next thing), Ctrl+Enter (commit — a chord because it is the irreversible one), Esc (once back to the search box, twice clear the desk), F2 (the assistant), F4 (register a new patient), F7 (the appointment book), F8 (take payment), F9 (reprint the last document), Up/Down (move down a list), 1/2/3 (cash/UPI/card, only when the cursor is not in a field).

- The artboard's own rule, quoted: 'Every keycap ON the screen shows what is actually bound. A keycap that lies is worse than none.' FD-23's close review already paid for this once.

### Server endpoints

**Existing:**
- `GET /opd/me/doctor — opd.consult (opd-masters.controller.ts:257-258). A 404 is the DOMAIN answer 'you have no doctor profile' (erratum E3), never a transport failure.`
- `GET /opd/config — followUpDefaultDays, followUpExtensionDays[], extensionCapPerDoctorPerMonth, maxSkipsBeforeLeft, dangerRanges, letterhead`
- `GET /opd/queues?doctorId&serviceDate — opd.queue.read (opd-queue.controller.ts:143-144). Returns WireQueueView: session, doctor, ordered[], current, inConsult[], waitingVitals, counts{waiting,called,inConsult,done,left}. Each row carries position, queueClass, danger, reEntry, perk, skips, and feeStatus.`
- `POST /opd/queues/:sessionId/call-next — opd.queue.operate (:154-155)`
- `POST /opd/queues/:sessionId/status — opd.queue.operate, body {status: in|out|closed} (:166-167)`
- `POST /opd/queues/entries/:entryId/skip — opd.queue.operate (:179-180)`
- `POST /opd/visits/:id/consult/start — opd.consult (:191-192)`
- `PUT /opd/visits/:id/consult/note — opd.consult (:201-202). Body: chiefComplaint, diagnosis, icd10Code, advice, admissionAdvised, referralTo, referralNote, advisedTests[{serviceId,code,name,pricePaise}] capped at 20.`
- `POST /opd/visits/:id/consult/complete — opd.consult (:212-213). Body: {note?, testsOrderedReturnToday: boolean, followUpDays?: positive int}.`
- `POST /opd/visits/:id/prescriptions — opd.consult (:225-226). Body: lines[], overrides[], interactionOverrides[{lineIndex,reason,saltPair?}], duplicateOverrides[{lineIndex,reason,moiety?}].`
- `POST /opd/visits/:id/rx-precheck — opd.consult (:245-246). Writes nothing, decides nothing; issue re-runs every check.`
- `GET /opd/visits/:id — opd.visits.read (opd-visits.controller.ts:388-389). Returns {encounter, queueEntries, vitals, prescriptions, patient}.`
- `GET /opd/visits/:id/vitals, GET /opd/visits/:id/prestage — opd.visits.read / opd.vitals.history.read`
- `GET /opd/patients/:patientId/timeline — opd.visits.read (:589-590)`
- `GET /opd/patients/:patientId/prescriptions — opd.consult (:614-615)`
- `GET /opd/patients/:patientId/vitals — opd.consult (:626-627)`
- `GET /opd/prescriptions/:id/print — opd.visits.read (opd-queue.controller.ts:276-277). Returns RxPrintData for the browser-rendered e-Rx.`
- `GET /patients/:id — patients.read. A 404 is a HIDDEN CONFIDENTIAL RECORD (§14 / D-37), render restricted mode with the UHID only.`
- `GET /patients/:id/allergies — patients.read; POST /patients/:id/allergies — patients.update (the doctor holds both; an allergy found DURING a consult is the best moment to record one)`
- `GET /formulary/medicines?active=true, GET /formulary/coverage, GET /formulary/interactions — formulary.read (formulary.controller.ts:141-142, :204-205, :173-174)`
- `GET /tariff/price-list, GET /tariff/services — tariff.read (tariff.controller.ts:200-201, :144-145)`
- `GET /lab/results/encounter/:encounterNo — lab.results.read (lab-verify.controller.ts:277-278). NEVER held for money (02 O-1).`
- `GET /lab/results/encounter/:encounterNo/provisional — lab.results.read (:296-297). 17d T5: the unsigned numbers on their own route, deliberately not a query flag.`
- `GET /lab/catalogue/search?q= — lab.catalogue.read (lab-catalogue.controller.ts:128-129)`
- `GET /lab/catalogue/orderables/:serviceId — lab.catalogue.read (:73-74)`
- `POST /lab/catalogue/duplicates — lab.catalogue.read (:117-118)`
- `POST /radiology/orders — radiology.orders.place (radiology-orders.controller.ts:78-79), idempotency-key header. THE DOCTOR HOLDS THIS. No web helper exists in lib/radiology-api.ts — client code is new, the endpoint is not.`
- `POST /radiology/orders/:orderId/items — radiology.orders.place (:98-99), the add-on as a new order in the parent's group`
- `GET /radiology/reports/:reportId — radiology.reports.read (radiology-reports.controller.ts:113-114)`
- `POST /speech/transcribe — SHIPPED INERT (kernel/inference/speech.controller.ts:71). Exists, user-actors-only (:80), 600 kB body cap, answers 503 speech_not_configured (:90) until SPEECH_PROVIDER/ACCOUNT_ID/API_TOKEN are set. Build the whole dictation surface against it (handoff §3.1 default (c)); the block is a DPIA revision, not a code change.`
- `POST /opd/visits/:id/re-enter, POST /opd/visits/:id/reclassify — opd.visits.open. NOT reachable by the doctor; listed so nobody wires them here.`

**Claimed missing (VERIFY — the critic corrected several):**
- `POST /lab/orders (or equivalent) — A CLINICIAN-PLACED LAB ORDER HAS NO ROUTE. The doctor role holds `lab.orders.place` + `orders.place` + `lab.catalogue.read` (seed-roles.ts:250-256) and there is nothing to call: the only lab-order POST is `POST /lab/desk/orders` at lab-desk.controller.ts:121-122, gated on `lab.desk.operate`, which the doctor does NOT hold. Grepped every controller for `RequirePermission("orders.place")` and `RequirePermission("lab.orders.place")` — ZERO hits. Today the doctor's only lab path is `advisedTests` on the consult note, which is a SUGGESTION the counter converts (07d/DD4) and creates no order. Either add a clinician route or DECIDE that advise-only is the design and say so on the screen (the existing screen already prints 'this creates no order' — opd-consult.test.tsx:1123 pins it).`
- `GET /radiology/orders?encounterNo= (or /studies?patientId=) — the doctor can PLACE an imaging order and then cannot read back its status or find the reportId. `GET /radiology/worklist` and `GET /radiology/studies/:id` are gated on `radiology.worklist.read`, which seed-roles.ts:268-271 deliberately withholds from the doctor ('a doctor browsing every scan in the hospital is exactly the read the alias rules exist to prevent'). `GET /radiology/reports/:reportId` needs an id nothing hands the doctor. A narrow per-encounter clinician read is genuinely absent.`
- `POST /opd/visits/:id/prescriptions does NOT enqueue a print job. The FD-24 outbox is written only at visit-open (encounters.ts:203 token slip, :211 `opd_prescription`), so the ISSUED e-Rx still prints through the browser via `RxPrint` (opd-consult.tsx:1367-1370). Two printing paths for one document. Enqueuing the issued Rx (render.ts:447 already handles `opd_prescription`) is a server change that does not exist yet.`
- `NOTHING for the scribe beyond transcription — no route stores a transcript against an encounter, and none should be added without the DPIA revision. `attachTranscript` exists in kernel/search/audit but is wired to the palette, not to a note.`

### Reuse, do not reinvent

- apps/web/src/components/agent-dock.tsx — `AgentDock` + `logged()`. MANDATORY, the co-pilot is non-negotiable. Props: {answer, log, onAsk, placeholder, idle}. Binds F2 itself (agent-dock.tsx:63-70) and caps the log at 40 lines.

- apps/web/src/screens/desk-one/desk-one.css — the design system. Import it or depend on router.tsx:24 keeping it in the bundle (see risks).

- apps/web/src/styles/paper-pine.css — the six palette values; import explicitly as login.tsx:13, desk.tsx:11, router.tsx:17 and desk-one.tsx:27 all do.

- apps/web/src/screens/desk-one/model.ts — PURE functions, no session coupling: `ageOf`, `ageYearsOf`, `sexLetter`, `initialsOf`, `rs(paise)`, `tokenLabel(deptCode, tokenNo)`, `istClock`, `istDateLabel`, `etaClock`, `logged`. Use `ageOf` instead of opd-consult.tsx's local `ageYearsAt` (opd-consult.tsx:71-78).

- apps/web/src/lib/opd-api.ts — every Wire type this screen needs is already declared: WireQueueView (:177-181), WireQueueEntryView (:140-162, carries feeStatus), WireEncounter (:112-124), WireOpdConfig (:68-72), plus `opdErrorMessage`, `todayIst`, `isInteractionHit`.

- apps/web/src/lib/lab-api.ts — `resultsForEncounter` (:443), `provisionalResultsForEncounter` (:447), `flagTone` (:474), `searchOrderables` (:211), `duplicateWarnings` (:214), `labRefusal` (:330).

- apps/web/src/lib/realtime.ts — `useRealtime([`queue:${doctorId}:${today}`, `encounter:${id}`])`. A push is a HINT to re-read; keep the 15 s poll beside it so a missed frame costs seconds, never correctness.

- apps/web/src/components/rx-print.tsx — the letterhead e-Rx. Keep the ONE render site rule (opd-consult.tsx:48): a single nullable `rxPrint` state so two `.print-doc` elements can never mount together.

- apps/web/src/components/voice-button.tsx + apps/web/src/lib/voice-flag.ts — VOICE_SEARCH_ENABLED is `false`; the button renders null by design. The scribe's mic must follow this pattern and say plainly why it is off, not render a disabled control with a compliance tooltip.

- apps/web/src/lib/print-api.ts — `listPrintJobs`, `reprintJob`, `PRINT_DOCUMENT_LABEL`, `printSummary`. READ THE PERMISSION WARNING IN RISKS BEFORE WIRING THESE.

- apps/web/src/screens/opd-appointments.tsx:499-610 — the reference implementation of a `.pp` screen with an AgentDock: layout wrapper, real `<label htmlFor>` on every field, the memoised `ask` callback, `<AgentDock>` as the last child. Copy this shape.

- apps/web/src/screens/desk-one/dossier.tsx — READ IT for the rail's language, do NOT import it. `Dossier()` takes no props and calls `useDesk()` (dossier.tsx:83), so it is bound to the counter session and is not mountable here. Its History sub-component (:33-81) is the pattern for the patient's past.

- apps/web/src/components/patient-strip.tsx, patient-picker.tsx — available, but the consult seat gets its patient from the queue, not from a search; use only if a lookup stage is added.

- apps/web/src/screens/opd-consult.tsx itself — DO NOT throw away the logic. The 1,482 lines encode measured rules that cost real defects: the K49 followUpDays omission (:677-681), the lazy PHI history reads (:307, :312), the §3.19 string→number resolver coercion (:100-108), and the C1 'a failed query is not a clinical negative' rule (:1409-1441). Port the brains, replace the paint.

### Permissions

- opd.consult — the seat's gate. Guards /opd/me/doctor, consult/start, consult/note, consult/complete, prescriptions, rx-precheck, and the two cross-encounter history reads.

- opd.queue.read — GET /opd/queues

- opd.queue.operate — call-next, session status, skip

- opd.visits.read — GET /opd/visits/:id, visit vitals, timeline, prescription print

- opd.vitals.record + opd.vitals.history.read — the cheap one-row pre-stage

- opd.masters.read, opd.appointments.read

- patients.read + patients.update — Group B, the sharpest row in seed-roles.ts (:207-230): the doctor held ZERO patients.* until 2026-08-26 and BOTH /patients/:id and /patients/:id/allergies answered 403 in production.

- formulary.read — the picker that sets medicineId (DD10, read-only)

- tariff.read — the priced catalogue behind advised tests (DD6)

- lab.orders.place, lab.results.read, lab.catalogue.read, orders.place, orders.read, orders.cancel

- radiology.orders.place, radiology.reports.read

- NOT HELD, and this is load-bearing: opd.visits.open (so /print/jobs and /print/reprint 403), lab.desk.operate (so POST /lab/desk/orders 403), lab.worklist.read, radiology.worklist.read, materials.stock.read (deliberately withheld, seed-roles.ts:200-206).

### Keyboard

- F2 — the co-pilot ask box. Bound by AgentDock itself (agent-dock.tsx:63-70), a plain window keydown listener with preventDefault. Draw the `kb dk` keycap; it is honest.

- Ctrl+Enter — COMPLETE the consultation. This is the Keymap's 'Commit — a chord, because it is the irreversible one'. It REPLACES the existing Alt+Enter (opd-consult.tsx:698-717), which the artboard does not contain. Breaking opd-consult.test.tsx:877 is the intended cost.

- Enter — 'do the obvious next thing': call next when nobody is in the chair, start the consultation when a patient is called. Must not fire from inside a field.

- Esc — once returns to the queue list, twice releases the patient and clears the panel. The Keymap's own words: 'Nothing bleeds into the next person.' This screen has no Esc today.

- Tab / Shift+Tab — 'the main instrument'. One pass top to bottom in the order a doctor asks the questions out loud: complaint, vitals read, diagnosis, ICD, advice, Rx lines, advised tests, follow-up. A field that is not on screen must never take a tab stop, and one that is must never be skipped.

- Up / Down — move through the queue rows.

- F8 — free for a seat action; globally unbound and reserved for exactly this (keyboard.tsx:149-158 says F8/F9 'belong to the task that builds the actions'). Bind it to Issue & print the e-Rx, or leave it and draw no keycap.

- F9 — 'reprint the last document'. DO NOT BIND IT NAIVELY: /print/reprint is gated on opd.visits.open which the doctor does not hold (see risks). Either bind it to the browser RxPrint of the last issued prescription, or do not draw the keycap.

- DO NOT BIND: F4 and F7. keyboard.tsx:98 and :123 already own them globally (F4 -> /counter?new=true, F7 -> /opd/appointments) and they fire on this screen. Drawing either keycap for a consult action produces a key that navigates away mid-consultation.

- DO NOT BIND: Ctrl+N, Ctrl+K, or any Ctrl+letter in ADEFGHJKLNOPRSTUW, or Ctrl+1..9 — the artboard struck all of them as browser-owned.

- RETIRE: the current Alt+N / Alt+K / Alt+S / Alt+Enter block (opd-consult.tsx:693-719). FD-5's ruling parked the Alt chords and the signed-off Keymap contains none of them. Four tests pin them (opd-consult.test.tsx:845, :863, :877, :899) — rewrite those four deliberately, in the same commit, rather than leaving a second key system alive beside the artboard's.

### Risks

- apps/web/src/screens/desk-one/desk-one.tsx:28 is the ONLY import of desk-one.css in the entire tree, and apps/web/src/router.tsx:24 statically importing DeskOne is the only reason `.pp` has any styling at all on opd-appointments.tsx and patient-detail.tsx. FD-25 handoff §3.2 openly contemplates DELETING /counter. If that happens — or if anyone code-splits DeskOne — every `.pp` screen silently loses its whole design system: no compile error, no test failure (jsdom applies no CSS), just an unstyled screen the owner finds. FIX IT IN THIS TASK: import desk-one.css (or a `.pp`-scoped extraction) from the consult screen directly.

- apps/web/src/screens/opd-appointments.tsx:499 and patient-detail.tsx:857 mount `<div className="pp">` with NO `data-lang` attribute. desk-one.css's Devanagari fix is scoped `.pp[data-lang="hi"]` — so FD-10/FD-11's fix (mono has no Devanagari coverage; uppercase buys nothing; .14em letter-spacing pulls conjuncts apart) has NEVER fired on either `.pp` screen. Only desk-one.tsx:1169 and login.tsx:154 stamp it. Stamp it here: `data-lang={i18n.language.startsWith('hi') ? 'hi' : 'en'}`.

- apps/core/src/kernel/printing/printing.controller.ts:155-156 (GET /print/jobs) and :192-193 (POST /print/reprint) are both `@RequirePermission("opd.visits.open")`. The doctor role (apps/core/scripts/seed-roles.ts:176-273) holds opd.visits.read and NOT opd.visits.open. Any print-status panel or F9 reprint on this screen 403s for every doctor. jsdom tests with a stubbed fetch will not catch it — only a real browser or an e2e will.

- apps/core/src/modules/lab/lab-desk.controller.ts:121-122 gates POST /lab/desk/orders on lab.desk.operate. A doctor placing a lab test WILL 403 there. The doctor's lab grants (seed-roles.ts:250-256) reach no HTTP route at all. Do not ship an 'Order lab test' button wired to that path.

- apps/web/src/screens/opd-consult.tsx:677-681 (K49): the DEFAULT follow-up must be ABSENT from the complete body, not sent as 7. Sending it explicitly makes the screen the authority on a value opd/config owns and it silently disagrees the day the owner changes followUpDefaultDays. A redesign that rebuilds the form is exactly where this regresses; opd-consult.test.tsx:765 asserts the posted KEY SET.

- apps/web/src/screens/opd-consult.tsx:307 and :312: rxHistory and vitalsHistory are lazily `enabled` on the history tab being open, because each is the largest PHI read the app makes and each writes a DPDP access-log row. A redesign that eagerly prefetches to make tabs feel snappy fills the compliance register with reads nobody performed. opd-consult.test.tsx:1036 pins it.

- apps/web/src/screens/opd-consult.tsx:1409-1441 encodes close-review finding C1: a FAILED lab query must never render 'No verified laboratory results for this visit'. That sentence is a clinical claim made to a prescriber, and a doctor who reads it stops looking. The four-way branch (isError -> unavailable, isPending -> loading, empty -> empty, else list) must survive the re-skin, and the provisional block must render NOTHING on error rather than an empty state.

- apps/web/src/screens/opd-consult.tsx:100-108 (§3.19 / K41): durationDays is coerced string->number at the ZOD RESOLVER via .transform().pipe(), deliberately not z.preprocess (whose z.input collapses to unknown and fails useForm's field-value typing). Rebuilding the Rx form with a different resolver posts a string and the server 400s. Note also opd-consult.tsx:196 — refused submissions replay `pendingLines.current` (the PARSED lines), never getValues().

- apps/web/src/screens/opd-consult.tsx:48 and :1367-1370: exactly ONE `.print-doc` may be mounted at a time, guarded by the single nullable rxPrint state. Adding a second printable (a certificate, an order slip) without extending that guard puts two documents on one sheet.

- apps/web/src/components/agent-dock.tsx:63-70 registers an unconditional window keydown listener for F2 with preventDefault. If the scribe or any new overlay also wants F2, or if two docks ever mount, the key fires twice. Mount exactly one AgentDock per screen.

- The four `@/components/ui/*` imports at apps/web/src/screens/opd-consult.tsx:22-25 (Button, Badge, Dialog, Tabs) plus ~131 raw Tailwind class sites are what the FD-25 handoff counts as '59 old-design hits — the worst file in the tree'. The definition of done forbids both. Half-converting is explicitly worse than not starting (commit 9af37bf: 'the two type systems sit in one column and the seam is exactly where the eye goes').

- opd-consult.tsx:71-78 duplicates the server's ageYearsAt as a UTC mirror. desk-one/model.ts:372-403 already has ageYearsOf/ageOf. Two age functions in one screen family is a drift waiting to happen.

- The screen must NOT branch on exact success status codes: twenty of twenty-one OPD POSTs ride Nest's default 201 and only /opd/prescriptions/verify is 200 (opd-consult.tsx:33-38). Success means api() did not throw.

- apps/core/test/caddyfile-parity.test.ts:373 asserts the SPA census `toHaveLength(48)`. Keeping /opd/consult at its existing path costs nothing; adding any sub-route (e.g. /opd/consult/scribe) moves the number. Measure it, never predict it — the test's own rule.

- The three known repo-wide flakes will show up on a full run and are NOT your diff: partners accrual.test.ts F11(a) 300 ms lock budget, kernel/worker/jobs.test.ts V12 scheduler window, lab-reports D9. Check CI on your own SHA before blaming the redesign — but the FD-25 handoff also warns that once this lane read a real failure as a flake.

### Locale

Namespace `opdConsult` in apps/web/src/locales/en.json and hi.json — it already holds exactly 100 leaf keys in each file (verified equal; total tree is 2657 leaves per file). Reuse them; the copy is good and 24 tests read it. Add roughly 55-75 new keys for: the co-pilot (askPlaceholder, agentIdle, ~8 canned answers naming their source), the scribe surface (record/stop/waveform/transcript/insert/undo, and the honest 'why the microphone is off' sentence), the keycap legend row, the ordering panel (lab advise vs radiology order, the refusal strings), the narrow-viewport story, and the new section headings. Related namespaces already present and reusable: `lab.consult.*` (title, unpaidNote, unavailable, loading, empty, provisionalTitle, provisionalNote, provisionalStamp), `rx.*`, `opd.visitType.*`, `opd.labels.*`, `patientStrip.*`. Locale parity is BLIND to a key missing from BOTH files (handoff §6) — every key lands in en.json and hi.json in the same commit. `shortcuts.opdConsult` ("Alt+C Consult") at en.json:88 is a live ORPHAN: keyboard.tsx:177-181 renders only search/new/book/confirm/release, so that key advertises a chord FD-5 parked. Delete it in both files or bind it — do not leave it.

### Shared files this screen touches

SERIALIZATION POINTS (every one of these is on CLAUDE.md's coordinate-before-editing list). (1) apps/web/src/locales/en.json AND hi.json — the biggest collision surface: all six FD-25 screens add keys, and parity is blind to a key missing from BOTH files, so a bad merge is invisible. Never `--ours` these; take main's copy and re-apply key-by-key. (2) apps/web/src/screens/desk-one/desk-one.css — the one-definition law means any new primitive lands HERE, and /registration, /appointment, /billing and /opd/vitals will all want one. Add primitives under `.d1, .pp` together; never fork the file. (3) apps/web/src/router.tsx — /opd/consult's route already exists (:771-775) and its nav row already exists (:111), so consult needs NO edit unless it claims `staticData.fullViewport` or a search param. /registration and /appointment DO edit it. Stay out if you can. (4) apps/core/test/caddyfile-parity.test.ts:373 — the census is 48 and the two re-created routes move it to 50; consult must not also move it. (5) apps/core/scripts/seed-roles.ts + apps/core/test/seed-roles.test.ts (pins permission counts) — ONLY touched if you add a clinician lab-order permission or grant the doctor a print permission. Both are hub files every lane fights over. (6) apps/web/src/lib/keyboard.tsx — F4/F7 are global and F2/F8/F9 are reserved there by comment plus a named test row in keyboard.test.tsx; a screen-local binding does NOT need to edit this file and should not. (7) apps/web/src/components/agent-dock.tsx — shared by every FD-25 screen; if consult needs a prop the others do not have, add it optional and default it. (8) apps/web/src/lib/opd-api.ts and lab-api.ts — shared Wire vocabulary; additive only. NOT shared, safe to own alone: apps/web/src/screens/opd-consult.tsx, opd-consult.test.tsx, lab-consult-panel.test.tsx, and any new files under a screens/consult/ directory. Order the work last, as the handoff §7 says: consult is screen 5 of 6 and is gated on the §3.1 scribe ruling.

---

## admin — the four back-office / self-service seats (user administration, OPD masters, staff reports, my day) — `/admin/users (router.tsx:842) + /opd/admin (router.tsx:613) + /staff (router.tsx:492) + /my-day (router.tsx:480) — all four already exist and are already in the caddyfile census`
**Complexity:** large

### What the artboard specifies

- NO ARTBOARD. The binding specification is apps/web/src/screens/desk-one/desk-one.css, whose header states it is the design system transcribed from the owner's signed-off 'Desk One' artifact, value by value.

- TWO SCOPES, ONE FILE. `.d1` is `position: fixed; inset: 0` (desk-one.css:36-47) and deliberately covers the app chrome; `.pp` is the in-shell scope FD-23 added (desk-one.css:26-34). All four of these screens keep their topbar, so all four wear `.pp`, never `.d1`. Layout rules (`.frame`, `.top`, `.rail`, `.ovl`, the 1220px media query) stay `.d1`-only and are NOT available to `.pp`.

- PRIMITIVES available to `.pp` (desk-one.css:51-142): `.mo` tabular mono, `.dev` Devanagari, `.tag` 9.5px uppercase micro-label, `.kb` keycap, `.pri` 40px primary, `.sec` 34px secondary (+`.sec.grn`), `.box` card, `.in` 40px field, `.pill` (+`.on` green / `.gd` gold / `.rd` red), `.stamp` (+`.un` gold / `.pd` green), `.agchip` + `.agdo` (agent, dark only), `.drow` list row.

- STAMPS ARE OUTLINED, NEVER FILLED — desk-one.css:106-115 quotes the artifact: 'thermal heads wear, paper curls, and a hollow stamp survives both.' Border-only is the design, not a style choice.

- SPEAKS-ON-DARK — desk-one.css:117-124: 'anything the AI says or does sits on pine ink. No legend needed to know what the machine touched.' There is no light variant of `.agchip` and must not be one: a suggestion rendered on paper is indistinguishable from a fact the hospital recorded.

- PALETTE MEANINGS (styles/paper-pine.css:1-10): paper #f4f7f4 ground; pine ink #132420 is text AND the only ground the machine speaks on; hospital green #0e6b4e is actions/applied benefits/settled money; marigold #dd8f1c is attention only — UNPAID, heavy queues, missing data; mint #35c48f is the agent's voice and never appears on paper; brick #b23a30 is refusals and blocked actions and nothing else.

- DEVANAGARI RULE (desk-one.css:196-224): under `[data-lang="hi"]` the `.tag` class drops its mono family, its uppercase and its .14em letter-spacing — Plex Mono has no Devanagari coverage, case does not exist in the script, and the tracking pulls conjuncts and matras apart. `.mo` deliberately does NOT change (UHIDs, money, tokens, times are Latin and digits, compared character by character).

- THE ONE LAYOUT NUMBER THAT TRANSFERS: 1220px is the measured floor (desk-one.css:144-175) — below it the header wraps rather than hiding the palette, and the rail narrows 296px -> 252px. A phone is explicitly out of scope: 'this is a two-handed screen with a cash drawer beside it.'

- THE MOUNT PATTERN, established twice (opd-appointments.tsx:499, patient-detail.tsx:857): `<div className="pp" style={{display:'flex',flexDirection:'column',minHeight:'calc(100vh - 96px)'}}>` with a `flexGrow:1, padding:'20px 24px'` body and `<AgentDock/>` pinned last.

- PILL TABS, not shadcn TabsList (opd-appointments.tsx:559-577): `role="tablist"` + `role="tab"` + `aria-selected`, `className={active ? 'pill on' : 'pill'}` at `height: 27`. FD-23's commit message records that restyling dropped `role="table"`/`role="tab"` on the first pass and only the existing tests noticed.

### Server endpoints

**Existing:**
- `GET /admin/users — users-admin.controller.ts:366, @RequirePermission(auth.users.manage,'hospital'); returns {users, fullAdministrators}`
- `POST /admin/users — users-admin.controller.ts:312`
- `POST /admin/users/:id/deactivate — users-admin.controller.ts:418`
- `POST /admin/users/:id/reactivate — users-admin.controller.ts:439`
- `POST /admin/users/:id/password-reset — users-admin.controller.ts:457`
- `POST /admin/users/:id/pin-reset — users-admin.controller.ts:497`
- `GET /admin/roles — roles-admin.controller.ts:154, @RequirePermission(auth.roles.manage); returns {roles, assignableScopes}`
- `POST /admin/users/:id/roles — roles-admin.controller.ts:202, auth.roles.manage`
- `DELETE /admin/users/:id/roles/:assignmentId — roles-admin.controller.ts:256, auth.roles.manage`
- `GET /opd/departments — opd-masters.controller.ts:271 (opd.masters.read)`
- `POST /opd/departments — opd-masters.controller.ts:278 (opd.masters.manage)`
- `PATCH /opd/departments/:id — opd-masters.controller.ts:289`
- `GET /opd/rooms — opd-masters.controller.ts:303`
- `POST /opd/rooms — opd-masters.controller.ts:310`
- `PATCH /opd/rooms/:id — opd-masters.controller.ts:321`
- `GET /opd/doctors — opd-masters.controller.ts:335`
- `POST /opd/doctors — opd-masters.controller.ts:342`
- `GET /opd/doctors/:id — opd-masters.controller.ts:353`
- `PATCH /opd/doctors/:id — opd-masters.controller.ts:361`
- `GET /opd/doctors/:id/schedules — opd-masters.controller.ts:375`
- `PUT /opd/doctors/:id/schedules — opd-masters.controller.ts:381 (full replace; opdAdmin.replaceHint is the copy)`
- `GET /opd/leaves?doctorId= — opd-masters.controller.ts:402`
- `POST /opd/leaves — opd-masters.controller.ts:409; returns {leaveId, affectedAppointmentIds}`
- `POST /opd/leaves/:id/cancel — opd-masters.controller.ts:420`
- `GET /staff — staff.controller.ts:67 (staff.reports.read)`
- `GET /staff/:userId/brief?period=&date= — staff.controller.ts:82 (staff.reports.read)`
- `POST /staff/:userId/drill — staff.controller.ts:121 (staff.reports.drill); writes staff_report.drilled`
- `GET /me/report — desk.controller.ts:84, NO @RequirePermission (self-scoped by URL, DD4)`
- `GET /me/brief?period=&date= — desk.controller.ts:105, no permission`
- `GET /me/report.csv — desk.controller.ts:137, no permission (downloadReportCsv, desk-api.ts)`
- `GET /me/desk — desk.controller.ts:64 (used by counter-figures, which shares my-day's components)`

**Claimed missing (VERIFY — the critic corrected several):**

### Reuse, do not reinvent

- apps/web/src/components/agent-dock.tsx — AgentDock + the `logged` reducer (:155-159, caps the log at 40). Mount one per screen. F2 is bound locally inside it (:63-70). Only two screens carry it today (opd-appointments, patient-detail); these four make it 3-6.

- apps/web/src/screens/desk-one/desk-one.css — the `.pp` primitives. Import is already global: router.tsx:24 statically imports DeskOne, which imports the stylesheet (desk-one.tsx:28), so `.pp` rules are in the main bundle on every route. Do NOT re-import per screen and do NOT copy rules into a second file.

- apps/web/src/styles/paper-pine.css — the six palette values, defined ONCE. `.pp` must be added to its selector list (see risks).

- apps/web/src/screens/opd-appointments.tsx:499 — the canonical `.pp` mount; :559-577 the pill-tab idiom with roles preserved; :453-475 the shape of an honest `ask` callback that names its source.

- apps/web/src/screens/patient-detail.tsx:857 — the second `.pp` precedent: a two-column 'who on the left, amendable record on the right' division, useful for /staff (subject picker left, figures right).

- apps/web/src/screens/desk-one/dossier.tsx and stages.tsx — the language itself: how a rail holds a person, how a stage advances, how a refusal lands inline.

- apps/web/src/components/submit-button.tsx — SubmitButton's synchronous ref latch. Already used by admin-users.tsx for every row write; keep it, `disabled` alone does not stop the second click.

- apps/web/src/components/form-kit.tsx — FormKit/TextField/SelectField. REUSE AS-IS OR HAND-ROLL, but do NOT restyle it: it is imported by 8 screens (admin-users, opd-admin, opd-consult, opd-desk, ops-mode, ops-downtime-kit, change-password, patient-detail).

- apps/web/src/screens/my-day.tsx — SectionTable and BriefPanel are EXPORTED and consumed by counter-figures.tsx:7. Changing them changes a second screen.

- apps/web/src/lib/admin-api.ts, lib/opd-api.ts, lib/desk-api.ts — every call these screens need already exists and is typed; no new client functions are required.

### Permissions

- auth.users.manage — opens /admin/users (NAV row router.tsx:119; every route on users-admin.controller.ts)

- auth.roles.manage — opens the role picker ONLY (GET /admin/roles, assign, revoke). A 403 here is NOT an error: a delegate holding users.manage but not roles.manage correctly sees the roster with no assign control (admin-users.tsx:64-73). The catalogue query is `retry: false` for exactly this reason (admin-users.tsx:110).

- opd.masters.manage — NAV row for /opd/admin (router.tsx:104) and every write on opd-masters.controller.ts

- opd.masters.read — every read on /opd/admin

- staff.reports.read — opens /staff (NAV row router.tsx:131). Held by medical_superintendent (seed-roles.ts:581) and staff_auditor.

- staff.reports.drill — the drill only. Its own role, `staff_auditor` (seed-roles.ts:650), deliberately narrow, seeded holding NOBODY. Memory notes the grant to a named human is still owed.

- /my-day — NO permission. desk.controller.ts's /me/* routes carry no @RequirePermission; self-scoping is structural (there is no userId to tamper with). /my-day is also absent from NAV — it is reached by the command palette and the dashboard.

- NOTE: no seeded role in seed-roles.ts holds auth.users.manage or auth.roles.manage. They are declared in kernel/auth/manifest.ts:8-9 and reach production through the single bootstrap admin — consistent with 'production still has ONE full admin'. This screen must not change that; it renders the fullAdministrators<2 warning (admin-users.tsx:~180) rather than fixing it.

### Keyboard

- F2 — focus the agent ask box. Bound LOCALLY inside AgentDock (agent-dock.tsx:63-70), not globally; it arrives free with the component on all four screens. This is the owner's ruling ('F2 will be dedicated to pull agent') and keyboard.tsx:133-147 keeps F2 unbound globally as the reservation.

- / — command palette (global, keyboard.tsx:33 shouldOpenPalette). Inherited, not bound here.

- F4 — new patient (global, keyboard.tsx:98). Inherited.

- F7 — the book (global). Inherited.

- Esc — release / back. Inherited; counter-figures.tsx:79-87 shows the correct local pattern (guard with isTypingTarget AND palette.isOpen).

- Ctrl+Enter — confirm. The only Ctrl chord any browser leaves alone (keyboard.tsx browserSafeKey).

- Tab — per the Keymap artboard, the main instrument: 'one pass, top to bottom, no backtracking and no reaching for the mouse.' These are form screens; tab order in the order a clerk asks the questions is the whole keyboard story here.

- BIND NOTHING NEW GLOBALLY. F8/F9 are browser-free but deliberately unbound (keyboard.tsx:149-155): a keycap nothing implements is a dead key, 'which is the precise mistake F2 is here to stop repeating.' Every keycap drawn must be bound — FD-23's close review caught the dock drawing an unbound F2 and the fix was to bind it, not to redraw it.

### Risks

- THE BIG ONE — `.pp` HAS NO PALETTE, AND IT IS BROKEN IN PRODUCTION TODAY. apps/web/src/styles/paper-pine.css:28-31 defines the tokens for `.d1, .lg, .dash, .shell` and NOT `.pp`. router.tsx:282 puts `.shell` on the <header>, and router.tsx:390-401 renders <Outlet/> as a SIBLING of that header — so a `.pp` screen has no ancestor defining --paper/--ink/--dim/--faint/--line/--line2/--wash/--green/--gold/--red/--agent/--agent-fg/--agent-dim/--mint. Verified: `grep -rn -- '--agent:' apps/web/src` returns paper-pine.css and nothing else. FIX BEFORE WRITING ANY SCREEN: add `.pp` to that selector list. Without it these four screens ship the same defect as opd-appointments.tsx:499 and patient-detail.tsx:857.

- WHY NOBODY CAUGHT IT: --card IS defined at styles.css:20 as `oklch(1 0 0)`, so `.box` and `.in` still get a white background and only the BORDER falls back to currentColor. The screens look 80% right, which is exactly the FD-2 failure mode the owner reported as 'the SCREEN, not the server'.

- WORST SINGLE CASUALTY: desk-one.css:114 `.stamp.un { border: 2px solid var(--gold) }`. An unresolved var in a SHORTHAND makes the whole declaration invalid at computed-value time, so border-style falls back to `none` — the UNPAID stamp renders with no outline at all. Same for `.stamp.pd` (:115).

- SECOND CASUALTY: agent-dock.tsx:78 sets `background: var(--agent)` inline. Unresolved -> transparent, and `color: var(--agent-fg)` -> inherits. The speaks-on-dark rule (desk-one.css:117-124), the one rule that tells a clerk what the machine touched, silently inverts.

- NO TEST CAN CATCH ANY OF THE ABOVE. opd-appointments.test.tsx:297 asserts `document.querySelector('.pp')` is non-null — class presence. jsdom computes no CSS custom properties. This is the FD-2 pattern in memory verbatim: '117 testid-based tests passed on an unreadable search row.' Verify in the live browser (preview.sh on :8443), not in vitest.

- `data-lang` IS NEVER STAMPED ON `.pp`. desk-one.tsx:1169 sets `data-lang={i18n.language.startsWith('hi')?'hi':'en'}` on `.d1`; opd-appointments.tsx:499 and patient-detail.tsx:857 set nothing, so `.pp[data-lang='hi']` (desk-one.css:217-224) can never match and every Devanagari `.tag` falls back to whatever face the terminal has. Stamp it on all four roots. shell-nav.test.tsx:261-268 is the assertion pattern to copy.

- CROSS-SCREEN COUPLING: counter-figures.tsx:7 imports BriefPanel and SectionTable from ./my-day. Restyling my-day silently restyles /counter/figures — which wears `data-seat="registration-counter"` (counter-figures.tsx:90), a block (styles.css:254-282) that defines only SHADCN token names (--background/--card/--foreground/--border/--muted-foreground) plus --seat-faint. It does NOT define --dim/--faint/--line2/--wash/--green. Either add `pp` to counter-figures' root class too, or keep those two components on Tailwind. Its 8 tests are in the blast radius.

- my-day.test.tsx:112 does `screen.getByRole('table').querySelector('tfoot')` — it needs a LITERAL <tfoot> element, not a role. Converting SectionTable to `.drow` divs breaks it, and the totals row is 'the server's arithmetic, rendered rather than recomputed'. Keep the real <table>/<tfoot> and style it, or change the test deliberately and say so.

- ROLE/LABEL PINS THAT A RESTYLE WILL DROP: my-day.test.tsx:109 getByRole('columnheader',{name:'Visit no'}); my-day.test.tsx:244 aria-pressed on the period buttons; staff-reports.test.tsx:57 getByLabelText('Staff member'); staff-reports.test.tsx:87 getByRole('button',{name:'Open the rows'}); opd-admin.test.tsx:53 getByRole('tab',{name:'Schedules & leaves'}); opd-admin.test.tsx:75-76 getByLabelText('Code')/('Name'); admin-users.test.tsx:278 getByRole('option',{name:/cashier — Cashier \(2 permissions\)/}). 43 tests across the four files, all role/label/text-based.

- THE LABELS COME FROM FormKit. form-kit.tsx:86 and :116-117 mint `htmlFor={`f-${name}`}` / `id={`f-${name}`}`. Every getByLabelText above depends on it. If you hand-roll `.in` fields you must hand-roll matching label/id pairs — FD-23 hit this and its commit records the fix: 'the filters use real <label htmlFor> rather than a styled .tag div, because three tests and every screen reader find those fields by their label.'

- DO NOT RESTYLE form-kit.tsx. It is imported by 8 screens; changing it reaches opd-consult, opd-desk, ops-mode, ops-downtime-kit, change-password and patient-detail — six screens outside this task, in other lanes.

- AgentDock has NO `no-print` class (agent-dock.tsx:77). /my-day's whole purpose is a printed, signed, filed shift report. `body * { visibility: hidden }` (styles.css:173) does hide it, but it is not `display:none` so it still takes a page box. Add `no-print`, and keep the rule that exactly ONE `.print-doc` may exist per screen (my-day.tsx header: two of them OVERPRINT rather than making two pages).

- AgentDock's F2 handler (agent-dock.tsx:63-70) is a bare window listener with no dialog or typing guard. On /admin/users, pressing F2 while the reset panel is open yanks focus out of it to the dock. Compare counter-figures.tsx:80, which guards on both isTypingTarget and palette.isOpen.

- isTypingTarget (keyboard.tsx:6-8) covers INPUT, TEXTAREA and contentEditable — NOT SELECT. /staff and /opd/admin are select-driven (the subject picker, the doctor picker, the department picker); pressing `/` with a <select> focused opens the command palette instead of doing option type-ahead.

- admin-users.tsx:110 catalogue is `retry:false` and a 403 there is the CORRECT rendering of a boundary (11e CLOSE restored it). A redesign that renders the assign control unconditionally, or that turns the 403 into an error banner, re-opens a closed finding.

- opd-admin.tsx:24 polls three master queries at 15 s (D6: realtime pushes are hints, this surface has no topic). Do not convert to realtime while restyling.

- admin-users.tsx uses role='status' NOT role='alert' for the two-admin warning, with a comment explaining why: the list refetches after every write and `alert` re-announces assertively, interrupting a screen reader mid-row. Preserve the distinction when moving that node into a `.pill gd`.

- seed-roles.test.ts pins permission counts at :832 (157), :1028 (302 pairs), :1046 (137), :1117 (143). NOT touched by a restyle — but any impulse to 'give staff_auditor to someone' or add a permission trips all four.

- caddyfile-parity.test.ts:373 pins `routes.toHaveLength(48)`. All four routes are already counted (:391 /my-day, :394 /staff, :404 /admin/users). Adding a route to this screen — a /admin/roles tab on its own path, say — breaks it and must be measured, never predicted.

### Locale

Namespaces all exist already in BOTH files at matching line numbers: `adminUsers` (en.json:1131), `opdAdmin` (:330), `staffReports` (:1845), `myDay` (:1782), `brief` (:1797), plus nav labels at :19/:31/:52. The delta is small and follows FD-23's precedent exactly — that commit added only 2 keys per screen. Budget ~8 required (`askPlaceholder` + `agentIdle` per screen, one honest sentence each naming what that screen's agent can actually see) plus ~10-20 optional for new subtitle/empty-state copy in the counter's voice. HARD CONSTRAINT: apps/web/src/lib/i18n.test.ts:11 pins hi.json key-for-key against en.json — every key lands in both files in the same commit or the web suite goes red.

### Shared files this screen touches

SERIALIZE ON THESE — every one is shared with another screen or lane. (1) apps/web/src/styles/paper-pine.css:28-31 — adding `.pp` to the palette selector list is a one-line edit that ANY other lane doing a `.pp` conversion needs identically; land it first, alone, and tell the other lanes. It is also the fix for the two FD-23 screens already shipped broken. (2) apps/web/src/locales/en.json AND hi.json — i18n.test.ts:11 pins them key-for-key; both files, same commit, or the web suite is red. (3) apps/web/src/screens/my-day.tsx — its exported SectionTable/BriefPanel are consumed by counter-figures.tsx:7, a different screen with its own 8 tests. (4) apps/web/src/components/agent-dock.tsx — shared with opd-appointments and patient-detail; a no-print class or a focus guard added here changes both. (5) apps/web/src/components/form-kit.tsx — 8 consumers; treat as read-only. (6) apps/web/src/screens/desk-one/desk-one.css — only if a new primitive is genuinely needed; new rules must carry BOTH `.d1` and `.pp` per the file's own rule. NOT TOUCHED, and say so in the PR: apps/web/src/router.tsx (all four routes and NAV rows already exist and are correct), apps/core/test/caddyfile-parity.test.ts (route count unchanged at 48), apps/core/scripts/seed-roles.ts + seed-roles.test.ts (no permission changes), and the entire server — every endpoint these screens need already exists.

---

# The shared-file plan — what must happen ONCE, up front

## router.tsx

- IMPORTS (add beside the existing screen imports, router.tsx:20-66). Only two are new — /billing, /opd/vitals and /opd/consult already import their components: BillingCounter (router.tsx:34), VitalsBay (router.tsx:31), OpdConsult (router.tsx:33). Add:
  import { Registration } from "./screens/registration";
  import { AppointmentSeat } from "./screens/appointment";
The T0 commit MUST also create those two screen files as minimal placeholders, or the shared commit does not typecheck and every screen agent is blocked on the same file.

- NAV ROWS (inside `const NAV`, router.tsx:91-208; the shape is `{ to, label, permission, group }` — the third field `group` is required, and nav-parity.test.ts:76 parses this table with a regex that tolerates fields in any order but throws on zero matches). Add:
  { to: "/registration", label: "nav.registration", permission: "patients.register", group: "desk" },
  { to: "/appointment", label: "nav.appointment", permission: "opd.appointments.manage", group: "desk" },
Place them beside the existing `/counter` row at router.tsx:99. New locale keys `nav.registration` and `nav.appointment` do NOT exist today (the `nav` namespace has 41 keys and neither is among them) — they go into en.json AND hi.json in the same T0 commit.

- ROUTE CONSTS (declare beside counterDeskRoute at router.tsx:531 and vitalsBayRoute at router.tsx:567):
  const registrationRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/registration",
    validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
      new: search.new === true || search.new === "true" ? true : undefined,
    }),
    staticData: { fullViewport: true },
    component: Registration,
  });
  const appointmentRoute = createRoute({
    getParentRoute: () => authedRoute,
    path: "/appointment",
    validateSearch: (search: Record<string, unknown>): { patientId?: string } => ({
      patientId: typeof search.patientId === "string" ? search.patientId : undefined,
    }),
    staticData: { fullViewport: true },
    component: AppointmentSeat,
  });
The `?new=true` shape is copied verbatim from counterDeskRoute (router.tsx:542-544); the F4 global chord in lib/keyboard.tsx currently targets /counter and the handoff's Routing.dc.html is the authority on which seat it should target after the split — decide it in T0, not later.

- addChildren ARRAY (router.tsx:891-930, inside `authedRoute.addChildren([...])`). Add `registrationRoute, appointmentRoute,` next to `counterFiguresRoute,` (router.tsx:904) / `vitalsBayRoute,` (router.tsx:905), with the census-moving comment the file's own convention requires (every prior wave left one: see the FD-2, PLAN 14 T9, PLAN 15 T8, PLAN 17b T8, PLAN 18a T9 and PLAN 16c T5 comments at router.tsx:898-928).

- staticData.fullViewport — THE ONE ROUTER FIELD MOST LIKELY TO CAUSE A SECOND ROUND OF EDITS, so decide it for all five in T0. It is declared at router.tsx:238-242 (`interface StaticDataRouteOption { fullViewport?: boolean }`), read at router.tsx:382-383 off the ACTIVE MATCHES (`s.matches.some((m) => m.staticData.fullViewport === true)`), and used to choose the body at router.tsx:390: when true the shell renders `<Outlet />` alone — no header, no ModeBanner, no PatientStrip, no ShortcutLegend, none of them in the DOM at all. Only counterDeskRoute carries it today (router.tsx:549). Any screen rooted on `.d1` MUST carry it: desk-one.css:38-49 makes `.d1` `position: fixed; inset: 0; z-index: 40` with an opaque `var(--paper)` ground, and the FD-11 defect (an invisible, tabbable, screen-reader-announced shell underneath) is exactly what happens without it. Since the handoff (§5) says all five screens are built FROM desk-one's components and CSS, add `staticData: { fullViewport: true }` to registrationRoute, appointmentRoute, billingRoute (router.tsx:787), vitalsBayRoute (router.tsx:567) and opdConsultRoute (router.tsx:771) in T0. If a screen turns out not to be `.d1`-rooted, removing the flag is a one-line edit for the final integration commit — far cheaper than five agents each discovering they need it.

- DECIDE THE FULL ROUTE LIST IN T0, INCLUDING SUB-ROUTES. Any later `/registration/...` or `/billing/...` child route is a second router.tsx edit AND a second caddyfile census move — i.e. two shared-file collisions. `/counter/figures` (router.tsx:576) is the precedent for a per-seat sub-route; if the three seats each want one, declare all of them now.

## The route census

CURRENT PIN: `expect(routes).toHaveLength(48)` at apps/core/test/caddyfile-parity.test.ts:373, inside the test `PLAN 11g — no SPA route falls inside a Caddy-proxied prefix (smoke-test D1)` (caddyfile-parity.test.ts:292). I ran it just now: `pnpm --filter @hmis/core exec jest -w 1 test/caddyfile-parity.test.ts` → PASS, 6/6, 0.578 s. So 48 is the true current value, green.

WHAT ALSO CHANGES — three assertions on lines 374-376 that FD-9 wrote to record the deletion and which FD-25 reverses:
  caddyfile-parity.test.ts:375  expect(routes).not.toContain("/appointment");   → must become toContain
  caddyfile-parity.test.ts:376  expect(routes).not.toContain("/registration");  → must become toContain
Leaving them as `not.toContain` makes the suite fail for the right reason but by the wrong name; flipping them is the point of the pin.

WHAT IT BECOMES: /billing, /opd/vitals and /opd/consult are ALREADY in the census (they are existing routes being redesigned, not new ones), so only /registration and /appointment are additions. Arithmetic says 48 → 50. **That number must be MEASURED, not written from this arithmetic.** The test's own docstring is explicit and the file records nine prior waves that obeyed it — "MEASURED, not predicted: the previous value 23 was observed failing with `Received length: 24` before it was moved" (caddyfile-parity.test.ts:299-302), and again at :306, :310, :313, :318, :323, :332, :356 and the FD-23 rebase note at :368-372: "the number below is what the merged tree MEASURED, not what this arithmetic predicted." The procedure is: add the routes, run the file, read `Received length: N` off the failure, write N.

THE PARSER TRAP THAT WILL BITE AN AGENT: `spaRoutePaths` (caddyfile-parity.test.ts:212-221) is `source.matchAll(/\bpath:\s*"(\/[^"]*)"/g)` over the RAW FILE TEXT — comments included. It is deduped (`[...new Set(paths)]`), which is why the file measures 49 raw matches and 48 unique today: `path: "/opd/vitals"` appears at router.tsx:563 inside a JSDoc comment and at router.tsx:569 as the real route. Harmless when the comment quotes a path that IS a route; a comment quoting a path that is NOT a route silently inflates the census by one. Tell every agent: do not write `path: "/…"` in a router.tsx comment for anything that is not a declared route.

SECOND CENSUS, EASILY MISSED: apps/web/src/shell-nav.test.tsx:91-92, in the test `FD-9: a counter clerk is offered Desk One, and it is the only front-desk row in the nav` (shell-nav.test.tsx:86), asserts `expect(hrefs).not.toContain("/registration")` and `expect(hrefs).not.toContain("/appointment")`. Once the NAV rows exist, a clerk holding `patients.register` + `opd.appointments.manage` sees both and this web test goes red. Update it in T0 (assert each row appears exactly once, and that the three seats are three distinct rows) rather than deleting it — it is the guard that caught FD-1's two-doors defect.

## Locales

SHAPE. apps/web/src/locales/en.json and hi.json are 3165 lines each and have EXACTLY 68 top-level keys each — one namespace per screen or per shared vocabulary, appended chronologically, never sorted. Recent namespaces sit at the file tail: `registrationCounter` en.json:2341, `vitalsBay` :2679, `pharmacyItems` :2868, `pharmacyErrors` :2891, `pharmacyCounter` :2920, `appointmentSeat` :2997, `aerb` :3038. `nav` is at en.json:15 with 41 keys.

THE PARITY TEST AND ITS BLINDNESS. apps/web/src/lib/i18n.test.ts is thirteen lines: `keyPaths` flattens each file to dotted paths and asserts `expect(keyPaths(hi).sort()).toEqual(keyPaths(en).sort())`. It is a SET COMPARISON between the two files and nothing else. A key present in neither file is invisible to it, and i18n.ts (lib/i18n.ts:8-13) sets no `parseMissingKeyHandler` and no `saveMissing`, so `t("registration.nope")` renders the literal string "registration.nope" on the screen with zero test signal. Every look-defect this lane has paid for (FD-11's five, FD-24's photo buttons) was of exactly this class: green suites, wrong screen.

CLOSE THE HOLE IN T0. Add a NEW web test (a new file, so it is not itself a shared file) that walks apps/web/src for literal `t("ns.key")` calls and asserts each resolves in en.json. Precedent for the technique is already in the tree: caddyfile-parity.test.ts:196-221 and nav-parity.test.ts:60-83 both parse web sources as text from a core test, and membership/guardrails.test.ts reads web screen sources. Both throw rather than return empty (§2.49) — copy that discipline. This is the single highest-value item in the whole T0 commit: it converts the five agents' most likely silent defect into a failing test.

NAMESPACE ALLOCATION — measured, not guessed. I counted `t("<ns>.` references across apps/web/src:
  · `registrationCounter` — 175 refs, live, consumed by screens/desk-one/{stages,dossier,photo}.tsx and counter-figures.tsx. CONTENDED: the /registration agent will reuse it heavily (it builds from desk-one), and Desk One still owns it. Additive edits only; nobody reorders it.
  · `vitalsBay` — 93 refs, live, the /opd/vitals agent's alone.
  · `opdConsult` — 86 refs, live, the /opd/consult agent's alone.
  · `billing` (8 direct children) + `billingDues` / `billingSession` / `billingOffice` — 78 refs, live, the /billing agent's.
  · `appointmentSeat` — 35 keys, ZERO refs. Orphaned when FD-9 deleted `/appointment`. The natural home for the new /appointment screen: revive it, do not mint a sibling.
  · `register` — 36 keys, 35 refs, and NOT the registration screen's: its only consumers are screens/patient-detail.tsx and screens/merge-review.tsx. It is shared field vocabulary. The /registration agent must NOT claim it.
  · Dead weight, for information: `counter` (39 keys, 0 refs), `opdVitals` (14 keys, 0 refs), `counterSlip` (6), `attach` (4), `assurance` (4). Verify with a dynamic-key grep before deleting anything; deletion is optional and belongs in T0 if done at all, never in a screen PR. (`materialsErrors`, `otErrors`, `pharmacyErrors` also show zero literal refs but are error-code lookups — leave them.)

THE COLLISION AND THE FIX. Five agents appending five new namespaces at the tail of the same two files is a five-way conflict on the last twenty lines, twice. T0 must therefore RESERVE the blocks: create every namespace each screen will use — `registration`, `appointment` (or the revived `appointmentSeat`), plus the `nav.registration` / `nav.appointment` keys and any admin-reskin namespace — in BOTH files, in one commit, each pre-populated with the key skeleton the artboards imply (title, section headings, the stage names from Routing.dc.html). After that each agent only ADDS keys INSIDE its own already-existing block, bounded above and below by unchanged lines, which is what git's three-way merge resolves cleanly. Rules for the agents: never reorder a namespace, never touch another agent's block, and every new string lands in en.json and hi.json in the same commit — the parity test only catches the second half of that rule.

ESCALATION IF THIS RECURS. The structural fix is to split the locales into per-namespace fragments (apps/web/src/locales/en/*.json + hi/*.json) assembled in lib/i18n.ts, with i18n.test.ts re-pointed at the assembled objects. That is one commit and it removes locales/*.json from CLAUDE.md's coordinate-first list permanently. It is a bigger change than FD-25 needs and I would not put it in T0 unless the lane expects more parallel screen waves.

## Permission gaps

- cashier → `tariff.read` — REQUIRED, AND IT IS A LIVE DEFECT TODAY, NOT JUST AN FD-25 NEED. The billing counter's line editor calls `listServices()` (apps/web/src/lib/billing-api.ts:311 → `api("GET", "/tariff/services")`) from screens/billing-counter.tsx:174. That route is `@RequirePermission("tariff.read", "hospital")` at apps/core/src/modules/tariff/tariff.controller.ts:144. `cashier` (seed-roles.ts:372-390) holds eleven permissions and not one `tariff.*`. Neither does `billing_manager` (seed-roles.ts:392-501). The only holders of `tariff.read` in the whole model are `doctor` (seed-roles.ts:208), `owner` (:522) and `tariff_editor` (:662). So on the deployed system nobody who works the billing counter can read the service catalogue their own screen searches. Worth reporting to the owner as a found defect, separately from FD-25.

- cashier → `patients.read` — REQUIRED IF /billing WEARS THE PATIENT RAIL. components/patient-strip.tsx and screens/desk-one/dossier.tsx both fetch `GET /patients/:id`, which is `@RequirePermission("patients.read")` at apps/core/src/modules/patients/patients.controller.ts:305 and :316. `cashier` holds NO `patients.*` string at all. `billing_manager` does hold `patients.read` and `patients.register` (the 07b O-1 counter-cover seven), which is why nobody has hit this yet. The redesigned cashier screen cannot show who it is billing without this grant.

- cashier → `opd.visits.read` (probably) and `opd.visits.open` (for print) — the counter is entered as `/billing?encounterId=…` (router.tsx:791-794); resolving that encounter to a person is an `opd.visits.*` read, and `cashier` holds no `opd.*` string at all. Separately, the FD-24 print-status poll `GET /printing/jobs?encounterId=` and `POST /printing/reprint` are BOTH `@RequirePermission("opd.visits.open", "hospital")` (apps/core/src/kernel/printing/printing.controller.ts:156 and :193 — the docstring's reason is "anyone who may create the slip may see whether it printed"). `opd_payment_receipt` is a declared document kind (kernel/db/schema/printing.ts:43, kernel/printing/enqueue.ts:28) that nothing enqueues yet; the moment /billing prints a receipt and shows its status, the cashier needs `opd.visits.open` or that guard has to be re-cut. Do NOT widen the guard to make the screen work — CLAUDE.md forbids it; grant the permission.

- vitals_desk → `opd.visits.open` — ONLY for the vitals slip. Everything Bay One actually calls is already covered: `GET /opd/bench` is `opd.queue.read` (opd-visits.controller.ts:503), `POST /opd/visits/:id/bench-state` and the four escalation routes are `opd.vitals.record` (:514, :536, :543, :554, :571), `GET /opd/visits/:id/prestage` is `opd.vitals.history.read` (:526) — and vitals_desk holds all three (seed-roles.ts:155-172, pinned at six permissions). The gap is only the FD-24 print pair above: `vitals_slip` is a declared document (enqueue.ts:30, destination `vitals_thermal` at :58) whose renderer returns null deliberately pending owner ruling R3's artboard (render.ts:433). If /opd/vitals shows print status or offers a reprint, vitals_desk needs `opd.visits.open`.

- doctor → `opd.visits.open` — same print pair. The A4 prescription (`opd_prescription`) is enqueued at visit-open by the front desk (apps/core/src/modules/opd/encounters.ts:212), but it is the DOCTOR's document; a consult screen that shows whether the prescription printed, or offers a reprint after an amendment, hits printing.controller.ts:156/:193 and `doctor` (seed-roles.ts:176-272, pinned at twenty) holds no `opd.visits.*` write string. Everything else the doctor's screen needs is already granted: `opd.consult`, `formulary.read`, `tariff.read`, `patients.read`/`.update`, the three `orders.*`, `lab.orders.place`/`.results.read`/`.catalogue.read`, `radiology.orders.place`/`.reports.read`.

- registration clerk (`front_office`) → NO GAP on the registration path itself. `POST /opd/triage` (opd-visits.controller.ts:231), `POST /opd/visits` (:316), `POST /opd/walk-in` (:340) and `POST /opd/visits/:id/join-queue` (:357) are all `opd.visits.open`, which front_office holds alongside `patients.register`/`.read`/`.update` (seed-roles.ts:86-104, pinned at twelve). The one standing hole is `patients.confidential.read`, still in NOT_YET_MODELLED (seed-roles.ts:1252-1257) awaiting an owner ruling — a confidential patient is invisible at the counter. Pre-existing, owner-gated, not FD-25's to close.

- appointment clerk → THERE IS NO SUCH ROLE. The 38 role keys are pinned at apps/core/test/seed-staff.test.ts:231 and none of them is an appointment seat; `front_office` already holds `opd.appointments.read` and `opd.appointments.manage` (seed-roles.ts:89-90). DECIDE THIS ONCE IN T0: (a) the appointment seat IS `front_office` — zero permission churn, zero count moves, and the standard Indian-corporate-hospital answer since one clerk covers both windows on a light day; or (b) mint `appointment_clerk`, which costs KNOWN_ROLE_KEYS 38 → 39 (seed-staff.test.ts:231 and the explicit list at :137-230), a LOCAL_ROLE_TITLES entry (seed-roles.ts:1365, pinned as a sorted list at seed-roles.test.ts:1315-1330), a new per-role count in the map at seed-roles.test.ts:905-1011, and every census below. Recommend (a).

- WHAT EVERY GRANT COSTS — this is why the permission work cannot be split across five PRs. apps/core/test/seed-roles.test.ts pins, in one file: the per-role permission counts (`front_office: 12` :905, `front_office_supervisor: 16` :911, `vitals_desk: 6` :912, `doctor: 20` :922, `cashier: 11` :941, `billing_manager: 20` :947); `modelPairs()` = 302 (:1028); `modelPermissions()` = 137 (:1046); `installedRegistry().allPermissions()` = 157 (:832, :1057); `heldPermissions()` = 143 (:1117); `NOT_YET_MODELLED` = 14 (:1120); the closure `held + not-yet = 157` (:1121); and `NON_TABLE_PAIRS` = 132 (:1490). Beyond the numbers, the test parses README.md's markdown permission tables and compares them to ROLE_MODEL IN BOTH DIRECTIONS (seed-roles.test.ts:37, :1131-1224 — seven tables, with rowCount/cells/tablePairs pinned per table). Any (role, permission) pair that is neither a tick in a README table nor a member of one of the named non-table constants (RULING_7_PAIRS, DOCTOR_TARIFF_PAIRS at :368, LAB_PAIRS, RADIOLOGY_PAIRS, PHARMACY_PAIRS, …) FAILS — and each of those constants is anchored to a README PROSE LINE the test quotes verbatim (:61, :77, :97, :127, :155, :181, :212, :237, :263, :317). So `cashier/tariff.read` needs: the grant in seed-roles.ts, a new named pair constant plus a verbatim README prose sentence, a cashier count bump 11 → 12, a modelPairs bump, a NON_TABLE_PAIRS bump, and README.md edited. Five agents each doing that to the same integers is five guaranteed rebase conflicts on two files.

## Recommended sequencing

SEQUENCE IT AS T0 → FIVE PARALLEL LANES → T6, WITH T0 MERGED TO MAIN BEFORE ANY SCREEN AGENT STARTS.

T0 — "FD-25 T0: the shared surfaces, once." One commit, one PR, one agent, nothing else in it. Contents, all of which are shared-file or count-pinned work:

1. apps/web/src/router.tsx — the complete final route table for all five screens AND the admin re-skin: both new imports, both new route consts (with `validateSearch` decided from Routing.dc.html), both addChildren entries, both NAV rows, and `staticData: { fullViewport: true }` on all five seat routes. Decide sub-routes now. After T0 no screen agent opens this file again.
2. apps/web/src/screens/registration.tsx and apps/web/src/screens/appointment.tsx as minimal placeholders — without them T0 does not typecheck, and each becomes the private property of exactly one agent.
3. apps/core/test/caddyfile-parity.test.ts:373-376 — run the test, read `Received length: N`, write N (expected 50, MEASURE IT), and flip the two `not.toContain` assertions.
4. apps/web/src/shell-nav.test.tsx:86-93 — re-express the FD-9 nav assertions for three seats instead of one.
5. apps/core/src/modules/patients/manifest.ts:21 (`menu: []` → the `/registration` entry) and apps/core/src/modules/opd/manifest.ts:13-31 (`+ /appointment`), so router.tsx's NAV and the manifests agree, per nav-parity.test.ts.
6. apps/web/src/locales/en.json + hi.json — reserve every namespace and the two `nav.*` keys, in both files, with skeletons.
7. apps/core/scripts/seed-roles.ts + apps/core/test/seed-roles.test.ts + README.md — ALL seat grants in one edit: `cashier` gains `tariff.read`, `patients.read`, `opd.visits.read`, `opd.visits.open`; `vitals_desk` and `doctor` each gain `opd.visits.open`; plus the DECIDED ruling on the appointment seat's role. Every one of those moves the same handful of pinned integers, so they must be one commit or they are N rebase conflicts.
8. A new apps/web/src/lib/i18n-keys.test.ts asserting every literal `t("ns.key")` in apps/web/src resolves in en.json. New file, not shared, and it closes the parity test's blind spot before five agents start writing strings into it.

Verify T0 with: `pnpm typecheck && pnpm lint`, then `pnpm --filter @hmis/core exec jest -w 2 test/caddyfile-parity.test.ts test/nav-parity.test.ts test/seed-roles.test.ts test/seed-staff.test.ts` and `pnpm --filter @hmis/web exec vitest run src/shell-nav.test.tsx src/lib/i18n.test.ts src/lib/i18n-keys.test.ts`. Paste the counts. T0 is done when those are green AND the census number was read off a run, not written from arithmetic.

THEN THE FIVE LANES. Each agent owns a disjoint file set and is told, explicitly, that the six shared files are FROZEN for the duration: router.tsx, both locale files (outside its own reserved namespace block), caddyfile-parity.test.ts, seed-roles.ts + seed-roles.test.ts, README.md. Ownership:
  · /registration → screens/registration.tsx + tests + locale namespaces `registration` and additive-only into `registrationCounter`
  · /appointment → screens/appointment.tsx + tests + the revived `appointmentSeat`
  · /billing → screens/billing-counter.tsx + tests + `billing*`
  · /opd/vitals → screens/vitals-bay*.tsx + tests + `vitalsBay`
  · /opd/consult → screens/opd-consult.tsx + tests + `opdConsult`
Shared primitives (components/agent-dock.tsx, patient-strip.tsx, patient-picker.tsx, desk-one/*, desk-one.css) are read-only to all five; a primitive change goes back to whoever owns T0 rather than being made in a screen PR — desk-one.css says so itself ("one definition — do not fork it").

Stack the five PRs rather than branching them all off main: with eight lanes and branch protection's up-to-date rule, parallel PRs off one base cycle behind forever (memory: stacked-prs-under-branch-protection). And never resolve a shared file with `--ours` when merging main into a task branch — take main's copy and re-apply your hunks.

T6 — integration. One agent, one commit, for whatever genuinely could not be decided in T0: removing a `fullViewport` flag from a screen that turned out not to be `.d1`-rooted, re-pointing the desk tiles in apps/core/src/modules/patients/desk-provider.ts:109-130 from `/counter` to `/registration` (deliberately deferred, because it depends on the owner's unresolved §3.2 ruling on whether `/counter` survives), and any census move a sub-route forced.

THE ONE THING THAT MAKES THIS FAIL. If T0 leaves a decision open that later needs a shared file, the whole scheme collapses to sequential work. The three decisions most likely to do that, in order: (a) `fullViewport` per screen, (b) the search params each seat hands the next (Routing.dc.html is the authority — read it before writing T0), (c) whether the appointment seat is `front_office` or a new role. Settle all three in T0 and mark them DECIDED in the phase doc.

---

# The critique — corrections and the honest verdict

## Ground truth first: the tree is not the tree these specs were written against

The session snapshot says branch `lane/front-desk-fd7-t9` at `9af37bf`. The actual lane is `lane/front-desk-fd24` at `7ff1f58`, **6 commits ahead of `origin/main` and 0 behind, nothing pushed, no PR** (`git rev-list --left-right --count origin/main...HEAD` → `0 6`; `tools/lane.sh status` → `+6/-0`). The handoff's §8 is unambiguous: *"Do not start FD-25 on top of an unpushed FD-24; this lane spent a whole afternoon chasing a 73-commit branch and the lesson was expensive."* **Neither the six specs nor the shared-file plan mentions this once.** The plan's T0 opens by editing `router.tsx` on this branch.

That is not pedantry. Every line number in these specs that touches FD-24's delta — `kernel/printing/printing.controller.ts`, `kernel/printing/enqueue.ts`, `render.ts`, `lib/print-api.ts` — describes code that **does not exist on `origin/main`**. The plan tells five agents to stack PRs; they would be stacking on an unmerged base. Four peer lanes are live (`radiology +28/-7`, `lims +1/-2`, `pharmacy +1/-7`), and `/opt/hmis` is `+0/-41` with a dirty file.

## Endpoints claimed MISSING that are real gaps (verified)

These check out and I'd trust them: no UHID preview (`grep -rn "next-uhid\|nextUhid\|previewUhid"` → nothing; `allocateUhid` has no HTTP surface); no clinician lab-order route (`grep -rn 'RequirePermission("orders.place"\|RequirePermission("lab.orders.place")'` → zero hits, the only lab-order POST is `lab-desk.controller.ts:121-122` on `lab.desk.operate`); no phone on `PatientSummary` (`registration.ts:776-785`, confirmed no contact field); no date bound on `needsRebooking` (`appointments.ts:209-220` supports only exact `serviceDate`); and the no-show sweep really is `lt(serviceDate, today)` at `appointments.ts:235`, so the appointment spec's "3 missed is permanently zero" risk is correct.

## Endpoints claimed MISSING that are wrong, and one that is dangerously wrong

**The billing spec's corporate-panel gap is misdiagnosed.** It says *"nothing anywhere returns the panel's NAME, the employee/member number... do not invent a panel name client-side."* The data exists and is already being written. `apps/core/src/kernel/db/schema/patients.ts:363-407` defines `patient_coverages`; `patients.controller.ts:104-117` accepts `kind`, `payerName`, `tpaName`, `policyNumber`, `employeeId`, `planClass`, `sumInsuredPaise`, `validTo`, `verificationStatus`. That is the artboard's "East Central Railway · employee 41129" line, field for field. It is inserted at `registration.ts:326`.

And it is **write-only**. `grep -rn "patientCoverages" apps/core/src` returns the schema, the insert, and `registration.test.ts` — nothing else. No endpoint reads it back. So (a) the required work is a read over a populated table, not a modelling exercise, which changes the estimate; and (b) **this is an unreported server-built-never-wired defect of exactly the class this lane's memory records three times for the OPD counter.** Desk One collects coverages today (`session.ts` `CoverageDraft`/`EMPTY_COVERAGE`, which the registration spec lists as reusable) and nothing in the product can ever read one. Neither the registration nor the billing spec flags it.

**The vitals spec's `"missing": []` is false.** `vitals_slip` is a declared `PrintDocument` (`enqueue.ts:30`) with a destination (`enqueue.ts:58`) that nothing enqueues — the only two `enqueuePrintJob` call sites in the tree are `encounters.ts:203` (token slip) and `:211` (prescription) — and that deliberately renders null (`render.ts:433`, pinned by `render.test.ts:176`). Handoff §3.3 names this as one of only **four** things to ask the owner. The vitals spec does not mention printing at all.

**The billing spec's `missing` list omits the same class of gap.** `opd_payment_receipt` is a declared kind (`enqueue.ts:28`) with a destination (`:56`) and **zero enqueue call sites**. The artboard's footer, "prints the receipt and stamps the token PAID," is not served by FD-24's outbox; the spec discusses only browser-side `invoice-print.tsx`.

**The shared-file plan has the print routes at the wrong path.** It says `GET /printing/jobs` and `POST /printing/reprint`. The controller is `@Controller("print")` (`printing.controller.ts:77`) → `/print/jobs` (`:155`), `/print/reprint` (`:192`). The specs get it right; the plan doesn't.

## The plan and the specs contradict each other on the single most expensive decision

The plan calls `staticData.fullViewport` *"THE ONE ROUTER FIELD MOST LIKELY TO CAUSE A SECOND ROUND OF EDITS, so decide it for all five in T0"* and then decides: add it to `registrationRoute`, `appointmentRoute`, `billingRoute`, `vitalsBayRoute` and `opdConsultRoute`.

Four of the five specs say the opposite, explicitly. Billing: *"/billing lives INSIDE the app shell and must NOT wear `.d1`."* Vitals: *"Safer default: use `.pp` inside the shell like FD-23 did... and leave fullViewport alone."* Consult: *"THE SHELL QUESTION IS ALREADY DECIDED BY PRECEDENT... it wears `.pp` and NOT `.d1`."* Admin: all four wear `.pp`.

The plan's version is not a harmless flag. `router.tsx:382-390`: when true the shell renders `<Outlet />` alone — the header, `ModeBanner`, `PatientStrip` and `ShortcutLegend` are **not in the DOM**. `/billing` is entered as `/billing?encounterId=…` (`router.tsx:789-796`) precisely as a hand-off; stripping `PatientStrip` off it is a live regression on a shipped route, applied in the commit that is supposed to unblock everyone else. Landing this in T0 does not save a round of edits; it buys three of them.

## Other places two specs disagree, or one is simply wrong

**nav-parity.** The registration spec: *"A NAV row for /registration needs a matching manifest entry with an IDENTICAL permission string... otherwise CI reds."* False. `nav-parity.test.ts:186-190` computes `nav.filter((n) => menu.has(n.to))` — the **intersection only**. A NAV row with no manifest entry passes. The appointment spec states this correctly. The plan follows the wrong one and makes T0 item 5 (editing `patients/manifest.ts:21` and `opd/manifest.ts:13-31`) mandatory when it is optional.

**Census arithmetic and line numbers.** The registration spec says the pin is at `caddyfile-parity.test.ts:385-387` and goes 48→49. It is at `:373`, with the negatives at `:375` (`/appointment`) and `:376` (`/registration`), and the series moves it 48→50. I ran it: `pnpm --filter @hmis/core exec jest -w 1 test/caddyfile-parity.test.ts test/nav-parity.test.ts` → **2 suites, 9 tests, all pass, 1.591 s**. So 48 is the true green value. The plan is right here; the registration spec is not.

**`Routing.dc.html` is not what the plan thinks it is.** The plan makes it the authority for the F4 target and for *"the search params each seat hands the next"*, and lists that as one of the three decisions whose failure *"collapses the whole scheme to sequential work."* I read the file. It is the **walk-in doctor-routing artboard** — `/registration → the visit`, "28 waiting in the building", "walk-in now / future appointment", "TWO DOORS, EQUAL WEIGHT". `grep -o "patientId\|?new=\|encounterId\|search="` returns **nothing**. There is no seat-to-seat handoff spec in it. The handoff §4's table label ("routing between the three") is what misled the plan.

**Extraction vs copy on `stages.tsx`.** Registration: *"THE CORRECT MOVE IS EXTRACTION, NOT A COPY."* Appointment: *"extract `History` and `slotClock` by copy-with-attribution rather than refactoring a file the /counter work is actively editing."* Plan: `desk-one/*` is *"read-only to all five."* Three positions on one file. And the registration spec undercounts the blast radius: it names four Desk One test files; **six** render DeskOne (`corrections`, `routing-rules`, `sidebars`, `registration-fields`, `appointment-panels`, `triage-debounce`).

## Verified-correct findings worth keeping (so they don't get lost in the noise)

The `.pp` palette hole is real and is the single best item in the whole package: `paper-pine.css:28-31` scopes the tokens to `.d1, .lg, .dash, .shell` and `grep -n '\.pp'` on that file returns nothing, while `grep -rn -- '--paper:'` returns exactly one hit. Two shipped screens (`opd-appointments.tsx:499`, `patient-detail.tsx:857`) are live with it.

The confidential-registration 400 is real: `session.ts` has `isConfidential` (`:132`, `:153`) and **no `alias` field at all**; `desk-one.tsx:417` sends `isConfidential` alone; `registration.ts:179-180` throws `alias_required`. Ticking that box at the counter fails today.

`MEMBER_BENEFITS_ENABLED` is set in no `.env` (`apps/core/.env`, `.env.example`, `docker/prod/.env.prod.example` all checked) — the billing scheme rail is inert by default, as claimed. One correction: `listServices` is **not** called unconditionally; `billing-counter.tsx:174-176` gates it on `enabled: debouncedServiceQuery.trim().length >= 2`. Still a live 403 for a cashier who types two characters, but the spec overstates it in a document that claims measurement.

Locale counts are exact: en 2657 / hi 2657 leaves, 68 top-level keys each; `appointmentSeat` has 35 keys and zero references; `nav.registration` and `nav.appointment` do not exist. `seed-roles.test.ts` pins are exact (`:832`/`:1057` = 157, `:905` front_office 12, `:912` vitals_desk 6, `:923` doctor 20, `:938` cashier 11, `:1028` = 302, `:1046` = 137, `:1117` = 143, `:1120` = 14, `:1121` closure). `stages.tsx` anchors are all correct (StageFind `:84`, Field `:252`, Picker `:273`, Fold `:305`, GRID3/4 `:343-344`, StageRegister `:346`, slotClock `:1213`, FutureTab `:1219`). The `away` bench state really is unreachable: `BENCH_STATES` includes it (`bench.ts:43`) and `vitals-bay.tsx:359` is the only caller, passing `"resting"`.

The plan's proposed `i18n-keys.test.ts` is justified: `lib/i18n.ts:8-13` sets no `parseMissingKeyHandler` and no `saveMissing`, and `i18n.test.ts` is a thirteen-line set comparison. Keep that item.

## Risks nobody listed

**A second agent dock exists.** `screens/desk-one/dock.tsx` is Desk One's own, coupled to `useDesk()`. The plan declares `components/agent-dock.tsx` shared and read-only and never says what happens when `/registration` lifts Desk One's registration stage but mounts the *other* dock. Two docks, one "speaks-on-dark" law, guaranteed drift.

**`data-lang` on `.pp` is a three-screen defect, not a two-screen one.** `desk-one.css:217,220` does scope `.pp[data-lang="hi"]`; neither `.pp` mount stamps it. The admin and consult specs catch this. Registration, appointment and billing do not — so all three would ship the identical Devanagari defect FD-10/FD-11 already paid for.

**Two headers.** The registration, appointment and billing artboards each draw their own top bar ("CRK | Registration" + mono `/registration` + the Esc search button). All three specs then say mount as `.pp` inside the shell, copying `opd-appointments.tsx:499`. But `opd-appointments.tsx:499-506` draws a *title*, not a header bar — so the precedent does not answer the question, and following it literally yields two stacked header bars. This is the same question as `fullViewport` and nobody resolves it in either direction.

**Granting `cashier` `patients.read` is a privacy widening, not a decision.** The plan puts it in T0 as one of six new pairs alongside `tariff.read`, `opd.visits.read`, `opd.visits.open`. `billing.controller.ts:503-507` documents in the codebase's own words that the cashier holds no `patients.read`. CLAUDE.md reserves owner rulings for "money, procurement and law"; widening who may read patient identity under DPDP is law. That belongs in the same list as the scribe, not in a shared-file commit.

Minor: test counts are inflated. Vitals is **45** tests across five suites, not 49 (measured: 10/7/1/11/16). `billing-counter.test.tsx` is **14**, not 16. Consult's 24 is right.

## Does the parallelisation story hold? No — and not for the reason the plan thinks

T0 as written does not free the lanes, because **three of the five screens must add primitives to `desk-one.css`** and the file's own header forbids forking it. Billing needs `.lane` and `.lrow` (verified absent; `.drow` at `:141` has the wrong padding and a hover). Vitals needs `.rail` (`:153`), `.top` (`:149`), `.ovl` (`:135`), `.lock` (`:143`) and `.frame` (`:146`) promoted from `.d1`-only to `.pp`, and there is no `.tile` anywhere. Consult needs its own narrow story because the `@media (max-width: 1220px)` block is `.d1`-scoped. None of those can be pre-landed in T0 because nobody knows the exact rules until the screens are written. So `desk-one.css` serialises the CSS work no matter what T0 does, and the plan's "read-only to all five" is a rule three specs already break.

The genuinely unparallelisable set, in order:

1. **`desk-one.css` primitive additions** — unforkable by design law, needed by 3 of 5, unknowable at T0.
2. **`stages.tsx`** — if the registration spec's extraction is right (it is), then `/appointment` consumes what `/registration` extracts, and the two are strictly sequential with a six-file Desk One test blast radius between them.
3. **`seed-roles.ts` + `seed-roles.test.ts` + `README.md`** — the plan is correct that this must be one commit; it is also an owner question.
4. **The core suite.** 383 core test files, ~15 min per CLAUDE.md, which bans a concurrent run while a peer is testing. Four peer lanes are live and `lane.sh` reports 9 Claude sessions on terminals. Every screen touching the census, nav-parity or seed-roles needs a core run and none of them can overlap.

What is *not* the constraint: the web suite. I measured it — **91 files, 704 tests, 40.8 s wall clock**, all green. That is not what slows this down.

## Honest verdict on one session

No, and the handoff already says so in §7: *"This is not one session of work... Attempting it in one pass produces five half-screens, which is worse than two finished ones."* The specs and the plan silently overrule that without arguing against it, which is the most serious thing in the package.

**The binding constraint is browser verification, not shared files.** The definition of done says *"seen in a real browser before you call it done,"* and this lane's entire recorded history is defects that only looking found while suites stayed green: FD-2's five, FD-9's three money/data defects, FD-11's five look-defects, FD-24's photo buttons. There is **one** preview (`/opt/hmis-preview/preview.sh` on :8443) against **one** dev DB (`hmis_fd_dev`), which the handoff §8 says is currently broken on migration numbering and must be dropped and re-migrated and re-seeded. Five parallel agents cannot look at five screens through one port; and `/billing`'s centrepiece renders nothing at all until `MEMBER_BENEFITS_ENABLED` is set, which is per-environment, not per-lane. Shared files are the visible problem and the plan handles most of them competently; the eyeball is the actual serialiser, and it is one eyeball.

Second constraint is the core suite under four-lane contention. Third is `desk-one.css`. Shared files are fourth.

Two items in scope are not parallelism problems at all and should be pulled out of the estimate: the **voice scribe** is blocked on a DPIA revision (handoff §3.1 — law, owner, default (c) is UI-only), and the **admin re-skin** is five screens sitting behind `form-kit.tsx`, which eight screens import and which the admin spec correctly marks read-only, against 43 role/label-pinned tests.

What I would actually recommend: land T0 **minus** the `fullViewport` blanket and **minus** the cashier grants; raise `fullViewport`/two-headers, the cashier privacy grants, the vitals slip (§3.3) and the scribe (§3.1) to the owner as one list; push and merge FD-24 first per §8; then build `/registration` alone, do the `stages.tsx` extraction once inside that PR, and let `/appointment` consume it. That is the handoff's own order, and nothing I checked in the repo argues against it.