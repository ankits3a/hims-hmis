import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  attributionIds, commissionAccruals, counterparties, partnerAgreements, partnerRefMap,
  receivableExpectations,
} from "../../kernel/db/schema";
import { issueAttribution } from "./attribution";
import { importStatement } from "./statements";
import { listPartnerRefs, mapPartnerRef, resolveStatementRef, writeOffExpectation } from "./reconcile";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 09 T7 — V7 AND ASSERTION BOOK ROW G3: **THE MAPPING TABLE IS THE ONLY JOIN.**
 *
 * The rule has two halves and this file asserts both, because either one alone is satisfiable by an
 * implementation that breaks the other:
 *
 *  · BEHAVIOUR — a partner reference differing from a MAPPED one by a single character resolves to
 *    NOTHING and the statement line disputes. That is the G3 mutant's own discriminating input: a
 *    similarity fallback added to `resolveStatementRef` matches it and the line settles.
 *  · SOURCE — this lane contains no fuzzy matcher AT ALL. A behavioural leg cannot see a fallback
 *    that happens not to fire on the fixture chosen; a source scan cannot see a fallback written
 *    with a token it does not know. Together they are hard to defeat by accident, which is the
 *    point: DD13's reason for forbidding fuzzy joins is that a match wrong once in a thousand rows
 *    produces a reconciliation nobody can audit, and "nobody noticed the fallback" is exactly how
 *    one arrives.
 *
 * §2.49 — the source scanner has a NEGATIVE CONTROL that fires on a synthetic source, so a scanner
 * that had gone silent could not pass this file vacuously.
 *
 * Every partner, reference and code below is INVENTED HERE (DD3 / owner ruling O-9).
 */
const FLAG = "RECEIVABLE_COMMISSION_ENABLED";

const CLERK: Actor = { type: "user", id: "t7-reconcile-clerk" };
const NOW = new Date("2026-08-19T06:00:00Z");
const AGREEMENT_FROM = new Date("2026-04-01T00:00:00Z");

// ── THE SOURCE SCAN — V7's structural half ────────────────────────────────────────────────────

const LANE_SOURCES = ["reconcile.ts", "statements.ts"] as const;

/**
 * Comments are STRIPPED before the scan, and that is not a convenience: this file's own subject is
 * discussed at length in the prose above `resolveStatementRef`, which says the words `similarity`
 * and `ilike` in order to forbid them. A scanner that read comments would refuse the very
 * documentation that makes the rule findable — §2.52's shape, where a correct implementation fails
 * a broken instrument.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Every operator, function and helper by which this codebase could express "close enough". The
 * list is assembled from FRAGMENTS so that the scanner's own source cannot match it — the
 * `billing-purity.test.ts` trick, and for the same reason: a sweep that exempts itself is a sweep
 * with a hole exactly where somebody would put the thing it looks for.
 */
const FUZZY_TOKENS: readonly string[] = [
  `simil${"arity"}`, `word_simil${"arity"}`, `${"i"}like`, `leven${"shtein"}`, `sound${"ex"}`,
  `meta${"phone"}`, `pg_${"trgm"}`, `${"tri"}gram`, `starts${"With"}`, `ends${"With"}`,
  `normalizeFor${"Search"}`,
];

export function fuzzyTokensIn(source: string): string[] {
  const code = stripComments(source).toLowerCase();
  return FUZZY_TOKENS.filter((token) => code.includes(token.toLowerCase()));
}

describe("V7 — the mapping table is the only join, and there is no fuzzy fallback", () => {
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

  // ── THE STRUCTURAL LEG ────────────────────────────────────────────────────────────────────

  it("V7 — neither `reconcile.ts` nor `statements.ts` contains ANY fuzzy matcher", () => {
    for (const file of LANE_SOURCES) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect({ file, fuzzy: fuzzyTokensIn(source) }).toEqual({ file, fuzzy: [] });
    }
  });

  /** §2.49 — the scanner must be able to FAIL, or the leg above is satisfied by a broken instrument. */
  it("V7 — the scanner's negative control: it FIRES on a source that adds a similarity fallback", () => {
    const mutantShape = [
      "const near = await exec.execute(sql`",
      "  select id from attribution_ids where similarity(code, ${ref}) > 0.4",
      "  order by similarity(code, ${ref}) desc limit 1`);",
    ].join("\n");
    expect(fuzzyTokensIn(mutantShape)).toContain("similarity");
    // …and it does NOT fire on the same words inside a comment, which is what the prose above
    // `resolveStatementRef` needs in order to forbid them by name.
    expect(fuzzyTokensIn("/* never use similarity() or ilike here */\nconst x = 1;")).toEqual([]);
    expect(fuzzyTokensIn("// no ilike, ever\nconst y = 2;")).toEqual([]);
  });

  // ── THE BEHAVIOURAL LEG — Assertion Book row G3 ───────────────────────────────────────────

  it("a mapped partner reference resolves EXACTLY", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: slip.attributionId }, NOW);

    expect(await resolveStatementRef(db, counterpartyId, { partnerRef: "LAB/2026/000871" })).toEqual({
      outcome: "resolved", attributionId: slip.attributionId, counterpartyId, via: "partner_ref",
    });
    // A CSV cell arrives padded; trimming whitespace is not matching.
    expect(await resolveStatementRef(db, counterpartyId, { partnerRef: "  LAB/2026/000871 " })).toMatchObject({
      outcome: "resolved", via: "partner_ref",
    });
  });

  /**
   * ═══ BOOK ROW G3 — ONE CHARACTER IS A DIFFERENT REFERENCE ═══
   *
   * `LAB/2026/000871` is mapped; `LAB/2026/000870` is not. Under the shipped join the second
   * resolves to nothing. Under a similarity fallback it resolves to the first — one digit apart on
   * a fifteen-character string scores ~0.93 — and a partner is credited for a referral it did not
   * make, or ours is credited to the wrong one.
   */
  it("G3 — a reference differing by ONE CHARACTER resolves to NOTHING, in every direction", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: slip.attributionId }, NOW);

    const nearMisses = [
      "LAB/2026/000870",   // one digit
      "LAB/2026/00871",    // one digit dropped
      "LAB/2026/0008711",  // one digit added
      "lab/2026/000871",   // case
      "LAB-2026-000871",   // separators
      "LAB/2026/000871 X", // a suffix
    ];
    for (const ref of nearMisses) {
      expect({ ref, ...(await resolveStatementRef(db, counterpartyId, { partnerRef: ref })) })
        .toEqual({ ref, outcome: "unknown" });
    }
  });

  it("G3 — the near miss DISPUTES the statement line rather than settling it", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: slip.attributionId }, NOW);

    const result = await importStatement(db, CLERK, {
      counterpartyId, statementRef: "INV-STMT-G3", statementPeriod: "2026-M08",
      csv: "attribution_ref,partner_ref,amount_paise\n,LAB/2026/000870,60000\n",
    }, NOW);

    expect(result.lines).toEqual([
      { rowNo: 2, outcome: "disputed", expectationId: expect.any(String), attributionId: null, reason: "unknown_attribution" },
    ]);
    // The claim the hospital DID raise is untouched and still ageing (V2).
    const raised = await db.select().from(receivableExpectations).where(eq(receivableExpectations.id, slip.expectationId));
    expect(raised[0]!.state).toBe("expected");
    // And NO money moved — a partner cannot create a receivable by asserting one.
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
  });

  it("a partner's reference space is scoped to that partner — B's ref never resolves under A", async () => {
    const a = await partnerFor("Invented Partner A");
    const b = await partnerFor("Invented Partner B");
    const slipB = await issueAttribution(db, CLERK, { counterpartyId: b.counterpartyId, referredValuePaise: 400_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId: b.counterpartyId, partnerRef: "SHARED-REF-1", attributionId: slipB.attributionId }, NOW);

    expect(await resolveStatementRef(db, a.counterpartyId, { partnerRef: "SHARED-REF-1" })).toEqual({ outcome: "unknown" });
    expect(await resolveStatementRef(db, b.counterpartyId, { partnerRef: "SHARED-REF-1" })).toMatchObject({ outcome: "resolved" });
  });

  /**
   * OUR OWN printed code is resolved GLOBALLY on purpose — see `reconcile.ts`'s header. Scoping it
   * would collapse V6 ("another partner's slip") into V1 ("a slip we never issued"), and the two
   * are different conversations with different partners.
   */
  it("our own code resolves globally, carrying the OWNING partner's id for the caller to compare", async () => {
    const a = await partnerFor("Invented Partner A");
    const b = await partnerFor("Invented Partner B");
    const slipA = await issueAttribution(db, CLERK, { counterpartyId: a.counterpartyId, referredValuePaise: 400_000 }, NOW);

    expect(await resolveStatementRef(db, b.counterpartyId, { attributionCode: slipA.code })).toEqual({
      outcome: "resolved", attributionId: slipA.attributionId, counterpartyId: a.counterpartyId, via: "attribution_code",
    });
  });

  it("the attribution code is tried FIRST and the partner reference only after it", async () => {
    const { counterpartyId } = await partnerFor();
    const byCode = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 100_000 }, NOW);
    const byRef = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "REF-BOTH", attributionId: byRef.attributionId }, NOW);

    expect(await resolveStatementRef(db, counterpartyId, { attributionCode: byCode.code, partnerRef: "REF-BOTH" }))
      .toMatchObject({ attributionId: byCode.attributionId, via: "attribution_code" });
  });

  // ── WRITING THE BRIDGE ────────────────────────────────────────────────────────────────────

  it("a mapping records WHO decided it — the thing a similarity score cannot give a dispute", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    const mapping = await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: slip.attributionId }, NOW);

    expect(mapping).toMatchObject({ counterpartyId, partnerRef: "LAB/2026/000871", attributionId: slip.attributionId, mappedBy: CLERK.id });
    expect(await listPartnerRefs(db, counterpartyId)).toHaveLength(1);
    expect((await db.select().from(partnerRefMap))[0]!.mappedBy).toBe(CLERK.id);
  });

  it("a second mapping for one (partner, reference) pair is a typed refusal, not an integrity error", async () => {
    const { counterpartyId } = await partnerFor();
    const first = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 100_000 }, NOW);
    const second = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 200_000 }, NOW);
    await mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: first.attributionId }, NOW);

    await expect(
      mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "LAB/2026/000871", attributionId: second.attributionId }, NOW),
    ).rejects.toMatchObject({ code: "duplicate_partner_ref" });
    expect(await listPartnerRefs(db, counterpartyId)).toHaveLength(1);
  });

  /**
   * DD13's single-partner rule is enforced where the bridge is BUILT. A mapping that crossed
   * partners would make V6 unenforceable by construction: the fuzzy join we refused would simply
   * have been replaced by a hand-written wrong one.
   */
  it("a mapping may not point at ANOTHER partner's attribution", async () => {
    const a = await partnerFor("Invented Partner A");
    const b = await partnerFor("Invented Partner B");
    const slipA = await issueAttribution(db, CLERK, { counterpartyId: a.counterpartyId, referredValuePaise: 400_000 }, NOW);

    await expect(
      mapPartnerRef(db, CLERK, { counterpartyId: b.counterpartyId, partnerRef: "REF-1", attributionId: slipA.attributionId }, NOW),
    ).rejects.toMatchObject({ code: "attribution_partner_mismatch" });
    expect(await db.select().from(partnerRefMap)).toHaveLength(0);
  });

  it("a mapping onto an unknown attribution, and a blank reference, are both typed refusals", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await expect(
      mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "REF-1", attributionId: newId() }, NOW),
    ).rejects.toMatchObject({ code: "unknown_attribution" });
    await expect(
      mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "   ", attributionId: slip.attributionId }, NOW),
    ).rejects.toMatchObject({ code: "unknown_partner_ref" });
  });

  it("writing the bridge refuses with the flag OFF", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    delete process.env[FLAG];
    await expect(
      mapPartnerRef(db, CLERK, { counterpartyId, partnerRef: "REF-1", attributionId: slip.attributionId }, NOW),
    ).rejects.toMatchObject({ code: "receivable_disabled" });
  });

  // ── THE OPERATOR'S END OF THE LIFECYCLE ───────────────────────────────────────────────────

  it("an expected claim can be written off with a reason, and it leaves the ledger alone", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);

    expect(await writeOffExpectation(db, CLERK, { expectationId: slip.expectationId, reason: "partner will not confirm" }, NOW))
      .toEqual({ expectationId: slip.expectationId, state: "written_off" });
    const rows = await db.select().from(receivableExpectations);
    expect(rows[0]).toMatchObject({ state: "written_off", disputeReason: "partner will not confirm" });
    expect(await db.select().from(commissionAccruals)).toHaveLength(0);
  });

  it("a MATCHED claim may not be written off — money a statement confirmed is credited, never forgotten", async () => {
    const { counterpartyId } = await partnerFor();
    const slip = await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    await db.update(receivableExpectations).set({ state: "matched", matchedAt: NOW })
      .where(eq(receivableExpectations.id, slip.expectationId));

    await expect(
      writeOffExpectation(db, CLERK, { expectationId: slip.expectationId, reason: "tidying up" }, NOW),
    ).rejects.toMatchObject({ code: "expectation_state_conflict" });
  });

  it("writing off an unknown expectation is a typed refusal", async () => {
    await expect(
      writeOffExpectation(db, CLERK, { expectationId: newId(), reason: "x" }, NOW),
    ).rejects.toMatchObject({ code: "unknown_expectation" });
  });

  it("the slips themselves are untouched by every refusal above", async () => {
    const { counterpartyId } = await partnerFor();
    await issueAttribution(db, CLERK, { counterpartyId, referredValuePaise: 400_000 }, NOW);
    expect((await db.select().from(attributionIds))[0]!.state).toBe("issued");
  });
});
