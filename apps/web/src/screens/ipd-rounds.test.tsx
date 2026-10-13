import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdRoundPatientScreen, IpdRounds } from "./ipd-rounds";
import type { IpdRoundPatient, IpdRoundsList, IpdRoundsRow } from "@hmis/contracts";

/*
  E4.2 (#734) — Rounds: the doctor's list and the patient's round page. Every value is synthetic: ids are `01FAKE…`,
  names are invented, the bodies are fixtures shaped by the contract (`packages/contracts/src/ipd/rounds.ts`).
*/

const api = vi.hoisted(() => ({ getRoundsList: vi.fn(), getRoundPatient: vi.fn(), signRound: vi.fn(), cosignRound: vi.fn(), stopOrder: vi.fn() }));
vi.mock("../lib/ipd-rounds-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-rounds-api")>();
  return { ...real, ...api };
});

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const NOW = new Date().toISOString();
const MONEY = /₹|paise|rupee|\bfee\b|\bcharges?\b|\bbill\b|payable|deposit|price/i; // "discharge" is not money

function row(n: number, over: Partial<IpdRoundsRow> = {}): IpdRoundsRow {
  return {
    admissionId: id(n), admissionNo: `IP26-00000${n}`, patient: { name: `Test Patient ${n}`, uhid: `UH-FAKE-${n}`, ageYears: 52, sex: "male", sealed: false },
    bedCode: `F05-MED-B0${n}`, wardCode: "F05-MED", wardName: "5A Medicine", boarded: false, why: "own", consultantName: "Dr Fake",
    state: "admitted", dayOfStay: 3, roundToday: "none", lastRoundAt: null, activeOrders: 2, fitWhen: null, consultId: null, ...over,
  };
}

const list: IpdRoundsList = {
  asOf: NOW, isConsultant: true,
  rows: [
    row(1),
    row(2, { boarded: true, wardCode: "F06-SUR", wardName: "6A Surgery", roundToday: "signed", why: "unit", consultantName: "Dr Head" }),
  ],
  cosignQueue: [{
    roundId: id(40), admissionId: id(1), authorId: "u-res", authorName: "Dr Resident", authorKind: "resident", mode: "bedside", seenAt: NOW,
    soap: { assessment: "Afebrile" }, status: "awaiting_cosign", source: "typed", provenance: "person", cosignedByName: null, cosignedAt: null,
    patient: { name: "Test Patient 1", uhid: "UH-FAKE-1", ageYears: 52, sex: "male", sealed: false }, bedCode: "F05-MED-B01",
  }],
};

const patient: IpdRoundPatient = {
  asOf: NOW, admissionId: id(1), admissionNo: "IP26-000001", patient: { name: "Test Patient 1", uhid: "UH-FAKE-1", ageYears: 52, sex: "male", sealed: false },
  alerts: ["Allergy: none recorded"], bedCode: "F05-MED-B01", wardName: "5A Medicine", boarded: false, state: "admitted", admittedAt: NOW, dayOfStay: 3,
  provisionalDiagnosis: "Community-acquired pneumonia", consultantName: "Dr Fake", coveringName: null, fitWhen: null, vitals: null,
  rounds: [list.cosignQueue[0]!],
  orders: [{
    orderId: id(60), kind: "drug", status: "active", verification: "pending", title: "Ceftriaxone 1 g · 1 g · IV · BD",
    drug: { medicineId: id(61), medicineName: "Ceftriaxone 1 g", doseValue: 1, doseUnit: "g", route: "iv", frequency: "BD", startAt: NOW, stopAt: NOW, durationDays: null, antibiotic: true, prn: null, weightBasedPerKg: false, weightKg: null },
    tests: null, orderedByName: "Dr Fake", orderedAt: NOW, issuedAt: null, endedAt: null, endReason: null, returnOwed: false,
  }],
  consults: [], can: { sign: true, order: true, cosign: true, declareFit: true },
};

beforeEach(() => {
  setToken("stub-token");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: ["ipd.round.sign", "ipd.order.place"], scoped: { department: {}, floor: {} } } }), { status: 200 })));
  api.getRoundsList.mockReset().mockResolvedValue(list);
  api.getRoundPatient.mockReset().mockResolvedValue(patient);
  api.signRound.mockReset().mockResolvedValue({ roundId: id(70), status: "signed", fitDeclaredAt: null });
  api.cosignRound.mockReset().mockResolvedValue({});
  api.stopOrder.mockReset().mockResolvedValue({});
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("Rounds list (E4.2)", () => {
  it("lists patients by need, marks a boarded patient with the ward it lies on, and shows the co-sign queue — no money", async () => {
    renderWithRouter(<IpdRounds />, "/ipd/rounds");
    const rows = await screen.findAllByTestId("ipd-rounds-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Test Patient 1");
    expect(rows[0]).toHaveTextContent("Not seen today");
    expect(rows[1]).toHaveTextContent("On 6A Surgery");
    expect(rows[1]).toHaveTextContent("Unit · Dr Head");
    expect(screen.getByText("Waiting for your co-sign")).toBeInTheDocument();
    expect(screen.getByText(/Draft by Dr Resident/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(MONEY);
  });
});

describe("Round page (E4.2)", () => {
  it("signs a structured round with fit for discharge from the plan bar", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdRoundPatientScreen admissionId={id(1)} />, "/ipd/rounds/x");
    await screen.findByTestId("ipd-round-patient");
    expect(screen.getByText("Allergy: none recorded")).toBeInTheDocument();
    expect(screen.getByTestId("ipd-round-sign")).toBeDisabled();
    await user.type(screen.getByLabelText("Assessment"), "Improving");
    await user.click(screen.getByRole("button", { name: "Today" }));
    await user.click(screen.getByTestId("ipd-round-sign"));
    await waitFor(() => expect(api.signRound).toHaveBeenCalledTimes(1));
    expect(api.signRound.mock.calls[0]![0]).toMatchObject({
      admissionId: id(1), mode: "bedside", soap: { assessment: "Improving" }, fit: { when: "today", disposition: "home" },
    });
    expect(document.body.textContent ?? "").not.toMatch(MONEY);
  });

  it("co-signs a resident's draft and stops an order with a reason", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdRoundPatientScreen admissionId={id(1)} />, "/ipd/rounds/x");
    await screen.findByTestId("ipd-round-patient");
    await user.click(screen.getByRole("button", { name: "Co-sign" }));
    await waitFor(() => expect(api.cosignRound).toHaveBeenCalledWith(id(40)));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.type(screen.getByLabelText("Reason"), "Course complete");
    await user.click(screen.getAllByRole("button", { name: "Stop" })[0]!);
    await waitFor(() => expect(api.stopOrder).toHaveBeenCalledWith(id(60), "Course complete"));
  });

  it("words a refusal by its code", async () => {
    const user = userEvent.setup();
    api.signRound.mockRejectedValueOnce(Object.assign(new Error("API 409"), { status: 409, body: { code: "consultant_cosign_required" } }));
    renderWithRouter(<IpdRoundPatientScreen admissionId={id(1)} />, "/ipd/rounds/x");
    await screen.findByTestId("ipd-round-patient");
    await user.type(screen.getByLabelText("Plan"), "Continue");
    await user.click(screen.getByTestId("ipd-round-sign"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A resident's round needs the consultant's co-sign");
  });
});
