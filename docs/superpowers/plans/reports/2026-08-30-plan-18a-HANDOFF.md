# PLAN 18a — FINAL HANDOFF. Radiology & Imaging core, paused at T1 of nine.

**Written 2026-08-30 by the Lane B execution session as it closes.** Self-contained: everything a
successor needs is here, and the phase document is the reference behind it, not a prerequisite.

**Verified at `dd60a4a`, which is `origin/main`.** Every number below was measured at write time, not
remembered.

---

## 1. Where the phase is, in one paragraph

Plan 18a was executed **through T1 of nine tasks**, plus the declarative half of T2. Two owner
rulings shaped it: *pause the lane* (2026-08-30, when Lane A's uncommitted work made the migration
journal un-splittable), then *land the work rather than lose it* (later the same day, once Lane A
committed `0046` and the blocker dissolved). **T1 is committed, CI-green and evidenced. T2's declared
surface is committed and UNPROVED. T3–T9 and both close-review passes have not started.** Nothing on
`main` from this lane changes any shipped behaviour.

---

## 2. What is on `main`

| commit | files | what it is | status |
|---|---|---|---|
| **`d5abf6a`** | 13 | **T1** — eleven tables, `0047_radiology_core`, the `X` accession series, two whole-row immutability triggers, `truncateAll` across three statements, both `EPISODE_SERIES` censuses at nine keys | **GREEN, 61/61** |
| **`997ab18`** | 11 | **T2, PARTIAL** — the `radiology` and `pcpndt` module skeletons: manifests, `device` kind declaration, event catalogue, two workflow definitions, the approval type, two error unions | **TYPECHECKS. NOT PROVED** |
| `2466b46` | 1 | the pause: kickoff, spike answers S1–S8, findings F1–F6, the handoff | — |
| `9b899ae` | 1 | F7 (the API quota) and a correction to this phase's own CI claim | — |
| `a57e7e4` | 1 | §9.1/§9.5/§9.9 corrected from "held" to "landed" | — |
| `dd60a4a` | 2 | **F8** — CI went green through the flake, refuting this lane's own prediction | — |

Two further commits address Lane A rather than this phase: `26d1a1b` (the coordination contract) and
`57b93fa` (the reply — F26's attribution, the `advance.test.ts` cascade, the frozen-file escalation).

**CI: `completed | success`**, run `33308463171` on `a57e7e4`, confirmed against that exact SHA.

---

## 3. THE HONESTY SECTION — what is proved, and what only compiles

**PROVED (`d5abf6a`).** Preflight `pnpm typecheck && pnpm lint` **exit 0**; then four suites
detached with the exit value read from a file: **exit 0 — 4 suites, 61 tests, 61 passed, on
`hmis_lane_b_scratch_1`**, run against Lane A's tree immediately before committing so the evidence
matches the state committed (rule 12). What those 61 actually assert:

- every CHECK refused **by Postgres and the refusal read** (the 07c pattern), not read out of
  `information_schema`;
- both triggers refusing UPDATE on nine/five named columns **and** DELETE;
- the partial slot unique refusing a second live booking **and releasing on each of `cancelled`,
  `rescheduled`, `no_show`** — both directions, because T4 A1's mutants attack both;
- `truncateAll` emptying **all eleven tables**, with one row inserted in each first, so "empty
  afterwards" is a claim about something.

**NOT PROVED (`997ab18`), and this is the single most important line in this document.** Eleven files
that typecheck and lint and have **no test of their own**. v3 §9.6's corollary applies exactly:
*uncompiled, unrun code is unknown code, however well described* — these compile, but nothing asserts
their behaviour. **Treat them as WRITTEN. Write their tests before building anything on them**;
`workflow-def.test.ts`, `kinds.test.ts` and `events.test.ts` are already named in T2's Files list.

**T1 is ROUTINE, so no mutants are owed and none were built** (AGENT-RULES §3). Said plainly rather
than a red manufactured to look like diligence.

---

## 4. Why landing this was safe — the inertness proof, measured

Both code commits are **inert**, and that is a property you can check rather than trust:

```
grep -c 'radiologyManifest\|pcpndtManifest' apps/core/src/kernel/modules/manifests.ts   → 0
apps/core/src/kernel/orders/parity.test.ts:41  asserts claimed kinds == ["lab"]
```

Neither manifest is in `ALL_MANIFESTS`; nothing imports either module's `index.ts`; and
`collectOrderKinds` / `collectResourceKinds` read the **registry**, not the directory. So `imaging` is
still an unclaimed order kind, `device` is still an unclaimed resource kind, and the permission,
manifest and role censuses have not moved by one.

**Eleven tables now exist with no writer.** That is `0044`/`0045`'s own posture — they shipped with
claimed kinds `[]` — one phase on. **The next production deploy will create eleven empty radiology
tables.** Expected, inert, and stated here so nobody meets it first in a deploy log.

---

## 5. The database, and the one irreversible act

`0047_radiology_core` is applied to **`hmis_lane_b_scratch_1` and to nothing else on this host** —
not `hmis_dev`, not `hmis_test_*`, and **not production, which is at 46 migrations** (measured
read-only against `hmis-prod-db-1`). This session made no production write; spike S6 was a read-only
`SELECT`. AGENT-RULES §6 requires that be reported rather than left implicit.

**The database is deliberately NOT dropped** — rule 7's *"say so rather than leaving it silently"*
branch, the `hmis_17a_scratch` precedent. It is the only place the migration can be inspected, and
ledger §2.137's specimen is precisely a reviewer concluding the evidence was missing because the
technique that fixes lane contention is the same one that erases the audit trail. Lane A has been
asked in writing to leave it when dropping theirs.

---

## 6. What is NOT done — the boundary, named so a successor finds a whole thing

- **The rest of T2**: installing both manifests (census 17 → **19**), the twenty permissions
  (`allPermissions` 111 → **131**), the four new roles, the README parity table, the worker install,
  the `imaging_report_ready` notification template. **None of it started.**
- **T3–T9 entirely**: placement + idempotency + the `order.placed` consumer; scheduling and the
  governed study-type definitions; check-in and the ten gates; the PCPNDT functions; acquisition;
  reports; five screens and the end-to-end proof.
- **Both close-review passes** (§9.6, §9.6.2). The whole **463,509** review term of the 736,000
  stop-loss is unspent.
- **No full `pnpm verify` by this lane**, deliberately — see F8 in §9.

---

## 7. RESUME CHECKLIST — in this order

1. **Re-run the pre-flight and re-measure all 20 rows of §2.** Every one. Lane A has landed many
   commits; `lab` claims an order kind now; rows 2, 3, 4, 8, 9 and 11 have all moved.
2. **The migration number is SETTLED.** `0047` is pushed; nothing to renumber, nothing held. The next
   migration this phase needs takes whatever is free *then*, measured immediately before **and after**
   `db:generate` (protocol §7).
3. **Re-answer spike S8 — its answer has already flipped TWICE.** Current truth, measured:
   `recordPhiAccess` on `kernel/orders/read.ts` with surface `orders.patient` **exists**, landed by
   **Lane A in `39beff0`** (counted 0 at `9ba2482`, `6bd3016`, `697ebfd` and `dd6f869`; 5 at
   `39beff0`). **REUSE it. Write no second call.** Append only `imaging.worklist`, `imaging.study`,
   `imaging.report`, `pcpndt.form_f` to `PhiSurface`.
4. **Write T2's tests** (§3). This comes before new code.
5. **Re-run T1's four suites** before building on them — a green is a claim about a tree that has
   since changed. Name the database in every commit message (§2.137).
6. **Then T2's censuses, with BOTH greps** (§2.131 / §2.138): `grep -rn "otManifest" apps/core
   --include=*.ts` for the places that NAME a manifest, and `grep -rn "ALL_MANIFESTS" apps/core
   --include=*.ts` for the places that COUNT them. Directory and glob, never a file list. Lane A's own
   close reports three derived censuses that its Files lists missed, one of which left `main` red for
   forty minutes.

---

## 8. Decisions already made that the resume must honour

| # | decision | why it is not re-openable cheaply |
|---|---|---|
| S4 | **The doctor role in this repository is `doctor`, not `consultant`** | The phase document's T2 text names a role key that does not exist. All four radiology roles are DECLARED by T2, not granted |
| S6 | **`seed-radiology.ts` must find-or-create its own tariff services**, `category: 'investigation'` | Production has six services in three categories and **no imaging service at all**; `advised_tests` is empty in all 13 encounters. A new category keys a new `gst_config` row — a CA sign-off, i.e. money, i.e. routed not invented |
| S1 | `phi_access_log.surface` carries **no CHECK** | The `PhiSurface` widening is a type edit alone; no migration line |
| S3 | `assignResource` already refuses a `down`/`qa_blocked`/`maintenance`/`retired`/`in_use` device | G2 at acquisition start costs T7 no code. Scheduling still needs its own check — booking Thursday assigns nothing today |
| S5 | The second-factor window is `cfg.secondFactorWindowMinutes` (**default 5**) | One existing caller, `guards.ts:117`. Inventing a second window is §2.54's class |
| §4.1 vs DD5 | The slot predicate **includes `no_show`** | The machine is idle whether the patient cancelled or simply did not come. Both freeing statuses proved by execution |
| M4 | **`dose_manual` is a provenance flag and does not excuse the number** | A machine with no dose SR is the case M4 exists for. An acquired ionising study with every dose field null is refused either way |
| Triggers | **Whole-row freeze minus a named pair**, not an enumerated column list | `0045` had to exist because `0044`'s list was incomplete. Inverting it means a column a later migration adds is frozen by default, and the "trigger omits `body`" mutants cannot be written by omission |

---

## 9. Findings, in brief

| # | finding |
|---|---|
| **F1** | `registerOpdEncounterResolver` read `opd_encounters.id` (a ULID) for a `V…` visit number, so `placeOrder` could resolve no real OPD visit. Masked for six phases because every suite that reaches the seam registers its own fake resolver. **Found by 18a's spike; FIXED BY LANE A in `d1f316b`**, proved red-before/green-after |
| **F2** | The T1 suite caught two defects **in itself**: a bogus `status` tripped `recorded_shape_ck` before `status_ck` (Postgres does not promise which of two violated CHECKs it reports), and the trigger correctly **permits a no-op UPDATE**. Both now assertions in their own right; both established at the database, along with the fact that a BEFORE ROW trigger runs ahead of FK checking |
| **F3** | Production has no imaging service and empty `advised_tests` — changes T4 (§8) |
| **F4** | None of the four roles exists; the doctor role is `doctor` — changes T2 (§8) |
| **F5** | §4.1 and DD5 disagree by one word on the slot predicate; §4.1 wins (§8) |
| **F6** | The lane collision — §10 |
| **F7** | The unauthenticated GitHub API quota is **60/hour per HOST**, shared by both lanes. This lane exhausted it polling for a CI verdict and got none. Poll ≤ once a minute, run ONE watcher, and treat an empty `workflow_runs` as *"ask again later"* — a rate-limit refusal and a genuinely absent run are indistinguishable at the shape level |
| **F8** | **This lane predicted CI would go red on `advance.test.ts`. It went green.** The four failures are a function of the HOST and the LOAD, not the file: they fail during a full parallel verify on the build box with a second lane active, pass 26/26 isolated on the same box, and pass on GitHub's runner. What is broken is the **local verify as an instrument**, not CI |

---

## 10. The two method findings worth carrying to the ledger

**(a) Two lanes in one checkout fail on the artefacts that CANNOT BE SPLIT, not on the files the
protocol names.** Protocol §4 gives a sound rule for a census or a truncate list — *"stage only your
hunks by path"* — and it works. It cannot work for `drizzle/meta/_journal.json`: committing this
lane's `0047` row while Lane A's `0046` sat uncommitted meant either orphaning theirs (red `main`,
broken deploy) or committing their migration for them. No third option exists at the diff level, and
no amount of care produces one.

Worse, *"whoever lands second pulls and re-reads"* assumes **the first lane LANDS**. Lane A correctly
ran T1→T2→T3 behind one batched verify — exactly what v3 §9.9 rule 4 instructs — so for ninety
minutes there was nothing to pull and a growing set of untouchable files. **§9.9 rule 4 and protocol
§4 are in direct tension and neither says so.**

> **The fix, and it is cheap: a lane that shares a checkout commits its MIGRATION as soon as it is
> green, ahead of the batch it belongs to.** Everything else in a batch can wait; the journal is the
> one artefact the other lane cannot work around.

**(b) A red on the build host and a red in CI are two different claims, and neither implies the
other.** §2.55 is the case where a green local verify hid a red CI. F8 is the same coin's other face:
a local red that CI does not share. This lane asserted the stronger claim before the evidence existed
and was refuted forty minutes later. **Name the box.**

---

## 11. Pointers

- **The phase document** — [`../2026-08-29-phase1-18a-radiology-core.md`](../2026-08-29-phase1-18a-radiology-core.md).
  §9.0 kickoff, §9.3 the eight spike answers in full, §9.2 the findings, §9.4 the Assertion Book as
  corrected by execution, §9.5 mechanical verification, §9.9 the in-document handoff.
- **The EXECUTE-PROMPT** — [`../2026-08-29-phase1-18a-radiology-core-EXECUTE-PROMPT.md`](../2026-08-29-phase1-18a-radiology-core-EXECUTE-PROMPT.md).
  Still the seed for a resuming session; §2's kickoff block and §4's lane rules both still apply.
- **Lane coordination** — [`2026-08-30-lane-b-held-coordination.md`](2026-08-30-lane-b-held-coordination.md)
  and [`2026-08-30-lane-b-reply-to-lane-a.md`](2026-08-30-lane-b-reply-to-lane-a.md). Read §6 of the
  reply, which amends its own §3.
- **The inherited contract** — phase 0's §6/§6A/§8 in
  [`../2026-08-29-phase1-17-order-envelope.md`](../2026-08-29-phase1-17-order-envelope.md), and this
  phase's own §6 (what 18b, 18c, 62, 63, 64, 26 and 22c-F inherit) and §8 (what it freezes).
