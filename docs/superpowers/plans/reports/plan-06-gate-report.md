# Plan 06 Gate Report — Tariff, Adjustment & GST Engine + Golden Suite

**Plan:** `docs/superpowers/plans/2026-08-14-phase1-06-tariff-gst-golden.md` (written and committed at `e315f3c`)
**Executed:** 2026-08-14, two pipelines (A = T1–T6, B = T7–T10), owner-approved for pipeline execution.
**Outcome: 10/10 tasks shipped and gate-passed. Zero halts on the plan itself; one infrastructure halt, recovered.**

Baseline entering the plan: `e315f3c`. Final state: **`fe1fd5a`**, eleven commits, CI green on every one.

---

## 1. Final state

| Workspace | Entering Plan 06 | Leaving Plan 06 |
|---|---|---|
| `apps/core` | 54 suites / 269 tests | **68 suites / 360 tests** |
| `packages/contracts` | 3 suites / 7 tests | 3 suites / 7 tests (byte-untouched) |
| `apps/web` | 11 files / 37 tests | 11 files / 37 tests (byte-untouched) |
| **Repo total** | 68 suites / 313 tests | **82 suites / 404 tests** |

Root `pnpm verify` (typecheck + lint + test across three workspaces) exits **0**, run detached with the exit code read from a file. `eslint .` produces **zero output** — the repo's lint remains pristine. Exactly **one** migration was generated (`0007_happy_tag`), in Task 1, as specified.

**Frozen-path audit over the whole plan (`git diff --name-only e315f3c..HEAD`): CLEAN.** Nothing under `apps/web/`, `packages/contracts/`, `apps/core/src/modules/patients/`, or `.github/workflows/` was touched by any of the eleven commits. 57 files changed, all inside the tariff module, its schema, its scripts, the shared test helper (T1 only), `app.module.ts` (T8 only), `package.json` (T5 and T9 only), and `README.md` (T10 only).

---

## 2. Task outcomes

| # | Task | Tier | Attempts | Commit | Files |
|---|---|---|---|---|---|
| T1 | Schema — 7 tables, migration 0007, truncate group | sonnet | 1 | `2a7f547` | 7 |
| T2 | Money primitives, service master, regulated prices | sonnet | 1 | `24c1080` | 5 |
| T3 | Pure engine — types, contest, GST, `priceInvoiceLines` | **opus** | 1 | `b5104b2` | 7 |
| T4 | Tariff versions — draft/submit/activate via approvals | sonnet | **2** | `09f4ae0` → `d6c2e6b` | 3 + 1 |
| T5 | Context loader, rule/GST config, seed, D-17 library | sonnet | 1 | `d61ca7d` | 8 |
| T6 | Golden suite — 12 hand-computed fixtures, harness | **opus** | 1 | `1e1aa27` | 14 |
| T7 | Impact simulation + g12 fixture | sonnet | 1 (+1 lost to infra) | `b3d3c0b` | 5 |
| T8 | Module surface — 17 routes, manifest, index, e2e | sonnet | 1 | `5fc1939` | 6 |
| T9 | `validate:tariff` D-17 gate script | sonnet | 1 | `e8b034a` | 2 |
| T10 | Lifecycle proof + docs | sonnet | 1 | `fe1fd5a` | 2 |

**9 of 10 tasks passed on the first attempt.** The single retry (T4) was a genuine gate catch and is documented in §6.

Every commit's `--stat` was diffed against its task's authorized file list by the main session; all eleven match exactly. T4's correction landed as a **new commit** on top of the already-pushed `09f4ae0` — tripwire 15 held, no history was rewritten anywhere in the plan.

---

## 3. Verification evidence

Independent of agent self-reports, the main session verified:

- **Detached `pnpm verify` after each pipeline**, exit code read from a file under `/opt/hmis` (never a wrapper, never a pipe). Both exit 0.
- **CI observed green on all eleven commits** via `gh run list --json headSha,conclusion`.
- **Per-commit `--stat`** against the authorized file list for every task.
- **Frozen-path audit** across the whole plan range.
- **The T4 race test re-run 20 times in isolation** by the main session, with isolation confirmed from the output (`8 skipped, 1 passed` per invocation), all 20 exit 0. See §6 and §7.2 for why this was necessary.
- **Server tree clean and `HEAD == origin/main`** at the close of each pipeline; all scratch files removed.

---

## 4. Shipped public interfaces (transcribed from source at `fe1fd5a`)

Transcribed byte-for-byte from the server by a read-only scout — not from the plan text, not from memory.

### 4.1 `modules/tariff/index.ts` — the frozen cross-module interface

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

`test/tariff-lifecycle.e2e.test.ts` imports every tariff symbol it uses from this index alone — that test existing and passing **is** the proof the surface suffices for a consumer.

### 4.2 Key signatures

```ts
// pricing.ts — the whole public surface, PURE + SYNCHRONOUS
export function priceInvoiceLines(ctx: PricingContext, lines: InvoiceLineInput[]): PricedLine[]

// simulation.ts — PURE + SYNCHRONOUS
export function simulateRevision(currentCtx: PricingContext, draftCtx: PricingContext, lines: InvoiceLineInput[]): ImpactReport

// context.ts — the impure boundary
export async function loadPricingContext(
  db: Db, opts: { at: Date; tariffVersionId?: string; allowDraft?: boolean; tags?: string[] },
): Promise<PricingContext>
export type ConfigError = { code: string; detail: string };
export async function validateTariffConfig(db: Db, at: Date): Promise<{ ok: boolean; errors: ConfigError[]; caSigned: boolean }>

// versions.ts — note activateVersion takes Db, not Tx; it manages its own transaction
export async function activateVersion(db: Db, actor: Actor, versionId: string, effectiveFrom: Date): Promise<{ versionNo: number; effectiveFrom: Date }>
export async function resolveActiveTariffVersion(db: Db, at: Date): Promise<{ versionId: string; versionNo: number } | null>

// money.ts — the ONLY rounding primitives in the module
export function divHalfUp(n: number, d: number): number      // floor((2n + d) / (2d))
export function percentAmount(grossPaise: number, bps: number): number
export function taxHead(basePaise: number, rateBps: number): number
export function roundTotalToRupee(totalPaise: number): { roundedPaise: number; roundingPaise: number }

// contest.ts — the plugin contract Plan 09 implements
export type AdjustmentSource = { key: string; propose(ctx, line, grossPaise): AdjustmentCandidate[] } // PURE, sync
```

`PricingContext.sources` **order is the tie-break precedence**; Plan 06 ships exactly `["rule", "manual"]`.

### 4.3 Events — the module's complete catalog, exactly two names

```ts
export const tariffRevisionApplied = defineEvent("tariff.revision_applied", "tariff", z.object({
  versionId, versionNo, effectiveFrom /* ISO string */, approvalId, itemCount,
}));
export const configValidated = defineEvent("config.validated", "tariff", z.object({
  scope: z.literal("tariff"), ok, errorCount, caSigned,
}));
```

Neither has subscribers yet; the dispatcher is unscheduled until Plan 11. Nothing in this plan wires consumers, correctly.

### 4.4 HTTP surface — 17 routes, prefix `/tariff`, every one `@RequirePermission(..., "hospital")`

| Method | Path | Permission | HttpCode |
|---|---|---|---|
| GET | `/tariff/services` | `tariff.read` | — |
| POST | `/tariff/services` | `tariff.services.manage` | 201 |
| PATCH | `/tariff/services/:id` | `tariff.services.manage` | — |
| POST | `/tariff/services/:id/regulated-prices` | `tariff.services.manage` | 201 |
| GET | `/tariff/services/:id/regulated-prices` | `tariff.read` | — |
| GET | `/tariff/versions` | `tariff.read` | — |
| POST | `/tariff/versions` | `tariff.versions.draft` | 201 |
| GET | `/tariff/versions/:id` | `tariff.read` | — |
| PUT | `/tariff/versions/:id/items/:serviceId` | `tariff.versions.draft` | — |
| POST | `/tariff/versions/:id/submit` | `tariff.versions.draft` | **200** |
| POST | `/tariff/versions/:id/activate` | `tariff.versions.activate` | **200** |
| POST | `/tariff/versions/:id/simulate` | `tariff.versions.draft` | **200** |
| GET | `/tariff/rules` | `tariff.read` | — |
| POST | `/tariff/rules` | `tariff.config.manage` | 201 |
| GET | `/tariff/gst` | `tariff.read` | — |
| PUT | `/tariff/gst/config/:category` | `tariff.config.manage` | — |
| PUT | `/tariff/gst/settings` | `tariff.config.manage` | — |

Manifest permissions: `tariff.read`, `tariff.services.manage`, `tariff.versions.draft`, `tariff.versions.activate`, `tariff.config.manage`. `menu: []` — no UI this plan.

### 4.5 Error mapping

| Status | Codes |
|---|---|
| 404 | `unknown_service`, `unknown_version`, `unknown_rule` |
| 403 | `sod_drafter_activator` |
| 400 | `invalid_paise`, `invalid_qty`, `invalid_rule_params`, `regulated_bounds_missing`, `gst_config_invalid` |
| 409 | every remaining state/config code (13 of them), plus any `ApprovalError` / `WorkflowError` |
| — | anything else rethrown |

All 22 `TariffErrorCode` values are covered with no gaps or overlaps. See §5.1 for the message-format deviation.

---

## 5. Deviations

**5.1 — Error codes are exposed in HTTP response bodies.** `toHttp` formats every `TariffError` response message as `` `${e.code}: ${e.message}` ``. The plan required T8's SoD test to find the literal string `sod_drafter_activator` in the response body (§3.14b: a bare 403 proves nothing, since the permission guard produces the same status), but `versions.ts` — frozen to T8 — never puts the code in the message text. Applying the prefix uniformly rather than special-casing one code keeps the mapping consistent and auditable across all 22 codes without touching a frozen file. **This is a public API surface decision that was not in the plan.** Plan 08's UI will receive `code: message` strings and can discriminate on the prefix; if that is undesirable, changing it is a one-line edit in `toHttp` plus the T8 SoD assertion.

**5.2 — One route bypasses the service layer.** `GET /tariff/services/:id/regulated-prices` queries the `regulatedPrices` table directly through drizzle inside the controller. `services.ts` exposes only `resolveRegulatedPrices(db, at)`, which returns a latest-as-of-date map across *all* services rather than one service's full row history, and `services.ts` was outside T8's file list. The coder followed the `patients.controller.ts` precedent (its `patientGuardians` route does the same). **Carried forward:** the next task that legitimately owns `services.ts` should add a proper `listRegulatedPrices(db, serviceId)` accessor and move the query behind it.

**5.3 — `POST /tariff/versions/:id/simulate` is gated on `tariff.versions.draft`, not `tariff.read`.** This follows the plan's route table exactly. Flagged because it means a read-only user cannot run an impact simulation; if Plan 08's billing UI expects that, the permission needs revisiting as a deliberate decision rather than a discovery.

**5.4 — T5 introduced three `ConfigError` codes not named in the plan:** `manual_caps_missing`, `smoke_price_failed`, `context_load_failed`. `ConfigError.code` is typed as plain `string` by the plan's own interface, and these cover validation failures with no existing `TariffErrorCode` equivalent. Existing codes were reused wherever one fit. **Important for consumers:** the realizable code set is **open**, not closed — three catch sites pass through any `TariffErrorCode` via a ternary, so the full set is those 9 literals ∪ the entire 22-member union. Do not write an exhaustive switch over it.

**5.5 — T5 wrapped the context load for smoke-pricing in its own try/catch**, beyond the plan's one-line D7 description. `loadRuleConfig` deliberately throws (via `.parse()`, not `safeParse`) on a corrupted `adjustment_rules.params` row, mirroring real billing-time behaviour; without the extra guard the "never throws" requirement would be violated by the corrupt-params test. An elaboration on the plan, not a departure from it.

**5.6 — `hmis_dev` was migrated and seeded** by T5's idempotency demonstration (`db:migrate` then `seed:tariff` twice). It now carries 5 `gst_config` rows, 1 `gst_settings` row and 4 `adjustment_rules` cap rows; `services`, `tariff_versions`, `tariff_items` and `regulated_prices` remain empty. No database was created or dropped.

**Deviations from earlier plans, deliberately not fixed:** everything in gate reports 01–05 §4, plus `qr.test.ts`'s 1-in-4096 tamper-payload flake, which remains untouched and still belongs to a future task that owns that file.

---

## 6. The gate catch — T4's activation race (a plan defect)

**This is the plan's most instructive defect and the only genuine gate rejection in ten tasks.**

The plan's Task 4 "Semantics" block specifies the race serializer verbatim as:

```
SELECT id FROM tariff_versions WHERE status = 'activated' FOR UPDATE
```

**That predicate matches zero rows whenever nothing has yet been activated — which is exactly the state the race test constructs.** It therefore acquired no lock and serialized nothing. Both racers reached the monotonicity re-check; the loser read the activated set *after* the winner committed, saw its own just-written `effectiveFrom`, and threw `effective_from_not_monotone` before ever reaching the single-winner conditional UPDATE that is supposed to be the sole arbiter.

The plan's own §3.13-aware self-review asserted that the loser's code had been *"traced"* to the single value `not_submitted`. **The trace was performed against a serializer that does not serialize**, so the conclusion was wrong — and the failure surfaced only 1 run in 15.

The gate found it by refusing to accept the coder's evidence: it ran the race test **15 times in isolation** and caught a failure on run 4. Its corrections were precise and correctly bounded — take a row lock on the version actually being activated; exclude that version from the monotonicity comparison with `ne(id, versionId)`; **do not widen the test's assertion** ("the single enumerated value is the specification; fix `versions.ts` so it holds"); and explicitly, do not amend the already-pushed commit. The retry changed one file by nine lines and landed a new commit.

**Fix for the plan text (for anyone re-reading it):** D5's activation semantics should read *"lock the target row (`WHERE id = :versionId FOR UPDATE`), then re-check monotonicity against all other activated versions."* The `status = 'activated'` lock is optional and was kept for cross-version serialization.

---

## 7. Process failures and their costs

**7.1 — Three harness stalls in pipeline A cost roughly 420k tokens.** `sonnet:t4` stalled at 1513 s, `sonnet:t5` at 406 s, `gate:t4#2` at 227 s; each was auto-retried by the runtime. **The three stalled agents are the three most expensive agents in the entire plan** — 262k, 337k and 122k against peer costs of 86–115k for coders and 58–101k for gates. This is the single largest cost driver of the run and it produced no code.

**7.2 — A gate lowered the evidence bar its predecessor had set.** Gate #1 failed T4 and demanded 20 *isolated* re-runs. Gate #2 passed the fix on **five non-isolating runs** — its own log records `9 passed/9 total` each time, meaning the full suite ran, using the very command form gate #1 had just diagnosed as broken. The fix was structurally correct, but the verification was weaker than specified. **Caught by main-session verification**, which re-ran the isolated form 20 times (20/20 clean, `8 skipped, 1 passed` confirming isolation). Prevention: the isolation requirement is now in the gate prompt itself, and tripwire 19 is in every brief.

**7.3 — Pipeline B's first launch was destroyed by a network outage: ~134k tokens, no code.** The T7 coder died four times — one truncated response, then three consecutive `ENOTFOUND` — exhausting `MAX_INFRA`. **The ladder behaved exactly as designed**: no tier promotion, no defect attempt consumed, and T8–T10 skipped on the dependency edge rather than running against an unfinished T7. This is §2.1's fix working.

**7.4 — The dangerous state that outage produced: shipped code that no gate had seen.** The first T7 coder **completed its work and pushed `b3d3c0b` before its response died in transit**. On resume, the naive move — re-running the coder — would have either re-implemented correct work or produced a report the gate would review *instead of* the code. T7's brief was rewritten into a verify-and-complete rung that stated the arrival state plainly, inherited the fail-first obligation rather than reproducing it, forbade amending the pushed commit, and declared a zero diff a valid success. The agent verified every criterion, re-derived G12 by hand, found no defect, and **changed nothing** — the correct outcome. **New standing rule: after any infrastructure halt, check whether the dead agent committed or pushed before resuming, and convert the task to a verify-only rung if it did.**

**7.5 — A stalled agent left an unexplained local commit.** Pipeline A's stalled `sonnet:t4` had created `09f4ae0` locally before dying. Its replacement found a local commit one ahead of origin, correctly refused to infer who made it (tripwire 8), independently verified its contents, and pushed it. Handled well, but it cost a round of investigation, and it is the same root cause as 7.4.

**7.6 — Two compile defects, both mine.** (a) My T5 brief asserted **no `.env` file exists** on the server; `apps/core/.env` does exist (12 keys). Harmless — `process.env` wins over dotenv and the inline `DATABASE_URL` worked as briefed — and the coder disclosed the discrepancy rather than adapting silently. This is §3.20 recurring: claiming exhaustiveness about a host environment I had not fully inspected. (b) My T8 acceptance criterion said *"the four validation codes → 400"*; the plan lists **five**. The coder typed the plan's five, verified they reconcile exactly against all 22 codes, and flagged my number as the error.

**7.7 — The main session broke two of its own tripwires, again.** It wrote the baseline verify's scratch files to `/tmp` (tripwire 3 — the rule it pastes into every brief), and later piped `git pull --rebase` into `tail`, so a genuine failure was masked by tail's exit 0 (tripwire 16). Both were caught by reading output rather than assuming, both cost nothing, and both are the ledger's §226 pattern recurring for the sixth and seventh time.

---

## 8. Cost accounting

| | Agents | Tokens | Wall clock |
|---|---|---|---|
| Pipeline A (T1–T6) | 14 | 1,738,375 | ~3h08m |
| Pipeline B, first launch (halted on infra) | 4 | 134,257 | ~2h07m |
| Pipeline B, resumed (T7–T10) | 8 | 773,451 | ~1h14m |
| **Pipeline total** | **26** | **2,646,083** | **~6h29m** |
| Scouts (pre-compile, stress pass, interface transcription) | 3 | 142,585 | — |
| **Plan total** | **29** | **2,788,668** | — |

**The plan's calibration was 1.5–1.7M; the actual came in ~56–76% over.** The overrun is almost entirely non-productive:

- ~420k — pipeline A's three harness stalls (§7.1)
- ~134k — the network outage that halted pipeline B (§7.3)
- ~175k — the T4 gate catch (retry coder + re-gate); **this one was worth paying for**

Strip the stalls and the outage and the run lands near **2.09M** — still ~25% over the estimate, but in ordinary territory. The calibration itself was drawn from Plan 04's backend numbers (~160k/task); Plan 06's real per-task cost for a *clean* task was 130–200k including its gate, so the model is sound and the estimate was slightly optimistic for a 10-task plan with two opus tasks.

---

## 9. What Plans 07, 08 and 09 can rely on

- **`priceInvoiceLines(ctx, lines)` is pure and synchronous**, and CI enforces it: the purity greps (`await`, `kernel/`, `new Date(`, `Math.random`) run against `money.ts`, `types.ts`, `contest.ts`, `gst.ts`, `pricing.ts`, `simulation.ts`. Everything impure lives in `loadPricingContext`. Plan 08 can price without a database in tests.
- **The tariff lock is real and proven in both directions.** `loadPricingContext({ tariffVersionId })` pins an explicit version — the mechanism IPD needs for an admitted patient whose stay spans a revision — and `resolveActiveTariffVersion(db, at)` resolves the version that was active on a past date, for backdated reprints. `tariff-lifecycle.e2e.test.ts` test 4 asserts both.
- **The `AdjustmentSource` interface is frozen**: `{ key, propose(ctx, line, grossPaise): AdjustmentCandidate[] }`, pure and synchronous. Plan 09 registers `"coupon"` and `"membership"` against it and adds fixtures to **this** harness. `PricingContext.sources` order is the tie-break precedence.
- **`PricedLine` carries the full audit answer to "why this rate"** — every candidate including rejected ones with the amount that was *asked*, the winner, the regulated clamp with the bound applied, and per-line taxable/exempt turnover with SAC. That per-line output is the Rule 42/43 ITC-reversal data D-3 requires; Plan 08 aggregates it at invoice/GSTR time. `PricedLine.regulatedClamp` is the source for `ceiling.price_applied` emission at invoice time.
- **`requiresApproval` is computed but not enforced.** The contest sets the flag using exact rational comparison; **Plan 08 must enforce it** against the approvals engine before accepting a manual discount. Nothing in Plan 06 blocks an over-threshold discount at write time.
- **`roundTotalToRupee`** is shipped and unused, waiting for Plan 08's CGST-Act §170 invoice-rounding line.
- **The golden harness is extensible**: add a JSON fixture, bump the count assertion in `golden.test.ts` (currently pinned at **13**), and add a schema variant + a harness branch if the new case is not a `price` or `price_error`. **The harness branch is required, not optional** — the price path reads `expected.length` and a new variant with a different `expected` shape fails the build without one.
- **Approval-gating is now demonstrated twice** (patient merge in Plan 05, tariff revision here) with the same shape: `requestApproval` on the caller's transaction, check-on-execute against the approvals row, SoD, single-winner conditional UPDATE, then the event. Plan 08's refunds and discount overrides follow it with no engine work.
- **Money is integer paise end to end**, with one rounding primitive (`divHalfUp`) used everywhere and no `z.coerce` anywhere in the module.

---

## 10. Open items

1. **`qr.test.ts`'s 1-in-4096 tamper-payload flake** — still carried, still untouched, still belongs to the next task that legitimately owns that file. (Carried from Plan 05 §7.6.)
2. **`listRegulatedPrices(db, serviceId)` accessor missing** — §5.2. The controller queries the table directly until a task owning `services.ts` adds it.
3. **Error-code prefixes in HTTP messages** — §5.1. A deliberate, disclosed API-surface decision Plan 08 inherits; revisit if the UI should not see internal codes.
4. **`simulate` requires `tariff.versions.draft`** — §5.3. Confirm this is what Plan 08's UI wants.
5. **The §10.4 Class-A two-key upgrade** (owner + Medical Superintendent) is a workflow-definition **data** change at go-live, not code. v1 registers a single approver role because the shipped flow builder supports exactly one.
6. **`gst_config` values are dev placeholders.** Every seeded value carries a `DEV PLACEHOLDER — CA sign-off required (§19)` comment and `caSigned` is `false`.

---

## 11. Go-live gates this plan creates

These are hard prerequisites before the first live invoice, recorded in `README.md`'s new runbook section:

1. **Register the `tariff_revision` approval type as data** — build with `approvalFlowDefinition({ typeKey: "tariff_revision", approverRole: "owner", ... })`, draft and activate through `/workflow/definitions` with drafter ≠ activator, then `POST /approvals/types`. Nothing in the tariff module works without it.
2. **`pnpm --filter @hmis/core seed:tariff`**, then load the hospital's real tariffs and regulated prices through `/tariff/services` and `/tariff/versions`.
3. **CA sign-off (§19)** — review every `gst_config` / `gst_settings` row against real practice, **including G13's stated assumption that the room-rent ₹5,000/day threshold compares the POST-DISCOUNT charged value** (fixture `g13-room-rent-postdiscount-ca.json` carries this as a `caFlag`; if the CA rules for the pre-discount reading, the change is one comparison in `gst.ts` and G13's expectation moves from net 495000 to 519750). Then set `caSigned: true` via `PUT /tariff/gst/settings`.
4. **`pnpm --filter @hmis/core validate:tariff` must print `ok=true`** before the first live invoice (D-17). The golden suite plus this script's printed report **is** the config-validation evidence. Against a config-only dev database the script correctly returns `ok=false`, exit 1 — the loud-failure direction was demonstrated by execution in T9.

---

## 12. The §3.14 guarantee — did it hold?

**Yes, and here is the evidence rather than the assertion.**

The plan was built around one rule: every golden expected value hand-computed from the spec, never produced by running the engine. Three independent things confirm it held:

1. **T6 disclosed its authoring method in full.** To keep the ~2.5 KB CONFIG_A block byte-identical across twelve files it used a throwaway generator holding CONFIG_A once and **every expected value as a hand-typed literal transcribed from the Fixture Book**. The script performed no arithmetic, imported nothing from the module, and never called the engine; it was deleted before the commit and `git status` was verified clean.
2. **Both gates re-derived fixtures by hand.** T6's gate independently re-derived G02, G03-L1, G05-L2, G07 and G13; T7's gate re-derived G12's full totals row. No mismatch was found anywhere.
3. **No halt event fired.** The engine and the Book agreed on every figure in thirteen fixtures. The halt rule was in force the whole time and was never needed — which is the outcome you want, provided the rule was genuinely armed. It was: T7's verify-only rung explicitly re-derived G12 *by hand rather than by re-running the engine*, and said so.

The harness has demonstrated teeth: the inline mutant test proves that deleting the `cfg.exempt` branch produces `cgstPaise: 4500` where G01 expects `0`, so the full deep-equal kills it. The fixture count is pinned so an empty or truncated directory cannot pass vacuously, and `workings` under 20 characters fails to parse.

---

## 13. Lessons for the ledger

Appended to `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` in the same session:

- **New §3.21** — a lock predicate that matches no rows is not a lock; and a race assertion whose "trace" was performed against the wrong serializer is worse than an untraced one (§6).
- **New tripwire 19** — `pnpm <script> -- <path> --testNamePattern=X` does not isolate; use `exec jest ... -t` and confirm isolation from the output (§7.2).
- **New process rule** — after an infrastructure halt, check whether the dead agent committed or pushed before resuming; convert to a verify-only rung if it did (§7.4).
- **Harness stalls are now the dominant cost driver**, not model choice or task complexity (§7.1).
- **§3.20 recurrence and a criterion miscount**, both compile defects of the main session (§7.6).
- **§226 recurrence** — the main session broke its own tripwires 3 and 16 (§7.7).
- **The stress pass earned its keep again**: it caught an acceptance criterion that was literally unreachable (T10's `ok:true` requires all four D-8 caps seeded, which the plan's setup did not say), plus the g12 sort-order trap, the harness-branch build break, and the open-vs-closed error-code set — none of which cost a retry because they were fixed before firing.
