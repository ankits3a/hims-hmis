import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { newId } from "@hmis/contracts";
import { approveRequest } from "../../../kernel/approvals/decisions";
import { withTx } from "../../../kernel/db/client";
import { ipdChargeLines, ipdPayerSplitSnapshots } from "../../../kernel/db/schema";
import { recordReceipt } from "../../billing";
import { setupTestDb, truncateAll } from "../../../../test/helpers/db";
import { CHARGE_RATES, mkChargesWorld } from "../../../../test/helpers/ipd";
import {
  askApproval, postConsultantVisit, postNightlyIpdCharges, printInterimBillSnapshot, readInterimBill, recordPayerAuth,
  registerIpdReceiptGuard, roomRentCapWarning,
} from "../index";
import type { Db } from "../../../kernel/db/client";
import type { ChargesWorld } from "../../../../test/helpers/ipd";

/**
 * E2.2 (#726) — "DONE MEANS" FOR THE PAYER SPLIT (spec SPEC-ipd-core §2 answer 5, §4.2, §4.3, §6 Admission/Bill;
 * decision 0072 answer 5). Each check calls the intent or the read with EXPLICIT instants (IST, `+05:30`): the poster
 * and the split read no clock. Amounts are obviously fake round values; the fixture's rates are `CHARGE_RATES`.
 */

jest.setTimeout(180_000);

const ist = (s: string): Date => new Date(`${s}+05:30`);
const key = (): string => randomUUID();

describe("E2.2 payer authorisation and bill split — acceptance", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let w: ChargesWorld;
  let unregister: (() => void) | null = null;

  beforeAll(async () => { ({ db, teardown } = await setupTestDb()); });
  afterAll(async () => teardown());
  beforeEach(async () => { await truncateAll(db); w = await mkChargesWorld(db); });
  afterEach(() => { unregister?.(); unregister = null; });

  const auth = (admissionId: string, at: Date, over: Record<string, unknown>) => recordPayerAuth(db, w.admitDesk, {
    idempotencyKey: key(), admissionId, payerKind: "insurance_cashless", entry: "initial", status: "requested",
    provisionalCashlessSigned: true, ...over,
  }, { now: at });
  const bill = (admissionId: string) => readInterimBill(db, w.billDesk, admissionId);
  const linesOf = async (admissionId: string) => db.select().from(ipdChargeLines).where(eq(ipdChargeLines.admissionId, admissionId));
  /** The split of each posted line, keyed `component` (one line per component in these stays). */
  const byComponent = async (admissionId: string) => {
    const b = await bill(admissionId);
    const lines = await linesOf(admissionId);
    const out: Record<string, { net: number; payer: number; patient: number; reasons: string[] }> = {};
    for (const s of b.payerSplit.lines) {
      const l = lines.find((x) => x.id === s.lineId)!;
      out[`${l.serviceDate}:${l.component}`] = { net: l.netPaise, payer: s.payerPaise, patient: s.patientPaise, reasons: s.reasons };
    }
    return { bill: b, lines: out };
  };

  it("(i) a pre-auth approved on day 2 makes the day-1 charges payer-payable", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await auth(admissionId, ist("2026-03-10T11:00:00"), { preAuthNumber: "PA-FAKE-001" });
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    // Awaiting the insurer: the day-1 lines are the patient's for now, with the reason.
    const before = await byComponent(admissionId);
    expect(before.bill.payerSplit.authState).toBe("pending");
    expect(Object.values(before.lines).every((l) => l.payer === 0 && l.reasons.includes("auth_pending"))).toBe(true);
    // Day 2: the insurer approves. Approval covers the stay from admission.
    const approved = await auth(admissionId, ist("2026-03-11T15:00:00"), { status: "approved", approvedAmountPaise: 10_000_000, preAuthNumber: "PA-FAKE-001" });
    expect(approved.coversFrom).toBe(ist("2026-03-10T10:00:00").toISOString());
    const after = await byComponent(admissionId);
    expect(after.bill.payerSplit).toMatchObject({ mode: "insured", authState: "approved", approvedTotalPaise: 10_000_000, preAuthNumber: "PA-FAKE-001" });
    const day1 = Object.entries(after.lines).filter(([k]) => k.startsWith("2026-03-10:"));
    expect(day1.map(([k]) => k).sort()).toEqual(["2026-03-10:nursing", "2026-03-10:rmo", "2026-03-10:room"]);
    for (const [, l] of day1) expect(l).toMatchObject({ payer: l.net, patient: 0, reasons: [] });
    expect(after.bill.payerSplit.totals.patientPaise).toBe(0);
  });

  it("(ii) a denial makes them patient-payable and flags the cash consent missing until a signed consent is recorded", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await auth(admissionId, ist("2026-03-10T11:00:00"), {});
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    await auth(admissionId, ist("2026-03-11T12:00:00"), { entry: "denial", status: "denied" });
    const denied = await byComponent(admissionId);
    expect(denied.bill.payerSplit.authState).toBe("denied");
    expect(denied.bill.payerSplit.exceptions).toEqual(["cash_consent_missing"]);
    for (const l of Object.values(denied.lines)) expect(l).toMatchObject({ payer: 0, patient: l.net, reasons: ["denied"] });
    // A payer change to cash WITHOUT the signed counselling document is refused; with it, the flag clears.
    await expect(auth(admissionId, ist("2026-03-11T13:00:00"), { entry: "payer_change", payerKind: "cash", status: "approved" }))
      .rejects.toMatchObject({ code: "payer_change_needs_counselling" });
    await auth(admissionId, ist("2026-03-11T13:05:00"), { entry: "payer_change", payerKind: "cash", status: "approved", counsellingDocumentId: newId() });
    const consented = await byComponent(admissionId);
    expect(consented.bill.payerSplit.exceptions).toEqual([]);
    expect(consented.bill.payerSplit.mode).toBe("cash");
    // Still cash FROM ADMISSION, and still said why.
    for (const l of Object.values(consented.lines)) expect(l).toMatchObject({ payer: 0, patient: l.net, reasons: ["denied"] });
  });

  /** A private stay with a consultant visit on day 1, under an approved pre-auth with a ₹1,000/day room-rent cap. */
  const cappedPrivateStay = async (over: Record<string, unknown> = {}): Promise<string> => {
    const { admissionId } = await w.admitAt("private", ist("2026-03-10T10:00:00"));
    await auth(admissionId, ist("2026-03-10T11:00:00"), {
      status: "approved", approvedAmountPaise: 10_000_000, preAuthNumber: "PA-FAKE-CAP", roomRentCapPaise: 100_000, ...over,
    });
    await withTx(db, (tx) => postConsultantVisit(tx, {
      admissionId, consultantUserId: w.consultantUserId, seenAt: ist("2026-03-10T12:00:00"), source: "rounds_tap",
    }));
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    return admissionId;
  };

  it("(iii) room-rent cap: private ₹4,000/day vs cap ₹1,000/day — nursing and visit paid at 1,000/4,000, the rest patient-payable, to the paisa", async () => {
    expect([CHARGE_RATES.private.room, CHARGE_RATES.private.nursing, CHARGE_RATES.private.visit]).toEqual([400_000, 90_000, 120_000]);
    const admissionId = await cappedPrivateStay();
    const { bill: b, lines } = await byComponent(admissionId);
    expect(lines["2026-03-10:room"]).toEqual({ net: 400_000, payer: 100_000, patient: 300_000, reasons: ["room_rent_over_cap"] });
    expect(lines["2026-03-10:nursing"]).toEqual({ net: 90_000, payer: 22_500, patient: 67_500, reasons: ["room_rent_cap_proportional"] });
    expect(lines["2026-03-10:visit"]).toEqual({ net: 120_000, payer: 30_000, patient: 90_000, reasons: ["room_rent_cap_proportional"] });
    expect(b.payerSplit.totals).toMatchObject({ payerPaise: 152_500, patientPaise: 457_500, capDeductionPaise: 457_500, coPayPaise: 0 });
    expect(b.payerSplit.roomRentCapPaise).toBe(100_000);
    // The deduction is shown in words.
    expect(b.payerSplit.words).toContain("Room ₹4,000/day over ₹1,000 cap: nursing, RMO, visits paid 25 %");
    expect(b.payerSplit.words).toContain("Room-rent cap deduction ₹4,575");
    // The warning before an upgrade consent says the same thing per day.
    await expect(roomRentCapWarning(db, w.billDesk, admissionId, "private")).resolves.toMatchObject({
      capPerDayPaise: 100_000, rentPerDayPaise: 400_000, overPerDayPaise: 300_000, payerShareBp: 2_500,
    });
    await expect(roomRentCapWarning(db, w.billDesk, admissionId, "icu")).resolves.toBeNull();
    // Printing the interim bill keeps what it said.
    const printed = await printInterimBillSnapshot(db, w.billDesk, admissionId, ist("2026-03-11T09:00:00"));
    expect(printed).toMatchObject({ payerPaise: 152_500, patientPaise: 457_500 });
    expect(await db.select().from(ipdPayerSplitSnapshots).where(eq(ipdPayerSplitSnapshots.admissionId, admissionId))).toHaveLength(1);
  });

  it("(iv) a scheme admission refuses a receipt on the generic billing route unless an approved non-covered line covers it", async () => {
    unregister = registerIpdReceiptGuard();
    const { admissionId, patientId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await auth(admissionId, ist("2026-03-10T11:00:00"), { payerKind: "pmjay", status: "approved", approvedAmountPaise: 2_500_000 });
    await postNightlyIpdCharges(db, ist("2026-03-11T00:05:00"));
    const generic = (amountPaise: number) => recordReceipt(db, w.admitDesk, { patientId, tenders: [{ mode: "cash", amountPaise }] });
    await expect(generic(10_000)).rejects.toMatchObject({ code: "receipt_guard_refused" });
    let b = await bill(admissionId);
    expect(b.payerSplit.mode).toBe("scheme");
    expect(b.payerSplit.lines.every((l) => l.patientPaise === 0 && l.payerPaise > 0)).toBe(true);
    expect(b.payerSplit.totals.patientPaise).toBe(0);
    // An approver marks a non-covered line (₹500): exactly that much may be taken, and the split names it.
    const { approvalId } = await askApproval(db, w.admitDesk, admissionId, { kind: "non_covered", note: "Attendant bed", amountPaise: 50_000 });
    await approveRequest(db, w.billingManager, { approvalId, note: "non-covered" });
    await expect(generic(50_000)).resolves.toMatchObject({ receiptId: expect.any(String) });
    await expect(generic(100)).rejects.toMatchObject({ code: "receipt_guard_refused" });
    b = await bill(admissionId);
    expect(b.payerSplit.schemeNonCoveredPaise).toBe(50_000);
    expect(b.payerSplit.totals.patientPaise).toBe(50_000);
  });

  it("(v) the insurer approves less than the bill: the difference is patient-payable with a reason", async () => {
    const { admissionId } = await w.admitAt("general", ist("2026-03-10T10:00:00"));
    await auth(admissionId, ist("2026-03-10T11:00:00"), { status: "approved", approvedAmountPaise: 300_000 });
    await postNightlyIpdCharges(db, ist("2026-03-12T00:05:00"));
    const day = CHARGE_RATES.general.room + CHARGE_RATES.general.nursing + CHARGE_RATES.general.rmo;
    expect(day).toBe(220_000);
    const { bill: b, lines } = await byComponent(admissionId);
    expect(b.payerSplit.totals).toMatchObject({ payerPaise: 300_000, patientPaise: 140_000, overApprovedPaise: 140_000 });
    // Day 1 fits under the approval; day 2 carries the difference, each line saying why.
    for (const [k, l] of Object.entries(lines)) if (k.startsWith("2026-03-10:")) expect(l).toMatchObject({ payer: l.net, patient: 0 });
    const day2 = Object.entries(lines).filter(([k]) => k.startsWith("2026-03-11:")).map(([, l]) => l);
    expect(day2.reduce((s, l) => s + l.patient, 0)).toBe(140_000);
    expect(day2.filter((l) => l.patient > 0).every((l) => l.reasons.includes("over_approved_amount"))).toBe(true);
    expect(b.payerSplit.words).toContain("Above approved ₹3,000: ₹1,400");
  });

  it("(vi) co-pay is applied after the room-rent cap", async () => {
    const admissionId = await cappedPrivateStay({ coPayBp: 1_000 });
    const { bill: b, lines } = await byComponent(admissionId);
    // Cap first (room ₹1,000, nursing ₹225, visit ₹300 payable), then 10 % co-pay on what the payer still carries.
    expect(lines["2026-03-10:room"]).toEqual({ net: 400_000, payer: 90_000, patient: 310_000, reasons: ["room_rent_over_cap", "co_pay"] });
    expect(lines["2026-03-10:nursing"]).toEqual({ net: 90_000, payer: 20_250, patient: 69_750, reasons: ["room_rent_cap_proportional", "co_pay"] });
    expect(lines["2026-03-10:visit"]).toEqual({ net: 120_000, payer: 27_000, patient: 93_000, reasons: ["room_rent_cap_proportional", "co_pay"] });
    expect(b.payerSplit.totals).toMatchObject({ payerPaise: 137_250, patientPaise: 472_750, capDeductionPaise: 457_500, coPayPaise: 15_250 });
    expect(b.payerSplit.words).toContain("Co-pay 10 %: ₹152.50");
  });
});
