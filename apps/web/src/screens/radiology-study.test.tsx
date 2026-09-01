import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologyStudy } from "./radiology-study";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({ studyId: "S1" }),
}));

/**
 * PLAN 18a T9 — the study console.
 *
 * **The assertion that carries the weight is the waive button.** It is rendered from the row's OWN
 * `waivable` flag, which the server snapshotted at check-in from `gates.ts`'s constant. A
 * client-side list of waivable kinds would be a second copy of a statutory rule, and `form_f` is
 * the entry somebody would eventually add to it — so the test proves the button follows the server
 * and appears on one kind and not the other.
 */
type Reply = { status: number; body: unknown };
const calls: string[] = [];

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    calls.push(key);
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const STUDY = {
  studyId: "S1", accessionNo: "X2608310001", status: "checked_in", priority: "routine",
  studyTypeCode: "USG-OBS-ANOMALY", scheduledAt: null, deviceResourceId: "D1",
  encounterNo: "V2608310001", patientId: "P1", patientName: "Asha Devi",
  formFRequired: true, restricted: true, ionising: false, contrastGiven: false,
  acquiredAt: null, authorisedBy: null, reports: [],
};

const READINESS = {
  state: "checked_in", ready: false,
  gates: [
    { id: "g1", kind: "form_f", state: "open", waivable: false },
    { id: "g2", kind: "chaperone_present", state: "open", waivable: true },
  ],
  open: ["chaperone_present", "form_f"],
};

beforeEach(() => { setToken("t"); calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

it("renders a WAIVE control only where the SERVER said the gate is waivable", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: READINESS },
  });
  renderWithProviders(<RadiologyStudy />);

  const chaperone = await screen.findByTestId("gate-chaperone_present");
  expect(chaperone.textContent).toContain("Waive");
  /** `form_f` is not waivable, and the client learned that from the row rather than from a list. */
  const formF = screen.getByTestId("gate-form_f");
  expect(formF.textContent).not.toContain("Waive");
});

it("shows the Form F flag on the header — the one a technologist must not miss", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: READINESS },
  });
  renderWithProviders(<RadiologyStudy />);
  expect(await screen.findByText("Form F")).toBeInTheDocument();
});

/**
 * The refusal is the product. `form_f_missing` tells a technologist to go and open the register;
 * a re-worded "could not proceed" tells them to press the button again.
 */
it("shows a gate refusal verbatim, with its code", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: STUDY } },
    "GET /api/radiology/studies/S1/readiness": { status: 200, body: READINESS },
    "POST /api/radiology/studies/S1/gates/form_f/satisfy": {
      status: 422,
      body: {
        statusCode: 422, code: "form_f_missing",
        message: "no Form F has been opened for this study — the PCPNDT register is the only way past this gate",
      },
    },
  });
  renderWithProviders(<RadiologyStudy />);
  const formF = await screen.findByTestId("gate-form_f");
  await userEvent.click(formF.querySelector("button")!);
  expect(await screen.findByRole("alert"))
    .toHaveTextContent(/the PCPNDT register is the only way past this gate.*form_f_missing/);
});

it("says the study is ready when the server reports no open gates", async () => {
  mockRoutes({
    "GET /api/radiology/studies/S1": { status: 200, body: { study: { ...STUDY, status: "ready" } } },
    "GET /api/radiology/studies/S1/readiness": {
      status: 200,
      body: { state: "ready", ready: true, gates: [{ id: "g1", kind: "form_f", state: "satisfied", waivable: false }], open: [] },
    },
  });
  renderWithProviders(<RadiologyStudy />);
  expect(await screen.findByRole("status")).toHaveTextContent(/ready/i);
});
