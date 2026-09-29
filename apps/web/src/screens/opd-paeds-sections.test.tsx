import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/api";
import { renderWithProviders, stubFetch } from "../test-utils";
import { PaedsSections, ageYmd, childAgeText } from "./opd-paeds-sections";
import type { WireVisitSections } from "./opd-eye-sections";
import type { WireDose, WirePaeds } from "./opd-paeds-sections";

/**
 * The Child tab (01-CONSULT-ENGINE.md §6.2; board `Departments`: "Child screen: age in Y-M-D,
 * growth, vaccines"). The server computes the growth and the timetable; this draws them, and saves
 * each section when the doctor leaves it.
 */
const dose = (id: string, label: string, status: WireDose["status"], extra: Partial<WireDose> = {}): WireDose => ({
  id, vaccine: label, label, status, dueOn: null, overdueFrom: null, givenOn: null, givenWhere: null, note: null, uip: null, ...extra,
});
const PAEDS: WirePaeds = {
  dob: "2025-06-15", dobEstimated: false, sex: "girl", age: { years: 1, months: 3, days: 13, totalDays: 470 }, adult: false,
  weight: { kg: 9.6, recordedAt: "2026-09-28T04:00:00.000Z", today: true, daysAgo: 0 },
  lengthSource: "vitals",
  growth: [
    { key: "wfa", value: 9.6, z: 0.18, percentile: 57.1, implausible: false, reference: "WHO 2006", reason: null },
    { key: "lhfa", value: 76, z: -1.02, percentile: 15.4, implausible: false, reference: "WHO 2006", reason: null },
    { key: "hcfa", value: null, z: null, percentile: null, implausible: false, reference: null, reason: "not_measured" },
    { key: "bfa", value: 16.62, z: 1.05, percentile: 85.3, implausible: false, reference: "WHO 2006", reason: null },
  ],
  immunisation: {
    source: "IAP-ACVIP Immunization Timetable 2023", today: "2026-09-28",
    doses: [
      dose("mmr-1", "MMR-1", "overdue", { dueOn: "2026-03-15", overdueFrom: "2026-04-12", uip: "UIP: MR-1 (measles-rubella) at 9-12 months." }),
      dose("mmr-2", "MMR-2", "due", { dueOn: "2026-09-15", overdueFrom: "2026-10-13" }),
      dose("bcg", "BCG", "given", { givenOn: "2025-06-16", givenWhere: "earlier" }),
      dose("dtp-b1", "DTwP/DTaP-B1", "upcoming", { dueOn: "2026-10-15" }),
      dose("hepb-4", "Hep B-4", "optional"),
    ],
  },
};
const WIRE: WireVisitSections = {
  profile: "paediatrics",
  sections: (["paeds.informant", "paeds.growth", "paeds.immunisation", "paeds.birth", "paeds.milestones", "paeds.feeding"] as const)
    .map((key) => ({ key, version: 1, kind: "form" })),
  records: {},
  paeds: PAEDS,
};

function puts(path: string): Record<string, unknown>[] {
  return vi.mocked(fetch).mock.calls
    .filter(([u, init]) => String(u).split("?")[0] === path && init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}
const render = (): void => {
  renderWithProviders(<><PaedsSections encounterId="enc-1" leaseBody={() => ({ leaseToken: "tab-1" })} readOnly={false} /><button type="button">elsewhere</button></>);
};

describe("age in years, months and days — the consult header's mirror of the server's", () => {
  it("counts on the IST calendar, and a 31st reaches a short month's last day", () => {
    expect(ageYmd("2025-06-15", new Date("2026-09-28T06:00:00Z"))).toEqual({ years: 1, months: 3, days: 13 });
    expect(ageYmd("2025-06-15", new Date("2026-09-27T20:00:00Z"))).toEqual({ years: 1, months: 3, days: 13 });
    expect(ageYmd("2024-01-31", new Date("2026-03-01T06:00:00Z"))).toEqual({ years: 2, months: 1, days: 1 });
  });
  it("a child's header reads Y-M-D; an adult's stays in years", () => {
    expect(childAgeText("2025-06-15", new Date("2026-09-28T06:00:00Z"))).toBe("1 y 3 m 13 d");
    expect(childAgeText("1990-01-01", new Date("2026-09-28T06:00:00Z"))).toBeNull();
  });
});

describe("PaedsSections — the Child tab", () => {
  beforeEach(() => { setToken("t"); });

  it("draws age, today's weight, and each growth indicator with its z-score and centile — or why it has none", async () => {
    stubFetch({ "GET /api/opd/visits/enc-1/sections": WIRE });
    render();
    expect(await screen.findByTestId("paeds-age")).toHaveTextContent("1 y 3 m 13 d");
    expect(screen.getByTestId("paeds-weight")).toHaveTextContent("9.6 kg");
    expect(screen.queryByTestId("paeds-weight-stale")).toBeNull();
    const wfa = screen.getByTestId("paeds-growth-row-wfa");
    expect(wfa).toHaveTextContent("+0.18");
    expect(wfa).toHaveTextContent("57.1");
    expect(screen.getByTestId("paeds-growth-row-lhfa")).toHaveTextContent("−1.02");
    expect(screen.getByTestId("paeds-growth-row-hcfa")).toHaveTextContent(/Not measured/);
  });

  it("a weight from an earlier visit is flagged, and from 5 years the missing IAP reference is said out loud", async () => {
    stubFetch({
      "GET /api/opd/visits/enc-1/sections": { ...WIRE, paeds: {
        ...PAEDS, age: { years: 7, months: 1, days: 0, totalDays: 2588 },
        weight: { kg: 21, recordedAt: "2026-08-01T04:00:00.000Z", today: false, daysAgo: 58 },
        growth: PAEDS.growth.map((g) => ({ ...g, z: null, percentile: null, reference: "IAP 2015" as const, reason: "iap_2015_lms_unpublished" })),
      } },
    });
    render();
    expect(await screen.findByTestId("paeds-weight-stale")).toHaveTextContent(/58 days/);
    expect(screen.getByTestId("paeds-growth-row-wfa")).toHaveTextContent(/IAP 2015 reference values are not published/);
  });

  it("the timetable lists overdue and due doses first, with the national programme's difference as a note", async () => {
    stubFetch({ "GET /api/opd/visits/enc-1/sections": WIRE });
    render();
    const due = await screen.findByTestId("paeds-imm-due");
    const rows = within(due).getAllByTestId(/^paeds-imm-dose-/).map((r) => r.getAttribute("data-testid"));
    expect(rows).toEqual(["paeds-imm-dose-mmr-1", "paeds-imm-dose-mmr-2"]);
    expect(screen.getByTestId("paeds-imm-dose-mmr-1")).toHaveTextContent(/OVERDUE/);
    expect(screen.getByTestId("paeds-imm-dose-mmr-1")).toHaveTextContent(/UIP: MR-1/);
    expect(screen.getByTestId("paeds-imm-upcoming")).toHaveTextContent("DTwP/DTaP-B1");
  });

  it("'Given today' records the dose with its batch and site, and keeps every entry already on record", async () => {
    stubFetch({
      "GET /api/opd/visits/enc-1/sections": { ...WIRE, records: { "paeds.immunisation": {
        body: { givenToday: [{ id: "g-1", dose: "var-1", batch: "VZ88", site: "left_thigh", brand: "", errorReason: null }], earlier: [], note: "" },
        at: "2026-09-28T04:10:00.000Z", authorId: "u", sectionVersion: 1, recordId: "r-1",
      } } },
      "PUT /api/opd/visits/enc-1/sections/paeds.immunisation": { record: { recordId: "r-2", at: "2026-09-28T04:20:00.000Z", body: {
        givenToday: [
          { id: "g-1", dose: "var-1", batch: "VZ88", site: "left_thigh", brand: "", errorReason: null },
          { id: "g-2", dose: "mmr-2", batch: "MMR2231A", site: "right_upper_arm", brand: "", errorReason: null },
        ], earlier: [], note: "",
      } } },
    });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByTestId("paeds-imm-give-mmr-2"));
    const save = screen.getByTestId("paeds-imm-save");
    expect(save).toBeDisabled(); // no batch yet
    await user.type(screen.getByTestId("paeds-imm-batch"), "MMR2231A");
    await user.selectOptions(screen.getByTestId("paeds-imm-site"), "right_upper_arm");
    await user.click(save);
    await waitFor(() => { expect(puts("/api/opd/visits/enc-1/sections/paeds.immunisation")).toHaveLength(1); });
    const sent = puts("/api/opd/visits/enc-1/sections/paeds.immunisation")[0]!;
    expect(sent.leaseToken).toBe("tab-1");
    expect((sent.body as { givenToday: unknown[] }).givenToday).toEqual([
      { id: "g-1", dose: "var-1", batch: "VZ88", site: "left_thigh", brand: "", errorReason: null },
      { dose: "mmr-2", batch: "MMR2231A", site: "right_upper_arm", brand: "", errorReason: null },
    ]);
  });

  it("tapping who gave the history saves the informant", async () => {
    stubFetch({
      "GET /api/opd/visits/enc-1/sections": WIRE,
      "PUT /api/opd/visits/enc-1/sections/paeds.informant": { record: { recordId: "r-3", at: "2026-09-28T04:20:00.000Z" } },
    });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByTestId("paeds-informant-mother"));
    await waitFor(() => { expect(puts("/api/opd/visits/enc-1/sections/paeds.informant")).toHaveLength(1); });
    expect(puts("/api/opd/visits/enc-1/sections/paeds.informant")[0]!.body).toMatchObject({ relation: "mother" });
    expect(screen.getByTestId("paeds-informant-mother")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows nothing that reads as a dose: no mg, mL or per-kg anywhere on the tab (§11.1 — dosing waits on a licence ruling)", async () => {
    stubFetch({ "GET /api/opd/visits/enc-1/sections": WIRE });
    render();
    const root = await screen.findByTestId("paeds-sections");
    expect(root.textContent).not.toMatch(/\bmg\b|\bml\b|\/\s*kg\b|per kg/i);
  });
});
