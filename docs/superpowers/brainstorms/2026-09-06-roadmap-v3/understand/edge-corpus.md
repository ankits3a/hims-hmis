# edge-corpus — what edge-case corpus exists, its shape, its coverage, and where the mission has no rows

Read-only, `main-ro` @ `b04cbd9` (2026-09-06). Paths relative to main-ro unless absolute. Row counts measured by grep over the section bounds named (regexes in §2).

## 0. In one paragraph

~3,100 written edge rows exist, in three generations and three grammars. Gen 1 (spec §11, Aug 10–22) is prose law: 13 exception maps + 125 swarm fixes. Gen 2 (department series, Aug 27) is the bulk: **2,915 rows in 22 docs** (≥ 106 each, 13–19 themes) + 10 cross-module chaos days. Gen 3 (11i, Sep 6) is the only corpus in the owner's norm — *scenario · expected behaviour · artefact that proves it* — and holds **100 rows (24 + 76)**, all about the stand-up path. Every mission pillar except absorption has rows only in gen 2, as "required behaviour → test" against mostly unbuilt modules; **ambient copilot, PACS-less cloud imaging, personalised monitoring, wound images, in-room delivery and 100 % real-time audit have zero rows anywhere** (the mission brief post-dates the series by ten days). The **session layer** — an AI session waking while the owner sleeps — has a rich but unshaped corpus: 11 traps + 6 stop rules in the 11i handoff, 18 LIMS traps, ~40 out-of-git memory lessons; none is a row with an artefact.

## 1. Corpora

### 1.1 corpus · 11i §2b — 24 rows, the owner's norm
`docs/superpowers/plans/2026-09-06-phase1-11i-the-stand-up-path.md:81-120`. Shape `| # | the day | modelled today | 11i answer | task |`: scenario · a cited measurement · the artefact (census row, drill, test, DECIDED line) · T1–T9. Rows the schema cannot hold resolve to the census verdict **NOT MODELLED → runbook §n** (L84–87), never silently green. Serves T2/T3/T6/T7/T9; lab seats only (pharmacy sent to 11k).

### 1.2 corpus · HANDOFF 11i §10 A–I — 76 rows
`docs/superpowers/2026-09-06-HANDOFF-commissioning-lane-11i.md:179-330`: A deploy/box 16 (L190) · B synthetic door 10 (L211) · C people 7 (L226) · D lab on UAT 9 (L238) · E 18c window 6 (L252) · F money/paper 3 (L263) · G the census itself 5 (L271) · H owner's day 3 (L281) · I third pass 17 (L289). Shape `| # | the day | what must be true | task | closes with |`, *closes with* typed **T** test · **M** mutant · **C** census row · **R** runbook step · **D** DECIDED (L183–186); ★ = found by measurement (23/76). "A row is closed when its artefact exists, not when it has been read" (L187). The only corpus modelling the **deploying agent's own failures** (A1 SSH drop mid-migration, A4 dirty checkout, A6 red main, I1 a census that writes, I13 UAT archiving WAL into prod's stanza).

### 1.3 corpus · Department series §5 — 2,915 rows in 22 docs (+ §6 chaos walkthroughs)
`docs/superpowers/brainstorms/2026-08-27-department-series/NN-*.md`, `## 5. Edge-case catalogue`. Per doc (§5 bounds): 01 radiology 138 (L188–414) · 02 lab 129 (L210–373) · 03 home care 126 · 04 physio 127 (L175–336) · 05 video 118 (L136–286) · 06 ICU 130 (L187–377) · 07 nursing 131 · 08 housekeeping 120 · 09 procurement 136 · 10 residents 125 · 11 KPI 132 · **12 copilot 106 (L111–257)** · 13 memberships 118 · 14 ED 158 · 15 OT 135 (L176–384) · 16 pharmacy 149 (L170–357) · 17 IPD 138 (L181–383) · 18 blood bank 147 · 19 support 142 · 20 front office 134 (L271–465) · 21 service lines 126 · 22 quality 150 (L183–377).
Grammar (`_AUTHORING-BRIEF.md` §5): **ID · scenario → required behaviour → test/assertion → ruling ref**, ≥ 80 rows in 13 mandatory themes (identity · timing · downtime · money · consent/MLC · staff · equipment · data quality · fraud · privacy/VIP · language · scale · integration). Three renderings: five-column tables (01/03/06/08/11/14/15/17/18/19/20/21, e.g. `15-ot-anaesthesia-cssd.md:178-182`), `- **A7**` bullets (02/04/05/07/09/10/12/16/22), numbered lists (13). The brief's Style rule ("walk the flow once more as a night-shift nurse… as a fraudster… as an auditor… as a patient who speaks only Bhojpuri… as the server going down") is the origin of the team norm. Serves plans 12a–67 — mostly **unbuilt**; the "assertion" names a test that does not exist.

### 1.4 corpus · 00-CROSS-MODULE-CHAOS — 10 whole-hospital days + 10 things the series cannot answer
`00-CROSS-MODULE-CHAOS.md`: §1 bus crash L9 · §2 3-h WAN outage + reconciliation morning L32 · §3 VIP+MLC+fraud+DPDP L78 · §4 flood+power+oxygen L102 · §5 doctors' strike L126 · §6 CRE outbreak L146 · §7 ransomware/restore day L168 · §8 NABH surprise + stock-out + critical miss L192 · §9 02:00 maternity+STEMI+blood L212 · §10 the 800→2,000 scale cliff L236 ("a prediction") · "What this series still cannot answer" L263–274. Shape: minute-by-minute with fixed sub-heads *System / Humans / Agents (and where silent) / Paper / Backfill / Audit next day / Edge rows exercised* (L5) — a **fixes index** over the department rows. The ten "cannot answer" items are edge classes without rows: floor-scoped degradation absent, no second adult, the audio ruling R-059, vendor facts, shared-component ownership, scale untested, legacy reality, CA/counsel, committees, alarm fatigue.

### 1.5 corpus · Spec §11 exception maps + swarm fixes (prose, locked)
`docs/superpowers/specs/2026-08-10-hmis-architecture-design.md`: §11.4 maps 1–13 (L269–284: downtime, newborn pairing, payer switch, bed-class, cross-consult, package overrun, re-admission, unknown patient, isolation, transfusion, day-care, MLC/unclaimed body, disaster) · §11.5 (L285) · §11.14 codes/compliance (L387–413) · §11.19-C/D/E 39+48+38 = 125 fixes (L550/L602/L662) · §11.20 "the swarm phase is closed" (L715). Governance rows that bind the missing classes: spec §16 guardrails (L774–789: fail-open, kill switch, global halt, provenance, T2–T3 clinical cap); DPIA `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md:40-52` 7 risk rows, §3-A L31 the speech carve-out ("audio cannot be de-identified"); copilot design `2026-08-25-clinical-copilot-design.md:118-135` (never auto-fired; 5 ordered activation gates).

### 1.6 corpus · Phase-doc edge passes (built modules)
07b `2026-08-28-phase1-07b-the-counter.md:238-262` 17 · 07c L228–247 12 · 07d L166–183 10 · 17 LIMS core L260–318 51 · 17 envelope L329–358 22 · 18a L354–401 40 · 17a L440–462 / 17b L461–476 prose. Shape "Edge-case pass (owner standing rule — before the doc is final)", drawn from brainstorm §5 (18a L354). These are the rows that became fail-first tests. 11i is the first phase doc in the Indian-day/artefact shape (only one hit for "Indian day" across `docs/superpowers/plans/*.md`).

### 1.7 corpus · Hermes Ops Copilot §8 — 13 rows, UNTRACKED
`/opt/hmis/docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md:205-221` E1–E13 (loop/429, key leak, owner asks for a patient, scrubber fails closed, hallucinated number, downtime, HMIS unreachable, delegate deactivated, prompt injection). No artefact column. The only rows anywhere about an owner-facing agent on a second server.

### 1.8 corpus · Lane handoff traps / stop rules — session-layer prose, ~35 items
11i handoff §5 L102–131 (11 traps: deploy.sh refuses non-main; the drill appends to the LIVE log; census reads through module exports; seeds never touch CA rows; pinned counts move; wall-clock flakes; `Math.random()` collision; web timeout budget; backticks execute; "written diagnoses go stale") · §8 stop rules L155–162 (6, incl. 200k-token stop-loss) · §7 L142–153 the only table of "what is the owner's, and when". LIMS `2026-09-04-HANDOFF-lims-lane.md:201-222` 8 (stacked PR auto-merges into its base; `--ours` drops peers' work; grep finds the NAME not the CAPABILITY; don't inherit a diagnosis; don't inherit a FIX; three-dot diff) · `2026-09-05-HANDOFF-lims-lane.md:197-215` 10. `AGENT-RULES.md` rules 12–21 (L132–207). Mechanisms outside the repo: `/opt/hmis-lanes/.orchestrator/bin/` — `board.sh` (memory, lock holder, per-lane drift/dirty/state, merge train), `test-lock.sh` (one heavy run per box), `lane-report.sh` (WORKING | AWAITING-TRAIN | IN-TRAIN | TESTING | BLOCKED | LANDED | IDLE); `tools/lane.sh:19-21,58-61` symlinks every lane's Claude memory to one directory.

### 1.9 corpus · Out-of-git memory — ~40 session-layer lessons
`/root/.claude/projects/-opt-hmis/memory/MEMORY.md` (102 files): stacked PRs (L41), CI twin runs + no rerun (L53), written diagnoses go stale (L68), wall-clock flakes (L75), two-dot diff phantom deletions (L78), mis-aimed instruments (L82), **a test executed deploy.sh and deployed production** (L92), stacked migration journals (L103). Prose lessons; not rows; not in git; shared across lanes by the symlink. `/opt/hmis-context/plan-09-brainstorm-2026-08-25.md:105-187` §4 is the brief's named format precedent.

## 2. Shape — three grammars, one norm

| generation | grammar | artefact column | count |
|---|---|---|---|
| spec §11 | prose law | none | 13 maps + ~30 items + 125 fixes |
| department §5 | ID · scenario → behaviour → **test/assertion** → ruling | a test that does not yet exist | 2,915 |
| phase-doc passes | scenario → behaviour → test in this phase | a fail-first test | 152 |
| **11i §2b + §10** | the day · modelled today · answer + task · **closes with T/M/C/R/D** | typed; must exist to close | 100 |
| Hermes §8 / traps / memory | bullet lesson | none | 13 / ~35 / ~40 |

Regexes over `## 5`→`## 6` bounds: table, bullet and numbered ID forms; an ID count, so a packed row (21 M-1) counts once.

## 3. Classes covered — one example each

- **class-covered · power/network/server down** — §2b 16 (internet drops at the desk → drill D); §10 A12; chaos §2 L32; 15 C4 gap rendered UNAVAILABLE (L219); spec map 1 L271.
- **class-covered · licence expiry** — §10 E2 (wrong expiry year; surrender is terminal), E5; chaos §8 fire NOC L203; 03 E-5.
- **class-covered · cash / money / CA-gated** — §2b 9–11 (GST-exempt lab, mid-FY series, ₹2.1 L cash §269ST); §10 F1, I3, I4 (₹0 price); spec §11.19-C-2.
- **class-covered · duplicate / wrong patient** — §2b 1, 4; §10 D9; 20 ID-1..6 (L278+); 02 A1/A2 chair scan (L215); 15 A1–A3 (L184–186); spec map 8.
- **class-covered · night without a pathologist / consultant unreachable** — §2b 6, 18; §10 D4, I5; `docs/runbooks/lab-go-live.md:223` drill A; chaos §9 L212; 17 G2 (L295).
- **class-covered · deploy day / the box** — §10 A1–A16, I12–I17 (SSH drop, disk full, dirty checkout, red main, tag collision, port held, TLS, Bearer swallowed, cursor burst, unset target, backout on NOT NULL, renamed role key).
- **class-covered · staff absent / overload** — chaos §5 L126; 17 G3 (L296); §10 C3; every doc's theme F.
- **class-covered · language** — §2b 21; 05 E17/K1/K4 (L209/L262/L265: Bhojpuri, 20-s consent clip, voice note unprocessed until the audio ruling); 02 K1 (L333); 17 L2 O-9 (L352); 12 K3 dictation (L210).
- **class-covered · paper fallback / backfill** — §2b 15; §10 I8; chaos §2 reconciliation table L58–72; lab runbook §8 L184; map 1 "an outage can never become a leakage window".
- **class-covered · machine down** — §2b 14–15; 15 C3/M6 (L218/L377); 01 G6/M1/M3 (L348+); 02 C3 (L242).
- **class-covered · law** — spec §11.14, §11.19-C 1–6; 15 E5 RTA "no police" (L257); chaos §3 L78.
- **class-covered · agent runtime** — 12 D1–D5 (provider 5xx, 45-s latency, model deprecated/silently updated, router), E1–E5 (loops, ₹2.1 L bill, retry storm), H1–H5 (human-vs-agent race, tier creep, tool-chain escalation), L1–L5 (nudge budget, fast-sign, liability, "sign as AI" impossible) — L148–222.
- **class-covered · synthetic vs prod** — §2b 22–23; §10 B1–B10.
- **class-covered · the census lying** — §10 G1–G5, I1–I5.

## 4. Classes MISSING — by pillar / milestone

"Missing" = no row whose scenario is about the pillar's *mechanism*; nearest neighbours cited.
- **class-missing · absorption G5–G7 + weekly deploys** — G1–G4 dense; G5 = T6. No row for the pilot week itself (paper vs screen disagree; staff stop entering; harvest unread; a real patient in the shadow window beyond §10 H3's wording), G7 exit with a visit in flight, a deploy during a pilot, a second department opening beside a piloting one (§10 F3 "not this phase"), training-day resets.
- **class-missing · ambient copilot** — zero rows on ambient listening. Nearest: 12 K3, DPIA §3-A, 05 K1, copilot §2.5 "never auto-fired". None on room consent, multiple speakers, attribution, "stop recording", MLC statements, drafted Rx vs a spoken allergy, mic/network loss mid-consult, priors from the wrong UHID, R-059 pending (chaos L266).
- **class-missing · zero-wait scheduling** — 20 has overbooking (TM-5 L296), follow-up caps (FR-3 L399); chaos §10 delay declarations. None on a wrong prediction, visit-type mis-class, a visible re-order, holiday priors, a chronically late doctor, walk-in fairness.
- **class-missing · in-room delivery** — 02 chair/bedside (A1/A2/C3/D1); 16 M9 cold chain (L323). None on a phlebotomist inside an occupied room, no printer in the room, stock-out runner, H1/NDPS from a room, room payment, patient gone before delivery.
- **class-missing · fibre-to-cloud radiology** — all 138 rows in 01 assume on-site Orthanc (A2 L197, C9 L234, G6, L1 L348). None on a fibre cut mid-scan, cloud outage in a trauma, upload saturation, DPDP cross-border DICOM, AI wrong on ICH, AI before the human read, AI on a mismatched study, SaMD status, outside priors, 4G night reads, cost per study.
- **class-missing · dynamic OT** — 15 has overrun cascade (B2 L200), race (B1), pre-emption (B3), reserve (B9); optimiser silent in disaster (chaos §1). None on moving a pre-medicated case, surgeon refusal, dirty-before-clean, loaner timing, anaesthetist reassigned by an agent, T3 at 03:00 with no approver, a relative told a moved time.
- **class-missing · personalised monitoring** — 06 C-6 telemetry gap (L227), D-5 oxygen; no row says "baseline". None on a baseline from the wrong patient/bed, learned during deterioration, the athlete's HR 42, a suppression preceding an arrest, a beta-blocker shift, no history at admission.
- **class-missing · wound images** — 03 D-9 photo sync (L235) only. None on wrong wound/person, blur, no smartphone, "infected" at 23:00, false reassurance, faces/tattoos retention, consent, minors, the T2 cap on patient-facing wording.
- **class-missing · physio trajectory** — 04 H2/H3 (L269–270) only. None on missed-session vs true deviation, inter-rater variance, home exercise, comorbid curves, outside centres.
- **class-missing · magic discharge** — 17 D5 drafter timeout (L241), G2, I1, L2 (L352), M2. None on clearance with a pending result/return/TPA final, generation before confirmation, plan change after confirm, LAMA/death, a clearance with no night holder, downtime.
- **class-missing · 100 % real-time audit** — 22 G-8/Q-5 samplers, I-5 completeness (L272), J-1 integrity (L279). None on an uncodified protocol, a rule that flags 100 %, protocol version change, sealed/MLC records, court evidence, auditing a copilot draft, just-culture mid-consult, "show me 100 %".
- **class-missing · multilingual speech (15 languages)** — Hindi/Bhojpuri screen + print rows exist. None on ASR mis-hearing a drug name by accent, a language off the list, transliterated names vs the ID, TRAI DLT per language, printer script rendering, digits.
- **class-missing · the SESSION LAYER** — prose only (§1.8–1.9). None on stale docs, concurrent writers, a red main at night, a lane holding memory, a PR nobody merges, a pending ruling, the orchestrator dying, the memory symlink, an accidental deploy (memory L92 — it happened).

## 5. Candidate rows — §2b format, marked by pillar (75)

**scenario · expected behaviour · artefact that proves it.** Proposals; nothing ruled; laws cited where they bind.

### Absorption track (G5–G7, 11k, weekly deploys)
- **AB1** Pilot day 3: paper register 41 lab orders, system 33 · the harvest prints the gap; > 10 % is a seat defect, never "training" · runbook §9 row `paper_vs_system`, dated daily.
- **AB2** "Seven empty harvest days" signed; nobody opened the harvest · reading is an event with the reader; G6 closes on seven read rows · `pilot.harvest_read` count.
- **AB3** A real patient pays cash in the shadow window · paper receipt authoritative; the system receipt prints COMMISSIONING on its face · template test while `ops.mode = commissioning`.
- **AB4** G7 exit at 10:00 with three consults open · `commissioning → ramp` refused while any encounter is `in_consult`; runbook says "between sessions" · transition-guard test + runbook line.
- **AB5** A tariff edit lands the day after `validate:config` ok · the mode row carries the config hash; mismatch = RED hospital census row · census row `config_hash_matches_mode`.
- **AB6** Second weekly deploy during the lab pilot · in the runbook window (after 21:00 IST); the harvest marks the deploy day; an open `deploy-blocker` holds the tip (§10 A6) · runbook step + label check.
- **AB7** T9 redirects removed while a desk still bookmarks `/counter/seat` · the removing PR reads Caddy 404 counts on the three paths first · counts in the PR body.
- **AB8** Pharmacy opens on UAT (11k) while the lab pilots on production · the seat drill quotes a real MRP/NPPA row; a placeholder GST slab refuses the drill's invoice · census row + drill transcript.
- **AB9** `uat-reset.sh` fires while a trainee is mid-walk · refuses if a session was active < 10 min ago unless `--force`; banner shows the reset time · guard test.
- **AB10** The owner's hotspot dies between runbook steps 6 and 7 · every step re-entrant; the runbook says which are safe to repeat · "safe to re-run" column.

### Ambient AI co-pilot (T2 cap; DPIA §3-A; R-059 pending)
- **AM1** Patient says "don't record this" · one key stops capture; the note shows `ambient: stopped 10:42`; consent state decides keep/discard · event + consent row.
- **AM2** Mother with two children in the room · the assembler binds to ONE open encounter; utterances are never attributed to persons; two open encounters → draft refused · fixture.
- **AM3** The relative answers everything · each claim carries `reported_by: attendant`; the doctor sees the source before signing · provenance field (copilot "typed claims").
- **AM4** Doctor says "amoxicillin"; patient said "penicillin rash" · the Rx line's allergy warning comes from the deterministic engine (formulary §1.3), never the transcript · issue-time check test.
- **AM5** Mic dies at minute 4 · the card stays complete; a gap band, no interpolation (15 C4 shape) · `UNAVAILABLE` render test.
- **AM6** Network drops mid-stream · the doctor writes by hand; the partial draft is discarded, never merged later (backfill rule, chaos §2) · no `draft.created` after `downtime.declared`.
- **AM7** Priors show the other Ram Kumar's HbA1c · Lens keys on the encounter's UHID; `duplicate.suspected` blanks priors and says why · fixture.
- **AM8** An MLC patient describes the assault · transcript = restricted legal document (map 12); ambient off for MLC encounters until counsel rules · encounter-flag gate test.
- **AM9** Draft signed in 4 seconds · fast-sign diagnostic to HOD (12 L2), never a block · report row.
- **AM10** A DSR asks for "everything you hold" · audio is not stored (DPIA §3-A); the transcript is; the export shows both · DSR export test.
- **AM11** Bhojpuri consult, ASR hinted `hi` · unparseable → transcript shown, asks (12 K3); each draft line carries `asr_confidence` · field rendered.

### Zero-wait dynamic scheduling
- **DS1** Predicted 12 min, actual 55 · display shows the prediction's age and queue position, never a promise; > 20 min triggers a delay-declaration task · `delay.declared` vs breaches.
- **DS2** `follow_up` slot; it is a post-op review with a dressing · one-tap re-class extends the slot; the mis-class is a KPI row, not a penalty · re-class event.
- **DS3** Token moves from 4 to 7 · one-line reason on the display; tokens only, never names (§11.5) · display snapshot test.
- **DS4** Dr X is always 40 min late · the predictor uses it; the digest names it as diagnostic (R-115 shape) · digest line.
- **DS5** Diwali eve, 20 % no-show · calendar-aware no-show prior is config, not a learned surprise · holiday fixture.

### In-consultation service delivery
- **IR1** Phlebotomist at room 3 while the next patient is inside · ante-room by default; in-room only when the room state is `free` · room-state gate test.
- **IR2** No printer in the room · 02 A1 still binds: label at the nearest registry printer; tube unlabelled until scanned · `label_source` never `handwritten`.
- **IR3** Drug not in stock; runner returns empty · line flips to `dispense_pending` with counter fallback, visible before the patient leaves · event + cockpit render.
- **IR4** Schedule H1 in the room · the H1 register row is written on the pharmacist's verification, not the runner's; NDPS never in-room (16 M9) · register test + category gate.
- **IR5** Payment in the room · UPI link from the doctor's screen; no cash in rooms (DECIDED, corporate standard); §10 D7 untouched · tender assertion.
- **IR6** Patient gone before the runner · task times out to the counter; the charge waits for `dispense.handed_over` · gate test.

### Fibre-to-cloud radiology
- **CR1** Fibre cut mid-scan · modality stores locally; console shows `uplink: down since 10:05`; nothing shown as "sent" · heartbeat event + banner.
- **CR2** Cloud outage during a trauma read · the edge box keeps 48 h; ED reads on the console; `study.uplink_failed` ages on the census · retention test.
- **CR3** 60 GB/day saturates the uplink · per-study upload SLA is an active alert (Bandwidth Forecaster) · SLA breach event.
- **CR4** AI says "no ICH"; the radiologist finds one · AI read `UNVERIFIED` until signed; disagreement is a register row, never an overwrite · `ai_read.disagreed`.
- **CR5** AI result before any human read · ED sees "AI prelim, unverified" only if the pack allows; never a patient · per-role visibility test.
- **CR6** AI on a study matched to the wrong patient (01 A2) · annotation cannot open on an unmatched study · assert.
- **CR7** Cloud region outside India · DPIA names the region; DPA on file; census row `imaging_cloud_region = IN` RED otherwise · census row.
- **CR8** The AI is a SaMD · CDSCO status + version pinned; a version change is change-class B (12 D3) · register row.
- **CR9** Night read on 4G · lossy preview stamped `preliminary`; the final read needs the full study · stamp test.

### Dynamic OT
- **OT1** Optimiser moves case 4 forward; the patient was pre-medicated · a case in `holding` or later is immovable by an agent · transition-guard test.
- **OT2** Surgeon refuses the rebalance · proposal withdrawn (12 H1); refusal is a reason row · `proposal.withdrawn`.
- **OT3** Infected case placed before a clean one · dirty-last is a hard constraint in the definition; no violating proposal is generated · property test.
- **OT4** 03:00 emergency insert, no duty manager awake for T3 · dead-end for inserts is the on-duty anaesthetist (DECIDED); everything else waits · ladder test.
- **OT5** Relative told 14:00; case moved to 16:30 · family display and template update from one event; no agent contacts a family (chaos §1) · send count.

### Personalised monitoring · Wound images · Physio
- **PM1** Baseline learned from the previous bed's patient · baseline binds from `bed.assigned`; earlier readings excluded · fixture.
- **PM2** Baseline learned during deterioration · bounded window; intensivist confirms (`baseline.confirmed`); unconfirmed never suppresses · confirm gate.
- **PM3** A suppressed alarm preceded an arrest · the suppression register shows who confirmed what (12 L3 liability shape) · register export.
- **PM4** Beta-blocker started · a drug event re-opens the baseline for confirmation · fixture.
- **WI1** Photo of the wrong wound or a relative · discharge QR/wristband in frame or `unverified` → a nurse calls · verification flag.
- **WI2** "Possible infection" at 23:00 · task to the on-call nurse via the ladder; the patient sees "a nurse will call", never a diagnosis (T2 cap) · patient-string test.
- **WI3** "Healing well" and the patient stops dressings · the app never says "fine"; every result ends with the follow-up date · template test.
- **PT1** ROM deviation after two missed sessions · `missed_sessions` is a recall (map 11), not a clinical alert · alert-class test.

### Magic discharge · 100 % audit · Multilingual
- **MD1** Summary generated with a critical result pending · draft lists pending results; cascade cannot reach `cleared` while one is unpublished · gate test.
- **MD2** Pharmacy return undone; billing clearance auto-processed · clearances are held tasks (17 M2); auto only under a zero-balance rule · fixture.
- **MD3** Plan changed after "confirm" · confirm is versioned; a new draft supersedes with a diff · provenance diff.
- **AU1** No codified protocol for the condition · audit shows `no_protocol`, counted as coverage — never "compliant" · KPI row.
- **AU2** A wrong rule flags 100 % · > 30 % flag rate auto-demotes to `diagnostic` and pages the QM · demotion event.
- **ML1** ASR hears "Amlodipine" as "Amitriptyline" · drug names resolve only through the formulary picker, ASR string shown beside · picker test.
- **ML2** Consent language nobody on staff reads · form in the patient's language with audio; witness mandatory (03 C-9) · i18n + witness test.

### The SESSION LAYER (an AI session wakes; the owner is asleep)
- **SL1** The session measures against `/opt/hmis`, 90 commits behind · first command `git fetch && git rev-parse --short origin/main`; a claim without a SHA is not a measurement · SHA in the report header.
- **SL2** A phase doc says "not built"; it merged last night · re-grep the CAPABILITY, not the NAME (LIMS §6.3; memory L68) · the grep in the report.
- **SL3** Two lanes edit `router.tsx` · board DRIFT/DIRTY; the second lane rebases and PROVES peers' hunks survive (LIMS §6.2) · parity assertion in the PR.
- **SL4** `main` red at 02:00 · merges and deploys freeze (§10 A6); the pusher fixes; nobody works around · CI run id in the lane report.
- **SL5** A lane idles holding 4 GB · `board.sh` shows it; the orchestrator drops it; a lane with uncommitted work is never dropped — reported BLOCKED · board row + state file.
- **SL6** A PR unmerged 3 days · `AWAITING-TRAIN` > 24 h is a digest line; a stacked PR is never armed before its base (LIMS §6.1) · lane-report age.
- **SL7** A money/law ruling is pending · stop at the ruling, record the corporate-standard default, continue elsewhere; name R-nnn/O-n · phase doc §7 row.
- **SL8** The orchestrator dies mid-train · `MERGE-TRAIN.md` on disk; any session resumes from it · file exists, dated.
- **SL9** A lane writes a wrong "FIXED" into the shared memory (`lane.sh:58-61`) · entries carry SHA + date; re-measure before acting on FIXED (memory L52) · SHA on the entry.
- **SL10** A test executes `deploy.sh` and deploys production (memory L92, 2026-09-06) · a guarded script cannot reach anything real from inside jest, independent of the guard · script refuses under `NODE_ENV=test` (test).
- **SL11** Context budget exhausted mid-task · 200k stop-loss (handoff §8); §8 CLOSE carries state; the successor's prompt names the handoff first · stop-loss line.
- **SL12** CI cannot be re-run by an agent (memory L53) · a stale red clears by a NEW run: empty commit or `update-branch`; say which · run-id pair.
- **SL13** "Green" claimed, not run · rule 12; counts + SHA pasted; a count without a command is not evidence · finish block.
- **SL14** The session is asked to deploy · never an agent's act; write the runbook step and stop · refusal in the report.

## Facts
1. Department series §5 = **2,915 rows** across 22 docs (min 106 in doc 12, max 158 in doc 14); the brief required ≥ 80 per doc in 13 themes.
2. Rows in the owner's norm: **11i §2b 24 + HANDOFF §10 76 = 100**, all lab stand-up and the box; §10 types the artefact (T/M/C/R/D), 23 rows ★ measured.
3. Phase-doc edge passes: 07b 17, 07c 12, 07d 10, 17 51, 17 envelope 22, 18a 40 — the rows that became tests.
4. `00-CROSS-MODULE-CHAOS.md` is a fixes index (each scenario lists the department row-ids it exercises) and names 10 classes the series cannot answer (L263–274).
5. Spec §11: 13 locked maps (L269–284) + 125 swarm fixes; §11.20 declares the swarm closed and hands residual risk to "commissioning/ramp mode… the golden suite… the owner's review rounds" (L717).
6. Zero rows anywhere on ambient listening, PACS-less cloud imaging, personalised baselines, wound images, in-room delivery, 100 % real-time audit (§4).
7. Session-layer knowledge is prose only: 11 traps + 6 stop rules (11i handoff), 18 LIMS traps, AGENT-RULES 12–21, ~40 memory files; mechanisms at `/opt/hmis-lanes/.orchestrator/bin/` and `tools/lane.sh` (shared memory symlink L19–21).
8. Hermes §8's 13 rows are the only rows about an owner-facing agent; the file is untracked.

## Surprises
1. **The corpus is inverted relative to the mission**: 2,915 rows for departments mostly unbuilt, 100 for the path in execution, 0 for the six pillars the brief leads with.
2. **Radiology's 138 rows all assume on-site Orthanc** (01 A2/C9/G6/L1/M3); the mission says eliminate PACS servers. No row records the contradiction.
3. **The department "assertion" column is fiction by design** — a test that will exist; 11i's artefact must exist to close. Same-looking grammars, opposite meanings about evidence.
4. **R-059 (the audio ruling) gates four pillars at once** (ambient, multilingual speech, dictation, handover narration; chaos L266), and DPIA §3-A is still "pending owner accept/refuse".
5. **Session-layer failures already happened and have rows nowhere**: a test deployed production (memory L92), `--ours` dropped peers' work (LIMS §6.2), two sessions inherited a wrong diagnosis (LIMS §6.6).
6. `lane.sh` shares one memory directory across lanes (L19–21, L58–61): a wrong "FIXED" from any lane reaches every lane the same night; nothing guards it.
7. The scale scenario (chaos §10 L236) is "a prediction"; every perf fixture it names is deferred by ROADMAP §5 (L412–433).
