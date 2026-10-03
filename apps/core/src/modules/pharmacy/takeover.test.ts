import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { events, pharmacyDispenses } from "../../kernel/db/schema";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { takeOverDispense } from "./takeover";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/* Owner 2026-10-03 — admin claimed a ticket, added medicines and left the desk; abhay.kumar must finish it. */
describe("taking over a colleague's ticket", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 100, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
  });
  afterEach(() => { fx.unregister(); });

  async function claimedAndVerified(): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: r.dispense.id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, r.dispense.id, { lines: [{ lineIdx: 0, qtyBase: 20 }] }, MON2);
    return r.dispense.id;
  }

  it("moves the holder, keeps the lines, records from whom and why, and needs a reason", async () => {
    const id = await claimedAndVerified();
    await expect(takeOverDispense(db, fx.incharge.actor, id, " ", MON2)).rejects.toMatchObject({ code: "reason_required" });

    const view = await takeOverDispense(db, fx.incharge.actor, id, "colleague left the desk", MON2);

    expect(view.claimedBy).toBe(fx.incharge.id);
    expect(view.status).toBe("verified");
    expect(view.lines.map((l) => l.qtyBase)).toEqual([20]);
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.taken_over"));
    expect(ev?.payload).toEqual({ dispenseId: id, patientId: view.patient.id, fromUserId: fx.pharmacist.id, toUserId: fx.incharge.id, status: "verified", reason: "colleague left the desk" });
    // Taking over your own ticket changes nothing and records nothing.
    await takeOverDispense(db, fx.incharge.actor, id, "again", MON2);
    expect(await db.select().from(events).where(eq(events.name, "dispense.taken_over"))).toHaveLength(1);
  });

  it("works up to the bill, and never after the hand-over", async () => {
    const id = await claimedAndVerified();
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await takeOverDispense(db, fx.incharge.actor, id, "shift change", MON2);
    // Back to the registered pharmacist, who hands it over.
    await takeOverDispense(db, fx.pharmacist.actor, id, "back at the desk", MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    await expect(takeOverDispense(db, fx.incharge.actor, id, "too late", MON3)).rejects.toMatchObject({ code: "dispense_not_in_state" });
    const [row] = await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id));
    expect(row?.claimedBy).toBe(fx.pharmacist.id);
  });
});
