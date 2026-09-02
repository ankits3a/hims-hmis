# Phase 17c — Five seats, one tube (LIMS series, 3 of n)

**Lane: LIGHT** (6 tasks, no new module, no migration — EXECUTE-METHOD-V3 §2).
**Stop-loss: 1,920,000** = main-session `6 × 200,000` + task-subagent `0` (§2.143a) + review `240,000 × (1 + 2.0)` (§2.145, the repair term 17a paid for). Comparables: 17b per task 123–145k; close pass ~240k.
**Balance at kickoff: ~14.85M** (§2.141; deltas per task in CLOSE).
**Lane:** `/opt/hmis-lanes/lims/hmis`, branch `lane/lims`, own test DBs; `origin/main` at `5feef43`. **One task = one PR**: commit by pathspec, push, `gh pr create`, `gh pr merge --squash --auto`; CI is the gate; locally only the touched suites; `tools/lane.sh status` before any full run; rebase on `origin/main` each morning.

## 1. Why this phase

17a and 17b are closed, green, undeployed. Their four screens are one-tube-one-person worklists in greyscale: the desk takes a raw `patientId` and `encounterNo` in two text boxes, the chair prints labels nobody can see, the bench cannot be scanned, the pathologist sees no previous value, and there is no report centre. The design series (`docs/design/2026-09-01-lims-central-lab/`, boards 0–5) drew the five working seats in flow order on one patient, Farida Khatoon T-118; the owner's brief is **seats, not scoreboards**.

Measured first (§2): 17a/17b shipped **three rails with no consumer** — the registration series' pattern, three times there, three times here. Rule for this phase: **a rail ships with its consumer in the same PR**.

**Finish line:** one patient through reception, collection, bench, verify and delivery over HTTP (T6) plus a web test per seat. No deploy (prod at 46 migrations, one administrator — 17b §9.9).

## 2. Ground truth — measured 2026-09-02 at `5feef43`; re-measure at kickoff

| # | rail | where | consumer today | 17c |
|---|---|---|---|---|
| 1 | `advisedTestItems` (consult Rx lines → desk) | `desk.ts:174` | **NONE** — no route, no screen | T1 |
| 2 | `LAB_REALTIME_NAMES` (10), `labTopicRouter` | `realtime.ts:50` | **NONE** — no `lab-*.tsx` calls `useRealtime`; 6 OPD screens do | T3 |
| 3 | `printLabels` → ids + `lab.label_printed` | `specimens.ts:125` | **no label rendered anywhere** | T2 |
| 4 | Six events without `orderGroupId` (17b F43), off realtime | `events.ts` | — | T3 |
| 5 | Topics: `lab:{orderGroupId}`, `lab_critical` only — no department space for tube/result events | `realtime.ts:59` | — | T3 |
| 6 | Collection queue row: no token, no draw order | `collection.ts:76` | chair | T2 |
| 7 | `GET /lab/collection/specimen/:no` carries no patient by design | chair | bench needs arrivals | T3 |
| 8 | `WorklistRow.analytes`: no previous value, no TAT target | `worklist.ts:35` | verify | T4 |
| 9 | Report readers by `reportId` / `orderId` / `encounterNo`; **none by patient, no delivery register** | `reports.ts` | verify | T5 |
| 10 | `printReport` channel + `collectorIdentity` + `approvalId`; `deliveryAllowed`; `lab.release_unpaid` approval (`billing_manager`) | 17b T7 | verify | T5 |
| 11 | `patient_lab_report_ready` values-free, `waApprovalStatus: not_submitted`; adapters `whatsapp`/`sms`; no email | `kernel/notify` | publish | unchanged |
| 12 | `entry_mode` admits `interface`; no writer | `results.ts:60` | — | 17-E |
| 13 | `EnterResultInput` = one analyte per call | `results.ts:62` | bench | kept (D6) |
| 14 | `DeskOrderInput.credit`; `lab_reception` holds `billing.credit.extend` | `desk.ts:98` | desk | D3 |
| 15 | `listVisits` filters status/department/doctor/date — **no token**; `queueEntry.tokenNo` on the item | `opd-visits.controller.ts:80` | — | S1 |
| 16 | `RegisterPanel`, `FindPanel`, `seatKey`, `usePaletteOptional`, `PatientPicker`, `LabReportPrint`, `[data-seat="registration-counter"]` | web | RC seat | reused |
| 17 | 4 roles, 15 permissions | seed-roles | — | **0 new permissions, 0 new roles** |
| 18 | 4 lab paths in NAV + manifest menu; `caddyfile-parity` is `≥`; `nav-parity` compares NAV to menus | — | — | T5 adds one |
| 19 | `lab.e2e.test.ts` walks desk → print, one patient | `test/` | — | T6 |

## 3. Spike — answered by reading at kickoff, 0 subagents

- **S1 — the token door.** No OPD export resolves `tokenNo` → encounter. T1's `find` calls `listVisits({serviceDate})` and matches the token inside the lab module (the day's list never crosses the wire). If that read needs an `opd.*` permission `lab_reception` lacks, a separate tiny OPD PR adds `findVisitByToken` **before T1**, never inside it.
- **S2 — credit without an approval.** Does `deskOrderAtCounter` accept `credit` from a `billing.credit.extend` holder with no `approvalId`? If not, D3's unbilled line goes through `addOnOrder` after settlement and "bill it here" is the only door.
- **S3 — ANSWERED.** `labTopicsFor` keys on the order group; a bench watching all groups has nothing to subscribe to. T3 adds a department topic (`lab_bench`, permission `lab.worklist.read`) for the tube and result events, beside `lab_critical`.
- **S4 — second enterer.** The shipped bench takes a `users.id` for the absurd voucher (`lab-bench.tsx:14`). Kept unless an index export offers a login lookup; otherwise recorded, not fixed.

## 4. Design decisions — DECIDED; none is money, procurement or law

- **D1 — Desk One for all five seats.** A seat is a place a person stands all day, like the registration counter; one language per seat class. One `[data-seat="lab"]` block in `styles.css` with the same token VALUES as `registration-counter` (copied, not `:root` — RC-3's own mutant). Portalled surfaces stay neutral (RC-3's limit).
- **D2 — Paths stay.** The four screens are rewritten in place. One path is added, `/lab/reports`, on `lab.reports.print` (held by `lab_reception` and `pathologist`).
- **D3 — The unbilled Rx line is CREDIT.** Board 1's "on the Rx, not billed" line rides the same order with `credit: {reason: "rx_line_unpaid"}` (S2). The tube is drawn; DD23's group interlock holds the report until settled — what the board draws. A slip pre-paid at the front desk is a billing-hub change: out (§6).
- **D4 — One field, three doors.** `GET /lab/desk/find?q=`: `UH…` → patient (`searchPatients`), `T-n` → today's visit (S1), `L…` → order. Names confirm, never select (edge 2). Register-in-place reuses `RegisterPanel` (edge 3).
- **D5 — Order of draw is a client constant** (`blood_culture → citrate → SST → heparin → EDTA → fluoride`, keyed on `container`). A label is a 50 × 25 mm Code128 SVG from `specimenNo`, browser-printed; no ZPL.
- **D6 — Per-analyte entry stays.** Each call is its own audit row, envelope and ladder; the seat sequences N calls with N idempotency keys.
- **D7 — The bench scan resolves in two lists**: the worklist (received), then a new arrivals reader (collected / in transit today, restricted filter as `collectionQueue`). Neither → "not drawn here today". No new PHI surface.
- **D8 — Realtime is restored at the emitters.** `events.ts` is no longer frozen: the six F43 events gain `orderGroupId`, return to `LAB_REALTIME_NAMES`, and route to `lab_bench` (S3). Consumers ship in the same PR.
- **D9 — Delivery is 17b's rails on their own seat.** Doctor's screen never waits (`listResultsForEncounter`); patient copy = the values-free notice + counter print with collector. **No WhatsApp PDF, OTP, email or "send again"** (template unapproved; 22c-F owns the patient link). HELD reads `deliveryAllowed`; release is the shipped approval.
- **D10 — No agent bar.** The boards' "lab agent" strip needs an agent surface that does not exist (RC-4: `agent_ledger` is a comment).
- **D11 — Previous value = last VERIFIED value of the analyte on the canonical patient** (merge chain, edge 5); never an unverified or superseded row.

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · Reception
**Files:** `lab/lab-desk.controller.ts` (`GET find`, `GET advised`), `lab/desk.ts` (preview adds `tubes[]`), `lab/lab-http.ts`, `lab/desk.test.ts`, `test/lab.e2e.test.ts`, `web/lib/lab-api.ts`, `web/screens/lab-desk.tsx` (+test), `web/styles.css` (D1), `locales/{en,hi}.json` `lab.desk.*`.
Seat: header (counter, person, IST clock, counts), portal list (today's orders awaiting collection via `collectionQueue`), the one field (D4), Rx lines from `advised` with billed / credit per line (D3), duplicate warning, tubes panel, priority, **Save — send to collection** (`deskOrder`).
**Assertion book:** `find` by `T-n` returns the ONE visit holding that token today plus its advised lines; mutant — match on patient name; input — two same-name patients, one token; kill — 2 hits vs 1. Second: a credit line's item carries `invoice_id` and `deliveryAllowed` says held until settled.
**Commit:** `feat(lab): reception seat — one field three doors, the Rx lines get a consumer, unpaid line on credit (17c T1)`

### T2 — CRITICAL · Collection
**Files:** `lab/collection.ts` (`tokenNo` joined from `opd_queue_entries` by encounter; `null` on a lab walk-in), `lab/collection.test.ts`, `web/components/specimen-label.tsx` (+test: Code128 encoder, print CSS), `web/screens/lab-collection.tsx` (+test), `web/lib/lab-api.ts`, locales `lab.collection.*`.
Seat: queue (STAT first, then arrival; token shown), patient card (fasting, note, wristband scan = `printLabels.scannedUhid`), tubes in draw order (D5) with print and per-tube `collect`, **Drawn — to the lab** only when every tube is scanned; recollections in the same queue.
**Assertion book:** labels render SST before EDTA before fluoride and each barcode decodes to its `specimenNo`; mutant — rank reversed; kill — order inverted. Second (server): the row carries the OPD token when one exists, `null` for a walk-in.
**Commit:** `feat(lab): collection seat — the token on the row, order of draw, the first printable label (17c T2)`

### T3 — CRITICAL · Bench, and realtime restored
**Files:** `lab/events.ts` (`orderGroupId` on six payloads), emitters in `lab/collection.ts`, `accession.ts`, `results.ts`, `verify.ts`, `lab/events.test.ts`, `lab/realtime.ts` + `.test.ts` (six names back; `lab_bench` space), `lab/worklist.ts` (`benchArrivals`), `lab/lab-bench.controller.ts` (`GET arrivals`), `web/screens/lab-bench.tsx` (+test; `useRealtime` on `lab_bench` and `lab_critical`), `web/lib/lab-api.ts`, locales `lab.bench.*`.
Seat: three columns (arrived not received / on the bench / results in), scan field (D7) → Receive starts TAT, grid per analyte (D6) with flag and arrival stamp, absurd second enterer (S4), reject with attribution, critical calls, **Save & complete** when every analyte has a value.
**Assertion book:** `labTopicsFor(lab.specimen_collected)` yields `lab_bench` and `lab:{group}` (was `[]`); mutant — payload without `orderGroupId`; kill — `[]` vs 2. Second (web): a collected-not-received S number shows Receive and no patient name until received.
**Commit:** `feat(lab): bench seat — scan to identify, arrivals column, six realtime events routed again (17c T3)`

### T4 — ROUTINE · Verify
**Files:** `lab/worklist.ts` (`previous {value, at}` per D11, `tatTargetMinutes`), `lab/worklist.test.ts` (new), `web/screens/lab-verify.tsx` (+test), `web/lib/lab-api.ts`, locales `lab.verify.*`.
Seat: queue (criticals and STAT first, oldest), TAT elapsed / target, open-call state, prev + delta beside each value, **Sign N & publish** (sequential `verifyResult`, then `publishReport`), sign-hold-publish, rerun, partial publish, preview via `LabReportPrint`.
**Assertion book:** `previous` is the last VERIFIED value on the canonical patient; mutant — latest row by `entered_at` regardless of status; input — an unverified later row on a merged loser; kill — wrong value.
**Commit:** `feat(lab): verify seat — the previous value, the clock against its target, sign-all (17c T4)`

### T5 — CRITICAL · Delivery, the fifth path
**Files:** `lab/reports.ts` (`reportsForPatient`, `deliveryRegister` — alias rule + `phi_access_log` like `getReport`, never the raw snapshot: 17b C1's shape), `lab/reports.test.ts`, `lab/lab-verify.controller.ts` (`GET reports/patient/:patientId`, `GET reports/register`), `lab/lab-http.ts`, `lab/manifest.ts` (menu "Report centre"), `web/router.tsx` (route + NAV appended), `web/screens/lab-reports.tsx` (+test), `web/lib/lab-api.ts`, locales `lab.reports.*` + `nav.labReports`; `nav-parity` and `caddyfile-parity` read, not edited.
Seat: register (published today: doctor's screen · patient copy · how it went out · signed at), the one field (UHID / mobile via `PatientPicker`), report card with the verdict, **Print & hand over** with collector name and relation, HELD with the unpaid amount and the approval path, sensitive = in person only.
**Assertion book:** `reportsForPatient` on a sealed patient returns the alias and writes ONE `phi_access_log` row per call; mutant — `select()` without the projection; kill — legal name present. Second (e2e): HELD prints nothing; the print lights after `settleInvoice`.
**Commit:** `feat(lab): report centre — reports by patient, the delivery register, the fifth lab path (17c T5)`

### T6 — ROUTINE · The walk and the CLOSE
**Files:** `test/lab.e2e.test.ts` (one `it`: find → advised → order with a credit line → labels → collect ×3 → arrivals → receive → results → verify with `previous` → partial publish → register HELD → settle → print with collector; every row read back), `docs/runbooks/lab-go-live.md` (seat drill), this doc §8.
**Commit:** `test(lab): one patient through five seats over HTTP; runbook drill; 17c CLOSE`

**Verify economy:** per task `pnpm typecheck && pnpm lint`, then only the named `lab/*.test.ts`, `test/lab.e2e.test.ts`, `test/nav-parity.test.ts` (T5), `vitest run screens/lab-*`. CI runs everything on every PR.

## 6. Out of scope — named so nobody infers them

Instrument inbox and bridge (17-E, board 6); send-outs (17-M, edge 9); camp bulk registration (edge 10); a slip pre-paid at the front desk (billing hub); WhatsApp PDF, OTP portal, email, "send again", Hindi report headings (edge 25); call-ladder contacts (edge 17); sex/age impossibility rule (edge 15); witnessed re-label (edge 12); downtime screen (edge 20); the agent bar (D10); page-2 boards. Carried from 17b untouched: F29, F31, F35, F36, F37, F44 (`lab.reflex_refused` waits for a reader).

## 7. Owner rulings — none

Nothing here is money, procurement or law; Desk One vs greyscale is D1. **Owner ACTIONS, unchanged from 17b:** a second administrator for DD11's separation of duties; WhatsApp template submission (`not_submitted`) before any patient message; the four lab role keys assigned (runbook §0, F39).

## 8. CLOSE — filled at execution

§8.0 §2 re-measured · §8.1 PRs and CI SHAs · §8.2 findings · §8.3 assertion book as executed · §8.4 evidence (suite counts, CI run ids) · §8.5 close review: two fresh passes, pass 2 briefed at the fixes (§2.140) · §8.6 actuals vs stop-loss.

### 8.1 T1 — Reception (executed 2026-09-02)

- **A FOURTH unconsumed rail:** `openLabWalkin` (17a A9) had no caller outside its own tests — a walk-in with an outside prescription could not be ordered through any route. T1's `deskWalkinOrder` is its first consumer; `POST /lab/desk/orders` takes `encounterNo` XOR `walkIn`.
- `GET /lab/desk/advised` was FOLDED into `find`: a visit hit carries its Rx lines, so the seat asks once. Preview also carries `tubes[]` in **order of draw** (D5's rank lives server-side in `DRAW_ORDER`; the chair reuses it in T2).
- The fixture's UHIDs (`HMS-…`) are not the production shape, so the UHID door is asserted on a REGISTERED patient. The fixture's fake `V` resolver cannot see a real walk-in visit (17a `d1f316b`'s lesson); desk.test and the e2e swap in the real reader on the real row, and `opd/encounter-resolver.test.ts` pins the real registration.
- `preview` accepts no `encounterNo` for a walk-in — billing prices it as self-pay (`resolveEncounter` returns `self` on an absent id).
- Mutant A1 applied and killed: the token door admitting every same-name patient returned 2 hits against 1. Evidence: `desk.test.ts` 22/22, `errors`, `money`, `lab.e2e` — 4 suites 44 tests; web `lab-desk.test.tsx` 6/6 + i18n parity; typecheck 0, lint 0 errors.
- Branch hygiene: PR #2 was squash-merged while T1 was in flight; `origin/main` was MERGED into `lane/lims` rather than rebased, because the lane's commits were already pushed and the rule is never to rewrite pushed history. Squash-merge flattens it on `main`.

### 8.2 T2 — Collection (executed 2026-09-02)

- **F1 — the shipped collection screen rendered fields the server never sent.** `WireCollectionRow` (17b T8) declared `patientDisplay`, `waitingMinutes`, `labelledAt`; `CollectionQueueRow` sent `patientName` and neither time. The queue showed blank names. The wire type now mirrors the server row and the server sends every field.
- **F2 — the chair's queue had no first half.** `collectionQueue` lists TUBES, which exist only after `printLabels`; a patient who had just left reception was on nobody's list. `awaitingLabels` (`GET /lab/collection/awaiting`) is the order-group half; the seat merges both, STAT first, then longest wait.
- **Assertion book corrected by execution:** "the row carries the OPD token when the encounter has one and `null` for a walk-in" is WRONG — a lab walk-in is an OPD visit in the LAB department and `openVisitInTx` joins the pathologist's doctor-day queue, so it carries a token of that series. `null` is a visit that never joined (RC-1's deferred join). Test A1 asserts the walk-in's own token.
- A rejected tube's free recollection already mints a replacement LABELLED specimen (17a T5), so it lands on the tube queue by itself (A2).
- The label is a Code 128 B SVG at 0.25 mm/module, asserted against the specification's worked example (checksum 88 for "Wikipedia"); order of draw is sorted server-side in the tube plan and client-side on the labelled tubes (the rank copied once, disclosed). `.specimen-labels` is its own print isolation.
- The RC-3 alias-layer censuses pinned ONE seat; D1 adds a second. Both widened to the set of scoped seats — the intent (no seat colour in an unscoped block) is unchanged. Found by PR #7's web job, not locally: the touched-suites rule does not run a peer's census.
- Evidence: core `collection` + `accession` 2 suites 15 tests; web `lab-collection` 4/4, `specimen-label` 4/4, i18n parity, `registration-counter` 99/99; typecheck 0, lint 0 errors.

