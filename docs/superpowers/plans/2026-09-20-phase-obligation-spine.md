# Phase: the obligation spine — owner request 2026-09-20

**Lane:** `obligation-spine` (docs) → build lanes per task below. **Supersedes** the build order in
`2026-09-20-HANDOFF-approvals-escalation.md` §8 and extends `2026-09-20-phase-approvals-spine.md`
(PR #265) rather than replacing it: L0–L9 there stand; this phase is the engine beneath L4–L6 and
the seats beyond approvals.

**Brainstorm set:** `brainstorms/2026-09-20-obligation-spine/` — `00-FABLE-REVIEW.md` (the model),
`01-STAFF-CENSUS.md` (every seat), `02-EDGE-CASES.md` (the register). Read those three, not this
doc's history.

## The owner's brief

Every event that needs a human act must find the right human, in time, on a medium that can reach
them, and if it does not, the person above them inherits it as their own failure to supervise.
Every seat in the building, gate guard to owner, and the AI agents beside them.

## Owner rulings

| | ruling | date |
|---|---|---|
| R1–R3 | authority for `owner`; standing policy with conservative ceilings; money ladders end at the owner | 2026-09-20, phase-approvals-spine |
| RU-4 | per-person channel ladder app → WhatsApp → SMS → call, climbing on no action | 2026-09-20, roster brainstorm |
| **RO-1** | **all support-service classes carry obligations** | 2026-09-20 |
| **RO-2** | **contractor supervisors sit on the same delay ledger as employees** | 2026-09-20 |
| **RO-3** | **English is the primary language, Hindi next** | 2026-09-20 |
| **RO-4** | **First build: in-app notifications and approvals, plus Chrome (Web Push) notifications.** DLT SMS registration and the WhatsApp API purchase are STARTED by the owner. | 2026-09-20 |
| **RO-5** | **Contractor delay records may be exported to the contracting firm.** | 2026-09-20 |
| **RO-6** | **R2 ceilings: follow top-hospital standards or the most logical answer** (delegated; the table below is the answer, reversible same-day per D14). | 2026-09-20 |
| **RO-7** | **The ageing sweep's interval: whatever is most logical** (delegated; O14 below). | 2026-09-20 |

**Still owed:** voice/IVR provider (only after the first two are live) · DND consent wording with
counsel · the date the DLT header and WhatsApp templates are approved (gates T4's external legs).

## R2 · Standing-policy ceilings, per type (RO-6)

Bands are the standard Indian corporate-hospital delegation of authority: a counter grant is small
and same-day reversible; anything definitional, identity-bearing or fraud-class never auto-grants.
Every policy row also carries: **self-pay only** (no TPA, no credit accounts), **first request of
the day for this patient and this payee** (the row's `cumulativePatientPaise` / `cumulativePayeePaise`
snapshots make this a free check), author = owner, weekly digest (T11), quarterly review.
"Never" means the type has no policy row at all.

| type | auto-grant ceiling | why this number |
|---|---|---|
| `billing_discount` | ≤ 5 % of the bill **and** ≤ ₹1,000 | the front-desk band at corporate hospitals is 5 %; a rupee cap stops 5 % of a large IPD bill |
| `billing_clearance_discount` | ≤ ₹500 | discharge rounding; anything larger is a write-off decision |
| `billing_refund` | ≤ ₹2,000, **and** only for a service not yet rendered, to the original tender | an unrendered service refunded the way it was paid is bookkeeping; cash-out of a rendered service is a control |
| `billing_credit_extension` | **never** | credit is money at risk; a human always |
| `billing_variance` | short or excess ≤ ₹100 per session, with the cashier's note | the universal cash-drawer tolerance; above it a manager reads the session |
| `lab_unpaid_report_release` | balance ≤ ₹200 | a balance that costs more to chase than it is worth should not hold a report |
| `membership_honour_unknown_card` | **never** | identity control |
| `materials_near_expiry_acceptance` | remaining shelf life ≥ 6 months **and** line value ≤ ₹10,000 | the standard receiving rule; below 6 months a human, above ₹10,000 a human |
| `materials_stock_adjustment` | \|variance\| ≤ 0.5 % of the item's counted value **and** ≤ ₹2,000 per item, **never** narcotic or cold-chain | count noise vs shrinkage |
| `materials_vendor_bank_change` | **never**; sequential dual control (O15) | fraud class |
| `tariff_revision` | **never** | blast radius: every bill |
| `radiology_definition_publish` | **never** | definitional; PCPNDT and AERB policy inside |
| `ot_definition_publish` | **never** | definitional |
| `ot_deposit_shortfall_exception` | shortfall ≤ 10 % of the deposit **and** ≤ ₹5,000 | the list must not stall for a rounding gap; a real shortfall is the owner's (R3) |
| `patient_merge` | **never**; sequential dual control (O15) | irreversible identity |
| `patient_unmerge` | **never** | irreversible identity |

The M-6 digest (T11) is what moves these numbers: a type granted ≥ 98 % of the time with no
rejection in 90 days is a candidate to raise; a type with rejections is never raised.

## DECIDED (standard answers, recorded, overturnable)

| # | decision |
|---|---|
| O1 | **The obligation is the primitive.** An approval is one kind; a task is another. Both are `kernel/workflow` instances with a respond clock, a resolve clock, an addressee, a chain, an evidence kind and a record. |
| O2 | **Two clocks.** Respond-by (minutes; seen/owned) and resolve-by (the budget). The role ladder climbs on respond first. |
| O3 | **Two ladders, orthogonal.** Channel ladder: same person, louder, climbs on no read then no ack. Role ladder: higher person, at 40 / 70 / 100 / 150 / 200 % of budget, anchored at state entry, rescheduled on budget change. |
| O4 | **A breach creates an obligation for the accountable person** ("act on X's delay"), same engine, bounded by chain depth. That is the delay ledger. |
| O5 | **Attribution to the rung until the roster answers who held it and could act;** person attribution switches on with Plan 20. Excusal from leave, theatre and off-shift is automatic once it does. |
| O6 | **Eight addressee kinds:** person, post, role (≤ 8 holders), unit, committee (secretary), contractor (supervisor), external party (owning seat), agent (owner). Fallback is recorded, never silent. |
| O7 | **Evidence kind per obligation kind:** in-app decision, keypad, QR scan, in-app photo, read-back, sensor-in-range, on-behalf tap. No evidence, no close. |
| O8 | **Reach profile per class, overridable per person.** Class defaults in `01-STAFF-CENSUS.md`. |
| O9 | **What a channel may carry (M-7):** any channel: seen/owned. WhatsApp buttons: small-band decisions via one-time tokens. SMS reply: ack only. App: everything. Shared numbers: seen only. |
| O10 | **External bodies carry kind, lane, remaining time, link.** Never a patient, never a staff health fact, amounts as bands. |
| O11 | **Two chains:** administrative (role → parent, department-scoped column, seeded global) and clinical unit (JR → SR → faculty → unit head → HOD → MS, from Plan 20-U postings). Kind picks the chain. Both end at MS, then owner. Validated as a DAG. |
| O12 | **The owner is not the universal last rung.** Q1 at 200 % and a daily digest; MS absorbs the rest. |
| O13 | **Desk-close compresses the respond clock; the accountability clock is working minutes; a blocking signal is live** ("patient left" drops the lane with the reason). D3 amended by that clause. |
| O14 | **Ageing sweep = same engine, second anchor** (time since filing), no last rung, accumulates on the owner's rail. **Intervals (RO-7):** first surfacing at **3 working days** open, then **every 7 days**; the weekly owner digest lists every Q2 item older than 7 days with its age; the MS's rail shows every item older than 3 working days. Compliance-calendar items (T10) use lead times of 30 / 14 / 7 / 1 days instead. |
| O15 | **Dual control is sequential maker-checker**, second approver ≠ first ≠ requester. Vendor bank change, patient merge, tariff revision on day one. |
| O16 | **Sensors, agents and external parties file** the way a cashier files; filer kind is on the card. |
| O17 | **Segregation of duties:** nobody decides what they filed. |
| O18 | **Coaching-only ledger for the first quarter;** no payroll or attendance link; visible to the person and their supervisor. |
| O19 | **Not this spine:** Code Blue, fire, Code Pink (real-time paging); patient-facing reminders (Plan 10). |
| O20 | **Anticipation is a source of obligations:** OT lists, planned discharges, the compliance calendar, rotation ends, expiries. Built as its own lane (T10). |

## Tasks

Each task is one PR on its own lane, one migration where marked, rebased before opening. Kernel
tasks touch shared files and go alone. Every task lists the pins it moves and the mutant it kills.

| T | what | area | migration | depends on | must prove |
|---|---|---|---|---|---|
| **T1** | Ladder anchored at state entry with percentage rungs; **respond clock** beside resolve; reschedule on budget change; storm coalescing (C4); rung ordering (R6) | `kernel/workflow` (coordinate; alone) | no (definition change; timers table gains `anchor`, `percent`) — yes if a column | — | timer suite re-run; C3 test (exactly one live ladder after a budget change); a 6 h budget escalates at 2 h 24 m, not 6 h 30 m |
| **T2** | `approval.requested` → in-app alert per addressee + push where the lane allows (closes E4) | `kernel/alerts`, `kernel/notify` | no | — | filing produces exactly one alert per addressee; a replay produces none |
| **T3** | **Ack states** on alerts: seen / owned (ETA, reason, ≤ 2 extensions) / handed over; the card and the rail act on them; owning stops the channel ladder atomically (R8) | `kernel/alerts`, web | yes: `acknowledged_at`, `owned_until`, `handover_to` | — | G5: third extension climbs; R8 race test |
| **T4** | **Channel ladder** climbing on no read then no ack; Web Push adapter (service worker); templates-with-slots in English and Hindi (RO-3); reach budget (R9); quiet hours per lane (R12); consent flag on the person (R2) | `kernel/notify`, web | yes: `push_subscriptions`, `notify_consent` | T3 | mutant: an external body containing a patient or staff-health field fails; N+1th interrupt in an hour coalesces |
| **T5** | **Addressees**: the eight kinds (O6), posts and their supervisors, contractor supervisors on the ledger (RO-2), DAG-validated chains (O11), fallback recorded (A1), role cap (A4), SoD (O17) | kernel (new `obligations` sub-area), `seed-roles` pins | yes: `posts`, `role_parents`, `obligation_addressees` | T1 | A3 cycle refusal; A8 same-user-three-seats refusal; A1 fallback row present |
| **T6** | **Delay obligations** (O4, O5): breach at 100 % files `delay_review` on the accountable rung; 150 % on its parent; bounded (A13); verbs excuse / cover / counsel / act; the person sees their own ledger | kernel obligations, web | yes: `obligation_delays` | T5 | chain of three: junior silent → senior's delay → owner's digest, no fourth; rung-attributed only |
| **T7** | **Derivation**: urgency (blocking live, perishable, compounding) and importance (I1–I5, per-type constants beside `closureSlaMinutes`); desk-close on the respond clock (O13); working minutes from department hours + the hospital calendar (C1) | approvals module + a `hospital_calendar` table | yes | T1 | C2 tests at 00:00/05:29/05:30/08:00/23:59 IST; "patient left" moves Now → Today with reason |
| **T8** | **Tasks as a verb** (O1): the first non-approval kinds — transport request, bed turnaround, breakdown ticket by criticality, MRD deficiency chase — with evidence kinds (O7: QR, photo, on-behalf tap) and post addressing; the station board endpoint (E5) | new leaf module `obligations-tasks` + web | yes: `obligation_evidence` | T5 | board returns no subject fields (mutant); a task without evidence cannot close |
| **T9** | **Shift brief + handover boundary**: everything a person or post owes, ordered by respond clock, at login / punch-in / take-over; open obligations at 08:00 hand over or escalate (C6) | web + roster read (after #264) | no | T5, #264 | brief lists only the person's and their posts' items; a 07:59 filing carries no record |
| **T10** | **Anticipation + compliance calendar** (O20): obligations from schedules and from a `compliance_items` calendar (licences, returns, AMC, badges, rotations); the ageing sweep (O14) | new leaf module | yes | T5 | an item 30 days out files at its lead time; the sweep rung recurs with no last rung |
| **T11** | **M-6 digest + sequential dual control** (O15) | approvals module | yes: `approval_second_decisions` | T5 | second approver = first or requester refused |
| **T12** | **Voice / IVR adapter + WhatsApp buttons with one-time tokens** (O9) | `kernel/notify` | yes: `channel_action_tokens` | T4, purchases | replayed token refused; SMS reply carries ack only |

**Order (RO-4).** T2 and T3 first, in parallel, on their own lanes: filing tells somebody, and
somebody can say "seen". **T4's Web Push leg follows immediately** (service worker, subscription
table, Chrome permission state on the user's settings page); its WhatsApp and SMS legs wait for the
DLT header and the BSP templates the owner has started. T1 next and alone. Then T5 → T6 and T7 in parallel → T8 → T9 (after #264) → T10, T11,
T12 as providers arrive. T4's push adapter can start any time after T3; its WhatsApp / SMS legs
wait for the purchases.

**Pins each task moves** (read at rebase, never remembered): `seed-roles.test.ts` permission counts
(T5, T8, T10 add permissions and owe README prose), `caddyfile-parity` route counts (T8, T9, T10),
`manifests` count (T8, T10), `schema/<module>.test.ts` column census for every migration.

## Design surfaces still to draw

The card with two clocks and the ack row · the station board · the shift brief · the person's own
ledger page · the owner's rail with the ageing sweep. Screens follow the Doctor Desk skeleton and
are gated on the owner's comment on the boards, as 20-U is.

## Definition of done for the phase

A refund filed at 19:40 against a counter that closes at 20:00 reaches the cashier's manager's phone
within two minutes of silence, is owned with one tap, and, if still undecided at close, carries over
with the patient told and no record against anyone. A ward transport request nobody picks up in
ten minutes reaches the housekeeping supervisor's phone in Hindi and the ward in-charge's banner,
and the ward boy's QR scan at radiology closes it. A vendor bank change waits for a second, different
approver. A licence expiring in thirty days is on the MS's rail today and on the owner's digest
every week until it is not. And the owner's phone rang for none of it.
