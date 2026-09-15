import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test-utils";
import { LabReportPrint } from "./lab-report-print";
import type { WireReportView } from "../lib/lab-api";

/**
 * PLAN 17b T8 — the A4 report.
 *
 * ═══ WHAT THIS FILE PROVES, AND IT IS TWO THINGS THE SCREEN CANNOT ═══
 *
 *  1. **Every value on the page comes from the SNAPSHOT** (DD13 / E4). The component is handed a
 *     report whose snapshot says "Ram Kumar" and whose ranges say `0.35 – 4.94`, and that is what
 *     prints — a reprint of last year's report is the same document, not today's data in last
 *     year's layout.
 *  2. **A single-operator release prints as PROVISIONAL** (DD11). A report that hid
 *     `pathologist_review_pending` would present a night-mode release as an ordinary one, and the
 *     whole reason that flag is on the row is that somebody reading the paper needs to know.
 */
const REPORT: WireReportView = {
  reportId: "r-1", orderId: "o-1", version: 1, status: "published", partial: false,
  channels: ["print", "whatsapp", "in_person"], printCount: 0,
  priorVersionId: null, amendmentReasonCode: null, publishedAt: "2026-08-30T06:00:00.000Z",
  delivery: { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 },
  snapshot: {
    orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001", serviceDate: "2026-08-30",
    patient: { id: "p-1", uhid: "HMS-00000101-7", name: "Ram Kumar", sex: "male", dob: "1990-05-10" },
    orderingClinicianId: "u-doc",
    signatory: { userId: "u-path", username: "dr.iyer", signedAt: "2026-08-30T06:05:00.000Z" },
    partial: false,
    notes: ["TSH: reference range: unspecified sex"],
    panels: [{
      orderItemId: "i-1", orderableCode: "TSH", nameEn: "Thyroid stimulating hormone",
      nameHi: null, discipline: "biochemistry", specimenNo: "S2608300001", sensitive: false,
      analytes: [{
        analyteCode: "TSH", nameEn: "TSH", nameHi: null, value: "5.5000", unit: "uIU/mL",
        flag: "H", refLow: "0.3500", refHigh: "4.9400", refText: null, refNote: null,
        deltaFlag: true, verifiedAt: "2026-08-30T06:04:00.000Z", pathologistReviewPending: false,
      }],
    }],
  },
};

it("prints the SNAPSHOT's identity, value, unit, flag word and reference interval", () => {
  renderWithProviders(<LabReportPrint report={REPORT} />);

  expect(screen.getByText("Ram Kumar")).toBeInTheDocument();
  expect(screen.getByText("HMS-00000101-7")).toBeInTheDocument();
  expect(screen.getByText("L2608300001")).toBeInTheDocument();

  /** Trailing zeros are trimmed for paper: `5.5000` is clutter, `5.5` is the same number. */
  expect(screen.getByText(/5\.5/)).toBeInTheDocument();
  expect(screen.getByText("uIU/mL")).toBeInTheDocument();
  /** THE FLAG IS A WORD. "H" means nothing at a nursing station at 02:00. */
  expect(screen.getByText("High")).toBeInTheDocument();
  expect(screen.getByText("0.35 – 4.94")).toBeInTheDocument();
  /** 02 H2 — the delta is a MARKER beside the number, which a photocopy keeps and a colour loses. */
  expect(screen.getByLabelText("delta")).toBeInTheDocument();
  /** 02 H4/H5 — the note that says why a range could not be chosen on the usual evidence. */
  expect(screen.getByText(/reference range: unspecified sex/)).toBeInTheDocument();
});

/**
 * ═══ THE HOSPITAL, AND THE PERSON WHO SIGNED — the half of this document nobody had opened ═══
 *
 * `REPORT` above is deliberately left as it was: **no `letterhead`, no `fullName`, no
 * `registrationNo`.** That is not an oversight, it is the OLD-SNAPSHOT case, and the existing
 * assertions below are its contract — a report published before this change is immutable by database
 * trigger, can never be backfilled, and must keep rendering exactly as it was signed.
 *
 * The new fixture is a separate constant so both states are proved, rather than the old one being
 * quietly upgraded and the fallback going untested. `dr.iyer` staying green below is the assertion
 * that a pre-change report is not broken by this change.
 */
const SIGNED: WireReportView = {
  ...REPORT,
  snapshot: {
    ...REPORT.snapshot,
    letterhead: {
      name: "CRK Medical College & Hospital",
      addressLines: ["Rooma, Kanpur 208001", "Uttar Pradesh"],
    },
    signatory: {
      ...REPORT.snapshot.signatory,
      fullName: "Dr Meera Iyer",
      registrationNo: "UPMC-45219",
    },
  },
};

it("prints the HOSPITAL that issued the report — its name and every address line", () => {
  renderWithProviders(<LabReportPrint report={SIGNED} />);

  expect(screen.getByText("CRK Medical College & Hospital")).toBeInTheDocument();
  expect(screen.getByText("Rooma, Kanpur 208001")).toBeInTheDocument();
  expect(screen.getByText("Uttar Pradesh")).toBeInTheDocument();
  /** The department line stays — it is now a subtitle under a hospital rather than the whole
   *  letterhead, which is what it was pretending to be. */
  expect(screen.getByText("Department of Laboratory Medicine")).toBeInTheDocument();
});

it("signs with the practitioner's NAME and council number, never the login", () => {
  renderWithProviders(<LabReportPrint report={SIGNED} />);

  expect(screen.getByText("Dr Meera Iyer")).toBeInTheDocument();
  expect(screen.getByText(/UPMC-45219/)).toBeInTheDocument();
  /**
   * **THE KILL.** The login must be absent from the page, not merely displaced by the name. A
   * username is an authentication artefact and belongs on no medical document.
   */
  expect(screen.queryByText("dr.iyer")).not.toBeInTheDocument();
});

/**
 * ═══ AND A REPORT SIGNED BEFORE ANY OF THIS STILL PRINTS ═══
 *
 * `lab_reports_forbid_published_mutation` freezes a published snapshot, so the fields cannot be
 * backfilled and older reports will carry none of them for ever. The failure mode to design against
 * is not a missing hospital — it is the word `undefined` on a patient's report, or a crash on a
 * reprint of a document somebody is holding a receipt for.
 */
it("an OLD snapshot — no letterhead, no full name — still renders, and never prints `undefined`", () => {
  const { container } = renderWithProviders(<LabReportPrint report={REPORT} />);

  expect(screen.getByText("dr.iyer")).toBeInTheDocument();
  expect(screen.queryByText("CRK Medical College & Hospital")).not.toBeInTheDocument();
  expect(screen.queryByText(/Reg\. No\./)).not.toBeInTheDocument();
  expect(container.textContent).not.toMatch(/undefined|\[object Object\]/);
});

it("names the signatory and says the report is computer generated — with NO signature line", () => {
  renderWithProviders(<LabReportPrint report={REPORT} />);
  expect(screen.getByText("dr.iyer")).toBeInTheDocument();
  expect(screen.getByText(/computer generated/i)).toBeInTheDocument();
  /**
   * `rx-print.tsx`'s rule, applied rather than re-decided: a printed "Signature: ____" invites a
   * hand-signed blank to stand in for the record. There is no such key and no such line.
   */
  expect(screen.queryByText(/Signature:/)).not.toBeInTheDocument();
});

it("DD11 — a night-mode release prints as PROVISIONAL, and an ordinary one does not", () => {
  const { unmount } = renderWithProviders(<LabReportPrint report={REPORT} />);
  expect(screen.queryByText(/Provisional/i)).not.toBeInTheDocument();
  unmount();

  const provisional: WireReportView = {
    ...REPORT,
    snapshot: {
      ...REPORT.snapshot,
      panels: [{
        ...REPORT.snapshot.panels[0]!,
        analytes: [{ ...REPORT.snapshot.panels[0]!.analytes[0]!, pathologistReviewPending: true }],
      }],
    },
  };
  renderWithProviders(<LabReportPrint report={provisional} />);
  expect(screen.getByText(/Provisional/i)).toBeInTheDocument();
});

it("an AMENDED version says so on the face of the page (R-018)", () => {
  renderWithProviders(<LabReportPrint report={{ ...REPORT, version: 2, priorVersionId: "r-0" }} />);
  expect(screen.getByText(/AMENDED/)).toBeInTheDocument();
  expect(screen.getByText(/Version 2/)).toBeInTheDocument();
});
