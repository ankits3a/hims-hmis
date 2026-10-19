---
issue: 920
status: approved
approved: 2026-10-19
---
# SPEC — Emergency department (ER / Casualty)

Status: APPROVED by the owner 2026-10-19.
Model: SPEC-ipd-core-2026-10-12.md (same lens, same layers, tighter). Hospital: 1,200 beds, ~67 departments,
medical college, Bihar. ER bed stock: 60 emergency-class beds already in the IPD bed layout (IPD MAP, "1,150 beds").
Sources: blueprint journey "Emergency" (https://claude.ai/code/artifact/f9a50580-20ba-4141-a623-1abf9943e616);
Doctor Desk PLAN §4.2 seam rows E1–E10 (docs/superpowers/plans/2026-10-04-doctor-desk-PLAN.md); IPD MAP
(emergencyAdmit, recordStabilised, mortuary register, order charge sink #785); decisions 0012 (ER gets its own
brainstorm), 0013 (credit = owner only), 0018 (death needs MCCD number), 0037 (emergency charted before billing),
0058 (no money on a doctor's screen), 0067 (one ordering door), 0069 (confirmed copilot acts).

## Questions for the owner (money, procurement, law only — at most five)

Each has a recommended default. Say "defaults" and every one is taken.

1. **ER rates (money).** Default: carry the incumbent's ER tariff line by line, in this standard shape —
   ER registration fee (once per visit), ER physician fee (once per visit), observation charge per started
   6 hours after the first 6 hours, procedures / consumables / drugs / tests itemised at the hospital tariff.
   If the patient is admitted, the ER lines roll into the IP running bill (no separate ER settlement). Go-live is
   blocked until the five ER service codes have rates.
2. **What happens to an unpaid ER balance when a non-admitted patient leaves (money).** Default: the same path IPD
   already uses — the patient leaves (never detained), the balance is recorded as dues against a signed undertaking,
   the invoice is "held until paid" (not credit, per 0013's "held until paid is not credit"), and the owner's
   approval attaches later. No deposit is ever asked or taken before the ER doctor records "stabilised".
3. **Road-accident cashless scheme and PM-JAY emergency packages (money + law).** Default: empanel for the central
   Cashless Treatment of Road Accident Victims scheme (up to ₹1.5 lakh for the first 7 days) and bill road-accident
   victims to it at ₹0 to the patient; PM-JAY card holders pay ₹0 as in IPD. The TPA desk files claims on the
   portals by hand until Phase 3. If you say no, road-accident victims are billed like anyone else (still
   treat-first).
4. **Billing during a declared mass-casualty event (money).** Default: every patient tagged to the event pays ₹0 at
   the point of care; their charges post to an "event" account at full tariff; after the event you decide, per
   event, whether to waive, claim from the state / district, or bill the patients' payers.
5. **ER hardware (procurement).** Default: 2 wall screens (55", 16:9) for the tracking board and the waiting-area
   display, 6 tablets (triage ×2, resus scribe ×1, MLC desk ×1, bay nurses ×2), 1 thermal wristband printer at the
   ER desk (IPD Q4 already names "ER" as an admitting point), 1 A4 printer for MLC copies, 2 rugged barcode scanners.
   About ₹4–5 lakh at current Indian prices; bought before lane 1 rehearses.

## 0. Lens and layers (as IPD §0, applied to ER)

The ER is where the system's slowness costs the most and where staff have the least attention to give it. So:
nothing may stand between a sick patient and a doctor — no form, no payment, no identity. Everything the
system needs it gathers after, from scans, devices, voice and the record, and the screen asks only what it
cannot know. The three IPD layers hold:

| Layer | What it is for ER |
| --- | --- |
| **Truth** | The ER episode and its events: arrival, triage and every re-triage, placements, calls, orders, doses, codes, MLC, disposition — each with provenance (person, device, copilot draft, agent, import) and server time. |
| **Intents** | One zod-contracted function per act in `packages/contracts/src/emergency`, exposed over HTTP and declared as a copilot tool on the manifest; refusals carry a code and a fix. |
| **Surfaces** | Tracking board, triage, ER desk, doctor phone, resus scribe, MLC desk, MCI board, family display, prints. Replaceable. |

**Rule: no rule lives only in a screen; acceptance tests call intents.** All ten IPD principles (§0A) apply
unchanged; two are sharpened for ER:
- **Care is never gated.** No intent that records clinical care reads the bill, the identity status or the MLC
  state to refuse. A test per clinical intent proves it (§6 Architecture).
- **Every clock is visible and owned.** Door-to-triage, re-triage due, door-to-doctor, specialty call unanswered,
  decision-to-bed, MLC intimation due: each shows a countdown; a breach becomes a task on the roster ladder
  (`escalationRecipients`), not a colour.

## 1. Truth: the ER episode

New leaf module `modules/emergency` (DECIDED; owns its tables, imports others only through their `index.ts`).
One **ER episode** per arrival, number `ER26-000123`, an encounter of kind `er`, its own workflow instance.

States: `expected` (pre-alert) → `arrived` → `triaged` → `in_treatment` → `disposition_decided` →
`departed` with outcome `discharged | admitted | referred_out | lama | absconded | lwbs | died`.
`arrived` → `brought_dead` is terminal and separate. `expected` lapses to `cancelled` after 2 hours.

Stamped once, never edited: `arrived_at` (gate / triage instant, not registration entry — seam E1),
`arrival_mode` (walk_in, private vehicle, own ambulance, 108/102 ambulance, police, referred_in, inter-facility),
`take_team_id` per specialty call = `unitOnTake(dept, arrived_at)`, `backupUnit` when full, with reason (E2).

## 2. Intent catalogue

Each declares actors (role, copilot proposal yes/no, device), preconditions, refusal codes with fixes, events and
undo kind (undo window · reversal · entered-in-error · irreversible).

Arrival: `pre_alert` · `register_arrival` · `register_unidentified` · `record_brought_dead` · `print_er_band`.
Triage: `triage` · `re_triage` · `place_in_bay` · `move_bay` · `assign_er_doctor`.
Care: `call_specialty` · `answer_call` · `record_er_note` · `place_er_order` (ordering door) · `issue_er_med` ·
`give_er_dose` · `record_procedure` · `declare_stabilised` · `record_consent`.
Law: `open_mlc` · `record_police_intimation` · `countersign_mlc` · `record_belongings` · `hand_over_evidence`.
Disposition: `decide_disposition` · `discharge_from_er` · `hand_to_unit` · `refer_out` · `record_lama` ·
`record_lwbs` · `record_abscond` · `record_er_death`.
Identity: `link_identity` (files a `patient_merge` request; the merge itself stays in `patients`).
Money (billing roles only): `settle_er_bill` · `record_er_dues`.
Codes: `call_code` · `record_code_event` · `end_code`. MCI: `declare_mci` · `mci_tag` · `stand_down_mci`.

Events (seams E6, E7): `er.arrived`, `er.triaged`, `er.retriaged`, `er.call_raised`, `er.call_answered`,
`er.stabilised`, `er.mlc_opened`, `er.police_intimated`, `er.handed_to_unit` {episodeId, admissionId, teamId,
from, to, at}, `er.departed` {outcome}, `er.brought_dead`, `er.code_called`, `er.code_ended`, `er.mci_declared`.

## 3. DECIDED by top-hospital practice (no owner ruling needed)

1. **Triage scale: ESI v4, five levels**, each with colour + word + number, never colour alone:
   1 Resuscitation (red), 2 Emergent (orange), 3 Urgent (yellow), 4 Less urgent (green), 5 Non-urgent (blue).
   The Doctor Desk export (E3) maps 1–2 red, 3 yellow, 4–5 green. Paediatric patients use ESI with paediatric
   vital-sign danger zones. Pregnant ≥ 20 weeks with an obstetric complaint is triaged then walked to the labour
   room (obstetric triage is the LR's, by its own spec); non-obstetric complaints stay in ER.
2. **Clocks.** Door-to-triage ≤ 5 min. Door-to-doctor: ESI 1 immediate, 2 ≤ 10 min, 3 ≤ 30, 4 ≤ 60, 5 ≤ 120.
   Re-triage due until a doctor has seen the patient: ESI 2 every 15 min, 3 every 30, 4 every 60, 5 every 120
   (ESI 1 is in resus, continuously watched). A worse vital set re-triages at once. Disposition decision ≤ 4 h;
   decision-to-bed ≤ 2 h, then the bed manager, ≥ 4 h the Medical Superintendent.
3. **Zones are beds.** Resus, red, yellow, green, paeds ER, observation, isolation and triage bays are `bed`
   resources of class `emergency` in the existing registry (no second bed table; no rent — IPD review #756).
   ER places patients through an IPD bed export taking the same bed lock, with an `er_episode` holder.
4. **Unidentified patients.** One tap: "Unknown male, ~35 y" with a real UHID flagged `identity_status =
   unidentified`, a sequence alias ("Unknown-0412", Hindi "अज्ञात-0412"), photo, distinguishing marks, the
   bringer's name and phone. Never a temporary or fake UHID: the record is real and later merged into the true
   one through the existing `patient_merge` approval (urgent, 240 min). Everything — episode, orders, results,
   bill, MLC, admission, band — follows the merge chain. Two unknowns at once get distinct aliases and photos.
5. **Treat first, pay later** (Clinical Establishments Act 2010 and its rules, adopted by Bihar; Supreme Court,
   Parmanand Katara 1989; MV Act s.134A Good Samaritan). Before `declare_stabilised`: no surface shows a deposit
   ask, `take_deposit` refuses `before_stabilisation`, no clinical intent reads money. A Good Samaritan is never
   asked for identity, money or to stay. Victims of rape and acid attack are treated at ₹0 by law (BNSS s.397):
   the bill desk cannot raise a patient-payable line on such an episode.
6. **No money on doctor or nurse screens** (0058). The ER doctor's phone, the tracking board and triage carry no
   amount, no paid / unpaid word, no "stabilised for billing" wording ("Stabilised" is a clinical word only).
7. **MLC.** The ER doctor opens the MLC (assault, road accident, burns, poisoning, hanging, drowning, fall from
   height, snake / animal bite with dispute, unknown unconscious, sexual assault, brought dead, death within 24 h
   of an injury, police-brought, any case the doctor judges). Serial from the MLC register; written intimation
   to the police post / station within 1 hour (target) with the receiving officer's name and number recorded;
   faculty countersign within 24 h as an obligation (E8). MLC never delays treatment. POCSO cases: mandatory
   report recorded; sexual-assault examination by the MoHFW 2014 protocol, with consent or court order.
   MLC patients: family surfaces off, model calls off (as IPD), copies only to police on a written requisition.
8. **Brought dead.** No treatment episode, no charge, always MLC. ECG strip / time of examination recorded;
   body to mortuary through IPD's mortuary register (needs an `er_episode` holder); released only with police
   clearance; the hospital issues no MCCD (cause unknown) — police inquest and post-mortem decide. 0018's MCCD
   rule applies to deaths after arrival, not to brought dead (patients needs a `brought_dead` death kind).
9. **Codes (NABH names).** Code Blue (arrest), Code Yellow (mass casualty), Code Grey (violence against staff,
   common in Indian ERs), plus clinical activations: STEMI (door-to-balloon ≤ 90 min, door-to-ECG ≤ 10 min),
   Stroke (door-to-CT ≤ 25 min, door-to-needle ≤ 60 min), Trauma level 1/2, Sepsis (antibiotics ≤ 1 h),
   Snakebite (ASV ≤ 30 min of decision), Obstetric emergency (pages LR). `call_code` pages the roster's team for
   that code via push (lock screen: bay + code, never a name — Doctor Desk E13) and starts the clock.
   Code Blue anywhere in the hospital uses the same intents; the record lives in `emergency`.
10. **Admission hand-off.** `hand_to_unit` calls IPD `emergencyAdmit` (source `er`; ICU through
    `askEmergencyIcuApproval`) or `requestAdmission` when no bed yet; IPD copies `arrived_at`; the ER episode stays
    open as **boarding** until the IPD bed placement, so the patient never sits in a gap. `stabilisedAt` is copied
    to the admission (IPD `recordStabilised`). ER lines move to the IP running bill at hand-off.
11. **Drugs.** ER satellite stock (crash cart, emergency drugs) issues to the patient with patient labels and posts
    on issue to the ER episode's charge sink (billing `registerEpisodeChargeSink`, prefix `ER`), the way IPD ward
    issue does (#787). Doses recorded in an ER medication record (give / hold / refuse; high-alert second PIN, as
    IPD eMAR). Verbal orders allowed in resus; read back; signed by the end of the code or within 2 h.
12. **Refer out.** Reason (no bed, no service, patient choice), receiving hospital confirmed by phone with the
    name of who accepted, stabilisation documented, transfer summary printed, ambulance and escort recorded.
    Referral for lack of money is never a recorded reason (refused).

## 4. Lanes, in merge order (one migration each, numbered at merge)

| # | Lane | Builds | Surfaces |
| --- | --- | --- | --- |
| 1 | **er-arrival** | Module, episode + workflow, arrival modes, pre-alert, unidentified registration, band, ER desk, tracking board v1, link_identity | C Desk, A Board |
| 2 | **er-triage** | ESI triage, re-triage clock, vitals (IPD scoring export), bays, doctor assignment, door-to-doctor clocks, OPD red-flag seam (E9) | B Triage, A Board |
| 3 | **er-care** | Notes, ordering door (STAT), ER satellite issue + medication record, procedures, consent, specialty calls (E4), criticals to the ER doctor, stabilised | D Doctor |
| 4 | **er-mlc** | MLC register, police intimation, countersign obligation, belongings and evidence chain, brought dead, mortuary seam | E MLC desk |
| 5 | **er-dispo** | Discharge (summary + Rx), hand_to_unit + boarding (E5, E6), refer out, LAMA, LWBS, abscond, death (MCCD) | D Doctor, A Board |
| 6 | **er-bill** | ER tariff, ER charge sink, stabilisation gate on money, settle at departure, dues path, roll into IP, scheme / road-accident / BNSS ₹0 | H Bill desk |
| 7 | **er-codes** | Code calls, paging, resuscitation record, activation clocks, Code Grey | F Resus scribe |
| 8 | **er-mci** | Code Yellow, pre-made unidentified packs, START / JumpSTART tags, surge bays, MCI board, family information desk | G MCI board |
| 9 | **er-copilot** | Now cards (E10 `er.casualty_now`), triage proposal, "since arrival", MLC and discharge drafts, family display | all |

### 4.1 er-arrival
- Rules: arrival is recorded before anything else (≤ 3 taps); the only required fields are sex (or "unknown"), an
  approximate age band and arrival mode. A known patient is found by scanning the UHID card, Aadhaar QR or ABHA,
  or by phone number. One open ER episode per patient (second refused, shows the first). Band printed at arrival
  (IPD band code; serial `<ER no>-<n>`). Pre-alert from an ambulance call creates an "Expected" card on the board.
- Edge cases: patient arrives twice in 24 h → new episode, "returned within 24 h" flag; already admitted in IPD and
  wanders to ER → refused "patient is admitted — call the ward team", with a Code Blue path that never refuses;
  arrival during downtime → paper ER sheet with reserved serial, back-filled with real times (IPD
  `backfillDowntime` pattern); twins / similar names → Name alert on both; unknown later identified by family →
  `link_identity` files the merge, band reprinted with the true name.

### 4.2 er-triage
- Rules: triage by a nurse or doctor with the `er.triage` grant; the ESI decision points are shown as questions
  (needs life-saving intervention? high-risk / confused / severe pain? how many resources? danger-zone vitals?);
  the level is the human's choice; a copilot proposal is a suggestion with its reasons. Down-triage below the
  proposal or the last level needs a reason. Vitals reuse the IPD scoring export (NEWS2 / PEWS / MEOWS) as a
  second signal, shown beside the level.
- Edge cases: patient leaves before triage → `record_lwbs` with the last-seen time; re-triage overdue → task to
  the triage nurse, then the ER charge nurse; triage nurse on break → the ER charge nurse holds the queue;
  child without guardian → social-worker task and MLC check; OPD desk red flag (E9) → an "Expected from OPD"
  card, the OPD visit closed as "sent to Casualty"; violent or intoxicated patient → Code Grey available from the
  triage screen, triage continues behind security.

### 4.3 er-care
- Rules: orders through `orderTests` (lab, imaging, outside tests) with priority STAT and the ER episode; criticals
  ring the ER doctor of record and the ER charge doctor (lab critical ladder); results arrive on the board as a
  "result ready" chip. Specialty call: who (roster `calloutList` for the take unit), when called, when answered,
  when seen; unanswered 15 min climbs the ladder. Every ER note is the doctor's; resident entries are drafts
  until an SR / consultant co-signs within the shift.
- Edge cases: two doctors order the same STAT test → duplicate warning, not a block; drug allergy unknown
  (unidentified patient) → "Allergy: unknown" in words on band and labels, high-alert check still applies;
  patient's own medicines brought by family → recorded, not charged; tests ordered then the patient leaves LAMA
  → pending results still route to a recall task; contrast CT in an unknown-kidney-function patient → the
  radiology rule stands; the ER doctor does not override it alone.

### 4.4 er-mlc
- Rules: §3.7. The MLC record holds: injuries (body diagram + photos, with consent), alleged cause in the
  informant's words, informant identity, police intimation (time, mode, receiver, station, GD entry number when
  given), belongings list signed by two staff, evidence (clothes, swabs, bullet) with a chain-of-custody log.
  MLC copy and wound certificate print from the record. An MLC is never deleted; corrections are addenda.
- Edge cases: police bring the patient (intimation is their arrival — record the officer); patient refuses
  examination → recorded refusal, treatment continues; MLC opened late (after admission) → allowed, flagged
  late; patient dies before countersign → countersign still owed; unknown patient is MLC by default; injury
  declared "accidental" by family but pattern suggests assault → the doctor decides MLC, not the family.

### 4.5 er-dispo
- Rules: one disposition per episode, decided by a doctor with a reason; discharge needs a signed ER summary
  (diagnosis, treatment given, medicines, return-if signs in Hindi and English, follow-up OPD booked); LAMA needs
  the risk explanation and a signature (patient or representative) or a witnessed refusal to sign; death needs
  the MCCD number (0018) or, if unnatural, MLC + police; every departure releases the bay to cleaning.
- Edge cases: admitted patient boards in ER for 9 hours → stays on the ER board with ward orders and IPD nursing
  tasks visible; specialty refuses the admission → MS arbitration task; ICU bed none → ICU waitlist (IPD) and the
  ER keeps the patient on a resus bay; patient absconds → security alert, police if MLC, bill frozen; the
  family insists on refer-out against advice → LAMA form with referral.

### 4.6 er-bill
- Rules: ER charges post as they happen to the ER episode (charge sink `ER…`; billing's `issueInvoice` refuses the
  `ER…` grammar as it does `IP…`). Money acts are refused before `declare_stabilised`. At departure: settle at the
  ER counter, or dues against undertaking (Q2), or ₹0 under scheme / road-accident / BNSS s.397 / MCI (Q3, Q4).
  On `hand_to_unit` all ER lines carry into the IP running bill with their ER service dates. GST and NPPA rules as IPD.
- Edge cases: stabilised but the family has no money → the patient is still treated, admitted or discharged; the
  dues path runs; brought dead → no bill; death in ER → bill to next of kin by a person, not a message; body never
  held (IPD mortuary rule); road-accident claim later rejected → difference to patient-payable with a reason line,
  owner informed; charge on the wrong unknown patient → reversal and repost, both audited, merge carries the rest.

### 4.7 er-codes
- Rules: `call_code` with kind and location from any staff phone or the wall button; the scribe tablet records the
  resuscitation timeline by tap (CPR start / pause, rhythm, shock with joules, drug + dose, airway, ROSC, time of
  death) with server time; `end_code` needs the team leader's sign and an outcome. Activation clocks (STEMI,
  stroke, sepsis, snakebite) run on the board from door time, not activation time.
- Edge cases: two codes at once → each its own record and team page; code called on a wrong bay → move, never
  re-create; code on an unregistered visitor → `register_unidentified` inline, then the record; scribe tablet
  offline → paper code sheet, back-filled, flagged; Code Grey: security paged, the staff member's location shown
  to security only, incident report drafted.

### 4.8 er-mci
- Rules: Code Yellow is declared by the ER consultant on duty or the MS. It switches the ER to: pre-printed
  unidentified packs (band + MLC sheet + tag, numbered MCI-01…), START (adult) / JumpSTART (child) tags
  Red / Yellow / Green / Black with words, surge bays from the IPD overflow class with duty-manager approval,
  OPD and elective OT stops proposed to the MS, a family information desk list (no clinical detail), and the
  MCI board. Stand-down returns each patient to the normal ESI flow.
- Edge cases: 40 arrivals in 20 minutes → registration ≤ 10 s each from packs; the same person registered twice in
  the rush → merge after the event, never during; a Black tag later found alive → re-tag allowed, audited; press
  and VIP calls → the information desk script, no names to press; network down during MCI → the packs are paper-first.

### 4.9 er-copilot (T2: proposes, a person confirms)
- Now cards: `retriage_due`, `doctor_overdue`, `call_unanswered`, `result_ready`, `critical_result`,
  `boarding_long`, `mlc_intimation_due`, `mlc_countersign_due`, `pre_alert`, `lwbs_risk` (long wait, low ESI).
- Triage proposal: ESI level with the decision-point reasons from the complaint, age and vitals; never set by
  the model. "Since arrival": four to six source-chipped lines. Drafts: ER summary, MLC narrative (injuries from
  the body diagram, cause in the informant's words), referral letter; each "Draft" until signed. MLC and sealed
  patients: no model call (IPD rule). Family display and messages: stage words only, never clinical text.

## 5. Surfaces and budgets (medians from events, weekly)

- **A. Tracking board** (wall 16:9 + desktop, fits 1920 × 1080 with no vertical scroll): columns by zone; each tile
  = bay, alias or initials on the wall, ESI (word + number + colour), time since arrival, next clock, doctor,
  chips (result ready, MLC, isolation, boarding, Name alert). Top strip: in department, waiting for triage,
  boarding (count, longest), LWBS today, codes running. Board update ≤ 2 s after an act.
- **B. Triage** (tablet or phone 390 px): ESI questions as big buttons, vitals by tap or voice with read-back,
  proposal card. Budget: triage ≤ 90 s.
- **C. ER desk**: arrival ≤ 20 s and ≤ 3 taps for an unknown patient; known patient by scan ≤ 10 s.
- **D. ER doctor** (phone / tablet): my patients by need; patient view opens on "since arrival"; one bar for
  order · call specialty · stabilised · disposition. No money anywhere.
- **E. MLC desk**: owed intimations and countersigns with clocks; prints.
- **F. Resus scribe** (tablet landscape): one tap per event, 48 px targets, timer always on screen.
- **G. MCI board**: tag counts by colour, bays left, teams, hospital beds free (from IPD board).
- **H. Bill desk** (exceptions only): stabilised and departing, dues awaiting approval, scheme claims pending.
- **I. Waiting-area display and family**: token + stage word ("Being seen", "Waiting for test", "Admitting"),
  no names; attendant WhatsApp as IPD (off for MLC and sealed).
- Paper: every surface prints (ER sheet, triage card, MLC form, code sheet, MCI pack).

Budgets: door-to-triage median ≤ 5 min (p90 ≤ 10); door-to-doctor within the ESI targets for ≥ 90 %;
non-admitted ER stay median ≤ 4 h; decision-to-bed median ≤ 2 h; code page delivered ≤ 10 s; MLC intimation
≤ 1 h for ≥ 95 %; LWBS ≤ 2 % of arrivals.

## 6. AI-era and UX edge cases (beyond the per-lane lists; IPD §4.10 also applies)

1. Proposal stale (patient re-triaged, moved): card withdraws itself with the reason.
2. Copilot proposes ESI 4, nurse picks 2: logged as override; no prompt to justify an up-triage.
3. Voice in a loud resus room mishears a dose: drugs are never taken from voice; numbers read back large.
4. Bhojpuri / Maithili / Magahi complaint: shown as heard; low-confidence words not filled.
5. Wall board for days: heartbeat, "Offline · last update 14:02" within 5 s, no names, slight hourly shift.
6. Phone on the lock screen: bay + code only, never a name.
7. Two staff place the same patient in two bays: one wins, the other sees "already in R-3".
8. Retried request on bad network: idempotency key per intent; one dose, one arrival.
9. Police officer asks a staff member for the record: only via a written requisition logged on the MLC.
10. Relative films in ER: Code Grey path; no system action beyond the incident record.
11. Patient's own assistant (future) asks for status via ABDM consent: stage word only, never MLC detail.
12. Unknown patient's photo: stored under the MLC, shown only to ER and police-requisition copies.
13. Clock on a phone wrong: server time everywhere.
14. Shift change at 08:00 with 30 patients: handover list per doctor and nurse; each patient accepted by tap.
15. Take changes at 08:00 while a 07:55 arrival waits: belongs to the unit on take at arrival (Doctor Desk E02).
16. A doctor triages and treats alone at night: both acts allowed; the report notes "single doctor".
17. Downtime: paper ER sheets with serials; back-fill keeps real times; nothing is lost in the merge.

### Autonomy ladder

| Job | Today | Can climb to | Never |
| --- | --- | --- | --- |
| ESI level | T2 proposes | stays T2 | auto-set |
| Re-triage reminders, clock escalations | rules | — | — |
| ER summary, MLC narrative, referral letter | T2 draft | stays T2 | auto-sign; MLC auto-file |
| Bay proposal | T2 | T3 for green-zone bays after 4 weeks ≥ 95 % accepted | resus, isolation |
| Family stage messages | rules | — | clinical text |
| Doses, orders, disposition | none | none | ever |

## 7. Done means (acceptance checks; each calls intents)

er-arrival
- [ ] An unknown patient is registered with three answers and gets a real UHID, alias and band; a second unknown
      at the same minute gets a different alias.
- [ ] A merge of an unknown into the true record carries the episode, orders, bill, MLC and band reprint.
- [ ] `arrived_at` is the gate instant; a registration entered 15 min later does not change it.
er-triage
- [ ] Each ESI level sets its re-triage interval; an overdue re-triage becomes a task once, then climbs.
- [ ] A down-triage without a reason is refused; an up-triage is not.
- [ ] A 07:55 arrival entered 08:10 is stamped to the night's take unit.
er-care
- [ ] An ER test order goes through `orderTests` with STAT priority and lands on the ER charge sink.
- [ ] A critical result reaches the ER doctor of record; unacknowledged, it climbs.
- [ ] No clinical intent refuses on money, identity or MLC state (one test per intent with an unpaid, unknown,
      MLC patient).
er-mlc
- [ ] A brought-dead arrival opens an MLC, posts no charge and cannot record a death without police clearance
      on body release.
- [ ] An MLC without police intimation after 1 h becomes a task; without countersign after 24 h, an obligation.
- [ ] An MLC record cannot be deleted; an edit is an addendum.
er-dispo
- [ ] `hand_to_unit` creates the IPD admission with `arrived_at` and `stabilisedAt` copied; the episode stays
      boarding until bed placement.
- [ ] Referral with reason "cannot pay" is refused.
- [ ] Death in ER refuses without an MCCD number unless MLC with police intimation.
er-bill
- [ ] Before `declare_stabilised` a deposit or ask is refused; after it, allowed.
- [ ] A rape or acid-attack episode cannot carry a patient-payable line.
- [ ] On admission, every ER line appears on the IP running bill with its ER service date, once.
- [ ] A patient leaving with a balance is never refused departure; dues are recorded against the undertaking.
- [ ] No ER doctor, nurse or board surface shows any money (guard test, as 0058).
er-codes
- [ ] `call_code` pages the roster team within 10 s; the lock-screen text has no name.
- [ ] A STEMI clock starts at door time, not activation time.
er-mci
- [ ] Code Yellow registers 40 pack patients in under 7 minutes in rehearsal; stand-down returns them to ESI.
er-copilot
- [ ] An ESI proposal is never applied without a person's tap; an MLC patient triggers no model call.
- [ ] A "since arrival" line whose number differs from its source fails the suite.
Experience (rehearsal week, then weekly)
- [ ] Door-to-triage median ≤ 5 min; unknown arrival ≤ 20 s; triage ≤ 90 s; every surface prints and shows
      "Offline" within 5 s; the board fits 1920 × 1080 and passes at 1366 × 768; phone screens pass at 390 px
      with text at 130 %.

## 8. Seams other modules owe (coordinate; shared files)

- `patients`: `identity_status` (unidentified) column and alias; `brought_dead` death kind beside 0018's MCCD rule.
- `ipd`: bed-placement export accepting an `er_episode` holder; mortuary register accepting an ER episode;
  scoring export (NEWS2 / PEWS / MEOWS); ER lines readable by the IP bill composer.
- `billing`: `ER` episode grammar refused by `issueInvoice`; ER sink registered by `EmergencyModule`.
- `roster`: new escalation kinds (`er_retriage`, `er_call`, `er_boarding`, `mlc_intimation`) are a migration in
  `ROSTER_ESCALATION_KINDS`. `opd`: red-flag brake creates the expected-arrival card (E9).
- Shared files touched: `app.module.ts`, `kernel/modules/manifests.ts`, `kernel/db/schema/index.ts`,
  `scripts/seed-roles.ts` (new `er.*` permissions + README prose), `router.tsx`, locales.

## 9. Out of scope

Ambulance fleet and dispatch (own brainstorm, 0012), blood-bank issue chain, labour-room triage, ICU device feeds,
telemedicine to district hospitals, portal automation of scheme and road-accident claims (Phase 3).
