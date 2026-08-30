import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { LabBench } from "./lab-bench";

/**
 * PLAN 17b T8 — the bench.
 *
 * **The refusal path asserted here is `absurd_value`** (02 H1), and what the screen does with it is
 * the point: it offers a field for a NAMED second holder of `lab.results.enter`, not a "confirm"
 * button. A dialog with a confirm button is a dialog people learn to click; a dialog that asks
 * whose name goes on a glucose of 1600 is one they read.
 *
 * The second property is DD12's: **a critical value opens a call at ENTRY**, the screen says so
 * immediately, and the panel it opens says in as many words that only a read-back closes it.
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

const WORKLIST = [{
  orderItemId: "i-1", orderId: "o-1", orderNo: "L2608300001", encounterNo: "V2608290001",
  patientId: "p-1", patientDisplay: "Ram Kumar",
  serviceId: "svc-gluf", orderableCode: "GLUF", orderableName: "Glucose, fasting",
  discipline: "biochemistry", priority: "routine", state: "in_analysis",
  specimenNo: "S2608300001", tatStartedAt: "2026-08-30T06:00:00.000Z",
  analytes: [{
    analyteId: "a-gluf", code: "GLUF", nameEn: "Glucose, fasting", unit: "mg/dL",
    resultType: "numeric", resultId: null, value: null, flag: null,
    refLow: "70", refHigh: "100", refText: null,
    verificationStatus: null, enteredById: null, pathologistReviewPending: false,
  }],
}];

beforeEach(() => { setToken("t"); });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("02 H1 — an absurd value is refused, and the override asks for a PERSON rather than a tick", async () => {
  let calls = 0;
  mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: WORKLIST },
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

  /** THE REFUSAL NAMES THE ENVELOPE AND WHAT TO DO — not "invalid value". */
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/outside the plausible envelope/));
  expect(screen.getByRole("alert")).toHaveTextContent(/second enterer/);

  /** THE OVERRIDE IS A NAME. There is no confirm button anywhere on this path. */
  await userEvent.click(screen.getByRole("button", { name: "Override envelope" }));
  await userEvent.type(screen.getByLabelText("Second enterer"), "01BENCH2");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
});

it("DD12 — a critical value says so the moment it is keyed, before anything is verified", async () => {
  mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: WORKLIST },
    "GET /api/lab/bench/criticals": { status: 200, body: [] },
    "POST /api/lab/bench/results": { status: 201, body: {
      resultId: "r-1", flag: "HH", deltaFlagged: false, criticalCallId: "c-1",
    } },
  });
  renderWithProviders(<LabBench />);
  await waitFor(() => expect(screen.getByLabelText("GLUF GLUF")).toBeInTheDocument());
  await userEvent.type(screen.getByLabelText("GLUF GLUF"), "480");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(/A call has been opened/));
});

it("02 §3.6 — the open call panel says a READ-BACK is what closes it", async () => {
  mockRoutes({
    "GET /api/lab/bench/worklist": { status: 200, body: [] },
    "GET /api/lab/bench/criticals": { status: 200, body: [{
      id: "c-1", resultId: "r-1", openedAt: "2026-08-30T02:00:00.000Z", openedBy: "u-tech",
      attempts: [{ at: "2026-08-30T02:02:00.000Z", by: "u-tech", contact: "ward 3", outcome: "no_answer" }],
      readbackText: null, closedBy: null, closedAt: null,
    }] },
    "POST /api/lab/bench/criticals/c-1/ack": { status: 201, body: { closed: true, attempts: 2 } },
  });
  renderWithProviders(<LabBench />);

  await waitFor(() =>
    expect(screen.getByText("Critical values — telephone now")).toBeInTheDocument());
  expect(screen.getByText(/Attempts: 1/)).toBeInTheDocument();
  expect(screen.getByText(/repeats the value back/)).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Who was called"), "Dr Rao, mobile");
  await userEvent.type(screen.getByLabelText(/Read-back/), "potassium six point eight");
  await userEvent.click(screen.getByRole("button", { name: "Record" }));
  await waitFor(() => expect(screen.getByLabelText("Who was called")).toHaveValue(""));
});
