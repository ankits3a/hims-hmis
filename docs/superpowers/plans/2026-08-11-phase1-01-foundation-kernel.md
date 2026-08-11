# Phase 1 / Plan 01 — Foundation Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the HMIS monorepo with its load-bearing kernel: PostgreSQL + Drizzle migrations, the append-only transactional-outbox event log, the module framework with manifests and enforced isolation, and an outbox dispatcher — all under CI.

**Architecture:** One NestJS modular monolith (`apps/core`) over one PostgreSQL 16 database. Every state change writes its event to the `events` table in the same transaction (transactional outbox, spec §4/§10.5). Modules are folders registered via manifests; cross-module imports are lint-forbidden. A pg-boss-scheduled dispatcher delivers events to in-process subscribers with per-consumer cursors (at-least-once).

**Tech Stack:** Node 22 LTS · pnpm workspaces · TypeScript ≥5.6 (strict) · NestJS ^11 · PostgreSQL 16 (Docker) · drizzle-orm + drizzle-kit · zod ^4 · ulid · pg-boss ^10 · Jest ^29/^30 + supertest · ESLint 9 flat config.

## Global Constraints (from spec v4.5)

- TypeScript everywhere; strict mode; no `any` in kernel code.
- **Events are append-only** — no UPDATE/DELETE path on `events`; corrections use the entered-in-error grammar (later plan) — never edits (§10.5, §11.19-E-8).
- Event names: `entity.verb_past` lowercase (§10.5). Envelope fields verbatim: `event_id` (ULID), `name`, `version`, `occurred_at`, `recorded_at`, `actor`, `patient_id?`, `encounter_id?`, `correlation_id?`, `causation_id?`, `module`, `payload`, `site_id`.
- `occurred_at` ≠ `recorded_at` is load-bearing (downtime backfill, §11.4 map 1) — never collapse them.
- Modules may not touch another module's tables or import another module's internals — enforced by lint (§4).
- No message broker, no Redis: coordination via Postgres + pg-boss only (§5); one codebase, multiple processes later (§2 v4.3) — nothing in this plan may assume single-process state.
- Idempotency keys on edge-submitted events (§11.14 sweep #10) — the `events` table carries a nullable unique `idempotency_key` from day one.
- Performance budget guardrail: kernel adds no per-request synchronous work beyond the transaction itself (§13/§15 budgets are tested in later plans).
- Site dimension: `site_id` default `'main'` everywhere now (multi-site future, §10.5).

## File Structure (locked by this plan)

```
hmis/
  package.json                     # workspace root, verify scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.mjs                # flat config incl. module-isolation rule
  docker/docker-compose.dev.yml    # dev + test Postgres
  .github/workflows/ci.yml
  packages/contracts/              # shared types: envelope, registry, ids
    src/envelope.ts
    src/registry.ts
    src/ids.ts
    src/index.ts
    test/*.test.ts
  apps/core/                       # the monolith
    src/main.ts
    src/app.module.ts
    src/health/health.controller.ts
    src/kernel/db/client.ts        # pg Pool + drizzle client + tx helper
    src/kernel/db/schema/events.ts # events table schema
    src/kernel/db/schema/index.ts
    src/kernel/events/append.ts    # appendEvent (outbox writer)
    src/kernel/events/dispatcher.ts# cursor-based dispatcher
    src/kernel/events/subscriptions.ts
    src/kernel/modules/manifest.ts # ModuleManifest type
    src/kernel/modules/loader.ts   # registry of installed modules
    drizzle.config.ts
    drizzle/                       # generated SQL migrations
    test/health.e2e.test.ts
    test/helpers/db.ts             # test-db lifecycle (migrate, truncate)
    src/kernel/**/*.test.ts        # unit/integration tests colocated
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`
- Create: `apps/core/package.json`, `apps/core/tsconfig.json`

**Interfaces:**
- Produces: workspace layout above; root scripts `pnpm verify` (typecheck+lint+test, lint added in Task 8), `pnpm -r build`; `@hmis/contracts` importable from `apps/core`.

- [ ] **Step 1: Root files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`package.json` (root):
```json
{
  "name": "hmis",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "typecheck": "pnpm -r exec tsc --noEmit",
    "test": "pnpm -r test",
    "verify": "pnpm typecheck && pnpm test"
  },
  "packageManager": "pnpm@10.0.0"
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`.nvmrc`: `22`

`.gitignore`: append `node_modules/`, `dist/`, `.env`, `coverage/` (keep the existing `.superpowers/` line).

- [ ] **Step 2: contracts package**

`packages/contracts/package.json`:
```json
{
  "name": "@hmis/contracts",
  "version": "0.1.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "test": "jest --passWithNoTests" },
  "devDependencies": { "typescript": "^5.6.0", "jest": "^29.7.0", "ts-jest": "^29.2.0", "@types/jest": "^29.5.0" }
}
```

`packages/contracts/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`packages/contracts/src/index.ts`:
```ts
export {};
```

Add `packages/contracts/jest.config.cjs`:
```js
module.exports = { preset: "ts-jest", testEnvironment: "node", testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"] };
```

- [ ] **Step 3: core app package (empty shell for now)**

`apps/core/package.json`:
```json
{
  "name": "@hmis/core",
  "version": "0.1.0",
  "scripts": { "test": "jest --passWithNoTests" },
  "dependencies": { "@hmis/contracts": "workspace:*" },
  "devDependencies": { "typescript": "^5.6.0", "jest": "^29.7.0", "ts-jest": "^29.2.0", "@types/jest": "^29.5.0", "@types/node": "^22.0.0" }
}
```

`apps/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "drizzle.config.ts"] }
```

`apps/core/jest.config.cjs`:
```js
module.exports = { preset: "ts-jest", testEnvironment: "node", testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"], testTimeout: 15000 };
```

- [ ] **Step 4: Verify the scaffold**

Run: `pnpm install && pnpm verify`
Expected: install succeeds; typecheck passes; tests pass (no tests yet → `--passWithNoTests`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo (contracts + core)"
```

---

### Task 2: Dev & test databases

**Files:**
- Create: `docker/docker-compose.dev.yml`, `apps/core/.env.example`, `apps/core/scripts/db-check.ts`

**Interfaces:**
- Produces: Postgres 16 on `localhost:5433`, databases `hmis_dev` and `hmis_test`; env var contract `DATABASE_URL` (dev) / `TEST_DATABASE_URL` (tests).

- [ ] **Step 1: Compose file**

`docker/docker-compose.dev.yml`:
```yaml
services:
  db:
    image: postgres:16
    ports: ["5433:5432"]
    environment:
      POSTGRES_USER: hmis
      POSTGRES_PASSWORD: hmis
      POSTGRES_DB: hmis_dev
    volumes:
      - ./initdb:/docker-entrypoint-initdb.d
      - hmis_pgdata:/var/lib/postgresql/data
volumes:
  hmis_pgdata:
```

`docker/initdb/01-test-db.sql`:
```sql
CREATE DATABASE hmis_test OWNER hmis;
```

`apps/core/.env.example`:
```
DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_dev
TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_test
```

- [ ] **Step 2: Failing smoke script**

`apps/core/scripts/db-check.ts`:
```ts
import { Client } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev";
  const client = new Client({ connectionString: url });
  await client.connect();
  const res = await client.query("select version()");
  // eslint-disable-next-line no-console
  console.log(res.rows[0].version);
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Add to `apps/core/package.json` dependencies: `"pg": "^8.13.0"`; devDependencies: `"@types/pg": "^8.11.0"`, `"tsx": "^4.19.0"`; script: `"db:check": "tsx scripts/db-check.ts"`.

Run: `pnpm --filter @hmis/core db:check`
Expected: FAIL (connection refused — container not up).

- [ ] **Step 3: Bring the database up, verify**

Run: `docker compose -f docker/docker-compose.dev.yml up -d && sleep 5 && pnpm --filter @hmis/core db:check`
Expected: prints `PostgreSQL 16.x ...`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: dev/test Postgres via docker compose + smoke check"
```

---

### Task 3: Contracts — IDs, envelope, registry

**Files:**
- Create: `packages/contracts/src/ids.ts`, `src/envelope.ts`, `src/registry.ts`; modify `src/index.ts`
- Test: `packages/contracts/test/envelope.test.ts`, `test/registry.test.ts`

**Interfaces:**
- Produces (exact, used by every later plan):
  - `newEventId(): string` — ULID.
  - `type Actor = { type: "user" | "agent" | "system"; id: string }`
  - `type EventInput = { name: string; version?: number; occurredAt?: Date; actor: Actor; patientId?: string; encounterId?: string; correlationId?: string; causationId?: string; module: string; payload: unknown; siteId?: string; idempotencyKey?: string }`
  - `defineEvent<T>(name, module, payloadSchema)` → `EventDef<T>` with `.make(input)` returning a validated `EventInput`.
  - `class EventRegistry` with `register(def)`, `get(name)`, `names(): string[]` — duplicate names throw.

- [ ] **Step 1: Write failing tests**

`packages/contracts/test/envelope.test.ts`:
```ts
import { defineEvent } from "../src/envelope";
import { z } from "zod";

const patientRegistered = defineEvent(
  "patient.registered",
  "registration",
  z.object({ uhid: z.string(), phone: z.string() }),
);

describe("defineEvent", () => {
  it("builds a valid EventInput with defaults", () => {
    const e = patientRegistered.make({
      actor: { type: "user", id: "u1" },
      payload: { uhid: "H0001", phone: "9999999999" },
    });
    expect(e.name).toBe("patient.registered");
    expect(e.module).toBe("registration");
    expect(e.version).toBe(1);
    expect(e.siteId).toBe("main");
    expect(e.occurredAt).toBeInstanceOf(Date);
  });

  it("rejects a payload that fails the schema", () => {
    expect(() =>
      patientRegistered.make({
        actor: { type: "user", id: "u1" },
        payload: { uhid: 42 } as unknown,
      }),
    ).toThrow();
  });

  it("rejects event names that are not entity.verb_past lowercase", () => {
    expect(() => defineEvent("PatientRegistered", "registration", z.object({}))).toThrow();
    expect(() => defineEvent("patient.Registered", "registration", z.object({}))).toThrow();
  });
});
```

`packages/contracts/test/registry.test.ts`:
```ts
import { EventRegistry } from "../src/registry";
import { defineEvent } from "../src/envelope";
import { z } from "zod";

describe("EventRegistry", () => {
  it("registers and lists event names", () => {
    const r = new EventRegistry();
    r.register(defineEvent("visit.opened", "opd", z.object({ visitId: z.string() })));
    expect(r.names()).toEqual(["visit.opened"]);
    expect(r.get("visit.opened")?.module).toBe("opd");
  });

  it("throws on duplicate registration", () => {
    const r = new EventRegistry();
    const d = defineEvent("visit.opened", "opd", z.object({}));
    r.register(d);
    expect(() => r.register(d)).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/contracts test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Add deps to `packages/contracts/package.json`: `"zod": "^4.0.0"`, `"ulid": "^3.0.0"` (dependencies).

`packages/contracts/src/ids.ts`:
```ts
import { ulid } from "ulid";
export function newEventId(): string {
  return ulid();
}
```

`packages/contracts/src/envelope.ts`:
```ts
import { z } from "zod";

export type Actor = { type: "user" | "agent" | "system"; id: string };

export type EventInput = {
  name: string;
  version: number;
  occurredAt: Date;
  actor: Actor;
  patientId?: string;
  encounterId?: string;
  correlationId?: string;
  causationId?: string;
  module: string;
  payload: unknown;
  siteId: string;
  idempotencyKey?: string;
};

export type MakeArgs = {
  actor: Actor;
  payload: unknown;
  occurredAt?: Date;
  patientId?: string;
  encounterId?: string;
  correlationId?: string;
  causationId?: string;
  siteId?: string;
  idempotencyKey?: string;
};

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export type EventDef<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  module: string;
  version: number;
  payloadSchema: S;
  make: (args: MakeArgs) => EventInput;
};

export function defineEvent<S extends z.ZodTypeAny>(
  name: string,
  module: string,
  payloadSchema: S,
  version = 1,
): EventDef<S> {
  if (!NAME_RE.test(name)) {
    throw new Error(`event name "${name}" must be lowercase entity.verb_past`);
  }
  return {
    name,
    module,
    version,
    payloadSchema,
    make(args: MakeArgs): EventInput {
      const payload = payloadSchema.parse(args.payload);
      return {
        name,
        module,
        version,
        payload,
        actor: args.actor,
        occurredAt: args.occurredAt ?? new Date(),
        patientId: args.patientId,
        encounterId: args.encounterId,
        correlationId: args.correlationId,
        causationId: args.causationId,
        siteId: args.siteId ?? "main",
        idempotencyKey: args.idempotencyKey,
      };
    },
  };
}
```

`packages/contracts/src/registry.ts`:
```ts
import type { EventDef } from "./envelope";

export class EventRegistry {
  private defs = new Map<string, EventDef>();

  register(def: EventDef): void {
    if (this.defs.has(def.name)) {
      throw new Error(`duplicate event registration: ${def.name}`);
    }
    this.defs.set(def.name, def);
  }

  get(name: string): EventDef | undefined {
    return this.defs.get(name);
  }

  names(): string[] {
    return [...this.defs.keys()];
  }
}
```

`packages/contracts/src/index.ts`:
```ts
export * from "./ids";
export * from "./envelope";
export * from "./registry";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/contracts test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): event envelope, name grammar, registry, ULID ids"
```

---

### Task 4: Drizzle infra + events table migration

**Files:**
- Create: `apps/core/drizzle.config.ts`, `apps/core/src/kernel/db/schema/events.ts`, `apps/core/src/kernel/db/schema/index.ts`, `apps/core/src/kernel/db/client.ts`, `apps/core/test/helpers/db.ts`
- Test: `apps/core/src/kernel/db/schema/events.test.ts`

**Interfaces:**
- Produces:
  - Drizzle table `events` (schema below) + generated SQL migration in `apps/core/drizzle/`.
  - `createDb(url): { db, pool }` and `withTx(db, fn)` from `kernel/db/client.ts` — exact: `withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T>`; types `Db`, `Tx` exported.
  - Test helper `setupTestDb(): Promise<{ db: Db; pool: Pool; teardown(): Promise<void> }>` — runs migrations on `TEST_DATABASE_URL`, truncates `events` between tests via exported `truncateAll(db)`.

- [ ] **Step 1: Schema**

Add deps to `apps/core/package.json`: `"drizzle-orm": "^0.40.0"` (dependencies); `"drizzle-kit": "^0.30.0"` (devDependencies). Scripts: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "tsx scripts/migrate.ts"`.

`apps/core/src/kernel/db/schema/events.ts`:
```ts
import { pgTable, text, integer, timestamp, jsonb, bigserial, uniqueIndex, index } from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    eventId: text("event_id").notNull().unique(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    patientId: text("patient_id"),
    encounterId: text("encounter_id"),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    module: text("module").notNull(),
    payload: jsonb("payload").notNull(),
    siteId: text("site_id").notNull().default("main"),
    idempotencyKey: text("idempotency_key"),
  },
  (t) => [
    uniqueIndex("events_idempotency_key_ux").on(t.idempotencyKey),
    index("events_name_idx").on(t.name),
    index("events_patient_idx").on(t.patientId),
    index("events_correlation_idx").on(t.correlationId),
  ],
);
```

`apps/core/src/kernel/db/schema/index.ts`:
```ts
export * from "./events";
```

`apps/core/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/kernel/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev" },
});
```

- [ ] **Step 2: Client + migration runner**

`apps/core/src/kernel/db/client.ts`:
```ts
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string): { db: Db; pool: Pool } {
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
```

`apps/core/scripts/migrate.ts`:
```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/kernel/db/client";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev";
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  // eslint-disable-next-line no-console
  console.log("migrations applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `pnpm --filter @hmis/core db:generate`
Expected: a SQL file appears in `apps/core/drizzle/` creating `events` with all 16 columns.

Run: `pnpm --filter @hmis/core db:migrate`
Expected: `migrations applied`.

- [ ] **Step 3: Test helper + failing schema test**

`apps/core/test/helpers/db.ts`:
```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { createDb, Db } from "../../src/kernel/db/client";
import type { Pool } from "pg";

export async function setupTestDb(): Promise<{ db: Db; pool: Pool; teardown(): Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_test";
  const { db, pool } = createDb(url);
  await migrate(db, { migrationsFolder: "./drizzle" });
  return { db, pool, teardown: async () => { await pool.end(); } };
}

export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table events restart identity`);
}
```

`apps/core/src/kernel/db/schema/events.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { events } from "./events";
import type { Db } from "../client";
import type { Pool } from "pg";

describe("events table", () => {
  let db: Db; let pool: Pool; let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("inserts a full envelope row and reads it back", async () => {
    await db.insert(events).values({
      eventId: "01TESTULID0000000000000000",
      name: "patient.registered",
      occurredAt: new Date("2026-08-11T10:00:00Z"),
      actorType: "user",
      actorId: "u1",
      module: "registration",
      payload: { uhid: "H0001" },
    });
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("patient.registered");
    expect(rows[0]!.siteId).toBe("main");
    expect(rows[0]!.recordedAt).toBeInstanceOf(Date);
  });

  it("enforces idempotency_key uniqueness", async () => {
    const base = {
      name: "sample.collected", occurredAt: new Date(), actorType: "user", actorId: "u1",
      module: "lab", payload: {}, idempotencyKey: "edge-1",
    };
    await db.insert(events).values({ ...base, eventId: "01A" });
    await expect(db.insert(events).values({ ...base, eventId: "01B" })).rejects.toThrow();
  });
});
```

Run: `pnpm --filter @hmis/core test`
Expected: PASS (migration applied to test DB by helper; both tests green). If it fails, fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add apps/core
git commit -m "feat(core): drizzle infra, events table migration, tx helper, test-db harness"
```

---

### Task 5: appendEvent — the transactional outbox writer

**Files:**
- Create: `apps/core/src/kernel/events/append.ts`
- Test: `apps/core/src/kernel/events/append.test.ts`

**Interfaces:**
- Consumes: `EventInput`, `newEventId` from `@hmis/contracts`; `Tx`, `events` from Task 4.
- Produces (exact, every module calls this): `appendEvent(tx: Tx, input: EventInput): Promise<{ eventId: string; seq: number }>` — inserts within the caller's transaction; on `idempotencyKey` conflict returns the existing row's ids without inserting (idempotent no-op).

- [ ] **Step 1: Failing tests**

`apps/core/src/kernel/events/append.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { appendEvent } from "./append";
import { withTx, Db } from "../db/client";
import { events } from "../db/schema";
import { sql } from "drizzle-orm";

const input = (over: Partial<Parameters<typeof appendEvent>[1]> = {}) => ({
  name: "visit.opened", version: 1, occurredAt: new Date(),
  actor: { type: "user" as const, id: "u1" }, module: "opd",
  payload: { visitId: "v1" }, siteId: "main", ...over,
});

describe("appendEvent", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("writes the event inside the caller's transaction", async () => {
    const { eventId } = await withTx(db, (tx) => appendEvent(tx, input()));
    expect(eventId).toHaveLength(26);
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(1);
  });

  it("rolls back with the enclosing transaction", async () => {
    await expect(
      withTx(db, async (tx) => {
        await appendEvent(tx, input());
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await db.select().from(events);
    expect(rows).toHaveLength(0);
  });

  it("is idempotent on idempotency_key", async () => {
    const a = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    const b = await withTx(db, (tx) => appendEvent(tx, input({ idempotencyKey: "k1" })));
    expect(b.eventId).toBe(a.eventId);
    const [{ count }] = (await db.execute(sql`select count(*)::int as count from events`)).rows as [{ count: number }];
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern append`
Expected: FAIL — `append.ts` not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/events/append.ts`:
```ts
import { newEventId, EventInput } from "@hmis/contracts";
import { sql } from "drizzle-orm";
import { events } from "../db/schema";
import type { Tx } from "../db/client";

export async function appendEvent(
  tx: Tx,
  input: EventInput,
): Promise<{ eventId: string; seq: number }> {
  const eventId = newEventId();
  const inserted = await tx
    .insert(events)
    .values({
      eventId,
      name: input.name,
      version: input.version,
      occurredAt: input.occurredAt,
      actorType: input.actor.type,
      actorId: input.actor.id,
      patientId: input.patientId,
      encounterId: input.encounterId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      module: input.module,
      payload: input.payload,
      siteId: input.siteId,
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing({ target: events.idempotencyKey })
    .returning({ eventId: events.eventId, seq: events.seq });

  if (inserted.length > 0) return inserted[0]!;

  const existing = (await tx.execute(
    sql`select event_id as "eventId", seq from events where idempotency_key = ${input.idempotencyKey}`,
  )).rows as [{ eventId: string; seq: number }];
  return existing[0]!;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern append`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/events
git commit -m "feat(core): appendEvent transactional outbox writer with idempotency"
```

---

### Task 6: NestJS app skeleton + health endpoint

**Files:**
- Create: `apps/core/src/main.ts`, `apps/core/src/app.module.ts`, `apps/core/src/health/health.controller.ts`
- Test: `apps/core/test/health.e2e.test.ts`

**Interfaces:**
- Produces: bootable Nest app (`pnpm --filter @hmis/core start:dev`); `GET /health` → `{ status: "ok", db: "ok" }`; DI token `DB` providing the `Db` instance app-wide.

- [ ] **Step 1: Failing e2e test**

Add deps to `apps/core/package.json` dependencies: `"@nestjs/common": "^11.0.0"`, `"@nestjs/core": "^11.0.0"`, `"@nestjs/platform-express": "^11.0.0"`, `"reflect-metadata": "^0.2.0"`, `"rxjs": "^7.8.0"`; devDependencies: `"@nestjs/testing": "^11.0.0"`, `"supertest": "^7.0.0"`, `"@types/supertest": "^6.0.0"`. Scripts: `"start:dev": "tsx watch src/main.ts"`.

`apps/core/test/health.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_test";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("reports ok with db connectivity", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern health`
Expected: FAIL — `AppModule` not found.

- [ ] **Step 2: Implement**

`apps/core/src/app.module.ts`:
```ts
import { Module, Global } from "@nestjs/common";
import { createDb, Db } from "./kernel/db/client";
import { HealthController } from "./health/health.controller";

export const DB = Symbol("DB");

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: DB,
      useFactory: (): Db => {
        const url = process.env.DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_dev";
        return createDb(url).db;
      },
    },
  ],
  exports: [DB],
})
export class AppModule {}
```

`apps/core/src/health/health.controller.ts`:
```ts
import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DB } from "../app.module";
import type { Db } from "../kernel/db/client";

@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async health(): Promise<{ status: string; db: string }> {
    await this.db.execute(sql`select 1`);
    return { status: "ok", db: "ok" };
  }
}
```

`apps/core/src/main.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
```

Enable decorators: add to `apps/core/tsconfig.json` compilerOptions: `"experimentalDecorators": true, "emitDecoratorMetadata": true`.

- [ ] **Step 3: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern health`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/core
git commit -m "feat(core): NestJS skeleton with DB-checked health endpoint"
```

---

### Task 7: Module framework — manifest + loader

**Files:**
- Create: `apps/core/src/kernel/modules/manifest.ts`, `apps/core/src/kernel/modules/loader.ts`
- Test: `apps/core/src/kernel/modules/loader.test.ts`

**Interfaces:**
- Produces (exact, every feature module implements this):
  - `type ModuleManifest = { key: string; title: string; menu: { label: string; path: string; permission: string }[]; permissions: string[]; subscriptions: { event: string; consumer: string }[] }`
  - `class ModuleRegistry` — `install(m: ModuleManifest): void` (duplicate `key` throws; a subscription to an event name failing the grammar regex throws), `all(): ModuleManifest[]`, `subscriptionsFor(eventName: string): { consumer: string; moduleKey: string }[]`, `allPermissions(): string[]` (deduped).

- [ ] **Step 1: Failing tests**

`apps/core/src/kernel/modules/loader.test.ts`:
```ts
import { ModuleRegistry } from "./loader";
import type { ModuleManifest } from "./manifest";

const reg = (over: Partial<ModuleManifest> = {}): ModuleManifest => ({
  key: "registration",
  title: "Registration",
  menu: [{ label: "New Patient", path: "/registration/new", permission: "registration.create" }],
  permissions: ["registration.create", "registration.read"],
  subscriptions: [],
  ...over,
});

describe("ModuleRegistry", () => {
  it("installs modules and lists permissions deduped", () => {
    const r = new ModuleRegistry();
    r.install(reg());
    r.install(reg({ key: "billing", title: "Billing", permissions: ["billing.create", "registration.read"] }));
    expect(r.all().map((m) => m.key)).toEqual(["registration", "billing"]);
    expect(r.allPermissions().sort()).toEqual(["billing.create", "registration.create", "registration.read"]);
  });

  it("rejects duplicate module keys", () => {
    const r = new ModuleRegistry();
    r.install(reg());
    expect(() => r.install(reg())).toThrow(/duplicate/i);
  });

  it("indexes event subscriptions by event name", () => {
    const r = new ModuleRegistry();
    r.install(reg({ key: "billing", subscriptions: [{ event: "visit.opened", consumer: "billing.autoCharge" }] }));
    expect(r.subscriptionsFor("visit.opened")).toEqual([{ consumer: "billing.autoCharge", moduleKey: "billing" }]);
    expect(r.subscriptionsFor("nothing.happened")).toEqual([]);
  });

  it("rejects subscriptions to malformed event names", () => {
    const r = new ModuleRegistry();
    expect(() =>
      r.install(reg({ subscriptions: [{ event: "BadName", consumer: "x.y" }] })),
    ).toThrow(/event name/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern loader`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/modules/manifest.ts`:
```ts
export type ModuleManifest = {
  key: string;
  title: string;
  menu: { label: string; path: string; permission: string }[];
  permissions: string[];
  subscriptions: { event: string; consumer: string }[];
};
```

`apps/core/src/kernel/modules/loader.ts`:
```ts
import type { ModuleManifest } from "./manifest";

const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class ModuleRegistry {
  private modules = new Map<string, ModuleManifest>();
  private subs = new Map<string, { consumer: string; moduleKey: string }[]>();

  install(m: ModuleManifest): void {
    if (this.modules.has(m.key)) throw new Error(`duplicate module key: ${m.key}`);
    for (const s of m.subscriptions) {
      if (!NAME_RE.test(s.event)) throw new Error(`invalid event name in subscription: ${s.event}`);
    }
    this.modules.set(m.key, m);
    for (const s of m.subscriptions) {
      const list = this.subs.get(s.event) ?? [];
      list.push({ consumer: s.consumer, moduleKey: m.key });
      this.subs.set(s.event, list);
    }
  }

  all(): ModuleManifest[] {
    return [...this.modules.values()];
  }

  subscriptionsFor(eventName: string): { consumer: string; moduleKey: string }[] {
    return this.subs.get(eventName) ?? [];
  }

  allPermissions(): string[] {
    return [...new Set(this.all().flatMap((m) => m.permissions))];
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern loader`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/kernel/modules
git commit -m "feat(core): module manifest type and registry with subscription index"
```

---

### Task 8: Module-isolation lint rule

**Files:**
- Create: `eslint.config.mjs` (root)
- Create: `apps/core/src/modules/.gitkeep`
- Test: fixture files created and deleted within the steps

**Interfaces:**
- Produces: `pnpm lint` (root script) — fails on any import from `src/modules/<a>/**` into `src/modules/<b>/**` internals; modules may import from `src/kernel/**`, `@hmis/contracts`, and another module's `index.ts` (its declared interface) only.

- [ ] **Step 1: Install and configure**

Root devDependencies: `"eslint": "^9.0.0"`, `"typescript-eslint": "^8.0.0"`, `"eslint-plugin-import": "^2.31.0"`.

`eslint.config.mjs`:
```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/drizzle/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["apps/core/src/modules/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["../*/!(index)", "../*/!(index)/**", "**/modules/*/!(index)", "**/modules/*/!(index)/**"],
          message: "Modules may only import another module's index.ts (its declared interface). Cross-module internals are forbidden (spec §4).",
        }],
      }],
    },
  },
);
```

Root `package.json` scripts: add `"lint": "eslint ."` and change `"verify": "pnpm typecheck && pnpm lint && pnpm test"`.

- [ ] **Step 2: Prove the rule fails on a violation**

Create fixtures:
`apps/core/src/modules/alpha/internal.ts` → `export const secret = 1;`
`apps/core/src/modules/alpha/index.ts` → `export const alphaApi = 1;`
`apps/core/src/modules/beta/service.ts` → `import { secret } from "../alpha/internal"; export const b = secret;`

Run: `pnpm lint`
Expected: FAIL — one error on `beta/service.ts` citing the message above.

- [ ] **Step 3: Prove the interface path passes**

Change `apps/core/src/modules/beta/service.ts` to:
```ts
import { alphaApi } from "../alpha/index";
export const b = alphaApi;
```

Run: `pnpm lint`
Expected: PASS.

Delete all fixture files (`alpha/`, `beta/`), keep `apps/core/src/modules/.gitkeep`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: eslint flat config with cross-module isolation rule"
```

---

### Task 9: Outbox dispatcher with per-consumer cursors

**Files:**
- Create: `apps/core/src/kernel/events/subscriptions.ts`, `apps/core/src/kernel/events/dispatcher.ts`
- Create: migration for `event_cursors` table (via schema + `db:generate`)
- Modify: `apps/core/src/kernel/db/schema/index.ts`
- Test: `apps/core/src/kernel/events/dispatcher.test.ts`

**Interfaces:**
- Consumes: `events` table (Task 4), `ModuleRegistry.subscriptionsFor` (Task 7).
- Produces (exact):
  - Schema `eventCursors` — `consumer text PK`, `lastSeq bigint not null default 0`, `updatedAt timestamptz`.
  - `type Handler = (e: { seq: number; eventId: string; name: string; payload: unknown; patientId: string | null; correlationId: string | null }) => Promise<void>`
  - `class SubscriptionBus` — `on(consumer: string, eventName: string, h: Handler)`, `handlersFor(eventName: string): { consumer: string; handler: Handler }[]`
  - `runDispatchCycle(db: Db, bus: SubscriptionBus, batchSize?: number): Promise<number>` — for each registered consumer: reads events with `seq > cursor` matching its event names (ordered by seq, limit batch), invokes handler per event, advances the cursor **only after the handler resolves** (at-least-once; a throwing handler halts that consumer's cursor, other consumers proceed). Returns total events delivered.
  - pg-boss wiring deferred to the deployment plan; this task delivers the cycle function that pg-boss will schedule (interval job).

- [ ] **Step 1: Cursor schema**

Append to `apps/core/src/kernel/db/schema/index.ts` a new file export. Create `apps/core/src/kernel/db/schema/eventCursors.ts`:
```ts
import { pgTable, text, bigint, timestamp } from "drizzle-orm/pg-core";

export const eventCursors = pgTable("event_cursors", {
  consumer: text("consumer").primaryKey(),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

`schema/index.ts` becomes:
```ts
export * from "./events";
export * from "./eventCursors";
```

Run: `pnpm --filter @hmis/core db:generate && pnpm --filter @hmis/core db:migrate`
Expected: new migration; applied. Update `truncateAll` in `test/helpers/db.ts` to also truncate `event_cursors`:
```ts
await db.execute(sql`truncate table events restart identity`);
await db.execute(sql`truncate table event_cursors`);
```

- [ ] **Step 2: Failing dispatcher tests**

`apps/core/src/kernel/events/dispatcher.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { appendEvent } from "./append";
import { SubscriptionBus } from "./subscriptions";
import { runDispatchCycle } from "./dispatcher";
import { withTx, Db } from "../db/client";

const mkInput = (name: string) => ({
  name, version: 1, occurredAt: new Date(),
  actor: { type: "system" as const, id: "test" }, module: "opd",
  payload: { n: name }, siteId: "main",
});

describe("runDispatchCycle", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("delivers matching events once and advances the cursor", async () => {
    const seen: string[] = [];
    const bus = new SubscriptionBus();
    bus.on("billing.autoCharge", "visit.opened", async (e) => { seen.push(e.eventId); });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await withTx(db, (tx) => appendEvent(tx, mkInput("patient.registered")));
    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));

    expect(await runDispatchCycle(db, bus)).toBe(2);
    expect(seen).toHaveLength(2);
    expect(await runDispatchCycle(db, bus)).toBe(0); // nothing redelivered
  });

  it("does not advance the cursor past a failing handler", async () => {
    let calls = 0;
    const bus = new SubscriptionBus();
    bus.on("flaky.consumer", "visit.opened", async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await runDispatchCycle(db, bus); // handler throws; swallowed per-consumer
    expect(calls).toBe(1);
    expect(await runDispatchCycle(db, bus)).toBe(1); // redelivered
    expect(calls).toBe(2);
  });

  it("isolates consumers — one failing consumer does not block another", async () => {
    const okSeen: string[] = [];
    const bus = new SubscriptionBus();
    bus.on("bad.consumer", "visit.opened", async () => { throw new Error("always"); });
    bus.on("good.consumer", "visit.opened", async (e) => { okSeen.push(e.eventId); });

    await withTx(db, (tx) => appendEvent(tx, mkInput("visit.opened")));
    await runDispatchCycle(db, bus);
    expect(okSeen).toHaveLength(1);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern dispatcher`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/events/subscriptions.ts`:
```ts
export type DispatchedEvent = {
  seq: number;
  eventId: string;
  name: string;
  payload: unknown;
  patientId: string | null;
  correlationId: string | null;
};

export type Handler = (e: DispatchedEvent) => Promise<void>;

export class SubscriptionBus {
  private byConsumer = new Map<string, { events: Set<string>; handler: Handler }>();

  on(consumer: string, eventName: string, handler: Handler): void {
    const entry = this.byConsumer.get(consumer);
    if (entry) {
      entry.events.add(eventName);
    } else {
      this.byConsumer.set(consumer, { events: new Set([eventName]), handler });
    }
  }

  consumers(): { consumer: string; events: string[]; handler: Handler }[] {
    return [...this.byConsumer.entries()].map(([consumer, v]) => ({
      consumer, events: [...v.events], handler: v.handler,
    }));
  }
}
```

`apps/core/src/kernel/events/dispatcher.ts`:
```ts
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { SubscriptionBus, DispatchedEvent } from "./subscriptions";

export async function runDispatchCycle(
  db: Db,
  bus: SubscriptionBus,
  batchSize = 100,
): Promise<number> {
  let delivered = 0;

  for (const { consumer, events: names, handler } of bus.consumers()) {
    await db.execute(
      sql`insert into event_cursors (consumer) values (${consumer}) on conflict do nothing`,
    );
    const cursorRows = (await db.execute(
      sql`select last_seq as "lastSeq" from event_cursors where consumer = ${consumer}`,
    )).rows as [{ lastSeq: number | string }];
    let lastSeq = Number(cursorRows[0]!.lastSeq);

    const rows = (await db.execute(sql`
      select seq, event_id as "eventId", name, payload,
             patient_id as "patientId", correlation_id as "correlationId"
      from events
      where seq > ${lastSeq} and name = any(${names})
      order by seq asc
      limit ${batchSize}
    `)).rows as unknown as DispatchedEvent[];

    for (const row of rows) {
      try {
        await handler({ ...row, seq: Number(row.seq) });
      } catch {
        break; // cursor stays; retried next cycle
      }
      lastSeq = Number(row.seq);
      delivered += 1;
      await db.execute(
        sql`update event_cursors set last_seq = ${lastSeq}, updated_at = now() where consumer = ${consumer}`,
      );
    }
  }

  return delivered;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern dispatcher`
Expected: PASS (3 tests).

- [ ] **Step 5: Full suite + commit**

Run: `pnpm verify`
Expected: typecheck, lint, and all tests PASS.

```bash
git add apps/core
git commit -m "feat(core): outbox dispatcher with per-consumer cursors and consumer isolation"
```

---

### Task 10: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Produces: CI running `pnpm verify` with a Postgres 16 service on every push/PR; README with the three commands a new machine needs.

- [ ] **Step 1: Workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: hmis
          POSTGRES_PASSWORD: hmis
          POSTGRES_DB: hmis_test
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U hmis" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      TEST_DATABASE_URL: postgres://hmis:hmis@localhost:5433/hmis_test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm verify
```

- [ ] **Step 2: README**

`README.md`:
```markdown
# HMIS

Agentic hospital operating system. Specs: `docs/superpowers/specs/`.

## Run locally
1. `docker compose -f docker/docker-compose.dev.yml up -d`
2. `pnpm install && pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core start:dev` → http://localhost:3000/health

## Verify (what CI runs)
`pnpm verify`  — typecheck + lint + tests (needs the compose DB up)
```

- [ ] **Step 3: Final verification + commit**

Run: `pnpm verify`
Expected: PASS.

```bash
git add -A
git commit -m "chore: CI workflow (pnpm verify + Postgres service) and README"
```

---

## Self-Review Notes

- **Spec coverage (this plan's slice):** §4 outbox ✓ (Tasks 4–5), §10.5 envelope verbatim incl. occurred/recorded split, site_id, idempotency ✓ (Tasks 3–5), §4 module framework + manifest ✓ (Task 7), §4 lint-enforced isolation ✓ (Task 8), event delivery for module sync ✓ (Task 9), §5 stack choices ✓ (Tasks 1–6), CI as standing verification ✓ (Task 10). Deliberately out of scope here (later plans in the series): RBAC, workflow engine, WebSockets, pg-boss scheduling of the dispatch cycle (deployment plan), catalog population (per-module plans), process split (deployment plan).
- **Type consistency:** `appendEvent(tx, EventInput)` (T5) consumes T3's `EventInput`; dispatcher (T9) consumes T4's `Db` and T5's rows; `ModuleRegistry.subscriptionsFor` (T7) matches the event-name grammar regex used in T3 — one regex, duplicated intentionally in contracts and loader (loader cannot import test-only helpers; both are pinned by tests).
- **Placeholders:** none — every step carries runnable code/commands.
