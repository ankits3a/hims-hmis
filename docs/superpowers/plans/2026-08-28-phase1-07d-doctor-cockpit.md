# Plan 07d — The doctor's cockpit: the record, the shelf, and the price list

**Status:** AUTHORED 2026-08-28, NOT APPROVED FOR EXECUTION.
**Depends on:** **07a** (the read gate — this phase's whole subject is reading patient records) and
07c (the desk and the brief this cockpit links into).
**Gated on a staffing decision, not on code — see §1.3. Read that before approving.**
**Next free migration: 0040 — this phase should need none.**

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Seven tasks, three CRITICAL. The CRITICALs are the ones that either read patient history
or put a number in front of a prescribing doctor; the rest is surface.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA;
reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **670,000 tokens**
- **Per-task rate — 20,178** (Plan 16a). **Task term:** `1.5 × (20,178 × 7) = 211,869`.
- **Review — TWO FRESH passes: `244,568 + 213,923 = 458,491`** (Plan 14 actuals). **Total: 670,360 → 670,000.**

**Escalation:** a CRITICAL in **T3** (stock state shown while prescribing) stops for owner
authorisation of a third pass. A wrong availability number sends a patient to an outside chemist,
or worse, anchors a prescribing decision on a stale shelf.

---

## 1. Why this phase

### 1.1 What the doctor has today

One line per past visit. `patientTimeline` returns 50 encounters with date, department, doctor,
diagnosis, ICD-10 and a prescription **count** — and the consult screen renders exactly that,
one row each. There is **no way to read a prior prescription at all**: the only cross-encounter
prescription read in the tree is the private query inside `runRxChecks`, used for interaction
checking, never exposed as a browse surface. There is no cross-visit vitals history endpoint
either. The patient-detail screen shows demographics, allergies and guardians — no timeline, no
vitals, no prescriptions.

The context-assembler / snapshot card (Plan 16b) is **not built** — the document's own status line
reads *"PROVISIONAL … not approved for execution"*, and no code for it exists.

### 1.2 What the doctor asked for, and what is actually there

**Queue depth — free.** `summaryByDoctor` already returns `waitingCount`, `waitingVitalsCount` and
`nowServing` per doctor-day. Surfacing it is presentation.

**Drug availability — real, and three pieces short.** The link exists:
`items.formulary_medicine_id` is a foreign key into `formulary_medicines` with a CHECK enforcing
*drug-class item ⇔ has a formulary medicine*, and `GET /materials/stock/balances` already answers
on-hand / reserved / frozen per store with a FEFO picker beside it. Missing: (a) a
medicine→item→stock query — `listItems` has no `formularyMedicineId` filter and no endpoint does
the join; (b) the `materials.items.read` / `materials.stock.read` grants, which the `doctor` role
does **not** hold and would 403 on today; (c) a real drug search — `formularyManifest.search` is
declared and deliberately **empty**, so the consult screen is a plain `<select>` over every
medicine.

**Investigations — cannot be built as asked.** There is **no lab or radiology module**: no order
table, no result table, no test catalogue, no accession. The only adjacent artifact is the OT
specimen-label stub, whose own header defers accession to an unbuilt Plan 17. The tariff catalogue
holds **exactly two service rows** on a fresh database — both OPD consultations — and
`services.category` is free text with no CHECK. The `doctor` role does not hold `tariff.read`.

### 1.3 THE GATE — this is a staffing decision and it comes first

**Zero `formulary_medicines` are seeded.** The seed creates 29 salts and 26 interaction pairs and
**no brand medicines at all**. No materials items, vendors or stores are seeded either. And the
`pharmacy` and `storekeeper` roles exist with correct grants and **no human holders**, so on the
live deployment nobody can currently admit a medicine or receive stock.

**Therefore: the availability panel ships as a well-built empty box until a person holds the
`pharmacy` role and populates the formulary.** That is not a defect this phase can fix and not a
thing more UI improves. **Do not approve T3–T4 until that person exists and has begun.** T1, T2 and
T5–T7 are independent of it and are worth shipping regardless.

---

## 2. Ground truth — measured 2026-08-28 at `69dde01`, **re-measure at kickoff**

| measured | value |
|---|---|
| Past-record surface in consult | one line per visit, 50 max; no note text, no prior rx, no vitals history |
| Cross-visit prescription browse endpoint | **none** |
| Cross-visit vitals history endpoint | **none** |
| Formulary search seam | declared, **empty** (`search: []`) |
| Drug picker UI | plain `<select>` over `GET /formulary/medicines` |
| Seeded `formulary_medicines` | **0** (29 salts, 26 interaction pairs) |
| Seeded materials items / vendors / stores | **0 / 0 / 0** |
| Seeded tariff `services` | **2**, both OPD consultation |
| `doctor` holds `materials.stock.read` | **no** |
| `doctor` holds `tariff.read` | **no** |
| Lab / radiology / order / result tables | **none exist** |
| Holders of `pharmacy` role | **0** |

---

## 3. Spike — answered at kickoff, recorded in §6.3

**S1 — the medicine→item→stock join.** Measure it across every store for a realistic formulary.
The doctor needs one answer per medicine in under the interaction-check budget; if the join cannot
meet it, the cockpit reads a cached availability projection refreshed on stock movement rather than
querying live, and says which.

**S2 — is `services.category` usable for grouping?** It is free text with no CHECK. Measure what
values actually exist. If the answer is "two rows, one category", T5 ships the catalogue behind a
category vocabulary this phase does **not** invent — it belongs to tariff, and the finding is
routed rather than patched here.

---

## 4. Design decisions

**DD1 — Catalogue and availability, never clinical recommendation.** The system deliberately has no
clinical decision support: the inference module is speech-only, and the agent taxonomy caps clinical
advice hard. Showing what is on the shelf and what it costs is inventory and pricing. Ranking what
to prescribe is a different product with a different approval, and this phase does not drift toward
it. **No ordering, ranking or scoring of clinical options anywhere in this phase.**

**DD2 — Availability is information; the server still decides.** Carrying the OT cockpit's own law:
*"the client's idea of 'next' is a second copy of the state machine, and the copy that is wrong is
the one on the screen."* So stock state never disables a prescription line. Plan 16a's design law is
explicit that **prescribing is never blocked by formulary coverage**, and it must not become blocked
by stock coverage either — a doctor may prescribe what the hospital does not stock, and the patient
buys it outside. The panel informs; it does not gate.

**DD3 — Stale stock is worse than no stock.** A number a doctor trusts must be current. Every
availability figure carries its as-of instant, and if the projection is behind or materials is
unreachable the panel says *unknown*, never zero. **Absence of data must never render as "out of
stock"** — that is the failure that changes a prescription for the wrong reason.

**DD4 — Investigations print as advice, and the screen says so.** The doctor picks from the priced
service catalogue; the selections print on the prescription as *advised tests with prices*. This
creates **no order, books no sample and returns no result**, and the UI states that plainly rather
than implying a pipeline that does not exist. It is how an Indian hospital works before a LIMS
lands, it answers the patient's real question at the chair — *what will the scan cost me* — and the
selections become the demand signal that tells Plan 17 which tests to carry first.

**DD5 — Reads are gated and logged, per 07a.** Every past-record surface this phase adds is a new
PHI read path and inherits 07a's confidentiality gate, access log and out-of-context notice
**at the time it is written**, not afterwards. A phase that widens record access without widening
the audit is the defect 07a exists to close.

**DD6 — Two permission grants, named and minimal.** `doctor` gains `materials.stock.read` and
`tariff.read`. Nothing else. Both are reads. Recorded here because a grant made quietly inside a UI
phase is how permission models rot.

**DD7 — No new tables.** The joins and catalogues exist. If a task reaches for a migration it has
strayed into Plan 16c (dispense) or Plan 17 (lab), neither of which is authored.

---

## 4A. ROUTED TO THE OWNER

**O-1 — who holds the `pharmacy` role, and when do they start?** §1.3. This gates T3–T4 entirely.
Until it is answered the availability work should not begin, because it cannot be tested against
anything real and cannot be used on the live box.

**O-2 — should advised investigations be priced on the printed slip?** Recommended **yes**: the
patient's first question is the price, and a quoted price is a commitment the hospital already makes
at the counter. The reason it is yours is that a printed price is read as a quotation, and tariff
changes between the advice and the visit.

---

## 5. Edge-case pass

| # | Case | Ruling |
|---|---|---|
| E-1 | Materials unreachable or projection stale | Panel shows *unknown* with an as-of time — never zero (DD3) |
| E-2 | Drug stocked in another store, not the OPD pharmacy | Show per-store, nearest first; "in stock" without a location is useless |
| E-3 | Brand not stocked, same salts stocked separately | Show the same-salt alternative as information; do not auto-substitute |
| E-4 | Formulary empty (today) | Panel renders a named empty state pointing at the curation gap, not a spinner |
| E-5 | Confidential patient in the cockpit | 07a's gate; alias everywhere; break-glass for a sealed record |
| E-6 | Doctor opens a patient not in their queue | Allowed, logged, flagged out-of-context, and the doctor is told (07a DD3) |
| E-7 | Prior prescription from a doctor who has left | Readable; authorship is history, not a permission |
| E-8 | Patient merged since the last visit | Timeline spans the merge chain — already true, must stay true after gating |
| E-9 | Tariff price changes between advice and visit | Slip carries the as-of date; the counter reprices (O-2) |
| E-10 | Advised test the hospital cannot actually do | Catalogue is the source; an inactive service never appears |

---

## 6. Tasks

Seven. **Three CRITICAL.**

### T1 — The past-record panel — **CRITICAL**

Cross-visit prescription and vitals history endpoints (neither exists), plus the consult-screen panel
that reads them. Every route inherits 07a's gate and log.

| # | Assertion | Mutant |
|---|---|---|
| A1 | A sealed patient's history is not readable without the permission or a grant | Skip the gate → 07a is undone by the phase that follows it |
| A2 | Every new read writes an access-log row | Add the endpoint without the log → record access widens, visibility does not |
| A3 | The timeline still spans the merge chain after gating | Gate by dropping the chain → a merged patient's history silently truncates |

### T2 — Queue depth and the next patients — **ROUTINE**

`summaryByDoctor` surfaced on the cockpit and the desk; realtime, with 07c's stale indicator.

### T3 — Medicine → item → stock — **CRITICAL** · gated on O-1

The join, the `listItems` filter, the availability projection with its as-of instant, and the two
grants (DD6).

| # | Assertion | Mutant |
|---|---|---|
| A1 | Unknown and zero are **distinct** states end to end | Collapse unknown to zero → DD3's exact failure, and it is invisible |
| A2 | Availability never disables a prescription line | Gate the line → Plan 16a's design law broken (DD2) |
| A3 | Per-store, not a hospital total | Sum the stores → "in stock" in a building the patient will not walk to |
| A4 | The as-of instant is rendered, always | Hide it → a stale number reads as a live one |

### T4 — Drug search — **ROUTINE** · gated on O-1

Fill the formulary's declared-empty search seam; type-ahead over brand and salt, replacing the
full-list `<select>`, with stock state on each row.

### T5 — Advised investigations — **ROUTINE**

Catalogue browse over priced services, selections printing on the prescription as advice, with
DD4's statement on the screen and on the paper.

### T6 — The doctor's brief in reach — **ROUTINE**

07c's brief, linked from the cockpit, defaulting to the doctor's own day — including the session
start-vs-schedule line and the delay declaration it prompts.

### T7 — Locale and the empty states — **ROUTINE**

Keys in both `en.json` and `hi.json` (parity load-bearing; avoid the reserved `count`
interpolation name). Every panel gets a real empty state — §1.3 guarantees several will be empty on
day one, and a spinner that never resolves is the worst of the available answers.

---

## 7. CLOSE

- [ ] Ground truth §2 re-measured; §1.3's zero-counts re-checked on the live box
- [ ] O-1 answered, or T3/T4 explicitly deferred and the phase closed without them
- [ ] Every Assertion Book row has a passing test and a killed mutant
- [ ] Unknown-vs-zero proven end to end with materials made unreachable
- [ ] A confidentiality test on **each** new read route
- [ ] Locale parity; every panel has an empty state exercised by a test
- [ ] Named in the close: no ordering pipeline exists (DD4), the two grants made (DD6), and the
      demand signal captured from advised tests for whoever authors Plan 17
