# VERIFY · P1 fabric + multilingual · lens = sequencing and absorption

Target: `wf/design/P1-fabric-multilingual.md` (232 lines, written 21:43 UTC 09-06 against `b04cbd9`). This pass re-measured against `main-ro`, which is now `3f596e4` (`git log -1`), and against CONTEXT.md's NIGHT UPDATE (:37-42). `RM` = `docs/superpowers/2026-09-06-ROADMAP-v2.md` · `index` = `…department-series/00-INDEX-AND-SYNTHESIS.md` · `P20` = `docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md` (merged overnight as #150, `d6c27ed`) · `11i` = `plans/2026-09-06-phase1-11i-the-stand-up-path.md` · `H` = the untracked Hermes brainstorm · `DPIA` = `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md`. Every code and PR claim below was re-grepped or re-listed in this session; the prior 22:10 verify at this path was read only after my own list was formed, and its findings that still stand are re-verified here with the overnight facts, not copied.

**Verdict: needs-amendment.** The skeleton holds — Plan 20 first and alone on the IPD path (RM:235-236, :400), 19a and 22-L pushed to Q-next with the roadmap's own reasons (RM:414), 12c to Q+2, documents before builds on the two DPIA-gated epics. What fails the lens: (a) the design's E1 is now aimed at a roadmap count that the authored Plan 20 corrected, and E1-M1 — which the design schedules for week 3 with "none" as its human act — is already done and held for the owner's line; (b) every G5 milestone in the pillar depends on a UAT that is held by the same owner's line, unnamed; (c) two builds are scheduled this quarter in lanes the roadmap has already sent to Track S, one of them before the gate that index §3 and RM §5 put on block 12; (d) one measurement egresses Class-2 audio before the law gate that governs it; (e) a runbook and three phase docs that acceptance cells cite are written by no milestone; (f) the deploy-day / config-before-guard / role-unheld rows are missing for E1's destination row, E3's route, E4's desk setting and E5's migration. No finding kills an epic; each changes a `depends_on`, a lane, a human-act cell, or adds a row.

---

## 1. Refutations

### F1 · E1-M1 is already done, its acceptance cell reads FAILED against the artefact, and E1-M2's human act is not "none" · **amend**

Design E1: *"No phase doc exists (`ls docs/superpowers/plans` → none for 20)"*; E1-M1 *"3 d · none (orchestrator approves)"*, acceptance *"§7 owner rulings · the doc · 0 (policy rows DECIDED)"*; §7 wk 3 *"E1-M1 — Plan 20 authored by R. Human act: none."*

- `docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md` exists on `main` (`git ls-tree origin/main`; commit `d6c27ed` "#150"). P20:3: *"Authored 2026-09-06 in lane `radiology`. FOR APPROVAL. NOT EXECUTED."* E1-M1 is a week-0 fact, not a week-3 milestone.
- P20 §7 (:134-141) carries **one** owner ruling — whether an on-call person's phone number lives in the system — *"it does not block T1–T3"*. The design's cell demands 0. Against the doc that exists, the cell is red on day one for a ruling the design never lists in its own §5 RULINGS table.
- CONTEXT.md:39: *"Plan 20 BUILD also waits on the owner's approval line (authoring is done)."* The orchestrator, which MISSION-BRIEF:29 authorises to *"do the needful"*, has chosen not to approve. So E1-M2's human act is **the owner's one-line approval of #150** — the same shape as RM:334's *"11i approval (owner: one line)"* — and the design's "none (orchestrator approves)" is contradicted by the orchestrator's own hold.

Fix: mark E1-M1 DONE (`d6c27ed`), rewrite its acceptance as "1 ruling, non-blocking for T1–T3, listed in §5", and give E1-M2 the human act "owner's approval line on #150". Add P20 §7's phone-number question to the RULINGS table (law: staff personal data under DPDP).

### F2 · E1-M2's Build and acceptance are aimed at the roadmap's count, which the authored doc measured and corrected · **amend**

Design E1 Build: *"the five runtime consumers + two seed scripts re-pointed (RM:337)"*; E1-M2 acceptance: *"a fixture asserting identical `resolvedUserIds` for all five"*; Build also lists *"census rows `roster_published_today`, `on_call_<role>_resolvable`"*, *"a digest line for `fallbackExhausted`"*.

- P20:28: *"3 runtime files + 2 seed scripts. `kernel/alerts/consumer.ts` (5 calls), `kernel/workflow/timers.ts` (2), `kernel/notify/consumer.ts` (1)"*. P20:29: the roadmap's list names `modules/ot/lists.ts`, *"which mentions the function in a comment and never calls it"*, and `roles.ts`, *"which is the DEFINITION"*. My grep agrees: `grep -rln usersHoldingRole apps/core/src` (non-test) = 5 files, of which `roles.ts` is the definition and `ot/lists.ts` a comment. P20 T3 (:100-102): *"The seed scripts do not move"*. The parity fixture must cover three, not five; the seeds stay static.
- P20 §6 (:126): *"Any change to `usersHoldingRoleAtScope` or `standup-check`'s two call sites"* is out of scope; P20 T7 (:116-118) adds **one** census row (resolver enabled + no roster published). The design's second row `on_call_<role>_resolvable` — which edge row 3 relies on to *"name the account"* of a deactivated holder — has no producer in the authored phase. `standup-check.ts:5,124,176` is where the excluded resolver is called.
- P20 has no digest line (`grep -c digest P20` = 0), no competency or credential tags (`grep -ci 'competenc|credential|tag'` = 0) — index:66 lists "credentials/competency tags" inside 20, and the authored doc dropped them without naming them in §6. **E2's dependency "Plan 20's competency tags for eligibility" therefore has no producer.**
- P20 D1 (:64-67): `roster` is *"its own kernel-adjacent module … app-and-worker"*. That is `kernel/modules/manifests.ts`, `app.module.ts` **and `worker.module.ts`** — three everyone-files (CLAUDE.md "Files that belong to everyone") the design's coordination list (`roles.ts`, `schema/index.ts`, `seed-roles`) omits, plus `kernel/alerts/consumer.ts`, which P20:36-38 itself names as *"the real coupling cost"*.

Fix: re-aim E1-M2 at P20 T1–T7 — parity over three call sites; one census row; delete the digest line or add it as a P20 task; either add competency tags to P20's §6 as out-of-scope and re-source E2's eligibility, or add them as a P20 task; complete the everyone-files list (manifests, app.module, worker.module, alerts/consumer, timers, notify/consumer, standup-check for T7).

### F3 · Every G5 milestone depends on "11i T3", which is held by the owner's line — a human act the design does not name · **amend**

E1-M3, E3-M3, E4-M3 `depends_on` = `11i T3`; E5-M4 `depends_on` = `11i T6`; E3 Deps *"11i T3 UAT"*; E4 Deps the same. All read as engineering.

- `gh pr list` now: #120 (T3, UAT target) MERGEABLE, #121 (T5) MERGEABLE, #122 (T6 docs) MERGEABLE, #119 (T7) MERGEABLE, #118 (T9) MERGEABLE, #117 (T8) CONFLICTING. CONTEXT.md:39: *"HELD by the orchestrator, deliberately, pending the owner's explicit line: #117–#122 (the 11i stack; landing it ratifies the 12:35 accidental deploy)"*. CONTEXT.md:21: no UAT container is running.
- 11i T3 (:244-266) is `deploy.sh`'s `HMIS_TARGET=uat`; T6 (:291-308) is the execution that dates `lab-go-live.md` — which today has 0 `## Executed` headings (measured over all five runbooks: lab 0, pharmacy 1, radiation-safety 0, radiology 0, radiology-pacs 0).

So the pillar's G5 column — four milestones — rests on one owner act that the design's "human act" cells never name. Under the design's own rule (§7: *"a slip reads as that act's slip"*), a UAT that never comes up would read as "the fabric is late".

Fix: in every `depends_on` that says `11i T3`/`11i T6`, add *"(held: owner's line on #117–#122, CONTEXT:39)"*, and put that line in the §5 RULINGS table as a **fact** the owner states — it is neither money nor law, but it is his by the orchestrator's choice.

### F4 · E3-M2 — a block-12 build this quarter, in a lane that is not free, before the gate index §3 and RM §5 set · **amend**

Design §7 wk 7–9: *"E3-M2 may start in the freed LIMS lane only if the counsel session is booked — else it stays authored."*

- **No freed LIMS lane.** RM:336 (wk 3): *"L: 11j closes, then L joins S (§0c.5)"*; RM:337 (wk 4–6): *"L is on S: pharmacy's UAT opening and the radiology census"*; RM:338 (wk 7–9): *"Fixes from the lab and pharmacy pilots are the build lanes' work now."* CONTEXT.md:23: L holds *"8 stacked PRs #125→#137, train frozen"* (three of which landed overnight as #137, #154 — the rest are still L's). RM §0c.5 (:176-181) is the sentence that sends L to S for the quarter.
- **The gate.** index:57: block 12 = *"agent runtime (slot when the DPIA is signed)"*. RM:428: *"No 12a agent runtime. DPIA v0.2 is counsel's."* DPIA:5 defines that runtime as *"agent grants, tool catalog, `InferenceClient`, prompt/playbook governance"*. E3-M2 builds `agent_permissions` (grants) and a ten-tool registry (catalog) — two of the four — and its `depends_on` is E3-M1 (an addendum *drafted*), with §7 relaxing it to *"the counsel session is booked"*. Booked is not signed. The design's §6 answer ("no in-house 12a runtime, no `complete()`") redefines the word rather than overriding the two sources.
- **Absorption.** RM:236: *"Everything else the lanes build this quarter comes out of the pilots, not out of the department series."* E3-M2 comes out of a brainstorm (H). And the design's own §6 last paragraph says Q-this = *"one substrate (E1), two documents (E3-M1, E4-M1) and one measurement (E4-M3)"* — then §7 schedules E3-M2 (10 d) + E3-M3 (4 d) + E4-M2 (4 d) inside the same 13 weeks.

Fix: E3-M2 `depends_on` = the Class-0 addendum **signed** (E3-M1 with its sign-off row filled), placed Q-next with E3-M3/M4; §7 wk 7–9 drops it and §6's summary becomes true. If the author wants it this quarter, one line must say it overrides RM:428 and index:57 and answer DPIA:5's definition.

### F5 · E4-M3 transmits Class-2 audio before the owner's §3-A accept · **amend**

E4-M3 `depends_on` = `E4-M2, 11i T3`. E4-M1 (owner accepts/refuses §3-A; counsel) gates only E4-M4.

- E4-M3's acceptance sets `SPEECH_*` on UAT and produces *"WER per clip and language"* on *"≥ 3 clips from a real counter"* — the bench (Build (b)) *"runs only with `SPEECH_*` set"*, i.e. it calls Cloudflare. `voice-flag.ts:6-11`: *"voice audio is Class 2 until the DPIA rules otherwise … any stage, any provider, ever"*; `speech.controller.ts:41-46` says the same for the route. DPIA:31-33: the carve-out is *"pending owner accept/refuse and counsel review"* and *"Workers AI is not region-pinnable to India today"*.
- The clips cannot be synthetic by the design's own rule (11h:688; edge row 23) and are recorded at a counter where utterances carry patient names — the exact reason §3-A exists.

Fix: E4-M3 `depends_on` adds E4-M1 **with the owner's accept line filled**; the recording (the human act) may precede, the transmission may not. A refusal closes E4 as "stays off — refused", which E4-M4 already knows how to write. Edge row 23 gains its sibling: *"the owner refuses §3-A; three clips exist; the bench never runs; §8 CLOSE records the refusal and the clips are deleted"*.

### F6 · E4-M2 — a lane the roadmap has closed, a server-side refusal that needs a desk identity that does not exist, and no config-before-guard line · **amend**

Design §7 wk 4–6: *"E4-M2 seams by the front-desk lane after FD-25's close (4 days)."* E4 Build (d) / edge row 14: *"the desk-level open-counter setting honoured by the palette and refused server-side … the server refuses a clip from that desk"*.

- **Lane.** RM:337: *"F closes its lane after the FD-25 close; F's capacity joins S for the pilots."* CONTEXT.md:41: F has 5 commits today on FD-26/27/28, *"NO remote branch, NO PR; the lane will push only on the owner's ask"*. F is not free in wk 4–6 and its unpushed work is a human-held gate of its own.
- **Absorption.** RM:428: *"the voice scribe stays inert at 503"* this quarter. E4-M2 edits `consult-scribe.tsx` (which posts `{ audio }` only, :91) and adds `scribe.suggestion_*` events for a route that answers 503 — a build whose only Q-this consumer is E4-M3, which F5 moves behind the owner's accept.
- **A capability that does not exist.** `grep -rni 'open_counter|openCounter|open-counter|desk_settings|deskSettings|desk_config'` over `apps/core/src`, `apps/web/src`, `packages/contracts/src` = 0. `kernel/db/schema/desk.ts` is `userDayFacts` (:35) — a per-user daily rollup, not a counter. `speech.controller.ts:80` refuses on `actor.type`, and the body (:30-34) is `{audio, language}` — nothing identifies a desk. A desk identity on the request is a new kernel concept (auth envelope, `search_audit`, the speech route), not four days in a web lane.
- **RM §3 rule 4 (:378-381):** *"a guard that needs configuration ships inert until the configuration exists, or its configuration surface ships one deploy earlier … Every phase doc from here states which of the two it chose."* E4 does not say what the server does when no desk carries the setting — refuse all (fail-closed, breaks E4-M3) or refuse none (the guard is theatre until someone configures it).

Fix: move E4-M2 to Q-next beside E4-M4. Keep Build (b), the bench script under `apps/core/scripts/`, as the Q-this engineering (1 d, any lane). Either make Build (d) a palette-side setting only (11h:350 asked for a *desk-level setting*; the desk is a browser) or make it its own kernel task with the desk identity named; either way write the rule-4 line.

### F7 · A runbook and three phase docs that acceptance cells cite are written by no milestone · **amend**

- **`docs/runbooks/ops-copilot-go-live.md`.** G2's instrument and E3-M3's acceptance (*"a dated `## Executed on UAT` in `ops-copilot-go-live.md`"*) both require it; the design notes it does not exist (*"four do"* — five now: lab, pharmacy, radiation-safety, radiology, radiology-pacs; #157 open adds OT). E3's Build list (H §7 items) does not include writing it; E1's Build does include `roster-go-live.md` (and P20 T7 :116 names "the runbook"). CONTEXT.md:42: *"Any document a roadmap item depends on must be checked to exist before it is named"* — the orchestrator lost a module to exactly this pointer last night.
- **Phase docs.** EXECUTE-METHOD §1 (:26-30): *"The phase document is the only phase-specific artifact."* E1 (E1-M1), E2 (E2-M1) and E5 (E5-M1) have an authoring milestone. E3 (12a-0), E4 (11h-ii) and E6 (12c-voice) have none, yet E3-M3 cites *"token audit · the phase doc"*, E4-M3 *"the phase doc's table"*, E6-M1 *"the phase doc"*. RM:334 shows what an authoring row costs the calendar: an approval line.

Fix: add `docs/runbooks/ops-copilot-go-live.md` to E3's Build (H T4's pack is its natural home) and three authoring rows — E3-M0 (12a-0 doc, from H), E4-M0 (11h-ii doc), E6-M0 (12c-voice doc) — each with a lane and the same "owner's approval line" human act F1 gives E1-M2.

### F8 · E5-M1 authored with no dependency for a department that has no runbook; E5-M3 sized for one lane across three others; E2's porters serve a department no calendar opens · **amend**

- **E5-M1** (§7 wk 7–9, `depends_on` "—"). The department 22-L serves is the front office (index:68, block 22). `ls docs/runbooks/` = lab, pharmacy, radiation-safety, radiology, radiology-pacs — **no front-desk runbook**, so no G5 artefact for the front desk can exist; RM:337 opens its six screens *"behind the same census"* (G1–G4 only). RM §0c.5 (:176-178): authoring while the department *"has not taken its first order on production … is the pattern this document exists to stop."* The Hindi-seat line the design's G5 baseline rests on (11i §2b row 21 :111; T6 :299 *"one seat run in Hindi"*) is T6b, NOT RUN and held (F3). E5-M4 depends on 11i T6; E5-M1 does not.
- **E5-M3** (8 d): `notification.sent.language` + fallback (`kernel/notify` — pump.ts:376-379 is the send-time branch), `print_jobs.language` + per-document policy (`kernel/printing`), a Hindi sig with pictograms (`modules/pharmacy/label.ts` — the pharmacy lane; pictograms are an asset job), lab refusals → `RuleCode` (`modules/lab/lab-http.ts:74` — the LIMS lane; P20 §6 :128-131 explicitly leaves alert prose to *"whichever phase takes the refusal-localisation work"*, so 22-L inherits the alerts bell too), `announcements(language)` (a new kernel table + the OPD display consumer, `modules/opd`). Named coordination: `patients`, `locales`, `printing`, `notify`. Unnamed: `modules/lab`, `modules/pharmacy`, `modules/opd`, `kernel/db/schema/index.ts`, and the alerts bell P20 hands over.
- **E2** Build names *"porters (Plan 31)"* as a first consumer. index:77: Plan 31 needs *"19a engine; 15's list (first consumer)"*; RM:414-418: *"not 29/31 (no consumer until 15 opens for real)"*; RM §2 never opens 15.

Fix: E5-M1 `depends_on` = 11i T6 executed (dated Hindi-seat line) **and** a front-desk seat walk on UAT — which needs a front-desk go-live runbook nobody has scheduled; name it as E5-M1's first deliverable or a precondition on S. Split E5-M3 into four owned rows (notify+print · pharmacy label · lab refusals + alerts bell · announcements+display) with their lanes, or size it ≥ 15 d. E2's first consumers = phlebotomy + radiology technician; porters when 15 passes G5.

### F9 · Missing edge rows — deploy-day, config-before-guard, role-unheld · **amend**

Present and correct: row 2 (E1 deploy-dark), row 21 (E1 `duty_manager` unheld), row 10 (E3 staging key vs production), rows 19/20 (session shapes), row 23 (clips never arrive). Missing:

| # | scenario | expected behaviour | artefact | milestone |
|---|---|---|---|---|
| a | **Config-before-guard, E1:** P20 T5's destination row lands on production and nobody has set it (the row is E1's to create — P20:32,40-44 measured it as a code constant, not an inherited config) | the ladder resolves to `duty_manager` exactly as `timers.ts` does today (P20 D2 :68-71, D6 :81-84); a census row `escalation_destination_set` RED with the screen that fixes it | census row + `escalation.triggered{fallback:true}` | E1-M2 |
| b | **Role-unheld, E1:** publication is *"a governed act"* (P20 D3 :72-75) and nobody holds the publish permission | no roster can be published; with the flag on, every escalation silently falls back and T7's census row is the only signal; add `roster_publisher_held` (G4) beside it | census row | E1-M2 |
| c | **Deploy-day, E3:** the `/mcp` route (H:135) reaches production through the weekly deploy with no `agents` row, no allowlist (H E2) | 401/403 for every caller by construction; the Caddyfile does not expose it until the runbook step that does | `caddyfile-parity.test.ts` + a 401 test | E3-M2 |
| d | **Role-unheld, E3:** D16 names *"global-halt authority per R-127's default"*; nobody on production holds it | the kill switch's human side is absent; census `agent_halt_authority_held` RED; no production key is created (row 10's rule extended) | census row | E3-M4 |
| e | **Deploy-day / config-first, E4:** E4-M2 deploys; no desk carries the open-counter setting | the phase states rule 4's choice (RM:378-381): recommended — the palette honours a browser-local setting; the server refuses nothing until a desk identity exists | the phase doc's rule-4 line + test | E4-M2 |
| f | **Deploy-day, E5:** 22-L's migration lands; `languages` and `announcements` are empty; `patients.read_language` is NULL on every existing row while `patients.language` stays `notNull().default("hi")` (`schema/patients.ts:95`) | the pump reads `patients.language` exactly as today (`pump.ts:376-379`); zero `language_fallback` rows — an empty registry is not a fallback; census `languages_registry_populated` | `notification.language_fallback` count = 0 on deploy day; census row | E5-M2 |
| g | **Ops act, E5-M4:** the relay (`kernel/printing/render.ts:19-32` — *"the relay turns HTML into paper"*) is on `main` as code but installed on no UAT desk PC; row 17 assumes a relay PC exists | the seat drill's print step is recorded "relay not installed" and the runbook line names the install as an ops act, not a defect | runbook line | E5-M4 |

### F10 · E3-M1 + E4-M1 in wk 1–2 "by the roadmap/commissioning lane" · **note**

CONTEXT.md:23: the roadmap lane is *"(history)"*; roadmap-v3 is this brainstorm. The commissioning lane's wk 1–2 (RM:334-335) is T1/T4/T2/T8/11j, T7 written, the drill rehearsal, then UAT and the lab on UAT — and today that lane's whole stack is open and held (F3), so its first fortnight is spent re-landing it. Two document tasks on S in that fortnight compete with the only act that closes 11i. Assign E3-M1/E4-M1 to the parked pharmacy worktree or to wk 3+.

### F11 · E1-M4's 30-day window does not fit wk 10–13, and RM:400's condition is "live", not "G6 for 30 days" · **note**

Wk 10 begins Mon 2026-11-09; wk 13 ends Sun 2026-12-06; thirty days from a wk-10 deploy is 2026-12-09. RM:400 (§4) reads *"Plan 20 roster live"* and RM:339 *"20 live"* as the IPD condition. Split E1-M4 into "live on production" (the IPD gate reads this; wk 10–13) and "30-day parameter read" (Q-next), and start the 30 days at the first `escalation.triggered` on production after the flag flips — production has ≈ 500 events and no real patient (CONTEXT.md:20-21), so a window started at the deploy can close on a denominator of 0.

### F12 · E3-M2's 10 d ignores H's own stop-loss; three more everyone-files · **note**

H:201: *"this is a one-phase plan if T3 is held to ten tools. If authoring finds the billing or OPD aggregates need new event consumers, T3 splits out and the plan becomes two."* Unnamed everyone-files for `kernel/copilot`: `kernel/modules/manifests.ts`, `test/caddyfile-parity.test.ts` (`/mcp`), `apps/web/src/router.tsx` + `locales/*.json` (`/admin/agents`). `agent_ledger`/`agent_permissions` appear on `main` only in comments (3 files); `kernel/copilot` does not exist — the design is right about that.

### F13 · Two naming collisions a reader will trip on · **note**

(i) Goal ids G1–G5 vs the roadmap's gate ids G1–G7 (RM:351-367): E1 *"Gates: G1–G5 for 20 itself"* is ambiguous. (ii) 22-L sits in block 22 whose index row (:68) needs *"13; Plan 10 public surface; PBX bought; R-216–R-227"*; the design should say in one line that the letter inherits none of those (languages need no PBX) so a reader of index §3 does not see a Track C plan built under unmet block prerequisites.

### F14 · E3-M4's gate is named "the Class-0 addendum"; the roadmap's word for the same act is "DPIA v0.2" · **note**

RM:405 (§4): *"DPIA v0.2 | law (counsel) | one counsel session (R-262) | … yes for 12a"*; CONTEXT.md:28: *"Nothing with inference runs on production before DPIA v0.2 (counsel)."* D4's split is a document-structure decision (defensible) but E3-M4 must name both words — "the Class-0 addendum, i.e. the part of DPIA v0.2 that covers this activation" — so the act is recognisable from RM §4, and must say whether counsel's *one* session (R-262) is expected to produce both the addendum and the §3-A ruling, since E4-M1 books the same session.

---

## 2. What holds (checked, not refuted)

- **E1 first, alone on the IPD critical path, flag + static fallback**: RM:235-236, RM:400, RM Q4 :278-300; P20 D2 (:68-71) confirms `ROSTER_RESOLVER_ENABLED` (design D11); the constant is nowhere in code yet (grep = 0), as expected before build.
- **E2 (19a) Q-next**: RM:414 *"no consumer opens this quarter"*; E2-M1 depends on E1-M4; index:153 puts the kernel task entity in 19a.
- **E6 (12c) Q+2 behind E4-M3 and E5-M2**: consistent with index:57 and the design's own D14.
- **Human acts named where the design saw them**: E3-M3 (second server H:182; provider DPA H:183), E3-M4 (counsel; Telegram pairing), E4-M1 (§3-A; counsel), E4-M4 (both signatures), E5-M3 (WABA), E6-M1 (vendor), F4 (the names, RM §0c.4 :167-174). *"Nothing else waits on"* the second server is right: RM:440-441 keeps UAT on this box.
- **Not-this-quarter items kept**: no `InferenceClient.complete()` (`kernel/inference/types.ts:9-11`); `VOICE_SEARCH_ENABLED=false` through the quarter (E4-M4 is Q-next); no third-language UI (D6).
- **The chaser-destination "Exists" claim is wrong but the Build is right**: P20:32 measures it as a code constant and P20 T5 (:108-111) makes it a row — the design's Build includes *"the chaser destination config row"*; only the Exists cell and edge row 1's phrasing need the word DECIDED, not "exists".
- **Lab raw-zod site** = 1 (`modules/lab/lab-http.ts:74`) as the design says.
- **Edge rows 2, 10, 19, 20, 21, 23, 24** model deploy-dark (E1), staging-vs-production keys (E3), the asleep-owner session, the flag-flip session, the unheld `duty_manager`, the never-arriving clips and the `agent_ledger` double-mint (H:172 C1) correctly.

---

## 3. Amendments, in the order to apply them

1. **E1 against the authored doc** (F1, F2): E1-M1 DONE (`d6c27ed`), acceptance "1 ruling, non-blocking"; E1-M2 human act = the owner's approval line on #150; parity over three runtime call sites, seeds static; one census row; digest line and competency tags either become P20 tasks or leave the design (and E2's eligibility is re-sourced); everyone-files list completed (manifests, app.module, worker.module, alerts/consumer, timers, notify/consumer, standup-check).
2. **Name the UAT hold** (F3): every `11i T3`/`11i T6` dependency carries "(held: owner's line on #117–#122)"; add that line to §5 as a fact the owner states.
3. **§7 must match §6** (F4, F6): Q-this = E1 + E3-M1 + E4-M1 + E4-M3's *recording* + the bench script. E3-M2/M3 and E4-M2 move to Q-next; E3-M2 `depends_on` = the Class-0 addendum **signed**.
4. **E4-M3 `depends_on` adds E4-M1 with the accept line filled** (F5); sibling of row 23 for the refusal.
5. **E4 Build (d)**: palette-side only, or its own kernel task with a desk identity; write RM rule 4's line; G3's and E4-M3's "per desk" become "per actor" until then (F6).
6. **Add the runbook and the three authoring rows** (F7): `ops-copilot-go-live.md` in E3's Build; E3-M0, E4-M0, E6-M0 with lanes and the approval-line human act.
7. **E5-M1 `depends_on` = 11i T6 executed + a front-desk seat walk on UAT**, naming the missing front-desk runbook; split E5-M3 into four owned rows incl. the alerts bell P20 hands over; E2 drops porters until 15 passes G5 (F8).
8. **Add the seven edge rows in F9** (destination row absent, roster publisher unheld, `/mcp` before keys, halt authority unheld, E4 rule-4 line, E5 NULL read_language deploy day, relay install as an ops act).
9. Notes: E3-M1/E4-M1 off S's first fortnight (F10); split E1-M4 "live" from "30-day read" and start the window at the first production escalation (F11); H's stop-loss + copilot everyone-files (F12); rename goals and add 22-L's one-line inheritance note (F13); E3-M4 names "DPIA v0.2" beside "addendum" and says what R-262's one session must produce (F14).
