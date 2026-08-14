# Plan 06.1 — Tariff Hardening · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**STATUS: WRITTEN 2026-08-14, awaiting owner approval. PLANNING ONLY — no execution has occurred.**

**Goal:** Close the four CRITICAL and the actionable MODERATE/MINOR findings of the 2026-08-14 post-ship adversarial stress test over the shipped tariff module (`reports/plan-06-stress-test-findings.md`) — before Plan 07 or 08 is authored against this surface. Two of the criticals bill or record wrong money today (C1 concurrent cross-version activation, C2 nondeterministic NPPA ceiling); two leave correct code deletable without a red test (C3 both-bounds clamp, C4 SoD submitter clause).

**Architecture:** No new surfaces, no new module, no moved contract. Seven strictly-sequential hardening tasks inside `apps/core/src/modules/tariff/` + one schema backstop: replace the activation serializer with a single ordered set lock (+ a partial unique index as the database-layer invariant), add a deterministic tie-break to regulated-price resolution, make rejected discount candidates record the asked amount, point the D-17 gate at the engine's own rule loader, and give every one of those changes a test that a named wrong implementation fails.

**Tech Stack:** Existing only — TypeScript strict + `noUncheckedIndexedAccess`, NestJS ^11, drizzle-orm 0.40.1 / drizzle-kit 0.30.6, zod ^4, pg, Jest + ts-jest. **Zero new dependencies, zero env vars, zero CI changes, zero new event names.**

**Input evidence:** `docs/superpowers/plans/reports/plan-06-stress-test-findings.md` (four read-only audit agents, ~613k tokens, against `207a95e`–`6483c2d`). Its §13 SOUND list is not re-litigated here; its enumerated dead branches get **no** tests, per its own instruction.

---

## Global Constraints

- Money is integer **PAISE**, always. No floats anywhere in pricing; **no `z.coerce` anywhere in this module** (ledger §3.19).
- `money.ts`, `types.ts`, `contest.ts`, `gst.ts`, `pricing.ts`, `simulation.ts` stay **PURE and SYNCHRONOUS**: no `await`, no import from `kernel/`, no `new Date(`, no `Math.random`. T4 touches three of these files; the purity greps must still pass.
- **Exactly ONE migration** — `0008_*`, generated in Task 1 by `pnpm --filter @hmis/core db:generate`, never hand-edited. A schema need discovered in any later task is a **plan defect to report, not to fix**.
- **`modules/tariff/index.ts` is FROZEN — byte-untouched.** This plan adds no export and removes none; Plan 08's contract does not move. T2 adds one member to the `TariffErrorCode` union inside `errors.ts` (the union `index.ts` already re-exports as a type — the realizable code set is documented as OPEN, gate report §5.4, and `toHttp`'s fallthrough maps any unlisted code to 409, so no consumer or controller moves). T3's new `listRegulatedPrices` is exported from `services.ts` and imported by the controller **within the module** — it is deliberately NOT added to `index.ts`.
- `packages/contracts` and `apps/web` **byte-untouched**; `modules/patients` read-only; **`apps/core/src/modules/patients/qr.test.ts` untouched** — its 1-in-4096 tamper flake is a deliberately carried open item owned by a future task.
- Also untouched this plan: `app.module.ts`, `apps/core/package.json`, `README.md`, `test/helpers/db.ts` (no new table ⇒ no truncate change), `simulation.ts`, `simulation.test.ts`, `tariff-lifecycle.e2e.test.ts`, `scripts/*`, `manifest.ts`, `tariff.module.ts`, `events.ts`, `money.ts`, `fixture-schema.ts`.
- Events: the module's catalog stays exactly `tariff.revision_applied` and `config.validated`. New `ConfigError` string codes (`duplicate_manual_cap`) are report entries, not events.
- Approver roles and thresholds remain **workflow-definition DATA** (owner decision 2, binding here and in Plan 08). This plan adds no approver-role logic and hard-codes no role.
- Baseline for every task: **the previous task's commit, i.e. current `origin/main`** (ledger §2.6 — never a fixed SHA). Per-workspace baseline entering this plan: `apps/core` **68 suites / 360 tests**; `packages/contracts` 3/7 and `apps/web` 11/37 are untouched throughout.

---

## The rule this plan exists to enforce: TWO audits per assertion, not one

Plan 06 was built around the §3.14 rule — *no fixture where both the right and a wrong implementation produce the same observable* — and its fixture `g09-manual-over-cap.json`, the one **named** for "records the amount that was ASKED… never clamped", violates it: its ask is `percent_bps 2500` of gross 50000 = 12500, which is **below** gross, so `Math.min(raw, gross)` is a no-op and the clamping implementation it exists to kill passes it byte-identically. Every expected value in Plan 06 was hand-derived and both gates re-derived samples — and this still shipped, because **hand-derivation proves a fixture is not circular; it does NOT prove it is discriminating. Those are two separate audits, and Plan 06 ran only the first.**

Binding rule for this plan, checkable by the gate on every task:

1. **Derivation audit:** every expected value added or changed is hand-computed in this document from D1–D7's rules — never produced by running the engine.
2. **Discrimination audit:** every fixture and assertion added or changed **names the wrong implementation it kills**, in this document, with the wrong implementation's differing observable computed by hand. Where an assertion pins a convention that a wrong implementation could still satisfy by accident (heap order in a fresh table), this document says so honestly and names the load-bearing defense instead.

The consolidated kill table is in §"Assertion Book" below; each task's steps carry the arithmetic inline.

---

## Owner decisions already made (2026-08-14, in-conversation) — build on these, do not re-litigate

1. **Hardening now**, before Plan 07 or 08 is authored.
2. **Drafter-as-approver: accepted as a v1 risk, not fixed in code.** The owner drafts prices and holds the sole `owner` approver role today; senior staff arrive later with TIERED discount approvals. Binding consequence: approver roles and thresholds stay workflow-definition **data** — in this plan and in Plan 08.
3. **`flat_paise` discounts are WHOLE-LINE, never per-unit.** Recorded as a doc comment on `ManualDiscountInput` in T4; partial-refund pro-ration is the billing layer's rule to state (Plan 08).
4. **The §170 rounding difference gets a dedicated `rounding_paise` column** on Plan 08's invoice table. Forward decision only — **no schema for it here**.
5. **Migration 0008 is authorised**, scoped by this plan to **one partial unique index** (T1). Partial unique indexes have two shipped precedents (`workflow_definitions_one_active_ux`, `patient_merge_requests_pending_loser_ux`) and drizzle-kit 0.30.6 emits their WHERE clauses correctly (verified in `drizzle/0004_white_hydra.sql:70` and `0006_faithful_ultron.sql:112`); CHECK constraints have **zero precedent** in this schema and are not introduced — the regulated-prices both-bounds-null hole closes in application code instead (T4).
6. **Integer-overflow headroom is accepted as-is** (≈ ₹4.5 × 10⁹ per line safe under the traced thresholds). No work.

**One decision this plan takes and flags for the owner at approval:** T2 adds the error code `approval_subject_mismatch` to the `TariffErrorCode` union. That *widens* the union (the approval-scope constraint blessed "narrowing"); `index.ts` stays byte-identical, the code set is ratified as open (gate report §5.4), and `toHttp` maps it to 409 with no controller edit. If the owner prefers no union change, the fallback is reusing `approval_not_granted` — say so at approval and T2 shrinks by one line; the default on approval of this plan as written is the new code.

---

## Findings disposition map

| Finding | Fixed in | How |
|---|---|---|
| **C1** concurrent cross-version activation | **T1** | single ordered set lock over `status IN ('submitted','activated')`; false comment corrected; partial unique index `(effective_from) WHERE status='activated'` as the DB-layer backstop (migration 0008); equal-date cross-version race test |
| **C2** NPPA ceiling nondeterministic on same-date rows | **T3** | `orderBy(desc(effectiveFrom), desc(id))` — ULIDs make descending id last-inserted-wins; both call sites (resolver + list route, the latter via the new accessor) |
| **C3** both-bounds clamp untested; mutant bills above MRP | **T6** | new golden fixture `g14` with `mrp < ceiling < tariff` (the executed mutant's kill case) |
| **C4** SoD submitter clause deletable | **T2** | drafter ≠ submitter test: the SUBMITTER is refused, a third actor succeeds |
| **M1** D-17 gate checks rows the engine never loads | **T5** | caps map built from `loadRuleConfig(db, at)` — the engine's own loader; inactive/expired-cap regression tests |
| **M2** rejections record the clamped amount; g09 vacuous | **T4** (code) + **T6** (fixture) | rejected branches record and check the ASKED amount; g09 rewritten to `flat_paise 60000` |
| **M3** `manualDiscount.value` unasserted; fractional paise reach net | **T4** | `assertPaise(md.value)` in the source; `assertPaise(taxableBasePaise)` belt in the engine |
| **M4** duplicate manual caps resolve nondeterministically | **T5** | `loadRuleConfig` ordered by id ASC (newest-wins, deterministic) + `duplicate_manual_cap` ConfigError at the gate |
| **M5** `validFrom` guard never reached | **T5** | boundary pair: before `validFrom` excluded, exactly at it included |
| **M6** ruleKey tie-break shadowed by source pre-sort | **T4** | stub unsorted source drives `runContest` directly |
| **M7** upsert UPDATE branches never executed | **T5** (unit, both) + **T7** (rules + gst-config over HTTP) | upsert-twice tests asserting one row + changed values |
| **M8** `active: false` never proven excluded | **T5** | retired rule absent from `loadRuleConfig`, present in `listAdjustmentRules` |
| **M9** eight uncovered routes | **T7** | two e2e blocks exercising all eight + the `PUT /tariff/gst/settings` success path, asserting round-trip state, not status codes |
| **M10** approval not verified against the version | **T2** | subjectType/subjectId check + `approval_subject_mismatch` |
| Findings §12.1 (`pricePaise: -1` two mechanisms) | **T7** | assert the zod issue shape — only the DTO produces it |
| §12.2 (`tariff_item_missing` two producers) | **T5** | Break-1 assertion pinned to the explicit check's distinct detail prefix |
| §12.3 (bare `rejects.toThrow()` ×3) | **T1** | `toMatchObject({ code: "23505" })` — drizzle-orm 0.40.1 propagates the raw pg error (verified in installed `node_modules`: no `DrizzleQueryError` exists in 0.40.1) |
| §12.4 (shallow freeze) | **T4** | deep-freeze + input-snapshot belt in the determinism test |
| §12.5 (category-exempt never billed composite) | **T4** | D4 decision-order test asserting `exemptReason` |
| §12.6 (zero-amount candidate) | **T4** | 1 bps on gross 4 → candidate recorded, winner null |
| §13 residual (fixture count is not a manifest) | **T6** | count assertion replaced by the literal sorted 14-name manifest |
| Gate report §5.2 open item (`listRegulatedPrices` accessor) | **T3** | accessor added; controller's direct table query moved behind it (carried-forward item, ledger §3.2 discipline) |
| *(new, found by this plan's Pass 1)* a regulated row with BOTH bounds null silently no-ops the C-3 clamp in the engine | **T4** | explicit `=== null`-pair guard → `regulated_price_missing`; write path already refuses this shape (`regulated_bounds_missing`), so this is defense in depth against bulk loads/data fixes |

**Deliberately NOT fixed, and why:**
- **M11 drafter-as-approver** — owner decision 2: accepted v1 risk; resolves as workflow-definition data when tiered approvers arrive.
- **Integer-overflow headroom** — owner decision 6.
- **`rounding_paise`, invoice totalling, GSTR-1 grouping, discount-override approval type, credit lines** (findings §14) — Plan 08's scope by design; §14 is an authoring input to Plan 08, not work here.
- **TCS, cess, reverse charge, B2B invoices** (findings §14 tail) — need an explicit owner ruling **at Plan 08 authoring**; carried in Pipeline Notes, no code here.
- **The enumerated dead/unreachable branches** (findings §12 tail) — the findings themselves forbid testing these.
- **An HTTP-layer drafter≠submitter SoD duplicate** — the deletable disjunct dies at unit level in T2; both disjuncts live in the same shipped statement exercised identically by both call paths, so an e2e duplicate adds cost and no discrimination. The existing e2e SoD wall (mechanism-attributed 403) already covers the HTTP claim.
- **The mrp == ceiling tie label** (which bound a swap of the two `bounds.push` lines would report when both bind at the same value) — D2 does not specify the label for an exact two-bound tie and no money moves on it; deliberately not pinned rather than invented.
- **`qr.test.ts`'s 1-in-4096 flake** — forbidden to this plan; owned by a future task on that file.
- **`code: message` HTTP prefix** — owner-ratified contract (gate report §5.1), not a defect.

---

## Consumed shipped surfaces (scout-verified against `/opt/hmis` source at `8e9f4a1`, this session)

Three read-only scouts transcribed every file this plan touches, byte-for-byte from the server — not from the findings document, not from memory. Facts the tasks depend on:

| Surface | Fact | Where |
|---|---|---|
| Activation locks (C1 target) | TWO statements: target-row lock, then `where status = 'activated' for update`; preceded by the comment falsely claiming the set lock "still serializes against any OTHER version's concurrent activation" | `versions.ts` inside `withTx`, comment + `tx.execute` pair |
| Monotonicity re-check | already excludes self: `and(eq(status,'activated'), ne(id, versionId))`; refuses on `r.effectiveFrom !== null && r.effectiveFrom >= effectiveFrom` | `versions.ts` |
| Same-version race loser | conditional UPDATE `where id = :id and status='submitted'` → 0 rows → `not_submitted`; existing race test asserts exactly this | `versions.ts`, `versions.test.ts` |
| `activateVersion` pre-checks | reads row + `getApproval(db, …)` OUTSIDE the tx (takes `Db`, manages its own `withTx`) — order: `unknown_version` → `not_submitted` → `approval_not_granted` → `approval_rejected` (+ belt UPDATE) → SoD → tx | `versions.ts` |
| `ApprovalRow` subject fields | `subjectType` / `subjectId` (`$inferSelect` of `approvals`; columns `subject_type`/`subject_id`) | `kernel/approvals/worklist.ts`, `schema/approvals.ts` |
| `TariffErrorCode` union | exactly 22 members today; `errors.ts` is a 14-line file | `errors.ts` |
| `toHttp` fallthrough | any `TariffError` not in `NOT_FOUND_CODES`/`VALIDATION_CODES` and not `sod_drafter_activator` → `ConflictException` (**409**); message is `` `${code}: ${message}` `` | `tariff.controller.ts` |
| DTO 400 shape | `parsed()` throws `BadRequestException(r.error.issues)` → response `message` is the zod **issues array** (domain errors are `code: message` strings) | `tariff.controller.ts` |
| Regulated resolution (C2 target) | `.orderBy(desc(effectiveFrom))` only; first-row-per-service reduction `if (row.serviceId in result) continue` | `services.ts` |
| Regulated list route (C2 second site) | controller queries the table directly, `desc(effectiveFrom)` only; `desc, eq` and the `regulatedPrices` schema import exist in the controller **solely** for this route | `tariff.controller.ts` |
| Write-path bounds guard | `appendRegulatedPrice` throws `regulated_bounds_missing` when both bounds absent; asserts paise on each | `services.ts` |
| Engine clamp (C3/null-hole target) | `bounds` built from non-null mrp then ceiling; `if (b.value < unitPaise)` running-min; both-null ⇒ empty array ⇒ **no clamp, no error** | `pricing.ts` |
| Manual source (M2/M3 target) | `raw` → `amount = Math.min(raw, gross)`; BOTH rejected branches record `amount`; over-cap check `amount * 10000 > maxBps * gross`; detail `` `${amount}p exceeds ${maxBps}bps of ${gross}p` `` | `contest.ts` |
| Contest tie-break (M6 target) | `valid.filter(rejected === null && amountPaise > 0)`; sort: amount desc → source order → ruleKey asc nulls-last; `standingRuleSource` pre-sorts its own rules by ruleKey | `contest.ts` |
| `loadRuleConfig` (M4/M5/M8 target) | `.where(eq(active, true))` with **no ORDER BY**; `validFrom > at → continue`, `validTo < at → continue`; manual rows assign caps last-write-wins | `rules.ts` |
| Param schemas | `ruleParamsSchema` (percent ≤ 10000 refine), `manualCapParamsSchema` (`maxBps` 0..10000, `approvalAboveBps` 0..10000 nullable) — both exported, both already imported by `context.ts` | `rules.ts` |
| `validateTariffConfig` (M1 target) | caps map built inside the `listAdjustmentRules(db)` loop (every row, no active/window filter); NEVER THROWS — Break 4 of the shipped test corrupts params and asserts accumulation | `context.ts`, `context.test.ts` |
| `loadRuleConfig` throws on corrupt params | `.parse()` by design (billing-time behaviour) — anything T5 adds around it must preserve validate's never-throws | `rules.ts`, `context.ts` smoke guard |
| Partial-index precedent syntax | `uniqueIndex("…").on(t.col).where(sql\`${t.status} = '…'\`)` with `import { sql } from "drizzle-orm"`; emitted SQL confirmed in migrations 0004 + 0006 | `schema/workflow.ts`, `schema/patients.ts`, `drizzle/*.sql` |
| `schema/tariff.ts` imports | pg-core only — **does not import `sql`**; T1 adds it | `schema/tariff.ts` |
| Migration journal | last entry idx **7** (`0007_happy_tag`) → the generator's next output is **0008** | `drizzle/meta/_journal.json` |
| pg error shape | drizzle-orm **0.40.1** exports only `DrizzleError`/`TransactionRollbackError` — **no `DrizzleQueryError`** (verified in the installed package on the server), so a unique violation surfaces as the raw pg `DatabaseError` with top-level `.code === "23505"` | `node_modules/.pnpm/drizzle-orm@0.40.1…/errors.js` |
| Test dialects | `versions.test.ts` and `tariff.e2e.test.ts` use `it(…)`; all other module tests use `test(…)`. Counts today: versions 9 · schema/tariff 3 · services 6 · pricing 8 · contest 15 · gst 7 · golden 15 runtime (13 fixtures + count + mutant) · rules 5 · gst-config 4 · context 6 · e2e 7 | transcriptions |
| e2e scaffolding | `mk(username)` user+token helper, `auth(token)` header helper, beforeEach seeds roles (`tariff_admin`/`tariff_drafter`/`reader`/`owner`), consultation+pharmacy GST config, settings, and the two-step `tariff_revision` type registration | `tariff.e2e.test.ts` |
| `gstCategoryBody` DTO | `sacCode`, `exempt`, `rateBps` required; `specialRule` and `thresholdPaise` **nullable but NOT optional** — PUT bodies must carry them explicitly (as `null` when unused) | `tariff.controller.ts` |
| Fixture harness | `files` = sorted `readdirSync` list; count test pins 13; fixtures embed CONFIG_A; expected `line` deep-equals the full `PricedLine`; `AdjustmentCandidate` = `{ sourceKey, ruleKey, kind, discountCategory, amountPaise, reason, requiresApproval, rejected }` | `golden.test.ts`, `fixture-schema.ts`, `types.ts` |

---

## File structure (all under `apps/core/` unless noted)

```
src/kernel/db/schema/tariff.ts        T1  +sql import, +1 partial unique index on tariff_versions
src/kernel/db/schema/tariff.test.ts   T1  +1 index test; 3 bare rejects.toThrow() tightened to 23505
drizzle/0008_<generated>.sql          T1  generated — the plan's ONLY migration
drizzle/meta/0008_snapshot.json       T1  generated (§3.16: the generator's FULL output set)
drizzle/meta/_journal.json            T1  rewritten by the generator
src/modules/tariff/versions.ts        T1  serializer replaced + comment corrected · T2 subject check
src/modules/tariff/versions.test.ts   T1  +1 cross-version race · T2 +2 (SoD submitter, subject mismatch)
src/modules/tariff/errors.ts          T2  +1 union member: approval_subject_mismatch
src/modules/tariff/services.ts        T3  resolve tie-break; +listRegulatedPrices; +RegulatedPriceRow type
src/modules/tariff/services.test.ts   T3  +2 (same-date correction; history ordering/scoping)
src/modules/tariff/tariff.controller.ts T3  regulated-prices GET moved behind the accessor; imports pruned
src/modules/tariff/contest.ts         T4  assertPaise(md.value); rejected branches record + check RAW
src/modules/tariff/pricing.ts         T4  both-bounds-null guard; assertPaise(taxableBasePaise) belt
src/modules/tariff/types.ts           T4  doc comment only: flat_paise is WHOLE-LINE (owner decision 3)
src/modules/tariff/contest.test.ts    T4  +4 (asked-amount flat, fractional value, stub tie-break, zero-amount)
src/modules/tariff/pricing.test.ts    T4  +2 (null-bounds, rogue-source belt); determinism test deep-frozen
src/modules/tariff/gst.test.ts        T4  +1 (composite outranks category exemption — D4 order)
src/modules/tariff/rules.ts           T5  loadRuleConfig ordered by id ASC (deterministic newest-wins)
src/modules/tariff/rules.test.ts      T5  +4 (validFrom pair, active:false, upsert-update, duplicate caps)
src/modules/tariff/gst-config.test.ts T5  +1 (upsertGstCategory update branch)
src/modules/tariff/context.ts         T5  gate caps from loadRuleConfig; duplicate_manual_cap detection
src/modules/tariff/context.test.ts    T5  +2 (gate-truth, duplicate cap); Break-1 assertion single-sourced
src/modules/tariff/golden/fixtures/g09-manual-over-cap.json      T6  rewritten: flat_paise 60000
src/modules/tariff/golden/fixtures/g14-regulated-both-bounds.json T6  NEW — the C3 kill case
src/modules/tariff/golden.test.ts     T6  count assertion replaced by the literal 14-name manifest
test/tariff.e2e.test.ts               T7  +2 route-coverage blocks; -1 leg gains the zod-issue assertion
```

No new test FILES anywhere (`g14` is a fixture, not a suite) ⇒ `apps/core` stays at **68 suites** for the whole plan.

---

## Tasks

Seven tasks, two pipelines: **A = T1–T4**, **B = T5–T7** (roadmap rule: ≤ 6 tasks per Workflow). **Strictly sequential** — `versions.ts`/`versions.test.ts` are shared by T1/T2, T6's rewritten g09 asserts behaviour T4 ships, T7's history-ordering assertion depends on T3's accessor.

---

### Task 1: Serialize activation across DIFFERENT versions + migration 0008  *(opus coder)*

**The defect (C1, CRITICAL, empirically reproduced by the stress test):** the shipped serializer is a target-row lock plus `select id from tariff_versions where status = 'activated' for update`. The set lock matches **zero rows while nothing has yet activated** — exactly the state two first-ever revisions race in — so two sessions activating two *different* submitted versions lock disjoint rows, both see an empty activated set at the monotonicity re-check, and **both commit**. Reproduced with raw `pg` sessions: v1 landed at Mar-1 and v2 (the newer revision) at Jan-1; `resolveActiveTariffVersion` then returns v1 for every date after Mar-1, so the new price runs six weeks and silently reverts, permanently. The comment above the locks explicitly claims the set lock "still serializes against any OTHER version's concurrent activation" — the claim is false and dies with the code.

**Files:**
- Modify: `apps/core/src/kernel/db/schema/tariff.ts` (+`sql` import, +1 index)
- Create (generated): `apps/core/drizzle/0008_<generated-name>.sql`, `apps/core/drizzle/meta/0008_snapshot.json`
- Modify (generated): `apps/core/drizzle/meta/_journal.json` (new last entry idx 8)
- Modify: `apps/core/src/modules/tariff/versions.ts` (the two lock statements + their comment — nothing else)
- Modify: `apps/core/src/modules/tariff/versions.test.ts` (+1 test)
- Modify: `apps/core/src/kernel/db/schema/tariff.test.ts` (+1 test; 3 assertions tightened)

**Interfaces:** no signature changes anywhere. `activateVersion(db, actor, versionId, effectiveFrom)` keeps its shape and its error codes; the same-version race loser stays `not_submitted` (traced below).

- [ ] **Step 1: Write the failing cross-version race test** — append to the `describe` block of `versions.test.ts` (this file uses `it(…)`; `s1`, `s2`, `mkDraft`, `drafter`, `activator`, `owner`, `events`, `tariffVersions`, `eq`, `getVersion` are already in scope/imported):

```ts
  it("cross-version race at an EQUAL effectiveFrom: one winner, loser is effective_from_not_monotone, monotone set holds", async () => {
    const v1 = await mkDraft([[s1, 10000]]);
    const v2 = await mkDraft([[s2, 20000]]);
    const sub1 = await withTx(db, (tx) => submitVersion(tx, drafter, v1.versionId));
    const sub2 = await withTx(db, (tx) => submitVersion(tx, drafter, v2.versionId));
    await approveRequest(db, owner, { approvalId: sub1.approvalId, note: "approved" });
    await approveRequest(db, owner, { approvalId: sub2.approvalId, note: "approved" });

    // §3.21 trace discipline: the serializer's predicate (status in submitted/activated) matches
    // BOTH target rows in this starting state — a lock that locks something. The loser waits on
    // the ordered set lock, then re-reads the activated set and finds the winner's row at the
    // SAME date, never strictly greater — so its code is deterministic on EVERY interleaving.
    const effectiveFrom = new Date("2026-02-01T00:00:00Z");
    const results = await Promise.allSettled([
      activateVersion(db, activator, v1.versionId, effectiveFrom),
      activateVersion(db, activator, v2.versionId, effectiveFrom),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    expect(fulfilled.length).toBe(1);
    expect(loser).toBeDefined();
    expect(loser!.reason.code).toBe("effective_from_not_monotone");

    // Invariants — asserted on every path, no early bail (§3.13 lesson).
    const activatedRows = await db.select().from(tariffVersions).where(eq(tariffVersions.status, "activated"));
    expect(activatedRows.length).toBe(1);
    const eventRows = await db.select().from(events).where(eq(events.name, "tariff.revision_applied"));
    expect(eventRows.length).toBe(1);

    // The loser is untouched — still submitted — and re-activates cleanly at a LATER date.
    const loserId = activatedRows[0]!.id === v1.versionId ? v2.versionId : v1.versionId;
    expect((await getVersion(db, loserId))!.version.status).toBe("submitted");
    const retry = await activateVersion(db, activator, loserId, new Date("2026-03-01T00:00:00Z"));
    expect(retry.effectiveFrom).toEqual(new Date("2026-03-01T00:00:00Z"));
  });
```

  **Why EQUAL dates, deliberately:** with two different dates the outcome is interleaving-dependent — if the earlier-dated version happens to win the lock, the later one then activates *legally* and both fulfil, so any "exactly one wins" assertion over a Jan/Mar pair fails a CORRECT implementation some of the time (§3.13 flake by construction). At equal dates every interleaving refuses the loser with the same single code. The Jan-then-Mar sequential semantics are already pinned by the shipped monotonicity test.

- [ ] **Step 2: Run it to fail — repeatedly, isolated (tripwire 19).** `pnpm --filter @hmis/core exec jest --passWithNoTests versions.test -t "cross-version race"` — confirm isolation from the OUTPUT (`9 skipped, 1 passed`-shaped line, not the exit code). Run **15 times**; the pre-fix failure is a race and may not fire every run — quote at least one failing run (expected shape: `fulfilled.length` 2, or an activatedRows count of 2). This fail-first evidence is owed by THIS attempt (§2.3); a retry inherits it.
- [ ] **Step 3: Replace the serializer.** In `versions.ts`, inside `withTx`, replace the two `tx.execute` lock statements AND the comment block above them (the one claiming the activated-set lock "still serializes against any OTHER version's concurrent activation") with exactly:

```ts
    // Serializes ANY two concurrent activations — same version or different versions. The
    // predicate always covers the version being activated (it stays 'submitted' until the
    // winner's conditional UPDATE flips it, and 'activated' keeps it in the set afterwards), so
    // two concurrent activators always contend on at least their two target rows, and ORDER BY id
    // makes every session acquire row locks in the same order — no deadlock. The previous shape
    // (target-row lock + a lock on the already-activated set) did NOT serialize two DIFFERENT
    // versions: with nothing yet activated the set lock matched zero rows and locked nothing
    // (stress-test C1, reproduced 2026-08-14). Do NOT reintroduce a separate target-row lock
    // ahead of this one — row-then-set acquisition order deadlocks (Postgres 40P01).
    await tx.execute(
      sql`select id from tariff_versions where status in ('submitted', 'activated') order by id for update`,
    );
```

  The monotonicity re-check below it (`ne(id, versionId)` exclusion) and the single-winner conditional UPDATE are already correct — do not touch them. **Same-version race trace under the new lock:** both racers pass the pre-tx checks, contend on the ordered set lock; the loser proceeds after the winner commits, its re-check excludes its own row (`ne`) so monotonicity passes, and its conditional UPDATE (`status='submitted'`) matches 0 rows → `not_submitted` — the shipped race test's single enumerated value is unchanged.
- [ ] **Step 4: Add the structural backstop.** In `schema/tariff.ts`: add `import { sql } from "drizzle-orm";` below the existing pg-core import block (the file does not import `sql` today), and extend `tariffVersions`' index array to:

```ts
  (t) => [
    uniqueIndex("tariff_versions_no_ux").on(t.versionNo),
    index("tariff_versions_status_idx").on(t.status),
    // D5's strict monotonicity means two ACTIVATED versions can never share an effective date.
    // This partial unique index IS that invariant at the database layer — the structural
    // backstop behind the activation serializer (the workflow_definitions_one_active_ux /
    // patient_merge_requests_pending_loser_ux precedent).
    uniqueIndex("tariff_versions_activated_effective_ux")
      .on(t.effectiveFrom)
      .where(sql`${t.status} = 'activated'`),
  ],
```

- [ ] **Step 5: Generate migration 0008** — `pnpm --filter @hmis/core db:generate`. Commit ALL generator outputs (§3.16): the new `.sql`, `meta/0008_snapshot.json`, and the rewritten `meta/_journal.json`. Read the generated SQL and confirm it carries `WHERE "tariff_versions"."status" = 'activated'` (the 0004/0006 emission shape). Never hand-edit it.
- [ ] **Step 6: Write the index test** — append to `schema/tariff.test.ts` (uses `test(…)`; `db`, `tariffVersions` in scope). No red run is owed for it — by this step migration 0008 is already applied to the per-worker databases, so its first honest run is green (§3.5); its teeth are Assertion Book A2's mutant walk, which the gate re-checks:

```ts
test("partial unique index: two ACTIVATED versions cannot share an effective_from; other statuses can", async () => {
  const d = new Date("2026-02-01T00:00:00Z");
  await db.insert(tariffVersions).values({ id: "va", versionNo: 11, status: "activated", effectiveFrom: d, createdBy: "t" });
  // Same instant under a NON-activated status inserts fine — the WHERE clause is live, not decorative.
  await db.insert(tariffVersions).values({ id: "vs", versionNo: 12, status: "submitted", effectiveFrom: d, createdBy: "t" });
  // A second ACTIVATED row at the same instant violates the invariant at the database layer.
  await expect(
    db.insert(tariffVersions).values({ id: "vb", versionNo: 13, status: "activated", effectiveFrom: d, createdBy: "t" }),
  ).rejects.toMatchObject({ code: "23505" });
  // A different instant is fine.
  await db.insert(tariffVersions).values({ id: "vc", versionNo: 14, status: "activated", effectiveFrom: new Date("2026-03-01T00:00:00Z"), createdBy: "t" });
});
```

  In the same file, tighten the second test's three bare `.rejects.toThrow()` calls (service code, version number, item pair) to `.rejects.toMatchObject({ code: "23505" })` — findings §12.3. `toMatchObject` on the raw pg `DatabaseError` is safe: drizzle-orm 0.40.1 has no query-error wrapper (scout-verified in the installed package).
- [ ] **Step 7: Verify.** `pnpm --filter @hmis/core exec jest --passWithNoTests versions.test` → 1 suite, **10 tests**. Both race tests (same-version AND cross-version) **20 isolated runs each**, exit codes captured to a file under `/opt/hmis`, isolation confirmed from output each time; 20/20 clean or the task fails. No `40P01` in any run. `exec jest --passWithNoTests kernel/db/schema/tariff.test` → **4 tests**. Whole workspace `pnpm --filter @hmis/core test` → 68 suites / **362 tests**. Detached root `pnpm verify`, exit read from a file (tripwires 16–18).
- [ ] **Step 8: Commit** — `fix(core): serialize tariff activation across versions — ordered set lock + migration 0008 backstop`. Then `git pull --rebase origin main`. Then `git push origin main`. (Three numbered steps — §3.8.)

**Acceptance criteria:**
1. The cross-version race test exists with EQUAL dates, was observed failing against the pre-fix code (quoted), and passes 20/20 isolated runs post-fix with isolation shown from output; the same-version race also passes 20/20 isolated and its loser code is still the single value `not_submitted`.
2. `versions.ts` contains exactly ONE lock statement (`status in ('submitted', 'activated') … order by id for update`); the false "still serializes against any OTHER version" claim is gone; no separate target-row lock remains.
3. Migration `0008_*.sql` + snapshot + journal are committed, generated not hand-written, and the SQL carries the partial `WHERE` clause.
4. The index test proves all three legs (same-date activated blocked with pg code 23505 top-level, same-date non-activated allowed, different-date activated allowed).
5. Workspace at 68 suites / 362 tests; `pnpm verify` green; no file outside this task's list changed.

---

### Task 2: SoD submitter clause + approval subject binding

**Two defects.** (a) **C4, CRITICAL test gap:** every SoD test in the module drafts and submits as the SAME actor, so deleting `|| actor.id === version.submittedBy` from the SoD check leaves everything green — and a supervisor who submits someone else's draft could then activate it, a straight governance bypass on a Class-A approval. (b) **M10, MODERATE:** `activateVersion` checks only `approval.status`, never that the approval's `subjectType`/`subjectId` name THIS version. Not exploitable today (`submitVersion` is the only writer of `approval_id` and always binds the approval it just created), but it is a trust-the-invariant design with zero structural defense against a future admin tool or data fix.

**Files:**
- Modify: `apps/core/src/modules/tariff/errors.ts` (+1 union member)
- Modify: `apps/core/src/modules/tariff/versions.ts` (one inserted guard)
- Modify: `apps/core/src/modules/tariff/versions.test.ts` (+2 tests)

**Interfaces:** `TariffErrorCode` gains `"approval_subject_mismatch"` (union widening; `index.ts` byte-untouched; `toHttp` fallthrough already maps it to 409 — **no controller edit**, and do NOT add it to `NOT_FOUND_CODES`/`VALIDATION_CODES`).

- [ ] **Step 1: Write both failing tests** — append to `versions.test.ts` (`createUser`, `withTx`, `approveRequest`, `tariffVersions`, `eq`, `getVersion` already imported; `Actor` type already imported):

```ts
  it("SoD blocks the SUBMITTER, not only the drafter: drafter != submitter, submitter refused, third actor succeeds", async () => {
    const submitterUser = await createUser(db, { username: "submitter", fullName: "Submitter", password: "p1234567" });
    const submitter: Actor = { type: "user", id: submitterUser.id };

    const draft = await mkDraft([[s1, 10000]]); // created by `drafter`
    const submitted = await withTx(db, (tx) => submitVersion(tx, submitter, draft.versionId));
    await approveRequest(db, owner, { approvalId: submitted.approvalId, note: "approved" });

    // Every prior SoD test had createdBy === submittedBy, so the submitter disjunct was deletable
    // with the suite green (stress-test C4). Here they differ: refusing the SUBMITTER exercises
    // exactly `actor.id === version.submittedBy`, and the third actor's immediate success proves
    // the refusal was SoD — not approval state, not version state (§3.14b ordering discipline).
    await expect(activateVersion(db, submitter, draft.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "sod_drafter_activator",
    });
    const result = await activateVersion(db, activator, draft.versionId, new Date("2026-02-01T00:00:00Z"));
    expect(result.versionNo).toBe(1);
  });

  it("an approval for a DIFFERENT subject cannot activate this version: approval_subject_mismatch", async () => {
    const vA = await mkDraft([[s1, 10000]]);
    const vB = await mkDraft([[s2, 20000]]);
    await withTx(db, (tx) => submitVersion(tx, drafter, vA.versionId));
    const subB = await withTx(db, (tx) => submitVersion(tx, drafter, vB.versionId));
    await approveRequest(db, owner, { approvalId: subB.approvalId, note: "approved B" });

    // No application path can produce this state (submitVersion always binds the approval it just
    // created), so the test reaches for a raw column write — simulating exactly the future admin
    // tool / data-fix bug M10 is about.
    await db.update(tariffVersions).set({ approvalId: subB.approvalId }).where(eq(tariffVersions.id, vA.versionId));

    await expect(activateVersion(db, activator, vA.versionId, new Date("2026-02-01T00:00:00Z"))).rejects.toMatchObject({
      code: "approval_subject_mismatch",
    });
    // vA untouched and still submitted; B's approval still activates B itself.
    expect((await getVersion(db, vA.versionId))!.version.status).toBe("submitted");
    const ok = await activateVersion(db, activator, vB.versionId, new Date("2026-02-01T00:00:00Z"));
    expect(ok.versionNo).toBe(2);
  });
```

- [ ] **Step 2: Run to fail** — isolated (`exec jest --passWithNoTests versions.test -t "<name>"`, isolation confirmed from output). Expected: the SoD test fails only if the disjunct were missing — against the SHIPPED code it PASSES, which is correct: C4 is a coverage gap, not a code bug, so **no red run is owed for it** (§3.5 — state this in the report; the discrimination proof is the mutant walk in this document, gate-checkable by deleting the disjunct mentally). The subject-mismatch test genuinely FAILS against shipped code (vA activates on B's approval — quote it).
- [ ] **Step 3: Implement.** In `errors.ts`, extend the union's approval line to:

```ts
  | "approval_not_granted" | "approval_rejected" | "approval_subject_mismatch" | "sod_drafter_activator" | "effective_from_not_monotone"
```

  In `versions.ts`, immediately after the `approval_rejected` block and before the SoD check, insert:

```ts
  // The approval must be FOR THIS VERSION. submitVersion is today the only writer of approval_id
  // and always binds the approval it just created — but that invariant had zero structural
  // defense against a future admin tool or data fix (stress-test M10). approval_id is plain text
  // with no FK by design, so the binding is asserted here, at the only consumption site.
  if (approval.subjectType !== "tariff_version" || approval.subjectId !== versionId) {
    throw new TariffError(
      "approval_subject_mismatch",
      `approval ${version.approvalId} is for ${approval.subjectType} ${approval.subjectId}, not tariff_version ${versionId}`,
    );
  }
```

- [ ] **Step 4: Run to pass** — `exec jest --passWithNoTests versions.test` → 1 suite, **12 tests**. Workspace → 68 suites / **364 tests**. Detached root `pnpm verify`.
- [ ] **Step 5: Commit** — `fix(core): SoD submitter coverage + approval subject binding on activation` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. A test exists where drafter ≠ submitter and the **submitter** is refused with `sod_drafter_activator`, followed by a third actor succeeding on the same version — the gate confirms by inspection that deleting `|| actor.id === version.submittedBy` fails it.
2. The subject-mismatch test failed against pre-fix code (quoted) and passes after; the guard compares BOTH `subjectType` and `subjectId` and sits before the SoD check.
3. `approval_subject_mismatch` is in the union; `index.ts` and `tariff.controller.ts` are byte-untouched.
4. Workspace 68 / 364; verify green.

---

### Task 3: Deterministic regulated-price resolution + the `listRegulatedPrices` accessor

**The defect (C2, CRITICAL):** `resolveRegulatedPrices` orders by `effectiveFrom DESC` with no tie-break and reduces first-row-per-service. `regulated_prices` is append-only BY DESIGN and `effectiveFrom` is a gazette calendar date, so "we typed the ceiling wrong — append the corrected row for the same gazette date" is the system's **normal correction path**, and which of the two same-date rows wins is Postgres heap order. The engine can bill at the superseded ceiling while `regulatedClamp` records that the NPPA hard block was applied — a DPCO violation carrying its own compliance attestation. The controller's regulated-prices list route has the same partial ordering; the gate report (§5.2) already carries the accessor this route should have had. Both close together here (ledger §3.2: the carried-forward item is named in the task that owns the file).

**Files:**
- Modify: `apps/core/src/modules/tariff/services.ts`
- Modify: `apps/core/src/modules/tariff/services.test.ts` (+2 tests)
- Modify: `apps/core/src/modules/tariff/tariff.controller.ts` (one route body + import pruning)

**Interfaces:**
- Produces (module-internal): `listRegulatedPrices(db: Db, serviceId: string): Promise<RegulatedPriceRow[]>` and `export type RegulatedPriceRow = typeof regulatedPrices.$inferSelect;` — exported from `services.ts`, imported by the controller, **deliberately NOT added to `index.ts`** (frozen).

- [ ] **Step 1: Write the failing determinism test** — append to `services.test.ts` (uses `test(…)`; `actor`, `withTx`, `appendRegulatedPrice`, `createService`, `resolveRegulatedPrices` in scope):

```ts
test("a same-date gazette CORRECTION wins: resolution is last-inserted, never heap order", async () => {
  const { serviceId } = await withTx(db, (tx) =>
    createService(tx, actor, { code: "SVC-7", name: "Drug D", category: "pharmacy", regulated: true }),
  );
  const gazetteDate = new Date("2026-04-01T00:00:00Z");
  await withTx(db, (tx) =>
    appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 10000, ceilingPaise: 8000, effectiveFrom: gazetteDate, gazetteRef: "GZ-1" }),
  );
  // The correction path C2 is about: same gazette date, corrected ceiling, appended as a new row
  // (the table is append-only by design — an UPDATE is forbidden by the change-control trail).
  await withTx(db, (tx) =>
    appendRegulatedPrice(tx, actor, { serviceId, mrpPaise: 10000, ceilingPaise: 6000, effectiveFrom: gazetteDate, gazetteRef: "GZ-1-corr" }),
  );
  const map = await resolveRegulatedPrices(db, new Date("2026-05-01T00:00:00Z"));
  expect(map[serviceId]).toEqual({ mrpPaise: 10000, ceilingPaise: 6000 });
});

test("listRegulatedPrices: one service's full history, newest first, same-date correction before its original", async () => {
  const { serviceId: a } = await withTx(db, (tx) =>
    createService(tx, actor, { code: "SVC-8", name: "Drug E", category: "pharmacy", regulated: true }),
  );
  const { serviceId: b } = await withTx(db, (tx) =>
    createService(tx, actor, { code: "SVC-9", name: "Drug F", category: "pharmacy", regulated: true }),
  );
  const r1 = await withTx(db, (tx) =>
    appendRegulatedPrice(tx, actor, { serviceId: a, mrpPaise: 10000, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
  );
  const r2 = await withTx(db, (tx) =>
    appendRegulatedPrice(tx, actor, { serviceId: a, mrpPaise: 9000, effectiveFrom: new Date("2026-04-01T00:00:00Z") }),
  );
  const r3 = await withTx(db, (tx) =>
    appendRegulatedPrice(tx, actor, { serviceId: a, mrpPaise: 8500, effectiveFrom: new Date("2026-04-01T00:00:00Z") }),
  );
  await withTx(db, (tx) =>
    appendRegulatedPrice(tx, actor, { serviceId: b, mrpPaise: 7000, effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
  );
  const history = await listRegulatedPrices(db, a);
  // Scoped to one service; newest gazette date first; within the same date, last-inserted first.
  expect(history.map((r) => r.id)).toEqual([r3.id, r2.id, r1.id]);
});
```

  (Add `listRegulatedPrices` to the `./services` import at the top of the file.)
- [ ] **Step 2: Run to fail.** The first test is heap-order-dependent pre-fix: run it **5 times isolated**; quote any failing run. **Honesty note (discrimination audit):** in a fresh test table heap order usually equals insertion order, so the no-tie-break implementation can pass this test repeatedly — the assertion pins the *convention*; the reliable kill for the missing-`desc(id)` mutant is the SECOND test's `[r3, r2, r1]` ordering, whose same-date pair a `desc(effectiveFrom)`-only sort has no reason to order correctly, plus the fact that ULID descending is the only total order the code now states. If neither test goes red pre-fix after 5 runs, say so in the report — the fix is still owed (the defect is nondeterminism itself, which a green run cannot disprove).
- [ ] **Step 3: Fix `services.ts`.** In `resolveRegulatedPrices`, change the ordering to `.orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.id))` and extend the function comment: ids are ULIDs, so descending id = last-inserted-wins among rows sharing a gazette date — the append-only correction path resolves to the correction, deterministically (stress-test C2). Add below it:

```ts
export type RegulatedPriceRow = typeof regulatedPrices.$inferSelect;

/** Full row history for ONE service, newest first; same-date rows resolve last-inserted-first
 * (ULID ids) — the same total order resolveRegulatedPrices uses (C2). The accessor the gate
 * report §5.2 carried forward: the controller's list route sits behind it now. */
export async function listRegulatedPrices(db: Db, serviceId: string): Promise<RegulatedPriceRow[]> {
  return db
    .select()
    .from(regulatedPrices)
    .where(eq(regulatedPrices.serviceId, serviceId))
    .orderBy(desc(regulatedPrices.effectiveFrom), desc(regulatedPrices.id));
}
```

- [ ] **Step 4: Move the controller behind it.** In `tariff.controller.ts`: the `listRegulatedPricesRoute` body becomes `return { items: await listRegulatedPrices(this.db, id) };`. Import changes, exactly: add `listRegulatedPrices` to the existing `./services` import; DELETE the now-unused `import { desc, eq } from "drizzle-orm";` line and the `import { regulatedPrices } from "../../kernel/db/schema";` line (both existed solely for this route — leaving either behind fails lint on unused vars).
- [ ] **Step 5: Run to pass** — `exec jest --passWithNoTests services.test` → 1 suite, **8 tests**; the determinism test 5× isolated, 5/5. Workspace → 68 suites / **366 tests**. Detached root `pnpm verify` (typecheck catches any import slip).
- [ ] **Step 6: Commit** — `fix(core): deterministic regulated-price resolution with last-inserted tie-break` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. Both `resolveRegulatedPrices` and `listRegulatedPrices` order by `(effectiveFrom DESC, id DESC)`; the same-date correction wins in the resolver and lists first in the history.
2. The controller route body no longer touches drizzle directly; `desc`/`eq`/`regulatedPrices` imports are gone from the controller; `index.ts` byte-untouched.
3. The history test pins `[r3, r2, r1]` by captured ids across two services (scoping proven).
4. Workspace 68 / 366; verify green.

---

### Task 4: Engine truth — asked amounts, paise guards, contest teeth  *(sonnet coder; the thinking is already in this document — the diffs are small and exact)*

**Defects:** **M2** — `manualDiscountSource` clamps to gross BEFORE the cap check and records the clamped amount on rejection, while `types.ts` specifies "the amount that was ASKED (audit)" and D3 forbids silent clamping; at a 100% cap (`maxBps: 10000`, legal under `manualCapParamsSchema`) the shipped check even ACCEPTS an over-gross ask silently clamped to gross — exactly the behaviour D3 names. **M3** — `manualDiscount.value` is the one money input never asserted: a `flat_paise 1250.5` flows to `discountPaise` and (because a half-paise base times any even `rateBps` yields an integral product) defeats `divHalfUp`'s guard, landing a fractional `netPaise` on a `bigint` column; the exposed caller is the direct programmatic import — Plan 08. **M6** — `runContest`'s ruleKey tie-break is shadowed by `standingRuleSource`'s pre-sort; the shipped sort lines are unreachable dead weight until a source proposes unsorted. Plus findings §12.4 (shallow freeze), §12.5 (swapping `gst.ts`'s first two branches is undetected — both give zero heads, only `exemptReason` differs, and `exemptReason` IS the audit trail), §12.6 (zero-amount candidate could win), and the Pass-1 find: a regulated row with both bounds null silently no-ops the C-3 clamp inside the engine.

**Semantics decision, derived here so the coder types it rather than re-deriving it:** the over-cap check moves from the clamped `amount` to the raw ask. For every `maxBps < 10000`: accepted ⇔ `raw ≤ maxBps/10000 · gross < gross`, so the clamp was a no-op on every accepted candidate and the check's answer is IDENTICAL on both operands — no shipped test, fixture, or golden expectation moves. At exactly `maxBps = 10000` the raw check turns "silently clamp an over-gross ask and accept it" into `over_cap` — the D3-correct answer. `requiresApproval` stays computed on the clamped `amount` (the benefit actually granted). Accepted candidates keep `amountPaise = Math.min(raw, gross)` — D2's "candidates are pre-capped at gross" belt stays.

**Files:**
- Modify: `apps/core/src/modules/tariff/contest.ts`, `contest.test.ts` (+4 tests)
- Modify: `apps/core/src/modules/tariff/pricing.ts`, `pricing.test.ts` (+2 tests, 1 test upgraded in place)
- Modify: `apps/core/src/modules/tariff/types.ts` (doc comment only — owner decision 3)
- Modify: `apps/core/src/modules/tariff/gst.test.ts` (+1 test)

**Interfaces:** none move. All four files stay PURE (no `await`, no `kernel/`, no `new Date(`, no `Math.random` — the CI purity greps must stay green).

- [ ] **Step 1: Write the failing engine tests.** In `contest.test.ts` (add `TariffError` to imports from `./errors`, and `AdjustmentSource` to the type imports from `./types`):

```ts
test("an over-GROSS flat ask is recorded at the ASKED amount — 60000, never the 50000 clamp", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "negotiated_corporate", kind: "flat_paise", value: 60000, reason: "asked too much" },
  };
  const out = manualDiscountSource.propose(makeCtx(), line, 50000);
  expect(out).toHaveLength(1);
  // A clamp-then-record implementation reports Math.min(60000, 50000) = 50000 on BOTH fields —
  // killed twice over. 60000×10000 = 600,000,000 > 2000×50000 = 100,000,000 → over_cap.
  expect(out[0]?.amountPaise).toBe(60000);
  expect(out[0]?.rejected).toEqual({ code: "over_cap", detail: "60000p exceeds 2000bps of 50000p" });
});

test("a fractional manual discount value is refused as invalid_paise before any arithmetic", () => {
  const line: InvoiceLineInput = {
    ...CONS_LINE,
    manualDiscount: { discountCategory: "charity", kind: "flat_paise", value: 1250.5, reason: "typo" },
  };
  // The HTTP DTO already refuses non-integers; this guards the direct programmatic caller —
  // Plan 08 — where 1250.5 previously flowed to a fractional netPaise on a bigint column (M3).
  expect(() => manualDiscountSource.propose(makeCtx(), line, 50000)).toThrow(TariffError);
  try {
    manualDiscountSource.propose(makeCtx(), line, 50000);
  } catch (e) {
    expect((e as TariffError).code).toBe("invalid_paise");
  }
});

test("the intra-source ruleKey tie-break is real: an UNSORTED source's equal candidates break to the earlier key", () => {
  const stub: AdjustmentSource = {
    key: "stub",
    propose: () => [
      { sourceKey: "stub", ruleKey: "R-ZZZ", kind: "flat_paise", discountCategory: "scheme", amountPaise: 5000, reason: "zz", requiresApproval: false, rejected: null },
      { sourceKey: "stub", ruleKey: null, kind: "flat_paise", discountCategory: "scheme", amountPaise: 5000, reason: "anon", requiresApproval: false, rejected: null },
      { sourceKey: "stub", ruleKey: "R-AAA", kind: "flat_paise", discountCategory: "scheme", amountPaise: 5000, reason: "aa", requiresApproval: false, rejected: null },
    ],
  };
  // standingRuleSource pre-sorts its own output, so only a deliberately unsorted source reaches
  // runContest's nulls-last + ruleKey comparison at all (M6). Deleting that block leaves a stable
  // sort in input order → R-ZZZ wins → killed.
  const { winner } = runContest(makeCtx({ sources: [stub] }), CONS_LINE, 50000);
  expect(winner?.ruleKey).toBe("R-AAA");
});

test("a zero-computed benefit is recorded but can never win", () => {
  const tiny: AdjustmentRuleConfig = {
    ruleKey: "R-1BPS", title: "One bps", kind: "percent_bps", value: 1,
    discountCategory: "scheme", requiredTag: null, serviceCategory: null, serviceId: null,
  };
  // pct(4, 1) = divHalfUp(4, 10000) = floor((8 + 10000) / 20000) = 0. Dropping the
  // `amountPaise > 0` filter puts a zero-benefit discount line on an invoice (winner non-null) — killed.
  const ctx = makeCtx({ rules: [tiny], tariff: { versionId: "v1", versionNo: 1, items: { "svc-cons": 4 } } });
  const { candidates, winner } = runContest(ctx, CONS_LINE, 4);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.amountPaise).toBe(0);
  expect(winner).toBeNull();
});
```

  In `pricing.test.ts` (add `AdjustmentSource` to the type imports):

```ts
test("a regulated row with BOTH bounds null is refused — the C-3 hard block must never silently no-op", () => {
  const ctx = makeCtx({
    regulatedPrices: {
      "svc-drug-a": { mrpPaise: 10000, ceilingPaise: 15000 },
      "svc-drug-b": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-c": { mrpPaise: 10000, ceilingPaise: 8000 },
      "svc-drug-d": { mrpPaise: null, ceilingPaise: null },
    },
  });
  // The write path refuses this shape (regulated_bounds_missing), but a bulk-loaded or hand-fixed
  // row must not price at bare tariff with regulatedClamp: null. Shipped code returns netPaise
  // 5600 here (tariff 5000 + 2×300) with no clamp and no error — killed by expecting the throw.
  expect(thrownCode(() => priceInvoiceLines(ctx, [{ lineId: "L1", serviceId: "svc-drug-d", qty: 1 }])))
    .toBe("regulated_price_missing");
});

test("an over-gross winner from a rogue source fails LOUDLY at the taxable base, never a negative net", () => {
  const rogue: AdjustmentSource = {
    key: "rogue",
    propose: () => [{
      sourceKey: "rogue", ruleKey: null, kind: "flat_paise", discountCategory: null,
      amountPaise: 60000, reason: "violates the D2 pre-cap contract on purpose",
      requiresApproval: false, rejected: null,
    }],
  };
  // ctx.sources is an OPEN plugin array (Plan 09 registers two more). Shipped code returns
  // netPaise -10000 here; the belt turns that into a thrown invalid_paise (M3 belt).
  expect(thrownCode(() => priceInvoiceLines(makeCtx({ sources: [rogue] }), [{ lineId: "L1", serviceId: "svc-cons", qty: 1 }])))
    .toBe("invalid_paise");
});
```

  Also in `pricing.test.ts`, REPLACE the body of the existing determinism test (`"priceInvoiceLines is synchronous and deterministic — same frozen ctx, deeply equal output"`) with the deep-freeze form — same test, sharper teeth, count unchanged (findings §12.4: `Object.freeze` is shallow; `ctx.tariff.items` stayed mutable):

```ts
test("priceInvoiceLines is synchronous, deterministic, and mutates NOTHING it is handed", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
      Object.freeze(value);
    }
    return value;
  }
  const ctx = deepFreeze(makeCtx({ rules: [R_EMP10], tags: ["employee"] }));
  const lines = deepFreeze<InvoiceLineInput[]>([
    { lineId: "L1", serviceId: "svc-proc", qty: 1 },
    { lineId: "L2", serviceId: "svc-drug-b", qty: 2 },
  ]);
  const snapshot = JSON.parse(JSON.stringify({ ctx, lines })) as unknown;
  const first = priceInvoiceLines(ctx, lines);
  expect(Array.isArray(first)).toBe(true); // an array, not a Promise
  expect(first).not.toBeInstanceOf(Promise);
  const second = priceInvoiceLines(ctx, lines);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  // Frozen objects throw on mutation under "use strict" (all ts-jest code is strict); the JSON
  // snapshot is the belt in case any layer silently ignores the freeze. (deepFreeze also freezes
  // the module-level SERVICES/CATEGORIES/CAPS fixtures — harmless: no test mutates them, and an
  // ENGINE that tried is exactly what this test exists to catch.)
  expect(JSON.parse(JSON.stringify({ ctx, lines }))).toEqual(snapshot);
});
```

  In `gst.test.ts`:

```ts
test("composite supply outranks category exemption — the D4 decision ORDER is observable in exemptReason", () => {
  // Both branch orders give zero heads; ONLY exemptReason separates them, and exemptReason is the
  // audit trail. Swapping gst.ts's first two branches reports "category_exempt" here — killed
  // (findings §12.5; the §3.14 class: never let two mechanisms share one observable).
  const gst = computeGst({
    cfg: CONSULTATION, settings: SETTINGS,
    line: line({ supplyContext: "composite_healthcare" }), taxableBasePaise: 50000, qty: 1,
  });
  expect(gst).toEqual({ sacCode: "999312", rateBps: 1800, exempt: true, exemptReason: "composite_healthcare", cgstPaise: 0, sgstPaise: 0 });
});
```

- [ ] **Step 2: Run all new tests to fail** (isolated per tripwire 19). Expected reds against shipped code: asked-amount test (records 50000), fractional test (no throw — returns a candidate), rogue-source test (returns net −10000), null-bounds test (prices at 5600). Expected GREENS against shipped code, correctly: the stub tie-break test (the tie-break exists — the gap was reachability; discrimination is by deleting the block, walked above), the zero-amount test (the filter exists), and the composite-order test (the order is right) — for these three, **no red run is owed** (§3.5); the kill is the named mutant in this document.
- [ ] **Step 3: Implement `contest.ts`.** Change the money import to `import { assertPaise, percentAmount } from "./money";`. Replace `manualDiscountSource.propose`'s body with:

```ts
  propose(ctx, line, grossPaise) {
    const md = line.manualDiscount;
    if (!md) return [];
    // The one money input that arrives from a CALLER rather than from zod-parsed config: guard it
    // here so a programmatic caller (Plan 08) can never float a fractional paise into the contest
    // (M3). Integer guard holds for both kinds — bps values are integers too.
    assertPaise(md.value, "manual discount value");
    const raw = md.kind === "percent_bps" ? percentAmount(grossPaise, md.value) : md.value;
    const amount = Math.min(raw, grossPaise);
    const base: AdjustmentCandidate = {
      sourceKey: "manual", ruleKey: null, kind: md.kind, discountCategory: md.discountCategory,
      amountPaise: amount, reason: md.reason, requiresApproval: false, rejected: null,
    };
    const caps = ctx.manualCaps[md.discountCategory];
    // Rejected candidates record the amount that was ASKED — the D-8 audit record (types.ts
    // contract; M2). Never the gross-clamped amount.
    if (!caps) return [{ ...base, amountPaise: raw, rejected: { code: "unknown_category", detail: `no cap configured for "${md.discountCategory}"` } }];
    // Governance checks are EXACT RATIONAL comparisons — never rounded (D1). The cap compares the
    // ASK: at a 100% cap an over-gross ask must reject as over_cap, never be silently clamped to
    // gross and accepted (D3: "recorded as rejected, never silently clamped"). For every
    // maxBps < 10000 this is provably identical to the old clamped-operand check.
    if (raw * 10000 > caps.maxBps * grossPaise) {
      return [{ ...base, amountPaise: raw, rejected: { code: "over_cap", detail: `${raw}p exceeds ${caps.maxBps}bps of ${grossPaise}p` } }];
    }
    const requiresApproval = caps.approvalAboveBps !== null && amount * 10000 > caps.approvalAboveBps * grossPaise;
    return [{ ...base, requiresApproval }];
  },
```

- [ ] **Step 4: Implement `pricing.ts`.** After the existing `if (!rp) throw …regulated_price_missing…` line, insert:

```ts
    // Defense in depth: appendRegulatedPrice refuses a row with neither bound, but a row that
    // arrives around the API (bulk load, data fix) must not silently no-op the C-3 hard block.
    // Both comparisons are `=== null` — a legal bound of 0 paise must survive.
    if (rp.mrpPaise === null && rp.ceilingPaise === null) {
      throw new TariffError("regulated_price_missing", `line ${line.lineId}: ${line.serviceId} has a regulated_prices row with no MRP and no ceiling`);
    }
```

  After `const taxableBasePaise = grossPaise - discountPaise;`, insert:

```ts
  // Engine-side belt on D2's "candidates are pre-capped at gross": ctx.sources is an open plugin
  // array (Plan 09 registers more) — a source proposing an over-gross winner must fail LOUDLY
  // here, never flow a negative or fractional base into GST (M3).
  assertPaise(taxableBasePaise, "taxable base");
```

  In `types.ts`, above `export type ManualDiscountInput`, add the comment (owner decision 3): `// flat_paise is a WHOLE-LINE amount, never per-unit (owner decision 2026-08-14). How a flat discount pro-rates on a partial refund is the billing layer's rule to state (Plan 08).`
- [ ] **Step 5: Run to pass.** `exec jest --passWithNoTests contest.test` → **19 tests**; `pricing.test` → **10**; `gst.test` → **8**. Confirm no shipped test moved: the existing over-cap percent test still records 12500 with detail `"12500p exceeds 2000bps of 50000p"` (raw = clamped there — the fix is invisible below gross, by construction). Golden suite untouched and green (`exec jest --passWithNoTests golden` → 15 — g09 still passes because its percent ask equals its raw). Purity greps green. Workspace → 68 suites / **373 tests**. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `fix(core): record asked discount amounts, guard manual paise and taxable base` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. Both rejected branches (`unknown_category`, `over_cap`) record `raw`; the over-cap check compares `raw`; `requiresApproval` still uses the clamped amount; accepted `amountPaise` still `Math.min(raw, gross)`.
2. The four red-first tests were observed red (quoted) and green after; the three intentionally-green-first tests are declared as such with their mutant walks intact.
3. `assertPaise` guards `md.value` (in the source) and `taxableBasePaise` (in the engine); the both-null regulated guard uses `=== null` twice.
4. `types.ts` changed by comment only; purity greps pass on all six pure files; no golden fixture changed in this task.
5. Workspace 68 / 373; verify green.

---

### Task 5: The D-17 gate tells the truth — engine caps, windows, duplicates, upsert branches

**The lead defect (M1):** `validateTariffConfig` builds its manual-caps map from `listAdjustmentRules(db)` — every row in the table — while the engine builds its map from `loadRuleConfig(db, at)`, which filters `active = true` and the validity window. Set `CAP-CHARITY` inactive (the shipped `POST /tariff/rules` accepts `active`), or just let a cap's `validTo` pass, and the gate prints `ok=true` while at the counter `ctx.manualCaps["charity"]` is `undefined` and **every charity waiver returns `rejected: unknown_category` with the patient billed full price**. The gate's one stated job (D7: all four D-8 categories have caps) checks the wrong set of rows. Riding along: **M4** (duplicate active cap rows resolve last-write-wins from an UNORDERED select — same invoice, two answers), **M5** (the `validFrom` guard is never reached by any test — both query dates in the only validity test are after it), **M7** (neither `upsertAdjustmentRule` nor `upsertGstCategory` ever executes its UPDATE branch; a plain-`insert` mutant passes the whole suite and the CA raising a rate gets a raw 23505), **M8** (no test sets `active: false`), and findings §12.2 (Break 1's `tariff_item_missing` has two producers).

**Files:**
- Modify: `apps/core/src/modules/tariff/rules.ts` (ordering + comment), `rules.test.ts` (+4)
- Modify: `apps/core/src/modules/tariff/context.ts` (caps source + duplicate detection), `context.test.ts` (+2, one assertion sharpened)
- Modify: `apps/core/src/modules/tariff/gst-config.test.ts` (+1)

**Interfaces:** none move. `duplicate_manual_cap` is a new `ConfigError.code` STRING (the set is plain `string` and documented open — no union edit, no event).

**Execute in step-NUMBER order (tests first, red runs before any implementation).** The implementation blocks are printed before the test blocks only because the tests assert semantics those blocks define — the numbering, not the page order, is the execution order.

- [ ] **Step 3 (implement, only after Step 2's red runs): `rules.ts`** — change the drizzle import to `import { asc, eq } from "drizzle-orm";` and `loadRuleConfig`'s select to:

```ts
  const rows = await db
    .select()
    .from(adjustmentRules)
    .where(eq(adjustmentRules.active, true))
    .orderBy(asc(adjustmentRules.id));
```

  Extend the function's doc comment: ordered by id ASC (ULIDs = creation order) so the last-write-wins cap assignment below is deterministic — among duplicate active manual rows for one category the NEWEST row wins, the same last-inserted-wins convention as `resolveRegulatedPrices` (C2/M4); `validateTariffConfig` separately surfaces duplicates as `duplicate_manual_cap`.
- [ ] **Step 4 (implement): `context.ts`** — in `validateTariffConfig`, keep the `listAdjustmentRules` loop exactly as shipped EXCEPT: delete the `manualCaps` accumulation from it (the loop keeps validating every row's params — including inactive rows, deliberately: a corrupt retired row is still a config smell). Replace the `const manualCaps: ManualCaps = {};` + in-loop assignment + `DISCOUNT_CATEGORIES` check with, after the loop:

```ts
  // The caps the ENGINE will actually see at `at` — loadRuleConfig, the same function
  // loadPricingContext uses (active + validity window). Building this map from the raw table let
  // the gate print ok=true while every charity waiver died unknown_category at the counter (M1).
  let engineCaps: ManualCaps = {};
  try {
    engineCaps = (await loadRuleConfig(db, at)).manualCaps;
  } catch {
    // A corrupt params row makes loadRuleConfig throw BY DESIGN (billing-time behaviour). The
    // loop above has already recorded it as invalid_rule_params; with no loadable caps, every
    // category below correctly reports manual_caps_missing. This function still never throws.
  }
  for (const cat of DISCOUNT_CATEGORIES) {
    if (!engineCaps[cat]) {
      errors.push({ code: "manual_caps_missing", detail: `no ACTIVE manual discount cap effective at ${at.toISOString()} for category "${cat}"` });
    }
  }

  // Duplicates: two active in-window manual rows for one category resolve deterministically at
  // the counter (newest wins — loadRuleConfig's id ordering), but a duplicate is a config smell
  // the gate must SURFACE, not silently resolve (M4).
  const seenCapRule = new Map<string, string>();
  for (const row of ruleRows) {
    if (row.sourceKey !== "manual" || !row.active) continue;
    if (row.validFrom !== null && row.validFrom > at) continue;
    if (row.validTo !== null && row.validTo < at) continue;
    const parsed = manualCapParamsSchema.safeParse(row.params);
    if (!parsed.success) continue;
    const prior = seenCapRule.get(parsed.data.discountCategory);
    if (prior !== undefined) {
      errors.push({
        code: "duplicate_manual_cap",
        detail: `category "${parsed.data.discountCategory}" has more than one active cap row effective at ${at.toISOString()} ("${prior}", "${row.ruleKey}") — the newest wins at the counter; retire the others`,
      });
    }
    seenCapRule.set(parsed.data.discountCategory, row.ruleKey);
  }
```

  (Everything needed — `loadRuleConfig`, `manualCapParamsSchema`, `DISCOUNT_CATEGORIES`, `ManualCaps` — is already imported by `context.ts`; no import changes.) **Regression trace, walked here so the coder does not re-derive it:** the shipped Break-4 test corrupts a `"rule"` row's params and asserts accumulation-without-throwing. Under this change `loadRuleConfig` THROWS on that row (`.parse`), the catch above swallows it, `engineCaps` stays `{}`, four `manual_caps_missing` entries join the already-recorded `invalid_rule_params` — every existing `.some(...)` assertion still holds, `ok` is still `false`, nothing throws. The happy-path `toEqual({ ok: true, errors: [], caSigned: false })` also still holds: four seeded caps, no duplicates, no extra errors.
- [ ] **Step 1: Failing gate tests** — append to `context.test.ts` (uses `test(…)`; `drafter`, `withTx`, `upsertAdjustmentRule`, `validateTariffConfig` in scope). Add a file-local `seedFullValidConfig()` helper that reproduces the four-breaks test's seeding block verbatim (two services incl. one regulated + its price row, both GST categories, settings, R-EMP10, all four caps, then `activateFullVersion` at 2026-02-01) and returns nothing — the existing four-breaks test keeps its inline copy, untouched.

```ts
test("the gate reads the ENGINE's caps: a deactivated or expired cap row flips ok to false", async () => {
  await seedFullValidConfig();
  const at = new Date("2026-03-01T00:00:00Z");
  expect((await validateTariffConfig(db, at)).ok).toBe(true);

  // Deactivate the charity cap THROUGH THE SHIPPED API — the exact stress-test scenario: the old
  // raw-table gate still saw this row and printed ok=true while the engine dropped it and every
  // charity waiver died unknown_category with the patient billed full price (M1).
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, drafter, {
      ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "CAP-CHARITY",
      params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 }, active: false,
    }),
  );
  const deactivated = await validateTariffConfig(db, at);
  expect(deactivated.ok).toBe(false);
  expect(deactivated.errors.some((e) => e.code === "manual_caps_missing" && e.detail.includes('"charity"'))).toBe(true);

  // Re-activate with a validity window that already CLOSED — the hole that opens by itself as
  // time passes (validTo elapses; nobody touched anything).
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, drafter, {
      ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "CAP-CHARITY",
      params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 },
      validTo: new Date("2026-01-31T00:00:00Z"), active: true,
    }),
  );
  const expired = await validateTariffConfig(db, at);
  expect(expired.ok).toBe(false);
  expect(expired.errors.some((e) => e.code === "manual_caps_missing" && e.detail.includes('"charity"'))).toBe(true);
});

test("a second active cap row for one category is REPORTED as duplicate_manual_cap, not silently resolved", async () => {
  await seedFullValidConfig();
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, drafter, {
      ruleKey: "CAP-CHARITY-2025", sourceKey: "manual", title: "Charity cap FY25",
      params: { discountCategory: "charity", maxBps: 500, approvalAboveBps: null },
    }),
  );
  const report = await validateTariffConfig(db, new Date("2026-03-01T00:00:00Z"));
  expect(report.ok).toBe(false);
  expect(report.errors.some((e) => e.code === "duplicate_manual_cap" && e.detail.includes('"charity"'))).toBe(true);
});
```

  And sharpen Break 1 in the existing four-breaks test (findings §12.2 — two producers, one observable): change its assertion to

```ts
    expect(break1.errors.some((e) => e.code === "tariff_item_missing" && e.detail.startsWith('active service "SVC-UNPRICED"'))).toBe(true);
```

  Only the explicit per-service check writes that detail prefix; the smoke loop's entry for the same service starts `smoke price failed for service …`. Deleting the explicit check now goes red.
- [ ] **Step 2: Failing rules/gst-config tests.** Append to `rules.test.ts` (uses `test(…)` with a module-scope `actor`), then run everything new ISOLATED (tripwire 19) and quote the two genuinely-red results — the gate-truth test (the shipped raw-table gate says `ok: true` after deactivation) and the duplicate-cap test (`duplicate_manual_cap` does not exist yet):

```ts
test("validFrom guards the future: a rule starting next month is invisible today, visible ON the day", async () => {
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, actor, {
      ruleKey: "R-FUTURE", sourceKey: "rule", title: "Starts Oct 1",
      params: { kind: "flat_paise", value: 100, discountCategory: "scheme", requiredTag: null },
      validFrom: new Date("2026-10-01T00:00:00Z"),
    }),
  );
  // Deleting rules.ts's validFrom guard makes a campaign configured to start next month apply
  // TODAY — killed by the first assertion (M5: the guard line had never once executed under
  // test). Flipping > to >= excludes the boundary instant — killed by the second ("equal is
  // included", the module's stated D5 resolution convention).
  const before = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
  expect(before.rules.map((r) => r.ruleKey)).not.toContain("R-FUTURE");
  const onTheDay = await loadRuleConfig(db, new Date("2026-10-01T00:00:00Z"));
  expect(onTheDay.rules.map((r) => r.ruleKey)).toContain("R-FUTURE");
});

test("active: false retires a rule from the engine while it stays listed for admin", async () => {
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, actor, {
      ruleKey: "R-RETIRED", sourceKey: "rule", title: "Retired",
      params: { kind: "flat_paise", value: 100, discountCategory: "scheme", requiredTag: null },
      active: false,
    }),
  );
  // Removing loadRuleConfig's `.where(eq(active, true))` keeps a retired discount applying at the
  // counter (M8) — killed by the first assertion; the second pins that "retired" is not "deleted".
  const cfg = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
  expect(cfg.rules.map((r) => r.ruleKey)).not.toContain("R-RETIRED");
  const all = await listAdjustmentRules(db);
  expect(all.map((r) => r.ruleKey)).toContain("R-RETIRED");
});

test("upserting an existing ruleKey UPDATES in place — one row, new values, new updatedBy", async () => {
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, actor, {
      ruleKey: "R-TWICE", sourceKey: "rule", title: "First",
      params: { kind: "percent_bps", value: 500, discountCategory: "scheme", requiredTag: null },
    }),
  );
  const editor = { type: "user", id: "u2" } as const;
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, editor, {
      ruleKey: "R-TWICE", sourceKey: "rule", title: "Second",
      params: { kind: "percent_bps", value: 750, discountCategory: "scheme", requiredTag: null },
    }),
  );
  // Every prior test upserted each key exactly once after a truncate, so the onConflictDoUpdate
  // branch had NEVER executed (M7) — a plain-.insert() mutant passes the whole shipped suite and
  // throws a raw 23505 here instead — killed.
  const rows = await listAdjustmentRules(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.title).toBe("Second");
  expect((rows[0]?.params as { value: number }).value).toBe(750);
  expect(rows[0]?.updatedBy).toBe("u2");
  expect(rows[0]?.createdBy).toBe(actor.id);
});

test("duplicate active caps for one category: the engine resolves to the NEWEST row, deterministically", async () => {
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, actor, {
      ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity cap",
      params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 },
    }),
  );
  await withTx(db, (tx) =>
    upsertAdjustmentRule(tx, actor, {
      ruleKey: "CAP-CHARITY-2025", sourceKey: "manual", title: "Charity cap FY25",
      params: { discountCategory: "charity", maxBps: 500, approvalAboveBps: null },
    }),
  );
  // HONESTY NOTE (discrimination audit): in a fresh table, heap order usually equals insertion
  // order, so an unordered implementation often passes this too. The assertion pins the stated
  // CONVENTION (newest wins, by ULID order); the load-bearing defense against duplicate caps is
  // validateTariffConfig's duplicate_manual_cap error, tested in context.test.ts.
  const { manualCaps } = await loadRuleConfig(db, new Date("2026-09-01T00:00:00Z"));
  expect(manualCaps.charity).toEqual({ maxBps: 500, approvalAboveBps: null });
});
```

  Append to `gst-config.test.ts`:

```ts
test("upserting an existing category UPDATES in place — the CA raising a rate must never hit a raw 23505", async () => {
  await withTx(db, (tx) =>
    upsertGstCategory(tx, actor, { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1200, specialRule: null, thresholdPaise: null }),
  );
  const signer = { type: "user", id: "ca-signer" } as const;
  await withTx(db, (tx) =>
    upsertGstCategory(tx, signer, { category: "pharmacy", sacCode: "3004", exempt: false, rateBps: 1800, specialRule: null, thresholdPaise: null }),
  );
  // The M7 mutant (plain .insert()) throws 23505 on the second call — killed. gstSettings'
  // upsert is already exercised twice by the shipped settings round-trip test; this closes the
  // same gap for categories.
  const rows = await listGstCategories(db);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.rateBps).toBe(1800);
});
```

- [ ] **Step 5: Run to pass.** Fail-first evidence is owed for exactly the two tests named in Step 2; the validFrom pair, the active-false test, and both upsert-UPDATE tests are GREEN against shipped code by nature (the guard and branches exist — the gap was coverage; §3.5, no red owed, kills are the named mutants in the Assertion Book). After Steps 3–4: `exec jest --passWithNoTests rules.test` → **9**; `gst-config.test` → **5**; `context.test` → **8**. Workspace → 68 suites / **380 tests**. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `fix(core): D-17 gate validates the engine's rule set; rules determinism and coverage` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. `validateTariffConfig`'s caps check consumes `loadRuleConfig(db, at)`; deactivating or expiring a cap row flips `ok` to false with `manual_caps_missing` naming the category; the shipped four-breaks test (incl. Break 4's corrupt params) passes UNCHANGED except the sharpened Break-1 detail assertion — proving never-throws survived the switch.
2. `duplicate_manual_cap` is reported for two active in-window caps on one category, and `loadRuleConfig` resolves them newest-wins via `asc(id)` ordering.
3. The `validFrom` guard now has both boundary directions asserted; `active: false` exclusion is asserted against the engine loader AND presence against the admin lister.
4. Both upsert UPDATE branches execute under test with row-count 1 and changed values.
5. Workspace 68 / 380; verify green; no schema change (a needed one is a plan defect to report).

---

### Task 6: Golden suite — g09 made discriminating, g14 added, the manifest pinned  *(opus coder — fixture authoring)*

**Defects:** **M2's fixture half** — `g09-manual-over-cap.json` is NAMED for "records the amount that was ASKED… never clamped" and cannot tell: its ask (percent 2500 of 50000 = 12500) sits below gross, so `Math.min` is a no-op and the clamping implementation passes it identically. **C3** — no fixture anywhere has BOTH `mrpPaise` and `ceilingPaise` below `tariffPaise`; the stress test EXECUTED the mutant `if (b.value < tariffPaise)` and it survived every shipped fixture while billing a drug at the ceiling when the MRP is lower — above the printed MRP. **Findings §13 residual** — the fixture-count assertion is a number, not a manifest: replacing g13 with a renamed copy of g01 stays green.

**Depends on T4 (sequential):** the rewritten g09 asserts `amountPaise: 60000` on the rejected candidate — red against pre-T4 code by design; that is the fixture's teeth, landing only after the code it certifies.

**Files:**
- Modify: `apps/core/src/modules/tariff/golden/fixtures/g09-manual-over-cap.json` (rewritten in full)
- Create: `apps/core/src/modules/tariff/golden/fixtures/g14-regulated-both-bounds.json`
- Modify: `apps/core/src/modules/tariff/golden.test.ts` (count test → manifest test)

**Both audits, run in this document:**

**g09 (rewritten) — Book entry.** Line: svc-cons ×1, manual `{ negotiated_corporate, flat_paise, 60000, "asked too much" }`, CONFIG_A.
*Derivation:* ask = flat **60000** (WHOLE-LINE, owner decision 3); cap negotiated_corporate 2000 bps, exact rational: `60000 × 10000 = 600,000,000 > 2000 × 50000 = 100,000,000` → rejected `over_cap`; candidate records the ASKED 60000 with detail `"60000p exceeds 2000bps of 50000p"`; no valid candidate → winner null, discount 0, taxableBase 50000; consultation `exempt: true` (would-be rate 1800) → heads 0/0; **net 50000**.
*Discrimination:* the clamp-then-record implementation reports `min(60000, 50000) = 50000` in `amountPaise` AND in the detail string — the full deep-equal fails on both. This is the exact mutant the shipped g09 could not see, now killed by the fixture named for it.

**g14 (new) — Book entry.** Config: CONFIG_A plus exactly three additions — services gains `{ "id": "svc-drug-e", "code": "DRUG-E", "name": "Drug E", "category": "pharmacy", "regulated": true, "active": true }`; `tariff.items` gains `"svc-drug-e": 20000`; `regulatedPrices` gains `"svc-drug-e": { "mrpPaise": 10000, "ceilingPaise": 15000 }`. Line: svc-drug-e ×1.
*Derivation:* `unit = min(tariff 20000, mrp 10000, ceiling 15000) = 10000` → clamp `mrp` (**both** bounds strictly below tariff — the first such triple anywhere; mrp < ceiling); gross 10000; no candidates; pharmacy 1200 bps: `head = divHalfUp(10000 × 1200, 20000) = divHalfUp(12,000,000, 20000) = 600` (exact 600.0); **net 10000 + 600 + 600 = 11200**.
*Discrimination:* the executed C3 mutant (`b.value < tariffPaise` instead of `< unitPaise`) walks: mrp 10000 < 20000 → unit 10000/"mrp"; then ceiling 15000 < 20000 **also true** → unit 15000/"ceiling". Mutant output: `unitPaise 15000, boundApplied "ceiling", head = divHalfUp(15000 × 1200, 20000) = 900, net 16800` — three fields differ from the Book's 10000/"mrp"/11200; the deep-equal kills it (matching the stress test's own executed table). The bounds-push-order swap stays observationally identical here and everywhere except an exact mrp == ceiling tie, whose label D2 does not specify — deliberately not pinned (see "NOT fixed" list).

- [ ] **Step 1: Rewrite `g09-manual-over-cap.json`** — full file, CONFIG_A pasted verbatim as `config` (unchanged from the shipped file), `name`: `"manual over cap: rejected and RECORDED at the asked amount, never clamped"`, `specRefs`: `["§7", "D-8"]`, `kind: "price"`, lines: `[{ "lineId": "L1", "serviceId": "svc-cons", "qty": 1, "manualDiscount": { "discountCategory": "negotiated_corporate", "kind": "flat_paise", "value": 60000, "reason": "asked too much" } }]`, expected — one entry whose `workings` carries the Book arithmetic above (including the sentence "a clamping impl records min(60000, gross 50000) = 50000 -> killed") and whose `line` is the complete `PricedLine` literal:

```json
{ "lineId": "L1", "serviceId": "svc-cons", "serviceName": "General consultation", "category": "consultation",
  "qty": 1, "unitPaise": 50000, "grossPaise": 50000, "regulatedClamp": null,
  "candidates": [ { "sourceKey": "manual", "ruleKey": null, "kind": "flat_paise",
    "discountCategory": "negotiated_corporate", "amountPaise": 60000, "reason": "asked too much",
    "requiresApproval": false,
    "rejected": { "code": "over_cap", "detail": "60000p exceeds 2000bps of 50000p" } } ],
  "winner": null, "discountPaise": 0, "taxableBasePaise": 50000,
  "gst": { "sacCode": "999312", "rateBps": 1800, "exempt": true, "exemptReason": "category_exempt", "cgstPaise": 0, "sgstPaise": 0 },
  "netPaise": 50000 }
```

- [ ] **Step 2: Author `g14-regulated-both-bounds.json`** — `kind: "price"`, `name`: `"C-3 both bounds bind: mrp < ceiling < tariff — the min is the MRP, never the ceiling"`, `specRefs`: `["C-3", "§7"]`, config = CONFIG_A with the three additions above (open the shipped `g05-regulated-min.json` on the server as the shape reference; every other config byte identical to CONFIG_A), one line `{ "lineId": "L1", "serviceId": "svc-drug-e", "qty": 1 }`, expected — `workings` carrying the Book arithmetic above (including the mutant walk "b.value<tariffPaise impl picks ceiling 15000 -> net 16800 -> killed") and the complete `line`:

```json
{ "lineId": "L1", "serviceId": "svc-drug-e", "serviceName": "Drug E", "category": "pharmacy",
  "qty": 1, "unitPaise": 10000, "grossPaise": 10000,
  "regulatedClamp": { "boundApplied": "mrp", "tariffPaise": 20000, "mrpPaise": 10000, "ceilingPaise": 15000 },
  "candidates": [], "winner": null, "discountPaise": 0, "taxableBasePaise": 10000,
  "gst": { "sacCode": "3004", "rateBps": 1200, "exempt": false, "exemptReason": null, "cgstPaise": 600, "sgstPaise": 600 },
  "netPaise": 11200 }
```

  **Authoring rule, unchanged from Plan 06 and gate-checkable:** every expected value transcribed from THIS document's Book entries — never produced by running the engine.
- [ ] **Step 3: Replace the count test with the manifest** in `golden.test.ts` (the §13 residual: a count cannot detect a renamed or duplicated fixture; a manifest can):

```ts
test("the fixture set is complete and NAMED — a renamed or duplicated fixture cannot pass, an empty dir never passes vacuously", () => {
  expect(files).toEqual([
    "g01-baseline-exempt.json",
    "g02-perhead-vs-split.json",
    "g03-halfup-direction.json",
    "g04-room-rent-boundary.json",
    "g05-regulated-min.json",
    "g06-regulated-missing.json",
    "g07-contest-three-way.json",
    "g08-contest-tie.json",
    "g09-manual-over-cap.json",
    "g10-flat-approval-flag.json",
    "g11-composite-supply.json",
    "g12-impact-simulation.json",
    "g13-room-rent-postdiscount-ca.json",
    "g14-regulated-both-bounds.json",
  ]);
});
```

- [ ] **Step 4: Run** — `pnpm --filter @hmis/core exec jest --passWithNoTests golden` → 1 suite, **16 tests** (14 fixtures + manifest + mutant), all green. Fail-first evidence for this task: with only the g09 rewrite in place and Step 2 not yet done, the manifest test fails on the missing g14 — run and quote it after Step 3 if authored in that order, or quote the g09 fixture failing against a stashless mental walk — concretely: **the required fail-first run is the manifest test red before g14 exists**; g09's red-vs-pre-T4-code cannot be demonstrated here (T4 already shipped) and its teeth are certified by the Book's mutant walk instead, which the gate re-derives.
- [ ] **Step 5: Whole workspace** — 68 suites / **381 tests**. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `test(core): golden g09 discriminates clamping; g14 pins the two-bound C-3 clamp; fixture manifest` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. The gate re-derives BOTH Book entries by hand from CONFIG_A + D1/D2/D4 and confirms fixture bytes match the Book (derivation audit), then walks both named mutants and confirms each produces a different observable that the deep-equal catches (discrimination audit).
2. g09's ask is `flat_paise 60000` with `amountPaise: 60000` on the rejected candidate; g14's triple is 20000/10000/15000 with clamp `"mrp"`.
3. The manifest test lists exactly the 14 names; no other fixture file changed byte-wise.
4. Workspace 68 / 381; verify green.

---

### Task 7: HTTP coverage — the eight silent routes + the DTO mechanism pin

**Defect (M9):** eight routes have zero test coverage — `PATCH /tariff/services/:id`, `POST /tariff/services/:id/regulated-prices` (**the only door C-3 gazette data can enter the system through**), `GET /tariff/services/:id/regulated-prices`, `GET /tariff/versions`, `GET /tariff/rules`, `POST /tariff/rules`, `GET /tariff/gst`, `PUT /tariff/gst/config/:category` — and `PUT /tariff/gst/settings` appears only as a 403. Plus findings §12.1: the `pricePaise: -1` leg proves nothing about which mechanism produced its 400 (DTO and domain both answer 400).

**Files:**
- Modify: `apps/core/test/tariff.e2e.test.ts` (+2 `it(…)` blocks; one existing leg sharpened)

Route/DTO facts the tests must honour (scout-verified): every listed body shape is in the controller's zod DTOs; `gstCategoryBody` requires `specialRule` and `thresholdPaise` present-but-nullable — the PUT bodies below carry them as `null` explicitly; `POST /tariff/rules` is an UPSERT returning `{ id }` at 201 on create AND on update (shipped semantics, asserted as such); responses: `{ items }`, `{ ok: true }`, `{ id }`, `{ categories, settings }` per the transcribed handlers.

- [ ] **Step 1: The config-routes block** — append inside the describe (uses `auth`, `adminToken`, `readerToken`, `request(app.getHttpServer())` as the shipped tests do):

```ts
  it("config routes over HTTP: rules and GST config round-trip, updates visible on re-read", async () => {
    // POST /tariff/rules creates…
    const created = await request(app.getHttpServer())
      .post("/tariff/rules").set(...auth(adminToken))
      .send({ ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity cap",
              params: { discountCategory: "charity", maxBps: 2500, approvalAboveBps: 1000 } }).expect(201);
    expect(typeof created.body.id).toBe("string");

    const listed = await request(app.getHttpServer()).get("/tariff/rules").set(...auth(readerToken)).expect(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].ruleKey).toBe("CAP-CHARITY");

    // …and UPDATES through the same route (shipped upsert semantics; the M7 branch over HTTP).
    await request(app.getHttpServer())
      .post("/tariff/rules").set(...auth(adminToken))
      .send({ ruleKey: "CAP-CHARITY", sourceKey: "manual", title: "Charity cap v2",
              params: { discountCategory: "charity", maxBps: 3000, approvalAboveBps: 1000 } }).expect(201);
    const relisted = await request(app.getHttpServer()).get("/tariff/rules").set(...auth(readerToken)).expect(200);
    expect(relisted.body.items).toHaveLength(1);
    expect(relisted.body.items[0].title).toBe("Charity cap v2");
    expect(relisted.body.items[0].params).toEqual({ discountCategory: "charity", maxBps: 3000, approvalAboveBps: 1000 });

    // GET /tariff/gst returns both halves (beforeEach seeded consultation + pharmacy + settings).
    const gst0 = await request(app.getHttpServer()).get("/tariff/gst").set(...auth(readerToken)).expect(200);
    expect(gst0.body.settings).toEqual({ compositeHealthcareExempt: true, caSigned: false });
    expect(gst0.body.categories.find((c: { category: string }) => c.category === "consultation").rateBps).toBe(1800);

    // PUT /tariff/gst/config/:category updates in place; PUT /tariff/gst/settings SUCCESS path
    // (previously only its 403 was asserted). specialRule/thresholdPaise are nullable-but-required
    // in the DTO — sent explicitly as null.
    await request(app.getHttpServer())
      .put("/tariff/gst/config/consultation").set(...auth(adminToken))
      .send({ sacCode: "999312", exempt: true, rateBps: 2000, specialRule: null, thresholdPaise: null }).expect(200);
    await request(app.getHttpServer())
      .put("/tariff/gst/settings").set(...auth(adminToken))
      .send({ caSigned: true }).expect(200);

    const gst1 = await request(app.getHttpServer()).get("/tariff/gst").set(...auth(readerToken)).expect(200);
    expect(gst1.body.categories.find((c: { category: string }) => c.category === "consultation").rateBps).toBe(2000);
    expect(gst1.body.settings.caSigned).toBe(true);
  });
```

- [ ] **Step 2: The service/gazette block:**

```ts
  it("service and gazette routes over HTTP: patch visible, regulated rows append and list newest-first", async () => {
    const svc = await request(app.getHttpServer())
      .post("/tariff/services").set(...auth(adminToken))
      .send({ code: "DRUG-1", name: "Drug One", category: "pharmacy", regulated: true }).expect(201);
    const drugId = svc.body.serviceId as string;

    await request(app.getHttpServer())
      .patch(`/tariff/services/${drugId}`).set(...auth(adminToken))
      .send({ name: "Drug One (renamed)" }).expect(200);
    const services = await request(app.getHttpServer()).get("/tariff/services").set(...auth(readerToken)).expect(200);
    expect(services.body.items.find((s: { id: string }) => s.id === drugId).name).toBe("Drug One (renamed)");

    // Gazette ingestion — the ONLY door C-3 data enters through, never before called by a test —
    // plus the same-date correction path, listed newest-first (T3's deterministic order, over HTTP).
    const r1 = await request(app.getHttpServer())
      .post(`/tariff/services/${drugId}/regulated-prices`).set(...auth(adminToken))
      .send({ mrpPaise: 10000, ceilingPaise: 8000, effectiveFrom: "2026-04-01T00:00:00.000Z", gazetteRef: "GZ-1" }).expect(201);
    const r2 = await request(app.getHttpServer())
      .post(`/tariff/services/${drugId}/regulated-prices`).set(...auth(adminToken))
      .send({ mrpPaise: 10000, ceilingPaise: 6000, effectiveFrom: "2026-04-01T00:00:00.000Z", gazetteRef: "GZ-1-corr" }).expect(201);

    const history = await request(app.getHttpServer())
      .get(`/tariff/services/${drugId}/regulated-prices`).set(...auth(readerToken)).expect(200);
    expect(history.body.items).toHaveLength(2);
    expect(history.body.items.map((r: { id: string }) => r.id)).toEqual([r2.body.id, r1.body.id]);
    expect(history.body.items[0].ceilingPaise).toBe(6000);

    // GET /tariff/versions lists what exists.
    const v = await request(app.getHttpServer()).post("/tariff/versions").set(...auth(drafterToken)).send({}).expect(201);
    const versions = await request(app.getHttpServer()).get("/tariff/versions").set(...auth(readerToken)).expect(200);
    expect(versions.body.items.map((x: { id: string }) => x.id)).toContain(v.body.versionId);
  });
```

- [ ] **Step 3: Pin the DTO mechanism on the −1 leg** (findings §12.1). In the existing `"validation walls"` test, capture the `pricePaise: -1` response and add:

```ts
    // Two mechanisms answer 400 on this route — the zod DTO and the domain's invalid_paise. The
    // zod ISSUE SHAPE in the body proves the DTO refused it before any domain code ran (§3.14b);
    // the domain path would carry the string "invalid_paise: …" instead.
    expect(bad.body.message).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "too_small", path: ["pricePaise"] })]),
    );
```

  (`const bad = await request(…)…​.expect(400);` replaces the bare await on that leg.)
- [ ] **Step 4: Run** — `pnpm --filter @hmis/core exec jest --passWithNoTests tariff.e2e` → 1 suite, **9 tests** (the path filter `tariff.e2e` cannot match `tariff-lifecycle.e2e` — one mandatory character between `tariff` and `e2e` — checked per §2.5). Fail-first: Steps 1–2 cover never-executed routes, so their first honest run is green — no red owed (§3.5); the coverage IS the deliverable, and every assertion is a round-trip state read, not a status code (§3.14b). Step 3's sharpened assertion would go red only if the DTO's issue shape were other than claimed — if it does, that is a plan defect to report, not to satisfy by loosening the assertion.
- [ ] **Step 5: Whole workspace** — 68 suites / **383 tests**; `packages/contracts` 3/7 and `apps/web` 11/37 unchanged. Detached root `pnpm verify`.
- [ ] **Step 6: Commit** — `test(core): cover the eight untested tariff routes; pin the DTO mechanism on validation 400s` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. All 17 declared routes are now exercised by at least one test — the gate enumerates route strings against the file and finds none missing.
2. Every new assertion reads state back (list reflects create/update; history ordering by captured ids; settings flip visible) — no assertion is a bare status code.
3. The −1 leg asserts the zod issue shape (`too_small` at `["pricePaise"]`).
4. Workspace 68 / 383; contracts and web byte-untouched for the whole plan; verify green.

---

## Assertion Book — every new/changed assertion, its derivation, and the wrong implementation it kills

The two audits (§"The rule this plan exists to enforce"), consolidated. "Derivation" points at the arithmetic shown in the owning task; "kills" names the mutant and its differing observable.

| # | Task | Assertion | Kills (mutant → wrong observable) | Honesty notes |
|---|---|---|---|---|
| A1 | T1 | cross-version equal-date race: loser = `effective_from_not_monotone`, 1 activated row, 1 event | reverting to the shipped two-lock serializer → both fulfil / 2 activated rows (observed pre-fix); with only the index and no serializer → loser dies as raw 23505, not the typed code | equal dates chosen because unequal dates make "one must lose" FALSE for a correct impl (interleaving-dependent) |
| A2 | T1 | partial-index test: 2nd same-date ACTIVATED insert → pg `23505`; same-date submitted OK; different-date activated OK | dropping the index → all inserts succeed; dropping the `WHERE` → the submitted-row leg fails | `.code` is top-level: drizzle 0.40.1 verified wrapper-free in installed node_modules |
| A3 | T1 | 3 schema uniqueness asserts tightened to `{ code: "23505" }` | any non-constraint error (e.g. an FK or syntax failure) satisfying a bare `toThrow()` | — |
| A4 | T2 | drafter≠submitter: SUBMITTER refused `sod_drafter_activator`, third actor then succeeds | deleting `\|\| actor.id === version.submittedBy` → submitter activates → first assert red | green-first vs shipped code (coverage gap, not code bug) — declared, no red owed |
| A5 | T2 | wrong-subject approval → `approval_subject_mismatch`; vA stays submitted; vB still activates | shipped code (no check) → vA activates on vB's approval (observed pre-fix red) | test writes the column raw — no app path can, which is the finding |
| A6 | T3 | same-date correction wins resolution `{10000, 6000}` | missing `desc(id)` → heap-order winner, typically the stale `{10000, 8000}` | fresh-table heap order ≈ insertion order, so the wrong impl CAN pass runs — declared; A7 + the stated total order carry the kill |
| A7 | T3 | history ids `[r3, r2, r1]` across a 2-service table | `desc(effectiveFrom)`-only → same-date pair `[r2, r3]` in insertion order under typical heap reads | same caveat as A6, opposite direction — the pair is asserted where insertion order and the required order DISAGREE, so heap-order luck now has to be un-lucky twice in opposite directions |
| A8 | T4 | over-gross flat ask records `amountPaise: 60000` + detail `"60000p …"` | clamp-then-record → 50000 in both fields (observed pre-fix red) | maxBps<10000 equivalence proof in T4 preamble — no shipped expectation moves |
| A9 | T4 | `flat_paise 1250.5` → throws `invalid_paise` | unguarded impl → candidate accepted; trace: base 50000−1250.5 = 48749.5, and a half-paise base times any EVEN rateBps yields an integral product, so `divHalfUp`'s guard stays silent → fractional net 54599.5 (observed pre-fix: no throw) | — |
| A10 | T4 | unsorted stub source: winner `R-AAA` | deleting the nulls-last+ruleKey block → stable sort keeps input order → `R-ZZZ` | green-first (block exists; gap was reachability) — declared |
| A11 | T4 | 1 bps on gross 4: candidate recorded at 0, winner null | dropping `&& c.amountPaise > 0` → zero-benefit winner non-null | green-first — declared |
| A12 | T4 | deep-frozen ctx+lines; output equal on 2nd run; JSON snapshot unchanged | any engine mutation of ctx/lines → TypeError under strict mode, or snapshot mismatch as the belt | deepFreeze reaches module fixtures — harmless, stated in the test |
| A13 | T4 | both-bounds-null regulated row → `regulated_price_missing` | shipped engine → prices at bare tariff, net 5600, clamp null (observed pre-fix red) | defense in depth; write path already refuses the shape |
| A14 | T4 | rogue over-gross winner → `invalid_paise` at taxable base | shipped engine → netPaise −10000 returned (observed pre-fix red) | — |
| A15 | T4 | category-exempt + composite context → `exemptReason: "composite_healthcare"` | swapping gst.ts's first two branches → `"category_exempt"`, heads identical 0/0 | green-first — order is correct today; §12.5's exact swap now dies |
| A16 | T5 | deactivated/expired charity cap → `ok:false` + `manual_caps_missing` naming charity | raw-table caps map (shipped) → `ok:true` in both legs (observed pre-fix red) | the M1 kill — the task's centerpiece |
| A17 | T5 | two active charity caps → `duplicate_manual_cap` | shipped gate → silent; and any impl resolving silently | — |
| A18 | T5 | rule with future `validFrom`: excluded before, included AT the instant | deleting the guard → included early; flipping `>` to `>=` → excluded at the boundary | green-first vs shipped code (the guard exists and is correct; the gap was that no test had ever reached it) — declared; the kills are the two named mutants |
| A19 | T5 | `active:false` in lister, absent from loader | dropping the `active` filter → retired discount still applies | green-first — declared |
| A20 | T5 | upsert-twice (rules + gst category): 1 row, new values | plain-`.insert()` mutant → raw 23505 on the 2nd call | green-first — declared; T7 repeats the rules half over HTTP |
| A21 | T5 | Break-1 assertion pinned to detail prefix `active service "SVC-UNPRICED"` | deleting the explicit check → only the smoke entry (`smoke price failed …`) remains → red | closes §12.2's two-producer degeneracy |
| A22 | T5 | duplicate caps: loader yields the NEWEST row's cap | unordered select → heap-order winner | convention-pin; load-bearing defense is A17 — declared verbatim in the test comment |
| A23 | T6 | g09 deep-equal with `amountPaise: 60000` on the rejected candidate | clamping impl → 50000 in amount + detail | the fixture named for the property now enforces it |
| A24 | T6 | g14 deep-equal: unit 10000, clamp `mrp`, net 11200 | `b.value < tariffPaise` mutant → 15000 / `ceiling` / 16800 (the stress test's EXECUTED survivor) | push-order swap stays equivalent except an unspecified mrp==ceiling tie label — deliberately unpinned |
| A25 | T6 | manifest deep-equals the 14 literal names | renamed-copy / duplicate / truncated dir → list mismatch (a count catches only the last) | — |
| A26 | T7 | 8 routes exercised with round-trip state reads | route deletion/misbinding → reads fail; status-only assertions would not notice a wrong handler | first runs green by nature (coverage) — declared |
| A27 | T7 | −1 paise leg carries zod issue `{ code: "too_small", path: ["pricePaise"] }` | DTO removed/bypassed → domain string body (`"invalid_paise: …"`) → shape assert red | closes §12.1's two-mechanism 400 |

---

## Self-review — what this plan's own stress passes caught before commit

**Pass 1 (every block read as compiler + test runner):**
1. **The intuitive cross-version race test is itself a §3.13 flake.** A Jan/Mar two-date race asserting "exactly one wins" FAILS a correct implementation whenever the earlier date wins the lock (the later activation is then legal). Caught while designing T1; the plan pins the equal-date form, whose loser code is deterministic on every interleaving, with the trace naming a lock predicate that matches two rows in the test's own starting state (§3.21 discipline).
2. **M2's minimal fix ("record raw") leaves the cap CHECK on the clamped amount — which silently ACCEPTS an over-gross ask at a 100% cap** (`maxBps: 10000` is legal in `manualCapParamsSchema`), the precise "silently clamped" behaviour D3 forbids. The plan moves check AND record to the raw ask, with the proof that nothing changes for any `maxBps < 10000` (so zero shipped expectations move).
3. **M1's obvious fix breaks the shipped never-throws regression.** Building the gate's caps from `loadRuleConfig` makes Break 4's corrupt-params row THROW (`.parse` by design). Caught by walking `context.test.ts` Break 4 against the new code; the plan wraps the call and lets the loop's already-recorded `invalid_rule_params` carry the diagnosis.
4. **T3 would strand three controller imports** (`desc`, `eq`, `regulatedPrices`) that exist solely for the moved route — an ESLint unused-var failure invisible until verify. The import pruning is a named step, not an afterthought.
5. **T1's fail-first evidence has an ordering dependency:** if migration 0008 lands before the code fix is demonstrated red, the pre-fix double-activation surfaces as a 23505 instead — a different failure signature that would confuse the fail-first quote. Steps ordered test → red runs → code fix → schema → migration.
6. **A regulated row with both bounds null silently no-ops the C-3 clamp inside the engine** — not in the findings document at all; found by walking `pricing.ts`'s bounds loop (empty array ⇒ no clamp, no error). Closed in T4 as defense in depth (the write path already refuses the shape), per owner decision 5's no-CHECK-constraints scoping.
7. **The findings' proposed C-3 fixture arithmetic** (head 600, net 11200) re-derived and confirmed; the mutant's counter-observable (900/16800) computed independently and matched against the stress test's executed table.

**Pass 1 also caught three defects in THIS document's own first draft, fixed before commit:** T5's steps originally put both implementation blocks before the failing tests (the §3.5 red-first ordering this ledger exists to enforce — renumbered, with the execution-order rule stated in the task); the rules upsert-UPDATE test asserted `createdBy` against a hardcoded user id from a *different* test file's convention that was never verified in `rules.test.ts` itself (§3.20's shape — now asserted against `actor.id`, self-referential); and T1's index test was titled "failing-then-passing" when by its step the migration is already applied and no red run is possible (retitled and declared green-first).

**Pass 2 (every consumed surface scout-verified against `/opt/hmis` at `8e9f4a1` — three read-only transcription scouts, full files, not summaries):**
8. **Both facts flagged for re-verification held:** `loadPricingContext` takes `Db` (not `Tx`) and runs outside any caller transaction; `toHttp`'s fallthrough maps every unlisted `TariffErrorCode` to 409 — so T2 needs no controller edit.
9. **drizzle-orm 0.40.1 does not wrap query errors** — no `DrizzleQueryError` exists anywhere in the installed package (`errors.js` exports only `DrizzleError`/`TransactionRollbackError`), so `rejects.toMatchObject({ code: "23505" })` reads the raw pg `DatabaseError` and is safe. Settled by grep of the server's `node_modules`, not release notes.
10. **Test dialect split confirmed** (`it` in `versions.test.ts`/e2e, `test` elsewhere) and per-file counts taken from source, so every task's count criterion is per-suite and checked against files the task itself adds (§2.5 — no task adds a test FILE, so no narrowing regex can drift; `tariff.e2e` proven unable to match `tariff-lifecycle.e2e`).
11. **`gstCategoryBody` requires `specialRule`/`thresholdPaise` present-but-nullable** — T7's PUT bodies carry explicit `null`s; a body omitting them 400s and would have burned a coder attempt.
12. **The partial-index syntax and its emitted SQL** verified against both shipped precedents AND their generated migrations (0004:70, 0006:112); `schema/tariff.ts`'s missing `sql` import confirmed; journal idx 7 → next is 0008.

---

## Test-count ladder (per-workspace, `apps/core`; contracts 3/7 and web 11/37 fixed throughout)

360 → **T1** 362 (versions 9→10 · schema/tariff 3→4) → **T2** 364 (versions →12) → **T3** 366 (services 6→8) → **T4** 373 (contest 15→19 · pricing 8→10 · gst 7→8) → **T5** 380 (rules 5→9 · gst-config 4→5 · context 6→8) → **T6** 381 (golden 15→16 runtime) → **T7** 383 (e2e 7→9). Suites stay at **68**: no task adds a file jest collects as a suite (g14 is a fixture JSON).

---

## Pipeline Notes (for /execute compilation — do not execute without owner approval)

- **Split:** Pipeline A = T1–T4, Pipeline B = T5–T7 (roadmap: ≤ 6 tasks per Workflow). **Strictly sequential within each**; B starts only after A's outcomes are recorded. Shared-file chain: `versions.ts`/`versions.test.ts` T1→T2 · T6's g09 asserts T4's contest semantics · T7's history-order assertion consumes T3's accessor ordering.
- **Tier map:** sonnet coders with **opus overrides on T1** (concurrency + the plan's only migration) **and T6** (golden fixture authoring — the Plan 06 precedent); **opus gate on every task**. T4 stays sonnet deliberately: its diffs are small and this document carries the exact blocks and the semantics proofs.
- **Cost calibration:** Plan 06's observed clean-task rate was **130–200k tokens including the gate**; seven tasks ⇒ **~0.95–1.4M work estimate**. Plus an **explicit infrastructure contingency of ~0.3–0.5M** — Plan 06's three harness stalls and one network outage cost ~554k, the single largest line item of that run; the ledger's instruction is to budget it, not to hope. **Total budget: ~1.3–1.9M subagent tokens; treat ~1.5M as the expected midpoint.** Wall clock ~2–3h across both pipelines at Plan 06's observed pace.
- **Frozen paths while pipelines run:** `apps/web/**`, `packages/contracts/**`, `apps/core/src/modules/patients/**` (esp. `qr.test.ts`), `.github/workflows/**` (tripwire 10), all of `apps/core/src/kernel/**` EXCEPT `kernel/db/schema/tariff.ts` + its test (T1 only); `drizzle/**` T1 only; `modules/tariff/index.ts` BYTE-FROZEN for the whole plan; also untouched: `app.module.ts`, `apps/core/package.json`, `README.md`, `test/helpers/db.ts`, `simulation.ts`(+test), `tariff-lifecycle.e2e.test.ts`, `scripts/**`, `manifest.ts`, `tariff.module.ts`, `events.ts`, `money.ts`, `fixture-schema.ts`.
- **Migration rule:** exactly one (T1, `0008`). Any later schema need = chain halt + plan-defect report.
- **Compile rules (from EXECUTION-LESSONS):** §1 tripwires **1–19 verbatim at the TOP of every brief** · briefs point at this committed plan on the server, never restate its code · baseline = "the previous task's commit, i.e. current `origin/main`" (§2.6) · per-suite counts only, with narrowing filters pre-checked against each task's own files (§2.5 — done in this document) · FINISH block = three numbered steps (§3.8) · gate verdicts carry `retry_mode` (§2.2) · no correction may direct a history rewrite (tripwire 15/§2.4) or security-code removal (tripwire 14) · race evidence only via `exec jest … -t` with isolation read from OUTPUT (tripwire 19; the isolation requirement sits in the gate prompt too) · after any infrastructure halt, check whether the dead agent committed or pushed before resuming and convert to a verify-only rung if it did (Plan 06 §7.4) · deviations-not-to-fix list in every brief: all gate-report 01–06 §4/§5 items incl. the `code: message` HTTP prefix (owner-ratified), plus `qr.test.ts`'s 1-in-4096 flake — not this plan's file.
- **Fail-first discipline for this plan specifically:** T1 (race), T2 (subject mismatch), T3 (determinism, best-effort ×5), T4 (four of seven), T5 (two of seven) carry genuine red-first evidence owed by the ORIGINAL attempt; every assertion this plan adds that is GREEN against shipped code is individually declared as such in its task with the mutant that certifies it instead (§3.5 — no manufactured red states, ever; tripwire 14 stands).
- **Carried forward to Plan 08 authoring (not this plan's work):** the findings §14 friction list (invoice totalling, `rounding_paise` column, discount-override approval type, credit lines, version pin at bill-open) and the owner rulings still needed on **TCS, cess, reverse charge, and B2B invoices to GST-registered patients**.
- **Events note:** no new event names; `duplicate_manual_cap` is a ConfigError string. The dispatcher remains unscheduled until Plan 11; nothing here wires consumers.







