import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithRouter } from "../test-utils";
import { IcuStation } from "./icu-station";
import { IcuChart } from "./icu-chart";
import { IcuMyBeds } from "./icu-phone";
import { IcuRequests } from "./icu-desk";
import type { IcuChartView, IcuMyBedsView, IcuRequestView, IcuStationView, IcuTile } from "@hmis/contracts";

/**
 * ICU IC-1 (#984) — the screens: the station greys when the feed is lost (D7) and its alarms are acknowledged, never
 * silenced (D5); the chart shows device values as unchecked and a correction beside its struck original (D4); the
 * nurse's phone puts the alarming bed first; a request decision needs a reason (D1). Names are made up.
 */
const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const tile = (over: Partial<IcuTile> = {}): IcuTile => ({
  admissionId: "A1", patientName: "Ramesh Test", uhid: "UH-1", bedId: "B1", bedName: "MICU-01", dayOfStay: 2,
  latest: { hr: { value: 112, at: iso(5_000) }, spo2: { value: 93, at: iso(5_000) }, abp_sys: { value: 92, at: iso(5_000) }, abp_dia: { value: 50, at: iso(5_000) }, abp_map: { value: 64, at: iso(5_000) }, rr: { value: 22, at: iso(5_000) } },
  freshnessSeconds: 5, devices: [{ type: "monitor", code: "MON-1", linkedAt: iso(3_600_000) }], openAlarms: [], storm: false, limits: [],
  spark: { hr: [100, 104, 110, 112] }, bundlesDue: 1, bundlesMissed: 0, hourDue: false, ...over,
});

function stub(routes: Record<string, unknown>, perms: string[], posted: { path: string; body: unknown }[]): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = raw.split("?")[0]!;
    if (path.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ actor: { type: "user", id: "me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    if ((init?.method ?? "GET") === "POST") {
      posted.push({ path, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const hit = Object.entries(routes).find(([k]) => path.endsWith(k));
    return new Response(JSON.stringify(hit === undefined ? {} : hit[1]), { status: hit === undefined ? 404 : 200 });
  }));
}

describe("ICU screens (IC-1 #984)", () => {
  let posted: { path: string; body: unknown }[];
  beforeEach(() => { setToken("t"); posted = []; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("D7: the station turns every tile grey and says the feed is lost", async () => {
    const view: IcuStationView = {
      hallId: "H1", hallName: "MICU Hall 1", asOf: new Date(NOW).toISOString(), grey: true, mode: "manual",
      feedLastSeenAt: iso(7 * 60_000), gapSince: iso(7 * 60_000), tiles: [tile()],
    };
    stub({ "/icu/station/H1": view }, ["icu.view"], posted);
    renderWithRouter(<IcuStation hallId="H1" />);
    expect(await screen.findByRole("status")).toHaveTextContent(/Feed lost since .* chart by hand every hour/i);
    const t = await screen.findByTestId("icu-tile");
    expect(t).toHaveClass("grey");
    expect(t).toHaveTextContent("NO FEED");
  });

  it("D5: an alarm is acknowledged with \"I'm going\" — the screen says it never silences the monitor", async () => {
    const view: IcuStationView = {
      hallId: "H1", hallName: "MICU Hall 1", asOf: new Date(NOW).toISOString(), grey: false, mode: "live", feedLastSeenAt: iso(5_000), gapSince: null,
      tiles: [tile({ openAlarms: [{ id: "AL1", severity: "life_threatening", message: "VT run", rung: "station", raisedAt: iso(70_000), param: "hr" }] })],
    };
    stub({ "/icu/station/H1": view }, ["icu.view", "icu.care"], posted);
    renderWithRouter(<IcuStation hallId="H1" />);
    const aside = await screen.findByRole("complementary", { name: "Alarms now" });
    expect(aside).toHaveTextContent("MICU-01 · VT run");
    expect(aside).toHaveTextContent("never silences the monitor");
    expect(await screen.findByTestId("icu-tile")).toHaveClass("alarm");
    await userEvent.setup().click(within(aside).getByRole("button", { name: "I'm going" }));
    expect(posted).toEqual([{ path: "/api/icu/alarms/ack", body: { alarmId: "AL1" } }]);
  });

  it("D4: device values are unchecked until signed; a correction shows its struck original", async () => {
    const hour = new Date(Math.floor((NOW + 5.5 * 3_600_000) / 3_600_000) * 3_600_000 - 5.5 * 3_600_000 - 3_600_000).toISOString();
    const chart: IcuChartView = {
      admissionId: "A1", mode: "live",
      hours: [{
        id: "H-1", hourStart: hour, state: "draft", mode: "device", signedBy: null, signedAt: null,
        values: [
          { id: "v1", param: "hr", value: 100, source: "device", technical: null, happenedAt: hour, enteredAt: hour, enteredBy: null, reason: null, supersedes: null, current: false },
          { id: "v2", param: "hr", value: 92, source: "correction", technical: null, happenedAt: hour, enteredAt: hour, enteredBy: "n1", reason: "Shivering", supersedes: "v1", current: true },
          { id: "v3", param: "spo2", value: null, source: "device", technical: "probe_off", happenedAt: hour, enteredAt: hour, enteredBy: null, reason: null, supersedes: null, current: true },
          { id: "v4", param: "rr", value: 20, source: "device", technical: null, happenedAt: hour, enteredAt: hour, enteredBy: null, reason: null, supersedes: null, current: true },
        ],
      }],
    };
    stub({ "/icu/chart/A1": chart }, ["icu.view", "icu.care"], posted);
    renderWithRouter(<IcuChart admissionId="A1" />);
    const table = await screen.findByRole("table");
    const hrRow = within(table).getByText("HR").closest("tr")!;
    expect(hrRow.querySelector(".old")).toHaveTextContent("100");
    expect(hrRow).toHaveTextContent("10092");
    expect(within(table).getByText("SpO₂").closest("tr")).toHaveTextContent("probe off");
    expect(within(table).getByText("RR").closest("tr")!.querySelector(".dev")).toHaveTextContent("20");
    await userEvent.setup().click(screen.getByRole("button", { name: /Check and sign/ }));
    expect(posted).toEqual([{ path: "/api/icu/chart/sign", body: { hourId: "H-1" } }]);
  });

  it("the nurse's phone puts the alarming bed first, and 'I'm there' acknowledges it", async () => {
    const view: IcuMyBedsView = {
      asOf: new Date(NOW).toISOString(), grey: false,
      tiles: [
        tile({ admissionId: "A9", bedName: "MICU-04", openAlarms: [{ id: "AL9", severity: "life_threatening", message: "VT run", rung: "bed_nurse", raisedAt: iso(30_000), param: null }] }),
        tile({ hourDue: true }),
      ],
    };
    stub({ "/icu/my-beds": view }, ["icu.care"], posted);
    renderWithRouter(<IcuMyBeds />);
    const beds = await screen.findAllByTestId("icu-phone-bed");
    expect(beds[0]).toHaveTextContent("MICU-04");
    expect(beds[0]).toHaveClass("alarm");
    expect(beds[1]).toHaveTextContent("Sign the hour");
    await userEvent.setup().click(within(beds[0]!).getByRole("button", { name: "Open bed · I'm there" }));
    expect(posted[0]).toEqual({ path: "/api/icu/alarms/ack", body: { alarmId: "AL9" } });
  });

  it("D1: the intensivist decides a request only with a reason", async () => {
    const r: IcuRequestView = {
      id: "R1", patientId: "P1", patientName: "Sita Test", uhid: "UH-9", admissionId: null, source: "er", priorityClass: 1,
      triage: { sofa: 8 }, reason: "Septic shock", state: "pending", requestedBy: "d1", requestedAt: iso(600_000), approvalId: "AP1",
      decidedBy: null, decidedAt: null, decisionReason: null, reviewAt: null, monitoring: null,
    };
    stub({ "/icu/requests": [r] }, ["icu.view", "icu.decide"], posted);
    renderWithRouter(<IcuRequests />);
    const row = await screen.findByTestId("icu-request");
    expect(row).toHaveTextContent("ER · Priority 1 · SOFA 8");
    const approve = within(row).getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    const user = userEvent.setup();
    await user.type(within(row).getByRole("textbox", { name: "Reason" }), "Needs a ventilator");
    await user.click(approve);
    expect(posted).toEqual([{ path: "/api/icu/requests/R1/decision", body: { decision: "approve", reason: "Needs a ventilator" } }]);
  });
});
