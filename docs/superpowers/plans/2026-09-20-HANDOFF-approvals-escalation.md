# HANDOFF — escalation, notification, and the matrices that decide who acts when

**For review by Fable.** Written 2026-09-20 on `lane/approvals-spine` (PR #265 open: the authority
fix + the ten-layer spine doc, `2026-09-20-phase-approvals-spine.md`). This file is the brainstorm
the owner asked for before the build of L4 (notify on file), L5 (ladders) and the escalation
mechanism. **Nothing in this file is built yet.** Reviewer: please argue with the model, not the
prose — the sections marked **OPEN** are where I most want to be wrong.

---

## 1. The owner's brief, in his words

> *"The system needs to automatically decide how much urgent, important the event it is to act on.
> As a hospital, every minute counts, that too when each action is connected to the action of the
> next person — so if an approval is needed in the next 6 hours, that doesn't mean the system would
> wait for 6 hours before it escalates to the senior; and if the senior does not act on the junior's
> delayed action, the senior's senior will be notified and he has to action for the senior's delay in
> acting over the junior's delay. We need urgent:important matrix for sure and a lot more other
> matrices that would define free flow operation of hospital, better accountability of staff and
> responsibility too."*

Three distinct demands, and they are not the same feature:

1. **Derive** urgency and importance from the request, rather than stamping them on the type.
2. **Escalate before the deadline, not at it** — the budget is a runway, not a cliff.
3. **Attribute the delay**, recursively: a supervisor inherits an unanswered item *as their own
   failure to supervise*, not merely as extra work.

(3) is the one that is genuinely absent from the codebase and from most approval engines. (1) and (2)
are gaps in configuration and in one kernel seam respectively.

---

## 2. What the engine actually does today — measured, 2026-09-20

| | Finding |
|---|---|
| **E1** | **The ladder only begins AFTER the deadline is fully spent.** `runDueTimers` handles the `sla` timer by emitting `workflow.sla.breached` and *then* scheduling rung 0 at `dueAt + ladder[0].afterMinutes` (`kernel/workflow/timers.ts`). A 6-hour budget with a 30-minute first rung escalates at **6 h 30 m**. The owner's objection is not only right, it understates the problem. |
| **E2** | **No approval type configures a ladder at all**, so today the breach emits into an empty room (all 16 types set `closureSlaMinutes` only). |
| **E3** | **Escalation already reaches humans on two surfaces** once a ladder exists. `alertsConsumer` raises an in-app alert row per recipient (pushed to the browser); `notifyConsumer` enqueues `staff_escalation` to the outbox, and `owner_escalation_sms` when a rung resolves to nobody *and* `duty_manager` resolves to nobody. **Both are built. Neither has ever fired**, because of E2. |
| **E4** | **`approval.requested` reaches neither surface.** Filing notifies nobody. |
| **E5** | **Rung recipients are resolved by `usersHoldingRole` with no availability awareness.** Empty role → `duty_manager` → owner SMS. Nothing knows who is on shift, on leave, or in theatre. |
| **E6** | **No alert or notification may carry patient identity** (Global Constraint 6; mutant-enforced in both consumers). Bodies are built from structural fields only — `defKey`, `state`, `rung`, `role`. This is a hard boundary on everything below. |
| **E7** | **Roles are flat strings. There is no supervisory graph.** "The senior" is not a concept the system can resolve; every ladder would have to be hand-written per type. |
| **E8** | Idempotency for alerts is the `(source_event_id, user_id)` pair, deliberately — one escalation fans to many recipients. Any new fan-out must keep that unit. |

### The one kernel change this needs

`SlaSpec.escalation[]` is `{ afterMinutes, toRole }`, chained from `dueAt`. **Pre-deadline rungs are
not expressible.** Options:

- **(a) Anchor the ladder at state entry.** Let a rung declare `atPercentOfBudget` (or
  `afterMinutesFromEntry`), and have the state-entry path schedule the whole ladder at once instead
  of chaining from breach. Rungs past 100% still work — they are simply percentages above 100.
- **(b) Add a second, pre-breach ladder** (`nudges`) beside `escalation`, leaving the breach ladder
  untouched.
- **(c) Keep the engine and schedule approval-specific timers in the approvals module.** Rejected:
  Plan 03 owns timers on purpose, and the approvals engine was built explicitly to write no timer
  code. Duplicating the claim-and-fire discipline is how two timer systems disagree.

**Recommendation: (a).** One anchor, one ladder, percentages throughout, and "escalate at 40% / 70% /
100% / 150% / 200%" becomes a sentence the definition can hold. It touches `kernel/workflow` —
a coordinate-before-editing area — and it is a behaviour change to a shipped engine, so it wants its
own PR with the timer tests re-run, ahead of everything else here.
**OPEN for review: is (a) right, or does (b)'s smaller blast radius win?**

---

## 3. The urgency × importance matrix

The two axes must drive *different* things. Conflating them is why "priority" fields decay into
noise everywhere they are implemented.

> **Urgency sets the clock — how long, and how often it ticks.**
> **Importance sets the ladder — how high it climbs, on which channel, and how many approvers.**

|  | **Not important** | **Important** |
|---|---|---|
| **Urgent** | **Q3 · DELEGATE** — small discount, patient at the counter. Short budget, low ladder, terminates at the deputy. *This is the auto-grant quadrant.* | **Q1 · DO NOW** — deposit waiver holding an OT list, large refund at a closing counter. Short budget, fast rungs, climbs to the owner, interrupt channel. |
| **Not urgent** | **Q4 · BATCH** — routine acceptances. Long budget, digest only, never an interrupt. | **Q2 · SCHEDULE** — tariff revision, vendor bank change, patient merge. Long budget, but climbs *high*. **The dangerous quadrant.** |

### The two asymmetries that matter

**Q3 is the automation target.** An urgent decision with small consequence is precisely what should
not require a human at 8 p.m. Ruling R2's standing policy should aim here first, and almost nowhere
else at the start.

**Q2 is what the current design systematically under-protects, and it is the reason to build this
at all.** Nothing is blocked, so nobody notices; the budget is long, so the clock is quiet; and the
consequence is the largest in the hospital. `materials_vendor_bank_change` — a fraud control — is a
pure Q2 item, and PR #265 found that *nobody could answer it at all* for an unknown length of time,
with no symptom whatsoever. **A time-pressure-driven escalation ladder does not protect Q2, because
Q2 has no time pressure.** Q2 therefore needs a second mechanism that the ladder cannot provide:

> **The ageing sweep.** Independent of budget: any Q2 item open past *N* days is surfaced as a
> standing item on the owner's rail, and in the weekly digest, with its age in days. It does not
> escalate through roles — it accumulates visibility. Q2's failure mode is being forgotten, not
> being refused.

**OPEN: is the ageing sweep a separate mechanism, or just a ladder with very long rungs?** I believe
separate — a ladder ends when it runs out of rungs, and "forgotten" has no end — but this is the
design choice I am least sure of.

---

## 4. Deriving the two scores automatically

Both computed at file time from the request, stored on the row (so the list sorts in SQL and a
decided row still says why it ranked as it did — phase-doc D3), and both **explainable**: the row
keeps the signals that fired, so the card can say *why* it is urgent rather than asserting it.

### Urgency signals

| | Signal | Source |
|---|---|---|
| **U1** | **Blocking** — is a person or a process waiting on this? A patient physically present, a queue behind the counter, a discharge held, an OT list, a held report, a held dispense. | the subject's own module |
| **U2** | **Perishability** — is a clock running that is not ours? Sample stability, a drug administration window, an appointment slot, the department's closing hour, a statutory deadline. | subject + department hours |
| **U3** | **Compounding** — does waiting create more work than it defers? Queue length behind the blocked step. | queue state |

**U2's closing-hour leg is the sharpest and the cheapest.** A ₹1,200 refund filed at 19:40 against a
counter that shuts at 20:00 has *twenty minutes*, not the type's 240. Budget should be
`min(type budget, time until the deciding desk closes)` whenever U1 is true. This single rule
converts a large share of "the system waited 6 hours" into correct behaviour on day one.

### Importance signals

| | Signal | Note |
|---|---|---|
| **I1** | **Value** — `amountPaise`, banded. | already on the row |
| **I2** | **Exposure** — same-day cumulative for this patient and this payee. | **already snapshotted on the row** (`cumulativePatientPaise` / `cumulativePayeePaise`) — unused by any ranking today |
| **I3** | **Irreversibility** — what does undoing it cost? A discount reverses with a credit note; a merge does not. | per type |
| **I4** | **Blast radius** — one bill, or every bill? `tariff_revision` changes the price of everything. | per type |
| **I5** | **Regulatory / fraud class** — PCPNDT, AERB, narcotics, a vendor's bank account changing. | per type |

**I3, I4 and I5 are per-type constants and should be declared on the type, beside
`closureSlaMinutes`.** Only I1 and I2 are per-request. That keeps the per-request computation cheap
and makes the importance of a *class* of decision reviewable in one table rather than inferred from
behaviour.

**Money is the weakest importance signal of the five, and the most tempting.** The three types PR
#265 found unanswerable are high-importance for reasons that are not rupees: irreversibility, blast
radius, and fraud class. A matrix keyed on amount alone would have ranked all three as trivial.

---

## 5. Escalation as accountability, not just as routing

This is the part with no existing implementation and the part the owner asked for most directly.

### 5.1 The supervisory chain (closes E7)

Declare, **once**, a parent for each role — not sixteen hand-written ladders:

```
cashier          → billing_manager      → medical_superintendent → owner
storekeeper      → materials_head       → medical_superintendent → owner
lab_technician   → pathologist          → medical_superintendent → owner
front_office     → front_office_supervisor → medical_superintendent → owner
...
duty_manager     → owner
```

A type's ladder is then **derived**: the chain above its `approverRole`, truncated at the height
importance earns. Q3 stops at the first parent; Q1 and Q2 run to `owner`. Ruling R3 — money types
end at the owner, clinical and definitional ones at the duty manager — becomes a property of the
truncation rule rather than sixteen copies of a list.

This chain is also the thing that makes "the senior's senior" resolvable at all.
**OPEN: one global chain, or per-department chains?** A hospital with two units has two billing
managers. I lean global-with-department-scoping-later, because the roster (Plan 20) is where
department scoping belongs and it is not merged.

### 5.2 Rungs as fractions of the budget

Not minutes after the deadline — percentages of the runway:

| at | who hears it | what it says |
|---|---|---|
| **40%** | the assignee, again | a nudge. Still theirs. Nothing is recorded. |
| **70%** | the assignee **and** their parent, for information | "this is about to be escalated." The parent is *informed*, not yet accountable. |
| **100%** | the parent, as an action | budget spent. **A delay record opens against the assignee.** |
| **150%** | the parent's parent | **a second delay record opens — against the parent**, for not acting on the first. |
| **200%** | the owner, always, for every type | the chain has failed. |

The 70% rung is the humane one and it is worth defending: it gives a person the chance to answer
*before* anything is recorded against them. An accountability system that never warns is
experienced as a trap, and staff route around traps.

### 5.3 The delay ledger

**A delay becomes an object**, because the owner's requirement is not "tell the senior" — it is
"the senior has to *action* the junior's delay." That needs a thing to action.

One row per (approval, rung) that passes 100%:

```
approval_delays
  approvalId · rung · roleKey · heldByUserIds
  heldFrom · budgetShareMinutes · overByMinutes
  excused (bool) · excuseReason · excusedBy
  closedAt · closedBy
```

It closes when the approval is decided. It survives afterwards as a fact — which is what makes
accountability reportable rather than merely felt.

### 5.4 Excusal — the fairness leg, and it is not optional

> **Never open a delay record against somebody the roster says could not have acted.**

A surgeon who was operating, a manager on sanctioned leave, a person off shift. Escalating past them
is correct — the work must move. *Recording it as their delay is not.* Without this, the first month
of the feature teaches every clinician that the system blames them for being at work, and the
feature is dead.

The roster (Plan 20, `#264`, in flight) is the availability source. Until it merges, the honest
interim is: **escalate, but mark every record `excused: pending` and attribute nothing**, and turn
attribution on with the roster. Shipping attribution before availability is shipping unfairness.

**Acknowledgement** is the second half: an approver may say *"seen, I need 30 minutes, reason"*. It
pauses the nudges, does **not** pause the budget, and is itself recorded. Someone who acknowledges
and then still misses the budget is a different fact from someone who never looked — and the
difference is exactly what a supervisor needs to know.

### 5.5 Working minutes, not wall-clock

A 1,440-minute "routine" budget filed at 18:00 hits 100% at 18:00 the next day — but passes 70% at
about 04:00. **Routine and low-urgency budgets must be measured in the deciding desk's working
minutes.** Q1/emergency stays wall-clock: an OT list does not care that it is 2 a.m.

This is small to implement and enormous for trust. Waking a billing manager at 4 a.m. about a
discount is how a hospital learns to silence the system.

---

## 6. The other matrices the owner asked for

Six, each doing work the others cannot. Numbers 3 and 6 are the ones I would most like Fable to
attack.

| # | Matrix | Axes | What it decides |
|---|---|---|---|
| **M-1** | **Urgency × Importance** | blocking/perishable × value/irreversibility/blast/fraud | §3 — the clock, the ladder height, the channel |
| **M-2** | **Authority × Amount** (delegation of authority) | role × money band | who may decide what size; the standing-policy ceiling (R2). Standard corporate DoA. |
| **M-3** | **Reversibility × Blast radius** | undo cost × how many rows it moves | **single approver, or dual control.** A vendor bank change is the textbook maker-checker case: one person requests, **two** independently approve. The engine today has exactly one approver per request. |
| **M-4** | **Availability × Role** | on shift / on leave / in theatre × role | skip, cover, excuse (§5.4). Source: Plan 20 roster. |
| **M-5** | **RACI per approval type** | Responsible (decides) · **Accountable (owns the delay)** · Consulted · Informed | today a type has only `approverRole`. Splitting **R** from **A** is what makes "the senior owns the junior's delay" a declared fact instead of an accident of ladder order. |
| **M-6** | **Frequency × Variance** | how often this type is granted × how much the decision varies | **which approvals are ceremony.** |

### M-6 deserves its own paragraph, because it is how the agentic layer earns its ceiling

If `billing_discount` under ₹500 is granted 98.7% of the time, with a median decision time of 40
seconds and no rejection in 90 days, **that is not a control — it is a toll booth**, and every one of
those 40-second decisions is a person interrupted. M-6 makes the weekly digest surface *auto-grant
candidates with their statistics*, so ruling R2's ceiling is set by measured behaviour rather than
guessed at. It also runs in reverse: a type with high variance is one where the humans disagree, and
that type must **never** be automated, however cheap it is.

This is the honest answer to "so that agentic AI could operate on hospital OS freely": the machine
does not earn authority by being clever. It earns a *specific, bounded, measured* envelope by
demonstrating that the humans in that envelope were not deciding anything.

---

## 7. What can go wrong (please add to this list)

| | Risk | Mitigation |
|---|---|---|
| **R-a** | **Alert fatigue.** If everything is Q1, nothing is. | Monitor the *distribution*. If more than ~20% of items land in Q1, the thresholds are wrong, and that figure is itself on the dashboard. Cap interrupt-channel sends per role per hour; beyond the cap, digest. |
| **R-b** | **Escalation storms.** The worker is down three hours, returns, and every timer fires at once. | Coalesce per recipient per cycle; discount worker downtime from budgets (the engine already holds that the worker is never load-bearing for a human flow). |
| **R-c** | **Gaming.** If delay is recorded, people reject fast to avoid the record. | Rejection rate per approver, and the reject→refile pattern, are monitored figures. A rejection with a one-tap preset and no reading time is visible. |
| **R-d** | **Blame instead of accountability.** | §5.4 excusal; the 70% warning rung; acknowledgement. Attribution stays off until the roster can answer "could they have acted?". |
| **R-e** | **Patient identity leaking into an SMS.** | Already a hard constraint (E6), mutant-enforced in both consumers. Every new fan-out must be asserted the same way — the recipient reaches the patient through permission-checked routes, never through the message. |
| **R-f** | **The chain dead-ends.** A rung's role has no holders. | The engine already falls back to `duty_manager`, then to owner SMS. The derived chain must not bypass that. |
| **R-g** | **Priority inflation by requesters.** If a requester can mark their own request urgent, everything is urgent. | Urgency is **derived, never typed in**. No field on the request form sets it. |

---

## 8. Proposed build order

Each is a PR. Migrations are one per PR, numbered at rebase.

| T | What | Notes |
|---|---|---|
| **T1** | **Kernel: ladders anchored at state entry** (§2 option (a)), with the timer suite re-run. | `kernel/workflow` — coordinate. Behaviour change to a shipped engine; goes first and alone. |
| **T2** | **`approval.requested` → both surfaces** (closes E4). In-app alert per holder of the approver role; outbox message only for the interrupt lane. | Smallest single win in the whole spine. Independent of T1. |
| **T3** | **The supervisory chain + derived ladders on all 16 types** (closes E2, E7). Ruling R3's money/clinical split becomes the truncation rule. | Needs T1. |
| **T4** | **Urgency + importance derivation**, stored and explainable (§4), with the closing-hour rule. | Migration: the two scores + the signals that fired. |
| **T5** | **The delay ledger** (§5.3) with excusal *pending* and acknowledgement. | Migration. Attribution reports come with the roster. |
| **T6** | **Working-minute budgets** (§5.5). | Needs department hours. |
| **T7** | **M-6 digest** — auto-grant candidates with their statistics. | Read-only; it is what sets R2's ceiling honestly. |
| **T8** | **M-3 dual control** for irreversible + wide-blast types. | Engine change: a request needs two approvers. Largest of these; may not belong in this lane. |

**T2 alone closes the largest measured hole and depends on nothing.** If the review process is slow,
T2 should ship regardless.

---

## 9. Questions for the reviewer

1. **§2** — ladder anchored at state entry (a), or a separate pre-breach `nudges` array (b)? I lean
   (a); (b) has the smaller blast radius on a shipped engine.
2. **§3** — is the Q2 ageing sweep genuinely a separate mechanism from the ladder, or am I inventing
   a second thing where a long ladder would do?
3. **§4** — is `min(type budget, time to desk close)` too aggressive as an automatic rule? It can
   turn a 4-hour budget into 20 minutes without anybody asking.
4. **§5.1** — one global supervisory chain, or per-department from the start? The roster is not
   merged.
5. **§5.4** — is "escalate but attribute nothing until the roster lands" the right interim, or should
   the whole delay ledger wait for Plan 20?
6. **§6 M-3** — is dual control worth its complexity for `materials_vendor_bank_change` and
   `patient_merge`, or is a single high-rung approver plus the delay ledger enough?
7. **Anything in §7 I have not thought of.** Accountability systems fail in ways their authors do not
   predict, and the ones here are the failures I could imagine.

---

## 10. Context the reviewer will want

- **PR #265** (open, this lane): the authority fix — four approval types were routed to a queue no
  holder of any role could open, three of them naming `owner` as approver — plus the invariant that
  catches the next one, plus the ten-layer spine doc.
- **Phase doc:** `docs/superpowers/plans/2026-09-20-phase-approvals-spine.md` — the ten layers,
  fifteen decided semantics, and the three owner rulings of 2026-09-20 (R1 authority, R2 standing
  policy with a conservative ceiling, R3 money escalates to the owner).
- **Spine summary page:** https://claude.ai/artifact/46xT5VoMfrUwRUg27SvVYD
- **Files that matter:** `kernel/workflow/timers.ts` (the ladder), `kernel/workflow/definition.ts`
  (`SlaSpec`), `kernel/alerts/consumer.ts` (in-app), `kernel/notify/consumer.ts` (outbox),
  `kernel/approvals/*` (the engine), `modules/*/approval-types.ts` (the sixteen types).
- **Not merged, relevant:** Plan 20 roster (`#264`) — the availability source §5.4 depends on.
