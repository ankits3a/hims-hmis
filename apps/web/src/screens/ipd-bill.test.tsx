import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdBillScreen } from "./ipd-bill";
import type { IpdInterimBill } from "@hmis/contracts";

/*
  E2.1 (#725) — the interim bill screen. Every value is synthetic: ids are `01FAKE…`, names invented, amounts made up;
  the shape is the contract's (`packages/contracts/src/ipd/charges.ts`).
*/

const api = vi.hoisted(() => ({ getInterimBill: vi.fn(), printInterimBill: vi.fn() }));
vi.mock("../lib/ipd-bill-api", () => api);

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const ADM = id(3);

const line = (n: number, over: Partial<IpdInterimBill["days"][number]["lines"][number]>): IpdInterimBill["days"][number]["lines"][number] => ({
  id: id(n), serviceDate: "2030-01-01", component: "room", billedClass: "general", serviceCode: "IPD_ROOM_GENERAL", serviceName: "IPD_ROOM_GENERAL",
  qty: 1, unitPaise: 150_000, grossPaise: 150_000, discountPaise: 0, gstPaise: 0, netPaise: 150_000, source: "ipd.nightly",
  consultantName: null, reversalOf: null, reversed: false, reason: null, postedAt: "2030-01-01T18:35:00.000Z", ...over,
});

function bill(over: Partial<IpdInterimBill> = {}): IpdInterimBill {
  return {
    admissionId: ADM, admissionNo: "IP30-000042", state: "admitted", patient: { id: id(1), uhid: "HMS-000123", name: "Ramesh Kumar" },
    admittedAt: "2029-12-31T17:30:00.000Z", dischargedAt: null, payerKind: "cash", tariffVersionNo: 7, postedThrough: "2030-01-01",
    stays: [
      { bedCode: "F5-MED-B12", bedClass: "general", billedClass: "general", startedAt: "2029-12-31T17:30:00.000Z", endedAt: "2030-01-01T04:30:00.000Z" },
      { bedCode: "F6-PVT-04", bedClass: "private", billedClass: "private", startedAt: "2030-01-01T04:30:00.000Z", endedAt: null },
    ],
    days: [
      { date: "2029-12-31", billedClass: "general", totalPaise: 200_000, lines: [
        line(10, { serviceDate: "2029-12-31" }),
        line(11, { serviceDate: "2029-12-31", component: "nursing", serviceCode: "IPD_NURSING_GENERAL", unitPaise: 50_000, grossPaise: 50_000, netPaise: 50_000 }),
      ] },
      { date: "2030-01-01", billedClass: "private", totalPaise: 120_000, lines: [
        line(12, { billedClass: "private", serviceCode: "IPD_ROOM_PRIVATE", unitPaise: 400_000, grossPaise: 400_000, netPaise: 400_000, reversed: true }),
        line(13, { billedClass: "private", serviceCode: "IPD_ROOM_PRIVATE", unitPaise: -400_000, grossPaise: -400_000, netPaise: -400_000, source: "ipd.reversal", reversalOf: id(12), reason: "Wrong class" }),
        line(14, { component: "visit", serviceCode: "IPD_VISIT_PRIVATE", unitPaise: 120_000, grossPaise: 120_000, netPaise: 120_000, source: "ipd.visit", consultantName: "Dr Synthetic" }),
      ] },
    ],
    byComponent: [{ component: "room", netPaise: 150_000 }, { component: "nursing", netPaise: 50_000 }, { component: "visit", netPaise: 120_000 }],
    totals: { grossPaise: 320_000, discountPaise: 0, gstPaise: 0, netPaise: 320_000, roundedPaise: 320_000 },
    depositPaidPaise: 500_000, balancePaise: 180_000, patientBalancePaise: 180_000,
    payerSplit: {
      mode: "cash", authState: "none", preAuthNumber: null, approvedTotalPaise: null, roomRentCapPaise: null, coPayBp: null,
      lines: [], totals: { payerPaise: 0, patientPaise: 320_000, nonPayablePaise: 0, capDeductionPaise: 0, coPayPaise: 0, overApprovedPaise: 0 },
      schemeNonCoveredPaise: 0, words: ["Cash: patient pays all"], exceptions: [],
    },
    exceptions: [{ serviceDate: "2030-01-01", component: "nursing", billedClass: "private", serviceCode: "IPD_NURSING_PRIVATE", reason: "rate_missing", errorCode: null, failCount: 0, firstSeenAt: "2030-01-01T18:35:00.000Z" }],
    ...over,
  };
}

describe("IpdBillScreen", () => {
  beforeEach(() => { api.getInterimBill.mockReset(); api.printInterimBill.mockReset(); });

  it("shows the days with their class, each move with its hour, the missing rate, and the deposit left in words", async () => {
    api.getInterimBill.mockResolvedValue(bill());
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    expect(await screen.findByRole("heading", { name: "Interim bill" })).toBeInTheDocument();
    expect(api.getInterimBill).toHaveBeenCalledWith(ADM);
    const lines = screen.getByRole("region", { name: "Charges by day" });
    expect(within(lines).getAllByText("General ward").length).toBeGreaterThan(0);
    expect(within(lines).getByText("Private room")).toBeInTheDocument();
    expect(within(lines).getByText("Reversal")).toBeInTheDocument();
    expect(within(lines).getByText("Wrong class")).toBeInTheDocument();
    expect(within(lines).getByText(/Dr Synthetic/)).toBeInTheDocument();
    const moves = screen.getByRole("region", { name: "Beds and moves" });
    expect(within(moves).getByText("F6-PVT-04")).toBeInTheDocument();
    expect(within(moves).getByText(/01 Jan 10:00 → now/)).toBeInTheDocument();
    const ex = screen.getByRole("region", { name: "Not posted" });
    expect(within(ex).getByText("Rate missing")).toBeInTheDocument();
    expect(within(ex).getByText("IPD_NURSING_PRIVATE")).toBeInTheDocument();
    const totals = screen.getByRole("region", { name: "Totals" });
    expect(within(totals).getByText("Deposit left")).toBeInTheDocument();
    expect(within(totals).getByText("₹1,800.00")).toBeInTheDocument();
  });

  it("says Due when the bill passes the deposit, and hides the exceptions panel when there are none", async () => {
    api.getInterimBill.mockResolvedValue(bill({ depositPaidPaise: 0, balancePaise: -320_000, exceptions: [] }));
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    const totals = await screen.findByRole("region", { name: "Totals" });
    expect(within(totals).getByText("Due")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Not posted" })).toBeNull();
  });

  it("E2.2: a cashless stay shows Payer and Patient per line with the reason, the cap deduction in words, and the patient balance", async () => {
    const insured = bill({
      payerKind: "insurance_cashless", patientBalancePaise: -20_000,
      payerSplit: {
        mode: "insured", authState: "approved", preAuthNumber: "PA-FAKE-1", approvedTotalPaise: 1_000_000, roomRentCapPaise: 100_000, coPayBp: null,
        lines: [
          { lineId: id(10), payerPaise: 100_000, patientPaise: 50_000, reasons: ["room_rent_over_cap"] },
          { lineId: id(11), payerPaise: 33_333, patientPaise: 16_667, reasons: ["room_rent_cap_proportional"] },
          { lineId: id(12), payerPaise: 0, patientPaise: 0, reasons: ["reversed"] },
          { lineId: id(13), payerPaise: 0, patientPaise: 0, reasons: ["reversed"] },
          { lineId: id(14), payerPaise: 120_000, patientPaise: 0, reasons: [] },
        ],
        totals: { payerPaise: 253_333, patientPaise: 66_667, nonPayablePaise: 0, capDeductionPaise: 66_667, coPayPaise: 0, overApprovedPaise: 0 },
        schemeNonCoveredPaise: 0, words: ["Room ₹1,500/day over ₹1,000 cap: nursing, RMO, visits paid 66.66 %", "Room-rent cap deduction ₹666.67"], exceptions: [],
      },
    });
    api.getInterimBill.mockResolvedValue(insured);
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    const lines = await screen.findByRole("region", { name: "Charges by day" });
    expect(within(lines).getByRole("columnheader", { name: "Payer" })).toBeInTheDocument();
    expect(within(lines).getByRole("columnheader", { name: "Patient" })).toBeInTheDocument();
    expect(within(lines).getByText("Over room cap")).toBeInTheDocument();
    expect(within(lines).getByText("Cap proportional")).toBeInTheDocument();
    const split = screen.getByRole("region", { name: "Payer split" });
    expect(within(split).getByText("Authorised")).toBeInTheDocument();
    expect(within(split).getByText("Pre-auth PA-FAKE-1")).toBeInTheDocument();
    expect(within(split).getByText(/over ₹1,000 cap/)).toBeInTheDocument();
    expect(within(split).getByText("Room-rent cap deduction ₹666.67")).toBeInTheDocument();
    expect(within(split).getByText("Patient due")).toBeInTheDocument();
    expect(within(split).getByText("₹200.00")).toBeInTheDocument();
  });

  it("E2.2: a denied stay flags the missing cash consent; a plain cash stay shows no split card or columns", async () => {
    api.getInterimBill.mockResolvedValue(bill({
      payerSplit: {
        mode: "insured", authState: "denied", preAuthNumber: null, approvedTotalPaise: null, roomRentCapPaise: null, coPayBp: null,
        lines: [{ lineId: id(10), payerPaise: 0, patientPaise: 150_000, reasons: ["denied"] }],
        totals: { payerPaise: 0, patientPaise: 150_000, nonPayablePaise: 0, capDeductionPaise: 0, coPayPaise: 0, overApprovedPaise: 0 },
        schemeNonCoveredPaise: 0, words: ["Pre-auth denied: cash from admission"], exceptions: ["cash_consent_missing"],
      },
    }));
    const first = renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    const split = await screen.findByRole("region", { name: "Payer split" });
    expect(within(split).getByRole("alert")).toHaveTextContent("Cash consent missing");
    first.unmount();
    api.getInterimBill.mockResolvedValue(bill());
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    await screen.findByRole("region", { name: "Totals" });
    expect(screen.queryByRole("region", { name: "Payer split" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Payer" })).toBeNull();
  });

  it("E2.2: Print keeps the split as printed, then prints", async () => {
    api.getInterimBill.mockResolvedValue(bill());
    api.printInterimBill.mockResolvedValue({ snapshotId: id(99), printedAt: "2030-01-02T00:00:00.000Z", payerPaise: 0, patientPaise: 320_000 });
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => undefined);
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    fireEvent.click(await screen.findByRole("button", { name: "Print" }));
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    expect(api.printInterimBill).toHaveBeenCalledWith(ADM);
    printSpy.mockRestore();
  });

  it("a user without the bill permission is told so, with no amounts", async () => {
    api.getInterimBill.mockRejectedValue(new ApiError(403, { code: "ipd_forbidden" }));
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access to inpatient bills.");
    expect(screen.queryByText(/₹/)).toBeNull();
  });
});
