# The history horizon

**Date:** 2026-09-14 · **Lane:** `lane/staff-reports` · Companion to `01-front-desk-reporting.md`

Owner ruling 2026-09-14: how far back a person may look is decided by who they are.

| Tier | Reaches back | Who |
|---|---|---|
| floor | **3 months** | `front_office` |
| year | **1 year** | `front_office_supervisor` |
| full | **unbounded** | `medical_superintendent`, `staff_auditor`, `owner` |

## 1. Two things measured first, and both matter

### 1.1 `user_day_facts` is never pruned

No retention rule touches it; nothing in `kernel/retention` or the worker sweeps it. So the
unbounded tier is a real capability rather than a promise the storage cannot keep. The table is
tens of staff x 365 rows a year — it will not become a size problem in this hospital's lifetime.

Had this gone the other way, "beyond 1 year" would have been ungrantable no matter what permission
said otherwise, and the ruling would have needed re-taking. It is worth checking BEFORE building the
tier rather than discovering it when a manager asks for two years and gets silence.

### 1.2 The baseline window is fetched for every period and USED by only two

`brief.ts` gives `day` and `week` a comparison baseline; `month`, `quarter`, `half` (and the new
`year`) carry DRIFT instead — the window's own first half against its own second half, computed
from the window itself.

But both controllers fetch the baseline unconditionally:

```
const [days, baseline] = await Promise.all([
  factsForWindow(..., w.from, w.to, ...),
  factsForWindow(..., b.from, b.to, ...),   // thrown away for month/quarter/half/year
]);
```

So a 3-month brief reads **182 days** today — 91 it shows and 91 it discards.

**This is why the horizon design is simple rather than fiddly.** If that fetch stayed, a clerk
capped at three months would silently read six, and the cap would have to be enforced against the
oldest day READ with a clamping rule for the baseline — which then collides with 07c DD8 (a figure
with no honest baseline shows none) and needs an argument.

**DECIDED (H1): skip the baseline fetch for periods that do not consume it.** It is a performance
fix and the horizon's simplification in one change. After it:

- `month` / `quarter` / `half` / `year` read exactly their own window.
- `day` / `week` read their window plus a baseline of at most 14 days — inside every tier.

The horizon then binds the REQUESTED PERIOD directly. No clamping rule, no DD8 collision, nothing
to remember.

## 2. The horizon is a permission, not a role constant

Two new strings, in the vocabulary that already exists (`staff.reports.read`, `staff.reports.drill`):

- `staff.reports.history.year`
- `staff.reports.history.full`

Holding neither is the floor. The tiers are a lattice, not a switch — `.full` implies `.year`
implies the floor.

**Why not a `Record<roleKey, horizon>` map:**

1. **Roles combine, and that is stated house doctrine.** `kernel/desk/types.ts`: *"Roles combine —
   the counter clerk this work began with holds registration, appointments and billing at once."* A
   role-to-horizon map needs a `max()` across the caller's roles and will be written without one the
   first time, because the person writing it has one role in mind. Permissions union for free: hold
   more, see more, with no arithmetic.
2. **A policy in a code constant is work to get out again.** Plan 20 hit exactly this — the
   escalation destination was a code constant, so making it configurable became work inside the plan
   rather than a grant.
3. **`grantPermissionToRole` refuses any string no manifest declares**, so a typo is a loud failure
   at seed time rather than a permission nobody can hold.
4. The owner can move a person between tiers with a grant instead of a release.

### 2.1 The grants

| Role | Change |
|---|---|
| `front_office` | none — floor is the absence of a grant |
| `front_office_supervisor` | **+ `staff.reports.history.year`** (already holds `staff.reports.read`) |
| `medical_superintendent` | **+ `staff.reports.history.full`** (already holds the read) |
| `staff_auditor` | **+ `staff.reports.history.full`** (already holds the read) |
| `owner` | **+ `staff.reports.read` + `staff.reports.history.full`** |

**`owner` holds NO staff-report permission today.** Not the read, not the drill. The owner cannot
open `/staff` at all. That is a live defect this ruling exposes rather than a decision anyone took —
it is fixed here.

`owner` gets the read and the full horizon; it does **not** get `staff.reports.drill`, which stays
what 07c made it: a separate string, separately granted, for reading the patient rows behind a
colleague's figures.

## 3. What the floor actually restricts

`front_office` holds no staff-report permission and will not be granted one (ruling 2026-09-14: a
clerk sees **their own** figures, not the team's). Their route is `/me/brief`, which is
**ungated — no `@RequirePermission` at all** — because DD4 self-scoping says there is no `userId` in
the path and therefore no version of it that reads a colleague's history.

So the 3-month floor is a **restriction on a capability every user already has**: `/me/brief` offers
all five periods to everyone today. After this, a clerk's own brief stops at `quarter`.

**DECIDED (H2): the floor applies to `/me/…` too, and it is the only place an existing capability
narrows.** Say so in the release note. A clerk who pulled a 6-month self-brief last week and cannot
this week should find the reason written down, not discover it as a bug.

## 4. Where the horizon binds

Every door that reads a historical day, and the cap is computed from the **caller's** permissions —
never the subject's.

| Surface | Bound by |
|---|---|
| `GET /me/brief` | requested period |
| `GET /me/report`, `/me/report.csv` | the requested `date` |
| `GET /staff/:id/brief` | requested period |
| `POST /staff/:id/drill` | the requested `date` (one day, but it can be any day) |
| T4 range instrument + every `.csv` | the `from` of the range |
| **MRD register (T7)** | **not bound — see §5** |

### 4.1 One helper, one census test

A single `horizonFor(actor)` returning the oldest permitted IST day, and one
`assertWithinHorizon(oldestDay, horizon)` that every door calls.

Then a **census test in the shape `ist-clock-parity.test.ts` already established** — it pins the set
of routes that read historical days and reddens when a new one appears without the check. A control
that depends on the next author remembering is not a control; this is the house idiom for turning
that into a compiler.

### 4.2 It refuses; it does not return empty

**DECIDED (H3):** over-horizon is `history_horizon_exceeded`, naming the caller's cap in the
message. Never a truncated window and never an empty brief.

An empty brief reads as *"this person did nothing"* — which `requireSubject`'s own comment calls
the one answer a supervisor must never be given by accident, because it is indistinguishable from a
person who did nothing. A silently truncated window is worse: it is a number that looks right.

### 4.3 The picker is convenience, not the control

The web period picker renders only the periods the caller may ask for. The server refuses
regardless — a hidden `<option>` is not an access control, and the route is reachable without the
screen.

## 5. MRD is not bound by the horizon

The owner's "MRD is a different animal" ruling extends here consistently: the MRD register (T7) has
**no history cap**. It is a statutory record whose retention schedule runs to years, and an MRD
officer who cannot reach a record from four years ago cannot do the job the role exists for.

`mrd.register.read` alone governs it — the permission is the control, the date range is not. Every
pull is still audited with its range and row count, and patient aliasing still applies against the
puller's clearance.

Capping MRD at a staff-supervision horizon would be the same category error as reaching the register
through `staff.reports.drill`: applying a supervision rule to a records-keeping act.

## 6. Tasks

Folded into `01`'s list:

- **T0 — the horizon.** H1's baseline-fetch fix, the two permission strings, the five grants,
  `horizonFor` + `assertWithinHorizon` at six doors, the census test, and the `year` period from
  D6 (they touch the same files and splitting them means writing `brief.ts` twice).

T0 lands first: every later task adds a surface that must call the check, and adding the check after
those surfaces exist means finding them all again.

### 6.1 The coordination cost, now two strings larger

`01` §9.1 named `mrd.register.read` as the one shared-file edit. It is now three new permission
strings across `scripts/seed-roles.ts` and `test/seed-roles.test.ts` (which pins permission counts),
plus the `staff.reports.history.*` pair declared in `kernel/desk/manifest.ts`.

T0 and T7 both move the pinned count. **They should not be in flight against each other** — either
one PR or a deliberate order, because two lanes each rebasing a pinned count onto the other is the
collision `serial-gap-poisons-lane-test-db` describes in a different register.
