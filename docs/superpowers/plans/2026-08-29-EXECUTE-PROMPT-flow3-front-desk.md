# EXECUTE PROMPT — Flow 3 front desk, end to end and testable live

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis`.

---

## Mission

Build the **Flow 3 "single window"** OPD journey as working software, from the design already
signed off on the canvas, until one person can walk the whole thing on a real browser against a
real database.

**The one demo that proves it is done.** A tester, using only the app:

1. Registers a new walk-in at the front desk, types a symptom, picks a doctor, takes ₹300 cash,
   and prints one 80 mm slip that is both her token and her receipt.
2. Scans that slip's barcode at the vitals desk, records her vitals, and finds the height carried
   forward from a previous visit and locked until a reason is chosen.
3. Sees her appear in the doctor's list, reorders the queue by drag, presses **Call next**, and
   watches the waiting-hall board change.

If a person can do those three things without you narrating over their shoulder, the phase is done.

---

## Read these first, in this order

**The design is not a description — it is HTML you can open and copy values out of.** Every screen
below exists as a real artboard with exact tokens, spacing and copy.

| What | Where |
|---|---|
| The canvas (open it, page 1) | https://claude.ai/code/artifact/1d57ce0c-d9e3-42a8-83fe-5a15014bb1fa |
| Working files for every artboard | `docs/design/2026-08-29-opd-counter-flow-v2/` |
| Front desk, all three sequence modes | `…/Main.dc.html` — the `renderVals()` at the bottom is the state machine |
| The 80 mm slip at actual print width | `…/TokenSlip72.dc.html` |
| Hindi-first variant of the same slip | `…/TokenSlipHindi.dc.html` |
| Vitals, doctor queue, display board | `…/VitalsDesk.dc.html`, `…/DoctorQueue.dc.html`, `…/DisplayBoardHindi.dc.html` |
| Devanagari rules — read before any Hindi string | `…/DevanagariSpec.dc.html` |
| Which printer prints what | `…/PrinterChoice.dc.html` |
| Why Flow 3 exists at all | `…/FlowComparison.dc.html` |

Then read, in the repo:

- `apps/web/src/styles.css` — the whole palette. Greyscale by design; the only colours are
  `--state-waiting / danger / settled / live`, and a hue means a **state**, never decoration.
- `apps/web/src/screens/counter-desk.tsx` — the current walk-in screen and the reasoning in its header.
- `apps/core/src/modules/opd/config.ts` — `OPD_ROLE_KEYS`, `loadOpdConfig`, `letterheadSchema`.
- `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` — **before you run any test.**

---

## Ground truth — already built, do not rebuild

Getting this wrong is the main way to waste a day.

- **The priority ladder exists.** `opd.queueClass` 0–4 — danger, returned-with-results,
  appointment-due, walk-in, future — is already computed server-side. The doctor's queue screen has
  to *display* it. Do not invent an ordering.
- **Fee quoting and invoicing exist.** `fetchFeeQuote` / `issueInvoice` in `apps/web/src/lib/billing-api.ts`,
  and a cashier-session precondition already enforced by `issueInvoice`. Flow 3 reuses these — the
  front desk simply becomes a place that calls them.
- **Change-handed-back is already modelled** and deliberately defaults to the whole surplus. Read the
  comment on `changeGivenPaise` in `counter-desk.tsx` before touching it.
- **`usePatientInHand`** already carries a patient across screens.
- **Print isolation is a live trap.** `styles.css` prints by hiding everything and re-showing
  `.print-doc` at `position:fixed; left:0; top:0`. **Two `.print-doc` nodes overprint each other.**
  See the header of `apps/web/src/components/counter-slip.tsx`. One at a time, always.
- **Existing print components to extend rather than fork:** `token-slip.tsx`, `counter-slip.tsx`,
  `rx-print.tsx`, `invoice-print.tsx`.
- **`photo-capture.tsx` and `patient-picker.tsx`** exist and work.
- **The hospital has no name in the app.** `hospital.name` in `apps/web/src/locales/en.json` is still
  `"Hospital (name pending — roadmap item #5)"`. Real values are on the canvas letterheads.

---

## What is genuinely new

**T1 · Counter sequence becomes configuration.** `opd_config` has no such column today.
Add `counter_sequence` (`queue_first` | `bill_first` | `single_window`) and `flat_fee_paise`.
Extend `letterheadSchema` — it is only `{ name, addressLines }` and the paper needs hotline,
emergency, email, website, and the QR password. Admin screen to set it; the value drives T3.

**T2 · Symptom → department master.** Does not exist. A table mapping a symptom term to a primary
and secondary department, seeded with the fifty commonest presenting complaints in both English and
Hindi, plus a search endpoint returning departments ranked by fit and doctors ranked by live queue
length. This is what makes the front desk symptom-first instead of forcing the clerk to know
specialties.

**T3 · The front desk screen, Flow 3 mode.** Build from `Main.dc.html`. Find-or-register, symptom
picker, visit type, tender (cash / UPI / card / Ayushman-zero-collect), one action that registers,
queues, bills and prints. The drawer strip is a real precondition — no open cashier session, no
finish. Keep the three modes: the same screen must still behave as Flow 1 and Flow 2.

**T4 · The combined 80 mm slip.** 72 mm printable = 576 dots at 203 dpi = 272 css px. Barcode under
the address, four-line patient block plus date, outlined PAID/UNPAID box (**never a filled black
block — heat, head wear and curl**), bilingual next steps, printed-by foot. Exactly one `.print-doc`.

**T5 · Vitals desk.** Barcode scan into the patient, carried-forward height greyed and locked until a
reason is picked from a preset list, old value retained beside the new one, four mandatory readings,
danger ranges flagged to the doctor.

**T6 · Doctor queue.** Only vitals-done patients callable. Class bands. Drag to reorder plus arrow
buttons — the arrows are not a fallback, they are what a tired attendant will actually use. Call next.
Every manual move written down with a name.

**T7 · Display board.** Per department, bilingual, Hindi leading. Token and room only — never a name.

**T8 · One e2e test that walks the demo above**, plus a seed script that creates the demo dataset so
a tester can reset and re-run.

---

## Non-goals — do not build these

Say so and stop if you find yourself starting one: exit-desk order entry, radiology reception,
pharmacy invoicing, the dot-matrix path, the floor board, downtime mode, the keyboard map,
registration's seven exception paths, the ESC/POS raster driver. All are designed on the canvas and
all are later phases. **Ship the walk first.**

---

## What will bite you

- **Hindi on paper.** Read `DevanagariSpec.dc.html`. Non-negotiables: `line-height: 1.55` on every
  Devanagari run; never below 11 pt on a 203 dpi head; **Western digits always**, in their own span;
  never machine-transliterate a patient's name — capture it or print Latin only.
- **Thermal printing is out of scope but browser printing is not.** Print to PDF from the browser for
  testing. An ESC/POS printer cannot type Devanagari at all and needs the slip as a raster image —
  that is a hardware spike, not this phase. Do not let it block T4.
- **Ayushman must say "₹0 — do not collect" in words.** An empty total is what gets a cardholder charged.
- **The test database is shared.** Two sessions running suites in `/opt/hmis` corrupt each other.
  Read the parallel-session protocol; other sessions are active in this repo right now.
- **Migrations are at `0047`.** Yours starts at `0048` — but re-measure with
  `ls apps/core/drizzle/*.sql | tail -1` before you generate, because other lanes are adding them.
- **The working tree is dirty and on `main`.** Branch before you write anything.

---

## Working discipline

1. **Branch first.** `git checkout -b feat/flow3-front-desk`.
2. Small commits, one per task, message in the repo's existing style.
3. `pnpm verify` (typecheck + lint + test) must pass before each commit. If the shared test DB makes a
   local run unattributable, say so and let CI be the instrument.
4. Do not deploy. Deployment is the owner's call, `deploy.sh` runs from a clean tree, and the
   production migration count must be **measured, never remembered**.
5. When a design decision is genuinely open, pick the most defensible Indian-corporate-hospital
   answer, mark it DECIDED with one line of reasoning, and keep going. Stop only for money,
   procurement or law.

## Done means

- The three-step demo runs on a real browser against a real database.
- The Sequence setting flips the front desk between all three flows and nothing else has to change.
- `pnpm verify` is green and CI is green.
- A short close report at `docs/superpowers/plans/reports/` naming what shipped, what was deferred,
  and every judgement call you made.

Start by reading the canvas working files and `counter-desk.tsx`, then tell me your task order and
where you disagree with mine before you write code.
