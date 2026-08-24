import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { todayIst } from "../lib/opd-api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdAdmin } from "./opd-admin";

const NOW_ISO = "2026-08-17T04:00:00.000Z";

const DEPARTMENTS = [
  { id: "dep-1", code: "MED", name: "General medicine", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
  { id: "dep-2", code: "PED", name: "Paediatrics", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];
const ROOMS = [
  { id: "room-1", code: "12", name: "Consulting 12", floor: "1", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];
const DOCTORS = [
  {
    id: "doc-1", userId: "u-9", displayName: "Dr Meera Rao", registrationNo: "NMC-4411", departmentId: "dep-1",
    specialty: "Cardiology", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO,
  },
];
const EXISTING_SCHEDULE = {
  id: "sch-1", doctorId: "doc-1", weekday: 3, startTime: "09:00", endTime: "13:00", roomId: "room-1",
  slotMinutes: 15, validFrom: "2026-01-01", validTo: null, active: true, createdBy: "u-1", createdAt: NOW_ISO,
};
const SCHEDULED_LEAVE = {
  id: "lv-1", doctorId: "doc-1", fromDate: "2026-08-20", toDate: "2026-08-21", reason: "Ward duty",
  status: "scheduled", createdBy: "u-1", createdAt: NOW_ISO, cancelledBy: null, cancelledAt: null,
};

const MASTERS = {
  "GET /api/opd/departments": { items: DEPARTMENTS },
  "GET /api/opd/rooms": { items: ROOMS },
  "GET /api/opd/doctors": { items: DOCTORS },
};

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input).split("?")[0]!,
    method: init?.method ?? "GET",
    body: typeof init?.body === "string" ? init.body : "",
  }));
}
function callsTo(method: string, url: string): { url: string; method: string; body: string }[] {
  return fetchCalls().filter((c) => c.method === method && c.url === url);
}
function bodyOf(method: string, url: string): Record<string, unknown> {
  return JSON.parse(callsTo(method, url)[0]?.body ?? "{}") as Record<string, unknown>;
}

async function openSchedulesTabFor(user: ReturnType<typeof userEvent.setup>, doctorId: string): Promise<void> {
  await user.click(screen.getByRole("tab", { name: "Schedules & leaves" }));
  await user.selectOptions(await screen.findByLabelText("Doctor"), doctorId);
}

describe("OpdAdmin", () => {
  beforeEach(() => {
    setToken(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the departments from GET /opd/departments and posts { code, name } for a new one", async () => {
    stubFetch({ ...MASTERS, "POST /api/opd/departments": { departmentId: "dep-3" } });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();

    expect(await screen.findByText("General medicine")).toBeInTheDocument();
    expect(screen.getByText("Paediatrics")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Code"), "ORT");
    await user.type(screen.getByLabelText("Name"), "Orthopaedics");
    await user.click(screen.getByRole("button", { name: "Add department" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/departments")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/departments")).toEqual({ code: "ORT", name: "Orthopaedics" });
  });

  it("the doctors tab posts the doctor body and renders the server's unknown_user refusal inline", async () => {
    // stubFetch always answers 200 and so cannot produce the 404 this case is about — the direct
    // stub is the only way to see a real non-2xx in this harness (the approvals-inbox precedent).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
        const path = raw.split("?")[0]!;
        const json = (body: unknown, status: number): Response =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
        if (init?.method === "POST" && path === "/api/opd/doctors") {
          return json({ statusCode: 404, message: 'no user named "dr.ramesh"', code: "unknown_user" }, 404);
        }
        if (path === "/api/opd/departments") return json({ items: DEPARTMENTS }, 200);
        if (path === "/api/opd/rooms") return json({ items: ROOMS }, 200);
        if (path === "/api/opd/doctors") return json({ items: DOCTORS }, 200);
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));

    await user.type(await screen.findByLabelText("Username"), "dr.ramesh");
    await user.type(screen.getByLabelText("Display name"), "Dr Ramesh Iyer");
    await user.type(screen.getByLabelText("Registration number"), "NMC-9002");
    await user.selectOptions(screen.getByLabelText("Department"), "dep-2");
    await user.type(screen.getByLabelText("Specialty"), "Paediatrics");
    await user.click(screen.getByRole("button", { name: "Add doctor" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/doctors")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/doctors")).toEqual({
      username: "dr.ramesh", displayName: "Dr Ramesh Iyer", registrationNo: "NMC-9002",
      departmentId: "dep-2", specialty: "Paediatrics",
    });
    // The server's own words, inline — no client-side guess at what went wrong.
    expect(await screen.findByRole("alert")).toHaveTextContent('no user named "dr.ramesh"');
  });

  it("the schedules editor PUTs weekday as a NUMBER and slotMinutes as null when the field is blank", async () => {
    stubFetch({
      ...MASTERS,
      "GET /api/opd/doctors/doc-1/schedules": { items: [EXISTING_SCHEDULE] },
      "GET /api/opd/leaves": { items: [] },
      "PUT /api/opd/doctors/doc-1/schedules": { scheduleIds: ["sch-1", "sch-2"] },
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openSchedulesTabFor(user, "doc-1");

    expect(await screen.findByDisplayValue("09:00")).toBeInTheDocument(); // the loaded template

    await user.click(screen.getByRole("button", { name: "Add row" }));
    const weekdays = screen.getAllByLabelText("Weekday");
    expect(weekdays).toHaveLength(2);
    // The new row defaults to Sunday, so selecting Monday is what puts a 1 on the wire.
    await user.selectOptions(weekdays[1]!, "1");
    await user.type(screen.getAllByLabelText("Start time")[1]!, "14:00");
    await user.type(screen.getAllByLabelText("End time")[1]!, "17:00");
    await user.selectOptions(screen.getAllByLabelText("Room")[1]!, "room-1");
    // Slot minutes deliberately LEFT BLANK — it must reach the server as null, not "" and not 0.
    await user.click(screen.getByRole("button", { name: "Save schedules" }));

    await waitFor(() => expect(callsTo("PUT", "/api/opd/doctors/doc-1/schedules")).toHaveLength(1));
    const body = bodyOf("PUT", "/api/opd/doctors/doc-1/schedules") as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(2);

    const added = body.items[1]!;
    // K41 / §3.19: register() hands back strings; the resolver is what makes this a number.
    expect(typeof added.weekday).toBe("number");
    expect(added.weekday).toBe(1);
    expect(added.slotMinutes).toBeNull();
    expect(added.startTime).toBe("14:00");
    expect(added.endTime).toBe("17:00");

    const kept = body.items[0]!;
    expect(typeof kept.weekday).toBe("number");
    expect(kept.weekday).toBe(3);
    expect(kept.slotMinutes).toBe(15); // a filled slot override is a number too, not "15"
  });

  it("scheduling a leave posts the range, reports the affected appointments, and cancels an existing leave", async () => {
    stubFetch({
      ...MASTERS,
      "GET /api/opd/doctors/doc-1/schedules": { items: [] },
      "GET /api/opd/leaves": { items: [SCHEDULED_LEAVE] },
      "POST /api/opd/leaves": { leaveId: "lv-2", affectedAppointmentIds: ["ap-1", "ap-2"] },
      "POST /api/opd/leaves/lv-1/cancel": { restored: 2 },
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openSchedulesTabFor(user, "doc-1");

    const from = await screen.findByLabelText("From date");
    await user.clear(from);
    await user.type(from, "2026-09-01");
    const to = screen.getByLabelText("To date");
    await user.clear(to);
    await user.type(to, "2026-09-03");
    await user.type(screen.getByLabelText("Reason"), "Conference");
    await user.click(screen.getByRole("button", { name: "Add leave" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/leaves")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/leaves")).toEqual({
      doctorId: "doc-1", fromDate: "2026-09-01", toDate: "2026-09-03", reason: "Conference",
    });
    expect(
      await screen.findByText("Leave scheduled — appointments needing rebooking: 2"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel leave" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/leaves/lv-1/cancel")).toHaveLength(1));
  });
});

describe("todayIst", () => {
  it("maps an instant to its IST calendar date across the +05:30 midnight", () => {
    expect(todayIst(new Date("2026-08-15T18:30:00Z"))).toBe("2026-08-16");
    // One second earlier is still 23:59:59 on the 15th in IST — the boundary, not a rounding accident.
    expect(todayIst(new Date("2026-08-15T18:29:59Z"))).toBe("2026-08-15");
  });
});
