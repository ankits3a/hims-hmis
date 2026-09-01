# HANDOFF — Registration Counter series, RC-1 closed → RC-2 next

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis` on the build host. Written 2026-09-01 by the RC-1 session at its context limit; every fact here is a POINTER to where the authority lives — trust the pointed-at file over this summary if they ever disagree (the §1 fact rule).

---

## Mission state in one paragraph

You are the **Registration Counter lane** of the agentic hospital OS, building the owner-approved Desk One seat in four phases. **RC-1 (counter rails & flows, server) is CLOSED, code-complete, NOT deployed** — nothing open, triple-attested. **Your job is RC-2 — benefits at the counter** (unless the owner reorders to RC-3, the seat itself; both stand on RC-1's rails). The standing prohibition holds: **no deploy anywhere in this series** — production has never left `commissioning`; code-complete + green evidence is the finish line.

## Read these, in this order, before any edit

1. `docs/superpowers/plans/2026-08-31-phase1-rc1-counter-rails.md` — RC-1's phase doc **including its CLOSE**: what shipped, the two review passes, the named carries, the owner rulings, the full-pass numbers. This is the densest single source.
2. `docs/superpowers/plans/2026-08-31-EXECUTE-PROMPT-registration-counter.md` — the original design-to-engineering handoff: the four-demo done-definition, the owner's design rulings 1–7, the A–D build lists (B = your RC-2), the discipline block.
3. Auto-memory `registration-counter-build.md` (loads with your session) — the compressed series state.
4. `docs/superpowers/EXECUTE-METHOD-V3.md` — the method (one doc per phase, LIGHT lane, stop-loss formula in §6 with all amendments, §9.9's verify rules INCLUDING the new rule 9).
5. `docs/superpowers/AGENT-RULES.md` — the binding contract. Then ledger §5 only; cite §2 entries BY NUMBER, never open the whole ledger (~106k tokens).
6. Before authoring RC-2's phase doc: brainstorm §1/§13/§14 of `docs/superpowers/brainstorms/2026-08-27-department-series/13-memberships-packages-crm.md` (and 20-front-office for context) — the handoff's standing rule.

## What RC-1 shipped (verify by reading, the SHAs are the record)

Commits `7035915`..`04b5496` on main. Migration **0048** (`counter_sequence`/`token_lane` on `opd_config`, `avg_consult_minutes` on departments — defaults ARE the shipped behaviour). New permission `opd.counter.flow.manage` (147 declared = 132 held + 15; README OPD table 15 rows). `PUT /opd/config/counter-flow` (narrow body, both directions pinned). Deferred queue join: `join:"defer"` on walk-in/openVisit (overloaded — shipped callers keep non-null types) + idempotent race-safe `POST /opd/visits/:id/join-queue`. `encounterFeeStatuses` (billing, batched, selects on the encounter's OWN fee service exactly as `gate.ts` does) + `registerFeeSettledHook` + `queue.fee_settled` event riding the settling transaction. `matchedOn` lanes on patient search (one predicate, SQL fragments doubling as boolean columns). `FeeQuote.freeReason` + `DoctorSummary.avgConsultMinutes`. The resurrected `changeGivenPaise` money defect fixed at THREE layers (controller zod, server ceiling `min(surplus, cash tendered)`, counter-desk default). Final evidence: **core 3267/3268 (the one red was a lifecycle event pin, fixed `9bcc05f`) + web 61/61 files + contracts 21/21**, sequential `-w 2` on `hmis_rc_scratch`; `perf-opd-queue` held (listQueue median 18 ms).

## Owner rulings that bind you — do not relitigate

1. **BEST SINGLE BENEFIT** (2026-08-31): Plan 09's pricing-contest semantics stand — one winner per line, NO stacking. The design's `priceOf()` stacking is overruled; the UI shows which chip won and why the others lost. This is RC-2's central constraint.
2. **Theming = ALIAS LAYER** (same): Desk One's paper-and-pine as a parallel token set beside the shadcn vars; the counter seat adopts first, others gradually. RC-3's concern.
3. Standing: decide industry-standard judgment calls yourself and mark DECIDED with one line; stop only for money/procurement/law; close every open item before the next phase; name the owner's rulings in CLOSE.
4. **PENDING OWNER RULING (surface it, don't apply it):** `maxWorkers: 2` in `apps/core/jest.config.cjs` — recommended by all three lanes, evidence in ledger §2.151 (it would also fix CI's false reds, likely making CI faster). Apply ONLY on the owner's word, between suite runs, as its own commit.

## RC-2 — benefits at the counter (the phase you author next)

From the EXECUTE prompt's build list B, reshaped by recon findings (memberships/coupons/partners ALREADY EXIST server-side from Plan 09, deployed inert behind flags): **arm, don't build.**
- Membership % + coupon recognition wired into the counter quote path (`composeBenefits` → contest, behind `MEMBER_BENEFITS_ENABLED` — read the env-flag comment at `invoices.ts` before touching; catalogs are empty by DD3, synthetic book lives out-of-git at `/opt/hmis-context/`).
- Referral-as-discount: a NEW contest `AdjustmentSource` (partners module has attribution + commission ledger but proposes nothing into pricing; `walk-in` already accepts `referralSource`/`referrerName` — the web never sends them). Partner LEDGER entry per the design; commission accrual flag stays OFF (O-8 unruled).
- Enrol-vs-apply permission split, day one (only *apply* exists: `membership.instrument.read/recognise`; `membership.catalog.manage` guards no route — the seed test treats that as deliberate, plan your grants in the same commit, §2.138 both greps + full-verify census discipline).
- Corporate v0 = `intendedPayer` recorded + the shipped credit-extended exit named on screen (real panel machinery is Plan 21's — no second home); package v0 rides `membership_plans.kind='package'` + entitlement counters. Both were DECIDED in RC-1's CLOSE.
- Review-window ₹0 already works and is now NAMED (`freeReason`) — RC-2 only renders it.
Stop-loss per §6's current formula from `docs/superpowers/pipelines/token-baselines.json` (RC-1's row is appended: LIGHT, 5 tasks, ~1.15M total, review:coding ≈ 0.9, remediation factor ~2.0 again).

## Carries with named owners (from RC-1's CLOSE — the detail lives there)

- **M3 → RC-3's board task**: no un-settle push. Three writers move an encounter OUT of settled and reach no hook — `reverseAllocation` (receipts.ts:555), `markEnteredInError` (:659), `issueCreditNote` (credit-notes.ts:282); staleness runs in the OPTIMISTIC direction. Needs an event (and rename `queue.fee_settled` → `queue.fee_status_changed` while it is still unconsumed), not just call sites.
- **RC-4 projects, never re-stores**: `agent_ledger` is RC-4's; the VD-1 lane deliberately emits domain events instead (`vitals.recheck_demanded`, `queue.escalated`, `queue.escalation_cancelled` — confirm as shipped in their relay/commits before building against them).
- Accepted MINORs are listed in RC-1's CLOSE — read them before "fixing" any (e.g. `heldSettlementPaise` deliberately excluded from the change surplus).

## The shared checkout — three lanes, and the rules that were paid for in blood last night

Peers (find current names via ListAgents; message before colliding): **VD-1 vitals-desk lane** (was `hmis-63`; mid-series, owns `vitals.ts`/vitals-rules, took migration 0049, coordinates warmly) and **18a radiology lane** (was `hmis-d9`; T5 proved, T6–T9 open). Live rules, all with specimens:
- **§2.152**: staging by path is NOT enough — `git commit` commits the shared INDEX. Commit WITH a pathspec (`git commit -m … -- <paths>`) and read `git diff --cached --stat` against your Files list first. (RC-1 swept a peer's 54 staged lines despite by-path staging.)
- **§2.151 (twice amended)**: never run bare `pnpm verify` — no `maxWorkers` means 7 jest workers × ~1.2 GB OOMs this box SOLO, and `pnpm -r test` runs core jest + web vitest concurrently. Run `pnpm --filter @hmis/core exec jest -w 2 …` then `pnpm --filter @hmis/web exec vitest run`, sequentially, exit value read from files, with the box SLOT negotiated by message. A red that is hook timeouts in `setupTestDb` with ZERO assertion diffs is the RUNNER, not the tree — **on CI too** (run 33436302396's signature).
- Your test DB: pick your own base, e.g. `TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_rc2_scratch` (worker DBs auto-create+migrate); NAME it in every evidence-citing commit (§2.137). `hmis_rc_scratch` was RC-1's; `hmis_vd_scratch`/`hmis_lane_b_scratch` are the peers'.
- Long runs: the harness reaps its own background tasks on this box — use `setsid nohup sh -c '… ; echo $? > file.exit' &` (rule 18) and re-arm cheap waiters when killed.
- Migrations: journal head was `0049_vitals_bay`; MEASURE `_journal.json` immediately before and after generating (§2.138-era discipline) — do not trust this line.
- CI: `docs/superpowers/pipelines/ci-watch-host.sh <FULL 40-char SHA>` (short SHAs are rejected). RC-1's head CI verdict was still UNRESOLVED at handoff — check `main`'s current head before your first commit, reading the failure SHAPE per §2.151 before believing any red.

## Method compliance checklist for RC-2 (the LIGHT-lane shape RC-1 followed)

Author ONE phase doc (why/spike/DDs/tasks/CLOSE) → record session token balance at kickoff and each boundary (§2.141) → spike questions answered in the cheapest honest way, and **grep the WRITERS of any predicate a new state touches, not just readers (§2.149)** → code sequentially, fail-first on CRITICAL money paths, rule-21 mutants (RC-1's precedent: the race mutant was built and DIED; permission inversions may be inline mutant-shaped assertions if disclosed) → **any change that arms a dormant flag/field re-reads every consumer as if new code (§2.150)** — RC-2 arms `MEMBER_BENEFITS_ENABLED` paths, so this rule is aimed straight at you → typecheck+lint before every launch → batch verifies; manifest/permission tasks owe a full pass at their boundary → TWO fresh reviewers (pass 1 briefed at operands per §9.7 — money file first; pass 2 briefed at the FIXES with verdict-per-fix per §9.10) → CLOSE with actuals, then the token audit fires by hook. Update auto-memory (`registration-counter-build.md`) at close.

## First actions

1. `git pull --rebase` (expect peers' commits), `git log --oneline -10`, `git status --porcelain` (whose files are dirty?), `ps -eo pid,cmd | grep -E "jest|vitest"` — the protocol pre-flight (`docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md`).
2. Check CI on main's head (full SHA) — discharge or diagnose before building on it.
3. Read the RC-1 phase doc CLOSE end-to-end, then the memberships brainstorm sections, then author RC-2's phase doc and commit it (with a pathspec) before coding.
