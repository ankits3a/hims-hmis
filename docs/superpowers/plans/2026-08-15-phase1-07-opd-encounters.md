# Phase 1 / Plan 07 — OPD: Encounters, Appointments, Queues, Vitals · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the OPD spine — the second domain module (`apps/core/src/modules/opd/`) and the second UI-heavy plan. Backend: the `encounters` table (spec §6 — the most load-bearing table after `events`, its type enum open and its clinical fields nullable so IPD/ER/teleconsult arrive later without a redesign), the OPD visit lifecycle **as a workflow definition run on Plan 03's engine** (§10.1 P1 / §10.2: "OPD flows are *data* authored in Plans 07+"), appointment booking on 10-minute slots derived from weekly doctor schedules minus leaves, walk-in visit opening with per-doctor-per-day tokens, the queue engine implementing §11.1's locked discipline as a **pure function over queue state, property-tested**, the same-day test re-entry priority class (the roadmap's diagnostics hook — and nothing else of diagnostics), the E-32 bounded-interleave perk hook (mechanics now, rules Plan 09), vitals capture with age-banded danger thresholds and `vitals.danger_flagged`, the consultation record with a printed e-Rx (FHIR-shaped JSONB document, HMAC-signed QR, allergy hard-warning with reasoned override), the doctor-leave cascade (§11.5), the E2 queue transfer, and a **multi-process-safe WebSocket gateway** whose fan-out reads the `events` table (a per-process tail), never in-memory state. Frontend (`apps/web`, the Plan 05 scaffold): six screens — OPD masters admin, appointments, OPD desk (walk-in + check-in + token slip), vitals desk, consultation (live queue + note + e-Rx print on the CRK letterhead), and the token display board with browser-speech audio calling.

**Architecture:** One new module folder, one new kernel folder (`kernel/realtime/` — WebSocket is cross-cutting infrastructure the bed board reuses), **exactly one migration (`0010_*`)**, three additive touches on Plan 05's patients module (two read helpers + one `index.ts` export block, so the OPD module never reads patient tables directly — spec §4), and three backend dependencies (`ws` + `@types/ws` for the gateway, `fast-check` for the property tests). Encounter state lives in the workflow instance and is **mirrored** onto `opd_encounters.status` in the same transaction by exactly one function (`moveEncounter`), so the two cannot drift; every state move is single-winner (the engine's conditional UPDATE) and every queue-entry move is a status-discriminated conditional UPDATE (the house pattern). Tokens come from an atomic `UPDATE … RETURNING` counter on the doctor-day session row; queue entries carry a database-side `bigserial seq` for arrival order — **nothing in this plan orders by `newId()`** (ledger §3.26, the `ids.ts` WARNING). The queue engine is pure: the service loads rows, calls `orderQueue`, and writes back the one row that moved. Realtime fan-out is a per-process tail over `events.seq` with a look-back window and dedupe (out-of-order commits are covered without touching `kernel/events`), delivered to topic subscribers over `ws` after bearer auth via `findLiveSession` and per-topic `hasPermission` checks; clients also poll every 15 s, so a missed hint costs seconds, never correctness. The OPD visit workflow definition is **Class A** (D-15: a patient-journey flow — owner + medical superintendent two-key), registered at go-live exactly like Plan 05's approval types (runbook, no boot-time DB call, tests activate it inline through a shared helper). Visit type (new/revisit/renewal) is auto-detected at visit open from the patient's most recent completed consultation **in the same department** (owner decision 2026-08-15) and its own follow-up window (7 days default; the doctor may set 15/21/30 at completion; extensions capped per doctor per IST month and evented through `consultation.completed`) — Plan 08 stamps its three-way fee on `visit_type` (revisit = free, owner decision).

**Tech Stack:** Existing — TypeScript strict, NestJS ^11, drizzle-orm ^0.40 / drizzle-kit ^0.30, zod ^4, pg ^8, Jest + ts-jest; React 19 + Vite 7 + Tailwind 4 + shadcn/ui + TanStack Router/Query + react-hook-form + i18next + Vitest. **New, backend only:** `ws` ^8.18 (+ `@types/ws` dev) and `fast-check` ^3.23 (dev). Zero env vars, zero CI changes, zero web dependencies (audio = browser `speechSynthesis`, realtime = browser `WebSocket`).

**Owner decisions folded in (2026-08-15, in-conversation):** follow-up window **7 days** default, doctor may change per visit (15/21/30 per spec §11.1) · follow-up (revisit) **fully free** — Plan 08's branch · **both** appointment-led and walk-in-led, **10-minute slots** · **100 consultation rooms, 200+ doctors** each available ≥ 2 days/week (schedules are weekly templates + leaves; masters admin screen ships) · **e-Rx: signed QR suffices, no wet signature**; sample letterhead **"CRK MEDICAL COLLEGE & HOSPITAL — CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"** (config data, dev placeholder) · vitals danger ranges: **India-standard defaults as first values**, config, clinical staff revise at UAT · **display board + browser-speech audio in scope** · **revisit anchor = same DEPARTMENT** (any doctor of the department within the window) · **catalog additions ratified: `queue.called`, `queue.skipped`, `visit.abandoned`** (module `opd`) · departments: **standard medical-college list seeded as dev placeholders**, editable in the admin screen · **diagnostics stay on the roadmap** (lab stage 3, PACS stage 5): the only diagnostics-adjacent artefact here is the queue's same-day re-entry priority class.

---

## Design (the decisions this plan makes — read before the tasks)

### D1. Encounter lifecycle = the `opd_visit` workflow definition (data), mirrored onto `opd_encounters.status`

```
registered ──(vitals recorded)──▶ waiting ──(doctor calls & starts)──▶ in_consultation ──▶ completed
    │                               ▲   │                                    │
    │                               │   └──────────────(abandon)─────────────┼──▶ abandoned
    │                               │                                        │
    │                    (re-check-in, same token)                (tests ordered, return today)
    │                               │                                        ▼
    └────────(abandon)──────────────┴──────────────────────────────── awaiting_results
```

- **States** (every non-terminal state carries an SLA — `defineWorkflow` refuses otherwise): `registered` (SLA 20 min, `record_only` — time to the vitals desk) · `waiting` (**SLA 45 min, `alerting: "active"`** — §10.3 names the OPD wait a go-live active alert; escalation `front_office_supervisor` after 15 min, `duty_manager` after 30) · `in_consultation` (60 min, record_only) · `awaiting_results` (240 min, record_only) · terminals `completed`, `abandoned`.
- **Transitions and the roles allowed** (role KEYS are data — the seed creates them, the owner assigns them): `registered→waiting` [`vitals_desk`,`nurse`,`doctor`] · `waiting→in_consultation` [`doctor`] · `in_consultation→completed` [`doctor`] · `in_consultation→awaiting_results` [`doctor`] · `awaiting_results→waiting` [`front_office`,`vitals_desk`,`nurse`,`doctor`] · `{registered,waiting,awaiting_results}→abandoned` [`front_office`,`front_office_supervisor`].
- **`changeClass: "A"`** — owner + medical superintendent two-key (Plan 03 `CHANGE_CLASS_POLICY.A`); the go-live runbook drafts it via `POST /workflow/definitions` with the exact JSON served by `GET /opd/definition`, two approvals, one activation by a third user (drafter ≠ activator SoD). Tests activate it through `test/helpers/opd.ts` (users, roles, approvals, activation — once per suite).
- **Mirror rule:** `moveEncounter(tx, actor, encounter, to)` calls `transition(tx, instanceId, to, actor)` then `UPDATE opd_encounters SET status = to … WHERE id = ? AND status = from`. Nothing else writes `status`. The engine's WorkflowError codes `stale_transition` / `instance_not_active` / `unknown_transition` — all three are legal outcomes of a concurrent or illegal move (ledger §3.13; the interleavings are traced in T4) — are rethrown as ONE OPD code, `encounter_state_conflict`; `role_denied` stays `role_denied` (403). Race tests assert the invariant (one winner, one event) AND the single mapped code.
- The queue entry is a separate row with its own status (`waiting_vitals | waiting | called | in_consult | done | left | transferred | cancelled`); `called` is queue-level (the encounter stays `waiting` until the doctor starts). Every queue-entry move is a conditional UPDATE discriminated on current status.

### D2. Queue discipline (§11.1 verbatim, plus E-32 and the re-entry class) — `orderQueue`, pure

Priority classes, in order — **0** danger vitals · **1** same-day re-entry (returned with results) · **2** DUE appointments (`appointmentAt ≤ now`, on-time or late — late never expires) · **3** walk-ins FIFO · **4** FUTURE appointments (`appointmentAt > now` — a walk-in beats a future appointment, never a due one). Within 0/1/3: by `eligibleAt` asc then `seq` asc (a skipped entry is re-queued with `eligibleAt = now`, so it loses its place, not its token); within 2 and 4: by `appointmentAt` asc then `seq`. **Perk hook (E-32):** `policy.perkEveryNth = N` and `(callsMade + 1) % N === 0` promotes the earliest waiting `perk` entry to the head of class 3 — never above danger, re-entry or a due appointment; `perk` is never set in Plan 07 (Plan 09 sets it from membership), and `perkEveryNth` is null in the seeded config. `nextInQueue = orderQueue(...)[0] ?? null`. Property-tested with fast-check (T5): permutation, class order, walk-in FIFO, walk-in-beats-future, due-beats-walk-in, perk bounds, determinism.

**Tokens:** per doctor per day (`opd_queue_sessions` keyed `(doctor_id, service_date)`, IST date), allocated by `UPDATE … SET next_token = next_token + 1 … RETURNING next_token`; the session row is created lazily with `onConflictDoNothing` + re-select (single-winner). Re-entry keeps its token (a new entry row, same `token_no`, `re_entry = true`). Transfer (E2) issues a new token in the target session and preserves `eligibleAt`. Public surfaces show **token + room + doctor** — never a patient name (§11.5).

**Call / skip / start:** `callNext` = one tx: refuse if the session is `out`/`closed`; refuse if an entry is already `called` (`call_conflict`); pick the head via the engine; `UPDATE opd_queue_entries SET status='called' … WHERE id=? AND status='waiting'` (0 rows ⇒ `call_conflict` — the SAME code as the pre-check, so the race loser's code is a single enumerated value however the interleaving falls); increment `calls_made`; append `queue.called`. `skipCalled` = called→waiting with `skips+1`, `eligibleAt=now` (or → `left` after `max_skips_before_left`, config 3); `queue.skipped`. `startConsultation` (T7) = queue entry called|waiting → `in_consult` + encounter `waiting→in_consultation` + `consultation.started`.

### D3. Visit type (owner: anchor = department) — `classifyVisit`, pure

At visit open for (patient, department): the anchor is the patient's most recent **completed** encounter in that department (across the patient's merge chain — `listMergedLoserIds` from the patients module); none ⇒ `new`; else `revisit` iff `istDayIndex(now) − istDayIndex(anchor.consultCompletedAt) ≤ anchor.followUpDays`, else `renewal`. Each completed consult carries its own `follow_up_days` (config default 7; the doctor may set one of the config's `followUpExtensionDays` = `[15, 21, 30]` at completion ⇒ `follow_up_extended = true`, refused with `extension_cap_reached` past `extension_cap_per_doctor_per_month` in the doctor's IST month — §11.19-C fix 14, evented through `consultation.completed`'s `followUpDays`/`followUpExtended`). Same-day re-entry is the SAME encounter — no new visit, no new type. `visit_type` is stamped on the encounter; Plan 08 reads it.

### D4. Vitals — `evaluateVitals`, pure; danger flags never auto-clear

Fields: height cm, weight kg, SBP, DBP, pulse, RR, SpO₂, temp °C, notes. Age band from the patient's DOB at record time (unknown DOB ⇒ adult band): `<1`, `1–5`, `6–12`, `≥13` (adult). Per band the config carries `required` (completeness — `vitals_incomplete` lists what is missing; **weight is required under 18**: the pediatric weight context §11.8) and `ranges`. **First values (India-standard, clinical staff revise at UAT — config, not code):** adult SBP 90–180 · DBP 60–110 · pulse 50–120 · RR 8–30 · SpO₂ ≥ 90 · temp 35.0–39.5 °C; child 6–12: SBP 80–140 · DBP 50–90 · pulse 60–130 · RR 14–30; child 1–5: SBP 75–130 · DBP 45–85 · pulse 70–150 · RR 20–40; infant <1: SBP 65–120 · DBP 40–80 · pulse 90–180 · RR 25–60 · temp 35.0–38.5. Any breach ⇒ `vitals.danger_flagged` (all flags in the payload), `opd_encounters.danger_flagged = true`, the waiting queue entry `danger = true` (class 0). A later normal reading does NOT clear the flag in Plan 07 (conservative; the doctor sees the history). Recording vitals on a `registered` encounter moves it to `waiting` (queue entry `waiting_vitals → waiting`, `eligible_at = now`); re-recording while `waiting` is allowed (no move).

### D5. Consultation, e-Rx, verification

The consult note lives on the encounter row (chief complaint, diagnosis text, optional ICD-10 code — §11.19-E fix 31, advice, admission advised, referral to/note, follow-up days). Prescriptions are versioned rows per encounter (`opd_prescriptions`; a re-issue supersedes the previous). **Allergy hard warning (§6):** every line's drug text is matched case-insensitively (substring, either direction) against the patient's ACTIVE allergies via the patients module's `listAllergies`; any match without a per-line override reason ⇒ `allergy_conflict` (409, matches listed); an override needs a reason (the S10 KPI "Rx safety-alert override rate with reasons"); overrides are stored on the prescription and counted in `prescription.issued`. The document column is a **FHIR-shaped Bundle** (Condition + MedicationRequest resources, built by the pure `toFhirBundle`), the spec's "stored FHIR-shaped, serialized later" rule. QR: `rx1.<prescriptionId>.<encounterId>.<version>.<sig>` HMAC-signed under the existing `SECRET_KEY` (Plan 02 crypto, Plan 05 QR pattern); `POST /opd/prescriptions/verify` returns HTTP 200 always (`ok:true` + summary | `ok:false` + reason) and appends `qr.signature_failed` (same catalog name and payload grammar as Plan 05's, `module: "opd"`) on every failure. Print: letterhead from `opd_config.letterhead` (data), doctor display name + registration number, patient UHID/name/age/sex, date, diagnosis, latest vitals, lines, QR — **no signature line** (owner decision). Only the encounter's own doctor (resolved from `opd_doctors.user_id = actor.id`) may start/complete/prescribe (`not_your_patient`); coverage is E2 transfer.

### D6. Realtime — `kernel/realtime/` (tail + gateway), OPD registers a topic router

- `EventTail`: per process; cursor starts at `max(seq)`; every 300 ms: `select … from events where seq > cursor − 500 and name = any($names) order by seq limit 1000`, dedupe by a bounded `seen` set, `cursor = max(seq)`; if `max(seq)` in the table drops below the cursor (test truncation with `restart identity`) the cursor resets. Late-committing lower seqs inside the window are delivered; beyond it they are not — pushes are hints, every subscribing screen also refetches every 15 s. `unref()`'d timer; stopped on shutdown.
- `RealtimeGateway` (Nest provider, `OnApplicationBootstrap`/`OnApplicationShutdown`): `ws.WebSocketServer({ noServer: true })` on the HTTP server's `upgrade` for path `/ws`; first client message must be `{"type":"auth","token"}` within 5 s (bearer session verified with `findLiveSession` — a token in a query string would land in proxy logs); then `{"type":"subscribe","topics":[…]}` — each topic prefix must be registered with a permission, checked with `hasPermission(db, userId, permission, "hospital")`; server pushes `{"type":"event","topic","name","seq","occurredAt","payload"}`. Modules register `{ names, topicsFor(event) }` routers and `{ prefix, permission }` topic spaces at module init. OPD topics: `queue:<doctorId>:<serviceDate>` (`opd.queue.read`), `display:<roomId>` (`opd.display.read`), `encounter:<encounterId>` (`opd.visits.read`).
- Multi-process claim, tested (T8): an event appended through a SECOND pool (a different connection — "another process") reaches a subscribed socket; a mutant that fans out from an in-process emitter never sees it and DIES.

### D7. Masters, schedules, leaves, appointments

Departments (code, name), rooms (code, name, floor), doctors (profile row linked to a Plan 02 user by `user_id` — created by username, resolved server-side; one department; registration number; specialty), weekly schedules (weekday 0–6, `HH:MM`–`HH:MM` IST, room, optional slot override, validity dates), leaves (from–to, reason, `scheduled|cancelled`). Slots for a date = pure `slotsForDate(templates, leaves, booked, date, cfg)`; booking = `opd_appointments` row with the **partial unique index `(doctor_id, slot_start) WHERE status IN ('booked','checked_in','needs_rebooking')`** as the arbiter (loser ⇒ `slot_taken`, single code); reschedule = cancel-as-`rescheduled` + new row atomically; cancel; **no-show sweep** `sweepAppointmentNoShows(db, now)` (the fifth unscheduled sweep — Plan 11's pg-boss list); **leave cascade** marks affected `booked` appointments `needs_rebooking` (worklist + one-tap reschedule; notify/call-tasks are Plans 10/12), cancelling the leave restores them. Check-in is same-IST-day only, from `booked`; it opens the visit (`visit.opened` + `patient.checked_in`) with `kind: appointment` and `appointmentAt = slot_start`.

### D8. Events minted (18 names, all `module: "opd"`; the three ratified additions are marked ★)

`appointment.booked` · `appointment.rescheduled` · `appointment.cancelled` · `appointment.no_show` · `doctor_leave.scheduled` · `visit.opened` · `patient.checked_in` (payload `kind: "arrival" | "re_entry"`) · `visit.transferred` · `visit.abandoned` ★ · `vitals.recorded` · `vitals.danger_flagged` · `queue.called` ★ · `queue.skipped` ★ · `consultation.started` · `consultation.completed` · `prescription.issued` · `referral.issued` · `admission.requested` (the IPD-phase intent stub) · plus `qr.signature_failed` (Plan 05's name and payload grammar, `module: "opd"`, for e-Rx scans). Every patient-scoped emission carries `patientId` **and `encounterId`** (§10.5 envelope; `defineEvent(...).make` accepts both — `timers.ts:108-113` precedent); every doctor-scoped payload carries `doctorId`, `serviceDate`, `sessionId`, `roomId | null`, `tokenNo` so the realtime router can topic it. **Nothing else emits.** Instance starts and transitions mint no names (Plan 03 rule; `workflow_transitions` is their record).

> **ERRATUM (2026-08-17, after pipeline A shipped).** This plan was authored saying **seventeen** P1 names; the bullet list above has always contained **eighteen**, and `modules/opd/events.ts` as shipped by T2 contains **19** `defineEvent` calls (the 18 above + `qr.signature_failed`), verified by grep on the server. T2's coder disclosed the discrepancy rather than deleting an event to hit the stated number — the correct call, and the shipped catalog is correct as it stands. The prose has been corrected here, in Global Constraints, in the File Structure table and in the Pipeline Notes events note. **One stale "seventeen" remains deliberately**: the docstring inside T2's `events.ts` code block below, which matches the comment already shipped in the source file. Do not edit shipped code to chase it — `events.ts` is frozen for pipelines B and C; a future task that legitimately owns the file may correct the comment. Plans 10/11 authored against this catalog must count **18 P1 names + `qr.signature_failed` = 19**.

### D9. What this plan deliberately does NOT build (stated)

Payment gate before consult (Plan 08 inserts pay-before-consult; here vitals is the only eligibility gate) · lab/imaging order entry, results, reports (stage 3/5 — the re-entry class is the only hook) · pharmacy formulary, substitution, dispensing (stage 2 — drug lines are free text) · WhatsApp/SMS pings and the public queue-position link (Plan 10) · call tasks for unresolved rebookings (P5, Plan 12) · membership perk assignment (Plan 09 sets `perk`) · IPD admission (the `admission.requested` stub records intent) · patient self-booking (Plan 10 public surface / CRM) · chaperone documentation gate (procedure/exam classes — diagnostics/procedures modules) · per-access break-glass eventing (carried again to the EMR plan) · doctor payout attribution (Plan 09) · a second site (`site_id` stays `"main"`).

---

## Consumed shipped surfaces (scout-verified against `/opt/hmis` at `2e5144b`, 2026-08-15 — four read-only transcription scouts)

- **ids:** `newId(): string` (`packages/contracts/src/ids.ts:12` — WARNING: not insertion-ordered; never `ORDER BY id`) · `newEventId()`.
- **Actor:** `type Actor = { type: "user" | "agent" | "system"; id: string }` (`packages/contracts/src/envelope.ts:3`).
- **Events:** `defineEvent(name, module, zodSchema)` → `.make({ actor, payload, patientId?, encounterId?, correlationId? })` (usage `modules/patients/events.ts`, `kernel/workflow/timers.ts:108-129` passes `encounterId`) · `appendEvent(tx, input): Promise<{ eventId; seq }>` (`kernel/events/append.ts:6`) · `events` table (`kernel/db/schema/events.ts`: `seq bigserial PK`, `event_id`, `name`, `occurred_at`, `recorded_at`, `actor_type/id`, `patient_id`, `encounter_id`, `correlation_id`, `module`, `payload jsonb`, `site_id default 'main'`) · `SubscriptionBus`/`runDispatchCycle` (module consumers with a shared cursor — NOT what a per-process WS fan-out uses; `dispatcher.ts:22-27` has no out-of-order-commit protection, which is why the tail carries a look-back window).
- **DB:** `Db`, `Tx`, `withTx(db, fn)`, `createDb(url): { db, pool }` (`kernel/db/client.ts`) · schema barrel `kernel/db/schema/index.ts` (8 re-exports; T1 adds `./opd`) · precedents: `bigserial("seq", { mode: "number" })` non-PK (`tariff.ts:83/:103`), partial `uniqueIndex(...).where(sql...)` (`patients.ts`, `workflow.ts:25`), `date("dob", { mode: "date" })` (patients — Plan 07 uses `mode: "string"` for service dates: verify-by-execution flag ①), `customType` bytea.
- **Test infra:** `setupTestDb()` / `truncateAll(db)` (`test/helpers/db.ts` — the patients statement at `:64-67` is the ONE T1 extends; `events` is truncated with `restart identity` at `:53`) · `test/helpers/env.ts` sets `SECRET_KEY` for jest · jest `testMatch: ["**/test/**/*.test.ts", "**/src/**/*.test.ts"]`, `testTimeout: 15000`.
- **Auth/RBAC:** `createUser(db, { username, fullName, password })`, `createSession(db, cfg, userId) → { token, sessionId }`, **`findLiveSession(db, token): Promise<LiveSession | null>`** (`kernel/auth/sessions.ts:35` — the WS upgrade verifier; needs only `Db`), `createRole(db, key, title)` (plain insert — throws on duplicate), `grantPermissionToRole(db, registry, roleKey, permission)`, `assignRole(db, { userId, roleKey, scopeType, scopeId? })`, `syncPermissions(db, registry)`, `hasPermission(db, userId, permission, "hospital")` (`kernel/auth/permissions.ts`), `seedSodPairs(db)`, decorators `RequirePermission(permission, scope)` / `CurrentActor()` / `Public()` (`kernel/auth/decorators.ts`), `SodViolationError` (`kernel/auth/sod.ts`), tokens `DB`, `CONFIG`, `DB_POOL`, `MODULE_REGISTRY` (`kernel/tokens.ts`), `AppConfig.secretKey: Buffer` (`kernel/config.ts`), `hmacSign(key, payload)` / `hmacVerify(key, payload, sig)` (`kernel/crypto.ts:31-38`).
- **Workflow engine:** `defineWorkflow(json)` (`kernel/workflow/definition.ts:53` — schema at `:7-34`: `sla { minutes, alerting: "active"|"record_only", escalation?: [{ afterMinutes, toRole }] }`, states `{ name, terminal?, sla? }`, transitions `{ from, to, roles: string[] min 1 }`; every non-terminal state MUST carry an SLA, terminals MUST NOT) · `createDraft(db, actor, json)`, `approveDefinition(db, actor, { definitionId, roleKey, note })`, `activateDefinition(db, actor, definitionId)`, `CHANGE_CLASS_POLICY.A = { requiredRoles: ["owner","medical_superintendent"], … }` (`definitions.ts:90-97`) · **`startInstance(tx, defKey, subject: { type, id, patientId?, encounterId? }) → { instanceId, state }`** (schedules the initial SLA timer, `instances.ts:38-63`) · **`transition(tx, instanceId, to, actor, { note? }) → { state, completed }`** (order of refusals: `unknown_instance` → `instance_not_active` → `unknown_transition` → `role_denied` (user without any allowed role at ANY scope; agents always) → single-winner UPDATE → `stale_transition`; cancels timers, schedules the new state's, `instances.ts:72-145`) · `WorkflowError.code` union (`instances.ts:13-31`) · `actorHoldsAnyRole(tx, userId, roleKeys)` (`roles.ts:11`) · `runDueTimers(db, now)` (unscheduled) · tables `workflow_instances(id, definition_id, def_key, current_state, status, subject_type, subject_id, patient_id, encounter_id, state_entered_at, …)`.
- **Patients module (`modules/patients/index.ts`, 16 lines):** `getPatient(db, actor, id) → { patient, resolvedFrom } | null` (confidential existence-hiding), `resolvePatientId(db, id) → string | null` (chain-resolving, no gate), `registerPatient(tx, actor, input)`, `searchPatients`, `PatientRow`, `PatientError`. **Not exported today, added by this plan (T3/T7): `listAllergies(db, patientId): Promise<AllergyRow[]>` (`allergies.ts:56`), `getPatientSummaries(db, actor, ids)` and `listMergedLoserIds(db, winnerId)` (new in `registration.ts`).** Patient rows: `dob: Date | null`, `sex`, `isConfidential`, `alias`, `status 'active'|'merged'`, `mergedIntoPatientId`.
- **Module framework:** `ModuleManifest = { key, title, menu: [{label,path,permission}], permissions: string[], subscriptions: [] }` (`kernel/modules/manifest.ts`) · `AppModule` installs manifests in the `MODULE_REGISTRY` factory and imports the Nest module (`app.module.ts:24, :43-45`) · controller pattern = `modules/patients/patients.controller.ts` (zod `parsed()`, `toHttp`, literal routes before `:id`) · module = controller-only, global guards from AuthModule.
- **HTTP bootstrap:** `configureApp(app)` + `createNestApplication<NestExpressApplication>({ bodyParser: false })` (single-argument overload — ledger §3.17); e2e token minting = `createUser` + `createSession` (never `/auth/login`); e2e permission grant = `createRole` + `grantPermissionToRole` per manifest permission + `assignRole` (`test/patients.e2e.test.ts:49-68`).
- **Web scaffold (`apps/web`):** `api<T>(method, path, body?)` (`lib/api.ts`), `getToken()`; `useAuth()`; `router.tsx` code-based routes under the pathless `authed` layout (`Shell` header nav + `KeyboardProvider` + `ShortcutLegend`); `FormKit`/`TextField`/`SelectField`/`CheckboxField` (`components/form-kit.tsx`, `data-field` Enter-advance, Alt+S submit); `QrCard` + `styles.css` print isolation (`.qr-card` visible, `.no-print`, `.print-only`); i18n `en.json`/`hi.json` (15 lines each, key-parity test `lib/i18n.test.ts`); tests: `renderWithProviders`, `stubFetch(routes)` (`test-utils.tsx`), `vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }))`, non-200 = direct `vi.stubGlobal("fetch", …)`; vite proxy list `/auth,/patients,/approvals,/workflow,/health` (T11 adds `/opd` and `/ws`); shadcn components present: alert, badge, button, card, checkbox, dialog, input, label, select, table, tabs, textarea; `PatientPhoto` exported from `screens/registration-desk.tsx`.
- **Deps present:** `ws@8.21.3` and `@nestjs/websockets` exist ONLY transitively; `fast-check`, `pg-boss`, `@nestjs/platform-ws` absent (scout K1 Q4). Postgres 16.

---

## Global Constraints (from spec v4.5 + roadmap standing rules + owner decisions 2026-08-15)

- TypeScript strict; no `any` anywhere (module and web app included).
- **Catalog discipline: exactly the EIGHTEEN names in D8 plus `qr.signature_failed` — 19 `defineEvent` calls in all — all `module: "opd"`,** envelope via `defineEvent(...).make(...)` + `appendEvent`, `patientId` AND `encounterId` on every encounter-scoped emission, `correlationId` = the encounter's workflow instance id on every encounter-scoped emission (§10.5: correlation = workflow instance). The three ratified additions (`queue.called`, `queue.skipped`, `visit.abandoned`) are recorded as catalog additions in this plan and the gate report. Nothing else emits.
- **Module isolation (spec §4):** all OPD backend code under `src/modules/opd/`; the module imports kernel freely and the patients module ONLY through `modules/patients/index`. Tests and `AppModule` import only from `modules/opd/index`. **The OPD module reads no patient table** — demographics come from `getPatientSummaries`/`getPatient`, ids from `resolvePatientId`, allergies from `listAllergies`, merge chains from `listMergedLoserIds` (the last three are the plan's ONLY edits to `modules/patients/`: T3 adds two functions to `registration.ts` + tests to `registration.test.ts` + three export lines to `index.ts`; T7 adds two export lines to `index.ts` for allergies).
- **Additive-only over shipped code.** Kernel files modified, exhaustively: `src/kernel/db/schema/index.ts` (one re-export, T1) · `test/helpers/db.ts` (ONE extended statement, T1) · `test/helpers/opd.ts` (new, T2; T3 appends) · `src/app.module.ts` (T8 imports `RealtimeModule`; T9 installs `opdManifest` + imports `OpdModule`) · `apps/core/package.json` + `pnpm-lock.yaml` (T5 adds `fast-check` dev; T8 adds `ws` + `@types/ws`; T6 adds the `seed:opd` script line) · `README.md` (T10, T16). **New kernel folder `src/kernel/realtime/`** (T8) — every other kernel folder is byte-frozen for this plan (`kernel/events/`, `kernel/workflow/`, `kernel/auth/`, `kernel/approvals/`, `kernel/modules/`, `kernel/config.ts`, `kernel/crypto.ts`, `kernel/tokens.ts`). `modules/tariff/**` byte-frozen. `.github/workflows/*` untouched by anyone (tripwire 10; CI needs no change: apps/core tests ride `pnpm -r test`).
- **No new env vars.** The letterhead, slot length, follow-up defaults, danger ranges, extension cap, skip cap and the perk hook are **data** in `opd_config` (`id = 'main'`), seeded by `pnpm --filter @hmis/core seed:opd` (the `seed:registration` precedent) — a missing row **hard-fails** every OPD write with `opd_not_configured` (the no-fallbacks rule); an invalid `danger_ranges` JSON hard-fails vitals with `opd_config_invalid`. Tests insert the config row in `beforeEach` through `test/helpers/opd.ts`.
- **Migration `0010_*` is generated exactly once, in T1, via `pnpm --filter @hmis/core db:generate`** — never hand-written, never regenerated; its FULL output set (`drizzle/0010_*.sql`, `drizzle/meta/0010_snapshot.json`, `drizzle/meta/_journal.json`) is in T1's Files list (§3.16). Any later schema need is a **CHAIN HALT + plan-defect report** (§3.12). No CHECK constraints (zero precedent); no Postgres extensions.
- **No FK from OPD tables into `users` or `workflow_instances`** (`opd_doctors.user_id`, `opd_encounters.workflow_instance_id`, `opd_appointments.encounter_id` are plain text — the `patient_merge_requests.approval_id` precedent), so the OPD tables join exactly ONE truncate group: the patients statement, which T1 extends by naming all twelve OPD tables (§3.12 — a table with an incoming FK to a truncated table must be named in the SAME statement; a separate earlier statement does not satisfy Postgres). FKs into `patients` are real (`opd_encounters`, `opd_appointments`, `opd_vitals`, `opd_prescriptions`); OPD-internal FKs are real.
- **`newId()` is never an ordering key.** Arrival order = `opd_queue_entries.seq` (bigserial); recency = timestamps (`opened_at`, `consult_completed_at`, `recorded_at`, `issued_at`) with `seq`/`id` only as a stable tie-break where two rows can share a timestamp is NOT load-bearing. Prescription versions are an integer counter per encounter (max+1 inside the tx after a `SELECT … FOR UPDATE` of the encounter row — one issuer at a time per encounter, T7).
- **Single-winner discipline (house pattern):** every state move is a conditional UPDATE discriminated on current state — workflow transitions (engine), the encounter mirror, queue-entry moves, appointment status moves, session token/calls counters (`SET x = x + 1 … RETURNING`), leave cancel, config update. Race tests enumerate every loser code the arbiter can produce (§3.13); where several engine codes are legal for one race they are mapped to ONE OPD code (`encounter_state_conflict`, `call_conflict`, `slot_taken`, `appointment_state_conflict`) and the test asserts the invariant on every path (no early bail).
- **Pure cores, purity-grepped:** `queue-engine.ts`, `visit-type.ts`, `vitals-rules.ts`, `slots.ts`, `fhir.ts`, `time.ts` import nothing from `kernel/`, never `await`, never call `new Date()` without an argument or `Math.random` — T5/T6 add a purity test (the Plan 06 grep pattern) over these six files.
- **Multi-process-safe:** no in-memory truth anywhere. The realtime tail is per-process by design (a cursor into the shared `events` table, not state); the gateway's socket registry is per-process by nature (sockets are). Sweeps (`sweepAppointmentNoShows`) claim rows with conditional UPDATEs and are idempotent; **unscheduled** (Plan 11 registers them with pg-boss alongside the four existing sweeps: `runDispatchCycle`, `sweepExpiredTempRoles`, `runDueTimers`, `sweepGuardianMajority`).
- **IST is the hospital clock:** `service_date` is the IST calendar date (`Asia/Kolkata`, fixed +05:30, no DST — computed arithmetically in `time.ts`, no `Intl` dependency); schedule times are `"HH:MM"` IST; `slot_start` is stored as `timestamptz` (UTC instant). Every service that reads the clock takes an optional `now: Date = new Date()` parameter (the `sweepGuardianMajority(db, now?)` precedent) so tests pin time.
- **Fail-first discipline (§3.5):** every backend task's failing-test step precedes implementation, and each fail-first test file must COMPILE against unmodified shipped code on its own (§3.23 — where a step's tests import symbols the same task creates, the step names which subset is deployed for the red run). T9's e2e is written before the controllers exist (red at 404). T10 adds lifecycle/perf tests over shipped code + docs and **explicitly owes no red run**. Web tasks: each screen's component test precedes the screen; T11's hook test precedes the hook. Fail-first evidence is owed by the ORIGINAL attempt; a retry inherits it (§2.3); every fail-first criterion carries the §2.8 fallback.
- **Two audits per assertion + tripwire 21:** every expected value below is hand-derived (never produced by running the engine); every Assertion Book row names its killing mutant, and the task that ships the assertion BUILDS the mutant as a separate scratch file beside the source (`*.mutant.ts` + `*.mutant.test.ts`, self-contained — never importing a shipped `*.test.ts`), runs it isolated by explicit path, records **DIED/SURVIVED with the run count**, and deletes the scratch BEFORE any workspace count and BEFORE commit. **§2.12 branches:** a required-DIED that SURVIVES because the *plan's test cannot discriminate* and the test is the task's own file ⇒ fix minimally in-task, DISCLOSE in the report, re-run; a survivor that implies the *shipped implementation is wrong*, or whose fix reaches outside the task's Files list ⇒ CHAIN HALT and plan-defect report. Never fix a survivor silently.
- **Static imports in tests** (§3.7); no assertion on `JSON.stringify` of a body (§3.11); every derived fixture hand-checked against this plan's own validators (§3.10 — the OPD definition JSON is validated by `defineWorkflow` in T3 Step 1 before any instance test runs); no lint suppression for an unconfigured rule (§3.15).
- **Perf budgets CI-enforced** (§15): T10 seeds 300 doctor-days × 60 entries and asserts median-of-5 `listQueue` < 100 ms and `openVisit`'s visit-type lookup < 100 ms with `EXPLAIN (FORMAT JSON)` no-Seq-Scan on `opd_queue_entries` and `opd_encounters`.
- **Confidential/VIP (§14, D-37):** the OPD module orders/prioritises on NOTHING patient-identifying; `getPatientSummaries` returns `name` only when the caller may see it and `alias`+`restricted: true` otherwise (the `verifyQrScan` alias precedent), and always `uhid`/`sex`/`dob` (needed clinically at the desk and by the vitals rules — a deliberate, disclosed policy). Public displays show tokens + room + doctor only.
- **i18n:** every user-facing string in `apps/web` goes through `t()` with `en` + `hi`; the key-parity test enforces completeness; Hindi is coder-authored (Plan 05 precedent, owner UAT pass). Print surfaces: e-Rx and token slip use `.print-doc` isolation added to `styles.css` (T15/T13); every printed document carries a signed QR (e-Rx: `rx1.` payload; token slip: the patient's Plan 05 card payload).
- **apps/web needs no new dependency** (WebSocket + speechSynthesis are browser APIs); vitest suites stub both.
- Build/test on the server per the roadmap's standing execution rules; briefs carry EXECUTION-LESSONS §1 tripwires 1–21 verbatim at top; baseline for every task = the previous task's commit, i.e. current `origin/main` (§2.6); per-suite counts are MEASURED before each compile and beat this document (§2.9).

## File Structure (locked by this plan)

```
apps/core/
  src/kernel/db/schema/opd.ts                       T1  twelve tables (below) — the module's schema, kernel-located by convention
  src/kernel/db/schema/index.ts                     T1  + export * from "./opd"
  drizzle/0010_<generated>.sql                      T1  generated once — the plan's ONLY migration
  drizzle/meta/0010_snapshot.json                   T1  generated
  drizzle/meta/_journal.json                        T1  rewritten by the generator (idx 10)
  test/helpers/db.ts                                T1  ONE statement extended (twelve OPD table names join the patients group)
  test/helpers/opd.ts                               T2  seedOpdBase · mkUser · seedOpdMasters · mkDoctor · mkPatient (T3 appends activateOpdVisitDefinition)
  src/modules/opd/errors.ts                         T1  OpdError + OpdErrorCode (closed union, every code T2–T9 throw)
  src/modules/opd/time.ts                           T1  IST helpers (pure): istDate, istDayIndex, istMonthKey, istDateTimeToUtc, ageYearsAt
  src/modules/opd/events.ts                         T2  the 18 catalog definitions + qr.signature_failed (opd) — 19 total
  src/modules/opd/config.ts                         T2  loadOpdConfig(db|tx) · dangerRangesSchema · letterheadSchema · DEFAULT_* (seed values)
  src/modules/opd/masters.ts                        T2  departments / rooms / doctors CRUD (+ doctorForUser)
  src/modules/opd/schedules.ts                      T2  weekly schedules · availableSlots (reads templates, leaves, live bookings)
  src/modules/opd/slots.ts                          T2  slotsForDate (pure)
  src/modules/opd/workflow-def.ts                   T3  OPD_VISIT_DEF_KEY · opdVisitDefinition() (validated by defineWorkflow)
  src/modules/opd/visit-type.ts                     T3  classifyVisit (pure)
  src/modules/opd/sessions.ts                       T3  getOrCreateSession · allocateToken · setSessionStatus
  src/modules/opd/encounters.ts                     T3  openVisit · moveEncounter · abandonVisit · reEnterVisit · transferQueue · getVisit · listVisits · timeline
  src/modules/opd/appointments.ts                   T4  book · reschedule · cancel · list · checkIn (calls T3 openVisit) · sweepAppointmentNoShows
  src/modules/opd/leaves.ts                         T4  scheduleDoctorLeave (+ needs_rebooking cascade) · cancelDoctorLeave (restores) · listLeaves
  src/modules/opd/queue-engine.ts                   T5  orderQueue · nextInQueue · classOf (pure)
  src/modules/opd/queue.ts                          T5  listQueue · callNext · skipCalled · markInConsult · boardSnapshot · summaryByDoctor
  src/modules/opd/vitals-rules.ts                   T6  bandFor · missingRequired · evaluateVitals (pure)
  src/modules/opd/vitals.ts                         T6  recordVitals · listVitals
  scripts/seed-opd.ts                               T6  config row + roles + departments (dev placeholders) — idempotent
  src/modules/opd/fhir.ts                           T7  toFhirBundle (pure)
  src/modules/opd/consultation.ts                   T7  startConsultation · saveConsultNote · completeConsultation
  src/modules/opd/prescriptions.ts                  T7  issuePrescription · buildRxQrPayload · verifyPrescriptionQr · getPrescriptionPrint · allergy matching
  src/kernel/realtime/tail.ts                       T8  EventTail (per-process cursor over events.seq)
  src/kernel/realtime/gateway.ts                    T8  RealtimeGateway (ws upgrade, auth, topics, routers)
  src/kernel/realtime/realtime.module.ts            T8  Nest module exporting the gateway
  src/modules/opd/realtime.ts                       T8  opdTopicRouter + OPD_TOPIC_SPACES (registered by OpdModule in T9)
  src/modules/opd/manifest.ts                       T9  opdManifest (permissions, menu)
  src/modules/opd/opd.module.ts                     T9  Nest module: three controllers + realtime registrar provider
  src/modules/opd/opd-masters.controller.ts         T9  /opd/departments,/rooms,/doctors,/schedules,/leaves,/config,/definition,/me/doctor
  src/modules/opd/opd-visits.controller.ts          T9  /opd/slots,/appointments,/visits,/patients/:id/timeline,/vitals
  src/modules/opd/opd-queue.controller.ts           T9  /opd/queues,/consult,/prescriptions
  src/modules/opd/index.ts                          T9  THE cross-module interface
  src/app.module.ts                                 T8 (RealtimeModule) · T9 (opdManifest + OpdModule)
  test/opd.e2e.test.ts                              T9  walk-in flow over HTTP (red-first)
  test/opd-lifecycle.e2e.test.ts                    T10 appointment→check-in→vitals→call→consult→Rx→verify→re-entry→complete + WS + leave cascade
  test/perf-opd-queue.test.ts                       T10 CI-gated queue/visit-type budgets
  README.md                                         T10 (OPD module + runbook) · T16 (web)

apps/web/
  vite.config.ts                                    T11 + "/opd" proxy, "/ws" ws proxy
  src/lib/realtime.ts (+ .test.ts)                  T11 RealtimeClient + useRealtime(topics, onEvent)
  src/lib/opd-api.ts                                T11 typed wire shapes + small fetchers shared by the six screens
  src/screens/opd-admin.tsx (+ .test.tsx)           T11 departments/rooms/doctors/schedules/leaves
  src/screens/opd-appointments.tsx (+ .test.tsx)    T12 slot picker, book, day list, reschedule/cancel, needs-rebooking worklist
  src/screens/opd-desk.tsx (+ .test.tsx)            T13 walk-in open, check-in, token slip print, queue summary, abandon, transfer
  src/components/token-slip.tsx (+ .test.tsx)       T13 printable slip (.print-doc)
  src/screens/opd-vitals.tsx (+ .test.tsx)          T14 worklist + form + danger flags + quick allergy
  src/screens/opd-consult.tsx (+ .test.tsx)         T15 live queue, call/skip/start, patient panel, note + Rx editor, complete
  src/components/rx-print.tsx (+ .test.tsx)         T15 e-Rx print (letterhead, QR, .print-doc)
  src/screens/opd-display.tsx (+ .test.tsx)         T16 board + speech
  src/router.tsx · src/lib/keyboard.tsx · src/locales/{en,hi}.json · src/styles.css   T11–T16 (each task lists its edits)
```

**Twelve tables (T1):** `opd_config` · `opd_departments` · `opd_rooms` · `opd_doctors` · `opd_doctor_schedules` · `opd_doctor_leaves` · `opd_appointments` · `opd_queue_sessions` · `opd_encounters` · `opd_queue_entries` · `opd_vitals` · `opd_prescriptions`.

**Not touched, deliberately:** every kernel folder except the new `kernel/realtime/` and the two one-line barrel/truncate edits · `modules/tariff/**` · `modules/patients/**` except the four named additive edits (`registration.ts`, `registration.test.ts`, `index.ts` in T3; `index.ts` in T7) · `qr.test.ts` (its 1-in-4096 flake stays with a future owner) · `jest.config.cjs` · `.env.example` · `tsconfig*` · `.github/workflows/*` · `apps/web/src/components/ui/**` (registry-owned) · `apps/web/src/screens/{registration-desk,patient-detail,merge-review,approvals-inbox,login}.tsx` (read-only; T13 imports `PatientPhoto` from registration-desk).

**Sequencing:** three pipelines, strictly sequential within each: **A = T1–T6** (schema → masters/slots/config → encounters/sessions/visit-type/definition → appointments/leaves → queue engine/service → vitals/seed), **B = T7–T10** (consultation/Rx → realtime kernel → module surface + first e2e → lifecycle e2e + perf + docs), **C = T11–T16** (web infra + admin → appointments → desk → vitals → consult → display + docs). B consumes A's services; C consumes B's HTTP/WS surface. Within each pipeline tasks share files (`test/helpers/opd.ts` grows in A; `apps/web` router/locales in C) — no parallel waves.

---

## Tasks

Sixteen tasks in three pipelines (A = T1–T6, B = T7–T10, C = T11–T16), ≤ 6 per Workflow, strictly sequential within each. Every task's brief carries EXECUTION-LESSONS §1 tripwires 1–21 verbatim at the top, the mutant-discipline block from Pipeline Notes, and the deviations-not-to-fix list.

---

### Task 1: Schema — twelve tables, migration 0010, the truncate group, IST helpers, the error union  *(opus coder — the plan's only migration)*

**Files:**
- Create: `apps/core/src/kernel/db/schema/opd.ts`
- Create: `apps/core/src/kernel/db/schema/opd.test.ts`
- Modify: `apps/core/src/kernel/db/schema/index.ts` (one line: `export * from "./opd";`)
- Create (generated): `apps/core/drizzle/0010_<name>.sql`, `apps/core/drizzle/meta/0010_snapshot.json`; Modify (generated): `apps/core/drizzle/meta/_journal.json`
- Modify: `apps/core/test/helpers/db.ts` (ONE statement — the patients group gains the twelve OPD names)
- Create: `apps/core/src/modules/opd/errors.ts`, `apps/core/src/modules/opd/time.ts`, `apps/core/src/modules/opd/time.test.ts`

- [ ] **Step 1: Write the failing schema tests** — `apps/core/src/kernel/db/schema/opd.test.ts`. They import `./opd`, which does not exist yet: the red is an unresolved import, the accepted evidence for a brand-new file (Plan 05 T1/T11 precedent; §3.23 is about MIXED reds, and nothing here is mixed — every assertion below is semantic once the file exists).

```ts
import { eq, sql } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { withTx } from "../client";
import {
  opdAppointments, opdConfig, opdDepartments, opdDoctors, opdEncounters, opdQueueEntries, opdQueueSessions,
  opdRooms, opdVitals, patients, registrationConfig,
} from "./index";
import type { Db } from "../client";

const AUDIT = { createdBy: "t", updatedBy: "t" };

describe("opd schema (migration 0010)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  async function seedDoctor(): Promise<{ deptId: string; roomId: string; doctorId: string }> {
    await db.insert(opdDepartments).values({ id: "D1", code: "MED", name: "General Medicine", ...AUDIT });
    await db.insert(opdRooms).values({ id: "R1", code: "12", name: "Room 12", ...AUDIT });
    await db.insert(opdDoctors).values({ id: "DOC1", userId: "U1", displayName: "Dr A", departmentId: "D1", ...AUDIT });
    return { deptId: "D1", roomId: "R1", doctorId: "DOC1" };
  }
  async function seedPatient(id: string): Promise<void> {
    await db.insert(patients).values({ id, uhid: `HMS-0000000${id.slice(-1)}-0`, name: "P", sex: "other", createdBy: "t", updatedBy: "t" });
  }

  it("service_date round-trips as a YYYY-MM-DD STRING (mode: string) — no timezone shift", async () => {
    const { doctorId } = await seedDoctor();
    await db.insert(opdQueueSessions).values({ id: "S1", doctorId, serviceDate: "2026-08-15", status: "not_started" });
    const rows = await db.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, "S1"));
    expect(rows[0]!.serviceDate).toBe("2026-08-15");
    expect(typeof rows[0]!.serviceDate).toBe("string");
  });

  it("appointments: the partial unique index arbitrates one live booking per (doctor, slot_start)", async () => {
    const { doctorId, deptId } = await seedDoctor();
    await seedPatient("P1"); await seedPatient("P2"); await seedPatient("P3");
    const slot = new Date("2026-08-17T05:00:00.000Z"); // 10:30 IST
    const base = { doctorId, departmentId: deptId, serviceDate: "2026-08-17", slotStart: slot, slotEnd: new Date(slot.getTime() + 600_000), bookedBy: "t", updatedBy: "t" };
    await db.insert(opdAppointments).values({ id: "A1", patientId: "P1", status: "cancelled", ...base });
    await db.insert(opdAppointments).values({ id: "A2", patientId: "P2", status: "booked", ...base }); // cancelled A1 does not block
    await expect(
      db.insert(opdAppointments).values({ id: "A3", patientId: "P3", status: "booked", ...base }),
    ).rejects.toMatchObject({ code: "23505" });
    const claimed = await db.insert(opdAppointments).values({ id: "A4", patientId: "P3", status: "needs_rebooking", ...base }).onConflictDoNothing().returning({ id: opdAppointments.id });
    expect(claimed).toEqual([]); // needs_rebooking is inside the live set
  });

  it("queue entries carry a database-side bigserial seq that climbs in insertion order inside one transaction", async () => {
    const { doctorId } = await seedDoctor();
    await seedPatient("P1");
    await db.insert(opdQueueSessions).values({ id: "S1", doctorId, serviceDate: "2026-08-15", status: "in" });
    await db.insert(opdEncounters).values({ id: "E1", patientId: "P1", workflowInstanceId: "WI1", doctorId, serviceDate: "2026-08-15", visitType: "new", openedBy: "t", updatedBy: "t" });
    const seqs = await withTx(db, async (tx) => {
      const out: number[] = [];
      for (const [id, token] of [["Q1", 1], ["Q2", 2], ["Q3", 3]] as const) {
        const r = await tx.insert(opdQueueEntries).values({ id, sessionId: "S1", encounterId: "E1", tokenNo: token, kind: "walk_in", status: "waiting_vitals" }).returning({ seq: opdQueueEntries.seq });
        out.push(r[0]!.seq);
      }
      return out;
    });
    expect(seqs[1]! - seqs[0]!).toBe(1);
    expect(seqs[2]! - seqs[1]!).toBe(1);
    expect(typeof seqs[0]).toBe("number");
  });

  it("vitals doubles round-trip exactly (38.4, 12.5) and jsonb flags survive", async () => {
    const { doctorId } = await seedDoctor();
    await seedPatient("P1");
    await db.insert(opdEncounters).values({ id: "E1", patientId: "P1", workflowInstanceId: "WI1", doctorId, serviceDate: "2026-08-15", visitType: "new", openedBy: "t", updatedBy: "t" });
    await db.insert(opdVitals).values({ id: "V1", encounterId: "E1", patientId: "P1", tempC: 38.4, weightKg: 12.5, dangerFlags: [{ vital: "tempC", value: 38.4, bound: "max", limit: 38.0 }], band: "child_1_5", recordedBy: "t" });
    const rows = await db.select().from(opdVitals).where(eq(opdVitals.id, "V1"));
    expect(rows[0]!.tempC).toBe(38.4);
    expect(rows[0]!.weightKg).toBe(12.5);
    expect(rows[0]!.dangerFlags).toEqual([{ vital: "tempC", value: 38.4, bound: "max", limit: 38.0 }]);
  });

  it("truncateAll clears the OPD chain that FKs into patients (§3.12: same statement)", async () => {
    const { doctorId } = await seedDoctor();
    await seedPatient("P1");
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" });
    await db.insert(opdEncounters).values({ id: "E1", patientId: "P1", workflowInstanceId: "WI1", doctorId, serviceDate: "2026-08-15", visitType: "new", openedBy: "t", updatedBy: "t" });
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15, 21, 30], dangerRanges: { bands: [] }, letterhead: { name: "X", addressLines: [] }, updatedBy: "t" });
    await truncateAll(db); // throws "cannot truncate a table referenced in a foreign key constraint" if the statement is wrong
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from opd_encounters`)).rows as [{ n: number }];
    expect(n).toBe(0);
    const [{ p }] = (await db.execute(sql`select count(*)::int as p from patients`)).rows as [{ p: number }];
    expect(p).toBe(0);
  });
});
```

- [ ] **Step 2: Write the schema** — `apps/core/src/kernel/db/schema/opd.ts` (comments are part of the deliverable — they are the column contract later tasks and Plan 08 read):

```ts
import { sql } from "drizzle-orm";
import {
  bigserial, boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";
import { patients } from "./patients";

/**
 * OPD module tables (Plan 07). Kernel-located by the shipped one-migration-dir convention; ownership
 * is code discipline — only modules/opd touches them (spec §4). Text ids are ULIDs via newId() and are
 * NEVER an ordering key (ids.ts WARNING, ledger §3.26): arrival order is opd_queue_entries.seq (bigserial),
 * recency is a timestamp. Dates are IST calendar dates stored as 'YYYY-MM-DD' strings (mode: "string");
 * instants are timestamptz.
 *
 * Deliberately NO foreign key from any OPD table into users or workflow_instances (plain text ids — the
 * patient_merge_requests.approval_id precedent), so the twelve tables join exactly ONE truncate group
 * (the patients statement in test/helpers/db.ts).
 */

/** Single audited config row (id = 'main'), seeded by scripts/seed-opd.ts. Missing ⇒ every OPD write hard-fails (no fallbacks). */
export const opdConfig = pgTable("opd_config", {
  id: text("id").primaryKey(),
  slotMinutes: integer("slot_minutes").notNull().default(10), // owner decision: 10-minute slots
  followUpDefaultDays: integer("follow_up_default_days").notNull().default(7), // §11.1 default; owner: 7
  followUpExtensionDays: jsonb("follow_up_extension_days").notNull(), // number[] — the values a doctor may set: [15, 21, 30]
  extensionCapPerDoctorPerMonth: integer("extension_cap_per_doctor_per_month").notNull().default(30), // §11.19-C fix 14
  maxSkipsBeforeLeft: integer("max_skips_before_left").notNull().default(3),
  perkEveryNth: integer("perk_every_nth"), // E-32 bounded interleave; null = off. Plan 09 sets it.
  dangerRanges: jsonb("danger_ranges").notNull(), // DangerRangesConfig (modules/opd/config.ts) — age-banded thresholds + required fields
  letterhead: jsonb("letterhead").notNull(), // { name: string; addressLines: string[] } — printed on the e-Rx
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const opdDepartments = pgTable(
  "opd_departments",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // short stable code, e.g. 'MED', 'PED' — printed on token slips
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_departments_code_ux").on(t.code)],
);

export const opdRooms = pgTable(
  "opd_rooms",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(), // what the display board and the token slip show, e.g. '12', 'B-4'
    name: text("name").notNull(),
    floor: text("floor"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_rooms_code_ux").on(t.code)],
);

/** Doctor profile — a Plan 02 user (user_id, plain text, no FK) with one primary OPD department. */
export const opdDoctors = pgTable(
  "opd_doctors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(), // users.id — plain text (see header)
    displayName: text("display_name").notNull(), // shown on displays, slips, e-Rx
    registrationNo: text("registration_no"), // NMC/state council registration — printed on the e-Rx
    departmentId: text("department_id").notNull().references(() => opdDepartments.id),
    specialty: text("specialty"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_doctors_user_ux").on(t.userId), index("opd_doctors_department_idx").on(t.departmentId)],
);

/** Weekly availability template. Times are IST 'HH:MM'. Slots are derived, never materialised (slots.ts). */
export const opdDoctorSchedules = pgTable(
  "opd_doctor_schedules",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    weekday: integer("weekday").notNull(), // 0 = Sunday … 6 = Saturday (IST calendar)
    startTime: text("start_time").notNull(), // 'HH:MM'
    endTime: text("end_time").notNull(), // 'HH:MM', exclusive
    roomId: text("room_id").notNull().references(() => opdRooms.id),
    slotMinutes: integer("slot_minutes"), // null ⇒ opd_config.slot_minutes
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }), // null = open-ended
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opd_doctor_schedules_doctor_idx").on(t.doctorId)],
);

/** Planned leave (§11.5 cascade): blocks slots, marks affected bookings needs_rebooking. */
export const opdDoctorLeaves = pgTable(
  "opd_doctor_leaves",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    fromDate: date("from_date", { mode: "string" }).notNull(),
    toDate: date("to_date", { mode: "string" }).notNull(), // inclusive
    reason: text("reason").notNull(),
    status: text("status").notNull().default("scheduled"), // 'scheduled' | 'cancelled'
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledBy: text("cancelled_by"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (t) => [index("opd_doctor_leaves_doctor_idx").on(t.doctorId)],
);

export const opdAppointments = pgTable(
  "opd_appointments",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    departmentId: text("department_id").notNull().references(() => opdDepartments.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(), // IST calendar date of slot_start
    slotStart: timestamp("slot_start", { withTimezone: true }).notNull(),
    slotEnd: timestamp("slot_end", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("booked"), // 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'needs_rebooking' | 'rescheduled'
    source: text("source").notNull().default("desk"), // 'desk' | 'phone' — the booking channel (self-booking arrives Plan 10)
    note: text("note"),
    encounterId: text("encounter_id"), // set on check-in; plain text (encounters FK appointments, not the reverse)
    rescheduledToId: text("rescheduled_to_id"),
    rescheduledFromId: text("rescheduled_from_id"),
    cancelReason: text("cancel_reason"),
    leaveId: text("leave_id"), // set when needs_rebooking was caused by a leave (cancelling that leave restores 'booked')
    bookedBy: text("booked_by").notNull(),
    bookedAt: timestamp("booked_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ONE live booking per doctor-slot — the arbiter for the booking race (single loser code: slot_taken).
    uniqueIndex("opd_appointments_slot_ux")
      .on(t.doctorId, t.slotStart)
      .where(sql`${t.status} in ('booked', 'checked_in', 'needs_rebooking')`),
    index("opd_appointments_doctor_date_idx").on(t.doctorId, t.serviceDate),
    index("opd_appointments_patient_idx").on(t.patientId),
    index("opd_appointments_status_idx").on(t.status),
  ],
);

/** One row per doctor per IST day: the token counter, the call counter, in/out status, the room. */
export const opdQueueSessions = pgTable(
  "opd_queue_sessions",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    roomId: text("room_id").references(() => opdRooms.id), // from the day's schedule template; null if unscheduled
    status: text("status").notNull().default("not_started"), // 'not_started' | 'in' | 'out' | 'closed'
    nextToken: integer("next_token").notNull().default(1), // allocated by UPDATE … SET next_token = next_token + 1 RETURNING
    callsMade: integer("calls_made").notNull().default(0), // drives the E-32 every-Nth interleave
    openedAt: timestamp("opened_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("opd_queue_sessions_doctor_date_ux").on(t.doctorId, t.serviceDate)],
);

/**
 * The encounter spine (spec §6). type is an OPEN text enum ('opd' now; 'ipd' | 'er' | 'teleconsult' later) and every
 * clinical/assignment column is nullable so later encounter types need no redesign. status MIRRORS the workflow
 * instance's current state and is written ONLY by encounters.ts moveEncounter, in the same transaction as
 * transition() — the instance is the arbiter, this column is the read model.
 */
export const opdEncounters = pgTable(
  "opd_encounters",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id").notNull().references(() => patients.id), // canonical id at open; merged-loser history is found via listMergedLoserIds
    type: text("type").notNull().default("opd"),
    status: text("status").notNull().default("registered"), // opd_visit states: registered | waiting | in_consultation | awaiting_results | completed | abandoned
    workflowInstanceId: text("workflow_instance_id").notNull(), // workflow_instances.id — plain text (see header)
    departmentId: text("department_id").references(() => opdDepartments.id),
    doctorId: text("doctor_id").references(() => opdDoctors.id),
    appointmentId: text("appointment_id").references(() => opdAppointments.id),
    serviceDate: date("service_date", { mode: "string" }).notNull(),
    visitType: text("visit_type").notNull(), // 'new' | 'revisit' | 'renewal' — auto-detected at open (visit-type.ts); Plan 08's fee branch
    intendedPayer: text("intended_payer").notNull().default("self"), // 'self' | 'tpa' | 'pmjay' | 'corporate' (§6)
    referralSource: text("referral_source"), // 'self' | 'internal_doctor' | 'external_rmp' | 'camp' | 'other' — attribution capture (§6); Plan 09 uses it
    referrerName: text("referrer_name"),
    // Consultation record (T7) — nullable until the doctor writes it.
    chiefComplaint: text("chief_complaint"),
    diagnosis: text("diagnosis"),
    icd10Code: text("icd10_code"), // §11.19-E fix 31: capturable at consult, not only at MRD coding
    advice: text("advice"),
    admissionAdvised: boolean("admission_advised").notNull().default(false),
    referralTo: text("referral_to"),
    referralNote: text("referral_note"),
    followUpDays: integer("follow_up_days"), // stamped at completion: config default or an extension value
    followUpExtended: boolean("follow_up_extended").notNull().default(false),
    dangerFlagged: boolean("danger_flagged").notNull().default(false), // set by vitals; never auto-cleared in Plan 07
    consultStartedAt: timestamp("consult_started_at", { withTimezone: true }),
    consultCompletedAt: timestamp("consult_completed_at", { withTimezone: true }),
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    abandonReason: text("abandon_reason"),
    openedBy: text("opened_by").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Visit-type detection: newest completed consult of this patient in this department.
    index("opd_encounters_patient_dept_completed_idx").on(t.patientId, t.departmentId, t.consultCompletedAt),
    // Extension cap: this doctor's extended completions in an IST month.
    index("opd_encounters_doctor_completed_idx").on(t.doctorId, t.consultCompletedAt),
    index("opd_encounters_doctor_date_idx").on(t.doctorId, t.serviceDate),
    index("opd_encounters_patient_opened_idx").on(t.patientId, t.openedAt),
    index("opd_encounters_status_idx").on(t.status),
  ],
);

/** Queue rows. seq is the arrival order (bigserial — never the ULID id). One live row per encounter at a time. */
export const opdQueueEntries = pgTable(
  "opd_queue_entries",
  {
    id: text("id").primaryKey(),
    seq: bigserial("seq", { mode: "number" }),
    sessionId: text("session_id").notNull().references(() => opdQueueSessions.id),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    tokenNo: integer("token_no").notNull(), // per doctor-day; a re-entry row REUSES the token
    kind: text("kind").notNull(), // 'appointment' | 'walk_in'
    appointmentAt: timestamp("appointment_at", { withTimezone: true }), // slot_start for appointments; null for walk-ins
    status: text("status").notNull(), // 'waiting_vitals' | 'waiting' | 'called' | 'in_consult' | 'done' | 'left' | 'transferred' | 'cancelled'
    danger: boolean("danger").notNull().default(false), // class 0
    reEntry: boolean("re_entry").notNull().default(false), // class 1 (same-day return with results)
    perk: boolean("perk").notNull().default(false), // E-32 hook — Plan 09 sets it; never true in Plan 07
    eligibleAt: timestamp("eligible_at", { withTimezone: true }), // set when the row becomes 'waiting' (and reset on a skip)
    calledAt: timestamp("called_at", { withTimezone: true }),
    callCount: integer("call_count").notNull().default(0),
    skips: integer("skips").notNull().default(0),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opd_queue_entries_session_status_idx").on(t.sessionId, t.status),
    index("opd_queue_entries_encounter_idx").on(t.encounterId),
  ],
);

export const opdVitals = pgTable(
  "opd_vitals",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    heightCm: doublePrecision("height_cm"),
    weightKg: doublePrecision("weight_kg"), // §11.8: the pediatric weight context — required under 18
    sbp: integer("sbp"),
    dbp: integer("dbp"),
    pulse: integer("pulse"),
    rr: integer("rr"),
    spo2: integer("spo2"),
    tempC: doublePrecision("temp_c"),
    notes: text("notes"),
    ageYearsAtRecord: integer("age_years_at_record"), // null when DOB unknown (adult band applied)
    band: text("band").notNull(), // 'infant' | 'child_1_5' | 'child_6_12' | 'adult'
    dangerFlags: jsonb("danger_flags").notNull(), // DangerFlag[] — [] when normal
    recordedBy: text("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opd_vitals_encounter_idx").on(t.encounterId), index("opd_vitals_patient_idx").on(t.patientId)],
);

/** Versioned per encounter; a re-issue supersedes. document is a FHIR-shaped Bundle (fhir.ts). */
export const opdPrescriptions = pgTable(
  "opd_prescriptions",
  {
    id: text("id").primaryKey(),
    encounterId: text("encounter_id").notNull().references(() => opdEncounters.id),
    patientId: text("patient_id").notNull().references(() => patients.id),
    doctorId: text("doctor_id").notNull().references(() => opdDoctors.id),
    version: integer("version").notNull(), // 1, 2, … per encounter (allocated under a FOR UPDATE of the encounter row)
    lines: jsonb("lines").notNull(), // RxLine[]
    document: jsonb("document").notNull(), // FHIR Bundle
    allergyOverrides: jsonb("allergy_overrides").notNull(), // AllergyOverride[] — [] when none
    status: text("status").notNull().default("active"), // 'active' | 'superseded'
    issuedBy: text("issued_by").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("opd_prescriptions_encounter_version_ux").on(t.encounterId, t.version),
    index("opd_prescriptions_patient_idx").on(t.patientId),
  ],
);
```

Append `export * from "./opd";` to `src/kernel/db/schema/index.ts`.

- [ ] **Step 3: Generate the migration** — `cd /opt/hmis && pnpm --filter @hmis/core db:generate` (needs `DATABASE_URL` from `apps/core/.env`, as Plans 05/06 did). Inspect the generated `drizzle/0010_*.sql` and CONFIRM (quote the lines in the report): (a) the partial index `opd_appointments_slot_ux` carries `WHERE "opd_appointments"."status" in ('booked', 'checked_in', 'needs_rebooking')`; (b) `opd_queue_entries.seq` is `bigserial NOT NULL`; (c) `service_date`/`valid_from`/`from_date` are `date`; (d) `weight_kg`/`temp_c`/`height_cm` are `double precision`; (e) `opd_prescriptions_encounter_version_ux` is a plain unique index. If (a) is dropped or altered — STOP and report (never hand-edit generated SQL). The generator's full output set (`0010_*.sql`, `meta/0010_snapshot.json`, `meta/_journal.json`) is committed (§3.16).

- [ ] **Step 4: Extend the truncate group — RED FIRST.** With the schema in place (Step 2–3) but `db.ts` untouched, run `pnpm --filter @hmis/core exec jest --passWithNoTests src/kernel/db/schema/opd.test`: EVERY test fails in `beforeEach` with `cannot truncate a table referenced in a foreign key constraint` (Postgres checks the constraint's EXISTENCE, not row counts — ledger §3.12; the twelve empty OPD tables FK into `patients`). Quote that message — it is Assertion Book row K1's executed pre-fix red (the shipped `db.ts` IS the mutant). Then in `apps/core/test/helpers/db.ts` replace the patients statement (currently `truncate table patient_merge_requests, patient_guardians, patient_allergies, patient_photos, patients, registration_config`) with ONE statement:

```ts
  await db.execute(
    sql`truncate table opd_prescriptions, opd_vitals, opd_queue_entries, opd_encounters, opd_appointments,
        opd_queue_sessions, opd_doctor_leaves, opd_doctor_schedules, opd_doctors, opd_rooms, opd_departments,
        opd_config, patient_merge_requests, patient_guardians, patient_allergies, patient_photos, patients,
        registration_config`,
  );
```
No other statement changes; `setupTestDb` untouched.

- [ ] **Step 5: The error union and the IST helpers (red-first for `time.ts`)** — create `apps/core/src/modules/opd/errors.ts`:

```ts
export type OpdErrorCode =
  | "user_actor_required" | "opd_not_configured" | "opd_config_invalid" | "invalid_config"
  | "unknown_department" | "department_inactive" | "duplicate_department_code"
  | "unknown_room" | "duplicate_room_code"
  | "unknown_doctor" | "doctor_inactive" | "unknown_user" | "user_already_doctor" | "doctor_department_mismatch"
  | "not_a_doctor" | "not_your_patient"
  | "invalid_schedule" | "unknown_schedule" | "unknown_leave" | "leave_not_scheduled" | "invalid_leave_range"
  | "patient_not_found"
  | "invalid_slot" | "slot_taken" | "slot_in_past" | "doctor_on_leave" | "unknown_appointment"
  | "appointment_state_conflict" | "appointment_not_today"
  | "unknown_encounter" | "encounter_state_conflict" | "unknown_session" | "session_closed" | "doctor_out"
  | "call_conflict" | "unknown_queue_entry" | "queue_entry_state_conflict" | "invalid_transfer"
  | "invalid_vitals" | "vitals_incomplete"
  | "invalid_follow_up_days" | "extension_cap_reached" | "reason_required"
  | "allergy_conflict" | "override_reason_required" | "empty_prescription" | "unknown_prescription";

export class OpdError extends Error {
  constructor(
    readonly code: OpdErrorCode,
    message?: string,
    readonly detail?: unknown, // e.g. allergy matches, missing vitals — carried to the HTTP body
  ) {
    super(message ?? code);
    this.name = "OpdError";
  }
}
```

Write `apps/core/src/modules/opd/time.test.ts` FIRST (red at unresolved import — a new file), with these hand-derived expectations:

```ts
import { addDays, ageYearsAt, istDate, istDateTimeToUtc, istDayIndex, istMonthBounds, istWeekday } from "./time";

describe("IST helpers (pure, fixed +05:30, no DST)", () => {
  it("istDate flips at 18:30 UTC", () => {
    expect(istDate(new Date("2026-08-15T18:29:59.000Z"))).toBe("2026-08-15");
    expect(istDate(new Date("2026-08-15T18:30:00.000Z"))).toBe("2026-08-16");
  });
  it("istDayIndex differences count IST calendar days", () => {
    // 2026-08-08 23:59:59 IST → 2026-08-16 00:00:00 IST = 8 days
    expect(istDayIndex(new Date("2026-08-15T18:30:00.000Z")) - istDayIndex(new Date("2026-08-08T18:29:59.000Z"))).toBe(8);
    expect(istDayIndex(new Date("2026-08-15T18:29:59.000Z")) - istDayIndex(new Date("2026-08-15T00:00:00.000Z"))).toBe(0);
  });
  it("istDateTimeToUtc: 2026-08-17 10:30 IST = 05:00 UTC", () => {
    expect(istDateTimeToUtc("2026-08-17", "10:30").toISOString()).toBe("2026-08-17T05:00:00.000Z");
    expect(istDateTimeToUtc("2026-08-17", "00:00").toISOString()).toBe("2026-08-16T18:30:00.000Z");
  });
  it("istWeekday: 2026-08-17 is a Monday (1); 2026-08-16 a Sunday (0)", () => {
    expect(istWeekday("2026-08-17")).toBe(1);
    expect(istWeekday("2026-08-16")).toBe(0);
  });
  it("addDays crosses month ends", () => {
    expect(addDays("2026-08-30", 3)).toBe("2026-09-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("istMonthBounds for August 2026 = [Jul 31 18:30Z, Aug 31 18:30Z)", () => {
    const b = istMonthBounds(new Date("2026-08-15T12:00:00.000Z"));
    expect(b.start.toISOString()).toBe("2026-07-31T18:30:00.000Z");
    expect(b.end.toISOString()).toBe("2026-08-31T18:30:00.000Z");
  });
  it("ageYearsAt is anniversary-aware", () => {
    const at = new Date("2026-08-15T06:00:00.000Z");
    expect(ageYearsAt(new Date("1990-04-02T00:00:00.000Z"), at)).toBe(36);
    expect(ageYearsAt(new Date("2016-08-16T00:00:00.000Z"), at)).toBe(9); // birthday tomorrow
    expect(ageYearsAt(new Date("2016-08-15T00:00:00.000Z"), at)).toBe(10); // birthday today
  });
});
```

Then `apps/core/src/modules/opd/time.ts`:

```ts
/** IST = UTC+05:30, fixed, no DST — the hospital clock. Pure: no Intl, no process TZ. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** Whole IST days since the epoch — subtract two to count calendar days between instants. */
export function istDayIndex(at: Date): number {
  return Math.floor((at.getTime() + IST_OFFSET_MS) / DAY_MS);
}

/** The IST calendar date of an instant, 'YYYY-MM-DD'. */
export function istDate(at: Date): string {
  return new Date(istDayIndex(at) * DAY_MS).toISOString().slice(0, 10);
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y!, m!, d!];
}

/** An IST wall-clock 'HH:MM' on an IST date → the UTC instant. */
export function istDateTimeToUtc(date: string, hhmm: string): Date {
  const [y, m, d] = parts(date);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh!, mm!) - IST_OFFSET_MS);
}

/** 0 = Sunday … 6 = Saturday for an IST calendar date. */
export function istWeekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** [start, end) UTC instants of the IST calendar month containing `at`. */
export function istMonthBounds(at: Date): { start: Date; end: Date } {
  const [y, m] = parts(istDate(at));
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS),
  };
}

/** Whole years between dob and `at`, UTC, anniversary-aware (mirrors patients/types.ts yearsBetween, which is module-private). */
export function ageYearsAt(dob: Date, at: Date): number {
  const years = at.getUTCFullYear() - dob.getUTCFullYear();
  const notYet =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  return notYet ? years - 1 : years;
}
```

- [ ] **Step 6: Run to pass.** `pnpm --filter @hmis/core exec jest --passWithNoTests src/kernel/db/schema/opd.test src/modules/opd/time.test` → 2 suites, 5 + 7 = **12 tests**. Then the whole workspace: **71 suites / 408 tests** (69/396 + 2 suites, +12). Detached root `pnpm verify` (tripwire 18), exit read from the file.
- [ ] **Step 7: Commit** — `feat(core): OPD schema — twelve tables, migration 0010, truncate group, IST helpers, error union` → `git pull --rebase origin main` → `git push origin main`.

**Acceptance criteria:**
1. `drizzle/0010_*.sql` exists, generated once, with the five confirmations of Step 3 quoted in the report; `_journal.json` has idx 10; no other migration file changed.
2. `opd.test.ts` 5/5 and `time.test.ts` 7/7 pass; the truncate test passes (which is only possible if the twelve names sit in the patients statement); the fail-first red for both new suites (unresolved import) is quoted — or, if a prior attempt already shipped the files, the gate re-derives the Assertion Book rows instead (§2.8).
3. `test/helpers/db.ts` differs from shipped in exactly ONE statement; `setupTestDb` byte-identical.
4. Workspace 71 suites / 408 tests; `pnpm verify` green; no scratch residue; `git status` clean.
5. `errors.ts` exports the union and class exactly as written (later tasks may only ADD codes, disclosed).

---

### Task 2: Events, config, masters, weekly schedules, pure slots — and the shared OPD test helper  *(sonnet coder)*

**Files:**
- Create: `apps/core/src/modules/opd/events.ts` (the complete catalog for this module)
- Create: `apps/core/src/modules/opd/config.ts`, `apps/core/src/modules/opd/config.test.ts`
- Create: `apps/core/src/modules/opd/masters.ts`, `apps/core/src/modules/opd/masters.test.ts`
- Create: `apps/core/src/modules/opd/schedules.ts`, `apps/core/src/modules/opd/schedules.test.ts`
- Create: `apps/core/src/modules/opd/slots.ts`, `apps/core/src/modules/opd/slots.test.ts`
- Create: `apps/core/test/helpers/opd.ts` (T3 appends `activateOpdVisitDefinition`; T4+ only consume it)

- [ ] **Step 1: The event catalog** — `apps/core/src/modules/opd/events.ts`. Every payload that names a doctor also names `serviceDate`, `sessionId`, `roomId` and `tokenNo` where they exist, because the realtime router (T8) topics on them; every encounter-scoped payload names `encounterId` and `patientId`. Exact file:

```ts
import { z } from "zod";
import { defineEvent } from "@hmis/contracts";

/**
 * The OPD module's complete event surface (Plan 07): seventeen §10.6 P1 names plus qr.signature_failed
 * (Plan 05's name and grammar, for e-Rx scans). queue.called, queue.skipped and visit.abandoned are catalog
 * ADDITIONS ratified by the owner on 2026-08-15 (the written catalog omitted the queue-call facts §11.1
 * describes). module "opd" on every one. Nothing else in this module emits.
 */
const MODULE = "opd";
const id = z.string().min(1);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); // IST calendar date
const iso = z.string().min(1); // ISO instant

/** Doctor-day location fields — the realtime router topics on these. roomId is null when the doctor-day has no template room. */
const where = {
  doctorId: id,
  serviceDate: isoDate,
  sessionId: id,
  roomId: z.string().nullable(),
  tokenNo: z.number().int().positive(),
};

export const dangerFlagSchema = z.object({
  vital: z.enum(["sbp", "dbp", "pulse", "rr", "spo2", "tempC"]),
  value: z.number(),
  bound: z.enum(["min", "max"]),
  limit: z.number(),
});
export type DangerFlag = z.infer<typeof dangerFlagSchema>;

export const appointmentBooked = defineEvent("appointment.booked", MODULE, z.object({
  appointmentId: id, patientId: id, doctorId: id, departmentId: id, serviceDate: isoDate, slotStart: iso,
  source: z.enum(["desk", "phone"]),
}));

export const appointmentRescheduled = defineEvent("appointment.rescheduled", MODULE, z.object({
  fromAppointmentId: id, toAppointmentId: id, patientId: id, doctorId: id, departmentId: id,
  serviceDate: isoDate, slotStart: iso, previousDoctorId: id, previousSlotStart: iso,
}));

export const appointmentCancelled = defineEvent("appointment.cancelled", MODULE, z.object({
  appointmentId: id, patientId: id, doctorId: id, serviceDate: isoDate, slotStart: iso, reason: z.string().min(1),
}));

export const appointmentNoShow = defineEvent("appointment.no_show", MODULE, z.object({
  appointmentId: id, patientId: id, doctorId: id, serviceDate: isoDate, slotStart: iso,
}));

export const doctorLeaveScheduled = defineEvent("doctor_leave.scheduled", MODULE, z.object({
  leaveId: id, doctorId: id, fromDate: isoDate, toDate: isoDate, reason: z.string().min(1),
  affectedAppointmentIds: z.array(id), // marked needs_rebooking in the same transaction (§11.5 cascade)
}));

export const visitOpened = defineEvent("visit.opened", MODULE, z.object({
  encounterId: id, patientId: id, departmentId: id, ...where,
  visitType: z.enum(["new", "revisit", "renewal"]),
  intendedPayer: z.enum(["self", "tpa", "pmjay", "corporate"]),
  kind: z.enum(["walk_in", "appointment"]),
  appointmentId: z.string().nullable(),
}));

export const patientCheckedIn = defineEvent("patient.checked_in", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  kind: z.enum(["arrival", "re_entry"]), // family lifecycle, type in payload (§10.5)
}));

export const visitTransferred = defineEvent("visit.transferred", MODULE, z.object({
  encounterId: id, patientId: id, serviceDate: isoDate,
  fromDoctorId: id, toDoctorId: id, fromSessionId: id, toSessionId: id,
  roomId: z.string().nullable(), tokenNo: z.number().int().positive(), // the NEW token in the target session
  consented: z.boolean(), reason: z.string().min(1),
}));

export const visitAbandoned = defineEvent("visit.abandoned", MODULE, z.object({
  encounterId: id, patientId: id, ...where,
  fromState: z.enum(["registered", "waiting", "awaiting_results"]), reason: z.string().min(1),
}));

export const vitalsRecorded = defineEvent("vitals.recorded", MODULE, z.object({
  encounterId: id, patientId: id, vitalsId: id, ...where,
  band: z.enum(["infant", "child_1_5", "child_6_12", "adult"]),
  dangerCount: z.number().int().nonnegative(),
}));

export const vitalsDangerFlagged = defineEvent("vitals.danger_flagged", MODULE, z.object({
  encounterId: id, patientId: id, vitalsId: id, ...where,
  flags: z.array(dangerFlagSchema).min(1),
}));

export const queueCalled = defineEvent("queue.called", MODULE, z.object({
  encounterId: id, patientId: id, entryId: id, ...where,
  callCount: z.number().int().positive(),
}));

export const queueSkipped = defineEvent("queue.skipped", MODULE, z.object({
  encounterId: id, patientId: id, entryId: id, ...where,
  skips: z.number().int().positive(),
  left: z.boolean(), // true when max_skips_before_left was reached and the entry left the queue
}));

export const consultationStarted = defineEvent("consultation.started", MODULE, z.object({
  encounterId: id, patientId: id, departmentId: id, ...where,
}));

export const consultationCompleted = defineEvent("consultation.completed", MODULE, z.object({
  encounterId: id, patientId: id, departmentId: id, ...where,
  visitType: z.enum(["new", "revisit", "renewal"]),
  followUpDays: z.number().int().positive(),
  followUpExtended: z.boolean(), // §11.19-C fix 14: each extension is evented; the pattern report derives from this
  admissionAdvised: z.boolean(),
  referralIssued: z.boolean(),
  prescriptionCount: z.number().int().nonnegative(),
  icd10Code: z.string().nullable(),
}));

export const prescriptionIssued = defineEvent("prescription.issued", MODULE, z.object({
  prescriptionId: id, encounterId: id, patientId: id, doctorId: id,
  version: z.number().int().positive(), lineCount: z.number().int().positive(),
  allergyOverrideCount: z.number().int().nonnegative(), // the S10 override-rate KPI numerator
}));

export const referralIssued = defineEvent("referral.issued", MODULE, z.object({
  encounterId: id, patientId: id, doctorId: id, referralTo: z.string().min(1), note: z.string().nullable(),
}));

/** IPD-phase stub: records the intent only. Bed/admission machinery is rollout stage 4. */
export const admissionRequested = defineEvent("admission.requested", MODULE, z.object({
  encounterId: id, patientId: id, doctorId: id, departmentId: id, note: z.string().nullable(),
}));

/** Same catalog name and grammar as modules/patients (D-23) — the subject here is an e-Rx QR. */
export const rxQrSignatureFailed = defineEvent("qr.signature_failed", MODULE, z.object({
  reason: z.enum(["malformed", "invalid_signature", "stale_version", "unknown_prescription"]),
  payloadPrefix: z.string(),
  patientId: z.string().optional(), // only when the signature verified
}));
```

- [ ] **Step 2: Config (red-first)** — write `config.test.ts` first:

```ts
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { opdConfig } from "../../kernel/db/schema";
import { DEFAULT_DANGER_RANGES, DEFAULT_LETTERHEAD, dangerRangesSchema, loadOpdConfig } from "./config";
import type { Db } from "../../kernel/db/client";

describe("opd config", () => {
  let db: Db; let teardown: () => Promise<void>;
  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); });

  it("hard-fails when the row is missing (no fallbacks)", async () => {
    await expect(loadOpdConfig(db)).rejects.toMatchObject({ code: "opd_not_configured" });
  });

  it("the shipped defaults parse and round-trip: four bands, adult last, weight required under 18", async () => {
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15, 21, 30], dangerRanges: DEFAULT_DANGER_RANGES, letterhead: DEFAULT_LETTERHEAD, updatedBy: "t" });
    const cfg = await loadOpdConfig(db);
    expect(cfg.slotMinutes).toBe(10);
    expect(cfg.followUpDefaultDays).toBe(7);
    expect(cfg.followUpExtensionDays).toEqual([15, 21, 30]);
    expect(cfg.extensionCapPerDoctorPerMonth).toBe(30);
    expect(cfg.maxSkipsBeforeLeft).toBe(3);
    expect(cfg.perkEveryNth).toBeNull();
    expect(cfg.dangerRanges.bands.map((b) => b.key)).toEqual(["infant", "child_1_5", "child_6_12", "adult"]);
    expect(cfg.dangerRanges.bands[3]!.upToAgeYears).toBeNull();
    expect(cfg.dangerRanges.weightRequiredUnderYears).toBe(18);
    expect(cfg.dangerRanges.bands[3]!.ranges.sbp).toEqual({ min: 90, max: 180 });
    expect(cfg.letterhead).toEqual({ name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"] });
  });

  it("an invalid danger_ranges JSON hard-fails with opd_config_invalid (a band without an adult tail)", async () => {
    const bad = { weightRequiredUnderYears: 18, bands: [{ key: "adult", upToAgeYears: 13, required: [], ranges: {} }] };
    expect(dangerRangesSchema.safeParse(bad).success).toBe(false);
    await db.insert(opdConfig).values({ id: "main", followUpExtensionDays: [15], dangerRanges: bad, letterhead: DEFAULT_LETTERHEAD, updatedBy: "t" });
    await expect(loadOpdConfig(db)).rejects.toMatchObject({ code: "opd_config_invalid" });
  });
});
```

Then `config.ts`:

```ts
import { eq } from "drizzle-orm";
import { z } from "zod";
import { opdConfig } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import type { Db, Tx } from "../../kernel/db/client";

export const VITAL_KEYS = ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC"] as const;
export type VitalKey = (typeof VITAL_KEYS)[number];
export const BAND_KEYS = ["infant", "child_1_5", "child_6_12", "adult"] as const;
export type BandKey = (typeof BAND_KEYS)[number];

const rangeSchema = z.object({ min: z.number().optional(), max: z.number().optional() });
const bandSchema = z.object({
  key: z.enum(BAND_KEYS),
  upToAgeYears: z.number().int().positive().nullable(), // EXCLUSIVE upper bound in whole years; null = the adult tail
  required: z.array(z.enum(VITAL_KEYS)),
  ranges: z.object({ sbp: rangeSchema, dbp: rangeSchema, pulse: rangeSchema, rr: rangeSchema, spo2: rangeSchema, tempC: rangeSchema }).partial(),
});
export const dangerRangesSchema = z
  .object({ weightRequiredUnderYears: z.number().int().nonnegative(), bands: z.array(bandSchema).min(1) })
  .refine((v) => v.bands[v.bands.length - 1]!.upToAgeYears === null, { message: "the last band must be the adult tail (upToAgeYears: null)" })
  .refine((v) => v.bands.slice(0, -1).every((b, i, arr) => b.upToAgeYears !== null && (i === 0 || arr[i - 1]!.upToAgeYears! < b.upToAgeYears)), {
    message: "bands must be ascending by upToAgeYears with only the last one open",
  });
export type DangerRangesConfig = z.infer<typeof dangerRangesSchema>;
export type BandConfig = z.infer<typeof bandSchema>;

export const letterheadSchema = z.object({ name: z.string().min(1), addressLines: z.array(z.string()) });
export type Letterhead = z.infer<typeof letterheadSchema>;

export type OpdConfig = {
  slotMinutes: number;
  followUpDefaultDays: number;
  followUpExtensionDays: number[];
  extensionCapPerDoctorPerMonth: number;
  maxSkipsBeforeLeft: number;
  perkEveryNth: number | null;
  dangerRanges: DangerRangesConfig;
  letterhead: Letterhead;
};

/** India-standard first values (owner decision 2026-08-15: clinical staff revise at UAT — data, not code). */
export const DEFAULT_DANGER_RANGES: DangerRangesConfig = {
  weightRequiredUnderYears: 18, // §11.8: pediatric dose ranges use the vitals-desk weight
  bands: [
    { key: "infant", upToAgeYears: 1, required: ["weightKg", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 65, max: 120 }, dbp: { min: 40, max: 80 }, pulse: { min: 90, max: 180 }, rr: { min: 25, max: 60 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 38.5 } } },
    { key: "child_1_5", upToAgeYears: 6, required: ["heightCm", "weightKg", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 75, max: 130 }, dbp: { min: 45, max: 85 }, pulse: { min: 70, max: 150 }, rr: { min: 20, max: 40 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 39.5 } } },
    { key: "child_6_12", upToAgeYears: 13, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 80, max: 140 }, dbp: { min: 50, max: 90 }, pulse: { min: 60, max: 130 }, rr: { min: 14, max: 30 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 39.5 } } },
    { key: "adult", upToAgeYears: null, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"],
      ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35.0, max: 39.5 } } },
  ],
};

/** Owner's sample letterhead (dev placeholder — hospital identity is owner-gated at go-live). */
export const DEFAULT_LETTERHEAD: Letterhead = {
  name: "CRK MEDICAL COLLEGE & HOSPITAL",
  addressLines: ["CHAURASIA CHOWK, HAJIPUR, BIHAR 844101"],
};

export const DEFAULT_FOLLOW_UP_EXTENSION_DAYS = [15, 21, 30]; // spec §11.1

/** Standard medical-college OPD list — dev placeholders, edited in the admin screen before go-live (owner decision). */
export const DEFAULT_DEPARTMENTS: { code: string; name: string }[] = [
  { code: "MED", name: "General Medicine" }, { code: "SUR", name: "General Surgery" }, { code: "PED", name: "Paediatrics" },
  { code: "OBG", name: "Obstetrics & Gynaecology" }, { code: "ORT", name: "Orthopaedics" }, { code: "ENT", name: "ENT" },
  { code: "OPH", name: "Ophthalmology" }, { code: "DER", name: "Dermatology" }, { code: "PSY", name: "Psychiatry" },
  { code: "CAR", name: "Cardiology" }, { code: "DEN", name: "Dental" }, { code: "PHY", name: "Physiotherapy" },
];

/** Role KEYS the opd_visit definition and its escalation ladder name (roles are Plan 02 data; the seed creates them, never assigns). */
export const OPD_ROLE_KEYS: { key: string; title: string }[] = [
  { key: "front_office", title: "Front Office (registration / OPD desk)" },
  { key: "front_office_supervisor", title: "Front-Office Supervisor" },
  { key: "vitals_desk", title: "Vitals-Desk Assistant" },
  { key: "nurse", title: "Nurse" },
  { key: "doctor", title: "Doctor (OPD consultant)" },
  { key: "opd_admin", title: "OPD Masters Administrator" },
  { key: "display", title: "Token Display Board" },
  { key: "duty_manager", title: "Duty Manager" },
  { key: "owner", title: "Owner" },
  { key: "medical_superintendent", title: "Medical Superintendent" },
];

const extensionDaysSchema = z.array(z.number().int().positive()).min(1);

export async function loadOpdConfig(db: Db | Tx): Promise<OpdConfig> {
  const rows = await db.select().from(opdConfig).where(eq(opdConfig.id, "main"));
  const row = rows[0];
  if (!row) throw new OpdError("opd_not_configured", "opd_config row 'main' is missing — run seed:opd");
  const ranges = dangerRangesSchema.safeParse(row.dangerRanges);
  if (!ranges.success) throw new OpdError("opd_config_invalid", "danger_ranges: " + ranges.error.issues.map((i) => i.message).join("; "));
  const letterhead = letterheadSchema.safeParse(row.letterhead);
  if (!letterhead.success) throw new OpdError("opd_config_invalid", "letterhead invalid");
  const ext = extensionDaysSchema.safeParse(row.followUpExtensionDays);
  if (!ext.success) throw new OpdError("opd_config_invalid", "follow_up_extension_days invalid");
  return {
    slotMinutes: row.slotMinutes,
    followUpDefaultDays: row.followUpDefaultDays,
    followUpExtensionDays: ext.data,
    extensionCapPerDoctorPerMonth: row.extensionCapPerDoctorPerMonth,
    maxSkipsBeforeLeft: row.maxSkipsBeforeLeft,
    perkEveryNth: row.perkEveryNth,
    dangerRanges: ranges.data,
    letterhead: letterhead.data,
  };
}
```

- [ ] **Step 3: The shared test helper** — `apps/core/test/helpers/opd.ts` (importable by every later suite; NOT a test file):

```ts
import { eq } from "drizzle-orm";
import { createUser } from "../../src/kernel/auth/identity";
import { createSession } from "../../src/kernel/auth/sessions";
import { assignRole } from "../../src/kernel/auth/permissions";
import { registrationConfig, roles, opdConfig, opdDepartments, opdDoctors, opdDoctorSchedules, opdRooms } from "../../src/kernel/db/schema";
import { withTx } from "../../src/kernel/db/client";
import { loadConfig } from "../../src/kernel/config";
import { newId } from "@hmis/contracts";
import { registerPatient } from "../../src/modules/patients";
import { DEFAULT_DANGER_RANGES, DEFAULT_FOLLOW_UP_EXTENSION_DAYS, DEFAULT_LETTERHEAD } from "../../src/modules/opd/config";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../src/kernel/db/client";
import type { RegisterPatientInput } from "../../src/modules/patients";

export const testCfg = loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! });

/** opd_config 'main' with the shipped defaults (+ registration_config so registerPatient works). */
export async function seedOpdBase(db: Db, over: { perkEveryNth?: number | null; slotMinutes?: number; extensionCap?: number; maxSkips?: number } = {}): Promise<void> {
  await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
  await db.insert(opdConfig).values({
    id: "main",
    slotMinutes: over.slotMinutes ?? 10,
    followUpExtensionDays: DEFAULT_FOLLOW_UP_EXTENSION_DAYS,
    extensionCapPerDoctorPerMonth: over.extensionCap ?? 30,
    maxSkipsBeforeLeft: over.maxSkips ?? 3,
    perkEveryNth: over.perkEveryNth ?? null,
    dangerRanges: DEFAULT_DANGER_RANGES,
    letterhead: DEFAULT_LETTERHEAD,
    updatedBy: "t",
  });
}

export async function ensureRole(db: Db, key: string): Promise<void> {
  await db.insert(roles).values({ key, title: key }).onConflictDoNothing();
}

/** A user holding the given role keys at hospital scope, with a live session token. */
export async function mkUser(db: Db, username: string, roleKeys: string[]): Promise<{ id: string; token: string; actor: Actor }> {
  const { id } = await createUser(db, { username, fullName: username, password: "p1234567" });
  for (const key of roleKeys) {
    await ensureRole(db, key);
    await assignRole(db, { userId: id, roleKey: key, scopeType: "hospital" });
  }
  const { token } = await createSession(db, testCfg, id);
  return { id, token, actor: { type: "user", id } };
}

export async function seedOpdMasters(db: Db): Promise<{ deptId: string; dept2Id: string; roomId: string; room2Id: string }> {
  const deptId = newId(); const dept2Id = newId(); const roomId = newId(); const room2Id = newId();
  await db.insert(opdDepartments).values([
    { id: deptId, code: "MED", name: "General Medicine", createdBy: "t", updatedBy: "t" },
    { id: dept2Id, code: "PED", name: "Paediatrics", createdBy: "t", updatedBy: "t" },
  ]);
  await db.insert(opdRooms).values([
    { id: roomId, code: "12", name: "Room 12", createdBy: "t", updatedBy: "t" },
    { id: room2Id, code: "14", name: "Room 14", createdBy: "t", updatedBy: "t" },
  ]);
  return { deptId, dept2Id, roomId, room2Id };
}

/** A doctor user + profile (+ optional weekly template). Defaults: Mon–Sat 09:00–13:00 in the given room. */
export async function mkDoctor(
  db: Db,
  input: { username: string; departmentId: string; roomId: string; weekdays?: number[]; start?: string; end?: string; displayName?: string },
): Promise<{ doctorId: string; userId: string; actor: Actor; token: string }> {
  const u = await mkUser(db, input.username, ["doctor"]);
  const doctorId = newId();
  await db.insert(opdDoctors).values({
    id: doctorId, userId: u.id, displayName: input.displayName ?? `Dr ${input.username}`, registrationNo: "BMC/12345",
    departmentId: input.departmentId, createdBy: "t", updatedBy: "t",
  });
  const weekdays = input.weekdays ?? [1, 2, 3, 4, 5, 6];
  if (weekdays.length > 0) {
    await db.insert(opdDoctorSchedules).values(weekdays.map((weekday) => ({
      id: newId(), doctorId, weekday, startTime: input.start ?? "09:00", endTime: input.end ?? "13:00", roomId: input.roomId,
      validFrom: "2026-01-01", createdBy: "t",
    })));
  }
  return { doctorId, userId: u.id, actor: u.actor, token: u.token };
}

export async function mkPatient(db: Db, actor: Actor, over: Partial<RegisterPatientInput> = {}): Promise<{ id: string; uhid: string }> {
  const { patient } = await withTx(db, (tx) =>
    registerPatient(tx, actor, { name: "Asha Devi", sex: "female", phone: "9876543210", ageYears: 30, ...over }),
  );
  return { id: patient.id, uhid: patient.uhid };
}

export async function doctorRow(db: Db, doctorId: string) {
  const rows = await db.select().from(opdDoctors).where(eq(opdDoctors.id, doctorId));
  return rows[0]!;
}
```
(`activateOpdVisitDefinition` is appended by T4.) The `registerPatient` import comes from `modules/patients` (its index) — the helper is outside `src/modules/**`, so the isolation lint does not apply, and it must never import OPD internals it does not need.

- [ ] **Step 4: Masters (red-first)** — `masters.test.ts` (uses `setupTestDb`, `truncateAll`, `seedOpdBase`, `mkUser`): tests — (1) `createDepartment` inserts, `listDepartments` returns it, duplicate code → `duplicate_department_code` and the tx leaves ONE row; (2) rooms likewise (`duplicate_room_code`); (3) `createDoctor` by username resolves the user id, refuses an unknown username (`unknown_user`), refuses a second profile for the same user (`user_already_doctor`), refuses an inactive department (`department_inactive`); (4) `doctorForUser` finds the profile; `updateDoctor({ active: false })` then `getDoctor` shows inactive; (5) non-user actors refused (`user_actor_required`). Then `masters.ts` with EXACT signatures:

```ts
export type DepartmentRow = typeof opdDepartments.$inferSelect;
export type RoomRow = typeof opdRooms.$inferSelect;
export type DoctorRow = typeof opdDoctors.$inferSelect;
export async function createDepartment(tx: Tx, actor: Actor, input: { code: string; name: string }): Promise<{ departmentId: string }>
export async function updateDepartment(tx: Tx, actor: Actor, id: string, patch: { name?: string; active?: boolean }): Promise<void>
export async function listDepartments(db: Db, opts: { activeOnly?: boolean } = {}): Promise<DepartmentRow[]>   // ORDER BY name
export async function createRoom(tx: Tx, actor: Actor, input: { code: string; name: string; floor?: string }): Promise<{ roomId: string }>
export async function updateRoom(tx: Tx, actor: Actor, id: string, patch: { name?: string; floor?: string | null; active?: boolean }): Promise<void>
export async function listRooms(db: Db, opts: { activeOnly?: boolean } = {}): Promise<RoomRow[]>               // ORDER BY code
export async function createDoctor(tx: Tx, actor: Actor, input: { username: string; displayName: string; registrationNo?: string; departmentId: string; specialty?: string }): Promise<{ doctorId: string; userId: string }>
export async function updateDoctor(tx: Tx, actor: Actor, id: string, patch: { displayName?: string; registrationNo?: string | null; departmentId?: string; specialty?: string | null; active?: boolean }): Promise<void>
export async function listDoctors(db: Db, opts: { departmentId?: string; activeOnly?: boolean } = {}): Promise<DoctorRow[]>  // ORDER BY display_name
export async function getDoctor(db: Db, id: string): Promise<DoctorRow | null>
export async function doctorForUser(db: Db | Tx, userId: string): Promise<DoctorRow | null>
```
Rules: writes require `actor.type === "user"`; duplicates are detected with `.onConflictDoNothing().returning()` (0 rows ⇒ the duplicate code — never a caught 23505 inside a tx); `createDoctor` reads `users` (kernel schema) by `username` → `unknown_user`; department must exist and be active; `updateDoctor({ departmentId })` validates the target department the same way.

- [ ] **Step 5: Pure slots (red-first)** — `slots.test.ts` with the hand-derived cases:

```ts
import { slotsForDate } from "./slots";

const tpl = { id: "T1", weekday: 1, startTime: "09:00", endTime: "10:00", roomId: "R1", slotMinutes: null, validFrom: "2026-01-01", validTo: null, active: true };
const base = { date: "2026-08-17", templates: [tpl], leaves: [], bookedStarts: [] as number[], defaultSlotMinutes: 10, now: new Date("2026-08-17T00:00:00.000Z") };

describe("slotsForDate (pure)", () => {
  it("Mon 09:00–10:00 IST at 10 min = six slots from 03:30Z, ten minutes apart, in room R1", () => {
    const slots = slotsForDate(base);
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-08-17T03:30:00.000Z", "2026-08-17T03:40:00.000Z", "2026-08-17T03:50:00.000Z",
      "2026-08-17T04:00:00.000Z", "2026-08-17T04:10:00.000Z", "2026-08-17T04:20:00.000Z",
    ]);
    expect(slots.every((s) => s.end.getTime() - s.start.getTime() === 600_000 && s.roomId === "R1" && s.scheduleId === "T1")).toBe(true);
    expect(slots.every((s) => !s.booked && !s.past)).toBe(true);
  });
  it("a booked start is flagged; starts before now are past", () => {
    const slots = slotsForDate({ ...base, bookedStarts: [Date.parse("2026-08-17T03:40:00.000Z")], now: new Date("2026-08-17T03:45:00.000Z") });
    expect(slots.map((s) => s.booked)).toEqual([false, true, false, false, false, false]);
    expect(slots.map((s) => s.past)).toEqual([true, true, false, false, false, false]);
  });
  it("a scheduled leave covering the date empties the day; a cancelled one does not", () => {
    expect(slotsForDate({ ...base, leaves: [{ fromDate: "2026-08-15", toDate: "2026-08-17", status: "scheduled" }] })).toEqual([]);
    expect(slotsForDate({ ...base, leaves: [{ fromDate: "2026-08-15", toDate: "2026-08-17", status: "cancelled" }] })).toHaveLength(6);
    expect(slotsForDate({ ...base, leaves: [{ fromDate: "2026-08-18", toDate: "2026-08-19", status: "scheduled" }] })).toHaveLength(6);
  });
  it("weekday and validity windows gate the template", () => {
    expect(slotsForDate({ ...base, date: "2026-08-18" })).toEqual([]); // Tuesday
    expect(slotsForDate({ ...base, templates: [{ ...tpl, validTo: "2026-08-16" }] })).toEqual([]);
    expect(slotsForDate({ ...base, templates: [{ ...tpl, validFrom: "2026-08-18" }] })).toEqual([]);
    expect(slotsForDate({ ...base, templates: [{ ...tpl, active: false }] })).toEqual([]);
  });
  it("a template slot override wins over the default; a partial trailing slot is dropped", () => {
    // 09:00–09:35 at 15 min → 09:00, 09:15 (09:30+15 > 09:35 is dropped)
    const slots = slotsForDate({ ...base, templates: [{ ...tpl, endTime: "09:35", slotMinutes: 15 }] });
    expect(slots.map((s) => s.start.toISOString())).toEqual(["2026-08-17T03:30:00.000Z", "2026-08-17T03:45:00.000Z"]);
  });
  it("two templates on the same weekday merge sorted by start", () => {
    const evening = { ...tpl, id: "T2", startTime: "17:00", endTime: "17:20", roomId: "R2" };
    const slots = slotsForDate({ ...base, templates: [evening, tpl] });
    expect(slots).toHaveLength(8);
    expect(slots[6]!.roomId).toBe("R2");
    expect(slots[6]!.start.toISOString()).toBe("2026-08-17T11:30:00.000Z");
  });
});
```

`slots.ts` (pure — imports only `./time`):

```ts
import { istDateTimeToUtc, istWeekday } from "./time";

export type ScheduleTemplate = {
  id: string; weekday: number; startTime: string; endTime: string; roomId: string;
  slotMinutes: number | null; validFrom: string; validTo: string | null; active: boolean;
};
export type LeaveRange = { fromDate: string; toDate: string; status: string };
export type Slot = { start: Date; end: Date; roomId: string; scheduleId: string; booked: boolean; past: boolean };

/** Slots of one IST date: active templates for that weekday inside their validity, minus scheduled leaves. Pure. */
export function slotsForDate(input: {
  date: string; templates: ScheduleTemplate[]; leaves: LeaveRange[]; bookedStarts: number[]; defaultSlotMinutes: number; now: Date;
}): Slot[] {
  const { date } = input;
  if (input.leaves.some((l) => l.status === "scheduled" && l.fromDate <= date && date <= l.toDate)) return [];
  const weekday = istWeekday(date);
  const booked = new Set(input.bookedStarts);
  const out: Slot[] = [];
  for (const t of input.templates) {
    if (!t.active || t.weekday !== weekday) continue;
    if (t.validFrom > date || (t.validTo !== null && t.validTo < date)) continue;
    const step = (t.slotMinutes ?? input.defaultSlotMinutes) * 60_000;
    const endMs = istDateTimeToUtc(date, t.endTime).getTime();
    for (let s = istDateTimeToUtc(date, t.startTime).getTime(); s + step <= endMs; s += step) {
      out.push({ start: new Date(s), end: new Date(s + step), roomId: t.roomId, scheduleId: t.id, booked: booked.has(s), past: s < input.now.getTime() });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
```
Derivation of the sixth-slot expectation in the last test: 17:00 IST = 11:30Z (17:00 − 5:30) — the two evening slots are indices 6 and 7 after the six morning ones.

- [ ] **Step 6: Schedules (red-first)** — `schedules.test.ts`: (1) `replaceDoctorSchedules` inserts N active rows and deactivates the previous set (old rows remain with `active = false` — no delete path); (2) refuses overlapping templates on one weekday (`invalid_schedule`: Mon 09:00–11:00 + Mon 10:30–12:00), a bad time (`25:00`), start ≥ end, an unknown room (`unknown_room`), an inactive room, and non-user actors; (3) `availableSlots(db, doctorId, "2026-08-17", now)` on the helper's default Mon–Sat 09:00–13:00 template = **24** slots (240 min / 10), the first at `03:30Z`, all `booked: false`; after inserting a live `booked` appointment at 03:40Z directly, index 1 is `booked: true`; after inserting a `scheduled` leave row covering the date, `[]`. `schedules.ts` signatures:

```ts
export type ScheduleInput = { weekday: number; startTime: string; endTime: string; roomId: string; slotMinutes?: number | null; validFrom: string; validTo?: string | null };
export async function replaceDoctorSchedules(tx: Tx, actor: Actor, doctorId: string, items: ScheduleInput[]): Promise<{ scheduleIds: string[] }>
export async function listDoctorSchedules(db: Db, doctorId: string, opts: { activeOnly?: boolean } = {}): Promise<(typeof opdDoctorSchedules.$inferSelect)[]>
export function validateScheduleSet(items: ScheduleInput[]): void   // pure: HH:MM regex, start < end, weekday 0–6, validFrom ≤ validTo, no same-weekday overlap → throws OpdError("invalid_schedule", …)
export async function availableSlots(db: Db | Tx, doctorId: string, date: string, now: Date = new Date()): Promise<Slot[]>   // Db | Tx: T4 calls it inside the booking transaction
```
`availableSlots` loads: config (`slotMinutes`), the doctor's active templates, the doctor's `scheduled` leaves, live appointments (`status in ('booked','checked_in','needs_rebooking')`, `serviceDate = date`) → `slotsForDate`.

- [ ] **Step 7: Mutants (tripwire 21).** Build `slots.mutantA.ts` (leave check deleted) + `slots.mutantA.mutant.test.ts` replicating the leave test → expected DIED (6 slots where `[]` asserted); `slots.mutantB.ts` (`validTo` clause deleted) + spec replicating the validity test → expected DIED. Run each 3×, record, delete scratch.
- [ ] **Step 8: Run to pass.** Isolated: `config.test` 3, `masters.test` 5, `slots.test` 6, `schedules.test` 3 = **17**. Workspace **75 suites / 425 tests**. Detached `pnpm verify`.
- [ ] **Step 9: Commit** — `feat(core): OPD events catalog, config, masters, weekly schedules and pure slots; shared OPD test helper` → pull --rebase → push.

**Acceptance criteria:**
1. `events.ts` defines exactly the eighteen `defineEvent` calls listed (17 P1 names + `qr.signature_failed`), all `module: "opd"`; a grep for `defineEvent(` in the file returns 18.
2. `config.test` 3/3 (missing row → `opd_not_configured`; invalid ranges → `opd_config_invalid`); the defaults in `config.ts` are byte-for-byte the values in D4 and the owner's letterhead.
3. `slots.test` 6/6 with the hand-derived instants; Mutants A and B DIED with run counts; scratch deleted.
4. `masters.test` 5/5, `schedules.test` 3/3 (24 slots on the helper's default template; booked flag; leave empties).
5. `test/helpers/opd.ts` exports `testCfg, seedOpdBase, ensureRole, mkUser, seedOpdMasters, mkDoctor, mkPatient, doctorRow`; every red-first run quoted (§2.8 fallback applies).
6. Workspace 75 / 425; verify green; clean tree.

---

### Task 3: The encounter spine — `opd_visit` definition (data), sessions + tokens, visit type, open / abandon / re-enter / transfer / timeline, and the two patients-module read helpers  *(opus coder — the plan's identity + concurrency core)*

**Files:**
- Create: `apps/core/src/modules/opd/workflow-def.ts`, `apps/core/src/modules/opd/workflow-def.test.ts`
- Create: `apps/core/src/modules/opd/visit-type.ts`, `apps/core/src/modules/opd/visit-type.test.ts`
- Create: `apps/core/src/modules/opd/sessions.ts`
- Create: `apps/core/src/modules/opd/encounters.ts`, `apps/core/src/modules/opd/encounters.test.ts`
- Modify: `apps/core/src/modules/patients/registration.ts` (+ `getPatientSummaries`, `listMergedLoserIds`; `inArray` joins the drizzle import), `apps/core/src/modules/patients/registration.test.ts` (+3 tests in a new describe block), `apps/core/src/modules/patients/index.ts` (+3 export lines)
- Modify: `apps/core/test/helpers/opd.ts` (+ `activateOpdVisitDefinition`, + `OPD_DEF_USERS`)

**A type fact this task is built around (verify-by-execution flag ③):** drizzle's `Tx` (`PgTransaction`) is NOT assignable to `Db` (`NodePgDatabase`, which carries `$client`). Patients-module readers are typed `Db`, so every OPD service that needs them takes `db: Db`, does those reads BEFORE opening its transaction, and delegates the transactional core to an `…InTx(tx, …)` sibling. If the compiler accepts `Tx` where `Db` is declared, nothing here breaks — the split stays.

- [ ] **Step 1: The definition, validated by the engine (red-first)** — `workflow-def.test.ts`:

```ts
import { defineWorkflow } from "../../kernel/workflow/definition";
import { OPD_VISIT_DEFINITION_JSON, OPD_VISIT_DEF_KEY, OPD_VISIT_STATES, opdVisitDefinition } from "./workflow-def";
import { OPD_ROLE_KEYS } from "./config";

describe("opd_visit workflow definition (data)", () => {
  it("validates against Plan 03's defineWorkflow: 6 states, 8 transitions, Class A, initial registered", () => {
    const def = opdVisitDefinition();
    expect(def.key).toBe(OPD_VISIT_DEF_KEY);
    expect(def.changeClass).toBe("A");
    expect(def.initialState).toBe("registered");
    expect(def.states.map((s) => s.name)).toEqual([...OPD_VISIT_STATES]);
    expect(def.transitions).toHaveLength(8);
    expect(defineWorkflow(OPD_VISIT_DEFINITION_JSON)).toEqual(def); // the JSON constant IS what the runbook posts
  });
  it("the OPD wait is the active alert: waiting carries a 45-min SLA with a two-rung ladder; every other non-terminal is record_only", () => {
    const def = opdVisitDefinition();
    const waiting = def.states.find((s) => s.name === "waiting")!;
    expect(waiting.sla).toEqual({ minutes: 45, alerting: "active", escalation: [{ afterMinutes: 15, toRole: "front_office_supervisor" }, { afterMinutes: 30, toRole: "duty_manager" }] });
    for (const name of ["registered", "in_consultation", "awaiting_results"]) {
      expect(def.states.find((s) => s.name === name)!.sla!.alerting).toBe("record_only");
    }
    expect(def.states.filter((s) => s.terminal).map((s) => s.name)).toEqual(["completed", "abandoned"]);
  });
  it("every transition role is a seeded OPD role key", () => {
    const keys = new Set(OPD_ROLE_KEYS.map((r) => r.key));
    for (const t of opdVisitDefinition().transitions) for (const r of t.roles) expect(keys.has(r)).toBe(true);
  });
});
```

`workflow-def.ts`:

```ts
import { defineWorkflow } from "../../kernel/workflow/definition";
import type { WorkflowDefinition } from "../../kernel/workflow/definition";

export const OPD_VISIT_DEF_KEY = "opd_visit";
export const OPD_VISIT_STATES = ["registered", "waiting", "in_consultation", "awaiting_results", "completed", "abandoned"] as const;
export type OpdVisitState = (typeof OPD_VISIT_STATES)[number];

/**
 * The OPD encounter state machine as workflow-definition DATA (spec §10.1 P1 / §10.2). Class A (D-15): a patient-journey
 * flow — owner + medical superintendent two-key at activation. Go-live: POST /workflow/definitions with exactly this JSON
 * (GET /opd/definition serves it), two approvals, activation by a third user. Tests: test/helpers/opd.ts.
 * §10.3: every non-terminal state carries an SLA; the OPD wait is the go-live ACTIVE alert.
 */
export const OPD_VISIT_DEFINITION_JSON = {
  key: OPD_VISIT_DEF_KEY,
  title: "OPD visit",
  changeClass: "A",
  initialState: "registered",
  states: [
    { name: "registered", sla: { minutes: 20, alerting: "record_only" } },
    { name: "waiting", sla: { minutes: 45, alerting: "active", escalation: [{ afterMinutes: 15, toRole: "front_office_supervisor" }, { afterMinutes: 30, toRole: "duty_manager" }] } },
    { name: "in_consultation", sla: { minutes: 60, alerting: "record_only" } },
    { name: "awaiting_results", sla: { minutes: 240, alerting: "record_only" } },
    { name: "completed", terminal: true },
    { name: "abandoned", terminal: true },
  ],
  transitions: [
    { from: "registered", to: "waiting", roles: ["vitals_desk", "nurse", "doctor"] },
    { from: "waiting", to: "in_consultation", roles: ["doctor"] },
    { from: "in_consultation", to: "completed", roles: ["doctor"] },
    { from: "in_consultation", to: "awaiting_results", roles: ["doctor"] },
    { from: "awaiting_results", to: "waiting", roles: ["front_office", "vitals_desk", "nurse", "doctor"] },
    { from: "registered", to: "abandoned", roles: ["front_office", "front_office_supervisor"] },
    { from: "waiting", to: "abandoned", roles: ["front_office", "front_office_supervisor"] },
    { from: "awaiting_results", to: "abandoned", roles: ["front_office", "front_office_supervisor"] },
  ],
};

export function opdVisitDefinition(): WorkflowDefinition {
  return defineWorkflow(OPD_VISIT_DEFINITION_JSON);
}
```

- [ ] **Step 2: Visit type (pure, red-first)** — `visit-type.test.ts`:

```ts
import { classifyVisit } from "./visit-type";

const anchor = (iso: string, followUpDays = 7) => ({ consultCompletedAt: new Date(iso), followUpDays });

describe("classifyVisit (pure; IST calendar days, inclusive window)", () => {
  it("no completed consult in the department → new", () => {
    expect(classifyVisit(null, new Date("2026-08-15T05:00:00.000Z"))).toBe("new");
  });
  it("day 7 after an Aug-8 consult is a revisit; day 8 is a renewal (7-day default, inclusive)", () => {
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z"), new Date("2026-08-15T05:00:00.000Z"))).toBe("revisit"); // 7 days
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z"), new Date("2026-08-15T18:30:00.000Z"))).toBe("renewal"); // Aug 16 IST = 8 days
  });
  it("counts calendar days, not 168 hours: 23:59 IST → 00:00 IST seven nights later is still day 7", () => {
    expect(classifyVisit(anchor("2026-08-08T18:29:59.000Z"), new Date("2026-08-14T18:30:00.000Z"))).toBe("revisit"); // Aug 8 23:59:59 IST → Aug 15 00:00 IST
  });
  it("an extended window (30) reaches Sep 7 and not Sep 8", () => {
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z", 30), new Date("2026-09-07T05:00:00.000Z"))).toBe("revisit");
    expect(classifyVisit(anchor("2026-08-08T10:00:00.000Z", 30), new Date("2026-09-08T05:00:00.000Z"))).toBe("renewal");
  });
});
```

`visit-type.ts`:

```ts
import { istDayIndex } from "./time";

export type VisitType = "new" | "revisit" | "renewal";

/**
 * §11.1 auto-detect. anchor = the patient's most recent COMPLETED consultation in the SAME DEPARTMENT (owner decision
 * 2026-08-15) with the follow-up window that consult carries (default 7; doctor-set 15/21/30). Inclusive, in IST calendar days.
 */
export function classifyVisit(anchor: { consultCompletedAt: Date; followUpDays: number } | null, now: Date): VisitType {
  if (anchor === null) return "new";
  const days = istDayIndex(now) - istDayIndex(anchor.consultCompletedAt);
  return days <= anchor.followUpDays ? "revisit" : "renewal";
}
```

- [ ] **Step 3: The patients-module read helpers (red-first, in Plan 05's test file)** — append to `apps/core/src/modules/patients/registration.test.ts` a new top-level `describe("Plan 07 read helpers: summaries + merged losers", …)` reusing the file's `db`/`clerk`/`baseInput` setup shape (its own `beforeAll`/`beforeEach` block copied, since describe blocks do not share hooks across the file's existing describe):

```ts
  it("getPatientSummaries: a confidential row returns alias + restricted for a clerk without the permission, the name with it; uhid/sex/dob always", async () => {
    const { patient: plain } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput }));
    const { patient: vip } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, name: "VIP Person", phone: "9876500001", isConfidential: true, alias: "Patient A", ageYears: 40 }));
    const before = await getPatientSummaries(db, clerk, [vip.id, plain.id]);
    expect(before.find((s) => s.id === vip.id)).toEqual({ requestedId: vip.id, id: vip.id, uhid: vip.uhid, name: null, alias: "Patient A", restricted: true, sex: "female", dob: vip.dob });
    expect(before.find((s) => s.id === plain.id)).toMatchObject({ name: "Asha Devi", alias: null, restricted: false });
    // grant the permission → the name appears (patientsManifest + registry are already imported by this file)
    const registry = new ModuleRegistry(); registry.install(patientsManifest);
    await syncPermissions(db, registry);
    await createRole(db, "vip_reader", "VIP reader");
    await grantPermissionToRole(db, registry, "vip_reader", "patients.confidential.read");
    const { id: readerId } = await createUser(db, { username: "reader", fullName: "reader", password: "p1234567" });
    await assignRole(db, { userId: readerId, roleKey: "vip_reader", scopeType: "hospital" });
    const after = await getPatientSummaries(db, { type: "user", id: readerId }, [vip.id]);
    expect(after[0]).toMatchObject({ name: "VIP Person", alias: null, restricted: false });
    // system actors always see; agents never do
    expect((await getPatientSummaries(db, { type: "system", id: "s" }, [vip.id]))[0]!.restricted).toBe(false);
    expect((await getPatientSummaries(db, { type: "agent", id: "a" }, [vip.id]))[0]!.restricted).toBe(true);
  });

  it("getPatientSummaries resolves a merged loser id to the winner (requestedId kept); listMergedLoserIds walks a two-hop chain", async () => {
    const { patient: w } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, phone: "9876500002" }));
    const { patient: l1 } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, phone: "9876500003" }));
    const { patient: l0 } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput, phone: "9876500004" }));
    // The storage shape a merge produces (merge.ts executeMerge) — written directly: this is a read-helper test.
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: w.id }).where(eq(patients.id, l1.id));
    await db.update(patients).set({ status: "merged", mergedIntoPatientId: l1.id }).where(eq(patients.id, l0.id));
    const s = await getPatientSummaries(db, clerk, [l0.id]);
    expect(s).toEqual([expect.objectContaining({ requestedId: l0.id, id: w.id, uhid: w.uhid })]);
    expect((await listMergedLoserIds(db, w.id)).sort()).toEqual([l0.id, l1.id].sort());
    expect(await listMergedLoserIds(db, l0.id)).toEqual([]);
  });

  it("getPatientSummaries dedupes ids and skips unknown ones", async () => {
    const { patient } = await withTx(db, (tx) => registerPatient(tx, clerk, { ...baseInput }));
    const s = await getPatientSummaries(db, clerk, [patient.id, patient.id, "01NOSUCH00000000000000000"]);
    expect(s).toHaveLength(1);
  });
```
(Add `getPatientSummaries, listMergedLoserIds` to the file's `./registration` import and `patients` to its schema import; the file already imports `createUser`, `assignRole`, `createRole`, `grantPermissionToRole`, `syncPermissions`, `ModuleRegistry`, `patientsManifest` — scout P §13 lines 5-8.) Red = TS2305 on the two missing exports (a compile red on a file that is otherwise green — the §3.23 shape: report it as "red at missing export", not as semantic evidence; the semantic evidence is the green run after Step 3b).

Step 3b — append to `apps/core/src/modules/patients/registration.ts` (change line 1 to `import { and, eq, inArray } from "drizzle-orm";`):

```ts
/**
 * Plan 07 bulk display summaries for queue/desk surfaces. Each requested id is resolved through the merge chain
 * (requestedId is echoed so callers can re-key). Confidential rows return alias + restricted:true — never the name —
 * unless the caller may see them (the verifyQrScan precedent); uhid/sex/dob are returned regardless because the staff
 * physically serving the patient need them (§14 privacy surface; D-37: nothing prioritises on any of this).
 */
export type PatientSummary = {
  requestedId: string; id: string; uhid: string; name: string | null; alias: string | null; restricted: boolean; sex: string; dob: Date | null;
};

export async function getPatientSummaries(db: Db, actor: Actor, patientIds: string[]): Promise<PatientSummary[]> {
  const unique = [...new Set(patientIds)];
  if (unique.length === 0) return [];
  // ONE query for the common case; only rows that are themselves merged losers walk the chain (rare).
  const rows = await db.select().from(patients).where(inArray(patients.id, unique));
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const out: PatientSummary[] = [];
  let canSee: boolean | null = null; // resolved at most once per call
  for (const requestedId of unique) {
    let row = byId.get(requestedId);
    if (row !== undefined && row.status === "merged") row = (await followMergeChain(db, requestedId))?.row;
    if (row === undefined) continue;
    let restricted = false;
    if (row.isConfidential && actor.type !== "system") {
      if (canSee === null) {
        canSee = actor.type === "user" ? await hasPermission(db, actor.id, "patients.confidential.read", "hospital") : false;
      }
      restricted = !canSee;
    }
    out.push({
      requestedId, id: row.id, uhid: row.uhid,
      name: restricted ? null : row.name, alias: restricted ? row.alias : null, restricted, sex: row.sex, dob: row.dob,
    });
  }
  return out;
}

/**
 * Every patient id whose merge chain ends at winnerId, excluding the winner (depth-capped at 5 hops like followMergeChain).
 * Consumers that keep their own patient_id (Plan 07 encounters) assemble a merged patient's full history with it —
 * merge never rewrites other modules' rows (§6).
 */
export async function listMergedLoserIds(db: Db, winnerId: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [winnerId];
  for (let hop = 0; hop < 5 && frontier.length > 0; hop++) {
    const rows = await db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.status, "merged"), inArray(patients.mergedIntoPatientId, frontier)));
    frontier = rows.map((r) => r.id).filter((id) => !found.includes(id));
    found.push(...frontier);
  }
  return found;
}
```
And in `modules/patients/index.ts` add, after the existing registration export lines:
```ts
export { getPatientSummaries, listMergedLoserIds } from "./registration"; // Plan 07 read helpers
export type { PatientSummary } from "./registration";
```

- [ ] **Step 4: Sessions** — `sessions.ts` (no test file of its own; encounters.test exercises every function):

```ts
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { opdDoctorSchedules, opdQueueSessions } from "../../kernel/db/schema";
import { OpdError } from "./errors";
import { istWeekday } from "./time";
import type { Tx } from "../../kernel/db/client";

export type SessionRow = typeof opdQueueSessions.$inferSelect;
export type SessionStatus = "not_started" | "in" | "out" | "closed";

/** The room of the doctor's first active template for that IST date (null when unscheduled — walk-ins are still allowed). */
export async function roomForDoctorDay(tx: Tx, doctorId: string, serviceDate: string): Promise<string | null> {
  const weekday = istWeekday(serviceDate);
  const rows = await tx
    .select({ roomId: opdDoctorSchedules.roomId, startTime: opdDoctorSchedules.startTime })
    .from(opdDoctorSchedules)
    .where(and(
      eq(opdDoctorSchedules.doctorId, doctorId), eq(opdDoctorSchedules.active, true), eq(opdDoctorSchedules.weekday, weekday),
      lte(opdDoctorSchedules.validFrom, serviceDate),
      or(isNull(opdDoctorSchedules.validTo), sql`${opdDoctorSchedules.validTo} >= ${serviceDate}`),
    ));
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => (a.startTime < b.startTime ? -1 : 1))[0]!.roomId;
}

/** Lazily creates the doctor-day row; the (doctor_id, service_date) unique index makes concurrent creators converge on one row. */
export async function getOrCreateSession(tx: Tx, doctorId: string, serviceDate: string, roomId: string | null): Promise<SessionRow> {
  await tx.insert(opdQueueSessions).values({ id: newId(), doctorId, serviceDate, roomId }).onConflictDoNothing();
  const rows = await tx.select().from(opdQueueSessions).where(and(eq(opdQueueSessions.doctorId, doctorId), eq(opdQueueSessions.serviceDate, serviceDate)));
  return rows[0]!;
}

/** Atomic counter — never read-then-write. Gaps are fine (a rolled-back visit skips a number); order is what matters. */
export async function allocateToken(tx: Tx, sessionId: string): Promise<number> {
  const rows = await tx
    .update(opdQueueSessions)
    .set({ nextToken: sql`${opdQueueSessions.nextToken} + 1` })
    .where(eq(opdQueueSessions.id, sessionId))
    .returning({ next: opdQueueSessions.nextToken });
  if (rows.length === 0) throw new OpdError("unknown_session");
  return rows[0]!.next - 1;
}

export async function setSessionStatus(tx: Tx, actor: Actor, sessionId: string, status: Exclude<SessionStatus, "not_started">, now: Date = new Date()): Promise<SessionRow> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const rows = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId));
  const s = rows[0];
  if (!s) throw new OpdError("unknown_session");
  if (s.status === "closed") throw new OpdError("session_closed");
  const updated = await tx
    .update(opdQueueSessions)
    .set({ status, openedAt: s.openedAt ?? (status === "in" ? now : null), closedAt: status === "closed" ? now : null })
    .where(and(eq(opdQueueSessions.id, sessionId), eq(opdQueueSessions.status, s.status)))
    .returning();
  if (updated.length === 0) throw new OpdError("session_closed", "session moved concurrently");
  return updated[0]!;
}
```

- [ ] **Step 5: Encounters (red-first)** — write `encounters.test.ts` FIRST. Setup per test: `truncateAll` → `seedOpdBase` → `activateOpdVisitDefinition` → `seedOpdMasters` → `mkDoctor("dra", deptId, roomId)`, `mkDoctor("drb", deptId, room2Id)`, `mkDoctor("drp", dept2Id, room2Id)` → users `clerk` [`front_office`], `sup` [`front_office_supervisor`], `vd` [`vitals_desk`] → `mkPatient`. Pin `MON = new Date("2026-08-17T04:00:00.000Z")` (Monday 09:30 IST). Ten tests, hand-derived:

  1. **walk-in open** — `openVisit(db, clerk.actor, { patientId, departmentId: deptId, doctorId: dra.doctorId }, MON)` → `visitType "new"`, `tokenNo 1`, `roomId === roomId`, `doctorScheduledToday true`; the encounter row: `status "registered"`, `serviceDate "2026-08-17"`, `intendedPayer "self"`, `openedBy clerk.id`; the workflow instance (`workflowInstances` by `encounter.workflowInstanceId`): `defKey "opd_visit"`, `currentState "registered"`, `subjectType "opd_encounter"`, `subjectId === encounter.id`, `encounterId === encounter.id`, `patientId`; the queue entry: `status "waiting_vitals"`, `kind "walk_in"`, `tokenNo 1`, `appointmentAt null`, `eligibleAt null`; events: exactly one `visit.opened` and one `patient.checked_in`, both with `encounterId` column = encounter.id, `patientId` column, `correlationId` = instance id; `visit.opened` payload `toEqual({ encounterId, patientId, departmentId: deptId, doctorId, serviceDate: "2026-08-17", sessionId, roomId, tokenNo: 1, visitType: "new", intendedPayer: "self", kind: "walk_in", appointmentId: null })`; `patient.checked_in` payload `toEqual({ encounterId, patientId, doctorId, serviceDate: "2026-08-17", sessionId, roomId, tokenNo: 1, kind: "arrival" })`.
  2. **tokens climb per doctor-day; an unscheduled day has no room** — a second open for the same doctor at `MON + 5 min` → `tokenNo 2`, same `sessionId`; a Sunday open (`2026-08-16T04:00Z`) → `roomId null`, `doctorScheduledToday false`, `tokenNo 1` (a new session); a different doctor on MON → `tokenNo 1`.
  3. **visit type across the department** — drive one encounter to completion with `moveEncounter` (vd: `registered→waiting`; dra: `waiting→in_consultation`; dra: `in_consultation→completed` with patch `{ consultCompletedAt: T0, followUpDays: 7 }` where `T0 = new Date("2026-08-08T10:00:00.000Z")`, passing `now = T0`); then: open with **drb** (same department) at `2026-08-15T05:00Z` → `"revisit"`; open with **drp** (other department) at the same instant → `"new"`; open with dra at `2026-08-15T18:30Z` → `"renewal"`; a second completed encounter with `followUpDays: 30` at `T0` and an open at `2026-09-07T05:00Z` → `"revisit"`. **Merged loser history counts:** register `loser`, complete an encounter under `loser` at `T0`, then set `loser` merged into `patientId` (direct UPDATE of the two patient columns — the storage shape), open under `patientId` at `2026-08-15T05:00Z` → `"revisit"`.
  4. **six concurrent opens, one doctor-day** — `Promise.all` of 6 `openVisit` for 6 patients → the six `tokenNo`s sorted are `[1,2,3,4,5,6]`; exactly ONE `opd_queue_sessions` row for (dra, 2026-08-17); six queue entries; `nextToken === 7`.
  5. **abandon** — from `registered` by clerk with reason `"left after billing"` → encounter `status "abandoned"`, `abandonReason`, `abandonedAt` set; the queue entry `status "cancelled"`; the instance `status "completed"`, `currentState "abandoned"`; exactly one `visit.abandoned` event with payload `toMatchObject({ encounterId, fromState: "registered", reason: "left after billing", tokenNo: 1 })`; `abandonVisit(db, clerk.actor, id, "  ")` → `reason_required`; abandoning it AGAIN → `encounter_state_conflict`.
  6. **abandon race** — a fresh encounter; `Promise.allSettled([abandonVisit(...), abandonVisit(...)])` with the same reason → exactly one fulfilled; the rejected one `code === "encounter_state_conflict"` (the ONLY code — trace in the preamble below); exactly one `visit.abandoned` event; encounter `abandoned`; run this test's body 5× in a loop inside the `it` (each iteration on a fresh encounter) so the interleaving is exercised.
  7. **role_denied propagates untouched** — `moveEncounter(tx, clerk.actor, enc, "waiting")` (clerk holds only `front_office`, not in `registered→waiting`'s roles) rejects with a `WorkflowError` whose `code === "role_denied"`; the encounter stays `registered` (the mirror never ran).
  8. **re-enter keeps the token** — drive to `awaiting_results` (vd → waiting; dra → in_consultation; dra → awaiting_results); `reEnterVisit(db, clerk.actor, id, MON2)` where `MON2 = MON + 3h` → encounter `waiting`; a NEW queue entry `{ status: "waiting", reEntry: true, tokenNo: 1, eligibleAt: MON2, kind: "walk_in" }` with a higher `seq` than the first; the FIRST entry is `done`; exactly one `patient.checked_in` with `kind "re_entry"` (two in total in the table); re-entering on a different IST day (`now = "2026-08-18T04:00Z"`) → `encounter_state_conflict`; re-entering a `waiting` encounter → `encounter_state_conflict`.
  9. **transfer (E2)** — two encounters under dra moved to `waiting` (vd) with `eligibleAt` set by moveEncounter's caller? — NO: in T3 `eligibleAt` is written by `reEnterVisit` and (T6) `recordVitals`; for this test shape both entries by a direct UPDATE (`status='waiting'`, `eligible_at` = `MON+1min` / `MON+2min` — the module's own table, disclosed) then `transferQueue(db, sup.actor, { fromDoctorId: dra.doctorId, toDoctorId: drb.doctorId, serviceDate: "2026-08-17", consented: true, reason: "Dr A called away" }, MON3)` → `{ transferred: 2, toSessionId }`; drb's session has 2 entries with tokens `[1, 2]` and the ORIGINAL `eligibleAt` values (order preserved), the old entries `status "transferred"`, both encounters `doctorId === drb.doctorId`, exactly two `visit.transferred` events with `consented true` and `toDoctorId drb`; `consented: false` → `invalid_transfer`; `toDoctorId: drp.doctorId` (other department) → `invalid_transfer`; a doctor with no live entries → `{ transferred: 0 }`.
  10. **timeline spans the merge chain** — encounters under `patientId` and under a merged loser (set up as in test 3) → `patientTimeline(db, clerk.actor, patientId)` returns both, newest `openedAt` first, each item carrying `doctorName` (`"Dr dra"`), `departmentName`, `status`, `visitType`, `serviceDate`; a request under the LOSER id returns the same list (resolution).

  **The abandon-race trace (ledger §3.13/§3.21 — the lock named and shown to match).** Both callers read the encounter row (`waiting`, unlocked), then call `transition`, which reads the instance (unlocked) and issues `UPDATE workflow_instances … WHERE id = ? AND status = 'active' AND current_state = 'waiting'` — the target row lock. Loser interleavings: (a) B's UPDATE queues behind A's row lock; after A commits, B's WHERE re-evaluates on the new version (`current_state = 'abandoned'`, `status = 'completed'`) → 0 rows → `stale_transition`; (b) B reads the instance after A committed → `status = 'completed'` → `instance_not_active`; (c) B reads the encounter row after A committed → `status = 'abandoned'` → the OPD pre-check refuses. `moveEncounter` maps (a) and (b) to `encounter_state_conflict`; (c) IS `encounter_state_conflict`. `unknown_transition` (a competing move to a non-terminal state) cannot occur in this test (both moves target `abandoned`) but is mapped identically for the general case. **One code.**

  Then implement `encounters.ts`. Exact signatures + the two load-bearing bodies:

```ts
export type EncounterRow = typeof opdEncounters.$inferSelect;
export type QueueEntryRow = typeof opdQueueEntries.$inferSelect;
export type OpenVisitInput = {
  patientId: string; departmentId: string; doctorId: string;
  intendedPayer?: "self" | "tpa" | "pmjay" | "corporate";
  referralSource?: "self" | "internal_doctor" | "external_rmp" | "camp" | "other";
  referrerName?: string;
  appointment?: { id: string; slotStart: Date }; // set only by appointments.checkIn (T4)
};
export type OpenVisitResult = {
  encounter: EncounterRow; queueEntry: QueueEntryRow; tokenNo: number; sessionId: string; roomId: string | null;
  visitType: VisitType; doctorScheduledToday: boolean;
};

/** Db-first: resolves the patient and its merge chain through the patients module, then runs openVisitInTx on its own transaction. */
export async function openVisit(db: Db, actor: Actor, input: OpenVisitInput, now: Date = new Date()): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  const canonical = await resolvePatientId(db, input.patientId);
  if (!canonical) throw new OpdError("patient_not_found", `unknown patient ${input.patientId}`);
  const chainIds = [canonical, ...(await listMergedLoserIds(db, canonical))];
  return withTx(db, (tx) => openVisitInTx(tx, actor, { ...input, patientId: canonical, chainIds }, now));
}

/** Tx-first core (also called by appointments.checkIn inside ITS transaction). patientId MUST already be canonical. */
export async function openVisitInTx(tx: Tx, actor: Actor, input: OpenVisitInput & { chainIds: string[] }, now: Date): Promise<OpenVisitResult> {
  if (actor.type !== "user") throw new OpdError("user_actor_required");
  await loadOpdConfig(tx); // opd_not_configured before any write
  const doctor = (await tx.select().from(opdDoctors).where(eq(opdDoctors.id, input.doctorId)))[0];
  if (!doctor) throw new OpdError("unknown_doctor");
  if (!doctor.active) throw new OpdError("doctor_inactive");
  const dept = (await tx.select().from(opdDepartments).where(eq(opdDepartments.id, input.departmentId)))[0];
  if (!dept) throw new OpdError("unknown_department");
  if (!dept.active) throw new OpdError("department_inactive");
  if (doctor.departmentId !== dept.id) throw new OpdError("doctor_department_mismatch");

  const serviceDate = istDate(now);
  const anchorRows = await tx
    .select({ consultCompletedAt: opdEncounters.consultCompletedAt, followUpDays: opdEncounters.followUpDays })
    .from(opdEncounters)
    .where(and(inArray(opdEncounters.patientId, input.chainIds), eq(opdEncounters.departmentId, dept.id), eq(opdEncounters.status, "completed")))
    .orderBy(desc(opdEncounters.consultCompletedAt))
    .limit(1);
  const a = anchorRows[0];
  const visitType = classifyVisit(a && a.consultCompletedAt ? { consultCompletedAt: a.consultCompletedAt, followUpDays: a.followUpDays ?? 7 } : null, now);

  const encounterId = newId();
  const { instanceId } = await startInstance(tx, OPD_VISIT_DEF_KEY, { type: "opd_encounter", id: encounterId, patientId: input.patientId, encounterId });
  const roomId = await roomForDoctorDay(tx, doctor.id, serviceDate);
  const session = await getOrCreateSession(tx, doctor.id, serviceDate, roomId);
  const tokenNo = await allocateToken(tx, session.id);

  const [encounter] = await tx.insert(opdEncounters).values({
    id: encounterId, patientId: input.patientId, workflowInstanceId: instanceId, departmentId: dept.id, doctorId: doctor.id,
    appointmentId: input.appointment?.id ?? null, serviceDate, visitType,
    intendedPayer: input.intendedPayer ?? "self", referralSource: input.referralSource ?? null, referrerName: input.referrerName ?? null,
    openedBy: actor.id, openedAt: now, updatedBy: actor.id, updatedAt: now,
  }).returning();
  const [queueEntry] = await tx.insert(opdQueueEntries).values({
    id: newId(), sessionId: session.id, encounterId, tokenNo,
    kind: input.appointment ? "appointment" : "walk_in", appointmentAt: input.appointment?.slotStart ?? null, status: "waiting_vitals",
  }).returning();

  const where = { doctorId: doctor.id, serviceDate, sessionId: session.id, roomId: session.roomId, tokenNo };
  const env = { actor, patientId: input.patientId, encounterId, correlationId: instanceId };
  await appendEvent(tx, visitOpened.make({ ...env, payload: {
    encounterId, patientId: input.patientId, departmentId: dept.id, ...where, visitType, intendedPayer: input.intendedPayer ?? "self",
    kind: input.appointment ? "appointment" : "walk_in", appointmentId: input.appointment?.id ?? null,
  } }));
  await appendEvent(tx, patientCheckedIn.make({ ...env, payload: { encounterId, patientId: input.patientId, ...where, kind: "arrival" } }));
  return { encounter: encounter!, queueEntry: queueEntry!, tokenNo, sessionId: session.id, roomId: session.roomId, visitType, doctorScheduledToday: roomId !== null };
}

/** THE only writer of opd_encounters.status: engine transition first (single-winner), then the mirror. */
export async function moveEncounter(
  tx: Tx, actor: Actor, encounter: EncounterRow, to: OpdVisitState,
  patch: Partial<Pick<EncounterRow, "consultStartedAt" | "consultCompletedAt" | "abandonedAt" | "abandonReason" | "followUpDays" | "followUpExtended"
    | "chiefComplaint" | "diagnosis" | "icd10Code" | "advice" | "admissionAdvised" | "referralTo" | "referralNote">> = {},
  now: Date = new Date(),
): Promise<EncounterRow> {
  try {
    await transition(tx, encounter.workflowInstanceId, to, actor);
  } catch (e) {
    if (e instanceof WorkflowError && (e.code === "stale_transition" || e.code === "instance_not_active" || e.code === "unknown_transition")) {
      throw new OpdError("encounter_state_conflict", `${encounter.status}→${to}: ${e.code}`);
    }
    throw e; // role_denied, unknown_instance, no_active_definition stay WorkflowErrors (403 / 409 at the edge)
  }
  const rows = await tx
    .update(opdEncounters)
    .set({ status: to, updatedBy: actor.id, updatedAt: now, ...patch })
    .where(and(eq(opdEncounters.id, encounter.id), eq(opdEncounters.status, encounter.status)))
    .returning();
  if (rows.length === 0) throw new OpdError("encounter_state_conflict", "mirror desync"); // unreachable while the invariant holds — a loud belt
  return rows[0]!;
}

export async function getEncounter(db: Db | Tx, id: string): Promise<EncounterRow | null>
export async function abandonVisit(db: Db, actor: Actor, encounterId: string, reason: string, now?: Date): Promise<{ encounter: EncounterRow }>
export async function reEnterVisit(db: Db, actor: Actor, encounterId: string, now?: Date): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }>
export async function transferQueue(db: Db, actor: Actor, input: { fromDoctorId: string; toDoctorId: string; serviceDate: string; entryIds?: string[]; consented: boolean; reason: string }, now?: Date): Promise<{ transferred: number; toSessionId: string }>
export async function getVisit(db: Db, encounterId: string): Promise<{ encounter: EncounterRow; queueEntries: QueueEntryRow[]; vitals: VitalsRow[]; prescriptions: PrescriptionRow[] } | null>   // entries by seq asc; vitals by recorded_at asc; prescriptions by version asc
export async function listVisits(db: Db, filter: { status?: OpdVisitState; departmentId?: string; doctorId?: string; serviceDate?: string }, limit = 200): Promise<EncounterRow[]>  // opened_at asc
export type TimelineItem = { encounterId: string; serviceDate: string; openedAt: Date; status: string; visitType: string; doctorId: string | null; doctorName: string | null; departmentId: string | null; departmentName: string | null; diagnosis: string | null; icd10Code: string | null; prescriptionLineCount: number; dangerFlagged: boolean };
export async function patientTimeline(db: Db, actor: Actor, patientId: string, limit = 50): Promise<TimelineItem[]>  // resolves the canonical id, includes listMergedLoserIds; opened_at desc
```
Rules for the rest: `abandonVisit` — `reason.trim() === ""` ⇒ `reason_required` before any read; status ∉ {registered, waiting, awaiting_results} ⇒ `encounter_state_conflict`; in one tx: `moveEncounter(→ abandoned, { abandonedAt: now, abandonReason })`, then `UPDATE opd_queue_entries SET status='cancelled' WHERE encounter_id=? AND status IN ('waiting_vitals','waiting','called') RETURNING`, then `visit.abandoned` built from the encounter's most recent entry (`ORDER BY seq DESC LIMIT 1` — seq, never id) with `fromState = encounter.status`. `reEnterVisit` — status must be `awaiting_results` and `istDate(now) === encounter.serviceDate` (else `encounter_state_conflict`); in one tx: `moveEncounter(→ waiting)`, mark any live previous entry `done` (conditional), insert the new entry (same session, same `tokenNo`, `kind` copied, `appointmentAt null`, `status waiting`, `reEntry true`, `danger = encounter.dangerFlagged`, `eligibleAt now`), append `patient.checked_in` `kind "re_entry"`. `transferQueue` — supervisor-level (HTTP permission `opd.queue.transfer`); `consented !== true` or `reason` blank ⇒ `invalid_transfer`; both doctors active and in the SAME department else `invalid_transfer`; from-session must exist (else `{ transferred: 0 }`); target session via `roomForDoctorDay` + `getOrCreateSession`; per live entry (`waiting_vitals|waiting|called`, optionally filtered by `entryIds`): conditional UPDATE old → `transferred` (0 rows ⇒ skip — moved concurrently), `allocateToken` in the target, insert the new entry (`called` becomes `waiting`; `eligibleAt`, `danger`, `reEntry`, `kind`, `appointmentAt` copied), `UPDATE opd_encounters SET doctor_id = to WHERE id = ? AND doctor_id = from`, append `visit.transferred`. Every event carries `patientId`, `encounterId`, `correlationId = workflowInstanceId`.

- [ ] **Step 6: The helper's definition activator** — append to `test/helpers/opd.ts`:

```ts
import { createDraft, approveDefinition, activateDefinition } from "../../src/kernel/workflow/definitions";
import { seedSodPairs } from "../../src/kernel/auth/sod";
import { sodPairs } from "../../src/kernel/db/schema";
import { OPD_VISIT_DEFINITION_JSON } from "../../src/modules/opd/workflow-def";

/** Class A activation exactly as the go-live runbook does it: drafter, owner + MS approvals, a distinct activator. Idempotent per suite: call once per beforeEach after truncateAll. */
export async function activateOpdVisitDefinition(db: Db): Promise<{ definitionId: string }> {
  if ((await db.select({ k: sodPairs.pairKey }).from(sodPairs)).length === 0) await seedSodPairs(db);
  const drafter = await mkUser(db, "opd_def_drafter", []);
  const owner = await mkUser(db, "opd_def_owner", ["owner"]);
  const ms = await mkUser(db, "opd_def_ms", ["medical_superintendent"]);
  const activator = await mkUser(db, "opd_def_activator", []);
  const { definitionId } = await createDraft(db, drafter.actor, OPD_VISIT_DEFINITION_JSON);
  await approveDefinition(db, owner.actor, { definitionId, roleKey: "owner", note: "go-live activation" });
  await approveDefinition(db, ms.actor, { definitionId, roleKey: "medical_superintendent", note: "go-live activation" });
  await activateDefinition(db, activator.actor, definitionId);
  return { definitionId };
}
```
(Move the new imports to the top of the file.)

- [ ] **Step 7: Mutants (tripwire 21).** Build and run isolated, 5× each unless noted, then delete: **Mutant A** `visit-type.mutantA.ts` — `days < anchor.followUpDays` (strict) → the "day 7 is a revisit" assertion → predicted DIED. **Mutant B** `encounters.mutantB.ts` — a copy of `openVisitInTx` whose anchor query drops the `departmentId` predicate → test 3's "other department → new" → predicted DIED. **Mutant C** `sessions.mutantC.ts` — `allocateToken` as read-then-write (`select next_token` then `update set next_token = n + 1`) → test 4's distinct-tokens assertion → predicted DIED-likely under 6-way contention; **measure, do not predict** (§3.22): run 10×, report the observed kill rate; a SURVIVED run is possible and is reported, not engineered away — the structural defence is the atomic `UPDATE … RETURNING`, which the shipped test pins by reading `nextToken === 7`. **Mutant D** `registration.mutantD.ts` — `listMergedLoserIds` with the hop loop bound at 1 → the two-hop chain test → predicted DIED. Every mutant spec is self-contained (inline seeding, `test/helpers/*` imports only).
- [ ] **Step 8: Run to pass.** Isolated: `workflow-def.test` 3, `visit-type.test` 4, `encounters.test` 10, `registration.test` (its previous count + 3 — measure, per §2.9). Workspace: **78 suites / 445 tests** (75 + 3 suites; 425 + 3 + 4 + 10 + 3). Detached `pnpm verify`.
- [ ] **Step 9: Commit** — `feat(core): OPD encounter spine — opd_visit definition, sessions/tokens, visit type, open/abandon/re-enter/transfer/timeline; patients summaries + merged-loser helpers` → pull --rebase → push.

**Acceptance criteria:**
1. `workflow-def.test` 3/3, `visit-type.test` 4/4, `encounters.test` 10/10, the three new `registration.test` tests green and every OTHER test in that file unchanged and green; every red-first run quoted (or the §2.8 fallback).
2. Test 1's two event payloads match `toEqual` exactly as written; test 6's race ran 5 iterations with ONE loser code (`encounter_state_conflict`) on every iteration and the invariant asserted on every path (no early bail); test 4 shows tokens `[1..6]` and `nextToken 7`.
3. `opd_encounters.status` is written by `moveEncounter` and NOWHERE else in the module (grep for `.update(opdEncounters)` shows the mirror plus the `doctorId` transfer update only — the latter does not touch `status`).
4. Mutants A, B, D DIED (5/5 each); Mutant C's observed rate over 10 runs reported (SURVIVED runs disclosed, not hidden); scratch deleted before the count step.
5. `modules/patients/index.ts` gained exactly the two lines shown; `registration.ts` gained the two functions + the `inArray` import and nothing else (`git diff --stat` = 3 patients files); the OPD module imports from `../patients` ONLY via `../patients/index` (`grep -rn "from \"../patients/" src/modules/opd` returns only `../patients` or `../patients/index` specifiers).
6. Workspace 78 / 445; verify green; clean tree.

---

### Task 4: Appointments — book / reschedule / cancel / check-in, the no-show sweep, and the doctor-leave cascade  *(sonnet coder)*

**Files:**
- Create: `apps/core/src/modules/opd/appointments.ts`, `apps/core/src/modules/opd/appointments.test.ts`
- Create: `apps/core/src/modules/opd/leaves.ts` (tested inside `appointments.test.ts` — the cascade is an appointments fact)

- [ ] **Step 1: Write the failing tests** — `appointments.test.ts` (setup as T3's encounters test: `truncateAll` → `seedOpdBase` → `activateOpdVisitDefinition` → `seedOpdMasters` → `mkDoctor("dra", deptId, roomId)` (Mon–Sat 09:00–13:00), `mkDoctor("drb", deptId, room2Id)`, `clerk` [`front_office`], `mkPatient` ×3). Pin `MON = "2026-08-17"`, `S0930 = new Date("2026-08-17T04:00:00.000Z")` (a template slot: 09:30 IST), `S0935 = new Date("2026-08-17T04:05:00.000Z")` (NOT a slot boundary), `NOW_SUN = new Date("2026-08-16T04:00:00.000Z")` (booking time, the day before). Nine tests, hand-derived:

  1. **book** — `bookAppointment(db, clerk.actor, { patientId: p1, doctorId: dra.doctorId, slotStart: S0930 }, NOW_SUN)` → row `{ status: "booked", serviceDate: "2026-08-17", departmentId: deptId, slotEnd: S0930 + 10 min, source: "desk" }`; one `appointment.booked` event with payload `toEqual({ appointmentId, patientId: p1, doctorId, departmentId: deptId, serviceDate: "2026-08-17", slotStart: "2026-08-17T04:00:00.000Z", source: "desk" })`; `S0935` → `invalid_slot`; a slot in the past (`now = S0930 + 1 min`) → `slot_in_past`; an unknown patient id → `patient_not_found`; a non-user actor → `user_actor_required`.
  2. **the slot race** — `Promise.allSettled([book(p1, S0930), book(p2, S0930)])` → exactly one fulfilled; the loser's `code === "slot_taken"` (the ONLY code: the partial unique index is the arbiter and `onConflictDoNothing().returning()` yields 0 rows on every interleaving — there is no pre-check that could produce a different code); exactly ONE live row for (dra, S0930); exactly one `appointment.booked` event; a later sequential booking of the same slot → `slot_taken`. Loop the race 5× on fresh slots (`S0930 + k×10 min`).
  3. **reschedule** — book `p1` at 09:30; `rescheduleAppointment(db, clerk.actor, id, { slotStart: S1000 }, NOW_SUN)` (10:00 IST = `04:30Z`) → old row `{ status: "rescheduled", rescheduledToId: newId }`, new row `{ status: "booked", slotStart: S1000, rescheduledFromId: oldId, patientId: p1 }`; one `appointment.rescheduled` event with `{ fromAppointmentId: oldId, toAppointmentId: newId, previousSlotStart: "2026-08-17T04:00:00.000Z", slotStart: "2026-08-17T04:30:00.000Z", doctorId, previousDoctorId: doctorId }`; rescheduling into a slot `p2` holds → `slot_taken` AND the old row is still `booked` (the whole transaction rolled back); rescheduling to **drb** (`{ slotStart: S0930, doctorId: drb.doctorId }`) → new row under drb, `previousDoctorId dra`; rescheduling a cancelled one → `appointment_state_conflict`.
  4. **cancel** — `cancelAppointment(db, clerk.actor, id, "patient called", now)` → `status "cancelled"`, `cancelReason`; event `appointment.cancelled` with `reason`; blank reason → `reason_required`; a second cancel → `appointment_state_conflict`; the freed slot is bookable again (`book(p2, S0930)` succeeds).
  5. **check-in opens the visit** — book `p1` at 09:30; `checkInAppointment(db, clerk.actor, id, new Date("2026-08-17T03:50:00.000Z"))` (09:20 IST, ten minutes early) → an `OpenVisitResult` with `tokenNo 1`, `visitType "new"`; the encounter `{ appointmentId: id, doctorId, departmentId }`; the queue entry `{ kind: "appointment", appointmentAt: S0930, status: "waiting_vitals" }`; the appointment `{ status: "checked_in", encounterId: encounter.id }`; the `visit.opened` payload has `kind "appointment"` and `appointmentId id`; checking in on the wrong day (`now = "2026-08-18T04:00Z"`) → `appointment_not_today` and NO encounter; checking in twice → `appointment_state_conflict`; a `Promise.allSettled` of two concurrent check-ins of one appointment → one fulfilled, one `appointment_state_conflict`, exactly ONE encounter for that appointment (the claim UPDATE `WHERE status = 'booked'` is the arbiter — single code).
  6. **needs_rebooking cannot check in** — after a leave marks the appointment (test 7's setup) `checkInAppointment` → `doctor_on_leave`.
  7. **leave cascade** — book `p1` Mon 09:30, `p2` Tue 09:30 (`2026-08-18T04:00Z`), `p3` Thu 09:30 (`2026-08-20T04:00Z`); `scheduleDoctorLeave(db, clerk.actor, { doctorId: dra.doctorId, fromDate: "2026-08-17", toDate: "2026-08-18", reason: "conference" }, NOW_SUN)` → `{ leaveId, affectedAppointmentIds }` with exactly the Mon and Tue ids (order-insensitive); both rows `{ status: "needs_rebooking", leaveId }`; the Thu row still `booked`; one `doctor_leave.scheduled` event with `affectedAppointmentIds` (sorted) and `fromDate/toDate/reason`; `availableSlots(db, dra.doctorId, "2026-08-17", NOW_SUN)` → `[]`; `listAppointments(db, { doctorId, needsRebooking: true })` → the two; rescheduling the Mon one to Thu 10:00 works (`rescheduled` + a new `booked` row); `cancelDoctorLeave(db, clerk.actor, leaveId, NOW_SUN)` → `{ restored: 1 }` — the Tue row is `booked` again with `leaveId null`, the Mon (rescheduled) row untouched; a second `cancelDoctorLeave` → `leave_not_scheduled`; `fromDate > toDate` → `invalid_leave_range`; `toDate` before today → `invalid_leave_range`; blank reason → `reason_required`.
  8. **no-show sweep** — book `p1` and `p2` on Mon 09:30/09:40 and `p3` on Tue 09:30; `sweepAppointmentNoShows(db, new Date("2026-08-17T18:30:00.000Z"))` (Tue 00:00 IST) → returns 2; both Mon rows `no_show`; two `appointment.no_show` events; the Tue row untouched; a second sweep at the same instant → 0; a sweep at `2026-08-17T18:29:59Z` (still Mon IST) → 0 (the day has not passed).
  9. **listAppointments** — by `doctorId + serviceDate` ordered by `slotStart` asc; by `patientId`; by `status: ["booked"]`.

- [ ] **Step 2: Implement `leaves.ts`**:

```ts
export type LeaveRow = typeof opdDoctorLeaves.$inferSelect;
export async function scheduleDoctorLeave(db: Db, actor: Actor, input: { doctorId: string; fromDate: string; toDate: string; reason: string }, now: Date = new Date()): Promise<{ leaveId: string; affectedAppointmentIds: string[] }>
export async function cancelDoctorLeave(db: Db, actor: Actor, leaveId: string, now: Date = new Date()): Promise<{ restored: number }>
export async function listLeaves(db: Db, filter: { doctorId?: string; from?: string; to?: string; status?: "scheduled" | "cancelled" }): Promise<LeaveRow[]>   // from_date asc
```
`scheduleDoctorLeave`: user actor; `reason.trim() === ""` ⇒ `reason_required`; `fromDate > toDate` or `toDate < istDate(now)` ⇒ `invalid_leave_range`; doctor exists (`unknown_doctor`); in ONE tx: insert the leave (`status "scheduled"`), then the cascade —
```ts
    const affected = await tx
      .update(opdAppointments)
      .set({ status: "needs_rebooking", leaveId, updatedBy: actor.id, updatedAt: now })
      .where(and(
        eq(opdAppointments.doctorId, input.doctorId), eq(opdAppointments.status, "booked"),
        gte(opdAppointments.serviceDate, input.fromDate), lte(opdAppointments.serviceDate, input.toDate),
      ))
      .returning({ id: opdAppointments.id });
```
then `doctor_leave.scheduled` with `affectedAppointmentIds: affected.map(a => a.id).sort()`. `cancelDoctorLeave`: conditional `UPDATE … SET status='cancelled', cancelled_by, cancelled_at WHERE id=? AND status='scheduled' RETURNING` (0 rows ⇒ `leave_not_scheduled`), then restore `UPDATE opd_appointments SET status='booked', leave_id=NULL WHERE leave_id=? AND status='needs_rebooking' RETURNING` → `restored`. No event on cancel (no catalog name; disclosed in D9's spirit — the leave row's `cancelled_at` is the record).

- [ ] **Step 3: Implement `appointments.ts`**:

```ts
export type AppointmentRow = typeof opdAppointments.$inferSelect;
export const LIVE_APPOINTMENT_STATUSES = ["booked", "checked_in", "needs_rebooking"] as const;
export async function bookAppointment(db: Db, actor: Actor, input: { patientId: string; doctorId: string; slotStart: Date; source?: "desk" | "phone"; note?: string }, now: Date = new Date()): Promise<{ appointment: AppointmentRow }>
export async function rescheduleAppointment(db: Db, actor: Actor, appointmentId: string, input: { slotStart: Date; doctorId?: string }, now: Date = new Date()): Promise<{ from: AppointmentRow; to: AppointmentRow }>
export async function cancelAppointment(db: Db, actor: Actor, appointmentId: string, reason: string, now: Date = new Date()): Promise<{ appointment: AppointmentRow }>
export async function checkInAppointment(db: Db, actor: Actor, appointmentId: string, now: Date = new Date()): Promise<OpenVisitResult>
export async function listAppointments(db: Db, filter: { doctorId?: string; serviceDate?: string; patientId?: string; status?: string[]; needsRebooking?: boolean }, limit = 500): Promise<AppointmentRow[]>   // slot_start asc
export async function sweepAppointmentNoShows(db: Db, now: Date = new Date()): Promise<number>
```
`bookAppointment` — user actor; `resolvePatientId(db, …)` ⇒ `patient_not_found`; then in ONE tx: doctor (`unknown_doctor`/`doctor_inactive`), department = the doctor's; `slotStart < now` ⇒ `slot_in_past`; `serviceDate = istDate(slotStart)`; the day's scheduled leaves ⇒ `doctor_on_leave`; `availableSlots(tx, doctorId, serviceDate, now)` must contain a slot with `start.getTime() === slotStart.getTime()` else `invalid_slot` (this validates the template, the weekday, validity and the slot grid in one call; `booked` slots are NOT refused here — the index decides, so the loser code is single); insert with `.onConflictDoNothing().returning()` — 0 rows ⇒ `slot_taken`; append `appointment.booked`. **The booking-race code is `slot_taken` on every interleaving** because nothing before the insert reads other bookings for correctness (`availableSlots`'s `booked` flag is display data and is ignored here). `rescheduleAppointment` — load; status ∈ {`booked`, `needs_rebooking`} else `appointment_state_conflict`; validate the new slot exactly as booking (target doctor defaults to the current); in ONE tx: conditional `UPDATE … SET status='rescheduled', rescheduled_to_id=? WHERE id=? AND status=<loaded>` (0 rows ⇒ `appointment_state_conflict`), then insert the new row (`rescheduledFromId`, same patient/source/note; `bookedBy = actor.id`) with `.onConflictDoNothing().returning()` — 0 rows ⇒ throw `slot_taken` (the transaction rolls the status flip back), then `appointment.rescheduled`. `cancelAppointment` — reason required; status ∈ {`booked`, `needs_rebooking`}; conditional update; event. `checkInAppointment` — load (`unknown_appointment`); `needs_rebooking` ⇒ `doctor_on_leave`; status ≠ `booked` ⇒ `appointment_state_conflict`; `serviceDate !== istDate(now)` ⇒ `appointment_not_today`; `canonical = resolvePatientId(db, appt.patientId)` (a merge may have landed since booking) and `chainIds` via `listMergedLoserIds` — BEFORE the tx; in ONE tx: claim `UPDATE opd_appointments SET status='checked_in' WHERE id=? AND status='booked' RETURNING` (0 rows ⇒ `appointment_state_conflict` — the single race code), `openVisitInTx(tx, actor, { patientId: canonical, departmentId, doctorId, appointment: { id, slotStart }, chainIds }, now)`, then `UPDATE opd_appointments SET encounter_id = ? WHERE id = ?`. `sweepAppointmentNoShows` — `today = istDate(now)`; candidates = `select id from opd_appointments where status='booked' and service_date < today`; per candidate, in its own tx: conditional `UPDATE … SET status='no_show', updated_by='no-show-sweep' WHERE id=? AND status='booked' RETURNING *` — if a row came back, append `appointment.no_show` (`actor: { type: "system", id: "no-show-sweep" }`); count the fired ones. Idempotent, multi-process-safe, **unscheduled** (Plan 11's pg-boss list — the fifth sweep).

- [ ] **Step 4: Mutants (tripwire 21).** **A** `appointments.mutantA.ts` — `bookAppointment` without the `availableSlots` membership check → test 1's `invalid_slot` → predicted DIED. **B** `appointments.mutantB.ts` — `checkInAppointment` without the same-day check → test 5's `appointment_not_today` → predicted DIED. **C** `leaves.mutantC.ts` — cascade UPDATE without the date-range predicates → test 7's "Thu row still booked" → predicted DIED. **D** `appointments.mutantD.ts` — sweep without `service_date < today` → test 8's "Tue row untouched" → predicted DIED. 5× each, self-contained specs, delete before counting.
- [ ] **Step 5: Run to pass.** `appointments.test` **9**. Workspace **79 suites / 454 tests**. Detached `pnpm verify`.
- [ ] **Step 6: Commit** — `feat(core): OPD appointments — slot booking with the index as arbiter, reschedule/cancel, same-day check-in opening the visit, no-show sweep, doctor-leave cascade` → pull --rebase → push.

**Acceptance criteria:**
1. 9/9 with the hand-derived instants (`04:00Z`, `04:30Z`, slotEnd +10 min) and the exact `appointment.booked` / `appointment.rescheduled` payloads; the booking race (5 iterations) and the check-in race each show ONE loser code and the invariant on every path.
2. `bookAppointment` never refuses on `availableSlots(...).booked` (grep shows the flag unused there) — the index is the sole arbiter (criterion for the single-code claim).
3. Mutants A–D DIED 5/5; scratch deleted.
4. `sweepAppointmentNoShows` claims per row with a conditional UPDATE and appends the event in the same tx as the claim; no scheduler code anywhere (grep `setInterval|setTimeout|cron` in `src/modules/opd` = 0 hits).
5. Workspace 79 / 454; verify green; clean tree.

---

### Task 5: The queue — pure engine (property-tested), call / skip / start, board and desk summaries, and the serializer  *(opus coder — the queue is the plan's most-read surface and its second concurrency core)*

**Files:**
- Modify: `apps/core/package.json` (devDependency `fast-check` ^3.23.0), `pnpm-lock.yaml`
- Create: `apps/core/src/modules/opd/queue-engine.ts`, `apps/core/src/modules/opd/queue-engine.test.ts`
- Create: `apps/core/src/modules/opd/queue.ts`, `apps/core/src/modules/opd/queue.test.ts`
- Create: `apps/core/src/modules/opd/purity.test.ts` (T6 and T7 each add one file name to its list)

- [ ] **Step 1: Install fast-check** — on the server: `cd /opt/hmis && pnpm --filter @hmis/core add -D fast-check@^3.23.0` (network; a registry failure is an INFRA event, not a defect — §2.1). Commit `apps/core/package.json` + `pnpm-lock.yaml` with the task (tripwire 12). Verify-by-execution flag ④: `fast-check` loads under ts-jest CJS — the property suite running IS the proof.

- [ ] **Step 2: The engine (red-first)** — `queue-engine.test.ts`. The hand-derived example first (D2's classes), then the properties:

```ts
import fc from "fast-check";
import { classOf, nextInQueue, orderQueue } from "./queue-engine";
import type { QueueEntryState } from "./queue-engine";

const T = (hhmmIst: string) => new Date(`2026-08-17T${hhmmIst}:00.000+05:30`); // IST wall clock → instant
const NOW = T("10:00");
const NONE = { perkEveryNth: null };
const e = (over: Partial<QueueEntryState> & { id: string; seq: number }): QueueEntryState => ({
  tokenNo: over.seq, kind: "walk_in", appointmentAt: null, eligibleAt: T("09:00"), danger: false, reEntry: false, perk: false, skips: 0, ...over,
});

describe("orderQueue — §11.1 discipline, hand-derived", () => {
  const A = e({ id: "A", seq: 1, eligibleAt: T("09:00") });                                        // walk-in, first to be eligible
  const B = e({ id: "B", seq: 2, kind: "appointment", appointmentAt: T("09:50"), eligibleAt: T("09:45") }); // due (late by 10 min)
  const C = e({ id: "C", seq: 3, kind: "appointment", appointmentAt: T("10:20"), eligibleAt: T("09:30") }); // FUTURE (arrived early)
  const D = e({ id: "D", seq: 4, eligibleAt: T("09:10"), danger: true });                          // danger vitals
  const E = e({ id: "E", seq: 5, eligibleAt: T("09:55"), reEntry: true });                         // back from the lab
  const F = e({ id: "F", seq: 6, eligibleAt: T("09:05"), skips: 1 });                              // walk-in
  const G = e({ id: "G", seq: 7, kind: "appointment", appointmentAt: T("09:30"), eligibleAt: T("09:58") }); // due (very late), earlier slot than B

  it("D E G B A F C: danger, re-entry, due appointments by slot, walk-ins FIFO, future appointment last", () => {
    expect(orderQueue([A, B, C, D, E, F, G], NOW, NONE, 0).map((x) => x.id)).toEqual(["D", "E", "G", "B", "A", "F", "C"]);
    expect(nextInQueue([A, B, C, D, E, F, G], NOW, NONE, 0)!.id).toBe("D");
  });
  it("classes: D=0 E=1 G=2 B=2 A=3 F=3 C=4; C becomes due at 10:20", () => {
    expect([D, E, G, B, A, F, C].map((x) => classOf(x, NOW))).toEqual([0, 1, 2, 2, 3, 3, 4]);
    expect(classOf(C, T("10:20"))).toBe(2);
    expect(orderQueue([A, C], T("10:20"), NONE, 0).map((x) => x.id)).toEqual(["C", "A"]);
  });
  it("a skipped walk-in re-queued (eligibleAt = now) falls behind the other walk-ins but keeps its token", () => {
    const F2 = { ...F, eligibleAt: T("10:00"), skips: 2 };
    expect(orderQueue([F2, A], NOW, NONE, 0).map((x) => x.id)).toEqual(["A", "F"]);
    expect(F2.tokenNo).toBe(6);
  });
  it("E-32 perk: on the Nth call the earliest perk walk-in heads the walk-ins — never above danger, re-entry or a due appointment", () => {
    const Fp = { ...F, perk: true, eligibleAt: T("09:30") };
    expect(orderQueue([A, Fp, C], NOW, { perkEveryNth: 2 }, 1).map((x) => x.id)).toEqual(["F", "A", "C"]); // (1+1)%2===0 → perk turn
    expect(orderQueue([A, Fp, C], NOW, { perkEveryNth: 2 }, 2).map((x) => x.id)).toEqual(["A", "F", "C"]); // (2+1)%2!==0 → plain
    expect(orderQueue([A, Fp, C, D], NOW, { perkEveryNth: 2 }, 1).map((x) => x.id)).toEqual(["D", "A", "F", "C"]); // danger heads: no promotion
    expect(orderQueue([A, Fp, C, B], NOW, { perkEveryNth: 2 }, 1).map((x) => x.id)).toEqual(["B", "A", "F", "C"]); // due appt heads: no promotion
    expect(orderQueue([A, Fp, C], NOW, { perkEveryNth: 1 }, 0).map((x) => x.id)).toEqual(["F", "A", "C"]); // N=1: every call is a perk turn
    expect(orderQueue([A, Fp, C], NOW, NONE, 1).map((x) => x.id)).toEqual(["A", "F", "C"]);         // hook off (Plan 07 config)
  });
  it("empty → null", () => { expect(nextInQueue([], NOW, NONE, 0)).toBeNull(); });
});

// ——— properties (fast-check) ———
const BASE = Date.parse("2026-08-17T03:30:00.000Z"); // 09:00 IST
const minuteArb = fc.integer({ min: 0, max: 8 * 60 });
const rawEntryArb = fc.record({
  id: fc.uuid(),
  seq: fc.integer({ min: 1, max: 1_000_000 }),
  kind: fc.constantFrom("appointment", "walk_in") as fc.Arbitrary<"appointment" | "walk_in">,
  apptMin: minuteArb, eligibleMin: minuteArb,
  danger: fc.boolean(), reEntry: fc.boolean(), perk: fc.boolean(), skips: fc.nat({ max: 5 }),
});
const entryArb: fc.Arbitrary<QueueEntryState> = rawEntryArb.map((r) => ({
  id: r.id, seq: r.seq, tokenNo: r.seq % 500 + 1, kind: r.kind,
  appointmentAt: r.kind === "appointment" ? new Date(BASE + r.apptMin * 60_000) : null,
  eligibleAt: new Date(BASE + r.eligibleMin * 60_000), danger: r.danger, reEntry: r.reEntry, perk: r.perk, skips: r.skips,
}));
const queueArb = fc.uniqueArray(entryArb, { selector: (x) => x.seq, maxLength: 40 });
const nowArb = minuteArb.map((m) => new Date(BASE + m * 60_000));
const ids = (xs: QueueEntryState[]) => xs.map((x) => x.id);

describe("orderQueue — properties", () => {
  it("P1 is a permutation of its input", () => {
    fc.assert(fc.property(queueArb, nowArb, (q, now) => {
      expect(ids(orderQueue(q, now, NONE, 0)).sort()).toEqual(ids(q).sort());
    }));
  });
  it("P2 classes never decrease along the ordering (danger < re-entry < due appt < walk-in < future appt)", () => {
    fc.assert(fc.property(queueArb, nowArb, (q, now) => {
      const cs = orderQueue(q, now, NONE, 0).map((x) => classOf(x, now));
      for (let i = 1; i < cs.length; i++) expect(cs[i - 1]! <= cs[i]!).toBe(true);
    }));
  });
  it("P3 within a class, eligibleAt (walk-ins/danger/re-entry) or appointmentAt (appointments) never decreases, seq breaks ties", () => {
    fc.assert(fc.property(queueArb, nowArb, (q, now) => {
      const o = orderQueue(q, now, NONE, 0);
      for (let i = 1; i < o.length; i++) {
        const a = o[i - 1]!, b = o[i]!;
        if (classOf(a, now) !== classOf(b, now)) continue;
        const key = (x: QueueEntryState) => (classOf(x, now) === 2 || classOf(x, now) === 4 ? x.appointmentAt!.getTime() : x.eligibleAt.getTime());
        expect(key(a) < key(b) || (key(a) === key(b) && a.seq < b.seq)).toBe(true);
      }
    }));
  });
  it("P4 deterministic under input shuffling", () => {
    fc.assert(fc.property(queueArb, nowArb, fc.array(fc.nat(), { minLength: 40, maxLength: 40 }), (q, now, noise) => {
      const shuffled = [...q].sort((a, b) => (noise[a.seq % 40]! - noise[b.seq % 40]!) || a.seq - b.seq);
      expect(ids(orderQueue(shuffled, now, NONE, 3))).toEqual(ids(orderQueue(q, now, NONE, 3)));
    }));
  });
  it("P5 the perk hook only ever moves ONE class-3 perk entry to the head, only when the plain head is class 3, only on an Nth call; otherwise identical", () => {
    fc.assert(fc.property(queueArb, nowArb, fc.integer({ min: 1, max: 5 }), fc.nat({ max: 20 }), (q, now, n, calls) => {
      const plain = orderQueue(q, now, NONE, calls);
      const perked = orderQueue(q, now, { perkEveryNth: n }, calls);
      const perkTurn = (calls + 1) % n === 0;
      const head = plain[0];
      const candidate = plain.find((x) => x.perk && classOf(x, now) === 3);
      if (!perkTurn || head === undefined || classOf(head, now) !== 3 || candidate === undefined) {
        expect(ids(perked)).toEqual(ids(plain));
      } else {
        expect(perked[0]!.id).toBe(candidate.id);
        expect(ids(perked).filter((i) => i !== candidate.id)).toEqual(ids(plain).filter((i) => i !== candidate.id));
      }
    }));
  });
});
```

Derivations for the example: `T("09:50")`/`T("09:30")` are due at NOW 10:00 (class 2), sorted by slot → G(09:30) before B(09:50); C(10:20) is future (class 4, last); D danger (0); E re-entry (1); walk-ins A(09:00) before F(09:05). Perk: `Fp` eligible 09:30 is later than A's 09:00, so without the hook A leads; on a perk turn F is promoted to the head only when the plain head (A) is class 3.

`queue-engine.ts` (pure — imports nothing):

```ts
export type QueueClass = 0 | 1 | 2 | 3 | 4; // danger · re-entry · due appointment · walk-in · future appointment
export type QueueEntryState = {
  id: string; tokenNo: number; kind: "appointment" | "walk_in"; appointmentAt: Date | null;
  eligibleAt: Date; seq: number; danger: boolean; reEntry: boolean; perk: boolean; skips: number;
};
export type QueuePolicy = { perkEveryNth: number | null };

/** §11.1 + E-32 + the re-entry class. Pure. */
export function classOf(e: QueueEntryState, now: Date): QueueClass {
  if (e.danger) return 0;
  if (e.reEntry) return 1;
  if (e.kind === "appointment" && e.appointmentAt !== null) return e.appointmentAt.getTime() <= now.getTime() ? 2 : 4;
  return 3;
}

function compare(a: QueueEntryState, b: QueueEntryState, now: Date): number {
  const ca = classOf(a, now), cb = classOf(b, now);
  if (ca !== cb) return ca - cb;
  const byAppt = ca === 2 || ca === 4;
  const ka = byAppt ? a.appointmentAt!.getTime() : a.eligibleAt.getTime();
  const kb = byAppt ? b.appointmentAt!.getTime() : b.eligibleAt.getTime();
  if (ka !== kb) return ka - kb;
  return a.seq - b.seq; // arrival order — the bigserial, never the ULID
}

/**
 * Full ordering of the WAITING entries. Danger → re-entry → due appointments (by slot; late keeps priority, never expires)
 * → walk-ins FIFO (by eligibleAt; a skip re-queues) → future appointments (a walk-in beats a future appointment, never a due one).
 * E-32 perk hook: on every Nth call the earliest class-3 perk entry heads the walk-ins — only when the plain head is a walk-in,
 * so danger, re-entry and due appointments are never overtaken. Plan 07 never sets perk; Plan 09 does.
 */
export function orderQueue(entries: QueueEntryState[], now: Date, policy: QueuePolicy, callsMade: number): QueueEntryState[] {
  const sorted = [...entries].sort((a, b) => compare(a, b, now));
  const n = policy.perkEveryNth;
  if (n !== null && n >= 1 && (callsMade + 1) % n === 0) {
    const head = sorted[0];
    if (head !== undefined && classOf(head, now) === 3) {
      const idx = sorted.findIndex((x) => x.perk && classOf(x, now) === 3);
      if (idx > 0) {
        const [p] = sorted.splice(idx, 1);
        sorted.unshift(p!);
      }
    }
  }
  return sorted;
}

export function nextInQueue(entries: QueueEntryState[], now: Date, policy: QueuePolicy, callsMade: number): QueueEntryState | null {
  return orderQueue(entries, now, policy, callsMade)[0] ?? null;
}
```

- [ ] **Step 3: The service (red-first)** — `queue.test.ts` (setup as before + `seedOpdBase({ maxSkips: 3 })`; queue rows reach `waiting` by TEST SHAPING: after `openVisit`, `UPDATE opd_queue_entries SET status='waiting', eligible_at=…, danger=…, re_entry=…, appointment_at=…, kind=…` — the module's own table, disclosed; production reaches `waiting` through T6 vitals). Pin `MON = "2026-08-17"`, `NOW = 2026-08-17T04:30:00.000Z` (10:00 IST). Nine tests:

  1. **listQueue mirrors the engine** — four walk-ins opened (tokens 1–4), shaped into the D/E/A/F pattern (danger, re-entry, plain 09:00, plain 09:05) plus one entry left `waiting_vitals` → `listQueue(db, clerk.actor, doctorId, MON, NOW)` returns `ordered` ids in engine order with `position` 1..4 and `class` 0/1/3/3, `waitingVitals 1`, `current null`, `counts.waiting 4`; each view row carries `patient.uhid` (from `getPatientSummaries`) and `encounter.visitType`; no session yet for drb → `null`.
  2. **callNext calls the head and opens the session** — → `{ entry }` with `status "called"`, `calledAt NOW`, `callCount 1`, `tokenNo` of D; session `{ callsMade: 1, status: "in", openedAt: NOW }`; exactly one `queue.called` with payload `toEqual({ encounterId, patientId, entryId, doctorId, serviceDate: MON, sessionId, roomId, tokenNo, callCount: 1 })`; a second `callNext` while D is `called` → `call_conflict`; on an empty queue → `{ entry: null }`.
  3. **skip re-queues, then leaves** — `skipCalled(db, dra.actor, entryId, NOW+1m)` → `{ status: "waiting", skips: 1, eligibleAt: NOW+1m }`, event `queue.skipped { skips: 1, left: false }`; `listQueue` now shows it LAST among the class-3 walk-ins (its class stays 0 if danger — use a plain walk-in for this test); call+skip twice more → third skip → `status "left"`, event `{ skips: 3, left: true }`, and it no longer appears in `ordered`; skipping a `waiting` entry → `queue_entry_state_conflict`.
  4. **markInConsult / markDone (Tx helpers)** — `called → in_consult` OK; `waiting → in_consult` OK (a doctor may take a patient without calling); `done → in_consult` → `queue_entry_state_conflict`; `markDone` on `in_consult` → `done` with `doneAt`.
  5. **call race, same instant** — two waiting; `Promise.allSettled([callNext(...NOW), callNext(...NOW)])` → one fulfilled, the other `call_conflict`; exactly one `called` row and one `queue.called` event; 5 iterations on fresh sessions.
  6. **the serializer, discriminated** — walk-in W (eligible 09:00) and appointment X due at `T = 04:50Z` (10:20 IST); `Promise.allSettled([callNext(..., new Date("2026-08-17T04:49:00Z")), callNext(..., new Date("2026-08-17T04:51:00Z"))])` — the two callers would pick DIFFERENT heads (W vs X) — → exactly ONE `called` row, exactly one fulfilled, the other `call_conflict`, one `queue.called`. (This is the test the session-row lock exists for; Mutant S below is its discriminator.)
  7. **doctor status gates the call** — `setSessionStatus(out)` → `callNext` → `doctor_out`; `closed` → `session_closed`; back `in` → works.
  8. **perk turn** — `seedOpdBase({ perkEveryNth: 2 })`; three walk-ins A (09:00), B (09:10), F (09:20, `perk = true` by shaping); call → A (callsMade 0 → not a perk turn); `markDone(A)`; call → **F** (callsMade 1 → perk turn); `markDone(F)`; call → B. Sequence `[A, F, B]`; with `perkEveryNth: null` the same setup yields `[A, B, F]`.
  9. **boardSnapshot + summaryByDoctor** — two doctors with sessions (rooms 12 and 14), one called + two waiting under dra, none under drb → `boardSnapshot(db, MON)` returns two items `{ roomCode: "12", doctorName: "Dr dra", status: "in", nowServing: <token>, next: [t2, t3], waitingCount: 2 }` / `{ roomCode: "14", …, nowServing: null, next: [] }` and NO patient identifiers (assert `Object.keys` of an item equals the documented set); `summaryByDoctor(db, deptId, MON, NOW)` lists dra and drb with `waitingCount`, `status`, `scheduledToday true`, `nowServing`.

  Then `queue.ts`:

```ts
export type QueueEntryView = QueueEntryRow & { position: number | null; queueClass: QueueClass | null; encounter: { id: string; patientId: string; visitType: string; dangerFlagged: boolean; status: string }; patient: PatientSummary | null };
export type QueueView = { session: SessionRow; doctor: DoctorRow; ordered: QueueEntryView[]; current: QueueEntryView | null; inConsult: QueueEntryView[]; waitingVitals: number; counts: { waiting: number; called: number; inConsult: number; done: number; left: number } };
export async function listQueue(db: Db, actor: Actor, doctorId: string, serviceDate: string, now: Date = new Date()): Promise<QueueView | null>
export async function callNext(db: Db, actor: Actor, sessionId: string, now: Date = new Date()): Promise<{ entry: QueueEntryRow | null; encounter: EncounterRow | null }>
export async function skipCalled(db: Db, actor: Actor, entryId: string, now: Date = new Date()): Promise<{ entry: QueueEntryRow }>
export async function markInConsult(tx: Tx, encounterId: string, now: Date): Promise<QueueEntryRow>   // called|waiting → in_consult (T7 startConsultation)
export async function markDone(tx: Tx, encounterId: string, now: Date): Promise<QueueEntryRow | null>  // any live entry → done (T7 completion); null when none
export type BoardItem = { sessionId: string; roomId: string | null; roomCode: string | null; doctorId: string; doctorName: string; departmentName: string; status: SessionStatus; nowServing: number | null; next: number[]; waitingCount: number };
export async function boardSnapshot(db: Db, serviceDate: string, roomIds?: string[], now: Date = new Date()): Promise<BoardItem[]>   // sessions of the day (status ≠ closed), ordered by roomCode; next = up to 5 tokens in engine order
export type DoctorSummary = { doctor: DoctorRow; sessionId: string | null; status: SessionStatus | "none"; waitingCount: number; waitingVitalsCount: number; nowServing: number | null; scheduledToday: boolean; roomCode: string | null };
export async function summaryByDoctor(db: Db, departmentId: string | undefined, serviceDate: string, now: Date = new Date()): Promise<DoctorSummary[]>
```
`toState(row)`: `eligibleAt = row.eligibleAt ?? row.createdAt`. **`callNext` body order (the serializer first):**
```ts
  return withTx(db, async (tx) => {
    const cfg = await loadOpdConfig(tx);
    // Serialize callers per session: two "call next" clicks at nearly the same instant may compute DIFFERENT heads
    // (an appointment crossing its due time between their clocks); the row lock makes the pre-check below authoritative.
    const sRows = await tx.select().from(opdQueueSessions).where(eq(opdQueueSessions.id, sessionId)).for("update");
    const session = sRows[0];
    if (!session) throw new OpdError("unknown_session");
    if (session.status === "closed") throw new OpdError("session_closed");
    if (session.status === "out") throw new OpdError("doctor_out");
    const live = await tx.select().from(opdQueueEntries).where(and(eq(opdQueueEntries.sessionId, sessionId), inArray(opdQueueEntries.status, ["waiting", "called"])));
    if (live.some((r) => r.status === "called")) throw new OpdError("call_conflict", "a token is already called — start or skip it first");
    const head = nextInQueue(live.filter((r) => r.status === "waiting").map(toState), now, { perkEveryNth: cfg.perkEveryNth }, session.callsMade);
    if (!head) return { entry: null, encounter: null };
    const updated = await tx.update(opdQueueEntries)
      .set({ status: "called", calledAt: now, callCount: sql`${opdQueueEntries.callCount} + 1` })
      .where(and(eq(opdQueueEntries.id, head.id), eq(opdQueueEntries.status, "waiting"))).returning();
    if (updated.length === 0) throw new OpdError("call_conflict", "entry moved concurrently"); // belt — the SAME code as the pre-check
    await tx.update(opdQueueSessions)
      .set({ callsMade: sql`${opdQueueSessions.callsMade} + 1`, status: session.status === "not_started" ? "in" : session.status, openedAt: session.openedAt ?? now })
      .where(eq(opdQueueSessions.id, sessionId));
    const encounter = (await getEncounter(tx, updated[0]!.encounterId))!;
    await appendEvent(tx, queueCalled.make({ actor, patientId: encounter.patientId, encounterId: encounter.id, correlationId: encounter.workflowInstanceId, payload: {
      encounterId: encounter.id, patientId: encounter.patientId, entryId: updated[0]!.id, doctorId: session.doctorId, serviceDate: session.serviceDate,
      sessionId, roomId: session.roomId, tokenNo: updated[0]!.tokenNo, callCount: updated[0]!.callCount,
    } }));
    return { entry: updated[0]!, encounter };
  });
```
**Loser trace for tests 5 and 6 (§3.13, §3.28):** B blocks on `SELECT … FOR UPDATE` of the session row until A commits (the lock is on a row OUTSIDE the entry A updates — the session — so it is a real serializer, not the belt's own row lock, §3.28); B's next statement (a fresh READ COMMITTED snapshot) then sees A's `called` row → the pre-check throws `call_conflict`. Had B somehow read `live` before A's commit (impossible under the lock; the mutant's world), its conditional UPDATE would hit A's row → 0 rows → `call_conflict` again — or, with different heads, BOTH would succeed, which is exactly what test 6 refuses. `skipCalled`: cfg; entry must be `called` (`queue_entry_state_conflict`); `skips + 1 >= cfg.maxSkipsBeforeLeft` ⇒ `status "left"` else `status "waiting", eligibleAt now`; conditional on `status = 'called'`; `queue.skipped`. `boardSnapshot` returns exactly the documented keys — no `patientId`, no name (public surface, §11.5).

- [ ] **Step 4: Purity test** — `purity.test.ts` (the Plan 06 grep pattern): for each of `["time.ts", "slots.ts", "visit-type.ts", "queue-engine.ts"]` read the file with `fs.readFileSync` (path via `__dirname`) and assert it contains none of `from "../../kernel`, `await `, `new Date()`, `Math.random`, `process.` — pure cores stay pure (T6 adds `vitals-rules.ts`, T7 adds `fhir.ts`).

- [ ] **Step 5: Mutants (tripwire 21).** Engine mutants (each a copy of `queue-engine.ts` + a self-contained spec re-running the affected `it`): **E1** class 4 collapsed into class 2 (future appointments treated as due) → the example test → predicted DIED; **E2** walk-ins compared by `tokenNo` instead of `eligibleAt` → the "skipped walk-in falls behind" test → predicted DIED; **E3** `danger` ignored → the example test → predicted DIED; **E4** perk promotion allowed when the head is class ≤ 2 → the "danger heads: no promotion" assertion → predicted DIED. Service mutants: **S** `callNext` without `.for("update")` → test 6 → predicted DIED-likely (both callers pick different heads and both succeed) — **measure 10×, report the observed rate** (§3.22; a partial survival is reported, not engineered); **Q** `callNext` without the `live.some(called)` pre-check → test 2's second-call assertion → predicted DIED (a second patient gets called). Delete all scratch before counting.
- [ ] **Step 6: Run to pass.** `queue-engine.test` **10** (5 examples + 5 properties), `queue.test` **9**, `purity.test` **1** = 20. Workspace **82 suites / 474 tests**. Detached `pnpm verify`.
- [ ] **Step 7: Commit** — `feat(core): OPD queue — pure engine with fast-check properties, call/skip/start with a per-session serializer, board and desk summaries` → pull --rebase → push.

**Acceptance criteria:**
1. The example test's expected order `["D","E","G","B","A","F","C"]` and the perk sequences pass exactly as written; the five properties pass at fast-check's default 100 runs each.
2. Test 6 (different clocks) shows exactly ONE called row and ONE loser with code `call_conflict` on every run; test 5 the same for 5 iterations; Mutant S's observed rate reported over 10 runs; Mutants E1–E4 and Q DIED (3× each is enough for pure/deterministic mutants — state the count).
3. `boardSnapshot` items carry exactly `{ sessionId, roomId, roomCode, doctorId, doctorName, departmentName, status, nowServing, next, waitingCount }` and nothing patient-identifying (asserted by key set).
4. `fast-check` appears in `apps/core/package.json` devDependencies and in `pnpm-lock.yaml`; `queue-engine.ts` imports nothing (purity test green).
5. Workspace 82 / 474; verify green; clean tree.

---

### Task 6: Vitals — age-banded rules (pure), recording with danger flags and the registered→waiting move; the `seed:opd` script  *(sonnet coder)*

**Files:**
- Create: `apps/core/src/modules/opd/vitals-rules.ts`, `apps/core/src/modules/opd/vitals-rules.test.ts`
- Create: `apps/core/src/modules/opd/vitals.ts`, `apps/core/src/modules/opd/vitals.test.ts`
- Create: `apps/core/scripts/seed-opd.ts`; Modify: `apps/core/package.json` (one script line `"seed:opd": "tsx scripts/seed-opd.ts"`)
- Modify: `apps/core/src/modules/opd/purity.test.ts` (add `"vitals-rules.ts"` to the list)

- [ ] **Step 1: Rules (pure, red-first)** — `vitals-rules.test.ts` with hand-derived values against `DEFAULT_DANGER_RANGES`:

```ts
import { DEFAULT_DANGER_RANGES } from "./config";
import { bandFor, evaluateVitals, missingRequired, validateVitalsRanges } from "./vitals-rules";

const cfg = DEFAULT_DANGER_RANGES;
const adultOk = { heightCm: 165, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, spo2: 98, tempC: 37.0 };

describe("vitals rules (pure)", () => {
  it("bandFor: exclusive upper bounds; unknown age → adult", () => {
    expect([0, 1, 5, 6, 12, 13, 40, null].map((a) => bandFor(a, cfg).key)).toEqual([
      "infant", "child_1_5", "child_1_5", "child_6_12", "child_6_12", "adult", "adult", "adult",
    ]);
  });
  it("missingRequired: the band's list, plus weight under 18", () => {
    expect(missingRequired({}, 40, cfg)).toEqual(["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"]);
    expect(missingRequired(adultOk, 40, cfg)).toEqual([]);
    expect(missingRequired({ heightCm: 90, tempC: 37, spo2: 98, pulse: 100 }, 3, cfg)).toEqual(["weightKg"]);
    expect(missingRequired({ weightKg: 4.2, tempC: 37, spo2: 98, pulse: 120 }, 0, cfg)).toEqual([]);
    expect(missingRequired({ ...adultOk, weightKg: undefined }, 17, cfg)).toEqual(["weightKg"]); // the under-18 rule
    expect(missingRequired({ ...adultOk }, null, cfg)).toEqual([]); // unknown DOB: adult list, no age rule
  });
  it("evaluateVitals: inclusive bounds; each breach names vital, value, bound, limit", () => {
    const adult = bandFor(40, cfg);
    expect(evaluateVitals({ ...adultOk, sbp: 190 }, adult)).toEqual([{ vital: "sbp", value: 190, bound: "max", limit: 180 }]);
    expect(evaluateVitals({ ...adultOk, sbp: 180 }, adult)).toEqual([]);
    expect(evaluateVitals({ ...adultOk, sbp: 89 }, adult)).toEqual([{ vital: "sbp", value: 89, bound: "min", limit: 90 }]);
    expect(evaluateVitals({ ...adultOk, spo2: 89 }, adult)).toEqual([{ vital: "spo2", value: 89, bound: "min", limit: 90 }]);
    expect(evaluateVitals({ ...adultOk, tempC: 39.5 }, adult)).toEqual([]);
    expect(evaluateVitals({ ...adultOk, tempC: 39.6 }, adult)).toEqual([{ vital: "tempC", value: 39.6, bound: "max", limit: 39.5 }]);
    expect(evaluateVitals({ ...adultOk, sbp: 200, spo2: 85 }, adult)).toHaveLength(2);
    expect(evaluateVitals({ pulse: 85 }, bandFor(0, cfg))).toEqual([{ vital: "pulse", value: 85, bound: "min", limit: 90 }]);
    expect(evaluateVitals({ sbp: 141 }, bandFor(8, cfg))).toEqual([{ vital: "sbp", value: 141, bound: "max", limit: 140 }]);
    expect(evaluateVitals({ rr: 31 }, adult)).toEqual([{ vital: "rr", value: 31, bound: "max", limit: 30 }]); // optional field, still evaluated when present
  });
  it("validateVitalsRanges refuses implausible readings", () => {
    expect(() => validateVitalsRanges({ ...adultOk, spo2: 101 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges({ ...adultOk, tempC: 50 })).toThrow(expect.objectContaining({ code: "invalid_vitals" }));
    expect(() => validateVitalsRanges(adultOk)).not.toThrow();
  });
});
```

`vitals-rules.ts` (pure — imports `./config` types + `./errors` only):

```ts
import { OpdError } from "./errors";
import type { BandConfig, DangerRangesConfig, VitalKey } from "./config";
import type { DangerFlag } from "./events";

export type VitalsInput = {
  heightCm?: number | null; weightKg?: number | null; sbp?: number | null; dbp?: number | null;
  pulse?: number | null; rr?: number | null; spo2?: number | null; tempC?: number | null; notes?: string | null;
};
const RANGED: readonly DangerFlag["vital"][] = ["sbp", "dbp", "pulse", "rr", "spo2", "tempC"];
const PLAUSIBLE: Record<VitalKey, [number, number]> = {
  heightCm: [20, 250], weightKg: [0.3, 400], sbp: [30, 300], dbp: [10, 200], pulse: [10, 300], rr: [2, 100], spo2: [0, 100], tempC: [25, 45],
};

/** The band whose EXCLUSIVE upper bound the age is below; unknown age → the adult tail. */
export function bandFor(ageYears: number | null, cfg: DangerRangesConfig): BandConfig {
  const tail = cfg.bands[cfg.bands.length - 1]!;
  if (ageYears === null) return tail;
  return cfg.bands.find((b) => b.upToAgeYears !== null && ageYears < b.upToAgeYears) ?? tail;
}

function present(v: VitalsInput, k: VitalKey): boolean {
  const x = v[k];
  return x !== undefined && x !== null;
}

/** Completeness (S10 KPI "vitals completeness"): the band's required list, plus weight under cfg.weightRequiredUnderYears (§11.8). */
export function missingRequired(v: VitalsInput, ageYears: number | null, cfg: DangerRangesConfig): VitalKey[] {
  const band = bandFor(ageYears, cfg);
  const need = new Set<VitalKey>(band.required);
  if (ageYears !== null && ageYears < cfg.weightRequiredUnderYears) need.add("weightKg");
  return (["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse", "rr"] as VitalKey[]).filter((k) => need.has(k) && !present(v, k));
}

/** Every PRESENT ranged vital compared against the band's inclusive bounds. */
export function evaluateVitals(v: VitalsInput, band: BandConfig): DangerFlag[] {
  const flags: DangerFlag[] = [];
  for (const k of RANGED) {
    const value = v[k];
    if (value === undefined || value === null) continue;
    const r = band.ranges[k];
    if (!r) continue;
    if (r.min !== undefined && value < r.min) flags.push({ vital: k, value, bound: "min", limit: r.min });
    if (r.max !== undefined && value > r.max) flags.push({ vital: k, value, bound: "max", limit: r.max });
  }
  return flags;
}

export function validateVitalsRanges(v: VitalsInput): void {
  for (const k of Object.keys(PLAUSIBLE) as VitalKey[]) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    const [lo, hi] = PLAUSIBLE[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < lo || x > hi) throw new OpdError("invalid_vitals", `${k} out of plausible range ${lo}–${hi}`, { vital: k, value: x });
  }
}
```

- [ ] **Step 2: Recording (red-first)** — `vitals.test.ts` (setup as T3; `vd` [`vitals_desk`], `clerk` [`front_office`]; a 30-year-old patient via `mkPatient` and a 3-year-old via `mkPatient(db, clerk.actor, { ageYears: 3, guardian: { name: "G", relationship: "mother" } })`; `MON` as before). Five tests:
  1. **normal recording moves registered → waiting** — `recordVitals(db, vd.actor, enc.id, adultOk, MON)` → the vitals row (`band "adult"`, `ageYearsAtRecord 30`, `dangerFlags []`, `recordedBy vd.id`); encounter `status "waiting"`, `dangerFlagged false`; the queue entry `{ status: "waiting", eligibleAt: MON, danger: false }`; exactly one `vitals.recorded` with payload `toMatchObject({ encounterId, vitalsId, band: "adult", dangerCount: 0, tokenNo: 1, serviceDate: "2026-08-17" })` and NO `vitals.danger_flagged`; the workflow instance `currentState "waiting"` with a fresh open SLA timer for `waiting` (`workflow_timers`: one open row, `state "waiting"`).
  2. **danger flags and never auto-clears** — `{ ...adultOk, sbp: 190 }` → `flags` `[{ sbp, 190, max, 180 }]`; encounter `dangerFlagged true`; queue entry `danger true`; one `vitals.danger_flagged` with payload `toMatchObject({ flags: [{ vital: "sbp", value: 190, bound: "max", limit: 180 }], tokenNo: 1 })`; a second, normal recording (`adultOk`, `MON + 5m`) → a second vitals row with `dangerFlags []`, encounter still `dangerFlagged true`, entry still `danger true`, no second transition (instance still `waiting`, one `waiting` timer only), two `vitals.recorded` in total.
  3. **incomplete writes nothing** — `{ ...adultOk, weightKg: undefined }` → rejects `vitals_incomplete` with `detail.missing` `["weightKg"]`; zero vitals rows, zero OPD events besides the open pair, encounter still `registered`.
  4. **pediatric band + weight context** — on the 3-year-old: `{ heightCm: 92, weightKg: 14, tempC: 37.2, spo2: 98, pulse: 155 }` → `band "child_1_5"`, `ageYearsAtRecord 3`, `flags` `[{ pulse, 155, max, 150 }]`; without `weightKg` → `vitals_incomplete` `["weightKg"]`.
  5. **gates** — `spo2: 101` → `invalid_vitals` (nothing written); a `front_office` actor on a `registered` encounter → a `WorkflowError` `role_denied` and NOTHING written (the move runs before the insert); on an `abandoned` encounter → `encounter_state_conflict`.

  `vitals.ts`:

```ts
export type VitalsRow = typeof opdVitals.$inferSelect;
export async function recordVitals(db: Db, actor: Actor, encounterId: string, input: VitalsInput, now: Date = new Date()): Promise<{ vitals: VitalsRow; flags: DangerFlag[]; encounter: EncounterRow }>
export async function listVitals(db: Db, encounterId: string): Promise<VitalsRow[]>   // recorded_at asc
```
`recordVitals`: user actor; `validateVitalsRanges`; `enc = getEncounter(db, id)` (`unknown_encounter`); status ∈ {`registered`, `waiting`} else `encounter_state_conflict`; `cfg = loadOpdConfig(db)`; `[summary] = getPatientSummaries(db, actor, [enc.patientId])`, `ageYears = summary?.dob ? ageYearsAt(summary.dob, now) : null`; `band = bandFor(ageYears, cfg.dangerRanges)`; `missing = missingRequired(...)` ⇒ `vitals_incomplete` with `detail: { missing }`; `flags = evaluateVitals(input, band)`; then in ONE tx, in this order: (1) if `enc.status === "registered"`: `moveEncounter(tx, actor, enc, "waiting", {}, now)` — the role check fails here before anything is written — and `UPDATE opd_queue_entries SET status='waiting', eligible_at=now WHERE encounter_id=? AND status='waiting_vitals'`; (2) insert the vitals row; (3) if `flags.length > 0`: `UPDATE opd_encounters SET danger_flagged = true WHERE id = ?` (not a status write — the mirror rule stands), `UPDATE opd_queue_entries SET danger = true WHERE encounter_id = ? AND status IN ('waiting_vitals','waiting','called')`, append `vitals.danger_flagged`; (4) append `vitals.recorded`. Both events carry the doctor-day `where` fields read from the encounter's latest queue entry (`ORDER BY seq DESC LIMIT 1`) and its session, `patientId`, `encounterId`, `correlationId`.

- [ ] **Step 3: The seed script** — `apps/core/scripts/seed-opd.ts` (the `seed-registration.ts` shape; idempotent; NEVER overwrites an existing config row — an edited config is owner data):

```ts
import { createDb } from "../src/kernel/db/client";
import { opdConfig, opdDepartments, roles } from "../src/kernel/db/schema";
import { requireEnv } from "../src/kernel/config";
import { newId } from "@hmis/contracts";
import {
  DEFAULT_DANGER_RANGES, DEFAULT_DEPARTMENTS, DEFAULT_FOLLOW_UP_EXTENSION_DAYS, DEFAULT_LETTERHEAD, OPD_ROLE_KEYS,
} from "../src/modules/opd/config";

/**
 * Seeds the OPD config row (defaults — owner-revised at UAT), the role KEYS the opd_visit definition names, and the
 * placeholder department list. Idempotent: existing rows are left alone. Usage: pnpm --filter @hmis/core seed:opd
 * Grants NOTHING and assigns NOBODY — role grants are the owner's policy (README runbook).
 */
async function main(): Promise<void> {
  const { db, pool } = createDb(requireEnv("DATABASE_URL"));
  try {
    const cfg = await db.insert(opdConfig).values({
      id: "main", followUpExtensionDays: DEFAULT_FOLLOW_UP_EXTENSION_DAYS, dangerRanges: DEFAULT_DANGER_RANGES,
      letterhead: DEFAULT_LETTERHEAD, updatedBy: "seed",
    }).onConflictDoNothing().returning({ id: opdConfig.id });
    console.log(cfg.length === 1 ? "opd_config seeded (defaults)" : "opd_config exists — left untouched");
    for (const r of OPD_ROLE_KEYS) await db.insert(roles).values({ key: r.key, title: r.title }).onConflictDoNothing();
    console.log(`roles ensured: ${OPD_ROLE_KEYS.map((r) => r.key).join(", ")}`);
    let added = 0;
    for (const d of DEFAULT_DEPARTMENTS) {
      const r = await db.insert(opdDepartments).values({ id: newId(), code: d.code, name: d.name, createdBy: "seed", updatedBy: "seed" }).onConflictDoNothing().returning({ id: opdDepartments.id });
      added += r.length;
    }
    console.log(`departments: ${added} added, ${DEFAULT_DEPARTMENTS.length - added} already present`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```
Add `"seed:opd": "tsx scripts/seed-opd.ts"` to `apps/core/package.json` scripts. Run it ONCE against the dev database on the server (`pnpm --filter @hmis/core seed:opd`) and quote its three output lines; run it a second time and quote "left untouched" / "0 added" — idempotency proven by execution (verify-by-execution flag ⑤). (`onConflictDoNothing` on `opd_departments` conflicts on the `code` unique index; on `roles` on the primary key.)

- [ ] **Step 4: Mutants (tripwire 21).** **V1** `vitals-rules.mutantV1.ts` — `value >= r.max` → the `sbp: 180 → []` assertion → predicted DIED. **V2** `bandFor` with `<=` → age 6 → `child_1_5` → predicted DIED. **V3** `vitals.mutantV3.ts` — a copy of `recordVitals` that skips the queue-entry `danger = true` update → test 2's entry assertion → predicted DIED. 3× each; delete before counting.
- [ ] **Step 5: Run to pass.** `vitals-rules.test` **4**, `vitals.test` **5**, `purity.test` still 1 (now over five files). Workspace **84 suites / 483 tests**. Detached `pnpm verify`.
- [ ] **Step 6: Commit** — `feat(core): OPD vitals — age-banded danger rules, recording with flags and the registered→waiting move; seed:opd` → pull --rebase → push.

**Acceptance criteria:**
1. `vitals-rules.test` 4/4 with the hand-derived flags (inclusive bounds proven at 180/39.5), `vitals.test` 5/5; every red-first run quoted (§2.8 fallback).
2. Test 5 shows `role_denied` with ZERO vitals rows written (the move precedes the insert); test 3 shows `vitals_incomplete` with `detail.missing = ["weightKg"]` and nothing written.
3. `seed:opd` executed twice on the dev DB with both outputs quoted; the script never updates an existing `opd_config` row (code reads `onConflictDoNothing`, no `onConflictDoUpdate`).
4. Mutants V1–V3 DIED (3/3 each); scratch deleted; `purity.test` covers five files.
5. Workspace 84 / 483; verify green; clean tree. **Pipeline A ends here.**

---

### Task 7: Consultation and the e-Rx — start / note / complete (follow-up window + extension cap, outcomes), prescriptions with the allergy hard-warning, FHIR-shaped document, signed QR + verification, print data  *(opus coder — clinical semantics + a version race)*

**Files:**
- Create: `apps/core/src/modules/opd/fhir.ts`, `apps/core/src/modules/opd/fhir.test.ts`
- Create: `apps/core/src/modules/opd/consultation.ts`, `apps/core/src/modules/opd/consultation.test.ts`
- Create: `apps/core/src/modules/opd/prescriptions.ts`, `apps/core/src/modules/opd/prescriptions.test.ts`
- Modify: `apps/core/src/modules/patients/index.ts` (+2 lines: `export { listAllergies } from "./allergies"; export type { AllergyRow } from "./allergies";`)
- Modify: `apps/core/src/modules/opd/purity.test.ts` (add `"fhir.ts"`)

- [ ] **Step 1: FHIR-shaped document (pure, red-first)** — `fhir.test.ts`: one exact-object test for a two-line prescription with a diagnosis + ICD-10, one for "no diagnosis → no Condition entry, no substitution → no `substitution` key". Expected object for the first (hand-written; `ISSUED = "2026-08-17T05:12:00.000Z"`):

```ts
{
  resourceType: "Bundle", type: "document", id: "RX1", timestamp: ISSUED,
  entry: [
    { resource: { resourceType: "Composition", status: "final", type: { text: "Prescription" }, date: ISSUED,
        subject: { reference: "Patient/P1" }, author: [{ reference: "Practitioner/DOC1" }], encounter: { reference: "Encounter/E1" },
        title: "OPD prescription v1" } },
    { resource: { resourceType: "Condition", subject: { reference: "Patient/P1" }, encounter: { reference: "Encounter/E1" },
        code: { text: "Acute pharyngitis", coding: [{ system: "http://hl7.org/fhir/sid/icd-10", code: "J02.9" }] } } },
    { resource: { resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: ISSUED,
        subject: { reference: "Patient/P1" }, encounter: { reference: "Encounter/E1" }, requester: { reference: "Practitioner/DOC1" },
        medicationCodeableConcept: { text: "Tab Paracetamol 500 mg" },
        dosageInstruction: [{ text: "1 tab · TDS · oral · 5 days", route: { text: "oral" }, timing: { code: { text: "TDS" }, repeat: { boundsDuration: { value: 5, unit: "d" } } } }],
        note: [{ text: "after food" }] } },
    { resource: { resourceType: "MedicationRequest", status: "active", intent: "order", authoredOn: ISSUED,
        subject: { reference: "Patient/P1" }, encounter: { reference: "Encounter/E1" }, requester: { reference: "Practitioner/DOC1" },
        medicationCodeableConcept: { text: "Syp Cetirizine" },
        dosageInstruction: [{ text: "5 ml · HS · oral", route: { text: "oral" }, timing: { code: { text: "HS" } } }],
        substitution: { allowedBoolean: false } } },
  ],
}
```
for `toFhirBundle({ prescriptionId: "RX1", version: 1, encounterId: "E1", patientId: "P1", doctorId: "DOC1", issuedAt: new Date(ISSUED), diagnosis: "Acute pharyngitis", icd10Code: "J02.9", lines: [ { drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS", durationDays: 5, instructions: "after food", noSubstitution: false }, { drug: "Syp Cetirizine", dose: "5 ml", route: "oral", frequency: "HS", durationDays: null, instructions: null, noSubstitution: true } ] })`. `fhir.ts` exports `RxLine`, `FhirBundle` (a structural type: `{ resourceType: "Bundle"; type: "document"; id: string; timestamp: string; entry: { resource: Record<string, unknown> }[] }`) and `toFhirBundle(...)`; the dosage `text` joins the present parts with ` · ` in the order dose · frequency · route · `${durationDays} days`; keys with no value are OMITTED (not `undefined` — `toEqual` treats undefined keys as absent, but the stored JSON must not carry nulls where the spec shows absence, so build objects conditionally). Pure: imports nothing.

- [ ] **Step 2: Consultation (red-first)** — `consultation.test.ts` (setup as T3 + `vd`; `MON`; helper `toWaiting(enc)` = `recordVitals(db, vd.actor, enc.id, adultOk, MON)`; `toInConsult(enc)` = `callNext` + `startConsultation`). Eight tests:
  1. **start** — from `waiting` (called or not): `startConsultation(db, dra.actor, enc.id, MON)` → encounter `in_consultation`, `consultStartedAt MON`; the queue entry `in_consult`; one `consultation.started` with `{ encounterId, patientId, departmentId, doctorId, serviceDate, sessionId, roomId, tokenNo }`; a user who is not a doctor (`clerk`) → `not_a_doctor`; **drb** (a doctor, not this patient's) → `not_your_patient`; from `registered` → `encounter_state_conflict`.
  2. **note is saved without a state change** — `saveConsultNote(db, dra.actor, id, { chiefComplaint: "fever 3d", diagnosis: "Acute pharyngitis", icd10Code: "J02.9", advice: "fluids", admissionAdvised: false })` → the columns; status still `in_consultation`; zero new events; on a `waiting` encounter → `encounter_state_conflict`.
  3. **complete with the default window** — `completeConsultation(db, dra.actor, id, { testsOrderedReturnToday: false }, MON2)` (`MON2 = MON + 20 min`) → encounter `{ status: "completed", consultCompletedAt: MON2, followUpDays: 7, followUpExtended: false }`; the queue entry `done` with `doneAt`; the instance `completed`; one `consultation.completed` with payload `toMatchObject({ visitType: "new", followUpDays: 7, followUpExtended: false, admissionAdvised: false, referralIssued: false, prescriptionCount: 0, icd10Code: "J02.9" })`; NO `admission.requested`, NO `referral.issued`; completing again → `encounter_state_conflict`.
  4. **extension: allowed values, evented, capped per doctor per IST month** — `seedOpdBase({ extensionCap: 2 })`; three encounters for dra; complete #1 with `followUpDays: 21` → `followUpExtended true`, event `followUpDays 21, followUpExtended true`; `followUpDays: 10` → `invalid_follow_up_days` (not in `[15,21,30]`; nothing moved); complete #2 with `30` → OK; complete #3 with `15` → `extension_cap_reached` (2 already this month) and the encounter is still `in_consultation`; #3 with the DEFAULT `7` still completes; a completion by **drb** with `15` succeeds (the cap is per doctor); an extension completed at `2026-09-01T05:00Z` (next IST month) by dra succeeds (fresh month).
  5. **outcomes** — note `{ admissionAdvised: true, referralTo: "AIIMS Patna", referralNote: "cardiac eval" }` then complete → one `admission.requested` `{ encounterId, patientId, doctorId, departmentId, note: null }` and one `referral.issued` `{ referralTo: "AIIMS Patna", note: "cardiac eval" }`; `consultation.completed` shows `admissionAdvised true, referralIssued true`.
  6. **tests ordered, return today** — complete with `{ testsOrderedReturnToday: true }` → encounter `awaiting_results`, `consultCompletedAt null`; the queue entry `done`; NO `consultation.completed`; then `reEnterVisit` (T3) → `waiting` with a re-entry row → `startConsultation` again → `in_consultation` (a second `consultation.started`) → complete → `completed`, exactly ONE `consultation.completed`; the visit type of a same-day second OPEN for this patient/department is unaffected (`renewal`/`new` logic untouched — assert a fresh `openVisit` at `MON + 6h` yields `"revisit"` because a completed consult now exists today).
  7. **only the treating doctor** — after E2 transfer to drb (T3 `transferQueue`), `startConsultation` by dra → `not_your_patient`; by drb → OK.
  8. **the completion race** — two concurrent `completeConsultation` (same doctor, defaults) → one fulfilled, the other `encounter_state_conflict`, exactly one `consultation.completed`, one `done` entry.

  `consultation.ts`:

```ts
export type ConsultNote = { chiefComplaint?: string | null; diagnosis?: string | null; icd10Code?: string | null; advice?: string | null; admissionAdvised?: boolean; referralTo?: string | null; referralNote?: string | null };
export async function startConsultation(db: Db, actor: Actor, encounterId: string, now?: Date): Promise<{ encounter: EncounterRow; queueEntry: QueueEntryRow }>
export async function saveConsultNote(db: Db, actor: Actor, encounterId: string, note: ConsultNote, now?: Date): Promise<{ encounter: EncounterRow }>
export async function completeConsultation(db: Db, actor: Actor, encounterId: string, input: { note?: ConsultNote; testsOrderedReturnToday: boolean; followUpDays?: number }, now?: Date): Promise<{ encounter: EncounterRow }>
async function requireTreatingDoctor(db: Db, actor: Actor, encounter: EncounterRow): Promise<DoctorRow>   // not_a_doctor · not_your_patient
```
`completeConsultation` (non-tests path): `followUpDays = input.followUpDays ?? cfg.followUpDefaultDays`; `extended = followUpDays !== cfg.followUpDefaultDays`; extended ⇒ must be in `cfg.followUpExtensionDays` (`invalid_follow_up_days`) and `count(opd_encounters where doctor_id = me and follow_up_extended and consult_completed_at ∈ istMonthBounds(now)) < cfg.extensionCapPerDoctorPerMonth` (`extension_cap_reached`) — the count runs INSIDE the tx after a `SELECT … FOR UPDATE` of the doctor's `opd_doctors` row (serializes a doctor's own completions so the cap cannot be overshot by two simultaneous completions; the doctor row is outside the encounter's write path — §3.28 — and it is cheap: one doctor completes one consult at a time). Then `moveEncounter(→ completed, { consultCompletedAt: now, followUpDays, followUpExtended: extended, ...noteColumns })`, `markDone`, count active prescriptions, append `consultation.completed`, then `admission.requested` if `admissionAdvised`, `referral.issued` if `referralTo`. Tests-ordered path: `moveEncounter(→ awaiting_results, note columns)`, `markDone`, no completion event.

- [ ] **Step 3: Prescriptions (red-first)** — `prescriptions.test.ts` (setup as above; a patient with an ACTIVE allergy `"Penicillin"` recorded via `POST`-equivalent `addAllergy`… — `addAllergy` is NOT exported from the patients index; record it through the patients module's `registerPatient`? No — allergies have no registration path. Use `db.insert(patientAllergies)` directly in the test (the storage shape; disclosed test shaping) or better: since the e2e (T10) covers `POST /patients/:id/allergies`, the unit test inserts the row directly.) Seven tests:
  1. **issue v1** — two lines, no allergies → `{ prescriptionId, version: 1, qrPayload }` with `qrPayload` matching `/^rx1\.[0-9A-Z]{26}\.[0-9A-Z]{26}\.1\.[A-Za-z0-9_-]{43}$/`; the row `{ status: "active", version: 1, allergyOverrides: [] }`; `document` equals `toFhirBundle(...)` for the same input (deep-equal); one `prescription.issued` `{ version: 1, lineCount: 2, allergyOverrideCount: 0 }`; empty lines → `empty_prescription`; a line with a blank drug → `empty_prescription`.
  2. **allergy hard-warning** — patient allergic to `"Penicillin"`; lines `[{ drug: "Tab Penicillin V" }, { drug: "Tab Paracetamol" }]` → rejects `allergy_conflict` with `detail.matches` `[{ lineIndex: 0, substance: "Penicillin" }]`, nothing written; with `overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "tolerated previously, benefit outweighs" }]` → issued with `allergyOverrides` stored and `allergyOverrideCount 1`; an override with a blank reason → `override_reason_required`; an override for a line that does not match → ignored (still `allergyOverrideCount 1` counts only matched overrides); matching is case-insensitive and bidirectional: allergy `"sulfa"` matches drug `"Sulfamethoxazole"`, allergy `"Penicillin G"` matches drug `"penicillin"`, allergy `"Penicillin"` does NOT match `"Amoxicillin"`; an `entered_in_error` allergy does not match.
  3. **re-issue supersedes** — v1 then v2 → v1 `superseded`, v2 `active`, `version 2`; `listPrescriptions` (encounter) returns both by version asc.
  4. **the version race** — `Promise.all([issue, issue])` on one encounter → both fulfilled with versions `{1, 2}` (sorted), exactly one `active`, two `prescription.issued` (the `FOR UPDATE` on the encounter row serializes allocation; the mutant below proves it).
  5. **only the treating doctor, only in consultation** — drb → `not_your_patient`; on `waiting` → `encounter_state_conflict`; on `awaiting_results` → `encounter_state_conflict`.
  6. **verify** — a built payload → `{ ok: true, prescription: { id, version: 1, issuedAt, lines }, patient: { uhid, name, restricted: false }, doctor: { displayName: "Dr dra", registrationNo: "BMC/12345" } }`; a tampered signature (last char flipped by a deterministic mapping — the Plan 05 flake is NOT reproduced: replace the LAST character with `"A"` if it is not `"A"`, else `"B"`) → `{ ok: false, reason: "invalid_signature" }` + one `qr.signature_failed` (module `opd`) with `reason invalid_signature` and no `patientId`; a superseded v1 payload after v2 → `stale_version` with `patientId`; a payload for a deleted-looking id (a valid signature over an unknown id is impossible to mint here — build one with `hmacSign` over an unknown id) → `unknown_prescription`; `"garbage"` → `malformed`; a `system` actor → `user_actor_required`.
  7. **print data** — `getPrescriptionPrint(db, dra.actor, id)` → `{ letterhead: { name: "CRK MEDICAL COLLEGE & HOSPITAL", addressLines: [...] }, patient: { uhid, name, ageYears: 30, sex: "female" }, doctor: { displayName, registrationNo, departmentName: "General Medicine" }, encounter: { serviceDate, diagnosis, icd10Code, advice, followUpDays }, vitals: <latest row or null>, lines, qrPayload, version, issuedAt }`.

  `prescriptions.ts`:

```ts
export type RxLine = { drug: string; dose: string; route: string; frequency: string; durationDays: number | null; instructions: string | null; noSubstitution: boolean };
export type AllergyOverride = { lineIndex: number; substance: string; reason: string };
export type AllergyMatch = { lineIndex: number; substance: string };
export function matchAllergies(lines: { drug: string }[], activeSubstances: string[]): AllergyMatch[]   // pure; lower-case, trimmed, includes() either direction
export const RX_QR_PREFIX = "rx1";
export function buildRxQrPayload(cfg: AppConfig, p: { id: string; encounterId: string; version: number }): string   // rx1.<id>.<encounterId>.<version>.<hmac>
export async function issuePrescription(db: Db, actor: Actor, cfg: AppConfig, encounterId: string, input: { lines: RxLine[]; overrides?: AllergyOverride[] }, now?: Date): Promise<{ prescriptionId: string; version: number; qrPayload: string; allergyOverrideCount: number }>
export async function listPrescriptions(db: Db, encounterId: string): Promise<PrescriptionRow[]>   // version asc
export type RxVerifyResult = { ok: true; prescription: { id: string; version: number; issuedAt: Date; lines: RxLine[] }; patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean }; doctor: { displayName: string; registrationNo: string | null } } | { ok: false; reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_prescription" };
export async function verifyPrescriptionQr(db: Db, cfg: AppConfig, actor: Actor, payload: string): Promise<RxVerifyResult>
export type RxPrintData = { letterhead: Letterhead; patient: { uhid: string; name: string | null; alias: string | null; restricted: boolean; ageYears: number | null; sex: string }; doctor: { displayName: string; registrationNo: string | null; departmentName: string | null }; encounter: { id: string; serviceDate: string; diagnosis: string | null; icd10Code: string | null; advice: string | null; followUpDays: number | null; chiefComplaint: string | null }; vitals: VitalsRow | null; lines: RxLine[]; qrPayload: string; version: number; issuedAt: Date };
export async function getPrescriptionPrint(db: Db, actor: Actor, prescriptionId: string): Promise<RxPrintData>
```
`issuePrescription`: `requireTreatingDoctor`; status must be `in_consultation`; lines validated (≥1, non-blank drug/dose/frequency/route — `empty_prescription`); `active = (await listAllergies(db, patientId)).filter(a => a.status === "active")` (the patients-index import — this task adds the export); `matches = matchAllergies(lines, active.map(a => a.substance))`; for each match an override with the same `lineIndex` must exist (`allergy_conflict`, `detail: { matches }`) with `reason.trim().length >= 3` (`override_reason_required`); `matchedOverrides` = overrides whose `lineIndex` is matched; then in ONE tx: `SELECT id FROM opd_encounters WHERE id = ? FOR UPDATE` (the version serializer — the encounter row is not otherwise written by this function, §3.28), `version = coalesce(max(version), 0) + 1`, `UPDATE opd_prescriptions SET status='superseded' WHERE encounter_id=? AND status='active'`, build `document`, insert, append `prescription.issued` (`allergyOverrideCount = matchedOverrides.length`). `verifyPrescriptionQr` mirrors `verifyQrScan` (`qr.ts`): user actor; parts/prefix/regex → `malformed`; `hmacVerify` → `invalid_signature` (no patientId evented); load → `unknown_prescription` (patientId unknown → not evented); `version` mismatch or `status !== "active"` → `stale_version` (patientId evented); each failure appends `qr.signature_failed` in its OWN transaction via `withTx`.

- [ ] **Step 4: Mutants (tripwire 21).** **F1** `prescriptions.mutantF1.ts` — `matchAllergies` in ONE direction only (`drug.includes(substance)`) → the `"Penicillin G"` vs `"penicillin"` assertion → predicted DIED. **C1** `consultation.mutantC1.ts` — the cap count deleted → test 4's `extension_cap_reached` → predicted DIED. **C2** — `requireTreatingDoctor` returns without the `doctorId` comparison → tests 1/7 `not_your_patient` → predicted DIED. **P1** `prescriptions.mutantP1.ts` — `issuePrescription` without the `FOR UPDATE` → test 4's race: both allocate `version 1` → the unique index rejects one insert with a raw `23505` → `Promise.all` rejects → predicted DIED-likely; **measure 10×, report the rate** (§3.22). **F2** `fhir.mutantF2.ts` — `Condition` entry emitted even when both diagnosis and icd10Code are null → the second fhir test → predicted DIED. **P2** `prescriptions.mutantP2.ts` — the supersede UPDATE (`status='superseded'` on the previous active row) dropped → prescriptions test 6's `stale_version` for v1 after v2 (v1 would verify `ok:true`) → predicted DIED. Delete before counting.
- [ ] **Step 5: Run to pass.** `fhir.test` **2**, `consultation.test` **8**, `prescriptions.test` **7**, `purity.test` still 1 (six files). Workspace **87 suites / 500 tests**. Detached `pnpm verify`.
- [ ] **Step 6: Commit** — `feat(core): OPD consultation and e-Rx — start/note/complete with follow-up extension cap and outcomes, prescriptions with allergy hard-warning, FHIR document, signed QR verify, print data` → pull --rebase → push.

**Acceptance criteria:**
1. All 17 new tests green; the FHIR bundle equals the hand-written object byte-for-byte on `toEqual`; every red-first run quoted (§2.8 fallback).
2. Test 4 (consultation) shows the cap enforced per doctor per IST month exactly as written (2 allowed, third refused, other doctor allowed, next month allowed); test 8's race and prescriptions test 4's race each show the invariant on every path.
3. `modules/patients/index.ts` gained exactly the two allergies lines; `listAllergies` is imported in `prescriptions.ts` from `../patients` (index) only.
4. Mutants F1, F2, P2, C1, C2 DIED (3/3); P1's observed rate over 10 runs reported honestly.
5. `verifyPrescriptionQr` appends `qr.signature_failed` with `module = "opd"` (asserted from the `events` row) and returns HTTP-200-shaped results (no throw on failure paths).
6. Workspace 87 / 500; verify green; clean tree.

---

### Task 8: Realtime kernel — the per-process event tail and the WebSocket gateway; the OPD topic router  *(opus coder — new kernel infrastructure, first backend runtime dependency since Plan 01, multi-process correctness)*

**Files:**
- Modify: `apps/core/package.json` (dependency `ws` ^8.18.0; devDependency `@types/ws` ^8.5.13), `pnpm-lock.yaml`
- Create: `apps/core/src/kernel/realtime/tail.ts`, `apps/core/src/kernel/realtime/tail.test.ts`
- Create: `apps/core/src/kernel/realtime/gateway.ts`, `apps/core/src/kernel/realtime/gateway.test.ts`
- Create: `apps/core/src/kernel/realtime/realtime.module.ts`
- Modify: `apps/core/src/app.module.ts` (import + register `RealtimeModule`)
- Create: `apps/core/src/modules/opd/realtime.ts`, `apps/core/src/modules/opd/realtime.test.ts` (the pure topic router — registered by `OpdModule` in T9)

- [ ] **Step 1: Install** — `cd /opt/hmis && pnpm --filter @hmis/core add ws@^8.18.0 && pnpm --filter @hmis/core add -D @types/ws@^8.5.13` (network — infra events are not defects). `ws` declares `bufferutil`/`utf-8-validate` as OPTIONAL peer deps — not installed, not needed; pnpm 10's denied build scripts are unaffected (verify-by-execution flag ⑥: the gateway suite connecting a real socket IS the proof). Commit both package files (tripwire 12).

- [ ] **Step 2: The tail (red-first)** — `tail.test.ts` (uses `setupTestDb`, `truncateAll`, `appendEvent`, `withTx`, plus a RAW `pg` client from a SECOND `createDb(workerUrl)` pool for the "another process" and "uncommitted lower seq" cases; `poll()` is called by hand — no timers in tests):

  1. **historical events are not replayed; new ones are delivered once** — append 3 events (`opd` names) BEFORE `tail.start()`; `start()`; `poll()` → 0 delivered; append 2 → `poll()` → 2, in seq order, each `{ seq, eventId, name, occurredAt, patientId, encounterId, payload }`; `poll()` again → 0.
  2. **name filter** — `names: () => ["queue.called"]`; append `queue.called` + `visit.opened` → `poll()` → 1 (`queue.called` only).
  3. **look-back delivers a lower seq that commits later (the out-of-order-commit case)** — pool B `BEGIN`; insert an event row (raw SQL, name `queue.called`) — seq N allocated, NOT committed; through `db` append + commit another (seq N+1); `poll()` → delivers N+1 (cursor = N+1); pool B `COMMIT`; `poll()` → delivers N (seq < cursor, inside the window); `poll()` → 0 (dedupe).
  4. **restart identity resets the cursor** — after some deliveries, `truncate table events restart identity` (what `truncateAll` does); append 1 → `poll()` → 1 (the new seq 1 is delivered although the cursor was higher).
  5. **two tails, two pools, one event** — `tailA` on `db`, `tailB` on pool B's `db` → append via `db` → both `poll()`s deliver it (the multi-process claim: fan-out reads the table, never a process-local bus).
  6. **listener errors do not stop delivery; unsubscribe works** — a throwing listener + a good one → the good one still receives; after `off()` nothing arrives.

  `tail.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

export type TailedEvent = { seq: number; eventId: string; name: string; occurredAt: Date; patientId: string | null; encounterId: string | null; payload: unknown };
export type TailListener = (e: TailedEvent) => void;

/**
 * A PER-PROCESS tail over events.seq — the realtime fan-out's only source of truth (spec §4: the event log is the spine;
 * roadmap: WebSocket fan-out reads events, never in-memory single-process state). Every process runs its own tail against
 * the shared table, so an event appended by ANY process reaches EVERY process's sockets. Not the dispatcher (whose cursor is
 * shared and claims each event once) — this is a read-only cursor: floor = max(seq) at start (history is never replayed);
 * each poll reads seq > max(floor, cursor − lookback) so a row whose seq was allocated earlier but committed later (the
 * out-of-order-commit window dispatcher.ts does not defend against) is still delivered; a bounded `seen` set dedupes.
 * If max(seq) ever drops below the cursor (test truncation with RESTART IDENTITY) the cursor resets. The timer is unref()'d.
 * Deliveries are hints: subscribing screens also poll their read models every 15 s.
 */
export class EventTail {
  private cursor = 0;
  private floor = 0;
  private started = false;
  private polling = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<number>();
  private readonly listeners = new Set<TailListener>();

  constructor(
    private readonly db: Db,
    private readonly names: () => string[],
    private readonly opts: { intervalMs: number; lookback: number; batch: number } = { intervalMs: 300, lookback: 500, batch: 1000 },
  ) {}

  on(l: TailListener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  private async maxSeq(): Promise<number> {
    const rows = (await this.db.execute(sql`select coalesce(max(seq), 0)::bigint as m from events`)).rows as [{ m: number | string }];
    return Number(rows[0]!.m);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.floor = await this.maxSeq();
    this.cursor = this.floor;
    this.timer = setInterval(() => { void this.poll(); }, this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** One tick. Exported for tests and callable while a scheduled tick is in flight (re-entrancy guarded). Returns deliveries. */
  async poll(): Promise<number> {
    if (this.polling) return 0;
    this.polling = true;
    try {
      const names = this.names();
      if (names.length === 0) return 0;
      const m = await this.maxSeq();
      if (m < this.cursor) { this.cursor = 0; this.floor = 0; this.seen.clear(); } // sequence restarted (tests) — deliver from the beginning
      const from = Math.max(this.floor, this.cursor - this.opts.lookback);
      const rows = (await this.db.execute(sql`
        select seq, event_id as "eventId", name, occurred_at as "occurredAt", patient_id as "patientId",
               encounter_id as "encounterId", payload
        from events
        where seq > ${from} and name = any(${sql.param(names)}::text[])
        order by seq asc
        limit ${this.opts.batch}
      `)).rows as unknown as (Omit<TailedEvent, "seq" | "occurredAt"> & { seq: number | string; occurredAt: Date | string })[];
      let delivered = 0;
      for (const r of rows) {
        const seq = Number(r.seq);
        if (this.seen.has(seq)) continue;
        this.seen.add(seq);
        if (seq > this.cursor) this.cursor = seq;
        const e: TailedEvent = { seq, eventId: r.eventId, name: r.name, occurredAt: new Date(r.occurredAt), patientId: r.patientId, encounterId: r.encounterId, payload: r.payload };
        for (const l of this.listeners) { try { l(e); } catch { /* a listener's failure is its own */ } }
        delivered += 1;
      }
      const prune = this.cursor - this.opts.lookback;
      for (const s of this.seen) if (s <= prune) this.seen.delete(s);
      return delivered;
    } finally {
      this.polling = false;
    }
  }
}
```
Verify-by-execution flag ⑦: `name = any($1::text[])` binding — the same shape `dispatcher.ts:26` uses (`sql.param(names)`), proven by tests 2 and 5.

- [ ] **Step 3: The gateway (red-first)** — `gateway.test.ts` boots a Nest app (`Test.createTestingModule({ imports: [AppModule] })` exactly like the e2e suites, `createNestApplication<NestExpressApplication>({ bodyParser: false })`, `configureApp`, then **`await app.listen(0)`** and read the port from `app.getHttpServer().address()`), obtains `RealtimeGateway` from the app (`app.get(RealtimeGateway)`), registers a TEST router `{ names: ["patient.registered", "queue.called"], topicsFor: (e) => [`t:${(e.payload as { patientId?: string }).patientId ?? "x"}`] }` and a topic space `{ prefix: "t", permission: "patients.read" }`, and connects `new WebSocket(`ws://127.0.0.1:${port}/ws`)` from the `ws` package. A `waitFor(ws, pred, ms = 3000)` helper collects JSON messages. Users: `reader` (role with `patients.read`), `rando` (no roles). Seven tests:
  1. a `subscribe` before `auth` → `{ type: "error", code: "unauthorized" }`; a bad token → `{ type: "error", code: "unauthorized" }` and the socket closes.
  2. auth with `reader`'s token → `{ type: "authed", userId }`; `subscribe ["t:p1"]` → `{ type: "subscribed", topics: ["t:p1"] }`; `subscribe ["zzz:1"]` (no space) → `{ type: "error", code: "forbidden_topic", topics: ["zzz:1"] }`.
  3. `rando` authed, `subscribe ["t:p1"]` → `forbidden_topic` (no `patients.read`).
  4. **an event reaches the subscriber** — reader subscribed to `t:p1`; `appendEvent` (via `db`) a `patient.registered` with `payload.patientId "p1"` → within 3 s a `{ type: "event", topic: "t:p1", name: "patient.registered", seq, occurredAt, payload }` arrives; an event for `p2` does not.
  5. **another process** — the same event appended through pool B (a second `createDb`) → still arrives (the tail reads the table).
  6. `unsubscribe ["t:p1"]` → `{ type: "unsubscribed" }` and a later `p1` event does not arrive; `ping` → `pong`.
  7. an unparseable frame → `{ type: "error", code: "bad_message" }`; the socket stays open.
  Auth timeout: construct-time option `authTimeoutMs` (default 5000) — the test module overrides via `gateway.configure({ authTimeoutMs: 300 })` before connecting; a socket that never authenticates is closed after it (test 1b).

  `gateway.ts` (exact structure; bodies as described):

```ts
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { DB } from "../tokens";
import { findLiveSession } from "../auth/sessions";
import { hasPermission } from "../auth/permissions";
import { EventTail } from "./tail";
import type { TailedEvent } from "./tail";
import type { Db } from "../db/client";

export type TopicRouter = { names: string[]; topicsFor: (e: TailedEvent) => string[] };
export type TopicSpace = { prefix: string; permission: string };
export const REALTIME_PATH = "/ws";

type ClientState = { userId: string | null; topics: Set<string>; authTimer: NodeJS.Timeout | null };
type Inbound =
  | { type: "auth"; token: string } | { type: "subscribe"; topics: string[] } | { type: "unsubscribe"; topics: string[] } | { type: "ping" };

/**
 * WebSocket fan-out (spec §5 realtime; §3 topology). Auth = the same bearer session HTTP uses, sent as the FIRST frame
 * (never in the URL — proxies log query strings). Topics are namespaced by a registered prefix, each with a permission
 * checked per subscribe via hasPermission (agents hold no permissions — Plan 02 seam — so agent tokens cannot subscribe).
 * Fan-out source = EventTail (per process, reads events.seq) — never an in-process emitter. Modules register routers and
 * topic spaces at their own module init; the kernel knows no module.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly routers: TopicRouter[] = [];
  private readonly spaces = new Map<string, TopicSpace>();
  private readonly clients = new Map<WebSocket, ClientState>();
  private wss: WebSocketServer | null = null;
  private tail: EventTail | null = null;
  private authTimeoutMs = 5000;

  constructor(@Inject(DB) private readonly db: Db, private readonly adapterHost: HttpAdapterHost) {}

  configure(opts: { authTimeoutMs?: number }): void { if (opts.authTimeoutMs !== undefined) this.authTimeoutMs = opts.authTimeoutMs; }
  registerRouter(r: TopicRouter): void { this.routers.push(r); }
  registerTopicSpace(s: TopicSpace): void { this.spaces.set(s.prefix, s); }
  /** Union of every router's names — the tail's filter, re-read on each poll so late registrations count. */
  names(): string[] { return [...new Set(this.routers.flatMap((r) => r.names))]; }

  async onApplicationBootstrap(): Promise<void> {
    const server = this.adapterHost.httpAdapter.getHttpServer() as import("node:http").Server;
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname !== REALTIME_PATH) { socket.destroy(); return; }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    this.tail = new EventTail(this.db, () => this.names());
    this.tail.on((e) => this.fanOut(e));
    await this.tail.start();
  }

  onApplicationShutdown(): void {
    this.tail?.stop();
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    this.wss?.close();
  }

  private accept(ws: WebSocket): void { /* register ClientState, arm authTimer (close 4001 on expiry), wire message/close handlers */ }
  private async onMessage(ws: WebSocket, raw: WebSocket.RawData): Promise<void> { /* parse → Inbound; bad_message on failure; dispatch */ }
  private async auth(ws: WebSocket, st: ClientState, token: string): Promise<void> { /* findLiveSession → authed | error unauthorized + close(4001) */ }
  private async subscribe(ws: WebSocket, st: ClientState, topics: string[]): Promise<void> { /* unauthorized if !userId; per topic: prefix = topic.split(":")[0]; space or forbidden_topic; hasPermission(db, userId, space.permission, "hospital") or forbidden_topic; add; reply subscribed | error{topics} */ }
  private fanOut(e: TailedEvent): void {
    const topics = new Set(this.routers.filter((r) => r.names.includes(e.name)).flatMap((r) => r.topicsFor(e)));
    if (topics.size === 0) return;
    for (const [ws, st] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      for (const t of topics) if (st.topics.has(t)) ws.send(JSON.stringify({ type: "event", topic: t, name: e.name, seq: e.seq, occurredAt: e.occurredAt.toISOString(), payload: e.payload }));
    }
  }
}
```
Wire protocol (documented in README by T10): client → `{"type":"auth","token"}` · `{"type":"subscribe","topics":[…]}` · `{"type":"unsubscribe","topics":[…]}` · `{"type":"ping"}`; server → `{"type":"authed","userId"}` · `{"type":"subscribed","topics"}` · `{"type":"unsubscribed","topics"}` · `{"type":"event","topic","name","seq","occurredAt","payload"}` · `{"type":"pong"}` · `{"type":"error","code":"unauthorized"|"forbidden_topic"|"bad_message"|"auth_timeout","topics"?}`. `realtime.module.ts`: `@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] }) export class RealtimeModule {}`; `app.module.ts` adds `RealtimeModule` to `imports` (one import line + one array entry — nothing else).

  **§3.6 audit (a boot-time DB call):** `onApplicationBootstrap` runs `EventTail.start()` = one `select max(seq) from events` per app boot, and one small query every 300 ms while running. Every shipped e2e suite boots `AppModule` against its per-worker database, which IS migrated (`setupTestDb`); the only suite pointed elsewhere was `health.e2e.test.ts` and Plan 02 T8 already re-wired it — RE-VERIFY by grepping every `test/*.e2e.test.ts` for how `DATABASE_URL` is set before `AppModule` compiles (all use the worker URL pattern of `patients.e2e.test.ts:37-39`). If any suite still boots against an unmigrated database, that suite fails at boot with `relation "events" does not exist` — that would be a **HALT and report**, never a `try/catch` around the tail (a loud failure on missing schema is the point).

- [ ] **Step 4: The OPD topic router (pure, red-first)** — `modules/opd/realtime.test.ts`: `opdTopicsFor({ name: "queue.called", payload: { doctorId: "D", serviceDate: "2026-08-17", roomId: "R", encounterId: "E", … } })` → `["queue:D:2026-08-17", "display:R", "encounter:E"]` (order as listed); `roomId: null` → no `display:` topic; `visit.transferred` payload `{ fromDoctorId: "A", toDoctorId: "B", serviceDate, roomId: "R2", encounterId: "E" }` → `["queue:A:2026-08-17", "queue:B:2026-08-17", "display:R2", "encounter:E"]`; a payload with no ids → `[]`. `modules/opd/realtime.ts`:

```ts
import type { TailedEvent } from "../../kernel/realtime/tail";
import type { TopicRouter, TopicSpace } from "../../kernel/realtime/gateway";

export const OPD_TOPIC_SPACES: TopicSpace[] = [
  { prefix: "queue", permission: "opd.queue.read" },      // queue:<doctorId>:<serviceDate>
  { prefix: "display", permission: "opd.display.read" },  // display:<roomId>
  { prefix: "encounter", permission: "opd.visits.read" }, // encounter:<encounterId>
];
export const OPD_REALTIME_NAMES = [
  "queue.called", "queue.skipped", "patient.checked_in", "visit.opened", "visit.abandoned", "visit.transferred",
  "vitals.recorded", "vitals.danger_flagged", "consultation.started", "consultation.completed",
];
type P = { doctorId?: string; fromDoctorId?: string; toDoctorId?: string; serviceDate?: string; roomId?: string | null; encounterId?: string };

export function opdTopicsFor(e: Pick<TailedEvent, "name" | "payload">): string[] {
  const p = (e.payload ?? {}) as P;
  const out: string[] = [];
  if (p.serviceDate) {
    if (p.doctorId) out.push(`queue:${p.doctorId}:${p.serviceDate}`);
    if (p.fromDoctorId) out.push(`queue:${p.fromDoctorId}:${p.serviceDate}`);
    if (p.toDoctorId) out.push(`queue:${p.toDoctorId}:${p.serviceDate}`);
  }
  if (p.roomId) out.push(`display:${p.roomId}`);
  if (p.encounterId) out.push(`encounter:${p.encounterId}`);
  return out;
}
export const opdTopicRouter: TopicRouter = { names: OPD_REALTIME_NAMES, topicsFor: opdTopicsFor };
```

- [ ] **Step 5: Mutants (tripwire 21).** **T1** `tail.mutantT1.ts` — `from = this.cursor` (look-back removed) → tail test 3 → predicted DIED (the late-committed N is never delivered). **T2** — the `seen` dedupe removed → tail test 3's final `poll() → 0` → predicted DIED (N+1 re-delivered inside the window). **G1** `gateway.mutantG1.ts` — fan-out wired to an in-process `EventEmitter` fed by a patched `appendEvent`-side hook instead of the tail (approximation: the mutant gateway's `fanOut` is invoked only from a local emitter the test triggers on ITS `db` appends) → gateway test 5 (pool B) → predicted DIED. Explain the approximation in the report (ledger 06.2 §5.5 precedent — declared approximations are acceptable). **G2** — `subscribe` without the `hasPermission` check → gateway test 3 → predicted DIED. **R1** `realtime.mutantR1.ts` — `visit.transferred` maps only `doctorId` (drops from/to) → the router test → predicted DIED. 3× each; delete before counting.
- [ ] **Step 6: Run to pass.** `tail.test` **6**, `gateway.test` **7** (incl. 1b), `opd/realtime.test` **4**. Workspace **90 suites / 517 tests**. Detached `pnpm verify` — and note the runtime: the gateway suite listens on an ephemeral port; a leaked interval would hang jest — `app.close()` in `afterAll` must return (flag ⑧: the suite exits without `--forceExit`; if jest reports open handles, that is a defect in `stop()`, not something to silence).
- [ ] **Step 7: Commit** — `feat(core): realtime kernel — per-process event tail with look-back, ws gateway with bearer auth and permissioned topics; OPD topic router` → pull --rebase → push.

**Acceptance criteria:**
1. `tail.test` 6/6 including test 3 (a lower seq committed AFTER the cursor advanced is delivered exactly once) and test 5 (two pools); `gateway.test` 7/7 including test 5 (an event appended by another connection reaches the socket) — the multi-process claim executed, not asserted.
2. `ws` and `@types/ws` in `apps/core/package.json` and the lockfile; `apps/core/src/kernel/realtime/` contains exactly the three source files + two tests; `app.module.ts` diff = the `RealtimeModule` import + registration only.
3. Mutants T1, T2, G1 (declared approximation), G2, R1 DIED (3/3 each); scratch deleted.
4. The gateway suite completes without open handles (`pnpm --filter @hmis/core exec jest src/kernel/realtime` exits on its own; the report quotes the run's tail).
5. The §3.6 audit result is stated in the report (every e2e suite boots against a migrated worker DB; none needed a change — or a HALT).
6. Workspace 90 / 517; verify green; clean tree.

---

### Task 9: Module surface — manifest, Nest module + realtime registrar, three controllers (the wire contract), `index.ts`, AppModule, and the first e2e  *(opus coder — first wiring of the module, ~40 routes, the contract every screen consumes)*

**Files:**
- Create: `apps/core/src/modules/opd/manifest.ts`, `apps/core/src/modules/opd/opd.module.ts`, `apps/core/src/modules/opd/index.ts`
- Create: `apps/core/src/modules/opd/opd-masters.controller.ts`, `apps/core/src/modules/opd/opd-visits.controller.ts`, `apps/core/src/modules/opd/opd-queue.controller.ts`
- Modify: `apps/core/src/modules/opd/config.ts` (+ `updateOpdConfig(tx, actor, patch)`), `apps/core/src/modules/opd/config.test.ts` (+1 test)
- Modify: `apps/core/src/app.module.ts` (import `opdManifest`, `OpdModule` from `./modules/opd`; install + import)
- Create: `apps/core/test/opd.e2e.test.ts`

- [ ] **Step 1: Write the failing e2e FIRST** — `test/opd.e2e.test.ts`, bootstrapped exactly like `test/patients.e2e.test.ts:1-70` (registry with all six manifests incl. `opdManifest`; per-worker `DATABASE_URL`; `createNestApplication<NestExpressApplication>({ bodyParser: false })`; `configureApp`; `app.init()`; `beforeEach`: `truncateAll` → `seedSodPairs` → `syncPermissions` → `seedOpdBase` → `activateOpdVisitDefinition` → `seedOpdMasters` → roles: `desk` (grants: `opd.appointments.read/manage`, `opd.visits.read/open`, `opd.queue.read`, `opd.vitals.record`, `patients.register`, `patients.read`), `doc` (`opd.consult`, `opd.queue.read/operate`, `opd.visits.read`, `patients.read`), `sup` (`desk` + `opd.queue.transfer`, `opd.masters.read/manage`, `opd.config.manage`), `disp` (`opd.display.read`), `pharm` (`opd.prescriptions.verify`) — created with `createRole` + `grantPermissionToRole` per permission — and users `clerk` [desk + `front_office`], `vd` [desk + `vitals_desk`], `dra` (via `mkDoctor` + `assignRole doc`), `sup` [sup + `front_office_supervisor`], `disp`, `pharm`, `rando` (no roles), each with a token). It is RED before the controllers exist (404s / TS2305 on `../src/modules/opd`), and that red is quoted. Six tests over HTTP:
  1. **auth + permission edges** — `GET /opd/queues/summary` → 401 without a token, 403 with `rando`; `POST /opd/visits` with `disp` → 403; `GET /opd/definition` with `sup` → 200 and body `toEqual(OPD_VISIT_DEFINITION_JSON)`.
  2. **the walk-in flow** — `POST /patients` (clerk) → patientId; `POST /opd/visits` `{ patientId, departmentId, doctorId }` (clerk) → **201** `{ encounter: { status: "registered", visitType: "new" }, tokenNo: 1, roomId, doctorScheduledToday }`; `GET /opd/queues?doctorId&serviceDate` (clerk) → `waitingVitals 1`, `ordered []`; `POST /opd/visits/:id/vitals` (vd) with `adultOk` → **201** `{ flags: [], encounter: { status: "waiting" } }`; `GET /opd/queues…` → `ordered[0].tokenNo 1`, `ordered[0].patient.uhid` present; `POST /opd/queues/:sessionId/call-next` (dra) → `{ entry: { status: "called", tokenNo: 1 } }`; `POST /opd/visits/:id/consult/start` (dra) → `encounter.status "in_consultation"`; `PUT /opd/visits/:id/consult/note` `{ diagnosis: "Acute pharyngitis", icd10Code: "J02.9" }` → 200; `POST /opd/visits/:id/consult/complete` `{ testsOrderedReturnToday: false }` (dra) → `encounter.status "completed"`, `followUpDays 7`; `GET /opd/patients/:patientId/timeline` (clerk) → 1 item with `doctorName "Dr dra"`.
  3. **e-Rx over HTTP, allergy conflict body shape** — patient with an allergy via `POST /patients/:id/allergies { substance: "Penicillin", source: "registration" }` (clerk); open → vitals → call → start; `POST /opd/visits/:id/prescriptions` `{ lines: [{ drug: "Tab Penicillin V", dose: "500 mg", route: "oral", frequency: "TDS", durationDays: 5, instructions: null, noSubstitution: false }] }` (dra) → **409** with body `{ code: "allergy_conflict", detail: { matches: [{ lineIndex: 0, substance: "Penicillin" }] } }` (the OPD error body carries `code` + `detail` — a deliberate widening over the patients module's message-only bodies, documented); with `overrides: [{ lineIndex: 0, substance: "Penicillin", reason: "tolerated in 2024" }]` → **201** `{ version: 1, qrPayload, allergyOverrideCount: 1 }`; `GET /opd/prescriptions/:id/print` (dra) → `letterhead.name "CRK MEDICAL COLLEGE & HOSPITAL"`, one line, `qrPayload`; `POST /opd/prescriptions/verify { payload }` (pharm) → **200** `{ ok: true, doctor: { displayName: "Dr dra" } }`; the tampered payload → **200** `{ ok: false, reason: "invalid_signature" }`.
  4. **the desk's error contract** — abandon without reason → 400 `{ code: "reason_required" }`; call-next when a token is already called → 409 `{ code: "call_conflict" }`; a second complete → 409 `{ code: "encounter_state_conflict" }`; vitals `{ spo2: 101 }` → 400 `{ code: "invalid_vitals" }`; an unknown encounter → 404 `{ code: "unknown_encounter" }`; `PUT /opd/config` (sup) with an invalid `dangerRanges` → 400 `{ code: "invalid_config" }`; a valid `PUT /opd/config { slotMinutes: 15 }` → 200 and `GET /opd/config` shows 15; `PUT /opd/config` by clerk → 403.
  5. **the public board carries no identity** — two visits, one called; `GET /opd/queues/board?serviceDate=` (disp) → items whose keys are exactly the `BoardItem` set (assert with `Object.keys(...).sort()`), `nowServing 1`, `next [2]`; `disp` calling `GET /opd/queues?doctorId…` → 403.
  6. **route ordering** — `GET /opd/queues/summary`, `GET /opd/queues/board`, `POST /opd/queues/transfer` (sup, `{ …, consented: true, reason }`) and `POST /opd/prescriptions/verify` all resolve to their literal handlers (200/201/409-by-content, never 404 — the literal-before-`:id` rule).

- [ ] **Step 2: Manifest + module + index + AppModule.**

```ts
// manifest.ts
export const opdManifest: ModuleManifest = {
  key: "opd",
  title: "OPD — encounters, appointments, queues, vitals",
  menu: [
    { label: "Appointments", path: "/opd/appointments", permission: "opd.appointments.read" },
    { label: "OPD desk", path: "/opd/desk", permission: "opd.visits.open" },
    { label: "Vitals", path: "/opd/vitals", permission: "opd.vitals.record" },
    { label: "Consultation", path: "/opd/consult", permission: "opd.consult" },
    { label: "Token display", path: "/opd/display", permission: "opd.display.read" },
    { label: "OPD admin", path: "/opd/admin", permission: "opd.masters.manage" },
  ],
  permissions: [
    "opd.masters.read", "opd.masters.manage", "opd.config.manage",
    "opd.appointments.read", "opd.appointments.manage",
    "opd.visits.read", "opd.visits.open", "opd.vitals.record",
    "opd.queue.read", "opd.queue.operate", "opd.queue.transfer",
    "opd.consult", "opd.prescriptions.verify", "opd.display.read",
  ],
  subscriptions: [], // no dispatcher consumers in this plan; realtime rides the gateway's tail
};
```
```ts
// opd.module.ts
@Injectable()
class OpdRealtimeRegistrar implements OnModuleInit {
  constructor(private readonly gateway: RealtimeGateway) {}
  onModuleInit(): void {
    for (const s of OPD_TOPIC_SPACES) this.gateway.registerTopicSpace(s);
    this.gateway.registerRouter(opdTopicRouter);
  }
}
@Module({ imports: [RealtimeModule], controllers: [OpdMastersController, OpdVisitsController, OpdQueueController], providers: [OpdRealtimeRegistrar] })
export class OpdModule {}
```
`index.ts` — the declared interface (Plan 08 will import `getEncounter`, `listVisits`, encounter types and events from here):
```ts
export { opdManifest } from "./manifest";
export { OpdModule } from "./opd.module";
export { OpdError } from "./errors";
export type { OpdErrorCode } from "./errors";
export { OPD_VISIT_DEF_KEY, OPD_VISIT_DEFINITION_JSON, OPD_VISIT_STATES, opdVisitDefinition } from "./workflow-def";
export type { OpdVisitState } from "./workflow-def";
export { getEncounter, getVisit, listVisits, patientTimeline } from "./encounters";
export type { EncounterRow, QueueEntryRow, TimelineItem } from "./encounters";
export { classifyVisit } from "./visit-type";
export type { VisitType } from "./visit-type";
export { loadOpdConfig } from "./config";
export type { OpdConfig } from "./config";
export { orderQueue, nextInQueue, classOf } from "./queue-engine";
export type { QueueEntryState, QueuePolicy, QueueClass } from "./queue-engine";
export * from "./events";
```
(Nothing else is exported — masters/appointments/queue/consultation/prescriptions/vitals services are reached over HTTP only, the Plan 05 pattern.) `app.module.ts`: `import { opdManifest, OpdModule } from "./modules/opd";`, add `OpdModule` to `imports`, `registry.install(opdManifest)` after `tariffManifest` — the existing comment "Later plans install their module manifests here" stays.

- [ ] **Step 3: `updateOpdConfig` (red-first, +1 config test)** — `config.ts` gains:
```ts
export type OpdConfigPatch = Partial<Pick<OpdConfig, "slotMinutes" | "followUpDefaultDays" | "followUpExtensionDays" | "extensionCapPerDoctorPerMonth" | "maxSkipsBeforeLeft" | "perkEveryNth" | "dangerRanges" | "letterhead">>;
export async function updateOpdConfig(tx: Tx, actor: Actor, patch: OpdConfigPatch, now: Date = new Date()): Promise<OpdConfig>
```
user actor; validates `dangerRanges` (`dangerRangesSchema`), `letterhead` (`letterheadSchema`), `followUpExtensionDays` (non-empty positive ints), integers positive (`perkEveryNth` positive or null) → `invalid_config` with the zod issues in `detail`; `UPDATE opd_config SET … , updated_by, updated_at WHERE id = 'main'` (0 rows ⇒ `opd_not_configured`); returns `loadOpdConfig(tx)`. Test: patch `slotMinutes: 15` → 15; an invalid ranges JSON → `invalid_config` and the row unchanged.

- [ ] **Step 4: The controllers — the wire contract.** Every route `@RequirePermission(<permission>, "hospital")`; bodies/queries zod-parsed with the patients `parsed()` helper shape; ONE `toHttp` in a shared file? — no: define `toHttp` ONCE in `opd-masters.controller.ts` and export it for the other two controllers (module-internal import). Error body shape for every OPD error: `{ statusCode, message, code, detail? }` (Nest `HttpException` with an object). Mapping: `OpdError` codes → **404**: `unknown_*`, `patient_not_found` · **409**: `*_state_conflict`, `slot_taken`, `call_conflict`, `doctor_out`, `session_closed`, `doctor_on_leave`, `appointment_not_today`, `extension_cap_reached`, `allergy_conflict`, `user_already_doctor`, `duplicate_*`, `opd_not_configured`, `opd_config_invalid`, `not_your_patient` · everything else **400** (`invalid_*`, `vitals_incomplete`, `reason_required`, `empty_prescription`, `override_reason_required`, `user_actor_required`, `not_a_doctor`, `invalid_transfer`, `invalid_leave_range`, `slot_in_past`, `doctor_department_mismatch`, `department_inactive`, `doctor_inactive`, `leave_not_scheduled`) · `WorkflowError` `role_denied` → **403**, other `WorkflowError` → **409** · `SodViolationError` → 403 · `PatientError` → the patients mapping shape (404 for `patient_not_found`, else 400) · unrecognised rethrows. Routes, exactly:

```
opd-masters.controller.ts   @Controller("opd")
GET    /opd/definition                    opd.masters.read      → OPD_VISIT_DEFINITION_JSON
GET    /opd/config                        opd.masters.read      → OpdConfig
PUT    /opd/config                        opd.config.manage     { …OpdConfigPatch } → OpdConfig
GET    /opd/me/doctor                     opd.consult           → DoctorRow | 404 { code: "not_a_doctor" }
GET    /opd/departments?active=           opd.masters.read      → { items: DepartmentRow[] }
POST   /opd/departments                   opd.masters.manage    { code, name } → { departmentId }                        201
PATCH  /opd/departments/:id               opd.masters.manage    { name?, active? } → { ok: true }
GET    /opd/rooms?active=                 opd.masters.read      → { items: RoomRow[] }
POST   /opd/rooms                         opd.masters.manage    { code, name, floor? } → { roomId }                       201
PATCH  /opd/rooms/:id                     opd.masters.manage    { name?, floor?, active? } → { ok: true }
GET    /opd/doctors?departmentId=&active= opd.masters.read      → { items: DoctorRow[] }
POST   /opd/doctors                       opd.masters.manage    { username, displayName, registrationNo?, departmentId, specialty? } → { doctorId, userId }  201
GET    /opd/doctors/:id                   opd.masters.read      → DoctorRow | 404
PATCH  /opd/doctors/:id                   opd.masters.manage    { displayName?, registrationNo?, departmentId?, specialty?, active? } → { ok: true }
GET    /opd/doctors/:id/schedules         opd.masters.read      → { items: ScheduleRow[] }
PUT    /opd/doctors/:id/schedules         opd.masters.manage    { items: ScheduleInput[] } → { scheduleIds }
GET    /opd/leaves?doctorId=&from=&to=&status=  opd.masters.read → { items: LeaveRow[] }
POST   /opd/leaves                        opd.masters.manage    { doctorId, fromDate, toDate, reason } → { leaveId, affectedAppointmentIds }  201
POST   /opd/leaves/:id/cancel             opd.masters.manage    → { restored }

opd-visits.controller.ts    @Controller("opd")
GET    /opd/slots?doctorId=&date=         opd.appointments.read → { slots: Slot[] }  (Dates serialize as ISO strings)
GET    /opd/appointments?doctorId=&serviceDate=&patientId=&status=&needsRebooking=   opd.appointments.read → { items: (AppointmentRow & { patient: PatientSummary | null })[] }
POST   /opd/appointments                  opd.appointments.manage { patientId, doctorId, slotStart (ISO), source?, note? } → { appointment }  201
POST   /opd/appointments/:id/reschedule   opd.appointments.manage { slotStart, doctorId? } → { from, to }
POST   /opd/appointments/:id/cancel       opd.appointments.manage { reason } → { appointment }
POST   /opd/appointments/:id/check-in     opd.visits.open       → OpenVisitResult
POST   /opd/visits                        opd.visits.open       { patientId, departmentId, doctorId, intendedPayer?, referralSource?, referrerName? } → OpenVisitResult  201
GET    /opd/visits?status=&departmentId=&doctorId=&serviceDate=   opd.visits.read → { items: (EncounterRow & { patient: PatientSummary | null; queueEntry: QueueEntryRow | null })[] }
GET    /opd/visits/:id                    opd.visits.read       → { encounter, queueEntries, vitals, prescriptions, patient }
POST   /opd/visits/:id/abandon            opd.visits.open       { reason } → { encounter }
POST   /opd/visits/:id/re-enter           opd.visits.open       → { encounter, queueEntry }
POST   /opd/visits/:id/vitals             opd.vitals.record     { heightCm?, weightKg?, sbp?, dbp?, pulse?, rr?, spo2?, tempC?, notes? } → { vitals, flags, encounter }  201
GET    /opd/visits/:id/vitals             opd.visits.read       → { items }
GET    /opd/patients/:patientId/timeline  opd.visits.read       → { items: TimelineItem[] }

opd-queue.controller.ts     @Controller("opd")   (literal routes FIRST: summary, board, transfer, prescriptions/verify)
GET    /opd/queues/summary?departmentId=&serviceDate=  opd.queue.read → { items: DoctorSummary[] }
GET    /opd/queues/board?serviceDate=&roomIds=         opd.display.read → { items: BoardItem[] }
POST   /opd/queues/transfer               opd.queue.transfer    { fromDoctorId, toDoctorId, serviceDate, entryIds?, consented, reason } → { transferred, toSessionId }
GET    /opd/queues?doctorId=&serviceDate= opd.queue.read        → QueueView | { session: null }
POST   /opd/queues/:sessionId/call-next   opd.queue.operate     → { entry, encounter }
POST   /opd/queues/:sessionId/status      opd.queue.operate     { status: "in" | "out" | "closed" } → { session }
POST   /opd/queues/entries/:entryId/skip  opd.queue.operate     → { entry }
POST   /opd/visits/:id/consult/start      opd.consult           → { encounter, queueEntry }
PUT    /opd/visits/:id/consult/note       opd.consult           { chiefComplaint?, diagnosis?, icd10Code?, advice?, admissionAdvised?, referralTo?, referralNote? } → { encounter }
POST   /opd/visits/:id/consult/complete   opd.consult           { note?, testsOrderedReturnToday, followUpDays? } → { encounter }
POST   /opd/visits/:id/prescriptions      opd.consult           { lines: RxLine[], overrides?: AllergyOverride[] } → { prescriptionId, version, qrPayload, allergyOverrideCount }  201
GET    /opd/visits/:id/prescriptions      opd.visits.read       → { items }
POST   /opd/prescriptions/verify          opd.prescriptions.verify { payload } → RxVerifyResult   @HttpCode(200) ALWAYS (the qr/verify precedent)
GET    /opd/prescriptions/:id/print       opd.visits.read       → RxPrintData
```
`serviceDate` query params default to `istDate(new Date())` when absent; `slotStart` bodies are `z.coerce.date()` (ISO strings); `roomIds` is comma-separated. Composition rules: `GET /opd/visits*` and `GET /opd/appointments` attach `patient` via ONE `getPatientSummaries(db, actor, ids)` call per request (never per row); `GET /opd/queues` = `listQueue` (already carries summaries).

- [ ] **Step 5: Run to pass.** Isolated: `config.test` 3→4, `opd.e2e` **6**. Workspace **91 suites / 524 tests**. Detached `pnpm verify`.
- [ ] **Step 6: Commit** — `feat(core): OPD module surface — manifest, three controllers (~40 routes), realtime registrar, index; first e2e` → pull --rebase → push.

**Acceptance criteria:**
1. `opd.e2e` 6/6, red-first quoted (404/TS2305 before the module existed — §2.8 fallback applies); the allergy-conflict 409 body carries `code` and `detail.matches`; the board keys assertion holds.
2. `manifest.ts` lists exactly the 14 permissions and 6 menu entries above; `index.ts` exports exactly the block shown; `AppModule` diff = one import line + one `imports` entry + one `registry.install` line.
3. Every route in the table exists with the stated method, path, permission and status (the gate spot-checks ≥ 10 routes against the controllers, including all four literal-before-`:id` cases).
4. `toHttp` is defined ONCE (masters controller) and imported by the other two; the mapping table above is implemented as written (the gate reads it).
5. Workspace 91 / 524; verify green; clean tree.

---

### Task 10: The lifecycle over HTTP + WebSocket, the CI perf gate, and the docs/runbook  *(opus coder — perf seeding SQL is verify-by-execution territory)*

**Files:**
- Create: `apps/core/test/opd-lifecycle.e2e.test.ts`
- Create: `apps/core/test/perf-opd-queue.test.ts`
- Modify: `apps/core/README.md` (an "OPD module (Plan 07)" section + "Go-live runbook — OPD" + "Realtime (WebSocket) protocol")

**This task explicitly owes NO red run** for the e2e and perf suites: they exercise shipped code; the evidence is the green run, the perf numbers, and the Assertion Book rows below.

- [ ] **Step 1: The lifecycle e2e** — bootstrapped like T9's e2e but with **`await app.listen(0)`** (for the socket) and a `ws` client helper. Pin `now` by passing nothing (real clock) — the flow is same-day by construction; use `istDate(new Date())` for query params. One long `it` per leg group (six legs), asserting at every step:
  1. **appointment → check-in** — `PUT /opd/doctors/:id/schedules` (sup) with a template covering TODAY's weekday 00:00–23:50 (`slotMinutes 10`) so a slot always exists; `GET /opd/slots?doctorId&date=today` → ≥ 1 slot; pick the first slot whose `start > now + 20 min` (skip past ones); `POST /opd/appointments` → 201; `POST /opd/appointments/:id/check-in` → `visit.opened` payload `kind "appointment"`; `queueEntry.appointmentAt === slotStart`; queue class 4 (future) until due — assert `GET /opd/queues` shows the entry with `queueClass 4` after vitals.
  2. **vitals with danger → the queue reorders; live push** — open a walk-in for a second patient first (token 2 … tokens are per doctor-day: the appointment took token 1); vitals normal for the walk-in, then vitals `sbp 190` for the appointment patient → `GET /opd/queues` `ordered[0]` is the appointment patient (`queueClass 0`, `danger true`) although its slot is in the future; the socket subscribed to `queue:<doctorId>:<today>` received a `vitals.danger_flagged` `event` frame (assert `name` and `payload.flags[0].vital === "sbp"`).
  3. **call → skip → call → start → Rx → verify → tests-ordered → re-entry → complete** — `call-next` → token of the danger patient; the socket receives `queue.called` with that `tokenNo` and the `display:<roomId>` subscriber (a second socket, `disp` token) receives the same frame under the display topic; `skip` → `queue.skipped`; `call-next` → the same danger patient again (class 0 still wins after the re-queue — `eligibleAt` reset does not demote a class-0 entry) — assert; `consult/start`; `prescriptions` v1; `verify` ok; `complete { testsOrderedReturnToday: true }` → `awaiting_results`; `re-enter` (clerk) → `waiting` with `reEntry true` and the SAME token; `GET /opd/queues` shows it class 1; `call-next` → it; `start` → `in_consultation`; `prescriptions` v2 (supersedes v1: `verify` of v1's payload → `stale_version`); `complete { testsOrderedReturnToday: false, followUpDays: 21 }` → `completed`, `followUpExtended true`; exactly ONE `consultation.completed` event in the table; timeline shows `prescriptionLineCount` of v2.
  4. **transfer + abandon** — third patient walk-in under dra → vitals → `POST /opd/queues/transfer` (sup) to drb → drb's queue has it with token 1 and dra's does not; the socket subscribed to drb's queue topic received `visit.transferred`; `POST /opd/visits/:id/abandon { reason }` (clerk) → `abandoned`; drb's queue no longer lists it.
  5. **leave cascade over HTTP** — book a slot for tomorrow (weekday template again), `POST /opd/leaves` (sup) covering tomorrow → `affectedAppointmentIds` = that id; `GET /opd/appointments?needsRebooking=true` lists it; `POST /opd/appointments/:id/reschedule` to the day after → 200; `POST /opd/leaves/:id/cancel` → `{ restored: 0 }`.
  6. **SLA structure exists** — after leg 3, `select count(*) from workflow_timers where instance_id = <that instance>` ≥ 1 and the FIRED/cancelled pattern matches the moves (at least one `waiting` timer cancelled); no `sla.breached` (nothing waited 45 min).
  Assertion discipline: the socket helper `expectFrame(ws, (m) => m.type === "event" && m.name === "queue.called", 3000)` fails the test on timeout — never a bare `await sleep`.

- [ ] **Step 2: The perf gate** — `test/perf-opd-queue.test.ts` (the `perf-patient-search.test.ts` shape, `beforeAll` timeout 120 s, teardown truncates). Seed by raw SQL: 20,000 patients (the perf-patient shape), 300 doctors across 12 departments, 300 doctor-day sessions for `today`, **60 queue entries + 60 encounters per session (18,000 each)** — encounters `status 'waiting'`, entries `status 'waiting'` with `eligible_at = now - (k minutes)`, `kind` alternating, `appointment_at` set on the appointment kind; plus **200,000 completed historical encounters** spread over the last 400 days across departments (for the visit-type lookup) — one `generate_series` INSERT per table; `ANALYZE`. Budgets (median of 5, warm-up call first): `listQueue(db, actor, doctorId, today)` **< 100 ms** on a 60-entry session; the visit-type anchor query (the exact `select … order by consult_completed_at desc limit 1` used by `openVisitInTx`, run via `openVisit` end-to-end) **< 100 ms**; `boardSnapshot(db, today)` over 300 sessions **< 300 ms** (the display refreshes on events, this is a ceiling); `EXPLAIN (FORMAT JSON)` of the entries query (`session_id = ? AND status IN (...)`) and of the anchor query → no `Seq Scan` on `opd_queue_entries` / `opd_encounters` (the `nodeTypes` walk with `length > 0`). Print timings with `console.log` (Plan 05 precedent — no `no-console` suppression: the rule is not configured, §3.15).

- [ ] **Step 3: Docs** — `apps/core/README.md` gains three sections (concise, factual): **OPD module (Plan 07)** — tables, states/transitions with roles, visit-type rule (department anchor, inclusive days), token/queue discipline (the five classes, perk hook off), vitals bands, e-Rx QR format, error-body shape, the 14 permissions and the recommended grants per role (`front_office`, `front_office_supervisor`, `vitals_desk`, `doctor`, `opd_admin`, `display`, `pharmacy`), the five unscheduled sweeps for Plan 11 (`runDispatchCycle`, `sweepExpiredTempRoles`, `runDueTimers`, `sweepGuardianMajority`, `sweepAppointmentNoShows`) — four existing + one; **Go-live runbook — OPD** — (1) `pnpm --filter @hmis/core seed:opd`; (2) create/assign roles (roles exist; grants are policy); (3) draft the `opd_visit` definition: `GET /opd/definition` → `POST /workflow/definitions` (a user with `workflow.definitions.draft`), `POST /workflow/definitions/:id/approve` by an `owner`-role user and by a `medical_superintendent`-role user, `POST /workflow/definitions/:id/activate` by a third user with `workflow.definitions.activate`; (4) departments/rooms/doctors/schedules via the admin screen (`/opd/admin`); (5) `PUT /opd/config` letterhead + danger ranges reviewed by clinical staff; (6) display board: open `/opd/display?rooms=<ids>` on the counter TV, click Start once (browser speech needs a gesture); **Realtime (WebSocket)** — the protocol frames, topics + permissions, the "hints + 15 s poll" contract, the multi-process design note.

- [ ] **Step 4: Run to pass.** `opd-lifecycle.e2e` **6**, `perf-opd-queue` **5** (three timing + two plan-shape). Workspace **93 suites / 535 tests**. Detached `pnpm verify` (the perf suite adds ~20–40 s).
- [ ] **Step 5: Commit** — `test(core): OPD lifecycle e2e over HTTP+WS, CI-gated queue/visit-type perf budgets; README OPD section + go-live runbook + realtime protocol` → pull --rebase → push. **CI must be observed green on this commit** (the perf seed is CI-viable — flag ⑨) before the task is done.

**Acceptance criteria:**
1. `opd-lifecycle.e2e` 6/6 with every socket frame asserted by predicate-with-timeout; `perf-opd-queue` 5/5 with the printed medians quoted in the report and both plans free of `Seq Scan` on the two tables.
2. The v1→v2 supersession is proven over HTTP (`verify` of v1 → `stale_version` after v2).
3. README sections present with the five sweeps and the exact runbook steps; the recommended-grants table matches the 14 permissions.
4. CI green on the pushed commit, matched by SHA.
5. Workspace 93 / 535; verify green; clean tree. **Pipeline B ends here.**

---

### Task 11: Web infrastructure — the realtime client + hook, the OPD API types, the dev proxy — and the OPD masters admin screen  *(opus coder — the WebSocket client is reused by four screens; get it right once)*

**Files:**
- Modify: `apps/web/vite.config.ts` (proxy `"/opd": "http://localhost:3000"`, `"/ws": { target: "ws://localhost:3000", ws: true }`)
- Create: `apps/web/src/lib/realtime.ts`, `apps/web/src/lib/realtime.test.ts`
- Create: `apps/web/src/lib/opd-api.ts` (wire types + tiny fetchers; no test of its own — the screens' tests exercise it)
- Create: `apps/web/src/screens/opd-admin.tsx`, `apps/web/src/screens/opd-admin.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/opd/admin`; nav link), `apps/web/src/locales/en.json` + `hi.json` (namespaces `opd` (shared: statuses, classes, common labels) and `opdAdmin`)

**Web conventions carried from Plan 05 (binding):** every string via `t()`; forms on `FormKit`/`TextField`/`SelectField` (`data-field`, Enter-advance, Alt+S); numbers from `register` are STRINGS — coerce with `z.preprocess` at the resolver and never compare `typeof v === "number"` on watched values (§3.19); errors inline `role="alert"`; the server is authoritative (client schemas mirror, never replace); component tests use `renderWithProviders` + `stubFetch`, mock `@tanstack/react-router` down to `useNavigate`/`useSearch` as needed, and stub globals (`WebSocket`, `speechSynthesis`) with `vi.stubGlobal` restored in `afterEach`; every screen polls its read model with `refetchInterval: 15_000` AND subscribes to its realtime topics (the pushes are hints — D6).

- [ ] **Step 1: The realtime client (red-first)** — `realtime.test.ts` with a `FakeWebSocket` class (`static instances: FakeWebSocket[]`, `sent: string[]`, `readyState`, `send()`, `close()`, `simulateOpen()`, `simulateMessage(obj)`, `simulateClose()`), `vi.stubGlobal("WebSocket", FakeWebSocket)`, `vi.useFakeTimers()`. Six tests: (1) `subscribe(["queue:D:2026-08-17"], h)` opens `` `ws://${location.host}/ws` `` (assert against `location.host` — jsdom's default origin under vitest), and on `simulateOpen()` the FIRST frame sent is `{"type":"auth","token":"<getToken()>"}` — nothing before auth; (2) on `{type:"authed"}` the client sends `{"type":"subscribe","topics":["queue:D:2026-08-17"]}` (deduped across handlers); (3) an incoming `{type:"event", topic:"queue:D:2026-08-17", …}` reaches `h` with the frame; a frame for another topic does not; (4) `unsubscribe` (the returned function) sends `{"type":"unsubscribe",…}` when the last handler for a topic leaves and NOT before (two handlers, remove one); (5) on `simulateClose()` a reconnect is scheduled with backoff `1000 → 2000 → 4000 … ≤ 30000` ms (advance timers, count `FakeWebSocket.instances`), and after reopening the client re-auths and re-subscribes to every active topic; (6) `useRealtime(topics, onEvent)` (rendered in a tiny test component) subscribes on mount and unsubscribes on unmount, and `onEvent` is called through a ref (a re-render with a new callback does not resubscribe — count `subscribe` frames).

  `realtime.ts` (load-bearing parts exact):

```ts
import { useEffect, useRef, useState } from "react";
import { getToken } from "./api";

export type EventFrame = { type: "event"; topic: string; name: string; seq: number; occurredAt: string; payload: unknown };
type ServerFrame = EventFrame | { type: "authed"; userId: string } | { type: "subscribed" | "unsubscribed"; topics: string[] } | { type: "pong" } | { type: "error"; code: string; topics?: string[] };
type Handler = (f: EventFrame) => void;

/** One socket per tab; topics are reference-counted; auth is the first frame; reconnect with capped exponential backoff. */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private authed = false;
  private backoffMs = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly listeners = new Set<(connected: boolean) => void>();
  constructor(private readonly url: string, private readonly token: () => string | null) {}

  onStatus(l: (connected: boolean) => void): () => void { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  get connected(): boolean { return this.authed; }

  subscribe(topics: string[], h: Handler): () => void {
    const fresh: string[] = [];
    for (const t of topics) {
      let set = this.handlers.get(t);
      if (!set) { set = new Set(); this.handlers.set(t, set); fresh.push(t); }
      set.add(h);
    }
    this.ensureOpen();
    if (this.authed && fresh.length > 0) this.send({ type: "subscribe", topics: fresh });
    return () => {
      const gone: string[] = [];
      for (const t of topics) {
        const set = this.handlers.get(t);
        if (!set) continue;
        set.delete(h);
        if (set.size === 0) { this.handlers.delete(t); gone.push(t); }
      }
      if (this.authed && gone.length > 0) this.send({ type: "unsubscribe", topics: gone });
    };
  }

  private ensureOpen(): void {
    if (this.ws !== null || this.token() === null) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => { this.send({ type: "auth", token: this.token() }); };
    ws.onmessage = (ev: MessageEvent<string>) => {
      let f: ServerFrame;
      try { f = JSON.parse(ev.data) as ServerFrame; } catch { return; }
      if (f.type === "authed") {
        this.authed = true; this.backoffMs = 1000;
        const topics = [...this.handlers.keys()];
        if (topics.length > 0) this.send({ type: "subscribe", topics });
        for (const l of this.listeners) l(true);
      } else if (f.type === "event") {
        for (const h of this.handlers.get(f.topic) ?? []) h(f);
      }
    };
    ws.onclose = () => {
      this.ws = null; this.authed = false;
      for (const l of this.listeners) l(false);
      if (this.handlers.size === 0) return;
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.ensureOpen(); }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    };
  }
  private send(obj: unknown): void { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
}

let singleton: RealtimeClient | null = null;
export function realtimeClient(): RealtimeClient {
  if (singleton === null) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    singleton = new RealtimeClient(`${proto}://${location.host}/ws`, getToken);
  }
  return singleton;
}
/** test seam */
export function resetRealtimeClientForTests(): void { singleton = null; }

/** Subscribe to topics for the component's lifetime; onEvent is read through a ref so callers may pass a fresh closure every render. */
export function useRealtime(topics: string[], onEvent: (f: EventFrame) => void): { connected: boolean } {
  const cb = useRef(onEvent);
  cb.current = onEvent;
  const key = topics.join("|");
  const [connected, setConnected] = useState(realtimeClient().connected);
  useEffect(() => {
    const client = realtimeClient();
    const off = client.subscribe(key === "" ? [] : key.split("|"), (f) => cb.current(f));
    const offStatus = client.onStatus(setConnected);
    return () => { off(); offStatus(); };
  }, [key]);
  return { connected };
}
```
`opd-api.ts`: the on-the-wire types the screens share (Dates as ISO strings — the Plan 05 wire-type convention): `WireEncounter`, `WireQueueEntry`, `WireQueueView`, `WireDoctorSummary`, `WireBoardItem`, `WireAppointment`, `WireSlot`, `WireDoctor`, `WireDepartment`, `WireRoom`, `WireSchedule`, `WireLeave`, `WireVitals`, `WirePrescription`, `WireRxPrint`, `WirePatientSummary`, `WireOpenVisitResult`, `WireTimelineItem`, `WireOpdConfig`, `WireOpdError` (`{ statusCode, message, code, detail? }`) + `opdErrorMessage(e: unknown): string` (the approvals-inbox `errorMessage` shape, reading `code`) + `todayIst(): string` (client-side IST date — mirrors `time.ts` arithmetic; a one-liner, tested inside `realtime.test.ts`? No — put `todayIst` in `opd-api.ts` with one test in `opd-admin.test.tsx`'s file: `todayIst(new Date("2026-08-15T18:30:00Z")) === "2026-08-16"`).

- [ ] **Step 2: The admin screen (red-first)** — `opd-admin.test.tsx` (4 tests): (1) renders the departments table from `GET /opd/departments`, and "Add department" posts `{ code, name }`; (2) the doctors tab posts `{ username, displayName, registrationNo, departmentId, specialty }` and shows the server's `unknown_user` message inline on a 404 (direct `vi.stubGlobal("fetch")` for the non-200); (3) the schedules editor for a doctor loads `GET /opd/doctors/:id/schedules`, adds a row (weekday/start/end/room/slot), and `PUT`s `{ items: [...] }` with `weekday` as a NUMBER and `slotMinutes` `null` when blank (the §3.19 coercion, asserted from the posted body); (4) the leaves panel posts `{ doctorId, fromDate, toDate, reason }` and renders `affectedAppointmentIds.length` in a confirmation line; "Cancel leave" posts `/opd/leaves/:id/cancel`. Screen: `Tabs` (shadcn) — Departments · Rooms · Doctors · Schedules & leaves; each tab = a table (shadcn `Table`) + a `FormKit` form; the Schedules tab has a doctor `SelectField`, a rows editor (weekday select 0–6 with localized day names, `start`/`end` `type="time"`, room select, slot minutes number), Save (PUT replaces the set — say so in a helper line), and the leaves list with an add form + cancel buttons; `active` toggles via PATCH. Route `/opd/admin` (component `OpdAdmin`) + nav link `nav.opdAdmin`.

- [ ] **Step 3: Mutants (tripwire 21).** **W1** `realtime.mutantW1.ts` — `subscribe` sent BEFORE `authed` (on `open`) → test 1/2's "nothing before auth" → predicted DIED. **W2** — `unsubscribe` sent when ANY handler leaves → test 4 → predicted DIED. **W3** `opd-admin.mutantW3.tsx` copy — schedules PUT without coercion (`weekday` string) → test 3 → predicted DIED. 3× each (vitest, isolated by path); delete before counting.
- [ ] **Step 4: Run to pass.** `realtime.test` **6**, `opd-admin.test` **4** (+ `todayIst` = 5). Web: **13 files / 48 tests**. Root `pnpm verify` (detached).
- [ ] **Step 5: Commit** — `feat(web): realtime client + useRealtime, OPD wire types, dev proxy; OPD masters admin screen` → pull --rebase → push.

**Acceptance criteria:**
1. `realtime.test` 6/6 (auth-first, ref-counted topics, backoff sequence `1000,2000,4000` asserted from timer advances, re-subscribe after reconnect, hook mount/unmount); `opd-admin.test` 5/5; red-first quoted (§2.8 fallback).
2. `vite.config.ts` gains exactly the two proxy entries; `apps/web/package.json` unchanged (zero new web deps).
3. `en.json`/`hi.json` parity test green; the new keys live under `opd` and `opdAdmin`.
4. Mutants W1–W3 DIED (3/3); scratch deleted.
5. Web 13 / 48; verify green; clean tree.

---

### Task 12: Appointments screen — slot grid, booking, day list, reschedule / cancel, the needs-rebooking worklist, check-in with the token slip  *(sonnet coder)*

**Files:**
- Create: `apps/web/src/components/patient-picker.tsx`, `apps/web/src/components/patient-picker.test.tsx` (search-first picker reused by T13; wraps `GET /patients/search` + `PatientPhoto` + a QR-scan text box that posts `POST /patients/qr/verify`)
- Create: `apps/web/src/components/token-slip.tsx`, `apps/web/src/components/token-slip.test.tsx` (printable `.print-doc`; reused by T13)
- Create: `apps/web/src/screens/opd-appointments.tsx`, `apps/web/src/screens/opd-appointments.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/opd/appointments`, nav link), `apps/web/src/styles.css` (append the `.print-doc` isolation block below), `en.json` + `hi.json` (`opdAppt`, `slip`, `picker`)

- [ ] **Step 1: Print isolation for documents** — append to `styles.css` (the `.qr-card` block stays untouched):
```css
/* Plan 07: printable documents (token slip, e-Rx). Only the .print-doc reaches the paper; A5 portrait default. */
@media print {
  .print-doc, .print-doc * { visibility: visible; }
  .print-doc { position: fixed; left: 0; top: 0; width: 148mm; min-height: 100mm; padding: 8mm; border: none; background: white; }
  @page { size: A5 portrait; margin: 6mm; }
}
```
(The existing `body * { visibility: hidden }` rule already hides everything else under print — this block whitelists the second document class.)

- [ ] **Step 2: Components (red-first)** — `patient-picker.test.tsx` (2): typing digits searches and a click selects (calls `onPick(hit)`); pasting a QR payload posts `/patients/qr/verify` and picks on `ok:true`, shows `t("picker.badScan")` on `ok:false`. `token-slip.test.tsx` (2): renders hospital name (`t("hospital.name")`), department code, doctor name, room code, TOKEN large (`data-testid="token-no"`), date, UHID, and the QR svg (from the patient's `payload`); the print button is `.no-print` and calls `window.print()`; the root carries `.print-doc`. `TokenSlip` props: `{ tokenNo: number; roomCode: string | null; doctorName: string; departmentCode: string; departmentName: string; serviceDate: string; patient: { uhid: string; name: string | null }; qrPayload: string; visitType: string }`.

- [ ] **Step 3: The screen (red-first)** — `opd-appointments.test.tsx` (5): (1) picking a department then a doctor and a date loads `GET /opd/slots?doctorId=&date=` and renders 6 slot buttons (`03:30Z…04:20Z` rendered as IST `09:00…09:50`), `booked` ones disabled, `past` ones dimmed; (2) picking a patient (via the picker stub) and clicking a slot posts `POST /opd/appointments { patientId, doctorId, slotStart: "<ISO>" }` and the day list refreshes; (3) the day list (`GET /opd/appointments?doctorId&serviceDate`) renders rows with patient UHID/name, slot time, status badge; **Reschedule** opens a dialog with the slot grid for a chosen date and posts `/opd/appointments/:id/reschedule { slotStart, doctorId }`; **Cancel** requires a reason and posts `{ reason }`; (4) the "Needs rebooking" tab lists `GET /opd/appointments?needsRebooking=true` across doctors with a one-tap Reschedule; (5) **Check in** on today's `booked` row posts `/opd/appointments/:id/check-in` and renders the `TokenSlip` with the returned `tokenNo` and the patient QR (`GET /patients/:id/qr`), disabled for other days. Screen: header controls (department `SelectField`, doctor `SelectField` from `GET /opd/doctors?departmentId`, `type="date"` input default `todayIst()`), left = slot grid (buttons in a 6-column grid, IST `HH:MM` labels via a local `fmtIst(iso)` = `new Date(iso)` shifted +5:30 and formatted `HH:MM`), right = `PatientPicker` + the day list; tabs Day · Needs rebooking. `refetchInterval: 15_000` on the day list; `useRealtime` on `queue:<doctorId>:<date>` refetching appointments on `patient.checked_in`.

- [ ] **Step 4: Mutants.** **A1** `opd-appointments.mutantA1.tsx` — check-in enabled on non-today rows → test 5 → predicted DIED. **A2** `token-slip.mutantA2.tsx` — root without `.print-doc` → slip test → predicted DIED. 3× each; delete.
- [ ] **Step 5: Run to pass.** Web: **16 files / 57 tests** (+2 +2 +5). Root verify.
- [ ] **Step 6: Commit** — `feat(web): OPD appointments — slot grid, booking, day list, reschedule/cancel, needs-rebooking worklist, check-in with the printed token slip; patient picker; print-doc isolation` → pull → push.

**Acceptance criteria:** tests 9/9 green + red-first quoted; slot labels prove the IST rendering (`04:00Z → 09:30`); the check-in body and the booking body asserted from `fetch` calls; `.print-doc` block appended verbatim; parity green; mutants A1/A2 DIED; web 16 / 57; verify green; clean tree.

---

### Task 13: The OPD desk — walk-in visit opening with the token slip, today's arrivals check-in, live queue overview, abandon, and the supervisor's E2 transfer  *(opus coder — the flagship desk screen; keyboard-first, most states)*

**Files:**
- Create: `apps/web/src/screens/opd-desk.tsx`, `apps/web/src/screens/opd-desk.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/opd/desk`, nav), `apps/web/src/lib/keyboard.tsx` (Alt+D → `/opd/desk`, Alt+V → `/opd/vitals`, Alt+C → `/opd/consult`, Alt+P → `/opd/appointments`; legend entries), `en.json` + `hi.json` (`opdDesk`, `shortcuts.*` additions)

- [ ] **Step 1: Tests first** — `opd-desk.test.tsx` (6): (1) the doctor board renders `GET /opd/queues/summary?departmentId=&serviceDate=` rows: doctor name, room, status badge (`in`/`out`/`not started`/`none`), waiting count, "not scheduled today" warning when `scheduledToday false`; (2) picking a patient (picker stub) then a doctor row's **Open visit** posts `POST /opd/visits { patientId, departmentId, doctorId, intendedPayer: "self" }` (payer select default self; referral source optional → included only when chosen) and renders the `TokenSlip` with the returned `tokenNo`/`roomCode` and the patient's QR; the doctor's `visitType` from the response is shown as a badge (`new` / `revisit` — with `t("opdDesk.freeFollowUp")` on `revisit`, the owner's free-follow-up rule surfaced to the desk); (3) **Today's arrivals** for the picked patient (`GET /opd/appointments?patientId&serviceDate=today`) shows a booked appointment with **Check in** → posts `/opd/appointments/:id/check-in` → slip; (4) the queue overview for a picked doctor (`GET /opd/queues?doctorId&serviceDate`) lists ordered tokens with class badges and refetches on a `queue.called` frame from `useRealtime` (assert a second `GET /opd/queues` after `simulateMessage`); (5) **Abandon** on a row opens a reason dialog, blocks empty, posts `{ reason }`; (6) **Transfer queue** (rendered only when `GET /auth/me`… no — the UI holds no client-side permission model (Plan 05 rule); the button is always rendered and a 403 renders inline) opens a dialog: target doctor select (same department list), a consent checkbox (`t("opdDesk.consentGiven")` — the §11.1 "bulk queue transfer (consent)" rule) that must be checked, a reason, optional entry multi-select; posts `POST /opd/queues/transfer { fromDoctorId, toDoctorId, serviceDate, entryIds?, consented: true, reason }`; a stubbed 403 renders inline. Keyboard: `/` focuses the picker's search (`data-search-input`), Alt+S submits the open-visit form, Enter advances.

- [ ] **Step 2: The screen** — three columns: (a) `PatientPicker` + arrivals + last-visit hint (`GET /opd/patients/:id/timeline` first item: "last seen <date>, <dept>"), (b) department select + doctor board (summary rows, polling 15 s, realtime on the picked doctor's topic), (c) the queue overview + actions (Abandon, Transfer). Open-visit form fields: `intendedPayer` (`self|tpa|pmjay|corporate`), `referralSource` (blank | `internal_doctor|external_rmp|camp|other`), `referrerName`. After open: slip view with Print + "Next patient" (clears the picker, refocuses search).

- [ ] **Step 3: Mutants.** **D1** copy — Transfer posts without checking `consented` → test 6 → predicted DIED. **D2** copy — abandon posts an empty reason → test 5 → predicted DIED. 3× each; delete.
- [ ] **Step 4: Run to pass.** Web **17 files / 63 tests**. Verify.
- [ ] **Step 5: Commit** — `feat(web): OPD desk — walk-in visit opening with token slip, arrivals check-in, live queue overview, abandon, supervisor transfer with consent; OPD keyboard shortcuts` → pull → push.

**Acceptance criteria:** 6/6 + red-first; the transfer body carries `consented: true` ONLY after the checkbox; keyboard shortcuts added to `keyboard.tsx` + legend + both locales; mutants D1/D2 DIED; parity green; web 17 / 63; verify green; clean.

---

### Task 14: The vitals desk — worklist, keyboard-first capture with band-aware required fields, danger flags, quick allergy  *(sonnet coder)*

**Files:**
- Create: `apps/web/src/screens/opd-vitals.tsx`, `apps/web/src/screens/opd-vitals.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/opd/vitals`, nav), `en.json` + `hi.json` (`opdVitals`)

- [ ] **Step 1: Tests first** — `opd-vitals.test.tsx` (5): (1) the worklist renders `GET /opd/visits?status=registered&departmentId=` rows (token, patient UHID/name, doctor, opened time, `danger` never here) ordered as returned; a department filter re-queries; the list refetches on a `visit.opened` frame (`useRealtime` on the department's doctors' queue topics — the topics come from `GET /opd/queues/summary`'s doctor ids); (2) selecting a row loads the patient (`GET /patients/:id` → age from `dob`; a 404 renders "restricted record" and uses the adult band) and `GET /opd/config` bands, and marks the REQUIRED fields for that band with `*` (a 3-year-old: height, weight, temp, SpO₂, pulse — and BP not required; an adult: the seven); (3) submitting posts `POST /opd/visits/:id/vitals` with NUMBERS (`weightKg: 60`, `tempC: 37.2`) — asserted from the body: no strings — and blank optional fields OMITTED (not `""`, not `null`); (4) a 201 with `flags: [{ vital: "sbp", value: 190, bound: "max", limit: 180 }]` renders a red `role="alert"` banner naming the vital and the limit (`t("opdVitals.danger", { vital, value, limit })`) and the row leaves the worklist (`encounter.status "waiting"`); a stubbed 400 `vitals_incomplete` with `detail.missing ["weightKg"]` renders the missing list inline; (5) **Quick allergy** posts `POST /patients/:id/allergies { substance, severity?, source: "vitals" }` and shows it in the patient panel's allergy list (`GET /patients/:id/allergies`).

- [ ] **Step 2: The screen** — left: worklist (department select from `GET /opd/departments`, rows as buttons; `refetchInterval 15_000`); right: patient panel (name/alias, UHID, age, sex, existing allergies with a quick-add form) + the vitals `FormKit` (fields in this tab order: height cm, weight kg, SBP, DBP, pulse, RR, SpO₂, temp °C, notes; all `type="number"` with `step`; `autoFocus` on height; band label `t("opdVitals.band.<key>")` computed client-side from age with the SAME exclusive-bound rule as `bandFor` (mirror, not authority — the server refuses incompleteness anyway) reading `GET /opd/config`'s `dangerRanges.bands`; required stars from `band.required` ∪ (`weightKg` if age < `weightRequiredUnderYears`)); zod schema with `z.preprocess` number coercion for each field (blank → `undefined`); on success show flags (if any) for 4 s then advance to the next worklist row automatically (keyboard-first desk flow: the assistant never touches the mouse between patients).

- [ ] **Step 3: Mutants.** **V1** copy — numbers posted as strings (no preprocess) → test 3 → predicted DIED. **V2** copy — required stars from the adult band always → test 2's 3-year-old assertion → predicted DIED. 3× each; delete.
- [ ] **Step 4: Run to pass.** Web **18 files / 68 tests**. Verify.
- [ ] **Step 5: Commit** — `feat(web): OPD vitals desk — worklist, keyboard-first capture with band-aware required fields, danger flags, quick allergy` → pull → push.

**Acceptance criteria:** 5/5 + red-first; the posted body is numeric with optional blanks omitted (asserted); mutants V1/V2 DIED; parity green; web 18 / 68; verify green; clean.

---

### Task 15: The consultation screen — live queue, call / skip / start / status, patient panel, note + Rx editor with the allergy override dialog, completion, and the printed e-Rx  *(opus coder — the doctor's flagship screen)*

**Files:**
- Create: `apps/web/src/components/rx-print.tsx`, `apps/web/src/components/rx-print.test.tsx`
- Create: `apps/web/src/screens/opd-consult.tsx`, `apps/web/src/screens/opd-consult.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/opd/consult`, nav), `en.json` + `hi.json` (`opdConsult`, `rx`)

- [ ] **Step 1: The e-Rx print (red-first)** — `rx-print.test.tsx` (2): (1) renders `letterhead.name` + each address line, the doctor's display name + registration number, patient UHID/name(or alias)/age/sex, the service date, diagnosis (+ ICD-10 in parentheses), the latest vitals line (`BP 120/80 · P 72 · SpO₂ 98% · T 37.0 °C · Wt 60 kg`), one row per line (`drug · dose · frequency · route · N days · instructions`, and `t("rx.noSubstitution")` when set), the follow-up line (`t("rx.followUp", { days })`), the QR svg from `qrPayload`, and NO signature line (assert the absence of `t("rx.signature")` — the key does not exist; assert no element with text matching /sign/i); (2) the root carries `.print-doc`, the print button `.no-print` and calls `window.print()`. Props = the T7 `RxPrintData` wire shape.

- [ ] **Step 2: The screen (red-first)** — `opd-consult.test.tsx` (6): (1) boots with `GET /opd/me/doctor` then `GET /opd/queues?doctorId=<me>&serviceDate=today`; renders the queue (position, token, class badge, danger flag icon, re-entry marker) with `current` (the called token) highlighted, the session status control (`in`/`out`/`closed`); a `queue.called` frame from `useRealtime` triggers a refetch; (2) **Call next** posts `/opd/queues/:sessionId/call-next` and shows the called token; **Skip** posts `/opd/queues/entries/:entryId/skip`; **Start** posts `/opd/visits/:id/consult/start` and opens the patient panel; a stubbed 409 `call_conflict` renders inline; (3) the patient panel loads `GET /patients/:id` (404 → restricted mode with UHID only), `GET /patients/:id/allergies` (active ones as red chips), `GET /opd/patients/:id/timeline` (rows: date, dept, doctor, diagnosis), `GET /opd/visits/:id` (latest vitals with danger flags highlighted); (4) the note form autosaves via `PUT /opd/visits/:id/consult/note` on blur (asserted body: `{ diagnosis, icd10Code, … }`); (5) the Rx editor: rows (drug, dose, route select `oral|iv|im|sc|topical|inhaled|other`, frequency select `OD|BD|TDS|QID|HS|SOS|STAT|other`, duration days, instructions, no-substitution checkbox); **Issue & print** posts `POST /opd/visits/:id/prescriptions { lines }`; on a stubbed **409 `allergy_conflict`** with `detail.matches` the override dialog opens listing each matched line + substance with a mandatory reason field per match; confirming re-posts with `overrides: [{ lineIndex, substance, reason }]`; on 201 the `RxPrint` renders with `GET /opd/prescriptions/:id/print` data and `window.print()` is available; (6) **Complete**: follow-up select (7 default, then 15/21/30 labelled `t("opdConsult.extension")`), toggle "tests ordered — patient returns today", admission-advised checkbox, referral fields; posts `POST /opd/visits/:id/consult/complete { note, testsOrderedReturnToday, followUpDays }` (`followUpDays` OMITTED when 7 is chosen so the server's default applies — assert); a stubbed 409 `extension_cap_reached` renders inline and keeps the form; on 200 the panel closes and the queue refetches.

  Screen layout: left rail = queue + session controls (sticky); main = patient header (name/alias, UHID, age/sex, visit type badge, danger flag banner) → tabs Note · Rx · History; footer = Complete controls. Keyboard: `Alt+N` call next, `Alt+K` skip, `Alt+S` start/issue (context), `Alt+Enter` complete — declared in the legend for this screen only (local `useEffect` keydown, not `keyboard.tsx`).

- [ ] **Step 3: Mutants.** **X1** `opd-consult` copy — the override dialog re-posts WITHOUT `overrides` → test 5 → predicted DIED. **X2** copy — `followUpDays: 7` sent explicitly → test 6's "omitted when default" → predicted DIED. **X3** `rx-print` copy — a "Signature: ____" line added → rx-print test 1's absence assertion → predicted DIED. 3× each; delete.
- [ ] **Step 4: Run to pass.** Web **20 files / 76 tests**. Verify.
- [ ] **Step 5: Commit** — `feat(web): OPD consultation — live queue with call/skip/start, patient panel, autosaving note, Rx editor with allergy override dialog, completion with follow-up window; printed e-Rx on the letterhead` → pull → push.

**Acceptance criteria:** 8/8 + red-first; bodies asserted for call-next/skip/start/note/prescriptions(+overrides)/complete; the print has NO signature line; parity green; mutants X1–X3 DIED; web 20 / 76; verify green; clean.

---

### Task 16: The token display board with browser-speech audio, nav completion, and the web docs  *(sonnet coder — pipeline C capstone)*

**Files:**
- Create: `apps/web/src/screens/opd-display.tsx`, `apps/web/src/screens/opd-display.test.tsx`
- Modify: `apps/web/src/router.tsx` (route `/opd/display` with `validateSearch: { rooms?: string }`; the Shell's nav gains the six OPD links — the OPD links render for everyone; the server 403s decide), `en.json` + `hi.json` (`opdDisplay`, `nav.*` completions), `README.md` (root — a "Web app: OPD screens" section: routes, roles, shortcuts, the display-board Start button)

- [ ] **Step 1: Tests first** — `opd-display.test.tsx` (4, with `vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn() })` and `vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; lang = ""; constructor(t: string) { this.text = t; } })`): (1) before Start, the board shows `t("opdDisplay.start")` and NO subscription is made (no `WebSocket` instance); after clicking Start, `GET /opd/queues/board?serviceDate=&roomIds=<from search>` renders one card per item: room code, doctor name, department, NOW SERVING token (or `—`), next tokens, `status`; (2) a `queue.called` frame `{ payload: { roomId, tokenNo: 37 } }` on `display:<roomId>` updates that card's NOW SERVING to 37 immediately (before any refetch) AND calls `speechSynthesis.speak` twice — first with an utterance whose `lang` is `hi-IN` and text `t("opdDisplay.announceHi", { token: 37, room })` (`"टोकन नंबर 37, कमरा 12"`), then `en-IN` with `"Token number 37, room 12"`; a `queue.skipped` frame clears the NOW SERVING of that room; (3) `refetchInterval` — advancing fake timers 15 s triggers a second board GET; (4) the DOM contains no patient identifiers: render with a board stub whose items are the exact `BoardItem` keys and assert `screen.queryByText(/UHID|Asha/)` is null AND that the component's fetch keys are only `/opd/queues/board` (no `/patients`).

- [ ] **Step 2: The screen** — full-screen dark layout for a TV (large type: room code, doctor, department; NOW SERVING in the largest weight; next 5 tokens smaller), Hindi/English labels both shown (the display is bilingual by design — §15 Hindi/English day one), a `Start` button that gates the socket + speech (browser autoplay/speech policies need one user gesture), `useRealtime(rooms.map(r => "display:" + r), onFrame)`, board query with `refetchInterval 15_000`, `queue.called` handler: patch the query cache for that room (`queryClient.setQueryData`) then `speak()`; `speak()` guards `"speechSynthesis" in window`, cancels any pending utterance, queues hi-IN then en-IN. Search param `rooms` (comma-separated room ids); no rooms → all sessions of the day.

- [ ] **Step 3: Nav + docs** — `Shell` nav: Appointments · OPD desk · Vitals · Consultation · Display · OPD admin (i18n `nav.*`); root `README.md` "Web app: OPD screens" — routes, the roles each screen expects, shortcuts (Alt+P/D/V/C, screen-local Alt+N/K/S/Enter), the display Start button, the "hints + 15 s poll" note.

- [ ] **Step 4: Mutants.** **B1** copy — speaks only English → test 2's `hi-IN` first assertion → predicted DIED. **B2** copy — subscribes before Start → test 1 → predicted DIED. 3× each; delete.
- [ ] **Step 5: Run to pass.** Web **21 files / 80 tests**. Root verify (whole repo).
- [ ] **Step 6: Commit** — `feat(web): OPD token display board with bilingual browser-speech calling; OPD nav; web docs` → pull → push.

**Acceptance criteria:** 4/4 + red-first; the two utterances asserted in order with `lang`; no patient identifiers on the board (asserted); nav complete in both locales; README section present; mutants B1/B2 DIED; web 21 / 80; verify green; clean. **Pipeline C ends here.**

---

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Per tripwire 21, "Kills" below are HAND-DERIVED PREDICTIONS. Each task's acceptance criteria require the mutant BUILT and RUN (separate scratch files, self-contained specs), and the **Executed verdict** recorded in the task report — the gate checks that the verdict exists and matches a real run, never a hand-walk. "= pre-fix red" means the shipped code is itself the mutant and the observed fail-first run is the executed evidence. Rows marked *measure* authorise an honest SURVIVED (a race window nobody has measured — ledger §3.22): the coder reports the observed rate and never engineers a kill; the structural defence is named. **§2.12:** a required-DIED that SURVIVES because the plan's TEST cannot discriminate and the test is the task's own file ⇒ fix minimally in-task, disclose, re-run; a survivor implying the shipped IMPLEMENTATION is wrong, or whose fix reaches outside the task's Files list ⇒ chain halt + plan-defect report.

| # | Task | Assertion | Kills (mutant → predicted wrong observable) | Executed verdict | Notes |
|---|---|---|---|---|---|
| K1 | T1 | `truncateAll` clears the OPD chain that FKs into `patients` | = pre-fix red: unextended `db.ts` → `cannot truncate a table referenced in a foreign key constraint` at every `beforeEach` | | §3.12 executed, not narrated |
| K2 | T1 | partial unique index arbitrates live bookings; cancelled rows do not block | (structural pin: 23505 on the second `booked`, `[]` on `needs_rebooking`, OK after `cancelled`) | | green by construction once drizzle emits the predicate — flag ② |
| K3 | T2 | leave day → `[]` slots | Mutant A (leave check deleted) → 6 slots | | pure |
| K4 | T2 | `validTo` gates the template | Mutant B (`validTo` clause deleted) → 6 slots | | pure |
| K5 | T3 | day 7 is a revisit (inclusive) | Mutant A (`<` strict) → `renewal` on day 7 | | pure boundary |
| K6 | T3 | visit type anchors on the SAME department | Mutant B (dept predicate dropped) → `revisit` for the other department | | owner decision made testable |
| K7 | T3 | six concurrent opens → tokens 1..6, `nextToken 7` | Mutant C (read-then-write counter) → a duplicate token — **measure 10×** | | structural defence: atomic `UPDATE … RETURNING`; SURVIVED runs reported |
| K8 | T3 | `listMergedLoserIds` walks two hops | Mutant D (hop bound 1) → `[l1]` only | | |
| K9 | T3 | abandon race: one winner, ONE loser code | (invariant + mapped code; interleavings traced in T3) | | five iterations; no early bail |
| K10 | T4 | off-grid slot → `invalid_slot` | Mutant A (membership check dropped) → booked | | |
| K11 | T4 | wrong-day check-in → `appointment_not_today` | Mutant B (same-day check dropped) → visit opened | | |
| K12 | T4 | cascade marks only the leave range | Mutant C (date predicates dropped) → the Thu row `needs_rebooking` | | |
| K13 | T4 | sweep leaves today's bookings alone | Mutant D (`service_date < today` dropped) → today's row `no_show` | | |
| K14 | T4 | slot race: `slot_taken`, one live row | (index-arbitrated; single code by construction — no pre-check) | | five iterations |
| K15 | T5 | example order `D E G B A F C` | Mutants E1 (future = due) / E3 (danger ignored) → different order | | pure |
| K16 | T5 | skipped walk-in falls behind, keeps token | Mutant E2 (walk-ins by tokenNo) → F before A | | pure |
| K17 | T5 | perk never overtakes classes 0–2 | Mutant E4 (promotion when head ≤ 2) → F before D/B | | pure + property P5 |
| K18 | T5 | properties P1–P5 | (fast-check, 100 runs each; the pure mutants above are re-run against P2/P3/P5 by the coder as a second confirmation) | | |
| K19 | T5 | two callers with straddling clocks → ONE called | Mutant S (`FOR UPDATE` removed) → two called rows — **measure 10×** | | the lock is on a row OUTSIDE the entry's write path (§3.28); observed rate reported |
| K20 | T5 | a second call while one is `called` → `call_conflict` | Mutant Q (pre-check removed) → a second patient called | | |
| K21 | T5 | call race same clock: one winner, one `call_conflict` | (invariant + single code) | | five iterations |
| K22 | T6 | inclusive bounds (180 → no flag; 181 → flag) | Mutant V1 (`>=`) → flag at 180 | | pure |
| K23 | T6 | age 6 → `child_6_12` | Mutant V2 (`<=`) → `child_1_5` | | pure |
| K24 | T6 | danger sets the queue entry's `danger` | Mutant V3 (entry update dropped) → `danger false` | | |
| K25 | T6 | danger never auto-clears | (a normal second reading leaves `dangerFlagged true`) — mutant not built: the assertion is a direct read of a column the shipped code never resets; a "clearing" mutant would be an invented feature | | declared; structural |
| K26 | T7 | allergy match is bidirectional, case-insensitive | Mutant F1 (one direction) → `Penicillin G` vs `penicillin` unmatched | | pure |
| K27 | T7 | no diagnosis → no `Condition` entry | Mutant F2 → an empty Condition emitted | | pure |
| K28 | T7 | extension cap per doctor per IST month | Mutant C1 (count dropped) → third extension accepted | | |
| K29 | T7 | only the treating doctor | Mutant C2 (doctor comparison dropped) → drb starts dra's patient | | |
| K30 | T7 | concurrent issues → versions {1,2} | Mutant P1 (`FOR UPDATE` dropped) → both compute 1 → raw 23505 — **measure 10×** | | structural defence: the unique index; observed rate reported |
| K31 | T7 | v1 → `stale_version` after v2 | (behavioural; the supersede UPDATE is the mechanism — a mutant dropping it makes v1 verify `ok:true`) → build as **Mutant P2** | | required DIED |
| K32 | T8 | look-back delivers a later-committed lower seq | Mutant T1 (`from = cursor`) → N never delivered | | the out-of-order-commit case executed with a raw client |
| K33 | T8 | dedupe: nothing delivered twice | Mutant T2 (`seen` removed) → N+1 delivered again | | |
| K34 | T8 | an event appended by another connection reaches the socket | Mutant G1 (in-process emitter fan-out — declared approximation) → never delivered | | the multi-process claim |
| K35 | T8 | subscribe checks the topic-space permission | Mutant G2 (`hasPermission` skipped) → `subscribed` for `rando` | | |
| K36 | T8 | `visit.transferred` topics both doctors | Mutant R1 (from/to dropped) → one topic | | pure |
| K37 | T9 | wire contract: statuses, codes, bodies | (e2e over the mutant-tested services; red-first at 404) | | no mutant owed — declared |
| K38 | T10 | no `Seq Scan` on `opd_queue_entries` / `opd_encounters` | discriminator = dropping the index (a schema change) — **not built, declared**; defence: the `EXPLAIN` walk with `length > 0` | | K3-style honest declaration |
| K39 | T11 | nothing sent before `authed`; subscribe after | Mutant W1 (subscribe on open) → subscribe frame first | | |
| K40 | T11 | ref-counted unsubscribe | Mutant W2 (unsubscribe on any leave) → early frame | | |
| K41 | T11 | schedule PUT coerces numbers | Mutant W3 (no coercion) → `weekday: "1"` | | §3.19 class |
| K42 | T12 | check-in only today | Mutant A1 → enabled on other days | | |
| K43 | T12 | slip carries `.print-doc` | Mutant A2 → class missing | | |
| K44 | T13 | transfer requires consent | Mutant D1 → posted without the checkbox | | |
| K45 | T13 | abandon requires reason | Mutant D2 → empty reason posted | | |
| K46 | T14 | numbers posted as numbers | Mutant V1 (web) → strings | | §3.19 class |
| K47 | T14 | required stars follow the band | Mutant V2 (web) → adult stars for a 3-year-old | | |
| K48 | T15 | overrides re-posted after the dialog | Mutant X1 → re-post without `overrides` | | |
| K49 | T15 | default follow-up omitted | Mutant X2 → `followUpDays: 7` sent | | |
| K50 | T15 | e-Rx has no signature line | Mutant X3 → a signature line | | owner decision made testable |
| K51 | T16 | Hindi first, then English, with `lang` | Mutant B1 (English only) → one utterance | | |
| K52 | T16 | no socket before Start | Mutant B2 (subscribe on mount) → a `WebSocket` instance early | | |

**Reading the Book honestly:** K7, K19, K30 are race windows — *measure, do not predict*; K25, K37, K38 declare no mutant with the reason; every other row is a required DIED. The count of executed verdicts a gate reads is 52 rows, of which 46 require a build.

## Verify-by-execution flags (prove by running — each names the owning task and the discharging assertion; the list may be incomplete, §3.20)

① `date(…, { mode: "string" })` round-trips `'YYYY-MM-DD'` with no TZ shift — T1 schema test 1. ② drizzle-kit emits the partial unique index WITH the `IN ('booked','checked_in','needs_rebooking')` predicate — T1 Step 3 inspection + schema test 2 (STOP if dropped; never hand-edit). ③ drizzle `Tx` is not assignable to `Db` — T3 typecheck; the Db-first/InTx split holds either way. ④ `fast-check` ^3 under ts-jest CJS — T5's property suite. ⑤ `seed:opd` idempotent — T6 runs it twice, both outputs quoted. ⑥ `ws` under pnpm 10's denied build scripts (optional native peers absent) — T8's gateway suite connects a real socket. ⑦ `name = any($1::text[])` binding via `sql.param` — T8 tail tests 2/5 (the `dispatcher.ts:26` shape). ⑧ the gateway suite exits without open handles (`unref()` + `stop()`) — T8 acceptance 4. ⑨ the perf seed (18k+18k+200k rows) completes inside the 120 s `beforeAll` in CI — T10 CI green. ⑩ `HttpAdapterHost.httpAdapter.getHttpServer()` is available in `onApplicationBootstrap` and an `upgrade` listener attached before `listen` fires for later connections — T8 gateway tests. ⑪ drizzle `.for("update")` on a select compiles and serializes — T5 K19 / T7 K30 measurements. ⑫ `z.coerce.date()` accepts ISO `slotStart` bodies — T9 e2e. ⑬ `defineEvent(...).make` accepts `encounterId` + `correlationId` and `appendEvent` writes both columns — T3 test 1 asserts the columns. ⑭ Nest `HttpException` with an object body returns `{ statusCode, message, code, detail }` verbatim — T9 e2e test 3/4. ⑮ jsdom lacks `speechSynthesis`/`SpeechSynthesisUtterance` (assign via `vi.stubGlobal`) and its `WebSocket` is replaced by the fake — T11/T16; the list of jsdom gaps may be incomplete. ⑯ TanStack Router `validateSearch` for `/opd/display?rooms=` — T16. ⑰ `Test.createTestingModule` + `app.listen(0)` + a `ws` client in jest — T8/T10. ⑱ `<input type="time">` values under `user-event` in jsdom — T11 schedules test. ⑲ `Object.keys` set equality as the "no identity on the board" proof — T5 test 9 / T9 test 5 / T16 test 4. ⑳ `sql\`select coalesce(max(seq), 0)::bigint\`` returns a numeric string through node-postgres — T8 tail (`Number()` applied).

**Derived-fixture check (§3.10):** the `opd_visit` definition is validated by `defineWorkflow` in T3 Step 1 before any instance test; the T2 helper's schedule template is a valid `ScheduleInput` (Mon–Sat 09:00–13:00, room from `seedOpdMasters`); every fixture patient goes through `registerPatient` (minors carry a guardian — `mkPatient(…, { ageYears: 3, guardian })`); no fixture is built by spreading another across a validator boundary. Test-shaping writes (queue-entry status/eligibleAt, the merge storage shape, an allergy row) are disclosed where used and touch only the shaping module's own tables or the storage shape the read helper is being tested against.

## Self-review — what this plan's own passes caught before commit

**Pass 1 (every block read as compiler + test runner):**
1. **`Tx` vs `Db`** — the first draft had `openVisit(tx, …)` call `resolvePatientId(tx, …)`; drizzle's `PgTransaction` lacks `$client`, so it would not typecheck. Every OPD service that consumes patients-module readers is now Db-first with an `…InTx` core (T3 preamble, flag ③), and `checkInAppointment` computes the merge chain BEFORE its transaction.
2. **`getPatientSummaries` was one query per id** — 60 queue rows ⇒ 60 `followMergeChain` round trips, eating most of the 100 ms budget. Rewritten to ONE `inArray` query with chain-walking only for rows that are themselves merged losers.
3. **`moveEncounter`'s patch type omitted the note columns** — T7's completion writes diagnosis/ICD-10 in the same UPDATE; the `Pick` now includes them (otherwise T7 would need a second UPDATE or a type cast).
4. **T3's transfer test set `eligibleAt` on entries that were still `waiting_vitals`** — the shaping now sets `status = 'waiting'` too, so the transferred rows carry the shape production produces.
5. **The truncate group's fail-first was hidden behind an unresolved-import red** — Step 4 now runs `opd.test` against the unextended `db.ts` first: every test dies in `beforeEach` with the FK message, an executed §3.12 red (K1).
6. **T1's queue-entry `seq` was declared with `.notNull()` in the first draft** — the shipped precedent (`tariff.ts:83`) omits it and drizzle infers `number` anyway; mirrored the precedent to avoid a generator surprise.
7. **The perk promotion in the first `orderQueue` draft used `classOf(head) >= 3`** — a class-4 head (only future appointments waiting) has no class-3 candidate, so `=== 3` is the exact condition and P5 states it that way.
8. **The abandon race would produce THREE engine codes** (`stale_transition`, `instance_not_active`, `unknown_transition`) depending on the interleaving — §3.13's exact shape. Mapped to ONE OPD code in `moveEncounter` with the trace written into T3; the test asserts the invariant on every path.
9. **`callNext` without a serializer could call TWO patients** when two clicks land with clocks straddling an appointment's due time — the belt (`WHERE status='waiting'`) does not catch different heads. Added the session-row `FOR UPDATE` and a test whose two callers deliberately pick different heads (K19); the lock is on a row outside the entry's write path (§3.28), and the mutant is measured, not predicted.
10. **T7's version allocation** — `max(version)+1` without a lock races to a raw 23505; a `FOR UPDATE` on the encounter row (not otherwise written by `issuePrescription`) serializes it; K30 measured.
11. **The extension cap could be overshot by two simultaneous completions** — the count now runs after a `FOR UPDATE` on the doctor's row (K28's mutant drops the count, not the lock — the lock's own discriminator would need a two-caller race at the cap boundary; declared as covered by the count test only, since a doctor completes one consult at a time by construction).
12. **`sweepAppointmentNoShows` in one bulk UPDATE would emit events outside the claim's transaction** — rewritten per-row (claim + event in one tx), the `runDueTimers` shape.
13. **The realtime tail's first poll would have replayed the look-back window of HISTORY** — added `floor = max(seq) at start` so `from = max(floor, cursor − lookback)`; history is never replayed, late commits inside the window are.
14. **Test-truncation with `RESTART IDENTITY` would silently blind the tail** in every e2e suite booting the app once and truncating per test — the `max(seq) < cursor` reset handles it (tail test 4).
15. **A T2 helper import cycle** — `test/helpers/opd.ts` imports `modules/opd/config` (defaults) and `modules/patients` (index) — both are leaf-ish and neither imports the helper; `activateOpdVisitDefinition` imports `workflow-def` (T3) — added in T3, not T2, so T2 compiles.
16. **`seedSodPairs` idempotency is unknown** (its body was not transcribed) — the helper guards it with a count check instead of assuming.
17. **The e-Rx tamper test** — Plan 05's `slice(0,-2)+"xx"` has a 1-in-4096 flake; T7 flips the LAST character deterministically (`"A"` unless it is `"A"`, then `"B"`), which always changes a base64url signature.

**Pass 2 (numbers and surfaces re-derived):**
18. Ladder arithmetic: `apps/core` 69/396 → T1 71/408 (+2 suites, +12) → T2 75/425 (+4, +17) → T3 78/445 (+3, +20 incl. 3 in `registration.test`) → T4 79/454 → T5 82/474 → T6 84/483 → T7 87/500 → T8 90/517 → T9 91/524 (+1 suite; +6 e2e +1 config) → T10 93/535. `apps/web` 11/37 → 13/48 → 16/57 → 17/63 → 18/68 → 20/76 → 21/80. `packages/contracts` 3/7 untouched. **Measurement before each compile beats these numbers (§2.9).**
19. Every hand-derived instant re-checked: `04:00Z` = 09:30 IST; `03:30Z` = 09:00; `04:50Z` = 10:20; `18:30Z` flips the IST date; `2026-08-17` is a Monday (Jan 1 2026 = Thursday; day-of-year 229 → +228 mod 7 = 4 → Monday); Aug 8 + 7 = Aug 15, + 30 = Sep 7; the IST August bounds are `07-31T18:30Z`–`08-31T18:30Z`.
20. Every consumed signature is transcribed from the scouts (K1/K2/P/W), not recalled: `startInstance(tx, defKey, subject)`, `transition(tx, id, to, actor, opts)`, `findLiveSession(db, token)`, `hasPermission(db, userId, permission, scope)`, `createSession(db, cfg, userId)`, `defineEvent(...).make({actor, payload, patientId?, encounterId?, correlationId?})`, `appendEvent(tx, input)`, `resolvePatientId(db, id)`, `getPatient(db, actor, id)`, `listAllergies(db, patientId)`, `hmacSign/hmacVerify(key, …)`, `CHANGE_CLASS_POLICY.A`, `approveDefinition(db, actor, {definitionId, roleKey, note})`, `activateDefinition(db, actor, id)`, the patients e2e bootstrap, `stubFetch`/`renderWithProviders`.
21. `apps/core/src/modules/opd` never imports `../patients/<file>` — only `../patients` (index); the isolation lint fires on `../[a-zA-Z0-9_-]*/**` except `/index`.
22. Frozen paths audited against every Files list: no task touches `kernel/events`, `kernel/workflow`, `kernel/auth`, `kernel/approvals`, `kernel/modules`, `modules/tariff`, `.github/workflows`, `jest.config.cjs`, `qr.test.ts`; the patients touches are exactly the four named files.

**Pass 3 (stress test over the code blocks — findings folded before commit):**
23. `slots.ts`'s loop condition `s + step <= endMs` drops the partial trailing slot — the T2 test pins it (09:35 at 15 min → two slots).
24. `evaluateVitals` evaluates `rr` even though the default bands do not REQUIRE it — the T6 test pins the "optional field still evaluated" case, so a coder cannot "optimise" it into `required`-only.
25. `orderQueue` sorts a copy (`[...entries]`) — the property P4 (determinism under shuffling) also proves the input is not mutated in a way that changes results.
26. `EventTail.poll` is re-entrancy guarded and never awaits listeners — a slow socket cannot stall the tail.
27. The gateway's `subscribe` reply for a partially-forbidden list: the accepted topics are subscribed and `error { code: "forbidden_topic", topics: [rejected…] }` is sent for the rest — the test asserts both frames.
28. `checkInAppointment` claims the appointment BEFORE `openVisitInTx` (so a concurrent check-in fails fast with zero writes) and sets `encounter_id` AFTER (so a failed open rolls the claim back).
29. The web `RealtimeClient` re-subscribes from the `handlers` map on every `authed` — a reconnect after a token refresh (new socket) restores every active topic; `useRealtime`'s dependency key is the joined topic list, so a re-render with the same topics does not resubscribe (test 6).
30. `TokenSlip` and `RxPrint` share the `.print-doc` block; only ONE `.print-doc` is ever mounted at a time on any screen (the desk shows the slip in a replaced view, the consult screen the Rx in a dialog rendered into the body) — otherwise both would print.

## Test-count ladder (per workspace; baseline measured 2026-08-15 at `2e5144b` — measurement beats this document)

`apps/core`: 69 suites / 396 tests → **T1** 71/408 → **T2** 75/425 → **T3** 78/445 → **T4** 79/454 → **T5** 82/474 → **T6** 84/483 → **T7** 87/500 → **T8** 90/517 → **T9** 91/524 → **T10** 93/535. `apps/web`: 11 files / 37 tests → **T11** 13/48 → **T12** 16/57 → **T13** 17/63 → **T14** 18/68 → **T15** 20/76 → **T16** 21/80. `packages/contracts` 3/7 unchanged throughout. Per-suite counts for touched shipped files (`registration.test`, `config.test`) are stated as deltas — the pre-compile scout measures the absolutes.

## Pipeline Notes (for /execute compilation — do not compile before owner approval)

- **Three pipelines: A = T1–T6, B = T7–T10, C = T11–T16 — strictly sequential within each; A → B → C.** Read A's report before compiling B, B's before C; re-measure per-suite counts with ONE scout immediately before each compile (§2.9) and paste them into the briefs.
- **Tier map:** A: T1 opus (migration) · T2 sonnet · T3 opus (identity + two races) · T4 sonnet · T5 opus (engine + serializer) · T6 sonnet · B: T7 opus · T8 opus (new kernel infra) · T9 opus (40 routes) · T10 opus (perf seed + WS e2e) · C: T11 opus (realtime client) · T12 sonnet · T13 opus (desk) · T14 sonnet · T15 opus (consult) · T16 sonnet. **Opus gate on every task regardless of coder tier.**
- **Cost calibration (calibrated UPWARD for UI, per the owner's instruction):** 06.2's clean rate was 181–368k / mean 246k per backend task incl. gate; Plan 07's backend tasks are larger (a new module, ~40 routes, kernel infra) ⇒ **~300k mean × 10 = 3.0M**; Plan 05's screen tasks ran ~230k and 42% over estimate — with mutants and larger screens ⇒ **~300k × 6 = 1.8M**; plus the explicit **infrastructure contingency 0.3–0.5M per pipeline (≈1.0–1.2M)** that made 06.1/06.2 land inside their bands. **Total budget ≈ 5.2–6.8M subagent tokens; treat ~5.9M as the expected midpoint.** Wall clock ~3–4 h per pipeline at the observed 30–35 min/task ⇒ 9–12 h across the three.
- **Frozen paths while the pipelines run:** every kernel folder EXCEPT the new `kernel/realtime/` (T8) and the two one-line edits (`kernel/db/schema/index.ts` T1; `app.module.ts` T8/T9); `drizzle/**` T1 only; `modules/tariff/**` byte-frozen; `modules/patients/**` except `registration.ts` + `registration.test.ts` + `index.ts` (T3) and `index.ts` (T7); `qr.test.ts`; `test/helpers/db.ts` after T1; `jest.config.cjs`; `.env.example`; `tsconfig*`; `.github/workflows/**` (tripwire 10); `apps/web/src/components/ui/**`; the five Plan 05 screens; `packages/contracts/**`; both `package.json`s and `pnpm-lock.yaml` EXCEPT T5 (fast-check), T6 (script line), T8 (ws) — nothing in C installs anything.
- **Migration rule:** exactly one (T1, `0010`). Any later schema need anywhere = **CHAIN HALT + plan-defect report** (owner halt condition).
- **Compile rules (EXECUTION-LESSONS):** §1 tripwires **1–21 verbatim at the TOP of every brief** (and every scout brief, with the §2.11 output protocol) · briefs point at this committed plan on the server (`docs/superpowers/plans/2026-08-15-phase1-07-opd-encounters.md`) and never restate its code · baseline = "the previous task's commit, i.e. current `origin/main`" (§2.6) · per-suite counts from the pre-compile measurement, stated as beating this document (§2.9) · count criteria never pinned to a path regex a later file could match (§2.5) · FINISH block = three numbered steps commit → `git pull --rebase origin main` → `git push origin main` (§3.8) · gate verdicts carry `retry_mode` (§2.2) · no correction may direct a history rewrite (tripwire 15) or security-code weakening (tripwire 14) · race/isolation evidence only via `pnpm --filter @hmis/core exec jest --passWithNoTests <path> -t "<name>"` with isolation read from OUTPUT (tripwire 19) · every fail-first criterion carries: "…or, if a prior attempt already shipped the artifact, the gate re-derives the Assertion Book rows and re-runs the surviving mutants instead" (§2.8) · after any infra halt, check whether the dead agent pushed before resuming (Plan 06 §7.4) · no scout or audit runs tests concurrently with a pipeline task (tripwire 20) · deviations-not-to-fix in every brief: gate reports 01–06.2 §4/§5 (incl. the `code: message` HTTP prefix on patients/tariff bodies, the open error-code sets, the tariff m2/m4/m9 deferrals), `qr.test.ts`'s flake, and — NEW, not a deviation but a stated convention — the OPD error body `{ statusCode, message, code, detail? }`.
- **Mutant discipline block for every brief (verbatim):** mutants are SEPARATE scratch files beside the source (`*.mutant.ts`/`*.mutant.tsx` + `*.mutant.test.ts(x)`), never edits to shipped files (tripwires 14/21); mutant specs are SELF-CONTAINED (inline seeding; `test/helpers/*` importable, shipped `*.test.ts` files are NOT); run isolated by explicit path (`exec jest --passWithNoTests <path>` / `vitest run <path>`); verdicts reported as DIED/SURVIVED with run counts; the *measure* rows report the observed rate; ALL scratch deleted BEFORE workspace counts and BEFORE commit, `git status` clean; **§2.12 branches: a required-DIED that SURVIVES because the plan's TEST cannot discriminate and the test is your own file ⇒ fix minimally in-task, DISCLOSE in your report, re-run; a survivor that implies the shipped IMPLEMENTATION is wrong, or whose fix reaches outside your Files list ⇒ CHAIN HALT and plan-defect report. Never fix a survivor silently.**
- **Halt conditions (owner-set, in every brief):** a second migration · a required-DIED surviving because the shipped code is wrong · a file outside the Files list · any frozen-path edit · amend/force-push of pushed history · any scope drift toward diagnostics, pharmacy or IPD (the re-entry class, free-text drug lines and the `admission.requested` stub are the whole allowance).
- **Network:** T5 (`fast-check`) and T8 (`ws`, `@types/ws`) run `pnpm add` on the server — a registry failure is INFRA (§2.1), never a defect retry. Pipeline C installs nothing.
- **Go-live items this plan creates (for the gate report's carried-forward list):** `seed:opd` per environment · the `opd_visit` Class-A activation runbook (owner + MS approvals) · role grants for the 14 `opd.*` permissions (recommended table in README) · letterhead + danger ranges + slot/follow-up config reviewed at UAT (`PUT /opd/config`) · departments/rooms/doctors/schedules via `/opd/admin` (200+ doctors — an owner data-entry effort; a CSV import is a candidate fast-follow, NOT this plan) · display TVs opened on `/opd/display?rooms=…` with one Start click · the fifth unscheduled sweep (`sweepAppointmentNoShows`) joins Plan 11's pg-boss list.
- **Carried forward, not this plan's work:** `workflow.controller.ts:142` transitions ordered by bare `at` with no tie-break — Plan 07 touches no workflow read surface, so it stays carried to the next plan that owns one · `qr.test.ts`'s 1-in-4096 flake (untouched here; a future owner of that file) · Plan 08 consumes `opd_encounters.visit_type` / `intended_payer`, `consultation.completed`, and the `index.ts` exports for the pay-before-consult gate and the three-way fee (revisit free) · Plan 09 sets `opd_queue_entries.perk` and `opd_config.perk_every_nth` (the interleave mechanics are shipped and tested) · Plan 10 subscribes to `patient.checked_in`/`queue.called`/`appointment.*`/`doctor_leave.scheduled` for pings and the public queue-position link · Plan 12 owns call-tasks for unresolved `needs_rebooking` and the follow-up-extension pattern report (both derive from shipped events) · per-access break-glass eventing → the EMR plan (again).
- **Events note:** eighteen catalog names + `qr.signature_failed` (**19** `defineEvent` calls — see the D8 erratum), all `module: "opd"`; three ratified catalog additions (`queue.called`, `queue.skipped`, `visit.abandoned`) to be recorded in the gate report; the dispatcher stays unscheduled until Plan 11 and no OPD consumer subscribes through it — realtime rides the gateway's per-process tail.

<!-- PLAN COMPLETE -->
