import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VitalsBay } from "./vitals-bay";
import {
  buildBody, emptyTiles, flagOf, humanDate, leadTileFor, mirrorFor, missingFor, parseTake, readLane, tileOrder, tileSetFor,
} from "./vitals-bay-capture";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WireDangerRanges, WirePreStage } from "../lib/opd-api";

/**
 * VD-2 T2 — the capture core (stories 2, 5, 6): tiles, the typing lane, the band, the gate mirrors,
 * the carried lock, the emergency set, the bold ✓. Two patients through the ASSEMBLED bay in every
 * screen test (D8); the server's answers are stubbed at the status the contract names (409 for a
 * clinical refusal, never a transport error).
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((ev: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
}

const RANGES: WireDangerRanges = {
  weightRequiredUnderYears: 18,
  bands: [
    { key: "infant", upToAgeYears: 1, required: ["weightKg", "tempC", "spo2", "pulse", "muacCm"], notRoutine: ["sbp", "dbp"],
      ranges: { sbp: { min: 65, max: 120 }, dbp: { min: 40, max: 80 }, pulse: { min: 90, max: 180 }, rr: { min: 25, max: 60 }, spo2: { min: 90 }, tempC: { min: 35, max: 38.5 } }, noticeRanges: { tempC: { max: 37.9 } } },
    { key: "child_1_5", upToAgeYears: 6, required: ["heightCm", "weightKg", "tempC", "spo2", "pulse", "muacCm"], notRoutine: ["sbp", "dbp"],
      ranges: { sbp: { min: 75, max: 130 }, dbp: { min: 45, max: 85 }, pulse: { min: 70, max: 150 }, rr: { min: 20, max: 40 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: { tempC: { max: 37.9 } } },
    { key: "child_6_12", upToAgeYears: 13, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], notRoutine: [],
      ranges: { sbp: { min: 80, max: 140 }, dbp: { min: 50, max: 90 }, pulse: { min: 60, max: 130 }, rr: { min: 14, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: { tempC: { max: 37.9 } } },
    { key: "adult", upToAgeYears: null, required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], notRoutine: [],
      ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {} },
  ],
  gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 },
  muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
};
const ROW_A: WireBenchRow = {
  encounterId: "E-A", entryId: "Q-A", tokenNo: 118, seq: 1, doctorId: "D-RAO", doctorName: "Dr Nishant Rao", serviceDate: "2026-09-02",
  patient: { requestedId: "P-A", id: "P-A", uhid: "UH-23-04417", name: "Sunita Devi", alias: null, restricted: false, administrativeGender: "female", dob: "1971-03-02" },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const ROW_B: WireBenchRow = { ...ROW_A, encounterId: "E-B", entryId: "Q-B", tokenNo: 121, seq: 2,
  patient: { ...ROW_A.patient!, requestedId: "P-B", id: "P-B", uhid: "UH-26-00121", name: "Ganesh Oraon", dob: "1965-01-01" } };
const ROW_K: WireBenchRow = { ...ROW_A, encounterId: "E-K", entryId: "Q-K", tokenNo: 130, seq: 3, doctorId: "D-TOPPO", doctorName: "Dr Sneha Toppo",
  patient: { ...ROW_A.patient!, requestedId: "P-K", id: "P-K", uhid: "UH-26-00130", name: "Munna", dob: "2022-06-01" } };
const PRE_A: WirePreStage = {
  patientId: "P-A", ageYears: 55, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "sbp", "dbp", "pulse", "spo2", "tempC"], notRoutine: [],
  last: { vitalsId: "V-A0", recordedAt: "2026-06-11T04:00:00.000Z", serviceDate: "2026-06-11", heightCm: 151, weightKg: 62, sbp: 132, dbp: 84, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, muacCm: null },
  carryCandidates: ["heightCm"], expectedFlags: [],
};
const PRE_B: WirePreStage = { patientId: "P-B", ageYears: 61, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: PRE_A.required, notRoutine: [], last: null, carryCandidates: [],
  expectedFlags: [{ vital: "sbp", value: 172, bound: "max", limit: 180, severity: "danger" }] };
const PRE_K: WirePreStage = { patientId: "P-K", ageYears: 4, band: "child_1_5", ranges: { sbp: { min: 75, max: 130 }, dbp: { min: 45, max: 85 }, pulse: { min: 70, max: 150 }, rr: { min: 20, max: 40 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: { tempC: { max: 37.9 } }, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "tempC", "spo2", "pulse", "muacCm"], notRoutine: ["sbp", "dbp"], last: null, carryCandidates: [], expectedFlags: [] };

type Posted = { path: string; body: unknown };
function stubBay(rows: WireBenchRow[], onVitals: (body: unknown, path: string) => Response, posted: Posted[] = []): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (key === "GET /api/auth/me") return json({ actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/opd/bench") return json({ items: rows });
    if (key === "GET /api/opd/queues/summary") return json({ items: [] });
    // CLOSE pass 1 CRITICAL — the desk holds neither `opd.masters.read` route; the bay must not need them.
    if (key === "GET /api/opd/departments") return new Response(JSON.stringify({ code: "forbidden" }), { status: 403 });
    if (key === "GET /api/opd/config") return new Response(JSON.stringify({ code: "forbidden" }), { status: 403 });
    if (key === "GET /api/opd/visits/E-A/prestage") return json(PRE_A);
    if (key === "GET /api/opd/visits/E-B/prestage") return json(PRE_B);
    if (key === "GET /api/opd/visits/E-K/prestage") return json(PRE_K);
    if (init?.method === "POST" && path.endsWith("/vitals")) {
      const body = JSON.parse(String(init.body)) as unknown;
      posted.push({ path, body });
      return onVitals(body, path);
    }
    return new Response("{}", { status: 404 });
  }));
}
const saved = (flags: unknown[] = []): Response =>
  new Response(JSON.stringify({ vitals: { id: "V-NEW" }, flags, encounter: { id: "E" } }), { status: 200, headers: { "Content-Type": "application/json" } });
const refused = (code: string, detail: unknown): Response =>
  new Response(JSON.stringify({ statusCode: 409, code, message: code, detail }), { status: 409, headers: { "Content-Type": "application/json" } });

beforeEach(() => { vi.stubGlobal("WebSocket", FakeWebSocket); resetRealtimeClientForTests(); setToken("t"); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("the pure rules mirror the server's", () => {
  it("parseTake: BP needs both numbers; a scalar is a number", () => {
    expect(parseTake("bp", "158/96")).toEqual([158, 96]);
    expect(parseTake("bp", "158")).toBeNull();
    expect(parseTake("weightKg", "4.8")).toBe(4.8);
    expect(parseTake("pulse", "7x")).toBeNull();
  });
  it("tileSetFor folds sbp/dbp to one tile; a 4-year-old requires MUAC and has BP not routine; the lead vital comes from history", () => {
    expect(tileSetFor(PRE_K)).toEqual({ required: ["heightCm", "weightKg", "tempC", "spo2", "pulse", "muacCm"], notRoutine: ["bp"] });
    expect(tileSetFor(PRE_A).required).toContain("bp");
    expect(leadTileFor(PRE_B)).toBe("bp");     // expected flag on sbp → cuff first
    expect(leadTileFor(PRE_K)).toBe("tempC");  // a child: temperature first
    expect(tileOrder("bp", tileSetFor(PRE_A))).toEqual(["bp", "pulse", "spo2", "tempC", "rr", "weightKg", "heightCm"]); // no MUAC tile for an adult
    expect(tileOrder("tempC", tileSetFor(PRE_K))).toEqual(["tempC", "bp", "pulse", "spo2", "rr", "weightKg", "heightCm", "muacCm"]);
  });
  it("mirrorFor: the slipped digit, the shrinking adult and the probe error — and the child is above the weight gate", () => {
    const tile = emptyTiles().weightKg;
    expect(mirrorFor("weightKg", 4.8, 61, RANGES, null, tile)).toEqual({ kind: "slipped_digit", key: "weightKg", value: 4.8, suggestion: 48 });
    expect(mirrorFor("weightKg", 14, 4, RANGES, null, tile)).toBeNull();
    expect(mirrorFor("heightCm", 147, 55, RANGES, PRE_A.last, emptyTiles().heightCm)).toEqual({ kind: "shrinking_adult", key: "heightCm", value: 147, last: 151 });
    expect(mirrorFor("heightCm", 150, 55, RANGES, PRE_A.last, emptyTiles().heightCm)).toBeNull();
    expect(mirrorFor("spo2", 45, 55, RANGES, null, emptyTiles().spo2)).toEqual({ kind: "probe_error", key: "spo2", value: 45 });
  });
  it("flagOf: 38.4 on a child is a NOTICE, 208/126 on an adult is DANGER, MUAC 11.0 is SAM — and BP on an under-5 is not flagged (not routine)", () => {
    const child = RANGES.bands[1]!; const adult = RANGES.bands[3]!;
    expect(flagOf("tempC", 38.4, child, RANGES)).toBe("notice");
    expect(flagOf("tempC", 38.4, adult, RANGES)).toBeNull();
    expect(flagOf("bp", [208, 126], adult, RANGES)).toBe("danger");
    expect(flagOf("muacCm", 11.0, child, RANGES)).toBe("sam");
    expect(flagOf("muacCm", 12.0, child, RANGES)).toBe("mam");
    expect(flagOf("bp", [200, 120], child, RANGES)).toBeNull();
  });
  it("missingFor + buildBody: an emergency trims to BP + pulse + SpO₂; a carried height travels as carriedForward with the carried number", () => {
    const t = emptyTiles();
    t.heightCm.carried = 151;
    t.bp.takes = [[128, 84]]; t.pulse.takes = [78]; t.spo2.takes = [97];
    expect(missingFor(t, tileSetFor(PRE_A).required, false)).toEqual(["weightKg", "tempC"]);
    expect(missingFor(t, tileSetFor(PRE_A).required, true)).toEqual([]);
    const body = buildBody(t, { emergency: false, chips: [] });
    expect(body.carriedForward).toEqual(["heightCm"]);
    expect(body.heightCm).toBe(151);
    expect(body.readings?.bp).toEqual({ takes: [[128, 84]], source: "typed" });
    expect(body.readings?.heightCm).toBeUndefined();
    t.heightCm.unlockReason = "patient_disputes_old_value"; t.heightCm.carried = null; t.heightCm.takes = [149];
    const b2 = buildBody(t, { emergency: true, chips: [{ key: "fasting", question: "q", answer: "fasting" }] });
    expect(b2.carriedForward).toBeUndefined();
    expect(b2.unlockReasons).toEqual({ heightCm: "patient_disputes_old_value" });
    expect(b2.emergency).toBe(true);
    expect(b2.contextChips).toHaveLength(1);
  });
  it("the serial lane is per-bay device state and ships OFF", () => {
    expect(readLane()).toBe("typing");
  });
  it("dates on the staff screen read 31-Aug-2026 (ruling 9)", () => {
    expect(humanDate("2026-06-11")).toBe("11-Jun-2026");
    expect(humanDate("nonsense")).toBe("nonsense");
  });
});

describe("CLOSE pass 1 — the hypoxic patient, and a chip that was never asked", () => {
  it("SpO₂ 68 twice: held, then CONFIRMED real — charted with overrides.spo2, and Save & send NOW takes it", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_B], () => saved([{ vital: "spo2", value: 68, bound: "min", limit: 90, severity: "danger" }]), posted);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    await user.click(screen.getByTestId("input-spo2")); await user.keyboard("68{Enter}");
    expect(screen.getByTestId("mirror").getAttribute("data-kind")).toBe("probe_error");
    fireEvent.click(screen.getByTestId("mirror-retake"));
    await user.keyboard("68{Enter}");
    expect(screen.getByTestId("held-spo2").textContent).toContain("68");
    fireEvent.click(screen.getByTestId("mirror-confirm"));            // it is real
    expect(screen.getByTestId("value-spo2").textContent).toBe("68");
    expect(screen.getByTestId("tile-spo2").getAttribute("data-tint")).toBe("danger");
    await user.click(screen.getByTestId("input-bp")); await user.keyboard("100/60{Enter}");
    await user.click(screen.getByTestId("input-pulse")); await user.keyboard("118{Enter}");
    fireEvent.click(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as { overrides: Record<string, string>; readings: { spo2: { takes: number[]; held?: number[] } }; emergency: boolean };
    expect(body.overrides).toEqual({ spo2: "confirmed_reclip" });
    expect(body.readings.spo2.takes).toEqual([68]);
    expect(body.readings.spo2.held).toEqual([68, 68]);   // both attempts were held before the confirm — the log keeps them
    expect(body.emergency).toBe(true);
    await waitFor(() => expect(screen.getByTestId("saved-danger").textContent).toContain("spo2 68"));
  });

  it("a chip cycles not-asked → yes → no → not-asked, and only an ASKED chip is posted", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_B], () => saved(), posted);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    const chip = screen.getByTestId("chip-bp_med_taken");
    fireEvent.click(chip); expect(chip.getAttribute("data-answer")).toBe("yes");
    fireEvent.click(chip); expect(chip.getAttribute("data-answer")).toBe("no");
    fireEvent.click(chip); expect(chip.getAttribute("data-answer")).toBe("");
    fireEvent.click(screen.getByTestId("chip-fasting")); fireEvent.click(screen.getByTestId("chip-fasting"));   // asked: no
    await user.keyboard("120/80{Enter}70{Enter}98{Enter}36.6{Enter}16{Enter}70{Enter}168{Enter}");
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]!.body as { contextChips: unknown }).contextChips).toEqual([{ key: "fasting", question: "khali pet?", answer: "not fasting" }]);
  });
});

describe("VD-2 T5 — the contract pass closed three clauses: 1–8 address a tile, the RR honesty nudge, the dates", () => {
  it("a bare digit with nobody typing focuses that tile of THIS patient's order; inside a tile it is a value", async () => {
    stubBay([ROW_A], () => saved());
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "4" });                      // tile 4 of [bp, pulse, spo2, tempC, rr, weightKg]
    expect(document.activeElement).toBe(screen.getByTestId("input-tempC"));
    await user.keyboard("37.1");                                   // digits inside the tile are the value
    expect((screen.getByTestId("input-tempC") as HTMLInputElement).value).toBe("37.1");
    expect(document.activeElement).toBe(screen.getByTestId("input-tempC"));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "9" });                       // no ninth tile: nothing moves
    expect(document.activeElement).not.toBe(screen.getByTestId("input-tempC"));
    expect(screen.getByTestId("prestage-last").textContent).toContain("11-Jun-2026");
  });

  it("an RR committed within fifteen seconds of reaching the tile is charted AND nudged; the counter runs fifteen seconds and the re-take goes as `counted`", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const posted: Posted[] = [];
      stubBay([ROW_B], () => saved(), posted);
      renderWithProviders(<VitalsBay />);
      await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("bench-row-121"));
      await waitFor(() => expect(screen.getByTestId("input-rr")).toBeInTheDocument());
      fireEvent.focus(screen.getByTestId("input-rr"));
      fireEvent.change(screen.getByTestId("input-rr"), { target: { value: "16" } });
      fireEvent.keyDown(screen.getByTestId("input-rr"), { key: "Enter" });
      expect(screen.getByTestId("value-rr").textContent).toBe("16");           // never a block
      expect(screen.getByTestId("rr-nudge").textContent).toContain("under fifteen seconds");
      fireEvent.click(screen.getByTestId("rr-count"));
      expect(screen.getByTestId("rr-nudge").textContent).toContain("counting");
      await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
      expect(screen.getByTestId("rr-nudge").textContent).toContain("fifteen seconds done");
      expect(document.activeElement).toBe(screen.getByTestId("input-rr"));
      fireEvent.change(screen.getByTestId("input-rr"), { target: { value: "18" } });
      fireEvent.keyDown(screen.getByTestId("input-rr"), { key: "Enter" });
      expect(screen.getByTestId("pair-rr").textContent).toBe("16 · 18");
      // the wire says which take was counted
      fireEvent.change(screen.getByTestId("input-bp"), { target: { value: "120/80" } }); fireEvent.keyDown(screen.getByTestId("input-bp"), { key: "Enter" });
      fireEvent.change(screen.getByTestId("input-pulse"), { target: { value: "70" } }); fireEvent.keyDown(screen.getByTestId("input-pulse"), { key: "Enter" });
      fireEvent.change(screen.getByTestId("input-spo2"), { target: { value: "98" } }); fireEvent.keyDown(screen.getByTestId("input-spo2"), { key: "Enter" });
      fireEvent.change(screen.getByTestId("input-tempC"), { target: { value: "36.6" } }); fireEvent.keyDown(screen.getByTestId("input-tempC"), { key: "Enter" });
      fireEvent.change(screen.getByTestId("input-weightKg"), { target: { value: "70" } }); fireEvent.keyDown(screen.getByTestId("input-weightKg"), { key: "Enter" });
      fireEvent.change(screen.getByTestId("input-heightCm"), { target: { value: "168" } }); fireEvent.keyDown(screen.getByTestId("input-heightCm"), { key: "Enter" });
      fireEvent.click(screen.getByTestId("save"));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect((posted[0]!.body as { readings: { rr: { takes: number[]; source: string } } }).readings.rr).toEqual({ takes: [16, 18], source: "counted" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VD-2 T2 — the ASSEMBLED bay: the typing lane at speed, the carried lock, the bold ✓ (two patients)", () => {
  it("A: keyboard only — ⏎ commits and jumps, height arrives carried and locked, the save names Sunita and Dr Rao, the desk clears; B: the lead vital is the cuff and nothing of A remains", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A, ROW_B], () => saved(), posted);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    // the carried height is shown from June, locked, and is not an input
    expect(screen.getByTestId("carried-heightCm").textContent).toContain("151");
    expect(screen.queryByTestId("input-heightCm")).not.toBeInTheDocument();
    // the typing lane: the lead tile (BP for an adult with no expected flag) has focus
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
    await user.keyboard("128/84{Enter}");
    expect(screen.getByTestId("value-bp").textContent).toBe("128/84");
    expect(document.activeElement).toBe(screen.getByTestId("input-pulse"));   // jumped to the next EMPTY tile
    await user.keyboard("78{Enter}");
    await user.keyboard("97{Enter}");     // spo2
    await user.keyboard("36.8{Enter}");   // tempC
    await user.keyboard("16{Enter}");     // rr
    await user.keyboard("62{Enter}");     // weightKg — height is carried, so the lane is done
    expect(screen.getByTestId("keys").textContent).toMatch(/^\d+ keys · 0 device reads/);
    fireEvent.click(screen.getByTestId("chip-fasting"));
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
    expect(screen.getByTestId("saved-banner").textContent).toContain("Sunita Devi");
    expect(screen.getByTestId("saved-banner").textContent).toContain("Dr Nishant Rao");
    expect(posted).toHaveLength(1);
    const body = posted[0]!.body as { readings: { bp: unknown; weightKg: unknown }; carriedForward: string[]; heightCm: number; contextChips: { key: string; answer: string }[]; emergency: boolean };
    expect(posted[0]!.path).toContain("/opd/visits/E-A/vitals");
    expect(body.readings.bp).toEqual({ takes: [[128, 84]], source: "typed" });
    expect(body.carriedForward).toEqual(["heightCm"]);
    expect(body.heightCm).toBe(151);
    expect(body.contextChips).toEqual([{ key: "fasting", question: "khali pet?", answer: "fasting" }]);
    expect(body.emergency).toBe(false);
    // the desk cleared: nothing in hand, and the banner stays
    expect(screen.getByTestId("session-empty")).toBeInTheDocument();
    expect(sessionStorage.getItem("hmis.inHand")).toBeNull();

    // B — first visit, "heavy head": the expected flag on sbp puts the cuff FIRST; no carried tile; empty tiles
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    expect(screen.queryByTestId("carried-heightCm")).not.toBeInTheDocument();
    expect(screen.getByTestId("input-heightCm")).toBeInTheDocument();
    expect(screen.getByTestId("value-bp").textContent).toBe("—");
    expect(screen.getByTestId("value-weightKg").textContent).toBe("—");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
    expect(screen.getByTestId("keys").textContent).toMatch(/^0 keys/);
  });

  it("the gates: 4.8 kg on B is held with 48 offered; SpO₂ 45 is held OUT of the chart until a re-clip; the height re-measure keeps both numbers", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A, ROW_B], () => saved(), posted);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    await user.click(screen.getByTestId("input-weightKg"));
    await user.keyboard("4.8{Enter}");
    const mirror = screen.getByTestId("mirror");
    expect(mirror.getAttribute("data-kind")).toBe("slipped_digit");
    expect(screen.getByTestId("value-weightKg").textContent).toBe("—");   // never touched the chart
    fireEvent.click(screen.getByTestId("mirror-fix"));
    expect(screen.getByTestId("value-weightKg").textContent).toBe("48");
    expect(screen.queryByTestId("mirror")).not.toBeInTheDocument();
    // the probe error
    await user.click(screen.getByTestId("input-spo2"));
    await user.keyboard("45{Enter}");
    expect(screen.getByTestId("mirror").getAttribute("data-kind")).toBe("probe_error");
    expect(screen.getByTestId("value-spo2").textContent).toBe("—");
    expect(screen.getByTestId("held-spo2").textContent).toContain("45");
    fireEvent.click(screen.getByTestId("mirror-retake"));
    await user.keyboard("96{Enter}");
    expect(screen.getByTestId("value-spo2").textContent).toBe("96");
    // save with the rest, and the wire carries the held value
    await user.click(screen.getByTestId("input-bp")); await user.keyboard("172/104{Enter}");
    expect(screen.queryByTestId("tint-bp")).not.toBeInTheDocument(); // inside the adult band (180/110): no tint
    await user.click(screen.getByTestId("input-pulse")); await user.keyboard("88{Enter}");
    await user.click(screen.getByTestId("input-tempC")); await user.keyboard("36.9{Enter}");
    await user.click(screen.getByTestId("input-heightCm")); await user.keyboard("168{Enter}");
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as { readings: { spo2: { takes: number[]; held: number[] }; weightKg: { takes: number[] } }; overrides?: unknown };
    expect(body.readings.spo2).toEqual({ takes: [96], source: "typed", held: [45] });
    expect(body.readings.weightKg.takes).toEqual([48]);
    expect(body.overrides).toBeUndefined();
  });

  it("the server's 409s are clinical refusals, not errors: vitals_gate → confirm resends with the override; carried_value_locked → the unlock reason; vitals_incomplete → the missing tiles", async () => {
    const posted: Posted[] = [];
    let n = 0;
    stubBay([ROW_A], () => {
      n += 1;
      if (n === 1) return refused("vitals_gate", { gates: [{ key: "heightCm", kind: "shrinking_adult", value: 151, suggestion: 155, message: "height 151 against 155 — re-measure once" }] });
      if (n === 2) return refused("carried_value_locked", { locked: [{ key: "heightCm", carried: 155, supplied: 151 }], reasons: [] });
      if (n === 3) return refused("vitals_incomplete", { missing: ["tempC"] });
      return saved([{ vital: "sbp", value: 190, bound: "max", limit: 180, severity: "danger" }]);
    }, posted);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    await user.keyboard("190/100{Enter}78{Enter}97{Enter}36.8{Enter}16{Enter}62{Enter}");
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("server-gate-heightCm")).toBeInTheDocument());
    expect(screen.queryByTestId("capture-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("server-gate-confirm-heightCm"));
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("server-locked-heightCm")).toBeInTheDocument());
    expect((posted[1]!.body as { overrides: Record<string, string> }).overrides).toEqual({ heightCm: "confirmed_after_remeasure" });
    // the lock: the tile was carried; pick a reason, type the new height, save again
    // (the server said locked, so the carried tile re-opens for a reason)
    expect(screen.getByTestId("tile-heightCm").getAttribute("data-locked")).toBe("true");
    fireEvent.change(screen.getByTestId("unlock-heightCm"), { target: { value: "posture_or_device_changed" } });
    await user.keyboard("149{Enter}");
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("missing")).toBeInTheDocument());
    expect(screen.getByTestId("missing").textContent).toContain("Temp");
    expect((posted[2]!.body as { unlockReasons: Record<string, string>; heightCm?: number; readings: { heightCm: { takes: number[] } } }).unlockReasons).toEqual({ heightCm: "posture_or_device_changed" });
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
    expect(screen.getByTestId("saved-danger").textContent).toContain("sbp 190");
  });

  it("paediatrics: a 4-year-old flips the band — MUAC required with zones, BP steps out as not routine, 38.4 is a NOTICE not a brick; Save & send NOW trims the required set", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_K, ROW_A], () => saved([{ vital: "tempC", value: 38.4, bound: "max", limit: 37.9, severity: "notice" }]), posted);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-130")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-130"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    expect(screen.getByTestId("tile-muacCm").getAttribute("data-required")).toBe("true");
    expect(screen.getByTestId("not-routine-bp")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-tempC")));
    await user.keyboard("38.4{Enter}");
    expect(screen.getByTestId("tile-tempC").getAttribute("data-tint")).toBe("notice");
    await user.click(screen.getByTestId("input-muacCm")); await user.keyboard("11.0{Enter}");
    expect(screen.getByTestId("tile-muacCm").getAttribute("data-tint")).toBe("sam");
    await user.click(screen.getByTestId("input-weightKg")); await user.keyboard("12.1{Enter}");   // no slipped-digit gate on a child
    expect(screen.queryByTestId("mirror")).not.toBeInTheDocument();
    // Save & send NOW on a trimmed set: only BP + pulse + SpO₂ are demanded
    fireEvent.click(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(screen.getByTestId("missing")).toBeInTheDocument());
    expect(screen.getByTestId("missing").textContent).toContain("BP");
    expect(screen.getByTestId("missing").textContent).not.toContain("Height");
    await user.click(screen.getByTestId("input-bp")); await user.keyboard("100/60{Enter}");
    await user.click(screen.getByTestId("input-pulse")); await user.keyboard("110{Enter}");
    await user.click(screen.getByTestId("input-spo2")); await user.keyboard("97{Enter}");
    fireEvent.click(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
    expect((posted[0]!.body as { emergency: boolean }).emergency).toBe(true);
    expect(screen.getByTestId("saved-notice").textContent).toContain("tempC 38.4");
    expect(screen.queryByTestId("saved-danger")).not.toBeInTheDocument();
  });

  it("Escape mid-capture clears the tiles — B does not inherit A's unsaved weight; the serial toggle persists per bay and ships OFF", async () => {
    stubBay([ROW_A, ROW_B], () => saved());
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    expect(screen.getByTestId("lane-toggle").getAttribute("data-lane")).toBe("typing");
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    await user.click(screen.getByTestId("input-weightKg")); await user.keyboard("60{Enter}");
    expect(screen.getByTestId("value-weightKg").textContent).toBe("60");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-121"));
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    expect(screen.getByTestId("value-weightKg").textContent).toBe("—");
    fireEvent.click(screen.getByTestId("lane-toggle"));
    expect(screen.getByTestId("lane-toggle").getAttribute("data-lane")).toBe("serial");
    expect(localStorage.getItem("vitalsBay.lane")).toBe("serial");
    expect(within(screen.getByTestId("tile-bp")).getByTestId("device-bp")).toBeInTheDocument();
  });
});
