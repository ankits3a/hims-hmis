import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";

// `Link` needs a router context and a component test mounts none, so it is stubbed to a plain
// anchor — the assertion below is about WHICH case the row links to, which the stub preserves.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: React.ReactNode; params?: { caseId?: string } }) =>
    <a href={`/ot/cockpit/${params?.caseId ?? ""}`}>{children}</a>,
}));

const { OtList } = await import("./ot-list");

type Reply = { status: number; body: unknown };

function mockRoutes(handlers: Record<string, Reply>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const reply = handlers[`${init?.method ?? "GET"} ${raw.split("?")[0]!}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status, headers: { "Content-Type": "application/json" },
    });
  }));
}

const LIST = [
  {
    caseId: "c-1", seq: 1, procedureClass: "gynae_dnc", procedureCode: "DNC", laterality: null,
    surgeonId: "u-surgeon", anaesthetistId: "u-anaes", state: "listed",
    patientDisplay: "Patient A",
    gates: [{ kind: "consent", state: "satisfied" }, { kind: "deposit", state: "open" }],
  },
];

describe("OtList", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("shows the day's cases with their gate chips and a link to the case's cockpit", async () => {
    mockRoutes({ "GET /api/ot/list": { status: 200, body: LIST } });
    renderWithProviders(<OtList />);

    await userEvent.type(screen.getByLabelText(/List date/i), "2026-09-02");
    await userEvent.type(screen.getByLabelText(/Theatre/i), "res-ot-1");
    await userEvent.click(screen.getByRole("button", { name: /Show list/i }));

    expect(await screen.findByText("DNC")).toBeInTheDocument();
    // F20 — the list shows the name the VIEWER may see. This fixture is a confidential patient, so
    // the server sent the alias and the alias is what a printed list carries.
    expect(screen.getByText("Patient A")).toBeInTheDocument();
    expect(screen.getByText("listed")).toBeInTheDocument();
    // Both gates are named — the open one is the coordinator's whole morning.
    expect(screen.getByText("consent")).toBeInTheDocument();
    expect(screen.getByText("deposit")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open cockpit/i })).toHaveAttribute("href", "/ot/cockpit/c-1");
  });

  /**
   * T9's acceptance: exercise ONE refusal path and assert the LOCALE STRING, not the code. Here it
   * is `list_not_publishable` — the server's rule, rendered as the sentence the server's catalogue
   * carries. A client copy of that catalogue would be §2.54 pointed at a screen.
   */
  it("renders the server's refusal as a sentence when the list cannot be published", async () => {
    mockRoutes({
      "GET /api/ot/list": { status: 200, body: LIST },
      "POST /api/ot/lists/publish": {
        status: 422,
        body: { statusCode: 422, message: "not publishable", code: "list_not_publishable" },
      },
    });
    renderWithProviders(<OtList />);

    await userEvent.type(screen.getByLabelText(/List date/i), "2026-09-02");
    await userEvent.type(screen.getByLabelText(/Theatre/i), "res-ot-1");
    await userEvent.click(screen.getByRole("button", { name: /Show list/i }));
    await userEvent.click(screen.getByRole("button", { name: /Publish the list/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This list cannot be published yet.");
  });
});
