# LANE COORDINATION — Lane B (18a radiology) is PAUSED and HOLDING WORK IN THE SHARED TREE

**Written 2026-08-30 07:55 UTC by the Lane B execution session, addressed to LANE A (Plan 17 →
17a/17b) as the ACTIVE lane in `/opt/hmis`.** Read this before your next `git add`.

**The one-line version:** Lane B executed Plan 18a through T1, was paused by an owner ruling, and is
**holding a migration and eleven tables UNCOMMITTED in the working tree you are using.** Nothing here
asks you to change your plan. It asks for three things — don't stage Lane B's files, take `0048` for
your next migration, and read §5, which is a defect in shipped code that affects **your** lab desk
today, not Lane B's radiology module tomorrow.

Supersedes nothing. Sits beside [`2026-08-26-parallel-session-protocol.md`](2026-08-26-parallel-session-protocol.md)
and is the concrete instance of its §6 and §7.

---

## 1. The three hard rules

**RULE 1 — NEVER `git add -A`, `git add <directory>`, or `git commit -a`.** Stage by explicit path,
always, and run `git status --porcelain` and READ IT first. Seven tracked files in this checkout
carry Lane B's uncommitted hunks (§3). A blanket stage silently commits another plan's schema,
another plan's migration journal entry, and eleven tables nobody reviewed, under your commit message.

**RULE 2 — YOUR NEXT MIGRATION IS `0048`.** Measured 2026-08-30 07:52 UTC:
`_journal.json` carries **48 entries, last `0047_radiology_core`** — Lane B's, generated and held.
`0046_lab_core` is yours and is committed; `0047` is taken in the working tree but NOT in git.

> **This is the trap that stopped Lane B, so it is worth stating from the other side.**
> `drizzle/meta/_journal.json` **cannot be split by hunk.** Its diff today is one entry — Lane B's
> `0047`. If you generate `0048`, your journal diff becomes TWO entries, and committing it means
> either carrying Lane B's `0047` row (whose `.sql` you would not be committing → **`origin/main`
> goes red and the next production deploy breaks**) or not committing a coherent journal at all.
>
> **So before you run `db:generate`, ask Lane B's holder to either land `0047` or park it out of the
> tree.** Do not work around it by hand-editing the journal (AGENT-RULES §6 forbids it outright).
> Re-check `_journal.json` immediately before AND after generating, either way (protocol §7).

**RULE 3 — TAKE YOUR OWN TEST DATABASE AND NAME IT.** `TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_17a_scratch"`
(or whatever you are already using) — v3 §9.9 rule 8. **Do not drop `hmis_lane_b_scratch_1`.** It is
the only database on this host where `0047` is applied, and it is deliberately retained as the
inspectable evidence behind Lane B's `exit 0` (ledger §2.137: the technique that fixes contention is
the same one that erases your audit trail).

---

## 2. What is committed vs. what is held

| | |
|---|---|
| **Committed and pushed** | `2466b46`, `9b899ae` — **the 18a phase document only. No code.** |
| **Held uncommitted** | one migration, eleven tables, two modules — everything in §3 |

Lane B is paused by owner ruling and will not touch this tree again until Plan 17 is closed and
pushed. **You are the only lane working.** The held files are inert: they typecheck, their suites
pass, and they claim no order kind, so they change no behaviour of yours.

---

## 3. The exact inventory Lane B holds — do not stage, revert, stash or tidy any of it

**Untracked (safe to ignore entirely; they are complete files, not scratch):**

```
apps/core/drizzle/0047_radiology_core.sql
apps/core/drizzle/meta/0047_snapshot.json
apps/core/src/kernel/db/schema/radiology.ts        (+ radiology.test.ts)
apps/core/src/kernel/db/schema/pcpndt.ts           (+ pcpndt.test.ts)
apps/core/src/modules/radiology/                   (7 files)
apps/core/src/modules/pcpndt/                      (4 files)
```

**Modified — these are the dangerous ones, because they are files you also edit:**

| file | Lane B's hunk | what you must do |
|---|---|---|
| `apps/core/drizzle/meta/_journal.json` | one entry: `idx 47`, `0047_radiology_core` | **RULE 2.** Do not commit this file until `0047` is resolved |
| `apps/core/test/helpers/db.ts` | eleven table names across three `truncate` statements, plus two new statements | If you append here, your `git diff` will show Lane B's hunks too. **Do not commit the file** — ask first |
| `apps/core/src/kernel/db/schema/index.ts` | `export * from "./radiology"; export * from "./pcpndt";` | same |
| `apps/core/src/kernel/episodes/series.ts` | `imaging_study: "X"` (the accession series) | same |
| `apps/core/src/kernel/db/schema/episodes.ts` | the `series_key` reading-aid comment | same |
| `apps/core/src/kernel/episodes/series.test.ts` | census moved to **nine** keys | **If your suite goes red on an eight-key census, this is why — it is not your bug** |
| `apps/core/src/kernel/orders/parity.test.ts` | same nine-key census + a comment | same |

**Not Lane B's and not yours either:** `.ci-watch.log`, `.g.log`, `.g.exit`, `.full.log`,
`docs/design/`, `2026-08-29-EXECUTE-PROMPT-flow3-front-desk.md`. Rule 8 — never infer from mtimes
who did what.

**If you genuinely need to commit one of the seven:** say so rather than working around it. The
correct resolution is for Lane B's holder to land `0047` first, not for you to stage someone else's
hunks or to revert them.

---

## 4. The shared seams — who takes what, when Lane B resumes

None of this blocks you. It is here so you do not have to guess, and so Lane B can measure rather
than remember when it comes back.

| seam | rule already agreed by both plans |
|---|---|
| `kernel/orders/read.ts` `recordPhiAccess` | **First lane to land writes the call**, surface string `orders.patient`. The other REUSES it. If you have landed it, Lane B appends only its own `PhiSurface` names and writes no second call (§2.54) |
| `kernel/phi/audit.ts` `PhiSurface` | Lane A appends `lab.results`, `lab.report`. **Lane B will append `imaging.worklist`, `imaging.study`, `imaging.report`, `pcpndt.form_f`.** Please do not add the `imaging.*`/`pcpndt.*` names — they arrive with their callers |
| `kernel/orders/parity.test.ts` claimed kinds | `[]` → `['lab']` (yours) → `['imaging','lab']` when 18a T2 lands. Whoever is second re-measures and does not assume |
| `kernel/resources/kinds.ts` claimants | you claim `bench`/`analyzer`; **Lane B claims `device`** and declares its vocabulary for the whole house. `collectResourceKinds` refuses a second claimant at boot |
| `kernel/modules/manifests.ts` | Lane B appends **two** (`pcpndt` then `radiology`), 17 → 19 |
| `seed-roles.ts` + `seed-roles.test.ts` + README | Lane B adds **20 permissions and 4 roles**. Grep the LIST (`ALL_MANIFESTS`), not just a sibling — §2.138, and your own 17a close reports three derived censuses that a Files list missed |
| `EPISODE_SERIES` | Lane B added `imaging_study: "X"`. `L`/`S` are yours and untouched |
| `addOrderItem` | **Neither lane writes it.** Your DD9 and 18a's DD10c agree: an add-on is a NEW order in the same `order_group_id`. Phase 0 §6A.5 is closed that way for both |

---

## 5. A DEFECT IN SHIPPED CODE THAT AFFECTS **YOUR** LAB DESK, NOT LANE B'S RADIOLOGY

This is the part of the document that is for you rather than about Lane B. It was found by 18a's
kickoff spike, it is not Lane B's to fix under its own frozen-surface rules, and **17a T4 has already
shipped the caller that trips it.**

**`registerOpdEncounterResolver` cannot resolve any real `V…` visit number.**

`apps/core/src/modules/opd/opd.module.ts:59` registers the resolver under prefix
`EPISODE_SERIES.visit` (`"V"`), so `resolveEncounterByPrefix` hands it a visit NUMBER. It then calls:

```ts
const encounter = await getEncounter(db, encounterId);   // encounters.ts:132
```

and `getEncounter` is `where(eq(opdEncounters.id, id))`. **`opd_encounters.id` is a `newId()` ULID**
(`encounters.ts:77`); the visit number lives in `visit_no`. Nothing in `apps/core/src` reads that
table by visit number — `grep -rn 'opdEncounters.visitNo' apps/core/src` returns one hit, in
`desk-provider.ts`, as a SELECT projection.

So for a real `V2608290001`, `resolveEncounterByPrefix` returns `{matched: true, resolved: null}`,
and `placeOrder` refuses **`unknown_encounter`**.

**Why no suite has ever caught it, in either lane:**

- phase 0's four order suites each register their own fake `V` resolver
  (`place.test.ts:79`, `advance.test.ts:64`, `read.test.ts:74`, `envelope.e2e.test.ts:78`);
- **your `test/helpers/lab.ts:176` does the same** — it registers a resolver mapping the literal
  `"V2608290001"` to a patient, so `desk.test.ts` and every suite built on `seedLabDeskBase` runs
  against a synthetic resolver and never reaches `registerOpdEncounterResolver`;
- `duplicates.test.ts:51` registers its own as well;
- billing never reaches it either: billing passes bare row ids, which match no prefix and fall
  through to its own private OPD fallback.

**The OT's resolver, one file over, is correct** — `ot.module.ts:46` reads
`daycareEncounters.encounterNo`. So this is a divergence between two implementations of one seam,
not a design decision.

**What it means for 17a.** `lab/desk.ts:317` passes a caller-supplied `input.encounterNo` straight
into `placeOrder`. In production, a lab order placed on a real OPD visit gets `unknown_encounter` at
the counter. Nothing in your phase can see it, because your fixture supplies the resolver.

**Lane B did not fix it** — `modules/opd/*` is frozen by 18a's EXECUTE-PROMPT beyond one export, so
it was reported rather than taken. **It is yours if you want it**, and the fix is one line (resolve by
`visitNo`). Two notes if you take it: prove it by EXECUTION first — register the REAL
`registerOpdEncounterResolver`, create a real encounter, and call `resolveEncounterByPrefix` with its
`visit_no`, so the red is a fact and not a reading; and that red run is the regression test.

---

## 6. The CI quota is per HOST, and both lanes spend from it

`ci-watch-host.sh` works because the repo is public and the unauthenticated API answers over plain
`curl`. That budget is **60 calls an hour for the whole box**, not per session.

**Lane B exhausted it at 07:43 UTC on 2026-08-30** — `remaining: 0` — by over-polling for a docs
commit's verdict and briefly running two watchers. It reset at **08:04 UTC**. If your `ci-watch`
returned nothing or an empty `workflow_runs` array in that window, **that was Lane B's doing and not
a verdict about your build.** Apologies — it is recorded as finding F7 in 18a's §9.2.

Two things follow, and the second is the one that bites:

- poll no faster than once a minute and run exactly ONE watcher (a 20-second loop alone is 180
  calls/hour, three times the ceiling);
- **an empty `workflow_runs` array and a rate-limit refusal are indistinguishable at the shape
  level.** Treat `none` as *"ask again later"*, never as *"no run exists"*.

---

## 7. What Lane B will do on resume, so you can predict it

Only after Plan 17 is **closed and pushed**, and starting with re-measurement rather than memory:

1. re-run the pre-flight and re-measure all 20 ground-truth rows;
2. re-check the migration number and renumber `0047` if you have taken it (rename the `.sql`, rename
   the snapshot, retag the journal — never the one already pushed);
3. **re-answer the S8 spike** — whether Lane A has landed the PHI call. Its answer already flipped
   once inside a single session;
4. re-run T1's four suites before trusting them, naming the database;
5. then T2's censuses — manifests, permissions, roles, README — with BOTH greps.

The full detail is [`../2026-08-29-phase1-18a-radiology-core.md`](../2026-08-29-phase1-18a-radiology-core.md)
**§9.9**. This document is the coordination subset of it.

---

## 8. The method finding both lanes paid for

**Two lanes in one checkout do not fail on the files the protocol names. They fail on the ARTEFACTS
THAT CANNOT BE SPLIT.**

Protocol §4 gives a sound rule for a census or a truncate list — *"stage only your hunks by path"* —
and it works. It cannot work for `drizzle/meta/_journal.json`, and that one file is what stopped
Lane B outright.

Worse, the protocol's *"whoever lands second pulls and re-reads"* assumes **the first lane LANDS**.
Lane A correctly ran T1→T2→T3 behind a single batched verify, which is exactly what
[`../../EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md) §9.9 rule 4 instructs — so for ninety
minutes there was nothing to pull and a growing set of files nobody could touch. **§9.9 rule 4 and
protocol §4 are in direct tension and neither says so.**

**The cheap fix, for whoever runs the next parallel fork:** a lane that shares a checkout **commits
its MIGRATION as soon as it is green, ahead of the batch it belongs to.** Everything else in a batch
can wait; the journal is the one artefact the other lane cannot work around.
