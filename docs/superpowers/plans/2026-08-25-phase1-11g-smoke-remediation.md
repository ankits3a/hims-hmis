# Plan 11g — smoke-test remediation: screens, deploy-config, and the small sharp edges

> **The phase document** — the only phase-specific artifact, per
> [`EXECUTE-METHOD-V3.md`](../EXECUTE-METHOD-V3.md) §1. **v3's third phase.** Written and
> executed 2026-08-24/25 on the build host by one session, owner watching.
>
> This phase exists to remediate
> [`reports/2026-08-24-synthetic-smoke-test-report.md`](reports/2026-08-24-synthetic-smoke-test-report.md).
> **Its defect numbers D1–D9 are the shared vocabulary and are used throughout** — a `T-D1`
> here is "the task that fixes the report's D1", and this document's own design rulings are
> numbered `DD1…` so they can never be confused with them.
>
> **The seed for a fresh session is three lines: read this document,
> [`AGENT-RULES.md`](../AGENT-RULES.md), and the ledger's §5 — then execute.**

## THE LANE — ruled at write time, v3 §2

**Ruled LIGHT.** Five tasks; no new module, no new screen, no full-module build; the largest
single change is mechanical (one path prefix threaded through the SPA's client, its dev proxy,
the production edge and 22 test files). Two of the five touch seams v3 §0 calls untouchable —
the auth credential path (T-D4) and the production deploy path (T-D2) — and **depth is not set
by the lane**: those carry rule-21 executed mutants and the independent close reviewer exactly
as a HEAVY task would. *(Dissent recorded and overruled: T-D1's blast radius is wide — 32 files
— but wide is not deep. Every one of those edits is the same edit, and a single test decides
whether all of them are right.)*

**Stop-loss: 1.5M total tokens, all sessions counted.** The honest comparable is still missing:
11e's actual and now 11f's are BOTH owner-held (runbook O3, whose class has now recurred three
times), so v3 §6's 1.5×-comparable rule cannot be applied honestly for the third phase running.
The only precedented anchor is 11f's own tripwire — 1.0M, itself set at 40% of the v2 band floor
— and this phase is materially larger than 11f: it carries a migration, a mechanical sweep across
22 test files, an owner-authorised production deploy and a post-deploy verification matrix, where
11f carried none of those. 1.5× that tripwire is the number. **It is a tripwire, not a target.**

---

## 1. Why this phase

The synthetic operational smoke test of 2026-08-24 put 206 scenarios through production over the
application's own HTTP surface and returned a verdict with two halves. The engine held: money
arithmetic, state machines, RBAC, separation of duties, the event loop and 26 of 27 adversarial
refusals all survived deliberate attack, and eight of ten modules came back GO. **And the
hospital still cannot use it** — 15 of 20 screens do not load in a browser (D1), and production
had never been given the configuration its own modules require (D2), which had the nightly close
failing for a day and a doctor unable to start a consultation because billing could not price it.

Neither is a bug in a module. Both are the gap between "deployed" and "operating" that Plan 11f
named as its thesis and did not close, because 11f could only close the half it could see: its
own deploy check recorded *"`/admin/users` answers 401 unauthenticated through the edge, so the
route is live and still guarded"* — true of the **API** route, read as evidence the **screen**
had shipped. That is ledger §2.88 one level out, with a bigger blast radius.

So this phase is remediation and nothing else. It fixes the two severities that stop the
hospital, the two smaller sharp edges the report ranked next (an unmapped 500 on the revenue path,
and an auth surface with no brute-force resistance at all), and it takes one cheap guard that
stops a screen creating records nobody can read. It adds **no new surface**, because a system with
zero operating days does not need more surface — it needs the surface it has to open in a browser.
Everything the report left to an owner ruling is named in §6 and left there.

**What is ruled OUT, in writing, and why.**

- **D5 (silent duplicate registrations) — OUT.** Needs the owner's ruling on what makes two
  registrations the same person before any code can be written. Routed to §6.
- **D6 (a confidential patient is unreachable) — the ROLE half is OUT**, for the same reason:
  `patients.confidential.read` is granted to nobody and `seed-roles.ts:270` records that it is
  awaiting an owner ruling on *who* may read such a record. **The SCREEN half is IN** as T-D6 —
  see DD5.
- **D7 gap 1 (no role holds any `tariff.*` permission) — OUT**, owner ruling, routed to §6.
  **D7 gap 2 (nothing registers the `tariff_revision` approval type) — IN**, folded into T-D2:
  it is an oversight rather than a pending ruling, and the smoke test had to register it by hand
  in production to get a tariff activated at all.
- **D8 (a service in a category with no `gst_config` row fails at the counter) — OUT**, and this
  one is a considered no rather than a deferral: `validateTariffConfig` ALREADY reports
  `gst_config_missing` for exactly this state (`context.ts:114-121`), and that validator is the
  D-17 go-live gate — so the condition is caught before the first live invoice, by design, in the
  place designed for it. Moving the refusal to `createService` would additionally *forbid*
  creating a service before its GST category is configured, which is a workflow ruling nobody has
  made. Recorded, not fixed.
- **D9 (denomination keys are paise) — OUT.** Changing the wire contract of a money field on the
  cash-variance path is not a small sharp edge, and the report's own note is that its screen is
  one of the 15 that do not load, so no UI translation could be verified. **It becomes verifiable
  for the first time when this phase deploys.** Revisit with a human at the counter, not before.
- **Not in scope at all:** Plan 09, runbook O1/O2 (owner-only by construction), the two red CI
  commits (runbook O4), and the DEV PLACEHOLDER money and tax values the smoke test wrote into
  production (runbook O6 owns those, and this phase does not touch a single one of them).

## 2. Ground truth — measured 2026-08-24/25 by this session on the build host

- **HEAD `e9ffe6a`**, clean tree. Baseline `pnpm verify` exit **0** at that SHA:
  `apps/core` **152 suites / 1175 tests** · `apps/web` **36 files / 193 tests** ·
  `packages/contracts` **3 / 7**. Migrations applied: **19** (`0000`–`0018`), so the next tag is **`0019`**; this phase generates it.
- **The SPA declares 20 routes** (`apps/web/src/router.tsx`) and the production edge
  (`docker/prod/Caddyfile`) proxies **12 path prefixes** to the API. Fifteen of the twenty routes
  fall inside a proxied prefix. That is D1, stated as an intersection rather than as a symptom.
- **The nav is 16 raw anchors** (`router.tsx:42-57`), not TanStack `<Link>`s, so every nav click
  is a full browser GET and hits the same wall as a bookmark.
- **`docker/prod/deploy.sh` runs exactly one seed** — `seed-cursors.js`, at line 379. It runs no
  `seed:roles`, no `seed:ops`, no `seed:opd`, no `seed:billing`, no `seed:tariff`. That is D2's
  cause, unchanged since Plan 11a.
- **Four of the five candidate seeds are already non-destructive on re-run** and say so in their
  own headers (`seed-roles.ts`, `seed-ops.ts`: *"all of it idempotent, so it belongs in the
  re-deploy path forever"*; `seed-opd.ts` and `seed-billing.ts`: `onConflictDoNothing`).
  **`seed-tariff.ts` is the exception** — `upsertGstSettings` and `upsertGstCategory` are
  `onConflictDoUpdate` (`gst-config.ts:96` and `:45` respectively), so a re-deploy would overwrite corrected
  money and tax values with DEV PLACEHOLDERS. See Q2.
- **`POST /billing/invoices` has no patient existence check.** `billing.controller.ts:95-110`'s
  `toHttp` maps `BillingError`, `TariffError`, `OpdError`, `PatientError`, `ApprovalError`,
  `WorkflowError`, `SodViolationError` and `ZodError`; a raw pg error falls through to
  `throw e` → 500. That is D3.
- **Nothing in `kernel/auth/` records a failed credential attempt.** `loginWithPassword`
  (`sessions.ts:138-147`) returns `null` and writes nothing; `switchWithPin` (`:149-162`) does the
  same for a **four-digit** PIN. `@nestjs/throttler` is not a dependency. That is D4, and the PIN
  path is the sharper half of it.
- **`/app/syn-tariff.js` is still present** inside `hmis-prod-api-1` (`-rw-r--r-- root root 4360
  Aug 24 18:08`), as the report predicted. It is inert and lives outside every volume; a deploy
  replaces the container. Re-checked after this phase's deploy — see CLOSE.

### 2.1 PREFLIGHT — the report's §5 SOAK list, run against `hmis-prod-db-1`

Read-only SELECTs, 2026-08-24 18:41–18:47 UTC (2026-08-25 00:11–00:17 IST), by this session.
**This is the only place these results are stated; CLOSE points here.**

| # | Soak item | MEASURED | Verdict |
|---|---|---|---|
| 1 | `runDailyClose` must now succeed | `last_started_at 2026-08-24 18:29:26.76+00` · `last_ok_at 2026-08-24 18:29:26.783+00` · `last_error NULL` · 22 ms | **PASS — D2's repair TOOK.** Its first successful run ever |
| 2 | a `daily_closes` row for 2026-08-24 | **1 row**, `day 2026-08-24`, totals `invoices 5 / ₹1,500 net` · `receipts 5 / ₹1,700 (cash ₹1,400 + upi ₹300)` · `creditNotes 1 / ₹300` · `vouchersPaid 1 / ₹300` · `degraded 0` | **PASS** — matches the report's prediction exactly |
| 3 | the 20 queued notifications must send, not expire | `queued 20` (all `next_attempt_at 2026-08-25 02:30:00+00` = 08:00 IST, quiet-hours resume) · `sent 2` (both 2026-08-23, pre-existing) · `expired 2` | **PASS on the mechanism, OPEN on the outcome** — see below |
| 4 | `sweepAppointmentNoShows` vs the live 2026-08-25 appointments | job ran 18:25:26 UTC, no error; the two `booked` rows are `slot_start 04:00` and `05:00 UTC` on 2026-08-25 — **in the future** | **NOT YET DUE** — unverifiable before ~10:45 IST on the 25th |
| 5 | `createEventPartitions` (00:15 IST) and `retentionSweep` (01:15 IST) fire tonight | both last ran 2026-08-23; four monthly partitions exist (`events_2026_08` … `events_2026_11`); `events` at 187 | **NOT YET DUE at first read** — re-read at CLOSE |
| 6 | `event_dead_letters` must stay 0 | **0** | **PASS** |

**Soak 3 needed a second query and it changed the reading.** The report's failure condition was
*"if they age to `expired` instead, the pump has a real defect that quiet hours is currently
hiding"* — and two rows ARE `expired`. They are not the pump aging anything out. Both are
`appointment_confirmed`, both have `expires_at` in the FUTURE (`2026-08-25 04:00` / `04:15 UTC`),
and both were flipped at `17:58:50`, which is the same instant one appointment was rescheduled and
another cancelled. That is `expireByRef` — the consumer's deliberate supersession of a
confirmation for an appointment that no longer exists (`enqueue.ts:140`, asserted in
`enqueue.test.ts:264` and `consumer.test.ts:364`). **Correct behaviour, not the defect the soak
item was watching for.** The 20 `patient_welcome`/`appointment_confirmed` rows still queued expire
between 2026-08-25 04:00 and 17:54 UTC, all AFTER the 02:30 UTC resume, so the window is real.

**No finding, and therefore no task, arises from the soak list.** D2's repair is confirmed by
measurement, which is what soak item 1 existed to decide.

## 3. Spike — questions written before, answers measured in place (v3 §1.2)

**Q1 — Does converting the nav to `<Link>` fix D1?** **NO, and it cannot.** It fixes exactly one
of the four ways a person reaches a screen. A bookmark, a typed URL, a hard refresh (F5 on
`/billing` while a cashier is mid-shift), a link pasted into WhatsApp, and the waiting-room display
board left on `/opd/display` overnight are all browser GETs against Caddy, and Caddy's `@api`
matcher is path-only — no method, no `Accept`. **Measured:** 15 of 20 routes fall inside a proxied
prefix, so 15 stay dark under a `<Link>`-only fix. It is a UX improvement wearing a fix's clothes.

**Q2 — Can every seed go into `deploy.sh` unchanged?** **NO — four can, one cannot.**
`seed-tariff.ts` writes `gst_settings` and five `gst_config` rows through `upsertGstSettings` /
`upsertGstCategory`, both `onConflictDoUpdate`. Its own header calls that idempotent, and it is —
*idempotent by value*, which is a different property from *non-destructive*. In the re-deploy path
it would silently restore DEV PLACEHOLDER GST rates over whatever the CA had corrected, on every
deploy, for ever. The other four are `onConflictDoNothing` or explicitly skip-if-present.

**Q3 — Is `validate:config` the right deploy gate?** **NO, and this is load-bearing.**
`runConfigValidation` is the **go-live** gate: `kernel/ops/validate.ts:100` adds
`ops.ca_signature_missing` whenever `gst_settings.ca_signed` is false, and `validateTariffConfig`
requires an ACTIVE tariff version (`context.ts:95-98`). Both are false in production today and
both are runbook O6's to make true. Wiring that verdict to `deploy.sh`'s exit status would make
**every deploy fail until the CA signs** — which is not a gate, it is a broken deploy. The deploy
gate must ask a strictly narrower question: *are the configuration rows the modules THROW without
actually present?*

**Q4 — Where must the `/api` prefix be applied so nothing else moves?** **At the edge, stripped —
never as a Nest global prefix.** `app.setGlobalPrefix("api")` would move the API's own path space,
which the container healthcheck, the Prometheus scrape, `apps/core`'s ~30 supertest e2e suites and
every `@Controller()` route string are all written against. Caddy's `uri strip_prefix /api` and
vite's `rewrite` move the *origin* path space and leave the API's own untouched. **Blast radius
measured:** SPA client + WS URL + dev proxy + Caddyfile + parity test + the route-key strings in
22 web test files (362 `"METHOD /path"` handler keys, and 148 `callsTo(…)` call sites of which 137 carry a
literal path — the count corrected at close, see F4).

**Q5 — Is per-account or per-IP throttling correct here?** **Per-account, and per SUBMITTED
username rather than per existing user.** Per-IP is wrong twice over: every request arrives from
the Caddy container, so an IP throttle without a trusted `X-Forwarded-For` throttles the proxy;
and a hospital desk NATs a whole ward, so it would punish the ward for one fumbled password.
Keying on the *submitted* string — existing or not — is what stops the refusal being a username
oracle, and it blunts spraying against invented usernames at the same time.

**Q6 — What does a failed PIN switch cost an attacker today?** **Nothing.** `switchWithPin` takes
a four-digit PIN — a 10,000-value keyspace — and records nothing on failure. The report's D4
measured `/auth/login` only; the PIN path is the weaker of the two by three orders of magnitude
and is covered by the same mechanism at no extra cost.

## 4. Design decisions

### DD1 — D1 is fixed by PATH-SPACE SEPARATION: the API moves under `/api/*` (RULED)

**The ruling.** The browser origin gets one unambiguous rule: **`/api/*` is the API and
everything else is the application.** Four files move together and they are one commit —
`apps/web/src/lib/api.ts` (the client's base path), `apps/web/src/lib/realtime.ts` (the WebSocket
URL), `apps/web/vite.config.ts` (the dev proxy, with a rewrite), `docker/prod/Caddyfile` (one
matcher, `uri strip_prefix /api`) — plus `apps/core/test/caddyfile-parity.test.ts`, which is what
stops them drifting apart again.

**Why, in one sentence:** it is the only candidate under which a *browser GET of a screen URL* and
an *API call* are distinguishable by the one thing Caddy is actually matching on.

**THE LOSER, recorded with reasons — converting the nav to TanStack `<Link>`.** It was the
report's own first suggestion and it is genuinely cheaper: sixteen lines, no test churn, no deploy
risk beyond a rebuild. It is ruled DEAD **as the fix** on three grounds, in descending order:

1. **It fixes clicks and nothing else (Q1).** Deep links, bookmarks, hard refresh, a typed URL and
   the display board's overnight reload all remain dark — 15 routes, measured. A hospital screen
   that works when you click to it and 404s when you refresh it is a worse failure than one that
   never works, because it is intermittent and every user will believe they did something wrong.
2. **It leaves the ambiguity in place for ever.** `/admin/users` would still mean two things, and
   every future API route would have to be checked by hand against every future screen route. The
   test this phase is required to ship would have to encode an ever-growing exception list instead
   of one rule.
3. **It cannot be tested at the layer the defect lives on.** The collision is between the SPA's
   route table and Caddy's matcher; `<Link>` changes neither.

*It is not, however, worthless — and it is not being smuggled in either.* With the split in place
a raw anchor is **correct**, merely slow: a full bundle reload on every nav click, all day, on a
desk machine. **The nav conversion ships inside T-D1 as the UX half, explicitly not as the fix**,
and the test that guards the fix does not depend on it — remove every `<Link>` and the test still
passes, remove the split and it fails. That separation is deliberate so the two can never be
confused later.

**A third candidate, considered and dead in one line:** discriminating at the edge on
`Accept: text/html` / `Sec-Fetch-Dest: document`. Dead because its failure mode is a POST that
receives `index.html` with HTTP 200 — silently, exactly the failure
`caddyfile-parity.test.ts`'s docstring was written to prevent, and now depending on a header
rather than a path.

**A fourth, weighed and dead:** mounting the SPA under `/app/*` instead. Same separation, opposite
direction, and it costs the SPA client nothing. Dead on UX, which is the owner's stated first
priority: every human-facing URL grows a dead segment (`hmis.crkmch.com/app/billing`), every
printed QR, bookmark and pasted link carries it, and the API — which no human ever types — keeps
the clean namespace. The prefix belongs on the machine surface.

**The required test, and it is not optional** (report §9.1, second clause). One new leg in
`caddyfile-parity.test.ts` reads the SPA's OWN route table out of `router.tsx` and asserts that
**no declared route falls inside any Caddy-proxied prefix**. It is fail-first by construction: on
today's tree it names 15 shadowed routes and fails; after the split it passes. Under §2.49 it
carries a pinned non-vacuous census (20 routes) and a parser that THROWS rather than returning
empty — a parser that finds no routes agrees with every matcher ever written.

### DD2 — D2 is fixed BOTH ways, because they are different instruments (RULED)

The report's framing is *"a deploy must establish its own configuration or refuse to claim
health."* The disjunction is the wrong shape: the two halves catch different failures and the
phase takes both.

**Half one — the deploy ESTABLISHES.** `deploy.sh` gains one unnumbered seeding step beside the
existing cursor-seeding one (the shape that step already set), running five seeds from inside the
image after migrations: `seed:roles`, `seed:ops`, `seed:opd`, `seed:billing`, `seed:tariff`. Every
one is a `compose run --rm api node dist/scripts/…` under `set -euo pipefail`, so **a seed that
fails is a deploy that fails**, loudly, at the step that names it.

**`seed-tariff.ts` is brought to the house convention first, and that is part of this task, not a
side effect** (Q2). Its two config writes become skip-if-present with the `seed-billing.ts` /
`seed-opd.ts` report line — *"exists — left untouched"* — because **a deploy must never be able to
overwrite a corrected money or tax value.** The module functions `upsertGstSettings` and
`upsertGstCategory` keep their upsert semantics exactly: they are what `PUT /billing/config` and
the tariff routes use to *deliberately* change a value, and narrowing them would break the repair
path. The change is in the SCRIPT, where the intent is "seed", not in the module, where the intent
is "set".

**Half two — the deploy REFUSES.** A new `apps/core/scripts/check-config-present.ts` runs as its
own numbered `deploy.sh` step and exits non-zero when a row the modules throw without is absent.
It asks the narrow question Q3 isolated, and it asks it **through the modules' own loaders**
(`loadBillingConfig`, `getGstSettings`, `listGstCategories`, `getApprovalType`) rather than
through its own SELECTs — the M1 lesson recorded in `validate.ts:20`: *a gate that builds its own
view of the config eventually validates something the engine will never see.*

It checks exactly five things, and the list is deliberately short:
`billing_config` id `main` loads · `gst_settings` id `main` exists · at least one `gst_config` row
exists · the five `billing_*` approval types are registered · `tariff_revision` is registered.
**It does NOT check CA sign-off and does NOT require an active tariff version** — those are
`validate:config`'s, they are runbook O6's to satisfy, and a deploy gate that demanded them would
refuse every deploy between now and the CA's signature (Q3).

**D7 gap 2 is closed in the same task.** `registerTariffApprovalTypes` lands beside the shipped
`registerBillingApprovalTypes` (`modules/billing/approval-types.ts`), same two-step
draft→activate→register flow, same skip-if-registered idempotency, registering
`tariff_revision` / *"Tariff Revision"* / approver `owner` / routine / `actFirstAllowed: false` /
1440-minute SLA — the spec four shipped test fixtures already use verbatim
(`test/helpers/billing.ts:76-89`). `seed-tariff.ts` calls it. **This is why the smoke test had to
register an approval type by hand in production to activate a tariff at all**, and after this task
nothing has to.

### DD3 — D3 is fixed by mapping the CONSTRAINT, never the error class (RULED)

`POST /billing/invoices` with an unknown `patientId` returns 500 because the FK violation escapes
`toHttp`'s ladder. The fix mirrors the precedent the report named — `users-admin.controller.ts:349`
maps `23505` onto a coded 409 — with one deliberate strengthening: **the mapping keys on the
constraint NAME, not on the SQLSTATE.** `invoices` can violate more than one foreign key, and a
blanket `23503 → patient_not_found` would answer a *different* missing row with a confidently
wrong sentence, which is worse than a 500 because it sends the cashier looking for the wrong
thing. `invoices_patient_id_patients_id_fk` → 404 `patient_not_found`; every other 23503 keeps
falling through to a loud 500, which is correct: it is a genuine bug.

**Considered and not taken: a pre-INSERT existence check in `issueInvoice`.** It reads better and
it is what a reviewer expects, and it is wrong here — it adds a SELECT to the hot path of every
invoice to answer a question the database already answers for free, and it leaves the raw FK
reachable anyway under a concurrent delete. The constraint is the authority; the mapping should
read it.

### DD4 — D4 is fixed by per-account self-healing BACKOFF, persisted, never a lockout (RULED)

**The mechanism.** One new table (migration `0019`), keyed by `(kind, subject)` where `kind` is
`login` or `pin` and `subject` is the **submitted username, normalised** (Q5). Consecutive
failures inside a rolling one-hour window are counted; from the 5th failure the credential path
refuses with **429 and `Retry-After`** for a window that doubles from 60 s to a 15-minute cap; any
success clears the row. Nothing about verification changes: the correct credential is still
verified by the shipped code, and **no guard is weakened anywhere** (rule 14).

**Backoff, NOT lockout, and the reason is clinical.** A lockout that only an administrator can
clear is a hazard in a hospital that has exactly ONE full administrator (runbook O1, still open) —
it creates a state whose only repair is a person who may be asleep, which is the same failure
shape 11e existed to end. Every refusal this ships expires by itself, and the longest anyone can
be held out is 15 minutes.

**The accepted cost, stated rather than discovered.** Keying on the submitted username makes a
deliberate denial-of-service possible: an attacker who knows a clinician's username can hold that
username in backoff by failing on purpose. That is the classic account-lockout trade, it is
accepted here, and the 15-minute cap is what bounds it — combined with the PIN-switch path
(a different `kind`, throttled separately, so a poisoned `login` row does not close the terminal
switch) and break-glass, which is untouched. The alternative — no throttle at all — leaves a
hospital on the public internet with a 10-character password floor and a **four-digit PIN** and no
brute-force resistance whatsoever (Q6), which is not a trade, it is the status quo the report
filed as MAJOR.

**Rate arithmetic, so the numbers are a decision and not a taste.** Five attempts per 15 minutes
is 480/day. Against `switchWithPin`'s 10,000-value keyspace that is ~21 days for full coverage,
against ~1 second unthrottled today; and every one of those failures leaves a row an operator can
read. Against a password meeting the shipped 10-character policy it is not a threat model at all.

**`@nestjs/throttler` — considered, dead.** It is IP-keyed by default, which Q5 rules wrong here;
making it account-keyed means writing the key extractor and the store anyway; its in-memory
default store loses state on restart and does not survive a second api replica; and it is a new
production dependency with a lockfile change for machinery this needs one table's worth of.

**Deliberately NOT in this task, and named so it is a decision:** no event is appended on
throttle. The auth catalog is closed by module-catalog discipline and adding a name to it is a
ratification, not a line of code. The table itself is the audit surface for now; the alerting seam
is recorded in §6.

### DD5 — D6's screen half is taken; its permission half is not (RULED)

`registration-desk.tsx:229` offers a `isConfidential` checkbox. Ticking it produces a clean 201
and a record that **no user in production can search, open, bill or treat**, because
`patients.confidential.read` is granted to no role and `search.ts:45-48` / `getPatient` both
filter on it. The record is not recoverable through any screen.

**The checkbox is removed from both screens that offer it** — registration and the patient-detail
edit form — behind a single named constant with the owner's pending ruling written beside it, so
restoring it is one line. The submitted value is preserved on the edit path (an edit must not
silently un-confidential a record), and `false` is sent on registration, which is what the schema
already defaults to.

**The API is NOT guarded, and that is the ruling, not an omission.** A refusal at
`registerPatient` would be a new guard on a data path the owner has not ruled on, it would break
any future import or merge that legitimately carries the flag, and rule 14's spirit cuts both
ways: guards are not casually added to a clinical write path to compensate for a missing grant.
What is being fixed is a **desk affordance that orphans a patient record with one click**. When
the owner rules who may read a confidential record, the checkbox comes back and the constant goes.

---

## 5. Tasks

Sequential, main session, LIGHT lane (v3 §3): narrow suites while iterating, detached runs with
the exit VALUE read from a file, **`pnpm verify` before every push** (§2.87 — the rule 11f's own
T4 poller now watches), CI green by FULL SHA via `pipelines/ci-watch-host.sh` before close.

---

### T-D1 — CRITICAL — the API moves under `/api/*`, and a test pins the two path spaces apart

**Files:** `apps/web/src/lib/api.ts` · `apps/web/src/lib/realtime.ts` ·
`apps/web/src/lib/realtime.test.ts` · `apps/web/src/lib/api.test.ts` · `apps/web/vite.config.ts` ·
`docker/prod/Caddyfile` · `apps/core/test/caddyfile-parity.test.ts` · `apps/web/src/router.tsx`
(the nav's 16 anchors → `<Link>`, DD1's UX half) · the route-key strings in the 22 `apps/web`
test files that stub `fetch` · **`docker/prod/deploy.sh` and `README.md` — the two OTHER consumers
of the origin's path space** (F1: the deploy's own edge gate and the 03:00 runbook both `curl`
`https://<site>/health`, which after the split is answered by the SPA with HTTP 200).

**Acceptance:** DD1 delivered. The SPA requests every API path under `/api`; the WebSocket
connects to `/api/ws`; Caddy proxies `/api*` and strips the prefix; the dev proxy rewrites
identically. **The new parity leg FAILS on the pre-fix tree naming the shadowed routes and passes
after** — quoted in CLOSE, fail-first per §2.4. The existing leg *"every prefix the SPA actually
CALLS is proxied"* is re-expressed against the new shape rather than deleted. **No consumer of the
origin's path space is left checking a path that no longer exists** — `deploy.sh`'s edge gate
moves to `/api/health`, gains a body check so an HTML answer can never read as healthy again, and
gains a second leg asserting a SCREEN path serves the SPA document; the README's 03:00 runbook
line moves with it. `pnpm verify` green.

**Book rows:**
- **R1** · a SPA route that falls inside a Caddy-proxied prefix fails the parity leg · mutant:
  the Caddyfile's `@api` matcher restored to the twelve pre-fix prefixes (a separate
  `Caddyfile.mutant` read by a scratch spec — never the shipped file) · discriminating input: the
  shipped 20-route table. Shipped → 0 shadowed, passes; mutant → 15 shadowed, fails **naming
  them**. Control: a matcher of `/api*` alone passes, so the row cannot pass by refusing
  everything.
- **R2** · the route-table parser cannot pass vacuously · discriminating input: a `router.tsx`
  with no `path:` properties — the parser THROWS *"this parser is stale"* rather than returning
  `[]`. Asserted by the leg's own pinned census (20) before any comparison, the §2.49 shape.

**Commit:** `fix(web,docker,core): the API moves under /api/* — 20 screens reachable in a browser, and a test that pins the two path spaces apart (smoke-test D1)`

---

### T-D2 — CRITICAL — a deploy establishes its own configuration, and refuses to claim health without it

**Files:** `docker/prod/deploy.sh` · `apps/core/scripts/seed-tariff.ts` ·
`apps/core/scripts/check-config-present.ts` (new) · `apps/core/package.json` (the
`check:config-present` script) · `apps/core/src/modules/tariff/approval-types.ts` (new) ·
`apps/core/src/modules/tariff/index.ts` (its export) · `apps/core/test/seed-tariff.test.ts` (new) ·
`apps/core/test/check-config-present.test.ts` (new).

**Acceptance:** DD2 delivered. `deploy.sh` runs the five seeds after migrations and a failing seed
fails the deploy; `seed:tariff` re-run over existing config leaves every value untouched and says
so; `tariff_revision` is registered by a seed; the gate script exits non-zero on a database
missing any of its five rows and zero on a seeded one, **without** requiring CA sign-off or an
active tariff version. `pnpm verify` green.

**Book rows:**
- **R1** · `seed:tariff` re-run over a CORRECTED `gst_config` row does not overwrite it · mutant:
  the shipped `upsertGstCategory` call restored (today's code, in a scratch copy of the script) ·
  discriminating input: seed → change `consultation.rateBps` to 500 → seed again. Shipped leaves
  500; mutant restores 1800. Control: a first seed on an empty database still writes all five
  rows, so the row cannot pass by writing nothing.
- **R2** · the gate refuses a database missing `billing_config` and admits a seeded one ·
  mutant: the `billing_config` leg removed · discriminating input: an empty database (shipped
  exits 1 naming the row; mutant exits 0) and a seeded one (both exit 0).

**Commit:** `fix(core,docker): the deploy seeds its own configuration and refuses to claim health without it — plus the tariff_revision approval type nothing registered (smoke-test D2, D7 gap 2)`

---

### T-D3 — ROUTINE — the FK violation on `POST /billing/invoices` becomes a coded 404

**Files:** `apps/core/src/modules/billing/billing.controller.ts` ·
`apps/core/test/billing.e2e.test.ts`.

**Acceptance:** DD3 delivered. An unknown `patientId` returns **404** with
`code: "patient_not_found"`; the mapping keys on `invoices_patient_id_patients_id_fk` and every
other `23503` still reaches a 500. ROUTINE tier: tests required and must pass, **mutants not
required** (AGENT-RULES §3) — but fail-first IS owed and cheap here, because the pre-fix tree
returns 500 to the same request. Quoted in CLOSE.

**Commit:** `fix(core): an unknown patientId on POST /billing/invoices is a coded 404, not a 500 (smoke-test D3)`

---

### T-D4 — CRITICAL — the auth path gets per-account backoff

**Files:** `apps/core/drizzle/0019_mysterious_shadowcat.sql` + `apps/core/drizzle/meta/*`
(generated) ·
`apps/core/src/kernel/db/schema/auth.ts` · `apps/core/src/kernel/auth/throttle.ts` (new) ·
`apps/core/src/kernel/auth/throttle.test.ts` (new) · `apps/core/src/kernel/auth/auth.controller.ts` ·
`apps/core/test/helpers/db.ts` (the truncate group) · `apps/core/test/auth.e2e.test.ts`.

**Acceptance:** DD4 delivered for `POST /auth/login` and `POST /auth/switch/pin`. Five consecutive
failures on one submitted username produce a **429 with `Retry-After`**; a success before the
threshold clears the counter; the window is rolling and self-healing; an unknown username is
throttled identically to a known one (no oracle); the two kinds do not share a counter. **No guard
is weakened and no verification path is changed** (rule 14). Migration `0019` is carried to the
commit that needs it (AGENT-RULES §6).

**Book rows:**
- **R1** · the threshold refuses the 6th attempt and NOT the 5th · mutant: the throttle check
  removed from the login handler · discriminating input: six wrong passwords in one window —
  shipped returns 401×5 then **429**; mutant returns 401×6. Control: the CORRECT password on
  attempt 3 succeeds under both, so the row cannot pass by refusing everything.
- **R2** · a success CLEARS the counter · mutant: the clear-on-success call removed ·
  discriminating input: 4 failures → 1 success → 4 failures → 1 success. Shipped: both successes
  return 200. Mutant: the second success is refused 429 by a counter that never reset.
- **R3** · `login` and `pin` do not share a counter · discriminating input: 5 failed logins for
  `asha`, then a CORRECT PIN switch for `asha` — shipped succeeds; a single-key implementation
  refuses. No separate mutant build: the wrong implementation is the row's named key shape,
  asserted by the test's own leg.
- **R4** · an UNKNOWN username is throttled identically · discriminating input: 6 failures against
  `nobody-here` — shipped returns 429 on the 6th, so the response shape cannot be used to
  enumerate. A per-user-row implementation returns 401 forever.

**Commit:** `feat(core): per-account self-healing backoff on the password and PIN credential paths (smoke-test D4)`

---

### T-D6 — ROUTINE — the registration desk stops offering a checkbox that orphans a patient

**Files:** `apps/web/src/lib/confidential-capture.ts` (new — the named constant DD5 requires;
omitted from this list at write time, F5) · `apps/web/src/screens/registration-desk.tsx` ·
`apps/web/src/screens/registration-desk.test.tsx` · `apps/web/src/screens/patient-detail.tsx` ·
`apps/web/src/screens/patient-detail.test.tsx`.

**Acceptance:** DD5 delivered. Neither screen renders the confidential checkbox; the registration
body still carries the field's default and the edit body still carries the record's CURRENT value
(an edit must not silently un-confidential a patient); one named constant carries the owner's
pending ruling and restoring the control is one line. ROUTINE: tests required, mutants not
required, fail-first not owed — **stated, not inferred.** No server change of any kind.

**Commit:** `fix(web): the confidential checkbox leaves the desk until a role can read what it creates (smoke-test D6, screen half)`

---

## 6. Routed to the owner — NOT this phase's, named so they are not lost

- **D5 — what makes two registrations the same person.** Name + phone? Name + phone + age band?
  A soft warning at the desk or a hard refusal? Until that is ruled nothing can be written, and
  the repair path is closed anyway: `patients.merge` is granted to **no role**, so a duplicate can
  be created by anyone and merged by no one. **The grant is the cheaper half and it is an owner
  ruling, not code.**
- **D6 permission half — who may read a confidential record.** `seed-roles.ts:270` has been
  waiting for this ruling since Plan 11d. T-D6 removes the trap; the ruling reopens the feature.
- **D7 gap 1 — who maintains the tariff.** All five `tariff.*` permissions sit in
  `NOT_YET_MODELLED`. **This blocks runbook O6 outright** — "real tariffs loaded before the first
  live invoice" has no path through any screen until a role holds them.
- **O1 / O2 — the second full administrator, and the burned 15-account roster's rotation.**
  Unchanged, owner-only, and still the standing operational hazard: production has ONE full
  administrator and its only repair is direct database access.
- **O4 — `gh run view 32668118868 --log-failed`**, still one line, still needs a credential this
  host does not have.
- **O6 — the real money and tax values.** Production currently holds DEV PLACEHOLDERS that this
  session did not touch: cash warn ₹1,50,000, cash block ₹2,00,000, PAN threshold ₹50,000, and
  five GST category rows. `ca_signed` is false in both `billing_config` and `gst_settings`.
- **Follow-up seams this phase deliberately left open:** no event is appended when a credential
  path is throttled (DD4), so brute force is visible in a table rather than in the alert stream;
  and D8/D9 are recorded in §1 with their reasons rather than fixed.

---

## 7. CLOSE — appended as the phase runs (v3 §1.5)

**Executed 2026-08-24/25 in one session, on the build host, LIGHT lane. Five tasks, EIGHT commits
(the seven tabled below plus this CLOSE), one owner-authorised production deploy.** Every task's `pnpm verify` was exit 0 before its push
(§2.87) and every commit is CI-GREEN BY FULL SHA, read from `pipelines/ci-watch-host.sh`'s exit
VALUE, never a pipeline's status.

| task | commit | tier | CI (run id) |
|---|---|---|---|
| — the phase document | `aa4baec` | — | (no run of its own — pushed with `f67c9fc`, whose run judged both) |
| T-D1 — the API moves under `/api/*` | `f67c9fc` | CRITICAL | **GREEN** 32766436144 |
| T-D2 — the deploy seeds and refuses | `9b680f0` | CRITICAL | **GREEN** 32767698599 |
| T-D3 — the FK becomes a coded 404 | `dbd46d3` | ROUTINE | **GREEN** 32768222971 |
| T-D4 — the credential paths get backoff | `c5cc224` | CRITICAL | **GREEN** 32769341226 |
| T-D6 — the confidential checkbox leaves the desk | `7893a83` | ROUTINE | **GREEN** 32770137370 |
| close review remediation — three MAJORs and five minors | `314f3d4` | — | **GREEN** 32773079683 |

*`e9ffe6a..HEAD` is EIGHT commits, not six: `894eebf` and `6620864` are the owner's own docs
commits, landed from another session while this one ran and carried in by `git pull --rebase`.
Verified docs-only by `git show --numstat`; neither is this phase's and neither is claimed as
such (rule 8).*

**Counts.** `apps/core` 152 suites / 1175 tests → **155 suites / 1209 tests**; `apps/web` 36 files
/ 193 tests → **36 files / 196 tests**; `packages/contracts` **3 / 7**, unchanged. The workspace total never decreased and no diff in this
phase deletes a test. One migration: **`0019_mysterious_shadowcat.sql`**, carried to the commit
that needed it.

### Findings — this session's own, in the order they were found

- **F1 — MEASURED, and it is the 11f-F1 class again: T-D1's Files list could not carry T-D1's
  acceptance.** The task changes where the API lives ON THE ORIGIN, and TWO things outside
  `apps/` consume that origin: `deploy.sh`'s step-8 gate and the README's 03:00 runbook line, both
  of which `curl https://<site>/health`. After the split that path is answered by the SPA handler
  with **HTTP 200 and an HTML body**, which `curl -fsS` reports as success — so the deploy's own
  health gate would have passed over a dead API, which is the exact defect class this phase
  exists to close, introduced BY this phase. Found while executing, before the document was
  committed, so the Files list as published is correct; recorded because the omission was real.
  **The lesson: a task that moves a PATH SPACE must name every consumer of that space, and the
  consumers are rarely all in the same package.** The gate was not merely re-pointed — it now
  checks the BODY (a 200 carrying a document is a `die`) and gained a second leg asserting a
  SCREEN path serves the SPA, so the deploy itself is now the D1 regression test. **Ledger §3.58.**
- **F2 — MEASURED. The document said the phase would generate migration `0020`; the tree
  generated `0019`.** Nineteen migrations were APPLIED (`0000`–`0018`), which is why the next tag
  is `0019` — the document read its own correct "19 applied" as "next is 0020". Corrected at close
  in all four places the close reviewer found it (§2, DD4, T-D4's Files list, T-D4's acceptance),
  which is one place more than I had found myself. §2.90's rule, on this document.
- **F3 — DISCLOSED, AND IT IS MINE. `git add -A`, twice.** The first time it swept T-D1's 31 code
  files into a commit whose message was the phase document's; caught before any push, corrected by
  `git reset --soft` on a commit `origin/main` had never seen, and re-split into `aa4baec` +
  `f67c9fc`. **The second time it swept a 457-line file that is not mine** —
  `docs/superpowers/plans/2026-08-25-phase1-11h-global-search-command-palette.md`, the owner's
  Plan 11h draft, which appeared in the tree while `pnpm verify` ran — into `314f3d4`, and that
  one WAS pushed. It is not touched: rule 15 forbids rewriting pushed history, and the file is not
  mine to delete (rule 2's boundary, rule 8's caution). It is intact in git under a commit message
  that does not mention it, and this paragraph is the record. **AGENT-RULES §5 step 0 already says
  "never run `git add -A` over a status you have not read" — and I read the status BOTH times.
  That is what makes this a new lesson rather than a rule I ignored:** reading a status tells you
  what is there NOW; `-A` stages what is there AT COMMIT TIME, and on a host the owner also works
  on (rule 8) those are different sets. **Ledger §2.92.**
- **F4 — MEASURED, mine, disclosed. AGENT-RULES rule 3 violated once.** The first run of the D1
  reproduction matrix used `curl -o /tmp/x` to discard response bodies. Rule 3 forbids any write
  to `/tmp`, for any reason. Deleted with `rm -f`, and the matrix re-run with `-o /dev/null`
  before anything was recorded — same result, 5 SPA / 15 API. Every other scratch this phase
  produced lived under `/opt/hmis` and is removed. *(The smoke-test session made the identical
  slip four hours earlier and recorded it in its own §10; that a second session repeated it inside
  one day is the finding, not the individual lapse.)*
- **F5 — MEASURED, caught by `pnpm verify` and not by the narrow run.** Three `await import(…)`
  calls in the new T-D2 tests passed jest (ts-jest transpiles) and FAILED `tsc --noEmit` under
  `moduleResolution: node16` with TS2834/TS2835. Hoisted to static imports. This is §2.87's rule
  earning its keep for the second phase running: the narrow suite is not the evidence, `pnpm
  verify` is.

### The independent close reviewer (v3 §3.4) — findings and their fates

One fresh-context reviewer over all six commits read together, ~1.2M ms, 107 tool calls. **No
CRITICAL. Three MAJOR, nine MINOR.** Every one of the three MAJORs is a defect I could not have
found by writing another test to my own understanding, which is the claim v3 §3.4 makes about this
instrument — discharged with specimens for the second phase running.

| # | finding | fate |
|---|---|---|
| **MAJOR 1** | **The new seed step could hard-abort `deploy.sh`, on exactly the case DD2 built the gate for.** `seed-roles`'s census checks a reachability invariant that includes the three `ops.*` grants `seed-ops` writes — so running `seed-roles` FIRST reports NOT READY on a fresh box, and 11d deliberately made that verdict `process.exitCode = 1`, which under `set -euo pipefail` kills the deploy AFTER migrations and BEFORE the containers are recreated. `seed-roles.test.ts:545,578` already asserted `ready === false` in that exact state; nothing connected that fact to the script | **FIXED** in `314f3d4`. `seed-ops` runs first; `seed-roles`'s VERDICT is decoupled from the deploy's exit status (its grants land either way, and the verdict stays loud in the transcript); `check-config-present` remains the hard gate; `seed:admin`'s exclusion is now written down. **Five new legs in `deploy-parity.test.ts` pin the order, the five seeds' presence on disk, the gate's position, and the wrapping** — static, because the failure is an ORDERING between programs a jest run cannot execute, which is the gap it fell through |
| **MAJOR 2** | **The throttle key was unbounded and the table was never reaped.** `loginSchema` puts no ceiling on `username` and the body limit is 1 MB; `subject` is half a composite PRIMARY KEY and Postgres refuses a btree tuple over ~2704 bytes — so **an anonymous `POST /auth/login` with a long enough username turned a clean 401 into a 500**. Below that, every failure against a NEW string wrote a permanent row and only a SUCCESSFUL authentication for that exact subject ever removed one | **FIXED** in `314f3d4`. `throttleSubject` truncates at 64 — one place, both credential paths, and nothing changes about what login ACCEPTS; `recordThrottleFailure` prunes rows whose window has passed, keyed on `last_failed_at` so a steadily-failing subject is never forgotten. Two regression legs, including that live rows survive the prune |
| **MAJOR 3** | **Every open browser tab breaks across the `/api/*` cut, opaquely.** A stale bundle requests the bare paths, gets `index.html` where it expects JSON, and `lib/api.ts`'s `JSON.parse` throws a bare `SyntaxError` no screen recognises. No data risk — the API never sees those requests — but a cashier mid-shift or the display board left on `/opd/display` overnight fails unexplained | **FIXED** in `314f3d4`. `deploy.sh` prints the hard-reload reminder as its last line and the README carries it. Verified in the live deploy transcript below |
| MINOR ×9 | the T-D3 test could not tell DD3's mapping from the blanket one DD3 rejects · DD3's justification was factually wrong about the schema (`invoices` has exactly ONE foreign key) · the migration number was wrong in **four** places, not the one I had found · "27 files" → 32 · Q4's `callsTo` count → 148 sites / 137 literal · T-D6's Files list omitted `confidential-capture.ts` · `docker-compose.prod.yml:162`'s stale "/health through Caddy" · `gst-config.ts:45`/`:96` transposed · no test drove the five seeds in `deploy.sh`'s order | **ALL TAKEN.** The first is the most valuable: `isInvoicePatientFkViolation` is now exported and pinned directly, because the e2e passed against the blanket `23503` mapping DD3 argues against. The last is MAJOR 1's root and is what the new parity legs close |

**What the reviewer checked and found clean, recorded so the close states COVERAGE and not only
defects:** `pnpm verify` at HEAD re-run independently (exit 0); the ~591 mechanical test-line edits
in `f67c9fc` proved mechanical by matching every `-` line against the multiset of `+` lines with
`/api` removed — **exactly one had no counterpart, the `API_BASE` import, so no test was deleted
and no assertion altered beyond the prefix**; every negative/absence assertion in those 22 files
enumerated individually and none turned vacuous; vite's dev-proxy rewrite confirmed to apply to
the WebSocket upgrade, byte-identical to Caddy's `strip_prefix`; no service worker; the QR payload
is not a URL; Prometheus scrapes containers directly; all five `dist/scripts/*.js` will exist;
`compose run --rm` propagates its exit code; every seed's non-destructiveness read rather than
trusted; the badge path correctly left unthrottled (an HMAC, not a guessable keyspace); no
inescapable lockout state; the lock not held across argon2; the unknown-username sequence
byte-identical to the known one; and nothing in the SPA sends `isConfidential: true` any more.

### The deploy — owner-authorised in conversation, 2026-08-25

`bash docker/prod/deploy.sh`, detached, **exit value 0** read from a file. Both new steps ran and
passed on the first live execution: *"seed:roles complete and READY"* and *"every configuration
row the modules require is present"*. The new edge gate passed **both** halves — *"api through the
edge: HTTP 200 `{"status":"ok","db":"ok","worker":"ok"}"*` and *"screen through the edge:
/admin/users serves the SPA document"* — and the hard-reload reminder printed as the last line.

**D1's reproduction matrix, the report's own §3 table, re-run across all 20 routes with a browser
`User-Agent` and `Accept: text/html`:**

| | SPA served (200 `text/html`) | screen dark (API JSON) |
|---|---|---|
| **before** (pre-11g image, measured this session) | **5** / 20 | **15** / 20 |
| **after** | **20** / 20 | **0** / 20 |

**Everything the brief required to stay put, verified after:**

- **`operating_mode_changes` is 0 rows.** Production has still never left `commissioning`.
- **The money and tax values are untouched** — `cash_warn 15000000`, `cash_block 20000000`,
  `pan_threshold 5000000`, `ca_signed false`, and all five `gst_config` rates byte-identical to
  their pre-deploy values. That is DD2's non-destructive property proven in production rather than
  asserted: five seeds ran over existing configuration and changed none of it.
- **`role_permissions` is 73**, unchanged — `seed:roles` granted nothing new because nothing was
  missing. **`approval_types` is 6** with `tariff_revision` present, correctly skipped.
- **Migrations 19 → 20 applied.** `auth_throttle` exists and holds **0 rows**.
- **`/app/syn-tariff.js` is GONE** from `hmis-prod-api-1` — the report's one left-behind artefact,
  removed by the container recreation exactly as it predicted.
- **The running images carry the fixes**, read from inside the containers rather than inferred:
  `dist/scripts/check-config-present.js` present · `auth_throttle` in the compiled schema ·
  `MAX_SUBJECT_LENGTH = 64` in the compiled throttle (so the close review's MAJOR 2 fix is what is
  live) · `isInvoicePatientFkViolation` in the compiled controller · and the served bundle under
  `/srv/assets/` contains `"/api"`.
- **The API is still guarded**: `/api/admin/users` answers **401** unauthenticated — and this
  time that is evidence about the API route only, which is the reading 11f got wrong and the
  reason the matrix above exists.

**What the deploy does NOT prove, and it is the same sentence the smoke test ended on:** twenty
routes serving `text/html` is twenty documents, not twenty working screens. **The owner clicking
through them is the acceptance test, and it is theirs.**

**PARTIALLY DISCHARGED, 2026-08-25 — the owner reports `/admin/users` and `/registration` both
render.** The two are NOT equal evidence and the difference is the whole point:

- **`/admin/users` was one of the fifteen dark screens.** It is also the exact URL the owner
  opened when this defect was found — the smoke-test report's D1 opens with
  *"the owner opened `/admin/users` and got `{"message":"Unauthorized","statusCode":401}`"*. **A
  human seeing that screen render is D1's acceptance, discharged at the surface it was found on**,
  and it is the first thing in this project's history that closes a production defect with a
  person's eyes rather than a status code.
- **`/registration` was one of the five that already served before the fix.** It is a
  NO-REGRESSION check — worth having, because the split moved every API call the screen makes,
  and worth not confusing with the line above.

**STILL UNSEEN BY A HUMAN: `/opd/desk`, `/billing`, `/ops/mode`, `/opd/display`** — four of the
fifteen that were dark, each now serving `text/html`, none yet rendered in front of somebody. And
one limit this session cannot resolve from the outside: *"renders"* is a statement about the
document. Whether the owner was AUTHENTICATED at the time — and therefore whether the screen drew
real data through the moved `/api/*` client, or drew the login screen the route's `beforeLoad`
redirects an anonymous visitor to — is not something a read-only observer can infer, and it is
not assumed here. The four remaining screens, opened while signed in, would settle both.

### The soak list

Run at PREFLIGHT and recorded once, in **§2.1** — the fact rule; this section points rather than
restates. Headline: **`runDailyClose` succeeded at 18:29:26Z with `last_error` NULL, its first
successful run ever, so D2's repair TOOK**; `daily_closes` carries its first row; `dead_letters`
stayed 0; `createEventPartitions` and `retentionSweep` both fired on schedule; and soak item 3's
stated failure condition is **not** met — the two `expired` rows are `expireByRef`'s deliberate
supersession of a cancelled and a rescheduled appointment, not the pump aging anything out.

**Three soak items remain genuinely undue and are the owner's to read tomorrow**: the 20 queued
notifications resume at 08:00 IST (02:30 UTC) and must go `sent`, not `expired`; the two live
2026-08-25 appointments must be marked no-show after their 09:30/10:30 IST slots pass; and both
are unaffected by this deploy.

### One NEW production observation, measured, not a defect

**The escalation ladder fired in production for the first time, unprompted, and behaved exactly as
designed.** Two OPD workflow instances the smoke test left in `waiting` escalated at rung 0
(19:00 UTC) and rung 1 (19:30 UTC), fanning out to the three `front_office_supervisor` holders:
**12 in-app alerts** and **12 notifications marked `undeliverable / no_phone`**. That is D-34's
designed degrade path — *"a phoneless staff member degrades to exactly the in-app alert that
already ships"* — working end to end, and the ladder has exhausted and stopped (nothing since
19:30:28). `event_dead_letters` is still 0 through those 12 extra deliveries.

**It is an owner note, not a task.** Those two instances will sit in `waiting` for ever, and two
further approval-SLA timers from the smoke test come due at 22:19 UTC tonight. The synthetic-data
manifest in the smoke report §6 is the wipe list; nothing here needs code.

### Actuals

| | |
|---|---|
| tokens, all sessions | **UNMEASURED — the owner's `/cost`.** A session cannot read its own total. This is runbook item **O3's class for the THIRD phase running** and it is now the longest-standing undischarged claim in the method |
| stop-loss | 1.5M. **Not observably crossed**, and — as in 11f — that is an assertion this session cannot discharge. Nothing in the run's shape suggested it: five tasks, one reviewer, six mutants built and run, one deploy, and rework confined to F5's three import lines and the reviewer's three MAJORs |
| agents | **1** — the independent close reviewer (254,782 subagent tokens, 107 tool calls). No subagent wrote any code |
| wall clock | ~3h15m end to end, dominated by **seven full `pnpm verify` runs**, five CI waits and the image build |
| mutants | **6 built and executed**, all DIED with expected-vs-received quoted, every control passing: T-D1 R1 (the twelve-prefix matcher restored — named all 15 dark screens) and R2 (the route parser throws rather than returning `[]`) · T-D2 R1 (the pre-11g unconditional upserts — restored a corrected 500 to 1800) and R2 (the `billing_config` leg removed) · T-D4 R1 (the throttle check deleted — **reproduced the smoke test's own measured signature**, 401×6 then 201) and R2 (the clear-on-success deleted). Plus one non-required vacuity control on T-D6's label strings |
| catches | **5 by the session** (F1–F5) · **3 MAJOR + 9 MINOR by the independent reviewer**, every one real, none CRITICAL |

**v3 §7's measurements.** Transcription-class incidents: **zero** — structurally, there is one
document. Defects reaching production from this phase: **none** — the three MAJORs were found and
fixed BEFORE the deploy, which is the entire purpose of putting the reviewer in front of the
deploy checkpoint rather than after it. Defects of a class v2's per-task apparatus has a named
prior catch for: **none** — MAJOR 1 is a cross-program ordering that no per-task gate has ever
been shaped to see, MAJOR 2 is a schema-key bound, MAJOR 3 is an operational note. The reversal
conditions recorded in v3 §7 are therefore **not** triggered; the next phase stays LIGHT-eligible.

### Ledger — the archive pass (v3 §5)

Four new entries: **§2.92, §3.58, §3.59, §3.60**.

**ARCHIVE PASS RUN, NOTHING QUALIFIES THIS CYCLE, and that is a finding rather than a skipped
step.** The obvious candidate was **§2.88** — the parity pin between two hand-maintained lists —
because this phase deleted the twelve-prefix mirror those two lists WERE. But §2.88's rule is
*"a parity pin over N hand-maintained copies needs an N+1th source DERIVED FROM USE"*, and this
phase's own new leg is another instance of exactly that rule rather than its retirement. **An
entry whose SPECIMEN's machinery is gone but whose RULE still binds is not archivable** — the
archive rule says *enabling mechanism*, and the mechanism here is hand-maintained parity, which
this repository still has three of.

### Routed to the owner

§6's list stands unchanged and unclosed: **D5**, **D6's permission half**, **D7 gap 1**,
**O1/O2**, **O4**, **O6**. Two items move:

- **D7 gap 2 is CLOSED** — `seed:tariff` registers `tariff_revision` on every deploy, and the
  README's go-live runbook step 1, which told the owner to do it by hand, is struck in place.
- **O5 — one real day through the system — is now POSSIBLE for the first time.** It was blocked by
  D1 for the whole of Plan 11f and the smoke test. Twenty screens serve. The hospital has still
  never operated on this system, and `operating_mode_changes` is still empty.
