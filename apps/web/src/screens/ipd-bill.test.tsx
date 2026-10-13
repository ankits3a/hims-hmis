import { screen, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdBillScreen } from "./ipd-bill";
import type { IpdInterimBill } from "@hmis/contracts";

/*
  E2.1 (#725) — the interim bill screen. Every value is synthetic: ids are `01FAKE…`, names invented, amounts made up;
  the shape is the contract's (`packages/contracts/src/ipd/charges.ts`).
*/

const api = vi.hoisted(() => ({ getInterimBill: vi.fn() }));
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
    depositPaidPaise: 500_000, balancePaise: 180_000,
    exceptions: [{ serviceDate: "2030-01-01", component: "nursing", billedClass: "private", serviceCode: "IPD_NURSING_PRIVATE", reason: "rate_missing", firstSeenAt: "2030-01-01T18:35:00.000Z" }],
    ...over,
  };
}

describe("IpdBillScreen", () => {
  beforeEach(() => { api.getInterimBill.mockReset(); });

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

  it("a user without the bill permission is told so, with no amounts", async () => {
    api.getInterimBill.mockRejectedValue(new ApiError(403, { code: "ipd_forbidden" }));
    renderWithRouter(<IpdBillScreen admissionId={ADM} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access to inpatient bills.");
    expect(screen.queryByText(/₹/)).toBeNull();
  });
});
