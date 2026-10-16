import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabReportPrint } from "../components/lab-report-print";
import { LabBench } from "./lab-bench";
import { LabVerify } from "./lab-verify";
import type { WireReportView, WireWorklistRow } from "../lib/lab-api";

/**
 * #703 — Full lab mode's culture report: the bench enters the antibiotic sensitivity table on the MIC_AST line (the
 * quick chain's editor), the verify screen shows it before the signature, and the signed report prints it.
 */
type Seen = { method: string; path: string; body: unknown }[];
function mockRoutes(handlers: Record<string, { status: number; body: unknown }>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    seen.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    const h = handlers[`${method} ${path}`];
    if (h === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(h.body), { status: h.status, headers: { "Content-Type": "application/json" } });
  }));
  return seen;
}

type Analyte = WireWorklistRow["analytes"][number];
const analyte = (code: string, over: Partial<Analyte> = {}): Analyte => ({
  analyteId: `a-${code}`, code, nameEn: code, unit: null, resultType: "text", resultId: null, value: null, flag: null,
  refLow: null, refHigh: null, refText: null, verificationStatus: null, enteredById: null, pathologistReviewPending: false,
  previous: null, rerunChoice: [], ast: null, ...over,
});
const culture = (analytes: Analyte[], state = "in_analysis"): WireWorklistRow => ({
  orderItemId: "i-cs", orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001", patientId: "p-1", patientDisplay: "Ram Kumar",
  serviceId: "svc-cs", orderableCode: "CS_URINE", orderableName: "Urine culture and sensitivity", discipline: "microbiology",
  priority: "routine", state, specimenNo: "S2608300001", tatStartedAt: "2026-08-30T06:00:00.000Z", tatTargetMinutes: 4320, analytes,
});
const TABLE = [{ antibiotic: "AMP", result: "R" as const, mic: "32" }, { antibiotic: "MEM", result: "S" as const, mic: null }];

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("the bench enters the table on a culture's MIC_AST line and posts its rows", async () => {
  const seen = mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: [culture([analyte("MIC_ORG", { resultId: "r-org", value: "E. coli" }), analyte("MIC_AST")])] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/results": { status: 201, body: { resultId: "r-ast", flag: null, deltaFlagged: false, criticalCallId: null } },
  });
  renderWithProviders(<LabBench />);
  const table = await screen.findByTestId("ast-CS_URINE");
  expect(screen.queryByLabelText("CS_URINE MIC_AST")).toBeNull();
  await userEvent.type(within(table).getByLabelText("Add antibiotic"), "Ampicillin{enter}");
  await userEvent.click(within(table).getByRole("button", { name: "Ampicillin Resistant" }));
  await userEvent.click(screen.getByRole("button", { name: "Save table" }));
  await waitFor(() => expect(seen.filter((s) => s.path === "/api/lab/bench/results")).toHaveLength(1));
  expect(seen.find((s) => s.path === "/api/lab/bench/results")!.body).toEqual({
    orderItemId: "i-cs", analyteId: "a-MIC_AST", value: "Resistant: Ampicillin", entryMode: "manual",
    ast: [{ antibiotic: "AMP", result: "R", mic: null }],
  });
});

it("the verify screen shows the entered table under its line before the signature", async () => {
  mockRoutes({
    "GET /api/lab/verify/worklist": { status: 200, body: [culture([
      analyte("MIC_AST", { resultId: "r-ast", value: "Resistant: Ampicillin · Sensitive: Meropenem", verificationStatus: "unverified", ast: TABLE }),
    ], "resulted")] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/reports/publishable": { status: 200, body: [] },
  });
  renderWithProviders(<LabVerify />);
  await userEvent.click(await screen.findByRole("button", { name: /Ram Kumar/ }));
  const preview = await screen.findByTestId("ast-preview-svc-cs");
  expect(preview).toHaveTextContent("Ampicillin");
  expect(preview).toHaveTextContent("Resistant");
  expect(preview).toHaveTextContent("Meropenem");
});

it("the signed report prints the table under the MIC_AST line", () => {
  const report: WireReportView = {
    reportId: "r-1", orderId: "o-1", version: 1, status: "published", partial: false, channels: ["print"], printCount: 0,
    priorVersionId: null, amendmentReasonCode: null, publishedAt: "2026-08-30T06:00:00.000Z",
    delivery: { allowed: true, reason: "settled", unpaidInvoiceIds: [], outstandingPaise: 0 },
    snapshot: {
      orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001", serviceDate: "2026-08-30",
      patient: { id: "p-1", uhid: "HMS-00000101-7", name: "Ram Kumar", sex: "male", dob: "1990-05-10" },
      orderingClinicianId: "u-doc", signatory: { userId: "u-path", username: "dr.iyer", signedAt: "2026-08-30T06:05:00.000Z" },
      partial: false, notes: [],
      panels: [{
        orderItemId: "i-cs", orderableCode: "CS_URINE", nameEn: "Urine culture and sensitivity", nameHi: null, discipline: "microbiology",
        specimenNo: "S2608300001", sensitive: false,
        analytes: [{
          analyteCode: "MIC_AST", nameEn: "Antibiotic sensitivity summary", nameHi: null, value: "Resistant: Ampicillin · Sensitive: Meropenem",
          unit: null, flag: null, refLow: null, refHigh: null, refText: null, refNote: null, deltaFlag: false,
          verifiedAt: "2026-08-30T06:04:00.000Z", pathologistReviewPending: false, ast: TABLE,
        }],
      }],
    },
  };
  renderWithProviders(<LabReportPrint report={report} />);
  const printed = screen.getByTestId("report-ast-i-cs");
  expect(within(printed).getByText("Ampicillin")).toBeInTheDocument();
  expect(within(printed).getByText("Resistant")).toBeInTheDocument();
  expect(within(printed).getByText("32")).toBeInTheDocument();
  expect(within(printed).getByText("Meropenem")).toBeInTheDocument();
});
