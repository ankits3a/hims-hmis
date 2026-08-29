# LANE B — AUTHOR Plan 18a (Radiology & Imaging, core)

**For a fresh session (Opus), on the build host, in `/opt/hmis`. Paste this file's path as the seed; read nothing else first.**

You are **authoring a phase document**, not executing one. Execution is a separate session with its own approval, exactly as Plan 17 phase 0 was. Your deliverable is the plan and its EXECUTE-PROMPT — no `apps/` code.

**A SECOND LANE (A) IS AUTHORING PLAN 17 — LIMS — IN THIS SAME CHECKOUT AT THE SAME TIME.** §4 below is not boilerplate; it is the part of this prompt most likely to cost you a day.

---

## 1. Read, in this order, before the first tool call

1. `docs/superpowers/AGENT-RULES.md` — in full (~26 KB). The binding process contract.
2. **`docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md`, LINES 297–374 ONLY** — that is `## 6 THE CONTRACT`, `### 6A WHAT THE ENVELOPE DOES NOT DO FOR YOU`, and `## 8 What this phase FREEZES`. **Do not read the whole file: it is 112,649 bytes ≈ 28k tokens, re-billed on every tool call.** Read `## 4.1` (line 145 onward, the frozen table shapes) when you need a column name.
3. `docs/superpowers/EXECUTE-METHOD-V3.md` §1, §2, §6, §9.1, §9.9.
4. `docs/superpowers/brainstorms/2026-08-27-department-series/01-radiology-imaging.md` — **§1 (frame/scope — its row 2 is the sentence phase 0 was written to satisfy), §5 (the 138-row edge catalogue), §13 (owner rulings), §14 (the plan sketch, whose gate reads "17's order envelope shipped"), §15.1 (the question phase 0 answered)**. It is 93 KB; those are the argument.
5. `docs/superpowers/brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md` §3 — **the split is ruled: `18a` core imaging · `18b` PACS · `18c` dose/RT. You are 18a. Do not invent a number and do not absorb 18b/18c.**
6. The ledger `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` — **§5 ONLY, which begins at line 1485 today. MEASURE IT (`grep -n '^## 5' …`) — it moved from 1323 to 1485 in one day, and a phase already paid for a stale copy of exactly this pointer.** The file is 407,657 bytes ≈ 102k tokens. **Never read it whole.** Cite by NUMBER: §2.54, §2.115, §2.131, §2.137, §2.138, §2.140.
7. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` — §1, §2, §7 at minimum.

Read the shipped seam only where you must: `apps/core/src/kernel/orders/kinds.ts`, `place.ts`, `read.ts`, and `apps/core/src/kernel/orders/envelope.e2e.test.ts` — **that last one is a working model of your T1**, a test-only manifest claiming a kind and driving an order to close.

## 2. What 18a is, and what phase 0 already decided FOR you

**Your gate is discharged.** Brainstorm §14 makes 18a conditional on *"17's order envelope shipped"*; it shipped, was reviewed twice, and is **live in production** (prod 46 migrations, deployed 2026-08-29) with zero consumers waiting for a first claimant.

Per §6.8 of phase 0, your claim is already specified: **`imaging` / `radiology_order` (`R`) / `radiology.orders.place`, `requiresIndication: true`.** That is ONE manifest field, and `requiresIndication` exists in the envelope *because of you* — `placeOrder` refuses an imaging order with no clinical justification, which is the radiation-justification gate expressed as a declaration rather than a guard you have to write.

You get for free: the order header and items, `order_no` from the existing `R` counter, the four-state machine with its compare-and-set and its audit log, `order.placed{kind:'imaging'}` to start your worklist, and the cross-kind readers.

**Your tables hang off `order_item_id` and NEVER add a column to the envelope (§8.1).** Study scheduling, modality/device resources, the safety gates and screenings, contrast, Form F links, acquisition, reporting.

**Two things phase 0 rules that will shape your design more than anything else:**
- **`restricted` is already on the item** (DD11) and the kernel reader honours it — the PCPNDT-class USG is a flag you SET, not a filter you build. Your extension may be stricter, never looser.
- **The envelope does not check encounter STATUS.** Whether a scan may follow a completed OPD visit is YOUR guard, not the kernel's; the kernel refuses only `unknown_encounter`.

## 3. The §6A items that bear on you

- **§6A.2 — `placeOrder` has no idempotency.** It belongs to the ROUTE and phase 0 mounts none. A retried click mints a second order; you post the charge at acquisition (01 §1: `charge.posted` from `study.acquired`), so it is a double charge and a second appointment slot. **Your plan owes the decision.**
- **§6A.5 — E3's add-on has no kernel API.** "Add a view to an existing open study request" is a normal radiology act. There is no `addOrderItem`; the first module to need it must not write the INSERT itself (it is the one write with no compare-and-set, no trigger and no guard, and it can deadlock against the header close — §6A.7). **Ask for the kernel function in your plan.**
- **§6A.8 — the readers log no PHI access.** This repo logs at the READER (`opd/history.ts`, `opd/vitals.ts`, `opd/prescriptions.ts` all call `recordPhiAccess`). A worklist is a PHI surface.
- **§6A.1** (no encounter resolver in the worker) bites you only if you place orders from a `system` actor; if you do, it is yours too.

## 4. THE PARALLEL LANE — four shared files, and the rule for each

Lane A is authoring Plan 17 in this checkout. While you are only writing docs you cannot collide. **The moment either lane executes, these four files collide by construction, and both lanes edit all four:**

| file | why both lanes touch it | the rule |
|---|---|---|
| `apps/core/src/kernel/modules/manifests.ts` + `manifests.test.ts` | each lane appends its module manifest | **the count and the ordered key list are MEASURED, never remembered.** Whoever lands second rebases and re-reads them |
| `apps/core/scripts/seed-roles.ts` + `test/seed-roles.test.ts` | each lane declares permissions | **FIVE censuses, and a sibling-grep finds only two of them** (ledger §2.138). Grep the LIST: `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts` |
| `apps/core/test/helpers/db.ts` | each lane's tables join `truncateAll` | a table absent from it is NEVER EMPTIED; a table whose parent is truncated must be in that parent's OWN statement |
| `apps/core/drizzle/` | migration numbers | **next free is `0046` as measured 2026-08-29. BOTH lanes will want it.** Protocol §7: re-check `meta/_journal.json` immediately before AND after generating, state the number you took in your commit message, and if you collide, renumber YOURS — never the one already pushed |

**And the thing that makes parallel execution actually work, which is not yet in the protocol document:** `test/helpers/db.ts` derives the worker database name from `TEST_DATABASE_URL`, so a lane takes its own databases with one env var —
`TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_b_scratch" pnpm --filter @hmis/core exec jest …`.
Measured: suites failing six at a time on foreign-key violations went 154/154 on the first isolated run, and a full verify returning 105 failures at load average 18.70 returned green at 2.35 with nothing changed but the box. AGENT-RULES rule 7 sanctions it; **drop the databases in the same task, AND NAME THEM in the commit and the close** — rule 7's drop is what erases the proof the run happened, and it cost a reviewer's entire CRITICAL slot last time (ledger §2.137).

**Never `git add -A` and never `git add <directory>`** — stage by explicit path, and read `git status --porcelain` first. Files you did not write are Lane A's and are not yours to stage, revert or tidy.

## 5. What the document must contain

The shape is `2026-08-29-phase1-17-order-envelope.md` — copy its skeleton, not its content:

- **THE RULING** in one paragraph, up front.
- **THE LANE** (v3 §2, argued) and a **stop-loss** with the arithmetic shown — `1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`, per-task rate from `pipelines/token-baselines.json`, and **budget TWO reviewer passes**: on phase 0 the second pass found a live confidentiality leak the first pass's own fix had created.
- **§2 Ground truth** — every row a COMMAND with its measured value, re-run at kickoff.
- **§3 Spike** — answered at kickoff. Phase 0's refuted two things and changed code before T1.
- **§4 Design decisions**, each DECIDED with its reasoning (owner standing rule 2026-08-28: most logical Indian-corporate-hospital choice, marked DECIDED; stop only for money, procurement or law). **Assume standard certificates and machinery exist.**
- **§5 Tasks**, tiered, each CRITICAL one carrying an inline **Assertion Book** with a named mutant per row.
- **§6 THE CONTRACT** — what 18b (PACS), 18c (dose/RT), 63 (cath lab) and 64 (RT) inherit from you. **Say explicitly what you are NOT building**, so 18b does not find a half-PACS.
- **§7 Edge-case pass** before finalising, drawn from brainstorm §5 — the 02:00 obstetric scan that must not be blocked by PCPNDT structure is the one the brainstorm names as decisive.
- **§8 What this phase FREEZES.**
- **§9 CLOSE**, empty, filled at execution.

**Then write its EXECUTE-PROMPT** as a sibling file, modelled on `2026-08-29-phase1-17-order-envelope-EXECUTE-PROMPT.md`.

## 6. Rulings to route to the owner rather than invent

Brainstorm §13 lists them. **PCPNDT is law and its structural obligations are the owner's to confirm, not yours to design around** — but *how* the structure is expressed in tables is yours. Modality hardware and PACS storage are money and procurement: route them. Everything else you decide and mark DECIDED.

## 7. Finish

Commit the two documents by explicit path. **Do not write code. Do not deploy.** Report: the plan's task count and lane, the migration number you reserved as a MEASUREMENT, which §6A items you closed and how, what you left to 18b/18c in as many words, and what you routed to the owner.
