# Prompt — WRITE the Plan 11e phase document

> **For a fresh session.** Written 2026-08-23 by the session that deployed 11d, discharged flag ③,
> activated `opd_visit`, and fixed MAJOR 1.
>
> **Your job is to WRITE the phase document. Do not execute it.** The session that executes it is a
> later one, and under v3 its seed is three lines (§1). Writing and executing in one context is how
> a plan stops being a prediction anyone can grade.
>
> **Nothing here is ground truth by the time you read it.** §1 says what to re-measure. The document
> this one replaces recorded its own SHA wrongly and named two roles that did not exist — in the
> section warning about exactly that.

---

## 0. Why 11e, and why now

The hospital is **operable**: a patient can be registered, queued, seen and closed out — proven end
to end on the live box on 2026-08-23 (gate report ADDENDUM 4). What it cannot do is **onboard a real
person safely**, and that is 11e.

- **There is no credential-reset flow anywhere in the system.** A receptionist who forgets her
  password on day three is locked out permanently, and the only repair is an agent with database
  access. `seed:staff` REFUSES a changed password by design, precisely because a silent overwrite
  would be the one way to lock a real user out — so the refusal that protects users also strands
  them.
- **`auth.users.manage` and `auth.roles.manage` are DECLARED and guard nothing.** Dead strings since
  Plan 02.
- **The password floor is `seed:staff`'s alone.** `loginSchema` accepts any non-empty string.
- **The pilot roster is burned** — 15 synthetic credentials and the `admin` password were pasted
  into a session transcript on 2026-08-23. Nothing real is exposed (synthetic names, and the box
  held zero patients at the time) but they must not survive into live use, and deactivate-and-
  reissue needs the surface this plan builds.

## 1. Ground truth — verify, do not trust

- `git pull --rebase origin main` on the build host and **record the SHA you are at.** This document
  was written at **`5b65eec`**. Docs commits land from the owner's machine while you work.
- **Re-measure the baseline** detached, exit VALUE from a file. At `5b65eec`: `apps/core` **148
  suites / 1110 tests**, `packages/contracts` **3 / 7**, `apps/web` **34 / 175**, `pnpm verify` exit
  VALUE **0**. One pre-existing eslint warning in `scheduler.test.ts` (unused disable directive) —
  not yours, leave it.
- **Re-read production before designing anything that depends on it.** At the time of writing:
  16 users, 20 role assignments, 12 roles, 59 declared permissions, 46 held, 13 not-yet-modelled,
  `opd_visit` v1 ACTIVE, 1 patient (`CRK-00000001-7`, a smoke-test record whose visit is abandoned),
  1 doctor, 12 placeholder departments, **0 rooms, 0 doctor schedules**.

## 2. Read first, in this order

1. **`EXECUTE-METHOD-V3.md`** — **v3 governs, and 11e is its first phase-document pilot.** Read §1
   (one document per phase, the fact rule) and §2 (you rule the lane, in one recorded sentence)
   before writing a line.
2. **`plan-11d-gate-report.md`, ADDENDA 2 through 5.** Addendum 5 is MAJOR 1's fix and states
   precisely what it did NOT close — which is 11e's.
3. **`plan-11d-findings-inbox.md`** — the densest thing in the repository.
4. **`AGENT-RULES.md`** — the contract, unchanged.
5. **`EXECUTION-LESSONS.md` §2.81-§2.86.** §2.81 twice: a plan's STATED mutant is itself a
   prediction, and 12 of 21 Book rows were refuted by execution.

## 3. What 11e must contain

The roadmap's sketch (`2026-08-11-phase1-plan-series.md`, Plan 11e entry) plus what this session
measured:

- `POST /admin/users` · role assign/revoke · **PIN reset** · deactivate · **force-password-change on
  first login** · the admin screen · `auth.users.manage` and `auth.roles.manage` finally guarding
  routes.
- **§3.42's four legs from day one.** A permission-map defect on THIS controller is privilege
  escalation, not a 403. This is the highest-privilege write in the system.
- **A real password policy**, replacing the seed-time-only floor. **Needs an owner ruling** — get it
  before designing, not during.
- **MAJOR 1's residual.** `seed-admin.ts` RETURNS EARLY on any deployment that already has an admin,
  so a permission declared after first boot is never granted there. `seed:roles` now *detects* that
  state and names it (addendum 5) but does not repair it. **The repair is 11e's** — and it must not
  become a second early-return of its own.
- **Credential rotation for the burned pilot roster** — the first real use of the surface.

## 4. Spike questions — answer by measurement before you design

Under v3 §1.2, run each in the cheapest honest way; a read-only production query from the main
session where that suffices.

1. **Can force-password-change reuse the existing session machinery**, or does it need a new token
   state? `SESSION_TTL_MINUTES` defaults to 720. Where would the flag live, and what does every
   authenticated route do when it is set?
2. **What should `seed-admin.ts`'s early return BECOME** once an admin surface exists? Deleting it
   risks re-granting on every deploy; keeping it preserves MAJOR 1's mechanism.
3. **PIN reset vs password reset — are they one flow or two?** `setPin` has exactly one non-test
   caller (`seed:staff`). 14 of 16 live users have a PIN.
4. **Does `assignRole`/revoke need the SoD engine in the loop?** `sod.ts` seeds nine pairs and
   `assertNotSodPair` is called from the workflow path today. An admin screen that hands out roles
   is where a pair gets violated.
5. **What does deactivate mean for an in-flight session?** A deactivated user holding a valid
   12-hour token is the interesting case.

## 5. Rulings already made — do not re-litigate

- **Owner ruling 2026-08-23, `workflow.*`:** `opd_admin` drafts, `owner` and `medical_superintendent`
  approve, `owner` activates. Shipped in `bf868d2`. The four `workflow.instances.*` strings stay
  not-yet-modelled.
- **Owner ruling 2026-08-23, `UHID_PREFIX = CRK`.** Seeded.
- **Sequencing:** Plan 09 (memberships/coupons, channel-partner re-shaped) comes AFTER 11e. It also
  carries a CA/counsel gate on GST and §11(4A) commission income that is outside the pipeline.

## 6. The lane

**v3 §2 says the plan author rules the lane at write time, in one recorded sentence — that is YOUR
call, not this document's.** For what it is worth, the session that wrote this would rule it
**HEAVY**: a controller, an admin screen, auth-path changes and the four legs is a module build, not
a hardening pass. If you rule it LIGHT, say why in the sentence — v3 wants the reasoning recorded,
not the verdict.

Note that verification depth is NOT set by the lane. Permissions and credentials get executed
mutants either way (v3 §2, rule 21).

## 7. Standing constraints

**Rules 3 and 7 as amended** govern every path and container decision · **`hmis-db-1` is the dev
database; `hmis-prod`'s database and volumes are a live hospital's data** — it now holds a real
activated workflow and a patient record · **the repo is PUBLIC — no password, PIN, roster or owner
email in any commit** · **never rewrite pushed history** · **never weaken a guard to produce
evidence** · **the deploy is authorized only when the owner names it.**

**Expect the safety classifier to block production operations even when authorized.** It blocked
this session five times, including one attempt to mint an `owner`-role account — where it was
right. **Do not work around it; report and ask.** §6 of the prior handoff, unchanged and vindicated.
