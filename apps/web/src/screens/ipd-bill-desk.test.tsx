import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdBillDeskScreen } from "./ipd-bill-desk";
import type { IpdBillDesk, IpdBillDeskRow } from "@hmis/contracts";

/*
  E2.3 (#727) — the bill desk screen. Every value is synthetic: ids are `01FAKE…`, names invented, amounts made up; the
  shape is the contract's (`packages/contracts/src/ipd/bill-desk.ts`).
*/

const api = vi.hoisted(() => ({ getBillDesk: vi.fn(), retryPosting: vi.fn(), getInterimBill: vi.fn(), printInterimBill: vi.fn() }));
vi.mock("../lib/ipd-bill-api", () => api);

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
  };
  return { asOf: "2030-01-02T04:00:00.000Z", counts, rows, canRetry: false, ...over };
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

  it("says when nothing needs the desk, and refuses a reader without the permission in words", async () => {
    api.getBillDesk.mockResolvedValueOnce(desk({ rows: [], counts: desk().counts }));
    const { unmount } = renderWithRouter(<IpdBillDeskScreen />);
    expect(await screen.findByText("Nothing needs the desk. Normal running bills are not listed.")).toBeInTheDocument();
    unmount();
    api.getBillDesk.mockRejectedValueOnce(new ApiError(403, { code: "ipd_forbidden" }));
    renderWithRouter(<IpdBillDeskScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The bill desk is for billing staff");
  });
});
