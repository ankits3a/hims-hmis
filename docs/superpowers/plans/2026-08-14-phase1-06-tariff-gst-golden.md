# Plan 06 — Tariff, Adjustment & GST Engine + Golden Suite · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**STATUS: WRITTEN 2026-08-14, awaiting owner approval. PLANNING ONLY — no execution has occurred.**

**Goal:** Ship the pure, deterministic pricing engine for Phase-1 billing — service master, versioned tariffs with the tariff-lock rule, the best-single-benefit adjustment contest behind a fixed `AdjustmentSource` plugin interface, GST computation with the exemption-boundary logic, regulated-price hard blocks (C-3), tariff-revision workflow through the shipped approvals engine (§11.11), impact simulation, and the CI-gated golden suite whose every expected value is hand-computed from the spec in this document (§18, D-17).

**Architecture:** One new domain module `apps/core/src/modules/tariff/` (the second real subject of the module-isolation rule, after patients). The heart is `priceInvoiceLines(ctx, items): PricedLine[]` — a **synchronous, pure** function: everything it needs arrives in a `PricingContext` built by a separate impure loader, so golden tests are hermetic (no database, no clock, no randomness). Tariffs are version-header + immutable-items; adjustments contest per line under best-single-benefit with a deterministic tie-break and a full audit record of losing candidates (D-8); GST is exemption-boundary logic over CA-configured data (D-3, §19); revision rides Plan 04's shipped approvals engine exactly the way Plan 05's merge does (request-on-submit, check-on-execute at activation).

**Tech Stack:** Existing only — TypeScript strict, NestJS ^11, drizzle-orm ^0.40 / drizzle-kit ^0.30, zod ^4, pg, Jest + ts-jest. **Zero new dependencies, zero env vars, zero CI changes.**

**Consumers:** Plan 08 (billing counter) imports `priceInvoiceLines` + `loadPricingContext` from this module's index and issues immutable invoices from `PricedLine[]`. Plan 09 (memberships/coupons) registers two more `AdjustmentSource`s against the interface **fixed here** and adds contest fixtures to **this** golden harness. Plan 07 consumes nothing from this plan (05∥06 by the roadmap's sequencing).

---

## Global Constraints

Copied from the roadmap globals + spec, binding on every task:

- **Money is integer PAISE, always** — `bigint("…", { mode: "number" })` columns (Plan 04 precedent `approvals.amountPaise`, schema/approvals.ts:44), `Number.isSafeInteger` guards, **no floats anywhere in pricing, ever; no `z.coerce` anywhere in this module** (ledger §3.19 — coercion at a money boundary is a live logic bug).
- **`priceInvoiceLines` and `simulateRevision` are PURE and SYNCHRONOUS.** The files `pricing.ts`, `gst.ts`, `contest.ts`, `simulation.ts`, `money.ts`, `types.ts` contain **no `await`, no import from `kernel/db`, no `new Date()` calls, no `Math.random`**. Loading the context is `context.ts`'s job and is impure by design.
- **Exactly ONE migration** — `0007_*`, generated in Task 1 by `pnpm db:generate`, never edited by hand, no schema change in any later task (a needed change is a plan defect to report, not to fix silently).
- Events append-only, `entity.verb_past`, full §10.5 envelope via `defineEvent(...).make(...)`; **exactly two new catalog names**: `tariff.revision_applied` (S5, §11.11) and `config.validated` (D-17). Nothing else emits from this module in this plan.
- Module isolation: later modules import **only** `modules/tariff/index.ts` or consume events. Kernel imports are unrestricted (shipped lint rule, eslint.config.mjs:21-32).
- GST rates, thresholds, SAC codes are **CA-configured data** (gst_config/gst_settings rows), never literals in engine code (§19 gate, D-3). Dev seeds carry placeholder values with `caSigned=false`.
- Append-only money surfaces: `tariff_items` are immutable once their version leaves `draft`; `regulated_prices` is insert-only (corrections = new effective-dated rows, E-8 spirit); activated versions are never edited or deleted.
- TypeScript strict + `noUncheckedIndexedAccess` (tsconfig.base.json:7) — all index access in plan code is guarded.
- Perf: pricing is O(lines × rules) pure arithmetic; no perf gate this plan (no query in the hot path). The engine must price 10,000 lines in well under a second incidentally, but no CI budget is added.
- `packages/contracts` and `apps/web` are **byte-untouched** this plan. `modules/patients` is read-only. `qr.test.ts`'s latent 1-in-4096 flake (gate report §7.6) belongs to a future task that owns that file — **do not touch it**.

---

## The §3.14 rule this plan is built around

The ledger's most recurrent defect class (§3.14/§3.14b/§3.14c/§5.4 — four instances in three pipelines) is **an assertion that passes for the wrong reason**. A golden suite whose expected values were produced by running the implementation is that defect at plan scale: it passes on day one no matter how wrong the pricing is, and locks the bug in. Therefore:

1. **Every expected value in every fixture in this plan was hand-computed from the spec's rules, and the arithmetic is shown in this document** (the Fixture Book below). A reviewer can check every number without running anything.
2. Every fixture file carries a mandatory `workings` string per line reproducing that arithmetic; **the harness fails any fixture whose `workings` is missing or empty**.
3. Every fixture names, in this document, **which wrong implementation it kills** — no fixture where both the right and a wrong implementation produce the same observable: no discount test with zero discount, no exempt test where the taxable answer is numerically identical, no rounding test whose value rounds the same way under half-up, truncation, and banker's.
4. "The expected value was derived independently of the implementation" is an **acceptance criterion on Task 6** that the gate can check: the workings must reproduce the expected number from the fixture's own inputs by the rules in this document, and any mismatch between workings and expectation fails the task.

---

## Consumed shipped surfaces (scout-verified against source at 800a28d)

Transcribed from shipped source by read-only scouts this session — not from memory, not from plan text.

| Surface | Signature (verbatim) | Where |
|---|---|---|
| Db/Tx/withTx | `export type Db = NodePgDatabase<typeof schema>` · `export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]` · `withTx<T>(db, fn)` | kernel/db/client.ts:5-16 |
| appendEvent | `appendEvent(tx: Tx, input: EventInput): Promise<{ eventId: string; seq: number }>` | kernel/events/append.ts:6-9 |
| defineEvent | `defineEvent(name, module, payloadSchema, version = 1)` returning `{ name, module, version, payloadSchema, make(args) }`; `make` fills `occurredAt ?? new Date()`, `siteId ?? "main"` | contracts/src/envelope.ts:42-74 |
| newId / Actor | `newId(): string` (ulid) · `Actor = { type: "user"\|"agent"\|"system"; id: string }` | contracts/src/ids.ts:8-10, envelope.ts:3 |
| requestApproval | `requestApproval(tx: Tx, requester: Actor, input: ApprovalRequestInput): Promise<{ approvalId; instanceId }>` — input takes `typeKey`, `subject {type,id}`, optional `patientId/encounterId/payeeId/amountPaise/requestNote/actFirst` | kernel/approvals/requests.ts:13-34 |
| getApproval | `getApproval(db: Db, approvalId: string): Promise<ApprovalRow \| null>` — `status: 'pending'\|'granted'\|'rejected'` | kernel/approvals/worklist.ts:84-87 |
| registerApprovalType | `registerApprovalType(db, actor, spec): Promise<{ typeKey; defKey }>` | kernel/approvals/types.ts:55-59 |
| approve/rejectRequest | `approveRequest(db: Db, actor: Actor, input: DecisionInput)` · `DecisionInput = { approvalId: string; note: string }` — **note is required** | kernel/approvals/decisions.ts:16,92-98 |
| createDb | `createDb(url: string): { db: Db; pool: Pool }` (scripts) | kernel/db/client.ts:8-12 |
| approvalFlowDefinition | `approvalFlowDefinition(spec: ApprovalFlowSpec): WorkflowDefinition` — **exactly one approver role**, pending → granted/rejected | kernel/approvals/flow.ts:31-55 |
| Workflow governance | `createDraft(db, drafter, def)` → `activateDefinition(db, activator, draft.definitionId)` (drafter ≠ activator), exactly as merge.test.ts:55-68 drives them | kernel/workflow/definitions.ts |
| Check-on-execute pattern | read row → `getApproval` → `status !== "granted"` throws → `withTx` single-winner conditional UPDATE | modules/patients/merge.ts:85-102 |
| ModuleManifest | `{ key, title, menu[], permissions[], subscriptions[] }`; registered via `app.module.ts` imports array + `registry.install(manifest)` | kernel/modules/manifest.ts:1-7, app.module.ts:10/23/41 |
| Config-as-data precedent | `registration_config` single row `id='main'`, seeded by upsert script, read per-use with loud missing-row error | schema/patients.ts:22-27, modules/patients/uhid.ts:109-124 |
| Money precedent | `amountPaise: bigint("amount_paise", { mode: "number" })` + "Money is integer PAISE" comment | schema/approvals.ts:28,44-46 |
| truncateAll | five statements; patients group is the model for adding one new statement | test/helpers/db.ts:51-68 |
| E2E bootstrap | `Test.createTestingModule({ imports: [AppModule] })` → `createNestApplication<NestExpressApplication>({ bodyParser: false })` (single-arg overload — §3.17!) → `configureApp(app)` → Bearer-token helper | test/patients.e2e.test.ts:35-70 |
| Error mapping | `toHttp(e): never` — module error class → Nest exceptions; `ApprovalError` (kernel/approvals/types), `WorkflowError` (kernel/workflow/instances) → 409; unrecognized rethrow | modules/patients/patients.controller.ts:9-11,34-47 |
| Seed convention | tsx script, `requireEnv`, idempotent `onConflictDoUpdate`, `main().catch(…exit(1))` | scripts/seed-registration.ts |
| Jest | `testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"]`, per-worker DBs via `setupTestDb()`, `test/helpers/env.ts` setupFile | jest.config.cjs, test/helpers/db.ts:31-49 |

**Baseline for every brief (§2.6): "the previous task's commit, i.e. current `origin/main`."** Per-workspace test baseline entering this plan: `apps/core` 54 suites / 269 tests (`packages/contracts` 3/7 and `apps/web` 11/37 are untouched by this plan).

---

## Design law for this module (normative — the Fixture Book derives from these rules)

Owner decisions resolved in-conversation 2026-08-14 (all eight): per-line half-up paise rounding · version-header + immutable items · best-single-benefit with full-contest recording and source-order tie-break · module home `modules/tariff` · GST as CA-flagged config data · synchronous pure simulation with caller-supplied lines · JSON golden fixtures with mandatory workings · approvals wired now, single-key v1.

### D1 — Money arithmetic
All amounts are non-negative integer **paise**. One rounding primitive, defined once in `money.ts` and used everywhere:

```
divHalfUp(n, d) = floor((2n + d) / (2d))     // round(n/d), halves away from zero; n ≥ 0, d > 0, integers
percent amount   = divHalfUp(gross × bps, 10000)
per-head GST     = divHalfUp(base × rateBps, 20000)      // CGST and SGST computed INDEPENDENTLY, each half-up
rupee rounding   = divHalfUp(total, 100) × 100           // CGST-Act-§170 invoice-total helper; applied by Plan 08
```

CGST and SGST are computed per head, not total-then-split (fixture G02 separates the two policies). Cap/approval **governance checks use exact rational comparison, never rounding**: over-cap ⇔ `amount × 10000 > maxBps × gross`; needs-approval ⇔ `amount × 10000 > approvalAboveBps × gross`.

### D2 — Per-line pricing order (frozen)
1. Resolve service; inactive/unknown service or missing tariff item → typed error.
2. **C-3 regulated clamp:** `unit = min(tariff, MRP, ceiling)` over the bounds present; regulated service with no effective `regulated_prices` row → error `regulated_price_missing`. The hard block **is** the min — no path may exceed the ceiling. Clamp recorded (`boundApplied: "mrp"|"ceiling"`) only when `unit < tariff`; ties go to tariff.
3. `gross = unit × qty` (qty is a positive integer).
4. **Adjustment contest** (D3) on gross → winner; `discount = winner?.amountPaise ?? 0`; `taxableBase = gross − discount`. Candidates are pre-capped at gross.
5. **GST decision** (D4) on `taxableBase`.
6. `net = taxableBase + cgst + sgst`.

### D3 — Adjustment contest (best-single-benefit, §7)
Each `AdjustmentSource` in `ctx.sources` proposes zero or more candidates per line (pure, sync). Sources shipped here: `standingRuleSource` (key `"rule"` — data-backed rows: percent/flat, D-8 `discountCategory`, optional `requiredTag` matched against `ctx.tags`, optional `serviceCategory`/`serviceId` scope, validity window resolved by the loader) and `manualDiscountSource` (key `"manual"` — proposes from `line.manualDiscount`, validates against the D-8 per-category caps config; over-cap or unknown-category candidates are **recorded as rejected**, never silently clamped or dropped). Plan 09 registers `"coupon"` and `"membership"` against the same interface.

**Winner:** largest `amountPaise` among candidates with `rejected === null` and `amountPaise > 0`. **Tie-break:** earlier source in `ctx.sources` order (fixed here as `["rule", "manual"]` — a documented standing scheme beats an ad-hoc manual entry of equal value, D-8 defensibility), then `ruleKey` ascending, nulls last. The `PricedLine` records the winner **and the full candidate list including rejected ones** — the audit answer to "why this rate", and the surface golden fixtures assert on.

### D4 — GST exemption boundary (D-3), in decision order
1. `line.supplyContext === "composite_healthcare"` and `gst_settings.compositeHealthcareExempt` → **exempt**, reason `composite_healthcare` (IPD composite supply; the caller sets the context — Plan 08/IPD).
2. Category config `exempt: true` → **exempt**, reason `category_exempt` (healthcare exemption). **Exempt categories still carry their would-be `rateBps` in config** — deliberately, so golden fixtures distinguish "exempt flag honored" from "rate happens to be zero" (§3.14 defense).
3. Category `specialRule: "room_rent_daily_threshold"`: taxable iff `taxableBase > thresholdPaise × qty` (integer-safe per-day comparison; qty = days for room lines). At-or-below → **exempt**, reason `room_rent_at_or_below_threshold`. Strictly-greater matches "exceeding ₹5,000/day".
   **STATED ASSUMPTION for the §19 CA gate:** the threshold compares the **post-discount charged value**. Fixture G13 pins this reading and is flagged `caFlag` in its file; if the CA rules for the pre-discount reading, the change is one comparison in `gst.ts` plus G13's expectation.
4. Otherwise taxable: `cgst = sgst = divHalfUp(base × rateBps, 20000)` (intra-state supply; IGST is out of Phase-1 scope — the hospital bills at the hospital).

The per-line output (taxable vs exempt turnover, SAC, heads) **is** the Rule 42/43 ITC-reversal data D-3 requires for the accountant; Plan 08 aggregates it at invoice/GSTR time.

### D5 — Tariff versioning & the lock rule (§7, §11.11)
`tariff_versions` (status `draft → submitted → activated`, terminal `rejected`) + `tariff_items` (versionId, serviceId, pricePaise; unique per pair; writable only while `draft`). A revision is always a new draft (optionally copied from any version). **Submit** = `requestApproval(tx, actor, { typeKey: "tariff_revision", subject: { type: "tariff_version", id } })` — Class-A per §11.11; the shipped flow builder supports exactly one approver role, so **v1 registers approver role `owner`**; the §10.4 two-key (owner + Medical Superintendent) is a definition-data upgrade at go-live, recorded in the runbook, not code. **Activate** = check-on-execute (`getApproval(...).status === "granted"`), drafter≠activator and submitter≠activator SoD (direct check), `effectiveFrom` **strictly greater** than every previously-activated version's (monotone ⇒ unambiguous resolution), single-winner conditional UPDATE, then `tariff.revision_applied`. `approval_id` is **plain text with no FK** (the `patient_merge_requests` §3.12 precedent — tariff tables form one self-contained TRUNCATE group).

**The lock:** `PricingContext` carries exactly one resolved tariff version. `resolveActiveTariffVersion(db, at)` = the activated version with the greatest `effectiveFrom ≤ at` (boundary: equal is included). OPD callers resolve at billing time; IPD admission (later plan) pins the admission-date version id on the stay and passes it for every bill of that stay — the pin's **storage** is IPD scope, the **capability** (`loadPricingContext` accepting an explicit `tariffVersionId`) ships here and G12 plus the lifecycle e2e prove old versions still price old.

### D6 — Impact simulation (§11.11)
`simulateRevision(currentCtx, draftCtx, lines): ImpactReport` — pure, sync: prices the same lines under both contexts, reports per-line net deltas, totals (net + tax), and a by-service rollup (sorted by serviceId). The HTTP route loads the draft context (`allowDraft: true`) and takes the line set from the caller; the "yesterday's invoice lines" reader is a one-function seam Plan 08 implements when invoice lines exist. Synchronous by decision — a day is a few thousand lines of pure arithmetic.

### D7 — Config validation (D-17) & the CA gate (§19)
`validateTariffConfig(db, at)` (impure, read-only): every active service has a price in the resolvable active version; every used category has a `gst_config` row; every regulated service has an effective `regulated_prices` row; every `adjustment_rules.params` parses under its source's zod schema; all four D-8 categories have manual caps; then smoke-prices every active service (qty 1) through the real engine. Returns `{ ok, errors[], caSigned }`. The runbook script `validate:tariff` prints the report, emits `config.validated`, exits non-zero on failure — **the pre-go-live config-validation report is this script's output plus a green golden suite**; `gst_settings.caSigned` is flipped only by the CA sign-off runbook step.

---

## File Structure

```
apps/core/src/kernel/db/schema/tariff.ts        T1  7 tables (services, tariff_versions, tariff_items,
                                                    regulated_prices, adjustment_rules, gst_config, gst_settings)
apps/core/src/kernel/db/schema/tariff.test.ts   T1  schema round-trips (paise bigint), truncate group
apps/core/src/kernel/db/schema/index.ts         T1  +1 line: export * from "./tariff"
apps/core/drizzle/0007_<name>.sql               T1  generated — the plan's ONLY migration
apps/core/drizzle/meta/0007_snapshot.json       T1  generated (§3.16: the generator's FULL output set)
apps/core/drizzle/meta/_journal.json            T1  rewritten by the generator
apps/core/test/helpers/db.ts                    T1  +1 TRUNCATE statement (all 7 tariff tables, one statement)

apps/core/src/modules/tariff/
  errors.ts             T2  TariffError + closed code union
  money.ts              T2  divHalfUp, percentAmount, taxHead, roundTotalToRupee, assertPaise
  money.test.ts         T2
  services.ts           T2  service master CRUD + regulated_prices append/resolve
  services.test.ts      T2
  types.ts              T3  PricingContext, InvoiceLineInput, PricedLine, AdjustmentSource, …
  contest.ts            T3  standingRuleSource, manualDiscountSource, runContest
  contest.test.ts       T3
  gst.ts                T3  computeGst (D4)
  gst.test.ts           T3
  pricing.ts            T3  priceInvoiceLines (D2)
  pricing.test.ts       T3
  versions.ts           T4  createDraftVersion, setTariffItem, submitVersion, activateVersion,
                            resolveActiveTariffVersion, getVersion, listVersions
  versions.test.ts      T4
  events.ts             T4  tariff.revision_applied · config.validated (defineEvent)
  rules.ts              T5  adjustment_rules CRUD + per-source zod param schemas + caps accessor
  rules.test.ts         T5
  gst-config.ts         T5  gst_config/gst_settings accessors + upserts
  gst-config.test.ts    T5
  context.ts            T5  loadPricingContext, validateTariffConfig
  context.test.ts       T5
  golden/fixtures/*.json T6 13 fixtures (G01–G13)
  fixture-schema.ts     T6  zod schema for fixture files (workings mandatory)
  golden.test.ts        T6  the harness — hermetic, no DB
  simulation.ts         T7  simulateRevision, ImpactReport
  simulation.test.ts    T7
  tariff.controller.ts  T8  HTTP surface + toHttp
  tariff.module.ts      T8
  manifest.ts           T8
  index.ts              T8  THE cross-module interface

apps/core/scripts/seed-tariff.ts                T5  gst categories + settings + D-8 caps (dev placeholders)
apps/core/package.json                          T5  +"seed:tariff" · T9 +"validate:tariff" (sequential owners)
apps/core/src/app.module.ts                     T8  +import, +imports array entry, +registry.install
apps/core/test/tariff.e2e.test.ts               T8  HTTP spine e2e
apps/core/scripts/validate-tariff-config.ts     T9  D-17 gate script (emits config.validated)
apps/core/test/tariff-lifecycle.e2e.test.ts     T10 full in-process lifecycle incl. tariff-lock proof
README.md                                       T10 tariff module docs + go-live runbook additions
```

Golden fixtures live **inside the module** (`src/modules/tariff/golden/`) so the harness is colocated (jest picks `src/**/*.test.ts`) and needs no module-index import ordering against T8; files are read with `node:fs` + `__dirname` (no `import` of JSON, no tsconfig change).

---

## Tasks

Ten tasks, two pipelines: **A = T1–T6** (schema → engine → golden), **B = T7–T10** (simulation → surface → gate script → lifecycle). Strictly sequential — every task shares files or interfaces with its neighbor. Baseline for every task: **the previous task's commit, i.e. current `origin/main`** (§2.6 — never a fixed SHA).

### Task 1: Schema — 7 tables, migration 0007, truncate group

**Files:**
- Create: `apps/core/src/kernel/db/schema/tariff.ts`
- Create: `apps/core/src/kernel/db/schema/tariff.test.ts`
- Modify: `apps/core/src/kernel/db/schema/index.ts` (+1 line)
- Create (generated): `apps/core/drizzle/0007_<generated-name>.sql`, `apps/core/drizzle/meta/0007_snapshot.json`
- Modify (generated): `apps/core/drizzle/meta/_journal.json`
- Modify: `apps/core/test/helpers/db.ts` (+1 TRUNCATE statement)

**Interfaces:**
- Consumes: drizzle-orm pg-core (`pgTable, text, bigint, boolean, integer, jsonb, timestamp, index, uniqueIndex` — the shipped import style, schema/patients.ts:1-5).
- Produces: tables `services`, `tariffVersions`, `tariffItems`, `regulatedPrices`, `adjustmentRules`, `gstConfig`, `gstSettings` exported via `schema/index.ts` — every later task selects/inserts through these.

- [ ] **Step 1: Write the failing schema test** — `apps/core/src/kernel/db/schema/tariff.test.ts`:

```ts
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  adjustmentRules, gstConfig, gstSettings, regulatedPrices, services, tariffItems, tariffVersions,
} from "./index";
import type { Db } from "../client";

let db: Db;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ db, teardown } = await setupTestDb());
});
afterAll(async () => teardown());
beforeEach(async () => truncateAll(db));

async function seedMinimal(): Promise<{ serviceId: string; versionId: string }> {
  await db.insert(services).values({ id: "s1", code: "SVC-1", name: "Svc", category: "pharmacy", regulated: true, createdBy: "t", updatedBy: "t" });
  await db.insert(tariffVersions).values({ id: "v1", versionNo: 1, createdBy: "t" });
  return { serviceId: "s1", versionId: "v1" };
}

test("bigint paise columns round-trip as JS numbers (never strings, never floats)", async () => {
  const { serviceId, versionId } = await seedMinimal();
  await db.insert(tariffItems).values({ id: "i1", versionId, serviceId, pricePaise: 123456789, updatedBy: "t" });
  await db.insert(regulatedPrices).values({ id: "r1", serviceId, mrpPaise: 987654321, ceilingPaise: 500, effectiveFrom: new Date("2026-01-01T00:00:00Z"), createdBy: "t" });
  const item = (await db.select().from(tariffItems))[0];
  const reg = (await db.select().from(regulatedPrices))[0];
  expect(item?.pricePaise).toBe(123456789);
  expect(typeof item?.pricePaise).toBe("number");
  expect(reg?.mrpPaise).toBe(987654321);
  expect(reg?.ceilingPaise).toBe(500);
});

test("unique constraints hold: service code, version number, one price per (version, service)", async () => {
  const { serviceId, versionId } = await seedMinimal();
  await expect(db.insert(services).values({ id: "s2", code: "SVC-1", name: "Dup", category: "pharmacy", createdBy: "t", updatedBy: "t" })).rejects.toThrow();
  await expect(db.insert(tariffVersions).values({ id: "v2", versionNo: 1, createdBy: "t" })).rejects.toThrow();
  await db.insert(tariffItems).values({ id: "i1", versionId, serviceId, pricePaise: 100, updatedBy: "t" });
  await expect(db.insert(tariffItems).values({ id: "i2", versionId, serviceId, pricePaise: 200, updatedBy: "t" })).rejects.toThrow();
});

test("truncateAll empties every tariff table in one statement (FK group proof — §3.12)", async () => {
  const { serviceId, versionId } = await seedMinimal();
  await db.insert(tariffItems).values({ id: "i1", versionId, serviceId, pricePaise: 100, updatedBy: "t" });
  await db.insert(regulatedPrices).values({ id: "r1", serviceId, effectiveFrom: new Date(), mrpPaise: 1, ceilingPaise: null, createdBy: "t" });
  await db.insert(adjustmentRules).values({ id: "a1", ruleKey: "R1", sourceKey: "rule", title: "T", params: {}, createdBy: "t", updatedBy: "t" });
  await db.insert(gstConfig).values({ category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, updatedBy: "t" });
  await db.insert(gstSettings).values({ id: "main", updatedBy: "t" });
  await truncateAll(db);
  // Unrolled on purpose: a loop over a UNION of table types does not typecheck against drizzle's from() overloads.
  expect((await db.select().from(services)).length).toBe(0);
  expect((await db.select().from(tariffVersions)).length).toBe(0);
  expect((await db.select().from(tariffItems)).length).toBe(0);
  expect((await db.select().from(regulatedPrices)).length).toBe(0);
  expect((await db.select().from(adjustmentRules)).length).toBe(0);
  expect((await db.select().from(gstConfig)).length).toBe(0);
  expect((await db.select().from(gstSettings)).length).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @hmis/core test -- tariff.test` — expected: FAIL (module `./index` has no export `services` etc.).
- [ ] **Step 3: Write the schema** — `apps/core/src/kernel/db/schema/tariff.ts`:

```ts
import {
  bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Plan 06 — tariff/pricing master data (spec §7, C-3, D-3, D-8, §11.11).
 * Money is integer PAISE (bigint mode number — never floats), the Plan 04 precedent.
 * This is ONE self-contained FK group: nothing here references any table outside this file,
 * and tariff_versions.approval_id is deliberately plain text with NO FK (§3.12 precedent:
 * patient_merge_requests.approval_id) so the group truncates in a single statement.
 */

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(), // ULID via newId()
    code: text("code").notNull(), // human-facing service code (printed on invoices)
    name: text("name").notNull(),
    category: text("category").notNull(), // keys gst_config + adjustment scoping (consultation/procedure/room_rent/pharmacy/device/…)
    regulated: boolean("regulated").notNull().default(false), // C-3: min(tariff, MRP, ceiling) applies
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("services_code_ux").on(t.code), index("services_category_idx").on(t.category)],
);

export const tariffVersions = pgTable(
  "tariff_versions",
  {
    id: text("id").primaryKey(),
    versionNo: integer("version_no").notNull(),
    status: text("status").notNull().default("draft"), // 'draft'|'submitted'|'activated'|'rejected' (§11.11)
    notes: text("notes"),
    approvalId: text("approval_id"), // plain text, NO FK — see file comment
    effectiveFrom: timestamp("effective_from", { withTimezone: true }), // set at activation; strictly monotone across activated versions
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    activatedBy: text("activated_by"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("tariff_versions_no_ux").on(t.versionNo), index("tariff_versions_status_idx").on(t.status)],
);

export const tariffItems = pgTable(
  "tariff_items",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id").notNull().references(() => tariffVersions.id),
    serviceId: text("service_id").notNull().references(() => services.id),
    pricePaise: bigint("price_paise", { mode: "number" }).notNull(), // integer PAISE
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tariff_items_version_service_ux").on(t.versionId, t.serviceId)],
);

// C-3 regulated-price attributes. APPEND-ONLY: a revision (NPPA gazette, new MRP) is a new
// effective-dated row, never an UPDATE — the master-data change-control trail is the row history.
export const regulatedPrices = pgTable(
  "regulated_prices",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull().references(() => services.id),
    mrpPaise: bigint("mrp_paise", { mode: "number" }),
    ceilingPaise: bigint("ceiling_paise", { mode: "number" }), // DPCO/NPPA notified ceiling
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    gazetteRef: text("gazette_ref"), // provenance for the NPPA revision watch (C-3)
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("regulated_prices_service_idx").on(t.serviceId, t.effectiveFrom)],
);

export const adjustmentRules = pgTable(
  "adjustment_rules",
  {
    id: text("id").primaryKey(),
    ruleKey: text("rule_key").notNull(),
    sourceKey: text("source_key").notNull(), // 'rule' (standing rules) | 'manual' (D-8 cap rows); Plan 09 adds 'coupon','membership'
    title: text("title").notNull(),
    params: jsonb("params").notNull(), // zod-validated per sourceKey (rules.ts owns the schemas)
    serviceCategory: text("service_category"), // scope: null = all categories
    serviceId: text("service_id"), // scope: null = all services; plain text, no FK (config may pre-date the service row in a bulk load)
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("adjustment_rules_key_ux").on(t.ruleKey), index("adjustment_rules_source_idx").on(t.sourceKey)],
);

// D-3 GST config — CA-configured DATA, never engine literals (§19 gate). For exempt categories
// rate_bps holds the WOULD-BE rate deliberately: golden fixtures use it to distinguish
// "exempt flag honored" from "rate happens to be zero" (ledger §3.14 defense).
export const gstConfig = pgTable("gst_config", {
  category: text("category").primaryKey(),
  sacCode: text("sac_code").notNull(), // SAC for services, HSN for goods — one column, reporting-friendly
  exempt: boolean("exempt").notNull(),
  rateBps: integer("rate_bps").notNull(), // basis points: 500 = 5%
  specialRule: text("special_rule"), // 'room_rent_daily_threshold' | null (D-3 ₹5k/day line)
  thresholdPaise: bigint("threshold_paise", { mode: "number" }), // per-day, for the room-rent rule
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Single audited row id='main' (registration_config precedent). ca_signed flips only via the
// §19 CA sign-off runbook step; D-17's validation report quotes it.
export const gstSettings = pgTable("gst_settings", {
  id: text("id").primaryKey(),
  compositeHealthcareExempt: boolean("composite_healthcare_exempt").notNull().default(true), // D-3 composite supply
  caSigned: boolean("ca_signed").notNull().default(false),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 4: Export + truncate group.** Append to `apps/core/src/kernel/db/schema/index.ts`: `export * from "./tariff";`. In `apps/core/test/helpers/db.ts`, add **one** statement after the patients group (all seven tables in a single TRUNCATE — they FK only each other, §3.12):

```ts
  await db.execute(
    sql`truncate table tariff_items, regulated_prices, adjustment_rules, gst_config, gst_settings,
        tariff_versions, services`,
  );
```

- [ ] **Step 5: Generate the migration** — `pnpm --filter @hmis/core db:generate`. This creates `drizzle/0007_<name>.sql` + `drizzle/meta/0007_snapshot.json` and rewrites `drizzle/meta/_journal.json` — **commit all three; they are the generator's full output set (§3.16).** Never edit the SQL by hand.
- [ ] **Step 6: Run the test to verify it passes** — `pnpm --filter @hmis/core test -- tariff.test` — expected: PASS, 3 tests.
- [ ] **Step 7: Full workspace check** — `pnpm --filter @hmis/core test` then root `pnpm verify` (detached on the server per tripwire 18). Expected: green; apps/core grows by exactly one suite.
- [ ] **Step 8: Commit** — `git add` the six listed files → commit `feat(core): tariff schema — 7 tables, migration 0007, truncate group` → `git pull --rebase origin main` → `git push origin main` (three separate steps, §3.8).

**Acceptance criteria:** the three named tests pass; migration 0007 exists with its snapshot + journal entry committed; `truncateAll` has exactly one new statement naming all 7 tables; no other file changed; CI observed green.

---

### Task 2: Money primitives + service master + regulated prices

**Files:**
- Create: `apps/core/src/modules/tariff/errors.ts`, `money.ts`, `money.test.ts`, `services.ts`, `services.test.ts`

**Interfaces:**
- Consumes: T1 tables via `../../kernel/db/schema`; `newId`, `Actor` from `@hmis/contracts`; `Db`, `Tx` from `../../kernel/db/client`.
- Produces (T3–T10 rely on these exact names):

```ts
// errors.ts
export type TariffErrorCode =
  | "invalid_paise" | "invalid_qty" | "unknown_service" | "service_inactive" | "duplicate_service_code"
  | "tariff_item_missing" | "regulated_price_missing" | "regulated_bounds_missing"
  | "gst_config_missing" | "gst_config_invalid" | "settings_missing"
  | "unknown_version" | "version_not_active" | "not_draft" | "not_submitted" | "empty_version"
  | "approval_not_granted" | "approval_rejected" | "sod_drafter_activator" | "effective_from_not_monotone"
  | "unknown_rule" | "invalid_rule_params";
export class TariffError extends Error { constructor(readonly code: TariffErrorCode, message?: string) }

// money.ts — the ONLY rounding primitives in the module (D1)
export function assertPaise(n: number, what: string): void            // throws invalid_paise unless safe non-negative integer
export function divHalfUp(n: number, d: number): number               // round(n/d), halves up; integers only
export function percentAmount(grossPaise: number, bps: number): number // divHalfUp(gross*bps, 10000)
export function taxHead(basePaise: number, rateBps: number): number    // divHalfUp(base*rateBps, 20000) — ONE head
export function roundTotalToRupee(totalPaise: number): { roundedPaise: number; roundingPaise: number } // CGST-Act §170 helper for Plan 08

// services.ts
export type ServiceInput = { code: string; name: string; category: string; regulated?: boolean };
export function createService(tx: Tx, actor: Actor, input: ServiceInput): Promise<{ serviceId: string }>
export function updateService(tx: Tx, actor: Actor, serviceId: string, patch: Partial<ServiceInput> & { active?: boolean }): Promise<void>
export function listServices(db: Db, opts?: { activeOnly?: boolean }): Promise<ServiceRow[]>   // ServiceRow = typeof services.$inferSelect
export function appendRegulatedPrice(tx: Tx, actor: Actor, input: { serviceId: string; mrpPaise?: number | null; ceilingPaise?: number | null; effectiveFrom: Date; gazetteRef?: string }): Promise<{ id: string }>
export function resolveRegulatedPrices(db: Db, at: Date): Promise<Record<string, { mrpPaise: number | null; ceilingPaise: number | null }>>
```

- [ ] **Step 1: Failing money tests** — `money.test.ts` (pure, no DB):

```ts
import { assertPaise, divHalfUp, percentAmount, roundTotalToRupee, taxHead } from "./money";
import { TariffError } from "./errors";

test("divHalfUp rounds halves up and everything else to nearest", () => {
  expect(divHalfUp(16666500, 20000)).toBe(833);   // 833.325 → 833 (G02's CGST head)
  expect(divHalfUp(22650000, 20000)).toBe(1133);  // 1132.5  → 1133 (G03: banker's would say 1132)
  expect(divHalfUp(0, 100)).toBe(0);
});
test("percentAmount: half-up at the paise (G07's candidates)", () => {
  expect(percentAmount(33335, 1000)).toBe(3334);  // 3333.5 → 3334
  expect(percentAmount(33335, 500)).toBe(1667);   // 1666.75 → 1667
  expect(percentAmount(33335, 800)).toBe(2667);   // 2666.8 → 2667
});
test("taxHead computes ONE head (half the rate), half-up", () => {
  expect(taxHead(18875, 1200)).toBe(1133);        // 6% = 1132.5 → 1133
  expect(taxHead(10000, 1200)).toBe(600);
  expect(taxHead(33333, 500)).toBe(833);          // 2.5% = 833.325 → 833
});
test("roundTotalToRupee: nearest rupee, 50p goes up (§170 helper)", () => {
  expect(roundTotalToRupee(12349)).toEqual({ roundedPaise: 12300, roundingPaise: -49 });
  expect(roundTotalToRupee(12350)).toEqual({ roundedPaise: 12400, roundingPaise: 50 });
  expect(roundTotalToRupee(12351)).toEqual({ roundedPaise: 12400, roundingPaise: 49 });
});
test("assertPaise rejects floats, negatives, unsafe integers", () => {
  for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    expect(() => assertPaise(bad, "x")).toThrow(TariffError);
  }
  expect(() => assertPaise(0, "x")).not.toThrow();
});
```

- [ ] **Step 2: Run to fail** — `pnpm --filter @hmis/core test -- money.test` → FAIL (module missing).
- [ ] **Step 3: Implement `errors.ts` + `money.ts`:**

```ts
// errors.ts
export type TariffErrorCode = /* the closed union from the Interfaces block, verbatim */;
export class TariffError extends Error {
  constructor(readonly code: TariffErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TariffError";
  }
}
```

```ts
// money.ts
import { TariffError } from "./errors";

export function assertPaise(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new TariffError("invalid_paise", `${what} must be a non-negative integer of paise, got ${String(n)}`);
}
/** round(n/d) with halves rounded UP (away from zero). Integer-only; d > 0. 2n stays < 2^53 for all invoice-scale inputs. */
export function divHalfUp(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(d) || d <= 0) throw new TariffError("invalid_paise", `divHalfUp(${String(n)}, ${String(d)})`);
  return Math.floor((2 * n + d) / (2 * d));
}
export function percentAmount(grossPaise: number, bps: number): number { return divHalfUp(grossPaise * bps, 10000); }
export function taxHead(basePaise: number, rateBps: number): number { return divHalfUp(basePaise * rateBps, 20000); }
export function roundTotalToRupee(totalPaise: number): { roundedPaise: number; roundingPaise: number } {
  assertPaise(totalPaise, "invoice total");
  const roundedPaise = divHalfUp(totalPaise, 100) * 100;
  return { roundedPaise, roundingPaise: roundedPaise - totalPaise };
}
```

- [ ] **Step 4: Run to pass** — 5 tests green.
- [ ] **Step 5: Failing services tests** — `services.test.ts` (DB suite: `setupTestDb`/`truncateAll` beforeEach, the schema-test harness shape). Six tests, each named for its rule: create + list round-trip (regulated flag persisted) · duplicate code → `TariffError("duplicate_service_code")` · update patch changes name/active and bumps `updatedBy` · `appendRegulatedPrice` with **neither** bound → `regulated_bounds_missing`; with negative/float paise → `invalid_paise` · append twice with different `effectiveFrom`, then `resolveRegulatedPrices(db, at)` picks the **latest row ≤ at** and omits future rows (use rows effective Jan-1 {mrp 10000} and Mar-1 {mrp 9000}; at Feb-1 → 10000, at Mar-1 → 9000 — **boundary: equal is included**; at Dec-31-prior → service absent from the map) · resolve returns only regulated services' rows.
- [ ] **Step 6: Run to fail**, then **Step 7: implement `services.ts`** — inserts with `newId()`, `assertPaise` on every paise input, duplicate-code mapped from the unique index (pre-check select by code inside the tx, unique index as the race backstop; a raw `23505` escaping the pre-check is acceptable and noted), `resolveRegulatedPrices` = one select ordered by `effectiveFrom desc` reduced to first-per-service where `effectiveFrom <= at`.
- [ ] **Step 8: Run to pass** — `pnpm --filter @hmis/core test -- services.test` → 6 tests green; then the module's suites: `pnpm --filter @hmis/core test -- "modules/tariff"`.
- [ ] **Step 9: Commit** — `feat(core): tariff money primitives, service master, regulated prices (C-3 data)` → pull --rebase → push.

**Acceptance criteria:** the 11 tests across the two new suites pass; `divHalfUp(22650000, 20000) === 1133` is asserted (the banker's-rounding separator — a banker's implementation fails this suite); no floats and no `z.coerce` appear anywhere in the two implementation files; `regulated_prices` has no UPDATE call anywhere in `services.ts` (append-only).

---

### Task 3: The pure engine — types, contest, GST boundary, priceInvoiceLines  *(opus coder)*

**Files:**
- Create: `apps/core/src/modules/tariff/types.ts`, `contest.ts`, `contest.test.ts`, `gst.ts`, `gst.test.ts`, `pricing.ts`, `pricing.test.ts`

**Interfaces:**
- Consumes: `money.ts`, `errors.ts` (T2). **Nothing else — these files import no kernel code, no db, no clock.**
- Produces (the contract Plans 08/09 build against — FIXED here):

```ts
// types.ts (complete — this block is the file, minus imports)
export type DiscountCategory = "charity" | "scheme" | "negotiated_corporate" | "employee"; // D-8
export const DISCOUNT_CATEGORIES = ["charity", "scheme", "negotiated_corporate", "employee"] as const;

export type ServiceInfo = { id: string; code: string; name: string; category: string; regulated: boolean; active: boolean };
export type GstCategoryConfig = {
  category: string; sacCode: string; exempt: boolean; rateBps: number;
  specialRule: "room_rent_daily_threshold" | null; thresholdPaise: number | null;
};
export type GstSettings = { compositeHealthcareExempt: boolean; caSigned: boolean };
export type AdjustmentRuleConfig = {
  ruleKey: string; title: string; kind: "percent_bps" | "flat_paise"; value: number;
  discountCategory: DiscountCategory; requiredTag: string | null;
  serviceCategory: string | null; serviceId: string | null;
};
export type ManualCaps = Partial<Record<DiscountCategory, { maxBps: number; approvalAboveBps: number | null }>>;
export type ManualDiscountInput = { discountCategory: DiscountCategory; kind: "percent_bps" | "flat_paise"; value: number; reason: string };

export type InvoiceLineInput = {
  lineId: string; serviceId: string; qty: number; // positive integer; days for room-rent lines
  supplyContext?: "standalone" | "composite_healthcare"; // D-3 composite supply; caller-set (Plan 08/IPD)
  manualDiscount?: ManualDiscountInput | null;
};

export type AdjustmentCandidate = {
  sourceKey: string; ruleKey: string | null; kind: "percent_bps" | "flat_paise";
  discountCategory: DiscountCategory | null;
  amountPaise: number; // computed benefit on THIS line, capped at gross; for rejected candidates: the amount that was ASKED (audit)
  reason: string;
  requiresApproval: boolean; // Plan 08 enforces against the approvals engine
  rejected: { code: "over_cap" | "unknown_category"; detail: string } | null; // recorded, excluded from the contest
};
export type AdjustmentSource = {
  key: string;
  propose(ctx: PricingContext, line: InvoiceLineInput, grossPaise: number): AdjustmentCandidate[]; // PURE, sync
};

export type PricingContext = {
  asOf: Date; // resolution timestamp the impure loader used; the engine never reads a clock
  tariff: { versionId: string; versionNo: number; items: Record<string, number> }; // serviceId → pricePaise (the LOCK: exactly one version)
  services: Record<string, ServiceInfo>;
  regulatedPrices: Record<string, { mrpPaise: number | null; ceilingPaise: number | null }>;
  gst: { categories: Record<string, GstCategoryConfig>; settings: GstSettings };
  rules: AdjustmentRuleConfig[];
  manualCaps: ManualCaps;
  sources: AdjustmentSource[]; // ORDER = tie-break precedence (D3); Plan 06 ships ["rule","manual"]
  tags: string[]; // request-level eligibility tags (e.g. "employee"); Plan 08 supplies from visit/patient
};

export type RegulatedClamp = { boundApplied: "mrp" | "ceiling"; tariffPaise: number; mrpPaise: number | null; ceilingPaise: number | null };
export type PricedLineGst = {
  sacCode: string; rateBps: number; exempt: boolean;
  exemptReason: "category_exempt" | "composite_healthcare" | "room_rent_at_or_below_threshold" | null;
  cgstPaise: number; sgstPaise: number;
};
export type PricedLine = {
  lineId: string; serviceId: string; serviceName: string; category: string;
  qty: number; unitPaise: number; grossPaise: number;
  regulatedClamp: RegulatedClamp | null;
  candidates: AdjustmentCandidate[]; winner: AdjustmentCandidate | null;
  discountPaise: number; taxableBasePaise: number;
  gst: PricedLineGst; netPaise: number;
};
```

```ts
// contest.ts / gst.ts / pricing.ts public surface
export const standingRuleSource: AdjustmentSource   // key "rule"
export const manualDiscountSource: AdjustmentSource // key "manual"
export function runContest(ctx, line, grossPaise): { candidates: AdjustmentCandidate[]; winner: AdjustmentCandidate | null }
export function computeGst(args: { cfg: GstCategoryConfig; settings: GstSettings; line: InvoiceLineInput; taxableBasePaise: number; qty: number }): PricedLineGst
export function priceInvoiceLines(ctx: PricingContext, lines: InvoiceLineInput[]): PricedLine[]  // SYNCHRONOUS
```

- [ ] **Step 1: Failing contest tests** — `contest.test.ts`, pure fixtures built inline (a `makeCtx(overrides)` helper returning a full `PricingContext` literal). Ten tests, the load-bearing ones with their separating logic stated:
  - *rule source proposes only on tag + scope match* — rule with `requiredTag: "employee"`: no tags → zero candidates; with tag → one candidate of the exact rounded amount (`percentAmount`), **asserting the amount value, not just presence**.
  - *rule scoped to a category/service does not fire elsewhere* (both directions asserted).
  - *flat rule caps at gross* — flat 60000 on gross 50000 → `amountPaise: 50000`.
  - *manual: unknown category → rejected recorded* (`rejected.code === "unknown_category"`, candidate present in output).
  - *manual: over-cap → rejected, and the ASKED amount is recorded* — 25% asked vs 20% cap on gross 50000 → `amountPaise: 12500`, `rejected.code: "over_cap"` (a clamping implementation would report 10000 and no rejection — killed).
  - *manual: requiresApproval uses exact rational compare* — flat 10000 on gross 50000 with `approvalAboveBps: 1000` → `requiresApproval: true`; value exactly AT the bps line → `false` (compute: flat 5000 on 50000 = exactly 1000bps → not above → false).
  - *winner = largest amount* (three candidates with distinct amounts).
  - *tie → earlier source in ctx.sources* (rule 5000 vs manual 5000 → rule wins; then reverse `ctx.sources` order in a second ctx → manual wins — **the order itself is asserted from both sides**).
  - *tie within one source → ruleKey ascending*.
  - *all-rejected → winner null, candidates still recorded*.
- [ ] **Step 2: Run to fail** — `pnpm --filter @hmis/core test -- contest.test`.
- [ ] **Step 3: Implement `types.ts` + `contest.ts`:**

```ts
// contest.ts
import { percentAmount } from "./money";
import type { AdjustmentCandidate, AdjustmentSource, InvoiceLineInput, PricingContext } from "./types";

export const standingRuleSource: AdjustmentSource = {
  key: "rule",
  propose(ctx, line, grossPaise) {
    const svc = ctx.services[line.serviceId];
    if (!svc) return [];
    const out: AdjustmentCandidate[] = [];
    const rules = [...ctx.rules].sort((a, b) => (a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0));
    for (const r of rules) {
      if (r.requiredTag !== null && !ctx.tags.includes(r.requiredTag)) continue;
      if (r.serviceCategory !== null && r.serviceCategory !== svc.category) continue;
      if (r.serviceId !== null && r.serviceId !== line.serviceId) continue;
      const raw = r.kind === "percent_bps" ? percentAmount(grossPaise, r.value) : r.value;
      out.push({
        sourceKey: "rule", ruleKey: r.ruleKey, kind: r.kind, discountCategory: r.discountCategory,
        amountPaise: Math.min(raw, grossPaise), reason: r.title, requiresApproval: false, rejected: null,
      });
    }
    return out;
  },
};

export const manualDiscountSource: AdjustmentSource = {
  key: "manual",
  propose(ctx, line, grossPaise) {
    const md = line.manualDiscount;
    if (!md) return [];
    const raw = md.kind === "percent_bps" ? percentAmount(grossPaise, md.value) : md.value;
    const amount = Math.min(raw, grossPaise);
    const base: AdjustmentCandidate = {
      sourceKey: "manual", ruleKey: null, kind: md.kind, discountCategory: md.discountCategory,
      amountPaise: amount, reason: md.reason, requiresApproval: false, rejected: null,
    };
    const caps = ctx.manualCaps[md.discountCategory];
    if (!caps) return [{ ...base, rejected: { code: "unknown_category", detail: `no cap configured for "${md.discountCategory}"` } }];
    // Governance checks are EXACT RATIONAL comparisons — never rounded (D1).
    if (amount * 10000 > caps.maxBps * grossPaise) {
      return [{ ...base, rejected: { code: "over_cap", detail: `${amount}p exceeds ${caps.maxBps}bps of ${grossPaise}p` } }];
    }
    const requiresApproval = caps.approvalAboveBps !== null && amount * 10000 > caps.approvalAboveBps * grossPaise;
    return [{ ...base, requiresApproval }];
  },
};

/** Best-single-benefit (§7): one winner per line; ties break by ctx.sources order, then ruleKey asc (nulls last). */
export function runContest(
  ctx: PricingContext, line: InvoiceLineInput, grossPaise: number,
): { candidates: AdjustmentCandidate[]; winner: AdjustmentCandidate | null } {
  const order = new Map<string, number>();
  ctx.sources.forEach((s, i) => order.set(s.key, i));
  const candidates: AdjustmentCandidate[] = [];
  for (const source of ctx.sources) candidates.push(...source.propose(ctx, line, grossPaise));
  const valid = candidates.filter((c) => c.rejected === null && c.amountPaise > 0);
  valid.sort((a, b) => {
    if (a.amountPaise !== b.amountPaise) return b.amountPaise - a.amountPaise;
    const ai = order.get(a.sourceKey) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.sourceKey) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    if (a.ruleKey === null && b.ruleKey === null) return 0; // nulls last, spelled out — no sentinel characters
    if (a.ruleKey === null) return 1;
    if (b.ruleKey === null) return -1;
    return a.ruleKey < b.ruleKey ? -1 : a.ruleKey > b.ruleKey ? 1 : 0;
  });
  return { candidates, winner: valid[0] ?? null };
}
```

- [ ] **Step 4: Run contest tests to pass.**
- [ ] **Step 5: Failing GST tests** — `gst.test.ts`. Seven tests: category-exempt returns zero heads **with the nonzero would-be rate echoed** (cfg `rateBps: 1800`, assert `rateBps === 1800 && cgstPaise === 0` — separates flag-honored from rate-zero) · composite exemption **wins over a taxable category** (pharmacy cfg, composite line → exempt `composite_healthcare`) · composite with `compositeHealthcareExempt: false` → taxable (the setting is consulted — deleting the check fails this) · room-rent at threshold ×qty → exempt; one paise above → taxable (both asserted; `thresholdPaise × qty` not `thresholdPaise` — qty 2 case where per-line total exceeds the single-day threshold but not ×2: base 960000, threshold 500000, qty 2 → exempt; a `base > threshold` implementation says taxable — killed) · room-rent rule with `thresholdPaise: null` → `TariffError("gst_config_invalid")` · per-head rounding: base 33333 rate 500 → heads 833/833 (not 834) · base 18875 rate 1200 → heads 1133/1133 (banker's/truncation killed).
- [ ] **Step 6: Run to fail; Step 7: implement `gst.ts`** (the D4 decision order verbatim):

```ts
// gst.ts
import { TariffError } from "./errors";
import { taxHead } from "./money";
import type { GstCategoryConfig, GstSettings, InvoiceLineInput, PricedLineGst } from "./types";

export function computeGst(args: {
  cfg: GstCategoryConfig; settings: GstSettings; line: InvoiceLineInput; taxableBasePaise: number; qty: number;
}): PricedLineGst {
  const { cfg, settings, line, taxableBasePaise, qty } = args;
  const zero = { sacCode: cfg.sacCode, rateBps: cfg.rateBps, cgstPaise: 0, sgstPaise: 0 };
  if (line.supplyContext === "composite_healthcare" && settings.compositeHealthcareExempt) {
    return { ...zero, exempt: true, exemptReason: "composite_healthcare" };
  }
  if (cfg.exempt) return { ...zero, exempt: true, exemptReason: "category_exempt" };
  if (cfg.specialRule === "room_rent_daily_threshold") {
    if (cfg.thresholdPaise === null) throw new TariffError("gst_config_invalid", `category "${cfg.category}" has the room-rent rule but no thresholdPaise`);
    // D-3: taxable iff the CHARGED (post-discount) value exceeds threshold × days. Integer-safe; strictly greater
    // matches "exceeding ₹5,000/day". STATED CA ASSUMPTION (§19 gate): post-discount reading — golden G13 pins it.
    if (!(taxableBasePaise > cfg.thresholdPaise * qty)) {
      return { ...zero, exempt: true, exemptReason: "room_rent_at_or_below_threshold" };
    }
  }
  const head = taxHead(taxableBasePaise, cfg.rateBps);
  return { sacCode: cfg.sacCode, rateBps: cfg.rateBps, exempt: false, exemptReason: null, cgstPaise: head, sgstPaise: head };
}
```

- [ ] **Step 8: Run to pass; Step 9: failing pricing tests** — `pricing.test.ts`. Eight tests: happy line (all output fields asserted with `toEqual` on the full `PricedLine`) · regulated three-way min (drug-a/b/c values from the Fixture Book — each min distinct, clamp field asserted incl. `null` for tariff-wins) · `regulated_price_missing` · `unknown_service` / `service_inactive` / `tariff_item_missing` / `invalid_qty` (qty 0, qty 1.5) each by code · discount flows into the taxable base (winner 3334 on gross 33335 → `taxableBasePaise 30001` — nonzero discount, §3.14) · **purity**: calling twice with the same frozen ctx returns deeply-equal results and the return value is an array, not a Promise (`Array.isArray(priceInvoiceLines(ctx, lines))`).
- [ ] **Step 10: Run to fail; Step 11: implement `pricing.ts`:**

```ts
// pricing.ts
import { TariffError } from "./errors";
import { assertPaise } from "./money";
import { runContest } from "./contest";
import { computeGst } from "./gst";
import type { InvoiceLineInput, PricedLine, PricingContext, RegulatedClamp } from "./types";

/** PURE + SYNCHRONOUS (§7, §18): no I/O, no clock, no randomness — same ctx+lines in, same PricedLine[] out. */
export function priceInvoiceLines(ctx: PricingContext, lines: InvoiceLineInput[]): PricedLine[] {
  return lines.map((line) => priceLine(ctx, line));
}

function priceLine(ctx: PricingContext, line: InvoiceLineInput): PricedLine {
  if (!Number.isSafeInteger(line.qty) || line.qty <= 0) throw new TariffError("invalid_qty", `line ${line.lineId}: qty must be a positive integer`);
  const svc = ctx.services[line.serviceId];
  if (!svc) throw new TariffError("unknown_service", `line ${line.lineId}: service ${line.serviceId}`);
  if (!svc.active) throw new TariffError("service_inactive", `line ${line.lineId}: service ${line.serviceId}`);
  const tariffPaise = ctx.tariff.items[line.serviceId];
  if (tariffPaise === undefined) throw new TariffError("tariff_item_missing", `line ${line.lineId}: no price for ${line.serviceId} in version ${ctx.tariff.versionId}`);
  assertPaise(tariffPaise, "tariff price");

  // C-3: min(tariff, MRP, NPPA ceiling). The hard block IS the min — no path may exceed the ceiling.
  let unitPaise = tariffPaise;
  let regulatedClamp: RegulatedClamp | null = null;
  if (svc.regulated) {
    const rp = ctx.regulatedPrices[line.serviceId];
    if (!rp) throw new TariffError("regulated_price_missing", `line ${line.lineId}: ${line.serviceId} is regulated but has no effective MRP/ceiling row`);
    const bounds: { boundApplied: "mrp" | "ceiling"; value: number }[] = [];
    if (rp.mrpPaise !== null) bounds.push({ boundApplied: "mrp", value: rp.mrpPaise });
    if (rp.ceilingPaise !== null) bounds.push({ boundApplied: "ceiling", value: rp.ceilingPaise });
    for (const b of bounds) {
      if (b.value < unitPaise) {
        unitPaise = b.value;
        regulatedClamp = { boundApplied: b.boundApplied, tariffPaise, mrpPaise: rp.mrpPaise, ceilingPaise: rp.ceilingPaise };
      }
    }
  }
  const grossPaise = unitPaise * line.qty;
  assertPaise(grossPaise, "gross");

  const { candidates, winner } = runContest(ctx, line, grossPaise);
  const discountPaise = winner?.amountPaise ?? 0;
  const taxableBasePaise = grossPaise - discountPaise;

  const cfg = ctx.gst.categories[svc.category];
  if (!cfg) throw new TariffError("gst_config_missing", `no gst_config row for category "${svc.category}"`);
  const gst = computeGst({ cfg, settings: ctx.gst.settings, line, taxableBasePaise, qty: line.qty });

  return {
    lineId: line.lineId, serviceId: svc.id, serviceName: svc.name, category: svc.category,
    qty: line.qty, unitPaise, grossPaise, regulatedClamp, candidates, winner,
    discountPaise, taxableBasePaise, gst, netPaise: taxableBasePaise + gst.cgstPaise + gst.sgstPaise,
  };
}
```

- [ ] **Step 12: Run all three suites to pass** — `pnpm --filter @hmis/core test -- "modules/tariff"` (25 tests across 5 suites so far).
- [ ] **Step 13: Commit** — `feat(core): pure pricing engine — contest, GST boundary, priceInvoiceLines` → pull --rebase → push.

**Acceptance criteria:** all named tests pass with the exact asserted values from this document; `pricing.ts`, `gst.ts`, `contest.ts`, `types.ts` contain **no `await`, no `import` from any `kernel/` path, no `new Date()`, no `Math.random`** (gate greps the four files); the tie-break is asserted from **both** orderings; the over-cap candidate records the asked amount with `rejected` set (clamping fails the suite); `computeGst` echoes the nonzero would-be rate on exempt lines.

---

### Task 4: Tariff versions — draft → submit (approval) → activate, tariff-lock resolution, events

**Files:**
- Create: `apps/core/src/modules/tariff/versions.ts`, `versions.test.ts`, `events.ts`

**Interfaces:**
- Consumes: `requestApproval` (kernel/approvals/requests.ts:30), `getApproval` (kernel/approvals/worklist.ts:84), `approveRequest`/`rejectRequest` (kernel/approvals/decisions.ts:92-98, tests only), `approvalFlowDefinition` (kernel/approvals/flow.ts:31), `createDraft`/`activateDefinition` (kernel/workflow/definitions.ts), `appendEvent` (kernel/events/append.ts:6), `withTx`/`Db`/`Tx`, `newId`, T1 tables, T2 errors/money.
- Produces:

```ts
export const TARIFF_REVISION_APPROVAL_TYPE = "tariff_revision"; // registered as go-live DATA (runbook, T10 README)
export function createDraftVersion(tx: Tx, actor: Actor, input?: { notes?: string; copyFromVersionId?: string }): Promise<{ versionId: string; versionNo: number }>
export function setTariffItem(tx: Tx, actor: Actor, versionId: string, serviceId: string, pricePaise: number): Promise<void>
export function submitVersion(tx: Tx, actor: Actor, versionId: string, requestNote?: string): Promise<{ approvalId: string; instanceId: string }>
export function activateVersion(db: Db, actor: Actor, versionId: string, effectiveFrom: Date): Promise<{ versionNo: number; effectiveFrom: Date }>
export function resolveActiveTariffVersion(db: Db, at: Date): Promise<{ versionId: string; versionNo: number } | null>
export function getVersion(db: Db, versionId: string): Promise<{ version: TariffVersionRow; items: TariffItemRow[] } | null>
export function listVersions(db: Db): Promise<TariffVersionRow[]>
```

```ts
// events.ts — the module's complete catalog: EXACTLY these two names (§10.6 discipline)
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";
const MODULE = "tariff";
export const tariffRevisionApplied = defineEvent("tariff.revision_applied", MODULE, z.object({
  versionId: z.string().min(1), versionNo: z.number().int().positive(),
  effectiveFrom: z.string().min(1), // ISO — dates ride events as strings
  approvalId: z.string().min(1), itemCount: z.number().int().nonnegative(),
}));
export const configValidated = defineEvent("config.validated", MODULE, z.object({
  scope: z.literal("tariff"), ok: z.boolean(), errorCount: z.number().int().nonnegative(), caSigned: z.boolean(),
}));
```

**Semantics (D5, restated as code obligations):** `submitVersion` requires ≥1 item (`empty_version`) and flips `draft→submitted` with a conditional UPDATE before calling `requestApproval` on the same tx. `activateVersion` is check-on-execute (merge.ts:85-102 pattern): status must be `submitted` (`not_submitted`), approval must be `granted` (`approval_not_granted` while pending, `approval_rejected` + version marked `rejected` when rejected), activator ≠ `createdBy` and ≠ `submittedBy` (`sod_drafter_activator`), then inside `withTx`: `SELECT id FROM tariff_versions WHERE status = 'activated' FOR UPDATE` (serializes concurrent activations), monotonicity re-check (`effective_from_not_monotone` unless strictly greater than every activated `effectiveFrom`), single-winner conditional UPDATE `WHERE id = … AND status = 'submitted'` (0 rows → `not_submitted`), then `appendEvent(tariffRevisionApplied.make({ actor, payload: … }))`. `resolveActiveTariffVersion` = greatest `effectiveFrom <= at` among `activated` (equal included).

- [ ] **Step 1: Failing tests** — `versions.test.ts`. `beforeEach` mirrors merge.test.ts:37-68 **verbatim in shape**: `truncateAll`, `seedSodPairs`, create users `drafter`/`activator`/`owner_user`, `createRole(db, "owner", "Owner")` + `assignRole` owner_user, then the two-step runbook registration with `approvalFlowDefinition({ typeKey: TARIFF_REVISION_APPROVAL_TYPE, title: "Tariff Revision", approverRole: "owner", closureSlaMinutes: 1440 })` → `createDraft(db, drafterActor, def)` → `activateDefinition(db, activatorActor, draft.definitionId)` → `registerApprovalType(db, activatorActor, { typeKey: TARIFF_REVISION_APPROVAL_TYPE, title: "Tariff Revision", approverRole: "owner", urgencyClass: "routine", actFirstAllowed: false })`. Plus two services and a helper `mkDraft(prices)` (createDraftVersion + setTariffItem each). Nine tests:
  1. *happy path end-to-end*: draft → items → submit (approvalId returned; row `submitted`) → `approveRequest` by owner → activate by a **third** user → row `activated`, `effectiveFrom` set; **exactly one `tariff.revision_applied` event row exists and its payload deep-equals** `{ versionId, versionNo: 1, effectiveFrom: <the ISO string passed>, approvalId, itemCount: 2 }` (assert against the `events` table, not the return value).
  2. *activate while pending → `approval_not_granted`*; after `rejectRequest` → `approval_rejected` **and** the version row is `rejected`.
  3. *SoD separates from approval state*: approval **granted** first, then the drafter attempts activation → `sod_drafter_activator`; the same call by the third user then **succeeds** — proving the block was SoD, not approval state (§3.14b lesson: name the mechanism; the success afterward is the discriminator).
  4. *setTariffItem after submit → `not_draft`*; item prices validate via `assertPaise` (reject 1.5 and −1).
  5. *submit with zero items → `empty_version`* (and status stays `draft` — the check precedes the flip).
  6. *monotone effectiveFrom*: v1 activated at Feb-1; v2 (fresh draft/submit/approve) with effectiveFrom Feb-1 → `effective_from_not_monotone`; Mar-1 → succeeds.
  7. *resolution boundary*: `resolveActiveTariffVersion(db, exactly Feb-1)` → v1 (equal included); at Jan-31 → null; after v2 activates Mar-1: at Feb-15 → **v1** (the lock: an old date still resolves the old version), at Mar-1 → v2.
  8. *copyFromVersionId copies items* (count + one price asserted; copied rows are new ids in the new version).
  9. *activation race*: `Promise.allSettled([activateVersion(...), activateVersion(...)])` by two different eligible activators on the SAME submitted version → exactly one fulfilled; the loser's `TariffError.code === "not_submitted"` (the only code the arbiter can produce — pre-check and 0-row conditional UPDATE both land there; §3.13: traced, single value); **invariant asserted: one `activated` row, exactly one `tariff.revision_applied` event.**
- [ ] **Step 2: Run to fail** — `pnpm --filter @hmis/core test -- versions.test`.
- [ ] **Step 3: Implement `events.ts` (the block above, verbatim) + `versions.ts`** per the semantics block. `createDraftVersion` computes `versionNo` as `max + 1` inside the tx (`tariff_versions_no_ux` is the race backstop).
- [ ] **Step 4: Run to pass** — 9 tests green; run the race test **five times** (`--testNamePattern` on the race test, five invocations) to shake §3.13-class flake.
- [ ] **Step 5: Commit** — `feat(core): tariff versions — draft/submit/activate via approvals, tariff.revision_applied` → pull --rebase → push.

**Acceptance criteria:** the nine named tests pass; the event payload is asserted via deep-equal against the `events` table; the SoD test grants the approval **before** the drafter's attempt (mechanism-separating, §3.14b); the race loser's code is the single enumerated value and the invariant assertions run on every code path (no early bail — §3.13); `versions.ts` mints no event name other than through `events.ts`.

---

### Task 5: Context loader, adjustment-rule config, GST config, seed, D-17 validation library

**Files:**
- Create: `apps/core/src/modules/tariff/rules.ts`, `rules.test.ts`, `gst-config.ts`, `gst-config.test.ts`, `context.ts`, `context.test.ts`
- Create: `apps/core/scripts/seed-tariff.ts`
- Modify: `apps/core/package.json` (+1 script line: `"seed:tariff": "tsx scripts/seed-tariff.ts"`)

**Interfaces:**
- Consumes: T1–T4 module surface; zod ^4; seed conventions (scripts/seed-registration.ts precedent: `requireEnv` where needed, idempotent upserts, `main().catch(…process.exit(1))`).
- Produces:

```ts
// rules.ts
export const ruleParamsSchema: z.ZodType<…>       // { kind, value (int ≥1; ≤10000 when percent), discountCategory, requiredTag: string|null }
export const manualCapParamsSchema: z.ZodType<…>  // { discountCategory, maxBps: int 0..10000, approvalAboveBps: int 0..10000 | null }
export function upsertAdjustmentRule(tx: Tx, actor: Actor, input: { ruleKey: string; sourceKey: "rule" | "manual"; title: string; params: unknown; serviceCategory?: string | null; serviceId?: string | null; validFrom?: Date | null; validTo?: Date | null; active?: boolean }): Promise<{ id: string }>  // throws invalid_rule_params
export function listAdjustmentRules(db: Db, opts?: { sourceKey?: string }): Promise<AdjustmentRuleRow[]>
export function loadRuleConfig(db: Db, at: Date): Promise<{ rules: AdjustmentRuleConfig[]; manualCaps: ManualCaps }>  // active rows within validity at `at`, params parsed

// gst-config.ts
export function upsertGstCategory(tx: Tx, actor: Actor, cfg: GstCategoryConfig): Promise<void>   // gst_config_invalid on bad shapes (room-rent rule without threshold, negative rate)
export function listGstCategories(db: Db): Promise<GstCategoryConfig[]>
export function getGstSettings(db: Db): Promise<GstSettings>            // settings_missing with the seed hint when row 'main' absent
export function upsertGstSettings(tx: Tx, actor: Actor, patch: Partial<GstSettings>): Promise<void>

// context.ts
export function loadPricingContext(db: Db, opts: { at: Date; tariffVersionId?: string; allowDraft?: boolean; tags?: string[] }): Promise<PricingContext>
export type ConfigError = { code: string; detail: string };
export function validateTariffConfig(db: Db, at: Date): Promise<{ ok: boolean; errors: ConfigError[]; caSigned: boolean }>
```

**Semantics:** `loadPricingContext` resolves the version (explicit `tariffVersionId` wins — the lock; must be `activated` unless `allowDraft`, else `version_not_active`; unknown id → `unknown_version`; no explicit id and nothing resolvable at `at` → `version_not_active`), loads items/services/regulated-at-`at`/gst/rules-at-`at`, sets `sources: [standingRuleSource, manualDiscountSource]` and `tags: opts.tags ?? []`. `validateTariffConfig` checks, in order, accumulating `ConfigError`s (never throwing): resolvable active version · every **active** service priced in it · every category used by an active service has a `gst_config` row · every **regulated** active service has an effective `regulated_prices` row · every `adjustment_rules.params` parses under its source schema · all four D-8 categories have caps rows · `gst_settings` present · then smoke-prices every active service (qty 1, no tags/discounts) through the **real** `priceInvoiceLines`, converting any throw into an error entry.

- [ ] **Step 1: Failing rules tests** — `rules.test.ts` (DB suite). Five tests: upsert + list round-trip · **bad params rejected by name** (`invalid_rule_params` for: percent value 10001; flat value 0; unknown discountCategory; missing requiredTag key — zod v4 messages not asserted, only the code) · *"params survive a jsonb round-trip and parse under the source schema"* — insert a rule via `upsertAdjustmentRule`, read via `loadRuleConfig`, deep-equal the parsed `AdjustmentRuleConfig` including `requiredTag: null` surviving as `null` not `undefined` (**this test owns verify-by-execution flag ⑤** — §3.9: the flag lives in the task whose code it protects) · validity window: rule with `validTo` in the past excluded at `at`, included at an earlier `at` · caps keyed by category with `approvalAboveBps: null` surviving.
- [ ] **Step 2: Run to fail; implement `rules.ts`.** zod v4, **no `z.coerce` anywhere** (§3.19); `params` stored as the zod-parsed object, not the raw input.
- [ ] **Step 3: Failing gst-config tests** — `gst-config.test.ts`. Four tests: category upsert + list round-trip (threshold paise as number) · `gst_config_invalid` on room-rent rule without threshold and on negative rateBps · `getGstSettings` missing row → `TariffError("settings_missing")` whose message names `seed:tariff` · settings upsert round-trip (`caSigned` flip persists, `updatedBy` recorded).
- [ ] **Step 4: Run to fail; implement `gst-config.ts`. Step 5: failing context tests** — `context.test.ts`. Six tests, seeding through the T2/T4/T5 functions (never raw inserts except where the test targets absence):
  1. *full load happy path*: activated version + 2 services (one regulated with an effective row) + gst rows + settings + one rule + caps → `loadPricingContext` returns a ctx whose every field deep-equals the expectation (items map, regulated map, sources keys `["rule","manual"]` **in that order**, tags default `[]`).
  2. *the lock*: explicit `tariffVersionId` of an OLD activated version wins over the newer one that `at` would resolve.
  3. *`version_not_active` for a draft id without `allowDraft`; same id loads with `allowDraft: true`* (simulation's path).
  4. *`unknown_version`*.
  5. *regulated resolution respects `at`* (row effective Mar-1 invisible at Feb-1 — the context is as-of-date faithful).
  6. *validateTariffConfig*: a fully-seeded config → `{ ok: true, errors: [], caSigned: false }`; then break it four ways in sequence (unpriced active service; missing gst category; regulated service without row; corrupt params via raw db update) → each produces its named error code, `ok: false`, and the runs never throw.
- [ ] **Step 6: Run to fail; implement `context.ts`. Step 7: write `scripts/seed-tariff.ts`** — idempotent upserts (the seed-registration.ts shape): `gst_settings` main `{ compositeHealthcareExempt: true, caSigned: false }`; five category rows exactly as the Fixture Book's CONFIG_A table (consultation/procedure exempt with would-be 1800; room_rent 500 + rule + threshold 500000; pharmacy 1200; device 500) — **every value commented `DEV PLACEHOLDER — CA sign-off required (§19)`**; four manual-caps rows (charity 2500/1000, employee 1000/null, scheme 1500/1000, negotiated_corporate 2000/1500). Add the package.json script line.
- [ ] **Step 8: Run all module suites** — `pnpm --filter @hmis/core test -- "modules/tariff"` → 15 new tests green (5+4+6). **Step 9: run the seed against the dev DB once** (`pnpm --filter @hmis/core seed:tariff`), then re-run it — second run must not error (idempotency proven by execution).
- [ ] **Step 10: Commit** — `feat(core): pricing context loader, adjustment-rule config, GST config, seed:tariff, D-17 validation` → pull --rebase → push.

**Acceptance criteria:** the 15 named tests pass; flag ⑤'s jsonb round-trip test exists under that exact name and asserts `null` (not `undefined`) survival; `validateTariffConfig` never throws on broken config (accumulates); the seed is idempotent by demonstrated double-run; package.json gains exactly one line; no `z.coerce` in the module (gate greps).

---

### Task 6: The golden suite — 12 hand-computed fixtures + hermetic harness  *(opus coder)*

**Files:**
- Create: `apps/core/src/modules/tariff/fixture-schema.ts`, `golden.test.ts`
- Create: `apps/core/src/modules/tariff/golden/fixtures/` — 12 files: `g01-baseline-exempt.json`, `g02-perhead-vs-split.json`, `g03-halfup-direction.json`, `g04-room-rent-boundary.json`, `g05-regulated-min.json`, `g06-regulated-missing.json`, `g07-contest-three-way.json`, `g08-contest-tie.json`, `g09-manual-over-cap.json`, `g10-flat-approval-flag.json`, `g11-composite-supply.json`, `g13-room-rent-postdiscount-ca.json`

(G12, the simulation fixture, ships with Task 7 — `simulateRevision` does not exist yet in pipeline A.)

**Interfaces:**
- Consumes: `priceInvoiceLines`, `types.ts`, the two shipped sources — via **relative imports inside the module** (no index yet; T8 ships it).
- Produces: the fixture JSON schema Plans 08/09 extend with their own cases (split tenders, refunds, membership/coupon contests — §18's remaining enumerated cases land in those plans, in **this** harness).

**Harness contract (the §3.14 mechanics):**

```ts
// fixture-schema.ts — zod v4, NO z.coerce anywhere
import { z } from "zod";
import { manualDiscountSource, standingRuleSource } from "./contest";
import type { GstCategoryConfig, PricingContext, ServiceInfo } from "./types";
const paise = z.number().int().nonnegative();
const workings = z.string().min(20); // a fixture without real arithmetic shown FAILS to parse
const serviceInfo = z.object({ id: z.string(), code: z.string(), name: z.string(), category: z.string(), regulated: z.boolean(), active: z.boolean() });
const gstCategory = z.object({ category: z.string(), sacCode: z.string(), exempt: z.boolean(), rateBps: z.number().int(),
  specialRule: z.enum(["room_rent_daily_threshold"]).nullable(), thresholdPaise: paise.nullable() });
const ruleConfig = z.object({ ruleKey: z.string(), title: z.string(), kind: z.enum(["percent_bps", "flat_paise"]), value: z.number().int().positive(),
  discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]), requiredTag: z.string().nullable(),
  serviceCategory: z.string().nullable(), serviceId: z.string().nullable() });
const configSchema = z.object({
  asOf: z.string(), // ISO
  tariff: z.object({ versionId: z.string(), versionNo: z.number().int(), items: z.record(z.string(), paise) }),
  services: z.array(serviceInfo),
  regulatedPrices: z.record(z.string(), z.object({ mrpPaise: paise.nullable(), ceilingPaise: paise.nullable() })),
  gstCategories: z.array(gstCategory),
  gstSettings: z.object({ compositeHealthcareExempt: z.boolean(), caSigned: z.boolean() }),
  rules: z.array(ruleConfig),
  manualCaps: z.record(z.string(), z.object({ maxBps: z.number().int(), approvalAboveBps: z.number().int().nullable() })),
  tags: z.array(z.string()),
});
const lineInput = z.object({ lineId: z.string(), serviceId: z.string(), qty: z.number().int().positive(),
  supplyContext: z.enum(["standalone", "composite_healthcare"]).optional(),
  manualDiscount: z.object({ discountCategory: z.enum(["charity", "scheme", "negotiated_corporate", "employee"]),
    kind: z.enum(["percent_bps", "flat_paise"]), value: z.number().int().positive(), reason: z.string() }).nullable().optional() });
export const fixtureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("price"), name: z.string(), specRefs: z.array(z.string()).min(1), caFlag: z.string().optional(),
    config: configSchema, lines: z.array(lineInput).min(1),
    expected: z.array(z.object({ workings, line: z.unknown() })).min(1) }), // line deep-equals the full PricedLine
  z.object({ kind: z.literal("price_error"), name: z.string(), specRefs: z.array(z.string()).min(1),
    config: configSchema, lines: z.array(lineInput).min(1),
    expected: z.object({ workings, errorCode: z.string() }) }),
]);
export type GoldenFixture = z.infer<typeof fixtureSchema>;

export function contextFromFixture(config: z.infer<typeof configSchema>): PricingContext {
  const services: Record<string, ServiceInfo> = {};
  for (const s of config.services) services[s.id] = s;
  const categories: Record<string, GstCategoryConfig> = {};
  for (const c of config.gstCategories) categories[c.category] = c;
  return {
    asOf: new Date(config.asOf),
    tariff: config.tariff,
    services,
    regulatedPrices: config.regulatedPrices,
    gst: { categories, settings: config.gstSettings },
    rules: config.rules,
    manualCaps: config.manualCaps,
    sources: [standingRuleSource, manualDiscountSource], // the shipped order — tie-break precedence (D3)
    tags: config.tags,
  };
}
```

```ts
// golden.test.ts — HERMETIC: no setupTestDb, no kernel import, no network, no clock
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureSchema, contextFromFixture } from "./fixture-schema";
import { priceInvoiceLines } from "./pricing";
import { TariffError } from "./errors";

const dir = join(__dirname, "golden", "fixtures");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

test("the fixture set is complete (an empty dir must never pass vacuously)", () => {
  expect(files.length).toBe(12); // T7 bumps to 13 (g12); Plans 08/09 bump again as they add cases
});

for (const file of files) {
  const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
  test(`golden ${file}: ${fixture.name}`, () => {
    const ctx = contextFromFixture(fixture.config);
    if (fixture.kind === "price_error") {
      expect.assertions(2);
      try { priceInvoiceLines(ctx, fixture.lines); } catch (e) {
        expect(e).toBeInstanceOf(TariffError);
        expect((e as TariffError).code).toBe(fixture.expected.errorCode);
      }
      return;
    }
    const priced = priceInvoiceLines(ctx, fixture.lines);
    expect(priced.length).toBe(fixture.expected.length);
    priced.forEach((line, i) => expect(line).toEqual(fixture.expected[i]?.line)); // FULL deep-equal — no partial matching
  });
}
```

Every fixture is **fully self-contained** (embeds its whole config), the harness never opens a database, and expected `line` objects are complete `PricedLine` literals — a partial matcher would let wrong fields ride (§3.14).

#### The shared config — CONFIG_A (every fixture embeds this block verbatim; deltas are stated per fixture)

`asOf: "2026-09-01T00:00:00.000Z"` · tariff `{ versionId: "v1", versionNo: 1 }` · `gstSettings { compositeHealthcareExempt: true, caSigned: false }` · `tags: []` unless stated.

| services (id · category · regulated) | tariff item (paise) | regulatedPrices (paise) |
|---|---|---|
| svc-cons · consultation · no | 50000 | — |
| svc-proc · procedure · no | 33335 | — |
| svc-room-gen · room_rent · no | 480000 | — |
| svc-room-dlx · room_rent · no | 600000 | — |
| svc-room-eq · room_rent · no | 500000 | — |
| svc-room-semi · room_rent · no | 550000 | — |
| svc-tab · pharmacy · no | 18875 | — |
| svc-dev · device · no | 33333 | — |
| svc-drug-a · pharmacy · **yes** | 12000 | mrp 10000 · ceiling 15000 |
| svc-drug-b · pharmacy · **yes** | 9000 | mrp 10000 · ceiling 8000 |
| svc-drug-c · pharmacy · **yes** | 7000 | mrp 10000 · ceiling 8000 |
| svc-drug-d · pharmacy · **yes** | 5000 | **no row** |

| gstCategories | sacCode | exempt | rateBps | specialRule | thresholdPaise |
|---|---|---|---|---|---|
| consultation | 999312 | **true** | 1800 (would-be — §3.14 defense) | null | null |
| procedure | 999312 | **true** | 1800 | null | null |
| room_rent | 999311 | false | 500 | room_rent_daily_threshold | 500000 |
| pharmacy | 3004 | false | 1200 | null | null |
| device | 9021 | false | 500 | null | null |

Rules: `R-CAMP5` (percent 500, scheme, requiredTag "camp2026", serviceCategory "procedure") · `R-EMP10` (percent 1000, employee, requiredTag "employee", no scope). Manual caps: charity 2500/1000 · employee 1000/null · scheme 1500/1000 · negotiated_corporate 2000/1500. All values are **dev placeholders pending CA sign-off** (§19); the fixtures test the ENGINE against its config, whatever the config says.

**CONFIG_A as JSON — paste this exact block as the `config` value of every fixture** (fixtures with tags override `"tags"`; G12 also derives its `draftConfig` from it; drug-d's absence from `regulatedPrices` is deliberate — it is G06's error case):

```json
{
  "asOf": "2026-09-01T00:00:00.000Z",
  "tariff": { "versionId": "v1", "versionNo": 1, "items": {
    "svc-cons": 50000, "svc-proc": 33335, "svc-room-gen": 480000, "svc-room-dlx": 600000,
    "svc-room-eq": 500000, "svc-room-semi": 550000, "svc-tab": 18875, "svc-dev": 33333,
    "svc-drug-a": 12000, "svc-drug-b": 9000, "svc-drug-c": 7000, "svc-drug-d": 5000 } },
  "services": [
    { "id": "svc-cons", "code": "CONS-GEN", "name": "General consultation", "category": "consultation", "regulated": false, "active": true },
    { "id": "svc-proc", "code": "PROC-MIN", "name": "Minor procedure", "category": "procedure", "regulated": false, "active": true },
    { "id": "svc-room-gen", "code": "ROOM-GEN", "name": "General ward bed per day", "category": "room_rent", "regulated": false, "active": true },
    { "id": "svc-room-dlx", "code": "ROOM-DLX", "name": "Deluxe room per day", "category": "room_rent", "regulated": false, "active": true },
    { "id": "svc-room-eq", "code": "ROOM-EQ", "name": "Semi-private room per day", "category": "room_rent", "regulated": false, "active": true },
    { "id": "svc-room-semi", "code": "ROOM-SEMI", "name": "Private room per day", "category": "room_rent", "regulated": false, "active": true },
    { "id": "svc-tab", "code": "PHARM-TAB", "name": "Paracetamol 500 strip", "category": "pharmacy", "regulated": false, "active": true },
    { "id": "svc-dev", "code": "DEV-ORTHO", "name": "Orthopedic device", "category": "device", "regulated": false, "active": true },
    { "id": "svc-drug-a", "code": "DRUG-A", "name": "Drug A", "category": "pharmacy", "regulated": true, "active": true },
    { "id": "svc-drug-b", "code": "DRUG-B", "name": "Drug B", "category": "pharmacy", "regulated": true, "active": true },
    { "id": "svc-drug-c", "code": "DRUG-C", "name": "Drug C", "category": "pharmacy", "regulated": true, "active": true },
    { "id": "svc-drug-d", "code": "DRUG-D", "name": "Drug D", "category": "pharmacy", "regulated": true, "active": true }
  ],
  "regulatedPrices": {
    "svc-drug-a": { "mrpPaise": 10000, "ceilingPaise": 15000 },
    "svc-drug-b": { "mrpPaise": 10000, "ceilingPaise": 8000 },
    "svc-drug-c": { "mrpPaise": 10000, "ceilingPaise": 8000 }
  },
  "gstCategories": [
    { "category": "consultation", "sacCode": "999312", "exempt": true, "rateBps": 1800, "specialRule": null, "thresholdPaise": null },
    { "category": "procedure", "sacCode": "999312", "exempt": true, "rateBps": 1800, "specialRule": null, "thresholdPaise": null },
    { "category": "room_rent", "sacCode": "999311", "exempt": false, "rateBps": 500, "specialRule": "room_rent_daily_threshold", "thresholdPaise": 500000 },
    { "category": "pharmacy", "sacCode": "3004", "exempt": false, "rateBps": 1200, "specialRule": null, "thresholdPaise": null },
    { "category": "device", "sacCode": "9021", "exempt": false, "rateBps": 500, "specialRule": null, "thresholdPaise": null }
  ],
  "gstSettings": { "compositeHealthcareExempt": true, "caSigned": false },
  "rules": [
    { "ruleKey": "R-CAMP5", "title": "Camp 2026 procedure scheme", "kind": "percent_bps", "value": 500, "discountCategory": "scheme", "requiredTag": "camp2026", "serviceCategory": "procedure", "serviceId": null },
    { "ruleKey": "R-EMP10", "title": "Employee discount", "kind": "percent_bps", "value": 1000, "discountCategory": "employee", "requiredTag": "employee", "serviceCategory": null, "serviceId": null }
  ],
  "manualCaps": {
    "charity": { "maxBps": 2500, "approvalAboveBps": 1000 },
    "employee": { "maxBps": 1000, "approvalAboveBps": null },
    "scheme": { "maxBps": 1500, "approvalAboveBps": 1000 },
    "negotiated_corporate": { "maxBps": 2000, "approvalAboveBps": 1500 }
  },
  "tags": []
}
```

#### The Fixture Book — every expected value hand-derived, with the wrong implementation each fixture kills

All arithmetic uses D1's primitives. `head(base, rate) = divHalfUp(base × rate, 20000)`; `pct(gross, bps) = divHalfUp(gross × bps, 10000)`.

**G01 — baseline exempt consultation.** Line: svc-cons ×1, no tags, no discount.
Workings: unit 50000 ×1 = gross 50000; no candidates (no tags, no manual) → discount 0; consultation `exempt: true` → heads 0/0 despite `rateBps 1800`; **net 50000**. Expected line: `{ unitPaise: 50000, grossPaise: 50000, regulatedClamp: null, candidates: [], winner: null, discountPaise: 0, taxableBasePaise: 50000, gst: { sacCode: "999312", rateBps: 1800, exempt: true, exemptReason: "category_exempt", cgstPaise: 0, sgstPaise: 0 }, netPaise: 50000 }` (+ identity fields).
**Kills:** an implementation that ignores the `exempt` flag and applies the rate → heads 4500/4500, net 59000 ≠ 50000. The nonzero would-be rate is what gives this fixture teeth.

**G02 — per-head vs total-then-split.** Line: svc-dev ×1.
Workings: gross 33333; taxable at 500bps; per head = divHalfUp(33333 × 500, 20000) = divHalfUp(16,666,500, 20000) = 833 (exact 833.325); **net 33333 + 833 + 833 = 34999**.
**Kills:** total-then-split — total 5% = 1666.65 → 1667, any split sums 1667 → net 35000 ≠ 34999.

**G03 — rounding direction.** Lines: svc-tab ×1; svc-tab ×3.
Workings L1: gross 18875; head = divHalfUp(18875 × 1200, 20000) = divHalfUp(22,650,000, 20000) = **1133** (exact 1132.5 — half-up; banker's says 1132, truncation says 1132); net 18875 + 2266 = **21141**. L2: gross 56625; head = divHalfUp(67,950,000, 20000) = 3398 (exact 3397.5); net 56625 + 6796 = **63421**.
**Kills:** truncation AND banker's rounding (both give L1 net 21139); also any impl multiplying tax before qty (L2 ≠ 3 × L1's tax: 3398 ≠ 3 × 1133 = 3399 — per-line-total taxation is pinned).

**G04 — room-rent boundary (D-3 ₹5k/day).** Lines: svc-room-gen ×2; svc-room-dlx ×2; svc-room-eq ×1.
Workings: gen — gross 960000; threshold × qty = 1,000,000; 960000 > 1,000,000 false → **exempt** `room_rent_at_or_below_threshold`, net 960000. dlx — gross 1,200,000 > 1,000,000 → taxable; head = divHalfUp(1,200,000 × 500, 20000) = 30000; net **1,260,000**. eq — gross 500000; 500000 > 500000 false → **exempt**, net 500000 ("exceeding" = strictly greater).
**Kills:** per-line-threshold impl (`base > threshold` says gen's 960000 is taxable); `>=` impl (taxes the exactly-at-threshold eq line).

**G05 — regulated three-way min (C-3).** Lines: drug-a ×1; drug-b ×1; drug-c ×1. Full fixture JSON verbatim (the exemplar file — the others follow the identical shape):

```json
{
  "kind": "price",
  "name": "C-3 min(tariff, MRP, ceiling): each bound wins once, each min distinct",
  "specRefs": ["C-3", "§7"],
  "config": { "…": "CONFIG_A — paste the 'CONFIG_A as JSON' block above, verbatim" },
  "lines": [
    { "lineId": "L1", "serviceId": "svc-drug-a", "qty": 1 },
    { "lineId": "L2", "serviceId": "svc-drug-b", "qty": 1 },
    { "lineId": "L3", "serviceId": "svc-drug-c", "qty": 1 }
  ],
  "expected": [
    { "workings": "drug-a: min(tariff 12000, mrp 10000, ceiling 15000) = 10000 -> clamp mrp; pharmacy 12%: head = divHalfUp(10000*1200, 20000) = 600; net 10000+600+600 = 11200",
      "line": { "lineId": "L1", "serviceId": "svc-drug-a", "serviceName": "Drug A", "category": "pharmacy",
        "qty": 1, "unitPaise": 10000, "grossPaise": 10000,
        "regulatedClamp": { "boundApplied": "mrp", "tariffPaise": 12000, "mrpPaise": 10000, "ceilingPaise": 15000 },
        "candidates": [], "winner": null, "discountPaise": 0, "taxableBasePaise": 10000,
        "gst": { "sacCode": "3004", "rateBps": 1200, "exempt": false, "exemptReason": null, "cgstPaise": 600, "sgstPaise": 600 },
        "netPaise": 11200 } },
    { "workings": "drug-b: min(9000, 10000, 8000) = 8000 -> clamp ceiling (NPPA hard block); head = divHalfUp(8000*1200, 20000) = 480; net 8960",
      "line": { "lineId": "L2", "serviceId": "svc-drug-b", "serviceName": "Drug B", "category": "pharmacy",
        "qty": 1, "unitPaise": 8000, "grossPaise": 8000,
        "regulatedClamp": { "boundApplied": "ceiling", "tariffPaise": 9000, "mrpPaise": 10000, "ceilingPaise": 8000 },
        "candidates": [], "winner": null, "discountPaise": 0, "taxableBasePaise": 8000,
        "gst": { "sacCode": "3004", "rateBps": 1200, "exempt": false, "exemptReason": null, "cgstPaise": 480, "sgstPaise": 480 },
        "netPaise": 8960 } },
    { "workings": "drug-c: min(7000, 10000, 8000) = 7000 -> tariff wins, NO clamp recorded; head = divHalfUp(7000*1200, 20000) = 420; net 7840",
      "line": { "lineId": "L3", "serviceId": "svc-drug-c", "serviceName": "Drug C", "category": "pharmacy",
        "qty": 1, "unitPaise": 7000, "grossPaise": 7000,
        "regulatedClamp": null,
        "candidates": [], "winner": null, "discountPaise": 0, "taxableBasePaise": 7000,
        "gst": { "sacCode": "3004", "rateBps": 1200, "exempt": false, "exemptReason": null, "cgstPaise": 420, "sgstPaise": 420 },
        "netPaise": 7840 } }
  ]
}
```

**Kills:** any wrong min-ordering — the three tariff/mrp/ceiling triples are chosen so every pairwise swap changes at least one net (11200 / 8960 / 7840 all distinct); an impl that reports a clamp when the tariff wins fails L3.

**G06 — regulated data missing → hard error.** Line: drug-d ×1. `kind: "price_error"`, expected `errorCode: "regulated_price_missing"`. Workings: svc-drug-d is `regulated: true` with no regulatedPrices entry — C-3 forbids pricing a regulated item without its MRP/ceiling data; the engine must throw, not fall back to tariff 5000. **Kills:** the silent-fallback impl (which would price the line at 5000 and keep going).

**G07 — three-way contest, best-single-benefit.** Line: svc-proc ×1, `tags: ["employee", "camp2026"]`, manual `{ charity, percent_bps 800, "hardship" }`.
Workings: gross 33335. Candidates in order (sources `[rule, manual]`, rules by ruleKey asc): R-CAMP5 (procedure ✓ tag ✓) pct(33335, 500) = divHalfUp(16,667,500, 10000) = **1667** (exact 1666.75); R-EMP10 (no scope, tag ✓) pct(33335, 1000) = **3334** (exact 3333.5); manual charity pct(33335, 800) = **2667** (exact 2666.8), within cap 2500bps, requiresApproval false (26,670,000 > 1000 × 33335 = 33,335,000 is false). Winner = R-EMP10 at 3334 (largest). taxableBase 33335 − 3334 = **30001**; procedure exempt → **net 30001**. Expected: candidates array of all three (each field spelled in the file), winner = the R-EMP10 candidate object, `discountPaise: 3334`.
**Kills:** stacking (any two benefits combined → base < 30001); wrong max; candidate rounding drift (each candidate value is a half-up pin); a source that fails to propose (candidates.length must be 3).

**G08 — tie-break by source order.** Line: svc-cons ×1, `tags: ["employee"]`, manual `{ charity, percent_bps 1000, "tie-test" }`.
Workings: R-EMP10 = pct(50000, 1000) = 5000; manual = 5000, cap ok (50,000,000 ≤ 2500 × 50000), requiresApproval **false** (50,000,000 > 1000 × 50000 = 50,000,000 is false — exactly-at-the-line is NOT above, exact rational compare). Tie 5000 = 5000 → earlier source wins → **winner sourceKey "rule", ruleKey "R-EMP10"**; net 45000 (exempt).
**Kills:** last-wins or manual-first tie-breaks; a rounded (rather than exact-rational) approval check, which would misflag the boundary case.

**G09 — manual over cap: rejected and RECORDED, never clamped.** Line: svc-cons ×1, no tags, manual `{ negotiated_corporate, percent_bps 2500, "asked too much" }`.
Workings: asked pct(50000, 2500) = 12500; cap 2000bps → 12500 × 10000 = 125,000,000 > 2000 × 50000 = 100,000,000 → **rejected `over_cap`**, candidate recorded with `amountPaise: 12500` (the ASKED amount — the audit record); no valid candidates → winner null, discount 0, **net 50000**; `candidates.length: 1`.
**Kills:** clamp-to-cap (net 40000); silent drop (empty candidates array).

**G10 — flat discount + the approval flag.** Line: svc-cons ×1, manual `{ charity, flat_paise 10000, "camp waiver" }`.
Workings: flat 10000 ≤ gross; cap: 100,000,000 ≤ 2500 × 50000 = 125,000,000 ✓; approvalAbove 1000: 100,000,000 > 1000 × 50000 = 50,000,000 → **requiresApproval true**. Winner manual 10000; base 40000; exempt → **net 40000**.
**Kills:** flat treated as bps; the approval flag not computed (Plan 08 will enforce it — a false here silently disarms that enforcement).

**G11 — composite supply (D-3).** Lines: svc-tab ×1 standalone; svc-tab ×1 `supplyContext: "composite_healthcare"`.
Workings: L1 = G03's L1 = **net 21141** (taxable). L2: same service, composite context + `compositeHealthcareExempt: true` → **exempt `composite_healthcare`**, net **18875**. Same input except the context flag — 21141 vs 18875.
**Kills:** ignoring `supplyContext`; ignoring the settings switch (contest.test's `false`-setting case covers the other direction).

**G13 — room-rent threshold on the post-discount value (CA-FLAGGED).** Line: svc-room-semi ×1, manual `{ charity, percent_bps 1000, "concession" }`. Fixture field `caFlag: "Threshold compared against POST-DISCOUNT charged value (₹4,950 < ₹5,000 ⇒ exempt). CONFIRM WITH CA at the §19 gate; if the pre-discount reading is ruled, gst.ts's comparison moves to grossPaise and this fixture's expectation changes to net 519750."`
Workings: gross 550000; discount pct(550000, 1000) = 55000 (cap ok: 550,000,000 ≤ 2500 × 550000 = 1,375,000,000; approval flag false: 550,000,000 > 1000 × 550000 = 550,000,000 is false); base 495000; threshold: 495000 > 500000 × 1 false → **exempt**, net **495000**. (Pre-discount reading: 550000 > 500000 → taxable, heads divHalfUp(495000 × 500, 20000) = 12375 each → net 519750 — the two readings differ by 24750, so the fixture genuinely separates them.)
**Kills:** the pre-discount implementation; and it documents the CA dependency in the artifact the CA will actually re-run.

#### Steps

- [ ] **Step 1: Write `fixture-schema.ts` + `golden.test.ts`** (the blocks above) and **one** fixture file, `g01-baseline-exempt.json`, complete.
- [ ] **Step 2: Run to fail meaningfully** — `pnpm --filter @hmis/core test -- golden` → the count test FAILS (1 file ≠ 12). This is the suite's fail-first evidence: the harness demonstrably refuses an incomplete fixture set.
- [ ] **Step 3: Author the remaining 11 fixtures** from the Fixture Book — every `expected.line` is the complete `PricedLine` literal derived above; every `workings` string carries the arithmetic shown here. **Author the JSON from the Book's numbers — never by running the engine and pasting its output** (acceptance criterion below).
- [ ] **Step 4: Run to pass** — `pnpm --filter @hmis/core test -- golden` → 13 tests (12 fixtures + the count test).
- [ ] **Step 5: Prove the harness has teeth (mutation check — the ledger §5 mutant pattern: the mutant lives in the TEST file; no shipped file is ever touched or copied):** add one test to `golden.test.ts`, `"the harness kills a no-exemption mutant"`. It defines `mutantComputeGst` inline — a copy of `computeGst`'s body with the `cfg.exempt` branch deleted — loads `g01-baseline-exempt.json`, calls the mutant with G01's cfg/settings/line/base 50000/qty 1, and asserts the mutant's output **differs from the fixture's expected `gst` block in the load-bearing way**: `expect(mutantGst.cgstPaise).toBe(4500)` (divHalfUp(50000 × 1800, 20000)) while the fixture expects 0 — so the fixture's full deep-equal would kill this mutant. This is the executable proof that G01's would-be-rate design has teeth.
- [ ] **Step 6: Full module suites green** — `pnpm --filter @hmis/core test -- "modules/tariff"`; then `pnpm --filter @hmis/core test` (whole workspace).
- [ ] **Step 7: Commit** — `test(core): golden suite — 12 hand-computed fixtures, hermetic harness` → pull --rebase → push.

**Acceptance criteria (the §3.14 criteria, gate-checkable without running anything):**
1. Every fixture's `workings` reproduces its expected numbers from the fixture's own inputs using D1's rules — the gate re-derives **at least G02, G03-L1, G05-L2, G07, and G13 by hand** and fails the task on any mismatch between workings, expectation, and this document's Fixture Book.
2. **The expected values were derived independently of the implementation**: the Book in this plan is the source; a fixture whose expectation matches engine output but contradicts the Book is a FAIL even if the suite is green (the suite being green while the Book says otherwise means the engine is wrong too).
3. No fixture is vacuous: every discount fixture has a nonzero discount, every exemption fixture's taxable-counterfactual differs numerically, every rounding fixture separates half-up from truncation or banker's, G04 pins both boundary directions.
4. The harness runs with no database (`golden.test.ts` imports neither `setupTestDb` nor anything under `kernel/`), deep-equals full `PricedLine` objects, pins the fixture count at 12, and the in-test mutant check passes.
5. 14 tests total in `golden.test.ts` (12 fixtures + count + mutant).

---

### Task 7: Impact simulation (§11.11) + the simulation golden fixture

**Files:**
- Create: `apps/core/src/modules/tariff/simulation.ts`, `simulation.test.ts`
- Create: `apps/core/src/modules/tariff/golden/fixtures/g12-impact-simulation.json`
- Modify: `apps/core/src/modules/tariff/fixture-schema.ts` (add the `simulate` variant), `golden.test.ts` (count 12 → 13; simulate branch)

**Interfaces:**
- Consumes: `priceInvoiceLines`, `types.ts` (relative imports; pure).
- Produces:

```ts
export type ImpactLineDelta = { lineId: string; serviceId: string; currentNetPaise: number; draftNetPaise: number; deltaPaise: number };
export type ImpactTotals = { currentNetPaise: number; draftNetPaise: number; deltaPaise: number; currentTaxPaise: number; draftTaxPaise: number; taxDeltaPaise: number };
export type ImpactByService = { serviceId: string; currentNetPaise: number; draftNetPaise: number; deltaPaise: number };
export type ImpactReport = { lines: ImpactLineDelta[]; totals: ImpactTotals; byService: ImpactByService[] };
export function simulateRevision(currentCtx: PricingContext, draftCtx: PricingContext, lines: InvoiceLineInput[]): ImpactReport // PURE, SYNC
```

Implementation: price the same `lines` under both contexts, zip by index, tax = `cgstPaise + sgstPaise` summed, `byService` aggregated by `serviceId` **sorted ascending** (deterministic output). Engine errors propagate — a draft that cannot price the lines is a broken draft and the caller must see which line.

- [ ] **Step 1: Failing unit tests** — `simulation.test.ts` (pure, `makeCtx` fixtures). Three tests: *price-change delta on an exempt service* (cons 50000 → 60000, one line → line delta +10000, taxDelta 0) · *byService aggregates same-service lines* (cons ×1 + cons ×2 under 50000→60000 → one byService row `{ current 150000, draft 180000, delta 30000 }`) · *empty lines → zeroed totals + empty arrays; draft missing an item → throws `tariff_item_missing`* (both directions in one test, `expect.assertions`).
- [ ] **Step 2: Run to fail** (`test -- simulation.test`); **Step 3: implement `simulation.ts`; Step 4: run to pass.**
- [ ] **Step 5: Extend the fixture schema** with the third discriminated variant:

```ts
  z.object({ kind: z.literal("simulate"), name: z.string(), specRefs: z.array(z.string()).min(1),
    config: configSchema, draftConfig: configSchema, lines: z.array(lineInput).min(1),
    expected: z.object({ workings, report: z.unknown() }) }), // report deep-equals the full ImpactReport
```

and the harness branch: `kind === "simulate"` → `expect(simulateRevision(contextFromFixture(f.config), contextFromFixture(f.draftConfig), f.lines)).toEqual(f.expected.report)`. Bump the count assertion to **13**.

- [ ] **Step 6: Author `g12-impact-simulation.json`** — config = CONFIG_A; draftConfig = CONFIG_A with tariff `{ versionId: "v2", versionNo: 2 }` and items deltas: svc-cons **60000**, svc-tab 18875 (unchanged), svc-dev **30000**; lines: cons ×1, tab ×1, dev ×1.

  **G12 workings (hand-derived):** current — cons 50000 (exempt, tax 0) · tab 21141 (tax 2266, from G03) · dev 34999 (tax 1666, from G02) → current net **106140**, tax **3932**. Draft — cons 60000 (exempt) · tab 21141 (unchanged) · dev: gross 30000, head = divHalfUp(30000 × 500, 20000) = 750, net **31500** (tax 1500) → draft net **112641**, tax **3766**. Report: lines deltas `[+10000, 0, −3499]`; totals `{ 106140, 112641, +6501, 3932, 3766, −166 }`; byService asc `[svc-cons {50000, 60000, +10000}, svc-dev {34999, 31500, −3499}, svc-tab {21141, 21141, 0}]`.
  **Kills:** draft priced under current items (all deltas 0); sign errors (dev's is negative — a revision can cut prices); tax deltas ignored (−166 is asserted independently of net).

- [ ] **Step 7: Run** `test -- golden` → 15 tests (13 fixtures + count + mutant) and `test -- simulation.test` → 3. **Step 8: Commit** — `feat(core): impact simulation — simulateRevision (§11.11)` → pull --rebase → push.

**Acceptance criteria:** G12's every number matches the workings above (gate re-derives the totals row); `simulation.ts` passes the purity greps (no await/kernel/Date/random); the count test now pins 13; byService is sorted and aggregated (the two-line test).

---

### Task 8: Module surface — HTTP controller, manifest, module, index, e2e

**Files:**
- Create: `apps/core/src/modules/tariff/tariff.controller.ts`, `tariff.module.ts`, `manifest.ts`, `index.ts`
- Modify: `apps/core/src/app.module.ts` (+1 import line, +`TariffModule` in the imports array, +`registry.install(tariffManifest)`)
- Create: `apps/core/test/tariff.e2e.test.ts`

**Interfaces:**
- Consumes: everything T2–T7 ships; `@RequirePermission`/`@CurrentActor` (Plan 02 guards, global `APP_GUARD`s); `configureApp`; `ApprovalError`/`WorkflowError` for `toHttp`.
- Produces — `manifest.ts`:

```ts
import type { ModuleManifest } from "../../kernel/modules/manifest";
export const tariffManifest: ModuleManifest = {
  key: "tariff",
  title: "Tariff, Pricing & GST",
  menu: [], // no UI this plan — Plan 08's screens link here
  permissions: [
    "tariff.read", "tariff.services.manage", "tariff.versions.draft",
    "tariff.versions.activate", "tariff.config.manage",
  ],
  subscriptions: [],
};
```

`tariff.module.ts` is the patients shape verbatim: `@Module({ controllers: [TariffController] })`. `index.ts` — **THE cross-module interface, frozen for Plans 08/09**:

```ts
export { tariffManifest } from "./manifest";
export { TariffModule } from "./tariff.module";
export { priceInvoiceLines } from "./pricing";
export { runContest, standingRuleSource, manualDiscountSource } from "./contest";
export { computeGst } from "./gst";
export { simulateRevision } from "./simulation";
export type { ImpactByService, ImpactLineDelta, ImpactReport, ImpactTotals } from "./simulation";
export { loadPricingContext, validateTariffConfig } from "./context";
export type { ConfigError } from "./context";
export { appendRegulatedPrice, createService, listServices, resolveRegulatedPrices, updateService } from "./services";
export {
  activateVersion, createDraftVersion, getVersion, listVersions, resolveActiveTariffVersion,
  setTariffItem, submitVersion, TARIFF_REVISION_APPROVAL_TYPE,
} from "./versions";
export { listAdjustmentRules, loadRuleConfig, upsertAdjustmentRule } from "./rules";
export { getGstSettings, listGstCategories, upsertGstCategory, upsertGstSettings } from "./gst-config";
export { assertPaise, divHalfUp, percentAmount, roundTotalToRupee, taxHead } from "./money";
export { TariffError } from "./errors";
export type { TariffErrorCode } from "./errors";
export * from "./types";
export * from "./events";
```

**HTTP wire contract (17 routes, all `@RequirePermission(…, "hospital")`; literal segments carry no `:id` collisions — the `/tariff` prefix has no bare `:id` route):**

```
GET    /tariff/services                          tariff.read              -> { items: ServiceRow[] }
POST   /tariff/services                          tariff.services.manage   -> { serviceId }            201
PATCH  /tariff/services/:id                      tariff.services.manage   -> { ok: true }
POST   /tariff/services/:id/regulated-prices     tariff.services.manage   -> { id }                   201
GET    /tariff/services/:id/regulated-prices     tariff.read              -> { items: RegulatedPriceRow[] }
GET    /tariff/versions                          tariff.read              -> { items: TariffVersionRow[] }
POST   /tariff/versions                          tariff.versions.draft    -> { versionId, versionNo } 201
GET    /tariff/versions/:id                      tariff.read              -> { version, items }        404 unknown
PUT    /tariff/versions/:id/items/:serviceId     tariff.versions.draft    { pricePaise } -> { ok: true }
POST   /tariff/versions/:id/submit               tariff.versions.draft    { requestNote? } -> { approvalId, instanceId }   @HttpCode(200)
POST   /tariff/versions/:id/activate             tariff.versions.activate { effectiveFrom: ISO } -> { versionNo, effectiveFrom }  @HttpCode(200)
POST   /tariff/versions/:id/simulate             tariff.versions.draft    { lines, at? } -> ImpactReport                   @HttpCode(200)
GET    /tariff/rules                             tariff.read              -> { items: AdjustmentRuleRow[] }
POST   /tariff/rules                             tariff.config.manage     -> { id }                   201
GET    /tariff/gst                               tariff.read              -> { categories, settings }
PUT    /tariff/gst/config/:category              tariff.config.manage     -> { ok: true }
PUT    /tariff/gst/settings                      tariff.config.manage     -> { ok: true }
```

Body validation: zod v4 schemas defined at the top of the controller, **no `z.coerce` anywhere** (§3.19) — `qty`/`pricePaise`/bps values are `z.number().int()` with range refinements (JSON numbers arrive as numbers; a string is a 400, correctly). `effectiveFrom`/`at` arrive as ISO strings, parsed explicitly: `const d = new Date(s); if (Number.isNaN(d.getTime())) throw new BadRequestException(...)` — **never `z.coerce.date()`**. `toHttp` (the patients pattern, defined once): `unknown_service`/`unknown_version`/`unknown_rule` → 404 · `sod_drafter_activator` → 403 · `invalid_paise`/`invalid_qty`/`invalid_rule_params`/`regulated_bounds_missing`/`gst_config_invalid` → 400 · every remaining `TariffErrorCode` (state/config conflicts: `not_draft`, `not_submitted`, `empty_version`, `approval_not_granted`, `approval_rejected`, `effective_from_not_monotone`, `version_not_active`, `duplicate_service_code`, `service_inactive`, `tariff_item_missing`, `regulated_price_missing`, `gst_config_missing`, `settings_missing`) → 409 · `ApprovalError`/`WorkflowError` → 409 · unrecognized rethrows.

- [ ] **Step 1: Failing e2e** — `apps/core/test/tariff.e2e.test.ts`. Bootstrap: **copy the app-bootstrap and registry-construction blocks of `test/patients.e2e.test.ts` verbatim**, swapping `patientsManifest` for `tariffManifest` (single-argument `createNestApplication<NestExpressApplication>({ bodyParser: false })` — §3.17's overload trap is already solved there; do not re-derive it). `beforeEach`: `truncateAll`, `seedSodPairs`, `syncPermissions(db, registry)`, seed GST config via `upsertGstCategory`/`upsertGstSettings` (consultation exempt/1800 + pharmacy 1200 + settings), roles: `tariff_admin` granted all five tariff permissions (assigned to `admin` user), `owner` role for the approver user, a `reader` user with only `tariff.read`, plus the two-step `tariff_revision` type registration (T4's beforeEach block, same code). Six tests:
  1. *the spine over HTTP*: POST 2 services → POST draft → PUT 2 items → POST submit `.expect(200)` (submit/activate/simulate carry `@HttpCode(200)` — actions, not creations; the assertions and the handler annotation are the SAME number by construction, §3.18) → `approveRequest` (direct call, owner actor) → POST activate by admin `.expect(200)` (drafter is a different user — create the draft via a `drafter` user's token) → GET version shows `status: "activated"` + effectiveFrom echo.
  2. *simulate over HTTP*: second draft with cons 60000, POST simulate `{ lines: [cons ×1] }` → totals deep-equal `{ current 50000, draft 60000, delta 10000, taxes 0/0/0 }` (consultation exempt — hand-derived).
  3. *permission walls*: reader POSTs a service → 403; anonymous GET → 401.
  4. *validation walls*: qty 1.5 → 400; pricePaise −1 → 400; `effectiveFrom: "not-a-date"` → 400.
  5. *state walls*: activate before approval → 409; PUT items after submit → 409.
  6. *SoD wall*: the drafting user (granted activate permission too) activates after approval → **403**, and the body message contains `sod_drafter_activator` — then admin succeeds (mechanism-separating, §3.14b: the 403 must come from the SoD check, not a missing permission, so the drafter explicitly HOLDS `tariff.versions.activate`).
- [ ] **Step 2: Run to fail** (`test -- tariff.e2e`) — routes 404. **Step 3: implement controller + module + manifest + index; wire `app.module.ts`.** **Step 4: run to pass** — 6 tests.
- [ ] **Step 5:** Full workspace `pnpm --filter @hmis/core test`; lint (`pnpm lint` — the module-isolation rule now sees `modules/tariff`); typecheck. **Step 6: Commit** — `feat(core): tariff module surface — HTTP routes, manifest, index, e2e` → pull --rebase → push.

**Acceptance criteria:** the six e2e tests pass; test 6's drafter demonstrably holds the activate permission (the grant is in the test body); `index.ts` exports exactly the block above; `app.module.ts` gained exactly three lines; no `z.coerce` and no `z.coerce.date` anywhere in the controller (gate greps); route literal order has no `:id` shadowing.

---

### Task 9: The D-17 gate script — `validate:tariff`

**Files:**
- Create: `apps/core/scripts/validate-tariff-config.ts`
- Modify: `apps/core/package.json` (+1 script line: `"validate:tariff": "tsx scripts/validate-tariff-config.ts"`)

**Interfaces:** consumes `validateTariffConfig`, `configValidated`, `withTx`, `appendEvent`, `createDb`, `requireEnv` — **importing the module ONLY via `../src/modules/tariff`** (the index; the lint rule applies to scripts too).

```ts
// scripts/validate-tariff-config.ts — D-17: run before first live invoice; go-live requires ok:true printed by THIS script.
import { createDb, withTx } from "../src/kernel/db/client";
import { appendEvent } from "../src/kernel/events/append";
import { requireEnv } from "../src/kernel/config";
import { configValidated, validateTariffConfig } from "../src/modules/tariff";

async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const report = await validateTariffConfig(db, new Date());
    for (const err of report.errors) console.log(`ERROR ${err.code}: ${err.detail}`);
    console.log(`config-validation: ok=${String(report.ok)} errors=${report.errors.length} caSigned=${String(report.caSigned)}`);
    const { eventId } = await withTx(db, (tx) =>
      appendEvent(tx, configValidated.make({
        actor: { type: "system", id: "validate-tariff-config" },
        payload: { scope: "tariff", ok: report.ok, errorCount: report.errors.length, caSigned: report.caSigned },
      })),
    );
    console.log(`config.validated emitted: ${eventId}`);
    if (!report.ok) process.exit(1);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); }); // seed-script convention: fail loud, exit non-zero
```

- [ ] **Step 1: Write the script + package.json line** (no unit test — the library is covered by context.test #6; the script is runbook-verified).
- [ ] **Step 2: Demonstrate by execution against the dev DB** — run `pnpm --filter @hmis/core validate:tariff` on the server with the exit code captured to a file (tripwires 16–18: `sh -c 'pnpm --filter @hmis/core validate:tariff > /opt/hmis/.vt.log 2>&1; echo $? > /opt/hmis/.vt.exit'`, then read both; delete both files before committing). On a dev DB without a full tariff config the expected result is a **non-empty error report, `ok=false`, `config.validated emitted: <id>`, exit 1** — the failure direction is the demonstration (a bare environment MUST fail the gate loudly). The ok:true direction is proven in T10's lifecycle test via the library.
- [ ] **Step 3:** Typecheck + lint green. **Step 4: Commit** — `feat(core): validate:tariff config gate script (D-17) — config.validated` → pull --rebase → push.

**Acceptance criteria:** the demonstrated run's captured output shows per-error lines, the summary line, the emitted event id, and captured exit code 1 (read from the file, never from a wrapper's status — tripwire 17); scratch files removed; the script imports the module only through its index; package.json gained exactly one line.

---

### Task 10: Lifecycle proof + docs

**Files:**
- Create: `apps/core/test/tariff-lifecycle.e2e.test.ts`
- Modify: `README.md` (tariff module section + go-live runbook additions)

**Interfaces:** consumes the module **only via `src/modules/tariff` (the index)** — this test IS the proof the index surface suffices for a consumer (Plan 08's compile-time reality).

- [ ] **Step 1: Failing lifecycle test** — function-level integration (merge.test.ts's shape: `setupTestDb`, no HTTP). `beforeEach`: truncate, sod pairs, users (drafter/activator/owner-approver/third-activator), owner role, `tariff_revision` type registration (T4's block), then **CONFIG_A seeded through the index surface**: 2 services (svc-cons consultation, svc-tab pharmacy), GST rows (consultation exempt/would-be 1800, pharmacy 1200), settings, caps. Four tests:
  1. *the D-17 ok:true direction*: draft v1 (cons 50000, tab 18875) → submit → approve → activate eff **2026-09-01** → `validateTariffConfig(db, 2026-09-15)` → `{ ok: true, errors: [], caSigned: false }` (the same library the T9 script runs — the two directions are now both demonstrated).
  2. *pricing under v1*: `loadPricingContext(at 2026-09-15)` → `priceInvoiceLines` on [cons ×1, tab ×1] → nets **50000** and **21141** (the Book's G01/G03 arithmetic, now through the full impure→pure chain: loader → engine).
  3. *revision with simulation*: draft v2 = `copyFromVersionId: v1` + cons → 60000 → `simulateRevision(currentCtx, draftCtx(allowDraft), lines)` → cons delta **+10000**, tab delta 0 → submit/approve/activate eff **2026-10-01** → `resolveActiveTariffVersion(2026-10-02)` = v2 → new context prices cons at 60000.
  4. *THE TARIFF-LOCK (§7)*: `loadPricingContext(at 2026-10-02, tariffVersionId: v1)` still prices cons at **50000** (an admitted patient's pinned version survives a mid-stay revision — the capability Plan 08/IPD builds on); and `resolveActiveTariffVersion(2026-09-20)` = **v1** (a backdated OPD re-print resolves the version that was active then).
- [ ] **Step 2: Run to fail; Step 3: (tests only — no implementation should be needed; any implementation change required here is a PLAN DEFECT to report, not to fix silently). Step 4: run to pass** — 4 tests.
- [ ] **Step 5: README** — add the module section: the index surface, the purity rule, the golden harness (how Plans 08/09 add fixtures), and **go-live runbook additions**: ① register `tariff_revision` approval type (two-step flow, drafter ≠ activator, approver role `owner`; the §10.4 Class-A **two-key upgrade — owner + Medical Superintendent — is a workflow-definition data change at go-live**, not code); ② `seed:tariff` then load real tariffs via the API; ③ CA sign-off (§19): review `gst_config`/`gst_settings` including **G13's post-discount threshold assumption**, then set `caSigned: true` via `PUT /tariff/gst/settings`; ④ `pnpm --filter @hmis/core validate:tariff` must print `ok=true` before the first live invoice (D-17) — the golden suite plus this report is the config-validation evidence.
- [ ] **Step 6:** Full `pnpm verify` (detached, exit code from file). **Step 7: Commit** — `test(core): tariff lifecycle e2e + module docs` → pull --rebase → push.

**Acceptance criteria:** four tests pass importing only from the module index; test 4 asserts BOTH lock directions (pinned old version + dated resolution); README carries the four runbook items; workspace fully green.

---

## Self-Review Notes

**Spec coverage:** §7 tariff/adjustments/best-single-benefit → T3+T6 (G07–G10) · §7 versioning + lock → T4, T10 test 4 · §11.11 revision workflow (draft → simulate → Class-A → effective date) → T4/T7/T8 · C-3 min-rule + hard block + regulated attributes under change control → T1 (append-only rows)/T2/T3, G05/G06 · D-3 exemption boundary (healthcare, ₹5k/day, composite, ITC data) → T3, G01/G04/G11/G13; per-line taxable/exempt output is the Rule 42/43 data · D-8 categories → contest + caps, G07–G10 · D-17 → T5 (library), T9 (script, fail direction), T10 (ok direction) · §18 golden → T6/T7; the §18 cases outside this plan's scope (split tenders, refunds, accruals, packages, payer splits) land in Plans 08/09 **in this harness** · §19 CA gate → `caSigned` + placeholder-marked seeds + G13's `caFlag` + runbook ③ · E-8 grammar → this plan's money surfaces are masters/config, handled by append-only rows; the billing-money entered-in-error lands in Plan 08 as the roadmap states.

**Out of scope, deliberately (re-read the roadmap's NOT-list before adding anything):** invoices, tenders, cashier sessions (08) · membership/coupon rules (09) · any UI · any pg-boss registration (11) · charge-posting consumers (08). The roadmap's table list named 4 tables; this plan ships 7 — the delta (tariff_items, gst_config, gst_settings) follows from the owner's resolved shape decisions (version-header+items; config-as-data) and stays inside the same module boundary.

**Verify-by-execution flags (§3.4 — each named, each owned):**
- ① bigint `mode:"number"` paise round-trip — T1 test 1.
- ② generator's full output set in the Files list (§3.16) — T1.
- ③ the 7-table single-statement TRUNCATE group (§3.12) — T1 test 3 runs it.
- ④ runbook type-registration flow — T4 beforeEach; names/args scout-verified against merge.test.ts:37-68 and kernel/workflow/definitions.ts.
- ⑤ jsonb params round-trip incl. `null` (not `undefined`) survival — T5 rules.test, named test (§3.9: owned where the code lives).
- ⑥ purity: gate greps `pricing.ts`/`gst.ts`/`contest.ts`/`simulation.ts`/`types.ts`/`money.ts` for `await`, `kernel/`, `new Date(`, `Math.random`; `golden.test.ts` imports no DB helper — T3/T6/T7 acceptance.
- ⑦ rounding-policy separations (G02 per-head-vs-split; G03 half-up-vs-banker's-vs-truncate) — hand-derived in the Book; gate re-derives.
- ⑧ activation race — T4 test 9 run five times; the loser's code traced to the single value `not_submitted` (§3.13: assert the invariant, enumerate the arbiter).
- ⑨ `__dirname` fixture loading under ts-jest CJS — apps/core/package.json has **no `"type": "module"`** (scout-verified), so ts-jest emits CJS and `__dirname` exists; additionally proven by T6 Step 2's failing-count run (the readdir must work for the run to fail the intended way).
- ⑩ safe-integer headroom: `divHalfUp` doubles n; worst plausible line (₹1 crore = 10⁹ paise × 10⁴ bps = 10¹³; ×2 = 2×10¹³ ≪ 2⁵³ ≈ 9×10¹⁵) — guarded by `assertPaise`/`divHalfUp` throws.
- ⑪ boundary semantics: resolution `effectiveFrom ≤ at` inclusive; activation strictly monotone — T4 tests 6–7, T5 context test 5.
- ⑫ `approveRequest`/`rejectRequest` argument shape — **VERIFIED against decisions.ts:16**: `{ approvalId: string; note: string }`, `note` required (an approval/rejection without a note is a type error — test code passes both fields).
- ⑬ zod v4 API forms used in `fixture-schema.ts` (`z.discriminatedUnion`, two-argument `z.record(keySchema, valueSchema)`) — compile-time verified in T6 Step 1's first run.

**Placeholder scan:** no TBDs; every test named with its assertion; the two blocks written as instructions-to-copy (T8's bootstrap/registry from patients.e2e.test.ts; CONFIG_A embedded per fixture) point at committed code/this document's tables — briefs point at the committed plan (ledger §5), not at the coder's imagination.

**Type-consistency pass:** `TariffError(code)` codes ↔ `toHttp` mapping ↔ tests use identical literals; `PricedLine`/`AdjustmentCandidate` field names identical across types.ts, the Book, fixture JSONs, and G05's verbatim exemplar; index.ts re-exports only names defined in Tasks 2–7; `ManualCaps` is `Partial<Record<…>>` so `ctx.manualCaps[cat]` is `T | undefined` under `noUncheckedIndexedAccess` — handled via the `!caps` guard.

**§2.3/§3.5 discipline:** every task leads with its failing test; fail-first evidence is owed by the ORIGINAL attempt — a retry inherits it and must never manufacture a red state against shipped code (verify-only mode, §2.2). T6's mutant check follows the §5 mutant pattern (mutant lives in the test file; no shipped file touched).

**Deviations NOT to fix (paste into every brief):** everything in gate reports 01–05 §4 (including `MODULE_REGISTRY` in tokens.ts, method-level `@Public`, argon2 under denied build scripts, the three-code race set, act-first local-state UI limitation) **plus `qr.test.ts`'s 1-in-4096 tamper-payload flake — not this plan's file; leave it.**

**What Plans 08/09 will rely on (forward contract, frozen at T8):** the index.ts block verbatim · `AdjustmentSource`/`AdjustmentCandidate`/`PricingContext` shapes · `requiresApproval` flag semantics (08 enforces via approvals before accepting a manual discount) · `roundTotalToRupee` for the §170 invoice rounding line (08) · the fixture schema + harness count bump protocol (08/09 add fixtures) · `loadPricingContext({ tariffVersionId })` as the IPD pin mechanism · `PricedLine.regulatedClamp` as the source for `ceiling.price_applied` emission at invoice time (08).

---

## Pipeline Notes (for /execute compilation — do not execute without owner approval)

- **Split:** Pipeline A = T1–T6, Pipeline B = T7–T10. **Strictly sequential within each pipeline** (every task shares module files with its neighbors); B starts only after A's gate report section is written.
- **Tier map:** sonnet coders with **opus coder overrides on T3 (engine) and T6 (golden authoring)**; **opus gate on every task**.
- **Cost calibration (backend, NOT Plan 05's UI-inflated numbers — gate report §7.8):** Plan 04's backend actual ≈ 160k tokens/task including gate (1.279M / 8, within 2% of its estimate). Ten tasks, two on opus: **estimate ≈ 1.5–1.7M subagent tokens total** (A ≈ 950k–1.05M, B ≈ 550–650k), ~2.5–3.5h wall clock.
- **Frozen paths while the pipelines run:** `apps/web/**`, `packages/contracts/**`, `apps/core/src/modules/patients/**`, `.github/workflows/**` (tripwire 10), all of `apps/core/src/kernel/**` EXCEPT `kernel/db/schema/tariff.ts` + `schema/index.ts` (T1 only); `test/helpers/db.ts` T1 only; `app.module.ts` T8 only; `apps/core/package.json` T5 and T9 only; `drizzle/**` T1 only.
- **Migration rule:** exactly one migration (T1). Any later schema need = chain halt + plan-defect report.
- **Compile rules (from EXECUTION-LESSONS):** §1 tripwires verbatim at the TOP of every brief · briefs point at the committed plan on the server, never restate code · baseline = "previous task's commit" (§2.6) · per-suite test counts only, narrowing regexes checked against the task's own later files (§2.5) · FINISH block = three numbered steps (§3.8) · gate verdicts carry `retry_mode` (§2.2) · no correction may direct history rewrites (tripwire 15/§2.4) or security-code removal (tripwire 14) · deviations-not-to-fix list in every brief.
- **Events note:** `config.validated` and `tariff.revision_applied` have no subscribers yet and the dispatcher is unscheduled until Plan 11 — nothing in this plan wires consumers, correctly.



