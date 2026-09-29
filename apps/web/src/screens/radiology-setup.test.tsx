import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RadiologySetup } from "./radiology-setup";

/**
 * PLAN 18-S RS4 T4 — the Setup station. Machines (register, edit, status with a reason and the
 * studies to move), Books (the governed flow, linked to the approvals inbox, no second approval
 * system) and Prices (read-only, the ruled price beside the tariff's).
 */
type Reply = { status: number; body: unknown };
type Call = { method: string; path: string; body: unknown };

function mockRoutes(handlers: Record<string, Reply>, permissions: string[] = ["radiology.devices.manage"]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (path === "/api/auth/me") {
      return new Response(JSON.stringify({
        actor: { type: "user", id: "U1" },
        permissions: { hospital: permissions, scoped: { department: {}, floor: {} } },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reply = handlers[`${method} ${path}`];
    if (reply === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const device = (over: Record<string, unknown>) => ({
  id: "D1", code: "CT-1", name: "CT scanner", modality: "ct", room: null, roomId: null, aeTitle: null,
  portable: false, status: "available", ionising: true, licensedNow: true, ...over,
});

const devicesReply = (devices: unknown[]): Reply => ({
  status: 200, body: { devices, rooms: [{ id: "R1", code: "RAD-R1", name: "CT room 1" }] },
});

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("machines", () => {
  it("lists the register on the right and registers a machine with its AE title and room", async () => {
    const calls = mockRoutes({
      "GET /api/radiology/setup/devices": devicesReply([device({}), device({ id: "D2", code: "XR-9", name: "Old X-ray", modality: "xray", status: "retired" })]),
      "POST /api/radiology/setup/devices": { status: 201, body: { deviceResourceId: "D3" } },
    });
    renderWithProviders(<RadiologySetup view="machines" />);
    const right = within(await screen.findByTestId("station-right"));
    expect(await right.findByTestId("machine-CT-1")).toHaveTextContent("no AE title");
    expect(right.getByTestId("machine-XR-9")).toHaveTextContent("Retired");

    await userEvent.type(screen.getByTestId("machine-code"), "CT-2");
    await userEvent.type(screen.getByTestId("machine-name"), "CT scanner 2");
    await userEvent.selectOptions(screen.getByTestId("machine-modality"), "ct");
    await userEvent.selectOptions(screen.getByTestId("machine-room"), "R1");
    await userEvent.type(screen.getByTestId("machine-ae"), "CT_2");
    await userEvent.click(screen.getByTestId("machine-save"));
    await waitFor(() => {
      expect(calls.find((c) => c.method === "POST" && c.path === "/api/radiology/setup/devices")?.body).toEqual({
        code: "CT-2", name: "CT scanner 2", modality: "ct", roomId: "R1", aeTitle: "CT_2", portable: false,
      });
    });
  });

  it("shows the server's AE-title refusal in its own words", async () => {
    mockRoutes({
      "GET /api/radiology/setup/devices": devicesReply([]),
      "POST /api/radiology/setup/devices": {
        status: 422, body: { statusCode: 422, code: "invalid_ae_title", message: "\"ct 2\" is not a DICOM AE title this department uses" },
      },
    });
    renderWithProviders(<RadiologySetup view="machines" />);
    await userEvent.type(await screen.findByTestId("machine-code"), "CT-2");
    await userEvent.type(screen.getByTestId("machine-name"), "CT 2");
    await userEvent.type(screen.getByTestId("machine-ae"), "ct 2");
    await userEvent.click(screen.getByTestId("machine-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid_ae_title");
  });

  it("will not set a status without a reason, and lists the studies to move with a link to the diary", async () => {
    const calls = mockRoutes({
      "GET /api/radiology/setup/devices": devicesReply([device({})]),
      "POST /api/radiology/setup/devices/D1/status": {
        status: 201,
        body: {
          from: "available", to: "down",
          studiesToMove: [{ studyId: "S1", accessionNo: "X2608310001", studyTypeCode: "CT-HEAD", status: "scheduled", scheduledAt: "2026-08-31T04:30:00.000Z" }],
        },
      },
    });
    renderWithProviders(<RadiologySetup view="machines" />);
    await userEvent.click(await screen.findByTestId("machine-CT-1"));
    await userEvent.selectOptions(screen.getByTestId("status-select"), "down");
    expect(screen.getByTestId("status-save")).toBeDisabled();
    await userEvent.type(screen.getByTestId("status-reason"), "tube failed");
    await userEvent.click(screen.getByTestId("status-save"));
    const moved = within(await screen.findByTestId("studies-to-move"));
    expect(moved.getByText(/X2608310001/)).toBeInTheDocument();
    expect(moved.getByTestId("to-diary")).toHaveAttribute("href", "/radiology/diary");
    expect(calls.find((c) => c.path === "/api/radiology/setup/devices/D1/status")?.body).toEqual({ status: "down", reason: "tube failed" });
  });

  it("does not offer a modality change on an existing machine", async () => {
    mockRoutes({ "GET /api/radiology/setup/devices": devicesReply([device({})]) });
    renderWithProviders(<RadiologySetup view="machines" />);
    await userEvent.click(await screen.findByTestId("machine-CT-1"));
    expect(screen.getByTestId("machine-modality")).toBeDisabled();
  });
});

describe("books", () => {
  const v = (over: Record<string, unknown>) => ({
    definitionId: "DEF1", version: 1, status: "active", draftedBy: "seed:radiology", createdAt: "2026-08-31T00:00:00.000Z",
    publishedBy: "seed:radiology", publishedAt: "2026-08-31T00:00:00.000Z", approvalId: null, approvalStatus: null,
    approvedBy: null, seeded: true, ...over,
  });
  const books = (drafts: unknown[]) => ({
    status: 200,
    body: {
      books: [
        { kind: "study_types", active: v({}), drafts },
        { kind: "pacs_settings", active: null, drafts: [] },
      ],
    },
  });

  it("names who set up the book, and sends a pending draft to the approvals inbox", async () => {
    mockRoutes({
      "GET /api/radiology/setup/books": books([v({ definitionId: "DEF2", version: 2, status: "draft", draftedBy: "Dr Rao", seeded: false, approvalId: "AP1", approvalStatus: "pending", publishedBy: null, publishedAt: null })]),
    }, ["radiology.devices.manage", "radiology.definitions.manage"]);
    renderWithProviders(<RadiologySetup view="books" />);
    const detail = within(await screen.findByTestId("book-detail"));
    expect(detail.getByText(/Set up by the seed/)).toBeInTheDocument();
    expect(detail.getByTestId("to-approvals")).toHaveAttribute("href", "/approvals?focus=AP1");
    expect(detail.queryByTestId("book-publish")).toBeNull();
  });

  it("publishes a granted draft through the existing route", async () => {
    const calls = mockRoutes({
      "GET /api/radiology/setup/books": books([v({ definitionId: "DEF2", version: 2, status: "draft", seeded: false, approvalId: "AP1", approvalStatus: "granted", approvedBy: "Dr Iyer", publishedBy: null, publishedAt: null })]),
      "POST /api/radiology/definitions/publish": { status: 201, body: { kind: "study_types", version: 2, supersededVersion: 1 } },
    }, ["radiology.devices.manage", "radiology.definitions.manage"]);
    renderWithProviders(<RadiologySetup view="books" />);
    await userEvent.click(await screen.findByTestId("book-publish"));
    await waitFor(() => {
      expect(calls.find((c) => c.path === "/api/radiology/definitions/publish")?.body).toEqual({ definitionId: "DEF2", approvalId: "AP1" });
    });
  });

  it("drafts a new version from the one in force, and is read-only without the definitions grant", async () => {
    const calls = mockRoutes({
      "GET /api/radiology/setup/books": books([]),
      "GET /api/radiology/definitions/study_types/active": { status: 200, body: { definitionId: "DEF1", kind: "study_types", version: 1, body: { types: [] } } },
      "POST /api/radiology/definitions/draft": { status: 201, body: { definitionId: "DEF3", version: 2, approvalId: "AP9" } },
    }, ["radiology.devices.manage", "radiology.definitions.manage"]);
    const { unmount } = renderWithProviders(<RadiologySetup view="books" />);
    await userEvent.click(await screen.findByTestId("book-draft-open"));
    expect(await screen.findByTestId("book-draft-body")).toHaveValue(JSON.stringify({ types: [] }, null, 2));
    await userEvent.click(screen.getByTestId("book-draft-submit"));
    await waitFor(() => {
      expect(calls.find((c) => c.path === "/api/radiology/definitions/draft")?.body).toEqual({ kind: "study_types", body: { types: [] } });
    });
    unmount();

    mockRoutes({ "GET /api/radiology/setup/books": books([]) });
    renderWithProviders(<RadiologySetup view="books" />);
    expect(await screen.findByText(/needs the radiology definitions grant/)).toBeInTheDocument();
    expect(screen.queryByTestId("book-draft-open")).toBeNull();
  });
});

describe("prices", () => {
  it("is read-only, flags a missing GST category, and shows the ruled film price beside the tariff", async () => {
    mockRoutes({
      "GET /api/radiology/setup/prices": {
        status: 200,
        body: {
          services: [
            { serviceId: "S1", code: "RAD-CT-HEAD", name: "CT head", category: "investigation", active: true, gst: null, pricePaise: 250000, ruledPricePaise: null },
            { serviceId: "S2", code: "RAD-FILM", name: "Imaging film, per sheet", category: "investigation", active: true, gst: { sacCode: "9993", exempt: true, rateBps: 0 }, pricePaise: null, ruledPricePaise: 25000 },
          ],
        },
      },
    });
    renderWithProviders(<RadiologySetup view="prices" />);
    expect(await screen.findByTestId("prices-note")).toHaveTextContent(/no tariff screen yet/);
    const right = within(screen.getByTestId("station-right"));
    expect(await right.findByTestId("price-RAD-CT-HEAD")).toHaveTextContent("no GST category");
    await userEvent.click(right.getByTestId("price-RAD-FILM"));
    const detail = within(screen.getByTestId("price-detail"));
    expect(detail.getByText("₹250")).toBeInTheDocument();
    expect(detail.getByText("Not in the active tariff")).toBeInTheDocument();
    expect(detail.getByText(/Exempt · SAC 9993/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
