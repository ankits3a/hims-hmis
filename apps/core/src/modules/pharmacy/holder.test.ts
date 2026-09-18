import { and, desc, eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { events, opdPrescriptions } from "../../kernel/db/schema";
import { prescriptionIssued } from "../opd";
import { claimDispense, findAtCounter } from "./claim";
import { handlePrescriptionIssued } from "./consumers";
import { confirmSlip, getDispense } from "./queue";
import { pickDispense } from "./pick";
import { cancelDispense, verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PHASE PD, PD-4 — what an open line carries, and the exit from a claim nobody is working.
 *
 * ═══ E1b WAS MEASURED, AND IT IS NOT A DEFECT ═══
 *
 * The PD-3 walk showed Vikas's ticket rendered as Anita's, and a holder-only guard on verify /
 * decline / pick looked like the server half of that. It is not: `t4.test.ts` pins the ASSISTANT
 * model — an aide claims and picks, a registered pharmacist performs the check the Act reserves —
 * and the guard turned that, the P2 registration suite and the HTTP e2e red. Work by two people on
 * one claimed ticket is the design. The defect was the SCREEN, and PD-3 fixed it there.
 */
describe("an open line's batches, and the exit from an abandoned claim (PD-4)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  async function claimedBy(actor: PharmacyFixture["pharmacist"]["actor"]): Promise<{ id: string; qr: string }> {
    const { encounter, issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin, frequency: "1-0-1", durationDays: 3 })]);
    const [e] = await db.select({ eventId: events.eventId, payload: events.payload }).from(events)
      .where(and(eq(events.name, prescriptionIssued.name), eq(events.encounterId, encounter.id))).orderBy(desc(events.seq)).limit(1);
    const { dispenseId } = await withTx(db, (tx) => handlePrescriptionIssued(tx, e!.eventId, e!.payload, MON2));
    await claimDispense(db, actor, { dispenseId: dispenseId!, door: "token" }, MON2);
    return { id: dispenseId!, qr: issued.qrPayload };
  }

  it("E6 — the exit from an abandoned claim stays open: cancel it with a reason, and the slip scans back into the line", async () => {
    const { id, qr } = await claimedBy(fx.pharmacist.actor);
    const cancelled = await cancelDispense(db, fx.incharge.actor, fx.decls, id, "held since 10:05, patient gone to the lab", MON2);
    expect(cancelled.status).toBe("cancelled");
    const again = await findAtCounter(db, testCfg, fx.incharge.actor, qr, MON2);
    expect(again.kind === "dispense" && again.dispense.status === "queued" && again.dispense.id !== id).toBe(true);
  });

  it("E28 — a ticket typed from the doctor's paper says so, and by whom, from the moment it is opened", async () => {
    const { id } = await claimedBy(fx.pharmacist.actor);
    const d = await getDispense(db, fx.pharmacist.actor, id, MON2);
    expect(d).toMatchObject({ transcribedBy: null, transcribedByName: null, slipConfirmedBy: null });
    await db.update(opdPrescriptions).set({ transcribedBy: fx.clerk.id }).where(eq(opdPrescriptions.id, d.prescriptionId));
    expect(await getDispense(db, fx.pharmacist.actor, id, MON2)).toMatchObject({ transcribedBy: fx.clerk.id, transcribedByName: "clerk", slipConfirmedBy: null });
    await confirmSlip(db, fx.pharmacist.actor, id, MON2);
    expect(await getDispense(db, fx.pharmacist.actor, id, MON2)).toMatchObject({ slipConfirmedBy: fx.pharmacist.id });
  });

  it("PD-D3 / E8 — each open line carries the batches the pick would draw from, earliest expiry first", async () => {
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-LATE", expiryDate: "2028-01-31", qtyBase: 200 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-SOON", expiryDate: "2026-08-29", qtyBase: 20 });
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-DEAD", expiryDate: "2026-08-01", qtyBase: 50 });
    const { id } = await claimedBy(fx.pharmacist.actor);

    const view = await getDispense(db, fx.pharmacist.actor, id, MON2);
    expect(view.lines[0]!.pickedBatch).toBeNull();
    expect(view.lines[0]!.batches).toEqual([
      { batchId: expect.any(String) as unknown, batchNo: "CR-SOON", expiryDate: "2026-08-29", available: 20 },
      { batchId: expect.any(String) as unknown, batchNo: "CR-LATE", expiryDate: "2028-01-31", available: 200 },
    ]);

    /* and once picked, the line names the batch it was GIVEN from — the right column of the desk */
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 6 }] }, MON2);
    const picked = await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    expect({ batches: picked.lines[0]!.batches, pickedBatch: picked.lines[0]!.pickedBatch })
      .toEqual({ batches: [], pickedBatch: { batchNo: "CR-SOON", expiryDate: "2026-08-29" } });
  });
});
