# Relay — roles, access and the elevation ceiling, landed 2026-08-26

**Commits:** `fc9e49a` (elevation ceiling + review queue) · `0b26b61` (role picker)
**Migration:** `0023_elevation_review`. **Next free migration: 0026** — the identifier-grammar lane took 0024/0025.
**Status: SHIPPED AND LIVE.** Deployed 2026-08-26 as an ancestor of `1bff417`; the operator step was performed after the fact (§5).

Companion note: `2026-08-26-identifier-grammar-relay.md`. That lane and this one ran in the **same
checkout at the same time**; read §6 before you run a broad test suite or stage a commit.

---

## 1. What changed, in one paragraph each

**The elevation ceiling.** `POST /auth/emergency-elevation` carries no `@RequirePermission` on purpose
— at 2 a.m. with the duty manager unreachable a person must be able to act, and the design pays for
that with loudness rather than a gate. But it accepted **any** `roleKey`, and `hasPermission` honours a
temp grant at *hospital* scope. So any authenticated user could POST `{roleKey: "admin",
ttlMinutes: 720}` and hold every `auth.*` permission for twelve hours — long enough to `POST
/admin/users` and give the new account a **permanent** `admin` assignment. The elevation expired; the
escalation did not. `assertMayTakeOver` could not catch it either: it reads `role_assignments` only, so
an elevated actor's `auth.*` set reads as empty. `temp-roles.ts` now refuses any role carrying authority
over access, on **both** grant doors.

**The review queue.** The staffing spec's workforce mechanism 6 says emergency elevation is "loudly
evented + **mandatory review**". The loud half shipped in Plan 02; the review half never existed —
`break_glass_grants` had `reviewed_at`/`reviewed_by`/`review_note` and a pending queue, and the table
recording a person handing *themselves* a role had nothing. `GET /auth/emergency-elevations/pending`
and `POST /auth/emergency-elevations/:id/review` now exist under a new permission,
`auth.elevation.review`, with an `emergency_elevation.reviewed` event.

**The role picker.** `admin-users.tsx` shipped able to REVOKE a role and never to assign one; its own
header said assigning "needs a role picker fed by a roles list the server does not yet expose". That
sentence was met in production as a bug report — *"I created users but can't assign roles."*
`RolesCatalogController` (`GET /admin/roles`, under `auth.roles.manage`) is that list, and the screen
now assigns. It reads only: role **authoring** stays code-owned.

---

## 2. Landmines — read this before you touch auth

1. **`seed:admin` IS NOT IN `deploy.sh`, and adding an `auth.*` permission is therefore a two-part
   change.** This is the one that actually bit. `syncPermissions` mirrors the new string into the
   `permissions` catalog at api boot, but only `seed-admin` grants it, and it is an operator command by
   design. Between deploy and that command, production had `auth.elevation.review` in the catalog held
   by **nobody** — the review queue answered 403 to the sole administrator. Re-running it is safe and
   idempotent: the policy gate at `seed-admin.ts:136` fires only `if (userCreated)`, so on a deployment
   that already has an admin, `ADMIN_PASSWORD` is read and never used. The repair is in §5.

2. **`fullAdministrators` requires the WHOLE `authManifest.permissions` set, so adding a string moves a
   number the operator sees.** It is `held.length === authManifest.permissions.length`. Going 6 → 7
   turned production's count from 1 to **0** until the grant landed, and `/admin/users` renders that
   count in the two-admin banner. Nothing had degraded; the definition moved under a deployment that
   had not been re-seeded. Expect this every time the manifest grows.

3. **Three tests pin the auth manifest exactly, and they are supposed to fail when you add to it.**
   `user-admin.e2e.test.ts`'s M6 leg ("a seventh `auth.*` is covered on arrival") pins the sorted list;
   its leg 3 pins the guarded-elsewhere exception list; `seed-roles.test.ts` pins the census at
   **74 declared = 51 held + 23 not yet modelled** in five places. Update them deliberately — that
   failure is the mechanism working, not an obstacle.

4. **Do not add anything to `ELEVATABLE_AUTH_PERMISSIONS` without reading its header.** The list is what
   a temporary grant MAY carry; the forbidden set is `authManifest.permissions` **minus** that list, so a
   new `auth.*` string is refused the day it is declared without anybody remembering. Inverting it into a
   hand-written deny-list fails open on exactly the permission nobody thought about. `auth.break_glass.use`
   is the single member: it is the emergency the mechanism exists for and confers nothing durable.
   `auth.elevation.review` is deliberately absent — that is what makes self-elevating into clearing your
   own elevation structurally impossible.

5. **`ASSIGNABLE_SCOPES` is `["hospital"]` and `roles-catalog.e2e.test.ts` PARSES THE SOURCE to prove it.**
   Every `@RequirePermission` in the tree demands `"hospital"`, and `hasPermission` refuses a
   non-hospital holding against a hospital requirement. A department-scoped assignment grants its holder
   **exactly nothing, on every route**. If that test starts failing you have added a genuinely
   department-scoped route: widen the constant and the picker gains the option in the same commit. Do not
   weaken the test, and do not add floor/department to the picker to be "complete".

6. **`truncateAll` did not need a new entry this time** — `temp_role_grants` was already in it. If you add
   a table this lane's successors assert counts on, it does.

---

## 3. Rules the code enforces, so don't "simplify" them away

- **The ceiling guards BOTH doors.** `grantTempRole` is checked identically to `emergencyElevate`. Today
  only `admin` holds `auth.temp_role.grant` so the admin-granted path is not itself an escalation — but
  §7's group C proposes moving that permission to the duty manager, and on the day it moves, two
  colleagues granting each other `admin` would reopen the hole through the other door.
- **A refused elevation writes NOTHING** — no row, no `emergency_elevation.used`. That event means
  authority was taken; emitting it for a refusal would put a lie in the stream the review queue reads.
- **Expired grants stay in the review queue.** The authority is gone; whether taking it was justified is
  not, and that is the only question a reviewer is asked. Filtering on `expiresAt > now` would drain the
  queue on a twelve-hour timer and call that "reviewed" — a race the reviewer loses by sleeping.
- **The review is a conditional UPDATE** (`isNull(reviewedAt)` in the WHERE), so two reviewers racing
  produce one winner and one event. A read-then-write commits both at READ COMMITTED.
- **Delegating authority over access is a PERMANENT assignment or it does not happen.** Temp grants are
  invisible to `hospitalScopeHolders` and `authPermissionsHeld` by design, so a temporary `admin` would be
  an administrator neither the lockout invariant nor the takeover rule can see.
- **The picker excludes roles the person already holds.** `assignRole` mints a fresh row per call and
  refuses nothing; an unfiltered list lets a double-click stack duplicates that each need their own revoke.
- **`grantsAccessAuthority` is derived server-side from `authManifest`**, never recomputed in the client, so
  the eighth `auth.*` string lights the warning with no web change.

---

## 4. Known gaps, deliberately left open

**`break-glass.ts`'s `recordReview` is weaker than its elevation counterpart and was left alone.** It
updates unconditionally, cannot distinguish a missing grant from an already-reviewed one, and **emits no
event at all**. That is a real gap, named in `temp-roles.ts`'s header so the difference reads as a decision
rather than an inconsistency. Closing it is cheap and belongs with whoever next touches break-glass.

**No second factor on any admin route.** Production still holds zero TOTP enrolments (11e's stated seam),
so turning `secondFactor: true` on would brick the surface. Unchanged by this work.

**Agents remain authenticated and powerless** — see §7.

---

## 5. Production state after this landed

| | before | after |
|---|---|---|
| Migrations applied | through 0022 | 26 rows, through `0025` (0023 is this lane's) |
| `auth.elevation.review` in catalog | — | present (added by `syncPermissions` at boot) |
| Roles granting it | — | `admin` |
| `admin` holds `auth.*` | 6 | **7 of 7** |
| `fullAdministrators` | 1 | **1** (it read **0** between deploy and the repair) |
| Unreviewed emergency elevations | — | **0** (none has ever been taken) |
| Self-elevation to `admin` | **possible, 12h, then permanent** | refused, 403 `role_not_temporarily_grantable` |

The repair, performed 2026-08-26 after the deploy, and the thing to run again the next time an `auth.*`
permission is declared:

```
cd /opt/hmis-prod && docker compose -p hmis-prod -f docker-compose.prod.yml --project-directory /opt/hmis-prod \
  run --rm -e ADMIN_USERNAME=admin -e ADMIN_FULL_NAME=Administrator -e ADMIN_PASSWORD=x \
  api node dist/scripts/seed-admin.js
```

`ADMIN_PASSWORD=x` is deliberate, not lazy: the user exists so the value is never used, and it cannot pass
the ten-character policy — so if the username were ever wrong the script REFUSES and writes nothing instead
of minting an administrator with a one-character password. It fails safe in the one direction that matters.
Note `admin` is the live account; `syn.smokeadmin` also holds the role and is **deactivated**.

---

## 6. The shared-checkout collision, from this side

Both commits here are ancestors of `1bff417`, so the identifier-grammar lane's push **and its production
deploy carried them**. Nothing was lost in either direction and no file was overruled: the only overlap was
`locales/en.json` / `hi.json`, where `rx.visitNo` and the `adminUsers.*` picker keys landed side by side.

What it cost was **verification, not code**. A full `pnpm verify` taken while the other session's jest was
running failed across a dozen unrelated suites — billing, tariff, opd, membership, ops, realtime, identity —
with foreign-key violations and 5 s timeouts, none of them explicable from the diff. Both sessions share
`hmis_test_<worker>`. The signature to recognise is `perf-opd-queue.test.ts` dying on
`opd_encounters_patient_id_patients_id_fk`: another run truncated `patients` mid-test.

Habits, matching the companion note's §5 and adding one:

- **`ps -eo pid,etimes,cmd | grep jest` before believing any broad failure.** A second session shows its own
  `/tmp/claude-0/-opt-hmis/<uuid>/` scratchpad path.
- **Run the suites your change touches; re-run collisions in isolation.** Every suite that failed in the
  batch here passed alone.
- **Stage explicitly. Never `git add -A` in this checkout** — the tree holds another lane's in-flight work.
- **`git stash -u` sweeps their files too.** It round-trips safely, but their work reappears in `git status`
  after the pop and reads as your own. That is what it looks like; it is not damage.

---

## 7. What the owner ruled, and the next right action

Ruled 2026-08-25 in the brainstorm that produced this work:

- **Role authoring: hybrid with an approval ceremony.** Not free-form DB editing. A composer screen drafts
  a role from the permission catalogue, then **draft → approve → activate** through the approvals engine,
  evented, with SoD warnings — mirroring how workflow definitions are already governed. The vocabulary stays
  code-owned until that ceremony exists. **This is the largest unbuilt piece and the natural next slice.**
- **Agent authority: design now, build in Plan 12a.** No agent code this phase.

**The role-model corrections the owner asked for ("think of more similar"), none of them yet built:**

- *Group A — new roles, permissions already exist, no holder:* `tariff_editor` (draft) with `owner` keeping
  `tariff.versions.activate` to honour the drafter/activator pair · `mrd_officer` (`patients.merge` — today
  duplicate records have **no repair path**) · `membership_admin` · `biomedical_engineer`
  (`ops.interface.manage`, currently bundled into `duty_manager`) · a holder for `approvals.types.manage`.
- *Group B — roles too thin to do their job:* `medical_superintendent` holds two workflow permissions and
  **cannot read a patient record** · `owner` holds three and cannot see an invoice or report · `duty_manager`
  has no `approvals.requests.decide` despite the bundling matrix giving it night override authority ·
  `pharmacy` holds exactly one permission · `display` is a role for a screen and should be a device identity.
- *Group C — permissions on the wrong role, all six `auth.*` sit on `admin` alone:* **`auth.break_glass.use`
  has NO clinical holder**, so spec §14's "ER staff can open any record instantly" is not true on this
  deployment · `auth.break_glass.review` and now `auth.elevation.review` sit with the technical superuser
  when governance intent puts both with the medical superintendent · `auth.temp_role.grant` is unreachable by
  the duty manager, who is the role the night-shift bundling matrix was built for.
- *Group D — a missing shape:* there is **no read-only observer role**; every read permission is bundled with
  a write role. Internal audit (E-17) needs one, and it is the exact shape Digest Writer and Leakage Auditor
  need in 12a — building it now means the agent runtime inherits a proven pattern.
- *Group E — blocked on owner rulings:* `patients.confidential.read` (who may see a VIP/staff record — note
  the identifier lane's §1 ruling that this lives on `patients.is_confidential`, **not** in a UHID serial
  band) · the seven `partners.*` (Plan 09 O-8, CA/counsel register) · `approvals.requests.create`.

**The agent finding that Plan 12a must start from:** `guards.ts:99-101` throws
`"agents hold no permissions yet"` — every agent request is 403 on every guarded route. `auth.agents.manage`
is declared, granted to `admin`, and **guards zero routes**, which is precisely the shape `auth.users.manage`
had before 11e. And `role_assignments.user_id` has an FK to `users.id`, so an agent **cannot hold a role at
all**. The design owes: delegated authority (`user ∩ agent`, the Lane 3 rule) for interactive copilots versus
**standing** authority for scheduled automations that have no human to intersect against; whether autonomy
tier is a column or is expressed as `.draft`-style permission strings the guards already enforce (a tier no
route reads is documentation); and the two uniform guardrails from §16 that do not exist yet — **global halt**
and **agent heartbeat**.

**Suggested order for whoever picks this up:** Group C first — it is small, it is pure `ROLE_MODEL` plus
README rows, and one of its items means the ER cannot currently break glass. Then Group A. Then the composer
ceremony. The agent design doc can run in parallel with any of them since it touches no shipped code.
