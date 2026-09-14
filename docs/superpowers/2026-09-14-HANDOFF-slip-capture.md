# HANDOFF — prescription capture, and the branch that is stranded behind it

**Read this file and `CLAUDE.md`. Nothing else, until a task below names something.**

---

## ⓪ THE PROMPT — paste this to start

> Read `docs/superpowers/2026-09-14-HANDOFF-slip-capture.md` in the `slip-capture` lane
> (`/opt/hmis-lanes/slip-capture/hmis`). Two lanes are in flight and §① says which is which.
> §④ is the open work, ordered. Do not re-measure anything in §③ — it is already paid for.

---

## ① THE TWO LANES IN FLIGHT

| | |
|---|---|
| **`lane/cds-dx-advice-allergy`** | **PR #197 OPEN**, 18 commits, migrations 0085–0091. The doctor's consult screen: ICD-10 diagnosis tags, the advice library, the coded allergen, snippets, the complaint vocabulary. CI was running when the session ended — **check it first**. |
| **`lane/slip-capture`** | This lane. 3 commits, migration 0085. Prescription capture. PR state is in §② — it was being opened as the session ended. |

**The two lanes both took migration 0085** — they were cut from the same `main`. Whichever merges
second must REGENERATE (never renumber) its migrations above the new tip. See
[[drizzle-when-silently-skips]]: a renamed file keeps its old `when` and is skipped for ever.

**`lane/front-desk-fd25` is STRANDED and is not this work's problem, but it is somebody's.** 81
commits (FD-27, FD-32, FD-33, the paper-slip desk, FD-36), **90 behind main, 33 conflicting files**,
no PR. Assessed 2026-09-14 — see §⑤.

---

## ② WHAT PRESCRIPTION CAPTURE IS, AND WHAT IS BUILT

Owner, 2026-09-14: *"the staff outside the consultation room asks for the prescription, scans the
QR in the footer, captures the picture … the prescription photo can be found in the patient history
by the doctor."*

Three commits, all green:

1. `45f68bbf` — **the storage seam and the table.** `DocumentStore` interface + `DiskDocumentStore`,
   `patient_documents` (migration 0085), capture / list / read / E-8 correction.
2. `bb563edd` — **the doctor's view.** Four routes, the DI wiring, and a fourth history view beside
   Visits / Prescriptions / Vitals.
3. `e00a273b` — **the slip desk** at `/opd/slips`: scan, read-back, camera or file, downscale, file.

**OWNER RULINGS HONOURED, both explicit:**
- *"downscale the image and save it to disk for now, I will then add Cloudflare R2 or AWS S3
  later"* → `DocumentStore` is an interface from the first commit, `storage_key` on the row, and
  **no `bytea`**. R2/S3 is one provider in `app.module.ts`.
- *"reuse an existing permission, don't mint a new one"* → capture on `patients.update`, reads on
  `patients.read`, the visit resolve on `opd.visits.read`. `seed-roles.test.ts` untouched.

---

## ③ MEASUREMENTS ALREADY PAID FOR — DO NOT RE-DERIVE

**Why not `bytea`:** a raw phone photo is 2–4 MB; at 200 OPD patients/day with one page each that is
~400 MB/day, **~145 GB/year** inside every `pg_dump`, restore and replica. Downscaled to ~300 KB it
is ~22 GB/year. `patient_photos` keeps bytes in the row and was right to — one 512 KB face photo per
patient does not survive the change of scale.

**The traversal guard has TWO layers and each alone suffices.** Measured:

    shape check neutered, resolve intact  ->  K2 fails; D2 and D6 PASS
    resolve neutered, shape intact        ->  K2 fails; D2 and D6 PASS
    both neutered                         ->  K2, D2, D6 all fail — the traversal escapes

A single mutant misleads here: `assertStorageKey` has two clauses (the regex AND `includes("..")`),
so breaking only the regex leaves the guard standing.

**The write order was backwards in the first draft.** Bytes-before-row was justified in a comment
and a mutation reversing it left every test green — the TRANSACTION is what guarantees a row never
outlives a failed `put`. What the order decides is ORPHANS, and row-first wins. `G2b` discriminates.

**The permission holders:** `patients.update` = doctor, front_office, front_office_supervisor,
lab_reception, mrd_officer, vitals_desk — exactly the seats that might hold the paper.

**jsdom cannot rasterise a pixel**, so the downscale's arithmetic is tested apart from the screen
(`fitToMaxEdge`, `fitsBudget`) and the screen tests stub the image boundary and say so.

---

## ④ WHAT IS OPEN, IN ORDER

1. **Check PR #197's CI**, and this lane's PR (§②). A red `main` freezes merges.
2. **A browser walk of `/opd/slips` with a real camera.** Nothing has been driven in Chromium —
   jsdom proved the wiring and the sums, not the lens. `getUserMedia` needs a secure context, so
   the preview must be `localhost` (which counts) or HTTPS. See [[how-to-see-what-the-user-sees]].
3. **`DOCUMENT_STORE_PATH` is unset on every deployment.** It defaults to `/var/lib/hmis/documents`,
   which does not exist on this box or in prod. A capture will fail `unwritable` until an operator
   creates it, and **nothing warns at boot** — see [[boot-check-warn-vs-refuse]] for which kind of
   check this wants (a DATA state an operator can be halfway through: WARN, do not refuse).
4. **Retention.** `patient_photos` is not in the sweep and neither is this. It is the first image
   class that needs one, and on disk the sweep must delete BYTES as well as rows —
   `DocumentStore.remove` exists and is idempotent for exactly that.
5. **The scribe desk should call this module** rather than grow its own capture, once
   `lane/front-desk-fd25` is rescued (§⑤).
6. **No `consult_prescription` is captured automatically.** The doctor's own e-Rx is already
   structured; the kind exists for a desk that photographs the printed copy, and nothing does yet.

---

## ⑤ `lane/front-desk-fd25` — THE ASSESSMENT, SO NOBODY REPEATS IT

**Do not build on it. Do not rebase it inside another task.** Measured 2026-09-14:

- tip `b30f71e3`, unchanged since 2026-09-13; **main 90 ahead, branch 81 ahead**
- **33 conflicting files**, 27 of them real code (6 are drizzle metadata)
- `opd-consult.tsx` is the killer: fd25 changed +604/−250, main +775/−307 independently, and
  PR #197 adds +979/−43 on top — a ~2,000-line three-way divergence in ONE file
- `billing-counter.tsx` +1,496, `render.ts` +737 behind it
- every pinned census is in the conflict set: `seed-roles.ts` + its test, `caddyfile-parity`,
  `router.tsx`, both locale files
- it carries **five** migrations (0074–0078), not the four recorded earlier, and they must be
  REGENERATED above whatever main's tip is by then

Precondition 1 from [[front-desk-fd25-rebase-preconditions]] is now **satisfied** (#187 is on main).
Preconditions 2–4 have all got worse. It needs its own session and it gets more expensive daily.

**It also has no photo capture** — measured: `getUserMedia` appears in `consult-scribe.tsx` for
`audio: true` (dictation), and the screen has zero matches for camera, canvas, file input or
`imageBase64`. Its migration adds only `transcribed_by` / `slip_confirmed_by` / `slip_confirmed_at`.
The typing half shipped; the image half never existed, which is why this lane exists.

---

## ⑥ TRAPS THIS LANE PAID FOR

- **A test that proves an escape must not leave the escape lying around.** The mutation run that
  genuinely escaped wrote `/tmp/escaped.jpg` and left it, failing every later run for an unrelated
  reason. Escape to a per-run unique name.
- **`PhiSurface` is a closed union** and the compiler refuses an undeclared string — good design.
  Two surfaces were added, not one: seeing that a document EXISTS and OPENING it are different acts.
- **`DeskTR` renders only its children**, so a `data-testid` on a table row is silently dropped.
- **jest's `expect` takes no message argument** (that is vitest). Put the case IN the assertion.
- **Adding an SPA route moves `caddyfile-parity`'s count** — 53 → 54 here. Measure it from the
  failure, never increment it on the way past.
- **An `eslint-disable` for a rule the project does not configure is itself an error.**
