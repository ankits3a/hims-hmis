# P1 — Unified intelligence fabric (tasks to agents AND humans) + multilingual speech

Read against `main-ro` @ `b04cbd9` (2026-09-06); every code line re-grepped tonight. Paths repo-relative. `H` = untracked Hermes brainstorm `/opt/hmis/docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md` · `RM` = `docs/superpowers/2026-09-06-ROADMAP-v2.md` · `REG` = `…department-series/00-OWNER-RULINGS-REGISTER.md` (R-nnn is at line 12+nnn) · `12` = `…department-series/12-agentic-copilot-layer.md` · `20` = `…department-series/20-*.md` · `DPIA` = `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md` · `spec` = `docs/superpowers/specs/2026-08-10-hmis-architecture-design.md` · `11h` = `…plans/2026-08-25-phase1-11h-global-search-command-palette.md` · `index` = `…department-series/00-INDEX-AND-SYNTHESIS.md`. Production moved to `399f92c` at 12:35 UTC today (CONTEXT.md:20); "deployed" = in that image.

## 0. The mission sentence(s) this pillar serves, and the honest reconciliation with the spec (tiers, buy-not-build, DPIA, the IPD gate)

Mission (MISSION-BRIEF.md:3,6,7): *"…a unified system that assigns tasks to both AI agents and human teams in real time"*; §1 *"connect every hospital department into a single intelligence layer. Assign real-time clinical and operational tasks to both AI agents and human staff (nurses, phlebotomists, radiology technicians, care coordinators)"*; *"understand and process speech across 15 Indian languages natively."*

| mission phrase | what the spec / law allows | what exists (cite) | reconciled goal |
|---|---|---|---|
| "a single intelligence layer" | agents "consume the event stream and act through the same permission-enforced APIs and workflow definitions as humans, never the database" (spec:776); no agent-to-agent transport (12:158); "Where a rule is safer, cheaper and more auditable than a model, the rule wins" (spec:780) | one event spine with `Actor = user\|agent\|system\|patient` (`packages/contracts/src/envelope.ts:35`; `kernel/db/schema/events.ts:30`); guarded workflow transitions + SLA timers + escalation ladders (`kernel/workflow/timers.ts:148-168`); alerts (`kernel/alerts/consumer.ts:173-188`) | **The fabric already exists and is deterministic**: the event log + workflow engine + ladders. What is missing is not a planner but a *destination that is a person* (Plan 20) and a *task entity* (19a). A central model-driven planner is in no design and is refused by construction — say so. |
| "assigns tasks to AI agents in real time" | tiers T0–T4; "Clinical actions cap at T2–T3 permanently" (spec:778); PRE-12a gate = DPIA + inference locus "before any agent activation" (spec:839) | the actor half only: `agents` table + key + kill switch (`kernel/db/schema/auth.ts:91-100`, `kernel/auth/guards.ts:47-52`); **"agents hold no permissions yet"** (`guards.ts:99-101`); `complete()` deliberately undeclared (`kernel/inference/types.ts:9-11`); no `agent_permissions` (`printing.controller.ts:31` says so), no `agent_ledger` (a comment at `opd/events.ts`; `…SCOPE-registration-counter-remainder.md:40`), no `kernel/copilot`; DPIA unsigned (DPIA:3,66-72); RM:428 "No 12a agent runtime". The one thing acting alone in production is a **rule** — the double-confirmed danger reading, 10-s human cancel (`modules/opd/escalation.ts:29-33`) | This quarter and next, "AI agents" = (a) **automations** under the harness, already acting (danger protocol, ladders, lab sweeps, radiology chasers), and (b) **one T0 external agent** — the Hermes Ops Copilot, pull-only, Class-0, no model call inside HMIS (H:9-13) — activated only after a Class-0 DPIA signature, a pinned-provider DPA and a second server. Model-backed *clinical* drafters (43c, 44, 18b R4) are P2/P3/P5's, behind DPIA L1; never above T2. |
| "assigns tasks to human teams … in real time" | Plan 20 = roster substrate replacing static `usersHoldingRole()` (index:66; RM Q4:278-300, DECIDED this quarter); kernel `tasks`/five pools = 19a (index theme 13:153; REG R-094:106); RM:414 "not 19a/19" this quarter | **role-broadcast**: "until it lands, escalation resolves to everyone currently holding the role" (`kernel/workflow/roles.ts:31-33`); five non-test files call it (RM:279-281; `ot/lists.ts:26`: the anaesthetist list "is a LIST, not an assignment"); the ladder already records `resolvedUserIds`/`fallback`/`fallbackExhausted` (`timers.ts:148-154,166-168`; schema `kernel/workflow/events.ts:35-45`); **no `tasks` table** (grep) | Q-this: every escalation and chaser reaches **one named on-duty holder** (E1). Q-next: a kernel task entity with claim discipline; the phlebotomy collection round and the radiology technician worklist as first clinical consumers (E2). "Real time" is the ladder's timer, which exists. |
| "speech across 15 Indian languages natively" | spec §9 buys commodity infrastructure (:161-166); ASR bought — Cloudflare for search, on-prem `whisper.cpp` before any clinical dictation (12:541); DPIA §3-A: "audio cannot be de-identified before transmission", one named exception, **pending owner accept/refuse** (DPIA:31-33); R-059 blocks every transcript-to-note agent (REG:71) | hi/en literal-typed at **eight** code sites (measured: `schema/patients.ts:95` comment + `modules/patients/types.ts:5`, `inference/types.ts:17`, `notify/templates.ts:19`, `notify/pump.ts:378`, `web/lib/i18n.ts:34`, `web/lib/patients-api.ts:155`, `desk-one/session.ts:109`, `lab-report-print.tsx:142`); `POST /speech/transcribe` deployed, inert at 503 (`speech.controller.ts:89-90`); `VOICE_SEARCH_ENABLED=false` (`voice-flag.ts:27`; `voice-button.tsx:16` renders null); the only live speech is browser TTS on the OPD display (`opd-display.tsx:45-52`); **no document names fifteen languages**; Bhojpuri (36 mentions in the series) cannot be recorded | **"Natively" = the OS is language-neutral at every surface it owns; the language is an attribute of the person and the document, not of the deployment.** ASR/TTS are bought behind `SpeechClient` (`types.ts:32`), and a language flips on only after WER is measured on the hospital's own recordings. "15" is the registry's ceiling, not a milestone — N is *measured* from `patients.spoken_language` over 90 days. Speech input beyond push-to-talk search is the owner's §3-A accept + counsel + R-059 and belongs to P2 (ambient); this pillar builds the substrate and the measurement. |

**Where the mission exceeds what is designable or lawful now:** (i) a central model that assigns tasks — in no design; (ii) ambient listening — the opposite of every authorised control (11h:341-342; `consult-scribe.tsx:30-38` push-to-hold, 15-s cap, audio discarded); (iii) speech in 15 languages — not lawful for anything clinical under the current DPIA, not measurable until a third language is *recordable*; (iv) T4 autonomy for anything clinical — never (spec:778). **DPIA:** one unsigned file couples the harmless Class-0 digest to the Class-2 speech carve-out (DPIA:5,31-33); DECIDED: addenda so a Class-0 signature can precede the speech ruling (D4). **IPD gate:** Plan 20 is a gate condition (RM:400) — E1 is on the IPD critical path; nothing else here is behind the gate. **Buy-not-build:** Hermes (OSS, self-hosted), the model provider (pinned, DPA), the ASR/TTS vendor — nothing here trains a model.

## 1. Goals — 2 to 5 goals, each with a NORTH-STAR PARAMETER

| # | goal | parameter | instrument | baseline today | target | who reads it |
|---|---|---|---|---|---|---|
| G1 | **One named human.** Every escalation reaches one on-duty holder, not a role broadcast | share of `escalation.triggered` rows with `payload.resolvedUserIds` of length 1 and `fallback=false`; count of `fallbackExhausted=true` per day | `events` table, fields already written (`timers.ts:166-168`); one SQL over `payload` | measurable now; 0 % single-holder by construction (`roles.ts:31-33`); production ≈ 500 events, no roster | ≥ 90 % single on-duty holder within 30 days of Plan 20 live on production; `fallbackExhausted` = 0 on any day a roster is published | duty manager (digest line); owner (08:00 digest, G2) |
| G2 | **The first agent acts under governance** — on production, observed, killable | `events.actor_type='agent'` rows/day; `copilot.tool_called` rows/day; digest delivered days per 30; a dated kill-switch + global-halt drill | `events`; `agent_ledger` (minted by E3); a dated `## Executed` section in `docs/runbooks/ops-copilot-go-live.md` (no such runbook exists — four do, `docs/runbooks/`) | 0 — no agent identity on production; `pnpm agent:create` exists (`apps/core/package.json:16`, `scripts/create-agent.ts`) but no ledger to count into | digest ≥ 27/30 days; 0 scrubber leaks (fail-closed count reported); one drill per quarter, dated | owner |
| G3 | **Speech exposure is measured before it is widened** | `search_audit.source='voice'` rows/day/desk (`kernel/search/audit.ts:146-159` records egress *before* the call); WER on ≥ 3 real Hinglish counter clips | `search_audit`; the 11h-ii phase doc's measurement table | 0 rows (route 503); WER "NOT MEASURED" (11h:135, :688) | WER recorded per clip; the flag flips only if the DECIDED threshold clears (D5); voice rows visible per desk | front-desk lane; the owner at accept/refuse |
| G4 | **Language-neutral surfaces** — a third language is recordable and every patient-facing send carries a language | literal `hi\|en` sites in code (8 today); distinct `patients.spoken_language` over 90 d; share of patient-audience `notification.sent` carrying `language`; `notification.language_fallback` per language | grep pinned in CI; `patients`; `events` | 8 sites; 0 third-language patients recordable; `notification.sent` carries no language (`kernel/notify/events.ts:16-28`) | sites → 1 registry; `bho` recordable; 100 % of patient sends carry `language`; fallback count reported per language | front office; owner digest |
| G5 | **A Hindi seat with zero defects** | 11i T6's dated Executed section: untranslated strings at the Hindi seat; `hi.json` non-Devanagari leaves pinned by an allowlist test; raw-zod refusal sites in `modules/lab` | `docs/runbooks/lab-go-live.md` (no executed section on `main`; T6b writes it); `apps/web/src/lib/i18n*.test.ts`; grep | T6 NOT RUN; 67 of 3,065 leaves non-Devanagari, 66 identical to English (re-measured, all acronyms/units); lab throws raw zod issues (`modules/lab/lab-http.ts:74`) | 0 defects at T6 or fixed in the same PR; allowlist test green at 67; lab refusals coded (the `RuleCode` pattern, `kernel/db/schema/materials.ts:739`) | commissioning lane; the pathologist at the seat |

## 2. Epics

### E1 · `P1-fabric-multilingual-E1` — One named human: the ladder reaches an on-duty holder
- **Plan home:** **Plan 20** (existing; index:66; RM Q4:278-300 DECIDED, authored wk 3, built wk 4–6 by R, RM:336-337). No phase doc exists (`ls docs/superpowers/plans` → none for 20).
- **Goal:** G1. Escalations, chasers and notify recipients resolve to the on-duty holder; a gap is a visible event, never silence.
- **Exists:** `usersHoldingRole` + the five files (§0); ladder rung → `duty_manager` → `owner` (`alerts/consumer.ts:23,30,177-184`; owner-SMS leg `notify/consumer.ts:33,191`); `escalation.triggered{resolvedUserIds,fallback,fallbackExhausted}` (`workflow/events.ts:43-45`); census row `second_administrator` (`scripts/standup-check.ts:173`); the chaser destination as a config row, 18a-iii's chaser "20's second consumer" (RM:297-300); the lab's critical ladder rings everyone holding a role (RM:283-284).
- **Build:** roster tables + CSV import + publication gate; `resolveOnDuty(role, at)` behind `ROSTER_RESOLVER_ENABLED` (default false, static fallback); the five runtime consumers + two seed scripts re-pointed (RM:337); the chaser destination config row; census rows `roster_published_today`, `on_call_<role>_resolvable` (none exist; hospital block `standup-check.ts:128-210`); a digest line for `fallbackExhausted`; `docs/runbooks/roster-go-live.md`.
- **Gates:** G1–G5 for 20 itself; an IPD-gate condition (RM:400). No DPIA (no inference).
- **Tier:** the resolver is an automation (T0); Coverage Resolver proposals are **T3** (duty manager approves; T1 in `disaster` — index theme 15:155; 12:174).
- **Deps:** Plan 13 (deployed); R-071/R-072/R-067/R-110 → DECIDED (D8); HR-SaaS sync deferred (CSV first, RM:294-296). Files everyone owns: `kernel/workflow/roles.ts`, `kernel/db/schema/index.ts`, `seed-roles` counts — coordinate.
- **Fallback / manual path:** flag off or roster empty → today's role broadcast, with `roster.unpublished` emitted once a day; the duty manager's phone list stays the paper path.

### E2 · `P1-fabric-multilingual-E2` — Tasks to human teams: the kernel task entity and five pools
- **Plan home:** **19a** (existing letter; index:46 "One P5 pool engine for five departments"; theme 13:153 "Kernel component in 19a"; REG R-094:106). Next quarter (RM:414).
- **Goal:** the mission's phlebotomists, technicians, porters and coordinators claim work from a pool with a claim discipline; the ladder becomes a task, and "nobody took it" is an event.
- **Exists:** nothing task-shaped — alerts are bounded pages (`kernel/alerts/alerts.ts:9-14`), approvals have a worklist (`kernel/approvals/worklist.ts`), lab `awaiting_collection` already carries an SLA (`modules/lab/sweeps.ts:247,266`), `imaging_study` is record-only; `fallbackExhausted` already routes to the owner (`timers.ts:154`).
- **Build:** `tasks` (pool, claimed_by, claim TTL, due_at, `pool_empty` fallback), events `task.offered/claimed/released/completed`, one worklist per pool, first consumers: the phlebotomy round (lab items), the radiology technician worklist, porters (Plan 31); SLA Chaser T1 on `due_at`; Turnover Dispatcher T4 later (Plan 19 proper).
- **Gates:** E1 live (a task needs an on-duty destination); G1–G5; no DPIA.
- **Tier:** claim discipline T0; chaser T1; dispatcher T4 operational only. Clinical content never in a task body — a task points at the order.
- **Deps:** E1; 11i UAT; Plan 20's competency tags for eligibility. **Fallback:** `pool_empty` → duty manager (theme 13:153); manual path = today's role broadcast, flagged `pool: none`.

### E3 · `P1-fabric-multilingual-E3` — The bridge: Hermes Ops Copilot as 12a-0
- **Plan home:** **12a-0** (letter inside block 12; H:184 R4 recommends it; grep on `main` = 0; numbering is not money/law → DECIDED, D2). Block 12 "slot when the DPIA is signed" (index:57).
- **Goal:** G2. The owner asks questions in Telegram and gets live Class-0 figures; the 08:00 digest spec §16 assigns to the Digest Writer (spec:784) is delivered — with no model call inside HMIS and no patient ever leaving.
- **Exists:** the actor half (`auth.ts:91-100`, `guards.ts:47-52`, `scripts/create-agent.ts`); the permission seam (`guards.ts:99-101`); `Actor` union (`envelope.ts:35`); the desk tiles (`kernel/desk/brief.ts`); H's task sketch T1–T6 (H:192-199) and edge pass E1–E13 (H:205-220). Absent: `agent_permissions`, `agent_ledger` (RC-6's, unbuilt — `…SCOPE-registration-counter-remainder.md:40,56`), `kernel/copilot`, any Class-0 read shaped for an agent.
- **Build (H §7):** `agent_permissions` + guard discharge (user ∩ agent); `kernel/copilot` MCP controller with Class-0 schema test, fail-closed scrubber, rate limit, global halt, `agent_ledger`, `copilot.tool_called`; ten Class-0 tools with seeded-day fixtures; `digest.fact_sheet` (H:60) + the Hermes pack (H:136-144: only the `hmis` MCP server, no router, skill creation off); `/admin/agents`; staging smoke on UAT against a real Hermes.
- **Gates:** DPIA Class-0 addendum signed (law) **before any production key** (H:180 R1); pinned provider under a no-training DPA (law/money, H:183); second server (money, H:182; RM:440-441); UAT (11i T3) as staging; G4 for the `owner` role holder = the delegate user (H E8).
- **Tier:** **T0** observe/report, pull-only (H:130), no writes, no push in v0 (v1/v2 are later plans and a ruling, H:62-71).
- **Deps:** 11i T3 UAT; E3 mints `agent_ledger`, RC-6 consumes (D3; H:172 C1). Files everyone owns: `guards.ts`, `schema/index.ts`, `app.module.ts`, `seed-roles` — one small commit each, by pathspec (H:173).
- **Fallback / manual path:** Hermes down → nothing in HMIS depends on it (H E7); the owner reads the desk tiles. Kill switch ends any misbehaviour (H E1; `guards.ts:51`).

### E4 · `P1-fabric-multilingual-E4` — 11h-ii: voice search, the switch-on, measured
- **Plan home:** **11h-ii** (roman sub-phase of the closed 11h, the 18a-ii pattern; grep = 0 on `main`; 11h's own open items :552-560, :686-688 are the scope).
- **Goal:** G3. The three preconditions in `voice-flag.ts:6-24` become artefacts; the flag flips or the phase closes with the number that says why not.
- **Exists:** the route (`speech.controller.ts:33` hi|en default `en`; :80 user actors only; :89-90 coded 503; :53 transcript never forwarded to a model; :103 the one `transcribe` call); `vad_filter` forced (`workers-ai.ts:9-17`); `recordVoiceEgress` (`search/audit.ts:146-159`); `consult-scribe.tsx:91` posts `{ audio }` only — **the language hint is dropped** (11h:525-526 specified it); config keys `SPEECH_PROVIDER/ACCOUNT_ID/API_TOKEN` (`kernel/config.ts:170-172`); DPIA §3-A pending; **spec §19 carries no amendment** (grep `speech-to-text|Cloudflare` over spec → 0 in §19); 11h:350 asks for "off at open counters" as a desk-level setting — no `open_counter` exists in code (grep = 0).
- **Build:** (a) the §19 amendment paragraph as a spec PR and the §3-A carve-out as its own DPIA addendum file with a sign-off table; (b) `apps/core/scripts/speech-bench.ts`: N owner-recorded clips + reference transcripts → WER per clip and language; runs only with `SPEECH_*` set, exits 2 in CI (CI never contacts a provider, `voice-flag.ts:21-23`); (c) the scribe passes the i18n language; `scribe.suggestion_accepted/discarded` events (grep `scribe.` in core events = 0 today) — the acceptance number 12 §9.12 needs; (d) the desk-level open-counter setting honoured by the palette and refused server-side (11h:350); (e) `SPEECH_*` on UAT; the flip is one line.
- **Gates:** owner accepts §3-A (law); counsel signs the addendum (law); WER ≤ D5's threshold; UAT.
- **Tier:** a processor, no tier; the transcript never chains into a model (`speech.controller.ts:53`).
- **Deps:** 11i T3 UAT; the front-desk lane owns `consult-scribe.tsx`. **Fallback:** 503 → typing, always (fail-open; `voice-button.tsx:16`).

### E5 · `P1-fabric-multilingual-E5` — 22-L: the language pack — the OS becomes language-neutral
- **Plan home:** **22-L** (a letter inside block 22 — front office at scale, index:68 — in the 17-E/17-M style; **not** `22d`, which 22-quality:537 already uses for its audit plan, since remapped to 28d). Source rows: doc 20's LA-1/LA-5 (20:427,431) and its `ivr_menus`/`announcements` tables (20:225,233). Q-next.
- **Goal:** G4 + G5. A Bhojpuri-only patient is recordable; every patient-facing paper, message and announcement renders in the patient's read language or logs a fallback; the UI stays hi/en (D6).
- **Exists:** eight `hi|en` sites (§0); parity tests (`i18n.test.ts:11-13` hi ≡ en key-for-key; `i18n-keys.test.ts`); compile-time template parity (`templates.ts:2,19`), eight templates each carrying `waApprovalStatus` (`templates.ts:17`); pump reads `patients.language` at send (`pump.ts:376-379`, staff/owner always `en`); token slip bilingual by design (`kernel/printing/render.ts:402,469-471`), `<html lang="en">` (:163), relay must carry a Devanagari face (:89-91); lab report per-copy `lang`, doctor's copy English (`lab-report-print.tsx:132-144`); pharmacy label has no language handling (`modules/pharmacy/label.ts`, grep `lang` = 0); registration picker hi/en (`desk-one/stages.tsx:788-791`); two locale files (`apps/web/src/locales/en.json, hi.json`).
- **Build:** kernel `languages` registry (BCP-47 tag, script, spoken/read); additive migration `patients.spoken_language`, `patients.read_language` (`language` kept as the read alias); optional `users.ui_language`; `notification.sent.language` + `notification.language_fallback`; `print_jobs.language` (table exists, `kernel/printing/printing.controller.ts`) with per-document policy (patient copy = read language, doctor copy `en`); Hindi sig with pictograms on the pharmacy label (16:300 K1); lab refusals → `RuleCode`; `announcements(language)` order from the catchment; the 67-leaf allowlist test.
- **Gates:** G1–G5 on the front desk; the relay font as a runbook line + test page; WhatsApp template approval per language — procurement (NEW-P1-3).
- **Tier:** none — templates, Class 0; "a model talking to patients … refused, not deferred" (12:511).
- **Deps:** FD-24 printing (`1a752e0`, ancestor of `f211075`, hence in production); `patients` is the shared module and `locales/*.json` is everyone's file — coordinate; migration serial at rebase.
- **Fallback:** a missing template/paper in the patient's language renders `hi` and logs `language_fallback`; never drops the send.

### E6 · `P1-fabric-multilingual-E6` — Indic speech behind the choke module: ASR/TTS bought, measured per language
- **Plan home:** **12c** (existing; "voice carve-out closed or kept", 12:624). Q+2.
- **Goal:** any language the registry holds can be spoken to the palette and spoken by the displays, each switched on by its own measured WER; the §3-A carve-out closes when in-region ASR arrives (11h:557-560; DPIA:33).
- **Exists:** the `SpeechClient` seam with an offline stand-in (`kernel/inference/types.ts:32`, `offline.ts`); Cloudflare Whisper (`workers-ai.ts`); browser TTS hi-IN then en-IN (`opd-display.tsx:45-52`) on `queue.called` (`modules/opd/events.ts:304`); 12 §9.11 "ASR: cloud (Cloudflare) for read-only search under the carve-out; on-prem whisper.cpp before any clinical dictation" (12:541); GPU box ₹3–6 L (12:603), ASR ₹0–2 k/month (12:598).
- **Build:** a second `SpeechClient` (in-region Indic ASR, or on-prem `whisper.cpp`/IndicConformer) selected per language by config; `TranscribeInput.language` widened to the registry; a server TTS adapter for `announcements(language, tts_ref)` so displays stop depending on installed browser voices; E4's bench run with ≥ 50 clips per language; paired eval fixtures by language (12:193 I5).
- **Gates:** ASR/TTS vendor + DPA (procurement/law, NEW-P1-1); GPU box only if chosen (money, NEW-P1-2); R-059 still binds anything beyond read-only search; DPIA addendum per provider.
- **Tier:** processor. **Deps:** E4 measured; E5 registry. **Fallback:** provider down → typing; display TTS falls back to browser hi/en, text always shown.

## 3. Milestones

Size = days of one lane. "Human act" names the act, not "approval". Acceptance cells read `parameter · instrument · threshold`.

**E1**
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E1-M1 | Plan 20 phase doc authored | authoring | phase doc names the five runtime consumer files + two seed scripts and the flag · `git ls-files docs/superpowers/plans` · 1 file; §7 owner rulings · the doc · 0 (policy rows DECIDED) | — | 3 d · none (orchestrator approves) |
| E1-M2 | Roster substrate merged, flag off | G1 merged | migration additive · `apps/core/drizzle` · 1 file, numbered at rebase; consumers unchanged with flag off · a fixture asserting identical `resolvedUserIds` for all five · pass; census rows added · `standup:check hospital` · `roster_published_today` present (RED allowed) | E1-M1 | 10 d · none |
| E1-M3 | Rehearsed on UAT (G5) | G5 | a week's roster loaded by CSV · `roster_publications` · 1 row; induced critical with an empty on-duty role · `escalation.triggered` · `fallback=true`, `fallbackExhausted=false`; with a holder · same · `resolvedUserIds.length=1`; dated section · `docs/runbooks/roster-go-live.md` · `## Executed on UAT — <date>` present | E1-M2, 11i T3 | 3 d · the duty manager (named under F4) walks it |
| E1-M4 | Live on production, 30 days (G6) | G6 | G1 share · `events` SQL · ≥ 90 %; `fallbackExhausted` on roster days · same · 0; chaser destination · the config row · = on-call radiologist | E1-M3, weekly deploy | 0 d build · the owner's weekly deploy; department heads publish rosters |

**E2** (Q-next)
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E2-M1 | 19a phase doc authored | authoring | consumers named · the doc · phlebotomy, radiology tech, porter; §7 rulings · the doc · 0 | E1-M4 | 3 d · none |
| E2-M2 | `tasks` kernel merged | G1 merged | two concurrent claimers · a test · exactly one `task.claimed`; TTL release · `task.released{reason:'ttl'}` · emitted at 15 min; empty pool · `task.pool_empty` → duty-manager alert · 1 per task; role-broadcast fallback when no pool configured · fixture · unchanged | E2-M1 | 8 d · none |
| E2-M3 | Phlebotomy round on UAT (G5) | G5 | lab `awaiting_collection` items become tasks · `tasks` count = items; a phlebotomist claims from a phone worklist · `task.claimed` actor = that user; `claimed→completed` p50 · events · ≤ the orderable's `tat_minutes_routine`; dated section · `lab-go-live.md` addendum · present | E2-M2 | 4 d · a real phlebotomist at the seat |
| E2-M4 | Production pilot 14 days | G6 | collection items claimed via tasks · SQL · ≥ 80 %; `pool_empty`/day · digest line · reported daily | E2-M3 | 0 d · weekly deploy |

**E3**
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E3-M1 | DPIA split: Class-0/MCP addendum drafted | docs | two files · `docs/compliance/` · addendum with the §3.4 assertion site (H:126) + sign-off table; the STT carve-out moved to its own addendum · same · §3-A no longer inside the base file | — | 1 d · owner books counsel (L1) |
| E3-M2 | T1–T3 merged behind the seam | G1 merged | agent without grant · test · 403; kill switch · test · 403 + `agent.kill_switch_set` event; every tool output field · Class-0 schema test · enum/label/number only; ledger · `agent_ledger` · 1 row per call; ten tools vs a seeded day · fixtures · numbers match | E3-M1 | 10 d · none |
| E3-M3 | Staging smoke: real Hermes on the second server against UAT | G5 | the four steps of H §4 · a dated `## Executed on UAT` in `ops-copilot-go-live.md` · present; 7 digests · Telegram + ledger · 7/7; "show me patient X" · ledger · scripted refusal, 0 egress; token audit · the phase doc · one week's figure | E3-M2, 11i T3 | 4 d · **second server bought** (H R2); provider DPA signed (H R3) |
| E3-M4 | Production connection | DPIA signed | production key created · `agents` row · only after the addendum's sign-off row is filled; digest days · ledger · ≥ 27/30; kill-switch + global-halt drill · runbook · dated; `events.actor_type='agent'` · SQL · > 0 | E3-M3, counsel signature | 1 d · counsel signs; the owner pairs Telegram |

**E4**
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E4-M1 | §19 amendment + §3-A addendum written | docs | spec §19 · grep `speech-to-text` in `spec` §19 · ≥ 1 hit; addendum · `docs/compliance/` · sign-off table present; `voice-flag.ts` comment · the file · cites the addendum path | — | 1 d · **owner accepts or refuses §3-A** (one line); counsel |
| E4-M2 | Seams + the bench | G1 merged | scribe posts `language` · test · = i18n language; Insert/Discard · events · `scribe.suggestion_accepted/discarded` emitted; open counter · test · mic not rendered + server 403; bench in CI · exit code · 2 with `SPEECH_*` unset | — | 4 d · none |
| E4-M3 | Measured on UAT | G5 | real clips · the phase doc's table · ≥ 3 clips from a real counter, WER per clip and language; `search_audit` voice rows · SQL per desk · visible; `SPEECH_*` · UAT env only · production unset | E4-M2, 11i T3 | 2 d · **the desk records three Hinglish clips** (a fact only the counter can produce) |
| E4-M4 | Flip, or close as "stays off" | law + D5 | `VOICE_SEARCH_ENABLED` · the constant · `true` only if WER ≤ D5 and both signatures exist, else `false` with the number in §8 CLOSE; production voice rows/day · `search_audit` · reported weekly | E4-M1, E4-M3 | 1 d · none beyond the signatures |

**E5** (Q-next)
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E5-M1 | 22-L phase doc authored | authoring | registry design + coordination list · the doc · names `patients`, `locales`, `printing`, `notify` owners | — | 3 d · none |
| E5-M2 | Registry + patient languages merged | G1 merged | literal `hi\|en` sites · CI grep · 0 outside the registry; migration · drizzle · additive, serial at rebase; picker · UAT · `bho` selectable and stored | E5-M1 | 6 d · none |
| E5-M3 | Papers, messages, refusals | G1 merged | patient-audience sends · `notification.sent.language` · 100 %; missing template · `notification.language_fallback` · emitted, send not dropped; patient copies · `print_jobs.language` · = read language; pharmacy label · a Hindi sig-pictogram fixture · renders; lab raw-zod refusals · grep `BadRequestException(r.error.issues)` in `modules/lab` · 0 | E5-M2 | 8 d · WABA per-language template approval (procurement) |
| E5-M4 | Hindi seat + relay font on UAT (G5) | G5 | T6 Hindi seat defects · `lab-go-live.md` executed section · 0 or fixed in the same PR; relay · a printed test page · Devanagari renders, runbook line ticked; allowlist · `i18n` test · 67 leaves, all listed | 11i T6 | 2 d · a Hindi-reading staff member runs the seat |
| E5-M5 | Production, 30 days | G6 | sends by language vs `patients.read_language` distribution · SQL · reported; fallback per language · digest · trend to 0 | E5-M4 | 0 d · weekly deploy |

**E6** (Q+2)
| id | name | gate | acceptance | depends_on | size · human act |
|---|---|---|---|---|---|
| E6-M1 | Vendor bench | procurement input | ≥ 2 candidates on the same clip set · the phase doc · WER per language, ≥ 50 clips each; residency · the DPA draft · India-region or on-prem stated | E4-M3, E5-M2 | 3 d · **the owner picks the vendor** (NEW-P1-1) |
| E6-M2 | Second `SpeechClient` merged | G1 merged | provider per language · config · selected; provider down · test · 503, typing unaffected; `language` · `TranscribeInput` · registry tag | E6-M1 | 6 d · none |
| E6-M3 | Server TTS for displays | G5 | `announcements(language, tts_ref)` · UAT display · speaks the catchment's order; no voice installed · test · text shown, browser fallback | E6-M2 | 4 d · none |
| E6-M4 | Languages flipped one at a time | law + D14 | each flip · the phase doc · its own WER ≤ D5 on its own clips; §3-A · DPIA addendum · closed if in-region | E6-M3 | 1 d each · counsel per provider |

## 4. Edge cases — the Indian day each must survive (11i §2b shape)

| # | scenario | expected behaviour | artefact that proves it | milestone |
|---|---|---|---|---|
| 1 | 02:00, the roster has no on-call radiologist; a CT shows a bleed | resolver falls to `duty_manager`; `escalation.triggered{fallback:true}`; the chaser's destination row is read, never a constant | event row + config row | E1-M3 |
| 2 | The deploy lands the resolver before anyone loads a roster (deploy-dark) | flag off by default; with flag on and no roster, static holders + one `roster.unpublished`/day; census `roster_published_today` RED with the screen that fixes it | `standup:check hospital` line | E1-M2 |
| 3 | A nurse is on the roster but her account is deactivated | resolver ignores inactive users; census `on_call_<role>_resolvable` RED names the account | census row | E1-M3 |
| 4 | Doctors' strike: six consultants marked absent in one upload (chaos §5) | Coverage Resolver emits *proposals* (T3); nothing is assigned until the duty manager approves | `coverage.proposed` without `coverage.applied` | E1-M3 |
| 5 | A phlebotomist claims a round and her phone dies in the ward | claim TTL 15 min → `task.released{reason:'ttl'}`; the item is back in the pool, SLA clock untouched | event pair | E2-M2 |
| 6 | `pool_empty` at 03:00, the duty manager is asleep | existing owner rung fires (`fallbackExhausted`); the task stays visible; the 08:00 digest carries it | alert + digest line | E2-M2 |
| 7 | The owner types "show me Ram Kumar's bill" into Telegram | no tool can answer; scripted refusal; ledger row records the refusal; zero egress | `agent_ledger` row, no `copilot.tool_called` | E3-M2 |
| 8 | A ward name in a master carries a phone number | scrubber fails the call closed; alert to the admin; the digest says "one figure withheld" | alert + ledger `scrubbed:true` | E3-M2 |
| 9 | The second server is unreachable at 08:00 | Hermes reports "the hospital did not answer", retries 08:15; nothing in HMIS blocks or notices | Hermes log; HMIS ledger has no row | E3-M3 |
| 10 | A staging Hermes is pointed at production | staging keys are prefixed; production refuses by construction; no production key exists before the addendum is signed | test + `agents` row absent | E3-M4 |
| 11 | A ceiling fan hums into the counter mic | `vad_filter` returns ""; no phantom query; the egress row still exists (audio *left*) | `search_audit` row with empty transcript | E4-M2 |
| 12 | Cloudflare is down mid-shift | 503 `speech_provider_failed`; the mic greys; typing unaffected; no retry buffer holds the clip | test + component | E4-M2 |
| 13 | A Hindi-UI doctor holds the scribe key | the clip is sent with `language:'hi'`; the transcript is a suggestion with Insert/Discard | test + `scribe.suggestion_*` event | E4-M2 |
| 14 | The registrar opens voice at the public counter | desk-level open-counter setting → no mic rendered; the server refuses a clip from that desk | test | E4-M2 |
| 15 | A Bhojpuri-only grandmother who reads Hindi registers | `spoken=bho, read=hi`; WhatsApp and the slip in Hindi; the palette's ASR hint stays `hi` until E6 | patient row + `notification.sent.language='hi'` | E5-M2 |
| 16 | A patient's language has no approved WhatsApp template | send in `hi` + `notification.language_fallback`; never dropped | event pair | E5-M3 |
| 17 | The relay PC has no Devanagari face | the runbook's test page prints boxes and the seat drill stops there; the census names the runbook line (NOT MODELLED → runbook §n) | printed page + runbook line | E5-M4 |
| 18 | The lab refuses "exactly one of encounterNo or walkIn" to a Hindi seat | the refusal is a code; the screen renders its locale string; digits read the same in both scripts | grep = 0 + locale key | E5-M3 |
| 19 | **Session:** E3-M3 is green, the DPIA is still unsigned, the owner is asleep | the session writes "production connection waits on the addendum signature" into §8 CLOSE and creates no production key; a refusal in the report, not a deploy | §8 CLOSE line; `agents` row absent | E3-M4 |
| 20 | **Session:** a lane flips `VOICE_SEARCH_ENABLED` to make a test pass | a CI pin asserts the constant is `false` on `main` while no signed addendum exists in `docs/compliance/` | the pin test | E4-M4 |
| 21 | **Absorption:** the roster feature is deployed but nobody on production holds `duty_manager` (G4) | census RED; `deploy.sh` prints it and does not stop (`deploy.sh:542-545`); the S-gate cannot close; the owner names the holder (F4) | census + runbook | E1-M3 |
| 22 | **Session:** 22-L's migration took serial `0080` at authoring; by rebase `0080` is taken | numbered at rebase, never at start (CLAUDE.md drizzle rule); memory's five-step procedure | the PR's migration serial = next free at rebase | E5-M2 |
| 23 | **Absorption:** the three Hinglish recordings never arrive | E4 closes "stays off — NOT MEASURED" with the date; no synthetic clip substitutes (11h:688) | §8 CLOSE line | E4-M3 |
| 24 | **Session:** RC-6 and 12a-0 are authored in the same fortnight and both mint `agent_ledger` | whichever PR reaches `main` first owns the table with H §3.8's columns incl. `surface`; the second rebases onto it and adds no second table (H:172) | one migration on `main`, `surface` column present | E3-M2 |
| 25 | **Absorption:** the owner's delegate user for Hermes loses hospital scope in a role reshuffle | user ∩ agent = ∅ → every call 403s; `/admin/agents` shows why; the digest stops and says so (H E8) | 403 rows in `agent_ledger`; admin page | E3-M4 |

## 5. DECIDED — judgement calls — and RULINGS (money / procurement / law / facts only)

**DECIDED** (Indian-corporate-hospital default; one line each)
- D1 The fabric is the event spine + workflow + ladders; no central planner (12:158; spec:776,780).
- D2 The Hermes bridge is **12a-0** — H:184 asked the owner; numbering is neither money nor law, and 12a's lineage stays honest.
- D3 E3 mints `agent_ledger`; RC-6 (unbuilt) consumes it — one table, two writers, whichever phase reaches `main` first (H:172).
- D4 The DPIA becomes a base file plus addenda (Class-0/MCP; §3-A STT; later L1) so a Class-0 signature does not wait on the speech question — document structure, not law.
- D5 The search-flip threshold is **WER ≤ 25 %** on the Hinglish counter set — a desk query tolerates a wrong token where a note would not; revised only by measurement.
- D6 The UI stays hi/en; a third language enters through patient paper, messages and audio — Bhojpuri speakers read Hindi (20:427); 3,065 leaves × N is a translation job, not a flag.
- D7 Registry = BCP-47 tag + script + spoken/read split; `patients.language` survives as the read-language alias — every module imports `patients`.
- D8 Roster policy rows R-071/R-072/R-067 and R-110 timers adopted at their register defaults (NABH tables exist; REG:83-84,79,122).
- D9 Coverage Resolver is T3 always, T1 in `disaster` (index:155; 12:174); the resolver function itself is T0.
- D10 Task claim TTL 15 min; `pool_empty` → duty manager (index:153); a task body never carries clinical content — it points at the order.
- D11 Plan 20 ships flag + static fallback (RM:280-282); no consumer changes behaviour with the flag off.
- D12 Hermes v0 as brainstormed: Telegram, pull-only, ten Class-0 tools, no staff names, skill creation off (H:130-144).
- D13 The speech bench never runs in CI; CI never contacts a provider (`voice-flag.ts:21-23`).
- D14 A language flips on one at a time, each on ≥ 50 of its own clips; no language flips on a declaration.
- D15 Displays get server TTS under E6 — browser voices are a per-kiosk dependency (`opd-display.tsx:45`).
- D16 Steward = the quality manager day one (R-133); global-halt authority per R-127's default; the dictation-to-note question is P2's (43c) and this pillar only supplies the ASR substrate.
- D17 No "15 languages" milestone: N is measured from `patients.spoken_language`; the registry's ceiling is a table row, not a goal.
- D18 Prescription drafting and ambient listening are not this pillar (P2); nothing here schedules them (index theme 4:144).
- D19 `users.ui_language` optional; the browser-local choice stays for shared desks (`i18n.ts:8-13`).
- D20 The language pack is **22-L**, not `22d`: the quality brainstorm's own "22d" (22-quality:537) was remapped to 28d by index §3, and a reader must never meet two 22d's.

**RULINGS** (money / procurement / law / facts only)
| id | question | category | recommended default | unblocks |
|---|---|---|---|---|
| R-262 + H R1 | sign DPIA v0.2's **Class-0/MCP addendum** (assertion site = MCP egress; processor = the pinned provider Hermes calls, H:180) | law | sign the Class-0 addendum first, independently of §3-A | E3-M4 |
| DPIA §3-A (DPIA:31-33) | accept or refuse the speech-to-text carve-out for read-only search | law (owner's accept) | accept on the stated terms; closes when in-region ASR arrives (11h:557-560) | E4-M4 |
| R-059 (REG:71) | the §19 audio inference-locus amendment | law | search-only carve-out now; transcript-to-note stays blocked (P2's question) | E4 (search); E6's ceiling |
| Second server (RM:440-441; H:182) | buy an Indian-region VPS for Hermes (and UAT headroom) | money | ₹1,500–3,000/month, 2 vCPU / 4 GB, nothing else on it | E3-M3 |
| H R3 (H:183) | pinned model provider under a no-training DPA | money + law | Anthropic direct, pinned model | E3-M3 |
| R-131 (REG:143) | inference cost cap | money | ₹5,000/day hard cap in commissioning; class halt at 150 % of the 7-day median | E3-M4 budgets |
| NEW-P1-1 | the Indic ASR/TTS vendor with an India-region DPA (no register row exists) | procurement + law | in-region provider under DPA; on-prem IndicConformer/whisper.cpp only if the GPU box is bought | E6-M1/M2 |
| NEW-P1-2 | the on-prem GPU box, ₹3–6 L (12:603) | money | **not now**; buy only if E6-M1 shows on-prem WER competitive *and* P2's dictation is ruled | on-prem ASR |
| NEW-P1-3 | WhatsApp/WABA + DLT registration and per-language template approval (`templates.ts:17`) | procurement | register now; console adapters (`adapters.ts:11`) until then | E5-M3 real sends |
| NEW-P1-4 | who translates ~8 templates + 4 papers into a third language | money (small) | the hospital's own bilingual staff, reviewed by the department head | E5-M3 for `bho` |
| Facts (F4) | the names: duty manager and on-call holders per role; the desk's three Hinglish recordings; the catchment's language mix until measured | fact | a row without a name reads *unstaffed* | E1-M3, E4-M3, E5 |

## 6. Not now — what this pillar does NOT build this quarter and the next, and why

- **No in-house 12a runtime, no `InferenceClient.complete()`** this quarter or next (RM:428): Hermes is 12a's first activation without its runtime (H:11-13, C4 :175); the contract is not guessed a phase early (`types.ts:9-11`).
- **No tasks engine this quarter** (19a is Q-next, RM:414): no consumer opens; a task needs an on-duty destination (E1).
- **No ambient scribe, no dictation-to-note, no prescription drafter** — P2's, behind R-059, DPIA L1 and 12a; no roster row names an Rx drafter (12 §8:301ff; index theme 4:144).
- **No UI in a third language**: the UI is hi/en (D6); a Bhojpuri speaker reads Hindi.
- **No cloud ASR for clinical narratives** (12:514), ever; **no model talking to patients** (12:511) — templates only, Class 0.
- **No IVR rung** until a telephony provider exists (Plan 22 procurement; `adapters.ts:11` has two channels).
- **No model translation of signed documents** (R-006, REG:18: 90 days of edit-distance first; the English signed copy governs).
- **No agent writes from Hermes** (v1 push, v2 approvals are later plans and a ruling, H:62-71); **no Workflow Tuner** (90 days of baselines, spec:786).
- **Why:** absorption before building. Production has ≈ 500 events and no real patient; every agent parameter in §1 is 0 because no department is open, not for want of code. This pillar's Q-this work is one substrate on the IPD critical path (E1), two documents (E3-M1, E4-M1) and one measurement (E4-M3).

## 7. Sequencing note — against ROADMAP v2 §2's 13 weeks and the two quarters after

Against RM §2's 13 weeks (Monday 2026-09-07). Production already runs a lane build (`399f92c`); every "weekly deploy" below is the governed one T7/T8 define:

- **Wk 1–2:** E3-M1 and E4-M1 (documents only: the DPIA split, the §19 amendment, the §3-A addendum) by the roadmap/commissioning lane — *human acts:* the owner books counsel (L1) and accepts or refuses §3-A in one line; buys the second server whenever he likes (H R2 — nothing else waits on it).
- **Wk 3:** E1-M1 — Plan 20 authored by R (RM:336). *Human act:* none.
- **Wk 4–6:** E1-M2 built by R (~2 weeks, RM:337); E4-M2 seams by the front-desk lane after FD-25's close (4 days). *Human acts:* F4 names the duty manager and on-call holders.
- **Wk 7–9:** E1-M3 on UAT (the duty manager walks it); E3-M2 may start in the freed LIMS lane **only if** the counsel session is booked — else it stays authored; E5-M1 authored. *Human acts:* the desk records three Hinglish clips for E4-M3.
- **Wk 10–13:** E1-M4 on production through the weekly deploy; E4-M3 measured on UAT if the clips exist; E3-M3 staging if the second server and the DPA exist. *Human acts:* the weekly deploy; the provider DPA.
- **Q-next (Dec–Feb):** E2 M1–M4 (19a) after E1-M4; E5 M2–M5 (22-L) with the front desk; E3-M4 production connection on counsel's signature; E4-M4 flip or close. *Human acts:* counsel signs the Class-0 addendum; NEW-P1-3 WABA registration; NEW-P1-4 translator.
- **Q+2 (Mar–May):** E6 M1–M4 (12c's voice half) after E4/E5; 12c proper (Lens narration) only when DPIA L1 is signed — P2's gate, not this pillar's. *Human acts:* NEW-P1-1 vendor pick; NEW-P1-2 GPU box only on E6-M1's evidence.

Each start names the human act it needs, so a slip reads as *that act's* slip, not as "the fabric is late".
