import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { mkPatient, testCfg } from "../../../test/helpers/opd";
import { stockBalances, stockReservations } from "../../kernel/db/schema";
import { claimDispense, findAtCounter } from "./claim";
import { pickDispense } from "./pick";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16c T4 A1 — THE LAST TEN TABLETS. Two dispenses, two patients, one batch of ten. Both
 * picks plan the same batch before either reserves; `reserveStock` takes the ledger's balance lock
 * and the second is refused. The assertion is a STATE (one reservation, ten reserved, never
 * eleven), not a duration — a busy host makes it more true. The mutant is a pick that inserts its
 * own reservation row outside the ledger: both would "succeed" and `qty_reserved` would read 20 on
 * a balance of 10.
 */
describe("pick — two counters, the last ten tablets (16c T4 A1)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  it("exactly one pick holds the batch; the other is refused by the ledger; the balance never goes negative", async () => {
    const batchId = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "LAST10", qtyBase: 10 });
    const other = await mkPatient(db, fx.clerk.actor, { name: "Ram Kumar", phone: "9000000001" });
    const ids: string[] = [];
    for (const patientId of [fx.patient.id, other.id]) {
      const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { patientId });
      const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
      if (r.kind !== "dispense") throw new Error("no dispense");
      await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
      await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
      ids.push(r.dispense.id);
    }
    const results = await Promise.allSettled(ids.map((id) => pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2)));
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0]!.reason as { code: string }).code).toMatch(/^(insufficient_stock|short_stock)$/);
    const held = await db.select().from(stockReservations).where(eq(stockReservations.status, "held"));
    expect(held).toHaveLength(1);
    const [bal] = await db.select().from(stockBalances).where(eq(stockBalances.batchId, batchId));
    expect(bal).toMatchObject({ qtyOnHand: 10, qtyReserved: 10, qtyFrozen: 0 });
  });
});
