# Plan 06.1 — Tariff Hardening · Gate Report

**Executed:** 2026-08-14, two pipelines, seven tasks. **Plan:** [`2026-08-14-phase1-06-1-tariff-hardening.md`](../2026-08-14-phase1-06-1-tariff-hardening.md).
**Input evidence:** [`plan-06-stress-test-findings.md`](plan-06-stress-test-findings.md) (4 CRITICAL / 11 MODERATE / 6 MINOR, four read-only audit agents, ~613k tokens).
**Owner approval:** in-conversation 2026-08-14, of the plan as written including its one flagged decision (T2 widens the `TariffErrorCode` union with `approval_subject_mismatch`; `index.ts` stays byte-frozen).

**Headline: 7 of 7 tasks passed on the first rung. Zero gate rejections across the whole plan — the first plan in the series with none.** One infrastructure outage (a network failure that killed T6's coder *after* it had pushed) and three harness stalls were the only failures of any kind, and the ladder absorbed both exactly as designed.

---

## 1. Final state

| | |
|---|---|
| Commits | 7, `cf2deb0` → `cab41c3`, linear on `main`; `5b0a7ba` is an ancestor of HEAD (no history rewrite anywhere) |
| `apps/core` | **68 suites / 383 tests** (from 68 / 360) |
| `packages/contracts` | 3 suites / 7 tests — byte-untouched all plan |
| `apps/web` | 11 files / 37 tests — byte-untouched all plan |
| `pnpm verify` | exit **0**, read from a captured file (tripwires 16–18) |
| CI | **green on all seven commits** |
| Migrations | exactly one new: `0008_loving_gunslinger.sql` + `meta/0008_snapshot.json` + rewritten `_journal.json` (idx 8) |
| Lint | zero problems |
| Server tree | clean; HEAD == origin/main; no scratch residue |

**Test-count ladder, verified at every rung:** 360 → **362** (T1) → **364** (T2) → **366** (T3) → **373** (T4) → **380** (T5) → **381** (T6) → **383** (T7). Suites fixed at 68 throughout — no task added a file jest collects as a suite (`g14` is a fixture JSON).

---

## 2. Task outcomes

| Task | Commit | Tier | Rungs | Gate | Cost (coder + gate) |
|---|---|---|---|---|---|
| T1 activation serializer + migration 0008 | `cf2deb0` | opus | 1 | pass #1 | 201,463 |
| T2 SoD submitter + approval subject binding | `786b743` | sonnet | 1 | pass #1 | 165,395 |
| T3 regulated determinism + `listRegulatedPrices` | `d211b92` | sonnet | 1 | pass #1 | 181,378 |
| T4 asked amounts, paise guards, contest teeth | `81421e5` | sonnet | 1 | pass #1 | 236,103 |
| T5 D-17 gate truth, rules determinism, coverage | `5f9ede4` | sonnet | 1 | pass #1 | 191,398 |
| T6 golden g09 / g14 / manifest | `c339765` | opus | 1 (+1 infra rung) | pass #1 | 277,749 |
| T7 the eight silent routes + DTO pin | `cab41c3` | sonnet | 1 | pass #1 | 175,682 |

Every commit's changed-file set matches its task's Files list **exactly** — checked per commit with `git show --stat`, not taken from any agent's report.

---

## 3. Verification evidence (main session, independent of every agent self-report)

- **`pnpm verify` after each pipeline**, detached on the server with the exit code written to a file under `/opt/hmis` and read back separately — never a pipe, never a wrapper. After A: 68/373, exit 0. After B: 68/383, exit 0.
- **Both activation race tests re-run 20× isolated each, by me, after pipeline A** — 40/40 clean, **`11 skipped, 1 passed, 12 total` on every single run** (isolation read from OUTPUT, tripwire 19), zero `40P01` deadlocks in any of the 40 logs. The Plan 06 §7.2 lesson says not to take a gate's word for race evidence; this did not.
- **Per-suite counts measured by me**, not transcribed: `rules.test` 9 · `gst-config.test` 5 · `context.test` 8 · `golden` 16 · `tariff.e2e` 8 · `versions.test` 12 · `services.test` 8 · `contest.test` 14 · `pricing.test` 10 · `gst.test` 8 · `kernel/db/schema/tariff.test` 4.
- **Frozen-path audit across the entire plan range** `5b0a7ba..cab41c3`: empty diff for `modules/tariff/index.ts`, `packages/contracts`, `apps/web`, `modules/patients` (incl. `qr.test.ts`), `.github/workflows`, `apps/core/package.json`, `README.md`, `test/helpers/db.ts`, `simulation.ts`(+test), `tariff-lifecycle.e2e.test.ts`, `scripts/**`, `manifest.ts`, `tariff.module.ts`, `events.ts`, `money.ts`, `fixture-schema.ts`. `kernel/**` and `drizzle/**` changed **only** in T1, as scoped. Of the golden fixtures, only `g09` changed and only `g14` was added — the other twelve byte-identical.
- **CI observed green per commit** via `gh run list`, matched by SHA.
- **History integrity:** `git merge-base --is-ancestor 5b0a7ba HEAD` passes; no amend, rebase, reset or force-push anywhere, including on the commit that a dead agent had already pushed.

---

## 4. Interface delta (what changed on the public surface — full transcription remains gate report 06 §4)

- **`modules/tariff/index.ts` — byte-identical to Plan 06's.** No export added or removed.
- **`TariffErrorCode`: 22 → 23 members.** `approval_subject_mismatch` joins the union. It is deliberately *not* in `NOT_FOUND_CODES` or `VALIDATION_CODES`, so `toHttp`'s fallthrough maps it to **409** — no controller edit was needed. The code set was already ratified as **open** (gate report 06 §5.4); this widens it as the owner approved.
- **`services.ts` gains `listRegulatedPrices(db, serviceId): Promise<RegulatedPriceRow[]>` and `export type RegulatedPriceRow`** — module-internal, imported by the controller, **deliberately not exported from `index.ts`**. This closes gate report 06 §5.2's carried-forward item.
- **`ConfigError.code` gains `duplicate_manual_cap`** — a plain string in an open set. No union edit, no new event.
- **New database object:** partial unique index `tariff_versions_activated_effective_ux` on `(effective_from) WHERE status = 'activated'`.
- **Unchanged:** 17 routes, 5 permissions, exactly two event names (`tariff.revision_applied`, `config.validated`), zero new dependencies, zero env vars, zero CI changes.

---

## 5. Deviations

**5.1 — T1's fail-first run budget was 3× what the plan prescribed.** The plan ordered 15 isolated pre-fix runs of the cross-version race and expected at least one red. **15/15 passed.** Rather than declare the evidence unobtainable or manufacture a red state, the coder ran 30 more and got one genuine failure — **1 in 45 (~2.2%)**. Its explanation, offered so the low rate is not mistaken for a broken test: under the shipped serializer both sessions *can* commit, but only if the second session's monotonicity SELECT lands before the first commits; in the jest harness the second activation consistently lags (the pg Pool must open a fresh physical connection for the second concurrent transaction while the first reuses an idle one), so the loser usually observes the winner already committed and refuses *legitimately* — i.e. accidentally passes. The stress test reproduced C1 easily because it drove raw `pg` sessions and controlled the interleaving directly. Nothing was touched to widen the window.

**5.2 — T3 staged its own in-progress test file to obtain a semantically informative red run.** The plan's Step 1 adds both new tests in one block, but the second imports `listRegulatedPrices`, which does not exist until Step 3 — so deploying that exact file against pre-fix `services.ts` fails the whole suite to *compile* (TS2305) on every run: a true red that says nothing about heap-order nondeterminism. The coder temporarily deployed a reduced variant of **its own** test file (first test only), captured five genuine semantic reds, then restored the full Step-1 file before implementing. No shipped source, schema, or database was mutated. Judged within the brief's "best-effort and honest" allowance and not a tripwire-14 breach; the gate ratified it. **It is nonetheless an authoring defect worth recording** (§13.3) — a fail-first step whose test file cannot compile before the implementation it precedes.

**5.3 — T6 was shipped by an agent that then died, and its replacement correctly changed nothing.** A network outage (`ENOTFOUND`) killed the T6 coder *after* it had committed and pushed `c339765`. The infra rung re-ran at the same tier (no promotion — §2.1 working), found the task's exact commit already on origin/main with exactly its three files, and converted itself to a **verify-only audit** per the rule Plan 06 added for precisely this case. It re-derived both Assertion Book entries by hand, structurally diffed g14's config against CONFIG_A, confirmed the manifest block verbatim, found no defect, and **changed nothing** — a zero diff as a declared valid success, the second time this shape has been the right answer.

**5.4 — One piece of owed fail-first evidence was not produced, and was declared rather than fabricated.** T6's brief required the manifest test observed red before `g14` existed. Post-outage, the only routes to that state were rewriting the pushed commit (tripwire 15) or deleting/relocating the shipped fixture (tripwire 14 in spirit, and named explicitly in the brief as forbidden manufacture). The agent considered a scratch worktree re-enactment, rejected it as requiring a `pnpm install` against the shared store, and **reported the gap**. The gate passed the task on the Assertion Book A25 walk instead. That is the correct call by both agents — and the criterion that became unsatisfiable was **mine**, a recurrence of ledger §2.3 (§13.2 below).

**5.5 — The plan's per-file test-count table overstated two files.** `contest.test` was stated at 15 and was actually **10** (T4 disclosed this and reported its honest final of 14 rather than padding to the plan's 19). `tariff.e2e` was stated at 7 and is actually **6** (found by me measuring every suite before compiling B; T7's criterion was corrected to 8 in the brief). The **workspace totals in the ladder were correct at every rung** and were verified independently each time. No test was added, split, or invented to reach a stated number.

**5.6 — T7 needed no identifier substitution.** The plan's e2e code blocks matched the shipped scaffolding byte-for-byte (`drafterToken`, `auth()`, `adminToken`, `readerToken` all exist under those exact names), and the DTO's zod issue shape for `pricePaise: -1` was exactly `{ code: "too_small", path: ["pricePaise"] }` as claimed — so Step 3's sharpened assertion passed first run with no loosening.

**Deviations from earlier plans, deliberately not fixed:** everything in gate reports 01–06 §4/§5, including the `code: message` HTTP prefix (owner-ratified), the open `ConfigError` code set, and the simulate route's permission; plus `qr.test.ts`'s 1-in-4096 tamper flake, which remains untouched and still belongs to a future task that owns that file.

---

## 6. Gate catches: none — and what that does and does not mean

**Seven tasks, seven first-rung passes, not one gate rejection.** Against Plan 06's 9-of-10 and Plan 05's 13-of-16, this is the cleanest execution in the series. Three things earned it, and it is worth being precise about which:

1. **The Assertion Book did the gate's hardest work at authoring time.** Every assertion arrived with its derivation *and* its named killing mutant already computed, so a coder had nothing to invent and a gate had a fixed target to re-derive against. The two §3.14-class defects that Plans 05 and 06 each shipped had no room to form here.
2. **The plan's own defects were caught by coders, not gates** — because the briefs told them to disclose plan defects rather than work around them. T4 found the contest count erratum; T3 found that the plan's A6 honesty note predicted the wrong direction (see §12).
3. **The pre-B measurement pass caught the one erratum that would have bitten.** `tariff.e2e`'s stated baseline of 7 vs. the real 6 would have made T7's count criterion unsatisfiable — a §2.5 compile defect, caught before it reached an agent, at the cost of one detached measurement run.

**What it does not mean:** a zero-catch run is not proof the gates were sharp. The one place a gate's judgment was genuinely tested — T6's missing fail-first evidence (§5.4) — it passed a task with a declared evidence gap. I believe that was correct (the alternative was fabrication), but it is the single verdict in this plan a reviewer should re-examine, and I am flagging it rather than letting a clean scoreboard bury it.

---

## 7. Process failures and their costs

| # | Failure | Class | Cost |
|---|---|---|---|
| 1 | Network outage (`ENOTFOUND`) killed T6's coder after it had pushed `c339765` | Infrastructure; **third instance** of a dead agent's committed work outliving its report | ~85k (the verify-only replacement rung). The original 103k was not wasted — that code shipped |
| 2 | Three harness stalls on the T6 replacement (607 s, 470 s, 219 s) | Host/harness | 0 extra tokens; ~22 min of the run's 30-min agent wall clock |
| 3 | Plan 06's stated prevention — "the isolation requirement now lives in the gate prompt" — had **never been applied to the skill template** | Prevention debt, discovered before compiling | 0 tokens. Fixed this session; both pipelines carried it |
| 4 | Two per-file test-count errata in the plan (§5.5) | Authoring defect; one caught by a coder, one by me pre-B | 0 tokens of retry |
| 5 | A criterion only the first attempt could satisfy (§5.4), made unsatisfiable by the outage | Compile defect, **mine** — ledger §2.3 recurring | 0 tokens; absorbed by an honest declaration |

**The failure shape moved again, and in the right direction.** Plan 06 produced one code defect and five process failures. Plan 06.1 produced **zero code defects that reached a gate** and five process items, four of which cost nothing because they were caught by disclosure rather than by failure. The only item with real cost was infrastructure — again.

---

## 8. Cost accounting

| Pipeline | Agents | Tokens | Wall clock |
|---|---|---|---|
| A (T1–T4) | 8 | 784,339 | ~1 h 52 m |
| B (T5–T7) | 7 (6 done, 1 died) | 644,829 | ~1 h 24 m |
| **Total** | **15** | **1,429,168** | **~3 h 16 m** |

Per agent: coders 85k–159k, gates 64k–89k. Per task including its gate: 165k–278k, mean **204k**.

**The plan calibrated 1.3–1.9M with a ~1.5M expected midpoint. The actual was 1.43M — inside the band, 5% under the midpoint.** This is the first plan in the series to land inside its own calibration (Plan 04 was accurate to 2% but had no contingency to spend; Plan 05 ran 42% over; Plan 06 ran 56–76% over). The reason is directly traceable: Plan 06's ledger entry said to budget infrastructure failure explicitly rather than hope it away, this plan budgeted 0.3–0.5M for it, and infrastructure consumed ~85k — well inside the reserve. **Budgeting for infrastructure failure is now empirically the difference between an accurate estimate and a 50%-over one.**

---

## 9. What Plans 07 and 08 can now rely on

- **Two concurrent activations cannot both succeed**, whatever versions they name. A single ordered lock over `status IN ('submitted','activated')` serializes every pair, and a partial unique index enforces the D5 monotonicity invariant at the database layer even if application code is bypassed. Verified 40/40 isolated, zero deadlocks.
- **An approval can only activate the version it was raised for** — `subjectType` and `subjectId` are both checked at the single consumption site.
- **Separation of duties covers the submitter, not just the drafter**, and there is now a test that dies if the clause is deleted.
- **Regulated-price resolution is a total order** — `(effectiveFrom DESC, id DESC)`, so the same-date gazette-correction path resolves to the correction, deterministically, at both the resolver and the list route. **A DPCO ceiling can no longer depend on heap order.**
- **Rejected discount candidates record the amount that was ASKED**, and the cap check compares the ask — so a 100% cap can no longer silently clamp an over-gross request and accept it.
- **Fractional paise cannot enter pricing** from the direct programmatic caller (`assertPaise` on `manualDiscount.value`), and an over-gross winner from any future plugin source fails loudly at the taxable base instead of producing a negative net. **Plan 08 and Plan 09 are the callers this protects.**
- **The D-17 go-live gate now validates the rule set the engine will actually load** — active, in-window — and reports duplicate caps instead of silently resolving them. A green gate now means what it says.
- **The golden suite has 14 fixtures pinned by a literal name manifest**, including the two-bound C-3 clamp case that the executed mutant survived before.
- **All 17 routes are exercised**, including gazette ingestion — the only door regulated-price data enters through.

---

## 10. Open items

- **`qr.test.ts`'s 1-in-4096 tamper flake** — still open, still deliberately untouched, still owned by the next task that legitimately owns that file.
- **The `mrp == ceiling` exact-tie label** — D2 does not specify which bound a two-bound tie reports, no money moves on it, and it is deliberately unpinned rather than invented.
- **Drafter-as-approver (M11)** — owner decision 2: accepted as a v1 risk; resolves as workflow-definition data when tiered approvers arrive.
- **Carried to Plan 08 authoring:** the findings §14 friction list (invoice totalling, the `rounding_paise` column, a discount-override approval type, credit lines, version pin at bill-open) and the **owner rulings still needed on TCS, cess, reverse charge, and B2B invoices to GST-registered patients**.

---

## 11. The two-audit rule — did it hold?

The plan existed because Plan 06 ran only **one** of the two audits: it hand-derived every expected value (proving fixtures were not circular) but never asked whether a fixture *discriminates*, which is how `g09` shipped bearing the name "records the amount that was ASKED… never clamped" while being provably unable to detect clamping.

**It held, and it was tested rather than assumed.** T6's gate re-derived both Book entries by hand from CONFIG_A and D1/D2/D4, walked both named mutants independently, and confirmed each produces an observable the deep-equal catches. It also re-checked the one Book value that *looks* wrong at a glance — g09's `requiresApproval: false` despite an ask of 12000 bps against a 1500 bps approval threshold — and traced it to source: the `over_cap` branch returns before the `requiresApproval` computation. **That is the discrimination audit doing exactly what it exists to do: refusing to accept a plausible number without deriving it.**

One instructive miss, in the safe direction: the plan's honesty note for A6 predicted that a no-tie-break implementation would *usually pass* the same-date correction test, because fresh-table heap order tends to match insertion order. T3 observed the opposite — because `resolveRegulatedPrices` reduces to the **first** row per service, insertion order means the **stale** row wins, so the pre-fix code failed **5/5**. The fixture was more discriminating than the plan claimed. The coder reported what it observed instead of asserting what the plan predicted, which is the whole discipline in one move.

---

## 12. Lessons for the ledger

**12.1 — A concurrency fail-first budget must be measured, not guessed.** T1's plan prescribed 15 isolated runs; the window opened once in 45 (~2.2%) on this host, because the jest harness's connection-pool behaviour systematically delays the second racer. A prescribed run count is a prediction about a race window, and predictions about race windows are exactly the thing this ledger keeps catching. **Prescribe a floor, require the report to state the observed rate, and authorize the coder to keep going rather than declare the evidence unobtainable.**

**12.2 — §2.3 recurring: a criterion only the FIRST attempt can satisfy becomes unsatisfiable the moment infrastructure forces a second.** T6's "manifest test observed red before g14 existed" was correct for an original attempt and impossible for the verify-only rung the outage forced. The agent refused to fabricate it and declared the gap; the gate passed on the mutant walk. **When a fail-first criterion depends on an intermediate state the task itself destroys, write the fallback into the criterion at compile time** — "…or, if a prior attempt already shipped the artifact, the gate re-derives the Assertion Book walk instead."

**12.3 — A fail-first step whose test file cannot COMPILE before the implementation produces a red that proves nothing.** T3's Step 1 added two tests in one block; the second referenced a function Step 3 creates, so the pre-fix run failed to typecheck rather than failing on the defect. The coder staged its own file down to get a semantically informative red. **When a task's tests and implementation are interdependent, split the fail-first step: the test that demonstrates the defect must be deployable against unmodified shipped code, on its own.**

**12.4 — A stated prevention is not a prevention until it is in the artifact.** Plan 06's ledger entry recorded that the jest-isolation requirement "now lives in the gate prompt." It did not — the template was never edited, and the fix would have died with that session. Found and landed before compiling A. **When a lesson's fix is "add it to the template," verify the template afterwards; a ledger entry describing a fix is not the fix.**

**12.5 — Per-file test counts transcribed into a plan are unreliable; workspace totals and deltas are not.** Two of eleven per-file figures were wrong (`contest.test` 15 vs 10, `tariff.e2e` 7 vs 6) while every workspace rung was exactly right. One was caught by a coder mid-run, one by a measurement pass before compiling pipeline B. **Measure per-suite baselines on the server immediately before compiling, paste the measurements into the briefs, and state explicitly that measurement beats the document — otherwise a correct agent spends tokens proving it is correct, or worse, pads a test to hit a number.**

**12.6 — Budgeting for infrastructure failure is what made this estimate accurate.** 1.43M against a 1.3–1.9M calibration, after two consecutive plans overran by 42% and 56–76%. The difference was not better luck — an outage and three stalls still happened — it was that Plan 06's lesson to budget an explicit infrastructure contingency was applied. **Keep doing this.**

**12.7 — The dead-agent-that-already-pushed rule paid off on its first real use.** Added after Plan 06 discovered the state the expensive way, it fired for real here: the replacement rung checked origin before acting, converted itself to a verify-only audit, refused to amend a pushed commit, re-derived the work by hand, and correctly changed nothing. **A zero diff, declared and justified, is a valid successful outcome — and the rule that produced it belongs permanently in every pipeline's compile notes.**
