import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { MON2, issueRx, line, reissueRx, seedPharmacyBase } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { orders, pharmacyDispenses } from "../../kernel/db/schema";
import { claimDispense, findAtCounter } from "./claim";
import { listQueue } from "./queue";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * PD-2 — OWNER RULING 2026-09-19: "give each ticket its P-number when it's queued."
 *
 * The number used to be minted at the CHECK (verify), as the medication order's number, so a
 * waiting ticket had none and the queue could not call anybody by it. It is minted now when the
 * ticket is queued, and the order placed at the check carries THAT number — one number per
 * dispense, from the window to the bill.
 */
describe("the ticket's P-number, from the moment it is queued (PD-2)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); fx = await seedPharmacyBase(db); });
  afterEach(() => { fx.unregister(); });

  const P = /^P\d{6}\d{4}$/;
  async function queued(lines = [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]): Promise<{ id: string; encounterId: string }> {
    const { issued, encounter } = await issueRx(db, fx, lines);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("expected a dispense");
    return { id: r.dispense.id, encounterId: encounter.id };
  }
  const numberOf = async (id: string): Promise<string | null> =>
    (await db.select({ n: pharmacyDispenses.dispenseNo }).from(pharmacyDispenses).where(eq(pharmacyDispenses.id, id)))[0]!.n;

  it("a queued ticket already has its P-number, and the queue shows it", async () => {
    const { id } = await queued();
    const n = await numberOf(id);
    expect(n).toMatch(P);
    const row = (await listQueue(db, fx.pharmacist.actor, { serviceDate: "2026-08-17" }, MON2)).find((r) => r.dispenseId === id);
    expect(row).toMatchObject({ status: "queued", dispenseNo: n });
  });

  it("the check places the medication order under THAT number, and mints no second one", async () => {
    const first = await queued();
    const n = await numberOf(first.id);
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: first.id, door: "rx_qr" }, MON2);
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, first.id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    expect(v.dispenseNo).toBe(n);
    const [order] = await db.select().from(orders).where(eq(orders.id, v.orderId!));
    expect(order!.orderNo).toBe(n);
    // the series moved once for that ticket: the next ticket takes the very next serial
    const second = await queued([line({ drug: "Calpol 500", medicineId: fx.med.calpol })]);
    expect(Number((await numberOf(second.id))!.slice(-4))).toBe(Number(n!.slice(-4)) + 1);
  });

  it("a ticket superseded while waiting keeps its number, cancelled; its replacement takes the next", async () => {
    const first = await queued();
    const n1 = await numberOf(first.id);
    const v2 = await reissueRx(db, fx, first.encounterId, [line({ drug: "Calpol 500", medicineId: fx.med.calpol })], { at: MON2 });
    await findAtCounter(db, testCfg, fx.pharmacist.actor, v2.qrPayload, MON2); // v2 queued: v1 superseded
    const all = await db.select().from(pharmacyDispenses).where(eq(pharmacyDispenses.encounterId, first.encounterId));
    expect(all.find((d) => d.id === first.id)).toMatchObject({ status: "cancelled", dispenseNo: n1 });
    const replacement = all.find((d) => d.id !== first.id)!;
    expect(replacement.status).toBe("queued");
    expect(Number(replacement.dispenseNo!.slice(-4))).toBe(Number(n1!.slice(-4)) + 1);
  });

  it("a ticket queued before PD-2 carries no number, and is numbered at the check exactly as before", async () => {
    const { id } = await queued();
    await db.update(pharmacyDispenses).set({ dispenseNo: null }).where(eq(pharmacyDispenses.id, id));
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    const v = await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: 15 }] }, MON2);
    expect(v.dispenseNo).toMatch(P);
    expect(await numberOf(id)).toBe(v.dispenseNo);
  });
});

