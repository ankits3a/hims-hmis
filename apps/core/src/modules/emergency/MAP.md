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
- `sweepErTriageClocks` (rides `lapseBedReservations`): overdue → ONE task (`er_retriage`, `sourceRef`
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

## 4. Traps
- `registerPatient` takes a `Tx` and the band reads the new patient in that same `tx` (`bandPerson(tx, …)`); reading it
  through `db` (`getPatient`) inside the transaction sees nothing.
- `getPatientSummaries` resolves the merge chain: an unknown whose summary id differs from the episode's `patient_id` has
  been merged — that is how the board knows, without flipping `identity_status` in place.
- The web dev server (`vite`) runs Chromium out of resources on this app (1,000+ modules); browser walks use
  `vite build` + `vite preview` against a stub API.
- Census pins moved by lane 1: seed-roles (role, pairs, permissions), seed-staff `KNOWN_ROLE_KEYS`, manifests (35;
  app-only list), caddyfile-parity routes (131), standup-check (`emergency` in NOT_DEPARTMENTS, OPEN).

## 5. Seams owed to later lanes
- Lane 2 built ESI, bays, the re-triage task and climb, and the OPD card. Still owed after lane 2: door-to-TRIAGE
  breach as a task (only re-triage raises one; the board shows the triage clock), LWBS (lane 5's `record_lwbs`),
  child-without-guardian social-worker task, Code Grey from triage (lane 7), the copilot's ESI proposal (lane 9),
  bay release on departure (lane 5 through `releaseErBayIn`), the ER bay on the IPD Beds board shows no ER name.
- er-care: the `ER` encounter resolver and episode charge sink (ordering door), orders following the merge.
- er-mlc: the MLC register, police intimation, the `brought_dead` death kind on patients, mortuary register seam.
- er-dispo: `hand_to_unit` → IPD `emergencyAdmit`; outcomes on `departed`. er-bill: the ER bill following the merge.
- Desk: Aadhaar QR and ABHA scans (lane 1 takes the UHID card barcode, UHID, phone and name); a thermal ER band kind on
  the print relay (the browser prints today, decision 0045's fallback); downtime paper-serial reservation.
- er-copilot: the `pre_alert` Now card; intents declared as copilot tools on the manifest.

## 6. Callers
- API: `EmergencyController` (`/er/*`). Worker: `kernel/worker/jobs.ts` `lapseBedReservations` → `lapseErPreAlerts`.
- Imports: `patients` (registerPatient, getPatient, getPatientSummaries, searchPatients, resolvePatientId,
  listMergedLoserIds, createMergeRequest, getMergeRequest, listAllergies), `ipd` (placedAdmissionOf, initialsOf),
  `billing` (withIdempotency).
