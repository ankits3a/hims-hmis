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
  labAnalytes, labOrderableAnalytes, labOrderables, labResults, labRunSheets,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import { LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument } from "./instruments";
import { closeRunSheet, openRunSheet, runSheetContents, scanIntoRunSheet } from "./run-sheets";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ 17-E T4 — THE RUN SHEET, FOR A MACHINE THAT CAN ONLY COUNT ═══
 *
 * The board: *"before loading, Abha scans each cup in order and the sheet remembers strip 41 →
 * S2609010215. When the block arrives, every strip finds its patient. A sheet with a gap parks that
 * one result."*
 *
 * The whole suite is about the second sentence. A position names a result only inside the run that
 * produced it, so everything depends on the mapping existing beforehand and being exact — and on
 * there being NOTHING to fall back to when it is not.
 */
describe("17-E T4 — the run sheet", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let bridge: Awaited<ReturnType<typeof mkUser>>;
  const machineCodeFor: Record<string, string> = {};

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    await ensureRole(db, "lab_bridge");
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_INSTRUMENTS_READ);
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_RESULTS_INTERFACE);
    bridge = await mkUser(db, "lab.bridge", ["lab_bridge"]);
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "U120", name: "Mission U120 urine strips", sampleIdMode: "run_sheet",
    }));
    /**
     * TWO orderables, not one repeated: a second order of the same test for one patient is refused
     * by the duplicate guard (`duplicate_unacknowledged`), which is correct behaviour and not
     * something this suite should be acknowledging its way around. The fixture's
     * `NON_OVERLAPPING_PAIRS` exist for exactly this — CBC and LFT share no analyte, so each tube
     * carries its own, and the instrument gets a code for each.
     */
    for (const [code, machineCode] of [["CBC", "GLU"], ["LFT", "PRO"]] as const) {
      const [a] = await db
        .select({ id: labAnalytes.id })
        .from(labOrderables)
        .innerJoin(labOrderableAnalytes, eq(labOrderableAnalytes.serviceId, labOrderables.serviceId))
        .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
        .where(eq(labOrderables.serviceId, serviceIdForLabCode(code)));
      machineCodeFor[code] = machineCode;
      await mapInstrumentCode(db, fx.pathologist.actor, {
        instrumentId, instrumentCode: machineCode, analyteId: a!.id,
      });
    }
  });
  afterEach(() => { fx.unregister(); });

  /** Two received tubes, each carrying a DIFFERENT test, with the machine code that reads it. */
  async function twoTubes(): Promise<[{ no: string; code: string }, { no: string; code: string }]> {
    const out: { no: string; code: string }[] = [];
    for (const orderable of ["CBC", "LFT"] as const) {
      const { specimens } = await deskAndLabel(db, fx, [orderable]);
      for (const s of specimens) {
        await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
      }
      out.push({ no: specimens[0]!.specimenNo, code: machineCodeFor[orderable]! });
    }
    return [out[0]!, out[1]!];
  }

  it("a scanned sheet turns positions into patients when the block lands", async () => {
    const [t41, t42] = await twoTubes();
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-7" });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 41, specimenNo: t41.no });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 42, specimenNo: t42.no });

    expect((await runSheetContents(db, runSheetId)).map((r) => [r.position, r.specimenNo]))
      .toEqual([[41, t41.no], [42, t42.no]]);

    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "u120-run-7",
      rows: [{ position: 41, code: t41.code, value: "5.0" }, { position: 42, code: t42.code, value: "6.0" }],
    });
    expect(out.attached.map((a) => a.position).sort()).toEqual([41, 42]);
    expect(out.parked).toEqual([]);
    expect(await db.select().from(labResults)).toHaveLength(2);
  });

  /**
   * ═══ THE MUTANT THIS WHOLE TASK EXISTS FOR: A GAP RESOLVING TO ITS NEIGHBOUR ═══
   *
   * A hole at strip 43 means nobody scanned strip 43, and the tube physically in that slot is
   * UNKNOWN. Reading it as 42's patient — or as "the only unscanned cup" — is the swapped tube the
   * sheet exists to prevent, and it would be invisible: a plausible number on the wrong person.
   */
  it("a GAP parks that position and ONLY that position — it never falls through to a neighbour", async () => {
    const [t41, t43] = await twoTubes();
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-8" });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 41, specimenNo: t41.no });
    /** 42 is deliberately never scanned. 43 is. */
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 43, specimenNo: t43.no });

    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "u120-run-8",
      rows: [
        { position: 41, code: t41.code, value: "5.0" },
        { position: 42, code: t41.code, value: "6.0" },
        { position: 43, code: t43.code, value: "7.0" },
      ],
    });

    expect(out.attached.map((a) => a.position).sort()).toEqual([41, 43]);
    expect(out.parked).toEqual([{ position: 42, reason: "no_run_sheet" }]);

    /** THE KILL: 42's value must not have been written against 41's or 43's specimen. */
    const rows = await db.select().from(labResults);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.valueNumeric).sort()).toEqual(["5.0000", "7.0000"]);
    expect(rows.map((r) => r.valueNumeric)).not.toContain("6.0000");
  });

  /**
   * MUTANT — TWO OPEN SHEETS ON ONE MACHINE. Then "position 4" has two answers and the ingest picks
   * by row order. Enforced by a partial unique index, not by a code check: a read-then-write here
   * is what 17d §9.2 cost.
   */
  it("refuses a SECOND open sheet on one instrument, and the database is what refuses", async () => {
    await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-A" });
    await expect(openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-B" }))
      .rejects.toMatchObject({ code: "no_active_order" });
    expect(await db.select().from(labRunSheets)).toHaveLength(1);
  });

  /** MUTANT — accept a position past the end of the sheet. An absent row is a park, not a guess. */
  it("parks a position the sheet never had", async () => {
    const [t41] = await twoTubes();
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-9" });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 41, specimenNo: t41.no });
    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "u120-run-9",
      rows: [{ position: 99, code: t41.code, value: "5.0" }],
    });
    expect(out.parked).toEqual([{ position: 99, reason: "no_run_sheet" }]);
    expect(await db.select().from(labResults)).toHaveLength(0);
  });

  /**
   * MUTANT — REUSE A CLOSED SHEET. Once the block has landed, the sheet's positions describe cups
   * that are no longer on the machine. A second block is a NEW run whose sheet nobody built, and
   * resolving it against the old map would report this run's numbers against last run's patients.
   */
  it("closes the sheet with the block that consumed it; a second block parks WHOLE", async () => {
    const [t41] = await twoTubes();
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-10" });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 41, specimenNo: t41.no });

    const first = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "u120-run-10a",
      rows: [{ position: 41, code: t41.code, value: "5.0" }],
    });
    expect(first.attached).toHaveLength(1);

    const [sheet] = await db.select().from(labRunSheets).where(eq(labRunSheets.id, runSheetId));
    expect([sheet!.status, sheet!.closedByTransmissionId]).toEqual(["closed", first.transmissionId]);

    /** A SECOND run, a different transmission, the same positions — and no sheet to read them by. */
    const second = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "u120-run-10b",
      rows: [{ position: 41, code: t41.code, value: "9.9" }],
    });
    expect(second.parked).toEqual([{ position: 41, reason: "no_run_sheet" }]);
    /** THE KILL: the second run's number written against the first run's patient. */
    expect(await db.select().from(labResults)).toHaveLength(1);
  });

  it("a block with NO sheet loaded parks every row rather than guessing", async () => {
    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "u120-no-sheet",
      rows: [{ position: 1, code: "GLU", value: "5.0" }, { position: 2, code: "GLU", value: "6.0" }],
    });
    expect(out.attached).toEqual([]);
    expect(out.parked.map((p) => p.reason)).toEqual(["no_run_sheet", "no_run_sheet"]);
  });

  /**
   * THE BRIDGE CONSUMES A SHEET AND CAN NEVER AUTHOR ONE. A machine that could write the mapping
   * could name any tube it liked — which is the whole authority the design withholds from it.
   */
  it("the bridge cannot build a sheet; the bench can", async () => {
    await expect(openRunSheet(db, bridge.actor, { instrumentId, runRef: "sheet-X" }))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(openRunSheet(db, { type: "agent", id: newId() }, { instrumentId, runRef: "sheet-Y" }))
      .rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("re-scanning a position REPLACES the cup — a swap before loading is ordinary", async () => {
    const [t41, t42] = await twoTubes();
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-11" });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 41, specimenNo: t41.no });
    await scanIntoRunSheet(db, fx.bench.actor, { runSheetId, position: 41, specimenNo: t42.no });
    const rows = await runSheetContents(db, runSheetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.specimenNo).toBe(t42.no);
  });

  it("a run sheet belongs only to a machine that reports a position", async () => {
    const { instrumentId: chem } = await registerInstrument(db, fx.pathologist.actor, {
      code: "CHEM-1", name: "Chemistry", sampleIdMode: "barcode",
    });
    await expect(openRunSheet(db, fx.bench.actor, { instrumentId: chem, runRef: "nope" }))
      .rejects.toMatchObject({ code: "unknown_instrument" });
  });

  it("an unreceived tube cannot be scanned onto the rack", async () => {
    const { specimens } = await deskAndLabel(db, fx, ["CBC"]); // labelled, never received
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-12" });
    await expect(scanIntoRunSheet(db, fx.bench.actor, {
      runSheetId, position: 1, specimenNo: specimens[0]!.specimenNo,
    })).rejects.toMatchObject({ code: "specimen_not_receivable" });
  });

  it("closeRunSheet is idempotent — closing a closed sheet changes nothing", async () => {
    const { runSheetId } = await openRunSheet(db, fx.bench.actor, { instrumentId, runRef: "sheet-13" });
    await closeRunSheet(db, runSheetId, "t-1");
    await closeRunSheet(db, runSheetId, "t-2");
    const [sheet] = await db.select().from(labRunSheets).where(eq(labRunSheets.id, runSheetId));
    expect(sheet!.closedByTransmissionId).toBe("t-1");
  });
});
