import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  deskAndLabel, grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labParkedResults, labResults, labSpecimens,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { LabError } from "./errors";
import {
  discardParkedResult, inbox, inboxCounts, LAB_INSTRUMENTS_OPERATE, matchParkedResult,
  rejectedPlates,
} from "./inbox";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import { LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument } from "./instruments";
import { openPlateMap, scanIntoPlateMap } from "./plate-maps";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ 17-E T6 — THE INTERFACE INBOX ═══
 *
 * Abha Rani's seat: the results that could not be named, with their raw payload and the machine that
 * sent them. Two things may happen to a row and there is deliberately no third — a human NAMES the
 * tube, or DISCARDS it with a reason.
 *
 * The suite is mostly about what the seat may NOT do. A screen that resolves rows is the softest
 * door in this phase, and it is the door somebody reaches for precisely when a result is already
 * confusing, so every guard the machine met has to meet the human too.
 */
describe("17-E T6 — the interface inbox", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let bridge: Awaited<ReturnType<typeof mkUser>>;
  let operator: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    await grantPermissionToRole(db, fx.registry, "lab_technician", LAB_INSTRUMENTS_OPERATE);
    await ensureRole(db, "lab_bridge");
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_INSTRUMENTS_READ);
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_RESULTS_INTERFACE);
    bridge = await mkUser(db, "lab.bridge", ["lab_bridge"]);
    /** The bench seat: it holds `lab.results.enter` AND the new operate grant, as seed-roles gives it. */
    operator = await mkUser(db, "abha.rani", ["lab_technician", "phlebotomist"]);
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "CHEM-1", name: "chemistry analyser", sampleIdMode: "barcode",
    }));
  });
  afterEach(() => { fx.unregister(); });

  async function analyteOf(code: string): Promise<string> {
    const [a] = await db
      .select({ id: labAnalytes.id })
      .from(labOrderables)
      .innerJoin(labOrderableAnalytes, eq(labOrderableAnalytes.serviceId, labOrderables.serviceId))
      .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
      .where(eq(labOrderables.serviceId, serviceIdForLabCode(code)));
    return a!.id;
  }

  /** A received tube, and a transmission that could not name it — so one row lands in the inbox. */
  async function parkedRowFor(code: string, machineCode: string): Promise<{ parkedId: string; specimenNo: string }> {
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: machineCode, analyteId: await analyteOf(code),
    });
    const { specimens } = await deskAndLabel(db, fx, [code]);
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    /** The bridge sends a sample id nobody can resolve — the ordinary way a row parks. */
    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: `run-${machineCode}`,
      rows: [{ position: 1, sampleId: "S-UNREADABLE", code: machineCode, value: "5.4" }],
    });
    expect(out.parked).toHaveLength(1);
    const [row] = await db.select().from(labParkedResults);
    return { parkedId: row!.id, specimenNo: specimens[0]!.specimenNo };
  }

  it("lists what is waiting, with the machine and OUR arrival clock, and counts it", async () => {
    const { parkedId } = await parkedRowFor("CBC", "GLU");
    const rows = await inbox(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: parkedId, instrumentCode: "CHEM-1", instrumentName: "chemistry analyser",
      rawValue: "5.4", reason: "unknown_sample", sampleId: "S-UNREADABLE",
    });
    expect(rows[0]!.arrivedAt).toBeInstanceOf(Date);
    expect(await inboxCounts(db)).toEqual([{ instrumentId, waiting: 1 }]);
  });

  it("a hand match names the tube, writes the result, and closes the row", async () => {
    const { parkedId, specimenNo } = await parkedRowFor("CBC", "GLU");
    const { resultId } = await matchParkedResult(db, operator.actor, { parkedResultId: parkedId, specimenNo });

    const [result] = await db.select().from(labResults).where(eq(labResults.id, resultId));
    /**
     * `manual_from_printout`, NOT `interface`. The interface failed to name this tube — that is why
     * the row was in the inbox — and a person decided whose it was. Recording it as `interface`
     * would hide the one human judgement in the chain, and it is the judgement most likely to be
     * wrong. `analyzer_id` still names the machine, so nothing about its authorship is lost.
     */
    expect([result!.entryMode, result!.analyzerId]).toEqual(["manual_from_printout", instrumentId]);
    expect(result!.remarks).toMatch(/matched by hand from the interface inbox/);

    const [row] = await db.select().from(labParkedResults).where(eq(labParkedResults.id, parkedId));
    expect([row!.status, row!.resolvedBy]).toEqual(["matched", operator.id]);
    expect(await inbox(db)).toEqual([]);
  });

  /**
   * ═══ MUTANT — A HAND MATCH THAT BYPASSES THE APPLICABILITY GUARD ═══
   *
   * The whole reason the match calls `attachMachineValue` rather than writing its own insert. A tube
   * with no open item for the analyte cannot carry the value, and the seat must not be the place
   * where that stops being true. The row stays PARKED: the human learned something and the row must
   * remain in front of them rather than being closed on a write that never happened.
   */
  it("MUTANT: a match the guards refuse writes NOTHING and leaves the row in the inbox", async () => {
    const { parkedId } = await parkedRowFor("CBC", "GLU");
    /** A DIFFERENT tube, carrying LFT — it has no open item for the CBC analyte the code maps to. */
    const { specimens } = await deskAndLabel(db, fx, ["LFT"]);
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }

    /**
     * NAMED, not merely `LabError`. This assertion previously accepted ANY LabError and so passed
     * on `permission_denied` — the operator lacked a grant and the test reported the applicability
     * guard working. A refusal test that does not name its refusal cannot tell the guard it is about
     * from the four other reasons the same call can fail.
     *
     * `unknown_analyte` is the TRUE refusal here and the seat is told it verbatim: the instrument's
     * code maps to an analyte this tube's order does not carry. The ingest collapses every refusal
     * to `guard_refused` because it only needs to know a human must look; a human at the screen needs
     * to know WHICH control refused, because the next action differs for each.
     */
    await expect(matchParkedResult(db, operator.actor, {
      parkedResultId: parkedId, specimenNo: specimens[0]!.specimenNo,
    })).rejects.toMatchObject({ code: "unknown_analyte" });

    expect(await db.select().from(labResults)).toHaveLength(0);
    const [row] = await db.select().from(labParkedResults).where(eq(labParkedResults.id, parkedId));
    expect([row!.status, row!.resolvedBy, row!.resolvedAt]).toEqual(["parked", null, null]);
    expect(await inbox(db)).toHaveLength(1);
  });

  /**
   * ═══ MUTANT — A PARKED RESULT ATTACHED TO ANOTHER DAY'S TUBE ═══
   *
   * The largest class of plausible-but-wrong pairings a person can make from this screen. A run that
   * arrived this morning cannot contain a reading from a tube received last Tuesday; that tube was
   * analysed, reported and disposed of on its own day.
   */
  it("MUTANT: a tube received on another day is refused, and named as another day", async () => {
    const { parkedId, specimenNo } = await parkedRowFor("CBC", "GLU");
    /** Age the tube by a week. Nothing else about it changes — it is still `received`. */
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.update(labSpecimens).set({ receivedAt: weekAgo }).where(eq(labSpecimens.specimenNo, specimenNo));

    await expect(matchParkedResult(db, operator.actor, { parkedResultId: parkedId, specimenNo }))
      .rejects.toThrow(/another day's tube/);
    expect(await db.select().from(labResults)).toHaveLength(0);
  });

  /**
   * ═══ MUTANT — A DISCARD WITH AN EMPTY REASON ═══
   *
   * The board: *"the result is discarded WITH A REASON"*. A number that came off an analyser and
   * vanished on a Tuesday with nothing to show is not a record, and whitespace is not a reason.
   */
  it("MUTANT: a discard names why, and blank or whitespace is refused", async () => {
    const { parkedId } = await parkedRowFor("CBC", "GLU");
    for (const reason of ["", "   ", "\t\n"]) {
      await expect(discardParkedResult(db, operator.actor, { parkedResultId: parkedId, reason }))
        .rejects.toThrow(LabError);
    }
    const [still] = await db.select().from(labParkedResults).where(eq(labParkedResults.id, parkedId));
    expect(still!.status).toBe("parked");

    await discardParkedResult(db, operator.actor, {
      parkedResultId: parkedId, reason: "control tube from the QC rack, not a patient",
    });
    const [row] = await db.select().from(labParkedResults).where(eq(labParkedResults.id, parkedId));
    /** DISCARDED, never DELETED — the row and its raw payload are still there to be read. */
    expect([row!.status, row!.discardReason, row!.resolvedBy])
      .toEqual(["discarded", "control tube from the QC rack, not a patient", operator.id]);
    expect(row!.rawValue).toBe("5.4");
    expect(await inbox(db)).toEqual([]);
  });

  it("a resolved row cannot be resolved twice, in either direction", async () => {
    const { parkedId, specimenNo } = await parkedRowFor("CBC", "GLU");
    await discardParkedResult(db, operator.actor, { parkedResultId: parkedId, reason: "QC rack" });
    await expect(matchParkedResult(db, operator.actor, { parkedResultId: parkedId, specimenNo }))
      .rejects.toThrow(LabError);
    await expect(discardParkedResult(db, operator.actor, { parkedResultId: parkedId, reason: "again" }))
      .rejects.toThrow(LabError);
  });

  /**
   * The BRIDGE holds `lab.results.interface` and must never resolve the rows its own transmission
   * parked: a machine account that could name the tube could name any tube it liked, which is the
   * authority this whole phase withholds from it.
   */
  it("the bridge cannot work the inbox, and neither can an agent", async () => {
    const { parkedId, specimenNo } = await parkedRowFor("CBC", "GLU");
    await expect(matchParkedResult(db, bridge.actor, { parkedResultId: parkedId, specimenNo }))
      .rejects.toThrow(LabError);
    await expect(discardParkedResult(db, bridge.actor, { parkedResultId: parkedId, reason: "x" }))
      .rejects.toThrow(LabError);
    await expect(matchParkedResult(db, { type: "agent", id: newId() }, { parkedResultId: parkedId, specimenNo }))
      .rejects.toThrow(LabError);
  });

  /**
   * ═══ D13 — THE SEAT SEES A REJECTED PLATE, AND THE INBOX DELIBERATELY DOES NOT LIST IT ═══
   *
   * A controls-failed plate parks NOTHING, so without this read the rejection would be invisible to
   * the person whose job it is to act on it. Both halves are asserted together on purpose: the
   * absence from the inbox is not an oversight, and the presence in `rejectedPlates` is what makes
   * the absence safe.
   */
  it("D13: a controls-failed plate is NOT in the inbox and IS in the rejected-plate read", async () => {
    const { instrumentId: reader } = await registerInstrument(db, fx.pathologist.actor, {
      code: "ELISA-1", name: "ELISA reader", sampleIdMode: "plate_map",
    });
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId: reader, instrumentCode: "HBSAG_OD", analyteId: await analyteOf("HBSAG"),
    });
    const { specimens } = await deskAndLabel(db, fx, ["HBSAG"]);
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    const { plateMapId } = await openPlateMap(db, fx.bench.actor, {
      instrumentId: reader, plateRef: "P-1", assay: "HBsAg", kitLot: "K2409",
      cutoffMultiplier: 3, cutoffOffset: 0, minPcNcRatio: 5, maxNcOd: 0.15,
    });
    for (const w of [
      { well: "B1", role: "negative_control" as const }, { well: "C1", role: "negative_control" as const },
      { well: "D1", role: "positive_control" as const }, { well: "E1", role: "positive_control" as const },
    ]) await scanIntoPlateMap(db, fx.bench.actor, { plateMapId, ...w });
    await scanIntoPlateMap(db, fx.bench.actor, {
      plateMapId, well: "F1", role: "patient", specimenNo: specimens[0]!.specimenNo,
    });

    /** Negative controls at 0.20 against a kit maximum of 0.15 — the plate is void. */
    const out = await ingestResults(db, bridge.actor, {
      instrumentId: reader, transmissionRef: "plate-dirty",
      rows: [["B1", "0.190"], ["C1", "0.210"], ["D1", "1.2"], ["E1", "1.4"], ["F1", "2.5"]]
        .map(([well, value], i) => ({ position: i + 1, sampleId: well!, code: "HBSAG_OD", value: value! })),
    });
    expect(out.plate!.status).toBe("controls_failed");

    /** NOT in the inbox — there is nothing here for a human to name, and offering it would invite harm. */
    expect(await inbox(db, { instrumentId: reader })).toEqual([]);
    /** But visible, with the figures that condemned it. */
    const plates = await rejectedPlates(db, { instrumentId: reader });
    expect(plates).toHaveLength(1);
    expect(plates[0]).toMatchObject({ plateMapId, plateRef: "P-1", assay: "HBsAg", kitLot: "K2409" });
    expect(plates[0]!.reason).toMatch(/negative control mean OD/);
    expect(plates[0]!.ncMeanOd).toBe("0.2000");
  });
});
