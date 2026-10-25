import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError, setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdDischarge } from "./ipd-discharge";
import type { IpdDischargeBoard, IpdDischargeTracker, IpdFinalBill } from "@hmis/contracts";

/*
  E3.2 (#730) — the discharge desk. Every value is synthetic: ids are `01FAKE…`, names are invented, the tracker is a
  fixture shaped by the contract (`packages/contracts/src/ipd/discharge.ts`).
*/

const api = vi.hoisted(() => ({
  getDischargeBoard: vi.fn(), getDischargeTracker: vi.fn(), getSummary: vi.fn(), confirmDepartment: vi.fn(), scanGatePass: vi.fn(),
  prepareFinalBill: vi.fn(), settleFinalBill: vi.fn(), issueGatePass: vi.fn(),
}));
const docsApi = vi.hoisted(() => ({ listPatientDocuments: vi.fn() }));
vi.mock("../lib/patients-api", async (orig) => {
  const real = await orig<typeof import("../lib/patients-api")>();
  return { ...real, ...docsApi };
});
vi.mock("../lib/ipd-discharge-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-discharge-api")>();
  return { ...real, ...api };
});

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const ahead = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();
const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();

const BOARD: IpdDischargeBoard = {
  rows: [{
    admissionId: id(1), admissionNo: "IP26-000101", state: "fit_declared", patientName: "Test Patient One", uhid: "UH-FAKE-1", bedCode: "F05-MED-B01",
    fitAt: ago(40), targetAt: ahead(140), nextStep: "departments", blocker: "Waiting: Pharmacy, Billing · Summary not signed · Final bill not settled",
  }],
};

const BILL: IpdFinalBill = {
  admissionId: id(1), admissionNo: "IP26-000101", billVersion: 6, lines: [], totalPaise: 440_000, payerPaise: 0, patientPaise: 440_000,
  patientRoundedPaise: 440_000, depositHeldPaise: 500_000, balancePaise: -60_000, payerKind: "cash", settled: null, exceptions: [],
};

function tracker(over: Partial<IpdDischargeTracker> = {}): IpdDischargeTracker {
  return {
    admissionId: id(1), admissionNo: "IP26-000101", state: "fit_declared",
    patient: { id: id(2), uhid: "UH-FAKE-1", name: "Test Patient One", ageSex: "F 52" }, bedCode: "F05-MED-B01", wardName: "5A Medicine",
    consultant: { id: "u-doc", name: "Fake Rao" }, disposition: "home", fitAt: ago(40), targetAt: ahead(140),
    steps: [
      { key: "fit", state: "done", at: ago(40), waitingFor: null },
      { key: "departments", state: "now", at: null, waitingFor: "Pharmacy, Billing" },
      { key: "summary", state: "now", at: null, waitingFor: "Dr Fake Rao" },
      { key: "bill", state: "waiting", at: null, waitingFor: null },
      { key: "gate_pass", state: "waiting", at: null, waitingFor: null },
      { key: "exit", state: "waiting", at: null, waitingFor: null },
    ],
    departments: [
      { department: "billing", basis: "always", confirmedAt: null, confirmedBy: null },
      { department: "pharmacy", basis: "open_orders", confirmedAt: null, confirmedBy: null },
      { department: "ward", basis: "lines", confirmedAt: ago(10), confirmedBy: "Sister Fake" },
    ],
    summary: { status: "none", signedBy: null, version: 0 }, gatePass: null, exit: null,
    blocker: "Waiting: Pharmacy, Billing · Summary not signed · Final bill not settled",
    bill: null,
    can: { declareFit: false, cancelFit: false, confirm: ["pharmacy"], editSummary: false, signSummary: false, settle: false, issueGatePass: false, scan: false, exit: false },
    ...over,
  };
}

beforeEach(() => {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.discharge.view"], scoped: { department: {}, floor: {} } } }), { status: 200 })));
  api.getDischargeBoard.mockReset().mockResolvedValue(BOARD);
  api.getDischargeTracker.mockReset().mockResolvedValue(tracker());
  api.getSummary.mockReset().mockRejectedValue(new Error("none"));
  api.confirmDepartment.mockReset().mockResolvedValue({});
  api.scanGatePass.mockReset().mockResolvedValue({ admissionId: id(1), state: "discharged" });
  api.prepareFinalBill.mockReset().mockResolvedValue({ ...BILL, balancePaise: 40_000, depositHeldPaise: 400_000 });
  api.settleFinalBill.mockReset();
  api.issueGatePass.mockReset();
  docsApi.listPatientDocuments.mockReset().mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("Discharge desk (E3.2)", () => {
  it("lists the cascade with the clock, the next step and the blocker named", async () => {
    renderWithRouter(<IpdDischarge />, "/ipd/discharge");
    const row = await screen.findByTestId(`ipdd-row-${id(1)}`);
    expect(row).toHaveTextContent("Test Patient One");
    expect(row).toHaveTextContent("F05-MED-B01");
    expect(row).toHaveTextContent("Fit declared");
    expect(row).toHaveTextContent("Next: Departments confirm charges");
    expect(row).toHaveTextContent(/2 h 1[89] min left/);
    expect(row).toHaveTextContent("Waiting: Pharmacy, Billing");
  });

  it("opens one admission: steps with times and whom they wait for; a department confirms its own; no money without the bill", async () => {
    renderWithRouter(<IpdDischarge />, `/ipd/discharge?admission=${id(1)}`);
    const tr = await screen.findByTestId("ipdd-tracker");
    expect(within(screen.getByTestId("ipdd-step-fit")).getByText(/Done \d\d:\d\d/)).toBeInTheDocument();
    expect(screen.getByTestId("ipdd-step-departments")).toHaveTextContent("Waiting: Pharmacy, Billing");
    expect(screen.getByTestId("ipdd-step-summary")).toHaveTextContent("Waiting: Dr Fake Rao");
    expect(tr).toHaveTextContent("⛔ Waiting: Pharmacy, Billing · Summary not signed · Final bill not settled");
    // A doctor-shaped tracker (bill null) shows no money anywhere.
    expect(tr.textContent ?? "").not.toMatch(/₹|Final bill\b.*Bill total/);
    expect(screen.queryByText("Bill total")).toBeNull();

    // Only the department the viewer may confirm has a button.
    const buttons = screen.getAllByRole("button", { name: "Confirm no pending charge" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    await waitFor(() => expect(api.confirmDepartment).toHaveBeenCalledWith(id(1), "pharmacy"));
  });

  it("shows the bill to a billing viewer: total, deposit and the refund due", async () => {
    api.getDischargeTracker.mockResolvedValue(tracker({ bill: BILL, can: { ...tracker().can, settle: true, confirm: [] } }));
    renderWithRouter(<IpdDischarge />, `/ipd/discharge?admission=${id(1)}`);
    expect(await screen.findByText("Bill total")).toBeInTheDocument();
    expect(screen.getByText("Refund due")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open final bill" })).toBeInTheDocument();
  });

  it("scans a gate pass at the desk", async () => {
    renderWithRouter(<IpdDischarge />, "/ipd/discharge");
    await screen.findByTestId(`ipdd-row-${id(1)}`);
    await userEvent.type(screen.getByRole("textbox", { name: "Scan gate pass" }), "GP-FAKE00001");
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    await waitFor(() => expect(api.scanGatePass).toHaveBeenCalledWith("GP-FAKE00001", "01K0000000000000000000GATE"));
    expect(await screen.findByRole("status")).toHaveTextContent("GP-FAKE00001 — patient left");
  });

  it("#763 ⚖: charges after the settled bill — the gate pass records them as dues against the picked undertaking", async () => {
    const settledBill: IpdFinalBill = {
      ...BILL, balancePaise: 0,
      settled: { billNo: "B1", settlement: "paid", paidPaise: 0, refundPaise: 0, refundState: "none", duesPaise: 0, duesApproved: false, settledAt: ago(60) },
      exceptions: ["settled_not_exited"],
    };
    api.getDischargeTracker.mockResolvedValue(tracker({ bill: settledBill, can: { ...tracker().can, issueGatePass: true, confirm: [] } }));
    docsApi.listPatientDocuments.mockResolvedValue([{ id: id(9), kind: "consent", capturedAt: ago(5) }] as never);
    api.issueGatePass.mockRejectedValueOnce(new ApiError(409, {
      statusCode: 409, code: "supplementary_unsettled", message: "x",
      rule: "Charges after the final bill need a supplementary bill settled or dues recorded.", fix: "Settle or record dues",
    })).mockResolvedValue({ code: "GP-FAKE00002" });
    renderWithRouter(<IpdDischarge />, `/ipd/discharge?admission=${id(1)}`);
    const issue = await screen.findByRole("button", { name: "Issue gate pass" });
    await userEvent.click(issue);
    expect(await screen.findByText(/Charges after the final bill — record them as dues/)).toBeInTheDocument();
    // The final bill's own capture: pick the signed undertaking from the patient's documents; not issuable without it.
    expect(issue).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Signed undertaking (filed document)" }), id(9));
    await userEvent.click(issue);
    await waitFor(() => expect(api.issueGatePass).toHaveBeenCalledTimes(2));
    expect(api.issueGatePass.mock.calls[1]).toEqual([id(1), undefined, id(9)]);
  });

  it("review #762 item 12: a retried settle re-sends the SAME idempotency key; a changed form gets a new one", async () => {
    api.getDischargeTracker.mockResolvedValue(tracker({ bill: BILL, can: { ...tracker().can, settle: true, confirm: [] } }));
    api.settleFinalBill.mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("timeout")).mockResolvedValue({ billNo: "B1" });
    renderWithRouter(<IpdDischarge />, `/ipd/discharge?admission=${id(1)}`);
    await userEvent.click(await screen.findByRole("button", { name: "Open final bill" }));
    const settleBtn = await screen.findByRole("button", { name: "Settle bill" });
    await userEvent.click(settleBtn);
    await waitFor(() => expect(api.settleFinalBill).toHaveBeenCalledTimes(1));
    await userEvent.click(settleBtn);
    await waitFor(() => expect(api.settleFinalBill).toHaveBeenCalledTimes(2));
    const [k1] = api.settleFinalBill.mock.calls[0]! as [string];
    const [k2, body2] = api.settleFinalBill.mock.calls[1]! as [string, { patientPayablePaise: number }];
    expect(k2).toBe(k1);
    expect(body2.patientPayablePaise).toBe(440_000);
    const amount = screen.getByRole("textbox", { name: "Amount (₹)" });
    await userEvent.clear(amount);
    await userEvent.type(amount, "450");
    await userEvent.click(settleBtn);
    await waitFor(() => expect(api.settleFinalBill).toHaveBeenCalledTimes(3));
    expect((api.settleFinalBill.mock.calls[2]! as [string])[0]).not.toBe(k1);
  });
});
