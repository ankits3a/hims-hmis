# The approvals spine — owner request 2026-09-20

> *"approval screen at https://hmis.crkmch.com/approvals needs a major change. It lacks action
> button. It lacks the flow of information on which the user has to take an action and why. It lacks
> if the action is urgent, important or can wait. Because if approvals are delayed then the whole
> chain of operations freezes. I need a cutting edge approval mechanism/backbone because the whole
> operating system relies on it. The dashboard must prioritize approvals. Get me enterprise grade
> approval mechanism spine backbone so that agentic AI could operate on hospital os freely and human
> staff could actually perform better."*

The inbox was redesigned yesterday (#258, `3e6c0e9d`, deployed) and the owner still cannot act on it.
That is not a regression in the redesign. It is four structural holes underneath it, three of them
**measured as never having been wired at all**. This doc names each, with the measurement, and says
what closes it.

## What was measured, 2026-09-20 (this is the diagnosis, not an opinion)

| # | Finding | Evidence |
|---|---|---|
| M1 | **The `owner` role cannot read or decide approvals.** It holds `approvals.types.manage` and neither `approvals.requests.read` nor `.decide`. The nav entry is gated on `.read` (`router.tsx:162`); the card renders the words "you cannot decide this" in place of the two buttons when `can("approvals.requests.decide")` is false (`approvals-inbox.tsx`, `canDecide`). **This is "it lacks action button", exactly.** | `scripts/seed-roles.ts` — owner block is lines 682–761; `approvals.requests.read`/`.decide` appear only at 645–646 (`billing_manager`) and 808–809 (`medical_superintendent`) |
| M2 | **Filing an approval notifies nobody. Ever.** `notifyConsumer` has branches for patient-registered, appointment booked/rescheduled/cancelled and `escalation.triggered` — and none for `approval.requested`. The approver learns a request exists only by opening the screen and looking. | `kernel/notify/consumer.ts:68–92` |
| M3 | **No escalation ladder is configured on any approval type.** `approvalFlowDefinition` accepts an `escalation` ladder and the engine fires it (`workflow/timers.ts`, `escalationTriggered`, and notify's `staff_escalation` + `owner_escalation_sms` templates are all built). Zero of the 16 registered types pass one. So an approval breaches its SLA, emits the breach, and then nothing climbs — it waits for the same one person, forever. | `grep escalation apps/core/src/modules/*/approval-types.ts` → only `closureSlaMinutes` |
| M4 | **The dashboard does not carry approvals.** `/` is `Desk` (`router.tsx:557`). Its only mention of approvals is a link inside the cash-drawer panel shown when a drawer is stuck in `closing`. No count, no urgency, no rail. | `screens/desk.tsx:238`, sole occurrence |

Three further gaps are design, not absence:

- **M5 — urgency is fixed per TYPE, never per request.** `urgencyClass` is snapshotted from
  `approval_types` at file time, so a ₹50 discount and a ₹50,000 discount are both `urgent`. Nothing
  in the row knows whether a patient is standing at a counter. The owner's "urgent, important or can
  wait" cannot be answered by the data as it stands.
- **M6 — the card cannot show the case.** `subjectType`/`subjectId` is carried on every row and
  rendered nowhere; `GET /approvals/:id` returns the bare row. The approver sees a sentence and the
  requester's note, and nothing about the bill, the patient's ledger, or what saying no does.
- **M7 — an agent cannot file an approval.** `requestApproval` and both decisions throw
  `user_actor_required` (`requests.ts:36`, `decisions.ts`). Agents are marked as "the Plan 12 seam".
  As it stands an agentic worker cannot participate in the approval chain at either end.

**The good news, and it is most of the work:** the engine underneath is sound. Requests ride real
workflow instances, transitions are single-winner, SoD (requester ≠ approver) is enforced with its
own audit write, decisions are mandatory-note and evented, SLA timers are rows fired by the worker,
and cumulative same-day exposure is already snapshotted per patient and per payee. The ladder, the
breach event and the escalation notification templates are all **built and unused**. The spine below
is mostly configuration and surfacing of shipped machinery — not new machinery.

---

## The spine — nine layers

### L0 · The approver can act
Grant the authority that makes the screen answerable (see **OPEN R1** — this one is the owner's,
because it is an authority and DPDP question, not a standard answer).

### L1 · Every request carries its own case — the decision packet
Each approval type declares a server-side **packet builder**: given this request, return the facts
that decide it (the bill and what is on it, the discount as a percentage as well as rupees, what the
patient has already been given today, what they have paid, the policy band that applies), the
**consequence of yes**, the **consequence of no**, and a **recommended answer with its reason**.

Typed and structured, served from `GET /approvals/:id`. The human card renders it; an agent reads the
same payload. One source, two readers — that is what makes L7 and L8 safe later.

### L2 · Priority is computed per request — Now / Today / Can wait
A priority computed **at file time** from: the type's base class · the amount band · **whether
somebody is blocked** (a patient at a counter, a discharge held, an OT list waiting) · same-day
cumulative exposure · the counter's closing hour.

"Blocked" is the load-bearing one and it is the owner's own sentence — *if approvals are delayed the
whole chain of operations freezes*. An approval with a patient standing in front of someone is a
different object from one without, and the inbox must say so. Three lanes, named in plain words:
**Now**, **Today**, **Can wait**.

### L3 · The clock is the SLA, and it is on the card
The worklist returns each row's SLA due time and breach state from its workflow timer. The card says
**"due in 25 min"** or **"overdue by 3 h"** — not "2 hours ago". Overdue rows sort to the top and are
red. A breach becomes a fact the approver sees, instead of an event nobody reads.

### L4 · Filing tells somebody (M2)
`approval.requested` gets its notify branch: every holder of the approver role, on the channel the
priority earns — in-app always; SMS/WhatsApp for the **Now** lane. This single branch is the largest
part of the freeze the owner is describing.

### L5 · Ladders configured on every type (M3)
Every one of the 16 types gets a real ladder: approver → deputy role → duty manager → owner, with
rungs sized to the type's SLA. No engine work — `approvalFlowDefinition` already takes it, the timer
runner already fires it, and both escalation templates already exist.

### L6 · Cover — nobody is a single point of failure
An approver hands their queue to a deputy for a window (who, from, to, why), audited, bounded and
revocable. It **never widens authority**: the deputy must already be able to hold that role. Today if
the billing manager is on leave, all five billing types freeze and the only way out is a duty manager
minting a temp role by hand. The roster being built in Plan 20 is the natural source of who is
actually on duty.

### L7 · Standing policy — bounded auto-decision
The hospital pre-declares, in a policy table per type, what needs no human: a ceiling, the conditions,
an effective window, the human who authored it and a review cadence. A request that satisfies a live
policy is granted **by the policy**, citing its author, instantly — fully audited, reversible, and
reported in a weekly digest of everything auto-granted.

This is an ordinary corporate **delegation-of-authority matrix**, which is the standard answer at any
corporate hospital. Below the ceiling the chain never stalls; above it a human always decides. It is
also the honest floor for agentic operation: the machine does not get judgement, it gets a
pre-authorised envelope. **OPEN R2** — the ceiling is money, so it is the owner's.

### L8 · Agents may ASK; only humans and policy may ANSWER
Open the **request** seam to agent actors, carrying both the agent's identity and the human principal
it acts for, so SoD still binds (an agent acting for the requester cannot let that requester approve).
Keep **decide** closed to humans and policy — permanently.

That asymmetry is the whole safety argument: agents generate work and prepare the case, humans and
pre-declared policy dispose of it. It is what lets an agentic worker operate the hospital OS without
ever holding authority it was not granted in advance.

### L9 · The dashboard leads with approvals (M4)
A standing rail at the top of `/`: **"3 waiting · 1 overdue · ₹4,200 at stake"**, the top item
decidable in one tap without leaving the screen, coloured by lane, plus a count badge in the nav.
Visible to anyone who can decide anything; absent for everyone else.

---

## DECIDED (not money, procurement or law — standard answers, taken and recorded)

| # | Decision |
|---|---|
| D1 | **Three priority lanes, named in plain words:** Now / Today / Can wait. Not P1–P3, not colours alone. The owner asked in those words and staff will use them. |
| D2 | **Blocking beats money.** A ₹200 approval with a patient at the counter outranks a ₹20,000 one with nobody waiting. A queue that has stopped is the more expensive of the two. |
| D3 | **Priority is computed at file time and stored on the row**, like `urgencyClass` and the cumulative snapshots already are — so the worklist orders in SQL and a decided row still says why it was urgent when it was filed. Age re-ranks within a lane; it never moves a row between lanes. |
| D4 | **`urgencyClass` stays and keeps its meaning.** The new priority is an additional column, not a rewrite: it is the type's floor, and a request may be raised above it, never below. Nothing that reads `urgencyClass` today changes behaviour. |
| D5 | **The packet is server-built, per type, and never invented on the client.** A type with no builder yet falls back to today's sentence — the engine is generic and a new module must be able to register a type before anyone writes its packet. |
| D6 | **Consequence-of-no is mandatory in every packet.** "The patient pays the full ₹1,250 and leaves" is the half of the decision the current screen never shows. |
| D7 | **The recommendation is advisory and always attributed** ("policy band C allows up to 10%"). It never pre-selects a verdict, never hides a button, and an approver who disagrees files no extra justification. |
| D8 | **The SLA clock shows remaining time, not elapsed.** Overdue is stated as overdue, with by how long. |
| D9 | **Notification channel follows the lane, not the type**: in-app for all three, SMS/WhatsApp added for Now. Routine approvals never wake anybody at night. |
| D10 | **The rail on `/` shows at most three rows plus a count.** A dashboard that lists twenty approvals is a second inbox, and the owner asked for prioritisation, not for the inbox twice. |
| D11 | **Escalation notifies; it never re-assigns.** A climbed rung widens who *may* act; it never takes the request away from the original approver, and the card says who else can now see it. |
| D12 | **Cover is a grant with an end time, and it is logged as a grant.** No open-ended delegation, no silent inheritance. |
| D13 | **A policy-granted approval is recorded as a decision by the POLICY**, naming its human author, with `decidedBy` never impersonating a person who did not look at it. |
| D14 | **Auto-grant is reversible for the rest of the working day** by any human who could have decided it, without a fresh approval. |
| D15 | **Agent-filed requests are visibly agent-filed** on the card ("asked by the pharmacy agent, for Dr Sharma"). An approver always knows whether a human or a machine assembled the request. |

## OPEN — owner rulings owed (money, authority and law; CLAUDE.md reserves these)

- **R1 · May the `owner` role read and decide approvals?** Granting `approvals.requests.read` +
  `.decide` is what puts the buttons on the owner's screen. It also shows patient names in every
  approval — and the `owner` role deliberately excludes `patients.read` today on DPDP
  minimum-necessary grounds (a recorded 2026-08-26 ruling). The alternatives are: grant both
  (simplest, and the owner sees names); grant them only for money types; or leave the owner out of the
  chain and have the medical superintendent and billing manager decide, with the owner reading a
  digest.
- **R2 · Standing policy (L7) — yes or no, and at what ceiling?** Whether the hospital pre-authorises
  routine approvals below a limit at all, and what the limit is per type. Pure delegation of financial
  authority.
- **R3 · Who catches an approval nobody answered?** The engine's default last rung is
  `duty_manager` (`workflow/timers.ts`, `DUTY_MANAGER_ROLE`). For money the owner may want the last
  rung to be himself.

## Not settled here

- Whether cover (L6) reads the Plan 20 roster or stands alone. Plan 20 T1 is `#264` and in flight;
  taking a dependency on an unmerged lane is how two lanes become one. Cover ships standalone and
  reads the roster when the roster lands.
- The packet builders for all 16 types are not one lane's work. The five billing types plus the two
  patient-merge types are 90% of what this hospital actually files; the rest fall back to D5.
