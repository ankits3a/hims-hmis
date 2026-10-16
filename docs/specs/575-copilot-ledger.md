---
issue: 575
status: built
approved: 2026-10-10
---
# SPEC — the copilot ledger (E0.1, decision 0064) — 2026-10-10 — APPROVED by the owner 2026-10-10 (as written, incl. D1, D2, D6)

Lane `copilot-ledger` (branch lane/copilot-ledger from main dc2edd4c). Plan: docs/superpowers/plans/2026-10-10-copilot-PLAN.md §3 E0.1.

**What it builds**
1. `copilot_asks` — one row for every request that reaches `POST /copilot/ask`: when, who (actor type + id), outcome,
   route that answered (phrasebook / chooser / model / none), intent, answer key, milliseconds, the MASKED question
   only (never the raw text; null when the masker's scrubber fired or the body was invalid), optional `screen` sent by
   the web, nullable `source` (chip / typed — filled from E1.3). Outcomes: answered, notUnderstood, noTool,
   notPermitted, needSubject, failed, identifierLeak, refusedActor, badRequest, error (`halted` reserved for E0.3).
   Written before the answer leaves; if the write fails the ask fails (no unrecorded answers).
2. `copilot_acts` — table only, nothing writes it until E0.2: actor, tool, subject patient id, args hash, proposal id,
   confirm id NOT NULL + UNIQUE, resulting module + row id. UPDATE/DELETE blocked by trigger (kept as long as the record).
3. ~~Retention sweep deletes~~ SUPERSEDED by the owner ruling below: the copilot's OWN nightly job `pruneCopilotAsks` (01:20 IST, always on) deletes `copilot_asks` older than 180 days in bounded batches, one count event per run.
4. Router reports `chooser` separately from `model` internally; the web response shape is unchanged.
5. New kernel manifest `copilot` declaring `copilot.health.read`; `GET /copilot/health?date=` returns that IST day's
   totals: asks, distinct askers (a number), by outcome, by route, p50/p95 ms per route, acts count, not-understood share.
6. A small read-only web page "Copilot health" (en + hi) showing those numbers.

**Done means** (binary; go to `acceptance/` once approved)
1. N asks → N `copilot_asks` rows, including notUnderstood, IdentifierLeak, notPermitted, non-user actor refusal and invalid body.
2. No ledger row contains the raw question: a question with a UHID/phone stores `<<P1>>`; an IdentifierLeak row stores null.
3. Each row names the route that answered; a chooser-answered ask records `chooser`, not `model`.
4. Inserting a `copilot_acts` row with a null confirm id fails at the database; a second row with the same confirm id fails.
5. UPDATE or DELETE on `copilot_acts` fails at the database.
6. With RETENTION_ENABLED=false, the `pruneCopilotAsks` job deletes a 181-day-old ask and keeps a 179-day-old one; acts are untouched.
7. `GET /copilot/health` returns today's counts to owner, admin and quality_manager, 403 to a doctor/cashier.
8. The health response and page carry no user id, name or per-person list (key set asserted).
9. `seed-roles` census, schema census, typecheck, lint and `node tools/arch/gen.mjs --check` green.
10. A user who has not seen the notice sees it before the first ask; after dismissing, never again; the ledger row is still written for every ask.

**Decisions (DECIDED unless the owner says otherwise)**
- D1 Asks go in their own table, NOT `events` (departs from plan text). `events` is append-only by trigger (migration
  0139) and kept 10 years by monthly partition drop, so 180-day ask retention cannot be done there. `search_audit`
  (own table, own window, count event on prune) is the house precedent.
- D2 `copilot.health.read` → `owner`, `admin` (IT), and a NEW role `quality_manager` (the steward, plan §5; no such
  role exists today). Roles that exist: owner, admin, medical_superintendent, duty_manager, staff_auditor and the clinical/department roles; no quality or steward role.
- D3 No subject/patient id and no rehydrated value on ask rows; distinct askers is a count only (no per-person view).
- D4 G6(a) reconciles against Caddy lines for POST /copilot/ask excluding 401 (those never reach the handler).
- D5 Seat for G1 is derived from roles at report time, not stored.
- D6 The masked question is stored even when it may hold an unmasked typed name (web without terms); that is what the
  steward's monthly 50-row sample (G6c) exists to find.

**Collisions:** no open PR touches kernel/copilot or seed-roles. #568 (lab quick) and #565 (vendor rates) take
migrations 0190/0193 + journal; #568 edits `apps/web/src/router.tsx`. Stale local lanes desk-upcoming (2026-09-14)
and pharmacy-safety-d4 (2026-09-28) carry seed-roles/sweep diffs — no open PR, treated as dead.

**Owner ruling 2026-10-10 (R-6 staff notice): NOTICE FIRST.** The notice ships with the ledger; production logging
only with the notice. Web: one line shown once per user before their first copilot ask (en: "Copilot questions are
logged for 180 days for safety and quality. No one sees a per-person list." + hi), dismissal stored server-side per user
(`copilot_notice_acks`; no existing per-user acknowledgement table fitted). Phone half ships with E1.3 (no phone copilot
yet). Decision record to be written by the orchestrator.

**Owner ruling 2026-10-10 (retention gap): OPTION (a).** Copilot ask rows get their own 180-day deletion,
independent of RETENTION_ENABLED and of the patient-record retention sweep, which stays inert per owner ruling 6 (its
defaults, hold checks and HALT list unchanged). Reason: copilot_asks are staff operational rows, not patient-event
records; legal holds govern patient event records. Built as `runCopilotAskPrune` (kernel/copilot/ledger.ts) + worker
job `pruneCopilotAsks`; the table trigger still allows DELETE only inside the prune's named transaction and only for
rows older than 179 days. kernel/retention/sweep.ts is back to main's text.

**Built 2026-10-10 — departures from the text above:** the permission is declared in the existing kernel `desk`
manifest (the copilot is the desk's agent), not a new `copilot` manifest — avoids `manifests.ts` + its pins. `admin`
gets its grant through a new one-line `ROLE_MODEL` row (seed:admin still owns its `auth.*` set). Page path `/copilot-health`.

**Owner question (law) — ANSWERED above**
Q1 R-6: the ledger is a per-employee activity log under the DPDP Act. May it start recording on production before
the staff-notice line is signed, or must the notice go out first?
