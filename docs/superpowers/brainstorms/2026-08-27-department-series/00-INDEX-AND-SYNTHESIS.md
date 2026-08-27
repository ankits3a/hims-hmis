# 00 — Index & Synthesis — Department Brainstorm & Planning Series (2026-08-27)

**Status:** Brainstorm v1 — nothing ruled. **Produced:** night of 2026-08-26 → 27, one AI agent per department, all writing against the same brief (`_AUTHORING-BRIEF.md`), the architecture spec v4.8, S10 staffing/KPI book, the clinical-copilot design, the roadmap and Plan 13. **Volume:** 22 documents, 2.02 MB, 2,925 numbered edge-case rows, 158 chaos walkthroughs, ~240 named agents/automations, 283 owner-ruling asks (262 after merging), and plan proposals that collided on the numbers 20–27 in eleven places.

Companion files: `00-OWNER-RULINGS-REGISTER.md` (every §13 ask, one table, grouped by who answers) · `00-CROSS-MODULE-CHAOS.md` (ten whole-hospital days no department owns) · `_extract-rulings-plans.md` (the mechanical extract these were built from).

---

## 1. What this is and how to use it

**What it is.** For every department or module the hospital will need by ~Aug 2027 (610 beds, 2,000+ OPD/day, 24×7 ED, 10 OTs, 45 ICU beds) that is *not yet built*, one document walks the department as a night nurse, a fraudster, an auditor, a Bhojpuri-only patient and a server going down. Each has the same 15 sections: frame and locked decisions → roles → workflows as definitions → data model → edge catalogue (80+ rows minimum; the average is 133) → chaos days → compliance surfaces → KPIs → agents → speed/accuracy levers → integrations → buy-vs-build and ₹ → **owner rulings (§13)** → **plan sketch (§14)** → open risks. Everything is a *proposal*; the documents were forbidden to re-litigate spec locks and forbidden to claim anything is built or ruled.

**What it is not.** Not phase documents (those get authored per the repo rhythm — one phase doc per plan, EXECUTE-METHOD v3). Not a roadmap amendment until you ratify §3 below. Not specs: the spec v4.8 and S10 remain the books of record; these extend them.

**How to use it (owner).**
1. Read §2's table and §7's reading order. Read each document's **executive summary only** (first 10 lines) — that is 22 × 2 minutes.
2. Rule on `00-OWNER-RULINGS-REGISTER.md`. Most rows have a corporate-standard default; you can rule a whole category with one line ("adopt all `policy` defaults except R-…"). The ten CA rows and fifty-two counsel rows need those people; book the two sessions (register R-255, R-262) before any Track-C plan is authored.
3. Ratify (or amend) the **reconciled plan numbering** in §3 — every document proposed its own numbers and eleven collide.
4. Then phase docs get authored one plan at a time, per the repo's plan rhythm: the phase doc's §1 cites the brainstorm doc, its §13 rulings arrive as "RULED" lines, its edge rows become the assertion book, its §14 interview questions get asked of the department head *before* T1.
5. Do not read §5 catalogues end to end. They are assertion books for the phase docs; read them when a phase doc is being authored.

---

## 2. The 22 documents

| # | Title | KB | Edge rows | Chaos | Agents | Rulings | Proposed plans (as written → reconciled) | Hardest problem (one line) |
|---|---|---|---|---|---|---|---|---|
| 01 | Radiology & Imaging | 93 | 138 | 8 | 13 | 13 | 18a/18b/18c, "2x RT" → 18a/b/c, 64 | PCPNDT structural without blocking the 02:00 obstetric scan; the report as a courtroom-grade versioned AI-pre-drafted document; PACS physics on one VM |
| 02 | Central Lab / LIMS | 98 | 129 | 8 | 14 | 12 | 17, 17-E, 20, 21, 22 → 17, 17-E, 17-M, 17-H, 28 | Identity at the tube; the release decision under pressure (auto-verify, QC lockout, unpaid interlock, 02:00 criticals); analyzers as untrusted half-connected peers |
| 03 | Home Collection & Home Care | 91 | 126 | 7 | 11 | 12 | 20 (20a/20b) → 24a/24b | Identity and custody at a doorstep; cold chain at 42 °C on a scooter; cash and attribution in the field |
| 04 | Physiotherapy & Session Departments | 83 | 127 | 7 | 10 | 12 | 20, 20b, 21, 22 → 25, 25b, 60, 61 | Prepaid courses that shorten/extend/refund on an append-only ledger; a missed session is a clinical event; hard safety gates that never block the paper path |
| 05 | Video Consultation / Tele | 75 | 118 | 7 | 9 | 13 | 21 → 23 | TPG drug-class legality enforced at Rx-issue time; identity and consent over a camera; money and no-shows at a distance with no payment gateway in the repo |
| 06 | ICU / Critical Care | 92 | 130 | 7 | 13 | 12 | 24, 25, 26, 27 → 49, 50, (fold), 51 | Silent wrong device↔bed↔patient mapping; alarm governance; money and law colliding at the bedside (deposit, TPA, withdrawal, brain death) |
| 07 | Nursing Management | 89 | 141 | 7 | 9 | 12 | 20, 21, 22a/b → 20, 41, 42a/42b | Wrong-patient/dose hard stop that survives every degradation; alarm economy at 03:00; the MAR and nursing notes as the legal record |
| 08 | Housekeeping, Laundry, BMW | 96 | 120 | 7 | 6 | 14 | 19a/19b/19c → 19a/19b/19c | The turnover clock is a capacity clock; BMW is chain-of-custody with criminal exposure; an outsourced, phone-first, Hindi/Bhojpuri workforce |
| 09 | Procurement, Stores, Vendors, Consignment | 91 | 136 | 6 | 10 | 13 | 14, 14b, 20 → 14, 14b, 29 | Batch/MRP/expiry truth at the receiving gate; consignment stock we dispense but don't own; fraud that looks like normal work |
| 10 | Doctors on Duty (residents, rounds, escalation) | 89 | 125 | 7 | 10 | 10 | 20, 21, 21b, 21c → 20, 43, 43b, 43c | Resolution truth at 03:00 (WhatsApp-swapped shifts); escalation without alarm fatigue; timely attributed documentation without making residents typists |
| 11 | Staff KPI, KRA & Performance | 87 | 132 | 7 | 8 | 11 | 20, 21, 22 → 21, 21b, 21c | Attribution under shared/handed-over/agent-assisted/backfilled work; "diagnostic never punitive" as a structural property; denominators and Simpson's paradox |
| 12 | Agentic Copilot Layer | 77 | 106 | 8 | ~75 roster | 10 | 12a/12b/12c → unchanged | Automation bias (a rubber-stamped draft is worse than none); de-identification of Hinglish free text; keeping 40+ agents boring |
| 13 | Memberships, Packages, Corporate, TPA panels, CRM | 88 | 118 | 7 | 12 | 15 | 20, 21, 22, 23 → 26, 46, 27, 27b | The money-law boundary (§11(4A), GST on vouchers, TDS, PPI, cut-practice); payer multiplicity on one bill; consent-bound engagement at 2,000/day |
| 14 | Emergency, Trauma, Ambulance, Disaster | 103 | 158 | 7 | 11 | 16 | 20, 20a, 20b, 20c → 40, 40a, 40b, 40c | Identity under fire (UNK/DIS-tags merged later without mixing blood groups); money without a gate; boarding made loud |
| 15 | OT, Anaesthesia, PACU, CSSD, Mini-OT | 97 | 135 | 7 | 12 | 12 | 15, 20, 21, 22 → 15, 48, 29, 28 | "No wheel-in past an open gate" that never strands a bleeding patient; sterility per set per case with BI recall into a running list; money composition of a case |
| 16 | Pharmacy | 84 | 149 | 6 | 10 | 14 | 16c/d/e/f → unchanged | One counter, three legal regimes (OTC/H1/NDPS); price = min(tariff, MRP, NPPA) at batch grain; leakage through six hands |
| 17 | IPD ADT, Bed Board, Wristbands, Discharge, MRD | 92 | 138 | 7 | 11 | 14 | 20, 21, 22, 23 → 41, 44, 45, 54 | The bed as a contended money-bearing resource; discharge as a multi-department clearance race; the record outlives the stay |
| 18 | Blood Bank & Transfusion | 95 | 147 | 7 | 7 | 10 | 24a/24b/24c → 47a/47b/47c | Wrong-blood-in-tube/at-bedside made physically hard; paper-to-digital absorption of a licensed, inspected bank; inventory truth under expiry, quarantine and replacement-donor coercion |
| 19 | Support Services (BME, diet, mortuary, security, transport, oxygen, IT ops) | 103 | 142 | 8 | 11 | 14 | 19-T0, 20, 21, 22, 23, 24, 25 → 19a, 29, 52, 53, 31, (fold), 30 | One P5 pool engine for five departments; oxygen that kills within minutes with sensors not yet bought; floor-scoped degradation is design law and unshipped |
| 20 | Front Office, Appointments, Call Centre, TPA/Claims, Feedback | 116 | 134 | 7 | 12 | 17 | 20, 20b, 21, 21b, 22 → 22, 22b, 46, 46b, 27 | Keeping a 2,000/day queue honest; the claims desk as a money-and-law machine; identity at speed across 16 counters + kiosks |
| 21 | Service Lines (maternity/NICU, cath lab, onco/RT, dialysis, endoscopy, paeds) | 90 | 126 | 7 | 14 | 12 | 23, 24, 25, 26, 27 → 62, 63, 64, 65, 66 | Two-patient encounters (dyads, minors, POCSO, wrong-milk); vendor-boundary clinical truth (consignment, R&V, reprocessors); decision-forcing clocks under 30 min |
| 22 | Quality, NABH, Incidents, Infection Control, Governance | 108 | 150 | 7 | 14 | 15 | 22a–e, 22-G → 28a–e, 28-G | The reporting-culture paradox; evidence honesty (indicators as true as the events); governance without a second adult |

Totals: 2,925 edge rows · 158 chaos walkthroughs · 283 ruling asks · agents: ~240 department candidates plus doc 12's cross-department roster of ~75 (overlapping).

---

## 3. Reconciled plan numbering

**Fixed by the roadmap (unchanged):** 12a/12b/12c agent runtime (slot when the DPIA is signed) · **13** resource registry (in flight) · Track A **14** procurement → **15** mini-OT → **16** pharmacy → **17** LIMS → **18** radiology ∥ Track B **19** housekeeping/laundry/BMW. Sub-phases the documents proposed *inside* those numbers are kept: 14/14b · 16c/16d/16e/16f · 17/17-E (analyzer edge, per machine) · 18a/18b/18c · 19a/19b/19c. Two lab extensions stay in the 17 family rather than taking new numbers: **17-M** microbiology & antibiogram, **17-H** histopathology/cytology.

**Rules applied.** (1) Numbers are blocks per track so the owner can read a number and know its gate: **20–31 = Track C** (substrates and light modules that need only 13 and run in parallel with A/B, no hard gate), **40–54 = the IPD cluster** (behind the hard gate), **60–67 = service lines** (each at its floor's commissioning). Gaps between blocks are deliberate. (2) Dependency order within a block. (3) A component two documents both claimed gets one home and the other adopts it (§5). (4) Anything a document proposed that is really a *slice* of an existing plan is folded (listed in the collisions table).

**The hard gate before the IPD cluster (40+).** Per Plan 13 §4A-3 and runbook O1: **a second approving actor exists** (production has one full admin; every two-key, SoD and committee rule is theatre until then); Plan 13 `0033` deployed and `opd_rooms` gone; Plan 20 roster substrate live (escalation resolves to on-duty holders, not everyone holding a role); the 11b hybrid/on-prem storage decision taken; Plan 30 floor-scoped degradation shipped (or explicitly waived for the first IPD floor); nursing scales day one (fix 38); the Plan 08 dues/advance ruling final; DPIA v0.2. Day-care service lines (60, 61) do *not* wait for this gate — they ride 25 + 16/17.

### Track C — after 13, parallel to A/B (20–31)
| Plan | Name | Source docs (their number) | Needs | Notes |
|---|---|---|---|---|
| **20** | Workforce & roster substrate (on-duty picture, credentials/competency tags, publication gates, HR-SaaS sync, Coverage Resolver as pure function, OPD availability migration) | 07 (20), 10 (20) | 13; HR SaaS chosen; R-071, R-072, R-067 | Kernel-adjacent; replaces static `usersHoldingRole()`; mini-OT already needs anaesthetist on-call resolution, so this is early |
| **21** | KPI formula registry & compute; **21b** reviews/KRAs/evidence packs/disputes/exposure; **21c** incentive statements & HR export | 11 (20, 21, 22) | 13; 12a scope frozen; R-116–R-125 | Before or alongside 12a's Digest Writer; every later plan's §8 *registers* metrics here (standing rule) |
| **22** | Front office at scale (appointments v2, call centre/PBX, displays, kiosks, handoff, certificates, Duplicate Sentinel); **22a** online payments (gateway adapter, links, webhooks, recon); **22b** Appointment Optimiser after 90 d | 20 (20, 20b); 05/03/13/16 (payment gateway) | 13; Plan 10 public surface; PBX bought; R-216–R-227, R-261 | 22a is the one payment adapter 23/24/26/27 consume |
| **23** | Teleconsultation & remote follow-up | 05 (21) | 22a; 16 and 17 soft; R-048–R-058 | Track B slot after 19 was the doc's recommendation; audio agents wait on R-059 |
| **24** | Home collection & home care: **24a** field core, **24b** home care + medicine delivery | 03 (20a/20b) | 17 accession; 19a tasks; 22a; 16 for 24b; R-024–R-035 | Registry kinds refused — vehicles/boxes/centres map to `device`/`room`/`store` (§5) |
| **25** | Session departments core + physiotherapy; **25b** home physio, group classes, corporate wellness | 04 (20, 20b) | 13, 09, 10; 15's `daycare.discharged`; R-036–R-047 | Generic course model reused by 60/61 |
| **26** | Health check-up packages | 13 (20) | 17 orders/results; 13 reservations; R-134, R-137 | Alongside 18 |
| **27** | Programmes, renewal & patient CRM (consent gate, recalls, feedback/NPS capture, grievance ladder rung 1); **27b** camps & outreach | 13 (22, 23); 20 (22) | 22a; Plan 10 opt-in registry; DPIA addendum; R-138–R-147 | Grievance *register/committee* lives in 28; capture lives here |
| **28** | Quality, NABH & governance pack: **28a** registers/incidents/licences/evidence, **28b** infection control, **28c** committees/documents/credentialing/drills, **28d** internal audit/clinical audits/DPDP program, **28e** inference lane, **28-G** governance (after O1, RULED) | 22 (22a–e, 22-G); absorbs 02 (22 NABL pack), 15 (22 quality pack), 06 (26 IC registers → 28b + 49) | 13; 12a harness shape; 21 registry shape; R-240–R-249, R-007, R-084 | Phase-2 fast-follow; 28a can run in parallel with Track A today under single-approver honesty mode (R-247) |
| **29** | BME, maintenance & utilities (equipment lifecycle over registry `device`, breakdown P0–P3, PPM/calibration, oxygen + utility telemetry consumer, cylinders P3, Oxygen Forecaster) | 19 (20, 24 folded); 09 (20 biomedical fleet); 15 (21 biomedical) | 13; 14 contracts; 19a engine; R-206, R-063 | One home for equipment; CMMS bought only if measurement says so |
| **30** | IT ops & floor-scoped downtime (`downtime_scopes`, two-person declaration, kit form kinds as data + six new kinds, backfill reconciliation, helpdesk pool, IT asset register, network-segment map) | 19 (25) | 11c/11d live; R-215 | Design law §12 unshipped; a gate for the IPD cluster |
| **31** | Patient transport (requests, both-end scans, SLA classes, ventilated bundle gate, Transport Dispatcher) | 19 (23) | 19a engine; 15's list (first consumer) | Pulled forward: the mini-OT needs porters |

### IPD cluster — behind the hard gate (40–54), in dependency order
| Plan | Name | Source docs | Needs | Notes |
|---|---|---|---|---|
| **40** | ED core; **40a** MLC, brought-dead & legal documents; **40b** ambulance & inter-facility transfer; **40c** disaster mode, codes catalog & clocks | 14 (20, 20a, 20b, 20c) | 13 (bays as beds); 10; 12a harness; 20 on-call; R-148–R-161 | Ships *first* in the cluster via the E-11 handoff to the incumbent IPD; 40c hosts the kernel code catalog (Blue/Violet/Pink/Yellow/fire/NRP/obstetric) all modules consume |
| **41** | IPD core: ADT, bed board over the registry, class ledger, wristbands/passes, deposits + payer periods + pre-auth sanction object, census | 17 (20); 07 (21) | 13 `0033`; Plan 08 dues; R-186–R-191 | Bed class/tariff link per Plan 13 §4A-1 |
| **42** | Nursing management: **42a** eMAR + worklist + vitals/EWS + assessments + handover + **the bedside two-person verify component**; **42b** ward narcotics, transfusion bedside, registers, Coverage Resolver/Deterioration Watch | 07 (22a/22b) | 20, 41, 16d; R-073–R-081 | If 47b must precede 42a, 47b builds the verify component and 42a adopts (R-259) |
| **43** | Doctors on duty: escalation ladder engine, handover, rounds, verification/co-sign, consults, duty reports; **43b** death → MCCD → MLC → mortality-review chain (shared with 44/53); **43c** inference (handover/duty-report drafters, dictation) after 12a + R-059 | 10 (21, 21b, 21c) | 20; 42a danger flags; R-108–R-115 | 43b is the single death chain every doc cites (06, 14, 17, 19, 21) |
| **44** | Discharge cascade, summaries (Drafter T2), deaths, LAMA/abscond, discharge lounge, ABDM care-context | 17 (21) | 41 live 30 d; 16 returns; 43b; R-190, R-192–R-195 | |
| **45** | MRD: file assembly, deficiencies, coding, release desk, retention/legal hold, physical files & legacy scanning, CRS filings | 17 (22) | 44; terminology licence; R-194 | |
| **46** | TPA, insurance, schemes & corporate credit desk (payer panels, pre-auth workflow, share split, claims + Claims Drafter, settlements, dunning/credit-stop, PMJAY/CGHS/ECHS/ESIC audit); **46b** NHCX/FHIR bundles | 20 (21, 21b); 13 (21) | 41 pre-auth object; 44 cascade; CA config; R-219–R-230, R-142, R-143 | 20 §14 flags a **46-lite** (OPD/day-care cashless) that could ride with 15 — owner call |
| **47** | Blood bank & transfusion: **47a** bank core (donor → unit → inventory → registers → e-RaktKosh), **47b** transfusion chain (order → issue → bedside → reaction → MTP), **47c** Reaction Report Drafter | 18 (24a/b/c) | 17 results interface; 14 lots; 42a verify component; R-196–R-204 | 30-day shadow with paper as SoT; the licensed bank keeps running throughout |
| **48** | Major OT suite + PACU + CSSD department (9 theatres, emergency board, OT→ICU handover, anaesthesia workstation feeds, loaner sets, OT List Optimiser, Op-Note Drafter) | 15 (20) | 15 patterns; 47; 49; R-162–R-170 | |
| **49** | ICU core (admission/contention, device↔bed↔patient, flowsheet, alarms, Code Blue, sepsis, restraint, HAI/bundle registers) | 06 (24 + registers from 26) | 41, 42a, 20; R-060–R-067, R-070 | NICU/PICU are hall variants, no separate plan |
| **50** | ICU telemetry edge (MQTT/Timescale, per-vendor HL7, slot-map governance, heartbeats, retention executor) | 06 (25) | 49; CMS bought with export spec; R-063, R-068 | |
| **51** | ICU end-of-life, THOTA/brain death, family communication, ICU agents | 06 (27); 17 (O-8 hook) | 49; 12a + DPIA; R-066, R-069 | |
| **52** | Dietary/kitchen (diet orders, production compiler, tray-tag pair scan, attendant meals, FSSAI registers) | 19 (21) | 41; 19a; R-213, R-214 | |
| **53** | Mortuary + security/visitor (passes extension, gate logs, code fan-out, CCTV governance, body custody + release + unclaimed ladder) | 19 (22) | 19a; 43b/44 death cascade; PSARA vendor; R-205, R-207–R-212 | |
| **54** | Command-centre watchers (census/discharge pipeline read models, Bed Demand Forecaster) | 17 (23) | 41 live 90 d | Roadmap note 10: watchers, not dashboards |

### Service lines — at each floor's commissioning (60–67)
| Plan | Name | Source docs | Needs |
|---|---|---|---|
| **60** | Dialysis (prescriptions, runs, sero classes, water/disinfection registers, reuse, Water-Quality Watcher) | 04 (21) + 21 (21 clinical content) | 25; 16 scans; 17 sero bloods; R-040, R-042, R-233, R-234 — **can precede the IPD gate** |
| **61** | Day-care chemotherapy (regimens, cycles, Chemo Gate, compounding verification, two-nurse admin, spill/extravasation registers) | 04 (22) + 21 (22) | 25; 16; 17; R-235, R-236 — **can precede the IPD gate** |
| **62** | Maternity & NICU (pregnancy record, partograph, D2D clock, dyad/EBM, MTP/POCSO/MDSR/CRS, JSY/JSSK) | 21 (23) | IPD cluster (41, 42, 49/50); 17; 18 Form F via `pcpndt`; R-231, R-237 |
| **63** | Cath lab & cardiology (STEMI clocks, consignment scan-on-use at NPPA ceiling, dose log → 18c, post-PCI on ICU pack) | 21 (24) | 14b consignment; 18b PACS; 40; R-232, R-013 |
| **64** | Radiation oncology orchestration (courses/fractions, R&V import, AERB registers + QA lockout, brachy source custody) | 21 (25); 01 ("2x") | 18c; LINAC vendor with export mandate; e-LORA; R-010 |
| **65** | Endoscopy (procedures, scope instances, reprocessing cycles, AER import, Scope Trace, sedation/chaperone gates) | 21 (26) | 15 patterns; 17-H; R-238 |
| **66** | Paediatric rules pack (weight currency, dose caps, immunisation schedule, parent-pass, PALS/NRP) | 21 (27) | IPD/PICU |
| **67** | Trauma registry + Abstractor agent | 14 (service-line) | 40c with ≥ 90 d of activations |

### Collisions resolved (doc said → now)
| Doc | Said | Now | Why |
|---|---|---|---|
| 02 | Plan 20 microbiology · 21 histopath · 22 NABL pack | **17-M · 17-H · fold into 28** | Lab extensions stay in the 17 family; NABL document control is the quality pack's Expertise store |
| 03 | Plan 20 home collection (20a/20b) | **24a/24b** | 20 goes to the roster substrate (two docs claimed it, and it is the earliest dependency) |
| 04 | Plan 20 sessions · 20b · 21 dialysis · 22 chemo | **25 · 25b · 60 · 61** | Session core is Track C; dialysis/chemo are service lines at floor commissioning |
| 05 | Plan 21 teleconsult | **23** | 21 goes to the KPI registry (kernel-adjacent, earlier) |
| 06 | Plan 24 ICU core · 25 telemetry · 26 IC registers · 27 EOL | **49 · 50 · fold (49 + 28b) · 51** | IPD cluster block; the hospital-wide HAI surveillance is 28b, ICU keeps its clinical register |
| 07 | Plan 20 workforce · 21 IPD beds · 22a/b nursing | **20 · 41 · 42a/42b** | 20 kept; IPD and nursing move behind the gate |
| 09 | Plan 20 biomedical fleet | **29** | One equipment home with doc 19's BME plan |
| 10 | Plan 20 duty roster · 21 doctors on duty · 21b death/MCCD · 21c inference | **20 · 43 · 43b · 43c** | 20 kept (same substrate as doc 07's); the rest is IPD cluster |
| 11 | Plan 20 KPI registry · 21 reviews · 22 incentives | **21 · 21b · 21c** | One number, three phases — the registry is one module |
| 13 | Plan 20 packages · 21 payer panels/TPA · 22 programmes/CRM · 23 camps | **26 · 46 (merged with doc 20's TPA desk) · 27 · 27b** | Two documents designed the TPA desk; one plan |
| 14 | Plan 20 ED · 20a · 20b · 20c | **40 · 40a · 40b · 40c** | ED opens the IPD cluster block |
| 15 | Plan 20 major OT · 21 biomedical · 22 quality pack | **48 · 29 · 28** | |
| 17 | Plan 20 IPD core · 21 discharge · 22 MRD · 23 command centre | **41 · 44 · 45 · 54** | |
| 18 | Plan 24 blood bank (24a/b/c) | **47a/47b/47c** | The doc asked the editor to allocate |
| 19 | 19-T0 engine · 20 BME · 21 dietary · 22 mortuary/security · 23 transport · 24 utilities · 25 IT ops | **19a · 29 · 52 · 53 · 31 · fold into 29 · 30** | Transport pulled forward to Track C (mini-OT needs porters); IT ops pulled forward as an IPD gate |
| 20 | Plan 20 front office · 20b · 21 TPA · 21b NHCX · 22 feedback | **22 · 22b · 46 · 46b · 27** | Feedback/NPS/grievance capture merges with the CRM; the committee is 28 |
| 21 | Plans 23–27 service lines | **62–66** | Service-line block |
| 22 | Plan 22 quality (22a–e, 22-G) | **28a–e, 28-G** | The doc anticipated renumbering |
| 01 | "Plan 2x" RT orchestration | **64** | With doc 21's RT plan |

**One line:** 12a–c · 13 · **A:** 14/14b → 15 → 16c–f → 17/17-E/17-M/17-H → 18a–c ∥ **B:** 19a–c · **C (20–31, after 13, parallel):** 20 roster · 21 KPI registry · 22 front office (+22a payments) · 23 tele · 24 home · 25 sessions/physio · 26 check-up packages · 27 CRM (+27b camps) · 28 quality/NABH (+28-G after O1) · 29 BME/utilities · 30 IT ops/floor-scoped downtime · 31 transport · **gate (O1, 0033, 20, 11b, 30)** · **IPD cluster (40–54):** 40 ED (+a/b/c) · 41 IPD ADT · 42 nursing (a/b) · 43 doctors on duty (+b death chain, +c inference) · 44 discharge · 45 MRD · 46 TPA/claims (+46b NHCX) · 47 blood bank (a/b/c) · 48 major OT · 49 ICU · 50 ICU edge · 51 ICU EOL · 52 dietary · 53 mortuary/security · 54 command centre · **service lines (60–67):** 60 dialysis · 61 chemo day-care · 62 maternity/NICU · 63 cath lab · 64 RT · 65 endoscopy · 66 paeds pack · 67 trauma registry.

---

## 4. Cross-cutting themes (raised independently by ≥ 3 documents)

| # | Theme | Docs | Recommended single resolution |
|---|---|---|---|
| 1 | **Encounter enum extension** — `daycare`, `home`, `lab_walkin`, `teleconsult`, `er`, `ipd`; who owns each extension table | 15, 04, 21, 17, 03, 02, 05, 14 | One kernel migration with Plan 15 T1 adds every value now (the enum was left open for this); each module owns its own extension table (`daycare_encounters` in OT until IPD lands, `tele_sessions`, `home_visits`, `er_episodes`); no module writes another's. Register R-035. |
| 2 | **New registry kinds requested** — `vehicle`, `cold_box`, `collection_centre`, `field_device` (03); `counter`, `kiosk`, `display`, `desk` (20); `slot` (19); `vehicle` (14); virtual rooms (05) | 03, 20, 19, 14, 05 | **Refuse all.** Plan 13 DD4 closed the set at ten for a reason. Map: vehicle/cold box/field device/kiosk/display → `device`; counter/desk → `bench` with `attributes.kind`; collection centre → `room` (or `store` for its stock) under a partner `floor`; mortuary slot → `bed`; virtual room → not a resource. Revisit only when *two* modules need the same eleventh kind. |
| 3 | **Payment gateway does not exist in the repo** (tele pay-before-consult, doorstep UPI, prepaid booking, membership sales, pharmacy online) | 05, 03, 20, 13, 16 | One adapter (Razorpay/PhonePe PG/Cashfree) with links, UPI intent, webhooks + polling, settlement file into the existing T+1 recon, refund reverse-to-source — **Plan 22a**, consumed by 23, 24, 26, 27, 16f. Register R-261. |
| 4 | **Audio/voice inference-locus exception** (transcript-to-note, dictation-to-draft, call summariser, handover narration, consent-audio) | 05, 10, 12, 20, 14, 07 | Stays blocked until the §19 amendment (Plan 11h DD11 routed it). Until then: ASR only on Cloudflare Workers AI, push-to-talk, nothing persisted, transcript is data; **no transcript-to-note agent is scheduled in any plan**. Register R-059. |
| 5 | **Consignment ledger** (ortho implants, cath stents, loaner sets, GST §31(7) six-month clock, NPPA ceiling, vendor liability) | 09, 15, 21, 16, 06 | One ledger in **14b**; `consignment.deployed` = charge + sticker + vendor liability in one event; 14b's consignment slice lands *before* 15's OT scan task; 63 consumes unchanged. Register R-102, R-232. |
| 6 | **Chaperone / witness / SoD roster gates** (USG chaperone, home ECG, narcotics witness, transfusion second person, student co-sign, counts scrub≠circulating) | 01, 03, 04, 07, 15, 16, 18, 21 | The gates are unenforceable until **Plan 20** publishes rosters with competency/eligibility tags. Pre-20 modules record `chaperone.present`/witness identity as *documentation* gates and stub the roster check; 20 turns them into publication gates. |
| 7 | **Sealed records** (PCPNDT, MTP, HIV, POCSO, VIP, staff-as-patient) across worklists, labels, analyzer host queries, vendor riders, agent pipelines, ABDM links | all 22 | One sealed-class propagation library in `patients` consumed via `patients.get`; alias on every public/vendor/display surface; **statutory registers keep the real name** (Form F, H1, MLC); treating-team carve-out (E-4) always; agent context assembly inherits the caller's filter (fix 25). No module implements its own aliasing. |
| 8 | **KPI formula registry** as the target home for every §8 | all 22 | **Plan 21** lands before any surface renders KPIs; every later plan's §8 registers metric ids there; S10 v1.3 is the book of record until then. Standing rule. |
| 9 | **Paper path / downtime kit / backfill** (every module needs its own form kinds, reserved serials, backfill screen, second-person close) | all 22 | **Plan 30** promotes kit form kinds to data and adds the six new kinds; each plan's T-last adds its kinds and a backfill screen; `late_entry.flagged` + `occurred_at` ≠ `recorded_at` everywhere; backfill events never trigger agents (fix 28). Until 30, every downtime is hospital-scoped — say so in every phase doc. |
| 10 | **Bedside two-person verify component** (transfusion, EBM, narcotics, high-alert, chemo) | 07, 18, 21, 16, 15 | Build once (42a, or 47b if it ships first — R-259); wristband + second person + item barcode hard stop; manual mode records `verification_mode=manual` and never silently downgrades. |
| 11 | **Code system** (Blue, Violet, Pink, Yellow, fire/evacuation, NRP, obstetric, CBRN) | 06, 14, 19, 21, 07, 22, 03 | One kernel/ops **code catalog** with roster-resolved converge tasks, gate-seal counters, timed code sheets and drill scoring — lands in **40c**, consumed by 49, 53, 62, 24 (Code-Violet-at-home). |
| 12 | **Death → declaration → MCCD → MLC check → mortuary → release → CRS** chain | 10, 17, 14, 19, 06, 21, 22 | One chain, **43b**; MRD owns the register row (45), mortuary owns custody (53), ED owns brought-dead (40a); body release never gated on payment (D-33); night certifier chain R-111. |
| 13 | **P5 pool engine / kernel `tasks`** | 08, 19, 03, 07, 09, 15 | Kernel component in **19a**; five pools, one claim discipline, `pool_empty` fallback to the duty manager (which scenario 10 shows is the bottleneck). Register R-094. |
| 14 | **`pcpndt` shared module** (Form F register + registrations) | 01, 15, 21, 22 | Tiny kernel-adjacent module built in **15**, adopted unchanged by 18a and 62; one register for one inspector. Register R-163. |
| 15 | **Coverage Resolver as a pure function** `(snapshot, proposal) → plan` | 02, 03, 04, 07, 10, 14, 17 | One implementation in **20**; per-module policy tables; always T3 (duty manager approves) except in `disaster` where it drops to T1. |
| 16 | **Licence-dependent operation blocks** (PCPNDT, AERB, blood bank, drug licence, BMW, MTP place, fire NOC) | 22, 01, 16, 18, 21, 08 | One licence register in **28a** with a dependent-operation interface every module calls; hard blocks per R-007; filed-renewal acknowledgement lifts 90 d. |
| 17 | **Inspection persona + certified statutory prints** (PCPNDT, NABL, SPCB, drugs inspector, SBTC, PMJAY audit, CEA, NABH) | 01, 02, 08, 13, 16, 18, 20, 22 | E-20 personas and hash-footer prints built once in **28a**; every register table declares its statutory print shape. |
| 18 | **Refund / credit-note policies for prepaid instruments** (tele, courses, memberships, packages, appointments, home visits) | 04, 05, 13, 20, 03 | Policy JSON in programme/package definitions, not code; auto-refund below a threshold for hospital-fault; approval above; bank transfer above ₹10k; one golden suite. |
| 19 | **Cold chain on the utility-telemetry pattern** (pharmacy fridges, blood bank, home transit boxes, dialysis RO, oxygen) | 16, 18, 03, 04, 19, 06 | One `utility_points` consumer in **29**; sensors must have local MQTT/Modbus (R-206); manual verified tasks day one; excursion → auto-hold is a T3 act behind standing DTC approval. |
| 20 | **One retention schedule** | 12 docs | Register R-009; counsel confirms once against state CEA rules; every §4 cites it. |
| 21 | **Single-approver honesty** until runbook O1 | 22, 12, 09, 13, 17 | R-247: enable single-approver mode with `governance.single_approver_used` events and a digest line; re-ratify Class-A definitions within 30 d of O1. This is the truthful posture, not a workaround. |
| 22 | **Negative-space watchers** (an absence is the signal) | all 22 | Each §14 answered it; collect every "absence" row into 54's watcher catalogue and 28a's silence detector; none becomes a red number on a dashboard. |

---

## 5. Kernel and registry asks — deduplicated

| Ask | Requested by | Recommendation |
|---|---|---|
| Encounter enum values `daycare`, `home`, `lab_walkin` (+ reserved `er`, `ipd`, `teleconsult`) | 15, 03, 02, 05, 14, 17 | **Accept**, one migration in 15 T1; extension tables module-owned (R-035) |
| Registry kinds `vehicle`, `cold_box`, `collection_centre`, `field_device` | 03 | **Refuse** → `device` / `room` / `store` |
| Registry kinds `counter`, `kiosk`, `display`, `desk` | 20 | **Refuse** → `bench` (counter/desk), `device` (kiosk/display) |
| Registry kind `slot` (mortuary) | 19 (asked and self-rejected) | **Refuse** → `bed` under a Mortuary `room` (R-205) |
| Registry kind `vehicle` (ambulance) | 14 (asked and self-rejected) | **Refuse** → `device` under an ambulance-bay `room` (R-156) |
| Kernel `tasks` / P5 pool engine | 08, 19 (+03, 07, 09, 15 as consumers) | **Accept** in 19a (R-094) |
| Roster substrate replacing static `usersHoldingRole()`; on-duty picture; publication gates | 07, 10 (+ every ladder consumer) | **Accept** as Plan 20, kernel-adjacent, feature-flagged with static fallback |
| KPI formula registry as kernel-level vs module | 11 | **Module-owned** (`modules/performance/`) with a kernel-registered read interface (R-125); every plan registers metrics there |
| `pcpndt` kernel-adjacent module | 15, 01 | **Accept**, built in 15 (R-163) |
| Code catalog (kernel/ops) | 06, 14, 19 | **Accept**, lands in 40c; ICU/mortuary/maternity consume |
| Floor-scoped `downtime_scopes` + kit form kinds as data + six new kit kinds | 19 | **Accept** as Plan 30 (R-215); an IPD-cluster gate |
| Payment gateway adapter | 05, 03, 20, 13 | **Accept** as 22a (R-261) |
| Bedside two-person verify component | 07, 18, 21, 16 | **Accept**, one component, 42a (or 47b) — R-259 |
| Journey Feed read model (`episodes`) in kernel | 12 | **Accept** in 12b as event-mirror v1; no module writes it |
| Expertise store: shared `documents` table for SOPs + playbooks | 22, 12 | **Fold**: one table with `audience`; decide at 28c authoring (R-260) |
| Sealed-class propagation into agent pipelines and vendor surfaces | all | **Existing** (fix 25, E-4) — extend the `patients` library; no new seam |
| Reservations as governed state machines with TTL (beds, ICU, OT, packages) | 17, 06, 15, 13 | **Existing** (roadmap note 15) — 41 implements; 15 and 26 consume the same shape |
| Interrupting approval channel (ICU admission, emergency PO, disaster declaration) | 06, 09, 14 | **Existing** (E-15) — no new seam; each plan registers its urgency class |
| Inference `complete()` contract + on-prem locus | 12, 01, 06, 07, 10 | **Accept** in 12a/12c per R-126; every T2 drafter is gated by the same five gates |
| **NEW event families** (deduplicated; ~400 NEW names proposed across the series) | all | **Accept the grammar, lint the names**: `disaster.*`, `code.*`, `consignment.*`, `roster.*`/`duty.*`, `kpi.*`, `outbreak.*`/`exposure.*`, `agent_run.*`/`inference.*`, `downtime_scope.*`, `visit.*`/`custody.*` (home), `tele.*`, `session.*`, `mlc.*`/`brought_dead.*`, `form_f.recorded`, `governance.single_approver_used`, `consultant.unreachable_flagged`, `send_out.lost`, `counterfeit.suspected`, `study.acquisition_completed_offline`, `daycare.converted_to_admission` (exists), `unit.*`/`transfusion.*` (exist). Rule for phase docs: reuse the catalog name where one exists; a NEW name needs the `entity.verb_past` lint and a subscriber named in the same doc. |

---

## 6. Top-20 risks across the series

1. **One approver.** Every two-key, SoD, committee and incapacity rule in 22 documents is theatre until runbook O1 closes (22, 12, 09, 13, 17). Nothing behind the IPD gate should be authored as if it were closed.
2. **Hospital-scoped downtime.** Design law §12 (floor-scoped degradation) is unshipped; at 610 beds one dark floor puts 609 beds on paper (19; every chaos §6).
3. **The single VM is the scale ceiling** and the 11b hybrid/on-prem decision is deferred (01 PACS storage, 06 telemetry, 20 at 2,000/day, 12 cost model).
4. **Alarm fatigue by design** — every plan adds "selective" active alerts; nobody has measured the sum. Scenario 10 in the chaos file is where it breaks (07, 10, 06, 20, 19).
5. **Wrong-patient at the point of no return** — tube (02, 03), bedside transfusion (18, 07), EBM (21), device↔bed (06), UNK merges in a disaster (14). Each is designed; the *shared* component is unowned (R-259).
6. **Audio/voice locus** unresolved blocks four departments' drafters; the temptation to ship a transcript-to-note "just for one doctor" is the DPDP breach path (05, 10, 12, 20).
7. **Payment gateway absent** — tele, home, prepaid booking and memberships all assume it (05, 03, 20, 13).
8. **Statutory registers on paper during cutover** — blood bank (18), H1/NDPS (16), Form F (01/15), MLC (14), BMW (08): the inspector needs continuity, and the shadow periods are the riskiest weeks.
9. **Licence expiry nobody noticed** — 22 6.5 (fire NOC) is the watchman *failing* on a bad expiry year; hard blocks (R-007) cut both ways: a wrong row stops USG.
10. **Consignment stock we don't own** — three counts, a six-month GST clock, a vendor rep who is absent when the stent is needed (09, 15, 21).
11. **Treat-first credit as the leakage door** — ED at 150–250/day with no payment gate needs the write-off ladder ruled (R-148) or every night is a negotiation (14, 17).
12. **Coercion in blood** — replacement-donor pressure is the commonest Indian failure; the design refuses to model it as a state (R-198/R-199); staff will route around it on WhatsApp unless the digest shows it (18).
13. **Reporting culture** — one wrong KPI on a wall ends incident reporting (22 O-1/O-2, 11 G4); the design forbids it structurally, the owner must sign the policy.
14. **Roster truth** — WhatsApp-swapped shifts and static role resolution mean the 03:00 escalation may reach nobody until Plan 20 (10, 07, 14).
15. **De-identification of Hinglish free text** — the DPIA's crux; the scrubber will never be perfect; complaint text and scanned Rx are the leak paths (12, 20, 27).
16. **Vendor lock at the edge** — analyzers, monitors, R&V, AERs, oxygen sensors without local export make the edge designs fiction (02, 06, 19, 21; R-251).
17. **CA/tax shapes assumed** — GST on convenience fees, packages, wellness; ITC apportionment; §11(4A); TDS classes — ten rows that could invalidate four money models (03, 04, 05, 09, 13).
18. **Cutover facts unseen** — legacy registers, the police station's MLC format, the reference-range book, the paper file index; every absorption plan depends on them (18, 02, 14, 17).
19. **Agent drift** — 40+ agents become 40 unaudited scripts by 2027 without the one harness/one catalog/one eval lane discipline (12); each department doc proposed 8–14 candidates.
20. **The clinical committees do not exist** — 24 clinical-policy defaults need a DTC/HICC/transfusion/mortality body to sign them; the chairs are proposals (R-243) and the quorum needs the roster module.

---

## 7. Reading order and the first five rulings

**Reading order for the owner (executive summaries first; full doc only where marked ★).**
1. **12 Agentic copilot layer** ★ §9.12 and §13 — it sets the rules every other document obeys.
2. **22 Quality/NABH/governance** ★ §1 and §13 — governance without a second adult; the licence register; who signs what.
3. **19 Support services** §1 and §14 — the pool engine, oxygen, and *why floor-scoped downtime gates everything*.
4. **09 Procurement** and **15 Mini-OT** — Track A's first two plans; rulings here unblock 14 and 15 immediately.
5. **16 Pharmacy**, **02 LIMS**, **01 Radiology** — the rest of Track A in order.
6. **08 Housekeeping/BMW** — Track B; the CBWTF contract is already an open action.
7. **07 Nursing** and **10 Doctors on duty** together — they share the roster substrate (Plan 20) and the escalation ladder.
8. **11 KPI** — the registry every plan will register into; short.
9. **20 Front office** and **13 Memberships/TPA** together — the money-and-law front of house; they share the TPA desk (46).
10. **17 IPD/MRD**, **14 ED**, **06 ICU**, **18 Blood bank** — the IPD cluster, in that order.
11. **05 Tele**, **03 Home**, **04 Sessions**, **21 Service lines** — light modules and floors, when their dates are near.
Then `00-CROSS-MODULE-CHAOS.md` scenarios 2, 7 and 10 (downtime, ransomware, scale) — the three that test the whole building rather than a department.

**The first five rulings that unblock the most.**
1. **R-247 + runbook O1 — the second approving actor.** Rule single-approver honesty mode now and name the date O1 closes. Unblocks: honest authoring of 28a, 12a's kill-switch drills, every two-key rule, the IPD gate.
2. **R-035 — the encounter enum extension** (`daycare`, `home`, `lab_walkin`, reserved values) in one migration with Plan 15 T1, extension tables module-owned. Unblocks: 15, 17, 23, 24, 25 without three separate spine edits.
3. **R-094 + R-215 — `tasks` in the kernel (19a) and floor-scoped downtime as Plan 30.** Unblocks: 19a authoring, 29/31/42/52/53 as consumers, and the IPD gate's honest definition.
4. **R-059 — the audio inference-locus amendment (yes/no/when).** Unblocks or *honestly parks* four departments' drafters (23, 43c, 22b, 12c) and stops any phase doc from scheduling a transcript-to-note agent by accident.
5. **R-255 + R-262 — book the CA session (ten rows) and the counsel session (retention R-009, licence blocks R-007, DPIA v0.2, the fifty-two legal rows).** Unblocks: 14's cash/ITC/MSME config, every money model in 23–27, and the DPIA that gates the first Track-C deploy.

A sixth that costs nothing: **ratify §3's numbering** so the next phase document can cite a plan number that will not move.
