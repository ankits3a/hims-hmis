# P1 fabric + multilingual — MEASURABILITY verification

Lens: measurability. Target: `wf/design/P1-fabric-multilingual.md`. Verified against `main-ro` @ `3f596e4` (the checkout has moved on from the design's `b04cbd9`; where a cited line drifted I give the current one). Every claim below was grepped or read tonight; nothing was run.

**Verdict: needs-amendment.** No parameter is unmeasurable in principle (no kill). Eleven need an instrument or threshold change; the rest are wording. The two structural problems: (1) **G1's instrument cannot tell a roster answer from a one-user hospital** and covers only one of the three escalation mechanisms that exist; (2) **the merged Plan 20 phase doc already exists and contradicts E1's table/resolver/consumer names**, so E1-M1's acceptance would fail against the document it is supposed to produce.

---

## 1. What is REAL (confirmed by grep) — the design's honest half

| instrument | where | verdict |
|---|---|---|
| `escalation.triggered{resolvedUserIds,fallback,fallbackExhausted}` | `apps/core/src/kernel/workflow/events.ts:34-45`; written at `kernel/workflow/timers.ts:148-168` | REAL. One producer only (timers.ts:158). |
| `events.actor_type` column | `kernel/db/schema/events.ts:31` | REAL. |
| `agents` table + `kill_switch` | `kernel/db/schema/auth.ts:91-100`; `kernel/auth/agents.ts:26` | REAL, but the kill switch is **not evented** (a plain `update`), contrary to spec:788 "itself evented". |
| `pnpm agent:create` / `scripts/create-agent.ts` | `apps/core/package.json:16` | REAL. |
| `search_audit.source='voice'`, egress row written before the call | `kernel/db/schema/search.ts:49`; `kernel/search/audit.ts:146-163` | REAL. **No terminal/desk column** — `actor_id` only (search.ts:35). |
| `POST /speech/transcribe` 503 before the egress row | `kernel/inference/speech.controller.ts:87-90` (503) precedes `:98` (egress) | REAL; baseline "0 rows" holds. |
| `VOICE_SEARCH_ENABLED=false` constant | `apps/web/src/lib/voice-flag.ts:27`; `voice-button.tsx:16` | REAL. |
| scribe posts `{ audio }` only | `apps/web/src/components/consult-scribe.tsx:91` | REAL (language hint dropped). |
| `standup:check <module>` with a `hospital` block; `second_administrator` row | `apps/core/scripts/standup-check.ts:126-172` (row at :168-172, not :173); `:470` `process.argv[2]` | REAL. |
| `deploy.sh` runs the census and does not stop | `docker/prod/deploy.sh:663-668` (not `:542-545`, which is a seed comment block) | REAL; cite drifted. |
| `alerts` rows carry `user_id` + `source_event_id` | `kernel/db/schema/alerts.ts:13-24` | REAL — and it is the **nearest instrument** for the chasers (see G1-b). |
| `lab_orderables.tat_minutes_routine` | `kernel/db/schema/lab.ts:70` | REAL, but the wrong quantity for E2-M3 (see below). |
| `print_jobs` table | `kernel/db/schema/printing.ts:38-62` | REAL; no `language` column (design says so). |
| `notification.sent` carries no language | `kernel/notify/events.ts:16-28` | CONFIRMED. |
| `patients.language` text default `'hi'`; API enum `hi\|en` | `kernel/db/schema/patients.ts:95`; `modules/patients/patients.controller.ts:80` | CONFIRMED — `bho` is refused at the API, not the column. |
| hi.json non-Devanagari leaves | re-measured: **3,073 leaves** (design: 3,065 — eight added since `b04cbd9` by #123/#126/#130/#134), 67 non-Devanagari, 66 identical to en, the 67th is `app.language` (the switcher label, correct) | CONFIRMED (67/66); leaf total stale by 8. **No allowlist test exists** — `apps/web/src/lib/i18n.test.ts:11-13` pins key parity only; grep `Devanagari` in `i18n*.test.ts` = 0. |
| lab raw-zod refusal | `modules/lab/lab-http.ts:72-76` — ONE helper `parsed()`; the "exactly one of encounterNo or walkIn" message is `lab-desk.controller.ts:81` | CONFIRMED. |
| DPIA single file, v0.2 DRAFT, §3-A pending, sign-off empty | `docs/compliance/2026-08-23-dpia-agentic-runtime-v0.1.md:3,31-33,66-72`; sections are 1–8 + 3-A (no §3.4) | CONFIRMED. |
| spec has no speech amendment | grep `speech-to-text\|Cloudflare\|whisper\|ASR` over the spec = 0; §19 at `:818` | CONFIRMED; E4-M1's grep is a real, falsifiable instrument. |
| `usersHoldingRole` non-test files | `ot/lists.ts` (comment only), `workflow/timers.ts`, `notify/consumer.ts`, `workflow/roles.ts` (definition), `alerts/consumer.ts`, `scripts/seed-ops.ts`, `scripts/seed-roles.ts` | Three runtime callers + two seeds — **matches Plan 20 §2, not the design's "five runtime"**. |

Hypothetical (minted by the epics, correctly labelled as build in the design, but listed as *instruments* in §1): `agent_ledger`, `copilot.tool_called`, `digest.fact_sheet`, `agent.kill_switch_set`, `roster_publications`, `roster.unpublished`, `roster_published_today`, `on_call_<role>_resolvable`, `coverage.proposed/applied`, `tasks`, `task.*`, `scribe.suggestion_*`, `open_counter`, `speech-bench.ts`, `notification.sent.language`, `notification.language_fallback`, `print_jobs.language`, `patients.spoken_language`, the 67-leaf allowlist test, `docs/runbooks/ops-copilot-go-live.md`, `roster-go-live.md`. All grep = 0 on `3f596e4`.

---

## 2. Refutations — north-star parameters (§1)

### G1 · One named human

**G1-a (amend) — the baseline "0 % single-holder by construction" is false, and the instrument cannot detect the thing it targets.** `resolvedUserIds` is `usersHoldingRole(tx, role)`, deduped and sorted (`roles.ts:31-33`). Its length is 1 whenever exactly one user holds the rung role — the normal state of a production with ONE administrator (CONTEXT:21) and seeded roles. So the share of length-1 rows today is not 0 %; it is whatever the static holder count happens to be, and after Plan 20 lands the same number cannot say whether the roster picked one person or one person exists. **The event needs a discriminator** — `resolvedBy: 'roster' | 'static'` or `rosterPeriodId: string | null` in the `escalation.triggered` payload — added in Plan 20 T2/T3 (`docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md:95-102`, which today specifies only a parity test). Then G1 = share of rows with `resolvedBy='roster'` and `length=1`.

**G1-b (amend) — "every escalation and chaser" is measured for one of three mechanisms.** Only `timers.ts:158` emits `escalation.triggered`. The radiology chasers resolve recipients directly — `handleImagingCriticalOverdue` and `handleImagingReportUnread` call `usersHoldingRole(tx, DUTY_MANAGER_ROLE)` at `kernel/alerts/consumer.ts:300,322` and emit nothing that records the resolution; `handleNotificationFailed` does the same at `:229`. The lab's critical ladder is a **phone log with a three-rung enum and free-text contact** (`modules/lab/criticals.ts:49-62`) — it resolves no role at all, so RM:283-284's "rings everyone holding a role" describes code that does not exist, and Plan 20 T5 (`:108-111`) would be adding a mechanism, not re-pointing one. **Nearest real instrument for the chasers:** `alerts` rows grouped by `source_event_id` where the source is `imaging.critical_overdue` / `imaging.report_unread` (`modules/radiology/events.ts:162,167`) — recipients per source event = 1 is the G1 condition. Name both SQLs.

**G1-c (amend) — the threshold has no denominator floor and the reader is a Q-next artefact.** "≥ 90 % within 30 days" on a production with ≈500 events and no patients (CONTEXT:21) may divide by zero. State a floor ("over ≥ 20 escalations in the window, else NOT MEASURED — N reported"). "Who reads it: duty manager (digest line); owner (08:00 digest, G2)" — the digest is E3-M4, Q-next; G1 lands Q-this. The reader for Q-this is the SQL plus Plan 20 T7's census row (`standup:check hospital`), not a digest.

### G2 · The first agent acts under governance

**G2-a (amend) — "digest delivered days per 30" is not an HMIS-recorded fact.** Delivery happens on the second server into Telegram; HMIS can record only that `digest.fact_sheet` was *served* (`agent_ledger` row, H:147). Restate: `agent_ledger` rows with `action='digest.fact_sheet'`, `outcome='ok'`, one per IST day, ≥ 27/30; Telegram is the human cross-check, not the instrument. Same for E3-M3 "Telegram + ledger · 7/7" and E3-M4.

**G2-b (amend) — "0 scrubber leaks" is an absence claim the system cannot produce.** A leak, by definition, wrote no `scrubbed:true` row (memory: *absence tests vs revert pairs*). What is measurable: the fail-closed count (`outcome='refused'`, reason `class_violation`) reported per day, plus a fixture test that seeds a phone number into a ward label and asserts refusal (edge 8). Keep "fail-closed count reported"; drop "0 leaks" as a parameter.

**G2-c (note) — `events.actor_type='agent'` needs an `actor_id` filter.** The print relay also authenticates as an agent (`kernel/printing/printing.controller.ts:29-43`); today it appends no events (grep `appendEvent\|.make(` in `kernel/printing/*.ts` = 0), but any future relay event would count as "the first agent acting". Filter by the Hermes agent's `agents.id`.

**G2-d (note) — baseline understates one gap:** the kill switch exists but is **not evented** (`kernel/auth/agents.ts:26` is a bare update; spec:788 requires "itself evented"). E3-M2's `agent.kill_switch_set` is the right build item; the baseline row should say "kill switch: column only, no event".

### G3 · Speech exposure measured before widened

**G3-a (amend) — "rows/day/desk" and E4-M3 "SQL per desk" are not computable.** `search_audit` carries `actor_id` (search.ts:35), no terminal or session column; `recordVoiceEgress` (`audit.ts:146-163`) takes `{actor, audioBytes}` only. The session does know its terminal (`kernel/auth/sessions.ts:12` `terminalId`; `decorators.ts:6` `hmisSession` on the request), so the fix is one column: add `terminal_id` to `search_audit` in E4-M2 and pass `req.hmisSession.terminalId`. Until then, measure per actor.

**G3-b (note) — WER is falsifiable (D5 ≤ 25 %) but the instrument is prose.** `speech-bench.ts` does not exist (`apps/core/package.json` scripts, `apps/core/scripts/`); the phase doc's table is a dated-document instrument, which CONTEXT:30 permits. Three clips is a smoke test, not a measurement — say "≥ 3 to flip the UAT switch, ≥ 50 per language before any production flip (D14)" so the two numbers are not read as the same bar.

**G3-c (note) — edge 11's artefact is ambiguous.** An egress row with `raw_query=''` is what the VAD filter leaves AND what a provider failure mid-call leaves (`attachTranscript` never runs on the throw at `speech.controller.ts:100-104`). `search_audit` has no outcome column. If edge 11 must be provable from the row, E4-M2 adds `outcome` (`ok|empty|provider_failed`).

### G4 · Language-neutral surfaces

**G4-a (amend) — the baseline "8 sites" is an undercount, and the CI grep has no pattern.** A strict grep for `"hi" | "en"` / `"en" | "hi"` / `z.enum(["hi","en"])` (either order) over `apps` + `packages`, non-test, returns **14 lines: 12 code + 2 comments**. The design's list misses `apps/web/src/screens/patient-detail.tsx:213`, `apps/core/src/modules/patients/patients.controller.ts:80` (the enum that actually refuses `bho`), `apps/core/src/modules/patients/events.ts:26` (the `patient.registered` **event contract** — widening it is a versioned-event change, not a literal swap), and `apps/core/src/kernel/inference/speech.controller.ts:33` (which the design cites elsewhere, at E4). Pattern-adjacent sites the grep would not catch: `apps/web/src/lib/i18n.ts:9` (`resources: { en, hi }`), `opd-display.tsx:48,50` (`hi-IN`/`en-IN`). Since "sites → 1 registry" and E5-M2's "0 outside the registry" are only as good as the pattern, the 22-L phase doc must state the regex and its exclusions, and the baseline must be re-measured against it. Target "sites → 1" should read "0 matches outside `kernel/languages/`".

**G4-b (note) — "100 % of patient sends carry `language`" measures the schema, not behaviour.** `pump.ts:378` always knows the language at send; once the field exists on `notification.sent` the share is 100 % by construction. Keep it as a pin (a test), not a north-star; the north-star is the fallback share per language.

**G4-c (note)** — `patients.spoken_language` and `notification.language_fallback` are minted by E5-M2/M3 and correctly described as such; the "baseline today" column says 0 for a column that does not exist, which is honest but should read "NOT RECORDABLE".

### G5 · A Hindi seat with zero defects

**G5-a (amend) — "defect" is undefined for the Hindi seat, so "0" is the walker's judgment.** 11i T6 (`docs/superpowers/plans/2026-09-06-phase1-11i-the-stand-up-path.md:291-305`) defines a defect as "a step that cannot be performed as written" and names "one seat run in Hindi", but no Hindi-specific defect class; the runbook's §9 harvest table (`docs/runbooks/lab-go-live.md:214-224`) counts lab events, not language. Define three countable classes for T6's Executed section: (a) an English string visible on a Hindi screen whose key is not in the 67-leaf allowlist; (b) a refusal rendered as raw zod text (`issues[...]`) rather than a locale string; (c) a printed page with tofu boxes. Then "0 defects" is falsifiable.

**G5-b (note)** — "67 of 3,065" → 3,073 leaves on `3f596e4` (67/66 unchanged). The "allowlist test green at 67" instrument does not exist; it is E5-M4's build item (`i18n.test.ts:11-13` pins parity only). Say "allowlist test (E5-M4) green at 67".

**G5-c (note)** — the `RuleCode` pattern is defined at `apps/core/src/modules/materials/qc.ts:40-55`, not `kernel/db/schema/materials.ts:739` (that line is a column comment naming it).

---

## 3. Refutations — acceptance parameters (§3) and edge artefacts (§4)

**E1-M1 (amend) — the milestone is already done and its acceptance would fail against the artefact.** `docs/superpowers/plans/2026-09-06-phase1-20-workforce-roster.md` exists on `main` (#150; `:3` "FOR APPROVAL. NOT EXECUTED."). Its §2 (`:24-47`) measures **3 runtime files + 2 seed scripts**, says `modules/ot/lists.ts` "mentions the function in a comment and never calls it" and `roles.ts` is the definition, and T3 (`:100-102`) says **the seed scripts do not move**. The design's acceptance — "names the five runtime consumer files + two seed scripts and the flag" — is therefore false against the doc that exists. Rewrite E1-M1 as "Plan 20 approved (the owner's approval line, per NIGHT UPDATE)" with acceptance "§8 CLOSE opened; the three runtime files + flag named (they are, `:100`)". Human act: the owner, not "none".

**E1 "Exists" row (amend) — "the chaser destination as a config row" is refuted by the phase doc and the code.** Plan 20 §2 (`:35`): "a CODE CONSTANT, not a configuration row"; `kernel/alerts/consumer.ts:300,322` call `usersHoldingRole(tx, DUTY_MANAGER_ROLE)`. Making it a row is Plan 20 **T5** (`:108-111`). E1-M4's "chaser destination · the config row" is minted by T5 — say so, and drop the row from "Exists".

**E1-M2/M3 (amend) — instrument names do not match the phase doc.** Design: `roster_publications`, `resolveOnDuty(role, at)`, census `roster_published_today` + `on_call_<role>_resolvable`, events `roster.unpublished`, `coverage.proposed/applied`. Plan 20: `roster_periods` (draft/published/superseded) + `roster_assignments` (`:91-93`), `whoIsOn(tx, roleKey, at)` (`:95-98`), **one** unnamed census row (`:117-120`), **no event names at all** (grep `roster\.\|coverage\.` in the doc = 0). Either align E1's instruments to the doc (E1-M3 "a week's roster · `roster_periods` where `status='published'` · 1 row") or state that this design adds the census/event names to Plan 20 before build. Edge rows 2, 3, 4 and 21 inherit this: edge 21's "census RED for duty_manager" has no row today (`standup-check.ts` codes: none for `duty_manager`; `seed-ops.ts:164-170` prints a count, which is a script line, not a census row).

**E1-M2 (amend)** — "a fixture asserting identical `resolvedUserIds` for all five" → three (Plan 20 T2's parity test, `:95-98`).

**E2-M3 (amend) — the threshold is mis-aimed.** "`claimed→completed` p50 ≤ the orderable's `tat_minutes_routine`" compares a collection round against the **order-to-report** TAT (`lab.ts:70`; `catalogue.ts:185` validates it > 0) — a bound the round meets trivially. The right quantity is the workflow's `awaiting_collection` state SLA, which already exists as data (`modules/lab/sweeps.ts:18-19` builds `slaByState` from the definition). Use that.

**E5-M3 (amend) — the lab-refusal grep pins the wrong layer.** "grep `BadRequestException(r.error.issues)` in `modules/lab` · 0" is satisfied by renaming the one helper (`lab-http.ts:72-76`) with no change to what a Hindi seat sees (memory: *a test can pin the wrong layer*). Assert the wire: POST a body with both `encounterNo` and `walkIn` → 400 whose body has a `code` and no `issues` array (the message today is `lab-desk.controller.ts:81`), and the web renders a locale key for it.

**E5-M5 (amend)** — "fallback per language · digest · trend to 0" is not a threshold. State one: "`notification.language_fallback` / patient sends per language < 5 % in the last 7 of 30 days, by SQL; reported in the digest when E3-M4 exists".

**E4-M4 (note)** — "production voice rows/day · reported weekly": nothing reports weekly today; the SQL is the instrument, the digest (E3-M4) is the reader.

**E4-M2 (note)** — "open counter · server 403" is buildable (`req.hmisSession.terminalId`, `sessions.ts:12`) but no terminal attribute marks an open counter (grep `open_counter\|openCounter` = 0); E4-M2 must add it, and the acceptance should name where (a `terminals` column or an ops config row).

**E3-M1 (note)** — "the §3.4 assertion site (H:126)": the DPIA has no §3.4 (its sections are 1–8 and 3-A); §3.4 is the Hermes brainstorm's own numbering. Write "H §3.4".

**E3-M2 (note)** — `agent.kill_switch_set`: correct build item; see G2-d for the baseline gap it closes.

**E3-M3 (note)** — "token audit · the phase doc · one week's figure": a prose figure; acceptable as a dated document, but say what is counted (tokens per digest, per question) so a second week can be compared.

**Edge 4 (note)** — `coverage.proposed` without `coverage.applied`: Plan 20 T6 (`:113-115`) names no event; add both to the phase doc or the edge row has no artefact.

**Edge 10 (note)** — "staging keys are prefixed": `createAgent` mints an unprefixed random key (`scripts/create-agent.ts:7`; `kernel/auth/agents.ts`); a prefix is a build item for E3 T1 and should be listed in E3's Build line.

**Edge 24 (note)** — `agent_ledger` is minted by whichever of RC-6 / 12a-0 lands first (H:172); the only real footprint today is three comments (`opd/events.ts:224`, `keyboard.tsx:137`, `keyboard.test.tsx:162`). Fine.

---

## 4. Does any parameter reduce to "tests pass" or "owner is satisfied"?

- E1-M2 "consumers unchanged with flag off · a fixture · pass" and E2-M2's four cells are **test-shaped** — acceptable at a G1-merged milestone, and each names a concrete assertion, so no.
- G5 "0 defects at T6" reduces to the walker's judgment until G5-a's classes are written — **yes, today**.
- G2 "0 scrubber leaks" reduces to "nothing was noticed" — **yes, today** (G2-b).
- E6-M1 "the owner picks the vendor" is a procurement act, correctly outside the parameter.
- Nothing reduces to "owner is satisfied".

## 5. Baseline honesty — the stale rows

| design says | measured on `3f596e4` |
|---|---|
| "No phase doc exists" for Plan 20; E1-M1 3 d | exists, #150, FOR APPROVAL NOT EXECUTED |
| chaser destination "as a config row" exists | a code constant (`alerts/consumer.ts:300,322`); Plan 20 T5 |
| "five runtime consumers + two seed scripts re-pointed" | three runtime + seeds stay (Plan 20 §2, T3) |
| 8 `hi\|en` sites | 14 lines (12 code + 2 comments) on a stated pattern |
| 3,065 hi.json leaves | 3,073 |
| 0 % single-holder "by construction" | undefined today; length-1 is common with one holder per role |
| kill switch exists (implied evented) | column only, no event |
| `deploy.sh:542-545`, `standup-check.ts:173` | `:663-668`, `:168-172` |

## 6. Minimal events/columns to add, and where

| add | to | in plan |
|---|---|---|
| `resolvedBy: 'roster'\|'static'` (or `rosterPeriodId`) on `escalation.triggered` | `kernel/workflow/events.ts`, `timers.ts` | Plan 20 T2/T3 |
| recipient count per `imaging.*` source event — SQL over `alerts` (no schema change) | — | Plan 20 T5 acceptance |
| `terminal_id` (+ `outcome`) on `search_audit` | `kernel/db/schema/search.ts`, `search/audit.ts` | 11h-ii (E4-M2) |
| `agent.kill_switch_set` event | `kernel/auth/agents.ts` | 12a-0 T1 |
| the CI grep pattern for literal languages, stated once | the 22-L phase doc | E5-M1 |
| `roster.unpublished`, `coverage.proposed`, `coverage.applied`, the census row's code | Plan 20 phase doc §5 | before E1-M2 |
| Hindi-seat defect classes (a)(b)(c) | 11i T6's Executed section template | 11i T6 |
