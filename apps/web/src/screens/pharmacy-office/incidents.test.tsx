import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../../lib/api";
import { incidentsCsv } from "../../lib/incidents-api";
import { renderWithRouter } from "../../test-utils";
import { IncidentRegisterView } from "./incidents";
import type { WireIncident } from "../../lib/incidents-api";

/**
 * PHARMACY STAGE D2 — the medication error and near-miss log as an office page: the indicator strip, the log
 * with each incident's review state, the record sheet (kind and NCC MERP category agree), and the reviewer's
 * acts. BLAME-FREE both ways: the page draws a name only when the server sent one, and the export never does.
 */
type Call = { method: string; path: string; body: unknown };
function mock(routes: Record<string, unknown | ((body: unknown) => unknown)>, perms: string[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!.replace(/^.*\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
    calls.push({ method, path, body });
    if (path === "/auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const v = routes[`${method} ${path}`];
    if (v === undefined) return new Response("{}", { status: 404 });
    const out = typeof v === "function" ? (v as (b: unknown) => unknown)(body) : v;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

const ROW: WireIncident = {
  id: "i1", no: "MI-000001", kind: "error", stage: "dispensing", type: "wrong_strength", category: "E", factors: ["look_alike_packaging"],
  patient: { id: "p1", uhid: "UH-0001", name: "Asha Devi", alias: null, restricted: false }, item: { id: "it1", name: "Dolo 650" },
  dispenseNo: "P2609280004", lineIdx: 0, whatHappened: "650 given for 500", createdAt: "2026-09-01T05:00:00.000Z",
  reporter: { role: "pharmacy", roleTitle: "Pharmacist", name: null },
  state: { reviewed: false, rootCause: null, actionTaken: null, closed: false }, events: [],
};
const NAMED: WireIncident = { ...ROW, reporter: { role: "pharmacy", roleTitle: "Pharmacist", name: "Kavita Joshi" } };
const INDICATOR = { months: [
  { month: "2026-08", errors: 0, nearMisses: 3, dispensedLines: 1200, counterLines: 1100, walkInLines: 100, errorsPer1000: 0 },
  { month: "2026-09", errors: 2, nearMisses: 5, dispensedLines: 800, counterLines: 700, walkInLines: 100, errorsPer1000: 2.5 },
] };

beforeEach(() => { setToken("t"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the medication incident log (pharmacy stage D2)", () => {
  it("a recorder sees the ROLE only, the indicator, and no review acts", async () => {
    mock({ "GET /pharmacy/incidents": { items: [ROW] }, "GET /pharmacy/incidents/indicator": INDICATOR }, ["pharmacy.incidents.record"]);
    renderWithRouter(<IncidentRegisterView />);
    expect(await screen.findByTestId("incident-reporter-MI-000001")).toHaveTextContent("Pharmacist");
    expect(screen.getByTestId("incident-reporter")).toHaveTextContent(/^Pharmacist$/);
    expect(screen.getByTestId("incidents-view")).not.toHaveTextContent("Kavita");
    // A harmful (E) error past 24 h unreviewed is red.
    expect(screen.getByTestId("incident-state-MI-000001").className).toContain("rd");
    expect(await screen.findByTestId("indicator-2026-09")).toHaveTextContent("2.50");
    expect(screen.getByTestId("indicator-2026-09")).toHaveTextContent("2 errors · 5 near misses · 800 lines");
    expect(screen.queryByTestId("incident-actions")).toBeNull();
  });

  it("a reviewer sees the name the server sent, beside the role, and records the review then the close", async () => {
    let reviewed = false;
    const calls = mock({
      "GET /pharmacy/incidents": () => ({ items: [reviewed ? { ...NAMED, state: { reviewed: true, rootCause: "Boxes side by side", actionTaken: "Moved apart", closed: false } } : NAMED] }),
      "GET /pharmacy/incidents/indicator": INDICATOR,
      "POST /pharmacy/incidents/i1/events": () => { reviewed = true; return { eventId: "e1" }; },
    }, ["pharmacy.incidents.review"]);
    renderWithRouter(<IncidentRegisterView />);
    expect(await screen.findByTestId("incident-reporter")).toHaveTextContent("Kavita Joshi (Pharmacist)");
    // A reviewer who does not record sees no record button.
    expect(screen.queryByTestId("incidents-record-open")).toBeNull();
    expect(screen.queryByTestId("incident-close")).toBeNull();
    await userEvent.type(screen.getByTestId("incident-cause"), "Boxes side by side");
    await userEvent.type(screen.getByTestId("incident-action"), "Moved apart");
    await userEvent.click(screen.getByTestId("incident-review-save"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ kind: "reviewed", rootCause: "Boxes side by side", actionTaken: "Moved apart" });
    expect(await screen.findByTestId("incident-close")).toBeInTheDocument();
  });

  it("the export carries the role and never the name — even from a reviewer's rows — and no patient", () => {
    const csv = incidentsCsv([NAMED]);
    expect(csv).toContain("Pharmacist");
    expect(csv).not.toContain("Kavita");
    expect(csv).not.toContain("Asha");
    expect(csv).not.toContain("UH-0001");
    expect(csv.split("\r\n")[0]).toContain("reporter_role");
  });

  it("the record sheet: an error offers only C–I, a near miss only A–B, and posts once", async () => {
    let recorded = false;
    const calls = mock({
      "GET /pharmacy/incidents": () => ({ items: recorded ? [{ ...ROW, id: "i9", no: "MI-000009" }] : [] }),
      "GET /pharmacy/incidents/indicator": INDICATOR,
      "POST /pharmacy/incidents": () => { recorded = true; return { incidentId: "i9", no: "MI-000009" }; },
    }, ["pharmacy.incidents.record"]);
    renderWithRouter(<IncidentRegisterView />);
    expect(await screen.findByTestId("incidents-empty")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("incidents-record-open"));
    const cats = (): string[] => within(screen.getByTestId("incident-category")).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(cats()).toEqual(["A", "B"]);
    await userEvent.click(screen.getByTestId("incident-kind-error"));
    expect(cats()).toEqual(["C", "D", "E", "F", "G", "H", "I"]);
    await userEvent.selectOptions(screen.getByTestId("incident-category"), "D");
    await userEvent.selectOptions(screen.getByTestId("incident-type"), "wrong_dose");
    await userEvent.click(screen.getByTestId("incident-factor-workload"));
    expect(screen.getByTestId("incident-record-save")).toBeDisabled();
    await userEvent.type(screen.getByTestId("incident-what-text"), "Twice the dose labelled");
    await userEvent.click(screen.getByTestId("incident-record-save"));
    expect(await screen.findByTestId("incidents-notice")).toHaveTextContent("MI-000009");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ kind: "error", category: "D", stage: "dispensing", type: "wrong_dose", factors: ["workload"], whatHappened: "Twice the dose labelled" });
  });
});
