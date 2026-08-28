# HMIS

Agentic hospital operating system. Specs: `docs/superpowers/specs/`.

## Run locally
1. `docker compose -f docker/docker-compose.dev.yml up -d`
2. `pnpm install && pnpm --filter @hmis/core db:migrate`
3. `pnpm --filter @hmis/core start:dev` → http://localhost:3000/health
   (known issue since Plan 07, §2.58: this crashes at `OpdRealtimeRegistrar.onModuleInit` because
   `tsx`'s esbuild transform emits no `design:paramtypes` metadata for Nest's constructor
   injection. Production never hits it — see **Deployment (Plan 11a)**'s run-commands note below
   for the compiled command that does start clean.)

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
`sla.breached` and climbs escalation ladders — it runs on a clock as of Plan 08.5 (the worker
process's scheduler; see **Worker process** below), same as `runDispatchCycle` and
`sweepExpiredTempRoles`. Authoring flows: POST /workflow/definitions with
`{ key, title, changeClass, initialState, states, transitions }` — every branch must reach
a terminal state or the draft is rejected with the full problem list.

## Approvals engine
One generic mechanism (spec §8): request → approver role → approve/reject with a mandatory
note → event. Every request type is registered configuration backed by a workflow definition
(`approval_<typeKey>`, built by `approvalFlowDefinition`, activated through the workflow
engine's own draft→activate governance), so closure SLAs and escalation ladders run on the
workflow engine's DB-row timers — `runDueTimers()` runs on the worker's clock as of Plan 08.5
(see **Worker process** below). Requester≠approver is enforced through the seeded `requester_approver` SoD
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
`patient_unmerge` — act-first enabled; `executeMerge` itself stays check-on-execute BY DESIGN,
never an event consumer — a merge is a synchronous admin action a human is waiting on at the
screen, and the worker existing does not change that). Guardian majority is read-time-enforced;
`sweepGuardianMajority` is one of the worker's six scheduled sweeps as of Plan 08.5 (daily 00:05
IST — see **Worker process** below), alongside `runDispatchCycle`, `sweepExpiredTempRoles`,
`runDueTimers`, `sweepAppointmentNoShows` and `runDailyClose`.

### Go-live runbook (owner steps, once per environment)
1. Choose the UHID prefix (Class A decision — printed on every card):
   `UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration` — production runs `U`
   (owner ruling 2026-08-25), giving UHIDs of the form `U12345013`: the prefix, a 7-digit serial
   and a Verhoeff check digit, nine characters with no separators. See **UHID format** below.
2. Register the merge approval types as data (no code): build each definition with
   `approvalFlowDefinition({ typeKey: "patient_merge" | "patient_unmerge", approverRole: <role>, ... })`,
   draft + activate through `/workflow/definitions` (drafter ≠ activator), then `POST /approvals/types`
   (`patient_unmerge` with `urgencyClass: "urgent", actFirstAllowed: true`).
3. Grant `patients.*` permissions to the registration-desk role; `patients.confidential.read`
   and `patients.merge` only to the roles the owner designates.

### UHID format (owner ruling 2026-08-25 — replaces `<PREFIX>-<8 digits>-<check>`)
`<PREFIX><7-digit serial><Verhoeff check digit>` — production: `U12345013`. Nine characters, no
separators, because a UHID is typed into a search box far more often than it is read off a card.
The check digit is Verhoeff (Aadhaar's algorithm, Plan 05 Q6, retained): it rejects every
single-digit typo and every adjacent transposition before one can land a desk on a stranger's chart.

**Serials 1–1,234,500 are reserved and carry NO meaning.** The floor exists so the first card reads
`U12345013` rather than `U00000017`, and so a memorable number can be minted by hand one day. It is
deliberately **not** a VIP or membership band: a UHID is printed, spoken across a counter and texted,
so a semantic range would broadcast exactly what `patients.is_confidential` (§14) exists to seal —
and status is revocable while a UHID is not. VIP is `is_confidential`; membership is Plan 09's
instrument record. `allocateUhid` refuses any serial inside the band, so a counter reset below the
floor halts registration loudly instead of quietly issuing a reserved number.

Search accepts `U12345013`, `u12345013`, bare `12345013`, the leading serial without the check digit,
any trailing run of 4+ digits, and any of those with stray spaces or hyphens.

**Re-minting old-format patients** (commissioning only — this renumbers people, which is normally
the one thing a UHID exists to prevent). **Re-seed the prefix FIRST**: the script mints through
`allocateUhid`, which reads `registration_config`, so running it before step 1 above would stamp
every patient with the OLD prefix and leave nothing for a second run to fix (it is idempotent on
format, not on prefix). Order: `UHID_PREFIX=U … seed:registration`, then
`DRY_RUN=1 pnpm --filter @hmis/core remint:uhids` to see the census, then the same command without
`DRY_RUN` to write. Old ids are parked in `legacy_uhid` and
`qr_version` is bumped so every card printed under the old format fails verification rather than
resolving to a number its patient no longer has.

## Episode numbers — V/A/L/S/R/P (owner ruling 2026-08-25)
`<letter><YYMMDD><4-digit daily serial>`, eleven characters, no separators. The counter resets each
day and is keyed on the **service date**, never the insert instant.

| Letter | Document | Allocated today? |
|---|---|---|
| `V` | Visit / encounter — `V2608250147` | yes, at `openVisit` |
| `A` | Appointment — `A2608250042` | yes, at booking and at reschedule |
| `L` | Lab order | reserved — lab module not built |
| `S` | Lab specimen / accession | reserved |
| `R` | Radiology order | reserved |
| `P` | Pharmacy dispense | reserved |

**This is deliberately not the UHID's design and not the invoice's.** A UHID names a person and is
typed constantly, so it spends nothing on self-description. An episode number names an event and is
mostly printed, scanned and stuck to a tube or a film jacket, so it carries its own date. An invoice
number is `INV/2627/000123` because GST demands a per-fiscal-year consecutive serial — tax law, not
usability — which is why `episode_series` is a **separate table** from `document_series`: the two
counters answer to different authorities and nobody tidying a clinical counter should be one typo
from resetting a statutory one. Gaplessness is required of the GST series and **not** of this one.

**One encounter = one visit number, including same-day re-entry.** A patient sent back through the
queue after results is on the same visit; the token is reused and so is the `V` number. Minting a
second there would attach results to a visit that never ordered them.

`L`/`S` are two numbers because an *order* ("CBC + LFT") and a *specimen* (the tube) are different
objects — one order yields several tubes — and a single number cannot express a haemolysed sample
being redrawn without cancelling the order. A lab or radiology order must also be able to exist
**without** a parent visit: direct walk-in tests and camp screenings are real, and a number that
requires a visit forces staff to fake one.

**The date reads YYMMDD, which is ambiguous to an Indian desk** — `260825` is 25-Aug-2026 here and
26-Aug-2025 under DD-MM-YY. YYMMDD is kept because it makes the id sort chronologically; the
mitigation is that every artifact prints a human date beside it. The token slip binds them on one
line (`V2608170001 · 17-Aug-2026`); the e-Rx already carries a four-digit-year date of its own.

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
1. ~~Register the `tariff_revision` approval type as data (no code): build the definition with
   `approvalFlowDefinition({ typeKey: "tariff_revision", approverRole: "owner", ... })`, draft +
   activate through `/workflow/definitions` (drafter ≠ activator), then `POST /approvals/types`.~~
   **DONE BY `seed:tariff` SINCE PLAN 11g — this is no longer an owner step.** Nothing registered
   this type until 2026-08-25, which is why `submitVersion` threw `unknown_type` on the live box
   and the synthetic smoke test had to register it by hand (report D7, gap 2);
   `registerTariffApprovalTypes` now does it, idempotently, on every deploy. **The struck text
   stays as the record of what the step used to be, and because it still describes the SHAPE of
   the registration.** The §10.4 Class-A two-key upgrade (owner + Medical Superintendent) is a
   workflow-definition **data** change at that point, not a code change — v1 registers a single
   approver role because the shipped flow builder supports exactly one.
   **Still open and still an owner ruling: no role holds any `tariff.*` permission** (report D7,
   gap 1), so the tariff cannot yet be operated through any screen.
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

**Sweeps.** `sweepAppointmentNoShows` is one of the worker's six scheduled sweeps as of Plan 08.5
(daily 23:55 IST — see **Worker process** below), alongside `runDispatchCycle`,
`sweepExpiredTempRoles`, `runDueTimers`, `sweepGuardianMajority` and `runDailyClose`.

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

Owner ruling of 2026-08-23 assigns the four `workflow.definitions.*` strings, which appear in no
table above: `opd_admin` DRAFTS (`workflow.definitions.draft`), an `owner`-role user and a
`medical_superintendent`-role user each APPROVE (`workflow.definitions.approve`), and the `owner`
role ACTIVATES (`workflow.definitions.activate`); all three roles may `workflow.definitions.read`.
Drafter and activator are therefore different people, which is what the `workflow_drafter_activator`
SoD pair requires. The four `workflow.instances.*` strings stay deliberately ungranted: the OPD
flow calls `startInstance` and `transition` in-process from `modules/opd/encounters.ts`, never
through that controller, so granting them would mint authority nobody needs.

Owner ruling of 2026-08-26 moves three `auth.*` strings off `admin`, which appear in no table
above: the `medical_superintendent` role gains `auth.break_glass.review` and
`auth.elevation.review` — reviewing exceptional access is medical-record governance, not a
technical-administrator chore — and the `duty_manager` role gains `auth.temp_role.grant`, the
mechanism the night-shift bundling matrix was built on. `admin` keeps all three; these are
additions, not moves, and nothing is taken from the account that repairs the deployment. A fourth
string, `auth.break_glass.use`, is deliberately NOT granted to any clinical role: no route in the
tree sets `breakGlassBypass`, so an active break-glass grant currently unlocks nothing, and
granting the key to a door that opens on nothing would manufacture the appearance of an emergency
path. That one needs wiring and an owner ruling on whether a bypass may cross the confidential
gate, not a role row.

Owner ruling of 2026-08-26 assigns ten pairs that appear in no table above, closing permissions
that had no holder at all and therefore answered 403 to every account on the deployment. A new
`tariff_editor` role reads the price list, manages services and DRAFTS a version; the `owner` role
gains `tariff.read`, `tariff.versions.activate` and `tariff.config.manage`, so the person who
writes a price is never the person who publishes it, and `tariff_revision` still routes the
submission through `billing_manager` in between. `owner` also gains `approvals.types.manage` —
editing an approval type changes who may approve what, for every module at once. A new
`membership_admin` role gains `membership.import.run` and `membership.reconcile.operate` (the
holder-book import and the queue that never auto-links); `membership.catalog.manage` is
deliberately excluded because it guards no route anywhere in the tree. A new `biomedical_engineer`
role gains `ops.interface.manage` as a SECOND holder — `duty_manager` keeps it, because the night
shift must be able to silence an interface without waking the engineer.

Owner ruling of 2026-08-26 opens the patient-merge lane, which had never worked: a new
`mrd_officer` role gains `patients.read`, `patients.update` and `patients.merge`, and the
`medical_superintendent` role — named as the `approverRole` on both new approval types — gains
`approvals.requests.read`, `approvals.requests.decide` and `patients.read`, without which an
approver cannot reach the worklist or open the two records they are deciding about. The permission
alone was never the blocker: `patient_merge` and `patient_unmerge` were named by `merge.ts` from
Plan 05 and registered by nothing, so `requestApproval` threw `unknown_type` for every account.
`pnpm --filter @hmis/core seed:patients` registers them and now runs on every deploy. One person
may hold both roles — `assertNotSodPair("requester_approver", …)` still refuses their own merge.

Owner ruling of 2026-08-26 widens three roles that could not do their own jobs, in pairs that
appear in no table above. The `doctor` role gains `patients.read` and `patients.update`: the
consultation screen fetches `GET /patients/:id` and `GET /patients/:id/allergies`, both gated on
`patients.read`, so until this ruling a doctor in consultation was refused the allergy register —
measured on the live deployment, where every active doctor returned no such permission.
`patients.update` comes with it because an allergy discovered during a consultation is the best
moment there is to record one. The `pharmacy` role gains `patients.read` for the same safety
reason at the dispensing counter, and read-only: the allergy register belongs to the clinicians
who examine the patient. The `owner` role gains `billing.reports.read`, `billing.invoice.read` and
`billing.session.read` — it could not open an invoice, a dues ledger or a daybook — and
deliberately does NOT gain `patients.read`, because the owner is an administrative principal and a
blanket clinical read is not minimum-necessary; an owner who is also a clinician holds a second
role, visibly, instead.

### Go-live runbook — OPD (owner steps, once per environment)
0. `UHID_PREFIX=<PREFIX> pnpm --filter @hmis/core seed:registration` — **the `registration_config`
   row.** Numbered ZERO because it belongs to Plan 05 rather than to OPD, and because the steps
   below are cited by number elsewhere in this repository; it is listed here anyway because
   **without it `POST /patients` answers 400 (`registration_config row 'main' is missing`) and no
   OPD visit can be opened for a patient who cannot be registered.** Omitting it from this list
   cost a live go-live run one round trip on 2026-08-23. `UHID_PREFIX` is 1–5 uppercase letters
   (production runs `U`),
   it prefixes every UHID the hospital ever issues, and it is an **owner-gated Class A decision** —
   the script refuses anything else and does not guess. Idempotent (it updates on conflict), so a
   prefix chosen in error can be corrected while few UHIDs exist; already-issued ones keep the old
   prefix.
1. `pnpm --filter @hmis/core seed:opd` — the `opd_config` row (slot length, follow-up defaults,
   danger ranges, letterhead, skip cap; perk hook off), the OPD role keys and the placeholder
   departments. Idempotent.
2. `pnpm --filter @hmis/core seed:roles` — the seed above CREATES role keys and grants NOTHING;
   this one writes the `role_permissions` rows for the table above, cell for cell, and creates
   `pharmacy` (which `seed:opd` does not carry) along with the billing section's `cashier` and
   `billing_manager`. Idempotent, and it follows the MANIFESTS rather than this table: a string no
   module manifest declares is refused outright, never granted quietly. `seed-roles.test.ts`
   parses this table and compares it against the seed both ways, so a transcription error here
   fails the build. Assigning each user their role(s) at hospital scope is still a separate step.
3. `cat roster.json | pnpm --filter @hmis/core seed:staff` — THE ACCOUNTS THEMSELVES. The
   roster is a JSON array of `{ username, fullName, password, pin?, roles }` piped in on STDIN,
   so no credential is written to the box or into shell history and you keep the only copy. The
   printed report — username, full name, roles, pin yes/no, created-or-already — IS the audit
   record, precisely because stdin leaves no file behind; it carries no password and no PIN, and
   a test asserts that by execution. Idempotent. It REFUSES, before writing anything at all, an
   unknown role key, a role step 2 has not created, and an existing username whose password or
   PIN differs from the roster's — there is no credential-reset flow in this system yet, so a
   silent overwrite would be the one way to lock a real user out of a live hospital. GIVE EACH
   PERSON A `pin`: without one they cannot use the sub-2-second PIN fast-switch at a shared
   terminal, which is the whole reason ward terminals need not share a session. Roles are
   ASSIGNED here and GRANTED in step 2 — this script never changes what a role may do. The two
   steps below both need the humans this step creates.
4. Activate the `opd_visit` definition (Class A, two-key): `GET /opd/definition` → post that exact
   JSON to `POST /workflow/definitions` as a user with `workflow.definitions.draft` →
   `POST /workflow/definitions/:id/approve` by an `owner`-role user AND by a
   `medical_superintendent`-role user → `POST /workflow/definitions/:id/activate` by a THIRD user
   with `workflow.definitions.activate` (drafter ≠ activator). No OPD visit can be opened before this.
5. Enter departments, rooms, doctors (by username — the user must exist) and weekly schedules in
   the admin screen `/opd/admin`.
6. `PUT /opd/config`: the hospital letterhead and the danger ranges reviewed and signed off by
   clinical staff at UAT; slot length and follow-up window if they differ from 10 min / 7 days.
7. Display board: open `/opd/display?rooms=<roomIds>` on the counter TV and click Start ONCE —
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
patient name or UHID (§14); go-live runbook step 7 above covers deploying it to the counter TV.

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
`cashier_sessions` (`open → closing → closed`), `document_series.next_no`, `billing_config`,
the `daily_closes` claim row, and `idempotency_keys` (a claim updated once with its result).
Every document series is per-fiscal-year and row-locked (`INV/26-27/000001`), and every threshold
below is `billing_config` DATA a CA reviews — never a code constant.

**Idempotency (`Idempotency-Key`, optional header, migration 0013).** The eight
document-CREATING writes — `POST /billing/invoices`, `/billing/receipts`,
`/billing/receipts/:id/allocations`, `/billing/invoices/:id/credit-notes`, `/billing/refunds/request`,
`/billing/refunds`, `/billing/refunds/:id/pay`, `/billing/eie` — accept an `Idempotency-Key`
header. The key is claimed with `INSERT … ON CONFLICT DO NOTHING` **before** the work, so a
concurrent duplicate never reaches the write path at all; recording it afterwards would be too
late, because by then both requests have issued a document. A replay returns the **original**
result rather than a refusal — a cashier who reloads mid-payment must see the receipt she already
took — and the stored request hash is what makes that safe: the same key against a *different*
body answers `409 idempotency_key_reused` instead of an unrelated document. A write that FAILS
releases its key, so a corrected retry may reuse it. The header is optional and a request without
one behaves exactly as before; the web client mints one per submit attempt, in one place.
Uniqueness is per `(actor, route, key)`, so one cashier's key can never replay another's.

**Events** (all `module: "billing"`, exactly twenty names): `invoice.issued` ·
`invoice.credit_extended` · `receipt.recorded` · `payment.received` · `advance.received` ·
`allocation.reversed` · `credit_note.issued` · `refund_voucher.issued` · `payment.refunded` ·
`cashier_session.opened` · `cashier_session.closed` · `variance.flagged` ·
`cash_threshold.warned` · `cash_threshold.blocked` · `tender.reconciled` · `tender.mismatched` ·
`degraded_mode.changed` · `document.entered_in_error` · `charge.orphan_flagged` · `day.closed`.
The dispatcher runs on the worker's clock as of Plan 08.5 (see **Worker process** below), but
every billing approval stays check-on-execute BY DESIGN — the loop existing does not change it
(Global Constraint 1). Billing screens (Plan 08 pipeline C) poll rather than subscribe — there are
still no billing realtime topics.

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

**`pnpm --filter @hmis/core seed:roles` WRITES this table** — it stopped being a recommendation
an operator transcribes by hand in Plan 11d. `apps/core/test/seed-roles.test.ts` parses the table
below and the OPD table above and compares them, cell for cell and in both directions, against
the seed's role model, so a transcription error fails the build rather than the pilot. The last
row's `/ .decide` shorthand is EXPANDED by that parser into two `approvals.*` permissions; a
parser that skipped it would agree with the seed vacuously.

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

Plan 09's four `membership.*` strings appear in neither table above, and are assigned by that
plan's DD18. Reading and recognising an instrument (`membership.instrument.read`,
`membership.instrument.recognise`) and REQUESTING a grace-honor (`membership.grace_honor.request`)
go to `front_office`, `front_office_supervisor` and `cashier` — the roles that already register the
patient and issue the invoice, because a member's benefit not applied at the moment of billing
cannot be applied afterwards without a credit note, an approval and a queue. APPROVING a
grace-honor (`membership.grace_honor.approve`) sits with `billing_manager` alone, the role that
already approves every other billing exception, so the desk that asks can never be the desk that
grants. Everything else that phase declares — the membership catalog, the holder-book import, the
reconcile queue, and all seven `partners.*` strings — is deliberately ungranted and recorded in
`NOT_YET_MODELLED` with its reason: no role model for them is published anywhere, the catalogs are
config rows loaded at commissioning rather than maintained by a human at a route, and every lane
they guard ships structurally OFF pending the owner's ruling on the CA/counsel register.

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
`billing.recon.upload` and `billing.eie.mark`. Of these a cashier holds only
`billing.refund.request` and `billing.refund.pay`, so a cashier who opens the back office can file,
issue and pay a refund voucher but is refused the worklist read, the statement upload and the
entered-in-error correction.

**Money writes are single-flight, on both sides.** Every write button on the four screens is a
`SubmitButton` (`components/submit-button.tsx`): a `useRef` latch that flips synchronously, so two
clicks in one tick call the handler once — `disabled` is the affordance, never the guard. That
closes the double click inside one tab. It cannot close a duplicate DELIVERY of the same request,
so each attempt also mints one `Idempotency-Key` and every write it makes carries it; the server
claims that key before doing the work (see **Idempotency** above). A deliberate second submit mints
a NEW key and is a new attempt — the guard is against duplication, never against a cashier who
means it.

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

## Membership, coupons and the channel ledger (Plan 09)

Two modules sharing one migration and no source file (DD1): `modules/membership` owns
instruments — plans, instances, covered members, entitlement counters, coupons, recognition, the
holder-book import and the reconcile queue; `modules/partners` owns counterparties — partners,
versioned agreements, the accrual ledger, receivable expectations, statement reconciliation, aging
and the channel P&L. **Every plan, coupon, partner and agreement term is a CONFIG ROW loaded at
commissioning; nothing in `apps/` contains a plan code, a partner code, a commission rate, a card
price or a card number (DD3)** — a freshly migrated database has empty catalogs, checked by
`catalogs-empty.test.ts`.

### Web app: membership and partners screens (Plan 09)

| Route | Screen | Permission |
|---|---|---|
| `/counter/instruments` | Card recognition — lookup by card, phone or holder name; what a card and its coupons grant today; the honouring disclosure, in the server's own words | `membership.instrument.read` |
| `/counter/reconcile` | Holder-book reconcile queue — fuzzy-match candidates and cap-overflow members from an import, linked one click at a time (never auto-linked, E3); lapsed restores | `membership.reconcile.operate` (NOT_YET_MODELLED) |
| `/partners/receivables` | Partner receivables — the aging report (outstanding vs. confirmed, DD5), the 11h barcode-wedge slip lookup, statement import | `partners.receivable.operate` / `.ledger.read` / `.statement.import` (NOT_YET_MODELLED) |
| `/partners/pnl` | Channel P&L — cards active, member spend, commission payable, receivables expected/matched/disputed, net channel margin, one row per partner | `partners.pnl.read` (NOT_YET_MODELLED) |

As elsewhere, the client holds no permission model of its own — every nav link renders for
everyone and the server's 403 on the underlying route is what actually decides who may use a screen.

### The five structural-OFF flags (DD14) — what each gates, and what authorises the flip

Every one is `z.enum(["true","false"]).default("false")` (never `z.coerce.boolean()`, which reads
the string `"false"` as `true`) and every one is DEFAULTED, so no `.env` anywhere needs a new key.
The mapping from flag to CA/counsel register item is stated ONCE, here.

| # | Flag | Default | Gates | Lifted by |
|---|---|---|---|---|
| 1 | `MEMBERSHIP_SALES_ENABLED` | `false` | Selling an instrument at the hospital counter. **No code lane exists for it in this phase at all** — E-32's guardrails (no ER/bedside sale path, no sales figure at the counter, the honouring disclosure) ship regardless | Standing ruling: sales open a later phase. CA/counsel register item 4 (cooling-off refunds) attaches to THIS flag when that phase builds the sale lane |
| 2 | `MEMBER_BENEFITS_ENABLED` | `false` | Composing the membership and coupon `AdjustmentSource`s into `priceDraft` at billing (DD2) | **Not a legal gate** — DD8's operational order, in the runbook below |
| 3 | `COMMISSION_ACCRUAL_ENABLED` | `false` | The accrual consumer WRITING payable commission rows (it registers and advances its cursor either way, DD7 — this flag decides writes only) | CA/counsel register items 2 and 3 (O-8, owner) |
| 4 | `RECEIVABLE_COMMISSION_ENABLED` | `false` | Attribution issuance, statement import and matching | CA/counsel register item 2 (O-8, owner) |
| 5 | `COUPON_ISSUANCE_ENABLED` | `false` | Issuing NEW coupon codes (campaign creation). **No code lane exists for it in this phase at all** — nothing anywhere reads this flag, so flipping it opens nothing (independent review, MINOR 2). Redeeming an already-issued coupon is ON and unflagged | CA/counsel register item 5, advertising rules (O-8, owner) |

**ON and unflagged regardless of all five:** recognition, honouring an already-issued instrument,
entitlement consume/restore, redemption of an already-issued coupon, the holder-book import, the
reconcile queue, and the channel P&L above — it reads whatever rows exist, which is zero while the
CA-gated lanes are off, and it does not error.

### Go-live runbook (owner steps, once per environment)

**The order below is DD8's, and it is an order for a reason:** a counter discount cannot be
backfilled, so arming member benefits before recognition is genuinely live and the import is done
means either refusing a paying member outright or honouring their card off-system while the queue
catches up.

1. Deploy with all five flags at their default (`false`). Recognition, honouring, the holder-book
   import, the reconcile queue and the P&L already work — see the flag table's last line.
2. Grant `membership.instrument.read` / `.recognise` and `membership.grace_honor.request` to the
   front-office/cashier roles, and `.approve` to `billing_manager` (`seed:membership` does the role
   creation; the grants are the table above the billing permissions section). **Also grant
   `membership.import.run` and `membership.reconcile.operate`** — both ship in `NOT_YET_MODELLED`
   (DD18) on purpose, so `POST /membership/import/holder-book` and `/counter/reconcile` are
   reachable by NOBODY until this step. Skipping it does not fail loudly; it leaves an operator
   looking at an empty screen or a 403 with no obvious cause.
3. Run the holder-book import (`pnpm --filter @hmis/core import:holder-book`, or the route above
   once granted) against the owner's real partner book. It is an OPERATOR command, never a deploy
   step — `docker/prod/deploy.sh` does not run it, deliberately, the same reasoning that keeps
   `seed:admin` out.
4. Clear the reconcile queue at `/counter/reconcile` — every fuzzy-match candidate and cap-overflow
   member the import could not link by itself (E3: nothing here is ever auto-linked; a human names
   the patient or dismisses the row).
5. Flip `MEMBER_BENEFITS_ENABLED: true`. From here a member's card is honoured inside the bill
   itself, not only at the recognition screen.
6. **When O-8 clears a CA/counsel register item, grant the matching `partners.*` permissions
   (all seven ship in `NOT_YET_MODELLED`) and flip the matching flag together** —
   `partners.attribution.issue` / `.statement.import` / `.receivable.operate` / `.ledger.read`
   before `RECEIVABLE_COMMISSION_ENABLED` (register item 2); nothing extra is needed for
   `COMMISSION_ACCRUAL_ENABLED` beyond the flag itself (register items 2 and 3), since the accrual
   consumer has no route of its own. `partners.pnl.read` and `partners.counterparty.manage` /
   `.agreement.manage` carry no O-8 gate — grant them whenever the owner wants the report visible
   or is ready to enter real partners and agreements (DD3).
7. **The FIRST deploy of this phase's code already runs `seed-cursors.js` (`deploy.sh`'s own seed
   step), and that seeds the new accrual consumer's cursor to the event log's CURRENT head — not to
   zero.** That is correct for a live delivery (nothing floods the worker at boot), but it means
   every payment the hospital takes between THAT deploy and the day `COMMISSION_ACCRUAL_ENABLED` is
   finally flipped is already behind the cursor and will never be picked up by ordinary dispatch.
   **Flipping the flag must be followed immediately by a `replayAccruals` run** (from the sequence
   number at or before that first deploy) or those payments never accrue — silently, with a clean
   exit code, because a backfill that ran with the flag still off reports a clean pass having
   written nothing (`replayAccruals` refuses outright with the flag off, precisely so this cannot
   be mistaken for success).
8. `COUPON_ISSUANCE_ENABLED` carries no ordering constraint of its own **because it carries no
   lane**: it is declared and defaulted, and nothing in `apps/`, `packages/` or `docker/` reads it
   (three occurrences, all in `kernel/config.ts` and its test). Flipping it changes no behaviour.
   It is here so the issuance lane a later phase builds is born gated rather than retrofitted —
   the same reason row 1 exists. Register item 5 gates that phase, not this flag.

**Watch items — read before trusting a number on any of these screens:**

(a) **DD11's merge-duplicate reconcile reason has no producer.** `patient_match_queue.reason` lists
    `merge_duplicate`, but detecting it means instrumenting `modules/patients/` at the point a
    merge executes, which no task in this phase owns. The column and the reconcile screen are
    ready; nothing writes that reason yet.
(b) **An imported card's COUNTED entitlements have no writer either.** Nothing this phase ships
    inserts an `entitlement_counters` row from the holder-book import — an imported card grants its
    plan's PERCENTAGE benefits (which need no counter) and no counted benefit (e.g. "3 free
    consults") until a later phase rules the shape of `membership_plans.entitlements`.
(c) **The E-32 queue perk is CONFIGURABLE and VISIBLE this phase, but not yet ACTED ON.**
    `membership_plans.queue_perk` is surfaced at recognition and rendered at the counter, but
    nothing in this phase writes `opd_queue_entries.perk = true` — that write belongs in
    `modules/opd/queue.ts`, which no task here touches. A plan configured with the perk will say so
    at the counter and change nothing about queue order until a later phase fills it in.
(d) **A bill that wins ONE entitlement on MORE lines than the member holds is refused WHOLE** —
    concretely, a member with one free consult left, billed for two consults on one invoice, cannot
    be invoiced at all until the clerk splits the bill. That refusal (`entitlement_exhausted`) is a
    typed 409 carrying its own reason, not a bare 500 — a close remediation to the frozen
    `billing.controller.ts`, landed outside any one task's Files list because that file is frozen
    to the whole phase. It is inert until `MEMBER_BENEFITS_ENABLED` is flipped (step 5).
(e) **An unknown counterparty on a holder-book import surfaces as a raw 500.** The foreign key on
    `holder_book_imports.counterparty_id` is what refuses it; `MembershipErrorCode`'s closed union
    carries no typed code for "counterparty not found" this phase.
(f) **An agreement amendment is a NEW version effective from a FUTURE instant — never an edit to a
    live version's `terms`, and never a version backdated behind an invoice the ledger has already
    priced.** Nothing in the schema forbids either mistake today (`partner_agreements` carries no
    append-only trigger and no `effective_from >= now()` check); both silently reprice or
    double-accrue money DD6's snapshot already settled. Train whoever enters agreement data on this
    before the first real amendment.
(g) **Two operators must not import statements for the same partner at the same time.** The
    open-claim lookup inside statement import takes no row lock, so two concurrent imports quoting
    the same referral can each confirm it — a real, measured race with no code-level guard in this
    phase.
(h) **Setting `counterparties.status = 'terminated'` alone stops nothing.** O-7's "new accruals
    stop at the term date" is implemented as CLOSING the active agreement version's
    `effective_to` — the status column by itself changes no arithmetic. Terminate a partner by
    closing their agreement window, not only by flipping the status.
(i) **`cardsActive` and `memberSpendPaise` on the channel P&L are NOT flag-gated and can be
    non-zero while every CA-gated number on the same row reads zero.** That is not a bug — cards
    can circulate and members can spend while the hospital and a partner are still waiting on O-8 —
    but it is worth saying once so nobody reads a partner's "0" commission row as "no activity".
(j) **When running the replay from step 7, flip the real `COMMISSION_ACCRUAL_ENABLED` environment
    variable — never rely on `replayAccruals`'s own `{ env }` option to arm it.** The option only
    gates the refusal at the TOP of the replay; the writer underneath it (`handleAccrualEvent`)
    reads `process.env` directly, with no argument. A caller who arms the backfill only through the
    option while the process environment still has the flag off gets exactly the failure the
    refusal exists to prevent: every row returns `disabled` and the job reports a clean pass having
    written nothing.

## Formulary and prescribing safety (Plan 16a)

Five tables — `formulary_salts`, `formulary_medicines`, `formulary_medicine_salts`,
`formulary_interactions`, `formulary_staging` — and one rule that explains all of them: **identity
is the active MOIETY, not the salt form.** "diclofenac sodium" and "diclofenac potassium" are one
row (`diclofenac`), because a patient allergic to one is allergic to the other.

Before this module the allergy guard was a bidirectional substring match over free text, and its
own doc-comment named its expiry. It catches "Penicillin G" from an allergy to "penicillin" and
misses **Augmentin**, because nothing in the system knew that Augmentin is amoxicillin +
clavulanic acid and that amoxicillin is a penicillin. Drug–drug interaction and duplicate-therapy
checks were not weak — they were impossible.

**Prescribing is never blocked by formulary coverage** (spec design law 1). A free-text line stays
legal forever; a line the formulary does not recognise simply gets the legacy substring check and
no more. The formulary earns trust by growing, not by gatekeeping — which is also why the per-line
"not in formulary" notice stays silent until coverage crosses 80% of the last 30 days' prescribed
lines.

**Permissions (owner ruling, 2026-08-26): the formulary is curated at the pharmacy and read by every prescriber.**
`formulary.manage` and `formulary.staging.review` go to `pharmacy` — the spec
says *pharmacist-gated*, and a mined composition reaches a live table only when a pharmacist admits
it, one item at a time. `formulary.read` goes to `pharmacy` and `doctor`, because prescribing
consumes the master that dispensing curates. Note that `pharmacy` is one of the roles `seed:roles`
creates with grants and no holders, so this mints live authority to nobody until a pharmacist
account exists.

**Mined data is never authority.** `formulary_staging` is a lookup dictionary, not a review queue:
the pharmacist types a name, gets the mined record pre-filling composition and schedule, verifies,
and admits. Nothing is bulk-approved, staging rows are invisible to every resolution path, and the
review UI renders payloads as text only — scraped content is untrusted and the reviewer is a
privileged user.

## Resource registry (Plan 13)

**Every physical place and station in the hospital lives in ONE tree**, `resources`, with
`resource_status_history` beside it. Floors, wards, halls, rooms and beds are the five KERNEL kinds;
theatres, stores, benches, analyzers and devices are the five the later modules claim. It is a
KERNEL subsystem (`src/kernel/resources/`) rather than a module — it owns no journey and is consumed
by OPD, the mini-OT, pharmacy, lab, housekeeping and IPD alike — and it carries a §4 manifest for
the same reason `kernel/ops` does: the manifest seam is where permissions are declared.

**`opd_rooms` is gone.** It was a private OPD table, and Plan 13 exists because OPD had privatised
the part of resource state that existed. The migration preserves every room id (they are ULIDs, so
`opd_doctor_schedules.room_id` and `opd_queue_sessions.room_id` needed no value rewrite — only their
foreign key's target changed), and OPD's `listRooms` / `createRoom` / `updateRoom` keep their
external shape over a mapper: `floor` reads `attributes->>'floor'` and `active` reads
`status !== retired`.

**There is no `active` boolean and there never will be.** One state column cannot disagree with
itself; a row that is `active: false` and `status: 'available'` is a row the bed board reads wrong.
Each kind declares its own vocabulary on its manifest — including `onRelease`, which for a bed is
**`cleaning` and not `available`**, because that field IS the discharge cascade and a bed that
returned straight to available would put the next patient in an uncleaned one.

**The tree is cycle-bounded and depth-bounded at the write path** (`MAX_RESOURCE_DEPTH = 6`),
because Postgres cannot express "not my own ancestor". There is deliberately no legal-parent-kind
matrix: containment rules belong to the owning module, not to the registry.

**Permissions (Plan 13 / DD14): the registry is read by the role that already reads the room book.**
`resources.read` guards the three read routes (`tree`, `board`, `history`) and goes to `opd_admin`
alone. It creates no new authority — that role already holds `opd.masters.read` and
`opd.masters.manage` over the same rooms. There is no `resources.manage`: registry master writes
keep going through OPD's existing `opd.masters.manage` routes, and the first module that needs a
registry write route declares and mounts its own permission with it.

## Materials — items, vendors, stores and the stock ledger (Plan 14)

The first tables in this system that know a box of anything exists: what an item IS, who supplied
it, which batch it belongs to, when it expires, what MRP is printed on it, **and who owns it**. One
module owns one ledger; pharmacy, the mini-OT and the lab are all CALLERS of it, never owners of a
second one. Stock lives at a location, and every location is a resource of kind `store` in the Plan
13 registry — central stores, sub-stores, the OT's consignment bin, and one `IN-TRANSIT` store per
site that a two-sided issue moves through.

**Permissions (Plan 14 / DD11): the storekeeper receives, the head is accountable, and the
pharmacist signs the drug verdict.** Eleven strings across three roles, and the split is the phase's
one RBAC decision. `materials_head` is ACCOUNTABLE — what the hospital may buy, whom it may buy
from, whose stock is frozen — and holds all eleven. `storekeeper` is an OPERATOR and holds six:
receive the lorry, move stock, read a shelf. `pharmacy` gains the QC verdict for drugs plus the two
read halves that make a verdict informed, because an item is the shelf side of a medicine the same
role already curates.

`materials.grn.capture` and `materials.grn.qc` are two strings for what is one desk today, and that
is deliberate: capture records what came off the lorry so the lorry can leave, and the verdict is a
separate act. The SoD pairs the procurement spec names — PO-approver/GRN-receiver,
custodian/counter — cannot be built until a purchase order (14b) and a cycle count (14c) exist, and
a two-key rule needs a second approving actor this deployment does not yet have. The permission
split is what those pairs will hang on.

| Permission | materials_head | storekeeper | pharmacy |
|---|---|---|---|
| `materials.items.read` | ✓ | ✓ | ✓ |
| `materials.items.manage` | ✓ | | |
| `materials.vendors.read` | ✓ | ✓ | |
| `materials.vendors.manage` | ✓ | | |
| `materials.stores.manage` | ✓ | | |
| `materials.stock.read` | ✓ | ✓ | ✓ |
| `materials.grn.capture` | ✓ | ✓ | |
| `materials.grn.qc` | ✓ | | ✓ |
| `materials.stock.issue` | ✓ | ✓ | |
| `materials.stock.receive` | ✓ | ✓ | |
| `materials.recall.manage` | ✓ | | |

`owner` gains nothing new: the vendor bank-change approval reaches the owner through `approvals.*`,
which that role already holds, and a `materials.*` string for it would be a second door to one
decision. Both new roles are created by `seed:roles` with grants and **no holders** — the `pharmacy`
precedent — so this table mints live authority to nobody until a storekeeper account exists.

**Two approval types, registered by `seed:materials` in the deploy path.**
`materials_near_expiry_acceptance` (approver `materials_head`, 240-minute SLA) gates posting a GRN
line whose residual shelf life is short; `materials_vendor_bank_change` (approver **`owner`**,
always, 1,440 minutes) gates changing where a supplier's money goes, and stamps a seven-day
cooling-off that this phase records and a later one enforces. An approval type reaches a deployment
only through a seed script, which is why that seed is in `deploy.sh` and not in a runbook.

## Mini-OT — the day-care spine (Plan 15)

The hospital could register a patient, consult, prescribe, bill and hold a consignment implant in a
store. It could not operate on anyone. This module is spec §11.16-A at one-theatre scale: a booking
that cannot skip its gates, a theatre that cannot be double-entered, counts that cannot be typed as
"correct", an implant scan that is a ledger fact in the same transaction, a recovery bay that cannot
be double-assigned, and a discharge bill composed from the ledger under `min(tariff, MRP, ceiling)`.

The unit is ONE theatre (`OT-1`, a registry resource of the module's own `theatre` kind), TWO
recovery bays (`RB-1`, `RB-2` — **kernel `bed` rows**, because `bed` is a kernel kind and a second
declaration is a boot error) and ONE consignment bin (`OT-CONSIGN`, a materials `store`). All four
are created by `seed:ot` in the deploy path, idempotently, and never through a screen: they are
fixed by the building rather than by a purchasing decision, and every write path needs them to exist
before the first booking.

**Permissions (Plan 15 / DD14): fourteen strings across six new roles, and three separations that
are the point of the module.** `ot_incharge` runs the list and holds eleven — but NOT
`ot.gates.override`, NOT `ot.definitions.manage`, NOT `ot.bill.compose`: the person under the most
pressure to start on time must not be able to wave a clinical gate through, redefine what the unit
may operate on, or bill for it. `surgeon` AND `anaesthetist` both hold `ot.gates.override`, because
a clinical override needs two DISTINCT actors holding those two roles — one role holding it would
make the two-key rule satisfiable by one person with two logins. `recovery_nurse` holds
`ot.discharge` and `ot_nurse` does not: a day-care patient leaves from the bay, and the person who
signs her out is the person who scored her.

| Permission | ot_incharge | surgeon | anaesthetist | ot_nurse | recovery_nurse | daycare_coordinator |
|---|---|---|---|---|---|---|
| `ot.definitions.read` | ✓ | ✓ | ✓ | | | ✓ |
| `ot.cases.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ot.cases.book` | ✓ | | | | | ✓ |
| `ot.cases.cancel` | ✓ | | | | | ✓ |
| `ot.list.manage` | ✓ | | | | | ✓ |
| `ot.gates.satisfy` | ✓ | | | | | ✓ |
| `ot.gates.override` | | ✓ | ✓ | | | |
| `ot.cockpit.operate` | ✓ | ✓ | ✓ | ✓ | | |
| `ot.implants.scan` | ✓ | | | ✓ | | |
| `ot.counts.record` | ✓ | | | ✓ | | |
| `ot.recovery.operate` | ✓ | | | | ✓ | |
| `ot.discharge` | ✓ | | | | ✓ | |

Two strings are held outside that table, by roles that already exist: `medical_superintendent` gains
`ot.definitions.read` and `ot.definitions.manage` — the criteria whitelist, the privilege list, the
deposit policy and the PACU thresholds are what the unit is ALLOWED to do, which is a
clinical-governance decision and therefore that office's — and `billing_manager` gains
`ot.bill.compose`, because composing a discharge bill reads the ledger, applies the regulated clamp,
allocates the deposit and can raise a refund, which belongs with the role that approves every other
billing exception rather than with the desk that takes the cash. **The plan named a
`billing_counter` role for that grant; no such role exists anywhere in this system, and granting a
string to a role that does not exist would make it a permission nobody can ever hold.** All six new
roles are created by `seed:roles` with grants and **no holders**, the `pharmacy` and `storekeeper`
precedent.

**Two approval types, registered by `seed:ot` in the deploy path.** `ot_definition_publish`
(approver `medical_superintendent`, 1,440-minute SLA) gates publishing any of the four governed
definitions — the engine's own requester-vs-approver segregation then forces two distinct humans, and
this deployment has them. `ot_deposit_exception` (approver **`owner`**, 120 minutes) is the ONLY
path by which a deposit shortfall reaches a satisfied gate: the money rule is the owner's, not the
superintendent's, and the person who waives a deposit must not be the person under pressure to fill
the list.


### The four screens, and where the cockpit lives

`/ot/list` (the day's list, with each case's gate chips and a link into its cockpit), `/ot/book`
(book a case, then hold the deposit against the encounter the booking created), `/ot/recovery` (the
bay board, PACU scores, escort verification, discharge and the bill) and `/ot/cockpit/:caseId` (the
one case, holding to wheel-out). **Three appear in the menu and four exist**: there is no such thing
as "the cockpit" without a case to open it on, so it is reached from the list, which is where a
nurse actually is when they need it. `otManifest.menu` declares the same three and
`apps/core/test/nav-parity.test.ts` fails if the two tables ever disagree.

Every hard gate is the SERVER's. The cockpit renders all seven clock buttons live rather than
greying out the ones it believes are not next — a client's idea of "next" is a second copy of the
state machine, and in a theatre the copy that is wrong is the one on the screen the nurse is looking
at. Press the wrong one and the engine refuses it with a sentence. No screen sends a timestamp:
DD8's five clocks are stamped by the server and the `0035` trigger makes them unrewritable.

**A confidential patient's legal name never reaches the theatre list or the recovery board.** Both
DTOs carry `patientDisplay`, which is `displayName(patient, canSeeConfidential)`'s answer for the
actor who asked — the alias for the theatre, the legal name for the two people holding
`patients.confidential.read`. A theatre list is printed and pinned to a wall and a recovery board
faces the corridor, which is what §14 is about.

### Go-live runbook — the mini-OT (executed at deploy, not at build)

Plan 15 is code-complete and **not deployed**; production is at 34 migrations and has never left
`commissioning`. When the owner names a SHA, these run in this order:

1. **`pnpm db:migrate`** — applies **three** migrations, all additive:
   · `0035_mute_vision.sql` — twelve new tables, their indexes and FKs, and the
     `ot_forbid_timestamp_rewrite` trigger.
   · `0036_ot_timestamp_delete_guard.sql` — re-creates that trigger as `BEFORE UPDATE OR DELETE`,
     so a delete-then-reinsert cannot rewrite the five clinical clocks (close review M5).
   · `0037_ot_incident_kinds.sql` — widens `ot_incidents_kind_ck` with `dose_log` and `absconded`.
   No `DROP TABLE`, no `DELETE`, no data migration — verified by grep at close, and worth reading
   before you apply them.
2. **`pnpm seed:roles`** — creates the six new roles with their grants and **no holders**, and adds
   `ot.definitions.*` to `medical_superintendent` and `ot.bill.compose` to `billing_manager`.
3. **`pnpm seed:ot`** — idempotently creates `OT-1` (theatre), `RB-1`/`RB-2` (kernel `bed` rows of
   the day-care recovery class), the `OT-CONSIGN` consignment store, the two approval types, and
   DRAFTS the four governed definitions. It does **not** publish them: publishing is a governance
   act, below.
4. **Create the `daycare_package` tariff services** — one per procedure class the unit will actually
   operate on (DD6/F8). A case whose class has no such service is refused `bill_not_composable` at
   discharge, which is the right failure but a late one; create them before the first booking.
5. **Publish the four definitions through the MS.** Each draft goes
   `request-publish → approved by `medical_superintendent` → published`, and the approvals engine's
   requester-vs-approver segregation forces two DISTINCT humans. **This deployment has one full
   admin.** Spike Q3 measured it: a second human — a named MS account distinct from whoever drafts —
   must exist before this step, or the publish cannot complete and no case can be booked. It is not
   a check you can wave through; it is the engine refusing.
6. **Activate the two Class-A workflow definitions** (the day-care case and the recovery stay)
   through the same drafter/approver/activator separation the OPD runbook already describes.
7. **Assign holders to the six roles.** Until somebody holds `daycare_coordinator`, the OT links are
   invisible to every user — the `pharmacy`/`storekeeper` precedent, working as ruled.

**Consignment agreements are Plan 14's precondition, not this one's.** A vendor without one is
refused at the materials GRN gate, which is where that rule lives and where it belongs; the OT
neither re-checks it nor can it be satisfied from here.

**Downtime is hospital-scoped.** A backfilled case is entered through
`POST /ot/cockpit/:caseId/backfill`, which walks the real transition matrix as the `system` actor
and carries the human's identity on a `late_entry.flagged` event — so an out-of-order downtime
record is refused by the state machine rather than by a private check, and every backfilled phase is
visibly a backfill. The transition is made as `system` because `in_holding → signed_in` admits only
an anaesthetist and the person typing a downtime record at 09:00 is usually the in-charge; the ROLE
check is the only thing `system` skips, so the ORDER check still bites.

**The conversion boundary (E-11).** A day-care case that becomes an inpatient stay hands over at
`converted_at`: consumptions at or before that instant are billed on the day-care invoice, and later
ones go to a `handoff_unbilled` report line for the incumbent IPD to bill. The boundary is INCLUSIVE
at the instant itself. Billing cannot enforce this — it has no idea a conversion happened — so the
OT composer filters, and `A30` is the test that says so.

## Worker process (Plan 08.5)

A second Node process, `apps/core/src/worker.ts`, boots a providers-only Nest application context
(`WorkerModule` — no controllers, no `RealtimeModule`, so it structurally cannot open `/ws` or run
the realtime tail; that stays the API process's, Global Constraint 2) from the SAME build as the
API, with its own DB pool. It runs six sweeps on an advisory-lock interval loop — never pg-boss,
never a second scheduler (D2): each tick, one checked-out client takes
`pg_try_advisory_lock(hashtext('job:<name>'))`; the loser skips the tick silently, so running more
than one worker process is safe by construction. The lock is noise-reduction only — correctness
never rests on it (D3): every sweep below is already idempotent and multi-process-safe on its own
claim (a conditional `UPDATE … RETURNING`, or `INSERT … ON CONFLICT DO NOTHING`).

**Start it:** `pnpm --filter @hmis/core start:worker` (mirrors `start:dev` — same `loadConfig()`,
same `.env`, no new environment variable is ever required). Dev compose is unchanged; a
production compose service, restart policy and heartbeat alerting are Plan 11's.

**The six jobs and their cadences** (every interval defaults in the config schema):

| Job | Cadence | Config key |
|---|---|---|
| `runDispatchCycle` | every 2 s | `WORKER_DISPATCH_INTERVAL_MS` (default 2 000) |
| `runDueTimers` | every 20 s | `WORKER_TIMERS_INTERVAL_MS` (default 20 000) |
| `sweepExpiredTempRoles` | every 60 s | `WORKER_TEMP_ROLES_INTERVAL_MS` (default 60 000) |
| `sweepGuardianMajority` | daily, 00:05 IST | code constant, not a knob |
| `sweepAppointmentNoShows` | daily, 23:55 IST | code constant, not a knob |
| `runDailyClose` | daily, 23:59 IST | code constant, not a knob |

The three daily jobs share one ticker, `WORKER_DAILY_TICK_MS` (default 30 000 ms): each tick it
checks whether `now` is past today's IST instant AND the job's heartbeat has no `last_ok_at` yet
on this IST day — the heartbeat doubles as the daily-run memory, so a failed daily run retries on
the next tick until it succeeds, and a successful one does not re-fire until tomorrow.

**Heartbeats.** `scheduler_heartbeats(job PK, last_started_at, last_ok_at, last_error,
last_duration_ms)` is upserted on every tick that WINS the lock — never a per-tick event (that
would flood the log). `GET /health` reads it and reports a `worker` field:

| `worker` | Meaning | `status` |
|---|---|---|
| `not_running` | zero heartbeat rows — no worker has ever ticked against this database | `ok` |
| `ok` | the freshest `last_started_at` is within `WORKER_STALE_AFTER_MS` (default 60 000 ms) | `ok` |
| `stale` | older than that | `degraded` |

The worker is never reported `down` — it is never load-bearing for a human flow (Global
Constraint 1), so its absence degrades a diagnostic; it never fails one.

**When the worker is down, nothing blocks.** Every sweep is a pure catch-up read over rows that
already carry their own due-ness (a due timer, an unresolved event past the dispatcher's cursor,
an appointment past its service date): with the worker not running, timers, escalations and
deliveries simply ACCUMULATE, and every one of them drains on restart — no request a human is
waiting on depends on the worker having ticked at all. This is proved, not asserted:
`apps/core/test/worker-runtime.e2e.test.ts`'s drain leg builds a backlog with the worker never
having run, then drives the sweeps directly and shows the backlog resolves and a second pass over
the same instant fires nothing further.

**The alerts bell** (`apps/web/src/components/alerts-bell.tsx`) is the runtime loop's first
human-facing surface: it polls `GET /alerts` (`refetchInterval: 15_000`) and treats a WebSocket
frame on `alerts:<userId>` as an invalidate hint only — the frame carries no title and no patient
identity (§14), so nothing is ever rendered from the frame itself, only from the poll it triggers.

## Operating modes and the downtime protocol (Plan 11c)

A hospital is never simply "up". It is being commissioned, or ramping, or running, or limping, or
writing on paper — and everybody on the floor needs to know which, because the right thing to do at
a registration desk is a different thing in each. Plan 11c makes that state **a declared fact with
a name, an author, a timestamp and a note**, rather than something each person infers from whether
their own screen is loading.

### The five modes

| mode | what it means | who declares it |
|---|---|---|
| `commissioning` | Not a running hospital yet. **This is what an empty ledger reads as**, so a freshly migrated deployment is in it by construction — nobody has to remember to set it. | nobody — it is the initial state and can never be a transition *target* |
| `ramp` | Live, but deliberately limited: one department, a capped list, staff shadowing paper. | duty manager |
| `normal` | Running. | duty manager |
| `degraded` | Partly working — one interface down, one module unreliable — and staff must know which. **A note is mandatory.** | duty manager |
| `downtime` | The screens are not to be trusted; the hospital is on paper. **A note is mandatory.** | duty manager |

The mode is an **append-only ledger** (`operating_mode_changes`), not a row somebody updates. The
current mode is the row with the highest `seq` — so the history comes free, cannot be edited away,
and is what an incident review reads back. `GET /ops/mode` is authenticated-only (every screen's
banner reads it); changing it needs the `ops.mode.set` permission at hospital scope.

### Leaving `commissioning` IS the go-live gate (D3)

`commissioning` is not left by asserting that things are fine. The only way out is through a
**persisted, all-green configuration validation report no older than 24 hours**:

1. `pnpm validate:config` on the box, or `POST /ops/config-validation` from the mode desk. Both
   call the same function — a runbook step and a button that disagreed about what "validated"
   means would be worse than having only one.
2. Read the per-scope lines. The run returns `200` with `ok: false` when the *configuration* is
   bad: the run succeeded, the configuration did not, and the errors are the response.
3. Fix what is red, re-run until `ok: true`, then declare `ramp` or `normal`.

A refusal names *why*: `no_report` (never run), `stale_report` (older than 24h), or
`report_not_ok` (the latest run was red). The gate rides **every** exit from `commissioning`, not
only the exits to `ramp`/`normal` — otherwise `commissioning → downtime → normal` would be a
two-step way around it.

### Declaring and recovering

- **Declare**: the mode desk at `/ops/mode`, or `POST /ops/mode` with
  `{ "to": "...", "note": "..." }`. Entering `degraded` or `downtime` **without a note is refused**
  (`mode_note_required`); the note is what the banner shows every user on every screen, and what
  the incident review reads.
- **Recover**: declare the mode you are actually in — usually `degraded` first, then `normal` when
  the last interface is back. There is no "undo": recovery is another appended row, with its own
  note. A no-op transition (`downtime → downtime`) is refused, so re-declaring cannot quietly
  re-alert everybody.
- **What the owner receives**: a mode change raises an alert through the shipped alerts fabric
  (`ops.mode_changed` → `kernel.alerts`), so every holder of the `owner` role gets an in-app alert
  and the bell lights up. It is idempotent on redelivery — one alert per holder per change, however
  many times the event is delivered. Mode alerts carry **mode words and the note only**; no patient
  identity, ever (GC6).
- **`ops.mode.set` is duty-manager authority, and NOTHING GRANTS IT UNTIL YOU RUN `pnpm seed:ops`.**

  > **CORRECTED 2026-08-23.** This paragraph used to read *"the seeded `admin` role holds every
  > manifest permission in dev"*. **That was false, and it was the dangerous kind of false**, because
  > it told the operator a grant had already happened. `scripts/seed-admin.ts` installs
  > `authManifest` ALONE, so it grants six `auth.*` strings and nothing else — and it returns early
  > on any deployment that already has an admin user, so on a live box it grants nothing at all.
  > `syncPermissions` mirrors permission NAMES into `permissions` at boot; it is a catalog and it
  > authorises no one. Found by Plan 11c's discovery review (gate report MAJOR 4): every `/ops` route
  > would have answered **403 to every user**, with the mode desk and downtime-kit links leading to
  > screens whose every action is refused — the emergency path, unreachable.

  **The go-live step, and it is idempotent so it belongs in the re-deploy path forever:**

  ```sh
  # 1. roles + grants only — safe to run any time, changes nothing on a second run
  pnpm --filter @hmis/core seed:ops

  # 2. appoint the actual humans (comma-separated usernames), and say who is woken at 03:00
  OPS_DUTY_MANAGERS=asha,ravi OPS_OWNERS=ankit pnpm --filter @hmis/core seed:ops
  ```

  It creates the `duty_manager` and `owner` roles if absent, grants all three `ops.*` permissions to
  `duty_manager` (and to `admin` if that role exists), assigns any usernames you name, and **prints a
  readiness verdict as its last line**. A username that does not exist is a hard error with exit 1,
  never a silent skip — believing you appointed a duty manager when you did not is the failure this
  guards.

  Two states it will refuse to call READY, both of which look like a working system until the night
  they matter: **no `duty_manager` holder** means nobody can declare downtime or print a kit, and
  **no `owner` holder** means a downtime declaration raises an alert for nobody, because the fan-out
  is `usersHoldingRole(owner)`.

  `owner` is granted no `ops.*` permission deliberately — map 1's rule is that the owner is *alerted*
  and never *required to act*, and receiving an alert needs no permission. **Do not run a hospital in
  which everybody can declare downtime.**

### The downtime protocol, and the kit

When the screens go dark the hospital does not stop; it writes on paper. The kit is what makes that
paper **reconcilable afterwards** rather than a stack of anonymous sheets.

1. **Generate** — `/ops/downtime-kit`, or `POST /ops/downtime-kits`, with a count per form kind
   (`registration`, `consultation`, `receipt`). Needs `ops.downtime.generate`. Each kind draws a
   **reserved, disjoint serial range** from its own counter under a row lock, so two people
   generating at the same moment can never be handed overlapping paper.
2. **Print** — `GET /ops/downtime-kits/:id` renders one entry per SHEET, each carrying a **signed
   QR** (`dtk1.<kitId>.<formKind>.<serial>.<hmac>`). Print it, on paper, **before** you need it.
   The screen replaces itself with the print surface (`.print-doc`), so what comes out of the
   printer is the form and nothing else.
3. **Seal** — put the printed kit in the drawer at each desk it serves, sealed, with the kit id
   written on the outside. A kit generated during an outage is a kit generated on a system that is
   down; that is the whole reason step 2 says *before*.
4. **Use** — during downtime each desk writes on the next sheet in its own kit. The serial on the
   sheet is a reconciliation key; it is not an invoice number and never becomes one.
5. **Recover and reconcile** — when the system is back, backfill each used sheet through the normal
   lane (registration, consultation, billing). Billing allocates a **real** invoice number from
   `document_series` at that moment. Scan or type the QR: a serial somebody invented, or wrote on
   the wrong form kind, **fails verification** rather than merely looking plausible. Then account
   for the unused blanks — the ranges are enumerable, so "which sheets exist, which were used,
   which are still blank" is a question with an answer.

**Why the kit does not draw from billing's `document_series`**: a `document_series` number is a
GST-consecutive document number. If a kit drew from it, every unused blank left in a drawer would
have consumed a number that no document will ever carry, and the consecutiveness the series exists
to guarantee would be broken by stationery.

### Interfaces and the heartbeat registry

Registered interfaces (`ops.interface.manage`) send heartbeats; a sweep job downs any that has gone
stale past its own `stale_after_ms` and appends `interface.down`, and the next heartbeat restores it
with `interface.restored`. An interface that has **never** sent a heartbeat stays `unknown` and is
never "downed" — a thing that has not started is a different fact from a thing that has stopped, and
conflating them is how a monitoring stack teaches people to ignore it. `degraded` mode plus the
interface list is how the floor finds out which half is broken.

## Deployment (Plan 11a)

Stage 1 (spec v4.7 §1, roadmap "Deployment topology"): ONE Hetzner cloud box, no standby, running
`hmis-prod` — its own Compose project, Postgres container, volumes and port range — BESIDE the
dev/build stack on the same host (owner ruling 2). Stage 2 adds a live pilot beside the incumbent
and moves toward hybrid (Plan 11b); stage 3 is fully on-prem. **Nothing here is provider-specific**
(D4/GC1): Compose + Caddy + Postgres + pgBackRest stand up on any capable metal, and the two
externals this plan touches are protocol-shaped — a backup destination speaking S3, and DNS
pointing a hostname at a box — so racking this on-prem tomorrow RE-POINTS a handful of values; it
rewrites nothing.

### Deploy sequence

`docker/prod/deploy.sh` is idempotent — run it to bring `hmis-prod` up from nothing or to
re-converge a running stack; re-running it over a live stack is the normal case (measured: it
recreates a container only when that container's OWN definition changed — a config-only edit to,
say, `alerts.yml` recreates nothing; see **Monitoring** below for how such an edit takes effect).

0. **Pre-flight** — refuses unless `/opt/hmis-prod` exists, `.env` and `.env.r2` are present and
   `chmod 600`, and 80/443 are free or already held by this stack's own Caddy.
1. **Build** the server, web and db images FROM THE CHECKOUT (never from `/opt/hmis-prod`).
2. **Copy configs** into `/opt/hmis-prod` (compose file, Caddyfile, pgBackRest config, the restore
   drill, the Prometheus/Grafana/postgres-exporter trees) and derive the backup credentials.
3. **`db` up**, waited on its own `pg_isready` healthcheck.
4. **pgBackRest**: stanza created, archiving CHECKED end to end (a forced WAL switch that has to
   actually land in the repository — D8).
5. **Migrations** from inside the image, then **cursor seeding** (D10): every production
   consumer (`kernel.alerts`, `kernel.notify`) is seeded at `max(seq)` so a first boot against a
   database that already carries history does not replay it through the dispatcher. Idempotent —
   it stays in the re-deploy path forever, and never lowers a cursor a live dispatch cycle has
   already moved past. **Then CONFIGURATION SEEDING and the CONFIGURATION GATE (Plan 11g / DD2):**
   `seed:ops`, `seed:opd`, `seed:billing`, `seed:tariff` and `seed:roles` — all five
   non-destructive on re-run, so a corrected money or tax value is never overwritten — followed by
   `check:config-present`, which **fails the deploy** if a row the modules throw without is
   missing. Until 11g this step ran the cursor seed and nothing else, and production was deployed
   with `billing_config` empty: every invoice threw, the nightly close failed for a day, and a
   doctor could not start a consultation. `seed:roles` is run for its GRANTS but its readiness
   VERDICT is deliberately not the deploy's exit status — that verdict is about who holds which
   role, which no deploy can repair. `seed:admin` is **not** here: it mints the bootstrap
   administrator and is an owner step.
6. **`api`, `worker`, `caddy` and the monitoring stack up** in one whole-project `compose up -d`;
   Caddy's edge config is then explicitly RELOADED (its directory-mounted Caddyfile does not
   itself trigger a container recreate on a content-only change).
7. **Cron installed**: the nightly full backup and the weekly restore drill (below).
8. **The EDGE gate, both halves** (Plan 11g / DD1): **`/api/health` verified GREEN through
   Caddy, over HTTPS, on the real hostname AND its body verified to be JSON**, plus a screen
   path (`/admin/users`) verified to serve the SPA document. The API lives under `/api/*`;
   a bare `https://<site>/health` now returns the SPA with HTTP 200 and proves nothing.

**AFTER ANY DEPLOY THAT MOVED THE API PATH SPACE — AND PLAN 11g DID — HARD-RELOAD EVERY OPEN
BROWSER TAB** (Ctrl+Shift+R). A tab still holding a pre-11g bundle requests the bare paths, gets
the SPA's `index.html` where it expects JSON, and fails with an unrecognised parse error rather
than a refusal any screen knows how to render. Nothing is lost and nothing is double-posted — the
API never sees those requests — but a cashier mid-shift, or the waiting-room display board left on
`/opd/display` overnight, will show unexplained failures until somebody reloads. `deploy.sh` prints
this reminder as its last line.

First bring-up, in order: create `/opt/hmis-prod` (`mkdir -p /opt/hmis-prod && chmod 700
/opt/hmis-prod`) → copy `docker/prod/.env.prod.example` to `/opt/hmis-prod/.env` and fill the
database password → run the **SECRET_KEY ceremony** below → put R2 credentials at
`/opt/hmis-prod/.env.r2` (procedure below) → `docker/prod/deploy.sh`, which prints
`hmis-prod is up: https://<hostname>` on success.

### The `SECRET_KEY` ceremony and escrow (D11)

- Generated **on the box**, never in git: `openssl rand -hex 32`, pasted after `SECRET_KEY=` in
  `/opt/hmis-prod/.env`. `chmod 600` that file immediately — `deploy.sh` refuses to run without
  it. This discharges `.env.example:5`'s promise that *"the production key is generated and
  escrowed in Plan 11."*
- **Escrow it**: copy the value into the hospital's own secret-management procedure for infra
  credentials, then read it back from wherever it now lives and compare it byte-for-byte against
  what is in `.env` before treating this step as done. Losing `SECRET_KEY` invalidates every
  session and everything sealed under it; leaking it is a full compromise.
- **A SECOND SECRET NEEDS THE SAME ESCROW, MINTED THE SAME WAY, BY `deploy.sh` ITSELF**: the first
  time it runs, it mints `PGBACKREST_REPO1_CIPHER_PASS` into `/opt/hmis-prod/.env.pgbackrest`
  (`chmod 600`) and preserves it verbatim on every later run — watch for the line
  `MINTED A NEW REPOSITORY CIPHER PASSPHRASE`, printed exactly once. It is the client-side
  encryption passphrase (spec E-2) for every backup in the R2 bucket: **losing it makes every
  backup unreadable ciphertext, including to the owner; changing it orphans everything already
  written** while every new backup keeps succeeding — the single most dangerous secret in this
  deployment to mishandle, because the failure is silent until the day of a restore.
- **A THIRD SECRET JOINS THE CEREMONY (Plan 11c / D10): THE SMTP CREDENTIAL.** The six keys in
  `/opt/hmis-prod/.env.smtp` (`chmod 600`) are what let a critical alert reach a human being at
  all, and `SMTP_PASSWORD` — a mailbox password, or an app password minted for this purpose
  alone on a provider with 2-step verification — is the credential among them. **Escrow it the
  same way, at the same time, in the same place** as `SECRET_KEY` and the pgBackRest cipher
  passphrase, and read it back from wherever it now lives before calling the step done.
  - Losing it is the mildest of the three: the alert path goes silent and is repaired by
    minting a new app password, filling `.env.smtp`, and re-running `deploy.sh`. **But it goes
    silent WITHOUT SAYING SO** — nothing pages you to tell you that paging has stopped — which
    is why it belongs in the ceremony rather than in somebody's memory. Re-run the synthetic
    alert drill in the alert-path section after any rotation, and confirm the mail arrived.
  - `ALERT_EMAIL_TO` is not a secret but it is just as load-bearing: it is **who is woken up**.
    A distribution list is fine; an unattended mailbox defeats the entire stack.
- None of the three values is ever written to this file, a report, a commit, or a chat message
  (GC2) — this section names the procedure, never a value.

### R2 credentials procedure

- The five values (`R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`) live **only** at `/opt/hmis-prod/.env.r2`, `chmod 600`, and never enter
  git, a report, or a chat message — see `docker/prod/.env.prod.example` for the shape (values
  empty on purpose).
- `deploy.sh` reads them from that file on every run and derives
  `/opt/hmis-prod/.env.pgbackrest` (also `chmod 600`) — the six `PGBACKREST_*` names the binary
  reads, plus the cipher passphrase above. **Never hand-edit the derived file**; it is
  regenerated every run, with the cipher passphrase preserved.
- **To rotate the R2 access key**: update `.env.r2`, re-run `deploy.sh`. The derived file picks
  up the new key/secret; the cipher passphrase is untouched.
- **Owner-carried item (Decisions §6): mask the R2 endpoint under an owner-controlled domain
  later** — re-point one line in `.env.r2` (and `pgbackrest.conf`'s CA path only if the new
  endpoint needs a different CA) when that happens; nothing else in this deployment changes (D4).

### The restore drill, and how to read its verdicts

- `docker/prod/drill/restore-drill.sh`, installed to `/opt/hmis-prod/drill/restore-drill.sh` by
  `deploy.sh`, runs **weekly** via a host cron entry `deploy.sh` also installs (Saturday 22:00
  UTC = 03:30 IST Sunday, an hour after Saturday night's full) and logs to
  `/opt/hmis-prod/log/restore-drill.log`.
- **It restores for real, never a `--dry-run`** (Global Constraint 7 — a backup nobody has
  restored is a belief, not a backup): census the live cluster → incremental backup → restore
  into a throwaway scratch container (never production's own `PGDATA`) → boot a second postmaster
  on the restored data → run the migrator's own consistency check against it → assert the row
  count and the newest known event id came back → drop the scratch database and destroy the
  container.
- **Read the exit code first — it is the sole authoritative verdict**, quoted directly from the
  script's own comment: a run whose EXIT trap still fires an evented append does not turn a
  failed drill into a green one. `0` = passed; non-zero = failed, and the transcript above the
  failure names the step that broke.
- **The verdict is also appended to the hospital's own event log**: `backup.drill_passed` /
  `backup.drill_failed` (module `backup`, defined in `apps/core/src/kernel/retention/events.ts`),
  so it is visible through the same surfaces as every other fact this system records — stanza,
  the live and restored row counts, the asserted event id (nullable), and the backup/restore
  timings in seconds.
- **A run against an empty `events` table says so out loud** rather than silently skipping the
  check: `NO EVENT ID ASSERTED: the live events table was empty at census time`, while the row
  count and migration-journal checks still run. The first genuinely event-bearing drill is the
  first one after production actually records something.
- To rehearse the drill without touching the production repository, point it at a scratch prefix
  in the same bucket: `HMIS_DRILL_REPO_PATH=/hmis-prod-rehearsal-<name>
  docker/prod/drill/restore-drill.sh` — this never touches the live cluster's own credentials or
  the production prefix it backs up to.

### The accepted shared-box failure mode (D13)

Stage 1 runs `hmis-prod` on the **same box** as the dev/build stack (owner ruling 2, accepted with
the contention risk named up front). **The symptom this can produce is LATENCY, NEVER DATA.** The
two stacks are different Compose projects (`hmis` / `hmis-prod`), different Postgres CONTAINERS on
different VOLUMES on different PORTS (dev 5433, prod `127.0.0.1:5434`) — there is no shared table
for a `truncate`, a migration, or a schema change on one side to reach on the other. Per-service
resource limits (`docker-compose.prod.yml`'s `deploy.resources`) bound how much either side can
take from the other, so a heavy pipeline run or test suite pass on the dev side can make a live
UAT session feel slow; it cannot make it wrong. If a UAT session is sluggish while a pipeline is
running, check `docker stats` to see which side is using the CPU/IO before assuming anything is
broken — that is this accepted trade-off working as designed, not an incident.

### Stage-1 RPO/RTO — stated honestly for a single box

- **RPO ≈ the WAL-push interval.** Continuous archiving pushes each WAL segment as it fills, or at
  worst every `archive_timeout` (300 s — `docker-compose.prod.yml`'s `db` service `command`), so
  the worst-case data-loss window is about five minutes of writes, not the time since the last
  nightly full.
- **RTO ≈ measured restore time + bring-up.** A real restore of a bundled, encrypted backup out of
  the production R2 bucket measured **4 seconds** for a 33 MB / 1671-file cluster (the Plan 11a
  T4 gate) — that number grows with database size, but it is the honest starting point. Add the
  time to run `deploy.sh` end to end against a repaired or replacement box (image builds, then the
  full sequence above) for the complete recovery time.
- **THIS IS NOT SPEC §12'S <15-MINUTE RTO TARGET — that target assumes a standby ready to
  promote, and stage 1 has none** (no replication, no promotion, no fencing; all Plan 11b, stage
  2, a second machine). A real outage on this box means: repair or replace the box, run
  `deploy.sh`, restore from R2. Nothing in stage 1 is engineered to make that FAST; it is
  engineered to make it POSSIBLE and PRACTICED — the weekly drill above is what "practiced" means.

### Retention (D6/D7) — what is deleted, what never is, and how to place a legal hold

**Retention is OFF as shipped, and that is deliberate.** `RETENTION_ENABLED` defaults to `false`,
so the `retentionSweep` job runs nightly at **01:15 IST**, finds its work, and deletes nothing.
**Do not turn it on until counsel has signed the window** (Plan 11a ruling 6). Deleting a clinical
record is not a decision a deployment makes.

Read this whole section before you flip it. In particular, understand how to place a legal hold
*before* you enable deletion, not after.

**The three settings** (all optional, all defaulted in `config.ts`, all commented in
`.env.prod.example`):

| key | default | what it governs |
|---|---|---|
| `RETENTION_ENABLED` | `false` | the master switch. False = the sweep is inert. |
| `RETENTION_EVENTS_MONTHS` | `120` (10 years) | how much of the `events` history is kept |
| `NOTIFY_RETAIN_DAYS` | `180` | how long terminal `notifications` rows are kept |

**What the sweep does when it is enabled.**

1. **`events` are dropped a whole month at a time, as partitions — never row by row.** That is the
   entire point of partitioning by the retention unit (D5): a month leaves in one irreversible
   statement, or it does not leave at all.
2. **Three things are never dropped whatever the configuration says:** the `DEFAULT` partition,
   the current month, and the adjacent month. A month with no partition of its own cannot be
   dropped by definition.
3. **The trail goes with the month, and only with the month.** The same run prunes
   `event_idempotency` (by `recorded_at`), `event_deliveries` (by `updated_at`) and
   `event_dead_letters` (by `parked_at`) in the same window — because a partition drop otherwise
   *orphans* those rows and silently moves the growth problem one table over. A `retrying`
   delivery is **never** deleted at any age: its age says only that it has been failing for a long
   time, not that it is finished.
4. **Terminal `notifications` rows** (`sent` · `expired` · `suppressed` · `undeliverable`) older
   than `NOTIFY_RETAIN_DAYS` are pruned in bounded batches. **`queued` and `sending` are never
   pruned at any age** — a `sending` row is the only record that a message may already be with a
   patient.

**Everything it does is evented**, so the hospital's own event stream is the audit trail:
`retention.partition_dropped` · `retention.drop_blocked` · `retention.side_tables_pruned` ·
`retention.notifications_pruned`.

#### Placing a legal hold

**A hold is a row, not a setting.** It lives in `retention_legal_holds`, and the sweep reads it on
every run. There are two shapes.

A **patient hold** protects every month containing any event of that patient:

```sql
insert into retention_legal_holds (id, patient_id, reason, created_by)
values (
  '01J000000000000000000HOLD',              -- any ULID; the id grammar entities share
  '01HR0PATIENT00000000000001',             -- the patient
  'Matter 2026/114 — preservation order of 2026-08-20, per counsel',
  'owner:asharma'                           -- who placed it
);
```

A **global hold** — litigation's actual shape, "preserve everything from this period" — is the
same row with **`patient_id` left NULL**:

```sql
insert into retention_legal_holds (id, patient_id, reason, created_by)
values ('01J000000000000000000GLOB', null, 'Matter 2026/114 — blanket preservation', 'owner:asharma');
```

**Releasing a hold NEVER deletes the row.** `released_at` is the only way a hold stops applying,
so the record that a hold once existed survives it:

```sql
update retention_legal_holds set released_at = now() where id = '01J000000000000000000HOLD';
```

Listing what is currently in force:

```sql
select id, coalesce(patient_id, '(GLOBAL)') as scope, reason, created_at, created_by
from retention_legal_holds where released_at is null order by created_at;
```

#### What a hold actually protects — and how to read a refusal

An active hold protects **the month's events and the month's trail**: the partition is not
dropped, and the same month's `event_idempotency`, `event_deliveries` and `event_dead_letters`
rows are not pruned either. A **global** hold makes the companion prune a complete no-op.

*(That second half was a real gap: the hold originally saved the partition while the same run
deleted the month's delivery trail. Fixed in `8a9fb46`; if you are reading an older checkout,
check that `companionSweepCutoff` exists in `kernel/retention/sweep.ts`.)*

**A refusal is visible, not silent.** When a month is held, the sweep appends
`retention.drop_blocked` naming the partition, the month, the reason (`legal_hold_global` or
`legal_hold_patient`) and the hold's id. To see whether last night's sweep refused anything:

```sql
select recorded_at, payload from events
where name = 'retention.drop_blocked' order by recorded_at desc limit 20;
```

And to confirm a shortened companion prune, `retention.side_tables_pruned` carries the **clamped**
cutoff it actually used — so a run held back by a hold is readable in the stream rather than
inferred from a low count.

**One thing a hold does not currently cover:** the `notifications` prune runs on its own window
regardless of holds. That is a deliberate, narrow reading — a notification is the messaging
side-effect of an event, and the event itself is preserved — and it is a question for counsel
rather than for a deployment. If the answer ever changes, it is one guard on the prune's batch
loop, and the shape is written into the comment above it.

### Monitoring (D9)

- **Prometheus (`127.0.0.1:9090`) and Grafana (`127.0.0.1:3001`) join the same `hmis-prod`
  Compose project** and are reached over an SSH tunnel — no new public port ships:
  `ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 root@<box>`, then open
  `http://127.0.0.1:3001` locally. `node_exporter` and `postgres_exporter` publish nothing at
  all — Prometheus reaches both over the compose network by service name.
- **Grafana's login is the image's stock default** (`admin` / `admin`, forced change on first
  login) — change it the first time you tunnel in. No credential is generated or escrowed for it:
  the surface is loopback-only either way, and `deploy.sh`'s credential-minting block mints only
  `SECRET_KEY`'s companion (the pgBackRest cipher passphrase above) — nothing here adds a second
  one.
- **The provisioned dashboard** ("HMIS — production overview") reads per-job scheduler heartbeat
  staleness (`hmis_scheduler_heartbeat_staleness_seconds`, a SELECT against the already-shipped
  `scheduler_heartbeats` table — no new instrumentation), whether any job is currently failing,
  `pg_up` and active connections (postgres_exporter's own built-in collectors), and host
  CPU/memory/disk (node_exporter).
- **The alert rule carries two legs, deliberately** (`docker/prod/prometheus/alerts.yml`): a
  STALENESS threshold for a job that HAS a heartbeat row, and a MISSING-SERIES check (`absent()`)
  for a job that has NEVER started. A heartbeat row is created only on a job's first tick, so
  staleness alone reads green precisely when a job has never run at all — the missing-series leg
  is what catches that (proven by drill; the gate report carries the transcript).
- **A config-only edit to `prometheus.yml` or `alerts.yml` does not itself take effect on a
  redeploy** — the directory mount that fixed this exact problem for Caddy (T3-1) means
  `compose up -d` recreates nothing when only file CONTENTS changed. Reload Prometheus the same
  way `deploy.sh` reloads Caddy: `curl -X POST http://127.0.0.1:9090/-/reload` over the tunnel.
- **Loki is deliberately not here.** On one box, `docker compose -p hmis-prod logs <service>` and
  `journalctl` are the log story; aggregation earns its cost with a second machine (stage 2).

### The alert path (Plan 11c / D10) — what reaches the inbox, and what to do at 03:00

Until Plan 11c there was no alert *path*. Every rule in `prometheus/alerts.yml` evaluated
correctly, turned red on a page nobody had open, and reached **no human being** — which on a single
box with no on-call rotation is the same as having no alerting at all. The ninth compose service
closes it.

- **Alertmanager (`prom/alertmanager:v0.27.0`, `127.0.0.1:9093`)** joins the `hmis-prod` project.
  Prometheus reaches it by service name over the compose network (`alerting:` in
  `prometheus.yml`); the loopback publication is for `amtool` on the box and for an SSH tunnel, and
  no public port ships.
- **`severity: critical` is dispatched immediately** (`group_wait: 0s`) and **re-sent every 4
  hours** until it resolves — so a page slept through at 03:00 is still on the screen at 07:00.
  **`severity: warning` is batched** (`group_wait: 5m`, `group_interval: 4h`), so a bad afternoon
  produces one mail rather than forty. Both receivers send a resolved notice.
- **The credentials never enter git (GC2).** `docker/prod/alertmanager/alertmanager.yml.tpl` is a
  template carrying `__PLACEHOLDER__` tokens; `deploy.sh` step 2 renders it into
  `/opt/hmis-prod/alertmanager/alertmanager.yml` from the owner's `/opt/hmis-prod/.env.smtp` (six
  keys, chmod 600). **The password is not even in the rendered file** — it is written to a separate
  `smtp_password` file that `smtp_auth_password_file` points at. Both derived files are 600 and
  owned by the container's own uid.
- **Port 587 with STARTTLS, and this is measured rather than conventional.** On this box **465 and
  25 are blocked outbound** — a silent timeout with no output at all, the drop signature rather
  than a refusal (11c spike, two providers, IPv4 and IPv6). 465 is not a fallback; a provider that
  offers only implicit TLS on 465 needs a relay in front of it.
- **A missing or incomplete `.env.smtp` refuses the deploy**, with the six-key shape printed. That
  is deliberate: a deploy that "succeeded" with no alert path is the worst outcome available here,
  because an inert alert stack is indistinguishable from a quiet night right up until it isn't.
- **Re-pointing the mailbox is an edit to `.env.smtp` and a re-run of `deploy.sh`.** The script
  restarts alertmanager unconditionally after rendering, because Alertmanager reads its config only
  at startup and `compose up -d` does not recreate a service whose *definition* is unchanged — the
  same trap that left grafana and prometheus running on empty config for 35 minutes in Plan 11a.
- **Alertmanager is itself a scrape target as of Plan 11d** (`job_name: alertmanager` in
  `prometheus.yml`, reached by service name like everything else). It exists for exactly one
  reason: so the three rules in *When the alert path itself breaks* below can be written at all.

#### What actually reaches the inbox today

| alert | severity | means |
|---|---|---|
| `HmisSchedulerJobStaleInterval` | critical | one of the five `every(ms)` jobs has not ticked in 5 minutes |
| `HmisSchedulerJobMissing` | critical | a job has **never** reported a heartbeat — the blind spot a staleness threshold cannot see |
| `HmisSchedulerJobStaleDaily` | warning | a daily job missed its run (26h threshold) |
| `HmisBackupDrillOverdue` | critical | no restore drill has passed in over 8 days |
| `HmisBackupDrillFailed` | critical | the most recent restore drill **failed** |
| `HmisAlertmanagerDown` | critical | the alert sink itself is gone or crash-looping — **read the limit below before trusting this one** |
| `HmisAlertNotificationsFailing` | critical | Alertmanager is up and the mail is not going out: a rotated app password, a bouncing mailbox, an SMTP host that stopped answering |
| `HmisPrometheusCannotReachAlertmanager` | critical | Prometheus cannot hand its alerts over — the link between the two, which neither one's own health page reports |
| *(mode changes)* | — | not email: `ops.mode_changed` reaches the owner as an in-app alert through the alerts bell |

#### When the alert path itself breaks (Plan 11d / D7)

Until Plan 11d, **nothing watched the thing that carries every other alert.** A rotated app
password, a bouncing mailbox and a crash-looping Alertmanager all looked exactly like a quiet
night. Three rules in `docker/prod/prometheus/alerts-meta.yml` — a third rule file beside
`alerts.yml` and `alerts-backup.yml` — close that, and Alertmanager became a scrape target purely
so they could be written.

**What you WILL be told, by email:**

- **The mail is failing** (`HmisAlertNotificationsFailing`). This is the likeliest real failure by
  a wide margin — the sink is up, and the credential or the mailbox is broken — and Alertmanager
  can still deliver an alert *about* it, because a failing email receiver does not stop it
  evaluating or routing. The counter behind the rule climbs about six times a minute for as long
  as the failure lasts (measured against a refused SMTP dial), so the alert keeps being re-sent
  rather than appearing once and going quiet.

**What you will NOT be told, and it is arithmetic rather than an oversight:**

- **An alert about a broken Alertmanager cannot be delivered by that Alertmanager.** On one box
  there is no second sink and no on-call rotation to fall back to. If Alertmanager is dead,
  `HmisAlertmanagerDown` and `HmisPrometheusCannotReachAlertmanager` turn red where you can SEE
  them — Prometheus's own `/alerts` on `http://127.0.0.1:9090` and Grafana on
  `http://127.0.0.1:3001`, both through the tunnel in step 3 below — and **no mail arrives.**
  `HmisPrometheusCannotReachAlertmanager` is at least evaluated by a *different process* than the
  one that is broken, which is why it is worth having even when it cannot be posted.
- **So the practical rule is that a silent week is not proof.** If nothing at all has arrived for
  an unusually long stretch, run the synthetic drill under *Silences, and testing the path* below.
  That one action is what distinguishes "nothing is wrong" from "nothing is being delivered", and
  it takes under a minute.
- The genuinely out-of-band answer — a watchdog on a **second machine** plus a deadman's switch —
  is Plan 11b's, where a second machine exists to host it. It is not half-built here.

**A rule file is only as real as its install.** `apps/core/test/deploy-parity.test.ts` fails the
build if `prometheus.yml` loads a rule file `deploy.sh` does not install, if `deploy.sh` installs
one nothing loads, or if a service whose config directory `deploy.sh` populates is left out of the
restart loop — the three ways a monitoring change has silently shipped INERT on this box before.

#### At 03:00, in order

1. **Read the subject line.** `[HMIS CRITICAL]` is a page; `[HMIS]` is a digest and can wait for
   morning.
2. **Is the hospital serving?** `curl -fsS https://<site>/api/health` from anywhere — **`/api`, and
   it matters**: since Plan 11g the API lives under `/api/*` and a bare `https://<site>/health`
   is served by the SPA handler, so it answers HTTP 200 with an HTML page whether or not the API
   is alive. A green answer here is JSON (`{"status":"ok",…}`). If it is green, the floor is
   working and you are debugging a background job, not an outage — the answer is probably
   morning.
3. **If it is not green**, tunnel in and look:
   `ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@<box>`, then
   Grafana on `http://127.0.0.1:3001` and Prometheus's own `/alerts` on `http://127.0.0.1:9090`.
4. **`docker compose -p hmis-prod ps`** and **`… logs --tail 100 <service>`**. A service in
   `Restarting` is the answer; there is no cluster to fail over to and no standby to promote.
5. **If the floor cannot work, declare `downtime` from the mode desk with a note.** That is what
   the banner and the paper kit are for, and it is a faster path back to a working hospital than
   any repair you will attempt at 03:00. Declare `degraded`/`normal` on the way back out.
6. **Backup drill alerts are never an emergency at 03:00** — they are an emergency *this week*.
   Read `/opt/hmis-prod/log/restore-drill.log`, then
   `docker exec --user postgres hmis-prod-db-1 pgbackrest --stanza=hmis check`, and run the drill
   by hand once you understand why it stopped passing. Until it passes, treat the backups as
   unproven.

#### Silences, and testing the path

- **Silence a known-noisy alert while you fix it**, rather than muting the mailbox:
  `docker exec hmis-prod-alertmanager-1 amtool --alertmanager.url=http://127.0.0.1:9093 silence add alertname=HmisBackupDrillOverdue --duration=24h --comment="drill re-run scheduled"`.
  Silences survive a redeploy because Alertmanager's state is on a **named volume**
  (`alertmanager_data`) — without one, every recreate would forget every silence and strand an
  anonymous volume on the box.
- **Prove the path end to end** after any change to the mailbox:
  ```
  docker exec hmis-prod-alertmanager-1 amtool --alertmanager.url=http://127.0.0.1:9093 \
    alert add alertname=HmisAlertPathDrill severity=critical \
    --annotation=summary="synthetic drill — ignore"
  docker exec hmis-prod-alertmanager-1 amtool --alertmanager.url=http://127.0.0.1:9093 alert --output=extended
  docker compose -p hmis-prod logs --tail 50 alertmanager
  ```
  The alert's `receivers` field is where you read that it routed to `owner-immediate`;
  **Alertmanager redacts the receiver URL in its own notify log** (`Post "<redacted>"`), so do not
  expect the log to name the SMTP endpoint. Then check the inbox — the log saying the notify
  succeeded and a human seeing the mail are two different facts, and only the second one is the
  thing this stack exists to deliver.

### Production run commands (§2.58 correction)

FORK-A resolved to **COMPILED**: production never runs through `tsx`. The images `deploy.sh`
builds run `node dist/src/main.js` (api), `node dist/src/worker.js` (worker) and
`node dist/scripts/migrate.js` (the migrator) — named directly in `docker-compose.prod.yml`'s
`command:` for each service.

**This corrects a run command that has been silently broken since Plan 07.** The dev command this
README's **Run locally** section documents (`start:dev`, i.e. `tsx watch src/main.ts`) crashes at
`OpdRealtimeRegistrar.onModuleInit`: `tsx`'s transformer (esbuild) emits no `design:paramtypes`
metadata for Nest's constructor injection, so a class-typed dependency resolves to `undefined` and
the crash surfaces the first time that dependency is used. `tsc` — what
`pnpm --filter @hmis/core build` runs, and what `deploy.sh` builds the production image with —
DOES emit that metadata, so the compiled api starts clean: measured serving a `200`
(`degraded`/`worker: stale` with no worker running, `ok` with one) `/health` response in the Plan
11a spike, faster to first response than the (non-booting) `tsx` path it replaces. Production
sidesteps the bug class entirely by never transpiling on boot — this is not a fix for `tsx`'s dev
experience, and `start:dev`'s crash remains something to know about rather than something this
plan repairs.
