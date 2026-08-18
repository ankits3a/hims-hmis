import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test-utils";
import { RxPrint } from "./rx-print";
import type { WireRxPrint } from "../lib/opd-api";

const ISSUED = "2026-08-18T05:12:00.000Z";

const DATA: WireRxPrint = {
  letterhead: {
    name: "CRK MEDICAL COLLEGE & HOSPITAL",
    addressLines: ["CHAURASIA CHOWK, HAJIPUR", "BIHAR 844101"],
  },
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, restricted: false, ageYears: 34, sex: "female" },
  doctor: { displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentName: "General Medicine" },
  encounter: {
    id: "enc-1", serviceDate: "2026-08-18", diagnosis: "Acute pharyngitis", icd10Code: "J02.9",
    advice: "warm fluids", followUpDays: 7, chiefComplaint: "fever 3d",
  },
  vitals: {
    id: "vit-2", encounterId: "enc-1", patientId: "p-1",
    heightCm: 162, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, rr: null, spo2: 98, tempC: 37,
    notes: null, ageYearsAtRecord: 34, band: "adult", dangerFlags: [],
    recordedBy: "u-2", recordedAt: "2026-08-18T04:40:00.000Z",
  },
  lines: [
    {
      drug: "Tab Paracetamol 500 mg", dose: "1 tab", route: "oral", frequency: "TDS",
      durationDays: 5, instructions: "after food", noSubstitution: false,
    },
    {
      drug: "Syp Cetirizine", dose: "5 ml", route: "oral", frequency: "HS",
      durationDays: null, instructions: null, noSubstitution: true,
    },
  ],
  qrPayload: "rx1.01JABCDEFGHJKMNPQRSTVWXYZ.01JBBCDEFGHJKMNPQRSTVWXYZ.1.Zm9vYmFyYmF6cXV4",
  version: 1,
  issuedAt: ISSUED,
};

describe("RxPrint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the letterhead, prescriber, patient, date, diagnosis with ICD-10, the latest vitals line, one row per drug line, the follow-up line and the QR — and carries NO signature line (K50)", () => {
    const { container } = renderWithProviders(<RxPrint data={DATA} />);

    // letterhead: the hospital name and EVERY address line
    expect(screen.getByText("CRK MEDICAL COLLEGE & HOSPITAL")).toBeInTheDocument();
    expect(screen.getByText("CHAURASIA CHOWK, HAJIPUR")).toBeInTheDocument();
    expect(screen.getByText("BIHAR 844101")).toBeInTheDocument();

    // the prescriber
    expect(screen.getByText("Dr Meera Rao")).toBeInTheDocument();
    expect(screen.getByText("General Medicine")).toBeInTheDocument();
    expect(screen.getByText("Reg. No.: BMC/12345")).toBeInTheDocument();

    // the patient and the service date
    expect(screen.getByTestId("rx-patient-name")).toHaveTextContent("Asha Devi");
    expect(screen.getByText("UHID: HMS0000000020")).toBeInTheDocument();
    expect(screen.getByTestId("rx-patient-age")).toHaveTextContent("Age: 34 · Sex: female");
    expect(screen.getByTestId("rx-date")).toHaveTextContent("Date: 2026-08-18");

    // diagnosis + ICD-10 in parentheses
    expect(screen.getByTestId("rx-diagnosis")).toHaveTextContent("Diagnosis: Acute pharyngitis (J02.9)");

    // the latest vitals line, exactly as the plan specifies it
    expect(screen.getByTestId("rx-vitals")).toHaveTextContent("BP 120/80 · P 72 · SpO₂ 98% · T 37.0 °C · Wt 60 kg");

    // one row per line: drug · dose · frequency · route · N days · instructions
    expect(screen.getByTestId("rx-line-0")).toHaveTextContent(
      "Tab Paracetamol 500 mg · 1 tab · TDS · oral · 5 days · after food",
    );
    expect(screen.getByTestId("rx-line-0")).not.toHaveTextContent("Do not substitute");
    // absent duration and instructions are DROPPED, not rendered as null/blank separators
    expect(screen.getByTestId("rx-line-1")).toHaveTextContent("Syp Cetirizine · 5 ml · HS · oral");
    expect(screen.getByTestId("rx-line-1")).toHaveTextContent("Do not substitute");

    expect(screen.getByText("Advice: warm fluids")).toBeInTheDocument();
    expect(screen.getByTestId("rx-follow-up")).toHaveTextContent("Follow-up in 7 days");

    // the signed QR is rendered as an inline SVG inside the printed document
    expect(container.querySelector(".print-doc svg")).not.toBeNull();

    /**
     * K50 — the ABSENCE assertion. §3.14c: an absence passes trivially against a fixture that never
     * had the element, so this row owns mutant X3 (a copy of this component that adds
     * "Signature: ____"). Both forms below must fail against X3: the query form catches an element
     * whose accessible text says "sign", and the textContent form catches the string anywhere in
     * the rendered document, including inside an element that carries other text too.
     */
    expect(screen.queryAllByText(/sign/i)).toHaveLength(0);
    expect(container.textContent ?? "").not.toMatch(/sign/i);
  });

  it("print isolation: the root carries .print-doc, the print button carries .no-print and calls window.print()", async () => {
    const printSpy = vi.fn();
    vi.stubGlobal("print", printSpy);
    const { container } = renderWithProviders(<RxPrint data={DATA} />);
    const user = userEvent.setup();

    const doc = container.querySelector(".print-doc");
    expect(doc).not.toBeNull();
    // exactly one printable document — two mounted at once would both reach the paper (styles.css)
    expect(container.querySelectorAll(".print-doc")).toHaveLength(1);

    const button = screen.getByRole("button", { name: "Print prescription" });
    expect(button).toHaveClass("no-print");
    // the button is chrome, never part of the document that prints
    expect(doc?.contains(button)).toBe(false);

    await user.click(button);

    expect(printSpy).toHaveBeenCalledTimes(1);
  });
});
