import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { deltaText, LabVerify, orderQueue } from "./lab-verify";
import type { WireCriticalCall, WireWorklistRow } from "../lib/lab-api";

/**
 * PLAN 17c T4 — the pathologist's seat. Carried from 17b: SoD refusal shown verbatim; the print
 * button follows the server's verdict; a settled report renders. Added: the queue order is a pure
 * function; the previous value and its delta are on the row; Sign N is N signatures.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply | (() => Reply)>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    seen.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler() : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
  return seen;
}

const analyte = (code: string, over: Partial<WireWorklistRow["analytes"][number]> = {}): WireWorklistRow["analytes"][number] => ({
  analyteId: `a-${code}`, code, nameEn: code, unit: "mg/dL", resultType: "numeric", resultId: `r-${code}`, value: "1",
  flag: "N", refLow: "0", refHigh: "10", refText: null, verificationStatus: "unverified", enteredById: "u-tech",
  pathologistReviewPending: false, previous: null, ...over,
});
const row = (over: Partial<WireWorklistRow>): WireWorklistRow => ({
  orderItemId: "i-1", orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001",
  patientId: "p-1", patientDisplay: "Ram Kumar",
  serviceId: "svc-tsh", orderableCode: "TSH", orderableName: "Thyroid stimulating hormone",
  discipline: "biochemistry", priority: "routine", state: "resulted",
  specimenNo: "S2608300001", tatStartedAt: "2026-08-30T06:00:00.000Z", tatTargetMinutes: 240,
  analytes: [analyte("TSH", { unit: "uIU/mL", value: "5.5", flag: "H", refLow: "0.35", refHigh: "4.94" })],
  ...over,
});
const QUEUE = [row({})];

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
const PUBLISHABLE = {
  orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001",
  patientId: "p-1", patientDisplay: "Ram Kumar", serviceDate: "2026-08-30",
  complete: true, itemCount: 1, completedCount: 1, orderables: ["TSH"], amendsReportId: null,
};
const heldReport = {
  reportId: "rep-1", orderId: "o-1", version: 1, status: "published", partial: false,
  channels: ["print", "whatsapp", "in_person"], printCount: 0, priorVersionId: null,
  amendmentReasonCode: null, publishedAt: "2026-08-30T06:05:00.000Z", snapshot,
  delivery: { allowed: false, reason: "unpaid_invoices", unpaidInvoiceIds: ["inv-1"], outstandingPaise: 30000 },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

/**
 * ═══ DD11 §7 — THE MORNING QUEUE, WHICH HAD NO SCREEN AT ALL ═══
 *
 * The runbook's own words: *"Those rows are the morning queue. Somebody must work it, and this build
 * ships no screen filter for it — read `lab_results` where `pathologist_review_pending` is true."*
 * A morning round at Apollo, Fortis, Medanta or Yashoda does not begin with a DBA running psql.
 */
it("DD11 — a night release is listed with WHO released it alone, and the review clears it", async () => {
  const seen = mockRoutes({
    "GET /api/lab/verify/night-releases": { status: 200, body: [{
      resultId: "r-night", orderItemId: "i-1", orderNo: "L2609010111",
      patientId: "p-1", patientDisplay: "Sunita Devi",
      analyteCode: "TSH", analyteName: "TSH", value: "9.9", unit: "uIU/mL", flag: "H",
      releasedBy: "dr.night", releasedAt: "2026-08-30T20:04:00.000Z",
    }] },
    "POST /api/lab/verify/night-releases/r-night/review": { status: 201, body: { resultId: "r-night" } },
  });
  renderWithProviders(<LabVerify />);

  await waitFor(() => expect(screen.getByTestId("night-r-night")).toBeInTheDocument());
  const row = screen.getByTestId("night-r-night");
  expect(row).toHaveTextContent("Sunita Devi");
  expect(row).toHaveTextContent("TSH 9.9 uIU/mL");
  /** WHO released it alone is the fact the review is ABOUT, so it is on the row, not behind a click. */
  expect(row).toHaveTextContent(/released by dr\.night/);

  await userEvent.click(within(row).getByRole("button", { name: "Reviewed" }));
  await waitFor(() => expect(
    seen.some((r) => r.method === "POST" && r.path.includes("/night-releases/r-night/review")),
  ).toBe(true));
});

/**
 * A heading over an empty list on every day shift is how a reviewer learns to skip the section on
 * the morning it is NOT empty. The queue appears only when it has something in it.
 */
it("DD11 — with nothing released overnight the section is absent, not an empty heading", async () => {
  mockRoutes({ "GET /api/lab/verify/night-releases": { status: 200, body: [] } });
  renderWithProviders(<LabVerify />);

  await waitFor(() => expect(screen.getByText(/Verify/i)).toBeInTheDocument());
  expect(screen.queryByText(/awaiting the second pair of hands/i)).not.toBeInTheDocument();
});

it("orderQueue — a critical or an open call first, then STAT, then the oldest clock", () => {
  const now = new Date("2026-08-30T10:00:00Z").getTime();
  const routineOld = row({ orderItemId: "i-a", orderId: "o-a", orderNo: "L-a", tatStartedAt: "2026-08-30T06:00:00.000Z" });
  const statNew = row({ orderItemId: "i-b", orderId: "o-b", orderNo: "L-b", priority: "stat", tatStartedAt: "2026-08-30T09:50:00.000Z" });
  const critical = row({ orderItemId: "i-c", orderId: "o-c", orderNo: "L-c", tatStartedAt: "2026-08-30T09:55:00.000Z",
    analytes: [analyte("K", { value: "6.4", flag: "HH" })] });
  const withCall = row({ orderItemId: "i-d", orderId: "o-d", orderNo: "L-d", tatStartedAt: "2026-08-30T09:58:00.000Z" });
  const calls = [{ orderNo: "L-d" } as WireCriticalCall];
  const out = orderQueue([routineOld, statNew, critical, withCall], calls, now);
  expect(out.map((r) => r.orderNo)).toEqual(["L-c", "L-d", "L-b", "L-a"]);
  expect(out[3]!.ageMinutes).toBe(240);
});

it("deltaText — arithmetic on two numbers the server chose, signed, or nothing", () => {
  expect(deltaText("41", "96")).toBe("−55");
  expect(deltaText("11.2", "11.8")).toBe("−0.6");
  expect(deltaText("62", "41")).toBe("+21");
  expect(deltaText("Reactive", "Non-reactive")).toBeNull();
  expect(deltaText("5", null)).toBeNull();
});

it("D11 — the previous value and its delta sit beside the result; Sign N posts N signatures in order", async () => {
  const gluf = row({
    orderItemId: "i-g", orderId: "o-g", orderNo: "L2609010102", orderableCode: "GLUF", orderableName: "Glucose, fasting",
    patientDisplay: "Farida Khatoon",
    analytes: [analyte("GLUF", { value: "41", flag: "LL", previous: { resultId: "r-old", value: "96", flag: "N", at: "2026-08-24T05:00:00.000Z" } })],
  });
  const lft = row({
    orderItemId: "i-l", orderId: "o-g", orderNo: "L2609010102", orderableCode: "LFT", orderableName: "Liver function test",
    patientDisplay: "Farida Khatoon",
    analytes: [
      analyte("AST", { value: "48", flag: "H", previous: { resultId: "r-a", value: "39", flag: "N", at: "2026-08-24T05:00:00.000Z" } }),
      analyte("TBIL", { value: "1.1", flag: "N", verificationStatus: "verified" }),
    ],
  });
  const seen = mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: [gluf, lft] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [] },
    "POST /api/lab/verify/results/r-GLUF": { status: 201, body: {} },
    "POST /api/lab/verify/results/r-AST": { status: 201, body: {} },
  });
  renderWithProviders(<LabVerify />);
  await waitFor(() => expect(screen.getByText("Farida Khatoon")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Farida Khatoon/ }));
  const glufRow = screen.getByTestId("row-GLUF");
  expect(glufRow).toHaveTextContent("41");
  expect(glufRow).toHaveTextContent("96");
  expect(glufRow).toHaveTextContent("Δ −55");
  const tbil = screen.getByTestId("row-TBIL");
  expect(tbil).toHaveTextContent("signed");
  expect(within(tbil).queryByRole("button", { name: "Sign" })).toBeNull();
  /** Two unsigned, one already signed: the button says two, and posts exactly two, in order. */
  const signAll = screen.getByRole("button", { name: "Sign 2 results" });
  await userEvent.click(signAll);
  await waitFor(() => expect(seen.filter((s) => s.path.startsWith("/api/lab/verify/results/"))).toHaveLength(2));
  expect(seen.filter((s) => s.path.startsWith("/api/lab/verify/results/")).map((s) => s.path))
    .toEqual(["/api/lab/verify/results/r-GLUF", "/api/lab/verify/results/r-AST"]);
});

it("DD11 — a verifier who keyed the number is refused, and the message says why", async () => {
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: QUEUE },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [] },
    "POST /api/lab/verify/results/r-TSH": { status: 403, body: {
      statusCode: 403, code: "sod_violation",
      message: "result r-1 was keyed by this same user — a result is signed by a second pair of hands, and holding both permissions is not the same as being two people",
    } },
  });
  renderWithProviders(<LabVerify />);
  await waitFor(() => expect(screen.getByText("Ram Kumar")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /Ram Kumar/ }));
  await userEvent.click(screen.getByRole("button", { name: "Sign" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/second pair of hands/));
});

it("DD23 — the print button follows the SERVER's verdict and names the money when it is held", async () => {
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [PUBLISHABLE] },
    "POST /api/lab/reports": { status: 201, body: { reportId: "rep-1", version: 1 } },
    "GET /api/lab/reports/rep-1": { status: 200, body: heldReport },
  });
  renderWithProviders(<LabVerify />);
  await waitFor(() => expect(screen.getByText("L2608300001")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Publish report" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/₹300.00 outstanding/));
  expect(screen.getByRole("alert")).toHaveTextContent(/1 invoice/);
  await userEvent.type(screen.getByLabelText("Collected by"), "the patient");
  expect(screen.getByRole("button", { name: "Print and hand over" })).toBeDisabled();
  expect(screen.queryByText("HMS-00000101-7")).not.toBeInTheDocument();
  expect(screen.getByText(/report is held/i)).toBeInTheDocument();
});

it("a settled report prints, and the A4 document renders from the snapshot", async () => {
  const settled = { ...heldReport, delivery: { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 } };
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [PUBLISHABLE] },
    "POST /api/lab/reports": { status: 201, body: { reportId: "rep-1", version: 1 } },
    "GET /api/lab/reports/rep-1": { status: 200, body: settled },
    "POST /api/lab/reports/rep-1/print": { status: 201, body: { deliveryId: "d-1", printCount: 1 } },
  });
  renderWithProviders(<LabVerify />);
  await waitFor(() => expect(screen.getByText("L2608300001")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Publish report" }));
  await waitFor(() => expect(screen.getByText("HMS-00000101-7")).toBeInTheDocument());
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Print and hand over" })).toBeDisabled();
  await userEvent.type(screen.getByLabelText("Collected by"), "Sunita Kumar (daughter)");
  expect(screen.getByRole("button", { name: "Print and hand over" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Print and hand over" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
});
