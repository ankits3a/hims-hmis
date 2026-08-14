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
