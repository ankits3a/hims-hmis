# Plan 22c-E — Records and the account: what the patient carries, who may see it, and closing the door

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION.** Two rulings were taken at write time and are recorded where they bite: **the visit summary is a kernel-D document type issued on `consultation.completed`** (DD3, RULED — there is no summary artifact today, and Records promised one); and **the public verification page is kernel-D's, this phase ships only the patient's controls over it** (DD5, RULED — one code path, not two). Everything else is locked in [`../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md`](../brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md) §2 and §5.

**Roadmap:** Track C · milestone **M4** · `07-IMPLEMENTATION-PLAN.md` T6 and the patient side of T7. **Spec:** [`../specs/2026-08-10-hmis-architecture-design.md`](../specs/2026-08-10-hmis-architecture-design.md) §14 (confidential and sealed), §11.14 (DPDP, retention), §12 (portability). **Brainstorm:** `01-MEDANTA-TEARDOWN.md` §H (records, privacy, law — twelve cases); `10-REMAINING-SEGMENTS.md` S9. **Review:** [`reports/2026-08-28-patient-self-service-review.md`](reports/2026-08-28-patient-self-service-review.md) D11, G6, G9, G14, G16. **This plan argues from those and does not restate them.**

**Slot: gated on kernel-D (documents exist) and 22c-B (households and the accessible set exist).** It does not depend on M2 or M3 and may run before either.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT.** Six tasks, one migration, no workflow definition, no approval band. **Four CRITICAL** — every task that reads a record on behalf of a phone is a privacy seam, and the sealed-class exclusion has to be invisible, which is harder to test than a refusal.

Main session codes task by task under AGENT-RULES; mutants per rule 21; CI watched by full SHA; reviewers **FRESH, not resumed** (v3 §9.5, ledger §2.115).

### Stop-loss (v3 §6): **690,000 tokens**

`1.5 × 2 × 229,246 = 687,738 → 690,000` — two fresh review passes at Plan 14's mean pass ([`../pipelines/token-baselines.json`](../pipelines/token-baselines.json)); the review §5(h) derivation. Main-session cost unmeasurable (runbook **O3**).

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 7,000 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| `01-MEDANTA-TEARDOWN.md` §H only | ≈ 2,500 | 625 |
| **NOT pointed at:** the ledger in full | 377,112 | **94,278** |

---

## 1. Why this phase

The e-Rx on the phone the moment it is signed is *"the single most-wanted thing in any patient app"* (S7-09). This phase delivers it, with receipts and a visit summary, under the two rules that make it safe to deliver: an adult's records are theirs until they consent (R-09), and a sealed record produces **no count, no placeholder, no "hidden" label** (T6's exit test). It also closes the loop the verification portal opened: the patient sees who retrieved their document and can revoke a lost paper's code. And it gives the account a door out — *Close app account*, renamed from *delete* because DPDP erasure is not absolute against clinical retention (R-10).

Lab and imaging reports are **not** here. They are 22c-F, on Plan 17 and 18, and this phase's record list is built so they plug into it (DD2).

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff** (AGENT-RULES §6)

| fact | value | consequence |
|---|---|---|
| migrations | **36** on disk; this phase writes the next free number at kickoff | |
| the record sources today | prescriptions (`opd_prescriptions`: `patientId`, `version`, `lines`, FHIR `document`) · encounters (`opd_encounters`: `diagnosis`, `advice`, `followUpDays`, `icd10Code`) · receipts/invoices (`GET billing/receipts?patientId=`, `billing.controller.ts:253`) · the OPD timeline (`GET opd/patients/:patientId/timeline`, `opd-visits.controller.ts:234`) | **DD2** — three sources, one list |
| `consultation.completed` payload | `encounterId, patientId, departmentId, visitType, followUpDays, admissionAdvised, referralIssued, prescriptionCount, icd10Code` (`opd/events.ts:106-116`) | **DD3** — the trigger for the visit summary |
| **no visit summary exists** | nothing renders `diagnosis/advice` except the e-Rx body | Records promised one (07 T6) ⇒ DD3 |
| confidential read path | `getPatientSummaries` (`patients/registration.ts:326-356`): `restricted` unless `hasPermission(db, actor.id, "patients.confidential.read")` — **a user-id lookup** | Review D11: a `patient` actor is never a user ⇒ **DD1** |
| sealed class | `patients.sensitive_context` (`schema/patients.ts:70`); consumed by `guardians.ts:34` (messages off) and nowhere in a read list | **DD4** — the exclusion is built here, once, as a filter over the accessible set |
| guardian authority | `{ messages, consents, dsr, bills }` (`patients/guardians.ts:14`) — **`dsr` exists** as a flag | H7: the export is scoped by it (T5) |
| retention | `retentionEnabled` defaults **false** (`kernel/config.ts:173-176`); legal holds are rows (`schema/retention.ts`) | R-10's *"retained under law"* is the truthful sentence today: nothing is deleted at all |
| documents | kernel-D: `documents(doc_type, patient_id, sealed, code_version, …)`, `document_retrievals`, the public lookup, `reissueCode`/`revokeCode` | **DD5** |
| notify | patient-audience transactional templates exist (`kernel/notify/templates.ts:11-14`); the deceased hard stop is in the gauntlet | T2's "e-Rx ready" is a template |
| privacy notice | nothing — no versions table, no consent row for the app | **G16** ⇒ T1, T5 |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | How many production patients are `sensitive_context = true`, and how many of those share a phone with another patient? | If the second number is zero, A9's invisibility test runs on a fixture only; if not, it has a production shape to match |
| **S2** | What does the OPD `patientTimeline` return for a merged loser, and does it follow the chain? | H5: one continuous history. If it already follows the chain, T2 reuses it; if not, T2 fixes it there, not in a wrapper |
| **S3** | Is `document_retrievals.ip_hash` enough for *"who retrieved it"* (S9-15), or does the retriever have to type an identity on the public page? | Decides whether T4 shows *"retrieved 3 times"* or *"retrieved by Dr — , Apollo Lucknow"*. Recommend the former plus an optional free-text *"I am"* field — an identity claim on a public page is not evidence |
| **S4** | Which patient-actor guard sites did 22c-A's T2 audit classify *patient-reachable-later* under `patients.*`? | T2 opens exactly those and no others |
| **S5** | What is the p95 of assembling a Records list for a phone with **8 accessible patients** (S1-R2's cap) across the three sources? | The list must render on 2G (I2); if it needs a read model, this phase builds it before, not after, the reviewer says so |

---

## 4. Design decisions

**DD1 — A patient actor is "self" for its accessible set, and the confidential check is bypassed only for that set.** `getPatientSummaries` and every visibility reader learn one rule: for `actor.type === "patient"`, `restricted = !accessibleSet.has(patientId)` — never a permission lookup on an id that is not a user. A confidential patient sees their own name (DD6 of kernel-D, the same principle); a household member with `adult_pending` access sees nothing, including the name (22c-B A20).

**DD2 — One record list, three sources, one seam.** `listRecords(phone, filter)` composes prescriptions, visit summaries and receipts through a `RecordSource` interface `{ kind, list(patientIds, since), release }` that lives in the patients module. 22c-F registers lab and imaging as the fourth and fifth sources against the same interface. **The list is filtered by the accessible set before any source is asked** — a source never sees a patient id the phone may not.

**DD3 — RULED: the visit summary is a document.** A kernel-D `doc_type = 'visit_summary'` issued by an OPD consumer of `consultation.completed`, body = diagnosis, ICD-10, advice, follow-up, referral/admission flags, the prescribing doctor — as of that moment, snapshot demographics, its own number and code. It is the patient's own copy of what the doctor concluded, the thing they photograph today. It is **not** the consult note (Plan 07's record), and it is not amended when the encounter's fields are — it is reissued through kernel-D's amendment grammar if the doctor amends after the patient left (S7-05).

**DD4 — Sealed exclusion is a filter that returns fewer rows, and the API shape is identical either way.** No `hiddenCount`, no `restricted: true` rows, no placeholder — the response for a phone with one sealed and two open patients is indistinguishable from one with two patients. The exclusion is applied in one place (the accessible-set resolver) so no source can leak it by accident.

**DD5 — RULED: the public page is kernel-D's; this phase ships the patient's side of it.** *Who retrieved my document* (from `document_retrievals`), *reissue the code* (a lost paper, S9-14), *revoke*. No second lookup path.

**DD6 — Release on authorisation for the three sources here, and nothing else.** A prescription releases at `prescription.issued`; a visit summary at issue; a receipt at issue. There is no clinician hold in this phase because none of these three is a result. The `release` member of `RecordSource` exists so 22c-F's classes (the R-08 restatement in the review §2) plug in without touching this list.

**DD7 — "Close app account" closes the credential, not the record.** `patient_credentials.closed_at`; every session for that phone is invalid on the next request (22c-B DD2's property); household links the phone *owned* revert to `adult_pending` for the other members (they must re-consent to whoever next holds the number); the patient rows are untouched and the screen says so in the words R-10 locked. Re-opening is an OTP login plus the second factor (R-11) — a closed account is a dormant one.

**DD8 — The DPDP export is a document too.** `doc_type = 'dsr_export'`: machine-readable JSON (the FHIR bundle where one exists — prescriptions already store one) plus the record list, issued through kernel-D so it carries a number, a code, and the snapshot, and is itself logged. Scoped by `authorityDsr` when a guardian asks (H7). Rate-limited per phone (one a day) because it is the most expensive read the app has.

**DD9 — Privacy notice versions are rows; a material change re-consents at next login.** `privacy_notice_versions(id, version, material, published_at)`, `patient_consents(credential_id, version, at)`. A login under a newer *material* version shows the notice and records the consent before any read; a non-material version is recorded silently. `promotionalOptIn` stays where it is (`patients.ts:66`) and is surfaced, never pre-checked (H9).

---

## 4A. ROUTED TO THE OWNER

**None.** The image-retention window (🔒₹) belongs to 22c-F. S3 may make *"who retrieved it"* less specific than the brainstorm imagined; that is a finding, not a decision.

---

## 5. Tasks

Six. Four CRITICAL.

### T1 — Migration: credentials lifecycle, notice versions, consents, the source registry — **ROUTINE**

`patient_credentials.closed_at`, `privacy_notice_versions`, `patient_consents`, and nothing for records themselves (they are read models over shipped tables). Register FK-bearing tables in the patients truncate group (§3.12).

### T2 — The record list under the accessible set — **CRITICAL**

`RecordSource` (DD2), the three sources, the sealed filter (DD4), DD1's self rule in `getPatientSummaries`, merged-loser chain (S2), and the "e-Rx ready" template on `prescription.issued` to the patient's own phone only.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | A phone sees records only for patients in its accessible set, re-evaluated per request | Cache the set in the token → revocation waits for a logout (22c-B A21's sibling, on reads) |
| A2 | An `adult_pending` member's records **and name** are absent | Return the name with an empty list → the disclosure R-09 exists to prevent |
| A3 | A confidential patient sees their own real name (DD1) | Permission-lookup on the patient actor's id → they see `P-4821` on their own phone (review D11) |
| A4 | **A sealed patient in the household produces a response byte-identical to that patient not existing** (DD4) | Add `hiddenCount` or a placeholder → *"1 record hidden"* is the seal broken |
| A5 | A merged loser's records appear under the canonical patient, once | Ignore the chain → H5: history split across a frozen record |
| A6 | A source is never called with a patient id outside the filtered set | Filter after the fan-out → a source's own bug leaks a sealed record |
| A7 | The "e-Rx ready" message goes to the patient's own verified phone, never to a household member's, and respects the deceased stop | Send to every household phone → a wife's prescription on the husband's phone |
| A8 | A prescription is listed the instant `prescription.issued` commits (S7-09) | List from a nightly read model → the most-wanted feature arrives tomorrow |

### T3 — The visit summary document — **CRITICAL**

The OPD consumer of `consultation.completed` issues the `visit_summary` through kernel-D in the consumer's transaction; reissue on a post-visit amendment.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A9 | Exactly one summary per completed consultation, idempotent under consumer redelivery | No idempotency key → five deliveries, five documents, five numbers |
| A10 | The summary's demographics are the encounter's snapshot (kernel-D DD2) | Read live → the Medanta failure on the one document the patient keeps longest |
| A11 | A diagnosis amended after completion reissues an AMENDED v2; v1 is retained and its code still resolves | Overwrite → the patient's copy silently disagrees with the record |
| A12 | A summary for a sealed-context patient is stamped `sealed` at issue and never lists | Stamp from the current flag at read → a later un-seal exposes it |

### T4 — Verification controls for the patient — **ROUTINE**

*Who retrieved this* (S9-15, per S3's shape), reissue code, revoke code — three calls into kernel-D's T5, scoped to the accessible set. **No public route is added here** (DD5).

### T5 — Close app account, the DPDP export, notice consent — **CRITICAL**

DD7, DD8, DD9.

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A13 | Closing the account deletes no patient row, no document, no event | Cascade anything → R-10 is violated and clinical retention is broken by a button |
| A14 | Every session on the closed credential fails on the next request | Check at login only → the open tab keeps reading |
| A15 | Members whose access rode the closed phone revert to `adult_pending` | Leave links live → the next holder of the number inherits a family's records |
| A16 | The DSR export for a guardian includes only patients where `authorityDsr` is true | Export the whole household → a guardian with bill authority downloads a minor's sealed-class history |
| A17 | A login under a newer **material** notice version is blocked from reads until consent is recorded | Record silently → re-consent is fiction |
| A18 | The export is itself a document with a retrieval log | Stream bytes → the most complete disclosure the app makes is the only one unlogged |

### T6 — Routes, screens, and the e2e — **ROUTINE**

The Records tab (documents grouped by visit), the account screen, the notice interstitial. Two e2e: *consult completes → summary and e-Rx on the phone within one request → adult member pending sees nothing → consents → sees both*; and *sealed member present → list identical to absent → close account → every session dead → reopen by OTP + UHID*.

---

## 6. CLOSE

*(Filled by the executing session.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S5
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review — **and the M4 milestone close**
