# ⚠ SUPERSEDED — use `2026-09-01-HANDOFF-rc4-t2-t4.md` instead

**This file is stale in two ways and is kept only so the correction is visible.** It was written
before RC-4's T1 and T3 shipped, and its original text claimed RC-4 was the last phase and that its
"entire content" was deleting one of the two counters — **both wrong** (see
`2026-09-01-SCOPE-registration-counter-remainder.md`). The live handoff is
**`2026-09-01-HANDOFF-rc4-t2-t4.md`**.

---

# HANDOFF — Registration Counter series: RC-1, RC-2, RC-3 all CLOSED. RC-4 is the last phase.

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis` on the build host. Written 2026-09-01 at RC-3's close, per EXECUTE-METHOD-V3 §5A.2. **Every fact here is a POINTER — trust the pointed-at file over this summary if they ever disagree.**

---

## Mission state in one paragraph

You are the **Registration Counter lane**, building the owner-approved **Desk One** seat. **RC-1 (rails), RC-2 (benefits) and RC-3 (the seat) are all CLOSED, code-complete, NOT deployed.** `main` is at `ece4760` or later.

> **CORRECTION, made the same day this handoff was written.** An earlier version of this paragraph said RC-4 was the LAST phase and that its *"entire content"* was deleting one of the two counters, gating everything on one ruling. **Both claims were wrong.** The deletion is a decision RC-3's own D1 introduced; it appears nowhere in the series' authority, `2026-08-31-EXECUTE-PROMPT-registration-counter.md`. Measured against that prompt's four acceptance demos, **the remainder is roughly three phases, and RC-4 as re-cut is blocked by nothing.** Read **`2026-09-01-SCOPE-registration-counter-remainder.md` FIRST** — it walks the four demos, says what is built with the grep that proves it, and proposes the cut. This handoff's §3 and §4 are superseded by it. The standing prohibition holds: **no deploy anywhere in this series**; production has never left `commissioning` and code-complete + green evidence is the finish line.

## 1. Read these, in this order, before any edit

0. **`docs/superpowers/plans/2026-09-01-SCOPE-registration-counter-remainder.md`** — what is left, measured against the series' four acceptance demos, and the proposed three-phase cut. **Read this before anything else; it supersedes §3 and §4 below.**
1. **`docs/superpowers/plans/2026-09-01-phase3-rc3-the-seat.md`** — RC-3's phase doc. Read **§5 (the CLOSE)**, **§6 (the three rulings that remain)** and **§7 (the eight findings RC-3 deliberately declined)**. §7 is your inbox: it is the list RC-4 inherits, and it exists so you do not rediscover any of it by grep.
2. `docs/superpowers/EXECUTE-METHOD-V3.md` — the method. **§5A is where RC-3's lessons landed**: 5A.1 the contract pass, 5A.2 this handoff, **5A.3 the assembled-artifact assertion**, **5A.4 revert every fix**. §6's stop-loss, §9.9's verify rules.
3. `docs/superpowers/AGENT-RULES.md` — the binding contract. Then ledger **§5 only**; cite §2 entries BY NUMBER (`grep -A 30 "^### 2\.NNN"`). **Never open the whole ledger — it is 461KB / ~115k tokens and this lane has not opened it for three phases.**
4. Auto-memory `registration-counter-build.md` loads with your session.

## 2. What RC-3 shipped, and the one thing it proved

Eleven commits, `9dee2bd`..`250979b`. New screen `apps/web/src/screens/registration-counter.tsx` on route `/counter/seat`; `counter-desk.tsx` untouched and still serving `/counter`. Zero migrations.

**THE FINDING THAT MATTERS TO YOU MORE THAN ANY FEATURE.** RC-3 built **thirteen rule-21 mutants, applied each to the tree, ran each, and killed all thirteen** — over clean typecheck, clean lint and a full web suite. Two independent reviewers then returned **3 CRITICAL + 12 MAJOR, and every CRITICAL was in the ASSEMBLY**, not in any component:

- the seat handed `quote={null}` into its own quote panel, so the whole benefits contest had no consumer;
- `useQuote` held a quote with no lifetime, so **patient B was shown patient A's bill and A's PHI under B's name**;
- a hard-coded `issued={null}` printed "Collect ₹400" on an encounter already paid.

**Killing a mutant in a component proves the component.** Each of those was tested exhaustively and never once reached through the screen that mounts it — the assembly-render ratio was 2 to 14, and both of those two used the FREE branch, where the priced path is irrelevant. That is now method **§5A.3**, and RC-4 is a phase that assembles, so it applies to you directly: **drive the assembled screen through a full cycle — two patients, not one.**

## 3. THE RULINGS — and what they actually gate (SUPERSEDED by the SCOPE doc; read that first)

**Does the seat REPLACE `/counter`, or keep sitting beside it?** RC-3's D1 kept both deliberately for one phase so a proven money path and an unproven layout were never in the same diff. Which one goes is the owner's call.

**It is NOT the content of the phase and it does NOT gate authoring** — that was the error above. The SCOPE doc argues the honest moment to delete the shipped counter is when its replacement demonstrably finishes a patient (opens a visit, joins a queue, shows the PAID stamp), which is RC-4's actual work. Do that work first; the deletion is a one-line edit at the end of it.

Two consequences already taken, so the ruling costs one edit and not a migration:
- `/counter/seat` is **the only NAV row in the application with no module-manifest entry**, deliberately, so no permanent server-side declaration sits behind a screen scheduled for deletion.
- `caddyfile-parity.test.ts` is pinned at **45** and its comment already says the number returns to 44 when one route goes.

**Two more rulings are open and both are MONEY. Neither is yours to default — and both gate RC-5 (the benefits UI), not RC-4:**
1. **Is a plan-bundled coupon a BEARER instrument?** A stranger presenting it permanently spends the member's single-use coupon — `couponUnusableReason` never checks the holder and the redemption's uniqueness is `(coupon_id, cycle_no)` with no patient term.
2. **Should a fully-refunded consult put the token back to UNPAID on the board?** **Confirmed by execution: a credit note CANNOT un-settle.** `settlementState` computes `covered = credited + allocated`, so a credit note counts toward coverage and can only move a fee status settled-ward. RC-3's D4 claimed the opposite and the test asserting it checked only `via`.

## 4. What RC-4 has to do, in the order the evidence suggests

**Five of eight rails are still unwired**, and that table is in RC-3 §5.3 — **already corrected once**, because the first version said three were wired when they were not. Do not trust a rails table you have not re-measured.

| still unwired | what it needs |
|---|---|
| `couponCodes` / `attributionCode` | **The door is open and the room is empty.** `fetchFeeQuote` and both invoice bodies accept them; the only call in the tree is `reprice([])` and **no screen has a coupon or referral input at all.** This is the seat's missing money UI |
| `feeSettled` / the board flip | T3 made `queue.fee_status_changed` flip BOTH ways and **no web code subscribes to it**; `WireQueueEntryView` still carries no fee-status field. The PAID stamp does not exist on any screen |
| `counter_sequence` / `token_lane` | the flow lock, no consumer |
| `join-queue` | bill-first's deferred join; the seat opens no visit at all |

Also owed, from RC-3 §7 and its D2: the dossier renders a **raw patient UUID** (a clerk cannot verify `9f3c…` against a person); there are **no flow steps and no token** on the seat; `QuotePanel` renders only `lines[0]` while printing the whole draft's total; and **Radix portals escape the alias layer** — a shadcn `Dialog` or `Select` opened from the seat renders at `document.body`, outside `[data-seat]`, and reads the greyscale values. Decide that last one on purpose rather than discovering it.

## 5. Traps this lane has already paid for

- **§2.163 — a revert is a write.** Never clean up a mutant with `git checkout` on a file carrying uncommitted work: RC-3 did, discarded a task's route mount, and **the suite went green over a tree that had lost half the task.** Copy to scratch and copy back.
- **§2.162 / §5A.3 — run the assembly-render grep before close.** `grep -c "renderWithProviders(<${SCREEN}"` against `grep -c "renderWithProviders(<${CHILD}"`. If the second dwarfs the first, the suite is testing the parts and trusting the whole.
- **§5A.4 — revert every close-review fix and confirm it goes red.** RC-3 ran twelve pairs and **two condemned the test rather than the code.**
- **§2.164 — an app-booting e2e imports EVERY module.** A peer lane's compile error, or a migration that throws, makes `test/*.e2e.test.ts` unrunnable **repo-wide**. `tsc` is blind to the migration case. Attribute with `tsc 2>&1 | grep -E "^src/modules/(your|dirs)/"` returning EMPTY rather than assuming.
- **§2.152 and its amendment** — a pathspec commits the WORKING TREE, so it captures a peer's uncommitted edits to any path you name. `git status` before every commit, and ask the peer.
- **Locale files are the guaranteed collision point.** `apps/web/src/locales/{en,hi}.json` (NOT `src/i18n/`), pinned key-for-key by `lib/i18n.test.ts`. Announce a single top-level namespace; RC-3 used `registrationCounter`, VD-2 uses `vitalsBay`. A key-parity check is pure set arithmetic over two JSON files and needs **no test runner and no box slot**.
- **Four declarations of one patient-search shape.** `patient-picker.tsx:17`, `registration-desk.tsx:16`, `merge-review.tsx:8` each declare a private identical `SearchHit` missing `matchedOn`; RC-3 added `WirePatientHit` in `lib/patients-api.ts` as a deliberate fourth. **"Hoist `SearchHit` into contracts" cannot be done literally — the name is taken by an unrelated concept** (`packages/contracts/src/search.ts:58`, the command palette's cross-entity hit). The migration target is `WirePatientHit` and the three copies must be RENAMED.
- **Inherited CRITICAL (Plan 09), still nobody's:** nothing in shipped code ever creates an `entitlement_counters` row, so a `kind='package'` plan with no counter prices as **unlimited free consults for ever**.

## 6. Verify economy

Test DB `hmis_rc3_scratch` (or mint `hmis_rc4_scratch`). **Never a bare `pnpm verify`** — `pnpm --filter @hmis/core exec jest -w 2 …` then `pnpm --filter @hmis/web exec vitest run`, sequentially, box slot by message (§2.151; `maxWorkers: 2` is in `apps/core/jest.config.cjs` by owner ruling). Web `vitest` needs no database and no slot negotiation — it is in-process and takes ~30s for all 68 files. `pnpm typecheck` AND `eslint` before every launch: **vitest strips types, so a green web suite can sit over code that does not compile.**

## 7. Cost, for your stop-loss

RC-3: ~1,007,000 of a 1,250,000 stop-loss (81%) — ~588k main-session across two sessions plus **419,272 for two fresh close reviewers**. Coding came in 26% under; **the review lane came in 6% over, and that is the first time this series priced it nearly right** because the term was set from RC-2's measured actuals rather than a multiplier on a guess. **Zero recon subagents, third phase running.**

**Set RC-4's stop-loss from the PER-TASK rate × your task count, never from RC-3's total** (§2.95). And **the review term is not a place to save**: on RC-3 it found 3 CRITICAL over thirteen dead mutants and a full green suite.

## 8. First actions

1. `git pull --rebase`, `git log --oneline -12`, `git status --porcelain` (**whose files are dirty?**), `ps -eo pid,cmd | grep -E "[j]est|[v]itest"` (**it must match `processChild` workers, not only supervisors**), `uptime`.
2. `ListAgents`, and **message the peers before touching anything shared** — three lanes have shared this checkout all day and two of RC-3's real defects were found by another lane's instrument, never by its own.
3. Re-measure the §5.3 rails table before believing it.
4. **Read the SCOPE doc and get the CUT agreed.** No ruling blocks RC-4's own work.
