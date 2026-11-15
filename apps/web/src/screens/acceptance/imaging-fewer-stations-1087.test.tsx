import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { AuthProvider } from "../../lib/auth";
import { setToken } from "../../lib/api";
import { router } from "../../router";
import { renderWithProviders } from "../../test-utils";
import { RadiologyReception } from "../radiology-reception";
import { RadiologyReading } from "../radiology-reading";

/**
 * ACCEPTANCE — issue #1087, spec docs/specs/1087-imaging-fewer-stations.md (owner APPROVED 2026-11-14), the
 * web half: the switch offers fewer stations; the diary and the portable round are header views of the
 * Desk and Rooms; the worklist address sends each person to their own list; the override asks are decided
 * in the reading room; the legacy report address opens that study in the reading room.
 *
 * The address checks mount the APPLICATION's router (not a stub route), because what is under test is
 * where an old address lands and what is drawn there.
 */
type Reply = { status: number; body: unknown };
const calls: { key: string; body: unknown }[] = [];
function mockRoutes(hospital: string[], handlers: Record<string, Reply> = {}): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = `${init?.method ?? "GET"} ${raw.split("?")[0]!}`;
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body });
    if (key === "GET /api/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-1" }, permissions: { hospital, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reply = handlers[key];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
}

/**
 * The application's route tree at `path`, under the providers `App.tsx` mounts. Each check gets its own
 * router over the SAME tree (`router.routeTree`): the exported router is one object, and a router that
 * was mounted once keeps the first mount's transition hooks after it unmounts.
 */
let app: typeof router;
function openAt(path: string, hospital: string[], handlers: Record<string, Reply> = {}): void {
  window.scrollTo = (): void => {};
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
  mockRoutes(hospital, handlers);
  setToken("t-1");
  app = createRouter({ routeTree: router.routeTree, history: createMemoryHistory({ initialEntries: [path] }) }) as unknown as typeof router;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <RouterProvider router={app} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** `seed-roles.ts`'s `radiology_receptionist`, as granted. */
const RECEPTIONIST = [
  "radiology.orders.place", "radiology.schedule", "radiology.checkin", "radiology.display.read", "radiology.worklist.read",
  "radiology.bill_decisions.manage", "radiology.definitions.read", "orders.place", "orders.read", "patients.register",
  "patients.read", "billing.invoice.issue", "billing.invoice.read", "billing.receipt.record", "billing.session.own",
];
/** `seed-roles.ts`'s `radiographer`. */
const RADIOGRAPHER = [
  "radiology.worklist.read", "radiology.checkin", "radiology.gates.satisfy", "radiology.acquire", "radiology.contrast.record",
  "radiology.reports.read", "radiology.definitions.read", "pcpndt.form_f.read", "radiology.mwl.read", "radiology.pacs.reconcile",
  "aerb.doses.read",
];
/** `seed-roles.ts`'s `radiology_resident`: a reporter who acquires nothing. */
const REPORTER = [
  "radiology.worklist.read", "radiology.reports.write", "radiology.reports.sign", "radiology.reports.read",
  "radiology.criticals.ack", "radiology.definitions.read",
];
/** A ULID-shaped study id: the reading room's `?study=` takes nothing else. */
const STUDY = "01J9Z8X7W6V5T4S3R2Q1P0N9M8";

beforeEach(() => { calls.length = 0; });
afterEach(() => { setToken(null); vi.unstubAllGlobals(); });

it("spec #1087 D1: the station switch for a receptionist's grants shows Desk and Hand-over, and no Worklist, Diary or Display", async () => {
  mockRoutes(RECEPTIONIST);
  setToken("t");
  renderWithProviders(<RadiologyReception />);
  const sw = within(await screen.findByRole("navigation", { name: "Stations" }));
  await waitFor(() => expect(sw.getByRole("link", { name: "Report hand-over" })).toBeInTheDocument());
  expect(sw.getAllByRole("link").map((a) => a.textContent)).toEqual(["Imaging reception", "Report hand-over"]);
  expect(sw.queryByRole("link", { name: "Imaging worklist" })).toBeNull();
  expect(sw.queryByRole("link", { name: "Imaging diary" })).toBeNull();
  expect(sw.queryByRole("link", { name: "Imaging hall display" })).toBeNull();
});

it("spec #1087 D2: the diary address renders the Desk with the diary view selected", async () => {
  openAt("/radiology/diary", RECEPTIONIST);
  await waitFor(() => expect(app.state.location.pathname).toBe("/radiology/reception"));
  expect(app.state.location.search).toEqual({ view: "diary" });
  const shell = await screen.findByTestId("station-shell");
  expect(shell).toHaveAttribute("data-station", "desk");
  expect(await screen.findByTestId("desk-view-diary")).toHaveAttribute("aria-current", "page");
  expect(screen.getByTestId("desk-view-counter")).not.toHaveAttribute("aria-current");
  expect(screen.getByTestId("diary-grid")).toBeInTheDocument();
});

it("spec #1087 D3: the portable address renders Rooms with the portable view selected", async () => {
  openAt("/radiology/portable", RADIOGRAPHER, {
    "GET /api/radiology/portable/round": { status: 200, body: { rows: [] } },
  });
  await waitFor(() => expect(app.state.location.pathname).toBe("/radiology/room"));
  expect(app.state.location.search).toEqual({ view: "portable" });
  const shell = await screen.findByTestId("station-shell");
  expect(shell).toHaveAttribute("data-station", "room");
  expect(await screen.findByTestId("room-view-portable")).toHaveAttribute("aria-current", "page");
  expect(screen.getByTestId("room-view-console")).not.toHaveAttribute("aria-current");
  expect(screen.getByTestId("portable-round")).toBeInTheDocument();
});

it("spec #1087 D4: the worklist address lands a radiographer on Rooms and a reporter on Reading", async () => {
  openAt("/radiology/worklist", RADIOGRAPHER);
  await waitFor(() => expect(app.state.location.pathname).toBe("/radiology/room"));
  expect(await screen.findByTestId("station-shell")).toHaveAttribute("data-station", "room");
  cleanup();
  vi.unstubAllGlobals();

  openAt("/radiology/worklist", REPORTER, {
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [] } },
  });
  await waitFor(() => expect(app.state.location.pathname).toBe("/radiology/read"));
  expect(await screen.findByTestId("station-shell")).toHaveAttribute("data-station", "read");
});

const ASK = (approvalId: string, studyId: string, patientName: string) => ({
  approvalId, status: "pending", studyId, accessionNo: `R-${studyId}`, studyTypeCode: "CT-ABD",
  patientId: `P-${studyId}`, patientName, kind: "renal_function", gateState: "open",
  note: "eGFR 28 yesterday; the surgeon needs the scan tonight", requesterId: "u-nurse", requesterName: "Nurse Rekha",
  requestedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
});

it("spec #1087 D6: the reading room shows an override request with grant and refuse controls that call the decide route", async () => {
  const user = userEvent.setup();
  mockRoutes(["radiology.reports.write", "radiology.gates.override"], {
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [] } },
    "GET /api/radiology/gate-override-requests": { status: 200, body: { requests: [ASK("A1", "S1", "Asha Devi"), ASK("A2", "S2", "Ravi Kumar")] } },
    "POST /api/radiology/gate-override-requests/A1/decide": { status: 201, body: { verdict: "rejected", override: null, study: null, note: null } },
    "POST /api/radiology/gate-override-requests/A2/decide": { status: 201, body: { verdict: "granted", override: { kind: "renal_function", state: "overridden" }, study: { state: "ready", open: [] }, note: null } },
  });
  setToken("t");
  renderWithProviders(<RadiologyReading studyId={null} />);
  await user.click(await screen.findByTestId("read-view-asks"));

  await user.click(await screen.findByTestId("override-ask-A1"));
  await user.type(screen.getByTestId("ask-reason"), "Wait for the repeat creatinine");
  await user.click(screen.getByTestId("ask-refuse"));
  await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/radiology/gate-override-requests/A1/decide")).toHaveLength(1));
  expect(calls.find((c) => c.key === "POST /api/radiology/gate-override-requests/A1/decide")!.body)
    .toEqual({ verdict: "refuse", reason: "Wait for the repeat creatinine" });

  await user.click(await screen.findByTestId("override-ask-A2"));
  await user.type(screen.getByTestId("ask-reason"), "Benefit outweighs risk; hydrate before and after");
  await user.click(screen.getByTestId("ask-grant"));
  await waitFor(() => expect(calls.filter((c) => c.key === "POST /api/radiology/gate-override-requests/A2/decide")).toHaveLength(1));
  expect(calls.find((c) => c.key === "POST /api/radiology/gate-override-requests/A2/decide")!.body)
    .toEqual({ verdict: "grant", reason: "Benefit outweighs risk; hydrate before and after" });
});

it("spec #1087 D7: the legacy report address opens that study in the reading room", async () => {
  openAt(`/radiology/studies/${STUDY}/report`, REPORTER, {
    "GET /api/radiology/reading/worklist": { status: 200, body: { rows: [] } },
  });
  await waitFor(() => expect(app.state.location.pathname).toBe("/radiology/read"));
  expect(app.state.location.search).toEqual({ study: STUDY });
  expect(await screen.findByTestId("station-shell")).toHaveAttribute("data-station", "read");
  await waitFor(() => expect(calls.map((c) => c.key)).toContain(`GET /api/radiology/reading/studies/${STUDY}`));
});
