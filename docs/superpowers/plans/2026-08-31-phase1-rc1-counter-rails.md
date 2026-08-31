# Phase RC-1 — Counter rails & flows (Registration Counter series, 1 of 4)

**Lane: LIGHT** (5 tasks, no full-module build — ruled per EXECUTE-METHOD-V3 §2).
**Stop-loss: 1,700,000** = main-session `5 × 200,000` + task-subagent `0` (LIGHT, §2.143a) + review `240,000 × (1 + 2.0)` (§2.145). Comparables: 17b per-task coding 123–145k; review pass ~240k.
**Session token balance at kickoff: ~14.81M** (recorded per §2.141; deltas at each task boundary in CLOSE).
**Parallel-lane state at kickoff:** the 18a radiology lane holds uncommitted work in this checkout and runs its own verify on `hmis_lane_b_scratch`. All RC test runs use `TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_rc_scratch`, named in every commit message that cites evidence (§2.137), dropped per task. Full verifies queue behind `loadavg < 5` (§9.9 rule 7). Stage by path, never `git add -A`.

## 1. Why this phase

The owner signed off the Desk One design for the Registration Counter seat (2026-08-31; handoff `2026-08-31-EXECUTE-PROMPT-registration-counter.md`, design `docs/design/2026-08-31-registration-counter/desk-one.html`). Recon (three read-only agents, this session) established: flow3 T1 **never executed** — `counter_sequence`/`token_lane` are new; the token has **no paid state anywhere**; patient search discards the branch that matched; no wait estimate exists; and the change-handed-back lane (`0039`) is **statically dead at the HTTP boundary** — the web sends `receipt.changeGivenPaise` and the billing controller's zod `receiptBlockSchema` (`billing.controller.ts:180–185`) does not declare it, so zod strips it and `issueInvoice` reads `undefined → 0`. That silently resurrects the exact drawer-vs-ledger defect 07b T5 existed to kill.

RC-1 is the server rails the seat stands on. RC-2 (benefits), RC-3 (the seat), RC-4 (agent surface v0) follow. **No deploy anywhere in this series** — production has never left `commissioning`; code-complete + one green full verify is the finish line.

**Owner rulings carried (2026-08-31, this session):** benefits settle by **best single benefit** — Plan 09's contest semantics stand, no stacking; theming is an **alias layer** (RC-3's concern). Desk One rulings 1–7 of the handoff carried unmodified.

## 2. Spike

- **S1 — prove the `changeGivenPaise` strip.** Static: `receiptBlockSchema` (`billing.controller.ts:180–185`) declares `tenders/panNumber/form60/note` only — read directly this session; the schema is module-private, so a standalone import probe is not honest evidence. **The execution proof is T1's owed fail-first red**: the new HTTP-path test runs against unmodified shipped code first and its failing output (received `0` vs expected `2000`) is quoted in CLOSE before the fix lands.
- **S2 — can an encounter exist with no queue entry without breaking shipped reads?** Static read of every consumer of `opd_queue_entries` joined from encounters.
  **ANSWER:** `listQueue`/`boardSnapshot`/`summaryByDoctor` select FROM queue entries (absence = simply not listed); `opd-vitals` lists by encounter `status=registered` independent of queue rows; `classifyVisit` reads encounters only. One trap: `walkIn` returns `tokenNo` unconditionally — the deferred branch must return `tokenNo: null` and the wire type must say so. No shipped reader breaks.
- **S3 — next free migration number.** Measured at generate time (T2), immediately before and after `_journal.json` — 18a may still generate. Journal head at authoring: `0047_radiology_core`.

## 3. Design decisions

- **D1 — Token PAID is derived, never stored.** The paid stamp is a projection of the invoice ledger — the same derivation `feeGate` already makes (settled or credit-extended ⇒ PAID; free-revisit ⇒ settled-by-rule). Billing already registers the gate into OPD's registry (dependency-inverted); RC-1 extends that seam with a batch `feeStatusFor(db, encounterIds) → Map<id, "settled"|"unsettled"|"free">` provider, consumed by the three queue read models as a `feeSettled` field. No new column, no second source of truth.
- **D2 — Board flip is a realtime publish, not a poll.** When `issueInvoice` settles an encounter's fee line, OPD publishes on the existing `queue:{doctorId}:{serviceDate}` topic (`queue.fee_settled`), same mechanism as `queue.called`. The web board patches the stamp in place.
- **D3 — `counter_sequence ∈ {queue_first, bill_first}` and `token_lane ∈ {token_first, token_on_payment}`** as two `opd_config` columns, defaults `queue_first`/`token_first` (today's implicit behaviour — the migration changes nothing observable). flow3's third value `single_window` is **DECIDED out**: the signed-off design has no such flow. `token_lane` is meaningful only under `queue_first` and affects **printing and stamps only** — allocation is untouched (the number exists from queue join; the lane decides whether the slip leaves the printer before settlement). Design F1 = `queue_first`+`token_first`, F2 = `queue_first`+`token_on_payment`, F3 = `bill_first`.
- **D4 — `bill_first` is a deferred queue join, not a reordered transaction.** `POST /opd/walk-in` gains `join: "queue" | "defer"` (default `"queue"`); a deferred visit opens with no queue entry and `tokenNo: null`, and a new `POST /opd/visits/:id/join-queue` (permission `opd.visits.open`) performs session-get-or-create + `allocateToken` + queue-entry insert exactly as `openVisitInTx` does today — one function, two callers, never a fork. The fee is already flat in shipped `charge_rules` (one fee service per visit type), so billing before department assignment quotes correctly; S2 proves no reader breaks.
- **D5 — Flow lock is its own narrow permission.** `opd.counter.flow.manage`, declared on the OPD manifest, granted to `front_office_supervisor` and `opd_admin`, guarding a new `PUT /opd/config/counter-flow` that patches only the two D3 columns. `opd.config.manage` (opd_admin only) still governs the full config. **DECIDED:** no `counter_supervisor` role is minted — `front_office_supervisor` already carries the SLA escalation and queue-transfer authority.
- **D6 — Match reasons come from the one shared predicate.** `patientMatchCondition` stays the single source (palette and desk must agree — its own §2.54 argument); it additionally reports which branches fired, and `searchPatients` maps that to `matchedOn: ("uhid"|"mobile"|"name")[]` per hit. Never a confidence number (design ruling: reasons, not percentages).
- **D7 — Wait v0 is `waitingCount × avg_consult_minutes`, and the seam is the column.** `opd_departments.avg_consult_minutes int NOT NULL DEFAULT 6`, editable via the existing masters route, exposed on `queues/summary` rows. ETA arithmetic (`~N min · H:MM`) is client rendering. A future pace model replaces the *column read*, not the wire shape.
- **D8 — The free quote names its rule.** `FeeQuote` gains `freeReason: { kind: "review_window", doctorName, seenOn, windowEndsOn } | null`, populated from the same anchor `classifyVisit` already loads. Receipt/screen wording is RC-3's; the fact travels from here.

## 4. Tasks

### T1 — CRITICAL · the `changeGivenPaise` boundary fix
**Files:** `apps/core/src/modules/billing/billing.controller.ts`, `apps/core/src/modules/billing/billing-http.test.ts` (new), `apps/web/src/lib/billing-api.ts` (add the field to `WireIssueInvoiceBody["receipt"]`).
Declare `changeGivenPaise: z.number().int().min(0).optional()` on `receiptBlockSchema`. Test drives the **controller schema path** (parse → `issueInvoice`), asserting the receipts row carries the value.
**Assertion book:** assertion — a request carrying `changeGivenPaise: 2000` produces `receipts.change_given_paise = 2000` and `expectedCash` subtracts it; mutant — scratch copy of the schema without the field; discriminating input — the S1 body; expected kill — received `0` vs expected `2000`.
**Commit:** `fix(core): the change lane reaches the server — receipt.changeGivenPaise was stripped at the controller boundary (RC-1 T1)`

### T2 — CRITICAL · flow config, the migration, the flow-lock permission
**Files:** `apps/core/src/kernel/db/schema/opd.ts`, `apps/core/drizzle/<next-free>_counter_flow.sql` + meta (measure per S3), `apps/core/src/modules/opd/config.ts`, `apps/core/src/modules/opd/opd-masters.controller.ts`, `apps/core/src/modules/opd/manifest.ts`, `apps/core/scripts/seed-roles.ts`, `apps/core/src/modules/opd/config.test.ts`, **plus every census the manifest move touches** — run both §2.138 greps at directory scope AND expect the full verify to find derived censuses (§9.9 rule 6: this task owes a FULL verify at its boundary).
Columns per D3 + D7 (`avg_consult_minutes` rides this migration). Permission + grants per D5.
**Assertion book:** assertion — a `front_office` actor is refused on `PUT /opd/config/counter-flow` and `front_office_supervisor` succeeds, both by execution; mutant — scratch controller guard with the broad permission instead of the narrow one; discriminating input — supervisor without `opd.config.manage`; expected kill — 403 vs 200 inversion.
**Commit:** `feat(core): counter_sequence + token_lane on opd_config, dept avg minutes, and the flow-lock permission (RC-1 T2)`

### T3 — CRITICAL · deferred queue join + the fee-settled projection
**Files:** `apps/core/src/modules/opd/encounters.ts`, `apps/core/src/modules/opd/walk-in.ts`, `apps/core/src/modules/opd/opd-visits.controller.ts`, `apps/core/src/modules/opd/queue.ts`, `apps/core/src/modules/opd/registry.ts` (or the seam file the gate registration lives in), `apps/core/src/modules/billing/billing.module.ts`, `apps/core/src/modules/billing/invoices.ts` (settle-time publish), `apps/core/src/modules/opd/join-queue.test.ts` (new), `apps/core/src/modules/opd/fee-status.test.ts` (new).
Per D1/D2/D4. `join-queue` is idempotent per encounter (a second call returns the existing entry) and refuses a closed/cancelled visit.
**Assertion book:** (a) assertion — token allocation under deferred join is race-safe: two concurrent `join-queue` calls yield ONE queue entry and ONE token; mutant — scratch join without the idempotency/unique guard; input — two parallel calls; kill — 2 rows vs 1. (b) assertion — `feeSettled` flips only on settlement or credit-extension, by execution against a real invoice; mutant — projection reading invoice existence instead of settlement; input — an issued-but-unpaid invoice; kill — `true` vs `false`.
**Commit:** `feat(core): bill-first via deferred queue join; fee-settled projection + board flip on the queue reads (RC-1 T3)`

### T4 — ROUTINE · match reasons on patient search
**Files:** `apps/core/src/modules/patients/search.ts`, `apps/core/src/modules/patients/search.test.ts`, `apps/web/src/lib/*` wire type (read-only addition).
Per D6. `matchedOn` on `PatientSearchResult`; the palette provider keeps compiling unchanged (additive).
**Commit:** `feat(core): patient search says why it matched — matchedOn from the one shared predicate (RC-1 T4)`

### T5 — ROUTINE · the named free reason + wait v0 exposure
**Files:** `apps/core/src/modules/billing/charge-rules.ts`, `apps/core/src/modules/opd/queue.ts` (summary avg), `apps/core/src/modules/billing/charge-rules.test.ts`, `apps/core/src/modules/opd/queue.test.ts`.
Per D7/D8 (`avg_consult_minutes` column lands in T2; this task reads it).
**Commit:** `feat(core): fee quote names the review window; queue summary carries the department pace (RC-1 T5)`

**Verify economy (§9.9):** T1 can batch its narrow suite; T2 owes a **full verify** at its boundary (manifest/permission move); T3–T5 batch into one full verify at phase end if the tree allows. `pnpm typecheck && pnpm lint` before every launch (§2.132). Tree frozen during any launched run.

## 5. CLOSE

**Commits:** `7035915` (doc) · `1a3ae37` (T1) · `38e0772` (T2, migration 0048) · `61e6c96` (T3+T4+T5) · `75d16fc` (remediation C1/M1/M2/M4) · `f615a67` (pass-2 repairs). **CODE-COMPLETE, NOT DEPLOYED** — the series' standing rule.

### Review lane (two fresh passes, §9.10 shape)

**Pass 1 (207k): 1 CRITICAAL + 4 MAJOR + 8 MINOR** against a tree with 55 green tests, a died mutant, and clean typecheck/lint — §9.4 again, fourth phase running.
- **C1** — a deferred (bill-first) visit crashed `recordVitals` AND `abandonVisit` (TypeError on `entries[0]!`), making the visit unclosable. Spike S2 answered the READS and never checked the two WRITES keying off `status=registered` — the lesson: *a spike that asks "does any reader break" must grep the writers of the same predicate.* Abandon half fixed (`75d16fc`, nullable event fields per the visit.opened treatment); **vitals half is a NAMED CARRY landing with the VD-1 lane's in-flight `vitals.ts` rewrite** (cross-session agreement, their guard sits pre-transaction with their own test + mutant).
- **M1** — `encounterFeeStatuses` filtered on the batch-wide UNION of fee services: the stamp could read `settled` where `feeGate` refuses, and changed with the queue's composition. Fixed: per-invoice `feeServices` set, own-fee check in the loop; pass 2 confirms gate and stamp now select identically.
- **M2** — the walk-in contract lied about deferred results (S2's own named trap). Fixed across three layers; pass 2 found the fix INCOMPLETE (overload #2's bare `Omit` captured variable-typed inputs, leaving #3 dead) — repaired in `f615a67` exactly as prescribed (`& { join?: "queue" }`).
- **M3 — NAMED CARRY to RC-3**: nothing un-flips the board (`reverseAllocation`, `markEnteredInError`, `issueCreditNote` are invisible to the settle seam; no `unsettled` direction in the event). The derived read self-corrects on refetch and the push has NO consumer until RC-3 builds the seat; RC-3's board task must add the reverse direction (and should rename the event `queue.fee_status_changed` while it is still unconsumed).
- **M4** — the change guard compared against the whole-receipt surplus with only a cash-EXISTS check; ₹1 of cash beside a card overpayment authorised handing the card's surplus out of the drawer. The guard was DEAD until T1 undid the zod strip — *a fix that arms a dormant guard owes that guard a re-read.* Fixed: ceiling = min(surplus, Σ cash tenders), both directions executed.
- **Pass 2 (109k): 4 CORRECT, 1 INCOMPLETE (M2), and one NEW find** — `counter-desk.tsx` defaulted change to the whole surplus with no cash cap, which M4's (correct) ceiling would have hard-failed on every mixed tender. §2.145's arithmetic holds again: the remediation itself carried a defect and a regression-trigger only pass 2 caught.

### Mechanical verification, stated honestly

- Per-task narrow evidence, all on `hmis_rc_scratch` (§2.137): T1 red-first over real HTTP (expected 2000, received 0 — the shipped schema was the mutant, the red is the kill) then 3 suites/32 tests; T2 29/29 + the derived-census batch 8 suites/59 tests; T3–T5 7 suites/55; remediation 6/67; pass-2 repairs 27/27 core + 13/13 `counter-desk.test.tsx`. Typecheck+lint 0 at every commit. Rule-21 mutant for the join race: scratch `joinQueue` without the lock → **DIED** (expected 1 entry, received 2), scratch deleted. The T2 permission mutant is an inline mutant-shaped assertion (18a precedent, disclosed): the broad-vs-narrow inversion is pinned by execution in `opd.e2e.test.ts` both directions.
- **The one-green-full-verify bar was NOT met locally and the reason is measured, not asserted:** three attempts. #1: 6 core suites at the 122s timeout wall + 2 web timeouts, first-run worker-DB creation race + concurrent web/core — every failure passed isolated (153+8). #2: SIGTERM'd at load 54 (ten sessions on the box). #3 (sequential, `-w 4`): jest workers OOM-killed — dmesg: `Out of memory: Killed process 3051327/3051328 (node)` at 21:12–21:15, on a 15GB box carrying three coding lanes. Per protocol §4.4 and the 2026-08-29 precedent, **CI per SHA is the full-suite instrument**; one local full verify remains queued for the box's quiet hour behind the VD-1 lane's slot (serialized by agreement). T2's boundary obligation (§9.9 rule 6) was discharged by the explicit derived-census batch + CI.
- Working-tree hygiene: three lanes shared the checkout all phase. Everything staged BY PATH; `events.ts` staged BY HUNK twice while it carried the VD-1 lane's uncommitted `muacCm` beside my hunks. No scratch files remain (`.rc1-*` logs deleted at close; the mutant deleted before commit).

### Owner rulings this phase names
1. **Best single benefit** (2026-08-31, AskUserQuestion): Plan 09's contest semantics stand; no stacking. Binds RC-2.
2. **Theming = alias layer** (same): Desk One's palette as a parallel token set; seats adopt gradually. Binds RC-3.
3. DECIDED (mine, named): `single_window` dropped from the sequence enum; no `counter_supervisor` role minted; bill_first defers the QUEUE JOIN never the assignment (the design's "flat; adjusts on assignment" line does not survive the shipped flat charge_rules — and does not need to).

### Carries
- **C1 vitals half** → VD-1 lane's next commit (guard + test theirs; confirmed in-flight with a mutant).
- **M3** → RC-3 (the un-flip direction + event rename, with the board consumer).
- Pass-2 MINORs accepted as-is, named: `heldSettlementPaise` excluded from the change surplus (conservative, over-refuses); error-code precedence flip on card-only over-change (`change_without_cash` now first); `feeServiceIds` union still feeds the ledger batch reads (row volume only, query count unchanged); `visit.abandoned` widened at version 1 (the visit.opened precedent); events for RC-4's ledger projection arriving from VD-1 (`vitals.recheck_demanded`, `queue.escalated`, `queue.escalation_cancelled` — to be confirmed as shipped).

### Actuals (recorded at close; the token audit's hook appends the baseline row)
| | |
|---|---|
| session balance kickoff → close | ~14.81M → ~14.39M (≈ **420k main-session**, harness overhead included) |
| subagents | recon 3 × ~133k avg = 400k · reviewer pass 1 207k · pass 2 109k ≈ **716k** |
| total vs stop-loss | ≈ **1.14M of 1,700,000 (67%)** |
| tasks | 5 coded + 2 remediation rounds; 6 commits; 0 deploys |
| catches | reviewer lane: 1 CRITICAL + 4 MAJOR (+1 new in pass 2); instruments before review: 0 of those |
| per-boundary deltas | doc+T1 ≈ 90k · T2 ≈ 75k · T3–T5 ≈ 210k · close lane (main) ≈ 45k |

**Lessons bound for the ledger:** (1) S2's class — a spike about "who breaks on this state" greps WRITERS, not just readers, of the predicate; (2) a fix that arms a dormant guard (T1/M4) owes the guard a re-read in the same task; (3) on a multi-lane box the full verify is a SLOT to be scheduled between sessions, not a command each lane runs — serialize by message, or the OOM killer serializes it for you.
