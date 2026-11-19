import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { creditNotes, pharmacyRetailSaleLines } from "../../kernel/db/schema";
import { issueCreditNote } from "../billing";
import { createStore, postMovement } from "../materials";
import { RETAIL_PHARMACY_STORE_CODE } from "./config";
import { pharmacyExceptionsOn } from "./exceptions";
import { recordRetailLicence, sellRetail } from "./retail";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Actor } from "@hmis/contracts";
import type { Db } from "../../kernel/db/client";
import type { DocumentStore } from "../../kernel/documents/store";

/**
 * #1065 follow-up — THE SAME MONEY IS COUNTED ONCE, AND A ROW SAYS WHERE ITS RECORD IS.
 *
 * A refund at the billing desk with nothing returned is a credit note (a `refund` row) AND, to the leakage auditor,
 * units that left the shelf unpaid (a `leakage` mismatch). Both are listed; the leakage line points at the refund that
 * carries its money and is left out of the day's count and total, so the owner's digest says the money once. A
 * leakage line with no such refund (stock used outside any sale) is counted as before.
 *
 * Every row also carries its record's own reference and the rights that open its link, so the page can show the
 * reference as text to a viewer who cannot open the screen. Every clock here is injected (the walk-in counter, the
 * credit note, the ledger, the leakage window): the day is the fixture's Monday.
 */
const DAY = "2026-08-17";
const HEAD: Actor = { type: "user", id: "01HMATERIALSHEAD00000000001" };
const docs: DocumentStore = { put: async () => {}, get: async () => Buffer.alloc(0), remove: async () => {} };

describe("pharmacy exceptions — counted once, and a reference for every row (#1065)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let fx: PharmacyFixture;
  let retailId: string;
  let batchId: string;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    fx = await seedPharmacyBase(db);
    await openSessionFor(db, { id: fx.pharmacist.id }, 0);
    ({ resourceId: retailId } = await withTx(db, (tx) => createStore(tx, HEAD, { code: RETAIL_PHARMACY_STORE_CODE, name: "Walk-in retail pharmacy" })));
    await ensureRole(db, "pharmacy_incharge");
    await grantPermissionToRole(db, fx.registry, "pharmacy_incharge", "pharmacy.retail.manage");
    const licensee = await mkUser(db, "ph.licensee", ["pharmacy_incharge"]);
    await recordRetailLicence(db, licensee.actor, {
      form20No: "RLF20-MH-PUN-1001", form21No: "RLF21-MH-PUN-1001", validFrom: "2026-01-01", validTo: "2030-12-31", pharmacistInCharge: "A. Kulkarni",
    }, MON);
    batchId = await stockIn(db, fx, { itemId: fx.item.crocin, batchNo: "R-1", qtyBase: 100, expiryDate: "2027-12-31", resourceId: retailId });
  });
  afterEach(() => { fx.unregister(); });

  it("a billing-desk refund with nothing returned is one refund row; its leakage line points at it and is not counted again", async () => {
    // Ten tablets sold (₹12 each), three refunded at the billing desk, nothing came back to the shelf.
    const sale = await sellRetail(db, docs, fx.pharmacist.actor, {
      customer: { existingId: fx.patient.id }, lines: [{ medicineId: fx.med.crocin, qtyBase: 10 }], tenders: [{ mode: "cash", amountPaise: 12_000 }],
    }, undefined, MON2);
    const [line] = await db.select().from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.saleId, sale.id));
    const note = await issueCreditNote(db, fx.pharmacist.actor, {
      kind: "refund", invoiceId: sale.invoiceId, reason: "customer complained", lines: [{ invoiceLineId: line!.invoiceLineId, qty: 3 }],
    }, MON3);
    const [cn] = await db.select({ netPaise: creditNotes.netPaise }).from(creditNotes).where(eq(creditNotes.id, note.creditNoteId));
    // Four tablets out of the retail store with no sale behind them: leakage with no refund to explain it.
    await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
      resourceId: retailId, batchId, qtyDelta: -4, reason: "consume", refType: "staff_sample", refId: "slip-9", occurredAt: MON3,
    }));

    const d = await pharmacyExceptionsOn(db, DAY);
    const refund = d.rows.find((r) => r.kind === "refund")!;
    expect(refund).toMatchObject({ paise: cn!.netPaise, sameMoneyAs: null, ref: sale.invoiceNo });
    const leaks = d.rows.filter((r) => r.kind === "leakage");
    expect(leaks).toHaveLength(2);
    const explained = leaks.find((r) => r.what.includes("not billed"))!;
    const used = leaks.find((r) => r.what.includes("outside a sale"))!;
    expect(explained).toMatchObject({ paise: 3 * 1_200, sameMoneyAs: refund.id });
    expect(used).toMatchObject({ paise: 4 * 500, sameMoneyAs: null });

    // The money once: the refund and the unexplained leakage, not the refund's own units again.
    expect(d.count).toBe(2);
    expect(d.totalPaise).toBe(cn!.netPaise + 4 * 500);
    expect(d.totals.find((t) => t.kind === "leakage")).toEqual({ kind: "leakage", count: 1, paise: 4 * 500 });
    expect(d.totals.find((t) => t.kind === "refund")).toEqual({ kind: "refund", count: 1, paise: cn!.netPaise });
  });

  it("every row names its record and the rights that open its screen", async () => {
    const sale = await sellRetail(db, docs, fx.pharmacist.actor, {
      customer: { existingId: fx.patient.id }, lines: [{ medicineId: fx.med.crocin, qtyBase: 10 }], tenders: [{ mode: "cash", amountPaise: 12_000 }],
    }, undefined, MON2);
    const [line] = await db.select().from(pharmacyRetailSaleLines).where(eq(pharmacyRetailSaleLines.saleId, sale.id));
    await issueCreditNote(db, fx.pharmacist.actor, {
      kind: "refund", invoiceId: sale.invoiceId, reason: "customer complained", lines: [{ invoiceLineId: line!.invoiceLineId, qty: 10 }],
    }, MON3);
    await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
      resourceId: retailId, batchId, qtyDelta: -2, reason: "consume", refType: "staff_sample", refId: "slip-9", occurredAt: MON3,
    }));

    const d = await pharmacyExceptionsOn(db, DAY);
    // A walk-in bill's credit note with no refund ask: the credit-note register, a reports reader's screen.
    expect(d.rows.find((r) => r.kind === "refund")).toMatchObject({
      ref: sale.invoiceNo, link: "/pharmacy/office?view=reports&page=reports", linkNeeds: ["pharmacy.reports.read"],
    });
    // Leakage opens the auditor, which the billing office's reports right opens; the reference is the slip.
    expect(d.rows.find((r) => r.what.includes("outside a sale"))).toMatchObject({
      ref: "staff_sample slip-9", link: "/pharmacy/leakage", linkNeeds: ["billing.reports.read"],
    });
    for (const r of d.rows) {
      expect(r.ref.length).toBeGreaterThan(0);
      expect(r.linkNeeds.length).toBeGreaterThan(0);
    }
  });
});
