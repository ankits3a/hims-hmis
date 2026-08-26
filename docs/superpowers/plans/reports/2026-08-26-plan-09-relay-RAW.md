# Plan 09 — the RAW pipeline relay (127 entries)

> **THIS FILE IS AN ARCHIVE, NOT A BRIEF. NO TASK BRIEF MAY EVER POINT AT IT.**
> It is 136KB / ~34k tokens, and under [`EXECUTE-METHOD-V3.md`](../../EXECUTE-METHOD-V3.md) §9.1 a
> brief cites by NUMBER and never by file. Pointing an agent here re-bills 34k on every one of its
> tool calls — the exact cost ledger §2.101 was written to measure. `grep` it; do not read it.
>
> **The distilled version is [`2026-08-26-plan-09-relay.md`](2026-08-26-plan-09-relay.md)** (11KB),
> and that one is still the right thing to read: it carries the load-bearing RULES — what changed,
> the landmines, what not to simplify away, the flag-flip order. **This file is the record behind
> it.**
>
> ## Why it is committed at all
>
> It survived only as an untracked file in a shared working tree, one `git clean` from gone. When
> Plan 09a's close asked whether it could be deleted, the answer given from memory was *"its
> substance is committed"* — and measurement refuted that: **127 numbered entries here against 164
> lines there**, with the majority of entries carrying facts findable in no committed file. The
> distillation preserves the rules; it does not preserve the 127 measured facts behind them.
> **A distillation is not an archive, and asserting equivalence from memory is the class of claim
> this project's evidence standard exists to stop.**
>
> Committed RAW rather than curated, deliberately: curating costs judgment and risks dropping the
> one entry that mattered, while committing costs 136KB in a repository that already carries a
> 10,840-line generated migration snapshot. **The failure mode removed is unrecoverable; the failure
> mode created is a large file nobody reads.**
>
> ## A sample of what is here and nowhere else
>
> `coupon_redemptions.cycle_no` and the real DD10 index key · that there is **no** partner-statement
> header or line table, and why T7's import had to land on `receivable_expectations` instead · the
> exact accrual idempotency index name · that the IST clock is duplicated again in
> `modules/membership/coupon-rules.ts` — which is what led Plan 09a's close to find **nine**
> hand-written copies of the hospital clock and pin them in `test/ist-clock-parity.test.ts` ·
> that the golden harness under `modules/membership/golden/` is NOT Plan 06's and has its own schema
> · that `adjustment_rules` is not where an instrument lives despite its own column comment saying
> so, and that a task following that stale comment hits a closed door in a frozen module.
>
> *Committed 2026-08-26 during Plan 09a's close. Authored by the Plan 09 pipeline session, which
> measured its own error and recommended this disposition rather than deletion.*

---

# Plan 09 relay — untracked scratch, APPEND ONLY

## 2026-08-25 · T1 (schema, modules, flags, lint rule) → every later task

**1. FOR T2–T8 — the two `errors.ts` unions are CLOSED for the whole phase.**
`modules/membership/errors.ts` and `modules/partners/errors.ts` are named in T1's Files list and in
NO other task's, while T2–T8 all modify `index.ts` and several modify `manifest.ts`/`events.ts`. So
every refusal this phase can make is already spelled in those two unions (they were written wide on
purpose — recognition, entitlements, coupons, import, statements, reconciliation, and one
`*_disabled` code per flag). **If your task needs an error code the union does not carry, that is a
PLAN DEFECT: report it with evidence. Do not widen the union (outside your Files list) and do not
borrow a neighbouring code.**

**2. FOR T3, T5, T7, T8 — the PERMISSION SET is closed by T1, for the same reason.**
`scripts/seed-roles.ts` and `test/seed-roles.test.ts` hold the reachability invariant (every
declared permission is granted or entered in `NOT_YET_MODELLED` with its reason) plus README parity;
both are T1's alone. All fourteen strings this phase will need are therefore already declared:

- membership (7): `membership.instrument.read`, `membership.instrument.recognise`,
  `membership.grace_honor.request`, `membership.grace_honor.approve`, `membership.catalog.manage`,
  `membership.import.run`, `membership.reconcile.operate`
- partners (7): `partners.counterparty.manage`, `partners.agreement.manage`,
  `partners.attribution.issue`, `partners.ledger.read`, `partners.statement.import`,
  `partners.receivable.operate`, `partners.pnl.read`

**Guard your routes with these.** Declaring a NEW permission on a manifest fails `seed-roles.test.ts`
(census 73, held 50, not-yet-modelled 23) and the README parity leg — in a file you may not edit.
That is a plan defect to report, not to work around.

**2a. A CONSEQUENCE T5 AND T8 MUST KNOW.** DD18 grants only the counter's four. `membership.import.run`
and `membership.reconcile.operate` are in `NOT_YET_MODELLED`, so **T5's reconcile-queue screen and
import route are reachable by NOBODY until the owner grants them.** That is DD18 working as written
(minimum authority, no published role model, catalogs seeded at commissioning), not an oversight —
but T8's runbook should name it as an owner step beside the flag flips.

**3. FOR T4 (and T2) — `coupon_redemptions.cycle_no` exists and the DD10 index key is
`(coupon_id, cycle_no)`, not `(coupon_id)`.**
DD5 (append-only), DD10's index as literally written, and O-4 (a released coupon is redeemable
again) are jointly unsatisfiable: a release cannot UPDATE the redeemed row, so it must be a second
row — and then an index keyed on `coupon_id` alone would refuse the re-redemption O-4 exists to
permit. `cycle_no` is the narrowest fix and is documented at length in `schema/membership.ts`.
**T4's writer must, inside the DD10 lock, set `cycle_no` = the number of RELEASE rows already
recorded for that coupon.** A second redemption at the same cycle is still refused by
`coupon_redemptions_single_use_uq` (mutant-verified), so D3's two mutants are unaffected. A release
row is `state='released'`, `released_of_id` = the redemption it negates, `amount_paise` 0.

**4. FOR T7 — THERE IS NO partner-statement header or line TABLE, and this is the plan's own
seventeen-table budget, not an omission by accident.** The plan names sixteen tables across its DDs
plus `commission_accrual_subjects`; the one free slot went to `import_quarantine` (T5 needs it
first, and T5 cannot create a table either). So T7's statement import must land as:
- one `receivable_expectations` row per statement line — the columns are already there
  (`statement_ref`, `statement_period`, `statement_line_no`, `dispute_reason`, `state`), with a
  PARTIAL unique index `receivable_expectations_statement_line_ux` on
  `(counterparty_id, statement_ref, statement_line_no) WHERE statement_ref is not null` so one
  statement cannot be imported twice; a line quoting an attribution we never issued is a row with
  `attribution_id = null` and `state = 'disputed'` (V1);
- unparseable/quarantined statement rows in `import_quarantine` with `source = 'partner_statement'`
  and `batch_id` = the statement's own reference (that column is plain text precisely so it can
  name either parent).
**If T7 concludes it genuinely needs another table, that is a HALT** (a second migration is on the
halt list) — report it as a plan defect rather than generating `0023`.

**5. FOR T3, T4, T5, T6, T7 — `events.test.ts` in both modules does NOT pin a frozen name list.**
It asserts (a) every event carries its module key and a well-formed name, (b) `MEMBERSHIP_EVENTS` /
`PARTNERS_EVENTS` equals what `events.ts` DEFINES, in source order, and (c) the plan-named events are
present. So you may add events to `events.ts` without touching the test — **provided you also add
them to the exported `*_EVENTS` array in source order.** That was deliberate: `events.ts` is in your
Files lists and `events.test.ts` is in nobody's but T1's.

**6. FOR T6 — the accrual idempotency index is `commission_accruals_basis_event_ux` on
`(subject_id, basis_event_id)`.** Adjustment and kicker rows carry `subject_id = null` and
`basis_event_id = null`, and Postgres treats NULLs as distinct, so they are unconstrained by it.
`commission_accrual_subjects` is unique on `(agreement_id, invoice_id, direction)` and is the row to
upsert-then-`FOR UPDATE`. `partnersManifest.subscriptions` is `[]` and `manifests.test.ts` records
"app-only until T6" in as many words — when you land the four subscriptions, move `partners` out of
the `["ops", "membership", "partners"]` line and into the shared list in that same test.

**7. MIGRATION FACT (all tasks). `0022_plan_09_membership_partners.sql`, journal idx 22.** One hand
edit to the generated file was required and is commented in place: `drizzle-kit` emits every FK
before every index, but the DD4 composite FK references the PAIR `(id, payee_class)`, so
`counterparties_id_payee_class_ux` had to be HOISTED above the `ALTER TABLE … ADD CONSTRAINT` block.
Left in generated order the migration fails outright with *there is no unique constraint matching
given keys for referenced table "counterparties"* — measured here before the move. If any later
phase regenerates a migration touching `counterparties`, watch that ordering.

**8. LINT (all tasks): bare `loadConfig()` is now an ERROR under `**/*.test.ts`** (`eslint.config.mjs`,
`no-restricted-syntax`). Pass an explicit env object:
`loadConfig({ DATABASE_URL: "postgres://unused", SECRET_KEY: process.env.SECRET_KEY! })`.

**9. `truncateAll` (all tasks): sixteen of the seventeen new tables are in the patients-group
statement and `import_quarantine` has its own.** No `restart identity` on that statement — assert seq
ORDER, never seq VALUES, in any test you write against these tables.

## 2026-08-25 · T1 GATE (independent re-run) → T6, T7, and anyone adding a constraint assertion

**10. THREE of `0022`'s CHECK constraints have NO shipped assertion anywhere, contrary to T1's
own §2.67 note.** T1's report says every constraint it did not mutate "IS exercised by a shipped
test that observes a real rejection quoting the constraint's own name". Measured here by grepping
every `toThrow(/…/)` in `schema/membership.test.ts` and `schema/partners.test.ts` — thirteen
constraint names are asserted, and these are NOT among them:

- `commission_accruals_direction_ck`  (T6)
- `commission_accrual_subjects_direction_ck`  (T6)
- `counterparties_status_ck`  (T7, O-7's `suspended`/`terminated` path)

The constraints THEMSELVES are present and correct in the shipped migration and snapshot (read and
verified here) — this is a gap in TEST COVERAGE, not in the schema. It matters because
`commission_accruals_direction_ck` is what stops a third `direction` value evading
`commission_accruals_payable_class_ck`, which only constrains `direction = 'payable'`. If your task
writes a `direction` or a `status`, assert the refusal in your own file rather than assuming one
already exists.

**11. `catalogs-empty.test.ts` truncates before it measures, so it cannot see a MIGRATION that
seeds a catalog.** Its `beforeEach` runs `truncateAll`, so its "a freshly migrated database has
empty catalogs" leg is really "an empty database is empty"; the leg that carries DD3's weight is
the `scripts/` scanner (which the A6 mutant kills correctly). Nothing in Plan 09 seeds a catalog
from a migration, so there is no live defect — but if any later task is tempted to put a catalog
row in a migration, that test will NOT catch it.

## 2026-08-25 · T2 (the two adjustment sources, the golden harness) → T3, T4, and anyone pricing an instrument

**12. FOR T4 — `ResolvedInstruments` CARRIES `billGrossPaise`, AND THE COMPOSER MUST FILL IT.**
K4's minimum-BILL threshold cannot be evaluated inside `propose`: the signature is
`(ctx, line, grossPaise)` and `PricingContext` has no notion of an invoice total, so a per-line
comparison would refuse every "spend X, get Y" coupon on a multi-line bill and a post-discount
comparison would let one instrument disqualify another. The threshold is therefore compared against
a REQUIRED field on the seam — `ResolvedInstruments.billGrossPaise`, the sum of every line's
`grossPaise` BEFORE any adjustment. It is deliberately non-optional: a default would silently
suppress every minimum-bill coupon in the hospital.

**The composition T4 writes is therefore TWO passes, and the second is the cheap one:**
```
const base   = await loadPricingContext(db, { at: now, tags });
const gross  = priceInvoiceLines(base, lines).reduce((n, l) => n + l.grossPaise, 0); // pure, sync
const ctx    = { ...base, sources: [...base.sources, membershipSource({...r, billGrossPaise: gross}),
                                                     couponSource({...r, billGrossPaise: gross})] };
```
`priceInvoiceLines` is pure and synchronous, so the first pass is arithmetic and not I/O. If T4
concludes a different basis is correct, that is a design change to state, not one to make quietly —
`golden/fixtures/m07-min-bill-before-discount.json` pins the current one with hand-computed
workings.

**13. FOR T3 — the shape of the value you must produce is `instruments.ts`, and two fields are NOT
on it.** (a) There is NO `at` / timestamp: the money moment is `PricingContext.asOf` and a second
one in the value would be a second time authority inside the money path (O-2's own reasoning).
Your `resolveInstruments(db, {…, at})` keeps `at` as a QUERY parameter. (b) There is NO `verified`:
O-1 says a grace-honored instance is HONOURED and accrues nothing, so verification gates T6's
accrual and never the counter's benefit. Set `ResolvedCoupon.benefit.benefitKey` to the coupon's own
code — it becomes `AdjustmentCandidate.ruleKey`, which is what the D-8 audit record shows a member.

**14. FOR T3 — `couponUnusableReason` is exported for YOU, because the SOURCES swallow the reason.**
`AdjustmentCandidate.rejected` is a CLOSED union in the frozen `modules/tariff/types.ts` —
`over_cap | unknown_category` — and neither member means "out of hours", "expired" or "under the
minimum bill". So `couponSource` proposes NOTHING for an unusable coupon rather than inventing a
rejected candidate, and the recognition surface is the only place that can tell a member why. The
six reasons map one-for-one onto codes T1 already spelled in the closed `MembershipErrorCode` union
(`coupon_expired`, `coupon_not_yet_valid`, `coupon_out_of_window`, `coupon_min_bill_not_met`);
`retired` and `off_weekday` map to `coupon_not_applicable`.

**15. THE CAP REJECTS, IT DOES NOT CLAMP — and the mutant is the reason, not a preference.**
An over-cap ask produces a REJECTED candidate carrying the ASK (`manualDiscountSource`'s shipped
rule, transplanted). Book row B4's mutant ("cap the clamped value") CANNOT DIE under clamping
semantics, because `Math.min` is commutative: "cap then clamp" and "clamp then cap" are the same
number, so a clamping cap is untestable by construction. Measured here: B4 DIED only under
rejection. If any later task shows a capped benefit to a user, show the ask and the refusal, not a
silent payout at the cap.

**16. THE IST CLOCK IS DUPLICATED A THIRD TIME, in `modules/membership/coupon-rules.ts`.**
`modules/opd/time.ts` and `modules/billing/time.ts` already each carry it and billing's header says
why (cross-module internals are not importable). `istDayIndex`, `istMinuteOfDay` and
`istWeekdayMondayZero` (0 = Monday, matching `coupon_definitions.weekday_mask`) are exported from
`modules/membership/index.ts` — **import them from there rather than writing a fourth copy.**
Expiry is an IST CALENDAR-DAY comparison, not an instant comparison (B6).

**17. THE GOLDEN HARNESS IS `modules/membership/golden/` AND IT IS NOT PLAN 06'S.** It has its own
`fixture-schema.ts` (flat object, no discriminated union), its own manifest pinned by name and its
own directory-contents assertion. **A task adding a fixture MUST add its filename to the manifest
list in `golden/golden.test.ts`** — that file is T2's, so if a later task needs a fixture there,
that is a Files-list question to raise, not an edit to make.

## 2026-08-25 · T2 GATE (independent re-run) → T3, T4, and anyone writing a Book-row mutant

**18. THE PLAN'S OWN B6 DISCRIMINATING INPUT DOES NOT DISCRIMINATE — CONFIRMED INDEPENDENTLY HERE.**
§6 T2's Assertion Book names B6's input as *"an instrument expiring on a date, priced at 18:31 UTC the
same day"*. Measured at this gate: with `valid_to = 2026-09-30T00:00:00Z`, the instant
`2026-09-30T18:31:00Z` is **already the next IST day**, so the correct IST-calendar-day predicate and
the "compare raw `Date` instants" mutant BOTH answer *expired* — the row's stated input kills nothing.
T2 substituted `2026-09-30T13:00:00Z` (18:30 IST, the SAME IST day), where IST says live and the UTC
mutant says expired, and the mutant DIED there (`Expected: true / Received: false`) — reproduced
independently at this gate against a fresh mutant. The plan's stated instant is still exercised, as
`asOf` in `golden/fixtures/m06-ist-midnight-expiry.json`. **This is a defect in the plan's Book TEXT,
not in the shipped code**, and it is recorded here because the same trap will bite any later task that
takes a Book row's "discriminating input" as discriminating without checking it: an IST-day predicate
and a UTC-instant predicate agree everywhere except inside the 05:30 window, and 18:31Z is outside it.

**19. FOR T3/T4 — `adjustment_rules` IS NOT WHERE AN INSTRUMENT LIVES, DESPITE WHAT ITS COLUMN COMMENT
SAYS.** `kernel/db/schema/tariff.ts:105` comments `source_key` as *"'rule' | 'manual' …; Plan 09 adds
'coupon','membership'"*, which predates DD2. Under DD2 Plan 09 adds NO `adjustment_rules` row at all:
the two instrument sources are RUNTIME FACTORIES over `ResolvedInstruments`, and the catalogs are
`membership_plans` / `coupon_definitions`. A task that follows that stale comment and tries to seed an
`adjustment_rules` row will also hit a closed door it cannot open — `tariff.controller.ts:114` types
the field `z.enum(["rule", "manual"])`, and `modules/tariff/` is frozen for the whole phase.

**20. CHECKED AT THIS GATE AND CLEAN, so nobody re-derives it:** all three IST clock copies
(`opd/time.ts`, `billing/time.ts`, `membership/coupon-rules.ts`) use an identical `IST_OFFSET_MS`,
`DAY_MS` and `Math.floor((t + offset) / DAY_MS)` day index — they cannot disagree on a day boundary.
The two frozen sources both satisfy B7 already (`standingRuleSource` emits `sourceKey: "rule"` with
`key: "rule"`; `manualDiscountSource` emits `"manual"` with `key: "manual"`), so `runContest`'s
precedence map is intact for all four sources. And every fixture's declared
`ResolvedInstruments.billGrossPaise` equals the sum of its own expected lines' `grossPaise` — the
harness does not assert that, so it was checked here; if a later task adds a fixture, check it again.

## 2026-08-25 · T3 (recognition, the sealed gate, the rate limit, grace-honor) → T4, T5, T7, T8 and the main session

**21. PLAN DEFECT — `apps/core/test/deploy-parity.test.ts` PINS THE SEED CENSUS AND §6.0's S14 MOVES IT,
and that file is in NO task's Files list.** §6.0 records `deploy-parity.test.ts` as "checked and clear"
on the grounds that this phase changes no compose service, no config directory and no restart loop.
That is true, and it misses the SEED-ORDER block three paragraphs further down the same file:
`expect(order).toHaveLength(8)` over every `compose run --rm api node dist/scripts/*.js` line in
`deploy.sh`. S14 requires T3 to add `seed-membership.js` to that script, which makes the census 9 and
the shipped assertion RED. Measured here, not predicted.

The sweep's own remedy for the identical shape elsewhere — **S11, the SPA route census in
`caddyfile-parity.test.ts`** — is that the file pinning the number joins the Files list of every task
that moves it. T3 applied that remedy: the integer is corrected to 9, with the reason written in
place, and the deviation is disclosed in the task report. **The alternatives were both worse:**
dropping the `deploy.sh` line recreates exactly the S3/S14 production gap (a grace-honor lane no
deployment can approve), and shipping the line without the census bump means pushing a RED tree.
**Nothing else in that file was touched.**

**22. FOR T5, T7, T8 — `deploy-parity.test.ts`'s census is now 9. If your task adds another seed
line, it moves again and the file is still in nobody's Files list.** T5's `import-holder-book`
deliberately does NOT go into `deploy.sh` (§6.0 S14), so T5 is unaffected.

**23. PLAN DEFECT — DD16's `perk` WRITE HAS NO OWNER IN PLAN 09.** DD16 says this phase writes
`opd_queue_entries.perk = true` "through the OPD module's index". Measured at T3:
`modules/opd/index.ts` exports `registerConsultStartGuard`, `getEncounter`, `getVisit`, `listVisits`,
`patientTimeline`, `classifyVisit`, `loadOpdConfig`, `orderQueue`, `nextInQueue`, `classOf` — and NO
writer for `perk`; the write belongs where a queue entry is created (`modules/opd/queue.ts`); and NO
task in Plan 09 names ANY file under `modules/opd/`. T3 therefore ships the READ half only:
`membership_plans.queue_perk` is surfaced on the recognition response as `RecognisedMembership.queuePerk`
and rendered at the counter, and `recognition.ts` carries `RECOGNITION_PERK_NOTE` saying so in place.
**T8's runbook should name this beside the flag flips: the E-32 queue perk is CONFIGURABLE and
VISIBLE this phase but not yet ACTED ON.**

**24. FOR T4 — the seam's exact signature, and the one field you must fill.**
`resolveInstruments(db, { patientId?, presentedCodes?, at, billGrossPaise? })` is exported from
`modules/membership`. It defaults `billGrossPaise` to 0, so relay note 12's two-pass composition
still applies verbatim — spread the real gross over the result (`{ ...r, billGrossPaise: gross }`) or
pass it in. **It takes NO actor**: its caller is the billing composer, whose subject is an invoice's
own patient. Confidentiality is decided by the two surfaces that DO take a caller —
`recogniseForActor` and `instrumentSearchProvider` — both through `visiblePatientIds`.

**25. FOR T4 — `membership_instances.status` HAS NO CHECK CONSTRAINT, and recognition closes it in TS.**
Migration 0022 constrains `counterparties.status` and the two accrual directions and not this column.
`recognition.ts`'s `instanceStatus()` maps any unrecognised value to `cancelled` — unknown prices
NOTHING — so `ResolvedMembership.status` is always one of the four `instruments.ts` declares. If you
write a status from another lane, it must be one of `active|expired|suspended|cancelled` or the
counter will silently stop honouring the card.

**26. FOR T4/T5 — the coupon benefit blob accepts BOTH `kind` spellings.**
`kernel/db/schema/membership.ts` documents `coupon_definitions.benefit` as `{ kind: 'percent'|'flat' }`,
written before T2 fixed `BenefitTerm.kind` at `percent_bps|flat_paise`. `recognition.ts` parses both
and normalises to T2's union (`percent` → `percent_bps`, `flat` → `flat_paise`). A commissioning file
written against either spelling works; **do not "fix" the column comment into a third spelling.**

**27. THE `search_audit` TABLE IS NOW WRITTEN BY TWO ROUTES, and that is what makes the DD8 limiter
work for card lookup.** `GET /membership/instruments/lookup` calls `recordSearch` on every EXECUTED
lookup, exactly as `GET /search` does, because `checkSearchRate` COUNTS that table — a lookup route
that did not write the row would be both unlimited and unaudited. A REFUSAL writes no audit row and
emits `instrument.lookup_refused` instead (mutant-verified: writing refusals there makes every retry
extend the block). **A later task that adds another read-heavy route over the holder book must do the
same two things or the limiter will not see it.**

**28. NO TRIGRAM INDEX EXISTS ON `membership_instances.holder_name`, and the both-directions name
match pays for it in this process.** Migration 0021 indexes `patients.name`, `opd_doctors.display_name`,
`opd_departments.name` and `services.name` — not the holder book, and adding one is a second migration
(a HALT). So `search-providers.ts` matches the folded query and the raw query against the column
(the shipped `patientMatchCondition` rule) and adds a THIRD lane for the case that rule cannot serve
— a LATIN query against a DEVANAGARI-stored holder — by folding the stored side with
`normalizeForSearch` in this process, over the rows that contain Devanagari, and only when the query
itself has none. **It is a scan of that subset.** The right fix is a stored folded column with its own
trigram index; it is routed to the owner as a later-phase item rather than smuggled in here.

**29. `SearchEntity` GAINED `"instrument"` AND THE ALIAS TABLE GAINED `card`.** `@card:<instanceId>`
is a chip the palette and the parser both understand, and `chipToken("instrument", id)` renders
`@card:<id>`. `kernel/search/registry.ts`'s `ENTITY_ORDER` does NOT list `instrument`, so the group
sorts LAST in the palette — that file is frozen for this phase and the fallback is deliberate
(`indexOf === -1` → `ENTITY_ORDER.length`), not an oversight. If the owner wants card hits higher,
that is a one-line 11h-file change for a later phase.

**30. FAIL-FIRST WAS NOT CAPTURED FOR T3's SUITES, disclosed rather than manufactured.** The
implementation landed before the tests within this single attempt, no prior attempt of T3 pushed an
artifact whose SHA could be cited (§2.4's auditable precondition), and §2.4 forbids manufacturing a
red by mutating shipped state. The discrimination evidence is the five Book-row mutants, each built
as a separate scratch file beside its source, run isolated, and recorded DIED with expected-vs-received
in the task report.

## 2026-08-25 · T3 GATE (independent re-run) → T4, T5, T7, T8 and the main session

**31. THE `/membership/recognition` ROUTE IS A SECOND CARD-CODE DOOR, AND IT IS NEITHER RATE-LIMITED
NOR SEALED-GATED ON THE CODE LANE.** Measured at this gate with a probe spec beside the source
(deleted afterwards), against the SHIPPED code:

```
PROBE A — recogniseForActor(db, deskWithout patients.confidential.read,
                            { presentedCodes: ["AZ-4477"] })
        → memberships: [{"card":"AZ-4477","plan":"Invented Card"}]  patientId: null
```
`AZ-4477` is a card linked to a CONFIDENTIAL patient. The search provider correctly returns
`hits: [], total: 0` for the same code (C1, mutant-verified here). `recogniseForActor`'s code lane
does not consult `visiblePatientIds` at all — it gates only the PATIENT lane — so the caller learns
that the card exists, which plan it carries, its validity window and its benefit titles. It does NOT
learn the holder's name, the patient id (correctly null) or any identity field, which is why this is
recorded as a finding rather than a criterion failure: `RecognisedMembership` carries no identity.

Two consequences a later task must know:
- **`GET /membership/recognition?codes=…` is an EXACT-MATCH card-code lookup that writes no
  `search_audit` row and calls no limiter**, while `GET /membership/instruments/lookup` does both.
  DD15's sentence is *"card-code lookup goes through `checkSearchRate`"*; only one of the two doors
  does. Exact match makes enumeration far more expensive than the prefix route, but it is not zero,
  and a route that reads the holder book without writing the audit row is by relay note 27's own
  argument both unlimited and unaudited.
- The docstring above `recogniseForActor` says *"the sealed gate runs before any instrument row is
  read"*. That is true of the patient lane and NOT of the code lane, and the paragraph immediately
  below it states the code-lane behaviour deliberately (*"a card handed across a counter is a
  physical object in the room"*). **If the owner wants the two doors to agree, the fix is one
  `visiblePatientIds` call over the resolved rows' `patient_id`s inside `recogniseForActor` plus
  `checkSearchRate` on the recognition route — both inside T3's own files.** Routed forward rather
  than fixed here: a gate does not write code.

**32. A CARD WHOSE HOLDER WAS MERGED AWAY IS INVISIBLE IN THE SEARCH PROVIDER, WHILE RECOGNITION
STILL FINDS IT.** Measured at this gate against shipped code:

```
PROBE B — instrumentSearchProvider.run(… "MM-10" …)  → hits: [] total: 0
PROBE B — recogniseForActor(…, { patientId: <SURVIVOR> })  → ["MM-1000"]
```
Cause: `visiblePatientIds` filters `patients.status = 'active'` (`modules/patients/search.ts:88`),
and DD11 says an instrument is never re-linked, so the row still points at the LOSER, whose status is
`merged`. `visibleFor` therefore returns no visible id for it and the gate predicate excludes the
row. It FAILS CLOSED (a card is hidden, never exposed), so it is not a confidentiality defect — but
it is exactly the outcome DD11's own reasoning exists to prevent, *"the card would go dark at the
counter the day the hospital tidied its own duplicate records"*, arriving through the palette instead
of through recognition. **T5's reconcile queue and any later holder-book screen that searches by card
code will not see merged holders' cards.** The narrow fix is for `search-providers.ts` to run the
match's patient ids through `resolvePatientId` before `visiblePatientIds`, the way `recognition.ts`
already does — again inside T3's own files.

**33. VERIFIED INDEPENDENTLY AT THIS GATE, so nobody re-derives it:** all five of §6 T3's Assertion
Book mutants were rebuilt here from scratch (separate files beside the source, deleted afterwards)
and all five DIED at an ASSERTION, not at typecheck or timeout — C1 `Expected: 1 / Received: 2` with
the HITS leg still passing (the §2.89 count-only leak shape, reproduced); C2 the mutant limiter threw
where shipped returns `total: 1`; C3 `Expected length: 5 / Received length: 10`; C4 all three inputs
`Received promise resolved instead of rejected`; C5 both directions `- Array [ … ] + Array []`.
The SPA route census (21) and the deploy seed census (9) were both re-measured here by parsing the
shipped files, not taken from the report.

## 2026-08-25 · T4 (the billing integration: compose, consume, redeem, restore, release) → T5, T6, T7, T8 and the main session

**34. FOR T6 — `invoiceAccrualView`'s EXACT semantics, because DD12's arithmetic is only correct on
top of these definitions.** Exported from `modules/billing`'s index (DD19/S15), shape as the plan
names it, and every field is a SUM OF ROWS with nothing combined:
- `creditedPaise` — Σ `credit_notes.net_paise` over notes NOT marked entered-in-error. **A
  `clearance_discount` note carries NO lines**, so it moves this number and moves NO line's
  `creditedBasePaise`. That asymmetry is correct (the receivable moved, the eligible SERVICE base
  did not) and T6's ratio depends on it.
- `allocatedPaise` — Σ apply − Σ reverse, so an `allocation.reversed` already carries collected
  money back off the invoice. **Do not subtract it a second time.**
- `refundedPaise` — Σ **PAID** refund vouchers with `invoice_id = this invoice`. An ISSUED voucher
  moves nothing (the money has not left the drawer). Asserted both ways in `accrual-view.test.ts`.
- `enteredInError` — a mark with `doc_type = 'invoice'`. **NOTHING in billing writes one today:**
  `markEnteredInError` marks RECEIPTS, and an invoice's own entered-in-error grammar is the
  `correction` credit note. The view reports it because DD12's `target = 0` branch needs it and
  `patientOutstandingPaise` already reads it; the test shapes the row directly and discloses it.

**35. FOR ANYONE WRITING A CONTENTION TEST IN THIS PHASE — TWO MEASURED TRAPS, BOTH FOUND BY A
BOOK-ROW MUTANT THAT SURVIVED.** T4's first contention suite raced `issueInvoice` and held the
counter row `FOR UPDATE`; the D2 mutant (`consumeEntitlements` with its `FOR UPDATE` deleted)
SURVIVED both legs 2/2. Why, measured:
- **HOLD `FOR NO KEY UPDATE`, NOT `FOR UPDATE`.** An INSERT into a child table takes `FOR KEY
  SHARE` on the parent row, and `FOR KEY SHARE` conflicts with a held `FOR UPDATE` — so a
  lock-less writer blocks too and "still pending at 400 ms" is true of both implementations.
  `FOR NO KEY UPDATE` is the weakest mode that conflicts with the writer's `FOR UPDATE` and NOT
  with the FK's `FOR KEY SHARE`. Under it: shipped BLOCKS, mutant settles in 75 ms.
- **`issueInvoice` IS ALREADY SERIALISED END TO END, BY `nextDocNo`.** Its first act inside the
  transaction is `UPDATE document_series SET next_no = next_no + 1 RETURNING`, which holds a
  row-exclusive lock on the ONE series row until COMMIT. Every concurrent invoice issue in the
  hospital queues there, BEFORE any instrument is touched. A race run through `issueInvoice`
  therefore measures the SERIES lock: the lock-less mutant scored **0/20** over-consumption that
  way and **19/20** when the writer was raced directly. **If your task's race matters, drive the
  WRITER, not the invoice.** (Same trap will apply to T6's accrual consumer if it races through
  a dispatch cycle.)

**36. FOR T5 — C5's LAPSED RESTORE IS A COLUMN, NOT A QUEUE ROW.** `restoreEntitlements` sets
`entitlement_movements.lapsed_restore = true` when the counter's own validity had lapsed, and
writes **no `patient_match_queue` row** — DD9 says "the flag is what the reconcile queue shows", and
T4's Files list carries no queue writer. **The reconcile queue must READ that flag** (the queue's
`reason` union already spells `'lapsed_restore'`). Nothing else surfaces it today.

**37. FOR T8's RUNBOOK — three things the flag flip needs beside it, all measured here.**
(a) **Presented coupon codes cannot reach the money path over HTTP.** `IssueInvoiceInput` carries
`couponCodes?`, but `billing.controller.ts`'s `issueInvoiceBody` has no such field and that file is
in NO task's Files list this phase. Bundled coupons (a card's own plan coupons) DO reach it through
`resolveInstruments`; a coupon handed across a counter does not, until a later phase widens the
body. (b) **A `MembershipError` thrown out of `issueInvoice` is a 500, not a typed 409.**
`billing.controller.ts`'s `toHttp` ladder has arms for BillingError/TariffError/OpdError/… and none
for MembershipError; the fix is one line in that frozen file. The two refusals that can reach it are
`entitlement_exhausted` and `coupon_already_redeemed`, and BOTH are narrowed out before pricing, so
each is reachable only by a genuine race or by a bill that wins one entitlement on more lines than
the counter holds. (c) The flag is `MEMBER_BENEFITS_ENABLED`, default false, and with it off
`priceDraft` reads no membership table at all.

**38. FOR EVERY LATER TASK — `MEMBER_BENEFITS_ENABLED` IS READ IN `invoices.ts`, NOT THROUGH
`loadConfig()`, AND THE REASON IS F1.** `loadConfig()` requires `DATABASE_URL` + `SECRET_KEY`, which
CI never sets on a request path (`kernel/worker/jobs.ts` carries the same scar in its own header),
and the caller that would normally hand the value down — `billing.controller.ts` — is frozen. The
one key is parsed with the same `z.enum(["true","false"])` spelling, and `entitlements.test.ts` pins
the two readers against each other **by execution** for all six inputs so the duplicate cannot
drift. If your task needs a flag on a non-controller code path, do the same and pin it the same way.

**39. ENVIRONMENT — THE `grep` IN THESE AGENT SHELLS IS A `ugrep` WRAPPER THAT CAN SILENTLY SKIP A
FILE.** Measured here: `grep -c "update" apps/core/src/modules/membership/entitlements.ts` printed
NOTHING and exited 1 while `command grep -c` on the same file printed 3. The file contained a stray
NUL byte (introduced invisibly while authoring, since fixed), which makes both GNU grep and the
wrapper treat it as binary — but the wrapper reports it as **no match**, which is indistinguishable
from a clean sweep. **Use `command grep` for any claim of the form "token X appears nowhere",** and
check new source files for NUL bytes: `python3 -c "print(open(P,'rb').read().count(b'\x00'))"`.
This is §2.51's class — an instrument that cannot fail loudly.

**40. THE ENTITLEMENT/BENEFIT LINK IS `benefitKey`, AND IT WAS T4'S CHOICE TO MAKE.** Nothing shipped
before this task connected `membership_plans.benefits[].benefitKey` to
`entitlement_counters.benefit_key`; the plan names both and never says how a counter is consumed.
T4's rule: **a counter is consumed when a benefit term carrying its `benefit_key` WINS a line**, one
unit per line, and a term with no counter is an unlimited percentage benefit. Two cards carrying the
same key (DD11's merge duplicate) resolve in ARRIVAL order via `counterForWinner`. If T5's reconcile
queue or a later screen shows entitlements, it must use the same key equality.

## 2026-08-25 · T4 GATE (independent re-run) → T5, T6, T7, T8 and the main session

**41. ALL SEVEN OF T4's KILLS REBUILT INDEPENDENTLY HERE AND ALL SEVEN DIED — plus the ONE T4
declared UNBUILT.** Every mutant below was authored fresh at this gate as a separate scratch file
beside its source, run isolated, and deleted (`git diff --stat HEAD` empty afterwards; the two
shipped `modules/billing/gate.*` files were briefly caught by a careless cleanup glob and restored
from HEAD in the same breath — disclosed rather than hidden, and the tree is byte-identical to
`fbebc66`).

- **D1** (flag gate replaced by `true`) — `1 failed, 11 skipped, 12 total`;
  `- Array [] / + Array [ {amountPaise: 10000, ruleKey: "consult-visits", sourceKey: "membership", …} ]`
- **D2 block** — `- {"after400ms": "pending"} / + {"after400ms": "settled"}` (mutant leg 83 ms
  against the shipped leg's full 400 ms block)
- **D2 race** — `- {"overConsumed": 0, "of": 20} / + {"overConsumed": 19, "of": 20}`
- **D3a block** — same pending/settled flip, mutant leg 72 ms
- **D3a race** — `Expected constructor: MembershipError / Received constructor: DatabaseError`
- **D3b** — `Received promise resolved instead of rejected. Resolved to value: {… "command":
  "INSERT", "rowCount": 1 …}`
- **D4** — `Expected length: 3 / Received length: 4` (two restore rows, one per line)
- **D5** — `Expected length: 1 / Received length: 2`, the extra row `state: "released",
  amountPaise: 0`
- **D6** — `error: partner_ledger_immutable: entitlement_movements rows are append-only (UPDATE
  refused)`. Confirmed as T4 disclosed: this row's kill is a RUNTIME REFUSAL BY THE TRIGGER, which
  is what the plan's own row specifies; it is not a typecheck death.
- **DV** (`invoiceAccrualView` ignoring credit notes) — 3 of 5 legs failed,
  `- "creditedPaise": 50000 / + "creditedPaise": 0` and the same on `creditedBasePaise`.
- **DORDER — the one T4 named as an UNBUILT class and did not claim.** Built here: `invoices.ts`
  with DD2's ruled source order reversed (`[…, coupon, membership]`). DIED at the shipped tie
  assertion — `- "membership", "coupon" / + "coupon", "membership"`. **The order ruling is
  mutant-covered; nobody needs to rebuild it.**

**42. HOW TO MUTATE AN INDEX WITHOUT MUTATING THE HOST — POSTGRES DDL IS TRANSACTIONAL.** T4's D3b
dropped `coupon_redemptions_single_use_uq` for real, could not recreate it (the duplicate row the
mutant had just proved could land violated it, and the table refuses DELETE by trigger), and needed
a `truncate`-and-recreate repair. **None of that is necessary.** Build the mutant inside a
transaction that is rolled back:

```
await withTx(db, async (tx) => {
  await tx.execute(sql`drop index coupon_redemptions_single_use_uq`);
  await expect(tx.insert(couponRedemptions).values(row({}))).rejects.toThrow(/…_uq/);
});
```
The failing `expect` propagates, `withTx` rolls back, and the index is restored byte-for-byte with
no repair and no window in which another run could see a schema without it. **T6 and T7 will each
want an index mutant (`commission_accruals_basis_event_ux`, `receivable_expectations_statement_line_ux`)
— use this shape, not a live `DROP INDEX`.**

**43. WORKER-DATABASE CENSUS, MEASURED AT THIS GATE.** `hmis_test_1..7` carry `coupon_redemptions`
AND `coupon_redemptions_single_use_uq` (repair verified good). **`hmis_test_8` is STALE at migration
15 and carries none of the Plan 09 tables; the un-suffixed `hmis_test` is at migration 2.** Neither
is a defect — they migrate on demand the first time a worker claims them — but T4's report line
"all eight worker databases that carry the table now carry the index" is true only because
`hmis_test_8` does not carry the table. **Do not read a fresh count off `hmis_test_8` and conclude a
migration is missing.**

**44. AN O-4 EDGE THE RULING DOES NOT COVER, AND THE OUTCOME DEPENDS ON ORDER.** `markEnteredInError`
collects release targets from the allocations it *itself* reverses (`dead.has(original.id)`
skips ones already reversed). So: allocate receipt R to invoice I, `reverseAllocation` it, THEN mark
R entered-in-error → `touchedInvoiceIds` is empty and **no coupon is released**, where marking R
first would have released it. Both end states are "receipt in error, allocation reversed". Neither
answer is obviously wrong (an unpaid invoice still stands, so the sale still happened), which is why
this is routed rather than fixed — but if a later phase widens O-4's triggers, this is the case to
rule on.

**45. CHECKED AND CLEAR AT THIS GATE, so nobody re-derives it.** (a) `previewInvoiceBody` and
`issueInvoiceBody` are plain `z.object`s and zod STRIPS unknown keys, so neither `patientId` nor
`couponCodes` is reachable over HTTP — T4's disclosed gap is inert rather than half-open, and no
caller can preview another patient's instruments. (b) `feeQuote` (`charge-rules.ts`) calls
`previewInvoice({ encounterId })`, so the counter's one-keystroke quote DOES compose the member's
benefit and cannot disagree with the invoice that follows — which is what T4's `previewInvoice`
interpretation exists to buy. (c) `accrual-view.ts`'s `creditedPaise` and `allocatedPaise` are
formula-identical to billing's own private `creditedPaiseOf`/`allocatedPaiseOf`; the seam cannot
drift from `invoiceSettlement`. (d) `allocations.kind` is only `'apply'|'reverse'` and
`refund_vouchers.status` only `'issued'|'paid'`, so the view's two CASE aggregates are total.

**46. THE ONE REFUSAL THAT CAN STOP A BILL, restated because it will reach a counter before a
screen does.** A bill that wins ONE entitlement on MORE lines than the counter still holds is
refused WHOLE (`entitlement_exhausted`), and over HTTP that is a **500**, not a typed 409 (relay
note 37b). Concretely: a member with one free consult left, billed for two consults on one invoice,
cannot be invoiced at all until the clerk splits the bill. The fix is one line in the frozen
`billing.controller.ts`; **T8's runbook should name this beside the flag flip, because the flag is
what arms it.**

## 2026-08-25 · MAIN SESSION (between pipelines A and B) → T8, and every task in pipeline B

**47. OWNER RULING, mid-phase: the phase FINISHES and the stop-loss is corrected to 6.9M.** The
4.5M tripwire fired on pipeline B's projection and the phase halted for the decision v3 §6 requires.
Pipeline A cost 583,827 subagent tokens per task against Plan 11d's 576,975 — agreeing to 1.2%, so
there was no overspend. The ceiling was set from a five-task phase's TOTAL and applied to an
eight-task phase. Nothing about your task changes; this is recorded so nobody reads the phase
document's stop-loss line and concludes the run is over budget.

**48. FOR T8 — RULED: relay note 46's 500 IS BEING FIXED, and your runbook must say so.** The owner
authorised converting the `entitlement_exhausted` refusal from a bare 500 to a typed 409 carrying its
reason. It lands as a MAIN-SESSION close remediation commit AFTER pipeline B, because
`billing.controller.ts` is frozen to every task in this phase — **do not attempt it yourself, and do
not add it to your Files list.** Write the runbook line in the FUTURE-CORRECT form: the entitlement
refusal is typed and explains itself, and a bill that wins one entitlement on more lines than the
member holds must be split by the clerk. Name it beside the `MEMBER_BENEFITS_ENABLED` flip, because
that flag is what arms it.

**49. FOR T8 — three more things §8 CLOSE already owes your runbook, from pipeline A's relay.**
(a) note 23 / F9: the E-32 queue perk is CONFIGURABLE and VISIBLE this phase but **not acted on** —
no task in Plan 09 owns a write to `opd_queue_entries.perk`. (b) note 10 / F7: three CHECK
constraints ship unasserted — if your task writes a `direction` or a `status`, assert the refusal in
your own file. (c) note 44: an O-4 edge whose outcome depends on the ORDER of `reverseAllocation` vs
`markEnteredInError`; routed, not fixed, and the case to rule on if O-4's triggers ever widen.

## 2026-08-25 · T5 (the holder-book import) → T6, T7, T8 and the MAIN SESSION — **HALT: THIS CHECKOUT IS NOT EXCLUSIVE**

**50. ANOTHER AGENT IS EDITING `/opt/hmis` AND RUNNING `pnpm verify` IN IT, CONCURRENTLY WITH THIS
PIPELINE. Measured, not inferred.** Between 14:20 and 14:33 UTC the working tree went from three
modified files to nine modified plus two untracked SOURCE files, and `/opt/hmis/.elev-verify.log`
— a detached verify log that is not mine — grew 2 882 bytes in a 45-second window while I watched
it (`stat -c %s` before/after; last line `apps/core test: PASS test/credential-lifecycle.e2e.test.ts`).
The work is an `auth.elevation.review` / temp-role-review feature:

```
 M apps/core/drizzle/meta/_journal.json      M apps/core/src/kernel/auth/temp-roles.ts
 M apps/core/src/kernel/auth/auth.controller.ts   M apps/core/src/kernel/db/schema/auth.ts
 M apps/core/src/kernel/auth/events.ts       M apps/core/test/seed-roles.test.ts
 M apps/core/src/kernel/auth/manifest.ts     M apps/core/test/temp-roles.e2e.test.ts
 M apps/core/src/kernel/auth/temp-roles.test.ts
 ?? apps/core/drizzle/0023_elevation_review.sql   ?? apps/core/drizzle/meta/0023_snapshot.json
```

**Three consequences every remaining task in this phase inherits:**

**(a) `pnpm verify` ON THIS HOST IS RED FOR REASONS OUTSIDE ANY TASK'S DIFF.** Measured detached,
exit VALUE 1 read from a file, started 14:22 at `e0f0b41`: apps/core **4 failed suites / 11 failed
tests**, 179 suites passed, 1484 tests total; apps/web 39 files / 218 tests all passed;
packages/contracts 4 suites / 21 tests all passed. The four failures, attributed:
- `test/seed-roles.test.ts` (4) — the census moved 73 → 74. The received array names the cause:
  `"auth.elevation.review"`, which exists only in the uncommitted `kernel/auth/manifest.ts`.
- `test/user-admin.e2e.test.ts` (2) — same string, same cause (`+ "auth.elevation.review"`).
- `test/temp-roles.e2e.test.ts` (1) and `src/modules/billing/gate.test.ts` (4) — **both PASS in
  isolation** (`jest --runInBand src/modules/billing/gate.test.ts test/temp-roles.e2e.test.ts`
  → `Test Suites: 2 passed, 2 total · Tests: 8 passed, 8 total`, exit 0). `gate.test.ts` failed the
  full run with `unknown SoD pair key: workflow_drafter_activator` — **rule 20's specimen exactly**:
  another agent's suite truncating a shared per-worker database mid-measurement.

**(b) MIGRATION `0023_elevation_review` IS APPLIED TO SEVEN WORKER DATABASES AND ITS FILE IS
UNTRACKED.** Census taken here (`information_schema.columns` for `temp_role_grants.reviewed_at`,
and `drizzle.__drizzle_migrations` counts):
`hmis_test_1 … hmis_test_7` — **carry it**, 24 migrations each · `hmis_test_8` — 15 migrations,
does not carry it · un-suffixed `hmis_test` — 2 migrations, does not carry it.
Recorded under AGENT-RULES §6 as a fact about the databases, **not** as something anyone should
undo: it is not this pipeline's migration and nobody here should delete the file or hand-edit the
journal. It does mean **every suite in this phase now runs against a schema no commit describes.**

**(c) THE PIPELINE'S SEQUENTIALITY PREMISE — one task at a time, no concurrent writer — DOES NOT
HOLD.** Two agents writing the same checkout void each other's verifies by F4 in both directions,
and neither can tell. T5 therefore **wrote no source file and committed nothing**, rather than
(i) corrupting the other agent's in-flight verify by writing while it ran, or (ii) reporting mutant
kills and counts taken from contaminated worker databases as if they were evidence. Rule 20 is
explicit that evidence taken in this window is unreliable, and rule 12 forbids reporting it anyway.

**What the main session has to decide before T5 is re-run:** whether the other lane is expected
(then the two must be serialised, or given separate checkouts and separate database prefixes), and
whether its commit lands before T5 restarts — because T5's own `pnpm verify` cannot be green until
`auth.elevation.review` is either committed with its role model or reverted by whoever owns it.

**51. FOR WHOEVER RE-RUNS T5 — the design work is done and none of it is lost; nothing was
written.** The findings that cost the reading, so they are not re-derived:
- `apps/core/test/caddyfile-parity.test.ts` currently pins `expect(routes).toHaveLength(21)`; T5's
  screen makes it **22**. Re-measure rather than trust this line.
- `apps/core/src/modules/membership/catalogs-empty.test.ts`'s script scanner flags any file under
  `apps/core/scripts/` that so much as NAMES a catalog table **by either spelling** — including the
  bare word `counterparties`. **`scripts/import-holder-book.ts` must import `importHolderBook`
  from the module index and name no table at all**, not even in a comment. `counterpartyId` is
  safe (`\bcounterparties\b` does not match it).
- `patient_match_queue` has **no writer anywhere in the repository yet** (grepped: only
  `schema/membership.test.ts` inserts one), so T5 is its first, and `reason = 'merge_duplicate'`
  has **no producer in Plan 09 at all** — DD11's "the merge surfaces the duplicate in the reconcile
  queue" is unowned, the same shape as DD16's `perk` write (relay 23) and for the same reason: the
  detection would have to live where a merge executes, in `modules/patients/`, which no task names.
  **T8's runbook should name it beside the perk.**
- `modules/billing/recon.ts`'s `parseReconCsv` is the shipped CSV precedent to follow (header
  required, 1-indexed line numbers matching a text editor, parse fully BEFORE any write), and
  `billing.controller.ts`'s `reconUploadBody` is the precedent for taking a CSV in a JSON body.
- There is **no error code for an unknown counterparty** in the closed `MembershipErrorCode` union
  (`unknown_counter` is the entitlement counter). The `holder_book_imports.counterparty_id` FK is
  what refuses; that is a gap to disclose, not to widen the union for.

**52. T5 WAITED FOR A CLEAN WINDOW AND THERE WAS NONE — recorded so the next attempt does not
repeat the wait.** From 14:33 to 14:44 UTC I polled `git rev-parse HEAD`, `git status --porcelain`
and the foreign verify log every 15 s. **HEAD never moved off `e0f0b41`**, the other lane's
modified set GREW (nine files → ten: `apps/core/test/user-admin.e2e.test.ts` joined it), and its
detached verify log grew 35 739 → 47 926 bytes and was then deleted — i.e. that agent finished one
verify and is iterating, not converging to a commit on any schedule this task could wait out.
T5 stopped there: writing source into that tree would have voided its in-flight verify (F4) as
surely as its writes void T5's.

## 2026-08-25 · T5 GATE (independent) → THE MAIN SESSION, T6, T7, T8 — **T5's HALT IS UPHELD, AND THE CONDITION HAS ESCALATED**

**53. THE HALT WAS CORRECT AND IT IS INDEPENDENTLY CORROBORATED. T5 shipped nothing, so every
acceptance criterion is unmet and the task FAILS — but the failure is environmental, not a defect
in the agent's judgement.** Two independent confirmations taken at this gate:

- **The lane T5 named COMMITTED while T5 was writing its report.** `fc9e49a`
  (`fix(core): close the emergency-elevation escalation …`, authored 14:46:40 UTC) contains
  **exactly the twelve files T5 listed** as the foreign working set — ten modified plus the two
  untracked drizzle files. T5 stopped polling at 14:44; the window it was waiting for opened
  2 minutes 40 seconds later. Its 11-minute bound (relay 52) was sound at the time and unlucky,
  not careless — and see 54 for why waiting longer would not have helped either.
- **Migration `0023_elevation_review` is now TRACKED**, so relay 50(b)'s "applied to seven worker
  databases with no commit describing it" is CLOSED. `hmis_test_1…7` were not corrupted; they were
  early. Nobody needs to repair anything.

**54. THE CONTAMINATION IS STILL LIVE AS THIS GATE WRITES, AND IT IS GROWING FASTER THAN IT WAS.**
Measured here, not inferred, `git status --porcelain` sampled every 20 s against `git rev-parse HEAD`:

```
14:47:06  clean  (only ?? .plan-09-relay.md)          <- tree genuinely clean for a moment
14:47:34  roles-admin.controller.ts modified          <- mtime, foreign
14:48:27  2 modified
14:49:07  3 modified   + db/schema/patients.ts
14:49:47  4 modified   + modules/patients/uhid.ts
14:50:07  5 modified   + modules/patients/search.ts
14:50:27  7 modified   + scripts/seed-registration.ts, drizzle/meta/_journal.json
14:50:44  8 modified   + apps/web/src/lib/admin-api.ts
          ?? apps/core/drizzle/0024_uhid_format.sql
          ?? apps/core/drizzle/meta/0024_snapshot.json
          ?? apps/core/test/roles-catalog.e2e.test.ts
```
HEAD never moved off `fc9e49a` throughout. **Two modified files became eight modified plus three
untracked in 3 minutes 10 seconds.** This is a second, DIFFERENT feature from the elevation one —
a UHID-format / roles-catalog lane — started immediately after `fc9e49a` landed. **The window does
not stay open. A re-run that simply waits will lose the same way T5 did.**

**55. `pnpm verify` IS RED ON THIS HOST RIGHT NOW, AT `fc9e49a`, FOR A REASON IN NOBODY'S DIFF.**
Run detached at 14:47:49, exit VALUE read from a file (`cat .t5gate-verify.exit` → `1`), 675 bytes
of log — it did not reach the suites at all. Typecheck PASSED; **lint** killed it:
```
/opt/hmis/apps/core/src/kernel/auth/roles-admin.controller.ts
  5:19  error  'inArray' is defined but never used  @typescript-eslint/no-unused-vars
✖ 2 problems (1 error, 1 warning)
```
That is the other lane's file caught MID-EDIT — an import added before its use. **T5's acceptance
line requires "detached `pnpm verify` exit VALUE 0 from a file"; that is unobtainable while another
agent is typing into this checkout, and it fails at LINT in ~40 s, long before any suite runs.**
Every remaining task in this phase inherits this: **a red `pnpm verify` here is not yours until you
have read the log and attributed it.**

**56. AGENT-RULES §6 CONDITION, LIVE: a NEW migration `0024_uhid_format` was generated during this
gate and is untracked, with `drizzle/meta/_journal.json` modified.** §6 is explicit that generating
one and letting a suite migrate it **mutates every per-worker database irreversibly and
`git checkout` does not undo it**. It is not this pipeline's and nobody here should touch the file,
the journal, or any `__drizzle_migrations` row — but **the worker databases are being re-shaped
underneath this phase for the second time in one afternoon**, and any census taken before 14:50 is
now stale. Re-measure rather than trust relay 43 or 50(b).

**57. WHAT THE MAIN SESSION MUST SETTLE BEFORE T5 IS RE-RUN — this is a scheduling decision, not a
coding one.** `/opt/hmis` is not an exclusive checkout and the pipeline's sequentiality premise is
false. One of these has to be true before T5 (or T6/T7/T8) can produce CRITICAL-tier evidence:
(a) the other lane is stopped and its work committed or reverted by whoever owns it; or
(b) the pipeline gets its own checkout AND its own test-database prefix — `JEST_WORKER_ID`-derived
names collide across agents, so a separate checkout alone is NOT enough; or
(c) the phase accepts non-isolated evidence, which for five Assertion Book mutants means accepting
assertions dressed as measurements, and rule 12 forbids it.
**Do not re-dispatch T5 into this tree as it stands.** It will burn a full CRITICAL-tier budget and
halt again on the same wall.

**58. T5's ROUTED FINDINGS ARE ALL VERIFIED TRUE AT THIS GATE — inherit them, do not re-derive.**
- `apps/core/test/caddyfile-parity.test.ts:297` pins `expect(routes).toHaveLength(21)`. Confirmed.
- `catalogs-empty.test.ts`'s `catalogsNamedIn` matches `\bcounterparties\b` **and five more**
  (`membership_plans`/`membershipPlans`, `coupon_definitions`/`couponDefinitions`,
  `membership_instances`/`membershipInstances`, `partner_agreements`/`partnerAgreements`,
  `partner_ref_map`/`partnerRefMap`) against **every** `.ts` under `apps/core/scripts/`, and
  `scriptsNamingCatalogs(SCRIPTS_DIR)` must equal `[]`. **`scripts/import-holder-book.ts` may not
  name ANY of the twelve spellings, not even in a comment** — T5 flagged `counterparties`; the
  bigger trap is `membershipInstances`, which an importer script is far likelier to reach for.
- `patient_match_queue` has **no production writer**: the only inserts in the tree are
  `kernel/db/schema/membership.test.ts` and the truncate in `test/helpers/db.ts`. Confirmed.
- `MembershipErrorCode` (errors.ts:16-34) carries no unknown-counterparty code; `unknown_counter`
  sits under the entitlement group at line 23. Confirmed — the FK is the only refusal.

**59. §3.43 SECOND-DOOR CHECK — THE PROVENANCE INVARIANT HAS A SECOND WRITER, AND A NAIVE TEST OF
IT WILL BE WRONG.** T5's acceptance line says *"every produced instance carries its import id and
row number"*. There is a second PRODUCTION writer to `membership_instances`:
**`modules/membership/recognition.ts:518`** (T3's grace-honor path) inserts with
`origin: "grace", verified: false` and **no `importId`, no `importRowNo`** — correctly, because no
import produced it. **So the invariant to assert is scoped: every instance with `origin = 'import'`
carries `import_id` and `import_row_no`.** An unscoped `every row has importId` assertion passes
today only because no grace instance exists in the importer's own fixture, and it becomes a false
red the first time the two suites share a database. Write the scoped form.

**60. T5's UNIMPLEMENTED DESIGN PROPOSALS (its relay 51 / interpretations) ARE RULED SOUND AT THIS
GATE — they are proposals, not shipped code, and a re-run may inherit them.** Checked against the
schema rather than against the report: (a) duplicate detection on `partner_sale_ref` exactly plus
`card_code` case-insensitively **within one drop only** is the only reading that satisfies E1 and E2
together, since `membership_instances_sale_ref_ux` is on `(counterparty_id, partner_sale_ref)` and
`card_code` carries an ordinary index by measurement; (b) set-equality header matching is what makes
E5 discriminable in BOTH directions; (d) `import_quarantine.raw` is jsonb and its schema header says
verbatim *"what the partner actually sent rather than what the parser made of it"* — the raw LINE is
the right payload, and `reason` is a separate NOT NULL column already; (e) `verified: true` for a
book row is consistent with C-17's schema comment (`origin='grace'` + `verified=false` waits *"until
a real book row arrives"*), and `activated_at` left null unless the drop carries the column is
consistent with O-6 (*"the ACTIVATION instant, never the sale date"*). **T5's refusal to implement
`reason = 'merge_duplicate'` is also upheld** — `patient_match_queue.reason` lists it, but detection
must live where a merge executes (`modules/patients/`), which no task in Plan 09 owns. It stays an
unowned ruling for T8's runbook, beside DD16's `perk` (relay 23/49a). `'lapsed_restore'` IS in the
schema's reason list, so relay 36's routing of it to T5 stands.

**61. ADDENDUM, 14:51 UTC — THE FOREIGN LANE HAS NOW MODIFIED A FILE ON T5's OWN FILES LIST.**
Final `git status --porcelain` at this gate, HEAD still `fc9e49a`:
```
 M apps/core/drizzle/meta/_journal.json      M apps/core/src/kernel/db/schema/patients.ts
 M apps/core/package.json          <-- T5 OWNS THIS   M apps/core/src/modules/patients/search.ts
 M apps/core/scripts/seed-registration.ts    M apps/core/src/modules/patients/uhid.ts
 M apps/core/src/kernel/auth/auth.module.ts  M apps/web/src/lib/admin-api.ts
 M apps/core/src/kernel/auth/roles-admin.controller.ts   M apps/web/src/screens/admin-users.tsx
?? apps/core/drizzle/0024_uhid_format.sql   ?? apps/core/drizzle/meta/0024_snapshot.json
?? apps/core/scripts/remint-uhids.ts        ?? apps/core/test/roles-catalog.e2e.test.ts
```
Two collisions, not one: **`apps/core/package.json` is on T5's Files list** (it is where
`import:holder-book` is registered) and it is dirty with somebody else's edit; and
**`apps/core/scripts/remint-uhids.ts` is a NEW file in `apps/core/scripts/`**, the directory
`catalogs-empty.test.ts` scans — so that suite's verdict now depends on a script this phase does not
own and cannot see the final form of. **This is no longer only an evidence problem; it is a
concurrent-edit collision on an owned path.** A T5 re-run would have to add a script line to a
`package.json` another agent is mid-edit in, and either agent's commit could drop the other's line.
Serialise the lanes (57) before re-dispatching anything in this phase.

## 2026-08-25 · T5 RE-RUN (the holder-book import) → T6, T7, T8 and the MAIN SESSION

**62. THE CONCURRENT-LANE CONDITION IS STILL LIVE, AND THIS RUN SHIPPED THROUGH IT RATHER THAN
HALTING AGAIN — here is exactly how, so a later task can copy it.** Measured at 14:53 UTC: TWO
foreign `pnpm verify` processes running in `/opt/hmis` (`ps -eo pid,etimes,args`, one of them a
claude session whose scratchpad id is not this one's), plus a foreign full `jest --passWithNoTests`
246 s in. HEAD moved twice under this task — `fc9e49a` → `0b26b61` (`feat(core,web): the role
picker …`) — and the foreign working set churned throughout. **Three mitigations, all cheap:**
- **`TEST_DATABASE_URL` IS THE ISOLATION KNOB AND NOBODY HAD USED IT.** `test/helpers/db.ts`
  derives the worker database from `<basename(TEST_DATABASE_URL)>_<JEST_WORKER_ID>`. Overriding
  the BASE NAME per run gives a private database family that no other agent's `JEST_WORKER_ID`
  can collide with: `TEST_DATABASE_URL=postgres://hmis:hmis@localhost:5433/hmis_t5iso pnpm
  --filter @hmis/core exec jest …` → `hmis_t5iso_1…`. Relay 57(b) said "a separate checkout alone
  is NOT enough, you also need a separate database prefix" — **the prefix half needs no checkout
  at all.** Every measurement in this task was taken that way and the databases were dropped at
  the end.
- **MUTANT SPECS ARE NAMED `*.mutant.spec.ts`, NOT `*.mutant.test.ts`.** `jest.config.cjs`'s
  `testMatch` is `**/{test,src}/**/*.test.ts`, so a `.spec.ts` is invisible to a plain `pnpm
  verify` — which matters on a SHARED checkout, where a mutant left in the tree for ninety seconds
  otherwise turns somebody else's verify red for a reason in nobody's diff. Run them with
  `jest --testMatch "**/*.mutant.spec.ts" <path>`.
- **THE THREE FILES ON T5's LIST THAT THE OTHER LANE HAD DIRTY RESOLVED THEMSELVES EXCEPT ONE.**
  `apps/web/src/locales/{en,hi}.json` were committed by the foreign lane in `0b26b61` and were
  clean when this task edited them. `apps/core/package.json` was NOT: it carried an uncommitted
  foreign `"remint:uhids"` line throughout. **It was staged with plumbing rather than `git add`** —
  `git hash-object -w` on HEAD's content plus this task's one line, then `git update-index
  --cacheinfo` — so the commit carries T5's line and NOT the other lane's uncommitted work, and
  the working tree keeps both. If your task's Files list collides with a live foreign edit, that is
  the shape: stage the blob you mean, never `git add` a file somebody else is mid-edit in.

**63. AGENT-RULES §6 FACT, MEASURED: migration `0024_uhid_format` is STILL UNTRACKED and is now in
EVERY database this phase touches, including ones created after it appeared.** It sits in
`apps/core/drizzle/`, so `migrate()` applies it to any database a suite creates — the fresh
`hmis_t5iso_*` family created by this task carried it from birth. It is not this pipeline's, nobody
here touched the file, the journal or a `__drizzle_migrations` row, and it needs no repair — but
**any worker-database census taken in this phase is a census of a schema no commit describes**, and
`hmis_test_*` is in the same position. Re-measure rather than trusting relay 43, 50(b) or 56.

**64. FOR T6/T7 — `import_quarantine` NOW HAS A WRITER AND ITS SHAPE IS FIXED BY IT.**
`modules/membership/import/quarantine.ts` exports `quarantineRows(tx, rows)` and
`listQuarantine(db, batchId)` through the membership index. **`raw` is `{ line: "<verbatim source
line>" }`** and nothing else — relay 60(d)'s ruling, implemented. T7's statement import puts its own
shape there under `source = 'partner_statement'` with `batch_id` = the statement reference; the
reader tolerates a `raw` it does not recognise (asserted, `line: ""`) rather than throwing, so the
two lanes' worklists cannot take each other down. The reason vocabulary is
`duplicate_key | inverted_validity | unknown_plan | missing_required | bad_date | short_row`, with a
total precedence order (`primaryReason`) in which **`duplicate_key` outranks everything**, because
that reason binds a SECOND row that may have no defect of its own.

**65. FOR T8's RUNBOOK — `entitlement_counters` HAS NO PRODUCTION WRITER IN PLAN 09, and T5
deliberately did not become one.** Grepped: the only `insert(entitlementCounters)` calls in the tree
are three test files and a schema test. `membership_plans.entitlements` is documented as *"the
counters a new instance is granted"* and **no shipped code defines that jsonb's SHAPE** — every
fixture in the phase writes `{}`, T4 (the entitlement owner) chose the `benefitKey` linkage but no
grant path, and T5's brief scopes it to the import lane. So an imported card grants its plan's
PERCENTAGE benefits (which need no counter) and **no counted entitlement at all** until a later
phase rules the shape. Inventing it inside T5 would have fixed a cross-task contract from one task's
file. **This is the third unowned write in this phase**, beside DD16's `perk` (relay 23/49a) and
DD11's `merge_duplicate` (relay 51/60) — all three belong in §8 CLOSE.

**66. THE PROVENANCE INVARIANT IS SHIPPED IN ITS SCOPED FORM (relay 59, applied).**
`importer.test.ts` asserts *"no instance with `origin = 'import'` has a null `import_id`"* and, as
the leg that can fail, shapes a `origin='grace'` row in the same database and asserts it HAS none.
An unscoped form would have been a false red the first time a grace instance shared a database.

**67. FOR T6/T7/T8 — TWO NEW EVENTS AND TWO NEW MENU/ROUTE FACTS.**
`MEMBERSHIP_EVENTS` is now five: `holder_book.imported` and `instrument.holder_linked` were appended
in source order (relay 5's rule, obeyed — `events.test.ts` untouched). The SPA route census in
`apps/core/test/caddyfile-parity.test.ts` is **22**, measured by running that suite, not predicted;
T7 and T8 each move it again. `membershipManifest.menu` now carries `/counter/reconcile` on
`membership.reconcile.operate`, which DD18 leaves in `NOT_YET_MODELLED` — **the import route and the
reconcile screen are reachable by NOBODY until the owner grants two permissions**
(`membership.import.run`, `membership.reconcile.operate`). That is relay 2a working as ruled, and
T8's runbook must name it beside the flag flips or the first operator will file a bug.

**68. AN UNKNOWN COUNTERPARTY IS A DATABASE ERROR, NOT A TYPED ONE — disclosed, not worked around.**
Relay 51/58 is confirmed: `MembershipErrorCode` carries no unknown-counterparty code and the union is
closed for the phase. `importHolderBook` therefore lets `holder_book_imports.counterparty_id`'s
foreign key refuse, which surfaces over HTTP as a **500** carrying the constraint name. The fix is
one code in T1's frozen `errors.ts`; it is the same shape as relay 37(b)'s `MembershipError` → 500,
and it belongs in §8 CLOSE beside it rather than in a task that may not edit the union.

**69. §2.62 DISCLOSURE — THE PUSH COALESCED TWO FOREIGN COMMITS, and it could not not have.**
Measured immediately before pushing: `git ls-remote origin main` → **`e0f0b41`**, while local `main`
already carried `fc9e49a` and `0b26b61` — **the other lane's two commits were sitting UNPUSHED on
local main**, and T5's commit `24aa8e9` sits on top of them. `git push origin main` therefore moved
the remote `e0f0b41..24aa8e9`, three commits in one push, and **CI runs only on the tip**: `fc9e49a`
and `0b26b61` get NO CI run of their own. The alternative — rebasing T5's commit onto `e0f0b41` —
was rejected because it would have published a branch that silently omits another agent's committed
work and would have changed the tree this task actually verified. **Nothing was rewritten and
nothing was reverted.** Whoever owns those two commits should know they are now published, so rule
15 binds them.

**70. WHAT `pnpm verify` ACTUALLY MEASURED, stated precisely because the tree was not still.**
Started 15:26:53 UTC at `0b26b61`, detached, exit VALUE read from a file → **0**. Totals:
`apps/core 188 suites / 1554 tests · apps/web 40 files / 231 tests · packages/contracts 4 suites /
21 tests`, zero failures anywhere. **The tree it ran against was `0b26b61` + T5's diff + the other
lane's UNCOMMITTED patients/UHID work** — which is NOT what was pushed, because none of that work is
in `24aa8e9`. It is additive (a UHID format change and its migration), it was green, and T5's own
suites assert nothing about UHID format, so the gap is disclosed rather than closed. **Then it moved
again:** `schema/opd.ts` at 15:32:29 and `modules/opd/appointments.ts` at 15:32:57 — a THIRD foreign
feature (episode/appointment numbers, migration `0025_episode_numbers`) — and a corroboration run
started at 15:32:44 caught it mid-edit: `manifests.test.ts` failed **to RUN** with
`opd/appointments.ts:59 TS2769 … Property 'appointmentNo' is missing`, while all 74 tests in the
eight suites passed. **`modules/opd/` is named by NO task in Plan 09** (relay 23 says so in as many
words), so that red is attributable with certainty. Every later task in this phase should expect the
same and should attribute before it debugs.

**71. A COUNT WART IN T5's OWN SUITES, DISCLOSED RATHER THAN RE-PUSHED — 9 TESTS RUN TWICE.**
`importer.test.ts` imports the `fixture()` helper from `column-maps.test.ts`, and importing a jest
test file REGISTERS ITS `describe` BLOCK in the importing suite. So the runner's
`importer.test.ts` line counts **28** where only **19** `it()`s are its own: column-maps' 9 execute a
second time inside it. Distinct T5 tests are **58 core (9 + 8 + 13 + 19 + 9-run-twice) + 9 web**;
the runner's workspace total therefore reads 9 higher than the distinct count. Nothing was padded to
hit a number — no number was targeted — and every one of those 9 genuinely passes both times. It is
left rather than corrected because the fix (inline the three-line reader, as T5's own mutant specs
already do) is worth less than a SECOND push, and §2.62 makes one push per task load-bearing: the
first commit of a coalesced push gets no CI run. **§8 CLOSE should fold it in with the other
one-liners.** The lesson generalises: **never import a helper from a `*.test.ts` file** — put it in
the importing file, the way `e*.mutant.spec.ts` did.

## 2026-08-25 · T5 GATE (independent re-run, the RE-RUN's gate) → T6, T7, T8 and the MAIN SESSION

**72. ALL FIVE OF T5's BOOK-ROW MUTANTS WERE REBUILT FROM SCRATCH AT THIS GATE AND ALL FIVE DIED —
and each was paired with a CONTROL spec of the same body against the SHIPPED importer, so a kill
cannot be a broken spec.** Every mutant was a separate `*.mutant.ts` beside its source (never an
edit to a shipped file), every spec self-contained (relay 71's lesson applied), run with
`jest --testMatch "**/*.mutant.spec.ts"` on a private `hmis_g5iso_*` database family (relay 62's
knob). Combined run: `Test Suites: 5 failed, 5 passed, 10 total · Tests: 7 failed, 7 passed, 14
total` — the five CONTROLS all PASS, the five mutants all fail at an ASSERTION (never a typecheck,
never a timeout):

- **E1** (idempotency keyed on the card number alone) — `- "accepted": 1, - "applied": 1 /
  + "accepted": 0, + "applied": 2`
- **E2** (last-wins: only the earlier row of a colliding key is dropped, silently) — card leg
  `- "accepted": 1, - "quarantined": 2 / + "accepted": 2, + "quarantined": 0`; sale-ref leg
  `- "accepted": 0, - "quarantined": 2 / + "accepted": 1, + "quarantined": 0`
- **E3** (auto-link above 0.5) — `expect(received).toBeNull() — Received:
  "01M0WSNX68RNTG9GM50818PVJJ"`
- **E4** (drop the overflow with no record) — `- Expected - 12 / + Received + 0`, the two
  `honoured: false` rows (memberNo 4 Vinayak Wagle, memberNo 5 Kamlakar Wagle) absent
- **E5** (map by position, §2.61's one-repointed-import shape: a mutant `column-maps` plus an
  importer whose ONLY change is that import) — DIED IN BOTH DIRECTIONS. Unknown shape: `Received
  promise resolved instead of rejected. Resolved to value: {… "columnMapVersion": "holder-book-v1",
  … "rowsAccepted": 1, "rowsTotal": 1}`. Transposed shape: `Expected: "Rukmini Sathe" / Received:
  "9820100113"`.
All scratch deleted; `git status` carries no `*.mutant.*` residue.

**73. CI IS GREEN ON `24aa8e9` — run 32866793610, 676 s — and on this host that is BETTER evidence
than a local `pnpm verify`, not worse.** CI runs typecheck + lint + the full suite against the
COMMITTED tree in an environment with no `apps/core/.env` (F1's trap), whereas a local verify today
runs against `24aa8e9` PLUS ~35 foreign modified files and two untracked foreign modules
(`kernel/episodes/`, `schema/episodes.ts`, migrations `0024`/`0025`) and a live foreign
`jest --runInBand` in the same checkout. **Every remaining task in this phase should watch CI on
its own SHA and say so, rather than reporting a local verify taken over somebody else's tree.**

**74. §3.43 SECOND DOOR, MEASURED — THE PARSER HAS `short_row` AND NO LONG-ROW CHECK, AND ONE
NARROW PATH LOSES DATA SILENTLY.** `parseHolderBook` flags `cells.length < headerCells.length` and
never the other direction; `mapRow` iterates the HEADER cells, so any cell beyond the header's
length is dropped without a word. Probed here against shipped code (both legs measured, spec
deleted):
- an unquoted comma inside the FINAL (`members`) column → `reasons: []`, the row IMPORTS, and the
  member name is truncated: `- "Chandra Rane, Jr" / + "Chandra Rane"`;
- an unquoted comma inside an EARLY column → the shift trips `bad_date` and the row QUARANTINES
  (`- Array [] / + Array ["bad_date"]`), so that half fails loud.
There is no CSV quoting anywhere in this lane (the `recon.ts` precedent is flat and unquoted), so
`"Kher, Vasanti"` is the same class. **T7's statement import will parse CSV in the same house
style — add the long-row leg there, and §8 CLOSE should fold a `long_row` reason in beside
`short_row`.** Not a criterion failure: no acceptance line and none of I1–I10 names this class.

**75. §3.43 SECOND DOOR — THE IMPORTER RESOLVES A PLAN BY CODE ALONE, NEVER BY OWNER.**
`loadPlanIdsByCode` filters only `inArray(membership_plans.code, …)`; `membership_plans.code` is
globally unique (`membership_plans_code_ux`) so nothing is ambiguous, but
`membership_plans.counterparty_id` is NULLABLE and is never compared against the drop's own
counterparty. **A drop uploaded under counterparty A that names a plan code belonging to
counterparty B is ACCEPTED**, producing instances on B's plan carrying `counterparty_id = A`.
**T6 must know this**, because its accrual is keyed on the instance's counterparty while the plan's
own owner says otherwise. Nothing in the plan requires the check, so it is routed rather than
called a defect.

**76. SECOND DOORS CHECKED AND CLEAN AT THIS GATE, so nobody re-derives them.** The only PRODUCTION
writers of `membership_instances` are `import/importer.ts` (insert), `recognition.ts:518` (the O-1
grace insert) and `import/match-queue.ts:354` (the human's link). The grace insert carries **no
`counterparty_id` and no `partner_sale_ref`**, so it can neither collide with
`membership_instances_sale_ref_ux` nor forge provenance — relay 59's scoped invariant is the right
one and is shipped. `covered_members`, `patient_match_queue`, `import_quarantine` and
`holder_book_imports` have exactly ONE production writer each, all T5's. The SPA route census was
re-measured here by parsing `router.tsx` directly (21 → 22, `/counter/reconcile` the only addition).
`MATCH_TRIGRAM_THRESHOLD` is byte-equal to `patients/search.ts`'s `TRIGRAM_THRESHOLD = 0.3` and uses
the same `%`-plus-`similarity()` shape, so the disclosed duplication is faithful.

**77. FIVE CODES IN THE CLOSED `MembershipErrorCode` UNION NOW SHIP WITH NO PRODUCER, and four are
in T5's own group.** Grepped here (`command grep`, relay 39's hazard respected):
`import_already_applied` (0 — T5 disclosed it; the re-send is a RESULT, not a refusal),
`import_row_quarantined` (0), `import_duplicate_key` (0), `import_range_inverted` (0 throwers — it
appears once, in `membership.controller.ts:48`'s 400-mapping set, because the inverted range
QUARANTINES rather than refusing), and `family_cap_exceeded` (0 anywhere — O-3's over-cap ADD has no
writer in Plan 09 at all, a fourth unowned write beside DD16's `perk`, DD11's `merge_duplicate` and
`entitlement_counters`). This is T1's deliberately-wide union working as designed, not a T5 defect;
**§8 CLOSE should list them so a later phase does not read an unused code as a shipped refusal.**

**78. A REPORT-FIELD INACCURACY ON THE RE-SENT-FILE BRANCH, disclosed for §8 CLOSE.** When a drop is
recognised by its `(counterparty_id, file_hash)` guard, `importHolderBook` returns
`rowsAlreadyApplied: rowsTotal` — ALL parsed data rows, including any the ORIGINAL import
quarantined. The acceptance line ("zero new rows and reports that it did") is met; the secondary
count can overstate what the hospital actually holds. One line, and the operator has the prior
`importId` to look at.

## 2026-08-25 · T6 (the accrual consumer, the agreements resolver, replay, the kicker) → T7, T8 and the MAIN SESSION

**79. FOR T7/T8 AND FOR §8 CLOSE — NO BILLING EMITTER STAMPS `occurredAt`, so on all four accrual
events it is the APPEND instant, not the money's own date.** Measured here while building Assertion
Book row F7(b): `allocateReceipt` (`receipts.ts:483`), `reverseAllocation` (`:575`),
`issueCreditNote` (`credit-notes.ts:471`) and `payRefundVoucher` (`refunds.ts:609`) all call
`<event>.make({ actor, payload, … })` with **no `occurredAt`**, so `defineEvent().make()` defaults it
to `new Date()`. A billing call made with an explicit back-dated `now` therefore produces an event
stamped with the WALL CLOCK. Plan 10 D5's contract is intact at the dispatcher (`dispatcher.ts`
projects `events.occurred_at` verbatim) — the gap is at the PRODUCER.

Consequences, all measured:
- **T6 is unaffected, and DD6 is why.** The agreement version is pinned at the INVOICE's `issued_at`
  — a stored column a back-dated issue really does move — so the accrual arithmetic never reads
  `occurredAt`. It orders the stream and stamps the row, nothing more. This is a second, unplanned
  argument for DD6's ruling.
- **F7(b)'s mutant is UNKILLABLE through real billing calls**: two payments made with back-dated
  `now`s carry the same wall-clock instant and resolve the same version. The mutant was killed
  against `DispatchedEvent`s carrying explicit instants — which is exactly what the dispatcher
  projects out of `events.occurred_at` — and the reason is written into `consumer.ts`'s header.
- **T7/T8: do not key anything on an accrual event's `occurredAt` and expect it to be the money's
  date.** Aging, statement periods and the kicker must read a stored date (`invoices.issued_at`,
  `membership_instances.activated_at`, `allocations.at`), never the event stamp. `recomputeKicker`
  takes `occurredAt` as an explicit CALLER argument for that reason.

**80. FOR T7 — `resolveAgreementAt(exec, counterpartyId, at)` AND `accrualTermsSchema` ARE YOURS TO
USE AND THE SCHEMA IS DELIBERATELY LOOSE.** `modules/partners/agreements.ts` is in T6's Files list
and in NO other task's, so the receivable lane cannot widen it. It is a plain `z.object`, which
STRIPS unknown keys rather than refusing them, and `ResolvedAgreement.rawTerms` carries the jsonb as
stored — so a commissioning agreement whose `terms` also names `receivableRateBps`, settlement days
or a dispute window parses fine here and T7 reads those off `rawTerms`. **What T6's schema REQUIRES
is `payableRateBps` and `eligibleCategories`** (the latter is not defaulted on purpose: an agreement
whose eligible set was never configured must fail loudly rather than silently accrue on every line
in the hospital). Only `status = 'active'` versions resolve, the window is `[effective_from,
effective_to)`, and an overlap resolves to the highest `version_no`.

**81. FOR T7 — O-7's `terminated` PATH IS THE AGREEMENT WINDOW, NOT A STATUS BRANCH, and nothing in
T6 reads `counterparties.status = 'terminated'`.** A termination is executed by closing the active
version's `effective_to`; an invoice issued after that instant resolves no version and accrues
nothing, while invoices billed before it keep settling under the terms that priced them — which is
exactly O-7's "new accruals stop at the term date, receivables stay collectible". **The gap to name
in T8's runbook: setting `status = 'terminated'` WITHOUT closing the agreement window stops
nothing.** `suspended` IS read, at handling time, and produces `state = 'escrowed'` rows (O-7, F9).

**82. FOR T7/T8 — `periodSettled()` READS `receivable_expectations`, and it is the only settled-period
signal this phase has a table for.** O-6 says a period whose partner statement has been settled is
closed to kicker recompute. Relay 4 rules that T7's statement import lands one `receivable_expectations`
row per statement line carrying `statement_period`; `kicker.ts` therefore treats a period as closed
once ANY line of that counterparty's statement for it reaches `state = 'matched'`. **T7 must write
`statement_period` in the same vocabulary `periodKeyFor` produces — `YYYY-Qn` / `YYYY-Mnn`, IST — or
the two lanes will never agree that a period is closed.** Re-opening a closed period is an owner
action and is NOT built.

**83. `partnersManifest` NOW DECLARES FOUR SUBSCRIPTIONS AND THE WORKER INSTALLS IT.**
`kernel/modules/manifests.test.ts`'s third census now reads: worker OMITS `["ops", "membership"]`,
ADDS `["notify"]`, SHARES nine including `partners`, `workerKeys` length **10**. `workerConsumers(db)`
carries `[PARTNERS_ACCRUAL_CONSUMER]: accrualConsumer(db)` and `worker-runtime.e2e.test.ts`'s
whole-equality pair list has a third entry. **A later task that installs anything worker-side moves
all three of those numbers.**

**84. THE EXPORTED SURFACE T7/T8 INHERIT, from `modules/partners/index.ts`:**
`accrualBasis` (DD12, PURE, over an `InvoiceAccrualView` + terms) · `accrualLedger({counterpartyId?,
invoiceId?})` (rows with `rateBps`/`agreementVersionNo` read off the ROW's snapshot — never the
agreement table, F7a) · `payableTotalPaise` / `escrowedTotalPaise` (O-7: no payable total includes an
escrowed row) · `appendAccrualDelta` · `attributeInvoice` · `resolveAgreementAt` / `requireAgreementAt`
/ `counterpartyFacts` / `rateSnapshotOf` / `accrualTermsSchema` · `accrualConsumer` /
`handleAccrualEvent` / `commissionAccrualEnabled` / `ACCRUAL_EVENT_NAMES` / `PARTNERS_ACCRUAL_CONSUMER`
· `replayAccruals` · `recomputeKicker` / `periodKeyFor` / `periodBounds` / `countActivations` /
`periodSettled` / `kickerBonusPaise`.

**85. A BACKFILL CANNOT REPRODUCE ROW GRANULARITY, ONLY THE TOTAL — measured, and the plan's own
DD12 property 4 is the accurate statement of it.** §6 T6's acceptance line says "flag-on + replay
reproduces the ledger exactly". Two different claims live under that sentence and only one of them
is achievable:
- **TRUE and asserted (`replay.test.ts`):** driven at the SAME observation points, `replayAccruals`
  and the dispatcher produce IDENTICAL ledgers, row for row — `[5 000, 2 800, 2 200, −2 200]` both
  ways. That is the design claim (the replay is `handleAccrualEvent` driven from the events table,
  not a second implementation) and it is what makes the backfill trustworthy.
- **FALSE as literally written, and disclosed:** a backfill run AFTER the fact writes ONE row per
  subject carrying the whole total (`[7 800]`), not the four the live lane wrote. `invoiceAccrualView`
  reports an invoice's LIVE money and takes no as-of parameter, so the first event replayed sees the
  final state and the three behind it find the subject already at target. **Same money, coarser
  audit granularity.** Reconstructing intermediate state would need `invoiceAccrualView(exec,
  invoiceId, asOf)`, which is T4's frozen file. Recorded as a plan-TEXT defect, not a code one:
  DD12 property 4 already states the real guarantee ("converge to the same total").

**86. `replayAccruals` REFUSES WITH THE FLAG OFF (`accrual_disabled`), deliberately.** Every row
would return `disabled` and the job would report a clean pass having written nothing — an operator
told their backfill succeeded when the reason it wrote nothing is the flag they forgot. It also
takes `{ fromSeq, toSeq, batchSize, env }`, and an unreadable payload PROPAGATES rather than being
skipped; `ReplayCounts.lastSeq` names where it stopped so a restart is `fromSeq`.

**87. `event_cursors.last_seq` TRACKS THE CONSUMER'S OWN SUBSCRIBED HEAD, NOT THE LOG'S.** The
dispatcher's window is filtered by `name = any(...)`, so an `advance.received` or a
`consumer.poisoned` behind the last subscribed event leaves the cursor legitimately short of
`max(events.seq)`. Measured here at 20 against a global 22; the first draft of T6's F5 leg compared
against the global head and failed for that reason. **Any later cursor assertion must compare
against the consumer's own subscribed maximum.**

**88. DD7's STATED FAILURE MODE IS NOT LITERALLY TRUE OF THIS DISPATCHER, and the ruling still
stands.** DD7 says a subscription that never registered "has no cursor, so flipping the flag later
starts from *now* and every earlier event is gone". Measured: `event_cursors.last_seq` DEFAULTS TO 0
(`schema/eventCursors.ts:5`) and `runDispatchCycle` reads `seq > max(cursor − lookback, 0)`, so a
consumer registered for the first time today would in fact re-read the whole surviving log, one
`batchSize` at a time. What DOES make the loss real is RETENTION — `events` is month-partitioned
since 0016 and `retentionSweep` prunes — plus the fact that a never-registered consumer's absence is
invisible. **The inversion T6 implements is unchanged and correct; only the mechanism in DD7's prose
is inaccurate, and §8 CLOSE should say so rather than let a later phase rely on the wrong reason.**

**89. FOR T7 — `payment.refunded` CARRIES NO INVOICE AND BILLING EXPORTS NO VOUCHER READER.** The
plan's §2 ground truth says `refund_vouchers` is "reachable through billing's index"; it is not —
`modules/billing/index.ts` exports `requestRefund`, `issueRefundVoucher` and `payRefundVoucher` and
no getter. `consumer.ts` therefore reads the one column (`refund_vouchers.invoice_id`) from the
KERNEL schema, which the module-isolation lint permits (it forbids another module's `src`, not
`kernel/db/schema` — `schema/partners.ts` references `invoices` for the same reason). An ADVANCE
refund carries a null `invoice_id` and is skipped. Same shape applies if T7 needs a voucher.

**90. THE COUNTERS T6 SHIPPED, for §8 CLOSE's census.** `apps/core/src/modules/partners/`:
`accrual.ts` (18 tests), `agreements.ts` (12), `consumer.ts` (11), `replay.ts` (5), `kicker.ts` (11),
`golden/` (13 — nine fixtures plus four manifest legs) = **70 new core tests**, plus one extended leg
each in `manifests.test.ts`, `worker-runtime.e2e.test.ts` and `seed-cursors.test.ts` (note 92).
Detached `pnpm verify` on a private database family, exit VALUE read from a file → **0**:
`apps/core 195 suites / 1637 tests · apps/web 40 files / 232 tests · packages/contracts 4 suites /
21 tests`, zero failures anywhere. FIFTEEN Assertion Book mutants built
(F1, F2, F3, F3b, F3c, F4, F5, F6, F7a, F7b, F8, F9, F10, F11-race, F11-block), each paired with a
CONTROL of the same body against shipped code; combined isolated run
`Test Suites: 3 failed, 3 total · Tests: 15 failed, 14 passed, 29 total` — every mutant dead at an
ASSERTION, every control green. All scratch deleted; the private `hmis_t6iso_1` database was dropped.

**91. AFTER T6, FOUR OF THE THIRTEEN `PartnersErrorCode` CODES HAVE A THROWER AND NINE DO NOT.**
Censused here with `command grep` over `new PartnersError("<code>"` across `apps/core/src`, tests
excluded (relay 39's hazard respected). **Thrown:** `unknown_agreement` (terms this lane cannot
read), `no_effective_agreement` (`requireAgreementAt`), `period_closed` (a settled quarter),
`accrual_disabled` (`replayAccruals` with the flag off). **Not thrown by anything:**
`unknown_counterparty`, `counterparty_suspended`, `counterparty_terminated`, `payout_class_blocked`,
`unknown_invoice`, `unknown_subject`, `accrual_replay_conflict`, `unverified_attribution` and
`receivable_disabled` (T7's). Three of those are deliberate rather than missing: a suspension
ESCROWS instead of refusing (O-7), an unverified instrument produces NO accrual rather than an
error (C-17), and `payout_class_blocked` rides the `payout.class_blocked` EVENT — the accrual lane's
outcomes are normal returns (`AccrualOutcome`), because a refusal thrown out of a dispatcher handler
parks the delivery and stops the lane. **`unknown_counterparty` and `unknown_invoice` appear in
`consumer.ts` as `AccrualOutcome` strings and are NOT the error codes of the same name.** This is
T1's deliberately-wide union working as designed; §8 CLOSE should list these beside relay 77's five
so a later phase does not read an unused code as a shipped refusal.

**92. PLAN DEFECT — A THIRD CENSUS FILE NOBODY OWNED, FOUND BY EXECUTION: `apps/core/src/kernel/worker/seed-cursors.test.ts` PINS `workerConsumers(db)`'s KEY LIST, and T6 moves it.** It asserts
`seedCursors(db)` returns exactly `[ALERTS_CONSUMER, NOTIFY_CONSUMER]`, and adding the accrual
handler makes it three. The file is in NO task's Files list and §6.0's sweep did not find it — same
shape as S2, S9, S11 and S14, and the same shape T3 hit with `deploy-parity.test.ts` (relay 21).
**T6 applied T3's ruled remedy**: the census is corrected in place with the reason written there,
and the deviation is disclosed in the task report. The alternatives were both worse — dropping the
`workerConsumers` entry recreates §6.0 S2's boot-error gap, and shipping the wire without the census
bump means pushing a RED tree (§2.87). Nothing else in that file was touched.

**A SECOND THING THAT FILE TAUGHT, and it is a real interaction with DD7 rather than a number.**
`seedCursors` (D10) seeds a BRAND-NEW consumer's cursor to `max(seq)` at deployment time — it SKIPS
the history that existed then, which is the 100-rows-per-tick flood D10 exists to prevent. Read
naively that is exactly DD7's "flipping the flag later starts from *now*". **It is not, and the
reason is that `replayAccruals` walks the `events` TABLE and reads no cursor at all.** The two are
complementary: the live lane starts at the head and writes nothing while the flag is off, and the
backfill fills the ledger from event history when the flag is flipped. **T7/T8: if a deployment runs
`seed:cursors` after this lands, the accrual cursor jumps to the head and the RUNBOOK's flag flip
must be followed by `replayAccruals` or the pilot's existing payments never accrue.**

**93. THIS HOST'S SHARED `hmis_test_*` FAMILY MADE A FULL `pnpm verify` READ 55 SUITES / 262 TESTS
RED FOR REASONS IN NOBODY'S DIFF — and relay 62's knob turned it into 0.** Measured here, three
runs, same tree:
- `pnpm verify` on the default `hmis_test_*` → exit VALUE 1, **apps/core 55 failed suites / 262
  failed tests**, spanning kernel/auth, kernel/workflow, billing, membership and patients. Signature:
  164 × `unknown SoD pair key: workflow_drafter_activator`, 72 × `duplicate key value violates unique
  constraint`, 10 × `deadlock detected`, `registration_config row 'main' is missing` — rule 20's
  specimen exactly (another agent's suite truncating a shared per-worker database mid-measurement).
- Two of the failed suites re-run in ISOLATION on the same shared family, `--runInBand`:
  `sessions.test.ts` + `workflow/instances.test.ts` → **2 passed, 21 tests, exit 0.**
- `TEST_DATABASE_URL=…/hmis_t6ver pnpm verify` (a private family no other agent's `JEST_WORKER_ID`
  can reach) → **55 failed suites became 2**, and both of THOSE were genuinely T6's (the census
  above, and a 12-trial race test over the 15 000 ms default). Fixed, re-run: **exit VALUE 0.**
**Every remaining task in this phase should run its final verify with a private
`TEST_DATABASE_URL` base name and drop the databases afterwards.** A red on the shared family is not
yours until you have re-run it privately.

**94. `git pull --rebase origin main` IS REFUSED IN THIS CHECKOUT WHILE THE FOREIGN LANE HAS
UNSTAGED WORK — `error: cannot pull with rebase: You have unstaged changes`.** Measured at T6's
finish block with ~50 foreign modified files in the tree. Stashing or committing them is not this
task's to do (they are another agent's), and `--autostash` would mutate the tree that agent is
working in. **The compliant substitute, and what T6 did:** `git fetch origin main` (read-only,
touches no working file), then confirm `git rev-parse origin/main` EQUALS `git rev-parse HEAD~1`
and that `git rev-list --count HEAD..origin/main` is 0 — i.e. the push is a clean fast-forward and
the rebase would have been a no-op. Rule 11's purpose is discharged by the confirmation, not by the
command. **T7/T8 will hit the same wall; if the remote HAS moved, do not `--autostash` — report it.**
T6's push moved the remote `24aa8e9..6fb10bd`, exactly ONE commit, so §2.62's coalescing hole is
closed for this task. **CI is GREEN on `6fb10bd1e64fee14c03726886939245ea941055d` — run
32877485404, 707 s, watched from this host with `ci-watch-host.sh`** (relay 73: on this box that is
better evidence than a local verify, because CI runs the committed tree with no `apps/core/.env` and
none of the foreign lane's ~50 uncommitted files).

## 2026-08-25 · T6 GATE (independent re-run) → T7, T8 and the MAIN SESSION

**95. VERIFIED INDEPENDENTLY AT THIS GATE, so nobody re-derives it: SEVENTEEN mutants were rebuilt
here from scratch (separate `*.gm.ts` files beside the sources, deleted afterwards, each paired with
a CONTROL of the same body against shipped code) and SIXTEEN died at an ASSERTION** — none at
typecheck, none at timeout. Isolation lines, four runs on a private `hmis_g6mut` family,
`--runInBand`: `Tests: 3 failed, 3 passed, 6 total` (pure base) · `4 failed, 7 passed, 11` (writer)
· `4 failed, 3 passed, 7` (consumer) · `5 failed, 3 passed, 8` (reader/kicker). The kills, with the
shipped assertion's own output: F1 `Expected: 4000 / Received: 5000` · F2 `Expected: 5000 / Received:
5600` · F3 `targetBase 38462 → 100000` · **F3b on §3 Q4's own fixture `45000/4500 → 63543/6354`** ·
F3c `Expected: 0 / Received: 10000` · F4 `Expected [] / Received [1 row of 10000]` · F5
`{cursor: 20, ["done"]} / {cursor: 19, ["retrying"]}` · F6 `"already_recorded" / "no_delta"` and, on
the STRONGER scenario (the credit note on the INELIGIBLE line, so the target really moves),
`duplicate key value violates unique constraint "commission_accruals_basis_event_ux"` — both guards
observed doing their own job · F7(a) `[[1000, 1]] / [[2000, 2]]` · F7(b) `[4000, 6000] / [4000,
20000]` · F8 `target 15000 / 0` · F9 `Expected length: 1 / Received length: 0` · F10 `Expected: 0 /
Received: 3` · F11 block `pending / settled` and race `overAppended 0 of 6 / 6 of 6`.

**THE ONE SURVIVOR, AND IT IS A FIXTURE-DATE ARTEFACT RATHER THAN A SHIPPED DEFECT.** A SECOND
flavour of F7(a) — a ledger reader that resolves the agreement in force at the WALL CLOCK
(`resolveAgreementAt(db, cp, new Date())`) rather than off the row's snapshot — SURVIVED the shipped
assertion. The reason is the fixture's dates: `accrual.test.ts`'s amendment is effective
`2026-09-01` and the build host's clock is `2026-08-25`, so "the version in force now" IS v1 today
and the mutant answers `[1000, 1]` like the shipped reader. The flavour the shipped leg DOES kill is
"take the latest active version" (`[2000, 2]`, above). **Consequence for whoever reads this after
2026-09-01: that leg's discrimination gets stronger, never weaker — but any later task copying this
fixture shape should move the amendment BEHIND the clock if it wants the wall-clock flavour killed
too.** The shipped code is correct in both flavours; only the assertion's reach is date-dependent.

**96. §3.43 — TWO OTHER DOORS REACH THE SAME PAYABLE QUANTITY, AND BOTH ARE OPEN. Measured at this
gate against SHIPPED code, no mutant involved.** The invariant T6 establishes is `Σ deltas = target`
per SUBJECT, and a subject is `(agreement_id, invoice_id, direction)` — so anything that changes
WHICH agreement version an invoice resolves to changes the subject, and the arithmetic silently
starts again from zero:
- **PROBE A — a BACKDATED new version double-accrues an invoice already in the ledger.** Invoice
  issued under v1, half paid, 5 000 accrued. An operator then INSERTS v2 with
  `effective_from = 2026-01-01` (i.e. behind the invoice's `issued_at`) at the SAME rate — the
  natural way to record "the amended agreement runs from the start of the year". The next money
  event resolves v2, opens a SECOND `commission_accrual_subjects` row, finds `Σ = 0` for it and
  appends the WHOLE target: `{"subjects": 2, "rows": [5000, 10000], "payable": 15000}` where 10 000
  is the correct total for that invoice. The first subject's 5 000 is never reversed.
- **PROBE B — an in-place UPDATE of a live version's `terms` reprices the REST of the invoice.**
  Nothing forbids it: `partner_agreements` is NOT under DD5's append-only trigger (that trigger
  covers `commission_accruals`, `entitlement_movements`, `coupon_redemptions`). After
  `update partner_agreements set terms = {payableRateBps: 2000}`, the next event tops the invoice up
  to the NEW rate's full target: `rows = [[5000, 1000 bps], [15000, 2000 bps]], payable 20000`. The
  earlier ROW keeps its snapshot (DD6 holds where it was designed to), but the invoice's total is
  repriced — which is the outcome DD6's prose forbids, reached through the one path DD6's mechanism
  does not cover.
**Neither is a T6 defect** — DD6 rules that amendments are versioned and forward-dated, and both
probes break that rule from OUTSIDE the code. **T8's runbook needs both as operating rules** (an
amendment is a NEW version effective from a FUTURE instant; a live version's `terms` are never
edited in place), and **§8 CLOSE should decide whether the real fix is an `effective_from >= now()`
check plus an append-only trigger on `partner_agreements`, or a subject keyed on the INVOICE rather
than on `(agreement, invoice)`.** Routed rather than fixed: a gate does not write code.

**97. `replayAccruals({ env })` GATES ON THE PASSED ENV AND THEN READS `process.env` ANYWAY.**
`replay.ts` refuses when `commissionAccrualEnabled(opts.env ?? process.env)` is false, but
`handleAccrualEvent` — which does the writing — calls `commissionAccrualEnabled()` with no argument,
i.e. `process.env`. So a caller who arms the backfill through the OPTION while the process
environment has the flag off gets exactly the failure the refusal exists to prevent: every row
returns `disabled`, the job reports a clean pass and writes nothing. Only the `"false"` direction of
that option is tested (`replay.test.ts:218`). **T8's runbook: flip the real environment variable,
never rely on `{ env }`.** Low severity today — the option has no production caller.

**98. THE GATE'S OWN RUNS, for the CLOSE census.** All ten touched suites re-run here on a private
family, detached, exit VALUE read from a file → **0**: `Test Suites: 10 passed, 10 total · Tests: 88
passed, 88 total` (`src/modules/partners/*`, `golden/`, `kernel/worker/seed-cursors.test.ts`,
`kernel/modules/manifests.test.ts`, `test/worker-runtime.e2e.test.ts`). **CI re-confirmed
independently on the pushed sha with `ci-watch-host.sh`, exit VALUE 0 from a file: `6fb10bd GREEN
(707s, run 32877485404)`** — and CI runs `pnpm install --frozen-lockfile` then `pnpm verify`, which
is both the full-suite evidence and the proof that the lockfile did not move. The private
`hmis_g6nar_1` and `hmis_g6mut_1` databases were dropped and every `*.gm.*` scratch file deleted.

## 2026-08-25 · T7 (attribution, statements, reconciliation, aging) → T8 and the MAIN SESSION

**99. FOR T8 AND §8 CLOSE — THE RECEIVABLE LANE'S EXPORTED SURFACE, from `modules/partners/index.ts`.**
`receivableCommissionEnabled` / `requireReceivableLane` / `receivableTermsSchema` /
`receivableTermsOf` / `receivableSnapshotOf` · `issueAttribution` / `findAttributionByCode` /
`voidAttribution` / `expireUnclaimed` / `openExpectations` / `attributionCodeFor` ·
`importStatement` / `parseStatement` / `resolveStatementColumnMap` / `listStatementQuarantine` /
`STATEMENT_COLUMN_MAPS` / `STATEMENT_MAP_VERSIONS` / `STATEMENT_QUARANTINE_REASONS` ·
`resolveStatementRef` / `mapPartnerRef` / `listPartnerRefs` / `writeOffExpectation` ·
`agingReport` / `receivableTotalPaise` / `bucketFor` / `AGING_BUCKETS`.
**For T8's P&L: `receivableTotalPaise(exec, counterpartyId)` is Σ of the append-only receivable
ledger and is the ONLY honest "what a partner actually confirmed" number.** The expectation rows
are CLAIMS and summing them double-counts the moment a V3 correction lands (a corrected referral
has two `matched` rows and one net ledger total). `agingReport(...).totals` already separates the
four: `outstandingPaise` / `disputedPaise` / `writtenOffPaise` from the claims, `confirmedPaise`
from the ledger.

**100. FOR T8's RUNBOOK — `RECEIVABLE_COMMISSION_ENABLED` ARMS FIVE WRITE PATHS AND ZERO READ PATHS.**
`issueAttribution`, `voidAttribution`, `expireUnclaimed`, `importStatement` and `mapPartnerRef` all
open with `requireReceivableLane()` and answer 409 `receivable_disabled` with the flag off (mutant
G5 proves it is load-bearing: with the check removed the referral is written). `GET
/partners/receivables/aging` is DELIBERATELY NOT GATED and reads zeros — an operator confirming the
lane is inert must not be refused the one screen that would tell them. **Two owner steps, not one:**
flip the flag AND grant the four permissions (`partners.attribution.issue`,
`partners.statement.import`, `partners.receivable.operate`, `partners.ledger.read`), all four of
which DD18 leaves in `NOT_YET_MODELLED`. Until both, the routes are mounted, guarded and reachable
by nobody — same shape as relay 2a/67 for the membership import.

**101. FOR T8 AND §8 CLOSE — A COMMISSIONING AGREEMENT NOW NEEDS TWO MORE `terms` KEYS, AND NEITHER
IS DEFAULTED.** `receivableTermsSchema` requires `receivableRateBps` (0…10 000) and
`unclaimedExpiryDays` (positive int), read off `ResolvedAgreement.rawTerms` (relay 80's ruling,
used as written — T6's `accrualTermsSchema` strips them and this lane parses its own half). Both
are deliberately undefaulted for `eligibleCategories`' own reason: an agreement whose receivable
terms were never configured must fail LOUDLY (`unknown_agreement`) rather than expect nothing and
never expire. **A partner configured for the PAYABLE lane only will refuse every referral** — that
is a commissioning-checklist line, not a bug.

**102. THE SEVENTEEN-TABLE BUDGET HELD (relay 4, implemented as ruled) — HERE IS EXACTLY HOW A
STATEMENT LANDS, because the shape is not obvious from the schema.**
- At ISSUANCE: one `receivable_expectations` row, `statement_ref` NULL, `state='expected'`. Those
  rows sit OUTSIDE `receivable_expectations_statement_line_ux` (it is partial on
  `statement_ref is not null`), which is what lets a match UPDATE one in place.
- At IMPORT, per parseable line, exactly one expectation row: the open one UPDATED to `matched` /
  `disputed`, or a NEW row for V1/V6/V3.
- **EVERY disputed line is ALSO written to `import_quarantine`** (`source='partner_statement'`,
  `batch_id` = the statement reference, `raw = { line }` — byte-identical to the holder book's, so
  `listQuarantine` serves both). That is not tidiness: on an `amount_mismatch` the expectation row
  keeps OUR figure, so **the partner's own figure would exist nowhere in this system** without it.
- `commission_accruals` receivable rows carry `subject_id = null` and `basis_event_id = null`
  (nulls are distinct, so `commission_accruals_basis_event_ux` leaves them unconstrained). What
  stops a double accrual is `statement_already_imported` plus the partial unique index behind it.

**103. FOR T8/T6 AND §8 CLOSE — `commission_accruals` HAS NO ATTRIBUTION COLUMN, so the receivable
lane's provenance travels in `rate_snapshot`.** A receivable row's snapshot is
`{agreementId, versionNo, effectiveFrom, receivableRateBps, pinnedAt, pinnedTo:"attribution.issued_at",
attributionId, expectationId, statementRef, statementLineNo}`. Consequences: (a) `accrualLedger`'s
`rateBps` and `agreementVersionNo` read `payableRateBps`/`versionNo`, so **`rateBps` comes back
NULL for every receivable row** — correct, not a defect, but a P&L that shows a rate must read
`receivableRateBps` itself; (b) the "what has this attribution already earned" sum is
`rate_snapshot->>'attributionId'`, a jsonb read over one counterparty's receivable slice, and there
is no index on it. Fine at pilot volume; the fix, if it ever matters, is a column and a migration.

**104. DD6 IS TRANSPOSED, NOT REUSED: a receivable is pinned at the ATTRIBUTION's `issued_at`.**
The payable lane pins at `invoices.issued_at` (relay 79/80). There is no invoice behind a referral,
so the analogue is the instant the slip was issued — the terms live when the hospital REFERRED are
the terms that govern the commission on that referral. `appendReceivable` resolves
`requireAgreementAt(tx, counterparty, expectation.expectedAt)`, so a V3 correction months later
still prices at the version that was live at referral. **A consequence T8 should know: if an
agreement's window is closed behind a still-open expectation, its correction refuses with
`no_effective_agreement`.** That is O-7 working as ruled (a closed window stops new accrual) and it
means a termination should not close the window behind uncollected receivables until they settle.

**105. §3.43 SECOND DOOR — `periodSettled` IS NOW REACHABLE, AND ONE VOCABULARY BINDS TWO LANES.**
Relay 82 required T7 to write `statement_period` in `periodKeyFor`'s spelling. It does, and
`importStatement` VALIDATES the caller's `statementPeriod` against `^(\d{4})-(M(0[1-9]|1[0-2])|Q[1-4])$`
before writing anything (`statement_columns_unknown` otherwise, asserted over five bad spellings).
So a matched line really does close that period to `recomputeKicker`. **The door this opens: a
partner statement can now close a kicker period.** A statement imported with the WRONG period
string closes the wrong quarter to recompute, and re-opening one is an owner action this phase does
not build. Routed, not fixed — the validation is as strict as the vocabulary allows.

**106. §3.43 SECOND DOOR — THE `attribution_ids.state` MACHINE HAS NO WRITER FOR `claimed`.**
`issued → void` (V4) and `issued → expired` (V5) both ship. **`claimed` is never written by
anything**, because a statement match moves the EXPECTATION's state and this phase has no reason to
move the slip's as well. The column's comment lists it, so a later reader could mistake its absence
for a bug: it is deliberate, and §8 CLOSE should say so beside relay 77/91's unused error codes.

**107. RELAY 74's LONG-ROW ROUTING IS IMPLEMENTED HERE.** `parseStatement` flags BOTH
`cells.length < headerCells.length` (`short_row`) and `> ` (`long_row`), asserted in both
directions — because a statement's cells end in an AMOUNT and the unquoted-comma class that
truncated a member's name in the holder book would MOVE MONEY here. There is still no CSV quoting
in either lane; `§8 CLOSE should fold a `long_row` reason in beside `short_row`` (relay 74's own
words) remains owed for `modules/membership/import/`, which is not this task's file.
A second refusal in the same family: an amount quoted in RUPEES (`600.00`) is `bad_amount`, never
silently multiplied by a hundred.

**108. AN INTERPRETATION T8 AND §8 CLOSE SHOULD SEE, because it is the one place this task chose
policy the plan does not state.** V1–V7 do not name the case where a statement line resolves to OUR
slip but quotes a DIFFERENT amount. It is `disputed` (`amount_mismatch`), the expectation keeps OUR
figure, NO ledger row is written, and the partner's line is quarantined verbatim. The alternative —
accepting the partner's number — is "silently accepted", which is exactly what V1 forbids for the
neighbouring case. Also chosen here and not stated by the plan: `issueAttribution` REFUSES a
`suspended`/`terminated` counterparty (`counterparty_suspended` / `counterparty_terminated`, two
codes that had no thrower before — relay 91), on O-7's own reasoning that a termination stops NEW
accruals while existing receivables stay collectible.

**109. CENSUSES MOVED BY THIS TASK, measured rather than predicted.** The SPA route census in
`apps/core/test/caddyfile-parity.test.ts` is **23** (observed failing at 22 with
`Expected length: 22 / Received length: 23` before it was moved; §6.0 S11's ruled remedy, the file
being on this task's Files list). `PARTNERS_EVENTS` is now **seven** — `attribution.issued`,
`attribution.voided`, `statement.imported`, `expectation.disputed`, `expectation.corrected`
appended in source order after the two T1 shipped (relay 5's rule, `events.test.ts` untouched).
`partnersManifest.menu` carries one entry, `/partners/receivables` on
`partners.receivable.operate`. **T8 moves the route census to 24 if it ships the P&L screen.**

**110. `pnpm verify` EVIDENCE AND THE CONCURRENT-LANE CONDITION, stated precisely.** Detached, exit
VALUE read from a file → **0**, on a private `hmis_t7ver` family (relay 62/93's knob):
`apps/core 200 suites / 1726 tests · apps/web 41 files / 244 tests · packages/contracts 4 suites /
21 tests`, zero failures. **The tree it ran against was `6fb10bd` + T7's diff + the foreign lane's
~43 uncommitted modified files and its untracked `kernel/episodes/`, `schema/episodes.ts` and
migrations `0024_uhid_format` / `0025_episode_numbers`** — which is NOT what is pushed. It was
green, so nothing is hidden by it, and relay 73's rule applies: **CI on the pushed sha is the better
evidence.** `apps/web/src/locales/{en,hi}.json` were dirty with a FOREIGN edit throughout, so they
were staged with plumbing (`git hash-object -w` on HEAD's content plus this task's own two edits,
then `git update-index --cacheinfo`) exactly as relay 62 prescribes — the commit carries T7's locale
keys and NOT the other lane's uncommitted work, and the working tree keeps both.

**111. CI IS GREEN ON `dcb637b839f3562fb74df6cdb4f3e12a29c5ef20` — run 32886158303, 659 s**,
watched from this host with `ci-watch-host.sh`, exit VALUE 0 read from a file. Relay 73/94's point
applies with full force here: CI ran the COMMITTED tree — no `apps/core/.env`, none of the foreign
lane's ~43 uncommitted files, none of its untracked `kernel/episodes/` or migrations `0024`/`0025`
— and `pnpm install --frozen-lockfile` in front of it is also the proof that `pnpm-lock.yaml` did
not move. The push moved the remote `6fb10bd..dcb637b`, exactly ONE commit, so §2.62's coalescing
hole is closed for this task. `git pull --rebase` was REFUSED (`cannot pull with rebase: You have
unstaged changes`, relay 94's wall, still live at ~43 foreign files); rule 11 was discharged by
relay 94's substitute instead — `git fetch origin main`, then `git rev-parse origin/main` ==
`git rev-parse HEAD~1` == `6fb10bd` and `git rev-list --count HEAD..origin/main` == 0.

**112. DISCLOSURE — THIS TASK DELETED A `.log` IT DID NOT CREATE.** `/opt/hmis/.ci-final.log` was
already untracked in this checkout when T7 started (it is in the session's opening `git status`) and
was swept up by this task's finish-block cleanup of `*.log` scratch. It was somebody else's — most
likely a previous CI watch — it is untracked, unreferenced and regenerated by re-running the
watcher, and nothing else was touched. Recorded rather than left for someone to discover, per rule 8
(report only what you yourself did).

**113. FAIL-FIRST, STATED HONESTLY (§2.4).** ONE legitimate red was captured against SHIPPED state
and is quoted in the task report: the S11 census in `apps/core/test/caddyfile-parity.test.ts`,
`Expected length: 22 / Received length: 23`, observed before the integer was moved. For T7's own
five new suites the implementation landed before the tests within this single attempt, no prior
attempt of T7 pushed an artifact whose SHA could be cited, and §2.4 forbids manufacturing a red by
mutating shipped state. **The discrimination evidence is the six Book-row mutants** (G1, G2, G3, G4,
G4b, G5), each a separate `*.mutant.ts` beside its source, each paired with a CONTROL of the same
body against shipped code, run isolated with `jest --testMatch "**/*.mutant.spec.ts"` on a private
`hmis_t7mut` family — `Test Suites: 1 failed, 1 total · Tests: 6 failed, 5 passed, 11 total`. All
scratch deleted and the private `hmis_t7iso_*`, `hmis_t7mut_*` and `hmis_t7ver_*` databases dropped.

**114. §2.67 — THE ONE MUTANT CLASS THIS TASK BUILT TWICE, AND WHY.** G4's Book row says "update
the prior row, trigger live", and the obvious mutant updates the LEDGER row — which dies at
`partner_ledger_immutable`, i.e. at the DATABASE rather than at an assertion. That is the kill the
row specifies (T4's D6 has the same shape and the T4 gate accepted it), but on its own it would
leave open whether the shipped ASSERTIONS discriminate or whether the trigger is doing all the work.
So a second flavour **G4b** was built: it amends the prior CLAIM row instead — and
`receivable_expectations` is deliberately NOT under the append-only trigger (DD5), so G4b cannot die
at the database. It died at the assertion, `- Array ["adjustment", 15000, "2026-M08"] / + (absent)`.
**The class left UNBUILT: a correction that appends an adjustment of the WRONG SIGN or the wrong
period key.** The shipped legs assert both (`[60_000, -10_000]` on a downward correction, and
`periodKey = "2026-Q3"` when a v1 statement corrects a quarter), but no mutant was built for them
and this task does not claim they are mutant-covered.

## 2026-08-25 · T7 GATE (independent re-run) → T8 and the MAIN SESSION

**115. ALL SIX OF T7's MUTANTS WERE REBUILT FROM SCRATCH AT THIS GATE AND ALL SIX DIED — each
paired with a CONTROL of the same body against SHIPPED code, so a kill cannot be a broken spec.**
Every mutant was a separate `*.gm.ts` beside its source (never an edit to a shipped file), the spec
was `*.gm.spec.ts` (relay 62's rule, invisible to a plain `pnpm verify`), run
`--runInBand --testMatch "**/*.gm.spec.ts"` on a private `hmis_g7mut` family. Isolation line,
identical to T7's own: `Test Suites: 1 failed, 1 total · Tests: 6 failed, 5 passed, 11 total`.
Kills, quoting the shipped assertion's own output — none at typecheck, none at timeout:
· **G1** (accrue on any statement line) `- "confirmedPaise": 0 / + "confirmedPaise": 60000`
· **G2** (drop the slip's partner from the dispute AND from the open-claim lookup)
  `- confirmedPaise 0, linesDisputed 1, linesMatched 0 / + 60000, 0, 1`
· **G3** (a `similarity(partner_ref, ref) > 0.4` lane appended to the only join, plus a `statements`
  whose sole change is that one import — §2.61's shape) `- "attributionId": null, "outcome":
  "disputed", "reason": "unknown_attribution" / + "outcome": "matched", "attributionId": "01M0X5DQ10…",
  "accrualId": "01M0X5DQ1P…", "amountPaise": 60000`
· **G4** (update the prior LEDGER row) `error: partner_ledger_immutable: commission_accruals rows
  are append-only (UPDATE refused)` — a RUNTIME DATABASE refusal, which is the kill the Book row
  specifies and which also proves the trigger is live on this table
· **G4b** (amend the prior CLAIM row and append nothing — `receivable_expectations` has no trigger)
  `- Array ["adjustment", 15000, "2026-M08"] / + (absent)`
· **G5** (create expectations regardless) `Received promise resolved instead of rejected. Resolved
  to value: {"attributionId": "01M0X5DSV7…", "code": "RF-WB8VX0G4N3", "expectedPaise": 60000, …}`
All scratch deleted; the private database was dropped.

**116. §3.43 SECOND DOOR, MEASURED AT THIS GATE AGAINST SHIPPED CODE — TWO CONCURRENT STATEMENT
IMPORTS QUOTING ONE SLIP EACH ACCRUE THE FULL AMOUNT. 7 of 8 trials double-counted.**
Probe (no mutant involved): one slip worth 60 000, then two `importStatement` calls with DIFFERENT
statement references, both quoting that slip's code, started together on the same pool:
```
PROBE A trials: [{"trial":1,"totalPaise":60000,"rows":1},{"trial":2,"totalPaise":120000,"rows":2},
                 … trials 3-8 all {"totalPaise":120000,"rows":2}]
```
Cause, and it is the shape this phase already knows: the open-claim lookup in `statements.ts` is a
plain `SELECT … where state = 'expected'` with **no `FOR UPDATE`**, so both transactions see the
same open claim, both UPDATE it to `matched` (the second blocks on the row lock and then applies —
its `where` is by id, with no state predicate to re-check) and both append a full
`commission_accruals` receivable row. `appendCorrection` has the same exposure one level out: it is
a read-modify-write over `Σ rate_snapshot->>'attributionId'` with no serializer — **exactly the
hazard `commission_accrual_subjects` was added to the schema to prevent for the payable lane**, in
that table's own header words ("without a serializer both cycles read the same sum and both
append").
**This is NOT a T7 acceptance failure** — no criterion, Assertion Book row, DD or V-rule gives the
receivable lane a concurrency requirement, where T4's D2/D3 and T6's F11 each have one — so it is
routed rather than called a defect, and a gate does not write code. **What §8 CLOSE has to decide:**
whether the fix is `FOR UPDATE` on the open expectation row inside `importStatement`'s transaction
(one clause, inside T7's own file, no table), or a serializer keyed on the attribution. **T8's
runbook must say meanwhile that two operators must not import statements for one partner at the
same time.**

**117. §3.43 SECOND DOOR, MEASURED — A SLIP THIS HOSPITAL VOIDED (V4) OR EXPIRED (V5) IS SETTLED,
NOT DISPUTED, BY A LATER STATEMENT QUOTING IT.** Probes B and C against shipped code:
```
PROBE B (after voidAttribution): {"lines":[{"outcome":"corrected","correctsPeriod":"2026-M09",
  "deltaPaise":60000}],"confirmedPaise":60000,"ledger":[["adjustment",60000]],
  "claims":[["written_off",60000,"referred test cancelled"],["matched",60000,null]]}
PROBE C (after the V5 write-off): identical shape — "corrected", ledger [["adjustment",60000]]
```
The open-claim lookup filters `state = 'expected'`, so a `written_off` claim is invisible to it and
the line falls through to V3's LATE-CORRECTION path: a NEW `matched` expectation row and a
full-value `adjustment` ledger row. Three consequences: (a) money is confirmed for a referral the
hospital itself cancelled, which contradicts `voidAttribution`'s own docstring (*"the referral did
not happen, so there is nothing to be owed for it"*); (b) `attribution_ids.state` stays `void` /
`expired` while a `matched` expectation exists against it — a pair no later reader can reconcile;
(c) it cannot be undone at the desk, because `writeOffExpectation` refuses a `matched` row.
V4's own guard is one-directional: `voidAttribution` refuses when a claim is ALREADY `matched`, and
nothing defends the reverse order. **Again not a criterion failure** (V4 says a cancelled test voids
its expectation, and it does; nothing says a later statement quoting a void slip must dispute) —
routed for §8 CLOSE to rule on. The narrow fix, if the owner wants one, is one predicate in
`statements.ts`: a resolution whose slip is `void`/`expired`, or whose only claims are
`written_off`, disputes instead of correcting.

**118. THE GATE'S OWN RUNS, for the CLOSE census — every one detached, exit VALUE read from a
file.** (a) The six suites T7 touches, on a private `hmis_g7nar` family → exit **0**,
`Test Suites: 6 passed, 6 total · Tests: 95 passed, 95 total` (attribution 22, statements 26,
reconcile 17, aging 12, e2e 12, caddyfile-parity 6 — the census re-measured at **23** by running
that suite, not by reading the integer). (b) `apps/web` `partner-receivables.test.tsx` under vitest
→ exit **0**, `Test Files 1 passed (1) · Tests 12 passed (12)`. (c) A full detached `pnpm verify` on
a private `hmis_g7ver` family → exit VALUE **0**: `apps/core 200 suites / 1726 tests · apps/web 41
files / 244 tests · packages/contracts 4 suites / 21 tests`, zero failures — identical to T7's own
figures and up on T6's floor (195/1637 · 40/232 · 4/21) by exactly T7's additions. Same disclosure
as relay 110: that tree is `dcb637b` PLUS the foreign lane's ~43 uncommitted files and its untracked
`kernel/episodes/`, `schema/episodes.ts` and migrations `0024`/`0025`. (d) **CI re-confirmed
independently on the pushed sha with `ci-watch-host.sh`, exit VALUE 0 from a file: `dcb637b GREEN
(659s, run 32886158303)`** — which is also the `--frozen-lockfile` proof that `pnpm-lock.yaml` did
not move. (e) The commit stat was read here rather than taken from the report: 21 files, 4805
insertions / **16** deletions, every path on the Files list, no frozen path, no lockfile line, and
no deleted line anywhere in the diff contains `it(`, `test(` or `describe(`. The two locale files
are 3 insertions / 2 deletions each — nothing re-serialised. All gate scratch deleted and the
private `hmis_g7*` databases dropped (`remaining hmis_g7*: []`).

## 2026-08-25 · T8 (guardrails, identity-free exports, the channel P&L, the runbook) → the MAIN SESSION / CLOSE

**119. PLAN DEFECT — `manifest.ts`'s OWN COMMENT SAYS T8 FILLS `menu`; THE COMPILED FROZEN LIST SAYS
T8 MAY NOT TOUCH THE TEST THAT PINS ITS EXACT SHAPE. Measured, not worked around.**
`apps/core/src/modules/partners/manifest.ts`'s header (pre-existing, written before T8ran) says
*"`menu` is filled by the tasks that ship screens — T7's receivables desk, below, and T8's channel
P&L."* But `apps/core/test/partners-receivables.e2e.test.ts` — FROZEN to T8 in the brief, "even if
your change would be correct" — asserts `expect(manifest.menu).toEqual([{ ...one entry, T7's
...}])`. Adding a second entry for the P&L screen (which T8 built and initially wired in) fails
that exact assertion (`- Expected 0 / + Received 5`, the extra object being the new menu row),
measured here before reverting. **Resolved: T8 did NOT add a `menu` entry.** The screen and its
route (`/partners/pnl`) are fully live and permission-gated server-side
(`partners.controller.ts`'s `@RequirePermission("partners.pnl.read", ...)`) and client-side
(`router.tsx`'s own `NAV` array, independent of `ModuleManifest.menu`) — only the SERVER's
self-descriptive `partnersManifest.menu` listing omits it. `manifest.ts`'s comment now says so in
place. **This is routed to CLOSE, not fixed here**: if the owner wants the P&L in that listing too,
the fix is one line in `manifest.ts` plus the same S11-shaped remedy already applied three times
this phase (T3/deploy-parity, T6/seed-cursors, T7/caddyfile-parity) — the frozen test joins the
Files list of whichever future task is allowed to move it, with the reason written in place. A gate
does not write code, and neither does a ROUTINE task discovering a frozen-list contradiction after
its own gate has already run.

**120. A NAMING TRAP IN DD15's OWN GUARD, FOR ANY LATER TASK REUSING `assertIdentityFree` /
`identityLeaks` (`modules/partners/exports.ts`).** `patients.id` is itself a column, so a bare `id`
key on ANY shape fed to this guard is an unconditional false positive — every row in this system
has one. `aging.ts`'s `AgingItem` already avoided this by construction (`expectationId`, never
`id`); T8 hit it directly building `PartnerExportRow` (first draft used `id`, `identityLeaks`
flagged it on every row, fixed to `rowId` — see `exports.ts`'s own comment on the field). **Any
later shape passed through this guard must use a QUALIFIED id name** (`rowId`, `subjectId`,
`instrumentId`, …), never the bare word `id`. Two more common words are patients columns too and
will trip the same way if used generically: `status` (use `state`, the house convention already)
and `name` (qualify it — `counterpartyName`, not `name` — `pnl.ts` does this already). `phone`,
`language`, `district`, `pincode`, `sex`, `alias` are patients columns as well, less likely to
collide but worth knowing before choosing a field name for anything partner-facing.

**121. FAIL-FIRST WAS NOT CAPTURED FOR T8's SUITES, disclosed rather than manufactured (ROUTINE,
AGENT-RULES §3 — mutants and fail-first are not owed).** Implementation landed before the tests
within this single attempt; no prior attempt at T8 pushed an artefact whose SHA could be cited
(§2.4's auditable precondition); §2.4 forbids manufacturing a red by mutating shipped state. No
assertion this task wrote was noticed to be non-discriminating — the two places that risk it most
(the DD15 export-shape test and the E-32 counter-screen scan) each ship with a synthetic/negative-
control leg proving the check can fail, per the brief's own instruction, and both were measured to
fail correctly before the real legs were trusted (§2.49).

**122. CENSUSES MOVED BY THIS TASK, MEASURED, NOT PREDICTED.** The SPA route census in
`apps/core/test/caddyfile-parity.test.ts` is **24** (`/partners/pnl` the only addition over T7's
23 — observed failing at 23 with `Received length: 24` before the number was moved, S11's remedy
applied as ruled). `partnersManifest.permissions` is unchanged (`partners.pnl.read` was already
declared by T1); `partnersManifest.menu` is unchanged (see 119). No event, error code or permission
was added by this task — DD15/E-32/the P&L/the runbook needed none.

**123. `pnpm verify` EVIDENCE, detached, exit VALUE read from a file on a private
`TEST_DATABASE_URL` family (`hmis_t8ver_*`, dropped after) → **0**: `apps/core 203 suites / 1748
tests · apps/web 42 files / 247 tests · packages/contracts 4 suites / 21 tests`. Against T7's own
gate figures (200/1726 · 41/244 · 4/21): **+3 core suites / +22 core tests, +1 web file / +3 web
tests, contracts unchanged** — reconciling exactly against this task's own three new core test
files (9 + 7 + 6 = 22) and one new web test file (3). Zero failures anywhere. No test deleted. No
lockfile diff. The tree this verify ran against was `dcb637b` + T8's diff + the foreign
uhid/episode-numbers lane's ~38 uncommitted files (unrelated `modules/opd`, `modules/patients`,
`kernel/episodes/`) — additive and outside every assertion T8 wrote, so the gap is disclosed rather
than closed (relay 70/93/110's own precedent). Commit `927afc6`, pushed as a clean fast-forward
(`dcb637b..927afc6`, exactly one commit) — `git pull --rebase` was refused
(`cannot pull with rebase: You have unstaged changes`, the same foreign-lane wall relay 94/111 hit);
discharged instead by `git fetch origin main` + confirming `origin/main == HEAD~1 == dcb637b` and
`git rev-list --count HEAD~1..origin/main == 0` (a genuine no-op rebase, not only a refused one).

## 2026-08-25 · T8 MECHANICAL CHECK (independent) → §8 CLOSE and any future task touching README/locales

**124. CI IS RED ON `927afc667975a859454c433249c025222841bd4c` (conclusion=failure, run 32893004939,
683s — `ci-watch-host.sh`, exit VALUE from a file) — BUT AN EXHAUSTIVE, CLEAN-CHECKOUT REPRODUCTION
OF EXACTLY WHAT CI RUNS COMES BACK FULLY GREEN.** Neither T8's own report nor relay 119-123 checked
CI at all — unlike T7's gate (relay 111/118), which ran `ci-watch-host.sh` and quoted GREEN before
calling the task done. The plan's own T8 acceptance line requires "CI green by full SHA before
close"; nobody on T8's side verified it, and this mechanical check is the first point anyone looked.
**Reproduction, to close the gap as far as this host can:** `git worktree add --detach` at the exact
pushed SHA (zero foreign contamination — the working checkout's ~38 dirty/untracked
uhid-format/episode-numbers files are absent by construction), `pnpm install --frozen-lockfile`
(also the lockfile-drift proof), then `pnpm typecheck` (exit 0), `pnpm lint` (exit 0, one
pre-existing unrelated warning in `scheduler.test.ts`, nothing from T8's files), then the FULL
`pnpm -r test` across all three packages, detached, exit VALUE 0 from a file:
`packages/contracts 4/4 suites, 21/21 tests · apps/web 42/42 files, 246/246 tests · apps/core
202/202 suites, 1727/1727 tests` — **zero failures anywhere.** This is as close to "ran what CI
runs" as this host can get without a `gh` credential (job logs are 403 here, standing per §7 item
6), and it did not reproduce the red. **The most likely explanation is a GitHub-runner-side flake**
(a service-container timing issue, a resource limit on the shared runner) rather than a defect in
what T8 shipped — but this is not proven, only made likely by an exhaustive negative result, and
only a fresh CI run (a new commit, or an authenticated `gh run rerun`) can settle it outright.
**Whoever runs §8 CLOSE should re-run `ci-watch-host.sh 927afc667975a859454c433249c025222841bd4c`
once more before writing the phase closed** — if GitHub ever re-evaluates/reruns the same SHA (it
sometimes does on a `workflow_dispatch` re-run by someone with the credential) the row may already
read GREEN; if it still reads RED, that is itself the signal this needs an authenticated log pull,
not another local reproduction — this one was as thorough as the evidence standard allows.

**125. THE ABSOLUTE `apps/core` TEST COUNT T8 (AND THIS CHECK'S OWN FIRST, NAIVE VERIFY RUN ON THE
SHARED CHECKOUT) QUOTED — 203 suites / 1748 tests — IS NOT WHAT IS ACTUALLY COMMITTED.** The clean,
CI-parity reproduction in 124 measures **202 suites / 1727 tests** for `927afc6` — one suite and 21
tests fewer. The entire difference is ONE foreign, untracked file that has nothing to do with any
task in this phase: `apps/core/src/kernel/episodes/series.test.ts` (21 tests), part of the
uhid-format/episode-numbers lane that has sat dirty/untracked in this checkout since at least T7's
own gate (relay 118 already disclosed the same tree contamination in prose, without isolating its
numeric effect). Since that file was almost certainly ALSO present, untracked, during T7's own gate
measurement (200/1726), the DELTA T8 claims — +3 suites / +22 tests, reconciling to
`pnl.test.ts`(9) + `exports.test.ts`(7) + `guardrails.test.ts`(6) — is still correct and is exactly
what this check's clean reproduction confirms (T7's true clean count would be 199/1705, and
199+3=202, 1705+22=1727 — both match). **Nothing here implies a test was deleted or the workspace
total decreased** (AGENT-RULES §4's actual concern); it means every `pnpm verify` run against the
shared `/opt/hmis` checkout during this phase — including this check's own first attempt — has been
quoting an absolute figure inflated by a foreign, never-committed suite. §8 CLOSE should quote the
CLEAN figures (202/1727 for apps/core, as of `927afc6`) if it states an absolute apps/core count,
not the contaminated 203/1748.

**126. UNDISCLOSED SCOPE CONTAMINATION IN T8's OWN COMMIT: ~90 LINES OF `README.md` (a whole "UHID
format" and "Episode numbers — V/A/L/S/R/P" section) DESCRIBE A FEATURE THAT IS NOT IN THE COMMITTED
CODEBASE AT `927afc6`, AND THAT CONTRADICTS the code THAT COMMIT DOES SHIP.** T8's brief is DD14/
DD15/O-8/S5/the channel P&L/the five-flag runbook — nothing about UHIDs or episode numbers. Measured
against `927afc6` directly: `git show HEAD:apps/core/src/modules/patients/uhid.ts` still formats
`` `${prefix}-${body}-${check}` `` (hyphenated) and `git show HEAD:apps/core/scripts/seed-registration.ts`
still enforces `/^[A-Z]{2,5}$/` (2-5 letters) — but the new README text says production runs prefix
`U` (a single letter, which the shipped regex would REFUSE) and describes a no-separator,
Verhoeff-checked format (`U12345013`), a reserved-serial floor, a `remint:uhids` script and an
`episode_series` table. **None of `apps/core/scripts/remint-uhids.ts` or
`apps/core/src/kernel/episodes/` exist in `927afc6`** (`git cat-file -e` against HEAD: both absent)
— they are the SAME foreign, uncommitted uhid-format/episode-numbers lane named in 124/125, still
dirty/untracked in this checkout. The same commit added a `"visitNo": "Visit no"` key to both
`en.json`/`hi.json` for the identical reason — it is consumed by `rx-print.tsx`'s
`t("rx.visitNo")`, itself part of that same uncommitted lane (confirmed via `git diff` on the
working tree's own dirty `rx-print.tsx`). **This reads as the README/locale-file analogue of the
git-plumbing problem relay 62/110/111 solved for T7's locale file**: T7 isolated its own two locale
edits from a dirty foreign file with `git hash-object -w` + `git update-index --cacheinfo`; T8 did
not do the same for `README.md` (or, this time, for the locale files either), and its commit swept
up whatever the foreign lane had already drafted, uncommitted, into `README.md` and both locale
files at the moment T8 wrote them. **Nothing in T8's own report or relay 119-123 mentions this.**
§8 CLOSE (or whichever task next legitimately owns the uhid-format/episode-numbers feature) should
know that `README.md`'s "UHID format" and "Episode numbers" sections, and the `rx.visitNo` locale
key, are ALREADY LIVE ON `main` as of `927afc6` — describing code that does not yet exist — and
either that task's own commit needs to reconcile the docs with what it actually ships (the prefix
regex, the format, the script name), or someone needs to correct `README.md` back out before then.
This is NOT a claim that the underlying uhid-format/episode-numbers work is wrong — only that its
DOCUMENTATION shipped to `main` a full commit before any of its CODE did, attributed to a task
(T8) that never touched that feature.

## 2026-08-25 · T8 CORRECTION (reviewer-routed) → §8 CLOSE

**127. BOTH REVIEWER-1 FINDINGS ON `927afc6` ADDRESSED IN A NEW FOLLOW-UP COMMIT, `b0d046b`
(rule 15 — no amend, no force-push).** (a) **Scope creep reverted.** The ~90-line "UHID format"
and "Episode numbers — V/A/L/S/R/P" README sections, the UHID-prefix-related sentence in the
Go-live runbook, the `1–5 uppercase letters (production runs U)` regex-doc line, and the
`rx.visitNo` locale key in both `en.json`/`hi.json` — all traced (relay 126) to the still-
uncommitted uhid-format/episode-numbers lane's dirty working-tree files — are reverted verbatim
to their `dcb637b` (pre-T8) wording. Diffed and confirmed: nothing in `README.md` now matches
`grep -i "uhid\|episode\|visitno"` outside pre-existing content; the locale diff against
`dcb637b` is now ONLY the `partnerReceivables`→`partnerPnl` nav addition and the new
`partnerPnl` block in both files — exactly T8's legitimate DD14/DD15 work, nothing else. (b) **CI
re-checked.** `927afc6` is confirmed STILL RED as of this correction
(`ci-watch-host.sh 927afc667975a859454c433249c025222841bd4c` → `CI IS RED, conclusion=failure, 683s,
run 32893004939` — unchanged from the first mechanical check, so GitHub has not re-evaluated that
SHA). The unauthenticated `/actions/runs/{id}/jobs` endpoint (no `gh` credential on this host, per
standing limitation) adds one datum beyond relay 124: the failure is squarely inside the single
`pnpm verify` step (20:02:41–20:13:36, ~655s) — every earlier step (`checkout`, `pnpm/action-setup`,
`setup-node`, `pnpm install --frozen-lockfile`) reports `success`; job logs are still 403 without a
credential, so which assertion failed remains unknown from this host. **This correction's own
commit, `b0d046b`, was watched independently and reads GREEN**: `ci-watch-host.sh
b0d046b2de096c1adc8edb9a0c498c38d4be13c1` → `CI IS GREEN (746s, run 32897168390)`. A second local,
detached `pnpm verify` on this same working tree (private `TEST_DATABASE_URL` family
`hmis_t8fix_*`, dropped after) also exited 0: **apps/core 203 suites / 1748 tests · apps/web 42
files / 247 tests · packages/contracts 4 suites / 21 tests** — identical to relay 123's own figures,
confirming the correction changed no test outcome. **As before (relay 125), that 203/1748 is the
CONTAMINATED apps/core figure** (the working tree still carries the foreign, uncommitted
`kernel/episodes/series.test.ts`, 21 tests, unrelated to any task this phase) — the CLEAN figure
for what is actually committed at `b0d046b` is **202 suites / 1727 tests**, matching relay 124/125's
clean-worktree reproduction of `927afc6` exactly, because this correction touched zero test files.
**Net for §8 CLOSE: the scope-creep finding is fully resolved (docs now match shipped code); the
CI-red finding is PARTIALLY resolved — the corrected commit that supersedes `927afc6` on `main`
is independently confirmed GREEN, but `927afc6` itself is not retroactively green and never can be
(rule 15) — its recorded run stays a failure whose cause is still unproven (flake vs. real defect)
without an authenticated `gh run view 32893004939 --log-failed`.** Two data points now support the
flake reading over a real defect: the exhaustive clean-checkout reproduction (relay 124, zero
failures) and this GREEN run of functionally-identical code one commit later — but neither is
proof, only accumulating likelihood, per §2.67's rule against generalising from one specimen.
