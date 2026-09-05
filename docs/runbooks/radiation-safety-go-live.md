# Radiation safety & AERB registers go-live runbook — Plan 18c (T1–T6)

The registers this phase ships are `aerb`: equipment licences, the appointed people, the
quality-assurance book, the patient dose register, the TLD badge programme, and the compliance
calendar that reads all of them.

**Read §0 before you deploy. It is not a warning about data quality; it is a warning that the
department stops.**

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**From the moment 18c is deployed, an ionising study cannot be acquired on a machine with no active
AERB licence on file.** Not "is flagged". Not "warns". `startAcquisition` refuses with
`device_not_licensed`, and the modality worklist withholds the study so the console never sees it.

That is deliberate (D3): a hospital operating an unlicensed X-ray unit is committing an offence, and
a register that watched it happen and said nothing would be worse than no register. But it means:

> **File every ionising machine's licence (§2) BEFORE you deploy, or the CT, the DR units, the
> mammography unit and the fluoroscopy suite all stop the moment the migration lands.**

**T6 added the screen this is done on.** Until it landed every route below was reachable only by
hand-rolled HTTP, which is why each section still prints its request — that is the reference for
what the field means, not the route you are expected to take. Go to
`/radiology/radiation-safety` → **Licences**, and work down the red *machines emitting with no
licence* block: every row on it carries its own **File a licence** and the form opens with that
machine already chosen. **The block emptying IS the check in §2's last bullet.**

Ultrasound and MRI are unaffected — AERB licences neither, and the gate is keyed on the study's
`ionising` flag rather than on the device.

**Rehearsal:** on a staging copy, apply the migrations WITHOUT filing a licence and try to start a
CT. You should see `device_not_licensed` with the device id and the date in the detail. That is the
failure your radiographers will meet if §2 is skipped; see it once, deliberately, on a Tuesday.

---

## 1. Preconditions

| # | What | Why it blocks |
|---|---|---|
| 1 | Migrations `0060`–`0065` applied | the five tables, the close-review repairs (`0064`) and the licence SEQUENCE index (`0065`) |
| 2 | `seed:roles` re-run | mints `radiation_safety_officer` and grants `aerb.doses.read` to `radiologist` and `radiographer` |
| 3 | A human assigned `radiation_safety_officer` at hospital scope | **nobody can file a licence without it**, and the role is minted holding nothing until somebody is assigned it (`seed:roles` mints authority and assigns nobody) |
| 4 | Each ionising machine already exists as a `device` resource | the licence points at the registry row, not at a name |
| 5 | Owner ruling R1 — the RSO and the medical physicist named | §3; the registers work without it and show the gap |

`seed:staff` will refuse a roster naming `radiation_safety_officer` on a deployment where
`seed:roles` has not been re-run — that is the census doing its job, not a bug.

---

## 2. The equipment licences (T1) — **do this before the deploy, not after**

One row per ionising machine, from the document AERB issued. There is no seed and no placeholder:
these are law, and a default would be a hospital claiming a licence it does not hold.

```
POST /aerb/licences        (aerb.registers.manage)
{
  "deviceResourceId": "<the device resource id>",
  "licenceType":      "licence" | "registration",
  "licenceNo":        "as printed on the document",
  "eloraRef":         "the eLORA reference, if you have it",
  "typeApprovalRef":  "type approval of the equipment model",
  "layoutApprovalRef":"approval of the room's shielding layout",
  "validFrom":        "YYYY-MM-DD",
  "validTo":          "YYYY-MM-DD",
  "rsoUserId":        "<the RSO's user id, or omit until R1 is ruled>"
}
```

- **`licence` vs `registration` is not cosmetic.** eLORA REGISTERS a plain radiography unit and
  LICENSES CT, fluoroscopy, mammography and interventional units. Enter what your document says;
  the gate treats them identically and the register prints the truth to the inspector.
- **A RENEWAL IS THE NEXT WINDOW, NOT A SURRENDER — and this paragraph used to say the opposite.**
  Until migration `0065` the invariant was "one active licence per device", and this runbook told
  you to *surrender the old row, then file the new one*. **Do not do that.** `surrendered` is
  terminal, so surrendering November's certificate in order to file January's leaves the machine
  with no licence in force for the rest of December — every ionising study on it refused, with no
  way back. Pass 2 of the close review measured exactly that and replaced the invariant.

  What a hospital has is a **sequence of certificates with non-overlapping validity**, and *which
  one is in force* is a question about the date. So: **file the renewal the day the paperwork
  arrives and touch nothing else.** The screen's **Renew** button on the licence row does this —
  it pre-fills the machine and starts the new window the day after the current one ends. Two
  certificates on one device is normal and correct; overlapping ones are refused
  (`licence_already_active`, naming the window it clashes with), and so are two that start on the
  same day.

  **Surrender is for a machine that is going away** (§2's status block below), never for one whose
  paperwork is being renewed.
- **Check your work before the deploy:** `GET /aerb/licences/gaps?onDate=YYYY-MM-DD` lists every
  non-retired `device` whose modality AERB licences and which has no live licence. **It must be
  empty** — on the screen, that is the red block at the top of the Licences tab being gone. If it names a machine, that machine stops when you deploy.

**Surrender, when a unit is decommissioned:**

```
POST /aerb/licences/:id/status
{ "to": "surrendered", "reason": "unit replaced", "decommissionRef": "your decommissioning record" }
```

`surrendered` is terminal and takes the date with it — AERB requires the decommissioning itself to
be documented, and the database refuses a surrendered row with no date.

---

## 3. The appointed people (T1) — R1

```
POST /aerb/persons        (aerb.registers.manage)
{ "userId": "...", "personRole": "rso" | "physicist",
  "approvalRef": "AERB's approval reference for this person",
  "qualification": "...", "validFrom": "YYYY-MM-DD", "validTo": "YYYY-MM-DD or omit" }
```

Omit `validTo` where your approval letter names no expiry — the calendar simply never chases it.
The recommended appointment (O-13) is a senior radiographer as RSO with AERB approval and a
visiting medical physicist on contract; the same human may hold both roles where the approvals say
so.

**Nothing refuses a scan for want of an RSO.** The register works before R1 is ruled and shows an
empty People tab; a phase that turns this into a block must say so in its own document.

---

## 4. Quality assurance and the machine block (T2)

```
POST /aerb/qa             (aerb.registers.manage)
{ "deviceResourceId": "...", "qaType": "AERB annual QA",
  "result": "pass" | "fail" | "conditional",
  "performedBy": "the physicist or the agency's engineer, by name",
  "performedOn": "YYYY-MM-DD",
  "agencyRef": "the agency's report reference",
  "values": { "kvpAccuracyPct": 2.1, "hvlMm": 3.4 },
  "nextDueOn": "YYYY-MM-DD" }
```

- **A `fail` stops the machine** — `qa_blocked` in the resource registry, in the same transaction.
  The scheduler and acquisition already refuse that status, so the diary stops taking bookings the
  moment you record the failure.
- **A `pass` releases it** — but only from `qa_blocked`. A machine sitting in `down` (a broken tube)
  or `maintenance` (an engineer's visit) is somebody else's status and a passing phantom test will
  not clear it.
- **A `fail` on a machine that is mid-examination is REFUSED** (`already_occupied`) and the record
  rolls back with it. Stopping a tube with a patient on the table is a decision a person makes at
  the console. Wait for the study to finish, then record.
- **An overdue test does NOT block** (D4). It appears on the calendar and on the inspector's file.
  The RSO blocks; the calendar tells them to.

`values` is free-form on purpose — the measured quantities differ per protocol, and a column per
quantity would be a migration every time the agency changed its form. **The screen does not collect
it** (T6, stated limit): the measured numbers live on the physicist's certificate, and a JSON blob
typed at the desk is a 500 waiting for a missing brace. The route still accepts it, so an importer
can carry the numbers later. What the screen records is that the test happened, its verdict, who
performed it and when the next is due — and, for a `fail`, it warns you by name that the machine is
about to stop before it sends anything.

---

## 5. The diagnostic reference levels (T3) — optional, and safe to defer

Published like every other radiology definition (draft → approval → publish), kind
`dose_reference_levels`:

```json
{ "levels": [
  { "study_type_code": "CT-HEAD", "quantity": "dlp", "value": 1000, "source": "ICRP 135" },
  { "modality": "ct", "quantity": "dlp", "value": 2000, "source": "local 75th percentile, n=142" }
] }
```

- `study_type_code` beats `modality`; an examination matching neither is registered **uncompared**,
  and the register stores `null` — which is not "under". Nothing breaks; you simply have no verdict
  until you publish a level.
- Quantities and their units: **CTDIvol mGy · DLP mGy·cm · DAP Gy·cm² · fluoroscopy seconds.**
- The comparison is stored on the dose row when the study is acquired, so republishing a level next
  year does not change what an examination in March was measured against.

**Deferring this is safe and common.** The dose register fills from day one either way; the
comparison arrives when your levels do.

---

## 6. The TLD badge programme (T4) — R2, R3

```
POST /aerb/badges                    { "userId": "...", "badgeNo": "TLD-001", "issuedOn": "YYYY-MM-DD" }
POST /aerb/badges/:id/close          { "status": "returned" | "lost", "onDate": "YYYY-MM-DD" }
POST /aerb/badges/reads              { "badgeId": "...", "periodStart": "...", "periodEnd": "...",
                                       "hp10Msv": 4.2, "hp007Msv": 4.9,
                                       "reportedOn": "...", "labRef": "TLD/2026/Q1" }
POST /aerb/settings/investigation-level  { "perMonthMsv": 1.0 }
```

- **Hp(10) and Hp(0.07) are different depths.** Enter both from the laboratory report; only Hp(10)
  is compared against the investigation level, because the skin limit is separate and far higher.
- **The investigation level is per MONTH and is pro-rated onto the wearing period.** A quarterly
  badge is compared against roughly three times the monthly figure. R3's recommended default is
  1.0 mSv/month; setting a level whose annual equivalent reaches the 30 mSv statutory ceiling is
  refused, because a trigger above the limit it warns about never fires.
- **The statutory limits are not editable from anywhere** — 20 mSv/year averaged over five, 30 mSv
  in any single year, 100 mSv over five. They are code constants with the Rules cited beside them.
- **A flagged reading changes nothing.** It raises the row, emits `radiation.dose_limit_warning` and
  waits for the RSO. Duty rosters are Plan 20's; a TLD report arrives weeks after the period it
  describes, and pulling somebody off fluoroscopy today over last quarter's reading is a decision a
  human makes.
- **Watch the Badges tab's red block**: badges with no reading for four months. Every row there is
  a person whose occupational exposure is unknown, which is the one thing this programme exists to
  make impossible.

---

## 7. The calendar and the inspector's file (T5)

`/radiology/radiation-safety` → **Calendar**. Licence expiry, the next QA due per machine and test
type, appointment expiry, and badges nobody is reading — sorted by how late each thing is.

- The working view shows only what is `due` (within 30 days) or `overdue`.
- **"Print the inspector's file"** switches to the whole file — including everything in date — and
  prints it. Hand that to the inspector; the half that is in date is the half that shows you are
  compliant.
- The calendar **blocks nothing**, ever.

---

## 8. What this does NOT turn on

Roster gates for a pregnant radiographer (Plan 20) · any alerting or escalation ladder · a room
shielding-survey workflow · brachytherapy source custody and RT fractions (Plan 64) · cath-lab dose
emission (Plan 63 — it will call the same `recordDose`) · eLORA submission or filing · TLD vendor
file import (readings are typed) · dose SR from the modality (18b-ii) · staff radiation-training
records and signage evidence (Plan 28) · patient dose from outside studies.

---

## 9. Rollback

The five tables are additive and nothing outside `aerb` reads them, with **one exception that
matters**: `startAcquisition` calls `assertDeviceLicensed` and `mwlExport` calls `activeLicenceFor`.

**Rolling back the code alone is safe** — the tables simply stop being written. **Rolling back the
migrations while the code is deployed is not**: every ionising acquisition will fail on a missing
table. Roll back the application first, the migrations second, or neither.

### If a LICENCE ROW is the problem — read this before you touch it

A machine stopped because its row is wrong rather than because its licence is. The fix is to correct
the register, not to disable the gate. **But the obvious correction does not work, and this section
told you to do it until 2026-09-05:**

> ~~`POST /aerb/licences/:id/status` with `{"to":"suspended"}` on the wrong row, then file the
> right one.~~

**Suspending does not clear the way.** `fileLicence`'s overlap pre-read excludes only `surrendered`
rows (`ne(status, "surrendered")`), so a *suspended* row still occupies its dates and filing the
corrected certificate comes back **`licence_already_active`, naming the row you just suspended** —
at the exact moment a machine is dark and somebody is working under pressure.

**What actually clears an overlapping row is SURRENDER, and surrender is terminal.** So today the
only working correction for a mistyped window is an act §2 reserves for decommissioning.

> **⚠ THIS IS AN OPEN QUESTION WITH THE OWNER, NOT A PROCEDURE.** Is a data-entry error a lawful
> reason to surrender a licence? Until that is answered, **do not surrender a row to fix a typo on
> your own authority.** Raise it with the RSO and the quality manager, record what you did and why,
> and if the machine must run meanwhile that is a clinical decision made by a person — not one this
> runbook can make for them.

**What IS safe today, and covers the common cases:**

- **The window is too SHORT** (you typed the wrong `validTo`, the machine goes dark early) — file
  the *next* certificate starting the day after the wrong one ends. No overlap, nothing surrendered,
  the machine keeps running. This is the renewal path and it is the answer more often than it looks.
- **The window is too LONG or the dates overlap a real certificate** — the register is claiming
  cover the hospital may not have. That is the case that needs the ruling above before anyone acts.
- **The licence NUMBER or a reference is wrong, dates correct** — there is deliberately no edit
  route (§2's header says why: a licence is a document AERB issued, and a correction must leave the
  register able to say what it said on the day of a given scan). Record the discrepancy and raise
  it; do not surrender to retype a number.

---

## 10. Who can do any of this (T6)

`aerb.registers.read` buys the book; **`aerb.registers.manage` buys the pen.** The screen asks the
server which one you hold and renders accordingly — a quality manager showing an inspector the file
sees five registers and not one form, and never discovers the difference by being refused.

So if the forms are not there:

1. Check the human has `radiation_safety_officer` at **hospital** scope (§1, precondition 3). The
   role is minted holding the permission and assigned to nobody.
2. Re-run `seed:roles` if the permission itself is missing — it is granted at `seed-roles.ts:1151`.
3. There is no third cause. The screen has no other input to that decision.

The machine and staff dropdowns come from `GET /aerb/pickers`, which sits behind the same
`aerb.registers.manage`. A reader who can see the registers and not the pickers is not a bug: an
inspector reading the file needs no dropdown of machines, and the staff roster is not part of what
the register discloses to a reader.
