import { capWarningOf, rupeeText, splitBill, splitModeOf, splitTermsOf } from "./payer-split";
import type { AuthRowInput, SplitLineInput, SplitTerms } from "./payer-split";

/** E2.2 (#726) — the pure payer split engine. Synthetic ids, obviously fake round amounts. */

let n = 0;
const line = (over: Partial<SplitLineInput>): SplitLineInput => {
  n += 1;
  return {
    id: `L${String(n).padStart(4, "0")}`, serviceDate: "2030-01-01", component: "room", billedClass: "private", serviceCode: "IPD_ROOM_PRIVATE",
    category: "room_rent", netPaise: 400_000, source: "ipd.nightly", reversalOf: null, postedAt: `2030-01-02T00:05:00.${String(n).padStart(3, "0")}Z`, ...over,
  };
};
const insured = (over: Partial<SplitTerms> = {}): SplitTerms => ({
  mode: "insured", authState: "approved", preAuthNumber: "PA-1", approvedTotalPaise: 100_000_000, roomRentCapPaise: null, coPayBp: null,
  deniedEver: false, exceptions: [], schemeNonCoveredPaise: 0, ...over,
});
const by = (s: ReturnType<typeof splitBill>, id: string) => s.lines.find((l) => l.lineId === id)!;

describe("splitBill", () => {
  it("an approved stay with no cap, co-pay or non-payable is all payer-payable", () => {
    const ls = [line({}), line({ component: "nursing", netPaise: 90_000 })];
    const s = splitBill(ls, insured());
    expect(s.lines.every((l) => l.patientPaise === 0 && l.reasons.length === 0)).toBe(true);
    expect(s.totals).toMatchObject({ payerPaise: 490_000, patientPaise: 0 });
  });

  it("proportional deduction rounds the payer DOWN to the paisa and the patient takes the remainder; payer + patient = line", () => {
    const room = line({ netPaise: 300_000 });
    const nursing = line({ component: "nursing", netPaise: 100_000 });
    const s = splitBill([room, nursing], insured({ roomRentCapPaise: 100_000 }));
    expect(by(s, nursing.id)).toEqual({ lineId: nursing.id, payerPaise: 33_333, patientPaise: 66_667, reasons: ["room_rent_cap_proportional"] });
    expect(by(s, room.id)).toMatchObject({ payerPaise: 100_000, patientPaise: 200_000 });
    for (const l of s.lines) expect(l.payerPaise + l.patientPaise).toBe(l.lineId === room.id ? 300_000 : 100_000);
  });

  it("RMO and cross-consultation take the deduction too; a non-room-scaled component would not", () => {
    const room = line({ netPaise: 200_000 });
    const rmo = line({ component: "rmo", netPaise: 20_000 });
    const cross = line({ component: "cross_visit", netPaise: 100_000 });
    const s = splitBill([room, rmo, cross], insured({ roomRentCapPaise: 100_000 }));
    expect(by(s, rmo.id)).toMatchObject({ payerPaise: 10_000, reasons: ["room_rent_cap_proportional"] });
    expect(by(s, cross.id)).toMatchObject({ payerPaise: 50_000, reasons: ["room_rent_cap_proportional"] });
  });

  it("rent within the cap: no deduction; the cap is per day (another day's rent does not count)", () => {
    const d1 = line({ netPaise: 100_000, billedClass: "general" });
    const n1 = line({ component: "nursing", netPaise: 50_000 });
    const d2 = line({ serviceDate: "2030-01-02", netPaise: 400_000 });
    const n2 = line({ serviceDate: "2030-01-02", component: "nursing", netPaise: 90_000 });
    const s = splitBill([d1, n1, d2, n2], insured({ roomRentCapPaise: 100_000 }));
    expect(by(s, d1.id).reasons).toEqual([]);
    expect(by(s, n1.id)).toMatchObject({ payerPaise: 50_000, patientPaise: 0 });
    expect(by(s, n2.id)).toMatchObject({ payerPaise: 22_500, patientPaise: 67_500 });
  });

  it("critical-care days (ICU, NICU, PICU, HDU) are exempt from the cap and the proportional deduction", () => {
    for (const cls of ["icu", "nicu", "picu", "hdu"] as const) {
      const room = line({ billedClass: cls, netPaise: 600_000 });
      const nursing = line({ component: "nursing", billedClass: cls, netPaise: 200_000 });
      const s = splitBill([room, nursing], insured({ roomRentCapPaise: 100_000 }));
      expect(s.totals).toMatchObject({ patientPaise: 0, capDeductionPaise: 0 });
    }
  });

  it("a reversed line and its reversal are both 0/0; the corrected line is split on its own", () => {
    const wrong = line({});
    const rev = line({ netPaise: -400_000, source: "ipd.reversal", reversalOf: wrong.id });
    const nursing = line({ component: "nursing", netPaise: 90_000 });
    const s = splitBill([wrong, rev, nursing], insured({ roomRentCapPaise: 100_000 }));
    expect(by(s, wrong.id)).toMatchObject({ payerPaise: 0, patientPaise: 0, reasons: ["reversed"] });
    expect(by(s, rev.id)).toMatchObject({ payerPaise: 0, patientPaise: 0, reasons: ["reversed"] });
    // With the room line reversed, the day has no rent: nursing is not deducted.
    expect(by(s, nursing.id)).toMatchObject({ payerPaise: 90_000, patientPaise: 0 });
  });

  it("non-payables by service code or by tariff category (case-insensitive) are the patient's", () => {
    const a = line({ component: "nursing", serviceCode: "KIT_ADMISSION", category: "consumable", netPaise: 5_000 });
    const b = line({ component: "nursing", serviceCode: "X", category: "Toiletries", netPaise: 3_000 });
    const s = splitBill([a, b], insured(), { services: new Set(["kit_admission"]), categories: new Set(["toiletries"]) });
    expect(s.lines.map((l) => l.reasons)).toEqual([["non_payable"], ["non_payable"]]);
    expect(s.totals).toMatchObject({ nonPayablePaise: 8_000, patientPaise: 8_000, payerPaise: 0 });
  });

  it("co-pay comes after the cap and rounds the payer down", () => {
    const room = line({ netPaise: 100_001, billedClass: "general" });
    const s = splitBill([room], insured({ coPayBp: 1_000 }));
    expect(by(s, room.id)).toMatchObject({ payerPaise: 90_000, patientPaise: 10_001, reasons: ["co_pay"] });
    expect(s.totals.coPayPaise).toBe(10_001);
  });

  it("the approved amount is consumed in posting order; the line that crosses it is split, later lines go to the patient", () => {
    const a = line({ serviceDate: "2030-01-01", netPaise: 150_000, billedClass: "general" });
    const b = line({ serviceDate: "2030-01-02", netPaise: 150_000, billedClass: "general" });
    const c = line({ serviceDate: "2030-01-03", netPaise: 150_000, billedClass: "general" });
    const s = splitBill([c, b, a], insured({ approvedTotalPaise: 200_000 }));
    expect(by(s, a.id)).toMatchObject({ payerPaise: 150_000, reasons: [] });
    expect(by(s, b.id)).toMatchObject({ payerPaise: 50_000, patientPaise: 100_000, reasons: ["over_approved_amount"] });
    expect(by(s, c.id)).toMatchObject({ payerPaise: 0, patientPaise: 150_000, reasons: ["over_approved_amount"] });
    expect(s.words).toContain(`Above approved ${rupeeText(200_000)}: ${rupeeText(250_000)}`);
  });

  it("pending, denied, cash, reimbursement and scheme each decide the whole bill", () => {
    const ls = [line({ billedClass: "general", netPaise: 150_000 })];
    expect(splitBill(ls, insured({ authState: "pending" })).lines[0]).toMatchObject({ payerPaise: 0, reasons: ["auth_pending"] });
    expect(splitBill(ls, insured({ authState: "none" })).lines[0]).toMatchObject({ payerPaise: 0, reasons: ["auth_pending"] });
    expect(splitBill(ls, insured({ authState: "denied" })).lines[0]).toMatchObject({ payerPaise: 0, reasons: ["denied"] });
    expect(splitBill(ls, insured({ mode: "cash" })).lines[0]).toMatchObject({ payerPaise: 0, reasons: ["cash"] });
    expect(splitBill(ls, insured({ mode: "cash", deniedEver: true })).lines[0]).toMatchObject({ payerPaise: 0, reasons: ["denied"] });
    expect(splitBill(ls, insured({ mode: "reimbursement" })).lines[0]).toMatchObject({ payerPaise: 0, reasons: ["cash"] });
    const scheme = splitBill(ls, insured({ mode: "scheme", schemeNonCoveredPaise: 50_000, roomRentCapPaise: 1 }));
    expect(scheme.lines[0]).toMatchObject({ payerPaise: 150_000, patientPaise: 0, reasons: ["scheme"] });
    expect(scheme.totals.patientPaise).toBe(50_000);
    expect(scheme.approvedTotalPaise).toBe(100_000_000);
    expect(splitBill(ls, insured({ authState: "pending" })).approvedTotalPaise).toBeNull();
  });
});

const row = (over: Partial<AuthRowInput>): AuthRowInput => {
  n += 1;
  return {
    id: `A${String(n).padStart(4, "0")}`, entry: "initial", status: "requested", preAuthNumber: null, approvedTotalPaise: 0,
    counsellingDocumentId: null, roomRentCapPaise: null, roomRentCapSiBp: null, coPayBp: null,
    recordedAt: new Date(Date.UTC(2030, 0, 1, 0, n)), ...over,
  };
};

describe("splitTermsOf", () => {
  it("no rows: insured is awaiting authorisation; the payer kinds map to modes", () => {
    expect(splitTermsOf("insurance_cashless", [], null, 0)).toMatchObject({ mode: "insured", authState: "none", approvedTotalPaise: 0 });
    expect([null, "cash", "insurance_reimbursement", "corporate", "pmjay", "state_scheme"].map(splitModeOf))
      .toEqual(["cash", "cash", "reimbursement", "insured", "scheme", "scheme"]);
  });

  it("the latest approval's running total stands; a later REQUESTED enhancement keeps it", () => {
    const t = splitTermsOf("insurance_cashless", [
      row({ status: "requested" }),
      row({ status: "approved", approvedTotalPaise: 300_000, preAuthNumber: "PA-9" }),
      row({ entry: "enhancement", status: "requested", approvedTotalPaise: 300_000 }),
    ], null, 0);
    expect(t).toMatchObject({ authState: "approved", approvedTotalPaise: 300_000, preAuthNumber: "PA-9" });
  });

  it("each term is the latest stated value; an absolute cap and a % cap replace each other; a % cap resolves on the sum insured", () => {
    const rows = [row({ status: "approved", approvedTotalPaise: 1, roomRentCapPaise: 200_000, coPayBp: 1_000 }), row({ entry: "enhancement", status: "approved", approvedTotalPaise: 2, roomRentCapSiBp: 100 })];
    expect(splitTermsOf("insurance_cashless", rows, 50_000_000, 0)).toMatchObject({ roomRentCapPaise: 500_000, coPayBp: 1_000, exceptions: [] });
    // No sum insured on the coverage: never a guessed cap — none applied, and the desk is told.
    expect(splitTermsOf("insurance_cashless", rows, null, 0)).toMatchObject({ roomRentCapPaise: null, exceptions: ["room_rent_cap_unresolved"] });
    const back = [...rows, row({ entry: "enhancement", status: "approved", approvedTotalPaise: 3, roomRentCapPaise: 150_000 })];
    expect(splitTermsOf("insurance_cashless", back, null, 0)).toMatchObject({ roomRentCapPaise: 150_000, exceptions: [] });
  });

  it("a denial: denied, and cash consent missing until a payer change carrying a signed counselling document", () => {
    const denied = [row({}), row({ entry: "denial", status: "denied" })];
    expect(splitTermsOf("insurance_cashless", denied, null, 0)).toMatchObject({ authState: "denied", deniedEver: true, exceptions: ["cash_consent_missing"] });
    const unsigned = [...denied, row({ entry: "payer_change", status: "approved" })];
    expect(splitTermsOf("cash", unsigned, null, 0).exceptions).toEqual(["cash_consent_missing"]);
    const signed = [...denied, row({ entry: "payer_change", status: "approved", counsellingDocumentId: "DOC1" })];
    expect(splitTermsOf("cash", signed, null, 0)).toMatchObject({ mode: "cash", deniedEver: true, exceptions: [] });
  });

  it("a payer change starts a new authorisation: the old insurer's approval and terms do not carry", () => {
    const rows = [
      row({ status: "approved", approvedTotalPaise: 900_000, roomRentCapPaise: 100_000 }),
      row({ entry: "payer_change", status: "requested", counsellingDocumentId: "DOC2" }),
    ];
    expect(splitTermsOf("corporate", rows, null, 0)).toMatchObject({ mode: "insured", authState: "pending", approvedTotalPaise: 0, roomRentCapPaise: null });
  });
});

describe("capWarningOf", () => {
  it("over the cap: the per-day difference and the payer's share of nursing, RMO, visits in words", () => {
    expect(capWarningOf("private", 100_000, 400_000)).toEqual({
      targetClass: "private", capPerDayPaise: 100_000, rentPerDayPaise: 400_000, overPerDayPaise: 300_000, payerShareBp: 2_500,
      words: "Over cap by ₹3,000/day; insurer pays 25 % of nursing, RMO, visits",
    });
  });
  it("no warning without a cap, without a rent, within the cap, or for critical care", () => {
    expect(capWarningOf("private", null, 400_000)).toBeNull();
    expect(capWarningOf("private", 100_000, null)).toBeNull();
    expect(capWarningOf("general", 200_000, 150_000)).toBeNull();
    expect(capWarningOf("icu", 100_000, 600_000)).toBeNull();
  });
});
