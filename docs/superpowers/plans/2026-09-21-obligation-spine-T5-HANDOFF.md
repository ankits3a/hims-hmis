# HANDOFF — the obligation spine, resume at T5

**Seed a fresh session with THIS FILE FIRST, then `2026-09-20-obligation-spine-EXECUTE-PROMPT.md`.**
Written 2026-09-21 by the session that executed T3, T1 and T4, at the stop-loss the execute
prompt sets for T3–T11 (V3 §9.6: the last budget goes on RUNNING, then on writing this).

**Sections of the implementation plan you do NOT need:** §0, §1 (superseded by §1a and by §9.1's
measured answers), §2.1–§2.3, §6's C-series rows already discharged below, §7, §8. **Read §1a,
§9.1, §2.4 onward, §3, §4 from T5, and §5.**

---

## 1. State in one paragraph

T3, T1 and T4 are built. T3 and T1 are **MERGED to `main` and NOT deployed**. T4 is on lane
`oblig-t4`, code-complete, its own suites green, and is either in review or merged by the time
you read this — **check `gh pr list --search oblig-t4` before assuming either.** Nothing in this
phase has been deployed and nothing should be: the execute prompt forbids it.

| task | state | commit / PR | migration |
|---|---|---|---|
| T3 alerts acknowledgement | MERGED | `a1e8d504` (#282) | `0115_obligation_alert_acknowledgement` |
| T1 percent ladders, respond clock, budget | MERGED | `bdb0a8a7` (#283) | `0116_obligation_ladder_and_respond` |
| T4 reach, Web Push, the relay job | lane `oblig-t4` | see `gh pr list` | **`0117`** at rebase (was cut at 0116 pre-rebase) |
| T5 T6 T7 T13 T11 T8 T9 T10 T12 | NOT STARTED | — | — |

**Resume at T5**, then the prompt's order: T5 → T6 → T7 → T13 → T11, CLOSE, then T8 → T9 → T10 → T12.

## 2. The seams T5 builds on, as they now stand

- **`resolveRung()` in `kernel/workflow/timers.ts`** is the ONE place a rung becomes people. It
  wraps `escalationRecipients(tx, "workflow.timer_rung", { fallbackRoleKey }, at)` and then the
  static duty-manager fallback. T5's `resolveAddressee` must not add a fourth `usersHoldingRole`
  site — §1a's T5 delta still binds: kind `role` inside the approvals chain
  (`alerts/consumer.ts:393-401`) STAYS `usersHoldingRole` (roster finding F24), the OWNER is
  never routed through the roster (F23), and only `post` and `unit` use `whoIsOn`.
- **`kernel/obligations/` exists**, with `consumer.ts` (one branch: an ack cancels the respond
  clock) and `manifest.ts`. The manifest is **WORKER-ONLY, the `notify` shape** — no permission,
  no route, absent from `ALL_MANIFESTS`. **T5 is the task that moves it into `ALL_MANIFESTS`,**
  because `obligations.chains.manage` is the first thing the api serves from it. That move edits
  `manifests.ts`, `manifests.test.ts` (the enumerated api/worker difference is currently
  `["notify", "obligations"]` and becomes `["notify"]` again, and `workerKeys` stays 17), and
  `standup-check.test.ts`'s `NOT_DEPARTMENTS`.
- **`alerts` carries the six acknowledgement columns and four CHECKs.** `acknowledgeAlert` is the
  only domain writer; `ALERT_ACK_KINDS` is the vocabulary; handover resolves a STAFF CODE
  server-side (a user picker is T9's).
- **`alert.acknowledged` and `respond.overdue` exist** and are both consumed. The alerts
  subscription census is at **7**, not 6 — T1 took the seventh, so T5's addressee-fallback event
  is the EIGHTH. `alerts/consumer.test.ts` has TWO subscription censuses and
  `worker-runtime.e2e.test.ts` a third; all three move together.
- **T4 added `user_reach_profiles`, `push_subscriptions`, the `web_push` channel, three staff
  relay templates and the `runReachLadder` job.** If T4 has not merged when you start T5, do not
  wait for it — T5 touches none of those files. Take your migration serial at rebase.

## 3. Traps this session paid for, so you do not

1. **A new CONSUMER, JOB or MANIFEST moves censuses your targeted batch cannot reach.** T1's only
   CI red was `src/kernel/worker/seed-cursors.test.ts`, a census expressed as a NAMED ARRAY in a
   directory the lane's batch did not include — after the whole `test/` directory and five
   `src/kernel` directories ran green. **Run the FULL core suite in the lane before pushing such
   a task.** 1230 s on this box, and cheaper than a red CI plus a second cycle. Memory:
   `census-sweep-needs-full-suite`.
2. **Take the migration serial at REBASE and re-cut if it moves.** T1 and T4 both cut at 0115/0116
   pre-rebase and had to re-cut. The recipe that works: resolve the `_journal.json` conflict to
   MAIN's side, `rm` your own `.sql` and snapshot, `drizzle-kit generate` again, **then drop your
   lane's two test databases** (`hmis_lane_<lane>_test_1` / `_2`) because the regenerated `when`
   is above the watermark they already applied. Five checks after every generate: predicted
   serial == generated, `when` strictly increasing, no `idx` hole, no forked snapshot `prevId`,
   no contamination and no `$1` in an emitted CHECK.
3. **`drizzle-kit` renders a bound parameter as `$1`.** Every CHECK with a vocabulary uses the
   local `inList` helper (`sql.raw` of vetted snake_case literals). Read the generated SQL.
4. **Fail-first on a DB CHECK: ship the COLUMNS first, run the census red, then add the CHECKs.**
   T3's red was `5 failed, 7 passed, 12 total`, each refusal reporting *"Received promise
   resolved instead of rejected"*. A test that cannot compile is not a red (AGENT-RULES §2.5).
5. **Do not derive a promise from two instants that both move.** `respond.overdue` first computed
   its minutes as `dueAt − state_entered_at`; `rescheduleBudget` re-lays the timer and a
   remediation migration re-stamps the entry. Read the number from the definition.
6. **`git stash` is forbidden** (one `refs/stash` across every worktree) and `$L run <lane> pnpm …`
   takes **no `--`**.

## 4. What T5 owes, restated from the plan so it cannot be lost

`role_parents`, `posts`, `post_holders`; `resolveAddressee` with the eight kinds and the > 8
holder refusal at DEFINITION time; the DAG validated on every write AND at boot;
`obligation.addressee_fell_back` on every fallback with no silent path (V9 is an ABSENCE test);
`deriveLadder` over the sixteen types with money ending at `owner` and the rest at
`duty_manager`; the `obligations.chains.manage` permission by the four-edit recipe (manifest
declaration + `ROLE_MODEL` grant + README prose constant + `seed-roles.test.ts` pins, ~12 of
them including the two bare-integer per-role arrays); `alerts/consumer.test.ts` still green on
its shipped branches.

**Every pinned count is read off the red run. None is predicted.** The current values are in the
plan's §9.1.
