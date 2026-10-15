---
type: module-notes
title: "emergency — module notes"
description: "Why and traps of the emergency department module, lane 1 (er-arrival, #808): the ER episode and its workflow, arrival modes, ambulance pre-alerts with a 2-hour lapse, unidentified registration (a real UHID with an alias), the ER band, brought-dead marker, identity link through the existing patient_merge, the tracking board v1 and the ER desk."
resource: apps/core/src/modules/emergency
tags: [emergency, er, arrival, unidentified, band, pre-alert, tracking-board, identity, merge]
generated: { by: agent:claude, at: 2026-10-15 }
verified: []
stale_after: 2027-01-15
---
# emergency — module notes

Hand-written notes: the WHY and the traps. Signatures are generated in `docs/architecture/modules/emergency.md`.
Paths are relative to `apps/core/src/modules/emergency/` unless they start with a module name, `kernel/`, `scripts/`,
`packages/` or `apps/`. The spec is SPEC-emergency-2026-10-15 (kept outside the repository); the owner's rulings are
decision 0076; the tracker is the GitHub milestone "Emergency" (#808–#816). Lane 1 = issue #808.

## 1. Purpose
The emergency department (casualty). Lane 1 builds arrival: every arrival is recorded first, in at most three taps,
with nothing asked that the system can learn later — no money, no ID, no phone. Later lanes (triage, care, MLC,
disposition, bill, codes, MCI, copilot) hang off the same episode.

## 2. Key files (owner of what)
- `packages/contracts/src/emergency/common.ts` (states, arrival modes, age bands, actor kinds, `ER_INTENT_CATALOGUE`
  of every spec §2 act), `packages/contracts/src/emergency/refusals.ts` (`ER_REFUSALS`: rule + fix per code), `packages/contracts/src/emergency/intents.ts` (lane 1 eight contracts),
  `packages/contracts/src/emergency/board.ts` (`ErBoard`, `ErDeskView`, `ER_ROUTES`, `ER_BOARD_TOPIC`). The contract test walks every key for money words.
- `kernel/db/schema/emergency.ts` — `er_episodes`, `er_pre_alerts`, `er_bands`; `patients.identity_status` (migration
  `er_arrival`). `schema-parity.test.ts` holds the retyped value lists equal to the contracts'.
- `workflow.ts` — `erEpisodeWorkflowDefinition` (`er_episode`, Class A), `ER_EPISODE_TRANSITIONS` (every edge names its
  catalogue act; later lanes' acts carry the spec's actors in `LATER_ACTORS` until contracted), `ER_ACTOR_ROLE_KEYS`.
- `core.ts` — permission, idempotency (`onceEr`, route `er:<intent>`), locks, `moveEpisode`, `mintEpisodeNo`
  (`ER26-000123`), `mintAlias` (`Unknown-0412` / `अज्ञात-0412`), `personRecords` (canonical + merged ids).
- `arrival.ts` — `preAlert`, `cancelPreAlert`, `lapseErPreAlerts` (the job), `registerArrival`, `registerUnidentified`,
  `recordBroughtDead`. `bands.ts` — `printErBand`, `reprintErBand`, `mintBandIn`, `bandPerson`. `identity.ts` —
  `linkIdentity`. `board.ts` — `readErBoard`, `readErDesk`, `searchErPatients`, `listErDoctors`.
- `events.ts`, `realtime.ts` (topic `er:board`, also refetched on `patient.merged`), `emergency.controller.ts`
  (`/er/*`), `emergency.module.ts`, `manifest.ts`, `names.ts`.
- `apps/web/src/screens/er-desk.tsx` (`/er/desk`), `apps/web/src/screens/er-board.tsx` (`/er/board`, `?wall=1`), `apps/web/src/screens/er.css`, `apps/web/src/lib/er-api.ts`.
- `test/helpers/emergency.ts` — `mkErWorld` (the IPD admit world + the activated `er_episode` workflow + the patients
  approval types + desk, casualty nurse, MRD officer, board-only doctor).

## 3. Invariants
- An intent is ONE function: parse the zod input → re-check the permission (`er_forbidden`) → run once under the
  idempotency key → lock → re-check state and rules → write + workflow + event, in one transaction. A refusal is
  `ErRefusal` (contract code, rule, fix, `detail` data); HTTP 404 for `*_not_found`, 409 otherwise.
- ONE workflow instance per episode; `er_episodes.state` mirrors it; every move goes through `moveEpisode`. The
  workflow checks ROLES (front_office, front_office_supervisor, er_nurse, doctor, duty_manager); the intent checks
  PERMISSIONS.
- `arrived_at` is the GATE instant (input `arrivedAt`, default now), stamped once; `registered_at` is the server's
  entry time. More than 24 h back needs a paper serial (`arrival_too_old`); the future (beyond 2 min skew) is refused.
- One open episode per PERSON: the check reads every record of the person (`personRecords`, through the merge chain);
  the partial unique `er_episodes_open_patient_ux` is the backstop and a lost race maps to the same refusal.
- An admitted inpatient lying on a bed is refused `patient_admitted` with the ward and bed (IPD `placedAdmissionOf`).
- A second arrival within 24 h is a NEW episode with `returned_within_24h` (+ `previous_episode_id`).
- Unidentified: a REAL UHID through `patients.registerPatient` with `identityStatus: "unidentified"`, the alias as the
  name, no DOB, assurance `self_declared`, no phone. The age band lives on the episode (DECIDED: a guessed child's DOB
  would trip the minor-needs-guardian rule at the desk that must ask nothing). Aliases are serial per IST year.
- The band prints IN the arrival transaction; serial `<ER no>-<n>`, QR `ERBAND1|serial|uhid`; one live band per episode;
  an unknown's band says "Allergy: unknown" and "Unidentified" in words. A reprint voids the old band with a reason.
- Pre-alert: its own row (DECIDED: not an episode state — one call may bring several patients). Arrivals claim it
  (`arrived_count`); the last claim closes it; it lapses at expected time + 2 h (`lapseErPreAlerts`, riding the
  `lapseBedReservations` minute job — no job and no pool client of its own). A past-due one is refused inline.
- Brought dead: minted and moved `arrived → brought_dead` at once; no band, no charge; the examining doctor and time are
  required (examined before arrival is refused). The patient master is NOT marked deceased (0018's MCCD rule; see §5).
- `link_identity` FILES `patient_merge` (unknown → true) and asks `patients.merge`; it never merges. After the MS grants
  and MRD executes, readers resolve the unknown to the true record: the tile and desk show the true name, the desk marks
  the band stale, the reprint prints the true name, UHID and allergies.
- Wall board: no names (alias or initials), no UHID, no complaint words. No money anywhere (0058).

### Lane 2 (er-triage, #809)
- ESI v4 (`packages/contracts/src/emergency/triage.ts`: `ER_ESI_INFO`, `esiAlgorithm`). The level is the person's; the
  four decision points give the algorithm's level (the proposal). A level less urgent than the proposal or the last
  level is refused `down_triage_needs_reason` without a reason; an up-triage never asks. Every entry is a row of
  `er_triage_entries` (the intents only insert); `er_episodes` mirrors the last level, score and clocks.
- The re-triage clock: from each triage, ESI 2/3/4/5 → 15/30/60/120 min (ESI 1 none), only while `triaged` (a doctor
  seeing the patient stops it). A vital set with a WORSE early-warning band pulls the due instant to now.
- `sweepErTriageClocks` (rides `lapseBedReservations`) runs TWO clocks on ONE ladder: door-to-triage (an `arrived`
  patient 5 min past the gate → task `er_triage_due`, stat; climb notice `er.triage_overdue`) and re-triage. Re-triage overdue → ONE task (`er_retriage`, `sourceRef`
  `er_retriage:<episode>:<due>`, skill `er_triage` → `er_nurse`, its one rung bells the casualty nurses); 15 min past due →
  ONE climb (`escalationRecipients("er_retriage")`, fallback `nursing_supervisor`; notice kind `er.retriage_overdue`),
  stamped per due instant. A re-triage, the doctor or (lane 5) departure cancels the task.
- The take (seam E2): `triage.departmentCode` → `unitOnTake(dept, arrived_at)` — the GATE instant, so a 07:55 arrival
  entered at 08:10 belongs to the night's unit. Stamped once on the episode (`take_*`).
- Bays: `placeInBay` / `moveBay` through IPD `placeErEpisodeIn` / `releaseErBayIn` (same room → bed lock; occupant
  type `er_episode`). LOCK ORDER: the episode first, then the bed. One bay per episode (`already_in_bay` names it);
  `er_episodes_open_bay_ux` backs one ER patient per bay. A move takes the new bay first, then sends the old to cleaning.
- `assign_er_doctor`: only an active `doctor` role holder; the first assignment moves `arrived|triaged → in_treatment`,
  stamps `seen_at` (door-to-doctor), clears the re-triage clock and cancels its task.
- OPD red flag (E9): `pre_alert` mode `opd_red_flag` names the patient (Desk One's "Send to Casualty"); the card
  carries the patient label (initials on the wall); "Arrived" on the ER desk opens Known with the patient picked.
- Permission `er.triage` (er_nurse, doctor). Screen `apps/web/src/screens/er-triage.tsx` (`/er/triage`).

### Lane 3 (er-care, #810)
- `care.ts` — the intents: `recordErNote` / `cosignErNote` (a `resident` role holder's note is a draft until a doctor who is
  not a resident co-signs; never the author), `placeErOrder` (THE ordering door `orderTests`, STAT by default, naming the ER
  number; the lab's duplicate findings are acknowledged and returned as a WARNING — spec §4.3), `issueErMed` (FEFO from the
  `ER-SAT` materials store, patient label lines, an `er.issue` charge line `rate_pending` for lane 6; own medicine takes no
  stock and no line; a recorded allergy matching the item name or its formulary salts needs `allergyOverride`, never a hard
  block; the ordering doctor must be a doctor; `verbal` = read back now, signed by that doctor within 2 h), `giveErDose`
  (one record per issue; a HIGH-ALERT item given needs a second clinical person's username + PIN on its own connection,
  throttled like IPD), `signErVerbalOrder`, `recordProcedure` (a `serviceId` posts an `er.procedure` line), `recordConsent`
  (paper names its witness; guardian/representative named with relation; `emergency` = no capacity, no relative, life at
  risk: the treating doctor plus a SECOND, different doctor), `callSpecialty` (the unit on take at the GATE; callees from the
  roster's `calloutList`; one open call per department), `answerCall`, `declareStabilised` (a doctor, once; a clinical word).
- `sweepErCareClocks` (rides the minute job): a lab critical on an open ER episode (lab `openCriticalsForEncounters`) →
  ONE notice to the ER doctor of record (none yet: the `er_critical` ladder); still open 15 min → ONE climb on `er_critical`
  (fallback `duty_manager`); the call closes only by the lab's read-back. A call unanswered 15 min → ONE climb on `er_call`.
  A verbal order unsigned 2 h → the ordering doctor's bell, once. Stamps: `er_critical_alerts`, `er_specialty_calls.climbed_at`,
  `er_med_issues.verbal_notice_at`.
- `charge-sink.ts` — the `ER` encounter resolver (only `^ER\d{2}-\d{6}$`, the patient through the merge chain, payer `self`)
  and the episode charge sink (billing `registerEpisodeChargeSink("ER")`): open episode = `live` (no invoice at a counter, no
  report held for money), departed = `ended`; one line per order item priced from the active tariff, `rate_missing` when no
  rate; a cancel before the work reverses. Billing's `RUNNING_BILL_EPISODE_RES` now names the ER grammar too (fail closed).
  Registered by `EmergencyModule` (API only, as IPD).
- Reads: `care-read.ts` `readErCare` (no money key — the acceptance suite stringifies it), `listErItems` (ER-SAT stock, no price).
- Board chips: `critical`, `call_waiting`, `stabilised`. Screen `apps/web/src/screens/er-patient.tsx` (`/er/patient`).
- Care is never gated: acceptance (c) runs every clinical intent on an unidentified patient who has paid nothing; (c-3) reads
  `care.ts` / `triage.ts` source for money words. MLC state joins (c) in lane 4.

### Lane 4 (er-mlc, #811)
- `mlc.ts` — the medico-legal case. `er_mlcs` is IMMUTABLE (migration trigger `er_mlc_append_only` refuses UPDATE and
  DELETE; also on `er_mlc_addenda`, `er_mlc_intimations`, `er_mlc_custody`); the only mutable MLC table is
  `er_mlc_obligations` (clock stamps). One MLC per episode (`er_mlcs_episode_ux`), serial `MLC26-000123` per IST year
  (advisory lock on the year). `openMlcIn` is the one writer: by a doctor (`openMlc`), or BY RULE in arrival.ts —
  `register_unidentified` (`unknown_unconscious`), `register_arrival` with mode `police` (`police_brought`), and
  `record_brought_dead` (`brought_dead`). Police on arrival with a station named = the intimation, recorded at the gate
  instant (`police_present`). `late` = a doctor opening it > 6 h after the gate or after the patient left.
- Obligations: `police_intimation` due open + 1 h; `faculty_countersign` due open + 24 h. `sweepErMlcClocks` (minute job):
  intimation past due → ONE stat task `er_mlc_intimation` (skill `er_mlc` → front_office, er_nurse), 30 min later ONE
  climb (`mlc_intimation` ladder, fallback duty_manager); countersign past due → `breached_at` + ONE notice
  (`mlc_countersign`, fallback medical_superintendent). Neither closes on death or departure. `recordPoliceIntimation`
  meets the obligation and cancels the task; `countersignMlc` = a doctor, not a resident, not the opener.
- Custody: `recordBelongings` / `handOverEvidence` — a numbered link each, recorder + a second person's PIN
  (`verifySecondPerson` from care.ts with an `er.mlc` holder test). A seal: collected before stored / handed over;
  handed over once; seals are upper-cased.
- Addenda (`addMlcAddendum`, a doctor) carry text, optional injuries, optional new category (the latest wins on read),
  `examinationRefused`.
- MLC events correlate on the MLC id (not the episode): lane 1's brought-dead test pins the episode's own events.
- Brought dead also calls `patients.recordBroughtDeadDeath` (deceased, `death_kind = 'brought_dead'`, no MCCD — the one
  deceased record without a certificate number) and `ipd.openErMortuaryEntry` (the mortuary register now holds an
  admission OR an ER episode; `mlc = true`, so `releaseBody` refuses until `recordPoliceClearance`).
- Reads: `readMlcDesk` (owed, oldest due first; last 7 days), `readMlc` (original + addenda + intimation + countersign +
  custody + mortuary entry). Screen `apps/web/src/screens/er-mlc.tsx` (`/er/mlc?mlc=<id>`); the ER patient's bar has "MLC".
- Care is never gated: (c-2) in `acceptance/mlc.acceptance.test.ts` runs lane 3's clinical intents on an MLC patient
  with the intimation overdue and the countersign breached. No care file reads `er_mlc*`.
- `scripts/stage-er-setup.ts` (UAT only): drafts `er_episode`, creates an EMPTY `ER-SAT` store, grants `er_nurse` to the
  all-roles account. Production: the materials head creates and stocks ER-SAT; MS + owner activate the workflow.

## 4. Traps
- `registerPatient` takes a `Tx` and the band reads the new patient in that same `tx` (`bandPerson(tx, …)`); reading it
  through `db` (`getPatient`) inside the transaction sees nothing.
- `getPatientSummaries` resolves the merge chain: an unknown whose summary id differs from the episode's `patient_id` has
  been merged — that is how the board knows, without flipping `identity_status` in place.
- The web dev server (`vite`) runs Chromium out of resources on this app (1,000+ modules); browser walks use
  `vite build` + `vite preview` against a stub API.
- Lane 4 moved: seed-roles (+1 permission `er.mlc`, 6 grants), caddyfile/nav (one menu entry `/er/mlc`), roster
  escalation kinds (+2, check constraint retyped by hand in `kernel/db/schema/roster.ts`), patients (`death_kind`), ipd mortuary register
  (`admission_id` nullable, `er_episode_id`).
- Census pins moved by lane 1: seed-roles (role, pairs, permissions), seed-staff `KNOWN_ROLE_KEYS`, manifests (35;
  app-only list), caddyfile-parity routes (131), standup-check (`emergency` in NOT_DEPARTMENTS, OPEN).

## 5. Seams owed to later lanes
- Lane 3 built care. Still owed after lane 3: the ER bill desk prices `rate_pending` issue lines and settles (lane 6);
  radiology's own `INPATIENT_ADMISSION_NO_RE` does not know the ER number (a STAT scan is authorised by `stat` anyway);
  results "ready" chip and copilot "since arrival" (lane 9); the drug-order list is the issue itself (no separate ER drug order).
- Lane 2 built ESI, bays, the door-to-triage and re-triage tasks and climbs, and the OPD card. Still owed after lane 2: LWBS (lane 5's `record_lwbs`),
  child-without-guardian social-worker task, Code Grey from triage (lane 7), the copilot's ESI proposal (lane 9),
  bay release on departure (lane 5 through `releaseErBayIn`), the ER bay on the IPD Beds board shows no ER name.
- er-care: the `ER` encounter resolver and episode charge sink (ordering door), orders following the merge.
- Lane 4 built the MLC. Still owed after lane 4: injury body diagram and photos (with consent); the MLC copy and wound
  certificate as designed prints (the desk prints the browser page today); police copies only on a written requisition
  log; family surfaces and model calls off for MLC patients (lane 9 / IPD); POCSO report detail; sexual-assault
  examination protocol form; `free_by_law` read by lane 6's bill desk; death in ER (lane 5's `record_er_death`) opening
  the mortuary entry through the same seam.
- er-dispo: `hand_to_unit` → IPD `emergencyAdmit`; outcomes on `departed`. er-bill: the ER bill following the merge.
- Desk: Aadhaar QR and ABHA scans (lane 1 takes the UHID card barcode, UHID, phone and name); a thermal ER band kind on
  the print relay (the browser prints today, decision 0045's fallback); downtime paper-serial reservation.
- er-copilot: the `pre_alert` Now card; intents declared as copilot tools on the manifest.

## 6. Callers
- API: `EmergencyController` (`/er/*`). Worker: `kernel/worker/jobs.ts` `lapseBedReservations` → `lapseErPreAlerts`.
- Imports: `patients` (registerPatient, getPatient, getPatientSummaries, searchPatients, resolvePatientId,
  listMergedLoserIds, createMergeRequest, getMergeRequest, listAllergies), `ipd` (placedAdmissionOf, initialsOf),
  `billing` (withIdempotency).
