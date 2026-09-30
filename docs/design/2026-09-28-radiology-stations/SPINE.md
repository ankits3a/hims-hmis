# The spine — how every seat connects (v3 contract)

Every department fact lives in ONE store in `core.js`. Stations render from the stores and change them only
through the spine functions. A station never keeps a private copy of a critical call, a release, a follow-up,
a bill decision, an approval or a gate. `LOG` records every call (the audit trail).

## Stores (core.js)

| Store | Holds | Written by | Read by |
|---|---|---|---|
| `STUDY[]` | every study, its `state`, `gates{}`, `hold`, `dev`, `slot`, `dose` | all spine fns | every station |
| `CRIT[]` | critical calls `{id, acc, cat, finding, to, rung, state}` | `raiseCritical`, `ackCritical` | read:critical, doc:results, hod:escalations |
| `FU[]` | follow-ups `{id, acc, pt, rec, due, state, newAcc}` | `addFollowup`, `bookFollowup` | read:followups, doc:results/doc:report |
| `BILLQ[]` | bill decisions `{id, acc, kind, amount, state}` | `raiseBill`, `acquire` | room:rejects, hod:approvals, hod:money |
| `APPROVALS[]` | overrides, discounts, definitions, bills | `askApproval`, `decideApproval` | hod:approvals, prep:bay, read (radiologist overrides) |
| `REL{acc}` | release status: doctor unread/read/acted, patient, film | `releaseReport`, `readReport`, `actedUpon` | desk:reports, doc:results, pt:report, hod:floor |
| `ALOG[]` | who opened which images/report and why | `viewImages`, `readReport` | hod:audit |
| `DEV{}` | machine licence (`aerb`) and state (`up`) | `fileLicence`, `setDevice` | desk:schedule, room:*, rso:licences, hod:floor/equipment |

## The hops

| Hop | Act (seat) | Spine call | State after | Must appear at |
|---|---|---|---|---|
| H1 | Doctor orders (doc:order, doc:ward) | `orderStudy(o)` | `to_book` (OPD) / `scheduled` (ER, IPD) | desk:counter (OPD); room:console / room:portable (ER, IPD) |
| H2 | Desk books (desk:counter, desk:schedule) | `bookStudy(acc, dev, slot)` | `scheduled` | desk:schedule, room:console of that room |
| H3 | Patient opened at desk on the day, or at the room for ER/IPD | `checkIn(acc)` | `checked_in`, gates opened from facts | prep:bay if a PREP gate is open; usg:room for USG |
| H4 | Prep closes gates (prep:*, usg:room for Form F) | `closeGate(acc, kind, how, reason)` | `ready` when none open | room:console as ready |
| H4b | Override beyond the nurse | `askApproval({kind:'gate_override', acc, gate, ask})` → `decideApproval(id, ok, reason)` | gate `overridden` | hod:approvals (and read, for the radiologist) |
| H5 | Room starts and completes (room:console, room:portable) | `startScan(acc)` → `acquire(acc, dose)` | `in_acquisition` → `acquired` | read:worklist; rso:patientdose; hod:floor |
| H6 | Sonologist signs in the room (usg:room) | `signReport(acc, 'farah')` then `releaseReport(acc)` | `published` | desk:reports, doc:results |
| H7 | Radiologist signs, releases (read:report) | `signReport(acc, signer)` → `releaseReport(acc)` | `reported` → `published` | desk:reports, doc:results, pt:report (Farida), hod:floor |
| H8 | Critical flagged (read:report) | `raiseCritical(acc, cat, finding)` | CRIT open | read:critical, doc:results (if the doctor is the station's doctor), hod:escalations (red at rung ≥ 2 or > 15 min) |
| H9 | Read-back (read:critical, doc:results) | `ackCritical(id, readBack)` | CRIT acked | read:critical acknowledged log |
| H10 | Doctor acts (doc:results) | `readReport(acc)`, `actedUpon(acc, note)` | REL.doctor `acted` | hod:floor north-star counter, desk:reports |
| H11 | Follow-up (read:report, read:followups → doc) | `addFollowup` → `bookFollowup(id, o)` | new study `to_book` | read:followups, doc:results, desk:counter |
| H12 | Money exceptions (room, desk) | `raiseBill(acc, kind, amount, note)` | BILLQ open | room:rejects, hod:approvals, hod:money |
| H14 | Licence filed (rso:licences) | `fileLicence(dev, text)` | DEV.aerb `ok`, holds released | room:console unblocked, desk booking allowed |
| H15 | Machine down (room:downtime, hod:equipment) | `setDevice(dev, 'down', why)` → returns studies to move | DEV.up `down` | desk:schedule banner, room:downtime, hod:floor |
| H16 | Outside CD (desk:outside) | `orderStudy({src:'OUT', …})` then `acquire` | `acquired` | read:worklist / read:tele |
| H17 | Image or report opened anywhere | `viewImages(acc, reason)` / `readReport(acc)` | ALOG row | hod:audit |

Gates split by WHO closes them: ROOM gates `identity_two_factor`, `laterality_confirm` close at the console
(the technologist checks the wristband with the patient on the table). All others are PREP gates. Prep bay lists
a study only while a PREP gate is open. `form_f` closes in usg:room.

## Test hooks (the journey walk reads these)

Every row, card or block that stands for one of these things carries the attribute, with the id as the value:
`data-acc` (a study), `data-crit`, `data-fu`, `data-bill`, `data-appr`, `data-alog`, `data-down` (a machine that
is down, on the banner or row that says so), `data-gap` (a licence gap row). Add `data-state="…"` where the row
shows a state (e.g. `data-state="acked"`, `data-state="acted"`).

## The journeys (journeys.cjs drives these through the spine and checks the attributes)

- J1 OPD CECT, new order → counter → diary → prep → room → reading → release → doctor acts.
- J2 ER STAT CT → room directly → reading → red critical → read-back.
- J3 IPD portable chest from the ward → portable round → reading.
- J4 Obstetric USG → Form F → sonologist signs in room → release.
- J5 Kidney override: prep asks → HOD approves → gate overridden.
- J6 MG-1 licence filed → Meera's mammogram starts.
- J7 Outside CD → second-opinion read.
- J8 Repeat no charge → rejects queue → HOD approvals.
- J9 Follow-up recommended → doctor books → counter.
- J10 CT-1 breaks down → diary banner, downtime board, floor.
- J11 Every image/report opening lands in the HOD's access log.

## Shared view state

- `S.room` (core) is the machine the Modality rooms station shows. The room station reads and writes `S.room`,
  never a private copy, so the journey walk (and a HOD "do it" link) can open a given room: `S.room = 'CT-1'; go('room','console')`.
- `S.usgRoom` likewise for Ultrasound (null = all rooms).
- `go(st, view)` must render a LIST view with nothing in hand unless the station's own selection is set; the walk
  clears selections by calling `ST[st].drop()` before checking a list.
