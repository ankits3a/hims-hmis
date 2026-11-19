import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
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

/** #1127 — the Doctors tab reads its own list: the doctor row plus login, Doctor ID and this week's schedule. */
const ADMIN_DOCTORS = DOCTORS.map((d) => ({ ...d, code: "DR-0001", username: "meera", scheduledThisWeek: true, secondary: null }));

const MASTERS = {
  "GET /api/opd/departments": { items: DEPARTMENTS },
  "GET /api/opd/rooms": { items: ROOMS },
  "GET /api/opd/doctors": { items: DOCTORS },
  "GET /api/opd/doctors/admin": { items: ADMIN_DOCTORS },
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

  /**
   * ═══ THE COMPLAINT VOCABULARY'S CURATION LOOP ═══
   *
   * Owner, 2026-09-14, asked whether phrasings of one meaning are mapped and whether the system
   * learns the doctor's words. Both do; this tab is where the second feeds the first — the phrases
   * doctors actually wrote that the co-pilot does not recognise, most used first.
   *
   * The proposer fills the form in. It never submits it: a mapping changes what the co-pilot
   * considers for every doctor afterwards, and `chest_tightness` reaching asthma while `chest_pain`
   * reaches nothing is a clinical distinction a person signs for.
   */
  const VOCAB = {
    "GET /api/opd/vocabulary/unmapped": { items: [
      { term: "chaati me dard", uses: 12, lastUsedAt: NOW_ISO },
      { term: "ghabrahat", uses: 3, lastUsedAt: NOW_ISO },
    ] },
    "GET /api/opd/vocabulary/concepts": { items: [
      { key: "chest_pain", label: "Chest pain" },
      { key: "cough", label: "Cough" },
    ] },
    "GET /api/opd/vocabulary/propose": { items: [
      { conceptKey: "chest_pain", label: "Chest pain", score: 0.78, because: "shares a word" },
    ] },
    "POST /api/opd/vocabulary/map": { termId: "ct-new" },
    "POST /api/opd/vocabulary/concepts": { key: "giddiness" },
  };

  async function openVocab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole("tab", { name: "Complaint words" }));
  }

  it("the vocabulary tab lists what the hospital typed and nobody has mapped, most used first", async () => {
    stubFetch({ ...MASTERS, ...VOCAB });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openVocab(user);

    /*
      Ordered by the server; the screen does not re-sort, so one order exists everywhere. The
      assertion is on the MAP BUTTONS rather than the rows, because `DeskTR` renders only its
      children and would drop a `data-testid` on the row without saying so.
    */
    await screen.findByTestId("vocab-map-chaati me dard");
    const buttons = screen.getAllByTestId(/^vocab-map-/);
    expect(buttons.map((b) => b.getAttribute("data-testid"))).toEqual([
      "vocab-map-chaati me dard", "vocab-map-ghabrahat",
    ]);
    /* The count is what makes this a worklist rather than a list: 12 uses, so it is worth mapping. */
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("a proposal FILLS the form and the curator is the one who submits it", async () => {
    stubFetch({ ...MASTERS, ...VOCAB });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openVocab(user);

    await user.click(await screen.findByTestId("vocab-map-chaati me dard"));
    await user.click(await screen.findByTestId("vocab-proposal-chest_pain"));

    /* Tapping the proposal has posted NOTHING — it only chose the meaning in the form. */
    expect(callsTo("POST", "/api/opd/vocabulary/map")).toHaveLength(0);
    expect(screen.getByLabelText("Existing meaning")).toHaveValue("chest_pain");

    await user.click(screen.getByTestId("vocab-confirm"));
    await waitFor(() => { expect(callsTo("POST", "/api/opd/vocabulary/map")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/vocabulary/map")).toEqual({
      term: "chaati me dard", conceptKey: "chest_pain", script: "hinglish",
    });
  });

  it("the script defaults to Devanagari for a Devanagari phrase, and Hinglish otherwise", async () => {
    /* The one of the three that IS detectable. The other two look alike to a machine, so the
       default is what a curator on this screen types most and they change it when it is wrong. */
    stubFetch({
      ...MASTERS, ...VOCAB,
      "GET /api/opd/vocabulary/unmapped": { items: [{ term: "सीने में जकड़न", uses: 4, lastUsedAt: NOW_ISO }] },
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openVocab(user);

    await user.click(await screen.findByTestId("vocab-map-सीने में जकड़न"));
    expect(screen.getByLabelText("Script")).toHaveValue("hi");
  });

  it("a phrase that fits no existing meaning gets a NEW one, created before it is mapped", async () => {
    stubFetch({ ...MASTERS, ...VOCAB });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openVocab(user);

    await user.click(await screen.findByTestId("vocab-map-ghabrahat"));
    await user.type(screen.getByLabelText("New meaning"), "Giddiness");
    await user.click(screen.getByTestId("vocab-confirm"));

    /* The concept first, then the mapping onto the key the server derived — the curator never
       types an identifier, so two people cannot invent two keys for one meaning. */
    await waitFor(() => { expect(callsTo("POST", "/api/opd/vocabulary/concepts")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/vocabulary/concepts")).toEqual({ label: "Giddiness" });
    await waitFor(() => { expect(callsTo("POST", "/api/opd/vocabulary/map")).toHaveLength(1); });
    expect(bodyOf("POST", "/api/opd/vocabulary/map")).toMatchObject({ term: "ghabrahat", conceptKey: "giddiness" });
  });

  it("choosing neither a meaning nor a new label maps nothing, and says why", async () => {
    stubFetch({ ...MASTERS, ...VOCAB });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openVocab(user);

    await user.click(await screen.findByTestId("vocab-map-ghabrahat"));
    await user.click(screen.getByTestId("vocab-confirm"));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Choose a meaning/);
    expect(callsTo("POST", "/api/opd/vocabulary/map")).toHaveLength(0);
  });

  it("an empty worklist says the vocabulary is complete rather than rendering a bare table", async () => {
    stubFetch({ ...MASTERS, ...VOCAB, "GET /api/opd/vocabulary/unmapped": { items: [] } });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openVocab(user);

    expect(await screen.findByTestId("vocab-empty")).toBeInTheDocument();
    expect(screen.queryByTestId(/^vocab-map-/)).toBeNull();
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

  it("the doctors tab posts the picked staff member and renders the server's unknown_user refusal in the panel", async () => {
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
        if (path === "/api/opd/doctors/admin") return json({ items: ADMIN_DOCTORS }, 200);
        if (path === "/api/opd/doctors/candidates") {
          return json({ items: [{ userId: "u-12", username: "dr.ramesh", fullName: "Ramesh Iyer", staffCode: "EMP-0012", isDoctorRole: true }] }, 200);
        }
        return new Response("{}", { status: 404 });
      }),
    );
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    await user.click(await screen.findByTestId("doctors-new"));
    const panel = await screen.findByTestId("doctor-new-panel");

    await user.type(within(panel).getByTestId("doctor-new-search"), "ram");
    await user.click(await within(panel).findByTestId("doctor-candidate-dr.ramesh"));
    await user.type(within(panel).getByLabelText("Registration number"), "NMC-9002");
    await user.selectOptions(within(panel).getByLabelText("Department"), "dep-2");
    await user.type(within(panel).getByLabelText("Specialty"), "Paediatrics");
    await user.click(within(panel).getByRole("button", { name: "Add doctor" }));

    await waitFor(() => expect(callsTo("POST", "/api/opd/doctors")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/doctors")).toEqual({
      username: "dr.ramesh", displayName: "Dr. Ramesh Iyer", registrationNo: "NMC-9002",
      departmentId: "dep-2", specialty: "Paediatrics",
    });
    // The server's own words, in the panel where the admin is looking — no client-side guess.
    expect(await within(panel).findByRole("alert")).toHaveTextContent('no user named "dr.ramesh"');
  });

  it("2026-10-04 — the doctors tab sends a Designation with a new doctor, and edits one in the panel (blank clears it)", async () => {
    stubFetch({
      ...MASTERS,
      "GET /api/opd/doctors/candidates": { items: [{ userId: "u-30", username: "raza", fullName: "S.I Raza", staffCode: "EMP-0030", isDoctorRole: true }] },
      "POST /api/opd/doctors": { doctorId: "doc-9", userId: "u-30" },
      "PATCH /api/opd/doctors/doc-1": { ok: true, needsRebooking: [], waitingToday: 0 },
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    await user.click(await screen.findByTestId("doctors-new"));
    const fresh = await screen.findByTestId("doctor-new-panel");
    await user.type(within(fresh).getByTestId("doctor-new-search"), "raza");
    await user.click(await within(fresh).findByTestId("doctor-candidate-raza"));
    await user.selectOptions(within(fresh).getByLabelText("Department"), "dep-2");
    await user.type(within(fresh).getByLabelText("Designation"), "Guest Faculty");
    await user.click(within(fresh).getByTestId("doctor-new-submit"));
    await waitFor(() => expect(callsTo("POST", "/api/opd/doctors")).toHaveLength(1));
    expect(bodyOf("POST", "/api/opd/doctors")).toMatchObject({ displayName: "Dr. S.I Raza", designation: "Guest Faculty" });

    await user.click(await screen.findByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    const box = within(panel).getByLabelText("Designation");
    await user.type(box, "Senior Resident");
    await user.click(within(panel).getByTestId("doctor-save"));
    await waitFor(() => expect(callsTo("PATCH", "/api/opd/doctors/doc-1")).toHaveLength(1));
    expect(bodyOf("PATCH", "/api/opd/doctors/doc-1")).toEqual({ designation: "Senior Resident" });
  });

  it("2026-10-04 — a designation cleared in the panel is sent as null", async () => {
    const titled = [{ ...ADMIN_DOCTORS[0]!, designation: "Guest Faculty" }];
    stubFetch({ ...MASTERS, "GET /api/opd/doctors/admin": { items: titled }, "PATCH /api/opd/doctors/doc-1": { ok: true, needsRebooking: [], waitingToday: 0 } });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    await user.click(await screen.findByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    await user.clear(within(panel).getByLabelText("Designation"));
    await user.click(within(panel).getByTestId("doctor-save"));
    await waitFor(() => expect(callsTo("PATCH", "/api/opd/doctors/doc-1")).toHaveLength(1));
    expect(bodyOf("PATCH", "/api/opd/doctors/doc-1")).toEqual({ designation: null });
  });

  it("#914 — the doctors panel gives a doctor a second department", async () => {
    stubFetch({ ...MASTERS, "PUT /api/opd/doctors/doc-1/secondary-department": { id: "sec-1" } });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    await user.click(await screen.findByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    const pick = within(panel).getByTestId("doctor-secondary-pick");
    // The primary is not offered as the second department.
    expect([...(pick as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "dep-2"]);
    await user.selectOptions(pick, "dep-2");
    await user.click(within(panel).getByTestId("doctor-secondary-start"));
    await waitFor(() => expect(callsTo("PUT", "/api/opd/doctors/doc-1/secondary-department")).toHaveLength(1));
    expect(bodyOf("PUT", "/api/opd/doctors/doc-1/secondary-department")).toEqual({ departmentId: "dep-2" });
  });

  it("#914 — a covering doctor's second department shows with its day, and End asks before it ends", async () => {
    const covering = [{ ...ADMIN_DOCTORS[0]!, secondary: { departmentId: "dep-2", fromDate: "2026-10-17", toDate: null } }];
    stubFetch({
      ...MASTERS, "GET /api/opd/doctors/admin": { items: covering },
      "POST /api/opd/doctors/doc-1/secondary-department/end": { secondary: {}, affectedAppointmentIds: ["a-1", "a-2"] },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    await user.click(await screen.findByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    expect(within(panel).getByText(/since .*17 Oct/)).toBeInTheDocument();
    expect(within(panel).queryByTestId("doctor-secondary-pick")).toBeNull(); // no picker while one runs

    await user.click(within(panel).getByTestId("doctor-secondary-end"));
    expect(callsTo("POST", "/api/opd/doctors/doc-1/secondary-department/end")).toHaveLength(0); // declined
    await user.click(within(panel).getByTestId("doctor-secondary-end"));
    await waitFor(() => expect(callsTo("POST", "/api/opd/doctors/doc-1/secondary-department/end")).toHaveLength(1));
    expect(await screen.findByText("Ended. 2 bookings need rebooking.")).toBeInTheDocument();
    confirm.mockRestore();
  });

  /*
    #1127 browser walk, 2026-11-19 — Escape on the deactivate check closed the PANEL behind it and left
    the check open: the check's first button was disabled while it loaded, DeskModal's opening focus
    failed on it, focus stayed on the panel, and the panel's Escape handler swallowed the key.
  */
  it("#1127 — Escape on the deactivate check closes the check and keeps the panel", async () => {
    stubFetch({
      ...MASTERS,
      "GET /api/opd/doctors/doc-1/impact": { booked: 0, bookedByDate: [], waitingToday: 0 },
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    await user.click(await screen.findByTestId("doctor-open-doc-1"));
    await user.click(within(await screen.findByTestId("doctor-panel")).getByTestId("doctor-deactivate"));
    await screen.findByTestId("doctor-impact-ask");
    await screen.findByTestId("doctor-impact-confirm");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("doctor-impact-ask")).toBeNull());
    expect(screen.getByTestId("doctor-panel")).toBeInTheDocument();
    expect(callsTo("PATCH", "/api/opd/doctors/doc-1")).toHaveLength(0);
  });

  it("#914 — a covering doctor's schedule row names the department the session serves", async () => {
    const covering = [{ ...DOCTORS[0]!, secondary: { departmentId: "dep-2", fromDate: "2026-10-17", toDate: null } }];
    stubFetch({
      ...MASTERS, "GET /api/opd/doctors": { items: covering },
      "GET /api/opd/doctors/doc-1/schedules": { items: [EXISTING_SCHEDULE] },
      "GET /api/opd/leaves": { items: [] },
      "PUT /api/opd/doctors/doc-1/schedules": { scheduleIds: ["sch-1"] },
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await openSchedulesTabFor(user, "doc-1");
    await user.selectOptions(await screen.findByLabelText("Department"), "dep-2");
    await user.click(screen.getByRole("button", { name: "Save schedules" }));
    await waitFor(() => expect(callsTo("PUT", "/api/opd/doctors/doc-1/schedules")).toHaveLength(1));
    expect(bodyOf("PUT", "/api/opd/doctors/doc-1/schedules")).toMatchObject({ items: [{ weekday: 3, departmentId: "dep-2" }] });
  });

  it("2026-10-04 — the doctors tab names every unit head with no registration number (the prescription's Dept. Regn prints blank for them)", async () => {
    setToken("t-1");
    stubFetch({
      ...MASTERS,
      "GET /api/auth/me": { actor: { type: "user", id: "u1" }, permissions: { hospital: ["roster.read", "opd.masters.manage"], scoped: { department: {}, floor: {} } } },
      "GET /api/roster/unit-heads-without-regn": [{ teamId: "t1", unitName: "General Medicine Unit I", userId: "u-ch", name: "Dr. Chandan" }],
    });
    renderWithProviders(<OpdAdmin />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Doctors" }));
    expect(await screen.findByTestId("heads-without-regn")).toHaveTextContent("Dr. Chandan (General Medicine Unit I)");
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
