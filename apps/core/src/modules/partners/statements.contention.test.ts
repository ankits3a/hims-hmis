import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { commissionAccruals, counterparties, partnerAgreements } from "../../kernel/db/schema";
import { issueAttribution } from "./attribution";
import { PartnersError } from "./errors";
import { importStatement } from "./statements";
import type { Db } from "../../kernel/db/client";
import type { Pool } from "pg";

/**
 * PLAN 09a T4 — DD4's SERIALIZER ON THE RECEIVABLE LANE, OBSERVED.
 *
 * ═══ WHAT PLAN 09 SHIPPED, AND WHAT IT COST ═══
 *
 * `importStatement` found the open claim with a bare `select … limit 1` and updated it with no
 * state predicate. Two statements quoting ONE slip therefore both read it `expected`, both matched
 * it, and both appended a full receivable accrual — Plan 09's own T7 gate measured **7 of 8 trials
 * double-counting**. This is the hazard `commission_accrual_subjects` closes on the PAYABLE side
 * and that the receivable side never had.
 *
 * ═══ WHY THIS FILE ASSERTS THE BLOCK, AND NOT ONLY THE OUTCOME ═══
 *
 * §3 Q6 and `entitlements.contention.test.ts` both recorded it: a forced interleave alone does not
 * discriminate, because the ordering serialises the work anyway. The outcome leg below is still
 * worth having — it is the property a human cares about — but the leg that REFUTES a lock-less
 * implementation is the one where an external session holds the row and a real writer must wait.
 *
 * ═══ WHICH LOCK, IN WHICH MODE, AND WHY IT IS NOT THE MODE THE LAST SUITE USED (§2.6) ═══
 *
 * The writer takes `select … for update` on the open `receivable_expectations` row. The holder
 * below takes **`FOR KEY SHARE`**, and that choice was MEASURED rather than reasoned, on a scratch
 * database, before this file was written:
 *
 *   held mode            | shipped (`SELECT … FOR UPDATE`) | lock-less (bare `UPDATE`)
 *   ---------------------|---------------------------------|---------------------------
 *   FOR KEY SHARE        | BLOCKED (3125 ms)               | proceeded (211 ms)   ← discriminates
 *   FOR NO KEY UPDATE    | BLOCKED (3117 ms)               | BLOCKED (3116 ms)    ← does NOT
 *
 * `entitlements.contention.test.ts` holds `FOR NO KEY UPDATE`, and holding it HERE would have
 * produced a mutant that "blocked" and looked killed while proving nothing — because the lock-less
 * implementation's own `UPDATE` takes `FOR NO KEY UPDATE` and conflicts with it. `FOR KEY SHARE`
 * is the weakest mode that still conflicts with the writer's `FOR UPDATE` while leaving a bare
 * `UPDATE` free to proceed. The same rule as the last suite, with the opposite answer, because the
 * statement the mutant reaches next is different.
 *
 * That measurement also settled something the docs do not state plainly: the `UPDATE` sets
 * `statement_ref`, a column of the PARTIAL unique index `receivable_expectations_statement_line_ux`,
 * and it still took only a no-key lock — so a partial unique index is excluded from Postgres's
 * key-attribute set.
 *
 * Rule 20 / §2.53: `pgrep -af jest` was read as LINES before every timing here.
 */
const FLAG = "RECEIVABLE_COMMISSION_ENABLED";
const CLERK: Actor = { type: "user", id: "t4-contention-clerk" };
const NOW = new Date("2026-08-19T06:00:00Z");
const LATER = new Date("2026-09-19T06:00:00Z");
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");
const V1_HEADER = "attribution_ref,partner_ref,amount_paise";

/** §2.3 — the reviewer's own trial count is a FLOOR, not a target. */
const TRIALS = 8;
/**
 * THE DEADLOCK LEG RUNS FEWER TRIALS THAN THE RACE LEGS, AND THE REASON IS A COST THIS SUITE IMPOSES
 * ON EVERY OTHER SUITE — added 2026-08-26 after `ff79eb9` went red in CI.
 *
 * That leg does not measure a PROBABILITY, it measures a MAPPING: whatever escapes must be typed.
 * Each trial deliberately deadlocks two transactions, and Postgres resolves a deadlock only after
 * `deadlock_timeout` (1 s here) — so eight trials is ~9 s of real lock contention against the shared
 * database, measured, in a suite jest runs in parallel with every other. At a 13-of-14 observed
 * deadlock rate, three trials still see one with probability ~99.96%, and the assertion is safe
 * either way because it never asserts that a deadlock HAPPENS.
 *
 * **Why it was cut rather than left alone.** `ff79eb9` went red on `scheduler.test.ts` — a suite
 * this phase does not touch — overrunning its own 120 s budget to 186 s and cascading into four hook
 * timeouts. The test surface was byte-identical across that red run and the FOUR green runs after
 * it, so the red is nondeterminism proven by execution rather than a defect here. But "not my
 * defect" and "not my contribution" are different claims: nine seconds of deliberate lock contention
 * is load this file added, and the cheapest honest response is to stop adding it.
 */
const DEADLOCK_TRIALS = 3;
/** How long the external session holds the row. The import must not settle before this elapses. */
const HOLD_MS = 400;
/**
 * MINOR B from the close review — the per-test budget for the race legs, the idiom `c3a2647`
 * established for exactly this. The deadlock leg measured **8,887 / 9,028 / 9,069 ms** on an IDLE
 * host against jest's global `testTimeout: 15000`, and the cost is structural: `deadlock_timeout`
 * is 1 s here and the leg runs 8 trials. On a contended CI runner that is a red `main` — and the
 * leg's own "cannot flake in either direction" note reasoned only about assertion outcomes and
 * missed the timeout dimension entirely. **The global budget is what fails, not the property.**
 */
const RACE_TIMEOUT_MS = 60_000;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const csv = (header: string, ...rows: string[]): string => [header, ...rows].join("\n");

describe("the receivable lane gets the serializer the payable lane already had (09a DD4)", () => {
  let db: Db;
  let pool: Pool;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, pool, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });
  beforeEach(async () => { process.env[FLAG] = "true"; await truncateAll(db); });

  async function partnerFor(): Promise<{ counterpartyId: string }> {
    const counterpartyId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name: "Invented Diagnostic Partner",
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: newId(), counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM, effectiveTo: null,
      status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null,
        receivableRateBps: 1_500, unclaimedExpiryDays: 45,
      },
    });
    return { counterpartyId };
  }

  it("an import BLOCKS while another session holds the open expectation, and settles on its COMMIT", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    const holder = await pool.connect();
    let stateAt400: string;
    let settledAfterMs = 0;
    let releasedAfterMs = 0;
    try {
      await holder.query("begin");
      // FOR KEY SHARE, and the mode is the whole experiment — see this file's header.
      await holder.query("select id from receivable_expectations where id = $1 for key share", [slip.expectationId]);

      const started = process.hrtime.bigint();
      const p = importStatement(db, CLERK, {
        counterpartyId, statementRef: "INV-STMT-BLOCK", statementPeriod: "2026-M08",
        csv: csv(V1_HEADER, `${slip.code},,60000`),
      }, LATER);
      stateAt400 = await Promise.race([p.then(() => "settled", () => "settled"), delay(HOLD_MS).then(() => "pending")]);

      await holder.query("commit");
      releasedAfterMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
      await p; // and it must actually finish once the holder lets go
      settledAfterMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
    } finally {
      holder.release();
    }

    // THE DISCRIMINATOR. A lock-less implementation settles in single-digit milliseconds.
    expect({ afterHold: stateAt400 }).toEqual({ afterHold: "pending" });

    /**
     * NOTE E from the close review — my first attempt at strengthening this asserted
     * `settledAfterMs >= HOLD_MS`, which is ENTAILED by the line above (the race already proved `p`
     * had not settled at `HOLD_MS`, and `settledAfterMs` is only read after `await p`). An assertion
     * that cannot fail independently of another is not a second check; it is a longer way of writing
     * the first one.
     *
     * The independent fact is on the OTHER side of the release: having waited, the import finished
     * PROMPTLY once the row was let go. Together with the line above that says *blocked, then
     * resumed by the commit* — which is what "waited on the lock" means, and what "merely slow on a
     * loaded box" would not produce. The bound is deliberately loose because this must not flake;
     * the observed resume is single-digit to low-tens of milliseconds.
     */
    expect({ resumedAfterReleaseWithinMs: settledAfterMs - releasedAfterMs < 5_000 })
      .toEqual({ resumedAfterReleaseWithinMs: true });

    // Having waited, it did the ordinary right thing: one confirmed claim, one ledger row.
    const ledger = await db.select().from(commissionAccruals).where(eq(commissionAccruals.counterpartyId, counterpartyId));
    expect({ rows: ledger.length, total: ledger.reduce((s, r) => s + r.amountPaise, 0) })
      .toEqual({ rows: 1, total: 60_000 });
  });

  it(`two statements quoting ONE slip cannot both accrue — ${String(TRIALS)} natural races`, async () => {
    const observed: { trial: number; rows: number; total: number }[] = [];

    for (let trial = 1; trial <= TRIALS; trial++) {
      const { counterpartyId } = await partnerFor();
      const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
      const line = csv(V1_HEADER, `${slip.code},,60000`);

      // Two DIFFERENT statement references — the `statement_already_imported` guard cannot see
      // this, and it runs outside the transaction anyway. Nothing but the row lock stands here.
      await Promise.allSettled([
        importStatement(db, CLERK, { counterpartyId, statementRef: `A-${String(trial)}`, statementPeriod: "2026-M08", csv: line }, LATER),
        importStatement(db, CLERK, { counterpartyId, statementRef: `B-${String(trial)}`, statementPeriod: "2026-M08", csv: line }, LATER),
      ]);

      const ledger = await db.select().from(commissionAccruals).where(eq(commissionAccruals.counterpartyId, counterpartyId));
      observed.push({ trial, rows: ledger.length, total: ledger.reduce((s, r) => s + r.amountPaise, 0) });
    }

    // The loser finds nothing open and takes the V3 correction path, whose delta is
    // `60 000 − 60 000 = 0` — and a zero adjustment appends no row at all. So the partner is owed
    // 60 000 once, however the two imports interleave.
    const wrong = observed.filter((o) => o.total !== 60_000);
    expect({ trials: TRIALS, doubleCounted: wrong.length, wrong }).toEqual({ trials: TRIALS, doubleCounted: 0, wrong: [] });
  }, RACE_TIMEOUT_MS);

  /**
   * THE LEG THE FIRST VERSION OF THIS FILE COULD NOT SEE, AND §2.102 IS EXACTLY WHY.
   *
   * The race above carries `60000` in BOTH statements — so the one field that decides the outcome
   * is EQUAL in every leg, and a suite in which the deciding field never differs cannot discriminate
   * what happens when it does. The close reviewer found this and measured the answer.
   *
   * **The lock makes the money SINGLE, not DETERMINISTIC.** With two different amounts the winner's
   * figure stands and the loser's is absorbed as a V3 correction, so the confirmed total is whichever
   * import took the lock first. This test therefore asserts the property that IS true — one slip is
   * never counted twice, and the surviving total is always one of the two quoted figures and never
   * their sum — and records in its own name that the choice between them is order-dependent.
   *
   * That order-dependence is NOT fixed here. Absorbing a differing later statement is Plan 09's
   * ruled V3 behaviour, pinned deliberately by `G4/V3` (an upward correction to 75 000 over a 60 000
   * expectation); what concurrency adds is that "later" is decided by a lock. Overturning V3 is the
   * owner's ruling to make. **The CLOSE names it as an open item gating
   * `RECEIVABLE_COMMISSION_ENABLED`, and this test is what will go red when it is settled.**
   */
  it("two statements quoting DIFFERENT amounts for one slip: never both, but which one is order-dependent", async () => {
    const seen = new Set<number>();

    for (let trial = 1; trial <= TRIALS; trial++) {
      const { counterpartyId } = await partnerFor();
      const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

      await Promise.allSettled([
        importStatement(db, CLERK, { counterpartyId, statementRef: `H-${String(trial)}`, statementPeriod: "2026-M08", csv: csv(V1_HEADER, `${slip.code},,60000`) }, LATER),
        importStatement(db, CLERK, { counterpartyId, statementRef: `I-${String(trial)}`, statementPeriod: "2026-M08", csv: csv(V1_HEADER, `${slip.code},,90000`) }, LATER),
      ]);

      const ledger = await db.select().from(commissionAccruals).where(eq(commissionAccruals.counterpartyId, counterpartyId));
      seen.add(ledger.reduce((s, r) => s + r.amountPaise, 0));
    }

    /**
     * MINOR A from the close review — an earlier version of this comment claimed 150 000 "is the
     * assertion that would fail against a lock-less implementation". **That was a hand-walked
     * prediction stated as a property, and it is false: the mutant was built and this leg SURVIVED**,
     * with byte-identical output. 150 000 is unreachable either way, because with DIFFERING amounts
     * the loser meets the still-`expected` 60 000 claim and takes the `amount_mismatch` DISPUTE
     * branch, which records no money at all.
     *
     * The leg still earns its place — it is what closes §2.102 by making the deciding field differ,
     * and it is what will go red when the owner rules on MAJOR 2. **What kills the lock is the
     * equal-amounts leg above**, and saying so here is the difference between a suite a reader can
     * trust and one that quietly over-claims its own coverage (rule 21).
     */
    const totals = [...seen].sort((x, y) => x - y);
    expect({ everDoubleCounted: totals.includes(150_000) }).toEqual({ everDoubleCounted: false });
    // Every observed total is one of the two figures a partner actually quoted.
    expect({ outsideTheQuotedFigures: totals.filter((t) => t !== 60_000 && t !== 90_000) })
      .toEqual({ outsideTheQuotedFigures: [] });
  }, RACE_TIMEOUT_MS);

  /**
   * MINOR 4 FROM THE CLOSE REVIEW — T4's row lock introduced an ABBA DEADLOCK, and the point of
   * this test is that a human gets a SENTENCE rather than a driver code.
   *
   * Two imports listing the same slips in OPPOSITE order take this lane's locks in opposite order.
   * Measured at **13 of 14 pairs** when this was written at eight trials (it now runs
   * `DEADLOCK_TRIALS` — see there), and by the reviewer at 3/3 under a forced interleave
   * against a lock-less mutant that was 3/3 clean — so it is T4's and not pre-existing. The money is
   * never wrong: the transaction rolls back whole. What was wrong is that `40P01` reached the
   * operator raw.
   *
   * **This assertion cannot flake in either direction**, which is why it is safe on `main`: if no
   * pair deadlocks it passes trivially, and if any pair does the escaping error must be typed. It
   * never asserts that a deadlock HAPPENS.
   *
   * The better repair — resolve every row, then sort by attribution id so both imports take locks in
   * one order — is named as a follow-up in the CLOSE and deliberately not taken here: it moves
   * resolution out of the loop and reorders `lines` in a money path's result.
   */
  it("opposite-order imports may deadlock, and a deadlock is a typed retryable refusal, never a raw 40P01", async () => {
    const escaped: string[] = [];

    for (let trial = 1; trial <= DEADLOCK_TRIALS; trial++) {
      const { counterpartyId } = await partnerFor();
      const s1 = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
      const s2 = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
      const forward = csv(V1_HEADER, `${s1.code},,60000`, `${s2.code},,60000`);
      const reverse = csv(V1_HEADER, `${s2.code},,60000`, `${s1.code},,60000`);

      const settled = await Promise.allSettled([
        importStatement(db, CLERK, { counterpartyId, statementRef: `F-${String(trial)}`, statementPeriod: "2026-M08", csv: forward }, LATER),
        importStatement(db, CLERK, { counterpartyId, statementRef: `R-${String(trial)}`, statementPeriod: "2026-M08", csv: reverse }, LATER),
      ]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          const e: unknown = outcome.reason;
          escaped.push(e instanceof PartnersError ? `typed:${e.code}` : `RAW:${String((e as { code?: unknown }).code)}`);
        }
      }
    }

    // Nothing untyped may reach a caller. A raw `40P01` or `23505` here IS the defect.
    expect({ rawDriverErrors: escaped.filter((x) => x.startsWith("RAW:")) })
      .toEqual({ rawDriverErrors: [] });
    // And whatever did escape is retryable, or the already-imported refusal — never anything else.
    const unexpected = escaped.filter((x) => x !== "typed:statement_import_conflict" && x !== "typed:statement_already_imported");
    expect({ unexpectedCodes: unexpected }).toEqual({ unexpectedCodes: [] });
  }, RACE_TIMEOUT_MS);

  /**
   * NOTE F from the close review — MINOR 3's fix WORKS and nothing required it to.
   *
   * The `23505` → `statement_already_imported` branch was measured green (8/8) but no test drove
   * it: `statements.test.ts` covers only the SEQUENTIAL pre-check, and the deadlock leg above uses
   * different statement references so it never reaches this constraint. **A branch with no test is
   * a branch the next refactor deletes with a green suite** — which is the whole reason this file
   * exists, one layer up.
   *
   * The legible pre-check runs on `db` OUTSIDE the transaction and therefore cannot see an
   * in-flight twin; the partial unique index is what actually catches this, and before the mapping
   * it surfaced as a raw `23505` falling through `toHttp` to a 500.
   */
  it("two imports of the SAME statementRef race to the index, and the loser gets a sentence not a 23505", async () => {
    const escaped: string[] = [];

    for (let trial = 1; trial <= TRIALS; trial++) {
      const { counterpartyId } = await partnerFor();
      const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
      const line = csv(V1_HEADER, `${slip.code},,60000`);
      const sameRef = `SAME-${String(trial)}`;

      const settled = await Promise.allSettled([
        importStatement(db, CLERK, { counterpartyId, statementRef: sameRef, statementPeriod: "2026-M08", csv: line }, LATER),
        importStatement(db, CLERK, { counterpartyId, statementRef: sameRef, statementPeriod: "2026-M08", csv: line }, LATER),
      ]);
      for (const outcome of settled) {
        if (outcome.status === "rejected") {
          const e: unknown = outcome.reason;
          escaped.push(e instanceof PartnersError ? `typed:${e.code}` : `RAW:${String((e as { code?: unknown }).code)}`);
        }
      }

      // And the money is single regardless of which one lost.
      const ledger = await db.select().from(commissionAccruals).where(eq(commissionAccruals.counterpartyId, counterpartyId));
      expect({ trial, total: ledger.reduce((n, r) => n + r.amountPaise, 0) }).toEqual({ trial, total: 60_000 });
    }

    expect({ rawDriverErrors: escaped.filter((x) => x.startsWith("RAW:")) })
      .toEqual({ rawDriverErrors: [] });
    // Exactly one of each pair may lose, and it loses with the same sentence the sequential
    // pre-check gives — that is the point of mapping it rather than inventing a new code.
    expect({ unexpected: escaped.filter((x) => x !== "typed:statement_already_imported") })
      .toEqual({ unexpected: [] });
  }, RACE_TIMEOUT_MS);
});
