# Plan 06 — Post-Ship Adversarial Stress Test: Findings

**Run:** 2026-08-14, immediately after Plan 06 shipped. Four independent read-only audit agents, ~613k subagent tokens, against `/opt/hmis` at commits `207a95e`–`6483c2d`.
**Status of this document: EVIDENCE, not a plan.** It records what was found and how it was proven. What to do about it belongs in a plan.

Lenses: ① test teeth (opus) · ② engine correctness (opus) · ③ state machine + approvals (sonnet) · ④ Plan 08 readiness (sonnet).

Nothing in this document was fixed. The module was green, CI-clean, and 68 suites / 360 tests passing at the time of the audit, and remained so.

---

## Summary

**Four CRITICAL findings. Four are live code defects; two are test gaps where the shipped code is correct but undefended.** (The counts overlap: C1 and C2 are both code and test gaps.)

| # | Severity | Finding | Kind |
|---|---|---|---|
| C1 | CRITICAL | Two *different* tariff versions can activate concurrently; monotonicity violated; a newer version's price permanently shadowed | code, **reproduced** |
| C2 | CRITICAL | `resolveRegulatedPrices` has no tie-break — the NPPA ceiling is nondeterministic on same-date gazette rows | code |
| C3 | CRITICAL | The C-3 clamp is never tested where two bounds both bind; a plausible mutant bills **above MRP** | test gap, **mutant executed** |
| C4 | CRITICAL | SoD's "not the submitter" clause is never exercised; deletable undetected | test gap, **mutant executed** |
| M1 | MODERATE | The D-17 go-live gate can print `ok=true` while every charity discount silently fails | code |
| M2 | MODERATE | Over-cap rejections record the clamped amount, not the amount asked; `g09` is vacuous on that exact property | code + fixture |
| M3 | MODERATE | `manualDiscount.value` is the one money input never asserted; fractional paise can reach `netPaise` | code, latent |
| M4 | MODERATE | Duplicate manual-cap rows for one category resolve nondeterministically | code |
| M5 | MODERATE | `loadRuleConfig`'s `validFrom` guard is never reached by any test | test gap |
| M6 | MODERATE | `runContest`'s ruleKey tie-break is shadowed by `standingRuleSource`'s own pre-sort | test gap |
| M7 | MODERATE | Neither `upsertAdjustmentRule` nor `upsertGstCategory` ever executes its UPDATE branch | test gap |
| M8 | MODERATE | `active: false` rules are never proven excluded | test gap |
| M9 | MODERATE | Eight controller routes have zero coverage, including gazette ingestion | test gap |
| M10 | MODERATE | `activateVersion` never verifies the approval belongs to this version | design gap |
| M11 | MODERATE | Drafter-as-approver is unblocked (in-spec v1 limitation) | control-design |

Plus 6 MINOR findings (§5) and a Plan 08 readiness assessment (§7).

---

## 1. C1 — Concurrent activation of two different versions is not serialized

**`apps/core/src/modules/tariff/versions.ts:190-208`**

`select id from tariff_versions where status = 'activated' for update` locks **zero rows when nothing has activated yet**. Two sessions activating two *different* submitted versions therefore both lock nothing, both see an empty activated set in the monotonicity re-check, and both commit.

**Reproduced**, not reasoned: the auditor replicated the exact SQL sequence with two independent raw `pg` client sessions. v1 (versionNo 1) activating at `2026-03-01` and v2 (versionNo 2, the newer revision) at `2026-01-01` **both succeeded**, leaving two activated rows with non-monotone dates.

Downstream, also verified: `resolveActiveTariffVersion` picks the greatest `effectiveFrom <= at`, so **every date after 2026-03-01 resolves to v1** — the newer revision is live only for the Jan-1→Mar-1 window and then permanently reverts to the stale price.

The target-row lock added during Plan 06's T4 gate catch protects same-version races only; it does nothing for two different rows.

**Test coverage:** none. The existing race test activates the *same* version twice.
**Note:** `versions.ts:184-189`'s comment explicitly claims the activated-set lock "still serializes against any OTHER version's concurrent activation." That claim is false and must be corrected along with the code.
**Proposed fix:** serialize on something that exists before either transaction commits. A single ordered lock over `status IN ('submitted','activated')` is sufficient — the version being activated is itself `submitted`, so the set is never empty. **Do not** keep the target-row lock alongside it: row-then-set ordering deadlocks (A holds v1 wanting v2, B holds v2 wanting v1 → Postgres `40P01`). A partial unique index on `(effective_from) WHERE status='activated'` is a structural backstop for the equal-date case.

## 2. C2 — The NPPA ceiling is nondeterministic

**`apps/core/src/modules/tariff/services.ts:104-115`** (and the same ordering at `tariff.controller.ts:202`)

`.orderBy(desc(regulatedPrices.effectiveFrom))` with a first-row-per-service reduction. The ordering is **partial**: rows sharing an `effectiveFrom` come back in Postgres heap order, which changes after any VACUUM, plan change, or parallel scan.

**Why it is reachable, not theoretical:** `regulated_prices` is append-only by design (`services.ts:64-65` — a gazette revision *must* be a new row, never an UPDATE), and `effectiveFrom` is a gazette **calendar date**. "We typed the ceiling wrong; append the corrected row for the same gazette date" is therefore the system's **normal correction path**, and there is no way to correct a same-date row without creating the collision.

**Concrete:** `svc-drug-b`, tariff 9000. Row A `effectiveFrom 2026-04-01, ceiling 8000`; Row B (correction, same date) `ceiling 6000`. The resolver may return 8000 → `unitPaise = min(9000, 8000) = 8000` with `regulatedClamp.boundApplied = "ceiling"`. **The line bills ₹20/unit above the notified ceiling while recording that the hard block was applied** — a DPCO violation carrying its own compliance attestation.

**Contrast:** the sibling resolver `versions.ts:244` has the identical shape but is safe, because activation enforces strict monotonicity. `regulated_prices` got neither monotonicity nor a tie-break.
**Test coverage:** none — `services.test.ts:72` and `context.test.ts:226` use distinct dates only.
**Proposed fix:** `.orderBy(desc(effectiveFrom), desc(id))` — ids are ULIDs, so descending is last-inserted-wins. Both call sites.

## 3. C3 — The C-3 clamp mutant survives every fixture

**`apps/core/src/modules/tariff/pricing.test.ts:92`** and **`golden/fixtures/g05-regulated-min.json`**

All three regulated fixtures are `drug-a{t:12000, mrp:10000, ceil:15000}`, `drug-b{t:9000, mrp:10000, ceil:8000}`, `drug-c{t:7000, mrp:10000, ceil:8000}`. **In no fixture anywhere are both `mrpPaise` and `ceilingPaise` below `tariffPaise`.**

**Mutant executed.** Changing `pricing.ts:31` from `if (b.value < unitPaise)` to `if (b.value < tariffPaise)`:

```
drug-a   correct {unit:10000, rec:"mrp"}     mutant {unit:10000, rec:"mrp"}      SURVIVES
drug-b   correct {unit:8000,  rec:"ceiling"} mutant {unit:8000,  rec:"ceiling"}  SURVIVES
drug-c   correct {unit:7000,  rec:null}      mutant {unit:7000,  rec:null}       SURVIVES
mrp<ceiling<tariff  correct {unit:10000,"mrp"}  mutant {unit:15000,"ceiling"}    KILLED
```

Because `bounds` is pushed `[mrp, ceiling]`, the mutant **charges the ceiling when the MRP is lower** — billing a regulated drug above its printed MRP. Swapping the two `bounds.push` lines is equally undetected. This is the invariant the file comment calls *"the hard block IS the min."*

**Proposed fix:** one more drug — `tariff 20000, mrp 10000, ceiling 15000` → expect `unitPaise 10000`, `boundApplied "mrp"`. Hand-derived net: `head = divHalfUp(10000 × 1200, 20000) = 600`; `net = 11200`.

## 4. C4 — SoD's submitter clause is never exercised

**`apps/core/src/modules/tariff/versions.test.ts:140`**, mirrored at **`apps/core/test/tariff.e2e.test.ts:298`**

`mkDraft` calls `createDraftVersion(tx, drafter, …)` and the test then calls `submitVersion(tx, drafter, …)`, so `createdBy === submittedBy === drafter` in **every** SoD test in the module. The two disjuncts of `versions.ts:176` are therefore indistinguishable.

**Mutant:** delete `|| actor.id === version.submittedBy`. Both tests stay green. Real consequence: a supervisor who submits someone else's draft can then activate it themselves — a straight governance bypass on a Class-A approval. Given the error code is literally named `sod_drafter_activator`, "forgot the submitter" is the *most* plausible way to write that line wrong.

**Credit where due:** the *ordering* discipline in these tests (granting approval **before** the blocked attempt; explicitly granting `tariff.versions.activate` to the drafter in the e2e) is exactly right and is the correct fix for the recorded unreachable-mechanism defect. This gap is orthogonal.
**Proposed fix:** one test where drafter ≠ submitter, asserting the **submitter** is refused and a third actor then succeeds.

## 5. M1 — The D-17 gate checks rows the engine will never load

**`apps/core/src/modules/tariff/context.ts:133-158`**

`validateTariffConfig` builds its caps map from `listAdjustmentRules(db)` — **every row in the table**. The engine builds its from `loadRuleConfig(db, at)`, which filters `active = true` and the `validFrom`/`validTo` window. The gate and the engine disagree about what config exists.

**Concrete:** take the fully-seeded config, then set the `CAP-CHARITY` rule `active: false` (the shipped `POST /tariff/rules` accepts `active`). `validateTariffConfig` returns `{ ok: true, errors: [] }`, `validate:tariff` exits 0, the pre-go-live report is clean. At the counter `ctx.manualCaps["charity"]` is `undefined`, so **every charity waiver returns `rejected: unknown_category` with `discountPaise: 0`** and the patient is billed full price. The same hole opens by itself when a cap row's `validTo` passes.

This is the gate's single stated job (D7: "all four D-8 categories have manual caps") and it is checking the wrong set of rows.
**Test coverage:** none — `context.test.ts:251` breaks the config four ways; none is an inactive or expired row.
**Proposed fix:** build the caps map from `loadRuleConfig(db, at)`, the same function the engine uses. (The `invalid_rule_params` loop has the mirror-image discrepancy in the harmless direction.)

## 6. M2 — Over-cap rejections record the clamped amount, and `g09` cannot tell the difference

**`apps/core/src/modules/tariff/contest.ts:31,39-41`**, contract at **`types.ts:27`**

`const amount = Math.min(raw, grossPaise)` runs **before** the cap check, and the rejected branch records `amount`, not `raw`. `types.ts:27` specifies *"for rejected candidates: the amount that was ASKED (audit)"*; D3 says over-cap candidates are *"recorded as rejected, never silently clamped."*

**Concrete:** gross 50000, manual `{charity, flat_paise 60000}`, cap 2500bps. Recorded: `amountPaise 50000`, detail `"50000p exceeds 2500bps of 50000p"`. Correct: `60000`. Money is unaffected (an over-gross ask is rejected either way for any `maxBps < 10000`); the **D-8 defensibility record an over-discount investigation reads** understates the attempt by ₹100.

**The fixture problem, which is the more important half.** `contest.test.ts:136` and `golden/g09-manual-over-cap.json` are both **named** for this property — *"records the amount that was ASKED… never clamped"* — and both use `percent_bps 2500` of 50000 = 12500. Since 12500 < 50000, `Math.min` is a no-op, so **both assertions pass identically under the clamping and non-clamping implementations.**

Plan 06's Fixture Book rule 3 states: *"no fixture where both the right and a wrong implementation produce the same observable."* **G09 violates that rule, on the exact property it is named after.** Hand-derivation guarantees a fixture is not circular; it does not guarantee it is discriminating. Those are two separate audits and Plan 06 ran only the first.

**Proposed fix:** record `raw` on the rejected branches; change G09 to `flat_paise 60000`.

## 7. M3 — `manualDiscount.value` is never asserted

**`apps/core/src/modules/tariff/contest.ts:30-31`**, **`pricing.ts:40-42`**

`priceInvoiceLines` asserts `line.qty`, `tariffPaise` and `grossPaise`. It never asserts `line.manualDiscount.value`, and never asserts `taxableBasePaise`.

**Traced and numerically verified:** gross 50000, taxable at 1200bps, `{charity, flat_paise 1250.5}`, cap 2500bps → accepted; `discountPaise 1250.5`; `taxableBasePaise 48749.5`; `taxHead(48749.5, 1200)` → `n = 58,499,400`, **which is a safe integer**, so `divHalfUp` does not throw → head 2925; **`netPaise = 54599.5`** — a fractional-paise line headed for a `bigint` column.

The module's only float defence is `Number.isSafeInteger` on the *product* inside `divHalfUp`, and a `.5`-paise base times any **even** `rateBps` yields an integral product — defeating the guard at exactly the rates in use (500, 1200, 1800). On an **exempt** category `taxHead` is never reached at all.

**Scope, honestly:** the shipped HTTP boundary is safe (`z.number().int().min(1)`), as is the fixture schema. The exposed caller is the direct programmatic import — i.e. **Plan 08**. MODERATE today, CRITICAL the day Plan 08 wires a non-controller path.
**Proposed fix:** `assertPaise(md.value, …)` before computing `raw`; `assertPaise(taxableBasePaise, …)` as the belt.

## 8. M4, M5, M6, M7, M8 — determinism and coverage in the rules path

- **M4** `rules.ts:120-142` — `loadRuleConfig` selects with no `ORDER BY` and assigns caps last-write-wins. The unique index is on `rule_key` only, so two active `manual` rows both declaring `charity` are creatable through the shipped API. Gross 50000, charity ask 2000bps: accepted if `CAP-CHARITY (2500)` lands last, rejected `over_cap` if `CAP-CHARITY-2025 (500)` does. Same invoice, two answers. Note the contrast: `contest.ts:10` deliberately sorts so the standing-rule contest is order-independent; that discipline was not applied here.
- **M5** `rules.test.ts:127` — the only validity test queries at `2026-03-01` and `2026-09-01`, both **after** `validFrom`, so `rules.ts:124`'s `continue` never executes in any test. Deleting the line makes a campaign discount configured to start next month apply today. Flipping `>` to `>=` also passes, contradicting the stated "equal is included" convention.
- **M6** `contest.test.ts:166` — the intra-source ruleKey tie-break is shadowed by `standingRuleSource`'s own pre-sort (`contest.ts:10`), and `Array.prototype.sort` is stable, so deleting `contest.ts:61-64` entirely still yields `R-AAA`. **Executed and confirmed.** A stub source returning `[R-ZZZ, R-AAA]` in that order is the only way to reach those lines.
- **M7** `rules.test.ts:19`, `gst-config.test.ts:20` — every test upserts each key exactly once after a truncate, so `rules.ts:86` and `gst-config.ts:45`'s `onConflictDoUpdate` branches are **never executed**. Replacing both with a plain `.insert()` passes the whole suite; in production the CA raising a GST rate gets a raw 23505. (`gstSettings`'s upsert *is* exercised twice and is correspondingly sound — the contrast is what makes this a gap.)
- **M8** — no test in the repo ever sets `active: false`, so removing `loadRuleConfig`'s `.where(eq(active, true))` is undetected: a retired discount keeps applying.

## 9. M9 — Eight routes with zero coverage

Never called by any test: `PATCH /tariff/services/:id` · **`POST /tariff/services/:id/regulated-prices`** · `GET /tariff/services/:id/regulated-prices` · `GET /tariff/versions` · `GET /tariff/rules` · `POST /tariff/rules` · `GET /tariff/gst` · `PUT /tariff/gst/config/:category`. `PUT /tariff/gst/settings` appears only as a 403 assertion; its success path is never exercised.

The C-3 clamp data that C2 and C3 are about can only enter the system through `POST /tariff/services/:id/regulated-prices` — **a route no test has ever called.**

## 10. M10 — `activateVersion` never verifies the approval is for this version

**`versions.ts:161-173`** — `getApproval(db, version.approvalId)` checks only `approval.status`, never `subjectType === "tariff_version" && subjectId === versionId`. `approvalId` is plain text with no FK (deliberate, per the `patient_merge_requests` precedent), so nothing enforces the binding at the DB layer either.

**Not exploitable today:** `versions.ts` is the only file that writes that table, `versions.ts:136` is the only site that sets `approvalId`, and it always sets it to an approval it just created for that same version. The invariant holds *by construction*, and `merge.ts` (the cited precedent) has the same shape.
**Why still worth closing:** it is a trust-the-invariant design with zero structural defense against any future admin tool, data-fix script, or later-plan bug that writes the column. Two lines close it: assert the subject match, throw a new distinct code.

## 11. M11 — Drafter-as-approver

**`versions.ts:175-181`** + **`kernel/approvals/decisions.ts:55`**. The engine's `assertNotSodPair(REQUESTER_APPROVER_PAIR, …)` compares the **requester** (whoever called `submitVersion`) against the decider. If A drafts and prices, B merely submits, and A holds the `owner` approver role, nothing stops A approving their own priced draft — only activation is checked against `createdBy`/`submittedBy`, so a third person C is a pure rubber stamp.

**In-spec:** D5 enumerates exactly the checks the code has, and the code comment defers the §10.4 two-key upgrade to definition data. This is a documented v1 limitation, not an implementation bug. Named here because in the most likely real deployment — a solo owner who both sets prices and holds the sole approver role — the entire approval step reduces to two rubber stamps around one person's decision.

---

## 12. MINOR findings

1. `tariff.e2e.test.ts:253` — the `pricePaise: -1` leg proves nothing about ordering: the DTO gives 400, and the domain path (`invalid_paise` → `VALIDATION_CODES`) also gives 400. Two mechanisms, one observable. Assert a Zod issue shape instead.
2. `context.test.ts:316` — Break 1's `tariff_item_missing` has two producers (the explicit check and the smoke-price loop); deleting the explicit check leaves it green. Breaks 2 and 3 are single-sourced and sound.
3. `schema/tariff.test.ts:34` — three bare `rejects.toThrow()` where `toMatchObject({ code: "23505" })` was available; any constraint violation satisfies them.
4. `pricing.test.ts:165` — `Array.isArray` / `not.toBeInstanceOf(Promise)` are type-level restatements, and `Object.freeze` is shallow (`ctx.tariff.items` stays mutable). Deep-freeze and assert non-mutation instead.
5. `gst.test.ts` — no test bills a **category-exempt** service as `composite_healthcare`, so swapping `gst.ts`'s first two branches is undetected. Both give zero heads; only `exemptReason` differs.
6. `contest.ts:55` — no test produces a zero-amount candidate, so dropping `&& c.amountPaise > 0` would put a zero-benefit discount line on an invoice. A rule at 1bps on gross 4 gives `divHalfUp(4, 10000) = 0`.

**Dead/unreachable branches enumerated** (not defects, do not write tests for these): `contest.ts:8`, `contest.ts:58-59`, `contest.ts:61-63` (with shipped sources), `simulation.ts:47`, and five `versions.ts` error paths.

---

## 13. Areas traced and found SOUND — do not re-litigate

- **Integer overflow is not reachable.** `divHalfUp`'s `isSafeInteger` guard is stronger than it looks: any product exceeding 2⁵³−1 rounds to a float ≥ 2⁵³ and is rejected, and `2 * n` is exact in binary floating point at every magnitude. Thresholds: `percentAmount` throws above gross ≈ **₹9.0 × 10⁹**, `taxHead(·, 1800)` above base ≈ **₹5.0 × 10¹⁰**. No hospital invoice line approaches this. *(Owner accepted 2026-08-14: no work.)*
- **All 33 `noUncheckedIndexedAccess` guards are correct, with no falsy-zero bug.** The two places where `0` is legal are explicitly `=== undefined` / `=== null`: `pricing.ts:18` (a service priced at 0 paise survives) and `gst.ts:15` (a 0 threshold survives).
- **No floats.** A sweep for `Math.round|ceil|abs|pow`, `toFixed`, `parseFloat`, division, `* 0.` and `z.coerce` across all nine files returned one hit: a comment saying not to use `z.coerce`.
- **Purity holds.** Nothing mutates its inputs; `standingRuleSource` copies before sorting; `runContest` sorts a fresh `.filter()` result; `simulation.ts` mutates only its own accumulators. (One aliasing note: `winner` is the same object reference as one element of `candidates`.)
- **`simulateRevision`'s index zip is safe** — both arrays come from a 1:1 `.map` over the same lines. `aggregateByService` is correct for repeated services and duplicate lineIds.
- **GST decision order is exactly D4**; no input produces the wrong `exemptReason` where two grounds coincide (the higher-priority ground is reported, which is what a decision order means).
- **The golden harness cannot pass vacuously.** Probed directly: `expected: []`, a missing `line` key, `workings` under 20 chars, `lines: []`, `specRefs: []`, and a missing `kind` are all schema-rejected; a malformed file fails at collection time because `parse` runs at module load; an absent file fails the count. **One residual gap:** the count is a number, not a manifest — replacing `g13` with a renamed copy of `g01` keeps it green.
- **`expect.assertions` is present everywhere it is needed** across the module.
- **Double-submission is closed** — verified with two concurrent `submitVersion` calls: exactly one wins, loser gets `not_draft`, exactly one approval row.
- **Rejected versions cannot be resubmitted, edited or activated**, and no code path moves a version backward. There is no `tariffItems` delete function at all, so the empty-version guard cannot be bypassed post-submit.
- **`tariff.revision_applied` cannot double-emit** — the append sits inside the same `withTx`, after the single-winner UPDATE.

**Nine tests were named as genuinely well-built**, several being direct correct responses to the recorded defect class: `gst.test.ts:35`+`:43` (the composite counterfactual pair), `golden/g11`, `contest.test.ts:143` (tie asserted from both orderings), `golden/g12` (insertion order deliberately ≠ sorted order; tax delta negative while net delta positive), `money.test.ts:5-19` (half cases at even parity so banker's and truncation both disagree), `golden/g13`, the SoD ordering discipline, `services.test.ts:72`, and `toHttp`'s code-folding.

**Audit scale:** 91 runtime tests examined; **64 judged sound**; 48/48 DB-free tests executed green. The DB-backed suites were not executed (creating databases was forbidden), so findings on those are from code tracing.

---

## 14. Plan 08 readiness

**No BLOCKERS.** Nothing in the frozen `index.ts` needs to change for Plan 08 to be authored against it.

**FRICTION to budget for:**
1. **Invoice-level totalling has zero engine support.** `PricedLine` is per-line; there is no invoice total type, no tax summary grouped by `(sacCode, rateBps, exempt)` for GSTR-1, no taxable-vs-exempt turnover split for Rule 42/43. `roundTotalToRupee` takes one number and nothing sums `PricedLine[]` into it. Correctly Plan 08's layer — but it is real work, not "call reduce once."
2. **No rounding-difference field or convention** anywhere. *(Owner decided 2026-08-14: a dedicated `rounding_paise` column on Plan 08's invoice table.)*
3. **No approval type registered for discount overrides.** `AdjustmentCandidate` carries amount/reason/category/`requiresApproval`; `requestApproval` needs `patientId` or `payeeId` when `amountPaise` is set, which the candidate correctly does not carry. Follow the `tariff_revision` runbook pattern.
4. **No negative-qty / credit-line support** (`pricing.ts:13` requires `qty > 0`), and **flat-discount pro-ration on partial refund is undefined**. *(Owner decided 2026-08-14: `flat_paise` is WHOLE-LINE.)*
5. **`loadPricingContext` and `activateVersion` take `Db`, not `Tx`.** Plan 08 cannot load context inside its invoice-persist transaction; it must load, price purely, then open a transaction. That is the correct pattern, but the version resolved at load time could in principle be superseded before persist — pin the resolved `tariff.versionId` at bill-open and document it.
6. **Carried debt Plan 08 should know about:** the `code: message` HTTP prefix *(owner-ratified 2026-08-14 as the contract)*, and `GET /tariff/services/:id/regulated-prices` querying the table directly.

**Deliberately out of Phase-1 scope, documented:** IGST / inter-state supply (plan §D4; the hospital bills at the hospital). **Handled, not a gap:** HSN vs SAC — one shared column with an explicit comment. **Deferred by sequencing, not homeless:** the IPD tariff pin has nowhere to be stored because IPD admission does not exist anywhere in Phase 1; the capability ships, the storage arrives with the feature.

**Unnoticed gaps for an OPD counter, neither deliberate nor covered** — worth an explicit owner ruling before Plan 08: **TCS, cess, reverse charge, and B2B invoices to a GST-registered patient**. Advance receipts ride the same IPD deferral.

---

## 15. Rounding: no defect, but two numbers Plan 08 must be handed

Half-up is applied consistently and only from `divHalfUp`. There is one legitimate rounded-feeds-rounding chain (the rounded discount forms the tax base) — that is D2's frozen order, not drift. Two consequences of the per-line policy are real and undocumented:

1. **Per-line and per-invoice tax will not reconcile.** Three lines each with base 18875 at 1200bps: summing per-line heads gives **3399**; taxing the invoice-level base once gives **3398**. GSTR-1 is filed at invoice level, so **Plan 08 must sum the engine's line heads and never recompute from the invoice total.**
2. **`cgst + sgst ≠ divHalfUp(base × rateBps, 10000)` at odd rates.** Base 33333 at 500bps: two independent heads sum to **1666**; total-then-split gives **1667**. This is the deliberate D1/G02 choice, but any invoice-level "total GST" recomputation will disagree by a paise.
