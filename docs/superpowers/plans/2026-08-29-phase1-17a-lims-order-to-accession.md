# Plan 17a — LIMS, order to accession: catalogue, the desk, the tube

**Written 2026-08-29 on the build host, AFTER Plan 17 stopped at its T2 boundary and the owner
authorised the re-cut. NOT APPROVED FOR EXECUTION — execution is a separate session with its own
approval.**

**THE RE-CUT, IN ONE PARAGRAPH.** Plan 17 shipped T1 (migration `0046`, thirteen lab tables, two
immutability triggers) and T2 (the module seam that CLAIMS the `lab` order kind) as `39beff0`, and
then stopped: two ROUTINE tasks had consumed 66% of a 730,000 stop-loss whose per-task term was
derived from a REVIEWER's rate and never contained the main session at all (ledger §2.141,
EXECUTE-METHOD-V3 §6 as amended the same day). The owner ruled the remaining seven tasks into two
phases. **This is the first: T3, T4 and T5 — the catalogue, the desk, and the tube — ending at a
state a lab actually reaches, which is an accessioned specimen with its TAT clock running.**
[`17b`](2026-08-29-phase1-17b-lims-result-to-report.md) takes T6–T9 from there.

**THE TASK NUMBERS DO NOT RESTART, AND THAT IS DELIBERATE.** These are Plan 17's T3, T4 and T5,
keeping the names its CLOSE already uses: §9.2's findings and §9.4's Assertion-Book corrections cite
`T4 A3`, `T4 A7`, `T5 A2` by number, and renumbering would create a translation layer between two
documents — §2.54's mechanism, at document scope. **Plan 17's §5 T3–T5 are STRUCK IN PLACE and point
here**; this document owns them now.

**WHAT THIS PHASE INHERITS AND MUST NOT RE-DERIVE** — all of it lives in
[`2026-08-29-phase1-17-lims-core.md`](2026-08-29-phase1-17-lims-core.md), which is read by SECTION
and never whole (90 KB):

| what | where | why it matters here |
|---|---|---|
| the twenty-one design decisions | §4 (`DD1`…`DD21`) | the rulings; this document restates none of them |
| the spike, ANSWERED | §9.3 (S1–S9) | **S1, S2, S3, S4, S6 all bind T4 and T5.** Read them instead of re-reading billing and opd |
| the nine findings | §9.2 (F1–F9) | **F7 changes T4's A3. F1 changes T4's event name. F2 is already granted** |
| the Assertion Book corrections | §9.4 | four rows this document has already applied — the table says which |
| the CONTRACT and the freezes | §6, §8 | what 17-E/17-M/24a/26 inherit; unchanged by the re-cut |
| the edge-case pass | §7 (E1–E51) | the rows this phase owns are named in §7 below |
| what T1/T2 actually shipped | §9.1, §9.5 | thirteen tables, four kernel edits, the census numbers |

---

## 0. EXECUTOR SEED — read this, then execute

**v3 §1 retired the separate execute-prompt** (*"the seed for a fresh executing session is three
lines"*), and Plan 17's audit priced the exception: a second document is a second copy of the task
list and it is re-billed on every tool call. So the seed is here.

**Read, in this order, before the first tool call:**

1. [`../AGENT-RULES.md`](../AGENT-RULES.md) — in full. Rule 3 (no `/tmp`; heredoc scripts), rule 7
   (a scratch database you name, use and drop), rule 20 (`pgrep -af jest` — **read the matched
   lines, never the count**), rule 21 (build the mutant, never predict it), §3 (mutant discipline by
   tier), §5 (the finish block), §6 (migrations are irreversible host mutations).
2. **This document, in full.** It is ~41 KB and it is the only plan you read whole.
3. Plan 17's §9.3 (the spike answers) and §9.2 (the findings) — those two sections, by line range,
   not the document.
4. [`reports/2026-08-26-parallel-session-protocol.md`](reports/2026-08-26-parallel-session-protocol.md)
   §1, §2, §7 — **Lane B (Plan 18a, radiology) shares this checkout.** Run §2's pre-flight before
   you begin and before every broad suite; read `git status --porcelain` before every `git add`.
5. The ledger's **§5 only** — measure its line first (`grep -n '^## 5' reports/EXECUTION-LESSONS.md`;
   1485 on 2026-08-29, and it has moved 160 lines in a day). Entries cited by NUMBER, read one at a
   time: §2.54, §2.115, §2.131, §2.133, §2.137, §2.138, §2.139, §2.141, §2.142.
6. The seam, only when you reach the task that calls it: `kernel/orders/{place,advance,read}.ts`
   (T4, T5), `modules/billing/index.ts`'s exported names (T4), `modules/opd/encounters.ts`'s
   `openVisitInTx` (T4), `kernel/episodes/series.ts` (T5), `kernel/worker/jobs.ts` (T5).

**You are the main session of a LIGHT-lane phase under v3 §3.** You code, task by task,
sequentially, yourself. Three tasks, T3→T4→T5, in order. No coding subagents, no Workflow tool.
Subagents are used for exactly one thing: **two FRESH close reviewers** (§9.6), never resumed
(§2.115).

**You are NOT authorised** to deploy, to widen your own permissions, to run anything against
`/opt/hmis-prod` beyond a read-only `psql`, or to edit any file this document's §8 freezes.

**RECORD YOUR OWN TOKEN BALANCE at kickoff and at every task boundary, and write the deltas into
§9.7.** This is v3 §6's new obligation and this phase is one of the two that make it real; without
it the next stop-loss is built from a reviewer's rate again.

---

## THE LANE — LIGHT, three tasks, all CRITICAL

**LIGHT**, and the re-cut is what makes that ruling honest. v3 §2 presumes LIGHT for *"≤8 tasks and
no full-module build"*; Plan 17 was a nine-task full-module build ruled LIGHT at its edge, and the
edge is where it broke. **Three tasks is inside the lane by any reading**, and all three are
CRITICAL — a formula-and-range engine that can print a wrong number, a money-plus-idempotency seam,
and a concurrency-and-money seam at accession. CRITICAL means executed mutants, in either lane.

### Stop-loss (v3 §6 as amended 2026-08-29): **1,350,000 tokens**, arithmetic shown

`stop-loss = main-session term + 1.5 × (per-task subagent rate × task count) + one reviewer pass per cycle`

- **Main-session term — 1,090,000.** From Plan 17's measurement, decomposed rather than averaged,
  because the two terms behave differently:
  - **Per-phase fixed ≈ 90,000** — the reading order, the pre-flight, the §2 re-measure. Plan 17
    paid ~150,000 for this because it also ran a nine-question spike and discovered the
    shared-file staging problem; **this phase inherits both**, which is the re-cut paying for
    itself before task one.
  - **Per-CRITICAL-task ≈ 330,000** — Plan 17's two ROUTINE tasks measured ~166,000 each of
    marginal cost (`(482,000 − 150,000) / 2`); a CRITICAL task adds an Assertion Book built and
    executed, and T4/T5 add concurrency rows measured over ≥ 8 rounds. `90,000 + 3 × 330,000`.
- **Task subagent term — 90,801.** `1.5 × (20,178 × 3)`, the old term kept at its old value because
  it is now correctly labelled: it is what the REVIEWERS cost per task, and it is small.
- **Review term — 260,000.** Two FRESH passes (§2.136, §2.140 — never one, and never resumed).
  Measured comparables: 22c-A's pair at 305,491 over nine commits, phase 0's at 348,043 over six
  tasks, and pass 2 of 22c-A alone at 133,904. Three tasks is a smaller surface; two passes at
  ~130,000.
- **Total: 1,440,801 → 1,350,000**, trimmed on the judgement that the fixed term is inherited rather
  than re-paid.

> **THIS NUMBER IS ONE MEASUREMENT EXTRAPOLATED AND IT WILL BE WRONG.** It is recorded with its
> arithmetic so that the CLOSE can say by how much and in which direction, which is the only way the
> third term ever becomes trustworthy. **It is a tripwire, not a target** — a phase that comes in at
> half of it has not underperformed. What must NOT happen again is the previous shape: a ceiling
> that could not cover the work before the first task ran.

**Hand-off rule.** If the session's own token balance passes ~65% of the stop-loss before **T4** is
committed, hand off at a task boundary per v3 §9.6 — typecheck, then the narrowest suite covering
what changed with its exit value read and its database named, then the note. **Running beats
writing**: uncompiled, unrun code is UNKNOWN code however well described.

**Execute this phase in a FRESH session**, and 17b in another. v3 §9.5's arithmetic is about agents
and applies to sessions for the same reason: a session carries everything it has read into every
later call.

---

## 1. Why this phase, and where it stops

**What exists after `39beff0`.** The lab is an ordering department with nothing behind it. The
manifest claims `lab`, thirteen tables stand empty, `LAB_ERROR_CODES` names twenty-nine refusals of
which zero are thrown, and `errors.test.ts`'s direction-1 leg is DERIVED from which files exist — so
it passes today and starts requiring throwers the moment T3 lands `catalogue.ts`, with no edit to
that test at any point. Four roles exist with grants and no holders. `EPISODE_SERIES.lab_specimen`
(`S`) has been reserved since 2026-08-25 and minted by nobody.

**What this phase adds.** The catalogue a lab can be configured with, the desk act that turns a
doctor's `advised_tests` into an order and an invoice in ONE transaction, and the physical chain
from a printed label to a tube received at the bench with its TAT clock started. **It stops at
`advanceOrderItem(… 'in_progress')`** — the envelope's own word for "the department has started".

**Why THIS cut.** The seam is one the CONTRACT already freezes (§6.2, §6.4): *a tube is
`lab_specimens` with an `S` number; an item's CURRENT tube is the `active` row in
`lab_specimen_items`; `in_progress` at receive is one of the three projection points*. Everything
17b does begins by reading an accessioned item, and nothing 17a does needs a result to exist. **A
lab's morning ends here and its bench begins here**, which is why the halves are independently
reviewable rather than merely smaller.

**What this phase does NOT do.** No result, no verification, no report, no interlock, no route, no
screen (17b). Nothing from Plan 17 §1.3's exclusion list changes: no analyzer interface, no QC, no
cultures, no histology, no packages, no patient-app reads, no LOINC load, no PDF renderer, no new
episode series letter, no new resource kind.

---

## 2. Ground truth — measured 2026-08-29 20:0x UTC, HEAD `91462da`

**Re-run every row at kickoff.** Lane B moved rows 1 and 2 during Plan 17's execution and will move
more; that is expected rather than a defect.

| # | fact | value today | how |
|---|---|---|---|
| 1 | migrations in the journal | **48** (`0000`–`0047`); **`0048` is the next free number** and this phase does not need one | `python3 -c "import json;j=json.load(open('apps/core/drizzle/meta/_journal.json'));print(len(j['entries']), j['entries'][-1]['tag'])"` |
| 2 | manifests installed | **18**; `manifests.test.ts` pins the ordered key list ending `lab` | `grep -c 'Manifest,$' apps/core/src/kernel/modules/manifests.ts` |
| 3 | claimed order kinds | **`['lab']`** — two censuses, `orders/kinds.test.ts` (whole declaration) and `orders/parity.test.ts` (kind names) | `grep -n 'claims exactly one order kind' apps/core/src/kernel/orders/kinds.test.ts` |
| 4 | permission census | **126** declared = **111** held + **15** not yet modelled | `grep -n 'toHaveLength(126)' apps/core/test/seed-roles.test.ts` |
| 5 | role census | **29** in `ROLE_MODEL`, **31** `KNOWN_ROLE_KEYS` | `grep -c 'roleKey: "' apps/core/scripts/seed-roles.ts` |
| 6 | lab tables | **13**, live in `schema/lab.ts`, migration `0046` | `grep -c 'pgTable(' apps/core/src/kernel/db/schema/lab.ts` |
| 7 | scheduler jobs registered | **13** — T5 makes it 15 | `grep -c 'scheduler.register' apps/core/src/kernel/worker/jobs.ts` |
| 8 | **the job censuses T5 moves** (§2.131 sibling-grep, directory + glob) | `jobs.test.ts`, `scheduler.test.ts`, `worker-runtime.e2e.test.ts`, `alerts-parity.test.ts`, `manifests.test.ts` | `grep -rn "sweepBatchExpiry" apps/core --include=*.ts \| grep -v /dist/` |
| 9 | `JobIntervals` is a TYPE event | **6 files** carry a literal or the type | `grep -rn 'JobIntervals' apps/core/src --include=*.ts \| grep -v /dist/` |
| 10 | `services` of category `investigation` | **1 in production** (`SYN-LAB-CBC`, synthetic); **no seed script creates any** | Plan 17 §9.3 S5 |
| 11 | `opd_departments` | **12 in production, no `LAB`** | Plan 17 §9.3 S5 |
| 12 | test files / tests | core **291** files, **2,882** tests | `find apps/core/src apps/core/test -name '*.test.ts' \| wc -l` |
| 13 | foreign files in the tree | Lane B's radiology/pcpndt, `docs/design/`, `.ci-watch.log` — **none of it this lane's to stage** | `git status --porcelain` |

**THE ONE ROW THAT IS A TRAP.** Row 1 says `0048` is free **and this phase should not need it**. All
thirteen tables and both triggers shipped in `0046`. **If you find yourself generating a migration,
stop and ask what column you are adding and why T1 did not have it** — a new column on a lab table
is a plan defect to report (AGENT-RULES: disclose, do not work around), and a new column on the
ENVELOPE is forbidden outright by phase 0 §8.1.

---

## 3. Spike — the answers are inherited; two questions are new

**Read Plan 17 §9.3 for S1–S9.** Five of them bind this phase and are summarised here ONLY as
pointers, because the fact rule puts the answer in one place:

- **S1** — `issueInvoice(db, actor, input, now?)` is `Db`-first and opens its OWN `withTx`; it
  refuses a remainder without `credit: {reason}` AND `billing.credit.extend`; `settlementState` is
  keyed on the INVOICE. **Binds T4 and T5.**
- **S2** — `openVisitInTx` requires a `user` actor, an ACTIVE doctor in an ACTIVE department with
  `doctor.departmentId === dept.id`, and it mints a `V` number, a workflow instance, a session and a
  queue token. **Binds T4.**
- **S3** — `payee_class` is `channel_partner | staff_internal | external_rmp`; class (c) is
  `external_rmp` and `accrual.ts:319` refuses a payable to one; **`orders.external_referrer_id` has
  NO foreign key** — it is `text` with a biconditional CHECK. **Binds T4 A7.**
- **S4** — `transition(tx, instanceId, to, actor, opts)`: the ENGINE checks that a `user` actor holds
  one of the transition's declared roles; `system` bypasses; `agent` is denied. **Binds T4's two
  definitions.**
- **S6** — `nextEpisodeNo(tx, 'lab_specimen', serviceDate)` → `S2608290001`; `episode_series` is keyed
  `(series_key, service_date)`; the allocator is a single-winner `UPDATE … RETURNING` whose returned
  value is POST-increment. **Binds T5.**

**TWO NEW QUESTIONS, answered at kickoff and recorded in §9.3.** Both size T5 and neither changes the
ruling:

| # | question | why it changes the work |
|---|---|---|
| **S10** | What does `scheduler.register` take, and which of the thirteen shipped jobs is the closest shape to a sweep that reads a due-time and emits — `sweepBatchExpiry` or `retentionSweep`? Does the scheduler pass an injected clock, or does the job read `new Date()`? | T5 A4 asserts a 7-day boundary at −7 d 1 h and −6 d 23 h. **A sweep that cannot be handed an instant cannot be tested at a boundary**, and the alternative — waiting seven days — is not a test. If no seam exists, T5 reports it as a plan defect rather than inventing a test-only clock (§2.127). |
| **S11** | Production, read-only: does any `resources` row of kind `bench` exist, and does `resources` carry a code the catalogue's `bench_key` could match? | T5's bench worklist keys on `lab_orderables.bench_key`. If no bench rows exist — and row 7 of Plan 17 §2 says nobody declared the kind before T2 — then the worklist is correct and empty, the golden fixture supplies the keys, and **creating the bench rows is a runbook act in §9.9, not code.** Say which. |

---

## 4. Design decisions — POINTERS, not restatements

**Every ruling this phase implements is in Plan 17 §4 and is unchanged.** The ones it implements:
**DD1** (two-level catalogue), **DD2** (ranges resolved at entry, snapshotted), **DD3** (guarded
formula evaluator), **DD4** (two workflow definitions, three projection points — this phase owns the
first, `in_progress` at receive), **DD5** (`S` numbers, one active tube per item), **DD6** (money at
order time at the desk; collection NEVER blocked by payment), **DD9** (an add-on is a new order in
the same group), **DD10** (right-patient scan before the label prints), **DD14** (consent-class ⇒
`restricted:true` at placement), **DD15** (the walk-in is a `V` visit), **DD19** (idempotency on
every document-creating route), **DD20** (two worker sweeps, no placements).

**ONE RULING IS NEW, AND IT IS THE RE-CUT'S OWN.**

**DD22 — THE PHASE BOUNDARY IS `in_progress`, AND 17a SHIPS NO ROUTE.** Plan 17's T8 mounted every
controller at once. That is now 17b's, and 17a therefore ships **services with no HTTP surface** —
the shape T2 already took deliberately (*"routes land when there are functions behind them"*).
Two consequences, both intended:
- **`withIdempotency` is NOT exercised in this phase.** DD19 puts it on the ROUTE, and phase 0 §6A.2
  is explicit that *"idempotency belongs to the ROUTE"*. T4 therefore ships `deskOrder` as a
  transaction-shaped service and **asserts A1/A1b/A2 by calling `withIdempotency` directly around
  it**, exactly as 17b's controller will — the wrapper is imported from `../billing`, not
  reimplemented, so the test and the controller call the same function.
- **A1's "same `orderNo` and same `invoiceId` on replay" is still fully testable**, because
  `withIdempotency` is a function and not a decorator. What is NOT testable until 17b is the wire:
  22c-A's C1 (a field missing from the wire schema returned 200 and wrote nothing) is 17b's to
  prove, and 17b's §5 T8 says so.

---

## 5. Tasks

**Files list discipline:** every task names its files; `git status --porcelain` is read before every
`git add`; `docs/design/` and anything Lane B writes are never staged. **Where two lanes have edited
one FILE, stage HEAD-plus-your-hunks as a blob** — ledger §2.142 gives the two commands, and reading
`git diff --cached --stat` afterwards is part of it.

**There are NO kernel edits in this phase.** Plan 17's four are shipped. If a task believes it needs
a fifth, that is a finding for §9.2, not a diff.

### T3 — Catalogue service, reference-range resolver, formula evaluator, reflex matcher, analyte-overlap duplicate detector, golden fixtures — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{catalogue.ts, ranges.ts, formula.ts, reflex.ts, duplicates.ts}` + tests, `apps/core/scripts/seed-lab-catalogue.ts`, `apps/core/test/fixtures/lab-catalogue.json` (~60 orderables, ~140 analytes, ranges, three reflex rules, **all reflex rules `active: false`**); Modify `apps/core/src/modules/lab/index.ts` (the exports T4 and 17b import).

**Produces:** `resolveRange(analyte, {ageDays, sex, pregnancyTrimester?}, at)` (DD2, PURE);
`evaluateFormula(analyte, siblings)` (DD3, PURE, guarded, **no `eval` and no `Function`
constructor** — a small recursive-descent parser over `+ - * /`, numbers, parentheses and sibling
CODES, and nothing else); `matchReflex(rules, result)` (PURE); `overlappingAnalytes(a, b)` and
`duplicateWarnings(exec, actor, canonicalPatientId, serviceIds, now)` — which resolves the merge
chain through `patients`' `resolvePatientId` FIRST (§6A.4), then calls `findRecentItems` per
candidate `service_id` **AND per every orderable sharing ≥ 1 analyte with it** (§6A.3), window from
the catalogue (default 24 h; troponin 6 h — 02 D11); `upsertOrderable` / `upsertAnalyte` with a
`version` bump, gated on `lab.catalogue.manage`, **refusing `reports_foetal_sex: true`** (E33 — the
database refuses it too, T1 shipped the CHECK, and the service refusal is what names the law rather
than the constraint); the seed script, creating the `investigation` `services` rows the fixture
names (row 10: none exist).

**THE FIXTURE IS A DELIVERABLE, NOT A CONVENIENCE.** §4A item 3 routes the REAL catalogue to the
owner; without a golden one this phase is unexecutable and 17b has nothing to result against. It is
drawn from standard kit-insert ranges, it is committed, and **production seeding stays a runbook act
on the owner's spreadsheet** (§9.9), exactly as 07d's formulary was.

#### Assertion Book — T3

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | Range resolution uses age AT COLLECTION in **IST** days, and the band boundary is inclusive-low / exclusive-high. | Age computed from `now` in UTC. | **DOB `2025-08-29`, collected `2026-08-29T00:30+05:30` (= `2026-08-28T19:00Z`).** Shipped: 365 days → infant band. Mutant: 364 → neonate band, different `ref_high`. |
| **A2** | `sex='any'` is the fallback when no sex-specific row exists; `other`/`unknown` never throws and stamps `ref_note`. | Fallback to `male`. | **Haemoglobin with male/female rows only, patient `other`.** Shipped: no numeric range + the note. Mutant: the male range, no note. |
| **A3** | Friedewald LDL yields `'not calculable (TG ≥ 400)'` TEXT, never a number, when the guard fails. | Guard ignored. | **TC 200, HDL 40, TG 450.** Shipped: text. Mutant: `70`. |
| **A4** | A formula reads siblings of the SAME specimen only. | Latest sibling result for the patient, any specimen. | **Two specimens the same day; TG on the second only.** Shipped: LDL on the first is `'not calculable (TG missing)'`. Mutant: computes with the second's TG. |
| **A5** | Duplicate detection sees a CBC inside "Fever Profile" ordered yesterday when a standalone CBC is ordered today. | Compare `service_id` only. | **Profile P (analytes CBC+Widal) placed −20 h; order CBC now.** Shipped: a warning naming P's item. Mutant: none. |
| **A6** | Duplicate detection resolves the merge chain BEFORE it looks. | Look up the given id. | **Patient B merged into A; B's order −2 h; order for A now.** Shipped: warning. Mutant: none. |
| **A7** | Reflex matches only ACTIVE rules **and** only when the parent item carries `reflex_consented_at`. | `active` ignored. | **TSH 9.0, rule TSH > 6 → FT4, rule INACTIVE.** Shipped: no match. Mutant: match. |
| **A8** | A `critical_low/high` override on the RESOLVED range row beats the analyte's default. | Read the analyte's only. | **K⁺ neonate range row with `critical_high 7.0`, analyte default 6.0, value 6.5.** Shipped: not critical. Mutant: critical. |
| **A9** *(new — the parser is the thing that can print a wrong number)* | The formula parser accepts ONLY the declared grammar and refuses everything else, by refusal rather than by silence. | Parser falls back to `Function(expr)`. | **`formula: "process.exit(1)"` and `formula: "TC - HDL - (TG/5"`.** Shipped: `catalogue_invalid` at upsert, both. Mutant: the first EXECUTES. |

**Acceptance:** every row per rule 21 (built, run isolated, DIED/SURVIVED with expected-vs-received
quoted); the golden fixture round-trips through the seed script onto the named private database and
`select count(*) from lab_orderables` matches the fixture; **fail-first owed and quoted** — these are
new pure functions, so a red is cheap and honest.
**Commit:** `feat(core): lab catalogue, IST age-band range resolver, guarded formula evaluator, analyte-overlap duplicate detector (17a T3)`

### T4 — Ordering at the desk: advised tests → order + invoice in ONE transaction; walk-in visit; consent gate; add-on; the two workflow definitions — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{desk.ts, workflow-def.ts, definitions.ts}` + tests,
`apps/core/src/modules/lab/definitions/{lab_item.json, lab_specimen.json}`; Modify
`apps/core/src/modules/opd/encounters.ts` (export `openLabWalkin`), `apps/core/src/modules/opd/index.ts`
(re-export), `apps/core/src/modules/lab/index.ts`.

**Produces:** `deskOrder(tx, actor, input)` →
`{encounterNo, orderGroupId?, items:[{serviceId, priority?, consent?:{recordedBy}}], invoice:{draftId, receipt?}, reflexConsent, duplicates:{acknowledged:[…]}}`
— `placeOrder` (kind `lab`; `authority` from the visit), `restricted:true` for `consent_required`
orderables, `origin:'duplicate_confirmed'` + `duplicate_of_item_id` for acknowledged duplicates, then
`issueInvoice` with one line per item and the visit's tags, then `lab_items` rows carrying the
invoice ids and `startInstance('lab_item')` per item, then `lab.order_desked` — **all in the
caller's transaction**. `addOnOrder(tx, actor, {parentItemId, serviceIds, specimenId?})` per DD9 with
`charge_reason:'lab_addon'`. `openLabWalkin` per DD15.

**Definitions:** `lab_item` — `ordered → awaiting_collection → collected → accessioned → in_analysis
→ resulted → verified → published`, with `recollection_pending`, `cancelled` and `sent_out` (17-M)
reserved, and a `rerun` loop `resulted → in_analysis`. `lab_specimen` per brainstorm §3.2. Both
validate under `defineWorkflow`; **the `verify` transition declares `pathologist`** because S4
established the engine checks a `user` actor's roles itself. Drafted and activated by the seed
(Class C default; owner-only activation in production is §9.9's act).

**THE TRANSACTION SEAM — READ FINDING F7 BEFORE WRITING A LINE OF THIS.** `issueInvoice` takes `Db`
and calls `withTx` itself. The seam is `issueInvoice(tx as unknown as Db, …)`, which opens a
SAVEPOINT inside the caller's transaction — the shipped house pattern (`place.ts:296`,
`patients/registration.ts:408`, `materials/grn.ts:379`). **It is a claim about drizzle's nesting
behaviour that NOTHING in this repository has yet proved. A3 is that proof and it is built FIRST**,
before `desk.ts` is finished, because if the savepoint does not roll back with the outer transaction
then DD6's "one transaction" is false and the design changes rather than the code.

#### Assertion Book — T4

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A3** ⚑ | Placement and invoice are ONE transaction: an invoice failure leaves **no order and no `order.placed`**. | Invoice issued after the outer commit. | **A fixture whose `service_id` the tariff has no price for**, so `issueInvoice` throws inside the savepoint. Shipped: 0 orders, 0 items, 0 events. Mutant: an order with no invoice. **BUILD THIS ROW FIRST (F7).** |
| **A1** | A replayed `lab.desk.place` with the same key returns the SAME `orderNo` and the SAME `invoiceId`, and the database holds ONE order, ONE invoice, ONE `order.placed`. | The idempotency wrapper bypassed. | **Two sequential calls, same key, same body** — through `withIdempotency` imported from `../billing`, the function 17b's controller will call. Shipped: equal ids, counts 1/1/1. Mutant: `L…0001` and `L…0002`. |
| **A1b** | Two CONCURRENT calls with the same key: exactly one does the work, the other returns the replay — **measured over ≥ 8 rounds** (rule 20: `pgrep -af jest` lines READ, `uptime` quoted). | The claim taken AFTER the work. | **`Promise.all` of two placements.** Shipped: 1 order every round. Mutant: 2 in ≥ 1 round. |
| **A2** | The same key with a DIFFERENT body is refused, not replayed. | The body hash not compared. | **The second call adds an item.** Shipped: `idempotency_mismatch`. Mutant: the first invoice returned for a different basket. |
| **A4** | A `consent_required` orderable without `consent` is refused BEFORE `placeOrder`; with it, the item is `restricted:true` and `lab_items.consent_recorded_at/by` are set. | `restricted` left at its default. | **HIV orderable, with consent.** Shipped: `order_items.restricted = true`. Mutant: false — **and the kernel reader then shows it to the ward clerk**, which is the whole of DD14 undone by one boolean. |
| **A5** | The doctor's `advised_tests` convert EXACTLY (same `serviceId` set, same count) and an orphan `serviceId` refuses with `unknown_service` NAMING it. | Skip unknowns silently. | **Three advised, one orphan.** Shipped: refusal. Mutant: two placed, and the patient billed for two of three "as advised". |
| **A6** | An add-on on an OPEN order is a NEW order in the same `order_group_id`, `origin:'addon'`, and touches `order_items` only through `placeOrder`. | `INSERT INTO order_items` on the parent. | **Add LFT to an open CBC order.** Shipped: 2 orders, 1 group, and the parent's `order_items` count stays 1. Mutant: the parent gains an item — the one write with no CAS and no guard (§6A.5/§6A.7). |
| **A7** | A walk-in with `authority:'external_prescription'` carries a `partners.id` — the chosen partner or the seeded sentinel — and emits **`lab.attribution_unverified_flagged`** when there is no Rx image and no confirmation. | The sentinel omitted. | **An unattributed walk-in.** Shipped: the sentinel id and the flag event. Mutant: `orders_external_referrer_ck` throws — **the BICONDITIONAL CHECK, not an FK** (S3: the column has none) — and the desk is unusable for walk-ins. |
| **A8** | `lab_item.json` has no `ordered → resulted` transition and no transition INTO `verified` from anywhere but `resulted`; both JSONs validate under `defineWorkflow`. | A shortcut transition added. | **A matrix walk over every declared pair.** |
| **A9** *(new — S2's consequence)* | `openLabWalkin` refuses when the `LAB` department or the pathologist-of-record is missing or inactive, with the OPD error that names which. | The lookup skipped, `department_id` left null. | **No `LAB` department seeded.** Shipped: `unknown_department`. Mutant: a visit with a null department — and every downstream `intendedPayer` read and every departmental report silently loses it. |

**Acceptance:** rows per rule 21; A1b's rounds measured with `uptime` quoted and the `pgrep` lines
read; `pnpm --filter @hmis/core exec jest src/modules/lab src/modules/opd/encounters.test.ts src/modules/billing/idempotency.test.ts`
green on the named private database; fail-first owed and quoted.
**Commit:** `feat(core): lab desk — advised tests to order + invoice in one transaction, walk-in visit, consent gate, add-on as a grouped order, two definitions (17a T4)`

### T5 — Collection and accession: the phlebotomy queue, labels and `S` numbers, right-patient scan, receive/reject/recollect, TAT start, the two sweeps — **CRITICAL**

**Files:** Create `apps/core/src/modules/lab/{collection.ts, specimens.ts, accession.ts, sweeps.ts}`
+ tests (+ `accession.concurrency.test.ts`); Modify `apps/core/src/kernel/worker/jobs.ts` (two
`scheduler.register` entries), `apps/core/src/config.ts` + `JobIntervals`
(`workerLabSweepIntervalMs`), and **the five job censuses row 8 names** — `jobs.test.ts`,
`scheduler.test.ts`, `worker-runtime.e2e.test.ts` (its *"EXACTLY the thirteen jobs"* becomes
fifteen), `alerts-parity.test.ts`, `manifests.test.ts`.

**Produces:** `collectionQueue(db, actor, {site, serviceDate})` — items `awaiting_collection`, STAT >
urgent > routine, the token, the patient name **through the kernel's alias rule**;
`printLabels(tx, actor, {orderGroupId, scannedUhid})` — refuses `tube_mismatch` when
`scannedUhid ≠ patient.uhid` (DD10), then mints one `lab_specimens` row per distinct
`(specimen_type, container)` across the group's items, `S` via `nextEpisodeNo` (S6), links
`lab_specimen_items`; `collect(tx, actor, {specimenId, wristbandScanned, site})`;
`receive(tx, actor, {specimenNo, containerSeen, identityRecheckBy?})` — the container check (02 G8),
the unscanned-without-recheck refusal (02 A2), **`advanceOrderItem(… 'in_progress')` for every active
item on the tube, `tat_started_at`, `lab.specimen_received`**, and a walk-in with no invoice ⇒
`issueInvoice` on credit (DD6, and `lab_technician` holds `billing.credit.extend` — F2, already
granted); `reject(tx, actor, {specimenNo, reason, attributableTo})` → a NEW specimen for the same
items, `lab.recollection_requested`, **no charge**; `sweepLabNonReturn` and `sweepLabSla` (DD20).

**NEITHER SWEEP PLACES AN ORDER, AND THAT IS DD8's WHOLE ARGUMENT.** Both call `advanceOrderItem` and
emit; neither resolves an encounter. **If you find yourself wanting `placeOrder` in the worker,
stop** — phase 0 §6A.1 records that the worker registers no encounter resolver, so it would fail with
`unknown_encounter` for a visit that exists, which is the right failure and not one to route around.

#### Assertion Book — T5

| # | assertion | mutant | discriminating input |
|---|---|---|---|
| **A1** | Two concurrent `receive` calls for one `specimen_no`: one wins, the other gets `already_received`; exactly ONE `lab.specimen_received` and ONE `order_item.started` per item — **≥ 8 rounds**. | Read status, then update, with no CAS. | **`Promise.all` of two receives.** Shipped: 1/1 every round. Mutant: 2 events in ≥ 1 round. |
| **A2** | `S` numbers are unique across concurrent label prints on the same day — the counter's row lock, INHERITED and re-measured here. | Pre-read `nextNo` outside the update. | **Two concurrent `printLabels`.** Shipped: `S…0001`, `S…0002`. Mutant: a duplicate the UNIQUE refuses in one of them. *(Phase 0 measured the same lock over 12 rounds; this row measures it through the lab's caller.)* |
| **A3** | A rejected specimen's recollection posts ZERO additional charge, and the item's `lab_items.invoice_line_id` is unchanged. | `issueInvoice` on recollection. | **Reject haemolysed, reprint, receive.** Shipped: 1 invoice line. Mutant: 2 — the patient billed twice for one test because the lab dropped the tube. |
| **A4** | The 7-day non-return sweep cancels with `cancel_reason='no_recollection'` and DD7 issues a credit note; a rejection **6 d 23 h** old is untouched. | `>=` off by a day, or the credit note skipped. | **Two rejections at −7 d 1 h and −6 d 23 h, clock injected per S10.** Shipped: one cancel + one credit note. |
| **A5** | `printLabels` with another queued patient's `scannedUhid` refuses `tube_mismatch`, emits `lab.tube_mismatch_flagged`, and writes **no `lab_specimens` row**. | The refusal placed after the insert. | **Two Ram Kumars, the wrong scan.** Shipped: 0 rows. Mutant: a labelled tube for the wrong person — E1, the case every lab has had. |
| **A6** | An unscanned ward collection cannot reach `received` without `identityRecheckBy`; with it, the recheck is stored. | The check skipped when `wristbandScanned=false`. | **A ward collection, no scan, no recheck.** Shipped: `identity_recheck_required`. |
| **A7** | The TAT clock starts at `receive` — not at `collect`, not at placement. | `tat_started_at = placed_at`. | **Place 09:00, collect 09:20, receive 09:50.** Shipped: 09:50. |
| **A8** | The SLA sweep breaches an item whose stage age exceeds the ACTIVE definition's SLA for its priority, emits ONCE, and never for a `cancelled` item. | Emit every sweep. | **Two sweeps over one breached item.** Shipped: 1 event — and the mechanism is T1's `lab_sla_breaches_item_stage_ux`, so the sweep keeps no state. |
| **A9** *(new — CONTRACT 2, and 24a is written against it)* | `receive` for a tube whose every item is `cancelled` refuses `no_active_order` and writes no transition. | Receive anyway. | **Cancel both items, then receive the tube.** Shipped: `no_active_order`, 0 transitions. Mutant: `advanceOrderItem` throws from a cancelled state and the bench sees a raw CAS error. |

**Acceptance:** rows per rule 21; **A1 and A2 measured over ≥ 8 rounds each with `uptime` at launch
quoted and the `pgrep -af jest` lines read, not counted**; the two sweep registrations counted by all
five censuses of row 8; fail-first owed and quoted.
**Commit:** `feat(core): lab collection and accession — S numbers, right-patient scan, receive with CAS and TAT start, reject/recollect free, two worker sweeps (17a T5)`

---

## 6. What 17b inherits from this phase

**17b may be authored and executed against these sentences without reading 17a's code.**

1. **`deskOrder`, `addOnOrder` and `openLabWalkin` are the three write paths that create lab work**,
   all `Tx`-first, all exported from `modules/lab/index.ts`. 17b's controllers wrap them in
   `withIdempotency` (DD19, DD22) and add no second placement path.
2. **An accessioned item is `order_items.status = 'in_progress'` with `lab_items.tat_started_at` set
   and exactly one `active` row in `lab_specimen_items`.** That triple is 17b's precondition for
   `enterResult`, and `item_not_resultable` is the refusal when it does not hold.
3. **The catalogue functions are PURE and are 17b's to call, not to reimplement**: `resolveRange`
   (17b snapshots its output onto the result row), `evaluateFormula`, `matchReflex`.
   **`matchReflex` decides nothing about consent** — the caller checks `reflex_consented_at`, which
   is where T6 A4b's assertion lives.
4. **The two workflow definitions exist and are ACTIVE in dev**; their `verify` transition declares
   `pathologist`, so 17b's SoD guard is an ADDITIONAL check about `entered_by`, never a role check.
5. **`lab.order_desked`, `lab.label_printed`, `lab.tube_mismatch_flagged`, `lab.specimen_collected`,
   `lab.specimen_received`, `lab.specimen_rejected`, `lab.recollection_requested`,
   `lab.sla_breached` and `lab.attribution_unverified_flagged` are EMITTED by this phase.** The
   remaining thirteen of `LAB_EVENTS` are 17b's.
6. **The golden fixture is the catalogue every 17b test builds on** — `test/fixtures/lab-catalogue.json`,
   with reflex rules INACTIVE, which is what makes T6 A7's "no match" leg honest.
7. **No route, no screen, no controller exists.** 17b mounts all of them, and 22c-A's C1 (a field
   missing from the wire schema returned 200 and wrote nothing) is 17b's to prove over HTTP.

**ADDED AT EXECUTION — five sentences 17b needs and cannot read off the design:**

8. **`printLabels` is `Db`-FIRST; `collect`, `receive` and `reject` are `Tx`-FIRST.** The asymmetry
   is load-bearing, not an oversight: `printLabels` is the only one that must WRITE on its refusal
   path (`lab.tube_mismatch_flagged`, F20), and a flag appended on the transaction that is about to
   roll back is a flag that never existed. 17b's controller wraps each in `withIdempotency` exactly
   the same way regardless.
9. **The tube's state machine is `lab_specimens.status`, not a workflow instance** (F15). The
   `lab_specimen` DEFINITION is drafted and activated by `activateLabDefinitions` and validates under
   `defineWorkflow`, and nothing instances it, because the table has no `instance_id`. 17b must read
   the column, and a phase that adds the column should add it with F1's window.
10. **`receive` is defended four deep and only its own CAS produces a readable refusal** (F21). If
    17b ever bypasses `receive` to move an item to `in_progress`, the concurrency safety survives and
    the SENTENCE at the bench does not.
11. **The two sweeps are `(db, now, …)` and neither places an order** (DD8). `sweepLabNonReturn`
    additionally takes `decls`, because `advanceOrderItem` validates against the INSTALLED manifests
    and the worker installs its own set.
12. **A redrawn tube's item goes `recollection_pending → awaiting_collection → collected`, two hops**
    (F23), and the shortcut edge must never be added — the intermediate state is what the seven-day
    sweep measures.

---

## 7. Edge cases this phase owns

**Plan 17 §7 is the full pass (E1–E51) and is not restated.** The rows this phase RULES:
E1 (two Ram Kumars — T5 A5), E2 (ward labels from memory — T5 A6), E4 (merge after results — tables
key `order_item_id`), E5 (outside-collected sample — `collection_site='external'`), E7 (UNK patient),
E8 (two open orders, two tubes — accession matches `specimen_no`, never the patient), E14 (add-on
after the serum is discarded — `disposed_at` refuses, opens a recollection, bills as new), E16
(cancel after the tube is on the bench — the CAS decides), E18 (STAT behind a routine batch — queue
order), E20 (label printer down — `label_source='downtime_kit'` mapped at accession by kit serial),
E22 (pays for 5, doctor adds 2 — DD9), E29 (outside RMP referrer — the sentinel, class (c)), E30
(duplicate same day, two doctors — T3 A5/A6), E31 (HIV consent — T4 A4), E33 (foetal sex — T3 A9),
E43 (ghost result — the definition's matrix refuses entry before accession), E44 (free recollection
abused — recollection only from `lab.specimen_rejected` by a lab actor), E47 (23:58 IST placement —
the desk passes the visit's `service_date` and never re-derives), E49 (collection sites), E51 (home
tube with no active order — T5 A9).

**Carried to 17b:** E13, E21, E23, E24, E25, E27, E34–E42, E45, E46.
**Carried out of Plan 17 entirely:** E6, E12, E19, E50 (17-E), E28 (per-line payer — 46), E3's twin
banner (a `patients` attribute that does not exist — 02 §15.11), E32 (MLC — 40a).

---

## 8. What this phase FREEZES

Plan 17 §8's thirteen items stand unchanged. This phase adds nothing to them and **may not weaken
any**: in particular items 1 (the thirteen table names and their columns), 3 (`S` on
`lab_specimens.specimen_no`; `lab_specimen_items.active` as the current tube), 4 (the three
projection points — this phase owns `in_progress` at receive), 7 (reflex synchronous and API-side;
add-on a grouped order) and 9 (the fifteen permissions and four roles) are load-bearing for 17b.

**Frozen surfaces this phase may NOT touch:** everything under `kernel/orders/`; `kernel/phi/audit.ts`;
`kernel/episodes/series.ts`; `kernel/resources/kinds.ts` and `schema/resources.ts`; `kernel/auth/*`;
`packages/contracts/*`; `kernel/db/schema/lab.ts` **and migration `0046`** (the tables are shipped —
a needed column is a finding, not a diff); `modules/billing/*` except as an IMPORT; `modules/opd/*`
except `encounters.ts` and `index.ts`; `modules/patients/*`; anything Lane B has written.

---

## 9. CLOSE — filled at execution

### 9.0 Kickoff — the pre-flight, §2 re-measured, and the token balance at task zero

**Executed 2026-08-29 20:55 UTC, HEAD `d1cb9ff`.**

**Pre-flight (protocol §2):** no jest or vitest process (the matched lines were READ, not counted —
rule 20); load average **0.26**; current with `origin/main`; everything dirty in the tree is Lane B's
radiology/pcpndt work plus `docs/design/` and `.ci-watch.log`, **none of it this lane's to stage**.

**§2 re-measured, every row: ALL THIRTEEN UNCHANGED.** 48 journal entries (`0047` is Lane B's, still
uncommitted); 18 manifests; `lab` claimed in both censuses; 126 permissions; 31 `KNOWN_ROLE_KEYS`;
13 lab tables; 13 scheduler jobs; **0 `investigation` services created by any seed**; 293 core test
files. Nothing this phase needs a migration for — row 1's trap does not fire.

**THE DATABASE, named here and in every commit that cites a green run (§2.137):**
`TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_17a_scratch"` → workers
`hmis_17a_scratch_1 … _N`. Dropped by explicit name at CLOSE.

**TOKEN BALANCE (v3 §6's new obligation, and this phase is one of the two that make it real):**

| boundary | balance | delta |
|---|---|---|
| kickoff (session 1) | 15,000,000 | — |
| T3 committed | 14,874,000 | **126,000** |
| **kickoff (session 2 — FRESH, the seed read alone)** | 14,908,000 | **92,000** |
| **T4 committed (`fba0d72`)** | 14,725,000 | **275,000** (of which 92,000 is the seed ⇒ **~183,000 marginal**) |
| **T5 code-complete, full verify launched** | 14,499,000 | **226,000** |
| **T5 committed (`b54acfd`)** | 14,477,000 | **248,000** |

**THE PHASE, THROUGH THREE COMMITTED TASKS: ~655,000 against a 1,350,000 stop-loss — 51%.**
`132,000` (T3, in the session that authored the plan) `+ 523,000` (this session: 92,000 of seed,
183,000 for T4, 248,000 for T5). **The CLOSE says the direction plainly rather than banking the
headroom, because a ceiling wrong in this direction misprices the next lane ruling exactly as the
last one did with the sign flipped:**

- **the per-phase fixed term of 90,000 was RIGHT** — a fresh session paid 92,000 to read in;
- **the per-CRITICAL-task term of 330,000 is roughly DOUBLE what these tasks cost**: T4 at ~183,000
  and T5 at ~248,000, and T5 is the more expensive one *because* it carried nine files of job
  registration, thirteen mutants, a four-deep concurrency investigation and a full-verify triage —
  i.e. the expensive task still came in 25% under the term;
- **the review term of 260,000 is UNSPENT and still owed** (§9.6), so the phase's true total is not
  yet known. On 22c-A's and phase 0's measured comparables the two passes land near it.

**The honest amendment for the next stop-loss: a CRITICAL task in a LIGHT lane measures nearer
200,000 than 330,000 when the phase inherits its spike, and the fixed term is the one that holds.**

> **THE FRESH-SESSION SEED IS THE NUMBER THE STOP-LOSS GOT RIGHT, AND IT IS WORTH SAYING SO.**
> §6 budgeted a **per-phase fixed ≈ 90,000** for the reading order, the pre-flight and the §2
> re-measure. Session 1 paid ~6,000 for it because it had already read everything while authoring;
> session 2 — the FRESH session §0 actually asks for — paid **92,000**. So the fixed term was not
> merely defensible, it was accurate to within 2%, and the reason session 1's T3 delta looked cheap
> is the inheritance §6 already names. **The per-CRITICAL-task term of 330,000 is the one that is
> loose**: T4 came in at ~183,000 marginal, and T4 is the task that carried the money seam, the
> idempotency rows, ten mutants and a red-main repair the plan never budgeted.

> **AND THE CAVEAT THAT MUST BE READ WITH EVERY NUMBER IN THAT TABLE.** §0 says execute this phase in
> a FRESH session. **This one is not**: it is the session that executed Plan 17's T1/T2, ran the
> token audit and authored both re-cut documents, so it carries all of that into every tool call —
> which is precisely the mechanism v3 §9.5 describes and §2.141 measured. The deltas below are
> therefore an UPPER bound on what a fresh session would spend, not an estimate of it, and the CLOSE
> says so rather than letting the next stop-loss inherit an inflated rate.

### 9.3 The spike answers (S10, S11) and which inherited answers were re-checked

**S10 — THE SCHEDULER INJECTS THE INSTANT, so T5 A4 needs no seam and no waiting.**
`kernel/worker/scheduler.ts:17` types a job as **`JobRun = (now: Date) => Promise<void>`**, and
`jobs.ts:214` registers the closest shipped shape as `run: async (now) => { await sweepBatchExpiry(db, now); }`.
`sweepBatchExpiry(db: Db, now: Date)` takes the instant as its second parameter and
`expiry.test.ts` drives it directly — `sweepBatchExpiry(db, NOW)` then `sweepBatchExpiry(db, later)`.
**So both lab sweeps are `(db: Db, now: Date)` and A4's −7 d 1 h / −6 d 23 h boundary is two calls
with two instants.** §2.127's warning about reaching for a test-only clock does not apply: the seam
is the shipped signature.

**S11 — PRODUCTION HAS NO BENCH, AND THE WORKLIST IS CORRECTLY EMPTY** (read-only `psql`, no write).
`resources` holds **8 rows: 2 `bed`, 4 `room`, 1 `store`, 1 `theatre` — and 0 `bench`**, which is
expected: nobody could declare the kind before `39beff0`. The table **does** carry a `code` column,
which is what `lab_orderables.bench_key` names. **So the golden fixture supplies the `bench_key`
values, the bench worklist returns nothing until rows exist, and CREATING THE BENCH ROWS IS A
RUNBOOK ACT (§9.9), not code** — the second of the two outcomes S11 was written to distinguish.

**F7 IS PROVED, AND IT WAS THE ONE THING THAT COULD HAVE CHANGED THE DESIGN.** §5 T4 says to build
A3 first because the "ONE transaction" seam rests on an unproven claim about drizzle: `issueInvoice`
takes `Db` and opens its own `withTx`, so the seam is `issueInvoice(tx as unknown as Db, …)` and the
question is whether that nests as a SAVEPOINT that rolls back with its parent. A scratch probe
(deleted) asked Postgres directly, in both directions:

| question | answer |
|---|---|
| an inner `withTx(tx as Db)` commits, then the OUTER transaction throws | **0 rows survive** — the savepoint is undone with its parent |
| the INNER throws | the outer transaction stays alive and usable (its own row still visible) |

So DD6's one-transaction placement is sound as designed, and T4 A3 asserts it over the REAL
`placeOrder` + `issueInvoice` pair rather than over a probe. **Had it come back the other way, the
answer would have been a design change and not a code change**, which is why the plan put it first.

**Inherited answers re-checked rather than assumed:** S1's `billing.credit.extend` grant is present
in `ROLE_MODEL` for all three lab roles (`39beff0`); S6's `nextEpisodeNo` signature is unchanged;
S2's `openVisitInTx` still requires an active doctor in an active department. S3 and S4 were read
this session and are unchanged.

### 9.1 The commits

| # | SHA | task | what landed |
|---|---|---|---|
| 1 | `b06e3d6` | **T3** | `catalogue.ts`, `ranges.ts`, `formula.ts`, `reflex.ts`, `duplicates.ts` + suites; `scripts/seed-lab-catalogue.ts`; `test/fixtures/lab-catalogue.json` (64 orderables, 130 analytes, 124 ranges, 3 INACTIVE reflex rules); the module index widened |
| 2 | `fba0d72` | **T4** | `desk.ts` (566 lines), `workflow-def.ts`, `definitions.ts` + three suites; `openLabWalkin`/`openLabWalkinInTx` in `modules/opd/encounters.ts`; both module indexes widened; `test/helpers/lab.ts` (the shared fixture, F9). 1,560 insertions, 0 deletions |
| 3 | `7dd039c` | **T4** | the eleventh IST clock declared — **`main` had been red since T3** (F10) |

| 4 | *(T5)* | **T5** | `collection.ts`, `specimens.ts`, `accession.ts`, `sweeps.ts` + four suites (incl. `accession.concurrency.test.ts`); two `scheduler.register` entries; `WORKER_LAB_SWEEP_INTERVAL_MS` + the widened `JobIntervals` `Pick`; FOUR job censuses, THREE `JobIntervals` literals and `docker/prod/prometheus/alerts.yml` |

### 9.2 Findings

**F1 — `lab_orderables` HAS NO `duplicate_window_hours` COLUMN.** §5 T3 says the duplicate window
comes "from the catalogue"; T1's thirteen tables carry none, and §2 row 1 rules a needed column is a
defect to REPORT rather than a migration to write. Shipped: `DEFAULT_WINDOW_HOURS = 24` plus a named
`WINDOW_BY_CODE` map carrying 02 D11's one clinical exception, both in `duplicates.ts` and both
labelled a stopgap. **The proper fix is one nullable column, and whichever phase next writes a lab
migration should carry it.**

**F2 — the fixture's eGFR analyte was DROPPED, not shipped.** CKD-EPI needs age and sex; DD3's
grammar has only sibling analytes, so the placeholder formula computed **zero**. An analyte that
prints a wrong number is the exact thing T3 exists to prevent. If eGFR is wanted, the grammar needs
subject variables — a design change, and it belongs in a phase that rules on it rather than in a
fixture that fakes it.

**F3 — `findRecentItems` takes ONE `service_id`, and the desk pays for it.** A five-item order
against a profile sharing twenty analytes is ~200 round-trips at a counter (E48: 900 orders/day).
`duplicates.ts` collapses to the DISTINCT candidate set (~25). **The kernel could answer in one
query if that reader took an array**; widening it is a kernel edit this phase may not make, and §6
records it as the optimisation the first caller who measures a slow desk should ask for.

**F4 — THREE REAL REDS AND ONE WRONG PREMISE, recorded because two of the four were the TESTS.**
- the `range()` fixture helper dropped its `...over` argument, so every row came back `rr-1` and all
  five assertions failed against a fixture that **could not express the difference under test**;
- the merge fixture wrote a `patient_merge_requests` row, when the chain actually lives on the
  PATIENT row (`status='merged'` + `merged_into_patient_id`) — the request is not the outcome;
- **the code one:** `WINDOW_BY_CODE` was keyed by ANALYTE code where `windowFor` reads the
  ORDERABLE's, so every troponin silently fell back to the 24 h default;
- **the premise one:** the first troponin assertion said a 4 h repeat is not flagged. Four hours is
  INSIDE a six-hour window; 02 D11's rule is that troponin's window is SHORTER, not that a serial
  troponin never warns. The assertion moved to 8 h, where the two windows actually differ.

**F5 — a §4 violation the lint rule caught, not a reviewer.** `duplicates.ts` first imported
`../patients/registration`; modules may import only another module's `index.ts`. Both helpers were
already on that index and `modules/membership/recognition.ts` uses the same pair the same way.

**F7 — PROVED, AND IT WAS THE ONE THING THAT COULD HAVE CHANGED THE DESIGN.** See §9.3. **T4 A3
now asserts it over the REAL pair** and the mutant is quoted in §9.4.

**F8 — THE TWO `.json` DEFINITION FILES IN T4's FILES LIST CANNOT EXIST IN THIS REPOSITORY.**
`tsconfig.base.json` sets no `resolveJsonModule`, so `import … from "./definitions/lab_item.json"`
does not compile; the only shipped precedent, `modules/opd/workflow-def.ts`, is a TypeScript const
for exactly that reason, and `createDraft`/`defineWorkflow` both take `unknown`. Shipping the JSONs
*as well* would put two hand-maintained copies of one definition in the tree (§2.54 at file scope);
shipping them *instead* would need a compiler-option change in a file T4 does not own. **Shipped as
`LAB_ITEM_DEFINITION_JSON` / `LAB_SPECIMEN_DEFINITION_JSON` consts in `workflow-def.ts`**, and 17b
inherits the const names rather than two paths.

**F9 — `test/helpers/lab.ts` IS A FILES-LIST DEVIATION, AND IT IS DECLARED RATHER THAN SMUGGLED.**
T4 and T5 both need the same eleven-step fixture (catalogue, GST category, a second tariff version,
`LAB` department, pathologist `opd_doctors` row, both lab definitions, the OPD visit definition,
sixteen grants). Two copies would drift by construction. It is the `test/helpers/opd.ts` /
`billing.ts` precedent; T4's diff carries a file its Files list does not name.

**F10 — `main` WAS RED FROM T3's PUSH UNTIL `7dd039c`, AND THE NARROW-SUITE ECONOMY IS WHY.**
T3's `ranges.ts` is the ELEVENTH copy of the hospital's IST offset, and
`test/ist-clock-parity.test.ts` exists to redden when an undeclared one appears. It did:
`1 failed, 2871 passed` on `b06e3d6`, and `e40fc08` inherited it. **The phase's own suite could not
have caught it** — that census lives in `test/`, not beside the code it counts, so
`jest src/modules/lab` never runs it. This is §2.131/§2.138's class with one new edge: *a census
that lives outside the module it counts is invisible to a task that runs only its module's suite.*
AGENT-RULES §2.8's narrow-suite economy is still right; the correction is that **reading CI by full
SHA at the task boundary is not optional**, and it is what found this. `ranges.ts` itself needed no
change — it already carried the written argument the census asks for.

**F11 — A1's MUTANT DIED BY THE DUPLICATE DETECTOR, NOT BY A SECOND ORDER NUMBER, AND THAT IS A
FACT ABOUT THIS SYSTEM WORTH KEEPING.** The Assertion Book predicted `L…0001` and `L…0002`. What
actually happened when the wrapper was bypassed is `LabError: CBC was ordered 0 h ago
(L2608290001)` — the lab's own duplicate detector caught the replay first. **It is NOT a reason to
call the wrapper redundant.** The detector only fires within its window and only on analyte
overlap, so a replayed order for a DIFFERENT orderable, or the same one 25 hours later, still
double-bills; and the detector's refusal reaches a counter as "this was already ordered", which is
the wrong sentence for a page reload. Recorded because a later reader measuring the two guards
against each other would otherwise reach the opposite conclusion from one green test.

**F12 — `invoice_lines.id` IS MINTED INSIDE `issueInvoice` AND IS NOT THE CALLER'S `lineId`.**
`invoices.ts:863` writes `id: newId()`; the caller-supplied `lineId` survives only as the discount
approval subject. So `lab_items.invoice_line_id` cannot be known at call time and is READ BACK,
ordered by `line_no`, mapped positionally against the input array — which is sound only because
`priceInvoiceLines` maps over `draft.lines` and does not reorder. `desk.ts` pins that with a length
check that refuses rather than mis-links, because a lab item pointing at the wrong invoice line is
a report released against somebody else's payment. **If a later phase ever makes pricing reorder or
merge lines, this is the call site that breaks silently**, and the length check is the only thing
that would not.

**F13 — `openLabWalkin` REFUSES A LAB WITH TWO ACTIVE PATHOLOGISTS RATHER THAN PICKING ONE, AND
THAT IS AN OWNER-FACING CONSEQUENCE.** `ordering_clinician_id` is the doctor answerable in a
medico-legal chain; choosing between two by row order would put a name on a report by accident. So
the counter must name one when the `LAB` department has more than one active `opd_doctors` row.
17a ships no route, so nothing is blocked today — **17b's controller must expose that field**, and
§9.9's runbook act should create ONE pathologist-of-record row unless the owner wants the counter
choosing per walk-in.

**F15 — `lab_specimens` HAS NO `instance_id`, SO THE `lab_specimen` DEFINITION IS DECLARED AND
NEVER INSTANCED.** DD4 rules two state machines and T4 ships both; `lab_items.instance_id` holds the
item's, and the tube's table carries no such column. §2 row 1 rules a needed column a defect to
REPORT rather than a migration to write, so it is reported: **`lab_specimens.status` IS the tube's
machine** (`labelled → collected → in_transit → received → stored → rejected → disposed`), enforced
by `lab_specimens_status_ck` and moved only by CAS. `workflow-def.test.ts` pins the definition's
state list against that vocabulary so the two cannot drift while they are separate. The proper fix
is one nullable column, and whichever phase next writes a lab migration should carry it with F1's.

**F16 — NO OPD EXPORT MAPS A `V` NUMBER TO ITS QUEUE TOKEN, so `collectionQueue` returns the
ENCOUNTER NUMBER and not "the token" §5 T5 asks for.** `modules/opd/index.ts` exports `getVisit`
and `getEncounter`, both keyed by `opd_encounters.id`; the token lives on `opd_queue_entries` and
nothing exported reaches it from a visit NUMBER. Reading that table directly is a §4 module-isolation
breach — the same one the lint rule caught in T3 (F5) — and T5's Files list names no OPD file, so
widening the OPD index is out of scope here. **The phlebotomy list therefore keys on the `S` number
and carries the `V`**, which is what a paper worklist actually needs; 17b's screen can call the OPD
route for a token if the counter wants one.

**F17 — `defineWorkflow` CANNOT EXPRESS A PER-PRIORITY SLA.** §5 T5 measures the breach against
*"the ACTIVE definition's SLA for its priority"*. `definition.ts`'s schema carries ONE `sla` per
state and no priority dimension, so that SLA does not exist as written. Shipped: the state's SLA is
the base, and a STAT item is held additionally to its orderable's own `tat_minutes_stat` — the
tighter of the two. That keeps a STAT troponin out of a routine LFT's four-hour analysis window,
which is the clinical content of the sentence, without inventing a kernel schema.

**F18 — THE FILES LIST SAYS `apps/core/src/config.ts`; THE FILE IS `apps/core/src/kernel/config.ts`.**
Trivial, recorded because a successor grepping the named path finds nothing.

**F19 — REGISTERING A JOB TOUCHES NINE PLACES AND NO FILES LIST HAS EVER NAMED THEM ALL. THIS IS
THE THIRD PHASE TO RECORD IT.** §5 T5 names `jobs.ts`, `config.ts` and five censuses. The actual
edit set for two jobs was: `jobs.ts` (the registrations **and** the widened `JobIntervals` `Pick`),
`kernel/config.ts` (the env key, the `AppConfig` field, the parse), **four** job censuses
(`jobs.test.ts`, `scheduler.test.ts`, `worker-runtime.e2e.test.ts`, `alerts-parity.test.ts`),
**three** `JobIntervals` object literals (the two in `jobs.test.ts`, one in `scheduler.test.ts`, one
in `retention/sweep.test.ts`), and **`docker/prod/prometheus/alerts.yml`** — which no Files list in
this repository has ever named and which `alerts-parity.test.ts` turns into a red test rather than a
silent monitoring hole. `manifests.test.ts`, which §2 row 8 lists, did NOT move: T2 already installed
the lab manifest in the worker for exactly this reason.

**The three `JobIntervals` literals announced themselves by TYPE**, precisely as `jobs.ts`'s own
docstring predicts (`TS2741: Property 'workerLabSweepIntervalMs' is missing`). The four censuses and
the alert rules did not, and had to be found by running them. **The generalisable rule for the next
plan: a task that registers a job names nine files, and the typechecker finds three of them.**

**F20 — THE TUBE-MISMATCH FLAG WAS ROLLED BACK BY ITS OWN REFUSAL.** `printLabels` appended
`lab.tube_mismatch_flagged` and then threw ON THE SAME TRANSACTION, so the rollback took the audit
record with it and a near-miss left no trace whatever. The test caught it (`Received length: 0`).
**Fixed: `printLabels` is `Db`-first and writes the flag on its own transaction before refusing** —
the only one of the four T5 acts that must WRITE on its refusal path, which is why it alone has that
shape. NABL asks for the count of these; a control nobody can count is a control nobody can audit.

**F21 — THE THREE SURVIVING MUTANTS AND WHAT THEY FOUND.** See §9.4.

**F25 — THE OPD ENCOUNTER RESOLVER COULD NOT RESOLVE A SINGLE REAL `V` NUMBER, AND 17a T4 SHIPPED
THE CALLER THAT TRIPS IT.** Reported by Lane B's 18a kickoff spike
([`reports/2026-08-30-lane-b-held-coordination.md`](reports/2026-08-30-lane-b-held-coordination.md)
§5), **verified here by execution rather than accepted**, and fixed in `d1f316b`.

`opd.module.ts` registers the resolver under prefix `EPISODE_SERIES.visit` (`"V"`), so
`resolveEncounterByPrefix` hands it a visit NUMBER — and it resolved that through `getEncounter`,
which read `opd_encounters.id`, a `newId()` ULID. The visit number lives in `visit_no`. So the
resolver returned `{matched: true, resolved: null}` for every real visit and `placeOrder` refused
`unknown_encounter`. **`desk.ts` passes a caller-supplied `encounterNo` straight into `placeOrder`,
so in production a lab order on a genuine OPD visit died at the counter.** `modules/ot`'s resolver
reads `daycare_encounters.encounter_no` and is correct — a divergence between two implementations of
one seam, not a design.

**THE RED, QUOTED, AGAINST SHIPPED CODE BEFORE THE FIX:**
`expect(received).not.toBeNull() / Received: null`, and `Expected: "tpa", Received: undefined`.
Green after: 5/5. `src/modules/opd/encounter-resolver.test.ts` is the regression test and it is the
only suite in the repository that registers the REAL resolver against a REAL visit.

**WHY NOTHING CAUGHT IT FOR SIX PHASES, AND IT IS THIS PHASE'S OWN FIXTURE AMONG THEM.** Every suite
that reaches this seam registers its own fake `V` resolver — phase 0's four order suites,
`duplicates.test.ts`, and **`test/helpers/lab.ts`, which T4 wrote**. That isolation is legitimate for
those tests and it is exactly what hid the defect: the fixture supplied the answer the code got
wrong. **The generalisable form, and it is sharper than F10's and F22's:** a fixture that stands in
for a production REGISTRATION tests everything except whether the registration works. Where a seam is
registered once at boot and stubbed everywhere else, one suite must use the real one.

**DEVIATION, DISCLOSED.** The one-line repair belongs in `opd.module.ts`'s resolver body, and §8 of
this document freezes `modules/opd/*` except `encounters.ts` and `index.ts`. Rather than edit a
frozen path quietly, the repair landed in the reader the resolver already calls, discriminating **by
shape** — a ULID cannot match `VISIT_NO_RE`, so all eighteen existing `getEncounter` callers take the
path they took before and billing's bare-row-id fallback is untouched. **A later phase that owns
`opd.module.ts` should move the discrimination into the resolver and narrow `getEncounter` back**;
that instruction is in the function's own header, not only here.

**F27 — `issueInvoice`'s `cash_threshold_blocked` AUDIT EVENT IS LOST THROUGH THE DESK'S CAST, AND
IT IS F20's DEFECT ONE MODULE OVER.** `invoices.ts:1042` appends the §269ST refusal event via
`withTx(db, …)` inside its own `catch`, on the reasoning that its transaction is already gone. Under
`deskOrder`'s `tx as unknown as Db` that `db` is a **`Tx`**, so the event lands on a savepoint of a
transaction that is about to roll back: a lab desk offered ₹2,10,000 in cash is refused correctly and
**no row anywhere records that it happened.** Not fixed — `modules/billing/*` is frozen for this
phase — and pass 2 confirmed there is no repair reachable from a file 17a owns. **The fix is the
shape `printLabels` already proves (F20): `deskOrder` must take a `Db` as well as its `Tx`, and it
belongs to whichever phase owns the controller.** 17b wires the receipt path, so 17b is that phase.

**F28 — AUTHORIZATION REFUSALS BORROW `unknown_service` (404) AND `catalogue_invalid` (422).**
`errors.ts`'s own header rules that a later task needing a code the union lacks has found a plan
defect to REPORT, and may not borrow a neighbouring one. T3 and T4 borrowed: `desk.ts` now uses
`unknown_service` for a non-user actor, a missing permission, an empty basket, an orphan orderable
AND an internal invariant abort. `errors.test.ts` stays green because it checks declared-vs-thrown in
both directions and never exclusivity. **The union needs a `permission_denied`; adding it is T2's
file and therefore a defect for 17b to carry.** (The lab worklist's own gates were moved to the
ENVELOPE's `actor_cannot_read` / `permission_denied` in `b8b03a6` rather than borrowing further —
pass 2 finding 5.)

**F29 — THE DUPLICATE CHECK IS A READ-THEN-REFUSE ACROSS TRANSACTIONS.** `deskOrder` treats
`duplicateWarnings` as a guard, but it is an unlocked `SELECT` with no unique constraint behind it:
two counters placing the same CBC for one patient within a second both see nothing and both bill.
An advisory lock on the patient row inside `desk.ts` would close it — so "cannot be fixed here" would
be false — and the reason it is deferred is SEVERITY, stated plainly: the duplicate gate is an
*acknowledgeable warning*, so a lost race costs a reversible double-bill, against a new serialisation
point on the desk's hottest path. **17b mounts the route where `withIdempotency` lands and should
rule on it there.**

**F30 — THE REDRAW NOW WRITES `cancelled_from = 'in_progress'` AND REFUNDS IN FULL, WHICH IS THE
DISCRIMINATOR O-4 READS.** `transitions.ts` records that O-4's money rule ("the charge stands if it
was analysed") reads `cancelled_from`. Before pass 1's C1 fix a post-accession reject was
unreachable, so an abandoned redraw was always cancelled from `placed`. It is now the normal path,
and the non-return sweep cancels from `in_progress` while issuing a 100% credit note — recording
"work had started, the charge stands" on the row and refunding anyway. Nothing reads the column
today. **It is latent in the one column whose stated purpose is to decide exactly this question, and
17b/O-4 is what will read it.**

**F31 — THE M8 CENSUS BINDS THE STATE LIST AND NOT THE TRANSITIONS.** `lab_specimens` has no
`instance_id` (F15), so no status write routes through `transition()` — `printLabels`, `collect`,
`receive` and `reject` all write string literals. The specimen definition's `transitions` array is
therefore unenforced documentation, and `reject` would happily write `stored → rejected`, an edge it
does not declare. Unreachable today because nothing writes `stored`. A second census leg — the four
writers' literal targets scanned out of source against the declared edges — is what would bind it,
and it is the same technique the test already uses for the state list.

**F26 — `recordPhiAccess` ON `kernel/orders/read.ts` IS ALREADY LANDED. ~~BY PHASE 0~~ — **CORRECTED
2026-08-30: BY THIS LANE, IN `39beff0`.** Lane B's §4 treated it as an unclaimed seam whose first
lane writes the call. It is at `read.ts:310` and `:347` with `surface: "orders.patient"`, so the
substance of the finding — **reuse it, write no second call, append only your own `PhiSurface`
names** — stands unchanged and is what Lane B needs.

**The attribution I gave Lane B was WRONG, and Lane B measured it and corrected me.** I wrote
"shipped in `9ba2482` and hardened in `6bd3016`" from a plausible reading of the git log rather than
from a count. Measured properly: `git show <sha>:…/orders/read.ts | grep -c recordPhiAccess` returns
**0 at `9ba2482`, 0 at `6bd3016`, and 5 at `39beff0`** — Plan 17's own T1/T2 commit, this lane's.
The wrong sentence is struck rather than deleted, because Lane B's §7 records that this spike answer
has now flipped **twice** and the record of a wrong answer is what stops it flipping a third time.

**The lesson is mine and it is the one this phase keeps re-learning in other forms:** I applied
`grep -n` to the file at HEAD and then attributed it from commit MESSAGES. A claim about WHEN
something landed is a claim about a tree at a SHA, and the only instrument that answers it is
`git show <sha>:<path>` — the same discipline §2.142 demands for what a commit CONTAINS.

**F22 — `errors.test.ts`'s DERIVED CENSUS CAUGHT `tube_mismatch` IN THE WRONG FILE, AND IT WAS
RIGHT.** T2's `OWNED_BY` map records, from the phase document's own Produces list, that
`tube_mismatch` is thrown by `collection.ts`. The first implementation put `printLabels` — and the
scan — in `specimens.ts`. The census went red with no edit to itself at any point, which is exactly
what its header promises. **Resolved by moving the DD10 guard to `collection.ts`** as
`assertRightPatient`, which is also where a reader looks for it: the right-patient scan is a
collection-desk control, not a property of the tube. **This is the SECOND time in one phase that a
derived census corrected the work** (F10 was the first), and both were invisible to the module's own
narrow suite.

**F23 — A REDRAWN TUBE TAKES TWO WORKFLOW HOPS, AND THE SHORTCUT MUST NOT BE ADDED.** After
`reject`, the item sits in `recollection_pending` and its replacement tube was labelled by the
rejection rather than by a `printLabels` call — so `collect` had no path to `collected`. The machine
has no `recollection_pending → collected` edge and **must not gain one**: that intermediate state is
what the seven-day non-return sweep measures the age of (A4), and a shortcut would make a redrawn
tube indistinguishable from one nobody ever came back for. `collect` performs both hops explicitly.

**F24 — SIX GENUINE REDS ON THE WAY TO T5's GREEN. FOUR WERE THE FIXTURE OR THE TEST; TWO WERE THE
CODE.** F4's and F14's lesson, a third time:
- **the code, twice:** F20's rolled-back flag, and F23's missing hop;
- `order_items.status` starts at **`placed`**, not `pending` — every one of the four new modules
  filtered on the wrong word and `printLabels` found nothing to label. The envelope's vocabulary is
  `placed | in_progress | completed | cancelled` and the lab's own eleven stages are a different
  list; conflating them is the exact confusion DD4's projection points exist to prevent;
- the fixture drew blood as `lab_reception`, and the engine refused: *"transition
  awaiting_collection→collected allows roles: phlebotomist, lab_technician, nurse"*. **That is S4
  working, not a defect** — a counter clerk may not draw blood — and the fixture gained a `bench`
  login holding `lab_technician` + `phlebotomist`;
- A2's eight rounds silently measured only FOUR, because the reused code pairs tripped the duplicate
  detector and the round was skipped. §2.3 says the stated count is a FLOOR to keep running toward,
  never a window to engineer, so the fixture gained sixteen analyte-DISJOINT orderables and the test
  asserts both callers survive each round rather than tolerating a short one;
- `HIV` had to leave those sixteen: it is `consent_required`, so `deskOrder` correctly refuses it
  without a consent block (T4 A4) and the round placed one order instead of two.

### 9.4 The Assertion Book, corrected by execution

**T3 — nine rows, nine mutants BUILT, nine DIED.** Each was a scratch module beside the source, run
isolated, deleted before the commit (`git status --porcelain` carries no `*.mutant.*`).

| row | mutant | expected vs received |
|---|---|---|
| **A1** | age from `now` in UTC | `Expected 365, Received 364` — a one-year-old moved into the neonate band, different `ref_high` |
| **A2** | fall back to `male` | `Received "rr-m"` — a male haemoglobin range printed for a patient of unstated sex, with nothing on the report saying so |
| **A3** | guard ignored | `Received {computed: true, value: 70}` — a plausible, wrong LDL on a report a cardiologist acts on |
| **A4** | missing sibling reads as `0` | computed a number where the shipped code names the missing analyte |
| **A5** | compare `service_id` only | `Expected length 1, Received 0` — the CBC inside the Fever profile invisible |
| **A6** | look up the given id, no chain | `Expected length 1, Received 0` — the order under the merged-away registration invisible |
| **A7** | `active` ignored | `Expected [], Received [{addsServiceId: "svc-ft4", …}]` — a patient billed for an FT4 nobody enabled |
| **A8** | analyte default beats the band | `Expected "7.0", Received "6.0"` — a critical call on a neonate's normal potassium |
| **A9** | `new Function(...)` | **the runner DIED: `process.exit called with "1"`, stack `at eval (eval at run (formula-a9.mutant.ts:155:17))`.** It did not fail an assertion; it EXECUTED the catalogue string |

**FAIL-FIRST:** discharged by the mutants and SAID so rather than manufactured. These are brand-new
pure modules, so a test-before-code red is an unresolved-import error, which §2.5 says proves
nothing. The four genuine reds of F4 are quoted above.

**T4 — TEN ROWS, TEN MUTANTS BUILT, TEN DIED.** Each was a scratch module beside the source, run
isolated, deleted before the commit (`git status --porcelain` carries no `*.mutant.*`). **A3 was
built first**, as §5 T4 requires, and it is the row that would have changed the design.

| row | mutant | expected vs received |
|---|---|---|
| **A3** ⚑ | the invoice made best-effort — caught and skipped, the order stands | **`Received promise resolved instead of rejected`, resolving to `orderNo: "L2608290001"` with `invoiceId: null`** — an order for two tests that no invoice will ever bill |
| **A1** | the idempotency wrapper bypassed | `LabError: CBC was ordered 0 h ago (L2608290001)` — **the DUPLICATE DETECTOR caught the replay, not a second order number** (finding F11) |
| **A1b** | the claim taken AFTER the work | `Expected [1,1,1,1,1,1,1,1], Received [2,2,2,2,2,2,2,2]` — two orders in **every one** of eight rounds |
| **A2** | the body hash not compared | resolved instead of refusing, returning `invoiceNo "INV/26-27/000001"`, `netPayablePaise 30000` — **the one-test invoice handed back for a two-test basket** |
| **A4** | `restricted` left at its default | `Expected: true, Received: false` — an HIV item the kernel reader then shows to the ward clerk |
| **A5** | unknown service ids skipped silently | resolved with 2 items and `netPayablePaise 60000` — **the patient billed for two of the three tests the doctor advised**, with nothing saying the third is missing |
| **A6** | `INSERT INTO order_items` on the parent | `Expected: not "01M17SAR9716KCHEJ4PKEYDKSS", Received: the same id` — the add-on became a row on the parent order, behind `placeOrder`'s back: no `order.placed`, no authority, no permission check |
| **A7** | the sentinel omitted | `error: new row for relation "orders" violates check constraint "orders_external_referrer_ck"` — **the BICONDITIONAL CHECK, exactly as S3 predicted, and the desk is unusable for walk-ins** |
| **A8** | a shortcut transition added | `ordered→resulted` `Expected: false, Received: true`; into-`verified` `Expected ["resulted"], Received ["in_analysis", "resulted"]` |
| **A9** | the department lookup skipped, the column left null | resolved to a visit `V2608300001` carrying **`"departmentId": null, "doctorId": null`** — every departmental report and every `intendedPayer` read silently loses the lab |

**TWO ROWS DIED AT A GUARD RATHER THAN AT THEIR OWN ASSERTION, AND BOTH ARE DISCLOSED.** A7 dies at
the Postgres CHECK — which is what the Book itself predicted, so the discriminator is the intended
one. A1 dies at the duplicate detector (F11). Neither was rewritten to manufacture a prettier kill.

**TWO MUTANTS HAD TO BE REPAIRED BEFORE THEY PROVED ANYTHING**, per rule 21, and both are the
failure modes that rule names: A3's first build died inside `defineEvent`'s zod payload
(`invoiceId` `too_small`) rather than at the count assertion, and A1's first build died at
`TS18048: 'key' is possibly 'undefined'` — **a TYPECHECK death, which proves nothing**. Both were
rebuilt to reach the assertion.

**FAIL-FIRST:** discharged by the mutants and SAID so. `desk.ts`, `workflow-def.ts` and
`definitions.ts` are brand-new modules, so a test-before-code red is an unresolved-import error,
which §2.5 says proves nothing. **Four genuine reds were met and are quoted below (F14).**

**T5 — NINE ROWS, THIRTEEN MUTANTS BUILT, THIRTEEN DIED — BUT FOUR OF THEM ONLY AFTER THE
ASSERTION WAS SHARPENED, AND THAT IS THE MOST USEFUL THING THIS TASK LEARNED.**

| row | mutant | expected vs received |
|---|---|---|
| **A1** | `receive`'s CAS removed | **SURVIVED** on the counting leg; `Expected ["already_received"], Received ["unknown_transition"]` on the refusal leg — see F21 |
| **A1b** | `receive`'s CAS **and** the envelope's `advanceOrderItem` CAS removed | **SURVIVED** on counting; same kill on the refusal leg |
| **A1c** | all THREE removed — `receive`'s, the envelope's, and the workflow engine's own single-winner | **SURVIVED** on counting; same kill on the refusal leg |
| **A2** | `nextEpisodeNo` pre-read, then written (read-then-write) | `error: duplicate key value violates unique constraint "episode_series_series_key_service_date_pk"` — the two printers collided on the COUNTER, one table earlier than the Book predicted |
| **A3** | `issueInvoice` on the recollection | `Expected 1, Received 2` invoice lines — **the patient billed twice because the lab dropped the tube** |
| **A4** | the boundary off by a day | the −6 d 23 h rejection was cancelled: `Expected []`, received a cancellation and a credit note |
| **A4b** | the credit note skipped | `Expected 1, Received 0` — the item cancelled and the money kept for a test the hospital has just decided it will never do |
| **A5** | the refusal moved BELOW the inserts | **SURVIVED** — see F21's twin below |
| **A5b** | the mismatch made a WARNING rather than a refusal | resolved instead of rejecting, **returning a real tube `S2608290001` labelled for the wrong person** |
| **A6** | the identity re-check skipped when unscanned | resolved: `{specimenNo: "S2608290001", tatStartedAt: …}` — an unscanned ward tube accessioned with nobody named |
| **A7** | `tat_started_at` from `placed_at` | `Expected "2026-08-30T01:50:15.905Z", Received "2026-08-29T22:50:15.837Z"` — the clock started three hours early, charging the lab for the ward's transport |
| **A8** | emit every sweep | `Expected length 1, Received length 2` — two `lab.sla_breached` events for one (item, stage) |
| **A9** | receive anyway | `Expected "no_active_order", Received "illegal_transition"` — **exactly the Book's prediction**: the bench meets a raw state-machine error |

**F21 — THREE MUTANTS SURVIVED, AND THE REASON IS WORTH MORE THAN THE KILLS.**
A1's Book row asserts *"exactly ONE `lab.specimen_received` and ONE `order_item.started` per item"*.
Removing `receive`'s CAS did not break it. Removing the ENVELOPE's `advanceOrderItem` CAS as well
did not break it. Removing the WORKFLOW ENGINE's single-winner too did not break it. **What actually
holds the line is the fourth guard nobody counted: the `lab_item` definition has no
`accessioned → accessioned` edge, so the loser dies at `unknown_transition` before it can emit** —
a state-machine legality table, not a compare-and-swap, with Postgres row locking serialising the
two writers into it.

So the shipped code is not wrong; it is defended four deep, and no single-guard mutant can kill that
assertion. AGENT-RULES §3 forbids fixing a survivor silently and rule 21 forbids claiming an
assertion discriminates without watching a mutant fail, so the row was **sharpened rather than
declared green**: it now also asserts what `receive`'s OWN CAS uniquely owns — that the loser reads
**`already_received`**, a sentence a bench can act on, instead of `unknown_transition`, an error
about a machine it has never heard of, on the busiest surface in the laboratory. All three mutants
die on that leg.

**A5 is the same shape.** *"Writes no `lab_specimens` row"* survived moving the refusal below the
inserts — because the throw rolls the transaction back and takes the row with it. The claim that
needs the ORDERING is the one A5b makes: an implementation that labels the tube and merely WARNS
(the shape a "don't block the counter" fix takes) returns a real `S` number for the wrong person,
and that mutant dies.

**FAIL-FIRST:** discharged by the mutants and SAID so; `collection.ts`, `specimens.ts`,
`accession.ts` and `sweeps.ts` are new modules, so a test-before-code red is an unresolved-import
error (§2.5). **Six genuine reds are quoted in F24.**

**F14 — FOUR REDS ON THE WAY TO T4's GREEN, AND ALL FOUR WERE THE FIXTURE OR THE TEST.** F4's
lesson, repeated one task later and worth the line:
- `PRICED_LAB_CODES` named `FT4`, which is an ANALYTE inside `TFT` and not an orderable — so
  `setTariffItem` hit `tariff_items_service_id_services_id_fk` for a `services` row the catalogue
  never created. The census the fixture needed was the fixture's own orderable list, not a
  remembered name;
- A1b re-seeded the whole eleven-step fixture inside its own loop and blew the 15 s timeout at
  round one. Rewritten to run eight rounds against ONE fixture with a different orderable each
  round, counting the **delta** rather than the total — which is also what keeps the duplicate
  detector out of a concurrency measurement;
- that timeout then left `opd_config` half-seeded, so the NEXT test failed on
  `duplicate key value violates unique constraint "opd_config_pkey"` — a cascade, not a defect;
- the fixture never activated the **OPD visit** definition, so both `openLabWalkin` rows died on
  `no active definition for "opd_visit"`. `openVisitInTx` calls `startInstance`, and A9 asserts the
  DEPARTMENT refusal — a walk-in dying on a missing workflow definition would have asserted nothing.

### 9.5 Mechanical verification — name the `TEST_DATABASE_URL` database of every run claimed (§2.137)

**EVERY RUN SO FAR USED `TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_17a_scratch"`**
(workers `hmis_17a_scratch_1 … _N`). **They are NOT yet dropped** — T4 and T5 still need them; the
CLOSE drops them by explicit name and says so.

| run | result |
|---|---|
| `jest src/modules/lab` (9 suites) — T3 | **57/57 passed, exit 0** |
| PREFLIGHT `pnpm typecheck` — T3 | **exit 0** |
| PREFLIGHT `pnpm lint` — T3 | **exit 0** (2 pre-existing warnings, 0 errors) |
| **T4 acceptance:** `jest src/modules/lab src/modules/opd/encounters.test.ts src/modules/billing/idempotency.test.ts` | **14 suites, 104/104 passed, exit 0** |
| `pnpm typecheck` — T4 | **exit 0** |
| `pnpm lint` — T4 | **exit 0** (the same 2 pre-existing warnings, 0 errors) |
| `jest test/ist-clock-parity.test.ts` — the F10 repair | **3/3 passed, exit 0** |

**CI, READ BY FULL SHA — AND IT IS WHY F10 IS IN THIS DOCUMENT.** `b06e3d6` (T3): **failure**
(`1 failed, 2871 passed`). `e40fc08`: **failure**, inherited. `7dd039c` carries the repair. The T3
handoff said its verdict was "the successor's to read"; reading it was the first thing this session
did after T4's own green, and it found a red `main` that had stood for ~40 minutes.

| **T5 acceptance:** `jest src/modules/lab` (15 suites) | **103/103 passed, exit 0** |
| `jest src/kernel/worker test/alerts-parity.test.ts test/worker-runtime.e2e.test.ts src/kernel/retention/sweep.test.ts` — the five job censuses | **passed, exit 0** |
| `pnpm typecheck` — T5 | **exit 0** |
| `pnpm lint` — T5 | **exit 0** (the same 2 pre-existing warnings, 0 errors) |

**THE ONE FULL `pnpm verify` (v3 §9.9 rule 4), AND ITS EXIT VALUE WAS 1. THE READING IS RULE 20's,
AND THE EVIDENCE IS BELOW RATHER THAN THE CONCLUSION.**

Run detached with its exit value in a file (rule 18), on `hmis_17a_scratch`:
**`Test Suites: 11 failed, 293 passed, 304 total; Tests: 27 failed, 2936 passed, 2963 total`,
exit 1.**

| what was measured | what it says |
|---|---|
| the failure signatures, counted | **44 `Exceeded timeout of 15000 ms for a hook` + 6 for a test; 4 duplicate-key errors that are cascades from half-run `beforeEach` hooks. ZERO assertion failures.** |
| the load average during the run | **10.74**, and **13.77 twenty minutes later with `pgrep -af jest` matching only my own probe shell** — the box was carrying work that was not mine, and rule 8 forbids inferring whose |
| the eleven failing suites, RE-RUN IN ISOLATION at load 2.9 | **84/84 passed, exit 0**, in two batches — `advance.test.ts`, `charge-rules`, `patient-identity`, `opd` schema, `accrual-view`, `check-config-present`, then `ops-lifecycle.e2e`, both `approval-types`, `totp`, `seed-admin` |
| the failing set's CONTENT | `totp`, `seed-admin`, `opd` schema round-trip, `ops-lifecycle`, `patient-identity` — **not one of them touches an order, a lab table, a worker job or an alert rule** |
| CI by full SHA on `c7604e6` (T4 + the census repair) | **success** — 296 suites on hardware nobody else is sharing |

**So the exit 1 is CONTENTION and it is reported as such rather than as a green run.** What would
have made it a defect is an assertion failure or a failing suite that touches this phase's surface,
and there is neither. **CI by full SHA is the load-bearing evidence for T5** (§2.142's rule for a
commit whose tested worktree differs from its committed tree — Lane B's uncommitted radiology work
is in the tree that produced every number above and in none of the commits).

**I observed interference and say so** (rule 20): the box was under load I did not create, before,
during and after the run.

#### THE FINAL VERIFY, RUN QUIET AFTER BOTH CLOSE PASSES — AND A CLAIM OF MINE IT REFUTES

Run detached on `hmis_17a_final` with Lane B paused and nothing else of mine running:

**`Test Suites: 1 failed, 304 passed, 305 total; Tests: 4 failed, 2973 passed, 2977 total`, exit 1.**

The single failing suite is `src/kernel/orders/advance.test.ts` — phase 0's, frozen for this phase —
and its C1/C1b rows are 12-round concurrency measurements against jest's 15-second default. Compare
the three runs: **11 failing suites, then 15, then 1**, as the box got quieter, with `advance.test.ts`
the only member of all three sets. **Every suite this phase wrote or touched is green.**

**AND HERE IS WHERE I WAS WRONG.** I told the owner this flake was *"a standing source of red CI"*.
It is not, and Lane B's F8 has the evidence: CI run `33308463171` on `a57e7e4` returned
`completed | success` with `advance.test.ts` included, and **CI is `success` on all three of this
phase's remediation commits — `1e57d65`, `b8b03a6`, `5a2d732`.** The four failures are a function of
the HOST and the LOAD, not of the file: they fail in a full parallel verify on this build box, pass
26/26 isolated on the same box, and pass on GitHub's runner.

**What is broken is the LOCAL FULL VERIFY as an instrument — which both lanes need and neither can
currently get green — and not CI, and not this phase.** I asserted the stronger claim before the
evidence existed, which is the same error in the same paragraph as F26's. **The general rule, which
is Lane B's and is worth the ledger: a red on the build host and a red in CI are two different
claims, and neither implies the other. §2.55 is the case where a green local verify hid a red CI;
this is the same coin's other face. Name the box.**

The one-line repair (an explicit timeout on C1/C1b, exactly what `jobs.test.ts` carries with its
§2.99 note) is still worth making by whichever phase owns `kernel/orders/`. It blocks nothing.

### 9.6 The close review — BOTH PASSES RUN, BOTH FRESH, AND THE SECOND ONE EARNED ITS KEEP

**Two passes, both FRESH, never resumed (§2.136, §2.140). Both read-only, running no tests — the
22c-A precedent, where two read-only reviewers confirmed migrations, lock order and HTTP mappings by
READING and each found a CRITICAL.** Pass 1 took the operand brief the HANDOFF carries verbatim;
pass 2's subject was **the remediation**, with a verdict demanded per fix.

**THE HEADLINE, AND IT IS §2.140's ARGUMENT WITH A SECOND SPECIMEN: TWO OF PASS 1's FIVE FIXES WERE
THEMSELVES THE NEXT DEFECT.** A phase that had stopped after one pass would have shipped a
confidentiality oracle it had just created and a silent-failure path where a monitored one used to
be.

#### 9.6.1 Pass 1 — two CRITICALs, seven MAJORs, both criticals on the recollection path

| # | finding | disposition |
|---|---|---|
| **C1** | **A tube rejected AFTER accession stranded the item and kept the money.** `reject`'s live set read `order_items.status = 'placed'` alone; `receive` had already set `in_progress`. **Haemolysis is found at the CENTRIFUGE**, so the guard written for "every test was cancelled" fired on the ORDINARY clinical path: no replacement tube, no recollection, links left ACTIVE on a rejected specimen so nothing could ever be relabelled, the item invisible to every sweep and worklist, and the patient's money kept for a test that could not be run. It also made `accessioned → recollection_pending` unreachable in practice. | **FIXED** `1e57d65`, proved RED first: `Expected ["01M19…"], Received []` |
| **C2** | **The non-return sweep cancelled in one transaction and refunded in another.** Any throw between them left the item cancelled, unrefunded and unrecoverable — `due` requires the very state the commit had just left. The code defended the split as "a worklist item"; **there was no worklist.** | **FIXED** `1e57d65` |
| **M3** | **`collectionQueue` was an ungated bulk PHI read** — no permission, no actor gate, no `restricted` filter, serving every labelled patient's name, UHID, `V` number and `["HIV"]`/`["HBSAG"]`/`["VDRL"]` to any caller. | **FIXED** `1e57d65`, then **re-fixed** in `b8b03a6` — see pass 2 finding 1 |
| **M5** | **`printLabels` validated the scan against `items[0]`'s patient** while `orderGroupId` is free caller input: two patients, one tube, results attributed to the wrong person. | **FIXED** both ends, then corrected for the merge chain in `b8b03a6` |
| **M8** | **F15's drift-guard did not guard.** The test pinned the definition against a constant in its own file, and the two vocabularies had ALREADY drifted — `awaiting_collection` where the CHECK says `labelled`, which is what `printLabels` writes. | **FIXED** `1e57d65`; the census now reads the CHECK out of the schema source |
| M4 | `issueInvoice`'s `cash_threshold_blocked` compensating audit event is written to a savepoint that is about to roll back, through `deskOrder`'s cast — a §269ST refusal leaves no record. | **REPORTED** (F27) — `modules/billing/*` is frozen; pass 2 confirmed the decision |
| M6 | `lab_sla_breaches_item_stage_ux` is `(item, stage)`, so a RE-ENTERED stage never alerts again. | **REPORTED, THEN OVERTURNED BY PASS 2 AND FIXED** — see below |
| M7 | Authorization refusals borrow `unknown_service` (404) and `catalogue_invalid` (422). | **REPORTED** (F28) — `errors.ts` is T2's and its header forbids widening |
| M9 | The duplicate check is a read-then-refuse with no lock: two concurrent desks both place. | **REPORTED** (F29) |

#### 9.6.2 Pass 2 — over the fixes, and three of its findings are defects the REMEDIATION introduced

| # | finding | disposition |
|---|---|---|
| **1** | **The M3 redaction was a COUNTING ORACLE.** Restricted codes were filtered out of `orderableCodes` while `itemIds` stayed beside them, so `orderableCodes.length < itemIds.length` **proves** a restricted test exists — and with one item and an empty array the reader learns the patient's only test is one of six, narrowed further by the container `printLabels` chose from that orderable's own catalogue row. **This is `hasHiddenItems` — the boolean `kernel/orders/read.ts` deleted for being too revealing — rebuilt out of two fields, one level down from where the kernel enforces the rule.** The new test asserted the leak rather than closing it. | **FIXED** `b8b03a6`: no codes on ANY row without clearance |
| **2** | **The C2 try/catch moved a MONITORED failure to a discarded one.** `scheduler.ts` catches a throwing run, writes an ERROR heartbeat and appends `sweep.failed`; `alerts.yml` carries both lab jobs (F19); `jobs.ts` drops the return value. A deterministic failure — no `credit_note` series for the new financial year — would have refunded nobody, for ever, with a **green heartbeat and no page.** | **FIXED** `b8b03a6`: the batch completes, then throws |
| **3** | **M6 needed no migration.** `lab_sla_breaches` already carries `due_at`; an `onConflictDoUpdate` guarded on it separates "already announced" from "entered again". **And C1's fix is what makes it bite** — reject → redraw → reject again is now the ordinary difficult-draw case, and the second `recollection_pending` breach never alerted. | **FIXED** `b8b03a6`; pass 1's "report, don't fix" was WRONG |
| **4** | **Both one-patient guards compared raw `patients.id`, and `merge.ts` does not repoint `orders.patient_id`.** One person legitimately has orders under two ids, so a merged patient's own add-on looked like a second person and `printLabels` refused the whole group **for ever, with the money already taken.** | **FIXED** `b8b03a6` — both guards resolve the chain |
| **5** | **The remediation borrowed error codes after declining to fix M7 for that exact reason** — `no_active_order` twice for authorization, serving a 403-shaped denial as **409 "re-read and retry"**, so a well-behaved client would poll a worklist it can never see. | **FIXED** `b8b03a6` — the ENVELOPE's own `actor_cannot_read` / `permission_denied` |
| 6,7,9,10,11 | The desk's group check was racy; the skipped envelope projection removed the only guard on a concurrently-cancelled item; `reject`'s comment named `pending`, not an envelope state; `creditNotes` was reported from inside the transaction; a second accession wiped the first's identity re-check. | **ALL FIXED** `b8b03a6` |
| 8,12,13 | `cancelled_from = 'in_progress'` + a full refund is the discriminator O-4 will read; the M8 census binds the state LIST but not the transitions; the `drawableItems` widening is inert today. | **REPORTED** — F30, F31 |

**PASS 2's VERDICTS PER FIX:** C1 **SOUND BUT INCOMPLETE** (lifecycle traced legal end to end, all
five widenings admit no row they should not, `notYetStarted` fails closed); C2 **SOUND BUT
INCOMPLETE** (the savepoint nesting genuinely holds for `issueCreditNote` — no catch, no
compensating lane, so M4's shape does not recur); M3 **SOUND BUT INCOMPLETE**; M5 **SOUND BUT
INCOMPLETE**; M8 **SOUND**. Every "incomplete" is closed in `b8b03a6`.

**ON THE FOUR "REPORT, DON'T FIX" DECISIONS:** pass 2 called M4 **defensible**, M7 **defensible as
to the freeze but violated in practice** (which `b8b03a6` corrects), M9 **defensible on severity but
not on reachability** — an advisory lock was available inside T4's own file, and the honest reason
is that an acknowledgeable warning's lost race costs a reversible double-bill against a new
serialisation point on the desk's hottest path — and **M6 NOT defensible**, which is why it is now
fixed.

**THE METHOD FINDING.** §2.140 said the second reviewer is not optional and produced the rule
*"when a fix REMOVES a disclosure, enumerate every OTHER field on the same response that is a
function of the removed one"*. This phase is that rule's second specimen, and the sharper form it
earns: **a remediation is not a smaller diff than the work, it is the same kind of work, and it
carries the same defect rate.** Two of pass 1's five fixes introduced a new defect; one of pass 1's
four deferrals was wrong. A single-pass close would have shipped all three.
### 9.7 Actuals — **the token balance at every task boundary** (v3 §6 as amended; recorded only after §9.6 exists)
### 9.8 The question this phase existed to answer

**"Can a lab be configured, ordered at, and accessioned — with the money right and the patient
right — before anything can be resulted?"** Yes, and the three things that decided it were not the
ones the plan expected.

**The plan expected F7 to be the risk**, and it was answered before T4 wrote a line: the savepoint
nests, so DD6's one transaction holds. T4 was then an ordinary implementation task, exactly as the
re-cut predicted, and A3 asserts the seam over the real pair.

**What actually cost the most was CENSUSES NOBODY'S FILES LIST NAMED.** Three separate ones
corrected this phase — the IST clock (F10, which had `main` red for forty minutes and was invisible
to the module's own suite), the lab error map (F22, which put the right-patient scan in the wrong
file), and the nine-file job registration (F19, third phase running). All three are DERIVED
expectations that read the tree rather than a list, and all three worked exactly as their authors
designed. **The lesson is not "write better Files lists" — it is that a derived census is the only
kind that survives a Files list being wrong**, and this phase is the argument for writing more of
them.

**And the mutant discipline paid in an unexpected direction.** Thirteen T5 mutants, and the four
most valuable were the ones that SURVIVED (F21): they proved that `receive`'s single-winner property
is defended four deep, that no single-guard mutant can kill it, and that what `receive`'s own CAS
uniquely owns is the sentence a bench reads rather than the invariant. A row declared green on the
first kill would have recorded none of that.
### 9.9 Deploy block — written when the owner authorises, never before

**NOT AUTHORISED, NOT WRITTEN.** What execution established the runbook will have to contain, so the
list is not re-derived: the `LAB` `opd_departments` row (production has twelve departments and no
`LAB`, S5 — `openLabWalkin` refuses `unknown_department` until it exists); **exactly ONE** active
pathologist-of-record as an `opd_doctors` row in it (F13 — two make the desk refuse rather than
choose); the production catalogue seed from the owner's spreadsheet, never `seed-lab-catalogue.ts`,
whose ranges are invented (§4A item 3); `activateLabDefinitions(db, activator)` for the two Class-C
machines; the `resources` rows of kind `bench` matching the catalogue's `bench_key` (S11 — zero
exist, and the worklist is correctly empty until they do); the four roles' grants; and
`WORKER_LAB_SWEEP_INTERVAL_MS` if the 60 000 default is not wanted. **`docker/prod/prometheus/alerts.yml`
changed in this phase and ships with the deploy** — the two new jobs are in both staleness legs and
the `absent()` chain, so a worker that never starts them pages rather than going quiet.

---

## HANDOFF — written at the T3 boundary, 2026-08-29 (v3 §9.6: run first, write second)

**The successor reads §0, then this section, then starts at T4.** Everything below is either
committed or measured; nothing here is a description of code that has not run.

**WHAT IS TRUE ABOUT THE CODE, AND HOW IT IS KNOWN.** T3 is committed as `b06e3d6`, green:
`jest src/modules/lab` **57/57, exit 0**, typecheck 0, lint 0, on `hmis_17a_scratch`. Nine mutants
built, run isolated and DEAD, with expected-vs-received in §9.4. This is not a "written but
unverified" handoff — §9.6's own failure mode — and the successor should not re-run T3 to believe it.

**THE ONE THING THAT WAS GOING TO DECIDE T4, AND IT IS DECIDED.** F7 asked whether
`issueInvoice(tx as unknown as Db, …)` nests as a savepoint that rolls back with its parent, because
DD6's whole "ONE transaction" design rests on it. **It does** (§9.3, both directions probed against
Postgres). So T4 is now an ordinary implementation task: write `deskOrder` to do `placeOrder` then
`issueInvoice` on the SAME `tx`, and let A3 assert the rollback over the real pair.

**WHAT IS NOT DONE.** T4 and T5, in full. No `desk.ts`, `workflow-def.ts`, `definitions.ts`,
`lab_item.json`, `lab_specimen.json`, `collection.ts`, `specimens.ts`, `accession.ts`, `sweeps.ts`.
`openLabWalkin` is not written and `modules/opd/encounters.ts` is untouched. No worker job is
registered, so the five job censuses of §2 row 8 are unmoved.

**THE FIVE THINGS NOT TO RE-DERIVE.**
1. **The spike is answered** — §9.3 carries S10 (the scheduler injects `now`, so T5 A4's seven-day
   boundary is two calls with two instants), S11 (no `bench` rows in production — a runbook act),
   and F7. Read them; do not re-read `scheduler.ts` or re-query production.
2. **T3's exports are the interface** — `resolveRange`, `evaluateFormula`, `matchReflex`,
   `duplicateWarnings`, `getOrderable`, `analytesFor`, `rangesFor`, `activeReflexRules`, all on
   `modules/lab/index.ts`. T4 CALLS them. **`matchReflex` deliberately does not check consent**
   (§6.3) — that is 17b's caller's job and neither side may assume the other did it.
3. **The golden fixture is seeded by `seedLabCatalogue(db, actor)`** and every T4/T5 fixture should
   build on it rather than hand-rolling orderables. Service ids are `serviceIdForLabCode(code)` —
   e.g. `LABSVC-CBC`. The three reflex rules are INACTIVE and a test pins that count at zero.
4. **F4's four reds** — two were the tests and one was the code. In particular a `range()`-style
   fixture helper that drops `...over` produces a suite that looks rigorous and reaches nothing.
5. **F8/§2.142's staging technique.** Lane B still shares this checkout (radiology, pcpndt,
   `0047`). `git add <path>` stages a WHOLE file, so for a file both lanes have edited, stage
   HEAD-plus-your-hunks as a blob (`git hash-object -w --stdin --path` + `git update-index
   --cacheinfo`) and read `git diff --cached --stat` before committing.

**THE DATABASE.** `TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_17a_scratch"`, named
in every commit that cites a green run, dropped by explicit name at CLOSE — **not yet dropped**.

**BUDGET.** Stop-loss **1,350,000**. Spent through T3: **~132,000** (§9.7's table), against a term
that budgeted ~330,000 for one CRITICAL task. The successor records its own balance at each task
boundary — that obligation is v3 §6's new one and this phase is one of the two making it real.

**WHAT T4 SHOULD DO FIRST.** Write `deskOrder` and A3 together, since the seam is now known-good;
then A1/A1b/A2 through the REAL `withIdempotency` imported from `../billing` (DD22 — 17a mounts no
route, so the test calls the same function 17b's controller will); then the walk-in, which needs a
`LAB` department and a pathologist `opd_doctors` row in the fixture (S2), and whose refusal path is
A9. **A7's mutant fails on the BICONDITIONAL CHECK, not an FK** — `orders.external_referrer_id` has
none (S3).

**THE CLOSE REVIEW'S BRIEF (v3 §9.7, verbatim — the operand instruction goes FIRST, ahead of any
dimension list):**

> For every threshold, cap or limit on a money or safety path: name what the compared quantity is
> summed from, and name one real transaction whose money that sum does not include. Do the same for
> every "already exists", "already collected" and "already done" check — `printLabels`' mismatch
> refusal, the accession CAS, the duplicate detector, the idempotent desk route, the non-return
> sweep's 7-day boundary — say what it queries and which writes it would miss.

**Money file first:** `desk.ts`, then `accession.ts`, then `duplicates.ts`. **Name the frozen
interfaces consumed:** `placeOrder`, `advanceOrderItem`, `issueInvoice`, `issueCreditNote`,
`withIdempotency`, `nextEpisodeNo`, `openVisitInTx`, `startInstance`. **Tell both reviewers that
Lane B may be running tests in this checkout and forbid them to run any** (§2.136: both of 22c-A's
reviewers were read-only and both still confirmed migrations, lock order and HTTP mappings by
reading).
