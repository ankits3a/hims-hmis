# PCPNDT register go-live runbook — the register the system cannot create for you

**The seventh go-live runbook.** It exists because a census of commissioning acts found that a
hospital could deploy this system, scan patients, and **hold no PCPNDT register at all** — with no
check anywhere reporting it.

**Nothing here is optional and none of it can be seeded.** There is no `seed-pcpndt.ts` and there
never will be: `registrations.ts` calls that "the posture", and `form-f.ts` states the reason in one
line — *"a Form F is signed by a person; a system actor cannot write or verify one."*

> **This document describes software steps for a statutory register.** It is not legal advice. The
> Pre-Conception and Pre-Natal Diagnostic Techniques Act governs what must be recorded, by whom, and
> for how long; your registration certificate and your appropriate authority govern the rest. Where
> this page and the Act differ, the Act is right.

---

## 0. WHAT WILL BITE YOU

**A covered scan cannot be acquired until §2, §3 and §4 are all done.** `startAcquisition` re-checks
both at the moment of the scan — not at check-in — because *a registration can lapse and a doctor can
be struck off between the two*:

```
assertMachineRegistered(tx, study.deviceResourceId, onDate)   -> machine_not_registered
assertPersonRegistered(tx, actor.id, registrationId)          -> person_not_registered
```

**The date is the server's IST day and cannot be supplied by the caller** (F52). A technologist
refused `machine_not_registered` cannot retry with last month's date, and the browser's UTC day —
which is *yesterday* between 00:00 and 05:30 IST — is not used. That is not a detail: the plan's own
decisive scenario is an 02:00 emergency scan on the day after a registration expired.

Check the whole register in one line:

```
pnpm --filter @hmis/core standup:check pcpndt
```

---

## 1. Preconditions

| # | Precondition | How you know |
|---|---|---|
| 1.1 | Radiology is commissioned | `radiology-go-live.md`; the machines must exist as registry devices first |
| 1.2 | Someone holds `pcpndt_incharge` at hospital scope | `pcpndt_incharge_held` is **ok** |
| 1.3 | You have the **registration certificate** in front of you | its number and both validity dates are transcribed, never guessed |
| 1.4 | You have the **Form B** machine declaration | make, model and serial for every machine |
| 1.5 | You have the list of doctors who may scan | including the ones who only cover nights |

**1.3–1.5 are the owner's facts and nobody else's.** No seed may guess a registration number, and a
placeholder here is a false entry in a statutory register — worse than an empty one, because an empty
register refuses scans and a wrong one permits them.

### Two things you should know before you start

- **There is no screen for the register.** `pcpndtManifest` declares `menu: []`, and the only PCPNDT
  screen in the build is the Form F form itself. §2–§4 are performed against the API. Disclosed here
  rather than hidden: it is a real gap and it is not this page's to close.
- **You can read the register back, but only over the API.** `GET /pcpndt/registrations` on
  `pcpndt.registrations.read` returns every registration with its machines and its people —
  **withdrawn and lapsed rows included, with their flags**, because the register is a historical
  record and a machine sold last year still has its serial series. Use it after each of §2–§4 to
  confirm what you actually entered.

---

## 2. Register the premises

```
POST /pcpndt/registrations
{ "site": "...", "registrationNo": "...", "validFrom": "YYYY-MM-DD", "validTo": "YYYY-MM-DD",
  "inchargeUserId": "..." }
```

On `pcpndt.registrations.manage`, which **only `pcpndt_incharge` holds.**

- `registrationNo` is **unique across the system** — a second premises cannot reuse it.
- `validFrom`/`validTo` are **the certificate's own dates.** `validTo` is what the lapse block reads,
  so a date typed as "today" silently makes the register expire the day it is created.
- **One hospital may hold several registrations.** A satellite clinic is its own premises with its
  own certificate; register each.

Census: `pcpndt_registration_active` → **ok** only when a registration's window covers today.

---

## 3. Register the machines — Form B's list

```
POST /pcpndt/registrations/:registrationId/machines
{ "deviceResourceId": "...", "make": "...", "model": "...", "serial": "...", "formBRef": "..." }
```

**Every machine on the Form B declaration, one call each.** `deviceResourceId` points at the same
registry row radiology schedules against, which is what makes *"was a non-registered machine used"*
answerable by a join instead of by someone's memory.

- **A machine may sit on only one active registration.** Enforced by a unique index, deliberately: a
  machine on two registrations would make "which registration covers this scan" depend on read order,
  with a criminal statute on the other end of it.
- A machine sold or moved is **deactivated, never deleted** — it keeps its serial series and its
  forms.

Census: `pcpndt_machine_registered` → **ok**.

---

## 4. Register the people

```
POST /pcpndt/registrations/:registrationId/persons
```

**Register every doctor who may ever acquire a covered scan — not only the sonologists.**

The reasoning is the Act's decisive edge case and it is worth reading before you shorten the list: an
02:00 suspected ectopic, the sonologist at home, the ED doctor scans. **That doctor is a registered
person or the scan does not happen.** The corporate answer is to register everyone who might ever
scan, in advance; the alternative is a bypass, and a bypass in this module is an offence.

Census: `pcpndt_person_registered` → **ok**.

---

## 5. Verify before the first covered scan

```
pnpm --filter @hmis/core standup:check pcpndt
GET /pcpndt/registrations          # and read back what you entered, line by line
```

Every row **ok** except §6's, which is never green by design. Then confirm with one real study that a
covered scan reaches acquisition and a Form F opens — the acquisition gate is the only thing that
proves §2–§4 agree with each other.

---

## 6. The wall

**The registration certificate must be displayed at the premises, and the register must be available
for inspection.** No column holds that fact and no query can answer it, so `standup:check` reports it
as **NOT MODELLED** rather than lying in either direction — a green row would certify a display
nobody made.

- Hang the certificate where patients can see it.
- Keep the Form F register retrievable for the retention period the Act sets.
- **The renewal is a diary entry, not a system feature.** `validTo` blocks scans the day it passes;
  nothing warns you beforehand. Put the renewal date in a human calendar the day you perform §2.

---

## 7. What this runbook does NOT cover

- **Form F itself** — the per-scan record. It is a clinical act on the screen the build already ships,
  not a commissioning step.
- **The appropriate authority's own filings**, inspections and returns.
- **Rollback.** Deactivating a registration stops every covered scan on its machines immediately.
  That is the correct behaviour when a certificate lapses and it is not a maintenance operation.

---

## 8. Why this document exists

The PCPNDT module shipped with tables, guards, permissions, an acquisition gate and a criminal
statute behind it — **and no runbook, no census row, and no seed.** It was in nobody's population:
a sweep bounded by *"radiology and AERB"* never entered it, and the readiness census walked the
runbook files, of which it had none.

**Its own guards were correct throughout.** `startAcquisition` would have refused every covered scan
on an empty register, which is the right failure. What was missing was anyone being told before the
patient was on the table.
