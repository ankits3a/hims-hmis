import { screen, within } from "@testing-library/react";
import { setToken } from "../../lib/api";
import { renderWithProviders } from "../../test-utils";
import { DoctorDeskTower } from "../doctor-desk-tower";
import { DoctorDeskBeds } from "../doctor-desk-beds";
import { RoundNoteQueue, memoryNoteStore } from "../../lib/round-queue";
import type { WireTower, WireTowerWard, WireWardBeds } from "../../lib/doctor-desk-api";

/**
 * ACCEPTANCE — issue #962, spec docs/specs/962-doctor-desk-ward.md (owner APPROVED 2026-10-26), the screens:
 *
 *   D3  the Tower's inpatient tiles equal the census, and each bed dot's colour equals the bed's flag from IPD.
 *   D4  Beds lists a unit patient lodged in another ward under "Not in your ward".
 *   D6  (phone side) five round notes signed with the phone offline land exactly once after reconnecting, each with its
 *       signing time and its sync time.
 */
const AT = "2026-03-10T09:30:00.000Z";

const WARD: WireTowerWard = {
  takeDay: "2026-03-10",
  census: {
    takeDay: "2026-03-10", from: "2026-03-10T02:30:00.000Z", to: "2026-03-11T02:30:00.000Z",
    admitted: 6, discharged: 2, lama: 1, absconded: 0, deaths: 1, transfersIn: 1, transfersOut: 0, occupied: 19, bedsAtMidnight: null,
  },
  totalBeds: 24,
  critical: 1,
  dischargeCandidates: 1,
  beds: [
    { bedId: "b1", bedCode: "G-201", status: "occupied", flag: "none", outlier: false },
    { bedId: "b2", bedCode: "G-204", status: "occupied", flag: "owed", outlier: false },
    { bedId: "b3", bedCode: "G-214", status: "occupied", flag: "critical", outlier: false },
    { bedId: "b4", bedCode: "G-225", status: "occupied", flag: "could_go_home", outlier: false },
    { bedId: "b5", bedCode: "G-230", status: "free", flag: "none", outlier: false },
  ],
};

const TOWER: WireTower = {
  at: AT, istDate: "2026-03-10",
  you: { userId: "sr", name: "Dr. Test Senior", grade: "senior_resident" },
  unit: { teamId: "u2", name: "General Medicine Unit II", short: "Unit II", departmentName: "General Medicine" },
  mode: "plain",
  tiles: { booked: null, seen: null, waiting: null, longestWaitMinutes: null, resultsToReview: 0, papersToSign: 0 },
  attention: [], tabCounts: { all: 0, critical: 0, change: 0, new: 0, pending: 0 },
  unitOverview: [], clocks: [], schedule: [], team: [], brief: null, briefsWaiting: 0, agentRuns: [],
  ward: WARD,
};

const patient = (id: string, name: string) => ({ id, uhid: `HMS-${id}`, name, restricted: false });
const BEDS: WireWardBeds = {
  at: AT, istDate: "2026-03-10",
  unit: TOWER.unit,
  beds: [
    { bedId: "b1", bedCode: "G-201", wardCode: "G-2", wardName: "Ward G-2", status: "occupied", flag: "none", outlier: false, changed: false,
      occupant: { admissionId: "a1", patient: patient("p1", "Patient Alpha"), ageSex: "70 M", dx: "Synthetic COPD", dayOfStay: 6, ews: { kind: "news2", value: 2, band: "low" }, tags: [] } },
    { bedId: "b3", bedCode: "G-214", wardCode: "G-2", wardName: "Ward G-2", status: "occupied", flag: "critical", outlier: false, changed: true,
      occupant: { admissionId: "a3", patient: patient("p3", "Patient Gamma"), ageSex: "64 M", dx: "Synthetic sepsis", dayOfStay: 4, ews: { kind: "news2", value: 8, band: "high" }, tags: [] } },
  ],
  outliers: [
    { bedId: "s1", bedCode: "S-112", wardCode: "S-1", wardName: "Surgery ward", status: "occupied", flag: "none", outlier: true, changed: true,
      occupant: { admissionId: "a9", patient: patient("p9", "Patient Lodged"), ageSex: "66 F", dx: "Synthetic pneumonia", dayOfStay: 2, ews: null, tags: [] } },
  ],
  free: 0,
};

function stub(routes: Record<string, unknown>): string[] {
  const posted: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method === "POST") posted.push(raw);
    const hit = Object.keys(routes).find((k) => raw.endsWith(k));
    const body = raw.endsWith("/auth/me")
      ? { actor: { type: "user", id: "sr" }, permissions: { hospital: ["opd.consult", "ipd.round.sign"], scoped: { department: {}, floor: {} } }, modules: { dark: [], on: ["ipd"] } }
      : raw.endsWith("/ops/mode") ? { mode: "normal", since: null, note: null, reportId: null }
        : hit === undefined ? {} : routes[hit];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return posted;
}

describe("#962 — the Doctor Desk ward, part 1", () => {
  beforeEach(() => { setToken("t"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("spec #962 D3: the Tower's inpatient tiles equal the census; each bed dot's colour equals the bed's flag", async () => {
    stub({ "/doctor-desk/tower": TOWER });
    renderWithProviders(<DoctorDeskTower />);
    expect(await screen.findByTestId("dd-tile-inpatients")).toHaveTextContent(String(WARD.census.occupied));
    expect(screen.getByTestId("dd-tile-newOnTake")).toHaveTextContent(String(WARD.census.admitted));
    expect(screen.getByTestId("dd-tile-review")).toHaveTextContent(String(WARD.critical));
    const map = screen.getByTestId("dd-bedmap");
    for (const b of WARD.beds) {
      const dot = within(map).getByTestId(`dd-bed-dot-${b.bedId}`);
      expect(dot.dataset.flag).toBe(b.status === "free" ? "free" : b.flag);
      expect(dot.className).toContain(b.status === "free" ? "dd-dot-free" : `dd-dot-${b.flag}`);
    }
    // A figure the reads cannot give (the midnight census before midnight) is absent, never a zero.
    expect(screen.queryByTestId("dd-ov-midnight")).toBeNull();
  });

  it("spec #962 D3 (absent, not zero): with no inpatient read the inpatient tiles and the bed map are absent", async () => {
    stub({ "/doctor-desk/tower": { ...TOWER, ward: null } });
    renderWithProviders(<DoctorDeskTower />);
    await screen.findByTestId("dd-summary");
    expect(screen.queryByTestId("dd-tile-inpatients")).toBeNull();
    expect(screen.queryByTestId("dd-bedmap")).toBeNull();
  });

  it("spec #962 D4: Beds lists a unit patient lodged in another ward under \"Not in your ward\"", async () => {
    stub({ "/doctor-desk/ward/beds": BEDS });
    renderWithProviders(<DoctorDeskBeds />);
    const outliers = await screen.findByTestId("dd-beds-outliers");
    expect(within(outliers).getByText("Not in your ward", { exact: false })).toBeInTheDocument();
    expect(within(outliers).getByText("Patient Lodged", { exact: false })).toBeInTheDocument();
    expect(within(outliers).getByText("S-112")).toBeInTheDocument();
    const list = screen.getByTestId("dd-beds-list");
    expect(within(list).queryByText("Patient Lodged", { exact: false })).toBeNull();
    expect(within(list).getByText("Patient Alpha", { exact: false })).toBeInTheDocument();
  });

  it("spec #962 D6: five notes signed offline land exactly once after reconnecting, each with its signing time and sync time", async () => {
    let online = false;
    const sent: { key: string; seenAt: string }[] = [];
    let clock = new Date("2026-03-10T09:30:00.000Z");
    const q = new RoundNoteQueue(memoryNoteStore(), async (body) => {
      if (!online) throw new TypeError("Failed to fetch");
      sent.push({ key: body.idempotencyKey, seenAt: body.seenAt });
      return { roundId: `r-${body.idempotencyKey}`, status: "signed" as const };
    }, () => clock);

    const signed: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock = new Date(Date.parse("2026-03-10T09:30:00.000Z") + i * 60_000);
      const n = await q.sign({ admissionId: "a3", mode: "bedside", soap: { assessment: `Synthetic note ${String(i)}` } });
      signed.push(n.signedAt);
      expect(n.status).toBe("queued");
    }
    expect(sent).toHaveLength(0);
    expect((await q.list()).filter((n) => n.status === "queued")).toHaveLength(5);

    online = true;
    clock = new Date("2026-03-10T10:00:00.000Z");
    expect(await q.replay()).toMatchObject({ sent: 5, conflicts: 0 });
    expect(await q.replay()).toMatchObject({ sent: 0, conflicts: 0 });
    expect(sent).toHaveLength(5);
    expect(new Set(sent.map((s) => s.key)).size).toBe(5);
    expect(sent.map((s) => s.seenAt).sort()).toEqual([...signed].sort());

    const all = await q.list();
    expect(all).toHaveLength(5);
    for (const n of all) {
      expect(n.status).toBe("synced");
      expect(signed).toContain(n.signedAt);
      expect(n.syncedAt).toBe("2026-03-10T10:00:00.000Z");
      expect(n.idempotencyKey).toBe(n.clientId);
    }
  });
});
