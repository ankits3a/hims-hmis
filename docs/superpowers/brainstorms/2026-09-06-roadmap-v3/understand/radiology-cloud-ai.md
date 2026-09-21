# radiology-cloud-ai — mission pillar 3a mapped to what exists (read-only, 2026-09-06, main-ro @ b04cbd9)

Paths are relative to the read-only checkout of `origin/main`. "Deployed" is judged against the deployed base
`c11833d` named in CONTEXT.md (56 migration files: `git ls-tree c11833d apps/core/drizzle/` — carries `0047`,
`0053`, `0054`; does NOT carry `0060`–`0065`). See Surprises #2 for the conflicting claim that production went
out on `399f92c`; this agent cannot read production and does not resolve it.

## 0. The one-line reconciliation

The mission says *"replace in-house PACS servers … transmitting imaging directly to our cloud"*. The spec's
owner ruling of 2026-08-22 says the opposite end state: **"Hosted on local (on-premises) servers. Patient care
must never depend on internet connectivity … THIS IS THE END STATE"** and *"nothing may be built that makes
stage 3 expensive. No managed cloud service becomes load-bearing"*
(`docs/superpowers/specs/2026-08-10-hmis-architecture-design.md:24-33`). The department brainstorm designed
Orthanc + OHIF **as the edge at the facility** precisely so acquisition survives a WAN outage
(`docs/superpowers/brainstorms/2026-08-27-department-series/00-CROSS-MODULE-CHAOS.md:42,55,176`: "modalities
keep acquiring (edge-local DICOM to Orthanc)"). The honest reading that satisfies both: **"cloud" is the
offsite tier (O-9) and the AI tier (R-008), never the acquisition edge.** Deleting the on-prem Orthanc is not
a design choice a lane can take; it reverses the owner's own v4.7 ruling, which is his to reverse
(architecture + money). Everything below is built on that reading and says where it would break if he does.

## 1. ordering-door (18a-iv, PR #143) — status: AUTHORED (open, FOR APPROVAL)

- **What was measured.** `/orders` and `"radiology/orders"` appear **0 times** in `apps/web/src`;
  `placeImagingOrder` is called only by its own controller; reception's *Walk in* auto-slots a study that
  already exists; *"Every study in the walk was created with curl"* (PR #142 body §8; memory
  `radiology-commissioning-walk` defect 6). `handleOrderPlaced` guards `if (payload.kind !== "imaging") return []`
  (`apps/core/src/modules/radiology/consumers.ts:61-65`).
- **What #143 proposes.** Four tasks (T1 advised imaging lines read; T2 the seat places the order; T3 walk-in
  leg; T4 census row + runbook §9 step); six DECIDED decisions, §7 empty ("invents no price, buys nothing,
  decides no statute"). D1: the door is `/radiology/reception`, not a new screen. D2: the advised line is a
  suggestion the receptionist confirms (auto-placing on consult close would bill scans never done). D4: the
  indication is required, typed at the desk, never defaulted — a CT with no indication is a dose nobody can
  justify to an AERB inspector. The doctor's half already works: `AdvisedTest` is service-generic and the
  picker searches the whole tariff (PR #143 body).
- **Why it is rung 0 of every epic below.** A PACS, a cloud tier and an AI product all consume studies; today
  the product produces none from a screen. #143's §6 names the next three seats with zero web callers:
  contrast administration (18a-iii T1, `POST /studies/:id/contrast`), the contrast **reaction** (T2 — "the one
  to raise first": 18a's gate reads the allergy it writes), the outside-study register (T4).
- **Companion PRs open:** #139 (walk report + `apps/core/scripts/dev-radiology-standup.ts`), #140 (radiology's
  own go-live runbook + `radiology_definitions_active` census row at **G3** — the two `imaging_*` Class-A
  workflow definitions are activated by nothing; three distinct humans needed), #142 (walk correction).
  Merged fixes from the walk: #133 seed died `actor_not_user`, #135 gaps route 400, #138 refusal names the
  room, #141 RSO field. `standup-check.ts:361-377` already carries radiology rows (G2 study types, G3 devices,
  G3 licensed).
- **Owner vs designable.** Designable now (the plan says so, §7 empty). Nothing here is money or law.

## 2. dicom-ingest (18b, "the seams without the hardware") — status: DEPLOYED seams; 18b-ii ABSENT

- **Shipped and in `c11833d`:** `0053_study_uid_unique.sql`, `0054_image_views_pacs_settings.sql`
  (`git ls-tree c11833d`); PRs #16 (T1 MWL pull export, dcmtk dump, AE title on the device), #17 (T2 UID
  `2.25.` + SHA-256 of the study id, `docs/superpowers/plans/2026-09-02-phase1-18b-dicom-seams-no-hardware.md:104`
  F1), #19 (T3 viewer door), #20 (T4 drafter seam), #34 (T5 e2e + runbook), #35 (close). Code:
  `apps/core/src/modules/radiology/mwl.ts:19-45` (D1 PULL route, D2 Form-F withholding, D4 alias on the
  worklist), `radiology-mwl.controller.ts:26-31` (`GET /radiology/mwl`, permission `radiology.mwl.read`),
  `views.ts:14-30` (URL computed server-side; `no_images` / `pacs_not_configured` refusals; writes
  `imaging_image_views`, emits `imaging.image_viewed`, PHI line), `radiology-images.controller.ts:11-16`
  (POST because it WRITES), `drafter.ts:6-24` (D7: module-local seam; offline template fills `technique`
  only; findings/impression EMPTY; lockout REFUSES), schema `IMAGE_SOURCES = ["pacs","no_pacs_images","outside"]`
  (`apps/core/src/kernel/db/schema/radiology.ts:83`), `pacs_settings` kind (`:102`), `provenance` jsonb (`:434`).
  The study screen chooses the source and shows "Opened N×" (`apps/web/src/screens/radiology-study.tsx:39,109,260-277`).
- **What does NOT exist (measured):** no DICOMweb/STOW/C-STORE/WADO code anywhere in `apps/core/src` (0 files);
  no OHIF in `apps/web/src` (0 files — the viewer is an external URL template, `views.ts:33-37`); no dicom/
  orthanc/cornerstone dependency in any `package.json`; `orthanc|dicom` appears in exactly one source file,
  `mwl.ts`, as prose. Runbook §6: *"No images flow into HMIS. There is no reconciliation … no dose SR parsing,
  no Orthanc authorization bridge, no embedded viewer, no tiering or offsite copy, no model-backed drafter"*
  (`docs/runbooks/radiology-pacs-go-live.md:130-135`). 18b §6 lists the same as 18b-ii
  (`…18b-dicom-seams-no-hardware.md:82-84`). `imaging.study_acquired` has **no consumer** (`:22` row 2).
- **The one trap the runbook leads with:** a bridge account holding a clinical role can satisfy a pregnancy
  gate; the kernel has no service-account door (S1), so `modality_bridge` (one permission) is the only
  safeguard (`radiology-pacs-go-live.md:14-21,64-71`). A cloud PACS's pull agent inherits this exactly.
- **18c's coupling:** from the moment `0060`–`0065` land, `startAcquisition` refuses `device_not_licensed`
  and **the MWL withholds the study so the console never sees it** (`docs/runbooks/radiation-safety-go-live.md:12-21`).
  Any PACS, on-prem or cloud, sees only licensed machines' worklists — that is a feature to keep.
- **Gaps for 18b-ii (designable once R1/R2 land):** reconciliation consumer of `imaging.study_acquired` →
  `study.unmatched` (off-book scan = the negative-space row, brainstorm `01-radiology-imaging.md:598`);
  dose SR hook (M4 fallback exists: manual dose mandatory); RBAC bridge (open question 4, `:622`); heartbeats
  `interface.down` (spec `:498`); restore drill. Outside-study image upload is deferred "with 18b-ii's storage
  tiering" (`docs/superpowers/plans/2026-09-05-phase1-18a-iii-radiology-clinical-flow.md:172`); today an
  outside study records only `arrival ∈ film|cd|link|none` (`schema/radiology.ts:823`).
- **Stale prose to fix:** the PACS runbook's status line still reads *"CODE-COMPLETE and NOT DEPLOYED"*
  (`radiology-pacs-go-live.md:3`) while `c11833d` carries its two migrations; 18c §8.8 says "Production is
  still at 46 migrations" (`…18c-radiation-safety-aerb.md:128`). Written diagnoses go stale.

## 3. pacs-storage-decision (11b) — status: OPEN — OWNER (procurement + money)

- **The ruling as posed to the owner:** 18b §7 **R1** recommends Orthanc + PostgreSQL index in its own
  container on the production box (11b on-prem), 2×3.84 TB NVMe + 8-bay nearline (₹2–3L), offsite incremental
  from day one (₹8–15k/month); **R2** modality worklist licences (CT + DR now); **R3** OHIF free (DECIDED),
  one 3 MP monitor ≈ ₹4L; **R4** drafter provider + DPIA addendum (`…18b-dicom-seams-no-hardware.md:86-93`).
  Register: the 11b decision "gates 18b-ii" and is "no for 41; yes for 49/50 (ICU telemetry) and 18b-ii"
  (`docs/superpowers/2026-09-06-ROADMAP-v2.md:402`), listed among the three procurement facts the owner
  states when he chooses (`:449`), and among the pre-IPD gate conditions (`00-INDEX-AND-SYNTHESIS.md:61,197`).
- **What the mission changes about the question.** R1 assumes the on-prem answer to 11b. The mission's
  "eliminate PACS servers at the facility" is a *fourth option* nobody has costed: acquisition edge in the
  cloud. Under spec §1 v4.7 (`:24-33`) that option is disallowed as an end state and a stage-3 cost. The
  brainstorm's sizing gives the arithmetic either way: ~150 MB/study, 100/day ≈ 15 GB/day ≈ 5.5 TB/y raw,
  300/day ≈ 16 TB/y (`01-radiology-imaging.md:565`); retention Tier 1 online 18 mo NVMe, Tier 2 nearline 5 y,
  Tier 3 cold offsite ≥10 y CT/MRI/mammo/MLC, paediatric to age 25 (`:184`; O-9 `:578`; one retention schedule
  R-009, counsel confirms, `00-OWNER-RULINGS-REGISTER.md:21`).
- **Recommendation for the roadmap doc (not a ruling — a framing):** put 11b to the owner as three priced
  options — (a) R1 as written; (b) R1 with Tier 2/3 in an India-region object store from day one (O-9 + R-254),
  which is the "cloud" the mission can have inside spec v4.7; (c) cloud-primary PACS, which requires him to
  amend spec §1 v4.7 and accept that a WAN cut stops acquisition (chaos file `:42`). Only (c) is the mission's
  literal wording, and only (c) is contradicted by his own prior ruling.
- **Measurable parameter once ruled:** `pacs_settings.enabled = true` published (G2 row); first successful
  MWL pull (`withheld: 0, malformedAeTitle: []`, runbook `:54-55`); monthly restore-drill log for the image
  tier (spec `:730`, ROADMAP `:76-78`).

## 4. cloud-tier — status: BRAINSTORMED; blocked on 11b + DPDP posture; no code

- **Where it is designed:** Orthanc "object storage (S3) for tiering" (`01-radiology-imaging.md:534`),
  offsite incremental ≈ ₹8–15k/month or a second NAS in another building ₹2–3L (`:558`), O-9 "offsite
  incremental object storage from PACS day one … impossible to retrofit late" (`:578`), Storage Forecaster
  (automation, T0, Orthanc metrics → headroom days, tier moves proposed, ships 18b; `:503`), spec fix 36
  "tiered imaging retention, incremental object-storage offsite" (`spec:596`) and the ransomware answer
  "weekly encrypted offsite copy on immutable/air-gapped media" (`spec:730`; chaos `:170-186`).
- **DPDP / residency rulings that already govern it:** **R-254** "India-region processing + DPA for all
  outbound processors (inference, PACS offsite, video …); on-prem default for Class-1 inference" — legal,
  pre-plan-authoring, plans 12c/18b/23/50 (`00-OWNER-RULINGS-REGISTER.md:266`); **R-126** cloud frontier only
  with in-region DPA (`:138`); **R-048** the precedent (video vendor, India region, DPA; `:60`); the spec's
  own pre-pilot gate: *"during the secondary-HMIS pilot, real patient data is live on a cloud host outside
  India — the DPDP posture for that window is a pre-pilot gate"* (`spec:33-34,839`). Production today is
  ONE Hetzner server (`spec:27`), i.e. every deployed table is already on a non-India cloud host; images
  would join a transfer class that is opened but not yet ruled defensible.
- **What the DPIA does not cover:** `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` has **zero**
  occurrences of image/DICOM/pixel/radiology (grep count 0). Its scope is the 12a runtime; Class 1 is
  "de-identified, token-referenced context" (`:20`); L1 requires "re-identification risk analysis, the chosen
  provider's processing locations, and DPDP §16 transfer analysis" before any Class-1 request (`:28`).
  Pixel data is not Class 1 by de-identifying headers alone (a CT head reconstructs a face); the brainstorm's
  de-id row J5 covers headers only (`01-radiology-imaging.md:331`). **A DPIA addendum for imaging egress
  (storage tier AND any AI processor) is required before one study leaves the premises** — R-262's "per-module
  addenda after" (`register:274`). LAW (counsel).
- **Designable now, no ruling needed:** the outbound register the brainstorm sketched and no schema has —
  `imaging_sendouts {study_id, partner_id, deid_level, sent_at, sla_due, returned_at, report_doc_id, cost}`
  (`01-radiology-imaging.md` §4 row 24; `grep -rli sendout|teleradiology apps/core/src` = 0). One table
  serves teleradiology, the offsite tier's restore proof and an AI processor alike: **every byte that leaves
  carries a processor id, a DPA id and a de-id level**. That is the measurable parameter for "cloud":
  outbound studies with no DPA id = 0.
- **PROCUREMENT/MONEY:** the object store contract (India region), the DPA. **LAW:** R-254 confirmation,
  the DPIA addendum, R-009 retention against state CEA rules.

## 5. instant-transfer-fibre — status: ABSENT (pure procurement)

- Nothing in the repository sizes or names a link: `fibre|fiber|bandwidth|Mbps|Gbps` return no hits in the
  radiology brainstorm (the grep surfaced only the S3/offsite rows). The only relevant numbers are storage
  growth (`01-radiology-imaging.md:565`: 15 GB/day at 100 studies/day) — a link is sized from that by
  arithmetic, and a redundant second path is what "patient care must never depend on internet connectivity"
  (`spec:24`) demands if anything clinical crosses it.
- **What HMIS can measure once a PACS exists:** modality acquisition time (DICOM `(0008,0032)`) vs Orthanc
  arrival vs first `imaging.image_viewed` — the reconciliation consumer 18b-ii adds is where the arrival
  timestamp would be recorded; today the only timestamps are `imaging.study_acquired` (entered at the
  console) and `imaging_image_views.viewedAt` (`views.ts:16-20`). Parameter: p95 acquisition→viewable ≤ N s,
  computable only after 18b-ii.
- **OWNER:** the link, the redundancy, the SLA, the modality MWL licences (R2). Not designable.

## 6. teleradiology (R-001) — status: BRAINSTORMED, dormant by design; no code

- **R-001** "Dormant DPA-backed contract now; duty manager activates on pre-authorised trigger (stat unread
  15 min / backlog > N); cost visible per activation" — purchase, plan 18b, pre-pilot
  (`00-OWNER-RULINGS-REGISTER.md:13`). WF-IMG-10: `study.sent_out` (de-identification level per DPA) →
  partner SLA clock → `study.external_reported` → ingest (PDF + structured fields) → auto-publish as signed by
  the registered external radiologist or in-house countersign; SLA miss → succession chain
  (`01-radiology-imaging.md:145-148`). Partners named (Teleradiology Solutions, 5C Network, Synapsica) via
  DICOMweb/STOW push (`:536`). Structured Report Extractor (agent T2) drafts fields from the partner PDF (`:485`;
  M7 `:363`). Open question 7: de-id vs the partner's need to phone criticals — token-map resolution designed
  with the DPA (`:624`). 18a-iii §6: "O-1 plus a signed DPA. Law and procurement" (`…18a-iii…md:165`).
- **Why it matters to pillar 3a:** it is the first flow in which images leave the premises, and it needs no
  AI. It is therefore the cheapest proof of the cloud-tier's legal machinery (DPA, de-id level, India
  region, send-out register) and of the succession chain (F1, `:275`; chaos 6.3 `:420`).
- **Designable now:** the `imaging_sendouts` register + `study.sent_out`/`study.external_reported` events
  + the send-out mirror of the lab's §11.6 pattern, all with the partner id as data. **OWNER:** the contract
  (money/procurement), the DPA (law).

## 7. ai-triage-nudges — status: BRAINSTORMED; R-008 "bought, never built", T1 only, after PACS is stable

- **The ruling:** **R-008** "None in 18a/18b; evaluate CXR-triage/stroke tools only as T1 nudges after PACS
  is stable; bought never built" — scope, 18b, can-wait (`00-OWNER-RULINGS-REGISTER.md:20`; O-8
  `01-radiology-imaging.md:577`; buy list `:551`). §9's Drafter is explicitly text-side: *"no pixel analysis
  in v1 … image-AI is a separate bought product later"* (`:484`). §16: T1 = remind/nudge; T2 = draft;
  clinical caps at T2–T3 permanently (`spec:778`); Radiology Report Drafter is the T2 agent "PACS phase"
  (`spec:785`).
- **What exists as a substrate:** `kernel/inference` is `SpeechClient` + offline + Cloudflare Workers AI only
  (`apps/core/src/kernel/inference/types.ts:32-34`, `workers-ai.ts:4-7`); `InferenceClient` appears **3 times,
  all in comments** ("becomes Plan 12a's `InferenceClient`"); `kernel/copilot` does not exist; ROADMAP §5:
  "No 12a agent runtime. DPIA v0.2 is counsel's; the voice scribe stays inert at 503" (`ROADMAP-v2.md:428`).
  The rail a nudge would ride is `imaging.study_acquired` (unconsumed) and the worklist's priority sort
  (F2 `:276`: stroke > trauma > ICU portable > ED > IPD > OPD). Existing T1 automations of the same shape:
  Order Appropriateness Nudger (rules), Unread-Study Watchman, Critical-Finding Chaser (`:494-498`;
  18a-iii T5 #132 shipped two chasers, `imaging.critical_overdue`/`imaging.report_unread`, `events.ts:162,167`).
- **Honest contract for a T1 image-AI nudge (designable now as a phase doc, not buildable):** the product's
  output lands as a **worklist priority hint + a row** (`imaging_ai_flags {study_id, processor_id, model_version,
  finding_class, confidence, at, acknowledged_by, agreed: bool|null}`), evented, dismissable, **never a
  sentence in a report** (D7's "a machine never invents a finding" extended to pixels); fail-open (no flag =
  ordinary queue); per-processor kill switch; provenance. Parameters: door-to-read for flagged vs unflagged
  (`imaging.study_acquired` → `imaging.report_published`); agreement rate from the row; nudges with no
  acknowledgement within SLA. The MWL D2 principle applies: a processor sees only what a DPA and a licence
  permit.
- **Gates, in order:** 18b-ii live and stable (R-008's own condition; propose ≥ 90 days, the brainstorm's
  O-6 number); 12a runtime (kill switch, provenance, tool catalogue — none built); DPIA v0.2 signed
  (R-262) **plus** the imaging addendum (pixel egress, re-identification); R-254 India-region + DPA for the
  processor; **LAW not in any repo doc: image-AI products are regulated as software-as-medical-device in
  India (CDSCO, MDR 2017) — the purchase must name a licensed product; counsel confirms.** **MONEY:** the
  product licence (R-008 "bought").

## 8. volumetric-3d-analysis — per mission modality — status: ABSENT; the ladder ends here

The mission names four analyses and four specialties. What the repository holds for each:

| mission item | modality / department | what exists | what is missing |
|---|---|---|---|
| intracranial haemorrhage mapping | CT head / neurology, stroke | stroke clock design `stroke.suspected` → door-to-CT ≤25 min → read ≤45 min (`01:135`); ICH is a **Red** critical category, phone ≤60 min (`:127`); F1 sole-radiologist stroke path (`:275`); O-8 names "stroke ASPECTS/LVO" as a bought tool (`:551`) | no ED module (40 unbuilt, `…18a-iii…md:169`); no neurology service line anywhere (index 60–67 has none); no volume field in any report table |
| fracture detection | DR / CT / orthopaedics | "unexpected fracture" is an **Orange** category (`:127`); ortho **implants** exist only as a consignment ledger (14b, `00-INDEX-AND-SYNTHESIS.md:145`) | no orthopaedics plan; no imaging↔implant link |
| implant positioning | post-op DR/CT / orthopaedics | MRI implant questionnaire gate P5 (`:403`); consignment `consignment.deployed` event (index `:145`) | no post-op imaging protocol, no angle/position fields |
| pneumothorax identification | CXR / chest trauma | tension pneumothorax **Red** (`:127`); `trauma.activated` → eFAST ≤10 min, CT ≤30 min (`:135`); CXR triage product named (`:551`); trauma registry = plan 67 | no chest-trauma pathway (needs 40/67) |
| oncology | CT/MRI/mammo | structured findings BI-RADS/TI-RADS/LI-RADS as `Observation` (`:32` of §4); "new mass suspicious for malignancy" Orange (`:127`); RT = plan 64, chemo = 61 | no tumour-response/volumetric fields; 64 waits on LINAC commissioning |

- **What "3D volumetric" is technically:** MPR/volume rendering is a viewer capability (OHIF extensions,
  bought/free — R3), and volumetric *measurement* is a vendor product's output (R-008). HMIS's part is the
  same in every row: **a structured field with provenance in a T2 draft that a radiologist signs under 2FA**
  — the `DraftProposal.structured {field, value, cited}` shape and the `provenance` column already exist
  (`drafter.ts:46-`, `schema/radiology.ts:434`, §9 prompt contract `01:505`). Nothing about "3D" changes the
  tier: it is T2 forever (`spec:778`).
- **Prerequisites that are not radiology's:** the departments the mission names do not exist as plans
  (neurology, orthopaedics, chest trauma); the consumers of a volumetric result are ED (40), OT (48), IPD (41)
  and the service lines (60–67), all behind the IPD gate (`ROADMAP-v2.md:419-427`, `index:61`).
- **OWNER:** each product (money; R-008), CDSCO status (law), the DPIA addendum (law). **Designable now:**
  nothing beyond the T2 draft contract above and a per-row parameter: *volumetric fields signed unchanged /
  edited / deleted by the radiologist* (edit-distance, the O-6/R-006 method, `register:18`).

## 9. An honest epic ladder (each rung's gate is named; nothing is renumbered)

| rung | epic (plan id) | status today | gate to start | parameter that confirms it |
|---|---|---|---|---|
| 0 | **18a-iv ordering door** (#143) + the reaction seat next (18a-iii §6) + radiology's own runbook (#140) + the catch-up deploy carrying 18c and the certificates (11i T7, ROADMAP `:267-272`) | authored / open | owner approves #143 (one line; §7 empty) | a study placed from `/radiology/reception` reaches `imaging.study_scheduled` with no curl; `standup:check radiology` all green on production; `aerb/licences/gaps` empty |
| 1 | **18b-ii on-prem PACS**: Orthanc container + worklist dir + bridge (runbook §5), reconciliation consumer → `study.unmatched`, dose SR hook, RBAC bridge, OHIF via `pacs_settings`, restore drill, Storage Forecaster T0 | absent (runbook `:130-135`) | **11b/R1 + R2 (owner: procurement + money)** | MWL pull `withheld:0`; off-book studies/day = 0; `image_viewed` per radiologist shift > 0; restore drill dated monthly |
| 2 | **Cloud tier**: Tier 2/3 object store in India region (O-9, R-254), `imaging_sendouts` register, teleradiology send-out (R-001) as the first outbound flow, DPIA imaging addendum | brainstormed | 11b option (b); **R-254 + DPIA addendum (counsel)**; **object-store + DPA + teleradiology contract (owner)** | outbound studies with no DPA id = 0; restore from offsite tier passes; send-out SLA misses → succession fires |
| 3 | **AI triage nudges T1** (bought CXR-triage / stroke tool; R-008) under 12a runtime | brainstormed | rung 1 stable ≥ 90 d; 12a runtime built; DPIA v0.2 + addendum signed; **CDSCO-licensed product (law) + licence (money)** | door-to-read flagged vs unflagged; agreement rate on the nudge row; zero report sentences of machine origin |
| 4 | **Volumetric reports as T2 drafts** (ICH volume, fracture, implant position, pneumothorax %) as structured fields with provenance, signed by a human | absent | rung 3 + 90 d of edit-distance data (R-006 method) + a consuming department (40/41/48/60–67) | fields signed unchanged vs edited; critical-category phone time for AI-flagged Red findings |
| — | **Eliminating the on-prem PACS** (the mission's literal wording) | contradicts `spec:24-33` and chaos `:42` | **owner amends spec §1 v4.7 (architecture + money)**; only then a lane may cost it | — |

## Facts

1. `c11833d` (the deployed base per CONTEXT.md) carries 56 migration files incl. `0047_radiology_core`,
   `0053_study_uid_unique`, `0054_image_views_pacs_settings`; `main` @ `b04cbd9` carries 80, through
   `0079_lab_rerun_choice` (`git ls-tree`, `ls apps/core/drizzle`). 18a + 18b seams are deployed; 18c
   (`0060`–`0065`) and 18a-iii (`0073`–`0078`) are not in that base.
2. `orthanc|dicom` occurs in exactly one core source file (`modules/radiology/mwl.ts`); DICOMweb/STOW/
   C-STORE/WADO: 0 files; `ohif` in `apps/web/src`: 0 files; no dicom/orthanc/cornerstone dependency.
3. `InferenceClient` occurs 3 times in `apps/core/src`, all in comments; the inference seam is `SpeechClient`
   (`kernel/inference/types.ts:32`) backed by Cloudflare Workers AI (`workers-ai.ts:4`).
4. `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` contains 0 mentions of image/DICOM/pixel/radiology.
5. `imaging.study_acquired` has no consumer outside the module (18b §2 row 2); the radiology event catalogue is
   13 names (`events.ts:35-167`), `imaging.image_viewed` among them.
6. `/orders` and `"radiology/orders"` occur 0 times in `apps/web/src`; `placeImagingOrder` has one caller
   (PR #142/#143, measured 2026-09-06 at `e32598b`).
7. Rulings that bind: R-001 (teleradiology, purchase), R-008 (image-AI bought, T1, after PACS), R-009 (one
   retention schedule, counsel), R-126 / R-254 (India-region + DPA, on-prem default for Class-1 inference),
   R-262 (DPIA v0.2 + per-module addenda); 18b §7 R1–R4; 18c §7 R1–R4; brainstorm O-1…O-13.
8. ROADMAP v2 excludes 18b-ii "until the PACS rulings" and all of 12a this quarter (`:423-428`); 11b is
   "yes for 18b-ii", "no for 41" (`:402`); radiology opens on production in weeks 7–9 on real AERB
   certificates (`:338`).
9. `standup-check.ts:361-377` has radiology rows (G2 study types; G3 devices present; G3 devices licensed);
   `deploy.sh` does not run `seed:radiology` (comment `:364-369`).
10. `grep -rli 'sendout|send_out|teleradiology' apps/core/src` = 0: no send-out table or event exists.

## Surprises

1. **The mission's "eliminate in-house PACS" is the exact inverse of the owner's own 2026-08-22 ruling**
   (`spec:24-33`: on-prem end state, no load-bearing managed cloud, care never depends on internet). Neither
   the brainstorm nor any plan has costed a cloud-primary PACS; the roadmap has to put the contradiction to
   him as a choice, not resolve it.
2. **Deployed-state conflict.** CONTEXT.md and 18a-iii §0 (`…18a-iii…md:8-30`) say production is `c11833d`
   (18a+18b in, 18c out). Memory `radiology-commissioning-walk` says production "went out by accident at
   12:35 on 2026-09-06 running `399f92c`" with 18c live against an empty licence table — which, per
   `radiation-safety-go-live.md:12-21`, would mean every ionising acquisition on production is refused
   right now. Only `select count(*) from drizzle.__drizzle_migrations` on production settles it; this
   workflow cannot run it. The roadmap should state which.
3. **The PACS runbook's own status line is wrong** (`radiology-pacs-go-live.md:3` "NOT DEPLOYED") and 18c
   §8.8 says "46 migrations" — both stale on the day they are read.
4. **The DPIA has never heard of an image.** Every "cloud imaging" or "AI annotation" step needs an addendum
   that does not exist, and the Class-1 definition (`dpia:20`) does not fit pixel data.
5. **No screen places an imaging order**; every study in the department's only real walk was made with
   curl (PR #142). The ordering door (#143) is rung 0 of pillar 3a, and it is unapproved.
6. **"Fibre" appears nowhere.** The only relevant numbers are storage growth (`01:565`); the link is pure
   procurement.
7. **18c's gate reaches the worklist**: an unlicensed machine is withheld from the MWL, not just refused at
   acquisition (`radiation-safety-go-live.md:14-15`). A cloud PACS's pull agent must keep that behaviour.
8. **`modality_bridge` is a user with a password, not a service account** (runbook `:14-21`, S1) — any
   cloud pull agent would hold a human-shaped login.
