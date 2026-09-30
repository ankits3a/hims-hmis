import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyReading } from "./radiology-reading";
import { ImagingResultsInbox } from "../components/radiology/imaging-results-inbox";

/**
 * PLAN 18-S RS8c T4/T5 — the reading room, part 3: Follow-ups (overdue first; the dock books for a
 * holder of the ordering grant, else records the notice), Peer review (a blind case, RADPEER, a line
 * for a discrepancy), Night & outside (concur / minor / major under the second factor), and the
 * doctor's inbox "Book it".
 */
type Reply = { status: number; body: unknown } | ((body: unknown) => { status: number; body: unknown });
const calls: { key: string; body: unknown }[] = [];
let perms: string[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-rad" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const h = handlers[key];
    if (h === undefined) return new Response("{}", { status: 404 });
    const reply = typeof h === "function" ? h(body) : h;
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

const fu = (over: Record<string, unknown>) => ({
  followupId: "F1", studyId: "S1", accessionNo: "X2609010001", studyName: "USG breast", patientId: "P1",
  patientName: "Asha Devi", uhid: "HMS-00000001-5", source: "birads", recommendation: "BI-RADS 3 — short-interval follow-up (6 months)",
  intervalLabel: "6 months", dueOn: "2027-03-01", state: "open", overdue: false, signedAt: "2026-09-01T07:00:00.000Z",
  treatingDoctor: "Dr Mehra", notified: null, booked: null, closed: null, ...over,
});
const FU_BOARD = {
  rows: [fu({ followupId: "F2", patientName: "Ravi Kumar", overdue: true, dueOn: "2026-09-01", source: "fleischner", recommendation: "Fleischner 2017: CT at 6–12 months." }), fu({})],
  tiles: { open: 2, overdue: 1, notActed: 2, closedOnTime90: 86, recommendedThisMonth: 2 },
};
const WL = { "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [] } }, "GET /api/radiology/reading/criticals": { status: 200, body: { open: [], acknowledged: [] } } };

beforeEach(() => { setToken("t"); calls.length = 0; perms = ["radiology.reports.write", "radiology.reports.amend", "radiology.criticals.ack"]; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

/* ═══════════════════════ follow-ups ═══════════════════════ */

it("Follow-ups: the overdue row is in hand first; the reading room's dock records the notice; the doctor books", async () => {
  mockRoutes({
    ...WL,
    "GET /api/radiology/reading/followups": { status: 200, body: FU_BOARD },
    "POST /api/radiology/followups/F2/notified": { status: 201, body: { followupId: "F2", state: "notified" } },
  });
  renderWithProviders(<RadiologyReading studyId={null} view="followups" />);
  const inHand = await screen.findByTestId("fu-in-hand");
  expect(inHand).toHaveTextContent("Ravi Kumar");
  expect(within(screen.getByTestId("fu-list")).getAllByRole("button")[0]).toHaveTextContent("Overdue");
  expect(screen.getByTestId("fu-who-books")).toHaveTextContent("Dr Mehra");
  expect(screen.getByTestId("fu-dock-act")).toHaveTextContent("Record that they were told");
  await userEvent.click(screen.getByTestId("fu-dock-act"));
  await waitFor(() => expect(calls.find((c) => c.key === "POST /api/radiology/followups/F2/notified")?.body).toEqual({ channel: "phone", note: null }));
});

it("Follow-ups: a holder of the ordering grant books from the dock, and a refusal names the desk that fixes it", async () => {
  perms = ["radiology.reports.write", "radiology.orders.place"];
  mockRoutes({
    ...WL,
    "GET /api/radiology/reading/followups": { status: 200, body: FU_BOARD },
    "POST /api/radiology/followups/F2/book": { status: 409, body: { statusCode: 409, code: "encounter_closed", message: "The patient has no visit to hang the follow-up on — the front desk opens one." } },
  });
  renderWithProviders(<RadiologyReading studyId={null} view="followups" />);
  await waitFor(() => expect(screen.getByTestId("fu-dock-act")).toHaveTextContent("Book Ravi's follow-up"));
  await userEvent.click(screen.getByTestId("fu-dock-act"));
  const refusal = await screen.findByRole("alert");
  expect(refusal).toHaveAttribute("data-refusal", "encounter_closed");
  expect(within(refusal).getByRole("link")).toHaveAttribute("href", "/radiology/reception");
});

it("Follow-ups: closing needs a reason and a line before the button opens", async () => {
  mockRoutes({
    ...WL,
    "GET /api/radiology/reading/followups": { status: 200, body: { ...FU_BOARD, rows: [fu({ state: "notified", notified: { at: "2026-09-02T05:00:00.000Z", channel: "phone", by: "Dr Rao", note: null } })] } },
    "POST /api/radiology/followups/F1/close": { status: 201, body: { followupId: "F1", state: "closed" } },
  });
  renderWithProviders(<RadiologyReading studyId={null} view="followups" />);
  await waitFor(() => expect(screen.getByTestId("fu-dock-act")).toHaveTextContent("Close with the reason"));
  expect(screen.getByTestId("fu-dock-act")).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Close with a reason" }), "patient_declines");
  await userEvent.type(screen.getByPlaceholderText(/One line/), "Refusal signed");
  await userEvent.click(screen.getByTestId("fu-dock-act"));
  await waitFor(() => expect(calls.find((c) => c.key === "POST /api/radiology/followups/F1/close")?.body).toEqual({ reason: "patient_declines", note: "Refusal signed" }));
});

/* ═══════════════════════ the header's views ═══════════════════════ */

it("a resident sees Follow-ups but not Peer review or Night & outside — those are a consultant's", async () => {
  perms = ["radiology.reports.write"];
  mockRoutes({ ...WL, "GET /api/radiology/reading/followups": { status: 200, body: FU_BOARD } });
  renderWithProviders(<RadiologyReading studyId={null} view="followups" />);
  await screen.findByTestId("read-view-followups");
  expect(screen.queryByTestId("read-view-peer")).toBeNull();
  expect(screen.queryByTestId("read-view-tele")).toBeNull();
});

/* ═══════════════════════ peer review ═══════════════════════ */

const PEER_BOARD = {
  queue: [{ reviewId: "PR1", trigger: "random", studyTypeName: "CT head plain", modality: "ct", signedAt: "2026-08-10T05:00:00.000Z", openedAt: "2026-09-01T02:30:00.000Z", ageDays: 3 }],
  recent: [], readers: [{ readerId: "u2", readerName: "Dr Sahay", scored: 20, concur: 19, minor: 1, significant: 0, agreementPct: 95 }],
  tiles: { sampledThisMonth: 4, triggeredThisMonth: 1, agreementPct: 95, significantThisMonth: 0, overdue: 0 },
};
const PEER_CASE = {
  reviewId: "PR1", trigger: "random", studyId: "S9", studyTypeName: "CT head plain", modality: "ct", patientAgeSex: "61M",
  indication: "Fall, drowsy", sections: { findings: "No bleed." }, impression: "No acute intracranial finding.", coded: {}, signedAt: null, prelim: false,
};

it("Peer review: a blind case, and a discrepancy cannot be saved without saying what it was", async () => {
  mockRoutes({
    ...WL,
    "GET /api/radiology/reading/peer": { status: 200, body: PEER_BOARD },
    "GET /api/radiology/reading/peer/PR1": { status: 200, body: { case: PEER_CASE } },
    "POST /api/radiology/reading/peer/PR1/score": { status: 201, body: { reviewId: "PR1", score: "2b" } },
  });
  renderWithProviders(<RadiologyReading studyId={null} view="peer" />);
  const text = await screen.findByTestId("peer-report-text");
  expect(text).toHaveTextContent("No acute intracranial finding.");
  expect(screen.getByTestId("peer-in-hand")).toHaveTextContent("Blind");
  expect(screen.getByTestId("peer-case-PR1")).not.toHaveTextContent("Dr Sahay");
  await userEvent.click(screen.getByRole("radio", { name: /^2b/ }));
  expect(screen.getByTestId("peer-dock-act")).toBeDisabled();
  await userEvent.type(screen.getByRole("textbox", { name: "Note" }), "Missed a thin SDH");
  await userEvent.click(screen.getByTestId("peer-dock-act"));
  await waitFor(() => expect(calls.find((c) => c.key === "POST /api/radiology/reading/peer/PR1/score")?.body).toEqual({ score: "2b", learningCase: false, note: "Missed a thin SDH" }));
  expect(screen.getByTestId("peer-agreement")).toHaveTextContent("Dr Sahay");
});

/* ═══════════════════════ night & outside ═══════════════════════ */

const TELE_ROW = {
  teleReadId: "T1", studyId: "S5", accessionNo: "X2609010005", patientName: "Bablu Yadav", uhid: "HMS-00000009-1", studyName: "CT head plain",
  priority: "stat", providerName: "NightRad Teleradiology Pvt Ltd", readerName: "Dr Kavya Menon", readerNmcNo: "NMC/KA/2011/4471",
  prelimAt: "2026-09-01T20:40:00.000Z", imagesAt: "2026-09-01T20:02:00.000Z", tatMinutes: 38, targetMinutes: 30, late: true,
  prelim: { findings: "No bleed.", impression: "No acute intracranial finding." }, state: "awaiting", overread: null,
};
const TELE_BOARD = {
  configured: true, coverage: { nightFrom: "21:00", nightTo: "08:00", overreadBy: "10:00", prelimMinutes: { stat: 30, urgent: 60 } },
  providers: [{ key: "nightrad", name: "NightRad Teleradiology Pvt Ltd", dpaSignedOn: "2026-07-01", readers: 1 }],
  queue: [TELE_ROW], log: [], outside: [],
  summary: { prelims30: 1, medianTat30: 38, late30: 1, minor30: 0, major30: 0, awaiting: 1 },
};

it("Night reads: the reader and NMC number in the lane; MAJOR needs a line and an impression; the second factor is asked, then the correction is signed", async () => {
  let asked = 0;
  mockRoutes({
    ...WL,
    "GET /api/radiology/reading/tele": { status: 200, body: TELE_BOARD },
    "POST /api/auth/totp/verify": { status: 204, body: null },
    "POST /api/radiology/tele/T1/overread": () => (asked++ === 0
      ? { status: 403, body: { statusCode: 403, code: "second_factor_required", message: "second_factor_required" } }
      : { status: 201, body: { teleReadId: "T1", grade: "major", finalReportId: "R9" } }),
  });
  renderWithProviders(<RadiologyReading studyId={null} view="tele" />);
  const lane = await screen.findByTestId("tele-in-hand");
  expect(lane).toHaveTextContent("Dr Kavya Menon");
  expect(lane).toHaveTextContent("NMC/KA/2011/4471");
  expect(screen.getByTestId("overread-dock-act")).toHaveTextContent("Concur and sign");
  await userEvent.click(screen.getByRole("radio", { name: "Major discrepancy" }));
  expect(screen.getByTestId("overread-dock-act")).toBeDisabled();
  await userEvent.type(screen.getByPlaceholderText(/missed a 4 mm/), "Missed a 4 mm contusion");
  const impression = screen.getAllByRole("textbox").find((el) => (el as HTMLTextAreaElement).value === "No acute intracranial finding.")!;
  await userEvent.clear(impression);
  await userEvent.type(impression, "Right frontal contusion.");
  await userEvent.click(screen.getByTestId("overread-dock-act"));
  const code = await screen.findByLabelText("Authenticator code");
  await userEvent.type(code, "123456");
  await userEvent.click(screen.getByTestId("overread-dock-act"));
  await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/radiology/tele/T1/overread")).toHaveLength(2));
  expect(calls.find((c) => c.key === "POST /api/auth/totp/verify")?.body).toEqual({ code: "123456" });
  expect(calls.filter((c) => c.key === "POST /api/radiology/tele/T1/overread")[1]!.body).toEqual({
    grade: "major", note: "Missed a 4 mm contusion", findings: "No bleed.", impression: "Right frontal contusion.",
  });
});

it("Night reads: with no partner book published the view says so and links Setup → Books", async () => {
  mockRoutes({ ...WL, "GET /api/radiology/reading/tele": { status: 200, body: { ...TELE_BOARD, configured: false, coverage: null, providers: [], queue: [] } } });
  renderWithProviders(<RadiologyReading studyId={null} view="tele" />);
  const note = await screen.findByTestId("tele-not-configured");
  expect(within(note).getByRole("link")).toHaveAttribute("href", "/radiology/setup?view=books");
});

/* ═══════════════════════ the doctor's inbox (T5) ═══════════════════════ */

it("the doctor's results inbox lists follow-ups to book and 'Book it' places the order", async () => {
  perms = ["radiology.reports.read", "radiology.orders.place"];
  mockRoutes({
    "GET /api/radiology/results": { status: 200, body: { rows: [] } },
    "GET /api/radiology/results/followups": { status: 200, body: { rows: [fu({})] } },
    "POST /api/radiology/followups/F1/book": { status: 201, body: { followupId: "F1", orderId: "O9", orderNo: "R2609010009" } },
  });
  renderWithProviders(<ImagingResultsInbox />);
  const section = await screen.findByTestId("followups-to-book");
  expect(section).toHaveTextContent("BI-RADS 3");
  await userEvent.click(within(section).getByRole("button", { name: "Book it" }));
  await waitFor(() => expect(calls.some((c) => c.key === "POST /api/radiology/followups/F1/book")).toBe(true));
});
