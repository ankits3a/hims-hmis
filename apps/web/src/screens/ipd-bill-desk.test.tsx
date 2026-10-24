import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdBillDeskScreen } from "./ipd-bill-desk";
import type { IpdBillDesk, IpdBillDeskRow } from "@hmis/contracts";

/*
  E2.3 (#727) — the bill desk screen. Every value is synthetic: ids are `01FAKE…`, names invented, amounts made up; the
  shape is the contract's (`packages/contracts/src/ipd/bill-desk.ts`).
*/

const api = vi.hoisted(() => ({ getBillDesk: vi.fn(), retryPosting: vi.fn(), getInterimBill: vi.fn(), printInterimBill: vi.fn(), resolveBackdatedVisit: vi.fn(),
  keepOrderCharge: vi.fn(), reverseOrderCharge: vi.fn() }));
vi.mock("../lib/ipd-bill-api", () => api);
// #763: the settled-bills panel under the list has its own wire (tested in ipd-settled-bills.test.tsx); silent here.
vi.mock("../lib/ipd-discharge-api", () => ({ getSettledBills: vi.fn(() => Promise.reject(new Error("not in this test"))) }));

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;

const row = (n: number, over: Partial<IpdBillDeskRow>): IpdBillDeskRow => ({
  admissionId: id(n), admissionNo: `IP30-00004${String(n)}`, state: "admitted",
  patient: { id: id(100 + n), uhid: `HMS-00012${String(n)}`, name: `Synthetic Patient ${String(n)}` },
  bedCode: `F5-MED-B1${String(n)}`, billedClass: "general", payerKind: "cash", reasons: ["deposit_75"], usedBp: 7_800,
  patientPayablePaise: 780_000, depositHeldPaise: 1_000_000, balancePaise: 220_000, icuBurn: null, since: "2030-01-02T03:30:00.000Z", ...over,
});

function desk(over: Partial<IpdBillDesk> = {}): IpdBillDesk {
  const rows = [
    row(1, { reasons: ["deposit_90"], usedBp: 9_400, patientPayablePaise: 940_000, balancePaise: 60_000 }),
    row(2, {}),
    row(3, { reasons: ["posting_failed"], usedBp: 2_000, billedClass: "icu", icuBurn: { perDayPaise: 800_000, days: 3, daysLeft: 1 } }),
    row(4, { reasons: ["deposit_check_pending"], usedBp: null, depositHeldPaise: 0, patientPayablePaise: 0, balancePaise: 0, patient: { id: id(104), uhid: "HMS-000999", name: "Alias Rose" } }),
  ];
  const counts = {
    deposit_90: 1, deposit_75: 1, icu_low_days: 0, posting_failed: 1, rate_missing: 0, tariff_missing: 0, deposit_check_pending: 1,
    cash_consent_missing: 0, auth_pending_24h: 0, discharge_balance: 0,
    // IPD/ER train B2 — the contracts are final: the order, return and reissue exceptions arrive with later lanes.
    visit_backdated: 0, order_cancelled_after_bill: 0, order_cancelled_after_work: 0, return_after_bill: 0, reissue_lost_damaged: 0,
  };
  const dailyTotals = {
    billDate: "2030-01-01", sending: { on: true, channels: ["whatsapp" as const], missing: [], sendHourIst: 9 }, sent: 5, waiting: 0, notSent: [],
  };
  return { asOf: "2030-01-02T04:00:00.000Z", counts, rows, canRetry: false, dailyTotals, ...over };
}

describe("IpdBillDeskScreen", () => {
  beforeEach(() => { api.getBillDesk.mockReset(); api.retryPosting.mockReset(); });

  it("lists the exceptions with their reasons in words, the deposit used, the ICU burn, and opens each interim bill", async () => {
    api.getBillDesk.mockResolvedValue(desk());
    renderWithRouter(<IpdBillDeskScreen />);
    const list = await screen.findByRole("region", { name: "Admissions that need the desk" });
    const rows = within(list).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Deposit 90 % used")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("94 %")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("₹8,000.00/day")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("1 day left")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("Alias Rose")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("link", { name: "Open bill" })).toHaveAttribute("href", `/ipd/admissions/${id(2)}/bill`);
    // Retry is the billing manager's: not offered to this reader.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("filters by a count and offers Retry on a failed posting to the billing manager", async () => {
    api.getBillDesk.mockResolvedValue(desk({ canRetry: true }));
    api.retryPosting.mockResolvedValue({ posted: 3, rentDays: ["2030-01-01"], exceptions: 0 });
    renderWithRouter(<IpdBillDeskScreen />);
    const counts = await screen.findByRole("navigation", { name: "Exceptions by kind" });
    fireEvent.click(within(counts).getByRole("button", { name: /Posting failed/ }));
    const list = screen.getByRole("region", { name: "Admissions that need the desk" });
    expect(within(list).getAllByRole("row").slice(1)).toHaveLength(1);
    expect(within(counts).getByRole("button", { name: /Rate missing/ })).toBeDisabled();
    fireEvent.click(within(list).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.retryPosting).toHaveBeenCalledWith(id(3)));
    expect(await screen.findByRole("status")).toHaveTextContent("Retried — 3 lines posted");
    expect(api.getBillDesk).toHaveBeenCalledTimes(2);
  });

  it("#761: shows the daily totals to attendants — off says 'template not configured', and every not-sent line is listed", async () => {
    api.getBillDesk.mockResolvedValue(desk({
      dailyTotals: {
        billDate: "2030-01-01", sending: { on: false, channels: [], missing: ["IPD_DAILY_TOTALS_WHATSAPP_TEMPLATE or IPD_DAILY_TOTALS_DLT_TEMPLATE_ID"], sendHourIst: 9 },
        sent: 0, waiting: 0,
        notSent: [
          { admissionId: id(7), admissionNo: "IP30-000047", billDate: "2030-01-01", status: "not_sent", words: "Not sent: template not configured" },
          { admissionId: id(8), admissionNo: "IP30-000048", billDate: "2030-01-01", status: "not_sent", words: "Not sent: no consent recorded" },
        ],
      },
    }));
    renderWithRouter(<IpdBillDeskScreen />);
    const strip = await screen.findByRole("region", { name: "Daily totals to attendants" });
    expect(within(strip).getByText("Sending is off: template not configured")).toBeInTheDocument();
    const lines = within(strip).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(within(lines[0]!).getByText("Not sent: template not configured")).toBeInTheDocument();
    expect(within(lines[1]!).getByRole("link", { name: "IP30-000048" })).toHaveAttribute("href", `/ipd/admissions/${id(8)}/bill`);
  });

  it("says when nothing needs the desk, and refuses a reader without the permission in words", async () => {
    api.getBillDesk.mockResolvedValueOnce(desk({ rows: [], counts: desk().counts }));
    const { unmount } = renderWithRouter(<IpdBillDeskScreen />);
    expect(await screen.findByText("Nothing needs the desk. Normal running bills are not listed.")).toBeInTheDocument();
    unmount();
    api.getBillDesk.mockRejectedValueOnce(new ApiError(403, { code: "ipd_forbidden" }));
    renderWithRouter(<IpdBillDeskScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The bill desk is for billing staff");
  });

  it("E4.2: a backdated round visit offers Charge visit and Waive, each needing a reason, to the billing manager only", async () => {
    const backdated = row(5, {
      reasons: ["visit_backdated"], backdatedVisits: [{ exceptionId: "x-1", serviceDate: "2030-01-01", consultantName: "Dr Synthetic" }],
    });
    api.getBillDesk.mockResolvedValue(desk({ canRetry: false, rows: [backdated] }));
    const { unmount } = renderWithRouter(<IpdBillDeskScreen />);
    expect((await screen.findAllByText("Visit backdated")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Charge visit" })).toBeNull();
    unmount();

    api.getBillDesk.mockResolvedValue(desk({ canRetry: true, rows: [backdated] }));
    api.resolveBackdatedVisit.mockResolvedValue({ outcome: "charged" });
    renderWithRouter(<IpdBillDeskScreen />);
    const box = await screen.findByTestId("backdated-x-1");
    expect(box).toHaveTextContent("Round on 2030-01-01 by Dr Synthetic — entered late");
    const charge = within(box).getByRole("button", { name: "Charge visit" });
    const waive = within(box).getByRole("button", { name: "Waive" });
    expect(charge).toBeDisabled();
    expect(waive).toBeDisabled();
    fireEvent.change(within(box).getByLabelText("Reason (required)"), { target: { value: "Night round, written late" } });
    fireEvent.click(waive);
    await waitFor(() => expect(api.resolveBackdatedVisit).toHaveBeenCalledWith("x-1", "waive", "Night round, written late"));
    expect(await screen.findByText("Backdated visit settled")).toBeInTheDocument();
  });

  it("#785: a cancelled order's charge offers Keep charge and Reverse after void, each needing a reason, to ipd.charges.reverse only", async () => {
    const cancelled = row(6, {
      reasons: ["order_cancelled_after_bill", "order_cancelled_after_work"],
      orderCancels: [
        { chargeLineId: "line-1", reason: "order_cancelled_after_bill", serviceName: "CBC", serviceDate: "2030-01-01" },
        { chargeLineId: "line-2", reason: "order_cancelled_after_work", serviceName: "LFT", serviceDate: "2030-01-01" },
      ],
    } as Partial<IpdBillDeskRow>);
    api.getBillDesk.mockResolvedValue(desk({ canRetry: false, rows: [cancelled] }));
    const { unmount } = renderWithRouter(<IpdBillDeskScreen />);
    expect((await screen.findAllByText("Cancelled after bill")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Keep charge" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reverse after void" })).toBeNull();
    unmount();

    api.getBillDesk.mockResolvedValue(desk({ canRetry: true, rows: [cancelled] }));
    api.keepOrderCharge.mockResolvedValue({ resolved: 1 });
    api.reverseOrderCharge.mockResolvedValue({ reversalLineId: "rev-1" });
    renderWithRouter(<IpdBillDeskScreen />);
    const billed = await screen.findByTestId("order-cancel-line-1");
    expect(billed).toHaveTextContent("CBC · 2030-01-01 — cancelled after the bill");
    const keep = within(billed).getByRole("button", { name: "Keep charge" });
    const reverse = within(billed).getByRole("button", { name: "Reverse after void" });
    expect(keep).toBeDisabled();
    expect(reverse).toBeDisabled();
    fireEvent.change(within(billed).getByLabelText("Reason (required)"), { target: { value: "Bill voided; test not done" } });
    fireEvent.click(reverse);
    await waitFor(() => expect(api.reverseOrderCharge).toHaveBeenCalledWith("line-1", "Bill voided; test not done"));
    const work = screen.getByTestId("order-cancel-line-2");
    expect(work).toHaveTextContent("LFT · 2030-01-01 — cancelled after the sample");
    fireEvent.change(within(work).getByLabelText("Reason (required)"), { target: { value: "Sample processed" } });
    fireEvent.click(within(work).getByRole("button", { name: "Keep charge" }));
    await waitFor(() => expect(api.keepOrderCharge).toHaveBeenCalledWith("line-2", "Sample processed"));
    expect(await screen.findByText("Cancelled order settled")).toBeInTheDocument();
  });
});
