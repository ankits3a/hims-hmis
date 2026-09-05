import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { seedLabDeskBase } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { labAnalytes, labInstrumentCodes, labInstruments, resources } from "../../kernel/db/schema";
import { LabError } from "./errors";
import {
  instrumentByResource, instrumentCodeMap, LAB_INSTRUMENTS_MANAGE, listInstruments,
  mapInstrumentCode, registerInstrument,
} from "./instruments";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 17-E T1 — THE INSTRUMENT REGISTER ═══
 *
 * The machine is a kernel `resources` row of kind `analyzer` — declared in `kinds.ts` since Plan 17
 * T2 with seven statuses and, until this task, no writer at all. What this module adds is the half
 * the kernel has no opinion about: **how each machine names the sample it just measured**, which is
 * the one axis the whole phase branches on.
 */
describe("17-E T1 — the instruments on the bench", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let analyteId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantPermissionToRole(db, fx.registry, "pathologist", LAB_INSTRUMENTS_MANAGE);
    const [a] = await db.select({ id: labAnalytes.id }).from(labAnalytes).limit(1);
    analyteId = a!.id;
  });
  afterEach(() => { fx.unregister(); });

  const chem = { code: "ANL-CHEM-1", name: "Chemistry analyser", sampleIdMode: "barcode" as const };

  it("registers a machine as a kernel `analyzer` resource AND the lab's row, in one act", async () => {
    const { instrumentId, resourceId } = await registerInstrument(db, fx.pathologist.actor, {
      ...chem, connection: "ASTM over RS-232",
    });

    /** The kernel half: the kind's own vocabulary, starting at the status `kinds.ts` declares. */
    const [res] = await db.select().from(resources).where(eq(resources.id, resourceId));
    expect([res!.kind, res!.status, res!.code]).toEqual(["analyzer", "available", "ANL-CHEM-1"]);

    /** The lab half: how it names a sample, which is the fact every later task reads. */
    const [row] = await db.select().from(labInstruments).where(eq(labInstruments.id, instrumentId));
    expect([row!.sampleIdMode, row!.connection, row!.active]).toEqual(["barcode", "ASTM over RS-232", true]);

    const register = await listInstruments(db);
    expect(register).toHaveLength(1);
    expect(register[0]).toMatchObject({ code: "ANL-CHEM-1", status: "available", sampleIdMode: "barcode" });
  });

  /**
   * MUTANT — TWO INSTRUMENT ROWS AGAINST ONE MACHINE.
   *
   * Two rows would give one analyser two code maps and two sample-id modes, and an ingest resolving
   * through "the" instrument would pick by row order — so the same tube would decode differently
   * depending on which row a query happened to return first. The machine is the identity.
   */
  it("refuses a SECOND instrument row against the same resource", async () => {
    const { resourceId } = await registerInstrument(db, fx.pathologist.actor, chem);
    await expect(db.insert(labInstruments).values({
      id: newId(), resourceId, sampleIdMode: "plate_map", createdBy: "t", updatedBy: "t",
    })).rejects.toThrow(/lab_instruments_resource_ux/);
  });

  /**
   * MUTANT — THE SAME CODE MAPPED TWICE ON ONE INSTRUMENT.
   *
   * The primary key says a code means ONE thing on ONE machine. A second row would make "which
   * analyte is GLU" depend on read order, which is the same defect as the one above wearing a
   * different hat. Re-mapping is therefore an UPDATE, and the test asserts the row COUNT as well as
   * the value — a check on the value alone would pass with two rows present.
   */
  it("re-mapping a code UPDATES it rather than adding a second row", async () => {
    const { instrumentId } = await registerInstrument(db, fx.pathologist.actor, chem);
    const [second] = await db.select({ id: labAnalytes.id }).from(labAnalytes).limit(2).offset(1);

    await mapInstrumentCode(db, fx.pathologist.actor, { instrumentId, instrumentCode: "GLU", analyteId, unit: "mg/dL" });
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "GLU", analyteId: second!.id, unit: "mmol/L", factor: "18.016",
    });

    const rows = await db.select().from(labInstrumentCodes).where(eq(labInstrumentCodes.instrumentId, instrumentId));
    expect(rows).toHaveLength(1);
    expect([rows[0]!.analyteId, rows[0]!.unit]).toEqual([second!.id, "mmol/L"]);

    const map = await instrumentCodeMap(db, instrumentId);
    expect(map.get("GLU")).toMatchObject({ analyteId: second!.id, unit: "mmol/L" });
    /** An unmapped code is ABSENT rather than defaulted — D4's park depends on this being a miss. */
    expect(map.get("GLUF")).toBeUndefined();
  });

  /**
   * MUTANT — A FACTOR OF ZERO.
   *
   * The quiet catastrophe of this table: it does not fail, it reports every value on that channel
   * as 0. A potassium of zero on a live patient is a plausible-looking number that no envelope
   * catches, because zero is not absurd — it is just wrong.
   */
  it("refuses a factor of zero or a negative one", async () => {
    const { instrumentId } = await registerInstrument(db, fx.pathologist.actor, chem);
    for (const factor of ["0", "-1"]) {
      await expect(mapInstrumentCode(db, fx.pathologist.actor, {
        instrumentId, instrumentCode: `K-${factor}`, analyteId, factor,
      })).rejects.toThrow(/lab_instrument_codes_factor_ck/);
    }
    /** The control: a real conversion factor is accepted, so the check is a floor and not a wall. */
    await mapInstrumentCode(db, fx.pathologist.actor, { instrumentId, instrumentCode: "K", analyteId, factor: "0.001" });
    expect((await instrumentCodeMap(db, instrumentId)).get("K")?.factor).toBe("0.001000");
  });

  it("names an unknown instrument and an unknown analyte rather than writing an orphan", async () => {
    const { instrumentId } = await registerInstrument(db, fx.pathologist.actor, chem);
    await expect(mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId: newId(), instrumentCode: "X", analyteId,
    })).rejects.toMatchObject({ code: "unknown_instrument" });
    await expect(mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "X", analyteId: newId(),
    })).rejects.toMatchObject({ code: "unknown_analyte" });
  });

  /**
   * ═══ THE BRIDGE MAY NOT ENROL ITSELF, AND THAT IS WHY THE ACTOR TYPE IS CHECKED FIRST ═══
   *
   * The bridge authenticates as an `agent` (D2). `hasPermission` takes a `users.id` and, handed an
   * agent id, returns false — which would report "this user lacks the grant" about something that
   * is not a user. Registering a machine and mapping its codes is administrative data with a person
   * answerable for it; a machine that could re-map its own codes could rename any test it reports.
   */
  it("refuses a non-user actor, and a user without the grant", async () => {
    await expect(registerInstrument(db, { type: "agent", id: newId() }, chem))
      .rejects.toMatchObject({ code: "user_actor_required" });

    const clerk = await mkUser(db, "lab.counter.nogrant", ["lab_reception"]);
    await expect(registerInstrument(db, clerk.actor, chem))
      .rejects.toMatchObject({ code: "permission_denied" });
    expect(await listInstruments(db)).toHaveLength(0);
  });

  it("finds the instrument behind a resource — the ingest routes are addressed by machine", async () => {
    const { instrumentId, resourceId } = await registerInstrument(db, fx.pathologist.actor, chem);
    expect(await instrumentByResource(db, resourceId)).toMatchObject({ id: instrumentId, sampleIdMode: "barcode" });
    expect(await instrumentByResource(db, newId())).toBeNull();
  });

  it("admits exactly the four sample-id modes the board describes", async () => {
    for (const mode of ["barcode", "typed_id", "run_sheet", "plate_map"] as const) {
      await registerInstrument(db, fx.pathologist.actor, { code: `ANL-${mode}`, name: mode, sampleIdMode: mode });
    }
    expect((await listInstruments(db)).map((i) => i.sampleIdMode).sort())
      .toEqual(["barcode", "plate_map", "run_sheet", "typed_id"]);
    /** A fifth mode is a code change plus a task, never a row somebody types. */
    await expect(db.insert(labInstruments).values({
      id: newId(), resourceId: (await registerInstrument(db, fx.pathologist.actor, { code: "X", name: "x", sampleIdMode: "barcode" })).resourceId,
      sampleIdMode: "telepathy", createdBy: "t", updatedBy: "t",
    })).rejects.toThrow(/lab_instruments_(sample_id_mode_ck|resource_ux)/);
  });

  it("LabError is the refusal type, so the controller maps it", async () => {
    await expect(registerInstrument(db, { type: "agent", id: newId() }, chem)).rejects.toBeInstanceOf(LabError);
  });
});
