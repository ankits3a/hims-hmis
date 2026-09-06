# Phase 18a-iii — Contrast, the bedside, and the study that came from outside (Radiology series, 4 of n)

**Authored 2026-09-05 in lane `radiology`. NOT APPROVED, NOT EXECUTED.** §0 is a gate on execution
and should be read before anything else in this document.

---

## 0. WHAT IS ACTUALLY DEPLOYED — measured, after this section said the opposite

**An earlier draft of this section claimed 18a, 18b and 18c were all code-complete and none
deployed, and recommended holding execution until they shipped. That was WRONG on two of the
three,** and it was wrong in the way this repository has been bitten by all week: it inherited
"NOT DEPLOYED" from phase-doc tails and memory written when it was true, and did not measure.
The orchestrator challenged it with a file count; the measurement below is what settled it.

Measured against the deployed base commit `c11833d`:

| plan | in the deployed base? | evidence |
|---|---|---|
| **18a — radiology core** | **YES** | `0047_radiology_core.sql`, plus `gates.ts` and `acquisition.ts` |
| **18b — DICOM seams** | **YES** | `0053_study_uid_unique.sql`, `0054_image_views_pacs_settings.sql`, plus `mwl.ts` |
| **18c — AERB registers** | **NO** | no `aerb/*` at all; none of `0060`–`0065` |

`c11833d` carries 56 migration files against main's 70, and is 51 commits behind main.

**So the foundation this phase builds on is deployed and has been exercised by a real department.**
18a-iii reads 18a's contrast columns, 18a's safety gates and 18b's `imageSource` vocabulary — all
of them in production. **It touches nothing of 18c's**, so 18c's own deploy blocker (a human
entering AERB certificates, runbook §0) does not gate this phase at all.

**There is therefore no sequencing gate on executing this**, and the earlier recommendation to wait
is withdrawn. What remains true, and is worth carrying rather than dropping with the error:

- **18c is genuinely unverified in production** and must not be deployed until the licence data is
  entered. Nothing here depends on it; if a later slice does, that slice inherits the gate.
- **The deploy backlog is real but is not this phase's problem to solve.** Production sits 51
  commits and 14 migrations behind main. That is worth the owner's attention as its own decision —
  "build more, or ship what exists" — and it is in his file as one. It is not an argument against
  building a phase whose foundations are already live.

**One caveat kept deliberately:** "present in the deployed base commit" is strong evidence, not
proof of what the production DATABASE has applied. The authoritative test is the applied-migration
count read from production, which this lane does not read. If that count disagrees with the table
above, the table is what is wrong.

---

## 1. Why this phase

18a shipped the order, the schedule, the safety gates, the acquisition and the report. 18b gave it
PACS seams. 18c gave the hospital its radiation-safety registers. **What none of them built is what
happens to the PATIENT around the scan**: the contrast that goes into an arm and occasionally
causes a reaction, the study performed at a bed because the patient cannot come to the machine, and
the film that arrives from another centre and has to be readable beside our own.

Each is named in 18a's own out-of-scope list as this phase's, and one of them — the outside-study
register — is a stated blocker on a decision 18b already shipped (`imageSource: "outside"` is in the
enum with nothing behind it).

---

## 2. Ground truth — measured 2026-09-05 at `3e1c59d`, re-measured unchanged at `5592599`; re-measure again at kickoff

| fact | measured |
|---|---|
| modules installed | `aerb billing formulary lab materials membership opd ot partners patients pcpndt pharmacy radiology tariff` — **no quality/incident module, no ED module** |
| the scheduler census | **`THE_SIXTEEN`** in `scheduler.test.ts` — not thirteen. 18a and 18c both say "the thirteen-job census"; 17a added two and 07c one since |
| contrast on the study | `contrast_given`, `contrast_agent`, `contrast_volume_ml` already columns on `imaging_studies`, under `imaging_studies_contrast_ck`. The schema comment says in as many words: *"A contrast agent nobody gave, or a volume with no agent, is a row 18a-iii cannot interpret."* 18a left this phase a typed seam |
| `imageSource` | `IMAGE_SOURCES = ["pacs", "no_pacs_images", "outside"]` — **`outside` is already legal and has no register behind it** (18b D8 defers it here by name) |
| report versioning | `prelim / draft / signed / amended / superseded` exists, with amend inserting v(n+1) in one transaction. **Addenda may already be covered by amend** — spike it before building anything |
| `incident.reported` | exists, and is **owned by `ot`** (`modules/ot/events.ts`, DD7: *"the OT-local incident record, until the quality module (28a) subscribes to it"*). There is **no hospital-wide incident or ADR register**, and 28a is unbuilt |

**The last row is the one that shapes this phase.** A contrast reaction is an adverse drug event and
an incident; the brainstorm's §1 boundary table sends both to a quality pack that does not exist.

---

## 3. Spike — answered by reading at kickoff, 0 subagents

1. **Does `amend` already give us addenda?** If v(n+1) `signed` with a reason is what an addendum
   is, this phase writes no report code at all. Read `report lifecycle` in 18a's doc and the amend
   transaction. **If yes, say so and delete the task** rather than building a synonym.
2. **Does `materials`/`pharmacy` expose an issue→consume seam a contrast vial can ride today**
   (P3, `material.issued` → `material.consumed`), or does the vial have to be a radiology-local
   fact for now? Read `modules/materials/index.ts` only.
3. **Is there any portable/bedside notion in `radiology` already?** `portable` and `bedside` appear
   in `views.ts` and `kinds.ts`; confirm whether that is a real concept or a comment before
   designing one.

---

## 4. Design decisions — DECIDED; none is money, procurement or law

- **D1 — The contrast reaction is RECORD-ONLY and emits an event nobody consumes yet.** This is
  18c's D9 posture, taken for the same reason: the hospital-wide incident and ADR registers belong
  to the quality pack (28a) and it does not exist. Radiology records the reaction on its own table
  and emits `imaging.contrast_reaction`; when 28a arrives it subscribes. **Radiology must NOT write
  into `ot`'s incident table** — that table is OT-local by its own docstring, and reaching into it
  would make the hospital's incident register a thing `ot` owns by accident of shipping first.
- **D2 — The reaction WRITES the patient's allergy, and that is the one thing it is not record-only
  about.** 18a's `prior_contrast_reaction` gate READS the patients module's allergy list and 18a's
  out-of-scope note says *"the reaction that WRITES that allergy is the follow-on's."* This is that
  write. A reaction recorded in radiology and invisible to the next CT's gate is the defect this
  whole chain exists to prevent, so the allergy write is in the same transaction as the reaction
  record — not an event, not a later consumer.
- **D3 — Severity is a closed vocabulary and the ladder is clinical, not administrative.**
  `mild | moderate | severe` on the ACR shape (nausea/urticaria · bronchospasm/hypotension needing
  treatment · cardiac arrest/anaphylaxis). Severity decides what the record REQUIRES (a severe
  reaction demands the managing clinician and the treatment given), never who may record it — a
  radiographer at 02:00 records what happened.
- **D4 — A portable study is the SAME study with a place, not a second kind.** It hangs off the
  existing `imaging_studies` row with a bedside location and the ward's request; there is no
  parallel table and no second workflow definition. The temptation is a `portable_studies` table,
  and it would fork every report, bill and register query in the module.
- **D5 — The outside-study register is a RECORD OF A DOCUMENT, not an image store.** A study done
  elsewhere enters as provenance — centre, date, modality, accession if any, and how the images
  arrived (film / CD / link / none) — so a radiologist reporting on it and a clinician reading that
  report can both see it was not ours. **No file upload in this phase**; the DPDP and storage
  questions belong with PACS tiering (18b-ii), and a half-built upload is worse than a citation.
- **D6 — An outside study is never billed as a performed study.** It has no acquisition, so it
  posts no charge. If the hospital charges a reporting fee for reading an outside film, that is a
  tariff row and a MONEY decision — parked in §7, not assumed here.
- **D7 — The two automations this phase adds are CHASERS, and they escalate to a human, never to a
  status.** Critical Chaser (a flagged critical finding unacknowledged after its SLA) and Unread
  Watchman (a signed report nobody opened). Both raise an alert row and emit; neither changes a
  study's status, cancels anything, or pages a rota. 18a made those SLAs record-only on purpose;
  this phase gives them a voice, not teeth. **Census `THE_SIXTEEN` → `THE_EIGHTEEN`, and the number
  moves in the same commit as the jobs** (`jobs.ts`, `scheduler.test.ts`, and the census array's
  spelled-out name — see `manifests.test.ts`'s convention and the T6 fix that made it self-checking).

---

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · The contrast administration record
The vial, the agent, the volume, the route, who gave it, when. Hangs off the study; validates
against the existing `imaging_studies_contrast_ck` rather than duplicating it. Spike answer (§3.2)
decides whether the vial rides `materials` or is radiology-local for now.

### T2 — CRITICAL · The reaction, the allergy write, and the record-only incident
D1/D2/D3. A reaction row, the patient-allergy write in the SAME transaction, and
`imaging.contrast_reaction` emitted for a consumer that does not exist yet. **The test that matters
is the loop:** record a severe reaction, then start a new contrast CT for that patient and prove
`prior_contrast_reaction` now refuses. A reaction that does not reach the next gate is the defect.

### T3 — ROUTINE · The portable / bedside study
D4. Ward request → a study with a bedside place → acquisition at the bed. The chaperone and
Form F rules that already apply to a USG apply here unchanged and MUST be shown to — a portable USG
on a ward is exactly the case §11.19-C-6 widened Form F to cover.

### T4 — ROUTINE · The outside-study register
D5/D6. Provenance in, `imageSource: "outside"` finally meaning something, and the report surface
labelling it so no reader mistakes it for ours. Closes 18b's D8 deferral.

### T5 — ROUTINE · The two chasers, and the census moves with them
D7. Critical Chaser and Unread Watchman as scheduler jobs; `THE_SIXTEEN` becomes `THE_EIGHTEEN` in
the same commit, along with the spelled-out count in every place that states it.

---

## 6. Out of scope — named so nobody infers them

- **The release desk (WF-IMG-09) — OUT, and it is BLOCKED ON MONEY.** Film and CD prices are owner
  ruling O-4 and 18a explicitly left the tariff rows here. Build it when O-4 is ruled; it is
  otherwise ready and is the most obviously missing counter surface.
- **Teleradiology send-out (WF-IMG-10)** — O-1 plus a signed DPA. Law and procurement.
- **KPI registrations** — Plan 21's registry does not exist.
- **Downtime kit** — Plan 30.
- **Emergency clocks (WF-IMG-07)** — needs an ED module; 40/46 are unbuilt.
- **Prep / recall messaging** — waits on the template language set (K1).
- **Image upload for outside studies** — D5; belongs with 18b-ii's storage tiering.
- **The hospital-wide incident and ADR registers** — 28a's. D1 is the seam, not a substitute.

---

## 7. Owner rulings — money, procurement, law

- **O-4 (money) — film, CD and outside-read prices.** Blocks the release desk entirely and D6's
  reporting-fee question partially. Recommendation on file in the brainstorm §13: film-free default,
  CD ₹150, film ₹250/sheet, MLC/police copies free.
- **O-1 (procurement + law) — teleradiology standby contract and DPA.** Blocks WF-IMG-10.
- **Sequencing (§0)** — whether to execute this before 18a/18c are deployed. Not a code question.

---

## 8. CLOSE — filled at execution

---

## 8. CLOSE — the review, run 2026-09-06 over T1–T5 as one combination

**All five tasks are merged** (#102, #105, #107, #108, #132). This is the review nobody had run: nine
merges reviewed individually, never as a series. Method: §5A's cheap steps, plus the reachability
scan the commissioning walk suggested, plus the asymmetry scan. **Everything below was found by
reading and by driving a real stack; the suite was green throughout and stayed green.**

`wc -c` on this document: **12,484** — well under §5A.2's ~50k-token archive threshold, so no handoff
split was needed.

### 8.1 The contract pass (§5A.1) — D1–D6, clause by clause. ALL CONFIRMED.

There is no CONTRACT section in this document, so §4's decisions were read as the phase's
commitments. Each was checked against shipped code, not against its own task's tests.

| decision | verdict |
|---|---|
| D1 reaction is record-only, emits `imaging.contrast_reaction`, no consumer | **confirmed** — nothing writes `ot`'s incident table |
| D2 the allergy write is in the SAME transaction | **confirmed, and stronger than the prose** — `imaging_contrast_reactions.allergy_id` is `NOT NULL`, so a reaction that wrote no allergy is a row the database cannot hold |
| D3 severity is closed, and decides what the record REQUIRES | **confirmed** — `severe` without both `treatmentGiven` and `managingClinicianId` is refused |
| D4 a portable study is the same study with a place | **confirmed**, and the rule is one-directional on purpose |
| D5 the outside study is a record of a DOCUMENT | **confirmed** — no upload, provenance only |
| D6 an outside study is never billed and logs no dose | **confirmed** — `registerOutsideStudy` never calls `recordAcquired`, so neither the dose write nor the bill decision is reachable |

**D2's chain was verified end to end rather than at its endpoints**, because that is where this
repository's phase defects live. The reaction writes `"<agent> (contrast media)"`; `isContrastAllergen`
matches against `CONTRAST_ALLERGEN_TERMS`, whose **first entry is `"contrast"`**. So the loop holds for
any brand, including one no term list has heard of — which is the argument `reactions.ts` makes for
itself, and it is true.

### 8.2 F1 — CRITICAL: the series shipped no user interface at all

**`apps/web/src` appears in none of the five commits.** Measured across the whole series:

| shipped | web callers |
|---|---|
| `POST` / `GET /radiology/studies/:id/contrast` (T1) | **0** |
| `POST /radiology/studies/contrast-reactions`, `GET …/:id/contrast-reactions` (T2) | **0** |
| `bedsideLocation` on the schedule body (T3) | **0** |
| `POST /radiology/studies/:id/outside` (T4) | **0** |

T5 is the exception and it is reachable: its two chasers raise alerts that the bell renders, because
the bell prints a server-supplied `title` rather than a per-kind locale key.

**The clinical consequence is precise.** 18a's `prior_contrast_reaction` gate reads the allergy that
T2's route writes — §8.1 confirms that loop is correct at every link. **It cannot be entered.** A
radiographer who watches a patient react to contrast has nowhere to record it, so the next CT's gate
sees nothing. The loop exists at both ends and has no middle.

### 8.3 F2 — MAJOR: the bedside study is unreachable twice over

Beyond having no web caller, `resolveBedside` refuses any device whose `attributes.portable` is not
`true` — and **nothing writes that attribute**: not `seed:radiology`, not any route, not any screen.
`DEVICE_PORTABLE_ATTRIBUTE` is declared, read once, and never set. T3 cannot be exercised on any
deployment by any supported means.

### 8.4 F3 — MAJOR: three documents instructed an act with no door (**fixed, #147**)

`seed-radiology.ts` claimed a hospital adds a second CT "through the resources screen"; there is
none, and no create route. `radiology-go-live.md` §5 and `standup-check`'s `radiology_device_present`
**fix text** repeated it — a census row whose remedy could not be performed.

### 8.5 F4 — MAJOR: ten refusals named a ULID (**fixed, #145**)

#138 made the AERB licence refusal name the machine. A census of `device ${` then found **eleven
sites, of which #138 had closed one** — an instance fix where a sweep was owed, caught against this
lane's own change from three hours earlier. Nine of the ten cost nothing (the row was already read
or already locked). `mwl.ts`'s remaining one is a **PHI-access audit reason** and was deliberately
left: a ULID is the correct identifier in an audit record.

**The suite noticed none of it** — 33 suites passed with ten sentences rewritten, because every
assertion checked `code` and none read the prose.

### 8.6 F5 — MINOR: a correct refusal whose remedy is impossible

Recording contrast on an outside study is refused *"open and clear [the contrast consent gate] before
administering"*. Check-in on an outside study is refused `bad_transition`, so **the advice is a dead
end**. The true reason is that the study was performed elsewhere and we administered nothing. Not
fixed; recorded.

### 8.7 The seams that came back CLEAN, which is worth recording

A close review that only lists defects cannot be calibrated. Each of these was a hypothesis driven
against a running stack and **refuted**:

- **Contrast on an outside study** — blocked in both directions (consent gate absent; and
  `registerOutsideStudy` refuses a checked-in study outright: *"an outside study is registered before
  anything else happens to it, because nothing else is going to"*).
- **The modality worklist** excludes outside studies — `MWL_STATUSES` cannot include `acquired`.
- **The unread-report chaser** scopes on `imagingReports.status = 'signed'`, so it correctly chases a
  radiologist's report on an outside film.
- **The worklist's `Unread` tab** means `acquired | reported`, so a published study correctly leaves it.

### 8.8 What the close did NOT do

**No second pass.** §2.140's method briefs a fresh reviewer at the fixes, and the lane's own history
says that pass found 15 of 16 fixes incomplete. This close had one reviewer and the fixes in §8.4 and
§8.5 have not been re-reviewed by anybody else. **F4 is itself the evidence for why that pass
matters** — it was an incomplete fix, found only because a census was run against it.

**§5A.3 is vacuous here and that is the finding.** It asks for one assertion over the assembled
artifact, driven through a full cycle. There is no assembly: the series wired nothing into a screen.
