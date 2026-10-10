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
  patient: { uhid: "HMS0000000020", name: "Asha Devi", alias: null, restricted: false, ageYears: 34, administrativeGender: "female" },
  doctor: { code: "DR-0114", departmentName: "General Medicine" },
  encounter: {
    id: "enc-1", visitNo: "V2608180001", serviceDate: "2026-08-18", diagnosis: "Acute pharyngitis", icd10Code: "J02.9",
    advice: "warm fluids", followUpDays: 7, chiefComplaint: "fever 3d",
    advisedTests: [],
  },
  vitals: {
    id: "vit-2", encounterId: "enc-1", patientId: "p-1",
    heightCm: 162, weightKg: 60, sbp: 120, dbp: 80, pulse: 72, rr: null, spo2: 98, tempC: 37,
    notes: null, ageYearsAtRecord: 34, band: "adult", dangerFlags: [],
    recordedBy: "u-2",
    recordedByName: "Dr Nishant Rao", recordedAt: "2026-08-18T04:40:00.000Z",
    // VD-1 T1 — the reading fields. An adult with no MUAC and one typed take per vital: the
    // ordinary row, which is what a print fixture should be.
    muacCm: null, readings: { bp: { takes: [[120, 80]], source: "typed" } }, contextChips: [],
    carriedForward: [], supersedesVitalsId: null, amendmentReason: null,
    status: "active" as const, emergency: false,
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

    // the prescriber — by Doctor ID only (owner rulings 2026-09-06 and 2026-09-28)
    expect(screen.getByTestId("rx-doctor-id")).toHaveTextContent("Doctor ID DR-0114");
    expect(screen.getByText("General Medicine")).toBeInTheDocument();

    // the patient and the service date
    expect(screen.getByTestId("rx-patient-name")).toHaveTextContent("Asha Devi");
    expect(screen.getByText("UHID: HMS0000000020")).toBeInTheDocument();
    expect(screen.getByTestId("rx-patient-age")).toHaveTextContent("Age: 34 · Sex: female");
    expect(screen.getByTestId("rx-date")).toHaveTextContent("Date: 2026-08-18");
    expect(screen.getByTestId("rx-visit-no")).toHaveTextContent("V2608180001");

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

  it("TELE-CALL (owner 2026-10-09): a tele prescription prints ONE boxed line under the doctor's lines; an in-person sheet prints nothing of the kind", () => {
    const tele = renderWithProviders(<RxPrint data={{ ...DATA, encounter: { ...DATA.encounter, tele: true } }} />);
    const line = screen.getByTestId("rx-tele");
    expect(line).toHaveTextContent("Tele-consultation · patient not examined");
    expect(line.className).toContain("border");
    // under the doctor's lines, above the patient block
    const doctor = screen.getByTestId("rx-doctor-id");
    expect(doctor.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(screen.getByTestId("rx-patient-name")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("rx-tele")).toHaveLength(1);
    tele.unmount();

    for (const encounter of [DATA.encounter, { ...DATA.encounter, tele: false }]) {
      const plain = renderWithProviders(<RxPrint data={{ ...DATA, encounter }} />);
      expect(screen.queryByTestId("rx-tele")).toBeNull();
      expect(plain.container).not.toHaveTextContent(/tele/i);
      plain.unmount();
    }
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

/**
 * PLAN 07d T5 / DD4 — **THE DISCLAIMER IS ON THE PAPER, NOT ONLY ON THE SCREEN.**
 *
 * The slip outlives the consultation and is read by a patient, a relative and a counter clerk, none
 * of whom saw the screen. A printed list of test names that looked like an order would send
 * somebody to a sample-collection desk that does not exist in this hospital's software.
 */
it("07d T5: advised tests print with their price and the as-of date (decision 0065: a free test may be ordered, so the slip no longer says none was)", () => {
  renderWithProviders(<RxPrint data={{
    ...DATA,
    encounter: {
      ...DATA.encounter,
      advisedTests: [
        { serviceId: "svc-usg", code: "USG-ABD", name: "Ultrasound abdomen", pricePaise: 120000 },
      ],
    },
  }} />);

  const block = screen.getByTestId("rx-advised-tests");
  expect(block).toHaveTextContent("Ultrasound abdomen");
  expect(block).toHaveTextContent("₹1,200.00");
  expect(block).not.toHaveTextContent(/no test has been ordered/i);
  // E-9 — the slip names the day it is quoting, because the counter reprices.
  expect(block).toHaveTextContent(DATA.encounter.serviceDate);
});

it("decision 0065: an outside test prints under 'Tests to be done outside', without a price, and not in the hospital list", () => {
  renderWithProviders(<RxPrint data={{
    ...DATA,
    encounter: {
      ...DATA.encounter,
      advisedTests: [
        { serviceId: "svc-usg", code: "USG-ABD", name: "Ultrasound abdomen", pricePaise: 120000 },
        { serviceId: "OUTSVC-ECG", code: "OUT-ECG", name: "ECG (12-lead)", pricePaise: 0 },
      ],
      outsideTestIds: ["OUTSVC-ECG"],
    },
  }} />);
  const outside = screen.getByTestId("rx-outside-tests");
  expect(outside).toHaveTextContent("Tests to be done outside");
  expect(outside).toHaveTextContent("ECG (12-lead)");
  expect(outside).not.toHaveTextContent("₹");
  expect(screen.getByTestId("rx-advised-tests")).not.toHaveTextContent("ECG");
});

it("07d T5: a prescription with no advised tests prints no such block at all", () => {
  renderWithProviders(<RxPrint data={DATA} />);
  expect(screen.queryByTestId("rx-advised-tests")).not.toBeInTheDocument();
});

/**
 * A browser tab open across a deploy can hold a print payload older than this field. An undefined
 * list must read as "none advised" — a prescription that will not render is a patient who leaves
 * without their slip.
 */
it("07d T5: a payload from before this field existed still renders", () => {
  const stale = { ...DATA, encounter: { ...DATA.encounter } } as unknown as Record<string, unknown>;
  delete (stale.encounter as Record<string, unknown>).advisedTests;
  renderWithProviders(<RxPrint data={stale as never} />);
  expect(screen.getByTestId("rx-date")).toBeInTheDocument();
  expect(screen.queryByTestId("rx-advised-tests")).not.toBeInTheDocument();
});

describe("RxPrint — the ophthal line", () => {
  it("names the eye after the route, and a taper prints as its text", () => {
    renderWithProviders(<RxPrint data={{
      ...DATA,
      lines: [{
        drug: "Prednisolone acetate 1% eye drops", dose: "1 drop", route: "eye", eye: "od",
        frequency: "Taper: 6×/day × 7d → 4×/day × 7d", taper: [{ timesPerDay: 6, days: 7 }, { timesPerDay: 4, days: 7 }],
        durationDays: 14, instructions: null, noSubstitution: false,
      }],
    }} />);
    expect(screen.getByTestId("rx-line-0")).toHaveTextContent(
      "Prednisolone acetate 1% eye drops · 1 drop · Taper: 6×/day × 7d → 4×/day × 7d · eye · RIGHT EYE · 14 days",
    );
  });
});

describe("RxPrint — the eye of a diagnosis (board \"Ophthal\")", () => {
  it("an eye-coded diagnosis prints its eye beside its code, each tag with its own", () => {
    renderWithProviders(<RxPrint data={{
      ...DATA,
      encounter: {
        ...DATA.encounter, diagnosis: "Senile nuclear cataract · Essential (primary) hypertension", icd10Code: "H25.1",
        diagnoses: [
          { text: "Senile nuclear cataract", icd10Code: "H25.1", laterality: "od" },
          { text: "Essential (primary) hypertension", icd10Code: "I10", laterality: null },
        ],
      },
    }} />);
    expect(screen.getByTestId("rx-diagnosis")).toHaveTextContent(
      "Diagnosis: Senile nuclear cataract (H25.1, RIGHT EYE) · Essential (primary) hypertension (I10)",
    );
  });

  it("a visit with no eye prints exactly as before", () => {
    renderWithProviders(<RxPrint data={{
      ...DATA, encounter: { ...DATA.encounter, diagnoses: [{ text: "Acute pharyngitis", icd10Code: "J02.9", laterality: null }] },
    }} />);
    expect(screen.getByTestId("rx-diagnosis")).toHaveTextContent("Diagnosis: Acute pharyngitis (J02.9)");
  });

  /*
   * CONSULT WALK 2026-09-28 (defect C) — two diagnoses printed as "Typhoid fever… · Acute URI…
   * (A01.00)": the display string carries every tag and only the PRIMARY code, so J06.9 vanished
   * from the paper. Every coded row prints with its own code, eye or no eye.
   */
  it("C1: two diagnoses without an eye print each with its OWN code — none is dropped", () => {
    renderWithProviders(<RxPrint data={{
      ...DATA,
      encounter: {
        ...DATA.encounter, diagnosis: "Typhoid fever, unspecified · Acute upper respiratory infection, unspecified", icd10Code: "A01.00",
        diagnoses: [
          { text: "Typhoid fever, unspecified", icd10Code: "A01.00", laterality: null },
          { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9", laterality: null },
        ],
      },
    }} />);
    expect(screen.getByTestId("rx-diagnosis")).toHaveTextContent(
      "Diagnosis: Typhoid fever, unspecified (A01.00) · Acute upper respiratory infection, unspecified (J06.9)",
    );
  });

  it("C2: an uncoded tag beside a coded one prints bare, and the coded one keeps its code", () => {
    renderWithProviders(<RxPrint data={{
      ...DATA,
      encounter: {
        ...DATA.encounter, diagnosis: "Viral fever · Acute upper respiratory infection, unspecified", icd10Code: "J06.9",
        diagnoses: [
          { text: "Viral fever", icd10Code: null, laterality: null },
          { text: "Acute upper respiratory infection, unspecified", icd10Code: "J06.9", laterality: null },
        ],
      },
    }} />);
    expect(screen.getByTestId("rx-diagnosis")).toHaveTextContent(
      "Diagnosis: Viral fever · Acute upper respiratory infection, unspecified (J06.9)",
    );
  });
});

/*
 * DEFECT H — OWNER RULINGS 2026-09-06 ("As a medical Institution with college, there's no need of
 * mentioning Dr. Name and their registration number. Only Dr. ID is required.") and 2026-09-28
 * ("Prescription print: Doctor ID only"). The e-Rx printed the doctor's name and "Reg. No.". The
 * fixture below is the payload as the server sent it BEFORE the ruling — name and council number
 * included — so the absence is asserted against a payload that HAS them, not one that never did.
 */
describe("RxPrint — the prescriber is the Doctor ID only (H)", () => {
  it("H1: prints 'Doctor ID <code>' and neither the doctor's name nor the registration number, even when the payload carries them", () => {
    const legacy = { ...DATA, doctor: { code: "DR-0114", displayName: "Dr Meera Rao", registrationNo: "BMC/12345", departmentName: "General Medicine" } } as unknown as WireRxPrint;
    const { container } = renderWithProviders(<RxPrint data={legacy} />);
    const doc = container.querySelector(".print-doc")!.textContent ?? "";
    expect(doc).toContain("Doctor ID DR-0114");
    expect(doc).not.toContain("Meera");
    expect(doc).not.toContain("BMC/12345");
    expect(doc).not.toMatch(/Reg\. ?No/i);
  });
});


/* ═══ OWNER 2026-10-04 — Unit Number and Dept. Regn; never a doctor's name, never "Guest Faculty" ═══ */
it("2026-10-04: a unit doctor's e-Rx prints the department, Unit Number = the unit and the head's Dept. Regn — no name, no Doctor ID", () => {
  renderWithProviders(<RxPrint data={{ ...DATA, doctor: { unitNumber: "Unit I", deptRegn: "BR-HEAD-77", departmentName: "General Medicine" } }} />);
  expect(screen.getByTestId("rx-department")).toHaveTextContent("General Medicine");
  expect(screen.getByTestId("rx-unit-number")).toHaveTextContent("Unit Number: Unit I");
  expect(screen.getByTestId("rx-dept-regn")).toHaveTextContent("Dept. Regn: BR-HEAD-77");
  expect(screen.queryByTestId("rx-doctor-id")).toBeNull();
  expect(document.body).not.toHaveTextContent("DR-0114");
});

it("2026-10-04: Guest Faculty prints the Doctor ID as the Unit Number and a blank Dept. Regn when none — never 'Guest Faculty'", () => {
  renderWithProviders(<RxPrint data={{ ...DATA, doctor: { unitNumber: "DR-0001", deptRegn: null, departmentName: "Paediatrics" } }} />);
  expect(screen.getByTestId("rx-unit-number")).toHaveTextContent("Unit Number: DR-0001");
  expect(screen.getByTestId("rx-dept-regn").textContent).toBe("Dept. Regn: ");
  expect(document.body).not.toHaveTextContent("Guest Faculty");
});

/**
 * Owner ruling 2026-10-06 — a prescription the desk TYPED from the doctor's paper must not pass for
 * one the doctor keyed. The print names the desk that typed it and says the signed paper is the
 * original; a prescription the doctor issued on the screen carries no such line.
 */
describe("RxPrint — a transcription says it is one", () => {
  it("typed from paper: the sheet says who typed it and that the signed paper is the original", () => {
    renderWithProviders(<RxPrint data={{ ...DATA, transcribedByName: "Priya Kumari" }} />);
    const note = screen.getByTestId("rx-transcribed");
    expect(note).toHaveTextContent("Typed from the doctor's paper prescription by Priya Kumari.");
    expect(note).toHaveTextContent("The paper the doctor signed is the original");
    /* It is INSIDE the printed document, not a screen-only hint. */
    expect(note.closest(".print-doc")).not.toBeNull();
  });
  it("keyed by the doctor (or an older server that says nothing): no such line", () => {
    renderWithProviders(<RxPrint data={DATA} />);
    expect(screen.queryByTestId("rx-transcribed")).not.toBeInTheDocument();
    renderWithProviders(<RxPrint data={{ ...DATA, transcribedByName: null }} />);
    expect(screen.queryByTestId("rx-transcribed")).not.toBeInTheDocument();
  });
});

/* Owner 2026-10-08 — a finger-prick glucose taken at the bay prints with WHEN it was taken, and never with a verdict. */
it("prints the glucose and its timing at the end of the vitals line, and nothing when none was taken", () => {
  renderWithProviders(<RxPrint data={{ ...DATA, vitals: { ...DATA.vitals!, glucoseMgDl: 186, glucoseTiming: "after_food" } }} />);
  expect(screen.getByTestId("rx-vitals")).toHaveTextContent("BP 120/80 · P 72 · SpO₂ 98% · T 37.0 °C · Wt 60 kg · Glucose 186 mg/dL (after food)");
  expect(screen.getByTestId("rx-vitals")).not.toHaveTextContent(/high|low|normal/i);
});
