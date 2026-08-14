# Plan 06.2 — Tariff Hardening II · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**STATUS: WRITTEN 2026-08-15 — awaiting owner approval of the plan. The §"Owner decision required" A1 ruling is MADE: Option B (database-side `seq` column), owner in-conversation 2026-08-15. T1 stands as written; do not compile a pipeline before plan approval.**

**Goal:** Close the 2 CRITICAL and 4 MODERATE findings — and the cheap MINORs — of the 2026-08-15 post-ship audit of Plan 06.1 (`reports/plan-06-1-audit-findings.md`), before Plan 07 mints ids for encounters/appointments/queues and before Plan 08 bills against this surface. The two criticals: (A1) `newId()` is non-monotonic `ulid()`, so every shipped "last-inserted-wins" ordering is a coin flip within a millisecond — 6 of 200 same-date gazette corrections billed the superseded DPCO ceiling; (A2) the activation race test cannot distinguish a working serializer from none — migration 0008's index enforces everything the test observes.

**Architecture:** No new module, no moved contract, no new event names. One migration (0009) adds a database-side monotone `seq` (bigserial) to the two tables whose ordering is load-bearing; three orderings move from id to seq; the activation serializer gets a controlled-contention suite that observes the LOCK, not the invariant the index enforces anyway; the rejected-approval belt moves below the guards that authorize it; and every remaining audit finding is either fixed with an *executed-mutant-certified* test or deferred with its reason written down.

**Tech Stack:** Existing only — TypeScript strict, NestJS ^11, drizzle-orm ^0.40 / drizzle-kit ^0.30, zod ^4, pg ^8, Jest + ts-jest. **Zero new dependencies, zero env vars, zero CI changes.**

**Input evidence:** `reports/plan-06-1-audit-findings.md` (two independent read-only opus auditors + one scout, ~493k tokens, against `cab41c3`). Its §6 SOUND list is **not re-litigated here**; its §7 could-not-check items are addressed only where a task naturally reaches them (the A2 contention harness is §7's first item).

---

## The rule this plan exists to enforce: an UNEXECUTED discrimination claim is a prediction

Plan 06.1's organizing rule was "two audits per assertion" — derivation AND discrimination. The audit proved the discrimination audit was itself unexecuted: A6's declared-unreliable kill runs 10/10, A7's declared-load-bearing kill runs 0/10, and the cap-comparison revert survives the entire suite. Hand-walked kills were wrong **four times, in both directions** (findings m11, ledger §3.24).

Binding rule for this plan, written into every task's acceptance criteria, per **tripwire 21**:

1. **Derivation audit** (unchanged): every expected value is hand-computed in this document, never produced by running the engine.
2. **Discrimination audit, EXECUTED:** every assertion's named mutant is **built by the task that ships the assertion** — as a separate scratch file beside the source, never by editing shipped files — run, and reported **DIED or SURVIVED** with the run count. The Assertion Book below records predictions; the *executed verdict column is filled at execution time* and measurement beats this document. Where the shipped pre-fix code IS the mutant (a genuine fail-first red), the observed red run is the executed mutant evidence and no second build is owed. Where a kill is genuinely unobtainable (one case, K3), this document says so and names the load-bearing structural defense instead — an honest SURVIVED is acceptable; an unexecuted DIED is not.
3. **Tripwire 20 (test-evidence interference):** no scout, audit, or second pipeline may run this repo's tests concurrently with a pipeline task. The pipeline is sequential and safe by construction; every brief carries tripwires 1–21 verbatim, including 20.

---

## Owner decision required — the A1 id-ordering fix (blocks compilation, not approval of the rest)

`newId()` (packages/contracts/src/ids.ts) is `ulid()`: a 48-bit millisecond timestamp plus 80 bits of fresh randomness. Two ids minted in the same millisecond sort by coin flip. **Blast radius, scout-measured at `acd42d2`:** `newId()` is minted at **25 production call sites across every module** (auth, workflow, approvals, patients, tariff — full list in the scout record), but **only three shipped orderings depend on ids being insertion-ordered, all in the tariff module**: `services.ts:110` (`resolveRegulatedPrices` — the DPCO ceiling), `services.ts:130` (`listRegulatedPrices` — the gazette audit trail), `rules.ts:128` (`loadRuleConfig` — duplicate-cap last-write-wins). Every other ordering in `apps/core`, `apps/web` and `packages/` sorts by a timestamp, an integer version, or a business key; the activation serializer's `ORDER BY id … FOR UPDATE` needs only a *consistent* total order and is safe as-is (scout-verified verdict table).

**Option A — `monotonicFactory()` in `packages/contracts/src/ids.ts`.** One line. Monotonic **per process** only.
- *Cost:* trivial today.
- *Why not recommended:* Plan 11 splits the API into api / ws-hub / worker processes. A bulk gazette import in the worker racing an admin POST in the api mints same-millisecond ids in two processes — the A1 defect returns exactly where it matters (bulk paths), after we declared it fixed. Worse, per-process monotonicity makes any FUTURE wrong ordering-by-id **untestable in-process** (always passes locally) while still broken cross-process: it hides the defect class instead of closing it. And it changes id-generation semantics for all 25 call sites to fix 3.

**Option B — database-side monotone `seq` column (RECOMMENDED).** Migration 0009 adds `seq: bigserial` to `regulated_prices` and `adjustment_rules` (the `events.seq` precedent — `bigserial("seq", { mode: "number" })`, the only bigserial in the schema today); the three orderings move to `seq`; `newId()` stays `ulid()` and gains a WARNING doc comment forbidding `ORDER BY id` for recency.
- *Cost:* one generated migration, two schema lines, three ordering edits, and a per-table discipline: any future table whose insertion order is load-bearing gets its own `seq`.
- *Why recommended:* the database allocates `seq` at insert time, so it survives any process topology — Plan 11 included. It is the shape the audit, the ledger (§3.26) and the roadmap entry all point at. Within one transaction (the bulk-import case that breaks Option A's future) allocation order is exactly insertion order.
- *Honest caveat, stated not hidden:* bigserial allocation is not commit-ordered — two *concurrent transactions* appending a correction for the SAME service and date could commit in reverse seq order. That race is ill-defined under the shipped id ordering too (worse: random), and gazette corrections are a change-controlled sequential path; declared as out of scope, same as today.

**This plan is written for Option B.** If the owner rules for Option A, T1 as written is void and must be re-authored before any pipeline is compiled (no conditional instructions per ledger §3.3 — the ruling gates compilation). T2–T6 are unaffected by the choice, **except** T1's K2 history-teeth work rides in T1.

**Two smaller rulings, flagged (defaults apply on plain approval):**
- **m1 zero-gross policy:** a positive manual ask on a ₹0 line records `over_cap` (any positive ask exceeds every cap of a zero-gross line, and `over_cap` keeps the ASKED amount in the D-8 record; the pre-06.1 path recorded an accepted 0 and lost the ask). No money moves either way. T4 pins this and fixes the false "provably identical" comment.
- **`packages/contracts/src/ids.ts` gains a doc comment** (Option B) — the first `packages/contracts` touch since Plan 05; comment-only, contracts suite stays 3 suites / 7 tests, no dependency change.

---

## Findings disposition map

| Finding | Severity | Disposition |
|---|---|---|
| **A1** non-monotonic id tie-breaks | CRITICAL | **T1** — seq column (Option B), orderings moved, bulk-corrigenda red-first test, ids.ts warning |
| **A2** race test can't see the serializer | CRITICAL | **T2** — controlled-contention suite: block-observation test (kills serializer deletion) + forced-interleave same-version race (kills m8's `ne()` deletion) |
| **B1** belt UPDATE precedes its guards | MODERATE | **T3** — belt moved below subject + SoD guards; both rejecting-path tests red-first |
| **B2** A7 history ordering kills nothing | MODERATE | **T1** — history test upgraded: heap agitation + seq expectation; mutant EXECUTED with floor, verdict recorded either way (structural defense named) |
| **B3** e2e route scope untested | MODERATE | **T6** — second service in the e2e gazette block; scope asserted both directions; controller-unit mutant executed |
| **B4** cap-comparison revert survives | MODERATE | **T4** — `maxBps: 10000` over-gross test, the one value where old and new differ; operand-revert mutant executed |
| m1 zero-gross `over_cap` + false comment | MINOR | **T4** — comment corrected; policy pinned by test (owner default above) |
| m2 migration 0008 install robustness | MINOR | **DEFERRED** — pre-go-live: no database outside stress-test scratch state can hold two same-instant activated rows; migrations run on fresh or clean databases today. Revisit in the go-live runbook plan. |
| m3 bare catch misattributes load failures | MINOR | **T5** — catch narrowed: ZodError keeps the shipped Break-4 behaviour; anything else → `rule_config_load_failed`, caps loop skipped |
| m4 raw 23505 → HTTP 500 on the new index | MINOR | **DEFERRED** — unreachable while the serializer stands (T2 now proves it stands and detects its removal). Typing 23505 inside `activateVersion` would *destroy* A2's unit-level discriminator; typing it in `toHttp` is cosmetic polish on an unreachable path. Note: two OTHER raw 23505s are documented-as-expected. Revisit with Plan 08's error-surface work if it touches `toHttp`. |
| m5 `=== null` passes undefined/undefined | MINOR | **T4** — `== null` on the both-bounds guard; red-first test with a cast-built ctx |
| m6 duplicate-cap filters deletable | MINOR | **T5** — retired/expired/future second-cap test; three filter-deletion mutants executed |
| m7 subjectType half deletable | MINOR | **T3** — wrong-subjectType approval test; deletion mutant executed |
| m8 `ne(id, versionId)` deletable | MINOR | **T2** — the forced interleave reaches the in-tx re-check deterministically; deletion mutant executed |
| m9 dead `Math.min` on accepted path | MINOR | **DEFERRED (no-op)** — it is a belt behind the raw-operand cap check, unreachable for every legal cap by construction. Deleting defensive code is not hardening; testing dead code is decoration. Documented here, nothing shipped. |
| m10 manifest vacuous-content / .JSON hole | MINOR | **T6** — raw-directory-listing test + non-vacuous-fixture test; scratch-dir mutants executed |
| m11 Assertion Book kills wrong both ways | MINOR | **PROCESS** — discharged by tripwire 21, which this plan's criteria operationalize (executed verdict column, filled at run time) |
| Audit §7 (A2 kill-rate needs contention harness) | — | **T2** builds exactly that harness |
| Audit §8 / ledger §2.10 (parallel test corruption) | — | **PROCESS** — now tripwire 20, in every brief |
| Scout observation: workflow transitions ordered by `at` with no tie-break (`workflow.controller.ts:142`) | — | **CARRIED FORWARD** — out of this plan's scope (do not expand); belongs to the next plan that owns workflow read surfaces |

---

## Consumed shipped surfaces (scout-verified against `/opt/hmis` at `acd42d2`, this session — five read-only scouts + one measurement scout)

| Surface | Fact | Where |
|---|---|---|
| `newId()` | `return ulid();` — plain, non-monotonic; `newEventId()` identical | `packages/contracts/src/ids.ts` (10 lines) |
| Ordering blast radius | 25 production `newId()` call sites; **exactly 3 insertion-order-dependent orderings**, all tariff (`services.ts:110`, `:130`, `rules.ts:128`); serializer's `order by id for update` needs only consistency (safe); `listVersions` orders by `versionNo`; dispatcher by `events.seq`; worklist by `requestedAt` | scout verdict table |
| `bigserial` precedent | `seq: bigserial("seq", { mode: "number" }).primaryKey()` on `events`; **no other schema file imports bigserial** | `kernel/db/schema/events.ts:1,6` |
| `regulated_prices` schema | id text PK, serviceId FK→services, mrp/ceiling bigint nullable, effectiveFrom notNull, gazetteRef, createdBy, createdAt; index `(service_id, effective_from)` | `kernel/db/schema/tariff.ts:75-88` |
| `adjustment_rules` schema | id text PK, ruleKey (unique ux), sourceKey, params jsonb, serviceCategory/serviceId nullable, validFrom/validTo nullable, active bool default true, audit cols | `kernel/db/schema/tariff.ts:90-109` |
| Migration journal | last entry idx **8** (`0008_loving_gunslinger`) → the generator's next output is **0009** | `drizzle/meta/_journal.json` |
| `resolveRegulatedPrices` | `.where(lte(effectiveFrom, at)).orderBy(desc(effectiveFrom), desc(id))`, first-row-per-service reduction; docstring claims "ULIDs … last-inserted-wins" (the false claim) | `services.ts:98-118` |
| `listRegulatedPrices` | same order-by pair; feeds `GET /tariff/services/:id/regulated-prices` | `services.ts:120-131`, controller |
| `appendRegulatedPrice` | takes `Tx`; requires ≥1 bound (`regulated_bounds_missing`); asserts paise per bound; single insert with `newId()` | `services.ts:66-96` |
| `loadRuleConfig` | `.where(eq(active, true)).orderBy(asc(id))`; window filters `validFrom > at`/`validTo < at` continue; manual rows assign caps last-write-wins; `.parse()` throws on corrupt params BY DESIGN | `rules.ts:120-152` |
| `activateVersion` guard order (shipped) | unknown_version → not_submitted → `!approval \|\| status === "pending"` → approval_not_granted → **rejected belt UPDATE + throw** (:165-173) → subject guard (:179) → SoD (:187) → tx | `versions.ts:148-192` |
| Rejected belt | conditional UPDATE `set status='rejected' where id=:v and status='submitted'` — the write B1 is about | `versions.ts:168-171` |
| In-tx sequence | ordered set lock (`status in ('submitted','activated') order by id for update`) → monotonicity re-check with `ne(id, versionId)` and `effectiveFrom !== null && >= ` refusal → single-winner conditional UPDATE → event | `versions.ts:194-247` |
| Shipped rejected-path test | "activate while pending → approval_not_granted; after reject → approval_rejected, version marked rejected" — pins the LEGITIMATE belt path (correct subject, non-SoD actor) | `versions.test.ts:122-138` |
| versions.test scaffolding | `it(…)` dialect; `drafter`/`activator`/`owner` actors, `s1`/`s2` services, `mkDraft(prices)`, `rejectRequest` already imported; `requestApproval` NOT yet imported | `versions.test.ts:1-89` |
| `setupTestDb` | returns `{ db, pool, teardown }` — **the pool is exported**, so a contention harness takes dedicated clients via `pool.connect()`; per-worker DB `<base>_<JEST_WORKER_ID>` | `test/helpers/db.ts:31-49` |
| `truncateAll` | 8 statements; tariff group is one self-contained statement — **no new table in this plan ⇒ no db.ts change** (a needed one is a plan defect to report, §3.12) | `test/helpers/db.ts:51-72` |
| `manualDiscountSource.propose` | signature `(ctx, line, grossPaise)`; `assertPaise(md.value)`; `raw` vs `amount = Math.min(raw, gross)`; cap check `raw * 10000 > caps.maxBps * grossPaise`; rejected records `raw`; detail `` `${raw}p exceeds ${caps.maxBps}bps of ${grossPaise}p` ``; comment claims "provably identical for every maxBps < 10000" (false at gross 0 — m1) | `contest.ts:25-54` |
| Both-bounds guard | `if (rp.mrpPaise === null && rp.ceilingPaise === null) throw regulated_price_missing`; bounds pushes use `!== null`; running-min `b.value < unitPaise` | `pricing.ts:30-41` |
| `validateTariffConfig` | never-throws; engineCaps from `loadRuleConfig` wrapped in a **bare `catch {}`** (:153-159 — m3); duplicate-cap loop filters `!row.active` / `validFrom > at` / `validTo < at` (:171-173 — m6); smoke block already types non-Tariff failures as `context_load_failed` (:213-218 — the convention m3's fix mirrors); **no zod import today** | `context.ts:87-222` |
| `context.test` helpers | `seedFullValidConfig()` seeds 2 services (one regulated), both GST categories, settings, R-EMP10, all four caps, activates at 2026-02-01; `drafter` actor in scope | `context.test.ts` |
| contest/pricing test helpers | `makeCtx(overrides)`, `CAPS` (negotiated_corporate `{maxBps: 2000, approvalAboveBps: 1500}`), `CONS_LINE`, `thrownCode()`; `ManualCaps` type imported in both files | `contest.test.ts`, `pricing.test.ts` tops |
| Golden harness | `files = readdirSync(dir).filter(f => f.endsWith(".json")).sort()` (**the m10 case-sensitivity hole**); manifest test = 14-name literal; per-fixture loop deep-equals `expected[i].line`; fixture kinds price / price_error / simulate all carry `lines` | `golden.test.ts:10-53` |
| e2e gazette block | one service (`DRUG-1`) with two same-date rows r1/r2; history asserted `[r2.id, r1.id]` by captured ids — **single-service fixture = the B3 hole**; `auth()`, `adminToken`, `readerToken` in scope | `test/tariff.e2e.test.ts:398-430` |
| Controller | `constructor(@Inject(DB) private readonly db: Db)`; `listRegulatedPricesRoute(@Param("id") id)` → `{ items: await listRegulatedPrices(this.db, id) }` — a controller-unit mutant is directly instantiable | `tariff.controller.ts` |
| Jest config | `testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"]`, testTimeout 15000 — scratch mutant SPECS are collected if named `*.test.ts`, so they run isolated by path and are **deleted before any workspace count and before commit** | `apps/core/jest.config.cjs` |
| Measured baseline (2026-08-15, measurement beats this document) | `apps/core` **68 suites / 383 tests**; per-suite: versions 12 · services 8 · rules 9 · contest 14 · pricing 10 · context 8 · gst 8 · gst-config 5 · golden 16 · schema/tariff 4 · tariff.e2e 8 · tariff-lifecycle.e2e 4; `packages/contracts` 3/7; `apps/web` 11 files/37 | measurement scout, commit `acd42d2` |

---

## Global Constraints

- Money is integer **PAISE**; no floats, **no `z.coerce` anywhere** (§3.19).
- `money.ts`, `types.ts`, `contest.ts`, `gst.ts`, `pricing.ts`, `simulation.ts` stay **PURE and SYNCHRONOUS**; purity greps must stay green (T4 touches two of these files).
- **Exactly ONE migration** — `0009_*`, generated in T1 by `pnpm --filter @hmis/core db:generate`, never hand-edited. A schema need discovered later is a plan defect to report (§3.12). No CHECK constraints (zero precedent).
- **`modules/tariff/index.ts` BYTE-FROZEN.** No export added or removed anywhere in the module's public surface. (`RegulatedPriceRow` and `AdjustmentRuleRow` gain a `seq` field via `$inferSelect` — a type-level widening with no export change; the HTTP list responses gain the field additively.)
- `packages/contracts` untouched EXCEPT `src/ids.ts`, comment-only, T1 (flagged above). `apps/web` byte-untouched. `modules/patients` read-only; **`qr.test.ts` untouched** (still owned by a future task on that file).
- Also untouched this plan: `app.module.ts`, both `package.json`s, `pnpm-lock.yaml` (no dependency change — tripwire 12 has nothing to carry), `README.md`, **`test/helpers/db.ts`** (no new table), `simulation.ts`(+test), `tariff-lifecycle.e2e.test.ts`, `scripts/*`, `manifest.ts`, `tariff.module.ts`, `tariff.controller.ts`, `events.ts`, `money.ts`(+test), `gst.ts`, `gst.test.ts`, `gst-config.ts`, `gst-config.test.ts`, `fixture-schema.ts`, all 14 golden fixture JSONs (only `golden.test.ts` changes), `.github/workflows/**` (tripwire 10), `kernel/**` except `kernel/db/schema/tariff.ts` (T1 only), `drizzle/**` (T1 only).
- Events: catalog unchanged (`tariff.revision_applied`, `config.validated`). `rule_config_load_failed` is a `ConfigError` **string** in an open set — no union edit, no event.
- **Scratch mutants:** built beside the source as `*.mutant.ts` (implementation copies) + `*.mutant.test.ts` (specs), run isolated by explicit path (`pnpm --filter @hmis/core exec jest --passWithNoTests <path>`), verdicts recorded, then **deleted BEFORE any workspace-count verification and BEFORE commit** (tripwire 4; jest's testMatch would otherwise collect the spec). `git status` clean before every commit.
- Baseline for every task: **the previous task's commit, i.e. current `origin/main`** (§2.6 — never a fixed SHA).
- Do not re-litigate any §4/§5 item of gate reports 01–06.1 (incl. the `code: message` HTTP prefix and the open `ConfigError`/`TariffErrorCode` sets).

---

## File structure (all under `apps/core/` unless noted)

```
packages/contracts/src/ids.ts                    T1  doc comment only: newId() is NOT insertion-ordered
src/kernel/db/schema/tariff.ts                   T1  +bigserial import; +seq on regulated_prices, adjustment_rules
drizzle/0009_<generated>.sql                     T1  generated — the plan's ONLY migration
drizzle/meta/0009_snapshot.json                  T1  generated (§3.16 full output set)
drizzle/meta/_journal.json                       T1  rewritten by the generator (new last idx 9)
src/modules/tariff/services.ts                   T1  both orderings → (effectiveFrom DESC, seq DESC); comments corrected
src/modules/tariff/rules.ts                      T1  loadRuleConfig ordering → asc(seq); comment corrected
src/modules/tariff/services.test.ts              T1  +1 bulk-corrigenda test; history test upgraded in place (agitation + seq)
src/modules/tariff/versions.contention.test.ts   T2  NEW suite (suites 68 → 69): lock-observation + forced same-version race
src/modules/tariff/versions.ts                   T3  guard reorder: subject → SoD → rejected belt; doc comment updated
src/modules/tariff/versions.test.ts              T3  +3 (mis-bound rejected; drafter-on-rejected; wrong subjectType)
src/modules/tariff/contest.ts                    T4  m1 comment corrected (behaviour unchanged)
src/modules/tariff/contest.test.ts               T4  +2 (B4 cap-10000; m1 zero-gross pin)
src/modules/tariff/pricing.ts                    T4  both-bounds guard === null → == null
src/modules/tariff/pricing.test.ts               T4  +1 (undefined-bounds refusal)
src/modules/tariff/context.ts                    T5  m3 catch narrowed (+ zod import); rule_config_load_failed
src/modules/tariff/context.test.ts               T5  +2 (load-failure attribution; retired/expired/future non-duplicates)
test/tariff.e2e.test.ts                          T6  gazette block extended: second service, scope asserted both ways
src/modules/tariff/golden.test.ts                T6  +2 (raw-listing = manifest; no vacuous fixture)
```

---

## Tasks

Six tasks, **ONE pipeline, strictly sequential** (roadmap rule: ≤ 6 per Workflow). Order: criticals first (T1, T2), then the guard reorder (T3 — edits `versions.ts`, which T2's suite exercises; T3's criteria re-run the contention suite), then the engine/gate/coverage tasks (T4, T5, T6 — disjoint files).

---

### Task 1: The ordering tells the truth — `seq` columns, migration 0009, bulk-corrigenda proof  *(opus coder)*

**The defect (A1, CRITICAL, reproduced 6/200):** all three "last-inserted-wins" orderings rest on `desc/asc(id)` with docstrings claiming "ULIDs = creation order." `newId()` is `ulid()` — same-millisecond ids sort by randomness. End-to-end through the shipped write path, 6 of 200 same-date corrigenda resolved to the SUPERSEDED ceiling; the list route confirms the same wrong row to the admin who checks. Safe today only because one-HTTP-request-per-row outlasts a millisecond; any bulk import (NPPA gazette loop, data fix, Plan 08 seeding) breaks it.

**Files:**
- Modify: `apps/core/src/kernel/db/schema/tariff.ts` (+`bigserial` to the pg-core import; +1 column on each of two tables)
- Create (generated): `apps/core/drizzle/0009_<generated>.sql`, `apps/core/drizzle/meta/0009_snapshot.json`
- Modify (generated): `apps/core/drizzle/meta/_journal.json` (new last idx 9)
- Modify: `apps/core/src/modules/tariff/services.ts` (two orderBy lines + two doc comments)
- Modify: `apps/core/src/modules/tariff/rules.ts` (one orderBy line + doc comment)
- Modify: `apps/core/src/modules/tariff/services.test.ts` (+1 test; 1 test upgraded in place)
- Modify: `packages/contracts/src/ids.ts` (doc comment only)

**Interfaces:** no signature changes. `RegulatedPriceRow`/`AdjustmentRuleRow` widen by `seq: number` via `$inferSelect` (additive; HTTP list payloads gain the field). `index.ts` byte-frozen.

- [ ] **Step 1: Write the failing bulk-corrigenda test** — append to `services.test.ts` (uses `test(…)`; `actor`, `withTx`, `db`, `createService`, `appendRegulatedPrice`, `resolveRegulatedPrices`, `listRegulatedPrices` are in scope per the shipped 06.1-T3 additions; if any identifier differs in the file, follow the file and disclose — measurement beats document):

```ts
test("bulk same-date corrigenda: the correction wins for EVERY service, even when minted in the same millisecond", async () => {
  // The A1 reproduction as a test: gazette row then same-date corrigendum, back to back inside
  // ONE transaction — the bulk-import shape (audit A1: 6/200 resolved to the superseded row).
  const N = 60;
  const gazetteDate = new Date("2026-06-01T00:00:00Z");
  const serviceIds = await withTx(db, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const { serviceId } = await createService(tx, actor, {
        code: `BULK-${i}`, name: `Bulk drug ${i}`, category: "pharmacy", regulated: true,
      });
      ids.push(serviceId);
    }
    for (const serviceId of ids) {
      await appendRegulatedPrice(tx, actor, { serviceId, ceilingPaise: 99900, effectiveFrom: gazetteDate, gazetteRef: "GZ-BULK" });
      await appendRegulatedPrice(tx, actor, { serviceId, ceilingPaise: 45000, effectiveFrom: gazetteDate, gazetteRef: "GZ-BULK-corr" });
    }
    return ids;
  });

  const map = await resolveRegulatedPrices(db, new Date("2026-07-01T00:00:00Z"));
  for (const serviceId of serviceIds) {
    expect(map[serviceId]).toEqual({ mrpPaise: null, ceilingPaise: 45000 });
  }
  // Structural pin: inside one transaction, seq allocation order IS insertion order.
  const history = await listRegulatedPrices(db, serviceIds[0]!);
  expect(history).toHaveLength(2);
  expect(history[0]!.ceilingPaise).toBe(45000);
  expect(history[0]!.seq).toBeGreaterThan(history[1]!.seq);
});
```

  Note the `seq` assertions do not compile against shipped code — **Step 2 runs the test with those two final `history` assertions commented out**, restoring them in Step 5 (§3.23: the fail-first variant must compile and run against unmodified shipped code on its own; the defect it demonstrates is the resolver's, not the type's).
- [ ] **Step 2: Run it to fail (§3.22 — a floor, not a promise).** Deploy the Step-1 test with the two seq lines commented; run isolated (`pnpm --filter @hmis/core exec jest --passWithNoTests services.test -t "bulk same-date"`, isolation confirmed from the OUTPUT per tripwire 19) **at least 5 times; report the observed red rate**. Derivation of expectation: the audit measured ~7% same-millisecond per back-to-back pair and half of those invert → ~3.5% per pair; with 60 pairs, P(≥1 wrong per run) ≈ 1−0.965⁶⁰ ≈ 88%, so ~1 in 5 runs may still pass — keep running (up to 20) rather than declare the red unobtainable. Quote at least one failing run (expected shape: some `map[serviceId]` equals `{ mrpPaise: null, ceilingPaise: 99900 }`). These rates are host-dependent possibilities, not forecasts (§3.20/§3.22); the fix is owed regardless of the observed rate, because the defect is the nondeterminism itself. **The observed red IS the executed mutant for K1** — the shipped id-ordering is the wrong implementation, run for real.
- [ ] **Step 3: Schema + migration.** In `kernel/db/schema/tariff.ts`: add `bigserial` to the pg-core import list, then add to BOTH `regulatedPrices` and `adjustmentRules`, directly under `id`:

```ts
    // Same-date/last-write-wins resolution orders by INSERTION, and ULID ids cannot carry that
    // order (same-millisecond ids sort by randomness — audit A1, ledger §3.26). The database
    // allocates this monotone sequence instead (events.seq precedent); it survives the Plan 11
    // process split, which per-process monotonicFactory() would not.
    seq: bigserial("seq", { mode: "number" }),
```

  Generate: `pnpm --filter @hmis/core db:generate`. Commit ALL generator outputs (§3.16). **Read the generated SQL** and confirm both `ALTER TABLE … ADD COLUMN "seq" bigserial NOT NULL;` statements (Postgres creates the sequence and backfills existing rows in arbitrary order — harmless: per-worker test DBs truncate, and no pre-existing production data exists). Never hand-edit it. Verify-by-execution flag ①: drizzle-kit ^0.30 emitting ADD COLUMN for bigserial is asserted from its serial handling, not from a shipped precedent — reading the generated SQL is the check.
- [ ] **Step 4: Move the three orderings.** In `services.ts`: both `orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.id))` become `orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.seq))`; rewrite both doc comments to drop the "ids are ULIDs, so descending id = last-inserted-wins" claim and state: same-date rows resolve by `seq` — the database-side insertion order (audit A1; ids are NOT insertion-ordered). In `rules.ts`: `orderBy(asc(adjustmentRules.id))` → `orderBy(asc(adjustmentRules.seq))`; rewrite the "(ULIDs = creation order)" clause the same way. In `packages/contracts/src/ids.ts`, extend `newId()`'s doc comment:

```ts
/** Entity ids (users, sessions, grants, …) share the event-id grammar: one ULID everywhere.
 * WARNING (audit A1, ledger §3.26): ulid() is NOT monotonic — two ids minted in the same
 * millisecond sort by 80 bits of randomness, never by insertion order. NEVER use `ORDER BY id`
 * where recency or insertion order matters; give the table a database-side monotone column
 * instead (bigserial `seq` — the events.seq / regulated_prices.seq precedent). */
```

- [ ] **Step 5: Restore the two seq assertions** in the Step-1 test; upgrade the shipped history test in place — `"listRegulatedPrices: one service's full history, newest first, same-date correction before its original"` gains heap agitation between the r3 insert and the query (add `import { eq } from "drizzle-orm";`-style imports only if not already present in the file, plus `import { regulatedPrices } from "../../kernel/db/schema";`):

```ts
  // Heap agitation (audit B2): an UPDATE relocates r2's live tuple to the end of the heap, so
  // physical order ≠ insertion order and "fresh-table heap luck" cannot save an implementation
  // that dropped the tie-break.
  await db.update(regulatedPrices).set({ gazetteRef: "agitated" }).where(eq(regulatedPrices.id, r2.id));
```

  The `[r3.id, r2.id, r1.id]` expectation is unchanged.
- [ ] **Step 6: Build and execute the K2 mutant (tripwire 21 — this is the row the audit falsified by hand).** Create `services.mutant.ts` beside the source: a copy of `listRegulatedPrices` (and its imports) with the `desc(regulatedPrices.seq)` tie-break DELETED. Create `services.mutant.test.ts`: replicate the upgraded history test's seeding (three rows + agitation) but call the mutant; assert the same `[r3, r2, r1]` id order. Run it isolated **10 times**; record **DIED or SURVIVED with the observed count** (e.g. "DIED 7/10"). **Do NOT predict the verdict in the report — measure it.** Either verdict is acceptable: the audit proved this mutant's behaviour is decided by Postgres sort internals, which is exactly why the load-bearing defense is structural (`seq` is monotone by allocation) and the resolver's kill is K1's executed red. Delete both scratch files; confirm `git status` shows only this task's Files list.
- [ ] **Step 7: Run to pass.** `exec jest --passWithNoTests services.test` → 1 suite, **9 tests**, 5/5 isolated runs of the bulk test green (post-fix it is deterministic). `exec jest --passWithNoTests rules.test` → 9 (unchanged — the duplicate-caps newest-wins test now rides `seq`; its same-millisecond margin is K3, declared untestable: the audit measured 0/200 same-ms collisions for sequential upserts, so no behavioural red exists to demand — the defense is the bigserial itself plus A17's `duplicate_manual_cap` gate error). Workspace `pnpm --filter @hmis/core test` → 68 suites / **384 tests**. `packages/contracts` suite → 3/7 (comment-only change). Detached root `pnpm verify`, exit read from a file (tripwires 16–18).
- [ ] **Step 8: Commit** — `fix(core): regulated-price and rule ordering ride a database-side seq — ids are not insertion-ordered` → `git pull --rebase origin main` → `git push origin main`. (Three numbered steps — §3.8.)

**Acceptance criteria:**
1. The bulk-corrigenda test exists, its pre-fix red was observed and quoted with the observed rate over ≥5 isolated runs (or the report states the full run count honestly if the window never opened — the fix ships regardless), and post-fix it passes 5/5 isolated, deterministically.
2. Migration `0009_*.sql` + snapshot + journal are committed, generated not hand-edited, and the SQL carries BOTH `ADD COLUMN "seq" bigserial` statements; exactly one migration in the whole plan.
3. All three orderings reference `seq`; no `orderBy` in `services.ts`/`rules.ts` references `id` any more; the false "ULIDs = creation order" claims are gone from both files; `ids.ts` carries the WARNING comment.
4. The K2 mutant was BUILT and RUN 10×; the report states DIED/SURVIVED with the count; scratch files are deleted (workspace count taken after deletion).
5. Workspace 68 / 384; contracts 3/7; verify green; no file outside the Files list changed; `test/helpers/db.ts` untouched.

---

### Task 2: A test that can see the serializer — controlled contention  *(opus coder)*

**The defect (A2, CRITICAL test gap):** the cross-version race test asserts one winner, one activated row, one event, typed loser — and migration 0008's partial unique index enforces every one of those with the serializer reverted OR deleted (both mutants pass 10/10 isolated). Three layers of verification measured something that cannot tell the implementations apart (§3.25: the backstop was tested twice, the mechanism never). Riding along: **m8** — deleting `ne(tariffVersions.id, versionId)` from the monotonicity re-check also survives, because the natural race's loser dies at the PRE-tx status check before ever reaching the re-check; only a forced interleave gets it there.

**Why a contention harness and not a dropped-index run:** the alternative (assert the typed code with the index dropped in a rolled-back transaction) cannot work for a cross-session race — transactional DDL holds an ACCESS EXCLUSIVE lock that blocks the second session, and dropping the index for real mutates shared schema that a mid-test crash would leave broken. Observing the BLOCK is observing the mechanism itself: with the ordered set lock held by an external session, `activateVersion` must wait; with the serializer deleted, it must not. That discriminates deterministically, with no schema mutation and no probability window. (This also discharges audit §7's first could-not-check item.)

**Files:**
- Create: `apps/core/src/modules/tariff/versions.contention.test.ts` — **a new jest suite: `apps/core` goes 68 → 69 suites**

**Interfaces:** none. No shipped file changes in this task.

- [ ] **Step 1: Author the suite.** Scaffolding mirrors `versions.test.ts:25-89` byte-for-byte where applicable (same imports plus `import { requestApproval } from "../../kernel/approvals/requests";` is NOT needed here; same beforeAll/beforeEach seeding: users, owner role, two-step type registration, two services, `mkDraft`), with `pool` captured from `setupTestDb` (`({ db, pool, teardown } = await setupTestDb())`) and helpers:

```ts
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SET_LOCK_SQL = "select id from tariff_versions where status in ('submitted', 'activated') order by id for update";
```

  Test 1 — the mechanism, observed:

```ts
  it("the ordered set lock is REAL: an activation BLOCKS while another session holds it, and completes after release", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(SET_LOCK_SQL); // the exact statement the serializer issues
      const p = activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
      p.catch(() => {}); // no unhandled rejection while unobserved
      // Audit A2's exact gap: the old race test could not see whether this lock exists. A
      // serializer-less activateVersion sails past a held lock and settles immediately; the
      // shipped one MUST still be waiting after 400 ms.
      const state = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);
      expect(state).toBe("pending");
      await holder.query("commit");
      const result = await p;
      expect(result.versionNo).toBe(1);
    } finally {
      holder.release();
    }
    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows).toHaveLength(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows).toHaveLength(1);
  });
```

  Test 2 — the forced same-version race (m8's discriminator):

```ts
  it("forced same-version contention: both racers pass the pre-checks, the loser reaches the IN-TX arbiter and is typed not_submitted", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });
    const secondUser = await createUser(db, { username: "activator2", fullName: "Activator Two", password: "p1234567" });
    const second: Actor = { type: "user", id: secondUser.id };

    const holder = await pool.connect();
    let results: PromiseSettledResult<{ versionNo: number; effectiveFrom: Date }>[];
    try {
      await holder.query("begin");
      await holder.query(SET_LOCK_SQL);
      // Both racers pass the PRE-tx checks (the row is still 'submitted' — nobody can commit
      // while the lock is held) and queue on the serializer. The natural Promise.allSettled race
      // never reliably reaches this state: its loser usually dies at the pre-tx status check
      // (ledger §3.22 — the second racer systematically lags). This interleave is forced.
      const w = activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
      w.catch(() => {});
      await delay(150);
      const l = activateVersion(db, second, draft.versionId, new Date("2026-02-01T00:00:00Z"));
      l.catch(() => {});
      await delay(150);
      await holder.query("commit");
      results = await Promise.allSettled([w, l]);
    } finally {
      holder.release();
    }

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(fulfilled).toHaveLength(1);
    expect(loser).toBeDefined();
    // The loser proceeds only after the winner COMMITTED, so its monotonicity re-check sees the
    // version's own row activated at the SAME date — and must exclude it (`ne(id, versionId)`,
    // §3.21's second half / audit m8) to fall through to the single-winner conditional UPDATE,
    // whose 0-row answer is the one honest loser code. Without the exclusion the loser dies
    // effective_from_not_monotone — this assertion is what makes the ne() clause undeletable.
    expect(loser!.reason.code).toBe("not_submitted");

    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows).toHaveLength(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows).toHaveLength(1);
  });
```

  Whichever racer wins the FIFO grant, the assertions are symmetric — the loser code is `not_submitted` in both orders, so this is not a §3.13 flake.
- [ ] **Step 2: First honest runs are GREEN — declared (§3.5), certified by Step 3's mutants.** Run the new suite isolated **10 times** (`exec jest --passWithNoTests versions.contention`, isolation shown from output); report the observed rate (expected 10/10 — these are forced interleavings, not probability windows; if any run fails, that is a finding to report, not to retry away). Confirm the path filter `versions.contention` cannot match any other suite (§2.5: `versions.test.ts` does not contain the substring `contention`).
- [ ] **Step 3: Build and execute BOTH mutants (tripwire 21).**
  - Mutant A (`versions.mutantA.ts` + `versions.mutantA.mutant.test.ts`): copy of `activateVersion` (and its imports) with the serializer `tx.execute(sql\`…for update\`)` statement DELETED; the spec replicates Test 1 against it. Expected observable: the activation settles during the hold → `expect(state).toBe("pending")` fails. Run 5×, record **DIED/SURVIVED with counts**.
  - Mutant B (`versions.mutantB.ts` + spec): copy with `ne(tariffVersions.id, versionId)` removed from the monotonicity re-check (`where(eq(status,'activated'))` only); the spec replicates Test 2. Expected observable: loser code `effective_from_not_monotone` ≠ `not_submitted`. Run 5×, record DIED/SURVIVED with counts.
  - Delete all four scratch files before the workspace count and before commit; `git status` clean.
- [ ] **Step 4: Whole workspace** — **69 suites / 386 tests**. Detached root `pnpm verify`.
- [ ] **Step 5: Commit** — `test(core): contention suite proves the activation serializer and its self-exclusion — the index alone cannot pass it` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. Both tests exist with the invariant assertions unconditional (no §3.13 early bail), passed 10/10 isolated with isolation shown from output, and are declared green-first.
2. Mutant A and Mutant B were BUILT as scratch files beside the source, EXECUTED, and reported DIED/SURVIVED with run counts; the task fails if either verdict is asserted without a run, and a SURVIVED verdict on either is a chain-halting plan defect to report (these two are designed deterministic).
3. No shipped file changed; the four scratch files are deleted; the new suite is the only tree change.
4. Workspace 69 / 386; verify green.

---

### Task 3: The belt below its guards — rejected-path integrity  *(sonnet coder)*

**The defect (B1, MODERATE, reproduced):** `activateVersion`'s rejected-approval belt UPDATE (`versions.ts:168-171`) runs BEFORE the approval-subject guard and the SoD guard. A mis-bound REJECTED approval (the exact M10 data-fix scenario the subject guard was added for) drives an unrelated healthy version to terminal `rejected` — no un-reject path exists — and the drafter, the actor SoD exists to exclude, can trigger that write. The shipped test covers only the granted mis-bind. Riding along: **m7** — the `subjectType !== "tariff_version"` half of the subject guard is deletable because the only test writes a real tariff approval id.

**Order chosen (and why it changes no shipped observable):** `unknown_version` → `not_submitted` → (`!approval || pending` → `approval_not_granted` — unchanged position: it is the null guard for everything below and writes nothing) → **subject guard** → **SoD guard** → **rejected belt + throw** → tx. Walked against every shipped versions test: pending-path unchanged (`approval_not_granted` before all moved code); legitimate rejected path unchanged (correct subject passes, activator passes SoD, belt fires, `approval_rejected` thrown — pinned by the shipped test at `versions.test.ts:122-138`, which keeps certifying the belt after the move); granted paths unchanged. The only behaviour changes are the two defect paths: mis-bound rejected → `approval_subject_mismatch` with no write; drafter/submitter on a rejected approval → `sod_drafter_activator` with no write.

**Files:**
- Modify: `apps/core/src/modules/tariff/versions.ts` (reorder inside `activateVersion`; function doc comment updated)
- Modify: `apps/core/src/modules/tariff/versions.test.ts` (+3 tests; add `requestApproval` to imports)

- [ ] **Step 1: Write the two failing tests and the one green-first test** — append to the describe block (`rejectRequest` is already imported; add `import { requestApproval } from "../../kernel/approvals/requests";`):

```ts
  it("a REJECTED approval mis-bound to a different version cannot reject it: the subject guard fires first and vA stays submitted", async () => {
    const vA = await mkDraft([[s1, 10000]]);
    const vB = await mkDraft([[s2, 20000]]);
    await withTx(db, (tx) => submitVersion(tx, drafter, vA.versionId));
    const subB = await withTx(db, (tx) => submitVersion(tx, drafter, vB.versionId));
    await rejectRequest(db, owner, { approvalId: subB.approvalId, note: "not this cycle" });

    // The M10 raw-column-write scenario again, with the approval REJECTED this time — audit B1's
    // reproduction: shipped code wrote healthy vA to terminal 'rejected' (no un-reject path
    // exists) before ever checking whose approval it was holding.
    await db.update(tariffVersions).set({ approvalId: subB.approvalId }).where(eq(tariffVersions.id, vA.versionId));

    await expect(activateVersion(db, activator, vA.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "approval_subject_mismatch",
    });
    expect((await getVersion(db, vA.versionId))!.version.status).toBe("submitted");
  });

  it("the drafter cannot trigger the rejected-approval belt: SoD fires first and the version stays submitted", async () => {
    const draft = await mkDraft([[s1, 10000]]);
    const submitted = await withTx(db, (tx) => submitVersion(tx, drafter, draft.versionId));
    await rejectRequest(db, owner, { approvalId: submitted.approvalId, note: "not this cycle" });

    // Audit B1's second half: the belt is a state-changing write, and the actor SoD exists to
    // exclude could perform it. Post-fix the drafter is turned away BEFORE the belt; the shipped
    // pending/rejected test (versions.test.ts:122) keeps pinning that a legitimate activator
    // still gets approval_rejected AND the belt still marks the version.
    await expect(activateVersion(db, drafter, draft.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "sod_drafter_activator",
    });
    expect((await getVersion(db, draft.versionId))!.version.status).toBe("submitted");
  });

  it("an approval whose subjectTYPE differs cannot activate, even with a matching subjectId", async () => {
    const vA = await mkDraft([[s1, 10000]]);
    await withTx(db, (tx) => submitVersion(tx, drafter, vA.versionId));
    // requestApproval writes subject verbatim (06.1 scout fact) — mint a granted approval of the
    // same type key whose subject.type is wrong but whose subject.id MATCHES vA, so only the
    // subjectType half of the guard can refuse it (audit m7: that half was deletable).
    const rogue = await withTx(db, (tx) =>
      requestApproval(tx, drafter, {
        typeKey: TARIFF_REVISION_APPROVAL_TYPE,
        subject: { type: "workflow_definition", id: vA.versionId },
      }),
    );
    await approveRequest(db, owner, { approvalId: rogue.approvalId, note: "approved rogue" });
    await db.update(tariffVersions).set({ approvalId: rogue.approvalId }).where(eq(tariffVersions.id, vA.versionId));

    await expect(activateVersion(db, activator, vA.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "approval_subject_mismatch",
    });
    expect((await getVersion(db, vA.versionId))!.version.status).toBe("submitted");
  });
```

- [ ] **Step 2: Run to fail** — isolated per test (tripwire 19, isolation shown from output). Expected against shipped code: test 1 RED (`approval_rejected` thrown, vA driven to `rejected` — quote it; **this red is K7's executed mutant**: the shipped order IS the wrong implementation, run for real); test 2 RED (`approval_rejected` + status `rejected` — K8's executed mutant, same reasoning); test 3 GREEN (the subjectType half exists — m7 is a coverage gap; no red owed, §3.5; its kill is Step 4's Mutant C). All three compile against unmodified shipped code (§3.23 — they consume only shipped exports; `requestApproval`'s verbatim-subject behaviour is verify-by-execution flag ②: if the kernel normalizes or validates `subject.type`, that is a plan defect to report, not to work around).
- [ ] **Step 3: Reorder `activateVersion`.** Replace lines `versions.ts:161-192` (from the `getApproval` line through the SoD guard) so the sequence reads: approval fetch → `!approval || pending → approval_not_granted` (unchanged) → subject guard (moved up, comment gains: "checked BEFORE any consequence of the approval's status is applied — a mis-bound approval can never write to a version it was not raised for (audit B1; ledger §3.27)") → SoD guard (moved up, comment gains: "sits BEFORE the rejected-approval belt so the SoD-excluded actor cannot trigger that write") → rejected belt + throw (moved down, its own comment gains: "below the subject and SoD guards (audit B1): it may only fire for the version this approval was raised for, at the hand of an actor entitled to activate it"). The belt UPDATE's SQL, the throw messages, and everything inside `withTx` are byte-unchanged. Update the function's doc comment (`:141-147`) to state the new gate order.
- [ ] **Step 4: Build and execute Mutant C (tripwire 21).** `versions.mutantC.ts` + `versions.mutantC.mutant.test.ts`: copy of the post-fix `activateVersion` with `approval.subjectType !== "tariff_version" ||` deleted from the subject guard; the spec replicates test 3's setup and asserts the same refusal. Expected observable: the rogue approval's subjectId matches, the halved guard passes, SoD passes, the version ACTIVATES → the `rejects` assertion fails. Run 5×, record DIED/SURVIVED with counts. Delete scratch files before the count step and commit.
- [ ] **Step 5: Run to pass.** `exec jest --passWithNoTests versions.test` → 1 suite, **15 tests**, including the untouched shipped rejected-path test at `:122` still green (the belt survived the move). `exec jest --passWithNoTests versions.contention` → still 2/2 (T2's suite exercises the reordered pre-checks). Workspace → 69 suites / **389 tests**. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `fix(core): rejected-approval belt moves below the subject and SoD guards; subjectType half proven` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. Tests 1 and 2 were observed RED against shipped code with the wrong code AND the wrongly-written status quoted, and pass post-fix; test 3 is declared green-first with Mutant C's executed DIED (run count stated).
2. In the shipped file, the belt UPDATE appears AFTER both the subject guard and the SoD guard; the belt's SQL and all error messages are byte-unchanged; the shipped `:122` test passes UNCHANGED.
3. The contention suite (T2) passes post-reorder, 2/2.
4. Workspace 69 / 389; verify green; scratch files gone.

---

### Task 4: The cap judges the ask everywhere — B4's missing value, m1's false comment, m5's undefined hole  *(sonnet coder)*

**Defects:** **B4** — reverting only the cap-comparison operand (`amount * 10000 >` instead of `raw * 10000 >`) survives the whole suite including golden: every existing fixture's cap is < 10000, where the two operands provably agree. At `maxBps: 10000` — legal under `manualCapParamsSchema.max(10000)` — the reverted code clamps an over-gross ask to gross and ACCEPTS a whole-line wipeout: the precise D3 violation T4-of-06.1 exists to prevent, with no behavioural test at the one cap value where old and new differ. **m1** — the shipped comment "provably identical for every maxBps < 10000" is false at `grossPaise === 0` (exhaustive sweep: 6000 divergences at zero gross). **m5** — the both-bounds guard's `=== null` lets a hand-built context with `undefined` bounds skip both the guard and every bound (each pushed `undefined` never binds), silently no-opping the C-3 clamp; TypeScript forbids the shape today, Plan 08 is the first consumer that could hand-build one.

**Files:**
- Modify: `apps/core/src/modules/tariff/contest.ts` (comment only — behaviour unchanged)
- Modify: `apps/core/src/modules/tariff/contest.test.ts` (+2 tests)
- Modify: `apps/core/src/modules/tariff/pricing.ts` (one guard: `===` → `==`, twice; comment updated)
- Modify: `apps/core/src/modules/tariff/pricing.test.ts` (+1 test)

**Interfaces:** none. Both source files stay PURE (purity greps green).

- [ ] **Step 1: Write the tests.** In `contest.test.ts` (both green-first against shipped code — B4 and m1 are coverage gaps; declared, killed by Step 3's mutant):

```ts
test("at a 100% cap the ASK is still what is judged: an over-gross ask is over_cap, never clamped-and-accepted", () => {
  // maxBps: 10000 is legal (manualCapParamsSchema .max(10000)) and is the ONE cap value where the
  // raw-operand and clamped-operand checks disagree (audit B4).
  const caps: ManualCaps = { ...CAPS, negotiated_corporate: { maxBps: 10000, approvalAboveBps: 1000 } };
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "negotiated_corporate", kind: "flat_paise", value: 60000, reason: "asked too much" },
  };
  const out = manualDiscountSource.propose(makeCtx({ manualCaps: caps }), line, 50000);
  expect(out).toHaveLength(1);
  // 60000×10000 = 600,000,000 > 10000×50000 = 500,000,000 → over_cap at the ASKED amount. The
  // clamped-operand implementation computes min(60000, 50000) = 50000, finds 500M > 500M false,
  // and ACCEPTS a silent whole-line wipeout (requiresApproval true) — the exact D3 violation.
  expect(out[0]?.amountPaise).toBe(60000);
  expect(out[0]?.rejected).toEqual({ code: "over_cap", detail: "60000p exceeds 10000bps of 50000p" });
});

test("a positive ask on a ZERO-GROSS line records over_cap — and keeps the asked amount in the audit record", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "negotiated_corporate", kind: "flat_paise", value: 5000, reason: "camp waiver" },
  };
  // gross 0: 5000×10000 = 50,000,000 > 2000×0 = 0 → over_cap, detail "5000p exceeds 2000bps of 0p".
  // Owner-ratified policy (audit m1, 2026-08-15): any positive ask exceeds every cap of a
  // zero-gross line, and over_cap keeps the ASK in the D-8 record; the pre-06.1 clamped path
  // recorded an accepted 0 and LOST the ask. No money moves either way.
  const out = manualDiscountSource.propose(makeCtx(), line, 0);
  expect(out).toHaveLength(1);
  expect(out[0]?.amountPaise).toBe(5000);
  expect(out[0]?.rejected).toEqual({ code: "over_cap", detail: "5000p exceeds 2000bps of 0p" });
});
```

  In `pricing.test.ts` (RED-first — the shipped `===` IS K12's mutant, executed by this run):

```ts
test("a regulated row with UNDEFINED bounds (a hand-built ctx) is refused exactly like a null-bounds row", () => {
  const ctx = makeCtx({
    regulatedPrices: {
      "svc-drug-a": { mrpPaise: 10000, ceilingPaise: 15000 },
      "svc-drug-b": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-c": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-d": { mrpPaise: undefined, ceilingPaise: undefined } as unknown as { mrpPaise: number | null; ceilingPaise: number | null },
    },
  });
  // TypeScript forbids this shape today; Plan 08 is the first consumer that could hand-build a
  // context (audit m5). Shipped `=== null` lets undefined/undefined skip the guard AND every
  // bound (`undefined !== null` pushes a bound whose `undefined < unit` never binds) — pricing
  // at bare tariff 5000 + 2×300 GST = net 5600 with regulatedClamp null. `== null` refuses it;
  // a legal 0-paise bound still survives (0 == null is false).
  expect(thrownCode(() => priceInvoiceLines(ctx, [{ lineId: "L1", serviceId: "svc-drug-d", qty: 1 }])))
    .toBe("regulated_price_missing");
});
```

- [ ] **Step 2: Run — quote the m5 red** (isolated; shipped code returns net 5600, no throw). The two contest tests are green-first, declared (§3.5).
- [ ] **Step 3: Build and execute Mutant D (tripwire 21) — ONE mutant, TWO kills.** `contest.mutant.ts` + `contest.mutant.mutant.test.ts`: copy of `manualDiscountSource` reverted to the clamped-operand shape (`amountPaise: amount` on both rejected branches AND `amount * 10000 > caps.maxBps * grossPaise`, detail interpolating `amount` — the pre-06.1 implementation, which is exactly what audit B4 reverted). The spec runs BOTH Step-1 contest tests against it. Expected observables, hand-derived: B4 leg → accepted `{ amountPaise: 50000, requiresApproval: true, rejected: null }` (50000×10000 = 500M ≯ 500M; 50000×10000 > 1000×50000 → approval flag); m1 leg → accepted `{ amountPaise: 0, requiresApproval: false, rejected: null }` (min(5000,0)=0; 0 ≯ 0; 0 ≯ 0). Both assertions fail → DIED expected on both legs. Run 5×, record per-leg DIED/SURVIVED with counts. Delete scratch files.
- [ ] **Step 4: Implement.** In `pricing.ts`, the guard becomes `if (rp.mrpPaise == null && rp.ceilingPaise == null) {` with its comment's last line replaced by: `// Both comparisons are '== null' — undefined from a hand-built context is refused too (audit m5), while a legal bound of 0 paise still survives (0 == null is false).` The bounds-loop `!== null` checks stay: for a MIXED shape (one bound undefined, one real) the pushed undefined bound never binds, which is observably identical to the null case — declared here, not "fixed". In `contest.ts`, replace the false comment clause with: `// For every maxBps < 10000 AND grossPaise > 0 this is provably identical to the old clamped-operand check; at grossPaise === 0 any positive ask is over_cap by policy (audit m1, owner-ratified 2026-08-15 — the record keeps the ask), and at maxBps = 10000 the raw operand is the one that refuses an over-gross ask (audit B4).` No executable line in `contest.ts` changes.
- [ ] **Step 5: Run to pass.** `exec jest --passWithNoTests contest.test` → **16**; `pricing.test` → **11**; golden untouched and green (`exec jest --passWithNoTests golden` → 16 — no fixture changes in this task). Purity greps green. Workspace → 69 suites / **392 tests**. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `test(core): cap comparison proven at the 100%-cap boundary and zero gross; undefined regulated bounds refused` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. The m5 test was observed RED (net-5600 path quoted) and passes post-fix; the two contest tests are declared green-first with Mutant D executed and BOTH legs' DIED verdicts recorded with run counts.
2. `contest.ts`'s diff is comment-only; `pricing.ts`'s executable diff is exactly the two `===`→`==` changes in one guard; purity greps pass.
3. The B4 test pins detail `"60000p exceeds 10000bps of 50000p"` and amount 60000; the m1 test pins `"5000p exceeds 2000bps of 0p"` and amount 5000 — both hand-derived above.
4. Workspace 69 / 392; verify green; no golden fixture byte changed; scratch files gone.

---

### Task 5: The gate's catch tells the truth, and its duplicate filters have teeth  *(sonnet coder)*

**Defects:** **m3** — `validateTariffConfig`'s engineCaps `catch {}` swallows EVERY `loadRuleConfig` failure. A corrupt-params ZodError is the designed path (Break 4 pins it), but a connection reset or a genuine bug is misattributed as four `manual_caps_missing` errors — the operator hunts a caps problem that does not exist. The smoke block already types non-Tariff failures (`context_load_failed`); this fix mirrors that shipped convention. **m6** — deleting any of the duplicate-cap loop's three window filters (`!row.active`, `validFrom > at`, `validTo < at`) survives the suite: a retired, expired, or future cap row would be reported as a live duplicate.

**Files:**
- Modify: `apps/core/src/modules/tariff/context.ts` (+`import { z } from "zod";`; the catch narrowed)
- Modify: `apps/core/src/modules/tariff/context.test.ts` (+2 tests; +`import * as rulesModule from "./rules";`)

**Interfaces:** `rule_config_load_failed` is a new `ConfigError` code STRING (open set — no union, no event). `validateTariffConfig` still NEVER throws.

- [ ] **Step 1: Write the failing m3 test** — append to `context.test.ts`:

```ts
  test("a NON-config loadRuleConfig failure is reported as rule_config_load_failed, never as missing caps", async () => {
    await seedFullValidConfig();
    // One rejection, consumed by validateTariffConfig's own direct call (its FIRST loadRuleConfig
    // call — the smoke block's loadPricingContext call comes later and gets the real function).
    const spy = jest.spyOn(rulesModule, "loadRuleConfig").mockRejectedValueOnce(new Error("connection reset by peer"));
    try {
      const report = await validateTariffConfig(db, new Date("2026-03-01T00:00:00Z"));
      // Shipped code swallowed this and printed FOUR manual_caps_missing entries (audit m3) —
      // a false diagnosis; all four caps are seeded and fine.
      expect(report.ok).toBe(false);
      expect(report.errors.some((e) => e.code === "rule_config_load_failed" && e.detail.includes("connection reset"))).toBe(true);
      expect(report.errors.filter((e) => e.code === "manual_caps_missing")).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
```

  And the green-first m6 test:

```ts
  test("a retired, expired, or not-yet-valid second cap row is NOT reported as a duplicate", async () => {
    await seedFullValidConfig();
    const mk = (ruleKey: string, extra: { active?: boolean; validFrom?: Date; validTo?: Date }) =>
      withTx(db, (tx) =>
        upsertAdjustmentRule(tx, drafter, {
          ruleKey, sourceKey: "manual", title: ruleKey,
          params: { discountCategory: "charity", maxBps: 500, approvalAboveBps: null }, ...extra,
        }),
      );
    await mk("CAP-CHARITY-RETIRED", { active: false });
    await mk("CAP-CHARITY-FY25", { validTo: new Date("2026-01-31T00:00:00Z") });
    await mk("CAP-CHARITY-FY27", { validFrom: new Date("2027-04-01T00:00:00Z") });
    const report = await validateTariffConfig(db, new Date("2026-03-01T00:00:00Z"));
    // Deleting any one of the loop's three window filters (audit m6) turns the matching row
    // above into a phantom "live duplicate" of the seeded CAP-CHARITY.
    expect(report.errors.filter((e) => e.code === "duplicate_manual_cap")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
```

- [ ] **Step 2: Run — quote the m3 red** (shipped: four `manual_caps_missing`, no `rule_config_load_failed` — both assertions fail; **this red is K13's executed mutant**). The m6 test is green-first, declared. Both compile against shipped code (§3.23). Verify-by-execution flag ③: `jest.spyOn` on a CJS namespace import re-binding `loadRuleConfig` for `context.ts`'s call site — ts-jest compiles the import to a property access, so the spy takes; if it does not (the assertion sees the real function), report a plan defect, do not restructure shipped code to make it mockable. Flag ④: `z.ZodError` instanceof under zod ^4 across the same installed package — `loadRuleConfig` uses `.parse`, one zod instance in the workspace.
- [ ] **Step 3: Implement the narrowed catch.** In `context.ts`: add `import { z } from "zod";`; replace the engineCaps block (`:152-164`) with:

```ts
  // The caps the ENGINE will actually see at `at` — loadRuleConfig, the same function
  // loadPricingContext uses (active + validity window). Building this map from the raw table let
  // the gate print ok=true while every charity waiver died unknown_category at the counter (M1).
  let engineCaps: ManualCaps | null = null;
  try {
    engineCaps = (await loadRuleConfig(db, at)).manualCaps;
  } catch (e) {
    if (e instanceof z.ZodError) {
      // Corrupt params throw BY DESIGN (billing-time behaviour). The loop above has already
      // recorded invalid_rule_params; with no loadable caps, every category below correctly
      // reports manual_caps_missing — the shipped Break-4 behaviour, unchanged.
      engineCaps = {};
    } else {
      // A non-config failure (connection reset, tx abort, a genuine bug) is NOT a caps problem —
      // reporting it as four manual_caps_missing sent the operator hunting config that was fine
      // (audit m3). Same convention as the smoke block's context_load_failed below. Never throws.
      errors.push({
        code: "rule_config_load_failed",
        detail: `loadRuleConfig failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  if (engineCaps !== null) {
    for (const cat of DISCOUNT_CATEGORIES) {
      if (!engineCaps[cat]) {
        errors.push({ code: "manual_caps_missing", detail: `no ACTIVE manual discount cap effective at ${at.toISOString()} for category "${cat}"` });
      }
    }
  }
```

  **Regression trace, walked here:** Break 4 corrupts a `"rule"` row → `loadRuleConfig` throws ZodError → `engineCaps = {}` → four `manual_caps_missing` + the loop's `invalid_rule_params`, `ok` false, nothing thrown — every existing assertion in the shipped four-breaks test holds byte-unchanged. Happy path: caps load, no error entries, `ok: true` — the shipped `toEqual({ ok: true, errors: [], caSigned: false })` holds.
- [ ] **Step 4: Build and execute Mutants E1–E3 (tripwire 21).** `context.mutant.ts` + `context.mutant.mutant.test.ts`: copy of `validateTariffConfig` (post-fix); the spec seeds via the same helpers and asserts the m6 expectation against the mutant. Run three sequential verdicts by editing THE SCRATCH COPY between runs (scratch files may be edited — they are never shipped): E1 deletes `!row.active ||` → the RETIRED leg must report a duplicate → assertion fails → DIED; restore, E2 deletes the `validTo` filter → FY25 leg → DIED; restore, E3 deletes the `validFrom` filter → FY27 leg → DIED. Record three verdicts with run counts. Delete scratch files.
- [ ] **Step 5: Run to pass.** `exec jest --passWithNoTests context.test` → 1 suite, **10 tests**, the shipped four-breaks test and both 06.1-T5 tests UNCHANGED and green. Workspace → 69 suites / **394 tests**. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `fix(core): non-config loadRuleConfig failures reported as rule_config_load_failed; duplicate-cap filters proven` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. The m3 test was observed RED with the shipped four-`manual_caps_missing` misattribution quoted, and passes post-fix; the ZodError path is proven unchanged by the shipped Break-4 test passing byte-unchanged.
2. The m6 test is declared green-first with E1/E2/E3 each executed and DIED, run counts stated.
3. `validateTariffConfig` still never throws (the catch has no rethrow path); `ok:true` requires zero errors including the new code.
4. Workspace 69 / 394; verify green; scratch files gone.

---

### Task 6: Scope you can see, a manifest you cannot gut  *(sonnet coder)*

**Defects:** **B3** — the e2e gazette fixture has ONE service with regulated rows, so a route that ignores `:id` is observationally identical to the shipped one over HTTP (textbook §3.14; mitigated off-HTTP by `services.test.ts`'s two-service scope test). **m10** — the golden manifest pins names, never content: a fixture gutted to `lines: [], expected: []` passes vacuously, and the `.endsWith(".json")` filter means a `g99-rogue.JSON` straggler is invisible to every test while sitting in the shipped fixtures directory.

**Files:**
- Modify: `apps/core/test/tariff.e2e.test.ts` (the gazette `it(…)` block extended in place — test count unchanged)
- Modify: `apps/core/src/modules/tariff/golden.test.ts` (+2 tests)

- [ ] **Step 1: Extend the gazette e2e block** — insert after the existing history assertions (`expect(history.body.items[0].ceilingPaise).toBe(6000);`) and before the `GET /tariff/versions` section:

```ts
    // Scope (audit B3): a SECOND service with its own gazette row is what makes "scoped" and
    // "unscoped" observably different over HTTP — with one service they are identical (§3.14).
    const svc2 = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "DRUG-2", name: "Drug Two", category: "pharmacy", regulated: true }).expect(201);
    const drug2Id = svc2.body.serviceId as string;
    const r3 = await request(app.getHttpServer())
      .post(`/tariff/services/${drug2Id}/regulated-prices`).set(...auth(adminToken))
      .send({ mrpPaise: 7000, effectiveFrom: "2026-04-01T00:00:00.000Z", gazetteRef: "GZ-2" }).expect(201);

    const historyA = await request(app.getHttpServer())
      .get(`/tariff/services/${drugId}/regulated-prices`).set(...auth(readerToken)).expect(200);
    expect(historyA.body.items).toHaveLength(2); // drug2's row is NOT here — the :id is live
    expect(historyA.body.items.map((r: { id: string }) => r.id)).toEqual([r2.body.id, r1.body.id]);
    const historyB = await request(app.getHttpServer())
      .get(`/tariff/services/${drug2Id}/regulated-prices`).set(...auth(readerToken)).expect(200);
    expect(historyB.body.items.map((r: { id: string }) => r.id)).toEqual([r3.body.id]);
```

- [ ] **Step 2: Add the two golden tests** — after the manifest test in `golden.test.ts`:

```ts
test("the fixtures directory contains NOTHING but the manifest — a .JSON straggler or stray file cannot hide", () => {
  // `files` filters .endsWith(".json") (case-sensitive), so a g99-rogue.JSON in the shipped
  // directory would be invisible to every fixture test while shipping in the tree (audit m10).
  expect([...readdirSync(dir)].sort()).toEqual(files);
});

test("no fixture is vacuous: every fixture prices at least one line", () => {
  for (const file of files) {
    const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
    // A fixture gutted to lines: [] passes the per-fixture deep-equal loop vacuously (audit m10);
    // the manifest pins names, this pins that each name still tests something.
    expect(fixture.lines.length).toBeGreaterThan(0);
    if (fixture.kind === "price") expect(fixture.expected.length).toBe(fixture.lines.length);
  }
});
```

  Both green-first, declared (§3.5): every shipped fixture is non-vacuous and the directory is clean; the coverage IS the deliverable. (All three fixture kinds carry `lines` — scout-verified against the harness loop.)
- [ ] **Step 3: Build and execute the m10 mutants (tripwire 21) — scratch-DIRECTORY replication, declared approximation.** The mutants here are FIXTURE mutations, which must never touch the shipped directory. Create `/opt/hmis/apps/core/src/modules/tariff/golden/.scratch-fixtures/` (under /opt/hmis, tripwire 3): copy all 14 shipped fixtures in, then (G1) add `g99-rogue.JSON` containing `{}`, and (G2) overwrite the copied `g01-baseline-exempt.json`'s `lines` and `expected` with `[]`. Create `golden.mutant.test.ts` beside `golden.test.ts` that reproduces the two Step-2 tests' logic verbatim but pointed at the scratch directory (the loader is two lines — `readdirSync` + filter — and the approximation is declared in the report: the mutant certifies the ASSERTIONS, the shipped tests bind them to the real directory). Expected: G1 fails the raw-listing test (`.JSON` in readdir, absent from files); G2 fails the vacuous test (`lines.length 0`) — for G2, note the gutted copy also changes `files`… it does not: the NAME g01 is unchanged, only content. Run once each, record DIED/SURVIVED. Delete the scratch directory AND the mutant spec before the count step and commit; `git status` clean.
- [ ] **Step 4: Build and execute Mutant F — the unscoped route, at controller-unit level (declared approximation).** A bootable Nest mutant would need a parallel AppModule; the honest cheap equivalent: `tariff.controller.mutantF.ts` exports a minimal class with `constructor(private readonly db: Db)` and the mutated route body `return { items: await this.db.select().from(regulatedPrices).orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.seq)) };` (the `:id` ignored — audit B3's mutant). `tariff.controller.mutantF.mutant.test.ts`: `setupTestDb`, seed two services with 2+1 regulated rows via `withTx`/`createService`/`appendRegulatedPrice`, instantiate the mutant with `db`, call it with service A's id, and apply Step 1's shape assertion `expect(items).toHaveLength(2)` → receives 3 → DIED expected. Run 5×, record the verdict with counts. The report declares the approximation: the mutant executes the scope ASSERTION against an unscoped implementation; route binding, auth, and serialization stay covered by the shipped e2e's captured-id assertions. Delete scratch files.
- [ ] **Step 5: Run to pass.** `exec jest --passWithNoTests tariff.e2e` → 1 suite, **8 tests** (`tariff.e2e` cannot match `tariff-lifecycle.e2e` — §2.5, one mandatory character); `exec jest --passWithNoTests golden` → **18**. Workspace → 69 suites / **396 tests**. All 14 fixture JSONs byte-unchanged (`git status`). Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `test(core): e2e gazette scope proven with a second service; golden manifest pins content and the raw directory` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. The e2e block asserts BOTH directions of scope (A excludes B's row by captured ids; B returns exactly its own), green-first declared, Mutant F executed with verdict and run count recorded, approximation declared.
2. Both golden tests exist; G1 and G2 executed in the scratch directory with verdicts recorded; the scratch directory and specs are deleted; all 14 shipped fixtures byte-identical.
3. Workspace 69 / 396; contracts 3/7 and web 11/37 unchanged for the whole plan; verify green.

---

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Per tripwire 21, "Kills" below are HAND-DERIVED PREDICTIONS. Each task's acceptance criteria require the mutant BUILT and RUN, and the **Executed verdict** recorded in the task report (the gate checks the verdict exists and matches a real run — never a hand-walk). "= pre-fix red" means the shipped code is itself the mutant and the observed fail-first run is the executed evidence.

| # | Task | Assertion | Kills (mutant → predicted wrong observable) | Executed verdict | Honesty notes |
|---|---|---|---|---|---|
| K1 | T1 | 60 same-date corrigenda ALL resolve to the correction | shipped id-tie-break → some service resolves `ceilingPaise 99900` (≈88%/run window) | = pre-fix red (rate reported) | red is probabilistic pre-fix (§3.22 floor 5, keep going to 20); deterministic green post-fix |
| K2 | T1 | history `[r3, r2, r1]` with heap agitation | drop `desc(seq)` → order decided by Postgres sort internals | **measure, do not predict** | the audit proved this exact row un-predictable (m11); load-bearing defense is structural (bigserial allocation) + K1; SURVIVED is an acceptable honest outcome |
| K3 | T1 | rules cap last-write-wins rides `seq` | `asc(seq)`→`asc(id)` revert — **no behavioural kill exists**: 0/200 same-ms on the sequential upsert path | none owed — declared | the one un-killable row, stated up front; defenses: bigserial allocation order + A17's `duplicate_manual_cap` |
| K4 | T1 | corrigendum's `seq` > original's, in-tx | (structural pin of allocation order; green by construction) | n/a | belt for K1's mechanism claim |
| K5 | T2 | activation BLOCKS ≥400ms under a held set lock, completes after release | Mutant A (serializer deleted) → settles immediately → "pending" assertion fails | required DIED | deterministic by design; SURVIVED = chain-halting plan defect |
| K6 | T2 | forced same-version loser typed `not_submitted`; 1 row, 1 event | Mutant B (`ne()` deleted) → loser `effective_from_not_monotone` | required DIED | symmetric in FIFO order — not a §3.13 flake |
| K7 | T3 | mis-bound REJECTED approval → `approval_subject_mismatch`, vA stays submitted | shipped order → `approval_rejected` + vA terminally rejected | = pre-fix red | the audit's B1 reproduction as a test |
| K8 | T3 | drafter on rejected approval → `sod_drafter_activator`, version stays submitted | shipped order → belt fires for the SoD-excluded actor | = pre-fix red | shipped `:122` test keeps pinning the legitimate belt path |
| K9 | T3 | wrong-subjectTYPE approval refused with matching subjectId | Mutant C (subjectType half deleted) → vA ACTIVATES | required DIED | green-first (m7 is a coverage gap) |
| K10 | T4 | cap 10000, ask 60000 > gross 50000 → `over_cap` @60000, detail `"…10000bps…"` | Mutant D (clamped operand) → accepted `{50000, requiresApproval: true}` | required DIED | the ONE cap value where operands disagree — B4's exact revert |
| K11 | T4 | gross 0, ask 5000 → `over_cap` @5000, detail `"…of 0p"` | Mutant D (same build) → accepted `{0, requiresApproval: false}` | required DIED | m1 policy pin; one mutant, two kills |
| K12 | T4 | undefined/undefined bounds → `regulated_price_missing` | shipped `=== null` → net 5600, clamp null | = pre-fix red | cast-built ctx; 0-paise bound survives `==` |
| K13 | T5 | non-Zod load failure → `rule_config_load_failed`, zero `manual_caps_missing` | shipped bare catch → four `manual_caps_missing`, no typed code | = pre-fix red | ZodError path pinned unchanged by shipped Break-4 |
| K14–16 | T5 | retired / expired / future second cap → NOT duplicate | E1/E2/E3 (each filter deleted in scratch copy) → phantom duplicate reported | required DIED ×3 | one test, three legs, three sequential scratch edits |
| K17 | T6 | e2e history for A excludes B's row; B returns its own | Mutant F (route ignores `:id`) → 3 items where 2 asserted | required DIED | executed at controller-unit level — approximation declared; route binding covered by shipped e2e ids |
| K18 | T6 | raw `readdirSync` listing equals the manifest | G1 (`g99-rogue.JSON` straggler in scratch dir) → listing ≠ files | required DIED | scratch-directory replication, declared |
| K19 | T6 | no fixture has `lines: []` (price: expected length = lines length) | G2 (gutted g01 copy in scratch dir) → length 0 | required DIED | same scratch run |

---

## Self-review — what this plan's own passes caught before commit

**Pass 1 (every block read as compiler + test runner):**
1. **The K1 test as first drafted did not compile against shipped code** — its `history[0]!.seq` assertions reference a column T1 itself adds, exactly ledger §3.23's fail-first-that-cannot-compile. Fixed: Step 2 runs the test with the two seq lines commented, Step 5 restores them; the pre-fix red demonstrates the resolver defect, not a type error.
2. **A "typed loser under cross-version contention" third T2 test was designed and then DELETED** — under the serializer-deleted mutant, sessions that ignore the lock never queue on the holder, so the forced interleave degenerates to the natural race and the discriminator collapses to the ~2%/run window §3.22 documented. The block-observation test discriminates deterministically; the typed-degradation path (raw 23505 → HTTP 500) stays with the m4 deferral, which the disposition map now cross-references.
3. **T2's fired-but-unawaited promises would crash Node on rejection** while the holder sleeps — an unhandled rejection is fatal in Node 22. Both tests attach `p.catch(() => {})` at creation; `Promise.allSettled` still observes the original settlement.
4. **T3's reorder could NOT naively preserve the shipped `approval_not_granted` observable** — moving ALL approval-status handling below SoD would flip the pending+drafter path from `approval_not_granted` to `sod_drafter_activator`, silently changing a shipped surface. The chosen order leaves the `!approval || pending` check in place (it writes nothing and null-guards the subject access) and moves only the rejected belt; every shipped versions test was walked against the new order in the task preamble.
5. **The m1 test needs no zero-priced fixture** — `manualDiscountSource.propose` takes `grossPaise` as an argument, so the zero-gross case is `propose(makeCtx(), line, 0)` with no tariff-item plumbing. First draft built a 0-paise service for nothing.
6. **The m3 spy would have poisoned the smoke block** if it mocked every call — `loadPricingContext` calls `loadRuleConfig` too. `mockRejectedValueOnce` scopes the failure to the engineCaps call (the function's first), and the test comment says so, so a future edit that reorders the calls fails loudly rather than mysteriously.
7. **m6's fix-shape trap:** the duplicate-cap loop must NOT be "fixed" by reusing `loadRuleConfig`'s filtered rows — the gate deliberately validates params on inactive rows too (a corrupt retired row is still a config smell, per the shipped design). T5 therefore adds NO production change for m6 — the filters are correct; only their tests were missing. The task's diff for m6 is test-only, and the criteria say so.

**Pass 2 (every consumed surface re-checked against the five scout transcriptions, and the numbers re-derived):**
8. **B4's arithmetic re-derived:** 60000×10000 = 600,000,000 vs 10000×50000 = 500,000,000 → over_cap; mutant side min(60000,50000) = 50000 → 500M ≯ 500M → accepted with `requiresApproval` (50000×10000 = 500,000,000 > 1000×50000 = 50,000,000) = true. Detail strings interpolate `raw`/`caps.maxBps`/`grossPaise` exactly as `contest.ts:49` formats them.
9. **The e2e extension reuses only identifiers the shipped block already binds** (`drugId`, `r1`, `r2`, `auth`, `adminToken`, `readerToken`) — scout-verified at `tariff.e2e.test.ts:398-430`; the new `svc2`/`r3` names collide with nothing in scope.
10. **The contention suite's pool arithmetic checked:** holder client (1) + winner tx (1) + loser tx (1) + pre-check queries — inside the default pg Pool of 10; no starvation risk. `SET_LOCK_SQL` matches `versions.ts:205` byte-for-byte.
11. **Jest will collect any `*.mutant.test.ts`** (testMatch `**/src/**/*.test.ts`) — which is exactly why every mutant step deletes scratch files BEFORE the workspace-count step, and why every count criterion in this plan is stated post-deletion. The suite ladder never includes a mutant spec.
12. **`rules.test` stays at 9** and `gst`/`gst-config`/`money`/`simulation`/`schema` suites are untouched — the ladder's per-suite deltas reconcile: 383 +1 (T1) +2 (T2) +3 (T3) +3 (T4) +2 (T5) +2 (T6) = **396**, suites 68 +1 = **69**.

---

## Test-count ladder (per-workspace; measured baseline 2026-08-15 at `acd42d2` — measurement beats this document)

`apps/core`: 68 suites / 383 tests → **T1** 68/384 (services 8→9) → **T2** 69/386 (+versions.contention 2) → **T3** 69/389 (versions 12→15) → **T4** 69/392 (contest 14→16 · pricing 10→11) → **T5** 69/394 (context 8→10) → **T6** 69/396 (golden 16→18 · e2e stays 8). `packages/contracts` 3/7 and `apps/web` 11 files/37 unchanged throughout (T1's contracts change is a doc comment).

---

## Pipeline Notes (for /execute compilation — do not compile before owner approval AND the A1 ruling)

- **One pipeline, six tasks, strictly sequential.** Shared-file chain: T2's suite exercises `versions.ts`, which T3 edits (T3's criteria re-run T2's suite); T1 owns `services/rules/schema`; T4/T5/T6 are disjoint from everything after T1.
- **Tier map:** opus coders on **T1** (the plan's only migration + the ordering semantics) and **T2** (concurrency harness); sonnet on T3–T6 (their diffs are small and this document carries the exact blocks and derivations); **opus gate on every task**.
- **Cost calibration:** Plan 06.1's observed clean rate was 165–278k per task including its gate (mean 204k); this plan adds mandatory mutant builds (~10–20% on the heavier tasks) ⇒ **work ≈ 1.1–1.6M**. Plus the **explicit infrastructure contingency of 0.3–0.5M** that made 06.1 the first estimate in the series to land inside its band (ledger §12.6/§2.8-adjacent: budget stalls and outages, never hope them away). **Total budget: ~1.4–2.1M subagent tokens; treat ~1.65M as the expected midpoint.** Wall clock ~2.5–3.5h at the observed pace.
- **Frozen paths while the pipeline runs:** `apps/web/**`; `packages/contracts/**` EXCEPT `src/ids.ts` (T1, comment-only); `modules/patients/**` (esp. `qr.test.ts`); `.github/workflows/**` (tripwire 10); `kernel/**` EXCEPT `kernel/db/schema/tariff.ts` (T1 only); `drizzle/**` T1 only; `modules/tariff/index.ts` BYTE-FROZEN; plus the Global Constraints untouched list (notably `test/helpers/db.ts`, `tariff.controller.ts`, all 14 fixture JSONs, both `package.json`s, `pnpm-lock.yaml`).
- **Migration rule:** exactly one (T1, `0009`). Any later schema need = chain halt + plan-defect report.
- **Compile rules (from EXECUTION-LESSONS):** §1 tripwires **1–21 verbatim at the TOP of every brief** (20 and 21 are new since 06.1 — interference and executed-mutants; they are the point of this plan) · briefs point at this committed plan on the server, never restate its code · baseline = "the previous task's commit, i.e. current `origin/main`" (§2.6) · per-suite counts from this document's measured table, with the statement that measurement beats the document (§2.9) · FINISH block = three numbered steps (§3.8) · gate verdicts carry `retry_mode` (§2.2) · no correction may direct a history rewrite (tripwire 15) or security-code weakening (tripwire 14) · race/isolation evidence only via `exec jest … ` with isolation read from OUTPUT (tripwire 19) · every fail-first criterion carries its post-hoc fallback: "…or, if a prior attempt already shipped the artifact, the gate re-derives the Book row and re-runs the surviving mutants instead" (§2.8) · after any infra halt, check whether the dead agent pushed before resuming (Plan 06 §7.4) · scout briefs (if any run mid-pipeline) must not run tests concurrently with tasks (tripwire 20) and must carry the §2.11 final-message output protocol · deviations-not-to-fix in every brief: gate reports 01–06.1 §4/§5 items, `qr.test.ts`'s flake (not this plan's file), m2/m4/m9 deferrals per the disposition map.
- **Mutant discipline for every brief:** mutants are separate scratch files beside the source (never edits to shipped files — tripwire 14/21); scratch specs run isolated by explicit path; verdicts reported as DIED/SURVIVED with run counts; ALL scratch files deleted before workspace counts and before commit; a required-DIED that SURVIVES is a chain halt (plan defect), not something to fix silently.
- **Carried forward, not this plan's work:** the m2/m4/m9 deferrals (disposition map); the workflow-transitions timestamp-ordering observation (`workflow.controller.ts:142`) for the next plan owning workflow read surfaces; Plan 07's ids must not order by `newId()` anywhere (the ids.ts warning + this plan's precedent are the guardrails); Plan 08 authoring inherits the findings §14 list unchanged from 06.1's notes.
- **Events note:** no new event names; `rule_config_load_failed` is a ConfigError string. The dispatcher remains unscheduled until Plan 11; nothing here wires consumers.
