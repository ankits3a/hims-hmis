import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
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
import { pharmacyCreditOf } from "./store-credit";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ OWNER RULING 2026-10-02 — PHARMACY CREDIT ═══
 *
 * A return kept as credit instead of refunded: no approval, no money out; the next pharmacy bill spends
 * it first and the patient pays only the difference; what is left stays (`store-credit.ts`).
 */
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number): Date => new Date(MON3.getTime() + days * DAY);

describe("pharmacy credit kept from a return (owner ruling 2026-10-02)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
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

  it("a return kept as credit asks for no refund: the credit note's amount becomes the patient's pharmacy credit", async () => {
    const { id, paid } = await sold();
    const out = await takeBack(id, 10, "credit");
    expect(out.refundApprovalId).toBeNull();
    expect(out.creditNotePaise).toBe(paid / 2);
    expect(out.creditKeptPaise).toBe(paid / 2);
    expect(await db.select().from(approvals).where(eq(approvals.typeKey, "billing_refund"))).toHaveLength(0); // nothing to approve: no money leaves
    expect((await listCreditNotes(db)).map((n) => [n.kind, n.netPaise])).toEqual([["refund", paid / 2]]);
    expect((await pharmacyCreditOf(db, fx.patient.id)).availablePaise).toBe(paid / 2);
    expect(await advanceOf(db, fx.patient.id)).toBe(paid / 2);
    // the old bill is still settled — by what was kept of it and what was credited — and owes nobody a refund
    const invoiceId = (await getDispenseRow(db, id)).invoiceId!;
    expect(await invoiceSettlement(db, invoiceId)).toMatchObject({ state: "settled", outstandingPaise: 0 });
    const [ev] = await db.select().from(events).where(eq(events.name, "dispense.line_returned"));
    expect(ev?.payload).toMatchObject({ refundApprovalId: null, creditKeptPaise: paid / 2 });
  });

  it("the default is still a refund request, and it leaves no credit", async () => {
    const { id, paid } = await sold();
    const out = await takeBack(id, 10, "refund");
    expect(out.refundApprovalId).toEqual(expect.any(String));
    expect(out.creditKeptPaise).toBe(0);
    expect((await pharmacyCreditOf(db, fx.patient.id)).availablePaise).toBe(0);
    expect(await advanceOf(db, fx.patient.id)).toBe(0);
    const [approval] = await db.select().from(approvals).where(eq(approvals.typeKey, "billing_refund"));
    expect(approval).toMatchObject({ typeKey: "billing_refund", amountPaise: paid / 2 });
  });

  it("a bigger purchase spends the credit first and takes only the difference; the paper says both", async () => {
    const { id, paid } = await sold();
    await takeBack(id, 10, "credit");
    const credit = paid / 2;

    const next = await picked(20, later(2));
    expect((await previewDispenseBill(db, fx.pharmacist.actor, next.id, later(2))).creditAvailablePaise).toBe(credit);
    // more credit than the book holds is refused, and nothing is billed
    await expect(billDispense(db, fx.pharmacist.actor, next.id, { useCreditPaise: credit + 100, tenders: [{ mode: "cash", amountPaise: next.net - credit - 100 }] }, later(2)))
      .rejects.toThrow(expect.objectContaining({ code: "credit_not_available" }));
    const billed = await billDispense(db, fx.pharmacist.actor, next.id, { useCreditPaise: credit, tenders: [{ mode: "cash", amountPaise: next.net - credit }] }, later(2));
    expect(billed.status).toBe("billed");
    expect(await invoiceSettlement(db, billed.invoiceId!)).toMatchObject({ state: "settled", outstandingPaise: 0 });
    expect((await pharmacyCreditOf(db, fx.patient.id)).availablePaise).toBe(0);
    expect(await advanceOf(db, fx.patient.id)).toBe(0);
    expect((await db.select().from(pharmacyCreditMoves)).map((m) => [m.kind, m.amountPaise]).sort()).toEqual([["kept", credit], ["used", credit]]);

    const closing = await closingFor(db, fx.pharmacist.actor, next.id);
    expect(closing.money).toMatchObject({ creditUsedPaise: credit, tenders: [{ mode: "cash", amountPaise: next.net - credit }] });
    const paper = await dispensePaper(db, fx.pharmacist.actor, next.id, later(2));
    expect(paper.html).toContain("Credit from earlier return");
    expect(paper.html).toContain("Balance paid");
  });

  it("a smaller purchase is paid wholly from credit with no tender, and what is left stays as credit", async () => {
    const { id, paid } = await sold();
    await takeBack(id, 20, "credit"); // the whole bill back: credit = paid
    const next = await picked(5, later(2));
    expect(next.net).toBeLessThan(paid);
    const billed = await billDispense(db, fx.pharmacist.actor, next.id, { useCreditPaise: next.net, tenders: [] }, later(2));
    expect(await invoiceSettlement(db, billed.invoiceId!)).toMatchObject({ state: "settled" });
    expect((await pharmacyCreditOf(db, fx.patient.id)).availablePaise).toBe(paid - next.net);
    expect(await advanceOf(db, fx.patient.id)).toBe(paid - next.net);
    expect((await closingFor(db, fx.pharmacist.actor, next.id)).money).toMatchObject({ creditUsedPaise: next.net, tenders: [], receiptNo: null });
  });

  it("the same money is never both: after a refund REQUEST and a kept credit on one bill, the credit is only the kept half", async () => {
    const { id, paid } = await sold();
    await takeBack(id, 10, "refund");
    await takeBack(id, 10, "credit");
    expect((await pharmacyCreditOf(db, fx.patient.id)).availablePaise).toBe(paid / 2);
    expect(await advanceOf(db, fx.patient.id)).toBe(paid / 2);
  });
});
