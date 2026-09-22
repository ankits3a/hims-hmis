import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { openSessionFor } from "../../../test/helpers/billing";
import { MON, MON2, MON3, issueRx, line, seedPharmacyBase, stockIn } from "../../../test/helpers/pharmacy";
import { ensureRole, mkUser, testCfg } from "../../../test/helpers/opd";
import { grantPermissionToRole } from "../../kernel/auth/permissions";
import { withTx } from "../../kernel/db/client";
import { enteredInErrorMarks, pharmacyDispenseLines } from "../../kernel/db/schema";
import { issueCreditNote } from "../billing";
import { balances, countSheet, postMovement, scheduleCount, submitCount } from "../materials";
import { billDispense, previewDispenseBill } from "./bill";
import { claimDispense, findAtCounter } from "./claim";
import { handOverDispense } from "./handover";
import { pharmacyLeakage } from "./leakage";
import { pickDispense } from "./pick";
import { acceptReturn } from "./returns";
import { verifyDispense } from "./verify";
import type { PharmacyFixture } from "../../../test/helpers/pharmacy";
import type { Db } from "../../kernel/db/client";

/**
 * ═══ PHARMACY P12 — THE LEAKAGE TRIANGLE: ISSUED, BILLED, COUNTED ═══
 *
 * Phase doc `docs/superpowers/plans/2026-09-17-phase-pharmacy-p12-leakage.md`. Doc 16 I1: "issued vs
 * billed vs counted triangle per location per day → variance row … fixture with 3 unbilled units
 * surfaces". The counter's own flow cannot bill a strip it did not issue. What leaks goes around it:
 * a refund at the billing desk with nothing returned, stock consumed at the counter outside any
 * dispense, and a shelf that does not match the books.
 */
const hour = (h: number): Date => new Date(MON3.getTime() + h * 60 * 60 * 1000);

describe("the pharmacy leakage triangle (P12)", () => {
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

  /** `qty` Crocin tablets dispensed, paid and handed over at MON3; returns the dispense and its invoice line. */
  async function handedOver(qty: number): Promise<{ id: string; invoiceId: string; invoiceLineId: string; unitPaise: number }> {
    const { issued } = await issueRx(db, fx, [line({ drug: "Crocin 500", medicineId: fx.med.crocin })]);
    const r = await findAtCounter(db, testCfg, fx.pharmacist.actor, issued.qrPayload, MON2);
    if (r.kind !== "dispense") throw new Error("no dispense");
    const id = r.dispense.id;
    await claimDispense(db, fx.pharmacist.actor, { dispenseId: id, door: "rx_qr" }, MON2);
    await verifyDispense(db, fx.pharmacist.actor, fx.decls, id, { lines: [{ lineIdx: 0, qtyBase: qty }] }, MON2);
    await pickDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON2);
    const preview = await previewDispenseBill(db, fx.pharmacist.actor, id, MON2);
    const b = await billDispense(db, fx.pharmacist.actor, id, { tenders: [{ mode: "cash", amountPaise: preview.totals.netPayablePaise }] }, MON2);
    const d = await handOverDispense(db, fx.pharmacist.actor, fx.decls, id, {}, MON3);
    const l = d.lines[0]!;
    return { id, invoiceId: b.invoiceId!, invoiceLineId: l.invoiceLineId!, unitPaise: l.unitPaise! };
  }

  it("surfaces a refund with nothing returned, consumption outside a dispense, and a count that came up short", async () => {
    // A clean dispense, later returned properly: restocked AND credited, so it balances.
    const clean = await handedOver(20);
    await acceptReturn(db, fx.pharmacist.actor, fx.decls, clean.id, { lines: [{ lineIdx: 0, qtyBase: 10 }], sealedIntact: true, reason: "course changed", reasonClass: "genuine" }, hour(1));
    // Three units refunded at the billing desk, nothing came back.
    const leaky = await handedOver(10);
    await issueCreditNote(db, fx.pharmacist.actor, { kind: "refund", invoiceId: leaky.invoiceId, reason: "patient complained", lines: [{ invoiceLineId: leaky.invoiceLineId, qty: 3 }] }, hour(2));
    // Four tablets consumed at the counter with no dispense behind them.
    const [crocinBatch] = (await balances(db, { resourceId: fx.storeId })).filter((b) => b.itemId === fx.item.crocin);
    await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
      resourceId: fx.storeId, batchId: crocinBatch!.batchId, qtyDelta: -4, reason: "consume", refType: "ward_emergency", refId: "slip-7", occurredAt: hour(3),
    }));
    // A blind count by a storekeeper finds two tablets fewer than the books.
    await ensureRole(db, "materials_head");
    await ensureRole(db, "storekeeper");
    await grantPermissionToRole(db, fx.registry, "materials_head", "materials.counts.manage");
    await grantPermissionToRole(db, fx.registry, "storekeeper", "materials.counts.perform");
    const head = await mkUser(db, "mat.head", ["materials_head"]);
    const keeper = await mkUser(db, "store.keeper", ["storekeeper"]);
    const count = await scheduleCount(db, head.actor, { storeResourceId: fx.storeId }, hour(4));
    const sheet = await countSheet(db, keeper.actor, count.id);
    const books = new Map((await balances(db, { resourceId: fx.storeId })).map((b) => [b.batchId, b.qtyOnHand] as const));
    const review = sheet.lines.map((l) => l.lineId);
    expect(review).toHaveLength(1);
    await submitCount(db, keeper.actor, count.id, {
      countedAt: hour(5).toISOString(),
      lines: [{ lineId: sheet.lines[0]!.lineId, countedQty: books.get(crocinBatch!.batchId)! - 2 }],
    }, hour(5));

    const report = await pharmacyLeakage(db, "2026-08-17");

    expect(report.day).toBe("2026-08-17");
    expect(report.store.code).toBe("PHARM-OPD");
    expect(report.dispensed).toEqual({ lines: 2, units: 30 });
    expect(report.mismatches).toEqual([{
      source: "dispense", dispenseId: leaky.id, dispenseNo: expect.any(String), saleId: null, invoiceNo: null, itemCode: "CROC500", batchNo: "CR-1",
      issued: 10, returned: 0, billed: 10, credited: 3, unbilledUnits: 3, unbilledPaise: 3 * leaky.unitPaise,
    }]);
    expect(report.otherConsumption).toEqual([{
      itemCode: "CROC500", batchNo: "CR-1", units: 4, refType: "ward_emergency", refId: "slip-7", actorId: fx.pharmacist.id,
      // The reviewer reads a person, not a ULID (found by the 2026-09-17 browser walk).
      actorName: "ph.mehta", occurredAt: hour(3).toISOString(),
    }]);
    expect(report.counted).toMatchObject({ counts: 1, varianceUnits: -2, variancePaise: -1000 });
    expect(report.counted.lines).toEqual([{ countId: count.id, itemCode: "CROC500", batchNo: "CR-1", varianceQty: -2, variancePaise: -1000 }]);
    expect(report.summary).toEqual({ unbilledUnits: 3, unbilledPaise: 3 * leaky.unitPaise, otherUnits: 4, countVarianceUnits: -2, countVariancePaise: -1000 });

    // Another day is quiet.
    const quiet = await pharmacyLeakage(db, "2026-08-18");
    expect(quiet.summary).toEqual({ unbilledUnits: 0, unbilledPaise: 0, otherUnits: 0, countVarianceUnits: 0, countVariancePaise: 0 });
  });

  it("finds a refund or a restock made today on a dispense handed over another day, and forgets a voided refund", async () => {
    const old = await handedOver(10);
    const other = await handedOver(10);
    const nextDay = new Date(MON3.getTime() + 24 * 60 * 60 * 1000);
    const note = await issueCreditNote(db, fx.pharmacist.actor, { kind: "refund", invoiceId: old.invoiceId, reason: "late complaint", lines: [{ invoiceLineId: old.invoiceLineId, qty: 2 }] }, nextDay);
    // Stock booked back against the other line with no refund behind it: the books gain what the
    // shelf may not have. The triangle shows it as negative unbilled.
    const [row] = await db.select({ id: pharmacyDispenseLines.id, batchId: pharmacyDispenseLines.batchId })
      .from(pharmacyDispenseLines).where(eq(pharmacyDispenseLines.dispenseId, other.id));
    await withTx(db, (tx) => postMovement(tx, fx.pharmacist.actor, {
      resourceId: fx.storeId, batchId: row!.batchId!, qtyDelta: 5, reason: "return", refType: "pharmacy_return", refId: row!.id, occurredAt: nextDay,
    }));

    const report = await pharmacyLeakage(db, "2026-08-18");

    expect(report.dispensed).toEqual({ lines: 0, units: 0 });
    expect(report.mismatches.map((m) => [m.dispenseId, m.unbilledUnits]).sort()).toEqual([[old.id, 2], [other.id, -5]].sort());

    // The refund is voided (entered in error): it no longer counts.
    await db.insert(enteredInErrorMarks).values({ id: newId(), docType: "credit_note", docId: note.creditNoteId, reason: "keyed twice", markedBy: fx.pharmacist.id, markedAt: nextDay });
    expect((await pharmacyLeakage(db, "2026-08-18")).mismatches.map((m) => m.dispenseId)).toEqual([other.id]);
    // On the day both were handed over, the voided refund's line balances; the restocked one does not.
    expect((await pharmacyLeakage(db, "2026-08-17")).mismatches.map((m) => [m.dispenseId, m.unbilledUnits])).toEqual([[other.id, -5]]);
  });

  it("refuses a day that is not a date", async () => {
    await expect(pharmacyLeakage(db, "2026-02-30")).rejects.toMatchObject({ code: "invalid_day" });
  });
});
