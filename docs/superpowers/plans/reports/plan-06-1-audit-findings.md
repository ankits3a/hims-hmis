# Plan 06.1 — Post-Ship Adversarial Audit: Findings

**Run:** 2026-08-14/15, immediately after Plan 06.1 shipped. Two independent read-only auditors (opus) against `/opt/hmis` at `cab41c3`, plus one read-only scout. ~493k subagent tokens.
**Status of this document: EVIDENCE, not a plan.** It records what was found and how it was proven. What to do about it belongs in a plan.

Lenses: ① engine and concurrency correctness · ② test teeth and the golden suite. A third scout gathered event-system facts for Plan 07 sequencing and is reported separately.

**Why this audit was run.** Plan 06.1 passed **7/7 with zero gate rejections**. Its own gate report §6 said, in as many words, that a zero-catch run is not proof the gates were sharp — it means they were never seriously tested — and flagged that the module was about to carry Plan 08's billing. This audit tested that. It found **two CRITICALs, four MODERATEs and eleven MINORs**, and it falsified three claims in the gate report that authorized it.

---

## Summary

| # | Severity | Finding | Kind | Reproduced |
|---|---|---|---|---|
| **A1** | **CRITICAL** | `newId()` is non-monotonic `ulid()`, so the `id DESC` tie-break shipped as the C2 fix is **random** within a millisecond. A superseded DPCO ceiling can win. | code defect | **YES** — 6 of 200 trials billed the superseded ceiling |
| **A2** | **CRITICAL** | The cross-version race test cannot distinguish a working serializer from **no serializer at all**. Both mutants survived 10/10 isolated runs. | test gap | **YES** — mutants executed |
| **B1** | MODERATE | The rejected-approval belt UPDATE runs **before** the approval-subject guard and the SoD guard, so a mis-bound rejected approval drives an unrelated healthy version to terminal `rejected` — and the SoD-forbidden drafter can trigger it. | code defect | **YES** |
| **B2** | MODERATE | `A7` (gazette history ordering) kills nothing: dropping `desc(id)` from `listRegulatedPrices` survives 10/10 isolated **and over HTTP**. The Assertion Book named A7 as the load-bearing kill for A6's admitted weakness. | test gap | **YES** |
| **B3** | MODERATE | The e2e gazette-history route's `serviceId` **scope** is untested — the fixture has one service, so scoped and unscoped are observationally identical. | test gap | **YES** |
| **B4** | MODERATE | Reverting **only** the cap comparison operand (leaving the recorded amount raw) survives the whole suite. At `maxBps = 10000` that silently clamps an over-gross ask and accepts it — the exact D3 violation T4 exists to prevent. | test gap | **YES** |
| m1–m11 | MINOR | See §5. | mixed | mostly |

---

## 1. A1 — the C2 tie-break is not deterministic (CRITICAL)

**`apps/core/src/modules/tariff/services.ts:110` and `:130`; root cause `packages/contracts/src/ids.ts:12`.**

T3 shipped `.orderBy(desc(effectiveFrom), desc(id))` with the comment *"ids are ULIDs, so descending id = last-inserted-wins."* **`newId()` calls `ulid()`, not `monotonicFactory()`.** A ULID is a 48-bit millisecond timestamp plus **80 bits of fresh randomness**; two minted in the same millisecond are ordered by coin flip. `id DESC` is a total order — it is simply not the *insertion* order, which is the property the fix required.

**Reproduced, not reasoned.** 200 000 consecutive ULID pairs: 191 851 shared a millisecond and **95 896 inverted (ratio 0.4998)**. Then end-to-end through the shipped `appendRegulatedPrice` → `resolveRegulatedPrices`, 200 trials of "gazette row, then same-date corrigendum, back to back in one transaction":

```
trials=200  sameMillisecond=14  engineResolvedToTheSUPERSEDEDrow=6
example: inserted[0]=01M00QR5NCV3MF5Y7NK4HPAZE4  inserted[1]=01M00QR5NCH08WYGAM3ZRMWDV7
         -> engine ceiling=99900 (superseded) instead of 45000 (corrigendum)
```

`listRegulatedPrices` returns the same wrong row at its head, so the admin UI **confirms** the wrong ceiling to whoever goes looking.

**Reachability boundary, established by execution.** Two *separate* `withTx` calls did not collide in 200 trials, and two `upsertAdjustmentRule` calls in one transaction did not collide in 200 trials. Today's one-row-per-HTTP-request route is therefore **accidentally** safe — determinism holds only because insert latency happens to exceed 1 ms, not because the ordering is correct. Any bulk path breaks it: an NPPA gazette import loop over a few hundred SKUs, a data fix, or Plan 08 seeding.

**Consequence.** A stent or drug bills at the pre-correction ceiling. Billing above a DPCO notified ceiling is a statutory offence and nothing in the system flags it.

**Same root cause, second site:** `rules.ts:128` (`asc(id)` + last-write-wins) rests on the identical assumption. Its *direction* was verified correct (newest wins, 200/200 stable for that shape), but it inherits the same latent tie.

**Note for the fix:** `monotonicFactory()` is monotonic **per process**. The architecture is heading for a multi-process split (api / ws hub / worker / renderer) in Plan 11, where two processes minting in the same millisecond would collide again. A database-side monotonic tie-break (a `bigserial` column, as `events.seq` already does) is the shape that survives that split. This is a design decision, not a one-line swap.

---

## 2. A2 — the race test cannot tell a working serializer from none (CRITICAL)

**`apps/core/src/modules/tariff/versions.test.ts`, "cross-version race at an EQUAL effectiveFrom".**

Two mutants were built as scratch files beside the source and executed:

| Mutant | Test | Verdict |
|---|---|---|
| **A1a** — revert to the Plan-06 two-lock serializer (the shape §3.21 was written about) | cross-version race ×10 isolated | **SURVIVED 10/10** |
| **A1b** — delete the serializer statement entirely | cross-version race ×10 isolated | **SURVIVED 10/10** |
| A1a / A1b | same-version race ×10 each | SURVIVED (by design — that test's arbiter is the conditional UPDATE) |

Each mutant died 1/1 in an incidental 8-file `--runInBand` batch, where the discriminator was the loser reporting **`23505`** instead of `effective_from_not_monotone` — i.e. **migration 0008's partial unique index is what holds the invariant, not the lock.**

**What this means, precisely.** The money invariant survives every mutant: exactly one winner, exactly one activated row, exactly one `tariff.revision_applied` event, in every run. The system is safe — via the index. What is lost is (a) a typed 409 degrading to a raw Postgres 23505 surfacing as HTTP 500, and (b) any executed proof of the plan's central claim that the ordered set lock *"serializes ANY two concurrent activations."*

**This is EXECUTION-LESSONS §3.21 recurring one level up.** §3.21 was a lock that did not lock. This is a *test* that cannot detect whether the lock locks. And the evidence everyone trusted — "20/20 clean isolated runs", produced by the coder, re-demanded by the gate, and then **re-run 40× independently by the main session** — is exactly what the *unfixed* serializer also produces. Three layers of verification measured something that does not discriminate.

**Not a contradiction of lens ①.** Lens ① independently argued the serializer *is* correct: real `EXPLAIN` shows `LockRows` above the `Sort` so rows lock in `id` order whatever scan the planner picks; 150 concurrent activations produced zero deadlocks; and the predicate provably always covers the version being activated. The serializer is very likely right. It is simply **not proven by any test**, and a future edit to it would go undetected.

---

## 3. B1 — a guard that runs after the write it gates (MODERATE)

**`apps/core/src/modules/tariff/versions.ts:165-190`.** Order today:

1. `:165` `if (approval.status === "rejected")` → `:170` **`db.update(tariffVersions).set({ status: "rejected" })`** → throw `approval_rejected`
2. `:179` approval-subject guard → `approval_subject_mismatch`
3. `:187` SoD guard → `sod_drafter_activator`

The state-changing write at step 1 precedes both guards. Reproduced with the same raw column write the shipped 06.1 test uses, but with the mis-bound approval **rejected** rather than granted:

```
thrownCode=approval_rejected  vA.status=rejected
(expected: approval_subject_mismatch, and vA stays 'submitted')
```

A legitimate pending FY-27 tariff revision, mis-bound by a data fix (**the exact M10 scenario the guard was written for**), is written to terminal `rejected`. There is no un-reject path — the revision must be re-drafted from scratch. Separately, the **drafter** — the actor `sod_drafter_activator` exists to keep out of this function — can perform that same write.

The shipped test only covers the *granted* case, which is why the gates never saw it. One fix for both: move the belt UPDATE below both guards.

---

## 4. B2 / B3 / B4 — three assertions with no teeth (MODERATE)

**B2 — the gazette history ordering.** Dropping `desc(regulatedPrices.id)` from `listRegulatedPrices` keeps the suite green — 10/10 isolated, **and** through the HTTP route. The Assertion Book's A7 row explicitly names this test as the load-bearing kill for A6's admitted heap-order weakness (*"A7 + the stated total order carry the kill"*). It kills nothing. Its stated prediction — that a `desc(effectiveFrom)`-only sort returns `[r2, r3]` — is **wrong in execution**: Postgres returns `[r3, r2, r1]`, identical to correct. A6 *does* carry the resolution invariant (10/10 kill), so billing is defended; the **audit trail** is not — a superseded row can list above its own correction undetected.

**B3 — the e2e route scope.** A mutant that makes `GET /tariff/services/:id/regulated-prices` ignore its `:id` and return every service's rows **survives**: the e2e fixture has exactly one service with regulated rows, so scoped and unscoped are observationally identical. Textbook §3.14. Mitigated off the HTTP path — `services.test.ts` does scope-test with two services.

**B4 — the cap comparison.** Reverting **only** the comparison operand (`raw * 10000 >` back to `amount * 10000 >`) while leaving the recorded amount as `raw` **survives the whole suite, golden included**. g09 and the contest test pin the *recorded amount*, never the *comparison*. At `maxBps = 10000` — legal under `manualCapParamsSchema`'s `.max(10000)` — the reverted code clamps an over-gross ask to gross and **accepts** it, netting the line to zero. That is precisely the D3 "recorded as rejected, never silently clamped" violation T4 was written to prevent, and no behavioural test covers the one cap value where old and new differ.

---

## 5. MINOR findings

| id | Finding | Where |
|---|---|---|
| m1 | The "provably identical for every `maxBps < 10000`" comment is **false at `grossPaise === 0`** (exhaustive sweep: 0 divergences for non-zero gross, 6000 at zero gross). A ₹0 camp consultation with a manual waiver now records a bogus `over_cap` in the D-8 audit record. No money moves. | `contest.ts:44-50` |
| m2 | Migration 0008 has no pre-flight de-duplication and is not `CONCURRENTLY`, so it **cannot install** on a database already holding two versions activated at the same instant — exactly the state stress-test C1 produced. Pre-go-live, so likely no such database exists. | `drizzle/0008_loving_gunslinger.sql` |
| m3 | `validateTariffConfig`'s bare `catch {}` swallows any `loadRuleConfig` failure — connection reset, transaction abort, genuine bug — and misattributes it as four `manual_caps_missing` errors. It can never print a false `ok: true` (verified). Diagnostic risk only. | `context.ts:150-157` |
| m4 | A 23505 on the new index escapes `toHttp` untyped → HTTP 500 with a raw Postgres constraint name. Same fallthrough covers two documented-as-expected raw 23505s. | `tariff.controller.ts` |
| m5 | The both-bounds guard's `=== null` passes an `undefined`/`undefined` shape and then silently skips the C-3 clamp. TypeScript forbids the shape today; Plan 08 is the first consumer that could hand-build a context. `!= null` closes it. | `pricing.ts:30-40` |
| m6 | Deleting all three filters (`!row.active`, `validFrom > at`, `validTo < at`) from the duplicate-cap loop survives — a retired cap would be reported as a live duplicate. | `context.ts` |
| m7 | Deleting the `subjectType !== "tariff_version" \|\|` half of the approval binding survives — the test writes a real tariff approval id, so only the `subjectId` half is exercised. | `versions.ts` |
| m8 | Deleting `ne(tariffVersions.id, versionId)` from the monotonicity re-check survives. **It is half of the fix §3.21 was written about.** | `versions.ts` |
| m9 | Deleting `Math.min(raw, grossPaise)` on the manual source's *accepted* path survives — now unreachable for every legal cap, so it is dead defensive code. The D2 contract `pricing.ts`'s belt cites is enforced by the cap comparison, not the clamp. | `contest.ts` |
| m10 | Manifest residuals (unclaimed by A25, so not defects): a duplicate named `*.JSON` passes because the filter is case-sensitive; a fixture **gutted** to `lines: [], expected: []` passes vacuously. The manifest pins names, never content. | `golden.test.ts` |
| m11 | Both Assertion Book heap-order predictions are wrong, in **opposite** directions: A6 is declared unreliable and kills 10/10; A7 is declared load-bearing and kills 0/10. The honesty discipline was applied to A22 and A6 but not to A7, where the plan asserted a kill it did not have. | plan §Assertion Book |

---

## 6. SOUND — checked by execution, and genuinely correct

**The activation serializer itself** (as distinct from its test). Real `EXPLAIN`: `LockRows → Sort → Bitmap Heap Scan` — `LockRows` sits **above** the `Sort`, so rows lock in `id` order whatever scan the planner picks, and `FOR UPDATE` excludes parallel plans. 6-way concurrent activation × 25 rounds: zero deadlocks in 150 activations. Loser codes deterministic across 160 rounds (80 same-version → `not_submitted` ×80; 80 cross-version → `effective_from_not_monotone` ×80), every round with a per-round event delta of exactly 1. The predicate provably always covers the version being activated, derived rather than asserted. **No starvation:** with an activation holding the lock 2000 ms, an unrelated submit completed in 15 ms — `draft` rows sit outside the predicate. The locked set grows at the tariff-revision rate, a dozen rows a year.

**No TOCTOU on the pre-transaction approval read** — the attempt to build one was refuted by the kernel: approvals are one-shot, `already granted` on re-decide.

**`subjectType`'s literal matches the kernel** — `requestApproval` writes `input.subject.type` verbatim; `submitVersion` passes `"tariff_version"`; no normalisation between.

**`resolveActiveTariffVersion` is now deterministic** — it orders by `effective_from DESC LIMIT 1` with no tie-break, which is only safe *because* migration 0008 makes `effective_from` unique among activated rows. The index buys more than its comment claims.

**Postgres collation is not a hazard** — under the live `en_US.utf8`, 500 real ULIDs sorted identically to JS binary sort, so `ORDER BY id` means the same thing in both layers.

**The new guards do not reject valid billing** — `assertPaise(taxableBasePaise)` fired on a legitimate input **zero** times across a 150-case sweep through the real engine, and cannot fire for the two shipped sources. `requiresApproval` still computes on the clamped amount on every reachable path.

**Purity holds** on all six pure files. **Resolver and accessor agree** on ordering and differ correctly on filtering.

**Sixteen assertions proved sharp by a mutant that died**, including the whole green-first set that nobody had ever seen fail: A4 (SoD submitter), A10 (ruleKey tie-break), A11 (zero-benefit filter), A15 (composite-vs-category order), A18 (validFrom, killed twice — deletion and `>`→`>=`), A19 (`active:false`), A20 both halves (rules and gst-config upserts), A2 both legs (index dropped; `WHERE` dropped), A26 for `PATCH services/:id`, plus A5, A8, A13, A14, A16, A17, A23, A24, A27, A6.

**Both golden fixtures re-derived entirely by hand** from CONFIG_A and D1/D2/D4 — g09 net 50000 and g14 net 11200 — matching the fixture bytes exactly, with `rateBps 1200` derived from the stated net *before* opening the file. g14's config is CONFIG_A plus exactly three keys, verified by a full flattened key diff: zero removals, zero value changes. The C-3 mutant differs in five asserted fields and dies.

**The manifest cannot pass vacuously** — an empty directory yields `[]` against a 14-name literal and fails; a missing directory throws at module load. Rename, duplicate, delete and add are all detected.

**All 17 routes are exercised**, enumerated independently against the controller, and the "reads state back" claim holds for every new assertion.

**The race tests have no §3.13 early-bail path** — the four invariant assertions sit unconditionally after the code check. The problem is not that the invariants are skipped; it is that the mutants satisfy them.

---

## 7. What the auditors could not check

- A definitive kill-rate curve for A2 would need a **controlled contention harness** (forced interleaving); only isolated single-file runs (0/10) and one incidental `--runInBand` batch (1/1) were measured.
- m3's non-config failure modes (connection reset, transaction abort inside `loadRuleConfig`) are reasoned from the catch's shape, not executed — inducing a mid-call connection failure would have meant touching the container.
- Assertion Book rows A3, A9, A12, A21 were outside the required minimum; A9 and A12 are structurally single-producer.

---

## 8. Process finding: parallel auditors sharing per-worker databases interfere

Both auditors ran concurrently against the same jest per-worker databases. One agent's `truncateAll` broke the other's measurements mid-run, producing failures whose signature was unmistakable (`unknown SoD pair key: workflow_drafter_activator`, `approval … was decided concurrently`) and which vanished on isolated re-run. Lens ① lost two experiment rounds and had to re-run them; lens ② had one mutant run fail on an unrelated FK violation.

**Consequence for future runs:** any two agents that run this repo's test suite concurrently will corrupt each other's evidence, because the per-worker database name derives from `JEST_WORKER_ID`, which is per-process and therefore collides across agents. Parallel audit or pipeline work must either serialize its test runs, or set a distinct database namespace per agent. This is prevention debt discovered the cheap way — nothing shipped wrong because of it — but a race-flake measurement corrupted by a second agent's truncate is indistinguishable from a real flake, which is exactly the confusion §3.21 cost a retry over.

---

## 9. Corrections owed to the Plan 06.1 gate report

Three claims in `plan-06-1-gate-report.md` are falsified by this audit and have been corrected in place:

1. **§9 — *"A DPCO ceiling can no longer depend on heap order."*** True as written and misleading: it now depends on ULID intra-millisecond randomness instead (A1).
2. **§9 — *"An approval can only activate the version it was raised for."*** True for activation; false for the rejected-belt write, which precedes the guard (B1).
3. **§3 — the main session's independent re-run of both race tests, 40/40 isolated.** The runs happened and the numbers are real, but the evidence **does not discriminate**: an unfixed serializer produces the same 40/40 (A2). The claim of independent verification stands; the claim that it verified the serializer does not.

§11's assessment that the two-audit rule "held, and was tested rather than assumed" also requires qualification: the derivation audit held everywhere it was checked, but the **discrimination** audit was itself unexecuted — A7's claimed kill is refuted by running it (B2, m11). A discrimination audit performed by hand is a prediction; only a mutant is evidence.
