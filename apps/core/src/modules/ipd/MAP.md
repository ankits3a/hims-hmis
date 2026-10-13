---
type: module-notes
title: "ipd — module notes"
description: "Why and traps of the inpatient module: validated bed and ward attributes and the bed-layout loader (E0.3), the bed intents and the Beds board (E1.1), admission — request, plan and deposit from the tariff, admit onto a bed in one transaction, the payer record, the band, the emergency lane and the downtime back-fill (E1.2) — and the running bill: tariff lock, day rule, nightly posting, visit seam, reversals, interim bill (E2.1) — and transfers: start with an SBAR handover, accept by the receiving nurse, cancel, the atomic swap and the class change in place at the next noon (E3.1)."
resource: apps/core/src/modules/ipd
tags: [ipd, beds, resources, admission, billing, transfer]
generated: { by: agent:claude, at: 2026-10-12 }
verified: []
stale_after: 2027-01-12
---
# ipd — module notes

Hand-written notes: the WHY and the traps. Signatures are generated in `docs/architecture/modules/ipd.md`.
Paths are relative to `apps/core/src/modules/ipd/` unless they start with a module name, `kernel/`, `scripts/`,
`packages/` or `apps/`. Citations name a file and a symbol, never a line number. The spec is
SPEC-ipd-core-2026-10-12 §4.1 (kept outside the repository); the plan is decision 0072, issue #715 (E0.3).

## 1. Purpose
The inpatient module. E0.3 starts it with the BED REGISTRY: every floor, ward, hall, room and bed of the
hospital as rows of the kernel resource registry (`kernel/resources`), with IPD's own facts about a bed and a
ward kept in `resources.attributes`. Later lanes add the bed board, admission, transfer, nursing and discharge.
E1.1 (#718) adds the module surface: `manifest.ts` (four `ipd.beds.*` permissions, the Beds menu), `IpdModule`
(the bed routes under `/ipd/beds`, the live topic `ipd_beds:board`) and the bed intents behind the Beds board.

## 2. Key files (owner of what)
- `bed-attributes.ts` — `IpdBedAttributesSchema` (class, gender rule, isolation, negative pressure, ICU flag,
  equipment, day care, overflow) and `IpdWardAttributesSchema` (department code, unit type, ward or hall). The
  rules live in the schema's refinements: airborne needs negative pressure; class `overflow` ⇔ `overflow: true`;
  class `daycare` ⇔ `daycare: true` (DECIDED, E0.3); no equipment tag twice.
- `bed-layout.ts` — `parseBedLayoutCsv` (header row 1; refuses missing or unknown columns), `validateBedLayout`
  (pure: rows → plan or every problem), `loadBedLayout` (diff and, with `apply`, write in one transaction) and
  `formatBedLayoutReport` (the dry-run summary).
- `errors.ts` — `IpdError`; `bed_layout_invalid` carries `detail.problems`.
- `packages/contracts/src/ipd-bed-classes.ts` — `IPD_BED_CLASSES` and `IPD_BED_CLASS_INFO` (census and rates
  flags). Shared with the rate card lane: do not rename its exports.
- `scripts/load-bed-layout.ts` — `runBedLayoutLoad`: `--file`, `--by`, `--apply`. Not a seed.
- `scripts/data/gen-ipd-bed-layout.ts` — `planningBedLayoutCsv` writes `scripts/data/ipd-bed-layout.planning.csv`.
- `beds.ts` (E1.1) — the bed intents: `reserveBed`, `releaseReservation`, `assignBed`, `blockBed`, `unblockBed`,
  `markBedClean`, `releaseIncumbentBed`; the bed-master act `retireBed`; the job `lapseBedReservations(db, now)`;
  the seams `releaseBedOccupant(tx, …)` (discharge/transfer empty a bed through it) and `markBedCleanIn(tx, …)`
  (housekeeping's task completion calls it); the cutover `markIncumbentBeds`; `nextRuleValidBeds`.
- `bed-rules.ts` — `checkBedRules`, the one pure rule check every bed act and (later) every Bed Flow proposal asks.
- `beds-board.ts` — `readBedBoard(db, actor, { wall })`, the board's read model (`IpdBedBoard` in contracts).
- `bed-events.ts`, `realtime.ts`, `beds.controller.ts`, `ipd.module.ts`, `manifest.ts`.
- `kernel/db/schema/ipd.ts` — `ipd_bed_reservations`, `ipd_bed_blocks`, `ipd_bed_stays` (migration `ipd_beds`).
- `packages/contracts/src/ipd/bed-board.ts` — board schema, routes, topic, `IpdRefusalBody`.
- `scripts/mark-incumbent-beds.ts` — `--file`, `--by` (holds `ipd.beds.manage`), `--apply`. Not a seed.
- `apps/web/src/screens/ipd-beds.tsx` — the board (route `/ipd/beds`, `?wall=1` for wall displays).

- `admissions.ts` (E1.2) — `requestAdmission`, `cancelAdmission`, `admit`, `emergencyAdmit`, `backfillDowntime`,
  `recordConsent`, `recordStabilised`, `incompleteOf`. `admission-core.ts` — lock/read, `moveAdmission` (workflow
  instance + mirror in one tx, engine refusals → IPD words), `mintAdmissionNo` (`IP26-000123`), and the links the bed
  intents call (`linkReservation`, `linkReservationEnded`, `linkPlacement`).
- `deposit.ts` — `IPD_DEPOSIT_POLICY` (decision 0072's days and percentages), `quoteDeposit` (pure), `planAdmission`,
  `takeDeposit` (thin wrapper over billing `recordReceipt`), `ipdNonPayableDepositCode`.
- `payer.ts` — `recordPayerAuth` (the manual authorisation record). `bands.ts` — `printBand`, `reprintBand`,
  `allergyWords`. `approval-types.ts` — the three IPD approval types and `registerIpdApprovalTypes` (go-live step).
- `admission-read.ts` — the desk's reads (view, quotes, bed proposals, OPD advice, consultants, `askApproval`).
- `admissions.controller.ts` — `/ipd/admissions/*` (`IPD_ADMIT_ROUTES`). `admission-events.ts` — the events.
- `kernel/db/schema/ipd.ts` — `ipd_admissions`, `ipd_payer_auths`, `ipd_admission_deposits`, `ipd_bands` (migration
  `ipd_admit`). `packages/contracts/src/ipd/admissions.ts` — read models and routes.
- `apps/web/src/screens/ipd-admit.tsx` — the Admit sheet (`/ipd/admit`, `?admission=<id>`); the Beds board's waiting
  column links to it.

- (E2.1) `charge-days.ts` — `ipdChargeableDays(stays, admittedAt, dischargedAt, upToIstDate)`, the pure day rule;
  `rentClassOf`, `classRank`. `charges.ts` — `postAdmissionCharges` (one admission up to a day), `postNightlyIpdCharges`
  (the job), `postConsultantVisit(tx, …)` (the rounds seam), `reverseChargeLine`, `priceComponent`. `interim-bill.ts` —
  `readInterimBill`. `charge-events.ts` — `ipd.charge.rent_posted` (G5b), `.visit_recorded`, `.exception_raised`,
  `.reversed`. `kernel/db/schema/ipd.ts` — `ipd_charge_lines`, `ipd_charge_exceptions`, `ipd_admissions.tariff_version_id`
  (migration `ipd_charges`). `packages/contracts/src/ipd/charges.ts` — `IpdInterimBill`, `IPD_CHARGE_ROUTES`.
  `apps/web/src/screens/ipd-bill.tsx` — the interim bill (`/ipd/admissions/$admissionId/bill`, no nav entry).

- (E3.1) `transfers.ts` — `startTransfer`, `acceptHandover`, `cancelTransfer`, `swapBeds`, `changeClass` (the intents) and
  `listHandovers`, `transferOptions` (the reads). `class-change.ts` — `nextNoonIst`, `applyClassChanges` (pure: splits a
  stay at its class change), `classChangesOf`. `transfer-events.ts` — `ipd.transfer.started|accepted|cancelled`,
  `ipd.bed.swapped`, `ipd.admission.class_changed`. `transfers.controller.ts` — `/ipd/transfers/*` (`IPD_TRANSFER_ROUTES`).
  `beds.ts` seams: `lockBedsInOrder`, `holdBedForTransferIn`, `endHoldIn`, `vacateBedForSwapIn`, `bedWithWard`.
  `kernel/db/schema/ipd.ts` — `ipd_transfers`, `ipd_class_changes` (migration `ipd_transfer`).
  `packages/contracts/src/ipd/transfers.ts` — `IpdHandoverList`, `IpdTransferOptions`, `IPD_IN_PLACE_CLASSES`,
  `IPD_TRANSFER_HOLD_MINUTES`; `cancel_transfer` joins the intent catalogue (`packages/contracts/src/ipd/intents-ward.ts`).
  `apps/web/src/screens/ipd-transfer-panel.tsx` (the Beds drawer's Transfer panel) and
  `apps/web/src/screens/ipd-handovers.tsx` (`/ipd/handovers`).

## 3. Invariants
- A bed is a kernel `bed` row. No new resource kind, no kernel edit, no migration: the attributes are jsonb,
  validated here, and only the keys the schemas name are written. Other keys on a row are kept.
- The loader validates the WHOLE file first. One bad row refuses the file, every bad row is listed by its
  spreadsheet row number, and nothing is written.
- Idempotent upsert by code (`resources_site_kind_code_lower_ux`: site, kind, lower(code)). A second run of the
  same file writes nothing: no row, no history, no event.
- The loader never deletes, retires, moves or revives. An IPD bed (a bed row whose attributes carry `class`)
  missing from the file is reported as "not in file" and left alone. A code already used by a place under a
  different parent, or by a retired place, refuses the file: moving and un-retiring are a person's acts.
- Dry run is the default and needs no permission. Applying needs `auth.users.manage` (DECIDED until the bed
  board declares IPD's own bed-master permission): `bed-layout.ts` `BED_LAYOUT_PERMISSION`, checked inside
  `loadBedLayout` (`bed_layout_forbidden`) and by the script's `--by`.
- The parser refuses a duplicate header name and any row whose cell count differs from the header's.
- An occupied bed's class, gender rule, isolation, ICU, day-care or overflow attribute never changes by file
  (`bed_occupied` refuses the file); equipment may. E1.1 keeps holds in
  `ipd_bed_reservations`, not a kernel status: the loader does not yet refuse a rule change on a held bed (owed).
- A ward and a hall may not share a code (`ward_hall_collision`), though the registry's index would allow it.

### Beds (E1.1)
- An intent is ONE function: parse the contract's zod input → re-check the permission (`ipd_forbidden`) → run
  under the contract's idempotency key (`withIdempotency`, route `ipd:<intent>`) → lock → re-check state and rules
  → write + event. A refusal is `IpdRefusal` (contract code, `rule`, `fix`, `bedRule` such as "Female-only bed",
  `detail`); HTTP 404 for `*_not_found`, 403 for the overflow gate, 409 otherwise (`IpdRefusalBody`).
- LOCK ORDER: the admission (advisory xact lock on `ipd_admission:<id>`, reserve/assign), then the bed's parent
  (room or ward) FOR UPDATE, then the bed, then IPD rows — `releaseBedOccupant` and the incumbent marker too (its
  dry run takes no lock). An open-stay unique violation maps to `admission_wrong_state`, never a 500. The parent lock serialises a
  twin room's two beds (gender fixed by the first occupant or holder until empty) and is also what makes two desks
  racing for one bed answer "bed just taken" with `detail.nextBeds` instead of the kernel's raw `already_occupied`.
- Kernel statuses only. Reserved = kernel `available` + an active `ipd_bed_reservations` row (partial unique: one
  live hold per bed). Blocked = kernel `blocked` + an active `ipd_bed_blocks` row; on an occupied bed the block is
  `pending_release` and `releaseBedOccupant` applies it. Occupant triad: `ipd_admission` / admission id, with the
  patient and billed class on the open `ipd_bed_stays` row (partial unique per bed and per admission). Incumbent:
  occupant `incumbent`/`incumbent` + `attributes.incumbent: true` (+ optional `incumbentGender`).
- Room gender comes from `placed_as` on open stays and live holds (and `incumbentGender`); a first holder with no
  recorded gender locks the room as unknown (`room_gender_unknown`, "Room gender not recorded — set it first").
- A hold past `expiresAt` is lapsed inline by any act that meets it (`currentHold`), not only by the minute job.
- DECIDED: a hold may be placed on an available OR cleaning bed; assignment needs `available`. One live hold per
  admission (a new one ends the old as `plan_changed`); assignment consumes the admission's own hold.
- The lapse is `lapseBedReservations(db, now)`, every minute (`kernel/worker/jobs.ts`), system actor
  `ipd-reservation-lapse`, provenance `system`, idempotent; it never ends a hold whose `expiresAt` is after `now`.
- Every event payload carries `provenance` (G11b) and, with an admission, `admissionId` (G2). Moves into cleaning
  carry `clean:routine` / `clean:terminal` (G3). Payloads carry ids only: the gateway fans them to every viewer.
- Board counts: census = class `inCensus` and not overflow; overflow apart; day care/emergency outside both.
  Wall mode sends initials only (`occupant.name` null, block notes blank).
- Overflow beds need `ipd.beds.overflow` (duty manager) — `overflow_needs_duty_manager`, checked before any rule.
- DECIDED rule details: child = under 14 on the day (no DOB → not refused on age); paediatric/NICU/PICU beds refuse
  adults; adult ICU and gender-segregated general beds refuse children; isolation rank none<contact<droplet<airborne
  and airborne also needs negative pressure; ward classes general→suite swap only with a flagged upgrade/downgrade
  in that direction; ICU flag must match both ways; gender = administrative gender, `need.placeAs` for other/unknown.
- Until ipd-admit: `admissionId` is the caller's request id and the bed intents carry `patientId` + `need`; ipd-admit
  derives both from the admission. `reserve_bed` does not yet emit `ipd.admission.reserved` (no admission record).

### Admission (E1.2)
- ONE workflow instance per admission (`ipd_admission` definition, Class A): `ipd_admissions.state` mirrors it and
  every move goes through `moveAdmission` in the same transaction. The workflow checks ROLES (front_office,
  front_office_supervisor, duty_manager for desk acts; doctor for requests); the intent checks PERMISSIONS. A user with
  the permission but none of those roles is refused `ipd_forbidden` by the engine.
- One open admission per patient: checked first (refused `admission_already_open` with the first admission in
  `detail`) and enforced by the partial unique index `ipd_admissions_open_patient_ux`; a lost race maps to the same
  refusal (the insert runs in a savepoint).
- `admit`, `emergencyAdmit` and `backfillDowntime` place the patient through `assignBedIn` INSIDE their own
  transaction (bed rules re-checked under the bed lock); `admit` judges plan, ICU approval and deposit on the LOCKED
  row. LOCK ORDER: every act on an admission first takes its advisory lock (`admissionAdvisoryLock`, shared with the
  bed intents and taken by `lockAdmission`); then placing acts take room → bed → admission row, `cancelAdmission`
  takes the row → the beds of its holds, money acts take the row → billing's rows.
- Money: every rupee comes from the active tariff (`IPD_<ROOM|NURSING|VISIT>_<CLASS>`; cashless non-payables
  `IPD_NONPAY_DEPOSIT_<CLASS>`). A missing component refuses `rate_missing` with `detail.class`, `detail.missing`,
  `detail.serviceCodes` — only when the DEPOSIT needs the missing rate (a ₹0 basis stands, estimate shown as n/a).
  Deposit = 3 class days (ICU 3 ICU days), surgery 50 % of the typed estimate, PM-JAY/state scheme ₹0, emergency
  before stabilisation ₹0, downtime back-fill `downtime_backfill` (paper; `deposit_check_pending` until the bill desk
  takes or checks it — `GET /ipd/admissions/deposit-checks`). DECIDED: the surgery share rounds UP to the whole rupee
  (deposits are collected in whole rupees). A payer change re-quotes the deposit. Doctor outputs carry no money (0058).
- `takeDeposit`: the billing receipt (`recordReceiptInTx`) and the link commit in ONE transaction; the intent's
  idempotency key is a unique column on the link, so a retry finds the committed pair and never takes money twice.
- Scheme cap: Σ GRANTED non-covered approvals (each names its amount) ≥ Σ every receipt of the patient since the
  request (entered-in-error excepted), checked under the admission row lock — on the desk's deposit AND on billing's
  generic receipt route via the receipt guard (`registerIpdReceiptGuard`, registered by `IpdModule`; billing's seam
  `registerReceiptGuard`). A cancel with a deposit still on account refuses `deposit_not_refunded`.
- `admit` needs a receipt linked to the admission covering `depositRequiredPaise`, or an exemption matching the plan's
  basis (scheme, emergency, cashless at ₹0) or a granted `ipd_deposit_waiver` approval.
- ICU class (icu, nicu, picu — HDU is not ICU) needs a GRANTED `ipd_icu_admission` approval on the admission. The
  emergency lane asks first (`askEmergencyIcuApproval` mints the admission id the approval names) and admits under it. Approvers: medical_superintendent or an `intensivist` role holder.
- A scheme patient's receipt needs a granted `ipd_non_covered_line` approval on the admission, and at most its amount.
- Band QR/barcode carry the band SERIAL (`<IP no>-<n>`); one live band per admission (partial unique); a reprint voids
  the old one with its reason. Allergies print in words; "Allergy: none recorded" when none.
- Downtime back-fill keeps the paper's request and admission times on the row, the stay and the events; the paper
  serial is upper-cased and unique.

### Running bill (E2.1)
- TARIFF LOCK: every admit path (`admit`, `emergencyAdmit`, `backfillDowntime`) records the version in force at the
  admitted instant in `ipd_admissions.tariff_version_id`; every charge prices from it through the tariff engine
  (`loadPricingContext({ tariffVersionId })` + `priceInvoiceLines`), so a later revision never reaches the stay and a lower
  regulated price still wins. Null (no tariff active, or admitted before E2.1) → the version in force at `admitted_at`,
  else a `tariff_missing` exception.
- LINES ARE NOT A BILLING INVOICE. Billing's invoices are issued, numbered, immutable documents with one live invoice per
  encounter; a running bill cannot live on one. Lines go to `ipd_charge_lines` (append-only: a trigger refuses UPDATE and
  DELETE) with their price frozen at posting; the final bill (E3.2) composes ONE invoice from them, the OT
  `composeDischargeBill` pattern (DECIDED). No billing or tariff signature changed.
- DAY RULE (DECIDED, see `charge-days.ts`): IST midnight to midnight; admission day billed whatever the hour; discharge
  day free up to 14:00 IST inclusive; highest class held MORE than an hour that day, else the longest; an ended stay under
  an hour is transit and dropped; the stay's `billed_class` (protected/booked) wins over the bed's; overflow bills general;
  daycare, emergency and LDR carry no rent; general < … < suite < hdu < icu = nicu = picu; home leave keeps billing.
  Review #756: overlapping stays are clipped to the previous stay's end first; when EVERY stay is under an hour none is
  dropped (minimum one day — admit 10:00, leave 10:30 bills that day at the stay's class).
- DECIDED (review #756): a day spent on an LDR, day-care or emergency bed posts no rent, nursing or RMO — those beds
  carry packages and services, not daily rates.
- IDEMPOTENCY IS THE DATABASE: partial unique indexes — one `ipd.nightly` line per (admission, service date, component),
  one `ipd.visit` line per (admission, date, consultant), one reversal per line. Inserts are `on conflict do nothing`;
  `ipd.charge.rent_posted` goes out only with a room line that was actually inserted, so G5b sees one per night.
- MISSING RATE: no item on the locked version, ₹0, or the service absent or SWITCHED OFF → required components (room,
  nursing, visit) raise one `ipd_charge_exceptions` row per key (event once) and post nothing; `rmo` is skipped silently;
  `cross_visit` falls back to `visit`. A later run that can price it posts the line and resolves the row.
- NIGHTLY JOB: `postNightlyIpdCharges(db, now)`, `dailyIst` 00:05; admissions in a bed plus ENDED ones whose
  `charges_posted_through` is short of the discharge day or that have an open exception (no age window); posts every
  unposted day up to YESTERDAY (a missed night is caught up with its own dates). One transaction per admission; the
  admission and stays are RE-READ under its advisory lock before the days are computed; a null tariff pin is resolved
  and persisted in that transaction. A DOMAIN failure (IPD/tariff/zod error, SQLSTATE 22/23) becomes a `posting_failed`
  exception (`error_code`, `fail_count`); at 3 consecutive the job skips the admission until `retryAdmissionCharges`
  (billing manager) resolves it. Only infrastructure errors fail the run. Today is never posted.
- VISITS: `postConsultantVisit(tx, { admissionId, consultantUserId, seenAt, source: "rounds_tap" })` — a consultant is a
  user with an ACTIVE `opd_doctors` row (residents are not on it → not charged); first tap per IST day posts, repeats post
  nothing; every tap emits `ipd.charge.visit_recorded`. Not the admitting/covering consultant → `cross_visit` (else `visit`).
  Class = billed class of the bed held at `seenAt` (no-rent bed → general, DECIDED). The answer carries no money.
  A REVERSED visit does not count: the day can be charged again, the new line taking the next `visit_seq` (the visit
  unique index is (admission, day, consultant, visit_seq) — a partial index cannot see another row's reversal).
- REVERSAL: `reverseChargeLine` (`ipd.charges.reverse`, billing_manager; HTTP `POST /ipd/charge-lines/:id/reverse`,
  `charges.controller.ts`, reason required) inserts the negated twin with a reason (zero-net lines too; a lost race on
  the unique index answers `charge_line_already_reversed`); a
  reversed nightly line is NOT re-posted by the job (its key is spent) — the corrected charge is the bill desk's (E2.3).
- DEPOSIT on the interim bill (`depositHeldPaise`): Σ deposit receipts (entered-in-error excepted) − the patient's
  advance refunds issued since the request, floored at 0 (billing refunds advances per patient, not per receipt).
- MONEY OFF DOCTORS (0058): `ipd.bill.view` (front office, its supervisor, duty manager, cashier, billing manager, owner)
  gates the interim bill; charge events carry ids and dates only; acceptance (viii) pins the doctor-reachable IPD routes and
  scans their answers for money keys.

### Transfer (E3.1)
- A transfer is complete ONLY at `acceptHandover` by a person other than the sender (`sender_cannot_accept`). Until
  then the patient's stay and the origin bed (kernel `occupied`, occupant = the admission) are untouched and the target
  is an ordinary `ipd_bed_reservations` hold (12 h, `IPD_TRANSFER_HOLD_MINUTES`) — every other act sees it held.
- Accept is ONE transaction: `releaseBedOccupant` on the origin (cleaning; `clean:terminal` when the admission is
  isolated), `assignBedIn(viaAdmit)` on the target (consumes the hold, re-checks every rule under lock, opens the stay
  at the bed's class), `transferring → admitted`, one `ipd.transfer.accepted { transferId, admissionId, … }` (the passes
  lane consumes it by that name). A retry with the same key answers the first result; another accept is
  `transfer_not_open`.
- The 30-minute escalation is NOT a job: the admission workflow's `transferring` SLA (30 min, ladder 100 % →
  `nursing_supervisor`); with nobody in that role the kernel's rung falls back to `duty_manager` (`resolveRung`).
  `ipd_transfers.escalates_at` copies the rung's due instant for the handover clock.
- `cancel_transfer` (DECIDED, §4.4 "cancel back") rides the workflow's single `transferring → admitted` edge (the engine
  allows one edge per pair), so its workflow roles are `accept_handover`'s; either transfer permission may cancel.
- LOCK ORDER for two beds/two admissions: advisory locks in admission-id order → `lockBedsInOrder` (all parents in id
  order, then all beds in id order) → admission rows in id order → IPD rows. A one-bed act (parent → bed) cannot cycle
  with it.
- A swap vacates both beds with kernel reason `swap` (not `clean:*`: G3 never counts it) straight back to `available`,
  then places each patient with `assignBedIn(viaAdmit)`; any refusal or failed write rolls both back (acceptance iii
  injects a trigger failure). A bed with a block waiting for release cannot take a swap.
- A transfer's need = the admission's isolation and gender + the TARGET bed's class and ICU flag, so a clinical move
  never needs a class consent; onto an ICU bed from a non-ICU bed needs a granted `ipd_icu_admission` approval.
- CLASS CHANGE IN PLACE (`changeClass`, permission `ipd.admit`): ward room classes only (`class_not_ward`), consent in
  the admission consent's shape, upgrade needs `roomRentCapAcknowledged`. It is a row in `ipd_class_changes`, never a
  future-dated stay; `charges.ts` `staysOf` folds it in (`applyClassChanges`) so the day rule decides the noon day
  (highest class held over an hour). It binds its stay: a move before noon leaves it behind. A newer change supersedes
  one not yet in effect.
- Permissions (DECIDED): `ipd.transfer.start` and `ipd.transfer.accept` are held by `duty_manager` alone until the
  ipd-nursing lane seeds `ward_nurse` / `nursing_supervisor` (the workflow already names those roles); the duty manager
  is also an `accept_handover` actor in the contract.

## 4. Traps
- `docker/prod/deploy.sh` runs every seed on every deploy. The loader is a script a person runs; never wire it
  into a seed.
- PLANNING LAYOUT from the confirmed bed split; the hospital's real room list replaces it. The workbook is
  1,150 beds (720 wards, 240 critical care, 50 NICU/SNCU, 20 LDR, 60 day care, 60 emergency); the rest of the
  1,200 is dialysis stations and theatres, which are not beds. Edit the generator, regenerate, commit both:
  `test/ipd-bed-layout-planning.test.ts` compares the file to the generator byte for byte.
- `scripts/data/` must hold only `.ts` files except files a script takes as an argument
  (`test/scripts-data-compiles.test.ts` `TAKEN_BY_ARGUMENT`); the planning CSV is listed there.
- Codes are unique per kind across the whole site, not per ward: a bed code must carry its ward
  (`F05-ORT-M-B12`), or two wards' "B12" collide. OT recovery bays are kernel `bed` rows too; their codes are
  not IPD's, and a clash refuses the file rather than adopting the bay.
- The loader writes ~1,600 rows through `createResource` (history row and event each). The planning workbook
  takes ~10 s on the build host; the acceptance tests give it 300 s.

- (E1.1) The kernel has no HTTP retire route; `retireBed` is the only retire that knows reservations. A script or
  module calling `retireResource` on a bed directly bypasses the "retired while reserved" refusal.
- (E1.1) `nextRuleValidBeds` does not re-derive each candidate's room gender (a proposal, not an act): the act
  re-checks under lock.
- (E1.1) A new scheduler job owes five censuses: `kernel/worker/jobs.test.ts`, `kernel/worker/scheduler.test.ts`, `test/alerts-parity.test.ts`,
  `test/worker-runtime.e2e.test.ts` and `docker/prod/prometheus/alerts.yml`.
- (E1.1) The bed-layout loader still applies with `auth.users.manage` (`BED_LAYOUT_PERMISSION`); moving it to
  `ipd.beds.manage` is owed.

- (E1.2) GO-LIVE STEPS, not seeds: the `ipd_admission` workflow definition must be drafted, approved (owner + MS) and
  activated, and `registerIpdApprovalTypes(db, activator)` run. Until then every request answers
  `admission_workflow_inactive` (503) and an approval request `approval_type_missing`.
- (E1.2) The bed intents still accept a request id with NO admission row (the approved E1.1 acceptance tests use
  one); with a real admission they check the caller's patient and need against the row (`state_changed`). So
  `ipd_bed_reservations.admission_id` / `ipd_bed_stays.admission_id` still have no FK to `ipd_admissions`.
- (E1.2) The thermal relay has no `ipd_wristband` print document (a kernel print-outbox edit, owed): the band
  prints from the desk's browser at band size; a named `printerId` is only checked to be alive.

- (E2.1) GO-LIVE: the rate card lane creates the IPD services INACTIVE (so `validateTariffConfig` stays green); the
  charges treat an inactive service as a missing rate. At cutover the priced IPD services must be switched on (a
  person's act in the tariff screen; no script yet — owed), or every day lands as an exception.
- (E2.1) SEAMS LEFT OPEN: pharmacy issue/return posting (§4.3) is not here — it will post its own source into
  `ipd_charge_lines` (add a source value and its idempotency index); ward consumables by scan likewise. Payer split and
  the room-rent cap are E2.2; deposit ladder and bill desk E2.3; the final bill E3.2 (`postAdmissionCharges` up to the
  discharge day, then compose the invoice).
- (E2.1) The transfer and discharge lanes do not exist yet: the acceptance tests write class moves and the discharge
  directly into `ipd_bed_stays` / `ipd_admissions` (`test/helpers/ipd.ts` `mkChargesWorld`).

- (E3.1) SEAMS LEFT OPEN: `not_receiving_ward` is not enforced (no nurse-to-ward assignment yet — ipd-nursing); the porter
  task is the transport lane's `requestPatientMove` (comment in `startTransfer`); the room-rent cap warning TEXT on an
  upgrade is the payer lane's (E2.2) — the intent only checks the acknowledgement; death mid-transfer
  (`transferring → deceased`, ipd-discharge) must cancel the open `ipd_transfers` row and its hold.
- (E3.1) The kernel workflow stamps state entry with the real clock, so the escalation rung is at real-now + 30 min
  even when an act is called with an explicit `now` (tests read the rung's `due_at` and drive `runDueTimers` around it).

## 5. Callers
- `scripts/load-bed-layout.ts` (operator).
- `beds.controller.ts` (the web board), `kernel/worker/jobs.ts` (`lapseBedReservations`),
  `scripts/mark-incumbent-beds.ts` (cutover). ipd-admit, ipd-transfer, ipd-discharge and housekeeping call
  `assignBed`/`reserveBed`, `releaseBedOccupant` and `markBedCleanIn`.
- (E1.2) `admit`/`emergencyAdmit`/`backfillDowntime` call `assignBedIn` and `endAdmissionHolds`; the Beds board reads
  open requests for its waiting column (`beds-board.ts`); ipd-charges (E2.1) reads `ipd_admissions` (payer, deposit)
  and `ipd_admission_deposits`; eMAR resolves band serials against `ipd_bands`.
- (E2.1) `kernel/worker/jobs.ts` (`postNightlyIpdCharges`, daily 00:05 IST); the rounds lane calls `postConsultantVisit`;
  the final bill (E3.2) calls `postAdmissionCharges`; `admissions.controller.ts` serves `readInterimBill`.
- (E3.1) `transfers.controller.ts` (the Beds drawer's Transfer panel, the `/ipd/handovers` list); the passes lane consumes
  `ipd.transfer.accepted`; `charges.ts` reads `ipd_class_changes` through `classChangesOf`.
