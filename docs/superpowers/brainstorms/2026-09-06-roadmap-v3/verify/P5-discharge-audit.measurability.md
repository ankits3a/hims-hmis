# P5 discharge-audit — MEASURABILITY verification

Target: `wf/design/P5-discharge-audit.md`. Lens: is every north-star and acceptance parameter measurable from something the system records, is the instrument real, is the threshold falsifiable, is "baseline today" honest, does anything reduce to "tests pass" / "owner is satisfied".

**Measured at `origin/main` = `41a4be4` (fetched 2026-09-08; `91c34fc` is its parent — one commit later, #118 11i T9).** Every repo claim below was re-read at that tip with `git show origin/main:<path>` / `git grep … origin/main`; the checkout's own HEAD (`ff07cbc`) was not used. Paths repo-relative; `core` = `apps/core/src`.

**Verdict: needs-amendment.** No parameter is unmeasurable in principle (no kill). Eleven need a different instrument, threshold or baseline; the design was written against `b04cbd9` and three of its baselines were overtaken by #157/#164 on 09-07. The doc citations (SPEC, IPD, K11, REG, DPIA, RM, Q22, IDX, P15, KD, plan-series) all verify — line numbers hold within ±2.

---

## 1. What is REAL (verified — the design's instruments that exist)

| instrument | where | note |
|---|---|---|
| `workflow_transitions{from_state,to_state,at}` | `core/kernel/db/schema/workflow.ts:67-80` | G1, E1-M4, E1-M5 |
| `events.occurred_at` / `recorded_at` / `actor_type` | `core/kernel/db/schema/events.ts:28-30` | Actor = `user|agent|system|patient` (`packages/contracts/src/envelope.ts:35`) |
| `sla.breached{instanceId, defKey, definitionVersion, state, slaMinutes, alerting, dueAt}` | `core/kernel/workflow/events.ts:20-31` | carries `defKey`+`state`, so `{daycare_case, discharge_ready}` is a real filter; fires for `record_only` states too (`timers.ts:120-133` records regardless, only the ladder is gated) — so D12's countersign clock IS measurable |
| `escalation.triggered{rung, role, fallback, fallbackExhausted}` | `events.ts:34-46`; emitter `timers.ts:150-165` | G5, edge 8 |
| `daycare_case` definition, `discharge_ready` 120 min ACTIVE | `core/modules/ot/workflow-def.ts` (`DAYCARE_CASE_DEF_KEY`, states list) | G1 |
| dispatcher 2 s / timers 20 s | `core/kernel/config.ts:53-54`; `worker/jobs.ts:199-207` | D4 |
| `daycare.discharged{encounterId,patientId,bayResourceId,at}` | `core/modules/ot/events.ts:84-86`; emitter `recovery.ts:491`; zero consumers outside `modules/ot` (grep) | E1-M1 baseline honest |
| `procedureCode` / `procedureClass` on `ot_cases` | `core/kernel/db/schema/ot.ts:255-256` | E1-M1's additive fields have a source |
| `daycare.discharge_ready{lateCutoffPassed}`, `daycare.absconded`, `escort.verified{at}`, `daycare.converted_to_admission{handoffDocumentId}` | `ot/events.ts:74-102` | harvest rows 3–5 |
| `notifications` table, `enqueueNotification` validates key + dedupe | `core/kernel/notify/enqueue.ts:64-73`; `schema/notifications.ts:44` statuses `queued|sending|sent|suppressed|expired|undeliverable` | `daycare_followup` = 0 hits today (honest) |
| `notification.sent|failed|suppressed|expired` | `core/kernel/notify/events.ts:16-54` | but see §2.6 |
| `print_jobs` outbox | `schema/printing.ts:38-46` | E1-M2 |
| `ot_definitions_one_active_ux` | `schema/ot.ts:543` | E1-M3 |
| `standup:check <module>` exits 1 on any RED | `apps/core/scripts/standup-check.ts:700-713` | E1-M4 |
| dated `## Executed` runbook section | `docs/runbooks/pharmacy-go-live.md:257` (`NOT YET RUN`); RM rule 3 (`ROADMAP-v2.md:376-377`) | E1-M4, E3-M3, E4-M4 |
| the 11 existing gate events on G3's list | `ot/events.ts:154,162,168` (`timeout.halted`, `count.mismatch`, `gate.overridden`); `kernel/auth/events.ts:5,16,28` (`break_glass.used`, `sod.violation_blocked`, `emergency_elevation.used`); `lab/events.ts:80,243,255`; `radiology/events.ts:162` (`imaging.critical_overdue`); `opd/events.ts:330-342` (`prescription.issued` + three `*OverrideCount`) | 11/11 verified |
| `device_not_licensed` 403 with no event twin | `core/modules/aerb/errors.ts:34` (STATUS map), `aerb/events.ts` = 3 events, none a refusal | G3 baseline "≥ 1" honest |
| `charge.orphan_flagged` from OPD-only `orphanScan` | `billing/events.ts:157-160`; `billing/daily-close.ts:295-306` | E2-M5 — see §2.9 |
| `user_day_facts` one-arithmetic; `config_validation_reports` persisted report | `core/kernel/desk/rollup.ts:9-25`; `schema/ops.ts:79-89` | E2-M1 precedents |
| `approvals.requested_at` / `decided_at` / `decided_by` / `approver_role` | `schema/approvals.ts:36-52` | E5 closure p90 measurable once instances exist |
| `alerts.read_at` | `schema/alerts.ts:25,29` | **the read instrument the design never uses — §2.2** |
| `caddyfile-parity`, `deploy-parity`, `standup-check` tests | `apps/core/test/` | E2-M2 |
| `check:config-present` | `apps/core/package.json:42`; `scripts/check-config-present.ts` | misaimed for permissions — §2.8 |
| `complete()` undeclared; `kernel/ops` exists without `fact-sheet.ts`; no `documents` table | `core/kernel/inference/types.ts:9-11`; `git ls-tree` | §0.3, E2, E3 honest |
| `15e`, `11l` free; `11k` taken | grep `docs/`: none / none / `…11i….md:411` | D7 |

Zero-hit confirmations (design says "does not exist" — true): `fit_declared`, `audit.control_tested`, `patient.discharged`, `task.verified`, `pass.issued|scanned`, `undertaking.signed`, `draft.provenance`, `protocol.deviation*`, `ops.fact_sheet*`, `summary_countersign*`, `aerb.acquisition_refused`, `daycare_followup`, `governance.single_approver_used`, any `holiday`.

---

## 2. Refutations

### 2.1 G1 — "0 breaches for a full week" is vacuous on an empty week · **amend (minor)**
Instrument real. Baseline "zero day-care cases on production" is structurally true, not just observed: `ot_workflow_definitions_active` is a Class-A ceremony no seed performs (`standup-check.ts:487-500`), so no `daycare_case` instance can exist on production. But "0 breaches for a full week" is satisfied by a week with 0 `discharge_ready` entries — the exact `no_data ≠ compliant` trap E2-M1 forbids. Write: "0 breaches in a week with ≥ 5 `discharge_ready` entries", and let the sheet print `no_data` otherwise.

### 2.2 G2 — titled "is read", instrumented as "is produced" · **amend**
`ops.fact_sheet_produced` counts production; "rows > 24 h old absent from any sheet" counts inclusion. Nothing measures a human reading. The nearest REAL instrument is already in the kernel: `alerts.read_at` (`schema/alerts.ts:25`, index `alerts_user_read_idx` on `(user_id, read_at)`), written by the in-app alert the `kernel.alerts` consumer creates from a subscribed event (`core/kernel/alerts/manifest.ts:20-48` subscribes `escalation.triggered`, `ops.mode_changed`, `imaging.critical_overdue`, `notification.failed`). Minimal add, in 11l: subscribe `ops.fact_sheet_produced` → one `alerts` row for the owner and the quality holder; G2 = "days in the last 7 whose sheet alert has `read_at` within 24 h · 7/7". Same fix serves E1-M5's "harvest read · dated line per day" (§2.7) and E2-M4's "in-app" (§2.10). Baseline "0 readers of `sla.breached`" holds (grep: definer, emitter, one comment at `approvals/events.ts:6`, six test files — the design says "two tests"; the count is off, the claim is not).

### 2.3 G3 — "a refusal event not on the list fails CI" is "tests pass" in north-star clothing · **amend (wording)** + baseline understated
Keep the two counts (refusals/overrides per gate per day; un-evented authority refusals = 0) as the north-star; move "fails CI" to E2-M3's acceptance where it belongs. Baseline "≥ 1 live gate un-evented" is honest but the measured universe is larger: 403 codes per module on main — aerb 3 (`device_not_licensed`, `no_active_licence`, `not_appointed`), lab 7 (`permission_denied`, `relabel_witness_same_actor`, `absurd_override_same_actor`, `impossible_override_same_actor`, `sod_violation`, `user_actor_required`, `machine_cannot_supersede`), ot 2 (`privilege_refused`, `same_actor`), pcpndt 5, pharmacy 2, radiology 4 = **23 codes in 7 modules**, of which the lab's `sod_violation` has a twin. Paste 23, not "≥ 1", so the target 0 is a known distance.

### 2.4 E1-M1 — two clauses have no data source · **amend**
(a) "recall date = review date else day 7": no review/follow-up date column exists on the day-care encounter (`schema/ot.ts` grep `review|follow`: only gate names). The first branch cannot be computed; either add `reviewDate` to `daycare_encounters` (additive, 15e) or make it day-7-only. (b) "next working day on holidays · unit test · 3 fixtures": there is NO holiday calendar anywhere (`grep -i holiday core packages scripts` = 0). A 3-fixture unit test passes against an injected calendar; production has none, so the behaviour is unfalsifiable there. Name the source (an `ops` config row is the smallest) or drop the clause. (c) Baseline citation stale: `recovery.ts:549`'s comment was rewritten 2026-09-07 (#164) and now says "no document asks for a recall task on a day-care abscond … there is no task primitive anywhere in the kernel". The parameter survives on its other two sources, both verified: SPEC:460 "missed follow-up = clinical recall task, not a no-show" and P15:339 "follow-up recall task via the notifications/scheduler seam" — cite those, not the comment. Edge row 4 ("today: incident only") stays true.

### 2.5 E1-M2 — "render.ts switch + parity test · 4 → 6" is the wrong count and the parity test does not exist · **amend**
`render.ts`'s switch has THREE cases (`core/kernel/printing/render.ts:660-662`: `opd_token_slip`, `opd_payment_receipt`, `opd_prescription`); `vitals_slip` is a fourth `DocumentKind` in `enqueue.ts:56` that deliberately renders `null` (`render.test.ts:810-816`). No test pins kinds ↔ switch (grep `PRINT_KINDS|parity` in `kernel/printing`: none; `render.test.ts:329` iterates the three by hand). Write: "`DocumentKind` 4 → 6; `render.ts` cases 3 → 5; a kinds↔switch parity test is a BUILD item of E1-M2 (fail-first: today 4 ≠ 3)". Edge row 32's "parity 6, not 5" inherits the fix.

### 2.6 E1-M3 — overtaken by #157; the runbook name collides; two harvest rows have no instrument · **amend**
- "`standup:check ot` · module keys 4 → 5": the census has SIX keys (`standup-check.ts:138 hospital, :295 lab, :407 pharmacy, :458 ot, :544 pcpndt, :595 radiology`) and `ot` already has six rows (`ot_approval_types_registered`, `ot_theatre_present`, `ot_workflow_definitions_active`, `ot_definitions_published`, `ot_surgeon_held`, `ot_anaesthetist_held`, `:460-522`). Baseline "no `ot` rows" is false at this tip. Restate as a delta: +`ot_incharge_held`, +`recovery_nurse_held` (roles exist: `seed-roles.ts:871,915`), +bays ≥ 2, +package tariff, +relay reachable → 6 → ≥ 11.
- "`docs/runbooks/mini-ot-go-live.md` · exists, pinned by deploy-parity": `docs/runbooks/ot-go-live.md` EXISTS (#157, §0–§9) and is pinned by `apps/core/test/standup-check.test.ts:146` (`"ot-go-live.md": "ot"`, a runbook↔module completeness map), NOT by deploy-parity (`test/deploy-parity.test.ts:223-528` pins `deploy.sh` seeds and scripts). A second OT runbook either breaks that map or duplicates §1–§7. It has no §Seat walk, §Harvest or §Executed (grep: none). E1-M3 = "add those three sections to `ot-go-live.md`"; the instrument is `standup-check.test.ts`'s map.
- Harvest row "`escort_required` refusals": `escort_required` is a thrown `OtError` with HTTP **422** (`ot/errors.ts:127`; throw sites `recovery.ts:347-470`, `gates.ts:300-303`), no event, and the kernel has no request/refusal log table (schema listing). Nothing the system records can count it — the design's own G3 rule. Minimal add in 15e: `daycare.escort_refused{encounterId, reason}` (or count `escort.verified{at:"discharge"}` and accept that only successes are visible). Note 422 ≠ 403, so E2-M3's lint will never surface it.
- Harvest row "`tariff_item_missing`": also a thrown error (`tariff/pricing.ts:27`), no event; the lab runbook lists it as prose for the same reason. Same remedy or say "prose row".
- G2 gate "MS publishes under single-approver honesty (R-247)": R-247 (REG:259) requires `governance.single_approver_used` events + a daily digest line; grep of `core` = 0. The honesty mode has no event on main, so "published under R-247" is unmeasurable until the approvals engine emits it. Name it as a build item (it is the sheet's "daily digest line", so 11l is the natural home; the emitter is the approvals engine, kernel — one lane).

### 2.7 E1-M5 — `notification.sent ≥ 95 %` measures a console adapter · **amend**
`NOTIFY_PROVIDER`'s zod enum has exactly ONE member, `console` (`core/kernel/config.ts:31,61`; `pump.ts:77-82`), and channels are `whatsapp|sms` only (`notify/adapters.ts:11`; `notify/events.ts:24`). On the pilot a `daycare_followup` row is "sent" to stdout and `notification.sent` fires; ≥ 95 % is vacuously true and no patient is reached (NEW-P5-3 defers WABA/DLT; there is no email adapter — see §2.10). Split the parameter: (a) one `notifications` row per discharge/abscond · 100 % (real, `schema/notifications.ts`); (b) `notification.sent` with `NOTIFY_PROVIDER ≠ console` · ≥ 95 % — gated on NEW-P5-3; until then (c) the recall call is a harvest line the recovery nurse writes (paper authoritative, as the pilot already is). "harvest read · dated line per day · 7/7" — no system artefact names the reader; use `alerts.read_at` (§2.2).

### 2.8 E2-M1 — the watermark test cannot be built through the real emitter, and the day-bucketing is wrong for the sheet's headline object · **amend**
For `sla.breached` the emitter passes no `occurredAt` (`timers.ts:122-133`) and `make()` defaults `occurredAt = new Date()` (`packages/contracts/src/envelope.ts:96`) inside the same transaction that sets `recorded_at` — so `occurred_at ≈ recorded_at` always, and the TRUE breach instant is `payload.dueAt`. `runDueTimers`' own docstring says repeated calls "drain a backlog … that accumulates while the worker is down" (`timers.ts:83-85`), so a breach due 23:59 IST can carry `occurred_at` = next morning. The test "breach `occurred_at` 23:59, `recorded_at` 00:01" is unconstructible via `runDueTimers`, and bucketing by `occurred_at` moves overnight breaches to the wrong day. Fix: bucket `sla.breached` by `payload.dueAt`; late-entry share for breaches = `occurred_at − dueAt`; keep `occurred_at`/`recorded_at` for human-keyed events (OT's `late_entry.flagged` exists, `ot/events.ts:188`). Edge row 10 inherits this. Sections "≥ 9": the Build list is exactly nine — falsifiable. "open critical calls at 07:00": `lab.critical_*` (12 hits, e.g. `lab/events.ts:205`) and `imaging.critical_overdue` — real.

### 2.9 E2-M2 — `check-config-present` does not check permissions; "RM rule 4" is deploy-dark · **amend**
`scripts/check-config-present.ts` imports billing config, GST settings and approval types (`:5-8`) and states "WHAT IT DELIBERATELY DOES NOT CHECK" (`:43-45`); it answers "can the modules run at all", never whether a permission row exists. Permissions are pinned by `seed-roles.ts` + `test/seed-roles.test.ts` (CLAUDE.md) and routes by `caddyfile-parity`. RM rule 4 (`ROADMAP-v2.md:378-381`) is "Deploy-dark: … its configuration surface ships one deploy earlier" — a sequencing rule, not a check. Instrument for "`ops.fact_sheet.read` present at deploy" = `seed-roles.test.ts` count +1, `seed:roles` in `deploy.sh` (deploy-parity). Edge row 29 same. `pnpm ops:fact-sheet` is correctly a build item (no `ops:*` script exists, `apps/core/package.json:4-43`).

### 2.10 E2-M3 — the lint pattern as written yields 8 false positives and protects 0 of the two `_blocked` names · **amend**
Against the 138 single-line `defineEvent` names on main, `*.blocked|*.overridden|*.refused|*_flagged` matches 10: `gate.overridden` (a gate) plus nine `_flagged` names of which eight are NOT gates (`lab.result_delta_flagged`, `lab.result_critical_flagged`, `lab.notifiable_flagged`, `lab.attribution_unverified_flagged`, `imaging.critical_flagged`, `material.discrepancy_flagged`, `surgeon.late_flagged`, `vitals.danger_flagged`). It misses `sod.violation_blocked` and `lab.sod_violation_blocked` (suffix `_blocked`, not `.blocked`) and every other name on G3's list (`timeout.halted`, `count.mismatch`, `break_glass.used`, `emergency_elevation.used`, `imaging.critical_overdue`, `prescription.issued`). `kernel/auth/events.ts` defines its events multi-line, so a per-line regex misses them too. The threshold "≥ 12, CI red on omission" is satisfiable; the mechanism is not. Specify an explicit allowlist over the parsed catalogue (the `BILLING_EVENTS`-style manifests, `billing/events.ts:168-175`) with a suffix rule `_blocked|_refused|\.overridden|\.halted`. The 403-lint's universe is §2.3's 23 codes; generic denials (`permission_denied`, `forbidden`, `user_actor_required`) need a declared exemption or the target 0 is unreachable by design.

### 2.11 E2-M4 — "email/in-app" names two channels the gateway does not have · **amend**
No email channel exists (`adapters.ts:11` `channel: "whatsapp" | "sms"`). "In-app" is the `alerts` table via `kernel.alerts`, which is not `notification.sent`. Instrument: an `alerts` row per day for the owner and the quality holder (`created_at` ≤ 07:05 IST) and `read_at` for read; `notification.sent` only once a non-console provider member exists (a config enum change — 11l or 11j). D6 should say "in-app now; WhatsApp/SMS after NEW-P5-3; email is nobody's build item".

### 2.12 E2-M5 — `charge.orphan_flagged.feeKind` does not exist · **amend (wording)**
Payload is `{encounterId, patientId, reason}` (`billing/events.ts:157-160`). The acceptance names a field as if it were the instrument; write "adds `feeKind` (additive, payload v2) and emits one per encounter per kind". The OPD-only baseline is verified (`daily-close.ts:295-306` reads `listVisits`).

### 2.13 E3-M1 — "lab G6 closed (dated)" has nowhere to be dated · **note**
`docs/runbooks/lab-go-live.md` has no G-gate line, no `## Executed`, no "dated" text (grep). RM rule 3 says the execution is dated in the runbook and RM:365 defines G6. Name the section (pharmacy's `## 6. Executed on UAT` is the pattern) so the E3 start condition is a line someone can read.

### 2.14 E4 — hypothetical and labelled; three vocabulary mis-aims · **note**
E4-M2 "rung 1": the engine's first escalation is `rung: 0` (`timers.ts:134-141`). E4-M3 "bed `dirty → available` via `task.verified`": the registry's bed release status is `cleaning` (`core/kernel/resources/kinds.ts:95-103`; `resources/events.ts:117`), `task.verified` has 0 hits and there is no task primitive (recovery.ts's corrected comment) — write `cleaning → available` via `resource.status_changed`. No `rmo` / `discharge_coordinator` role in `seed-roles.ts` (only `medical_superintendent`, `:600`) — E4-M2's "RMO → report.signed" needs Plan 20 to mint the key. IPD:97-113's nine clearances verified; SPEC:256 "< 3 h" verified; IPD:596 "0.8–60 s" verified.

### 2.15 E5 — three clauses are yes/no or "the committee liked it" · **amend (wording)**
E5-M2 "one patient-day reconstructed · script · yes" → "script exits 0 and prints N events / M evaluations / K tasks for a named day". E5-M4 "precision reviewed by the DTC" is not a number → "share of shadow deviations the reviewer closed `accepted` ≥ X % over 30 d", from `approvals.status`/`decision_note`. E5-M1 "each with … unit test" reduces to tests-exist → "each rule id appears on ≥ 1 sheet line in the window". E5-M2 "reviewer named · approval holder · 100 %": approvals are ROLE-addressed at open (`approver_role` snapshot, `schema/approvals.ts:36`) and person-addressed only at decision (`decided_by`); write "≥ 1 holder of the rung role at open AND `decided_by` non-null at close". No `quality_manager`/`dtc*` role exists (`seed-roles.ts` grep) — Plan 20 or `seed:roles` must mint one before "named" can be true.

---

## 3. Stale baselines to rewrite (all in §0 / Exists lines)
1. §0.5 "no `ot` rows in `standup:check`" — six rows since #157 (`standup-check.ts:458-527`).
2. §0.5 "no runbook (`docs/runbooks/` = four files, none OT)" — nine files; `ot-go-live.md` exists, pinned at `standup-check.test.ts:146`.
3. §0.5 "`markAbsconded`'s comment promises one (`recovery.ts:549`)" — rewritten 09-07 to deny it; cite SPEC:460 + P15:339 instead.
4. §0.6 "two tests" — six test files read `sla.breached`; the no-reader claim stands.
5. E1 Exists: `list.resequenced` now exists (`ot/events.ts:136`, #164) — not cited, harmless.
6. Read-against line: "`main-ro` @ `b04cbd9`" → "`origin/main` @ `91c34fc`/`41a4be4`, 2026-09-08".

## 4. Parameters that reduce to "tests pass" / "owner is satisfied"
G3 north-star "fails CI"; E5-M1 "each with unit test"; E5-M4 "reviewed by the DTC"; E5-M2 "script · yes"; E1-M5 "harvest read · dated line" (human prose). E4-M1 "phase doc exists / §2b ≥ 24 rows" is an existence check but acceptable for an *authored* gate. Everything else is a count, a duration, a row or a dated section.

## 5. Sound as written
G4 (honestly "not measurable"), G5's instruments once built, E1-M4 (dated section + exit code + transitions), E2-M1's `no_data` fixture and schema test, E3-M1/M3, E4-M4/M5/M6 thresholds, E5-M3's demotion rule (> 30 % over 7 d), edge rows 1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13–27 (each names an artefact that exists or that its milestone builds).
