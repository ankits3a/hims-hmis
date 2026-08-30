# Plan 17b (LIMS, result → report) — HANDOFF to a fresh session

**Written 2026-08-30 by the session that executed all four tasks and both close-review passes,
because it was running out of context, not out of work.** Everything below is measured or quoted;
nothing is remembered.

**Read this file first, then `../2026-08-29-phase1-17b-lims-result-to-report.md` §9 (the CLOSE — it
is filled in). You do NOT need to re-read §0–§8: the work is done.**

---

## 1. THE ONE THING THAT IS NOT FINISHED — ✅ **DISCHARGED 2026-08-30**

> **RESOLVED by the session that received this handoff.** The third full verify, launched detached
> at ~18:31 UTC, finished at 18:48 with **`.verify.exit` = `0`**: typecheck 0, lint 0 errors,
> **`apps/web` 61 files / 374 tests**, **`apps/core` 313 suites / 3 052 tests**, zero `FAIL` lines,
> on `hmis_17b_lane` across seven workers. Recorded in the phase document's **§9.5** and the gate
> report's **§2**; the scratch files were deleted. **Section 1 below is kept as written** — it is the
> record of what was and was not known at handoff time, and the procedure in it is what closed it.
> **The phase's only remaining item is §3: the owner's ruling on F45.**


**A full `pnpm verify` has never been observed green since this phase's code landed.** That is the
only open mechanical obligation. Everything else is shipped, pushed and documented.

### What IS proven, and by which run

| run | result |
|---|---|
| lab module + `test/lab.e2e.test.ts`, `-w 2`, on `hmis_17b_lane` | **23 suites / 186 tests, exit 0** |
| `pnpm --filter @hmis/web test` | **61 files / 374 tests, exit 0** |
| `pnpm typecheck` | **exit 0** |
| `pnpm lint` | **exit 0** (2 pre-existing warnings in `advance.test.ts` and `scheduler.test.ts`, not this phase's) |
| the 18 suites that failed the full run, re-run isolated at `-w 2` | **18 suites / 118 tests, exit 0** |
| **full workspace, one run** | **NEVER OBSERVED CLEAN** |

### Why the full run failed, and why it is not this phase's code

Two full runs were attempted. Both came back **exit 1**, and both times **every failing file was
one this phase never touched**:

- **Run 1** (at the T8 boundary): 3 suites. ONE was a real defect — `ist-clock-parity.test.ts`,
  because `verify.ts` is the TWELFTH IST clock and was undeclared. **Fixed and declared in
  `d2d2274`.** The other two were `patients-lifecycle.e2e.test.ts` (a 15 000 ms hook budget blown at
  load 14–19; the suite takes **9.87 s** isolated) and `fhir.test.ts` (a `SIGKILL`ed jest worker).
- **Run 2** (after pass 2's remediation): **18 suites / 71 tests**, at **load average 86 with two
  other `claude` sessions live on this host**. The failure census is unambiguous:
  **136 × `Exceeded timeout of 15000 ms for a hook`**, **8 × `deadlock detected`**, duplicate keys on
  `users_username_ux` / `roles_pkey` / `patients_pkey` (§2.137's own signature — a truncate
  interrupted mid-flight, then fixtures colliding), and a `SIGKILL`ed worker. Suite times were
  180–287 s against a normal 5–70 s. **All 18 re-ran isolated: exit 0.**

### WHAT YOU DO FIRST

A third full verify was launched detached at ~18:31 UTC and **may still be running or may have
finished** by the time you read this:

```
cat /opt/hmis/.verify.exit        # the exit VALUE — never a pipeline's status (rules 16–18)
grep -cE "^apps/core test: (PASS|FAIL)" /opt/hmis/.verify.log
grep -E "^apps/core test: (Test Suites:|Tests:)" /opt/hmis/.verify.log | tail -2
```

- **If `.verify.exit` is `0`** — record it in the phase document's **§9.5** and in the gate report's
  §2, delete `.verify.log`/`.verify.exit` with plain `rm -f`, commit, and the phase is closed.
- **If it is `1`** — read the failure census the same way (`grep -E "●" -A 3 … | grep -E "Exceeded
  timeout|SIGKILL|deadlock|duplicate key"`), check `uptime` and `ps -eo pid,args | grep "[c]laude$"`
  for other sessions, and **re-run only the failed set isolated at `-w 2`** before concluding
  anything. That is the procedure that has correctly diagnosed both previous runs.
- **If the file does not exist**, relaunch it. **Do NOT pass `-w` through `pnpm verify`** — `pnpm
  verify -- -w 4` lands the flag on `pnpm test` where `-w` is pnpm's own `--workspace-root`, not
  jest's. Launch detached with the exit value to a file (rule 18):

```
setsid nohup sh -c 'TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_17b_lane" \
  pnpm verify > /opt/hmis/.verify.log 2>&1; echo $? > /opt/hmis/.verify.exit' >/dev/null 2>&1 &
```

**Check `uptime` and the other-session count BEFORE trusting any timing** (rule 20). This host has
carried two other `claude` sessions all day, and it is the direct cause of both red runs.

> **`.verify.log` and `.verify.exit` are SCRATCH.** `rm -f` them before any `git add`, and read
> `git status --porcelain` first (AGENT-RULES §5 step 0). `docs/design/` and the two DESIGN/EXECUTE
> prompts at `docs/superpowers/plans/` are ANOTHER SESSION'S untracked trees — never stage them.

---

## 2. WHAT SHIPPED — seven commits, all pushed

| commit | what |
|---|---|
| `f32c331` | **T6** — results: entry with the absurd envelope, ranges snapshotted at entry, delta against the previous VERIFIED result, SoD verify with a CAS, criticals with read-back, the synchronous reflex, `completed` at the last signature |
| `cfba8d5` | **T7** — versioned report snapshots, the delivery interlock, print register, token-only ready notice, amendment, DD7's cancel-money rule; **the kernel edit** (`patient_lab_report_ready`) |
| `1e4e182` | **T8** — five controllers behind one error mapper, four screens, the A4 print, the OPD consult panel, `lab.e2e.test.ts` |
| `d2d2274` | **T9** — the Plan 17 gate report (both halves), `docs/runbooks/lab-go-live.md`, §9, and the twelfth-IST-clock declaration |
| `8f4e308` | close review **pass 1**'s remediation |
| `3275b11` | close review **pass 2**'s remediation |
| `66b4ccf` | the token audit — ledger **§2.145**, EXECUTE-METHOD-V3 §6's remediation factor 1.0 → 2.0, `token-baselines.json` |

**`main` has moved since**: another session pushed `7c17d41` (a project-brief export) on top.
`git pull --rebase origin main` before writing.

**Both obligations §0 handed this phase are closed and proved by execution.** F27 — the §269ST cash
refusal now leaves a `cash_threshold.blocked` row where it previously left nothing
(`deskOrderAtCounter` holds the real `Db`). F28 — `permission_denied` exists and `catalogue.ts` /
`desk.ts`'s borrowed 404/422 are repointed.

---

## 3. THE ONE DECISION THAT IS THE OWNER'S, NOT YOURS

**§9.2 F45 — DD23's grain was amended from the ORDER to the ORDER GROUP, at close review.**

Pass 1's answer to the §9 brief found the charge the old sum left out: **the reflex's own.** DD9
makes a reflex a NEW ORDER with its own credit invoice, so a TSH paid ₹300 in cash that reflexed an
unpaid FT4 read `settled` on the very order the counter was handing over — same patient, same tube,
same visit, minutes apart.

The grain is now the order group (phase 0 DD2's "one clinical act"). It **over-blocks**, which is
DD23's own stated safe direction — but **it changes a design decision the plan had already made**,
and it was taken under the owner's standing rule rather than on the plan's authority.

**It is flagged in the gate report §5 as the owner's to confirm or reverse.** If the owner reverses
it, the change is localised: `interlock.ts`'s `deliveryAllowed` (the sibling-orders lookup) and
`interlock.test.ts`'s A1 row, which asserts the group rule in as many words.

---

## 4. WHAT THE TWO CLOSE REVIEWS FOUND — the number that matters most

**Twenty-three mutants were built and twenty-three died. They found none of it.** Nor did green
narrow suites, a green e2e over every route, or `pnpm typecheck`/`lint`.

| pass | found | cost |
|---|---|---|
| **1** (fresh) | 4 CRITICAL + 9 MAJOR + 8 MINOR on the server, **5 CRITICAL** on the screens | 238,225 tokens / 63 calls |
| **2** (fresh, over the fixes) | **4 of 13 fixes condemned**, **2 NEW defects the fixing commit created** | 245,017 / 52 calls |

The four that would have hurt a patient, and the one that would have stopped the laboratory:

- a sealed patient's **legal name, UHID and DOB** returned by a sibling route with no alias rule and
  no audit row, while the reader beside it did both (§2.140's exact shape);
- a **corrected critical potassium opened no telephone call**, on the one path where the value is
  known to have been wrong;
- a rerun that corrected a cholesterol left the derived LDL computed from the number it replaced —
  a signed report reading *cholesterol 150, LDL 426*;
- two pathologists signing the last two analytes **stranded the item permanently**, with no recovery
  through any shipped route;
- **no report could be published from any screen**: the Publish button sat on a worklist row that
  vanishes at the exact moment publishing becomes legal.

**Pass 2 is why four of pass 1's thirteen fixes are not in production**, including one that made a
partial report un-amendable — so a version carrying a wrong haemoglobin would have stayed published.

---

## 5. IF THE OWNER ASKS "WHAT DID IT COST" — the audit, already written and pushed

**~857,000 main-session (a LOWER BOUND — LIGHT lane, in-session, only `/cost` can settle it)
+ 483,242 for two fresh reviewers = ~1,340,000 against a 1,570,000 stop-loss (85%).**

**The review lane cost more than the coding**: ~965,000 for two passes and two remediation rounds,
against ~645,000 for all four tasks. T7 came in at ~123k against 250k; T8 — the task §0 called
"genuinely the largest surface in either half" — at ~145k against 300k.

Ledger **§2.145** records the rate rather than the impression: across 17a and 17b, **pass 2 condemns
about a third of pass 1's fixes and the fixing commit reliably adds one or two of its own**
(17a: 3 of 5, +1; 17b: 4 of 13, +2). EXECUTE-METHOD-V3 §6's remediation factor is now **2.0**.

---

## 6. THE STATE OF THE MODULE, IN ONE PARAGRAPH

**Code-complete and NOT DEPLOYED.** Production carries no `LAB` department, no lab roles, no
catalogue and no activated definitions. The go-live steps are
`docs/runbooks/lab-go-live.md`, in order, with what proves each. **The blocker is not code:** the
hospital still has ONE full administrator, and DD11's separation of duties — the control this module
is built around — cannot be satisfied by one pair of hands. That is stated in the gate report's
opening block and in §9.9.

**The runbook's §0 is the thing that will bite a deployer**: a login holding all fifteen `lab.*`
permissions and none of the four lab ROLE KEYS reaches every route and then cannot draw blood,
because the workflow engine checks `user_roles` and never consults permissions. It was found by
`lab.e2e.test.ts` and by nothing else — 243 service-level tests were green because their fixtures
build users with real roles (§9.2 F39).

---

## 7. FINDINGS CARRIED FORWARD (the full table is gate report §5)

Closed by this phase: **F27, F28, F30, F38, F42**. Open and owned elsewhere: **F29** (the duplicate
check's missing lock — a desk phase), **F31** (`lab_specimens` has no `instance_id`), **F34** (night
mode from the IST clock rather than a per-deployment flag — 17-E), **F35** (DD7 written twice —
`sweeps.ts` is frozen), **F36** (`unpaidLineIds` carries invoice ids), **F37** (no
`resulted → cancelled` edge), **F41** (DD23's multi-invoice loop is defensive), **F43** (six realtime
names removed), **F44** (a reflex that cannot be billed has no durable record — `LAB_EVENTS` is
closed), **F45** (§3 above).

---

## 8. WHAT THIS SESSION WOULD TELL YOU IF IT COULD TELL YOU ONE THING

**Do not report the composite as a single green run.** Every suite in this repository passes, but
not in one execution, and the honest sentence is exactly that until `.verify.exit` says `0`. The
temptation at the end of a long phase is to average the evidence; the discipline is to say which run
produced which number and to name what has not been observed.
