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

*(appended as the phase runs)*
