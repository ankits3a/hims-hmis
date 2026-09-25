import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { OpdAdmin } from "./opd-admin";
import { MyLayoutDialog, applyLayout, orderRows } from "./opd-layout";
import type { WireDepartmentLayout, WireMyLayout } from "./opd-layout";

/**
 * Board `Profiles` — the admin's department default and the doctor's own layout. The server holds
 * every rule (layout.ts); these tests pin that the controls draw what it says and send back the
 * body the admin or the doctor built.
 */
const NOW_ISO = "2026-08-17T04:00:00.000Z";
const DEPARTMENTS = [
  { id: "dep-1", code: "MED", name: "General Medicine", active: true, createdBy: "u-1", createdAt: NOW_ISO, updatedBy: "u-1", updatedAt: NOW_ISO },
];
const LOCKED = ["vitals", "complaints", "exam", "dx", "rx"];
const KEYS = ["vitals", "complaints", "exam", "dx", "inv", "rx", "treat", "advice", "notes"] as const;
const DEPT_LAYOUT: WireDepartmentLayout = {
  departmentId: "dep-1", departmentName: "General Medicine", version: 3,
  sections: KEYS.map((key) => ({ key, shown: true, mandatory: LOCKED.includes(key), locked: LOCKED.includes(key) })),
  audit: [
    { version: 3, by: "u-1", byName: "R. Singh", at: "2026-09-22T10:40:00.000Z", changes: [{ kind: "mandatory", key: "advice" }], summary: "Advice set to mandatory" },
    { version: 2, by: "u-1", byName: "R. Singh", at: "2026-09-21T10:40:00.000Z", changes: [{ kind: "moved", key: "advice", above: "rx", below: null }], summary: "Advice moved above Rx" },
  ],
};

function fetchCalls(): { url: string; method: string; body: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: String(input).split("?")[0]!, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "",
  }));
}
const bodiesOf = (method: string, url: string): Record<string, unknown>[] =>
  fetchCalls().filter((c) => c.method === method && c.url === url).map((c) => JSON.parse(c.body) as Record<string, unknown>);

beforeEach(() => { setToken(null); localStorage.clear(); setToken("t-1"); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the consult's tab order follows the layout", () => {
  const TABS = [["summary", "Summary"], ["vitals", "Vitals"], ["complaints", "Complaints"], ["rx", "Rx"], ["notes", "Notes"]] as const;
  it("summary first, then the layout's order; a section the layout leaves off is gone; no layout is today's order", () => {
    const layout = { sections: [{ key: "rx" as const, mandatory: true }, { key: "vitals" as const, mandatory: true }, { key: "complaints" as const, mandatory: true }], defaultVersion: 1, overlayVersion: 1 };
    expect(applyLayout(TABS, layout).map((o) => o[0])).toEqual(["summary", "rx", "vitals", "complaints"]);
    expect(applyLayout(TABS, undefined).map((o) => o[0])).toEqual(["summary", "vitals", "complaints", "rx", "notes"]);
    expect(orderRows([{ id: "complaints" }, { id: "rx" }, { id: "notes" }], layout).map((r) => r.id)).toEqual(["rx", "complaints"]);
  });
});

describe("OpdAdmin — Consult layout", () => {
  it("draws the department default with the locked sections ticked and disabled, and saves the body the admin built", async () => {
    stubFetch({
      "GET /api/opd/departments": { items: DEPARTMENTS },
      "GET /api/opd/rooms": { items: [] },
      "GET /api/opd/doctors": { items: [] },
      "GET /api/opd/layouts/dep-1": DEPT_LAYOUT,
      "PUT /api/opd/layouts/dep-1": { ...DEPT_LAYOUT, version: 4 },
    });
    const user = userEvent.setup();
    renderWithProviders(<OpdAdmin />);
    await user.click(await screen.findByRole("tab", { name: "Consult layout" }));
    expect(await screen.findByTestId("layout-version")).toHaveTextContent("General Medicine · version 3 · changes apply to new visits only");
    // Locked: ticked and disabled in both columns.
    for (const k of LOCKED) {
      expect(screen.getByTestId(`layout-mandatory-${k}`)).toBeChecked();
      expect(screen.getByTestId(`layout-mandatory-${k}`)).toBeDisabled();
      expect(screen.getByTestId(`layout-shown-${k}`)).toBeDisabled();
    }
    const audit = screen.getByTestId("layout-audit");
    expect(within(audit).getByTestId("layout-audit-v3")).toHaveTextContent("R. Singh · Advice & follow-up set to mandatory (v2 → v3)");
    expect(within(audit).getByTestId("layout-audit-v2")).toHaveTextContent("Advice & follow-up moved above Prescription");
    expect(audit).toHaveTextContent("An old visit always reads and prints in the version it was written under.");

    await user.click(screen.getByTestId("layout-shown-notes")); // hide Notes
    await user.click(screen.getByTestId("layout-mandatory-treat")); // Treatment mandatory
    await user.click(screen.getByTestId("layout-up-advice")); // Advice above Treatment
    await user.click(screen.getByTestId("layout-save"));
    await waitFor(() => { expect(bodiesOf("PUT", "/api/opd/layouts/dep-1")).toHaveLength(1); });
    const sent = bodiesOf("PUT", "/api/opd/layouts/dep-1")[0]!.sections as { key: string; shown: boolean; mandatory: boolean }[];
    expect(sent.map((r) => r.key)).toEqual(["vitals", "complaints", "exam", "dx", "inv", "rx", "advice", "treat", "notes"]);
    expect(sent.find((r) => r.key === "notes")).toEqual({ key: "notes", shown: false, mandatory: false });
    expect(sent.find((r) => r.key === "treat")).toEqual({ key: "treat", shown: true, mandatory: true });
    expect(sent.find((r) => r.key === "rx")).toEqual({ key: "rx", shown: true, mandatory: true });
    expect(await screen.findByTestId("layout-version")).toHaveTextContent("version 4");
  });
});

describe("My layout", () => {
  const MINE: WireMyLayout = {
    departmentId: "dep-1", departmentName: "General Medicine", version: null, defaultVersion: 3,
    sections: KEYS.filter((k) => k !== "treat").map((key) => ({ key, mandatory: LOCKED.includes(key) || key === "advice", hidden: false })),
    adminHidden: ["treat"], audit: [],
  };

  it("hides a section that is not mandatory, offers no Hide on a mandatory one, and saves order and hidden", async () => {
    stubFetch({ "GET /api/opd/me/layout": MINE, "PUT /api/opd/me/layout": { ...MINE, version: 1 } });
    const user = userEvent.setup();
    renderWithProviders(<MyLayoutDialog open onClose={() => undefined} />);
    const dialog = await screen.findByTestId("my-layout-dialog");
    await within(dialog).findByTestId("my-layout-row-notes");
    expect(within(dialog).getByTestId("my-layout-note")).toHaveTextContent("Changes apply to your next visits");
    // Mandatory — locked or the admin's — has no Hide control at all.
    for (const k of [...LOCKED, "advice"]) expect(within(dialog).queryByTestId(`my-layout-hide-${k}`)).toBeNull();
    expect(within(dialog).queryByTestId("my-layout-row-treat")).toBeNull(); // the admin hid it: not the doctor's to show
    expect(dialog).toHaveTextContent("Hidden by the department layout: Treatment");
    await user.click(within(dialog).getByTestId("my-layout-hide-notes"));
    await user.click(within(dialog).getByTestId("my-layout-up-rx"));
    await user.click(within(dialog).getByTestId("my-layout-save"));
    await waitFor(() => { expect(bodiesOf("PUT", "/api/opd/me/layout")).toHaveLength(1); });
    expect(bodiesOf("PUT", "/api/opd/me/layout")[0]).toEqual({
      order: ["vitals", "complaints", "exam", "dx", "rx", "inv", "advice", "notes"],
      hidden: ["notes"],
    });
    expect(await within(dialog).findByTestId("my-layout-saved")).toBeInTheDocument();
  });
});
