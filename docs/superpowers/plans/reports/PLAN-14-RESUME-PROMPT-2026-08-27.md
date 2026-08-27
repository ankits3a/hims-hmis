# Plan 14 — RESUME PROMPT: finish the close remediation, re-review, close, deploy

**Written 2026-08-27 by the executing session, at its context limit, mid-remediation.** Paste the
fenced block below into a fresh Claude Code session **on the build host**, model Opus.

The phase is **CODE-COMPLETE and BLOCKED**. All nine tasks are committed, pushed and CI-green. The
independent close reviewer returned **1 CRITICAL + 9 MAJOR + 8 MINOR**. Roughly half the
remediation is written and **sitting uncommitted in the working tree**. The rest is listed below,
exactly.

---

```
Plan 14 (Materials core) — FINISH THE CLOSE. You are on the build host, in /opt/hmis, on `main`.
The nine tasks are DONE, pushed and CI-green. An independent reviewer BLOCKED the close with 1
CRITICAL and 9 MAJORs. Remediation is HALF WRITTEN AND UNCOMMITTED. Your job is to finish it,
re-review it, close the phase, and ask the owner to authorise the deploy.

═══ READ FIRST (three reads, then work) ═══

  1. docs/superpowers/plans/2026-08-27-phase1-14-materials-core.md — the phase document. §1–§5 are
     the contract (DD1–DD18, owner rulings O-2/O-6/O-8/O-11, Assertion Book A1–A21 with FOUR rows
     corrected in place by execution). **§6 CLOSE is already written** — findings F1–F16, the
     Assertion Book outcomes, mechanical evidence. You will APPEND to §6, not rewrite it.
  2. docs/superpowers/AGENT-RULES.md in full. Rules 14–21 have no exceptions. **Rule 15: never
     amend or force-push. Every correction is a NEW commit.**
  3. This file's "THE REVIEWER'S FINDINGS" section below — it is the reviewer's report, verbatim
     enough to act on. DO NOT re-read EXECUTION-LESSONS.md in full (362 KB, re-billed every call).

═══ STATE, EXACTLY ═══

HEAD = dd0a4b7 (pushed). The phase's commits, all CI GREEN by full SHA:
  d068b99 T1 schema (16 tables, migration 0034) · 957515d T2 seam · 1c5b637 T3 items
  bc5ad0b T4 vendors · ec3b493 T5 ledger · 1a1548f T6 GRN gate · b3c9c18 T7 issue+consumer
  d86e00e T8 routes/sweep/e2e · b0cffd7 T9 screens · 2a54ebf close fix (F15/F16)
  dd0a4b7 docs: CLOSE part 1
(402b458 between T1 and T2 is ANOTHER LANE's docs-only commit. Not ours. A second lane shares this
working tree — stage BY PATH, never `git add -A`; read reports/2026-08-26-parallel-session-protocol.md.)

**UNCOMMITTED in the working tree right now — written, NOT typechecked, NOT tested:**
  M apps/core/src/modules/materials/ledger.ts               C1 fix
  M apps/core/src/modules/materials/materials.controller.ts M1 fix
  M apps/core/src/modules/materials/stores.ts               M2 fix
  M apps/core/src/modules/materials/items.ts                M4 fix
  M apps/core/src/modules/materials/events.ts               M3 fix (payload field rename)
  M apps/core/src/modules/materials/consumption.ts          M3 + M5 fix
  M apps/core/src/modules/materials/grn.ts                  M9 fix + `istDay` exported
  M apps/core/src/modules/materials/expiry.ts               m2 fix (UTC→IST day)

Delete the stray `.ciwatch.*` / `.fix.*` scratch files before any `git add` (AGENT-RULES §5 step 0).

═══ WHAT IS ALREADY FIXED (verify by reading, then move on) ═══

**C1 — the lost update. THE ONE THAT BLOCKS.** `ledger.ts` `postMovements` wrote an
application-computed ABSOLUTE balance (`before + delta`) through `onConflictDoUpdate`, and
`lockBalances` (`SELECT … FOR UPDATE`) cannot lock a row that does not exist yet. Two concurrent
inbound movements into a NEW `(store, batch)` pair therefore both read 0, both wrote `q`, and the
ledger summed to `2q` while the balance said `q` — a silent loss that lands HIGH, so
`stock_balances_non_negative_ck` never fires. Reachable through `postGrn`, `issueStock` (two sources
racing on the shared `IN-TRANSIT` row) and `receiveStock`. **Fixed:** the upsert is now an atomic
INCREMENT (`set: { qtyOnHand: sql\`${stockBalances.qtyOnHand} + ${m.qtyDelta}\` }`) with `RETURNING`
supplying the true post-value; the `after` map is gone.

M1 `ResourceError` now mapped in `materials.controller.ts`'s `toHttp` (it reached
`POST /materials/stores` as a 500 — the same defect Plan 13's close fixed in the OPD controller).
M2 `ensureTransitStore`'s 23505 catch was DEAD (createResource already types it) — now catches
`ResourceError` with code `duplicate_code`.
M3 `material.consumed` mixed units: `mrpPaise` per PACK beside a `ceilingPaise` silently converted
per BASE unit. Payload now carries `mrpPaise`+`mrpUom` (as printed), **`mrpPaisePerBase`** and
**`ceilingPaisePerBase`** (unit in the name). `perBaseOrNull` helper added to `consumption.ts`.
M4 the pair rule ("paise never travels without its unit") now applies to `ceilingPaise` in
`setPriceRegulation` — DD8 rule 7 was failing OPEN by the pack multiplier.
M5 `consumptionsFor` now returns `mrpPaisePerBase`, `ceilingPaisePerBase` and `caseRef`, resolving
the regulation PER ROW at that row's own `occurred_at`.
M9 the consignment-lot agreement lookup is filtered to those VALID ON THE CHALLAN DATE and ordered
deterministically (it recorded an arbitrary, possibly expired, agreement).
m2 `expiry.ts` used a UTC calendar day; now `istDay` (exported from `grn.ts`).

═══ WHAT IS NOT DONE — DO THIS ═══

**1. The uncommitted work does not compile or pass yet. Nothing has been run since it was written.**
   `pnpm typecheck` first. **`consumption.test.ts` WILL FAIL**: it asserts `ceilingPaise` on the
   event payload and on `ConsumptionRow`. Update it to the new field names and ADD a leg that would
   have caught M3 — a fixture where `mrpUom !== baseUom` (e.g. base `each`, `mrpUom: "box"`,
   multiplier 5). **That coincidence is a SEVENTH §2.102 fixture trap the phase's standing note does
   not name, and it is the one that hid the money defect.** Add it to the note in §5.

**2. M6 — `pharmacy`'s ruled `grn.qc` grant is UNREACHABLE.** DD11 rules the pharmacist the QC
   signatory for drugs, but `materials.controller.ts` guards `GET /materials/grns` and
   `GET /materials/grns/:id` on `materials.grn.capture`, and `manifest.ts`'s menu entry too —
   neither of which `pharmacy` holds. A pharmacist sees no menu entry and 403s on the list. Guard
   the GRN READ routes (and, with a recorded DD16 deviation, the menu entry) on
   `materials.stock.read`, which both roles hold. Add an e2e leg proving a `grn.qc`-only actor can
   read a GRN and post its verdict.

**3. M7 — an unconvertible CEILING aborts a whole delivery with a 404.** `grn.ts`'s
   `qcContextFor` calls `mrpPerBaseUnit` outside any try/catch; it throws `unknown_uom`, which
   `materialsHttpStatus` maps to 404. F9 already fixed exactly this one level down for the line's
   own MRP ("a per-line rule must produce a per-line verdict") and the context assembler did not get
   the same treatment. **Fail CLOSED, not open**: catch it, put a flag on `QcContext`, and have rule
   7 reject the line with `mrp_unconvertible`.

**4. M8 — the error union has drifted in both directions, and the test that would have caught it
   was promised and never written.** `errors.ts:14` says *"Both directions are asserted by
   `errors.test.ts` at T8"* — **that file does not exist.** Concretely: `not_in_transit` is thrown
   only by `grn.ts` meaning "QC has not run" (a BORROWED code, which `errors.ts` forbids in as many
   words), and its intended thrower in `transfers.ts` is unreachable by construction
   (`transfer.status === "in_transit" ? "not_in_transit" : …` inside `if (status !== "in_transit")`).
   Five declared codes have ZERO throw sites: `batch_required`, `expiry_required`, `expired`,
   `mrp_below_cost`, `mrp_above_ceiling` — they are `qc.ts` `RuleCode`s, a different union, recorded
   on the line and never thrown. **Fix the `not_in_transit` ternary; give `postGrn` its own honest
   code; remove the five from `MaterialsErrorCode` (documenting that they are RuleCodes); and WRITE
   `errors.test.ts` asserting both directions by scanning the module source.** Use `/usr/bin/grep`.

**5. The remaining MINORs.** Judge each; fix or record with a reason. m3 `issueStock`'s batch
   override does not check the batch belongs to the item (corrupts the event payload only, ledger is
   safe). m4 `postGrn` does not re-check DD8 rule 8, so a batch frozen between QC and post receives
   stock that is not added to `qty_frozen`. m5 `findOrCreateBatch` keeps the first receipt's
   `landedCostPaise` on a merged pile. m6 the screens render the server's ENGLISH `message` for API
   refusals rather than a locale string — T9's acceptance asked for the locale string, and a Hindi
   user gets English (the QC *rule* codes are done correctly, all 13 keys in both locales). m7
   `postMovements`' balance read filters on `batchId` only, so it reads every store's balance of the
   touched batches — O(stores), the shape Plan 13's CLOSE/M5 fixed in `heightOf`. m8 `unknown_uom`
   maps to 404 for what are validation conflicts.

**6. `pnpm verify` detached, exit value READ FROM A FILE**, before any push. Narrow suites while
   iterating. Commit BY PATH with a message naming the findings fixed. Push. Watch CI by FULL SHA
   with `bash docs/superpowers/pipelines/ci-watch-host.sh <sha>`.

**7. RE-REVIEW — this is not optional.** The phase document's own rule: *"its MAJORs are fixed and
   the fix is REVIEWED AGAIN — a remediation is unreviewed code on the same path (09a and 13 both
   found their best defect there)."* **Plan 13 shipped its second defect INSIDE the fix for its
   first.** THE RESUME RULE (v3 §9.5, ledger §2.115): the second pass's question is SCOPE —
   *"confirm these N properties of this diff"* — so **spawn a FRESH reviewer, not a resumed one**
   (measured 4–7× cheaper with nothing verified less). Use the `Plan` subagent type: read + bash, no
   write. Give it the remediation diff and the finding list, and tell it to hunt specifically for
   defects INTRODUCED by the fixes.

**8. Finish CLOSE (§6 of the phase document).** Append: §6.7 the reviewer's report (1 CRITICAL,
   9 MAJOR, 8 MINOR — its own token count was ≈230,000 / 244,568 billed, 67 tool uses, 838s);
   §6.8 the remediation and the SECOND review; §6.9 the actuals row — **and only now**, because
   v3 §9.4 forbids writing it before the reviewer has returned. LIGHT lane: `token-audit.js` reports
   NO subagent transcripts, so subagent spend is the reviewers only; main-session cost is
   unmeasurable from inside (runbook O3) — say so rather than estimating. Append the phase to
   `docs/superpowers/pipelines/token-baselines.json`. Write the ledger lessons (§2 entries, each
   with a NAMED RULE, a specimen with real numbers, and a MECHANICAL form) and the
   EXECUTE-METHOD-V3 amendment. Run the ledger ARCHIVE pass (v3 §5). Append the CLOSED line to
   §6.6's roadmap amendment.

**9. THE DEPLOY IS THE OWNER'S, AND ONLY AFTER A CLEAN RE-REVIEW.** Do NOT run
   `docker/prod/deploy.sh` on the strength of a green suite. Ask the owner, naming: the commit SHA,
   migration **0034** (additive, 16 tables, 22 CHECKs, no data migration, no DROP), and
   **`seed:materials`** in the deploy seed chain (census 11→12). Measured read-only at close:
   production is at **34 migrations**, `to_regclass('items'/'stock_ledger'/'consignment_lots')` all
   NULL, **`operating_mode_changes` has 0 rows — the hospital has NEVER left `commissioning`**, 33
   users, 5 live sessions, newest event ~1h old. So this is a real deployment but not an operational
   act on a *working* hospital; say which it was in CLOSE. After deploying, verify
   `to_regclass('items')` etc. non-NULL and `seed-materials` idempotent ON THE LIVE BOX.

═══ THINGS THAT WILL BITE YOU, LEARNED THE HARD WAY THIS PHASE ═══

  · **`grep` here is a SHELL FUNCTION wrapping `ugrep --ignore-files`, and it SILENTLY RETURNS ZERO
    MATCHES ON UNTRACKED FILES.** It reported "zero hits" on a file containing ten. Use
    `/usr/bin/grep -a` for any evidence claim (the `-a` also defeats its "binary file matches"
    heuristic on UTF-8 box-drawing characters). This is finding F8 and it invalidates grep-as-
    evidence for anything you have not yet committed.
  · **Never write a literal control character into source.** Two NUL bytes made `ledger.ts` BINARY
    to git — no diff, no blame, no grep line numbers, on the phase's most important file (F15).
  · **Never re-serialise a JSON locale file.** `indent=2` turned a 40-line file into 1313 and
    destroyed the diff for three added keys (F16). House style is one top-level key per line.
  · **Six of this phase's sixteen findings are one defect**: a file that pins a census the task moves,
    absent from that task's Files list — `kinds.test.ts`, `seed-staff.test.ts`,
    `ist-clock-parity.test.ts`, `worker-runtime.e2e.test.ts`, `seed-cursors.test.ts`,
    `alerts-parity.test.ts` (+ `docker/prod/prometheus/alerts.yml`). Two of them had docstrings
    PREDICTING the omission. If you move a number, `/usr/bin/grep -ra` for who pins it.
  · **AGENT-RULES §1.3 forbids writing to `/tmp` absolutely, which conflicts with the harness's own
    scratchpad instruction.** One breach was committed and disclosed in §6.5. Use heredocs piped to
    `python3`/`node` with no file. **The conflict should be settled in the method** — put it to the
    owner.
  · Three of the four corrected Assertion Book rows (A4, A8, A20) share ONE new lesson: **the
    persisted state cannot distinguish the implementations at all** — a database may return either
    row for a tie, a transaction rolls back either way, a lock-less write can land on a legal
    number. What discriminates is the ERROR CODE, or nothing. That belongs in the ledger.

═══ THE REVIEWER'S FINDINGS, FOR REFERENCE ═══

CRITICAL C1 — ledger.ts lost update (FIXED, uncommitted).
MAJOR  M1 ResourceError → 500 (FIXED) · M2 dead race recovery (FIXED) · M3 payload unit mismatch
       (FIXED) · M4 ceiling pair rule (FIXED) · M5 consumptionsFor incomplete (FIXED) ·
       **M6 pharmacy grant unreachable (TODO)** · **M7 unconvertible ceiling → 404 (TODO)** ·
       **M8 error-union drift + missing errors.test.ts (TODO)** · M9 arbitrary agreement (FIXED).
MINOR  m1 NUL bytes (already fixed as F15) · m2 UTC day (FIXED) · m3 unvalidated batch override ·
       m4 post-after-recall · m5 stale landed cost · m6 English refusals on screens ·
       m7 unfiltered balance read · m8 unknown_uom→404. (m3–m8 TODO: fix or record.)

The reviewer also verified and found CORRECT: every census against the code (manifests 14,
permissions 89 = 75 + 14, deploy seeds 12, SPA routes 28, worker consumers 4, jobs 11, IST copies 10,
alerts.yml both legs); all five semantic CHECKs in the generated migration; `truncateAll` complete;
A9's ordered set lock; FEFO's ordering and filters; `recallBatch` taking no store argument; the
vendor masking in every direction including the events; DD18 held (no PO, no charge poster, no
Tally, no register); A11's append-only absence; and the four Assertion Book corrections themselves.

═══ HARD STOPS ═══

  · A reviewer CRITICAL blocks the close. Fix, re-review, only then close.
  · Never amend or force-push (rule 15). Corrections are NEW commits.
  · Never touch /opt/hmis-prod except through deploy.sh under owner authorisation.
  · Stop-loss 675,000 subagent tokens. Two reviewer passes ≈ 245k + one more. Track it.
```

---

## For whoever pastes it

The phase document is the contract; this file is only the seed. If they disagree, the phase document
wins and the disagreement is a finding.

**If the uncommitted remediation has vanished, it is recoverable.** A second lane shares this
working tree, and protocol §6 warns that another session's `git stash -u` or a broad `git add` can
sweep files that are not yours. Before handing off, the diff was written to
`/opt/hmis/.plan14-remediation.patch` (untracked, inside the only writable path). If
`git status` no longer shows the eight modified files, `git apply .plan14-remediation.patch`
restores them. If the patch is gone too, every fix is described precisely enough above to rewrite —
and C1's is four lines.

**The single most important thing in this handoff is C1.** It is a silent stock loss on a
money-adjacent read model with no reconciliation tool in the phase, and its fix is written but has
never been compiled or run. Verify it before anything else.
