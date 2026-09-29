import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { ModuleRegistry } from "../../kernel/modules/loader";
import { grantPermissionToRole, syncPermissions } from "../../kernel/auth/permissions";
import { aerbTldReads, events } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { aerbManifest } from "./manifest";
import { issueBadge, recordBadgeRead } from "./badges";
import { declarePregnancy } from "./pregnancy";
import { importTldReads, parseDose, parseReportDate, splitCsv } from "./tld-import";
import { AerbError } from "./errors";
import type { Db } from "../../kernel/db/client";
import type { Actor } from "@hmis/contracts";

/**
 * 18-S RS11 T1 — the quarterly TLD report, imported whole or not at all.
 *
 * The mutant this file is built around: **"write the good lines and report the bad ones."** The RSO
 * reads "2 imported, 1 error", fixes nothing, and the quarter is on file for two workers and not the
 * third — with nothing in the register saying whose dose is missing. So every refusal below also
 * reads the TABLE afterwards and finds it empty.
 */
const FIXTURE = readFileSync(join(__dirname, "__fixtures__", "tld-quarterly-q2-2026.csv"), "utf8");

describe("TLD CSV import (18-S RS11 T1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let rso: Actor;
  let bikash: string;
  let ravi: string;
  let rina: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    const registry = new ModuleRegistry();
    registry.install(aerbManifest);
    await syncPermissions(db, registry);
    for (const role of ["radiation_safety_officer", "radiographer"]) await ensureRole(db, role);
    for (const p of aerbManifest.permissions) await grantPermissionToRole(db, registry, "radiation_safety_officer", p);
    ({ actor: rso } = await mkUser(db, "rso.bhat", ["radiation_safety_officer"]));
    bikash = (await mkUser(db, "Bikash Mondal", ["radiographer"])).id;
    ravi = (await mkUser(db, "Ravi Tudu", ["radiographer"])).id;
    rina = (await mkUser(db, "Rina Devi", ["radiographer"])).id;
    for (const [userId, badgeNo] of [[bikash, "JH-40117"], [ravi, "JH-40118"], [rina, "JH-40119"]] as const) {
      await withTx(db, (tx) => issueBadge(tx, rso, { userId, badgeNo, issuedOn: "2026-01-01" }));
    }
  });

  const run = (csv: string, dryRun: boolean) =>
    withTx(db, (tx) => importTldReads(tx, rso, { csv, reportedOn: "20/07/2026", labRef: "BARC-TLD/2026/Q2/881", dryRun }));

  const refusal = async (p: Promise<unknown>): Promise<AerbError> => {
    try { await p; } catch (e) { if (e instanceof AerbError) return e; throw e; }
    throw new Error("expected a refusal");
  };

  it("parses the service layout: tolerant headers, day-first dates, BDL as zero", () => {
    expect(splitCsv("a,\"b, c\",d\r\n1,2,3\n")).toEqual([["a", "b, c", "d"], ["1", "2", "3"]]);
    expect(parseReportDate("01/04/2026")).toBe("2026-04-01");
    expect(parseReportDate("30-Jun-2026")).toBe("2026-06-30");
    expect(parseReportDate("2026-06-30")).toBe("2026-06-30");
    expect(parseReportDate("31/06/2026")).toBeNull();
    expect(parseDose("BDL")).toEqual({ value: 0, note: expect.stringContaining("below the detection limit") });
    expect(parseDose("0.42")).toEqual({ value: 0.42, note: null });
    expect(parseDose("abc")).toBeNull();
  });

  it("a dry run previews every line with its flags and writes NOTHING", async () => {
    const report = await run(FIXTURE, true);
    expect(report.errorCount).toBe(0);
    expect(report.imported).toBe(0);
    expect(report.columns).toMatchObject({ badgeNo: "TLD Badge No.", wearer: "Name of the Radiation Worker", hp10: "Hp(10) (mSv)" });
    expect(report.rows.map((r) => [r.badgeNo, r.userName, r.periodStart, r.periodEnd, r.hp10Msv])).toEqual([
      ["JH-40117", "Bikash Mondal", "2026-04-01", "2026-06-30", 0.42],
      ["JH-40118", "Ravi Tudu", "2026-04-01", "2026-06-30", 3.4],
      ["JH-40119", "Rina Devi", "2026-04-01", "2026-06-30", 0],
    ]);
    /** 3.40 mSv in a 91-day quarter is over 1 mSv × 91/30.44 ≈ 2.99 — ruling 5's quarterly 3 mSv. */
    expect(report.rows.map((r) => r.overInvestigationLevel)).toEqual([false, true, false]);
    expect(report.rows[2]!.remarks).toContain("below the detection limit");
    expect(report.flagged.investigation).toBe(1);
    expect(await db.select().from(aerbTldReads)).toHaveLength(0);
  });

  it("confirm writes every line through recordBadgeRead: stored verdict, the dose-limit event", async () => {
    const report = await run(FIXTURE, false);
    expect(report.imported).toBe(3);
    const reads = await db.select().from(aerbTldReads);
    expect(reads).toHaveLength(3);
    expect(reads.every((r) => r.labRef === "BARC-TLD/2026/Q2/881" && r.reportedOn === "2026-07-20")).toBe(true);
    expect(reads.filter((r) => r.investigationFlag)).toHaveLength(1);
    const warnings = await db.select().from(events).where(eq(events.name, "radiation.dose_limit_warning"));
    expect(warnings).toHaveLength(1);
  });

  it("an unknown badge refuses the WHOLE file, names the line, and writes nothing", async () => {
    const bad = `${FIXTURE.trimEnd()}\n4,JH-99999,Somebody,01/04/2026,30/06/2026,0.10,0.10,\n`;
    const preview = await run(bad, true);
    expect(preview.errorCount).toBe(1);
    expect(preview.rows[3]!.errors[0]).toContain("JH-99999 is not in the badge book");
    const e = await refusal(run(bad, false));
    expect(e.code).toBe("tld_import_rejected");
    expect((e.detail as { rows: { line: number; errors: string[] }[] }).rows.find((r) => r.errors.length > 0)!.line).toBe(5);
    expect(await db.select().from(aerbTldReads)).toHaveLength(0);
  });

  it("a period already on file, or twice in the file, is refused per row", async () => {
    const other = (await mkUser(db, "Other Worker", [])).id;
    const { badgeId } = await withTx(db, (tx) => issueBadge(tx, rso, { userId: other, badgeNo: "JH-1", issuedOn: "2026-01-01" }));
    await withTx(db, (tx) => recordBadgeRead(tx, rso, {
      badgeId, periodStart: "2026-04-01", periodEnd: "2026-06-30", hp10Msv: 0.2, reportedOn: "2026-07-10",
    }));
    const csv = "Badge No,Period From,Period To,Hp10\nJH-1,01/04/2026,30/06/2026,0.2\n"
      + "JH-40117,01/04/2026,30/06/2026,0.1\nJH-40117,01/04/2026,30/06/2026,0.1\n";
    const preview = await run(csv, true);
    expect(preview.rows[0]!.errors[0]).toContain("already has a reading on file");
    expect(preview.rows[1]!.errors[0]).toContain("line 4 repeats");
    expect(preview.rows[2]!.errors[0]).toContain("line 3 already carries");
    expect((await refusal(run(csv, false))).code).toBe("tld_import_rejected");
    expect(await db.select().from(aerbTldReads)).toHaveLength(1);
  });

  it("a file without the required columns is refused before any line is read", async () => {
    const e = await refusal(run("Name,Dose\nRavi,1\n", true));
    expect(e.code).toBe("tld_import_rejected");
    expect(e.message).toContain("badge number");
  });

  it("flags a year's projection over 20 mSv and a year over the 30 mSv limit", async () => {
    const csv = "Badge No,Period From,Period To,Hp(10)\n"
      + "JH-40118,01/01/2026,31/03/2026,8.0\nJH-40118,01/04/2026,30/06/2026,23.0\n";
    const report = await run(csv, true);
    expect(report.rows[0]!.overAnnualProjection).toBe(true); // 8 mSv in 90 days → ~32 mSv a year
    expect(report.rows[0]!.overAnnualLimit).toBe(false);
    expect(report.rows[1]!.yearTotalMsv).toBe(31);
    expect(report.rows[1]!.overAnnualLimit).toBe(true);
  });

  it("a declared-pregnant worker's reads are compared with the 1 mSv foetal limit", async () => {
    await withTx(db, (tx) => declarePregnancy(tx, rso, { userId: rina, declaredOn: "2026-05-01", expectedOn: "2026-12-20" }, { now: new Date("2026-07-20T06:00:00Z") }));
    /** 1.5 mSv over 1 Apr–30 Jun; 61 of 91 days after the declaration → ~1.005 mSv, at the limit. */
    const csv = "Badge No,Period From,Period To,Hp(10)\nJH-40119,01/04/2026,30/06/2026,1.5\nJH-40118,01/04/2026,30/06/2026,1.5\n";
    const report = await run(csv, true);
    expect(report.rows[0]!.overFoetalLimit).toBe(true);
    expect(report.rows[0]!.warnings.join(" ")).toContain("foetal limit");
    expect(report.rows[1]!.overFoetalLimit).toBe(false);
    const written = await run(csv, false);
    expect(written.imported).toBe(2);
  });
});
