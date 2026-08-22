# Plan 11c spike brief — two measurements and a config smoke, before anything compiles

**Written 2026-08-23 by the plan-writing session.** Run by ONE agent, from the execute session,
BEFORE Phase 0 and before any brief is compiled. The plan this serves:
[`../2026-08-23-phase1-11c-operating-modes-downtime-kit.md`](../2026-08-23-phase1-11c-operating-modes-downtime-kit.md)
— its D12 is **fork-open until question A below is answered by measurement**, and its T6 SMTP
shape depends on question B. Everything this spike builds is THROWAWAY; the deliverable is a
report, committed as `plan-11c-spike-report.md` beside this brief, and the fork resolutions
written into the plan document **in place** (§2.48: mark the losing shape dead where it stands).

**Budget: ~80k target, honest range to 200k** (11a's spike ran 197k against a 50k target and
was worth it; this one is two measurements and a smoke, not four forks). **Wall clock: the ≥30
isolated census runs dominate — expect 30-60 min of build-host time.**

## Ground rules (AGENT-RULES.md binds in full; these are the spike-specific edges)

- All evidence on the build host (`root@62.238.106.231:/opt/hmis`). Author in your own mirror
  (rule 22, per-agent suffix). **Nothing is committed to `main` by this spike.** Work on a
  throwaway branch or uncommitted tree state; leave the server tree CLEAN
  (`git status --porcelain` empty) before reporting.
- **No writes to `/opt/hmis-prod`, ever** (rule 3 — that directory is production's; this spike
  has no business there). No `hmis-prod` container is touched (rule 7). Any container you
  create belongs to a `hmis-spike` compose project or a `--name hmis-spike-*` and is REMOVED
  before you report.
- Rule 20 before every timing/flake measurement: `pgrep -af jest`, read the matched LINES, and
  say in the report whether anything else was running.
- Exit codes read from files, detached, per rules 16-18. Isolation proven from OUTPUT (rule 19).

## Question A — the L14 census restructure: does the shape kill the flake? *(resolves plan D12 / Book R2)*

**The claim to test** (plan D12): replacing the census's single
`advanceTimersByTimeAsync(25 * 60 * 60 * 1000)` (`apps/core/src/kernel/worker/scheduler.test.ts:292`)
with an explicit stepwise sequence — advance TO just past each of the five daily instants from
the pinned `2026-08-21T12:00:00.000Z` start (23:55 IST, 23:59 IST, then 00:05, 00:15, 01:15 the
next IST day), each step followed by a bounded number of tick-sized advances with settle room so
every `isDailyDue` DB round-trip resolves before the next step — makes the census
deterministic under CI-class starvation while HOLDING the assertions: `jobs()` equals the census,
the invoked SET equals the census, `leakedErrors()` empty, the `DATABASE_URL`-unset guard
untouched. The interval jobs' hour-scale cadences (`CENSUS_INTERVALS`, :223) stay as they are;
`CENSUS_DAILY_TICK_MS` stays 30 000 (:261 — lowering it was analysed and REFUSED in the 11a gate
report §7.9; do not relitigate it here).

**Do:**
1. Write the restructured census as an edit to `scheduler.test.ts` in your working tree (both
   L14 tests if the second's structure is affected; expected: only the first).
2. Run it **isolated** (rule 19's exact invocation, isolation quoted from output) **≥30 times**,
   detached, exit values to files. Report the observed rate as `greens/runs`. The shipped
   census's measured rate is ~16% red per CI run and it fails twice consecutively — your
   baseline for comparison, from the gate report §3a; do not re-measure the shipped rate.
3. Report the restructured test's RUNTIME vs the shipped census's (one timed run each is
   enough) — the §7.9 trade says the fix must not multiply the ~3 000 real DB reads; stepwise
   advancing should REDUCE ticks, and the runtime is the cheap proxy. Quote both numbers.
4. Run the FULL `scheduler.test.ts` suite once with the edit in place — the M-S2 grave test
   (:304-339) and the rest must still pass beside it.
5. Revert the working tree; confirm clean.

**Verdicts:** ≥30/30 green → D12 is RESOLVED as written; paste the measured rate and the final
test shape (verbatim diff) into the report for R0-2 to ship. Any red → report the failure's
anatomy (which instant, what was pending) and STOP — do not iterate more than one refinement
pass; a second failure means R0-2 gets re-authored by the execute session against your
measurement, with the plan's named fallback (a test-only daily-check seam on `Scheduler`) on
the table.

**One honesty note the report must carry:** the build host is not the starved CI container, so
30/30 here does not PROVE 0% on CI — it proves the shape is deterministic where the shipped
shape already flaked at ~16% per-run equivalent. Say so; the post-ship CI observation window is
the real confirmation, and the Pipeline Notes already treat any post-R0-2 census red as a
regression signal.

## Question B — is SMTP submission egress open from the box? *(shapes T6's `.env.smtp`)*

Hetzner blocks outbound port 25 by default on newer accounts; 587 (submission) is normally open
— but "normally" is a prediction, and T6 puts SMTP on the deploy's critical path. **Measure,
credential-free:**

```
timeout 10 openssl s_client -starttls smtp -connect smtp.gmail.com:587 -brief </dev/null
timeout 10 openssl s_client -connect smtp.gmail.com:465 -brief </dev/null
```

(Any large public SMTP host serves; no login is attempted, no credential exists yet.) Report,
per port: TCP connect y/n, STARTTLS/TLS established y/n. **587 open → T6 ships as written.
587 blocked but 465 open → T6's template uses implicit-TLS 465 and the report says so, plan
amended in place. Both blocked → STOP and report; the owner needs a relay decision before T6
exists** (execute-prerequisite 4 names this).

## Question C — Alertmanager boots our shape *(cheap smoke; de-risks T6's first rung)*

`prom/alertmanager:v0.27.0` under a throwaway `hmis-spike` compose project (or bare
`docker run --name hmis-spike-am`), loopback port only, with a minimal config in the PLAN's
template shape — route `severity: critical` to a receiver, but the receiver is a **file/webhook
stub, NOT email** (no credential exists; that leg is T6's drill). Then:

1. Boot; confirm it reaches `running` and `/-/ready` answers on loopback.
2. Fire one synthetic alert (`amtool alert add severity=critical alertname=SpikeProbe` inside
   the container, or `curl` the v2 API) and confirm it appears in `amtool alert query` /
   the API — route matched, alert accepted.
3. Confirm `amtool` ships in this image tag (T6's drill assumes it; if absent, say so and name
   the curl-only drill shape).
4. Tear down BY NAME; confirm gone; no volume left.

This is a smoke, not a fork: if the image tag misbehaves, T6 pins a different v0.2x tag and the
report names it. Ten minutes, not an afternoon.

## Report format

`docs/superpowers/plans/reports/plan-11c-spike-report.md`, committed (docs commit, owner's
machine or execute session — NOT from the spike agent, whose tree stays clean): per question —
what ran (commands), what was OBSERVED (quoted output, rates as fractions, runtimes), the
verdict in one sentence, and for A the verbatim final test shape. Then the execute session
edits the plan's D12 (and T6's SMTP port if B says so) **in place, marking the superseded text
dead where it stands**, before Phase 0 compiles.
