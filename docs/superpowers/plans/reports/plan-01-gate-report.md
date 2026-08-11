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

**Test inventory:** `pnpm verify` = typecheck → lint → test, **exit 0**. **18 tests**: `@hmis/contracts` 5 (2 suites), `@hmis/core` 13 (5 suites). Verified independently by the main session after each pipeline, not only by the agents.

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
3. **`apps/core/jest.config.cjs` sets `maxWorkers: 1`.** The DB-backed suites share one `hmis_test` database and parallel workers truncated each other. **Watch this from Plan 05 on** — as suites grow this serialises the whole run; the durable fix is a per-worker database or schema, and it should be planned before the suite gets big.
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

**Planning lesson:** both defects were in code the plan presented as exact-and-final. Future plans should mark any hand-written matcher pattern or raw-SQL parameter binding as *verify-by-execution*, since neither fails at typecheck.

---

## 6. Open items carried forward

1. **The CI commit `07547af` is not on GitHub.** GitHub refuses `.github/workflows/*` from a deploy key. Requires a credential with `workflow` scope (`gh auth refresh -h github.com -s workflow`, then push). **CI has therefore never actually run** — its first green run is still unproven. Resolve before treating CI as a real gate.
2. `pnpm lint` emits **2 warnings** (unused `eslint-disable no-console` directives in `db-check.ts` / `migrate.ts`, inherited from the plan's verbatim code). 0 errors; harmless; clean up when convenient.
3. `runDispatchCycle` has **no scheduler** until Plan 11. Any plan needing live event fan-out before then must schedule it explicitly.
4. `ModuleRegistry` is not in Nest DI, and no module manifest exists yet — Plan 02's permission registry is its first consumer (`allPermissions()`).
5. **Deployment topology question for Plan 11:** this same box is currently build host, co-tenant of InsForge, and prospective deploy target. Spec §12 wants primary and standby in different fire zones — the separation needs a decision, not a default.
6. **InsForge remains out of the architecture** by the owner's decision (2026-08-11). Possible future fit — *evaluate, don't assume*: Plan 10's public read-only surface (spec §11.19-E fix 1), where `cc.elar.club` could serve as the outbound-push DMZ relay. Never a path into the core.

---

## 7. What Plan 02 can rely on

The event spine is real and provable: an append-only `events` table with the full §10.5 envelope, a transactional-outbox writer that lives or dies with the caller's transaction, idempotency for edge resubmissions, per-consumer cursor delivery with consumer isolation, a module manifest/registry with a deduped permission surface, a lint rule that genuinely blocks cross-module reach-in, and a CI definition (pending its first run). Plan 02 (Auth, RBAC & Actor Fabric) consumes `allPermissions()` from the registry and `Actor` from contracts, and adds nothing to the events table — it writes its own tables and emits `break_glass.used`, `sod.violation_blocked`, `emergency_elevation.used`, `temp_role.granted/.expired` through `appendEvent`.
