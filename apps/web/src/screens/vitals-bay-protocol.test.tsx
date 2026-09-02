import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VitalsBay } from "./vitals-bay";
import { emptyTiles } from "./vitals-bay-capture";
import { heldFirstTake, holdFirstTake, isElevated, readingFrom, releaseFirstTake } from "./vitals-bay-protocol";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WireDangerRanges, WireEscalationView, WirePreStage } from "../lib/opd-api";

/**
 * VD-2 T3 — the danger protocol and the rest (stories 3 and 4), through the ASSEMBLED bay with two
 * patients. The server is a scripted stub that answers the protocol routes the way VD-1's
 * `escalation.ts` does — recheck_demanded, escalated with ten seconds, cancelled — and the bay is
 * asserted on what it POSTS and what it paints, never on its own arithmetic.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((ev: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
}
const ADULT = { key: "adult" as const, upToAgeYears: null, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"] as const,
  notRoutine: [] as const, ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {} };
const RANGES: WireDangerRanges = {
  weightRequiredUnderYears: 18,
  bands: [{ ...ADULT, required: [...ADULT.required], notRoutine: [] }],
  gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 },
  muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
};
const ROW_B: WireBenchRow = {
  encounterId: "E-B", entryId: "Q-B", tokenNo: 121, seq: 1, doctorId: "D-RAO", doctorName: "Dr Nishant Rao", serviceDate: "2026-09-02",
  patient: { requestedId: "P-B", id: "P-B", uhid: "UH-26-00121", name: "Ganesh Oraon", alias: null, restricted: false, administrativeGender: "male", dob: "1965-01-01" },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const ROW_S: WireBenchRow = { ...ROW_B, encounterId: "E-S", entryId: "Q-S", tokenNo: 118, seq: 2,
  patient: { ...ROW_B.patient!, requestedId: "P-S", id: "P-S", uhid: "UH-23-04417", name: "Sunita Devi", dob: "1971-03-02" } };
const ROW_C: WireBenchRow = { ...ROW_B, encounterId: "E-C", entryId: "Q-C", tokenNo: 125, seq: 3,
  patient: { ...ROW_B.patient!, requestedId: "P-C", id: "P-C", uhid: "UH-26-00125", name: "Kamla", dob: "1980-01-01" } };
const PRE = (patientId: string, last: WirePreStage["last"] = null): WirePreStage =>
  ({ patientId, ageYears: 55, band: "adult", required: [...ADULT.required], notRoutine: [], last, carryCandidates: [], expectedFlags: [] });
const JUNE = { vitalsId: "V0", recordedAt: "2026-06-11T04:00:00.000Z", serviceDate: "2026-06-11", heightCm: 151, weightKg: 62, sbp: 132, dbp: 84, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, muacCm: null };

type Call = { key: string; body: unknown };
function stubBay(rows: WireBenchRow[], calls: Call[]): { set: (encounterId: string, v: WireEscalationView | null) => void } {
  // the protocol's state lives PER ENCOUNTER on the server, exactly as `opd_queue_entries.escalation` does
  const states = new Map<string, WireEscalationView | null>();
  const encounterOf = (path: string): string => /\/opd\/visits\/([^/]+)\//.exec(path)?.[1] ?? "";
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) as unknown : undefined;
    if (init?.method === "POST") calls.push({ key, body });
    if (key === "GET /api/auth/me") return json({ actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/opd/bench") return json({ items: rows });
    if (key === "GET /api/opd/queues/summary") return json({ items: [] });
    if (key === "GET /api/opd/departments") return json({ items: [] });
    if (key === "GET /api/opd/config") return json({ dangerRanges: RANGES, counterSequence: "queue_first", tokenLane: "token_first" });
    if (key === "GET /api/opd/visits/E-B/prestage") return json(PRE("P-B"));
    if (key === "GET /api/opd/visits/E-S/prestage") return json(PRE("P-S", JUNE));
    if (key === "GET /api/opd/visits/E-C/prestage") return json(PRE("P-C"));
    const enc = encounterOf(path);
    if (key.endsWith("/escalation")) return json({ escalation: states.get(enc) ?? null });
    if (key.endsWith("/escalation/recheck")) {
      const r = body as { sbp?: number };
      if (r.sbp !== undefined && r.sbp <= 180) return json({ statusCode: 409, code: "escalation_not_warranted", message: "inside the band" }, 409);
      const v: WireEscalationView = { entryId: "Q-B", state: "recheck_demanded", escalatedAt: null, escalatedFromClass: null, escalationBy: null, cancelMsRemaining: 0 };
      states.set(enc, v); return json(v);
    }
    if (key.endsWith("/escalation/escalate")) {
      const r = body as { sbp?: number };
      if (r.sbp !== undefined && r.sbp <= 180) return json({ statusCode: 409, code: "escalation_not_warranted", message: "the recheck is inside the patient's band" }, 409);
      const v: WireEscalationView = { entryId: "Q-B", state: "escalated", escalatedAt: "2026-09-02T04:30:00.000Z", escalatedFromClass: 3, escalationBy: null, cancelMsRemaining: 10_000 };
      states.set(enc, v); return json(v);
    }
    if (key.endsWith("/escalation/cancel")) {
      const v: WireEscalationView = { entryId: "Q-B", state: "cancelled", escalatedAt: "2026-09-02T04:30:00.000Z", escalatedFromClass: 3, escalationBy: "u-vd", cancelMsRemaining: 0 };
      states.set(enc, v); return json(v);
    }
    if (key.endsWith("/bench-state")) return json({ ...ROW_S, benchState: "resting", recallAt: "2026-09-02T04:35:00.000Z" });
    if (key.endsWith("/vitals")) return json({ vitals: { id: "V-NEW" }, flags: [{ vital: "sbp", value: 214, bound: "max", limit: 180, severity: "danger" }], encounter: { id: "E" } });
    return new Response("{}", { status: 404 });
  }));
  return { set: (encounterId, v) => { states.set(encounterId, v); } };
}

beforeEach(() => { vi.stubGlobal("WebSocket", FakeWebSocket); resetRealtimeClientForTests(); setToken("t"); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("the pure rules", () => {
  it("isElevated: within 20/10 of the ceiling, or 20 above the last chart — never at danger numbers, never on a not-routine BP", () => {
    const band = RANGES.bands[0]!;
    expect(isElevated([172, 104], band, null)).toBe(true);
    expect(isElevated([150, 95], band, null)).toBe(false);
    expect(isElevated([155, 90], band, JUNE)).toBe(true);     // 132 + 20
    expect(isElevated([208, 126], band, null)).toBe(false);   // danger: rest refused
    expect(isElevated([172, 104], { ...band, notRoutine: ["sbp", "dbp"] }, null)).toBe(false);
  });
  it("readingFrom carries the operative numbers in the wire's vocabulary; the held first take survives a round trip and is released", () => {
    const t = emptyTiles(); t.bp.takes = [[208, 126], [214, 132]]; t.pulse.takes = [104]; t.spo2.takes = [95];
    expect(readingFrom(t)).toEqual({ sbp: 214, dbp: 132, pulse: 104, spo2: 95 });
    holdFirstTake("E-X", [172, 104]);
    expect(heldFirstTake("E-X")).toEqual([172, 104]);
    releaseFirstTake("E-X");
    expect(heldFirstTake("E-X")).toBeNull();
  });
});

describe("VD-2 T3 — story 3: the escalation, through the ASSEMBLED bay", () => {
  it("208/126 → the tile goes brick and the OTHER ARM is demanded; 214/132 → class 0 with a ten-second CANCEL; cancel restores; the save carries the PAIR", async () => {
    const calls: Call[] = [];
    stubBay([ROW_B, ROW_C], calls);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
    await user.keyboard("208/126{Enter}");
    expect(screen.getByTestId("tile-bp").getAttribute("data-tint")).toBe("danger");
    await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("recheck_demanded"));
    expect(screen.getByTestId("protocol-demand").textContent).toContain("OTHER ARM");
    expect(calls.filter((c) => c.key.endsWith("/escalation/recheck"))).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ sbp: 208, dbp: 126 });
    expect(screen.queryByTestId("rest-offer")).not.toBeInTheDocument();     // rest is refused at danger numbers

    await user.click(screen.getByTestId("input-bp"));
    await user.keyboard("214/132{Enter}");
    await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("escalated"));
    expect(screen.getByTestId("pair-bp").textContent).toBe("208/126 · 214/132");
    expect(screen.getByTestId("protocol-escalated").textContent).toContain("Dr Nishant Rao");
    expect(screen.getByTestId("protocol-countdown").textContent).toMatch(/^(10|9)s$/);
    const escalate = calls.find((c) => c.key.endsWith("/escalation/escalate"))!;
    expect(escalate.body).toEqual({ sbp: 214, dbp: 132 });

    fireEvent.click(screen.getByTestId("protocol-cancel"));
    await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("cancelled"));
    expect(screen.getByTestId("protocol-cancelled").textContent).toContain("class 3");
    expect(calls.filter((c) => c.key.endsWith("/escalation/cancel"))).toHaveLength(1);

    // Save & send NOW: the pair goes, both takes, never averaged
    await user.click(screen.getByTestId("input-pulse")); await user.keyboard("104{Enter}");
    await user.click(screen.getByTestId("input-spo2")); await user.keyboard("95{Enter}");
    fireEvent.click(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
    const save = calls.find((c) => c.key.endsWith("/vitals"))!;
    expect((save.body as { readings: { bp: { takes: unknown } }; emergency: boolean }).readings.bp.takes).toEqual([[208, 126], [214, 132]]);
    expect((save.body as { emergency: boolean }).emergency).toBe(true);
    expect(screen.getByTestId("saved-danger").textContent).toContain("sbp 214");

    // C — a second patient, nothing carries: no protocol panel, no pair, no countdown
    fireEvent.click(screen.getByTestId("bench-row-125"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    expect(screen.queryByTestId("protocol")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pair-bp")).not.toBeInTheDocument();
    expect(screen.getByTestId("value-bp").textContent).toBe("—");
  });

  it("the other arm inside the band CALMS the protocol: the server's 409 escalation_not_warranted is a sentence, both readings stay as a pair, the board does not move", async () => {
    const calls: Call[] = [];
    stubBay([ROW_B], calls);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
    await user.keyboard("208/126{Enter}");
    await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("recheck_demanded"));
    await user.click(screen.getByTestId("input-bp"));
    await user.keyboard("150/92{Enter}");
    // a calm second take is not "danger": the tile is not re-offered to the protocol at all — the nurse saves the pair
    expect(screen.getByTestId("pair-bp").textContent).toBe("208/126 · 150/92");
    expect(calls.filter((c) => c.key.endsWith("/escalation/escalate"))).toHaveLength(0);
    expect(screen.queryByTestId("protocol-escalated")).not.toBeInTheDocument();
    expect(screen.queryByTestId("protocol-error")).not.toBeInTheDocument();
  });
});

describe("VD-2 T3 — story 4: rest-and-recheck, the recall on the bench, the pair", () => {
  it("172/104 against June's 132 offers the rest chairs; resting posts the bench state and clears the desk; another patient is taken; Sunita returns with her first reading HELD and the save carries the pair", async () => {
    const calls: Call[] = [];
    stubBay([ROW_S, ROW_C], calls);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
    await user.keyboard("172/104{Enter}");
    expect(screen.getByTestId("tile-bp").getAttribute("data-tint")).toBe("");            // inside the band
    await waitFor(() => expect(screen.getByTestId("rest-offer")).toBeInTheDocument());
    expect(calls.filter((c) => c.key.includes("/escalation/"))).toHaveLength(0);         // not a danger: the protocol was not asked
    fireEvent.click(screen.getByTestId("rest-go"));
    await waitFor(() => expect(screen.getByTestId("rest-banner")).toBeInTheDocument());
    const rest = calls.find((c) => c.key.endsWith("/bench-state"))!;
    expect(rest.key).toContain("/opd/visits/E-S/bench-state");
    expect(rest.body).toEqual({ state: "resting", restMinutes: 5, note: "first reading 172/104" });
    expect(screen.getByTestId("rest-banner").textContent).toContain("Sunita Devi");
    expect(screen.getByTestId("rest-banner").textContent).toContain("10:05");   // 04:35Z on the bench row = 10:05 IST
    expect(screen.getByTestId("session-empty")).toBeInTheDocument();

    // Kamla in between: no held reading, no offer
    fireEvent.click(screen.getByTestId("bench-row-125"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    expect(screen.queryByTestId("held-first-take")).not.toBeInTheDocument();
    expect(screen.getByTestId("value-bp").textContent).toBe("—");

    // Sunita is recalled: the first reading is restored, the second lands, the pair is saved
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("held-first-take")).toBeInTheDocument());
    expect(screen.getByTestId("held-first-take").textContent).toContain("172/104");
    expect(screen.getByTestId("value-bp").textContent).toBe("172/104");
    await user.click(screen.getByTestId("input-bp")); await user.keyboard("128/82{Enter}");
    expect(screen.getByTestId("pair-bp").textContent).toBe("172/104 · 128/82");
    expect(screen.queryByTestId("rest-offer")).not.toBeInTheDocument();           // a second take never re-offers rest
    await user.click(screen.getByTestId("input-pulse")); await user.keyboard("80{Enter}");
    await user.click(screen.getByTestId("input-spo2")); await user.keyboard("98{Enter}");
    await user.click(screen.getByTestId("input-tempC")); await user.keyboard("36.7{Enter}");
    await user.click(screen.getByTestId("input-weightKg")); await user.keyboard("62{Enter}");
    await user.click(screen.getByTestId("input-heightCm")); await user.keyboard("151{Enter}");
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
    const save = calls.find((c) => c.key.endsWith("/vitals"))!;
    expect((save.body as { readings: { bp: { takes: unknown } } }).readings.bp.takes).toEqual([[172, 104], [128, 82]]);
    expect(heldFirstTake("E-S")).toBeNull();   // released with the save
  });

  it("the countdown is cosmetic and it DECAYS: ten seconds after the server opened the window, CANCEL is gone and 'class 0 stands' is painted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls: Call[] = [];
      stubBay([ROW_B], calls);
      renderWithProviders(<VitalsBay />);
      await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("bench-row-121"));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
      fireEvent.change(screen.getByTestId("input-bp"), { target: { value: "208/126" } });
      fireEvent.keyDown(screen.getByTestId("input-bp"), { key: "Enter" });
      await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("recheck_demanded"));
      fireEvent.change(screen.getByTestId("input-bp"), { target: { value: "214/132" } });
      fireEvent.keyDown(screen.getByTestId("input-bp"), { key: "Enter" });
      await waitFor(() => expect(screen.getByTestId("protocol-countdown")).toBeInTheDocument());
      const first = Number(screen.getByTestId("protocol-countdown").textContent!.replace("s", ""));
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
      const later = Number(screen.getByTestId("protocol-countdown").textContent!.replace("s", ""));
      expect(later).toBeLessThan(first);
      expect(later).toBeLessThanOrEqual(6);
      await act(async () => { await vi.advanceTimersByTimeAsync(7_000); });
      expect(screen.queryByTestId("protocol-cancel")).not.toBeInTheDocument();
      expect(screen.getByTestId("protocol-committed")).toBeInTheDocument();
      // the tiles were never repainted by the tick: the pair is still there, the input still exists
      expect(screen.getByTestId("pair-bp").textContent).toBe("208/126 · 214/132");
      expect(screen.getByTestId("input-bp")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a re-identified patient shows the protocol where the SERVER left it — an escalation survives the bay's own memory", async () => {
    const calls: Call[] = [];
    const server = stubBay([ROW_B], calls);
    server.set("E-B", { entryId: "Q-B", state: "escalated", escalatedAt: "2026-09-02T04:30:00.000Z", escalatedFromClass: 3, escalationBy: null, cancelMsRemaining: 0 });
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("escalated"));
    expect(screen.getByTestId("protocol-committed")).toBeInTheDocument();   // window closed: no CANCEL button
    expect(screen.queryByTestId("protocol-cancel")).not.toBeInTheDocument();
    await act(async () => { /* settle */ });
  });
});
