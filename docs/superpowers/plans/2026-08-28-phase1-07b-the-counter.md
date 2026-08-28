# Plan 07b — The Counter: one person, one screen, one walk-in

**Status:** AUTHORED 2026-08-28, NOT APPROVED FOR EXECUTION.
**Owner rulings folded:** four, taken 2026-08-28 (§4A).
**Predecessor slice of Plan 22** (front office at scale, 00-INDEX §3). This phase does not claim a
Track C number and does not disturb the numbering ratification: it is the UX remediation of what
Plan 07 and Plan 08 already shipped, and Plan 22 replaces its screens with the multi-counter,
kiosk and display versions when the hall needs them.

**Next free migration: 0038 — this phase should need none.** If a task reaches for one, that is a
signal it has strayed into Plan 22's tables (§4 DD9).

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Nine tasks, five CRITICAL. Nothing here invents a money rule, a clinical rule or a
workflow state — every CRITICAL is critical because it moves an existing guarantee onto a new
surface, and the failure modes are the quiet kind: a wrong patient on a strip, a partial walk-in,
change that never reached the drawer.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA;
reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **700,000 tokens**

- **Per-task rate — 20,178** (Plan 16a, the closest LIGHT UI-and-surface phase;
  [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). Same known bias as
  22a-1 records: for a LIGHT phase this is a review cost wearing an execution cost's clothes, and
  main-session cost stays unmeasurable (runbook **O3**).
- **Task term:** `1.5 × (20,178 × 9) = 272,403`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`** (Plan 14 actuals).
- **Total: 730,894.** Trimmed to **700,000** deliberately: unlike 22a-1 this phase raises no new
  money rail, so the third-pass escalation it reserved budget for does not apply here.

**The escalation, stated so it is not taken silently.** If the first pass finds a CRITICAL in
**T1 or T6** — the patient-identity strip and the composed transaction, where a defect is both most
likely and most expensive — stop and get owner authorisation for a third fresh pass rather than
quietly exceeding.

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 9,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |
| **NOT pointed at:** brainstorm doc 20 (Plan 22's scope, not this one) | — | — |

---

## 1. Why this phase

### 1.1 The point

The hospital can already run an OPD. What it cannot do is run one *quickly with one person on the
counter* — which is the staffing reality at current traffic, and the owner's ruling (§4A R-4).

Every screen in the build is a faithful one-to-one projection of a backend module. The counter
clerk's unit of work is not a module; it is one human from hello to goodbye. There is no shared
patient context anywhere in the web app — four screens each mount their own `PatientPicker` with
private `useState`, and unmounting a route discards everything. So the simplest possible walk-in
costs **three route changes, three searches for the same patient, one hand-typed encounter id and
seven backend calls in seven separate transactions.**

This phase does not add a capability. It connects ones that were already built and never wired,
and composes three screens into the one desk a single staffer actually works.

### 1.2 THE SLICE — ruled at write time

**In:** the patient-in-hand context, the counter screen, the composed walk-in transaction, the
counter's missing money mechanics, the handoffs, the nav.

**Out, and named so it is not drifted into:** kiosks, queue displays, PBX, call centre, appointment
policies/overbooking/waitlist, `duplicate_candidates` as a table, counter resources in the registry,
the payment gateway. All of that is **Plan 22 / 22a**. This phase touches no new table.

---

## 2. Ground truth — measured 2026-08-28 at `69dde01`, **re-measure at kickoff** (AGENT-RULES §6)

| measured | value | where |
|---|---|---|
| Route changes, simplest walk-in | 3 | `registration` → `patients/$id` → `opd/desk` → `billing` |
| Searches for the same patient | 3 | four independent `PatientPicker` mounts |
| Shared patient/encounter state | **none** | no store; grep for zustand/redux/createStore returns nothing |
| Backend calls / transactions | 7 / 7 | `patients.search`, `POST /patients`, `POST /opd/visits`, vitals, fee-quote, `POST /billing/invoices`, consult-start |
| Idempotency coverage | billing only | `withIdempotency` lives in `modules/billing/idempotency.ts` |
| Duplicate check at registration | **none** | `registerPatient` inserts unconditionally |
| DB queries per fee quote | ~10 | `feeQuote` → `previewInvoice` → `loadPricingContext`; encounter fetched twice; nothing cached |
| Nav entries / routes | 27 / 32 | `router.tsx` `NAV`, pinned by `caddyfile-parity.test.ts` |
| Links a `front_office` + `cashier` holder sees | 7 | flat, ungrouped, one row |
| `/billing?encounterId=` senders | **0** | receiver + tests exist; all three refs to `/billing` are bare |
| `switchWithPin` / `switchWithBadge` UI | **none** | server routes exist, no front door |

**The three unwired rails.** `/billing?encounterId=` (documented at `router.tsx:351`, read at
`billing-counter.tsx:90`, covered by its own suite, constructed nowhere); `switchWithPin` /
`switchWithBadge` (built for shared terminals, no UI); `secondFactor` on `PermissionGuard` (built,
zero routes, deliberately — production holds no TOTP enrolments). The first is this phase's
cheapest win. The second is **out of scope at one-staffer traffic** (§4 DD10). The third stays
unarmed.

---

## 3. Spike — answered at kickoff, recorded in §6.3

**S1 — Can `withIdempotency` be lifted to the kernel without breaking billing?** It lives in
`modules/billing/`, throws `BillingError`, and the shipped ESLint module-isolation rule forbids
`src/modules/**` importing another module's internals — so OPD cannot call it where it stands. The
table (`idempotency_keys`) is already kernel. Measure: does lifting the helper to
`kernel/idempotency.ts` with a caller-supplied error constructor leave every billing suite green?
**If it does not, T6 uses a route-local claim and says so rather than duplicating the helper.**

**S2 — What does `.print-doc` isolation actually permit?** `styles.css` prints exactly one
`.print-doc` at a time, and `opd-desk.tsx`'s header calls that out as load-bearing. T9 must combine
the token slip and the fee receipt into ONE document node, not two siblings. Measure it before
designing the node.

---

## 4. Design decisions

**DD1 — The counter ends at payment, and does not touch vitals.** Owner ruling R-1: vitals are
recorded by dedicated staff. So the counter's scope is *register → open visit → bill → collect →
hand off*, full stop. **The OPD workflow definition is not edited by this phase** — `registered →
waiting` keeps its `vitals_desk | nurse | doctor` grant. That is a real scope win: no Class A
workflow change, therefore no owner re-activation, therefore no migration.

**DD2 — Every walk-in leaves the counter in exactly one of three lawful states, and the counter
must show which.** Owner ruling R-2: no patient passes the counter unbilled. The system already
supports precisely three exits and `gate.ts` already honours all three —
**(a)** an invoice settled; **(b)** an invoice **credit-extended** with a reason (the charge was
raised, the money is owed, the patient may be seen — `feeCovered` returns true on
`creditExtended`); **(c)** a **free revisit**, no invoice at all (`feeServiceFor` → `null`,
spec:224, Plan 07's own owner decision). Nothing new is built. The defect today is that the counter
cannot *see* which state it is in, so the clerk cannot tell the patient. The screen must name the
exit before the patient walks away.

**DD3 — The patient-in-hand holds ids, never a name.** `sessionStorage`, tab-scoped: it survives an
accidental refresh (which happens several times a shift) and dies with the tab (shared counter
machines — inheriting the palette's DD8 reasoning verbatim rather than re-deriving it). It stores
`patientId` and `encounterId` **and nothing else**; everything rendered comes from a live query on
those ids. A cached name that goes stale after a merge is a wrong-patient risk, and L8 rules a
wrong merge a patient-safety emergency.

**DD4 — The strip is a new exposure surface and is closed in the same task.** Putting patient
identity on *every* screen puts it on screens a visitor reads over the shoulder. The strip renders
through `patientLabel()` — alias for `restricted`, never the raw name — so confidential, VIP and
staff-as-patient stay aliased (L2). This is not a follow-up; a strip that leaks is worse than no
strip.

**DD5 — The drawer is the counter's precondition, not billing's.** R-2 plus R-4 together mean one
person must have an open cashier session before they can serve the *first* patient — because
`issueInvoice` calls `requireOpenSession`, and payment is now mandatory. Today they would discover
that at the payment step, having already registered the patient and opened a visit: a half-done
walk-in caused purely by ordering. The counter checks the session **on mount** and offers "open
drawer" inline. The variance lockout stays exactly as Plan 08 ruled it — it is a financial control,
not friction — but its operational consequence is now larger and is routed (§4A O-1).

**DD6 — UPI stays manual, and the tender reference stays mandatory.** Owner ruling R-3: collect UPI,
enter the amount manually, automate after 22a-1. So `tender_ref_required` **stays**. Dropping it
would create an unreconcilable hole that both today's T+1 recon (`recon.ts` matches on reference)
and 22a-1's settlement import would inherit — we would be buying counter seconds with a permanent
accounting defect. Speed comes from the field, not from deleting it: inline in the tender row,
numeric input mode, and the UTR's **last six digits** accepted rather than the full string.
**No QR on the token slip, no gateway, no webhook in this phase.**

**DD7 — The composed endpoint is the transaction; the UI is not.** `POST /opd/walk-in` runs in one
transaction under one `Idempotency-Key`. The counter screen must **not** orchestrate seven calls
client-side and call the result atomic — a browser that dies between call three and four is exactly
the partial state being removed. If T6 slips, T3 ships against the existing calls and **the
atomicity gap is stated in the close report, not hidden**.

**DD8 — Duplicate detection here is a query, not a table.** `duplicate_candidates` belongs to Plan
22 (brainstorm doc 20 §1.3). This phase warns at registration time from the trigram search that
already exists (`patientFuzzyCondition`): *"3 possible matches — review before registering."* A
warning the clerk may override, evented, not a gate. Building the table here would take a component
from a plan that has not been authored.

**DD9 — No new tables, no migration.** If a task needs one, it has strayed into Plan 22. Stop and
say so.

**DD10 — Fast user-switch is out.** `switchWithPin`/`switchWithBadge` exist and have no UI, but at
one-staffer traffic (R-4) a shift change is a rare event and a full login is the correct cost. It
returns with Plan 22's multi-counter model. Naming it here so the next reader does not re-discover
it as a gap.

**DD12 — CORRECTION, 2026-08-28, made while executing: "there is no change calculator" WAS WRONG.**

This document and the brief that preceded it both said the counter computes no change and silently
banks an overpayment as an advance. Measured in the code, that is false in its first half and
imprecise in its second. `issueInvoice` computes `unallocatedPaise = receiptTotalPaise -
allocatedPaise` and returns it; `billing-counter.tsx` renders it; the locale string reads
**"Change due / banked as advance: {{amount}}"**. A figure is computed and shown.

**The real defect is that those are TWO OUTCOMES WITH ONE RECORD.** The banner names both and the
cashier picks; the ledger writes the same row either way — an unallocated receipt balance, which
*is* a patient advance. Nothing anywhere records cash handed back (`grep` for a change-out concept
returns nothing). So when the cashier hands the money over, the advance is fictional: the patient's
balance is overstated by exactly that amount AND the drawer is short by it at close, with no row
that explains the variance. `expectedCash(openingFloat, cashTenders, cashVouchers)` has no term for
it, so the variance lands on the cashier.

**T5 is therefore not "add a calculator". It is: make the cashier DECLARE which lane, record the
change-out, and add its term to the expected-cash fold.** That needs a migration, which this phase
said it would not take — so T5 is re-scoped and re-costed rather than quietly widened, and the
honest note is that the original framing would have shipped a second display of a number that is
already displayed while leaving the money wrong.

**DD11 — The existing screens stay.** `/opd/desk` and `/billing` are not deleted or redirected. The
counter sits beside them: the supervisor's board, the transfer lane, the dues desk and the billing
office all still need their own surfaces, and Plan 22's multi-counter model needs them intact.

---

## 4A. ROUTED TO THE OWNER

**Rulings already taken, 2026-08-28 — folded above, not re-litigated:**

| # | Ruling | Where it lands |
|---|---|---|
| **R-1** | **Front desk does NOT record vitals** — dedicated staff do | DD1; no workflow edit; T7 makes the handoff visible instead |
| **R-2** | **Pay-before-consult holds.** No patient passes the counter without being billed; payment first, then consultation | DD2, DD5; L7 unchanged |
| **R-3** | **UPI collected and entered manually** against the UPI mode; automation after 22a-1 ships | DD6; no gateway in scope |
| **R-4** | **One staffer may hold all three roles and must be able to work smoothly** — traffic is low, do not staff three desks | DD5, DD10, DD11; T3 and T8 are the answer |

**O-1 — the single-staffer lockout. STAFFING, therefore yours.** A paise mismatch at close moves the
cashier session to `closing` and locks that person out of **all** counter work until a
`billing_manager` grants a variance approval. With one person on the counter (R-4) that now closes
registration and visit-opening too, not just billing — the hospital's front door. The control is
correct and stays. **Name who covers**, and whether they hold `front_office` standing or are granted
it at the moment. T4 builds whatever you name; if you name nobody, T4 ships the loud failure and the
runbook records the gap.

---

## 5. Edge-case pass (owner standing rule — before the doc is final)

| # | Case | Ruling |
|---|---|---|
| E-1 | New patient at the counter | Inline registration inside the counter screen; never a route change (T3) |
| E-2 | Free revisit inside the follow-up window | DD2 exit (c). Counter shows "No fee — revisit". No invoice, gate passes. Must not look like a failure |
| E-3 | Scheme / zero-cash patient (JSSK, PMJAY) | DD2 exit (b): invoice raised, credit extended with reason. Satisfies R-2 — *billed*, not necessarily *paid* |
| E-4 | Patient short of cash | Same credit lane, reason mandatory, approval above `creditCapPaise` |
| E-5 | Cash tendered over the amount | See the CORRECTION below — the figure exists; the two lanes are conflated |
| E-6 | Cash episode crosses the PAN threshold | Surfaced **at quote**, not at submit (T5). Never a surprise after notes are on the counter |
| E-7 | Drawer not open at shift start | Blocked on mount with an inline "open drawer" (DD5), not at the payment step |
| E-8 | Drawer variance lockout mid-shift | O-1. Loud, named, runbook-recorded |
| E-9 | Double-click / retry / flaky uplink | One `Idempotency-Key` per walk-in, minted in one place (T6). Today a retry mints a second UHID |
| E-10 | Two counters open the same patient | No guard exists on `openVisit`; the idempotency key covers the one-staffer case. Genuine multi-counter concurrency is Plan 22 — **stated, not silently fixed** |
| E-11 | Appointment arrival, not a walk-in | `checkInAppointment` already composes claim + visit-open in one transaction; T3 routes it into the same billing step so both paths end identically |
| E-12 | Patient abandons after paying, before vitals | Abandon-with-reason exists; the refund's first step has no UI. **Out of scope, named in the close** — it is 22a-2's concession/refund surface |
| E-13 | Discount above cap, manager elsewhere | Counter must let the clerk *request* the approval inline rather than paste an id it cannot obtain (T5). At one staffer, out-of-band coordination is a stall |
| E-14 | Confidential / VIP / staff-as-patient | DD4. Aliased on the strip, on every screen |
| E-15 | Merge lands while a patient is in hand | DD3 — ids only, live queries, so the strip follows the merge instead of showing a dead name |
| E-16 | Printer dead | Existing downtime kit. Unchanged |
| E-17 | Doctor goes on leave after the visit opened | Existing `needs_rebooking` + E2 bulk transfer. Unchanged |

---

## 6. Tasks

Nine. **Five CRITICAL.**

### T1 — The patient-in-hand context and the counter strip — **CRITICAL**

A React context over `sessionStorage` holding `{ patientId, encounterId }` (DD3). Every
`PatientPicker` reads and writes it. A persistent strip on the authed layout rendering photo, alias-safe
label, UHID, age/sex, token, visit no, fee status and dues — all from live queries on the ids.

#### Assertion Book — T1

| # | Assertion | Mutant |
|---|---|---|
| A1 | Picking a patient on any screen sets it for every screen | Keep the picker's local state only → the three-search defect survives the phase |
| A2 | Restores after a reload, in the same tab | Hold it in memory only → an accidental refresh loses the patient mid-transaction |
| A3 | A second tab starts empty; logout clears it | Use `localStorage` → the patient survives the shift change on a shared machine (the exact thing the palette refused to do) |
| A4 | The strip renders `patientLabel()`, never `patient.name` | Render the raw name → confidential/VIP identity leaks onto every screen (DD4, L2) |
| A5 | Only ids are persisted; name/dues come from a query | Cache the name → a post-merge strip shows a patient who no longer exists (L8) |

### T2 — Wire the three handoffs — **ROUTINE**

Token slip's terminal button becomes **"Take payment →"** navigating `/billing?encounterId=…`.
`/patients/$patientId` gains its onward actions (open visit · book · bill · timeline). Palette entity
hits carry their ids. `Alt+B`/`Alt+D`/`Alt+P` act on the patient in hand. `PatientPicker` takes
`autoFocus` on mount.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | The token slip constructs `/billing?encounterId=<id>` | Navigate bare → the receiver stays dead exactly as it has been since Plan 08 |
| A2 | `/patients/$id` has at least one onward action | Leave it read-only → the registration search still dead-ends |
| A3 | A palette invoice hit opens that invoice, not the dues list | Drop the id → the palette keeps pretending to be navigation |

### T3 — The counter screen — **CRITICAL**

One route. Scan or search → register inline if new (with the DD8 duplicate warning) → department and
doctor → open visit → fee quote → tender → issue → print. Ends by naming the DD2 exit and the vitals
handoff. Appointment arrivals (E-11) enter the same flow at the billing step.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A1 | A returning walk-in completes with **one** patient search and **zero** route changes | Allow a second picker → the phase's whole reason is gone |
| A2 | The screen names which of DD2's three exits applied | Show only "issued" → a free revisit reads as a failure and the clerk collects nothing (or bills twice) |
| A3 | Registration warns on trigram matches before inserting | Insert unconditionally → today's duplicate-UHID factory ships forward |
| A4 | The screen never moves the encounter past `waiting_vitals` | Add a vitals write → violates R-1 and edits a Class A workflow |

### T4 — The drawer precondition — **CRITICAL**

Session checked on mount; inline open with declared float; the lockout surfaced loudly with O-1's
named cover.

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A1 | No open session blocks at mount, before any patient is touched | Check at payment → a half-done walk-in every shift start (DD5) |
| A2 | A `closing` session states the lockout and names the cover | Fail with `no_open_session` → the clerk reads it as a bug and retries forever |

### T5 — The counter's money mechanics — **CRITICAL**

Change calculator. Cash-law/PAN evaluated at quote. Tender reference inline, numeric, last-six
accepted. Discount approval **requested** from the counter.

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A1 | Cash over the payable shows **change due**, and does not bank an advance silently | Keep today's behaviour → drawer and ledger disagree by every note handed back (E-5) |
| A2 | PAN/Form-60 is demanded at quote time | Evaluate at submit → the surprise blocking field survives (E-6) |
| A3 | Non-cash tenders still require a reference | Make it optional → an unreconcilable hole 22a-1 inherits (DD6) |

### T6 — `POST /opd/walk-in`, one transaction, one key — **CRITICAL**

Attach-or-register + open visit + issue invoice + settle tender, in one transaction under one
`Idempotency-Key` minted in one client place. Depends on S1.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A1 | A failure at any step leaves **nothing** written | Keep separate transactions → a patient parked in `waiting`, unpaid, with nothing to reconcile |
| A2 | A replay returns the original result, not a refusal | Answer 409 → the clerk is told the payment failed while the hospital holds the money |
| A3 | The same key with a different body is refused | Answer the original → a second patient gets the first one's receipt |
| A4 | The free-revisit path writes no invoice and still succeeds | Force an invoice → spec:224 broken and every revisit charged |

### T7 — The vitals handoff, made visible — **ROUTINE**

R-1 keeps vitals a separate desk, so the handoff must stop being implicit. The printed slip names the
vitals station; the counter shows "sent to vitals"; the vitals worklist surfaces newly-billed
arrivals.

### T8 — One desk, not seven links — **ROUTINE**

Group the nav. A `front_office` + `cashier` holder sees **Counter** first, with the module screens
grouped behind it. `nav-parity.test.ts` and `caddyfile-parity.test.ts` must both stay green — the
route count moves and the manifests must move with it (the M6/F1 precedent).

### T9 — Print once — **ROUTINE**

Token slip and fee receipt as ONE `.print-doc` node, one click. Depends on S2.

---

## 7. CLOSE

- [ ] Ground truth §2 re-measured at kickoff and the table corrected in place
- [ ] S1 and S2 answered, recorded in §6.3
- [ ] Every Assertion Book row has a passing test and a killed mutant
- [ ] `nav-parity` and `caddyfile-parity` green; route count updated deliberately
- [ ] **Walk-in measured end to end and the §2 numbers restated** — searches, route changes, calls
- [ ] The three DD2 exits each demonstrated on the counter screen
- [ ] Named in the close report, not hidden: **E-10** (multi-counter concurrency → Plan 22),
      **E-12** (same-visit refund UI → 22a-2), **DD10** (fast user-switch), and the T6 atomicity gap
      if T6 slipped
- [ ] O-1 answered by the owner, or the gap recorded in the runbook
- [ ] Stop-loss not exceeded, or the T1/T6 escalation taken explicitly
