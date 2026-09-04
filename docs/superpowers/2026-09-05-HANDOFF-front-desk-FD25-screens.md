# HANDOFF — FD-25: five production screens, the co-pilot, and the admin dashboard

**Written 2026-09-04, at the end of the FD-24 session. Paste §0 as your first message in the new
session. Read this whole file before writing code; read `CLAUDE.md` first. Nothing else.**

---

## 0 · THE PROMPT — paste this

> Read `docs/superpowers/2026-09-05-HANDOFF-front-desk-FD25-screens.md` in full, then `CLAUDE.md`.
> Execute it.
>
> Build, to production quality, in this order:
> 1. **`/registration`** — the registration clerk's screen (user 1)
> 2. **`/appointment`** — the appointment clerk's screen (user 2)
> 3. **`/billing`** — the cashier's screen (user 3)
> 4. **`/opd/vitals`** — the vitals nurse's screen (user 4), rebuilt
> 5. **`/opd/consult`** — the doctor's screen (user 5): consultation notes, prescribing, ordering
>    tests, plus a **voice scribe**
> 6. **the admin dashboard** — every remaining old surface brought onto the new design
>
> Every one of them must wear the new design language, carry a working **AI co-pilot**, and have no
> gap between what the screen says and what the server does. **Redesign — leave no trace of the old
> UI.** UX is non-negotiable. The co-pilot is non-negotiable.
>
> Stop and ask me only about the items in §3 of the handoff. Everything else: decide, mark it
> DECIDED, keep going.

---

## 1 · WHERE THINGS STAND, MEASURED 2026-09-04

**Lane** `/opt/hmis-lanes/front-desk/hmis`, branch `lane/front-desk-fd24`, **4 commits ahead of
`origin/main`, 0 behind. Nothing pushed, no PR open.** FD-24 (printing) is code-complete; a full
core run was in flight when this was written — **re-run it and read the count before trusting it.**

`origin/main` already carries everything through FD-23 plus the FD-24 plan doc (PR #50, squash
`b738ddb`).

### What FD-24 built, and why you need to know

Printing is **server-side**: `print_jobs` is an outbox (migration `0069`), a relay inside the
hospital claims jobs over an outbound connection and prints them via CUPS
(`tools/print-relay/relay.mjs` + its README). Opening a visit queues the token slip and the A4
prescription **inside the visit's own transaction**. `StageDone` shows print status and offers a
reprint.

**Until the relay is installed in the hospital, nothing physically prints.** Jobs queue correctly.
Owner ruling R7 makes that survivable: a print failure is advisory, never blocking.

### The design debt, counted rather than asserted

Almost every screen still wears the **old Tailwind/shadcn** look. Only `screens/desk-one/*`,
`opd-appointments.tsx` and (partly) `patient-detail.tsx` speak the new language. Measured by
counting old-vs-new class usage per file:

| screen | old-design hits |
|---|---|
| `opd-consult.tsx` (the doctor) | **59** |
| `billing-office.tsx` | 54 |
| `billing-counter.tsx` (the cashier) | 43 |
| `opd-desk.tsx` | 35 |
| `counter-figures.tsx` | 32 |
| `billing-session.tsx` / `billing-dues.tsx` | 31 each |
| `vitals-bay.tsx` (the nurse) | 18 |
| `my-day.tsx`, `opd-admin.tsx`, `staff-reports.tsx`, `ops-mode.tsx`, the lab/materials/OT screens | 15–35 each |

The owner has called this *"pathetic"* twice. They are right, and the number above is why: the new
design was only ever applied to three files.

---

## 2 · THE THING THAT WILL CONFUSE YOU IF NOBODY SAYS IT

**`/registration` and `/appointment` DO NOT EXIST. They were deliberately deleted.**

FD-9 (2026-09-03) merged registration + appointment + billing into **one** screen at `/counter`
("Desk One") on the owner's explicit ruling:

> *"remove the old design.. Let's only focus on one user right now. This user has access to
> registration, appointment and billing."*

The route census in `apps/core/test/caddyfile-parity.test.ts` records the deletion, and its comment
says the deletion was chosen over a redirect because *"a second name for one screen is what put the
owner on the wrong counter in FD-1."*

**The new ask reverses that**, and legitimately — the hospital now staffs three seats instead of
one. So:

- **Re-create `/registration` and `/appointment` as real routes** (the census count goes 48 → 50;
  measure it, never predict it — the test's own rule).
- **Do NOT delete Desk One's code.** `screens/desk-one/` is the only production-quality front-desk
  UI in the tree and it is where the design system lives. The three new screens are built FROM its
  components and its CSS, not beside them.
- **`/counter` itself:** the owner has not ruled. See §3.

---

## 3 · ASK THE OWNER ABOUT THESE FOUR THINGS — AND ONLY THESE

**3.1 · The voice scribe is blocked by design law, not by engineering.**

`POST /api/speech/transcribe` already exists and is **shipped inert**
(`kernel/inference/speech.controller.ts`). It is off because of the DPIA's §2 design law, quoted in
`docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md`:

> **Class 2 never enters an inference request — any stage, any provider, ever.**

A doctor dictating a consultation is **Class 2 identified health data**. So a cloud scribe — any
provider, including the proposed Cloudflare Whisper exception — is forbidden until the DPIA is
revised. The controller says so itself: *"requires a DPIA revision — not a plan ruling and not a
code change."*

**Do not build a cloud scribe and do not quietly widen the rule.** Put it to the owner as:
(a) revise the DPIA to permit a named STT provider under a no-training DPA, (b) on-prem STT (the
ladder's L2, a ₹3–6 L box, currently deferred), or (c) ship the scribe's UI against the inert route
so it lights up the day a provider is authorised. **Default if the owner is asleep: (c).** Build the
whole dictation surface — record, waveform, transcript panel, insert-into-note, undo — against the
existing inert endpoint, and make the microphone say plainly why it is off. Nothing is wasted.

**3.2 · What happens to `/counter`.** Three separate seats make Desk One either (a) redundant and
deleted, or (b) kept as a fourth "one person does everything" route for a small-hours shift. FD-9's
own lesson says two names for one screen is a defect. **Default: keep it working, do not add it to
the nav, and ask.**

**3.3 · The vitals slip still has no artboard.** Owner ruling R3 created it in the FD-24 session;
it is the only one of the four print documents with no design. `renderDocument` returns null for it
deliberately. Get an artboard before building it.

**3.4 · What the co-pilot may actually do.** See §5 — today it answers only from what is on the
screen, with no model behind it, because FD-8 measured the gateway at 22–40 s per call. If the owner
wants a real model in the loop, that is a Class-0/Class-1 question and a latency question, and it
needs a ruling before you design around it.

---

## 4 · THE DESIGN REFERENCES — USE THEM, DO NOT INVENT

**Everything is already designed. The owner has signed these off. Read the artboard before you
write the screen.**

| Screen | Artboard |
|---|---|
| `/registration` | `docs/design/2026-09-03-front-desk-three-seats/Registration.dc.html` |
| `/appointment` | `…/three-seats/Appointment.dc.html` |
| `/billing` | `…/three-seats/Billing.dc.html` |
| routing between the three | `…/three-seats/Routing.dc.html` · keys: `…/Keymap.dc.html` |
| `/opd/vitals` | `docs/design/2026-08-31-vitals-desk/` — **"Bay One", signed off**, 6 owner rulings incl. 10-s bump cancel, serial toggle OFF, three-door identify, bold-✓ confirm |
| the counter's flow, print, edge cases | `docs/design/2026-08-29-opd-counter-flow-v2/` (v2, **not** v1) |
| registration counter, deeper | `docs/design/2026-08-31-registration-counter/` — **"Desk One" won** |

Open the standalone `*.html` in each folder for the whole canvas. There is **no artboard for the
doctor's screen or the admin dashboard** — for those, extend the established language rather than
inventing a second one, and consider asking for a design pass first.

---

## 5 · THE DESIGN SYSTEM AND THE CO-PILOT — WHAT "THE NEW UI" ACTUALLY MEANS

**The system lives in `apps/web/src/screens/desk-one/desk-one.css`.** Its own header says: primitives
carry `.d1` AND `.pp`; layout rules keep `.d1` alone; **one definition — do not fork it.** If a new
screen needs a primitive, add it there.

Type: IBM Plex Sans / Mono / Sans Devanagari, **now self-hosted** in `apps/web/public/fonts` with
`src/styles/plex.css` (FD-23 close review — a render-blocking Google Fonts link on an on-prem
hospital was both a first-paint risk and a privacy leak). Do not re-add a font CDN.

Other primitives worth reusing before rebuilding: `components/agent-dock.tsx`,
`components/patient-picker.tsx`, `components/patient-strip.tsx`, `screens/desk-one/dossier.tsx`
(the left rail), `overlays.tsx` (the correction sheet), `model.ts` (pure functions — `tokenLabel`,
`billOf`, `ageOf`, `walk-in routing`).

### The co-pilot, stated honestly

`components/agent-dock.tsx` is the reusable bar: a ticker of what just happened, an ask box bound to
**F2**, and a pull-up log. It is live on `/opd/appointments` and `/patients/:id`; Desk One has its
own (`desk-one/dock.tsx`).

**There is no language model behind it.** FD-8 measured the hospital's triage gateway at **22–40 s**
synchronously — not an answer a clerk with a queue can wait for — and a browser-side key would put a
gateway credential in every bundle. So it answers from **what is already on the screen**, and every
answer names its source. That is not a stub to be replaced casually; it is a measured decision.

**"The co-pilot is non-negotiable" means: every screen you build gets a working `AgentDock`, wired
to that screen's real state, answering that screen's real questions, and honestly saying what it
cannot see.** A dock that renders and answers nothing is worse than none — the F2 keycap taught this
lane that lesson already (FD-23 close review: *"a keycap that lies is worse than none"*).

---

## 6 · RULES THAT BIND — from `CLAUDE.md` and this lane's scars

- **Work in a lane.** Never edit `/opt/hmis`. Commit by pathspec, never `git add -A`.
- **Evidence over assertion.** Never report a test green you did not run in that state; paste counts.
- **A new test must fail first** against the code it guards. This session proved every fix that way
  and it caught three real defects.
- **Never weaken a guard, permission check or audit write** to make a test pass.
- **Migrations:** additive, numbered **at rebase time** — use `tools/renumber-lane-migrations.py`
  (it refuses a colliding tag and a non-ascending journal), then **drop the lane's test databases**.
- **Shared files** (`router.tsx`, `locales/*.json`, `seed-roles.ts`, `caddyfile-parity.test.ts`,
  `app.module.ts`, `kernel/**`): coordinate, and **never `--ours`** a shared file in a merge — take
  main's copy and re-apply your hunks, then prove key-by-key that nothing of a peer's was dropped.
- **The route census is MEASURED**, never predicted. Adding `/registration` and `/appointment` moves
  it; run the test, read the number, write that.
- **Locale parity** is blind to a key missing from BOTH files. Every new string goes in `en.json`
  and `hi.json` together.
- **Owner rulings are for money, procurement and law only.** Everything else: pick the standard
  Indian-corporate-hospital answer, mark it DECIDED in the phase doc, keep going.

### Traps this lane has already paid for — do not re-buy them

- **`stubFetch` does not await handlers** (`test-utils.tsx:39`). An `async` route handler makes
  `JSON.stringify(Promise)` → `{}`. To simulate a slow network, wrap `globalThis.fetch`, never the
  handler. *(I got this wrong once and drew a false conclusion from it.)*
- **Waiting for a heading is not waiting for the data.** `openFutureTab` waited for "The day's book"
  while the grid gated on `!slots.isFetching`; ten assertions sat on that race and CI failed one.
- **`INSERT … SELECT … ON CONFLICT` evaluates the SELECT on EVERY call**, not just the insert. It
  cost a 5× regression that `perf-opd-queue` caught at 107 ms against a 100 ms budget. Use
  `RETURNING (xmax = 0) AS inserted`.
- **Chromium silently ignores `@page { size: 72mm auto }`** and emits US Letter. Page geometry
  travels as data and the relay measures it. `tools/print-relay --self-test` guards this.
- **A wall-clock CI failure that the same SHA passes on a rerun looks exactly like this repo's four
  known flakes — and once this session, it was not one.** Check whether your diff is in the measured
  path before reaching for the flake explanation.
- **A half-moved control looks finished from the one screenshot you have.** FD-21 moved the photo
  Retake and left Camera/Upload behind, because `PhotoPanel` branches on whether a photo exists and
  only one branch was touched. The owner found it, not the tests.

---

## 7 · SCOPE — READ THIS BEFORE PROMISING THE OWNER ANYTHING

**This is not one session of work.** Five production screens, a voice scribe, a working co-pilot on
each, and a full admin re-skin is comfortably several sessions even going well. Attempting it in one
pass produces five half-screens, which is worse than two finished ones.

**Do it in this order and finish each before starting the next.** Each is a PR.

1. `/registration` — smallest, best-designed, re-establishes the pattern for the rest
2. `/appointment` — reuses registration's rail and picker
3. `/billing` — money; it gets the most careful review
4. `/opd/vitals` — Bay One is signed off and has six rulings already made
5. `/opd/consult` + scribe — the biggest, and gated on §3.1
6. the admin dashboard and the remaining old surfaces

**Definition of done for each screen** — all of it, not most:

- wears the design system (no `@/components/ui/*`, no raw Tailwind in the screen body)
- a working `AgentDock` answering that screen's real questions
- every string in `en.json` **and** `hi.json`
- permissions enforced server-side, not just hidden in the UI
- keyboard path per `Keymap.dc.html` — **and every keycap drawn is a key that is bound**
- responsive to the counter machines (Desk One's floor is 1220 px; check the artboard)
- tests that fail first, including one that would have caught the defect you were most worried about
- typecheck 0, lint 0 errors, both suites green with counts pasted
- **seen in a real browser before you call it done.** This lane's record is unambiguous: three
  money/data defects in FD-9, five look-defects in FD-11 and the photo buttons in FD-24 were all
  found by looking, with green suites throughout. `docs`-wise see memory `how-to-see-what-the-user-sees`;
  the preview is `/opt/hmis-preview/preview.sh` on :8443 and the tunnel is `ssh -N -L 5180:…`.

**A note on the owner's own words.** They said *"no crack and loopholes"* and *"UX is
non-negotiable"*, and they will look at the screen, not the test count. When you must choose between
another feature and finishing the one in front of you properly — finish it properly.

---

## 8 · FIRST FIVE MINUTES OF THE NEW SESSION

```bash
cd /opt/hmis-lanes/front-desk/hmis
git status --short && git log --oneline -4
git fetch origin && git rev-list --left-right --count origin/main...HEAD
tools/lane.sh status                      # who else is running tests, free memory
```

Then: **finish FD-24** — re-run the full core suite, read the count, push
`lane/front-desk-fd24`, open the PR, and let CI gate it. Do not start FD-25 on top of an unpushed
FD-24; this lane spent a whole afternoon chasing a 73-commit branch and the lesson was expensive.

Then open a fresh lane off the merged main for the screens.

**The preview database `hmis_fd_dev` still has the OLD migration numbering applied** and will fail on
the next API restart (it would re-apply `0066`–`0068` and skip `0059`). Drop and re-migrate it before
using the preview, and re-seed the demo data (`apps/core/scripts/seed-*.ts`; the demo package/coupon
data sat on `Ramesh Kumar` `U00110012`).
