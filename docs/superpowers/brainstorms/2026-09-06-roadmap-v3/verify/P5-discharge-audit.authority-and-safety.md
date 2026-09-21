# VERIFY — P5-discharge-audit · lens: AUTHORITY AND SAFETY

Target: `wf/design/P5-discharge-audit.md`. Sources read on `main-ro` (checkout tip `ff07cbc`; the register, spec §16, DPIA and roadmap are unchanged from `b04cbd9` — register rows still sit at line 12+nnn, verified for R-192 at :204). Abbreviations as in the target. REG = `docs/superpowers/brainstorms/2026-08-27-department-series/00-OWNER-RULINGS-REGISTER.md`; SPEC = `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md`; DPIA = `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md`; RM = `docs/superpowers/2026-09-06-ROADMAP-v2.md`; P15 = `docs/superpowers/plans/2026-08-28-phase1-15-mini-ot-daycare.md`; KD = `docs/superpowers/plans/2026-08-28-phase1-kernelD-document-chrome.md`; IPD = `…/17-ipd-adt-bed-mrd.md`; core = `apps/core/src`.

**Verdict: NEEDS-AMENDMENT.** Nothing kills the design: the shape (E1+E2 this quarter; E3–E5 behind dated gates; every inference last and named) is the roadmap's own. But ten amendable breaches of decision hygiene and agent law, none cosmetic. What is clean is listed at the end so the next pass does not re-check it.

---

## 1. Lens (1) — DECIDED that is actually money / procurement / law

### A1 · D9 activates a Class-B clinical-safety definition under the wrong authority — AMEND
- D9: "The mini-OT opens under R-247 honesty mode (MS publishes …)"; E1 gate G2: "the MS publishes the DD6 drafts under single-approver honesty (R-247…)"; E1-M3 human act: "the MS publishes the drafts on UAT (R-247); the owner names three OT holders" (ot_incharge / recovery_nurse / anaesthetist — no department head).
- The OT's `criteria` definitions (procedure whitelist, ASA ≤ II, age, escort) are **Class B** by the spec: SPEC:460 "case-selection criteria are governed definition data, Class B". SPEC:623 fixes Class B's approver pair: "**department head + duty approval**", and says "the taxonomy itself is Class A" (the owner's).
- The register has an explicit row for exactly this: **R-170** (REG:182) "Day-care case-selection criteria (Class B) — … escort mandatory — **owner + department heads approve before activation** (§19 gate) · clinical · Blocks 15 · **pre-pilot**". The design never cites it.
- R-247 (REG:259) is not about this: its text is "single-approver honesty mode until runbook O1 closes … re-ratify **Class-A** definitions by two keys within 30 d of O1", Blocks `28a, 12a`. It carves out the missing *second administrator*; it does not replace a department head. RM:186-191 adopted it for the lab, whose separation is technologist/pathologist (four role keys), not a Class-B activation.
- P15 already measured the gap: P15:201 "`department_head` is unseeded with zero holders, so **a Class-B definition has no lawful approver pair on production today — this phase publishes nothing Class B** (DD6 routes `ot_definition_publish` through the approvals engine with `medical_superintendent` as approver, not through `CHANGE_CLASS_POLICY.B`)". D9 makes that interim posture permanent and carries it to the production pilot (E1-M5), where real patients are selected for day-care surgery by criteria one MS activated.
- **Amend:** cite R-170; the approver pair for `criteria` is MS + the surgical/anaesthesia HOD (`department_head`), i.e. add a department head to NEW-P5-2's names, and E1-M3's acceptance gains "`department_head` held · `seed-roles` READY · ≥ 1" before any Class-B publish on UAT. R-247 stays cited only for the second administrator (Class-A re-ratification ≤ 30 d after O1, which the design already says).

### A6 · D2 lets a rule sign a money gate on the wrong condition — AMEND
- D2: "A zero-balance billing clearance … auto-satisf[ies]". The cascade's billing clearance is not a balance check: IPD:104 `billing_pending_charges (orphan check)`; SPEC:256 step 4 "**no-pending-charges gate** — every department one-click confirms". A zero balance with an un-posted charge is precisely the leakage the Leakage Auditor exists for (SPEC:783 "orphan offenders").
- Money-gate auto-satisfy rules are Class A: SPEC:623 "Class A — clinical-safety, **money rules**, statutory/sealed config: owner + medical-superintendent two-key". A design doc may shape it; it cannot DECIDE its activation.
- **Amend:** D2's condition = "the orphan scan for the encounter is empty" (E2-M5's widened `charge.orphan_flagged` is the instrument the design already builds), never balance; balance/dues stay on R-195 → R-252's Plan 08 path; note the rule is a Class-A definition activated by two keys.

### N3 · D10 touches R-058 (money) — NOTE
- D10 "Recall = the review date, else day 7". REG:70 **R-058** "Post-discharge tele programme paid or free — Free nurse touchpoints 30 d post day-care/IPD; tele doctor review at follow-up rate · money". D10 should say the day-7 review is the package's included visit (standard) and cite R-058 for anything beyond it.

### N9 · D12 `record_only` countersign clock through the pilot — NOTE
- R-192 (REG:204) is `legal`: consultant countersigns ≤ 24 h. D12 keeps the clock `record_only` until after E4-M6's production pilot. Defensible under G6 "paper authoritative" (RM:365) only because E4-M6 reads countersign share daily; write that dependency into D12 so the clock's silence is a read line, not a blind spot.

### N10 · E1-M5 pilot before O6 — NOTE (sound, say it)
- A production pilot with placeholder tariff is RM:365 G6's own law (shadow, paper authoritative) and RM:339 (exit from commissioning only on O6). Sound. Add one sentence: no system-generated invoice or message reaches a patient during G6; the slip and bill the patient holds are the paper ones.

---

## 2. Lens (2) — rulings sent to the owner that the standing rule says to DECIDE

### A7 · R-119 is register-category `policy`, not law — AMEND
- Design RULINGS row: "R-119 · KPI-linked pay forbidden · **law** (a policy instrument the owner signs) · unblocks E5-M5; Plan 21". REG:131: category **`policy`**. The standing rule (CONTEXT:27) reserves rulings for money/procurement/law. The design already applies it by construction (D13, edge 27). Listing it as a ruling adds a false owner gate on E5-M5 and Plan 21.
- **Amend:** move to DECIDED ("R-119's default adopted; no per-person aggregate exists by schema"); the owner signs the HR policy *text* at 21/28a authoring (IDX:207 risk 13), not as a gate on this pillar.

### A8 · NEW-P5-1 has a ₹0 default — DECIDE it, defer only the purchase — AMEND
- "Machine-readable protocol source: licensed content or in-house SOPs … procurement · in-house SOPs first (₹0, DTC-signed)". A ₹0, in-house default is exactly what the standing rule says to DECIDE. Precedents: R-260 (REG:272, `scope`) the Expertise store; **R-044** (REG:56, `purchase`) "Ship free scales …; licensed scales on the §19 knowledge budget line"; RM:449 names the interaction/dose dataset licence (₹8–12 L/yr) as the shape of a content purchase.
- **Amend:** D21 "First five clinical rules from DTC-signed in-house SOPs via the Expertise store (R-260); licensed content is a purchase on the §19 knowledge budget line (R-044 pattern), raised only when a service line names it." Keep a one-line deferred procurement row.

### N1 · Facts are not rulings — NOTE
- The RULINGS header reads "money / procurement / law / **facts the owner holds**" and carries O1 ("fact (staffing)") and NEW-P5-2 (three names). RM:452: "**Two facts, not rulings**, are the owner's to state in a line each." Split the table: RULINGS (R-nnn/O6) vs FACTS (O1, names — now including a `department_head`, per A1).

### N2 · NEW-P5-3 duplicates an existing deferred decision — NOTE
- SPEC §19 (line ≈826) already lists "WhatsApp Business API / SMS / IVR provider selection (gateway module spec)". Cite it rather than mint a NEW id; and name the messaging law the channel inherits: R-020 (REG:32, legal: templates only to patients), R-249 (REG:261: post-discharge WhatsApp, patient language, opt-out honoured), R-114 (REG:126: no PHI on WhatsApp once in-app handover is live).

### N4 · R-252 is the parent of R-148 / R-195 — NOTE
- REG:264 R-252: "Rule Plan 08's dues item first; R-002, R-148, R-195 inherit it"; RM:404 lists the Plan 08 dues/advance ruling as YES on 41's critical path. Cite R-252 on the money row so the five ladders are asked in the order the register set.

---

## 3. Lens (3) — tiers, DPIA-before-inference, fail-open, kill switch, API-only, provenance

### A2 · E4-M5's gate is not the Class-1 gate — AMEND
- E4-M5 gate: "DPIA v0.2; 12a; R-126"; dependency "DPIA v0.2". The Drafter consumes Class-1 patient context (IPD:461, DPIA class 1). DPIA v0.2 as drafted does **not** cover it: DPIA:15 "Future stages (**not activated by this DPIA**; each triggers a DPIA revision): T2 clinical drafters consuming Class-1"; DPIA:24 "**L1 (future revision):** before any Class-1 request flows, this section is expanded with re-identification risk analysis, the chosen provider's processing locations, and DPDP §16 transfer analysis"; DPIA:37 lawful basis for Class 1 is `[COUNSEL]`. The design's own RULINGS row says "split the STT carve-out so Class-0 signs alone" — which makes v0.2 a Class-0 signature and leaves the Drafter unsigned.
- Uncited legal row: **R-128** (REG:140) "Consent posture for AI-assisted care — Named in DPDP notice + general consent; **per-patient opt-out honoured for Class-1 runs**; no per-encounter consent — counsel confirms · legal · 12a · **pre-pilot**". Shadow on production (30 consecutive drafts) is a Class-1 run on real patients; opt-out must be honoured before the first one.
- Missing acceptance: DPIA:20 "automated tests assert request bodies contain no identifier fields" — E4-M5 has provenance, kill switch and citation guard, but no identifier-absence test on the request body.
- R-006 (REG:18, legal): patient-language AI summaries deferred until 90 d of edit-distance data; "English signed copy governs". E4-M5's edit-distance hashes are that data — so the shadow Drafter drafts English only and the Hindi patient copy stays a deterministic template (which D11 already does for the slip); say it.
- **Amend:** E4-M5 gate = "DPIA Class-1 revision signed (DPIA:15,24,37) · R-128 opt-out honoured · R-126 locus ruled · `complete()` landed · 12a harness"; acceptance += "request body carries no identifier field · call-site test · 0"; scope line "English draft only; Hindi copy deterministic until R-006's 90 d".

### A3 · Five automations and one T4 with no off switch, and no harness — AMEND
- SPEC:780-781: automations "run… under the agent harness (identity, **kill switch**, heartbeat, mode/backfill gates, tier)"; SPEC:786: "**per-agent kill switch**, instant, itself evented … **global halt** — one flag pauses every agent and automation". Q22:541 (28's own precondition): "12a harness shape settled (provenance, kill switch) even if inference off".
- In code: `agents.killSwitch` exists but bites only `x-agent-key` callers (`core/kernel/auth/guards.ts:51`; `agents.ts:17-26`); worker jobs have no switch; **no global halt exists** (grep of `kernel` for global halt/halt-all: empty). The design adds the recall writer (T1), the fact-sheet job (T0), the refusal-twin lint (T0), the evaluator (T0/T2-capped), the Chaser-as-ladder, and names the Turnover Dispatcher (T4) — none with a named off switch; RM:428 "No 12a agent runtime" this quarter or next.
- The T4 row: IPD:458 gives its manual path ("supervisor manual assign"), kill scope (per-agent) and ship home "**Plan 20 (w/ 19)**"; RM:414 says 19 is not built this quarter; E4-M3's "bed `dirty → available` via `task.verified`" names a task primitive the kernel does not have (CONTEXT:46, PR #164).
- **Amend:** (i) every automation this design adds ships behind a `*_ENABLED` config flag, inert by default, the `RETENTION_ENABLED` precedent (`core/kernel/config.ts:114-123`), with the toggle evented — that is the kill switch until 12a's harness exists, and the design says so in each E-M row; (ii) E4-M3's first cut is the roster's manual path (housekeeping marks the bed available in the registry, evented); the T4 Dispatcher is a "later" line gated on 19/20 + 12a; drop `task.verified`.

### A4 · The recall writer can block a discharge, and sends a patient message without the consent P15 built — AMEND
- Fail-open: `enqueueNotification(tx: Tx, …)` runs inside the caller's transaction and **throws** on a patient-audience template with no `patientId`, on a `userId` mismatch, on an unregistered key, on a promotional class (`core/kernel/notify/enqueue.ts:68-100`). P15:156 places the recall inside `dischargeDaycare`. If E1-M1 writes the row in the discharge `withTx` (`recovery.ts:447`), any throw aborts the discharge — SPEC:786 "an agent erroring or offline never blocks a human flow". The design does not say where the writer runs; no edge row covers it (edge 13 covers only the printer).
- Consent and channel: P15:190 ruled "The follow-up recall task in DD10 is a **TASK, not a message** … **No `enqueueNotification` call** … `notifyOk` is captured with it so the consent exists the day the channel does" — the flag is on the row (`core/kernel/db/schema/ot.ts:198-199`; `modules/ot/gates.ts:88`). The design converts the task into a `notifications` row keyed `daycare_followup` and never reads `notifyOk`. (The task→message conversion itself is right — CONTEXT:46: there is no task primitive — but it makes this a patient-data flow over a channel, which brings R-020, R-249, R-114 and SPEC:773's per-patient language preference, none cited.)
- Instrument: `NOTIFY_PROVIDER`'s enum "has exactly ONE member today" — `console` (`core/kernel/notify/pump.ts:77`; `config.ts:61`; `adapters.ts:50-63`). E1-M5's "recalls · `notification.sent` per row · ≥ 95 %" reads green on production with zero messages reaching anyone.
- **Amend:** the recall is a **consumer** of `daycare.discharged` / `daycare.absconded` in its own transaction (the fail-open lint's shape: no human path awaits it); it honours `escort.notifyOk` / the patient's opt-out and language; `notifyOk=false` or no phone → the slip carries the date and the row is `suppressed` (`notify/events.ts` already has it); add edge row "enqueue throws at discharge → discharge completes, recall row absent, sheet counts it"; E1-M5's instrument becomes `notifications` rows by status, with the real adapter named (SPEC §19 / N2) before `sent` means anything.

### A5 · E5-M2 processes staff behavioural data on production before the addendum — AMEND
- E5-M2 "Evaluator → deviation → named reviewer (shadow) · G1–G4". G1–G4 are production gates (RM:359-362: G3 "never a seed on production", G4 `/admin/users`). A deviation task on production names a real clinician's act. DPIA:38 flags staff behavioural data "**for review now**"; R-118 (REG:130, `policy`, pre-pilot) requires a written staff notice; R-122 (REG:134) is the precedent shape: "**Flag-inert until staff notice live, opt-in UI, DPIA line signed**". The design puts the addendum at E5-M5 (pilot), one milestone late.
- **Amend:** E5-M2 on production is flag-inert until the staff notice (R-118) and the DPIA staff-data line are signed; its shadow runs on UAT (G5) with synthetic data until then. §0.8 "an addendum before E5 pilots" → "before E5-M2 on production".

### A10 · The "one patient-day reconstructed · script" is a Class-2 read outside RBAC — AMEND
- E5-M2 / edge 26: "one patient-day reconstructed end-to-end from events, rules and tasks · **script**". A script on production reads identified health data with no actor, no permission string and no PHI-log row; the kernel has the log (`core/kernel/phi/audit.ts`, `PhiSurface`). Run by a session it is an agent reading Class 2 through the database — the API-only law (SPEC:786) inverted.
- **Amend:** a permissioned read (`quality.reconstruct.read`) under the QM's identity, writing a `PhiSurface` row; the inspector artefact is that read's render, never a shell transcript.

### N6 · Hermes narration is inference over production's sheet — NOTE
- E2 says the Digest Writer / Hermes "narrate it later". Hermes's model runs on a second server over production's Class-0 sheet; the Hermes brainstorm itself gates that on the DPIA (`00-BRAINSTORM.md:33` "Signature is a law/money stop", :126 "an addendum the DPIA needs before signature"). Name the gate ("DPIA v0.2 signed, Hermes §6 R1") so "later" is dated, and E2 stays inference-free until then.

### N5 · Edge 25 cites a fix that does not exist — NOTE
- "spec fix 25" has no hit in SPEC. The sealed class is SPEC:559, item 5 of §11.19-C (line 550) — the "§11.19-C-5" P15 and SPEC:462 use. Fix the cite; the behaviour (evaluator reads through the caller's filter; a task shows no sealed content) is right.

### N8 · Edge 28 cites the wrong roadmap rule — NOTE
- "never creates a human on production (RM rule 1)". RM:370 rule 1 is "Production never receives **synthetic people** or invented clinical values" — patients. The rule that a session never creates a *user* on production is G4's "/admin/users … a named human" (RM:362) plus the classifier that blocks prod DB writes. Fix the cite.

---

## 4. Lens (4) — patient-data flows vs DPDP / consent / residency

- **R-008 (image AI) and R-059 (speech)** do not bind: P5 carries no imaging upload and no speech path. Confirmed absent from all five epics.
- **Fact sheet (E2):** Class 0 by construction (DPIA:11 fixes the shape; E2-M1 "patient identifiers · schema test · 0"); harvest rows are event counts (`docs/runbooks/lab-go-live.md:213-218`); email/in-app to the owner is inside DPIA §3 L0. Clean.
- **Recall message (E1):** see A4 — consent flag exists and is unread; channel law uncited.
- **Drafter (E4-M5):** see A2 — Class-1 revision, R-128, identifier-absence test, R-006.
- **Deviation tasks (E5):** see A5 — staff data before the addendum.
- **Reconstruction (E5-M2):** see A10.
- **A9 · Verify endpoint puts the credential in a GET path — AMEND (small).** E3-M1: "`GET /documents/verify/:code`". KD:157 rules "`GET /verify/:docNo` (renders the entry form and nothing about the document) · **`POST /verify/:docNo` with the code**", and DD4 (KD:98) "the QR never carries the access code … the paper — QR *and* code — is the credential". A code in a GET path lands in Caddy access logs and browser history. Adopt KD:157 verbatim.
- **N7 · R-009 retention unnamed.** REG:21 R-009 binds "every plan's §4". New tables — `ops_fact_sheets`, `protocol_rules`, deviation approvals, `documents` — carry no retention class in the design. Name them (KPI packs 8 y; agent runs 10 y; IPD documents 10 y; legal holds override) in E2/E3/E5.

---

## 5. What is clean (checked, not re-arguable)

- Clinical cap respected: Drafter T2 (SPEC:785); evaluator "never a block, never a correction" (Q22:460; A12:393); Turnover Dispatcher T4 is operational and the spec allows it (SPEC:778, :787) — the defect is its switch and home (A3), not its tier. Recall at T1 = SPEC:784.
- No inference on production before counsel: E4-M5 is the only inference and is last; edge 33 refuses a shadow-on-production proposal; `complete()` is deliberately undeclared (`core/kernel/inference/types.ts:9-11`); RM:405 ("DPIA v0.2 … yes for 44's Drafter") matches.
- Draft provenance (model id / prompt / hashes into event and signed document) is in E4-M5's acceptance — SPEC:786 v4.6.
- Money rows sent to the owner are money: R-148/187/195/219/220 (REG:160,199,207,231,232 all `money`); R-245 `money`; O6 (RM:444 "money, law"). Law rows are law: R-192, R-111, R-126, R-240, R-241, R-262 (`legal`). R-130 tier promotion is the spec's own rule (SPEC:786) and the register's default (owner signs clinical-class promotions).
- D11 (Hindi + English, deterministic, digits unchanged) is R-006's own default ("deterministic templates for meds/warnings") — cite it and it is closed.
- Fail-open for the model half is designed and tested (IPD:241 D5; E4-M5 kill-switch acceptance; edge 18).
- Class-B seeds stay drafts (RM:373 rule 2; `seed-ot.ts:64-73`) — the *seed* is right; the *publisher* is A1.

## 6. Amendment list (for the design's next revision)

1. D9 → cite R-170; approver pair MS + `department_head`; add a department head to the names; E1-M3 gains the held-role row. (A1)
2. D2 → "orphan scan empty", never balance; note Class-A activation; cite R-252. (A6, N4)
3. R-119 → DECIDED (D13 already is it); drop from RULINGS. (A7)
4. NEW-P5-1 → DECIDED (in-house SOPs, R-260/R-044); keep a deferred purchase line. (A8)
5. E4-M5 gate → DPIA Class-1 revision + R-128 + identifier-absence test + English-only draft (R-006). (A2)
6. Every automation behind an inert `*_ENABLED` flag, toggle evented; T4 Dispatcher deferred to 19/20 + 12a; drop `task.verified`; manual path first. (A3)
7. Recall = consumer, own tx; honour `notifyOk`/opt-out/language; add the enqueue-throws edge; E1-M5 instrument reads row status and names the adapter. (A4)
8. E5-M2 flag-inert on production until staff notice + DPIA staff line; shadow on UAT. (A5)
9. E5-M2 reconstruction = permissioned read with a PHI-log row, never a script. (A10)
10. E3-M1 verify route = KD:157 (`POST /verify/:docNo`, code in body). (A9)
11. Split FACTS from RULINGS (O1, names); cite SPEC §19 for the gateway; cite R-020/R-249/R-114, R-058, R-009 retention rows; fix the two bad cites (edge 25 → SPEC:559 §11.19-C-5; edge 28 → RM:362/G4); name the DPIA gate on Hermes narration. (N1–N8)
