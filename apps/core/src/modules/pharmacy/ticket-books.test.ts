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
import { gstBook, patientPharmacyBills, ticketInvoices } from "./ticket-books";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * Owner 2026-10-03 — which patient was given a credit note in a range, the total, and on the patient's
 * profile the credit available in their name (`credit-notes.ts`).
 */
const DAY = 24 * 60 * 60 * 1000;
const later = (days: number): Date => new Date(MON3.getTime() + days * DAY);

describe("tickets and invoices, the GST book, the patient's pharmacy bills (owner 2026-10-03)", () => {
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

  it("each ticket's bill carries its GST, the credit notes against it, and the earlier credit spent on it", async () => {
    const { a, b } = await returnedThenSpent();
    const t = await ticketInvoices(db, reader.actor, { preset: "custom", from: "2026-01-01", to: "2026-12-31" }, later(2));
    expect(t.rows).toHaveLength(2);
    const [first, second] = t.rows;
    expect(first!.ticket).toMatch(/^P/);
    expect(first!.netPaise).toBe(a.net);
    expect(first!.creditNotes).toHaveLength(1);
    expect(first!.finalPaise).toBe(0); // all of it came back
    expect(second!.netPaise).toBe(b.net);
    expect(second!.creditUsedPaise).toBe(a.net);
    expect(t.totals).toMatchObject({ bills: 2, netPaise: a.net + b.net, returnedPaise: a.net, finalPaise: b.net, creditUsedPaise: a.net });
  });

  it("the GST book: rate-wise sales less returns is the tax owed once; the credit spent is a payment, apart from the tax", async () => {
    const { a, b } = await returnedThenSpent();
    const g = await gstBook(db, reader.actor, { preset: "custom", from: "2026-01-01", to: "2026-12-31" }, later(2));
    const tax = (m: { cgstPaise: number; sgstPaise: number }): number => m.cgstPaise + m.sgstPaise;
    expect(g.rates).toHaveLength(1);
    expect(g.totals.sales.netPaise).toBe(a.net + b.net);
    expect(g.totals.returns.netPaise).toBe(a.net);
    expect(tax(g.totals.net)).toBe(tax(g.totals.sales) - tax(g.totals.returns));
    expect(tax(g.totals.net) * 3).toBe(tax(g.totals.sales) * 2); // net tax is the second bill's alone: 2 of 3 parts
    expect(g.creditNotes).toHaveLength(1);
    expect(g.creditNotes[0]!.invoiceNo).not.toBe("");
    expect(g.creditNotes[0]!.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(g.money).toEqual({ billedPaise: a.net + b.net, paidFromCreditPaise: a.net, outstandingPaise: 0, collectedPaise: b.net });
  });

  it("the patient's pharmacy bills, newest first, each with its ticket and credit notes", async () => {
    const { a, b } = await returnedThenSpent();
    const { bills } = await patientPharmacyBills(db, reader.actor, fx.patient.id);
    expect(bills.map((x) => [x.netPaise, x.creditNotes.length, x.creditUsedPaise])).toEqual([[b.net, 0, a.net], [a.net, 1, 0]]);
    expect(bills.every((x) => x.ticket !== null && x.source === "dispense")).toBe(true);
  });
});
