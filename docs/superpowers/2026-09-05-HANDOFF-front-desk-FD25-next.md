# FD-25 → next session: what is built, what is owed, and where the traps are

> **SUPERSEDED 2026-09-05, later the same day, by
> `2026-09-05-CLOSE-front-desk-FD25-backlog.md`.** Its three steps were executed: main is merged
> (the census re-measured at `modelPairs` **307**, cashier index 7 at **13**), seven of the eight
> §3 backlog findings are fixed, and **§5's readiness question is ANSWERED — the owner ruled #92
> may be marked ready once the backlog is fixed.** §3's list and §5's open decisions are stale;
> read the close doc's §5 and §6 instead. What is still accurate here: §4's census method, §6's
> environment notes and the traps at the end of §6.


**Written** 2026-09-05, at the end of the session that built it.
**Branch** `lane/front-desk-fd25` @ `9716776` · 33 ahead of `origin/main`, 7 behind · 83 files, +11,020/−1,392
**PR** #92, **DRAFT** — deliberately, see §5 · **all four CI checks green on both twins**
**Deployed?** No. Nothing in this branch has ever run in production.

---

## 1 · What is built

Six production front-desk screens, each built to the signed-off artboards, each carrying a working
AI co-pilot, each opened in a real browser against the real API before being called done.

| Screen | Route | Shape of the work |
|---|---|---|
| Registration clerk | `/registration` | new screen (~1,100 lines) + route + census |
| Appointment clerk | `/appointment` | new screen + `appointment-view.ts` + slot board |
| Cashier | `/billing` | view rewritten on the design system; data layer untouched |
| Vitals nurse (Bay One) | `/opd/vitals` | re-skin — logic, hooks and exported helpers kept wholesale |
| Doctor + voice scribe | `/opd/consult` | the worst file in the tree: 4 shadcn imports + ~131 Tailwind sites → **0** |
| Back office | `/admin/users`, `/opd/admin`, `/staff`, `/my-day` | 1,392 lines, 6 shadcn imports, 131 Tailwind sites → **0** |

Plus FD-24's printing work underneath it (the outbox, the relay, the three documents, migration 0069).

**The four owner rulings, all implemented:** voice scribe ships against the inert `POST
/speech/transcribe` (503 until a DPIA revision) · `/counter` keeps working and left the nav (row
removed, route serves, command palette still finds it by name) · cashier granted `patients.read` +
`tariff.read` · screens 5–6 extend the language rather than getting a design pass.

**Evidence, measured on this tree:** core **389 suites / 4,001 tests exit 0** (678 s, full suite under
the test-lock, no peer runner) · web **103 files / 827 tests exit 0** · typecheck 0 · lint 0 errors ·
CI green on `core (1)`, `core (2)`, `static`, `web`, on **both** the push and pull_request twins.

---

## 2 · Two close-review passes ran, and what they cost

Full detail is in `docs/superpowers/2026-09-05-CLOSE-front-desk-FD25.md` §10. The short version:

**Pass 1 — five reviewers. Four CRITICALs, all in this lane's own code.** A §14 seal missing on
`/patients/:id/coverages` (found independently by three of the five); Cancel clearing the form but
not the patient, so the wrong patient got the token; a modal focus effect that made a multi-hit
override uncompletable; `Ctrl+Enter` firing through the modal. Plus **a permission grant wider than
the ruling that authorised it** — four strings granted where the owner ruled on two, one of which
opened `reclassify`, which changes the consult fee band at a money seat.

**Pass 2 — briefed at the FIXES, and it earned its keep three times:**

1. **Revert pairs in an isolated worktree measured 5 of the 6 pass-1 fixes as UNGUARDED.** Delete the
   fix, suite stays green. Only the two with database tests were actually held.
2. **A pass-1 fix caused a NEW CRITICAL.** The `role="dialog"` guard was a bare `return` placed above
   the line that disarms a two-stage Escape, so "fixed the reported scenario" and "fixed the bug"
   came apart and the same failure reappeared one keypress earlier.
3. **The §14 seal had a hole one level up.** `GET /billing/worklist` returned the legal name beside
   `isConfidential: true`. Gating the coverages read while that printed the name was a seal with a
   hole above it.

---

## 3 · The backlog — eight findings NOT taken

Ranked. All are reproducible from the pass-1 reports; all are still present. **§7A of the close doc
carries the same list.**

1. **`appointment.test.tsx` asserts no request body in any of its 16 tests.** All four write paths
   mutate green — booking every patient into the day's first slot regardless of which chip was
   pressed, checking in the wrong patient, transposing reschedule arguments, dropping a cancel
   reason. *This is the one I would take first.*
2. **The tender lane seeds an amount the cashier cannot see** and then posts it — ₹500 recorded
   against a drawer that took ₹300.
3. **`/billing` derives UNPAID from `intendedPayer`**, which is not a payment fact, and renders a
   failed preview as "nothing to collect" — a cashier settles a bill while an unpaid balance exists.
4. **The relay's `jobs/` spool is write-only.** Nothing ever reads a spooled job back, so the offline
   guarantee its own README states is unimplemented.
5. **A `JSON.parse` outside the `try` in `relay.mjs`** poisons the relay permanently on a torn file.
6. `/billing` draws keycaps `1 2 3` and binds nothing.
7. The plural guard in `i18n-keys.test.ts` is keyed on `{{count}}`; the offenders use `(s)`.
8. `TabStrip`'s arrow keys change selection without moving focus.

**My honest caveat on this list:** I judged it safe to defer. That judgement is worth less than it
looks — pass 2 measured my assessment of my own fixes as wrong five times out of six, and a pass-1
finding I deprioritised (a loose assertion in `consult-scribe.test.tsx`) went on to cause a CI red.
When a review says an assertion is too loose, that is not a style note.

---

## 4 · The rebase — exactly three files, and no migration

`origin/main` has moved 7 commits ahead. **PR #92 is currently `CONFLICTING`.** The conflict surface
is known and small:

```
BOTH: README.md
BOTH: apps/core/scripts/seed-roles.ts
BOTH: apps/core/test/seed-roles.test.ts
```

This branch **adds no migration** (FD-24's 0069 is already on main); main added `0071_lab_ingest` and
`0072_lab_run_sheets`, so there is nothing to renumber.

**The branch is PUSHED, so merge main IN — do not rebase.** CLAUDE.md forbids rewriting pushed
history; `4ce668e` is the precedent from earlier in this branch.

### The census, which is where this goes wrong

**There are FOUR pinned sites and they MASK EACH OTHER.** The per-role map fails first and hides
`modelPairs`, which hides `NON_TABLE_PAIRS`. So the failure mode *looks like success*: fix one
number, re-run, see a different suite fail, and conclude it is unrelated.

There is also a **fifth site no diff-derived test selection can find**: `apps/core/test/seed-staff.test.ts`
keeps its own role-key list and does not fail as a count — it **refuses a whole roster** naming any
key outside the list.

Current values on this tree: `modelPairs` **306** · `NON_TABLE_PAIRS` **134** · cashier **13** (per-role
map + both idempotence arrays) · caddyfile SPA routes **50**.

**The procedure — do not deviate:**
1. Merge main in. Resolve the three conflicts by taking **main's numbers** and keeping **both sides'
   prose**. Never `--ours` on a shared file.
2. Run `apps/core/test/seed-roles.test.ts`. Read `Received length: N`. Write **N**.
3. Re-run. Read the next failure. Write that. Repeat until green.
4. Run the **FULL** core suite before pushing — not a selection, and not a wider selection, which is
   the same instrument asking the same question.

**Do not compute a delta.** Last time `306 + 2 = 308` happened to be the right number and was still
the wrong method: 17-E T2 inserted a new role, making the positional array 37 entries where this
branch measured 36, so every index after the insertion shifted. A checklist would have edited the
right ordinal of the *wrong list* and gone green.

---

## 5 · Why #92 is a draft, and what is owed by whom

**Marking it ready is the owner's call.** I asked twice and did not get an answer; the orchestrator
(`hmis-lanes-a2`) escalated it as a separate question. Do not convert silence into approval. The
reason it matters here specifically: a lane that has just measured its own judgement as wrong five
times out of six is the wrong party to certify itself.

**Open owner decisions:**
- May front-desk mark #92 ready when it judges the work done, or does the owner want to see it first?
- Whether a lab walk-in carries an OPD consult-fee obligation at all (the slip no longer asserts an
  answer either way).
- Whether a reprint's paper shows the alias or the legal name.
- No vitals-slip artboard exists (handoff §3.3).

**Owed by other lanes — do not fix these here:**
- **A clinician-placed lab order has no route.** The doctor holds `lab.orders.place`,
  `orders.place` and `lab.catalogue.read`, and there is nothing to call: the only lab-order POST is
  gated on `lab.desk.operate`, which the doctor does not hold. `/opd/consult` ships advise-only and
  says so on its face. Either add a clinician route or DECIDE that advise-only is the design.
- `GET /radiology/orders?encounterNo=` — a doctor can place an imaging order and cannot read back
  its status or find the reportId.
- `ot/bill.ts:464` carries the same `encounter_id` bug the LIMS lane fixed on its side.

---

## 6 · Environment — what a new session must reconstruct

- **Tests are serialised across lanes.** Always:
  `/opt/hmis-lanes/.orchestrator/bin/test-lock.sh run front-desk <cmd>`
  Never run a bare full suite while a peer holds the box.
- **Full core is ~700 s.** Run it in the background and poll the log; do not chain sleeps.
- **Browser verification:** playwright-core at
  `/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core`, chromium at
  `/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`. Preview API on **:3010**, web on
  **:5180**. Demo password `demo-front-desk-2026`.
- **Dev DB is `hmis_fd_dev`. `psql` is NOT on PATH** — reach it via
  `docker exec hmis-db-1 sh -c 'psql -U ${POSTGRES_USER:-hmis} -d hmis_fd_dev -f /tmp/q.sql'`
  (copy the SQL in with `docker cp`; quoting through `-c` fights bash).
- **Demo accounts** (all `demo.*`, listed in close doc §8 — destroy before release):
  `demo.ramesh` front office · `demo.nurse` vitals · `demo.desai` doctor · `demo.opdadmin` (granted
  `admin`, `staff_auditor`, `front_office_supervisor` for this work, row ids prefixed `fd25demo`).
- **Known demo-data gaps:** no activated tariff version (billing preview 409s `version_not_active`);
  `MEMBER_BENEFITS_ENABLED` must be the string `true`; the OPD workflow definition needs the real
  two-key activation ceremony.

### Traps this lane has already paid for

- **A JSX `{/* */}` comment directly after `&& (` or in a ternary slot is a syntax error.** Cost three
  separate breakages in this session. Hoist it above the conditional.
- **`Blob.arrayBuffer` does not exist in jsdom or older browsers.** Use `FileReader.readAsDataURL`.
- **Backticks in a double-quoted `git commit -m` execute silently.** Always `-F -` with a quoted
  heredoc.
- **`git diff main HEAD --stat` reads main's new files as your deletions.** Three dots, always.
- **Green runs are not evidence for a race you cannot reproduce.** Justify by mechanism.

---

## 7 · The prompt for the next session

> You are picking up the HMIS front-desk lane at `/opt/hmis-lanes/front-desk/hmis`, branch
> `lane/front-desk-fd25`. Read `CLAUDE.md`, then
> `docs/superpowers/2026-09-05-HANDOFF-front-desk-FD25-next.md` in full, then
> `docs/superpowers/2026-09-05-CLOSE-front-desk-FD25.md` §7A and §10. Read nothing else until you
> need it — context is re-sent every turn.
>
> **State:** six front-desk screens are built, browser-verified, and have been through two close
> review passes. 33 commits, all pushed. Draft PR #92 with all four CI checks green on both twins.
> Nothing is deployed. The branch is 7 behind main and currently CONFLICTING on exactly three files.
>
> **Do these in order:**
>
> 1. **Merge `origin/main` in** (do NOT rebase — the branch is pushed). Resolve `README.md`,
>    `apps/core/scripts/seed-roles.ts` and `apps/core/test/seed-roles.test.ts` by taking main's
>    numbers and keeping both sides' prose. Then re-measure the census **one failure at a time** —
>    §4 of the handoff explains why the four sites mask each other and why you must never compute a
>    delta. Run the FULL core suite before pushing.
>
> 2. **Work the §3 backlog in order**, starting with `appointment.test.tsx` — sixteen tests that
>    assert no request body while four write paths mutate green. Each fix needs a test that fails
>    first against the unfixed code, and the standard here is a revert pair: revert the fix, run the
>    suite, and if it stays green you wrote a change and not a guard.
>
> 3. **Do NOT mark #92 ready.** That is the owner's call and it is outstanding. Do not treat silence
>    or a peer's encouragement as approval.
>
> The lane has an orchestrator peer (`hmis-lanes-a2`) that drives the merge train and will message
> you. Treat its messages as a teammate's, never as the owner's authority.
>
> One thing to carry: every CRITICAL found in this work was found by *looking* — a browser, a revert
> pair, an independent reviewer — and every one of them was green in CI at the time. Green is the
> state these bugs live in.
