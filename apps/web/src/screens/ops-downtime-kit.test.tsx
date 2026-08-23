import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { OpsDowntimeKit } from "./ops-downtime-kit";

/**
 * PLAN 11c T5 — ROUTINE tier (AGENT-RULES §3): tests required and must pass; mutants NOT
 * required, fail-first NOT owed.
 *
 * PRINT EXCLUSIVITY IS A BEHAVIOURAL ASSERTION, NAMED EXPLICITLY IN THIS TASK'S BRIEF (§3.34's
 * scar: six screens once honoured the `.print-doc` convention with zero tests protecting it, and
 * a mutant that deleted it passed everything). The two tests below that reach the print view both
 * assert `container.querySelectorAll(".print-doc")` has length exactly 1 and that the generator
 * form is GONE, not hidden beside it — the `billing-counter.test.tsx` precedent for the same
 * convention.
 */

type Reply = { status: number; body: unknown };
type Handler = Reply | (() => Reply);

function mockRoutes(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
      const handler = handlers[key];
      if (handler === undefined) return new Response("{}", { status: 404 });
      const reply = typeof handler === "function" ? handler() : handler;
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function callsTo(method: string, path: string): { body: unknown }[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return (init?.method ?? "GET") === method && raw.split("?")[0] === path;
    })
    .map(([, init]) => ({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }));
}

const PRINT_PAYLOAD = {
  kitId: "kit-1",
  note: "power cut, block A",
  generatedBy: "u-1",
  generatedAt: "2026-08-23T03:00:00.000Z",
  totalForms: 2,
  ranges: [
    {
      id: "rng-1",
      desk: "Front desk",
      formKind: "registration",
      startSerial: 1,
      endSerial: 2,
      count: 2,
      forms: [
        { formKind: "registration", serial: 1, qr: "dtk1.kit-1.registration.1.sig1" },
        { formKind: "registration", serial: 2, qr: "dtk1.kit-1.registration.2.sig2" },
      ],
    },
  ],
};

describe("OpsDowntimeKit", () => {
  beforeEach(() => {
    setToken("tok-1");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setToken(null);
    localStorage.clear();
  });

  it("renders the empty-list state when no kit has been generated", async () => {
    mockRoutes({ "GET /ops/downtime-kits": { status: 200, body: { kits: [] } } });
    renderWithProviders(<OpsDowntimeKit />);
    expect(await screen.findByTestId("kit-list-empty")).toBeInTheDocument();
  });

  it("lists a previously-generated kit from GET /ops/downtime-kits", async () => {
    mockRoutes({
      "GET /ops/downtime-kits": {
        status: 200,
        body: {
          kits: [
            {
              id: "kit-0", note: "drill", generatedBy: "u-1", generatedAt: "2026-08-20T00:00:00.000Z",
              totalForms: 5, ranges: [],
            },
          ],
        },
      },
    });
    renderWithProviders(<OpsDowntimeKit />);
    const row = await screen.findByTestId("kit-row-kit-0");
    expect(row).toHaveTextContent("drill");
    expect(row).toHaveTextContent("5");
  });

  it("generating a kit POSTs desks with only the non-zero counts, then the print view REPLACES the screen showing exactly one .print-doc", async () => {
    mockRoutes({
      "GET /ops/downtime-kits": { status: 200, body: { kits: [] } },
      "POST /ops/downtime-kits": {
        status: 201,
        body: { id: "kit-1", note: "power cut, block A", generatedBy: "u-1", generatedAt: "2026-08-23T03:00:00.000Z", totalForms: 2, ranges: PRINT_PAYLOAD.ranges, eventId: "ev-1" },
      },
      "GET /ops/downtime-kits/kit-1": { status: 200, body: PRINT_PAYLOAD },
    });
    const { container } = renderWithProviders(<OpsDowntimeKit />);
    const user = userEvent.setup();

    await screen.findByTestId("kit-list-empty");
    await user.type(screen.getByLabelText("Desk"), "Front desk");
    await user.type(screen.getByLabelText("Registration"), "2");
    await user.type(screen.getByLabelText("Note"), "power cut, block A");
    await user.click(screen.getByRole("button", { name: "Generate kit (Alt+S)" }));

    await waitFor(() => expect(callsTo("POST", "/ops/downtime-kits")).toHaveLength(1));
    expect(callsTo("POST", "/ops/downtime-kits")[0]!.body).toEqual({
      note: "power cut, block A",
      desks: [{ desk: "Front desk", counts: { registration: 2 } }],
    });

    const doc = await waitFor(() => {
      const found = container.querySelector(".print-doc");
      expect(found).not.toBeNull();
      return found;
    });
    expect(doc).not.toBeNull();
    // exactly one printable document is mounted: the generator/list is GONE, not hidden beside it
    expect(container.querySelectorAll(".print-doc")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Generate kit (Alt+S)" })).toBeNull();
    expect(screen.getByTestId("kit-print-id")).toHaveTextContent("kit-1");
    expect(screen.getByTestId("kit-form-registration-1")).toBeInTheDocument();
    expect(screen.getByTestId("kit-form-registration-2")).toBeInTheDocument();
  });

  it("printing an EXISTING kit from the list also replaces the screen, and Back returns to the generator", async () => {
    mockRoutes({
      "GET /ops/downtime-kits": {
        status: 200,
        body: { kits: [{ id: "kit-1", note: "power cut, block A", generatedBy: "u-1", generatedAt: "2026-08-23T03:00:00.000Z", totalForms: 2, ranges: PRINT_PAYLOAD.ranges }] },
      },
      "GET /ops/downtime-kits/kit-1": { status: 200, body: PRINT_PAYLOAD },
    });
    const { container } = renderWithProviders(<OpsDowntimeKit />);
    const user = userEvent.setup();

    const row = await screen.findByTestId("kit-row-kit-1");
    await user.click(screen.getByRole("button", { name: "Print" }));

    await waitFor(() => expect(container.querySelectorAll(".print-doc")).toHaveLength(1));
    expect(row).not.toBeInTheDocument(); // the list is gone along with the rest of the screen

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(container.querySelectorAll(".print-doc")).toHaveLength(0);
    expect(await screen.findByTestId("kit-row-kit-1")).toBeInTheDocument();
  });

  it("a downtime_kit_empty refusal (every count left at zero) renders inline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const path = raw.split("?")[0]!;
        const json = (body: unknown, status: number): Response =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (init?.method === "POST" && path === "/ops/downtime-kits") {
          return json({ code: "downtime_kit_empty", message: "a kit that reserves no forms is not a kit" }, 400);
        }
        if (path === "/ops/downtime-kits") return json({ kits: [] }, 200);
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpsDowntimeKit />);
    const user = userEvent.setup();

    await screen.findByTestId("kit-list-empty");
    await user.type(screen.getByLabelText("Desk"), "Front desk");
    await user.click(screen.getByRole("button", { name: "Generate kit (Alt+S)" }));

    const refusal = await screen.findByTestId("kit-generate-error");
    expect(refusal).toHaveAttribute("data-code", "downtime_kit_empty");
    expect(refusal).toHaveTextContent("reserves no forms");
  });

  it("a downtime_kit_duplicate_desk refusal (two rows, same desk name) renders inline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const path = raw.split("?")[0]!;
        const json = (body: unknown, status: number): Response =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (init?.method === "POST" && path === "/ops/downtime-kits") {
          return json({ code: "downtime_kit_duplicate_desk", message: 'desk "Front desk" appears more than once in one kit' }, 400);
        }
        if (path === "/ops/downtime-kits") return json({ kits: [] }, 200);
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpsDowntimeKit />);
    const user = userEvent.setup();

    await screen.findByTestId("kit-list-empty");
    await user.click(screen.getByRole("button", { name: "Add desk" }));

    const deskInputs = screen.getAllByLabelText("Desk");
    const registrationInputs = screen.getAllByLabelText("Registration");
    await user.type(deskInputs[0]!, "Front desk");
    await user.type(registrationInputs[0]!, "1");
    await user.type(deskInputs[1]!, "Front desk");
    await user.type(registrationInputs[1]!, "1");
    await user.click(screen.getByRole("button", { name: "Generate kit (Alt+S)" }));

    const refusal = await screen.findByTestId("kit-generate-error");
    expect(refusal).toHaveAttribute("data-code", "downtime_kit_duplicate_desk");
    expect(refusal).toHaveTextContent("more than once in this kit");
  });
});
