import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deskAndLabel, grantLabResultPermissions, seedLabDeskBase, uhidOf } from "../../../test/helpers/lab";
import { mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { labAnalytes, labOrderableAnalytes, labOrderables } from "../../kernel/db/schema";
import { receive } from "./accession";
import {
  instrumentWorklist, LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument,
} from "./instruments";
import { serviceIdForLabCode } from "../../../test/helpers/lab";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ 17-E T2 — THE MACHINE ASKS WHAT TO RUN, AND IS TOLD ONLY THAT ═══
 *
 * The board's chemistry analyser is *"ASTM both ways: it asks the server what to run"*. What this
 * suite is really about is the ANSWER'S SHAPE: a list of the instrument's own codes, and nothing
 * else. No patient name, no UHID, no date of birth, no order number. A bench PC speaking ASTM in
 * clear text on a flat hospital LAN is the last place in the building to hold PHI, and the protocol
 * has no way to protect it even if we wanted to.
 *
 * So the leak test below is not a nicety. It is the reason the reader takes a specimen number and
 * returns codes rather than returning "the order".
 */
describe("17-E T2 — the instrument worklist", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

  /** The analytes a CBC actually carries, so the fixture asserts against the catalogue, not a guess. */
  async function analytesOf(code: string): Promise<{ id: string; code: string }[]> {
    return await db
      .select({ id: labAnalytes.id, code: labAnalytes.code })
      .from(labOrderables)
      .innerJoin(labOrderableAnalytes, eq(labOrderableAnalytes.serviceId, labOrderables.serviceId))
      .innerJoin(labAnalytes, eq(labAnalytes.id, labOrderableAnalytes.analyteId))
      .where(eq(labOrderables.serviceId, serviceIdForLabCode(code)));
  }

  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedLabDeskBase(db);
    await grantLabResultPermissions(db, fx);
    await grantPermissionToRole(db, fx.registry, "pathologist", "lab.instruments.manage");
    await grantPermissionToRole(db, fx.registry, "pathologist", LAB_INSTRUMENTS_READ);
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "ANL-CHEM-1", name: "Chemistry analyser", sampleIdMode: "barcode",
    }));
  });
  afterEach(() => { fx.unregister(); });

  /** Order → label → draw → RECEIVE: the state in which a tube is on the analyser's rack. */
  async function receivedTube(codes: readonly string[]): Promise<string> {
    /** `deskAndLabel` already DRAWS the tube; this adds only the bench's receipt. */
    const { specimens } = await deskAndLabel(db, fx, codes);
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    return specimens[0]!.specimenNo;
  }

  it("answers with the instrument's OWN codes for the analytes it is mapped for", async () => {
    const analytes = await analytesOf("CBC");
    const mapped = analytes.slice(0, 2);
    for (const [i, a] of mapped.entries()) {
      await mapInstrumentCode(db, fx.pathologist.actor, {
        instrumentId, instrumentCode: `M${String(i)}`, analyteId: a.id,
      });
    }
    const specimenNo = await receivedTube(["CBC"]);
    const out = await instrumentWorklist(db, fx.pathologist.actor, { instrumentId, sampleId: specimenNo });

    expect(out.specimenNo).toBe(specimenNo);
    expect(out.entries.map((e) => e.instrumentCode).sort()).toEqual(["M0", "M1"]);
    expect(out.entries.map((e) => e.analyteCode).sort()).toEqual(mapped.map((a) => a.code).sort());
  });

  /**
   * MUTANT — RETURNING AN ANALYTE THE INSTRUMENT HAS NO CODE FOR.
   *
   * Not an optimisation. An analyser told to run a test it has no channel for either errors, or —
   * worse — runs something adjacent and reports it under a code we will fail to map, which is a
   * parked result at best. A CBC carries more analytes than any one machine runs.
   */
  it("withholds analytes this instrument has NO code for — it is told only what it can do", async () => {
    const analytes = await analytesOf("CBC");
    expect(analytes.length).toBeGreaterThan(1); // the fixture must be able to discriminate
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "ONLY", analyteId: analytes[0]!.id,
    });
    const specimenNo = await receivedTube(["CBC"]);
    const out = await instrumentWorklist(db, fx.pathologist.actor, { instrumentId, sampleId: specimenNo });

    /** THE KILL: every analyte on the panel, when only one is mapped. */
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]!.instrumentCode).toBe("ONLY");
  });

  /**
   * MUTANT — ANSWERING FOR A TUBE THE BENCH HAS NOT RECEIVED.
   *
   * A labelled-but-not-received tube is still in transit, or was rejected and is awaiting a redraw.
   * Answering for one would have the analyser aspirate from a rack position holding nothing — or
   * holding the tube that replaced it, which is the swap this module spends 17d T1 preventing.
   */
  it("returns NOTHING for a tube that has not been received", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "M0", analyteId: analytes[0]!.id,
    });
    const { specimens } = await deskAndLabel(db, fx, ["CBC"]); // labelled, never drawn or received
    const out = await instrumentWorklist(db, fx.pathologist.actor, {
      instrumentId, sampleId: specimens[0]!.specimenNo,
    });
    expect(out.entries).toEqual([]);
  });

  /**
   * MUTANT — LEAKING THE PATIENT BLOCK.
   *
   * Asserted over the SERIALISED answer rather than field by field, because the failure this guards
   * is a field somebody adds later without thinking about the wire. A whitelist of keys would pass
   * while a nested object carried a name.
   */
  it("carries NO patient identity anywhere in the answer — asserted over the whole payload", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "M0", analyteId: analytes[0]!.id,
    });
    const specimenNo = await receivedTube(["CBC"]);
    const uhid = await uhidOf(db, fx.patientId);
    const out = await instrumentWorklist(db, fx.pathologist.actor, { instrumentId, sampleId: specimenNo });

    const wire = JSON.stringify(out);
    for (const secret of [uhid, "Farida", "Khatoon", fx.patientId, fx.encounterNo]) {
      expect(wire).not.toContain(secret);
    }
    /** And the shape is exactly two fields per entry — nothing rides along unnoticed. */
    expect(Object.keys(out).sort()).toEqual(["entries", "specimenNo"]);
    for (const e of out.entries) expect(Object.keys(e).sort()).toEqual(["analyteCode", "instrumentCode"]);
  });

  /**
   * MUTANT — ANSWERING WITHOUT THE GRANT.
   *
   * The bridge holds `lab.instruments.read` and NOTHING else — a machine account that could also
   * register instruments could rename any test it reports. A holder of `manage` alone is refused
   * here, which is the direction people forget to test.
   */
  it("refuses a caller without lab.instruments.read, including one who can MANAGE instruments", async () => {
    const clerk = await mkUser(db, "lab.counter.noread", ["lab_reception"]);
    await expect(instrumentWorklist(db, clerk.actor, { instrumentId, sampleId: "S1" }))
      .rejects.toMatchObject({ code: "permission_denied" });

    const manager = await mkUser(db, "lab.estate", ["lab_technician"]);
    await grantPermissionToRole(db, fx.registry, "lab_technician", "lab.instruments.manage");
    await expect(instrumentWorklist(db, manager.actor, { instrumentId, sampleId: "S1" }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("names an unknown instrument, an inactive one, and an unknown specimen", async () => {
    await expect(instrumentWorklist(db, fx.pathologist.actor, { instrumentId: newId(), sampleId: "S1" }))
      .rejects.toMatchObject({ code: "unknown_instrument" });
    await expect(instrumentWorklist(db, fx.pathologist.actor, { instrumentId, sampleId: "S-nope" }))
      .rejects.toMatchObject({ code: "unknown_specimen" });
  });

  it("an instrument with an EMPTY code map answers nothing rather than everything", async () => {
    const specimenNo = await receivedTube(["CBC"]);
    const out = await instrumentWorklist(db, fx.pathologist.actor, { instrumentId, sampleId: specimenNo });
    expect(out.entries).toEqual([]);
  });
});
