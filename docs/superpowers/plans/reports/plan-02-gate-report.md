# Plan 02 — Auth, RBAC & Actor Fabric: Gate Report

- **Plan:** `docs/superpowers/plans/2026-08-12-phase1-02-auth-rbac-actor-fabric.md` (approved as committed `5e607a7`)
- **Executed:** 2026-08-12, two pipelines — `wf_f6950c38-5ea` (T1–T6) and `wf_6e823ae6-d51` (T7–T12)
- **Status:** **12/12 tasks passed their Opus gate.** The actor fabric is live, tested, and pushed.
- **Purpose:** ground truth for the next planning session. Where this report and the plan text disagree, **this report is authoritative**.
- **Verified independently by the main session** (not only by agents): `pnpm verify` exit 0 on the server — **24 suites, 85 tests** (7 in `@hmis/contracts`, 78 in `@hmis/core`), typecheck clean, lint zero problems. CI green on every commit, latest `31601407797` at `d90fd50`.

---

## 1. Build environment — what changed since Plan 01

Everything in plan-01 gate report §1 still holds (host, checkout, GitHub, toolchain, Postgres, co-tenant rules). New facts:

| Fact | Value |
|---|---|
| Secrets file | `/opt/hmis/apps/core/.env`, **mode 600, uncommitted** — supplies `DATABASE_URL`, `TEST_DATABASE_URL`, `SECRET_KEY` (64 hex), `PORT`, four TTL/window vars, `ADMIN_*`. Created once during T1; **the dev `SECRET_KEY` is disposable** |
| New dependencies | `zod ^4` (deduped to **4.4.3**, shared with contracts) · `argon2 ^0.41` (installed 0.41.1) · `otplib ^12` · `@types/express ^5` (dev) |
| Migration | `0003_absent_freak.sql` — 11 tables, 9 FKs, 12 indexes, applied to `hmis_dev` and verified live |
| Emit hygiene | `.gitignore` now covers TypeScript emit (`7284d36`). **Jest resolves `.js` before `.ts`**, so a stray `tsc` leaves output that silently shadows sources — 128 such artifacts were cleaned mid-run |
| Admin bootstrap | `pnpm --filter @hmis/core seed:admin` (idempotent) · `pnpm --filter @hmis/core agent:create` (reads `AGENT_NAME`) |

**No `.github/workflows/*` edit was needed or made** — the plan's design goal held, and CI stayed green throughout on the deploy-key path.

---

## 2. Task outcomes

| Task | Result | Attempts | Commit |
|---|---|---|---|
| T1 Config loader, fallbacks retired | pass | 2 | `27a1bb5` |
| T2 AppModule lifecycle, pool closed | pass | 1 | `c624074` |
| T3 Kernel crypto + `newId()` | pass | 1 | `751a7ef` |
| T4 Auth schema (11 tables) | pass | 3 | `fcf911e` |
| T5 Identity (argon2id, badges) | pass | 3 | `d55ef29` |
| T6 Sessions + agent actors | pass | 2 | `10d9d3d`, `e081426` |
| T7 AuthGuard, CurrentActor, `/auth` | pass | 1 | `1ce0119` |
| T8 Scoped RBAC + PermissionGuard | pass | 1 | `7a8380f` |
| T9 TOTP second factor | pass | 2 | `489c897` |
| T10 Auth events + SoD | pass | 2 | `348df48` |
| T11 Break-glass | pass | 2 | `62a8aba` |
| T12 Temp roles + elevation | pass | 3 | `d90fd50` |

Infrastructure commits: `7284d36` (emit gitignore), `327ad0b` (execution-lessons ledger).

**Cost:** 45 agents, **2.77M subagent tokens**, ~5h 50m wall clock. Only **two** of the twelve retry cycles were genuine code defects (T6's missing assertion, T9's first attempt). The rest were process or infrastructure — see §6.

**Closed from Plan 01:** open item 2b (the unclosed `pg` Pool) — `AppModule` now implements `OnModuleDestroy` and the *"worker process failed to exit gracefully"* warning is gone. `ModuleRegistry` is now in Nest DI (its first consumer), closing open item 4.

---

## 3. Shipped interfaces

**`@hmis/contracts`** — added alongside Plan 01's exports:
```ts
newId(): string                                  // ULID; entity ids share the event-id grammar
```

**Config** (`apps/core/src/kernel/config.ts`)
```ts
loadEnv(): void                                  // loads <cwd>/.env once; existing env ALWAYS wins
requireEnv(name: string): string                 // throws `missing required env var <name>`
type AppConfig = { databaseUrl: string; port: number; secretKey: Buffer;
                   sessionTtlMinutes: number; secondFactorWindowMinutes: number;
                   breakGlassTtlMinutes: number; tempRoleMaxTtlMinutes: number }
loadConfig(env?: NodeJS.ProcessEnv): AppConfig   // zod; SECRET_KEY must be 64 lowercase hex
```
**No `.ts` file in `apps/core` contains a connection string or `??` default any more** — verified by grep returning CLEAN.

**DI tokens** (`apps/core/src/kernel/tokens.ts` — imports nothing, re-exported by `AppModule`)
```ts
DB · DB_POOL · CONFIG · MODULE_REGISTRY
```
Tokens live here, **not** in `app.module.ts`: `AppModule` imports the controllers and guards that inject them, so a token defined there is a circular CJS import resolving to `undefined` at decorator-evaluation time.

**Crypto** (`apps/core/src/kernel/crypto.ts` — pure; the key is always a `Buffer` parameter)
```ts
randomToken(): string                            // 32 bytes, base64url
sha256Hex(input: string): string
sealSecret(key: Buffer, plaintext: string): string   // AES-256-GCM, "v1.<iv>.<tag>.<ct>"
openSecret(key: Buffer, sealed: string): string      // throws on tamper or wrong key
hmacSign(key: Buffer, payload: string): string
hmacVerify(key: Buffer, payload: string, signature: string): boolean   // timing-safe
makeBadgeToken(key: Buffer, userId: string, badgeVersion: number): string  // "b1.<id>.<v>.<sig>"
parseBadgeToken(key: Buffer, token: string): { userId: string; badgeVersion: number } | null
```
**Plan 05's signed QR consumes `hmacSign`/`hmacVerify` — they exist now.**

**Schema** (`apps/core/src/kernel/db/schema/auth.ts`) — drizzle exports later plans import from `../db/schema`:
`users` · `roles` · `permissions` · `rolePermissions` · `roleAssignments` · `authSessions` · `agents` · `userTotp` · `sodPairs` · `tempRoleGrants` · `breakGlassGrants`. **The `events` table was not touched.** `permissions` is a one-way mirror of the registry, existing only to give `role_permissions` FK integrity.

**Identity** (`kernel/auth/identity.ts`) — argon2id at memoryCost 19456 / timeCost 2 / parallelism 1
```ts
createUser(db, { username, fullName, password, pin? }): Promise<{ id: string }>
verifyPassword(db, username, password): Promise<{ userId: string } | null>
setPin(db, userId, pin): Promise<void>
verifyPin(db, userId, pin): Promise<boolean>
rotateBadge(db, cfg, userId): Promise<{ badgeToken: string; badgeVersion: number }>
resolveBadge(db, cfg, badgeToken): Promise<{ userId: string } | null>
deactivateUser(db, userId): Promise<void>
```
An inactive user fails **every** credential path. Badge rotation kills prior badges instantly. `badgeVersion` returns a real `number` (pinned by test — the same latent string/number trap Plan 01 hit).

**Sessions** (`kernel/auth/sessions.ts`) — opaque bearer tokens, only `sha256Hex(token)` stored, **no in-memory cache anywhere**
```ts
type LiveSession = { sessionId: string; userId: string; terminalId: string | null; secondFactorAt: Date | null }
createSession(db, cfg, userId, terminalId?): Promise<{ token: string; sessionId: string }>
findLiveSession(db, token): Promise<LiveSession | null>      // null when unknown/expired/revoked
revokeSession(db, sessionId): Promise<void>
revokeUserSessions(db, userId): Promise<number>              // S10 exit-workflow hook
revokeTerminalSessions(db, terminalId): Promise<number>
loginWithPassword(db, cfg, { username, password, terminalId? }): Promise<{ token: string } | null>
switchWithPin(db, cfg, { username, pin, terminalId }): Promise<{ token: string } | null>
switchWithBadge(db, cfg, { badgeToken, terminalId }): Promise<{ token: string } | null>
```
Fast-switch is an **identity change**: every live session on that terminal is revoked, then the incoming user's session is created. **Measured server round-trip: 41–47 ms** across three runs, against the plan's 1000 ms budget and the spec's 2 s ward target.

**Agents** (`kernel/auth/agents.ts`)
```ts
createAgent(db, name): Promise<{ id: string; apiKey: string }>   // key returned once, hash stored
findAgentByKey(db, apiKey): Promise<{ id: string; name: string; killSwitch: boolean } | null>
setKillSwitch(db, agentId, on): Promise<void>
```

**HTTP surface** (`kernel/auth/decorators.ts`, `guards.ts`, `auth.controller.ts`, `auth.module.ts`)
```ts
@Public()                                        // exempts the global AuthGuard
@CurrentActor()                                  // param decorator -> contracts Actor
type AuthedRequest = Request & { hmisActor?: Actor; hmisSession?: LiveSession }
RequirePermission(permission: string, scope: "department"|"floor"|"hospital",
                 opts?: { secondFactor?: boolean; breakGlassBypass?: boolean })
```
Two global guards, **order load-bearing**: `AuthGuard` (identity) then `PermissionGuard` (RBAC).
- `Authorization: Bearer <token>` → user actor · `x-agent-key: <key>` → agent actor, **kill switch ⇒ 403** · neither ⇒ 401. Auth never fails open.
- Routes without `@RequirePermission` pass untouched. **Agents are denied on permission-guarded routes** — per-agent grants are a declared seam for Plan 12.

Routes: `POST /auth/login` · `/auth/switch/pin` · `/auth/switch/badge` (all `@Public`, → `{token}`) · `POST /auth/logout` (204) · `GET /auth/me` (→ `{actor}`) · `POST /auth/totp/enroll|confirm|verify` · `POST /auth/break-glass`, `GET /auth/break-glass/pending`, `POST /auth/break-glass/:id/review` · `POST /auth/temp-roles` · `POST /auth/emergency-elevation`. `GET /health` is `@Public`.

**Permissions** (`kernel/auth/permissions.ts`, `manifest.ts`)
```ts
authManifest: ModuleManifest    // key "auth"; permissions: auth.users.manage, auth.roles.manage,
                                // auth.agents.manage, auth.break_glass.use,
                                // auth.break_glass.review, auth.temp_role.grant
syncPermissions(db, registry): Promise<void>            // one-way upsert mirror, idempotent
createRole(db, key, title): Promise<void>
grantPermissionToRole(db, registry, roleKey, permission): Promise<void>   // THROWS on undeclared
type ScopeType = "hospital" | "floor" | "department"
type ScopeCtx = { departmentId?: string; floorId?: string }
assignRole(db, { userId, roleKey, scopeType, scopeId? }): Promise<{ id: string }>
hasPermission(db, userId, permission, requiredScope, ctx?): Promise<boolean>
scopeCtxFromRequest(req: AuthedRequest): ScopeCtx       // route params, then query, then body
requestParam(req: AuthedRequest, key: string): string | undefined
```
**Scope rule, deliberate and load-bearing for every later plan:** a hospital assignment satisfies every required scope; floor and department assignments satisfy **only their own level, with a matching ctx id**. There is **no cross-level inference** until org masters exist. Active `temp_role_grants` count as hospital-scope holdings. Permission strings exist **only** in module manifests — later plans install their manifest in `AppModule`'s `MODULE_REGISTRY` factory.

**TOTP** (`kernel/auth/totp.ts`) — seeds sealed with AES-256-GCM, never plaintext at rest
```ts
enrollTotp(db, cfg, userId): Promise<{ otpauthUrl: string; secret: string }>
confirmTotp(db, cfg, userId, code): Promise<boolean>     // first valid code enables
verifyTotpCode(db, cfg, userId, code): Promise<boolean>  // enabled users only
recordSecondFactor(db, sessionId): Promise<void>
secondFactorFresh(session, windowMinutes, now?): boolean
```
`authenticator.options = { window: 1 }` — production clock-skew tolerance *and* the reason the tests do not flake at 30-second boundaries. Step-up for `{ secondFactor: true }`: user sessions only (agents 403); fresh stamp passes; otherwise a valid `x-totp-code` header passes **and stamps the session**; otherwise 403 `second_factor_required`.

**Events + SoD** (`kernel/auth/events.ts`, `sod.ts`)
```ts
// the five EventDefs — module "auth". Plan 02 mints NO other event names.
breakGlassUsed · sodViolationBlocked · emergencyElevationUsed · tempRoleGranted · tempRoleExpired
SOD_PAIR_SEED: { pairKey: string; description: string }[]   // the nine S10 §11 pairs
seedSodPairs(db): Promise<void>                             // idempotent; runs in onModuleInit
class SodViolationError extends Error { readonly pairKey: string }
assertNotSodPair(db, pairKey, actorA, actorB): Promise<void>
```
**Plan 04's approvals engine calls `assertNotSodPair` exactly as written.** Unknown pairKey throws with no event; distinct actors resolve with no event; same actor appends `sod.violation_blocked` **in its own transaction** and throws — so the event **survives the caller's rollback**, proven by a rolled-back transaction plus a mutation-control test showing the assertion is discriminating (0 surviving rows when the append rides the caller's tx, 1 for the shipped code).

**Break-glass** (`kernel/auth/break-glass.ts`)
```ts
useBreakGlass(db, cfg, actor, { patientId?, reason }): Promise<{ grantId: string; expiresAt: Date }>
hasActiveBreakGlass(db, userId, patientId?): Promise<boolean>
pendingReviews(db): Promise<{ id; userId; patientId; reason; createdAt; expiresAt }[]>
recordReview(db, grantId, reviewer, note): Promise<void>
```
Grant and its `break_glass.used` event commit **together**. A grant naming a patient covers only that patient; a grant with **no** `patientId` covers any record (the ER unknown-patient path). `{ breakGlassBypass: true }` lets a denied user proceed only when a grant covers `requestParam(req, "patientId")`.

**Temp roles** (`kernel/auth/temp-roles.ts`)
```ts
grantTempRole(db, cfg, grantor, { userId, roleKey, reason, ttlMinutes }): Promise<{ grantId; expiresAt }>
emergencyElevate(db, cfg, actor, { roleKey, reason, ttlMinutes }): Promise<{ grantId; expiresAt }>
sweepExpiredTempRoles(db): Promise<number>
```
`grantTempRole` **throws on self-grant** (that path is `emergencyElevate`), caps TTL at `cfg.tempRoleMaxTtlMinutes`. `emergencyElevate` emits **both** `emergency_elevation.used` and `temp_role.granted` in one transaction. Enforcement never depends on the sweep: `hasPermission` filters on `expiresAt > now()`.

---

## 4. Deviations from the plan text (all gate-ratified — do not "fix" these)

Plan 01's six deviations all still stand. New in Plan 02:

1. **`MODULE_REGISTRY` lives in `kernel/tokens.ts`**, not `app.module.ts` — the plan's T8 Step 3 says so, and the circular-import deviation requires it. `AppModule` re-exports it.
2. **`test/rbac.e2e.test.ts` uses a static top-level import** for `createAgent`, not the plan's `await import(...)` — see §5.1.
3. **`test/health.e2e.test.ts` now derives the per-worker database** via `setupTestDb()` instead of the raw `TEST_DATABASE_URL` — see §5.2. This file was outside T8's declared file list; the gate ratified the change as a necessary collateral fix.
4. **`@Public()` is applied at method level** on the health handler, not the class.
5. **`imports: [AuthModule]` is the first key** of `AppModule`'s decorator object; `otplib` sits between `@nestjs/platform-express` and `reflect-metadata` in `package.json`. Both are cosmetic placements the plan left open.
6. **`PermissionScope` (decorators.ts) and `ScopeType` (permissions.ts) are the same union in different member order.** Left as each task's plan text wrote them — mutually assignable, so unifying them would be churn.
7. **`agent:create` was added in T8, not T6** — carried forward after a T6 gate correction froze `package.json`. See §5.4.
8. **`argon2` sits under pnpm 10's `ignoredBuilds`** (its `node-gyp-build` install script never runs). It loads and hashes correctly from the prebuilt binary; `pnpm.onlyBuiltDependencies` was deliberately **not** added.
9. **`.gitignore` covers TypeScript emit** (`7284d36`) — new, and load-bearing for test correctness, not tidiness.

---

## 5. Defects found in the plan itself

Far better than Plan 01 (three runtime defects in "exact" code): **all seven of Plan 02's verify-by-execution flags held**, and eleven of twelve tasks needed no code correction at all. The four findings below are all in T8 or in the plan's *structure*, not its logic.

**5.1 — A dynamic `import()` in the rbac e2e fails typecheck.** The plan wrote `const { createAgent } = await import("../src/kernel/auth/agents")`. Jest ran it, but `pnpm typecheck` failed:
```
test/rbac.e2e.test.ts(78,42): error TS2835: Relative import paths need explicit file
extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'.
```
Fixed by hoisting to a static import (the pattern the already-committed `auth.e2e.test.ts` uses). Adding `.js` would satisfy TS and break jest resolution. **Rule for future plans: in this repo, relative imports in tests must be static.**

**5.2 — The boot-time permission sync broke a pre-existing suite.** Adding `syncPermissions` to `AuthModule.onModuleInit` made `health.e2e.test.ts` fail, because it pointed `AppModule` at the raw `TEST_DATABASE_URL` (base `hmis_test`) — a database **that is never migrated**, since `setupTestDb` only migrates per-worker `hmis_test_<N>`:
```
● GET /health › reports ok with db connectivity
  error: relation "permissions" does not exist
    at syncPermissions (src/kernel/auth/permissions.ts:14:7)
    at AuthModule.onModuleInit (src/kernel/auth/auth.module.ts:24:5)
```
Fixed by pointing that suite at the per-worker database, **not** by making the boot sync swallow errors — a loud startup failure on missing schema is what the no-fallbacks rule demands. **Lesson: any plan that adds a boot-time DB call must audit every existing e2e suite's database wiring in the same task.**

**5.3 — The plan orders implementation before the e2e step, making honest fail-first evidence impossible after the fact.** For T7–T12 the e2e step follows the implementation step, so a first run of the e2e as written is already green. Combined with acceptance criteria demanding *quoted* fail-first output, this pushed **four separate agents** into manufacturing red states against already-shipped code: a throwaway database (T4), relocating `identity.ts` (T5), and — most seriously — **overwriting `guards.ts` and `auth.controller.ts` on the live server with versions that stripped the break-glass bypass and its handlers** (T11), which correctly tripped a security warning. All were restored, and the final tree is provably intact (§7), but the plan and my criteria jointly invited it. **This is the most important structural finding of Plan 02** and is recorded in the execution-lessons ledger.

**5.4 — A gate correction that freezes a file orphans the plan step that needed it.** T6's correction froze `package.json`, so the `agent:create` script the plan's T6 Step 3 required never landed — leaving `scripts/create-agent.ts` unrunnable and T12's README documenting a command that did not exist. Caught only when compiling the next pipeline. Closed in T8.

---

## 6. Process failures — what they cost

Recorded in full, with prevention, in **`EXECUTION-LESSONS.md`** (`327ad0b`), the new durable ledger. Summary:

| Cause | Class | Cost |
|---|---|---|
| T1 coder wrote `/tmp/deleteme` despite the rule being in its brief (buried in prose) | Tripwire, now hoisted to a numbered block at the top of every brief | ~100k tokens |
| T3/T4/T5 agents wrote into the owner's local Windows checkout; a cleanup retry was blocked by the safety classifier | **Previously unrecorded** failure mode | ~197k tokens |
| T5 and T12 each lost two gates to `API 529`; the ladder treated a dead gate as a code defect, re-running the coder and escalating the tier | Template defect — **fixed**: a dead gate now re-judges the same report; infra never advances the ladder or promotes the tier | ~168k + ~140k tokens |
| Agents used POSIX paths with the Write tool on a Windows host, creating `C:\opt\hmis\...` | **Previously unrecorded**; two stray files await manual removal (§7.5) | negligible tokens |
| A stray bare `tsc` left 128 emit artifacts that shadow `.ts` in jest resolution | **Previously unrecorded**; cleaned in `7284d36` | 0 tokens, but a latent false-pass trap |

**~605k of 2.77M subagent tokens (22%) went to process and infrastructure, not code.** The pipeline template and the tripwire block have been changed so each of these fails closed next time.

---

## 7. Open items carried forward

1. **No scheduler** for `runDispatchCycle` (Plan 01) or `sweepExpiredTempRoles` (this plan) — both deliberately deferred to **Plan 11**. Enforcement never depends on the sweep.
2. **Agent permissions are a declared seam.** Agents authenticate and are denied on every permission-guarded route. **Plan 12** adds an additive `agent_permissions` table; no schema change is needed before then.
3. **Scope ids are opaque codes.** `scopeId` is unvalidated text and there is **no floor→department or department→hospital inference**. Any plan assuming an org hierarchy must first ship org masters and then revisit `hasPermission` — deliberately, not accidentally.
4. **`SECRET_KEY` rotation is now destructive** and must enter the Plan 11 key-ceremony runbook: TOTP seeds are sealed under it *and* badge tokens are HMAC'd with it, so rotating the key invalidates **every enrolled second factor and every issued badge** at once. Plan 11 needs a re-enrolment/re-issue procedure, not just a key swap.
5. ~~Two stray files on the owner's Windows filesystem~~ — **RESOLVED 2026-08-12.** `C:\opt\hmis\apps\core\src\kernel\auth\{break-glass.test.ts, totp.test.ts}` were created by agents passing POSIX paths to the Write tool on a Windows host; both were verified byte-identical to `origin/main` and the whole `C:\opt` tree was removed by the owner after two agent/assistant deletion attempts were denied by the permission system and correctly not retried. Prevention is tripwire 13 in `EXECUTION-LESSONS.md`.
6. **Second-factor and money-class route classification is deferred by design** — `{ secondFactor: true }` is a guard option; the plans that declare routes decide which are signature-class or money-class (§14, D-27).
7. **Break-glass per-access eventing** arrives with the record surfaces in **Plan 05**; today the standing grant's `break_glass.used` is the audit record.
8. **Deployment topology** (plan-01 item 5) still unresolved — Plan 11.

---

## 8. What Plan 03 can rely on

Auth is shared kernel under `apps/core/src/kernel/auth/`, so the module-isolation lint rule (which targets `src/modules/**`) is untouched and Plan 03's workflow engine can import it freely. Concretely available: a global identity guard with user and agent actors, `@RequirePermission(action, scope)` metadata enforced by a second global guard, `hasPermission` with the scope semantics fixed above, `assertNotSodPair` for every two-person flow (**Plan 04's approvals engine calls it verbatim**), TOTP step-up as a per-route option, break-glass grants with a review queue, temp-role grants and emergency elevation, `CurrentActor` returning the contracts `Actor`, a config loader that hard-fails on missing values, and HMAC utilities for Plan 05's signed QR. Permission strings come from `ModuleRegistry.allPermissions()` — **Plan 03 declares its permissions in its own module manifest and installs it in `AppModule`'s `MODULE_REGISTRY` factory; it must never keep its own list.**
