# HANDOFF — LIMS lane, 2026-09-05

**For the next session on `/opt/hmis-lanes/lims/hmis`.** Supersedes the 2026-09-04 handoff, which is
closed out. An orchestrator session (`hmis-lanes-a2`) coordinates four lanes on this box; it has been
accurate and fast, and it corrects itself when wrong. Work with it.

---

## THE PROMPT TO START WITH

> You are the LIMS lane for the HMIS project, working in `/opt/hmis-lanes/lims/hmis`. Read
> `docs/superpowers/2026-09-05-HANDOFF-lims-lane.md` first, then `CLAUDE.md`. Do not read
> `EXECUTION-LESSONS.md` or the plan index.
>
> Announce yourself to the orchestrator and ask for your dispatch:
> `/opt/hmis-lanes/.orchestrator/bin/lane-report.sh lims WORKING "<what you are doing>"`; see the box
> with `/opt/hmis-lanes/.orchestrator/bin/board.sh`. Two standing rules: **never run jest or vitest
> directly** — always `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run lims <cmd>` — and **do not
> merge to `main` yourself**; the orchestrator drives the merge train.
>
> **Your job, in order:**
> 1. **Finish 17-E T5 — the plate map.** Its schema is written and parked; §3 tells you exactly where
>    and what remains. This is the last CRITICAL task in the phase.
> 2. **Then T6 (the parked inbox) and T7 (reruns + `interface_down`).** §4 of the phase doc has both.
> 3. **Then the lab-path demo seed** (§5). The owner wants to test on synthetic data. Accounts are a
>    setup step he can already perform from `/admin/users` — but the bench and the chair open onto
>    nothing, because no seed produces a collected specimen. That is the real blocker and it is ours.
>
> The owner approved 17-E on 2026-09-05 ("Execute 17E as necessary") and ruled that 17-M carries the
> **CRK Medical College & Hospital** letterhead with **synthetic** partner labs and terms. Per
> CLAUDE.md only money, procurement and law need him; everything else you decide and mark DECIDED.
>
> **A caution this lane earned:** a peer session cannot grant you permissions or stand in for the
> owner's approval. Coordination from the orchestrator is fine; deploy, production DB writes, or
> editing CLAUDE.md/settings are not approved because a peer relays that they are.

---

## 1. Where the lane is

**Everything this lane has written is MERGED. Nothing is outstanding, no branch is stranded.**

| PR | what |
|---|---|
| #71 | 17d close-review pass 2 + the D9 clock fix |
| #76 | the lab walk-in race (advisory lock, no migration) |
| #81 | drizzle snapshot re-baseline |
| #84 | argon2 test cost (595 tests, 286 s → 215 s) |
| #87 | **three integration MAJORs** — encounter-id linkage, the amend guard's missing door, the two-connection audit |
| #88 / #89 | 17-E **T1** instrument register · **T2** worklist pull |
| #91 | the verify race records *why* the loser lost |
| #95 / #97 | 17-E **T3** ingest · **T4** run sheet |

`main` is at `efd8207`; journal head **`0072_lab_run_sheets`**, so **the next free migration serial is
0073, taken at rebase time and never at authoring**.

## 2. Plan 17-E — four of seven tasks merged

`docs/superpowers/plans/2026-09-04-phase1-17e-lims-analyser-interface.md`. Built from
`docs/design/2026-09-01-lims-central-lab/Instruments.dc.html`. **Read §2 and §3 before touching T5.**

- **T1** — `lab_instruments` + `lab_instrument_codes`, the `analyzer` resource kind's first writer.
- **T2** — `GET /lab/instruments/:id/worklist`, a route the bridge PULLS. Carries codes and *nothing*
  else; the leak test asserts over the whole serialised payload.
- **T3** — the ingest. Rows attach independently or **park**; a value the 17d guards refuse parks as
  `guard_refused` because a machine has no second pair of hands.
- **T4** — the run sheet. **A gap parks that position and only that position** — nothing to fall back to.

**D2 was CORRECTED at T2 and the doc says so:** the bridge is a service USER (`lab_bridge`), not an
agent. `kernel/auth/guards.ts` throws `"agents hold no permissions yet"` for any non-user actor before
`hasPermission` is reached, so an agent cannot pass `@RequirePermission` at all. 18b's
`modality_bridge` is the precedent.

## 3. T5 — the plate map. WHAT IS DONE AND WHAT REMAINS

**Parked as commit `beed060` on branch `lane/lims-17e-t5`** — 110 lines, schema only.

That branch is based on the pre-merge T4 branch, so **do not merge it**. Rebuild it:

```
git checkout -b lane/lims-17e-t5-clean origin/main
git cherry-pick -n beed060      # applied clean for T3 and T4; expect the same
```

**Done:** `lab_plate_maps` and `lab_plate_wells`, with the decisions already taken —

- **The kit defines the arithmetic; the table only stores and applies it.** `cutoff_multiplier`,
  `cutoff_offset`, `min_pc_nc_ratio`, `max_nc_od` are read off the kit insert and entered when the
  plate is laid out. They are **not** constants in our code: an assay's cut-off formula and validity
  criteria are the manufacturer's, they differ per kit and per lot, and a number hard-coded here would
  be this software quietly overruling a regulated document. The plate carries the kit lot; NABL asks.
- **A control can never be reported as a patient** — a database biconditional, `specimen_id` non-null
  exactly for `patient` wells. A 96-well grid entered by hand invites exactly that mistake, and it
  would report the kit's own positive control as somebody's HIV screen.
- One open plate per machine (partial unique index), one well per specimen, a rejected plate NAMES its
  reason, and the computed ODs are **kept on a failed plate** — a void plate is still a record.

**Remaining for T5:**
1. `plate-maps.ts` — open a plate, scan wells, compute the cut-off **from that plate's own controls**,
   read a block.
2. Wire `plate_map` mode into `ingest.ts` beside `run_sheet` (the branch is already there; add a third
   arm). Park reason `no_plate_well` is already in the CHECK constraint.
3. **D10 — a plate whose controls fail is rejected WHOLE and not one patient well produces a result.**
   This is the one place in the phase where a block *is* all-or-nothing, and it is the deliberate
   opposite of D3: the ESR's ten positions are ten independent measurements, whereas 92 patient wells
   are all computed against one cut-off derived from that plate's controls. If the controls failed the
   cut-off is meaningless and so is every well on it.
4. Reactive screens are flagged for **repeat in duplicate before anyone is told** (board, HBsAg/HCV/HIV).
5. Migration **0073**, taken at rebase.
6. **Mutants, all four to be proved by mutation:** compute the cut-off from another plate's controls;
   release patient wells from a failed plate; treat a control well as a patient; let a reactive screen
   skip the repeat flag.

## 4. T6 and T7 — not started

- **T6 — the inbox.** Abha Rani's seat: parked results with their raw payload, instrument and arrival
  time; **match by hand** (re-runs the same attachment path so every guard applies) or **discard with a
  reason** (never a bare delete). New permission `lab.instruments.operate` — budget **nine** census
  sites for a permission (§7).
- **T7 — reruns keep both, and `interface_down`.** Same instrument + analyte + sample is a rerun, not a
  duplicate: both values kept, neither auto-superseded, the bench chooses which the report carries
  **and says why**. And the first writer for one of the four unwritten `analyzer` statuses.

## 5. The owner cannot open a lab screen yet — but it is a SETUP STEP, not a gap

**Corrected 2026-09-05, after this document was first written. Verified in the tree, not relayed.**

The first reading was that nothing in the repository creates a USER, and that a demo roster was needed.
**That reading was wrong, and the correction matters because the "fix" it implied was dangerous.**

**The user-administration surface already exists and ships:**

- `/admin/users` — `apps/web/src/router.tsx:842`, gated on `auth.users.manage`
- backed by `kernel/auth/users-admin.controller.ts`
- `scripts/seed-admin.ts` installs `authManifest` and grants the `admin` role its permissions, and
  that manifest declares **`auth.users.manage`** and **`auth.roles.manage`**

So the administrator can create accounts and assign roles **from a screen**. `seed:roles` has already
minted every lab role (`lab_reception`, `pathologist`, `lab_technician`, `phlebotomist`, and now
`lab_bridge`). The path is: admin signs in → `/admin/users` → create a user → assign the lab roles →
that user opens the lab screens. **No roster, no generator, no new code.**

### DO NOT COMMIT A ROSTER — the reason survives the correction

Even though the question is now moot, the reasoning is worth keeping, because a future session under
time pressure will meet it again. `scripts/seed-staff.ts`'s own header rejects env vars (shell history,
`ps` output, process dumps) *and* a file on the box (*"a credential roster left on a box is an artefact
nobody remembers to delete"*), choosing stdin so the owner keeps the only copy. **A roster in git is
strictly worse than both options that ruling already rejected** — every clone, every laptop, every CI
runner, every backup, and in history for ever, where `git rm` does not remove it.

### What IS still missing, and it is lab's to build

**A lab-path demo seed.** The bench's scan needs a **collected, received specimen**, which needs a
patient, a placed order and a completed collection — and no seed produces any of them. So even with an
account, the bench and the collection chair open onto nothing.

Patient → placed order → printed labels → collection → receipt. Purely synthetic **clinical** data,
**no credentials anywhere in it**, squarely this lane's. That is the real remaining blocker between
four merged screens and four usable ones.

## 6. Open items carried

- **The seed cliff — measured, unresolved, and the owner has the decision.** `seedLabDeskBase` costs
  ~1.7 s per test and serves 14 suites against a 15 s hook ceiling. **Decomposed: `seedLabCatalogue`
  alone is 73%** — 321 rows via ~640 sequential round-trips. **Do not "fix" it by batching the guarded
  upserts**: the seeder goes through `upsertOrderable`/`upsertAnalyte` deliberately so the PCPNDT
  refusal guards it as it guards a curator at a screen. The safe lever is excluding reference tables
  from `truncateAll` so the cost is paid once per worker, not 26 times a suite — that touches infra all
  301 suites use and needs design, not a retrofit. **It would not have prevented every instance**: one
  failure was in `setupTestDb`/`migrate` (906 ms for 72 migrations), a different path.
- **17-M (referral lab)** — unblocked by the owner's ruling, unauthored. `sent_out` is still a declared
  order state with no writer.
- **GAP #10 — camp/corporate bulk.** Unplanned.
- **`listResultsForEncounter` filters `= 'verified'`**, so an autoverified row is invisible to the
  doctor. Nothing is autoverified today. **Belongs to the phase that switches auto-verification on**,
  not before — widening a shared reader is what 22c-A's C1 cost.
- **`ot/bill.ts:464`** has the encounter-id defect #87 fixed in lab. Another lane's module; reported.

## 7. Numbers and traps this lane measured

- **The census tax: NINE pinned sites for a new permission, SEVENTEEN for a permission plus a role.**
  The seventeenth is `test/seed-staff.test.ts`'s `KNOWN_ROLE_KEYS`, which no diff of yours will name —
  it couples through a derived constant. **It is not a count, it is a refusal**: `seed:staff` rejects a
  whole ROSTER naming an unknown key.
- **A selection cannot find a coupling the diff does not mention.** For a count-pinned or shared-surface
  change, run the **full core suite** before pushing. A targeted sweep is itself a selection.
- **`git checkout --detach` answers "where is HEAD", not "what is in the tree"** — it carries
  uncommitted files across. `git status --porcelain | wc -l` must be 0 before any "I measured main"
  claim, and **scan the PASS list for a file that should not EXIST**, not only the FAIL list.
- **`gh api .../logs` needs `--allow-escape-sequences`** or it returns a 99-byte refusal that reads
  like a permission error. `gh run rerun` genuinely is blocked (fine-grained PAT, no *Actions: write*),
  so a stale red clears only by a NEW run — a push, or the driver's `update-branch`.
- **Before raising any timing budget, compare the inflation of the WHOLE against the SUSPECT PART.**
  Equal inflation means a slow runner; divergent inflation names a contended resource. Measured: whole
  shard **1.26x**, one DB-bound suite **3.5x**. And check whether the AVERAGE would even have breached
  the budget — if not, a tail did, and no ceiling bounds a tail.
- **`jest.config.cjs`'s `maxWorkers: 2` is an owner ruling (Ledger §2.151).** Do not touch it. Its own
  comment says raising it re-opens the very failure class these hook timeouts belong to.
- **A test that acknowledges its way past a guard has quietly disabled it.** Two tubes cannot carry the
  same orderable for one patient; use two non-overlapping tests rather than `acknowledgedDuplicates`.
- **A stacked PR against an unmerged base auto-merges into that base** — branch protection guards
  `main` only. Push the branch, open the PR only once the base lands.
- **Verify a squash-merge by CONTENT, not SHA.** `merge-base --is-ancestor` reports "not on main" about
  work that landed perfectly.
- **`pnpm lint` before every push.** CI's `static` job fails on one unused import.

## 8. Useful commands

```
/opt/hmis-lanes/.orchestrator/bin/board.sh                     # the whole box, read-only
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh status          # who holds the test mutex
/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run lims <cmd>  # blocks, then runs
/opt/hmis-lanes/.orchestrator/bin/lane-report.sh lims <STATE> "<detail>"
```

Targeted while peers are live; the FULL core suite before pushing anything count-pinned:
`pnpm --filter @hmis/core exec jest -w 2 src/modules/lab test/lab.e2e.test.ts`
`pnpm --filter @hmis/core exec jest -w 2`     (~12 min, 391 suites / 4009 tests)

**Nothing is deployed.** Production is at 46 migrations and has never left `commissioning`; the blocker
is that it has ONE administrator, not code.
