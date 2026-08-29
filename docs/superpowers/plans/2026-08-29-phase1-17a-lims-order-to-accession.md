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
| kickoff | 15,000,000 | — |
| T3 committed | 14,874,000 | **126,000** |

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

**Inherited answers re-checked rather than assumed:** S1's `billing.credit.extend` grant is present
in `ROLE_MODEL` for all three lab roles (`39beff0`); S6's `nextEpisodeNo` signature is unchanged;
S2's `openVisitInTx` still requires an active doctor in an active department. S3 and S4 were read
this session and are unchanged.

### 9.1 The commits
### 9.2 Findings
### 9.4 The Assertion Book, corrected by execution
### 9.5 Mechanical verification — name the `TEST_DATABASE_URL` database of every run claimed (§2.137)
### 9.6 The close review: pass 1 (fresh) and 9.6.2 (pass 2, fresh, over the fixes, a verdict per fix)
### 9.7 Actuals — **the token balance at every task boundary** (v3 §6 as amended; recorded only after §9.6 exists)
### 9.8 The question this phase existed to answer
### 9.9 Deploy block — the `LAB` department, the pathologist-of-record as an `opd_doctors` row, the production catalogue seed, the definitions activation, the bench rows, the four roles' grants — written when the owner authorises, never before

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
