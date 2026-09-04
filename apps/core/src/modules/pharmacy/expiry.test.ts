import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { stockBalances, stockReservations } from "../../kernel/db/schema";
import { previewDispenseBill, billDispense } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { PICK_RESERVATION_MINUTES } from "./config";
import { sweepExpiredPicks } from "./expiry";
import { pickDispense } from "./pick";
import { getDispense } from "./queue";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 16c CLOSE / F11 — the pick reservation expires, and the shelf gets its stock back.
 *
 * `pick.ts` wrote `expires_at` from the first commit and nothing read it, so these assertions are
 * about a promise (D2) that the shipped code did not keep: an abandoned pick held `qty_reserved`
 * for ever and the counter reported short stock on a full shelf.
 */
describe("the pick reservation expires (16c F11)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  const AFTER = new Date(MON2.getTime() + (PICK_RESERVATION_MINUTES + 1) * 60_000);
  const WITHIN = new Date(MON2.getTime() + (PICK_RESERVATION_MINUTES - 1) * 60_000);

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", expiryDate: "2027-12-31", qtyBase: 100, mrpPaise: 12000 });
  });
  afterEach(() => { fx.unregister(); });

  async function picked(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 10 }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, {}, MON2);
    return r.dispense.id;
  }
  const reservedNow = async (): Promise<number> =>
    (await db.select().from(stockBalances)).reduce((n, b) => n + b.qtyReserved, 0);

  it("an abandoned pick past its window is cancelled and the ten tablets go back to the shelf", async () => {
    const id = await picked();
    expect(await reservedNow()).toBe(10);

    // inside the window the sweep leaves it alone — a pharmacist mid-transaction is not abandoned
    expect(await sweepExpiredPicks(db, fx.decls, WITHIN)).toEqual({ cancelled: [] });
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("picked");
    expect(await reservedNow()).toBe(10);

    // past it, the stock is somebody else's again
    expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [id] });
    const after = await getDispense(db, fx.pharmacist.actor, id);
    expect(after.status).toBe("cancelled");
    expect(after.cancelReason).toContain("expired");
    expect(await reservedNow()).toBe(0);
    const [res] = await db.select().from(stockReservations);
    expect(res?.status).toBe("released");

    // and it is idempotent: a second pass has nothing left to do
    expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [] });
  });

  it("a BILLED dispense is never swept — the medicine is paid for and belongs to the patient", async () => {
    const id = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);

    expect(await sweepExpiredPicks(db, fx.decls, AFTER)).toEqual({ cancelled: [] });
    expect((await getDispense(db, fx.pharmacist.actor, id)).status).toBe("billed");
    expect(await reservedNow()).toBe(10); // still held FOR this patient, not released to the shelf
    const [res] = await db.select().from(stockReservations).where(eq(stockReservations.status, "held"));
    expect(res).toBeDefined();
  });
});
