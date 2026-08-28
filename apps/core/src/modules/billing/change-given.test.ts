import { eq } from "drizzle-orm";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { grantCreditExtend, seedBillingBase } from "../../../test/helpers/billing";
import { mkPatient, mkUser, seedOpdBase } from "../../../test/helpers/opd";
import { receipts } from "../../kernel/db/schema";
import { expectedCash } from "./cash-math";
import { issueInvoice } from "./invoices";
import { beginClose, openSession } from "./sessions";
import { BillingError } from "./errors";
import type { Db } from "../../kernel/db/client";

/**
 * PLAN 07b T5 — THE CHANGE-OUT LANE.
 *
 * The counter always computed the surplus and always showed it, under a label reading
 * "Change due / banked as advance". That is TWO OUTCOMES WITH ONE RECORD: whichever the cashier
 * did, the ledger wrote an unallocated receipt balance, which IS a patient advance. So when the
 * money was handed over the advance was fictional — the patient's balance was overstated by exactly
 * that amount, AND the drawer was short by it at close, with nothing to explain the variance the
 * cashier then had to answer for.
 *
 * The fix is not a second display of a number that is already displayed. It is making the cashier
 * DECLARE which lane, recording it, and subtracting it from expected cash.
 */
describe("change handed back (07b T5)", () => {
  let db: Db;
  let teardown: () => Promise<void>;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  let svc: string;
  beforeEach(async () => {
    await truncateAll(db);
    // `mkPatient` mints a UHID, which needs `registration_config` — the billing fixture does not
    // seed it because nothing in billing registers a patient.
    await seedOpdBase(db);
    ({ consultNewServiceId: svc } = await seedBillingBase(db));
    await grantCreditExtend(db, "cashier");
  });

  /** The pure fold, first: change LEAVES the drawer exactly as a paid cash voucher does. */
  describe("expectedCash", () => {
    it("subtracts change handed back", () => {
      expect(expectedCash(200_00, 500_00, 0, 0)).toBe(700_00);
      expect(expectedCash(200_00, 500_00, 0, 20_00)).toBe(680_00);
    });

    it("defaults to zero so every pre-existing caller keeps its arithmetic", () => {
      expect(expectedCash(200_00, 500_00, 50_00)).toBe(expectedCash(200_00, 500_00, 50_00, 0));
    });

    it("refuses a negative or fractional declaration", () => {
      expect(() => expectedCash(0, 0, 0, -1)).toThrow();
      expect(() => expectedCash(0, 0, 0, 1.5)).toThrow();
    });
  });

  describe("the guards that keep the declaration honest", () => {
    it("refuses change larger than the surplus — the rest is the hospital's money", async () => {
      const cashier = await mkUser(db, "cash1", ["cashier"]);
      await openSession(db, cashier.actor, 200_00);
      const patient = await mkPatient(db, cashier.actor, { phone: "9876500001" });
      await expect(issueInvoice(db, cashier.actor, {
        draftId: "d-1", patientId: patient.id,
        lines: [{ lineId: "l1", serviceId: svc, qty: 1 }],
        receipt: { tenders: [{ mode: "cash", amountPaise: 500_00 }], changeGivenPaise: 999_00 },
      })).rejects.toMatchObject({ code: "change_exceeds_surplus" });
    });

    it("refuses change against a card-only payment — that is a refund, and refunds have a ladder", async () => {
      const cashier = await mkUser(db, "cash2", ["cashier"]);
      await openSession(db, cashier.actor, 200_00);
      const patient = await mkPatient(db, cashier.actor, { phone: "9876500002" });
      await expect(issueInvoice(db, cashier.actor, {
        draftId: "d-2", patientId: patient.id,
        lines: [{ lineId: "l1", serviceId: svc, qty: 1 }],
        receipt: {
          tenders: [{ mode: "card", amountPaise: 500_00, refText: "AUTH-1" }],
          changeGivenPaise: 10_00,
        },
      })).rejects.toBeInstanceOf(BillingError);
    });
  });

  /**
   * THE DEFECT ITSELF, end to end: the same overpayment, declared two ways, must produce two
   * different drawers. Before this column both produced the same one, and only one of them was true.
   */
  it("the same overpayment declared as CHANGE and as an ADVANCE close to different expected cash", async () => {
    const given = await (async (): Promise<number> => {
      const cashier = await mkUser(db, "cashA", ["cashier"]);
      await openSession(db, cashier.actor, 200_00);
      const patient = await mkPatient(db, cashier.actor, { phone: "9876500003" });
      const issued = await issueInvoice(db, cashier.actor, {
        draftId: "d-3", patientId: patient.id,
        lines: [{ lineId: "l1", serviceId: svc, qty: 1 }],
        receipt: { tenders: [{ mode: "cash", amountPaise: 700_00 }], changeGivenPaise: 200_00 },
      });
      expect(issued.unallocatedPaise).toBeGreaterThanOrEqual(200_00);
      const [row] = await db.select().from(receipts).where(eq(receipts.id, issued.receiptId!));
      expect(row!.changeGivenPaise).toBe(200_00);
      const closing = await beginClose(db, cashier.actor, { denominations: {}, note: "x" });
      return closing.expectedCashPaise!;
    })();

    const kept = await (async (): Promise<number> => {
      const cashier = await mkUser(db, "cashB", ["cashier"]);
      await openSession(db, cashier.actor, 200_00);
      const patient = await mkPatient(db, cashier.actor, { phone: "9876500004" });
      await issueInvoice(db, cashier.actor, {
        draftId: "d-4", patientId: patient.id,
        lines: [{ lineId: "l1", serviceId: svc, qty: 1 }],
        receipt: { tenders: [{ mode: "cash", amountPaise: 700_00 }] }, // same money, no declaration: kept as advance
      });
      const closing = await beginClose(db, cashier.actor, { denominations: {}, note: "x" });
      return closing.expectedCashPaise!;
    })();

    // The drawer that handed ₹200 back expects ₹200 less in it. Before T5 these were equal, and the
    // cashier who gave change carried a variance she did not cause.
    expect(kept - given).toBe(200_00);
  });

  it("an undeclared receipt keeps the old arithmetic exactly — the column defaults to zero", async () => {
    const cashier = await mkUser(db, "cashC", ["cashier"]);
    await openSession(db, cashier.actor, 200_00);
    const patient = await mkPatient(db, cashier.actor, { phone: "9876500005" });
    const issued = await issueInvoice(db, cashier.actor, {
      draftId: "d-5", patientId: patient.id,
      lines: [{ lineId: "l1", serviceId: svc, qty: 1 }],
      receipt: { tenders: [{ mode: "cash", amountPaise: 500_00 }] },
    });
    const [row] = await db.select().from(receipts).where(eq(receipts.id, issued.receiptId!));
    expect(row!.changeGivenPaise).toBe(0);
    const closing = await beginClose(db, cashier.actor, { denominations: {}, note: "x" });
    expect(closing.expectedCashPaise).toBe(200_00 + 500_00);
  });
});
