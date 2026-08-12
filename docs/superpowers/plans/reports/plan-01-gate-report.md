# Plan 01 — Foundation Kernel: Gate Report

- **Plan:** `docs/superpowers/plans/2026-08-11-phase1-01-foundation-kernel.md`
- **Executed:** 2026-08-11 / 2026-08-12 (single session)
- **Status:** **10/10 tasks passed their Opus gate.** Kernel is live, tested, and pushed.
- **Purpose of this file:** ground truth for the next planning session. Where this report and the plan text disagree, **this report is authoritative** — the plan contains two defects that would not compile/enforce as written (§5 below).

---

## 1. Build environment (unchanged facts every later plan depends on)

| Fact | Value |
|---|---|
| Build + test host | `root@62.238.106.231` (Hetzner, Ubuntu, ufw allows 22/80/443 only) |
| Repo checkout | `/opt/hmis` — the **canonical working copy**; agents work here over SSH |
| GitHub | `git@github.com:ankits3a/hims-hmis.git` — **private**, branch `main`, server pushes via deploy key `hetzner-build-box` |
| Toolchain | Node **v22.23.2**, pnpm **10.34.5** (installed via NodeSource + `npm i -g pnpm@10`) |
| Database | Postgres 16 in docker compose project **`hmis`**, bound **`127.0.0.1:5433`**, databases `hmis_dev` + `hmis_test`, user/pass `hmis`/`hmis` |
| Local Windows repo | `C:\Users\ankit\hmis` — docs/planning only; **not** a build environment |
| Co-tenant | An unrelated **InsForge** stack runs on the same host (`insforge-*` containers, `/opt/InsForge`, ports 5430/5432/7130/7133). **Off-limits to all pipeline work.** Not part of this architecture (spec §2/§5 stands: one NestJS app over one Postgres). |

**Shared-host rules that must be copied into every future task brief:** `/opt/hmis` is the only writable path on that server (including no writes to `/tmp`); no docker container may be created except the `hmis` compose project; never read, stat, or reference `/opt/InsForge`; never infer from logs/timestamps who did what (the owner works on the same box from the same IP and key).

---

## 2. Task outcomes

| Task | Result | Attempts | Commit |
|---|---|---|---|
| T1 Monorepo scaffold | pass | 2 | `8e146c3` |
| T2 Dev/test Postgres | pass | 1 | `f956e06` |
| T3 Contracts — ids, envelope, registry | pass | 1 | `164b73d` |
| T4 Drizzle infra + events table | pass | 2 | `d5b68f7` |
| T5 `appendEvent` outbox writer | pass | 3 | `80a0a3b` |
| T6 NestJS skeleton + health | pass | 2 | `d6da23c` |
| T7 Module manifest + registry | pass | 1 | `b8f2cb7` |
| T8 Module-isolation lint rule | pass | 1 | `a0a4f11` |
| T9 Outbox dispatcher + cursors | pass | 1 | `2d85732` |
| T10 CI workflow + README | pass | 1 | `07547af` |

**Test inventory:** `pnpm verify` = typecheck → lint → test, **exit 0**, lint reporting **zero problems**. **22 tests**: `@hmis/contracts` 5 (2 suites), `@hmis/core` 17 (5 suites), running **in parallel** on per-worker databases. Verified independently by the main session after each pipeline, not only by the agents.

**Post-plan work folded in (same session, each separately gated):** `88b5e65` CI fix · `1f92110` lint warnings cleared · `3944469` per-worker test databases · `3660ffa` idempotency side table.

**Retry causes** (none were code-quality failures): T1#1 and T4#1 breached shared-host rules (a read-only `stat` of `/opt/InsForge`; a `/tmp` write). T5#2/#3 and T6#2 were process disputes over producing fail-first evidence for files already correct and committed. A prior run (`wf_f14fbdd4-f2a`) was halted entirely by a **bad acceptance criterion of mine** — it asserted the co-tenant InsForge stack was healthy, an externally-mutable condition the task could not control. Lesson folded in: **every criterion must be attributable to the task itself.**

---

## 3. Shipped interfaces (the contract later plans build on)

All signatures below were verified by the gate against the plan's Interfaces blocks.

**`@hmis/contracts`** (`packages/contracts/src/`)
```ts
newEventId(): string                                  // ULID
type Actor = { type: "user" | "agent" | "system"; id: string }
type EventInput = { name; version; occurredAt; actor; patientId?; encounterId?;
                    correlationId?; causationId?; module; payload; siteId; idempotencyKey? }
defineEvent<S extends z.ZodTypeAny>(name, module, payloadSchema, version = 1): EventDef<S>
   // throws unless name matches /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
   // .make(args) validates payload via zod, defaults version=1, siteId="main", occurredAt=now
class EventRegistry { register(def): void; get(name): EventDef|undefined; names(): string[] }
   // register throws on duplicate name
```

**Kernel DB** (`apps/core/src/kernel/db/`)
```ts
type Db; type Tx
createDb(url: string): { db: Db; pool: Pool }
withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>
```
`events` table — 16 columns, append-only, **no UPDATE/DELETE path anywhere in the codebase**:
`seq` (bigserial PK) · `event_id` (unique) · `name` · `version` (default 1) · `occurred_at` · `recorded_at` (default now — **kept distinct from occurred_at**, downtime backfill depends on it) · `actor_type` · `actor_id` · `patient_id?` · `encounter_id?` · `correlation_id?` · `causation_id?` · `module` · `payload` (jsonb) · `site_id` (default `'main'`) · `idempotency_key?` (unique index). Indexes on `name`, `patient_id`, `correlation_id`. Migration `apps/core/drizzle/0000_wakeful_ink.sql`.

**Outbox writer** (`apps/core/src/kernel/events/append.ts`)
```ts
appendEvent(tx: Tx, input: EventInput): Promise<{ eventId: string; seq: number }>
```
Writes on the caller's transaction (rollback-proven by test). On `idempotency_key` conflict: no second insert, returns the existing row's ids.

**Idempotency side table** (added 2026-08-12, commit `3660ffa`, owner-approved) — `event_idempotency`: `idempotency_key` text **PK** · `event_id` text not null · `seq` bigint (nullable *by design*, always populated before the transaction commits) · `recorded_at` timestamptz default now. `events.idempotency_key` **keeps its column but its index is now plain, not unique** — global uniqueness lives in this non-partitioned side table so it survives any future partitioning of `events` (see §6.5).
`appendEvent`'s algorithm is now **side-table-first**: claim the key with `ON CONFLICT DO NOTHING … RETURNING`; if the claim returns nothing the key is taken, so read back `event_id`/`seq` and insert **no** event row; otherwise insert the event and backfill the claim's `seq`. Ordering matters — it makes the duplicate case a no-op without a SAVEPOINT inside the caller's transaction. No nested transaction; every statement on the passed `tx`.
**Latent bug fixed in passing:** the old duplicate path returned `seq` as a **string** (pg returns bigint as text through raw `execute`) while the declared type says `number` — verified by the gate against the live database. Both paths now return a real `number`, pinned by test. Anything that consumed `appendEvent`'s `seq` was at risk of a silent `"1" !== 1` comparison.

**Module framework** (`apps/core/src/kernel/modules/`)
```ts
type ModuleManifest = { key; title; menu: {label,path,permission}[]; permissions: string[];
                        subscriptions: {event,consumer}[] }
class ModuleRegistry {
  install(m): void            // throws on duplicate key; throws on malformed subscription event name
  all(): ModuleManifest[]
  subscriptionsFor(eventName): { consumer, moduleKey }[]
  allPermissions(): string[]  // deduped — Plan 02's auth layer consumes THIS, never its own list
}
```
Not yet wired into Nest DI — deliberate; wiring belongs to a later plan.

**Dispatcher** (`apps/core/src/kernel/events/`)
```ts
type DispatchedEvent = { seq; eventId; name; payload; patientId; correlationId }
type Handler = (e: DispatchedEvent) => Promise<void>
class SubscriptionBus { on(consumer, eventName, handler): void; consumers(): {...}[] }
runDispatchCycle(db: Db, bus: SubscriptionBus, batchSize = 100): Promise<number>
```
Guarantees proven by test: at-least-once delivery; cursor advances **only after** the handler resolves; a throwing handler halts only its own consumer (redelivered next cycle) while other consumers proceed. Cursor table `event_cursors` (`consumer` PK, `last_seq`, `updated_at`), migration `0001_huge_wrecker.sql`.
**pg-boss scheduling of this cycle is deliberately deferred to Plan 11 (Deployment).** Today nothing calls `runDispatchCycle` in production.

**HTTP** (`apps/core/src/`) — `AppModule` with `@Global` DI token `DB`; `GET /health` → `{ status: "ok", db: "ok" }` (executes `select 1`). Boot: `pnpm --filter @hmis/core start:dev`.

---

## 4. Deviations from the plan text (all gate-ratified — do not "fix" these)

1. **`docker/docker-compose.dev.yml` binds `127.0.0.1:5433:5432`** (plan said `5433:5432`). The build host is internet-facing; a plaintext-credential Postgres must not be one firewall rule from the world.
2. **`packages/contracts/package.json` has no `"type": "module"`.** The predicted ESM trap bit at the *typecheck* step, not jest: under `NodeNext`, TS2835 demanded explicit file extensions on every relative import. Removing the field was the smaller of the two sanctioned fixes. No exported name or signature changed.
3. ~~`maxWorkers: 1`~~ — **superseded 2026-08-12 (commit `d0b0b0e`-series, gated).** The serialisation is gone: `setupTestDb()` now derives a per-worker database from `TEST_DATABASE_URL` + `JEST_WORKER_ID` (`hmis_test_1`, `hmis_test_2`, …), creating it on demand through a short-lived maintenance connection to the `postgres` database (pre-check on `pg_database` *and* a `42P04` catch), then migrating it. **`setupTestDb()` and `truncateAll(db)` keep their exact signatures — every DB-backed test in every later plan writes against them unchanged, and gets parallelism for free.** Verified green over 6 consecutive runs plus a fresh-database cold path (proving the CI case where no worker DB exists yet).
4. **`apps/core/src/index.ts`** exists as an accepted placeholder.
5. **`pnpm-lock.yaml` is committed with every dependency change** (the plan's per-task `git add` lists didn't mention it; omitting it leaves the tree dirty).
6. **`eslint.config.mjs` carries one test-scoped accommodation**: `@typescript-eslint/no-unused-vars` is disabled for `**/*.test.ts`, because Task 4's plan-verbatim test destructures `pool` without reading it. The isolation rule itself is untouched, and the recommended set stays fully active for all non-test source.

---

## 5. Two defects found **in the plan itself** (fixed in code; fix the pattern in future plans)

**5.1 — The module-isolation lint rule was silently dead as written.** *(critical: this rule is the mechanical enforcement of spec §4)*

The plan's `no-restricted-imports` patterns used bash extglob (`"../*/!(index)"`). ESLint 9 matches `patterns.group` through the `ignore` package (gitignore semantics), which **does not support extglob** — the agent verified empirically against ESLint's own matcher that all four patterns evaluate `false` for every import, including the fixture's own violation. Implemented verbatim, `pnpm lint` would never fail on a cross-module import and the architecture rule would have been decorative.

Shipped replacement (same scope, same message text, same intent):
```js
patterns: [{
  group: ["../[a-zA-Z0-9_-]*/**", "!../[a-zA-Z0-9_-]*/index",
          "**/modules/[a-zA-Z0-9_-]*/**", "!**/modules/[a-zA-Z0-9_-]*/index"],
  message: "Modules may only import another module's index.ts (its declared interface). Cross-module internals are forbidden (spec §4).",
}]
```
Proven by fixture: sibling internals **blocked**, sibling `index` **allowed**, `src/kernel/**` imports **allowed**, deep sibling paths **blocked**, bare specifiers (`@hmis/contracts`, `drizzle-orm`) unaffected. Fixtures deleted before commit.

**5.2 — Drizzle array parameters don't bind as arrays.** In `runDispatchCycle`, `sql\`name = any(${names})\`` expands a JS array into a parenthesised comma-list (built for `IN`), producing *malformed array literal* / *cannot cast type record to text[]*. Shipped fix: `sql.param(names)` with the `::text[]` cast, forcing a genuine single-parameter bind. **Any future plan that writes a raw `= any(...)` predicate must use `sql.param()`.**

**5.3 — The CI workflow could never start.** The plan's `pnpm/action-setup@v4` step passed `with: { version: 10 }` while the root `package.json` pins `"packageManager": "pnpm@10.0.0"`; the action hard-errors on a duplicate version spec (`ERR_PNPM_BAD_PM_VERSION` family) and the job died at 35s before installing anything. Fixed by dropping the `version` input and letting the action read the `packageManager` pin — commit `88b5e65`, gated separately. First green run: **31537097234** (`pnpm install --frozen-lockfile` + `pnpm verify` both executed and passed, 12/12 steps).

**Planning lesson:** all three defects were in code the plan presented as exact-and-final, and **none** of them fail at typecheck — a dead lint matcher, a mis-bound SQL parameter, and a CI config conflict all look correct on the page. Future plans should mark hand-written matcher patterns, raw-SQL parameter bindings, and third-party CI action inputs as *verify-by-execution*, and no plan's CI task should be considered done until a run is observed green.

---

## 6. Open items carried forward

1. ~~CI commit not pushed / never run~~ — **RESOLVED.** GitHub refuses `.github/workflows/*` pushed with a deploy key, so that file must always be pushed from a machine whose credentials carry the `workflow` scope (the owner's `gh` token was refreshed with `gh auth refresh -h github.com -s workflow`). **Standing rule for every future plan: the server checkout cannot push workflow files — route those through the local machine.** CI now runs on every push and is green (`31537097234`).
2. ~~2 lint warnings~~ — **RESOLVED.** `pnpm lint` now reports zero problems, zero warnings.

2b. **Known minor leak for Plan 02 to close:** the Nest e2e test logs *"A worker process has failed to exit gracefully"*. `AppModule`'s `DB` provider factory creates a `pg` Pool that nothing closes on `app.close()` — reproducible before and after the test-isolation work, and it affects neither exit code nor results. Plan 02 touches `AppModule` for guards and `CurrentActor`; close the pool via a lifecycle hook (`OnModuleDestroy`) while you are in there.
3. `runDispatchCycle` has **no scheduler** until Plan 11. Any plan needing live event fan-out before then must schedule it explicitly.
4. `ModuleRegistry` is not in Nest DI, and no module manifest exists yet — Plan 02's permission registry is its first consumer (`allPermissions()`).
5. **Deployment topology question for Plan 11:** this same box is currently build host, co-tenant of InsForge, and prospective deploy target. Spec §12 wants primary and standby in different fire zones — the separation needs a decision, not a default.
6. **InsForge remains out of the architecture** by the owner's decision (2026-08-11). Possible future fit — *evaluate, don't assume*: Plan 10's public read-only surface (spec §11.19-E fix 1), where `cc.elar.club` could serve as the outbound-push DMZ relay. Never a path into the core.

---

## 7. What Plan 02 can rely on

The event spine is real and provable: an append-only `events` table with the full §10.5 envelope, a transactional-outbox writer that lives or dies with the caller's transaction, idempotency for edge resubmissions, per-consumer cursor delivery with consumer isolation, a module manifest/registry with a deduped permission surface, a lint rule that genuinely blocks cross-module reach-in, and a CI definition (pending its first run). Plan 02 (Auth, RBAC & Actor Fabric) consumes `allPermissions()` from the registry and `Actor` from contracts, and adds nothing to the events table — it writes its own tables and emits `break_glass.used`, `sod.violation_blocked`, `emergency_elevation.used`, `temp_role.granted/.expired` through `appendEvent`.
