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
  labAnalytes, labOrderableAnalytes, labOrderables, labParkedResults, labResults, labTransmissions,
} from "../../kernel/db/schema";
import { receive } from "./accession";
import { ingestResults, LAB_RESULTS_INTERFACE } from "./ingest";
import { LAB_INSTRUMENTS_READ, mapInstrumentCode, registerInstrument } from "./instruments";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ 17-E T3 — THE BLOCK ARRIVES, AND EVERY ROW FINDS ITS PATIENT OR PARKS ═══
 *
 * The board's Autolab ESR sends ten positions and its header reads *"9 matched · 1 waiting"*. That
 * sentence is the specification, and the two halves are separately load-bearing: the nine must
 * attach independently of the one, and the one must not vanish.
 */
describe("17-E T3 — the instrument ingest", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;
  let instrumentId: string;
  let bridge: Awaited<ReturnType<typeof mkUser>>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });

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
    /** `seedLabDeskBase` mints only the roles it needs; the bridge's is 17-E's own. */
    await ensureRole(db, "lab_bridge");
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_INSTRUMENTS_READ);
    await grantPermissionToRole(db, fx.registry, "lab_bridge", LAB_RESULTS_INTERFACE);
    /** The bridge is a service USER holding `lab_bridge` and nothing else (D2, corrected at T2). */
    bridge = await mkUser(db, "lab.bridge", ["lab_bridge"]);
    ({ instrumentId } = await registerInstrument(db, fx.pathologist.actor, {
      code: "ANL-CHEM-1", name: "Chemistry analyser", sampleIdMode: "barcode",
    }));
  });
  afterEach(() => { fx.unregister(); });

  /** A received tube plus the analyte codes it carries — the state a machine measures from. */
  async function tube(codes: readonly string[] = ["CBC"]): Promise<string> {
    const { specimens } = await deskAndLabel(db, fx, codes);
    for (const s of specimens) {
      await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: s.specimenNo }));
    }
    return specimens[0]!.specimenNo;
  }

  /**
   * ═══ D3 — ONE UNREADABLE ROW PARKS THAT ROW, AND THE OTHERS GO ON ═══
   *
   * THE MUTANT: reject the block. The ten positions are ten different patients, and the analyser has
   * already consumed the samples — "send it again" is not available. A block-level refusal costs
   * nine people their results for a reason none of them had anything to do with.
   */
  it("attaches the readable rows and parks only the unreadable one", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analytes[0]!.id,
    });
    const specimenNo = await tube();

    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-3",
      rows: [
        { position: 1, sampleId: specimenNo, code: "HGB", value: "12.5" },
        { position: 2, sampleId: specimenNo, code: "NOT-MAPPED", value: "99" },
        { position: 3, sampleId: "S-does-not-exist", code: "HGB", value: "13.0" },
      ],
    });

    expect(out.attached.map((a) => a.position)).toEqual([1]);
    expect(out.parked.map((p) => [p.position, p.reason])).toEqual([[2, "unmapped_code"], [3, "unknown_sample"]]);
    /** THE KILL: a block-level refusal would have written nothing at all. */
    expect(await db.select().from(labResults)).toHaveLength(1);
  });

  /**
   * The column `lab_results.analyzer_id` has existed since Plan 17 T1 and appeared exactly once in
   * the repository — in the schema, with no writer and no reader. This is its writer.
   */
  it("stamps the row as machine-produced: entry_mode `interface` AND the analyser's id", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analytes[0]!.id,
    });
    const specimenNo = await tube();
    await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-1",
      rows: [{ position: 1, sampleId: specimenNo, code: "HGB", value: "12.5" }],
    });

    const [row] = await db.select().from(labResults);
    expect([row!.entryMode, row!.analyzerId]).toEqual(["interface", instrumentId]);
    /** And WHO carried it is the bridge account — HOW and WHO are separate columns. */
    expect([row!.enteredByType, row!.enteredById]).toEqual(["user", bridge.id]);
  });

  /**
   * ═══ D5 — TWO CLOCKS, AND OURS IS THE ONE THAT COUNTS ═══
   *
   * THE MUTANT: trust `instrumentAt`. An analyser whose clock survived a power cut reading
   * 1970-01-01 would otherwise back-date the entry and make the turnaround unmeasurable.
   */
  it("records OUR arrival instant, never the instrument's own clock", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analytes[0]!.id,
    });
    const specimenNo = await tube();
    const theirClockIsWrong = new Date("1970-01-01T00:00:00.000Z");
    const ours = new Date();

    await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-clock",
      rows: [{ position: 1, sampleId: specimenNo, code: "HGB", value: "12.5", instrumentAt: theirClockIsWrong }],
    }, ours);

    const [t] = await db.select().from(labTransmissions);
    expect(t!.arrivedAt.getTime()).toBe(ours.getTime());
    const [row] = await db.select().from(labResults);
    /** THE KILL: an entry stamped 1970 is a turnaround nobody can measure. */
    expect(row!.enteredAt.getFullYear()).toBeGreaterThan(2020);
  });

  /**
   * ═══ A RETRY IS NOT A SECOND SET OF RESULTS ═══
   *
   * THE MUTANT: write the block twice. `lab_results` has no natural key that would catch it, so the
   * duplicate would reach the report as two values for one measurement.
   */
  it("treats a repeated transmissionRef as a no-op, not a second set of values", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analytes[0]!.id,
    });
    const specimenNo = await tube();
    const rows = [{ position: 1, sampleId: specimenNo, code: "HGB", value: "12.5" }];

    const first = await ingestResults(db, bridge.actor, { instrumentId, transmissionRef: "run-7", rows });
    const retry = await ingestResults(db, bridge.actor, { instrumentId, transmissionRef: "run-7", rows });

    expect([first.duplicate, retry.duplicate]).toEqual([false, true]);
    expect(retry.transmissionId).toBe(first.transmissionId);
    /** THE KILL: two rows for one measurement. */
    expect(await db.select().from(labResults)).toHaveLength(1);
    expect(await db.select().from(labTransmissions)).toHaveLength(1);
  });

  /**
   * ═══ THE GUARDS APPLY TO MACHINE VALUES EXACTLY AS TO TYPED ONES ═══
   *
   * THE MUTANT, and it is the gravest in the phase: let the machine path skip 17d T1's applicability
   * control or 02 H1's absurd envelope. Both refuse unless a SECOND PAIR OF HANDS vouches, and a
   * machine has none — so the value parks for a human. It must be neither entered nor dropped: a
   * value impossible for this patient is exactly the swapped tube those guards exist to catch.
   */
  it("PARKS a value the guards refuse, rather than entering it or dropping it", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analytes[0]!.id,
    });
    const specimenNo = await tube();

    /** A value far outside any envelope — the absurd guard refuses it and no machine can override. */
    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-absurd",
      rows: [{ position: 1, sampleId: specimenNo, code: "HGB", value: "999999" }],
    });

    expect(out.attached).toHaveLength(0);
    expect(out.parked).toHaveLength(1);
    expect(out.parked[0]!.reason).toBe("guard_refused");
    /** THE KILL, both halves: not entered, and not silently gone. */
    expect(await db.select().from(labResults)).toHaveLength(0);
    const [parkedRow] = await db.select().from(labParkedResults);
    expect(parkedRow!.rawValue).toBe("999999");
  });

  /** The parked payload is kept RAW — being unable to interpret it is the reason the row exists. */
  it("parks the payload verbatim: the instrument's own code, value and units", async () => {
    const specimenNo = await tube();
    await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-raw",
      rows: [{ position: 4, sampleId: specimenNo, code: "WEIRD", value: "++", unit: "arb" }],
    });
    const [p] = await db.select().from(labParkedResults);
    expect([p!.instrumentCode, p!.rawValue, p!.rawUnit, p!.reason, p!.status])
      .toEqual(["WEIRD", "++", "arb", "unmapped_code", "parked"]);
  });

  it("parks a tube the bench has not received — its rack slot is not ours to read", async () => {
    const analytes = await analytesOf("CBC");
    await mapInstrumentCode(db, fx.pathologist.actor, {
      instrumentId, instrumentCode: "HGB", analyteId: analytes[0]!.id,
    });
    const { specimens } = await deskAndLabel(db, fx, ["CBC"]); // labelled, never received
    const out = await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-early",
      rows: [{ position: 1, sampleId: specimens[0]!.specimenNo, code: "HGB", value: "12.5" }],
    });
    expect(out.parked[0]!.reason).toBe("sample_not_received");
  });

  it("refuses a caller without the interface grant, and a non-user actor", async () => {
    const clerk = await mkUser(db, "lab.counter.nointerface", ["lab_reception"]);
    await expect(ingestResults(db, clerk.actor, { instrumentId, transmissionRef: "x", rows: [] }))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(ingestResults(db, { type: "agent", id: newId() }, { instrumentId, transmissionRef: "x", rows: [] }))
      .rejects.toMatchObject({ code: "user_actor_required" });
  });

  it("records the transmission even when every row parks — a silent bridge is not a busy one", async () => {
    const specimenNo = await tube();
    await ingestResults(db, bridge.actor, {
      instrumentId, transmissionRef: "run-all-parked",
      rows: [{ position: 1, sampleId: specimenNo, code: "NOPE", value: "1" }],
    });
    const [t] = await db.select().from(labTransmissions);
    expect([t!.transmissionRef, t!.rowCount]).toEqual(["run-all-parked", 1]);
  });
});
