# Plan 06.2 — Tariff Hardening II · Gate Report

**Executed:** 2026-08-15, one pipeline, six tasks, strictly sequential. **Plan:** [`2026-08-15-phase1-06-2-tariff-hardening-2.md`](../2026-08-15-phase1-06-2-tariff-hardening-2.md).
**Input evidence:** [`plan-06-1-audit-findings.md`](plan-06-1-audit-findings.md) (2 CRITICAL / 4 MODERATE / 11 MINOR, two independent read-only opus auditors + one scout, ~493k tokens, against `cab41c3`).
**Owner approval:** in-conversation 2026-08-15, of the plan as written including its flagged defaults — the A1 ruling (Option B, database-side `seq`), the m1 zero-gross `over_cap` policy, the comment-only `packages/contracts/src/ids.ts` touch, and the m2/m4/m9 deferrals.
**Workflow:** runId `wf_651a795d-41b`, script `routing-pipeline-wf_651a795d-41b.js`.

**Headline: 6 of 6 tasks shipped. One gate rejection — and it was a real plan defect, found by an executed mutant that refused to die.** Plan 06.1 passed 7/7 with zero gate catches and a post-ship audit then found two CRITICALs in it. This plan's whole organizing rule was tripwire 21: *an unexecuted discrimination claim is a prediction*. On its first outing that rule caught a falsified prediction in the plan's own headline fix — **the replacement for the non-discriminating A2 race test was itself non-discriminating**, for a different reason, and only building Mutant A revealed it. Nobody hand-walked their way to that. See §7.

---

## 1. Final state

| | |
|---|---|
| Commits | 6, `03969ec` → `5fd3ad0`, linear on `main`; `fba3fdc` is an ancestor of HEAD (no history rewrite anywhere) |
| `apps/core` | **69 suites / 396 tests** (from 68 / 383) |
| `packages/contracts` | 3 suites / 7 tests — unchanged (T1's touch is a doc comment) |
| `apps/web` | 11 files / 37 tests — byte-untouched all plan |
| `pnpm verify` | exit **0**, read from a captured file (tripwires 16–18) |
| CI | **green on all six commits**, matched by SHA |
| Migrations | exactly one new: `0009_huge_joshua_kane.sql` + `meta/0009_snapshot.json` + rewritten `_journal.json` (idx 9) |
| Server tree | HEAD == origin/main; two untracked scratch items remain — see §10 |

**Test-count ladder:** 383 → **384** (T1) → **386** (T2) → **389** (T3) → **392** (T4) → **394** (T5) → **396** (T6). Suites 68 → **69** at T2, the plan's one new suite file. Every rung was verified by that task's gate with its own detached `pnpm verify`; the final rung was verified independently by the main session. The ladder hit every predicted number exactly — no task padded, split, or invented a test.

---

## 2. Task outcomes

| Task | Commit | Tier | Rungs | Gate | Cost (coder + gate) |
|---|---|---|---|---|---|
| T1 `seq` columns, migration 0009, bulk-corrigenda proof (A1) | `03969ec` | opus | 1 | pass #1 | 181,089 |
| T2 controlled-contention suite (A2, m8) | `dd49c35` | opus | **2** | **fail #1**, pass #2 | 367,668 |
| T3 rejected belt below its guards (B1, m7) | `cf749e2` | sonnet | 1 | pass #1 | 232,195 |
| T4 cap at the 100% boundary, zero gross, undefined bounds (B4, m1, m5) | `17e183d` | sonnet | 1 | pass #1 | 218,991 |
| T5 narrowed catch, duplicate-cap teeth (m3, m6) | `717e211` | sonnet | 1 | pass #1 | 212,137 |
| T6 e2e scope, non-vacuous manifest (B3, m10) | `5fd3ad0` | sonnet | 1 (+1 infra rung) | pass #1 | 266,425 |

Every commit's changed-file set matches its task's Files list **exactly** — checked per commit with `git show --stat`, not taken from any agent's report: 8 / 1 / 2 / 4 / 2 / 2 files.

---

## 3. Verification evidence (main session, independent of every agent self-report)

- **`pnpm verify`** detached on the server with the exit code written to `/opt/hmis/.mainverify.exit` and read back separately — never a pipe, never a wrapper. **Exit 0; `apps/core` 69 suites / 396 tests.**
- **The new contention suite re-run 10× isolated by me** — 10/10 `EXIT=0`, and isolation read from OUTPUT on every run (tripwire 19): `Ran all test suites matching /versions.contention/i.` with `Test Suites: 1 passed, 1 total` and `Tests: 2 passed, 2 total`, ten times over. This is the suite whose predecessor was proved non-discriminating, so its evidence was the one thing worth re-measuring by hand. Note what this does and does not prove: it proves the suite is stable, **not** that it discriminates — discrimination is proved only by Mutant A dying (§6, §7).
- **`packages/contracts` and `apps/web` re-run by me**, not inferred from the untouched diff: contracts `3 passed / 7 passed`, exit 0; web `Test Files 11 passed (11)` / `Tests 37 passed (37)`.
- **Per-commit `git show --stat`** against each task's Files list — all six exact, no strays.
- **Frozen-path audit across the whole range `fba3fdc..HEAD`** — empty diff for `modules/tariff/index.ts` (byte-identical), `apps/core/test/helpers/db.ts`, `tariff.controller.ts`, **all 14 golden fixture JSONs**, `apps/web/**`, `.github/**`, both `package.json`s and `pnpm-lock.yaml`. The complete 19-file change set for the plan is exactly the union of the six Files lists.
- **Migrations counted on disk:** ten `.sql` files, `0000`–`0009`. Exactly one added, in T1, as specified. Fixture directory still holds 14 files.
- **CI observed green per commit** via `gh run list`, matched by SHA: `03969ec` `dd49c35` `cf749e2` `17e183d` `717e211` `5fd3ad0` — all `completed success`.
- **History integrity:** `git merge-base --is-ancestor fba3fdc HEAD` passes; HEAD == `origin/main`; no amend, rebase, reset or force-push anywhere, including on T2's halted first attempt which had *not* pushed.
- **Pre-compile baseline measured by one scout running alone** (tripwire 20, ledger §2.9), and it agreed with the plan's table on every figure — 68/383 with all ten named per-suite counts exact, contracts 3/7, web 11/37, journal idx 8, 14 fixtures, zero mutant residue. One correction it did find: the golden fixtures live in `golden/fixtures/`, not `golden/`, which the plan's T6 Step 3 wrote one level shallow. Folded into T6's brief before compiling.

---

## 4. Interface delta

- **`modules/tariff/index.ts` — byte-identical.** No export added or removed.
- **Two new database columns:** `regulated_prices.seq` and `adjustment_rules.seq`, both `bigserial` (the `events.seq` precedent). `RegulatedPriceRow` and `AdjustmentRuleRow` widen by `seq: number` through `$inferSelect` — a type-level widening with no export change; the HTTP list payloads gain the field **additively**. A pre-compile `toEqual` sweep over every tariff test file confirmed no shipped assertion deep-equals a full row of either table, and none broke.
- **`ConfigError.code` gains `rule_config_load_failed`** — a plain string in an open set. No union edit, no new event.
- **`newId()` carries a WARNING doc comment** forbidding `ORDER BY id` for recency or insertion order. Zero executable change in `packages/contracts`.
- **Three orderings moved off ids:** `resolveRegulatedPrices` and `listRegulatedPrices` to `(effectiveFrom DESC, seq DESC)`, `loadRuleConfig` to `asc(seq)`. No `orderBy` in `services.ts` or `rules.ts` references `id` any more.
- **`activateVersion`'s gate order changed** (no observable change on any shipped path): the rejected-approval belt UPDATE now sits below the approval-subject and SoD guards. The belt's SQL and every error message are byte-unchanged; `approval_not_granted` keeps its original position deliberately, so the pending+drafter path still reports `approval_not_granted` rather than flipping to `sod_drafter_activator`.
- **Unchanged:** 17 routes, 5 permissions, exactly two event names (`tariff.revision_applied`, `config.validated`), zero new dependencies, zero env vars, zero CI changes.

---

## 5. Deviations

**5.1 — T2's Test 1 does not hold the lock the plan told it to hold. This is the plan defect of the run and it is described in full in §7.** The plan's holder statement was `SET_LOCK_SQL` itself, whose predicate covers the target version's own row; the shipped single-winner UPDATE must lock that same row, so a serializer-*less* `activateVersion` blocks too and the assertion cannot discriminate. Measured: **Mutant A SURVIVED 5/5** against the plan's shape, independently reproduced by the gate at **SURVIVED 3/3**. The correction — hold a *second* submitted+approved version's row, which only the serializer's set predicate reaches — is confined to T2's single file and was disclosed, not silently applied. Mutant A then **DIED 5/5**, gate-reproduced **DIED 5/5**.

**5.2 — T1's K2 mutant SURVIVED 10/10, and that is the honest, plan-authorised outcome.** The Assertion Book marked K2 *"measure, do not predict"* and stated in advance that SURVIVED is acceptable, because the post-ship audit had already proved this row's behaviour is decided by Postgres sort internals rather than by the tie-break. The coder measured it, did not engineer a kill, and said so; the gate independently rebuilt the mutant and reproduced SURVIVED 10/10. **The load-bearing defence for this ordering is structural — `bigserial` allocation order — plus K1's executed red, exactly as the plan said it would be.** An honest SURVIVED recorded is worth more than a manufactured DIED.

**5.3 — T1's observed pre-fix red rate was 75% (15 of 20 isolated runs), against the plan's hand-derived ~88%.** The coder reported the measurement rather than the document, which is what the plan asked for. The failure shape was exactly the predicted one (a service resolving to the superseded `ceilingPaise 99900`). Ledger §3.22 again: a derived rate for a race window is a possibility, not a forecast.

**5.4 — Doc-comment wording in `services.ts` and `rules.ts` is the coder's, not the plan's.** Step 4 gave prose direction for those two files rather than an exact block (unlike `ids.ts` and the schema comment, both typed verbatim). The rewrites preserve every surviving factual clause and replace only the false id-ordering claims; the coder verified by grep that the only remaining `ULID` mentions in either file are inside the new corrective text. Ratified.

**5.5 — Mutant scratch files were larger than "a copy of the function" in three tasks.** T3's Mutant C and T5's E1–E3 copies pulled in the surrounding module plumbing needed to exercise the mutated function standalone; T6's Mutant F is a controller-unit approximation rather than a booted Nest app, and G1/G2 are scratch-*directory* replications rather than mutations of the shipped fixtures. Every one of these approximations was **declared in the report** as the plan required, and each was the honest cheap equivalent of an infeasible exact mutant. Ratified.

**5.6 — T6's G2 dies one step earlier than the plan narrated.** `fixtureSchema.parse()` throws a `ZodError` on the gutted fixture (the schema already enforces `lines.min(1)`) before the `expect(...).toBeGreaterThan(0)` line is reached. The mutant still DIES; the observation was reported rather than treated as a defect. Ratified — the assertion's teeth are real either way, and the schema turning out to be a second line of defence is good news.

**5.7 — T2's commit carries no `Co-Authored-By` trailer.** The coder flagged the conflict between the global trailer instruction and its brief's "commit with the plan's EXACT commit message", and resolved it toward the brief and the repo's own convention (no preceding commit carries one). Correct call; all six commits are consistent.

**Deviations from earlier plans, deliberately not fixed:** everything in gate reports 01–06.1 §4/§5, including the `code: message` HTTP prefix, the open `ConfigError`/`TariffErrorCode` sets, and the simulate route's permission; `qr.test.ts`'s 1-in-4096 tamper flake; and the m2/m4/m9 deferrals, which no task touched.

---

## 6. The Assertion Book, EXECUTED — the verdict column filled from real runs

Per tripwire 21, every row below is a **measured** result. "= pre-fix red" means the shipped code was itself the mutant and the observed failing run is the executed evidence.

| # | Task | Predicted | **Executed verdict** |
|---|---|---|---|
| K1 | T1 | pre-fix red | **RED 15/20 isolated (75%)**, exact predicted shape; gate independently built the mutant → **DIED 5/5** |
| K2 | T1 | *measure, do not predict* | **SURVIVED 10/10**; gate independently reproduced **SURVIVED 10/10** — plan-authorised honest outcome (§5.2) |
| K3 | T1 | none owed, declared un-killable | **none built** — the declaration was honoured, no kill manufactured |
| K4 | T1 | structural pin | green by construction |
| K5 | T2 | required DIED | **SURVIVED 5/5 against the plan's test as written** → plan defect (§7) → after the in-scope correction, **DIED 5/5**; gate reproduced both (**SURVIVED 3/3** original, **DIED 5/5** corrected) |
| K6 | T2 | required DIED | **DIED 5/5**; gate independently **DIED 5/5** |
| K7 | T3 | pre-fix red | **RED**, observed `{code: approval_rejected, status: rejected}`; gate re-derived against a pre-fix module copy → **RED** |
| K8 | T3 | pre-fix red | **RED**, same observed pair; gate re-derived → **RED** |
| K9 | T3 | required DIED | **DIED 5/5**; gate independently **DIED 5/5** |
| K10 | T4 | required DIED | **DIED 5/5** (observed accepted `50000`, `requiresApproval: true`); gate independently **DIED 5/5** |
| K11 | T4 | required DIED | **DIED 5/5** (observed accepted `0`, `rejected: null`); same single mutant build, two kills |
| K12 | T4 | pre-fix red | **RED**, no throw observed; gate independently built it → **DIED** |
| K13 | T5 | pre-fix red | **RED**, four `manual_caps_missing` and no typed code, as predicted |
| K14–16 | T5 | required DIED ×3 | **DIED 1/1 each** (retired / FY25 / FY27 legs); gate independently rebuilt all three → **DIED 3/3**, baseline passing |
| K17 | T6 | required DIED | **DIED 5/5** (controller-unit approximation, declared) |
| K18 | T6 | required DIED | **DIED** (`.JSON` straggler in the scratch directory) |
| K19 | T6 | required DIED | **DIED** (gutted fixture copy; via `ZodError`, §5.6) |

**Nineteen rows, nineteen executed verdicts. Every required-DIED mutant died — one of them only after the test that was supposed to kill it was corrected.** Eleven of the mutants were independently rebuilt and re-run by the gates rather than accepted from a coder report.

---

## 7. The one gate rejection, in full — K5 falsified

This is the finding worth the whole plan, so it gets its own section.

**What the plan specified.** T2 Test 1 has an external `pg` client take the serializer's exact statement and hold it open:

```
SET_LOCK_SQL = select id from tariff_versions
               where status in ('submitted','activated') order by id for update
```

then fire `activateVersion` and assert it is still `"pending"` after 400 ms. The reasoning: a serializer-less implementation sails past a held lock and settles immediately, so the assertion discriminates deterministically. Assertion Book K5 recorded this as *required DIED* and called it "deterministic by design".

**What execution found.** That predicate matches the **target version's own row** — it is `submitted` at that moment. And `activateVersion`'s single-winner conditional UPDATE (`where id = versionId and status = 'submitted'`) must take an exclusive lock on that very row regardless of whether the serializer exists. So the serializer-less mutant **also blocks**, `expect(state).toBe("pending")` passes for both implementations, and the test cannot tell them apart. The T2 coder built Mutant A, watched it **SURVIVE 5/5**, correctly refused to commit, and reported it as a chain-halting plan defect. The gate independently reproduced **SURVIVED 3/3** against the plan's original shape before ruling.

**Why this matters more than an ordinary defect.** Audit finding A2 was *"the race test cannot see whether the lock locks"*. This plan existed to fix exactly that, and its fix had **the same blindness for a different reason**. Ledger §3.21 was a lock that did not lock; §3.25 was a backstop masking a missing mechanism; this is a *third* variant — **the observation point was inside the target's own write path**, so the mechanism under test and the thing that would block anyway were indistinguishable. A hand-walk could not have caught it; the plan's authoring passes, its stress pass, and my compile all read it as sound. Only building the wrong implementation and watching it pass did.

**The correction, and why it is legitimate.** The holder now locks a **different** row — a second submitted-and-approved version seeded after the target — via `select id from tariff_versions where id = $1 for update`. That row sits inside the serializer's set predicate and outside everything the target's own activation reads or writes, so the shipped code blocks on the set lock and the serializer-less mutant settles immediately. Mutant A then **DIED 5/5**. The change is confined to `versions.contention.test.ts`, which is T2's only file; the target is still created first so `versionNo` is still 1; both invariant assertions stay unconditional at exactly 1 and were re-verified by measurement, since the second version is only ever *submitted* and never activated. The coder disclosed all of it and did **not** edit the plan document, correctly treating `docs/**` as outside its Files list.

**The process cost, and the compile defect underneath it.** My brief's mutant-discipline block said flatly: *a required-DIED mutant that SURVIVES is a CHAIN HALT*. The owner's own framing was finer — *a disclosed defect fixable within the task's own scope may be fixed minimally in-task; anything larger halts the chain* — and this defect was **always** inside T2's own scope, because T2's only file is the test. The coder obeyed my cruder rule, halted, and committed nothing; the gate then failed the task on unmet criteria and issued the very correction the coder could have applied itself. **That round trip cost roughly 185k tokens to reach a conclusion available one rung earlier.** The rule was still right to fire — a survivor must never be silently fixed — but it needs the distinction the owner drew. New ledger entry §2.12.

---

## 8. Infrastructure and process

- **One infrastructure failure:** `gate:t6#1` died on `API Error: ENOTFOUND` after 733 s and 71,695 tokens. The ladder did exactly what §2.1 designed — **re-judged the same coder report with a fresh gate, did not re-run the coder, did not promote the tier.** `gate:t6#1~1` passed T6 on its own re-run of verify and the isolated suites. T6's commit `5fd3ad0` was already pushed before the first gate started, so the Plan 06 §7.4 "did the dead agent already push" hazard never arose.
- **Zero harness stalls** — the first pipeline in the series with none. Plan 06 lost ~420k to three, Plan 06.1 lost ~22 minutes to three.
- **No tripwire breaches by any agent.** No `/tmp` writes, no local-checkout writes, no bare `tsc`, no history rewrite, no security-code weakening, no non-isolating name filters, no exit status read from a pipe or a wrapper. Every long command ran detached with its exit in a file. Four separate agents independently found the `.plan-06-2-t2-halt/` residue and each correctly **left it alone** as not theirs to clean.
- **Two gates left their own scratch behind** (`.gate-verify.log`, `.gate-verify.exit` in `/opt/hmis`). Tripwire 4 is written at coders and the gate prompt never repeats it. Harmless, untracked, but it is prevention debt — §10.
- **Tripwire 20 held.** The pre-compile scout ran alone; nothing ran tests alongside the pipeline; every agent that measured reported explicitly that it saw no interference. My own post-pipeline verify, contention runs and suite re-runs were serialised one after another.

---

## 9. Cost accounting

| | |
|---|---|
| Pipeline agents | 15 (14 completed, 1 killed by `ENOTFOUND`) |
| Pipeline tokens | **1,478,505** |
| Pre-compile measurement scout | 53,123 |
| **Total** | **1,531,628** |
| Wall clock | **3h 10m 35s** |
| Calibration | 1.4–2.1M, midpoint ~1.65M, 2.5–3.5h |

**Inside the band, ~7% under the stated midpoint, and inside the wall-clock estimate — the second consecutive plan to land inside its own calibration.** Per task including its gate: 181k–368k, mean 246k, against 06.1's 165k–278k / mean 204k. The rise is the mandatory mutant builds, which the plan predicted at 10–20% on the heavier tasks and which cost about that.

Where the two non-clean expenditures went:
- **The K5 plan defect: ~185k** (gate #1's rejection, the retry coder, and gate #2 above what a single clean gate would have cost). This is a **genuine defect catch and worth every token** — it is the difference between shipping a second non-discriminating A2 test and shipping one that works.
- **The `ENOTFOUND` gate: 71,695**, no code, pure infrastructure. Against the 0.3–0.5M contingency, ~72k consumed. Budgeting for infrastructure rather than hoping it away has now worked three plans running.

---

## 10. Open items

1. **The plan document's K5 row and T2 Step 1 code block are WRONG as committed** and are corrected in place by this session, marked as a post-execution correction. Measurement beats the document — the plan's own rule, applied to the plan.
2. **Server residue awaiting the owner's call:** `/opt/hmis/.plan-06-2-t2-halt/` (18 files — the halted T2 attempt's logs and `.bak` mutant copies, deliberately preserved as the SURVIVED-5/5 evidence) and `.gate-verify.log` / `.gate-verify.exit`. All untracked; none is collected by jest (`.bak` does not match `*.test.ts`); the committed tree has **zero** `*.mutant.*` residue. Recommend deleting both once this report has been read — the evidence they hold is now written down here.
3. **Carried forward, unchanged:** workflow transitions ordered by bare `at` with no tie-break (`workflow.controller.ts:142`), for the next plan that owns workflow read surfaces.
4. **Plan 07 must not order by `newId()` anywhere.** The `ids.ts` WARNING comment and this plan's `seq` precedent are the guardrails. Any Plan 07 table whose insertion order is load-bearing gets its own `bigserial seq`.
5. **m2, m4, m9 remain deferred** with the reasons in the plan's disposition map. m4 in particular should stay deferred while T2's suite stands: typing the raw `23505` inside `activateVersion` would destroy A2's unit-level discriminator.
6. **Sequences are not reset by `truncateAll`** (no `RESTART IDENTITY`), so `seq` climbs across tests within a worker database. Harmless — only monotonicity is load-bearing — but recorded because a future reader may expect per-test reset.
7. **The gate prompt should carry tripwire 4.** See §8.

---

## 11. Did the executed-mutant rule hold?

Yes, and unlike 06.1's two-audit rule it was **tested on its first run and it fired**.

Plan 06.1's Assertion Book was checked by hand by two gates and a main session and read as sound; executed, it was wrong twice in opposite directions. This plan required every named mutant to be built and run, and the very first CRITICAL fix it applied that rule to — the A2 replacement — turned out to rest on a false prediction. The rule cost about 185k to catch it. The alternative was shipping a second non-discriminating test for the same invariant, discovering it in a third post-ship audit, and writing a Plan 06.3.

Two further things earned their keep. **Coders briefed to disclose plan defects rather than work around them** produced the catch — the T2 coder halted a chain rather than quietly adjusting a lock statement until the mutant died, which is the failure mode that would have hidden this forever. And **gates that rebuild mutants instead of reading about them** — eleven of nineteen rows were independently re-executed by a gate, including the gate that reproduced the original SURVIVED before accepting the correction.

The honest caveat: **one required-DIED row needed the test corrected to die, and one row (K2) SURVIVED by design.** Neither is a failure. But nobody should read "19/19 executed" as "19/19 killed" — the value of the Book is that those two facts are now written down as measurements instead of assumed away as predictions.

---

## 12. Lessons for the ledger

Appended to [`EXECUTION-LESSONS.md`](EXECUTION-LESSONS.md) the same session:

- **§3.28** — a test that observes a lock must hold a row **outside the target's own write path**, or the mechanism and the thing that would block anyway are indistinguishable. The third variant of the §3.21/§3.25 family, and the first found by an executed mutant rather than by an audit.
- **§2.12** — a chain-halt rule for surviving mutants must distinguish *the shipped code is wrong* (halt) from *the plan's test cannot discriminate* (in-scope fix, disclose, re-run). My brief collapsed the two and cost a rung.
- **Cost-ledger rows** for both, plus the `ENOTFOUND` gate and the plan totals.
- **Prevention debt:** the gate prompt does not carry tripwire 4, so gates leave scratch; and a halt directory has no owner, so residue accumulates until the main session clears it.
