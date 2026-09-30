# HANDOFF: Plan 17-F, the Central Lab stations (written 2026-09-29, for a GitHub-connected cloud session)

Everything a successor needs is in git. The local session's memory, its scratchpad and the dev database
`hmis_lab_synth` do **not** travel. Trust `origin/main` and the PRs below over anything restated here.
Re-measure before acting.

## Paste this into the successor session

```
Read CLAUDE.md, then docs/superpowers/2026-09-29-HANDOFF-17f-lims.md (this file), then
docs/superpowers/plans/2026-09-26-17f-lims-stations.md (the phase plan). Re-measure: gh pr view
378 381 382, git log origin/main, the highest apps/core/drizzle/*.sql. If the owner has merged
#378/#381/#382, start phase F5 (QC module) exactly as the plan's F5 section and its findings table
say, in its own branch and PR, one migration numbered at rebase. If they are still open, do not merge
them yourself (squash-merge is the owner's call); report their state and ask. Never force-push; a
branch that is BEHIND gets `git merge origin/main`, not a rebase of pushed history.
```

## 1. Where things stand (2026-09-29, main `9dec14c1`)

| PR | What | State |
|---|---|---|
| #325 | The owner-approved lab-stations board (`docs/design/2026-09-25-lims-stations/`, artifact v19 + 7 Playwright walks) and the 17-F plan | MERGED `28e5ad55` |
| #330 | **F1**: `apps/web/src/components/station/station-shell.tsx`. The five lab screens are rewrapped with no behaviour change; the lab routes are `fullViewport` | MERGED `29c01263` |
| #331 | Plan amendment from the roadmap-v3 handoff: the stand-up runs beside the build; F6/F9 build on the obligation spine and roster; three census rows are assigned to phases | MERGED `5a766353` |
| #332 | **Synthetic lab stand-up**: `tools/lab-synthetic.sh`, `apps/core/scripts/synthetic/lab/`, `scripts/seed-lab-synthetic.ts`, synthetic DPIA v0.2 counsel positions. `standup:check lab` goes from 12 RED to 0 on a dev DB | MERGED `3c5114aa` |
| **#378** | The §13 five-seat walk on the synthetic lab: what held, and **14 findings** mapped to phases. Also: ruling 12 marked superseded, `seed:registration` + a front-desk user added to the synthetic script | **OPEN, CI 8/8 green, awaiting owner merge** |
| **#381** | **Safety fix**: a critical call closes only on a read-back that SAYS the value (422 `readback_mismatch`). Parses digits, Devanagari digits and English number words, including "one twenty" = 120 | **OPEN, CI 8/8 green, awaiting owner merge** |
| **#382** | **Money-flow fix**: `lab_reception` gains `lab.reports.release_unpaid`, so the counter can complete an OWNER-approved release. Separation 4 is re-pinned on `approvals.requests.decide`. Proven end to end | **OPEN, CI 8/8 green, awaiting owner merge** |

If a PR is BEHIND main when the owner merges, merge `origin/main` into the branch, re-run CI, and never
force-push.

## 2. Owner rulings that changed during this work (the plan must follow the newest)

- **Ruling 12 is SUPERSEDED (2026-09-28, #347, gap A3):** "nobody can issue credit except owner". Releasing a
  held lab report unpaid needs the **owner's** approval (`lab_release_unpaid_owner`). The plan says so on
  #378's branch. #382 makes the counter the one who ACTS on a granted approval. That is DECIDED and open to
  owner objection; the alternative (the billing manager acts) would also need `lab.reports.print` for that
  role.
- **Ruling 13 (2026-09-26):** the signing pathologist's council registration number stays on the printed
  lab report.
- **Synthetic data authorised (2026-09-26):** the owner asked for a synthetic catalogue, pathologist of
  record, users, analyser list and "DPIA v0.2 from counsel".
  - The DPIA file (`docs/compliance/2026-09-26-dpia-v0.2-SYNTHETIC-counsel-positions.md`) is explicitly
    **not legal advice and does not open the production inference gate**.
  - Nothing synthetic may reach production. The scripts refuse `:5434` and need `HMIS_SYNTHETIC_DATA_OK=1`.
- **WhatsApp/SMS provider:** the owner will attach it later. Read receipts, the SMS fallback and the
  relative OTP stay blocked (F8).

## 3. What is left, in order

**A. The owner merges #378, #381, #382.** Nothing below depends on #381/#382 except the walk re-run.

**B. F5, the QC module (next build phase).** Spec: the plan's "F5 · QC module" and its F5 additions.
- Tables `lab_qc_materials`, `lab_qc_runs`.
- Westgard rules: 1-2s warns; 1-3s and 2-2s reject.
- It writes the `qc_locked` / `available` statuses that already exist in `modules/lab/kinds.ts`.
- **Release gate:** `ingestResults` and `enterResult` refuse a locked analyser, with no override. Unlock only
  on a passing run.
- A Levey-Jennings read model, and a look-back list of samples run before the failure.
- Web: the "Instruments & QC" view inside the F1 station shell.
- New census row `lab_qc_material_per_analyser`.
- One migration, numbered at rebase: main's highest is `0147_aerb_incidents_pregnancy.sql`, so re-read it
  at rebase.
- A new test must fail first.

**C. F6, escalation to people.** Build on `kernel/obligations/` (the spine), the kernel ladder
(rung → `duty_manager` → `owner`) and `modules/roster/resolve.ts`. Do not build a second escalation system.
- `lab_supervisor` becomes a role key in `LAB_ROLE_KEYS` (`scripts/standup-check.ts`), with a G4 census row.
- Pages: the supervisor at 15 min, the pathologist at 30.
- `sweepLabSla` breaches set `notified`.
- Closes census row `lab_critical_call_list`.
- Keep the critical-call ladder (whom the bench phones, `criticals.ts` `RUNGS`) separate from escalation
  (who is paged).

**D. Then F7 → F8 → F9, with F2 ∥ F3 ∥ F4 where lanes allow.** Each walk finding below is owned by a phase.

| # | Finding (from the §13 walk, #378) | Phase |
|---|---|---|
| 3 | "Save & complete" never lights on panels with a formula analyte; a typed formula value is refused 422 and aborts the batch (per-row Save works) | F4 |
| 4 | The wristband scan is held only in the browser; reopening mid-draw downgrades the draw to "no wristband scan" | F3 |
| 5 | A pathologist cannot start a result: `accessioned→in_analysis` allows only `lab_technician`, `lab_bridge` | F4 / F6 night cover |
| 6 | Verify cannot move a rerun choice before signing | F7 |
| 7 | The lab desk's own registration has no near-duplicate override; ruling 6 removes that door anyway | F2 |
| 8 | Raw UTC ISO timestamps on the critical call and on the PRINTED report ("Authorised: …Z") | F6, F7 |
| 9 | The printed report shows an invented exact date of birth for an age-only registration | F7 |
| 10 | A patient with no phone gets notices queued for ever; the register says "notice queued" | F8 |
| 11 | Bench and verify show four decimals ("11.8000") | F4, F7 |
| 12 | The station shell has no language switch | F1 follow-up |
| 13 | The environment banner covers full-viewport headers (the station shell and Desk One) on non-prod | F1 follow-up |
| 14 | "KFT" (the common Indian name) does not find RFT | F2 |

Findings 1 and 2 are the fixes in #381 and #382.

**E. Not yet rehearsed:** runbook Drills A–D (`docs/runbooks/lab-go-live.md` §10) on the synthetic DB.

## 4. Owner-only inputs still owed for PRODUCTION (synthetic stands in only on dev)

- the lab catalogue spreadsheet: it must band every analyte, including urine and stool microscopy, which the
  golden fixture leaves unbanded;
- the real pathologist of record and the four lab role holders;
- the analyser inventory (only the Curio Lab Gen 1 is known);
- DPIA v0.2 from real counsel;
- the WhatsApp/SMS provider.

## 5. How to work (if the successor has a box, not just GitHub)

- CLAUDE.md rules bind: one lane per task (`tools/lane.sh new <name>`); commit by pathspec; the test lock
  (`/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run <lane> …`) around every jest/vitest pool; the full
  suite belongs to CI.
- The synthetic lab: `tools/lab-synthetic.sh [db]` on the dev instance `:5433`. It is idempotent, and changed
  data needs a fresh DB. After pulling main, re-run it, or at least `seed:lab`, because new approval types
  appear in migrations and seeds. Credentials are generated into `~/.hmis-synthetic/<db>.credentials`.
- A lane must run `pnpm --filter @hmis/contracts build` before any `tsx scripts/*` (MODULE_NOT_FOUND
  otherwise).
- Browser walks: build core (`pnpm --filter @hmis/core build`); run `node dist/src/main.js` and the worker
  with `SECRET_KEY` (64 hex), `DOCUMENT_STORE_PATH` and `HMIS_ENVIRONMENT_LABEL`; point vite at it. **Check a
  port's owner first** (`ss -ltnp`, `/proc/<pid>/environ`): other sessions run their own servers. Kill only by
  PID; `pkill -f` / `pgrep -f | xargs kill` matches your own shell and ends it.
- Lab screen tests render without a router; the station switch uses `useRouter({ warn: false })`. Never put
  `.pp` on a screen that still uses shadcn controls, because `desk-one.css`'s `.pp button`/`.pp input` resets
  strip them. `.st` carries the palette alone.
- Names the roadmap-v3 brainstorm proposes that are **not on main**: `unbilledOrdersFor`,
  `PROTOCOL_GATE_EVENTS`, `ops_fact_sheets`, print kind `lab_label`, a lab-report `lang` parameter. Never cite
  them as existing.

## 6. If the successor has only GitHub (no box)

- It cannot run the synthetic DB, the browser walk or the test lock. Rely on CI (`gh pr checks`, where every
  commit runs twice) as the gate, and say plainly that nothing was run locally.
- F5 can still be written and pushed on a branch. Its tests run in CI's core shards.
- Do not merge; the owner squash-merges.
