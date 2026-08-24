# Synthetic operational smoke test — production, 2026-08-24

> **Owner-supervised, owner-authorised, REPORT-ONLY on source code.** Substitutes for runbook item
> O5 of [`2026-08-24-phase1-11f-operability-gate.md`](../2026-08-24-phase1-11f-operability-gate.md)
> §5.5 by the owner's ruling in conversation, 2026-08-24. Executed on the build host against
> `https://hmis.crkmch.com` over the application's own HTTP surface. HEAD `f81d61c`, clean tree.
>
> **No source file under `apps/`, `packages/` or `docker/` was changed. No defect found here was
> fixed.** Production DATA was written — that is what the test is — and the two configuration
> seeds and the synthetic tariff described in §2 were run under explicit owner authorisation.
>
> Every count below is MEASURED unless marked INFERRED or PREDICTION.

---

## 1. Verdict — per module

| # | Module | Scenarios | PASS | FAIL | BLOCKED | Go / no-go |
|---|---|---|---|---|---|---|
| 1 | Auth & RBAC | 30 | 29 | 1 | 0 | **GO with one fix** — every boundary holds; no throttle (D4) |
| 2 | User administration | 12 | 12 | 0 | 0 | **GO** — the strongest module in the system |
| 3 | Patient master | 34 | 31 | 3 | 0 | **NO-GO** — registrations work; duplicates and confidential records are traps (D5, D6) |
| 4 | OPD | 31 | 28 | 0 | 3 | **GO** — appointments, vitals, queue triage and the consult chain all hold |
| 5 | Billing counter | 26 | 25 | 1 | 0 | **NO-GO until D3** — arithmetic and ceilings are excellent; one 500 |
| 6 | Workflow / approvals | 9 | 9 | 0 | 0 | **GO** — matured through its real path, SoD enforced |
| 7 | Runtime loop | 6 | 6 | 0 | 0 | **GO** — dispatcher provably consuming; 0 dead letters |
| 8 | Notifications & alerts | 5 | 5 | 0 | 0 | **GO** — quiet hours honoured; nothing lost |
| 9 | Ops surfaces | 6 | 6 | 0 | 0 | **GO** — reachable by API, truthful, mode unchanged |
| 10 | Adversarial, cross-module | 27 | 26 | 1 | 0 | **GO with D3** — 26 governed refusals, one unmapped crash |
| — | **Screens (browser)** | 20 | 5 | 15 | 0 | **HARD NO-GO** — D1 |
| | **TOTAL** | **206** | **182** | **21** | **3** | |

**The one-sentence verdict.** The *engine* is in materially better shape than its zero operating
days would suggest — money arithmetic, state machines, RBAC, separation of duties and the event
loop all held under deliberate attack — but **the hospital cannot use it**, because 15 of 20
screens do not load (D1) and because production had never been given the configuration its own
modules require (D2). Neither is a bug in a module; both are gaps between "deployed" and
"operating", which is exactly what Plan 11f said this phase's thesis was.

---

## 2. What was changed in production, and under what authority

Three actions crossed the read-only line. All three were authorised by the owner in conversation
after the blocker was reported with evidence; the first two were run by the owner's own hand
because the permission classifier refused them from this session.

| # | Action | Authority | Effect (MEASURED) |
|---|---|---|---|
| 1 | `seed:billing` (deployed artifact, exit **0**) | owner, explicit | `billing_config` 0→**1**, `approval_types` 0→**5**, `services` 0→**2**, SoD pairs ensured |
| 2 | `seed:tariff` (deployed artifact, exit **0**) | owner, explicit | `gst_settings` 0→**1**, `gst_config` 0→**5**, `adjustment_rules` 0→**4** |
| 3 | `seed:admin` → `syn.smokeadmin` (exit **0**) | owner, explicit | one disposable administrator, deactivated at §6 |
| 4 | SYN tariff lifecycle (`.syn-tariff.js`, exit **0**) | owner, explicit ("Yes on SYN tariff") | `tariff_revision` approval type registered, 4 SYN services, version 1 with 6 items, **activated** |

**Everything the owner's brief placed off-limits stayed off-limits.** `operating_mode_changes` is
**0 rows** at both ends; the operating mode is `commissioning` with `since: null`; the real `admin`
account was never authenticated as, reset, deactivated or read beyond its `active` flag; no
container was stopped, restarted or removed; no migration ran (still 19); `ca_signed` and
`gst_settings.ca_signed` remain **false**.

**Two things the owner must know about action 1 and 2.** They wrote **DEV PLACEHOLDER** money and
tax values into production — cash warn ₹1,50,000, cash block ₹2,00,000, PAN threshold ₹50,000, GST
rates per category — every one marked `CA sign-off required (§19)` in its own source. They are
correctable through `PUT /billing/config`, and runbook item **O6** still owns the real ones.

---

## 3. Defects

### D1 — SEVERE — 15 of 20 application screens are unreachable in a browser

**This is the defect that stops the hospital, and it is how the test began: the owner opened
`/admin/users` and got `{"message":"Unauthorized","statusCode":401}`.**

`/opt/hmis-prod/caddy/Caddyfile` routes twelve path prefixes to the API:

```
@api path /auth* /patients* /approvals* /workflow* /health* /opd* /billing* /alerts* /admin* /ops* /tariff* /ws*
handle @api { reverse_proxy api:3000 }                        <- evaluated FIRST
handle      { root * /srv; try_files {path} /index.html }      <- the SPA, never reached for those
```

`apps/web/src/router.tsx` declares its screens on **the same paths**. The matcher is path-only —
no method, no `Accept` discrimination — so a browser asking for a screen is handed the API's JSON.

**Reproduction** — `curl` with a browser `User-Agent` and `Accept: text/html`:

| Result | Routes |
|---|---|
| SPA served (200 `text/html`) | `/` · `/login` · `/change-password` · `/registration` · `/merge` — **5** |
| **Screen dark** (API JSON) | `/admin/users` 401 · `/approvals` 401 · `/ops/mode` 401 · `/patients/:id` 401 · `/opd/appointments` 401 · `/opd/admin` 404 · `/opd/desk` 404 · `/opd/vitals` 404 · `/opd/consult` 404 · `/opd/display` 404 · `/billing` 404 · `/billing/dues` 404 · `/billing/session` 404 · `/billing/office` 404 · `/ops/downtime-kit` 404 — **15** |

**There is no in-app escape hatch, and this is the half that makes it severe.** `router.tsx:42-57`
builds the header nav from **raw anchors** — `<a href="/admin/users">`, not TanStack `<Link to=…>`.
A raw anchor is a full browser page load, so clicking the nav goes to Caddy and hits the same wall.
**Of the 16 nav links, 14 are dead.** After login the index redirects to `/registration`, and
Registration and Merge are the only destinations a human can reach.

**Why it was not caught.** Plan 11f's deploy check recorded *"`/admin/users` answers 401
unauthenticated through the edge, so the route is live and still guarded"*. That is true of the
**API** route and was read as evidence the **screen** had shipped. It is ledger §2.88 exactly, one
level out: `/ops` was dark for a plan cycle under a green test; this is the same mistake with a
bigger blast radius. `apps/core/test/caddyfile-parity.test.ts` pins the API prefixes against the
Vite dev proxy — but nothing pins the SPA's *own route table* against those prefixes, and in dev
the Vite server resolves the collision the other way, so this cannot reproduce outside production.

**Not fixed, deliberately.** The fix is a real choice — nav to `<Link>`, and/or move the API behind
an `/api/*` prefix — plus a rebuild and a deploy. It deserves a plan and the independent review the
method requires, not a hot patch from the session that found it.

### D2 — SEVERE — production was deployed without the configuration its modules require

**MEASURED at preflight:** `billing_config` **0** · `gst_settings` **0** · `approval_types` **0** ·
`services` **0** · `tariff_versions` **0** · `tariff_items` **0**.

**Root cause, MEASURED:** `docker/prod/deploy.sh` runs exactly one seed — line 379,
`seed-cursors.js`. It runs no `seed:billing`, no `seed:tariff`, no `seed:roles`, no `seed:opd`, no
`seed:ops`. Whatever configuration production had came from hand-runs during Plans 11a–11e, and
`seed:billing` and `seed:tariff` were never among them.

**Consequence — the whole revenue path was dead, and the clinical path with it:**

```
POST /billing/invoices -> issueInvoice()
  -> loadBillingConfig()   config.ts:52    throws billing_not_configured
  -> priceDraft() -> loadPricingContext()  context.ts:39  throws version_not_active
```

`loadBillingConfig` is called by `invoices.ts:397`, `refunds.ts` ×3, `credit-notes.ts:288`,
`daily-close.ts:314`, `charge-rules.ts:62`, `gate.ts:70`. **And it reached the clinic:**
`POST /opd/visits/:id/consult/start` returned
`409 consult_gate_refused · billing_fee_gate · fee_unsettled` — **a doctor could not start a
consultation, because billing could not price it.** The nightly `runDailyClose` had been failing
since 2026-08-23 with `last_ok_at` NULL and the literal error `billing_config row 'main' is
missing — run seed:billing`; that was this defect, visible for a day, on a surface nobody read.

**Not repairable through the application.** `updateBillingConfig` (`config.ts:105`) is an
`UPDATE … WHERE id='main'` that throws when zero rows match, so `PUT /billing/config` cannot create
the row. Only `seed:billing` can.

**Status: repaired during this run** by §2 actions 1, 2 and 4, under owner authorisation. The
deploy-script gap that caused it is **NOT fixed** and is the single highest-value item for the next
phase: a deploy that does not establish its own configuration will do this again on the next box.

### D3 — SEVERE — an unknown `patientId` on `POST /billing/invoices` returns 500

Every other unknown-id path in the system returns a clean, coded 404 — `unknown_service`,
`unknown_encounter`, `patient_not_found`, `unknown_doctor`. This one crashes.

**Reproduction** (as `syn.cashier1`):
```
POST /billing/invoices {"draftId":"syn-inv-9","patientId":"01M0NOTAREALPATIENTXXXXXXX",
  "lines":[{"lineId":"l1","serviceId":"<SYN-OPD-GEN>","qty":1}],
  "receipt":{"tenders":[{"mode":"cash","amountPaise":30000}]}}
-> 500 {"message":"Internal server error"}
```

**Container log, MEASURED:**
```
ERROR [ExceptionsHandler] error: insert or update on table "invoices" violates foreign key
  constraint "invoices_patient_id_patients_id_fk"
  code: '23503'
  detail: 'Key (patient_id)=(01M0NOTAREALPATIENTXXXXXXX) is not present in table "patients".'
  at async issueInvoice (/app/apps/core/dist/src/modules/billing/invoices.js:327:16)
```

`issueInvoice` never checks the patient exists; the FK constraint catches it at insert time and
nothing maps `23503` onto an HTTP status. The billing module already has this exact pattern solved
elsewhere — `users-admin.controller.ts:348` maps a unique violation onto a 409 with a comment
explaining that a raw 500 *"tells the person at the desk nothing and looks like an outage"*. The
same reasoning applies here and the mapping is absent.

**Severity rationale:** the brief states a 500 in the adversarial sweep is a defect. A cashier
whose screen holds a stale patient id sees "Internal server error" and cannot tell an outage from
a typo.

### D4 — MAJOR — no login rate-limiting or account lockout anywhere

**MEASURED:** five consecutive wrong passwords against `syn.doctor1` returned 401, 401, 401, 401,
401 — and the correct password then succeeded immediately. No delay, no lockout, no counter.

**Confirmed in code:** a grep for `lockout|failed_attempts|rateLimit|throttl` across
`kernel/auth/` and `kernel/http/` returns only the *administrator*-lockout invariant (the guard
that stops the last admin being removed) — an unrelated mechanism. `@nestjs/throttler` is not a
dependency. `apps/core/src/kernel/auth/password-policy.ts` documents a deliberate decision to keep
`loginSchema` at `min(1)` so existing users are not locked out — sound, and orthogonal to this.

This is a hospital system on the public internet with a 10-character password floor and no
brute-force resistance at all. The password policy is doing real work; nothing is protecting it.

### D5 — MAJOR — patient registration accepts silent duplicates, and nobody can clean them up

**MEASURED:** registering `{"name":"SYN-Rajesh Kumar","sex":"male","ageYears":45,
"phone":"9876500011"}` **three times** produced three patients — `CRK-00000003-8`,
`CRK-00000019-0`, `CRK-00000020-8` — each a clean 201 with a fresh UHID, no warning field, no flag,
no `warnings` array in the response body.

**Confirmed in code:** `registerPatient` performs no similarity check. The only occurrence of
"duplicate" in the whole patients module is `merge.ts:40`, about a merge-conflict rollback.

**And the repair path is closed.** `POST /patients/merge-requests` returned **403** for the
front-office user *and* **403 for the administrator** — `patients.merge` is granted to no role in
production (§4). So a duplicate created at the desk can be created by anyone and merged by no one.
The merge machinery exists and is unreachable.

For a hospital this is the classic master-data failure: one patient, three UHIDs, three clinical
histories, three balances.

### D6 — MAJOR — a confidential patient becomes unreachable by every user

**MEASURED:** `SYN-Confidential Case` (`CRK-00000016-1`) registered with `isConfidential: true`
returns a clean 201. Thereafter, as `syn.frontoff1`:

- `GET /patients/search?q=SYN-Confidential` → `200 {"items":[]}`
- `GET /patients/<id>` → **404**

`search.ts:45-48` filters confidential records unless the caller holds
`patients.confidential.read`, and `getPatient` applies the same rule. **No role in production holds
that permission** (§4) — so the record is invisible to search *and* 404 on direct fetch, for
everybody, permanently. It cannot be found, opened, billed, or treated.

The registration surface offers a checkbox that silently orphans the record. `seed-roles.ts:270`
records the permission as awaiting an owner ruling on *who* may see such a record; until that
ruling exists, the checkbox should not be reachable.

### D7 — MAJOR — the tariff module cannot be operated by any human, by two independent gaps

1. **No role holds any `tariff.*` permission.** All five — `tariff.read`,
   `tariff.services.manage`, `tariff.versions.draft`, `tariff.versions.activate`,
   `tariff.config.manage` — are in `seed-roles.ts`'s `NOT_YET_MODELLED` list, reason recorded as
   *"no tariff role model is published anywhere… no owner ruling exists yet."*
2. **The `tariff_revision` approval type is registered by nothing.** `TARIFF_REVISION_APPROVAL_TYPE`
   is defined at `versions.ts:20` and consumed at `versions.ts:129`, and **no seed script registers
   it** — MEASURED: `approval_types` held only the five `billing_*` rows. `requestApproval` throws
   `unknown_type` for an unregistered key (`requests.ts:39`), so `submitVersion` could not have
   succeeded even if somebody held the permissions.

So a tariff could not be loaded, revised, or activated through any route. This session reached an
active tariff only by driving the module's own in-process API from a script — and had to register
the missing approval type on the way, which is the proof of gap 2.

**This blocks runbook item O6 outright.** "Real tariffs loaded before the first live invoice" has
no path today. It needs an owner ruling naming the role that maintains the tariff, and a seed that
registers `tariff_revision`.

*(Gap 1 is documented and deliberate, not an oversight — `NOT_YET_MODELLED` is explicit that nine
of its thirteen entries mean "no ruling yet" rather than "nailed shut". Gap 2 is an oversight.)*

### D8 — MINOR — a service in a category with no `gst_config` row fails at the counter, not at creation

`createService` accepts any `category` string. `gst_config` holds five rows — `consultation`,
`device`, `pharmacy`, `procedure`, `room_rent`. A SYN service created in category `investigation`
produced, at invoice time, `409 gst_config_missing` — *"no gst_config row for category …"*. The
service was created happily hours earlier. Validation belongs at service creation, where an admin
can act on it, not at the counter in front of a patient.

### D9 — MINOR — cashier-session denomination keys are paise, which will be misread as rupees

Closing a session with `{"denominations":{"500":12}}` produced `countedCashPaise: 6000` — twelve
*500-paise* units, ₹60. A cashier counting twelve ₹500 notes means ₹6,000 and must type
`{"50000":12}`. Internally consistent with the paise-everywhere convention and arguably correct,
but it is the single most misreadable number in the system, it sits on the cash-variance path, and
its screen is one of the 15 that do not load (D1) so no UI translation could be verified.

---

## 4. Verified NOT defects — five things that look alarming and are correct

Recorded because each one cost investigation and would otherwise be re-filed by the next reader.

1. **`event_cursors.last_seq` lagging the event log.** `kernel.notify` sat at 31 while events
   reached 41, with `updated_at` moving. Correct: `dispatcher.ts:162` filters the window by
   `e.name = any(names)` and `maxSeen` starts at the cursor, so `last_seq` tracks the last seq
   *that consumer subscribes to*. The moving `updated_at` is the proof the cycle ran.
2. **Re-POSTing an identical invoice body mints a second invoice.** Correct: idempotency is keyed
   on the `Idempotency-Key` **header**, optional by explicit design (`idempotency.ts:31`). With the
   header sent twice, both calls returned the same `INV/26-27/000004`. The SPA does mint keys
   (`components/submit-button.tsx:47`). My first probe simply sent no header.
3. **Patient search finding nothing for "Sheikh" or "Sunita".** Correct: `search.ts:57` is
   `lower(name) LIKE 'q%'` — a name **prefix** match, plus phone prefix and exact UHID. Unicode is
   fine; `SYN-राजेश` matched. Surname search is a UX limitation, not a fault. *(My first report of
   a Devanagari 400 was my own un-encoded curl. Retracted.)*
4. **20 notifications sitting `queued`.** Correct: quiet hours. `pump.ts:352` — *"QUIET HOURS (D7).
   Not a suppression: back to `queued`, no attempt counted."* The run finished at 23:55 IST.
5. **An administrator deactivating its own account, successfully.** Correct, and I proved it the
   expensive way by doing it to myself. The lockout invariant counts *remaining* full
   administrators; a second one existed (`fullAdministrators: 2`), so the removal was legal. With
   one left it refuses. This is the invariant working, not a hole.

---

## 5. Blocked and soak items

**BLOCKED — could not be tested, with the precise reason:**

| Item | Reason |
|---|---|
| Every screen interaction, all 10 modules | **D1.** Nothing was driven through the UI; this whole test is HTTP. Keyboard-first flows, the Hindi toggle, the mode banner, `SubmitButton`'s idempotency in the browser, print layouts: all unverified. |
| Prescription issue, print, pharmacy verify | **BLOCKED-BY-HARNESS.** Body schema validated and the state guard proved correct (`409 encounter_state_conflict` — *"a prescription is issued in consultation, not registered"*), but I could not sequence a second patient through the queue to `in_consultation` within my own attempt budget. Not evidence of a defect. |
| Patient merge, end to end | **D5/D7** — `patients.merge` held by nobody; 403 for every actor including admin. |
| Workflow instance routes | `workflow.instances.*` held by nobody (documented, deliberate — the OPD flow calls `startInstance` in-process). |
| `runDailyClose` producing a `daily_closes` row | Fires at **23:59 IST** daily. `daily_closes` is 0. |
| Two-admin banner in the UI | **D1** — the screen that renders it does not load. The API count was verified instead: 1 → 2 → 1. |
| Real SMTP / notification delivery | Quiet hours; nothing left the queue. |
| `opd.display.read` board, positive path | The `display` role's only holder is `opd.display1`, a real pilot account whose credential is not mine to use. Negative path verified (403 for two other roles). |

**SOAK — check these tomorrow, with the exact query:**

1. **`runDailyClose` must now succeed.** It has never had a successful run.
   `select job,last_ok_at,last_error from scheduler_heartbeats where job='runDailyClose';`
   Expect `last_ok_at` non-null and `last_error` null after 23:59 IST 2026-08-24. **If it still
   shows the `billing_config` error, D2's repair did not take.**
2. **A `daily_closes` row for 2026-08-24.** `select * from daily_closes;` — expect 1 row covering
   5 invoices / ₹1,500 gross / 1 credit note / 1 paid voucher.
3. **The 20 queued notifications must send when quiet hours lift.**
   `select status,count(*) from notifications group by 1;` — expect `queued` to fall toward 0 and
   `sent` to rise. If they age to `expired` instead, the pump has a real defect that quiet hours
   is currently hiding.
4. **`sweepAppointmentNoShows` (23:55 IST) against the 2 live appointments for 2026-08-25.**
   Neither will be checked in. Expect them marked no-show after their slots pass on the 25th.
5. **`createEventPartitions` (00:15 IST) and `retentionSweep` (01:15 IST)** — both last ran
   2026-08-23; confirm they fire tonight. `events` is at 179 in `events_2026_08`.
6. **`event_dead_letters` must stay 0.** It is 0 now after 179 events and 25 deliveries.

---

## 6. Synthetic-data manifest

Everything below is `SYN`-tagged and was created by this test. It is **retained deliberately** as
the seed for the next phase's testing, and enumerated here so a pre-go-live wipe stays executable.

**Users — 13, ALL DEACTIVATED (`active = false`), verified by SELECT.** Credentials are burned into
this transcript by design; reactivate rather than recreate.

| username | role | password | deactivated |
|---|---|---|---|
| `syn.smokeadmin` | admin | `SynSmoke-Live-2026` | yes (§7) |
| `syn.doctor1` | doctor | `SynLive-doctor1-2026` | yes |
| `syn.doctor2` | doctor | `SynLive-doctor2-2026` | yes |
| `syn.frontoff1` | front_office | `SynLive-frontoff1-2026` | yes |
| `syn.frontoff2` | front_office | `SynLive-frontoff2-2026` | yes |
| `syn.fosuper1` | front_office_supervisor | `SynLive-fosuper1-2026` | yes |
| `syn.cashier1` | cashier | `SynLive-cashier1-2026` | yes |
| `syn.cashier2` | cashier | `SynLive-cashier2-2026` | yes |
| `syn.billmgr1` | billing_manager | `SynLive-billmgr1-2026` | yes |
| `syn.vitals1` | vitals_desk | `SynLive-vitals1-2026` | yes |
| `syn.pharmacy1` | pharmacy | `SynLive-pharmacy1-2026` | yes |
| `syn.opdadmin1` | opd_admin | `SynLive-opdadmin1-2026` | yes |
| `syn.dutymgr1` | duty_manager | `SynLive-dutymgr1-2026` | yes |

Each carries a PIN (`1111`, `2222`, `3333`, `4444`, `5555`, `6666`, `7777`, `8888`, `9999`, `1212`,
`1313`, `1414` in cast order). All twelve staff completed the forced first-login password change
(12 × HTTP 204); `syn.smokeadmin` was created by `seed:admin`, which sets no forced change.

**Patients — 18 created (`CRK-00000003-8` … `CRK-00000020-8`).** `CRK-00000001-7` and
`CRK-00000002-9` are pre-existing and NOT mine.

`SYN-Rajesh Kumar` ×3 (**the D5 duplicates** — `-3`, `-19`, `-20`) · `SYN-Sunita Kumar` ·
`SYN-Aarav Kumar` (minor, 2 guardians) · `SYN-Fatima Sheikh` · `SYN-Imran Sheikh` (minor, guardian)
· `SYN-राजेश कुमार` · `SYN-முருகன் ராமசாமி` · `SYN-Zoë Ngô-Đặng` · `S` (single char) ·
`SYN-Minimal Only` · `SYN-Baby Of Sunita` (age 0) · `SYN-Elder Maximum` (age 130) · `SYN-Dob Given`
· `SYN-Confidential Case` (**D6 — unreachable**) · `SYN-Complete Record` · `SYN-XXXX…` (200 chars).
Allergies on `-3`: `SYN-Penicillin` (severe), `SYN-Dust` (mild).

**OPD:** 2 doctor profiles (`SYN Dr Aarav Menon` / General Medicine, `SYN Dr Ishita Banerjee` /
Paediatrics) · 2 rooms (`SYN-R1`, `SYN-R2`) · 14 schedule rows (7 weekdays × 2 doctors, 09:00–17:00
IST, 15-min slots, `validFrom` 2026-08-01) · 4 appointments for 2026-08-25 (1 booked, 1
rescheduled, 1 cancelled, 1 live) · 5 encounters · 4 vitals rows.

**Billing:** invoices `INV/26-27/000001`–`000005` (₹300 each, ₹1,500 total, all GST-exempt
consultation) · receipts `RCP/26-27/000001`–`000005` · credit note `CN/26-27/000001` (₹300) ·
refund voucher `RFV/26-27/000001` (₹300, **paid**) · 2 cashier sessions (one closed with an
approved −₹6,040 variance, one left open by `syn.cashier2`).

**Tariff (SYN):** version **1**, activated, `effectiveFrom` 2026-08-24T17:14:13Z, 6 items —
`SYN-OPD-GEN` ₹300 · `SYN-OPD-SPEC` ₹600 · `SYN-LAB-CBC` ₹250 · `SYN-PROC-DRESS` ₹150 ·
`OPD-CONSULT-NEW` ₹300 · `OPD-CONSULT-RENEWAL` ₹150. Four `SYN-*` services created.

**Approvals:** 4 rows — 1 `tariff_revision` (granted), 2 `billing_refund` (1 granted and consumed,
1 granted-in-error and correctly refused at issue), 1 `billing_variance` (granted). Approval type
`tariff_revision` and its workflow definition were **registered by this test** and are NOT synthetic
data — they are D7's missing infrastructure and should be kept.

**Not synthetic, keep:** `billing_config`, `gst_settings`, 5 `gst_config` rows, 4
`adjustment_rules`, 5 `billing_*` approval types, `OPD-CONSULT-NEW` / `OPD-CONSULT-RENEWAL`
services. These are D2's repair.

**One artefact left behind:** `/app/syn-tariff.js` inside the `hmis-prod-api-1` container. The
container runs as non-root and refused `rm`. It is inert, outside any volume, and disappears on the
next deploy. Remove with `docker exec -u 0 hmis-prod-api-1 rm -f /app/syn-tariff.js` if desired.

---

## 7. Baseline vs end-state

| Table | Baseline (17:1x UTC) | End state | Δ |
|---|---|---|---|
| `users` / active | 16 / 16 | 29 / **16** | +13 created, all 13 deactivated |
| `patients` | 2 | 20 | +18 |
| `opd_doctors` / `opd_rooms` | 1 / 0 | 3 / 2 | +2 / +2 |
| `opd_appointments` | 0 | 4 | +4 |
| `opd_encounters` | 3 | 8 | +5 |
| `opd_vitals` | 2 | 6 | +4 |
| `opd_queue_entries` | 3 | 8 | +5 |
| `services` | 0 | 6 | +6 |
| `tariff_versions` / `tariff_items` | 0 / 0 | 1 / 6 | +1 / +6 |
| `billing_config` / `gst_config` | 0 / 0 | 1 / 5 | D2 repair |
| `invoices` / `invoice_lines` | 0 / 0 | 5 / 5 | +5 |
| `receipts` / `receipt_tenders` | 0 / 0 | 5 / 5 | +5 |
| `credit_notes` / `refund_vouchers` | 0 / 0 | 1 / 1 | +1 / +1 |
| `cashier_sessions` | 0 | 2 | +2 |
| `daily_closes` | 0 | 0 | soak item 2 |
| `approval_types` / `approvals` | 0 / 0 | 6 / 4 | +6 / +4 |
| `workflow_instances` | 3 | 12 | +9 |
| `events` | 31 | 179 | +148 |
| `event_deliveries` (all `done`) | 2 | 25 | +23 |
| **`event_dead_letters`** | **0** | **0** | **unchanged** |
| `alerts` | 0 | 0 | unchanged |
| `notifications` | 2 | 24 | +22 (20 queued, quiet hours) |
| `roles` | 14 | 14 | unchanged |
| **`operating_mode_changes`** | **0** | **0** | **UNCHANGED — required, verified** |

Operating mode at both ends: **`commissioning`**, `since: null`, `reportId: null`. Migrations: 19,
unchanged. `hmis-prod` containers: 9 up at both ends, none restarted.

---

## 8. What this test does NOT prove

- **Nothing about real staff usability.** No human touched a screen. Given D1, no human *could*
  have. Every claim here is about HTTP behaviour.
- **Nothing about the user interface at all** — not layout, not the Hindi toggle, not the
  keyboard-first flows, not print output, not the mode banner, not the operability banner whose
  whole purpose is to be seen. 15 of 20 screens were never rendered.
- **Nothing about real money.** Every rupee here is synthetic and every threshold is a **DEV
  PLACEHOLDER awaiting CA sign-off (§19)**. `ca_signed` is false in both `billing_config` and
  `gst_settings`. The GST treatment observed (consultation exempt, SAC 999312) is placeholder data,
  not tax advice, and `GET /billing/gstr1` returning a well-formed exempt row proves the *shape*, not
  the correctness, of a return.
- **Nothing about real tariffs.** D7 stands and **O6 is untouched**.
- **Nothing about credential hygiene.** **O1 (a second real full administrator) and O2 (D5's
  rotation of the 15 burned pilot accounts) remain open and owner-only.** This test made
  `fullAdministrators` read 2 for about 40 minutes with a synthetic account and then put it back to
  1. That was measurement, not mitigation — production still has exactly ONE full administrator and
  its only repair is still direct database access.
- **Nothing that needs time.** Everything in §5's soak list is unproven until tomorrow, including
  whether D2's repair actually fixed the nightly close.
- **Nothing about load, concurrency, or failure.** One actor at a time, no parallelism, no
  contention, no restart, no network partition, no backup restore. The locking and concurrency
  properties the plans care most about were not exercised.
- **Nothing about the two red CI commits** (11e F2 / runbook O4). Untouched.

---

## 9. Recommended order for the next phase

1. **D1** — nothing else matters until a person can open a screen. Decide `<Link>` vs an `/api/*`
   prefix split, and pin the SPA route table against the Caddy prefixes with a test that would have
   caught this.
2. **D2's cause** — make `deploy.sh` establish configuration, or make the operability gate fail
   loudly when `billing_config` is absent. `runDailyClose` was screaming for a day.
3. **D3** — map the FK violation to a 404. It is a small change with a working precedent in the
   same codebase.
4. **D4** — add login throttling.
5. **D5, D6, D7** — three owner rulings, not code: what makes two registrations a duplicate; who may
   read a confidential record; who maintains the tariff. Each unblocks a route that exists.
6. **O1/O2** — still the standing operational hazard, still owner-only.

---

## 10. Process notes against myself

- **AGENT-RULES rule 3 violated once, disclosed and corrected.** I wrote a baseline file into the
  session scratchpad before registering that it lives under `/tmp`, which rule 3 forbids outright.
  Deleted with `rm -f`. All later scratch stayed under `/opt/hmis` and is removed in the finish
  block.
- **I deactivated my own administrator account** while testing the lockout invariant, and needed
  the owner to reactivate it. The finding was real and correct (§4.5); the sequencing was mine.
- **Four permission-classifier refusals** (running `seed:admin`, writing a script into the
  container, reading the production `.env`, `docker cp`). Each was reported to the owner rather
  than reshaped around; the owner ran the commands. Recorded because it is the shape of this
  session's cost, and because the refusals were correct — three of the four involved a credential.
- **Two findings I filed and retracted** after measuring properly: a Devanagari search "400" that
  was my own un-encoded curl, and an idempotency "defect" that was a missing header. Both are in
  §4 so they are not re-filed.
