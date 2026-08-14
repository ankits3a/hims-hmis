# Plan 06.1 — Tariff Hardening · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**STATUS: WRITTEN 2026-08-14, awaiting owner approval. PLANNING ONLY — no execution has occurred.**

**Goal:** Close the four CRITICAL findings and the highest-value MODERATE findings from the post-Plan-06 adversarial stress test (four read-only audit agents, 613k tokens, 2026-08-14). Three of the four criticals can bill wrong money or misstate statutory compliance **today**; the other two are test gaps that leave correct code undefended against the next edit. Plan 08 builds directly on this surface, so every one of these is cheaper to fix now than after invoices exist.

**Baseline:** `6483c2d` on main. `apps/core` 68 suites / 360 tests; `packages/contracts` 3/7 and `apps/web` 11/37 untouched by this plan.

**Tech stack:** Existing only. **Zero new dependencies, zero env vars, zero CI changes. Exactly ONE migration (`0008`), generated in Task 1.**

---

## Global Constraints

- Money is integer **PAISE**, always. No floats in pricing, ever. **No `z.coerce` anywhere in this module**, for any field, including `z.coerce.date()`.
- `money.ts`, `types.ts`, `contest.ts`, `gst.ts`, `pricing.ts`, `simulation.ts` remain **pure and synchronous**: no `await`, no import from any `kernel/` path, no `new Date(`, no `Math.random`. The gate greps those four strings against those six files.
- **Exactly ONE migration**, `0008`, generated in Task 1 by `pnpm --filter @hmis/core db:generate`, never hand-edited. A schema need discovered in any later task is a **plan defect to report, not to fix**.
- **`index.ts` is frozen.** This plan adds no export and removes none. Plan 08's contract does not move. (T3 adds one member to the `TariffErrorCode` union, which `index.ts` already re-exports as a type — that is a widening of an existing export, not a new one.)
- `packages/contracts` and `apps/web` are **byte-untouched**. `modules/patients` is read-only. **Do not touch `qr.test.ts`** — its 1-in-4096 tamper flake is a deliberately carried open item belonging to a future task that owns that file.
- Events: **no new event names.** The module's catalog stays exactly `tariff.revision_applied` and `config.validated`.
- Every fixture value added or changed in this plan is **hand-derived in this document** and must never be produced by running the engine (the §3.14 rule Plan 06 was built around — see "The fixture lesson" below).

---

## The fixture lesson this plan exists to apply

Plan 06's Fixture Book discipline worked for what it targeted: no expected value came from engine output, and both gates re-derived samples by hand. But `g09-manual-over-cap.json` — the fixture **named** *"records the amount that was ASKED… never clamped"* — uses `percent_bps 2500` of gross `50000` = `12500`, which is below gross, so `Math.min(raw, gross)` is a no-op and the fixture passes **identically** under the clamping implementation it exists to kill. The plan's own Fixture Book rule 3 ("no fixture where both the right and a wrong implementation produce the same observable") is violated by the fixture named after the property.

**Hand-derivation guarantees a fixture is not circular. It does not guarantee the fixture is discriminating.** Those are two separate audits and Plan 06 ran only the first. Every fixture and assertion this plan touches must pass both: derived by hand from the rules in this document, **and** demonstrated to separate the right implementation from the named wrong one.

---

## Owner decisions (resolved in-conversation 2026-08-14)

1. **Hardening now**, before Plan 07 or 08 is authored.
2. **Drafter-as-approver: accepted as a v1 risk, not fixed in code.** The owner currently drafts prices and holds the sole `owner` approver role. Senior staff will later hold **tiered discount approvals**. Binding consequence for this plan and Plan 08: approver roles and thresholds must remain **workflow-definition DATA**, never hard-coded. This plan adds no approver-role logic and hard-codes no role.
3. **`flat_paise` discounts are WHOLE-LINE.** Recorded in `types.ts` as a doc comment (T5). Partial refunds of a flat-discounted line are Plan 08's problem and its plan must state the rule.
4. **The §170 rounding difference gets a dedicated `rounding_paise` column** on Plan 08's invoice table. Recorded here as a forward decision only — **no schema for it in this plan.**
5. **Migration 0008 is authorised, scoped to the partial unique index only** (see T1). The `regulated_prices` both-bounds-null hole is closed in application code instead: partial unique indexes have two shipped precedents in this repo and drizzle-kit emits them correctly, whereas **CHECK constraints have zero precedent anywhere in the schema** — an unproven drizzle-kit path is not worth adding to a money migration for a state only direct SQL can reach.
6. **Integer-overflow headroom is accepted as-is.** The safe threshold is ~₹4.5 × 10⁹ on a single line; no work.

---

## Consumed shipped surfaces (scout-verified against source at `6483c2d`)

| Surface | Fact | Where |
|---|---|---|
| Partial unique index | Supported and precedented: `uniqueIndex("n").on(t.col).where(sql\`…\`)`. `.where` exists only **after** `.on()` (on `IndexBuilder`, not `IndexBuilderOn`) | drizzle-orm 0.40.1, `pg-core/indexes.d.ts:67`; precedents `schema/workflow.ts:25`, `schema/patients.ts:172` |
| drizzle-kit emits WHERE | Confirmed in shipped SQL | `drizzle/0004_white_hydra.sql:70`, `drizzle/0006_faithful_ultron.sql:112` |
| CHECK constraints | **No precedent anywhere** in `schema/*.ts` | grep: zero hits |
| `schema/tariff.ts` imports | Does **not** import `sql`; T1 must add `import { sql } from "drizzle-orm";` | `schema/tariff.ts:1-3` |
| `versions.ts` imports | `and, desc, eq, lte, ne, sql` from drizzle-orm. **`inArray` is NOT imported** | `versions.ts:1` |
| Current activation locks | Two statements: target-row lock then `where status = 'activated' for update` | `versions.ts:190-191` |
| The stale comment | `versions.ts:184-189` **claims** the activated-set lock "still serializes against any OTHER version's concurrent activation" — the stress test disproved exactly this. T1 must correct the comment, not just the code | `versions.ts:184-189` |
| Approval subject fields | `subjectType` / `subjectId`, both `notNull` | `schema/approvals.ts:39-40` |
| `getApproval` | `(db: Db, approvalId: string) => Promise<ApprovalRow \| null>`; bare select, **no `FOR UPDATE`, runs outside the activation tx** (same shape as the `merge.ts` precedent — not changed by this plan) | `approvals/worklist.ts:84-87` |
| `toHttp` default | Any `TariffErrorCode` not in `NOT_FOUND_CODES`/`VALIDATION_CODES` and not `sod_drafter_activator` falls through to **409**. A new state-conflict code therefore needs **no** controller edit | `tariff.controller.ts:35-46` |
| Next migration | `0007_happy_tag` is last; journal idx 7. Next is **0008** | `drizzle/`, `drizzle/meta/_journal.json` |

**Baseline for every brief (§2.6): "the previous task's commit, i.e. current `origin/main`."** Never a fixed SHA.

---

## Tasks

Six tasks, **one pipeline, strictly sequential** — `versions.ts` is shared by T1/T3, `pricing.ts` by T2/T5, `tariff.e2e.test.ts` by T3/T6.

---

### Task 1: Serialize activation across DIFFERENT versions + migration 0008 *(opus coder)*

**The defect (CRITICAL, empirically reproduced).** `versions.ts:191`'s `select id from tariff_versions where status = 'activated' for update` locks **zero rows when no version has activated yet**, so two concurrent `activateVersion` calls on two *different* submitted versions each see an empty activated set, each pass their monotonicity check, and both commit. Reproduced with two raw `pg` sessions: v1 lands at Mar-1 and v2 (the newer revision) at Jan-1 — after which `resolveActiveTariffVersion` returns **v1 for every date after Mar-1**, so the new price is live for six weeks and then silently reverts to the stale one, permanently.

**Files:**
- Modify: `apps/core/src/kernel/db/schema/tariff.ts` (add `sql` import + one partial unique index)
- Create (generated): `apps/core/drizzle/0008_<name>.sql`, `apps/core/drizzle/meta/0008_snapshot.json`
- Modify (generated): `apps/core/drizzle/meta/_journal.json`
- Modify: `apps/core/src/modules/tariff/versions.ts`
- Modify: `apps/core/src/modules/tariff/versions.test.ts`

**Interfaces:** no signature changes. `resolveActiveTariffVersion` keeps its shape.

- [ ] **Step 1: Write the failing cross-version race test** in `versions.test.ts`. Build **two** independent submitted-and-approved versions (v1 and v2, each with ≥1 item, each with its own granted approval), then `Promise.allSettled([activateVersion(db, actorA, v1, MAR_1), activateVersion(db, actorB, v2, JAN_1)])`. Assert the **invariant**, not a specific loser code (§3.13): after the dust settles, `select * from tariff_versions where status = 'activated'` must contain rows whose `effectiveFrom` values are **strictly increasing with activation order** — concretely, it is never the case that two activated rows exist where the one with the **greater `versionNo`** has an **earlier or equal `effectiveFrom`**. Also assert `resolveActiveTariffVersion(db, 2026-06-01)` returns the **highest-numbered** activated version. Expected: FAIL before the fix (both activations succeed, v1 shadows v2).
- [ ] **Step 2: Run it to fail.** Isolate with `pnpm --filter @hmis/core exec jest --passWithNoTests versions.test -t "<name>"` and confirm the output shows other tests **skipped** (tripwire 19). Run it **five times** — a race test that fails only sometimes must be shown to fail reliably before it is trusted to pass reliably.
- [ ] **Step 3: Fix the lock.** Replace **both** statements at `versions.ts:190-191` with a **single** lock:

```ts
    // Serializes ANY two concurrent activations. The set is never empty — the version being
    // activated is itself 'submitted', so it is always a member — and `order by id` makes the
    // lock acquisition order deterministic across sessions, which is what prevents a deadlock.
    // The previous pair (target-row lock, then a lock on the 'activated' set) did NOT serialize
    // two DIFFERENT versions: with nothing yet activated the second statement locked zero rows.
    await tx.execute(
      sql`select id from tariff_versions where status in ('submitted','activated') order by id for update`,
    );
```

  **Do not** keep the old target-row lock alongside it. Taking the row lock first and the set lock second is a **deadlock**: session A holds v1 and waits for v2 while B holds v2 and waits for v1, and Postgres aborts one with `40P01`, which surfaces as an unhandled error rather than a clean `TariffError`. The single ordered set lock already covers the target row.

- [ ] **Step 4: Add the deterministic resolution tiebreak.** In `resolveActiveTariffVersion`, change the ordering to `.orderBy(desc(tariffVersions.effectiveFrom), desc(tariffVersions.activatedAt))`. Defense in depth: with T1's index in place a tie cannot occur, but an undefined ordering must not be the thing standing between two prices.
- [ ] **Step 5: Add the structural backstop.** In `schema/tariff.ts`, add `import { sql } from "drizzle-orm";` and append to the `tariffVersions` index list:

```ts
    // Two activated versions can never legitimately share an effective date — D5 requires
    // strictly-increasing effectiveFrom. The index IS that invariant, enforced by the database.
    uniqueIndex("tariff_versions_activated_effective_ux")
      .on(t.effectiveFrom)
      .where(sql`${t.status} = 'activated'`),
```

  This is the `workflow_definitions_one_active_ux` / `patient_merge_requests_pending_loser_ux` shape verbatim.

- [ ] **Step 6: Generate the migration** — `pnpm --filter @hmis/core db:generate`. Commit **all three** generator outputs (the `.sql`, `meta/0008_snapshot.json`, and the rewritten `meta/_journal.json` whose new last entry is idx 8). Never hand-edit the SQL.
- [ ] **Step 7: Add the tie backstop test** — two versions activated with the **same** `effectiveFrom` (bypassing the app check is not possible, so drive it through two concurrent activations with identical dates) must not both land: assert exactly one activated row, and that the loser's failure is surfaced rather than swallowed. If the loser surfaces a raw Postgres `23505` rather than a `TariffError`, that is acceptable and must be **stated in the report** — do not add error-mapping beyond this task's scope.
- [ ] **Step 8: Run the race tests 20 times each**, isolated per tripwire 19, capturing every exit code to a file under `/opt/hmis`. Quote all 20. Anything less than 20/20 clean is a failure.
- [ ] **Step 9:** `pnpm --filter @hmis/core test -- versions.test` → 1 suite, **11 tests** (9 existing + 2 new). Workspace → **68 suites / 362 tests**. Then a detached root `pnpm verify`, exit code read from a file.
- [ ] **Step 10: Commit** — `fix(core): serialize tariff activation across versions, migration 0008` → `git pull --rebase origin main` → `git push origin main` (three separate steps).

**Acceptance criteria:** the cross-version race test fails against the pre-fix code (fail-first quoted) and passes 20/20 after; the two lock statements are replaced by exactly one ordered `status in ('submitted','activated')` lock and the stale comment at `versions.ts:184-189` is corrected to describe what the code now actually does; migration 0008 exists with its snapshot and journal entry; the partial unique index matches the two shipped precedents; `resolveActiveTariffVersion` carries the `activatedAt` tiebreak; no deadlock (`40P01`) appears in any of the 20 runs; workspace at 68/362.

---

### Task 2: Regulated-price determinism + C-3 clamp integrity

**Two defects.** (a) CRITICAL: `services.ts:104` orders `regulated_prices` by `effectiveFrom DESC` with **no tie-break**. The table is append-only by design — a gazette correction *must* be a new row — and `effectiveFrom` is a calendar date, so "append the corrected row for the same gazette date" is the **normal correction path** and produces two rows with identical timestamps. Which wins is Postgres heap order: the engine can bill at the **superseded** ceiling while `regulatedClamp` records that the NPPA hard block was applied. (b) CRITICAL test gap: **no fixture anywhere has both `mrpPaise` and `ceilingPaise` below `tariffPaise`**, so changing `pricing.ts:31` to compare against `tariffPaise` instead of the running `unitPaise` passes every existing test — and on a drug where MRP < ceiling < tariff it **bills at the ceiling when the MRP is lower**, i.e. above the printed MRP.

**Files:**
- Modify: `apps/core/src/modules/tariff/services.ts`, `services.test.ts`
- Modify: `apps/core/src/modules/tariff/pricing.ts`, `pricing.test.ts`
- Modify: `apps/core/src/modules/tariff/tariff.controller.ts` (the regulated-prices list route's ordering only)
- Modify: `apps/core/src/modules/tariff/golden/fixtures/g05-regulated-min.json`

- [ ] **Step 1: Failing determinism test** — in `services.test.ts`, append **two** `regulated_prices` rows for one service with a **byte-identical `effectiveFrom`**, the second carrying the corrected (lower) ceiling. Assert `resolveRegulatedPrices(db, at)` returns the **last-inserted** row's bounds. Run it several times; before the fix it is order-dependent.
- [ ] **Step 2: Failing clamp test.** Add a fourth regulated service to `pricing.test.ts`'s fixtures — **`svc-drug-e`: tariff `20000`, mrp `10000`, ceiling `15000`** — and assert the full `PricedLine`: `unitPaise 10000`, `regulatedClamp.boundApplied "mrp"`.
  **Hand-derived (this is the Book entry for it):** `min(20000, 10000, 15000) = 10000` → clamp `mrp`; pharmacy 12% → `head = divHalfUp(10000 × 1200, 20000) = divHalfUp(12,000,000, 20000) = 600`; `net = 10000 + 600 + 600 = 11200`.
  **Kills:** the `b.value < tariffPaise` mutant, which selects the **ceiling** (15000) here and yields `unitPaise 15000`, `boundApplied "ceiling"`, `net 16800` — three fields different. Also kills a swapped `bounds.push` order.
- [ ] **Step 3: Run both to fail. Step 4: fix `services.ts`** — `.orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.id))`. Ids are ULIDs, so lexicographic descending is last-inserted-wins and deterministic. Apply the **same** ordering to the list route in `tariff.controller.ts` (it displays the same unstable order).
- [ ] **Step 5: Close the null-bounds hole in `pricing.ts`.** A `regulatedPrices` row that exists with **both** bounds `null` currently yields an empty `bounds` array, no clamp and no error — the C-3 hard block silently no-ops and the line prices at tariff with `regulatedClamp: null`. Treat it as `regulated_price_missing`, the same as an absent row:

```ts
    if (rp.mrpPaise === null && rp.ceilingPaise === null) {
      throw new TariffError("regulated_price_missing", `line ${line.lineId}: ${line.serviceId} has a regulated_prices row with no MRP and no ceiling`);
    }
```

  Note the guard must be `=== null` on both, never a falsy check — a bound of `0` paise is legal.
- [ ] **Step 6: Add the same case to the golden suite.** Add `svc-drug-e` to **CONFIG_A inside `g05-regulated-min.json` only** (services, tariff items, regulatedPrices) and a fourth line `L4` with the expected `PricedLine` and a `workings` string reproducing Step 2's arithmetic. **The fixture count stays 13** — g05 gains a line, not a new file.
- [ ] **Step 7:** `pnpm --filter @hmis/core test -- "modules/tariff"`; `pnpm --filter @hmis/core test` → **68 suites / 364 tests** (+2 from this task). Detached root `pnpm verify`.
- [ ] **Step 8: Commit** — `fix(core): deterministic regulated-price resolution, C-3 clamp coverage` → pull --rebase → push.

**Acceptance criteria:** the same-`effectiveFrom` test returns the corrected row deterministically and is run at least 5 times; `g05` and `pricing.test.ts` both carry the MRP<ceiling<tariff case and the reviewer confirms by hand that the `b.value < tariffPaise` mutant would produce `unitPaise 15000` and fail; the null-bounds guard uses `=== null` on both bounds; the controller list route shares the resolver's ordering; fixture count still 13; workspace 68/364.

---

### Task 3: SoD completeness + approval subject binding

**Two defects.** (a) CRITICAL test gap: **every SoD test makes drafter and submitter the same person**, so `|| actor.id === version.submittedBy` (`versions.ts:176`) can be deleted with everything still green — a supervisor who submits someone else's draft could then activate it. (b) MODERATE: `activateVersion` reads `getApproval(db, version.approvalId)` and checks only `status`; it never verifies the approval's `subjectType`/`subjectId` actually match this version. Not exploitable today (`versions.ts:136` is the only writer of that column and always writes an approval it just created for this version), but it is a trust-the-invariant design with no structural defense.

**Files:**
- Modify: `apps/core/src/modules/tariff/errors.ts` (one new code)
- Modify: `apps/core/src/modules/tariff/versions.ts`, `versions.test.ts`
- Modify: `apps/core/test/tariff.e2e.test.ts`

- [ ] **Step 1: Failing SoD test.** Add a test where the drafter and submitter are **distinct**: `createDraftVersion` as `drafter`, `setTariffItem` as `drafter`, `submitVersion` as a separate `submitter` actor, approve, then assert `activateVersion(db, submitter, …)` throws `sod_drafter_activator` — **and** that a third eligible actor then succeeds on the same version. The success afterwards is the discriminator: it proves the refusal came from SoD and not from any other state.
- [ ] **Step 2: Failing subject-binding test.** Create version A and version B, each submitted with its own approval. Grant B's approval. Then, by direct `db.update` on `tariff_versions` (the test may reach for raw SQL here precisely because no application path can produce this state), point **A's** `approvalId` at **B's** granted approval and attempt `activateVersion` on A. Expected: `approval_subject_mismatch`, not a successful activation.
- [ ] **Step 3: Run to fail. Step 4: implement.** Add `"approval_subject_mismatch"` to the `TariffErrorCode` union in `errors.ts`. In `activateVersion`, immediately after loading the approval and before the status check:

```ts
  if (approval.subjectType !== "tariff_version" || approval.subjectId !== versionId) {
    throw new TariffError(
      "approval_subject_mismatch",
      `approval ${version.approvalId} is for ${approval.subjectType} ${approval.subjectId}, not tariff_version ${versionId}`,
    );
  }
```

  **No controller change is needed:** `toHttp`'s fallthrough maps any unlisted code to 409, which is the correct status for a state conflict. Do not add the code to `NOT_FOUND_CODES` or `VALIDATION_CODES`.
- [ ] **Step 5: Add the HTTP-level SoD case** to `tariff.e2e.test.ts`'s existing SoD test: the submitter (distinct from the drafter, and explicitly granted `tariff.versions.activate` so the refusal cannot come from the permission guard) is refused **403** with `sod_drafter_activator` in the body, and a different eligible user then succeeds. **Extend the existing test — do not add a new block.** The suite stays at 6 tests.
- [ ] **Step 6:** `pnpm --filter @hmis/core test -- versions.test` → 1 suite, **13 tests**; `test -- tariff.e2e` → 1 suite, 6 tests; workspace → **68 suites / 366 tests**.
- [ ] **Step 7: Commit** — `fix(core): SoD submitter coverage + approval subject binding` → pull --rebase → push.

**Acceptance criteria:** a test exists in which drafter ≠ submitter and the **submitter** is refused activation, followed by a third actor succeeding; `approval_subject_mismatch` is in the closed union and thrown before the status check; the reviewer confirms deleting `|| actor.id === version.submittedBy` now fails a test; no controller edit was made; workspace 68/366.

---

### Task 4: Make the D-17 gate tell the truth

**The defect (CRITICAL in effect).** `validateTariffConfig` builds its manual-caps map from `listAdjustmentRules(db)` — **every row in the table**. The engine builds its map from `loadRuleConfig(db, at)`, which filters `active = true` and the `validFrom`/`validTo` window. Deactivate a cap row, or simply let its `validTo` pass, and the gate still sees it, reports `ok: true`, and `validate:tariff` exits 0 — while at the counter `ctx.manualCaps["charity"]` is `undefined`, so **every charity waiver is rejected `unknown_category`** and the patient is billed full price. The gate's one stated job is "all four D-8 categories have caps," and it is checking the wrong set of rows.

Three supporting gaps ride along: no test ever sets `active: false` (so removing `loadRuleConfig`'s `.where(eq(active, true))` is undetected); the `validFrom` guard at `rules.ts:124` is never reached by any test (both query dates in the only validity test are after `validFrom`, so deleting the line — making a campaign discount live a month early — is undetected); and duplicate cap rows for one category resolve last-write-wins from an unordered select.

**Files:**
- Modify: `apps/core/src/modules/tariff/context.ts`, `context.test.ts`
- Modify: `apps/core/src/modules/tariff/rules.ts`, `rules.test.ts`
- Modify: `apps/core/src/modules/tariff/gst-config.test.ts`

- [ ] **Step 1: Failing gate test** — in `context.test.ts`, seed a fully valid config, assert `{ ok: true }`, then set the `charity` cap row `active: false` and assert the report is now `ok: false` carrying `manual_caps_missing` for `charity`. Add the mirror case with a `validTo` in the past.
- [ ] **Step 2: Failing rules tests** — in `rules.test.ts`: (a) a rule with `active: false` is absent from `loadRuleConfig(...).rules` while still present in `listAdjustmentRules(db)`; (b) the **validity boundary trio** on one fixture (`validFrom 2026-01-01`, `validTo 2026-06-30T23:59:59`): at `2025-12-31` excluded, at exactly `2026-01-01` **included**, at exactly `2026-06-30T23:59:59` **included**. The `2025-12-31` case is what kills a deleted `validFrom` guard; the two equality cases pin the stated "equal is included" convention.
- [ ] **Step 3: Failing duplicate-cap test** — two active `manual` rows both declaring `discountCategory: "charity"` with different `maxBps`. Assert `validateTariffConfig` reports a `duplicate_manual_cap` error rather than silently picking one.
- [ ] **Step 4: Failing upsert-UPDATE tests** — neither `upsertAdjustmentRule` nor `upsertGstCategory` has ever had its `onConflictDoUpdate` branch executed: every test upserts each key exactly once after a truncate. Replacing both with a plain `.insert()` passes the entire suite today, and in production the CA raising a GST rate gets a raw `23505`. In `rules.test.ts` and `gst-config.test.ts`, upsert the same key **twice** with a changed value and assert the row count stays 1, the value changed, and `updatedBy` moved to the second actor.
- [ ] **Step 5: Run all to fail. Step 6: implement.**
  - `context.ts`: build the caps map from `loadRuleConfig(db, at)` — the same function the engine uses — instead of from raw `listAdjustmentRules` rows. Add `duplicate_manual_cap` as a `ConfigError.code` (it is a plain `string`, so no union edit).
  - `rules.ts`: add `.orderBy(adjustmentRules.ruleKey)` to `loadRuleConfig`'s select so a duplicate resolves deterministically even where the validator permits it.
  - **`validateTariffConfig` must still never throw** — it accumulates. Preserve that.
- [ ] **Step 7:** `test -- context.test` → 1 suite, **8 tests**; `test -- rules.test` → 1 suite, **8 tests**; `test -- gst-config.test` → 1 suite, **5 tests**; workspace → **68 suites / 372 tests**.
- [ ] **Step 8: Commit** — `fix(core): D-17 gate reads the engine's rule set, not the raw table` → pull --rebase → push.

**Acceptance criteria:** deactivating a cap row makes `validateTariffConfig` report `ok: false`; the validity trio pins both boundaries **and** the pre-`validFrom` exclusion; a duplicate cap is reported rather than silently resolved; both upsert UPDATE paths are exercised with an asserted value change; `validateTariffConfig` still never throws on any broken config; workspace 68/372.

---

### Task 5: Contest audit record + money guards *(opus coder)*

**Four defects, all in the adjustment path.** (a) `contest.ts:31` clamps to gross **before** recording a rejection, so a ₹600 ask against a ₹500 line is recorded as ₹500 — while `types.ts:27` specifies "the amount that was ASKED (audit)". The money is right; the D-8 defensibility record an over-discount investigation reads is wrong. (b) `g09` is vacuous on exactly this property (see "The fixture lesson"). (c) `manualDiscount.value` is the one money input never passed through `assertPaise`: a `flat_paise` value of `1250.5` flows through `Math.min` into `discountPaise`, and because `.5`-paise bases times even `rateBps` yield integral products, `divHalfUp`'s safe-integer guard does not fire — producing a fractional-paise `netPaise` headed for a `bigint` column. The shipped HTTP boundary is safe (`z.number().int()`); the exposed caller is a direct programmatic import, i.e. **Plan 08**. (d) `discountPaise ≤ grossPaise` is a contract, not an enforced invariant — both shipped sources honour it, but `ctx.sources` is an open plugin array and Plan 09 registers two more.

**Files:**
- Modify: `apps/core/src/modules/tariff/contest.ts`, `contest.test.ts`
- Modify: `apps/core/src/modules/tariff/pricing.ts`, `pricing.test.ts`
- Modify: `apps/core/src/modules/tariff/types.ts` (one doc comment, decision 3)
- Modify: `apps/core/src/modules/tariff/golden/fixtures/g09-manual-over-cap.json`

- [ ] **Step 1: Failing audit-record test.** Gross `50000`, manual `{ charity, flat_paise 60000, "full waiver" }`, caps `charity { maxBps 2500, approvalAboveBps 1000 }`. Assert `amountPaise: 60000` (the **asked** amount) and `rejected.code: "over_cap"`, and that `detail` names 60000 rather than 50000. **Kills** the clamp-then-record implementation, which reports 50000.
- [ ] **Step 2: Fix `g09` to discriminate.** Change its manual discount from `percent_bps 2500` to **`flat_paise 60000`** and update the expectation to `amountPaise: 60000`, `rejected.code "over_cap"`, `discountPaise 0`, `winner null`, `candidates.length 1`, `net 50000`.
  **Hand-derived:** ask `60000`; cap check `60000 × 10000 = 600,000,000 > 2500 × 50000 = 125,000,000` → rejected `over_cap`; no valid candidate → `discount 0`, `taxableBase 50000`; consultation is `exempt` → heads `0/0`; **net 50000**. Update the `workings` string to carry this arithmetic. The count stays 13.
- [ ] **Step 3: Failing exact-rational test.** The current "exact rational compare" test uses `5000/50000` at `1000 bps`, where the naive float form `(amount/gross)*10000 > bps` gives **exactly** `1000` too — both policies agree, so it proves nothing. Use the discriminating triple **amount `7`, gross `100`, `approvalAboveBps 700`**: exact says `7 × 10000 = 70000 > 700 × 100 = 70000` → **false**; float says `(7/100)*10000 = 700.0000000000001 > 700` → **true**. Assert `requiresApproval === false`. Mirror the same triple at the `over_cap` gate, where a float comparison would spuriously reject a legitimate discount.
- [ ] **Step 4: Failing ruleKey tie-break test.** The existing test is shadowed by `standingRuleSource`'s own pre-sort (`contest.ts:10`), so deleting `runContest`'s whole nulls-last + ruleKey block still passes. Drive `runContest` with a **stub `AdjustmentSource`** whose `propose` returns `[{ruleKey:"R-ZZZ"}, {ruleKey:"R-AAA"}]` **in that order** at equal `amountPaise`, and assert the winner is `R-AAA`. This is also the only way to reach those lines at all.
- [ ] **Step 5: Failing zero-amount test.** A rule at `1 bps` on gross `4` gives `divHalfUp(4, 10000) = 0`. Assert the candidate **is recorded** in `candidates` but `winner` is `null` — dropping `&& c.amountPaise > 0` from the filter would otherwise put a zero-benefit discount line on an invoice.
- [ ] **Step 6: Run all to fail. Step 7: implement.**
  - `contest.ts`: compute `const asked = raw;` and use `asked` for both `amountPaise` and `detail` on the **rejected** branches; keep the clamped `amount` only on the accepted branch. Add `assertPaise(md.value, "manualDiscount.value")` before computing `raw`. Reject a duplicate `sourceKey` in `ctx.sources` (a duplicate silently inverts the D3 tie-break precedence, because `order.set` is last-wins).
  - `pricing.ts`: `const discountPaise = Math.min(winner?.amountPaise ?? 0, grossPaise);` and `assertPaise(taxableBasePaise, "taxable base");` — enforcing the D2 contract in the engine rather than trusting a plugin, before Plan 09's sources arrive.
  - `types.ts`: document decision 3 on `ManualDiscountInput` — *"`flat_paise` is a WHOLE-LINE amount, never per-unit (owner decision 2026-08-14). Partial refunds of a flat-discounted line are the billing layer's rule."*
- [ ] **Step 8:** `test -- contest.test` → 1 suite, **14 tests**; `test -- golden` → 1 suite, 15 tests (count unchanged at 13 fixtures); workspace → **68 suites / 376 tests**. Detached root `pnpm verify`.
- [ ] **Step 9: Commit** — `fix(core): record the asked discount amount, guard manual discount paise` → pull --rebase → push.

**Acceptance criteria:** an over-gross ask is recorded at the asked amount in both `amountPaise` and `detail`; `g09` now uses `flat_paise 60000` and the reviewer re-derives its net of 50000 by hand from the Book entry above and confirms the clamping implementation would fail it; the exact-rational test uses the 7/100/700 triple and the reviewer confirms the float form gives the opposite answer; the ruleKey tie-break is driven by a stub source, not by `standingRuleSource`; `assertPaise` covers `manualDiscount.value` and `taxableBasePaise`; purity greps still pass on all six pure files; workspace 68/376.

---

### Task 6: Route coverage, harness manifest, composite precedence

**Three gaps.** (a) **Eight controller routes have zero test coverage**, including `POST /tariff/services/:id/regulated-prices` — the **only** way C-3 gazette data enters the system, and the very data Task 2's clamp integrity depends on. (b) `golden.test.ts:14` pins a fixture **count**, not a manifest: replacing `g13` with a renamed copy of `g01` keeps it green. (c) No test bills a category-exempt service as `composite_healthcare`, so swapping `gst.ts`'s first two branches is undetected — both give zero heads, only `exemptReason` differs, which is the audit trail.

**Files:**
- Modify: `apps/core/test/tariff.e2e.test.ts`
- Modify: `apps/core/src/modules/tariff/gst.test.ts`
- Modify: `apps/core/src/modules/tariff/golden.test.ts`

- [ ] **Step 1: Cover the eight routes** in `tariff.e2e.test.ts` as **one new test block** named for what it proves (`"every declared route is reachable and returns its documented shape"`), exercising: `PATCH /tariff/services/:id`, `POST` and `GET /tariff/services/:id/regulated-prices`, `GET /tariff/versions`, `GET` and `POST /tariff/rules`, `GET /tariff/gst`, `PUT /tariff/gst/config/:category`, and the **success** path of `PUT /tariff/gst/settings` (currently only asserted as a 403). Assert response shapes, not just status codes. The gazette-ingestion round trip (`POST` then `GET`) must assert the stored bounds come back.
- [ ] **Step 2: Replace the count with a manifest** in `golden.test.ts`: assert the sorted `files` array deep-equals the literal list of all 13 fixture names. A count cannot detect a renamed or duplicated fixture; a manifest can. Keep the "empty dir must never pass vacuously" intent in the test name.
- [ ] **Step 3: Add the composite-precedence test** to `gst.test.ts`: a **category-exempt** service (consultation, `exempt: true`, would-be `rateBps 1800`) billed with `supplyContext: "composite_healthcare"` must report `exemptReason: "composite_healthcare"`, not `"category_exempt"`. Both orderings give `cgst/sgst = 0`, so the assertion must be on `exemptReason` — the observable that actually distinguishes them.
- [ ] **Step 4:** `test -- tariff.e2e` → 1 suite, **7 tests**; `test -- gst.test` → 1 suite, **8 tests**; `test -- golden` → 1 suite, 15 tests; workspace → **68 suites / 379 tests**. Detached root `pnpm verify` — `packages/contracts` 3/7 and `apps/web` 11/37 unchanged.
- [ ] **Step 5: Commit** — `test(core): cover the eight untested tariff routes, pin the golden manifest` → pull --rebase → push.

**Acceptance criteria:** all 17 routes are now exercised by at least one test, and the reviewer confirms by enumerating route strings against the test file; the gazette round trip asserts stored values, not just a 201; `golden.test.ts` asserts a literal 13-name manifest; the composite-precedence test asserts `exemptReason` rather than the zero heads; workspace 68/379.

---

## Self-Review Notes

**Findings deliberately NOT fixed in this plan**, with reasons:
- **Drafter-as-approver** (owner decision 2) — accepted v1 risk; resolves as workflow-definition data when senior staff arrive.
- **Integer-overflow headroom** (owner decision 6) — ~₹4.5 × 10⁹ per line is ample.
- **`listRegulatedPrices(db, serviceId)` accessor** — the controller queries the table directly (Plan 06 gate report §5.2). Task 2 touches the ordering of that query but does not restructure it; the accessor belongs to a task that owns `services.ts`'s public surface.
- **Error-code prefixes in HTTP bodies** — ratified by the owner as the contract, not a defect.
- **Invoice-level totalling, GSTR-1 rate-wise grouping, `rounding_paise`** — Plan 08's scope by design.
- **The five dead branches** the audit enumerated (`contest.ts:8`, `simulation.ts:47`, and three in `versions.ts`) — unreachable by construction; adding tests for them would be testing the type system.

**Verify-by-execution flags (§3.4 — each named, each owned):**
- ① The single ordered `status in (…)` lock does not deadlock — T1 Step 8, 20 isolated runs.
- ② drizzle-kit emits the partial `WHERE` for migration 0008 — T1 Step 6; precedented in 0004 and 0006 but must be read in the generated SQL.
- ③ The cross-version race test genuinely **fails first** — T1 Step 2, five runs before the fix.
- ④ ULID descending really is last-inserted-wins for same-timestamp rows — T2 Step 1, several runs.
- ⑤ The `b.value < tariffPaise` mutant is killed by the new drug-e case — T2, gate re-derives by hand.
- ⑥ Deleting `|| actor.id === version.submittedBy` now fails a test — T3 acceptance, gate verifies.
- ⑦ `toHttp`'s 409 fallthrough covers `approval_subject_mismatch` with no controller edit — T3 Step 4.
- ⑧ `validateTariffConfig` still never throws after switching to `loadRuleConfig` — T4 Step 6.
- ⑨ The 7/100/700 triple really does separate exact from float — T5 Step 3, arithmetic shown above.
- ⑩ `assertPaise` on `manualDiscount.value` does not break any existing fixture — T5 Step 8.

**Deviations NOT to fix (paste into every brief):** everything in gate reports 01–06 §4/§5, **including** the `code: message` HTTP prefix (owner-ratified) and the controller's direct `regulatedPrices` query; **plus `qr.test.ts`'s 1-in-4096 tamper-payload flake — not this plan's file; leave it.**

**Test-count ladder** (per-workspace, `apps/core`): 360 → T1 **362** → T2 **364** → T3 **366** → T4 **372** → T5 **376** → T6 **379**. Suites stay at **68** throughout — every task extends an existing suite; no task adds a file that jest collects as a new suite.

---

## Pipeline Notes (for /execute compilation — do not execute without owner approval)

- **One pipeline, T1–T6, strictly sequential.** `versions.ts` is shared by T1/T3, `pricing.ts` by T2/T5, `tariff.e2e.test.ts` by T3/T6, `golden.test.ts` by T2/T5/T6 (fixture edits) and T6 (manifest).
- **Tier map:** sonnet coders with **opus overrides on T1 (concurrency + migration) and T5 (money semantics)**; **opus gate on every task**.
- **Cost calibration:** six tasks at the Plan 06 observed clean-task rate of 130–200k including gate ⇒ **~1.0–1.2M subagent tokens**, plus an explicit **infrastructure contingency** — Plan 06's stalls and one network outage cost ~554k, which the estimate must stop pretending is rare (ledger, Plan 06 totals).
- **Frozen paths while the pipeline runs:** `apps/web/**`, `packages/contracts/**`, `apps/core/src/modules/patients/**`, `.github/workflows/**`, all of `apps/core/src/kernel/**` EXCEPT `schema/tariff.ts` (T1 only), `apps/core/package.json`, `README.md`, `apps/core/src/app.module.ts`, `apps/core/src/modules/tariff/index.ts` (frozen — this plan changes no export), `drizzle/**` (T1 only).
- **Migration rule:** exactly one migration (T1, `0008`). Any later schema need = chain halt + plan-defect report.
- **Compile rules (from EXECUTION-LESSONS):** §1 tripwires **including the new 19** verbatim at the TOP of every brief · briefs point at this committed plan, never restate its code · baseline = "previous task's commit" (§2.6) · per-suite counts, narrowing regexes checked against the task's own later files (§2.5) · FINISH = three numbered steps (§3.8) · gate verdicts carry `retry_mode` (§2.2) · no correction may direct a history rewrite (tripwire 15) or security-code removal (tripwire 14) · deviations-not-to-fix list in every brief · **after any infrastructure halt, check whether the dead agent committed or pushed before resuming, and convert the task to a verify-only rung if it did** (Plan 06 §7.4).
- **Every fixture or assertion this plan adds must pass BOTH audits**: hand-derived from this document, **and** demonstrated to kill the named wrong implementation. That is the Plan 06 lesson and it is this plan's reason to exist.
