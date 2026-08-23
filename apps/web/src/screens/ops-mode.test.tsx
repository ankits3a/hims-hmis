import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { OpsMode } from "./ops-mode";

/**
 * PLAN 11c T5 — ROUTINE tier (AGENT-RULES §3): tests required and must pass; mutants NOT
 * required, fail-first NOT owed. Assertions are behavioural where this screen DECIDES something
 * (which gate branch renders, which refusal sentence a code maps to) — the plan's own
 * instruction for this task.
 *
 * `stubFetch` (test-utils.tsx) always answers 200, so the refusal tests below use a direct
 * `vi.stubGlobal("fetch", …)` stub instead — the `opd-admin.test.tsx` precedent for a real
 * non-2xx status, copied rather than imported (a test file is self-contained).
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

describe("OpsMode", () => {
  beforeEach(() => {
    setToken("tok-1");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setToken(null);
    localStorage.clear();
  });

  it("renders the current mode, its since instant and its note from GET /ops/mode", async () => {
    mockRoutes({
      "GET /ops/mode": {
        status: 200,
        body: { mode: "degraded", since: "2026-08-23T02:00:00.000Z", note: "printer offline at desk 3", reportId: null },
      },
      "GET /ops/config-validation/latest": { status: 200, body: { report: null } },
    });
    renderWithProviders(<OpsMode />);

    expect(await screen.findByTestId("mode-current-word")).toHaveTextContent("Degraded");
    expect(screen.getByTestId("mode-current-since")).toHaveTextContent("2026-08-23T02:00:00.000Z");
    expect(screen.getByTestId("mode-current-note")).toHaveTextContent("printer offline at desk 3");
  });

  it("renders the no-report gate state when nothing has been validated yet", async () => {
    mockRoutes({
      "GET /ops/mode": { status: 200, body: { mode: "commissioning", since: null, note: null, reportId: null } },
      "GET /ops/config-validation/latest": { status: 200, body: { report: null } },
    });
    renderWithProviders(<OpsMode />);
    expect(await screen.findByTestId("mode-gate-none")).toBeInTheDocument();
    expect(screen.queryByTestId("mode-gate-verdict")).not.toBeInTheDocument();
  });

  it("renders the gate verdict and a scope's errors when a report exists", async () => {
    mockRoutes({
      "GET /ops/mode": { status: 200, body: { mode: "commissioning", since: null, note: null, reportId: null } },
      "GET /ops/config-validation/latest": {
        status: 200,
        body: {
          report: {
            id: "rep-1",
            ok: false,
            at: "2026-08-23T01:00:00.000Z",
            scopes: [
              { scope: "tariff", ok: false, caSigned: false, errors: [{ code: "ops.ca_signature_missing", detail: "not signed" }] },
              { scope: "billing", ok: true, caSigned: null, errors: [] },
            ],
          },
        },
      },
    });
    renderWithProviders(<OpsMode />);

    expect(await screen.findByTestId("mode-gate-verdict")).toHaveTextContent("2026-08-23T01:00:00.000Z");
    expect(screen.getByTestId("mode-gate-scope-tariff")).toHaveTextContent("ops.ca_signature_missing: not signed");
    expect(screen.getByTestId("mode-gate-scope-billing")).not.toHaveTextContent("ops.ca_signature_missing");
  });

  it("Run validation POSTs /ops/config-validation with no body and the gate re-reads afterwards", async () => {
    let ran = false;
    mockRoutes({
      "GET /ops/mode": { status: 200, body: { mode: "commissioning", since: null, note: null, reportId: null } },
      "GET /ops/config-validation/latest": () => ({
        status: 200,
        body: { report: ran ? { id: "rep-1", ok: true, at: "2026-08-23T01:00:00.000Z", scopes: [] } : null },
      }),
      "POST /ops/config-validation": () => {
        ran = true;
        return { status: 201, body: { reportId: "rep-1", ok: true, at: "2026-08-23T01:00:00.000Z", scopes: [], eventId: "ev-1" } };
      },
    });
    renderWithProviders(<OpsMode />);
    await screen.findByTestId("mode-gate-none");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run validation" }));

    await waitFor(() => expect(callsTo("POST", "/ops/config-validation")).toHaveLength(1));
    expect(await screen.findByTestId("mode-gate-verdict")).toBeInTheDocument();
  });

  it("the change form posts { to, note } to POST /ops/mode and the current mode updates on success", async () => {
    let current: { mode: "commissioning" | "downtime"; since: string | null; note: string | null; reportId: string | null } = {
      mode: "commissioning", since: null, note: null, reportId: null,
    };
    mockRoutes({
      "GET /ops/mode": () => ({ status: 200, body: current }),
      "GET /ops/config-validation/latest": { status: 200, body: { report: null } },
      "POST /ops/mode": () => {
        current = { mode: "downtime", since: "2026-08-23T03:00:00.000Z", note: "power cut, generator starting", reportId: null };
        return { status: 201, body: { id: "chg-1", from: "commissioning", to: "downtime", note: "power cut, generator starting", reportId: null } };
      },
    });
    renderWithProviders(<OpsMode />);
    await screen.findByTestId("mode-current-word");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("New mode"), "downtime");
    await user.type(screen.getByLabelText("Note"), "power cut, generator starting");
    await user.click(screen.getByRole("button", { name: "Change mode (Alt+S)" }));

    await waitFor(() => expect(callsTo("POST", "/ops/mode")).toHaveLength(1));
    expect(callsTo("POST", "/ops/mode")[0]!.body).toEqual({ to: "downtime", note: "power cut, generator starting" });
    expect(await screen.findByText("Mode changed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("mode-current-word")).toHaveTextContent("Downtime"));
  });

  it("a golive_gate_unsatisfied refusal renders BOTH the code's sentence and the detail's sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const path = raw.split("?")[0]!;
        const json = (body: unknown, status: number): Response =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (init?.method === "POST" && path === "/ops/mode") {
          return json(
            { code: "golive_gate_unsatisfied", detail: "stale_report", message: "golive_gate_unsatisfied: stale_report" },
            409,
          );
        }
        if (path === "/ops/mode") return json({ mode: "commissioning", since: null, note: null, reportId: null }, 200);
        if (path === "/ops/config-validation/latest") return json({ report: null }, 200);
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpsMode />);
    await screen.findByTestId("mode-current-word");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("New mode"), "normal");
    await user.click(screen.getByRole("button", { name: "Change mode (Alt+S)" }));

    const refusal = await screen.findByTestId("mode-change-error");
    expect(refusal).toHaveAttribute("data-code", "golive_gate_unsatisfied");
    expect(refusal).toHaveTextContent("go-live gate is not satisfied");
    expect(refusal).toHaveTextContent("more than 24 hours old");
  });

  it("a refusal with no machine code (a 403) falls back to the server's raw message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const path = raw.split("?")[0]!;
        const json = (body: unknown, status: number): Response =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (init?.method === "POST" && path === "/ops/mode") {
          return json({ statusCode: 403, message: "missing permission ops.mode.set", error: "Forbidden" }, 403);
        }
        if (path === "/ops/mode") return json({ mode: "commissioning", since: null, note: null, reportId: null }, 200);
        if (path === "/ops/config-validation/latest") return json({ report: null }, 200);
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpsMode />);
    await screen.findByTestId("mode-current-word");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("New mode"), "normal");
    await user.click(screen.getByRole("button", { name: "Change mode (Alt+S)" }));

    const refusal = await screen.findByTestId("mode-change-error");
    expect(refusal).toHaveAttribute("data-code", "");
    expect(refusal).toHaveTextContent("missing permission ops.mode.set");
  });
});
