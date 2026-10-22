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
- Wall board: no names (alias or initials), no UHID, no complaint words. No money anywhere (0058). ER review
  (2026-10-15, DECIDED): the wall has its own permission `er.board.wall` (route `/er/board/wall`, topic `erwall:board`;
  the kiosk `display` role holds only that); police involvement (the chip, a police arrival mode, a police pre-alert's
  mode) never reaches the wall.
- Band and sealed records: the band's name is `patients.displayNameFor` — a sealed record prints its alias unless the
  printing user holds `patients.confidential.read`.
- `link_identity` refuses a deceased true record (`patient_deceased`) and a true record with its own open ER episode
  (`episode_already_open`). `patients.identity_status` is CHECKed (`patients_identity_status_ck`, migration er_arrival);
  `patient_merge` refuses to keep an unidentified record over an identified one (`merge_into_unidentified`).

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

- ER review 2 (2026-10-15, DECIDED as standard practice):
  - `return_er_med` (`er_med_returns`, one per issue; never after a given dose; a returned issue takes no dose). MONEY
    DEFAULT: an UNOPENED unit goes back to ER-SAT on the issue's own batches and its charge line is REVERSED; an OPENED
    unit is WASTAGE — no stock movement (the issue already took it) and the charge STANDS unless the bill desk waives it
    (lane 6). Wasting a high-alert or controlled (`storage_class = narcotic`) drug names a PIN-confirmed witness. A held
    or refused dose prompts the return on the patient screen.
  - Emergency consent: the second doctor confirms with their own username and PIN (`secondDoctor`), never a picked id.
    Every PIN (`secondCheck`, `secondDoctor`, `witness`) is left out of the idempotency request hash.
  - "Resident" = IPD's consultant rule read the other way (`ipd` `isConsultant`: the doctor master plus the roster grade,
    else not a resident role): a doctor who is not a consultant writes drafts; only a consultant co-signs. The seed has
    no `resident` role, so the role check alone never fired.
  - A critical result rings the doctor of record AND the `er_critical` roster target's people at the first notice; the
    climb 15 min later is unchanged. The wall board carries no per-patient critical chip.
  - An answered call keeps the answering doctor's note (`er_specialty_calls.answer_note`).
  - Naming another doctor as the orderer records a verbal order (signature owed, 2-hour bell).

### Lane 5 (er-dispo, #812)
- `dispo.ts` — one disposition per episode (`discharge` | `admit` | `refer_out`) by a doctor with a reason
  (`decideDisposition`, or the exit act itself while `in_treatment` — `decidedIn`); a mismatching act is refused.
  `departIn` is THE way out: re-triage task cancelled, bay released (`ipd.releaseErBayIn`, to cleaning), `departed` +
  outcome, `er.departed`. The departure's paper is one append-only `er_departure_records` row (trigger).
- `handToUnit`: IPD's own intents (`emergencyAdmit` with a bed — needs `ipd.admit`; else `requestAdmission` source `er`,
  `sourceRef` = episode id) with the ER idempotency key, then the ER transaction: `ipd.stampErHandOffIn` (er_arrived_at,
  stabilisedAt), `admission_id`, `boarding_since`. Boarding = `disposition_decided` + `boarding_since`: board chip
  `boarding`, stat. `sweepErBoarding` (minute job) departs the patient once IPD's admission is placed (`leaveForBedIn`:
  ER `er.order` lines carried by `ipd.carryErOrderLinesIn` → `postOrderLineIn`, ER line `moved`), or stops boarding if the
  admission was cancelled (doctor told). ER issue/procedure lines stay on the ER episode (lane 6). A `moved` line's
  later order cancel answers `work_done` (billing reverses on the IP bill).
- `referOut` refuses `cannot_pay` before anything. `recordLama` (doctor or duty manager; a refusal to sign needs a
  different active staff witness). `recordLwbs` (arrived/triaged), `recordAbscond` (security via `er_abscond` ladder,
  fallback security_guard; an MLC also to the duty manager for the police). `recordErDeathIntent`: MCCD number, or an
  MLC with the police intimation met → `patients.recordErDeath` (`death_kind = 'medico_legal'`), mortuary entry
  (`mlc` per the case). 
- Review fixes (#850): the `admission` departure record is written when the patient LEAVES for the bed (one record per
  episode); `departIn` cancels the open IPD request (`ipd.cancelErAdmissionIn` = the cancel intent's body; a deposit on
  account leaves it to the desk); after IPD cancels a hand-off the doctor may re-decide (audited `previous`) or hand off
  again (`hand_off_attempts` → a stable IPD idempotency key; an open request for the episode is adopted, never
  duplicated); a named bed needs `ipd.admit` (`bed_needs_admission_desk`); a moved order cancelled goes through IPD's
  `reverseIpdOrderCharge`; MLC abscond → `er_abscond_mlc` ladder; notice times in IST; ER death on a merged unknown marks
  the canonical record; IPD advice expiry never applies to source `er`; "stabilised" after hand-off re-copies; IPD
  admission view shows "ER arrival"; refer-out decisions with money words refused; the desk may record an abscond.
- Decision to bed: `sweepErBoarding` raises `er_boarding` (skill `er_bed` → duty_manager, the bed manager) 2 h after the
  decision and climbs once at 4 h (`er_boarding` ladder, fallback MS). A specialty refusal (`recordSpecialtyRefusal`) is an
  `er_admission_disputes` row + `er_arbitration` task for the MS; `arbitrateAdmission` (MS only) rules once and closes it.
- Clocks: a departed episode leaves the triage and care clocks (the verbal-order bell now reads open episodes only).
  DECIDED: the MLC clocks keep running after departure — spec §4.4 keeps the countersign (and the intimation) owed.

### Lane 6 (er-bill, #813)
- `bill.ts` — THE ONLY ER FILE THAT HANDLES MONEY (permission `er.bill`: front office, its supervisor, cashier, billing
  manager, duty manager; never a clinician). The ER tariff's own lines are DERIVED, never stored (`visitFeeLines`):
  registration (every visit but brought dead), physician fee (once the ER doctor is named), observation (qty = 6 h blocks
  started after the first 6, until departure). Codes `ER-REG`, `ER-PHYS`, `ER-OBS`, `ER-DRUG` (contracts
  `ER_SERVICE_CODES`); the rates are the UAT SAMPLE fixture (`scripts/fixtures/er-uat-sample-tariff.ts`) until the
  incumbent's arrive (0076: go-live blocked till then). `priceLinesIn`: drugs at Σ batch MRP × units (carrier `ER-DRUG`),
  rate-missing lines re-priced. All pricing as composite healthcare supply.
- Gate: in the department and not stabilised → `not_stabilised` for an advance or a settlement. After departure a bill
  always settles. `composeErBill` splits by payer: self all patient; PM-JAY / BNSS s.397 / MCI event all payer; road
  accident payer up to `cover_cap_paise` for lines within `cover_until` (7 days). An MLC of sexual assault / acid attack is
  BNSS whatever the desk set (`effective`). `settleErBill`: one billing invoice for the patient's share (advances via
  `settleFromReceipts`, tenders as a receipt); dues need the undertaking → `holdUntilPaid` (never credit, 0013); payer share →
  `er_payer_claims` (`to_file`: the TPA desk's seam, `listErClaims`). Admitted episodes: `rolled_to_ip`.
- Roll-over at admission: `rollErLinesIn` (called first in lane 5's `leaveForBedIn`) carries the visit lines and the stored
  issue/procedure lines through IPD's `carryErLineIn` (`ipd.er` lines, component `er`, one per ER line via
  `ipd_charge_lines_er_line_ux`; a missing rate is the IP bill desk's exception); order lines go through lane 5's order seam.
- `stage-er-setup` step d drafts the sample ER tariff (services inactive, a draft version).
- ER review 3 (2026-10-15): a drug is priced at its batch MRP for the PACK the MRP names, spread over the base units
  taken (materials' `packPriceOf` + `saleAmountPaise`), never MRP × base units. At roll-over every ER advance becomes a
  deposit of the admission (IPD `carryErAdvanceIn`, once per receipt) and an issue still without a price rolls over on
  the `ER-DRUG` carrier (the IP desk's exception); an admitted episode takes no further ER advance (`rolled_to_ip`).
- ER review 3, part 2 (2026-10-15, DECIDED): an advance beyond the patient's share at settlement (BNSS at ₹0, a scheme
  that pays all) becomes an `advance_refund` request on the refund desk in the settlement's transaction. Road-accident
  cover is per ACCIDENT (`er_episodes.accident_ref` / `accident_at`, default the scheme reference): a person's episodes of
  one accident share the ₹1.5 lakh cap (what settled episodes drew is subtracted) and one 7-day window (the earliest
  accident time). The window judges each line by the episode time it covers (observation by its 6-hour blocks). A future
  accident time is refused. A dues undertaking is one of the patient's own active documents (`undertaking_invalid`).

### Lane 7 (er-codes, #814)
- `codes.ts` — `callCode` (permission `er.codes`, broad: any staff phone): Code Blue / Code Grey anywhere (a place, no
  patient), the activations (STEMI, stroke, trauma, sepsis, snakebite, obstetric) on an open ER episode; one running code of
  a kind per episode (`er_codes_running_ux`), two codes at once are two rows. THE PAGE is in the call's transaction: a bell
  row per team member (`er.code` / `er.code_grey`), which the platform relays to phones as its content-free "open HMIS"
  (M6b) — the bell names the code and the bay, never the patient. Team (`ER_CODE_TEAM`): the department on take through
  `calloutList`, the ER doctor of record; Code Blue its `code_blue` ladder (fallback anaesthetist); Code Grey the `code_grey`
  ladder only (fallback security guard), with the place, and an incident report drafted on the row.
- `recordCodeEvent`: append-only `er_code_events` (trigger); the first recorder is the scribe; a paper sheet back-filled
  with its time and `fromPaper`; a wrong place is a `location` event, never a new code. `endCode`: a doctor (Code Grey: any
  holder) with an outcome; `recordCodeDebrief`: that leader, once, after the end.
- Clocks (`ER_CODE_CLOCKS`): from the DOOR (`door_at`, the ER gate) — snakebite ASV and obstetric hand-over from the call;
  a `milestone` event meets one. The board tile carries `activations` (`activationClocksFor`). Screens: `/er/codes` (the
  resus scribe), "Code" on the ER patient bar, Code Grey on the triage header.

### Lane 8 (er-mci, #815)
- `mci.ts` — Code Yellow. `declareMci` / `standDownMci` / `mintMciPacks` / `openSurgeBays` need `er.mci` AND the role
  (`ER_MCI_COMMAND_ROLES`: medical_superintendent, duty_manager; refusal `mci_role_needed`). DECIDED (coordinator
  2026-10-15): the MS or the duty manager declares, not the ER consultant of the spec. One running event
  (`er_mci_events_running_ux` + advisory lock `er_mci`); the declaration opens lane 6's event account in the same transaction.
- Packs (`er_mci_packs`): a real UHID per pack (unidentified record, sex unknown), alias `Unknown-MCI26-007` (Hindi
  `अज्ञात-MCI26-007` via `aliasHiOf`), serial per IST year (lock `er_mci_pack:<year>`). The pack's band is printed ahead:
  barcode = the pack number, QR `ERBAND1|<pack no>|<UHID>` — `register_mci_arrival` records it as the episode's live
  `er_bands` row (serial = pack number), so a scan resolves it like any ER band. The arrival asks nothing (default mode
  `ambulance_108`), opens the MLC by rule (`unknown_unconscious`, as lane 1's unknowns), and needs a RUNNING event.
  The episode keeps `alias` with null `alias_year`/`alias_serial` (`ArriveArgs.unidentified` year/serial nullable).
- Tags: `mciTag` (er.mci) — every tag an `er_mci_tags` row (append-only trigger), the episode mirrors `mci_tag`; START
  for adults, JumpSTART for `infant`/`child` age bands (`mciTagProposal` in contracts: the proposal beside the person's
  pick). A Black re-tag needs a reason. The FIRST link to the event sets payer `mci_event` + the event account (lane 6
  then bills nothing patient-payable), unless an `er_bills` row exists.
- Clocks: while the event runs its `arrived` patients are off the door-to-triage sweep (`notInRunningMci` in
  triage.ts); the stand-down puts them back — the sweep raises their `er_triage_due` at once (they are past 5 min).
- Surge bays: `er_mci_surge_beds` (overflow-class beds, the running event). `placeInBay` / `moveBay` pass
  `{ surge: isSurgeBay }` to IPD `placeErEpisodeIn`, which then accepts class `overflow`; `listErBays` lists them while the
  event runs. After the stand-down no one new goes in.
- Reads: `readMciBoard` (counts by tag, packs ready, ER bays, surge bays, ward beds free, patients by alias or initials),
  `readMciCount` (`/er/mci/:id/count`, the district head count — counts only). Screen `apps/web/src/screens/er-mci.tsx`
  (`/er/mci`); the board tile carries `mciTag` (colour and word).
- #877 follow-ups: `declare_mci` pages (same transaction, returns `paged`) everyone on the Casualty roster on duty
  (`ER_ROSTER_DEPARTMENT = "CAS"`), the hospital on-call cover, the MS and duty managers; nobody on the roster = the
  casualty nurses; never the declarer; at most 100 phones. Bell kinds `er.code_yellow` (no patient text) and
  `er.mci_stops`. The declaration raises task `er_mci_stops` (`sourceRef er_mci_stops:<mciId>`) proposing OPD-intake and
  elective-OT stops; `decide_mci_stops` (POST /er/mci/stops) is the MS's alone, once; the answer is stored on the task
  (`cancel_reason` = confirmed / declined + note; no migration). A confirmation rings the duty managers; stand-down
  withdraws an unanswered proposal; nothing in OPD or OT switches off by itself. `readMciFamilyDesk` (GET /er/mci/family,
  the running event else the last stood-down one): name or alias, stage word, place, nothing clinical, plus a fixed
  press/VIP script; MLC, sealed and confidential patients are only counted (OPEN: every pack arrival opens an MLC by
  rule, so pack patients never show there — owner call). Board fields `stops` and `teams` (teams per zone: ER = Casualty
  teams + who is on duty; each surge ward its own zone with the teams homed there).

## 4. Traps
- `registerPatient` takes a `Tx` and the band reads the new patient in that same `tx` (`bandPerson(tx, …)`); reading it
  through `db` (`getPatient`) inside the transaction sees nothing.
- `getPatientSummaries` resolves the merge chain: an unknown whose summary id differs from the episode's `patient_id` has
  been merged — that is how the board knows, without flipping `identity_status` in place.
- The web dev server (`vite`) runs Chromium out of resources on this app (1,000+ modules); browser walks use
  `vite build` + `vite preview` against a stub API.
- Lane 5 moved: seed-roles (+1 `er.disposition`, 4 grants), roster kinds (+`er_abscond`), patients death kinds
  (+`medico_legal`), IPD `request_admission` source `er`, `ipd_admissions.er_arrived_at`, board stats (+boarding, lwbsToday).
- Lane 4 moved: seed-roles (+1 permission `er.mlc`, 6 grants), caddyfile/nav (one menu entry `/er/mlc`), roster
  escalation kinds (+2, check constraint retyped by hand in `kernel/db/schema/roster.ts`), patients (`death_kind`), ipd mortuary register
  (`admission_id` nullable, `er_episode_id`).
- Census pins moved by lane 1: seed-roles (role, pairs, permissions), seed-staff `KNOWN_ROLE_KEYS`, manifests (35;
  app-only list), caddyfile-parity routes (131), standup-check (`emergency` in NOT_DEPARTMENTS, OPEN).

- TRUNCATE is not guarded: the MLC tables' append-only triggers (lane 4) are row-level BEFORE UPDATE OR DELETE only. A
  statement-level TRUNCATE trigger would also stop the test suites' `truncateAll`; DECIDED to leave it (TRUNCATE needs the
  table owner, which only migrations and the test reset hold).

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
- Lane 7 built codes. Still owed: a hospital-wide wall "code" button (any staff phone works today); STEMI door-to-balloon
  read from the cath lab instead of tapped; the code sheet print; Code Grey's incident report filed into a quality
  module (none exists yet: no general incident intake; drafted on the code row today); the scribe tablet's offline queue (paper back-fill is the fallback).
- Lane 8 built Code Yellow. Still owed: designed print of the pack sheet and the head count (the browser prints the
  page); merge of a person registered twice in the rush (after the event, through `link_identity`).
- Lane 6 built the bill. Still owed: the incumbent's real ER rates (0076 go-live blocker); a claim's status flow at the
  TPA desk (#822 reads `er_payer_claims`); MCI tagging of episodes at scale (lane 8 opens the account); printed ER bill.
- DECIDED (coordinator 2026-10-15, to match decision 0075): a REJECTED road-accident claim's difference is NEVER billed to
  the patient automatically — the billing manager decides on recovery. Nothing in the ER bill re-splits a settled bill.
- Lane 5 built disposition. Still owed after lane 5: decision-to-bed climb (`er_boarding` ladder) and the MS arbitration task
  when a specialty refuses; ICU waitlist hand-off; the follow-up OPD visit BOOKED (the summary records department + date);
  designed prints of the summary / referral / LAMA form; an LWBS button on the ER desk (the desk holds the permission; the
  screen is the ER patient's); ER issue and procedure lines carried to the IP bill (lane 6). er-bill: the ER bill following the merge.
- Desk: Aadhaar QR and ABHA scans (lane 1 takes the UHID card barcode, UHID, phone and name); a thermal ER band kind on
  the print relay (the browser prints today, decision 0045's fallback); downtime paper-serial reservation.
- er-copilot: the `pre_alert` Now card; intents declared as copilot tools on the manifest.

## 6. Callers
- API: `EmergencyController` (`/er/*`). Worker: `kernel/worker/jobs.ts` `lapseBedReservations` → `lapseErPreAlerts`.
- Imports: `patients` (registerPatient, getPatient, getPatientSummaries, searchPatients, resolvePatientId,
  listMergedLoserIds, createMergeRequest, getMergeRequest, listAllergies), `ipd` (placedAdmissionOf, initialsOf),
  `billing` (withIdempotency).
