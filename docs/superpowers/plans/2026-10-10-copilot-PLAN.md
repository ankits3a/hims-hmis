# PLAN — the staff copilot: goals, milestones, epics, and what "done" means

**Date:** 2026-10-10 · **Measured at:** `main` 21467fd7 · **Roadmap:** `docs/superpowers/2026-10-10-ROADMAP-copilot.md`
**Status:** v2 — Fable review applied (§7). Nothing is built from this until the owner approves §1 (goals and targets).
**Owner request 2026-10-10:** "plan this roadmap and get it reviewed by Fable. Then break the plan into milestones &
epics. Add goals around it and then create what 'goal is done' means. Once the confirmation metrics is clear we can
then proceed with implementation."

Owner picks 2026-10-10: Android first; scan widget first; drafts = staff messages + reports/summaries; acts =
reminders to myself, book/move appointment, existing desk acts, leave/duty swap. Ranking page (artifact
P8eS4UB9ynFptwrtjq1Tm3, collection `picks`) was empty when this was written.

---

## 1. Goals and what "goal is done" means

A goal is an outcome on the hospital floor. Each has a metric, the instrument that measures it, a baseline measured
in M0 (never guessed), and a target. **A goal is done when its target holds on production for the whole window,
read by the query named in §6, dated, and the owner has seen the number.** Targets are proposals until the owner
approves them; the approved table becomes a numbered decision.

| # | Goal | Metric (exact) | Instrument | Target | Window |
|---|---|---|---|---|---|
| G1 | **Staff actually use it** | distinct users with ≥1 *answered* question (not notUnderstood / noTool / refused) ÷ distinct users active that week (web session or phone `auth_devices.last_seen_at`), reported per seat | ledger (E0.1) + sign-in records | ≥25% overall; every M1 seat >0 | 4 consecutive weeks |
| G2 | **It does real work** | (a) confirmed acts on shared records (appointment, leave/swap) per week — self-reminders counted separately; (b) acts reversed by anyone within 24 h, matched on proposal id via the module's own cancel event | ledger act rows + module audit events | (a) ≥100/week; (b) <5% | 4 consecutive weeks |
| G3 | **It understands how staff talk** | (a) not-understood share of live questions; (b) "wrong" taps on answer cards ÷ answers; (c) frozen Hinglish eval set routed right | ledger outcome + feedback columns; eval set in CI | (a) <10%; (b) <5%; (c) ≥90% | 2 weeks (a, b); every CI run (c) |
| G4 | **Fast** | answer time p50 / p95, reported per route (phrasebook / chooser / model) | ledger timings | phrasebook + chooser p50 <1.5 s, p95 <4 s; model route reported, no target | 2 weeks |
| G5 | **Criticals are not missed** | lab critical read-back loop: `lab_critical_calls.closed_at − opened_at`, median and p95 | existing `lab_critical_calls` table (baseline readable today) | median <15 min, p95 <30 min | 4 weeks |
| G6 | **Safe and auditable** | (a) ledger ask rows = `POST /copilot/ask` count in the Caddy access log; (b) act rows with no confirm id; (c) names found in a monthly sample of 50 masked questions read by the steward; (d) monthly halt drill | reconciliation query; steward sample record; drill record | (a) equal ±0; (b) 0; (c) 0; (d) passes, halt effective on the next ask | every month |
| G7 | **No act on the wrong patient** | acts where the ledger subject ≠ the module audit subject, plus any incident-register entry citing the copilot | reconciliation query + incident register | 0, ever | permanent |
| G8 | **Cost under control** | model calls per day and ₹ per answered question; hard daily cap that falls back to phrasebook-only | ledger + provider usage | owner sets cap (R-4); never exceeded | every day |
| G9 | **The owner sees the hospital without asking** | 08:00 digest delivered; owner's "useful" tap | notify log; digest feedback row | ≥95% of days; useful ≥4 of 5 days | 30 days |

G9 waits for R-3/R-4. No goal for "minutes saved": no honest instrument exists; G2 + G4 are the measurable proxies.
"Unseen results >24 h" returns as a goal only after a lab "report seen" marker exists (M3).

## 2. Milestones

| Milestone | Owner can see | Epics | Goals | Gate |
|---|---|---|---|---|
| **M0 — Measure and make safe** | a Copilot health page: questions, acts, not-understood, wrong taps, timings, model calls/₹; halt switch | E0.1–E0.6 | baselines for all; G6, G8 | none |
| **M1 — Copilot in the pocket** | scan widget; reminders; phone copilot with seat chips; "my open loops"; morning card | E1.1–E1.6 | G1, G3, G4, G5 baseline | E1.1, E1.2 none beyond E0.1; E1.3 after E0.6 |
| **M2 — The copilot does work** | appointment booked and leave filed from chat | E2.1–E2.3 | G2, G7 | M0 (E0.2) |
| **M3a — Criticals on the spine** | criticals chased with a ladder to the unit head | E3.1–E3.2 | G5 | M1 |
| **M4 — Drafts and the owner's copilot** | draft notice / day summary; 08:00 digest | E4.1–E4.3 | G9 | R-1; R-3/R-4 for E4.3 |
| **Out of this track** | spine T8 (task board) and T9 (shift brief) become their own phases; M5 money/wards stays gated (R-5, IPD) | — | — | — |

Order: E0.1 and E1.1 start together; then E1.2 (reminders); the rest of M0; then M1 → M2 → M3a; M4 when rulings land.

## 3. Epics with "done means" (each check binary and testable)

Every epic is one lane and one PR, gets its own ~10-line spec before build, and its approved checks go into `acceptance/`.

### M0 — Measure and make safe
- **E0.1 Ledger.** Asks recorded as `events` rows (append, idempotency, partitions, retention sweep already exist);
  acts in a structured `copilot_acts` table: tool, subject patient id, args hash, proposal id, confirm id, resulting
  module row id. Retention: asks 180 days (same class as `notifications`); acts as long as the record.
  Done means: (1) N asks → N ask rows, including refusals and halts; (2) every act row has a non-null confirm id
  (DB constraint); (3) `GET /copilot/health` under new permission `copilot.health.read` (owner, IT, steward) returns
  today's counts; (4) health page shows no per-person "fewest questions" view.
- **E0.2 Propose → confirm → act.** A proposal binds user, tool, exact args, subject and expiry ≤5 min under an HMAC.
  `POST /copilot/confirm` re-reads state and re-checks permission; the module write and the act row commit in one
  transaction. Each tool states whether it has a "verify" step (brainstorm §3) or why not.
  Done means: (1) replayed confirm writes nothing; (2) expired proposal refuses; (3) args changed after signing
  refuses; (4) permission revoked between propose and confirm refuses; (5) a forced failure after the module write
  leaves neither the write nor the act row; (6) the slot taken between propose and confirm refuses.
- **E0.3 Halt switch.** One indexed DB read per ask, no cache (as `getOperatingMode`). Scopes read / act / draft /
  global. Global: owner clears. Act scope: owner or duty manager clears (DECIDED: a false 2 a.m. halt must not block
  till morning). On the failover site the switch is read from the same replicated table.
  Done means: (1) after halting "act", the next confirm refuses while reads answer; (2) each halt and clear is an
  audit event naming who; (3) a non-owner cannot clear global.
- **E0.4 Hinglish eval set.** ~150 questions (English, romanised Hindi, Devanagari) with expected intent; recorded
  chooser answers; CI, no network. Monthly refresh: steward adds a masked sample of last month's not-understood and
  wrong-tapped questions. Done means: (1) CI fails when routing drops below the recorded floor; (2) set lives under
  `acceptance/` once approved.
- **E0.5 Cost meter and cap.** Done means: (1) model calls/day and ₹ on the health page; (2) when the cap is reached
  every ask routes phrasebook-only until midnight IST, and the health page says so.
- **E0.6 Name-aware masking (blocker for any phone chat).** Mask names of patients this user can see today
  (registered/queued/admitted, roman + Devanagari variants) before any model call; until it ships, the phone runs
  phrasebook-only (`model === null` path). Done means: (1) a question naming a patient registered today makes zero
  model calls when the name is not masked (recorded chooser, call count asserted); (2) with masking, the model
  request contains `<<Pn>>`, never the name; (3) the web path's `terms` behaviour is unchanged.
- **E0.7 Open intent seam — deferred** until M1 ships. It touches `phrasebook.ts`, contracts, `router.ts`, locales and
  `manifests.ts` (all shared files) and would collide with E1.3.

### M1 — Copilot in the pocket
- **E1.1 Scan widget.** `/opt/hmis-context/SPEC-home-widgets-2026-10-10.md` Part A (its six checks).
- **E1.2 Reminders.** Own table `user_reminders` (user, due_at, repeat, fired_at, cancelled_at, text ≤80 chars, no
  patient reference) and own worker job using the conditional-UPDATE claim; push text is the fixed category sentence
  ("You have a reminder"); the user's text shows only inside the app. Created from a screen first; from chat in E1.3.
  Done means: (1) fires within 60 s of due time; (2) fires once after an API or worker restart; (3) repeating ones
  can be listed and cancelled; (4) push payload contains no user text (test on the payload).
- **E1.3 Phone copilot chat.** `/copilot` screen; each seat's top three questions as tappable chips; answer card with
  a one-tap "wrong"; en/hi answer keys copied into the app's `hi.json`/`en.json`; nothing stored on the phone.
  Done means: (1) every web intent answers with the same text; (2) chip vs typed recorded in the ledger; (3) "wrong"
  tap writes a feedback row; (4) inputs stay above the Android keyboard (vc24 pattern); (5) phrasebook-only until E0.6.
- **E1.4 My open loops (read).** Over `alerts` + `lab_critical_calls` + radiology acknowledgements, no spine change.
  Done means: the phone list equals the web list for the same user and fixture.
- **E1.5 Morning card.** Done means: a doctor fixture with 2 returned reports and 1 unread study sees exactly those 3;
  each opens its screen in one tap; nothing on the lock screen or in a push names a patient.
- **E1.6 Patient dues (read).** Done means: matches the billing counter for fixture bills with refund and credit.
- **E1.7 Copilot widget + mic.** DECIDED: the mic uses the server's `/speech/transcribe` (one provider, one ledger),
  hidden until R-2; widget "Ask" ships without it. Done means: (1) Ask opens chat with keyboard up; (2) with R-2, the
  transcript shows for edit before it is asked; (3) without R-2 no mic is drawn.

### M2 — The copilot does work
- **E2.1 Appointment book / move.** Done means: (1) a chat booking appears in the appointments list identical to a
  screen booking except "via copilot"; (2) G7 reconciliation holds on the fixture; (3) tele-call pay-first rule holds.
- **E2.2 Leave / duty swap into approvals.** Done means: (1) approver sees it in the same queue; (2) refusal reason
  returns to chat; (3) the requester cannot approve their own (fail-first test on the new path).
- **E2.3 Reminders from chat.** Done means: "remind me at 4 to see bed 12" creates an E1.2 reminder after one confirm.
- Cut from M2: pharmacy short-book / PO acts (buttons already exist; segregation-of-duties risk for little value).

### M3a — Criticals on the spine
- **E3.1 Spine T5 (addressees and chains)** per `plans/2026-09-21-obligation-spine-T5-HANDOFF.md`; its own spec.
- **E3.2 Lab criticals onto the spine** with a ladder to the unit head. Done means: (1) each critical has an owner, a
  respond clock and a ladder; (2) unanswered at 15 min climbs one rung (fixture clock, not the real clock);
  (3) G5 query runs on production.

### M4 — Drafts and the owner's copilot
- **E4.1 Draft contract** (per-user toggle off by default, decision 0006 pattern; editable; never sent without a tap;
  draft and final ledgered; inputs as R-1 allows).
- **E4.2 Staff notice + day summary drafts.** Done means: every figure in the draft matches the report screen; an
  abnormal value is never dropped (fixture test).
- **E4.3 Owner digest / ops copilot (Hermes).** Class-0 tools only. Done means: schema test over every tool's output
  finds no patient field.

## 4. Rulings owed

R-1 drafts (M4) · R-2 staff voice to cloud speech (E1.7 mic) · R-3 second server, R-4 provider + daily cap (E0.5 cap
value, E4.3) · R-5 insurance module · R-6 DPIA signature, now including a staff-notice line: the ledger is a
per-employee activity log (staff are data principals under the DPDP Act).

## 5. Ownership and adoption (DECIDED, standard practice)

- **Copilot steward:** the quality manager, named by the owner. Runs the monthly name sample (G6c), the eval refresh
  (E0.4) and the halt drill (G6d).
- **Adoption:** per seat a two-minute demo at handover by the seat's in-charge in M1; chips make the first use
  typing-free.

## 6. Goal ledger (filled as measured; each row names its query and date)

| Goal | Baseline | Latest | Done? |
|---|---|---|---|
| G1–G9 | — | — | — |

## 7. Fable review (2026-10-10) — what changed from v1

Accepted all eleven findings. Blocker: phone chat had no screen `terms`, so a typed patient name would reach the
chooser model (verified: `mask.ts` `terms` param; `use-copilot.tsx` passes screen names) → E0.6 added, phone
phrasebook-only until it ships. Reminders cannot sit on `workflow_timers` (`instance_id` NOT NULL, verified) → own
table + job, moved into M1. Ledger gains structured act columns, one-transaction write, retention. M3 split; T8/T9
leave this track. Intent seam deferred. Mic contradiction resolved (server speech, R-2). Halt clear widened to duty
manager for act scope. Pharmacy acts cut. `patient_dues` moved to M1. Goals: G1 target 40%→25% and redefined on
answered questions; G2 200→100/week on shared records only; "wrong" tap added; G4 per route; G5 re-instrumented on
`lab_critical_calls`; G6 reconciled against the access log + monthly name sample; new G7 (wrong patient = 0) and
G8 (cost cap).
