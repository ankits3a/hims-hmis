# Central Lab stations — the approved board (plan 17-F spec)

**This board is the spec for plan 17-F** (`docs/superpowers/plans/2026-09-26-17f-lims-stations.md`).
Where the plan and the board disagree on what a screen shows or does, the board wins until the owner says
otherwise; where the board and the code disagree on a rule, the plan names the gap and the phase that closes it.

- **Live artifact:** https://claude.ai/artifact/Q55XsWxk8h4rpBK7XfhAN2, **version 19** (26 Sep 2026).
  The page's `<title>` still reads "Lab Reception Counter" because that is where it started.
- **Copy in the repo:** `lab-stations.html`. It is byte-identical to the artifact's page body as published
  (the publish wrapper `<!doctype html>…<body>` / `</body></html>` is the only difference). It is a single
  self-contained file of vanilla JS with synthetic data; open it in any browser, no build step.
- **Built with the owner, station by station, 25–26 Sep 2026.** The owner rejected a simulator first and asked for
  "each station's dashboard and a working clickable menu/tabs screen … match the 3-column screen design format".

## The six stations

The header's station switch (Reception · Collection · Bench · Verify · Supervisor) moves between them; Reports is a
view inside Reception, not its own station.

1. **Reception** (counter L-01). Work starts from a *visit*: the left lane lists the patient's visits today and the
   centre turns that visit's prescription into an order — Tests → Checks → Bill → Token — with a pinned dock whose
   Enter runs the next act. A second visit's order joins the same lab token (one draw); a test on both visits is billed
   once. No discount at the counter (a request goes to the Supervisor, at most 10%), wallet deduct-only, reflex consent
   as an optional check, and a walk-in with no UHID is sent to the front desk.
2. **Collection** (the chair). Opens on "Scan the slip or search the patient"; opening a patient means they have
   arrived. A scan identifies and prints labels; the draw table shows each tube (drawing, barcode, printed and filled
   times) in order of draw. Refusals: `arm_restricted`, `not_fasting` (hold up to 7 days or rebook free),
   `draw_not_due`, `identity_recheck_required`, `relabel_witness_required`. A bell icon calls the token; it changes no
   state.
3. **Bench, by patient and by run.** Receiving a tube starts the turnaround clock. *By patient*: each test group
   offers "From the analyser | Run on Curio | Type values"; a physically impossible value needs a second named person
   (`absurd_value`, `sod_violation`); a QC-locked analyser with no backup refuses typing (`no_backup`). *By run*: a
   grid of an instrument's run; complete the clean patients in one act, exceptions stay unticked (critical, haemolysed,
   big change, blast flag). Run-sheet instruments (EL-120, U120, Curio Lab Gen 1) are loaded by scanning tubes.
   Instruments & QC shows a Levey-Jennings chart; a 2-2s failure locks the analyser. Critical calls climb a ladder
   that closes only on a correct read-back.
4. **Verify & Release** (Dr. Radhika Iyer). An all-normal batch signs in one act, logged per report, behind a PIN
   asked every 15 minutes (`signature_pin_required`, `signature_pin_wrong`). "Needs your eye" opens a patient: send one
   value back for a rerun, preview the NABL report, sign. A partial report signs now and returns as amendment v2; a
   correction needs a reason code (`amendment_reason_required`). HIV reactive is in person only; notifiable results
   get a drafted IDSP L-form entry for the supervisor to send.
5. **Reports** (a view inside Reception). One release register, sorted by what needs action. Hand-over names the
   collector (patient / relative with name, relation and OTP consent / ward / courier): `collector_required`,
   `collector_details_required`, `patient_consent_required`. HIV: counselling recorded first, patient alone with ID,
   sealed envelope (`counselling_required`, `in_person_only`). A held copy is released unpaid by the billing manager
   only (`release_not_authorised` for anyone else).
6. **Supervisor** (Meenakshi Das). "Escalated to you" is built from every station's own clocks once they run out;
   each escalation needs an act (do it, page, take over, or accept with a reason — `reason_required`), and unacted for
   15 minutes pages the head of department. Also: the floor (pipeline by stage, bench load, instruments, turnaround
   median / 90th percentile, rejections, counters), Approvals (discounts ≤10%, bench open/close, downtime), the
   NABL 112 quality week (EQAS shown as a gap) and the roster.

## Layout rules the board obeys (owner, 25 Sep)

Menu in the header. Left lane = the patient, run or escalation in hand. Right = one list with no filter tabs, then
"Clocks running" collapsed. Opening something shrinks the list to one line and opens the copilot panel. Dark colour
only as a highlight. No button that only records presence. The next act sits in a pinned dock and Enter runs it.
Nothing in the centre duplicates the right-hand list.

## Widths checked

1920, 1440, 1280, 1100, 1024, 768 and 390 px — no sideways scroll at any of them (walk output `overflow 0`).
Breakpoints: the list becomes a drawer below 1280, the nav becomes a Menu below 1100, and the station switch moves
into the Menu at 1000 and below.

## Owner comments acted on

All eight comment threads on the artifact are resolved:

- Removed the "Next at the counter" card, the five-tile stats row and the "Needs reception" card: the right-hand list
  already shows that. "Median at counter" moved to the lane's "your day" block.
- Removed the Quick actions row (header menu covers it).
- Removed "Register walk-in" everywhere: the patient registers at the front desk (ruling 6).
- Merged "Release to the counter" into "Clear the desk" / Esc, which now drops the claim.
- Made the copilot panel, Clocks, ask bar and answer popup light cards; dark only as a highlight.

And the rulings given in conversation, v2–v19: menu in the header and no list filters (v2); the copilot zooms in as
the list shrinks (v3); work starts from a visit, two visits share a token (v10); the barcode draw table as on the
1 Sep canvas (v12); "we are complicating this" — no presence buttons (v13); the Bench drafts by run as well as by
patient, Curio Lab Gen 1 as backup (v15–v16); report hand-over lives in Reception (v18); the Supervisor approves
discounts, the 4.5 s self-approval removed (v19).

## Walks

`walks/` holds the seven Playwright walks that drove every station. Each prints `ERRORS: none` (no page errors);
the ones that sweep widths also print `overflow 0` per width.

| Script | Station |
| --- | --- |
| `rwalk3.cjs`, `rfarida.cjs` | Reception |
| `rcol2.cjs` | Collection |
| `rbench2.cjs` | Bench, by run and by patient |
| `rverify.cjs` | Verify & Release |
| `rrel.cjs` | Reports |
| `rsup.cjs` | Supervisor |

They load `../lab-stations.html` relative to themselves, so run them from anywhere:

```
node docs/design/2026-09-25-lims-stations/walks/rsup.cjs
```

They need `playwright-core` and a Chromium, which are not repo dependencies. The defaults are this build host's
(`/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`,
`/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`, run with `--no-sandbox`); override with
`PLAYWRIGHT_CORE=…` and `CHROME=…`. Screenshots go to `$SHOTS`, default `$TMPDIR/lims-stations-shots`, never into
the repo. They are Playwright, not jest or vitest, so the test lock does not apply — but each launches a browser, so
run them one at a time. Do not edit the HTML while a walk runs.

Test gotchas: ids containing `~` break CSS selectors (use `[id="…"]`); at 1000 px and below the station tabs are in
the Menu, so clicks run at 1440.

## Relation to earlier boards

The 1 Sep canvas (`../2026-09-01-lims-central-lab/`) supplied the people, numbering, instruments and the barcode
table. This board supersedes its layout (menu-in-sidebar, filter tabs, tiles) under the 25 Sep layout ruling.
