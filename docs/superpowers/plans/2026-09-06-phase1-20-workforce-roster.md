# Phase 20 — The workforce and roster substrate

**Authored 2026-09-06 in lane `radiology`. FOR APPROVAL. NOT EXECUTED.**

ROADMAP v2 §2 week 3 names this as the radiology lane's next authoring goal, 18b-ii being gated on
PACS rulings. Everything in §2 was measured at `main` today; **three of the roadmap's own figures did
not survive that measurement** and are corrected there rather than repeated.

---

## 1. Why this phase

Every escalation in this system currently ends at *"everybody holding a role"*. There is no notion of
who is **on duty**, so a critical finding at 02:00 rings every duty manager on the roll, the lab's
critical ladder rings the same way, and the mini-OT's anaesthetist on-call is a list rather than a
person. `usersHoldingRole()` is the static resolver that makes that true, and this phase replaces it
with one that knows the date and the shift — behind a flag, with the static answer as the fallback.

**It is a substrate, not a feature.** Nothing renders a roster to a patient. What changes is that a
question the building already asks — *"who do I tell?"* — starts having a correct answer.

---

## 2. Ground truth — measured 2026-09-06 at `main`; re-measure at kickoff

| fact | measured |
|---|---|
| **`usersHoldingRole` real call sites** | **3 runtime files + 2 seed scripts.** `kernel/alerts/consumer.ts` (5 calls), `kernel/workflow/timers.ts` (2), `kernel/notify/consumer.ts` (1); `scripts/seed-ops.ts` (4), `scripts/seed-roles.ts` (1) |
| **the roadmap's list** | names `modules/ot/lists.ts` — which **mentions the function in a comment and never calls it** — and `kernel/workflow/roles.ts`, which is the DEFINITION. It omits both seed scripts. Its two figures ("exactly five", then "7 consumer files — five runtime, two seed scripts") disagree with each other and with the code |
| **a second resolver the roadmap does not name** | `usersHoldingRoleAtScope`, 2 call sites, both in `scripts/standup-check.ts` |
| **the escalation ladder** | **already data.** `timers.ts` resolves `rungSpec.toRole` per rung, with a duty-manager fallback and an owner-SMS exhaustion path |
| **the chasers' destination** | **a CODE CONSTANT, not a configuration row.** `handleImagingCriticalOverdue` and `handleImagingReportUnread` each call `usersHoldingRole(tx, DUTY_MANAGER_ROLE)` in `kernel/alerts/consumer.ts` |
| existing roster / shift / on-call tables | **none.** The only table matching is `lab_critical_calls`, which is a call LOG |

**The blast radius is smaller than the roadmap claims, and the shape is different.** Three runtime
files, not five or seven. But one of the three is `kernel/alerts/consumer.ts`, which CLAUDE.md lists
among the files that belong to everyone — so this phase coordinates on a shared kernel file, and that
is the real coupling cost rather than the count.

**And the roadmap's premise that "the chaser's destination is a configuration row, never a code
constant, so 20 re-points it without touching the chaser" is half true.** The chaser is untouched —
it emits an event and names nobody, which is 18a-iii D7 working exactly as designed. But the
destination is a constant in the kernel's alerts consumer, and making it a row is **this phase's
work**, not a property it inherits.

---

## 3. Spike — answered by reading at kickoff, 0 subagents

1. **Is `usersHoldingRole`'s signature the whole seam?** It takes `(tx, roleKey)` and returns user
   ids. A date-aware resolver needs an instant. Read whether every call site has one in scope, or
   whether some would have to invent "now" — a resolver that defaults its own clock is how two
   answers to "who is on duty" get into one building.
2. **What does the seed-script half want?** `seed-ops.ts` and `seed-roles.ts` use it to COUNT holders
   for a readiness report. That is a question about the roll, not about the shift, and it probably
   should keep the static resolver for ever. Decide it in the open.
3. **Does `lab_critical_calls` already model a contact attempt** well enough to be the ladder's
   record, or does this phase need its own?

---

## 4. Design decisions — DECIDED; none is money, procurement or law

- **D1 — The roster is its own kernel-adjacent module `roster`, not a module's private table.**
  18c's D1 argument for `aerb`, applied again: radiology, the lab, the OT and the front desk all owe
  the same rows, and a roster owned by whichever department shipped first becomes that department's
  by accident. `roster` is app-and-worker, because the resolver is read from both.
- **D2 — The resolver is FLAGGED and the static answer is the fallback.** `ROSTER_RESOLVER_ENABLED`
  off, or no published roster covering the instant, resolves exactly as today. **The fallback is not
  an error path**; a hospital that has not published next week's roster must still escalate.
- **D3 — A roster is a DRAFT until it is published, and publication is a governed act.** An unpublished
  roster is invisible to the resolver. This is the tariff-version shape, for the same reason: a
  half-entered roster that silently started answering "who is on call" is worse than no roster.
- **D4 — The Coverage Resolver is a pure function and proposes only; the duty manager approves every
  proposal.** The roadmap's scope cut, kept exactly. **No automatic reassignment, ever** — a system
  that moved a named anaesthetist onto a night it computed they were free would be making a
  staffing decision at 02:00 on evidence nobody re-read.
- **D5 — Import is CSV; HR-SaaS sync is deferred until an HR SaaS exists.** Procurement.
- **D6 — The escalation destination becomes a configuration row, and that is a task here.** Ground
  truth says it is a constant today. The ladder becomes `named clinician → on-call → duty manager`,
  with the duty manager as the last rung and never removed — §0 row 11's ruling, and the fallback
  D2 already requires.
- **D7 — A shift is a WINDOW, not a day.** A night shift crosses IST midnight, and every date bug in
  this repository has been a UTC/IST day boundary. The resolver takes an instant and compares
  against `[startsAt, endsAt)`; it never asks what day it is.

---

## 5. Tasks — one PR each, fail-first, rail + consumer together

### T1 — CRITICAL · The roster tables and the publication gate
`roster_periods` (draft/published/superseded), `roster_assignments` (user, role, window). The
publication ceremony and its supersede-in-one-transaction. No resolver yet.

### T2 — CRITICAL · The resolver, flagged, with a parity test
`whoIsOn(tx, roleKey, at)`. **The test that matters is the parity one**: with the flag off, or with
no published roster covering the instant, it returns exactly what `usersHoldingRole` returns — same
ids, same order — over a fixture with several roles and several holders.

### T3 — CRITICAL · The three runtime call sites move behind the flag
`alerts/consumer.ts`, `workflow/timers.ts`, `notify/consumer.ts`. **The seed scripts do not move**
(spike 2): counting the roll is a different question from resolving the shift.

### T4 — ROUTINE · The CSV import
One period per file, validated whole before the first write — `seed:staff`'s posture, for the same
reason.

### T5 — ROUTINE · The escalation destination as a row (D6)
The two radiology chaser branches and the lab's critical ladder resolve their rung from configuration
rather than `DUTY_MANAGER_ROLE`. **18a-iii's chaser is not edited** — it names nobody and must not
start.

### T6 — ROUTINE · The coverage proposal, and the duty manager's approval
The pure function, the gaps it reports, and the screen that shows a proposal nobody has accepted yet.

### T7 — ROUTINE · The census row and the runbook
`standup:check` gains a row that is RED when the resolver is enabled and no roster is published —
the state in which the flag is on and every escalation has quietly fallen back.

---

## 6. Out of scope — named so nobody infers them

- **Attendance, leave, payroll and biometrics.** A roster says who is *meant* to be on. What actually
  happened is a different system and a different set of laws.
- Any change to `usersHoldingRoleAtScope` or `standup-check`'s two call sites.
- HR-SaaS sync (D5), and automatic reassignment (D4).
- **The alert `title` and `body` remain English server prose.** That is a real gap — the alerts bell
  renders a server string on a screen that otherwise translates — and it belongs to whichever phase
  takes the refusal-localisation work, not to this one.

---

## 7. Owner rulings — money, procurement, law

**One, and it does not block T1–T3.** *Does an on-call person's contact detail live in this system?*
The resolver returns user ids and the alerts land in-app, which needs nothing. The moment the ladder
is expected to telephone somebody it needs a number, and a staff phone number is personal data under
DPDP with a retention answer attached. **T1–T7 as written need no number.**

---

## 8. CLOSE — filled at execution
