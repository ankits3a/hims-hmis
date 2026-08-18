import { newId } from "@hmis/contracts";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import { withTx } from "../../kernel/db/client";
import { receipts, receiptTenders, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { loadBillingConfig } from "./config";
import { assertCashAccepted, episodeCashPaise } from "./cash-law";
import { istDay } from "./time";
import type { TenderInput } from "./cash-law";
import type { BillingConfig } from "./config";
import type { Db } from "../../kernel/db/client";

/**
 * Plan 08 T5, D7 — the C-2 cash law.
 *
 * SEEDED CONFIG (test/helpers/billing.ts `seedBillingBase`, mirroring scripts/seed-billing.ts):
 *   cashWarnPaise 15_000_000 (Rs 1,50,000) · cashBlockPaise 20_000_000 (Rs 2,00,000)
 *   panThresholdPaise 5_000_000 (Rs 50,000).
 *
 * DISCLOSED SHAPING: prior receipts are inserted directly against T1's schema rather than issued
 * through `issueInvoice`. The amounts these tests need as PRIOR history (Rs 1,49,999.98, Rs
 * 40,000, Rs 1,99,999.99 on UPI) are exactly the amounts the law under test would refuse or warn
 * on while being set up, so building the history through the writer would test the writer, not
 * the law. The shaped rows carry the same columns the writer writes.
 */
describe("cash law (C-2): episodeCashPaise / assertCashAccepted (D7)", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let cfg: BillingConfig;
  let sessionId: string;

  // IST is UTC+5:30, so an IST calendar day starts at 18:30 UTC on the previous day. Hand-derived:
  // 2026-08-19T06:00:00Z + 5:30 = 2026-08-19T11:30 IST, which is the IST day "2026-08-19".
  const AT = new Date("2026-08-19T06:00:00Z");
  const TODAY = "2026-08-19";
  const YESTERDAY = "2026-08-18";

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    await seedBillingBase(db);
    cfg = await loadBillingConfig(db);
    const cashier = await mkCashier(db, "cashlaw-cashier");
    ({ id: sessionId } = await openSessionFor(db, cashier, 100_000));
  });

  async function mkTestPatient(): Promise<string> {
    const actor: Actor = { type: "user", id: "cashlaw-clerk" };
    const { patient } = await withTx(db, (tx) =>
      registerPatient(tx, actor, { name: "Cash Law Patient", sex: "female", ageYears: 40 }),
    );
    return patient.id;
  }

  /** One shaped receipt (+ tenders) on a named IST day — see the disclosure above. */
  async function shapeReceipt(patientId: string, serviceDay: string, tenders: TenderInput[]): Promise<void> {
    const receiptId = newId();
    let totalPaise = 0;
    for (const tender of tenders) totalPaise += tender.amountPaise;
    await db.insert(receipts).values({
      id: receiptId, receiptNo: newId(), patientId, cashierSessionId: sessionId,
      receivedBy: "shaped", receivedAt: AT, serviceDay, totalPaise,
    });
    for (const tender of tenders) {
      await db.insert(receiptTenders).values({
        id: newId(), receiptId, mode: tender.mode, amountPaise: tender.amountPaise, refText: tender.refText ?? null,
      });
    }
  }

  test("the episode spans only the patient's SAME IST-day receipts, and advances count", async () => {
    // The IST day boundary is 18:30 UTC of the previous calendar day — hand-derived, both sides.
    expect(istDay(new Date("2026-08-18T18:29:59.999Z"))).toBe(YESTERDAY);
    expect(istDay(new Date("2026-08-18T18:30:00.000Z"))).toBe(TODAY);
    expect(istDay(AT)).toBe(TODAY);

    const patientId = await mkTestPatient();
    await shapeReceipt(patientId, YESTERDAY, [{ mode: "cash", amountPaise: 700_000 }]);
    // An ADVANCE: cash with no invoice behind it. Cash is cash under §269ST, so it counts (D7).
    await shapeReceipt(patientId, TODAY, [{ mode: "cash", amountPaise: 300_000 }]);

    expect(await episodeCashPaise(db, patientId, AT)).toBe(300_000);
    // Another patient's cash is another patient's episode.
    const other = await mkTestPatient();
    expect(await episodeCashPaise(db, other, AT)).toBe(0);
  });

  test("warn fires when Sigma + incoming lands exactly ON the warn threshold, not one paise below", async () => {
    const patientId = await mkTestPatient();
    await shapeReceipt(patientId, TODAY, [{ mode: "cash", amountPaise: 14_999_998 }]);

    // 14_999_998 + 1 = 14_999_999 < 15_000_000 -> no warning.
    const below = await assertCashAccepted(db, cfg, {
      patientId, tenders: [{ mode: "cash", amountPaise: 1 }], form60: true, at: AT,
    });
    expect(below).toMatchObject({ episodeCashPaise: 14_999_999, priorCashPaise: 14_999_998, warned: false });

    // 14_999_998 + 2 = 15_000_000, exactly the warn threshold -> warns.
    const on = await assertCashAccepted(db, cfg, {
      patientId, tenders: [{ mode: "cash", amountPaise: 2 }], form60: true, at: AT,
    });
    expect(on).toMatchObject({ episodeCashPaise: 15_000_000, incomingCashPaise: 2, warned: true });
  });

  test("at or above the block threshold the cash is refused: cash_threshold_blocked (block beats PAN)", async () => {
    const patientId = await mkTestPatient();
    // 0 + 20_000_000 = the block threshold exactly. It is also far past the PAN threshold and
    // carries neither PAN nor Form 60 — the harder refusal is the one reported.
    await expect(
      assertCashAccepted(db, cfg, { patientId, tenders: [{ mode: "cash", amountPaise: 20_000_000 }], at: AT }),
    ).rejects.toMatchObject({ code: "cash_threshold_blocked" });
  });

  test("cash past the PAN threshold without PAN or Form 60 is refused: pan_required (strictly above)", async () => {
    const patientId = await mkTestPatient();
    await shapeReceipt(patientId, TODAY, [{ mode: "cash", amountPaise: 4_000_000 }]);

    // 4_000_000 + 1_000_000 = 5_000_000, exactly the threshold — "exceeding" means strictly above.
    const on = await assertCashAccepted(db, cfg, {
      patientId, tenders: [{ mode: "cash", amountPaise: 1_000_000 }], at: AT,
    });
    expect(on.episodeCashPaise).toBe(5_000_000);

    // 4_000_000 + 1_000_001 = 5_000_001 -> identification required.
    await expect(
      assertCashAccepted(db, cfg, { patientId, tenders: [{ mode: "cash", amountPaise: 1_000_001 }], at: AT }),
    ).rejects.toMatchObject({ code: "pan_required" });
  });

  test("Form 60 — or a PAN — satisfies the identification requirement", async () => {
    const patientId = await mkTestPatient();
    await shapeReceipt(patientId, TODAY, [{ mode: "cash", amountPaise: 4_000_000 }]);
    const tenders: TenderInput[] = [{ mode: "cash", amountPaise: 1_000_001 }];

    const withForm60 = await assertCashAccepted(db, cfg, { patientId, tenders, form60: true, at: AT });
    expect(withForm60).toMatchObject({ episodeCashPaise: 5_000_001, warned: false });

    const withPan = await assertCashAccepted(db, cfg, { patientId, tenders, panNumber: "ABCDE1234F", at: AT });
    expect(withPan.episodeCashPaise).toBe(5_000_001);
  });

  test("non-cash tenders never enter the episode, on either side of the sum", async () => {
    const patientId = await mkTestPatient();
    // One paise short of the block threshold — but on UPI, which leaves a banking trail.
    await shapeReceipt(patientId, TODAY, [{ mode: "upi", amountPaise: 19_999_999, refText: "UPI-REF-1" }]);
    expect(await episodeCashPaise(db, patientId, AT)).toBe(0);

    // A single paise of cash on top: the episode is 1, not 20_000_000, so nothing is refused.
    const verdict = await assertCashAccepted(db, cfg, {
      patientId, tenders: [{ mode: "cash", amountPaise: 1 }, { mode: "card", amountPaise: 19_999_999, refText: "CARD-1" }], at: AT,
    });
    expect(verdict).toMatchObject({ priorCashPaise: 0, incomingCashPaise: 1, episodeCashPaise: 1, warned: false });
  });
});
