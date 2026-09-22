import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { claimDispense, findAtCounter } from "./claim";
import { getDispense } from "./queue";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * A PRICE ON EVERY LINE, BEFORE THE BILL (the approved Desk board: each line carries `₹145.00` and
 * `₹14.50 ea`, and the rail's total says "so far" until the ticket settles).
 *
 * The shipped desk showed "—" on every line and "priced when the strips are collected", which is a
 * counter that cannot answer "how much will this be?" — the question every patient asks first. The
 * quote is the SERVER's, from the batch the pick would take, and the ticket's running total is the
 * server's sum: the desk adds nothing up.
 */
describe("what the ticket will cost, said before it is collected", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  it("each line is quoted from the batch the pick would take, and the ticket carries the running total", async () => {
    // ₹120 a strip of ten = ₹12 a tablet; ₹90 a strip = ₹9
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", mrpPaise: 12_000, qtyBase: 100 });
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", mrpPaise: 9_000, qtyBase: 100 });
    const { issued } = await issueRx(db, fx, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "1-0-1", durationDays: 5 }),
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "1-0-0", durationDays: 3 }),
    ]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);

    const d = await getDispense(db, fx.pharmacist.actor, found.dispense.id, MON2);
    expect(d.lines[0]).toMatchObject({ qtyBase: 10, quote: { batchNo: "CR-1", unitPaise: 1_200, pack: { uom: "strip", multiplier: 10, paise: 12_000 } } });
    expect(d.lines[1]).toMatchObject({ qtyBase: 3, quote: { batchNo: "AZ-1", unitPaise: 900 } });
    // 10 × ₹12.00 + 3 × ₹9.00 — the SERVER's sum over the quantities the check will be made against
    expect(d.quotedTotalPaise).toBe(10 * 1_200 + 3 * 900);
  });

  it("a line the shelf cannot fill is quoted at nothing, and is left out of the total", async () => {
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", mrpPaise: 9_000, qtyBase: 100 });
    const { issued } = await issueRx(db, fx, [
      line({ drug: "Crocin 500", medicineId: fx.med.crocin }), // nothing of it on the shelf
      line({ drug: "Azee 500", medicineId: fx.med.azithro, frequency: "1-0-0", durationDays: 3 }),
    ]);
    const found = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (found.kind !== "dispense") throw new Error("expected a dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: found.dispense.id, door: "rx_qr" }, MON2);

    const d = await getDispense(db, fx.pharmacist.actor, found.dispense.id, MON2);
    expect(d.lines[0]!.quote).toBeNull();
    expect(d.quotedTotalPaise).toBe(3 * 900);
  });
});
