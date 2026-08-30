# Plan 17b — LIMS, result to report: entry, verification, the interlock, the screens

**Written 2026-08-29 on the build host, AFTER Plan 17 stopped at its T2 boundary and the owner
authorised the re-cut. NOT APPROVED FOR EXECUTION — execution is a separate session with its own
approval, and it is GATED on 17a being code-complete.**

**THE RE-CUT, AND WHERE THIS HALF STARTS.** Plan 17 shipped T1+T2 (`39beff0`) and stopped on its
stop-loss (ledger §2.141). The owner ruled the remaining seven tasks into two phases:
[`17a`](2026-08-29-phase1-17a-lims-order-to-accession.md) takes T3–T5 and ends at an accessioned
specimen with its TAT clock running. **This is the second: T6, T7, T8 and T9 — the number, the
signature, the document, and the screens that show them.** It begins by reading an item 17a left
`in_progress` and ends with a report a patient can be handed.

**THE TASK NUMBERS DO NOT RESTART.** These are Plan 17's T6–T9, keeping the names its CLOSE already
uses (§9.4 corrects `T6 A4` and `T7 A1` by number). **Plan 17's §5 T6–T9 are STRUCK IN PLACE and
point here.**

**THE GATE.** 17b cannot start before 17a is code-complete, and the precondition is mechanical
rather than ceremonial: **every T6 fixture needs an item at `in_progress` with `tat_started_at` set
and one `active` row in `lab_specimen_items`** (17a §6.2), and every T7 fixture needs an invoice
17a's desk raised. A session that starts here against a tree without 17a will spend its budget
building 17a's fixtures by hand and then discover they disagree with 17a's real writers.

**WHAT THIS PHASE INHERITS AND MUST NOT RE-DERIVE:**

| what | where |
|---|---|
| the twenty-one design decisions | Plan 17 §4 — **DD8, DD11, DD12, DD13, DD14, DD16, DD18, DD21** are this phase's |
| the spike, ANSWERED | Plan 17 §9.3 — **S1, S4, S7, S8, S9 bind this phase** |
| the findings | Plan 17 §9.2 — **F3 is a task in this phase; F7 shapes T7's money reads** |
| the Assertion Book corrections | Plan 17 §9.4 — **T6 A4 and T7 A1 are already applied below** |
| the CONTRACT, the freezes, the edge pass | Plan 17 §6, §8, §7 |
| what 17a hands over | 17a §6, seven sentences |

---

## 0. EXECUTOR SEED — read this, then execute

> # ⏩ WHAT CHANGED BETWEEN AUTHORING (2026-08-29) AND NOW (2026-08-30). READ THIS FIRST.
>
> **This block is written by the session that closed 17a, so that you do not pay to discover any of
> it.** The document below it is unchanged except where this block says otherwise. **It is not a
> substitute for §2's re-measure — it is the list of things that MOVED, so your re-measure knows
> where to look.**
>
> ### THE GATE IS DISCHARGED. 17a IS CLOSED, NOT MERELY CODE-COMPLETE.
>
> T3/T4/T5 shipped (`b06e3d6`, `fba0d72`, `b54acfd`), **both** close-review passes ran, their twelve
> findings were remediated (`1e57d65`, `b8b03a6`), and the token audit is written. CI is green.
> **Verified mechanically for you** — the three things every fixture here needs all exist and work:
>
> | you need | it is | proved by |
> |---|---|---|
> | an item `in_progress`, `tat_started_at` set, ONE `active` `lab_specimen_items` row | `receive` from `modules/lab` | `accession.test.ts` A7 |
> | an invoice the desk raised | `deskOrder` from `modules/lab` | `desk.test.ts` A3 |
> | `resolveRange` / `evaluateFormula` / `matchReflex` to CALL, not reimplement | exported from `modules/lab` | 17a §6.3 |
>
> **Use 17a's real writers to build every fixture.** §0's warning about hand-built fixtures
> disagreeing with the real ones is now avoidable: `test/helpers/lab.ts` exports `seedLabDeskBase`
> and `deskAndLabel`, which take an order all the way to a received tube. Start there.
>
> ### FIVE OBLIGATIONS 17a HANDS YOU — they are in its §9.2 as F27–F31, and TWO are yours to fix
>
> 1. **F27 — `issueInvoice`'s `cash_threshold_blocked` audit event is LOST through `deskOrder`'s
>    cast, and it is F20's defect one module over.** `invoices.ts:1042` appends the §269ST refusal on
>    `withTx(db, …)` inside its own `catch`; through the desk's `tx as unknown as Db` that `db` is a
>    **`Tx`**, so the event lands on a savepoint of a transaction that is about to roll back and a
>    refusal of ₹2,10,000 in cash leaves **no record anywhere**. 17a could not fix it —
>    `modules/billing/*` was frozen — and **you wire the receipt path, so it is yours.** The shape
>    that works is `printLabels`': take a `Db` as well as a `Tx` and write the audit lane on it.
> 2. **F28 — the error union has no `permission_denied`, and T3/T4 borrowed `unknown_service` (404)
>    and `catalogue_invalid` (422) for authorization refusals.** `errors.ts` is T2's file and its own
>    header forbids a later task widening the union — which is why 17a reported it rather than
>    widening. **You own T8's controllers, so you meet this on every route.** Add the code and its
>    status, and fix the borrowings; `errors.test.ts` checks declared-vs-thrown in both directions and
>    will not object, which is exactly why it went unnoticed.
> 3. **F29 — the duplicate check is a read-then-refuse with no lock.** An advisory lock in `desk.ts`
>    would close it. 17a deferred on SEVERITY, not reachability: a lost race costs a reversible
>    double-bill against a new serialisation point on the desk's hottest path. **You mount the route
>    where `withIdempotency` lands — rule on it there.**
> 4. **F30 — the redraw now writes `cancelled_from = 'in_progress'` and refunds in full.**
>    `transitions.ts` records that O-4's money rule reads `cancelled_from`. Nothing reads it today.
>    **You are the phase that will.**
> 5. **F31 — the specimen definition's TRANSITIONS are unenforced.** `lab_specimens` has no
>    `instance_id`, so all four writers set the status by string literal. The state LIST is now bound
>    to the schema CHECK by a derived census; the EDGES are not.
>
> ### GROUND TRUTH THAT MOVED — re-measure all of it, but these are the ones that changed
>
> | row | authored as | **now** |
> |---|---|---|
> | scheduler jobs | 13 | **15** — 17a T5 added `sweepLabNonReturn` and `sweepLabSla` |
> | migrations | 46 | **48**; `0047` is Lane B's radiology core. **`0048` is free** |
> | manifests installed | 18 | **18** — Lane B's radiology/pcpndt skeletons are on `main` and are NOT installed, so nothing of theirs is live |
> | claimed order kinds | `['lab']` | **`['lab']`**, unchanged |
> | rows 14, 16, 17, 20 | as written | **all still accurate** — verified 2026-08-30, including row 16: `PhiSurface` really does already carry `orders.patient`, `lab.results` and `lab.report`, so **this phase adds none** |
>
> ### THE LANE IS YOURS ALONE NOW
>
> **§0 item 4 and §2's "Lane B shares this checkout" are SUPERSEDED. Lane B (Plan 18a) is CLOSED.**
> Its work is landed and inert; the working tree is clean. You still read `git status --porcelain`
> before every `git add` — that is just discipline — but the blob-staging technique (§2.142) and the
> migration-number negotiation are not needed. **Do not drop `hmis_lane_b_scratch_1`**: it is the
> only place `0047` is applied and Lane B asked in writing for it to stand.
>
> ### `pnpm verify` WORKS NOW, AND IT DID NOT WHEN THIS WAS WRITTEN
>
> Six consecutive full verifies failed across two lanes and both concluded the instrument was broken.
> It was one test — `advance.test.ts`'s C1 at **10,847 ms against a 15,000 ms default on an idle
> box** — plus a fixture cascade that reported one fault as two (ledger **§2.144**, fixed in
> `cae2f05`). **A full `pnpm verify` is now exit 0: 305 suites, 2977 tests, zero timeouts.** So
> v3 §9.9 rule 4's one-run-per-block is achievable rather than aspirational. **If a race row of yours
> lands near its budget, give it an explicit timeout and say the measured idle cost in the comment** —
> that is now twice-established house practice (`jobs.test.ts`, `advance.test.ts`).
>
> ### THE STOP-LOSS IS RESTATED — §6's formula was amended the day 17a closed (ledger §2.143)
>
> 17a closed at **~1,241,000 of 1,350,000 (92%)** — and its three terms were **27% under, 100% under
> and 72% over**. Three errors cancelling is not a validated formula. v3 §6 now says: **delete the
> task-subagent term in a LIGHT lane** (17a carried 90,801 for agents its own §0 forbade), and **the
> review term is a MULTIPLIER, `× (1 + remediation factor)`, because nothing pays for REPAIRING what
> the review finds** — twelve findings across two passes cost roughly the review again.
>
> **Restated for this phase, and it is the number to carry:**
>
> ```
> main-session   90,000 fixed
>              + 250,000 T6   ← 17a measured CRITICAL tasks at 183k and 248k marginal, not 330k
>              + 250,000 T7
>              + 300,000 T8   ← genuinely the largest surface in either half
>              +  80,000 T9
>              = 970,000
> task subagents        0     ← LIGHT lane. Do not carry 121,068 for agents you may not spawn
> review        300,000 × (1 + 1.0) = 600,000
> ─────────────────────────────────────────
> STOP-LOSS ≈ 1,570,000
> ```
>
> It lands within 1% of the 1,560,000 below — **for entirely different reasons**, which is the point:
> lower coding, zero subagents, double review. **Report a fraction of stop-loss only at CLOSE**; 17a
> reported "51%" at its T5 boundary with the review correctly named as unspent and then said "three
> times what the phase needs" a paragraph later, and the wrong half was the quotable one.
>
> ### AND THE ONE THING 17a WOULD TELL YOU IF IT COULD TELL YOU ONLY ONE
>
> **Its two CRITICALs were both money silently vanishing on the ORDINARY clinical path, and neither
> was found by 32 dead mutants, green suites or green CI. Both were found by a fresh reviewer.**
> Then the SECOND reviewer found that three of the first pass's five fixes were themselves defective.
> **Budget both passes, run both fresh, and treat your own remediation as unreviewed code** — because
> it is.


**Read, in this order, before the first tool call:**

1. [`../AGENT-RULES.md`](../AGENT-RULES.md) — in full. Rules 3, 7, 20, 21, §3, §5, §6.
2. **This document, in full** (~32 KB — the only plan you read whole).
3. **17a §6** (what it hands you — seven sentences) and Plan 17's **§9.2** and **§9.3**, by line
   range.
4. [`reports/2026-08-26-parallel-session-protocol.md`](reports/2026-08-26-parallel-session-protocol.md)
   §1, §2, §7 — Lane B shares this checkout.
5. The ledger's **§5 only**, its line measured first. By number: §2.54, §2.115, §2.131, §2.133,
   §2.136, §2.137, §2.138, **§2.139** (never `not.toHaveBeenCalled()` on a `Db`-taking spy — it OOMs
   the runner at 4 GB on the one run that matters), **§2.140** (a fix can open the next door),
   §2.141, §2.142.
6. The seam, when you reach the task that calls it: `kernel/orders/{advance,read}.ts` (T6, T7),
   `kernel/workflow/instances.ts:136-157` (the CAS T6 copies), `modules/billing/index.ts`'s
   `invoiceSettlement` / `issueCreditNote` / `settlementState` (T7), `kernel/notify/{enqueue,templates}.ts`
   (T7 — **and see F3**), `kernel/phi/audit.ts`'s `recordPhiAccess` (T7), `apps/web/src/router.tsx`
   and `components/rx-print.tsx` (T8).

**You are the main session of a LIGHT-lane phase under v3 §3.** Four tasks, T6→T7→T8→T9, in order.
No coding subagents. Two FRESH close reviewers at the end, never resumed.

**You are NOT authorised** to deploy, to widen your own permissions, or to edit any file §8 freezes.

**RECORD YOUR OWN TOKEN BALANCE at kickoff and at every task boundary** into §9.7 (v3 §6).

---

## THE LANE — LIGHT, four tasks: two CRITICAL, one large ROUTINE, one docs

### Stop-loss (v3 §6 as amended 2026-08-29): **1,560,000 tokens**, arithmetic shown

- **Main-session term — 1,170,000**, decomposed per task rather than averaged, because T8's size is
  not T9's:
  - per-phase fixed **90,000** (reading, pre-flight, re-measure — the spike is inherited);
  - **T6 CRITICAL ≈ 350,000** (nine rows, one concurrency row over ≥ 8 rounds, and a reflex
    placement inside a verifying transaction);
  - **T7 CRITICAL ≈ 350,000** (nine rows, the money seam, the fourth kernel edit, PHI logging);
  - **T8 ROUTINE but the largest surface in either half ≈ 300,000** (five controllers, four screens,
    a print component, an e2e over every route, four censuses);
  - **T9 docs ≈ 80,000**.
- **Task subagent term — 121,068** (`1.5 × (20,178 × 4)`).
- **Review term — 300,000.** Two FRESH passes over a bigger and more dangerous surface than 17a's:
  14's pair measured 458,491 over nine tasks, 22c-A's 305,491 over nine commits, phase 0's 348,043
  over six. Four tasks with a money interlock and a confidentiality path: ~150,000 each.
- **Total: 1,591,068 → 1,560,000.**

> One measurement extrapolated; it will be wrong and the CLOSE says by how much. A tripwire, not a
> target.

**Hand-off rule.** If the token balance passes ~65% of the stop-loss before **T7** is committed, hand
off at a task boundary (v3 §9.6): typecheck, the narrowest suite with its exit value read and its
database named, then the note. **T7 is the task that must not be handed off half-written** — it is
the money and confidentiality seam, and Plan 14's specimen is exactly a CRITICAL fix handed over
un-run.

**Execute in a FRESH session, separate from 17a's.**

---

## 1. Why this phase

**What exists when it starts.** An accessioned specimen and nothing that can say what is in it. The
catalogue can resolve a range and evaluate a formula (17a T3) and nobody calls either. Thirteen of
the twenty-two `LAB_EVENTS` have no emitter. `lab_results`, `lab_reports`, `lab_report_deliveries`
and `lab_critical_calls` stand empty behind two immutability triggers that have never refused a
real UPDATE. **The lab can take a tube and cannot report on it**, which is the state this phase
exists to end.

**What it adds.** The number (entry with its absurd envelope, its snapshotted range, its flags and
its delta), the signature (SoD verification with a CAS, night mode, and `completed` on the envelope
when the last analyte verifies), the escalation (criticals with the call ladder and the read-back),
the automation (reflex, synchronous, inside the verifying transaction), the document (versioned,
signed, amendable, never edited), the **delivery interlock** (print and WhatsApp held until the
self-pay line settles; **the doctor's screen never held**), and the four screens plus the A4 print
that make all of it a lab somebody can work in.

**What it does NOT do.** Plan 17 §1.3 unchanged: no analyzer interface, no QC, no reagent lots
(17-E); no cultures or send-outs (17-M); no histology (17-H); no home-collection logic beyond a
column (24a); no packages (26); no patient-app reads (22c-F); **no auto-verification activation** —
the engine ships with zero active rules and `entry_mode='interface'` does not exist, so nothing can
auto-verify in this phase by construction; no LOINC load; no PDF renderer.

---

## 2. Ground truth — measured 2026-08-29, HEAD `91462da`; **re-measure at kickoff, after 17a**

Rows 1–13 of [17a §2](2026-08-29-phase1-17a-lims-order-to-accession.md) apply unchanged and are not
copied. The rows this phase adds:

| # | fact | value today | how |
|---|---|---|---|
| 14 | notification templates | **5**, in a CLOSED literal `Record` in `kernel/notify/templates.ts`; `templateByKey` THROWS for anything else; **no registration function exists** | `grep -n '^  [a-z_]*: {' apps/core/src/kernel/notify/templates.ts` |
| 15 | the template census | `templates.test.ts` pins `Object.keys(notificationTemplates).sort()` as a literal list | `grep -n 'Object.keys(notificationTemplates)' apps/core/src/kernel/notify/templates.test.ts` |
| 16 | `PhiSurface` | carries `orders.patient`, `lab.results`, `lab.report` since `39beff0` — **this phase adds none** | `grep -n 'lab.report' apps/core/src/kernel/phi/audit.ts` |
| 17 | web screens / router `path:` lines | **35 / 35** — T8 makes both 39 | `ls apps/web/src/screens \| grep -vc test; grep -c 'path:' apps/web/src/router.tsx` |
| 18 | the SPA nav censuses T8 moves | `apps/core/test/nav-parity.test.ts` (compares `ALL_MANIFESTS` menus to `router.tsx`'s NAV) and `apps/web/src/shell-nav.test.tsx` | `grep -rn "ALL_MANIFESTS" apps/core/test/nav-parity.test.ts` |
| 19 | the A4 design | `docs/design/2026-08-29-opd-counter-flow/ReportA4.dc.html` — **UNTRACKED, another session's** | `ls docs/design/2026-08-29-opd-counter-flow/` |
| 20 | `invoiceSettlement` | exported from `modules/billing`, takes `Db \| Tx`, keyed on the INVOICE | `grep -n 'invoiceSettlement' apps/core/src/modules/billing/index.ts` |

---

## 3. Spike — inherited; one new question

**Plan 17 §9.3 answers S1, S4, S7, S8 and S9, and all five bind this phase.** The two that change
code:

- **S7 — the template registry is CLOSED kernel code.** `modules/lab/notify-templates.ts` as Plan 17
  imagined it **cannot exist**. T7 appends `patient_lab_report_ready` to
  `kernel/notify/templates.ts` and its key to `templates.test.ts`'s sorted census. **This is the
  fourth kernel edit of the lab's build and the only one this phase makes** (finding F3).
- **S9 — a `system` reflex order STILL owes `ordering_clinician_id`.** `place.ts:126` checks
  `requiresClinician` for EVERY actor type, after `resolveAuthority` has already accepted the system
  actor's `protocolRef`. The two guards are independent. **T6 A4 passes the verifying pathologist's
  user id**, and a mutant that omits it fails with `clinician_required` for the wrong reason.

| # | new question | why it changes the work |
|---|---|---|
| **S12** | Is there any deep-link target for a report before 22c-F ships — a patient-facing route, a QR resolver, anything `patient_lab_report_ready` could carry? And does `enqueueNotification`'s `dedupeKey` (or its equivalent) let a re-notified AMENDED report through, or would it be suppressed as a duplicate of the original publish? | T7 publishes a token-only "report ready" notice with **no result values** (02 J3 / R-020), so the body says where to collect — but R-018's amendment RE-notification must reach the patient, and a dedupe key derived from the report id alone would silently swallow it. **Read the dedupe rule; do not assume it.** If amendment re-notification cannot be made to work, that is a finding and the amendment notice is deferred with a named reason, not faked. |

---

## 4. Design decisions — POINTERS, and one new ruling

**Implemented from Plan 17 §4:** **DD8** (reflex synchronous, in the verifying transaction, API-side),
**DD11** (verification is a human act with SoD; auto-verify ships DISABLED; a `system` verify is
refused outright), **DD12** (criticals: flag at entry, call ladder, read-back closes it),
**DD13** (versioned JSON snapshots; amendment is a new version; no edit endpoint),
**DD14** (confidentiality: `restricted`, `sensitive` ⇒ in-person, the alias rule on every reader),
**DD6**'s interlock half (`deliveryAllowed`, the payer branch, the approval release),
**DD7** (cancellation money), **DD16** (the permissions, already granted), **DD18** (the events),
**DD19** (idempotency on the nine routes), **DD21** (four screens + the print component + the ONE
OPD panel).

**DD23 — `deliveryAllowed` IS INVOICE-GRAINED, AND THE OVER-BLOCK IS THE RULING (spike S1, and it
corrects T7 A1).** `settlementState` is a PURE function of three numbers about ONE INVOICE
(`billing/settlement.ts:12`), and the only exported reader is
`invoiceSettlement(exec, invoiceId)` — **there is no line-grained settlement in this system.** So:

> `deliveryAllowed(exec, orderId)` blocks while ANY invoice carrying one of this order's
> `lab_items.invoice_id` values is not `settled`.

**This OVER-blocks and never UNDER-blocks**, and that is the safe direction: a mixed invoice (a
consultation plus two lab lines) that is half-paid holds the lab report until it is settled. The
alternative — attributing a partial payment to particular lines — is an allocation policy this
system deliberately does not have, and inventing one inside the lab would put a second answer beside
billing's. **T7 A1's mutant must discriminate the invoice-grained rule, not a line-grained one that
does not exist**, and the CONTRACT sentence (§6.5) is amended to say so in as many words.

**DD24 — THE AMENDMENT NOTICE IS GATED ON S12 AND FAILS LOUDLY, NOT SILENTLY.** If S12 finds that a
dedupe rule would suppress an AMENDED re-notification, T7 does NOT invent a bypass: it records the
finding, ships publication without the amendment notice, and the runbook (§9.9) tells the counter to
telephone. **A patient who was told a result and never told it changed is the outcome R-018 exists
to prevent, and a silently-swallowed message is indistinguishable from one nobody sent.**

---

## 5. Tasks

**Files list discipline** as 17a §5. **ONE kernel edit in this phase** — T7's template append — and
it is named in T7's commit message so Lane B can rebase.

### T6 — Results: manual entry, absurd envelope, snapshot ranges, flags, delta, SoD verification, night mode, criticals with the call ladder, rerun, SYNCHRONOUS reflex, `completed` at verify — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{results.ts, verify.ts, criticals.ts}` + tests
(+ `verify.concurrency.test.ts`); Modify `apps/core/src/modules/lab/index.ts`.

**Produces:** `enterResult(tx, actor, {orderItemId, analyteId, value, unit?, entryMode, remarks?, absurdOverride?})`
— refuses outside `absurd_low/high` unless `absurdOverride` names a SECOND holder of
`lab.results.enter` (02 H1); resolves and **snapshots** the range (17a T3's `resolveRange`); sets
`flag`; runs the delta against the previous VERIFIED result of the same analyte for the CANONICAL
patient within `delta_window_hours` (02 H2); opens a critical call when outside the critical band
(DD12); computes formula analytes of the same specimen when every input exists; emits
`lab.result_entered`. `verifyResult(tx, actor, {resultId})` — SoD (DD11), `lab.results.verify`, a CAS
on `verification_status='unverified'`, `verified_by/at`, **reflex** (DD8), **`advanceOrderItem(…
'completed')` when every analyte of the item has a verified row**, `lab.result_verified`.
`requestRerun` (`rerun_of`, free, back to `in_analysis`). `acknowledgeCritical(tx, actor, {callId, attempt | readback})`
— closes ONLY on read-back text (02 §3.6). **A `system` actor is refused at `verifyResult`
(`user_actor_required`)**: NABL permits documented technologist release; it does not permit a system
releasing a manually keyed number.

**THE CAS IS TRANSCRIBED, NOT INVENTED.** `kernel/workflow/instances.ts:136-157` is the shipped
single-winner pattern and phase 0's `advanceOrderItem` is its second copy; `verifyResult` is the
third. `WHERE id = ? AND verification_status = 'unverified'`, zero rows updated ⇒ `already_verified`,
and **the caller reports rather than re-reads and overwrites.**

#### Assertion Book — T6

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | Enterer ≠ verifier is enforced **per RESULT ROW** even when one user holds both permissions; night mode flips it to allowed-with-flag. | SoD checked on ROLE, not on `entered_by`. | **A tech holding both permissions, night mode off.** Shipped: `sod_violation` + `lab.sod_violation_blocked`. Mutant: verified — and one person with two permissions has signed their own number. |
| **A2** | Two concurrent verifies of one result: ONE `lab.result_verified`, the loser `already_verified` — **≥ 8 rounds**, `uptime` quoted, `pgrep -af jest` lines read. | Read-then-write. | **`Promise.all` of two verifies.** |
| **A3** | `completed` fires on the envelope item exactly when the LAST analyte verifies, never earlier, and the transitions row's actor is the verifier. | Advance on the first verify. | **A CBC with 3 analytes; verify two.** Shipped: the item stays `in_progress`. Mutant: `completed` with a result missing — and 22c-F shows a report that does not exist. |
| **A4** | Reflex: verifying TSH 9.0 (rule ACTIVE, consent given) places ONE new order in the same group as `system` / `protocol` / `protocol_ref = rule id` / `origin:'reflex'` / `parent_item_id`, **with `orderingClinicianId` = the verifying pathologist (S9)**, attached to the same specimen, invoiced with `charge_reason:'lab_reflex'`, **in the SAME transaction**. | The reflex placed after the commit. | **A forced throw injected AFTER `placeOrder` and before commit.** Shipped: 0 orders, 0 results verified — both rolled back. Mutant: the reflex order survives a failed verify. |
| **A4b** | Reflex is NOT placed when `reflex_consented_at` is null, and NOT placed twice when the same result is re-examined. | Consent ignored. | **The same value, no consent.** Shipped: 0 orders. |
| **A5** | A critical value opens exactly ONE `lab_critical_calls` row **at ENTRY**, before any verify, and the call cannot close without `readback_text`. | Open at verify. | **K⁺ 6.8 entered, not verified.** Shipped: 1 open call. Mutant: 0 — and at 02:00 with no pathologist logged in, nobody is telephoned (02 F1). |
| **A6** | The snapshot on the result is the range as it was AT ENTRY: a range-table edit afterwards changes nothing on the row or the flag. | Read the range at report time. | **Enter, then move `ref_high` in `lab_reference_ranges`.** Shipped: the row and its flag are unchanged. |
| **A7** | Delta compares against the previous **VERIFIED** result of the same analyte for the **CANONICAL** patient — not an unverified one, and not a sibling's (02 A3). | Previous row regardless of status. | **A prior UNVERIFIED 4.2, a prior VERIFIED 0.9, today 4.1.** Shipped: delta flagged against 0.9. Mutant: not flagged, against 4.2. |
| **A8** | An absurd value (glucose 1200 mg/dL) is refused without a second holder's override; with it, `absurd_overridden_by` is stored — and the override may not be the ENTERER. | The envelope not checked. | **Glucose 1200, then the same actor overriding.** Shipped: `absurd_value`, then `absurd_override_same_actor`. |
| **A9** | A `system` actor is refused at `verifyResult` (`user_actor_required`) — the auto-verify seam is structurally closed in this phase. | Actor type not checked. | as stated |

**Acceptance:** rows per rule 21; A4's rollback proved by an injected throw; **any spy on a
`Db`-taking function asserted as `expect(spy.mock.calls.map((c) => c[1])).toEqual([…])`, never
`not.toHaveBeenCalled()`** (§2.139 — the assertion whose whole job is to fail loudly OOMs the runner
at 4 GB when it does); fail-first owed and quoted.
**Commit:** `feat(core): lab results — manual entry with absurd envelope and snapshotted ranges, delta, SoD verify with CAS, criticals with read-back, synchronous reflex, completed at verify (17b T6)`

### T7 — Reports: versioned snapshot, the DELIVERY INTERLOCK, publish, print with release register, the ready notice, amendment, PHI logging — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{reports.ts, interlock.ts, money.ts}` + tests; Modify
`apps/core/src/kernel/notify/templates.ts` (**kernel edit — `patient_lab_report_ready`, finding F3**),
`apps/core/src/kernel/notify/templates.test.ts` (its sorted census),
`apps/core/src/modules/lab/index.ts`.

**Produces:** `money.ts` — `chargeReasonFor`, and `refundOnCancel(tx, actor, orderItemId)`
implementing DD7 from `cancelled_from` + `exists(lab_results)`, **invoked synchronously by every lab
cancel path** (the sweep, the desk's cancel, the pathologist's cancel) rather than by a subscription
to `order_item.cancelled` — the lab is the only writer that cancels lab items, and a subscription
would be a second answer to one question. `interlock.ts` — `deliveryAllowed(exec, orderId)` per DD6
and **DD23**, returning `{allowed, reason: 'unpaid_invoices' | 'exempt_payer' | 'settled' | 'released_by_approval', unpaidInvoiceIds}`.
`reports.ts` — `publishReport`, `printReport`, `releaseUnpaid`, `amendReport`, `getReport`,
`listResultsForEncounter`.

**THE ONE SENTENCE THIS TASK MUST NOT GET WRONG:** *the doctor's read NEVER calls
`deliveryAllowed`*. `listResultsForEncounter` returns verified results for an unpaid self-pay order,
and the critical-value CALL never consults the interlock either. **Hiding a verified result from the
clinician who ordered it is the safety defect 02 O-1 forbids**, and the interlock exists to hold a
DOCUMENT, not a fact.

#### Assertion Book — T7

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | `deliveryAllowed` blocks while ANY invoice carrying one of the order's lab lines is unsettled (**DD23, invoice-grained**) — an order with a CBC paid at the desk and a reflex FT4 invoiced on credit is BLOCKED. | Check the DESK invoice only. | **A paid CBC + an unpaid reflex FT4 on a second invoice.** Shipped: blocked, `unpaidInvoiceIds=[the reflex invoice]`. Mutant: allowed — the §9.7 operand question, pre-answered. |
| **A1b** *(the operand's other half)* | A partially-paid MIXED invoice (consultation + lab line) BLOCKS, and the reason names the invoice rather than the line. | Treat "some money arrived" as settled. | **An invoice with a consultation and a CBC, half paid.** Shipped: blocked. Mutant: released on a payment that may have been for the consultation. |
| **A2** | `tpa`, `pmjay`, `corporate` visits and every `D` encounter deliver with ZERO receipts. | Payer ignored. | **A corporate visit, no receipt.** Shipped: allowed, `exempt_payer`. |
| **A3** | The doctor's `listResultsForEncounter` returns verified results for an UNPAID self-pay order; `printReport` for the same order refuses `report_print_blocked` and emits it. | The interlock applied at READ. | **Unpaid, verified.** Shipped: the read returns rows; the print is refused. Mutant: the doctor sees nothing. |
| **A4** | Release-unpaid with a granted approval prints, records the approval on the delivery row, and **does NOT alter the invoice or the dues** (`patientOutstandingPaise` identical before and after). | The release writes a credit note. | **Approve, print, compare balances.** Shipped: unchanged. Mutant: the interlock becomes a discount mechanism — 02 O-1's opposite. |
| **A5** | `refundOnCancel`: `cancelled_from='placed'` ⇒ ONE credit note for exactly that line's paise; `'in_progress'` WITH a result row ⇒ NO credit note; `'in_progress'` WITHOUT one ⇒ credit note. | `cancelled_from` ignored (always refund). | **The three fixtures.** Shipped: 1 / 0 / 1. Mutant: 1 / 1 / 1 — the legacy "no pathology refund once the result is saved" violated silently. |
| **A6** | A published report's snapshot is immutable (T1's trigger refuses the UPDATE), and an amendment is version n+1 with `prior_version_id`, the superseded result row still readable. | Update in place. | **Amend Hb 12.0 → 10.2.** Shipped: 2 report rows, 2 result rows, v1 `superseded`. |
| **A7** | The "ready" enqueue carries **NO result values** and is NOT enqueued for a `sensitive` orderable; `lab.report_published` fires regardless of the enqueue outcome (02 C5). | Values in the body / `sensitive` not checked. | **An HIV report published.** Shipped: 0 notifications, 1 event. **Asserted on the ENQUEUED PAYLOAD, not on a template string.** |
| **A8** | `getReport` for a SEALED patient by a caller without `patients.confidential.read` returns the alias and writes ONE `phi_access_log` row with `surface='lab.report'`; the same caller's second read writes a second row. | The log skipped on the alias path. | **A sealed fixture, a clerk.** Shipped: alias, 1 row, then 2. Mutant: 0 rows. |
| **A9** | Print without `collectorIdentity` is refused (02 J2); with it the release register names the collector and the printer. | Identity optional. | as stated |

**Acceptance:** rows per rule 21; **`money.ts` and `interlock.ts` are the reviewer's first two
files**; A7 asserted on the enqueued payload; fail-first owed and quoted.
**Commit:** `feat(core): lab reports — versioned snapshots, invoice-grained delivery interlock with payer branch and approval release, print register, ready-notice, amendment, cancel-money rule; kernel: the patient report-ready template (17b T7)`

### T8 — Routes, four screens, the print component, the consult panel, i18n, nav parity, realtime — **ROUTINE**

**Files:** Create `apps/core/src/modules/lab/{lab-desk.controller.ts, lab-collection.controller.ts, lab-bench.controller.ts, lab-verify.controller.ts, lab-catalogue.controller.ts, realtime.ts}`,
`apps/core/test/lab.e2e.test.ts`; `apps/web/src/screens/{lab-desk, lab-collection, lab-bench, lab-verify}.tsx`
+ tests, `apps/web/src/components/lab-report-print.tsx` + test; Modify `apps/web/src/router.tsx`
(four `path:` lines AND four NAV rows), `apps/web/src/locales/{en,hi}.json`,
`apps/web/src/screens/opd-consult.tsx` (**the ONE results panel**), `apps/core/test/nav-parity.test.ts`,
`apps/web/src/shell-nav.test.tsx`, `apps/core/src/modules/lab/lab.module.ts` (the five controllers;
`LabModule` imports `RealtimeModule`), `apps/core/src/app.module.ts` (ONE import line).

**Produces:** every route zod-validated, `Idempotency-Key` read on the nine DD19 routes,
`LabError.toHttp` mapped, screens on the OPD keyboard conventions, the A4 print component (copying
`ReportA4.dc.html`'s layout **by eye if it is still untracked — that tree is never staged**, else
`rx-print.tsx`'s), `hi.json` carrying every new key.

**THE ROUTE ASSERTIONS ARE OVER HTTP, NOT OVER THE SERVICE.** 22c-A's C1: a field missing from the
wire schema returned **200 and wrote nothing**, and every test had called the service directly.
`lab.e2e.test.ts` hits each route over the wire, asserts the BODY it wrote, and walks a refusal from
every error family through so `labHttpStatus` is EXECUTED.

**Acceptance:** `pnpm --filter @hmis/web test` and `apps/core/test/lab.e2e.test.ts` green on the
named database; `nav-parity` and `shell-nav` updated (row 18); the wire assertion above. No
fail-first owed — say so.
**Commit:** `feat(web,core): lab desk, collection, bench and verify screens, A4 report print, consult results panel, routes with idempotency keys (17b T8)`

### T9 — Gate report, runbook, drills, the production seed, KPIs deferred — **ROUTINE**

**Files:** Create `docs/superpowers/plans/reports/2026-XX-XX-plan-17-gate-report.md` (covering
**both halves** — 17a and 17b are one module and one go-live), `docs/runbooks/lab-go-live.md`;
Modify this document's §9 and 17a's §9.9 pointer.

**Produces:** the honest §19-style lines (proven by execution / proven by reading / not proven); the
runbook — the `LAB` department, the pathologist-of-record as an `opd_doctors` row, the four roles'
production grants plus the three kernel `orders.*`, the catalogue seed from the owner's spreadsheet,
the signatory block, the bench rows (17a S11), the definitions activation as the owner's §10.4 act,
the pilot-as-secondary window and its harvest form, and the paper downtime path (02 C3/C4) with
`label_source='downtime_kit'`; the drill script for the three chaos rows this plan can run (a
critical at 02:00 with no pathologist logged in; a rejected tube on a departed OPD patient; a
printer-down label fallback). **KPI lines (02 §8) are NOT registered** — Plan 21's registry does not
exist — and the gate report says so.

**Acceptance:** documents committed by path; nothing under `apps/`. No fail-first.
**Commit:** `docs(plan): Plan 17 gate report, go-live runbook, drills (17b T9)`

---

## 6. THE CONTRACT — the amendment this phase makes

**Plan 17 §6's fourteen sentences stand.** This phase amends exactly one and adds one:

- **§6.5 AMENDED (DD23):** *"`deliveryAllowed(exec, orderId)` is the ONE interlock function"* — and
  it is **INVOICE-grained**. It blocks while any invoice carrying one of the order's lab lines is
  unsettled, which over-blocks a partially-paid mixed invoice and never under-blocks. 22c-F, 24a's
  rider app and 18a call it and **nobody re-derives it from invoices**.
- **§6.15 NEW:** *"a `system` actor is refused at `verifyResult`, and `entry_mode='interface'` does
  not exist."* 17-E's auto-verification activation is the phase that changes both, over
  `entry_mode='interface'` rows with no delta, absurd or critical flag, and DD11's zero-rule engine
  is the seam it activates.

---

## 7. Edge cases this phase owns

**Plan 17 §7 is the full pass.** The rows this phase RULES: E13 (rerun after publish — an amendment,
never a silent replace), E21 (WhatsApp down at publish — T7 A7), E23 ("I'll pay later" — DD6),
E24 (ER unpaid critical — the call never consults the interlock), E25 (refund after the result is
saved — DD7), E27 (package partial — `partial:true`), E34 (night, no pathologist, K⁺ 6.8 — DD12),
E35 (tech alone at night — DD11 night mode), E36 (glucose 1200 typo — T6 A8), E37 (delta 0.9 → 4.2 —
T6 A7), E38 (LDL with TG 450 — 17a T3 A3, consumed here), E39 (DOB missing / sex other — the notes
ride the snapshot), E40 (pathologist edits a verified value — no edit endpoint; T7 A6), E41 (unit
change in the catalogue — results keep their unit), E42 (cashier prints for a friend — T7 A4/A9),
E45 (waiting-area TV — no lab display screen in this phase), E46 (shared family phone, pregnancy
test — `sensitive` ⇒ in-person, T7 A7).

---

## 8. What this phase FREEZES

Plan 17 §8's thirteen, plus DD23's invoice-grained interlock and §6.15.

**Frozen surfaces this phase may NOT touch:** everything under `kernel/orders/`;
`kernel/db/schema/lab.ts` and migrations `0046`/`0047`; `kernel/episodes/series.ts`;
`kernel/resources/*`; `kernel/auth/*`; `packages/contracts/*`; `modules/billing/*` except as an
IMPORT; `modules/opd/*` except the ONE results panel in `opd-consult.tsx`; `modules/patients/*`;
**everything 17a wrote** (`catalogue.ts`, `ranges.ts`, `formula.ts`, `reflex.ts`, `duplicates.ts`,
`desk.ts`, `workflow-def.ts`, `definitions.ts`, `collection.ts`, `specimens.ts`, `accession.ts`,
`sweeps.ts`) — 17b CALLS them and does not edit them; a needed change there is a finding;
anything Lane B has written.

`kernel/notify/templates.ts` and its test are the ONE kernel exception, and only for T7's append.

---

## 9. CLOSE — filled at execution 2026-08-30

### 9.0 Kickoff — the pre-flight, §2 re-measured, 17a's gate confirmed

**HEAD at kickoff: `e56c7ef`.** Tree clean but for three untracked docs trees belonging to other
sessions (`docs/design/`, two DESIGN/EXECUTE prompts) — never staged, per §0 and spike S8.

**§2 re-measured, every row:**

| # | fact | authored | measured at kickoff |
|---|---|---|---|
| 14 | notification templates | 5 | **5** — `patient_welcome`, `appointment_confirmed`, `appointment_reminder`, `staff_escalation`, `owner_escalation_sms`. T7 makes it 6. |
| 15 | the template census | a sorted literal | **unchanged**, `templates.test.ts:20` |
| 16 | `PhiSurface` | carries the three lab surfaces | **confirmed** at `audit.ts:47` — this phase adds none |
| 17 | web screens / router `path:` | 35 / 35 | **35 / 35**. T8 makes both 39. |
| 18 | the SPA nav censuses | `nav-parity.test.ts`, `shell-nav.test.tsx` | **both present** — and a THIRD the row does not name: `caddyfile-parity.test.ts` pins the route COUNT at 35 (§9.2 F40) |
| 19 | the A4 design | untracked | **untracked** — 13 `.dc.html` files; read for the layout, never staged |
| 20 | `invoiceSettlement` | `Db \| Tx`, invoice-keyed | **confirmed** at `invoices.ts:213` |

**17a's gate, confirmed mechanically before a line was written:** `receive`, `deskOrder`,
`resolveRange`, `evaluateFormula` and `matchReflex` all exported from `modules/lab/index.ts`;
`test/helpers/lab.ts` exports `seedLabDeskBase` and `deskAndLabel`; migration `0046` live.

### 9.3 The spike answer (S12) and which inherited answers were re-checked

**S12 — ANSWERED BY READING `enqueue.ts`, AND THE AMENDMENT NOTICE GETS THROUGH.**

`enqueueNotification`'s `dedupeKey` is **caller-supplied** and its uniqueness is a plain
`onConflictDoNothing` on that one column (`enqueue.ts:117-127`). An amendment is a NEW `lab_reports`
row with its own id, so a key derived from the REPORT id — `lab_report_ready:${reportId}` — is
distinct by construction and R-018's re-notification is delivered.

**DD24's fallback is therefore NOT needed.** The amendment notice ships; the runbook does not have
to tell the counter to telephone. That is read off the code rather than assumed, which is what DD24
asked for.

**No deep-link target exists before 22c-F**, confirming spike S7: the body says where to collect and
carries the order number alone.

**Re-checked and still binding:** S1 (the `Tx as Db` savepoint — T7's `refundOnCancel` and the
reflex invoice both rely on it), S4 (the engine checks the role itself — which is F39's mechanism),
S7 (the closed template registry — T7's kernel edit), S9 (a `system` reflex order still owes
`ordering_clinician_id` — the verifying pathologist supplies it).

### 9.1 The commits

| commit | task |
|---|---|
| `f32c331` | **T6** — results: entry, absurd envelope, snapshotted ranges, delta, SoD verify with CAS, criticals, synchronous reflex, `completed` at verify |
| `cfba8d5` | **T7** — reports: versioned snapshots, the invoice-grained interlock, print register, ready-notice, amendment, DD7's cancel money; the kernel template |
| *(T8)* | **T8** — five controllers, four screens, the A4 print, the consult panel, the e2e |
| *(T9)* | **T9** — the gate report, the runbook, this section |

### 9.2 Findings

**F32 — `permission_denied` ADDED to a union whose header forbids widening, on §0's instruction.**
17a §9.2 F28 reported that T3 and T4 refused AUTHORIZATION with `catalogue_invalid` (422) and
`unknown_service` (404); 17b's §0 instructs this phase to add the code and repair the borrowings.
Both were repointed and no test asserted either.

**F33 — `critical_already_closed` ADDED, by the same argument, on my judgment rather than §0's
instruction.** Two nurses reading back one potassium is the ordinary race and the loser needs a 409
of its own; borrowing `already_verified` would put a word about a pathologist's signature on a
telephone call, which is F28's defect committed while fixing it.

**F34 — NIGHT MODE IS DERIVED FROM THE IST CLOCK, NOT FROM THE DEFINITION FLAG DD11 NAMES.**
`single_operator_night_mode` does not exist: `defineWorkflow` validates a closed shape and
`workflow-def.ts` is 17a's, frozen by §8. The alternative — a `nightMode: true` INPUT — is worse
than no control at all, because a boolean that switches off separation of duties is switched on by
whoever wants it off. 21:00–07:00 IST, computed from `now`, unchosen by any caller. 17-E owns
the real per-deployment switch.

**F35 — DD7 IS WRITTEN TWICE.** `money.ts`'s `refundOnCancel` and `sweeps.ts`'s inline credit note
(17a T5). They agree today because the sweep's items are always at `recollection_pending` with no
result row — a strict subset of leg 3 — but they are two copies of one rule and `sweeps.ts` is
frozen. Every path this phase adds goes through `refundOnCancel`.

**F36 — `lab.report_print_blocked`'s payload field is `unpaidLineIds` and it carries INVOICE ids.**
DD23 ruled the interlock invoice-grained AFTER `events.ts` was written, and `events.ts` is T2's
frozen file. Naming the invoices is the honest payload; renaming the field belongs to a phase that
may edit it.

**F37 — THE `lab_item` DEFINITION CANNOT LEAVE `resulted` OR `verified` FOR `cancelled`.** DD7's
middle leg — cancelled from `in_progress` with a result already keyed — is exactly the state the
machine cannot leave. `cancelLabItem` cancels the ENVELOPE and applies the money rule
unconditionally, moves the lab instance when the pinned definition allows it, and **returns the
state it was left in** rather than pretending. Harmless in practice: every worklist and every sweep
in this module keys off `order_items.status`, which `worklist.ts`'s header states and its query
makes true.

**F38 — DD13's SUPERSEDING ROW HAD NO WRITER, AND T7 A6 IS WHAT FOUND IT.** The immutability trigger
refuses an UPDATE to a verified result and `enterResult` refuses a `completed` item, so *"a
correction after verification is a NEW row carrying `supersedes_result_id`"* was unbuildable by any
shipped path. `amendResult` is that writer: `lab.reports.amend`, entered and verified in one act by
the amending pathologist, the superseded row readable for ever.

**F39 — FIFTEEN PERMISSIONS AND NO ROLE IS A LOGIN THAT CANNOT DRAW BLOOD.** `@RequirePermission`
gates the ROUTE; the workflow engine gates the TRANSITION on the definition's declared ROLE LIST
against `user_roles`, and permissions are not consulted (17a S4). **Found by `lab.e2e.test.ts` and
by nothing else** — every service-level fixture builds users with real role keys, so 243 green tests
could not see it. It is a go-live fact: the runbook's §0 exists for it and the e2e pins it.

**F40 — A THIRD ROUTE CENSUS THE FILES LIST DOES NOT NAME.** §2 row 18 names `nav-parity.test.ts`
and `shell-nav.test.tsx`. `apps/core/test/caddyfile-parity.test.ts` pins the SPA route COUNT — 35
before this phase, 39 after — and it is the file five previous phases have each had to join. Found
by grepping for `router.tsx` rather than for a sibling's name, which is §2.138's own instruction.

**F43 — SIX OF SIXTEEN REALTIME NAMES COULD NEVER PRODUCE A TOPIC.** `lab.specimen_collected`,
`lab.specimen_received`, `lab.specimen_rejected`, `lab.recollection_requested`, `lab.result_entered`
and `lab.result_verified` declare neither `orderId` nor `orderGroupId` in their payloads
(`events.ts`), and `TailedEvent` carries `{seq, eventId, name, occurredAt, patientId, encounterId,
payload}` — **no correlation id** — so `labTopicsFor` returned `[]` for every one of them while
`realtime.ts`'s own header promised a counter would watch "the tube drawn, received, resulted,
signed and published". Found by close review pass 1 (M5). `events.ts` is T2's frozen file, so the
six are REMOVED from `LAB_REALTIME_NAMES` rather than left as a promise nothing keeps: the phase
that may edit `events.ts` adds `orderGroupId` to their payloads and puts them back.

**F42 — `verify.ts` IS THE TWELFTH IST CLOCK, AND THE FULL VERIFY IS WHAT FOUND IT.** DD11's night
window is 21:00–07:00 **IST**, so `isSingleOperatorNight` carries the offset. `ist-clock-parity.test.ts`
pins the census and lives in `test/`, so the lab module's own suite was green and the workspace run
went red — **which is exactly what happened to 17a T4 with the eleventh copy, one task earlier.** The
site is DECLARED with a written argument rather than dodged: computing the hour through `Intl` and
`Asia/Kolkata` would give the same answer and would NOT appear in the census, which is the reason not
to do it. The census file joins T6's surface after the fact and is named in T9's commit message.

**The companion habit this bought:** a phase that computes an IST anything reads
`test/ist-clock-parity.test.ts` BEFORE it commits. Two consecutive lab tasks each added a clock and
neither noticed until the full run.

**F41 — DD23's MULTI-INVOICE LOOP IS DEFENSIVE, NOT EXERCISED BY ANY SHIPPED WRITER.** One lab order
carries exactly one invoice today: `deskOrder` bills all of an order's items together and DD9 makes
an add-on a NEW order. `lab_items.invoice_id` is per ITEM, which is why the loop exists; 26's package
or a re-billing path will be its first real caller. Both interlock rows that need two invoices build
the second through billing's own writer and repoint the lab's own column, disclosed in the test.

**Three files this phase's Files lists do not name, all disclosed on 17a F9's precedent:**
`test/helpers/lab.ts` (`grantLabResultPermissions`, `runLabOrder`, `settleInvoice`),
`modules/lab/verify.test.helpers.ts` (`activateTshReflex` — importing it from `verify.test.ts` would
register that file's `describe` blocks into the importing suite), and `modules/lab/worklist.ts` (the
two worklists, needed by two controllers). `lab-http.ts` is a fourth: the shared error mapper, which
T8's Files list implies at five call sites and names at none.

### 9.4 The Assertion Book, corrected by execution

| row | as authored | as executed, and why |
|---|---|---|
| **T6 A8** | glucose 1200 | **GLUF 1600.** The golden catalogue's envelope is 5 … 1500 mg/dL, so 1200 is INSIDE it: the plan's own input would have passed against an implementation with no envelope check at all. |
| **T6 A1** | "a tech holding both permissions" | **a user holding both ROLES.** A technologist is refused by the workflow's own role check on `resulted → verified` before the SoD guard is reached, so the plan's input would have died for the wrong reason. |
| **T6 A3** | "a CBC with 3 analytes" | **TFT**, which reports exactly three. The fixture's CBC reports sixteen. |
| **T6 A7** | HB | **CREA** — `delta_abs 0.5` over 168 h and NO critical band, so the row measures the delta alone rather than opening a call ladder beside it. |
| **T7 A1** | a CBC paid at the desk + a reflex on credit, ONE order | **two assertions.** DD9 makes a reflex a NEW ORDER with its own invoice, so `deliveryAllowed(deskOrderId)` legitimately never sees it — the reflex order's OWN report is held, and separately an order billed across two invoices is held while either is unsettled (F41). |
| **T7 A6** | "2 report rows, 2 result rows" | **unchanged, and it needed a writer that did not exist** (F38). |
| **M4's own test** | one TFT, one analyte signed | **two orderables, one analyser down.** `partial` is ITEM-grained: `buildSnapshot` includes an item only when it is `completed`, and an item completes only when its LAST analyte is signed — so a one-item order has no partial state at all and the first version of this row was refused *"a partial report of nothing is not a report"*. The code was describing the fixture correctly; 02 D7's real case is two tests. |

### 9.5 Mechanical verification — the database of every run named (§2.137)

**Every run in this phase used `TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_17b_lane"`**,
a lane-private database created by `ensureWorkerDatabaseExists` and migrated from empty. It is named
here because §2.137's whole lesson is that the two obligations which make the technique safe are
exactly what erase the proof it ran.

**Fail-first, quoted.** The first run of `results.test.ts` against unmodified shipped code:
`Tests: 3 failed, 8 passed, 11 total` — `"0.9" vs "0.9000"` (the column's own `numeric(14,4)`
scale), `"1600" vs "1600.0000"`, and `TariffError: no price for LABSVC-MP`. The first run of
`money.test.ts`: `Tests: 2 failed, 6 passed, 8 total` — `WorkflowError: no transition
resulted→cancelled in lab_item`, which is F37, found by the assertion rather than by reading. The
first run of `lab.e2e.test.ts`: `expected 201 "Created", got 403 "Forbidden"` on the label print,
which is F39.

**T8 is ROUTINE and owes no fail-first. Said so rather than manufactured.**

**THE FULL WORKSPACE VERIFY, RUN DETACHED WITH ITS EXIT VALUE READ FROM A FILE (rule 18).** The
first full run at the T8 boundary came back **exit 1: `Test Suites: 3 failed, 310 passed, 313 total ·
Tests: 2 failed, 3037 passed, 3039 total`**, and the three are three different things, reported
separately because averaging them would hide the only one that mattered:

| suite | cause | verdict |
|---|---|---|
| `test/ist-clock-parity.test.ts` | **A REAL DEFECT OF THIS PHASE** — `verify.ts` is a twelfth IST clock and was undeclared (F42) | fixed; the site is declared with a written argument |
| `test/patients-lifecycle.e2e.test.ts` | `Exceeded timeout of 15000 ms for a hook` in `beforeEach` | environmental — **load average 14.21 / 19.49** during the run, and the suite runs in **9.87 s** isolated. Ledger §2.144's exact class |
| `src/modules/opd/fhir.test.ts` | `A jest worker process (pid=2102292) was terminated by another process: signal=SIGKILL` | environmental — memory pressure at the same load |

All three re-run ISOLATED after the fix: `Test Suites: 3 passed, 3 total · Tests: 6 passed, 6 total`,
exit 0, on `hmis_17b_lane`. **The load was this session's own doing** — a close-review agent was
reading the checkout while the verify ran — which is AGENT-RULES rule 20 pointed at myself: my own
concurrent work made my own timing evidence unreliable.

**The final full verify is run after the close review's remediation and its exit value is recorded
in §9.6.**

**Mutants (rule 21 / §3 CRITICAL) — twenty-three built, twenty-three DIED**, each run isolated with
the isolation line read from the OUTPUT (`9 skipped, 1 passed, 10 total` / `1 failed, 13 skipped,
14 total`), never from the exit code:

- **T6, ten:** a1 (SoD on the role), a2 (read-then-write CAS), a3 (advance on the first verify),
  a4 (the reflex on its own transaction — against a CONTROL that is the shipped code with the same
  injected throw, which PASSED), a4b (consent ignored), a5 (the call opened at verify), a6 (no range
  snapshot), a7 (the previous row regardless of status), a8 (no envelope check), a9 (actor type not
  checked).
- **T7, thirteen:** a1 (the desk invoice only), a1b (partial treated as settled), a2 + a2d (the payer
  and the day-care prefix ignored), a3 (the interlock applied at READ — **it returned nothing to the
  doctor**), a4 (the release writes a credit note — **₹300 outstanding became ₹0**), a5
  (`cancelled_from` ignored), a6 (the prior version not superseded), a6b (the correction names
  nothing), a7 (`sensitive` not checked — an HBsAg result was messaged), a7b (the notice carries more
  than the order number), a8 (the log skipped on the alias path), a9 (the collector optional).

All mutant scratch — `results.mutant.ts`, `verify.mutant.ts`, `money.mutant.ts`, `interlock.mutant.ts`,
`reports.mutant.ts`, two scratch specs, two harness scripts — was `rm -f`'d before each commit and
`git status --porcelain` read before each `git add`.

### 9.6 The close review

#### 9.6.1 Pass 1 (FRESH, forbidden to run tests) — four CRITICALs, nine MAJORs, eight MINORs

**It answered the §9 brief first, and the answer was a finding.** *"For `deliveryAllowed`, name one
real charge its sum does not include"* → **the reflex test's.** A TSH paid ₹300 in cash at the desk,
reflexing an FT4 onto a new order with its own unpaid credit invoice, leaves `deliveryAllowed(L-1)`
reading `settled` while ₹450 stands — because `billedLabLines` is scoped to ONE order and DD9 makes
a reflex a new one. §9.2 F41 disclosed the mechanism; the reviewer named the consequence, which the
disclosure did not: **the sum for the order being handed over excludes a charge created by the same
clinical act, on the same tube, minutes earlier.**

**THE FOUR CRITICALS, ALL REAL, ALL FIXED:**

| # | what it was | what it cost |
|---|---|---|
| **C1** | `GET /lab/reports/order/:orderId` returned `select()` with no projection — the raw `snapshot`, which carries the **legal** name by design (E4) | a sealed VIP's legal name, UHID and date of birth to any holder of `lab.results.read`, with **no alias rule and no `phi_access_log` row**. `getReport` applies both; this was a second reader on the same controller with neither. **§2.140's own shape** — a disclosure removed at one reader and left standing on a sibling added in the same commit |
| **C2** | `amendResult` computed a flag and threw it away: returned `flag: null`, opened no call, emitted no critical or notifiable event | a potassium signed at 22:00 as 4.2 and corrected to 6.9 at 09:00 produced a critical value on a signed report **that nobody was telephoned about**, on the one path where the value is KNOWN to have been wrong |
| **C3** | `computeFormulaAnalytes` skipped any analyte that already had ANY row | a rerun correcting cholesterol 500 → 150 left the LDL at 426. A signed report reading *cholesterol 150, LDL 426* — arithmetically impossible, and a cardiologist acts on it |
| **C4** | `completeItemIfSigned`'s fold was an unlocked READ COMMITTED count | two pathologists signing the last two analytes each saw the other's still unverified: **`completed` never fired**, the item sat on the verify queue for ever with every value signed, and `publishReport` refused "not finished" permanently. **No recovery through any shipped route.** `advance.ts` documents this identical defect one level up and fixed it with `FOR UPDATE`; the pattern had not been applied |

**THE NINE MAJORS.** M1 — the reflex's invoice ran unguarded in the verifying transaction, so an
unpriced reflexed test (an ordinary go-live gap: the counter never SELLS an FT4) made **every TSH
with reflex consent unsignable** and the treating doctor saw nothing. Money held a clinical fact,
which is 02 O-1 inverted. M2 — two concurrent amendments left TWO `published` versions. M3 — the
supersession chain had **no writer**: the route's schema named neither field, so zod stripped them
and every re-keyed value wrote a NULL chain. M4 — a completed partial stayed stamped PARTIAL for
ever. M5 — six of sixteen realtime names could never route. M6 — the delta scanned every patient in
the window, ~2,500 sequential round-trips inside the entry transaction. M7 — `print_count` was a
read-then-write. M8 — one grant released every version, unlimited times, for ever. M9 — a whitespace
value became `0`, then `""` in a `numeric`, then a **500**.

**AND THE WEB SLICE, which pass 1 delegated and relayed** — five more CRITICALs, every one real:
the consult panel rendered a failed query as *"No verified laboratory results"* **to a prescriber**;
`wristbandScanned` defaulted to `true` with the checkbox below the button; the Publish button sat on
rows that vanish the moment publishing becomes legal, so **no report could be published from any
screen**; the desk sent `credit` on every order, so the interlock held 100% of reports for money
already in the drawer; and the critical panel shared one contact/read-back across all open calls, so
a read-back typed for one patient could close another's.

#### 9.6.2 Pass 2 (FRESH, over the fixes)

Filled after the remediation.

### 9.7 Actuals — the token balance at every task boundary (v3 §6)

| boundary | consumed | of the 1,570,000 stop-loss |
|---|---|---|
| kickoff (reading, §2 re-measure, gate confirmation) | ~88,000 | 6% |
| **T6 committed** (`f32c331`) | ~354,000 | 23% |
| **T7 committed** (`cfba8d5`) | ~477,000 | 30% |
| **T8 code-complete** | ~622,000 | 40% |
| **T9 documents written** | ~645,000 | 41% |

**Reported as a fraction of stop-loss ONLY here, at CLOSE** — §0's instruction, bought by 17a
reporting "51%" at a task boundary with the review correctly named as unspent and then calling it
"three times what the phase needs" a paragraph later.

The per-task terms against §0's restated budget: T6 at **~266,000 against 250,000** (6% over),
T7 at **~123,000 against 250,000** (51% under), T8 at **~145,000 against 300,000** (52% under),
T9 at **~23,000 against 80,000**. The fixed term ran at 88,000 against 90,000. **T7 and T8 were both
about half their budgets and T6 was the only overrun**, which is the opposite of the shape §0
predicted — T8 was called "genuinely the largest surface in either half" and cost less than T6.

### 9.8 The question this phase existed to answer

*Can a laboratory that can take a tube be made into a laboratory that can report on it, without any
of the four things that make laboratory software dangerous — a wrong number reported as right, a
result the ordering doctor cannot see, a critical value nobody telephoned, and money moved by a
document leaving a building?*

**Yes, and each of the four is closed by a different mechanism rather than by the same one four
times.** The wrong number is closed by an envelope that needs a second person's name and a range
snapshotted at entry. The invisible result is closed by a reader that does not consult the
interlock — the one line in this module whose failure kills somebody, and the one the mutant proved
returns nothing when it is broken. The un-telephoned critical is closed by a call opened at ENTRY
that only a read-back closes. And the money is closed by an interlock that holds a DOCUMENT and by
a release that provably moves not one paisa.

### 9.9 Deploy block — written when the owner authorises, never before

**NOT WRITTEN. The module is code-complete and not deployed.** The go-live acts live in
[`docs/runbooks/lab-go-live.md`](../../runbooks/lab-go-live.md) and the honest state of the work is
in [`reports/2026-08-30-plan-17-gate-report.md`](reports/2026-08-30-plan-17-gate-report.md).

**The blocker is not code.** Production has ONE full administrator, and DD11's separation of duties
— the control this module is built around — cannot be satisfied by one pair of hands.
