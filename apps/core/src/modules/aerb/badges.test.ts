import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { aerbTldReads, events } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { aerbManifest } from "./manifest";
import {
  STATUTORY_LIMITS, badgeGaps, badgeReads, badgeRegister, closeBadge, issueBadge,
  recordBadgeRead, setInvestigationLevel,
} from "./badges";
import { investigationLevelFor } from "./limits";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * PLAN 18c T4 — the TLD badge programme.
 *
 * ═══ THE MUTANT THIS FILE IS BUILT AROUND ═══
 *
 * *"Compare the period's reading against the MONTHLY level."* A quarterly badge reading 1.4 mSv is
 * a perfectly ordinary quarter against a 1 mSv/month programme — and against the un-pro-rated
 * monthly figure it is an incident. A register that cried wolf every quarter would be a register
 * an RSO stopped reading, which is the failure mode that matters more than a missed flag.
 *
 * The second is the one about depths: Hp(0.07) is the SKIN dose with its own far higher limit, and
 * comparing it against the whole-body trigger would flag a radiographer for a dose the Rules do not
 * consider one.
 */
describe("the TLD badge programme and the investigation ladder (18c T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let outsider: Actor;
  let tech: { id: string; actor: Actor };
  let tech2: { id: string; actor: Actor };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    for (const role of ["radiation_safety_officer", "radiographer"]) await ensureRole(db, role);
    for (const p of aerbManifest.permissions) {
      await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    }
    await grantPermissionToRole(db, registry, "radiographer", "aerb.doses.read");
    ({ actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]));
    ({ actor: outsider } = await mkUser(db, "front.desk", ["radiographer"]));
    const a = await mkUser(db, "rt.singh", ["radiographer"]);
    const b = await mkUser(db, "rt.devi", ["radiographer"]);
    tech = { id: a.id, actor: a.actor };
    tech2 = { id: b.id, actor: b.actor };
  });

  const issue = (userId: string, badgeNo: string, issuedOn = "2026-01-01") =>
    withTx(db, (tx) => issueBadge(tx, rso, { userId, badgeNo, issuedOn }));

  const read = (badgeId: string, over: Partial<Parameters<typeof recordBadgeRead>[2]> = {}) =>
    withTx(db, (tx) => recordBadgeRead(tx, rso, {
      badgeId, periodStart: "2026-01-01", periodEnd: "2026-03-31",
      hp10Msv: 1.4, hp007Msv: 1.6, reportedOn: "2026-04-20", labRef: "TLD/2026/Q1", ...over,
    }));

  /* ═════════ THE PRO-RATED LEVEL — the mutant's home ═════════ */

  /**
   * A quarter is ~3 months, so a 1 mSv/month programme's quarterly trigger is ~3 mSv. The 1.4 mSv
   * reading below is the row the un-pro-rated mutant flags and this register does not.
   */
  it("compares a QUARTERLY reading against a pro-rated level, not the monthly figure", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    const out = await read(badgeId, { hp10Msv: 1.4 });
    expect(out.investigationLevelMsv).toBeCloseTo(2.958, 2); // 90 days at 1 mSv / 30.44 days
    expect(out.investigation).toBe(false);
  });

  it("flags a quarterly reading that DOES exceed the pro-rated level", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    const out = await read(badgeId, { hp10Msv: 3.2 });
    expect(out.investigation).toBe(true);
    const [row] = await db.select().from(aerbTldReads).where(eq(aerbTldReads.id, out.readId));
    expect(row!.investigationFlag).toBe(true);
    expect(Number(row!.investigationLevelMsv)).toBeCloseTo(2.958, 2);
  });

  it("the SAME reading flags once the owner lowers the level — the number is data (R3)", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    expect((await read(badgeId, { hp10Msv: 1.4 })).investigation).toBe(false);
    await withTx(db, (tx) => setInvestigationLevel(tx, rso, 0.4));
    const out = await read(badgeId, { hp10Msv: 1.4, periodStart: "2026-04-01", periodEnd: "2026-06-30" });
    expect(out.investigation).toBe(true);
  });

  /**
   * The stored verdict is the point: lowering the level next year must not turn last year's
   * readings into incidents retroactively.
   */
  it("a level lowered LATER does not re-flag a reading already entered", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    const first = await read(badgeId, { hp10Msv: 1.4 });
    await withTx(db, (tx) => setInvestigationLevel(tx, rso, 0.2));
    const [row] = await db.select().from(aerbTldReads).where(eq(aerbTldReads.id, first.readId));
    expect(row!.investigationFlag).toBe(false);
    expect(Number(row!.investigationLevelMsv)).toBeCloseTo(2.958, 2);
  });

  it("the pro-rating is inclusive of both endpoints — 31 days is 31, not 30", () => {
    expect(investigationLevelFor(1, "2026-01-01", "2026-01-31")).toBeCloseTo(31 / 30.436875, 4);
    expect(investigationLevelFor(1, "2026-01-01", "2026-01-01")).toBeCloseTo(1 / 30.436875, 4);
  });

  /* ═════════ THE TWO DEPTHS ═════════ */

  /**
   * Hp(0.07) is the SKIN dose. It is recorded and compared against nothing here — a shallow reading
   * measured against the whole-body trigger would flag a radiographer for a dose the Rules do not
   * consider one. The row below has an Hp(0.07) well over the level and an Hp(10) under it.
   */
  it("records Hp(0.07) and never compares it — the skin limit is not the whole-body one", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    const out = await read(badgeId, { hp10Msv: 1.4, hp007Msv: 9.9 });
    expect(out.investigation).toBe(false);
    const [row] = await db.select().from(aerbTldReads).where(eq(aerbTldReads.id, out.readId));
    expect(row!.hp007Msv).toBe("9.900");
  });

  /* ═════════ RECORD-ONLY (D9) ═════════ */

  it("emits radiation.dose_limit_warning naming the worker, and nothing else", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    await read(badgeId, { hp10Msv: 3.2 });
    const [row] = await db.select().from(events).where(eq(events.name, "radiation.dose_limit_warning"));
    expect(row).toBeDefined();
    expect(row!.payload).toMatchObject({ userId: tech.id, badgeNo: "TLD-001", hp10Msv: 3.2 });
    /** No patient, no procedure, no roster. */
    expect(JSON.stringify(row!.payload)).not.toMatch(/patient|procedure|roster|shift/i);
  });

  it("emits NOTHING for a reading under the level", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    await read(badgeId, { hp10Msv: 1.4 });
    expect(await db.select().from(events).where(eq(events.name, "radiation.dose_limit_warning"))).toHaveLength(0);
  });

  /** D9's whole posture: a flagged reading changes no status anywhere and refuses nothing. */
  it("a flagged reading refuses NOTHING — the next reading records exactly as before", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    await read(badgeId, { hp10Msv: 25 });
    await expect(read(badgeId, { hp10Msv: 26, periodStart: "2026-04-01", periodEnd: "2026-06-30" }))
      .resolves.toMatchObject({ investigation: true });
    const register = await badgeRegister(db, { onDate: "2026-07-01" });
    expect(register[0]!.status).toBe("active"); // the badge is not suspended by its own reading
  });

  /* ═════════ ONE BADGE, ONE PERSON, ONE PERIOD ═════════ */

  /**
   * CLOSE REVIEW — this used to assert the raw index name, i.e. it pinned a 500 with a Postgres
   * constraint in the body as the expected behaviour. The refusal is a sentence now.
   */
  it("refuses a second active badge for one person, BY NAME", async () => {
    await issue(tech.id, "TLD-001");
    await expect(issue(tech.id, "TLD-002")).rejects.toMatchObject({
      code: "badge_already_issued",
      detail: { badgeNo: "TLD-002" },
    });
    /** And the same number in somebody else's hands is refused too, with a different sentence. */
    await expect(issue(tech2.id, "TLD-001")).rejects.toMatchObject({ code: "badge_already_issued" });
  });

  it("a returned badge frees the person AND the number, and the old readings stay", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    await read(badgeId, { hp10Msv: 1.1 });
    await withTx(db, (tx) => closeBadge(tx, rso, badgeId, "returned", "2026-06-30"));
    await expect(issue(tech.id, "TLD-001", "2026-07-01")).resolves.toBeDefined();
    expect(await badgeReads(db)).toHaveLength(1);
  });

  it("refuses a second reading for the same badge and period — a correction is not a second dose", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    await read(badgeId);
    await expect(read(badgeId)).rejects.toMatchObject({
      code: "read_already_recorded",
      detail: { periodStart: "2026-01-01", periodEnd: "2026-03-31" },
    });
  });

  /**
   * CLOSE REVIEW — a laboratory report for a period before the badge was issued is a report about
   * a badge somebody else was wearing, and it used to be accepted and counted into the worker's
   * cumulative.
   */
  it("refuses a reading for a period that closed before the badge was issued", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001", "2026-04-01");
    await expect(read(badgeId, { periodStart: "2026-01-01", periodEnd: "2026-03-31" }))
      .rejects.toMatchObject({ code: "invalid_validity", detail: { issuedOn: "2026-04-01" } });
  });

  it("refuses returning a badge on a date before it was issued, by name rather than by CHECK", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001", "2026-04-01");
    await expect(withTx(db, (tx) => closeBadge(tx, rso, badgeId, "returned", "2026-01-01")))
      .rejects.toMatchObject({ code: "invalid_validity" });
  });

  it("refuses a negative reading and a period that ends before it begins", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001");
    await expect(read(badgeId, { hp10Msv: -1 })).rejects.toMatchObject({ code: "invalid_validity" });
    await expect(read(badgeId, { periodStart: "2026-03-31", periodEnd: "2026-01-01" }))
      .rejects.toMatchObject({ code: "invalid_validity" });
  });

  /* ═════════ THE CUMULATIVES, AND THE LIMITS THEY ARE COMPARED AGAINST ═════════ */

  it("sums the calendar year and the rolling five years FOR THE WORKER", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001", "2022-01-01");
    await read(badgeId, { hp10Msv: 4, periodStart: "2022-01-01", periodEnd: "2022-03-31" });
    await read(badgeId, { hp10Msv: 5, periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    await read(badgeId, { hp10Msv: 6, periodStart: "2026-04-01", periodEnd: "2026-06-30" });
    const [row] = await badgeRegister(db, { onDate: "2026-07-01" });
    expect(Number(row!.workerYtdMsv)).toBeCloseTo(11, 3);
    expect(Number(row!.workerFiveYearMsv)).toBeCloseTo(15, 3);
    expect(row!.overAnnualLimit).toBe(false);
    expect(row!.overFiveYearLimit).toBe(false);
  });

  /**
   * ═══ CLOSE REVIEW, CRITICAL — THE DOSE BELONGS TO THE PERSON, NOT TO THE PLASTIC ═══
   *
   * A badge lost mid-year and replaced splits the ledger. Summed per badge, this radiographer's
   * 34 mSv showed as two green rows — 28 and 6 — against a 30 mSv statutory ceiling, with no flag
   * anywhere. The close-then-reissue below is the sequence the suite ALREADY performed one test
   * over while asserting the split was correct.
   */
  it("a badge lost and re-issued does NOT split the worker's year under the limit", async () => {
    const first = await issue(tech.id, "TLD-001", "2026-01-01");
    await read(first.badgeId, { hp10Msv: 16, periodStart: "2026-01-01", periodEnd: "2026-03-31" });
    await read(first.badgeId, { hp10Msv: 12, periodStart: "2026-04-01", periodEnd: "2026-06-30" });
    await withTx(db, (tx) => closeBadge(tx, rso, first.badgeId, "lost", "2026-07-01"));
    const second = await issue(tech.id, "TLD-014", "2026-07-02");
    await read(second.badgeId, { hp10Msv: 6, periodStart: "2026-07-01", periodEnd: "2026-09-30" });

    const rows = await badgeRegister(db, { onDate: "2026-10-01" });
    expect(rows).toHaveLength(2);
    /** BOTH rows carry the person's 34 mSv, and BOTH say the ceiling was breached. */
    for (const r of rows) {
      expect(Number(r.workerYtdMsv)).toBeCloseTo(34, 3);
      expect(r.overAnnualLimit).toBe(true);
    }
    /** The per-badge column still shows what THIS badge read, which is what an RSO scans down. */
    expect(rows.find((r) => r.badgeNo === "TLD-014")!.lastHp10Msv).toBe("6.000");
  });

  /**
   * ═══ CLOSE REVIEW, CRITICAL — A LATE REPORT LANDS IN ITS OWN YEAR ═══
   *
   * `recordBadgeRead`'s own docstring says a TLD report arrives weeks after the period it
   * describes. The Q4 reading entered in February has `periodEnd` in LAST year: keyed on the
   * current year it was excluded, and last year was never recomputed, so a year that went over the
   * ceiling was over it at no instant the system could report.
   */
  it("a Q4 report entered in February still puts LAST year over the limit", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001", "2026-01-01");
    for (const [q, start, end] of [["Q1", "2026-01-01", "2026-03-31"], ["Q2", "2026-04-01", "2026-06-30"], ["Q3", "2026-07-01", "2026-09-30"]] as const) {
      void q;
      await read(badgeId, { hp10Msv: 9, periodStart: start, periodEnd: end });
    }
    /** 27 mSv by the end of September, and clean. */
    const inYear = await badgeRegister(db, { onDate: "2026-12-31" });
    expect(inYear[0]!.overAnnualLimit).toBe(false);

    /** The Q4 report arrives in February and takes 2026 to 33 mSv. */
    await read(badgeId, { hp10Msv: 6, periodStart: "2026-10-01", periodEnd: "2026-12-31", reportedOn: "2027-02-10" });
    const later = await badgeRegister(db, { onDate: "2027-02-10" });
    expect(later[0]!.overAnnualLimit).toBe(true);
    expect(later[0]!.worstYear).toBe("2026");
    expect(Number(later[0]!.worstYearMsv)).toBeCloseTo(33, 3);
    /** This YEAR is still zero, and both facts are on the row. */
    expect(Number(later[0]!.workerYtdMsv)).toBeCloseTo(0, 3);
  });

  it("names the statutory limits it compares against, and they are the Rules' numbers", async () => {
    expect(STATUTORY_LIMITS).toEqual({ annualMsv: 30, fiveYearAverageMsv: 20, fiveYearTotalMsv: 100 });
    const { badgeId } = await issue(tech.id, "TLD-001");
    await read(badgeId, { hp10Msv: 31 });
    const [row] = await badgeRegister(db, { onDate: "2026-07-01" });
    expect(row!.overAnnualLimit).toBe(true);
  });

  /** The statutory limit is LAW and the investigation level is policy — one is editable, one is not. */
  it("refuses an investigation level at or above the statutory annual limit", async () => {
    await expect(withTx(db, (tx) => setInvestigationLevel(tx, rso, 3)))
      .rejects.toMatchObject({ code: "invalid_validity" });
    await expect(withTx(db, (tx) => setInvestigationLevel(tx, rso, 0.5))).resolves.toBeUndefined();
  });

  /* ═════════ THE NEGATIVE SPACE — a badge period with NO read ═════════ */

  /**
   * The brainstorm's own question. A register that listed only the readings it HAS could never show
   * the badge that was never sent, and every one of those is a person whose exposure is unknown.
   */
  it("names the active badge that has produced no reading in four months", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001", "2026-01-01");
    await issue(tech2.id, "TLD-002", "2026-01-01");
    await read(badgeId, { hp10Msv: 1.1, periodStart: "2026-01-01", periodEnd: "2026-03-31" });

    /**
     * 2026-04-15 — NEITHER is a gap yet, and that is the assertion. The first was read a fortnight
     * ago; the second has never been read at all, but it has only been worn 104 days and a Q1
     * report typically arrives in mid-May. A gap list that cried on day 105 would be a gap list an
     * RSO stopped opening, which is the failure that matters more than a late flag.
     */
    expect(await badgeGaps(db, { onDate: "2026-04-15" })).toHaveLength(0);

    /** 2026-05-15 — 134 days, and the badge that has produced NOTHING is now named. */
    const early = await badgeGaps(db, { onDate: "2026-05-15" });
    expect(early.map((g) => g.badgeNo)).toEqual(["TLD-002"]);

    /** 2026-09-01: the first is now five months stale too. */
    const later = await badgeGaps(db, { onDate: "2026-09-01" });
    expect(later.map((g) => g.badgeNo).sort()).toEqual(["TLD-001", "TLD-002"]);
    expect(later.find((g) => g.badgeNo === "TLD-001")!.lastPeriodEnd).toBe("2026-03-31");
    expect(later.find((g) => g.badgeNo === "TLD-002")!.lastPeriodEnd).toBeNull();
  });

  it("a RETURNED badge is not a gap — nobody is wearing it", async () => {
    const { badgeId } = await issue(tech.id, "TLD-001", "2026-01-01");
    await withTx(db, (tx) => closeBadge(tx, rso, badgeId, "returned", "2026-02-01"));
    expect(await badgeGaps(db, { onDate: "2026-09-01" })).toHaveLength(0);
  });

  /* ═════════ WHO MAY ═════════ */

  it("a radiographer holding only the dose read cannot issue a badge or enter a reading", async () => {
    await expect(withTx(db, (tx) => issueBadge(tx, outsider, {
      userId: tech.id, badgeNo: "TLD-009", issuedOn: "2026-01-01",
    }))).rejects.toMatchObject({ code: "not_appointed" });
    const { badgeId } = await issue(tech.id, "TLD-001");
    await expect(withTx(db, (tx) => recordBadgeRead(tx, outsider, {
      badgeId, periodStart: "2026-01-01", periodEnd: "2026-03-31", hp10Msv: 1, reportedOn: "2026-04-01",
    }))).rejects.toMatchObject({ code: "not_appointed" });
  });
});
