---
type: module-notes
title: "transport — module notes"
description: "Why and traps of porters and patient movement on the task engine: the request row beside the task, the escort rule and the oxygen check enforced inside the engine's start, the wristband handover inside its done, the merge rule, the porter's card details and the supervisor board."
resource: apps/core/src/modules/transport
tags: [transport, tasks, ipd]
generated: { by: agent:claude, at: 2026-10-13 }
verified: []
stale_after: 2027-01-13
---
# transport — module notes

Hand-written notes: the WHY and the traps. Signatures, routes and tables are generated in
`docs/architecture/modules/transport.md`. Paths are relative to `apps/core/src/modules/transport/` unless they
start with a module name, `kernel/`, `scripts/`, `packages/` or `apps/`. Citations name a file and a symbol, never a
line number. Spec: SPEC-ipd-companions §6, §10, §11 and SPEC-ipd-core §4.4 (kept outside the repository);
issue #723, decision 0072.

## 1. Purpose
Porters. A patient move (admit, transfer, imaging, OT, discharge, other), a sample run or a document run is ONE task on
the shared engine (`modules/tasks`) plus ONE `transport_requests` row with what the engine does not know: to where, how
(mode, oxygen, monitor, isolation), the escort, the cylinder check and the handover. Three rules, all intent-enforced:
- a critical patient's move cannot START without a nurse or doctor escort recorded (`escort_required`);
- an oxygen move cannot START before the cylinder check (`oxygen_not_checked`);
- a move is DONE only with a wristband scan of the SAME admission (`wrong_patient`, `band_unknown`, `band_void`).
The IPD transfer itself is still accepted by the receiving nurse (ipd-transfer, SPEC-ipd-core §4.4) — not here.

## 2. Key files (owner of what)
- `kinds.ts` — `defineSkill("porter" → support_staff)` and the three kinds: `patient_move` (5/30 min, proof `scan`,
  ladder 0/+15, hooks `beforeStart: patientMoveMayStart`, `beforeDone: patientMoveHandover`), `sample_run` and
  `document_run` (5/20 min, proof `tap`). All escalate to `services_supervisor`.
- `guards.ts` — the two hooks, `requestOfTask`, `escortNeeded` (the request's flag OR the risk seam NOW).
- `risk.ts` — `isHighRiskForTransport(admissionId)`: THE SEAM the nursing lane fills (NEWS2/MEOWS/PEWS high band,
  infusion running). Today: an ICU/HDU/NICU/PICU bed (ipd `admissionForTransport`).
- `requests.ts` — `requestTransport`, `requestPatientMove` (for IPD lanes, inside their transaction), `addEscort`,
  `recordOxygenCheck`, `escortCandidates`.
- `reads.ts` — `transportDetails` (porter's card), `transportBoard` (wall), `patientOptions`, `placeOptions`.
- `transport.controller.ts`, `manifest.ts` (`transport.request`, `.work`, `.manage`), `names.ts` (`ESCORT_ROLE_KEYS`).
- Schema `kernel/db/schema/transport.ts` — `transport_requests` (migration `*_transport_requests.sql`).
- ipd seam `ipd/transport-seam.ts` — `admissionForTransport`, `movableAdmissions`, `resolveBandScan`,
  `CRITICAL_CARE_BED_CLASSES`.
- Contracts `packages/contracts/src/transport.ts` (kinds, enums, inputs, refusals, wire shapes, routes).
- Web: `apps/web/src/screens/transport-card.tsx` (inside "My tasks"), `apps/web/src/screens/transport-request.tsx`
  (`/transport/request`), `apps/web/src/screens/transport-board.tsx` (`/transport`), `apps/web/src/screens/transport.css`,
  `apps/web/src/lib/transport-api.ts`.
- Tests: `acceptance/transport.acceptance.test.ts`; fixture `apps/core/test/helpers/transport.ts`.

## 3. Main flows
### 3.1 Request
`requestTransport`: a patient move needs an open, MOVABLE admission (admitted, transferring, fit_declared,
discharging); FROM defaults to its current bed; TO is a register place (ward, hall, room, theatre) or a typed note.
`escort_reason` = `critical_care_bed` (risk seam) > `high_risk_flag` (requester) > `requested`; any → escort required.
Then `raiseTask` (kind, place = FROM, patient) in the same transaction, then the row. Merged into an open task →
the existing row is kept and the flags are OR-ed (oxygen, monitor, escort): a second asker is never ignored.

### 3.2 The porter's road (the engine's doors, `/tasks/:id/...`)
Accept → (Add escort, Cylinder checked: `/transport/tasks/:id/escort`, `/oxygen-check`, before Start only) → Start
(`beforeStart`) → Done with `{ proof: { kind: "scan", code } }` (`beforeDone`). The code is the band's Code 128 serial
or its QR `IPDBAND1|<serial>|<uhid>`; a handheld scanner types it into the field.

## 4. Invariants and traps
- **Linked by `task_id`, not `source_ref`.** The engine's `sourceRef` skips the ten-minute merge window, and the merge
  is a done-means check (same patient asked twice merges; a different patient never — the engine's merge key includes
  the patient). `sourceRef` is passed through ONLY when a caller gives one (an IPD intent's retry key).
- **The rules live in the engine's transaction**, not at transport's doors: a porter using `/tasks/:id/start` directly
  is refused the same way. A hook throws a `TransportRefusal`, which is a `TaskKindRefusal` — both controllers map it to
  `{ code, message, fix }`.
- **Escort need is re-checked at Start** (`escortNeeded`): a patient moved into an ICU bed after the request still
  needs one. The escort is an active user holding a role in `ESCORT_ROLE_KEYS` and is not the porter.
- A `patient_move` raised through the generic `/tasks` door has no transport row: Start refuses `not_transport`.
- Handover order: unknown band → `band_unknown`; another admission's band (live or void) → `wrong_patient`; the
  patient's own replaced band → `band_void`. A refused WRONG-PATIENT handover is a safety event: after the rollback the
  engine runs the refusal's `afterRefusal` in its own transaction (`recordRefusedHandover`) — the scan is appended to
  `transport_requests.handover_refusals` and every services supervisor and duty manager gets a
  `transport.handover_refused` bell.
- **No patient on the wall.** The board shows bed/place names, the porter's initials and the escort state in words;
  the porter's OWN card shows the patient's name (sealed if confidential) and IP number — they fetch the patient by them.
- The worker imports the module (side effect only) so the clock knows the kinds; nothing is installed there.

## 5. Who calls transport
- kernel: `app.module.ts` (`TransportModule`), `kernel/modules/manifests.ts`, `kernel/worker/worker.module.ts` (import).
- Planned: ipd-admit / ipd-transfer / ipd-discharge / OT / imaging call `requestPatientMove(tx, actor, {...})` through
  `index.ts`. The admit lane has no porter call yet (not wired: no admit intent raises a move today).
- Out of scope (seams noted): Code Blue from the porter's phone, lift status, robots, the mobile app.
