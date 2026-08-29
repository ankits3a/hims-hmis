# Plan 22c-F — Reports and images: the record-source contract, the release classes, and the study on a phone

**Written 2026-08-28 on the build host. NOT APPROVED FOR EXECUTION — and, unlike every other document in this series, NOT EXECUTION-READY BY CONSTRUCTION.** Its two producers do not exist: `apps/core/src/modules/` holds no lab and no radiology module (Plans 17 and 18 are unbuilt), and the PACS is unchosen (O-1). This document is therefore a **contract phase**: it fixes the seam the two producers will publish through, the release vocabulary they will carry, and the two document types they will issue — so that when 17 and 18 are written they consume this rather than invent it. Its task list is real; its Files lists are written against tables that will be named by Plan 17/18 and are marked as such. **Re-measure everything at kickoff; expect §2 to be half wrong by then, and correct it in place.**

Two rulings taken at write time: **the release class is a property of the catalogue entry, and R-08 is restated as its default** (DD1, RULED — the review §2 argues it from the HIV Act 2017 and from the lab plan's own E1/E9/J3, which R-08 as locked would override); and **the portal obeys the lab's unpaid-report interlock for non-critical OPD reports** (DD2, RULED — reconciling two locked registers, review D15).

**Roadmap:** Track C · milestone **M5** · `07-IMPLEMENTATION-PLAN.md` T8/T9. **Department series:** [`../brainstorms/2026-08-27-department-series/02-central-lab-lims.md`](../brainstorms/2026-08-27-department-series/02-central-lab-lims.md) §3.1 (the result state machine: `verified → published → acknowledged`), §5 D2/D3 (the interlock), E1/E4/E9 (HIV, adolescent, genetic), J3 (sensitive-in-person); [`../brainstorms/2026-08-27-department-series/01-radiology-imaging.md`](../brainstorms/2026-08-27-department-series/01-radiology-imaging.md) WF-IMG-03 (PCPNDT, sealed), WF-IMG-09 (release to patient/third party under DPDP), the Orthanc + OHIF topology. **Brainstorm:** `00-RECORD-AND-PLAN.md` §5A.4 (what images cost); `10-REMAINING-SEGMENTS.md` S9. **Review:** [`reports/2026-08-28-patient-self-service-review.md`](reports/2026-08-28-patient-self-service-review.md) §2 (R-08), D15.

**Slot: gated on 22c-E (the record list and its `RecordSource` seam), kernel-D (the document types), Plan 17 (lab results exist), and — for T5/T6 only — Plan 18 and O-1.** T1–T4 can execute the day Plan 17's result table exists; T5–T6 wait for the PACS.

**Executor seed (v3 §1):** this document, [`../AGENT-RULES.md`](../AGENT-RULES.md), ledger §5 (lines 1132–1146). **Do not read [`reports/EXECUTION-LESSONS.md`](reports/EXECUTION-LESSONS.md) in full: 377,112 bytes ≈ 94,278 tokens, re-billed per tool call (v3 §9.1).** Entries that bite: §2.101, §2.115.

---

## THE LANE — ruled at write time, v3 §2

**LIGHT, in two halves that may execute months apart.** Six tasks, one migration per half, no workflow definition, no approval band. **Three CRITICAL** — the release engine (a clinical-safety and statutory seam), the lab report document (the NABL face), and the image path (a 300 MB object reaching a phone through a public-ish URL). If the two halves execute in different sessions, **each half is closed and reviewed on its own** — a half-phase with an open CLOSE is the §9.6 handoff failure waiting to happen.

### Stop-loss (v3 §6): **690,000 tokens per half executed, and the number is re-derived at each kickoff**

`1.5 × 2 × 229,246 = 687,738 → 690,000` at today's baselines. The half that lands after Plan 17 must re-read [`../pipelines/token-baselines.json`](../pipelines/token-baselines.json) — Plan 17 will have added rows and the mean pass may have moved. Main-session cost unmeasurable (runbook **O3**).

### Context budget (v3 §9.2)

| pointed at | bytes | ≈ tokens |
|---|---|---|
| this document | measure at kickoff | ≈ 7,500 |
| `AGENT-RULES.md` | 26,563 | 6,641 |
| ledger §5 only | ≈ 3,500 | 875 |
| lab doc §3.1 + §5 D/E/J only | ≈ 9,000 | 2,250 |
| **NOT pointed at:** the ledger in full, either department doc in full (98 KB and 92 KB) | — | **≈ 47,000 + 94,278** |

---

## 1. Why this phase

Lab reports are a rendering problem; radiology images are an infrastructure problem (§5A.4). This phase is written now, before either producer exists, for one reason: **the release decision and the document face must be fixed before Plan 17 is written**, or the lab module will decide for itself what reaches a phone at 11 p.m. and what a report looks like — and the portal will inherit those decisions instead of setting them. The competitor's document set shows what "each module decides for itself" produces.

The differentiator is images: the competitor destroys film at 90 days; we keep the study and the patient carries it. That is also the largest storage commitment the hospital will make, which is why it is the last thing in the programme and gated on a rupee figure.

---

## 2. Ground truth — measured 2026-08-28, **re-measure at kickoff and expect drift** (AGENT-RULES §6)

| fact | value today | what will have changed by kickoff |
|---|---|---|
| producers | **none** — `ls apps/core/src/modules/` → `billing formulary materials membership opd ot partners patients tariff` | Plan 17 adds `lab`; Plan 18 adds `radiology`. **Their table and event names replace every `<lab.*>` / `<rad.*>` placeholder below** |
| reserved grammar | `EPISODE_SERIES`: `lab_order: "L"`, `lab_specimen: "S"`, `radiology_order: "R"` (`kernel/episodes/series.ts`) with the order-vs-specimen distinction argued in place | Unchanged — this is the one thing already built for them |
| result states (planned) | `resulted → verified → published → acknowledged` (lab doc §3.1); `verified → published` is *"immediate unless interlock"* (§3.1 table) | Becomes code in Plan 17 |
| interlock (planned) | unpaid OPD report → *"print/WhatsApp blocked (locked)"*, override approval-gated `report.released_unpaid`; **never for ER/IPD; criticals publish and are phoned regardless** (lab doc D2, D3) | **DD2** |
| sensitive classes (planned) | HIV: consent event before collection, publish channel forced `in_person`; genetic: `sealed_class=true`; sensitive tests never auto-publish to WhatsApp (E1, E9, J3) | **DD1** — the vocabulary this phase names so Plan 17 stores it as data, not as three special cases |
| critical values (planned) | `critical_value_contact` P7 ladder, 15 min in-house, `lab_critical_calls` with read-back (lab doc §3.6, §4) | The NABL callback R-08 relies on — real, but for the panic list only |
| imaging release (planned) | WF-IMG-09: identity + authority verified, sealed class → DPO, formats incl. *DICOMweb share link time-boxed*, `document.release_logged`; obstetric USG template has **no foetal-sex field and lexical lockouts** (WF-IMG-03) | **DD5**, DD6 |
| PACS | **unchosen (O-1)**; recommendation Orthanc + OHIF, DICOMweb (QIDO/WADO/STOW) | The whole of T5/T6 |
| documents | kernel-D: `doc_type` with typed Zone C, `specimen` and `study` **declared with no issuer** (kernel-D DD11), `accreditation` slot, authorship triples | T3/T4 are the first issuers of those two types |
| the record list | 22c-E `RecordSource { kind, list, release }` | T1 registers two more |
| storage decision | 11b hybrid/on-prem open; nothing binary but `patient_photos` bytea | T5's derived series need a home — **the same open decision as M3 DD7** |

---

## 3. Spike — answered at kickoff, recorded in §6.3

| # | Question | Why it changes the work |
|---|---|---|
| **S1** | **What does Plan 17 store per test for release?** A `release_policy` column on the catalogue as DD1 asks, or the three special cases the department doc sketched? | If the column exists, T2 reads it; if not, T2's first commit is a Plan 17 migration adding it, and that is a disclosed cross-plan edit |
| **S2** | What is the shape of `<lab.result_published>` — per test, per order, per report bundle? | The portal lists *reports*, not tests; if publishing is per test, T3 assembles a bundle and needs a rule for the partial case (lab doc's *"partial report at 24 h"*) |
| **S3** | Does the interlock state live on the order (`lab_orders.interlock_state` in the sketch) and does it re-evaluate on `payment.received`? | DD2's obey-the-interlock is one read if yes; a subscription if no |
| **S4** | O-1: which PACS, and does it speak DICOMweb with a token we can mint per patient per study? | Without a per-study token there is no safe share link and T5 is a download, not a viewer |
| **S5** | Study sizes and counts from the first month of Plan 18: median and p95 MB per modality, studies/day | The derived-series budget (DD6) and the retention window (🔒₹) need real numbers, not §5A.4's ranges |
| **S6** | Can a derived JPEG series be produced *by the PACS* (Orthanc's preview/rendered endpoints) rather than by us? | If yes, T5 stores nothing derived and the storage question shrinks to the PACS's own |

---

## 4. Design decisions

**DD1 — RULED: `release_policy` is a property of the catalogue entry, and R-08 is its default, not its ceiling.** ∈ `immediate | clinician_first | in_person_only | never`. Defaults: `immediate` for everything; `clinician_first` for histopathology/cytology and first-positive infectious serology (HBsAg, anti-HCV, VDRL/TPHA); `in_person_only` for HIV (NACO; HIV Act 2017 counselling) and genetic; `never` for sealed classes (`sensitive_context`, PCPNDT). `clinician_first` is **bounded**: the report releases on the ordering clinician's release *or* at 72 h, whichever first — a hold, not a block, so the Cures-Act objection to information blocking does not apply and a clinician who forgets does not bury a diagnosis. The critical-value ladder is unchanged and orthogonal: a critical is phoned regardless of class. **The data lives in Plan 17's catalogue; this phase names the vocabulary and consumes it.** The locked register row R-08 should be amended to this sentence before this phase executes.

**DD2 — RULED: the portal obeys the interlock for non-critical unpaid OPD reports.** Two locked registers disagree (review D15); they reconcile because the lab's D3 already exempts criticals and ER/IPD. So: an OPD report with `interlock_state = unpaid` is **absent** from the phone (not "hidden", not "pay to view" — absent, DD4's rule from 22c-E) until payment lands, and the Records tab carries a plain *"unpaid investigations"* card from the dues machinery, which is the *dues nudge separated from release* that S9-02 asked for. A critical value is never withheld and is never the thing on the phone either — it is the phone call.

**DD3 — Report ≠ image; two artifacts, two release states.** A radiology **report** is a kernel-D document (`doc_type = 'imaging_report'`, Zone C = `study`) released under DD1 on sign. A **study** is a reference (`<rad.studies>.dicomweb_study_uid` + PACS id) released only after its report is released (S9-18: *an unreported scan is a diagnosis the patient will make themselves*) and never for a sealed class. A report may release while images are still processing.

**DD4 — Documents, not screens.** The lab report is issued through kernel-D at `<lab.result_published>` with Zone C = `specimen` (ordered / collected / received / authorised / specimen type / specimen no — the `S` number), the NABL mark in the accreditation slot **when the issuing discipline is accredited**, method, reference interval, the abnormal/borderline/normal legend, the *authorized by / performed by* triples. **No "not valid for medico-legal purposes"** (locked), no specimen-research small print (locked). Amendments reissue AMENDED through kernel-D DD7 — the NABL "original retained" rule is the component's, not the lab's.

**DD5 — The viewer is bought, the reference is ours, the pixels are the PACS's.** OHIF against DICOMweb, embedded, with a **per-study, per-patient, time-boxed token** minted by us and validated by the PACS proxy. We store `study_uid`, `series_count`, `modality`, `released_at`, `derived_ready_at`. No DICOM byte is ever copied into Postgres.

**DD6 — Two paths, one study: derived for the phone, full for the clinician and for download-on-request.** A derived JPEG series (key images + a thumbnail strip) for the portal's default view; full-fidelity DICOM behind a *download* that is logged as a release (WF-IMG-09) and rate-limited. S6 decides who makes the derived series. **Retention:** clinical retention per R-009; portal availability 3 years, retrieval-on-request beyond (locked, 🔒₹ pending the figure); the *link* dies with retention — a 410 with the retrieval-on-request path, never a 404 (S9-20).

**DD7 — Obstetric imaging inherits the PCPNDT lockouts, and the portal adds one.** The report template already forbids the field and the words (WF-IMG-03). The portal never surfaces an obstetric study's *images* to the patient before 20 weeks' gestation is irrelevant to it — it surfaces none until the report is released, and the report is the locked-down text. Nothing here weakens Plan 18's rule; this decision exists so nobody "helpfully" adds a key-image gallery for obstetric USG.

**DD8 — Every read of a report or study by the patient is a `document_retrievals` row.** Same table as the public portal, `channel = 'app'`. The patient can see their own retrievals; the DPO's access-vs-care-relationship report (H12) joins them.

---

## 4A. ROUTED TO THE OWNER — provisional, and named

- **O-1 — the PACS and its rupee figure.** Blocks T5/T6 only. Recommendation stands: Orthanc + OHIF.
- **The image retention window** (🔒₹) — the default above (3 years portal, then on request) stands until the owner names a number.
- **R-08's restatement (DD1)** — a locked-register amendment; the argument is statute and the lab plan's own text. Presented for ratification, not re-litigated here.

---

## 5. Tasks

Six, in two halves. Three CRITICAL. **Placeholders `<lab.*>` / `<rad.*>` are Plan 17/18's names and are replaced at kickoff.**

### Half A — reports (gated on Plan 17)

### T1 — Migration A: release state, the two record sources — **ROUTINE**

`record_release(id, source_kind, source_ref, patient_id FK, policy, released_at, held_until, released_by, reason)` — one row per report; the two `RecordSource` registrations (`lab_report`, `imaging_report`) in 22c-E's seam. If S1 says the catalogue lacks `release_policy`, the disclosed Plan 17 migration adding it lands here first. Patients truncate group (§3.12).

### T2 — The release engine — **CRITICAL**

Consumes `<lab.result_published>` / `<rad.report_signed>`; reads the catalogue's policy; writes `record_release`; runs the 72 h clock on `kernel/worker`; obeys the interlock (DD2); exposes `release(patientIds)` to the record list.

#### Assertion Book — T2

| # | Assertion | Mutant |
|---|---|---|
| A1 | An `immediate` report is listable in the same transaction its publish event commits | Release from a sweep → the R-08 promise arrives tomorrow |
| A2 | An `in_person_only` report **never** reaches `release(...)`, under any clock, for any actor | Let the 72 h clock release it → an HIV result on a phone; the HIV Act's counselling requirement bypassed by a timer |
| A3 | A `clinician_first` report releases on the clinician's action **or** at 72 h, whichever first | Drop the clock → a forgotten release buries a malignancy indefinitely |
| A4 | A `never`/sealed report produces no row, and its absence is invisible (22c-E DD4) | Write a row with `policy=never` and filter at read → one bug away from disclosure |
| A5 | An unpaid OPD report is absent; the *same* report becomes present on `payment.received` with no other action (DD2) | Ignore the interlock → the lab's locked rule is overridden by the portal |
| A6 | A critical value's telephone ladder is untouched and un-gated by any policy here | Route criticals through `clinician_first` → a panic potassium waits 72 h for a portal rule |
| A7 | An ER/IPD report ignores the interlock (lab D3) | Apply it → an inpatient's report is withheld over a bill not yet raised |

### T3 — The lab report document — **CRITICAL**

The `lab_report` issuer through kernel-D (DD4): the specimen zone, accreditation, method, reference interval, legend, authorship. Amendment via kernel-D.

#### Assertion Book — T3

| # | Assertion | Mutant |
|---|---|---|
| A8 | The report's demographics are the encounter snapshot; a name amended between collection and authorisation prints the **encounter's** name (kernel-D DD2) | Snapshot at issue → P1 on a lab report, reproduced |
| A9 | The NABL mark renders only when the issuing discipline's accreditation is set | Print it on every report → a false accreditation claim on an unaccredited discipline |
| A10 | Reference interval is the one the result was verified against, stored in the body, not re-read from the catalogue | Re-read at print → a changed range makes a normal result print abnormal |
| A11 | "Not valid for medico-legal purposes" does not exist as a string in the renderer or its i18n keys | Add it → locked J10 violated; the test asserts absence (the `rx.signature` precedent) |
| A12 | An amended report is a new document version; the original's code resolves with the banner | Overwrite → NABL's retention rule broken |

### T4 — Records integration and the e2e (half A) — **ROUTINE**

Reports grouped by visit in the Records tab; the *unpaid investigations* card; *e2e: order → publish → immediate report on the phone → a `clinician_first` report absent until the clinician releases → an HIV item never present → amend → v2 AMENDED, v1 retained*.

### Half B — images (gated on Plan 18 and O-1)

### T5 — Studies: reference, token, viewer, derived series — **CRITICAL**

DD5, DD6 against the chosen PACS. **The Files list is unknowable until O-1 is answered and is written at kickoff.**

#### Assertion Book — T5

| # | Assertion | Mutant |
|---|---|---|
| A13 | A study is listable only after its report's `record_release` row exists (DD3) | List on `study.stored` → S9-18: an unreported scan on a phone |
| A14 | The viewer token is per study, per patient, time-boxed, and validated by the proxy on every request | A per-patient token → one leaked link opens every study; a per-study token with no expiry → forever |
| A15 | A 300 MB study opens on the phone without the phone downloading 300 MB (the derived path) | Serve WADO full-fidelity by default → the differentiator is unusable on 4G |
| A16 | Full-DICOM download is a logged release (`document_retrievals`, WF-IMG-09) and rate-limited | Unlogged → the DPO's report is blind to the largest disclosure the app makes |
| A17 | No DICOM byte is written to Postgres | Cache a series in `bytea` → the database is the PACS by accident |
| A18 | A study past portal retention answers 410 with the on-request path | 404 → S9-20's support ticket |
| A19 | An obstetric study exposes no key-image gallery (DD7) | Add one → the PCPNDT lockout on text is bypassed by pictures |

### T6 — Records integration and the e2e (half B) — **ROUTINE**

Studies under their reports; *e2e: report released → study listable → derived view on a throttled connection → full download logged → retention lapse → 410*.

---

## 6. CLOSE

*(Filled by the executing session — one CLOSE per half if they execute apart, each with its own review.)*

### 6.1 The commits
### 6.2 Findings
### 6.3 Spike answers S1–S6 — S1 (does the policy column exist) and S4 (the PACS token) decide the shape of both halves
### 6.4 The Assertion Book, corrected by execution
### 6.5 Mechanical verification
### 6.6 The independent close review — **and the M5 milestone close**
