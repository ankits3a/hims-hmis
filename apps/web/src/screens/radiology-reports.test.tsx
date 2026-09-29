import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReports } from "./radiology-reports";

/**
 * PLAN 18-S RS9 T4 — REPORT HAND-OVER. One register, rows that need the desk first; the report in
 * hand opens the hand-over with ONE docked act; a relative is named, related and identified (no OTP
 * service exists — said on the screen); film and CD are asked for, printed, and handed with the report.
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

const row = {
  studyId: "S1", version: 1, modality: "xray", patientId: "P1", uhid: "HMS-1", publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
  criticalCategory: null, bedsideLocation: null, doctor: "read", notice: "queued", filmIncluded: true,
  handovers: [], media: [], needs: ["not_collected"],
};
const XRAY = { ...row, reportId: "R1", accessionNo: "X2609290001", studyName: "X-ray chest PA", patientName: "Farida Khatoon" };
const ABN = {
  ...row, reportId: "R2", studyId: "S2", accessionNo: "X2609270118", studyName: "CT abdomen", patientName: "Latika Hansda",
  modality: "ct", filmIncluded: false, criticalCategory: "orange", doctor: "unread", notice: null,
  publishedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(), needs: ["abnormal_uncollected", "notice_not_sent", "not_collected"],
};
const DONE = {
  ...row, reportId: "R3", studyId: "S3", accessionNo: "X2609280001", studyName: "USG abdomen", patientName: "Ramdas Soy", modality: "usg",
  filmIncluded: false, needs: [], handovers: [{ handoverId: "H1", reportId: "R3", version: 1, collectorKind: "patient", collectorName: null, collectorRelation: null, filmSheets: 0, cd: false, handedAt: new Date().toISOString() }],
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("one register: the abnormal uncollected row first, the rows that need the desk in the list, the clock running", async () => {
  mockRoutes({ "GET /api/radiology/release": { status: 200, body: { rows: [ABN, XRAY, DONE] } } });
  renderWithProviders(<RadiologyReports />);
  const reg = await screen.findByTestId("release-register");
  const items = await within(reg).findAllByRole("listitem");
  expect(items.map((li) => li.getAttribute("data-acc"))).toEqual(["X2609270118", "X2609290001", "X2609280001"]);
  expect(items[0]).toHaveAttribute("data-state", "abnormal_uncollected");
  expect(items[2]).toHaveAttribute("data-state", "done");
  expect(within(items[0]!).getByText(/Abnormal, not collected in 24 h/)).toBeInTheDocument();
  expect(screen.getAllByText(/Latika Hansda/).length).toBeGreaterThan(1);
});

it("a relative collects only with a name, a relation and an ID; the OTP gap is said; Enter-dock sends the collector", async () => {
  mockRoutes({
    "GET /api/radiology/release": { status: 200, body: { rows: [XRAY] } },
    "POST /api/radiology/reports/R1/handover": { status: 200, body: { handoverId: "H9", filmSheets: 0, cd: false } },
  });
  renderWithProviders(<RadiologyReports />);
  const reg = await screen.findByTestId("release-register");
  await userEvent.click(await within(reg).findByRole("button", { name: "Open" }));
  const hand = screen.getByTestId("handover");
  await userEvent.click(within(hand).getByRole("radio", { name: "Relative" }));
  expect(within(hand).getByTestId("otp-deferred")).toHaveTextContent(/no OTP service/);
  const act = within(hand).getByTestId("dock-act");
  expect(act).toBeDisabled();
  await userEvent.type(within(hand).getByLabelText("Relative's name"), "Rakesh Munda");
  await userEvent.selectOptions(within(hand).getByLabelText("Relation"), "son");
  await userEvent.selectOptions(within(hand).getByLabelText("ID shown"), "aadhaar");
  await userEvent.type(within(hand).getByLabelText("Last 4 characters"), "4821");
  expect(act).toBeEnabled();
  await userEvent.click(act);
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/reports/R1/handover")).toEqual([{
      collectorKind: "relative", collectorName: "Rakesh Munda", collectorRelation: "Son",
      collectorIdType: "aadhaar", collectorIdLast4: "4821", mediaRequestIds: [], note: null,
    }]);
  });
  expect(await screen.findByText(/Handed over and logged: Farida Khatoon/)).toBeInTheDocument();
});

it("ruling 1: film is asked for, marked printed, and handed with the report; the included sheet says no charge", async () => {
  const withMedia = {
    ...XRAY, needs: ["media_to_hand", "not_collected"],
    media: [
      { requestId: "M1", kind: "film", quantity: 1, included: true, requestedAt: new Date().toISOString(), printedAt: new Date().toISOString(), handedOver: false, serviceCode: null },
      { requestId: "M2", kind: "cd", quantity: 1, included: false, requestedAt: new Date().toISOString(), printedAt: null, handedOver: false, serviceCode: "RAD-CD" },
    ],
  };
  mockRoutes({
    "GET /api/radiology/release": { status: 200, body: { rows: [withMedia] } },
    "POST /api/radiology/studies/S1/media": { status: 200, body: { requestIds: ["M3"], included: false } },
    "POST /api/radiology/media/M2/printed": { status: 200, body: { requestId: "M2", printedAt: new Date().toISOString() } },
    "POST /api/radiology/reports/R1/handover": { status: 200, body: { handoverId: "H9", filmSheets: 1, cd: false } },
  });
  renderWithProviders(<RadiologyReports />);
  await userEvent.click(await within(await screen.findByTestId("release-register")).findByRole("button", { name: "Open" }));
  const media = screen.getByTestId("media");
  expect(within(media).getByText(/An X-ray includes one film/)).toBeInTheDocument();
  expect(within(media).getByText(/included, no charge/)).toBeInTheDocument();
  expect(within(media).getByText(/bill RAD-CD at the billing counter/)).toBeInTheDocument();

  await userEvent.click(within(media).getByRole("button", { name: "Ask for a CD" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/studies/S1/media")).toEqual([{ kind: "cd" }]); });
  await userEvent.click(within(media).getByRole("button", { name: "Mark printed" }));
  await waitFor(() => { expect(bodiesOf("POST /api/radiology/media/M2/printed")).toHaveLength(1); });

  await userEvent.click(within(media).getByRole("checkbox", { name: "Hand over with the report" }));
  await userEvent.click(screen.getByTestId("dock-act"));
  await waitFor(() => {
    expect(bodiesOf("POST /api/radiology/reports/R1/handover")).toEqual([{
      collectorKind: "patient", collectorName: null, collectorRelation: null, collectorIdType: null, collectorIdLast4: null,
      mediaRequestIds: ["M1"], note: null,
    }]);
  });
});

it("a refusal names what to do — an amended report is handed over as the new version", async () => {
  mockRoutes({
    "GET /api/radiology/release": { status: 200, body: { rows: [XRAY] } },
    "POST /api/radiology/reports/R1/handover": { status: 409, body: { code: "report_superseded", message: "Version 1 of the X2609290001 report was amended — version 2 is the report now; open that one." } },
  });
  renderWithProviders(<RadiologyReports />);
  await userEvent.click(await within(await screen.findByTestId("release-register")).findByRole("button", { name: "Open" }));
  await userEvent.click(screen.getByTestId("dock-act"));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveAttribute("data-refusal", "report_superseded");
  expect(alert).toHaveTextContent(/version 2 is the report now/);
});
