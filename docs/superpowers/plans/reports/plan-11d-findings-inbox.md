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
