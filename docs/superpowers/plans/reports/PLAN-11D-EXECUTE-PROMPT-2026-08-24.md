# Prompt — execute Plan 11d (spike → Phase 0 → compile → run → verify → the authorized deploy)

> **For a fresh session.** Written 2026-08-24 by the session that brainstormed and wrote Plan 11d.
> **The writer of a plan does not execute it**, and that separation has now paid four times: it
> caught a self-contradictory TRUNCATE claim, a forward reference, a files-array drift, and a
> census fix reported on one green run. You are the reader who has not already convinced themselves.

**The plan:**
[`../2026-08-24-phase1-11d-operability-hardening.md`](../2026-08-24-phase1-11d-operability-hardening.md) ·
**spike brief:** [`PLAN-11D-SPIKE-BRIEF-2026-08-24.md`](PLAN-11D-SPIKE-BRIEF-2026-08-24.md).

**What this plan is, in one sentence:** the live system at `https://hmis.crkmch.com` currently has
**one user who can log in and no way to make a second**, and **no module's permissions are granted
to any role**, so a hospital cannot be run on it — and three MAJOR defects from 11c stand in code
that is already serving. 11d closes all of that and makes the alert path watch itself.

---

## 0. What you are doing — six phases, strictly in order

| phase | who | gate before moving on |
|---|---|---|
| **1. SPIKE** | one agent | Questions A and B answered by MEASUREMENT, and their consequences written **into the plan document, in place** |
| **2. PHASE 0** | one opus agent, one commit | `pnpm verify` exit VALUE 0 **and CI GREEN by FULL SHA** |
| **3. COMPILE** | you, main session | the EXECUTE-METHOD §3 sweep plus the plan's own list, all of it mechanical, none of it by reading |
| **4. RUN** | six sequential waves | every wave's commit CI-green by full SHA before the next dispatches |
| **5. VERIFY** | you, main session | detached `pnpm verify` with the exit VALUE from a file, per-commit Files-list audit, frozen-path sweep, clean tree |
| **6. THE DEPLOY** | you, **only when the owner names it** | flag ③ — `seed:roles` and `seed:staff` against production, and the grant join read back |

**Phase 6 is not optional and it is not yours to start.** Everything in phases 1–5 leaves production
exactly as it is. **The plan only becomes true for the hospital in phase 6**, and 11c's T6 was
blocked twice — by a safety classifier and by the owner's own
`Bash(docker compose -f docker/prod/*)` deny rule — before the owner authorized it in as many words.
**Expect the same. Do not work around either gate. Ask.**

## 1. Read first, in this order

1. **The plan**, whole, cold. Its D1 and D12 are the parts most likely to be skimmed and least
   likely to be safe to skim.
2. **`plan-11c-gate-report.md` including ALL THREE addenda.** The body says 11c is NOT LIVE and the
   addenda say it is. Both are true of their moment; only the addenda are true now.
3. **`plan-11c-findings-inbox.md`** — its open ask is answered in this plan's owner ruling 3, and
   its `changeId` entry is closed by T3.
4. **`EXECUTION-LESSONS.md` §2.46–§2.80 and §3.** §2.54, §2.77, §2.79, §2.80, §3.42, §3.43, §3.44
   and §3.46 are all load-bearing in this plan specifically.
5. **`AGENT-RULES.md`** and **`EXECUTE-METHOD.md`** — the contract and the method.

## 2. Ground truth — verify it, do not trust it

The plan states a baseline and a set of source coordinates. **Both expire.** Before you compile:

- `git pull --rebase origin main` and record the SHA you are actually at. The plan was written at
  **`c65c26b`**; docs commits land from the owner's machine while you work.
- **Re-measure the baseline** on the build host, detached, exit VALUE from a file: `apps/core`,
  `apps/web`, `packages/contracts` suite and test counts. The plan says 144/1049 · 34/173 · 3/7.
  **If they differ, the measurement wins and you say so in the gate report.**
- **Re-derive every permission count** the plan's Consumed Surfaces section states (auth 6,
  workflow 8, approvals 4, patients 5, tariff 5, opd 14, billing 14, ops 3, alerts 0, notify 0) and
  quote the greps with the SHA. §2.73: a census expires the moment anything lands.
- **Re-resolve every line number** the plan cites. Phase 0 moves lines in `scheduler.test.ts` and
  nothing else; **confirm that by `--stat` rather than believing this sentence** (§2.78 — line
  numbers are a census too, and they expired in the same commit that expired a count last time).
- **Confirm `test/ops-lifecycle.e2e.test.ts`'s current content** before T4's brief is written. 11c
  already put a kit-permission leg in it (`leg 5`, around `:336`); T4 EXTENDS, never duplicates,
  and the thirteen-route census must be **re-counted from the decorators**, not copied from the
  plan.

## 3. Compile — the items history says get skipped, plus this plan's own

Run **all** of EXECUTE-METHOD §3's sweep. It found six plan defects in twenty minutes once, five of
them HALT-class. Then these, which this plan's own authoring earned:

1. **§2.46 — resolve every File Structure path against the tree.** Modify-targets must EXIST;
   create-targets must NOT. This plan has **eight create-targets** (`manifests.ts`,
   `manifests.test.ts`, `seed-roles.ts`, `seed-roles.test.ts`, `seed-staff.ts`, `seed-staff.test.ts`,
   `deploy-parity.test.ts`, `alerts-meta.yml`) and the rest are modifies. A wrong path is a HALT,
   not a typo, because the frozen block is GENERATED from these lists.
2. **§2.54 — assert the script's `files` arrays EQUAL the plan's File Structure, per task, both
   directions.** This is the check that cost Plan 08.5 its headline deliverable by being absent.
   **Three files in this plan have more than one owner** (`package.json` T1→T2, `README.md`
   T1→T2→T5) and each owner's brief must name its own lines and **enumerate**, never say "change
   nothing else" (§2.72).
3. **§2.47 — the forward-reference pass.** T1 creates `manifests.ts` and nothing after T1 imports
   it, so the plan should be forward-safe. **Verify that rather than accepting it**; the blindness
   is structural and a careful author is exactly who misses it.
4. **§2.50 — count the tasks with no in-pipeline verdict.** There are **none**: all six are CRITICAL
   with opus gates, so the wave-stall break is live for every wave. Confirm that in the script
   rather than assuming it from the plan's table.
5. **Commit message per task** — the plan carries all seven (R0-1 + six). Confirm each is present
   before compiling; AGENT-RULES §5 step 1 resolves to nothing without them.
6. **Stat the pipeline template before grepping it** (§2.51). Its path is in the ledger's §2 header
   and it was stale once; an empty grep against a missing file reads identically to an empty grep
   against a present one.
7. **CRLF (§2.79), and this plan has a sharper version of it than 11c did.** T5 edits `deploy.sh`
   (shell) and `prometheus.yml` (YAML), **where a `\r` is not cosmetic** — a carriage return in a
   `for svc in …` line changes what the shell reads. Brief T5 to patch **server-side** with a
   `python3 - <<'PY'` heredoc reading and writing `newline=""`, which cannot introduce the problem
   at all. Two agents hit this trap in one pipeline last time and the main session hit the quoting
   family of it three times.
8. **The spike's amendments are IN the plan document before you compile.** If Question A or B moved
   anything, grep the whole plan for the superseded shape and mark it dead **in place** (§2.48) —
   "fork resolution is not an amendment" is about authority, never about process.

## 4. Run

- **Six waves, strictly sequential**, one push per wave (§2.62 — two tasks coalescing into one push
  leaves the earlier commit with **no CI run at all**, which reports identically to a red one).
- **`ci-watch.sh` in the background on your machine for the whole run.** `gh` cannot run on the
  build host, so no in-pipeline agent can check CI, and under the Workflow tool you are not sitting
  between the waves either. That combination shipped six red commits once.
- **Read more than `conclusion` (§2.59).** A CI result has three states — green, red, and DID NOT
  RUN — and the third looks exactly like the second. A duration in seconds with an empty `steps`
  array is a job that never started.
- **A census red after Phase 0 is READ, NOT RE-RUN.** §2.80's bar is still unmet. The first question
  is always **timeout or set mismatch?** — grep the log for `Expected -` and for the missing job
  names. A **set mismatch** is a regression signal and you investigate it. A **bare timeout** is the
  harness, and R0-1 exists precisely so the two are distinguishable at a glance. §2.76's control
  discipline applies: to tell a flake from a regression, re-run a commit you already believe.
- **Every task is CRITICAL.** Opus coder, per-task opus gate, mutants owed, fail-first owed. Plus the
  mechanical check on every task — **do not cut it** (11c's gate report §7.8), and one discovery
  reviewer for the pipeline, which has been the best-value agent in three consecutive runs.
- **Halt conditions that are already written into the plan, so honour them rather than reasoning
  past them:** T1 halts if the spike showed production's grants are wider than predicted; T3 halts
  if `withTx` does not hold one client or the loser does not block. **An agent reporting a plan
  defect instead of working around it is the behaviour EXECUTE-METHOD §6 says not to touch.**
- **Rule 7, restated because this plan has an infra task:** T5 may run `promtool` in a throwaway
  `hmis-drill` project it removes before reporting. **T5 may NOT run `deploy.sh`, restart any
  `hmis-prod` service, or touch production in any way.** That is phase 6 and it is yours, not a
  task's (§2.71's named-owner rule, applied by putting the owner outside the pipeline).

## 5. Verify & close

The main session verifies and never trusts a self-report:

- Detached `pnpm verify` at final HEAD, **exit VALUE read from a file**, per-workspace counts
  compared against the re-measured baseline **in both directions**.
- **Per-commit `git show --stat` against each task's Files list, both directions**, for all seven
  commits. A whole-file diff defeats this check (§2.79's second-order damage) — if a `--stat` shows
  a file's whole length, look at the line endings before you look at the logic.
- **Frozen-path audit over the whole range.** GC13's list plus this plan's additions:
  `jest.config.cjs`, `alerts.yml`, `alerts-backup.yml`, `alerts-parity.test.ts`,
  `caddyfile-parity.test.ts`, and **the whole of `apps/web/`** (GC4 — this plan ships no screen).
- **`drizzle/` is UNTOUCHED, in both directions** (GC2). A migration in this plan is a halt, and
  confirming its absence costs one `git diff --stat`.
- **`pnpm-lock.yaml` untouched.**
- **Container and volume roster read and compared against rule 7**, before and after. Nothing this
  pipeline does should move it; phase 6 should not either.
- **Grep the whole commit range for a credential shape** — the repo is PUBLIC and T2 is the
  highest-risk task this project has yet shipped for GC3. No password, no PIN, no roster, no owner
  email, no SMTP value beyond the placeholders already committed.
- **Then the ledger**, same session: every §2/§3 entry this run earned, with its specimen. And the
  **findings inbox** for anything routed forward.

## 6. The deploy — flag ③, and it is the point of the whole plan

**Only when the owner names the operation.** Then, in this order, each with its exit VALUE read from
a file (rule 18 — a dropped link mid-run destroys the evidence):

1. **`seed:roles` against production**, through the shipped image the way 11c ran `seed-ops`
   (`compose run --rm api node dist/scripts/seed-roles.js`). Quote the whole transcript: roles
   created versus already present, grants per role, and the readiness verdict.
2. **Read the join back** — `users → role_assignments → role_permissions` — and compare it against
   the role model **at the level `PermissionGuard` actually reads**, not against the script's own
   report. 11c's addendum 2 is the precedent and it is the right standard.
3. **`seed:staff` against production**, roster on **stdin** from the owner's file, which stays on
   the owner's machine. Quote the secret-free report. Then re-run it and quote `already`.
4. **Re-run `seed:roles`** and confirm it reports `already` and exits 0 — idempotence proven on the
   live system, not merely in a drill (again, 11c's standard).
5. **`deploy.sh`**, for T5's monitoring changes, and then confirm by the service's own API rather
   than by `ls` inside a container (§2.77): the `alertmanager` scrape target appears in
   Prometheus's `/api/v1/targets` as **up**, and `/api/v1/rules` loads **three** rule files with
   **eight** rules across them. **A file visible in a container is not evidence that the process
   read it.**
6. **A real login as a real staff member** — the owner, or someone with a roster account — reaching
   one route their role grants and one it does not. **This is the only evidence that the whole chain
   works**, and no test in the pipeline can produce it.

**Then the gate report**, and it lands three roadmap corrections this plan was forbidden to make:
11c's status line still reads *"SHIPPED AS CODE … NOT LIVE"* when its own addenda say otherwise ·
11d belongs in the sequencing note between 11c and 09 · Plan 11e needs a slot. That is the pattern
11c's own gate report used to fix the stale Plan 07 and 08 lines.

## 7. Hard constraints

- **NO MIGRATION AND NO SCHEMA CHANGE.** A `drizzle/` diff in either direction is a halt (GC2). This
  removes AGENT-RULES §6's whole irreversible-host-mutation class from the run — the class that
  cost ~934k tokens once and delivered nothing. Do not give it back.
- **`apps/web` is frozen in full.** No screen, no route, no locale key.
- **The repo is PUBLIC.** No secret in any commit, ever — and this plan handles passwords and PINs
  for the first time.
- **Rules 3 and 7 as amended** govern every path and container decision. `hmis-db-1` is the dev
  database; `hmis-prod`'s database and volumes are a live hospital's data.
- **Never weaken a guard to produce evidence** (rule 14). T4's whole job is permission enforcement;
  a mutant lives in a scratch file beside the source, never in the source.
- **Never rewrite pushed history** (rule 15). A correction lands as a new commit. If a classifier
  blocks an amend, it is right and the ledger says so (11c §7.6).
- **The plan document is the code authority; `AGENT-RULES.md` is the process authority.** Where a
  brief disagrees with the rules about PROCESS, the rules win; where it disagrees with the plan
  about CODE, the plan wins.
- **You are not the writer.** If the plan is wrong, say so, amend it in place with the amendment
  visible in its own commit, and grep the whole document for what the amendment supersedes. That
  loop has caught four defects that would otherwise have shipped.
