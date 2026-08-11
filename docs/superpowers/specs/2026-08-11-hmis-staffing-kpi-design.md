# HMIS Staffing & KPI Book — Design Spec (Series S10)

- **Date:** 2026-08-11 (v1.2 — stress-pass-7 corrections folded; see parent §11.19-D)
- **Status:** Approved in brainstorming session; pending owner's independent stress rounds
- **Parent spec:** `2026-08-10-hmis-architecture-design.md` (v4.3) — all station/flow references point there; "Fig-1/Fig-2" references mean the parent spec's §11.1 (OPD) and §11.2 (IPD) flow designs as drawn in the Flow Atlas
- **Scope:** Workforce positioning across three operating models, **39 full-depth role cards**, role-bundling + segregation-of-duties matrices, **18 workforce mechanisms**, and the KPI/KRA/OKR framework. Headcounts are **planning bands** — day-one (≈100 OPD, small IPD) → 610-bed target — firmed at each phase's commissioning.

## 1. The three operating models

The flows are fixed (parent spec §11); the models change who executes each step and how many humans it takes.

- **A1 — All-human.** Humans execute care *and* the second job: chasing, reconciling, compiling, remembering. Full traditional complement; every register hand-kept. **A1 is never deleted — it is the drilled downtime mode.**
- **A2 — AI-assisted (day-one operating model).** Same humans, same stations; the 15 agents (parent §16) absorb the second job. Clinical headcount unchanged (care- and NABH-ratio-bound); the coordination/MIS layer thins; every role gets faster and less error-prone.
- **A3 — Agentic operations (earned target).** T4 agents own operational stations end-to-end; kiosks/self-service absorb routine volume; several desks become exception-handler posts. Humans concentrate on care, judgment, counseling, and exception queues. **Nurses and doctors do not reduce across models — the delta is entirely coordination, admin, and back-office.**

**Whole-hospital planning bands (610-bed):** A1 ≈ 2.2–2.5 staff/bed (≈1,350–1,500) · A2 ≈ 1.9–2.2 (≈1,150–1,350) · A3 ≈ 1.6–1.9 (≈1,000–1,150). **Day-one totals (v1.1 — corrected to the honest sum of the role cards' day-one columns): A1 ≈ 85–115 · A2 ≈ 70–100.** The original 45–55 claim contradicted the cards and is withdrawn; day-one still assumes several floors (ICU halls, most OTs, service lines) not yet commissioned — bands firm up against the commissioning schedule.

## 2. KPI / KRA / OKR framework

- **KPI** = event-derived metric with target. Every KPI names its source events — measurement is the exhaust of operations, never manual MIS.
- **KRA** = the responsibility bundle: which stations/flows the role owns.
- **OKR** = quarterly; **objectives set by the owner**, key results auto-measured from the event stream. Cards below carry a *sample* OKR — real ones are set each quarter.
- **Philosophy (owner-confirmed):** KPIs are diagnostic instruments that inform human conversations; they **never auto-trigger penalties or rankings**. Appraisal stays human judgment that KPIs inform.
- **Fairness rule:** every rate KPI is reported alongside its load context (patients assigned, queue depth, shift census). Raw comparison across unequal loads is structurally prevented.
- **Integrity rule:** every KPI ships with its gaming check (e.g., scan-time clustering anomalies), routed to Fraud Sentinel as diagnostics.

Card format: **Role** · reports to · stations → **A1 / A2 / A3** → **KPI** → **KRA** → **sample OKR** → **HC** (day-one → 610-bed, A2 model; A1/A3 deltas noted where material).

## 3. Front office & revenue (7 roles)

**1. Registration Clerk** · Front-office supervisor · Fig-1 entry, §11.1
- A1: manual forms ~4–5 min/patient, duplicates common · A2: QR/phone-first flow; Ops Copilot for queries; Recall Agent owns callbacks · A3: kiosks + WhatsApp pre-registration absorb 60–70%; exception-handler post
- KPI: median registration time (<3 min; `patient.registered` stamps) · duplicate-UHID rate (<0.5%) · pre-billing queue abandonment · demographic completeness %
- KRA: every arrival identified once, registered once, routed right — zero identity debris
- OKR: *frictionless arrival* — median <2 min · dupes <0.5% · 40% revisits via QR self-flow
- HC: 2 → 12–16 (A1: 16–20 · A3: 5–7 exception desks)

**2. Front-Office Supervisor** · Operations manager · queues, displays, handoffs
- A1: firefighting queues by walking; disputes verbal · A2: live queue dashboards, SLA Chaser escalations land here first · A3: manages exception queue + kiosk fleet health
- KPI: OPD wait-SLA compliance (`sla.breached` on waits) · queue-transfer resolution time (E2) · grievance first-response time
- KRA: front-of-house flow keeps moving; every escalation answered
- OKR: *no invisible waits* — wait-SLA >92% · zero unacknowledged front-office escalations
- HC: 1 → 3–4 (one per shift)

**3. Cashier** · Billing supervisor · §7 tenders, sessions
- A1: manual receipts, trust-counted drawers · A2: session discipline; engine decides prices; Fraud Sentinel protects the honest · A3: digital tenders absorb most volume; cash desks remain
- KPI: variance rate (<0.1%; `cash_variance.recorded`) · collections/session · refund TAT · UPI reconciliation match rate
- KRA: every rupee lands in a session; every session closes reconciled
- OKR: *audit-clean counters* — variance <0.1% · zero sessions unreconciled >24 h · +20% digital share
- HC: 2 → 14–18 (A3: 8–10)

**4. Billing Supervisor** · Finance head/owner · §11.11 rhythm, refunds, credit control
- A1: month-end reconciliation marathons · A2: daily close + orphan report are morning reads, not projects; approves refunds/discount overrides · A3: exception-approver over largely self-running money flows
- KPI: day-close on-time rate · orphan-report clearance time · dunning-ladder adherence · write-off rate
- KRA: the money rhythm (daily/monthly/payout cycles) executes on calendar; no silent revenue loss
- OKR: *zero leakage quarters* — orphans cleared <24 h · Tally sync mismatches = 0 · dunning on-calendar 100%
- HC: 1 → 3–4

**5. TPA / Insurance Desk Executive** · Billing supervisor · §11.4 map 3, claims lifecycle (phase 6)
- A1: paper pre-auths, fax-era chasing, discovery-at-discharge denials · A2: payer tags + enhancement-threshold reminders + Claims Drafter assembling files · A3: drafter-prepared claims; human counsels patients and negotiates insurers
- KPI: pre-auth TAT · enhancement-before-exhaustion rate · claim first-pass acceptance % · short-payment recovery %
- KRA: no patient blindsided by payer outcomes; no claim dies of paperwork
- OKR: *cashless without chaos* — pre-auth <4 h median · 90% enhancements requested before limit · first-pass acceptance >85%
- HC: 0 (payer tagging only) → 6–8

**6. Admission / Bed-Board Clerk** · Front-office supervisor · §11.2 admission desk
- A1: bed registers by phone-around · A2: live bed board, deposit engine, wristband print, porter auto-task · A3: Turnover Dispatcher keeps board true; clerk handles payer branches and counseling handoffs
- KPI: request→bed-assigned SLA (<30 min) · deposit-collection completeness · wristband-at-admission compliance
- KRA: right patient, right bed, right class, right deposit — documented before the ward sees them
- OKR: *no bed limbo* — assignment SLA >95% · 100% wristbands before transport
- HC: 1 → 6–8

**7. MRD Officer** · Quality/admin head · records, registers, certificates, retention, DPDP (§11.14, §11.19-B)
- A1: file rooms, missing files, certificate queues · A2: digital-first records; certificates from templates; records-request workflow with TAT; retention/legal-hold flags · A3: near-zero filing; the role is release governance + statutory registers QA
- KPI: records-request TAT compliance (72 h statutory) · certificate issue TAT · register completeness audits · ICD coding backlog
- KRA: every record findable, releasable only lawfully, retained per schedule
- OKR: *records that answer* — 100% statutory TAT · coding backlog <7 days
- HC: 1 → 5–7

## 4. Doctors (7 roles)

*Family note: doctor headcounts are specialty-mix and volume-driven; bands assume the 610-bed case mix (24×7 ED, 10 OTs, 45 ICU, maternity, cath, oncology). All doctor KPIs observe the fairness rule (load-normalized) and inform conversations only.*

**8. OPD Consultant** · Medical director · Fig-1 consultation, §11.6–11.8 ordering
- A1: paper Rx, memory-based follow-ups, TAT blindness · A2: vitals pre-loaded, one-screen history, e-Rx with safety checks, results return to their queue · A3: ambient documentation drafts (T2), pre-visit AI summaries — consult time drops, volume capacity rises
- KPI: consultation throughput (load-shown) · same-day result-review closure · Rx safety-alert override rate (with reasons) · follow-up conversion
- KRA: every consult decided, documented, and its loops (tests, follow-ups) closed
- OKR: *closed-loop consults* — 95% same-day result review · documented override reasons 100%
- HC: 6–8 visiting/duty → 80–120 (mix of full-time + visiting; fee-split per §7)

**9. Duty Medical Officer (ward RMO)** · Medical director · §11.2 stay loop, verbal-order countersigns
- A1: on-foot rounds with paper charts; verbal orders undocumented · A2: worklist-driven rounds, danger-vitals escalations, verbal-order countersign queue · A3: AI round-prep summaries; RMO handles deviations, not data gathering
- KPI: escalation acknowledgment time (5-min class) · verbal-order countersign within window · rounds completion rate
- KRA: the ward's medical continuity between consultant touches — nothing deteriorates unseen
- OKR: *no silent nights* — 100% escalations acknowledged in SLA · countersigns 100% in window
- HC: 2–3 → 60–80 (shift-covered across floors)

**10. ER Physician** · ER head · §11.3 end-to-end
- A1: triage by instinct, parked patients · A2: triage discipline, stat-priority ordering, disposition clock, codes one touch away · A3: AI pre-arrival prep (ambulance data), draft dispositions — physician decides faster
- KPI: triage <5 min compliance · door-to-disposition median · 24-h ceiling breaches · MLC documentation completeness
- KRA: every ER episode reaches exactly one disposition, defensibly documented
- OKR: *decisive door* — ceiling breaches <2% · median disposition <4 h
- HC: 2–3 → 12–16 (24×7 rota)

**11. Intensivist** · Medical director · §11.15 ICU floor
- A1: bedside-only awareness · A2: floor overview + hall dashboards + phone view; Code Blue tiered response; titration orders; family-briefing rhythm · A3: AI trend-watch surfaces deteriorating patterns across all 45 beds; intensivist attention goes where the model points, decision stays theirs (T2)
- KPI: response-to-escalation time · 48-h ICU readmission rate · briefing compliance (daily documented) · device-reconciliation exceptions
- KRA: 45 beds' worth of severity, continuously triaged by attention
- OKR: *no unseen deterioration* — 100% daily briefings · readmits <5%
- HC: 1–2 → 10–14

**12. Surgeon (operating consultant)** · Medical director · §11.9/§11.16
- A1: list by phone, counts by memory, implants in a diary · A2: list workflow, hard pre-op gates, WHO states, implant scans, utilization mirrors · A3: AI-drafted op notes (T2), pre-op risk summaries
- KPI: first-case on-time · gate-compliance (zero wheel-ins past open gates) · unplanned return-to-OT rate · SSI rate (surveillance-linked)
- KRA: their list runs on gates and checklists, never on memory
- OKR: *on-time, on-checklist* — first-case on-time >85% · gate violations = 0
- HC: visiting panel → 40–60 across specialties (incl. cath operators; fee-split per §7)

**13. Anesthetist** · OT head · PAC gates, WHO checklist co-owner, §11.16
- A1: PAC on paper day-of · A2: PAC clearance as a gate days ahead; machine data pre-fills records; NPO-extension alerts protect their patients · A3: AI intra-op record keeping validated by them
- KPI: PAC-before-day-of rate · sign-in/time-out participation 100% · anesthesia documentation completeness · PACU handover quality (recovery scoring done)
- KRA: no patient induced past an open gate; every anesthesia event recorded
- OKR: *gates before gas* — 100% PAC before surgery day · zero undocumented inductions
- HC: 1–2 → 15–20

**14. Obstetrician** · Medical director · §11.17 maternity floor
- A1: partograph on paper if at all · A2: decision-forcing partograph, CTG alerts, D2D clock, obstetric codes · A3: AI labour-trend watch across all active labours; decisions remain theirs
- KPI: decision-to-delivery ≤30 min compliance · partograph completion rate · documented decision at action-line 100%
- KRA: every labour tracked to a documented decision; no drift past action lines
- OKR: *no undecided labours* — D2D compliance >95% · partographs 100%
- HC: 1–2 → 10–14 (24×7 rota)

## 5. Diagnostics (5 roles)

**15. Radiologist** · Diagnostics head · §11.7 worklist, PCPNDT accountability
- A1: film piles, verbal criticals · A2: PACS worklist, structured reporting, critical-findings protocol, Form-F gates enforced by system · A3: Radiology Drafter pre-drafts (T2); radiologist signs — edit distance tracked as the *agent's* KPI, not theirs
- KPI: report TAT by modality · critical-finding communication compliance · addendum/amendment rate
- KRA: every study read, every critical finding provably communicated
- OKR: *no unread studies* — routine TAT <24 h · critical comms 100% documented
- HC: 1 (24×7 per owner) → 6–8 + teleradiology overflow

**16. Pathologist** · Lab head · §11.6 verification tier, frozen sections
- A1: everything crosses their bench · A2: auto-verification handles normals; they sign abnormal/critical/manual; frozen-section TAT clock · A3: AI pre-classification queues by urgency
- KPI: abnormal-verification TAT · frozen-section TAT compliance · amended-report rate
- KRA: nothing abnormal leaves unverified; intra-op answers arrive in surgical time
- OKR: *judgment where it matters* — frozen TAT 100% · abnormal TAT <2 h
- HC: 1 → 4–6

**17. Lab Technician** · Pathologist/lab manager · §11.6 pipeline, QC
- A1: manual registers, QC informal · A2: accession scans, QC lockout, analyzer interfaces, rejection loop · A3: analyzers + agents run routine flow; techs own QC, exceptions, manual benches
- KPI: TAT by category · sample rejection rate (theirs vs collection's, separated) · QC compliance (zero lockout overrides) · recollection closure
- KRA: the pipeline's integrity — right sample, right process, right QC, on time
- OKR: *clean pipeline* — rejects <2% · QC lockouts honored 100%
- HC: 3–4 → 25–35 (24×7)

**18. Imaging Technician** · Radiology head · acquisition, §11.7 gates
- A1: paper requisitions · A2: worklist-driven acquisition, safety gates (pregnancy/contrast/Form F) surfaced at console, PACS push · A3: schedule optimization by agent; tech owns patient handling + image quality
- KPI: acquisition-to-PACS lag · repeat/reject image rate · gate compliance 100% · modality utilization
- KRA: right study, right patient, right safety gates, first time
- OKR: *first-shot quality* — repeats <3% · zero gate bypasses
- HC: 2–3 → 18–25 (incl. cath lab, mobile, CT/MRI 24×7)

**19. Blood Bank Officer/Technician** · Pathologist/BB head · §11.4 map 10, MTP, §11.16 reserves
- A1: register-run bank · A2: cross-match holds with auto-release, issue scans, MTP rules, reaction workflow · A3: inventory forecasting by agent; humans own serology judgment + donor relations
- KPI: emergency issue TAT · unit wastage/expiry rate · reservation-to-use ratio · reaction documentation 100%
- KRA: right blood, right patient, provable chain, minimal wastage
- OKR: *zero-doubt transfusions* — chain events 100% · wastage <3%
- HC: 2 (existing bank) → 8–10 (24×7)

## 6. Nursing (5 roles)

*Family note: ratios are care-bound and constant across models — general 1:6–8, ICU 1:1–2, NICU 1:2, OT per-table teams. Band-scan compliance, handover acknowledgment, and load-context reporting apply to all nursing cards.*

**20. Staff Nurse (ward)** · Ward in-charge · Fig-2 stay loop
- A1: paper MAR, ~2 h/shift on registers · A2: eMAR band-scan, monitor pre-fill, handover gates, register time ~20 min · A3: ambient documentation; nurse-call as timed tasks
- KPI: dose on-time (>95%) · scan compliance (>98%) · vitals timeliness · handover acknowledgment 100% · incident/fall rate (load-shown)
- KRA: assigned patients' care executed as ordered, documented as done, escalated when deviating
- OKR: *zero silent misses* — on-time >95% · scans >98% · handovers 100%
- HC: 8–10 → 320–380 total ward nursing (all shifts, leave-adjusted)

**21. ICU Nurse** · ICU in-charge · §11.15
- A1: obs charts hourly by hand · A2: telemetry pre-fills validated charting; titration logging; alarm acknowledgment audit; EBM/transfusion double-verifies · A3: AI trend flags augment, never replace, bedside vigilance
- KPI: alarm acknowledgment time · charting validation rate · line/tube care bundle compliance · data-gap incidents on their beds
- KRA: their 1–2 patients continuously monitored with a defensible record
- OKR: *always-on vigilance* — critical alarm ack <60 s · validation 100%
- HC: 6–8 → 140–170 (45 ICU + 15 NICU, all shifts)

**22. OT Nurse (scrub/circulating)** · OT in-charge · §11.16 counts, kits
- A1: counts by memory + paper · A2: WHO states, two-person counts, kit scan-out, implant scans · A3: same hands-on role; consumable capture near-ambient
- KPI: count completion 100% · timeout participation · kit reconciliation variance · IUSS involvement rate (should trend ↓)
- KRA: nothing left inside, nothing unbilled, nothing unsterile
- OKR: *counted and clean* — count events 100% · kit variance <1%
- HC: 4–6 → 45–60 (9 theatres, shifts)

**23. Ward In-Charge (Sister In-Charge)** · Matron · ward operations, rosters, handovers
- A1: register-keeper and rota-maker by hand · A2: roster validation gates, handover enforcement, ward KPI visibility, stock par oversight · A3: exception manager — bundling matrix decisions at night, overload flags on their people
- KPI: roster publication compliance (no blocked publishes) · ward handover completion · ward stock variance · staff overload flags addressed
- KRA: the ward runs — staffed, handed over, stocked, and honest
- OKR: *wards that run themselves* — zero coverage holes · handovers 100%
- HC: 1 → 18–22 (one per ward/shift-lead structure)

**24. Matron / Nursing Superintendent** · Medical director/owner · nursing service line
- A1: paper-aggregated oversight · A2: floor-wide nursing KPIs live; bus-factor and bench gaps visible; credential expiry pipeline · A3: capability planner — training matrix, cross-skill coverage, fairness guardian of nursing KPIs
- KPI: hospital nursing-KPI roll-ups (context-shown) · bench/bus-factor gaps closed · training compliance · attrition rate + exit-handover completion
- KRA: the nursing workforce — sized, skilled, rostered, retained
- OKR: *bench strength* — every station ≥2 trained · attrition <18% annual
- HC: 1 → 3–4 (matron + deputies)

## 7. Pharmacy & materials (4 roles)

**25. Pharmacist** · Pharmacy head · §11.8, OP/IP dispensing, narcotics
- A1: manual bins, expiry surprises, H1 register by hand · A2: Rx-ahead-of-patient, FEFO picks, substitution rules, registers self-write, Replenishment Agent drafts indents · A3: dispensing largely flow-directed; pharmacist owns clinical checks, counseling, narcotics, compounding
- KPI: dispense TAT · substitution-policy compliance · expiry write-offs (→0 via FEFO) · narcotics reconciliation (always exact)
- KRA: right drug, right patient, right batch — and the schedules' registers beyond reproach
- OKR: *clean counters* — expiry write-offs <0.5% of stock value · narcotics variance = 0
- HC: 2–3 → 20–28 (OP+IP+wards, 24×7)

**26. Storekeeper (central stores)** · Materials head · §11.10 custody side
- A1: ledgers + annual-count shocks · A2: two-sided scans, cycle counts, leakage triangle on their locations · A3: agent-drafted replenishment; storekeeper = custody, counts, physical truth
- KPI: stock accuracy (counted vs system) · issue TAT to sub-stores · expiry-on-shelf incidents · variance approvals on their locations
- KRA: physical stock equals system stock, always provable
- OKR: *shelf truth* — accuracy >99% · zero unexplained variances
- HC: 1–2 → 10–14 (SoD: never also purchase/GRN-approve)

**27. Purchase Officer** · Materials/finance head · §11.10 P2P
- A1: quotation binders, relationship-driven POs · A2: rate contracts, three-quote gates, vendor scorecards auto-derived, 3-way match · A3: agent-drafted POs under contracts; officer negotiates, manages vendors, handles exceptions
- KPI: PO cycle time · rate-contract coverage % · vendor fill-rate/TAT (their portfolio) · emergency-purchase rate (should trend ↓)
- KRA: the hospital never stocks out and never overpays — provably
- OKR: *contracted calm* — contract coverage >85% · emergency purchases <2%
- HC: 1 → 4–5 (SoD: never GRN-receives)

**28. CSSD Technician** · OT/CSSD in-charge · §11.10 set cycle
- A1: trust-based sterility · A2: barcode set cycle, BI gates, load recalls, OT-list demand view · A3: same hands; forecasting by agent
- KPI: set turnaround TAT · BI compliance 100% · recall execution time · IUSS support rate
- KRA: every instrument provably sterile, traceably cycled
- OKR: *provable sterility* — BI documentation 100% · zero unsterile releases
- HC: 1–2 → 8–10

## 8. Clinical support (2 roles)

**29. Dietician** · Medical director · diet orders → kitchen, §11.19-A tray verification
- A1: diet slips lost between ward and kitchen · A2: diet orders flow to production lists; tray-tag verification; therapeutic-diet compliance visible · A3: AI drafts diet plans from orders + labs (T2), dietician signs
- KPI: diet-order execution rate · tray-verification compliance · therapeutic-diet error rate · nutrition-assessment coverage (NABH)
- KRA: every therapeutic diet ordered, delivered, and verifiably correct
- OKR: *right tray, every tray* — verification >98% · errors → 0
- HC: 1 → 6–8

**30. Physiotherapist** · Medical director · §11.19-A session machinery
- A1: appointment diary + paper notes · A2: therapy plans as session bundles, worklists, missed-session recalls · A3: adherence nudging by Recall Agent; therapist treats
- KPI: session completion rate · missed-session recall closure · outcome documentation per plan
- KRA: every therapy plan executed to completion or consciously closed
- OKR: *finished plans* — completion >85% · recalls closed <48 h
- HC: 1–2 → 10–14

## 9. Operations & support (4 roles)

**31. Duty Manager** · Operations head/owner · the shift's exception-holder: codes, downtime authority, bundling matrix, overrides
- A1: firefighter with a phone · A2: every escalation ladder ends here before the owner; downtime/disaster declaration authority; evented overrides · A3: the human hub of an agentic hospital's night — exceptions, codes, judgment
- KPI: escalation resolution time · code-drill participation · downtime declarations handled per protocol · override rate (visible, contextual)
- KRA: whoever else is absent, the hospital has a decision-maker on the floor
- OKR: *always answerable* — 100% escalations resolved or elevated in SLA
- HC: 1 → 4–5 (24×7 single-point per shift)

**32. Housekeeping Supervisor (+ pool)** · Operations · P5 pools: turnover, deep cleans, scheduled rounds
- A1: verbal task assignment, no proof of cleaning · A2: pooled queue with claims, verified turnovers, isolation protocols · A3: Turnover Dispatcher assigns; supervisor audits verification quality
- KPI: bed turnover TAT · deep-clean verification compliance · scheduled-round completion
- KRA: clean, verified, on-time — beds and floors as capacity, not chores
- OKR: *beds back fast* — turnover median <45 min · verification 100%
- HC: 1 + pool 6–8 → 4–5 + pool 90–120

**33. Biomedical Engineer** · Operations · §11.12 maintenance, AMC, device fleet
- A1: breakdown-driven, AMC diary · A2: priority tickets (30-min critical SLA), AMC auto-tasks, device heartbeats, downtime registers · A3: predictive flags from telemetry; engineer plans instead of firefights
- KPI: critical-response SLA · preventive-maintenance completion · equipment uptime by class · calibration currency (NABH)
- KRA: every device working, calibrated, and provably maintained
- OKR: *no dead machines* — critical SLA >95% · PM completion 100%
- HC: 1 → 6–8 + AMC vendors

**34. Security Supervisor (+ pool)** · Operations · passes, codes, gate discipline, §11.14
- A1: register-and-instinct gatekeeping · A2: QR pass scans, code responses (Violet/Yellow/infant), body-release verification, gate-pass discipline · A3: same posts; anomaly flags (pass misuse patterns) surfaced by agents
- KPI: pass-scan compliance at ward entries · code-response drill times · gate-pass verification rate
- KRA: the building's boundaries — who enters, who exits, provably
- OKR: *boundaries that hold* — scan compliance >95% · drill times in target
- HC: 1 + pool 4–6 → 4–5 + pool 60–80

*(Pool-role note: porters/GDA ride the P5 pooled-queue mechanics under the duty manager/housekeeping structure — day-one pool 3–4 → 60–80 at scale.)*

## 9A. Governance & flow-gate roles (5 cards added in stress pass 6 → 39 total)

**35. Vitals-Desk Assistant** · Front-office supervisor / nursing · §11.1 mandatory vitals station
- A1: manual BP/weight noted on slips · A2: connected devices push into the encounter; danger flags fire · A3: self-service kiosks for basics, assistant handles assisted patients + quality
- KPI: throughput/load · vitals completeness (all fields) · danger-flag latency · device-calibration task compliance
- KRA: no patient reaches a doctor without complete, current vitals
- OKR: *no blank charts* — completeness >99% · flag latency <60 s
- HC: 1–2 → 8–12

**36. Phlebotomist** · Lab manager · §11.6 collection stations + ward rounds
- A1: handwritten tube labels (the classic wrong-blood-in-tube source) · A2: chair-side barcode labels + right-patient scan; rejection loop feedback by collector · A3: routing/rounds optimized by agent; hands unchanged
- KPI: collection-attributable rejection rate (<1%) · draws/session (load-shown) · ward-round on-time rate
- KRA: right patient, right tube, right label — first time
- OKR: *clean draws* — attributable rejects <1% · zero unlabeled-at-chair events
- HC: 1–2 → 12–16

**37. Quality Manager (NABH coordinator)** · Owner/medical superintendent · quality pack, §11.14 registers, audit calendar
- A1: binder-driven NABH prep, data begged from departments · A2: self-feeding registers + indicator dashboards; runs audit calendar, incident RCAs, committee cadence · A3: agents draft RCA timelines from event trails; QM leads judgment + culture
- KPI: indicator-report timeliness (auto, should be ~100%) · incident-closure TAT · audit-schedule adherence · NABH objective-element readiness %
- KRA: the hospital is permanently inspection-ready because the data never stops being true
- OKR: *always audit-ready* — incident RCAs closed <14 days · readiness >90%
- HC: 1 → 3–4 (with MRD/quality cell)

**38. Infection Control Nurse** · Quality manager / medical superintendent · HAI surveillance, isolation flows, BMW chain, exposure protocol
- A1: paper surveillance nobody trusts · A2: HAI indicators self-feed (§11.4 map 9, SSI register); isolation compliance audits; PEP clock owner (§11.14); BMW segregation audits · A3: agent-flagged infection clusters (T0) for her investigation
- KPI: surveillance completeness · bundle-compliance audit rate · PEP first-dose-in-window 100% · BMW segregation audit findings
- KRA: infections found, traced, and prevented — provably
- OKR: *closed-loop infection control* — cluster investigations started <24 h · PEP window 100%
- HC: 1 → 3–4

**39. Medical Superintendent** · Owner · medical governance: credentialing/privileging decisions, attribution disputes, mortality/tumor-board committees, two-key clinical-definition approvals (§16), MLC oversight
- A1: authority by memo and meeting · A2: worklist of governance decisions — privileging approvals, disputed attributions, committee actions, workflow-definition co-signs — all evented · A3: agent-briefed committees (draft case summaries), decisions remain human
- KPI: privileging-decision TAT · committee cadence adherence · dispute-resolution TAT · co-sign turnaround on clinical definitions
- KRA: clinical authority is exercised, recorded, and never a bottleneck
- OKR: *governance that keeps pace* — privileging TAT <7 days · zero overdue committee cycles
- HC: 1 → 2–3 (MS + deputy)

## 10. Role-bundling matrix (skeleton shifts)

Night/weekend collapse rules — **may bundle**: duty manager ← front-office supervisor + billing supervisor (dispute/override authority) · admission clerk ← registration clerk · MRD ← front office (release requests queue to day) · purchase ← (nothing; sleeps) · dietician/physio ← on-call. **Must stay distinct (SoD or safety):** cashier vs any approver of refunds/discounts · storekeeper vs stock counter · narcotic issuer vs witness · ICU nurse vs ward nurse assignments (competency-gated) · scrub vs circulating during counts · Code Blue roles per roster. Roster publication validates bundles against this matrix.

## 11. Segregation-of-duties hard pairs (RBAC-enforced)

Never the same person: requester/approver of any approval-engine item · cashier / refund-void approver · PO approver / GRN receiver · stock custodian / cycle counter (**incl. ward sub-stores: counts by stores/pharmacy staff, never the custodian in-charge — v1.1**) · narcotics issuer / witness · payout preparer / payout approver · workflow-definition drafter / activator (owner activates) · quality auditor / audited-station holder for that audit · **downtime declarer / downtime-cash reconciler (v1.1)**. `sod.violation_blocked` fires on any attempt; the bundling matrix inherits these.

**Witness eligibility (v1.1):** any two-person verify (narcotics, high-alert meds, transfusion, EBM, counts) accepts any licensed nurse on the floor, cross-ward pulls allowed; last resort = logged remote-video witness. Roster validation guarantees at least one eligible witness per floor per shift — a shift without a witness doesn't publish.

## 12. Workforce mechanisms (from the staffing stress test — all locked)

1. Role-bundling matrix with roster-validation gate (§10 above; `roster.published/.blocked`)
2. SoD hard pairs, RBAC-enforced (§11 above)
3. Attrition defenses: fabric-as-SOP onboarding · **bus-factor per station** (`bench.gap_flagged`) · exit workflow (handover, same-hour revoke, dues)
4. Workforce surge mode: essential rosters, widened bundling, elective shed, pre-verified locum pool with auto-expiring grants (`temp_role.granted/.expired`)
5. Statutory roster compliance: max consecutive shifts, weekly offs — violating rosters don't publish
6. Emergency role elevation: break-glass for actions, loudly evented + mandatory review (`emergency_elevation.used`)
7. Activity-attendance reconciliation (T0 report; `activity_attendance.mismatch`) — management diagnostic, never auto-action
8. Credential verification before activation (council-verified, documented) — onboarding gate
9. Attribution-dispute workflow (both doctors + medical director; `attribution.disputed/.resolved`)
10. Outward-referral pattern reports (T0, owner's judgment)
11. KPI gaming checks paired to every KPI (Fraud Sentinel diagnostics)
12. KPI fairness: load-context on every rate KPI (structural, in every report)
13. Overload detection (`overload.flagged`) — protects people and protects the KPIs from masking understaffing
14. New-joiner ramp: restore-drill training environment, buddy tasks, probation dashboards
15. **Roster system-of-record = HMIS (v1.1):** HR keeps payroll/attendance; rosters are authored, validated, and published in the HMIS — publication gates (coverage, SoD, witness, statutes) are therefore enforceable, resolving the ownership contradiction
16. **Succession chains (v1.1):** every single-incumbent 24×7 post (duty manager, radiologist, blood-bank officer) carries a published succession chain; the duty-manager night succession is explicit — the downtime/disaster authority can never be an empty chair
17. **Labor statutes in roster validation (v1.1):** women's night-shift provisions (transport/consent per state rules), Maternity Benefit Act + creche obligations, CLRA registration for outsourced pools, PSARA-licensed security vendor, POSH ICC channel live from day one
18. **Duplicate-UHID gaming check (v1.1):** false-attach detection — demographic-mismatch audit sampling + photo prompt at attach — pairs the registration KPI (the one identity error that emits no anomalous event)
19. **Owner succession & governance role (v1.2, parent §11.19-D fixes 10/12):** the owner joins the succession-chain rule — two-key emergency governance path (duty manager + medical superintendent), declared-incapacity deputy pair with time-boxed evented authority, sealed technical-continuity kit with annual stranger drill. The owner is no longer the only unmitigated single-incumbent post.
20. **DPO & grievance ownership (v1.2):** the quality manager (card 37) dual-hats as DPDP Data Protection Officer day one (dedicated DPO at scale); grievance-officer duty assigned; DPIA participation is a card-37 KRA line.
21. **Documentation-time budgets (v1.2):** every role card's mandatory interaction load is summed per shift; a workflow-definition change adding a mandatory step must fit the role's budget or displace an existing step — enforced at definition-change time (Class-A/B review input).
22. **Patient-navigation duty (v1.2):** front-office roles carry low-literacy/unaccompanied-patient navigation duty day one; a dedicated navigator post joins the roster at scale.
23. **Count randomization & dyad analytics (v1.2):** cycle-count assignments randomize among eligible non-custodian counters; blind recounts periodic; Fraud Sentinel models standing two-person pairings (approver/requester, witness pairs, counter/custodian) — recurring dyads with anomalous outcomes are a report class.
24. **Doctor adoption program (v1.2, parent fix 35):** dictation-to-draft path and scribe option from day one; designed off-site access for countersigns/approvals; per-doctor live accrual dashboard from week one — adoption carrots ship with the sticks.

## 13. Spec self-review note

Headcount bands are planning estimates pending commissioning schedules and case-mix confirmation — they parameterize hiring plans, they are not commitments. Doctor/nursing numbers assume NABH-aligned ratios; statutory ratio changes override this book. All KPIs trace to catalog events (parent spec §10.6, ~265); any KPI without an event source is a bug in this book.
