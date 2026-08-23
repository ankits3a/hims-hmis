# Plan 11e — user administration over HTTP: credentials, access, and the end of permanent lockout

> **The phase document** — the only phase-specific artifact, per
> [`EXECUTE-METHOD-V3.md`](../EXECUTE-METHOD-V3.md) §1. **This is v3's first phase-document
> pilot: the method is under test alongside the plan** (v3 §7 records what refutes it).
> Written 2026-08-23 by the session that answered
> [`reports/PLAN-11E-WRITE-PROMPT-2026-08-23.md`](reports/PLAN-11E-WRITE-PROMPT-2026-08-23.md);
> every number in §2 and §3 was measured by that session on the build host, not carried forward.
>
> **The seed for the executing session is three lines: read this document,
> [`AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute.**

## THE LANE — ruled at write time, v3 §2

**Ruled LIGHT.** The auth kernel this phase touches is ~660 lines across six files; the surface
is two new controllers, one policy module, two screens and two seed repairs — six tasks, inside
§2's ≤8 guide and nothing like the 05/07/08 many-task module shape — and the risk here is
**depth, not breadth**: privilege-escalation depth is carried by rule-21 executed mutants and
the independent close reviewer, both of which are lane-independent, while HEAVY's apparatus
guards against breadth classes (brief transcription, subagent coordination) this phase does not
have. *(The write prompt's author leaned HEAVY, calling it "a module build"; recorded here as
the dissent this ruling overrules, with the reasoning v3 asks for.)*

**Stop-loss: 2.5M total tokens, all sessions counted.** Set at the floor of the v2 comparison
band (v3 §7's 2.49M low-water mark) so the tripwire fires exactly where §7's cost-refutation
condition begins — a LIGHT phase that spends into the v2 band has already refuted v3's cost
claim, and the owner should be deciding, not the session.

**Verification depth is not set by the lane** (v3 §2): this phase is permissions and
credentials end to end, so every CRITICAL task below carries executed mutants, rule 21
unchanged.

---

## 1. Why this phase

The hospital is operable — a patient was registered, queued, seen and closed out on the live
box on 2026-08-23 (gate report ADDENDUM 4) — but it cannot **onboard or repair a human
safely**. There is no credential-reset flow anywhere in the system: a receptionist who forgets
her password is locked out permanently, and the only repair is an agent with database access.
`seed:staff` REFUSES a changed password *by design* — a silent overwrite is the one way to lock
a real user out — so the refusal that protects users also strands them. `createUser` reaches
production only through two seed scripts; `deactivateUser` and `revokeUserSessions` shipped in
Plan 02 and have **zero non-test callers** (measured, §3 Q5).

The declared authority for fixing this is dead weight: `auth.users.manage` and
`auth.roles.manage` have been declared since Plan 02 and guard **no route anywhere in the tree**
(measured — their only non-test occurrences are the manifest and two seed-script comments).
The password floor is `seed:staff`'s alone; `loginSchema` accepts any non-empty string. And the
urgency is no longer synthetic: the pilot roster — 15 accounts plus `admin` — was **burned**
into a session transcript on 2026-08-23, and production now holds a **real patient record**
registered through the live system the same evening (§2). The box stopped being a rehearsal
tonight.

This phase also owns MAJOR 1's residual: `seed-admin.ts` returns early on any deployment that
already has an admin, so a permission declared after first boot is never granted there.
Addendum 5's fix makes `seed:roles` *detect and name* that state; **the repair is this
phase's** (§4 D4), and it must not become a second early-return of its own. Plan 09
(memberships/coupons) is ruled to run AFTER 11e; the `workflow.*` sequencing, `UHID_PREFIX=CRK`
and the four not-yet-modelled `workflow.instances.*` strings are already ruled — do not
re-litigate (write prompt §5).

## 2. Ground truth — measured 2026-08-23 by the authoring session

- **SHA `2c42a88`**, clean tree, on the build host (the working session runs ON the host —
  v3 §8's topology ruling, now in effect).
- **Baseline, detached, exit VALUES from files:** `pnpm verify` exit **0** — `apps/core`
  **148 suites / 1110 tests**, `packages/contracts` **3 / 7**, `apps/web` **34 / 175**
  (vitest — its summary lines say `Test Files`, not jest's `Test Suites`, which has already
  eaten one grep). One pre-existing eslint warning (`scheduler.test.ts:573`, unused disable
  directive) — not this phase's, leave it.
- **Production** (`hmis-prod-db-1`, read-only SELECTs): 16 users (all active, 14 with a PIN) ·
  20 role assignments · **14 roles** · 59 declared permissions, 46 held, 13 not-yet-modelled ·
  `opd_visit` v1 ACTIVE · **2 patients** · 1 doctor · 12 placeholder departments · 0 rooms ·
  0 doctor schedules · **26 live sessions** · **0 TOTP enrollments**.
- **Two corrections to the write prompt's §1 baseline, both explained:** it said 12 roles —
  `nurse` and `medical_superintendent` were created at 19:51 by `seed:opd` step 1 (gate report
  ADDENDUM 3), before the prompt was written; its number was already stale. `nurse` holds
  **0 permissions and 0 holders** (it is in `OPD_ROLE_KEYS` but not in `ROLE_MODEL`, so the
  READY verdict does not cover it). And it said 1 patient — the second, `CRK-00000002-9`
  ("Ankit Kumar", registered 20:27 through the live system), appears to be the owner's own
  real registration. §2.78 again: the document warning about staleness was stale.

## 3. Spike — five questions, answered by measurement (v3 §1.2)

**Q1 — Can force-password-change reuse the existing session machinery?** **YES, with one
column and one join.** `findLiveSession` (`sessions.ts:35`) is the single session-resolution
choke point — exactly two non-test callers, measured: `guards.ts:43` (the global `APP_GUARD`
`AuthGuard`, `auth.module.ts:14`, so **every** authenticated HTTP route passes through it) and
`realtime/gateway.ts:165` (the WebSocket auth). No new token state is needed: the flag lives
on `users` as `must_change_password`, surfaced by joining `users` into `findLiveSession`'s
existing single SELECT — zero additional queries per request. When set, `AuthGuard` refuses
with 403 `password_change_required` on every route except `POST /auth/change-password` and
`POST /auth/logout`; the session itself stays valid (`SESSION_TTL_MINUTES` default 720,
`config.ts:40`), so completing the change needs no re-login. Design in D1.

**Q2 — What should `seed-admin.ts`'s early return become?** **A user-creation-only skip.**
Measured shape: `seed-admin.ts:17-22` returns before the grant loop (`:31-33`);
`syncPermissions` (`:14`) runs before the return, which is why a late-declared permission
appears in `permissions` yet is never granted. `grantPermissionToRole` is idempotent
(`onConflictDoNothing`, `permissions.ts:40`); `createRole` is not (plain insert, select-guarded
in the script). The repair: role-ensure, grant-reconcile and assignment-ensure run on **every**
invocation — the `seed-ops` unconditional-regrant pattern the 11d discovery review named "safe
by contrast" — and only `createUser` stays conditional on the username existing. Re-granting on
every deploy is not a risk but the contract: `admin`'s grant set is *defined* as
`registry.allPermissions()` of the manifests the script installs; a deliberate revoke of an
admin permission is a model change, not a database state this script preserves. Not a second
early return: every code path executes on every run. Design in D4.

**Q3 — PIN reset vs password reset: one flow or two?** **Two endpoints over one shared core.**
`setPin` exists (`identity.ts:47`; one non-test caller, `seed-staff.ts:367`); **no
`setPassword` exists anywhere in the tree** (measured — `createUser` is the only place a
password hash is ever written). The credentials mean different things: a password opens a
session anywhere; a PIN is the shared-terminal fast-switch credential (14 of 16 live users hold
one, confirmed). Their reset consequences differ accordingly — a password reset must revoke the
target's live sessions and set `must_change_password`; a PIN reset must do neither (a PIN
change implies no password compromise, and `switchWithPin` already revokes the terminal's
sessions on every switch, `sessions.ts:100`). So: one new `setPassword` mirroring `setPin`, one
policy module validating both (D3), two endpoints (D2).

**Q4 — Does `assignRole`/revoke need the SoD engine in the loop?** **NO.**
`assertNotSodPair` (`sod.ts:37`) is an ACT-time comparator: it refuses only when the *same
actor* sits on both sides of *one act*, and it has exactly two non-test callers —
`approvals/decisions.ts:55` (requester vs approver) and `workflow/definitions.ts:208` (drafter
vs activator) — both measured. The nine seeded pairs are act pairs, not role pairs: one person
MAY hold both roles in a small hospital, and the engine blocks them acting as both sides of a
single item, which is why the 11d reviewer recorded "SoD is enforced at ACT time, never at
assignment time, so there is nothing for a roster to bypass." The same holds for this
controller: role assignment ships **no SoD call**. (An informational assign-time warning is
conceivable future UX; it is not 11e scope and would need its own role-pair vocabulary.)

**Q5 — What does deactivate mean for an in-flight session?** **Today: almost nothing, and that
is the finding.** Measured along the whole request path: `findLiveSession` checks token hash,
revocation and expiry only — it never reads `users`; `hasPermission` (`permissions.ts:63`)
reads `role_assignments`, `temp_role_grants` and `role_permissions` — never `users`. Only the
three session-*creation* paths (`verifyPassword`, `verifyPin`, `resolveBadge`) check
`user.active`. So a deactivated user holding a valid token keeps full authority for up to 12
hours, on HTTP and on the WebSocket alike. `deactivateUser` (`identity.ts:86`) and
`revokeUserSessions` (`sessions.ts:61`) both exist with zero non-test callers. The fix is
**both belts**: the deactivate endpoint revokes the target's sessions in the same operation,
AND `findLiveSession`'s new join (Q1) refuses an inactive user's session at the choke point —
the second closes the window for any future path that forgets the first, and covers the
gateway for free. Design in D1/D2.

## 4. Design decisions

### D1 — One choke point learns two facts: `active` and `must_change_password`

`findLiveSession` gains a join on `users` and its `LiveSession` return gains
`mustChangePassword`. **An inactive user's session resolves to `null` right there** — callers
cannot forget a check that never reaches them; both HTTP (401) and the WebSocket (4001) inherit
it with no further code. `mustChangePassword` is returned as data: `AuthGuard` refuses guarded
work with 403 `password_change_required` except the two exempt routes (Q1); the gateway refuses
auth outright when it is set — a person mid-credential-reset has no business streaming
hospital data, and the change-password flow needs no socket. The flag is set by admin password
reset and admin user creation (default **true** — every provisioned human proves control of
their own credential on first login), cleared only by `POST /auth/change-password`.

### D2 — The admin surface: two controllers, no role CRUD, one lockout invariant

`users-admin.controller.ts` (guarded by `auth.users.manage`, hospital scope) and
`roles-admin.controller.ts` (guarded by `auth.roles.manage`, hospital scope) — split so each
dead permission string finally guards exactly the surface its name claims:

| route | guard | behaviour |
|---|---|---|
| `POST /admin/users` | `auth.users.manage` | create via `createUser`; policy-checked password, optional policy-checked PIN; `must_change_password` true |
| `GET /admin/users` | `auth.users.manage` | list: username, full name, active, has-PIN, must-change, roles with scopes |
| `POST /admin/users/:id/deactivate` | `auth.users.manage` | `deactivateUser` + `revokeUserSessions`, one flow; lockout invariant below |
| `POST /admin/users/:id/reactivate` | `auth.users.manage` | reverses a mistaken deactivation; sessions stay revoked — the user logs in fresh |
| `POST /admin/users/:id/password-reset` | `auth.users.manage` | `setPassword` (policy-checked) + set must-change + `revokeUserSessions` |
| `POST /admin/users/:id/pin-reset` | `auth.users.manage` | `setPin` (policy-checked); no must-change, no session revocation (Q3) |
| `POST /admin/users/:id/roles` | `auth.roles.manage` | `assignRole` (existing scope rules apply; no SoD call — Q4) |
| `DELETE /admin/users/:id/roles/:assignmentId` | `auth.roles.manage` | new `revokeRoleAssignment`; effective immediately — `hasPermission` reads live rows, so no session work is needed; lockout invariant below |
| `POST /auth/change-password` | authenticated, no permission | self-service: current password required, new one policy-checked, clears must-change, revokes the user's OTHER sessions |

**No role create/edit/delete over HTTP, deliberately.** The role vocabulary is code-owned
(`ROLE_MODEL` + the seeds): an HTTP-minted role is invisible to the model — the exact shape
production's permissionless `owner` role had for all of 11d. Addendum 5's measured census would
now at least *see* such a role; it still must not be possible to *make* one here.

**The lockout invariant, stated once and enforced twice:** no mutation may leave **zero active
users holding `auth.users.manage`**. Checked inside `deactivate` and inside
`revokeRoleAssignment` (the two routes that can reduce the holder count), refusal 409
`admin_lockout`. This is the receptionist-lockout problem one level up: an admin surface that
can deactivate its own last key repairs nobody.

**Every mutation emits an audit event** (`defineEvent`, module `auth`): `user.created`,
`user.deactivated`, `user.reactivated`, `user.credential_reset` (payload names `kind:
"password" | "pin"` and the acting admin — never any credential material),
`user.password_changed`, `role.assigned`, `role.revoked`. New event *types* over the append
stream are the safe direction (§2.86 poisoned history by tightening an existing type; adding
types poisons nothing — new consumers replaying from cursor 0 see a valid stream).

**No second factor on these routes in 11e, deliberately:** production has **0 TOTP
enrollments** (§2), so `secondFactor: true` would brick the surface on day one. Enrollment
exists (`/auth/totp/enroll`); requiring it here is a one-line hardening for a later phase,
after the owner enrolls.

### D3 — The password policy — OWNER RULED 2026-08-23 (taken by the authoring session)

**Minimum 10 characters; no composition rules, no expiry** (length beats composition rules
people work around); **reject the username** (case-insensitive) **and a fixed top-20
common-password list**; **PIN: 4–6 digits exactly.** Enforced in one module,
`password-policy.ts`, at **every path that sets a credential**: admin create, admin
password-reset, admin PIN-reset, self-service change-password, and `seed:staff`'s roster
validation (whose 8-character floor and its "seed-time floor, not an auth policy" apology are
replaced by the shared policy — the burned roster is being reissued anyway, so no live roster
is invalidated). **`loginSchema` stays `min(1)`, deliberately:** login verifies what exists; a
floor at login locks out precisely the users the reset flow exists to save. Existing accounts
meet the floor at their next credential change — which for every live account is the D5
rotation.

### D4 — `seed-admin.ts` reconciles; only user creation is conditional

Per Q2. The script's shape becomes: `syncPermissions` → ensure `admin` role → **reconcile
grants** (`registry.allPermissions()`, idempotent) → create the user only if absent → ensure
the role assignment. The early return is deleted; its only surviving descendant is the
`createUser` guard. The census (`seed:roles`, addendum 5) remains the detector; this makes
re-running `seed:admin` the documented repair it always claimed to be.

### D5 — Rotation of the burned roster: the first real use of the surface

After deploy, **performed by the owner through the admin screen — not by an agent, and not
over any transcript**: password-reset all 15 roster accounts, PIN-reset the 14 PIN-holders,
then change `admin`'s own password via self-service change-password. Every password reset
revokes the target's live sessions (the 26 outstanding tokens die with the rotation), and
every reset account proves control at first login via the must-change flow. The whole point of
building this over HTTP is that no credential need ever transit a session transcript again;
the rotation must honour that from its first run. Steps and evidence land in CLOSE, deploy and
rotation each **owner-authorised in as many words** (standing constraint, unchanged).

### D6 — The screens

`admin-users.tsx` (list + create + per-user actions; keyboard-first per the §15 design law —
this is the owner's most-typed new surface) and `change-password.tsx` (the forced-change
landing: `login.tsx` routes a 403 `password_change_required` there instead of into the shell).
Client calls in a new `lib/admin-api.ts`, following the per-module client pattern
(`ops-api.ts` et al.). Routes registered in `router.tsx`.

## 5. Tasks

Sequential, main session, LIGHT lane (v3 §3): narrow suites while iterating, detached runs
with exit files, `ci-watch.sh` in the background for the duration, CI-green-by-FULL-SHA
(§2.84) before close. CRITICAL tasks carry their assertion rows inline — **assertion · mutant
· discriminating input** — and rule 21 governs: build every mutant, quote expected vs
received.

---

### T1 — CRITICAL — the choke point: `active`, `must_change_password`, `setPassword`

**Files:** `apps/core/src/kernel/db/schema/auth.ts` · `apps/core/drizzle/0018_*` (generated —
AGENT-RULES §6: generate only when ready to carry it to the commit) ·
`apps/core/src/kernel/auth/sessions.ts` · `apps/core/src/kernel/auth/identity.ts`
(`setPassword`, `reactivateUser`) · `apps/core/src/kernel/auth/guards.ts` ·
`apps/core/src/kernel/realtime/gateway.ts` · `apps/core/src/kernel/auth/sessions.test.ts` ·
`apps/core/src/kernel/auth/identity.test.ts` · `apps/core/test/credential-lifecycle.e2e.test.ts`
(new).

**Acceptance:** D1 delivered; the e2e file proves the full lifecycle over HTTP: login →
deactivate → the *same token* refused; must-change set → guarded route 403
`password_change_required` → change-password (T2 route may not exist yet: the flag-clearing
unit is exercised directly here, the route lands in T2) → guarded route 200. Gateway refusal
covered at unit level against `findLiveSession`'s contract.

**Book rows:**
- **R1** · a deactivated user's still-valid token is refused on its next request · mutant:
  pre-change `findLiveSession` (no `users` join) restored as scratch · discriminating input:
  login, deactivate the user by direct call, replay the token — shipped 401, mutant 200. *(The
  mutant is today's shipped code, so its premise cannot "already be satisfied" — §2.81's tell
  checked at authoring: the discriminator is the replay, which today measurably succeeds.)*
- **R2** · must-change refuses guarded work AND admits the exempt route · two-sided: mutant A
  (guard lacks the refusal) dies on the 403 leg; mutant B (guard lacks the exemption, refusing
  everything) dies on the change-password-admitted leg. A one-legged version of this row is
  vacuous — either mutant alone survives half of it.
- **R3** · deactivation composed with revocation leaves zero live sessions for the target ·
  no mutant — asserted by count from `auth_sessions` (evidence discipline §2.6/§2.7), because
  the enforcing seam is T3's endpoint; the row re-runs there.

**Commit:** `feat(core): sessions learn active and must-change at the choke point — deactivation and forced reset become enforceable`

---

### T2 — CRITICAL — one password policy for every credential-setting path

**Files:** `apps/core/src/kernel/auth/password-policy.ts` (new) ·
`apps/core/src/kernel/auth/password-policy.test.ts` (new) ·
`apps/core/src/kernel/auth/auth.controller.ts` (`POST /auth/change-password`) ·
`apps/core/scripts/seed-staff.ts` (policy replaces the 8-floor).

**Acceptance:** D3 delivered verbatim; change-password requires the current password, applies
the policy, clears must-change, revokes the caller's other sessions; `seed:staff` refuses a
policy-violating roster whole-and-before-first-write exactly as it refuses today (its existing
refusal tests keep passing with the new floor).

**Book rows:**
- **R4** · a 9-character password is refused and a 10-character one accepted at EVERY set
  path (policy unit + change-password + seed-staff roster) · mutant: floor at 8 · dies on
  each path's 9-character refusal leg. The per-path coverage is the row's point — a policy
  module nobody calls is the current defect restated.
- **R5** · change-password with a wrong current password is refused AND clears nothing AND
  revokes nothing · mutant: handler that validates the new password but skips the
  current-password check · discriminating input: wrong current + valid new — mutant 204,
  shipped 403, and the flag/state assertions pin that nothing moved.
- **R6** · the username (case-insensitive) and a top-20 entry are refused even at length ≥10 ·
  no mutant needed if R4's dies — but the inputs are distinct legs of the policy unit test,
  named so the close reviewer sees the ruling's full surface executed.

**Commit:** `feat(core): the password policy — one floor for every path that sets a credential (owner ruling 2026-08-23)`

---

### T3 — CRITICAL — `users-admin.controller.ts`: `auth.users.manage` finally guards routes

**Files:** `apps/core/src/kernel/auth/users-admin.controller.ts` (new) ·
`apps/core/src/kernel/auth/events.ts` (the seven D2 events) ·
`apps/core/src/kernel/auth/auth.module.ts` (register controllers — also T4's, so this file is
touched once, here) · `apps/core/test/user-admin.e2e.test.ts` (new; T4 extends it — the one
deliberate two-owner file, sequential same-session lane, noted for the per-commit stat audit).

**Acceptance:** D2's six `auth.users.manage` routes; every mutation emits its event; the
lockout invariant on deactivate; **§3.42's four legs from day one** for BOTH admin
controllers' bindings (the legs land here, T4's routes join them when they exist): the
role-less 403 sweep asserting each route refuses **by the permission it names**, the
no-token-401 sweep, the declared-set-equality leg against `authManifest`, and the
decorator-repoint mutant — the leg-10 redundant-actor sweep is **deliberately not shipped**
(11d proved leg 10 ⊆ legs 8 ∧ 9; a vanity leg is §2.81's cannot-fail shape). Pattern:
`test/ops-lifecycle.e2e.test.ts` legs 8/8b/9/11.

**Book rows:**
- **R7** · every `/admin/users*` route refuses a role-less authenticated user 403 naming its
  own permission, and refuses no-token 401 · mutant: one route's decorator deleted ·
  dies on the sweep's this-route-was-guarded leg.
- **R8** · the decorator-repoint mutant: one route's `auth.users.manage` →
  `auth.roles.manage` · dies on the names-the-RIGHT-permission leg (403 message asserts the
  string) — §3.42's exact defect, executed.
- **R9** · password-reset revokes: after reset, the target's prior token replays to 401 and
  must-change is set (T1 R3 re-run at the enforcing seam) · mutant: handler calling
  `setPassword` but not `revokeUserSessions` · discriminating input: the replay — mutant 200.
- **R10** · the lockout invariant · mutant: invariant check removed · discriminating input:
  deactivate the sole active `auth.users.manage` holder — shipped 409 `admin_lockout`, mutant
  200; control: deactivating a non-last holder succeeds in both (so the row cannot pass by
  refusing everything).

**Commit:** `feat(core): user administration over HTTP — auth.users.manage finally guards routes`

---

### T4 — CRITICAL — `roles-admin.controller.ts`: assign/revoke, `auth.roles.manage` guards

**Files:** `apps/core/src/kernel/auth/roles-admin.controller.ts` (new) ·
`apps/core/src/kernel/auth/permissions.ts` (`revokeRoleAssignment`) ·
`apps/core/test/user-admin.e2e.test.ts` (extends T3's legs with these bindings).

**Acceptance:** D2's two role routes; scope rules unchanged from `assignRole`; no SoD call
(Q4, recorded in the controller header with the two-caller measurement); lockout invariant on
revoke; the four legs now cover both controllers' full binding set.

**Book rows:**
- **R11** · a revoked assignment is effective on the target's NEXT request with no session
  work · mutant: `revokeRoleAssignment` deletes nothing (returns success) · discriminating
  input: user with one role 200s a guarded route, revoke, same token replays — shipped 403,
  mutant 200. *(Also the executable proof of Q5's "hasPermission reads live rows".)*
- **R12** · T3's R7/R8 legs, extended: the repoint mutant on a role route
  (`auth.roles.manage` → `auth.users.manage`) dies on the right-permission leg.

**Commit:** `feat(core): role assign and revoke over HTTP — auth.roles.manage finally guards routes`

---

### T5 — CRITICAL — `seed-admin.ts` reconciles: MAJOR 1's residual repaired

**Files:** `apps/core/scripts/seed-admin.ts` · `apps/core/test/seed-admin.test.ts` (new).

**Acceptance:** D4's shape; idempotent (second run: zero new rows, stated by the script);
the addendum-5 census on a repaired database reports the reconciled permission as held.

**Book rows:**
- **R13** · a permission declared AFTER first boot is granted by re-run · mutant: the
  verbatim early return restored (it is today's shipped code — same §2.81 note as R1) ·
  discriminating input: run once, install a manifest carrying one extra permission, run again
  — shipped grants it (`role_permissions` row exists), mutant does not. This is the
  discriminating input MAJOR 1's fix could only *name*; here it is executed.
- **R14** · reconciliation grants; it never un-grants or duplicates · second run over a
  hand-granted extra row: row count unchanged, extra grant intact (evidence by count,
  §2.7).

**Commit:** `fix(core): seed-admin reconciles grants instead of returning early — MAJOR 1's residual`

---

### T6 — ROUTINE — the screens: admin users, and the forced-change flow

**Files:** `apps/web/src/screens/admin-users.tsx` + `.test.tsx` (new) ·
`apps/web/src/screens/change-password.tsx` + `.test.tsx` (new) ·
`apps/web/src/lib/admin-api.ts` (new) · `apps/web/src/router.tsx` ·
`apps/web/src/screens/login.tsx` + `.test.tsx` (the `password_change_required` routing).

**Acceptance:** D6; tests required and passing (no mutants — ROUTINE, and fail-first is not
owed: say so in the report); the web workspace total does not decrease.

**Commit:** `feat(web): the user-administration screen and the forced password-change flow`

---

## 6. CLOSE — appended as the phase runs (v3 §1.5)

*Empty at authoring, by design. This section is the findings inbox and the gate report.*

- **Findings** as they arrive, each MEASURED or PREDICTION, per the 11d inbox's format.
- **Independent review** (v3 §3.4): one fresh-context reviewer agent, restricted tools, reads
  every commit of the phase together; findings land here; CRITICAL findings block close.
- **Mechanical close** (v3 §3.5): detached `pnpm verify` exit VALUE from a file · per-commit
  `git show --stat` against each task's Files list (T3/T4's shared e2e file is expected twice)
  · frozen-path audit · clean tree · CI green by FULL SHA for every commit.
- **Ledger archive-rule pass** (v3 §5) at close, and any new lessons.
- **Deploy, then D5's rotation** — each only when the owner authorises it by name. The safety
  classifier is expected to block production operations even when authorised; report and ask,
  never work around (standing constraint, vindicated five times in 11d).
- **The actuals row** (tokens all-sessions, agents, wall clock, catches) against the
  stop-loss, and the v3 pilot measurements §7 names: total tokens vs 2.64M/2.49M/3.34M ·
  reviewer/production defects · transcription-class incidents (target zero).
