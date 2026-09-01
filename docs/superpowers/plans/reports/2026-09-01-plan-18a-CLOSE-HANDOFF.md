# Plan 18a (Radiology & Imaging core) — HANDOFF AT THE CLOSE BOUNDARY

**Written 2026-09-01 by the session that executed T5 through T9 and the close. Everything below is
measured or quoted; nothing is remembered.**

**Read this file in full. Then read the phase document's §9.2 (findings) and §6 (the CONTRACT).
You do NOT need §0–§5 — every task is done and this file names the decisions the remaining work
depends on.**

Phase document: `docs/superpowers/plans/2026-08-29-phase1-18a-radiology-core.md`
Previous handoff (superseded, kept for history): `reports/2026-08-31-plan-18a-T5-HANDOFF.md`

---

## 0. THE ONE-PARAGRAPH STATE

**ALL NINE TASKS ARE DONE, PROVED AND PUSHED. The tip is `ec0aa8a`.** The module places imaging
orders, applies the PCPNDT rule, creates studies, runs a diary, opens and clears ten safety gates,
holds a statutory register with gap-free Form F serials, acquires with a dose and contrast under a
registered machine and person, writes immutable versioned reports signed under a fresh second
factor, publishes without waiting for the cashier, and serves five screens. **A full workspace pass
has been run and recorded.** Nothing is deployed; production has never seen this code.

**THE ONE THING LEFT IS THE INDEPENDENT CLOSE REVIEW — §9.6 and §9.6.2, both FRESH, both owed.**
`§9.7`'s actuals wait on it by rule (v3 §9.4). **That is your task. Do not start new feature work.**

---

## 1. WHAT IS ON `main` — this phase's commits, in order

| commit | what |
|---|---|
| `d5abf6a` | T1 — eleven tables, `0047_radiology_core`, the `X` accession series, two immutability triggers |
| `997ab18` `e9c425c` | T2 — both manifests installed, 20 permissions, 4 roles |
| `74e3079` | T3 — placement, the PCPNDT applicability rule, the `order.placed` consumer |
| `a407719` `620b7c1` | T4 — the governed study-type book, 20 seeds, the diary; owner ruled the seed SELF-PUBLISHES |
| **`835ca2a`** | **T5** — check-in, the ten gates, waive/override, readiness |
| **`f449f70`** | **T6** — the `pcpndt` register **and migration `0050`** |
| **`6908d13`** | **T7** — acquisition, DD12a's four authorisations, the bill-decision queue |
| **`52b4810`** | **T8** — reports: versions, signature, lockout, publication, criticals, the three reads |
| **`2e848d8`** | **T9** — five screens, two nav entries, route census 39→44, the END-TO-END PROOF |
| **`ed754cc`** | **§6 CONFIRMED** — and it found F39 and F40, two contract violations in this phase's own code |
| **`ec0aa8a`** | **the close** — the full verify's one real red (F44) and three defects a reading pass found |

Commits from OTHER LANES are interleaved throughout (`RC-1`, `RC-2`, `RC-3`, `VD-1`). See §6 below.

---

## 2. THE EVIDENCE, AND EXACTLY HOW MUCH IT IS WORTH

### The full workspace pass — RUN, RECORDED, and one real red

`hmis_18a_verify` (its own database, so nothing could contend), §2.151's sequential capped form,
HEAD `ed754cc`, 16:05 → 16:49 on 2026-09-01:

| half | result |
|---|---|
| `apps/core` | **3 314 passed / 3 315** · 338 suites passed, 9 failed |
| `apps/web` | **67 files / 404 tests**, exit 0 |
| `@hmis/contracts` | 4 suites / 21 tests, exit 0 |
| contention census | **`Exceeded timeout` 0 · `deadlock` 0 · `SIGKILL` 0 · `duplicate key` 0** |

**Eight of the nine failing suites were ONE compile error in `modules/opd/config.ts`** — the VD-1
lane's vitals work, mid-edit in the shared checkout. `radiology/reports.test.ts` was among the eight
and **failed to RUN, not to assert**. **The one genuine red was F44 and it was this lane's; it is
fixed in `ec0aa8a`.** The zero contention census is what makes that attribution checkable.

**THIS PASS PREDATES `ec0aa8a`.** The close commit changed `read.ts` and one controller comment. The
affected suites were re-run green (`roles-catalog.e2e`, `radiology/read`, `radiology.e2e` — 3 suites
/ 17 tests) but **a full pass over the FINAL tip has not been observed.** Running one is a
reasonable first act; see §5 for the command and the etiquette.

### Targeted evidence, all on `hmis_lane_b_scratch` unless noted

- radiology + pcpndt: **23 suites / 311 tests**
- radiology + pcpndt + e2e + four censuses: **28 suites / 343 tests**
- **THIRTY MUTANTS across T5–T8. Twenty-eight died as the plan states them; TWO (T7 A1, A2) SURVIVED
  and their atomicity-breaking replacements died.** Per-mutant expected-vs-received is in §9.5-T5
  through §9.5-T9.

---

## 3. WHAT THE CLOSE REVIEW MUST DO

**Two passes, both FRESH** (a reviewer that is not the author). §9.6 is over the whole phase; §9.6.2
is over the remediation diff only, after pass 1's fixes land.

**Ledger §2.115 applies: resume a reviewer for MEMORY, spawn FRESH for SCOPE.**

### The five places this phase is most likely to be wrong, ranked

1. **`gates.ts` (930 lines) — the ten per-kind satisfaction rules.** Each was written to be COMPUTED
   rather than asserted, and four deviate from the plan's evidence sketch in the strengthening
   direction (F20). A reviewer should ask of each kind: *what input makes this gate a lie?*
2. **`reports.ts` — the version chain.** Every act inserts; nothing is edited. Check that no path
   can leave a study with zero signed reports, and that `amendReport`'s supersede-then-insert is
   atomic under concurrency (`reports.concurrency.test.ts` asserts it, with a held transaction).
3. **`acquisition.ts` — the order of operations.** §5 T7 states the sequence and F39 proved one step
   was in the wrong place for a week. Re-read the sequence against the code, not against the tests.
4. **`money.ts` `authorisationOf`** — four answers, a precedence that is a RULING (`stat` is last on
   purpose), and I1's harm behind it.
5. **`read.ts` — the two confidentiality rules.** RESTRICTED is a hold-out; CONFIDENTIAL is a
   rename. A reviewer should confirm they are never conflated (A8's mutant is exactly that).

### The method lesson this phase's close earned — USE IT

**READING BEAT TESTING, decisively.** Six defects were found AFTER the suite was green and **not one
had a failing test**, under 3 315 passing tests and thirty dead mutants:

- **F39 and F40** — by reading §6's CONTRACT clause by clause against the shipped code. **Ten
  minutes.** One had the envelope item completing at acquisition instead of publish (a doctor's
  order reading DONE while the study sat unread); the other had the second-factor window
  re-implemented alongside the kernel's, so route and function could disagree about one signature.
- **F42, F43, F44** — by reading the diff.

**Do the CONTRACT pass first.** It is the cheapest high-yield review instrument this phase found.

---

## 4. FINDINGS OPEN, EACH WITH ITS OWNER

**These are the close review's to rule on. None is fixed.**

- **F19 — the `open → satisfied` gate edge names FOUR roles and the permission model grants ONE.**
  `radiologist` and `doctor` are on the workflow edge; only `radiographer` holds
  `radiology.gates.satisfy`, so the other two are dead over HTTP. Fails SAFE. Both planes are PINNED
  against each other in `gates.test.ts`, so a change to either trips. **Ruling needed:** grant the
  permission, or take the names off the edge.
- **F24 — nothing ever writes `rescheduled`.** The terminal state, both its transitions, and one of
  the three names in `imaging_studies_slot_ux`'s predicate are unreachable. Three documents state a
  design `rescheduleStudy` does not implement (it rewrites `scheduled_at` in place), so DD5's audit
  answer — *"when was this moved, off what slot"* — does not exist.
- **F35 — nothing ever writes `amended`.** F24's shape, smaller: no control depends on it.
- **F41 — both error unions lack a "you lack this permission" code**, and five call sites improvised
  one. The worst is `unknown_study` (**404**) for an authorisation failure in `read.ts`; it escapes
  notice only because the controller guard answers 403 first. `errors.ts` says REPORT rather than
  borrow, which is why it is here. **The ask is two codes per union:** an `already_terminal`-shaped
  one and a `forbidden`-shaped one.
- **F18 is CLOSED** (T7 writes `ionising`), **F13, F9, F15, F16, F17, F25, F28, F39, F40, F42, F43,
  F44 are all closed.** F30, F33, F34, F36, F37, F38, F26, F27 are recorded lessons, not open work.

### Owed before go-live, not before close

- **A `pregnancy_policy` seed.** The kind has a published zod schema and NO seed. `gates.ts` ships
  `DEFAULT_PREGNANCY_POLICY` at the strict end of every field, and `checkIn` reports
  `policySource: 'default' | 'published'`. Until a hospital publishes one, every hospital runs the
  default — correct, but not a decision anybody has taken.
- **A human must enter the real §19 PCPNDT registration.** The module refuses every applicable scan
  until one exists. That is the correct posture and it is a SECOND-HUMAN blocker, the same class
  that holds Plan 17b.

---

## 5. THE ONE THING THAT WILL BITE YOU IF YOU SKIP IT

### Migration `0050` is NOT OPTIONAL (F25)

`0047`'s Form F trigger compared WHOLE ROWS minus `verified_by`/`verified_at`, so **no column could
change after INSERT** — meaning a Form F could never go `open → recorded`, and therefore **no
PCPNDT-applicable scan could ever be acquired.** A legally mandated register that could not be
completed. Proved at the database before a line of `form-f.ts` existed.

`0050` permits **exactly one** transition and widens nothing: the serial, machine, study and patient
stay frozen from INSERT and across the completion; a recorded form cannot be reopened; DELETE stays
refused; `verified_by`/`verified_at` remain the only columns a recorded row may ever change.

**It is outside T6's Files list and is disclosed as such.** The alternative was a CHAIN HALT, which
was rejected because the defect makes T6 **through T9** unbuildable rather than merely wrong.

**Any scratch database predating `f449f70` will not have the fixed trigger until it re-migrates.**

---

## 6. THE CHECKOUT IS SHARED — READ THIS BEFORE RUNNING OR COMMITTING ANYTHING

Four other lanes worked in `/opt/hmis` alongside this one on 2026-09-01 (RC-1, RC-2, RC-3, VD-1).
**This cost more clock than any coding problem in the phase.**

### Committing — §2.152, learned the hard way twice

`git commit` commits the **INDEX**, and on a shared checkout the index is shared too. Staging by
path is **NOT** enough — a peer lane's bare `git commit` swept 54 lines of this lane's staged work
into their commit. **Do BOTH:**

```
git diff --cached --stat          # READ IT against your own Files list, every time
git commit -m "…" -- <your paths> # a pathspec commits ONLY those paths
```

Then **read the commit's own stat line against the size of what you wrote.** A 4× insertion count is
the tree telling you whose work you just took. This session caught `.rc1-ci-t5.log` that way.

### Running tests — §2.151 (owner ruling, `42e7efc`)

`apps/core/jest.config.cjs` now carries `maxWorkers: 2`, so **do not hand-cap**. But `pnpm test` is
`pnpm -r test` with no `workspace-concurrency`, which runs core's jest pool and web's vitest pool
**at the same time**. A bare `pnpm verify` still OOMs this 8-core/15.6 GB box.

```
# the SAFE form — sequential halves, its OWN database so nothing contends
TEST_DATABASE_URL="postgres://hmis:hmis@localhost:5433/hmis_18a_review" \
  pnpm --filter @hmis/core exec jest --passWithNoTests
pnpm --filter @hmis/web exec vitest run
pnpm --filter @hmis/contracts test
```

**Coordinate the slot by message before starting.** Use `ListAgents`, then `SendMessage`. Peers on
2026-09-01 were `hmis-75` (RC-1, closed), `hmis-62` (RC-2, closed) and `hmis-63` (VD-1).

### Reading a red — the shape rule

**A full-suite red whose failures are `Exceeded timeout … for a HOOK` in `setupTestDb` plus cascades
(`teardown is not a function`, `pg_type_typname_nsp_index`, `users_username_ux`) and which contains
ZERO assertion diffs is the RUNNER, not the tree.** Count `grep -c "Received:"` before believing any
of it. **This fires in GitHub CI too**: run `33436302396` came back red at 117 minutes with 126
suites and 846 hook timeouts, and the same code passed in the capped sequential form.

**And check the calendar (F28).** A suite red today and green yesterday with no diff between is a
calendar bomb until proved otherwise — re-run with the clock moved before eliminating anything else.
`test/helpers/radiology.ts` had one: it spaced placements in FICTIONAL time and stamped rows with
the REAL clock, and it took out five suites across two lanes on the morning the wall clock crossed
its threshold.

---

## 7. THE THREE METHOD LESSONS WORTH MORE THAN THE CODE

1. **F28 — a test that mixes a fictional clock for its assertions with the real clock for its rows
   is not deterministic; it is merely not failing yet.** It fails on whoever runs it next, not on
   whoever wrote it.
2. **F33 — a PRE-READ in front of the control, not CAS-versus-index, is what decides whether a race
   test needs a held transaction.** T4's slot race has no pre-read and needs none; T5's gate CAS and
   T8's amend both do. T8's two races sit in ONE file, unheld and held, as the worked contrast.
3. **F30 — a mutant that reorders two writes inside one transaction tests nothing**, because the
   rollback is the control rather than the order. To discriminate an ordering assertion, one write
   must ESCAPE the transaction.

Also: **F44 — in a repository that polices itself with text censuses, a doc comment is executable.**
A comment quoting `@RequirePermission(...)` verbatim IS a decorator to `roles-catalog.e2e`.

---

## 8. WHAT THIS PHASE DELIBERATELY DID NOT BUILD

Named so a successor finds a whole thing rather than a gap (§6.9, and T9's own note):

- **No PACS / DICOM / MWL / viewer** — 18b. `study_instance_uid` and `image_source` are reserved.
- **No dose register / TLD / AERB / QA workflow** — 18c. The five dose columns are written here.
- **No contrast-reaction chain, portable flow, teleradiology, release desk, emergency clocks, KPIs,
  prep messaging or scheduler job** — 18a-iii.
- **No return compiler, inspection persona, certified print or registration-expiry lift** — 18a-ii.
- **The SCREENS ARE THIN.** A device diary, a bill-decision queue screen, an amend form, a
  critical-acknowledgement screen and a template picker all have ROUTES and API functions and **no
  screen**. Stated in T9's findings rather than hidden.

---

## 9. THE ONE SENTENCE THIS SESSION WOULD LEAVE YOU WITH

**Six defects survived 3 315 passing tests and thirty dead mutants, and every one of them was found
by READING — two by comparing the CONTRACT to the code clause by clause, four by reading the diff.
Start your review there, not with the test suite.**
