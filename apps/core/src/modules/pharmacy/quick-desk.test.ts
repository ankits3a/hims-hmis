import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, openVisitWithoutRx, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { events, pharmacyRegH1 } from "../../kernel/db/schema";
import { withTx } from "../../kernel/db/client";
import { billDispense, previewDispenseBill } from "./bill";
import { handOverDispense } from "./handover";
import { enterPaperPrescription } from "./paper-rx";
import { pickDispense } from "./pick";
import { loadPharmacySettings, updatePharmacySettings } from "./settings";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

class FakeStore implements DocumentStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> { this.files.set(key, bytes); }
  async get(key: string): Promise<Buffer> {
    const b = this.files.get(key);
    if (b === undefined) throw new Error("not found");
    return b;
  }
  async remove(key: string): Promise<void> { this.files.delete(key); }
}
const RX_DATE = "2026-08-17"; // MON in IST

/**
 * OWNER RULING 2026-10-02 — QUICK DESK MODE (`settings.ts`). `fx.incharge` holds the pharmacy role and
 * has NO state-council registration on file: the person the three checks stop while the mode is off.
 */
describe("quick desk mode (owner ruling 2026-10-02)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let store: FakeStore;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    store = new FakeStore();
    await openSessionFor(db, { id: fx.incharge.id }, 0);
    await stockIn(db, fx, { itemId: fx.item.azithro, batchNo: "AZ-1", expiryDate: "2027-06-30", qtyBase: 30, mrpPaise: 15000 });
    await grantPermissionToRole(db, fx.registry, "pharmacy", "pharmacy.licences.manage");
    await openVisitWithoutRx(db, fx);
  });
  afterEach(() => { fx.unregister(); });

  const h1 = () => ({ patientId: fx.patient.id, rxDate: RX_DATE, lines: [{ itemId: fx.item.azithro, qtyBase: 3 }] });
  const turn = (on: boolean, at: Date = MON2) => withTx(db, (tx) => updatePharmacySettings(tx, fx.incharge.actor, { quickDesk: on }, at));

  it("is off until somebody turns it on; only pharmacy.licences.manage may; every change is audited, a no-op is not", async () => {
    expect(await loadPharmacySettings(db)).toEqual({ quickDesk: false, updatedBy: null, updatedAt: null });
    await expect(withTx(db, (tx) => updatePharmacySettings(tx, fx.aide.actor, { quickDesk: true }, MON2)))
      .rejects.toThrow(expect.objectContaining({ code: "permission_denied" }));
    expect((await turn(true)).quickDesk).toBe(true);
    await turn(true);
    await turn(false, MON3);
    const changes = (await db.select().from(events).where(eq(events.name, "pharmacy_settings.changed"))).map((e) => e.payload);
    expect(changes).toEqual([{ setting: "quick_desk", from: false, to: true }, { setting: "quick_desk", from: true, to: false }]);
  });

  it("OFF: the photo, the registration and the slip confirm each stop an unregistered person", async () => {
    await expect(enterPaperPrescription(db, testCfg, store, fx.incharge.actor, h1(), MON2))
      .rejects.toThrow(expect.objectContaining({ code: "prescription_required" }));
    const photo = { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]) };
    const d = await enterPaperPrescription(db, testCfg, store, fx.incharge.actor, { ...h1(), photo }, MON2);
    await expect(verifyDispense(db, fx.incharge.actor, fx.decls, d.id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2))
      .rejects.toThrow(expect.objectContaining({ code: "pharmacist_not_registered" }));
  });

  it("ON: an unregistered person with the desk's permissions enters a Schedule H1 paper with no photo, verifies, bills with no slip confirm, and hands over; the H1 register is still written", async () => {
    await turn(true);
    const d = await enterPaperPrescription(db, testCfg, store, fx.incharge.actor, h1(), MON2);
    await verifyDispense(db, fx.incharge.actor, fx.decls, d.id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
    await pickDispense(db, fx.incharge.actor, fx.decls, d.id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.incharge.actor, d.id, MON2);
    await billDispense(db, fx.incharge.actor, d.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    const h = await handOverDispense(db, fx.incharge.actor, fx.decls, d.id, { identity: { via: "phone_last4", value: "3210" } }, MON3);
    expect(h.status).toBe("handed_over");
    const reg = await db.select().from(pharmacyRegH1);
    expect(reg.map((r) => [r.prescriberRegNo, r.qtyBase, r.batchNo])).toEqual([["BMC/12345", 3, "AZ-1"]]);
  });

  it("ON: the permission still decides — a login without pharmacy.dispense.scheduled does not hand a Schedule H1 line over", async () => {
    await turn(true);
    const d = await enterPaperPrescription(db, testCfg, store, fx.incharge.actor, h1(), MON2);
    await verifyDispense(db, fx.incharge.actor, fx.decls, d.id, { lines: [{ lineIdx: 0, qtyBase: 3 }] }, MON2);
    await pickDispense(db, fx.incharge.actor, fx.decls, d.id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.incharge.actor, d.id, MON2);
    await billDispense(db, fx.incharge.actor, d.id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    await expect(handOverDispense(db, fx.aide.actor, fx.decls, d.id, { identity: { via: "phone_last4", value: "3210" } }, MON3))
      .rejects.toThrow(expect.objectContaining({ code: "scheduled_needs_pharmacist" }));
  });
});
