# Plan 11d — findings inbox

Findings routed forward during the 11d run. Each names its source, says whether it is MEASURED or a
PREDICTION, and states what it blocks. **Nothing here is fixed by 11d unless a line says so.**

---

## 2026-08-24 · T2 + its gate · `seed:opd` grants nothing, and that BLOCKS the README's own go-live runbook

**MEASURED.** `OPD_ROLE_KEYS` (`src/modules/opd/config.ts`) holds ten role keys; `seed-opd.ts`
inserts all ten `onConflictDoNothing` and calls `grantPermissionToRole` **nowhere**. After
`seed:roles` ships, three of those keys still hold **zero** permissions: `nurse`, `owner`,
`medical_superintendent`.

**The consequence the gate traced, and it is the sharp part.** README go-live runbook step 4 is the
`opd_visit` two-key activation ceremony. `POST /workflow/definitions/:id/approve` carries
`@RequirePermission("workflow.definitions.approve", "hospital")`, and **all eight `workflow.*`
strings sit on owner ruling 7's not-yet-modelled list.** So an `owner`-role user provisioned by
`seed:staff` **cannot perform the approval the very next runbook step demands**, and no OPD visit
can be opened until somebody can. **The runbook cannot currently be completed end to end.**

This is MAJOR 4's shape surviving in the role vocabulary: 11d closes it for `opd.*`, `billing.*` and
`patients.*` and leaves this door shut. It is not a T1 or T2 defect — both did exactly what ruling 7
said, and `seed:staff` now reports `!! NOT READY — role(s) holding ZERO permissions: …` rather than
implying success, with a test pinning it.

**Needs an owner ruling**, most likely granting `workflow.definitions.draft` / `.approve` /
`.activate` to `owner` and `medical_superintendent`. **Blocks: a usable OPD flow after the deploy.
Does not block: the rest of this pipeline.**

## 2026-08-24 · T2's gate · `seed:staff`'s writes are not transactional

**MEASURED.** Validation is whole-roster and happens before the first write — D4's actual
requirement, and V7 plus three further probes confirm zero users are created when any row is bad,
including when the bad row is LAST and discovered in the per-row loop. **But the writes themselves
are not wrapped in `db.transaction`.** "All-or-nothing writes" is not claimed by D4 and is not
delivered.

It degrades safely: the verify phase re-reads and prints `!! NOT READY` naming what is missing, and
the script is idempotent, so a re-run completes the roster. **The transcript should not be read as
an atomicity guarantee**, and D4 says the transcript IS the audit record — so this belongs in the
record.

## 2026-08-24 · T2's gate · the 8-character password floor is a seed-time floor, not an auth policy

**MEASURED.** `loginSchema` is `password: z.string().min(1)` and `pinSwitchSchema` is
`pin: z.string().min(4)`. `seed:staff` enforces 8, every other entry point does not. **A floor any
other entry point bypasses is a floor in name only.** Carry to Plan 11e with the credential-reset
flow; needs an owner ruling on what the real policy is.

## 2026-08-24 · T2's gate · `roleHolders` is roster-scoped, not hospital-scoped

**MEASURED.** `seed:staff`'s report prints `role holders: cashier 1`, but the count is computed over
`inArray(users.username, <this roster>)` — holders *within this roster*, not on the deployment.
Since D4 makes the transcript the audit record, that line reads as a hospital-wide count and is not
one. One sentence of text would fix it.

## 2026-08-24 · T2's gate · within-row refusals are not collected

**MEASURED.** When a row's password AND pin both differ from an existing user's, the per-row loop
`continue`s after the password problem, so the transcript names the password only and the operator
meets the PIN refusal on a second run. The header says refusals are "collected rather than thrown
one at a time" — true ACROSS rows, not WITHIN one.

## 2026-08-24 · T2's gate · the unknown-role refusal echoes a roster value verbatim

**MEASURED.** `unknown role key(s): <whatever sat in roles>`. GC3 and V9 concern the password and
PIN fields, and both hold — the gate enumerated all three `console.*` call sites and drove eight
malformed rosters plus seven malformed-JSON shapes through them without leaking either secret. This
is noted because the script's header claims no roster value other than a username or a role key ever
reaches a stream, which is literally accurate but worth knowing when reading a transcript.

## 2026-08-24 · T2 drill residue on the dev database

**MEASURED, disclosed, not cleaned.** Three accounts — `t2drill.asha`, `t2drill.ravi`,
`t2drill.meera` — exist on `hmis_dev` with five hospital-scope role assignments, created by flag ②.
**They cannot affect the suite by a wider margin than first stated:** `TEST_DATABASE_URL`'s base is
`hmis_test`, not `hmis_dev`, and `setupTestDb` appends `_${JEST_WORKER_ID}`, so the suite never
opens `hmis_dev` at all — a different base name, not merely a different suffix. Worth deleting
before `hmis_dev` is used for anything a person could mistake for real.

## 2026-08-24 · T3 · the assert-on graph, and it caught this session out TWICE

**MEASURED.** T3 raised a CHAIN HALT on D6's second half: `test/ops-lifecycle.e2e.test.ts:319` pins
`refId: "downtime"`, and that file was frozen to T3. T3 built the repoint, ran it, measured the
break, backed it out and shipped D6's payload half alone (AGENT-RULES §3(a)).

**The lesson, and it is a §2 ledger entry:** a plan's File Structure gives every file ONE OWNER, but
it does not model **which files ASSERT ON which files' behaviour.** That second graph is what a
widening change actually travels along. The compile sweep walked the payload's readers and found
them all; the break was two hops downstream, in a consumer of the value the payload produces.

**And the amendment that routed it walked the new graph ONE HOP AND STOPPED** — T3's gate then built
the repoint itself and found a THIRD reader, `consumer.test.ts:659`, inside T3's own file. So the
rule needs both halves: **walk the assert-on graph transitively to a fixpoint, AND include
assertions the widening task added in the same commit** — the third reader did not exist when the
sweep ran, because T3 wrote it while raising the halt.

## 2026-08-24 · T3's gate · D5's "ahead of BOTH" clause is not load-bearing

**MEASURED.** The gate built the mutant that places the lock between the
`mode_commissioning_is_initial_only` refusal and `getOperatingMode(tx)`. It **SURVIVED**, 4/4 green
across all 15 rounds of every case. That refusal is pure input validation on `input.to`, reads no
database state and throws unconditionally, so only "ahead of the READ" carries weight. Case C is not
serialised by luck — it is serialised by the lock preceding the read, confirmed independently by two
other mutants. The source comment was corrected in place; the shipped placement was always correct.

## 2026-08-24 · T3's gate · `FOR UPDATE` proven inadequate, by execution

**MEASURED, and worth keeping as the record of why D5 chose what it chose.** A mutant using
`select … FOR UPDATE` on the ledger in the identical position passes cases A, B and V11 — rows exist
to lock — and **fails case C 15/15**, leaving `commissioningExits=2`. The zero-row commissioning
exit is exactly the case a row lock cannot cover. D5's reasoning is now evidenced rather than
argued.

## 2026-08-24 · Book rows this run refuted BY EXECUTION

Recorded together because the pattern is the finding. Each was a stated mutant or expectation that
**could not fail**, and each would otherwise have shipped as green evidence proving nothing:

1. **R1** — "force the bound to 1 turn" is a no-op: on a healthy box `done()` is true on turn 0, so
   the test passes at exit 0 under both budgets. Phase 0 built the two-part mutant that works.
2. **V2's three named exceptions** — `auth.users.manage`, `auth.roles.manage`,
   `billing.credit.extend` are all HELD, so as controls they proved nothing. They were justified by
   *guards no route*, a different property from the one V2 asserts.
3. **V3's second mutant** — a parser that returns `[]` instead of throwing cannot fail, because on
   the real README every cell is recognised and the `throw` branch is unreachable. The mutant that
   discriminates SKIPS the shorthand row.
4. **D2's "the worker installs a smaller SUBSET"** — measurably false. `worker.module.ts` omits
   `ops` and adds `notify`; neither set is a subset of the other.
5. **V10's case-B expectation** — "exactly one appended row per round in all three" is false for B
   and could never have killed either mutant there, since shipped, no-lock and wrong-position all
   produce `appended=2`.
6. **V13's mutant** — cannot fail while T3's halt stands, because the shipped code IS that mutant.

**The generalisation for the ledger:** an Assertion Book written before any code exists is a set of
PREDICTIONS about what will discriminate, and this run refuted six of them. Rule 21 already says
never claim an assertion discriminates without building the mutant — **the corollary is that a
plan's stated mutant is itself a prediction, and a task that finds it cannot fail has discovered
something worth more than the kill it was asked for.**

## 2026-08-24 · T4's gate · leg 10 is provably NOT independently load-bearing

**PROVED, not hand-walked.** D9 says of its four legs that "no three of them catch what the fourth
catches". **That is FALSE for leg 10.** The gate's proof: leg 8 green implies the table agrees with
the decorators on all eleven rows; leg 9 green implies the table's guarded set equals `opsManifest`'s
three declared permissions; together, every guarded route demands one of the three, and the actor in
leg 10 holds all three — so **leg 10 cannot fail whenever legs 8 and 9 pass.** Leg 10 ⊆ (leg 8 ∧
leg 9): cheap redundancy, not a fourth independent leg.

The other three ARE independent and it is measured, each firing alone: **leg 8 alone** (a route
silently gains a decorator), **leg 9 alone** (a fourth declared permission guarding no route), **leg
11 alone** (the decorator groups swapped *and the table swapped with them*). Leg 11's uniqueness —
D9's central justification — holds only in that strong form, because 11c's original mutant dies on
leg 8 as well.

## 2026-08-24 · T4's gate · an ops decorator's SCOPE argument is unobservable in production

**MEASURED.** `permissions.ts:100` reads `if (h.scopeType === "hospital") return true;` **before**
`:101`'s `if (h.scopeType !== requiredScope) return false;`. A mutant changing **all seven** guarded
ops decorators from `"hospital"` to `"department"` SURVIVED 15/15 — R1's shape, a mutant that cannot
fail. The behaviour is intended (`:101`'s comment: *"no cross-level inference until org masters
exist"*) and the mechanism is covered elsewhere by `permissions.test.ts` and `rbac.e2e.test.ts`,
which use department and floor scopes.

**Why it is still worth recording:** all three seed paths — `seed-admin`, `seed-ops`, `seed-staff` —
assign **hospital scope only**. So on the live deployment an ops decorator's scope argument could be
wrong and **nothing would fail**. That is fine today and stops being fine the moment a
department-scoped grant exists.

## 2026-08-24 · main session · `gh run list --commit <SHORT-SHA>` returns `[]`, which reads exactly like §2.59's DID-NOT-RUN

**MEASURED, on myself.** §2.59 warns that a CI result has three states — green, red, and DID NOT RUN
— and that the third reports identically to the second. **There is a fourth thing that reports
identically to the third: an abbreviated SHA.** `gh run list --commit 03d4e90` returns `[]` silently;
`gh run list --commit 03d4e903a22ef281e26149fdcee2232c25f6b556` returns the green run. I briefly read
two commits as never-dispatched on exactly this basis.

**The rule: always query CI by FULL SHA, and treat an empty result as "the query was wrong" until the
full SHA has been tried.** The execute prompt already says "CI green by FULL SHA" — this is the
measurement that shows the word FULL is load-bearing rather than stylistic.

## 2026-08-24 · T5's gate · `deploy.sh` still carries a FOURTH hand-maintained copy of the rule-file census

**MEASURED, and it is the highest-value follow-up this run produced.** `deploy.sh:216` reads
`note "prometheus/{prometheus,alerts,alerts-backup,alerts-meta}.yml, …"` — the deploy's on-screen
manifest of what step 2 copied. **T5 had to hand-edit that brace-list precisely because nothing
enforces it**, in the very file whose "two hand-maintained lists" D8 was written to unify. Next time
it will be forgotten and the deploy will print a manifest omitting a file it just installed —
§2.77's shape surviving one level out.

**The fix is about six lines**: a fourth leg in `deploy-parity.test.ts` asserting the brace-list
equals `installedPrometheusFiles(stepTwo)`. **Deliberately NOT done in this run** — `deploy-parity.
test.ts` is T5's shipped file and its gate has already passed; adding a test leg to it after the
fact, with no task owning the work, is precisely the unowned scope creep this method exists to
prevent. **Booked for the next infra plan.**

## 2026-08-24 · T5's gate · flag ④ is evidenced but NOT reproducible from a checkout

**MEASURED.** The `promtool` drill files (`rules_test_fire.yml`, `rules_test_healthy.yml`) were
scratch and are gone, because the Files list is locked to five paths. So the alert rules were proven
once and **nothing re-runs that proof**. T5's phrase is the right name for it: *"the difference
between was-proven-once and stays-proven."*

**Deleting them was correct, and the gate found a second, executable reason beyond scope:**
`ruleFilesOnDisk()` globs `*.yml` in `docker/prod/prometheus/` excluding only `prometheus.yml`, so a
`rules_test_*.yml` committed beside the rules would have **failed leg 2 of the very test that commit
ships.** Not merely out of scope — self-defeating.

**What a later plan should ship, concretely** (from T5's gate): the drill files in a
**subdirectory** (`readdirSync` is non-recursive, so a subdir is invisible to the shipped parser —
verify that before shipping) · the healthy file carrying its `promql_expr_test` presence legs, as a
stated convention for every future rule file · a CI step running `promtool test rules` in the pinned
`prom/prometheus:v2.53.0` — **which is an OWNER action, because rule 10 forbids the build host
pushing `.github/workflows/*`** · and if that stalls, a fallback leg in `deploy-parity.test.ts`
asserting the drill file pins every series each rule's `expr` names.

## 2026-08-24 · T6's gate · V21 is the ONLY assertion standing between D10's fix and a total loss of interface-down detection

**MEASURED, and it is the cleanest §3.44 discharge this project has produced.** The gate built the
over-wide predicate — truncating the compared instant to whole seconds, so any sighting with
sub-second digits can never match and **every stale interface stays `up` for ever**:

| run | verdict |
|---|---|
| over-wide mutant vs **V21** | **DIED** — `- Array [ "01M0QSMW…" ] / + Array []` |
| over-wide mutant vs **V20** | **SURVIVED**, exit 0, `falseDown: 0` |
| over-wide mutant vs **the whole file** | **11 of 12 PASS** — V21 the sole failure |

**Every other assertion in the file, including V20 and the four pre-existing rows, passes against a
predicate that has disabled the feature entirely.** That is §3.44's claim — *a guard one term too
wide is invisible to every mutant in the set, because they only exercise the defect's own path* —
demonstrated rather than argued.

**And the reason V21 could catch it at all is a fixture decision:** the sighting is written by the
shipped `recordHeartbeat` and round-trips through Postgres, carrying sub-second digits, rather than
being hand-set. A hand-set whole-second fixture would have hidden the precision bug completely.

## 2026-08-24 · T6's gate · the anti-vacuity leg is what stops V20 becoming a green that means nothing

**MEASURED.** The gate built a probe that removes the race without touching any assertion —
awaiting the sweep fully *before* the heartbeat. Result: the **primary assertion PASSED**
(`falseDown: 0, unclassified: 0`) and only `expect(observed.heartbeatKeptItUp).toBeGreaterThan(0)`
failed, `Expected: > 0 / Received: 0`. A race test that has stopped racing looks exactly like a race
test that passes. **Every measured-race row in this project should carry an anti-vacuity leg naming
the interleaving it requires**; V10's and V20's now do, and the pattern is worth generalising.

## 2026-08-24 · minor, routed forward from the final corrections

- **`interfaces.ts`'s file header** was non-exhaustive after D10 (it described the sweep's claim as
  `WHERE status = 'up'`). **Corrected in place.** T6 was right to flag rather than fix it in-task —
  the sentence was TRUE for the property it argues and merely narrower, and a false statement must
  be fixed in-task while a true-but-narrower one is a finding to route.
- **`ops.controller.ts`'s provenance tag** attributed the 42/17 split to §B-MEASURED, which cannot
  contain it — production has never run `seed:roles`. **Corrected** to cite the shipped test that
  pins it. Every number was right; only the citation was wrong. Worth the fix precisely because that
  comment exists because a reader trusted its predecessor's provenance.
- **`deploy-parity.test.ts` cited `deploy.sh:432` and `:386`**, both invalidated by the five lines
  its own commit added to step 2 (actual `:437` and `:391`). **Corrected.** §2.60 arriving on the day
  a file was written, which is the fastest this project has seen it.

---

# Discovery review — the cross-task findings no per-task gate could see

One agent, reading all of 11d's commits together, `58e0e61..4f0685f`. Four findings, two MAJOR, all
executed. **None had been found by six coders and six gates.**

## MAJOR 1 · `seed:roles`'s census and its READY verdict assert database facts they never read

**Shipped by T1 (`fd24235`). Armed by `seed-admin.ts`'s early return, and by any deployment that is
not this one.**

`seedRoles()` computes its whole invariant from **source constants**: `held = modelPermissions()` union
`GRANTED_BY_OTHER_SEEDS.flatMap(...)`. It reads `role_permissions` **only** to decide `granted` vs
`already` per role. **MEASURED** on a database where only `seed:roles` had run:

```
report.declared=59  report.held=42  report.notYetModelled=17
role_permissions rows=54   distinct permissions ACTUALLY granted=33
claimed HELD but held by NOBODY: auth.agents.manage, auth.break_glass.review,
  auth.break_glass.use, auth.roles.manage, auth.temp_role.grant, auth.users.manage,
  ops.downtime.generate, ops.interface.manage, ops.mode.set
```

And the verdict follows the fiction — giving every model role a holder was the ONLY thing needed to
get `ready=true` on that box, while nine of the claimed forty-two were held by nobody.

**Why it is not academic.** `seed-admin.ts:18-22` returns **before** every `grantPermissionToRole` on
any deployment that already has an admin. So the day `authManifest` grows a permission, production's
`seed:admin` can never grant it — while `heldPermissions()` counts it held immediately, **and V2's
orphan leg stays green because it reads the same constant.** That is **MAJOR 4's exact mechanism
reproduced inside the artefact built to abolish it**, and Plan 11e is booked to work on `auth.*`.
(`seed-ops.ts` is safe by contrast: it re-grants unconditionally on every run.)

**On production TODAY the numbers happen to be right**, because `seed:admin` and `seed:ops` have both
run there. That is luck, not design — and §B-MEASURED is the proof that "which seeds have run" is not
knowable a priori: it found `seed:opd` had **never** run despite the README instructing it.

**What closes it, cheaply:** `seedRoles` already issues an `existingGrants` query. Widen it from
`inArray(rolePermissions.roleKey, modelKeys)` to every row, derive `held` from the **intersection** of
the static model and what the database actually holds, and report both numbers when they differ — so
`GRANTED_BY_OTHER_SEEDS` becomes a claim the run VERIFIES rather than one it repeats.

**Consequence for flag 3:** the execute prompt already requires reading the
`users -> role_assignments -> role_permissions` join back and comparing it **against the role model, not
against the script's own report.** This finding is why that instruction is load-bearing.

## MAJOR 2 · a pre-11d `ops.mode_changed` row is now POISON, and the loss is silent by construction

**Shipped by T3 (`4daacf4`). Armed by the next deploy, and certainly by the next consumer.**

`events.ts` gained `changeId: z.string().min(1)` — **required, no default, no version bump** — and
`handleModeChanged` opens with `modeChanged.payloadSchema.parse(e.payload)`. Every `ops.mode_changed`
row already in a live `events` table lacks that field. **MEASURED**, old-shaped payload through five
dispatch cycles:

```
alerts raised = 0
event_deliveries: status=parked  attempts=5
  last_error: invalid_type  path:["changeId"]  expected string, received undefined
event_dead_letters: 1        consumer.poisoned events: 1
```

**Control**, identical payload plus `changeId`: **1 alert raised, delivered in one cycle.**

**Three arming paths**, from the dispatcher's own query (`status is null or status = 'retrying'`):
a mode change appended but not yet dispatched when the worker restarts — **and a deploy runs inside a
maintenance window, exactly when somebody declares `downtime`** · a delivery sitting at `retrying`
when the image changes · **any new consumer**, whose cursor starts at 0 and replays every historical
mode change with no delivery row. Each costs 5 attempts plus 30 s of backoff and **blocks that
consumer's whole in-order stream**, then dead-letters.

**And nothing anywhere notices.** Enumerated: `consumer.poisoned` has **zero subscribers** in the
tree; `event_dead_letters` is read by exactly one thing — `retention/sweep.ts:388`, which **deletes**
from it; no rule in `alerts.yml`, `alerts-backup.yml` or the new `alerts-meta.yml` reads either; no
metric, no screen, no email. **A dispatch cycle that parks an event is a SUCCESSFUL run to
`HmisSchedulerJobStale*`.** Retention is inert, so dead letters accumulate silently and for ever.

**What closes it:** `changeId: z.string().min(1).optional()` with `refId: payload.changeId ?? payload.to`
in the consumer, until the last legacy row is out of every consumer's window — or an explicit version
bump with a legacy branch. **Separately and larger: something has to watch `consumer.poisoned`.**

## MINOR 3 · the two new seed scripts disagree about what `!! NOT READY` means to the shell

**T1 vs T2 — the convention several files honour that no test protects (3.34/3.45), caught in the
act.** Measured on one database, exit VALUE from a file:

| script | verdict printed | exit VALUE |
|---|---|---|
| `seed:roles` | `!! NOT READY / !! NO USER HOLDS ANY OF THE 9 ROLES` | **0** |
| `seed:staff` | `!! NOT READY / !! role(s) holding ZERO permissions` | **1** |

`seed-ops.ts` — the precedent both were told to copy — also exits 0. **T2 improved on the convention
and T1 inherited it, and nothing tests either.**

**The consequence is in the deploy path.** The execute prompt's phase-6 step 4 says *"re-run
`seed:roles` and confirm it reports `already` and exits 0"*. **`seed:roles` exits 0 unconditionally** —
while reporting orphaned permissions, undeclared strings, or that no user holds any role. The
machine-readable half of that check carries no information, and an operator chaining
`seed:roles && ...` under `set -e` gets a green light from a run that named real problems.

## MINOR 4 · `refType: "operating_mode"` now holds two incompatible kinds of `refId`

**T3 wrote the field, T4 repointed the consumer, and the plan never mentions the existing rows** — the
compile sweep walked the payload's readers and then the assert-on graph, but never the **persisted
data**. After the deploy, pre-11d alerts carry the mode WORD and post-11d alerts carry a ULID, with no
migration and no discriminator.

**2.49 in its positive direction, which is the sharper half:** grepping `apps/web/src` for every use
of `refId`/`refType` returns **three hits — two type fields and one word in a comment. No component
reads either value.** Nothing in `apps/core` reads `alerts.refId` back either. **So the capability D6
exists for has no consumer anywhere** — while T4's commit message says "the mode alert can finally
deep-link" and two source headers say the same. The risk is that 11e's screens read those sentences,
assume every `operating_mode` row carries a ULID, and produce a dead link for every pre-deploy alert.

## Outside the brief · D7 watches the email path; the alert the README promises for a mode change does not travel it

The README's own table says mode changes reach the owner **"not email — as an in-app alert through
the alerts bell"**. T5's three rules watch Alertmanager, its notification failures, and the
Prometheus-to-Alertmanager link. **Nothing watches the in-app path** — outbox, dispatcher,
`kernel.alerts`, the `alerts` row, the bell — which is the path a mode alert actually takes, and which
MAJOR 2 shows can drop an alert into a dead-letter table nobody reads. **MAJOR 3's headline was
"nothing watches the alert path itself"; 11d closed the half that carries five rules to an inbox and
left the half that carries the sixth to a browser.**

## What the reviewer looked for and did NOT find (method stated, so the clean answers count)

- **Advisory-lock key-space collision** between T3's `pg_advisory_xact_lock(hashtext('hmis.operating_mode'))`
  and the scheduler's session-scoped `pg_try_advisory_lock(hashtext($1))` — they share one key space,
  and a collision would block a mode declaration behind a job or silently skip a job tick. Computed in
  Postgres over all eleven keys: **DISTINCT_KEYS = 11 OF 11, no collision**, and
  `hashtext('hmis.operating_mode') = 774876239` independently corroborates D5.
- **A second door on the mode ledger** — `changeOperatingMode` is the only non-test writer of
  `operating_mode_changes` in the tree. One door, and T3 closed it.
- **The three closure invariants' different exception policies** — principled, each anti-vacuity-checked
  appropriately to what it exempts.
- **Wrong-order seed run** — executed `seed:opd` then `seed:staff` before `seed:roles`: the verify leg
  catches it, names the fix and exits 1.
- **SoD bypass via `seed:staff`** — `assertNotSodPair` is enforced at ACT time, never at assignment
  time, so there is nothing for a roster to bypass.
- **`zod` reachable in the production image** and **`compose run` stdin** (`-T` defaults true) — both
  fine, and the stdin failure mode is loud rather than silent.
