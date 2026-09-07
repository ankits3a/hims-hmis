# OT & day-care go-live runbook — the page `seed-ot.ts` has been pointing at

**`seed-ot.ts` ends by printing this, and has since Plan 15:**

```
NOTHING IS ACTIVE: an MS publishes the three drafts and drafts `privileges` themselves (DD6, T9's runbook)
```

**This is that runbook.** Until now it did not exist, so the seed correctly refused to weaken a
two-key clinical-safety approval and then pointed the operator at a page nobody had written. The
refusal was right; the missing page was the defect.

---

## 0. WHAT WILL BITE YOU

**The deploy leaves the OT deliberately inert, and that is by design, not by omission.** After
`seed:ot` you have approval types, a theatre, recovery bays and **three drafts**. You do not have:

| # | missing | why no seed can supply it |
|---|---|---|
| 1 | `daycare_case` and `ot_gate` **active** | change-class **A** — two approvals and a distinct activator |
| 2 | `criteria`, `deposit_policy`, `pacu_thresholds` **published** | the MS publishes, under `ot_definition_publish` |
| 3 | `privileges` **drafted at all** | which surgeon may do which procedure is *this* hospital's fact |

**(3) is the one that surprises people.** The seed drafts three of the four definition kinds and does
not draft `privileges`, because no seed can guess a credentialling decision. `ot_gate` checks a
surgeon against the published `privileges`, so an OT with everything else done still cannot pass a
case through its gate.

Check all of it in one line:

```
pnpm --filter @hmis/core standup:check ot
```

---

## 1. Preconditions

| # | Precondition | How you know |
|---|---|---|
| 1.1 | `seed:ot` has run (the deploy runs it) | `ot_approval_types_registered` and `ot_theatre_present` are **ok** |
| 1.2 | SoD pairs seeded | `seed:ot` calls `seedSodPairs` itself, so this follows 1.1 |
| 1.3 | The three governance humans exist | `opd_admin`, `medical_superintendent`, `owner` at hospital scope |
| 1.4 | Clinical roles exist | `surgeon`, `anaesthetist`, and for a full day list `ot_incharge`, `daycare_coordinator`, `ot_nurse`, `recovery_nurse` |

**The grants for §2 are narrow and are not the OT's own roles** — they are the kernel's governance
grants, measured from `seed-roles.ts`:

| permission | held by |
|---|---|
| `workflow.definitions.draft` | **`opd_admin` only** |
| `workflow.definitions.approve` | `medical_superintendent`, `owner` |
| `workflow.definitions.activate` | **`owner` only** |

> **THE TRAP WITH NO WAY OUT — the owner must not be the drafter.** `owner` is the only role that can
> activate, and `activateDefinition` enforces **drafter ≠ activator** (`workflow_drafter_activator`).
> If the owner drafts, **nobody can activate** and the draft must be discarded and redrafted by
> someone else. Identical to `opd-go-live.md` §1.6, and it bites here twice because there are two
> definitions.

---

## 2. Activate `daycare_case` and `ot_gate` — the Class A ceremony, twice

Nothing seeds these. Perform §2 **once per definition**.

**2.1** — The `opd_admin` drafts, posting the definition's JSON:

```
POST /workflow/definitions        body: the daycare_case (then ot_gate) definition
```

**2.2** — The medical superintendent approves:

```
POST /workflow/definitions/:id/approve    { "roleKey": "medical_superintendent", "note": "go-live activation" }
```

**2.3** — The owner approves:

```
POST /workflow/definitions/:id/approve    { "roleKey": "owner", "note": "go-live activation" }
```

Two **distinct people**: `approveDefinition` refuses `duplicate_approval` **per person, not per role
key**, so one account holding both roles cannot supply both keys.

**2.4** — The owner activates:

```
POST /workflow/definitions/:id/activate
```

Census: `ot_workflow_definitions_active` → **ok** only when **both** are active.

---

## 3. Publish the three seeded drafts

`seed:ot` has already drafted `criteria`, `deposit_policy` and `pacu_thresholds` into
`ot_definitions`. Publishing is the **medical superintendent's** act under the
`ot_definition_publish` approval type — a different governance from §2 and a different table.

Publish each of the three. Review the bodies first: they are defaults written at plan time, not this
hospital's policy.

- **`criteria`** — which procedures may be done as day-care, by class and anaesthesia type.
- **`deposit_policy`** — what is taken up front, by payer class.
- **`pacu_thresholds`** — the discharge scale. **One scale per technique**: a GA PADSS and a spinal's
  longer set are different rows, and getting this wrong sends a patient home on the wrong criteria.

---

## 4. Draft *and* publish `privileges` — the step no seed performs

**This is the one with no starting point.** `privileges` records which surgeon may perform which
procedure class, and `ot_gate` refuses a case whose surgeon is not privileged for it.

1. The MS (or the OT in-charge, per your credentialling policy) **drafts** the body from the
   hospital's own credentialling file.
2. The MS **publishes** it, under `ot_definition_publish` as in §3.

**Do not copy another site's `privileges`.** It is a credentialling record; publishing someone else's
asserts that this hospital granted privileges it never granted.

Census: `ot_definitions_published` → **ok** only when **all four** kinds have an active row.

---

## 5. The unit

`seed:ot` creates the day-care theatre and its recovery bays as registry resources. Confirm the codes
and names match the physical rooms, and rename at the registry if not — the board a nurse reads shows
these strings.

Census: `ot_theatre_present` → **ok**.

---

## 6. The people

| Role | Without it |
|---|---|
| `surgeon` | no case can be booked |
| `anaesthetist` | the anaesthesia gate has no holder |
| `ot_incharge` | no one runs the list |
| `daycare_coordinator` | no one schedules or discharges |
| `ot_nurse`, `recovery_nurse` | no counts, no PACU scoring |

All at **hospital scope**. Census: `ot_surgeon_held`, `ot_anaesthetist_held` → **ok**.

---

## 7. Money

The day-care **packages** and the **implant** service must exist and be priced in the active tariff
version, with their GST categories set. An unpriced package fails **at booking, in front of a
patient** — the same shape as the laboratory's §4.5 and OPD's §5.

---

## 8. What this runbook does NOT cover

- **CSSD, instrument trays and sterilisation** — not modelled in this build.
- **Inpatient theatre.** This is the *day-care* OT; a full inpatient theatre list is a later phase.
- **Rollback.** Retiring an active `daycare_case` stops booking. As with OPD, the recovery from a bad
  definition is to draft, approve and activate a corrected one through §2 again.

---

## 9. Why this document exists

The OT's commissioning ceremony was performed, correctly and in full, in exactly one place:
`test/helpers/ot.ts`, whose own comment says why it does it the real way —

> *"A fixture that activated these by inserting a row would prove nothing about whether the runbook is
> performable."*

**The fixture was written to prove a runbook performable, and the runbook did not exist.** Every OT
suite passed because every suite performed the ceremony itself in `beforeEach`. `seed-ot.ts` refused
to shortcut it and named this page. Both were right, and between them the act still reached no
operator. The rows in §0's census are the part that will now say so out loud.
