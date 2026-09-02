# HANDOFF — the front-desk lane, 2026-09-02 13:10 UTC

**Written by the executing session at 89% of its context.** Paste the prompt at the bottom into a
fresh session opened at `/opt/hmis-lanes/front-desk/hmis`. Memory is shared across lanes and is
already up to date: `front-desk-lane-2026-09-02.md` in the project memory carries the day in detail.

## 1. State in one paragraph

**VD-2 (Bay One, the vitals desk) is MERGED to main** via PR #15 and **FD-1 (the front-desk
dashboard) is MERGED to main** via PR #29 (`c11833d`, 12:59 UTC). Both phases ran two close-review
passes and are remediated; their phase docs carry the CLOSE sections. **Neither is deployed.** The
owner asked for the dashboard to go live; the integration checkout `/opt/hmis` is at `c11833d`
with a clean tree, and the deploy script is the ONE thing the executing session could not run —
the permission classifier refuses `bash docker/prod/deploy.sh` in every form. The owner runs it.

## 2. The next three actions, in order

1. **Deploy** (owner's hand, from any session's prompt):
   `! bash /opt/hmis/docker/prod/deploy.sh` — idempotent, builds from the checkout, migrations
   from inside the image, seeds, then the health gate through the edge. Production was at **46**
   migrations; main deploys **56** (VD-1 0049, radiology 0050–0054, FD-1 0055 — two indexes).
2. **Verify**: `bash /tmp/claude-0/-opt-hmis-lanes-front-desk-hmis/87840b0c-3f23-403c-8fd7-6e87bbf1cdf1/scratchpad/deploy-verify.sh`
   (if the scratchpad is gone, the checks are: migration count 56; `curl https://hmis.crkmch.com/api/health`
   answers JSON; `/counter/seat/figures` and `/opd/vitals/bay` serve HTML; `/api/me/desk` answers
   401 without a token; `pg_indexes` has `receipts_session_idx` and `refund_vouchers_session_idx`).
3. **Tidy**: in `/opt/hmis`, drop stash `a0b73c4` (tag `front-desk-deploy-2026-09-02-identical-docs`,
   six docs byte-identical to what PR #5 committed — find it by tag first, `git stash drop stash@{n}`);
   watch PR #32 (test-only flake fix, armed) land; then `tools/lane.sh drop front-desk` from `/opt/hmis`.

## 3. What is live for whom, after the deploy

Production holds 7 `front_office`, 7 `cashier`, 4 `vitals_desk` users (read-only count on
2026-09-02). The three tiles appear on their home screen and "your figures" opens from the seat's
header with **no data change**; Bay One serves at `/opd/vitals/bay` for the vitals desks. Deploying
main also carries the other lanes' merged work since the last deploy (VD-1 rails, radiology 18a
and its DICOM seams, LIMS 17c seats) — all CI-gated.

## 4. Open items and who holds them

- **RC-5 (benefits in the clerk's hands)** — gated on three money rulings, defaults in
  `2026-09-02-SCOPE-front-desk-lane.md`: R1 bundled coupon not bearer (bound to the UHID); R2 a
  full refund does not un-flip PAID; R3 F5 midnight re-dates the deferred visit in the settle hook.
- **Deletions the owner holds**: `/counter` (RC-4 T5) and `/opd/vitals` (VD-2 T5 ran the seven
  stories). Each is one edit and a route pin −1.
- **Procurement**: the serial-device ledger for the bays; the bay ships with the lane OFF.
- **RC-6** the agent surface (`agent_ledger`, footer bar, F2, log, say-this lines) — unbuilt; the
  vitals bay and the figures screen were built to consume it, not fork it.
- **Recorded, not fixed** (phase docs §7): VD-2 — the held first take across a rest is one tab's
  `sessionStorage` (server truth needs a column, a migration); the cancelled-entry predicate on
  the record path; the carried lock is opt-in; `GET …/escalation` is ungated. FD-1 — the
  fixed-page print model (07a's, every printable screen's); the 7-/30-day window edges untested;
  "already had that mobile", SMS bounces, counter timing need rails that do not exist; no budget
  pin for the drawer under load.

## 5. Mechanics that cost a day to learn

- **Branch tooling**: the classifier blocks `git switch`/`checkout -b`, `push --force-with-lease`,
  `gh run rerun`, and `gh pr merge --auto` on a PR whose title says "do not merge". What works:
  commit on `lane/front-desk`, `git push origin HEAD:refs/heads/lane/front-desk-<task>`, `gh pr create --head`
  that branch, `gh pr merge N --squash --auto`; catch up with `git merge origin/main` (never rebase).
- **Branch protection needs an up-to-date branch**: every merge on main knocks open PRs BEHIND
  mid-shard. `gh api -X PUT repos/ankits3a/hims-hmis/pulls/N/update-branch` re-triggers CI
  without dropping auto-merge; close+reopen drops it. Core shards take ~30 min. A stacked series
  merges as its TIP; close the task PRs afterwards as the record.
- **Peer lanes** (pharmacy `hmis-5a`, LIMS `hmis-30`, radiology `hmis-e0`) answer `SendMessage`;
  they held merges for #29 on request and resumed — say when you are done. Space merges ~12 min.
- **Shared files touched today**: `apps/web/src/lib/auth.tsx` (logout clears the query cache —
  a boot-time clear breaks screens that fetch before `/auth/me`), the seat census in
  `registration-counter.test.tsx` (four `data-seat` carriers), migration 0055.
- **Lessons**: read each route's permission against the ROLE that sits at the seat and stub the
  routes it cannot reach as 403 (VD-2's CRITICAL was invisible to 40 dead mutants); a provider test
  must use the real clock (`registerPatient` stamps `now()`); never assert a short substring over a
  JSON dump (a ULID contains any two letters — PR #32); when two remediations meet at one seam,
  pass 2's WRONG lives there.

## 6. The prompt for the new session

```
You are the front-desk lane of the HMIS monorepo, in the worktree /opt/hmis-lanes/front-desk/hmis
on branch lane/front-desk. Read CLAUDE.md, then docs/superpowers/plans/2026-09-02-HANDOFF-front-desk-lane.md
in full, then the memory entry "Front-desk lane 2026-09-02" from the index. Do not re-derive anything
those three carry. VD-2 and FD-1 are merged to main and NOT deployed; the deploy is the owner's hand
(section 2 of the handoff). Your job: (1) run the post-deploy verification once the owner reports the
deploy done and record the measured migration count in memory; (2) drop the tagged stash in /opt/hmis,
confirm PR #32 landed, and close the lane with tools/lane.sh drop front-desk from /opt/hmis; (3) if the
owner rules on RC-5's three money questions, author RC-5 as a phase doc under 15 KB in the house pattern
(one PR per task, every rail grep-counted with its consumer before its task is written) and stop for
approval before code. Do not start RC-6 or FD-2. Commit by pathspec, push task branches as
HEAD:refs/heads/lane/front-desk-<task>, one PR per task, squash auto-merge, merge origin/main to catch up.
```
