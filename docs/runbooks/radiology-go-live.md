# Radiology go-live runbook — Plan 18a (with 18a-iii)

The imaging department: the order, the schedule, the safety gates, the acquisition and the report.

**Two companion runbooks cover the rest of the series and neither replaces this one.**
`radiology-pacs-go-live.md` is 18b (worklist export, UIDs, the viewer door).
`radiation-safety-go-live.md` is 18c (the AERB registers) and **its §0 is a hard stop on the whole
department** — read it before you deploy, not after.

**Written 2026-09-06 from a stand-up performed on an empty database**, not from the plan documents.
Everything below was reached by being blocked by it; the walk that produced it is
`docs/superpowers/plans/reports/2026-09-06-radiology-commissioning-walk.md`.

---

## 0. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

**`seed:radiology` does not finish the department, and the step it leaves undone is invisible until a
doctor places the first order.**

The two workflow definitions the department runs on — `imaging_study` and `imaging_gate` — are
activated by **no seed and no script**. Until §3 is performed, a placed order produces no study, the
reception and worklist screens stay empty, and nothing anywhere says why. There is no refusal to read
because there is no request: `handleOrderPlaced` runs in the worker and fails there.

> **Perform §3 before you let a clinician place an imaging order.** It is a governed ceremony that
> names **three people**, so it cannot be done at 2 a.m. by whoever is deploying.

This is the counterpart to the laboratory's §5, with one difference that matters: the lab's
definitions are change-class **C**, activated by the department's own head. Radiology's are
change-class **A** — the same weight as an OPD visit — so they need the owner, the medical
superintendent, and a third person to draft.

---

## 1. Preconditions

| # | What | Why it blocks |
|---|---|---|
| 1 | Migrations applied through `0078` | the imaging tables, 18a-iii's contrast/outside/chaser tables |
| 2 | `seed:roles` re-run | mints `radiologist`, `radiographer`, `radiology_receptionist`, `modality_bridge` |
| 3 | **Humans assigned to those roles** at hospital scope | `seed:roles` mints authority and assigns NOBODY; a role nobody holds is a screen nobody can open |
| 4 | A user holding `owner`, a **different** user holding `medical_superintendent`, and a **third** holding any role | §3 — three distinct people, not two |
| 5 | The worker process running | §8 |
| 6 | An active tariff version with imaging prices | §6 — otherwise acquisition refuses `402` |
| 7 | 18c's licence register populated | `radiation-safety-go-live.md` §2 — otherwise every ionising study refuses |

---

## 2. The seeds, in order

```
pnpm seed:roles          # exits 1 listing what is unassigned — read it, that is the census working
pnpm seed:admin
pnpm seed:radiology      # 20 services, 5 device resources, study_types v1 ACTIVE
cat roster.json | pnpm seed:staff
```

`seed:radiology` creates the twenty study types' tariff **service rows with no prices** (a phase that
invented prices would be inventing money) and five `device` resources — one X-ray, one ultrasound,
one CT, one MRI, one mammography unit. **A hospital with two CTs adds the second through the
resources screen**; the seed does not guess at an inventory.

It also self-publishes the `study_types` book, leaving `approval_id` NULL as the provenance — the
owner's 2026-08-31 ruling. Every LATER version goes through the medical superintendent's approval on
the publish route, which is unchanged.

**`SEED_ACTOR_ID` names the administrator performing the go-live** and the audit row records them.
Left unset, the activation row reads `seed:radiology` — honest, and implicating no human.

---

## 3. The workflow definitions — the ceremony §0 is about

`imaging_study` and `imaging_gate` are change-class **A**. Activating one takes **three distinct
people**, and the third is the part no other document mentions:

1. **A drafter** calls `createDraft` for each definition.
2. **The owner** approves it (`roleKey: "owner"`).
3. **The medical superintendent** approves it (`roleKey: "medical_superintendent"`).
4. **Someone who is not the drafter** activates it.

Two guards make the third person unavoidable, and each refuses with its own error:

- `approveDefinition` refuses `duplicate_approval` on `(definitionId, approverId)` — **per PERSON,
  not per role key**. One account holding both `owner` and `medical_superintendent` cannot supply
  both approvals.
- `activateDefinition` refuses the SoD pair `workflow_drafter_activator`. **Whoever drafted it may
  not activate it**, so the drafter must be a third person if an approver activates.

So the smallest lawful set is three: a drafter, and two approvers one of whom activates.

`registerRadiologyApprovalTypes` registers `imaging_definition_publish` (approver
`medical_superintendent`, 24-hour SLA). `seed:radiology` performs it, as a user actor. It is
idempotent — a typeKey already registered is left untouched.

**Confirm before going further.** With §3 undone, `handleOrderPlaced` cannot start an instance and no
study appears. The check is positive, not negative: place one order and see a study with an `X`
accession on `/radiology/reception`.

**On a dev or UAT stack** `npx tsx apps/core/scripts/dev-radiology-standup.ts` performs this and §6
in one step. It refuses production two ways and **files no AERB licence, deliberately**. It is not a
production path: production's activation names real people and that is the point of it.

---

## 4. Who holds what

| role | holds | seat |
|---|---|---|
| `radiology_receptionist` | `radiology.schedule`, `radiology.orders.place`, `radiology.bill_decisions.manage` | reception — books slots, walk-ins, check-in |
| `radiographer` | `radiology.checkin`, `radiology.acquire`, `radiology.gates.satisfy`, `radiology.mwl.read` | the console |
| `radiologist` | `radiology.reports.{read,write,sign,amend}`, `radiology.gates.override`, `radiology.criticals.ack`, `radiology.definitions.manage` | reporting |
| `doctor` | `radiology.orders.place`, `radiology.reports.read` | the ward and the OPD |
| `modality_bridge` | `radiology.mwl.read` | the machine, not a human — see the PACS runbook |
| `radiation_safety_officer` | `aerb.*` | the registers — see the radiation-safety runbook |

**A radiographer cannot override a gate and cannot sign.** That is DD7 and it is deliberate: the
radiologist is the second clinical opinion on a gate the technologist raised.

**Signing needs a second factor.** `POST /radiology/studies/:id/reports/sign` refuses
`second_factor_required` on a stale session. Every radiologist enrols TOTP
(`/auth/totp/enroll` → `confirm`) **before** their first reporting session, not during it.

---

## 5. The machines

Each `device` resource carries a `modality` attribute, and `scheduleStudy` matches a study type
against it. **The AE title a modality worklist needs cannot be set at all** — nothing in the
workspace writes `attributes.aeTitle`, so `GET /radiology/mwl` is permanently empty; the PACS
runbook's §2 carries the measurement. This sentence used to say "set the AE title too", seven lines
above the paragraph below declaring there is no door for a machine.

**The device registry row is what an AERB licence points at.** A machine that does not exist as a
resource cannot be licensed, and therefore cannot be used for an ionising examination. The machines
must exist before you enter the certificates.

**THERE IS NO RESOURCES SCREEN, and this section said otherwise until it was measured.** The kernel
exposes `/resources/board`, `/resources/tree` and `/resources/:id/history` — all GET — and no create
or update route at all. `createResource` is reached only through `materials/stores.ts`,
`opd/masters.ts`, `lab/instruments.ts` and two seed scripts. **The laboratory has a door for its
instruments; radiology has none for its machines.**

So `seed:radiology` is the only writer of an imaging device, and the honest instruction is:

> A hospital with two CTs, a second DR unit or a C-arm adds it to `MODALITY_MACHINES` in
> `apps/core/scripts/seed-radiology.ts` and re-runs `pnpm seed:radiology`. Every step is
> find-or-create, so a re-run adds the new machine and touches nothing else.

**That is a deployment act, not a hospital one**, and it is a gap rather than a design: a hospital
cannot commission a machine on a Sunday without an engineer. It is recorded here so nobody looks for
a screen, and it is the same shape as §0 — a capability whose door was never built.

---

## 6. The tariff and the GST category

`seed:radiology` creates the service rows and sets **no prices**. Enter the rate list through the
tariff routes: draft a version, set a price per imaging service, submit, approve, activate.
**Not "the tariff screens"** — `tariff/manifest.ts` is `menu: []` with the comment *"no UI this
plan"*. The routes and the grants are real and the ceremony works; the screen is Plan 08's.

**The `investigation` GST category must exist**, or pricing refuses `gst_config_missing`. Every
imaging service is that category — and so is every laboratory service, so **this is one ruling for
both departments**, not two. The SAC code and whether it is exempt are a CA-and-owner decision. Do
not ship a placeholder into production.

Until a version is active, `startAcquisition` on a routine self-pay study refuses **`402
payment_required`** — *"take the money, or record it as stat if this is an emergency"* (DD12a). That
is the money gate working, not a tariff bug. The cashier also needs an **open cash session** before
any invoice can be issued.

The order of the two refusals is worth knowing: **the money gate fires before the licence gate**, so
a department with no tariff will never discover its AERB problem.

---

## 7. The AERB licences

`radiation-safety-go-live.md` §2, in full, and its §0 first. In summary: from the moment 18c is
deployed, an ionising study cannot be acquired on a machine with no active licence — the refusal
names the machine and the date and points at the RSO. Ultrasound and MRI are unaffected; the gate is
keyed on the study type's `ionising` flag.

**`GET /aerb/licences/gaps` coming back empty is the check.** So is the red *machines emitting with
no licence* block on `/radiology/radiation-safety` emptying — they read the same data.

---

## 8. The worker

`order.placed` is appended by the placement route and **dispatched by the worker process**. With no
worker running, `POST /radiology/orders` returns `201` and **no study is ever created** — the
department looks broken and the API looks healthy. If reception is empty after an order, check the
worker before anything else.

---

## 9. Verify — walk it once, deliberately

Place a real order and take it to the end. Every step below was performed on 2026-09-06 and each
number is what the route actually returns.

1. `POST /radiology/orders` → `201`, an `R…` order number and an `X…` accession appears at reception.
2. Schedule it onto a machine → `201`.
3. Check in → `201`, and the open gates come back named.
4. Satisfy each gate. **The evidence IS the body**, not nested: identity is
   `{"secondIdentifier":"uhid","value":"U…"}`, pregnancy is `{"declared":true,"lmpDate":"…"}`.
5. Bill it, then link the line — `POST /radiology/studies/:id/invoice-line` takes an **existing**
   `invoiceLineId`. Billing prices it; radiology only links it.
6. Start acquisition. **On an ionising study with no certificate on file this is where you meet
   `403 device_not_licensed`** — see it once, on purpose.
7. File the certificate at `/radiology/radiation-safety`, then start again → `201 in_acquisition`.
8. Record acquired **with a dose** — an ionising study carries at least one of CTDIvol, DLP or DAP.
9. Draft, sign (second factor), publish → the report shows `v2 — signed · published`.

---

## 10. Drills — before the pilot, not during it

**Drill A — the machine with no paper.** Try a CT on an unlicensed unit and read the refusal aloud.
It names the machine by its code and says who lifts it. Everyone on the floor should have met it once
before a patient is on the table.

**Drill B — a critical finding at 02:00.** Publish a report marked `red` and confirm the
acknowledgement lands. 18a-iii's chasers escalate an unacknowledged critical and an unread report;
they write a mark and raise an alert and **they never close a finding or mark a report read** — a
human does.

**Drill C — the outside film.** Register a study done elsewhere. It records the centre, the date and
how the images arrived, it is never billed as a performed study, and no dose is logged against it.
