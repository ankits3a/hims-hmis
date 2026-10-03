import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { approvals, events, pharmacyCreditMoves } from "../../kernel/db/schema";
import { advanceOf, invoiceSettlement, listCreditNotes } from "../billing";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { closingFor } from "./closing";
import { handOverDispense } from "./handover";
import { pickDispense } from "./pick";
import { dispensePaper } from "./print";
import { getDispenseRow } from "./queue";
import { acceptReturn } from "./returns";
import { creditNoteRegister, patientCredit } from "./credit-notes";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * Owner 2026-10-03 — which patient was given a credit note in a range, the total, and on the patient's
 * profile the credit available in their name (`credit-notes.ts`).
 */
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number): Date => new Date(MON3.getTime() + days * DAY);

describe("the credit note register and a patient's credit (owner 2026-10-03)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let reader: { actor: { type: "user"; id: string } };

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.reports.read");
    reader = await mkUser(db, "ph.reports", ["pharmacy_incharge"]) as typeof reader;
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 200, expiryDate: "2027-12-31", mrpPaise: 12000, at: MON });
  });
  afterEach(() => { fx.unregister(); });

  /** A ticket of `qty` Crocin tablets, picked and priced: its id and what it costs. */
  async function picked(qty: number, at: Date = MON2): Promise<{ id: string; net: number }> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })], { at });
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, at);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, at);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, at);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, at);
    return { id, net: (await previewDispenseBill(db, fx.pharmacist.actor, id, at)).totals.netPayablePaise };
  }
  /** Twenty tablets, paid in cash and handed over at MON3. */
  async function sold(): Promise<{ id: string; paid: number }> {
    const t = await picked(20);
    await billDispense(db, fx.pharmacist.actor, t.id, { tenders: [{ mode: "cash", amountPaise: t.net }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, t.id, {}, MON3);
    return { id: t.id, paid: t.net };
  }
  const takeBack = (id: string, qtyBase: number, settle: "refund" | "credit") => acceptReturn(db, fx.pharmacist.actor, fx.decls, id, {
    lines: [{ lineIdx: 0, qtyBase }], sealedIntact: true, reason: "the doctor changed the medicine", reasonClass: "genuine", settle,
  }, later(1));

  it("lists each credit note with its patient, its value and what became of the money, and totals the range", async () => {
    const { id, paid } = await sold();
    const kept = await takeBack(id, 10, "credit");
    const refunded = await takeBack(id, 10, "refund");

    const reg = await creditNoteRegister(db, reader.actor, { preset: "week" }, later(1));

    expect(reg.rows.map((r) => [r.creditNoteNo, r.uhid, r.netPaise, r.settlement])).toEqual([
      [kept.creditNoteNo, expect.any(String), paid / 2, "kept_as_credit"],
      [refunded.creditNoteNo, expect.any(String), paid / 2, "refund_requested"],
    ]);
    expect(reg.rows[0]!.patientId).toBe(fx.patient.id);
    expect(reg.rows[1]!.reason).toBe("pharmacy return: the doctor changed the medicine");
    expect(reg.totals).toEqual({ count: 2, netPaise: paid, keptPaise: paid / 2, refundRequestedPaise: paid / 2, refundPaidPaise: 0 });
    expect(reg.byPatient).toEqual([expect.objectContaining({ patientId: fx.patient.id, count: 2, netPaise: paid, keptPaise: paid / 2, refundPaise: paid / 2 })]);
    // A day with none is an empty register, not an error.
    expect((await creditNoteRegister(db, reader.actor, { preset: "custom", from: "2026-01-01", to: "2026-01-02" }, later(1))).totals.count).toBe(0);
  });

  it("the patient's profile reads every credit note on their bills and the pharmacy credit available now", async () => {
    const { id, paid } = await sold();
    await takeBack(id, 10, "credit");
    await takeBack(id, 10, "refund");

    const mine = await patientCredit(db, reader.actor, fx.patient.id);

    expect(mine.availablePaise).toBe(paid / 2);
    expect(mine.totalAvailablePaise).toBe(paid / 2); // the kept half is the patient's credit with the hospital
    expect(mine.notes.map((n) => n.categories)).toEqual([["pharmacy"], ["pharmacy"]]);
    expect(mine.refunds).toEqual([]); // the other half is only requested: no voucher yet
    expect(mine.totalNetPaise).toBe(paid);
    expect(mine.notes.map((n) => n.settlement).sort()).toEqual(["kept_as_credit", "refund_requested"]);
  });
});
