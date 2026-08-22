import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import {
  OPERATING_MODES, configValidationReports, downtimeFormCounters, downtimeKitRanges, downtimeKits,
  interfaces, operatingModeChanges,
} from "./ops";
import type { Db } from "../client";

const ACTOR = "01HDUTYMANAGER000000000001";
const AT = new Date("2026-08-23T09:00:00.000Z");

describe("the ops tables (Plan 11c)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => {
    await teardown();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("names the five operating modes, commissioning first", async () => {
    expect([...OPERATING_MODES]).toEqual(["commissioning", "ramp", "normal", "degraded", "downtime"]);
  });

  // ─────────────────────────────── the ordering columns (§3.26) ───────────────────────────────

  /**
   * The property every "latest row" read in this plan depends on: `seq` is allocated by the
   * DATABASE in insertion order, so it is monotone even when the ids are not. Asserted by
   * execution rather than by reading the column type, because the type is the easy half.
   */
  it("seq bigserials populate ascending on every ops table that anything orders by", async () => {
    // Ids DESCEND while the rows are inserted, so an ascending seq cannot be an artefact of the
    // ids happening to sort the same way.
    for (const suffix of ["CCC", "BBB", "AAA"]) {
      await db.insert(operatingModeChanges).values({
        id: `01HOPSSEQ00000000000000${suffix}`, fromMode: "commissioning", toMode: "ramp",
        note: null, reportId: null, actorId: ACTOR, at: AT,
      });
      await db.insert(configValidationReports).values({
        id: `01HOPSRPT00000000000000${suffix}`, ok: true, scopes: {}, at: AT,
      });
      await db.insert(interfaces).values({
        id: `01HOPSIFC00000000000000${suffix}`, kind: "printer", name: `printer ${suffix}`,
      });
      await db.insert(downtimeKits).values({
        id: `01HOPSKIT00000000000000${suffix}`, generatedBy: ACTOR, generatedAt: AT,
      });
    }

    const seqsOf = (rows: { seq: number }[]): number[] => rows.map((r) => Number(r.seq));

    const modes = await db.select().from(operatingModeChanges).orderBy(operatingModeChanges.seq);
    const reports = await db.select().from(configValidationReports).orderBy(configValidationReports.seq);
    const ifaces = await db.select().from(interfaces).orderBy(interfaces.seq);
    const kits = await db.select().from(downtimeKits).orderBy(downtimeKits.seq);

    expect(seqsOf(modes)).toEqual([1, 2, 3]);
    expect(seqsOf(reports)).toEqual([1, 2, 3]);
    expect(seqsOf(ifaces)).toEqual([1, 2, 3]);
    expect(seqsOf(kits)).toEqual([1, 2, 3]);
    // …and seq order is genuinely NOT id order, in every one of them.
    expect(modes.map((r) => r.id.slice(-3))).toEqual(["CCC", "BBB", "AAA"]);
    expect(kits.map((r) => r.id.slice(-3))).toEqual(["CCC", "BBB", "AAA"]);
  });

  // ───────────────────────────────── operating_mode_changes ──────────────────────────────────

  it("round-trips a mode change, with note and report reference both nullable", async () => {
    await db.insert(operatingModeChanges).values([
      {
        id: "01HOPSMODE000000000000GATE", fromMode: "commissioning", toMode: "normal",
        note: null, reportId: "01HOPSRPT00000000000GREEN", actorId: ACTOR, at: AT,
      },
      {
        id: "01HOPSMODE000000000000DOWN", fromMode: "normal", toMode: "downtime",
        note: "UPS failure in the server room", reportId: null, actorId: ACTOR, at: AT,
      },
    ]);

    const rows = await db.select().from(operatingModeChanges).orderBy(operatingModeChanges.seq);
    expect(rows[0]!.note).toBeNull();
    expect(rows[0]!.reportId).toBe("01HOPSRPT00000000000GREEN");
    expect(rows[1]!.note).toBe("UPS failure in the server room");
    expect(rows[1]!.reportId).toBeNull();
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  it("accepts a report_id that names no report — it is a reference, not a foreign key", async () => {
    // Deliberate (see the file header): an FK here would drag `operating_mode_changes` into
    // whichever truncate group `config_validation_reports` sits in, and the reference is a
    // provenance note rather than a structural guarantee. The guard fills it from the row it
    // read, so it cannot be wrong in practice.
    await db.insert(operatingModeChanges).values({
      id: "01HOPSMODE00000000000ORPHN", fromMode: "commissioning", toMode: "ramp", note: null,
      reportId: "01HNOSUCHREPORT0000000001", actorId: ACTOR, at: AT,
    });
    expect(await db.select().from(operatingModeChanges)).toHaveLength(1);
  });

  // ─────────────────────────────── config_validation_reports ─────────────────────────────────

  it("round-trips a report with its per-scope detail as JSONB", async () => {
    const scopes = {
      tariff: { ok: false, caSigned: false, errors: ["no CA-signed version"] },
      billing: { ok: true, errors: [] },
    };
    await db.insert(configValidationReports).values({
      id: "01HOPSRPT0000000000000RED", ok: false, scopes, at: AT,
    });
    const rows = await db.select().from(configValidationReports);
    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.scopes).toEqual(scopes); // structural round-trip, not a stringified blob
  });

  // ───────────────────────────────────────── interfaces ──────────────────────────────────────

  it("defaults a new interface to never-seen, unknown and active", async () => {
    await db.insert(interfaces).values({
      id: "01HOPSIFC0000000000000NEW", kind: "printer", name: "OPD label printer",
      location: "OPD counter 1",
    });
    const rows = await db.select().from(interfaces);
    // `last_seen_at` NULL is NEVER SEEN, and it is a distinct state from `down` (D6 / V10).
    expect(rows[0]!.lastSeenAt).toBeNull();
    expect(rows[0]!.status).toBe("unknown");
    expect(rows[0]!.active).toBe(true);
    // Per-device staleness, defaulted: a label printer and a lab analyser go quiet differently.
    expect(rows[0]!.staleAfterMs).toBe(180_000);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("carries a per-device stale_after_ms that overrides the default", async () => {
    await db.insert(interfaces).values({
      id: "01HOPSIFC000000000000FAST", kind: "scanner", name: "records scanner", staleAfterMs: 30_000,
    });
    const rows = await db.select().from(interfaces);
    expect(rows[0]!.staleAfterMs).toBe(30_000);
  });

  // ───────────────────────────── downtime kits, ranges and counters ──────────────────────────

  const KIT = "01HOPSKIT0000000000000ONE";

  const seedKit = async (): Promise<void> => {
    await db.insert(downtimeKits).values({
      id: KIT, note: "night shift", generatedBy: ACTOR, generatedAt: AT,
    });
  };

  it("round-trips a kit and its inclusive serial ranges", async () => {
    await seedKit();
    await db.insert(downtimeKitRanges).values([
      { id: "01HOPSRNG000000000000REG1", kitId: KIT, desk: "front", formKind: "registration", startSerial: 1, endSerial: 50 },
      { id: "01HOPSRNG000000000000RCP1", kitId: KIT, desk: "front", formKind: "receipt", startSerial: 1, endSerial: 25 },
    ]);
    const rows = await db.select().from(downtimeKitRanges).orderBy(downtimeKitRanges.seq);
    expect(rows.map((r) => [r.formKind, r.startSerial, r.endSerial])).toEqual([
      ["registration", 1, 50],
      ["receipt", 1, 25],
    ]);
  });

  it("refuses a range naming a kit that does not exist — the one FK in this file", async () => {
    // A range whose kit id is a typo is paper nobody can reconcile, which is the exact failure
    // the serials exist to prevent.
    await expect(
      db.insert(downtimeKitRanges).values({
        id: "01HOPSRNG00000000000ORPHN", kitId: "01HNOSUCHKIT00000000000001", desk: "front",
        formKind: "registration", startSerial: 1, endSerial: 10,
      }),
    ).rejects.toThrow();
  });

  it("refuses a second range for the same kit, desk and form kind", async () => {
    await seedKit();
    await db.insert(downtimeKitRanges).values({
      id: "01HOPSRNG000000000000DUP1", kitId: KIT, desk: "front", formKind: "registration",
      startSerial: 1, endSerial: 10,
    });
    await expect(
      db.insert(downtimeKitRanges).values({
        id: "01HOPSRNG000000000000DUP2", kitId: KIT, desk: "front", formKind: "registration",
        startSerial: 11, endSerial: 20,
      }),
    ).rejects.toThrow();
    // A DIFFERENT desk on the same kit and kind is fine — that is the whole point of the column.
    await db.insert(downtimeKitRanges).values({
      id: "01HOPSRNG000000000000DUP3", kitId: KIT, desk: "billing", formKind: "registration",
      startSerial: 11, endSerial: 20,
    });
    expect(await db.select().from(downtimeKitRanges)).toHaveLength(2);
  });

  it("counters are keyed by form kind and start at 1", async () => {
    await db.insert(downtimeFormCounters).values({ formKind: "registration" });
    const rows = await db.select().from(downtimeFormCounters);
    expect(rows).toEqual([{ formKind: "registration", nextSerial: 1 }]);
    // The PK is the form kind: a second row for the same kind would be a second counter, and two
    // counters for one kind is precisely how overlapping serials happen.
    await expect(
      db.insert(downtimeFormCounters).values({ formKind: "registration", nextSerial: 99 }),
    ).rejects.toThrow();
  });

  // ──────────────────────────────── the truncate helper itself ───────────────────────────────

  it("truncateAll empties all six ops tables — the FK group included", async () => {
    await seedKit();
    await db.insert(downtimeKitRanges).values({
      id: "01HOPSRNG000000000000TRNC", kitId: KIT, desk: "front", formKind: "registration",
      startSerial: 1, endSerial: 10,
    });
    await db.insert(downtimeFormCounters).values({ formKind: "registration", nextSerial: 11 });
    await db.insert(operatingModeChanges).values({
      id: "01HOPSMODE00000000000TRNC", fromMode: "commissioning", toMode: "ramp", note: null,
      reportId: null, actorId: ACTOR, at: AT,
    });
    await db.insert(configValidationReports).values({
      id: "01HOPSRPT00000000000TRNC1", ok: true, scopes: {}, at: AT,
    });
    await db.insert(interfaces).values({ id: "01HOPSIFC00000000000TRNC1", kind: "other", name: "x" });

    // Postgres refuses to TRUNCATE a table an FK still POINTS AT unless the referencing table is
    // named in the SAME statement (§3.12/§3.35). If the kit group were split, this call throws.
    await truncateAll(db);

    expect(await db.select().from(downtimeKitRanges)).toEqual([]);
    expect(await db.select().from(downtimeKits)).toEqual([]);
    expect(await db.select().from(downtimeFormCounters)).toEqual([]);
    expect(await db.select().from(operatingModeChanges)).toEqual([]);
    expect(await db.select().from(configValidationReports)).toEqual([]);
    expect(await db.select().from(interfaces)).toEqual([]);
  });

  it("truncateAll restarts the ops sequences, so seq is comparable across tests", async () => {
    await db.insert(operatingModeChanges).values({
      id: "01HOPSMODE000000000000RST", fromMode: "commissioning", toMode: "ramp", note: null,
      reportId: null, actorId: ACTOR, at: AT,
    });
    await truncateAll(db);
    await db.insert(operatingModeChanges).values({
      id: "01HOPSMODE000000000000RS2", fromMode: "commissioning", toMode: "ramp", note: null,
      reportId: null, actorId: ACTOR, at: AT,
    });
    const rows = await db.select({ seq: operatingModeChanges.seq }).from(operatingModeChanges);
    expect(Number(rows[0]!.seq)).toBe(1);
  });
});
