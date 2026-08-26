import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { commissionAccruals, counterparties, partnerAgreements } from "../../kernel/db/schema";
import { issueAttribution } from "./attribution";
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
    try {
      await holder.query("begin");
      // FOR KEY SHARE, and the mode is the whole experiment — see this file's header.
      await holder.query("select id from receivable_expectations where id = $1 for key share", [slip.expectationId]);

      const p = importStatement(db, CLERK, {
        counterpartyId, statementRef: "INV-STMT-BLOCK", statementPeriod: "2026-M08",
        csv: csv(V1_HEADER, `${slip.code},,60000`),
      }, LATER);
      stateAt400 = await Promise.race([p.then(() => "settled", () => "settled"), delay(400).then(() => "pending")]);

      await holder.query("commit");
      await p; // and it must actually finish once the holder lets go
    } finally {
      holder.release();
    }

    expect({ after400ms: stateAt400 }).toEqual({ after400ms: "pending" });

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
  });
});
