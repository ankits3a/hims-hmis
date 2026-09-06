# The radiology commissioning walk — 2026-09-06

**What this is:** the imaging department stood up from an empty database and walked seat by seat in a
real browser, on an isolated dev stack. It is the rehearsal `docs/runbooks/radiation-safety-go-live.md`
§0 asks for — *"on a staging copy, apply the migrations WITHOUT filing a licence and try to start a
CT ... see it once, deliberately, on a Tuesday"* — performed, plus everything that blocked the way
there.

**Why it was worth doing:** production is running 18a, 18b and 18c. The 18c licence gate is live
against an empty `aerb_licences` table, so every ionising examination is being refused. The remedy is
data entry, and this walk establishes whether the path to that remedy actually works. **It did not, in
four separate places, and none of the four was visible to a green test suite.**

Environment: `hmis_rad_dev` on `:5433` (dev; `:5434` is `hmis-prod-db-1` and was never touched),
API `:3030`, web `:5200`. **No production database was read or written at any point.**

---

## 1. The finding that outranks the rest

**`pnpm seed:radiology` could not succeed on a fresh deployment.** It died on its first statement:

```
GovernanceError: workflow governance refused: actor_not_user
  at activateDefinition (kernel/workflow/definitions.ts:185)
  at registerRadiologyApprovalTypes (modules/radiology/approval-types.ts:82)
```

`registerRadiologyApprovalTypes` is **line 102, the first statement in `seedRadiology`** — before the
service loop, before the machine loop, before the study-type book. So a fresh database gets **no
services, no `device` resources and no active `study_types`**. Not a partial seed: nothing.

The script passed its system `SEEDER` to a function whose own docstring has required a `"user"` actor
since 18a T4, and whose two kernel calls each refuse a system one independently — `activateDefinition`
(`actor_not_user`) and `registerApprovalType` (`user_actor_required`, *"agents are the Plan 12 seam"*).
Two guards saying the same thing is a decision, so the fix runs the act as a user rather than widening
either. **PR #133.**

**Why it survived four phases.** The registration loop skips a typeKey that is already registered, so
on any database whose types already existed the broken line never executed and the seed exited 0.
*Invisible exactly where the seed had been run before, fatal exactly where it had not* — invisible in
development, fatal at go-live. The script had no test; nothing short of a run from `truncateAll` could
meet it.

> **A question for the owner that follows from this, and that no lane can answer.** If the seed never
> succeeded on a fresh database, production's radiology was stood up some other way or not at all. It
> is worth confirming production actually holds an active `study_types` definition and its five
> `device` resources. **18c's licence gate points at a `device` registry row** — if the machines were
> never created, "enter the certificates" has nothing to attach them to, and that step precedes the
> RSO assignment rather than following it.

---

## 2. The preconditions nobody documents, in the order they blocked the walk

Each was found by being stopped by it.

| # | What blocked | Why it is not in any runbook |
|---|---|---|
| 1 | `seed:radiology` refused `actor_not_user` | §1. PR #133 |
| 2 | **The two `imaging_*` workflow definitions are activated by nothing** | see below — **this one has no owner** |
| 3 | A Class-A definition needs **three** distinct humans, not two | `workflow_drafter_activator` SoD, written down nowhere |
| 4 | The **worker must be running** or no study is ever created | `order.placed` is appended by the route and dispatched by the worker |
| 5 | No ACTIVE tariff version → `402 payment_required` at acquisition | deliberate (owner item O6); prices are the owner's data |
| 6 | No `investigation` GST category | shared with the laboratory; one CA ruling, not two |
| 7 | The cashier needs an **open cash session** before issuing | `409 no_open_session` |
| 8 | `GET /aerb/licences/gaps` — the runbook's own check — returned **400** | §3. PR #135 |
| 9 | Signing needs TOTP enrolment | works: `/auth/totp/enroll` → `confirm` → `verify` → sign |

**Precondition 2 is the one to act on.** `RADIOLOGY_WORKFLOW_DEFINITIONS` (`imaging_study` and
`imaging_gate`, both `changeClass: "A"`) is referenced by the e2e test and the test helper and **by no
seed, script or runbook**. Without them the department has no state machine at all. Radiology is the
only clinical module with no go-live runbook of its own — `docs/runbooks/` holds
`radiology-pacs-go-live.md` (18b) and `radiation-safety-go-live.md` (18c), and neither mentions this.
`apps/core/scripts/dev-radiology-standup.ts` now performs it for a dev stack; **a production go-live
still needs it written down as a human ceremony**, because it names three people.

Precondition 3 corrects something several documents state incorrectly. A Class-A definition is
commonly described as "two keys, owner and medical superintendent". It needs **three distinct humans**:
`approveDefinition` refuses a second approval from the same *person*, and the SoD pair
`workflow_drafter_activator` refuses an activation by whoever drafted it. Discovered as a
`SodViolationError`, not by reading.

---

## 3. The §0 rehearsal, performed

Order → schedule → check-in → gates → billing → **licence gate** → acquisition → dose → report → sign
→ publish, over the real routes, as the real roles.

```
POST /radiology/studies/:id/acquisition/start          (radiographer, CT-1, no certificate on file)
403 device_not_licensed
"device 01M1VRJ4R8V6XJ0BGCRQKQBM9H carries no active AERB licence covering 2026-09-06 —
 equipment that emits ionising radiation may not be operated without one"
```

**That is what a radiographer meets in production today.** The certificate was then filed through the
real screen at `/radiology/radiation-safety` as the RSO — CT-1 dropped off the red *machines emitting
with no licence* block, leaving MMG-1 and XR-1 — and the same request succeeded:

```
201 {"status":"in_acquisition","authorisedBy":"invoice"}
```

The screen works, and the remedy path is real. **The gap in production is the data and the people, not
the code.**

Two defects came out of the rehearsal, both fixed:

**`GET /aerb/licences/gaps` returned `400`.** `onDate` is declared optional and was parsed as
required, so the bare call — the one §0 publishes, whose empty answer *is* the deploy gate — could not
be made. The e2e always asked `?onDate=`, and so does the screen, so the only form never exercised was
the only form documented. Now defaults to the server's IST day, this module's own idiom. **PR #135.**

**The refusal named the machine by ULID.** A radiographer reads it standing at a console in X-ray
room 1, and nothing on that screen maps `01M1VRJ4QVQWNA2V3X8YYK62MF` back to the room — so the one
thing they must tell the RSO was the one thing the refusal did not say. It now reads
`XR-1 (X-ray room 1) carries no active AERB licence covering 2026-09-06 … The radiation safety officer
files the certificate under Radiation safety → Licences.` **PR #138.**

---

## 4. What only the browser answered

- **The clinical hard stop is English on a fully Hindi screen.** With the UI in Hindi
  (`document.documentElement.lang === "hi"`, chrome fully translated — `सुरक्षा गेट`,
  `सभी गेट पूरे — यह जाँच तैयार है।`) the licence refusal and the gate refusal both arrive in English.
  The laboratory has the same shape. **Naming the machine (PR #138) was the higher-value half**: a code
  reads identically in both scripts, a ULID reads as noise in either. Translating these sentences is a
  real item and is *not* done.
- **Gate state chips are untranslated** — the gate *names* translate (`पहचान (दो कारक)`,
  `गर्भावस्था जाँच`) while their states render as bare `satisfied` / `open` in both languages.
- **The licence form's machine picker is right, and I was wrong about it first.** It offers all five
  machines but labels the two that need none — `MRI-1 … · AERB does not licence this modality`. My
  first note called that a defect; it came from reading truncated `<option>` text rather than the
  rendered page.
- **The worklist tabs are correct.** `Unread` means status `acquired` or `reported` — the radiologist's
  reporting queue — so a published study correctly leaves it and appears under `All`. Checked before
  filing, and it was not a defect.
- Reception, worklist, study console, report and radiation-safety all render with **no 403s and no
  console errors** across `rad.desk`, `rad.tech`, `dr.mehta` and `rso.singh`.

---

## 5. Synthetic data now in `hmis_rad_dev`

Eight staff (`owner.gupta`, `ms.iyer`, `opd.admin`, `dr.rao`, `rad.desk`, `rad.tech`, `dr.mehta`,
`rso.singh`, all `demo-pass-2026`), three patients with encounters, 20 imaging services with **labelled
DEV placeholder** prices, an active tariff version, one CT licence numbered `…DEMO…`, and one completed
study — `X2609060001`, CT head, dose recorded, report signed under a fresh second factor and published.

**No seed writes an AERB licence and that must stay true** (`aerb/licences.ts`: a placeholder row is a
hospital claiming paper it does not hold). The one certificate here went in through the real
`POST /aerb/licences` route and carries `DEMO`. MMG-1 and XR-1 were deliberately left unlicensed so the
gap block and the refusal stay demonstrable.

---

## 6. What is still the owner's

1. **The RSO assignment in production.** `seed:roles` mints authority and assigns nobody; the runbook
   says in its own words that *nobody can file a licence without it*. Role existing and somebody
   holding it are two different preconditions — and if nobody holds it, the ionising modalities are
   refused and **no account can lift the refusal**.
2. **The certificates**, entered until `GET /aerb/licences/gaps` comes back empty.
3. **Real imaging prices and the SAC ruling** for the `investigation` category. Everything this walk
   wrote is a labelled dev placeholder.
4. **Whether `imaging_study` / `imaging_gate` activation belongs in a seed or a written ceremony.** It
   names three people, so it is probably a runbook step — but radiology has no runbook to put it in.

---

## 7. CORRECTION — the walk's API was a day-old build, and what that changes

**Added the same evening, after the error was found.** The stack this walk drove was built with
`pnpm build` **at the repo root, where there is no `build` script**. It exited **254**
(`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "build" not found`); the failure was printed and then
not read, because a background task reported "exit code 0" and that was the number believed. The API
served `dist` from the previous day. The real command is
`pnpm --filter @hmis/core exec tsc -p tsconfig.build.json`.

**What it does not change, re-measured rather than argued.** Every finding above was confirmed from
source by jest, and both API-level ones were re-run against a correctly built current API:

```
GET /aerb/licences/gaps        -> 400   (unchanged)
POST .../acquisition/start     -> 403   "device 01M1VRJ4QVQ… carries no active AERB licence"
```

Identical. §1, §2 and the screen observations in §4 are unaffected — **vite serves the client from
source**, so every UI finding was always against current code.

**What it does change:** the walk never exercised 18a-iii T1–T4, because those routes were not in the
running API. §3's clinical walk is a walk of 18a, 18b and 18c. That is worth stating plainly rather
than leaving to be inferred from a date.

**And the lesson is the one that generalises.** `pnpm build` appears in three lanes' stand-up notes
and does not exist. A command that fails loudly is still silent if nobody reads the number — and a
backgrounded pipeline reports the exit status of the *last* command in it, not the one that mattered.

---

## 8. THE FINDING THE REBUILD SURFACED — radiology has no inbound door

With the correct build running, the 18a-iii routes appeared, and enumerating what the client actually
calls answered a question the walk had not thought to ask.

| measured | result |
|---|---|
| `/orders` prefix anywhere in `apps/web/src` | **0** |
| `"radiology/orders"` anywhere in `apps/web/src` | **0** |
| callers of `placeImagingOrder` in core | `radiology-orders.controller.ts` and `place.ts` only |
| any OPD path that creates an imaging order | none |

**Nothing in the product places an imaging order.** Reception's *Walk in* auto-slots a study that
already exists; it does not create one. The department can schedule, gate, acquire, report, sign and
publish — and no screen can put a study into it. **Every study in this walk was created with `curl`.**

Three more of the same shape, all 18a-iii, all merged this week, all with **zero web callers**:

- `POST /radiology/studies/:id/contrast` — T1, the contrast administration record
- `POST /radiology/studies/contrast-reactions` — T2, **the reaction that writes the patient's allergy**
- `POST /radiology/studies/:id/outside` — T4, the outside-study register

**T2 is the one to raise first.** The entire point of that chain is that the next CT's safety gate
reads an allergy the reaction wrote — 18a's gate reads it, and 18a-iii's D2 put the write in the same
transaction precisely so it could not be missed. There is no way to record one.

This is the same shape as §1 and §2 at the largest scale, and it is worth noting that it probably
explains the "18a has been exercised by a real department" line the phase documents carry: alongside
§1, that reads as inherited optimism rather than a measurement.

**Building an ordering surface is a scope decision and is deliberately not taken here.** It is a new
clinical screen, not a judgement call inside existing work, and it is the owner's to schedule.
