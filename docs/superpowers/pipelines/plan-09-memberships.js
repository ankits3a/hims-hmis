export const meta = {
  name: 'plan-09-memberships',
  description: 'Plan 09: memberships, coupons, entitlements, the holder-book import, the accrual ledger and the receivable instrument',
  phases: [
    { title: 'Wave 1', detail: 'T1 schema — 17 tables, both modules, five flags, the loadConfig lint rule' },
    { title: 'Wave 2', detail: 'T2 the two AdjustmentSources, pure, with Plan 09 golden fixtures' },
    { title: 'Wave 3', detail: 'T3 recognition at the counter — sealed gate, rate limit, grace-honor' },
    { title: 'Wave 4', detail: 'T4 billing integration — consume and restore as one property' },
    { title: 'Wave 5', detail: 'T5 the holder-book import, quarantine and the reconcile queue' },
    { title: 'Wave 6', detail: 'T6 the accrual consumer — four subscriptions, delta-to-target' },
    { title: 'Wave 7', detail: 'T7 the receivable instrument, statements and aging' },
    { title: 'Wave 8', detail: 'T8 guardrails, identity-free exports, channel P&L, runbook' },
    { title: 'Discovery', detail: 'one opus reviewer reads every commit of the phase together' },
  ],
}

// ============================== COMPILE-TIME CONSTANTS ==============================
// MEASURED by the main session on this host immediately before compiling, detached, exit VALUE
// read from a file. Never a remembered number (§2.6/§2.21 — a baseline has a shelf life).
const BASELINE = 'apps/core 166 suites / 1310 tests · apps/web 38 files / 210 tests · packages/contracts 4 suites / 20 tests'
const BASELINE_SHA = 'a4144c1'

const RULES = '/opt/hmis/docs/superpowers/AGENT-RULES.md'
const PLAN = '/opt/hmis/docs/superpowers/plans/2026-08-25-phase1-09-memberships-coupons-accrual-ledger.md'
const LEDGER = '/opt/hmis/docs/superpowers/plans/reports/EXECUTION-LESSONS.md'
// v3 §1 retires the findings inbox AS AN ARTIFACT. The MECHANISM §2.16/§2.39 needs survives as an
// UNTRACKED relay nobody commits; the main session folds it into the phase document's CLOSE.
// The ruling is recorded in the plan's THE LANE block so the reviewer reads it as one.
const RELAY = '/opt/hmis/.plan-09-relay.md'

// Which subset of TASKS this invocation runs, and whether the discovery reviewer runs after it.
// TASKS stays complete either way: the frozen-path block is generated from ALL of them, so a task
// in pipeline A still knows T7 owns a file it must not touch.
const RUN = (args && args.tasks) || ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']
const RUN_DISCOVERY = args ? args.discovery !== false : true

// ============================== TASKS ==============================
// `files` arrays ARE the plan's §6 Files lists. §2.54: these are two copies of one fact and nothing
// else reconciles them — the pre-flight parses the plan's fenced lists and asserts equality per
// task, BOTH DIRECTIONS. Amend one without the other and the generated frozen block silently
// forbids what the plan requires.
const TASKS = [
  {
    id: 'T1', wave: 1, tier: 'CRITICAL', model: 'opus', gate: true, deps: [],
    commit: 'feat(core): partner, instrument and accrual-ledger schema — external RMP unpayable at the schema level (09 T1)',
    files: [
      'apps/core/src/kernel/db/schema/membership.ts',
      'apps/core/src/kernel/db/schema/membership.test.ts',
      'apps/core/src/kernel/db/schema/partners.ts',
      'apps/core/src/kernel/db/schema/partners.test.ts',
      'apps/core/src/modules/membership/index.ts',
      'apps/core/src/modules/membership/manifest.ts',
      'apps/core/src/modules/membership/membership.module.ts',
      'apps/core/src/modules/membership/errors.ts',
      'apps/core/src/modules/membership/events.ts',
      'apps/core/src/modules/membership/events.test.ts',
      'apps/core/src/modules/membership/catalogs-empty.test.ts',
      'apps/core/src/modules/partners/index.ts',
      'apps/core/src/modules/partners/manifest.ts',
      'apps/core/src/modules/partners/partners.module.ts',
      'apps/core/src/modules/partners/errors.ts',
      'apps/core/src/modules/partners/events.ts',
      'apps/core/src/modules/partners/events.test.ts',
      'apps/core/drizzle/0022_<generated-name>.sql',
      'apps/core/drizzle/meta/0022_snapshot.json',
      'apps/core/drizzle/meta/_journal.json',
      'apps/core/src/kernel/db/schema/index.ts',
      'apps/core/src/kernel/modules/manifests.ts',
      'apps/core/src/kernel/modules/manifests.test.ts',
      'apps/core/src/app.module.ts',
      'apps/core/src/kernel/config.ts',
      'apps/core/src/kernel/config.test.ts',
      'apps/core/test/helpers/db.ts',
      'apps/core/scripts/seed-roles.ts',
      'apps/core/test/seed-roles.test.ts',
      'README.md',
      'eslint.config.mjs',
    ],
    brief: `## Task T1 — Seventeen tables, two modules, five flags, one lint rule

Read the plan's **§2 Ground truth**, **§3 Q1 and Q2** (both MEASURED — do not re-derive them),
**§5 DD1, DD3, DD4, DD5, DD14, DD17, DD18**, **§6.0 (the whole compile sweep — S2, S3, S8, S9, S13
are all about YOUR Files list)** and **§6 T1**. The plan is the design law. This brief adds only what
the plan does not carry.

### The four things that will bite, all of them measured at compile time

1. **\`apps/core/test/helpers/db.ts\` — §3.12 and §3.35, and this is a HALT if you get it wrong.**
   Postgres checks whether an FK constraint POINTS AT the table being truncated — **constraint
   existence, never row counts and never statement order.** Every new table that FKs into
   \`patients\`, \`invoices\` or \`invoice_lines\` MUST be named in **that group's own statement** (the
   long one). A separate earlier statement does not satisfy Postgres. A table with no inbound FK
   takes **its own statement** — read the \`search_audit\` and \`auth_throttle\` comments already in
   that file; they explain the reasoning in place and you should match their style.
   **DD17 is what keeps this small: every actor column in this phase is PLAIN TEXT, never an FK into
   \`users\`, so the users statement needs no change at all.**
2. **\`apps/core/test/seed-roles.test.ts\` holds a reachability invariant that FAILS THE BUILD.**
   Every permission you declare must be either granted in \`ROLE_MODEL\` or entered in
   \`NOT_YET_MODELLED\` **with its reason**. **DD18 rules which is which** — read it and follow it;
   it is not your decision to re-make. Also: three separate assertions pin
   \`allPermissions()\` at a fixed length and one pins a per-module census as an object literal.
   **MEASURE the new numbers from what you actually declare and update them. Never transcribe a
   count from the plan** — the plan deliberately states no number, because the manifests own it.
3. **\`README.md\` is pinned to the role model cell for cell, both directions** (S13). DD18's grants
   have no README permission column, so they take the shape the two existing precedents took: a
   **named pairs constant** in the test plus a **README prose line the test quotes verbatim** as its
   authorisation. Read \`RULING_7_PAIRS\` / \`WORKFLOW_RULING_PAIRS\` and \`NON_TABLE_PAIRS\` and copy
   that shape. **Add a paragraph and a constant; do not restructure the existing tables.**
4. **The eslint rule.** Ban bare \`loadConfig()\` under \`**/*.test.ts\`. F1 (plan §2) cost the last
   phase a red CI commit: \`apps/core/.env\` exists on this host and can never exist in CI, so
   \`loadConfig()\` resolves here and throws there. The shipped workaround is
   \`loadConfig({ DATABASE_URL: "postgres://unused", … })\`. **DEMONSTRATE THE RULE FIRING** on a
   deliberately-added bare call in a scratch test file, quote the lint output, then delete that file
   before you commit.

### The migration

**ONE migration, \`0022\`.** AGENT-RULES §6 is in force: generate it only when you are ready to
carry it to a commit, and if you must abandon after it is applied, **STOP AND REPORT which databases
carry it** — never delete the file, never hand-edit \`drizzle/meta/_journal.json\` or a
\`__drizzle_migrations\` row. Head today is \`0021_search_trigram\`, 22 journal entries.
**F5's lesson: the \`meta/\` snapshot ships in the SAME COMMIT as its migration.**

**DD4's composite-FK mechanism was measured by the spike (plan §3 Q1) and all four probes refused.
Two constraints follow and neither is optional:**
- The FK ships with the **default \`ON UPDATE NO ACTION\`** and the migration carries a COMMENT
  saying why: under \`CASCADE\` the FK stays satisfied and only the child's CHECK refuses, so a
  later ledger table carrying the FK without that CHECK would be silently relabelled
  \`external_rmp\`.
- A counterparty's class is frozen while ANY accrual row exists, **receivable rows included**. So
  nothing here may implement a status change as a class change — \`counterparties.status\` is a
  separate column (O-7).

**Append-only is Q2's measured answer: reuse \`0012_billing_immutability.sql\`'s shape** — one
plpgsql function raising on \`BEFORE UPDATE OR DELETE\`, attached per table. **Define your OWN
function**, do not attach billing's: its message names the wrong module, and a shared function lets
one plan's migration change another's error text.

**\`commission_accrual_subjects\`** is the seventeenth table and it exists for DD12's serializer:
unique on \`(agreement_id, invoice_id, direction)\`, upserted then locked \`FOR UPDATE\` by T6. Ship
the table and its index; T6 writes the locking.

### Modules

Both manifests go in \`ALL_MANIFESTS\` and are installed by \`app.module.ts\`'s one loop.
**\`partnersManifest\` ships with \`subscriptions: []\` and is installed APP-SIDE ONLY** (S2) —
T6 adds its four subscriptions, its handler, its worker install and the census in ONE commit,
because \`buildSubscriptionBus\` turns a declared subscription with no matching handler into a boot
error. Record in \`manifests.test.ts\` that partners is app-only until T6, in the style that file
already uses for the app/worker difference.

Controllers are NOT in your Files list and that is deliberate: T3 and T7 create them. Your Nest
modules ship with providers and no controllers.

### The five flags

**DD14.** All five in \`configSchema\`, all **defaulted** (the B1 scar — this schema is parsed
through the whole environment by every caller, so nothing new may be required in any \`.env\`,
here or in CI), all spelled \`z.enum(["true","false"]).default("false")\` and never
\`z.coerce.boolean()\`, which reads the string \`"false"\` as TRUE. Copy \`RETENTION_ENABLED\`'s
comment discipline — say WHY each is off and which gate lifts it.

### DD3's catalogs-empty test

Boot against a fresh test database, assert every catalog reader returns \`[]\`, and assert no seed
script under \`apps/core/scripts/\` writes to any catalog table. **This is the check that keeps the
out-of-git partner book out of the repo, and it names no secret** — which is exactly why it is
shaped this way rather than as a grep for forbidden values. Do not make it vacuous: give it a leg
that fails, per §2.49.`,
    criteria: [
      'Migration `0022` applies cleanly to a fresh database AND to the per-worker databases; the `meta/` snapshot and `_journal.json` are in the SAME commit as the .sql (F5).',
      'The composite FK is declared with the default `ON UPDATE NO ACTION` and the migration carries a comment saying why (plan §3 Q1).',
      'Book rows A1, A2, A4, A5, A6 built as mutants and each recorded DIED with expected-vs-received quoted. A3 is STRUCK by the plan — do not build it.',
      '`apps/core/test/helpers/db.ts`: every new table that FKs into patients/invoices/invoice_lines is named in THAT group\'s own truncate statement; tables with no inbound FK take their own statement. Quote the statements you changed.',
      '`seed-roles.test.ts` green: every declared permission is granted per DD18 or entered in NOT_YET_MODELLED with its reason; the length assertions and the per-module census are re-MEASURED from the manifests, not transcribed.',
      'README parity green: DD18\'s grants land as a named pairs constant plus a README prose line the test quotes verbatim, following the two existing precedents. The existing tables are not restructured.',
      'The eslint rule is DEMONSTRATED FIRING on a deliberately-added bare `loadConfig()` in a scratch test file, with the lint output quoted, and that scratch file is deleted before the commit.',
      '`catalogs-empty.test.ts` green and NOT vacuous — it has a leg that can fail (§2.49).',
      '`partnersManifest.subscriptions` is `[]` and partners is installed app-side only; `manifests.test.ts` records that it is app-only until T6.',
      'All five flags parse `false` from an env object containing none of them; each is a two-string enum, never `z.coerce.boolean()`.',
      'Detached `pnpm verify` exit VALUE 0 read from a file; workspace totals did not decrease against the baseline; no test deleted; `git status --porcelain` empty; `pnpm-lock.yaml` absent from the diff.',
    ],
  },
  {
    id: 'T2', wave: 2, tier: 'CRITICAL', model: 'opus', gate: true, deps: ['T1'],
    commit: 'feat(core): membership and coupon adjustment sources — pure, golden-fixtured, tariff untouched (09 T2)',
    files: [
      'apps/core/src/modules/membership/instruments.ts',
      'apps/core/src/modules/membership/instruments.test.ts',
      'apps/core/src/modules/membership/sources.ts',
      'apps/core/src/modules/membership/sources.test.ts',
      'apps/core/src/modules/membership/coupon-rules.ts',
      'apps/core/src/modules/membership/coupon-rules.test.ts',
      'apps/core/src/modules/membership/golden/fixture-schema.ts',
      'apps/core/src/modules/membership/golden/golden.test.ts',
      'apps/core/src/modules/membership/golden/fixtures/',
      'apps/core/src/modules/membership/index.ts',
    ],
    brief: `## Task T2 — The two adjustment sources, pure, and this phase's own golden harness

Read the plan's **§3 Q3 (MEASURED — DD2 is confirmed by execution, and it found a trap that is now
Book row B7)**, **§5 DD2, DD9, DD16**, **§4 O-2**, and **§6 T2**.

### What §3 Q3 measured, so you do not rediscover it

- \`{...base, sources: [...base.sources, a, b]}\` at the billing layer typechecks, prices, and needs
  **no change under \`apps/core/src/modules/tariff/\`** — which is frozen to you in full.
- An appended source flows through the **whole** engine, not only the contest: the taxable line's
  GST was computed on the post-discount base.
- **Tie-break by array order was OBSERVED**, both directions, and the mutant died on both legs.
- **THE TRAP, and it is silent.** \`runContest\` builds precedence as
  \`ctx.sources.forEach((s, i) => order.set(s.key, i))\` and looks the candidate up by
  **\`candidate.sourceKey\`**, falling back to \`Number.MAX_SAFE_INTEGER\`. So two appended sources
  sharing a \`key\` **collapse into one precedence slot**, and a candidate whose \`sourceKey\` does
  not equal its own source's \`key\` **sorts last on every tie** — with nothing failing anywhere.
  Emit \`sourceKey === key\`, keep the two keys distinct, and **pin it with Book row B7.**

### The shape

\`membershipSource(resolved)\` and \`couponSource(resolved)\` are **factories** returning an
\`AdjustmentSource\` closing over a plain value. \`propose\` is **PURE and SYNC** — no database, no
clock, no await. \`ResolvedInstruments\` is YOUR type and it is the seam T3 fills: define it here so
T3 produces it and T4 consumes it.

Everything comes through the frozen tariff index — \`priceInvoiceLines\`, \`standingRuleSource\`,
\`manualDiscountSource\`, \`assertPaise\`, \`divHalfUp\`, \`percentAmount\` and the types. All of it is
already exported (plan §2). **You write no rounding of your own.**

### The golden harness

Copy Plan 06's discipline deliberately, do not extend its files: your own \`fixture-schema.ts\` with
**\`workings: z.string().min(20)\`**, so a fixture without real arithmetic shown **fails to parse**.
Copy both of its anti-vacuity tests too — the manifest pinned by name, and the directory asserted to
contain nothing but the manifest (a \`.JSON\` straggler is invisible to a case-sensitive filter).

**Every fixture's \`workings\` is HAND-COMPUTED and shows the arithmetic.** The plan's §6 T2
acceptance names the nine cases; each gets a fixture.

**Fixtures invent their own people and codes (O-9).** The out-of-git partner book may not be
transcribed into a tracked file, and a fixture is a tracked file. Invent the codes; test the CLASS.`,
    criteria: [
      '`propose` is pure and synchronous in both sources — no await, no clock, no db import. Assert it, do not merely claim it.',
      'Book rows B1-B7 built as mutants, each recorded DIED with the assertion\'s own expected-vs-received quoted. B7 pins `sourceKey === key` (plan §3 Q3).',
      'The fixture manifest is pinned by name AND the directory is asserted to contain nothing else; every fixture prices at least one line; every fixture\'s `workings` shows hand-computed arithmetic.',
      'Fixtures exist for: member+coupon contest, GST-exempt line under a coupon, percentage cap exact hit, off-peak boundary at 11:59:59 IST, IST-midnight expiry, min-bill threshold ordering, zero-amount line, and a three-instrument contest recording all rejected candidates.',
      '`git show --stat` of the commit shows ZERO files under `apps/core/src/modules/tariff/`.',
      'No value, code, rate or name from `/opt/hmis-context/` appears in any fixture. The fixtures were invented by this task.',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
  {
    id: 'T3', wave: 3, tier: 'CRITICAL', model: 'opus', gate: true, deps: ['T2'],
    commit: 'feat(core,web): instrument recognition at the counter — sealed-gated, rate-limited, grace-honor by approval (09 T3)',
    files: [
      'apps/core/src/modules/membership/recognition.ts',
      'apps/core/src/modules/membership/recognition.test.ts',
      'apps/core/src/modules/membership/search-providers.ts',
      'apps/core/src/modules/membership/search-providers.test.ts',
      'apps/core/src/modules/membership/approval-types.ts',
      'apps/core/src/modules/membership/approval-types.test.ts',
      'apps/core/src/modules/membership/membership.controller.ts',
      'apps/core/scripts/seed-membership.ts',
      'apps/core/test/membership-recognition.e2e.test.ts',
      'apps/web/src/lib/membership-api.ts',
      'apps/web/src/screens/counter-instruments.tsx',
      'apps/web/src/screens/counter-instruments.test.tsx',
      'apps/core/src/modules/membership/index.ts',
      'apps/core/src/modules/membership/manifest.ts',
      'apps/core/src/modules/membership/events.ts',
      'apps/core/src/modules/membership/membership.module.ts',
      'apps/core/package.json',
      'docker/prod/deploy.sh',
      'packages/contracts/src/search.ts',
      'packages/contracts/src/search.test.ts',
      'apps/web/src/router.tsx',
      'apps/core/test/caddyfile-parity.test.ts',
      'apps/web/src/screens/billing-counter.tsx',
      'apps/web/src/locales/en.json',
      'apps/web/src/locales/hi.json',
    ],
    brief: `## Task T3 — Recognition at the counter

Read the plan's **§2 Ground truth** (the 11h search seam, the DD8 limiter, \`normalizeForSearch\`,
merge semantics), **§5 DD8, DD11, DD15, DD16**, **§4 O-1 and O-2**, **§6.0 S3, S10, S11, S14**, and
**§6 T3**.

\`resolveInstruments(db, {patientId, presentedCodes, at})\` produces T2's \`ResolvedInstruments\`.
This task ships **before** the billing integration by design — DD8: counter discounts cannot
backfill, so recognition must be live before the counter can bill a member.

### The five things measured or ruled at compile time

1. **The sealed gate goes in the SQL, in the SAME query that produces the count.** 11h's
   independent review found a sealed patient reachable through a chip-scoped query where both halves
   were individually correct (§2.89). Use \`visiblePatientIds()\` — the helper 11h's remediation made
   the single gate. **Never re-implement confidentiality, and never post-filter.**
2. **\`\\b\` IS ASCII-ONLY** (F7). \`/\\b(word|शब्द)\\b/\` never matches the Devanagari half, silently,
   because the English half still works. If you regex user text, do not use \`\\b\` for a bilingual
   pattern. \`normalizeForSearch\` + the \`0021\` trigram index are the shipped mechanism — reuse, do
   not reinvent.
3. **Rate limiting reuses \`checkSearchRate\` verbatim** (plan §2). Read its docstring first: a
   refusal is an **EVENT, never an audit row**, because writing refusals to the counted table makes
   every retry extend the block — it fails closed on the busiest counter in the building.
4. **S10 — \`SearchEntity\` is a CLOSED union in \`packages/contracts\`,** beside the \`@alias\` table
   a desk types. **Add a member and an alias; change nothing else in that package.** Checked at
   compile: no reader switches exhaustively, so widening is safe.
5. **S14 — \`seed:membership\` joins \`docker/prod/deploy.sh\`.** It runs **beside
   \`seed:billing\`/\`seed:tariff\` and BEFORE \`seed:roles\`** (that script's census counts what other
   seeds already granted), and it must be **non-destructive on re-run** (\`onConflictDoNothing\`) —
   read the comment block above the seed calls; it explains the ordering and the convention. One
   line added to that file, nothing else. **\`import-holder-book\` (T5) deliberately does NOT go
   there** — a deploy that imported a holder book would be importing data nobody asked it for.

### S11 — the SPA route census

\`apps/core/test/caddyfile-parity.test.ts\` asserts the parsed route count. You add one screen, so
you move it by one. **Measure it; do not guess.** No Caddyfile change is needed — every call goes
through the one \`/api\` door, measured at compile.

### O-1's grace-honor, and its teeth

Default is **refuse-with-event**. Grace-honor needs an approval (\`membership_grace_honor\`,
approver \`billing_manager\`, \`actFirstAllowed: false\`) and emits \`instrument.grace_honored\`. A
grace-honored instance carries \`origin = 'grace'\` and **accrues nothing** until a real book row
matches it — there is no partner sale reference to attribute to (C-17).

### The web half

Locale keys go in **both** \`en.json\` and \`hi.json\`. **Add keys; do not re-serialise the file** —
F5 caught a 989-line locale reformat that existed to add one key. E-32: the honouring response
carries the disclosure line, and **no counter screen shows a sales figure.**`,
    criteria: [
      'Book rows C1-C5 built as mutants, each DIED with expected-vs-received quoted.',
      'C1 specifically: the sealed gate is in the SQL and `total` is counted by the SAME query. A mutant that computes `total` without the gate must die.',
      'A Devanagari-stored holder is found by a Latin query AND the reverse. Both directions asserted.',
      'Lookup past the limit is refused with `Retry-After`, and the refusal is an EVENT, not a `search_audit` row. Assert the audit table did NOT grow.',
      'Grace-honor without an approval is refused; with one it emits `instrument.grace_honored` and the instance carries `origin=\'grace\'`.',
      '`seed:membership` registers the approval type, is idempotent on a second run (quote both runs), and is added to `docker/prod/deploy.sh` beside seed:billing/seed:tariff and BEFORE seed:roles.',
      '`packages/contracts/src/search.ts` gains one union member and one alias, and nothing else in that package changed.',
      'The SPA route census in `caddyfile-parity.test.ts` is re-measured and updated; no Caddyfile change.',
      'The e2e covers the null-auth case (11h MAJOR-5). Locale keys added to BOTH en.json and hi.json without re-serialising either file.',
      'The honouring response carries the disclosure text; no counter screen renders a sales figure (E-32).',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
  {
    id: 'T4', wave: 4, tier: 'CRITICAL', model: 'opus', gate: true, deps: ['T3'],
    commit: 'fix(core): member benefits at the counter — consume and restore as one property (09 T4)',
    files: [
      'apps/core/src/modules/membership/entitlements.ts',
      'apps/core/src/modules/membership/entitlements.test.ts',
      'apps/core/src/modules/membership/entitlements.contention.test.ts',
      'apps/core/src/modules/membership/redemptions.ts',
      'apps/core/src/modules/membership/redemptions.test.ts',
      'apps/core/src/modules/billing/accrual-view.ts',
      'apps/core/src/modules/billing/accrual-view.test.ts',
      'apps/core/src/modules/membership/index.ts',
      'apps/core/src/modules/billing/index.ts',
      'apps/core/src/modules/billing/invoices.ts',
      'apps/core/src/modules/billing/credit-notes.ts',
      'apps/core/src/modules/billing/receipts.ts',
      'apps/core/src/modules/billing/golden-billing.test.ts',
    ],
    brief: `## Task T4 — The billing integration, and DD19's seam

Read the plan's **§3 Q4 and Q6 (both MEASURED, and Q4 REFUTED the plan's first accrual base)**,
**§5 DD2, DD9, DD10, DD12, DD19**, **§4 O-4**, **§6.0 S12 and S15**, and **§6 T4**.

**Consume and restore ship together in this one task on purpose.** They are one property, and the
defect class where one task ships a mechanism dormant and a later one arms it (§2.86) is exactly
what splitting them would invite.

### What §3 Q6 measured about the lock — including about the TEST

- \`SELECT … FOR UPDATE\` on the parent counter row **does** serialise: B blocked the full 605 ms and
  released within 0 ms of A's COMMIT; with the lock removed it returned in 2 ms. Natural race:
  **over-consumption 0/20 with the lock, 20/20 without.** The window opens on its own in READ
  COMMITTED — do not engineer it.
- **THE WARNING THAT CHANGES YOUR TEST.** A forced interleave alone **does not discriminate the
  outcome**: both runs end with one movement row, because the forced ordering serialises the compute
  step anyway. **A contention test asserting only "one movement row" PASSES against a lock-less
  implementation** — \`versions.contention.test.ts\`'s own recorded lesson, recurring. **Assert the
  BLOCK**: that the second client's \`SELECT … FOR UPDATE\` has not settled while the first holds,
  and does settle within milliseconds of its COMMIT. Then run the natural race and report the
  **OBSERVED** rate both ways.
- Rule 20 / §2.53: before you trust a race measurement, check for other jest runs and **read the
  matched command LINES, not the count** — the probe matches its own shell.
- The single-use coupon's partial unique index fired **10/10** with the lock removed. The lock's job
  is to turn a raw \`23505\` into a clean typed refusal; the index's job is that the second
  redemption never lands. **Both of DD10's mutants discriminate — build both.**

### DD19's seam, and §2.49 binds hardest here

\`invoiceAccrualView\` in the new \`accrual-view.ts\`, exported through billing's index, is the ONLY
way T6 will read billing money — the isolation lint stops \`partners\` reaching deeper, and
\`creditedPaiseOf\`/\`allocatedPaiseOf\`/\`enteredInErrorDocIds\` are private. **It has no caller until
T6**, which is precisely how a vacuous test is born. Its fixtures therefore carry a credit note **on
an eligible line**, an allocation reversal, and an entered-in-error mark, with numbers that **differ
from each other**, so an implementation returning the pre-credit numbers fails.

**A fixture trap measured in §3 Q4:** \`issueCreditNote({ lines: [{ invoiceLineId }] })\` wants the
**stored \`invoice_lines.id\`**, not the caller's draft \`lineId\`. Read the ids back
(\`select … from invoice_lines order by line_no\`).

### S12 — a constraint on your DIFF, not your Files list

\`billing-purity.test.ts\` greps **every file under \`modules/billing\`, fixtures and tests included**,
for \`Math.round\`, \`toFixed\`, \`parseFloat\`, \`* 0.\` and **\`z.coerce\`** — with the token list
assembled from fragments so the sweep covers its own file. Every division goes through
\`divHalfUp\` from the frozen tariff index. A zod coercion is not available in that directory.

### The composition

DD2's shape, behind \`MEMBER_BENEFITS_ENABLED\`, in \`priceDraft\`. Source order
\`[rule, manual, membership, coupon]\` — a ruling, not an accident (DD2 says why). With the flag off,
compose nothing and every existing billing test must pass **unchanged**.

O-4's narrowing: release a redemption **only** on \`markEnteredInError\` of the invoice's receipt or
a **full-value \`correction\`** credit note. A partial refund releases nothing.`,
    criteria: [
      'Book rows D1-D6 built as mutants, each DIED with expected-vs-received quoted. D3 is TWO mutants: lock removed keeping the index, and index removed keeping the lock.',
      'The contention test asserts the BLOCK (not merely the outcome): the second client has not settled while the first holds, and settles within ms of its COMMIT. Quote the timings.',
      'The natural race is run and the OBSERVED over-consumption rate is reported BOTH ways (with and without the lock), as a rate, not a prediction.',
      'Rule 20: `pgrep -af jest` was run and the matched LINES were read; the report says whether interference was observed either way.',
      '`invoiceAccrualView` is exported through billing\'s index and its tests run against invoices carrying a credit note on an ELIGIBLE line, an allocation reversal, and an entered-in-error mark, with numbers that differ. An implementation returning pre-credit numbers must fail them.',
      'With `MEMBER_BENEFITS_ENABLED` off, `priceDraft` composes nothing and every pre-existing billing test passes unchanged.',
      'With it on, a member\'s benefit appears in `invoice_lines.candidates` and, when it wins, in `winner`.',
      'A partial credit note restores only the reversed line\'s counter; restore after the counter\'s validity lapsed succeeds and is flagged; a partial refund releases no coupon.',
      'No `Math.round`, `toFixed`, `parseFloat`, `* 0.` or `z.coerce` appears anywhere in the diff under `modules/billing` (S12); every division goes through `divHalfUp`.',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
  {
    id: 'T5', wave: 5, tier: 'CRITICAL', model: 'opus', gate: true, deps: ['T4'],
    commit: 'feat(core,web): the holder-book import — quarantine, provenance and a reconcile queue that never auto-links (09 T5)',
    files: [
      'apps/core/src/modules/membership/import/column-maps.ts',
      'apps/core/src/modules/membership/import/column-maps.test.ts',
      'apps/core/src/modules/membership/import/importer.ts',
      'apps/core/src/modules/membership/import/importer.test.ts',
      'apps/core/src/modules/membership/import/quarantine.ts',
      'apps/core/src/modules/membership/import/quarantine.test.ts',
      'apps/core/src/modules/membership/import/match-queue.ts',
      'apps/core/src/modules/membership/import/match-queue.test.ts',
      'apps/core/src/modules/membership/import/fixtures/',
      'apps/core/scripts/import-holder-book.ts',
      'apps/web/src/screens/instrument-reconcile.tsx',
      'apps/web/src/screens/instrument-reconcile.test.tsx',
      'apps/core/src/modules/membership/index.ts',
      'apps/core/src/modules/membership/manifest.ts',
      'apps/core/src/modules/membership/events.ts',
      'apps/core/src/modules/membership/membership.controller.ts',
      'apps/core/src/modules/membership/membership.module.ts',
      'apps/core/package.json',
      'apps/web/src/lib/membership-api.ts',
      'apps/web/src/router.tsx',
      'apps/core/test/caddyfile-parity.test.ts',
      'apps/web/src/locales/en.json',
      'apps/web/src/locales/hi.json',
    ],
    brief: `## Task T5 — The holder-book import

Read the plan's **§5 DD3, DD12's provenance clause, DD11**, **§4 O-5 and O-9**, **§6.0 S11**, and
**§6 T5**. The edge cases are I1-I10 in the plan's acceptance line; every one is a test.

### O-9 is the constraint that shapes your fixtures, and it is absolute

The out-of-git partner book at \`/opt/hmis-context/\` **may not be read by you and may not be
transcribed into any tracked file.** A fixture is a tracked file. **Invent your own rows** — invented
codes, invented people — covering the same DIRT CLASSES: duplicate key within a drop, the same person
under a Devanagari and a Latin spelling across drops, a phone shared by a whole family, a
covered-member count over the plan cap, \`valid_till\` before \`valid_from\`, a re-sent file, a holder
who fuzzy-matches a registered patient, and a dormant holder never seen at a counter. **A class does
not care which invented name carries it.**

### The rulings that decide behaviour

- **Idempotency is on \`(counterparty, partner_sale_ref)\`**, not on the card number — a card number
  can be reissued.
- **A duplicate within one drop quarantines BOTH rows with a reason. Never last-wins.**
- **A fuzzy patient match NEVER auto-links.** It lands in the manual reconcile queue. Plan 05's
  merge machinery is the precedent and \`resolvePatientId\` is how a merged holder resolves — merge
  never rewrites another module's rows (DD11).
- **O-5: over-cap covered members are honoured TO the cap, in the file's own row order, and the
  overflow is recorded with its provenance and surfaced in the queue.** Never quarantine the row —
  the member paid, and the overflow is the partner's data error.
- **Every produced row carries provenance**: import id and row number. Dispute forensics is the
  whole point.
- **An unknown column shape FAILS LOUDLY.** Never map by position as a fallback — a silent
  positional map is how a phone number becomes a date of birth.

### S11

\`apps/core/test/caddyfile-parity.test.ts\` pins the parsed SPA route count. You add one screen.
Measure the new number; do not guess.

Locale keys in **both** files, added not re-serialised (F5).

**\`import-holder-book\` is an OPERATOR command and deliberately does NOT go into
\`docker/prod/deploy.sh\`** — a deploy that imported a holder book would be importing data nobody
asked it for. That file is not in your Files list.`,
    criteria: [
      'Book rows E1-E5 built as mutants, each DIED with expected-vs-received quoted.',
      'Re-importing the same file produces zero new rows and reports that it did.',
      'A duplicate key within one drop quarantines BOTH rows with a reason; neither wins.',
      'An inverted validity range quarantines; an unknown column shape refuses loudly with no positional fallback.',
      'A holder who fuzzy-matches an existing patient lands in the queue and is NOT linked. A shared family phone imports cleanly.',
      'Over-cap members are honoured to cap in file order with the overflow recorded and queued (O-5), never silently dropped.',
      'Every produced instance carries its import id and row number.',
      'No value, code, rate or name from `/opt/hmis-context/` appears in any fixture; the fixtures were invented by this task (O-9). The context directory was not read.',
      'The SPA route census is re-measured; locale keys added to both files without re-serialising either.',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
  {
    id: 'T6', wave: 6, tier: 'CRITICAL', model: 'opus', gate: true, deps: ['T5'],
    commit: 'feat(core): the accrual consumer — replay-safe, snapshot-rated, and inert until the CA gate opens (09 T6)',
    files: [
      'apps/core/src/modules/partners/accrual.ts',
      'apps/core/src/modules/partners/accrual.test.ts',
      'apps/core/src/modules/partners/agreements.ts',
      'apps/core/src/modules/partners/agreements.test.ts',
      'apps/core/src/modules/partners/consumer.ts',
      'apps/core/src/modules/partners/consumer.test.ts',
      'apps/core/src/modules/partners/replay.ts',
      'apps/core/src/modules/partners/replay.test.ts',
      'apps/core/src/modules/partners/kicker.ts',
      'apps/core/src/modules/partners/kicker.test.ts',
      'apps/core/src/modules/partners/golden/fixture-schema.ts',
      'apps/core/src/modules/partners/golden/golden.test.ts',
      'apps/core/src/modules/partners/golden/fixtures/',
      'apps/core/src/modules/partners/index.ts',
      'apps/core/src/modules/partners/manifest.ts',
      'apps/core/src/modules/partners/events.ts',
      'apps/core/src/modules/partners/partners.module.ts',
      'apps/core/src/kernel/worker/worker.module.ts',
      'apps/core/src/kernel/modules/manifests.ts',
      'apps/core/src/kernel/modules/manifests.test.ts',
      'apps/core/test/worker-runtime.e2e.test.ts',
    ],
    brief: `## Task T6 — The accrual consumer

Read the plan's **§3 Q4 (MEASURED — it REFUTED the first version of the base and found a third
money-carrying event)**, **§5 DD5, DD6, DD7, DD12, DD19**, **§4 O-6 and O-7**, **§6.0 S2 and S15**,
and **§6 T6**. **DD12 is the arithmetic and it is not yours to re-derive.**

### The registration is ONE edit (S2, and it is Plan 10 D13's lesson verbatim)

\`partnersManifest\` gains its **FOUR** subscriptions, \`workerConsumers(db)\` gains the handler, the
worker registry installs the manifest, and \`manifests.test.ts\`'s census records it — **all in this
one commit.** \`buildSubscriptionBus\` turns a declared subscription with no matching handler into a
boot error, and passing the handler without installing means the lane hears nothing. Both halves,
one commit.

**The four names, and why four:** \`payment.received\` · \`payment.refunded\` ·
**\`allocation.reversed\`** · **\`credit_note.issued\`**. §3 Q4 measured that \`reverseAllocation\` and
\`markEnteredInError\` both emit \`allocation.reversed\` and **neither emits a refund event** — a
consumer on the first two names accrues and never gives it back.

### DD7's inversion — read it twice, because the obvious implementation is wrong

**The consumer registers ALWAYS and advances its cursor ALWAYS.** The flag decides only whether it
**WRITES**. Registering conditionally is check-on-execute wearing a manifest's clothes, and it is
silently lossy: a subscription that never registered has no cursor, so flipping the flag later
starts from *now* and every earlier event is gone. Flag-on plus **replay** is the tested path.

### DD12, and the one thing that makes it simple

Under delta-to-target the handler **does not branch on which of the four events arrived.** Every one
re-reads the invoice through \`invoiceAccrualView\` (T4's seam), computes the target, and appends the
delta. A refund, a reversal, a credit note and an entered-in-error mark all move \`collected\` or
\`settleable\`, so all four produce a negative delta through the same line. **There is no separate
reversal path to write.**

Serialise with the \`commission_accrual_subjects\` row: upsert, \`SELECT … FOR UPDATE\`, then sum and
append inside the lock. Two dispatch cycles handling two different events for one invoice
concurrently is a real, observed shape (the alerts consumer's docstring records it).

**DD6: the agreement version is resolved at the INVOICE's issue instant**, not at each payment's —
otherwise a later payment would recompute the whole invoice at a new rate and an amendment would
rewrite history, which is what DD6 forbids. \`occurredAt\` still orders the stream and still drives
the kicker.

### Golden fixtures

Your own harness under \`partners/golden/\`, same \`workings\` discipline as T2's. **Every money path
gets a fixture with hand-computed arithmetic**, and one of them is §3 Q4's own counter-example: a
settled invoice carrying a credit note on an eligible line, where the correct base is 45 000 and the
refuted formula gives 63 543. **That fixture is what kills mutant F3b.**

Dead-letter parking must not halt the lane (A8): a poison row parks, alerts, and the next event
still processes.`,
    criteria: [
      'Book rows F1, F2, F3, F3b, F3c, F4-F11 built as mutants, each DIED with expected-vs-received quoted. F3b is the REFUTED first version of the base and is killed by §3 Q4\'s own fixture.',
      'FOUR subscriptions declared on the manifest AND the handler present in `workerConsumers(db)`; the e2e that compares the two lists is extended and passes.',
      'With `COMMISSION_ACCRUAL_ENABLED` off: no accrual row exists AND the cursor still advances. Both asserted separately.',
      'Flag-on plus replay reproduces exactly what live processing would have produced. Quote both ledgers.',
      'A redelivered event produces no second accrual; two concurrent events for one invoice cannot double-append (the subject-row lock, mutant F11).',
      'An accrual straddling an amendment uses the version effective at the INVOICE\'s issue instant, and its snapshot proves it (mutant F7 has two legs).',
      'Every money path has a golden fixture whose `workings` shows hand-computed arithmetic, including §3 Q4\'s credit-note counter-example.',
      'A poison row parks and alerts, and the next event still processes (A8).',
      'Suspension writes an `escrowed` row rather than skipping the write (O-7); the kicker counts ACTIVATED, not fed (O-6).',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
  {
    id: 'T7', wave: 7, tier: 'CRITICAL', model: 'opus', gate: true, deps: ['T6'],
    commit: 'feat(core,web): the receivable-commission instrument — attribution, statements and an aging report (09 T7)',
    files: [
      'apps/core/src/modules/partners/attribution.ts',
      'apps/core/src/modules/partners/attribution.test.ts',
      'apps/core/src/modules/partners/statements.ts',
      'apps/core/src/modules/partners/statements.test.ts',
      'apps/core/src/modules/partners/reconcile.ts',
      'apps/core/src/modules/partners/reconcile.test.ts',
      'apps/core/src/modules/partners/aging.ts',
      'apps/core/src/modules/partners/aging.test.ts',
      'apps/core/src/modules/partners/partners.controller.ts',
      'apps/core/test/partners-receivables.e2e.test.ts',
      'apps/web/src/lib/partners-api.ts',
      'apps/web/src/screens/partner-receivables.tsx',
      'apps/web/src/screens/partner-receivables.test.tsx',
      'apps/core/src/modules/partners/index.ts',
      'apps/core/src/modules/partners/manifest.ts',
      'apps/core/src/modules/partners/events.ts',
      'apps/core/src/modules/partners/partners.module.ts',
      'apps/web/src/router.tsx',
      'apps/core/test/caddyfile-parity.test.ts',
      'apps/web/src/locales/en.json',
      'apps/web/src/locales/hi.json',
    ],
    brief: `## Task T7 — The receivable instrument

Read the plan's **§5 DD5, DD13, DD15**, **§4 O-8**, **§6.0 S11**, and **§6 T7**. V1-V7 are the
acceptance backbone.

### DD13's two rules, and they are the whole design

1. **An outbound referral issues ONE attribution id, to ONE partner, at referral time.** The partner
   whose id is on the slip is the partner with the claim. A statement line quoting a different
   partner's id is \`disputed\` — V6 is a rule to state, not a conflict to resolve.
2. **FUZZY JOINS ARE FORBIDDEN.** A partner's own reference space joins through the explicit mapping
   table and nothing else. A fuzzy match that is wrong once in a thousand rows produces a
   reconciliation nobody can audit and a dispute nobody can settle. **Ship a test that proves no
   fuzzy fallback exists** (mutant G3 adds one and must die).

### The lifecycle lives on the expectation, not on the ledger

\`receivable_expectations\` walks \`expected → matched → disputed → written_off\` and is **not**
append-only. \`commission_accruals\` **is**. DD5 says why: the ledger records money, the expectation
records a claim, and mixing them is what makes an append-only ledger need an UPDATE. A statement's
late correction (V3) is an **adjustment row**, never an edit.

The QR/barcode path reuses 11h's wedge. **11h's own finding: the wedge fired multiple times per scan
with truncated payloads before it was fixed** — read what shipped rather than re-deriving it.

### DD15 — nothing partner-facing carries identity

Instrument ids, attribution ids and amounts. No name, no UHID, no phone, no patient id. This is
11h's sealed-patient lesson applied at design time instead of at review time.

### S11

The SPA route census in \`caddyfile-parity.test.ts\` moves by one. Measure it. Locale keys in both
files, added not re-serialised.

\`RECEIVABLE_COMMISSION_ENABLED\` is **CA-gated (O-8, the owner's)** and ships OFF. Mutant G5 proves
the flag is load-bearing.`,
    criteria: [
      'Book rows G1-G5 built as mutants, each DIED with expected-vs-received quoted.',
      'A statement line with no hospital attribution becomes `disputed`, never silently accepted (V1).',
      'A hospital attribution absent from a statement ages and appears in the report (V2).',
      'A late correction lands as an adjustment row and edits nothing, with the append-only trigger live (V3).',
      'A cancelled test voids its expectation (V4); an unclaimed slip expires after the configured days (V5).',
      'A statement quoting another partner\'s attribution id is disputed (V6).',
      'The mapping table is the ONLY join and a test proves no fuzzy fallback exists (V7, mutant G3).',
      'No partner-facing read model, export or statement view carries a patients-table field (DD15).',
      '`RECEIVABLE_COMMISSION_ENABLED` off means no expectation is created (mutant G5).',
      'The SPA route census is re-measured; locale keys added to both files without re-serialising either.',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
  {
    id: 'T8', wave: 8, tier: 'ROUTINE', model: 'sonnet', gate: false, deps: ['T7'],
    commit: 'feat(core,web): channel P&L, identity-free exports and the flag runbook (09 T8)',
    files: [
      'apps/core/src/modules/partners/pnl.ts',
      'apps/core/src/modules/partners/pnl.test.ts',
      'apps/core/src/modules/partners/exports.ts',
      'apps/core/src/modules/partners/exports.test.ts',
      'apps/core/src/modules/membership/guardrails.test.ts',
      'apps/web/src/screens/partner-pnl.tsx',
      'apps/web/src/screens/partner-pnl.test.tsx',
      'apps/core/src/modules/partners/index.ts',
      'apps/core/src/modules/partners/manifest.ts',
      'apps/core/src/modules/partners/partners.controller.ts',
      'apps/web/src/lib/partners-api.ts',
      'apps/web/src/router.tsx',
      'apps/core/test/caddyfile-parity.test.ts',
      'apps/web/src/locales/en.json',
      'apps/web/src/locales/hi.json',
      'README.md',
    ],
    brief: `## Task T8 — Guardrails, identity-free exports, the channel P&L, and the runbook

Read the plan's **§5 DD14 and DD15**, **§4 O-8**, **§6.0 S5**, **§7**, and **§6 T8**.

### An EXPLICIT NON-GOAL, and it is a compile-sweep finding (S5)

**\`check:config-present\` does NOT learn about this phase.** Plan 09's catalogs are legitimately
empty until commissioning (DD3), and 11g's deploy gate has a third leg specifically so it does not
refuse every deploy over config that is correctly absent. **Record this reasoning as a comment in
\`guardrails.test.ts\`** so the next reader does not "complete" the gate. \`check-config-present.ts\`
is not in your Files list and must not be edited.

### DD15's export test is the one that can pass vacuously

**Walk the exported row SHAPE and refuse any field whose source is the patients table.** An export
shape that happens to be empty satisfies every assertion ever written (§2.49), so ship a
**synthetic leg that CAN fail**: a row shape deliberately carrying a patient field, asserted to be
refused.

### The runbook

In \`README.md\`. **All five flags, the ORDER the owner flips them in, and which CA/counsel register
item gates each.** DD14 has the mapping; §7 has what stays the owner's. The order is DD8's:
recognition deployed → import run → reconcile queue cleared → member benefits armed; the three
CA-gated lanes wait on O-8.

### The P&L

Per partner: cards active, member spend, commission payable, receivables expected/matched/disputed,
net channel margin. **It must read ZEROS with the lanes off and not error** — that is its acceptance,
not an afterthought.

### ROUTINE means no mutants are owed

AGENT-RULES §3: tests are required and must pass; **mutants are not required and fail-first is not
owed — say so rather than manufacturing one.** If you NOTICE an assertion that cannot discriminate,
**say so as a finding** — that is worth more than a mutant nobody asked for.

### S11

The SPA route census moves by one. Measure it. Locale keys in both files, added not re-serialised.`,
    criteria: [
      'No exported field resolves to a patients-table column, proven by walking the row SHAPE; the test has a synthetic leg that CAN fail (a shape carrying a patient field, refused).',
      'No counter screen renders a sales figure (E-32); the guardrail enforcement points are collected and tested in one place.',
      'The P&L read model returns zeros with all lanes off and does not error.',
      'The README runbook names all five flags, the order the owner flips them in, and the CA/counsel register item gating each.',
      '`guardrails.test.ts` carries a comment recording S5: `check:config-present` deliberately does NOT learn about this phase, with the reason. `check-config-present.ts` is not edited.',
      'The SPA route census is re-measured; locale keys added to both files without re-serialising either.',
      'Fail-first is explicitly declared not owed (ROUTINE). Any non-discriminating assertion noticed is reported as a finding.',
      'Detached `pnpm verify` exit VALUE 0 from a file; totals did not decrease; no test deleted; clean tree; no lockfile diff.',
    ],
  },
]

// ============================== SHARED PROMPT BLOCKS ==============================

const RULES_POINTER = 'READ `' + RULES + '` IN FULL BEFORE YOU TOUCH ANYTHING.\n'
  + 'It is the binding contract. Where it and this brief disagree about PROCESS, it wins; where they\n'
  + 'disagree about CODE, the plan document wins.\n\n'
  + 'NOTE WHAT IS STRUCK IN IT, because it changes how you work: rule 13 and ALL of rule 22 (the\n'
  + 'local mirror) are STRUCK — you are ON the build host, in the checkout at `/opt/hmis`, so Read,\n'
  + 'Edit, Write and Grep target it natively. There is no mirror, no `scp`, no md5 confirmation.\n'
  + 'Rules 1-3 compress to one sentence: `/opt/hmis` and `/opt/hmis-prod` are the only writable\n'
  + 'paths, and NO WRITES TO `/tmp`, EVER. Rules 7 and 14-21 are unchanged and the evidence standard\n'
  + 'is unchanged: evidence comes only from this host.'

const PLAN_POINTER = 'THE PLAN IS THE DESIGN LAW AND IT IS ON THIS HOST:\n\n  ' + PLAN
  + '\n\nRead the sections your brief names. **DO NOT ask this brief to restate the plan** — the brief\n'
  + 'deliberately carries only what the plan does not: facts measured at compile or spike time, and\n'
  + 'traps. The plan carries the design, the Files list, the acceptance criteria and the Assertion\n'
  + 'Book rows for your task, inline in §6.\n\n'
  + 'Its §6.0 is the COMPILE-TIME SWEEP — thirteen findings, several of them about YOUR Files list\n'
  + 'and why a file you might not expect is in it. Read the ones your brief names.\n\n'
  + 'THE LEDGER, for the §-numbered lessons this brief and the plan both cite:\n\n  ' + LEDGER
  + '\n\nYou do not need to read it end to end. When a brief cites `§2.87` or `§3.12`, that is where\n'
  + 'the specimen is.\n\n'
  + 'DO NOT re-litigate the plan\'s design decisions or its rulings — they are owner-approved or\n'
  + 'session-ruled law and the reasons are written down. If you believe the PLAN is defective, that\n'
  + 'is a FINDING you report with evidence, not a licence to redesign.'

const CONTEXT_BAN = 'A HARD BOUNDARY ON THIS PHASE, AND IT IS THE OWNER\'S STANDING INSTRUCTION.\n\n'
  + 'Two files live OUT OF GIT at `/opt/hmis-context/`. **You do not need them, you must not read\n'
  + 'them, and NOTHING FROM THEM MAY EVER REACH A TRACKED FILE.** The repository is PUBLIC. The plan\n'
  + 'document was written under the same rule and contains no partner name, partner code, plan code,\n'
  + 'coupon code, rate, price, card number or sample person — which is why it describes SHAPES.\n\n'
  + 'Concretely (plan §4 O-9 and §5 DD3): every plan, coupon, partner and agreement term is a CONFIG\n'
  + 'ROW loaded at commissioning, never a constant in `apps/`. **Fixtures invent their own codes and\n'
  + 'their own people.** A fixture tests a CLASS — a duplicate key, a mixed-script name, an over-cap\n'
  + 'family — and a class does not care which invented name carries it. If you find yourself wanting\n'
  + 'a realistic-looking rate or code, invent one.'

const GROUND_TRUTH = 'GROUND TRUTH, MEASURED BY THE MAIN SESSION IMMEDIATELY BEFORE THIS PIPELINE\n'
  + 'STARTED — detached `pnpm verify`, exit VALUE read from a file, exit 0, at `' + BASELINE_SHA + '`:\n\n'
  + '  ' + BASELINE + '\n\n'
  + 'A BASELINE HAS A SHELF LIFE INSIDE A PIPELINE THAT MUTATES SHARED STATE (§2.21). Earlier waves\n'
  + 'in this run have added tests and, in wave 1, a MIGRATION. So: treat the numbers above as the\n'
  + 'floor AGREEMENT RULES §4 cares about — the workspace total must not DECREASE and your diff must\n'
  + 'DELETE no test — and MEASURE the current totals yourself rather than reconciling against a\n'
  + 'remembered figure. If what you measure disagrees with the line above, REPORT THE DIFFERENCE AND\n'
  + 'ITS CAUSE. Never pad, split, merge or delete a test to hit a number.'

const EVIDENCE = 'EVIDENCE DISCIPLINE — the five ways this project has actually been lied to by its own\n'
  + 'tooling. Every one is a ledger entry with a specimen:\n\n'
  + '- NEVER take a PIPELINE\'s exit status as a COMMAND\'s verdict. `pnpm verify 2>&1 | tail -40`\n'
  + '  exits 0 even when verify FAILED — that is `tail`\'s status, and it is a silent false PASS.\n'
  + '  `| head -N` fails the opposite way, closing the pipe early. Capture `${PIPESTATUS[0]}` or run\n'
  + '  unpiped (rule 16). NEVER infer pass/fail from a truncated window.\n'
  + '- NEVER take a WRAPPER\'s exit status as the command\'s. `; echo "exit: $?"` makes the shell exit\n'
  + '  0 because the ECHO succeeded. Read the echoed VALUE, or a captured exit file (rule 17).\n'
  + '- RUN ANY LONG COMMAND DETACHED with its exit code written to a file, then poll that file\n'
  + '  (rule 18). `pnpm verify` here runs ~450-700 s.\n'
  + '- A JEST NAME FILTER MUST ISOLATE, and `pnpm --filter … test -- <path> -t X` does NOT: pnpm\n'
  + '  injects a literal `--`, your pattern becomes another PATH pattern, and the whole suite runs\n'
  + '  looking like a passing single test. Bypass the script — `pnpm --filter @hmis/core exec jest\n'
  + '  --passWithNoTests <path> -t "<name>"` — and confirm isolation in the OUTPUT ("N skipped, 1\n'
  + '  passed"), never in the exit code (rule 19).\n'
  + '- `pgrep -af jest` MATCHES ITS OWN INVOKING SHELL, and so does `pkill -f`. **Read the matched\n'
  + '  command LINES, never the count** (rule 20, §2.53). Two agents have already read their own\n'
  + '  probe as somebody else\'s suite. Kill by PID, never by pattern (§2.66).\n\n'
  + 'AND FOUR FROM THE LAST PHASE, all measured:\n'
  + '- **§2.87 / F1: A TASK THAT PUSHES IS A TASK THAT MUST RUN WHAT CI RUNS.** "Full suite once, at\n'
  + '  the end" became a per-commit gap and two commits shipped RED while the build host called them\n'
  + '  green. Run the NARROW suite while iterating; run **`pnpm verify`** before you push.\n'
  + '- **F1 again, specifically: `apps/core/.env` EXISTS on this host and can NEVER exist in CI.**\n'
  + '  `loadConfig()` bare resolves here and THROWS there. Any test that calls it passes locally and\n'
  + '  fails remotely, for ever. Pass an explicit env object:\n'
  + '  `loadConfig({ DATABASE_URL: "postgres://unused", … })`. T1 ships a lint rule for this.\n'
  + '- **F3: narrow jest runs verify BEHAVIOUR, not TYPES.** `ts-jest` compiles only the files under\n'
  + '  test, so a duplicate identifier or a stale mock in a file you did not touch survives three\n'
  + '  green narrow runs and surfaces only in `pnpm verify`. Widening a shared type has a blast\n'
  + '  radius a narrow run cannot show.\n'
  + '- **F4: EDITING THE TREE DURING A VERIFY VOIDS THAT VERIFY.** Files written mid-run are compiled\n'
  + '  against a stale sibling; the run is void, not red-for-cause. Start it and leave the tree alone.\n'
  + '- **F5: READ THE COMMIT STAT.** It caught a 989-line locale reformat that existed to add one\n'
  + '  key, a drizzle snapshot missing from the commit carrying its migration, and twice, files in\n'
  + '  the wrong commit. `git show --stat` your own commit before you report it.'

const RELAY_BLOCK = 'IF YOU FIND SOMETHING A LATER TASK MUST KNOW, WRITE IT WHERE THAT TASK WILL READ IT.\n'
  + 'The waves run back-to-back with NO human in the gap (§2.16/§2.39), so a finding that names a\n'
  + 'later task has nowhere to go unless you put it here:\n\n  ' + RELAY
  + '\n\nAPPEND to it, never rewrite it: a dated entry naming the task it is for, what you found, and\n'
  + 'the evidence. Then also put it in your `findings`.\n\n'
  + 'IT IS UNTRACKED SCRATCH AND IT IS THE ONE EXPECTED EXCEPTION IN `git status`. Do NOT delete it\n'
  + 'in your cleanup, do NOT `git add` it, and do NOT report its presence as an unclean tree. The\n'
  + 'main session folds it into the plan document\'s CLOSE section and it is never committed as a file\n'
  + 'of its own — that is how this pipeline satisfies both §2.16 and EXECUTE-METHOD-V3 §1, and the\n'
  + 'ruling is recorded in the plan\'s THE LANE block.\n\n'
  + 'STEP 0, BEFORE ANYTHING ELSE: READ IT. It holds what earlier waves found out about the surfaces\n'
  + 'you are about to build on — discovered AFTER your brief was compiled, and as binding as the\n'
  + 'brief. If it has no entries, say so and move on.\n\n'
  + '§2.67 — WHEN YOU BOOK A SURVIVOR AS BENIGN, SAY WHICH MUTANT YOU BUILT AND WHAT THE CLASS OF\n'
  + 'UNBUILT ONES IS, OR SAY THAT YOU DO NOT KNOW. "I built the mutant and it was harmless"\n'
  + 'generalises from one mutant to a whole class, and that generalisation is a prediction like any\n'
  + 'other. A reassurance routed forward inherits rule 21\'s burden exactly as an explanation does.'

function frozenBlock(t) {
  const mine = new Set(t.files)
  const others = []
  TASKS.forEach(function (o) {
    if (o.id === t.id) return
    o.files.forEach(function (f) { if (!mine.has(f)) others.push(f + '   (owned by ' + o.id + ')') })
  })
  const uniq = [...new Set(others)].sort()
  return 'YOUR FILES LIST — THE ONLY PATHS YOU MAY COMMIT:\n\n'
    + t.files.map(function (f) { return '  ' + f }).join('\n')
    + '\n\nA path ending in `/` is a DIRECTORY you own: every file you create inside it is yours.\n'
    + '`apps/core/drizzle/0022_<generated-name>.sql` is the generator\'s own name — report the real one.\n'
    + '\n\nIf you find yourself committing a file this list does not name, STOP. If the work genuinely\n'
    + 'requires a file outside the list, that is a PLAN DEFECT: report it with evidence rather than\n'
    + 'widening your scope. Reporting a plan defect instead of working around it is explicitly the\n'
    + 'behaviour this process wants, and it is how the plan\'s own §6.0 findings came to exist.\n\n'
    + 'FROZEN — OWNED BY OTHER TASKS IN THIS PHASE. DO NOT TOUCH THEM, EVEN IF YOUR CHANGE WOULD BE\n'
    + 'CORRECT:\n\n'
    + uniq.map(function (f) { return '  ' + f }).join('\n')
    + '\n\nEvery other path in the repository is likewise frozen to you, and the plan\'s THE LANE block\n'
    + 'names five frozen absolutely: **all of `apps/core/src/modules/tariff/`**,\n'
    + '`kernel/events/dispatcher.ts`, `kernel/db/schema/billing.ts`, `docker/prod/Caddyfile` and\n'
    + '`docker/prod/docker-compose.prod.yml`. Two exceptions to the freeze, both narrow: (a) transient\n'
    + 'MUTANT SCRATCH may sit beside its source while you work and must be deleted before your final\n'
    + 'counts and before committing (AGENT-RULES §3); (b) `pnpm-lock.yaml` must NEVER change — a diff\n'
    + 'there is a HALT.'
}

const HALT = 'HALT TO THE MAIN SESSION — STOP AND REPORT, DO NOT WORK AROUND. Any finding that would:\n'
  + '- add a SECOND migration, or ANY dependency (a `pnpm-lock.yaml` diff is a halt);\n'
  + '- touch anything under `apps/core/src/modules/tariff/` — the whole directory is frozen, and the\n'
  + '  plan\'s DD2 exists precisely so that nothing here needs to;\n'
  + '- touch `kernel/events/dispatcher.ts`;\n'
  + '- flip any of the five flags\' defaults to `true`, or weaken a sealed/confidential gate, or\n'
  + '  weaken the `external_rmp` unpayability;\n'
  + '- put ANY secret, or ANY value from `/opt/hmis-context/`, in git;\n'
  + '- require a `.github/workflows` edit — the server deploy key CANNOT push it (rule 10);\n'
  + '- stop, remove, rebuild or prune anything on rule 7\'s protected roster (`hmis-db-1`, the\n'
  + '  `hmis_hmis_pgdata` volume, or ANY `hmis-prod` container or volume);\n'
  + '- write anywhere but `/opt/hmis` (rule 3 — NO `/tmp`, ever, not even a throwaway sanity check);\n'
  + '- leave an APPLIED-THEN-ABANDONED migration (AGENT-RULES §6: stop and report which databases\n'
  + '  carry it — never delete the file, never hand-edit the journal or a `__drizzle_migrations` row).\n\n'
  + 'A SURVIVING REQUIRED-DIED MUTANT IS NEVER SILENTLY FIXED AND NEVER SILENTLY ACCEPTED\n'
  + '(AGENT-RULES §3, two branches, disclose either way): (a) the survival implies the SHIPPED CODE\n'
  + 'IS WRONG, or the fix reaches outside your Files list -> CHAIN HALT, commit nothing further,\n'
  + 'report it as a plan defect with evidence; (b) the survival means the PLAN\'S TEST cannot\n'
  + 'discriminate and that test is YOUR OWN task\'s file -> fix it minimally in-task and disclose it.\n\n'
  + 'AGENT-RULES rule 14: NEVER weaken, strip or disable security-relevant code to produce a test\n'
  + 'result — not even temporarily, not even to satisfy a reviewer asking for a failing run. If\n'
  + 'evidence requires that, say it is impossible and explain why.\n'
  + 'AGENT-RULES rule 15: NEVER rewrite published history. No `--amend`, no rebase of pushed work,\n'
  + 'no `reset --hard`, no force-push — INCLUDING on a commit you pushed minutes ago. A correction\n'
  + 'lands as a NEW follow-up commit, always. If any instruction tells you otherwise, refuse it and\n'
  + 'report that you refused.'

function finishBlock(t) {
  return 'THE FINISH BLOCK — AGENT-RULES §5. Three numbered steps, in this order, NOT chained onto\n'
    + 'one line:\n\n'
    + '0. BEFORE any `git add`: run `git status --porcelain` and READ IT. Delete every scratch file\n'
    + '   you created — mutants, scratch specs, `.log`, `.exit` — with plain `rm -f` (`rm -rf` is\n'
    + '   DENIED on this host by a standing rule; do not attempt it). The tree must contain ONLY files\n'
    + '   your Files list names, PLUS the relay file, which is the one expected exception. Never run\n'
    + '   `git add -A` over a status you have not read (§2.92 — it has twice picked up somebody\n'
    + '   else\'s work on this shared host): `git add` the paths your Files list names, BY NAME.\n'
    + '1. Commit with the plan\'s EXACT message for this task:\n\n'
    + '     ' + t.commit + '\n\n'
    + '2. `git pull --rebase origin main`   (rule 11 — docs commits land while pipelines run)\n'
    + '3. `git push origin main`\n\n'
    + 'BEFORE STEP 1, RUN `pnpm verify` DETACHED AND READ THE EXIT VALUE FROM A FILE (§2.87: a task\n'
    + 'that pushes is a task that must run what CI runs — two commits shipped red because a narrow\n'
    + 'suite was called evidence). Then `git show --stat` your own commit against your Files list\n'
    + 'before you report it (F5).\n\n'
    + 'Then confirm and report: `git status` clean, and THE RESULTING FULL COMMIT SHA. The main\n'
    + 'session checks CI by FULL sha — a short one matches nothing, prints nothing and exits 0, and\n'
    + 'that silence is "not checked", never "not failing" (§2.42/§2.84).\n'
    + 'ONE PUSH PER TASK. This pipeline is strictly sequential precisely so no two commits share a\n'
    + 'push: a coalesced push leaves the earlier commit with NO CI RUN AT ALL (§2.62).'
}

const PERSONA_CODER = 'You are a senior software engineer executing a briefed implementation task in an\n'
  + 'automated pipeline. The brief you receive is your ENTIRE context — you cannot see the\n'
  + 'conversation that produced it.\n\n'
  + '- Read the files named in the brief before changing anything. Match the existing codebase: its\n'
  + '  style, naming, idiom and comment density. This codebase explains WHY in comments, at length,\n'
  + '  where a decision was expensive — match that where it applies and nowhere else.\n'
  + '- Deliver exactly the scope in the brief. No drive-by refactors, no extra features, no\n'
  + '  speculative error handling.\n'
  + '- If the brief is contradictory or missing something essential, SAY SO in your report and do the\n'
  + '  part that is unambiguous — do not guess at the rest.\n'
  + '- EVIDENCE OVER ASSERTION (rule 12). Never report a test as passing without having run it in\n'
  + '  that state. Report results faithfully and paste failing output if anything fails.\n'
  + '- DO NOT USE ANY MCP TOOL. Do not read `/opt/hmis-context/`.'

const PERSONA_GATE = 'You are a senior reviewer GATING one implementation task in an automated pipeline.\n'
  + 'You receive the task\'s brief, its acceptance criteria and the implementing agent\'s report. You\n'
  + 'cannot see the conversation or the wider plan beyond what the brief points you at.\n\n'
  + '- Read the changed files. Judge the change against the brief: does it do what was asked, and\n'
  + '  ONLY what was asked?\n'
  + '- RE-RUN THE TESTS COVERING THE CHANGE YOURSELF. Never accept the coder\'s claim that tests pass\n'
  + '  without running them. Detached, exit VALUE from a file.\n'
  + '- Check every acceptance criterion explicitly, one by one.\n'
  + '- REBUILD THE TASK\'S REQUIRED-DIED MUTANTS YOURSELF. This is the most expensive practice in\n'
  + '  this process and it is the one that has caught surviving mutants nobody else saw. A kill is\n'
  + '  evidenced by the ASSERTION\'s own failure — quote expected vs received. A mutant that dies at\n'
  + '  TYPECHECK proves NOTHING (this repo compiles with `noUncheckedIndexedAccess`), and a class\n'
  + '  with `private` members is compared NOMINALLY, so a byte-copy mutant of one cannot be passed\n'
  + '  to a function typed against the shipped class (§2.61) — copy the one intermediate module and\n'
  + '  repoint ONLY its `import type`. A mutant that dies by TIMEOUT is not a kill either (§2.45).\n'
  + '- GO PAST THE BRIEF ONCE, DELIBERATELY. §3.43: a defect found at one door usually has more than\n'
  + '  one door. For every invariant this task constrains, ask which OTHER writer reaches the same\n'
  + '  quantity, and check it. That practice is in the ledger\'s §5 "what is working" list because a\n'
  + '  gate that did it reproduced a money defect through a writer the Files list never named.\n'
  + '- Fail conditions beyond the criteria: SCOPE CREEP (the diff touches files or behaviour neither\n'
  + '  the brief nor the criteria asked for) and OVERENGINEERING. Judge scope against the brief PLUS\n'
  + '  criteria PLUS any corrections quoted in the brief: authorized breadth is not creep.\n'
  + '- Rule on each interpretation the coder flagged: reasonable, or a wrong guess that changes the\n'
  + '  outcome? A wrong guess is a `bad-interpretation` violation.\n'
  + '- CHECK THE COMMIT STAT YOURSELF against the Files list (F5) — not against the coder\'s summary\n'
  + '  of it. A whole-file rewrite where one key was added is a finding.\n'
  + '- You CAN check CI: `bash docs/superpowers/pipelines/ci-watch-host.sh <FULL-SHA>` works from this\n'
  + '  host with no credential, and its exit value is 0 green / 1 red / 2 unresolved. Job LOGS still\n'
  + '  need a credential nobody has here, so a RED is a verdict you report, not one you diagnose.\n\n'
  + 'A pass requires: every criterion met, tests passing UNDER YOUR OWN RUN, and zero violations.\n'
  + 'Anything else is a fail. Your final message is consumed by a script, not a human — return only\n'
  + 'the structured data.'

const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'files_changed', 'tests', 'interpretations'],
  properties: {
    outcome: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests: { type: 'string' },
    interpretations: { type: 'array', items: { type: 'string' } },
    commit_sha: { type: 'string' },
    evidence: { type: 'string' },
    mutants: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
  },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'violations', 'corrections', 'tests'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    violations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['type', 'detail'],
        properties: {
          type: { type: 'string', enum: ['criterion-unmet', 'test-failure', 'scope-creep', 'overengineering', 'bad-interpretation', 'agent-error'] },
          detail: { type: 'string' },
        },
      },
    },
    corrections: { type: 'array', items: { type: 'string' } },
    retry_mode: { type: 'string', enum: ['reimplement', 'verify-only'] },
    findings: { type: 'array', items: { type: 'string' } },
    tests: {
      type: 'object', additionalProperties: false, required: ['ran', 'passed', 'failed'],
      properties: { ran: { type: 'string' }, passed: { type: 'number' }, failed: { type: 'number' } },
    },
  },
}

function coderPrompt(t, history) {
  let p = RULES_POINTER + '\n\n' + PLAN_POINTER + '\n\n' + CONTEXT_BAN + '\n\n' + RELAY_BLOCK
    + '\n\n' + GROUND_TRUTH + '\n\n' + EVIDENCE + '\n\n' + PERSONA_CODER
    + '\n\nRISK TIER: ' + t.tier + (t.tier === 'CRITICAL'
      ? '. AGENT-RULES §3\'s CRITICAL branch applies IN FULL: build every mutant the plan\'s Assertion\nBook names for your task (they are inline in the plan\'s §6, in your task\'s own table), in a\nSEPARATE scratch file beside the source — never by editing, moving or reverting the shipped file —\nrun ISOLATED, quote the isolation line and expected-vs-received, and record DIED or SURVIVED with\ncounts. Fail-first is owed by the attempt that does the work and its failing output must be QUOTED;\nNEVER manufacture a red by mutating shipped state (no throwaway databases, no relocating source\nfiles, no weakening a guard). If a legitimate red is impossible, say so plainly.'
      : '. AGENT-RULES §3\'s ROUTINE branch: tests are required and must pass. **MUTANTS ARE NOT\nREQUIRED.** Fail-first is not owed — SAY SO rather than manufacturing one. If you NOTICE an\nassertion that cannot discriminate, say so: that is a finding, and it is worth more than a mutant\nyou were not asked to build.')
    + '\n\n' + t.brief + '\n\n' + frozenBlock(t) + '\n\n' + HALT + '\n\n' + finishBlock(t)
  p += '\n\nACCEPTANCE CRITERIA YOUR WORK MUST MEET — each is checked independently by a reviewer:\n'
    + t.criteria.map(function (c) { return '- ' + c }).join('\n')
  p += '\n\nIf any part of the brief is ambiguous, choose the most reasonable interpretation, complete the'
    + ' task, and list every such choice in the interpretations field of your report. Never expand'
    + ' scope beyond the brief.'
  p += '\n\nIf a tool call is denied by the permission system, do not attempt the same change through'
    + ' another tool or shell command; stop and record the denial verbatim in the outcome field.'
  if (history && history.length) {
    p += '\n\nA reviewer FAILED ' + history.length + ' previous attempt(s) at this task. Full failure history, oldest first:'
    history.forEach(function (v, idx) {
      p += '\nAttempt ' + (idx + 1) + ' violations: ' + v.violations.map(function (x) { return x.type + ' - ' + x.detail }).join('; ')
      p += '\nAttempt ' + (idx + 1) + ' corrections: ' + v.corrections.join('; ')
    })
    if ((history[history.length - 1] || {}).retry_mode === 'verify-only') {
      p += '\nThe reviewer judged the implementation itself CORRECT AND COMPLETE. Do not rewrite,'
        + ' re-generate or re-commit the code. This attempt is VERIFICATION ONLY: re-run the required'
        + ' commands, capture their real output, and satisfy every correction with evidence. Do NOT'
        + ' manufacture a fail-first run by mutating shipped state.'
        + '\nIMPORTANT: if the previous attempt already COMMITTED AND PUSHED, do not amend or re-commit'
        + ' it (rule 15). Report the existing SHA. AGENT-RULES §2.4\'s fallback applies: you may skip a'
        + ' red run by NAMING THE COMMIT SHA that already contains the artifact.'
    } else {
      p += '\nThe files are currently in the state the most recent attempt left them. Apply every'
        + ' correction. If the previous attempt already pushed a commit, corrections land as a NEW'
        + ' follow-up commit — never an amend or a force-push (rule 15).'
        + '\n\nAND THE STATE THAT IS NOT IN THE FILES: **A MIGRATION A PREVIOUS ATTEMPT APPLIED IS STILL'
        + ' APPLIED.** AGENT-RULES §6 — running the generator and letting a suite migrate MUTATES ALL'
        + ' PER-WORKER DATABASES, and `git checkout` does not undo it. Before you regenerate anything,'
        + ' MEASURE what is already applied (the `drizzle.__drizzle_migrations` rows and the actual'
        + ' table shape) and say so. Do NOT generate a second migration to "fix" the first, do NOT'
        + ' delete the applied file, and do NOT hand-edit `drizzle/meta/_journal.json` or a'
        + ' `__drizzle_migrations` row. If the correction cannot be made without undoing an applied'
        + ' irreversible migration, that is a STOP-AND-REPORT, not a retry: name which databases carry'
        + ' it and halt.'
    }
  }
  return p
}

function gatePrompt(t, report) {
  return RULES_POINTER + '\n\n' + PLAN_POINTER + '\n\n' + CONTEXT_BAN + '\n\n' + RELAY_BLOCK
    + '\n\n' + GROUND_TRUTH + '\n\n' + EVIDENCE + '\n\n' + PERSONA_GATE
    + '\n\nTHE TASK BRIEF YOU ARE GATING:\n\n' + t.brief
    + '\n\n' + frozenBlock(t)
    + '\n\nACCEPTANCE CRITERIA — check every one explicitly:\n'
    + t.criteria.map(function (c) { return '- ' + c }).join('\n')
    + '\n\nTHE IMPLEMENTER\'S REPORT (JSON):\n' + JSON.stringify(report)
    + '\n\nDo not re-litigate the plan\'s design decisions or its rulings — they are owner-approved or'
    + ' session-ruled law. Judge execution. If you believe the PLAN itself is defective, that is a'
    + ' finding for the relay and your findings array, not a task failure, unless the defect means a'
    + ' criterion is genuinely unmet.'
    + '\n\nYOUR OWN scratch lives under `/opt/hmis` — NEVER `/tmp` — and you delete it with plain'
    + ' `rm -f` before you return. Do not commit anything: gating is read-and-run, not write.'
}

function mechanicalPrompt(t, report) {
  return RULES_POINTER + '\n\n' + RELAY_BLOCK + '\n\n' + GROUND_TRUTH + '\n\n' + EVIDENCE
    + '\n\nYou are the MECHANICAL CHECK on one completed ROUTINE task. You are not a design reviewer:'
    + ' you verify that what was CLAIMED actually HAPPENED. Do not re-litigate the approach.'
    + '\n\n§2.50 is why you exist: under the Workflow tool a task nothing judges CANNOT FAIL, so the'
    + ' wave-stall break is dead for it. You are this task\'s verdict.'
    + '\n\n§2.32 is why this prompt repeats the rules instead of assuming them: the mechanical-check'
    + ' prompt inherits NONE of what the coder and gate prompts carry, and the pre-flight cannot'
    + ' catch that.'
    + '\n\nTASK BRIEF:\n\n' + t.brief
    + '\n\nACCEPTANCE CRITERIA:\n' + t.criteria.map(function (c) { return '- ' + c }).join('\n')
    + '\n\nIMPLEMENTER REPORT (JSON):\n' + JSON.stringify(report)
    + '\n\nTHE CHECKLIST — run each one YOURSELF and quote what you observed:\n'
    + '1. `pnpm verify`, DETACHED, with the exit VALUE read from a file.\n'
    + '2. `git show --stat` of the ACTUAL commit against the task\'s Files list — never against the\n'
    + '   implementer\'s summary of it. Every path in the diff must be named by the Files list, and a\n'
    + '   whole-file rewrite where one key was added is a finding (F5).\n'
    + '3. A frozen-path grep over that same diff. Any hit is a violation.\n'
    + '4. CI by FULL SHA: `bash docs/superpowers/pipelines/ci-watch-host.sh <FULL-SHA>`, exit value\n'
    + '   0 green / 1 red / 2 unresolved. You CAN run this — it needs no credential.\n'
    + '5. The tree is clean: `git status --porcelain` empty except the relay file, no mutant or\n'
    + '   scratch residue.\n'
    + '6. Workspace test totals did not decrease and the diff deletes no test. Quote the summary lines.\n'
    + '7. `pnpm-lock.yaml` does not appear in the diff.\n'
    + '8. Nothing from `/opt/hmis-context/` appears anywhere in the diff — no partner code, plan code,\n'
    + '   rate or sample person. Grep the diff for the SHAPES (a bare `%`-rate constant, a card-number\n'
    + '   -looking literal) rather than for values you do not have.\n'
    + '9. The ROUTINE-tier claims: fail-first declared not owed, and any non-discriminating assertion\n'
    + '   reported as a finding rather than silently accepted.\n'
    + '\nYour OWN scratch lives under `/opt/hmis` — NEVER `/tmp` — and you delete it with plain `rm -f`\n'
    + 'before you return.'
}

// ============================== THE LADDER AND THE WAVES ==============================

const results = {}
const failed = new Set()

async function runTask(t) {
  const unmet = t.deps.filter(function (d) {
    // A dependency satisfied by an EARLIER PIPELINE (this invocation runs a subset) is satisfied.
    if (!RUN.includes(d)) return false
    return (results[d] || {}).status !== 'done'
  })
  if (unmet.length) {
    results[t.id] = { status: 'skipped', reason: 'dependency not done: ' + unmet.join(',') }
    failed.add(t.id)
    return
  }
  const history = []
  // A rung advances ONLY on a real gate rejection. Infrastructure failures retry the SAME rung and
  // never promote the tier: an API 529 is not a code defect and must not cost an escalation (§2.1).
  const LADDER = [
    { model: t.model, label: t.model + ':' + t.id },
    { model: t.model, label: 'retry:' + t.id },
    { model: 'opus', label: 'escalate:' + t.id },
  ]
  const MAX_INFRA = 3
  let infra = 0
  for (let rung = 0; rung < LADDER.length; ) {
    const a = LADDER[rung]
    const report = await agent(coderPrompt(t, history), {
      agentType: 'general-purpose', model: a.model,
      label: a.label + (infra ? '~' + infra : ''), phase: 'Wave ' + t.wave, schema: REPORT_SCHEMA,
    })
    if (!report) {
      if (++infra > MAX_INFRA) {
        results[t.id] = { status: 'failed', reason: 'infrastructure: coder unavailable', attempts: rung + 1, history }
        failed.add(t.id)
        return
      }
      log(t.id + ': coder infra failure ' + infra + ' — same rung, tier unchanged')
      continue
    }

    if (!t.gate) {
      let chk = null
      for (let g = 0; g <= MAX_INFRA; g++) {
        chk = await agent(mechanicalPrompt(t, report), {
          agentType: 'general-purpose', model: 'sonnet',
          label: 'check:' + t.id + (g ? '~' + g : ''), phase: 'Wave ' + t.wave, schema: VERDICT_SCHEMA,
        })
        if (chk) break
        infra++
        log(t.id + ': mechanical-check infra failure ' + infra + ' — re-judging the same work')
      }
      if (!chk) {
        results[t.id] = { status: 'failed', reason: 'infrastructure: mechanical check unavailable', attempts: rung + 1, history }
        failed.add(t.id)
        return
      }
      if (chk.verdict === 'pass') {
        results[t.id] = { status: 'done', attempts: rung + 1, files: report.files_changed, sha: report.commit_sha, tests: chk.tests, mutants: report.mutants, interpretations: report.interpretations, findings: (chk.findings || []).concat(report.findings || []), evidence: report.evidence }
        return
      }
      history.push(chk)
      log(t.id + ': rung ' + (rung + 1) + ' rejected by mechanical check — ' + chk.violations.map(function (v) { return v.type }).join(','))
      rung++
      continue
    }

    // A dead gate re-judges the SAME report. It must never trigger a fresh coder attempt.
    let verdict = null
    for (let g = 0; g <= MAX_INFRA; g++) {
      verdict = await agent(gatePrompt(t, report), {
        agentType: 'general-purpose', model: 'opus',
        label: 'gate:' + t.id + '#' + (rung + 1) + (g ? '~' + g : ''), phase: 'Wave ' + t.wave, schema: VERDICT_SCHEMA,
      })
      if (verdict) break
      infra++
      log(t.id + ': gate infra failure ' + infra + ' — re-judging the same work, no new coder attempt')
    }
    if (!verdict) {
      results[t.id] = { status: 'failed', reason: 'infrastructure: gate unavailable', attempts: rung + 1, history }
      failed.add(t.id)
      return
    }
    if (verdict.verdict === 'pass') {
      results[t.id] = { status: 'done', attempts: rung + 1, files: report.files_changed, sha: report.commit_sha, tests: verdict.tests, mutants: report.mutants, interpretations: report.interpretations, findings: (verdict.findings || []).concat(report.findings || []), evidence: report.evidence }
      return
    }
    history.push(verdict)
    log(t.id + ': rung ' + (rung + 1) + ' rejected — ' + verdict.violations.map(function (v) { return v.type }).join(',') + (verdict.retry_mode === 'verify-only' ? ' (verify-only retry)' : ''))
    rung++
  }
  results[t.id] = { status: 'failed', attempts: LADDER.length, history }
  failed.add(t.id)
}

const ACTIVE = TASKS.filter(function (t) { return RUN.includes(t.id) })
const waves = [...new Set(ACTIVE.map(function (t) { return t.wave }))].sort(function (a, b) { return a - b })
let stalled = false
for (const w of waves) {
  phase('Wave ' + w)
  const inWave = ACTIVE.filter(function (t) { return t.wave === w })
  for (const t of inWave) { await runTask(t) }
  if (inWave.some(function (t) { return (results[t.id] || {}).status !== 'done' })) {
    log('wave ' + w + ' did not complete — stopping the run rather than letting later waves discover it')
    stalled = true
    break
  }
}

// EXECUTE-METHOD v2 §4 + v3 §3.4: ONE reviewer, reading every commit of the PHASE together. The
// findings that have mattered most here were CROSS-TASK — a defect shipped dormant by one task and
// armed by another, a convention several tasks honour that no test protects — and a per-task gate
// structurally cannot see them. It runs only on a complete run: reading a half-shipped range for
// cross-task defects is reading a system that does not exist yet.
const DISCOVERY_PROMPT = RULES_POINTER + '\n\n' + PLAN_POINTER + '\n\n' + CONTEXT_BAN
  + '\n\n' + GROUND_TRUTH + '\n\n' + EVIDENCE
  + '\n\nYou are the ONE INDEPENDENT REVIEWER for Plan 09, and under EXECUTE-METHOD-V3 §3.4 your'
  + ' findings are the phase\'s gate report. Every task has shipped and passed its own gate. You are'
  + ' NOT re-gating them: you read ALL OF THE PHASE\'S COMMITS TOGETHER and look for what a per-task'
  + ' reviewer structurally could not see.\n\n'
  + 'Find the range with `git log --oneline` on `main` — the task commits carry `(09 T1)` … `(09 T8)`'
  + ' in their messages. Read the relay file too:\n\n  ' + RELAY
  + '\n\nWHAT TO HUNT — the classes that have actually produced CRITICAL and MAJOR findings in this\n'
  + 'project:\n'
  + '- A defect shipped DORMANT by one task and ARMED by a later one. Two commits can each be\n'
  + '  correct and their composition wrong (§2.86). **T4 ships a seam with no caller until T6 —\n'
  + '  that is the highest-risk pair in this phase.**\n'
  + '- A CONFIDENTIALITY GATE that is correct in one lane and bypassed in another. 11h\'s CRITICAL\n'
  + '  was exactly this: two halves individually correct, jointly blind (§2.89). This phase adds a\n'
  + '  new way to reach a patient — by instrument — so ask whether every lane that can name a\n'
  + '  patient goes through `visiblePatientIds()`.\n'
  + '- Two tasks that DISAGREE IN CODE about whether some state can exist.\n'
  + '- A convention several tasks honour that NO TEST PROTECTS — the shipped code is right and\n'
  + '  nothing pins that it stays right.\n'
  + '- An assertion that cannot discriminate: a census asserting a SET cannot see a mutation that\n'
  + '  preserves the set; a config test asserting a key PARSES asserts nothing about whether it\n'
  + '  takes EFFECT (§2.60). **The five flags are five chances at this.**\n'
  + '- A REASSURANCE routed forward (§2.67). Re-check every "benign" verdict in the relay by building\n'
  + '  a DIFFERENT mutant of the same class. Plan 10\'s headline MAJOR was found exactly this way.\n'
  + '- MONEY: the accrual base is the single most consequential arithmetic in the phase and its first\n'
  + '  version was REFUTED by the spike (plan §3 Q4). Re-derive DD12 from the shipped code and check\n'
  + '  it against the plan\'s own counter-example by hand.\n'
  + '- ANYTHING FROM `/opt/hmis-context/` THAT REACHED A TRACKED FILE. You must not read that\n'
  + '  directory; grep the diffs for the SHAPES instead — a bare rate constant in `apps/`, a\n'
  + '  card-number-looking literal, a partner code. Plan §5 DD3 says every catalog is data.\n\n'
  + 'RULE 21 BINDS YOU HARDEST OF ALL: you are the last reader, so an unexecuted claim from you\n'
  + 'reaches the gate report unchallenged. BUILD the mutant, do not predict it. Quote expected vs\n'
  + 'received. A mutant that dies at TYPECHECK or by TIMEOUT proves nothing.\n\n'
  + 'You COMMIT NOTHING and you FIX NOTHING. Findings go in your return value with their executed\n'
  + 'evidence, a severity, and — for anything you are NOT certain of — the words that say so. Clean\n'
  + 'up every scratch file you create with plain `rm -f`.'

let discovery = null
if (!stalled && RUN_DISCOVERY) {
  phase('Discovery')
  discovery = await agent(DISCOVERY_PROMPT, {
    agentType: 'general-purpose', model: 'opus', label: 'discovery:plan-09', phase: 'Discovery',
    schema: {
      type: 'object', additionalProperties: false, required: ['summary', 'findings'],
      properties: {
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['severity', 'title', 'evidence'],
            properties: {
              severity: { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR', 'NOTE'] },
              title: { type: 'string' },
              evidence: { type: 'string' },
              executed: { type: 'boolean' },
            },
          },
        },
      },
    },
  })
}

return {
  ran: RUN,
  tasks: results,
  stalled,
  discovery,
  halted: [...failed],
  summary: Object.values(results).filter(function (r) { return r.status === 'done' }).length + '/' + ACTIVE.length + ' done',
}
