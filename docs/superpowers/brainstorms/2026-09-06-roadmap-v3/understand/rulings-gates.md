# rulings-gates — which owner rulings and hospital-wide gates bind the five mission pillars

Read-only, 2026-09-06, `origin/main` @ `b04cbd9`. Paths: **REG** = `docs/superpowers/brainstorms/2026-08-27-department-series/00-OWNER-RULINGS-REGISTER.md` (row R-nnn is at line 12+nnn; R-001:13 … R-262:274; §2 grouping :276-286) · **RM** = `docs/superpowers/2026-09-06-ROADMAP-v2.md` · **11i** = `docs/superpowers/plans/2026-09-06-phase1-11i-the-stand-up-path.md` · **IDX** = `…department-series/00-INDEX-AND-SYNTHESIS.md` · **11f** = `…plans/2026-08-24-phase1-11f-operability-gate.md` · **DPIA** = `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` · **PSS** = `…brainstorms/2026-08-27-patient-self-service/06-RULINGS-LOCKED.md` · **P08** = `…plans/2026-08-18-phase1-08-billing-counter.md` · **SER** = `…plans/2026-08-11-phase1-plan-series.md` (`…` = `docs/superpowers/`). Pillars: **P1** fabric + 15 languages · **P2** OPD (scheduling, ambient co-pilot, in-room lab/pharmacy) · **P3** fibre-to-cloud radiology + OT · **P4** monitoring + three betas · **P5** magic discharge + 100 % audit.

Standing rule (CLAUDE.md; RM §6:438): the owner rules **money, procurement, law** and states **facts only he holds**; everything else the agent DECIDES at the Indian-corporate-hospital default. Applied here to the 262-row register, O1–O6, and the roadmap's gates.

## 1. The hospital-wide gates — what sits in front of what

| gate | definition (cite) | state 2026-09-06 | sits in front of | owner act |
|---|---|---|---|---|
| **O1 second full administrator** | 11f:259-261 (`/admin/users`, assign `admin`, detector goes quiet) | NOT DONE — production has one admin (11f:545; RM §4:397; CONTEXT) | IPD gate (RM §4:397-407); Class-A two-key + re-ratification within 30 d (R-247, REG:259); OT `ot_definition_publish` second approver (`…15-mini-ot-daycare.md:201`); 28-G; **no longer the lab** (RM §0c.6:183-191 adopts R-247 honesty mode) | a name and a date; five minutes on the screen, week 3 (RM §2:336) |
| **O2 credential rotation** | 11f:263-265 (15 passwords, 14 PINs, admin's own) | NOT DONE at 11f close (11f:550); no later evidence read | nothing on the roadmap names it — a hygiene gate before any real staff log in | owner-only by construction (11f:255-257) |
| **O5 one real day through the system** | 11f:271-274; first row in `operating_mode_changes` | NOT DONE — 498 events, never left commissioning (RM §0:28) | superseded by G5/G6 (RM §3:351-378): a dated runbook `## Executed` section + a pilot harvest | the department head performs it; the owner states the fact in §3 |
| **O6 CA signature + active tariff** | 11f:275-277; `validate:config` prints `caSigned` (`apps/core/scripts/validate-config.ts:28-29`); every GST row is `DEV PLACEHOLDER — CA sign-off required` (`apps/core/scripts/seed-tariff.ts:33-100`) | OPEN, unchanged since 24 Aug (RM §0 row 5:29) | **G7, the only hospital-wide exit from `commissioning`** (RM §3:378; §1 Q1:219-220); pharmacy runbook precondition 5 (`docs/runbooks/pharmacy-go-live.md:35`); the lab catalogue's prices; the first live invoice | one CA session with the ten CA rows as agenda (R-255, REG:267; RM §6.3:444-446) |
| **GST on tax-inclusive MRP** (new, not in the register) | memory `pharmacy-launch-2026-09-06`: `pricing.ts:103` adds tax on top of MRP; 16c R-2 (`…16c-opd-dispense-counter.md:98`) ruled WHICH slab, never inclusive-vs-exclusive | OPEN and live: pharmacy routes are live on production with an empty shelf; a real slab bills above printed MRP (illegal), the placeholder `exempt:true` (`seed-tariff.ts:93`) is right by accident | the pharmacy demo seed, the item loader (RM §2 wk 4-6:337), G3 for pharmacy, P2 in-room medicine delivery | owner states the treatment (inclusive), CA states the rates — must precede O6's slab signature |
| **DPIA v0.2** | R-262 (REG:274); the file's header already reads "0.2 DRAFT … not reviewed, not signed" (DPIA:3); [COUNSEL] items at DPIA:27 (Class-0 cross-border), :29 (router sub-processor pinning), :33 (STT carve-out), :38 (staff-data notice), :56 (erasure/crypto-shredding), :57 (retention); plus R-262's eight additions and two addenda owed by others: 18b R4 Drafter (`…18b-dicom-seams-no-hardware.md:91`), Hermes E10 (`/opt/hmis/…hermes…/00-BRAINSTORM.md:216`) | UNSIGNED (DPIA:66-70) | **anything with inference on production** (CONTEXT; RM §5:429 "No 12a agent runtime"): P1 fabric, P2 ambient co-pilot + voice scribe (inert at 503), P4 vision/wound beta, P5 discharge Drafter, 43c, 44 (RM §4:405) | one counsel session; the owner's accept/refuse on the STT carve-out (DPIA:33) is his half |
| **11b storage / hybrid** | SER:339-345 (Plan 11 split; 11b = stage 2, "waits on the on-prem primary being procured and racked"); `…11a-deployment.md:46` | UNDECIDED (RM §4:402; IDX §6 risk 3:197) | 18b-ii PACS (18b R1 recommends on-prem Orthanc, ₹2-3 L + ₹8-15k/mo, `…18b…md:88`); 49/50 ICU telemetry; not 41 (RM §4:402) | a decision then a purchase (RM §6.4:449). **Conflicts with the mission's "eliminate PACS servers, cloud"** — see Surprises |
| **"Plan 08 dues / advance ruling"** | RM §4:403 + R-252 (REG:264) cite it as OPEN and critical for 41 | **RULED 2026-08-18, SHIPPED 2026-08-21**: P08:11-14 rulings 1-2 (dues + advances = receipts & allocations; credit = caps + approval; carry-forward was in the ask, SER:492); `…11c…md:772` confirms | what is genuinely open is the **IPD money**: deposit shortfall R-187, treat-first write-off ladder R-148, discharge dues R-195, undertaking R-219, short-payment ladder R-220 | one line confirming the 08 ruling extends to IPD deposits, plus the five ladders' numbers |
| **Second server** | RM §6.1:440-442; Hermes R2 (`…hermes…/00-BRAINSTORM.md:182`: Indian VPS ₹1.5-3k/mo, must not share the hospital box) | OPEN | UAT off the memory ceiling (11i D1:127-130 — target-parameterised, no rewrite); Hermes/P1 T0 ops copilot | a purchase; nothing waits on it (11i §7:445-447) |
| **AERB certificates** | RM §0 row 6:30 (18c not deploy-dark: every ionising study refuses `device_not_licensed` until licences are filed); 18c §7 R1-R4 (`…18c-radiation-safety-aerb.md:80-84`); runbook preconditions 3+5 (`docs/runbooks/radiation-safety-go-live.md:44-48`) | the certificates are the owner's paper; `DEMO` licences exist only on the AERB bench | radiology opening on production (RM §2 wk 7-9:338; G3 for radiology); P3 fibre-to-cloud in its entirety | the certificates by week 7, the RSO and physicist by name; until then production's CT/DR stay refused "which costs nothing while radiology is unopened" (RM §2:346-348) |
| **Lab catalogue spreadsheet** | `docs/runbooks/lab-go-live.md:36,108-110` (precondition 1.4; "the hospital's catalogue is the owner's data"); `…17-lims-core.md:170` item 3 (codes, ranges with sources, prices, pathologist's registration number, three report samples) | not received; UAT runs on the golden ~60-orderable fixture | the lab's production stand-up (G3, RM §2 wk 3:336); pricing also needs O6 | by week 3; the 11k loader (11i §6:411-413) takes his file, never invents rows |
| **The names** | RM §0c.4 via §6:452-455 | none named | G4: lab (pathologist + 4 keys, wk 3), pharmacy (chief + 3, wk 4), radiology (RSO + physicist, wk 7); nobody can file a licence without an RSO holder (`radiation-safety-go-live.md:46`) | a row without a name reads *unstaffed* |
| **Licence inventory** | R-256 (REG:268): PCPNDT, MTP place, NDPS RMI, retail Form 20/21, blood-bank, AERB/e-LORA, BMW, fire NOC, CEA, FSSAI, PSARA, lifts | not produced | 28a authoring; R-007 hard blocks; 18a's "real §19 PCPNDT registration" (`…18b…md:92`, `…18c…md:84`) | copies with expiry dates — a fact, not a judgment |
| **Payment gateway** | R-261 (REG:273) | **DECIDED** Razorpay (PSS:69); 22a1/22a2 authored, not approved (`…22a1-payment-money-in.md:5`) | prepaid booking (R-218), tele, home, memberships | sign the merchant agreement |
| **`deploy-blocker` label** | RM §0 row 10:35; §0c:104-106 ("inert until it does") | absent | every weekly deploy | one click |
| **WhatsApp templates / DLT / WABA** | 17c §7 (`…17c-lims-five-seats.md:105` `not_submitted`); `lab-go-live.md:319`; 11i §6:414-416 | not submitted | any patient message from lab, pharmacy, front desk (P2 in-room delivery, P4 wound uploads) | a vendor registration — procurement fact |

## 2. OPEN owner rulings that bind each pillar (money / procurement / law only)

Urgency: **now** = on the 13-week calendar; **Q4** = blocks a plan authored this quarter; **later** = behind the IPD gate or outside the quarter (RM §5:412-436).

### P1 — Unified intelligence fabric + 15-language speech
| id | question | cat | blocks | default | urgency |
|---|---|---|---|---|---|
| R-059 (REG:71) | audio/voice inference-locus amendment: transcript-to-note, dictation, call summarising | law | 23, 43c, 22b, 12c; IDX risk 6 (:200) | blocked until ruled; ASR only, push-to-talk, nothing persisted | now — the ambient co-pilot cannot be scheduled without it |
| DPIA §3-A STT carve-out (DPIA:33) | accept/refuse the one named Class-2 exception (Cloudflare Whisper, cross-border acknowledged) | law + owner accept | voice search, and by extension every speech feature in 15 languages | accept on the stated terms; close when in-region ASR arrives | now |
| R-126 (REG:138) | Class-1 inference locus (on-prem small models vs in-region cloud DPA) | law | 12c, every drafter | on-prem default; cloud only with in-region DPA | Q4 |
| R-131 (REG:143) | inference cost cap | money | 12a | ₹5,000/day hard cap in commissioning; halt at 150 % of 7-day median | Q4 |
| R-254 (REG:266) | data-residency stance for every outbound processor | law | 12c, 18b, 23, 50 | India-region + DPA for all | Q4 |
| Second server (RM §6.1) | buy an Indian VPS for Hermes/UAT | money | Hermes T0 copilot; UAT headroom | ₹1.5-3k/mo VPS | now, cheap |
| 18b R4 (`…18b…md:91`) | Drafter provider + DPIA addendum | law + money | any model call in radiology; the same ruling Hermes awaits | offline until DPIA signed and a provider chosen | Q4 |
| ASR/speech vendor for 15 languages | no register row; the mission's "natively" needs an Indic ASR contract (Bhashini/AI4Bharat/cloud) with a DPA | procurement + law | P1 multilingual in its entirety | pick an in-region provider so the §3-A carve-out closes | Q4 |

### P2 — Intelligent OPD
| id | question | cat | blocks | default | urgency |
|---|---|---|---|---|---|
| GST on inclusive MRP (§1) | treatment of medicine MRP | money/CA | pharmacy G3, in-room medicine delivery | MRP is tax-inclusive by statute; back out tax from MRP | **now** |
| O6 (§1) | CA-signed slabs + real tariff | money/law | G7; every consult fee, the lab walk-in `V` visit price | one CA session | now |
| R-024, R-043, R-055, R-097, R-098, R-099, R-101, R-134, R-137 + umbrella R-255 (REG:36,55,67,109-113,146,149,267) | the ten CA rows: GST on convenience/wellness/packages, 40A(3)/269ST thresholds, ITC apportionment, MSME 30-day, capitalisation, trust §11(4A), TDS/RCM, PPI | CA | 14, 23-27; IDX risk 17 (:213) | statute values now, CA confirms | now — one agenda, one session |
| R-218 (REG:230) | no-show fee / prepaid self-booking | money | 22, zero-wait scheduling | no fee year 1; prepaid optional with auto-refund ≥ 2 h | Q4 |
| R-050 (REG:62) | e-Rx signature method | law | 23, ambient-drafted prescriptions | server-side signing + TOTP; Aadhaar eSign later | Q4 |
| R-173, R-174 (REG:185-186) | NDPS RMI application; separate retail Form 20/21 | law | 16d, 16c — 16c R-3 already refuses X/NDPS at the counter (`…16c…md:99`) | apply now; separate retail licence | Q4 |
| FD-25 ruling 4 (memory `fd25-owner-rulings-2026-09-05` §4) | panel/TPA counter wording | money-adjacent | a front-desk briefing before a live counter | "the panel rate is the price; ₹X still payable" | now, one sentence |

### P3 — Fibre-to-cloud radiology + dynamic OT
| id | question | cat | blocks | default | urgency |
|---|---|---|---|---|---|
| 11b + 18b R1 (§1; `…18b…md:88`) | PACS storage: on-prem Orthanc vs the mission's cloud | procurement + money | 18b-ii, every "instant AI annotation / 3D volumetric" item | 18b recommends on-prem NVMe + offsite incremental; the mission says cloud — **the owner must pick** | Q4 (wk 7-9 per RM §2:338) |
| 18b R2, R3 (`…18b…md:89-90`) | MWL/MPPS licences per modality; 3 MP diagnostic monitor (~₹4 L) | procurement | 18b-ii | CT + DR now | Q4 |
| AERB certificates + 18c R1-R4 (§1) | RSO + physicist names; TLD badge contract; investigation level (R3 is policy, misfiled — §5); QA contract | law/procurement/fact | radiology opening on production | file by week 7; senior radiographer as RSO | now |
| R-001 (REG:13) | teleradiology standby contract + DPA | procurement + law | 18b, 18a-iii WF-IMG-10 (`…18a-iii…md:181`) | dormant DPA-backed contract, duty-manager trigger | Q4 |
| R-004 (REG:16) | film/CD prices | money | 18a-iii release desk (`…18a-iii…md:178-180`) | film-free; CD ₹150; film ₹250; MLC free | now — blocks the release desk |
| R-008 (REG:20) | image-AI products (CXR triage, stroke) — the mission's ICH/fracture/pneumothorax | procurement (register says scope) | P3's AI analysis entirely | bought never built; T1 nudges only after PACS stable | Q4 — a vendor evaluation the owner funds |
| R-237 (REG:249) | MTP approved-place + PCPNDT certificates on file | law | 15, 62; 18a's real §19 registration | owner already opened; go-live gate | now |
| R-007 (REG:19) | hard block on licence expiry | law | 15, 18a, 28a, 47 | hard block + 90-d filed-renewal lift (18c already does this) | counsel confirms |
| R-102 (REG:114) | consignment agreement clauses, wrongly-opened implant liability | law | 14b, 15 OT | hospital cost centre unless vendor defect; refuse consignment GRN without agreement | Q4 |
| R-164, R-165, R-162 (REG:174-177) | theatre-time bands; opened-kit on cancellation; day-care billed by package | money | 15 | wheel-in→wheel-out 30-min bands after 60; patient-attributable charges patient | Q4 |
| R-013 (REG:25) | PCPNDT in-charge, RSO, e-LORA per device | staffing → **names + a filing** | 18a, 18c, 63, 64 | 24×7 radiologist = sonologist-in-charge | now |

### P4 — Patient care, monitoring, three betas
| id | question | cat | blocks | default | urgency |
|---|---|---|---|---|---|
| Interaction/dose dataset licence (RM §0 row 9:37; §6.4:450) | ₹8-12 L/yr, RFQ running | procurement + money | **16e clinical pharmacy = the medication-safety beta entirely** | sign after the RFQ | Q4 |
| 11b (§1) | telemetry storage | procurement | 49/50 personalised monitoring | decide with PACS | later |
| R-063, R-206, R-251 (REG:75,218,263) | UPS/SNMP; device export mandate (Modbus/MQTT/HL7) | procurement | 49, 29, 14 checklist; IDX risk 16 (:212) | no device without local export | Q4 |
| R-009 (REG:21) | one retention schedule (telemetry 90 d full-res, photos 3 y, …) | law | every §4; wound-image uploads | adopt the schedule; counsel confirms against state CEA | Q4 |

### P5 — Magic discharge + 100 % real-time audit
| id | question | cat | blocks | default | urgency |
|---|---|---|---|---|---|
| O1 (§1) | second administrator | staffing → **a name** | IPD gate, every two-key rule, R-247 re-ratification, 28-G | five minutes | now (wk 3) |
| IPD money (§1 dues row): R-148, R-187, R-195, R-219, R-220, R-258 (REG:160,199,207,231,232,270) | write-off ladder; deposit shortfall; discharge dues; undertaking threshold; short-payment ladder; credit-stopped corporate at ED | money | 40, 41, 44, 46; IDX risk 11 (:207) | ≤ ₹2k auto write-off, ≤ ₹25k billing head, above owner; admit regardless of shortfall | Q4 (41 authored wk 7-9) |
| R-192, R-111 (REG:204,123) | discharge-summary sign delegation (RMO signs, consultant ≤ 24 h); MCCD certifier chain | law (+ medical director) | 44 magic discharge, 43b | as defaulted | Q4 |
| R-084, R-246 (REG:96,258) | statutory signatories/occupier; incapacity deputy pair + instrument | law | 19b, 28a, 28-G | owner = occupier, MS alternate, QM = DPO; counsel executes the instrument | Q4 |
| R-240, R-241, R-245 (REG:252-257) | just-culture policy; open disclosure; internal auditor appointment | law / money | 28a, 28d — the 100 %-audit pillar has no reporting culture without R-240 (IDX risk 13:209) | adopt; appoint the §138 firm before the Payouts pack | Q4 |
| R-119 (REG:131) | KPI-linked pay forbidden; incident counts never in appraisal | policy **but the owner must sign it** (IDX risk 13) | 21, 21c, 28a | forbidden by design | Q4 — sign, do not deliberate |

## 3. Facts only the owner holds (not rulings)

1. **Has any real patient been registered on production?** 498 events say no; his one line sets the announcement and the hour, not the order (RM §0b.1:59-61; 11i §7:430-436).
2. **The names** — pathologist of record + 4 lab keys (wk 3), chief pharmacist + 3 (wk 4), RSO + physicist (wk 7), and the committee slate R-243/R-253 (REG:255,265) for the day the DTC must sign 24 clinical defaults (REG:284; IDX risk 20:216).
3. **The lab catalogue spreadsheet** and the pharmacy item master (schedule, HSN, GST, MRP) — G3's long pole (RM §0 row 8:33).
4. **The AERB certificates**, the PCPNDT §19 registration, and the licence inventory with expiry dates (R-256).
5. **Vendor facts** R-257 (REG:269): analyser inventory + protocols (17-E T7 needs a real `lab_bridge` instrument), monitor HL7 samples, PBX API, wristband printer, HR SaaS export.
6. **Deploy #73 or bin it**; remove the two demo directories (`…HANDOFF-pharmacy-lane-v2.md:51`; 11i §6:427-429).
7. **Whether FP sterilisation services are performed** (R-171, REG:183) — a fact about the hospital, wrongly filed as scope.

## 4. Already DECIDED — do not re-ask

| id | where decided |
|---|---|
| R-247 single-approver honesty mode until O1; the lab opens under it | RM §0c.6:183-191; Plan 15 DD6 (`…15-mini-ot-daycare.md:144,201`) |
| R-035 encounter enum extension | moot: `opd_encounters.type` is open text; walk-in rides `V` (`…15…md:238`; `…17-lims-core.md:166` DD15) |
| R-014, R-018, R-022, R-020 (lab: night criticals, amendment wording, auto-verify OFF, templates only); 02 O-1/O-4 = R-002/R-016 | `…17-lims-core.md:124,131,166` |
| R-015 reference-lab partner | owner 2026-09-05: synthetic partners, CRK letterhead (`…17e-lims-analyser-interface.md:288-296`) |
| 16c R-1..R-5 (batch-grain price, slab, no X/NDPS at counter, H1 register, discount cap) = R-177 half | `…16c…md:95-101` |
| R-261 payment gateway = Razorpay; P-3 fee absorbed; refund/concession ladders; R-08 release-on-authorisation | PSS:69-90, 33, 122-125 |
| Q5 analyser rerun rule; Q6 pool values; Plan 30 floor-scoped downtime waived for the first IPD floor; 41 before 40; 17-M after lab G6; reagent consumption deferred (not owner's) | RM §1 Q5-Q6:303-324; §4:401; §5:412-436 |
| Plan 08 dues/advances/credit/refund guards (rulings 1-3) | P08:11-14; SHIPPED SER:175 |
| Printing = server-side (option B); ABDM now; 20-minute rule; packages both ways | memory `printing-architecture-ruling`; `…fd7-three-seats.md:75-83` |
| Diagnostic-only visit carries no consult fee; reprints carry the alias | memory `fd25-owner-rulings-2026-09-05` §2-3 |

## 5. Misfiled — not money / procurement / law, wrongly left to the owner

REG:278 puts **174 rows** in "owner alone", of which **policy 52 · scope 22 · staffing 10 = 84** are not money/procurement/law, and **24 clinical-policy rows** (REG:284) belong to the DTC once it exists. Under the standing rule the agent DECIDES these at the Indian-corporate-hospital default; the owner's one act is "adopt all defaults except …" (REG:278 offers exactly that). The consequential ones:

| id | why not owner's | Indian-corporate-hospital default (DECIDE) |
|---|---|---|
| R-094 tasks/P5 pool as kernel; R-215 floor-scoped downtime as Plan 30; R-125 KPI registry home; R-163 pcpndt module; R-205 mortuary slot; R-259 one two-person verify component; R-260 expertise store; R-239 numbering | architecture/scope — IDX §7 already calls three of them "the first five rulings" but they are numbering and placement, not money | adopt each recommended default verbatim; ratify §3 numbering by silence |
| R-216, R-217 overbooking; R-188 bed TTLs; R-190 discharge-before-11 KPI; R-085 turnover SLAs; R-046 recall cadence; R-110 escalation timers | operational policy — every corporate hospital runs these as config | 15 %/25 % overbooking; 30-min tentative hold; 60 % D<11 target as KPI only; S1 5/5/10/10 min |
| R-072, R-078, R-113, R-065, R-144, R-074, R-081, R-114, R-115 (fatigue limits, verbal-order window, locum grants, visitors, VIP, bedside scan, handover drafter order, WhatsApp PHI ban, reachability) | nursing/medical administration policy; NABH tables exist | adopt; matron/MS own the numbers |
| R-116, R-117, R-120-R-123 (KPI audience, rate-KPI withholding, DQ, OKR level, nudge, surge) | KPI design law | adopt; only R-119 needs the owner's *signature* |
| R-127 global-halt authority; R-130 tier-promotion numbers; R-132 pilot cohort; R-133 steward | 12a governance — spec §16 already fixes the tiers (`…hmis-architecture-design.md:778`) | any on-call halts; owner OR two-of-three clears; QM = steward day one |
| R-096 near-expiry; R-100 bank-change cooling-off; R-103 capex committee; R-105 blacklist; R-106 invoice reader | procurement *policy*, already RULED 2026-08-27 by adopting defaults (`…14-materials-core.md:293`) | done — stale rows |
| R-018, R-028, R-030, R-037, R-088, R-090, R-092, R-093, R-142, R-161, R-199, R-202, R-225, R-229, R-236, R-242, R-244, R-248, R-249 | departmental policy | adopt |
| R-013 (fact half), R-023, R-067, R-124, R-182, R-183, R-228, R-243, R-253, R-133 | staffing: who holds which chair — the *names* are facts the owner supplies; the *shape* is standard | QM dual-hats registrar/steward/DPO; DTC chair = senior physician; hire at 300 beds |
| 18c R3 investigation level | dose policy — "the number is data, not a deploy" (`…18c…md:82`) | 1 mSv/month pro-rated |
| the 24 clinical rows (REG:284: R-005, R-011, R-014, R-022, R-039, R-042, R-057, R-060, R-070, R-109, R-166-R-168, R-170, R-175, R-179, R-180, R-200, R-201, R-224, R-233-R-235, R-238) | the medical board signs, not the owner; Class-B definitions stay drafts (RM §3 rule 2:382) | ship as draft definitions; the DTC activates once R-243's chairs are named |
| R-171 FP sterilisation; R-196 blood-bank absorption date; R-029, R-047, R-141 scope deferrals | facts or "not this quarter" | defer; ask R-171 as a fact |

**Effect:** the honest owner's register shrinks from 262 to roughly **64 money + 26 purchase + 52 legal(→ one counsel session) + 10 CA(→ one CA session) + 2 fact rows**, and of those only the rows in §2 touch this quarter's calendar.

## 6. THE OWNER'S LIST — the shortest list of acts only he can perform this quarter

| # | act | group | unblocks | by |
|---|---|---|---|---|
| M1 | **Rule GST-on-MRP is tax-inclusive** (one line), then **book the CA session** with the ten CA rows (R-255) + the real tariff → O6 | money | pharmacy G3 and seed; G7 exit from commissioning; every live invoice; P2 in-room delivery | wk 2 (treatment), wk 6-10 (session) |
| M2 | Confirm the 2026-08-18 dues/advance ruling extends to IPD deposits and give the five ladder numbers (R-148/187/195/219/220) | money | 41 authoring wk 7-9; P5 magic discharge's dues clearance | wk 6 |
| M3 | Film/CD prices (R-004) | money | 18a-iii release desk | wk 2 |
| M4 | Buy the second server (₹1.5-3k/mo) | money | Hermes T0; UAT headroom | any time |
| M5 | Inference cost cap (R-131) — accept ₹5k/day | money | 12a when DPIA signs | Q4 |
| P1 | **Decide 11b: on-prem Orthanc (18b R1) or cloud PACS (the mission)** — the one procurement that shapes P3 | procurement | 18b-ii, 49/50 | wk 7-9 |
| P2 | Sign the interaction/dose dataset licence after the RFQ (₹8-12 L/yr) | procurement | 16e = the medication-safety beta | Q4 |
| P3 | Teleradiology standby contract + DPA (R-001); TLD badge + QA contracts (18c R2, R4); MWL licences (18b R2) | procurement | 18a-iii WF-IMG-10; 18c registers; 18b-ii | wk 7-9 |
| P4 | Razorpay merchant agreement; WhatsApp/WABA + DLT registration; an Indic ASR provider with DPA | procurement | 22a, zero-wait prepaid booking; every patient message; P1 15-language speech | Q4 |
| P5 | HR SaaS choice — may stay deferred (CSV import first) | procurement | 20's sync only | later |
| L1 | **One counsel session**: DPIA v0.2 (+ STT carve-out accept/refuse, Drafter addendum, Hermes E10), R-009 retention, R-007 licence blocks, R-059 audio locus, R-126/R-254 residency, R-050 e-Rx signing, R-173/R-174 NDPS + retail licence, R-084/R-246 signatories + incapacity instrument, R-192/R-111 discharge/MCCD chain | law | everything with inference (P1, P2 ambient, P4 vision, P5 Drafter); 12a; 16d; 28a/28-G; 44 | wk 4-8 |
| L2 | File the AERB certificates (and e-LORA per device), the real PCPNDT §19 registration, MTP approved-place (R-237); produce the licence inventory (R-256) | law | radiology on production (wk 7); 15; 28a | wk 7 |
| L3 | Sign the just-culture / KPI-not-pay policy instruments (R-240, R-119) once counsel reviews | law | 28a, 21 — P5's reporting culture | Q4 |
| F1 | **O1 — name the second administrator** and create the account | fact/staffing | IPD gate; every two-key; R-247 re-ratification | wk 3 |
| F2 | State whether any real patient exists on production | fact | the catch-up deploy's announcement and hour | wk 1 |
| F3 | Hand over the lab catalogue spreadsheet + the pharmacy item master | fact | G3 lab (wk 3), G3 pharmacy (wk 4-6) | wk 3-4 |
| F4 | Name the humans: pathologist + 4 lab keys; chief pharmacist + 3; RSO + physicist; the committee chairs (R-243/R-253) | fact | G4 per department; the DTC that signs 24 clinical defaults | wk 3 / 4 / 7 |
| F5 | Collect R-257 vendor facts (analyser inventory first — 17-E T7's real instrument) | fact | 17-E on production; 49/50; 22 | Q4 |
| F6 | Deploy #73 or bin it; approve 11i; deploy production weekly by hand; create the `deploy-blocker` label | fact/act | G1 for every module; RM §0 row 10's rule | wk 1 and weekly |
| F7 | Say "adopt all defaults" for the 84 misfiled rows (§5) | — | closes 84 rows; no phase doc says "owner ruling pending" again | wk 1 |

Everything else in the 262 rows is DECIDED (§4), behind the IPD gate, or outside the quarter (RM §5).

## Facts

- Register: 262 rows; §2 counts owner-alone 174 (money 64, policy 52, purchase 26, scope 22, staffing 10), CA 10, legal 52, clinical 24, vendor-fact 2+ (REG:278-286). Nothing in the register is marked RULED in the file itself (REG:3).
- O1–O6 defined at 11f:259-277; all six NOT DONE at 11f's close (11f:545-560); production still has one administrator and 498 events, never left `commissioning` (RM §0:28; §4:397).
- `validate:config` prints `caSigned` per scope (`validate-config.ts:28-29`); every rate in `seed-tariff.ts` is a `DEV PLACEHOLDER — CA sign-off required (§19)` (:33-100); pharmacy runbook precondition 5 requires the signed slabs (`pharmacy-go-live.md:35`).
- The Plan 08 dues/advance ruling was given 2026-08-18 (P08:11-13) and shipped 2026-08-21 (SER:175); 11c re-confirmed it (`…11c…md:772`).
- DPIA file is titled v0.1 but its header says "0.2 DRAFT … not reviewed, not signed" with nine [COUNSEL] marks (DPIA:3,27,29,33,38,56,57,66-70).
- R-247 adopted as DECIDED by the roadmap; O1 leaves the lab's critical path (RM §0c.6:183-191).
- 18c is not deploy-dark: ionising studies refuse until licences are filed (RM §0 row 6:30; `radiation-safety-go-live.md:44-48`).

## Surprises

1. **The "open dues ruling" is stale.** RM §4:403 and R-252 (REG:264) list it as an open, critical-path owner conversation; it was ruled on 2026-08-18 and shipped three days later (P08:11-13; SER:175; `…11c…md:772`). What is actually open is the IPD deposit/write-off ladders — five numbers, not a ruling on the instrument.
2. **The mission and the register disagree on P3's substrate.** The mission says "eliminate traditional PACS servers … cloud"; 18b R1 recommends an on-prem Orthanc on the production box under 11b (`…18b…md:88`), and R-254 defaults to on-prem for Class-1. The 11b decision is therefore not a storage purchase but the pillar's architecture, and nobody has put the two sentences side by side for him.
3. **GST-on-inclusive-MRP is not in the register at all** and is the single live money trap: the pharmacy went live by accident with an empty shelf, and the placeholder that makes it bill correctly is scheduled to be "corrected" by O6's slab signature (memory `pharmacy-launch-2026-09-06`; `seed-tariff.ts:93`). The order must be treatment first, rates second.
4. **The register left 84 non-money/procurement/law rows plus 24 clinical rows to the owner**; the standing rule (issued 2026-08-28, a day after the register) closes them with one line.
5. **The DPIA is one document for two very different asks**: the Class-0 digest writer (harmless) and the speech carve-out (a Class-2 exception with cross-border transfer). Signing v0.2 as one instrument couples the ops copilot to the ambient co-pilot's hardest question; splitting the STT carve-out into its own addendum would let Hermes/T0 proceed on the Class-0 signature alone.
6. **O2 (credential rotation) has vanished from every later document** — no roadmap row, no census row — yet 11e's burned roster is what the first real pharmacist logs in with.
7. **R-008 files the mission's headline diagnostics (ICH, fracture, pneumothorax) as "scope, can-wait, bought never built"** — a procurement line with a rupee figure nobody has asked for, absent from RM §6.
