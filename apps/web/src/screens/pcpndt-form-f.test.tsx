import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { PcpndtFormF } from "./pcpndt-form-f";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({ studyId: "S1" }),
}));

/**
 * PLAN 18a T9 — the Form F screen, and A6's other half.
 *
 * **The assertion this file exists for is the NAME.** Every other screen renders a confidential
 * patient through the alias; this one shows the legal name, because a statutory declaration bearing
 * a pseudonym is a false declaration. T6's `read.test.ts` proves the server sends it; this proves
 * the screen renders it and tells the reader WHY, so nobody sees a leak and "fixes" it.
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

const FORM = {
  formFId: "F1", serialNo: 7, serialYear: 2026, status: "recorded", applicability: "pregnant",
  indicationCode: "anomaly-scan", gestationWeeks: 19, sections: { F: "anomaly scan" },
  declaration: {}, referral: {}, resultSummary: null,
  signedBy: "u1", signedAt: "2026-08-31T09:00:00.000Z", verifiedBy: null, verifiedAt: null,
  patientName: "Asha Devi", patientUhid: "HMS-00000001-5", patientIsConfidential: true,
  machine: { id: "M1", make: "GE", model: "Voluson S10", serial: "SN-99001" },
  person: { id: "P1", userId: "u1", qualification: "MD Radiodiagnosis" },
};

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

it("shows the REAL name for a confidential patient, and says why", async () => {
  mockRoutes({ "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: FORM } } });
  renderWithProviders(<PcpndtFormF />);
  expect(await screen.findByTestId("patient")).toHaveTextContent("Asha Devi");
  expect(screen.getByText(/statutory declaration bearing a pseudonym is a false declaration/))
    .toBeInTheDocument();
});

it("shows the gap-free serial and the machine the declaration names", async () => {
  mockRoutes({ "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: FORM } } });
  renderWithProviders(<PcpndtFormF />);
  expect(await screen.findByTestId("serial")).toHaveTextContent("Serial 7/2026");
  expect(screen.getByText(/Voluson S10.*SN-99001/)).toBeInTheDocument();
});

it("a recorded form offers VERIFY and no longer offers an edit", async () => {
  mockRoutes({ "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: FORM } } });
  renderWithProviders(<PcpndtFormF />);
  expect(await screen.findByRole("button", { name: /Verify/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Record and sign/ })).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/can no longer be edited/);
});

it("a study with no form offers to OPEN one, which mints the serial", async () => {
  mockRoutes({
    "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: null } },
    "POST /api/pcpndt/form-f": { status: 201, body: { formFId: "F1", serialNo: 1, serialYear: 2026 } },
  });
  renderWithProviders(<PcpndtFormF />);
  expect(await screen.findByText(/No Form F has been opened/)).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText("Indication"), "anomaly-scan");
  await userEvent.click(screen.getByRole("button", { name: "Open Form F" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

/** An unregistered machine is a 403 the sonologist acts on by calling the in-charge. */
it("shows an unregistered-machine refusal with the server's own words", async () => {
  mockRoutes({
    "GET /api/pcpndt/studies/S1/form-f": { status: 200, body: { form: null } },
    "POST /api/pcpndt/form-f": {
      status: 403,
      body: {
        statusCode: 403, code: "machine_not_registered",
        message: "device D1 is not on an active PCPNDT registration on 2026-08-31",
      },
    },
  });
  renderWithProviders(<PcpndtFormF />);
  await screen.findByText(/No Form F has been opened/);
  await userEvent.click(screen.getByRole("button", { name: "Open Form F" }));
  expect(await screen.findByRole("alert"))
    .toHaveTextContent(/not on an active PCPNDT registration.*machine_not_registered/);
});
