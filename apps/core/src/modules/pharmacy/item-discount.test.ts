import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { testCfg } from "../../../test/helpers/opd";
import { withTx } from "../../kernel/db/client";
import { creditNotes, events, invoiceLines, invoices, pharmacySaleItems } from "../../kernel/db/schema";
import { ITEM_DISCOUNT_SOURCE_KEY, SALE_DISCOUNT_SOURCE_KEY } from "../billing";
import { registerPharmacyApprovalTypes } from "./approval-types";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { PharmacyError } from "./errors";
import { pickDispense } from "./pick";
import { cancelBilledDispense } from "./refund";
import { listSaleItems, setSaleItemDiscount } from "./sale-items";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * OWNER 2026-10-02 — "standing patient discount per item". The in-charge sets a discount on a sale item; every
 * bill line of that item then carries it as its own discount, with no approval at the counter. It competes
 * with the counter's per-bill discount on the same line and the larger one wins: nothing stacks.
 */
describe("the standing discount on a pharmacy sale item (owner 2026-10-02)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await registerPharmacyApprovalTypes(db, fx.base.activator);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    // ₹22.40 a strip of 10: 224 paise a tablet, so 15 tablets are ₹33.60.
    await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "CR-1", qtyBase: 200, mrpPaise: 2240 });
  });
  afterEach(() => { fx.unregister(); });

  async function picked(qty = 15): Promise<string> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    return id;
  }
  const setDiscount = (bps: number) => withTx(db, (tx) => setSaleItemDiscount(tx, fx.incharge.actor, fx.item.crocin, bps));
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof PharmacyError) return e.code; throw e; }
    return "did not refuse";
  };
  const linesOfInvoice = (invoiceId: string) => db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
  const sum = (rows: readonly { discountPaise: number }[]) => rows.reduce((n, l) => n + l.discountPaise, 0);

  it("15% on the item: the preview and the bill take ₹5.04 off ₹33.60, as the line's own discount, with no approval and no counter ask", async () => {
    await setDiscount(1500);
    expect((await listSaleItems(db)).find((s) => s.itemId === fx.item.crocin)?.discountBps).toBe(1500);
    const id = await picked();
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { tender: "upi" });
    expect(preview.totals).toMatchObject({ grossPaise: 3360, netPayablePaise: 2856 });
    expect(sum(preview.lines)).toBe(504);

    const billed = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "upi", amountPaise: 2856, refText: "UTR-1" }] }, MON2);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, billed.invoiceId!));
    expect(inv).toMatchObject({ netPayablePaise: 2856, roundingPaise: 0 });
    const rows = await linesOfInvoice(billed.invoiceId!);
    expect(sum(rows)).toBe(504);
    expect(rows.filter((l) => l.discountPaise > 0).map((l) => (l.winner as { sourceKey: string } | null)?.sourceKey)).toEqual(rows.filter((l) => l.discountPaise > 0).map(() => ITEM_DISCOUNT_SOURCE_KEY));

    // A full cancel credits what was paid, not the MRP.
    const cancelled = await cancelBilledDispense(db, fx.pharmacist.actor, fx.decls, id, { reason: "patient bought it outside", reasonClass: "genuine" }, MON3);
    const [note] = await db.select().from(creditNotes).where(eq(creditNotes.id, cancelled.creditNoteId));
    expect(note).toMatchObject({ invoiceId: billed.invoiceId, netPaise: 2856 });
  });

  it("the larger discount wins on the line and nothing stacks: a counter 10% loses to a standing 15%, and beats a standing 5%", async () => {
    await setDiscount(1500);
    const first = await picked();
    const ask = { kind: "percent_bps" as const, value: 1000, reason: "regular patient" };
    // The counter's 10% takes nothing here: the judged amount is zero, so it needs nobody's approval and the bill issues.
    expect((await previewDispenseBill(db, fx.pharmacist.actor, first, MON2, { tender: "upi", discount: ask })).discount).toMatchObject({ amountPaise: 0, tier: "pharmacist" });
    const a = await billDispense(db, fx.pharmacist.actor, first, { tenders: [{ mode: "upi", amountPaise: 2856, refText: "UTR-2" }], discount: ask }, MON2);
    expect(sum(await linesOfInvoice(a.invoiceId!))).toBe(504);

    await setDiscount(500);
    const second = await picked();
    const b = await billDispense(db, fx.pharmacist.actor, second, { tenders: [{ mode: "upi", amountPaise: 3024, refText: "UTR-3" }], discount: ask }, MON2);
    const rows = await linesOfInvoice(b.invoiceId!);
    expect(sum(rows)).toBe(336); // 10% of ₹33.60, not 10% + 5%
    expect(new Set(rows.filter((l) => l.discountPaise > 0).map((l) => (l.winner as { sourceKey: string }).sourceKey))).toEqual(new Set([SALE_DISCOUNT_SOURCE_KEY]));
  });

  it("removing it restores the MRP; the limit is 25%, whole basis points, and only a sale item has one; every change is an event", async () => {
    await setDiscount(1500);
    await setDiscount(0);
    const id = await picked();
    expect((await previewDispenseBill(db, fx.pharmacist.actor, id, MON2, { tender: "upi" })).totals).toMatchObject({ grossPaise: 3360, netPayablePaise: 3360 });

    await setDiscount(2500);
    for (const bps of [2501, -1, 12.5]) expect(await code(setDiscount(bps))).toBe("standing_discount_refused");
    expect(await code(withTx(db, (tx) => setSaleItemDiscount(tx, fx.incharge.actor, "01HNOTASALEITEM00000000001", 500)))).toBe("unknown_sale_item");
    await setDiscount(2500); // the same value again: nothing changes and nothing is recorded
    // The database holds the limit too.
    await expect(db.update(pharmacySaleItems).set({ discountBps: 2501 }).where(eq(pharmacySaleItems.itemId, fx.item.crocin))).rejects.toThrow();

    const said = await db.select().from(events).where(eq(events.name, "sale_item.discount_set"));
    expect(said.map((e) => [(e.payload as { fromBps: number }).fromBps, (e.payload as { toBps: number }).toBps])).toEqual([[0, 1500], [1500, 0], [0, 2500]]);
  });
});
