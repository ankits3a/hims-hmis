import { eq } from "drizzle-orm";
import type { Actor } from "@hmis/contracts";
import { setupTestDb, truncateAll } from "../../../test/helpers/db";
import { issuePaidInvoiceByTender, mkBillingManager, mkCashier, openSessionFor, seedBillingBase } from "../../../test/helpers/billing";
import type { BillingBaseFixture } from "../../../test/helpers/billing";
import { approveRequest } from "../../kernel/approvals/decisions";
import { withTx } from "../../kernel/db/client";
import { receiptTenders, refundVouchers, registrationConfig } from "../../kernel/db/schema";
import { registerPatient } from "../patients";
import { billingOfficeNeeds, gstr1Due } from "./office-needs";
import { recordReceipt } from "./receipts";
import { uploadSettlement } from "./recon";
import { resolveMismatch } from "./recon-resolve";
import { issueRefundVoucher, issueVoucherForApproval, requestRefund } from "./refunds";
import type { Db } from "../../kernel/db/client";

/**
 * UX-AUDIT 2026-09-28 · BOARD — the billing back office's one ranked "needs you today" list.
 * The board's order: a settlement mismatch first, then vouchers to pay, then refunds to approve;
 * what only the OWNER may decide (OWNER RULINGS 2026-09-28) and a dispute with the bank are clocks,
 * `state: "waiting"`, not tasks.
 */
describe("office-needs.ts: the billing office's ranked needs feed", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let base: BillingBaseFixture;
  const NOW = new Date("2026-08-19T06:00:00Z");
  const LATER = new Date("2026-08-21T06:00:00Z");
  const OFFICE: Actor = { type: "user", id: "needs-office" };

  beforeAll(async () => {
    ({ db, teardown } = await setupTestDb());
  });
  afterAll(async () => teardown());
  beforeEach(async () => {
    await truncateAll(db);
    await db.insert(registrationConfig).values({ id: "main", uhidPrefix: "HMS", updatedBy: "t" }).onConflictDoNothing();
    base = await seedBillingBase(db);
  });

  async function patient(name: string): Promise<string> {
    const { patient: p } = await withTx(db, (tx) => registerPatient(tx, { type: "user", id: "clerk" }, { name, sex: "female", ageYears: 46 }));
    return p.id;
  }

  test("gstr1Due: through the 11th it is last month's return, after it this month's", () => {
    expect(gstr1Due("2026-09-28")).toEqual({ month: "2026-09", due: "2026-10-11", daysLeft: 13 });
    expect(gstr1Due("2026-10-05")).toEqual({ month: "2026-09", due: "2026-10-11", daysLeft: 6 });
    expect(gstr1Due("2026-10-11")).toEqual({ month: "2026-09", due: "2026-10-11", daysLeft: 0 });
    expect(gstr1Due("2027-01-20")).toEqual({ month: "2027-01", due: "2027-02-11", daysLeft: 22 });
  });

  test("ranks a mismatch, then a voucher to pay, then a refund to approve; the owner's questions and a dispute wait on the clocks", async () => {
    const cashier = await mkCashier(db, "cashier-needs");
    await openSessionFor(db, cashier, 100_000);
    const manager = await mkBillingManager(db, "manager-needs");

    // A card tender the bank settled ₹12.50 short.
    const rakesh = await patient("Rakesh Yadav");
    await issuePaidInvoiceByTender(db, cashier, { patientId: rakesh, serviceId: base.consultNewServiceId, mode: "card", refText: "CARD-N-1" }, NOW);
    await uploadSettlement(db, OFFICE, { csv: "ref,settledPaise,settledOn\nCARD-N-1,48000,2026-08-19", source: "card" }, NOW);

    // An approved, issued voucher nobody has paid.
    const sunita = await patient("Sunita Verma");
    await recordReceipt(db, cashier.actor, { patientId: sunita, tenders: [{ mode: "cash", amountPaise: 3_000_000 }] }, NOW);
    const asked = await requestRefund(db, cashier.actor, { kind: "advance_refund", patientId: sunita, amountPaise: 240_000, reasonClass: "genuine", reason: "MRI cancelled" });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "ok" });
    await issueRefundVoucher(db, cashier.actor, { kind: "advance_refund", patientId: sunita, amountPaise: 240_000, reasonClass: "genuine", reason: "MRI cancelled", approvalId: asked.approvalId, method: "cash" }, NOW);

    // A refund waiting for the manager, and one above ₹25,000.00 waiting for the owner.
    await requestRefund(db, cashier.actor, { kind: "advance_refund", patientId: sunita, amountPaise: 120_000, reasonClass: "mistake", reason: "billed twice" });
    await requestRefund(db, cashier.actor, { kind: "advance_refund", patientId: sunita, amountPaise: 2_600_000, reasonClass: "genuine", reason: "surgery cancelled" });

    const feed = await billingOfficeNeeds(db, OFFICE, LATER);
    const kinds = feed.rows.map((r) => `${r.kind}:${r.state}`);
    expect(kinds).toEqual([
      "recon_mismatch:open", "pay_voucher:open", "approve_refund:open", "refund_owner:waiting", "gstr1_due:open",
    ]);
    const [recon, pay, approve] = feed.rows;
    expect(recon!).toMatchObject({ source: "RECON", tone: "rd", patient: { name: "Rakesh Yadav" }, params: { shortPaise: 1_250, settledPaise: 48_000, expectedNetPaise: 49_250, mode: "card" } });
    expect(pay!).toMatchObject({ source: "PAY", patient: { name: "Sunita Verma" }, params: { amountPaise: 240_000, method: "cash", reason: "MRI cancelled" } });
    expect(String(pay!.params.voucherNo)).toMatch(/^RFV\/\d{2}-\d{2}\/\d{6}$/);
    expect(pay!.ageMinutes).toBe(2 * 24 * 60);
    expect(approve!).toMatchObject({ source: "APPROVE", params: { amountPaise: 120_000 } });
    expect(feed.money).toEqual({ toPayCount: 1, toPayPaise: 240_000, shortPaise: 1_250 });
    expect(recon!.params.ownerApproval).toBeNull(); // ₹12.50 is under the owner's line
    expect(feed.limits).toMatchObject({ reconChargeManagerMaxPaise: 5_000, refundOwnerAbovePaise: 2_500_000 });
    // No identity document reference, ever.
    expect(JSON.stringify(feed)).not.toMatch(/payeeIdRef/);

    // OWNER RULING 2026-09-28 — a shortfall above ₹50.00 asked of the owner is a clock until the owner answers.
    const imran = await patient("Imran Qureshi");
    await issuePaidInvoiceByTender(db, cashier, { patientId: imran, serviceId: base.consultNewServiceId, mode: "card", refText: "CARD-N-2" }, NOW);
    await uploadSettlement(db, OFFICE, { csv: "ref,settledPaise,settledOn\nCARD-N-2,40000,2026-08-19", source: "card" }, NOW);
    const big = (await billingOfficeNeeds(db, OFFICE, LATER)).rows.find((r) => r.patient?.name === "Imran Qureshi")!;
    expect(big).toMatchObject({ kind: "recon_mismatch", state: "open", params: { shortPaise: 9_250, ownerApproval: null } });
    const askedOwner = await resolveMismatch(db, OFFICE, { tenderId: String(big.params.tenderId), outcome: "bank_charge", reason: "bank kept 9250" }, NOW);
    if (askedOwner.status !== "awaiting_owner") throw new Error("expected the owner to be asked");
    const waiting = (await billingOfficeNeeds(db, OFFICE, LATER)).rows.find((r) => r.patient?.name === "Imran Qureshi")!;
    expect(waiting).toMatchObject({ state: "waiting", params: { ownerApproval: "pending", ownerApprovalId: askedOwner.approvalId } });
    await approveRequest(db, base.owner, { approvalId: askedOwner.approvalId, note: "owner yes" });
    const granted = (await billingOfficeNeeds(db, OFFICE, LATER)).rows.find((r) => r.patient?.name === "Imran Qureshi")!;
    expect(granted).toMatchObject({ state: "open", params: { ownerApproval: "granted" } });

    // A dispute moves the mismatch to the clocks.
    const tenderId = String(recon!.params.tenderId);
    await resolveMismatch(db, OFFICE, { tenderId, outcome: "dispute", reason: "raised with the bank" }, NOW);
    const after = await billingOfficeNeeds(db, OFFICE, LATER);
    expect(after.rows.find((r) => r.params.tenderId === tenderId)).toMatchObject({ kind: "recon_disputed", state: "waiting" });
    const [tender] = await db.select().from(receiptTenders).where(eq(receiptTenders.id, tenderId));
    expect(tender!.state).toBe("mismatched");
  });

  /* Owner 2026-10-03 — an approved refund with no voucher sat nowhere; it is now the office's to issue. */
  test("an approved refund with no voucher is the office's to issue; issued from the worklist it becomes a voucher to pay", async () => {
    const cashier = await mkCashier(db, "cashier-issue");
    await openSessionFor(db, cashier, 100_000);
    const manager = await mkBillingManager(db, "manager-issue");
    const sunita = await patient("Sunita Verma");
    await recordReceipt(db, cashier.actor, { patientId: sunita, tenders: [{ mode: "cash", amountPaise: 300_000 }] }, NOW);
    const asked = await requestRefund(db, cashier.actor, { kind: "advance_refund", patientId: sunita, amountPaise: 77_000, reasonClass: "mistake", reason: "wrong medicine given" });
    await approveRequest(db, manager.actor, { approvalId: asked.approvalId, note: "ok" });

    const before = (await billingOfficeNeeds(db, OFFICE, LATER)).rows.filter((r) => r.kind === "issue_voucher");
    expect(before).toHaveLength(1);
    expect(before[0]!).toMatchObject({ source: "PAY", state: "open", patient: { name: "Sunita Verma" }, params: { approvalId: asked.approvalId, amountPaise: 77_000 } });

    const v = await issueVoucherForApproval(db, cashier.actor, asked.approvalId, "cash", NOW);
    const [row] = await db.select().from(refundVouchers).where(eq(refundVouchers.id, v.voucherId));
    expect(row).toMatchObject({ kind: "advance_refund", amountPaise: 77_000, reasonClass: "mistake", reason: "wrong medicine given", method: "cash", status: "issued" });

    const after = await billingOfficeNeeds(db, OFFICE, LATER);
    expect(after.rows.filter((r) => r.kind === "issue_voucher")).toHaveLength(0);
    expect(after.rows.filter((r) => r.kind === "pay_voucher").map((r) => r.params.amountPaise)).toEqual([77_000]);
    // the same approval cannot be spent twice
    await expect(issueVoucherForApproval(db, cashier.actor, asked.approvalId, "cash", NOW)).rejects.toMatchObject({ code: "voucher_state_conflict" });
    await expect(issueRefundVoucher(db, cashier.actor, { kind: "advance_refund", patientId: sunita, amountPaise: 77_000, reasonClass: "mistake", reason: "wrong medicine given", approvalId: asked.approvalId, method: "cash" }, NOW))
      .rejects.toMatchObject({ code: "voucher_state_conflict" });
  });

  test("a finished day's UPI/card money still captured reads as a statement not uploaded", async () => {
    const cashier = await mkCashier(db, "cashier-missing");
    await openSessionFor(db, cashier, 100_000);
    const p = await patient("Imran Qureshi");
    await issuePaidInvoiceByTender(db, cashier, { patientId: p, serviceId: base.consultNewServiceId, mode: "card", refText: "CARD-M-1" }, NOW);
    const feed = await billingOfficeNeeds(db, OFFICE, LATER);
    expect(feed.rows.find((r) => r.kind === "recon_missing")).toMatchObject({
      source: "RECON", params: { day: "2026-08-19", mode: "card", count: 1, totalPaise: 50_000 },
    });
    // The same day, the statement is not late yet.
    const sameDay = await billingOfficeNeeds(db, OFFICE, NOW);
    expect(sameDay.rows.some((r) => r.kind === "recon_missing")).toBe(false);
  });
});
