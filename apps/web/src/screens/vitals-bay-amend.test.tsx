import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VitalsBay } from "./vitals-bay";
import { activeChart, amendedReadings, diffOf } from "./vitals-bay-amend";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WireVitals } from "../lib/opd-api";

/**
 * VD-2 T4 — amend after save (story 7). The ✓ row re-opens the chart ON A COPY; the reason is the
 * record; the diff is the trail; Escape abandons and the saved chart is byte-identical when it is
 * re-opened. Two patients, so B's ✓ row cannot inherit A's abandoned edit.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((ev: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
}
const chart = (id: string, encounterId: string, patientId: string, over: Partial<WireVitals> = {}): WireVitals => ({
  id, encounterId, patientId, heightCm: 151, weightKg: 62, sbp: 128, dbp: 84, pulse: 78, rr: 16, spo2: 97, tempC: 36.8, muacCm: null, notes: null,
  ageYearsAtRecord: 55, band: "adult",dangerFlags: [], recordedBy: "u-vd", recordedAt: "2026-09-02T04:20:00.000Z",
  readings: {}, contextChips: [], carriedForward: [], supersedesVitalsId: null, amendmentReason: null, status: "active", emergency: false, ...over,
});
const ROW_A: WireBenchRow = {
  encounterId: "E-A", entryId: "Q-A", tokenNo: 118, seq: 1, doctorId: "D-RAO", doctorName: "Dr Nishant Rao", serviceDate: "2026-09-02",
  patient: { requestedId: "P-A", id: "P-A", uhid: "UH-23-04417", name: "Sunita Devi", alias: null, restricted: false, administrativeGender: "female", dob: "1971-03-02" },
  benchState: null, recallAt: null, vitalsDone: true, vitalsId: "V-A1", escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const ROW_B: WireBenchRow = { ...ROW_A, encounterId: "E-B", entryId: "Q-B", tokenNo: 121, seq: 2, vitalsId: "V-B1",
  patient: { ...ROW_A.patient!, requestedId: "P-B", id: "P-B", uhid: "UH-26-00121", name: "Ganesh Oraon" } };

type Call = { key: string; body: unknown };
function stubBay(seed: WireBenchRow[], calls: Call[], charts: Record<string, WireVitals[]>, onAmend?: (body: Record<string, unknown>, prior: WireVitals) => Response | null): void {
  const rows = seed.map((r) => ({ ...r }));   // the stub mutates vitalsId after an amend; the module constants must not carry that into the next test
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) as unknown : undefined;
    if (init?.method === "POST") calls.push({ key, body });
    if (key === "GET /api/auth/me") return json({ actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record", "opd.visits.read"], scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/opd/bench") return json({ items: rows });
    if (key === "GET /api/opd/queues/summary") return json({ items: [] });
    if (key === "GET /api/opd/departments") return json({ code: "forbidden" }, 403);
    if (key === "GET /api/opd/config") return json({ code: "forbidden" }, 403);
    const g = /\/opd\/vitals\/([^/]+)$/.exec(path);
    if (g !== null && init?.method !== "POST") {
      const v = Object.values(charts).flat().find((x) => x.id === g[1]);
      return v === undefined ? json({ code: "unknown_vitals" }, 404) : json({ vitals: v });
    }
    if (key.startsWith("POST /api/opd/vitals/") && key.endsWith("/amend")) {
      const id = /\/opd\/vitals\/([^/]+)\/amend/.exec(path)![1]!;
      const b = body as Record<string, number | null> & { reason: string; readings?: unknown; carriedForward?: string[]; unlockReasons?: Record<string, string>; overrides?: Record<string, string> };
      const prior = Object.values(charts).flat().find((v) => v.id === id)!;
      if (onAmend !== undefined) { const r = onAmend(b, prior); if (r !== null) return r; }
      const next = chart(`${id}-amended`, prior.encounterId, prior.patientId, {
        heightCm: b.heightCm ?? null, weightKg: b.weightKg ?? null, sbp: b.sbp ?? null, dbp: b.dbp ?? null, pulse: b.pulse ?? null, rr: b.rr ?? null,
        spo2: b.spo2 ?? null, tempC: b.tempC ?? null, muacCm: b.muacCm ?? null,
        supersedesVitalsId: id, amendmentReason: b.reason, recordedAt: "2026-09-02T04:31:00.000Z",
        readings: b.readings ?? {}, carriedForward: b.carriedForward ?? [],
      });
      const flags = (b.spo2 ?? 100) < 90 ? [{ vital: "spo2", value: b.spo2, bound: "min", limit: 90, severity: "danger" }] : [];
      charts[prior.encounterId] = [{ ...prior, status: "superseded" }, next];
      const r = rows.find((x) => x.encounterId === prior.encounterId); if (r !== undefined) r.vitalsId = next.id;   // the bench re-reads the new active id
      return json({ vitals: next, flags, superseded: id });
    }
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { vi.stubGlobal("WebSocket", FakeWebSocket); resetRealtimeClientForTests(); setToken("t"); sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("the pure rules", () => {
  it("diffOf names each changed scalar with its old and new value; activeChart picks the active row the bench points at", () => {
    const a = chart("V1", "E", "P"); const b = chart("V2", "E", "P", { weightKg: 64, spo2: null });
    expect(diffOf(a, b)).toEqual([{ key: "weightKg", from: 62, to: 64 }, { key: "spo2", from: 97, to: null }]);
    expect(activeChart([{ ...a, status: "superseded" }, b], "V2")?.id).toBe("V2");
    expect(activeChart([{ ...a, status: "superseded" }, b], "V1")?.id).toBe("V2"); // the bench's id is superseded → the latest active
    expect(activeChart([], null)).toBeNull();
  });
});

describe("CLOSE pass 1 — the amendment keeps the pair, unlocks a carried key with a reason, and answers a gate", () => {
  it("amendedReadings replaces the OPERATIVE take of a changed key and keeps the rest — the pair, the held value, the device source", () => {
    const prior = chart("V1", "E", "P", { sbp: 214, dbp: 132, spo2: 96, readings: { bp: { takes: [[208, 126], [214, 132]], source: "typed" }, spo2: { takes: [96], source: "device", held: [45] } } });
    const r = amendedReadings(prior, { weightKg: 64, spo2: 95, sbp: 214, dbp: 130 });
    expect(r.bp).toEqual({ takes: [[208, 126], [214, 130]], source: "typed" });
    expect(r.spo2).toEqual({ takes: [95], source: "device", held: [45] });
    expect(r.weightKg).toEqual({ takes: [64], source: "typed" });
  });

  it("amending Ganesh's weight posts his BP PAIR untouched, his notes, his chips; changing a CARRIED height asks for a reason and sends it", async () => {
    const calls: Call[] = [];
    const g = chart("V-A1", "E-A", "P-A", { sbp: 214, dbp: 132, notes: "escort sent", carriedForward: ["heightCm"], readings: { bp: { takes: [[208, 126], [214, 132]], source: "typed" }, heightCm: { takes: [], source: "typed" } } });
    stubBay([ROW_A], calls, { "E-A": [g] });
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    await user.clear(screen.getByTestId("amend-weightKg")); await user.type(screen.getByTestId("amend-weightKg"), "64");
    await user.type(screen.getByTestId("amend-reason"), "re-weighed");
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(calls).toHaveLength(1));
    const b1 = calls[0]!.body as { readings: { bp: { takes: unknown } }; notes: string; carriedForward: string[]; heightCm: number };
    expect(b1.readings.bp.takes).toEqual([[208, 126], [214, 132]]);   // the pair survives the correction
    expect(b1.notes).toBe("escort sent");
    expect(b1.carriedForward).toEqual(["heightCm"]);
    expect(b1.heightCm).toBe(151);

    // the carried height changed: a reason is asked BEFORE the round trip, then it travels
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    await user.clear(screen.getByTestId("amend-heightCm")); await user.type(screen.getByTestId("amend-heightCm"), "149");
    await user.type(screen.getByTestId("amend-reason"), "measured again");
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(screen.getByTestId("amend-unlock-heightCm")).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    fireEvent.change(screen.getByTestId("amend-unlock-heightCm"), { target: { value: "patient_disputes_old_value" } });
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(calls).toHaveLength(2));
    const b2 = calls[1]!.body as { unlockReasons: Record<string, string>; carriedForward: string[]; heightCm: number };
    expect(b2.unlockReasons).toEqual({ heightCm: "patient_disputes_old_value" });
    expect(b2.carriedForward).toEqual([]);
    expect(b2.heightCm).toBe(149);
  });

  it("a gate the server raises on the amendment is confirmed, not dead-ended: overrides travel on the retry", async () => {
    const calls: Call[] = [];
    let n = 0;
    stubBay([ROW_A], calls, { "E-A": [chart("V-A1", "E-A", "P-A")] }, () => {
      n += 1;
      return n === 1 ? new Response(JSON.stringify({ statusCode: 409, code: "vitals_gate", message: "4.8 kg on an adult", detail: { gates: [{ key: "weightKg", kind: "slipped_digit", value: 22, message: "22 kg on an adult — a slipped digit" }] } }), { status: 409, headers: { "Content-Type": "application/json" } }) : null;
    });
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    await user.clear(screen.getByTestId("amend-weightKg")); await user.type(screen.getByTestId("amend-weightKg"), "22");
    await user.type(screen.getByTestId("amend-reason"), "cachexia — it is real");
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(screen.getByTestId("amend-gate-weightKg")).toBeInTheDocument());
    expect(screen.queryByTestId("amend-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("amend-gate-confirm-weightKg"));
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect((calls[1]!.body as { overrides: Record<string, string> }).overrides).toEqual({ weightKg: "confirmed_real" });
  });
});

describe("VD-2 T4 — the ASSEMBLED bay: amend after save, two patients", () => {
  it("A's ✓ row re-opens her chart; weight 62 → 64 with a reason posts the amend; the trail names the old value, the actor and the clock; B's ✓ row shows B's chart, not A's edit", async () => {
    const calls: Call[] = [];
    const charts = { "E-A": [chart("V-A1", "E-A", "P-A")], "E-B": [chart("V-B1", "E-B", "P-B", { weightKg: 71 })] };
    stubBay([ROW_A, ROW_B], calls, charts);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    expect(screen.getByTestId("bench-row-118").getAttribute("data-state")).toBe("done");
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    expect(screen.getByTestId("amend").getAttribute("data-vitals")).toBe("V-A1");
    expect(screen.queryByTestId("capture")).not.toBeInTheDocument();
    expect((screen.getByTestId("amend-weightKg") as HTMLInputElement).value).toBe("62");
    expect(screen.getByTestId("amend-save")).toBeDisabled();            // nothing changed yet

    await user.clear(screen.getByTestId("amend-weightKg"));
    await user.type(screen.getByTestId("amend-weightKg"), "64");
    expect(screen.getByTestId("amend-save")).toBeEnabled();
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(screen.getByTestId("amend-error")).toBeInTheDocument());   // a reason is the record
    expect(calls).toHaveLength(0);
    await user.type(screen.getByTestId("amend-reason"), "scale read 64, typed 62");
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe("POST /api/opd/vitals/V-A1/amend");
    expect(calls[0]!.body).toMatchObject({ weightKg: 64, heightCm: 151, sbp: 128, dbp: 84, reason: "scale read 64, typed 62", emergency: false });
    expect(screen.getByTestId("saved-banner").textContent).toContain("Amended Sunita Devi");
    expect(screen.getByTestId("trail-weightKg").textContent).toContain("62 → 64");
    expect(screen.getByTestId("trail-weightKg").textContent).toContain("u-vd");
    expect(screen.getByTestId("trail-weightKg").textContent).toContain("10:01");  // 04:31Z in IST
    expect(screen.getByTestId("session-empty")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("amend").getAttribute("data-vitals")).toBe("V-B1"));
    expect((screen.getByTestId("amend-weightKg") as HTMLInputElement).value).toBe("71");
  });

  it("Escape abandons the copy: no POST, and re-opening the chart shows the SAVED value, not the abandoned edit", async () => {
    const calls: Call[] = [];
    const charts = { "E-A": [chart("V-A1", "E-A", "P-A")] };
    stubBay([ROW_A], calls, charts);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    await user.clear(screen.getByTestId("amend-pulse"));
    await user.type(screen.getByTestId("amend-pulse"), "110");
    await user.type(screen.getByTestId("amend-reason"), "changed my mind");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    expect((screen.getByTestId("amend-pulse") as HTMLInputElement).value).toBe("78");
    expect((screen.getByTestId("amend-reason") as HTMLInputElement).value).toBe("");
  });

  it("an amendment that REVEALS a danger says so in the banner — SpO₂ 97 corrected to 85", async () => {
    const calls: Call[] = [];
    stubBay([ROW_A], calls, { "E-A": [chart("V-A1", "E-A", "P-A")] });
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
    await user.clear(screen.getByTestId("amend-spo2")); await user.type(screen.getByTestId("amend-spo2"), "85");
    await user.type(screen.getByTestId("amend-reason"), "probe on the wrong finger");
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(screen.getByTestId("saved-danger")).toBeInTheDocument());
    expect(screen.getByTestId("saved-danger").textContent).toContain("spo2 85");
  });
});
