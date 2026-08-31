# EXECUTE PROMPT — Registration Counter dashboard ("Desk One"), from signed-off design to working software

Paste everything below the line into a fresh Claude Code session opened at `/opt/hmis` on the build host.

---

## Mission

Build the **Registration Counter seat** — the front-desk dashboard the owner signed off on
2026-08-31 — as working software. This is the flagship seat of the **agentic AI hospital OS**:
the clerk (persona: Ramesh Chaudhary, `front_office`) registers, queues, and bills a walk-in
without losing the patient between pages, while an agent surface does visible, logged, useful
work alongside him.

You are not designing. The design is decided, clickable, and lives in this repo as HTML you can
open and lift exact values from. You are also not coding straight from this prompt: **author
phase documents per `docs/superpowers/EXECUTE-METHOD-V3.md` first**, then execute them. This
prompt is the design-to-engineering handoff: what was decided, what exists, what is genuinely
new, and where the traps are.

## The one demo that proves it is done

A tester, using only the app, in one sitting:

1. **Returning member.** Searches `98012` → the patient card shows *why* it matched (same
   mobile — never a percentage). Picks her. An **in-sight agent card** offers her active
   membership; one click applies it and the bill column reprices 20% off before billing is ever
   opened. Queues her to the shorter General Medicine line (queue length + minutes + clock time
   shown), takes UPI, and watches the token flip UNPAID → PAID on the board.
2. **Review revisit.** Picks a patient inside her doctor's review window → the bill forces
   itself to ₹0 with the rule named on screen, no tender buttons appear, and the token releases
   on confirm.
3. **Supervisor flow flip.** From the locked flow pill, switches the counter to
   Register → Bill → Appointment. The next patient is billed a flat consult fee first and their
   token leaves the printer already PAID.
4. **New walk-in.** Registers in four fields, attaches a channel-partner referral, books her a
   **future appointment mid-walk-in without dropping today's session**, and finishes. Every
   autonomous thing the agent did is in the footer log with a timestamp.

If those four run without narration, the phase series is done.

## Read these first, in this order

| What | Where |
|---|---|
| Mission & vision — the whole project brief | `docs/PROJECT-BRIEF-2026-08-30.md` |
| **The signed-off design (open it in a browser, click through it)** | `docs/design/2026-08-31-registration-counter/desk-one.html` · live: https://claude.ai/code/artifact/80a2bb44-fea9-4e0e-b4f5-aadfcf55ad0e |
| The agentic-vision variant — its schema §4 is the agent-surface build list | `…/counter-cockpit.html` · https://claude.ai/code/artifact/12ab9804-3efd-4c81-8f8b-18a57df14781 |
| The rejected-but-mined greyscale variant | `…/greyscale-stages.html` · https://claude.ai/code/artifact/3d23c67d-9d18-4845-9b75-d43008a1ce22 |
| Method — one doc per phase, LIGHT lane, stop-loss | `docs/superpowers/EXECUTE-METHOD-V3.md` |
| Rules every coding agent must hold | `docs/superpowers/AGENT-RULES.md` |
| The lessons ledger — at minimum §5 | `docs/superpowers/plans/reports/EXECUTION-LESSONS.md` |
| **Before running any test or deploy** | `docs/superpowers/plans/reports/2026-08-26-parallel-session-protocol.md` |
| OPD/front-desk brainstorm — read §1/§13/§14 before authoring any phase doc | `docs/superpowers/brainstorms/2026-08-27-department-series/` |
| The current counter screen and its header reasoning | `apps/web/src/screens/counter-desk.tsx` |
| Fee quote / invoice / cashier-session precondition | `apps/web/src/lib/billing-api.ts` |
| The cross-screen patient session that already exists | `apps/web/src/lib/patient-in-hand.tsx` |
| Palette discipline of the shipped app | `apps/web/src/styles.css` |

## The owner's design rulings — carry these, do not relitigate

All from anchored artifact comments and messages, 2026-08-31:

1. **Desk One is the base.** Paper-and-pine identity: green-biased paper `#f4f7f4`, pine ink
   `#132420`, hospital green `#0e6b4e` (primary/settled), marigold `#dd8f1c` (UNPAID, heavy
   queues, missing data), mint `#35c48f` as the agent's voice — **always on pine, never on
   paper**. Type: IBM Plex Sans / Plex Mono (everything compared digit-by-digit, and section
   labels) / Plex Sans Devanagari (the say-this-to-the-patient lines).
2. **Keep the minimized footer agent bar** — ticker of the agent's latest action + ask box (F2)
   + pull-up log. Ruled explicitly: "I would like to have it in the final design."
3. **Keep the search-first opening** — "Who is in front of you?" with register-new enabled only
   after a search has run. Ruled on both its title and subtitle.
4. **Keep Ctrl+K** (command palette) and the **live "N waiting · Q" pill** in the header.
5. **Agent info cards must sit in the line of sight, not a sidebar.** Ruled on the greyscale
   variant: "It should be visible right in the sight… because of placement often will get
   missed." Desk One's inline pine chips at the point of decision are the pattern; a right rail
   is not.
6. **The dossier column with the live bill.** The patient session is a left column that
   accretes — identity, flow steps, benefit chips, token, and a bill that reprices from the
   first chip. Billing as a screen only chooses the tender.
7. Standing rulings from the seat-pass (see the ruling block in
   `docs/superpowers/plans/2026-08-30-DESIGN-PROMPT-enquiry-counter.md`): English leads staff
   screens, Hindi leads paper · UNPAID is an **outlined** box, never filled black · 72 mm / 272 px
   slips, western digits, `line-height 1.55` on Devanagari · dates as `31-Aug-2026`.

**One decision to surface, not make silently:** the shipped app is shadcn greyscale
(`styles.css`); the owner picked Desk One's paper-and-pine for this seat. Propose the theming
mechanism (a token layer over the existing variables vs. a per-seat theme) in the first phase
doc and get a ruling before restyling anything outside this seat.

## Ground truth — already built; verify, then reuse, never rebuild

Measure everything; remember nothing (prod migration count included — the owner's standing rule).
As of 2026-08-31 these exist. Confirm each before authoring:

- **A one-screen counter is deployed** (07a–07d, live at hmis.crkmch.com): find/register, fee
  quote, invoice, change-handed-back (`0039`), PHI read logging (`0038`), confidential-alias
  cover on all four routes. This seat **extends or replaces `counter-desk.tsx` — decide which in
  the phase doc**, and check first for counter rails built server-side but never wired (that was
  the 07-diagnosis pattern; wire before you build).
- **`usePatientInHand`** (`apps/web/src/lib/patient-in-hand.tsx`) already carries a patient
  across screens — the dossier column is a *rendering* of it, not a new session store.
  `patient-picker.tsx` and `patient-strip.tsx` exist.
- **`fetchFeeQuote` / `issueInvoice`** in `billing-api.ts`, with the cashier-session
  precondition enforced server-side. The live bill is a client composition over the quote — the
  pricing pipeline itself belongs server-side.
- **The priority ladder** `opd.queueClass` 0–4 is computed server-side; display it, do not
  invent an ordering.
- **Registration validation**: `dob_or_age`, `minor_needs_guardian`, IAL rungs
  (`staff_verified` → `id_verified` → `abha_verified`), UHID generation, and the post-create
  merge workflow. There is **no pre-create duplicate check today** — the search-first ruling
  (#3) is the design's answer; build the gate, reuse the merge machinery for what slips through.
- **Print isolation is a live trap**: one `.print-doc` node at a time, always. Extend
  `token-slip.tsx` / `counter-slip.tsx` / `invoice-print.tsx`; never fork them.
- **Check whether flow3's T1 shipped**: `counter_sequence` on `opd_config`
  (`queue_first | bill_first | single_window`) may already exist from
  `2026-08-29-EXECUTE-PROMPT-flow3-front-desk.md`. If it does, the design's F1/F2/F3 maps onto
  it plus one new axis: **token lane** (token-first-UNPAID vs token-on-payment). If it does not,
  both are new config.

## What is genuinely new — the build list to cut into phases

Cut these into 2–4 phase docs by the method; suggested grain below. Where a call is open, pick
the most defensible Indian-corporate-hospital answer, mark it DECIDED with one line, and keep
moving. Stop only for money, procurement, or law.

**A · Flows and the token lane.** `counter_sequence` + `token_lane` as supervisor-locked config
(`counter_supervisor` — check the role census; 146 permissions / 33 roles as of 18a-T2). Token
state machine: issued-UNPAID → flipped-PAID on settle; held → released-PAID on settle;
bill-first → born PAID. The lock pill wears the setting openly in the header.

**B · Benefits & pricing pipeline.** Server-side, feeding the quote: membership (percentage),
channel-partner referral (percentage + a **partner ledger entry** for month-end commission),
coupon (flat, single-use), corporate/cashless (zero-collect, bill to panel, e-authorisation
record), care package (consult covered, usage counter), **review-window auto-₹0** (window
sourced from the consult record; the rule named on the receipt). Stacking order as designed:
membership % → referral % → coupon flat → overrides (review/package/corporate). Late attach at
billing reprices in place. **Permission split is a ruling, not a UX nicety**: this seat
*applies* membership benefits and cannot *enrol* — enrolment is the front-office manager.
Model it as two permissions from day one.

**C · The seat itself.** Desk One's screen: search-first find (match *reasons*), four-field
register, dossier column over `usePatientInHand`, symptom → department/doctor ranking with
queue length + minutes + clock-time waits (v0 = queue × configured avg; keep the seam for a
pace model), assign-to-doctor / join-dept-pool, future appointment mid-walk-in (session
preserved), audited demographics edit, keyboard map (Ctrl K · Ctrl N · Q · 1/2/3 tender ·
Ctrl ⏎ · Esc), queues overlay.

**D · The agent surface, v0 — honest about what it is.** The UI contract is the product; the
intelligence arrives in layers. v0 ships **deterministic rules rendered in the agent voice**:
the footer ticker + log driven by real system events (membership verified, token flipped,
receipt issued, record amended…), and in-sight suggestion cards from rules the data already
supports (member-with-unapplied-benefit, inside-review-window, shorter-queue-for-symptom,
missing-address). Every autonomous act lands in the log with a timestamp — this event stream
(`agent_ledger`) is a real table, because it is the audit answer to "what did the AI do?". The
ask box can ship v0 with queue/price/policy lookups; the LLM behind it is a later phase — build
the seam, not the model. `counter-cockpit.html`'s schema §4 lists the fuller surface
(pre-registrations, household links, wait model, drawer ledger…) — **do not build those in this
series**; they are the roadmap the owner has seen, and each needs its own ruling.

**ABHA** is an integration seam, not a feature you can finish: build the create/verify UI states
against a stub and **stop for the owner** where real ABDM credentials/procurement begin.

## Discipline

- Two coding lanes must never share this checkout (`2026-08-29` collision: a local
  `pnpm verify` became unattributable). One lane, or worktrees per the protocol doc.
- `pnpm verify` green in one run is the bar; prove the test DB after the fact if in doubt
  (ledger §2.144-era lessons).
- **Do not deploy.** Production has never left `commissioning`, has one admin, and the owner
  holds the deploy. Code-complete + verified is this series' finish line.
- Close every open item on a phase before the next; name the owner's rulings in the close
  report. Feature-complete with an unnamed open judgment call is not closed.

## Start here

Read the brief, the design (actually click through it — the flows, the review-₹0 path, the
lane behaviors are all live in it), then the ground-truth files. Come back with the phase cut
(A–D above is a suggestion, not a ruling), what you found already wired vs. missing on the
07-series counter, and the one or two decisions that need the owner — **before** you author
phase one.
