import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdSettledBills } from "./ipd-settled-bills";
import type { IpdDischargeBillDesk, IpdFinalBill } from "@hmis/contracts";

/*
  #763 — the bill desk's settled bills: Supplementary bill and Void bill. Every value is synthetic: ids `01FAKE…`, numbers
  invented; the shapes are the contract's (`packages/contracts/src/ipd/discharge.ts`).
*/

const api = vi.hoisted(() => ({
  getSettledBills: vi.fn(), prepareSupplementaryBill: vi.fn(), settleSupplementaryBill: vi.fn(), askBillVoid: vi.fn(), voidBill: vi.fn(),
}));
vi.mock("../lib/ipd-discharge-api", () => api);

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;

function desk(voidApproval: IpdDischargeBillDesk["rows"][number]["bills"][number]["voidApproval"] = null): IpdDischargeBillDesk {
  return {
    rows: [{
      admissionId: id(1), admissionNo: "IP30-000041", state: "fit_declared", billNo: "INV-FAKE-1", duesPaise: 0, refundPaise: 0,
      settledAt: "2030-01-02T04:00:00.000Z", exceptions: ["settled_not_exited", "supplementary_owed"],
      bills: [{
        billId: id(11), kind: "final", seq: 0, billNo: "INV-FAKE-1", totalPaise: 900_000, patientPaise: 900_000, duesPaise: 0, refundPaise: 0,
        settledAt: "2030-01-02T04:00:00.000Z", voidApproval,
      }],
    }],
  };
}

const supp: IpdFinalBill = {
  admissionId: id(1), admissionNo: "IP30-000041", billVersion: 9,
  lines: [
    { lineId: id(21), serviceDate: "2030-01-03", serviceName: "Room", component: "room", qty: 1, netPaise: 250_000, payerPaise: 0, patientPaise: 250_000 },
    { lineId: id(22), serviceDate: "2030-01-03", serviceName: "Nursing", component: "nursing", qty: 1, netPaise: 50_000, payerPaise: 0, patientPaise: 50_000 },
  ],
  totalPaise: 300_000, payerPaise: 0, patientPaise: 300_000, patientRoundedPaise: 300_000, depositHeldPaise: 0, balancePaise: 300_000,
  payerKind: "cash", settled: null, exceptions: [],
};

describe("IpdSettledBills (#763)", () => {
  beforeEach(() => { for (const f of Object.values(api)) f.mockReset(); });

  it("composes the supplementary bill and records dues against the undertaking when the cash falls short", async () => {
    api.getSettledBills.mockResolvedValue(desk());
    api.prepareSupplementaryBill.mockResolvedValue(supp);
    api.settleSupplementaryBill.mockResolvedValue({ billNo: "INV-FAKE-2" });
    renderWithRouter(<IpdSettledBills />);
    const panel = await screen.findByRole("region", { name: "Settled bills" });
    expect(within(panel).getByText("Supplementary bill owed")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Supplementary bill" }));
    const form = await screen.findByRole("group", { name: "Supplementary bill" });
    expect(within(form).getByText("2 charges")).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Cash received ₹"), { target: { value: "1000" } });
    fireEvent.click(within(form).getByRole("button", { name: "Settle" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Dues need the signed undertaking");
    expect(api.settleSupplementaryBill).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText("Undertaking document"), { target: { value: id(31) } });
    fireEvent.click(within(form).getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(api.settleSupplementaryBill).toHaveBeenCalledTimes(1));
    expect(api.settleSupplementaryBill.mock.calls[0]![1]).toEqual({
      admissionId: id(1), billVersion: 9, patientPayablePaise: 300_000, settlement: "dues_recorded",
      payments: [{ tender: "cash", amountPaise: 100_000 }], undertakingDocumentId: id(31),
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Supplementary bill INV-FAKE-2 settled");
  });

  it("asks the void with a reason, waits for the approval, and voids with the granted approval", async () => {
    api.getSettledBills.mockResolvedValueOnce(desk());
    api.askBillVoid.mockResolvedValue({ approvalId: id(41) });
    api.getSettledBills.mockResolvedValueOnce(desk({ approvalId: id(41), status: "pending" }));
    const { unmount } = renderWithRouter(<IpdSettledBills />);
    const panel = await screen.findByRole("region", { name: "Settled bills" });
    fireEvent.click(within(panel).getByRole("button", { name: "Ask to void" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Ask to void" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Give a reason");
    fireEvent.change(within(panel).getByPlaceholderText("Reason"), { target: { value: "wrong class" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Ask to void" }));
    await waitFor(() => expect(api.askBillVoid).toHaveBeenCalledWith(id(1), id(11), "wrong class"));
    expect(await screen.findByText("Void waiting for approval")).toBeInTheDocument();
    unmount();

    api.getSettledBills.mockResolvedValue(desk({ approvalId: id(41), status: "granted" }));
    api.voidBill.mockRejectedValueOnce(new ApiError(422, { code: "refund_issued" }));
    renderWithRouter(<IpdSettledBills />);
    const again = await screen.findByRole("region", { name: "Settled bills" });
    fireEvent.click(within(again).getByRole("button", { name: "Void bill" }));
    fireEvent.change(within(again).getByPlaceholderText("Reason"), { target: { value: "wrong class" } });
    fireEvent.click(within(again).getByRole("button", { name: "Void bill" }));
    expect(await within(again).findByRole("alert")).toHaveTextContent("Refund already paid out — cannot void");
    expect(api.voidBill).toHaveBeenCalledWith(id(1), id(11), id(41), "wrong class");
  });

  it("shows nothing to a reader without the bill permission", async () => {
    api.getSettledBills.mockRejectedValue(new ApiError(403, { code: "ipd_forbidden" }));
    const { container } = renderWithRouter(<IpdSettledBills />);
    await waitFor(() => expect(api.getSettledBills).toHaveBeenCalled());
    expect(container.querySelector(".ipdsb")).toBeNull();
  });
});
