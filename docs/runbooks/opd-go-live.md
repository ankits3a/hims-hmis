# OPD go-live runbook — the front desk, and the definition nobody wrote down

**The sixth go-live runbook, and the first written for a module that was already live.** The
laboratory, the pharmacy and radiology each had one before they opened. OPD — which all three of
them order through — did not, and this document exists because that gap had a consequence.

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**Activate the `opd_visit` workflow definition (§2). Until you do, the hospital cannot register a
single patient, and the error will not say so.**

`openVisitInTx` calls `startInstance(tx, "opd_visit", …)` on **every** encounter it opens. With no
active definition that throws `no_active_definition`, which reaches the counter as a **409 naming a
workflow key**. A receptionist reads that as "the system is down"; an engineer reads it as a bug in
registration. It is neither: it is a commissioning step nobody performed, because until this document
existed there was nowhere it was written.

**It is not a seed and it cannot become one.** `opd_visit` is a **Class A** definition
(`CHANGE_CLASS_POLICY.A`): `owner` + `medical_superintendent` approvals, plus a drafter who is not the
activator. **Three people, and they are not interchangeable** (§1.6). A seed that activated it would
collapse a two-key clinical-safety approval into an automated call — the design would still be there,
and it would be decorative.

Check it before you believe anything else:

```
pnpm --filter @hmis/core standup:check front-desk
```

`opd_visit_definition_active` **RED** means no patient can be registered. It is the only row on this
page that has that consequence on its own.

---

## 1. Preconditions

| # | Precondition | How you know |
|---|---|---|
| 1.1 | The deploy has run and migrations are applied | `pnpm --filter @hmis/core db:check` |
| 1.2 | `opd_config` and the default departments exist | `seed:opd` has run — `opd_config_present` is **ok** |
| 1.3 | `registration_config` exists | `registration_config_present` is **ok** (`seed:registration`) |
| 1.4 | Billing configuration exists | `billing_config_present` is **ok**; the counter takes money |
| 1.5 | The SoD pairs are seeded | `workflow_drafter_activator` must exist, or §2 cannot refuse correctly |
| 1.6 | **Three people hold three roles at hospital scope** | `opd_admin`, `medical_superintendent`, `owner` — see below |

**1.6 is the one that delays go-live.** Every route in §2 is permission-guarded, and the grants are
narrow — measured from `seed-roles.ts`, not assumed:

| permission | held by | so it is the |
|---|---|---|
| `workflow.definitions.draft` | **`opd_admin` only** | drafter |
| `workflow.definitions.approve` | `medical_superintendent`, `owner` | the two approvers |
| `workflow.definitions.activate` | **`owner` only** | activator |

So the ceremony is **three people**: `opd_admin` drafts, `medical_superintendent` approves, and
`owner` approves *and* activates. Nothing forbids an approver from activating — the only separation
`activateDefinition` enforces is **drafter ≠ activator**.

> **THE TRAP THAT HAS NO WAY OUT: the owner must not be the drafter.** `owner` is the only role that
> can activate, and the `workflow_drafter_activator` SoD pair refuses a drafter who then activates.
> If the same person holds `opd_admin` and `owner` and drafts the definition, **there is no one who
> can activate it** and the draft has to be discarded and redrafted by someone else. Give
> `opd_admin` to the administrator, not to the owner.

---

## 2. Activate the `opd_visit` definition — the ceremony

This is a **Class A change**. It is performed once per environment, by the three people of §1.6, and
every step leaves a row an auditor can read afterwards.

**2.1 — Fetch the definition body.** The server serves the exact JSON it expects:

```
GET /opd/definition
```

Do not hand-write it and do not copy it from an older environment. The body carries the six states,
the eight transitions, and the SLA and escalation ladder for each state; a body that differs from the
build's is a definition the build will refuse or, worse, accept and then behave differently under.

**2.2 — The `opd_admin` creates the draft.**

```
POST /workflow/definitions        body: the JSON from 2.1
```

Guarded by `workflow.definitions.draft`, which **only `opd_admin` holds** (owner ruling 2026-08-23).
The response carries the `definitionId` the next three calls need.

**2.3 — The medical superintendent approves.**

```
POST /workflow/definitions/:id/approve    { "roleKey": "medical_superintendent", "note": "go-live activation" }
```

**2.4 — The owner approves.**

```
POST /workflow/definitions/:id/approve    { "roleKey": "owner", "note": "go-live activation" }
```

`note` is required and must be at least three characters. Two **distinct** people:
`duplicate_approval` refuses the same person twice and `approver_lacks_role` refuses anyone not
actually holding that role at hospital scope. Both refusals are the design working, not an obstacle.

**2.5 — The owner activates.**

```
POST /workflow/definitions/:id/activate
```

Guarded by `workflow.definitions.activate`, which **only `owner` holds**. `activateDefinition`
re-checks the approvals itself (`approvals_missing` if either is absent) and enforces
**drafter ≠ activator** — see the trap in §1.6. Only now does the definition become `active`, and
only now can a visit be opened.

**2.6 — Verify, and verify through the census rather than by eye.**

```
pnpm --filter @hmis/core standup:check front-desk
```

`opd_visit_definition_active` must read **ok**. If it does not, nothing in §3 onward is worth doing.

> **The emergency path exists and is not this.** `CHANGE_CLASS_POLICY.A.emergencyRoles` is
> `duty_manager` + `medical_superintendent` (E-5). It is for a definition change during an incident,
> not for a go-live you would rather not get three people into a room for. Using it here records an
> emergency that did not happen, in a row that is kept for ever.

---

## 3. The department and the doctor of record

A department alone is not a clinic. `openVisitInTx` validates the **pair** — a department *and* an
active doctor in it — so a hospital with ten departments and no doctor fails on the first walk-in,
not at seed time.

- Create the departments at `/opd/admin` (`seed:opd` writes a default set; keep or replace them).
- Create at least one **active** doctor in one of them, with a registration number.

Census: `active_doctor_in_a_department` → **ok**.

---

## 4. The people

| Role | Why the counter stops without it |
|---|---|
| `front_office` | registers the patient; without it there is no one to open a visit |
| `cashier` | the drawer session cannot be opened, so no money can be taken |
| `vitals_desk` / `nurse` | `registered → waiting` is theirs; without one, every patient stays at `registered` |
| `doctor` | `waiting → in_consultation` and every transition out of it |

All at **hospital scope** at `/admin/users`. A role held only at a department scope reads RED in the
census and grants nothing outside that department — which is the correct behaviour and a common
first-day surprise.

Census: `front_office_held`, `cashier_held` → **ok**.

---

## 5. Consultation charges

`billing_config.chargeRules.opdConsult` must name a `new` and a `renewal` service, and both must be
priced in the active tariff version. An unpriced consultation fails **at the counter, in front of a
patient**, with `tariff_item_missing` — the same shape as the laboratory's §4.5 warning, one module
over.

---

## 6. What this runbook does NOT cover

- **Appointments, the queue and the display board** — they follow the visit and none of them can be
  exercised until §2 is done.
- **The OT and day-care definitions.** `daycare_case` and the OT's second definition are **also Class
  A and also have no runbook and no census row.** That is the same defect as this document's, one
  module over, and it is named here rather than left for someone to rediscover.
- **Rollback.** Retiring an active `opd_visit` stops registration hospital-wide; there is no
  supported "downgrade the definition" path, and the correct recovery from a bad definition is to
  draft, approve and activate a corrected one through §2 again.

---

## 7. Why this document exists

`activateOpdVisitDefinition` was defined in `test/helpers/opd.ts` and called by **forty test files
and by nothing in `src/` or `scripts/`.** Every OPD suite passed, because every suite performed the
ceremony itself in `beforeEach`. Production works because a human performed it once and no runbook
recorded that they had.

**A test helper is not a commissioning path**, and a green suite over a fixture that performs a
missing step is the quietest way for that step to stay missing. The check in §2.6 is the fix, and it
is a row in the readiness census so that the next environment is told before the first patient rather
than by them.
