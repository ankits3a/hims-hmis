import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { VitalsBay } from "./vitals-bay";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WireDoctorSummary, WirePreStage } from "../lib/opd-api";

/**
 * ═══ OWNER 2026-10-04 — THE VITALS BAY ON A PHONE ═══
 *
 * At 390px the bay kept its three columns (session 294px | stage | bench 238px) in a row that
 * scrolled SIDEWAYS: the nurse saw the session card and a sliver of the bench, and the capture
 * tiles were off the right edge. A phone works one patient at a time, as Desk One does at the same
 * width: one column (the door, the patient as a strip, the tiles), the bench behind one button
 * that opens it from the bottom, and nothing narrower than a thumb.
 *
 * jsdom has no `matchMedia`, so every other bay suite renders the wide bay — the desktop DOM is
 * untouched. These tests install a `matchMedia` that answers like a phone.
 */

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void { /* the bay only listens */ }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

const ROW_A: WireBenchRow = {
  encounterId: "E-A", entryId: "Q-A", tokenNo: 118, seq: 1, doctorId: "D-RAO", doctorName: "Dr Nishant Rao", serviceDate: "2026-09-02",
  patient: { requestedId: "P-A", id: "P-A", uhid: "UH-23-04417", name: "Sunita Devi", alias: null, restricted: false, administrativeGender: "female", dob: "1971-03-02" },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const ROW_B: WireBenchRow = {
  ...ROW_A, encounterId: "E-B", entryId: "Q-B", tokenNo: 121, seq: 2, benchState: "resting", recallAt: "2026-09-02T04:27:00.000Z", recallDue: true,
  patient: { requestedId: "P-B", id: "P-B", uhid: "UH-26-00121", name: "Ganesh Oraon", alias: null, restricted: false, administrativeGender: "male", dob: "1965-01-01" },
};
const PRE_A: WirePreStage = {
  patientId: "P-A", ageYears: 55, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false, required: ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC"], notRoutine: [],
  last: null, carryCandidates: [], expectedFlags: [], feeUnpaid: false, feeBypass: null,
};
const SUMMARY: WireDoctorSummary[] = [{
  doctor: { id: "D-RAO", userId: "u-rao", displayName: "Dr Nishant Rao", registrationNo: null, departmentId: "DEP-GM", specialty: null, active: true, createdBy: "x", createdAt: "", updatedBy: "x", updatedAt: "" },
  sessionId: "S1", status: "in", waitingCount: 6, waitingVitalsCount: 1, nowServing: 117, scheduledToday: true, roomCode: "3", avgConsultMinutes: 6,
} as WireDoctorSummary];

function phoneViewport(phone: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: phone
      ? (query: string) => ({
        matches: /max-width/.test(query), media: query, onchange: null,
        addEventListener: () => undefined, removeEventListener: () => undefined,
        addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
      })
      : undefined,
  });
}

function mount(): void {
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record", "opd.queue.read"], scoped: { department: {}, floor: {} } } },
    "GET /api/opd/bench": { items: [ROW_A, ROW_B] },
    "GET /api/opd/queues/summary": { items: SUMMARY },
    "GET /api/opd/visits/E-A/prestage": PRE_A,
  });
  renderWithProviders(<VitalsBay />);
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  resetRealtimeClientForTests();
  setToken("t");
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); phoneViewport(false); });

describe("the vitals bay on a phone (owner 2026-10-04)", () => {
  it("is one column: no sideways row, no inline bench — the bench is one button with its count and the due recall on it", async () => {
    phoneViewport(true);
    mount();
    const toggle = await screen.findByTestId("bench-toggle");
    await waitFor(() => expect(toggle.textContent).toContain("2"));
    expect(toggle.textContent).toMatch(/1 due/);
    expect(screen.getByTestId("vb-phone")).toBeInTheDocument();
    expect(screen.queryByTestId("bench")).not.toBeInTheDocument();            // not beside the stage
    expect(screen.queryByTestId("keys-pill")).not.toBeInTheDocument();       // a keyboard figure, on a phone
    expect(screen.getByTestId("session-empty")).toBeInTheDocument();
  });

  it("the bench opens from the bottom; taking a row closes it and puts the patient in a strip above the tiles", async () => {
    phoneViewport(true);
    mount();
    fireEvent.click(await screen.findByTestId("bench-toggle"));
    const sheet = await screen.findByTestId("bench-sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    await waitFor(() => expect(within(sheet).getByTestId("bench-row-121")).toBeInTheDocument());
    fireEvent.click(within(sheet).getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.queryByTestId("bench-sheet")).not.toBeInTheDocument());

    const strip = await screen.findByTestId("vb-who-toggle");
    expect(strip.textContent).toContain("#118");
    expect(strip.textContent).toContain("Sunita Devi");
    expect(strip.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
    // every reading box opens the number pad
    expect(screen.getByTestId("input-bp").getAttribute("inputmode")).toBe("decimal");
    expect(screen.getByTestId("input-pulse").getAttribute("inputmode")).toBe("decimal");

    fireEvent.click(strip);
    expect(strip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-A");
  });

  it("a wide screen is the bay it was: three columns, the bench inline, no phone controls", async () => {
    phoneViewport(false);
    mount();
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    expect(screen.getByTestId("bench")).toBeInTheDocument();
    expect(screen.getByTestId("keys-pill")).toBeInTheDocument();
    expect(screen.queryByTestId("vb-phone")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bench-toggle")).not.toBeInTheDocument();
  });
});
