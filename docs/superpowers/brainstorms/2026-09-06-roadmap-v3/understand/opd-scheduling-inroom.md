# opd-scheduling-inroom — pillar 2a (zero-wait dynamic scheduling) and 2c (in-consultation service delivery)

Read-only survey of `origin/main` @ `b04cbd9` (2026-09-06). Paths are relative to the main-ro checkout. Production runs `c11833d` (56 migrations, 90 commits behind, `git log c11833d..HEAD | wc -l` = 90); "deployed" below means present at `c11833d`, verified with `git ls-tree c11833d`.

Status vocabulary: **deployed** (in `c11833d`) · **merged** (on main, not on prod) · **authored** (phase doc exists, no code) · **brainstormed** (department series only) · **absent** (nowhere).

---

## 1. appointment-duration-by-visit-type — ABSENT (rails: partial)

**What exists (deployed).**
- Slot length is ONE number per schedule template, falling back to a hospital-wide config: `opd_config.slot_minutes` default 10 — "owner decision: 10-minute slots" (`apps/core/src/kernel/db/schema/opd.ts:23`); per-template override `opd_doctor_schedules.slot_minutes` "null ⇒ opd_config.slot_minutes" (`schema/opd.ts:103`); the pure allocator steps a fixed `(t.slotMinutes ?? input.defaultSlotMinutes) * 60_000` across the template (`apps/core/src/modules/opd/slots.ts:22-25`). Owner decision of 2026-08-15 folded into Plan 07: "both appointment-led and walk-in-led, 10-minute slots" (`docs/superpowers/plans/2026-08-15-phase1-07-opd-encounters.md:11`).
- Visit type is `new | revisit | renewal` and is computed **at visit OPEN, not at booking**: `classifyVisit(anchor, now)` anchored on the patient's last COMPLETED consult in the SAME DEPARTMENT with that consult's `followUpDays` (`modules/opd/visit-type.ts:5-13`; caller `modules/opd/encounters.ts:104-110`). It drives the FEE branch (revisit free; `visit.opened` payload `visitType` `modules/opd/events.ts:84`), never the length. `opd_appointments` carries `slot_start/slot_end/status/source` and **no visit type, no duration** (`schema/opd.ts:144-149`); `appointments.ts` never calls `classifyVisit` (grep: no hit).
- The enum has **no "post-surgical review"**: `z.enum(["new","revisit","renewal"])` on the reclassify route (`modules/opd/opd-visits.controller.ts:113`) and on `consultation.completed` (`events.ts:321`). The only surgical link is `consultation.completed.admissionAdvised` (`events.ts:325`).
- The only pace term anywhere is a STATIC per-department constant: `opd_departments.avg_consult_minutes` default 6, "wait v0 is waitingCount × avgConsultMinutes … a future pace model replaces THIS COLUMN'S READ" (`schema/opd.ts:48-50`; edited via masters `modules/opd/masters.ts:113-114`, capped 240 `opd-masters.controller.ts:126`).
- Follow-up window config: 7 days default, doctor extensions `[15,21,30]`, cap 30/doctor/month (`schema/opd.ts:24-26`; `modules/opd/consultation.ts:172,204`).

**What the brainstorms designed.**
- Doc 20 §3.1 `appointment_v2` is an OVERLAY on Plan 07's row (confirmations, waitlist, overbooking, delay declaration, no-show ladder) — `docs/superpowers/brainstorms/2026-08-27-department-series/20-front-office-appointments-tpa-claims.md:120-134`. Its `appointment_policies` table carries `slot_minutes` per **doctor or department**, plus `overbook_pct`, `no_show_grace_min` (`20:219`) — still not per visit type.
- Appointment Optimiser (agent, T2, deterministic core + LLM explanation): drafts overbook % within bands, rebalancing, cover suggestions; FO supervisor accepts item-by-item; shadow 30 d; "20 (after 90 days baselines)" (`20:587`), Plan 20b (`20:707`) = reconciled **22b** (`00-INDEX-AND-SYNTHESIS.md:68`).
- Doc 05 tele: "tele slots are OPD schedule rows with a `mode`" (`05-video-consultation-opd.md:25`); B6 reuses `classifyVisit` verbatim (`05:158`); Follow-up Scheduler automation T1 proposes a follow-up slot from `consultation.completed` (`05:49,354`).
- Consult DURATION appears in the series only as a diagnostic: FR-12 "consultation duration distribution per doctor is a diagnostic, never punitive" (`20:408`); `tele.consult_duration_p50` (`05:327`). **No document designs slot length by visit type.**

**Rulings that bind.** 10-minute slots (owner, 2026-08-15, Plan 07:11); L1 queue discipline locked (walk-in never beats a due appointment, late keeps priority) (`20:29`); L3 follow-up 7/15/21/30 (`20:31`); revisit anchor = department (`visit-type.ts:5-7`); R-216 overbooking bands, R-217 unconfirmed release, R-218 no no-show fee year 1 (`00-OWNER-RULINGS-REGISTER.md:228-230`); FD-7 DECIDED continuity window 6 months (`plans/2026-09-03-phase1-fd7-three-seats.md:86-88`). ROADMAP v2 §5: "not 22/22a (PBX, kiosks, gateway are procurement)" this quarter (`docs/superpowers/2026-09-06-ROADMAP-v2.md:414-417`); Plan 20 in the calendar is the ROSTER substrate, not front office (`ROADMAP-v2.md:336`; index `00-INDEX-AND-SYNTHESIS.md:66`).

**Gaps to close for the mission.** (1) A visit type known at BOOKING — `classifyVisit(anchor, slotStart)` is pure and can be evaluated for a future date; (2) minutes per type (new / revisit / post-surgical) as `opd_config` or `appointment_policies` data; (3) `slotsForDate` allocates fixed steps and the booking arbiter is the partial unique index on `(doctor_id, slot_start)` (`schema/opd.ts:450-452`) — a 20-minute booking must claim two starts or the arbiter changes; (4) a "post-surgical review" type needs a source: Plan 15 day-care case ref / `admissionAdvised`; (5) any DYNAMIC adjustment needs a measured pace per doctor and type, which is item 3's baseline.

**Parameter that confirms it (measurable today).** median(`consultation.completed.occurred_at − consultation.started.occurred_at`) grouped by `consultation.completed.visitType` per doctor (`events.ts:315-328`; every row has `occurred_at`, `kernel/db/schema/events.ts:28`); or `opd_encounters.consult_completed_at − consult_started_at` (`schema/opd.ts:334-335`, stamped at `consultation.ts:135,227`). Goal parameter: booked slot minutes within ±25 % of the trailing-30 median for that type.

---

## 2. delay-prediction — BRAINSTORMED (Wait-Time Predictor T0); code has a static v0

**What exists.**
- Wait v0 = `waitingCount × avgConsultMinutes`, rendered as minutes AND a clock time — in THREE places: server `summaryByDoctor` (`modules/opd/queue.ts:270-274, 336-347`), web `waitMinutes()` (`apps/web/src/screens/desk-one/model.ts:221-240`), web routing `waitOf` (`apps/web/src/lib/walk-in-routing.ts:56`). model.ts itself warns "Two formulas for one number is how a screen and a server come to quote different waits" (`model.ts:231-233`). **Deployed**: `avgConsultMinutes` is in `c11833d`'s schema (`git show c11833d:…schema/opd.ts` line 48-50).
- The 20-minute rule (owner R2, 2026-09-03): wait > 20 min → highlight in red and NAME the shortest-wait doctor; never re-routes alone (`fd7-three-seats.md:79-81`; `walk-in-routing.ts:30-37`, `DELAY_HIGHLIGHT_MINUTES = 20`). T8 auto-assign to least wait on department-queue join (owner ruling, `fd7:333-352`) — found the leave defect: "an empty queue is the shortest queue" (`fd7:345-352`). Merged (FD-7), not deployed.
- Session lateness is RECORDABLE: `queue_session.opened {openedAt, scheduledStart}` (`events.ts:294-297`; `modules/opd/sessions.ts:145,208`) so first `queue.called − scheduledStart` = "silent lateness" (doc 20's negative-space signal `20:717`, doctor KPI `20:572`).
- Doctor delay declaration: **absent in code** (grep `doctor_late|delay_declared`: none). Designed in doc 20 §3.1: `doctor.delay_declared {minutes, reason}` shifts `appointmentAt` for class computation only, WhatsApp "running ~40 min late; position preserved", opens walk-in gap-fill; > 90 min → E2 (`20:133`); `doctor_delays` table (`20:222`); PA may declare (ST-2 `20:363`); one-tap target < 10 s (`20:615`). 22c-D T5 "Session signals: doctor late, break, cancelled" is **authored, not executed**: CLOSE section reads "(Filled by the executing session.)" (`plans/2026-08-28-phase1-22cD-appointment-journey.md:149,181-190`) and no `check_in_source|journey_tasks` exists in `apps/core/src` (grep: none).
- The public wait surface: 22c-D DD4 rules **position, not minutes** — "a range is shown only at positions ≤ 5, widening with distance, and never a single figure" (`22cD:84`); DD5 patient topic `appointment:<id>` `{position, delta, reason}` (`22cD:86`). Not built.

**What the brainstorm designed.** Wait-Time Predictor: automation T0, every 60 s per doctor session over own events (calls made, consult durations trailing 30, queue depth by class, delay declared) → minutes per waiting entry on display + public link; no sign-off; fail-open "n ahead"; backtest MAE < 10 min on last 30 days; never hides class order; DPIA none (`20:584`); Plan 20 item 7 (`20:706`) = reconciled 22. SC-4: display "now serving / your token / est. wait" degrades to "n ahead" with no model (`20:441`). Chaos 6.2 surge: predictor shows 95-min estimates, "patients leave and come back instead of crowding" (`20:471`).

**Rulings.** L1 locked order — a predictor is informational only; L22 agents payer-blind and VIP-blind, monthly wait-time-by-payer-class equity report (`20:52`; spec `2026-08-10-hmis-architecture-design.md:649`); Optimiser is T2 and waits for 90 d of baselines (22b); R-059 blocks only AUDIO inference (`00-OWNER-RULINGS-REGISTER.md:71`) — a regression over own events has no inference and no DPIA v0.2 dependency (CONTEXT: "Nothing with inference runs on production before DPIA v0.2"). ROADMAP v2 §5 excludes Plan 22 this quarter (`ROADMAP-v2.md:414`).

**Gaps.** No per-doctor pace (department constant, hand-edited); no per-class or per-type pace; no `doctor.delay_declared` event; no baseline data — production has 498 events and never left `commissioning` (CONTEXT §position). A T0 predictor could be a pure read in `opd` (replacing "THIS COLUMN'S READ", `schema/opd.ts:49`) rather than a Plan 22 module.

**Parameter.** MAE of quoted wait vs realised (`queue.called.occurred_at − eligible_at`) per doctor-session, computed from `opd_queue_entries.eligible_at/called_at` (`schema/opd.ts:380-381`); target MAE < 10 min (doc 20's own figure).

---

## 3. queue-wait-measurement — DEPLOYED instruments, NO consumer (no KPI registry)

**Events and columns that already time the OPD journey** (all `module: "opd"`, every row stamped `occurred_at` `kernel/db/schema/events.ts:28`; `kernel/events/append.ts:36`):

| clock | start | stop |
|---|---|---|
| arrival → vitals | `visit.opened` (`events.ts:77`; `opd_encounters.opened_at` `schema/opd.ts:339`) / `patient.checked_in {kind: arrival\|re_entry}` (`events.ts:132-135`) | `vitals.recorded` (`events.ts:190`); bench rest/step-out `bench.state_set` (`events.ts:268`) |
| eligible → called (the hall wait) | `opd_queue_entries.eligible_at` set on `waiting`, reset on skip (`schema/opd.ts:380`; `queue.ts:159`) | `queue.called {callCount}` (`events.ts:304-307`; `called_at` `queue.ts:131`) |
| called → in room | `queue.called` | `consultation.started` (`events.ts:315`; `consult_started_at` `consultation.ts:135`; `in_consult` `queue.ts:183`) |
| consult duration | `consultation.started` | `consultation.completed {visitType, followUpDays, admissionAdvised, prescriptionCount}` (`events.ts:319-328`; `consultation.ts:227`) |
| session lateness | `queue_session.opened.scheduledStart` (`events.ts:296`) | first `queue.called` |
| session throughput | `queue_session.opened` | `queue_session.closed {seen}` (`events.ts:299-302`) |
| results loop | `consultation.completed` into `awaiting_results` | `patient.checked_in {re_entry}`; `visit.abandoned` (`events.ts:144`) |
| wait SLA | `opd_visit` definition: registered 20 min record_only · **waiting 45 min ACTIVE, escalation front_office_supervisor@15 / duty_manager@30** · in_consultation 60 · awaiting_results 240 (`modules/opd/workflow-def.ts:20-23`) | `sla.breached {instanceId, state, slaMinutes}` from the engine (`kernel/workflow/events.ts:20-28`) |
| danger bump | `queue.escalated {escalatedAt}` / `queue.escalation_cancelled {withinMs}` (`events.ts:245-262`) | — |
| fee gate flip | `queue.fee_status_changed` (`events.ts:122`) | — |

Lab side: `lab.order_desked` (`modules/lab/events.ts:45`) minus `consultation.completed` = the walk from room to lab desk; `lab.label_printed` (`:58`) → `lab.specimen_collected {wristbandScanned, collectionSite}` (`:77-79`) → `lab.specimen_received` (`:83`); TAT starts at receive (`schema/lab.ts:303-305`); the collection queue row carries `waitingMinutes` since `labelledAt` (`modules/lab/collection.ts:110-111`). Pharmacy side: `dispense.queued/claimed/verified/picked/billed/handed_over/cancelled` (`modules/pharmacy/events.ts:14-62`) with SLAs queued 120 / claimed 2 / verified 3 / picked 5 / billed 1440 min, all record_only (`modules/pharmacy/workflow-def.ts:33-39`) — `queued → claimed` IS the pharmacy queue wait.

**Consumers.** None computes a KPI: the staffing spec names "OPD wait-SLA compliance (`sla.breached` on waits) … wait-SLA >92 %" for the FO supervisor (`docs/superpowers/specs/2026-08-11-hmis-staffing-kpi-design.md:40-42`); doc 20 §8 `fo.sup.wait_sla = 1 − sla.breached(state=waiting) ÷ visits` (`20:532`); the KPI formula registry is Plan 21 and "does not exist" (lab runbook §11 quoted at `docs/PROJECT-BRIEF-2026-08-30.md:880`). The display board consumes `queue.called/skipped` only (`apps/web/src/screens/opd-display.tsx:90-92,113-126`).

**Gaps.** No stored per-entry wait (position computed on read, 22c-D DD4); no per-doctor pace read; no `doctor.delay_declared`; no registry to publish the numbers; no data on production. Everything in the table above is in `c11833d` (Plan 07 + VD-1 `escalation.ts`/`bench.ts` present at `c11833d`).

---

## 4. in-room-phlebotomy — ABSENT as a flow; the lab rail does NOT bind collection to a chair

**The path today (merged; collection.ts and lab-collection.tsx are also in `c11833d`).**
1. The doctor ADVISES, never orders: `advised_tests` jsonb on the encounter (`schema/opd.ts:328`), saved through the consult note (`apps/web/src/screens/opd-consult.tsx:461-471`); Plan 07d T5: "creates no order, books no sample and returns no result" (`plans/2026-08-28-phase1-07d-doctor-cockpit.md:133-134`). The envelope refuses agents outright — "a drafter proposes, a human orders" (E12, `kernel/orders/place.ts:255-262`); the placer may be a `clinician` (`place.ts:251`).
2. The LAB DESK converts advice to an order and BILLS in the same transaction: `advisedTestItems` (`modules/lab/desk.ts:170-186`), permission `lab.desk.operate` (`desk.ts:165`), invoice + items with `collectionSite: item.collectionSite ?? "opd"` (`desk.ts:480-489`); the desk body accepts `collectionSite ∈ opd|ward|home|camp|external` per item (`modules/lab/lab-desk.controller.ts:35-40`). Doc 02's flow: OPD `ordered → awaiting_payment → awaiting_collection`, payment within 30 min (`02-central-lab-lims.md:95-98,112`).
3. Labels print only after the patient's UHID scan (`POST /lab/collection/labels {scannedUhid}` `lab-collection.controller.ts:6-11`; doc 02 §10 "printed at the chair after the patient scan, never before" `02:482`).
4. The draw: `POST /lab/collection/collect {specimenId, wristbandScanned, site?}` (`lab-collection.controller.ts:13-17,90-107`), permission `lab.collection.operate`; `collect()` CASes `labelled → collected`, stamps `collectedBy = actor.id`, `collectedAt`, `collectionSite = input.site ?? specimen.collectionSite` (`modules/lab/collection.ts:308-333`); an unscanned draw is recorded, and the identity re-check lands at accession (`collection.ts:300-306`; `schema/lab.ts:300-301`). The queue is SITE-scoped (`collectionQueue(db, actor, {site?, serviceDate})` `collection.ts:149-153`; `queueQuery.site` `controller:19-21`) and reads the OPD token (`collection.ts:105-109`).
5. `collection_site` is a closed CHECK of five values `opd|ward|home|camp|external` on both `lab_items` and `lab_specimens` (`schema/lab.ts:299,317-318,361,385-386`); a consult room is `opd` with **no room/location column**. `RESOURCE_KIND_VALUES` = floor, ward, hall, room, bed, theatre, store, bench, analyzer, device (`kernel/db/schema/resources.ts:86-88`) — no chair, display, counter. The chair screen has no site selector (grep `site` in `lab-collection.tsx`: none; web only READS `collectionSite`, `apps/web/src/lib/lab-api.ts:72,278`).

**Answer to the question asked.** The accession path already accepts a collection recorded by ANY `lab.collection.operate` holder at ANY of the five sites; nothing checks a chair or bench. A nurse in the consult room can `collect` today. What she CANNOT do from the room: place the order (desk permission + payment), print the label (no room printer binding), or hand the tube to transport (the patient walks it; `collected → accessioned` "transport 45 min, runner/tech" `02:114`).

**Brainstorm coverage.** Doc 02: phlebotomist card "OPD collection chairs, ward rounds, stat tasks, ED draws" (`02:57`); ward BEDSIDE pattern with wristband scan (A2 `02:216`), ward tablet app "scan → collect → mark" (`02:486`, hardware `02:533`); L4 "multiple collection sites … queue per site; one accession point per site or central" (`02:343`); T4 "phlebotomy queue (extends Plan 07 queue engine), chair screen, label service, ward tablet collection" (`02:566`); collection chairs = `room` children with `chair=true` (`02:202`). Doc 03 `sample_custody` for the home leg (`03-home-collection-home-care.md:117-127`). Doc 20 `opd_flow_handoff` "Send to vitals/billing/lab reception" with ack SLA 15 min for lab reception (`20:162-167,622`). **No document in the series designs a draw inside the consultation room** (series grep for consult/consultation room: only 08's cleaning class `08:115` and 20's CL-11 no cameras in consult rooms `20:356`).

**Rulings that bind.** R-002 report-blocked-until-paid scope (`REGISTER:14`); doc 02 §3.1 OPD pays before `awaiting_collection` (`02:112`) — money, so an in-room draw BEFORE the lab invoice is settled needs an owner ruling (pay-before-exit for lab items, mirroring L7's rails-down relaxation `20:35`); consent-class tests cannot be collected without consent (DD14 `schema/lab.ts:292-294`; 02 E1 `02:268`); identity at the tube A1/A2 (`02:215-216`); phlebotomist KPI `wristband_scan_rate` 100 % (`02:433`); R-020 no LLM text to patients (`REGISTER:32`).

**Gaps to close.** (a) Ordering from the consult seat (a doctor-side `placeOrder` door; billing at the desk or on exit); (b) the money ruling above; (c) a location for the draw — a `roomId` on `lab_specimens` or a sixth site value (the E49 note says `home` was added "not a column" `schema/lab.ts:298`); (d) a printer at the room — server-side printing is RULED (`kernel/printing`, memory: printing-architecture-ruling); (e) a task to a phlebotomist pool ("come to room 12") — the P5 pool engine is Plan 19a, explicitly not built this quarter (`ROADMAP-v2.md:414-415`); (f) the room→lab transport leg and its custody scan.

**Parameter.** share of OPD `lab.specimen_collected` rows whose `collectedAt − consultation.completed.occurred_at ≤ 10 min` for the same encounter (both events exist today), plus `collection_site`/room attribution once (c) lands.

---

## 5. in-room-medicine-delivery — ABSENT; 16c is a counter, doc 03 is a home last-mile

**What exists (merged, NOT deployed — `git ls-tree c11833d apps/core/src/modules/pharmacy/` is empty; the 11i catch-up adds `pharmacy` `plans/2026-09-06-phase1-11i-the-stand-up-path.md:60`).** 16c D10: a consumer of `prescription.issued` inserts `queued`, idempotent per (prescription, version) (`modules/pharmacy/queue.ts:21-30`); the counter claims by Rx QR / patient QR / `T-n` token / UHID (D4, `plans/2026-09-02-phase1-16c-opd-dispense-counter.md:41`); verify re-runs allergy/interaction checks (D9); FEFO pick reserves stock at store `PHARM-OPD` (`modules/pharmacy/config.ts:8-9`; D2); bill at `min(batch MRP, ceiling, tariff)`; HAND OVER at the window with a second identity confirmation for H/H1 under `pharmacy.dispense.scheduled` (`modules/pharmacy/handover.ts:31-35`; D7 `16c:44`); "money moves before the drug leaves" (D8 `16c:45`). Definition `queued → claimed → verified → picked → billed → handed_over | cancelled` (`modules/pharmacy/workflow-def.ts:33-39`). No location, runner, or delivery field anywhere in the module (grep `runner|deliver|room`: one unrelated comment `verify.ts:53`).

**Brainstorm coverage.** Doc 16 §3.1 counter flow (`16-pharmacy.md:56-80`); "Rx-ahead-of-patient: cart pre-verified on `prescription.issued`; counter shows ready before the patient reaches; target ≥ 80 % of carts VERIFYING before scan" (`16:459`) — the nearest thing to "no pharmacy queue"; A2 attendant collects for bedridden OPD (`16:176`); J1 public display tokens only (`16:292`); M6 counter announces token when WhatsApp is down (`16:320`); IPD unit-dose cassettes to wards (`16:461`, 16d); home delivery = doc 03 §3.3 `medicine_delivery` (pharmacist `rx.verified_for_delivery` → `dispense.completed` → packed → `delivery.dispatched` → `delivery.handed_over` with OTP/photo/geo; Schedule X/NDPS never; rider as vendor actor) (`03:128-137`), scope R-181 (`REGISTER:193`). **No document designs a runner from the counter to a consult room.**

**Rulings that bind.** Pharmacy Act §42 / D7: a Schedule H/H1 hand-over completes only under the pharmacist's permission with identity confirmation (`handover.ts:33-35`) — an aide can carry, only a pharmacist can HAND OVER; R-174 hospital pharmacy dispenses only to encounters; R-175 substitution needs patient consent captured (D6 `16c:43`) — a room delivery must capture consent before pick or bring the choice to the room; R-176 single dispense per Rx; D8 money first — today the patient must visit billing before the drug moves; R-177 discount floor; the GST-on-MRP question is the pharmacy launch blocker (memory: pharmacy-launch-2026-09-06); R-182 pharmacist headcount (2–3).

**Gaps to close.** (a) a delivery leg in the definition (`picked → billed → dispatched_to_room → handed_over` with `roomId`, carrier, and the pharmacist's hand-over act — or a pharmacist at the room); (b) who carries — P5 task pool (19a, not this quarter); (c) payment before the drug leaves — either the counter bills against the encounter and the patient settles at one exit counter (owner ruling: money), or a room-side tender (no cashier session in a consult room — SoD, `16:48`); (d) counselling and the H1 register row at the room (`counselled_by` on `pharmacy_dispenses`, `16:152`).

**Parameter.** `dispense.handed_over.occurred_at − prescription.issued.occurred_at` per OPD encounter (both events exist), target median ≤ 8 min (doc 16's own counter target `16:469`); share handed over with `roomId` set once (a) lands.

---

## 6. token-queue-displays — DEPLOYED (Plan 07 T16); position/wait surfaces authored only

- `opd-display.tsx` is in `c11833d`: full-screen TV board of TOKENS, ROOMS, DOCTORS and "NOTHING that identifies a patient (§14)" (`apps/web/src/screens/opd-display.tsx:12-13`), browser speech in Hindi then English on `queue.called` (`:44-52,113-126`), patched before the 15 s poll (`:90-92`). Role `display` seeded (`PROJECT-BRIEF-2026-08-30.md:1298`); permission `opd.display.read` (grep count 4 in `modules/opd`). Realtime topics per hall/doctor-day (`modules/opd/realtime.ts:13-19,45`).
- Desk One shows per-doctor queue bars with wait as minutes AND clock (`desk-one/model.ts:221-240`; `stages.tsx:868`) and a dock "Q" listing every line (`stages.tsx:235-237`) — merged (FD-7/FD-25), not deployed.
- **No wait estimate and no "n ahead" on the public board**; no public queue-position route (grep `queuePosition|/public/`: none). 22c-D T3 patient-scoped position topic is authored, not built (`22cD:131-143,181-190`).
- Doc 20 designs `display_endpoints` as registry kind `display`, announcement queue, TTS cache, numeral audio pack hi/en, `needs_visual_call`, heartbeat KPI `fo.sup.display_uptime`, announcement latency < 2 s (`20:57,535,620,706`) — Plan 22 item 4, out of quarter. The registry has no `display` kind (`schema/resources.ts:86-88`).
- Rulings: L2 tokens only, never names; aliasing on all public surfaces (`20:30`); R-144 VIP privacy only, never clinical priority (`REGISTER:156`).

---

## Facts

1. Slot length is one fixed number per template or config (10 min, owner 2026-08-15); the visit type never reaches the slot (`slots.ts:22`; `schema/opd.ts:23,103,144-146`).
2. Visit type is computed at OPEN from the department's last completed consult, never at booking; the enum is `new|revisit|renewal` with no post-surgical type (`visit-type.ts:9-13`; `opd-visits.controller.ts:113`).
3. The only pace term is a static per-department `avg_consult_minutes` (default 6), and wait v0 = `waitingCount × avgConsultMinutes` is duplicated in server and two web files (`schema/opd.ts:48-50`; `queue.ts:346`; `model.ts:238-240`; `walk-in-routing.ts:56`).
4. Every OPD clock needed for prediction is already evented with `occurred_at` and in production's base: `visit.opened`, `patient.checked_in`, `queue_session.opened{scheduledStart}`, `queue.called`, `consultation.started/completed{visitType}`, `sla.breached{state, slaMinutes}` (`events.ts:77-328`; `kernel/workflow/events.ts:20-28`) — but production holds 498 events and no consumer computes a KPI (Plan 21 does not exist).
5. `doctor.delay_declared` exists only in doc 20 and the un-executed 22c-D T5 (`20:133`; `22cD:149,181`).
6. The doctor advises; the lab desk orders and bills (`07d:133-134`; `desk.ts:170-186,480-489`); agents can never place an order (`place.ts:255-262`).
7. `collect()` accepts any of five sites from any `lab.collection.operate` holder and binds to no chair; the site CHECK is closed (`collection.ts:308-333`; `schema/lab.ts:317-318`); the resource registry has no chair/display/counter kind (`schema/resources.ts:86-88`).
8. The pharmacy dispense is a window act ending in a pharmacist hand-over with identity confirmation; no delivery state, no location (`handover.ts:31-35`; `pharmacy/workflow-def.ts:33-39`); doc 03's delivery is home-only (`03:128-137`).
9. Plan 22 (appointments v2, predictor, displays, kiosks) and 22b (Optimiser after 90 d) are explicitly outside this quarter; Plan 20 in the calendar is the roster (`ROADMAP-v2.md:336,414-417`; index `:66,68`).
10. Production `c11833d` has Plan 07 OPD, VD-1 bench/escalation, the display board, lab collection, wait v0 — and no pharmacy module (git ls-tree evidence above).
11. The P5 task pool (19a) that a "runner" or "phlebotomist to room 12" would ride is not built this quarter (`ROADMAP-v2.md:414-415`).
12. Owner rulings owed by the mission's 2c, in the register's vocabulary: money — lab collection before lab payment; money — pharmacy hand-over before a single exit settlement; law — none new (Pharmacy Act hand-over stays with the pharmacist).

## Surprises

- The wait quoted to a patient on Desk One and by the 20-minute rule is a hand-typed department constant, not a measurement — while the events to measure it have been recorded since Plan 07 (`masters.ts:113-114` vs `events.ts:304-328`).
- 22c-D ruled "position, not minutes … never a single figure" for the patient (`22cD:84`), which is in direct tension with the mission's "predict potential delays in advance" — the two need reconciling before a predictor is authored.
- T8's auto-assign found that an empty queue is the shortest queue and would have routed every patient to the doctor on leave (`fd7:345-352`) — a warning for any pace model that trusts `waitingCount` alone.
- The lab rail is closer to in-room collection than the pharmacy rail is to in-room delivery: the draw can already be recorded anywhere; the blockers are ordering, payment and the printer, none of them lab code.
- Appointments never classify the visit, so "revisit is free" is only known when the patient arrives; a booking-time classification is a pure-function call away (`visit-type.ts:9`), which is also the door to type-based length.
- "Post-surgical review" exists in no enum, no plan and no ruling; Plan 15's day-care case and `admissionAdvised` are the only hooks.
- The overbooking policy hinges on a trailing no-show rate (R-216) and `appointment.no_show` is already swept and evented (`events.ts:68`; Plan 07 T4) — that baseline can accrue from day one of UAT.
- The mission's "eliminate pharmacy and lab queues" collides with two rails the series treats as locked: pay-before-collection (`02:112`) and pharmacist-only hand-over (D7); both are money/law, so both go to the owner rather than being DECIDED.
