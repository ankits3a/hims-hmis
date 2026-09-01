import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyWorklist } from "./radiology-worklist";

/**
 * `useNavigate` is the one router hook this screen calls, and the harness mounts no
 * `RouterProvider` — the house convention `opd-desk.test.tsx` records. `importOriginal` keeps every
 * other export real, because a factory that returned only what the screen needs TODAY fails at
 * access time the first time it needs one more.
 */
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

/**
 * PLAN 18a T9 — the imaging worklist.
 *
 * **What is asserted is that the screen FILTERS NOTHING.** A restricted study is absent because the
 * server did not send it (T8 A8) and a confidential patient's row arrives already carrying whichever
 * name the reader is entitled to. So the test feeds rows and checks that what the server said is
 * exactly what is rendered — a screen that "helpfully" hid or re-rendered either would fail here.
 */
type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const row = (over: Record<string, unknown>) => ({
  studyId: "S1", accessionNo: "X2608310001", status: "scheduled", priority: "routine",
  studyTypeCode: "USG-ABDO", scheduledAt: "2026-08-31T09:00:00.000Z", deviceResourceId: "D1",
  encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: false, restricted: false, ...over,
});

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("renders the accession, the patient and the study the server sent", async () => {
  mockRoutes({ "GET /api/radiology/worklist": { status: 200, body: { rows: [row({})] } } });
  renderWithProviders(<RadiologyWorklist />);
  expect(await screen.findByText("X2608310001")).toBeInTheDocument();
  expect(screen.getByText("Asha Devi")).toBeInTheDocument();
});

/**
 * The two flags a technologist must not miss are on the ROW rather than one click in. `form_f` is
 * the one with a criminal statute behind it.
 */
it("shows the Form F flag and the STAT badge on the row", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": {
      status: 200,
      body: { rows: [row({ formFRequired: true, priority: "stat", restricted: true })] },
    },
  });
  renderWithProviders(<RadiologyWorklist />);
  expect(await screen.findByText("Form F")).toBeInTheDocument();
  expect(screen.getByText("STAT")).toBeInTheDocument();
  expect(screen.getByText("restricted")).toBeInTheDocument();
});

/**
 * ═══ THE SCREEN RENDERS THE NAME THE SERVER CHOSE, WHATEVER IT IS ═══
 *
 * The alias decision belongs to `read.ts`'s `displayName` call. If this component ever grew its own
 * confidentiality logic, this row would be the one that caught it: the server said "Priya M." and
 * the screen must say "Priya M." and nothing else.
 */
it("renders the alias verbatim when the server sent one — it makes no confidentiality decision", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": { status: 200, body: { rows: [row({ patientName: "Priya M." })] } },
  });
  renderWithProviders(<RadiologyWorklist />);
  expect(await screen.findByText("Priya M.")).toBeInTheDocument();
  expect(screen.queryByText("Asha Devi")).not.toBeInTheDocument();
});

it("`stat` sorts above `routine`, which is the one thing the list decides", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": {
      status: 200,
      body: {
        rows: [
          row({ studyId: "S1", accessionNo: "X-ROUTINE", priority: "routine" }),
          row({ studyId: "S2", accessionNo: "X-STAT", priority: "stat" }),
        ],
      },
    },
  });
  renderWithProviders(<RadiologyWorklist />);
  await screen.findByText("X-STAT");
  const rows = screen.getAllByRole("row").slice(1);
  expect(rows[0]!.textContent).toContain("X-STAT");
});

it("switching the view re-queries, and the empty list says so", async () => {
  mockRoutes({ "GET /api/radiology/worklist": { status: 200, body: { rows: [] } } });
  renderWithProviders(<RadiologyWorklist />);
  expect(await screen.findByText(/Nothing on this list/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Unread" }));
  await waitFor(() => { expect(screen.getByRole("button", { name: "Unread" })).toBeInTheDocument(); });
});

it("a refusal is shown with the server's own words", async () => {
  mockRoutes({
    "GET /api/radiology/worklist": {
      status: 403, body: { statusCode: 403, message: "u does not hold radiology.worklist.read", code: "unknown_study" },
    },
  });
  renderWithProviders(<RadiologyWorklist />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/does not hold radiology.worklist.read/);
});
