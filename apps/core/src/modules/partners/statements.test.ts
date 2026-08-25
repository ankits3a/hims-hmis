import { asc, eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  commissionAccruals, counterparties, events, importQuarantine, partnerAgreements,
  receivableExpectations,
} from "../../kernel/db/schema";
import { issueAttribution } from "./attribution";
import { mapPartnerRef } from "./reconcile";
import {
  STATEMENT_MAP_VERSIONS, importStatement, listStatementQuarantine, parseStatement,
  resolveStatementColumnMap,
} from "./statements";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T7 — THE PARTNER STATEMENT (DD13). Assertion Book rows **G1**, **G2** and **G4** live
 * here, with V1, V3 and V6.
 *
 * ═══ THE THREE RULES THIS FILE EXISTS TO HOLD ═══
 *
 *  · **G1 / V1** — a line whose attribution this hospital never issued DISPUTES. It never accrues,
 *    because a partner cannot create a receivable by asserting one, and it is never silently
 *    dropped either: the dispute is a row, an event and a verbatim quarantine line.
 *  · **G2 / V6** — a statement from partner B quoting partner A's slip DISPUTES. DD13 makes this a
 *    RULE and not a conflict to resolve: the partner whose id is on the slip is the partner with
 *    the claim.
 *  · **G4 / V3** — a statement amending a period already settled APPENDS an adjustment row naming
 *    that period. It edits neither the prior expectation nor the prior ledger entry, and
 *    `commission_accruals` is append-only by trigger, so an implementation that tried would be
 *    REFUSED by the database rather than merely wrong.
 *
 * Every partner, reference, statement and amount below is INVENTED HERE (DD3 / owner ruling O-9).
 * The rates are chosen so the arithmetic is checkable by hand:
 * `percentAmount(400 000, 1 500) = divHalfUp(400 000 · 1 500, 10 000) = 60 000`.
 */
const FLAG = "RECEIVABLE_COMMISSION_ENABLED";

const CLERK: Actor = { type: "user", id: "t7-statement-clerk" };
const NOW = new Date("2026-08-19T06:00:00Z"); // 11:30 IST — inside 2026-M08 / 2026-Q3
const LATER = new Date("2026-09-19T06:00:00Z");
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");

const V1_HEADER = "attribution_ref,partner_ref,amount_paise";
const V2_HEADER = "our ref,their ref,amount paise,period";

describe("the partner statement: matched, disputed, corrected (DD13, V1/V3/V6)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { delete process.env[FLAG]; await teardown(); });

  beforeEach(async () => {
    process.env[FLAG] = "true";
    await truncateAll(db);
  });

  async function partnerFor(name = "Invented Diagnostic Partner"): Promise<{ counterpartyId: string; agreementId: string }> {
    const counterpartyId = newId();
    const agreementId = newId();
    await db.insert(counterparties).values({
      id: counterpartyId, code: `INV-CP-${counterpartyId.slice(-6)}`, name,
      payeeClass: "channel_partner", status: "active", createdBy: "test",
    });
    await db.insert(partnerAgreements).values({
      id: agreementId, counterpartyId, versionNo: 1, effectiveFrom: AGREEMENT_FROM,
      effectiveTo: null, status: "active", createdBy: "test",
      terms: {
        payableRateBps: 1_000, eligibleCategories: ["diagnostics"], kicker: null,
        receivableRateBps: 1_500, unclaimedExpiryDays: 45,
      },
    });
    return { counterpartyId, agreementId };
  }

  const csv = (header: string, ...rows: string[]): string => [header, ...rows].join("\n");

  // ── THE COLUMN MAPS — read by NAME, never by position ─────────────────────────────────────

  it("a transposed drop imports correctly, because the map's identity is its header SET", () => {
    const straight = parseStatement(csv(V1_HEADER, "RF-1,,60000"));
    const transposed = parseStatement(csv("amount_paise,partner_ref,attribution_ref", "60000,,RF-1"));
    expect(straight.map.version).toBe("partner-statement-v1");
    expect(transposed.map.version).toBe("partner-statement-v1");
    expect(transposed.rows[0]).toMatchObject({ attributionRef: "RF-1", amountPaise: 60_000 });
  });

  it("an unrecognised header set refuses the WHOLE file rather than reading a prefix by position", () => {
    expect(() => parseStatement(csv("ref,amount", "RF-1,60000"))).toThrow(/matches no known map/);
    try {
      parseStatement(csv("ref,amount", "RF-1,60000"));
    } catch (e) {
      expect(e).toMatchObject({ code: "statement_columns_unknown" });
    }
  });

  it("a repeated heading is an UNKNOWN shape, not a near miss", () => {
    expect(() => resolveStatementColumnMap(["attribution_ref", "attribution_ref", "amount_paise"]))
      .toThrow(/repeats a column name/);
  });

  it("naming a version does not license reading a file that version does not describe", () => {
    expect(() => parseStatement(csv(V1_HEADER, "RF-1,,1"), "partner-statement-v2")).toThrow(/matches no known map/);
    expect(() => parseStatement(csv(V1_HEADER, "RF-1,,1"), "no-such-map")).toThrow(/no statement column map/);
    expect(STATEMENT_MAP_VERSIONS).toEqual(["partner-statement-v1", "partner-statement-v2"]);
  });

  /**
   * The holder-book parser flags `cells.length < headerCells.length` and never the other direction,
   * and the gate that measured it found the narrow path where that loses data silently. A
   * statement's cells END in an AMOUNT, so the same stray comma would move money — hence a long-row
   * leg here, and both directions asserted.
   */
  it("both a SHORT and a LONG row are refused — an unquoted comma cannot silently move money", () => {
    const parsedRows = parseStatement(csv(V1_HEADER, "RF-1,,60000,oops", "RF-2,")).rows;
    expect(parsedRows.map((r) => r.reasons)).toEqual([["long_row"], ["short_row", "bad_amount"]]);
  });

  it("an amount in RUPEES is `bad_amount`, never silently multiplied by a hundred", () => {
    expect(parseStatement(csv(V1_HEADER, "RF-1,,600.00")).rows[0]!.reasons).toEqual(["bad_amount"]);
    expect(parseStatement(csv(V1_HEADER, "RF-1,,-600")).rows[0]!.reasons).toEqual(["bad_amount"]);
    expect(parseStatement(csv(V1_HEADER, "RF-1,,")).rows[0]!.reasons).toEqual(["bad_amount"]);
  });

  it("a line naming NEITHER reference is refused: no join, fuzzy or otherwise, could resolve it", () => {
    expect(parseStatement(csv(V1_HEADER, ",,60000")).rows[0]!.reasons).toEqual(["missing_required"]);
  });

  // ── THE MATCHED LANE ──────────────────────────────────────────────────────────────────────

  it("a line quoting our own code MATCHES the open claim and records the money in the ledger", async () => {
    const { counterpartyId, agreementId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-001", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, LATER);

    expect(result).toMatchObject({
      columnMapVersion: "partner-statement-v1",
      linesTotal: 1, linesMatched: 1, linesDisputed: 0, linesCorrected: 0, linesQuarantined: 0,
      confirmedPaise: 60_000,
    });

    // THE CLAIM moved in place — `receivable_expectations` is the one updatable table (DD5).
    const claims = await db.select().from(receivableExpectations);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      id: slip.expectationId, state: "matched", statementRef: "INV-STMT-001",
      statementPeriod: "2026-M08", statementLineNo: 2, amountPaise: 60_000, disputeReason: null,
    });
    expect(claims[0]!.matchedAt).toEqual(LATER);

    // THE MONEY is an append-only ledger row carrying its own rate snapshot (DD6).
    const ledger = await db.select().from(commissionAccruals);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      counterpartyId, agreementId, direction: "receivable", kind: "accrual", state: "accrued",
      amountPaise: 60_000, periodKey: "2026-M08", subjectId: null, basisEventId: null, invoiceId: null,
    });
    expect(ledger[0]!.rateSnapshot).toMatchObject({
      agreementId, versionNo: 1, receivableRateBps: 1_500,
      pinnedTo: "attribution.issued_at", pinnedAt: NOW.toISOString(),
      attributionId: slip.attributionId, expectationId: slip.expectationId,
      statementRef: "INV-STMT-001", statementLineNo: 2,
    });
    // DD15 — no identity anywhere on the ledger row.
    expect(JSON.stringify(ledger[0]!.rateSnapshot)).not.toContain("patient");
  });

  it("a line quoting the PARTNER's own reference matches through the mapping table and nothing else", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: slip.attributionId }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-002", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, ",LAB/2026/000871,60000"),
    }, LATER);

    expect(result.linesMatched).toBe(1);
    expect((await db.select().from(receivableExpectations))[0]!.state).toBe("matched");
  });

  // ── G1 / V1 — A CLAIM AGAINST A SLIP WE NEVER ISSUED ──────────────────────────────────────

  /**
   * ═══ BOOK ROW G1 — AN UNMATCHED LINE DISPUTES RATHER THAN ACCRUES ═══
   *
   * The mutant accrues on any statement line; the input is a line whose attribution id does not
   * exist. The assertion that kills it is the LEDGER's emptiness, not the row's state — an
   * implementation that disputed the row AND accrued would pass a state-only test while paying a
   * partner for a referral nobody made.
   */
  it("G1 / V1 — a line quoting an id we never issued is DISPUTED and accrues NOTHING", async () => {
    const { counterpartyId } = await partnerFor();

    const result = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-003", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, "RF-NEVERISSUED,,60000"),
    }, LATER);

    expect(result).toMatchObject({ linesTotal: 1, linesMatched: 0, linesDisputed: 1, confirmedPaise: 0 });
    const claims = await db.select().from(receivableExpectations);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      counterpartyId, attributionId: null, agreementId: null, state: "disputed",
      disputeReason: "unknown_attribution", amountPaise: 60_000,
      statementRef: "INV-STMT-003", statementLineNo: 2,
    });

    // THE ASSERTION THAT IS THE RULE: no money moved.
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);

    // And the line survives verbatim, because there is no statement-line table to hold it.
    expect(await listStatementQuarantine(db, "INV-STMT-003")).toEqual([
      { id: expect.any(String), rowNo: 2, reason: "unknown_attribution", line: "RF-NEVERISSUED,,60000" },
    ]);
    const spine = await db.select().from(events).orderBy(asc(events.seq));
    expect(spine.map((e) => e.name)).toEqual(["expectation.disputed", "statement.imported"]);
  });

  // ── G2 / V6 — ONE PARTNER QUOTING ANOTHER'S SLIP ──────────────────────────────────────────

  /**
   * ═══ BOOK ROW G2 — THE ATTRIBUTION'S PARTNER IS THE ONE ON THE SLIP ═══
   *
   * The mutant matches on the STATEMENT's partner instead of the slip's; the input is a statement
   * from one partner quoting another's id. Under the mutant, partner B settles partner A's
   * referral — and A's own claim ages out unpaid while B is credited for work it never referred.
   */
  it("G2 / V6 — partner B quoting partner A's slip is DISPUTED, and A's claim is untouched", async () => {
    const a = await partnerFor("Invented Partner A");
    const b = await partnerFor("Invented Partner B");
    const slipA = await issueAttribution(db, CLERK, { counterpartyId: a.counterpartyId, referredValuePaise: 400_000 }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId: b.counterpartyId, statementRef: "INV-STMT-B-004", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slipA.code},,60000`),
    }, LATER);

    expect(result).toMatchObject({ linesMatched: 0, linesDisputed: 1, confirmedPaise: 0 });

    // B's row records WHOSE slip it quoted — that id IS the evidence of the dispute.
    const disputed = await db
      .select().from(receivableExpectations)
      .where(eq(receivableExpectations.counterpartyId, b.counterpartyId));
    expect(disputed).toHaveLength(1);
    expect(disputed[0]).toMatchObject({
      attributionId: slipA.attributionId, state: "disputed",
      disputeReason: "attribution_partner_mismatch", amountPaise: 60_000,
    });

    // A's claim is exactly as it was: still `expected`, still ageing (V2), still A's.
    const owned = await db
      .select().from(receivableExpectations)
      .where(eq(receivableExpectations.id, slipA.expectationId));
    expect(owned[0]).toMatchObject({ state: "expected", statementRef: null, counterpartyId: a.counterpartyId });

    // And NOBODY was paid.
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
  });

  it("V6 — a partner reference mapped by ANOTHER partner cannot reach this statement at all", async () => {
    const a = await partnerFor("Invented Partner A");
    const b = await partnerFor("Invented Partner B");
    const slipA = await issueAttribution(db, CLERK, { counterpartyId: a.counterpartyId, referredValuePaise: 400_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId: a.counterpartyId, partnerRef: "SHARED-1", attributionId: slipA.attributionId }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId: b.counterpartyId, statementRef: "INV-STMT-B-005", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, ",SHARED-1,60000"),
    }, LATER);
    expect(result.lines[0]).toMatchObject({ outcome: "disputed", reason: "unknown_attribution" });
  });

  // ── THE AMOUNT THE PARTNER DISAGREES WITH ─────────────────────────────────────────────────

  it("a line whose amount differs from ours is DISPUTED, keeps OUR number, and confirms no money", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-006", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,45000`),
    }, LATER);

    expect(result).toMatchObject({ linesDisputed: 1, confirmedPaise: 0 });
    const claims = await db.select().from(receivableExpectations);
    expect(claims[0]).toMatchObject({
      id: slip.expectationId, state: "disputed", disputeReason: "amount_mismatch",
      amountPaise: 60_000, statementRef: "INV-STMT-006",
    });
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
    // The partner's own figure survives verbatim in quarantine — there is no statement-line table.
    expect((await listStatementQuarantine(db, "INV-STMT-006"))[0]).toMatchObject({
      reason: "amount_mismatch", line: `${slip.code},,45000`,
    });
  });

  // ── G4 / V3 — THE LATE CORRECTION ─────────────────────────────────────────────────────────

  /**
   * ═══ BOOK ROW G4 — A LATE CORRECTION APPENDS ═══
   *
   * August's statement settles a referral at 60 000. September's statement amends August: the
   * partner now says 75 000. The correct answer is an ADJUSTMENT ROW of +15 000 naming `2026-M08`,
   * with August's own expectation row and August's own ledger row byte-identical afterwards.
   *
   * The mutant updates the prior row instead. `commission_accruals` is append-only BY TRIGGER
   * (DD5), so it does not merely produce a wrong number — the database REFUSES it, and the kill is
   * `partner_ledger_immutable`.
   */
  it("G4 / V3 — a statement amending a settled period APPENDS an adjustment and edits nothing", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-AUG", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, LATER);
    const augustClaim = (await db.select().from(receivableExpectations).where(eq(receivableExpectations.id, slip.expectationId)))[0]!;
    const augustLedger = (await db.select().from(commissionAccruals))[0]!;

    const correction = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-SEP", statementPeriod: "2026-M09",
      csv: csv(V2_HEADER, `${slip.code},,75000,2026-M08`),
    }, new Date("2026-10-19T06:00:00Z"));

    expect(correction).toMatchObject({
      columnMapVersion: "partner-statement-v2",
      linesMatched: 0, linesDisputed: 0, linesCorrected: 1, confirmedPaise: 15_000,
    });
    expect(correction.lines[0]).toMatchObject({
      outcome: "corrected", correctsPeriod: "2026-M08", deltaPaise: 15_000,
    });

    // THE LEDGER APPENDED. Two rows, and the SUM is the corrected total.
    const ledger = await db.select().from(commissionAccruals).orderBy(asc(commissionAccruals.seq));
    expect(ledger.map((r) => [r.kind, r.amountPaise, r.periodKey])).toEqual([
      ["accrual", 60_000, "2026-M08"],
      ["adjustment", 15_000, "2026-M08"],
    ]);
    expect(ledger.reduce((n, r) => n + r.amountPaise, 0)).toBe(75_000);

    // AUGUST'S OWN ROWS ARE BYTE-IDENTICAL — nothing was edited, in either table.
    expect(ledger[0]).toEqual(augustLedger);
    const augustAfter = (await db.select().from(receivableExpectations).where(eq(receivableExpectations.id, slip.expectationId)))[0]!;
    expect(augustAfter).toEqual(augustClaim);

    // September's line is its own row, matched, naming its own statement.
    const september = (await db.select().from(receivableExpectations).where(eq(receivableExpectations.statementRef, "INV-STMT-SEP")))[0]!;
    expect(september).toMatchObject({
      state: "matched", amountPaise: 75_000, statementPeriod: "2026-M09", attributionId: slip.attributionId,
    });

    const spine = await db.select().from(events).orderBy(asc(events.seq));
    expect(spine.map((e) => e.name)).toEqual([
      "attribution.issued", "statement.imported", "expectation.corrected", "statement.imported",
    ]);
    expect(spine[2]!.payload).toMatchObject({ correctsPeriod: "2026-M08", deltaPaise: 15_000 });
  });

  it("V3 — a DOWNWARD correction is a NEGATIVE row, never a smaller number written over the old one", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-AUG", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, LATER);

    const correction = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-SEP", statementPeriod: "2026-M09",
      csv: csv(V2_HEADER, `${slip.code},,50000,2026-M08`),
    }, new Date("2026-10-19T06:00:00Z"));

    expect(correction.lines[0]).toMatchObject({ outcome: "corrected", deltaPaise: -10_000 });
    expect(correction.confirmedPaise).toBe(-10_000);
    const ledger = await db.select().from(commissionAccruals).orderBy(asc(commissionAccruals.seq));
    expect(ledger.map((r) => r.amountPaise)).toEqual([60_000, -10_000]);
    expect(ledger.reduce((n, r) => n + r.amountPaise, 0)).toBe(50_000);

    // …and the SPINE says the same thing. A clamped-at-zero event would make the audit record
    // disagree with the ledger row it describes, which is the one thing it may never do.
    const spine = await db.select().from(events).orderBy(asc(events.seq));
    const last = spine[spine.length - 1]!;
    expect(last.name).toBe("statement.imported");
    expect(last.payload).toMatchObject({ linesCorrected: 1, confirmedPaise: -10_000 });
  });

  it("V3 — a correction that changes NOTHING appends no ledger row: an adjustment of zero is not an adjustment", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-AUG", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, LATER);

    const repeat = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-SEP", statementPeriod: "2026-M09",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, new Date("2026-10-19T06:00:00Z"));

    expect(repeat.lines[0]).toMatchObject({ outcome: "corrected", deltaPaise: 0, accrualId: null });
    expect(await db.select().from(commissionAccruals)).toHaveLength(1);
  });

  it("V3 — under v1 (no period column) a correction names the period the prior settlement was in", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-Q3", statementPeriod: "2026-Q3",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, LATER);

    const correction = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-Q4", statementPeriod: "2026-Q4",
      csv: csv(V1_HEADER, `${slip.code},,70000`),
    }, new Date("2026-12-19T06:00:00Z"));

    expect(correction.lines[0]).toMatchObject({ correctsPeriod: "2026-Q3", deltaPaise: 10_000 });
    const adjustment = (await db.select().from(commissionAccruals).orderBy(asc(commissionAccruals.seq)))[1]!;
    expect(adjustment.periodKey).toBe("2026-Q3");
  });

  // ── IMPORTED ONCE ─────────────────────────────────────────────────────────────────────────

  it("one statement cannot be imported twice", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    const body = {
      counterpartyId, statementRef: "INV-STMT-007", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    };
    await importStatement(db, CLERK, body, LATER);
    await expect(importStatement(db, CLERK, body, LATER)).rejects.toMatchObject({ code: "statement_already_imported" });
    expect(await db.select().from(commissionAccruals)).toHaveLength(1);
  });

  it("the partial unique index is the structural guard behind that refusal", async () => {
    const { counterpartyId } = await partnerFor();
    await expect(
      db.insert(receivableExpectations).values([
        { id: newId(), counterpartyId, amountPaise: 1, state: "disputed", statementRef: "S1", statementLineNo: 2, expectedAt: NOW },
        { id: newId(), counterpartyId, amountPaise: 1, state: "disputed", statementRef: "S1", statementLineNo: 2, expectedAt: NOW },
      ]),
    ).rejects.toThrow(/receivable_expectations_statement_line_ux/);
  });

  it("rows created at ISSUANCE sit OUTSIDE that index — two open claims are not a collision", async () => {
    const { counterpartyId } = await partnerFor();
    await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 100_000 }, NOW);
    await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, NOW);
    expect(await db.select().from(receivableExpectations)).toHaveLength(2);
  });

  // ── THE WHOLE-FILE DISCIPLINE ─────────────────────────────────────────────────────────────

  it("a mixed statement lands every line somewhere a human can see", async () => {
    const { counterpartyId } = await partnerFor();
    const matched = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    const ageing = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-MIXED", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER,
        `${matched.code},,60000`,   // row 2 — matched
        "RF-NOSUCHSLIP,,10000",     // row 3 — V1 dispute
        "RF-BAD,,not-a-number",     // row 4 — quarantined
        ",,5000",                   // row 5 — quarantined
      ),
    }, LATER);

    expect(result).toMatchObject({
      linesTotal: 4, linesMatched: 1, linesDisputed: 1, linesCorrected: 0, linesQuarantined: 2,
      confirmedPaise: 60_000,
    });
    expect(result.lines.map((l) => [l.rowNo, l.outcome])).toEqual([
      [2, "matched"], [3, "disputed"], [4, "quarantined"], [5, "quarantined"],
    ]);
    // The claim NOBODY mentioned is untouched, and V2's report is where it goes on ageing.
    const untouched = (await db.select().from(receivableExpectations).where(eq(receivableExpectations.id, ageing.expectationId)))[0]!;
    expect(untouched).toMatchObject({ state: "expected", statementRef: null });
    // Quarantine holds the verbatim lines under this statement's own reference.
    expect((await listStatementQuarantine(db, "INV-STMT-MIXED")).map((r) => [r.rowNo, r.reason])).toEqual([
      [3, "unknown_attribution"], [4, "bad_amount"], [5, "missing_required"],
    ]);
  });

  it("the quarantine rows are this lane's own and carry the holder book's `{ line }` shape", async () => {
    const { counterpartyId } = await partnerFor();
    await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-Q", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, "RF-X,,nope"),
    }, LATER);
    const rows = await db.select().from(importQuarantine);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "partner_statement", batchId: "INV-STMT-Q", rowNo: 2, reason: "bad_amount" });
    expect(rows[0]!.raw).toEqual({ line: "RF-X,,nope" });
  });

  it("a statement whose columns are unreadable writes NOTHING at all", async () => {
    const { counterpartyId } = await partnerFor();
    await expect(importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-008", statementPeriod: "2026-M08",
      csv: csv("ref,amount", "RF-1,60000"),
    }, LATER)).rejects.toMatchObject({ code: "statement_columns_unknown" });
    expect(await db.select().from(receivableExpectations)).toHaveLength(0);
    expect(await db.select().from(importQuarantine)).toHaveLength(0);
  });

  /**
   * `kicker.ts`'s `periodSettled` looks a period up by STRING EQUALITY on `statement_period`, so
   * two lanes spelling one quarter differently would never agree that it was settled. The spelling
   * is validated against `periodKeyFor`'s own vocabulary before anything is written.
   */
  it("a statement period outside `periodKeyFor`'s vocabulary is refused before anything is written", async () => {
    const { counterpartyId } = await partnerFor();
    for (const period of ["2026-08", "August 2026", "2026-M13", "2026-Q5", ""]) {
      await expect(importStatement(db, CLERK, {
        counterpartyId, statementRef: `INV-STMT-${period}`, statementPeriod: period,
        csv: csv(V1_HEADER, "RF-1,,1"),
      }, LATER)).rejects.toMatchObject({ code: "statement_columns_unknown" });
    }
    expect(await db.select().from(receivableExpectations)).toHaveLength(0);
  });

  it("an unknown counterparty and a blank statement reference are both typed refusals", async () => {
    await expect(importStatement(db, CLERK, {
      counterpartyId: newId(), statementRef: "INV-STMT-009", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, "RF-1,,1"),
    }, LATER)).rejects.toMatchObject({ code: "unknown_counterparty" });

    const { counterpartyId } = await partnerFor();
    await expect(importStatement(db, CLERK, {
      counterpartyId, statementRef: "   ", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, "RF-1,,1"),
    }, LATER)).rejects.toMatchObject({ code: "statement_columns_unknown" });
  });

  it("the import refuses with the flag OFF, and writes nothing", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    delete process.env[FLAG];
    await expect(importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-010", statementPeriod: "2026-M08",
      csv: csv(V1_HEADER, `${slip.code},,60000`),
    }, LATER)).rejects.toMatchObject({ code: "receivable_disabled" });
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
  });
});
