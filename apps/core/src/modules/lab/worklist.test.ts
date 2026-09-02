import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { deskAndLabel, grantLabResultPermissions, runLabOrder, seedLabDeskBase } from "../../../test/helpers/lab";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { receive } from "./accession";
import { benchArrivals, benchWorklist, verifyWorklist } from "./worklist";
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
    /**
     * ALL OR NOTHING (close review pass 1, F1): the first cut filtered the restricted code out and
     * left `itemIds` beside it — `[]` next to one item PROVES a restricted test. Every row alike:
     * no codes for a reader without `orders.read.restricted`, every code for one who holds it.
     */
    expect(arrivals.map((a) => a.orderableCodes)).toEqual([[], []]);
    await grantPermissionToRole(db, fx.registry, "lab_technician", "orders.read.restricted");
    const cleared = await benchArrivals(db, fx.bench.actor);
    expect(cleared.flatMap((a) => a.orderableCodes).sort()).toEqual(["CBC", "HBSAG"]);
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

/**
 * ═══ PLAN 17c T4 / D11 — THE PREVIOUS VALUE IS THE LAST VERIFIED ONE ═══
 */
describe("the verify seat's previous value (17c T4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: LabDeskFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => { await teardown(); });
  beforeEach(async () => { await truncateAll(db); fx = await seedLabDeskBase(db); });
  afterEach(() => { fx.unregister(); });

  it("previous is the last VERIFIED TSH, never a later UNVERIFIED one; the TAT target follows the priority", async () => {
    await grantLabResultPermissions(db, fx);
    const t0 = new Date("2026-08-29T04:00:00Z");
    // 1. Signed last week: TSH 5.5 — the comparison the pathologist wants.
    await runLabOrder(db, fx, ["TSH"], { at: new Date(t0.getTime() - 7 * 86_400_000), values: { TSH: "5.5" } });
    // 2. Keyed yesterday and NEVER signed: 4.0 — the mutant's answer (latest by entered_at).
    await runLabOrder(db, fx, ["TSH"], { at: new Date(t0.getTime() - 86_400_000), values: { TSH: "4.0" }, verify: false });
    // 3. Today, on the pathologist's queue.
    const today = await runLabOrder(db, fx, ["TSH"], { at: t0, values: { TSH: "3.0" }, verify: false });

    const queue = await verifyWorklist(db, fx.pathologist.actor);
    const row = queue.find((r) => r.orderId === today.orderId)!;
    const tsh = row.analytes.find((a) => a.code === "TSH")!;
    expect(Number(tsh.value)).toBe(3);
    expect(Number(tsh.previous?.value)).toBe(5.5); // THE KILL: 4
    expect(tsh.previous?.flag).not.toBeUndefined();
    expect(row.tatTargetMinutes).toBeGreaterThan(0);
  });
});
