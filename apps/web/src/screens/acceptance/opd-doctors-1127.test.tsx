import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../../lib/api";
import { renderWithProviders, stubFetch } from "../../test-utils";
import { OpdAdmin } from "../opd-admin";

/**
 * ACCEPTANCE — issue #1127, spec docs/specs/1127-opd-doctors-panel.md (owner APPROVED 2026-11-19): the web half.
 * OPD Admin → Doctors on the Users screen's pattern: search and filter tags over a short list, a side panel per
 * doctor, a New doctor panel that suggests staff. Names here are invented.
 */
const NOW_ISO = "2026-08-17T04:00:00.000Z";
const stamp = { createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO };
const DEPARTMENTS = [
  { id: "dep-1", code: "MED", name: "General medicine", active: true, ...stamp },
  { id: "dep-2", code: "PED", name: "Paediatrics", active: true, ...stamp },
  { id: "dep-3", code: "ENT", name: "ENT", active: true, ...stamp },
];
type Row = Record<string, unknown> & { id: string };
const baseDoctors = (): Row[] => [
  {
    id: "doc-1", code: "DR-0001", userId: "u-9", username: "meera", displayName: "Dr Meera Rao", registrationNo: "NMC-4411",
    departmentId: "dep-1", specialty: "Cardiology", designation: null, active: true, secondary: null, scheduledThisWeek: true, ...stamp,
  },
  {
    id: "doc-2", code: "DR-0002", userId: "u-kn", username: "kavya", displayName: "Dr Kavya Nair", registrationNo: null,
    departmentId: "dep-1", specialty: null, designation: "Assistant Professor", active: true,
    secondary: { departmentId: "dep-2", fromDate: "2026-08-01", toDate: null }, scheduledThisWeek: false, ...stamp,
  },
  {
    id: "doc-3", code: "DR-0003", userId: "u-7", username: "oldhand", displayName: "Dr Old Hand", registrationNo: "BMC-1",
    departmentId: "dep-2", specialty: null, designation: null, active: false, secondary: null, scheduledThisWeek: false, ...stamp,
  },
];

let doctors: Row[] = baseDoctors();
const ME = { actor: { type: "user", id: "u1" }, permissions: { hospital: ["roster.read", "opd.masters.read", "opd.masters.manage"], scoped: { department: {}, floor: {} } } };

function routes(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "GET /api/auth/me": ME,
    "GET /api/opd/departments": { items: DEPARTMENTS },
    "GET /api/opd/rooms": { items: [{ id: "room-1", code: "12", name: "Consulting 12", floor: "1", active: true, ...stamp }] },
    "GET /api/opd/doctors": () => ({ items: doctors }),
    "GET /api/opd/doctors/admin": () => ({ items: doctors }),
    "GET /api/roster/unit-heads-without-regn": [],
    "GET /api/opd/doctors/doc-1/schedules": { items: [{ id: "sch-1", doctorId: "doc-1", weekday: 3, startTime: "09:00", endTime: "13:00", roomId: "room-1", slotMinutes: 15, validFrom: "2026-01-01", validTo: null, active: true, departmentId: null, createdBy: "u-1", createdAt: NOW_ISO }] },
    "GET /api/opd/doctors/doc-2/schedules": { items: [] },
    "GET /api/opd/leaves": { items: [{ id: "lv-1", doctorId: "doc-1", fromDate: "2026-08-20", toDate: "2026-08-21", reason: "Conference", status: "scheduled", createdBy: "u-1", createdAt: NOW_ISO, cancelledBy: null, cancelledAt: null }] },
    "GET /api/opd/doctors/doc-1/history": { items: [] },
    "GET /api/opd/doctors/doc-2/history": { items: [] },
    ...extra,
  };
}

function calls(method: string, url: string): Record<string, unknown>[] {
  return vi.mocked(fetch).mock.calls
    .filter(([input, init]) => (init?.method ?? "GET") === method && String(input).split("?")[0] === url)
    .map(([, init]) => JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
}
function urlsTo(prefix: string): string[] {
  return vi.mocked(fetch).mock.calls.map(([input]) => String(input)).filter((u) => u.startsWith(prefix));
}

async function openDoctorsTab(): Promise<ReturnType<typeof userEvent.setup>> {
  renderWithProviders(<OpdAdmin />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("tab", { name: "Doctors" }));
  await screen.findByTestId("doctor-row-doc-1");
  return user;
}
const shownRows = (): string[] =>
  within(screen.getByTestId("doctors-rows")).queryAllByTestId(/^doctor-row-/).map((el) => el.getAttribute("data-testid")!.replace("doctor-row-", ""));

describe("#1127 — OPD Admin → Doctors (web)", () => {
  beforeEach(() => { setToken("t-1"); localStorage.clear(); doctors = baseDoctors(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("spec #1127 D1: the search finds by name, Doctor ID, username, registration number or department; tags narrow the list", async () => {
    stubFetch(routes());
    const user = await openDoctorsTab();
    expect(shownRows()).toEqual(["doc-1", "doc-2", "doc-3"]);
    const search = screen.getByTestId("doctors-search");
    const find = async (q: string): Promise<string[]> => { await user.clear(search); await user.type(search, q); return shownRows(); };
    expect(await find("kavya")).toEqual(["doc-2"]);
    expect(await find("DR-0003")).toEqual(["doc-3"]);
    expect(await find("oldhand")).toEqual(["doc-3"]);
    expect(await find("NMC-4411")).toEqual(["doc-1"]);
    expect(await find("paediatrics")).toEqual(["doc-2", "doc-3"]);
    await user.clear(search);
    await user.click(screen.getByTestId("doctors-chip-active"));
    expect(shownRows()).toEqual(["doc-1", "doc-2"]);
    await user.click(screen.getByTestId("doctors-chip-inactive"));
    expect(shownRows()).toEqual(["doc-3"]);
    await user.click(screen.getByTestId("doctors-chip-noRegn"));
    expect(shownRows()).toEqual(["doc-2"]);
    await user.click(screen.getByTestId("doctors-chip-noSchedule"));
    expect(shownRows()).toEqual(["doc-2"]);
    await user.click(screen.getByTestId("doctors-chip-secondary"));
    expect(shownRows()).toEqual(["doc-2"]);
    await user.click(screen.getByTestId("doctors-chip-all"));
    expect(shownRows()).toEqual(["doc-1", "doc-2", "doc-3"]);
  });

  it("spec #1127 D2: the side panel edits name, registration, specialty, designation, department and second department; the list shows the new values", async () => {
    stubFetch(routes({
      "PATCH /api/opd/doctors/doc-1": (init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        doctors = doctors.map((d) => (d.id === "doc-1" ? { ...d, ...body } : d));
        return { ok: true, needsRebooking: [], waitingToday: 0 };
      },
      "PUT /api/opd/doctors/doc-1/secondary-department": { id: "sec-1", doctorId: "doc-1", departmentId: "dep-3", fromDate: "2026-08-17", toDate: null },
    }));
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    const field = (name: string): HTMLInputElement => within(panel).getByLabelText(name);
    await user.clear(field("Display name")); await user.type(field("Display name"), "Dr Meera K. Rao");
    await user.clear(field("Registration number")); await user.type(field("Registration number"), "NMC-5000");
    await user.clear(field("Specialty")); await user.type(field("Specialty"), "Interventional cardiology");
    await user.type(field("Designation"), "Professor");
    await user.click(within(panel).getByTestId("doctor-save"));
    await waitFor(() => { expect(calls("PATCH", "/api/opd/doctors/doc-1")).toHaveLength(1); });
    expect(calls("PATCH", "/api/opd/doctors/doc-1")[0]).toEqual({
      displayName: "Dr Meera K. Rao", registrationNo: "NMC-5000", specialty: "Interventional cardiology", designation: "Professor",
    });
    await waitFor(() => { expect(screen.getByTestId("doctor-row-doc-1")).toHaveTextContent("Dr Meera K. Rao"); });

    await user.selectOptions(within(panel).getByTestId("doctor-secondary-pick"), "dep-3");
    await user.click(within(panel).getByTestId("doctor-secondary-start"));
    await waitFor(() => { expect(calls("PUT", "/api/opd/doctors/doc-1/secondary-department")).toEqual([{ departmentId: "dep-3" }]); });
  });

  it("spec #1127 D3: the panel shows the Doctor ID with no box to change it", async () => {
    stubFetch(routes());
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    expect(within(panel).getByTestId("doctor-code")).toHaveTextContent("DR-0001");
    expect(within(panel).queryByDisplayValue("DR-0001")).toBeNull();
    expect(within(panel).queryByLabelText(/doctor id/i)).toBeNull();
  });

  it("spec #1127 D4: New doctor suggests staff from two letters; picking one fills username and \"Dr. <full name>\"", async () => {
    stubFetch(routes({
      "GET /api/opd/doctors/candidates": { items: [{ userId: "u-20", username: "ravi", fullName: "Ravi Kumar", staffCode: "EMP-0020", isDoctorRole: true }] },
      "POST /api/opd/doctors": { doctorId: "doc-9", userId: "u-20" },
    }));
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctors-new"));
    const panel = await screen.findByTestId("doctor-new-panel");
    await user.type(within(panel).getByTestId("doctor-new-search"), "r");
    expect(urlsTo("/api/opd/doctors/candidates")).toEqual([]);
    await user.type(within(panel).getByTestId("doctor-new-search"), "a");
    await user.click(await within(panel).findByTestId("doctor-candidate-ravi"));
    expect(within(panel).getByTestId("doctor-new-username")).toHaveTextContent("ravi");
    expect(within(panel).getByLabelText("Display name")).toHaveValue("Dr. Ravi Kumar");
    await user.selectOptions(within(panel).getByLabelText("Department"), "dep-1");
    await user.click(within(panel).getByTestId("doctor-new-submit"));
    await waitFor(() => { expect(calls("POST", "/api/opd/doctors")).toHaveLength(1); });
    expect(calls("POST", "/api/opd/doctors")[0]).toEqual({ username: "ravi", displayName: "Dr. Ravi Kumar", departmentId: "dep-1" });
  });

  it("spec #1127 D5: deactivating first lists the future bookings by day and today's waiting patients, then switches off", async () => {
    stubFetch(routes({
      "GET /api/opd/doctors/doc-1/impact": { booked: 3, bookedByDate: [{ date: "2026-08-20", count: 2 }, { date: "2026-08-21", count: 1 }], waitingToday: 1 },
      "PATCH /api/opd/doctors/doc-1": { ok: true, needsRebooking: ["a1", "a2", "a3"], waitingToday: 1 },
    }));
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    await user.click(within(await screen.findByTestId("doctor-panel")).getByTestId("doctor-deactivate"));
    const ask = await screen.findByTestId("doctor-impact-ask");
    await waitFor(() => { expect(within(ask).getByTestId("doctor-impact-booked")).toHaveTextContent("20 Aug"); });
    expect(within(ask).getByTestId("doctor-impact-booked")).toHaveTextContent("21 Aug");
    expect(within(ask).getByTestId("doctor-impact-waiting")).toHaveTextContent("1");
    expect(urlsTo("/api/opd/doctors/doc-1/impact")[0]).toContain("kind=deactivate");
    expect(calls("PATCH", "/api/opd/doctors/doc-1")).toHaveLength(0);
    await user.click(within(ask).getByTestId("doctor-impact-confirm"));
    await waitFor(() => { expect(calls("PATCH", "/api/opd/doctors/doc-1")).toEqual([{ active: false }]); });
  });

  it("spec #1127 D6: a department change shows the same check before it is saved", async () => {
    stubFetch(routes({
      "GET /api/opd/doctors/doc-1/impact": { booked: 1, bookedByDate: [{ date: "2026-08-24", count: 1 }], waitingToday: 0 },
      "PATCH /api/opd/doctors/doc-1": { ok: true, needsRebooking: ["a1"], waitingToday: 0 },
    }));
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    await user.selectOptions(within(panel).getByLabelText("Department"), "dep-3");
    await user.click(within(panel).getByTestId("doctor-save"));
    const ask = await screen.findByTestId("doctor-impact-ask");
    await waitFor(() => { expect(within(ask).getByTestId("doctor-impact-booked")).toHaveTextContent("24 Aug"); });
    expect(urlsTo("/api/opd/doctors/doc-1/impact")[0]).toContain("departmentId=dep-3");
    expect(calls("PATCH", "/api/opd/doctors/doc-1")).toHaveLength(0);
    await user.click(within(ask).getByTestId("doctor-impact-confirm"));
    await waitFor(() => { expect(calls("PATCH", "/api/opd/doctors/doc-1")).toEqual([{ departmentId: "dep-3" }]); });
  });

  it("spec #1127 D7: the panel lists each change: field, old → new, who and when", async () => {
    stubFetch(routes({
      "GET /api/opd/doctors/doc-1/history": { items: [
        { at: "2026-08-17T05:00:00.000Z", actorName: "Admin One", kind: "changed", changes: [{ field: "displayName", from: "Dr M Rao", to: "Dr Meera Rao" }] },
      ] },
    }));
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    const history = await within(await screen.findByTestId("doctor-panel")).findByTestId("doctor-history");
    await waitFor(() => { expect(history).toHaveTextContent("Dr M Rao"); });
    expect(history).toHaveTextContent("Dr Meera Rao");
    expect(history).toHaveTextContent("Admin One");
    expect(history).toHaveTextContent("17 Aug");
  });

  it("spec #1127 D8: the panel shows the weekly schedule and leaves, and opens Schedules & leaves for that doctor", async () => {
    stubFetch(routes());
    const user = await openDoctorsTab();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    const panel = await screen.findByTestId("doctor-panel");
    await waitFor(() => { expect(within(panel).getByTestId("doctor-schedule-summary")).toHaveTextContent("09:00–13:00"); });
    expect(within(panel).getByTestId("doctor-schedule-summary")).toHaveTextContent("Wed");
    await waitFor(() => { expect(within(panel).getByTestId("doctor-leaves-summary")).toHaveTextContent("20 Aug"); });
    await user.click(within(panel).getByTestId("doctor-open-schedules"));
    expect(screen.getByRole("tab", { name: "Schedules & leaves" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("Doctor")).toHaveValue("doc-1");
  });

  it("spec #1127 D9: the no-registration note names each doctor as a link to their registration box", async () => {
    stubFetch(routes({
      "GET /api/roster/unit-heads-without-regn": [{ teamId: "t1", unitName: "General Medicine Unit I", userId: "u-kn", name: "Dr Kavya Nair" }],
    }));
    const user = await openDoctorsTab();
    const note = await screen.findByTestId("heads-without-regn");
    await user.click(within(note).getByRole("button", { name: /Dr Kavya Nair/ }));
    const panel = await screen.findByTestId("doctor-panel");
    await waitFor(() => { expect(within(panel).getByLabelText("Registration number")).toHaveFocus(); });
    expect(within(panel).getByTestId("doctor-code")).toHaveTextContent("DR-0002");
  });

  it("spec #1127 D10: the list is a list of rows, not a wide table, and the panel is a dialog", async () => {
    stubFetch(routes());
    const user = await openDoctorsTab();
    expect(screen.getByRole("tabpanel").querySelector("table")).toBeNull();
    await user.click(screen.getByTestId("doctor-open-doc-1"));
    expect(await screen.findByRole("dialog")).toContainElement(screen.getByTestId("doctor-panel"));
  });
});
