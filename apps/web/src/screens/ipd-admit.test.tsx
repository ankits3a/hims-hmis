import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IpdAdmit } from "./ipd-admit";
import type { IpdAdmissionView, IpdBedProposal, IpdClassQuote } from "@hmis/contracts";

/*
  E1.2 (#719) — the Admit sheet. Every value is synthetic: ids are `01FAKE…`, names invented, amounts made up; the
  shapes are the contract's (`packages/contracts/src/ipd/admissions.ts`).
*/

const api = vi.hoisted(() => ({
  listAdmissions: vi.fn(), getAdmission: vi.fn(), getQuotes: vi.fn(), getBedProposals: vi.fn(), planAdmission: vi.fn(),
  takeDeposit: vi.fn(), admitPatient: vi.fn(), printBand: vi.fn(), askApproval: vi.fn(), reserveBed: vi.fn(),
}));
vi.mock("../lib/ipd-admit-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-admit-api")>();
  return { ...real, ...api };
});
vi.mock("../lib/ipd-beds-api", async (orig) => {
  const real = await orig<typeof import("../lib/ipd-beds-api")>();
  return { ...real, reserveBed: api.reserveBed };
});

const id = (n: number): string => `01FAKE${String(n).padStart(20, "0")}`;
const ADM = id(3);
const BED = id(4);

function view(over: Partial<IpdAdmissionView> = {}): IpdAdmissionView {
  return {
    id: ADM, admissionNo: null, state: "requested", source: "opd_advice",
    patient: { id: id(1), uhid: "HMS-000123", name: "Ramesh Kumar", initials: "R.K.", ageSex: "M 61", allergies: ["Allergy: Penicillin (severe)"] },
    consultant: { id: "user-fake-01", name: "Dr. Synthetic Verma" }, department: "MED", provisionalDiagnosis: "Synthetic angina",
    mlc: false, requestedClass: "general", isolation: "none", icu: false, requestedAt: "2030-01-01T05:20:00.000Z",
    plannedFor: null, expiresAt: "2030-01-02T05:20:00.000Z", payerKind: null, coverageId: null, estimatePaise: null,
    depositRequiredPaise: null, depositBasis: null, depositPaidPaise: 0, depositCheckPending: false, deposits: [], consent: null, reservation: null, bed: null,
    band: null, icuApproval: null, admittedAt: null, stabilisedAt: null, downtimeSerial: null, incomplete: [], ...over,
  };
}
const QUOTES: IpdClassQuote[] = [
  { class: "general", label: "General ward", perDay: { room: 150_000, nursing: 50_000, visit: 80_000 }, missing: [], estimatePaise: 840_000, depositPaise: 840_000, depositBasis: "medical_class_days", freeBeds: 4 },
  { class: "private", label: "Private room", perDay: null, missing: ["room", "nursing", "visit"], estimatePaise: null, depositPaise: null, depositBasis: "medical_class_days", freeBeds: 2 },
];
const BEDS: IpdBedProposal[] = [
  { bedId: BED, code: "F05-MED-M-B07", wardName: "Medicine male", class: "general", reasons: ["Male bay", "Oxygen point"] },
];
const BAND = {
  name: "Ramesh Kumar", uhid: "HMS-000123", ageSex: "61M", dob: null, admissionNo: "IP30-000001", admittedOn: "01 Jan 2030",
  bedCode: "F05-MED-M-B07", consultant: "Dr. Synthetic Verma", allergyWords: ["Allergy: Penicillin (severe)"], alertWords: [],
  motherName: null, size: "adult" as const, site: "wrist" as const, barcode: "IP30-000001-1", qr: "IPDBAND1|IP30-000001-1|HMS-000123",
};

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.listAdmissions.mockResolvedValue([view()]);
  api.getAdmission.mockResolvedValue(view());
  api.getQuotes.mockResolvedValue(QUOTES);
  api.getBedProposals.mockResolvedValue(BEDS);
});

describe("Admit — one flowing sheet (E1.2)", () => {
  it("shows the identity header with the allergy in words, the class cards from the tariff and the top beds with reasons", async () => {
    renderWithRouter(<IpdAdmit />, `/ipd/admit?admission=${ADM}`);
    const patient = await screen.findByRole("region", { name: "Patient" });
    expect(within(patient).getByText("Allergy: Penicillin (severe)")).toBeInTheDocument();
    expect(within(patient).getByText("HMS-000123")).toBeInTheDocument();
    const classes = await screen.findByRole("radiogroup", { name: "Room class" });
    expect(within(classes).getAllByText("₹8,400")).toHaveLength(2); // 3-day estimate and deposit, side by side
    // A class with no rate never shows a guessed number: it names what is missing and the fix.
    expect(within(classes).getByText(/Rate not set \(room, nursing, visit\) · Ask billing to set the rate/)).toBeInTheDocument();
    expect(await screen.findByText("Male bay · Oxygen point")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Admit and print band" })).toBeDisabled();
  });

  it("E2.2: a class over the insurer's room-rent cap carries the warning in words on its card", async () => {
    api.getQuotes.mockResolvedValue([
      QUOTES[0]!,
      { ...QUOTES[1]!, perDay: { room: 400_000, nursing: 90_000, visit: 120_000 }, missing: [], estimatePaise: 1_830_000, depositPaise: 500_000,
        capWarning: { targetClass: "private", capPerDayPaise: 200_000, rentPerDayPaise: 400_000, overPerDayPaise: 200_000, payerShareBp: 5_000,
          words: "Over cap by ₹2,000/day; insurer pays 50 % of nursing, RMO, visits" } },
    ]);
    renderWithRouter(<IpdAdmit />, `/ipd/admit?admission=${ADM}`);
    const classes = await screen.findByRole("radiogroup", { name: "Room class" });
    expect(await within(classes).findByText("Over cap by ₹2,000/day; insurer pays 50 % of nursing, RMO, visits")).toBeInTheDocument();
  });

  it("walks payer → bed → consent → deposit → admit, then prints the band with the allergy written on it", async () => {
    const user = userEvent.setup();
    renderWithRouter(<IpdAdmit />, `/ipd/admit?admission=${ADM}`);
    const classes = await screen.findByRole("radiogroup", { name: "Room class" });
    api.planAdmission.mockResolvedValue({ depositRequiredPaise: 840_000, estimatePaise: 840_000, depositBasis: "medical_class_days" });
    api.getAdmission.mockResolvedValue(view({ payerKind: "cash", depositRequiredPaise: 840_000, estimatePaise: 840_000, depositBasis: "medical_class_days" }));
    await user.click(within(classes).getByRole("radio", { name: /General ward/ }));
    expect(api.planAdmission).toHaveBeenCalledWith({ admissionId: ADM, payerKind: "cash", requestedClass: "general", plan: { kind: "medical" } });

    api.reserveBed.mockResolvedValue({});
    await user.click(await screen.findByRole("button", { name: /F05-MED-M-B07/ }));
    expect(api.reserveBed).toHaveBeenCalledWith(expect.objectContaining({ admissionId: ADM, bedId: BED, patientId: id(1) }));

    await user.click(screen.getByLabelText("Paper consent signed"));
    await user.type(screen.getByLabelText("Witness"), "Desk Witness");

    api.takeDeposit.mockResolvedValue({ receiptId: id(9), receiptNo: "RCP-0001", amountPaise: 840_000, depositTotalPaise: 840_000 });
    await user.type(screen.getByLabelText("Reference"), "UPI-SYN-1");
    const admitted = view({
      payerKind: "cash", depositRequiredPaise: 840_000, depositBasis: "medical_class_days", depositPaidPaise: 840_000,
      deposits: [{ receiptId: id(9), receiptNo: "RCP-0001", amountPaise: 840_000, takenAt: "2030-01-01T05:25:00.000Z" }],
      reservation: { id: id(5), bedId: BED, bedCode: "F05-MED-M-B07", expiresAt: "2030-01-01T07:25:00.000Z" },
    });
    api.getAdmission.mockResolvedValue(admitted);
    await user.click(screen.getByRole("button", { name: /Take ₹8,400/ }));
    expect(api.takeDeposit).toHaveBeenCalledWith(expect.objectContaining({ admissionId: ADM, amountPaise: 840_000, tender: "upi", tenderRef: "UPI-SYN-1" }));

    api.admitPatient.mockResolvedValue({ admissionId: ADM, bedId: BED, admittedAt: "2030-01-01T05:26:00.000Z" });
    api.printBand.mockResolvedValue({ bandId: id(10), bandSerial: BAND.barcode, printedAt: "2030-01-01T05:26:00.000Z", band: BAND });
    const admit = screen.getByRole("button", { name: "Admit and print band" });
    await waitFor(() => expect(admit).toBeEnabled());
    api.getAdmission.mockResolvedValue({ ...admitted, state: "admitted", admissionNo: "IP30-000001", admittedAt: "2030-01-01T05:26:00.000Z",
      bed: { id: BED, code: "F05-MED-M-B07", wardName: "Medicine male" }, band: { id: id(10), serial: BAND.barcode, printedAt: "2030-01-01T05:26:00.000Z" } });
    await user.click(admit);
    expect(api.admitPatient).toHaveBeenCalledWith({
      admissionId: ADM, bedId: BED, deposit: { receiptId: id(9) },
      consent: { signedBy: "patient", method: "paper", witnessName: "Desk Witness", language: "hi" },
    });
    expect(api.printBand).toHaveBeenCalledWith(ADM, "adult", "wrist");
    const bands = await screen.findAllByTestId("ipd-band");
    expect(bands[0]).toHaveTextContent("Allergy: Penicillin (severe)");
    expect(await screen.findByText("Band printed · allergy written on the band")).toBeInTheDocument();
  });

  it("a refusal names the rule and the fix — no dead end", async () => {
    const user = userEvent.setup();
    api.planAdmission.mockRejectedValue(new ApiError(409, {
      statusCode: 409, code: "rate_missing", message: "x", rule: "A rate this estimate needs is not set on the active tariff.", fix: "Ask billing to set the rate",
    }));
    renderWithRouter(<IpdAdmit />, `/ipd/admit?admission=${ADM}`);
    const classes = await screen.findByRole("radiogroup", { name: "Room class" });
    await user.click(within(classes).getByRole("radio", { name: /Private room/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A rate this estimate needs is not set on the active tariff.");
    expect(alert).toHaveTextContent("Fix: Ask billing to set the rate");
  });

  it("ICU: the sheet asks for the intensivist's approval and will not admit without it", async () => {
    const user = userEvent.setup();
    api.getAdmission.mockResolvedValue(view({ requestedClass: "icu", icu: true }));
    api.askApproval.mockResolvedValue({ approvalId: id(11) });
    renderWithRouter(<IpdAdmit />, `/ipd/admit?admission=${ADM}`);
    expect(await screen.findByText("ICU needs an intensivist's approval")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Request approval" }));
    expect(api.askApproval).toHaveBeenCalledWith(ADM, "icu", expect.any(String));
    expect(screen.getByRole("button", { name: "Admit and print band" })).toBeDisabled();
  });
});
