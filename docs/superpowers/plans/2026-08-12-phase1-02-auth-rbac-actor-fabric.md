# Phase 1 / Plan 02 — Auth, RBAC & Actor Fabric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kernel its actor fabric: config/secrets loader (no more hardcoded fallbacks), users with password/PIN/badge credentials, DB-backed sessions with <2 s shared-terminal fast-switching, permission checks (`action` + `scope`) consuming `ModuleRegistry.allPermissions()`, TOTP step-up for signature/money-class checks, break-glass, SoD hard-pair enforcement, agent actors with kill switches, and emergency role elevation — every exceptional act emitted through `appendEvent`.

**Architecture:** Auth is **shared kernel** (spec §3), not a feature module — it lives under `apps/core/src/kernel/auth/` (the module-isolation lint rule targets `src/modules/**` and is untouched). Identity is table-backed (`users`, `agents`), sessions are opaque bearer tokens hashed at rest in `auth_sessions` (DB lookup per request — multi-process-safe, instantly revocable, per spec's no-in-memory-state rule), and permission resolution is a per-request query over `role_assignments` + active `temp_role_grants`. Secrets follow the owner-approved pattern (roadmap, resolved 2026-08-12): `.env` + zod-validated `loadConfig()` with **zero fallbacks**, and AES-256-GCM sealing under `SECRET_KEY` for DB-held secrets (TOTP seeds). The five catalog events this plan owns (`break_glass.used`, `sod.violation_blocked`, `emergency_elevation.used`, `temp_role.granted`, `temp_role.expired`) are written via `appendEvent` — `sod.violation_blocked` deliberately in its **own** transaction so it survives the caller's rollback.

**Tech Stack:** Everything from Plan 01 (Node 22 · pnpm · TS strict · NestJS ^11 · Postgres 16 · drizzle-orm · zod ^4 · Jest ^29) plus: `argon2` ^0.41 (argon2id password/PIN hashing, prebuilt binaries) · `otplib` ^12 (RFC-6238 TOTP) · `node:crypto` (AES-256-GCM, HMAC — no new dependency).

## Global Constraints (from spec v4.5 + roadmap standing rules)

- TypeScript strict; no `any` in kernel code.
- **This plan adds nothing to the `events` table schema** (gate report §7). It writes its own tables and emits exactly the five catalog events above through `appendEvent` — no invented event names (catalog discipline, §10.6).
- Event names `entity.verb_past`; full §10.5 envelope via `defineEvent(...).make(...)`; `module: "auth"`.
- Permission strings come from `ModuleRegistry.allPermissions()` — auth **consumes the registry, never keeps its own list** (roadmap trap; gate report §3). The `permissions` table is a one-way sync *from* the registry, existing only to give `role_permissions` FK integrity.
- **No config fallbacks.** After Task 1, no `.ts` file may contain a connection string or a `?? "postgres://…"` default. Missing env = loud startup failure.
- No shared accounts (§11.18 lock 6): fast-switch is an **identity change** — a new session for the incoming user, prior sessions on that terminal revoked. Server-side switch budget test-enforced (<2 s end-to-end target; test asserts the handler round-trip < 1000 ms).
- Second factor for signature-class and money-class checks (§14, D-27) is a **guard option** at the route (`{ secondFactor: true }`) — the classes themselves are assigned where later plans declare routes.
- Agents are first-class actors (§16/§14): own credentials, same RBAC path, per-agent kill switch. Fail-open rule does **not** apply to auth — a killed agent is denied, loudly.
- Multi-process-safe: no in-memory session or permission caches. Every check hits Postgres.
- SoD violations are **blocked and evented** (`sod.violation_blocked`, S10 §11) — the event must survive the blocked transaction's rollback.
- VIP/confidential and sealed-class *data* rules arrive with clinical records (Plan 05+); this plan ships the access primitives they will consult (break-glass grants, scope checks).
- Append-only events; corrections via later entered-in-error grammar — never edits.
- Build/test on the server per the roadmap's standing execution rules (shared-host boilerplate goes into every pipeline brief; `.github/workflows/*` is **not touched by this plan** — CI needs no edit because `TEST_DATABASE_URL` is already set in the workflow and test-only secret defaults come from a jest setup file).

## File Structure (locked by this plan)

```
apps/core/
  src/kernel/config.ts                 # loadEnv / requireEnv / loadConfig (zod, no fallbacks)
  src/kernel/crypto.ts                 # tokens, sha256, AES-256-GCM seal/open, HMAC, badge tokens
  src/kernel/auth/events.ts            # the five auth event definitions (defineEvent + zod)
  src/kernel/auth/manifest.ts          # auth ModuleManifest (declares auth.* permissions)
  src/kernel/auth/identity.ts          # users: create, password/PIN verify, badge issue/rotate
  src/kernel/auth/agents.ts            # agent actors: create, key lookup, kill switch
  src/kernel/auth/sessions.ts          # opaque-token sessions; login / switch / revoke
  src/kernel/auth/permissions.ts       # registry sync, roles, assignments, hasPermission
  src/kernel/auth/totp.ts              # TOTP enroll/confirm/verify (sealed seeds), step-up record
  src/kernel/auth/sod.ts               # SoD pair catalog seed + assertNotSodPair
  src/kernel/auth/break-glass.ts       # grants, active check, review queue
  src/kernel/auth/temp-roles.ts        # temp grants, emergency elevation, expiry sweep
  src/kernel/auth/decorators.ts        # @Public, @CurrentActor, @RequirePermission
  src/kernel/auth/guards.ts            # AuthGuard (identity), PermissionGuard (RBAC + step-up + break-glass)
  src/kernel/auth/auth.controller.ts   # /auth/* endpoints
  src/kernel/auth/auth.module.ts       # Nest module: guards as APP_GUARD, boot-time syncs
  src/kernel/db/schema/auth.ts         # all Plan-02 tables (one schema file, one migration)
  scripts/seed-admin.ts                # bootstrap admin user + admin role (env-driven)
  scripts/create-agent.ts              # mint an agent actor + API key (env-driven)
  test/helpers/env.ts                  # jest setupFile: .env load + test-only secret defaults
```

Modified (exact new contents shown in tasks): root `package.json` (no change needed), `apps/core/package.json` (deps/scripts), `apps/core/jest.config.cjs` (setupFiles), `apps/core/.env.example`, `apps/core/drizzle.config.ts`, `apps/core/scripts/migrate.ts`, `apps/core/scripts/db-check.ts`, `apps/core/src/app.module.ts`, `apps/core/src/main.ts`, `apps/core/src/health/health.controller.ts` (gains `@Public`), `apps/core/test/helpers/db.ts`, `apps/core/test/health.e2e.test.ts`, `packages/contracts/src/ids.ts` (adds `newId()`), `apps/core/src/kernel/db/schema/index.ts`.

**Sequencing:** Tasks are strictly ordered 1→12 (many touch `auth.module.ts`/`guards.ts` cumulatively). Pipeline waves must not parallelize tasks that share files — practically, run them sequentially.

---

### Task 1: Config loader — retire every hardcoded fallback

**Files:**
- Create: `apps/core/src/kernel/config.ts`, `apps/core/test/helpers/env.ts`
- Modify: `apps/core/package.json` (add `zod`), `apps/core/jest.config.cjs`, `apps/core/.env.example`, `apps/core/drizzle.config.ts`, `apps/core/scripts/migrate.ts`, `apps/core/scripts/db-check.ts`, `apps/core/test/helpers/db.ts`, `apps/core/test/health.e2e.test.ts`
- Test: `apps/core/src/kernel/config.test.ts`
- Server-only (not committed): create `/opt/hmis/apps/core/.env` from the example, `chmod 600`

**Interfaces:**
- Consumes: nothing new.
- Produces (exact, every later task and plan uses these):
  - `loadEnv(): void` — loads `<cwd>/.env` once via `node:util` `parseEnv`; **existing environment always wins** (CI stays authoritative).
  - `requireEnv(name: string): string` — throws `missing required env var <name>` when unset/empty.
  - `type AppConfig = { databaseUrl: string; port: number; secretKey: Buffer; sessionTtlMinutes: number; secondFactorWindowMinutes: number; breakGlassTtlMinutes: number; tempRoleMaxTtlMinutes: number }`
  - `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` — zod-validated; `SECRET_KEY` must be 64 hex chars (32 bytes); throws on any missing/invalid value.

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/config.test.ts`:
```ts
import { loadConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@host:5433/db",
  SECRET_KEY: "ab".repeat(32),
};

describe("loadConfig", () => {
  it("parses a minimal env and applies defaults", () => {
    const cfg = loadConfig(base);
    expect(cfg.databaseUrl).toBe(base.DATABASE_URL);
    expect(cfg.port).toBe(3000);
    expect(cfg.sessionTtlMinutes).toBe(720);
    expect(cfg.secondFactorWindowMinutes).toBe(5);
    expect(cfg.breakGlassTtlMinutes).toBe(60);
    expect(cfg.tempRoleMaxTtlMinutes).toBe(720);
    expect(cfg.secretKey).toBeInstanceOf(Buffer);
    expect(cfg.secretKey.length).toBe(32);
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({ SECRET_KEY: base.SECRET_KEY })).toThrow();
  });

  it("throws when SECRET_KEY is not 64 hex chars", () => {
    expect(() => loadConfig({ ...base, SECRET_KEY: "deadbeef" })).toThrow(/SECRET_KEY/);
  });

  it("honours numeric overrides", () => {
    const cfg = loadConfig({ ...base, PORT: "4000", SESSION_TTL_MINUTES: "60" });
    expect(cfg.port).toBe(4000);
    expect(cfg.sessionTtlMinutes).toBe(60);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern config`
Expected: FAIL — `./config` not found.

- [ ] **Step 3: Implement**

Add to `apps/core/package.json` dependencies: `"zod": "^4.0.0"`.

`apps/core/src/kernel/config.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";

let envLoaded = false;

/** Loads <cwd>/.env once. Existing process.env values always win (CI stays authoritative). */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  const candidate = resolve(process.cwd(), ".env");
  if (!existsSync(candidate)) return;
  const parsed = parseEnv(readFileSync(candidate, "utf8")) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] ??= value;
  }
}

export function requireEnv(name: string): string {
  loadEnv();
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  SECRET_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "SECRET_KEY must be 64 lowercase hex chars (32 bytes)"),
  SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(720),
  SECOND_FACTOR_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),
  BREAK_GLASS_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  TEMP_ROLE_MAX_TTL_MINUTES: z.coerce.number().int().positive().default(720),
});

export type AppConfig = {
  databaseUrl: string;
  port: number;
  secretKey: Buffer;
  sessionTtlMinutes: number;
  secondFactorWindowMinutes: number;
  breakGlassTtlMinutes: number;
  tempRoleMaxTtlMinutes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env) loadEnv();
  const parsed = configSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    port: parsed.PORT,
    secretKey: Buffer.from(parsed.SECRET_KEY, "hex"),
    sessionTtlMinutes: parsed.SESSION_TTL_MINUTES,
    secondFactorWindowMinutes: parsed.SECOND_FACTOR_WINDOW_MINUTES,
    breakGlassTtlMinutes: parsed.BREAK_GLASS_TTL_MINUTES,
    tempRoleMaxTtlMinutes: parsed.TEMP_ROLE_MAX_TTL_MINUTES,
  };
}
```

`apps/core/test/helpers/env.ts` (jest setupFile — runs before every suite):
```ts
import { loadEnv } from "../../src/kernel/config";

loadEnv();
// Test-only secret defaults. Never used outside jest; real values come from the environment.
process.env.SECRET_KEY ??= "0".repeat(64);
```

`apps/core/jest.config.cjs` becomes:
```js
module.exports = { preset: "ts-jest", testEnvironment: "node", testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"], testTimeout: 15000, setupFiles: ["<rootDir>/test/helpers/env.ts"] };
```

- [ ] **Step 4: Retire the fallbacks (exact new contents)**

`apps/core/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";
import { requireEnv } from "./src/kernel/config";

export default defineConfig({
  schema: "./src/kernel/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: requireEnv("DATABASE_URL") },
});
```

`apps/core/scripts/migrate.ts`:
```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("migrations applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

`apps/core/scripts/db-check.ts`:
```ts
import { Client } from "pg";
import { requireEnv } from "../src/kernel/config";

async function main(): Promise<void> {
  const client = new Client({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();
  const res = await client.query("select version()");
  console.log(res.rows[0].version);
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

In `apps/core/test/helpers/db.ts` replace the line
```ts
  const baseUrl = process.env.TEST_DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_test";
```
with
```ts
  const baseUrl = requireEnv("TEST_DATABASE_URL");
```
and add `import { requireEnv } from "../../src/kernel/config";` to its imports. Everything else in the helper stays byte-identical (per-worker DB creation is gated work — do not restructure it).

In `apps/core/test/health.e2e.test.ts` replace
```ts
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://hmis:hmis@localhost:5433/hmis_test";
```
with
```ts
    process.env.DATABASE_URL = requireEnv("TEST_DATABASE_URL");
```
and add `import { requireEnv } from "../src/kernel/config";`.

`apps/core/.env.example` becomes:
```
# Copy to apps/core/.env (git-ignored; chmod 600 on the server). Existing env vars always win.
DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_dev
TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_test
# 32 bytes hex. Generate: openssl rand -hex 32
# Dev/test key only — the production key is generated and escrowed in Plan 11 (spec E-2).
SECRET_KEY=
PORT=3000
SESSION_TTL_MINUTES=720
SECOND_FACTOR_WINDOW_MINUTES=5
BREAK_GLASS_TTL_MINUTES=60
TEMP_ROLE_MAX_TTL_MINUTES=720
# Used only by scripts/seed-admin.ts and scripts/create-agent.ts:
ADMIN_USERNAME=
ADMIN_PASSWORD=
ADMIN_FULL_NAME=
AGENT_NAME=
```

**Server-only step (not committed):** on `/opt/hmis`, create `apps/core/.env` from the example with the real dev/test URLs, `SECRET_KEY=$(openssl rand -hex 32)`, and `chmod 600 apps/core/.env`. `.gitignore` already ignores `.env`.

Note: `app.module.ts` still carries its fallback after this task — it is rewritten in Task 2 (single owner per file per task).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm install && pnpm --filter @hmis/core test -- --testPathPattern config`
Expected: PASS (4 tests).

Run: `pnpm verify`
Expected: PASS — the full suite still green (the setupFile + server `.env` supply what the retired fallbacks used to).

Run: `grep -rn "postgres://hmis" apps/core/src apps/core/scripts apps/core/test apps/core/drizzle.config.ts || echo CLEAN`
Expected: the only remaining hit is `apps/core/src/app.module.ts` (removed in Task 2). After Task 2 this grep prints `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add apps/core packages pnpm-lock.yaml
git commit -m "feat(core): zod-validated config loader; retire hardcoded connection-string fallbacks"
```

---

### Task 2: AppModule lifecycle — config-driven DB provider, pool closed on shutdown

Closes gate-report open item 2b: the `pg` Pool created by the `DB` factory is never ended, which leaves the *"A worker process has failed to exit gracefully"* warning in the Nest e2e run.

**Files:**
- Create: `apps/core/src/kernel/tokens.ts`
- Modify: `apps/core/src/app.module.ts`, `apps/core/src/main.ts`, `apps/core/src/health/health.controller.ts`
- Test: `apps/core/test/health.e2e.test.ts` (extended)

**Interfaces:**
- Consumes: `loadConfig`, `AppConfig` (Task 1); `createDb` (Plan 01).
- Produces (exact, later tasks inject these):
  - `kernel/tokens.ts` exporting DI tokens `DB` (unchanged meaning: the `Db` instance), `DB_POOL` (`pg.Pool`), `CONFIG` (`AppConfig`). **Tokens live outside `app.module.ts` deliberately**: `AppModule` imports every controller/guard, and those inject the tokens — tokens-in-app-module makes each such import circular, which CJS resolves as `undefined` at decorator-evaluation time. `AppModule` re-exports the tokens (so `import { DB } from "../src/app.module"` keeps working), stays `@Global`, and provides all three.
  - `AppModule implements OnModuleDestroy` — `app.close()` ends the pool.

- [ ] **Step 1: Extend the e2e test (failing first)**

`apps/core/test/health.e2e.test.ts` becomes:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import type { Pool } from "pg";
import { AppModule, DB_POOL } from "../src/app.module";
import { requireEnv } from "../src/kernel/config";

describe("GET /health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = requireEnv("TEST_DATABASE_URL");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => { try { await app.close(); } catch { /* already closed by the pool test */ } });

  it("reports ok with db connectivity", async () => {
    const res = await request(app.getHttpServer()).get("/health").expect(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });

  it("closes the pg pool when the app closes", async () => {
    const pool = app.get<Pool>(DB_POOL);
    await app.close();
    expect(pool.ended).toBe(true);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern health`
Expected: FAIL — `DB_POOL` is not exported.

- [ ] **Step 2: Implement**

`apps/core/src/kernel/tokens.ts` (new):
```ts
// DI tokens live here, not in app.module.ts: AppModule imports the controllers and
// guards that inject these tokens, so token-in-app-module is a circular import that
// CJS resolves to `undefined` at decorator time. This module imports nothing.
export const DB = Symbol("DB");
export const DB_POOL = Symbol("DB_POOL");
export const CONFIG = Symbol("CONFIG");
```

In `apps/core/src/health/health.controller.ts`, change the `DB` import from `"../app.module"` to `import { DB } from "../kernel/tokens";` — nothing else in the controller changes.

`apps/core/src/app.module.ts` becomes:
```ts
import { Module, Global, Inject, OnModuleDestroy } from "@nestjs/common";
import type { Pool } from "pg";
import { createDb, Db } from "./kernel/db/client";
import { loadConfig, AppConfig } from "./kernel/config";
import { DB, DB_POOL, CONFIG } from "./kernel/tokens";
import { HealthController } from "./health/health.controller";

export { DB, DB_POOL, CONFIG } from "./kernel/tokens";

type DbBundle = { db: Db; pool: Pool };
const DB_BUNDLE = Symbol("DB_BUNDLE");

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    { provide: CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: DB_BUNDLE,
      useFactory: (cfg: AppConfig): DbBundle => createDb(cfg.databaseUrl),
      inject: [CONFIG],
    },
    { provide: DB, useFactory: (b: DbBundle): Db => b.db, inject: [DB_BUNDLE] },
    { provide: DB_POOL, useFactory: (b: DbBundle): Pool => b.pool, inject: [DB_BUNDLE] },
  ],
  exports: [DB, DB_POOL, CONFIG],
})
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.pool.ended) await this.pool.end();
  }
}
```

`apps/core/src/main.ts` becomes:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadConfig } from "./kernel/config";

async function bootstrap(): Promise<void> {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(cfg.port);
}
void bootstrap();
```

Note: `loadConfig()` now hard-fails at boot when `DATABASE_URL`/`SECRET_KEY` are absent — that is the intended behavior (Global Constraints).

- [ ] **Step 3: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern health`
Expected: PASS (2 tests) — and the jest output for this suite **no longer prints** "A worker process has failed to exit gracefully".

Run: `grep -rn "postgres://hmis" apps/core/src apps/core/scripts apps/core/test apps/core/drizzle.config.ts || echo CLEAN`
Expected: `CLEAN`.

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/core
git commit -m "feat(core): config-driven DI providers; close pg pool on shutdown (gate item 2b)"
```

---

### Task 3: Kernel crypto — sealing, HMAC, tokens (+ `newId()` in contracts)

The HMAC utility is pulled forward from Plan 05 by owner decision (2026-08-12): badge fast-switch tokens need it now; Plan 05's signed QR consumes the same functions.

**Files:**
- Create: `apps/core/src/kernel/crypto.ts`
- Modify: `packages/contracts/src/ids.ts`
- Test: `apps/core/src/kernel/crypto.test.ts`, `packages/contracts/test/ids.test.ts`

**Interfaces:**
- Consumes: `AppConfig.secretKey` (Task 1) at call sites — every function here takes the key as a `Buffer` parameter (pure, no config import).
- Produces (exact):
  - contracts: `newId(): string` — ULID for entity ids (same grammar as event ids; one id shape everywhere).
  - `randomToken(): string` — 32 random bytes, base64url (session tokens, agent API keys).
  - `sha256Hex(input: string): string` — at-rest hash for tokens/keys.
  - `sealSecret(key: Buffer, plaintext: string): string` / `openSecret(key: Buffer, sealed: string): string` — AES-256-GCM, format `v1.<iv>.<tag>.<ct>` (base64url parts); tamper or wrong key throws.
  - `hmacSign(key: Buffer, payload: string): string` / `hmacVerify(key: Buffer, payload: string, signature: string): boolean` — HMAC-SHA256, timing-safe compare (Plan 05 consumes these for signed QR).
  - `makeBadgeToken(key: Buffer, userId: string, badgeVersion: number): string` — `b1.<userId>.<version>.<sig>`; `parseBadgeToken(key: Buffer, token: string): { userId: string; badgeVersion: number } | null`.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/test/ids.test.ts`:
```ts
import { newId, newEventId } from "../src/ids";

describe("ids", () => {
  it("newId returns a 26-char ULID", () => {
    expect(newId()).toHaveLength(26);
    expect(newId()).not.toBe(newId());
  });
  it("newEventId is still exported and ULID-shaped", () => {
    expect(newEventId()).toHaveLength(26);
  });
});
```

`apps/core/src/kernel/crypto.test.ts`:
```ts
import {
  randomToken, sha256Hex, sealSecret, openSecret,
  hmacSign, hmacVerify, makeBadgeToken, parseBadgeToken,
} from "./crypto";

const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 8);

describe("kernel crypto", () => {
  it("randomToken is unique and url-safe", () => {
    const t = randomToken();
    expect(t).not.toBe(randomToken());
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("sha256Hex is deterministic hex", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seals and opens a secret round-trip", () => {
    const sealed = sealSecret(key, "JBSWY3DPEHPK3PXP");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(openSecret(key, sealed)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects tampered or wrong-key ciphertext", () => {
    const sealed = sealSecret(key, "secret");
    expect(() => openSecret(otherKey, sealed)).toThrow();
    const parts = sealed.split(".");
    parts[3] = parts[3]!.slice(0, -2) + "AA";
    expect(() => openSecret(key, parts.join("."))).toThrow();
  });

  it("hmac verifies only the exact payload and key", () => {
    const sig = hmacSign(key, "payload");
    expect(hmacVerify(key, "payload", sig)).toBe(true);
    expect(hmacVerify(key, "payload2", sig)).toBe(false);
    expect(hmacVerify(otherKey, "payload", sig)).toBe(false);
    expect(hmacVerify(key, "payload", "not-a-sig")).toBe(false);
  });

  it("badge tokens round-trip and reject tampering", () => {
    const token = makeBadgeToken(key, "01HUSER00000000000000000A", 3);
    expect(parseBadgeToken(key, token)).toEqual({ userId: "01HUSER00000000000000000A", badgeVersion: 3 });
    expect(parseBadgeToken(otherKey, token)).toBeNull();
    expect(parseBadgeToken(key, token.replace(".3.", ".4."))).toBeNull();
    expect(parseBadgeToken(key, "garbage")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/contracts test && pnpm --filter @hmis/core test -- --testPathPattern crypto`
Expected: FAIL — `newId` not exported; `./crypto` not found.

- [ ] **Step 3: Implement**

`packages/contracts/src/ids.ts` becomes:
```ts
import { ulid } from "ulid";

export function newEventId(): string {
  return ulid();
}

/** Entity ids (users, sessions, grants, …) share the event-id grammar: one ULID everywhere. */
export function newId(): string {
  return ulid();
}
```

`apps/core/src/kernel/crypto.ts`:
```ts
import {
  createCipheriv, createDecipheriv, createHash, createHmac,
  randomBytes, timingSafeEqual,
} from "node:crypto";

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sealSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function openSecret(key: Buffer, sealed: string): string {
  const [v, ivPart, tagPart, ctPart] = sealed.split(".");
  if (v !== "v1" || !ivPart || !tagPart || !ctPart) throw new Error("malformed sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
}

export function hmacSign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function hmacVerify(key: Buffer, payload: string, signature: string): boolean {
  const expected = Buffer.from(hmacSign(key, payload));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function makeBadgeToken(key: Buffer, userId: string, badgeVersion: number): string {
  const body = `b1.${userId}.${badgeVersion}`;
  return `${body}.${hmacSign(key, body)}`;
}

export function parseBadgeToken(
  key: Buffer,
  token: string,
): { userId: string; badgeVersion: number } | null {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "b1") return null;
  const [prefix, userId, versionPart, sig] = parts as [string, string, string, string];
  if (!hmacVerify(key, `${prefix}.${userId}.${versionPart}`, sig)) return null;
  const badgeVersion = Number(versionPart);
  if (!Number.isInteger(badgeVersion) || badgeVersion < 0 || userId === "") return null;
  return { userId, badgeVersion };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/contracts test && pnpm --filter @hmis/core test -- --testPathPattern crypto`
Expected: PASS (contracts: 7 tests across 3 suites; crypto: 6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts apps/core/src/kernel/crypto.ts apps/core/src/kernel/crypto.test.ts
git commit -m "feat(kernel): crypto primitives (AES-GCM sealing, HMAC, badge tokens) + contracts newId()"
```

---

### Task 4: Auth schema — one migration for the whole actor fabric

**Files:**
- Create: `apps/core/src/kernel/db/schema/auth.ts`
- Modify: `apps/core/src/kernel/db/schema/index.ts`, `apps/core/test/helpers/db.ts` (truncate list)
- Create: generated migration in `apps/core/drizzle/` (via `db:generate` — filename is auto-named, do not hand-write it)
- Test: `apps/core/src/kernel/db/schema/auth.test.ts`

**Interfaces:**
- Consumes: drizzle helpers (Plan 01).
- Produces (exact drizzle exports later tasks import from `../db/schema`): `users`, `roles`, `permissions`, `rolePermissions`, `roleAssignments`, `authSessions`, `agents`, `userTotp`, `sodPairs`, `tempRoleGrants`, `breakGlassGrants`.
- **This task does not touch the `events` table** (gate report §7).

- [ ] **Step 1: Schema**

`apps/core/src/kernel/db/schema/auth.ts`:
```ts
import {
  pgTable, text, integer, boolean, timestamp, primaryKey, index, uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    fullName: text("full_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    pinHash: text("pin_hash"),
    badgeVersion: integer("badge_version").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_username_ux").on(t.username)],
);

export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One-way mirror of ModuleRegistry.allPermissions() — exists only for FK integrity.
export const permissions = pgTable("permissions", {
  permission: text("permission").primaryKey(),
  module: text("module").notNull(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key").notNull().references(() => roles.key),
    permission: text("permission").notNull().references(() => permissions.permission),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permission] })],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    roleKey: text("role_key").notNull().references(() => roles.key),
    scopeType: text("scope_type").notNull(), // 'hospital' | 'floor' | 'department'
    scopeId: text("scope_id"), // null for hospital scope; opaque code until org masters exist
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("role_assignments_user_idx").on(t.userId)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    terminalId: text("terminal_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_ux").on(t.tokenHash),
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_terminal_idx").on(t.terminalId),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    apiKeyHash: text("api_key_hash").notNull(),
    killSwitch: boolean("kill_switch").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agents_name_ux").on(t.name), uniqueIndex("agents_key_ux").on(t.apiKeyHash)],
);

export const userTotp = pgTable("user_totp", {
  userId: text("user_id").primaryKey().references(() => users.id),
  secretSealed: text("secret_sealed").notNull(), // AES-256-GCM sealed; never plaintext at rest
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
});

export const sodPairs = pgTable("sod_pairs", {
  pairKey: text("pair_key").primaryKey(),
  description: text("description").notNull(),
});

export const tempRoleGrants = pgTable(
  "temp_role_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    roleKey: text("role_key").notNull().references(() => roles.key),
    grantedBy: text("granted_by").notNull(), // actor id; equals userId on emergency self-elevation
    kind: text("kind").notNull(), // 'granted' | 'emergency'
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    expiredEventAt: timestamp("expired_event_at", { withTimezone: true }), // set when temp_role.expired emitted
  },
  (t) => [index("temp_role_grants_user_idx").on(t.userId), index("temp_role_grants_expiry_idx").on(t.expiresAt)],
);

export const breakGlassGrants = pgTable(
  "break_glass_grants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    patientId: text("patient_id"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
  },
  (t) => [index("break_glass_user_idx").on(t.userId), index("break_glass_review_idx").on(t.reviewedAt)],
);
```

`apps/core/src/kernel/db/schema/index.ts` becomes:
```ts
export * from "./events";
export * from "./eventCursors";
export * from "./eventIdempotency";
export * from "./auth";
```

Run: `pnpm --filter @hmis/core db:generate && pnpm --filter @hmis/core db:migrate`
Expected: one new migration (0003_*) creating all eleven tables; `migrations applied`.

- [ ] **Step 2: Extend `truncateAll`**

In `apps/core/test/helpers/db.ts`, `truncateAll` becomes:
```ts
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(sql`truncate table events restart identity`);
  await db.execute(sql`truncate table event_cursors`);
  await db.execute(sql`truncate table event_idempotency`);
  await db.execute(
    sql`truncate table break_glass_grants, temp_role_grants, user_totp, auth_sessions,
        role_assignments, role_permissions, agents, sod_pairs, permissions, roles, users`,
  );
}
```
(One statement for the FK-linked auth tables — `truncate a, b, c` is FK-safe when every referenced table is in the list.)

- [ ] **Step 3: Failing schema test, then pass**

`apps/core/src/kernel/db/schema/auth.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { users, roles, permissions, rolePermissions } from "./auth";
import type { Db } from "../client";

describe("auth tables", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("round-trips a user with defaults", async () => {
    await db.insert(users).values({
      id: "01HUSER00000000000000000A",
      username: "asha",
      fullName: "Asha K",
      passwordHash: "x",
    });
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.badgeVersion).toBe(0);
    expect(rows[0]!.active).toBe(true);
  });

  it("enforces username uniqueness", async () => {
    const base = { username: "asha", fullName: "Asha K", passwordHash: "x" };
    await db.insert(users).values({ ...base, id: "01A" });
    await expect(db.insert(users).values({ ...base, id: "01B" })).rejects.toThrow();
  });

  it("role_permissions requires a synced permission row (FK)", async () => {
    await db.insert(roles).values({ key: "cashier", title: "Cashier" });
    await expect(
      db.insert(rolePermissions).values({ roleKey: "cashier", permission: "billing.collect" }),
    ).rejects.toThrow();
    await db.insert(permissions).values({ permission: "billing.collect", module: "billing" });
    await db.insert(rolePermissions).values({ roleKey: "cashier", permission: "billing.collect" });
    const rows = await db.select().from(rolePermissions);
    expect(rows).toHaveLength(1);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "schema/auth"`
Expected: PASS (3 tests). (The per-worker test databases pick the new migration up automatically via `setupTestDb`.)

- [ ] **Step 4: Full suite + commit**

Run: `pnpm verify`
Expected: PASS.

```bash
git add apps/core
git commit -m "feat(core): auth schema — users, roles, permissions mirror, sessions, agents, sod, grants"
```

---

### Task 5: Identity — users, argon2 password/PIN, badge issue/rotate

**Files:**
- Create: `apps/core/src/kernel/auth/identity.ts`
- Modify: `apps/core/package.json` (add `argon2`)
- Test: `apps/core/src/kernel/auth/identity.test.ts`

**Interfaces:**
- Consumes: `users` (Task 4), crypto (Task 3), `newId` (contracts), `Db` (Plan 01), `AppConfig` (Task 1).
- Produces (exact):
  - `createUser(db: Db, input: { username: string; fullName: string; password: string; pin?: string }): Promise<{ id: string }>` — argon2id hashes; duplicate username rejects (DB unique).
  - `verifyPassword(db: Db, username: string, password: string): Promise<{ userId: string } | null>` — null on unknown/inactive user or bad password.
  - `setPin(db: Db, userId: string, pin: string): Promise<void>`
  - `verifyPin(db: Db, userId: string, pin: string): Promise<boolean>`
  - `rotateBadge(db: Db, cfg: AppConfig, userId: string): Promise<{ badgeToken: string; badgeVersion: number }>` — increments `badgeVersion` (old badges die instantly).
  - `resolveBadge(db: Db, cfg: AppConfig, badgeToken: string): Promise<{ userId: string } | null>` — signature + current version + active user.
  - `deactivateUser(db: Db, userId: string): Promise<void>` (exit-workflow hook, S10 mech 3).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/auth/identity.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  createUser, verifyPassword, setPin, verifyPin, rotateBadge, resolveBadge, deactivateUser,
} from "./identity";
import { loadConfig } from "../config";
import type { Db } from "../db/client";

const cfg = loadConfig({
  DATABASE_URL: "postgres://unused",
  SECRET_KEY: process.env.SECRET_KEY!,
});

describe("identity", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates a user and verifies the password", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass" });
    expect(id).toHaveLength(26);
    expect(await verifyPassword(db, "asha", "s3cret-pass")).toEqual({ userId: id });
    expect(await verifyPassword(db, "asha", "wrong")).toBeNull();
    expect(await verifyPassword(db, "nobody", "s3cret-pass")).toBeNull();
  });

  it("rejects duplicate usernames", async () => {
    await createUser(db, { username: "asha", fullName: "A", password: "p1234567" });
    await expect(createUser(db, { username: "asha", fullName: "B", password: "p1234567" })).rejects.toThrow();
  });

  it("verifies a PIN set after creation", async () => {
    const { id } = await createUser(db, { username: "ravi", fullName: "Ravi", password: "p1234567" });
    expect(await verifyPin(db, id, "482913")).toBe(false); // no pin yet
    await setPin(db, id, "482913");
    expect(await verifyPin(db, id, "482913")).toBe(true);
    expect(await verifyPin(db, id, "000000")).toBe(false);
  });

  it("issues and rotates badge tokens", async () => {
    const { id } = await createUser(db, { username: "meena", fullName: "Meena", password: "p1234567" });
    const first = await rotateBadge(db, cfg, id);
    expect(first.badgeVersion).toBe(1);
    expect(await resolveBadge(db, cfg, first.badgeToken)).toEqual({ userId: id });
    const second = await rotateBadge(db, cfg, id);
    expect(second.badgeVersion).toBe(2);
    expect(await resolveBadge(db, cfg, first.badgeToken)).toBeNull(); // old badge dead
    expect(await resolveBadge(db, cfg, second.badgeToken)).toEqual({ userId: id });
  });

  it("inactive users fail every credential path", async () => {
    const { id } = await createUser(db, { username: "gone", fullName: "Gone", password: "p1234567", pin: "112233" });
    const badge = await rotateBadge(db, cfg, id);
    await deactivateUser(db, id);
    expect(await verifyPassword(db, "gone", "p1234567")).toBeNull();
    expect(await verifyPin(db, id, "112233")).toBe(false);
    expect(await resolveBadge(db, cfg, badge.badgeToken)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern identity`
Expected: FAIL — `./identity` not found.

- [ ] **Step 3: Implement**

Add to `apps/core/package.json` dependencies: `"argon2": "^0.41.0"`.

`apps/core/src/kernel/auth/identity.ts`:
```ts
import argon2 from "argon2";
import { eq, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { users } from "../db/schema";
import { makeBadgeToken, parseBadgeToken } from "../crypto";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

// OWASP-baseline argon2id. PIN verification rides the same params and must stay
// inside the <2 s fast-switch budget (perf-tested in Task 7).
const ARGON2_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export async function createUser(
  db: Db,
  input: { username: string; fullName: string; password: string; pin?: string },
): Promise<{ id: string }> {
  const id = newId();
  const passwordHash = await argon2.hash(input.password, ARGON2_OPTS);
  const pinHash = input.pin === undefined ? null : await argon2.hash(input.pin, ARGON2_OPTS);
  await db.insert(users).values({
    id,
    username: input.username,
    fullName: input.fullName,
    passwordHash,
    pinHash,
  });
  return { id };
}

export async function verifyPassword(
  db: Db,
  username: string,
  password: string,
): Promise<{ userId: string } | null> {
  const rows = await db.select().from(users).where(eq(users.username, username));
  const user = rows[0];
  if (!user || !user.active) return null;
  const ok = await argon2.verify(user.passwordHash, password);
  return ok ? { userId: user.id } : null;
}

export async function setPin(db: Db, userId: string, pin: string): Promise<void> {
  const pinHash = await argon2.hash(pin, ARGON2_OPTS);
  await db.update(users).set({ pinHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function verifyPin(db: Db, userId: string, pin: string): Promise<boolean> {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (!user || !user.active || user.pinHash === null) return false;
  return argon2.verify(user.pinHash, pin);
}

export async function rotateBadge(
  db: Db,
  cfg: AppConfig,
  userId: string,
): Promise<{ badgeToken: string; badgeVersion: number }> {
  const rows = await db
    .update(users)
    .set({ badgeVersion: sql<number>`${users.badgeVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning({ badgeVersion: users.badgeVersion });
  const badgeVersion = rows[0]!.badgeVersion;
  return { badgeToken: makeBadgeToken(cfg.secretKey, userId, badgeVersion), badgeVersion };
}

export async function resolveBadge(
  db: Db,
  cfg: AppConfig,
  badgeToken: string,
): Promise<{ userId: string } | null> {
  const parsed = parseBadgeToken(cfg.secretKey, badgeToken);
  if (!parsed) return null;
  const rows = await db.select().from(users).where(eq(users.id, parsed.userId));
  const user = rows[0];
  if (!user || !user.active || user.badgeVersion !== parsed.badgeVersion) return null;
  return { userId: user.id };
}

export async function deactivateUser(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ active: false, updatedAt: new Date() }).where(eq(users.id, userId));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern identity`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core pnpm-lock.yaml
git commit -m "feat(auth): user identity — argon2id password/PIN, rotatable HMAC badge tokens"
```

---

### Task 6: Sessions + agent actors (libraries)

**Files:**
- Create: `apps/core/src/kernel/auth/sessions.ts`, `apps/core/src/kernel/auth/agents.ts`, `apps/core/scripts/create-agent.ts`
- Test: `apps/core/src/kernel/auth/sessions.test.ts`, `apps/core/src/kernel/auth/agents.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5; `authSessions`, `agents` tables (Task 4).
- Produces (exact):
  - `type LiveSession = { sessionId: string; userId: string; terminalId: string | null; secondFactorAt: Date | null }`
  - `createSession(db: Db, cfg: AppConfig, userId: string, terminalId?: string): Promise<{ token: string; sessionId: string }>` — opaque token returned once; only `sha256Hex(token)` stored.
  - `findLiveSession(db: Db, token: string): Promise<LiveSession | null>` — null when unknown, expired, or revoked.
  - `revokeSession(db: Db, sessionId: string): Promise<void>`
  - `revokeUserSessions(db: Db, userId: string): Promise<number>` — the S10 exit-workflow same-hour-revoke hook.
  - `revokeTerminalSessions(db: Db, terminalId: string): Promise<number>`
  - `loginWithPassword(db: Db, cfg: AppConfig, input: { username: string; password: string; terminalId?: string }): Promise<{ token: string } | null>`
  - `switchWithPin(db: Db, cfg: AppConfig, input: { username: string; pin: string; terminalId: string }): Promise<{ token: string } | null>` — **identity change**: revokes every live session on that terminal, then creates the incoming user's session.
  - `switchWithBadge(db: Db, cfg: AppConfig, input: { badgeToken: string; terminalId: string }): Promise<{ token: string } | null>` — same semantics via badge.
  - `createAgent(db: Db, name: string): Promise<{ id: string; apiKey: string }>` — key returned once; only its hash stored.
  - `findAgentByKey(db: Db, apiKey: string): Promise<{ id: string; name: string; killSwitch: boolean } | null>`
  - `setKillSwitch(db: Db, agentId: string, on: boolean): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/auth/sessions.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser, setPin, rotateBadge } from "./identity";
import {
  createSession, findLiveSession, revokeSession, revokeUserSessions,
  loginWithPassword, switchWithPin, switchWithBadge,
} from "./sessions";
import { loadConfig } from "../config";
import { authSessions } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("sessions", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  async function mkUser(username = "asha"): Promise<string> {
    const { id } = await createUser(db, { username, fullName: "U", password: "s3cret-pass" });
    return id;
  }

  it("creates and finds a live session by opaque token", async () => {
    const userId = await mkUser();
    const { token, sessionId } = await createSession(db, cfg, userId, "counter-1");
    const live = await findLiveSession(db, token);
    expect(live).toEqual({ sessionId, userId, terminalId: "counter-1", secondFactorAt: null });
    expect(await findLiveSession(db, "not-a-token")).toBeNull();
  });

  it("revoked and expired sessions are not live", async () => {
    const userId = await mkUser();
    const { token, sessionId } = await createSession(db, cfg, userId);
    await revokeSession(db, sessionId);
    expect(await findLiveSession(db, token)).toBeNull();

    const s2 = await createSession(db, cfg, userId);
    await db.update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.id, s2.sessionId));
    expect(await findLiveSession(db, s2.token)).toBeNull(); // past expiry ⇒ not live
  });

  it("revokeUserSessions kills every session of that user", async () => {
    const userId = await mkUser();
    const a = await createSession(db, cfg, userId);
    const b = await createSession(db, cfg, userId);
    expect(await revokeUserSessions(db, userId)).toBe(2);
    expect(await findLiveSession(db, a.token)).toBeNull();
    expect(await findLiveSession(db, b.token)).toBeNull();
  });

  it("loginWithPassword returns a token only on valid credentials", async () => {
    await mkUser("ravi");
    expect(await loginWithPassword(db, cfg, { username: "ravi", password: "wrong" })).toBeNull();
    const ok = await loginWithPassword(db, cfg, { username: "ravi", password: "s3cret-pass" });
    expect(ok).not.toBeNull();
    expect(await findLiveSession(db, ok!.token)).not.toBeNull();
  });

  it("fast-switch is an identity change: prior terminal sessions die", async () => {
    const u1 = await mkUser("first");
    const u2 = await mkUser("second");
    await setPin(db, u2, "482913");
    const s1 = await loginWithPassword(db, cfg, { username: "first", password: "s3cret-pass", terminalId: "ward-3" });
    const switched = await switchWithPin(db, cfg, { username: "second", pin: "482913", terminalId: "ward-3" });
    expect(switched).not.toBeNull();
    expect(await findLiveSession(db, s1!.token)).toBeNull(); // outgoing user is gone
    expect((await findLiveSession(db, switched!.token))!.userId).toBe(u2);
    expect(u1).not.toBe(u2);
  });

  it("badge switch resolves the badge and switches identity", async () => {
    const u1 = await mkUser("first");
    await mkUser("second");
    const badge = await rotateBadge(db, cfg, u1);
    const s = await switchWithBadge(db, cfg, { badgeToken: badge.badgeToken, terminalId: "ward-3" });
    expect((await findLiveSession(db, s!.token))!.userId).toBe(u1);
    expect(await switchWithBadge(db, cfg, { badgeToken: "b1.fake.1.sig", terminalId: "ward-3" })).toBeNull();
  });
});
```

`apps/core/src/kernel/auth/agents.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createAgent, findAgentByKey, setKillSwitch } from "./agents";
import type { Db } from "../db/client";

describe("agents", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("creates an agent and finds it by key", async () => {
    const { id, apiKey } = await createAgent(db, "digest-writer");
    const found = await findAgentByKey(db, apiKey);
    expect(found).toEqual({ id, name: "digest-writer", killSwitch: false });
    expect(await findAgentByKey(db, "wrong-key")).toBeNull();
  });

  it("kill switch state is visible on lookup", async () => {
    const { id, apiKey } = await createAgent(db, "sla-chaser");
    await setKillSwitch(db, id, true);
    expect((await findAgentByKey(db, apiKey))!.killSwitch).toBe(true);
  });

  it("rejects duplicate agent names", async () => {
    await createAgent(db, "digest-writer");
    await expect(createAgent(db, "digest-writer")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/(sessions|agents)"`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/auth/sessions.ts`:
```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { authSessions, users } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import { verifyPassword, verifyPin, resolveBadge } from "./identity";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export type LiveSession = {
  sessionId: string;
  userId: string;
  terminalId: string | null;
  secondFactorAt: Date | null;
};

export async function createSession(
  db: Db,
  cfg: AppConfig,
  userId: string,
  terminalId?: string,
): Promise<{ token: string; sessionId: string }> {
  const token = randomToken();
  const sessionId = newId();
  const expiresAt = new Date(Date.now() + cfg.sessionTtlMinutes * 60_000);
  await db.insert(authSessions).values({
    id: sessionId,
    tokenHash: sha256Hex(token),
    userId,
    terminalId: terminalId ?? null,
    expiresAt,
  });
  return { token, sessionId };
}

export async function findLiveSession(db: Db, token: string): Promise<LiveSession | null> {
  const rows = await db
    .select({
      sessionId: authSessions.id,
      userId: authSessions.userId,
      terminalId: authSessions.terminalId,
      secondFactorAt: authSessions.secondFactorAt,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.tokenHash, sha256Hex(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, new Date()),
      ),
    );
  return rows[0] ?? null;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
}

export async function revokeUserSessions(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return rows.length;
}

export async function revokeTerminalSessions(db: Db, terminalId: string): Promise<number> {
  const rows = await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(authSessions.terminalId, terminalId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return rows.length;
}

export async function loginWithPassword(
  db: Db,
  cfg: AppConfig,
  input: { username: string; password: string; terminalId?: string },
): Promise<{ token: string } | null> {
  const verified = await verifyPassword(db, input.username, input.password);
  if (!verified) return null;
  const { token } = await createSession(db, cfg, verified.userId, input.terminalId);
  return { token };
}

export async function switchWithPin(
  db: Db,
  cfg: AppConfig,
  input: { username: string; pin: string; terminalId: string },
): Promise<{ token: string } | null> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username));
  const user = rows[0];
  if (!user) return null;
  const ok = await verifyPin(db, user.id, input.pin);
  if (!ok) return null;
  await revokeTerminalSessions(db, input.terminalId);
  const { token } = await createSession(db, cfg, user.id, input.terminalId);
  return { token };
}

export async function switchWithBadge(
  db: Db,
  cfg: AppConfig,
  input: { badgeToken: string; terminalId: string },
): Promise<{ token: string } | null> {
  const resolved = await resolveBadge(db, cfg, input.badgeToken);
  if (!resolved) return null;
  await revokeTerminalSessions(db, input.terminalId);
  const { token } = await createSession(db, cfg, resolved.userId, input.terminalId);
  return { token };
}
```

`apps/core/src/kernel/auth/agents.ts`:
```ts
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { agents } from "../db/schema";
import { randomToken, sha256Hex } from "../crypto";
import type { Db } from "../db/client";

export async function createAgent(db: Db, name: string): Promise<{ id: string; apiKey: string }> {
  const id = newId();
  const apiKey = randomToken();
  await db.insert(agents).values({ id, name, apiKeyHash: sha256Hex(apiKey) });
  return { id, apiKey };
}

export async function findAgentByKey(
  db: Db,
  apiKey: string,
): Promise<{ id: string; name: string; killSwitch: boolean } | null> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, killSwitch: agents.killSwitch })
    .from(agents)
    .where(eq(agents.apiKeyHash, sha256Hex(apiKey)));
  return rows[0] ?? null;
}

export async function setKillSwitch(db: Db, agentId: string, on: boolean): Promise<void> {
  await db.update(agents).set({ killSwitch: on }).where(eq(agents.id, agentId));
}
```

`apps/core/scripts/create-agent.ts`:
```ts
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createAgent } from "../src/kernel/auth/agents";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const { id, apiKey } = await createAgent(db, requireEnv("AGENT_NAME"));
  await pool.end();
  console.log(`agent ${id} created — API key (shown once): ${apiKey}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```
Add script to `apps/core/package.json`: `"agent:create": "tsx scripts/create-agent.ts"`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/(sessions|agents)"`
Expected: PASS (sessions 6 tests, agents 3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core
git commit -m "feat(auth): DB-backed opaque-token sessions, terminal fast-switch, agent actors with kill switch"
```

---

### Task 7: AuthGuard, CurrentActor, /auth endpoints — with the <2 s fast-switch proof

**Files:**
- Create: `apps/core/src/kernel/auth/decorators.ts`, `apps/core/src/kernel/auth/guards.ts`, `apps/core/src/kernel/auth/auth.controller.ts`, `apps/core/src/kernel/auth/auth.module.ts`
- Modify: `apps/core/src/app.module.ts` (import `AuthModule`), `apps/core/src/health/health.controller.ts` (`@Public`)
- Test: `apps/core/test/auth.e2e.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6; `Actor` from contracts.
- Produces (exact, every later plan's controllers use these):
  - `@Public()` — route/class metadata exempting the global `AuthGuard`.
  - `@CurrentActor()` param decorator → contracts `Actor` (`{ type: "user" | "agent" | "system"; id: string }`).
  - `type AuthedRequest = Request & { hmisActor?: Actor; hmisSession?: LiveSession }`
  - `AuthGuard` (registered as global `APP_GUARD` by `AuthModule`): `Authorization: Bearer <token>` → user actor via `findLiveSession`; `x-agent-key: <key>` → agent actor via `findAgentByKey` (**kill switch ⇒ 403**); neither ⇒ 401.
  - `RequirePermission(permission: string, scope: "department" | "floor" | "hospital", opts?: { secondFactor?: boolean; breakGlassBypass?: boolean })` — metadata only in this task; the enforcing `PermissionGuard` lands in Task 8, `secondFactor` behavior in Task 9, `breakGlassBypass` in Task 11.
  - HTTP: `POST /auth/login` `{username,password,terminalId?}` → `{token}` (Public) · `POST /auth/switch/pin` `{username,pin,terminalId}` → `{token}` (Public) · `POST /auth/switch/badge` `{badgeToken,terminalId}` → `{token}` (Public) · `POST /auth/logout` → 204 · `GET /auth/me` → `{ actor }`.

- [ ] **Step 1: Write the failing e2e test**

`apps/core/test/auth.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser, setPin } from "../src/kernel/auth/identity";
import { createAgent, setKillSwitch } from "../src/kernel/auth/agents";
import { requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

describe("auth e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    // Point the app at this worker's database so e2e and helper see the same rows.
    // setupTestDb derives "<base>_<JEST_WORKER_ID>" from TEST_DATABASE_URL — mirror it exactly.
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("health stays public", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);
  });

  it("unauthenticated requests to guarded routes get 401", async () => {
    await request(app.getHttpServer()).get("/auth/me").expect(401);
  });

  it("login → me → logout lifecycle", async () => {
    await createUser(db, { username: "asha", fullName: "Asha K", password: "s3cret-pass" });
    await request(app.getHttpServer())
      .post("/auth/login").send({ username: "asha", password: "nope" }).expect(401);
    const login = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "asha", password: "s3cret-pass" }).expect(201);
    const token = login.body.token as string;
    const me = await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${token}`).expect(200);
    expect(me.body.actor.type).toBe("user");
    await request(app.getHttpServer())
      .post("/auth/logout").set("Authorization", `Bearer ${token}`).expect(204);
    await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${token}`).expect(401);
  });

  it("agent key authenticates; kill switch turns it into 403", async () => {
    const { id, apiKey } = await createAgent(db, "digest-writer");
    const me = await request(app.getHttpServer())
      .get("/auth/me").set("x-agent-key", apiKey).expect(200);
    expect(me.body.actor).toEqual({ type: "agent", id });
    await setKillSwitch(db, id, true);
    await request(app.getHttpServer())
      .get("/auth/me").set("x-agent-key", apiKey).expect(403);
  });

  it("pin fast-switch changes identity on the terminal within budget", async () => {
    await createUser(db, { username: "first", fullName: "F", password: "s3cret-pass" });
    const { id: u2 } = await createUser(db, { username: "second", fullName: "S", password: "s3cret-pass" });
    await setPin(db, u2, "482913");
    const s1 = await request(app.getHttpServer())
      .post("/auth/login").send({ username: "first", password: "s3cret-pass", terminalId: "counter-1" }).expect(201);

    // warm-up switch (JIT, pool) then the measured one — budget guards the steady state
    await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);
    const started = Date.now();
    const switched = await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "482913", terminalId: "counter-1" }).expect(201);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000); // server share of the <2 s spec budget (roadmap trap)

    const me = await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${switched.body.token}`).expect(200);
    expect(me.body.actor.id).toBe(u2);
    await request(app.getHttpServer())
      .get("/auth/me").set("Authorization", `Bearer ${s1.body.token}`).expect(401); // outgoing identity dead
  });

  it("bad switch credentials are rejected", async () => {
    await request(app.getHttpServer())
      .post("/auth/switch/pin").send({ username: "second", pin: "000000", terminalId: "t" }).expect(401);
    await request(app.getHttpServer())
      .post("/auth/switch/badge").send({ badgeToken: "b1.x.1.y", terminalId: "t" }).expect(401);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern auth.e2e`
Expected: FAIL — modules not found.

- [ ] **Step 2: Implement decorators and guard**

`apps/core/src/kernel/auth/decorators.ts`:
```ts
import { SetMetadata, createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Actor } from "@hmis/contracts";
import type { Request } from "express";
import type { LiveSession } from "./sessions";

export type AuthedRequest = Request & { hmisActor?: Actor; hmisSession?: LiveSession };

export const IS_PUBLIC = "hmis:isPublic";
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

export type PermissionScope = "department" | "floor" | "hospital";
export type PermissionRequirement = {
  permission: string;
  scope: PermissionScope;
  secondFactor?: boolean;
  breakGlassBypass?: boolean;
};
export const PERMISSION_KEY = "hmis:permission";
export const RequirePermission = (
  permission: string,
  scope: PermissionScope,
  opts: { secondFactor?: boolean; breakGlassBypass?: boolean } = {},
): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSION_KEY, { permission, scope, ...opts } satisfies PermissionRequirement);

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.hmisActor) throw new Error("CurrentActor used on a route the AuthGuard did not authenticate");
  return req.hmisActor;
});
```

`apps/core/src/kernel/auth/guards.ts`:
```ts
import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DB } from "../tokens";
import { findLiveSession } from "./sessions";
import { findAgentByKey } from "./agents";
import { IS_PUBLIC, AuthedRequest } from "./decorators";
import type { Db } from "../db/client";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    const agentKey = req.headers["x-agent-key"];
    if (typeof agentKey === "string" && agentKey !== "") {
      const agent = await findAgentByKey(this.db, agentKey);
      if (!agent) throw new UnauthorizedException();
      if (agent.killSwitch) throw new ForbiddenException("agent kill switch is active");
      req.hmisActor = { type: "agent", id: agent.id };
      return true;
    }

    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) throw new UnauthorizedException();
    const session = await findLiveSession(this.db, token);
    if (!session) throw new UnauthorizedException();
    req.hmisActor = { type: "user", id: session.userId };
    req.hmisSession = session;
    return true;
  }
}
```

- [ ] **Step 3: Implement controller and module**

`apps/core/src/kernel/auth/auth.controller.ts`:
```ts
import {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req, UnauthorizedException,
} from "@nestjs/common";
import { z } from "zod";
import type { Actor } from "@hmis/contracts";
import { CONFIG, DB } from "../tokens";
import { loginWithPassword, revokeSession, switchWithBadge, switchWithPin } from "./sessions";
import { CurrentActor, Public, AuthedRequest } from "./decorators";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  terminalId: z.string().min(1).optional(),
});
const pinSwitchSchema = z.object({
  username: z.string().min(1),
  pin: z.string().min(4),
  terminalId: z.string().min(1),
});
const badgeSwitchSchema = z.object({
  badgeToken: z.string().min(1),
  terminalId: z.string().min(1),
});

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly cfg: AppConfig,
  ) {}

  @Public()
  @Post("login")
  async login(@Body() body: unknown): Promise<{ token: string }> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await loginWithPassword(this.db, this.cfg, parsed.data);
    if (!result) throw new UnauthorizedException();
    return result;
  }

  @Public()
  @Post("switch/pin")
  async switchPin(@Body() body: unknown): Promise<{ token: string }> {
    const parsed = pinSwitchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await switchWithPin(this.db, this.cfg, parsed.data);
    if (!result) throw new UnauthorizedException();
    return result;
  }

  @Public()
  @Post("switch/badge")
  async switchBadge(@Body() body: unknown): Promise<{ token: string }> {
    const parsed = badgeSwitchSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const result = await switchWithBadge(this.db, this.cfg, parsed.data);
    if (!result) throw new UnauthorizedException();
    return result;
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest): Promise<void> {
    if (req.hmisSession) await revokeSession(this.db, req.hmisSession.sessionId);
  }

  @Get("me")
  me(@CurrentActor() actor: Actor): { actor: Actor } {
    return { actor };
  }
}
```

`apps/core/src/kernel/auth/auth.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./guards";

@Module({
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}
```

In `apps/core/src/app.module.ts`, add `AuthModule` to a new `imports: [AuthModule]` entry in the `@Module` decorator and `import { AuthModule } from "./kernel/auth/auth.module";` at the top. Everything else from Task 2 stays byte-identical.

In `apps/core/src/health/health.controller.ts`, add `@Public()` above `@Controller("health")`'s `@Get()` method and `import { Public } from "../kernel/auth/decorators";` — health must stay probe-able without credentials.

Add `"express"` types if the compiler asks: devDependency `"@types/express": "^5.0.0"` (Nest ^11 ships express 5).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth.e2e|health"`
Expected: PASS — auth e2e 6 tests (fast-switch elapsed under 1000 ms) and health suite still green.

Run: `pnpm verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core
git commit -m "feat(auth): global AuthGuard, CurrentActor, /auth endpoints with perf-tested fast-switch"
```

---

### Task 8: Permissions — registry sync, roles, scoped checks, PermissionGuard, seed-admin

The registry trap (roadmap, gate report §3/§6-4): permission strings exist **only** in module manifests. This task wires `ModuleRegistry` into Nest DI (its first consumer), mirrors `allPermissions()` into the `permissions` table for FK integrity, and rejects any grant of a string the registry does not know.

**Files:**
- Create: `apps/core/src/kernel/auth/manifest.ts`, `apps/core/src/kernel/auth/permissions.ts`, `apps/core/scripts/seed-admin.ts`
- Modify: `apps/core/src/app.module.ts` (add `MODULE_REGISTRY`), `apps/core/src/kernel/auth/guards.ts` (add `PermissionGuard`), `apps/core/src/kernel/auth/auth.module.ts` (register guard + boot sync), `apps/core/package.json` (script)
- Test: `apps/core/src/kernel/auth/permissions.test.ts`, `apps/core/test/rbac.e2e.test.ts`

**Interfaces:**
- Consumes: `ModuleRegistry` + `ModuleManifest` (Plan 01 Task 7), `PERMISSION_KEY`/`PermissionRequirement` metadata (Task 7), tables (Task 4).
- Produces (exact):
  - `authManifest: ModuleManifest` — key `"auth"`, permissions `["auth.users.manage", "auth.roles.manage", "auth.agents.manage", "auth.break_glass.use", "auth.break_glass.review", "auth.temp_role.grant"]`.
  - DI token `MODULE_REGISTRY` (`@Global` from `AppModule`) — a `ModuleRegistry` with `authManifest` installed; later plans install their manifests in this same factory.
  - `syncPermissions(db: Db, registry: ModuleRegistry): Promise<void>` — one-way upsert mirror.
  - `createRole(db: Db, key: string, title: string): Promise<void>`
  - `grantPermissionToRole(db: Db, registry: ModuleRegistry, roleKey: string, permission: string): Promise<void>` — **throws on any permission the registry doesn't declare**.
  - `type ScopeType = "hospital" | "floor" | "department"`; `type ScopeCtx = { departmentId?: string; floorId?: string }`
  - `assignRole(db: Db, input: { userId: string; roleKey: string; scopeType: ScopeType; scopeId?: string }): Promise<{ id: string }>`
  - `hasPermission(db: Db, userId: string, permission: string, requiredScope: ScopeType, ctx?: ScopeCtx): Promise<boolean>` — hospital assignments satisfy everything; floor/department assignments satisfy only their own level with a matching ctx id (**no cross-level inference until org masters exist — deliberate Plan-02 rule**); active `temp_role_grants` count as hospital-scope holdings.
  - `PermissionGuard` (global, runs after `AuthGuard`): enforces `@RequirePermission` metadata; routes without the metadata pass untouched; agents are denied on permission-guarded routes with a clear message (**agent permission grants are a declared seam for Plan 12** — additive `agent_permissions` table there, no schema change now).
  - `scopeCtxFromRequest(req: AuthedRequest): ScopeCtx` — reads `departmentId`/`floorId` from route params, then query, then body.
  - Script `pnpm --filter @hmis/core seed:admin` — idempotent bootstrap: admin user (env-driven), `admin` role holding every registry permission, hospital-scope assignment.

- [ ] **Step 1: Write the failing unit tests**

`apps/core/src/kernel/auth/permissions.test.ts`:
```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import {
  syncPermissions, createRole, grantPermissionToRole, assignRole, hasPermission,
} from "./permissions";
import { authManifest } from "./manifest";
import { ModuleRegistry } from "../modules/loader";
import { tempRoleGrants } from "../db/schema";
import { newId } from "@hmis/contracts";
import type { Db } from "../db/client";

function freshRegistry(): ModuleRegistry {
  const r = new ModuleRegistry();
  r.install(authManifest);
  return r;
}

describe("permissions", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("syncPermissions mirrors the registry and is idempotent", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await syncPermissions(db, registry); // second run must not throw
  });

  it("rejects granting a permission the registry does not declare", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    await createRole(db, "admin", "Administrator");
    await expect(
      grantPermissionToRole(db, registry, "admin", "billing.refund.approve"),
    ).rejects.toThrow(/module manifests/);
  });

  it("hospital scope satisfies every required scope", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    const { id: userId } = await createUser(db, { username: "a", fullName: "A", password: "p1234567" });
    await createRole(db, "admin", "Administrator");
    await grantPermissionToRole(db, registry, "admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "admin", scopeType: "hospital" });
    expect(await hasPermission(db, userId, "auth.users.manage", "hospital")).toBe(true);
    expect(await hasPermission(db, userId, "auth.users.manage", "department", { departmentId: "cardio" })).toBe(true);
    expect(await hasPermission(db, userId, "auth.roles.manage", "hospital")).toBe(false); // not granted
  });

  it("department scope satisfies only its own department", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    const { id: userId } = await createUser(db, { username: "b", fullName: "B", password: "p1234567" });
    await createRole(db, "dept-admin", "Dept Admin");
    await grantPermissionToRole(db, registry, "dept-admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "dept-admin", scopeType: "department", scopeId: "cardio" });
    expect(await hasPermission(db, userId, "auth.users.manage", "department", { departmentId: "cardio" })).toBe(true);
    expect(await hasPermission(db, userId, "auth.users.manage", "department", { departmentId: "ortho" })).toBe(false);
    expect(await hasPermission(db, userId, "auth.users.manage", "hospital")).toBe(false); // no upward inference
    expect(await hasPermission(db, userId, "auth.users.manage", "department")).toBe(false); // no ctx id
  });

  it("active temp grants confer the role at hospital scope; expired ones do not", async () => {
    const registry = freshRegistry();
    await syncPermissions(db, registry);
    const { id: userId } = await createUser(db, { username: "c", fullName: "C", password: "p1234567" });
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
    await db.insert(tempRoleGrants).values({
      id: newId(), userId, roleKey: "reviewer", grantedBy: "seed", kind: "granted",
      reason: "test", expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await hasPermission(db, userId, "auth.break_glass.review", "hospital")).toBe(true);
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
    const { id: u2 } = await createUser(db, { username: "d", fullName: "D", password: "p1234567" });
    await db.insert(tempRoleGrants).values({
      id: newId(), userId: u2, roleKey: "reviewer", grantedBy: "seed", kind: "granted",
      reason: "test", expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await hasPermission(db, u2, "auth.break_glass.review", "hospital")).toBe(false);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/permissions"`
Expected: FAIL — modules not found.

- [ ] **Step 2: Implement manifest + permissions service**

`apps/core/src/kernel/auth/manifest.ts`:
```ts
import type { ModuleManifest } from "../modules/manifest";

export const authManifest: ModuleManifest = {
  key: "auth",
  title: "Users & Access",
  menu: [],
  permissions: [
    "auth.users.manage",
    "auth.roles.manage",
    "auth.agents.manage",
    "auth.break_glass.use",
    "auth.break_glass.review",
    "auth.temp_role.grant",
  ],
  subscriptions: [],
};
```

`apps/core/src/kernel/auth/permissions.ts`:
```ts
import { and, eq, gt, inArray } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { permissions, rolePermissions, roleAssignments, roles, tempRoleGrants } from "../db/schema";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

export type ScopeType = "hospital" | "floor" | "department";
export type ScopeCtx = { departmentId?: string; floorId?: string };

export async function syncPermissions(db: Db, registry: ModuleRegistry): Promise<void> {
  for (const manifest of registry.all()) {
    for (const permission of manifest.permissions) {
      await db
        .insert(permissions)
        .values({ permission, module: manifest.key })
        .onConflictDoUpdate({
          target: permissions.permission,
          set: { module: manifest.key, syncedAt: new Date() },
        });
    }
  }
}

export async function createRole(db: Db, key: string, title: string): Promise<void> {
  await db.insert(roles).values({ key, title });
}

export async function grantPermissionToRole(
  db: Db,
  registry: ModuleRegistry,
  roleKey: string,
  permission: string,
): Promise<void> {
  if (!registry.allPermissions().includes(permission)) {
    throw new Error(
      `unknown permission "${permission}" — permission strings come from module manifests only (spec §4)`,
    );
  }
  await db.insert(rolePermissions).values({ roleKey, permission }).onConflictDoNothing();
}

export async function assignRole(
  db: Db,
  input: { userId: string; roleKey: string; scopeType: ScopeType; scopeId?: string },
): Promise<{ id: string }> {
  if (input.scopeType !== "hospital" && input.scopeId === undefined) {
    throw new Error(`${input.scopeType}-scoped assignment requires a scopeId`);
  }
  const id = newId();
  await db.insert(roleAssignments).values({
    id,
    userId: input.userId,
    roleKey: input.roleKey,
    scopeType: input.scopeType,
    scopeId: input.scopeType === "hospital" ? null : input.scopeId,
  });
  return { id };
}

type Holding = { roleKey: string; scopeType: ScopeType; scopeId: string | null };

export async function hasPermission(
  db: Db,
  userId: string,
  permission: string,
  requiredScope: ScopeType,
  ctx: ScopeCtx = {},
): Promise<boolean> {
  const permanent = await db
    .select({
      roleKey: roleAssignments.roleKey,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
    })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, userId));

  const temp = await db
    .select({ roleKey: tempRoleGrants.roleKey })
    .from(tempRoleGrants)
    .where(and(eq(tempRoleGrants.userId, userId), gt(tempRoleGrants.expiresAt, new Date())));

  const holdings: Holding[] = [
    ...permanent.map((a) => ({ roleKey: a.roleKey, scopeType: a.scopeType as ScopeType, scopeId: a.scopeId })),
    // Temp grants are exceptional, loud, and time-boxed — they act at hospital scope.
    ...temp.map((t) => ({ roleKey: t.roleKey, scopeType: "hospital" as ScopeType, scopeId: null })),
  ];
  if (holdings.length === 0) return false;

  const roleKeys = [...new Set(holdings.map((h) => h.roleKey))];
  const granted = await db
    .select({ roleKey: rolePermissions.roleKey })
    .from(rolePermissions)
    .where(and(inArray(rolePermissions.roleKey, roleKeys), eq(rolePermissions.permission, permission)));
  const grantedRoles = new Set(granted.map((g) => g.roleKey));

  return holdings.some((h) => {
    if (!grantedRoles.has(h.roleKey)) return false;
    if (h.scopeType === "hospital") return true;
    if (h.scopeType !== requiredScope) return false; // no cross-level inference until org masters exist
    const wanted = requiredScope === "department" ? ctx.departmentId : ctx.floorId;
    return wanted !== undefined && h.scopeId === wanted;
  });
}
```

- [ ] **Step 3: Wire registry DI, PermissionGuard, boot sync**

Append to `apps/core/src/kernel/tokens.ts`:
```ts
export const MODULE_REGISTRY = Symbol("MODULE_REGISTRY");
```

In `apps/core/src/app.module.ts` add:
```ts
import { ModuleRegistry } from "./kernel/modules/loader";
import { authManifest } from "./kernel/auth/manifest";
```
add `MODULE_REGISTRY` to both the token import and the re-export line, and add a provider (in the existing `providers` array) + export:
```ts
    {
      provide: MODULE_REGISTRY,
      useFactory: (): ModuleRegistry => {
        const registry = new ModuleRegistry();
        registry.install(authManifest);
        // Later plans install their module manifests here.
        return registry;
      },
    },
```
with `MODULE_REGISTRY` added to the `exports` array. Everything else stays as Task 7 left it.

Append to `apps/core/src/kernel/auth/guards.ts`:
```ts
import { PERMISSION_KEY, PermissionRequirement } from "./decorators";
import { hasPermission, scopeCtxFromRequest } from "./permissions";
```
(merge into the existing import lines) and:
```ts
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(
      PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!requirement) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const actor = req.hmisActor;
    if (!actor) throw new UnauthorizedException();

    if (actor.type !== "user") {
      // Deliberate Plan-02 seam: agent permission grants arrive with the agent runtime
      // (Plan 12, additive agent_permissions table). Until then agents hold no permissions.
      throw new ForbiddenException("agents hold no permissions yet");
    }

    const allowed = await hasPermission(
      this.db, actor.id, requirement.permission, requirement.scope, scopeCtxFromRequest(req),
    );
    if (!allowed) throw new ForbiddenException(`missing permission ${requirement.permission}`);
    return true;
  }
}
```

Move `scopeCtxFromRequest` into `permissions.ts` (it needs `AuthedRequest` — import the type):
```ts
import type { AuthedRequest } from "./decorators";

function pickScopeValue(req: AuthedRequest, key: string): string | undefined {
  const fromParams = (req.params as Record<string, string | undefined> | undefined)?.[key];
  if (typeof fromParams === "string") return fromParams;
  const fromQuery = (req.query as Record<string, unknown> | undefined)?.[key];
  if (typeof fromQuery === "string") return fromQuery;
  const fromBody = (req.body as Record<string, unknown> | undefined)?.[key];
  if (typeof fromBody === "string") return fromBody;
  return undefined;
}

export function scopeCtxFromRequest(req: AuthedRequest): ScopeCtx {
  return { departmentId: pickScopeValue(req, "departmentId"), floorId: pickScopeValue(req, "floorId") };
}
```

`apps/core/src/kernel/auth/auth.module.ts` becomes:
```ts
import { Inject, Module, OnModuleInit } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DB, MODULE_REGISTRY } from "../tokens";
import { AuthController } from "./auth.controller";
import { AuthGuard, PermissionGuard } from "./guards";
import { syncPermissions } from "./permissions";
import type { ModuleRegistry } from "../modules/loader";
import type { Db } from "../db/client";

@Module({
  controllers: [AuthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },       // runs first: identity
    { provide: APP_GUARD, useClass: PermissionGuard }, // runs second: RBAC
  ],
})
export class AuthModule implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(MODULE_REGISTRY) private readonly registry: ModuleRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await syncPermissions(this.db, this.registry);
  }
}
```

- [ ] **Step 4: Failing e2e, then pass**

`apps/core/test/rbac.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { Controller, Get, INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

@Controller("scope-test")
class ScopeTestController {
  @RequirePermission("auth.users.manage", "hospital")
  @Get("admin")
  admin(): { ok: boolean } { return { ok: true }; }

  @RequirePermission("auth.users.manage", "department")
  @Get("dept/:departmentId")
  dept(): { ok: boolean } { return { ok: true }; }
}

describe("rbac e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ScopeTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  async function userWithToken(username: string): Promise<{ userId: string; token: string }> {
    const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    return { userId: id, token };
  }

  it("denies without the permission, allows with a hospital-scope role", async () => {
    const { userId, token } = await userWithToken("asha");
    await request(app.getHttpServer())
      .get("/scope-test/admin").set("Authorization", `Bearer ${token}`).expect(403);
    await createRole(db, "admin", "Administrator");
    await grantPermissionToRole(db, registry, "admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "admin", scopeType: "hospital" });
    await request(app.getHttpServer())
      .get("/scope-test/admin").set("Authorization", `Bearer ${token}`).expect(200);
  });

  it("department scope binds to the route's departmentId", async () => {
    const { userId, token } = await userWithToken("ravi");
    await createRole(db, "dept-admin", "Dept Admin");
    await grantPermissionToRole(db, registry, "dept-admin", "auth.users.manage");
    await assignRole(db, { userId, roleKey: "dept-admin", scopeType: "department", scopeId: "cardio" });
    await request(app.getHttpServer())
      .get("/scope-test/dept/cardio").set("Authorization", `Bearer ${token}`).expect(200);
    await request(app.getHttpServer())
      .get("/scope-test/dept/ortho").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("agents are denied on permission-guarded routes", async () => {
    const { createAgent } = await import("../src/kernel/auth/agents");
    const { apiKey } = await createAgent(db, "probe");
    await request(app.getHttpServer())
      .get("/scope-test/admin").set("x-agent-key", apiKey).expect(403);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/permissions|rbac.e2e"`
Expected: PASS (unit 5 tests, e2e 3 tests).

- [ ] **Step 5: Seed script**

`apps/core/scripts/seed-admin.ts`:
```ts
import { eq } from "drizzle-orm";
import { createDb } from "../src/kernel/db/client";
import { requireEnv } from "../src/kernel/config";
import { createUser } from "../src/kernel/auth/identity";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { authManifest } from "../src/kernel/auth/manifest";
import { roles, users } from "../src/kernel/db/schema";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  await syncPermissions(db, registry);

  const username = requireEnv("ADMIN_USERNAME");
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (existing.length > 0) {
    console.log(`admin "${username}" already exists — nothing to do`);
    await pool.end();
    return;
  }

  const { id } = await createUser(db, {
    username,
    fullName: requireEnv("ADMIN_FULL_NAME"),
    password: requireEnv("ADMIN_PASSWORD"),
  });
  const haveAdminRole = await db.select({ key: roles.key }).from(roles).where(eq(roles.key, "admin"));
  if (haveAdminRole.length === 0) await createRole(db, "admin", "Administrator");
  for (const permission of registry.allPermissions()) {
    await grantPermissionToRole(db, registry, "admin", permission);
  }
  await assignRole(db, { userId: id, roleKey: "admin", scopeType: "hospital" });
  await pool.end();
  console.log(`admin "${username}" created (${id}) with hospital-scope admin role`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```
Add script to `apps/core/package.json`: `"seed:admin": "tsx scripts/seed-admin.ts"`.

Run on the server (env vars in `apps/core/.env`): `pnpm --filter @hmis/core seed:admin`
Expected: `admin "<name>" created (<ulid>) with hospital-scope admin role`; a second run prints `already exists`.

- [ ] **Step 6: Full suite + commit**

Run: `pnpm verify`
Expected: PASS.

```bash
git add apps/core
git commit -m "feat(auth): scoped RBAC from ModuleRegistry permissions, PermissionGuard, admin seed"
```

---

### Task 9: TOTP second factor — sealed seeds + step-up guard option

**Files:**
- Create: `apps/core/src/kernel/auth/totp.ts`
- Modify: `apps/core/package.json` (add `otplib`), `apps/core/src/kernel/auth/guards.ts` (step-up in `PermissionGuard`), `apps/core/src/kernel/auth/auth.controller.ts` (TOTP endpoints)
- Test: `apps/core/src/kernel/auth/totp.test.ts`, `apps/core/test/second-factor.e2e.test.ts`

**Interfaces:**
- Consumes: `userTotp`, `authSessions` (Task 4), `sealSecret`/`openSecret` (Task 3), `CONFIG` (Task 2).
- Produces (exact):
  - `enrollTotp(db: Db, cfg: AppConfig, userId: string): Promise<{ otpauthUrl: string; secret: string }>` — seed stored **sealed only**; re-enroll resets `enabledAt`.
  - `confirmTotp(db: Db, cfg: AppConfig, userId: string, code: string): Promise<boolean>` — first valid code enables.
  - `verifyTotpCode(db: Db, cfg: AppConfig, userId: string, code: string): Promise<boolean>` — enabled users only.
  - `recordSecondFactor(db: Db, sessionId: string): Promise<void>`; `secondFactorFresh(session: { secondFactorAt: Date | null }, windowMinutes: number, now?: Date): boolean`
  - Guard behavior for `@RequirePermission(p, s, { secondFactor: true })`: user sessions only (agents 403); passes when `secondFactorAt` is within `cfg.secondFactorWindowMinutes`, else when a valid `x-totp-code` header is presented (which also stamps the session); otherwise 403 `second_factor_required`.
  - HTTP: `POST /auth/totp/enroll` → `{ otpauthUrl }` · `POST /auth/totp/confirm` `{code}` → 204/403 · `POST /auth/totp/verify` `{code}` → 204 (stamps session).

- [ ] **Step 1: Write the failing unit tests**

`apps/core/src/kernel/auth/totp.test.ts`:
```ts
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { enrollTotp, confirmTotp, verifyTotpCode, secondFactorFresh } from "./totp";
import { loadConfig } from "../config";
import { userTotp } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("totp", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); });
  afterAll(async () => { await teardown(); });

  it("enrolls with a sealed seed, confirms with a valid code", async () => {
    const { id } = await createUser(db, { username: "asha", fullName: "A", password: "p1234567" });
    const { secret, otpauthUrl } = await enrollTotp(db, cfg, id);
    expect(otpauthUrl).toContain("otpauth://totp/");
    const stored = (await db.select().from(userTotp).where(eq(userTotp.userId, id)))[0]!;
    expect(stored.secretSealed).not.toContain(secret); // sealed, never plaintext
    expect(stored.enabledAt).toBeNull();
    expect(await verifyTotpCode(db, cfg, id, authenticator.generate(secret))).toBe(false); // not enabled yet
    expect(await confirmTotp(db, cfg, id, "000000")).toBe(false);
    expect(await confirmTotp(db, cfg, id, authenticator.generate(secret))).toBe(true);
    expect(await verifyTotpCode(db, cfg, id, authenticator.generate(secret))).toBe(true);
    expect(await verifyTotpCode(db, cfg, id, "000000")).toBe(false);
  });

  it("secondFactorFresh honours the window", () => {
    const now = new Date("2026-08-12T10:00:00Z");
    expect(secondFactorFresh({ secondFactorAt: null }, 5, now)).toBe(false);
    expect(secondFactorFresh({ secondFactorAt: new Date("2026-08-12T09:56:00Z") }, 5, now)).toBe(true);
    expect(secondFactorFresh({ secondFactorAt: new Date("2026-08-12T09:54:00Z") }, 5, now)).toBe(false);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/totp"`
Expected: FAIL — `./totp` not found.

- [ ] **Step 2: Implement**

Add to `apps/core/package.json` dependencies: `"otplib": "^12.0.1"`.

`apps/core/src/kernel/auth/totp.ts`:
```ts
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { authSessions, userTotp } from "../db/schema";
import { openSecret, sealSecret } from "../crypto";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export async function enrollTotp(
  db: Db,
  cfg: AppConfig,
  userId: string,
): Promise<{ otpauthUrl: string; secret: string }> {
  const secret = authenticator.generateSecret();
  const secretSealed = sealSecret(cfg.secretKey, secret);
  await db
    .insert(userTotp)
    .values({ userId, secretSealed, enabledAt: null })
    .onConflictDoUpdate({ target: userTotp.userId, set: { secretSealed, enabledAt: null } });
  return { otpauthUrl: authenticator.keyuri(userId, "HMIS", secret), secret };
}

export async function confirmTotp(db: Db, cfg: AppConfig, userId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  const row = rows[0];
  if (!row) return false;
  const ok = authenticator.check(code, openSecret(cfg.secretKey, row.secretSealed));
  if (ok && row.enabledAt === null) {
    await db.update(userTotp).set({ enabledAt: new Date() }).where(eq(userTotp.userId, userId));
  }
  return ok;
}

export async function verifyTotpCode(db: Db, cfg: AppConfig, userId: string, code: string): Promise<boolean> {
  const rows = await db.select().from(userTotp).where(eq(userTotp.userId, userId));
  const row = rows[0];
  if (!row || row.enabledAt === null) return false;
  return authenticator.check(code, openSecret(cfg.secretKey, row.secretSealed));
}

export async function recordSecondFactor(db: Db, sessionId: string): Promise<void> {
  await db.update(authSessions).set({ secondFactorAt: new Date() }).where(eq(authSessions.id, sessionId));
}

export function secondFactorFresh(
  session: { secondFactorAt: Date | null },
  windowMinutes: number,
  now: Date = new Date(),
): boolean {
  return (
    session.secondFactorAt !== null &&
    now.getTime() - session.secondFactorAt.getTime() <= windowMinutes * 60_000
  );
}
```

Extend `PermissionGuard.canActivate` in `guards.ts` — after the `hasPermission` check passes, before `return true`:
```ts
    if (requirement.secondFactor) {
      const session = req.hmisSession;
      if (!session) throw new ForbiddenException("second factor requires a user session");
      if (!secondFactorFresh(session, this.cfg.secondFactorWindowMinutes)) {
        const code = req.headers["x-totp-code"];
        const ok = typeof code === "string" && (await verifyTotpCode(this.db, this.cfg, actor.id, code));
        if (!ok) throw new ForbiddenException("second_factor_required");
        await recordSecondFactor(this.db, session.sessionId);
      }
    }
```
`PermissionGuard`'s constructor gains `@Inject(CONFIG) private readonly cfg: AppConfig` and `guards.ts` imports `CONFIG`, `AppConfig`, and the three totp functions.

Add to `auth.controller.ts` (imports: `enrollTotp`, `confirmTotp`, `verifyTotpCode`, `recordSecondFactor`; `ForbiddenException`):
```ts
  @Post("totp/enroll")
  async totpEnroll(@CurrentActor() actor: Actor): Promise<{ otpauthUrl: string }> {
    if (actor.type !== "user") throw new ForbiddenException();
    const { otpauthUrl } = await enrollTotp(this.db, this.cfg, actor.id);
    return { otpauthUrl };
  }

  @Post("totp/confirm")
  @HttpCode(204)
  async totpConfirm(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<void> {
    const parsed = z.object({ code: z.string().min(6) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (actor.type !== "user" || !(await confirmTotp(this.db, this.cfg, actor.id, parsed.data.code))) {
      throw new ForbiddenException("invalid code");
    }
  }

  @Post("totp/verify")
  @HttpCode(204)
  async totpVerify(@Req() req: AuthedRequest, @Body() body: unknown): Promise<void> {
    const parsed = z.object({ code: z.string().min(6) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const actor = req.hmisActor;
    if (!actor || actor.type !== "user" || !req.hmisSession) throw new ForbiddenException();
    if (!(await verifyTotpCode(this.db, this.cfg, actor.id, parsed.data.code))) {
      throw new ForbiddenException("invalid code");
    }
    await recordSecondFactor(this.db, req.hmisSession.sessionId);
  }
```

- [ ] **Step 3: Failing e2e, then pass**

`apps/core/test/second-factor.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { Controller, INestApplication, Post } from "@nestjs/common";
import request from "supertest";
import { authenticator } from "otplib";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { enrollTotp, confirmTotp } from "../src/kernel/auth/totp";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

@Controller("stepup-test")
class StepupTestController {
  @RequirePermission("auth.roles.manage", "hospital", { secondFactor: true })
  @Post("signature-act")
  act(): { ok: boolean } { return { ok: true }; }
}

describe("second factor e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [StepupTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("requires, accepts, then remembers the second factor within the window", async () => {
    const { id } = await createUser(db, { username: "signer", fullName: "S", password: "p1234567" });
    await createRole(db, "signer", "Signer");
    await grantPermissionToRole(db, registry, "signer", "auth.roles.manage");
    await assignRole(db, { userId: id, roleKey: "signer", scopeType: "hospital" });
    const { token } = await createSession(db, cfg, id);

    // permission alone is not enough
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act").set("Authorization", `Bearer ${token}`).expect(403);

    const { secret } = await enrollTotp(db, cfg, id);
    await confirmTotp(db, cfg, id, authenticator.generate(secret));

    // wrong code still 403
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`).set("x-totp-code", "000000").expect(403);

    // valid code passes and stamps the session
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act")
      .set("Authorization", `Bearer ${token}`).set("x-totp-code", authenticator.generate(secret)).expect(201);

    // within the window no code is needed
    await request(app.getHttpServer())
      .post("/stepup-test/signature-act").set("Authorization", `Bearer ${token}`).expect(201);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "totp|second-factor"`
Expected: PASS (unit 2 tests, e2e 1 test).

- [ ] **Step 4: Full suite + commit**

Run: `pnpm verify`
Expected: PASS.

```bash
git add apps/core pnpm-lock.yaml
git commit -m "feat(auth): TOTP second factor with sealed seeds and step-up guard option"
```

---

### Task 10: Auth events + SoD hard-pair enforcement

First consumer of `appendEvent` in this plan. The one subtlety is load-bearing: **`sod.violation_blocked` must survive the caller's rollback** — a blocked transaction that also rolled back its own violation event would be an SoD block nobody can audit. `assertNotSodPair` therefore appends in its **own** transaction on `db`, never on the caller's `tx`.

**Files:**
- Create: `apps/core/src/kernel/auth/events.ts`, `apps/core/src/kernel/auth/sod.ts`
- Modify: `apps/core/src/kernel/auth/auth.module.ts` (seed pairs on boot)
- Test: `apps/core/src/kernel/auth/sod.test.ts`

**Interfaces:**
- Consumes: `defineEvent` (contracts), `appendEvent`/`withTx` (Plan 01), `sodPairs` (Task 4).
- Produces (exact):
  - `events.ts` exports `breakGlassUsed`, `sodViolationBlocked`, `emergencyElevationUsed`, `tempRoleGranted`, `tempRoleExpired` — the five `EventDef`s, module `"auth"`, zod payloads as written below. **No other event names may be minted by this plan.**
  - `SOD_PAIR_SEED: { pairKey: string; description: string }[]` — the nine S10 §11 pairs.
  - `seedSodPairs(db: Db): Promise<void>` — idempotent upsert (runs in `AuthModule.onModuleInit`).
  - `class SodViolationError extends Error { readonly pairKey: string }`
  - `assertNotSodPair(db: Db, pairKey: string, actorA: Actor, actorB: Actor): Promise<void>` — unknown pairKey throws (no event); distinct actors resolve; same actor ⇒ appends `sod.violation_blocked` in its own transaction, then throws `SodViolationError`. **Plan 04's approvals engine calls exactly this.**

- [ ] **Step 1: Write the failing tests**

`apps/core/src/kernel/auth/sod.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { assertNotSodPair, seedSodPairs, SodViolationError, SOD_PAIR_SEED } from "./sod";
import { withTx } from "../db/client";
import { events } from "../db/schema";
import type { Db } from "../db/client";

const userA = { type: "user" as const, id: "01HUSERAAAAAAAAAAAAAAAAAA0" };
const userB = { type: "user" as const, id: "01HUSERBBBBBBBBBBBBBBBBBB0" };

describe("sod", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => { await truncateAll(db); await seedSodPairs(db); });
  afterAll(async () => { await teardown(); });

  it("seeds all nine S10 pairs idempotently", async () => {
    expect(SOD_PAIR_SEED).toHaveLength(9);
    await seedSodPairs(db); // second run must not throw
  });

  it("distinct actors pass without an event", async () => {
    await assertNotSodPair(db, "requester_approver", userA, userB);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("unknown pair keys throw without an event", async () => {
    await expect(assertNotSodPair(db, "not_a_pair", userA, userA)).rejects.toThrow(/unknown SoD pair/);
    expect(await db.select().from(events)).toHaveLength(0);
  });

  it("same actor blocks with sod.violation_blocked", async () => {
    await expect(assertNotSodPair(db, "cashier_refund_approver", userA, userA))
      .rejects.toThrow(SodViolationError);
    const rows = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("auth");
    expect((rows[0]!.payload as { pairKey: string }).pairKey).toBe("cashier_refund_approver");
  });

  it("the violation event survives the caller's rollback", async () => {
    await expect(
      withTx(db, async (tx) => {
        void tx; // caller doing its own transactional work…
        await assertNotSodPair(db, "narcotics_issuer_witness", userB, userB);
      }),
    ).rejects.toThrow(SodViolationError);
    // caller's tx rolled back, but the block is still on the record:
    const rows = await db.select().from(events).where(eq(events.name, "sod.violation_blocked"));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/sod"`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/core/src/kernel/auth/events.ts`:
```ts
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

export const breakGlassUsed = defineEvent(
  "break_glass.used",
  "auth",
  z.object({
    grantId: z.string(),
    patientId: z.string().optional(),
    reason: z.string(),
    expiresAt: z.string(), // ISO timestamp
  }),
);

export const sodViolationBlocked = defineEvent(
  "sod.violation_blocked",
  "auth",
  z.object({
    pairKey: z.string(),
    actorAType: z.string(),
    actorAId: z.string(),
    actorBType: z.string(),
    actorBId: z.string(),
  }),
);

export const emergencyElevationUsed = defineEvent(
  "emergency_elevation.used",
  "auth",
  z.object({ grantId: z.string(), roleKey: z.string(), reason: z.string(), expiresAt: z.string() }),
);

export const tempRoleGranted = defineEvent(
  "temp_role.granted",
  "auth",
  z.object({
    grantId: z.string(),
    userId: z.string(),
    roleKey: z.string(),
    grantedBy: z.string(),
    kind: z.enum(["granted", "emergency"]),
    reason: z.string(),
    expiresAt: z.string(),
  }),
);

export const tempRoleExpired = defineEvent(
  "temp_role.expired",
  "auth",
  z.object({ grantId: z.string(), userId: z.string(), roleKey: z.string() }),
);
```

`apps/core/src/kernel/auth/sod.ts`:
```ts
import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { sodPairs } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { sodViolationBlocked } from "./events";
import type { Db } from "../db/client";

export const SOD_PAIR_SEED: { pairKey: string; description: string }[] = [
  { pairKey: "requester_approver", description: "Requester vs approver of any approvals-engine item" },
  { pairKey: "cashier_refund_approver", description: "Cashier vs refund/void approver" },
  { pairKey: "po_approver_grn_receiver", description: "PO approver vs GRN receiver" },
  { pairKey: "stock_custodian_cycle_counter", description: "Stock custodian vs cycle counter (incl. ward sub-stores)" },
  { pairKey: "narcotics_issuer_witness", description: "Narcotics issuer vs witness" },
  { pairKey: "payout_preparer_payout_approver", description: "Payout preparer vs payout approver" },
  { pairKey: "workflow_drafter_activator", description: "Workflow-definition drafter vs activator" },
  { pairKey: "quality_auditor_audited_station", description: "Quality auditor vs audited-station holder for that audit" },
  { pairKey: "downtime_declarer_cash_reconciler", description: "Downtime declarer vs downtime-cash reconciler" },
];

export async function seedSodPairs(db: Db): Promise<void> {
  for (const pair of SOD_PAIR_SEED) {
    await db
      .insert(sodPairs)
      .values(pair)
      .onConflictDoUpdate({ target: sodPairs.pairKey, set: { description: pair.description } });
  }
}

export class SodViolationError extends Error {
  constructor(readonly pairKey: string) {
    super(`segregation-of-duties violation: ${pairKey}`);
    this.name = "SodViolationError";
  }
}

export async function assertNotSodPair(
  db: Db,
  pairKey: string,
  actorA: Actor,
  actorB: Actor,
): Promise<void> {
  const known = await db.select({ pairKey: sodPairs.pairKey }).from(sodPairs).where(eq(sodPairs.pairKey, pairKey));
  if (known.length === 0) throw new Error(`unknown SoD pair key: ${pairKey}`);
  if (actorA.type !== actorB.type || actorA.id !== actorB.id) return;

  // Own transaction on `db`, never the caller's tx: the block must survive the caller's rollback.
  await withTx(db, (tx) =>
    appendEvent(
      tx,
      sodViolationBlocked.make({
        actor: actorA,
        payload: {
          pairKey,
          actorAType: actorA.type,
          actorAId: actorA.id,
          actorBType: actorB.type,
          actorBId: actorB.id,
        },
      }),
    ),
  );
  throw new SodViolationError(pairKey);
}
```

In `auth.module.ts`, `onModuleInit` becomes:
```ts
  async onModuleInit(): Promise<void> {
    await syncPermissions(this.db, this.registry);
    await seedSodPairs(this.db);
  }
```
with `import { seedSodPairs } from "./sod";` added.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/sod"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/core
git commit -m "feat(auth): five catalog event defs; SoD pair catalog + rollback-proof violation blocking"
```

---

### Task 11: Break-glass — instant grant, loud event, review queue, guard bypass

**Files:**
- Create: `apps/core/src/kernel/auth/break-glass.ts`
- Modify: `apps/core/src/kernel/auth/guards.ts` (bypass in `PermissionGuard`), `apps/core/src/kernel/auth/auth.controller.ts` (endpoints), `apps/core/src/kernel/auth/permissions.ts` (export `requestParam`)
- Test: `apps/core/src/kernel/auth/break-glass.test.ts`, `apps/core/test/break-glass.e2e.test.ts`

**Interfaces:**
- Consumes: `breakGlassGrants` (Task 4), `breakGlassUsed` (Task 10), `CONFIG`.
- Produces (exact):
  - `useBreakGlass(db: Db, cfg: AppConfig, actor: Actor, input: { patientId?: string; reason: string }): Promise<{ grantId: string; expiresAt: Date }>` — grant + `break_glass.used` in **the same transaction** (they commit together); TTL `cfg.breakGlassTtlMinutes`.
  - `hasActiveBreakGlass(db: Db, userId: string, patientId?: string): Promise<boolean>` — a patient-specific grant covers that patient; a grant with no `patientId` covers any record (ER unknown-patient path).
  - `pendingReviews(db: Db): Promise<{ id: string; userId: string; patientId: string | null; reason: string; createdAt: Date; expiresAt: Date }[]>`; `recordReview(db: Db, grantId: string, reviewer: Actor, note: string): Promise<void>`
  - `requestParam(req: AuthedRequest, key: string): string | undefined` (exported from `permissions.ts`; `scopeCtxFromRequest` now uses it).
  - Guard behavior for `{ breakGlassBypass: true }`: when the permission check fails **and** the user holds an active grant covering `requestParam(req, "patientId")`, the request proceeds (the standing grant's event is the audit record; per-access record eventing arrives with the record surfaces in Plan 05).
  - HTTP: `POST /auth/break-glass` `{patientId?, reason}` (permission `auth.break_glass.use`, hospital) → `{grantId, expiresAt}` · `GET /auth/break-glass/pending` (permission `auth.break_glass.review`) → `{items}` · `POST /auth/break-glass/:id/review` `{note}` (same permission) → 204.

- [ ] **Step 1: Write the failing unit tests**

`apps/core/src/kernel/auth/break-glass.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { useBreakGlass, hasActiveBreakGlass, pendingReviews, recordReview } from "./break-glass";
import { loadConfig } from "../config";
import { events } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

describe("break-glass", () => {
  let db: Db; let teardown: () => Promise<void>;
  let er: { type: "user"; id: string }; // real user row — break_glass_grants.user_id is FK'd
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    const { id } = await createUser(db, { username: "er-doc", fullName: "ER Doc", password: "p1234567" });
    er = { type: "user", id };
  });
  afterAll(async () => { await teardown(); });

  it("grants instantly and events loudly in one transaction", async () => {
    const { grantId, expiresAt } = await useBreakGlass(db, cfg, er, { patientId: "P1", reason: "unconscious ER arrival" });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const rows = await db.select().from(events).where(eq(events.name, "break_glass.used"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBe("P1");
    expect((rows[0]!.payload as { grantId: string }).grantId).toBe(grantId);
  });

  it("scopes active grants to the granted patient; null covers any", async () => {
    await useBreakGlass(db, cfg, er, { patientId: "P1", reason: "r" });
    expect(await hasActiveBreakGlass(db, er.id, "P1")).toBe(true);
    expect(await hasActiveBreakGlass(db, er.id, "P2")).toBe(false);
    expect(await hasActiveBreakGlass(db, "someone-else", "P1")).toBe(false);
    await useBreakGlass(db, cfg, er, { reason: "unknown patient" });
    expect(await hasActiveBreakGlass(db, er.id, "P2")).toBe(true);
  });

  it("review queue lists unreviewed grants and closes on review", async () => {
    const { grantId } = await useBreakGlass(db, cfg, er, { patientId: "P1", reason: "r" });
    expect(await pendingReviews(db)).toHaveLength(1);
    await recordReview(db, grantId, { type: "user", id: "reviewer-1" }, "justified");
    expect(await pendingReviews(db)).toHaveLength(0);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/break-glass"`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`apps/core/src/kernel/auth/break-glass.ts`:
```ts
import { and, eq, gt, isNull } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { breakGlassGrants } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { breakGlassUsed } from "./events";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export async function useBreakGlass(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  input: { patientId?: string; reason: string },
): Promise<{ grantId: string; expiresAt: Date }> {
  const grantId = newId();
  const expiresAt = new Date(Date.now() + cfg.breakGlassTtlMinutes * 60_000);
  await withTx(db, async (tx) => {
    await tx.insert(breakGlassGrants).values({
      id: grantId,
      userId: actor.id,
      patientId: input.patientId ?? null,
      reason: input.reason,
      expiresAt,
    });
    await appendEvent(
      tx,
      breakGlassUsed.make({
        actor,
        patientId: input.patientId,
        payload: { grantId, patientId: input.patientId, reason: input.reason, expiresAt: expiresAt.toISOString() },
      }),
    );
  });
  return { grantId, expiresAt };
}

export async function hasActiveBreakGlass(db: Db, userId: string, patientId?: string): Promise<boolean> {
  const rows = await db
    .select({ patientId: breakGlassGrants.patientId })
    .from(breakGlassGrants)
    .where(and(eq(breakGlassGrants.userId, userId), gt(breakGlassGrants.expiresAt, new Date())));
  return rows.some((g) => g.patientId === null || (patientId !== undefined && g.patientId === patientId));
}

export type BreakGlassReviewItem = {
  id: string; userId: string; patientId: string | null; reason: string; createdAt: Date; expiresAt: Date;
};

export async function pendingReviews(db: Db): Promise<BreakGlassReviewItem[]> {
  return db
    .select({
      id: breakGlassGrants.id,
      userId: breakGlassGrants.userId,
      patientId: breakGlassGrants.patientId,
      reason: breakGlassGrants.reason,
      createdAt: breakGlassGrants.createdAt,
      expiresAt: breakGlassGrants.expiresAt,
    })
    .from(breakGlassGrants)
    .where(isNull(breakGlassGrants.reviewedAt))
    .orderBy(breakGlassGrants.createdAt);
}

export async function recordReview(db: Db, grantId: string, reviewer: Actor, note: string): Promise<void> {
  await db
    .update(breakGlassGrants)
    .set({ reviewedAt: new Date(), reviewedBy: reviewer.id, reviewNote: note })
    .where(eq(breakGlassGrants.id, grantId));
}
```

In `permissions.ts`, rename the private `pickScopeValue` to an exported `requestParam` (same body, same lookup order params → query → body) and update `scopeCtxFromRequest` to use it.

In `guards.ts` (`PermissionGuard`), the failure branch becomes:
```ts
    if (!allowed) {
      const bypass =
        requirement.breakGlassBypass === true &&
        (await hasActiveBreakGlass(this.db, actor.id, requestParam(req, "patientId")));
      if (!bypass) throw new ForbiddenException(`missing permission ${requirement.permission}`);
    }
```
with `import { hasActiveBreakGlass } from "./break-glass";` and `requestParam` added to the `./permissions` import. The `secondFactor` block from Task 9 stays after this and still applies on the bypass path.

Add to `auth.controller.ts` (imports: `useBreakGlass`, `pendingReviews`, `recordReview`, `RequirePermission`, `Param`; types as needed):
```ts
  @RequirePermission("auth.break_glass.use", "hospital")
  @Post("break-glass")
  async breakGlass(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
  ): Promise<{ grantId: string; expiresAt: string }> {
    const parsed = z.object({ patientId: z.string().min(1).optional(), reason: z.string().min(3) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { grantId, expiresAt } = await useBreakGlass(this.db, this.cfg, actor, parsed.data);
    return { grantId, expiresAt: expiresAt.toISOString() };
  }

  @RequirePermission("auth.break_glass.review", "hospital")
  @Get("break-glass/pending")
  async breakGlassPending(): Promise<{ items: Awaited<ReturnType<typeof pendingReviews>> }> {
    return { items: await pendingReviews(this.db) };
  }

  @RequirePermission("auth.break_glass.review", "hospital")
  @Post("break-glass/:id/review")
  @HttpCode(204)
  async breakGlassReview(
    @CurrentActor() actor: Actor,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = z.object({ note: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    await recordReview(this.db, id, actor, parsed.data.note);
  }
```

- [ ] **Step 3: Failing e2e, then pass**

`apps/core/test/break-glass.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { Controller, Get, INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, assignRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { useBreakGlass } from "../src/kernel/auth/break-glass";
import { RequirePermission } from "../src/kernel/auth/decorators";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

@Controller("record-test")
class RecordTestController {
  @RequirePermission("auth.users.manage", "hospital", { breakGlassBypass: true })
  @Get("patient/:patientId")
  read(): { ok: boolean } { return { ok: true }; }
}

describe("break-glass e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RecordTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => { await truncateAll(db); await syncPermissions(db, registry); });
  afterAll(async () => { await app.close(); await teardown(); });

  it("active grant bypasses a missing permission for that patient only", async () => {
    const { id } = await createUser(db, { username: "er1", fullName: "ER", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    await request(app.getHttpServer())
      .get("/record-test/patient/P1").set("Authorization", `Bearer ${token}`).expect(403);
    await useBreakGlass(db, cfg, { type: "user", id }, { patientId: "P1", reason: "emergency" });
    await request(app.getHttpServer())
      .get("/record-test/patient/P1").set("Authorization", `Bearer ${token}`).expect(200);
    await request(app.getHttpServer())
      .get("/record-test/patient/P2").set("Authorization", `Bearer ${token}`).expect(403);
  });

  it("the endpoint needs auth.break_glass.use; review needs auth.break_glass.review", async () => {
    const { id } = await createUser(db, { username: "er2", fullName: "ER", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);
    await request(app.getHttpServer())
      .post("/auth/break-glass").set("Authorization", `Bearer ${token}`)
      .send({ patientId: "P1", reason: "emergency" }).expect(403);

    await createRole(db, "er-staff", "ER Staff");
    await grantPermissionToRole(db, registry, "er-staff", "auth.break_glass.use");
    await assignRole(db, { userId: id, roleKey: "er-staff", scopeType: "hospital" });
    const res = await request(app.getHttpServer())
      .post("/auth/break-glass").set("Authorization", `Bearer ${token}`)
      .send({ patientId: "P1", reason: "emergency" }).expect(201);
    expect(res.body.grantId).toHaveLength(26);

    await request(app.getHttpServer())
      .get("/auth/break-glass/pending").set("Authorization", `Bearer ${token}`).expect(403);
    await grantPermissionToRole(db, registry, "er-staff", "auth.break_glass.review");
    const pending = await request(app.getHttpServer())
      .get("/auth/break-glass/pending").set("Authorization", `Bearer ${token}`).expect(200);
    expect(pending.body.items).toHaveLength(1);
    await request(app.getHttpServer())
      .post(`/auth/break-glass/${res.body.grantId}/review`)
      .set("Authorization", `Bearer ${token}`).send({ note: "justified" }).expect(204);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "break-glass"`
Expected: PASS (unit 3, e2e 2).

- [ ] **Step 4: Full suite + commit**

Run: `pnpm verify`
Expected: PASS.

```bash
git add apps/core
git commit -m "feat(auth): break-glass grants with loud events, review queue, guarded bypass"
```

---

### Task 12: Temp roles & emergency elevation + expiry sweep + README

**Files:**
- Create: `apps/core/src/kernel/auth/temp-roles.ts`
- Modify: `apps/core/src/kernel/auth/auth.controller.ts` (endpoints), `README.md`
- Test: `apps/core/src/kernel/auth/temp-roles.test.ts`, `apps/core/test/temp-roles.e2e.test.ts`

**Interfaces:**
- Consumes: `tempRoleGrants` (Task 4; already consulted by `hasPermission` from Task 8), events (Task 10), `CONFIG`.
- Produces (exact):
  - `grantTempRole(db: Db, cfg: AppConfig, grantor: Actor, input: { userId: string; roleKey: string; reason: string; ttlMinutes: number }): Promise<{ grantId: string; expiresAt: Date }>` — kind `"granted"`, TTL capped at `cfg.tempRoleMaxTtlMinutes`, `temp_role.granted` in the same tx; **self-grant throws** (that path is `emergencyElevate`).
  - `emergencyElevate(db: Db, cfg: AppConfig, actor: Actor, input: { roleKey: string; reason: string; ttlMinutes: number }): Promise<{ grantId: string; expiresAt: Date }>` — kind `"emergency"`, emits `emergency_elevation.used` **and** `temp_role.granted` in one tx (S10 mechanism 6: break-glass for actions, loud, mandatory review rides the digest/report side in Plan 12).
  - `sweepExpiredTempRoles(db: Db): Promise<number>` — for each grant past expiry with `expiredEventAt` null: emit `temp_role.expired` + stamp, one tx per grant. **Scheduling is deliberately deferred to Plan 11** (same pattern as `runDispatchCycle`); enforcement never depends on the sweep because `hasPermission` filters on `expiresAt > now()`.
  - HTTP: `POST /auth/temp-roles` `{userId, roleKey, reason, ttlMinutes}` (permission `auth.temp_role.grant`, hospital) → `{grantId, expiresAt}` · `POST /auth/emergency-elevation` `{roleKey, reason, ttlMinutes}` (any authenticated **user** — loud by design) → `{grantId, expiresAt}`.

- [ ] **Step 1: Write the failing unit tests**

`apps/core/src/kernel/auth/temp-roles.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { createUser } from "./identity";
import { createRole, grantPermissionToRole, hasPermission, syncPermissions } from "./permissions";
import { grantTempRole, emergencyElevate, sweepExpiredTempRoles } from "./temp-roles";
import { authManifest } from "./manifest";
import { ModuleRegistry } from "../modules/loader";
import { loadConfig } from "../config";
import { events, tempRoleGrants } from "../db/schema";
import type { Db } from "../db/client";

const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });
const registry = new ModuleRegistry();
registry.install(authManifest);

describe("temp roles", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
  });
  afterAll(async () => { await teardown(); });

  it("grants a temp role, events it, and the permission takes effect", async () => {
    const { id: grantee } = await createUser(db, { username: "g", fullName: "G", password: "p1234567" });
    const grantor = { type: "user" as const, id: "01HGRANTOR000000000000000A" };
    const { grantId } = await grantTempRole(db, cfg, grantor, {
      userId: grantee, roleKey: "reviewer", reason: "night cover", ttlMinutes: 60,
    });
    expect(await hasPermission(db, grantee, "auth.break_glass.review", "hospital")).toBe(true);
    const evts = await db.select().from(events).where(eq(events.name, "temp_role.granted"));
    expect(evts).toHaveLength(1);
    expect((evts[0]!.payload as { grantId: string }).grantId).toBe(grantId);
  });

  it("caps TTL at the configured maximum", async () => {
    const { id: grantee } = await createUser(db, { username: "g2", fullName: "G", password: "p1234567" });
    const { expiresAt } = await grantTempRole(db, cfg, { type: "user", id: "x" }, {
      userId: grantee, roleKey: "reviewer", reason: "r", ttlMinutes: 999999,
    });
    const maxMs = cfg.tempRoleMaxTtlMinutes * 60_000;
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(maxMs + 1000);
  });

  it("self-grant must go through emergencyElevate", async () => {
    const { id } = await createUser(db, { username: "g3", fullName: "G", password: "p1234567" });
    await expect(
      grantTempRole(db, cfg, { type: "user", id }, { userId: id, roleKey: "reviewer", reason: "r", ttlMinutes: 10 }),
    ).rejects.toThrow(/emergencyElevate/);
  });

  it("emergency elevation emits both events and confers the role", async () => {
    const { id } = await createUser(db, { username: "g4", fullName: "G", password: "p1234567" });
    await emergencyElevate(db, cfg, { type: "user", id }, { roleKey: "reviewer", reason: "duty manager unreachable", ttlMinutes: 30 });
    expect(await hasPermission(db, id, "auth.break_glass.review", "hospital")).toBe(true);
    expect(await db.select().from(events).where(eq(events.name, "emergency_elevation.used"))).toHaveLength(1);
    expect(await db.select().from(events).where(eq(events.name, "temp_role.granted"))).toHaveLength(1);
  });

  it("sweep emits temp_role.expired exactly once per lapsed grant", async () => {
    const { id } = await createUser(db, { username: "g5", fullName: "G", password: "p1234567" });
    await db.insert(tempRoleGrants).values({
      id: "01HGRANTEXPIRED0000000000A", userId: id, roleKey: "reviewer", grantedBy: "x",
      kind: "granted", reason: "r", expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await sweepExpiredTempRoles(db)).toBe(1);
    expect(await sweepExpiredTempRoles(db)).toBe(0); // idempotent
    expect(await db.select().from(events).where(eq(events.name, "temp_role.expired"))).toHaveLength(1);
    expect(await hasPermission(db, id, "auth.break_glass.review", "hospital")).toBe(false); // enforcement was already inline
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "auth/temp-roles"`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`apps/core/src/kernel/auth/temp-roles.ts`:
```ts
import { and, eq, isNull, lte } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { tempRoleGrants } from "../db/schema";
import { appendEvent } from "../events/append";
import { withTx } from "../db/client";
import { emergencyElevationUsed, tempRoleGranted, tempRoleExpired } from "./events";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";

export async function grantTempRole(
  db: Db,
  cfg: AppConfig,
  grantor: Actor,
  input: { userId: string; roleKey: string; reason: string; ttlMinutes: number },
): Promise<{ grantId: string; expiresAt: Date }> {
  if (grantor.type === "user" && grantor.id === input.userId) {
    throw new Error("self-grant is not allowed here — use emergencyElevate, which events emergency_elevation.used");
  }
  const ttl = Math.min(input.ttlMinutes, cfg.tempRoleMaxTtlMinutes);
  const grantId = newId();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  await withTx(db, async (tx) => {
    await tx.insert(tempRoleGrants).values({
      id: grantId, userId: input.userId, roleKey: input.roleKey,
      grantedBy: grantor.id, kind: "granted", reason: input.reason, expiresAt,
    });
    await appendEvent(
      tx,
      tempRoleGranted.make({
        actor: grantor,
        payload: {
          grantId, userId: input.userId, roleKey: input.roleKey,
          grantedBy: grantor.id, kind: "granted", reason: input.reason,
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
  });
  return { grantId, expiresAt };
}

export async function emergencyElevate(
  db: Db,
  cfg: AppConfig,
  actor: Actor,
  input: { roleKey: string; reason: string; ttlMinutes: number },
): Promise<{ grantId: string; expiresAt: Date }> {
  const ttl = Math.min(input.ttlMinutes, cfg.tempRoleMaxTtlMinutes);
  const grantId = newId();
  const expiresAt = new Date(Date.now() + ttl * 60_000);
  await withTx(db, async (tx) => {
    await tx.insert(tempRoleGrants).values({
      id: grantId, userId: actor.id, roleKey: input.roleKey,
      grantedBy: actor.id, kind: "emergency", reason: input.reason, expiresAt,
    });
    await appendEvent(
      tx,
      emergencyElevationUsed.make({
        actor,
        payload: { grantId, roleKey: input.roleKey, reason: input.reason, expiresAt: expiresAt.toISOString() },
      }),
    );
    await appendEvent(
      tx,
      tempRoleGranted.make({
        actor,
        payload: {
          grantId, userId: actor.id, roleKey: input.roleKey,
          grantedBy: actor.id, kind: "emergency", reason: input.reason,
          expiresAt: expiresAt.toISOString(),
        },
      }),
    );
  });
  return { grantId, expiresAt };
}

export async function sweepExpiredTempRoles(db: Db): Promise<number> {
  const due = await db
    .select()
    .from(tempRoleGrants)
    .where(and(lte(tempRoleGrants.expiresAt, new Date()), isNull(tempRoleGrants.expiredEventAt)));
  for (const grant of due) {
    await withTx(db, async (tx) => {
      await appendEvent(
        tx,
        tempRoleExpired.make({
          actor: { type: "system", id: "temp-role-sweep" },
          payload: { grantId: grant.id, userId: grant.userId, roleKey: grant.roleKey },
        }),
      );
      await tx.update(tempRoleGrants).set({ expiredEventAt: new Date() }).where(eq(tempRoleGrants.id, grant.id));
    });
  }
  return due.length;
}
```

Add to `auth.controller.ts` (imports: `grantTempRole`, `emergencyElevate`):
```ts
  @RequirePermission("auth.temp_role.grant", "hospital")
  @Post("temp-roles")
  async tempRole(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ grantId: string; expiresAt: string }> {
    const parsed = z.object({
      userId: z.string().min(1), roleKey: z.string().min(1),
      reason: z.string().min(3), ttlMinutes: z.number().int().positive(),
    }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { grantId, expiresAt } = await grantTempRole(this.db, this.cfg, actor, parsed.data);
    return { grantId, expiresAt: expiresAt.toISOString() };
  }

  @Post("emergency-elevation")
  async emergencyElevation(@CurrentActor() actor: Actor, @Body() body: unknown): Promise<{ grantId: string; expiresAt: string }> {
    const parsed = z.object({
      roleKey: z.string().min(1), reason: z.string().min(3), ttlMinutes: z.number().int().positive(),
    }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    if (actor.type !== "user") throw new ForbiddenException("emergency elevation is for human users");
    const { grantId, expiresAt } = await emergencyElevate(this.db, this.cfg, actor, parsed.data);
    return { grantId, expiresAt: expiresAt.toISOString() };
  }
```

- [ ] **Step 3: Failing e2e, then pass**

`apps/core/test/temp-roles.e2e.test.ts`:
```ts
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { setupTestDb, truncateAll } from "./helpers/db";
import { createUser } from "../src/kernel/auth/identity";
import { createSession } from "../src/kernel/auth/sessions";
import { createRole, grantPermissionToRole, syncPermissions } from "../src/kernel/auth/permissions";
import { authManifest } from "../src/kernel/auth/manifest";
import { ModuleRegistry } from "../src/kernel/modules/loader";
import { loadConfig, requireEnv } from "../src/kernel/config";
import type { Db } from "../src/kernel/db/client";

describe("temp roles e2e", () => {
  let app: INestApplication;
  let db: Db; let teardown: () => Promise<void>;
  const registry = new ModuleRegistry();
  registry.install(authManifest);
  const cfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
    const workerUrl = new URL(requireEnv("TEST_DATABASE_URL"));
    workerUrl.pathname = `${workerUrl.pathname}_${process.env.JEST_WORKER_ID ?? "1"}`;
    process.env.DATABASE_URL = workerUrl.toString();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  beforeEach(async () => {
    await truncateAll(db);
    await syncPermissions(db, registry);
    await createRole(db, "reviewer", "Reviewer");
    await grantPermissionToRole(db, registry, "reviewer", "auth.break_glass.review");
  });
  afterAll(async () => { await app.close(); await teardown(); });

  it("temp-role grants need the permission; emergency elevation is open and takes effect", async () => {
    const { id } = await createUser(db, { username: "night", fullName: "N", password: "p1234567" });
    const { token } = await createSession(db, cfg, id);

    await request(app.getHttpServer())
      .post("/auth/temp-roles").set("Authorization", `Bearer ${token}`)
      .send({ userId: "someone", roleKey: "reviewer", reason: "cover", ttlMinutes: 30 }).expect(403);

    await request(app.getHttpServer())
      .post("/auth/emergency-elevation").set("Authorization", `Bearer ${token}`)
      .send({ roleKey: "reviewer", reason: "duty manager unreachable", ttlMinutes: 30 }).expect(201);

    // The elevated role's permission now passes on a guarded route:
    await request(app.getHttpServer())
      .get("/auth/break-glass/pending").set("Authorization", `Bearer ${token}`).expect(200);
  });
});
```

Run: `pnpm --filter @hmis/core test -- --testPathPattern "temp-roles"`
Expected: PASS (unit 5, e2e 1).

- [ ] **Step 4: README + full verify**

Append to `README.md`:
```markdown
## Auth bootstrap
1. Copy `apps/core/.env.example` → `apps/core/.env` and fill it (`openssl rand -hex 32` for `SECRET_KEY`); `chmod 600`.
2. `pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core seed:admin` (reads `ADMIN_*` from the env)
4. Agents: `pnpm --filter @hmis/core agent:create` (reads `AGENT_NAME`; prints the API key once)
```

Run: `pnpm verify`
Expected: PASS — full suite green, zero lint problems.

- [ ] **Step 5: Commit**

```bash
git add apps/core README.md
git commit -m "feat(auth): temp role grants, emergency elevation, expiry sweep; auth bootstrap docs"
```

---

## Self-Review Notes

- **Spec coverage (this plan's slice):** §14 permissions as action+scope with roles per department/floor ✓ (T4, T8) · §14 second factor for money/signature classes as guard option ✓ (T9) · D-27 signature-class 2FA mechanism ✓ (T9; class assignment happens at each route in later plans) · §14 break-glass instant + loud + review queue ✓ (T11) · §11.18 lock 6 no shared accounts + PIN/badge fast switch, perf-proven ✓ (T5–T7) · §16/§14 agents as first-class actors with credentials + kill switch ✓ (T6, T7) · S10 §11 SoD hard pairs RBAC-enforced with `sod.violation_blocked` ✓ (T10) · S10 mechanism 6 emergency elevation ✓ (T12) · S10 mechanism 3 same-hour revoke hook (`revokeUserSessions`, `deactivateUser`) ✓ (T5, T6) · roadmap items absorbed: config loader + fallback retirement ✓ (T1), pool leak 2b ✓ (T2), registry-consumed permissions ✓ (T8), HMAC pull-forward ✓ (T3, owner-approved). Deliberately out of scope (per roadmap): approvals-engine consumers (Plan 04), sealed-class data rules and record surfaces (Plan 05+), agent permission grants + tier config (Plan 12 — additive `agent_permissions` table), scheduling of `sweepExpiredTempRoles` (Plan 11), full roster/witness validation (Phase-2 roster module; substrate seam noted in roadmap E-7).
- **Catalog discipline:** exactly five event names minted — `break_glass.used`, `sod.violation_blocked`, `emergency_elevation.used`, `temp_role.granted`, `temp_role.expired` — all in §10.6's catalog. Logins/switches are *not* evented (no such catalog names); `auth_sessions` rows are the access log until the spec says otherwise.
- **Type consistency:** `loadConfig` (T1) feeds `CONFIG` (T2) consumed by T5/T6/T9/T11/T12 signatures as `AppConfig` · `Actor` from contracts is the single actor shape in `CurrentActor`, `assertNotSodPair`, `useBreakGlass`, `grantTempRole` · `assertNotSodPair(db, pairKey, actorA, actorB)` matches the roadmap's Plan-04 consumption (db-first because the event must outlive the caller's tx — documented in T10) · `hasPermission`'s temp-grant union (T8) is what makes T12's grants effective with no further wiring · `setupTestDb`/`truncateAll` keep their Plan-01 signatures (truncate list extended only).
- **Placeholders:** none — every step carries runnable code or exact commands.
- **Verify-by-execution flags (Plan-01 lesson — prove these by running, not by reading):** ① `argon2` native module install on the server (prebuilt binary path) — prove with the identity tests, not `pnpm install` alone; ② `otplib` v12 API names (`authenticator.generateSecret/keyuri/check/generate`) — prove in T9's red→green cycle; ③ drizzle `onConflictDoUpdate` on text-PK tables and the `sql\`${users.badgeVersion} + 1\`` returning-update — prove in T5/T8 tests against the live DB; ④ Nest 11 + express 5 types (`AuthedRequest`, global `APP_GUARD` ordering AuthGuard→PermissionGuard) — prove in T7/T8 e2e; ⑤ zod is now a dependency of two packages — if `defineEvent` payload schemas typecheck oddly across package boundaries, dedupe to a single zod version in the lockfile before fighting types; ⑥ `process.env` mutation order in e2e files (worker-DB URL set *before* `Test.createTestingModule`) — the e2e tests themselves are the proof; ⑦ no CI file changes are needed — confirm by observing the first push's CI run green (TEST_DATABASE_URL is already in the workflow; SECRET_KEY comes from the jest setupFile).
- **Shared-host & pipeline notes (copy into briefs):** all standing rules from the roadmap §Standing execution rules apply; additionally for this plan — the server-only `.env` creation step (T1) is environment setup, not committed code; `pnpm install` will compile/download argon2 — stay inside `/opt/hmis`; do not touch `.github/workflows/*` (no change is needed; if an agent believes one is, halt and report instead).
