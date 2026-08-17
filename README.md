# HMIS

Agentic hospital operating system. Specs: `docs/superpowers/specs/`.

## Run locally
1. `docker compose -f docker/docker-compose.dev.yml up -d`
2. `pnpm install && pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core start:dev` → http://localhost:3000/health

## Verify (what CI runs)
`pnpm verify`  — typecheck + lint + tests (needs the compose DB up)

## Auth bootstrap
1. Copy `apps/core/.env.example` → `apps/core/.env` and fill it (`openssl rand -hex 32` for `SECRET_KEY`); `chmod 600`.
2. `pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core seed:admin` (reads `ADMIN_*` from the env)
4. Agents: `pnpm --filter @hmis/core agent:create` (reads `AGENT_NAME`; prints the API key once)

## Workflow engine
Definitions are versioned data (draft → approve per change class → activate; immutable once
active; one active version per key). Instances pin their definition version; transitions
enforce the definition's allowed roles. SLA timers are DB rows: `runDueTimers()` emits
`sla.breached` and climbs escalation ladders — it is UNSCHEDULED until Plan 11 registers it
as a pg-boss cron (owner decision 2026-08-12), same as `runDispatchCycle` and
`sweepExpiredTempRoles`. Authoring flows: POST /workflow/definitions with
`{ key, title, changeClass, initialState, states, transitions }` — every branch must reach
a terminal state or the draft is rejected with the full problem list.

## Approvals engine
One generic mechanism (spec §8): request → approver role → approve/reject with a mandatory
note → event. Every request type is registered configuration backed by a workflow definition
(`approval_<typeKey>`, built by `approvalFlowDefinition`, activated through the workflow
engine's own draft→activate governance), so closure SLAs and escalation ladders run on the
workflow engine's DB-row timers — `runDueTimers()` remains UNSCHEDULED until Plan 11's
pg-boss cron. Requester≠approver is enforced through the seeded `requester_approver` SoD
pair; decisions are single-winner instance transitions. C-12 cumulative same-patient/
same-payee/same-IST-day totals are snapshotted on every money request (report-only —
thresholds arrive with CA configuration in Plans 06/08). Urgency classes
routine|urgent|emergency are fixed per type; act-first-review-after needs the type's
opt-in plus a justification note. Routes: POST /approvals/types · POST /approvals ·
GET /approvals (role-scoped worklist) · GET /approvals/:id · POST /approvals/:id/approve ·
POST /approvals/:id/reject.

## Patients module (Plan 05)

The first domain module: `apps/core/src/modules/patients/` owns the patient master (spec §6).
Other modules reference `patient_id` and import ONLY from `modules/patients/index` (or consume
events) — the module-isolation lint rule enforces it. UHID = `<PREFIX>-<8 digits>-<Verhoeff>`;
phone-first search carries a CI-enforced <300 ms budget (`test/perf-patient-search.test.ts`).
Merge/unmerge are approval-gated through the approvals engine (types `patient_merge`,
`patient_unmerge` — act-first enabled). Guardian majority is read-time-enforced;
`sweepGuardianMajority` is the FOURTH unscheduled sweep (pg-boss cron in Plan 11, with
`runDispatchCycle`, `sweepExpiredTempRoles`, `runDueTimers`).

### Go-live runbook (owner steps, once per environment)
1. Choose the UHID prefix (Class A decision — printed on every card):
   `UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration`
2. Register the merge approval types as data (no code): build each definition with
   `approvalFlowDefinition({ typeKey: "patient_merge" | "patient_unmerge", approverRole: <role>, ... })`,
   draft + activate through `/workflow/definitions` (drafter ≠ activator), then `POST /approvals/types`
   (`patient_unmerge` with `urgencyClass: "urgent", actFirstAllowed: true`).
3. Grant `patients.*` permissions to the registration-desk role; `patients.confidential.read`
   and `patients.merge` only to the roles the owner designates.

## Web app (Plan 05)

`apps/web` — React 19 + Vite 7 SPA (Tailwind 4, shadcn/ui, TanStack Router/Query, RHF+zod,
i18next hi/en, Vitest). Rides root `pnpm verify` (typecheck via `pnpm -r exec tsc --noEmit`,
tests via `pnpm -r test`, lint via root `eslint .`) — CI needed NO change. Dev:
`pnpm --filter @hmis/web dev` (proxies /auth,/patients,/approvals,/workflow to :3000).
Build: `pnpm --filter @hmis/web build` → `apps/web/dist` (served by Caddy in Plan 11).
Screens: registration desk (search-first, C-18 photo confirm, printed QR card), patient
detail, merge review (approval-gated), approvals inbox (generic — serves every engine type).
Keyboard: `/` search · F2 new patient · Alt+M merge · Alt+A approvals · Enter advances ·
Alt+S submits. UI language ≠ patient message language (the latter is a patient field).

## Tariff module (Plan 06)

The second domain module: `apps/core/src/modules/tariff/` owns the service master, versioned
tariffs with the tariff-lock rule, the best-single-benefit adjustment contest, GST computation
with the exemption-boundary logic, and the tariff-revision workflow (spec §7, C-3, D-3, D-8,
§11.11). Other modules import ONLY from `modules/tariff/index` (or consume the
`tariff.revision_applied` / `config.validated` events) — the module-isolation lint rule enforces
it, and `test/tariff-lifecycle.e2e.test.ts` is the executable proof: it drives a full
draft → submit → approve → activate → reprice cycle importing every tariff symbol from the
index alone, never an internal file.

`priceInvoiceLines` and `simulateRevision` are PURE and SYNCHRONOUS: `money.ts`, `types.ts`,
`contest.ts`, `gst.ts`, `pricing.ts`, `simulation.ts` contain no `await`, no import from any
`kernel/` path, no `new Date(`, no `Math.random` — CI greps those exact strings against those
exact files. Everything impure (resolving the active tariff version, loading
services/GST/rules/regulated-prices from the database) lives in `context.ts`'s
`loadPricingContext`, so the golden suite (`golden/fixtures/*.json` + `golden.test.ts`) stays
hermetic — no database, no clock, no randomness — and every fixture's `workings` field is
hand-derived from the spec, never produced by running the engine (the §3.14 defense against an
assertion that passes for the wrong reason). Plan 08 (billing counter) imports
`priceInvoiceLines` + `loadPricingContext` from this index and issues immutable invoices from
`PricedLine[]`; Plan 09 (memberships/coupons) registers two more `AdjustmentSource`s against the
`AdjustmentSource` interface fixed here and adds its own fixtures to THIS harness (same fixture
schema, same `golden.test.ts` count-bump protocol).

### Go-live runbook (owner steps, once per environment)
1. Register the `tariff_revision` approval type as data (no code): build the definition with
   `approvalFlowDefinition({ typeKey: "tariff_revision", approverRole: "owner", ... })`, draft +
   activate through `/workflow/definitions` (drafter ≠ activator), then `POST /approvals/types`.
   The §10.4 Class-A two-key upgrade (owner + Medical Superintendent) is a workflow-definition
   **data** change at that point, not a code change — v1 registers a single approver role
   because the shipped flow builder supports exactly one.
2. `pnpm --filter @hmis/core seed:tariff` (dev-placeholder GST categories/settings/D-8 caps),
   then load the hospital's real tariffs and regulated prices through the `/tariff/services` and
   `/tariff/versions` API.
3. CA sign-off (§19): review every `gst_config`/`gst_settings` row against real practice —
   including **G13's assumption that the room-rent ₹5,000/day threshold compares the
   post-discount charged value**, not the pre-discount tariff — then set `caSigned: true` via
   `PUT /tariff/gst/settings`.
4. `pnpm --filter @hmis/core validate:tariff` must print `ok=true` before the first live invoice
   (D-17) — the golden suite plus this script's printed report is the config-validation
   evidence.

## OPD module (Plan 07)

The third domain module: `apps/core/src/modules/opd/` owns the OPD spine — twelve tables
(`opd_config`, `opd_departments`, `opd_rooms`, `opd_doctors`, `opd_doctor_schedules`,
`opd_doctor_leaves`, `opd_appointments`, `opd_queue_sessions`, `opd_encounters`,
`opd_queue_entries`, `opd_vitals`, `opd_prescriptions`, migration `0010`). Other modules import
ONLY from `modules/opd/index` (or consume its events); the module itself reads no patient table —
demographics, allergies and merge chains come from `modules/patients/index`.

**Encounter lifecycle = workflow DATA.** The `opd_visit` definition (Class A, served verbatim by
`GET /opd/definition`) runs on Plan 03's engine: `registered` (SLA 20 min) → `waiting` (45 min,
`alerting: "active"`, escalation front_office_supervisor@15 / duty_manager@30) → `in_consultation`
(60 min) → `completed`, plus `awaiting_results` (240 min) for the same-day return with results and
the terminal `abandoned`. Transition roles: `registered→waiting` [vitals_desk, nurse, doctor] ·
`waiting→in_consultation` [doctor] · `in_consultation→completed|awaiting_results` [doctor] ·
`awaiting_results→waiting` [front_office, vitals_desk, nurse, doctor] ·
`{registered,waiting,awaiting_results}→abandoned` [front_office, front_office_supervisor].
`opd_encounters.status` MIRRORS the instance and is written by exactly one function
(`moveEncounter`) in the same transaction as the engine's single-winner transition; the engine's
`stale_transition` / `instance_not_active` / `unknown_transition` all surface as ONE OPD code,
`encounter_state_conflict`.

**Visit type** is auto-detected at visit open: the anchor is the patient's most recent COMPLETED
encounter in the SAME department (across the merge chain). None ⇒ `new`; else `revisit` when the
inclusive IST day gap is ≤ that encounter's own `follow_up_days` (config default 7; a doctor may
set 15/21/30 at completion, capped per doctor per IST month), else `renewal`. Plan 08 branches its
fee on `visit_type` (revisit free).

**Tokens and queue.** One `opd_queue_sessions` row per doctor per IST day carries the token counter
(`UPDATE … SET next_token = next_token + 1 RETURNING`) and the call counter. Priority classes:
**0** danger vitals · **1** same-day re-entry · **2** DUE appointments (late never expires) ·
**3** walk-ins FIFO · **4** FUTURE appointments — so a walk-in beats a future appointment, never a
due one. Within 0/1/3 by `eligible_at` then the bigserial `seq` (arrival order — never the ULID id);
within 2/4 by `appointment_at` then `seq`. A skip re-queues with `eligible_at = now` (the patient
loses their place, never their token) and becomes `left` after `max_skips_before_left`. A re-entry
reuses the token. The E-32 perk hook (`perk_every_nth`) is shipped but OFF (null in the seed): Plan
09 sets it, and it can never overtake classes 0–2. Public surfaces (display board) carry token,
room and doctor only — never patient identity.

**Vitals** are age-banded (`infant` <1 · `child_1_5` <6 · `child_6_12` <13 · `adult`; unknown DOB ⇒
adult) with per-band required fields and inclusive danger bounds, all config data in
`opd_config.danger_ranges` (India-standard first values — clinical staff revise at UAT). Weight is
required under 18 (§11.8). A breach mints `vitals.danger_flagged`, flags the encounter and its
waiting queue entry (class 0), and NEVER auto-clears in Plan 07 — a later normal reading leaves the
flag, so the doctor sees the history.

**e-Rx.** Prescriptions are versioned per encounter (a re-issue supersedes; exactly one `active`
row). Every line is matched case-insensitively, in both directions, against the patient's ACTIVE
allergies: a match without a per-line reasoned override is `allergy_conflict` (409, matches in
`detail`). The stored document is a FHIR-shaped Bundle. The printed QR payload is
`rx1.<prescriptionId>.<encounterId>.<version>.<sig>`, HMAC-signed under `SECRET_KEY`;
`POST /opd/prescriptions/verify` always answers HTTP 200 — `{ ok: true, … }` or `{ ok: false,
reason: "malformed" | "invalid_signature" | "stale_version" | "unknown_prescription" }` — and every
failure appends `qr.signature_failed`. There is deliberately no signature line on the print (owner
decision: the signed QR is the authentication).

**Error body.** OPD refusals return an OBJECT: `{ statusCode, message, code, detail? }` — six
screens and the pharmacy scanner branch on `code`, and the allergy warning has to carry its matches.
This is deliberately WIDER than the patients/tariff modules' `code: message` string bodies; neither
side is realigned.

**Events** (all `module: "opd"`): `appointment.booked` · `appointment.rescheduled` ·
`appointment.cancelled` · `appointment.no_show` · `doctor_leave.scheduled` · `visit.opened` ·
`patient.checked_in` · `visit.transferred` · `visit.abandoned` · `vitals.recorded` ·
`vitals.danger_flagged` · `queue.called` · `queue.skipped` · `consultation.started` ·
`consultation.completed` · `prescription.issued` · `referral.issued` · `admission.requested`, plus
`qr.signature_failed` for e-Rx scans.

**Sweeps.** `sweepAppointmentNoShows` is the FIFTH unscheduled sweep — Plan 11 registers all five as
pg-boss crons: `runDispatchCycle`, `sweepExpiredTempRoles`, `runDueTimers`, `sweepGuardianMajority`,
`sweepAppointmentNoShows`.

**Perf budgets** are CI-enforced in `test/perf-opd-queue.test.ts` (300 doctor-days × 60 entries,
200k completed historical encounters): `listQueue` < 100 ms, `openVisit` including the visit-type
anchor < 100 ms, `boardSnapshot` over 300 sessions < 500 ms, and `EXPLAIN (FORMAT JSON)` proves no
`Seq Scan` on `opd_queue_entries` or `opd_encounters`.

**Permissions (14) and the recommended grants.** Route access is permission-gated; the encounter's
STATE MOVES are additionally gated by the workflow definition's role keys (`front_office`,
`front_office_supervisor`, `vitals_desk`, `nurse`, `doctor`), so a desk user needs both the
permission and the role.

| Permission | front_office | front_office_supervisor | vitals_desk | doctor | opd_admin | display | pharmacy |
|---|---|---|---|---|---|---|---|
| `opd.masters.read` | ✓ | ✓ | | ✓ | ✓ | | |
| `opd.masters.manage` | | | | | ✓ | | |
| `opd.config.manage` | | | | | ✓ | | |
| `opd.appointments.read` | ✓ | ✓ | | ✓ | ✓ | | |
| `opd.appointments.manage` | ✓ | ✓ | | | | | |
| `opd.visits.read` | ✓ | ✓ | ✓ | ✓ | | | |
| `opd.visits.open` | ✓ | ✓ | | | | | |
| `opd.vitals.record` | | | ✓ | ✓ | | | |
| `opd.queue.read` | ✓ | ✓ | ✓ | ✓ | | | |
| `opd.queue.operate` | | | | ✓ | | | |
| `opd.queue.transfer` | | ✓ | | | | | |
| `opd.consult` | | | | ✓ | | | |
| `opd.prescriptions.verify` | | | | | | | ✓ |
| `opd.display.read` | | | | | | ✓ | |

Plan 05's `patients.register` / `patients.read` (and `patients.update` for quick allergies) stay
with the desk and vitals roles — the OPD screens read demographics through the patients module.

### Go-live runbook — OPD (owner steps, once per environment)
1. `pnpm --filter @hmis/core seed:opd` — the `opd_config` row (slot length, follow-up defaults,
   danger ranges, letterhead, skip cap; perk hook off), the OPD role keys and the placeholder
   departments. Idempotent.
2. Assign the roles: the seed CREATES role keys, never grants them. Grant the `opd.*` permissions
   per the table above and assign each user their role(s) at hospital scope.
3. Activate the `opd_visit` definition (Class A, two-key): `GET /opd/definition` → post that exact
   JSON to `POST /workflow/definitions` as a user with `workflow.definitions.draft` →
   `POST /workflow/definitions/:id/approve` by an `owner`-role user AND by a
   `medical_superintendent`-role user → `POST /workflow/definitions/:id/activate` by a THIRD user
   with `workflow.definitions.activate` (drafter ≠ activator). No OPD visit can be opened before this.
4. Enter departments, rooms, doctors (by username — the user must exist) and weekly schedules in
   the admin screen `/opd/admin`.
5. `PUT /opd/config`: the hospital letterhead and the danger ranges reviewed and signed off by
   clinical staff at UAT; slot length and follow-up window if they differ from 10 min / 7 days.
6. Display board: open `/opd/display?rooms=<roomIds>` on the counter TV and click Start ONCE —
   browser speech needs a user gesture before it may speak.

## Realtime (WebSocket) protocol

One endpoint, `/ws`, on the same host and port as the HTTP API (`kernel/realtime/`). The client
sends JSON text frames:

- `{"type":"auth","token":"<the same bearer session token HTTP uses>"}` — MUST be the first frame,
  within 5 s, or the server sends `{"type":"error","code":"auth_timeout"}` and closes with 4001. The
  token is never put in the URL: proxies log query strings.
- `{"type":"subscribe","topics":[…]}` / `{"type":"unsubscribe","topics":[…]}` · `{"type":"ping"}`.

The server replies `{"type":"authed","userId"}` · `{"type":"subscribed","topics"}` ·
`{"type":"unsubscribed","topics"}` · `{"type":"pong"}` ·
`{"type":"error","code":"unauthorized"|"auth_timeout"|"bad_message"|"forbidden_topic","topics"?}`,
and pushes `{"type":"event","topic","name","seq","occurredAt","payload"}`. A partially forbidden
subscribe list is answered BOTH ways: the allowed topics come back `subscribed`, the rest as
`forbidden_topic`.

Topics are namespaced by a registered prefix, each carrying the permission a subscriber must hold
(checked per subscribe, so agents — which hold no permissions — cannot subscribe):

| Topic | Permission | Pushed on |
|---|---|---|
| `queue:<doctorId>:<serviceDate>` | `opd.queue.read` | the doctor-day's queue, vitals, visit and consultation events |
| `display:<roomId>` | `opd.display.read` | the same events for that room's doctor-day |
| `encounter:<encounterId>` | `opd.visits.read` | that encounter's own events |

**Pushes are HINTS, not the source of truth.** Every subscribing screen also polls its read model
every 15 s, so a dropped socket or a missed frame costs seconds of freshness, never correctness.

**Multi-process by construction.** Fan-out reads the `events` table through a per-process tail
(cursor over `events.seq` with a look-back window for out-of-order commits and a bounded dedupe
set), never an in-memory emitter — so an event appended by ANY process reaches EVERY process's
sockets, and the gateway needs no sticky sessions and no broker.
