# HANDOFF — Registration Counter series: RC-2 CLOSED, RC-3 at T4 of 5

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis` on the build host. Written 2026-09-01 by the RC-3 session at its context limit. **Every fact here is a POINTER — trust the pointed-at file over this summary if they ever disagree.**

---

## Mission state in one paragraph

You are the **Registration Counter lane** of the agentic hospital OS, building the owner-approved **Desk One** seat in four phases. **RC-1 (rails) and RC-2 (benefits) are both CLOSED, code-complete, NOT deployed.** You are mid-**RC-3 (the seat)**: **T1, T2 and T3 are done and pushed; T4 and T5 remain.** The standing prohibition holds — **no deploy anywhere in this series**; production has never left `commissioning`. Code-complete + green evidence is the finish line. `main` is at `03fd081`, in sync, and green.

## Read these, in this order, before any edit

1. **`docs/superpowers/plans/2026-09-01-phase3-rc3-the-seat.md`** — YOUR phase doc. §1 (why this is a wiring phase), §2 (spike, already answered), §3 (design decisions D1–D7), §4 (tasks — **T4 and T5 are yours**), **§6 (two owner rulings still needed)**.
2. `docs/superpowers/plans/2026-09-01-phase2-rc2-benefits-at-counter.md` — RC-2's CLOSE. What shipped, what both review passes found, the three carried findings.
3. `docs/superpowers/EXECUTE-METHOD-V3.md` — the method. §6's stop-loss (amended 2026-09-01), §9.9's verify rules.
4. `docs/superpowers/AGENT-RULES.md` — the binding contract. Then ledger **§5 only**; cite §2 entries BY NUMBER (`grep -A 30 "^### 2\.NNN"`), never open the whole file — it is 448KB and reading it is the waste it documents.
5. Auto-memory `registration-counter-build.md` loads with your session.

## What RC-3 has done (T1–T3, all pushed)

| | |
|---|---|
| `8c23b60` | Phase doc. **The finding that shaped it: RC-1 and RC-2 shipped EIGHT rails with ZERO web consumers.** `matchedOn` is not declared in any web type at all. So RC-3 is *wire eight rails*, not *build a seat* — and almost everything is a FIRST CONSUMER, which is when a rail's assumptions get tested for the first time. |
| `9dee2bd` | **T1** — `QuotePanel` renders the CONTEST: winner applied, losers greyed with reason, never summed. Payer-ineligible shows as absent-with-a-note (RC-2 T3 emits no candidate; drawing one would claim a contest that never ran). Also aligned the quote's silent truncation with the invoice's hard cap. |
| `4a58f45` | **T2** — `Dossier` over `usePatientInHand` (a rendering, never a second store), and DD2's three lawful exits lifted verbatim from `counter-desk.tsx`. |
| `03fd081` | **T3 — M3 DISCHARGED.** `queue.fee_settled` → `queue.fee_status_changed`, `status` widened to all four `EncounterFeeStatus` values, `via` widened, and the three missing call sites added (`reverseAllocation`, `markEnteredInError`, `issueCreditNote`). The board now flips BOTH ways. |

**Evidence at T3:** fee-status 11/11; money-path batch `billing`+`opd`+`membership`+`partners` **97 suites / 920 tests, exit 0** on `hmis_rc3_scratch`; typecheck 0; lint clean in RC-3's files.

## YOUR TASKS — T4 and T5

Read §4 of the phase doc for the full text. In brief:

- **T4 — ROUTINE · search-first find with match reasons, and the wait model.** `matchedOn` exists server-side at `patients/search.ts:25` and **is not declared in any web wire type** — declare it in `apps/web/src/lib/patients-api.ts`, render as REASONS never a score (owner's design ruling: "same mobile", never a percentage). Wait v0 = `waitingCount × avgConsultMinutes` rendered `~N min · H:MM`; **MEASURE first whether `avgConsultMinutes` is already exposed on `queues/summary`** — RC-1 D7 put the column there but the web does not read it.
- **T5 — ROUTINE · the alias layer, the keyboard map, the queues overlay.** D3: a `[data-seat="registration-counter"]` block mapping Desk One's paper-and-pine onto the shipped shadcn variables, **scoped to the seat's root, not global** — that is the owner's ALIAS-LAYER ruling made mechanical. Tokens measured from the design: `--paper:#f4f7f4 --card:#ffffff --ink:#132420 --line:#dfe7e1 --dim:#5c6f66 --faint:#8ea69a --wash:#eef3ef --green:#0e6b4e --gold:#dd8f1c --red:#b23a30`. Keyboard: Ctrl+K · Ctrl+N · Q · 1/2/3 tender · Ctrl+⏎ · Esc. **Mutant: the tokens declared globally; kill: a shadcn screen turning green.**

Then **CLOSE**, then the token-audit hook fires, then update auto-memory.

## OWNER RULINGS OUTSTANDING — surface, do not default

1. **Is a plan-bundled coupon a BEARER instrument?** RC-2's pass 2 found that a coupon with a `planId`, presented by a stranger, resolves with `instanceId: null` and **permanently spends the member's single-use coupon** — `couponUnusableReason` never checks the bundled coupon is held by the bill's patient, and the redemption's uniqueness is `(coupon_id, cycle_no)` with no patient term. A leaflet should be bearer; a coupon bundled with a paid membership probably should not. **This is money. Not yours to default.**
2. **Does the seat replace `/counter` or sit beside it?** D1 deliberately keeps both for one phase. RC-4 deletes one — which.

## Carries with named owners

- **`lab/lab-desk.controller.ts:183` is an instrument oracle** — same shape RC-2 MAJOR 4 closed on billing's preview: no `@CurrentActor()`, `patientId` a required body field, so `lines[].candidates` leaks membership status, plan tier and literal coupon codes for any patient, outside `visiblePatientIds`. Pre-existing (Plan 17's route), latent while `MEMBER_BENEFITS_ENABLED` is off. **Not a drive-by fix in a UI phase.**
- **`MEMBER_BENEFITS_ENABLED` arms HOSPITAL-WIDE, not counter-wide.** `lab-desk.controller.ts:183` and `ot/bill.ts` both pass `patientId` and so resolve instruments. Whoever flips that `.env` should know. RC-2 arms it in tests only.
- **CRITICAL (inherited, Plan 09): nothing in shipped code ever creates an `entitlement_counters` row.** A `kind='package'` plan with no counter prices as **unlimited free consults, forever**, with an empty `entitlement_movements` to show for it. RC-2 T5 proved the READER half against hand-inserted rows. The granting step has no owner in any plan — Plan 22's, and it needs one.
- **`issueInvoice` never checks `encounter.patientId === input.patientId`** (RC-2 review MAJOR 6).
- **§2.154's open question** — RC-1 T3's join-queue race mutant died on an *unwarmed* connection pool, where a right kill and a lucky interleaving are indistinguishable. Warm and re-run before trusting that guard.

## The shared checkout — three lanes, and what today cost

Peers (find current names via `ListAgents`; **message before colliding — both are responsive and both caught real defects of mine today**): **`hmis-63`** (VD-1 vitals-desk, code-complete T1–T5) and **`hmis-d9`** (18a radiology, all nine tasks done, running its close review). Live rules:

- **§2.152 AND ITS AMENDMENT: a pathspec protects against a dirty INDEX, not against a peer's dirty WORKING TREE.** `git commit -- <path>` commits the working-tree state of that path, so it captures a peer's uncommitted edits to a file you name. Neither a stat nor `--cached --stat` can see it. **This happened to me today** — a peer's pathspec commit captured this lane's uncommitted census edits and left `main` red in a split state. Check `git status` for the paths you are about to commit, and **ask the peer**.
- **§2.151**: never bare `pnpm verify`. `pnpm --filter @hmis/core exec jest -w 2 …` then `pnpm --filter @hmis/web exec vitest run`, sequentially, box slot by message. **`maxWorkers: 2` is now in `apps/core/jest.config.cjs`** (owner ruling, `42e7efc`) — and it was later EXONERATED of a red that reproduced at `-w 7` too, so do not suspect it first.
- **Your test DB: `hmis_rc3_scratch`.** Name it in every evidence-citing commit (§2.137). Peers use `hmis_vd_scratch` / `hmis_18a_*`.
- **Long runs: `setsid nohup sh -c '… ; echo $? > FILE.exit' &`** — the harness reaps its own waiters, not the detached run. **USE A TIMESTAMPED PATH.** A stale `.exit` from seven hours earlier satisfied my `until [ -f ]` guard today and I read an ancient exit code as this run's.
- **Migration journal head: `0050_form_f_completion`, 51 entries.** MEASURE before and after generating; do not trust this line.

## The lesson this session paid the most for

**Five instrument-blindnesses in one day, all the same bug.** `pkill -f "jest.js…"` and `ps | grep "jest.js"` are both blind to `processChild` workers — so I killed a supervisor, counted supervisors, declared the box clean, and left orphans truncating a database under a live batch. `grep -E "^\+"` is blind to a diff's `+` column — so I certified that a sweep had not happened when it had. A peer's `pgrep -c -f jest-worker` counted its own shell and parked a job for seven and a half hours. A stale `.exit` file satisfied a guard. **Before trusting a check, ask what it would report if the thing you are looking for were present. If the answer is "the same", it is not a check.** Ledger §2.158 has the calendar-bomb variant of this.

**And the cheapest instrument of the day, from the 18a lane: read the phase's CONTRACT clause by clause against the shipped code.** It found two defects in their phase that 343 green tests and thirty dead mutants had missed, and it found a clause I had written into my own T1 and simply not done — within ten minutes of my adopting it. Their diagnosis of why tests miss such things is the keeper: **every assertion that touched them checked a state where the right and wrong behaviours agree.** Do this before every CLOSE.

## Method compliance for T4/T5

Record the session token balance at kickoff and each task boundary (§2.141) → grep the WRITERS of any predicate a new state touches, not just readers (§2.149) → rule-21 mutants, inline and disclosed is fine → typecheck AND lint before every launch (**vitest strips types, so a green web suite can sit over code that does not compile — both gates, every time**) → **new i18n strings need BOTH `en.json` and `hi.json`; `i18n.test.ts:12` pins them key-for-key** → tree frozen during any launched run, and **never widen a batch into a directory another lane is working in** → TWO fresh review passes at close (**they found 2 CRITICAL + 6 MAJOR on RC-2 over a tree with 3337 green tests, three died mutants and clean typecheck/lint — and 3 of 7 fixes came back INCOMPLETE**) → CLOSE with actuals → token audit fires by hook → update auto-memory.

**Stop-loss: 1,250,000** (phase doc header has the derivation). RC-3 has spent roughly **250k of main session through T3**, plus **0 subagent tokens** — recon ran inline, as RC-2's audit prescribed (§2.156). The 510,000 review term is UNSPENT and the two passes are NOT yet run; on RC-2 they found 2 CRITICAL + 6 MAJOR over an already-green tree, so **report RC-3's cost as `spent / (stop-loss − review term)` until they have run** (§2.157) rather than as a flattering fraction of the whole.

> **NOTE ON THE TOKEN-AUDIT HOOK.** It fires on any pushed phase-doc-shaped file and it fired on THIS handoff. **No baselines row was appended, deliberately: RC-3 has not closed.** A row for an incomplete phase would make `token-baselines.json` — the file whose entire job is to make the next audit a comparison rather than an anecdote — carry a number that is not comparable to anything. Append RC-3's row at its real CLOSE, with the review lane's actual cost in it. The script itself was run (it is free) and reports what it should for a LIGHT phase: no transcripts, because the cost is main-session.

## First actions

1. `git pull --rebase`, `git log --oneline -10`, `git status --porcelain` (**whose files are dirty?**), `ps -eo pid,cmd | grep -E "jest|vitest"`, `uptime`.
2. Read the phase doc §4's T4 entry, then MEASURE whether `avgConsultMinutes` is exposed on `queues/summary` before writing anything.
3. Message the peers to find out who holds the box.
