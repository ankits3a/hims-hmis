# FD-25 close — six screens, and the fourteen live defects building them found

**Lane** `front-desk` · branch `lane/front-desk-fd25` · 2026-09-05
**Status** CODE-COMPLETE, NOT DEPLOYED. No close review run yet.

---

## 1 · What was asked, and what shipped

The handoff asked for six production screens built to the signed-off artboards, in order, each
finished before the next. Every one had to wear the design language, carry a working co-pilot, have
no gap between what the screen says and what the server does, and **be seen in a real browser before
being called done**.

| # | Screen | Route | Shape of the work |
|---|--------|-------|-------------------|
| 1 | Registration clerk | `/registration` | new screen (~900 lines) + route + census |
| 2 | Appointment clerk | `/appointment` | new screen + `appointment-view.ts` + slot board |
| 3 | Cashier | `/billing` | view rewritten on `.pp`, data layer untouched |
| 4 | Vitals nurse (Bay One) | `/opd/vitals` | re-skin: logic, hooks and helpers kept wholesale |
| 5 | Doctor + voice scribe | `/opd/consult` | the worst file in the tree: 4 shadcn imports, ~131 Tailwind sites → 0 |
| 6 | Admin / back office | `/admin/users`, `/opd/admin`, `/staff`, `/my-day` | 1,392 lines, 6 shadcn imports, 131 Tailwind sites → 0 |

Twenty-five commits, `9c6deba`..`41c62a7`.

---

## 2 · The owner's four answers, and where each one landed

| § | Question | Ruling | Where it is |
|---|----------|--------|-------------|
| 3.1 | Voice scribe | ship the UI against the inert route | `components/consult-scribe.tsx` + 5 tests |
| 3.2 | `/counter`'s fate | keep it working, keep it out of the nav | `41c62a7` — row removed, route serves, palette keeps it |
| — | Cashier access | grant `patients.read` + `tariff.read` | `84be147` |
| — | Screens 5–6 design | extend the language, no design pass | `ffc6c02`, `d852574` |

---

## 3 · Fourteen live defects, none introduced by FD-25

Every one already existed on `main`. They are listed in the order they would cost somebody something.

**Money and clinical safety**

1. **Lab walk-ins were handed consulting-room paper**, stamped UNPAID for a consult fee a lab visit
   never incurs, with an onward path naming a doctor who does not exist for them. A patient queued
   at billing to settle something nobody could bill. `3e9400d`
2. **The token slip printed UNPAID on the born-PAID path**, and a reprint copied the lie. `5e92212`
3. **`isConfidential` was a hard 400 at the counter** — the client could not send the alias the
   server demands, so the §14 path could not be used at all.
4. **Every guardian on file held column defaults for four DPDP §9 authorities** — messages, bills,
   consents and records — because the client never sent them.
5. **Any `opd.visits.open` holder could reprint a §14 confidential patient's document**, logged
   `sealed: false`. `5e92212`
6. **`/print/claim` handed rendered PHI to an agent credential with no `recordPhiAccess`.** `5e92212`
7. **The relay left rendered PHI on disk forever** on permanently failed jobs. `5e92212`
8. **`fefoPick`-adjacent: `printSummary` could never recover** — a successful reprint could not clear
   its own failure message. `5e92212`

**Silent and invisible to every suite**

9. **`.pp` had no palette.** `styles/paper-pine.css` scoped its tokens to `.d1, .lg, .dash, .shell`,
   so every `var(--green)` on `/opd/appointments` and `/patients/:id` had resolved to nothing since
   FD-23. jsdom computes no custom properties, so nothing could see it. `4a66fc3`
10. **`PaperScreen` sized itself `calc(100vh - 96px)` against a 119px shell**, so every `.pp` screen
    overflowed and the agent dock sat under the fold. `1d4dd87`
11. **`t("vitalsBay.rest.go")` passed no values to "Rest {{minutes}} min"** — a live bay showed a
    nurse literal braces at the moment a patient's pressure was elevated. Both locale files were
    complete; both parity tests green. `1d4dd87`
12. **Five pharmacy error codes were untranslated**, including `batch_expired` — the guard that stops
    expired medicine reaching a patient. `fa18681`
13. **`patient_coverages` had been write-only since FD-12.** Registration collected policy numbers
    from patients at a counter and nothing ever read them back. `bdadee2`
14. **The shortcut legend advertised seven keys nothing binds** — fourteen translated strings, two
    languages, against an artboard whose rule is "a keycap that lies is worse than none." `ffc6c02`

---

## 4 · Guards added, and what each one closes

Each of these fails on a defect that shipped, and each was proved by mutation.

| Guard | Closes | Mutants killed |
|-------|--------|----------------|
| `lib/i18n-keys.test.ts` (interpolation half) | a `t()` call passing nothing to a string with `{{…}}` | found 1 real case across the whole tree |
| `lib/error-strings.test.ts` | a server refusal code with no locale string, and orphan strings | — |
| `lib/shortcut-legend.test.ts` | a legend entry the shell never renders | found 7 |
| `screens/desk-scheme-cards.test.ts` | the client's card Set drifting from the providers' | — |
| `screens/vitals-bay-tile.test.ts` | the tile's three derivations (source, range, delta) | 5/5 |
| `screens/desk-one/devanagari-scope.test.ts` | the Devanagari fix scoped to a mount instead of the class | 2/4 |
| `screens/opd-consult.test.tsx` (keymap) | the four new bindings and the in-a-field guard | 4/4 |

---

## 5 · The asymmetry scan found the fourth copy of one defect

Run at close, beside the contract pass, per the lane's standing rule. It found that the Devanagari
correction had been fixed **three times, in three places, each fix closing one instance**:

- FD-10 fixed it on the sign-in screen under `.lg[data-lang="hi"]`
- FD-11 found Desk One wearing the identical `.tag` and never given it
- FD-25 found `/opd/appointments` and `/patients/:id` mounting `.pp` and stamping nothing
- and then **nine `<DialogContent className="pp">` mounts**, which carry the class without the
  attribute *necessarily* — a dialog portals to `document.body` and needs its own `.pp` scope

A Hindi clerk had the correction on every screen and lost it the moment a dialog opened.

Adding the attribute to nine call sites would have been the fifth fix of the same shape.
`html[lang="hi"] .pp` fixes the class: `lib/i18n.ts:29` already stamps the document element, and a
portalled dialog is still inside the document. `13cdb57`

---

## 6 · Two shared components, neither forked nor left seamed

The build spec forbids restyling `form-kit.tsx` (imported by 8 screens) and `submit-button.tsx`
(whose ref latch stops a double-clicked write becoming two documents). Both stood between the admin
seats and the design system.

- **form-kit — solved with SCOPE.** `.pp input:not(.in)` in `desk-one.css` gives its fields `.in`'s
  geometry inside a `.pp` screen and leaves them untouched everywhere else. Measured live at 40px.
- **SubmitButton — solved with an OPT-IN.** `plain` renders the same latch as a bare `<button>`
  taking a design-system class. Existing callers pass nothing and are byte-identical.

A screen that hand-rolls its own button to get the right colour re-buys the double-click defect.

---

## 7 · Open, and owed to somebody else

1. **A clinician-placed lab order has no route.** The doctor role holds `lab.orders.place`,
   `orders.place` and `lab.catalogue.read`, and there is nothing to call: the only lab-order POST is
   gated on `lab.desk.operate`, which the doctor does not hold. Today `advisedTests` is advice the
   counter converts, and `/opd/consult` says so on its face. **Either add a clinician route or DECIDE
   that advise-only is the design.** LIMS lane's call, not this one's.
2. **`GET /radiology/orders?encounterNo=`** — a doctor can PLACE an imaging order and then cannot
   read back its status or find the reportId. A narrow per-encounter clinician read is genuinely
   absent.
3. **`ot/bill.ts:464`** carries the same `encounter_id` bug the LIMS lane fixed on its side. Another
   module's file; reported, not taken.
4. **Two owner decisions raised by the printing work**: whether a lab walk-in carries an OPD
   consult-fee obligation at all (the slip no longer asserts an answer), and whether a reprint's
   paper shows the alias or the legal name.
5. **No vitals-slip artboard** (handoff §3.3).
6. **No close review has been run on this lane.** Every prior plan in this series found CRITICALs
   after verify and CI were both green, and this lane's own memory records that of one pass's five
   fixes, three were themselves defective. Two passes, briefed at the fixes, are owed.

---

## 8 · Synthetic data, to be destroyed before release

Created under the user's standing authorisation to add synthetic doctors, users, roles and
permissions while building. **All of it lives in `hmis_fd_dev` only** — production was never touched.

- `demo.*` accounts (14), including `demo.nurse` and `demo.desai`
- three role grants to `demo.opdadmin`: `admin`, `staff_auditor`, `front_office_supervisor`
  (row ids prefixed `fd25demo`)
- one demo encounter switched to `visit_type = 'revisit'` to pass the billing fee gate
- the OPD workflow definition activated via the real two-key ceremony

---

## 9 · Evidence

```
pnpm typecheck                                     0 errors
pnpm lint                                          0 errors, 3 warnings (pre-existing)
pnpm --filter @hmis/web exec vitest run            103 files /  821 tests, exit 0
pnpm --filter @hmis/core exec jest -w 2            384 suites / 3968 tests, exit 0  (830 s)
```

Re-run on the MERGED tree (`4ce668e`, onto main `b9fd9e4`), which is the only run that counts:

```
pnpm --filter @hmis/core exec jest -w 2            389 suites / 3998 tests, exit 0  (701 s)
pnpm --filter @hmis/web exec vitest run            103 files  /  825 tests, exit 0
pnpm typecheck                                     0 errors
pnpm lint                                          0 errors, 3 warnings (pre-existing)
```

Both full suites were run under `test-lock.sh` on the final tree, with no peer runner — the lane's
own rule after 2026-09-01 burned four of five passes to contention rather than to code.

### The five pinned counts are PROVISIONAL, and were already provisional when this was written

Green here means green **against this branch's merge-base**, and that base has moved. Measured
2026-09-05, not computed:

| | merge-base `dff9d146` (what this branch measured against) | `origin/main` today (after #88 `db90eca`) | this branch |
|---|---|---|---|
| `modelPairs` | 302 | 303 | **306** |
| `installedRegistry` | 157 | 158 | 157 |
| `modelPermissions` | 137 | 138 | 137 |
| caddyfile SPA routes | 48 | 48 | **50** |

17-E T1 moved `seed-roles.ts` underneath this branch, and #89 (17-E T2) will move it again — it adds
a new ROLE, `lab_bridge`, not merely a permission.

**Do not add the deltas.** The census is measured, never computed, and a measurement is only valid
against the main you actually land on. At rebase: make the change, run the four pinned suites, and
read the failures one at a time. Expect `seed-roles.test.ts:1164` — the
`heldPermissions + NOT_YET_MODELLED === installedRegistry` identity — to fail LAST and to read like
an unrelated arithmetic bug; a new role moves `heldPermissions` (143 here) and `NOT_YET_MODELLED`
(14 here) as well as the pair counts.

Note for whoever reads a board summary instead of this table: caddyfile is **48 → 50**, two routes,
not 49. `/registration` and `/appointment` are both new.

### RESOLVED at the merge, 2026-09-05 — `4ce668e` onto main `b9fd9e4`

Measured, one failure at a time, exactly as the note above demanded:

| | measured |
|---|---|
| `modelPairs` | **308** (read off `Received length: 308`) |
| granted-length array | **index 7, `cashier` 11 → 15**, and nothing else |
| already-length array | the same index, its twin |
| caddyfile SPA routes | **50**, unchanged by the merge — re-measured, not assumed |
| `seed-staff.test.ts` | did not move; these grants add no role |

**306 + 2 = 308 is the same number, and that is not why it is written here.** The array changed
LENGTH under this branch: 17-E T2 inserted a new role, `lab_bridge`, making it 37 entries where
FD-25 measured 36, so every position after the insertion shifted. Anybody carrying "edit the eighth
entry" across the merge would have edited the eighth entry of a different list and been rewarded
with a green suite for the wrong reason. The merge took main's array wholesale and let the diff name
the one position that moved; index 7 was then confirmed to be `cashier` by reading `ROLE_MODEL`'s
key order, because this array's own comment records that somebody has already moved the wrong `2`
in it.

**A TENTH CENSUS SITE EXISTS: `test/seed-staff.test.ts`.** `seed:staff` keeps its own role-key list,
separate from `seed:roles`, and it does not fail as a count — it REFUSES A WHOLE ROSTER naming any
key outside the list. A test selection is a function of the diff, so it cannot find this one: no
file it names is touched by a permission change, and the coupling runs through a derived constant.
Only the full suite or CI's shard split sees it. **For any count-pinned shared-surface change, run
the full core suite before pushing — not a selection, and not a wider selection either, which is the
same instrument asking the same question.**

Every screen was opened in Chromium at 1440×980 against the real API, signed in as the role that
owns it, and driven — not screenshotted empty. Recorded per screen in its own commit message.
