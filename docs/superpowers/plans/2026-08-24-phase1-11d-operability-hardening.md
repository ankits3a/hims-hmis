# Phase 1 / Plan 11d — The live system becomes operable, and its safety net watches itself · Implementation Plan

**Written 2026-08-24 by the next-phase brainstorm session** (prompt:
[`reports/NEXT-PHASE-BRAINSTORM-PROMPT-2026-08-24.md`](reports/NEXT-PHASE-BRAINSTORM-PROMPT-2026-08-24.md)),
against the tree at **`78b0a3d`**.

> **SHA CORRECTION, made the same day and left visible rather than tidied away (§2.80's
> corollary).** This document first said `c65c26b`. **Two commits landed from another session
> while I was reading** — `3104041` (`test(core): the settle bound must sit BELOW jest's
> testTimeout`) and `78b0a3d` (the prompt update) — and `3104041` is the commit that gives
> `scheduler.test.ts` its `SETTLE_BOUND_TURNS = 5_000` at `:119` and its honest-limit comment at
> `:115-117`. **Those lines do not exist at `c65c26b`**, so every reference this plan makes to
> that file is against `78b0a3d` and is quoted correctly only under that SHA. `3104041` touched
> **one file** and `78b0a3d` touched **one document**, so every OTHER consumed surface below is
> byte-identical at both SHAs — verified by `--stat`, not assumed. **This is §2.78 happening to
> the session that wrote about §2.78: a coordinate is a claim with no expiry date on it, and
> mine expired under me.** D11's premise is unaffected and re-checked: `jest.config.cjs:14`
> still reads `testTimeout: 15000` and the census still carries no per-test override.
Spike brief: [`reports/PLAN-11D-SPIKE-BRIEF-2026-08-24.md`](reports/PLAN-11D-SPIKE-BRIEF-2026-08-24.md) ·
execute prompt: [`reports/PLAN-11D-EXECUTE-PROMPT-2026-08-24.md`](reports/PLAN-11D-EXECUTE-PROMPT-2026-08-24.md).

**The writer of this plan does not execute it.** A different session does, and that separation has
now paid four times.

> **~~ONE FORK IS OPEN AND IT IS THE PLAN'S OWN PREMISE.~~ CLOSED 2026-08-24 BY MEASUREMENT, THE
> SAME DAY, AGAINST THE LIVE DATABASE.** D1's central claim was written as MEASURED FROM SOURCE and
> PREDICTED ABOUT PRODUCTION. **The prediction was exactly right**, and the four read-only SELECTs of
> spike Question B were run against `hmis-prod` on the owner's explicit authorization before any
> brief was compiled — see **§B-MEASURED** below for the transcript. `admin` holds **nine**
> permissions: six `auth.*` and three `ops.*`, and **nothing else**. The catalog holds **59**. **Fifty
> declared permissions are held by nobody.**
>
> **Spike Question B is therefore DISCHARGED and the spike agent must not repeat it** (its brief is
> amended to match). ~~**Question A remains open and still blocks compile.**~~ **QUESTION A IS ALSO
> DISCHARGED — 2026-08-24, by the spike, MEASURED** (`reports/plan-11d-spike-report.md`, and D5
> below carries the numbers): `withTx` holds one backend, the loser blocks ~203 ms against a 200 ms
> hold where the no-lock control waits 0 ms, the post-lock re-read sees the winner's commit 5/5, and
> a thrown error releases the lock. **No halt condition fired and D5 ships as written.**
>
> **THIS DOCUMENT IS NO LONGER FORK-OPEN ANYWHERE. Compile is unblocked.** The spike additionally
> moved D7 and V18a — the alert-path counters are present at zero on a fresh Alertmanager (so no
> `absent()` leg is needed), and `promtool` reports SUCCESS at exit 0 for a healthy file that merely
> OMITS the series a rule reads, which is why V18a gained a third required-DIED mutant and the
> Book's count moved 26 → 27.

**Baseline at writing** (gate-report addendum 2, re-measure at compile): `apps/core` **144 suites /
1049 tests** · `apps/web` **34 / 173** · `packages/contracts` **3 / 7**, exit 0. Latest migration
`0017_windy_red_shift`. Measurement beats this document.

---

## Why 11d is next, and what it is deliberately not

**The critical path is no longer feature code, and it is no longer deployment either — it is
whether the live system can be operated by more than one person and whether it can tell the truth
about its own health.** Production is up: `hmis-prod`, nine services on `https://hmis.crkmch.com`,
WAL archiving to R2, a weekly restore drill that passes, and — since 2026-08-23 — a
`severity: critical` alert that reaches a human inbox, confirmed by the owner's own receipt.

Against that, three MAJOR defects from 11c are unfixed in code that is now serving a hospital, and
this brainstorm found **two more of the same class that nobody had booked**:

1. **Nothing creates a second user.** `createUser` has exactly one non-test caller —
   `scripts/seed-admin.ts:24` — and that script returns early on any deployment that already has an
   admin. `setPin` and `rotateBadge` have **zero** non-test callers anywhere in the tree. There is
   no user-administration HTTP surface: the twelve controllers are health, alerts, approvals, auth,
   ops, workflow, billing, opd (three), patients and tariff. `seed:ops` *refuses* a username that
   does not exist, by design. So D2's separation of duties, the sub-2-second PIN fast-switch Plan
   02 built and perf-tested, and owner UAT at the real counters are all unreachable on the live box.
2. **Nothing grants any module's permissions.** `grantPermissionToRole` has exactly **two**
   non-test callers: `seed-admin.ts`, whose registry holds `authManifest` **alone** (six `auth.*`
   strings), and `seed-ops.ts`, which grants the three `ops.*` strings. `app.module.ts` installs
   **nine** manifests, so `syncPermissions` mirrors every permission NAME into the catalog at
   boot — and nothing ever turns a name into a grant. **This is MAJOR 4 with nine doors instead of
   one, and §3.43 is the entry that predicted it**: MAJOR 4's fix was scoped to the door the
   reviewer walked. The README even instructs the owner to perform the missing step —
   *"the seed CREATES role keys, never grants them. Grant the `opd.*` permissions per the table
   above"* (`README.md:229`) — naming a tool that does not exist.
3. **MAJOR 1** — the mode ledger takes no lock. Measured **14/15** and **15/15**. A duty manager
   who declares `downtime` gets a 201 while the banner the whole hospital reads says `degraded`.
4. **MAJOR 2** — `ops.interface.manage` is bound to its routes by nothing a test can see. Mutant
   **SURVIVED** beside a control that **DIED**.
5. **MAJOR 3** — nothing watches the alert path itself, and **this got worse when 11c shipped**:
   the path is live, so its silent failure modes are live too.

**Everything else that could be next is either ruled out or blocked, and each for a stated reason:**

| candidate | why not now | trigger that changes it |
|---|---|---|
| **Plan 09** (memberships, coupons) | Owner ruled 2026-08-23: **no live memberships in the pilot.** Shipping it next spends a pipeline on code with no live consumer while known defects serve a hospital. | The owner reverses that ruling, or cutover turns out to need the legacy membership book carried over. |
| **Plan 12a** (agent runtime) | Gated before activation by the DPIA artefact and the inference-locus decision — **neither started**, both weeks of owner lead time. Its two proofs also want live baselines that this plan is a precondition for. | The DPIA author is engaged AND the inference locus is decided. |
| **Plan 11b** (the hybrid step) | Waits on the on-prem primary being procured and racked. | Hardware arrives. |
| **Go-live readiness itself** | Counsel bundle, DPIA, WhatsApp BSP onboarding, E-11 boundary map, internal auditor — **no pipeline can produce any of it**, and inventing tasks around owner action is how a plan pretends to progress. Said plainly rather than dressed up. | Nothing; these run on the owner's clock in parallel with this plan. |

**What 11d does NOT build, stated so nobody looks for it:** no HTTP user-administration surface and
no admin screen (booked as **Plan 11e** below — the owner ruled "script now, screen booked later")
· no schema change of any kind · no `apps/web` change of any kind · no out-of-band watchdog (that
is E-16 and it belongs to 11b — see D7's honest limit) · no password-change or credential-reset
flow (booked into 11e with the screen that needs it).

## Owner rulings this plan encodes (2026-08-24, in conversation)

1. **Staff provisioning ships as a SCRIPT now; the HTTP surface and admin screen are booked as a
   named later plan (11e).** The pilot needs perhaps five to twenty accounts created once, by the
   owner, and `seed:ops` just proved that shape idempotent on the live box. The HTTP surface is the
   highest-privilege write in the system and deserves its own plan with §3.42's full treatment plus
   screens — folding it in here is precisely how 11a became too large to execute.
2. **11d ships the ACTUAL role model, not merely the mechanism.** The README's two tables — its OPD
   table (`README.md:209`, seven roles) and its billing table (`README.md:428`, two roles) — become
   real `role_permissions` rows, with a test pinning each cell against the owning manifest **and
   against the README itself**, so a transcription error fails the build rather than the pilot. A
   documented-but-unenforced role model is §3.34's class exactly.
3. **T1's D2 reading of the commissioning exit is CONFIRMED** (the open ask in 11c's findings
   inbox). **Every** exit from `commissioning` rides D-17's gate, not merely `→ ramp|normal`. The
   narrow reading leaves `commissioning → downtime → normal` as a two-step path to `normal` that
   never consults a validation report. 11d records the ruling and **builds the mutant 11c's T1
   never built** for the bypass half (Book V12b) — the inbox entry marked that half a PREDICTION
   and it stays one until this plan kills it.
4. **`scheduler.test.ts` gets a per-TEST timeout, documented — not a redesign and not nothing.**
   The 5 000-turn bound is correct; what is missing is headroom for the walk. Phase 0 gives the L14
   census its own budget so a bound hit produces the set assertion naming the missing jobs rather
   than a bare `Exceeded timeout of 15000 ms`.
5. **The spike may run READ-ONLY queries against the production database.** SELECT only; no INSERT,
   no UPDATE, no container action, no schema change. This converts the plan's central premise from
   a prediction into a measurement before a single brief is written. **EXERCISED 2026-08-24, in the
   planning session rather than the spike, on a second explicit authorization — four SELECTs, exit
   VALUE 0, transcript in §B-MEASURED.** Doing it before the spike rather than inside it cost one
   minute and removed the risk of a 100-200k spike measuring a premise that had already collapsed.
6. Standing rulings inherited and untouched: retention stays INERT (`RETENTION_ENABLED=false`) ·
   staged deployment (spec v4.7) · production shares the build host under the `hmis-prod` project
   (rules 3 and 7 as amended) · **the deploy is authorized only when the owner names it**.
7. **NEW, RULED AT COMPILE 2026-08-24 — `patients.*` joins the role model, and the other seventeen
   unheld permissions are booked as NOT YET MODELLED.** The compile sweep measured that D3's two
   README tables leave **twenty of the fifty-nine declared permissions held by nobody**, and that
   D1's three named "exceptions" were each justified by *guards no route* — a different property
   from *held by a role*, and all three are in fact held. The owner ruled: **grant
   `patients.register`/`read`/`update` to `front_office` and `front_office_supervisor`, and
   `patients.read`/`update` to `vitals_desk`**, because the README's own OPD prose already says
   those permissions "stay with the desk and vitals roles" and because a `front_office` that cannot
   register a patient makes the OPD flow unrunnable — which is the exact failure 11d exists to fix.
   **The remaining seventeen are listed as not-yet-modelled with a reason each, and no grant is
   invented for any of them.** D1, D3, V2 and V3 are amended in place accordingly.

---

## Design (the decisions this plan makes — read before the tasks)

### D1. The grant gap is one defect with nine doors, and the fix is a REACHABILITY INVARIANT

**The measured facts, from source at `78b0a3d`:**

- `syncPermissions(db, registry)` (`kernel/auth/permissions.ts:11`) upserts one `permissions` row
  per manifest permission. **It grants nothing to any role.** It is a catalog.
- `grantPermissionToRole(db, registry, roleKey, permission)` (`:29`) writes the `role_permissions`
  row, and refuses any string `registry.allPermissions()` does not contain.
- **Its two non-test callers are `scripts/seed-admin.ts:32` and `scripts/seed-ops.ts:138`, and
  nothing else in the tree.** `seed-admin.ts` builds a registry holding `authManifest` alone
  (`:12-13`), so `registry.allPermissions()` there is six strings, and the script returns early
  (`:18-22`) on any deployment that already has an admin. `seed-ops.ts` grants three.
- `app.module.ts:46-61` installs **nine** manifests: auth, workflow, approvals, patients, tariff,
  opd, billing, alerts, ops. So on any booted deployment the CATALOG is complete and the GRANTS
  cover two modules.
- `alertsManifest.permissions` and `notifyManifest.permissions` are deliberately **empty** (their
  own headers say why: alerts are yours by identity, not by role). `notifyManifest` is installed by
  the worker, not by `app.module.ts` — which is exactly why the manifest list must become one
  artefact rather than several hand-maintained copies (D2).

**The fix is not "add grants for billing too".** That is scoping the fix to the reproduction, which
is the mistake §3.43 exists to name, committed once already by MAJOR 4's closure. The fix is an
**invariant with a test**:

> **Every permission an installed manifest declares is either held by at least one seeded role, or
> named in an explicit exceptions list beside the reason it is unreachable on purpose.**

That assertion fails the build the day a module adds a permission and forgets the role model, which
is the failure mode that produced this defect twice. **The exceptions list is what keeps it honest
rather than merely green.**

> **CORRECTED AT COMPILE 2026-08-24 (owner ruling 7), and the correction is load-bearing: THIS
> PARAGRAPH ORIGINALLY CONFLATED TWO DIFFERENT PROPERTIES.** It read: *"it is where
> `auth.users.manage` and `auth.roles.manage` (declared, guarding no route, waiting for 11e) and
> `billing.credit.extend` (checked inside the issue transaction, never at a route — `README.md:424`)
> are written down with their reasons."* **Every one of those three reasons is about GUARDING A
> ROUTE, and the invariant above is about being HELD BY A ROLE.** They are not the same claim, and
> under the invariant as stated **none of those three is an exception at all**: `admin` holds both
> `auth.*` strings via `seed:admin`, and the README's own billing table grants
> `billing.credit.extend` to `cashier`. "Declared but guarding no route" is a real and useful fact —
> it is what `billing.e2e.test.ts` and T4's leg 2 assert, per module — but it belongs to those
> tests, **not to this one**.
>
> **What the exceptions list actually holds, measured at `1764aec`: the TWENTY declared permissions
> that NO role holds.** Held = 39 of 59 (`opd.*` 14 and `billing.*` 14 from the two README tables,
> `approvals.requests.read`/`.decide` from the billing table, `auth.*` 6 from `seed:admin`, `ops.*`
> 3 from `seed:ops`). **Unheld = `workflow.*` 8 · `tariff.*` 5 · `patients.*` 5 ·
> `approvals.types.manage` and `approvals.requests.create`.** Confirmed exhaustive:
> `grantPermissionToRole` still has exactly two non-test callers, so there is no other grant source
> in the tree.


### §B-MEASURED — what production actually holds (2026-08-24, read-only, owner-authorized)

Four SELECTs, no writes of any kind, run through `docker exec hmis-prod-db-1` with the credentials
evaluated INSIDE the container so no secret entered any transcript. **`psql` exit VALUE 0.**

```
=== who exists, and can any of them fast-switch? ===
 username | active | has_pin
----------+--------+---------
 admin    | t      | f
(1 row)

=== the join PermissionGuard actually reads ===
 username |   role_key   | scope_type |       permission
----------+--------------+------------+-------------------------
 admin    | admin        | hospital   | auth.agents.manage
 admin    | admin        | hospital   | auth.break_glass.review
 admin    | admin        | hospital   | auth.break_glass.use
 admin    | admin        | hospital   | auth.roles.manage
 admin    | admin        | hospital   | auth.temp_role.grant
 admin    | admin        | hospital   | auth.users.manage
 admin    | admin        | hospital   | ops.downtime.generate
 admin    | admin        | hospital   | ops.interface.manage
 admin    | admin        | hospital   | ops.mode.set
 admin    | duty_manager | hospital   | ops.downtime.generate
 admin    | duty_manager | hospital   | ops.interface.manage
 admin    | duty_manager | hospital   | ops.mode.set
 admin    | owner        | hospital   |
(13 rows)

=== is the CATALOG complete? ===          === which roles exist, and how many grants? ===
  module   | count                             key      | granted
-----------+-------                        --------------+---------
 approvals |     4                          admin        |       9
 auth      |     6                          duty_manager |       3
 billing   |    14                          owner        |       0
 opd       |    14                         (3 rows)
 ops       |     3
 patients  |     5
 tariff    |     5
 workflow  |     8
(8 rows)
```

**The premise HOLDS, and D1 is now MEASURED rather than predicted.** `admin` holds nine
permissions. The catalog holds **59** (4+6+14+14+3+5+5+8 — alerts and notify declare zero, so eight
module rows for nine installed manifests is exactly right). **Fifty declared permissions are held by
no role at all**, so every `billing.*`, `patients.*`, `opd.*`, `tariff.*`, `workflow.*` and
`approvals.*` route on `https://hmis.crkmch.com` answers **403 to the only user who exists.** A
patient cannot be registered and an invoice cannot be issued on the live system today.

**THREE THINGS THE QUERIES FOUND THAT THIS PLAN DID NOT PREDICT:**

1. **`admin` HAS NO PIN** (`has_pin = f`). Plan 02 built and perf-tested a sub-2-second PIN
   fast-switch precisely so ward terminals would not end up sharing a session, and **not one user
   can use it** — because `setPin` has zero non-test callers and nothing can set one. This is the
   staff-account gap arriving a second way, and it makes **T2's `pin` handling load-bearing rather
   than a convenience.** Book V6 already covers it; it is now covering a measured defect.
2. **ONLY THREE ROLES EXIST** — `admin`, `duty_manager`, `owner`. The **ten** `OPD_ROLE_KEYS` that
   `seed:opd` inserts are absent, which means **`seed:opd` has NEVER been run against production**,
   which in turn means no `opd_config` row and no placeholder departments. That is not a permission
   defect and it is not 11d's to fix — **it is a commissioning gap**, booked in Carried forward and
   named in the execute prompt's deploy checklist. D3's `ensureRole` guard already handles finding
   those roles absent; what changes is that it will CREATE most of them rather than find them.
3. **EVERY PER-MANIFEST PERMISSION COUNT IN THE CONSUMED SURFACES SECTION IS INDEPENDENTLY
   CONFIRMED** by the live catalog — auth 6, workflow 8, approvals 4, patients 5, tariff 5, opd 14,
   billing 14, ops 3. That transcription was read from source and is now corroborated by a source
   that cannot have copied it. **This is the one place where a census got a free second witness**,
   and it is worth recording because §2.73 usually only tells you when a count has gone stale.

**What did NOT need changing as a result:** T1's scope, D1's argument, D3's role model, the Book,
the task list, or the budget. **The measurement confirmed the plan rather than moving it** — which
is the outcome that costs nothing and is worth exactly as much as the one that saves a rung.


### D2. ONE manifest list, consumed by every registry — §2.54 closed before it fires a third time

`app.module.ts` installs nine manifests. The worker installs its own set. `seed-admin.ts` installs
one. `seed-ops.ts` installs one. **That is four hand-maintained copies of "which manifests exist",
and §2.54 is the ledger entry that says two copies of one fact drift by construction** — it cost
Plan 08.5 its headline deliverable, and the drift between `seed-admin.ts`'s registry and
`app.module.ts`'s is *precisely how MAJOR 4 happened*.

**So: `src/kernel/modules/manifests.ts` exports `ALL_MANIFESTS`**, and `app.module.ts` and the seed
scripts consume it. The worker keeps its own smaller set deliberately — it installs what it
subscribes to — and the test states that difference as an intentional subset rather than letting it
look like drift.

**The assertion that makes this load-bearing** (Book V4): a manifest installed by `app.module.ts`
and absent from `ALL_MANIFESTS` fails. Without that leg this is a refactor; with it, it is the
mechanism that stops the next module repeating MAJOR 4.

### D3. The role model is CODE, and the README is pinned to it — not the other way round

Owner ruling 2 puts nine roles in the repository:

| source | roles |
|---|---|
| `README.md:209` (OPD) | `front_office` · `front_office_supervisor` · `vitals_desk` · `doctor` · `opd_admin` · `display` · `pharmacy` |
| `README.md:428` (billing) | `cashier` · `billing_manager` |

**AND `patients.*` JOINS THE MODEL — owner ruling 7, 2026-08-24, taken at compile because the two
tables alone ship a role model that cannot run an OPD visit.** The README's OPD section already
states the intent in prose immediately under its table: *"Plan 05's `patients.register` /
`patients.read` (and `patients.update` for quick allergies) stay with the desk and vitals roles —
the OPD screens read demographics through the patients module."* Shipping the tables ALONE would
give `front_office` fourteen `opd.*` permissions and **still no way to register a patient**, so the
pilot would die at step one of the flow this plan exists to enable. That is transcription of a
stated intent, not invention of authority:

| role | gains |
|---|---|
| `front_office` | `patients.register` · `patients.read` · `patients.update` |
| `front_office_supervisor` | `patients.register` · `patients.read` · `patients.update` |
| `vitals_desk` | `patients.read` · `patients.update` |

**`vitals_desk` does NOT get `patients.register`** — the prose says registration is the desk's work
and vitals records against a patient who already exists, and a narrower grant is the one that can be
widened later without anybody being locked out in the meantime.

**THE REMAINING SEVENTEEN ARE `NOT YET MODELLED`, WHICH IS A DIFFERENT THING FROM AN EXCEPTION AND
MUST SAY SO IN ITS OWN WORDS.** An exception says *"unreachable on purpose"*; these say *"no owner
ruling exists yet"*, and writing the second as the first is how a gap becomes a decision nobody
made. `workflow.*` 8 (activation is a two-key Class A ceremony — `README.md` OPD runbook step 3 —
whose assignment is per-definition and per-environment, and no table models it) · `tariff.*` 5 (no
role model published; the pilot's tariff is seeded by script) · `patients.merge` and
`patients.confidential.read` (a supervised correction and §14 VIP visibility — both want an owner
ruling this plan does not have) · `approvals.types.manage` and `approvals.requests.create`.
**Each is listed with that reason, and the day any of them gains a holder the list shrinks by one
and the test says so.**

`scripts/seed-roles.ts` holds the model as a typed table and is the **source of truth**. Two
independent legs stop it being a transcription nobody checks:

- **(a) against the MANIFESTS** — every granted string is declared by an installed manifest, and
  every declared permission is held or excepted (D1's invariant). This catches a typo
  (`billing.invoice.isue`) and an orphan (a permission no role can hold).
- **(b) against the README** — the two markdown tables are parsed and compared cell for cell, both
  directions, **over the TABLE-DERIVED subset of the model only**. Owner ruling 7 adds `patients.*`
  grants that appear in NEITHER table, so an unscoped "both directions" would fail against the
  correct model. **The `patients.*` additions get their own leg**: asserted as exactly the eight
  (role, permission) pairs above, with the README prose line located and quoted as their reason, and
  their own census pinned first. A model row that is neither table-derived nor in that explicit set
  **fails** — which is what stops the subset scoping from becoming a hole. `caddyfile-parity.test.ts` is the precedent for parsing a non-TypeScript artefact
  from a test, and it carries the discipline this leg must copy: **both parsers THROW rather than
  return `[]` on a shape they do not recognise, and the test pins a census — nine roles, and the
  exact permission count per role — BEFORE anything is compared**, because two parsers that both
  return `[]` agree with each other forever (§2.49).

**Why the README is the pinned side and not the source:** documentation drifts silently and code
does not; but a role model that lives only in code is a role model the owner cannot review before
running it. Pinning gives both — the owner reads the table, the build enforces it.

**THREE FACTS ABOUT ROLE KEYS THAT THIS SESSION MEASURED AND THAT WILL BITE A CARELESS
TRANSCRIPTION.** All from `src/modules/opd/config.ts:75-86` and `README.md:209/428`:

1. **`OPD_ROLE_KEYS` holds TEN keys and the README's OPD table has SEVEN columns, and they are not
   nested sets.** The constant carries `nurse`, `duty_manager`, `owner` and
   `medical_superintendent`, none of which is a column in the permission table; the table carries
   **`pharmacy`, which is in no role-keys constant anywhere.** So `seed:roles` creates `pharmacy`,
   `cashier` and `billing_manager` itself and finds the other six already present from `seed:opd`
   — which is exactly why `ensureRole`'s existence guard is not optional.
2. **`seed:roles` CONSUMES `OPD_ROLE_KEYS`; it does not re-list those keys.** A fourth copy of "the
   role keys" is §2.54's mechanism, and this plan exists partly because of the third copy. Where a
   role has no entry in that constant, the seed declares it locally **and the test asserts the
   union**, so neither source can quietly drop one.
3. **The billing table's last row is `approvals.requests.read` / `.decide` in ONE cell**
   (`README.md:444`) — two permissions from a DIFFERENT manifest, written as a shorthand. A naive
   parser reads that cell as a single malformed permission string. D3 leg (b)'s parser must expand
   it or **throw on it**, and it must never silently skip it, because skipping is how a parity test
   passes vacuously (§2.49). Whichever it does, the census pin is what proves it did something.

**`opd_admin`, `display` and `pharmacy` get roles with grants and no humans, and that is correct.**
`seed:roles` creates authority; `seed:staff` assigns it. A role with zero holders appears in the
report rather than being silently absent — the same discipline `seed:ops` already applies to
`owner`.

### D4. `seed:staff` reads its roster from STDIN, and the trade is stated

The roster carries passwords and PINs. Three shapes were considered and the reasoning matters more
than the verdict:

- **Env vars** (the `seed:ops` shape, `OPS_DUTY_MANAGERS=asha,ravi`): correct for usernames, wrong
  for credentials — they land in shell history, in `ps` output, and in any process dump.
- **A file under `/opt/hmis-prod`**: rule 3 says that directory holds deploy-script-managed configs
  and the production `.env` only, and a credential roster left on the box is an artefact nobody is
  going to remember to delete.
- **STDIN** — chosen. `cat roster.json | pnpm --filter @hmis/core seed:staff`. Nothing is written to
  the box, nothing enters shell history, and the owner controls the only copy.

**The honest cost of the choice, disclosed rather than glossed:** stdin leaves no artefact to audit
later — there is no file to re-read to see who was provisioned. The script therefore prints a
**roster report without secrets** (username · full name · roles · pin set yes/no · created or
already-present), and that transcript is the audit record. Book V9 asserts by execution that no
password and no PIN appears anywhere in stdout or stderr.

**Re-running with a DIFFERENT password for an existing username is a hard REFUSAL, not an
overwrite.** A roster that changes a credential is either a typo or a deliberate reset, and both
deserve to be explicit. There is no credential-reset flow in this system yet, so a silent overwrite
would be the only way to lock a real user out of a live hospital and nobody would see it happen.
Book V8 measures it.

**Roles are ASSIGNED here and GRANTED in D3** — `seed:staff` never calls `grantPermissionToRole`.
One script mints authority, the other hands it to humans; a script that did both would make "give
Asha the cashier role" and "change what a cashier may do" the same command.

### D5. The mode ledger takes `pg_advisory_xact_lock`, and the lock goes BEFORE the read

MAJOR 1, measured by 11c's discovery reviewer over 15 rounds per case: **A** two concurrent
identical `normal → downtime` → **14/15** appended two rows and two events; **B** concurrent
`→ downtime` and `→ degraded` → **15/15** both succeeded with `current=degraded` in all fifteen;
**C** two concurrent go-live exits → **15/15** left two commissioning-exit rows.

`changeOperatingMode` (`kernel/ops/mode.ts:112`) reads the current mode at `:127` with a plain
`SELECT` and appends at `:144`. Under READ COMMITTED all four refusals are check-then-act with
nothing serialising the pair.

**The fix: `select pg_advisory_xact_lock(hashtext('hmis.operating_mode'))` as the FIRST statement
of the function, before `getOperatingMode(tx)`.**

Three things about that sentence are load-bearing and each has a reason:

- **`pg_advisory_xact_lock`, not `FOR UPDATE`.** A row lock cannot serialise the case with **no
  rows**, and the zero-row commissioning exit is exactly case C — the one where two concurrent
  go-live exits both won.
- **The `_xact_` variant, not the session variant already in the tree.** `kernel/worker/scheduler.ts`
  uses `pg_try_advisory_lock` and its own header (`:28-36`) explains the consequence: a
  session-scoped lock pins one pooled client for the lock's whole lifetime and must be explicitly
  unlocked. The transaction-scoped variant is released by COMMIT or ROLLBACK, which is the only
  discipline that survives a thrown `ModeError` between the lock and the append — and this function
  throws on four separate paths.
- **BEFORE the read, not after.** A lock taken after `getOperatingMode` serialises the writes and
  not the decisions, so case B — the duty manager who declares downtime and is told `degraded` —
  still happens. **Book V11 is a row of its own for exactly this**, because a correctly-named lock
  in the wrong place reads as correct in every code review.

**~~This is the ONE new database primitive in the plan and nobody here has executed it.~~ IT IS NOW
MEASURED, NOT PREDICTED** — spike Question A (`reports/plan-11d-spike-report.md`), five runs against
the dev database on PostgreSQL 16.14 through the shipped `withTx`/`Tx` surface. All four
load-bearing claims hold, **each against a control that would have caught a trivially-true result**:

- **`withTx` holds ONE backend for the transaction's life.** `pg_backend_pid()` = `291220` at
  statement 1 and at statement 7 with four statements between; `txid_current()` identical too.
  **Control:** two *concurrent* `withTx` blocks got pids `291220` and `291221`, so the pool does
  hand out distinct backends and the pin is the transaction's.
- **The loser BLOCKS for the winner's hold.** Against a 200 ms hold the loser waited
  **203.0 / 203.7 / 203.6 / 204.0 / 204.0 ms**. **Control:** the identical choreography with the
  lock statement removed waited **0 ms in all five runs**. `pg_locks` during the wait names it
  exactly — `locktype=advisory`, `mode=ExclusiveLock`, `objid=774876239`, waiter's
  `wait_event_type=Lock` / `wait_event=advisory` — and the no-lock control's same snapshot returned
  **no rows at all**, so no other lock in this path produces that wait (AGENT-RULES §2.6).
- **After acquiring, the loser's re-read SEES the winner's committed row** — sentinel present, 5/5.
  **Control:** without the lock it is absent, 5/5. **That control IS case B.**
- **A thrown error releases the lock.** A `ModeError`-shaped throw between the lock and the append
  left **zero** granted advisory locks anywhere, and the next transaction acquired in
  **1.5-1.8 ms** against the 203 ms of a genuinely contended acquisition. **No unlock call is needed
  on any of the four refusal paths.**

**The statement, exactly as measured and exactly as T3 should write it:**

```ts
await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hmis.operating_mode"}))`);
```

It is `Tx`-typed and compiles: the scratch helper `takeModeLock(tx: Tx)` passed
`pnpm --filter @hmis/core exec tsc --noEmit` at **exit VALUE 0** under `strict` +
`noUncheckedIndexedAccess`, so T3 meets no type problem on its first rung. `hashtext` returns
`integer` (`hashtext('hmis.operating_mode') = 774876239`), widening to the single-argument
`pg_advisory_xact_lock(bigint)` overload — the same resolution `kernel/worker/scheduler.ts` already
relies on. Calling it twice in one transaction does **not** self-deadlock. `statement_timeout`,
`lock_timeout` and `idle_in_transaction_session_timeout` are all `0` on the dev server and nothing
in `docker/` or the connection strings sets any of them, so a blocked acquisition cannot be cut off
by a timeout.

### D6. `ops.mode_changed` gains `changeId`, closing a routed-forward finding

11c's findings inbox records that the payload is `{from, to, note, reportId}` and carries no
change-row id, so the alerts consumer had to write `refType: "operating_mode"`,
`refId: <the mode word>` where its two neighbours carry an entity type and its id.
`changeOperatingMode` already mints that id at `:143` and appends the event at `:154` **in the same
transaction**, so this is one field on the payload and one line in the consumer.

It rides D5's task because it is the same function, the same author and the same commit — and
because a mode alert that cannot deep-link to its own history row only ever gets more expensive to
fix as consumers accumulate.

### D7. The alert path watches itself — and its ONE unavoidable limit is stated, not hidden

MAJOR 3, and the sharpest of the three because 11c is what armed it. Alertmanager is not a scrape
target; `up{job="alertmanager"}` and `alertmanager_notifications_failed_total` do not exist on this
box; no rule touches `prometheus_notifications_errors_total`. A rotated app password, a bouncing
mailbox and a crash-looping alertmanager are all indistinguishable from a quiet night.

**What ships:** one scrape job (`alertmanager:9093` over the compose network — the same
service-name reach `prometheus.yml`'s `alerting:` block already uses at `:41-43`) and a **third
rule file**, `alerts-meta.yml`, carrying three rules:

| rule | expression shape | what it catches |
|---|---|---|
| `HmisAlertmanagerDown` | `up{job="alertmanager"} == 0` | the sink is gone or crash-looping |
| `HmisAlertNotificationsFailing` | `increase(alertmanager_notifications_failed_total[15m]) > 0` | a rotated app password, a bouncing mailbox, an SMTP refusal |
| `HmisPrometheusCannotReachAlertmanager` | `increase(prometheus_notifications_errors_total[15m]) > 0` OR `increase(prometheus_notifications_dropped_total[15m]) > 0` | the link between the two, which neither endpoint's own health reports |

**A third file rather than rules inside `alerts.yml`, for D11's exact reason, restated because it
is now a pattern rather than an accident:** `apps/core/test/alerts-parity.test.ts` reads ONE
hardcoded path and parses it with matchers that throw on shapes they do not recognise, and its
`job=~` parser matches FILE-WIDE and asserts exactly two legs. `alerts.yml` is the SCHEDULER-parity
surface; `alerts-backup.yml` is the BACKUP surface; `alerts-meta.yml` is the ALERT-PATH surface.
The `rule_files` list grows by one line and D8's new test is what stops that line being forgotten.

**The third rule's series were also measured, and they behave differently from the first two.**
`prometheus_notifications_dropped_total` is **unlabelled and present at 0 from boot,
unconditionally**. `prometheus_notifications_errors_total` is **per-alertmanager-endpoint and exists
only because `prometheus.yml` carries an `alerting:` block** — on a Prometheus with no such block it
is absent from `/metrics` entirely; the moment one is configured, the series appears **at 0 for
every configured endpoint within seconds, before any error**, and then climbs 0 -> 1 on the endpoint
that fails. Since 11c's `alerting:` block is already at `prometheus.yml:41-43`, both series exist on
the production box today and the rule is armed. **The OR is what makes it robust either way**: the
`dropped_total` leg is always evaluable, so the rule can never be silently non-evaluable as a whole.

**THE LIMIT, AND IT IS REAL: an alert about a broken alertmanager cannot be delivered by that
alertmanager.** This plan does not pretend otherwise. What the three rules genuinely buy on a
single-box deployment:

- `HmisPrometheusCannotReachAlertmanager` is evaluated by **Prometheus, a different process**, from
  Prometheus's own self-scrape (`job_name: prometheus`, already configured at `prometheus.yml:46-48`
  — no new scrape needed for this half). A dead alertmanager is therefore *observable* by a healthy
  Prometheus — on `/alerts` and in Grafana — even when it cannot be emailed.
- `HmisAlertNotificationsFailing` covers the far more likely failure by a wide margin: **the sink is
  up and the credential or the mailbox is broken.** That alert *can* be delivered — a failing email
  receiver does not stop Alertmanager evaluating or routing — and **the counter climbing is
  MEASURED, not assumed**: spike Question C drove a real SMTP refusal against
  `prom/alertmanager:v0.27.0` and `alertmanager_notifications_failed_total{integration="email"}`
  with `reason="other"` reached **6 in ~60 s** of continuous failure, so `increase(...[15m])` stays
  far above 0 for as long as the situation persists and the alert is re-sent.

**THE MISSING-SERIES BLIND SPOT DOES NOT EXIST HERE, AND THIS WAS MEASURED BEFORE THE RULE WAS
WRITTEN.** A `prom/alertmanager:v0.27.0` that has never sent a notification already exports
**`alertmanager_notifications_total` at 0 for all 13 integrations and
`alertmanager_notifications_failed_total` at 0 for all 13 integrations x all 5 reasons (65
series)**, with HELP and TYPE. The label cross-product is registered at start-up, not lazily on
first use, and it is not restricted to the integrations the config names. **So `increase(...) > 0`
is armed on a fresh deployment and needs no `or on() vector(0)` term and no `absent()` leg.**
(Contrast D11's watcher and `alerts.yml`'s scheduler leg, where the series genuinely can be
absent — the difference is which process owns the metric.)

**The rule deliberately does not filter on `reason`, and that is now a decision rather than an
omission.** A refused SMTP dial — the single likeliest real failure, a smarthost that stops
answering — is bucketed as **`reason="other"`**, not `serverError` and not `clientError`. A rule
filtered to the "error-looking" reasons would miss it entirely.
- **The genuinely out-of-band answer is E-16's watchdog plus a deadman's switch, and both belong to
  11b**, where a second machine exists to host them. Booked below rather than half-built here — and
  a deadman's switch that depended on an external ping provider would also breach the portability
  constraint (spec v4.7, GC14), which is a decision for the owner to make deliberately rather than
  inherit from a hardening plan.

**A fourth rule was considered and rejected**: `absent(up{job="alertmanager"})`, on D11's
negative-space reasoning. It is redundant here — a scrape target that has never been scraped makes
`up` absent, but `alerts-meta.yml` is installed in the same commit as the scrape job, so the only
way to reach that state is a `prometheus.yml` that loads the rules and omits the job. **D8's leg 2
makes that a build failure instead of a silent gap**, which is a stronger answer than a rule.
**Measured for completeness** (spike Question C.3): `up` for a target that has never been scraped is
**genuinely absent** — an `/api/v1/query?query=up` one second after start-up returned `result: []` —
and becomes `0` only when the first scrape *completes*, which for an unreachable target costs a full
`scrape_timeout` (10 s) after a scrape offset anywhere in `[0, scrape_interval)`. On this box that
is a window of up to ~25 s after any Prometheus restart. `HmisAlertmanagerDown`'s `for: 5m` covers
it with two orders of magnitude to spare, **so the rejection stands — but the state is real, not
hypothetical.**

### D8. `deploy.sh`'s two hand-maintained lists become ONE tested invariant (§2.77's rule, promoted)

The third §2.77 specimen — postgres-exporter omitted from the restart loop, D11's watcher inert
after a clean deploy — was fixed at the root in `ea4da87`, **and the rule it earned was written
into a source comment**:

> *"every service whose config directory step 2 installs must appear in this loop"*
> — `docker/prod/deploy.sh`, above the loop at `:432`

**§3.46 is the entry that says a hand-off written in a source comment reaches nobody**, and this
one guards the difference between a live watcher and an inert one. It becomes
`apps/core/test/deploy-parity.test.ts`, in `caddyfile-parity.test.ts`'s shape, with three legs:

1. **Restart-loop closure** — every **COMPOSE SERVICE** whose config directory step 2 populates
   under `$DEPLOY_DIR/<svc>/` — **by `install -D` OR by rendering** — appears in the
   `for svc in …` loop at `:432`. `caddy` is the one declared exception and the test names its
   reason (it gets an explicit `reload`, which is stronger).

   **AMENDED AT COMPILE 2026-08-24, because the leg as first written would have FAILED against
   correct shipped code** — measured at `84db774`, and the correction is load-bearing in three ways
   a coder cannot infer from the sentence above:
   - **Two `install -D` targets are NOT compose services.** `deploy.sh` installs into
     `$DEPLOY_DIR/pgbackrest/` (`:180`) and `$DEPLOY_DIR/drill/` (`:181`); neither is a service and
     neither belongs in a restart loop. A parser that maps a populated directory to a service name
     demands both join the loop and reports two false failures.
   - **`alertmanager`'s config is RENDERED, not installed.** `install -d` makes the directory at
     `:299` and the config is derived from `.env.smtp` at `:300-328` (Plan 11c D10 — it carries an
     SMTP password and is never committed). A parser keyed on `install -D` misses it entirely and
     reports the loop's `alertmanager` entry as an extra — the third false failure.
   - **The service list cannot come from `deploy.sh`.** It reads `compose config --services` at
     `:453`, which a jest test cannot run; the test parses `docker/prod/docker-compose.prod.yml`
     instead. **The nine services are** `db api worker caddy node-exporter postgres-exporter
     prometheus grafana alertmanager`.

   **Under the corrected wording the invariant closes EXACTLY**, which is what makes it worth
   shipping: populated-and-a-service = `{caddy, prometheus, postgres-exporter, grafana,
   alertmanager}`; the loop = `{prometheus, grafana, alertmanager, postgres-exporter}`; the
   difference is `{caddy}` and it is the declared exception. **Three sources, one census, no
   residue** — and the census pin of leg 3 is what stops a parser going blind and agreeing with
   itself (§2.49).
2. **Rule-file closure, both directions** (MINOR 6) — every path in `prometheus.yml`'s `rule_files`
   exists on disk under `docker/prod/prometheus/`, **and** every rule file on disk is both named in
   `rule_files` and installed by `deploy.sh`. Today that is three files and nothing checks any of
   it; `deploy.sh`'s own comment at `:197-201` is currently doing a test's job in prose.
3. **The census pin** — the counts, stated before anything is compared, so two parsers cannot agree
   vacuously (§2.49). Adding a service or a rule file edits three places in one commit, and the
   number is the deliberate friction that makes the third place unforgettable.

**All three legs parse SHIPPED BYTES, never a restatement.** The test reads `docker/prod/deploy.sh`
and `docker/prod/prometheus/prometheus.yml` from disk exactly as `caddyfile-parity.test.ts` reads
`docker/prod/Caddyfile`; a leg that compared two TypeScript constants would be a fourth copy of the
fact rather than a check on the first three.

### D9. The ops permission MAP gets §3.42's closed shape, all four legs

MAJOR 2: both interface routes are only ever driven by an actor holding all three ops permissions.
The mutant that repointed them to `OPS_MODE_SET` — a real, declared permission — **SURVIVED 6
suites / 71 tests**, while the same mutation on the *kit* decorators **DIED**. §3.42 was applied to
two of three permissions and not the third, and the third is the one that decides when a human is
woken up.

`apps/core/test/billing.e2e.test.ts:525-600` is the closed form of this exact defect and it is what
T4 copies — **four legs, because no three of them catch what the fourth catches**:

1. A `ROUTES` table with a **permission column**, swept by a role-less user, asserting the kernel
   guard's own `missing permission <x>` **by name** per route. (A regression pin on its own: it
   catches a decorator that MOVES, never one that was wrong the day both were written.)
2. **Manifest closure**, both directions: every demanded permission is declared by `opsManifest`,
   and every declared permission guards at least one route. **Ops has no exception** — all three of
   `opsManifest.permissions` guard routes — so `toEqual([])` holds in BOTH directions, making this
   leg strictly stronger than billing's (whose second direction carries `["billing.credit.extend"]`).
3. **The granted direction**: an actor holding all three is refused **for a missing permission** on
   no route in the table. Catches a decorator pointing at an undeclared or misspelt permission that
   legs 1 and 2 would both still pass.
4. **The two-actor map**: one actor holding `{ops.mode.set, ops.downtime.generate}` and another
   holding `{ops.interface.manage}` alone, each refused on the other's routes **by the permission
   name**. This is the leg that kills 11c's surviving mutant, and it is the only one that can.

**The unguarded routes are asserted as unguarded, deliberately.** `GET /ops/mode`,
`GET /ops/config-validation/latest`, `GET /ops/interfaces` and `POST /ops/interfaces/:id/heartbeat`
mint no permission on purpose — the controller header gives the reason (a read permission would
have to be held by every role that ever looks, and a device posting a heartbeat holds nothing). A
route silently *losing* its decorator must fail this test, so the table names those four and
asserts they are authenticated-only rather than omitting them.

### D10. The heartbeat/sweep race — one predicate, and a criterion that protects the legitimate path

MINOR 5, measured 14/15. `sweepInterfaceHeartbeats` (`kernel/ops/interfaces.ts:283`) selects
candidates **outside** any transaction (`:287-297`), then per row opens one and claims with
`where(and(eq(interfaces.id, row.id), eq(interfaces.status, "up")))` (`:309`). A heartbeat landing
between the read and the claim sets `lastSeenAt` and leaves `status` at `up`, so the claim still
matches and a live interface is marked down with a false `interface.down` event.

`recordHeartbeat` (`:197`) already takes `FOR UPDATE` on its side (`:211`), so the two serialise —
they simply serialise on a predicate that cannot see the update that matters. **The fix is one
term: `eq(interfaces.lastSeenAt, lastSeenAt)` in the sweep's conditional update**, so a moved
timestamp loses the claim exactly as a moved status already does.

**MINOR today only because `interface.down` has no alert subscription — and dormant-then-armed:
Plan 11b puts real printers on this seam** (§2.16's arming rule, and the reason this sits in a
CRITICAL task rather than on a deferred list).

**§3.44 applies and the criterion is written before the code:** this fix adds a refusal, so the
task must also assert **the legitimate path is unharmed** — a genuinely stale interface whose
`lastSeenAt` has NOT moved is still downed and its `interface.down` still appends. A guard one term
too wide would leave every stale printer up for ever, and every mutant in the set would still pass,
because they only ever exercise the defect's own path.

### D11. Phase 0 — the L14 census gets its own budget, and the limit is documented

Owner ruling 4. `jest.config.cjs` sets `testTimeout: 15000` for the whole workspace.
`scheduler.test.ts:119` bounds `settleUntil` at 5 000 turns (~5 s), leaving ~10 s for a walk that
**measured 37.6 s on CI against 2.9 s on the build host**. The bound is right; the budget is not.

**The fix is a per-TEST timeout on the L14 census — jest's third argument to `it(...)` — and NOT a
change to `jest.config.cjs`.** §3.44's not-over-broad discipline applied to a test harness: raising
the global timeout would slow every genuine hang across 144 suites from 15 s to a minute and buy
nothing anywhere else. Only the one test that drives real database round-trips under fake timers
gets the longer budget.

**What this does and does not claim.** It does not fix the flake — §2.80's bar is several
consecutive greens across commits touching unrelated files, and it is still unmet. What it buys is
that **a bound hit becomes a diagnosis instead of a timeout**: the set assertion runs and names the
missing jobs. The honest limit already written at `scheduler.test.ts:115-117` stays, extended with
the new number — on a container so starved that the walk alone exceeds the budget, the timeout is a
fact about the harness and no bound changes that.

Phase 0 rather than a task, because it changes what every later CI red in this run MEANS and must
land before the first task commits.

**SHIPPED AT `e88b5db`, and the number is derived rather than chosen: `CENSUS_TIMEOUT_MS =
120_000`.** The arithmetic, measured on the build host at `58e0e61` in isolation: the census walk
costs **3 082 ms** here · §2.80's own pair puts CI at **12.97×** the build host (37.6 s against
2.9 s) · so the walk projects to **~40 s on CI today** · one `settleUntil` turn costs **1.11 ms**
(measured from a 20 000-turn scratch copy: 25 348 ms total − 3 082 ms walk), so a full 5 000-turn
bound hit costs **~5.6 s** · worst case the budget must clear is therefore **~46 s**, and 120 000 ms
clears it by **2.6×**. `jest.config.cjs` was NOT touched.

**The sibling M-S2 test deliberately did NOT get one, and that is a stated decision rather than an
omission** (§3.44's not-over-broad discipline applied to a harness). It measures **483 ms** isolated
against the census's 3 082 ms, its wait is a 400-iteration REAL-timer poll rather than a fake-clock
walk over a compressed 9 h 5 min, and — the reason that actually decides it — **it already fails
with a diagnosis**: the poll exhausts by iteration count at ~2 s and its assertion names what did
and did not run. It needs no larger budget to turn a timeout into a diagnosis. **Disclosed residual:
at 12.97× it projects to ~6.3 s of a 15 s budget, so if CI degrades past ~2.4× its observed worst,
M-S2 is the next bare-timeout candidate** — the second place a future census red should look.

### D12. What this plan deliberately does NOT build, and where each thing went

| deferred | why | where it goes |
|---|---|---|
| HTTP user administration + admin screen | Owner ruling 1. Highest-privilege write in the system; needs §3.42's full treatment, screens, i18n and a credential-reset flow. `auth.users.manage` and `auth.roles.manage` are already DECLARED and guard no route — the seam is waiting. | **Plan 11e**, booked below |
| Password change / credential reset | No flow exists today (`verifyPassword` yes, no setter). D4's refusal-on-change is the correct interim, not a substitute. | **Plan 11e** |
| Out-of-band watchdog + deadman's switch | Needs a second machine, or an external provider that would breach portability (GC14). D7 states the limit rather than half-closing it. | **Plan 11b** (E-16) |
| A `scheduler.test.ts` redesign | Owner ruling 4 chose the timeout. Seven ledger entries say the design is the real answer, and that is a plan-sized change to a file four plans have touched. | Booked; trigger is the next census red that is a SET MISMATCH rather than a timeout |
| Any schema change | Nothing here needs one. **GC3 makes a `drizzle/` diff a halt**, which removes AGENT-RULES §6's whole irreversible-mutation hazard class from this run. | n/a |
| Repairing production's grants by hand | The fix is the script, run as a deploy step. A hand-written `INSERT` would leave production in a state no script reproduces. | flag ③ |

**Plan 11e — user administration (booked, not written).** Trigger: the pilot has staff and the
owner needs to add, disable or re-role one without an ssh session. Scope sketch, so the next writer
starts from something: `POST /admin/users` · role assign/revoke · PIN reset · deactivate ·
force-password-change on first login · the admin screen · `auth.users.manage` and
`auth.roles.manage` finally guarding routes · and §3.42's four legs from day one, because a
permission-map defect on THIS controller is a privilege-escalation defect rather than a 403.

---

## Consumed shipped surfaces (transcribed from source at `78b0a3d`, 2026-08-24, this session)

Every line below was read from the tree, not recalled. **Line numbers expire the moment Phase 0
lands (§2.73/§2.78) — Phase 0 touches `scheduler.test.ts` only, so every reference here except that
file's survives it; re-resolve and navigate by SYMBOL regardless.**

**`apps/core/src/kernel/auth/permissions.ts`** — `syncPermissions(db, registry)` `:11` upserts
`permissions` rows only · `createRole(db, key, title)` `:25` is a **bare insert and is NOT
idempotent** (`seed-ops.ts` guards it with an existence check at `:81`) · `grantPermissionToRole(db,
registry, roleKey, permission)` `:29` throws `unknown permission "<x>"` for anything
`registry.allPermissions()` lacks, then inserts `onConflictDoNothing` · `assignRole(db, {userId,
roleKey, scopeType, scopeId?})` `:43` throws unless `scopeType === "hospital"` or a `scopeId` is
given, returns `{id}` · `hasPermission(...)` `:63` is what `PermissionGuard` reads.

**`apps/core/src/kernel/auth/identity.ts`** — `createUser(db, {username, fullName, password,
pin?})` `:18` returns `{id}`; argon2id at `memoryCost 19456 / timeCost 2 / parallelism 1` `:11-15`;
`pinHash` is `null` when no pin is supplied · `verifyPassword(db, username, password)` **`:35`**
returns `{userId}` or `null` and refuses an inactive user · `setPin(db, userId, pin)` **`:47`** ·
`verifyPin(db, userId, pin)` **`:52`** · `rotateBadge` **`:59`**. **`setPin` and `rotateBadge` have
ZERO non-test callers.**

> **CORRECTED AT COMPILE 2026-08-24 (§2.78), re-resolved at `84db774`.** This document was written
> with `:34 / :46 / :51 / :58` for those four — **each off by one**, and `identity.ts` has not
> changed since `78b0a3d`, so the transcription was simply wrong rather than stale. The argon2id
> parameters are at `:13-15`, not `:11-15`. Nothing downstream breaks (T2 is briefed to navigate by
> SYMBOL, which is precisely why §2.78 says to), but **a coordinate that was never right is worse
> than one that expired**: the expired kind announces itself when the file moves, and this kind does
> not.

**`apps/core/src/kernel/workflow/roles.ts`** — `usersHoldingRole(tx, roleKey)` is **Tx-typed**;
`seed-ops.ts:93` and `alerts/consumer.ts:153` both wrap it in `withTx`.

**`apps/core/src/kernel/db/client.ts`** — `withTx<T>(db, fn)` `:14` is `db.transaction(fn)` and
nothing else.

**`apps/core/src/kernel/ops/mode.ts`** — `getOperatingMode(exec: Db | Tx)` `:61`, `orderBy
desc(seq)`, zero rows → `"commissioning"` · `changeOperatingMode(tx, actor, input, now = new
Date())` `:112`, Tx-typed, four refusal codes in the order commissioning-is-initial-only `:119` →
`mode_unchanged` `:128` → `mode_note_required` `:133` → `golive_gate_unsatisfied` `:141` · the
read is `:127`, the insert `:144`, the event append `:154`, payload
`{from, to, note, reportId}` `:161` · `VALIDATION_FRESH_HOURS = 24` `:18` ·
`MODES_REQUIRING_NOTE = ["downtime", "degraded"]` `:24`.

**`apps/core/src/kernel/ops/interfaces.ts`** — `recordHeartbeat(db, actor, id, now)` `:197` opens a
tx, `select … for("update")` `:207-211`, claims `down → up` `:217-221`, falls through to an
unconditional `status:"up", lastSeenAt:now` update `:227` · `sweepInterfaceHeartbeats(db, now)`
`:283` selects candidates OUTSIDE a transaction `:287-297` (`active = true AND status = 'up' AND
last_seen_at IS NOT NULL`, `order by seq`), skips fresh rows `:303`, then per row opens a tx and
claims on `(id, status = 'up')` `:309`.

**`apps/core/src/kernel/ops/manifest.ts`** — `OPS_MODE_SET = "ops.mode.set"`,
`OPS_DOWNTIME_GENERATE = "ops.downtime.generate"`, `OPS_INTERFACE_MANAGE = "ops.interface.manage"`;
`opsManifest.permissions` is exactly those three; `subscriptions: []`; two menu entries.

**`apps/core/src/kernel/ops/ops.controller.ts`** — `@Controller("ops")` `:145`. Guarded:
`POST mode` `:196-197` and `POST config-validation` `:225-226` on `OPS_MODE_SET` · `POST interfaces`
`:272-273` and `POST interfaces/:id/deactivate` `:284-285` on `OPS_INTERFACE_MANAGE` ·
`POST downtime-kits` `:337-338`, `GET downtime-kits` `:352-353`, `GET downtime-kits/:id` `:366-367`
on `OPS_DOWNTIME_GENERATE`. **Unguarded (authenticated-only, by design):** `GET mode` `:169`,
`GET config-validation/latest` `:232`, `GET interfaces` `:262`, `POST interfaces/:id/heartbeat`
`:298`. **ELEVEN routes, seven guarded, four unguarded; T4's table states the
census before it compares anything.**

**`apps/core/src/app.module.ts:46-61`** — `registry.install(...)` for `authManifest`,
`workflowManifest`, `approvalsManifest`, `patientsManifest`, `tariffManifest`, `opdManifest`,
`billingManifest`, `alertsManifest`, `opsManifest`. **Nine.**

**Manifest permission counts, read from each file:** auth 6 (`auth.users.manage`,
`auth.roles.manage`, `auth.agents.manage`, `auth.break_glass.use`, `auth.break_glass.review`,
`auth.temp_role.grant`) · workflow 8 · approvals 4 · patients 5 · tariff 5 · opd 14 · billing 14 ·
ops 3 · alerts **0** and notify **0**, both deliberately (their headers say why). **T1 re-derives
these at compile and quotes the greps; the numbers here are a census with an expiry date.**

**`apps/core/scripts/seed-ops.ts`** — the shape T1 and T2 copy: header explaining WHY, `ensureRole`
guarding the non-idempotent `createRole` `:79-84`, `assignAll` throwing on an unknown username
`:96-101`, holder counts and a `READY` / `!! NOT READY` verdict as the last line. **Proven
idempotent on the live box (gate report ADDENDUM 2).**

**`apps/core/src/modules/opd/config.ts:75-86`** — `OPD_ROLE_KEYS` is **ten** entries:
`front_office`, `front_office_supervisor`, `vitals_desk`, `nurse`, `doctor`, `opd_admin`,
`display`, `duty_manager`, `owner`, `medical_superintendent`. **`pharmacy` is NOT among them**,
and it IS a column in the README's permission table. `seed-opd.ts:22` inserts all ten
`onConflictDoNothing`. **T1 IMPORTS this constant and does not modify it** — reading a frozen
module is not a scope violation, and GC13 freezes writes, not imports.

**`apps/core/test/billing.e2e.test.ts:45` and `:525-600`** — the `ROUTES` triple table and the four
legs D9 copies, including the exact assertion shapes (`toEqual` on `{method, path, status,
message}`; `refusedForPermission` computed from `message.startsWith("missing permission ")`).

**`apps/core/test/caddyfile-parity.test.ts:1-40`** — `readFileSync` + `resolve(__dirname, "..",
"..", "..")` to reach `docker/prod/`; both parsers **throw** on an unrecognised shape; a census
pinned before comparison. The precedent D3 leg (b) and D8 copy.

**`docker/prod/prometheus/prometheus.yml`** — `rule_files:` names `alerts.yml` `:21` and
`alerts-backup.yml` `:27` · `alerting:` targets `alertmanager:9093` `:41-43` · `scrape_configs`
`:45-63` are `prometheus` (127.0.0.1:9090), `node`, `postgres` (`honor_labels: true`). **No
alertmanager scrape job.**

**`docker/prod/deploy.sh`** — installs at `:173`, `:178`, `:180-182`, `:195-196`, `:202-208`,
`:299` (the alertmanager directory + rendered config) · the restart loop is
`for svc in prometheus grafana alertmanager postgres-exporter` `:432-437` · the SMTP six-key
pre-flight dies at `:290-297` · step 6b asserts the whole declared service SET `:458-475`.

**`apps/core/jest.config.cjs`** — `testTimeout: 15000`, `testMatch` covers `**/test/**` and
`**/src/**`, `moduleNameMapper` pins `@hmis/contracts` to source.

**`apps/core/package.json` scripts** — `seed:admin`, `seed:registration`, `seed:tariff`, `seed:opd`,
`seed:billing`, `seed:ops`, `validate:config`, `validate:billing`, `validate:tariff`, `agent:create`.
**T1 adds `seed:roles`; T2 adds `seed:staff`. No other line moves.**

---

## Global Constraints

1. **No new npm dependency; a `pnpm-lock.yaml` diff anywhere is a halt.** Nothing here needs one —
   the role model is a table, the roster is JSON on stdin, and the rules are a YAML file.
2. **NO MIGRATION AND NO SCHEMA CHANGE. A `drizzle/` diff anywhere is a HALT**, in either
   direction. `0018` is not this plan's. This removes AGENT-RULES §6's entire irreversible-host-
   mutation hazard class from the run, and it is the cheapest safety this plan gets.
3. **No secret in git, ever** (GC2 inherited, and the repo is PUBLIC): no password, no PIN, no
   roster, no SMTP host, no owner email. The roster reaches `seed:staff` on **stdin** and is never
   written to the box (D4). **The seed's own OUTPUT is asserted secret-free by execution** (V9).
4. **`apps/web` is FROZEN IN FULL.** This plan ships no screen, no route, no locale key. A diff
   under `apps/web/` is a scope violation regardless of how correct it looks.
5. **No behaviour change to any existing route's RESPONSE SHAPE.** T4 adds assertions about
   permissions; it changes no decorator. If T4's table and a decorator disagree, **the decorator is
   the fact and the disagreement is a finding**, routed to the inbox — never a decorator edit
   inside a test task.
6. **Retention semantics untouched**: nothing here reads or changes `RETENTION_ENABLED`, the sweep,
   or the holds.
7. **Every clock-reading function keeps its injected `now: Date = new Date()`** (08.5 GC9/10); no
   fixture derives from the wall clock (§3.31/§3.41).
8. **Concurrency rows are MEASURED, and the stated run count is a FLOOR, not a target** (§3.22,
   AGENT-RULES §2.3): report the OBSERVED rate, keep running if the window has not opened, and
   never engineer the window. Rule 20 applies — confirm nothing else is running first, and **read
   the matched command lines, never the count**.
9. **Workspace totals never decrease; no test deleted** (AGENT-RULES §4); no per-task count targets.
10. **Every seed script is IDEMPOTENT and says so by execution.** Run twice in the same task; the
    second run must exit 0 and report "already" for everything it did the first time. `createRole`
    is a bare insert and is NOT idempotent on its own — guard it, as `seed-ops.ts:79-84` does.
11. **Production containers**: rule 7 as amended governs. **T5 is the ONLY task authorized to act on
    `hmis-prod`, and only for a `promtool` run inside a throwaway container** (§2.71's named-owner
    rule). **The DEPLOY itself is NOT in this pipeline** — it is an owner-authorized step in the
    execute prompt's Phase 5, because 11c's T6 was blocked twice for exactly this reason.
12. **Infra work is verified by drills that actually ran**; transcripts go in the gate report.
13. **Frozen unless a Files list names it** (GC13 inherited and extended): the dispatcher, the
    notify pump and gauntlet, the retention sweep, everything under
    `modules/billing|tariff|patients|opd`, `caddyfile-parity.test.ts`, `alerts-parity.test.ts`,
    `alerts.yml`, `alerts-backup.yml`, the dev compose, `.github/workflows/*` (rule 10), and
    **`jest.config.cjs`** (D11 — the timeout is per-test, never global).
14. **Portability (spec v4.7)**: nothing provider-specific. The three new alert rules read metrics
    two shipped containers already expose; no external ping service, no hosted watchdog.
15. **A parser in a parity test THROWS on a shape it does not recognise, and the test pins a CENSUS
    before it compares anything** (§2.49). Two parsers that both return `[]` agree forever.

---

## File Structure (locked; the frozen-path block is GENERATED from these lists — §2.25)

```
apps/core/
  src/kernel/worker/scheduler.test.ts           R0-1 (per-TEST timeout on the L14 census + the limit comment)
  src/kernel/modules/manifests.ts               T1 create (ALL_MANIFESTS — the one list, D2)
  src/kernel/modules/manifests.test.ts          T1 create (V4: app.module parity, worker subset stated)
  src/app.module.ts                             T1 (consume ALL_MANIFESTS — the install block ONLY, lines 46-61)
  scripts/seed-roles.ts                         T1 create (the nine roles + grants, D3)
  test/seed-roles.test.ts                       T1 create (V1-V3, V5: manifest closure, README parity, idempotence)
  scripts/seed-staff.ts                         T2 create (users + PINs + role assignment from stdin, D4)
  test/seed-staff.test.ts                       T2 create (V6-V9)
  package.json                                  T1 ("seed:roles" line ONLY) · T2 ("seed:staff" line ONLY)
  src/kernel/ops/mode.ts                        T3 (advisory lock first; changeId on the payload)
  src/kernel/ops/mode.test.ts                   T3 (V10, V11, V12b)
  src/kernel/ops/events.ts                      T3 (modeChanged payload gains changeId — that field ONLY)
  src/kernel/alerts/consumer.ts                 T3 (changeId on the payload — SHIPPED) ·
                                                T4 (the refId repoint — CHAIN-HALTED out of T3, see below)
  src/kernel/alerts/consumer.test.ts            T3 (V13)
  test/ops-lifecycle.e2e.test.ts                T4 (the ROUTES table and D9's four legs, PLUS
                                                leg 4's `refId` assertion — the other half of D6)
  test/deploy-parity.test.ts                    T5 create (D8's three legs)
  src/kernel/ops/interfaces.ts                  T6 (the lastSeenAt predicate — that term ONLY)
  src/kernel/ops/interfaces.test.ts             T6 (V20, V21)
  src/kernel/ops/ops.controller.ts              T6 (the stale "admin holds every manifest permission" comment, §2.60)
docker/prod/
  prometheus/prometheus.yml                     T5 (the alertmanager scrape job + alerts-meta.yml in rule_files)
  prometheus/alerts-meta.yml                    T5 create (D7's three rules)
  deploy.sh                                     T5 (install alerts-meta.yml — one line, in step 2's block)
README.md                                       T1 (the OPD/billing runbook steps gain their command) ·
                                                T2 (the staff-account step) · T5 (the alert-path monitoring section)
```

**Everything not listed is frozen to this plan (GC13).** Note the three files with more than one
owner and their strict order: `package.json` T1 → T2 (one line each, enumerated — never "change
nothing else", §2.72) and `README.md` T1 → T2 → T5 (three disjoint sections, each named).

---

## Phase 0 — before the pipeline (one commit, after the spike, before compile)

**R0-1 — the L14 census gets its own timeout (D11).** `scheduler.test.ts` only: jest's third
argument on the census `it(...)`, the existing honest-limit comment at `:115-117` extended with the
new number and with what a bound hit now produces, and **nothing else in the file moves**. Then
`pnpm verify` on the build host detached with the exit VALUE read from a file, and **CI checked by
FULL SHA before the pipeline compiles** — Phase 0 exists to make later reds readable, so a Phase 0
whose own CI state is unknown defeats itself.

**§2.73/§2.78 apply to this commit specifically:** it moves lines in `scheduler.test.ts`. No task in
this plan references that file, so nothing downstream goes stale — **but re-run the check rather
than trusting this sentence**, and confirm the `--stat` names exactly one file.

## Tasks

### Task 1: `ALL_MANIFESTS`, `seed:roles`, and the reachability invariant *(CRITICAL, opus coder + opus gate)*

D1+D2+D3. Create `kernel/modules/manifests.ts` exporting `ALL_MANIFESTS` (the nine
`app.module.ts:46-61` installs, in that order) and repoint `app.module.ts`'s install block at it —
**that block only; the module's providers, imports and everything else are untouched.** Create
`scripts/seed-roles.ts` in `seed-ops.ts`'s shape: install `ALL_MANIFESTS`, `syncPermissions`,
`ensureRole` for the nine roles of D3's table, grant per the model, report holders per role and
finish with a readiness verdict line. Add the `seed:roles` script line. Correct the README's OPD
runbook step 2 (`README.md:229`) and the billing table's surrounding prose so each names the command
that now performs what they instruct.

**The tests are the deliverable as much as the script is** (`test/seed-roles.test.ts`): manifest
closure both directions with the exceptions list and its reasons (V1, V2), README parity cell for
cell with both parsers throwing and the census pinned first (V3), and idempotence by executing the
seed twice (V5). `manifests.test.ts` carries V4.

**Halt conditions.** ~~If the spike's Question B shows production's `admin` already holds more than
`auth.*` + `ops.*`, STOP and report.~~ **DISCHARGED 2026-08-24 by measurement (§B-MEASURED): `admin`
holds exactly nine — six `auth.*`, three `ops.*` — and fifty declared permissions are held by
nobody. The premise held; this task ships at full size.** If any README cell names a permission no manifest declares, that is a
**finding about the README**, routed to the inbox with the cell quoted; the seed follows the
manifests and says so in its report.

### Task 2: `seed:staff` — the deployment can be given its humans *(CRITICAL, opus coder + opus gate)*

D4. Create `scripts/seed-staff.ts`: read a JSON roster from **stdin**, validate it with zod before
touching the database, and per row create the user through the shipped `createUser` (with `pin` when
given), then `assignRole` at hospital scope for each named role. Refuse — loudly, before any write —
on an unknown role key, on a role `seed:roles` has not created, and on an existing username whose
password differs from the roster's. Print a **secret-free** roster report and a readiness verdict.
Add the `seed:staff` script line and the README's go-live account step.

**Read `seed-ops.ts` first and copy its discipline, not just its shape:** the header that explains
why the script exists, the existence-guard around non-idempotent primitives, the hard error on a
username that does not resolve, and a last line that states readiness rather than implying it.

**Criteria that are not mutants and are still required.** The roster schema is validated WHOLE
before the first write — a half-provisioned roster is worse than a refused one. No password and no
PIN reaches any log, any error message, or the report. A row that already exists in full is
reported as `already` and re-assigns nothing.

### Task 3: The mode ledger serialises, and its event can be deep-linked *(CRITICAL, opus coder + opus gate)*

D5+D6. `pg_advisory_xact_lock(hashtext('hmis.operating_mode'))` as the FIRST statement of
`changeOperatingMode`, before `getOperatingMode(tx)` — with D5's reasoning transcribed above it in
the source, because the next reader must be able to see why it is `_xact_` and why it is first. Add
`changeId` to the `ops.mode_changed` payload in `kernel/ops/events.ts` and repoint the alerts
consumer's `refId` at it (that branch only; `raiseAlerts` untouched).

**The Book rows here are the plan's most expensive and its most important**: V10 is a measured race
over ≥15 rounds reproducing the gate report's three cases, V11 proves the lock's POSITION and not
merely its presence, V12b kills the commissioning-bypass prediction 11c's inbox left standing, and
V13 pins the new `refId`.

**THE PAYLOAD-SHAPE READERS, ENUMERATED AT COMPILE (§2.72 — never "change nothing else"), because
adding `changeId` BREAKS TWO SHIPPED ASSERTIONS AND STALES A TEST NAME.** Measured at `e88b5db` by
grepping every reader of the payload across `apps/core`, `apps/web` and `packages`:

- **`kernel/ops/mode.test.ts:350-351` pins the payload with STRICT `toEqual`** —
  `toEqual({ from: "commissioning", to: "normal", note: null, reportId })` and its `downtime`
  sibling. **Both fail the moment `changeId` exists.** T3 owns this file: EXTEND both to carry the
  new field. This is a required edit, not collateral damage.
- **That test's own NAME goes stale** — *"carrying from/to/note/reportId and no patient"*. Correct
  it in the same commit (§2.60: a stale sentence beside correct code is how MAJOR 4 shipped).
- **`kernel/alerts/consumer.ts:250` is the single line to repoint** — it currently reads
  `refId: payload.to`, which is the mode WORD where its two neighbours carry an entity id.
- **`apps/web` reads this payload NOWHERE — grep returns zero hits**, so GC4's full freeze survives
  T3's widening. Confirmed rather than assumed; a payload widened under a frozen consumer would have
  been a HALT.
- `kernel/ops/manifest.ts:18` and `db/schema/ops.ts:33` mention `ops.mode_changed` in COMMENTS only,
  and `kernel/ops/validate.test.ts:437` asserts `opsManifest.subscriptions` is empty — none reads
  the payload, none is affected, none is in T3's Files list.

**Halt condition.** ~~If the spike's Question A shows `withTx` does not hold one client for the
transaction, or that the loser does not block, **STOP**: the fix named here is wrong and the plan
needs a different one.~~ **DISCHARGED 2026-08-24 — Question A MEASURED, all five sub-questions, each
against a control (see D5). `withTx` holds one backend, the loser blocks ~203 ms where the no-lock
control waits 0 ms, and a thrown error releases the lock. The fix named here is correct and T3
proceeds at full size.** The standing prohibition survives the discharge: **do not substitute a
session lock, a `FOR UPDATE`, or a retry loop on your own authority.**

### Task 4: The ops permission MAP — §3.42's four legs *(CRITICAL, opus coder + opus gate)*

> **T4 INHERITS THE OTHER HALF OF D6 — routed here by a CHAIN HALT that T3 raised correctly, and
> the miss was the compile sweep's, not T3's.** The sweep enumerated every reader of the
> `ops.mode_changed` PAYLOAD and found them all. It did not enumerate readers of **the value that
> payload produces two hops downstream** — the alert's persisted `refId`. There is exactly one, and
> it was frozen to T3: `test/ops-lifecycle.e2e.test.ts:319` pins `refId: "downtime"` inside leg 4's
> `toMatchObject`. T3 built the full repoint, ran it, and MEASURED the break rather than predicting
> it — `- "refId": "downtime"` / `+ "refId": "01M0QE1XGG08TFPCMBC9E7HSM0"` — then backed the repoint
> out under AGENT-RULES §3(a) and shipped D6's payload half alone. **That is the behaviour
> EXECUTE-METHOD §6 says not to touch.**
>
> **So T4 lands ~~two lines~~ THREE lines across THREE files, and they must land in ONE commit or
> the suite is red between them:**
> 1. `src/kernel/alerts/consumer.ts` — `refId: payload.to` → `refId: payload.changeId`. **That
>    branch ONLY; `raiseAlerts` is untouched.** T3 left a signpost in `OPERATING_MODE_REF_TYPE`'s
>    header naming this blocker — **delete the signpost as you land the fix**, or it becomes a
>    §2.60 stale sentence beside correct code.
> 2. `test/ops-lifecycle.e2e.test.ts` leg 4 — `refId: "downtime"` → the `operating_mode_changes`
>    row id, asserted by **whole-string equality against the id read back from the table**, never
>    against a hardcoded ULID.
> 3. **`src/kernel/alerts/consumer.test.ts:659` — `expect(row.refId).toBe("downtime")`, plus the
>    four-line comment above it that says "when the two-line repoint lands".** FOUND BY T3'S GATE,
>    which built the repoint and ran it: it breaks **TWO** assertions, not one. This file's other
>    signpost undercounts for the same reason `consumer.ts`'s does.
>
> **THE UNDERCOUNT IS THIS SESSION'S DEFECT, TWICE OVER, AND IT IS THE SAME DEFECT BOTH TIMES.**
> The compile sweep walked the payload's readers; T3's halt taught it to walk the *assert-on* graph
> as well; and the first amendment then walked that graph **one hop and stopped**, missing a reader
> that sits in the widening task's OWN file. **The assert-on graph must be walked transitively and
> to a fixpoint, and it must include assertions the widening task ADDED IN THE SAME COMMIT** — the
> third reader here did not exist when the sweep ran, because T3 wrote it while raising the halt.
>
> **This also completes Book row V13**, whose Book mutant ("revert `refId` to the mode word") could
> not fail while the halt stood — the shipped code WAS that mutant. Build it after the repoint.

D9, in `test/ops-lifecycle.e2e.test.ts`. **Apart from that two-line D6 completion, this task changes
no production code at all** (GC5): if a decorator and the table disagree, the decorator is the fact
and the disagreement is a finding.
Build the `ROUTES` table from the decorators — eleven routes, seven guarded, four unguarded, the
census asserted before anything is compared — then the four legs of D9.

**The task is not done until the mutant that SURVIVED in 11c has DIED here**: repoint both interface
decorators to `OPS_MODE_SET` in a scratch copy beside the source, run this suite, and quote
`Expected "missing permission ops.interface.manage"` against what the mutant produced. A green suite
against that mutant means the legs are not yet discriminating, whatever else passes.

### Task 5: The alert path watches itself, and `deploy.sh`'s lists become one invariant *(CRITICAL, opus coder + opus gate — infra drills)*

D7+D8. Add the `alertmanager` scrape job to `prometheus.yml`, create `alerts-meta.yml` with D7's
three rules, add its one `install` line to `deploy.sh`'s step 2 and its path to `rule_files`, and
create `test/deploy-parity.test.ts` with D8's three legs. Extend the README's monitoring section
with the alert-path rules **and with D7's limit stated in the owner's terms** — what the owner will
and will not be told when the sink itself breaks.

**`promtool` is the proof and both directions are required** (flag ④): every rule fires on its
synthetic input and **none fires on healthy input**. Build the rule-file mutants the way 11c's T6
did unprompted — widen a threshold, and separately break a rule in a way only the negative control
can see.

**Rule 7 boundary, in as many words:** you may run `promtool` in a throwaway container under a
`hmis-drill` project that you remove before you report. **You may NOT run `deploy.sh`, restart any
`hmis-prod` service, or otherwise act on the production stack.** The deploy is the owner's to
authorize and it happens after this pipeline (execute prompt, Phase 5).

### Task 6: The heartbeat/sweep race, and one stale sentence *(CRITICAL, opus coder + opus gate)*

D10. Add `eq(interfaces.lastSeenAt, lastSeenAt)` to the sweep's conditional update. V20 is the
measured race (≥15 rounds, the 14/15 window reproduced against the mutant); **V21 is §3.44's
not-over-broad criterion and it is not optional** — a genuinely stale interface is still downed and
still appends `interface.down`.

Also correct `ops.controller.ts`'s comment claiming *"the seeded `admin` holds every manifest
permission in dev"* (§2.60 — a downstream reader believed exactly this sentence's README twin, and
that is how MAJOR 4 shipped). Replace it with what is true after T1: `admin` holds what `seed:admin`
and `seed:ops` grant, and `seed:roles` is what makes the module permissions real.

## Commit messages — one per task, exact (AGENT-RULES §5 step 1 resolves here)

| | message |
|---|---|
| R0-1 | `test(core): the L14 census gets its own timeout — a bound hit must name the missing jobs, not report a bare timeout` |
| T1 | `feat(core): seed:roles and ALL_MANIFESTS — every declared permission is now reachable by some role, and a test says so` |
| T2 | `feat(core): seed:staff — a deployment can be given its humans, from stdin, with no credential left on the box` |
| T3 | `fix(core): the mode ledger takes an advisory lock before it reads — two concurrent declarations can no longer both win` |
| T4 | `test(core): the ops permission map, all four legs — the mutant that survived Plan 11c now dies` |
| T5 | `feat(infra): the alert path is watched, and deploy.sh's two lists become one tested invariant` |
| T6 | `fix(core): a heartbeat landing mid-sweep no longer loses to a false interface.down` |

## Assertion Book — predictions until executed; the verdict column is filled by the shipping task

Rows marked **P** carry inputs the task must confirm by building the mutant and watching it die
(rule 21). Rows marked **M** are measurements over a floor of runs, not single mutants.

| # | task | assertion | killing mutant | discriminating input | P/M |
|---|---|---|---|---|---|
| R1 | R0-1 | A `settleUntil` bound hit produces the SET assertion naming the missing jobs, not a bare timeout | ~~force the bound to 1 turn in a scratch copy~~ **CORRECTED AT PHASE 0 — that mutant is a NO-OP and SURVIVES.** The mutant that discriminates is TWO-PART: **(a) make the census UNSATISFIABLE** so the poll actually reaches its bound, **and (b) force the bound ABOVE the old 15 000 ms budget** (20 000 turns ≈ 22 s) | **MEASURED at `e88b5db`, both arms, exit VALUE 1 each.** OLD 15 s budget → `Exceeded timeout of 15000 ms` at `(15406 ms)` with **no job name anywhere in the failure** (the `console.warn` does print, but AFTER teardown, beside `ReferenceError: … after it has been torn down`). NEW 120 s budget → `(25348 ms)` and the SET assertion runs: `- "runNotifyPump"` / `- "sweepExpiredTempRoles"` — **the two jobs CI actually lost.** · **Why the Book's version is a no-op:** on a healthy box every job is already recorded by the time `settleUntil` is reached, so `done()` is true on turn 0, the bound is never touched, and the test PASSES at exit 0 under BOTH budgets (measured: `3069 ms` old, `2967 ms` new). A mutant that cannot fail is not a mutant. **The mutant is still the BOUND, not the machine** — starvation cannot be manufactured on a box serving a hospital, which is exactly why (a) is needed to reach the bound at all | **P** |
| V1 | T1 | Every granted string is DECLARED by an installed manifest | one typo'd cell in the role model | `"billing.invoice.isue"` in `cashier` → shipped: the test names the undeclared string; unmutated control: nine roles green | |
| V2 | T1 | Every declared permission is held by at least one role or NAMED in the not-yet-modelled list | delete `cashier`'s `billing.receipt.record` grant | shipped: the census names the orphaned permission; control: **the SEVENTEEN not-yet-modelled strings pass — `workflow.*` 8, `tariff.*` 5, `patients.merge`, `patients.confidential.read`, `approvals.types.manage`, `approvals.requests.create` — and their REASONS are asserted present, not merely their names.** ~~the three real exceptions (`auth.users.manage`, `auth.roles.manage`, `billing.credit.extend`)~~ **CORRECTED AT COMPILE: those three are all HELD (admin holds both `auth.*`; the billing table grants `credit.extend` to `cashier`), so as controls they proved nothing — they were justified by "guards no route", which is a DIFFERENT property from the one this row asserts.** Second mutant, and it is the one that matters: **move one string from the model into the not-yet-modelled list** → the census counts (39 held / 17 not-yet-modelled) fail before any reason is read, which is the §2.49 leg that stops the list becoming a place to hide an orphan | **P** |
| V3 | T1 | The README's two tables and the role model agree, cell for cell, both directions, **over the table-derived subset** — and the eight `patients.*` pairs of owner ruling 7 are pinned by their own leg with the README prose quoted as their reason | flip one tick in the seed's table; **and separately, delete one `patients.*` pair** → the ruling-7 leg names it while the table-parity leg stays green, proving the two legs are independent | shipped: parity fails naming the (role, permission) cell; a second mutant on the PARSER (return `[]` instead of throwing) → the census pin fails first, which is the §2.49 leg | **P** |
| V4 | T1 | `ALL_MANIFESTS` equals what `app.module.ts` installs | add a tenth install to `app.module.ts` only | shipped: the parity test names the extra manifest; control: the worker's smaller set is asserted a SUBSET and does not fail | |
| V5 | T1 | `seed:roles` is idempotent | drop `ensureRole`'s existence guard | run twice against one database → shipped: the second run exits 0 reporting `already`; mutant: duplicate-key error on `roles` | |
| V6 | T2 | A roster row yields a working password AND a working PIN | drop the `pin` from the `createUser` call | shipped: `verifyPassword` true and `verifyPin` true; mutant: `verifyPin` false with `verifyPassword` still true — so the control isolates the PIN leg rather than the row | |
| V7 | T2 | An unknown role key is a hard refusal BEFORE any write | skip the unknown key silently | a roster with one good row and one bad role key → shipped: exit non-zero and **zero users created**; mutant: one user exists holding nothing, exit 0 | **P** |
| V8 | T2 | An existing username with a DIFFERENT password is refused, never overwritten | make the update unconditional | seed, then re-seed the same username with a new password → shipped: refused, and `verifyPassword` still accepts the ORIGINAL; mutant: the original stops working — a live user locked out with nobody watching | **P** |
| V9 | T2 | No password and no PIN appears in stdout or stderr | log the roster row on error | drive a failing row whose password is a distinctive sentinel → shipped: the sentinel appears in neither stream; mutant: it appears. **Assert on the CAPTURED STREAMS, never on a return value** | **P** |
| V10 | T3 | Concurrent declarations SERIALISE — one wins and the loser sees the winner | drop the advisory lock | ≥15 rounds per case (a floor, §3.22), the gate report's three: **A** two identical `normal→downtime` · **B** concurrent `→downtime` / `→degraded` · **C** two concurrent go-live exits. **SHIPPED + MEASURED at `4daacf4`, 15 rounds each: A 15/15 `appended=1` · B 15/15 `departingNormal=1, chained=true` · C 15/15 `commissioningExits=1`. Mutant: A **14/15** — identical to 11c's own measurement — B 15/15 `departingNormal=2, chained=false`, C 15/15 `commissioningExits=2`.** · ~~shipped: exactly one appended row per round in all three~~ **CORRECTED IN-TASK: that phrase is FALSE for case B and cannot be made true. The loser there is not refused — it re-reads the winner's state and `downtime → degraded` is a LEGAL transition, so two rows is the CORRECT outcome (V11's own row already says "refused, **or appends from the winner's state**"). The discriminating invariant for B is ONE ROW PER PREDECESSOR STATE — `departingNormal=1` plus chain well-formedness — which is strictly stronger and which both mutants break.** | **P/M** |
| V11 | T3 | The lock is taken BEFORE the read, not merely somewhere in the function | move the lock to after `getOperatingMode(tx)` | case B specifically → shipped: the loser is refused or appends from the winner's state; mutant: **both succeed and `current` disagrees with what one caller was told** — the identical symptom the unlocked code has, which is why presence alone is not the assertion | **P** |
| V12b | T3 | The commissioning gate covers EVERY exit, so `commissioning → downtime → normal` is not a bypass | narrow the guard to `to === "ramp"` or `"normal"` (D3's literal text) | from `commissioning` with NO valid report: `→ downtime` then `→ normal` → shipped: refused at step one with `golive_gate_unsatisfied`; mutant: **reaches `normal` having read no report at all.** Closes the PREDICTION 11c's inbox left standing | **P** |
| V13 | T3 | `ops.mode_changed` carries `changeId`, and the alert's `refId` IS that id | revert `refId` to the mode word | one mode change → shipped: `refId` equals the `operating_mode_changes.id` by whole-string equality; mutant: it equals `"downtime"` | |
| V14 | T4 | Every guarded route refuses a role-less user BY THE PERMISSION IT NAMES | repoint both interface decorators to `OPS_MODE_SET` | 11c's surviving mutant, rebuilt → shipped: `Expected "missing permission ops.interface.manage"`; **mutant: DIES here where it SURVIVED there.** Census pinned first: eleven routes, seven guarded, four unguarded | **P** |
| V15 | T4 | Manifest closure, both directions, with no exception | (a) a route on an UNDECLARED permission; (b) a fourth declared permission guarding no route | (a) `ops.interface.manag` → the closure leg names it; (b) a manifest-only string → the reverse direction names it. **Each must die on THIS leg with the other legs green**, or the legs are not independent | |
| V16 | T4 | The granted direction: an all-three actor is refused for a missing permission on NO ops route | a decorator repointed to a misspelt permission | the all-three actor over all eleven routes → shipped: no `missing permission` refusal anywhere; mutant: one route refuses an actor that holds everything | |
| V17 | T4 | The two-actor MAP: each real, non-empty grant set is refused on the other's routes, by name | swap the two decorator groups | `{mode.set, downtime.generate}` vs `{interface.manage}` → shipped: each refused on the other's routes naming the right permission; mutant: the refusals name the WRONG permission **while the status stays 403** — the exact tell §3.42 was written for | **P** |
| V18a | T5 | Each of D7's three rules fires on its synthetic input and NOT on healthy input | widen a threshold; separately break a rule so only the negative control fails; **and a THIRD: delete one series from the healthy test's `input_series`** — that mutant CANNOT be killed by an `exp_alerts: []` leg (it makes it PASS), so the healthy file must additionally carry a `promql_expr_test` leg asserting each series present, and **the kill is THAT leg failing**, not the alert leg (§2.22 — a negative control that cannot fail this way is "not a pre-flight") | `promtool test rules` over `alerts-meta.yml`, both directions, exit VALUE quoted (spike MEASURED: firing **0**, healthy **0**, deliberate break **1** with `got:[]` naming both rules). **Annotations asserted by EXACT text, and the `{{ $value }}` render MEASURED before it is asserted** — the spike predicted the extrapolated `10.714285714285714` and promtool answered a bare `10`; assert the render, or write the annotation with a `printf "%.0f"` pipe so the text is stable. **The `for:` clause is genuinely driven and must be asserted in BOTH positions** — `exp_alerts: []` at `eval_time: 4m` and firing at `10m` for a `for: 5m` rule. **`[15m]` needs no shrinking**: `increase(...[15m])` is evaluable from the SECOND sample in the window whatever the window's width (measured: nil at 1 sample, `0E+00` at 2, `2E+00` at 4 over a 3-minute series). **AND THE NEGATIVE LEG MUST PIN EVERY SERIES PRESENT-AT-ZERO IN `input_series`, WITH ITS REAL LABELS** — `alertmanager_notifications_failed_total{integration,reason}`, `up{job,instance}`, `prometheus_notifications_errors_total{alertmanager}` and the unlabelled `prometheus_notifications_dropped_total`. **MEASURED: a healthy file that simply OMITS the series passes `exp_alerts: []` at exit VALUE 0, indistinguishable from a real green** | **P** |
| V18b | T5 | Rule-file closure: `rule_files`, the files on disk, and `deploy.sh`'s installs are ONE set | (a) a `rule_files` entry naming no file; (b) delete an `install` line for a named rule file | each → shipped: the leg names the missing side; **both mutants must die on this leg**, and the census pin (three rule files) must fail first if a parser goes blind | **P** |
| V19 | T5 | Restart-loop closure: every COMPOSE SERVICE whose config dir step 2 populates (by `install -D` **or by rendering**) appears in the loop | remove `postgres-exporter` from the loop | §2.77's third specimen, now a test → shipped: the leg names the omitted service; control: `caddy` is the declared exception and its absence does NOT fail | **P** |
| V20 | T6 | A heartbeat landing mid-sweep is not overwritten by a false `interface.down` | drop the `lastSeenAt` predicate | ≥15 rounds (a floor): a heartbeat interleaved between the sweep's read and its claim → shipped: status stays `up`, **zero** `interface.down` events; mutant: the 14/15 false-down window reappears and is quoted | **P/M** |
| V21 | T6 | The legitimate path is unharmed — a genuinely stale interface is STILL downed | (none — §3.44's not-over-broad control, and it must stay GREEN) | a stale `up` interface whose `lastSeenAt` does not move → downed, exactly one `interface.down`. **A predicate one term too wide passes every other row in this Book** | |

**Required-DIED mutant count: ~~26~~ ~~27~~ 29** — R1 (1, Phase 0) · **T1 (8: V1, V2×2, V3×3, V4,
V5)** · T2 (4) · T3 (4) · T4 (5: V14, V15×2, V16, V17) · **T5 (6: V18a×3, V18b×2, V19)** · T6 (1).
**The count moved TWICE after the plan was written, both times because something was measured rather
than reasoned about, and §2.68 says the target moves with the Book:**

- **26 → 27, the spike's.** V18a's third mutant exists because `promtool` reports SUCCESS at exit
  VALUE 0 for a healthy file that simply omits the series a rule reads — so an `exp_alerts: []` leg
  proves a rule did not FIRE, never that it was EVALUATED.
- **27 → 29, owner ruling 7's.** V2 gains the mutant that moves one string into the
  not-yet-modelled list (the census counts must fail before any reason is read, or that list becomes
  a place to hide an orphan), and V3 gains the one that deletes a `patients.*` pair (proving the
  table-parity leg and the ruling-7 leg are independent rather than one leg wearing two hats).

**Budget consequence, stated rather than absorbed:** the plan derived ≤3.4M from 26 mutants and
16-18 agents. Three more mutants land on two tasks that were already the plan's most expensive, so
**the honest target is ≤3.6M** — and Plan 10's §2.68 lesson was precisely that inheriting a number
instead of re-deriving it is the mistake, not overspending against a re-derived one. **Two measured races**
(V10, V20) at a floor of 15 rounds each. **Two drills**: the `promtool` run in both directions, and
the spike's read-only production query. **V21 is a required-GREEN control, not a mutant**, and a
task that reports it as a kill has misread it.

**V10 and V11's PRIMITIVE is no longer a prediction.** The spike measured `pg_advisory_xact_lock`
end to end (report §Question A): the lock blocks, the post-lock re-read sees the winner's commit,
and a thrown error releases it. **T3 does not re-measure the primitive; T3 measures the FUNCTION.**
V11's mutant — the lock moved to after `getOperatingMode(tx)` — is known-constructible, and its
expected symptom is the one the spike produced as its *no-lock control*: the loser reads the
pre-change state (sentinel absent, 5/5) and decides on it.

These are the §2.68 inputs to the budget in the Pipeline Notes. **If compile grows the Book, the
target moves with it — in the execute prompt, before the run.**

## Verify-by-execution flags (each names its owning task)

- **①** (T1) `pnpm --filter @hmis/core seed:roles` executed against a real database, **twice**:
  first run creates nine roles and reports its grant counts per role; second run reports `already`
  for everything and exits 0. Both transcripts quoted.
- **②** (T2) `seed:staff` executed against a real database with a three-row roster: the users exist,
  `verifyPassword` and `verifyPin` both succeed for a row that carried a PIN, and the printed report
  is **grepped for the password sentinel and found clean**. Then re-run: `already`, exit 0.
- **③** (**THE EXECUTE SESSION, NOT A TASK**) `seed:roles` and `seed:staff` run **against
  production**, after the owner authorizes it by name, with the `users → role_assignments →
  role_permissions` join read back and compared against the role model. **This is the flag that
  turns this plan into a usable hospital**, and it is deliberately outside the pipeline because rule
  7 and the owner's deny rule both gate it (execute prompt, Phase 5).
- **④** (T5) `promtool test rules` over `alerts-meta.yml` with all three rules firing on their
  synthetic inputs and **none** firing on healthy inputs, exit VALUE quoted; plus `promtool check
  rules` clean.
- **⑤** (T5) `deploy-parity.test.ts` proven to DISCRIMINATE, not merely to pass: the three mutants
  of V18b and V19 built and their kills quoted. A parity test that has never been watched to fail
  is §2.22's "not a pre-flight".
- **⑥** (T3) The measured race quoted with its **observed** rate per case, all three cases, against
  both the shipped code and the mutant — never a summary. Rule 20's isolation confirmed by reading
  the matched command lines.
- **⑦** (T4) The 11c mutant rebuilt and its death quoted, side by side with the SURVIVED result the
  11c gate report records. **This flag is the whole point of T4** — a green new test proves nothing
  about a mutant that once survived.
- **⑧** (execute session) `pnpm verify` at the final HEAD, detached, **exit VALUE from a file**,
  with per-workspace suite/test counts compared against the baseline in both directions.

## Pipeline Notes (for the compile session)

- **Spike FIRST** (the brief beside this plan), **then Phase 0** (one commit, CI checked by FULL
  SHA, one push — §2.62), then compile. **Do not compile before the spike's Questions A and B are
  written into this document** — A decides whether T3's fix is the right fix, B decides whether T1
  is the size this plan says it is.
- **One pipeline, six waves, STRICTLY SEQUENTIAL** — W1[T1] → … → W6[T6]. T1 and T2 share
  `package.json` and `README.md`; T3 and T6 both touch `kernel/ops/`; T4 reads what T3 writes.
- **Models: all six tasks are CRITICAL — opus coder + per-task opus gate.** There is no ROUTINE task
  in this plan and the tiering dial therefore pays nothing (§8's calibration note, applied honestly
  rather than quoted): every task is permissions, concurrency, or an assertion whose entire job is
  to discriminate. Phase 0: one opus agent. One discovery reviewer for the pipeline. **Do not cut
  the mechanical check.**
- Briefs POINT at `AGENT-RULES.md` and at this plan — **never paste** (§2.40's scar); restricted
  tool set; baseline re-measured at compile, detached, exit value from a file.
- **The EXECUTE-METHOD §3 sweep runs before any brief**, and additionally, from this plan's own
  authoring:
  - **Re-derive every permission COUNT in the Consumed Surfaces section** (§2.73 — a census with an
    expiry date), and state each with its SHA.
  - **Re-resolve every line number this document cites**, and brief each task to navigate by SYMBOL
    (§2.78). Phase 0 touches `scheduler.test.ts`, which no task references — confirm that rather
    than trusting it.
  - **Confirm `test/ops-lifecycle.e2e.test.ts`'s existing content before T4 extends it**: 11c's
    leg 5 already asserts the kit routes' permission by name, so T4 must extend rather than
    duplicate, and the census (eleven routes) must be re-counted from the decorators at compile.
  - **Re-derive the ROLE census from all three sources** (§2.46 applied to values): the README's
    two tables, `OPD_ROLE_KEYS`, and the roles `seed:admin`/`seed:ops` already create. The plan
    states nine roles WITH GRANTS against a ten-entry constant that is a different ten; confirm
    that at compile and state it with its SHA, because a role the seed creates and no table
    grants — or the reverse — is a rung.
  - **Check that no task's Files list names a file another task creates in a LATER wave** (§2.47).
    The intended shape is already forward-safe: T1 creates `manifests.ts`, and nothing later than
    T1 imports it.
  - **Assert the script's `files` arrays equal this document's File Structure, both directions**
    (§2.54 — the entry that cost 08.5 its headline deliverable).
- **CRLF (§2.79):** every task here authors on the Windows mirror and syncs. `deploy.sh`,
  `prometheus.yml` and `alerts-meta.yml` are **shell and YAML, where a CRLF is not cosmetic** — a
  `\r` in a `for svc in` line changes what the shell reads. **Brief T5 to patch SERVER-SIDE**
  (a `python3 - <<'PY'` heredoc over ssh, reading and writing with `newline=""`), which is the shape
  the 11c main session adopted deliberately after watching the trap fire three times.
- **Budget, derived from the Book per §2.68 — arithmetic, not analogy.** **26 required-DIED
  mutants** (1 Phase 0 · 6 T1 · 4 T2 · 4 T3 · 5 T4 · 5 T5 · 1 T6) + **2 measured races** at a
  15-round floor + **2 drills** + **6 opus gates** + 6 mechanical checks + 1 discovery reviewer
  ≈ **16–18 agents**. Calibration against what is known: Plan 10 ran 13 agents / 20 mutants at
  **2.64M**; Plan 11c ran 15 agents / 15 mutants at **2.49M**; Plan 11a ran 16 drill-heavy agents at
  **3.34M**. This plan is **mutant-heavier than any of them** and drill-lighter than 11a, with no
  migration and no web work. **Target: ≤ 3.4M subagent tokens.** The spike is budgeted separately in
  its brief (~100k target, honest range to 200k — 11c's targeted 80k and cost 172k).
- **The trim levers, named so a cut is made with open eyes rather than by drift.** If the budget
  must come down: V5 (seed idempotence) and V9 (secret-free output) could ride as acceptance
  criteria with quoted transcripts instead of built mutants — that is **−2 mutants and ~150k**, and
  it costs the guarantee that those two assertions discriminate. **Do NOT trim V11, V17, V19 or
  V21**: V11 and V17 are the rows that catch the defects this plan exists for, V19 is the §2.77 rule
  finally becoming a test, and V21 is the control that stops T6's fix becoming T6's defect.
- CI watched by `ci-watch.sh` for the whole run. **A census red after Phase 0 is READ, NOT RE-RUN**:
  §2.80's bar is unmet, so the first question is always *timeout or set mismatch?* — grep the log
  for `Expected -` and for the missing job names before touching anything. A **set mismatch** is a
  regression signal; a **bare timeout** is the harness, and R0-1 exists to make the two
  distinguishable at a glance. Read §2.80 and 11c's §3a before re-running.
- **The repo is PUBLIC.** Nothing in any commit may carry a password, a PIN, a roster, an owner
  email, or an SMTP value beyond the placeholders already committed (GC3). **T2 is the highest-risk
  task in the plan for this** — brief it explicitly, and grep the diff before the commit.

## Execute-prerequisites (owner actions; the pipeline halts where noted)

1. ~~**The spike has run and its Question A is written into this document** (blocks compile). A
   decides whether T3's named fix is correct.~~ ~~B decides whether T1 is the size stated here.~~
   **BOTH DISCHARGED, and this prerequisite is MET.** **B** — measured 2026-08-24 in the planning
   session, §B-MEASURED, premise held. **A** — measured 2026-08-24 by the spike, five runs each with
   a control, written into D5 above; `pg_advisory_xact_lock` serialises `changeOperatingMode`
   exactly as D5 predicted, and T3 is unblocked. **Nothing in this plan is fork-open.**
2. **The staff roster** — usernames, full names, initial passwords, PINs, and the role each person
   holds, from D3's nine. **Needed for flag ③, NOT for the pipeline**: every task tests with
   fixtures it makes itself. The owner can produce this while the pipeline runs.
3. **The deploy authorization, named in as many words** (blocks flag ③ and nothing else). 11c's T6
   was blocked twice by a safety classifier and by the owner's own
   `Bash(docker compose -f docker/prod/*)` deny rule before the owner authorized it explicitly.
   **Expect the same and do not work around it.**
4. **Nothing else.** No DNS, no R2, no new credential, no new hostname, no schema change.

## Decisions for the owner (with what stalls without each)

1. ~~**None new — this plan's five were ruled in the brainstorm**~~ **ONE NEW, and it was taken at
   compile rather than in the brainstorm because only the compile sweep surfaced it: owner ruling 7
   above.** The brainstorm's five stand unchanged (script now with 11e booked · ship the role
   model · confirm D2's commissioning reading · per-test timeout · read-only production query
   authorized). Ruling 7 exists because *"ship the ACTUAL role model"* turned out to be
   under-determined: the two README tables cover 39 of 59 declared permissions, and the twenty-
   permission gap was invisible until someone counted. **The lesson is §2.49's, in its positive
   direction: the question "what does this plan assert about the things it does NOT mention?" is
   worth asking of a role model exactly as much as of a test fixture.**
2. **One thing the owner should decide but which blocks nothing here:** D7's honest limit means a
   dead Alertmanager is *visible* to Prometheus and *not emailable*. The out-of-band answer is
   E-16's watchdog in 11b. **If the owner wants coverage before that hardware lands, the option is a
   deadman's switch through an external ping provider — which breaches the portability constraint
   (GC14) and should be an explicit owner ruling, not a plan's quiet choice.** Raised here rather
   than decided.
3. **The lead-time clocks this plan does not absorb** (restated from 11c, all still open, none
   blocking this pipeline): counsel bundle · DPIA author + inference locus (blocks 12a activation) ·
   WhatsApp BSP onboarding · E-11 transition-operations boundary map · E-1 (blocks only the relay) ·
   internal auditor (E-17) · **the second off-machine escrow copy and the decrypt-verify
   confirmation, both still owed** · the R2-endpoint masking reminder, delivered again.

## Self-review — what this plan's own passes caught before commit

1. **The plan's headline finding was NOT in the brief I was given, and it came from one grep.**
   The prompt named three MAJORs and asked me to choose between hardening and the roadmap. Tracing
   `createUser`'s callers — one command — found that **no second user can exist on the live box**,
   and tracing `grantPermissionToRole`'s callers found that **no module's permissions are ever
   granted**. Both are MAJOR 4's class. The lesson for the next brainstorm, and it is §3.43's:
   **when a plan closes a defect, grep for the other doors before writing the closure into a gate
   report.** MAJOR 4 was closed for `ops.*` on 2026-08-23 and the same defect stood in eight other
   modules that same evening.
2. **I nearly wrote "add billing grants to `seed-ops`".** That is scoping the fix to the
   reproduction — the exact mistake that produced this finding — and D1's reachability invariant is
   what replaced it. The tell was writing the sentence and noticing it named one module.
3. **The manifest-list refactor was almost left out as unnecessary.** It looks like tidying. It is
   not: `seed-admin.ts`'s one-manifest registry **is** the mechanism of MAJOR 4, and without D2's
   V4 assertion the tenth manifest repeats it. §2.54 is the entry; the fix is one list plus one
   test, and the test is the half that matters.
4. **Every consumed surface was re-read from the tree at `78b0a3d`, and one recollection was
   wrong.** I expected `seed-ops.ts` to be able to create users; it explicitly refuses
   (`:96-101`) — which is correct behaviour and which is why the gap is real rather than a
   workaround away.
5. **The Book gained V11 and V21 during self-review, and both are the rows that matter most.**
   V11 exists because a lock in the wrong place reads as correct — the first draft asserted only
   that a lock was taken. V21 exists because §3.44 says a fix that adds a refusal needs a criterion
   protecting what must still be allowed, and T6's one-term predicate is exactly such a fix.
6. **A role-key discrepancy was found in self-review and it would have cost a rung.** The
   plan said "nine roles" and `OPD_ROLE_KEYS` holds ten — a different ten. `pharmacy`
   appears in the README's permission table and in **no role-keys constant anywhere**, while
   `nurse` and `medical_superintendent` are keys with no permission column. A transcription
   that trusted either source alone would have shipped a role the seed never creates or a
   grant for a role the table never mentions. **Found by reading the constant rather than
   the table** — §2.46's lesson (resolve against the tree, never by reading) applied to a
   value instead of a path.
7. **A fourth alert rule was considered and rejected with its reason recorded** (D7's
   `absent(up{job="alertmanager"})`), because a rejected alternative left unmarked reads as an
   oversight to the next reader (§2.48's discipline applied to a design choice rather than a fork).
8. **The one honest limit is stated three times on purpose** — in D7, in the flags, and in the
   owner decisions: **an alert about a broken Alertmanager cannot be delivered by that
   Alertmanager.** A hardening plan that quietly implied otherwise would be the same failure it
   exists to fix, one level up.
9. **What I could NOT check and marked as prediction rather than fact:** the production grant state
   (Question B), `pg_advisory_xact_lock` under this repo's `withTx` (A), whether Alertmanager
   exports its notification counters before the first notification (C), and whether `promtool` can
   unit-test a rule over `up{}` (D). **Four predictions, four spike questions, no fifth.**
10. **B was then MEASURED the same day and the prediction was exactly right** (§B-MEASURED) — and it
   found three things the plan had not predicted, of which two matter: **`admin` has no PIN**, so the
   fast-switch Plan 02 perf-tested is unusable by anyone, and **`seed:opd` has never run against
   production**, so ten role keys and the `opd_config` row are simply absent. **The lesson is the
   cheap one: a measurement that CONFIRMS a premise still pays, because the queries you write to
   test one claim return facts about four others.** §2.49's rule in its positive direction.

## Carried forward

- **Plan 11e — user administration over HTTP**, scoped in D12. Trigger: the pilot has staff and the
  owner needs to add, disable or re-role one without an ssh session.
- **`scheduler.test.ts`'s design.** Seven ledger entries. Owner ruled the timeout for now; the
  trigger for the redesign is the next census red that is a **set mismatch** rather than a timeout.
- **PRODUCTION IS NOT COMMISSIONED BEYOND OPS, and 11d does not fix that** (found by §B-MEASURED).
  `seed:opd` has never run there — no `opd_config` row, no placeholder departments, ten missing role
  keys — and by the same reasoning `seed:tariff`, `seed:billing` and `seed:registration` are worth
  checking. **This is why D-17's gate is correctly refusing to let the box leave `commissioning`**:
  the system already knows it is not configured, which is the gate working as designed rather than a
  defect. What is missing is **one written commissioning checklist** naming every seed in order; the
  execute prompt's phase 6 carries it as a deploy step, and the gate report should promote it to the
  README.
- **The deadman's switch / E-16 watchdog** — 11b, and the portability decision in owner-decision 2.
- **§7.7's stale `/opt/hmis/apps/core/dist/`** on the build host — gitignored, cannot shadow the
  suite, but `start:prod` would run stale bytes. A one-line cleanup for the execute session, booked
  in its prompt rather than given a task.
- **The roadmap needs three edits this plan must NOT make** (its boundary says so, and 11c's gate
  report is the precedent): 11c's status line still reads *"SHIPPED AS CODE … NOT LIVE"* when the
  addenda say it is live; the sequencing note should record 11d between 11c and 09; and Plan 11e
  needs a slot. **The executing session's gate report lands all three.**
