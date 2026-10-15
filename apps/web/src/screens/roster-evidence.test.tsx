import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { RosterEvidence, rangeOk } from "./roster-evidence";
import type { WireDutyEvidence, WireEvidencePickerDepartment } from "../lib/roster-api";

/**
 * 20-U U8 — the duty-evidence report, on screen: pick people and days, read the sheet exactly as the
 * printer will print it (the server's HTML, in a frame), print on the office's A4 through the server.
 */
const DEPTS: WireEvidencePickerDepartment[] = [
  { departmentId: "sur", name: "General Surgery", people: [
    { userId: "kavita", name: "Dr. Kavita Sinha", grade: "senior_resident", unitName: "General Surgery Unit I" },
    { userId: "anand", name: "Dr. Anand Rao", grade: "associate_professor", unitName: "General Surgery Unit II" },
  ] },
];
const SHEET = "<!doctype html><html><body><h1>Duty evidence</h1><p>surgeon: wheeled in 09:12, wheeled out 11:40</p></body></html>";
const REPORT: WireDutyEvidence = {
  from: "2026-09-01", to: "2026-09-30", generatedAt: "2026-10-04T05:00:00.000Z", generatedBy: "Dr. R. Prasad", ref: "A1B2C3D4E5",
  sources: ["roster", "leave", "holidays", "theatre"], people: [],
};

describe("RosterEvidence (20-U U8)", () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let served = true;
  beforeEach(() => {
    setToken("t");
    calls.length = 0;
    served = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ method: init?.method ?? "GET", url: raw, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      const body = raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "ms" }, permissions: { hospital: ["roster.read", "roster.periods.publish"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : raw.endsWith("/roster/evidence/people") ? { you: { name: "Dr. R. Prasad", grade: null, positionKey: null, unitName: null, departmentName: null }, departments: DEPTS }
            : raw.includes("/roster/evidence/print") ? { queued: true, ref: "A1B2C3D4E5", served }
              : raw.includes("/roster/evidence?") ? { report: REPORT, html: SHEET } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("pick a person and the days, read the sheet as it will print, print it on the office A4", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterEvidence />);
    const kavita = await screen.findByTestId("evidence-person-kavita");
    expect(kavita).toHaveTextContent("Dr. Kavita SinhaSR · Unit I");
    await user.click(within(kavita).getByRole("checkbox"));
    expect(screen.getByTestId("evidence-chosen")).toHaveTextContent("1 person chosen");
    await user.click(screen.getByTestId("evidence-show"));
    const frame = await screen.findByTestId("evidence-sheet");
    expect(frame.getAttribute("srcdoc")).toBe(SHEET);
    expect(calls.find((c) => c.url.includes("/roster/evidence?"))!.url).toMatch(/users=kavita&from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByTestId("evidence-sources")).toHaveTextContent("Theatre wheel-in and wheel-out");

    await user.click(screen.getByTestId("evidence-print"));
    expect(await screen.findByTestId("evidence-printed")).toHaveTextContent("Sent to the office printer. Reference A1B2C3D4E5.");
    expect(calls.filter((c) => c.method === "POST").map((c) => (c.body as { userIds: string[] }).userIds)).toEqual([["kavita"]]);
  });

  it("says so when no relay serves the office printer, rather than letting somebody wait at it", async () => {
    served = false;
    const user = userEvent.setup();
    renderWithProviders(<RosterEvidence />);
    await user.click(within(await screen.findByTestId("evidence-person-anand")).getByRole("checkbox"));
    await user.click(screen.getByTestId("evidence-show"));
    await screen.findByTestId("evidence-sheet");
    await user.click(screen.getByTestId("evidence-print"));
    expect(await screen.findByTestId("evidence-printed")).toHaveTextContent(/no print relay has been heard from lately/);
  });

  it("asks for a person before it asks the server", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RosterEvidence />);
    await user.click(await screen.findByTestId("evidence-show"));
    expect(screen.getByTestId("evidence-problem")).toHaveTextContent("Choose at least one person.");
    expect(calls.some((c) => c.url.includes("/roster/evidence?"))).toBe(false);
  });

  it("a range is a range: at most 31 days, the last not before the first", () => {
    expect(rangeOk("2026-09-01", "2026-09-30")).toBe(true);
    expect(rangeOk("2026-09-01", "2026-10-01")).toBe(true);
    expect(rangeOk("2026-09-01", "2026-10-02")).toBe(false);
    expect(rangeOk("2026-09-05", "2026-09-01")).toBe(false);
    expect(rangeOk("05-09-2026", "2026-09-30")).toBe(false);
  });

  it("a person whose roster nobody here answers for is told who runs the sheet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = raw.endsWith("/auth/me")
        ? { actor: { type: "user", id: "x" }, permissions: { hospital: ["roster.read"], scoped: { department: {}, floor: {} } } }
        : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
          : { you: { name: "x", grade: null, positionKey: null, unitName: null, departmentName: null }, departments: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    renderWithProviders(<RosterEvidence />);
    expect(await screen.findByTestId("evidence-none")).toHaveTextContent("The sheet is run by a head of department");
  });
});
