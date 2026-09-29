import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { ImagingResultsInbox } from "./imaging-results-inbox";

/**
 * PLAN 18-S RS9 T3 — THE DOCTOR'S IMAGING RESULTS. Criticals not read back come first and are
 * closed by the doctor's own read-back; opening a report is the read; "Mark acted upon" asks what
 * the report changed (an outcome and one line) and sends exactly that.
 */
type Reply = { status: number; body: unknown };
function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}
function bodiesOf(key: string): unknown[] {
  const fetchMock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL, RequestInit | undefined][] } };
  return fetchMock.mock.calls
    .filter(([input, init]) => `${init?.method ?? "GET"} ${String(input).split("?")[0]!}` === key)
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

const base = {
  studyId: "S1", studyName: "X-ray abdomen, erect", studyTypeCode: "XR-ABDO", patientId: "P1", uhid: "HMS-1",
  version: 1, amended: false, signedAt: "2026-09-28T05:18:00.000Z", publishedAt: "2026-09-28T05:18:00.000Z",
  signerName: "Dr Anjali Mehta", impression: null, criticalCategory: null, critical: null,
  firstReadAt: null, chasedAt: null, acted: null, orderedByMe: true,
};
const CRIT = {
  ...base, reportId: "R-CRIT", accessionNo: "X2609280027", patientName: "Lakshmi Oraon", state: "unread",
  impression: "Pneumoperitoneum — free gas under the right hemidiaphragm", criticalCategory: "red",
  critical: { criticalId: "C1", category: "red", raisedAt: "2026-09-28T05:18:00.000Z", acknowledgedAt: null, readBack: null },
};
const UNREAD = { ...base, reportId: "R-UN", studyId: "S2", accessionNo: "X2609260019", patientName: "Hari Oraon", state: "unread", chasedAt: "2026-09-27T09:35:00.000Z", impression: "No active disease." };
const ACTED = {
  ...base, reportId: "R-AC", studyId: "S3", accessionNo: "X2609160022", patientName: "Farida Khatoon", state: "acted",
  acted: { at: "2026-09-16T07:00:00.000Z", outcome: "referred", note: "Ordered CECT abdomen for raised ALP" },
};
const REPORT = {
  report: {
    reportId: "R-UN", studyId: "S2", accessionNo: "X2609260019", version: 1, status: "signed", templateKey: "generic",
    body: { technique: "PA view.", findings: "Lungs clear." }, impression: "No active disease.", laterality: null,
    criticalCategory: null, signerId: "u-rad", signedAt: base.signedAt, publishedAt: base.publishedAt,
    amendmentReason: null, supersedesId: null, patientName: "Hari Oraon", provenance: null,
  },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("lists the open critical first, in red, then unread (chased), then acted — each carrying its hooks", async () => {
  mockRoutes({ "GET /api/radiology/results": { status: 200, body: { rows: [CRIT, UNREAD, ACTED] } } });
  renderWithProviders(<ImagingResultsInbox />);
  const items = await screen.findAllByRole("listitem");
  expect(items.map((li) => li.getAttribute("data-acc"))).toEqual(["X2609280027", "X2609260019", "X2609160022"]);
  expect(items[0]).toHaveAttribute("data-crit", "C1");
  expect(within(items[0]!).getByText("RED critical")).toBeInTheDocument();
  expect(within(items[1]!).getByText("Unread · chased at 24 h")).toBeInTheDocument();
  expect(within(items[2]!).getByText(/Referred — Ordered CECT abdomen/)).toBeInTheDocument();
  expect(within(items[2]!).queryByRole("button", { name: "Mark acted upon" })).toBeNull();
  expect(screen.getByText(/1 critical to read back · 2 unread · 0 read, not acted on/)).toBeInTheDocument();
});

it("the doctor reads a red critical back in their own words through the treating-doctor route", async () => {
  mockRoutes({
    "GET /api/radiology/results": { status: 200, body: { rows: [CRIT] } },
    "POST /api/radiology/reports/R-CRIT/read-back": { status: 200, body: { criticalId: "C1", acknowledgedAt: "2026-09-28T05:30:00.000Z" } },
  });
  renderWithProviders(<ImagingResultsInbox />);
  await userEvent.click(await screen.findByRole("button", { name: "Read back and acknowledge" }));
  const form = screen.getByTestId("readback-form");
  const save = within(form).getByRole("button", { name: "Acknowledge" });
  expect(save).toBeDisabled();
  await userEvent.type(within(form).getByLabelText("Your read-back"), "Free gas under the diaphragm, surgery called");
  await userEvent.click(save);
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/reports/R-CRIT/read-back")).toEqual([{ readBack: "Free gas under the diaphragm, surgery called" }]); });
  expect(await screen.findByText(/Read back and acknowledged \(X2609280027\)/)).toBeInTheDocument();
});

it("opening a report shows its sections and impression; marking it acted sends the outcome and the line", async () => {
  mockRoutes({
    "GET /api/radiology/results": { status: 200, body: { rows: [UNREAD] } },
    "GET /api/radiology/reports/R-UN": { status: 200, body: REPORT },
    "POST /api/radiology/reports/R-UN/acted": { status: 200, body: { reportId: "R-UN", actedAt: "2026-09-28T06:00:00.000Z", outcome: "no_change" } },
  });
  renderWithProviders(<ImagingResultsInbox />);
  await userEvent.click(await screen.findByRole("button", { name: "Open report" }));
  const rep = await screen.findByTestId("inbox-report");
  expect(await within(rep).findByText(/Lungs clear\./)).toBeInTheDocument();
  expect(within(rep).getByText(/Signed by Dr Anjali Mehta/)).toBeInTheDocument();

  await userEvent.click(within(rep).getByRole("button", { name: "Mark acted upon" }));
  const form = screen.getByTestId("acted-form");
  await userEvent.click(within(form).getByRole("radio", { name: "No change needed" }));
  const save = within(form).getByRole("button", { name: "Save" });
  await userEvent.type(within(form).getByLabelText("One line for the record"), "ok");
  expect(save).toBeDisabled();
  await userEvent.type(within(form).getByLabelText("One line for the record"), " — cough settling, no change");
  await userEvent.click(save);
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/reports/R-UN/acted")).toEqual([{ outcome: "no_change", note: "ok — cough settling, no change" }]);
  });
});

it("a refusal is shown in the server's words — a doctor who is not treating this patient", async () => {
  mockRoutes({
    "GET /api/radiology/results": { status: 200, body: { rows: [UNREAD] } },
    "POST /api/radiology/reports/R-UN/acted": { status: 403, body: { code: "not_treating_doctor", message: "Only the treating doctor records what the X2609260019 report changed: Dr Rao." } },
  });
  renderWithProviders(<ImagingResultsInbox />);
  await userEvent.click(await screen.findByRole("button", { name: "Mark acted upon" }));
  const form = screen.getByTestId("acted-form");
  await userEvent.type(within(form).getByLabelText("One line for the record"), "Started antibiotics");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  const alert = await within(form).findByRole("alert");
  expect(alert).toHaveAttribute("data-refusal", "not_treating_doctor");
  expect(alert).toHaveTextContent(/Dr Rao/);
});

it("renders nothing for a user without radiology.reports.read", async () => {
  mockRoutes({ "GET /api/radiology/results": { status: 403, body: { code: "forbidden", message: "no" } } });
  const { container } = renderWithProviders(<ImagingResultsInbox />);
  await waitFor(() => { expect(container.querySelector("[data-testid='imaging-results']")).toBeNull(); });
});
