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

---

## THE CLOSE — appended 2026-08-24 by the executing session

**Status: CLOSED — code and deploy. The rotation (D5) remains the owner's, by design.** Every task shipped, the reviewer's two CRITICALs
are fixed and pinned, `pnpm verify` is exit 0, and CI is green by full SHA on the final commit.
What is NOT done, and cannot be by this session: the production deploy and D5's rotation, both
owner-authorised by name — and **the deployed edge still routes none of this** (F1 below).

### The seven commits

| task | SHA | CI |
|---|---|---|
| T1 the choke point learns `active` and `must_change_password` | `0b6a06c` | green |
| T2 the password policy, one floor for every path | `3eec860` | **RED** (F2) |
| T3 user administration over HTTP | `61ef959` | green |
| T4 role assign and revoke over HTTP | `c760586` | **RED** (F2) |
| T5 `seed-admin` reconciles — MAJOR 1's residual | `05f6d75` | green |
| T6 the screen and the forced-change flow | `14b66aa` | green |
| CLOSE remediation — the reviewer's C1/C2 and five MAJORs | `00c3747` | green |
| CLOSE — this gate report and ledger 2.87–2.91 | `932b803` | green |

*Every row in the CI column was read from `/commits/{FULL-SHA}/check-runs` after the run reached
`completed` (§2.84: by FULL SHA, never a short one). The `00c3747` cell was first written while
its run was still `in_progress` and corrected here once the conclusion existed — recorded because
a verdict written ahead of its evidence is the thing rule 12 forbids, and it does not stop being
that by turning out true.*

### Findings

**F1 — `/admin*`, `/ops*` and `/tariff*` were proxied by nothing. MEASURED.** Found by the
independent reviewer as C1. `apps/web/vite.config.ts` and `docker/prod/Caddyfile` route nine
prefixes between them; the SPA calls eight, and three were in neither list. In production those
calls fall through to the SPA handler and return `index.html` with HTTP 200. `/admin` is this
phase's; **`/ops` is Plan 11c's operating-mode and downtime-kit surface and has been dark since
11c shipped** — one letter from the proxied `/opd`, which is why three reviews missed it — and
`/tariff` feeds the billing counter's service picker. Fixed in `00c3747` and pinned by a third
source (the prefixes `apps/web/src` actually requests), which is independent of both lists.
**The DEPLOYED `/opt/hmis-prod/caddy/Caddyfile` is unchanged** — rule 3 forbids this task writing
there — so all three stay dark in production until the owner authorises a deploy.

**F2 — two intermediate commits went red on `origin/main`. MEASURED; cause PREDICTION.**
`3eec860` and `c760586` failed CI while every build-host run was green. Both genuinely executed
(638 s and 365 s inside `pnpm verify`, against a 413–521 s green band), so this is not §2.59's
did-not-run. Job logs need an authenticated `gh` and returned 403, so the failing test is **not
identified**. What is established: `05f6d75` contains all of `c760586`'s code and is green, and
`c760586` → `05f6d75` differ only in `seed-admin.ts`, which nothing else imports — so T4's red
**cannot be deterministic in T4's code**. The same shape holds for T2. Leading candidate,
unconfirmed: `test/auth.e2e.test.ts:77` asserts `expect(elapsed).toBeLessThan(1000)` on a
**single sample** of one PIN switch (an argon2id verify at memoryCost 19456). It is the only
single-sample wall-clock assertion in the suite — the two perf tests use best-of-N — and this
phase added roughly a hundred argon2 operations to the same CI run on a 4-core shared runner.
**Open item for the owner:** `gh run view 32668118868 --log-failed` settles it in one line.

**F3 — the build host CAN read CI, and the method says it cannot. MEASURED.** v3 §8 rules that
`ci-watch.sh` stays on the owner's Windows machine because `gh` cannot authenticate here. `gh`
indeed cannot — but **the repository is public**, so the unauthenticated GitHub API answers
`/commits/{sha}/check-runs` and `/actions/runs/{id}/jobs` from this host. That is how F2 was
found at all. Job *logs* remain 403. A ~15-line poller using only `curl` would give a build-host
session green/red per SHA with no credential.

**F4 — `pnpm verify` was not run at T2 or T4, and both are the commits that went red. MEASURED.**
At T2 the evidence was typecheck, lint and a 14-suite blast radius; at T4, typecheck, lint and the
full core suite — but never `packages/contracts` or `apps/web`, and never the whole of `pnpm
verify`. §2.8's "run the full workspace suite ONCE, at the end" is about a phase; on a CRITICAL
task whose commit is pushed immediately, "the end" is every commit, because each push is what CI
judges. See L1.

**F5 — the plan's Files lists were short in five places. MEASURED, all disclosed at commit time.**
`sessions.ts` and `test/seed-staff.test.ts` (T2), `auth.controller.ts` (T3), `auth.module.ts`
(T4), `locales/en.json` + `hi.json` (T6). Four were forced by the plan's own design decisions;
`auth.module.ts` is a genuine plan defect — it put both controller registrations in T3 so the file
would be touched once, but a controller cannot be registered in the commit before it exists. The
CLOSE remediation touched four more (`seed-ops.ts`, `seed-roles.ts`, `seed-roles.test.ts`,
`vite.config.ts`, `Caddyfile`, `auth.tsx`, `caddyfile-parity.test.ts`), all consequences of
reviewer findings.

**F6 — the T6 locale files were reflowed by a pretty-printer. MEASURED.** A 48-key addition
landed as a 1017-line diff per file, hiding what changed. No semantic change (48 added, 0 removed,
0 changed, en/hi key sets identical, verified by flattening both revisions). Restored to the
house one-line-per-section style in `00c3747`.

**F7 — the password policy's common-password list buys exactly one entry. MEASURED, disclosed at
authoring.** Nineteen of the twenty entries are shorter than the ten-character floor, so only
`1234567890` is refused by the list rather than by length. Stated in the module header and pinned
by its test, so neither can drift. Not a defect; recorded so nobody reads the list as more
protection than it is.

**F8 — `seed:admin` applies no password policy. MEASURED, stated seam. — CLOSED 2026-08-24 by Plan
11f D1/T1 (`22a5e3b`).** D3 enumerates the five paths the policy guards and the bootstrap path is
not among them, so `ADMIN_PASSWORD` can still be four characters. Left open deliberately rather
than closed on an executing session's authority; written into the script's header. ~~**Owner ruling
wanted.**~~ **The ruling came, and it made `ADMIN_PASSWORD` the SIXTH guarded path** — validated at
the create path only, so a reconcile-only re-run still performs the repair D4 built it to be. This
line was the fourth surviving claim of the retired behaviour, found by 11f's independent reviewer
after 11f's own close sweep had retired the other three; it is evidence for ledger §3.54.

### Independent review (v3 §3.4)

One fresh-context `general-purpose` reviewer, instructed read-only, read all six commits together.
**Verdict: BLOCK**, on 2 CRITICAL, 7 MAJOR, 14 MINOR. It went past its brief exactly as the
ledger's §5 asks — C1's twin doors (`/ops`, `/tariff`) are worth more than C1 itself.

*Tool restriction was by instruction, not by tool set* — v3 §3.4 says "restricted tool set"; a
`general-purpose` agent forbidden from Edit/Write/commit was chosen over the structurally
read-only `Explore` because review quality was the binding concern. It wrote nothing. Recorded as
a deviation.

**Fixed in `00c3747`:** C1 (F1 above) · C2 (the lockout invariant counted holders at ANY scope
while every route demands hospital scope — two authorised requests produced a permanent lockout;
mutant DIED both ways against the pre-fix code extracted verbatim from `14b66aa`) · M1 (the same
check was a TOCTOU under READ COMMITTED — advisory lock added) · M2 (R4's two missing call sites)
· M4 (`seed:roles` emitted guidance T5 had falsified) · M5 (`AuthProvider` cleared the token on
the forced-change 403, breaking a reload of `/change-password`).

**Accepted, NOT fixed — carried forward with reasons:**

- **M3 — `ADMIN_ROUTES` is its own source of truth**, so a route added to a controller and not to
  the table is invisible to all four §3.42 legs. Real, and the reviewer is right that the billing
  precedent is stronger. The fix (enumerate Nest's router via `DiscoveryService`) is a testing-
  apparatus change of its own size and belongs to a phase that can verify it, not to a close.
- **M6 — RULED AND CLOSED 2026-08-24** (owner delegated the ruling to the executing session).
  A credential reset is a TAKEOVER — the actor picks the password, so they can sign in as the
  target — which made `auth.users.manage` a complete escalation to `auth.roles.manage`, firing at
  exactly the moment this phase exists to enable: delegating password resets to a supervisor made
  that supervisor a silent superuser. **The rule: an actor may reset a credential only if the
  `auth.*` permissions they hold are a SUPERSET of the target's.** Drawn at `auth.*` rather than
  at every permission, because the naive form is unworkable — a supervisor holding only
  `auth.users.manage` could not reset a CASHIER, since the cashier holds `billing.*`, and that
  kills the feature. The protected set is read from `authManifest.permissions`, so a seventh
  `auth.*` is covered the day it is declared. **The stated cost:** a deployment with ONE full
  administrator has nobody who may reset them; the mitigation is named in the refusal itself —
  keep two. Mutant DIED (ungated handler PERMITS the takeover; shipped REFUSES; owner→supervisor
  still PERMITTED, so the rule is not refusing everything).
- **M7 — the gateway's must-change refusal has no executing test.** The plan's T1 acceptance
  sanctioned unit-level coverage of `findLiveSession`'s contract, which is what shipped; the
  gateway's own branch is unasserted. Plan-level, not execution-level.
- **MINOR: `create`'s uniqueness pre-check sits outside its transaction** (concurrent duplicate
  creates give 500, not 409); **policy-vs-existence ordering differs** between `pinReset` and
  `passwordReset`; **`admin-users.tsx` does not use `SubmitButton`'s in-flight latch** (§3.45's
  convention has stopped travelling — a class, not a screen).

### Mechanical close (v3 §3.5)

- **`pnpm verify` at `00c3747`: exit 0**, read from `.verify.exit`, detached. `apps/core`
  **152 suites / 1160 tests** · `packages/contracts` **3 / 7** · `apps/web` **36 files / 189
  tests**. Baseline at `587a446` was 148/1110 · 3/7 · 34/175. One pre-existing eslint warning
  (`scheduler.test.ts:573`), untouched.
- **No test deleted, no assertion weakened.** Across the whole range the only removed
  `*.test.ts(x)` lines are five: a widened import, the `LiveSession` `toEqual` widened to include
  `mustChangePassword`, and the PIN sentinel plus its comment.
- **Per-commit `git show --stat` against Files lists**: every file accounted for; the five
  extensions are F5.
- **Frozen-path audit**: the union of touched files equals the Files lists plus disclosed
  extensions, and every named file was touched. Empty in both directions.
- **Clean tree**, no `*.mutant.*` residue, all scratch deleted. Scratch databases
  `hmis_11e_fresh_1..7` created under rule 7's own-name exception and dropped at close.
- **CI green by full SHA**: `00c3747` green; F2 records the two intermediate reds.

### Ledger archive-rule pass (v3 §5)

Nothing archived. Every entry consulted this phase still attaches to a live mechanism, and the two
that looked archivable are not: §2.40's class is structurally impossible under v3 §8's topology
but its entry is already struck in place in AGENT-RULES rather than the ledger, and §2.59's
did-not-run distinction was *used* this phase (F2) to avoid misreading two real failures.

### Lessons bound for the ledger

- **L1 — a task that PUSHES is a task that must run what CI runs.** §2.8's "full suite once, at
  the end" is a phase-level economy that silently became a per-commit gap: T2 and T4 pushed on a
  blast radius and a core-only run, and both went red (F4). The rule needs the clause: *before the
  finish block's push, run the same command CI runs.* Cost: two red commits on `origin/main` and
  an unresolved cause.
- **L2 — a parity pin between two hand-maintained lists cannot see what is in neither.**
  `caddyfile-parity.test.ts` was written precisely to stop a prefix going dark in production, and
  three prefixes went dark under it — one of them an emergency surface, for a whole plan cycle.
  A pin over N copies of a fact needs an N+1th source that is derived from *use*. (§3.42's closing
  move, generalised: the leg must read something that is not the thing under test.)
- **L3 — when a guard and a counter answer the same question, they must be the same code.** C2:
  `hasPermission` refuses a department-scoped holding at hospital scope; the lockout counter
  accepted it. Both were correct in isolation and the pair was exploitable. Where an invariant
  counts who may do something, derive it from the function that decides whether they may.
- **L4 — deleting a defect means retiring its documentation in the same commit.** T5 removed
  `seed-admin`'s early return and left eight places asserting it still exists, one of them
  *emitted to an operator at the moment they need the repair* (M4). §2.78's class, in the emitting
  direction rather than the reading one.
- **L5 — v3 §8's topology ruling was measured on `gh` alone.** The build host cannot authenticate
  `gh`, but it can read a public repo's CI over plain `curl` (F3). "The host cannot see CI" was
  true of the tool and false of the question.

### Actuals (v3 §6) and the v3 pilot measurements (§7)

| | |
|---|---|
| tasks | 6, all shipped, plus one CLOSE remediation commit |
| commits | 7 |
| agents | **1** (the independent reviewer, 241,019 tokens, 69 tool uses, 12m 55s) |
| wall clock | ~13h elapsed across two sessions (2026-08-23 21:14 UTC → 2026-08-24 10:30 UTC), including a session resume |
| mutants built | **13**, all DIED, each with a shipped control through the same harness |
| reviewer defects | 2 CRITICAL, 7 MAJOR, 14 MINOR — 6 fixed at close, 3 accepted and carried |
| defects reaching production | **0 from this phase's code.** F1 is a pre-existing production defect this phase's reviewer found (`/ops` dark since 11c) |
| transcription-class incidents | **0** — the target §7 names, and the one-document structure is why |
| stop-loss (2.5M tokens) | **NOT MEASURABLE from inside the session.** See below. |

**On the stop-loss, honestly.** §7's headline measurement is total tokens against 2.64M / 2.49M /
3.34M, and the executing session cannot read its own billed total — the only number it can quote
is the reviewer subagent's 241,019. Reporting an invented figure would be worse than reporting
none. **The owner can read the real number** (`/cost`, or the Anthropic console for
2026-08-23/24) and should record it here; until then §7's cost comparison for the v3 pilot is
UNDISCHARGED, and no conclusion about v3's cost claim should be drawn in either direction.

What the pilot *can* report: one agent instead of a compiled pipeline, zero transcription
incidents, and an independent reviewer that returned two CRITICALs — of which one was a live
production defect predating the phase. §7's reversal conditions are not met: no defect of a class
v2's per-task apparatus has a named prior catch for reached production. The LIGHT lane held.

### THE DEPLOY — DONE 2026-08-24, owner-authorised and owner-executed

The owner authorised the deploy and ran `docker/prod/deploy.sh` themselves: **the safety
classifier denied it to this session**, exactly as the standing constraint predicts, and the
session reported and asked rather than working around it (no splitting the script, no calling
`docker compose` directly). Sixth vindication of that constraint.

**Window, MEASURED before the deploy:** 0 live sessions · `operating_mode_changes` empty, so the
hospital had never left `commissioning` · 2 patients, 3 encounters · 122 G free. Nobody was
interrupted.

**Verified after, all MEASURED:**

| check | result |
|---|---|
| deployed `@api` matcher | 12 prefixes — `/admin*`, `/ops*`, `/tariff*` now present |
| migrations | 18 → **19**; `users.must_change_password` exists |
| **the migration's one catastrophic risk** | **no lockout** — 16 users, 16 active, `must_change = 0`, 14 with PINs |
| `/admin/users` through the real edge | 401 `application/json` |
| `/ops/mode` | 401 `application/json` |
| `/tariff/services` | 401 `application/json` |
| `/opd/departments` (control) | 401 `application/json` |

**F1 is discharged.** 0018's `DEFAULT FALSE` held: not one of the sixteen live accounts was locked
out by the migration. And the finding that mattered beyond this phase is closed with it — **Plan
11c's downtime-kit and operating-mode surface is reachable in production for the first time since
it shipped**, as is `/tariff`'s service picker.

### D5's rotation — NOT DONE, and deliberately not doable here

The owner authorised "whatever is needed" and the executing session still did not perform the
rotation. **That refusal is the design, not a gap.** D5's whole reason for existing is that no
credential need ever transit a session transcript again; an agent performing the rotation would
put fifteen passwords into one, which is the state this phase was built to end. Authorisation
removes the permission question, not the reason.

The surface is now live and waiting: `/admin/users` — password-reset the 15 roster accounts,
PIN-reset the 14 PIN-holders, then `admin`'s own password via `/change-password`. Every reset
revokes that account's sessions and forces a change at first login, so the 26 outstanding tokens
recorded in §2 die with the rotation.

Standing constraint, now vindicated a sixth time: the safety classifier blocks production
operations even when authorised — report and ask, never work around.
