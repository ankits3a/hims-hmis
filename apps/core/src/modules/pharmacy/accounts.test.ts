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
import { pharmacyAccounts } from "./accounts";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * Owner 2026-10-03 — which patient was given a credit note in a range, the total, and on the patient's
 * profile the credit available in their name (`credit-notes.ts`).
 */
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number): Date => new Date(MON3.getTime() + days * DAY);

describe("the pharmacy accounts for the CA (owner 2026-10-03)", () => {
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

  /* The owner's case: a bill returned as credit, then a bigger bill paid partly from that credit. */
  async function returnedThenSpent(): Promise<{ a: { id: string; net: number }; b: { id: string; net: number } }> {
    const a = await picked(10);
    await billDispense(db, fx.pharmacist.actor, a.id, { tenders: [{ mode: "cash", amountPaise: a.net }] }, MON2);
    await handOverDispense(db, fx.pharmacist.actor, fx.decls, a.id, {}, MON3);
    await takeBack(a.id, 10, "credit");
    const b = await picked(20, later(2));
    await billDispense(db, fx.pharmacist.actor, b.id, { useCreditPaise: a.net, tenders: [{ mode: "cash", amountPaise: b.net - a.net }] }, later(2));
    return { a, b };
  }

  it("one period: sales less credit notes, output GST, money in by tender and from credit, the credit book, and every document in time order", async () => {
    const { a, b } = await returnedThenSpent();
    const acc = await pharmacyAccounts(db, reader.actor, { preset: "custom", from: "2026-01-01", to: "2026-12-31" }, later(2));
    expect(acc.sales.count).toBe(2);
    expect(acc.sales.netPaise).toBe(a.net + b.net);
    expect(acc.returns.netPaise).toBe(a.net);
    expect(acc.netSalesPaise).toBe(b.net);
    const tax = (s: { cgstPaise: number; sgstPaise: number }): number => s.cgstPaise + s.sgstPaise;
    expect(acc.gst.outputPaise).toBe(tax(acc.sales) - tax(acc.returns));
    expect(acc.gst.netPayablePaise).toBe(acc.gst.outputPaise - acc.gst.inputPaise);
    // the money actually taken: the first bill's cash, then only the difference on the second
    expect(acc.moneyIn.totalPaise).toBe(b.net);
    expect(acc.moneyIn.cashPaise).toBe(b.net);
    expect(acc.moneyIn.fromCreditPaise).toBe(a.net);
    expect(acc.moneyIn.outstandingPaise).toBe(0);
    expect(acc.credit).toEqual({ keptPaise: a.net, usedPaise: a.net, heldNowPaise: 0 });
    expect(acc.moneyOut.totalPaise).toBe(0);
    expect(acc.documents.map((d) => d.type)).toEqual(["bill", "credit_note", "credit_kept", "bill", "credit_used"]);
    expect(acc.documents.every((d) => d.by !== "")).toBe(true);
  });
});
