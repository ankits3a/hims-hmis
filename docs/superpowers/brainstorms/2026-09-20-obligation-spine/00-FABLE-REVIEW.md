# The obligation spine — Fable's review of the escalation handoff, 2026-09-20

Reviews `plans/2026-09-20-HANDOFF-approvals-escalation.md` (Opus, same day). Nothing here is built.
The handoff's measurements (E1–E8) stand; this doc argues with its model in three places and
answers its nine questions. Owner brief, restated: *make every staff member and every agent
proactive to each event, across every kind of staff a teaching hospital has, on every medium that
can reach a person.*

---

## 1. Three reframes

### 1.1 The primitive is an OBLIGATION, not an approval

An approval is one kind of thing a person owes the hospital by a time. A teaching hospital has
hundreds of others, and most of them are not approvals:

| owed by | example | today |
|---|---|---|
| PG on take | see a new admission within 30 min | nothing |
| faculty | countersign the discharge summary within 24 h | nothing |
| pathologist | acknowledge a critical value; phone the ward | `lab` critical-value flag, no clock |
| pharmacist | verify a held dispense | queue, no clock |
| nurse | give the 18:00 dose; escalate a missed one | nothing |
| MRD | code the file within 48 h of discharge | nothing |
| stores | act on a reorder point | approval type exists |
| HOD | confirm the unit table / publish the roster | Plan 20-U |
| biomedical | calibration due; AMC expiry | nothing |
| admin | AERB, PCPNDT, drug licence, fire NOC, BMW authorisation renewals | nothing |
| accounts | GSTR-1 by the 11th, TDS by the 7th | nothing |
| the agent | file the refund request it promised the counter | nothing |

Every row has the same shape: **who owes it · by when · who is accountable if they do not · how we
reach them · what we record.** `kernel/workflow` already holds instances, states, SLA timers and a
ladder; the approvals engine is its first client. **Build ladders, acknowledgement, the delay
ledger and the reach layer in the kernel, and let approvals be the first obligation kind.** Building
them inside `kernel/approvals` means building them again for orders, roster and clinical events.

The recursion the owner asked for falls out of this for free: **a breached obligation CREATES an
obligation for the accountable person** ("act on X's delay"), in the same engine, with its own
runway and its own accountable person. "The senior's senior" needs no special code; it is the
second iteration of the same rule. The delay ledger (handoff §5.3) is then just the obligation kind
`delay_review`, with excuse / cover / counsel / act as its verbs.

### 1.2 Two clocks: respond-by and resolve-by

The handoff runs one clock (the budget) and pauses nudges on acknowledgement. Standard practice
(ITIL, rapid-response) runs two, and the difference is what kills alert fatigue:

- **Respond-by** — minutes. Has a human *seen and owned* this? Silence is the failure escalated
  fast, because silence is cheap to cure: one tap. The role ladder climbs on this clock first.
- **Resolve-by** — the budget. Has it been decided? Climbs slowly, because an owned item with an
  ETA is a different fact from an unseen one.

Most escalation traffic is about silence. A person who acknowledges with "30 min, in theatre" has
answered the respond clock, and the ladder stops interrupting them until the ETA. A person who
acknowledges and still misses the budget produces the record the supervisor actually needs.
**Acknowledgement states:** `seen` (read receipt, any channel) · `owned` (ETA + optional reason) ·
`handed over` (to a named person, D12 grant) · `done`. `alerts` has `read_at` only today; `owned`
is the new state.

### 1.3 Two ladders, orthogonal: reach (louder) and role (higher)

- **The channel ladder** climbs on the *same person*, louder: app → WhatsApp → SMS → call. It is
  measured in minutes and it climbs on **no read**, then on **no ack**. It never involves anyone
  else. Today it climbs only on delivery failure (measured, roster memory).
- **The role ladder** climbs to a *different person*, at fractions of the budget (handoff §5.2).

They compose: at each rung of the role ladder, the recipient gets the channel ladder appropriate to
the lane. Q4 never leaves the app. Q1 starts at WhatsApp and reaches a call inside ten minutes of
silence. Merging the two into one list is how "the owner got an SMS about a ₹200 discount" happens.

---

## 2. Answers to the handoff's nine questions

| # | Question | Answer |
|---|---|---|
| 1 | Ladder anchored at state entry (a) or a `nudges` array (b)? | **(a).** (b)'s "smaller blast radius" is not real: the breach path would still have to know the nudges exist to avoid double-firing at 100%. One anchor, percentages throughout. Add one thing: the schedule is **recomputed when the budget changes** (the desk-close rule shortens it; an acknowledgement's ETA does not). |
| 2 | Is the ageing sweep a separate mechanism? | **Same engine, second anchor.** The ladder measures time-to-deadline; the sweep measures time-since-filing on items with no deadline. Both are timers on the instance. The sweep is a recurring rung (every N days, N per type) that accumulates on the owner's rail; it has no last rung. Do not build it as a report. |
| 3 | `min(budget, time to desk close)` too aggressive? | Apply it to the **respond clock and the notification ladder**, not to the accountability record. At desk close an undecided blocking item is *carried over*: the patient is told, the item re-files with a fresh runway at next opening, and the carry-over itself is the recorded fact. Recording a 20-minute delay against a manager is the unfair case. Also: **blocking is a live signal, not a file-time constant.** When the counter marks "patient left", urgency drops to Today, with the reason on the row. This relaxes D3 by one clause: age never moves a row between lanes; a *signal change* may, and says so. |
| 4 | One global chain or per department? | **Two chains, scoped by data from day one, seeded global.** The administrative chain (role → parent role, optional department) carries money and admin. The **clinical unit chain** (JR → SR → faculty → unit head → HOD → MS) carries clinical obligations and is Plan 20-U's postings table. The obligation kind picks the chain. Both end at MS, then owner. |
| 5 | Ship the ledger with `excused: pending`? | **Ship it attributed to the RUNG, not the person.** "The `billing_manager` rung was silent for 40 min" is true today without the roster and blames nobody. Person attribution switches on when the roster can answer "who held the rung and could act". This is more honest than a pending flag that everyone reads as an accusation anyway. |
| 6 | Dual control for vendor bank change and patient merge? | **Yes, as sequential maker-checker, not as a two-approver engine.** The first approval creates a second obligation for a *different* holder of the same or higher rung; the row shows "1 of 2". Same primitive, no engine change, and it is how every Indian bank's portal does it. `materials_vendor_bank_change`, `patient_merge`, `tariff_revision` on day one. |
| 7 | Risks not listed | §5 below. |
| 8 | (implicit) Where does Now/Today/Can wait sit against Q1–Q4? | Lanes are urgency; ladder height is importance. A row has both. The card shows the lane; the ladder is invisible until it climbs. |
| 9 | (implicit) Who is the last rung for everything? | **Not the owner.** R3 makes the owner the last rung for money; the 200% "always the owner" rung in §5.2 turns the owner into the hospital's inbox. The owner gets Q1 at 200% and a daily digest of everything else. MS absorbs the rest. |

---

## 3. Mediums — every way a thing can move

A medium is not a pipe. Each has five properties the router reads: **latency · interruptiveness ·
can the person ACT from it · identity assurance of that act · cost.** The owner's list plus what is
missing:

| medium | acts from it? | identity | notes |
|---|---|---|---|
| in-app inbox + rail | yes, full | session | exists |
| **Web Push (Chrome/PWA)** | ack; deep-link | session | the "app notification"; no service worker today (measured). First to build. |
| **seat / station banner** | yes | the station | an obligation on *the billing counter*, whoever is logged in. Handles vacancy: unstaffed station = climb. |
| **the copilot at login / punch-in** | yes | session | "3 things wait, the first closes in 12 min." The Doctor Desk login brief already has a lifecycle. AEBAS punch-in is a proven-presence moment. |
| **department display board** | no | none | TV at the nursing station, OT desk, lab: the queue by lane, no names (E6). Ambient; nobody is paged. |
| WhatsApp (BSP) | **yes, buttons**: Seen / Own 30 min / Approve (small) | phone number | template pre-approval; 24-h window rules. Purchase owed. |
| SMS (DLT) | reply code `Y 4821` | phone number | every template DLT-registered; lead time weeks. Purchase owed. |
| **flash SMS / missed call** | ack by call-back | phone | India-specific, feature-phone safe: housekeeping, drivers, security. |
| automated voice (TTS, Hindi/English) | keypad: 1 own, 2 hand over, 3 cannot | phone | the interrupt channel for Now. |
| IVR inbound | yes, for a code | phone + PIN | "call 040-… and press your code": for people who cannot open the app (theatre, ward round). |
| manual call | yes, by the caller | the caller | a task for the duty manager's desk; the last automated rung creates it. |
| **runner** | yes, by finding them | the runner | an obligation for a ward attendant to physically locate the person. Last rung in the building. |
| **DECT / SIP handset, PA overhead page** | no | none | most Indian hospitals have both; code-level events only. Later. |
| email | no (digests) | — | Q2/Q4 digests, HODs, vendors, TPA, auditors. |
| **calendar invite (.ics)** | no | — | scheduled Q2 items: "tariff review Thursday 15:00". |
| printed slip at the station printer | no | — | the dispense counter already prints; a paper nudge for a nursing station. |
| WhatsApp group digest | no | — | departments run on groups already; a read-only evening digest by department, no names. |
| webhook / event bus | machine | signed | the college timetable, vendor portal, TPA, the AI agents themselves. |

**Rules that bind the router**

- **Decision weight × channel assurance (M-7).** Any channel can carry *seen* and *owned*. A phone
  number can carry a decision only under the type's small band; above it, the channel deep-links
  to the app. A shared ward phone can carry nothing but *seen*.
- **Staff class × reach profile (M-8).** Faculty: app → WhatsApp → call. PG on take: app → call
  (they are awake by definition). Nurse: station banner → ward phone. Housekeeping / driver /
  security: SMS Hindi → voice → supervisor. Owner: WhatsApp → call. Vendor: email → WhatsApp.
  Student: never; a student holds no obligation.
- **Duty state × lane (M-9).** Off duty: nothing but Now, and only if on call. Working-minute
  budgets for Today and Can wait (handoff §5.5). In theatre (roster says so): skip to the unit's
  next person, no record.
- **Per-person reach budget.** N interrupts per hour across *all* kinds; beyond it, coalesce.
  Every subsystem pinging separately is how a system gets muted.
- **No patient identity on any external medium** (E6). The message says *what kind* and *how
  long*; the person reaches the patient through a permission-checked route.

---

## 4. Proactive means BEFORE the event

Three horizons, and the handoff covers only the middle one:

1. **Anticipate.** Obligations are created from what is *scheduled*: tomorrow's OT list needs two
   deposit exceptions decided by 18:00 today; a planned discharge needs a signed summary; a
   licence expires in 30 days; a PG's rotation ends Friday and the posting must be renewed; a
   batch expires; a calibration is due. A **compliance calendar** (AERB, PCPNDT, drug licence,
   fire NOC, BMW, GSTR, TDS, NMC registration renewals, AMC) is the largest source of Q2 items
   the hospital has, and the sweep is what keeps them alive.
2. **Act.** The obligation fires; the ladders run (§1).
3. **Record.** The ledger; the digests; M-6's ceremony statistics.

Two proactive surfaces cost almost nothing and belong to horizon 1:

- **The shift brief.** At login, punch-in or take-over: everything the person owes, ordered by
  the respond clock, with what expires during *their* shift.
- **Handover as the escalation boundary.** In a teaching unit, obligations transfer at 08:00.
  An open obligation on the outgoing PG that is not explicitly handed over escalates at the
  boundary. The handover list is *generated* from open obligations, not typed.

**Where the agents sit.** Every agent does five things with obligations, and nothing else: assemble
the packet (L1) · recommend (D7) · chase (the agent IS a medium: the copilot at the seat) ·
anticipate (create the obligation from the schedule) · auto-grant inside the envelope (L7, M-6).
**An agent's own promise is an obligation too:** "I will file the refund" that never files is a
delay record against the agent, reported to whoever owns the agent. Agents ask; humans and policy
answer (L8).

---

## 5. Risks the handoff did not list

| | risk | mitigation |
|---|---|---|
| R-h | **Owner bottleneck.** A 200% rung that is always the owner makes the owner the inbox. | §2 answer 9. |
| R-i | **Cross-kind fatigue.** Five subsystems each escalate correctly and the person mutes the phone. | one obligation kernel, one reach budget per person. |
| R-j | **Shared and stale phones.** A ward phone, a family number, a PG who left. | `seen` only from shared numbers; roster owns the number; a bounced number is itself an obligation for HR. |
| R-k | **TRAI / DLT / BSP lead time and template rigidity.** Every SMS body pre-registered; WhatsApp templates approved; free-form copy impossible. | design the copy as *templates with slots* now; register at purchase; the console adapter must render the same templates so the text never changes on go-live. |
| R-l | **The ledger becomes a punishment tool and is gamed** (fast rejects, refile churn). | first quarter: the ledger is a coaching signal visible to the person and their supervisor only; no HR export until the roster can excuse. Rejection-without-reading is a monitored figure. |
| R-m | **Same person twice in a chain** (HOD is also unit head; MS is also the faculty). | dedupe by person, not rung, at fan-out. |
| R-n | **A rung with no holder at 02:00** (the role exists, nobody is on call). | the roster answers who is on call; absent a roster, `duty_manager` then owner SMS, as today. Never silently skip. |
| R-o | **Working-minute maths against a UTC dev DB.** | measured trap (roster memory); budgets computed in IST from department hours, tested at 00:00–08:00. |
| R-p | **Obligations on a station with nobody logged in.** | station vacancy is a signal; climb after N minutes of vacancy, to the supervisor of the station. |
| R-q | **Escalation storms after worker downtime.** | handoff R-b; add: downtime is discounted from the *respond* clock too. |

---

## 6. Matrices, consolidated

| # | matrix | decides |
|---|---|---|
| M-1 | urgency × importance | the clocks, the ladder height, the channel floor |
| M-2 | authority × amount | who may decide what; the policy ceiling |
| M-3 | reversibility × blast radius | single vs sequential dual control |
| M-4 | availability × role | skip, cover, excuse |
| M-5 | RACI per kind | who decides vs who owns the delay |
| M-6 | frequency × variance | which approvals are ceremony (the agents' envelope) |
| **M-7** | decision weight × channel assurance | what a channel may carry |
| **M-8** | staff class × reach profile | which mediums exist for whom |
| **M-9** | duty state × lane | who may be reached when |
| **M-10** | event kind × horizon | anticipate / act / record |

---

## 7. Build order, revised

| T | what | change from the handoff |
|---|---|---|
| T1 | kernel ladders anchored at state entry, **two clocks** (respond, resolve), schedule recomputed on budget change | adds the respond clock |
| T2 | `approval.requested` → in-app + push | unchanged, ships first |
| T3 | **ack states** (`seen` / `owned` / `handed over`) on alerts, acted from the app | new; cheapest change with the largest effect |
| T4 | the channel ladder climbing on no-read / no-ack, Web Push adapter, templates-with-slots | RU-4 |
| T5 | the two supervisory chains, rung-attributed delay obligations (recursive) | ledger attributed to the rung |
| T6 | urgency + importance derivation, live blocking signal, desk-close on the respond clock | §2 answer 3 |
| T7 | working-minute budgets + duty state from the roster (after #264) | unchanged |
| T8 | shift brief + handover boundary | new |
| T9 | M-6 digest; sequential dual control | unchanged |
| T10 | compliance calendar + anticipation obligations | new; a separate lane |
| — | purchases the owner owes | WhatsApp BSP · DLT SMS (weeks of lead time) · voice/IVR provider |

**Decided here (not money, procurement or law):** obligation as the primitive · two clocks · two
ladders · rung attribution until the roster · sequential dual control · owner is not the universal
last rung. **Owner rulings needed:** which of the three providers to buy first · whether a phone
number may carry a small-band decision (M-7) · whether housekeeping and drivers carry obligations
in phase one · the first N for the ageing sweep.
