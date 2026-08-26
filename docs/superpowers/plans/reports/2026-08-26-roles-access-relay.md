# Relay — roles, access and the elevation ceiling, 2026-08-26

**Commits, in order:** `fc9e49a` elevation ceiling + review queue · `0b26b61` role picker ·
`68868ed` Group C · `1ef118a` Group A · `37787de` the patient-merge lane · `fd92fe3` Group B.
**Migration:** `0023_elevation_review`. **Next free migration: 0026** — the identifier-grammar lane took 0024/0025.
**New seed:** `seed:patients`, in `deploy.sh` between `seed-opd` and `seed-billing`.

> ## STATUS: SHIPPED AND LIVE — deployed 2026-08-26 03:13 UTC, verified against the database
>
> `deploy.sh` exit 0; edge gate green (`{"status":"ok","db":"ok","worker":"ok"}` through Caddy, and
> `/admin/users` serving the SPA document). **No migration ran** — 0023–0025 were already applied,
> so this deploy was image + seed only.
>
> **The clinical fix is live.** All three active doctors — `anand.rao`, `meera.iyer`,
> `vikram.desai` — measured `patients.read: false` before and `true` after. Doctors can see the
> allergy register during consultation.
>
> **ONE THING IS STILL OUTSTANDING AND IT IS NOT A CODE CHANGE:** `seed:roles` exited 1 with
> `NOT READY — roles with zero holders: tariff_editor, membership_admin, mrd_officer,
> biomedical_engineer`. That is the census working, not a failure: `seed:roles` mints authority and
> ASSIGNS NOBODY, by design, and `deploy.sh` treats the verdict as non-fatal. **Those four roles
> exist with correct grants and no people in them.** Assign at `/admin/users` — `mrd_officer` is the
> one with immediate effect, because it opens the duplicate-patient repair path that has never
> worked on this deployment. Its approver, `medical_superintendent`, already has a holder.

Companion note: `2026-08-26-identifier-grammar-relay.md`. That lane and this one ran in the **same
checkout at the same time**; read §7 before you run a broad test suite or stage a commit.

---

## 1. What changed

**The elevation ceiling (`fc9e49a`).** `POST /auth/emergency-elevation` carries no
`@RequirePermission` on purpose — at 2 a.m. with the duty manager unreachable a person must be able
to act, and the design pays for that with loudness rather than a gate. But it accepted **any**
`roleKey`, and `hasPermission` honours a temp grant at *hospital* scope. Any authenticated user
could POST `{roleKey: "admin", ttlMinutes: 720}` and hold every `auth.*` permission for twelve
hours — long enough to `POST /admin/users` and give the new account a **permanent** `admin`
assignment. The elevation expired; the escalation did not. `assertMayTakeOver` could not catch it
either: it reads `role_assignments` only, so an elevated actor's `auth.*` set reads as empty.

**The review queue (`fc9e49a`).** Workforce mechanism 6 says emergency elevation is "loudly evented
+ **mandatory review**". The loud half shipped in Plan 02; the review half never existed.
`GET /auth/emergency-elevations/pending` and `POST /auth/emergency-elevations/:id/review` now do,
under a new permission `auth.elevation.review`, with an `emergency_elevation.reviewed` event.

**The role picker (`0b26b61`).** `admin-users.tsx` could REVOKE a role and never assign one — its
own header said so. The owner met that sentence as a bug report: *"I created users but can't assign
roles."* `GET /admin/roles` (`RolesCatalogController`) is the catalogue; the screen now assigns.

**Group C (`68868ed`).** Every `auth.*` string was held by `admin` alone, because `seed:admin`
grants the whole manifest there and no model row mentioned one. `medical_superintendent` gained the
two review desks; `duty_manager` gained `auth.temp_role.grant`, the mechanism the night-shift
bundling matrix was built on. All additive — `admin` keeps everything.

**Group A (`1ef118a`).** Eight permissions guarded LIVE routes and were held by nobody, so those
routes answered 403 to every account. New `tariff_editor`, `membership_admin` and
`biomedical_engineer`; `owner` gained the tariff activator key plus `approvals.types.manage`. The
price list now has the ceremony the state machine already had: editor drafts, `billing_manager`
approves via `tariff_revision`, owner activates.

**The merge lane (`37787de`).** See §2 — this one is the pattern in its purest form.

**Group B (`fd92fe3`).** `doctor` gained `patients.read` + `patients.update`; `pharmacy` gained
`patients.read`; `owner` gained the three billing reads. See the banner above.

---

## 2. THE PATTERN — a permission is the last mile of something, and four times it was the only mile

**Four times in one session, a missing GRANT turned out to be a missing MECHANISM.** Treat this as a
standing hypothesis, not four coincidences: permissions are declared beside routes, grants are
decided separately and later, and nothing checks that the machinery between them exists.

| the permission | what it looked like | what was actually missing |
|---|---|---|
| `auth.break_glass.use` | no clinical role holds it | **no route sets `breakGlassBypass`** — a grant unlocks nothing |
| `patients.merge` | MRD officer has no role | **`patient_merge` registered by no seed** — `requestApproval` threw `unknown_type` for everybody |
| `membership.catalog.manage` | unmodelled since Plan 09 | **guards no route in the tree** — its only occurrence is the manifest |
| `approvals.requests.*` for `duty_manager` | night override authority missing | worklist is role-scoped, decide enforces `approverRole` — **no type names `duty_manager`** |

**The check before you grant anything, and it is three greps:**

1. `grep -rn "<permission>" apps/core/src --include="*.ts" | grep -v test` — does it guard a route
   at all, or only appear in its manifest?
2. If the route creates an approval, is its `typeKey` registered by a seed *that `deploy.sh` runs*?
3. If it decides an approval, does any registered type name a role the grantee holds?

**Why the reachability census cannot see any of this.** `seed:roles`'s invariant asks whether a
permission has **a** holder. It never asks whether the holder can reach anything, nor whether the
role that *needs* it has it. Group B moved six pairs and **the census did not move at all** — every
string was already held by some role. A green census is not a working system.

---

## 3. Landmines — read before you touch auth or the role model

1. **`seed:admin` IS NOT IN `deploy.sh`, so adding an `auth.*` permission is a two-part change.**
   This one bit. `syncPermissions` mirrors the string into the catalog at api boot; only
   `seed-admin` grants it, and it is an operator command. Production ran part of 2026-08-26 with
   `auth.elevation.review` held by nobody. Re-running is safe and idempotent — the policy gate at
   `seed-admin.ts:136` fires only `if (userCreated)`, so `ADMIN_PASSWORD` is read and never used on
   a box that already has an admin. Command in §6.

2. **`fullAdministrators` requires the WHOLE `authManifest.permissions` set**, so adding a string
   moves a number the operator sees. Going 6 → 7 turned production's count from 1 to **0** until
   the grant landed, and `/admin/users` renders it in the two-admin banner.

3. **Seven censuses pin this model and they are SUPPOSED to fail when you change it.** In
   `seed-roles.test.ts`: the role-key list, the per-role permission counts, `modelPairs`,
   `modelPermissions`, `heldPermissions`, `NOT_YET_MODELLED`'s length AND its explicit roster, and
   `NON_TABLE_PAIRS`. Elsewhere: `seed-staff.test.ts`'s `KNOWN_ROLE_KEYS` (derived — it grows on its
   own, the pin is there so somebody notices) and `deploy-parity.test.ts`'s two seed-script censuses.
   Budget for all of them; the failures are precise and tell you the new number.

4. **Every non-table grant needs a README sentence this test quotes VERBATIM.** There are now seven
   such sets (`RULING_7_PAIRS`, `WORKFLOW_RULING_PAIRS`, `PLAN_09_PAIRS`, `GROUP_C_PAIRS`,
   `GROUP_A_PAIRS`, `MERGE_LANE_PAIRS`, `GROUP_B_PAIRS`). A model row in none of them fails V3's
   last leg, which is what stops the README-subset scoping becoming a hole.

5. **Do not add to `ELEVATABLE_AUTH_PERMISSIONS` without reading its header.** The list is what a
   temporary grant MAY carry; the forbidden set is `authManifest.permissions` **minus** it, so a new
   `auth.*` string is refused on arrival. Inverting it into a deny-list fails open on exactly the
   permission nobody thought about. `auth.break_glass.use` is the only member.

6. **`ASSIGNABLE_SCOPES` is `["hospital"]` and `roles-catalog.e2e.test.ts` PARSES THE SOURCE to
   prove it.** Every `@RequirePermission` in the tree demands hospital, and `hasPermission` refuses
   a non-hospital holding against a hospital requirement — so a department-scoped assignment grants
   **nothing, on every route**. If that test fails you have added a genuinely department-scoped
   route: widen the constant and the picker gains the option in the same commit. Do not weaken the
   test; do not add floor/department to the picker "for completeness".

---

## 4. Rules the code enforces, so don't "simplify" them away

- **The elevation ceiling guards BOTH doors.** `grantTempRole` is checked identically to
  `emergencyElevate` — which is what made Group C's `duty_manager` row safe to write at all.
- **A refused elevation writes NOTHING** — no row, no `emergency_elevation.used`. That event means
  authority was taken; emitting it for a refusal would put a lie in the stream the queue reads.
- **Expired elevations stay in the review queue.** The authority is gone; whether taking it was
  justified is not. Filtering on `expiresAt > now` makes the mandatory review a race the reviewer
  loses by sleeping.
- **The merge is gated three ways, independently:** `executeMerge` refuses anything but a `granted`
  approval; the approver is `medical_superintendent`, a different role; and
  `assertNotSodPair("requester_approver", …)` means one person holding BOTH roles still cannot
  approve their own merge — which matters, because in a small hospital they often will.
- **`tariff_editor` drafts and `owner` activates.** There is no `tariff_drafter_activator` SoD pair;
  the role boundary IS the control, and it is the first thing a revenue audit asks about.
- **`owner` has money and operations visibility, never clinical records.** The absence of
  `patients.read` there is a ruling, not an oversight: an owner who is also a clinician holds a
  SECOND role, visible on the admin screen.
- **`seed:patients` is in the DEPLOY path, not the runbook**, precisely because `seed:registration`
  is not — a registration that must be remembered per environment is one that gets forgotten, which
  is how `patient_merge` went unregistered from Plan 05 until now.

---

## 5. Known gaps, deliberately left open

- **`break-glass` unlocks nothing** and `recordReview` in `break-glass.ts` is weaker than its
  elevation counterpart — unconditional update, cannot tell a missing grant from a reviewed one,
  emits no event. Named in `temp-roles.ts` so the difference reads as a decision.
- **No second factor on any admin route.** Production holds zero TOTP enrolments (11e's seam).
- **Agents remain authenticated and powerless** — `guards.ts:99-101`.
- **No read-only observer role** (Group D, unbuilt) — see §8.

---

## 6. Production state — measured before and after the 2026-08-26 deploy

| | before | after (verified) |
|---|---|---|
| Roles in `roles` | 14 | **18** |
| `doctor` → `patients.read` / `.update` | **false** | **true / true** — all three active doctors |
| `pharmacy` permissions | 1 | **2** |
| `owner` permissions | 3 | **10** |
| `medical_superintendent` permissions | 2 | **7** |
| `duty_manager` permissions | 3 | **4** |
| `patient_merge` / `patient_unmerge` | **unregistered** | **both registered**, approver `medical_superintendent` |
| `auth.elevation.review` holders | `admin` | **`admin`, `medical_superintendent`** |
| `fullAdministrators` | 1 | 1 |
| Unreviewed emergency elevations | 0 | 0 |
| Holders of the four new roles | — | **ZERO — assign them** (see the banner) |

**Hard-reload every open browser tab after a deploy** (Ctrl+Shift+R). `deploy.sh` prints this
itself: a stale tab gets HTML where it expects JSON and fails opaquely.

The operator command for any future `auth.*` permission — idempotent, password never used on a box
that already has an admin:

```
cd /opt/hmis-prod && docker compose -p hmis-prod -f docker-compose.prod.yml --project-directory /opt/hmis-prod \
  run --rm -e ADMIN_USERNAME=admin -e ADMIN_FULL_NAME=Administrator -e ADMIN_PASSWORD=x \
  api node dist/scripts/seed-admin.js
```

`ADMIN_PASSWORD=x` is deliberate: it cannot pass the ten-character policy, so a wrong username makes
the script REFUSE rather than mint an administrator with a one-character password. Note `admin` is
the live account; `syn.smokeadmin` also holds the role and is deactivated.

**`seed:roles` mints authority and assigns nobody.** After deploying, `mrd_officer`,
`tariff_editor`, `membership_admin` and `biomedical_engineer` exist with **zero holders** — assign
them at `/admin/users`, which is now a two-click job because the picker exists.

---

## 7. The shared checkout

Both early commits are ancestors of `1bff417`, so the identifier-grammar lane's push and deploy
carried them. Nothing was lost either way; the only file overlap was the two locale catalogs, where
`rx.visitNo` and the `adminUsers.*` picker keys landed side by side.

What it cost was **verification, not code**. A full `pnpm verify` taken while the other session's
jest was running failed across a dozen unrelated suites — billing, tariff, opd, membership, ops,
realtime, identity — none explicable from the diff. Both sessions share `hmis_test_<worker>`. The
signature is `perf-opd-queue.test.ts` dying on `opd_encounters_patient_id_patients_id_fk`: another
run truncated `patients` mid-test.

- **`ps -eo pid,etimes,cmd | grep jest` before believing any broad failure.** A second session shows
  its own `/tmp/claude-0/-opt-hmis/<uuid>/` scratchpad path.
- **Run the suites your change touches; re-run collisions in isolation.** Every suite that failed in
  the batch passed alone.
- **Stage explicitly. Never `git add -A` in this checkout.**
- **`git stash -u` sweeps their files too.** It round-trips safely, but their work reappears in
  `git status` after the pop and reads as your own. That is what it looks like; it is not damage.

---

## 8. What remains, and the suggested order

**Ruled by the owner 2026-08-25, still unbuilt:**

- **Role authoring: hybrid with an approval ceremony.** Not free-form DB editing — a composer that
  drafts a role from the permission catalogue, then **draft → approve → activate** through the
  approvals engine, evented, with SoD warnings, mirroring how workflow definitions are governed.
  **The largest unbuilt piece.** Note it will hit the same wall as everything in §2: a role minted
  at runtime is invisible to `ROLE_MODEL`, so the census and the README-parity tests need a
  DB-authored class distinct from the code-owned one before this can land.
- **Agent authority: design now, build in Plan 12a.** Start from `guards.ts:99-101` —
  `"agents hold no permissions yet"`, so every agent request is 403 on every guarded route.
  `auth.agents.manage` is declared, granted to `admin`, and **guards zero routes** — the shape
  `auth.users.manage` had before 11e. And `role_assignments.user_id` FKs `users.id`, so an agent
  **cannot hold a role at all**. The design owes: delegated authority (`user ∩ agent`) for
  interactive copilots versus **standing** authority for scheduled automations with no human to
  intersect against; whether autonomy tier is a column or is expressed as `.draft`-style permission
  strings the guards already enforce (a tier no route reads is documentation); and the two §16
  guardrails that do not exist — **global halt** and **agent heartbeat**.

**Group D — the missing shape.** There is still **no read-only observer role**; every read
permission is bundled with a write role. Internal audit (E-17) needs one, and it is exactly the
shape Digest Writer and Leakage Auditor need in 12a — building it now means the agent runtime
inherits a proven pattern instead of inventing one.

**Group E — blocked on owner rulings.** `patients.confidential.read` (who may see a VIP/staff
record — note the identifier lane's ruling that this lives on `patients.is_confidential`, **not** in
a UHID serial band) · the seven `partners.*` (Plan 09 O-8, CA/counsel register) ·
`approvals.requests.create`.

**The four unwired mechanisms from §2**, each a design piece rather than a role row:
break-glass bypass (and whether it may cross the confidential gate — spec §14 puts "open any record"
and "confidential stays sealed" in direct tension, which only the owner can resolve) · night
override for the duty manager · a screen for `membership.catalog.manage` · `display` as a device
identity rather than a role.

**Suggested order.** **Assign the four empty roles first** — it is a two-click job at
`/admin/users` and until it is done, four correct grants reach nobody (the banner names them).
Then **Group D**, because it is small and 12a wants the shape. Then the **break-glass ruling**,
which is the only remaining item with a clinical edge — and note it is a §2 item, so expect wiring
plus a ruling rather than a role row. The composer ceremony and the agent design doc are both large
and independent; the agent doc touches no shipped code and can run in parallel with anything.
