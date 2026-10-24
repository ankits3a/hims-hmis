import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdTpaScreen } from "./ipd-tpa";
import { TpaPanel } from "./ipd-tpa-panel";
import type { IpdTpaBoard, IpdTpaBoardRow, IpdTpaClaim, IpdTpaPanel } from "@hmis/contracts";

/*
  #604 (decision 0075) — the TPA desk board and the per-admission panel. Every value is synthetic: ids `01FAKE…`, names
  invented, amounts made up; the shapes are the contract's (`packages/contracts/src/ipd/tpa.ts`).
*/
const api = vi.hoisted(() => ({
  getTpaBoard: vi.fn(), getTpaPanel: vi.fn(), searchPackages: vi.fn(), importPackages: vi.fn(), recordQuery: vi.fn(), answerQuery: vi.fn(),
  attachDocument: vi.fn(), selectPackage: vi.fn(), removePackage: vi.fn(), submitClaim: vi.fn(), settleClaim: vi.fn(), rejectClaim: vi.fn(),
}));
vi.mock("../lib/ipd-tpa-api", () => api);
vi.mock("../lib/patients-api", () => ({ listPatientDocuments: vi.fn(() => Promise.resolve([])) }));

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const row = (n: number, over: Partial<IpdTpaBoardRow>): IpdTpaBoardRow => ({
  id: `preauth_waiting:${id(n)}`, kind: "preauth_waiting", admissionId: id(n), admissionNo: `IP30-00001${String(n)}`, patientName: `Synthetic Patient ${String(n)}`,
  payerKind: "insurance_cashless", preAuthNumber: `PA-FAKE-${String(n)}`, stage: "preauth", claimId: null, queryId: null,
  since: "2030-01-02T04:30:00.000Z", waitMinutes: 75, dueMinutes: 60, severity: "warn", approvedTotalPaise: null, claimablePaise: null, claimedPaise: null, ...over,
});

describe("IpdTpaScreen", () => {
  beforeEach(() => { api.getTpaBoard.mockReset(); });

  it("lists the work worst first with the clock and the state in words, filters by kind, and opens the stay's bill", async () => {
    const rows = [
      row(1, { severity: "hot", waitMinutes: 130 }),
      row(2, { id: `enhancement_due:${id(2)}`, kind: "enhancement_due", stage: "enhancement", severity: "warn", approvedTotalPaise: 480_000, claimablePaise: 440_000 }),
      row(3, { id: `claim_with_payer:${id(3)}`, kind: "claim_with_payer", stage: "claim", claimId: id(33), waitMinutes: 31 * 24 * 60, claimedPaise: 440_000 }),
    ];
    const board: IpdTpaBoard = {
      asOf: "2030-01-02T06:00:00.000Z", rows,
      counts: { query_open: 0, preauth_waiting: 1, enhancement_due: 1, claim_to_submit: 0, claim_with_payer: 1 },
    };
    api.getTpaBoard.mockResolvedValue(board);
    renderWithRouter(<IpdTpaScreen />);
    const list = await screen.findByRole("region", { name: "Work list" });
    const trs = within(list).getAllByRole("row").slice(1);
    expect(trs).toHaveLength(3);
    expect(within(trs[0]!).getByText("2 h 10 min")).toBeInTheDocument();
    expect(within(trs[0]!).getByText("Overdue")).toBeInTheDocument();
    expect(within(trs[1]!).getByText("₹4,400.00 of ₹4,800.00 approved")).toBeInTheDocument();
    expect(within(trs[2]!).getByText("31 days")).toBeInTheDocument();
    expect(within(trs[0]!).getByRole("link", { name: "Open" })).toHaveAttribute("href", `/ipd/admissions/${id(1)}/bill`);
    fireEvent.click(screen.getByRole("button", { name: /Claim with payer/ }));
    expect(within(list).getAllByRole("row").slice(1)).toHaveLength(1);
  });

  it("says so when the reader may not see the desk", async () => {
    api.getTpaBoard.mockRejectedValue(new ApiError(403, {}));
    renderWithRouter(<IpdTpaScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("You do not have access to the TPA desk.");
  });
});

const claim = (over: Partial<IpdTpaClaim>): IpdTpaClaim => ({
  id: id(50), finalBillId: id(51), state: "with_payer", claimRef: "CL-FAKE-1", submittedAt: "2030-01-03T04:30:00.000Z", ageDays: 3,
  billPayerPaise: 440_000, claimedPaise: 440_000, defaultClaimPaise: 440_000, netPaidPaise: null, tdsPaise: null, utrRef: null, settledOn: null,
  deductions: [], deductionsPaise: 0, packageVariancePaise: 0, unexplainedPaise: null, rejectionReason: null, missingDocuments: [], ...over,
});
const panel = (over: Partial<IpdTpaPanel>): IpdTpaPanel => ({
  admissionId: id(1), admissionNo: "IP30-000011", payerKind: "insurance_cashless", isScheme: false, preAuthNumber: "PA-FAKE-1",
  approvedTotalPaise: 1_000_000, waiting: null, enhancementDue: false, claimablePaise: null, auths: [], queries: [], documents: [], packages: [],
  packageAmountPaise: 0, claims: [], ...over,
});

describe("TpaPanel", () => {
  beforeEach(() => { api.getTpaPanel.mockReset(); api.settleClaim.mockReset(); });

  it("hides for a reader without the desk's permission", async () => {
    api.getTpaPanel.mockRejectedValue(new ApiError(403, {}));
    renderWithRouter(<TpaPanel admissionId={id(1)} patientId={id(2)} />);
    await waitFor(() => expect(api.getTpaPanel).toHaveBeenCalled());
    expect(screen.queryByTestId("tpa-panel")).toBeNull();
  });

  it("shows the pre-auth clock in words", async () => {
    api.getTpaPanel.mockResolvedValue(panel({ waiting: { stage: "preauth", since: "2030-01-02T04:30:00.000Z", waitMinutes: 75, dueMinutes: 60 } }));
    renderWithRouter(<TpaPanel admissionId={id(1)} patientId={id(2)} />);
    expect(await screen.findByText(/waiting 1 h 15 min/)).toBeInTheDocument();
    expect(screen.getByText("Due")).toBeInTheDocument();
  });

  it("records a settlement only once net, TDS and deductions add up to the claim", async () => {
    api.getTpaPanel.mockResolvedValue(panel({ claims: [claim({})] }));
    api.settleClaim.mockResolvedValue({ outcome: "short_paid" });
    renderWithRouter(<TpaPanel admissionId={id(1)} patientId={id(2)} />);
    const settle = await screen.findByRole("button", { name: "Record settlement" });
    fireEvent.change(screen.getByLabelText("Net paid"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("TDS"), { target: { value: "440" } });
    fireEvent.change(screen.getByLabelText("UTR"), { target: { value: "UTR-FAKE-1" } });
    expect(screen.getByText("Off by ₹960.00")).toBeInTheDocument();
    expect(settle).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add deduction" }));
    fireEvent.change(screen.getByLabelText("Deduction amount"), { target: { value: "960" } });
    expect(screen.getByText("Adds up to the claim")).toBeInTheDocument();
    fireEvent.click(settle);
    await waitFor(() => expect(api.settleClaim).toHaveBeenCalledWith(id(50), expect.objectContaining({
      netPaidPaise: 300_000, tdsPaise: 44_000, utrRef: "UTR-FAKE-1", deductions: [{ reason: "non_payable_items", amountPaise: 96_000 }],
    })));
  });
});
