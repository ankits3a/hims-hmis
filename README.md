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

## Web app: OPD screens (Plan 07)

Six screens ride the `apps/web` scaffold from Plan 05 (React 19, Tailwind 4, shadcn/ui, TanStack
Router/Query, i18next hi/en, Vitest). The Shell's OPD nav links render for EVERYONE — the client
holds no permission model of its own; the server's 403 on the underlying route is what actually
decides who may use a screen.

| Route | Screen | Expected role(s) |
|---|---|---|
| `/opd/appointments` | Appointments — slot grid, booking, day list, reschedule/cancel, needs-rebooking, check-in with the printed token slip | `front_office`, `front_office_supervisor` (read-only for `doctor`, `opd_admin`) |
| `/opd/desk` | OPD desk — walk-in visit opening, today's arrivals check-in, live queue overview, abandon, the supervisor's E2 transfer | `front_office`, `front_office_supervisor` |
| `/opd/vitals` | Vitals desk — worklist, band-aware capture, danger flags, quick allergy | `vitals_desk`, `doctor` |
| `/opd/consult` | Consultation — live queue with call/skip/start, patient panel, note + Rx editor, completion, printed e-Rx | `doctor` |
| `/opd/display[?rooms=<roomIds>]` | Token display board — waiting-room TV board with bilingual speech calling | `display` (a kiosk account holding only `opd.display.read`) |
| `/opd/admin` | OPD masters — departments, rooms, doctors, weekly schedules, leaves | `opd_admin` |

See the OPD module's permission table above for the exact grant per route.

**Shortcuts.** Global (bound once in `keyboard.tsx`, mounted in the authed Shell): `/` search ·
F2 new patient · Alt+M merge · Alt+A approvals · Alt+P appointments · Alt+D OPD desk · Alt+V
vitals · Alt+C consultation. The consultation screen additionally binds its OWN screen-local
shortcuts (a `useEffect` keydown handler private to that screen, not `keyboard.tsx`): Alt+N call
next · Alt+K skip · Alt+S start / issue (context-dependent) · Alt+Enter complete.

**The display board's Start button.** `/opd/display` (optionally `?rooms=<comma-separated room
ids>`, no filter ⇒ every session of the day) boots into a gate showing only a Start button — no
`WebSocket` connects and no board data is fetched until it is clicked. Browsers refuse speech
synthesis (and may refuse socket-driven audio) without a prior user gesture, so Start supplies
that gesture: afterwards the board's `GET /opd/queues/board` fires, the socket subscribes to
`display:<roomId>` for each room in scope, and a `queue.called` frame speaks the token twice —
Hindi first (`hi-IN`), then English (`en-IN`) — while patching that room's NOW SERVING
immediately, ahead of the next poll. The board shows token, room and doctor ONLY — never a
patient name or UHID (§14); go-live runbook step 6 above covers deploying it to the counter TV.

**Realtime pushes are hints.** Every OPD screen — the display board included — BOTH subscribes to
its realtime topics AND polls its read model every 15 s (`refetchInterval: 15_000`); a missed or
delayed WebSocket frame costs a screen seconds of staleness, never correctness.

## Billing module (Plan 08)

The fourth domain module: `apps/core/src/modules/billing/` owns the money spine — invoices,
credit notes, the receipts+allocations ledger, cashier sessions, refund vouchers, tender
reconciliation and the daily close. Other modules import ONLY from `modules/billing/index` (or
consume its events); billing itself reads no OPD, patient or tariff table directly — every
cross-module read goes through `modules/opd/index`, `modules/patients/index` or
`modules/tariff/index`.

**The ledger, in three sentences.** Money in is one instrument: append-only `receipts` (mixed
cash/UPI/card tenders) and append-only `allocations` (receipt → invoice, `apply` or `reverse`) —
nothing in the ledger is ever updated or deleted, and a `receipts` row with nothing allocated
against it IS a patient advance. Settlement (`unpaid|partial|settled`) is DERIVED —
`netPayable − credited (live credit notes) − allocated`, floored at zero — never a stored status
column, which is what keeps the six-table immutability below total. Partial settlement is
first-class, not an edge case: dues and advances are the SAME mechanism, clearing dues needs no
special permission because taking money is always safe, and the two acts this module actually
gates are issuing an invoice UNSETTLED (`billing.credit.extend`, capped, approval above cap) and
shrinking a receivable (`billing.credit_note.issue` with its own cap/approval, or a
`billing.refund.*` voucher, approval-gated always).

**Structural immutability.** `invoices`, `invoice_lines`, `credit_notes`, `credit_note_lines`,
`receipts` and `allocations` carry a `BEFORE UPDATE OR DELETE` trigger that raises — six tables,
proven by migration (0012), not by convention. The module's mutable surface is exhaustively:
`receipt_tenders` (the E-25 lifecycle state), `refund_vouchers` (`issued → paid`),
`cashier_sessions` (`open → closing → closed`), `document_series.next_no`, `billing_config`, and
the `daily_closes` claim row. Every document series is per-fiscal-year and row-locked
(`INV/26-27/000001`), and every threshold below is `billing_config` DATA a CA reviews — never a
code constant.

**Events** (all `module: "billing"`, exactly twenty names): `invoice.issued` ·
`invoice.credit_extended` · `receipt.recorded` · `payment.received` · `advance.received` ·
`allocation.reversed` · `credit_note.issued` · `refund_voucher.issued` · `payment.refunded` ·
`cashier_session.opened` · `cashier_session.closed` · `variance.flagged` ·
`cash_threshold.warned` · `cash_threshold.blocked` · `tender.reconciled` · `tender.mismatched` ·
`degraded_mode.changed` · `document.entered_in_error` · `charge.orphan_flagged` · `day.closed`.
The dispatcher stays unscheduled until Plan 11; billing screens (Plan 08 pipeline C) poll rather
than subscribe — there are no billing realtime topics yet.

**The pay-before-consult gate.** `modules/opd/consultation.ts` carries a keyed guard registry
(`registerConsultStartGuard`, dependency-inverted so OPD ships with zero billing import); billing's
`OnModuleInit` registers `billing_fee_gate` against it. A `new`/`renewal` visit with no
settled-or-credit-extended fee invoice refuses `startConsultation` with `OpdError
"consult_gate_refused"` (409, carrying `{ guard, code: "fee_unsettled" }` in `detail`); `revisit` is
FREE and always passes. `runDailyClose`'s orphan scan is the safety net for anything the counter
missed — nothing auto-charges.

### Route table (31 routes, one controller, `@Controller("billing")`)

| Method | Route | Notes |
|---|---|---|
| POST | `/billing/invoices` | issue (receipt + credit lane inline) |
| POST | `/billing/invoices/preview` | price a draft, persist nothing |
| GET | `/billing/invoices` | list, filter `patientId`/`encounterId` |
| GET | `/billing/invoices/:id` | detail + derived settlement |
| GET | `/billing/invoices/:id/print` | letterhead, lines, settlement, signed QR |
| POST | `/billing/invoices/:id/credit-notes` | `refund` \| `clearance_discount` \| `correction` |
| GET | `/billing/invoices/:id/credit-notes` | list for one invoice |
| GET | `/billing/visits/:encounterId/fee-quote` | the D8 branch + a priced preview |
| POST | `/billing/receipts` | standalone receipt (advance lane) |
| GET | `/billing/receipts` | list, filter `patientId` |
| POST | `/billing/receipts/:id/allocations` | apply toward one invoice (partial allowed) |
| POST | `/billing/allocations/:id/reverse` | append the mirror `reverse` row |
| POST | `/billing/eie` | mark a receipt entered-in-error; reverses its live allocations |
| GET | `/billing/patients/:patientId/balance` | advance + outstanding + dues |
| GET | `/billing/patients/:patientId/dues` | unsettled invoices, oldest first |
| POST | `/billing/refunds/request` | files the mandatory `billing_refund` approval |
| POST | `/billing/refunds` | issue the voucher (check-on-execute) |
| POST | `/billing/refunds/:id/pay` | disburse; payee identity required, every method |
| GET | `/billing/refunds` | worklist, filter `patientId`/`status` |
| POST | `/billing/sessions` | open (one live session per cashier) |
| GET | `/billing/sessions/current` | the caller's own open/closing session |
| POST | `/billing/sessions/:id/close` | denominations → counted, variance, approval if any |
| POST | `/billing/sessions/:id/confirm-close` | check-on-execute against the granted variance approval |
| GET | `/billing/sessions` | worklist, filter `cashierUserId`/`status` |
| POST | `/billing/recon/upload` | `{ csv, source }` statement match |
| GET | `/billing/recon/mismatches` | the open mismatch worklist |
| GET | `/billing/day-book` | receipts by mode, invoices, CN, vouchers, degraded breakout |
| GET | `/billing/gstr1` | `(sacCode, rateBps, exempt)` groups from STORED line heads |
| GET | `/billing/config` | the D-17 row |
| PUT | `/billing/config` | admin patch, validated before write |
| PUT | `/billing/degraded` | the E-24 toggle |

Error body: the OPD convention `{ statusCode, message, code, detail? }` (billing is a new module;
patients/tariff keep their own ratified `code: message` string bodies — neither side is
realigned).

### Recommended permission grants

`billing.credit.extend` guards no route of its own — it is checked INSIDE the issue transaction,
on the same `POST /billing/invoices` a plain issue uses. Every other permission below maps
one-to-one to a route above.

| Permission | cashier | billing_manager |
|---|---|---|
| `billing.invoice.issue` | ✓ | |
| `billing.invoice.read` | ✓ | ✓ |
| `billing.credit.extend` | ✓ | |
| `billing.receipt.record` | ✓ | |
| `billing.credit_note.issue` | ✓ | |
| `billing.refund.request` | ✓ | |
| `billing.refund.pay` | ✓ | |
| `billing.session.own` | ✓ | |
| `billing.allocation.reverse` | | ✓ |
| `billing.session.read` | | ✓ |
| `billing.recon.upload` | | ✓ |
| `billing.reports.read` | | ✓ |
| `billing.config.write` | | ✓ |
| `billing.eie.mark` | | ✓ |
| `approvals.requests.read` / `.decide` | | ✓ |

The split follows the owner's ruling that taking money and issuing a routine bill is a cashier's
ordinary work; the two acts that need a second set of eyes — issuing UNSETTLED and shrinking a
receivable — stay cap/approval-gated (D2/D4/D6) rather than walled off the cashier entirely, so
the counter can act under the cap without waiting on a supervisor. Reversing an allocation,
voiding a document (EIE) and reconciling statements are back-office corrections, not counter
actions, so they sit with `billing_manager` alone; `billing_manager` is also the `approverRole` on
all five billing approval types (below), so it needs the generic approvals permissions too.

### Go-live runbook (owner steps, once per environment)

1. `pnpm --filter @hmis/core seed:billing` — the `billing_config` row (dev-placeholder
   thresholds), roles `cashier`/`billing_manager` (created, not granted), and the five approval
   types below. Idempotent.
2. **CA review, every threshold against its statutory anchor** — `billing_config` is DATA, never a
   code constant:
   - `cashWarnPaise` / `cashBlockPaise` — **§269ST**: cash receipts of ₹2,00,000 or more from ONE
     person in a day are prohibited; the seeded block sits AT that ceiling with a warn step below
     it so the counter sees it coming.
   - `panThresholdPaise` — **Rule 114B**: a single cash transaction (or connected transactions) of
     ₹50,000 or more needs the payer's PAN or a Form 60 declaration; the seeded default sits at
     that ceiling.
   - the rounding behaviour itself (no config — it is how `totalInvoice` computes
     `netPayablePaise`) — **§170 CGST Act**: round the tax invoice value to the nearest rupee,
     applied ONCE, to the invoice's raw total, never per line and never inside a credit note's own
     shares (D3/D4).
   - the 16-character invoice-serial ceiling (**GST serial numbering rules**) —
     `INV/26-27/000001` is 16 characters exactly; see watch item (a) below.
   - `refundBankAbovePaise`, `creditCapPaise`, `outstandingCapPaise`, `feeBps`,
     `reconTolerancePaise` carry no external statute — hospital policy, reviewed the same way.
3. Flip `caSigned: true` via `PUT /billing/config` once every threshold above is reviewed — but
   see watch item (b): the flip today is a paper record, not something the validate gate checks.
4. `pnpm --filter @hmis/core validate:billing` must print `ok=true` before the first live invoice
   (D-17) — it checks `chargeRules` against live `services`, the warn/block ordering and
   `seriesPrefixes` completeness through the SAME loaders the runtime uses (the M1 lesson); see
   watch item (a) for what it does NOT check.
5. Confirm the five approval types are registered (`seed:billing` does this; a re-run is a no-op)
   — `billing_credit_extension`, `billing_discount`, `billing_clearance_discount`,
   `billing_refund`, `billing_variance`, all `approverRole: "billing_manager"`.
6. Grant roles per the table above; every billing approval resolves to `billing_manager` — grant
   `approvals.requests.read`/`.decide` there too, or nobody can ever clear one.
7. **FY-rollover check, first week of April:** the series counters are per-`(seriesKey, fy)` and
   cold-start at 1 automatically — confirm the first April invoice of each series actually reads
   `.../27-28/000001`, not a continuation of the prior year's count.

**Five watch items carried from pipeline A — read before trusting the numbers above:**

(a) **`nextDocNo` pads to 6 digits unconditionally.** Serial 1,000,000 in a single fiscal year
    renders `INV/26-27/1000000` — 17 characters, one past the GST ceiling — with no runtime guard.
    `billing_config.seriesPrefixes` values are validated only as `z.string().min(1)`, no maximum,
    so an admin patch to `{ invoice: "INVOICE" }` produces a 20-character serial and
    `validateBillingConfig` still reports `ok: true`. Neither is a go-live blocker at Phase-1
    volumes, but nobody should assume the gate already catches this.
(b) **`validate:billing` returns `ok: true` on a config with `caSigned: false`.** D-17 frames the
    gate as the thing that blocks the first live invoice until the CA has signed off; today it does
    not read that flag at all. Until the gate is extended, step 3 above is the substitute: a human
    confirms the review happened before flipping the flag, because nothing currently verifies that
    the flip itself is honest.
(c) **The `billing_variance` approval carries no `amountPaise`.** The kernel's general shape
    (`requestApproval`) expects a positive `amountPaise` plus a `patientId` or `payeeId`; a session
    variance is signed (can be negative) and belongs to neither a patient nor a payee, so it rides
    the request note instead. The variance value is readable from the `variance.flagged` event and
    from `cashier_sessions.variance_paise` — never from the approval row itself.
(d) **Any non-zero variance locks the cashier out of ALL counter work**, not just session-close,
    until a `billing_manager` grants the variance approval: `beginClose` moves the session to
    `closing`, and every receipt/voucher-pay route requires the ACTING cashier's session to be
    `open`. Correct by design (a drawer under dispute should not keep taking money), but it is an
    operational surprise the first time a cashier meets it — train them on it before go-live, and
    make sure a `billing_manager` is reachable during counter hours.
(e) **`hmis_dev` already carries migrations `0011`+`0012` and a seeded `billing_config` row**
    (applied by pipeline A's `pnpm db:migrate` / `seed:billing`) — a fresh environment gets both
    from step 1 above; this note is only for anyone inspecting the shared dev database directly.

## Web app: billing screens (Plan 08)

Four keyboard-first screens ride the same `apps/web` scaffold as the OPD screens. As there, **the
client holds no permission model of its own** — every billing nav link renders for everyone, and the
server's 403 on the underlying route is what actually decides who may use a screen. A refusal is
rendered inline, in the server's own words, wherever the user was standing.

| Route | Screen | Expected role(s) |
|---|---|---|
| `/billing[?encounterId=<id>]` | Billing counter — fee quote, line editor with the live priced preview and its contest, mixed tenders, the credit lane, the printed invoice | `cashier` |
| `/billing/dues` | Dues & advances — one ledger: outstanding per invoice, partial dues clear, clearance discount, advance take/apply | `cashier` |
| `/billing/session` | Cashier session — open with a float, denomination count-down, variance and its approval wait | `cashier` |
| `/billing/office` | Back office — refund request/issue/pay worklist with guard flags, entered-in-error correction, statement reconciliation, day book, GSTR-1 | `billing_manager` |

`cashier` gets the counter, dues and session screens; `billing_manager` adds the back office and the
`billing_config` surface (`PUT /billing/config`, `PUT /billing/degraded`), and is the `approverRole`
on all five billing approval types. See the module's permission table above for the exact grant per
route — `/billing/office` reads `billing.reports.read` and writes through `billing.refund.*`,
`billing.recon.upload` and `billing.eie.mark`, none of which a cashier holds.

**Shortcuts.** Alt+B opens the counter (global, `keyboard.tsx`). The back office binds its own
screen-local digit keys — `1` refunds, `2` reconciliation, `3` day book, `4` GSTR-1 — which are
ignored while the focus is in a field, so typing an amount never changes tabs.

**The wedge-scanner lane (UAT item closed).** `PatientPicker`'s scan input accepts a keyboard-wedge
barcode/QR scanner as well as a paste: the buffer is an ACCUMULATOR and **Enter is the trigger**, so
a scanner that types a UHID in under 30 ms and a human who types the same UHID slowly both verify
through the identical call. The 500 ms idle timer only auto-CLEARS a stale buffer; it is not a speed
gate, and no scanner needs configuring beyond "send Enter after the payload". The input itself
carries `data-search-input`, so `/` focuses it on every screen that mounts the picker.

**Polling, not push.** Billing publishes no realtime topics this plan — deliberately. Every billing
screen refreshes its read model on the same 15 s convention as the OPD screens
(`refetchInterval: 15_000`): the counter's fee-quote sidebar, the dues balance, the cashier's own
drawer, and the back office's refund and mismatch worklists. A money worklist that is seconds stale
is correct; one that is wrong is not.

**Degraded-tender mode (E-24).** When `billing_config.degraded_tender` is on, a UPI or card tender
needs a **hand-typed reference** and the receipt is stamped `degraded: true`. Operationally that
means: the counter keeps taking money while the PSP terminal is down, the day book breaks the
degraded receipts out as their own figure, and reconciliation should be run against those first —
hand-typed references are where the ref that never matches comes from. Turn it off (`PUT
/billing/degraded`, with a reason) as soon as the terminal is back; nothing turns it off by itself.

**Two operating notes the screens render rather than hide.** A non-zero cashier-session variance
moves the drawer to `closing` and locks that cashier out of all counter work until a
`billing_manager` grants the variance approval (watch item (d) above) — the session screen says so on
screen. And a clearance discount is refused `over_cap` on any category with no cap rule configured,
which on a freshly seeded environment is EVERY category: the dues screen renders that as a
configuration message naming the category, not as a money refusal, because an administrator has to
add the cap rule in the tariff module before the lane works at all.

**The day book is read live.** `/billing/office` reads `GET /billing/day-book?day=` rather than the
totals stored on `daily_closes`: `runDailyClose` computes its totals outside the claim transaction,
so a document that commits in that window is permanently absent from the stored close and no re-run
repairs it. The screen renders the API's figures **verbatim** — it folds nothing of its own, and the
GSTR-1 view likewise prints the stored per-line tax heads summed, never re-derived from a group's
taxable value (§170/§15.1: heads are summed, never recomputed).
