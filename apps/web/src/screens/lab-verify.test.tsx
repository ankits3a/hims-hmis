import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabVerify } from "./lab-verify";

/**
 * PLAN 17b T8 — verify & report.
 *
 * **The refusal path asserted here is `sod_violation`** (DD11): a technologist who keyed a number
 * cannot sign it, and the message says why. The second and more important property is DD6/DD23's:
 * **the print button follows the SERVER's `delivery` verdict and the screen never computes it**,
 * and when it is held the sentence names the money so a clerk can act at the cash window.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const handler = handlers[key];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler() : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const QUEUE = [{
  orderItemId: "i-1", orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001",
  patientId: "p-1", patientDisplay: "Ram Kumar",
  serviceId: "svc-tsh", orderableCode: "TSH", orderableName: "Thyroid stimulating hormone",
  discipline: "biochemistry", priority: "routine", state: "resulted",
  specimenNo: "S2608300001", tatStartedAt: "2026-08-30T06:00:00.000Z",
  analytes: [{
    analyteId: "a-tsh", code: "TSH", nameEn: "TSH", unit: "uIU/mL", resultType: "numeric",
    resultId: "r-1", value: "5.5", flag: "H", refLow: "0.35", refHigh: "4.94", refText: null,
    verificationStatus: "unverified", enteredById: "u-tech", pathologistReviewPending: false,
  }],
}];

const snapshot = {
  orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001", serviceDate: "2026-08-30",
  patient: { id: "p-1", uhid: "HMS-00000101-7", name: "Ram Kumar", sex: "male", dob: "1990-05-10" },
  orderingClinicianId: "u-doc",
  signatory: { userId: "u-path", username: "dr.iyer", signedAt: "2026-08-30T06:05:00.000Z" },
  partial: false, notes: [],
  panels: [{
    orderItemId: "i-1", orderableCode: "TSH", nameEn: "Thyroid stimulating hormone", nameHi: null,
    discipline: "biochemistry", specimenNo: "S2608300001", sensitive: false,
    analytes: [{
      analyteCode: "TSH", nameEn: "TSH", nameHi: null, value: "5.5000", unit: "uIU/mL", flag: "H",
      refLow: "0.3500", refHigh: "4.9400", refText: null, refNote: null, deltaFlag: false,
      verifiedAt: "2026-08-30T06:04:00.000Z", pathologistReviewPending: false,
    }],
  }],
};

/** An order whose every item has finished — the shape the publish queue serves (web C3). */
const PUBLISHABLE = {
  orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001",
  patientId: "p-1", patientDisplay: "Ram Kumar", serviceDate: "2026-08-30",
  complete: true, itemCount: 1, completedCount: 1, orderables: ["TSH"],
};

const heldReport = {
  reportId: "rep-1", orderId: "o-1", version: 1, status: "published", partial: false,
  channels: ["print", "whatsapp", "in_person"], printCount: 0, priorVersionId: null,
  amendmentReasonCode: null, publishedAt: "2026-08-30T06:05:00.000Z", snapshot,
  delivery: { allowed: false, reason: "unpaid_invoices", unpaidInvoiceIds: ["inv-1"], outstandingPaise: 30000 },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("DD11 — a verifier who keyed the number is refused, and the message says why", async () => {
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: QUEUE },
    "GET /api/lab/reports/publishable": { status: 200, body: [] },
    "POST /api/lab/verify/results/r-1": { status: 403, body: {
      statusCode: 403, code: "sod_violation",
      message: "result r-1 was keyed by this same user — a result is signed by a second pair of hands, and holding both permissions is not the same as being two people",
    } },
  });
  renderWithProviders(<LabVerify />);
  await waitFor(() => expect(screen.getByText("L2608300001")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Sign" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(/second pair of hands/));
});

it("DD23 — the print button follows the SERVER's verdict and names the money when it is held", async () => {
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [PUBLISHABLE] },
    "POST /api/lab/reports": { status: 201, body: { reportId: "rep-1", version: 1 } },
    "GET /api/lab/reports/rep-1": { status: 200, body: heldReport },
  });
  renderWithProviders(<LabVerify />);
  /**
   * PUBLISHED FROM THE PUBLISH QUEUE, NOT FROM THE VERIFY WORKLIST (close review, web C3). The two
   * are mutually exclusive: an item leaves the verify worklist at the exact moment it becomes
   * publishable, so the button that used to sit there could never be pressed.
   */
  await waitFor(() => expect(screen.getByText("L2608300001")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Publish report" }));

  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/₹300.00 outstanding/));
  expect(screen.getByRole("alert")).toHaveTextContent(/1 invoice/);
  /** Held: disabled EVEN WITH a collector typed — the money verdict is the server's, not the form's. */
  await userEvent.type(screen.getByLabelText("Collected by"), "the patient");
  expect(screen.getByRole("button", { name: "Print and hand over" })).toBeDisabled();
  /** AND THE A4 IS NOT MOUNTED, so Ctrl+P cannot walk around the register (close review MAJOR). */
  expect(screen.queryByText("HMS-00000101-7")).not.toBeInTheDocument();
  expect(screen.getByText(/report is held/i)).toBeInTheDocument();
});

it("a settled report prints, and the A4 document renders from the snapshot", async () => {
  const settled = {
    ...heldReport,
    delivery: { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 },
  };
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [PUBLISHABLE] },
    "POST /api/lab/reports": { status: 201, body: { reportId: "rep-1", version: 1 } },
    "GET /api/lab/reports/rep-1": { status: 200, body: settled },
    "POST /api/lab/reports/rep-1/print": { status: 201, body: { deliveryId: "d-1", printCount: 1 } },
  });
  renderWithProviders(<LabVerify />);
  await waitFor(() => expect(screen.getByText("L2608300001")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Publish report" }));

  /** The A4 document is mounted — one `.print-doc` on the screen and no other printable surface. */
  await waitFor(() => expect(screen.getByText("HMS-00000101-7")).toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  expect(screen.getByRole("button", { name: "Print and hand over" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Collected by"), "Sunita Kumar (daughter)");
  expect(screen.getByRole("button", { name: "Print and hand over" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Print and hand over" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
