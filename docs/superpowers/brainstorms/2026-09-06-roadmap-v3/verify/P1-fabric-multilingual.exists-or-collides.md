# VERIFY · P1-fabric-multilingual · lens EXISTS-OR-COLLIDES

Target: `wf/design/P1-fabric-multilingual.md`. Checked against `main-ro`, which is at **`3f596e4`** (`git log -1`: "17-E T7b … (#154)", 2026-09-07 08:26 IST) — NOT `b04cbd9` as the design's header says. The NIGHT UPDATE (CONTEXT.md:36-43) landed 43 PRs; the design was written before it and did not re-read. Every code citation below was re-grepped on `3f596e4`; every doc citation opened. `H` = the untracked Hermes brainstorm at `/opt/hmis/docs/superpowers/brainstorms/2026-09-01-hermes-ops-copilot/00-BRAINSTORM.md` (230 lines).

Verdict: **needs-amendment**. One milestone already exists on `main` and must go (E1-M1); E1's build list collides with the authored Plan 20 on five names; E3 gives the Ops Copilot a third home without retiring the two the spec and doc 12 already hold; E6 borrows 12c's number without its gate and contradicts doc 20's ruled "no live TTS"; E2 silently drops R-094's first consumer; one edge-row citation points at seed comments. The remaining ~60 citations hold.

---

## 1. Already exists but presented as new

### R1 · E1-M1 "Plan 20 phase doc authored — 3 d, wk 3" — KILL (the milestone; move the item to *Exists*)
- Design E1: *"No phase doc exists (`ls docs/superpowers/plans` → none for 20)"*; E1-M1 = authoring, 3 d; §7 *"Wk 3: E1-M1 — Plan 20 authored by R"*.
- Repo: `docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md` (143 lines) is on `main` — merged as **#150** (`lane/radiology-plan-20`, "docs: Phase 20 — the workforce and roster substrate (FOR APPROVAL)"); CONTEXT.md:37 names it. `ls docs/superpowers/plans | grep phase1-20` → 1 file.
- What remains is not authoring: CONTEXT.md:39 *"Plan 20 BUILD also waits on the owner's approval line (authoring is done)"*. So E1-M2's "human act · none" is also wrong — the human act is the owner's one-line approval of #150's doc, and it gates the build, not the authoring.
- Fix: delete E1-M1; add the doc to E1 *Exists*; E1-M2 human act = "the owner's approval line on Plan 20 (held by the orchestrator, CONTEXT.md:39)"; §7 wk 3 row becomes "approval line" not "authored by R".

### R2 · E1 *Exists/Build* names five things the authored Plan 20 already DECIDED differently — AMEND
The design wrote Plan 20's build from RM:279-281 and RM:337; Plan 20 §2 measured the code and refutes the roadmap's count in so many words. Every item below is a name a lane would grep for and fail to find:

| design says | Plan 20 (`…phase1-20-workforce-roster.md`) says | evidence |
|---|---|---|
| "five non-test files call it" (§0 row 3); "the five runtime consumers + two seed scripts re-pointed"; E1-M1 acceptance *"names the five runtime consumer files + two seed scripts"* | **3 runtime files + 2 seed scripts** (`alerts/consumer.ts` 5 calls, `workflow/timers.ts` 2, `notify/consumer.ts` 1; `seed-ops.ts` 4, `seed-roles.ts` 1); *"the roadmap's list names `modules/ot/lists.ts` — which mentions the function in a comment and never calls it — and `kernel/workflow/roles.ts`, which is the DEFINITION"*; T3: *"The seed scripts do not move"* | Plan 20:28-30, :100-102. Verified: `grep -n usersHoldingRole apps/core/src/modules/ot/lists.ts` → only line 26, inside a `/** … */` comment; `roles.ts` is the export |
| `resolveOnDuty(role, at)` | `whoIsOn(tx, roleKey, at)` | Plan 20 T2:96 |
| E1-M3 acceptance: `roster_publications` · 1 row | `roster_periods` (draft/published/superseded) + `roster_assignments` | Plan 20 T1:92-93 |
| census rows `roster_published_today` (edge row 2: RED with **flag off**) and `on_call_<role>_resolvable` | ONE row, RED **only when the resolver is enabled and no roster is published** — "the state in which the flag is on and every escalation has quietly fallen back" | Plan 20 T7:117-118. Edge row 2 inverts the ruled condition |
| no module named; coordination list = `roles.ts`, `schema/index.ts`, `seed-roles` | D1: `roster` is its own kernel-adjacent module, app **and** worker | Plan 20 D1:64-67 |
| `docs/runbooks/roster-go-live.md` | T7 "the census row and the runbook" — unnamed | Plan 20:116-118 (no collision; name it as the design's proposal, not as Plan 20's) |

Also: Plan 20 §7 (:134-139) names its one ruling — *does an on-call person's phone number live in this system (DPDP, retention)* — and says T1–T7 need no number. The design's E1 says only "No DPIA (no inference)" and lists D8 (R-071/072/067/110); it should carry Plan 20's actual ruling. And Plan 20 §6:130-132 explicitly hands off *"the alert `title` and `body` remain English server prose … belongs to whichever phase takes the refusal-localisation work"* — E5 is that phase and does not claim it (see R11).

Fix: rewrite E1 *Build* as "Plan 20 T1–T7 as authored" and cite its names; keep only what the design adds (the `fallbackExhausted` digest line; the G1 SQL). E1-M3's artefacts → `roster_periods.status='published'`.

---

## 2. Plan-home collisions with index §3 / authored plans / PRs

Checked: `ls docs/superpowers/plans` (92 files), `gh pr list --state all --limit 160` (#2–#161), index §3 (`00-INDEX-AND-SYNTHESIS.md:55-135`), `git branch -r` (no roster/hermes/language/voice/task branch).

### R3 · E3 "12a-0" — the Ops Copilot already has TWO homes; the design adds a third without retiring either — AMEND
- spec:783: Ops Copilot is a T0 roster member; spec:791: *"**Ops Copilot and generic summarisation are out of Phase 1** (no state to query yet — revisit after the resource registry)"*.
- doc 12:16: *"Plan 12b (Fraud Sentinel rules-first, Recall OPD, **Ops Copilot only after Plan 13 and only if reopened**)"* — the roadmap put it in **12b**.
- doc 12:374: *"Ops Copilot for housekeeping (Lane 3 pilot) … T2 … **12c**"* — a second, staff-facing Ops Copilot in **12c**.
- index:57 fixes "12a/12b/12c (slot when the DPIA is signed)"; `grep -rn '12a-0' docs` on `main` → 0 (the design's claim holds), and `grep -ril hermes docs` on `main` → only RM:440 and 18b:91 (a passing mention each).
- H:184 R4 recommends 12a-0 and says **"Owner to confirm"**; D2 decides it as "numbering is neither money nor law". Acceptable as a DECIDED — but the design must say: (a) Plan 13 is deployed, so 12b's "only after Plan 13 and only if reopened" condition is now satisfiable and this IS the reopening; (b) 12c's Lane-3 housekeeping copilot is a different agent (staff-facing, T2) and stays in 12c; (c) spec:791's "out of Phase 1" is superseded. Otherwise a reader of doc 12 meets three Ops Copilots.
- **The plan home rests on an untracked file.** Twelve of E3's citations (H:9-13, :60, :62-71, :126, :130, :136-144, :172-175, :180-184, :192-199, :205-220) are to a document that is not on `main` (CONTEXT.md:4 "untracked"). CONTEXT.md:42's lesson applies verbatim: *"Any document a roadmap item depends on must be checked to exist before it is named."* E3-M1 must include committing H (a docs PR) or E3 has no home a session can read.

### R4 · E6 under "12c" — borrows the number without the gate, and contradicts doc 20's ruled display audio — AMEND
- 12:624 defines 12c: *"Conversational Work Surface + Lens narration (Class-1 lane) … voice carve-out closed or kept. **Gate:** Plan 13 registry live; **Plan 19 live for the cohort; DPIA L1 signed**."* The design puts a "processor, no tier" ASR/TTS vendor substrate under 12c (E6 *Plan home*) while §7 schedules it Q+2 "after E4/E5" and says 12c proper waits on DPIA L1 "— P2's gate, not this pillar's". A number carries its gate (index §3 rule 1: "the owner can read a number and know its gate"); E6 as written is 12c's number with E4/E5's gates.
- E6-M3 *"server TTS adapter for `announcements(language, tts_ref)` so displays stop depending on installed browser voices"* and D15 *"Displays get server TTS under E6"* collide with doc 20's design decision: EQ-2 (20:375) *"pre-rendered numeral audio clips per language (0–999) concatenated deterministically, **not live TTS**"*; 20:641 *"Audio | pre-rendered numeral clips per language … | **no live TTS dependency**"*; `tts_ref` (20:233) is the reference to such a clip. `announcements` is Plan 22's table (index:68 "displays"), so E6-M3 also gives display audio a second home beside 22-L (E5 already takes `announcements(language)`).
- Fix: either (i) move E6's display half into 22-L as EQ-2's pre-rendered clips (which also answers doc 20:752 "numeral audio for regional languages … decide the language pack at commissioning per catchment"), and give the ASR half its own letter in the 11h lineage (11h-iii) — or (ii) keep 12c and state that E6 inherits 12c's three gates. Either way, name EQ-2 as overruled or adopted.

### R5 · E2 "19a" — R-094 rules housekeeping the first consumer; the design's 19a has no housekeeping in it — AMEND
- REG:106 R-094: *"Kernel; delivered as Plan 19a's first task; **housekeeping first consumer**, transport/maintenance/nursing/security/IT reuse"* (category `scope`, `pre-plan-authoring`). doc 08:599: *"19a — Task fabric + turnover (kernel `tasks`, **housekeeping module core**)"* with T1–T7 listed. index:35 "19a/19b/19c" from doc 08.
- Design E2: first consumers = "the phlebotomy round (lab items), the radiology technician worklist, porters (Plan 31)"; E2-M1 acceptance "consumers named · phlebotomy, radiology tech, porter; §7 rulings · 0". Housekeeping is absent; R-082 (REG:94, category **purchase**, pre-plan-authoring for 19a) and R-089 (REG:101, attendant PWA) are the rulings that sit on 19a authoring and are not named.
- R-094 is `scope`, so re-deciding is allowed — but the design must say it is changing 19a's ruled first consumer and why (the mission names phlebotomists/technicians; housekeeping has no consumer open — RM:414). Or keep housekeeping first and add the clinical pools as second consumers. As written, "19a" points at two different phases.

### R6 · E4 "11h-ii" and E5 "22-L" — no collision found (sound)
- `grep -rn '11h-ii\|22-L' docs` → 0. Roman sub-phase precedent exists on `main`: `2026-09-05-phase1-18a-iii-…md`, `2026-09-06-phase1-18a-iv-…md` (18a-ii is prose-only, RM:433). 11h's §6 (:543-562) "Routed to the owner — NOT this phase's" carries exactly the four items E4 takes; the §19 amendment was deferred "to 11g's close" (11h:7, :561-562) and never landed (`awk '/^## 19/,/^## 20/'` over the spec, grep `speech|cloudflare|audio` → 0). RM:428 "the voice scribe stays inert at 503" — E4-M3 keeps production unset and configures UAT only; state that RM:428 is read as production.
- 22-L: index:68 block 22 = 22/22a/22b; on disk 22a1, 22a2, 22cA–22cF (patient self-service). `22d` is used at 22-quality:537 (→ 28d) — D20 is right. doc 20:752 puts "the language pack" in Plan 22's open items; LA-5 (20:431) names `language_fallback` — the design's event name matches. `spoken_language|read_language|ui_language` → 0 on `main`. No second home.

---

## 3. Citations that are wrong (grepped)

### R7 · Edge row 21: "`deploy.sh` prints it and does not stop (`deploy.sh:542-545`)" — AMEND
There is no root `deploy.sh`; the file is `docker/prod/deploy.sh`, and lines 540-547 are the seed-inventory comment block (`seed:tariff … seed:membership`). The census runs at **`docker/prod/deploy.sh:663-666`**: `compose run --rm api node dist/scripts/standup-check.js all` → "standup:check reported RED rows (exit $?) — that is the to-do list for the department" (continues). The "report, not an abort" posture is documented at 11i:52 (`deploy.sh:498–517`, pre-#116 numbering). Same wrong citation is implied by E1-M2's `standup:check hospital` line — fine there, only row 21 cites a line.

### R8 · `speech.controller.ts` — path missing — note
Cited bare five times. It is `apps/core/src/kernel/inference/speech.controller.ts`; :33 `language: z.enum(["hi","en"]).default("en")`, :53 "never forwarded to a language model", :80 "user actors only", :89-90 coded 503 `speech_not_configured`, :103 the one `transcribe` call — all hold.

### R9 · "the 08:00 digest spec §16 assigns to the Digest Writer (spec:784)" — note
The Digest Writer is on the **T0** line, spec:783; :784 is the T1 line (SLA Chaser, Recall, Expiry Watchman).

### R10 · "`print_jobs.language` (table exists, `kernel/printing/printing.controller.ts`)" — note
The table is `printJobs` at `apps/core/src/kernel/db/schema/printing.ts:37` (columns include `document`, `destination`, `dedupe_key`; no `language`). The controller is not where the table lives.

### R11 · G5 / E5 refusal-localisation: the shipped precedent is uncited, and Plan 20 hands E5 more — note
- #131 (merged, `lane/lims-locale-parity`) added `apps/web/src/lib/error-strings.test.ts`: it reads the server's error-code list and asserts every code has an `en`/`hi` string (`pharmacyErrorText`, 32 codes, "five … had no string"); `en.json` already carries `materialsErrors` (:1425), `otErrors` (:1635), `pharmacyErrors` (:3038) namespaces. #130 ("a refusal is a sentence, not a blank") did the lab's reception 403. E5 cites only `materials.ts:739`'s `RuleCode` comment; the mechanism-plus-test is #131 and should be the pattern named, and the lab's namespace (`labErrors`) the deliverable.
- Plan 20 §6:130-132 hands "alert title/body English server prose" to "whichever phase takes the refusal-localisation work" — E5 should claim it or name who does. `lab-http.ts:74` raw-zod claim holds on `3f596e4`.

### R12 · G5 baseline "67 of 3,065 leaves" — note
Measured on `3f596e4` (`node` walk of `hi.json` vs `en.json`): **3,073** leaves, 67 non-Devanagari, 66 identical to English. The 67/66 pin holds; 3,065 is stale by 8. Pin the allowlist on 67, never on the total.

### R13 · G2 "no such runbook exists — four do" — note
`docs/runbooks/` on `main` has **five**: lab, pharmacy, radiation-safety, radiology, radiology-pacs (radiology merged as #140, CONTEXT.md:21); #157 (open) adds OT.

### R14 · D8 "R-110 timers adopted at their register defaults" as a Plan 20 row — note
REG:122 R-110 = "Escalation timers and interrupt list … | policy | **43** | pre-pilot". It is Plan 43's, not a roster policy row. R-071/072/067 (REG:83-84, :79) are 20's — those hold.

### R15 · D3 / E3 `agent_ledger` ownership — note
`SCOPE-registration-counter-remainder.md:40,56` say RC-6 (cited, holds); `apps/core/src/modules/opd/events.ts:224` says *"RC-4 owns the `agent_ledger` … and it does not exist yet"*. Two prose owners already; edge row 24 should name both so the "whichever reaches `main` first" rule covers the code comment too.

### R16 · Header "Read against `main-ro` @ `b04cbd9`" — note
`main-ro` is `3f596e4`; the design predates CONTEXT.md:36-43 and every finding in §1 follows from that.

---

## 4. Citations checked and holding (so the amendments above are the whole list)
Code: `envelope.ts:35` Actor union · `schema/events.ts:30` · `workflow/timers.ts:148-168` (`resolvedUserIds/fallback/fallbackExhausted`) · `alerts/consumer.ts:23,30,173-188` · `schema/auth.ts:91-100` agents · `auth/guards.ts:47-52,99-101` ("agents hold no permissions yet") · `inference/types.ts:9-11,17,32` · `printing.controller.ts:31` · `opd/escalation.ts:28-33` · `workflow/roles.ts:31-33` · `ot/lists.ts:26` (a comment — see R2) · `workflow/events.ts:35-45` · `schema/patients.ts:95` · `patients/types.ts:5` · `notify/templates.ts:2,17,19` · `notify/pump.ts:376-379` · `web/lib/i18n.ts:8-13,34` · `patients-api.ts:155` · `desk-one/session.ts:109` · `lab-report-print.tsx:132-144` · `voice-flag.ts:6-27` · `voice-button.tsx:16` · `opd-display.tsx:44-52` · `package.json:16` + `scripts/create-agent.ts` · `search/audit.ts:146-159` · `notify/events.ts:16-28` (no `language`) · `standup-check.ts:128-210,173` · `notify/consumer.ts:33,191` · `alerts/alerts.ts:9-14` · `approvals/worklist.ts` · `lab/sweeps.ts:247,266` · `desk/brief.ts` · `consult-scribe.tsx:30-38,91` (`{ audio }` only — language dropped, holds) · `workers-ai.ts:9-17` · `config.ts:170-172` · `lab-http.ts:74` · `materials.ts:739` · `i18n.test.ts:11-13`, `i18n-keys.test.ts` · `printing/render.ts:89-91,163,402,469-471` · `pharmacy/label.ts` grep `lang` = 0 · `desk-one/stages.tsx:786-792` · `notify/adapters.ts:11` · `opd/events.ts:303`. Absences: `tasks` table, `agent_permissions`, `agent_ledger`, `kernel/copilot`, `open_counter`, `scribe.*` events, `12a-0`, `11h-ii`, `22-L`, `spoken_language` — all 0 on `main`. `1a752e0` is an ancestor of `f211075` (FD-24 in production) — holds.
Docs: spec:776,778,780,786,839, §9:161-166, §19 no speech amendment · 12:158,174,193,511,514,541,598,603,624 · DPIA:3 ("0.2 DRAFT … not yet signed"),:5,:31-33,:66-72 · RM:278-300,336-337,400,414,428,440-441 · index:46,57,66,68,144,153,155 · REG R-006:18, R-059:71, R-067:79, R-071/072:83-84, R-094:106, R-127:139, R-131:143, R-133:145, R-262:274 (the "line = 12+nnn" rule holds) · 11h:135,341-342,350,525-526,552-560,686-688 · 20:225,233,427,431 · 16:300 K1 · 22-quality:537 · "Bhojpuri 36 mentions" (grep -o over the series → 36) · 11i:111 row 21 (Hindi seat, T6).

## 5. Amendment list (for the structured summary)
1. Delete E1-M1; move Plan 20's doc (#150) to E1 *Exists*; E1-M2's human act = the owner's approval line; fix §7 wk 3.
2. Rewrite E1 *Build/acceptance* in Plan 20's own names: 3 runtime files (seeds do not move), `whoIsOn`, `roster_periods`/`roster_assignments`, the `roster` module, T7's one census row (RED = flag on + unpublished); fix edge row 2; carry Plan 20 §7's phone-number ruling.
3. E3: name and retire the two prior Ops Copilot homes (12b "only if reopened" → this is the reopening, Plan 13 deployed; 12c's Lane-3 copilot stays 12c); add "commit H to `main`" to E3-M1 — a plan home cannot rest on an untracked file.
4. E6: either inherit 12c's three gates or move out of 12c; replace server TTS with doc 20 EQ-2's pre-rendered numeral clips (or overrule EQ-2 explicitly); give `announcements` one home (22-L).
5. E2: state that R-094's ruled first consumer (housekeeping) is being changed, and name R-082/R-089 as the rulings on 19a authoring — or keep housekeeping first.
6. Edge row 21 → `docker/prod/deploy.sh:663-666`.
7. Notes: full path for `speech.controller.ts`; spec:783 not :784; `print_jobs` → `schema/printing.ts:37`; cite #131 `error-strings.test.ts` + a `labErrors` namespace and claim Plan 20 §6's alert-prose handoff; leaves 3,073; five runbooks; R-110 is Plan 43's; `opd/events.ts:224` says RC-4; header → `3f596e4`.
