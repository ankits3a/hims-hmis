# Plan 22c-A — The patient actor and the identity spine

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION — execution is a separate session with its own approval.** Two rulings were taken at write time and are recorded where they bite: the **SLICE** (§1.2 — M1 of the patient-self-service plan is three phase documents, this is the first) and the **FIELD-CLASS ASSIGNMENT of the gender split** (DD4, RULED). Every other decision this phase needs was locked before it was written, in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md).

**Roadmap:** [`2026-08-11-phase1-plan-series.md`](2026-08-11-phase1-plan-series.md) — Track C. Plan numbering reconciled in the department series' `00-INDEX-AND-SYNTHESIS.md` §3: **22 / 22a / 22b are taken**; the patient app is unallocated and this series proposes **22c**. **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §6 (the patient master — one table, every module references `patient_id` and copies nothing), §14 (confidential/VIP), §10.5 (event envelope). **Brainstorm:** [`../brainstorms/2026-08-27-patient-self-service/`](../brainstorms/2026-08-27-patient-self-service/) — `00-RECORD-AND-PLAN.md` §2.1 (the amendment law), `04-S1-IDENTITY.md` (the segment), `06-RULINGS-LOCKED.md` (every decision), `07-IMPLEMENTATION-PLAN.md` §2 (K1/K4). **This plan argues from those and does not restate them.**

**Slot:** production is at `0035`; this phase writes `0036`. Nothing in the house blocks it — and unusually for this series, **nothing downstream can start until it lands**: `Actor` has three types and every patient-facing route is refused by design until there is a fourth.

**Executor seed (v3 §1):** read this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 (lines 1132–1146) — then execute, on the build host, task by task. **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: it is 377,112 bytes ≈ 94,278 tokens and it is re-billed on every tool call (v3 §9.1).** The entries that bear on this phase are cited by number where they bite: §2.101, §2.115, §2.120/§2.121.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Seven tasks, no workflow definition, no approval band, no register, one migration. It is a kernel seam rather than a module build — the shape v3 §2 names as LIGHT's natural home. **What makes it not a small phase is blast radius, not breadth:** 29 files read `actor.type` and 46 sites throw `user_actor_required`. That does not change the lane — v3 §2 is explicit that the lane sets dispatch, not verification depth — it changes the tiering: **five of the seven tasks are CRITICAL** and carry executed mutants.

**The main session codes task by task** under AGENT-RULES in full, builds every mutant the inline Assertion Books name, watches CI with [`../pipelines/ci-watch-host.sh`](../pipelines/ci-watch-host.sh) by full SHA, and closes with independent reviewers — **spawned FRESH, not resumed** (v3 §9.5; ledger §2.115, and Plan 14's own measurement: two fresh reviewers at 244,568 and 213,923 tokens beat Plan 13's resumed chain, whose third invocation cost 28% more than its first and did 5% of the work).

### Stop-loss (v3 §6): **670,000 tokens**, arithmetic shown

`stop-loss = 1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`

- **Per-task rate — 20,178**, from Plan 16a (LIGHT, 9 tasks, 181,605 subagent tokens; [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)). Carried forward from Plan 14, which used the same input. **The known bias, restated so it is not forgotten: for a LIGHT phase `subagentTokens` IS the reviewer, so this "per-task rate" is a review cost wearing an execution cost's clothes.** Main-session cost remains unmeasurable from inside a session (runbook **O3**).
- **Task term:** `1.5 × (20,178 × 7) = 211,869`.
- **Review term — TWO FRESH passes: `244,568 + 213,923 = 458,491`**, Plan 14's measured actuals for exactly this pattern. Two passes rather than one because this phase changes a permission seam and an identity seam in the same migration, and both 09a and 13 found their most valuable defect in the *remediation* of the first pass.
- **Total: 670,360 → 670,000.**

**Read the arithmetic before trusting the number.** Seven tasks here price within 1% of Plan 14's nine, because the review term dominates and does not scale with task count. If this phase closes clean on one pass, it will come in at roughly two-thirds of the stop-loss — that is the expected case, not a saving to celebrate.

### Context budget (v3 §9.2), measured before compiling

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff (`wc -c`) | ≈ 7,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only (lines 1132–1146) | ≈ 3,500 | 875 |
| `06-RULINGS-LOCKED.md` | ≈ 12,000 | 3,000 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278 — the number §9.1's cite-by-number rule exists to avoid** |

**Per-agent context carried: ≈ 17,500 tokens.** Plan 09's briefs carried 374,461 into every one of 2,327 tool calls (ledger §2.101).

---

## 1. Why this phase

### 1.1 The seam

`Actor = { type: "user" | "agent" | "system"; id: string }`. `bookAppointment` throws `user_actor_required`; `verifyQrScan` says *"scanners are desk surfaces — user actors only"*. **Every step of the patient app is currently refused by design.** No amount of front-end work changes that, and nothing in the self-service programme can start until a fourth actor type exists and every one of the 46 guard sites has been decided one way or the other.

The same phase carries the identity machinery, because it is the same seam: an actor that can act on its own record needs a record whose provenance is stated (`identity_assurance`), whose history is retained (`patient_identity_versions`), and whose privacy flags are not settable by whoever can fix a typo (the permission split).

### 1.2 THE SLICE — ruled at write time

M1 of [`07-IMPLEMENTATION-PLAN.md`](../brainstorms/2026-08-27-patient-self-service/07-IMPLEMENTATION-PLAN.md) is sixteen tasks. That is a module build, which v3 §2 sends to HEAVY — and the Plan 14 precedent says the better answer is to slice, not to change lanes. **M1 is three phase documents:**

| | Phase | Scope |
|---|---|---|
| **this** | **22c-A** | The patient actor and the identity spine — kernel only. Serves the registration counter as much as the app |
| next | **22c-B** | Self-registration — OTP/PIN auth, drafts, the dedup gate, households, the confidential request |
| then | **22c-C** | Browse and book — public catalogue, doctor profiles, the availability projection, holds, binding, cart, pay-later |

**This phase ships nothing patient-facing.** Its whole visible output is at the counter: a registration clerk gains an assurance stamp, an amendment reason, and a permission wall between fixing a phone number and hiding a patient. That is deliberate — the riskiest change in the programme lands alone, with the full suite green, before anything is built on it.

### 1.3 What this phase does not do

No OTP. No households. No public route. No document chrome (that is `kernel-D`, its own phase — this one builds only the **resolver** the chrome will call). No booking. No money.

---

## 2. Ground truth — measured on this host, 2026-08-28, and **re-measure it at kickoff** (AGENT-RULES §6)

| fact | value | how |
|---|---|---|
| migrations on disk | **36** (`0000`–`0035`); this phase writes **`0036`** | `ls apps/core/drizzle/*.sql \| wc -l` |
| files reading `actor.type` | **29** (excluding tests) | `grep -rln 'actor\.type' --include="*.ts" apps/core/src \| grep -v '\.test\.'` |
| sites throwing `user_actor_required` / equivalent | **46** (excluding tests) | `grep -rn 'user_actor_required' --include="*.ts" apps/core/src \| grep -v '\.test\.'` |
| readers of `.sex` | **48** across core + web (excluding tests) | `grep -rn '\.sex\b\|sex:' --include="*.ts" --include="*.tsx" apps/core/src apps/web/src` |
| `patients` permissions today | `patients.register`, `.read`, `.update`, `.merge`, `.confidential.read` | `modules/patients/manifest.ts` |
| `patients.sex` | `text NOT NULL` — `'male'\|'female'\|'other'\|'unknown'` | `kernel/db/schema/patients.ts:55` |
| name snapshot anywhere | **none** — no `patient_name` column on any table; every document renders `patients.name` by live join | grep across all schema files |

**The last row is the phase's justification in one line.** It is also demonstrated in production by a competitor: Medanta's own reports print one patient's age three different ways across a single episode (`01-MEDANTA-TEARDOWN.md` P1).

---

## 3. Spike — questions written now, answered at kickoff

Answer by reading code and by read-only SQL against production. Record the answers in §6.3.

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | Of the 46 `user_actor_required` sites, how many are **desk-only by nature** (scanners, cashier sessions, approvals) versus **patient-reachable in principle** (read own record, book own slot)? | Sets T2's size. If the answer is "44 desk-only", T2 is an audit with two exceptions; if it is "30/16", it is a design task |
| **S2** | Does any route today rely on `actor.type === "user"` as a **proxy for authentication** rather than for staff-ness? | Any such site is a latent auth hole the moment a fourth type exists |
| **S3** | How many production patients have `sex = 'unknown'` or `'other'`? | Sizes the T4 backfill and tells us whether the split is cosmetic or load-bearing today |
| **S4** | Do the two shipped print surfaces — the e-Rx (`prescriptions.ts`) and the printed invoice (`billing.controller.ts`) — read demographics at render time or at issue time? | If either already snapshots, T6 has a precedent to follow rather than invent |
| **S5** | Which roles currently hold `patients.update` in production? | T5 must not silently grant them `confidential.write`; the count tells us how much role surgery the migration needs |
| **S6** | Is `patients.sex` read anywhere that would be **clinically wrong** if it became administrative gender? | Today there is no lab or dosing module, so the expected answer is "no" — recording it now is what makes the split safe to do cheaply |

---

## 4. Design decisions — what this plan rules beyond the spec

**DD1 — The fourth actor type is `patient`, and its default is REFUSE.** Adding a union member must not widen a single existing route. Every guard that today asks `actor.type !== "user"` keeps refusing a `patient` actor unless this phase explicitly opens it, and **this phase opens none** — 22c-B and 22c-C open them one at a time, each with its own test. The audit in T2 is therefore a proof of *non*-change, which is the only kind of proof that makes a union widening safe.

**DD2 — Assurance is an ordered ladder, stored as text, compared by an exported rank function.** `self_declared` (0) · `staff_verified` (1) · `id_verified` (2) · `abha_verified` (3). Not an enum type in Postgres: this project's precedent is open text enums with the values in a comment (`patients.sex`, `opdEncounters.type`), and a fourth level will arrive.

**DD3 — Identity versions are append-only and mint on Class I change only.** Class I is `name`, `dob`, `administrative_gender`, `abhaNumber`. A Class II contact change (phone, address) does not mint a version — versions exist to answer *"who was this person when the document was issued"*, and a phone number is not part of that answer. Every version stores the full Class I field set, not a diff, so the resolver is a lookup and never a replay.

**DD4 — RULED: `administrative_gender` is Class I; `sex` becomes Class III.** The split is R-05; what it did not say is which side is identity-bearing. **Administrative gender is the legal identity marker** — it appears on documents, it is what a patient has a NALSA right to change, and it is therefore versioned and amendment-gated. **Clinical sex is a clinical observation** — it drives reference ranges and dosing when those modules exist, and it corrects through the `entered_in_error` grammar that allergies already use, not through the amendment path. Getting this backwards would either obstruct a legal right or let a clinical value be rewritten as an identity correction.

**DD5 — The amendment path drops assurance rather than refusing.** S1-R3, locked. A Class I amendment on a record above `self_declared` without evidence of at least that level sets assurance to `staff_verified` and events the drop. Refusing instead would push clerks into re-registering, which is the duplicate path this whole programme exists to close.

**DD6 — The resolver is a function, not a join.** `resolveIdentityAt(db, patientId, at)` returns the Class I field set in force at `at`. Renderers call it; nothing reads `patients.name` for a document again. This phase converts the two shipped print surfaces (S4) and pins the behaviour with a test that reprints a document after an amendment.

**DD7 — Permission split, and no role gains anything.** `patients.confidential.write` and `patients.deceased.write` are new and are granted to **no existing role by the migration**. The runbook step that grants them is an owner act, exactly like every other Class-A grant. A phase that silently widened a privacy permission would be the defect this split exists to prevent.

**DD8 — No new registry kinds, no new module.** This is kernel work inside `patients` plus the `Actor` type. The department series closed registry kinds at ten and this phase does not reopen them.

---

## 4A. ROUTED TO THE OWNER — provisional, and named

**None.** Every decision this phase needs was locked in `06-RULINGS-LOCKED.md` before it was written, under the owner's standing instruction to decide on industry practice. The four items still open in that document (PACS, Pine Labs, concession ceilings, the batched counsel review) touch phases 22c-C and later, and **none of them blocks a task here.**

---

## 5. Tasks

Seven. Five CRITICAL. Each CRITICAL task carries an inline Assertion Book whose mutants are **built and executed**, per AGENT-RULES rule 21.

### T1 — Migration `0036`: assurance, administrative gender, identity versions, permission rows — **ROUTINE**

`patients.identity_assurance text NOT NULL DEFAULT 'self_declared'` — every existing row backfills to **`staff_verified`**, not the default: every patient in the master today was entered by a clerk. `patients.administrative_gender text` backfilled from `sex` for every row, then set `NOT NULL`. `patient_identity_versions` (append-only; the immutability trigger set, following the `receipts`/`allocations` precedent). Two permission rows.

**Files:** `kernel/db/schema/patients.ts`, `apps/core/drizzle/0036_*.sql`, `modules/patients/manifest.ts`.

### T2 — The `patient` actor type, and the audit that proves nothing widened — **CRITICAL**

`Actor` gains `"patient"` in `packages/contracts/src/envelope.ts`. Then the audit: all 29 `actor.type` readers and all 46 guard sites, each classified **desk-only** or **patient-reachable-later**, recorded as a table in §6.3. No route opens in this phase.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | A `patient` actor is refused by **every** existing guard site | Remove the `patient` case from one guard's refusal so it falls through to allow → a patient actor reaches a staff route |
| A2 | `bookAppointment` still throws `user_actor_required` for a `patient` actor | Widen the check to `!== "system"` → a patient books directly, bypassing 22c-C's hold machinery |
| A3 | `verifyQrScan` still refuses a non-`user` actor | Allow `patient` → a patient scans their own card and the confidential alias path is never exercised |
| A4 | The event envelope round-trips `type: "patient"` | Drop it from the envelope's union → events lose provenance silently |
| A5 | No route that used `actor.type === "user"` as an authentication proxy exists (S2) | If S2 finds one: mutate it to accept `patient` → an unauthenticated-equivalent actor reaches it |

### T3 — Identity versions, field classes, and the assurance ladder — **CRITICAL**

`resolveFieldClass`, version minting on Class I change inside `updatePatient`'s existing transaction, the assurance rank function, the upgrade path (staff actors only), and DD5's drop.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A6 | A Class I change mints exactly one version, inside the same transaction as `patient.updated` | Move the mint outside the transaction → a rolled-back amendment leaves an orphan version |
| A7 | A Class II change mints **no** version | Mint on every change → version noise makes the resolver ambiguous and the table unbounded |
| A8 | An unevidenced Class I amendment on an `id_verified` record leaves assurance at `staff_verified` (DD5) | Skip the drop → the stamp asserts a verification that no longer covers the field |
| A9 | Assurance never decreases except by A8, and never increases except by a staff actor | Allow a `patient` actor to upgrade → self-asserted identity verification |
| A10 | Versions are append-only | Attempt an UPDATE → the immutability trigger must refuse |

### T4 — Administrative gender split from clinical sex — **CRITICAL**

Backfill, then classify all 48 readers: **display, document and search surfaces read `administrative_gender`; clinical surfaces read `sex`.** Today no clinical reader exists (S6), which is exactly why the split is cheap now.

#### Assertion Book — T4

| # | Assertion | Mutant |
|---|---|---|
| A11 | Every existing row has `administrative_gender = sex` after `0036` | Skip the backfill → a NOT NULL violation, or worse, an empty gender on a printed document |
| A12 | Amending `administrative_gender` mints a version (Class I, DD4) | Classify it as Class II → a legal identity change leaves no trace and reprints wrong |
| A13 | Amending `sex` mints **no** version and follows the clinical-correction path | Classify it as Class I → a clinical correction is recorded as an identity amendment |
| A14 | A document rendered after a gender amendment shows the value **as of the encounter** | Point the renderer at `patients.administrative_gender` → the Medanta failure, reproduced exactly |

### T5 — The permission split — **CRITICAL**

`patients.confidential.write` and `patients.deceased.write` gate those fields in `updatePatient`. `patients.update` no longer reaches them. **No role is granted the new permissions by the migration** (DD7).

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A15 | An actor holding only `patients.update` is refused when setting `isConfidential` | Leave the field on `patients.update` → any clerk who can fix a typo can hide a patient from search |
| A16 | Same for `deceasedAt` | Leave it → any clerk can silence the notification gateway for a living patient |
| A17 | The migration grants the new permissions to **zero** roles | Grant to every holder of `patients.update` → the split is cosmetic and the phase achieved nothing |
| A18 | A confidential patient still requires an alias (the shipped `alias_required` rule) | Drop it → a confidential patient with no alias renders a blank name on public surfaces |

### T6 — `resolveIdentityAt`, and the two shipped print surfaces adopt it — **CRITICAL**

The resolver, plus conversion of the e-Rx and the printed invoice. Nothing else prints today.

#### Assertion Book — T6

| # | Assertion | Mutant |
|---|---|---|
| A19 | `resolveIdentityAt(p, t)` returns the version in force at `t`, not the current row | Return the current row → **the Medanta bug**: a reprint shows today's name and today's age |
| A20 | With no version at or before `t` (a patient registered before this phase), it returns the earliest version | Return null → every pre-`0036` document fails to render |
| A21 | A version minted at exactly `t` is in force at `t` | Use `<` instead of `<=` → an amendment and an issue in the same second render the wrong side |
| A22 | An e-Rx reprinted after a name amendment shows the name as issued, plus the amendment annotation | Read live → the phase's entire purpose is defeated and nothing fails loudly |
| A23 | Age on a document is computed from the encounter date, not the print date | Compute from `now()` → Medanta's P1, exactly |

### T7 — Routes, the amendment surface, and the e2e — **ROUTINE**

`PATCH /patients/:id` gains a reason class (an enum, never free text — series R-018) and optional evidence reference. A route for the assurance upgrade. The registration-desk and patient-detail screens surface assurance and the amendment reason. One e2e: register → amend → reprint → assert as-of-issue.

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 The spike answers, and the actor-audit table (S1–S6, T2)
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review
