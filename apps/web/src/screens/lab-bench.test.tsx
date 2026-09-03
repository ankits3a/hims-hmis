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
  /** 17d T2 — `identifiedBy` is now on every receive: the route requires it and the screen declares it. */
  expect(seen.find((s) => s.path === "/api/lab/bench/receive")!.body).toEqual({
    specimenNo: "S2608300009", identityRecheckBy: "Sister Rekha", identifiedBy: "scan",
  });
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

/**
 * 17d T2 — THE SMUDGED LABEL. Two assertions a green suite would otherwise miss: Receive stays
 * DISABLED until both the witness and the reason are there (a control the operator can walk past by
 * clicking through is not a control), and the body actually carries `identifiedBy: "typed"` — the
 * route requires it, and a screen that sent `"scan"` while a human keyed the number would make the
 * whole rule unreachable from the one surface that can answer it.
 */
it("17d T2 — a typed tube number opens a witness and a reason, and Receive waits for both", async () => {
  const seen = mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/arrivals": { status: 200, body: [ARRIVAL] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "GET /api/lab/collection/specimen/S2608300009": { status: 200, body: null },
    "POST /api/lab/bench/receive": { status: 201, body: { specimenId: "s-9", itemIds: ["i-9"] } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByTestId("arrival-S2608300009")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("Scan the tube"), "S2608300009{Enter}");

  // The unscanned-wristband re-check is this arrival's own gate (17a A6) — satisfy it first.
  await userEvent.type(await screen.findByLabelText("Identity re-checked by"), "Sister Rekha");
  const receive = screen.getByRole("button", { name: "Receive" });
  expect(receive).toBeEnabled();

  await userEvent.click(screen.getByLabelText("The label cannot be read — I typed the number"));
  expect(receive).toBeDisabled(); // THE KILL: a witness-free re-label one click away
  await userEvent.type(screen.getByLabelText("Witnessed by (second person’s login)"), "01BENCH2");
  expect(receive).toBeDisabled(); // …and still disabled with no reason
  await userEvent.type(screen.getByLabelText("Why the label could not be read"), "frozen over");
  expect(receive).toBeEnabled();

  await userEvent.click(receive);
  await waitFor(() => expect(seen.filter((c) => c.path === "/api/lab/bench/receive")).toHaveLength(1));
  expect(seen.find((c) => c.path === "/api/lab/bench/receive")!.body).toMatchObject({
    specimenNo: "S2608300009", identifiedBy: "typed",
    relabel: { witnessedBy: "01BENCH2", reason: "frozen over" },
  });
});

/**
 * 17d T1 — THE SUSPECTED SWAP, on the screen. The two assertions that matter are the ones a green
 * suite would otherwise miss: the OTHER tube's barcode is on the page (a refusal saying "check the
 * other tube" without its number sends a technologist to a rack of forty), and the second person is
 * sent as `impossibleOverride` and NOT as `absurdOverride` — D2's whole point is that a
 * decimal-point waiver must not excuse a swapped tube.
 */
it("17d T1 — an impossible value names the other tube drawn in that minute, and vouches separately", async () => {
  let calls = 0;
  const seen = mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: WORKLIST },
    "GET /api/lab/bench/arrivals": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/results": () => {
      calls += 1;
      return calls === 1
        ? { status: 422, body: {
            statusCode: 422, code: "analyte_not_applicable",
            message: "UPT is reported only for female patients and this record reads male — check the tube against the patient before the number goes in",
            detail: { analyteCode: "UPT", breach: "sex", suspectSpecimenNos: ["S2608300002", "S2608300003"] },
          } }
        : { status: 201, body: { resultId: "r-2", flag: null, deltaFlagged: false, criticalCallId: null } };
    },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByLabelText("GLUF GLUF")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("GLUF GLUF"), "90");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(/Check the tube before this value goes in/);
  expect(alert).toHaveTextContent(/reported only for female patients/);
  // THE KILL: a banner without the barcodes is a banner nobody can act on.
  expect(alert).toHaveTextContent(/S2608300002, S2608300003/);

  await userEvent.type(screen.getByLabelText("Confirmed by (second person’s login)"), "01BENCH2");
  await userEvent.click(screen.getByRole("button", { name: "Vouch & save" }));
  await waitFor(() => expect(seen.filter((c) => c.path === "/api/lab/bench/results")).toHaveLength(2));
  const second = seen.filter((c) => c.path === "/api/lab/bench/results")[1]!.body as Record<string, unknown>;
  expect(second.impossibleOverride).toEqual({ by: "01BENCH2" });
  expect(second.absurdOverride).toBeUndefined(); // THE KILL: the two waivers are not interchangeable
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
