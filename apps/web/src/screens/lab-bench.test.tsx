import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabBench, resolveScan } from "./lab-bench";
import type { WireBenchArrival, WireWorklistRow } from "../lib/lab-api";

/**
 * PLAN 17c T3 — the bench. Carried from 17b: the absurd override asks for a PERSON; a critical
 * says so at entry; the call panel says a read-back closes it. Added: the scan resolves in two
 * lists and never guesses; a tube drawn without a wristband scan cannot be received until somebody
 * is named; Save & complete is N records, not one.
 */
type Reply = { status: number; body: unknown };
type Seen = { method: string; path: string; body: unknown }[];

function mockRoutes(handlers: Record<string, Reply | ((body: unknown) => Reply)>): Seen {
  const seen: Seen = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = raw.split("?")[0]!;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    seen.push({ method, path, body });
    const handler = handlers[`${method} ${path}`];
    if (handler === undefined) return new Response("{}", { status: 404 });
    const reply = typeof handler === "function" ? handler(body) : handler;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
  return seen;
}

const analyte = (code: string, over: Partial<WireWorklistRow["analytes"][number]> = {}): WireWorklistRow["analytes"][number] => ({
  analyteId: `a-${code}`, code, nameEn: code, unit: "mg/dL", resultType: "numeric", resultId: null, value: null, flag: null,
  refLow: "70", refHigh: "100", refText: null, verificationStatus: null, enteredById: null, pathologistReviewPending: false,
  previous: null, ...over,
});
const WORKLIST: WireWorklistRow[] = [{
  orderItemId: "i-1", orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001",
  patientId: "p-1", patientDisplay: "Ram Kumar",
  serviceId: "svc-gluf", orderableCode: "GLUF", orderableName: "Glucose, fasting",
  discipline: "biochemistry", priority: "routine", state: "in_analysis",
  specimenNo: "S2608300001", tatStartedAt: "2026-08-30T06:00:00.000Z", tatTargetMinutes: 240,
  analytes: [analyte("GLUF")],
}];
const LFT: WireWorklistRow = {
  ...WORKLIST[0]!, orderItemId: "i-2", serviceId: "svc-lft", orderableCode: "LFT", orderableName: "Liver function test",
  specimenNo: "S2608300002", analytes: [analyte("TBIL", { value: "1.1", flag: "N" }), analyte("AST"), analyte("ALT")],
};
const ARRIVAL: WireBenchArrival = {
  specimenId: "s-9", specimenNo: "S2608300009", orderGroupId: "g-9", patientId: "p-9", patientDisplay: "Mohan Prasad",
  encounterNo: "V2608290009", container: "sst", specimenType: "serum", collectionSite: "ward", priority: "routine",
  orderableCodes: ["RFT", "K"], itemIds: ["i-9"], collectedAt: "2026-08-30T05:50:00.000Z", wristbandScanned: false, waitingMinutes: 6,
};

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("resolveScan — worklist first, then arrivals, then nothing; never a guess", () => {
  expect(resolveScan("s2608300001", WORKLIST, [ARRIVAL])).toMatchObject({ kind: "worklist" });
  expect(resolveScan("S2608300009", WORKLIST, [ARRIVAL])).toMatchObject({ kind: "arrival", row: { specimenNo: "S2608300009" } });
  expect(resolveScan("S2608300777", WORKLIST, [ARRIVAL])).toEqual({ kind: "none" });
  expect(resolveScan("  ", WORKLIST, [ARRIVAL])).toEqual({ kind: "none" });
});

it("D7 — a scanned tube in transit shows its patient; without a wristband scan it cannot be received until somebody is NAMED", async () => {
  const seen = mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [ARRIVAL] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/receive": { status: 201, body: { specimenId: "s-9", specimenNo: "S2608300009", itemIds: ["i-9"], tatStartedAt: "2026-08-30T06:00:00.000Z" } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByText("Mohan Prasad")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("Scan the tube"), "S2608300009{enter}");
  const row = screen.getByTestId("arrival-S2608300009");
  expect(row).toHaveTextContent(/no wristband scan/);
  expect(within(row).getByRole("button", { name: "Receive" })).toBeDisabled();
  await userEvent.type(within(row).getByLabelText("Identity re-checked by"), "Sister Rekha");
  expect(within(row).getByRole("button", { name: "Receive" })).toBeEnabled();
  await userEvent.click(within(row).getByRole("button", { name: "Receive" }));
  await waitFor(() => expect(seen.find((s) => s.path === "/api/lab/bench/receive")).toBeDefined());
  expect(seen.find((s) => s.path === "/api/lab/bench/receive")!.body).toEqual({ specimenNo: "S2608300009", identityRecheckBy: "Sister Rekha" });
});

it("a scan that matches neither list is refused as not drawn here — the chair's route is never asked", async () => {
  const seen = mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: WORKLIST },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByText("Ram Kumar")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("Scan the tube"), "S2608300777{enter}");
  expect(screen.getByRole("alert")).toHaveTextContent(/S2608300777/);
  expect(screen.getByRole("alert")).toHaveTextContent(/not drawn here today/);
  expect(seen.some((s) => s.path.startsWith("/api/lab/collection/specimen"))).toBe(false);
});

it("D6 — Save & complete lights when every analyte is filled and posts ONE record per value", async () => {
  const seen = mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: [LFT] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/results": { status: 201, body: { resultId: "r-x", flag: "N", deltaFlagged: false, criticalCallId: null } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByLabelText("LFT AST")).toBeInTheDocument());
  expect(screen.getByText(/1 of 3 in/)).toBeInTheDocument();
  const save = screen.getByRole("button", { name: "Save & complete" });
  expect(save).toBeDisabled();
  await userEvent.type(screen.getByLabelText("LFT AST"), "48");
  expect(save).toBeDisabled();
  await userEvent.type(screen.getByLabelText("LFT ALT"), "62");
  expect(save).toBeEnabled();
  await userEvent.click(save);
  await waitFor(() => expect(seen.filter((s) => s.path === "/api/lab/bench/results")).toHaveLength(2));
  const bodies = seen.filter((s) => s.path === "/api/lab/bench/results").map((s) => s.body as { analyteId: string; value: string });
  expect(bodies).toEqual([
    { orderItemId: "i-2", analyteId: "a-AST", value: "48", entryMode: "manual" },
    { orderItemId: "i-2", analyteId: "a-ALT", value: "62", entryMode: "manual" },
  ]);
});

it("02 H1 — an absurd value is refused, and the override asks for a PERSON rather than a tick", async () => {
  let calls = 0;
  mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: WORKLIST },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/results": () => {
      calls += 1;
      return calls === 1
        ? { status: 422, body: {
            statusCode: 422, code: "absurd_value",
            message: "GLUF 1600 mg/dL is outside the plausible envelope (5 … 1500) — re-check the sample and the decimal point, or have a second enterer override it",
          } }
        : { status: 201, body: { resultId: "r-1", flag: "HH", deltaFlagged: false, criticalCallId: "c-1" } };
    },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByLabelText("GLUF GLUF")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("GLUF GLUF"), "1600");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/outside the plausible envelope/));
  expect(screen.getByRole("alert")).toHaveTextContent(/second enterer/);
  await userEvent.click(screen.getByRole("button", { name: "Override envelope" }));
  await userEvent.type(screen.getByLabelText("Second enterer"), "01BENCH2");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
});

it("DD12 — a critical value says so the moment it is keyed, before anything is verified", async () => {
  mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: WORKLIST },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/results": { status: 201, body: { resultId: "r-1", flag: "HH", deltaFlagged: false, criticalCallId: "c-1" } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByLabelText("GLUF GLUF")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("GLUF GLUF"), "480");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/A call has been opened/));
});

it("02 §3.6 — the open call panel says a READ-BACK is what closes it", async () => {
  mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [{
      id: "c-1", resultId: "r-1", openedAt: "2026-08-30T02:00:00.000Z", openedBy: "u-tech",
      attempts: [{ at: "2026-08-30T02:02:00.000Z", by: "u-tech", contact: "ward 3", outcome: "no_answer" }],
      patientDisplay: "Ram Kumar", patientId: "p-1", orderNo: "L2608300001",
      encounterNo: "V2608290001", analyteCode: "K", value: "6.8", unit: "mmol/L", flag: "HH",
      supersededBy: null,
    }] },
    "POST /api/lab/bench/criticals/c-1/ack": { status: 201, body: { closed: true, attempts: 2 } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByText(/Ram Kumar · K 6.8 mmol\/L HH/)).toBeInTheDocument());
  expect(screen.getByText(/Attempts: 1/)).toBeInTheDocument();
  expect(screen.getByText(/repeats the value back/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Who was called Ram Kumar"), "Dr Rao, mobile");
  await userEvent.selectOptions(screen.getByLabelText("Outcome"), "message_left");
  await userEvent.type(screen.getByLabelText(/Read-back/), "potassium six point eight");
  await userEvent.click(screen.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(screen.getByLabelText("Who was called Ram Kumar")).toHaveValue(""));
});
