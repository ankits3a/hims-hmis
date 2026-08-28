# Plan 07a — The read gate: confidentiality on the OPD read routes, and an access log

**Status:** AUTHORED 2026-08-28, NOT APPROVED FOR EXECUTION. **Recommended to run before 07b/07c/07d.**
**Next free migration: 0038** — T3 takes it. T1 and T2 need none.

**This is a security remediation, not a feature.** It was found while auditing for the dashboard
work and is written up separately because folding a confidentiality fix into a UI phase is how such
fixes get deprioritised.

---

## 1. The finding

### 1.1 A registration clerk can read a confidential patient's diagnoses

`GET /opd/patients/:patientId/timeline` → `patientTimeline` (`modules/opd/encounters.ts:307`)
returns, per past encounter: `serviceDate`, `status`, `visitType`, `doctorId/Name`,
`departmentId/Name`, **`diagnosis`**, **`icd10Code`**, `prescriptionLineCount`, `dangerFlagged`.

It is guarded by `@RequirePermission("opd.visits.read", "hospital")` and nothing else. It resolves
the patient with `resolvePatientId`, which is merge-chain mapping documented as *"no gate"*. Its
`actor` parameter is threaded in from the controller and **never referenced in the function body**.

`front_office` holds `opd.visits.read` (`scripts/seed-roles.ts`, the `front_office` block). So a
registration clerk who does **not** hold `patients.confidential.read` can read a confidential
patient's full diagnosis history — while `GET /patients/:id` correctly 404s that same patient for
that same clerk, because `getPatient` existence-hides them.

**The confidential flag currently protects the name and hides the diagnoses from nobody.** That is
the wrong way round: the diagnosis is the more sensitive fact.

### 1.2 It is a class, not an instance

`GET /opd/visits/:id/vitals` → `listVitals(this.db, id)` takes a raw id and **no actor at all**.
The per-visit prescription read is the same shape. Both are gated only by `opd.visits.read`.

### 1.3 The fix already exists next door and was never carried across

Plan 11h's close caught exactly this in the appointment search lane. The test still carries the
reasoning verbatim (`modules/opd/search-providers.test.ts`, *"A @patient CHIP MUST NOT BYPASS THE
SEALED CLASS — the id is not a capability"*):

> INDEPENDENT REVIEWER, Plan 11h close — CRITICAL 1, the OPD half. A clerk holding
> `opd.appointments.read` and not `patients.confidential.read` could read a confidential
> patient's appointment dates, doctor, department and status by passing an id they already had.
> The text lane was gated; the chip lane was not.

Search was fixed. The OPD read routes were not, and **there is no confidentiality test on the
timeline** — `encounters.test.ts:293` tests only merge-chain spanning and ordering.

### 1.4 PHI reads are effectively unaudited

`recordOpened` is called from exactly one place in the entire web app —
`components/command-palette.tsx:137`. A patient reached from the OPD queue, an appointment list,
the consult screen or a direct URL leaves **no access-log row of any kind**. `search_audit` records
that someone searched and, if they clicked through, which record they opened from that one search.
Nothing records what was then read.

### 1.5 Break-glass is fully built and completely inert

`break_glass_grants`, the guard check in `kernel/auth/guards.ts`, `POST /auth/break-glass`, the
pending list and the mandatory after-the-fact review all exist. **`breakGlassBypass: true` appears
on zero production routes.** As shipped it grants nothing to anyone, so there is no lawful path for
a clinician who legitimately must read a sealed record in an emergency — they either have the
permission or they do not.

### 1.6 No care-relationship check exists on any read

`requireTreatingDoctor` (`modules/opd/consultation.ts:50`) is a real check — *"only the encounter's
OWN doctor may start, note, complete or prescribe"* — and it gates **writes only**. Every read path
is a flat hospital-scope permission. Any holder of `opd.visits.read` / `patients.read` may browse
any non-confidential patient's timeline, vitals, prescriptions and allergies, whether or not they
have ever treated them, leaving no trace.

---

## 2. Design decisions

**DD1 — Gate at the read function, not the controller.** The controller already passes `actor`;
the function ignores it. Fixing it in the controller would leave every future caller unprotected.
`patientTimeline`, `listVitals` and the prescription reads each resolve the patient through the
same confidentiality decision `getPatient` uses, and return not-found — never a partial row and
never a distinguishable error, because a different error is itself the leak.

**DD2 — Existence-hiding, matching the precedent.** A caller without `patients.confidential.read`
gets the same answer for "sealed patient" and "no such patient". This is what `getPatient` already
does and what the search provider already does; a third behaviour would be a third thing to reason
about.

**DD3 — Access is logged, not blocked.** Blocking clinical reads is how people get hurt. A read
inside a treating relationship is logged quietly; a read outside one is logged, flagged, **and the
reader is told at the moment they do it**. Being told is most of the deterrent, and it converts an
invisible act into a decision the person owns.

**DD4 — The access log is its own stream.** Not `events` (business facts, and it has no `actor_id`
index), not `search_audit` (query-scoped, 90-day retention, deliberately not legal-hold-clamped).
A PHI read log answers a different question and has different retention and hold rules.

**DD5 — Break-glass gets its first route.** The sealed-record read path opts in, so a clinician who
must see a sealed record can, with a reason, time-boxed, and reviewed afterwards by a human. Wiring
it here is what turns the existing review queue from decoration into a control. **Search deliberately
still does not honour it** — that was ruled a privilege-escalation bug once already and stays ruled.

**DD6 — No change to who holds what.** This phase grants no permission and revokes none. It makes
the existing grants mean what they were always documented to mean.

---

## 3. Tasks

Three. **All CRITICAL.**

### T1 — Confidentiality on the OPD read routes — **CRITICAL**

`patientTimeline`, `listVitals`, per-visit prescription reads. Carry Plan 11h's reasoning across.

| # | Assertion | Mutant |
|---|---|---|
| A1 | A caller without `patients.confidential.read` gets not-found for a sealed patient's timeline | Return the rows → the finding ships unfixed |
| A2 | Sealed and non-existent are **indistinguishable** — same status, same body | Return a distinct error → the error is the leak |
| A3 | A caller WITH the permission still reads normally | Over-gate → clinicians lose access to sealed records and route round the system |
| A4 | The same holds for vitals and prescriptions, not just the timeline | Fix only the timeline → §1.2 says it is a class |
| A5 | The merge chain is still spanned for a permitted caller | Gate by dropping the chain → a merged patient's history silently truncates |

### T2 — The PHI access log — **CRITICAL** · migration `0038`

One row per patient-record read: actor, patient, what was read, when, whether a treating
relationship existed, and the reason where one was required.

| # | Assertion | Mutant |
|---|---|---|
| A1 | Every read path writes a row, not just the palette | Log at the palette only → §1.4 unchanged |
| A2 | A logging failure never fails the read | Make it blocking → a log outage becomes a clinical outage |
| A3 | Out-of-context reads are marked at write time | Compute it later → the relationship at read time is unrecoverable afterwards |
| A4 | The log is legal-hold aware | Prune under hold → the record needed for the investigation is the one deleted |

### T3 — Break-glass wired, and the reader told — **CRITICAL**

The sealed read path opts into `breakGlassBypass`; the UI states plainly, before the read, that an
out-of-context or sealed access is recorded and reviewed.

| # | Assertion | Mutant |
|---|---|---|
| A1 | A sealed read succeeds only with an active, unexpired grant for that patient or hospital-wide | Accept any grant → break-glass becomes a master key |
| A2 | The grant is reviewable and appears in the pending queue | Skip the event → the review queue stays empty and the control is theatre |
| A3 | The reader sees the notice **before** the read completes | Show it after → it is a receipt, not a deterrent |

---

## 4. CLOSE

- [ ] §1.1 reproduced against a seeded confidential patient **before** the fix, and refuted after
- [ ] A confidentiality test exists on each of the three read routes (there is none today)
- [ ] Access log written from every read path, verified by an e2e that reaches a patient from the
      queue rather than the palette
- [ ] Break-glass produces a reviewable grant and the pending queue is non-empty in the test
- [ ] No permission granted or revoked by this phase
- [ ] Named in the close: `opd_queue_entries` has no actor columns (07c T6 covers the session half);
      care-relationship gating on reads is *logged*, not enforced (DD3) — the owner should know that
      is a deliberate choice
