# Prompt — brainstorm and plan the next phase after Plan 11c (NO EXECUTION)

> **For a fresh session, on Fable.** Written 2026-08-23 by the session that compiled, ran and
> deployed Plan 11c. Your job is to **decide what is next and write its plan**. You do not execute
> it — a different session does, and that separation has now paid four times. The plan you write
> gets its own spike brief and execute prompt, as 11c did.

---

## Read these first, in this order

| # | file | why |
|---|---|---|
| 1 | `docs/superpowers/plans/reports/plan-11c-gate-report.md` **including ALL THREE addenda** | the state you are building on, and the four MAJORs you must decide about. Read it cold and do not skim the addenda — the body says "NOT LIVE" and the addenda say it is |
| 2 | `docs/superpowers/plans/reports/plan-11c-findings-inbox.md` | routed-forward findings from the pipeline, including **one open ask of the plan owner** (T1's D2/D3 disagreement about how much of the commissioning exit is gated) |
| 3 | `docs/superpowers/plans/2026-08-11-phase1-plan-series.md` | the roadmap; Plan 09's slot is RULED, 12a's gate is described |
| 4 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` §2.46-§2.80 and §3 | the ledger. §2.75, §2.77, §2.78, §2.79 and §2.80 were all earned or re-earned in the last two plans |
| 5 | `docs/superpowers/AGENT-RULES.md` + `docs/superpowers/EXECUTE-METHOD.md` | the contract and the method you are writing a plan FOR |

## Where things stand, measured

**Production is LIVE and now has an alert path that reaches a human.** `hmis-prod`, **9 services**
on `https://hmis.crkmch.com`, WAL archiving to R2, nightly full + weekly restore drill (passing —
the drill-age metric reads ~10 h). Plan 11c deployed 2026-08-23: operating modes, the D-17
validation aggregate, interface heartbeats as the tenth job, the downtime kit, the web surfaces,
Alertmanager → the owner's inbox. **Flag ⑤ discharged in full**: a synthetic `severity: critical`
alert was delivered by Alertmanager and the owner confirmed inbox receipt.

`pnpm verify` at HEAD: `apps/core` **144 suites / 1049 tests** · `apps/web` **34 / 173** ·
`packages/contracts` **3 / 7**, exit 0. Next migration is **`0018`** (latest `0017_windy_red_shift`).

**The escrow ceremony is DONE** (2026-08-23) — `SECRET_KEY`, the pgBackRest cipher passphrase, the
R2 values and the SMTP credential are in an AES-256-CBC bundle under an owner-typed passphrase, on
the box and fetched off it, hashes matched. The owner still owes a **second off-machine copy** and a
**decrypt-verify confirmation**; that is not a plan, it is a reminder to deliver.

## The actual question, and it is genuinely open

**Four MAJOR defects from 11c are unfixed, and the roadmap says Plan 09 is next. Those cannot both
be right, and choosing between them IS this session's job.** Argue it; do not assume.

**The four 11c MAJORs, three of them measured with executed evidence:**

1. **The mode ledger takes no lock.** Two concurrent declarations both win — measured **14/15** and
   **15/15**. A duty manager who declares `downtime` can get a 201 while the banner the whole
   hospital reads says `degraded`. A double-click on the mode desk is enough. Fix named in the
   report (`pg_advisory_xact_lock`; a `FOR UPDATE` will not do, because the zero-row commissioning
   case is exactly the one that must serialise).
2. **`ops.interface.manage` is bound to its routes by nothing a test can see** — mutant **SURVIVED**
   beside a control that **DIED**. §3.42's shape, applied to two of three permissions and not the
   third.
3. **Nothing watches the alert path itself.** Alertmanager is not a scrape target; no rule touches
   `alertmanager_notifications_failed_total` or `prometheus_notifications_errors_total`. **This one
   got worse when 11c shipped, not better** — the path is live now, so its silent failure modes are
   live too. A rotated app password or a bouncing mailbox is indistinguishable from a quiet night.
4. ~~Nothing can grant the `ops.*` permissions~~ — **CLOSED** by `90c0e6c` (`seed:ops`).

**Plus two live-system findings from the deploy itself:** §2.77's third specimen (postgres-exporter
was omitted from the restart loop and D11's watcher was inert after a clean deploy — fixed in
`ea4da87`), and the fact that `admin` currently holds duty-manager, kit and owner authority at once
because it is the only user, which is fine for UAT and **is not the go-live shape**.

**The candidates, and each has a real case:**

- **A hardening plan (call it 11d)** — the three MAJORs plus MINOR 5 (the heartbeat/sweep race,
  measured 14/15, dormant today and **armed by 11b** when real printers land). Small, mutant-shaped,
  and it closes defects in code that is now serving a hospital.
- **Plan 09** — the roadmap's ruled next slot. Owner ruled 2026-08-23: **no live memberships in the
  pilot**, which is precisely the argument for asking whether it should be next at all.
- **Plan 12a** — its mode gate now has its seam (`getOperatingMode`). Still gated on the DPIA and
  the inference-locus decision, which are owner lead-time items, not pipeline work.
- **Go-live readiness itself** — staff accounts and the separation of duties that makes D2 real,
  the WhatsApp BSP clock, the counsel bundle. Much of this is owner action with weeks of lead time
  and **no pipeline can produce it**; say so plainly rather than inventing tasks around it.

## Things that are true and will bite you if you assume otherwise

- **The L14 census flake is NOT confirmed fixed, and the file has a live open question.** `7e38b28`
  replaced a fixed settle count with a wait-on-condition. Since then: **five green CI runs and one
  failure** — and the failure (`e31538b`) was **not** the old set-mismatch (grepped: zero
  `Expected -2`, zero `runNotifyPump`) but a **15 s jest timeout** on a starved container that took
  **101.98 s** for an 11 s suite, with four unrelated `setupTestDb()` hook timeouts beside it.
  §2.80's bar is several consecutive greens across commits touching unrelated files, and **the
  honest verdict is "not yet confirmed", not "fixed"**. The build host reproduces the failure in
  **no** shape. If you see a census red, read §2.80 and §3a before you re-run anything.

  **The open question, and it is a genuine one for a hardening plan to answer.** That run exposed a
  defect in the fix itself, corrected in `3104041`: `settleUntil`'s bound was 20 000 turns (~20 s)
  against `jest.config.cjs`'s `testTimeout: 15000`, so it could only ever be reached by blowing the
  test timeout first — defeating the helper's whole purpose, which is to RETURN on a bound hit so
  the set assertion fails **naming the missing jobs** instead of reporting a bare timeout. The bound
  is now 5 000 turns (~5 s), leaving ~10 s for the walk. **What remains unanswered:** on a container
  so starved that the WALK alone exceeds 15 s, nothing in this test can produce a clean failure —
  the timeout is then a fact about the harness, not the census. Whether that is acceptable, or
  whether this test needs its own longer `testTimeout`, or whether the census should stop driving
  real database round-trips under fake timers at all, is a real design question. **`scheduler.test.ts`
  has now produced SEVEN ledger entries** (§2.57, §2.60, §2.64, twice in 11a's §7.9/§3a, and §2.78
  and §2.80 here). A file that keeps earning entries is telling you something about its design, not
  about the sessions that touch it.
- **The repo is PUBLIC.** No secret, SMTP host or owner email in any commit, ever (GC2).
- **`RETENTION_ENABLED` is still false** and retention semantics are still frozen pending counsel.
- **Rules 3 and 7 as amended** govern every path and container decision; production shares the build
  host under the `hmis-prod` project and `hmis-db-1` is the dev database.
- **The deploy is authorized only when the owner names it.** A safety classifier and the owner's own
  `Bash(docker compose -f docker/prod/*)` deny rule both gate it; 11c's T6 was blocked twice before
  the owner authorized it in as many words.
- **One open ask of the plan owner sits in the findings inbox** — T1's D2/D3 disagreement about how
  much of the commissioning exit is gated. Resolve it in conversation and record the ruling.

## What I want out of the session

1. **A recommendation with an argument**, not a menu. Say what is next and why, and say what you are
   deliberately NOT doing and what its trigger condition is.
2. **The plan document**, in the house shape: owner rulings encoded · numbered design decisions ·
   consumed surfaces transcribed from source **at a named SHA** · global constraints · a locked File
   Structure · per-task risk tiers · an Assertion Book whose every row names its killing mutant and
   its discriminating input · verify-by-execution flags · Pipeline Notes with a token budget derived
   from the Book's own row count (§2.68) · a self-review section that says what your own passes
   caught.
3. **A spike brief** for anything the plan asserts that nobody has executed — and be honest about
   what is a prediction. 11c's spike cost 172k and closed a fork, measured a blocked port nobody
   expected, and found two Alertmanager facts that would have cost a rung each.
4. **An execute prompt** for the session that runs it.
5. **Ask me before you decide anything you would have to guess at.** I am available in this
   conversation.

## Boundaries

- **NO EXECUTION.** Write documents. Touch no file under `apps/`, `packages/` or `docker/`.
- **Do not edit the roadmap** — the plan you write is not yet shipped, and a plan must not silently
  edit the document it was born from. Note what should change and let the executing session's gate
  report land it (that is how 11c fixed the stale Plan 07 and Plan 08 status lines).
- Commit your documents in **one** docs commit on `main`. `git pull --rebase` first — other sessions
  land commits while you work.
- The writer of a plan does not execute it. Say so at the top of what you write.
