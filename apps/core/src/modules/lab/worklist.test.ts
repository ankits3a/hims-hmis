import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deskAndLabel, seedLabDeskBase } from "../../../test/helpers/lab";
import { withTx } from "../../kernel/db/client";
import { receive } from "./accession";
import { benchArrivals, benchWorklist } from "./worklist";
import type { LabDeskFixture } from "../../../test/helpers/lab";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PLAN 17c T3 / D7 — THE BENCH'S FIRST COLUMN ═══
 *
 * A scanned tube that is drawn and not yet received had nothing to show: the chair's specimen
 * reader carries no patient by design. `benchArrivals` is the actor-gated reader for that column.
 */
describe("the bench's arrivals (17c T3)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  it("a drawn tube is an ARRIVAL with its patient and codes; once received it is on the worklist and gone from arrivals", async () => {
    const drawn = await deskAndLabel(db, fx, ["CBC", "HBSAG"], { wristbandScanned: false });
    const arrivals = await benchArrivals(db, fx.bench.actor);
    expect(arrivals.map((a) => a.specimenNo).sort()).toEqual(drawn.specimens.map((s) => s.specimenNo).sort());
    for (const a of arrivals) {
      expect(a.patientDisplay).toBe("Ram Kumar");
      expect(a.wristbandScanned).toBe(false);
      expect(a.orderGroupId).toBe(drawn.orderGroupId);
    }
    /** The tube stays on the list and the RESTRICTED test's name leaves it (collectionQueue's rule). */
    const codes = arrivals.flatMap((a) => a.orderableCodes);
    expect(codes).toContain("CBC");
    expect(codes).not.toContain("HBSAG");
    expect(await benchWorklist(db, fx.bench.actor)).toEqual([]);

    const cbcTube = drawn.specimens.find((s) => s.itemIds.includes(drawn.itemIds[0]!))!;
    await withTx(db, (tx) => receive(tx, fx.bench.actor, fx.decls, { specimenNo: cbcTube.specimenNo, identityRecheckBy: "Sister Rekha" }));
    const after = await benchArrivals(db, fx.bench.actor);
    expect(after.map((a) => a.specimenNo)).not.toContain(cbcTube.specimenNo);
    const work = await benchWorklist(db, fx.bench.actor);
    expect(work.map((w) => w.specimenNo)).toContain(cbcTube.specimenNo);
  });

  it("a reader that is not a user is refused, and so is one without the worklist permission", async () => {
    await expect(benchArrivals(db, { type: "system", id: "sys" })).rejects.toMatchObject({ code: "user_actor_required" });
  });
});
