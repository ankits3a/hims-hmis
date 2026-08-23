# Plan 11c — findings inbox

Things discovered OUTSIDE a task's Files list, routed forward rather than fixed in place.
Each entry states whether its claim is MEASURED (a mutant was built and watched) or a PREDICTION.

---

## 2026-08-23 · T1 · D3 and D2 disagree about how much of the commissioning exit is gated

**What the plan says, in two places that do not match.**

- **D2 (the transition matrix):** "leaving `commissioning` requires D3's gate (Book V2)".
- **D3 (the guard's own section):** "`changeOperatingMode` refuses `commissioning → ramp|normal`
  unless the latest `config_validation_reports` row has `ok = true` and `at` within 24 h".

`commissioning` has four possible targets, not two. D3 names only `ramp` and `normal`; D2 names
the exit as such. The two readings differ for `commissioning → degraded` and
`commissioning → downtime`.

**What T1 shipped, and why.** The D2 reading: EVERY exit from `commissioning` rides the gate.
`kernel/ops/mode.ts` gates on `from === "commissioning"`, not on the target. The reason is that
the narrow reading leaves a two-step path — `commissioning → downtime → normal` — that reaches
`normal` having never consulted a validation report, which is the single thing D3 exists to
prevent. Gating the whole exit only ever adds refusals; it removes none.

**Evidence, and the honest split between the two halves of this entry:**

- **MEASURED.** The shipped behaviour is asserted by execution in `src/kernel/ops/mode.test.ts`
  ("V2: the gate applies to EVERY exit from commissioning, so downtime is not a way around
  D-17"), green in `pnpm verify` at `e757f207c0ec3b168c7ff552aa3ee46b61d8160e`. The gate itself
  is mutant-proven: V2's mutant (`false ? await assertGoLiveGate(tx, now) : null`) DIED —
  expected `{code: "golive_gate_unsatisfied", detail: "no_report"}`, received
  `{resolvedTo: "normal"}`.
- **PREDICTION — no mutant was built for this half.** That the NARROW reading would permit
  `commissioning → downtime → normal` as a bypass is reasoning from the matrix, not a measured
  fact: I did not build a narrow-gate variant and watch it walk that path. It is stated here as
  the rationale for the choice, not as evidence.

**Who this touches.** T4's `test/ops-lifecycle.e2e.test.ts` drives "commissioning boot → exit
refused → validate → commissioning→normal", which both readings satisfy identically, so nothing
downstream is blocked either way. T5's mode desk renders `golive_gate_unsatisfied` for a
`downtime` attempt made from `commissioning`, which under the narrow reading it would not.

**Ask of the plan owner:** confirm the D2 reading, or say so and T1's guard narrows in a
follow-up commit. Nothing is committed on the assumption that this entry will be answered.

---

## 2026-08-23 · T1 · `ops.mode_changed` carries no change-row id, so a mode alert cannot deep-link

**The fact.** The plan fixes the payload at `{from, to, note: nullable, reportId: nullable}`
(Task 1's own section). It carries no `changeId`, and the `operating_mode_changes` row's id is
not derivable from anything on the envelope.

**What that forced.** The alerts consumer's new branch (D4) has to name a `refType`/`refId` pair
like its two neighbours, which use `(workflow_instance, instanceId)` and `(patient, patientId)` —
an entity type and its id. With no change-row id available, T1 shipped
`refType: "operating_mode"`, `refId: <the new mode word>`. The linkage to the exact change is not
lost — `alerts.source_event_id` is the `ops.mode_changed` event id, and `alert.raised` carries
`causationId` — but it is one hop further than the other two branches.

**Evidence: MEASURED for the shipped shape, nothing here is a prediction about behaviour.**
`src/kernel/alerts/consumer.test.ts` asserts `refType`/`refId` by whole-string equality, green in
verify; V6's mutant (the branch deleted) DIED — expected
`["first: resolved", "second: resolved"]`, received `["first: threw ZodError", "second: threw
ZodError"]`.

**Who this touches.** T5's `mode-banner.tsx` / `ops-mode.tsx`: an alert row for a mode change
routes the owner to the mode desk in general, not to one history entry. If a deep link is wanted,
the cheapest change is a `changeId` on the payload — a T1-owned file, and therefore a follow-up
commit rather than something a later task should add on its own.

---

## 2026-08-23 · T2 · `validateBillingConfig` does NOT throw on a missing `billing_config` row

**What the compiled brief says.** T2's brief transcribes the consumed surface as: *"It throws
`billing_not_configured` if the `billing_config` 'main' row is missing."*

**What the shipped function does.** It does not throw. `modules/billing/config.ts` wraps
`loadBillingConfig` in a try/catch, pushes the `BillingError`'s own code as a `ConfigError`, and
RETURNS EARLY with `{ ok: false, errors: [{ code: "billing_not_configured", … }] }`. The header
comment above it states the contract the code actually keeps: *"Read-only; accumulates
ConfigErrors and never throws."*

**Evidence: MEASURED, and it is a green assertion rather than a prediction.**
`src/kernel/ops/validate.test.ts` › *"an unconfigured deployment is red in BOTH scopes, and the
aggregate still returns rather than throwing"* runs `runConfigValidation` against a truncated
database and asserts `codesOf(billing)` CONTAINS `billing_not_configured` — i.e. the missing row
arrives as a code in a returned report, not as an exception. Green in `pnpm verify`. **No mutant
was built for this entry and none is owed:** the claim is about the behaviour of a CONSUMED,
FROZEN function, established by executing it, not about whether one of my assertions
discriminates.

**Why it mattered.** Believing the brief would have led T2 to wrap the billing leg in a
try/catch and synthesise a scope-failure code of its own — an invented code for a state the
shipped validator already reports precisely, and a second code path nothing would ever exercise.
`kernel/ops/validate.ts` therefore calls both validators plainly and lets an actual throw
propagate, which is the correct answer to "is this deployment ready?" when the question could not
be evaluated at all.

**Who this touches.** T4's `test/ops-lifecycle.e2e.test.ts` boots against an unconfigured
database and drives `POST /ops/config-validation` before seeding: that route answers **200 with
`ok: false`**, never a 5xx.

---

## 2026-08-23 · T2 · no shipped fixture makes the D-17 aggregate green — the exact two steps that do

**The fact, and it is a compile-time finding the brief already anticipated; this entry records it
MEASURED rather than predicted.** `seedBillingBase` (`test/helpers/billing.ts`, the only exported
whole-context fixture) leaves the aggregate RED for two independent reasons:

1. It seeds ONE of the four `DISCOUNT_CATEGORIES` manual caps (`CAP-CHARITY`), so
   `validateTariffConfig` returns three `manual_caps_missing` errors.
2. It calls `upsertGstSettings(tx, actor, { compositeHealthcareExempt: true, caSigned: false })`,
   and D5's tariff leg is `ok && caSigned`.

Tariff's own `seedFullValidConfig` closes both, but it is FILE-LOCAL to
`modules/tariff/context.test.ts` and not exported.

**The recipe, executed twice — once in-suite and once against a real database.** On top of
`seedBillingBase(db)`, inside one `withTx`:

```ts
for (const discountCategory of ["scheme", "negotiated_corporate", "employee"] as const) {
  await upsertAdjustmentRule(tx, base.drafter, {
    ruleKey: `CAP-${discountCategory.toUpperCase()}`, sourceKey: "manual",
    title: `${discountCategory} discount cap`,
    params: { discountCategory, maxBps: 5000, approvalAboveBps: 3000 },
  });
}
await upsertGstSettings(tx, base.drafter, { caSigned: true });
```

with an `at` at or after the seeded version's activation (`2026-01-01T00:00:00Z`). Every row goes
through the OWNING module's public API — never a hand-rolled insert into tariff's tables.

**Evidence: MEASURED.** (a) `validate.test.ts` › *"green control"* asserts
`{ scope: "tariff", ok: true, caSigned: true, errors: [] }` and
`{ scope: "billing", ok: true, caSigned: null, errors: [] }`, green in verify. (b) The same
fixture, run against an isolated scratch database created and dropped inside this task, made
`pnpm validate:config` exit **0** printing `scope tariff: ok=true errors=0 caSigned=true` /
`scope billing: ok=true errors=0` — flag ①'s positive direction.

**One extra fact worth having.** On a database with NO `gst_settings` row at all,
`validateTariffConfig` reports `settings_missing` AND `caSigned: false`, so the aggregate's
synthetic `ops.ca_signature_missing` appears BESIDE it rather than instead of it. That is two
errors describing one absence, and it is the shipped validator's shape, not something this task
introduced.

**Who this touches.** T4's `test/ops-lifecycle.e2e.test.ts` must run both steps before
`POST /ops/config-validation` can answer `ok: true`, or the whole "commissioning → normal" leg of
that e2e is unreachable.

---

## 2026-08-23 · T3 · a stale job count in a FROZEN monitoring file (`postgres-exporter/queries.yml:18`)

**The fact.** `docker/prod/postgres-exporter/queries.yml` line 18 states, in the comment that
explains why `alerts.yml` needs its `absent()` leg at all:

> `# THIS QUERY RETURNS A ROW ONLY FOR A JOB THAT HAS STARTED AT LEAST ONCE (spike finding 6): the`
> # worker registers NINE jobs (kernel/worker/jobs.ts registerAllJobs) but

As of this task's commit `registerAllJobs` registers **TEN**. That file is **T6's** in Plan 11c's
File Structure and therefore frozen to T3, so the number was left as it stands rather than fixed.

**What is NOT wrong.** The QUERY itself is unaffected and needs no edit: it is
`select job, … from scheduler_heartbeats` with no job-name enumeration anywhere, so the tenth
job's row is exported the moment it first ticks, exactly like the other nine. Nothing about the
metric, the gauge, or `alerts.yml`'s parity with the registry depends on that comment.

**Evidence: MEASURED for the mechanism, and the count itself is arithmetic rather than a claim.**
The worker boot line was executed on the build host and names ten jobs
(`worker started: jobs=…,retentionSweep,sweepInterfaceHeartbeats`), and
`test/alerts-parity.test.ts` is green at `toHaveLength(10)` with the exporter file untouched.
**NO MUTANT WAS BUILT FOR THIS ENTRY AND NONE IS OWED** — the finding is a stale sentence in a
comment, not an assertion that might fail to discriminate; there is no behaviour here to mutate.

**Who this touches.** T6 owns the file and already edits `postgres-exporter/queries.yml` for
D11's drill-age query. One word (`NINE` → `TEN`) in the same commit closes it. §2.60's rule is
the reason it is worth the line at all: the next reader believes a stale comment, and this one
sits directly above the explanation of why the missing-series leg exists.

---

## 2026-08-23 · T6 · EXECUTE-PREREQUISITE NOT MET — `/opt/hmis-prod/.env.smtp` has an EMPTY `SMTP_PASSWORD`

**The fact, MEASURED on the box.** The file exists, is `-rw------- root root` (600), and carries
all six key NAMES. Five of them carry values. `SMTP_PASSWORD` does not:

```
$ awk -F= "/^SMTP_PASSWORD=/{v=substr(\$0,index(\$0,\"=\")+1); print \"len=\" length(v)}" /opt/hmis-prod/.env.smtp
len=0
$ grep -n "^SMTP_PASSWORD=" /opt/hmis-prod/.env.smtp | cat -A
8:SMTP_PASSWORD=$
```

(`$` is `cat -A`s end-of-line marker: there is nothing between the `=` and the newline.) The
file`s own header says the value is to be a Gmail APP PASSWORD minted at
`myaccount.google.com/apppasswords`; it has not been pasted in yet.

**Why this is a HALT and not a workaround.** T6`s brief: *"Do not fabricate a credential. Do not
stub the derivation. Do not invent a placeholder that lets the deploy pass."* A present-but-empty
key is exactly the shape that a shallow check waves through — the file exists, it is 600, it has
six lines — and it is the shape that would produce an Alertmanager which starts, looks healthy in
`compose ps`, and fails SMTP authentication only at the moment it first has something to say.

**What T6 therefore shipped, and what it did NOT run.** Every artefact is committed and proven by
execution as far as it can be without the credential. `deploy.sh` was **NOT** run, so flags **④**
(9/9 declared services) and **⑤** (the synthetic alert to the inbox) are **UNDISCHARGED**, as is
the post-deploy volume-roster check. The production roster is unchanged: 9 containers, 7 volumes,
no anonymous volume.

**The die path IS proven, using the shipped bytes.** Lines 263-328 of `docker/prod/deploy.sh` were
extracted verbatim (`sed -n "263,328p"`, md5 `12cc776c0847ec31f3df4588f54154c0`) and executed
against a scratch `.env.smtp` whose `SMTP_PASSWORD` is present and empty — i.e. the real file`s
exact shape. It refused, exit value 1:

> `deploy.sh: FATAL: SMTP_PASSWORD is empty in …/.env.smtp. Refusing to deploy an alert path that
> cannot deliver — a critical alert nobody receives is worse than an obvious hole, because it looks
> exactly like a quiet night.`

So when the owner pastes the app password and re-runs `deploy.sh`, the run either completes or
refuses for a reason it names. Nothing needs re-authoring; the deploy needs running.

**Ask of the plan owner:** paste the app password into `/opt/hmis-prod/.env.smtp`, keep it 600,
escrow it beside `SECRET_KEY` and the pgBackRest cipher passphrase (README, ceremony section),
then run `docker/prod/deploy.sh` and the alert drill in the README`s alert-path section. **The
escrow ceremony is now a THREE-secret ceremony.**

---

## 2026-08-23 · T6 · D10 says the derived `alertmanager.yml` is 600 — 600 ALONE would not start

**The fact, MEASURED against the pinned tag.** `prom/alertmanager:v0.27.0` declares `USER nobody`,
and its own `/etc/passwd` maps that to uid/gid **65534**:

```
$ docker run --rm --entrypoint /bin/sh prom/alertmanager:v0.27.0 -c "id; grep nobody /etc/passwd"
uid=65534(nobody) gid=65534(nobody) groups=65534(nobody)
nobody:x:65534:65534:nobody:/home:/bin/false
```

D10 specifies the derived config as `600`. A `600` file owned by **root** is unreadable by uid
65534, so the container would fail to read its own config — and the same applies with more force
to the `smtp_password` file, which must be 600 for GC2 and must be read by that process.

**What T6 shipped.** Both derived files are `chmod 600` **and** `chown 65534:65534`
(`ALERTMANAGER_UID`, overridable via `HMIS_ALERTMANAGER_UID`), and their directory is `0755` so
the mount is traversable. This satisfies D10`s `600` literally while being readable by the one
process that needs it and by no other account on the box. **MEASURED:** the shipped render block,
executed verbatim against dummy credentials, produced `-rw------- nobody nogroup` for both files,
and `amtool check-config` accepted the result (`SUCCESS … 2 receivers`).

**PREDICTION, stated as one.** That a root-owned 600 config would actually make the container
fail was NOT executed — no deploy ran (see the entry above), and I built no root-owned variant to
watch it fail. It is inference from the uid, not a measurement. If a future tag changes its user,
the failure is loud rather than silent: alertmanager never reaches `running` and step 6b names it.

---

## 2026-08-23 · T6 · `HmisBackupDrillOverdue` FIRES ON A FRESH DEPLOYMENT, by design — the owner should expect it

**The fact.** D11 asks for "age of the newest `backup.drill_passed`". When there is no such row at
all, the query has to answer something. T6 chose `coalesce(…, to_timestamp(0))`, so a deployment
on which no drill has ever passed reports an age measured in decades and
`HmisBackupDrillOverdue` (critical) fires ~15 minutes after Prometheus first scrapes it.

**Why, rather than returning no row.** A missing series reads GREEN. That is precisely the blind
spot `alerts.yml`s `absent()` leg exists to close for the scheduler (spike finding 6), and "we
have never proven we can restore" is not a quieter fact than "we could restore nine days ago".
The rule`s own annotation says which case it is looking at.

**The consequence the owner should be told about, once.** On the first `deploy.sh` run after the
SMTP credential lands, the very first email this stack sends will most likely be
`[HMIS CRITICAL] HmisBackupDrillOverdue` — because the drill runs weekly (22:00 UTC Saturday) and
the events table has no `backup.drill_passed` row until the first one completes. It clears itself
on the first pass. That is a correct alert, not a false one, but an owner who is not expecting it
will read it as the alert path being broken on arrival.

**Evidence: MEASURED, and the negative control is measured too.** `promtool test rules` over
`alerts-backup.yml` — both rules fire on synthetic inputs and NEITHER fires on healthy input
(exit value 0, `SUCCESS`). Three mutants of the rule file were built as separate scratch files and
all three DIED, including one (`> 691200` → `> 0`) whose only symptom is the negative control
failing.

**Closed in the same commit:** T3`s inbox entry above (`queries.yml:18` said the worker registers
NINE jobs). It now says TEN. The file is T6`s and the fix is one word.
