# LANE A — AUTHOR Plan 17 (Central Lab / LIMS)

**For a fresh session (Opus), on the build host, in `/opt/hmis`. Paste this file's path as the seed; read nothing else first.**

You are **authoring a phase document**, not executing one. Execution is a separate session with its own approval, exactly as Plan 17 phase 0 was. Your deliverable is the plan and its EXECUTE-PROMPT — no `apps/` code.

**A SECOND LANE (B) IS AUTHORING PLAN 18a — RADIOLOGY — IN THIS SAME CHECKOUT AT THE SAME TIME.** §4 below is not boilerplate; it is the part of this prompt most likely to cost you a day.

---

## 1. Read, in this order, before the first tool call

1. `docs/superpowers/AGENT-RULES.md` — in full (~26 KB). The binding process contract.
2. **`docs/superpowers/plans/2026-08-29-phase1-17-order-envelope.md`, LINES 297–374 ONLY** — that is `## 6 THE CONTRACT`, `### 6A WHAT THE ENVELOPE DOES NOT DO FOR YOU`, and `## 8 What this phase FREEZES`. **Do not read the whole file: it is 112,649 bytes ≈ 28k tokens, re-billed on every tool call.** Read `## 4.1` (line 145 onward, the frozen table shapes) when you need a column name. §6A is eight things the envelope deliberately does NOT do and **two of them are yours to close** — see §3.
3. `docs/superpowers/EXECUTE-METHOD-V3.md` §1, §2, §6, §9.1, §9.9 — how a phase document is shaped, how the lane is ruled, how the stop-loss is computed.
4. `docs/superpowers/brainstorms/2026-08-27-department-series/02-central-lab-lims.md` — **§1 (frame/scope), §5 (the 129-row edge catalogue), §13 (owner rulings needed), §14 (the plan sketch), §15 (open questions)**. It is 98 KB; those five sections are the argument. §2/§3/§4 when you need actors, flows or the data sketch.
5. `docs/superpowers/brainstorms/2026-08-27-department-series/00-INDEX-AND-SYNTHESIS.md` §3 — **the numbering is ruled: `17` LIMS core · `17-E` analyzer edge · `17-M` microbiology · `17-H` histopath. Do not invent a number.**
6. The ledger `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` — **§5 ONLY, which begins at line 1485 today. MEASURE IT (`grep -n '^## 5' …`) — it moved from 1323 to 1485 in one day, and a phase already paid for a stale copy of exactly this pointer.** The file is 407,657 bytes ≈ 102k tokens. **Never read it whole.** Cite entries by NUMBER: §2.54, §2.115, §2.131, §2.137, §2.138, §2.140.
7. `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` — §1, §2, §7 at minimum.

Read the shipped seam only where you must: `apps/core/src/kernel/orders/kinds.ts` (the declaration you will make), `place.ts` and `read.ts` (what you get for free), `apps/core/src/kernel/episodes/series.ts` (why `S` is not an order number).

## 2. What Plan 17 is, and what phase 0 already decided FOR you

**The envelope is built, reviewed twice, and LIVE in production (prod 46 migrations, deployed 2026-08-29).** You inherit it; you do not rebuild it and you do not edit it.

Per §6.8 of phase 0, your claim is already specified: **`lab` / `lab_order` (`L`) / `lab.orders.place`, `requiresClinician: true`, `requiresIndication: false`, `selfOrderable: false`.** That is ONE manifest field. `envelope.e2e.test.ts` already proves that exact declaration works end to end against a test-only manifest — **read it; it is a working model of your T1.**

You get for free: the order header and items, `order_no` from the existing counter, the four-state machine with its compare-and-set, `order.placed` and `order_item.*`, and the cross-kind readers. You owe: everything after the order.

**Your tables hang off `order_item_id` and NEVER add a column to `orders`/`order_items`/`order_item_transitions` (§8.1).** Specimens and their `S` numbers, accession, sample rejection and re-collection, analyzer worklists, results, verification, reference ranges, reports, amendments, the publish interlock.

**`lab_specimen` (`S`) is NOT an order number and must never be declared as your `seriesKey`.** One order yields several tubes and one tube serves several tests — `series.ts`'s own header is the reasoning. The specimen numbers itself, on your table.

## 3. The two §6A items that are YOURS, and they are the sharpest content in this prompt

- **§6A.1 — the WORKER registers no encounter resolver.** `resolveEncounterByPrefix` reads a process-local map filled only by `OpdModule.onModuleInit` and `OtModule.onModuleInit`; `worker.module.ts` has no `imports:` at all. **Your reflex rule and every standing order is a `system` actor running in the worker, and today it would get `unknown_encounter` for a visit that exists.** Your plan must rule how that is closed — the worker importing the modules that register `V` and `D`, or the map seeded another way — with the reasoning written down.
- **§6A.2 — `placeOrder` has no idempotency.** It belongs to the ROUTE, and phase 0 mounts none. A retried click at the counter mints a second `order_no`, a second set of items and a second `order.placed`; you post the charge at accession, so the patient is billed twice and two tubes are drawn. **Your plan owes the idempotency decision** (the repo has an `idempotency_keys` table used at the controller layer).

Also read §6A.3/§6A.4 (`findRecentItems` matches `service_id` and `patient_id` exactly, so it misses a duplicate inside a PROFILE and misses a pre-merge duplicate registration — profiles are your subject), §6A.5 (E3's add-on has no kernel API; if you need it, ask for the kernel function rather than writing the INSERT), and §6A.8 (the readers log no PHI access).

## 4. THE PARALLEL LANE — four shared files, and the rule for each

Lane B is authoring Plan 18a in this checkout. While you are only writing docs you cannot collide. **The moment either lane executes, these four files collide by construction, and both lanes edit all four:**

| file | why both lanes touch it | the rule |
|---|---|---|
| `apps/core/src/kernel/modules/manifests.ts` + `manifests.test.ts` | each lane appends its module manifest | **the count and the ordered key list are MEASURED, never remembered.** Whoever lands second rebases and re-reads them |
| `apps/core/scripts/seed-roles.ts` + `test/seed-roles.test.ts` | each lane declares permissions | **FIVE censuses, and a sibling-grep finds only two of them** (ledger §2.138). Grep the LIST: `grep -rn "ALL_MANIFESTS" apps/core --include=*.ts` |
| `apps/core/test/helpers/db.ts` | each lane's tables join `truncateAll` | a table absent from it is NEVER EMPTIED; a table whose parent is truncated must be in that parent's OWN statement |
| `apps/core/drizzle/` | migration numbers | **next free is `0046` as measured 2026-08-29. BOTH lanes will want it.** Protocol §7: re-check `meta/_journal.json` immediately before AND after generating, state the number you took in your commit message, and if you collide, renumber YOURS — never the one already pushed |

**And the thing that makes parallel execution actually work, which is not yet in the protocol document:** `test/helpers/db.ts` derives the worker database name from `TEST_DATABASE_URL`, so a lane takes its own databases with one env var —
`TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_lane_a_scratch" pnpm --filter @hmis/core exec jest …`.
Measured: suites failing six at a time on foreign-key violations went 154/154 on the first isolated run, and a full verify returning 105 failures at load average 18.70 returned green at 2.35 with nothing changed but the box. AGENT-RULES rule 7 sanctions it; **drop the databases in the same task, AND NAME THEM in the commit and the close** — rule 7's drop is what erases the proof the run happened, and it cost a reviewer's entire CRITICAL slot last time (ledger §2.137).

**Never `git add -A` and never `git add <directory>`** — stage by explicit path, and read `git status --porcelain` first. Files you did not write are Lane B's and are not yours to stage, revert or tidy.

## 5. What the document must contain

The shape is `2026-08-29-phase1-17-order-envelope.md` — copy its skeleton, not its content:

- **THE RULING** in one paragraph, up front.
- **THE LANE** (v3 §2: LIGHT or HEAVY, argued) and a **stop-loss** with the arithmetic shown — `1.5 × (per-task rate × task count) + one full reviewer pass per remediation cycle`, per-task rate from `pipelines/token-baselines.json`, and **budget TWO reviewer passes**: on phase 0 the second pass found a live confidentiality leak the first pass's own fix had created.
- **§2 Ground truth** — every row a COMMAND with its measured value, to be re-run at kickoff.
- **§3 Spike** — questions answered at kickoff. A spike that only confirms the plan buys insurance; phase 0's refuted two things and changed code before T1.
- **§4 Design decisions**, each DECIDED with its reasoning (owner standing rule 2026-08-28: pick the most logical Indian-corporate-hospital choice and mark it DECIDED; stop only for money, procurement or law).
- **§5 Tasks**, tiered, each CRITICAL one carrying an inline **Assertion Book** with a named mutant per row.
- **§6 THE CONTRACT** — what 17-E, 17-M, 17-H, 24a and 26 inherit from you.
- **§7 Edge-case pass** before finalising, drawn from brainstorm §5.
- **§8 What this phase FREEZES.**
- **§9 CLOSE**, empty, filled at execution.

**Then write its EXECUTE-PROMPT** as a sibling file, modelled on `2026-08-29-phase1-17-order-envelope-EXECUTE-PROMPT.md`.

## 6. Rulings to route to the owner rather than invent

Brainstorm §13 lists them. Money, procurement and law are the owner's; everything else you decide and mark DECIDED. The report-blocked-until-paid interlock (02 O-1) and the charge-after-cancellation rule (02 O-4, which phase 0 made a one-column read via `cancelled_from`) are **yours to rule**, not the owner's.

## 7. Finish

Commit the two documents by explicit path. **Do not write code. Do not deploy.** Report: the plan's task count and lane, the migration number you reserved as a MEASUREMENT, which §6A items you closed and how, and what you routed to the owner.
