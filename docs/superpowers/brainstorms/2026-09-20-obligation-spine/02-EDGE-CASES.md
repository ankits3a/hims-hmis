# Edge cases — the register the spine must answer before it is built

Companion to `00-FABLE-REVIEW.md` and `01-STAFF-CENSUS.md`. Owner rulings of 2026-09-20 (later):
**all support-service classes carry obligations · contractor supervisors sit on the same delay
ledger as employees · English primary, Hindi next.** Each row below is a case that the naive
design gets wrong, with the answer the plan takes. **DECIDED** rows are standard answers taken
here; **OWNER** rows are money, procurement or law.

## 1. Clocks

| # | case | answer |
|---|---|---|
| C1 | Working minutes need department hours, and hours differ on Sunday, on national / state / hospital-declared holidays, and on half days. | A **hospital calendar** table (holiday, half day, per department override) is data; budgets in working minutes read it. Emergency and Now lanes ignore it. DECIDED |
| C2 | Dev DB runs `Etc/UTC`; every "today" is wrong 00:00–05:30 IST. | Every clock computation takes an explicit IST zone; tests run at 00:00, 05:29, 05:30, 08:00 and 23:59 IST. Measured trap (roster memory). |
| C3 | A budget change (desk-close rule, ETA, handover) after timers are scheduled. | Reschedule the whole ladder from the new budget; cancel the old timers under the existing claim-and-fire discipline. Tested as: change the budget, assert exactly one set of timers is live. |
| C4 | The worker was down three hours; timers fire together. | Coalesce per recipient per cycle; a single "N things waited" message; the respond clock is not charged for downtime (the stall interval is recorded on the instance). |
| C5 | A resolve-by shorter than the respond-by (tiny budgets). | respond-by = min(respond, resolve). |
| C6 | An obligation filed at 07:59 on a take ending at 08:00. | Handover moves it at the boundary with no record against the outgoing person; a rung silent for under N minutes is never recorded. |
| C7 | Budget spans a holiday or a night for a Today item. | Working minutes pause; the card shows the *calendar* deadline ("Monday 11:40"), never a raw minute count. |
| C8 | Clock skew between worker and DB. | `now()` from the DB in every scheduling write; never `Date.now()` in a decision path. |
| C9 | Replay (D5): a replayed filing must not re-notify. | All schedule reads from `occurredAt`; idempotency unit stays `(source_event_id, recipient)`. |

## 2. Addressee resolution

| # | case | answer |
|---|---|---|
| A1 | Role with zero holders (measured E5), post with nobody logged in, unit with nobody on take, contractor roster missing for today, committee without a secretary, external party without a contact, agent disabled. | Fall back one level (post → its supervisor role → duty manager → owner SMS) and **record the fallback as a fact on the instance**. The fact itself files a Q2 obligation on HR / admin: "post X had no holder at HH:MM". Never silently skip. DECIDED |
| A2 | Same person twice in one chain (HOD who is also unit head; MS acting as HOD). | Dedupe by person at fan-out; the higher rung absorbs the lower. |
| A3 | Chain cycle (a role whose parent is itself, or A→B→A). | The chain table is validated as a DAG at seed and on every write; a cycle refuses the write. Test: insert a cycle, assert refusal. |
| A4 | Role fan-out to forty holders (staff nurse). | Roles above N holders (N = 8) cannot be an addressee; the obligation must name a post, a unit or a person. Enforced at definition time. |
| A5 | Person deactivated (left the hospital) while holding obligations. | Offboarding sweeps open obligations back to the post or role; the person's rung record closes as `excused: left`. Offboarding is itself an obligation on HR. |
| A6 | Leave sanctioned after the obligation was filed. | Excuse retroactively for the leave window; the record stays, marked excused, with the leave as the reason. |
| A7 | Cover grant (D12) expires while the cover holds an obligation. | The obligation returns to the original holder with a fresh respond clock and a notice to both. |
| A8 | Requester is also an approver of the same kind. | Segregation of duties: a person never decides what they filed. Dual control: the second approver differs from the first **and** from the requester. Test with the same user in all three seats. DECIDED |
| A9 | A temporary role grant (`auth.temp_role.grant`) holder. | Receives the role's obligations; the record names the person and marks the grant as temporary. |
| A10 | Contract staff have no login (ruled: they carry obligations). | The obligation is on the **post**; the ack comes from the post phone plus the shift; the **contractor supervisor** is the attributed person on the same ledger (ruled). The contractor's shift roster is hospital data. |
| A11 | A visiting consultant with private hours. | Reach profile `visiting`; only clinical obligations for their own patients; chain to HOD. |
| A12 | Students. | Never an addressee. Interns receive tasks; the JR is attributed. DECIDED |
| A13 | The top of the chain is silent (owner or MS). | The chain terminates: no obligation is created on nobody; the item stays on the owner's rail and the digest. Recursion is bounded by chain depth. |

## 3. Reach and channels

| # | case | answer |
|---|---|---|
| R1 | Shared number (ward phone), wrong number (family), changed number. | A shared number carries **seen** only. A bounced or wrong number files an HR obligation. The roster owns the number, not the user profile. |
| R2 | TRAI DND registry. | Service messages to staff are permitted under TCCCPR with consent; consent captured at onboarding and stored. Templates are *service*, never *promotional*. OWNER (law): confirm consent wording with counsel. |
| R3 | DLT registration: every SMS template pre-registered, variables capped (~30 chars), URLs whitelisted. WhatsApp BSP: utility templates approved, three quick-reply buttons, opt-in. | Copy is **templates with slots**, English first, Hindi next (ruled), registered at purchase; the console adapter renders the same templates so go-live changes nothing. Weeks of lead time: purchase decisions gate T-channel. |
| R4 | Voice: TTS quality in Hindi; the person answers and presses nothing; voicemail; retries. | Keypad ack (1 own, 2 hand over, 3 cannot); no keypress = not acked; two retries five minutes apart, then the role ladder. Never a voice call for Today or Can wait. |
| R5 | Web Push: permission denied; browser closed; iOS Safari only when installed. | Push is unconfirmed until read; the ladder climbs from push to WhatsApp on no read within the lane's minutes. Permission state is shown on the user's own settings page. |
| R6 | Message ordering: the parent's escalation arrives before the assignee's nudge. | Rung timers are ordered by percentage; a later rung never fires before an earlier one has been recorded as fired. |
| R7 | Acting from the channel is replayable or spoofable (SMS sender spoofing exists). | SMS reply carries **ack only**. WhatsApp buttons (BSP-verified) carry decisions in the small band via one-time tokens bound to (obligation, recipient, action) with expiry. Everything else deep-links to the app. Refines review M-7. DECIDED |
| R8 | A `seen` ack races the call being placed. | Ack stops the channel ladder atomically; a call already dialling is allowed to complete; the second ack is a no-op. |
| R9 | The reach budget: five subsystems escalate correctly and the phone is muted. | N interrupts per person per hour across all kinds (N = 6); beyond it, coalesce into one message. Night supervisors and CMO are exempt. |
| R10 | Patient identity (E6) and **staff health identity** (needle-stick PEP names an exposed staff member). | No external channel carries a patient or a staff member's health fact. External bodies carry: kind, lane, remaining time, a link. Amounts are carried as **band**, not rupees, on external channels. DECIDED |
| R11 | Language per person (ruled English primary, Hindi next). | Person's language from their profile; class default (support classes default Hindi); templates exist in both before a class is switched on. Voice uses the person's language. |
| R12 | Quiet hours per lane. | Can wait: never outside working minutes. Today: working minutes. Now: always, to the on-call person the roster names. |

## 4. Evidence and gaming

| # | case | answer |
|---|---|---|
| G1 | QR at the ward photographed and scanned from elsewhere. | Static QR in phase one; every scan carries device and time and is auditable. Rotating QR on a station display later. DECIDED |
| G2 | Old photo reused as evidence. | Evidence photos are captured in-app, never uploaded from the gallery; timestamped server-side. |
| G3 | Keypad ack by whoever holds the phone. | Identity assurance of a keypad ack is *the phone*; it carries seen/owned only. |
| G4 | Fast reject to dodge the record (handoff R-c). | Reading time before a decision is a measured figure; rejections under N seconds with a preset reason surface in the digest. |
| G5 | Acknowledge with an ETA and extend forever. | Two extensions, each recorded; the third climbs the role ladder regardless. |
| G6 | Hand over to dodge. | Handover keeps the first holder's respond-clock record; handover counts per person surface in the digest. |
| G7 | Sensor returns to range and the obligation closes with no human act. | Auto-close is recorded as closed-by-sensor; the human's seen/owned record stands. |
| G8 | Batch-approve in the Can wait view without reading. | Same reading-time signal as G4; batch is limited to policy-eligible kinds. |
| G9 | The ledger used for punishment, then gamed (handoff R-l). | First quarter: coaching-only, visible to the person and their supervisor. No payroll or attendance link. Contractor supervisors' records are visible to the facility manager; export to the contracting firm is permitted (RO-5). |

## 5. Recursion, storms, fan-out

| # | case | answer |
|---|---|---|
| S1 | A failed autoclave BI creates one obligation per affected OT list. | Coalesce per recipient: one obligation with N subjects, not N obligations. |
| S2 | An agent files in a loop. | Rate cap per agent per hour; over the cap the agent is paused and its owner gets a Now obligation. |
| S3 | Delay obligations nest to the top of the chain. | Bounded by chain depth (A13); the top is the digest. |
| S4 | Timer storm after downtime. | C4. |
| S5 | A role ladder and a channel ladder both climb during one silence. | Channel ladder runs inside a rung; the role ladder climbs only on the budget. They never send the same fact twice to the same person (dedupe by (obligation, person, rung)). |

## 6. Engine and data

| # | case | answer |
|---|---|---|
| E1 | The sixteen approval types must keep working unchanged. | Every new column nullable with a class default; `urgencyClass` untouched (D4); the existing ladder path is the 100%+ tail of the new one. |
| E2 | Where do obligations live? | Obligations are `kernel/workflow` instances of new definitions; the ledger, addressees and evidence are new additive tables. No second timer system (handoff option (c) stays rejected). DECIDED |
| E3 | Migrations: one per PR, serial at rebase; kernel schema index is shared; seed-roles pins; caddyfile pins; manifests count. | Each task lists its pin changes; a PR that touches `kernel/workflow` goes alone. |
| E4 | New PHI read surfaces. | Every worklist that shows a patient adds an audit surface, as `approvals.worklist` did. |
| E5 | The board at a nursing station shows counts by lane and never a name. | The board endpoint returns no subject fields by construction and a mutant test proves it. |

## 7. Not this spine

| | | |
|---|---|---|
| N1 | **Code Blue, fire, Code Pink.** | Real-time paging under a minute; the PA and DECT systems. The spine records the response afterwards; it is not the crash-call. DECIDED |
| N2 | Patient-facing obligations (pay, return for follow-up). | Plan 10 notify territory; the same primitive may serve later. |
| N3 | Payroll and attendance consequences. | Not in phase one (G9). |
| N4 | Multi-campus. | Not in phase one; the addressee model has a department scope column so it can come. |

**Ruled later on 2026-09-20:** in-app + Chrome push first, DLT SMS and WhatsApp API purchases started
(RO-4) · contractor records MAY be exported to the firm (RO-5; G9 amended) · R2 ceilings and the
sweep interval delegated and decided in the phase doc (RO-6, RO-7). **Still open:** voice/IVR
provider · DND consent wording with counsel.
