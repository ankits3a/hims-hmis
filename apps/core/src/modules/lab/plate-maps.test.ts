import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import {
  grantLabResultPermissions, seedLabDeskBase, serviceIdForLabCode,
} from "../../../test/helpers/lab";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import {
  labAnalytes, labOrderableAnalytes, labOrderables, labPlateMaps, labPlateWells, labResults,
  labSpecimens, patients,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { collect } from "./collection";
import { deskOrder } from "./desk";
import { LabError } from "./errors";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import { LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument } from "./instruments";
import {
  evaluatePlateControls, openPlateMap, plateContents, scanIntoPlateMap,
} from "./plate-maps";
import { printLabels } from "./specimens";
import type { PlateWellRole } from "./plate-maps";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ 17-E T5 — THE PLATE MAP, AND THE CONTROLS THAT CAN VOID IT ═══
 *
 * The board: *"The reader sends 96 optical densities and nothing else. The cut-off is computed from
 * the controls; a plate whose controls fail is rejected whole, and no patient gets a result from it.
 * Reactive screens are repeated before anyone is told."*
 *
 * Every test here is about one of four ways this could report a number that is not a person's:
 * a cut-off borrowed from a plate that is not this one, a patient released off a void plate, a
 * control read as a patient, and a first-run reactive told to somebody before it was repeated.
 *
 * ═══ THE KIT'S NUMBERS ARE CHOSEN SO THE ARITHMETIC IS VISIBLE ═══
 *
 * `multiplier 3, offset 0` makes the cut-off exactly three times the negative-control mean, so a
 * test that changes the controls and expects the verdict to move is asserting the DEPENDENCE and not
 * a coincidence. A kit whose offset dominated would hide exactly the mutant this task is about.
 */
const KIT = { cutoffMultiplier: 3, cutoffOffset: 0, minPcNcRatio: 5, maxNcOd: 0.15 };

describe("17-E T5 — the plate map", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let hbsagAnalyteId: string;
  let bridge: Awaited<ReturnType<typeof mkUser>>;
  const MACHINE_CODE = "HBSAG_OD";

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
      code: "EL-READER", name: "ELISA microplate reader", sampleIdMode: "plate_map",
    }));
    /**
     * HBsAg is a `coded` analyte in the catalogue, which is what a qualitative screen IS — and the
     * reason this suite can assert the word a report carries rather than an optical density.
     */
    const [a] = await db
      .select({ id: labAnalytes.id })
      .from(labOrderables)
      .innerJoin(labOrderableAnalytes, eq(labOrderableAnalytes.serviceId, labOrderables.serviceId))
      .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
      .where(eq(labOrderables.serviceId, serviceIdForLabCode("HBSAG")));
    hbsagAnalyteId = a!.id;
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: MACHINE_CODE, analyteId: hbsagAnalyteId,
    });
  });
  afterEach(() => { fx.unregister(); });

  /**
   * A received HBsAg tube for ONE named person. A real plate is ninety-two different patients, so
   * the two wells this suite uses belong to two different people rather than to one person ordering
   * the same screen twice — which the duplicate guard would rightly refuse.
   */
  async function receivedTube(patientId: string, encounterNo: string): Promise<string> {
    const placed = await withTx(db, (tx) => deskOrder(tx, fx.desk.actor, fx.decls, {
      patientId, encounterNo, serviceDate: fx.serviceDate,
      orderingClinicianId: fx.pathologist.id, credit: { reason: "counter order" },
      items: [{ serviceId: serviceIdForLabCode("HBSAG") }],
    }));
    const [patient] = await db.select().from(patients).where(eq(patients.id, patientId));
    const { specimens } = await printLabels(db, fx.bench.actor, {
      orderGroupId: placed.orderGroupId, scannedUhid: patient!.uhid,
    });
    for (const s of specimens) {
      await withTx(db, (tx) => collect(tx, fx.bench.actor, { specimenId: s.specimenId, wristbandScanned: true }));
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    return specimens[0]!.specimenNo;
  }

  const tubeA = (): Promise<string> => receivedTube(fx.patientId, fx.encounterNo);
  const tubeB = (): Promise<string> => receivedTube(fx.otherPatientId, fx.otherEncounterNo);

  /** Lays out a plate: the wells in order, the roles they hold, the tubes the patient wells carry. */
  async function layOut(
    wells: readonly { well: string; role: PlateWellRole; specimenNo?: string }[],
    over: Partial<typeof KIT> & { plateRef?: string } = {},
  ): Promise<string> {
    const { plateMapId } = await openPlateMap(db, fx.bench.actor, {
      instrumentId, plateRef: over.plateRef ?? "P-1", assay: "HBsAg", kitLot: "K2409",
      ...KIT, ...over,
    });
    for (const w of wells) {
      await scanIntoPlateMap(db, fx.bench.actor, {
        plateMapId, well: w.well, role: w.role, specimenNo: w.specimenNo ?? null,
      });
    }
    return plateMapId;
  }

  /** The block the reader transmits: the WELL is how it names a sample, in `sampleId`. */
  function block(
    ref: string, reads: readonly (readonly [string, string])[],
  ): Parameters<typeof ingestResults>[2] {
    return {
      instrumentId, transmissionRef: ref,
      rows: reads.map(([well, value], i) => ({ position: i + 1, sampleId: well, code: MACHINE_CODE, value })),
    };
  }

  /** The controls every good plate in this suite carries: nc mean 0.05, pc mean 1.30, ratio 26. */
  const GOOD_CONTROLS = [
    ["A1", "0.010"], ["B1", "0.040"], ["C1", "0.060"], ["D1", "1.200"], ["E1", "1.400"],
  ] as const;
  const CONTROL_WELLS = [
    { well: "A1", role: "blank" as const },
    { well: "B1", role: "negative_control" as const },
    { well: "C1", role: "negative_control" as const },
    { well: "D1", role: "positive_control" as const },
    { well: "E1", role: "positive_control" as const },
  ];

  it("a laid-out plate turns wells into people, and the cut-off comes from its own controls", async () => {
    const [a, b] = [await tubeA(), await tubeB()];
    const plateMapId = await layOut([
      ...CONTROL_WELLS,
      { well: "F1", role: "patient", specimenNo: a },
      { well: "G1", role: "patient", specimenNo: b },
    ]);

    /** nc mean 0.05 × 3 = cut-off 0.15. F1 at 0.05 is S/CO 0.33; G1 at 0.90 is S/CO 6.00. */
    const out = await ingestResults(db, bridge.actor, block("elisa-1", [
      ...GOOD_CONTROLS, ["F1", "0.050"], ["G1", "0.900"],
    ]));

    expect(out.parked).toEqual([]);
    expect(out.attached).toHaveLength(2);
    expect(out.plate).toMatchObject({ status: "read", reason: null });
    /**
     * The floats are compared with a tolerance and the STORED figures below are compared exactly.
     * That split is the honest one: `0.04 + 0.06` is 0.10000000000000001 in IEEE-754 and a mean
     * taken in a different but equally correct order lands on a different last bit, whereas what
     * the plate WRITES DOWN is rounded to the four decimals the column holds and is exact.
     */
    expect(out.plate!.cutoffOd).toBeCloseTo(0.15, 6);
    expect(out.plate!.ncMeanOd).toBeCloseTo(0.05, 6);
    expect(out.plate!.pcMeanOd).toBeCloseTo(1.3, 6);

    /** THE CONTROLS AND THE BLANK PRODUCE NO RESULT — five of the seven wells report nothing. */
    const results = await db.select().from(labResults);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.valueCoded).sort()).toEqual(["Non-Reactive", "Reactive"]);
    expect(results.every((r) => r.entryMode === "interface" && r.analyzerId === instrumentId)).toBe(true);

    const [plate] = await db.select().from(labPlateMaps).where(eq(labPlateMaps.id, plateMapId));
    expect([plate!.status, plate!.cutoffOd, plate!.controlsFailReason]).toEqual(["read", "0.1500", null]);

    const wells = await plateContents(db, plateMapId);
    expect(wells.map((w) => [w.well, w.verdict])).toEqual([
      ["A1", null], ["B1", "control_ok"], ["C1", "control_ok"], ["D1", "control_ok"], ["E1", "control_ok"],
      ["F1", "non_reactive"], ["G1", "reactive"],
    ]);
  });

  /**
   * ═══ MUTANT 1 — THE CUT-OFF BORROWED FROM ANOTHER PLATE ═══
   *
   * The same optical density, 0.100, read on two plates whose negative controls differ. On the first
   * the cut-off is 0.150 and 0.100 is NON-REACTIVE; on the second the controls are cleaner, the
   * cut-off is 0.045, and the identical number is REACTIVE. A cut-off cached, hard-coded, or taken
   * from the previous plate would make these two answers agree — and one of the two patients would
   * be told the wrong thing about hepatitis B.
   */
  it("MUTANT: the same OD is reactive on one plate and not on another, because the controls differ", async () => {
    const a = await tubeA();
    const first = await layOut([...CONTROL_WELLS, { well: "F1", role: "patient", specimenNo: a }]);
    const out1 = await ingestResults(db, bridge.actor, block("elisa-lowclean", [
      ...GOOD_CONTROLS, ["F1", "0.100"],
    ]));
    expect(out1.plate!.cutoffOd).toBeCloseTo(0.15, 6);
    expect((await plateContents(db, first)).find((w) => w.well === "F1")!.verdict).toBe("non_reactive");

    /** A SECOND plate on the same reader — the first is read, so a new one may be laid out. */
    const b = await tubeB();
    const second = await layOut([
      { well: "A1", role: "blank" },
      { well: "B1", role: "negative_control" }, { well: "C1", role: "negative_control" },
      { well: "D1", role: "positive_control" }, { well: "E1", role: "positive_control" },
      { well: "F1", role: "patient", specimenNo: b },
    ], { plateRef: "P-2" });
    const out2 = await ingestResults(db, bridge.actor, block("elisa-cleaner", [
      ["A1", "0.005"], ["B1", "0.010"], ["C1", "0.020"], ["D1", "1.200"], ["E1", "1.400"],
      ["F1", "0.100"],
    ]));

    expect(out2.plate!.cutoffOd).toBeCloseTo(0.045, 4);
    expect((await plateContents(db, second)).find((w) => w.well === "F1")!.verdict).toBe("reactive");

    const values = (await db.select().from(labResults)).map((r) => r.valueCoded).sort();
    expect(values).toEqual(["Non-Reactive", "Reactive"]);
  });

  /**
   * ═══ MUTANT 2 — A PATIENT RELEASED OFF A VOID PLATE (D10) ═══
   *
   * The negative controls read 0.200 against a kit maximum of 0.150: the plate is contaminated or
   * under-washed and every number on it is meaningless. Not one patient well produces a result — and
   * nothing parks either, because T6's inbox exists so a human can NAME an unidentified number and
   * attach it, which is precisely the action that must be impossible here. The plate row is the
   * whole record of the rejection, and it keeps every optical density that produced the verdict.
   */
  it("MUTANT: a plate whose controls fail releases NOTHING — not a result and not an inbox row", async () => {
    const [a, b] = [await tubeA(), await tubeB()];
    const plateMapId = await layOut([
      ...CONTROL_WELLS,
      { well: "F1", role: "patient", specimenNo: a },
      { well: "G1", role: "patient", specimenNo: b },
    ]);

    const out = await ingestResults(db, bridge.actor, block("elisa-dirty", [
      ["A1", "0.010"], ["B1", "0.190"], ["C1", "0.210"], ["D1", "1.200"], ["E1", "1.400"],
      /** A frankly reactive well: on a valid plate this WOULD have been released. */
      ["F1", "0.050"], ["G1", "2.500"],
    ]));

    expect(out.attached).toEqual([]);
    expect(out.parked).toEqual([]);
    expect(await db.select().from(labResults)).toHaveLength(0);
    expect(out.plate!.status).toBe("controls_failed");
    expect(out.plate!.ncMeanOd).toBeCloseTo(0.2, 6);
    expect(out.plate!.reason).toMatch(/negative control mean OD/);

    const [plate] = await db.select().from(labPlateMaps).where(eq(labPlateMaps.id, plateMapId));
    expect(plate!.status).toBe("controls_failed");
    expect(plate!.controlsFailReason).not.toBeNull();
    /** THE FIGURES SURVIVE THE REJECTION — a void plate is still a record, and NABL asks. */
    expect([plate!.ncMeanOd, plate!.pcMeanOd, plate!.cutoffOd]).toEqual(["0.2000", "1.3000", "0.6000"]);

    const wells = await plateContents(db, plateMapId);
    const g1 = wells.find((w) => w.well === "G1")!;
    expect([g1.od, g1.verdict, g1.repeatRequired]).toEqual(["2.5000", null, false]);
    expect(wells.find((w) => w.well === "B1")!.verdict).toBe("control_failed");
  });

  /**
   * ═══ MUTANT 3 — A CONTROL REPORTED AS A PATIENT ═══
   *
   * The biconditional is a database CHECK and not a convention, so this proves it the only way an
   * absence can be proved: by trying to ADD the forbidden thing. The service refuses in a sentence
   * the bench can act on; the constraint refuses anything that goes round the service.
   */
  it("MUTANT: a control can never carry a tube, at the service and at the constraint", async () => {
    const a = await tubeA();
    const { plateMapId } = await openPlateMap(db, fx.bench.actor, {
      instrumentId, plateRef: "P-1", assay: "HBsAg", kitLot: "K2409", ...KIT,
    });

    await expect(scanIntoPlateMap(db, fx.bench.actor, {
      plateMapId, well: "B1", role: "negative_control", specimenNo: a,
    })).rejects.toThrow(LabError);
    /** And the mirror: a patient well with no tube is a well nobody can report. */
    await expect(scanIntoPlateMap(db, fx.bench.actor, {
      plateMapId, well: "F1", role: "patient",
    })).rejects.toThrow(LabError);

    const [specimenRow] = await db.select().from(labPlateWells).where(eq(labPlateWells.plateMapId, plateMapId));
    expect(specimenRow).toBeUndefined();

    /**
     * ═══ STRAIGHT PAST THE SERVICE, AT THE TABLE ═══
     *
     * The tube is a REAL one. An invented id would be refused by the FOREIGN KEY to `lab_specimens`
     * whether or not the biconditional exists, so the assertion would pin the wrong layer and stay
     * green with the CHECK deleted — which is exactly what a mutant that drops the constraint
     * proved when this test used `newId()`.
     */
    const [tube] = await db.select({ id: labSpecimens.id })
      .from(labSpecimens).where(eq(labSpecimens.specimenNo, a));
    await expect(db.insert(labPlateWells).values({
      plateMapId, well: "B2", role: "positive_control", specimenId: tube!.id,
      scannedAt: new Date(), scannedBy: fx.bench.id,
    })).rejects.toThrow(/lab_plate_wells_specimen_ck/);

    /**
     * And the half no foreign key could ever cover: a PATIENT well with no tube. Nothing but the
     * biconditional can refuse a null here, so this direction names the constraint on its own.
     */
    await expect(db.insert(labPlateWells).values({
      plateMapId, well: "B3", role: "patient", specimenId: null,
      scannedAt: new Date(), scannedBy: fx.bench.id,
    })).rejects.toThrow(/lab_plate_wells_specimen_ck/);
  });

  /**
   * ═══ MUTANT 4 — A REACTIVE SCREEN TOLD TO SOMEBODY BEFORE IT WAS REPEATED ═══
   *
   * A first-run reactive on HBsAg is a reading, not a finding. The flag is on the well and the
   * instruction travels in the result's own remarks, so whoever verifies it sees the requirement
   * without having to open the plate.
   */
  it("MUTANT: a reactive well is flagged for repeat in duplicate, and a non-reactive one is not", async () => {
    const [a, b] = [await tubeA(), await tubeB()];
    const plateMapId = await layOut([
      ...CONTROL_WELLS,
      { well: "F1", role: "patient", specimenNo: a },
      { well: "G1", role: "patient", specimenNo: b },
    ]);
    await ingestResults(db, bridge.actor, block("elisa-2", [
      ...GOOD_CONTROLS, ["F1", "0.050"], ["G1", "0.900"],
    ]));

    const wells = await plateContents(db, plateMapId);
    expect(wells.find((w) => w.well === "G1")!.repeatRequired).toBe(true);
    expect(wells.find((w) => w.well === "F1")!.repeatRequired).toBe(false);

    const results = await db.select().from(labResults);
    const reactive = results.find((r) => r.valueCoded === "Reactive")!;
    const nonReactive = results.find((r) => r.valueCoded === "Non-Reactive")!;
    expect(reactive.remarks).toMatch(/REPEAT IN DUPLICATE BEFORE REPORTING/);
    expect(nonReactive.remarks).not.toMatch(/REPEAT IN DUPLICATE/);
    /** The remarks carry the arithmetic, so a report never shows a bare optical density. */
    expect(reactive.remarks).toMatch(/OD 0\.9000 · cut-off 0\.1500 · S\/CO 6\.00/);
    expect(reactive.remarks).toMatch(/kit lot K2409/);
  });

  it("a block with no plate laid out parks whole — there is nothing to read the wells against", async () => {
    await tubeA();
    const out = await ingestResults(db, bridge.actor, block("elisa-nomap", [
      ...GOOD_CONTROLS, ["F1", "0.900"],
    ]));
    expect(out.attached).toEqual([]);
    expect(out.parked.map((p) => p.reason)).toEqual(Array(6).fill("no_plate_well"));
    expect(out.plate).toBeUndefined();
    expect(await db.select().from(labResults)).toHaveLength(0);
  });

  it("the block CONSUMES the plate — a second block finds no map and parks whole", async () => {
    const a = await tubeA();
    await layOut([...CONTROL_WELLS, { well: "F1", role: "patient", specimenNo: a }]);
    await ingestResults(db, bridge.actor, block("elisa-3", [...GOOD_CONTROLS, ["F1", "0.900"]]));

    const second = await ingestResults(db, bridge.actor, block("elisa-4", [
      ...GOOD_CONTROLS, ["F1", "0.100"],
    ]));
    expect(second.attached).toEqual([]);
    expect(second.parked.map((p) => p.reason)).toEqual(Array(6).fill("no_plate_well"));
    /** The FIRST plate's one result stands; the second block added none. */
    expect(await db.select().from(labResults)).toHaveLength(1);
  });

  it("a reading for a well nobody laid out parks that well, and the plate still reports", async () => {
    const a = await tubeA();
    await layOut([...CONTROL_WELLS, { well: "F1", role: "patient", specimenNo: a }]);
    const out = await ingestResults(db, bridge.actor, block("elisa-5", [
      ...GOOD_CONTROLS, ["F1", "0.900"], ["H12", "0.400"],
    ]));
    expect(out.attached).toHaveLength(1);
    expect(out.parked).toEqual([{ position: 7, reason: "no_plate_well" }]);
  });

  /**
   * A doubled NEGATIVE CONTROL is the dangerous version: it drags the mean, the cut-off moves with
   * it, and every patient well on the plate is measured against the wrong number in a direction
   * nothing reports. Here the second `B1` at 0.500 would pull the mean from 0.050 to 0.200 and
   * treble the cut-off — so neither reading is used, and the plate reports on C1 alone.
   */
  it("MUTANT: a well named twice in one block skews nothing — neither reading is used", async () => {
    const a = await tubeA();
    await layOut([...CONTROL_WELLS, { well: "F1", role: "patient", specimenNo: a }]);
    const out = await ingestResults(db, bridge.actor, block("elisa-dup", [
      ["A1", "0.010"], ["B1", "0.040"], ["B1", "0.500"], ["C1", "0.060"],
      ["D1", "1.200"], ["E1", "1.400"], ["F1", "0.100"],
    ]));

    /** C1 alone is the negative mean: 0.060 × 3 = 0.180, and F1 at 0.100 stays non-reactive. */
    expect(out.plate!.status).toBe("read");
    expect(out.plate!.ncMeanOd).toBeCloseTo(0.06, 6);
    expect(out.plate!.cutoffOd).toBeCloseTo(0.18, 6);
    expect(out.parked.map((p) => [p.reason, p.detail])).toEqual([
      ["no_plate_well", "well_named_twice"], ["no_plate_well", "well_named_twice"],
    ]);
    expect(out.attached).toHaveLength(1);
    expect((await db.select().from(labResults))[0]!.valueCoded).toBe("Non-Reactive");
  });

  it("one open plate per reader, and a plate belongs to a reader that reports wells", async () => {
    await layOut(CONTROL_WELLS);
    await expect(openPlateMap(db, fx.bench.actor, {
      instrumentId, plateRef: "P-2", assay: "HBsAg", kitLot: "K2409", ...KIT,
    })).rejects.toThrow(LabError);

    const { instrumentId: counter } = await registerInstrument(db, fx.pathologist.actor, {
      code: "EL-120", name: "electrolyte analyser", sampleIdMode: "run_sheet",
    });
    await expect(openPlateMap(db, fx.bench.actor, {
      instrumentId: counter, plateRef: "P-9", assay: "HBsAg", kitLot: "K2409", ...KIT,
    })).rejects.toThrow(LabError);
  });

  /**
   * The plate is laid out at the BENCH. A machine account that could write the map could name any
   * well it liked, which is exactly the authority this phase withholds from it.
   */
  it("the bridge cannot lay out a plate, and neither can an agent", async () => {
    await expect(openPlateMap(db, bridge.actor, {
      instrumentId, plateRef: "P-X", assay: "HBsAg", kitLot: "K2409", ...KIT,
    })).rejects.toThrow(LabError);
    await expect(openPlateMap(db, { type: "agent", id: newId() }, {
      instrumentId, plateRef: "P-Y", assay: "HBsAg", kitLot: "K2409", ...KIT,
    })).rejects.toThrow(LabError);
  });

  /**
   * ═══ THE ARITHMETIC, WITHOUT A DATABASE ═══
   *
   * A missing control is a FAILURE and never a pass. The tempting alternative — "no negative control
   * was read, so skip that check" — turns a plate loaded wrongly into a plate that reports.
   */
  describe("evaluatePlateControls", () => {
    const nc = (od: number) => ({ role: "negative_control" as const, od });
    const pc = (od: number) => ({ role: "positive_control" as const, od });

    it("computes the cut-off from the kit's formula over this plate's negative controls", () => {
      const v = evaluatePlateControls(KIT, [nc(0.04), nc(0.06), pc(1.2), pc(1.4)]);
      expect(v.ok).toBe(true);
      expect(v.ncMeanOd).toBeCloseTo(0.05, 6);
      expect(v.pcMeanOd).toBeCloseTo(1.3, 6);
      expect(v.cutoffOd).toBeCloseTo(0.15, 6);
    });

    it("a dedicated cut-off control REPLACES the formula, because the kit insert says so", () => {
      const v = evaluatePlateControls(KIT, [
        nc(0.04), nc(0.06), pc(1.2), pc(1.4), { role: "cutoff_control", od: 0.3 },
      ]);
      expect([v.ok, v.cutoffOd]).toEqual([true, 0.3]);
      /** The FORMULA would have said 0.15 — the presence of the control is what changed the answer. */
    });

    it("a missing control fails the plate rather than skipping its check", () => {
      expect(evaluatePlateControls(KIT, [pc(1.2)]).ok).toBe(false);
      expect(evaluatePlateControls(KIT, [nc(0.05)]).reason).toMatch(/no positive control/);
    });

    it("a weak positive fails the ratio, and a dirty negative fails the maximum", () => {
      expect(evaluatePlateControls(KIT, [nc(0.05), pc(0.2)]).reason).toMatch(/positive\/negative ratio/);
      expect(evaluatePlateControls(KIT, [nc(0.2), pc(2)]).reason).toMatch(/exceeds the kit's maximum/);
    });
  });
});
