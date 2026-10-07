import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VitalsBay } from "./vitals-bay";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WirePreStage } from "../lib/opd-api";

/**
 * ═══ OWNER 2026-10-07 — THE GUARDIAN CAME WITH THE REPORTS ═══
 *
 * A REVISIT or a RENEWAL in hand offers "Patient not present — guardian with reports"; a new visit
 * does not (owner 2026-10-07: the fee follows the visit type; an unpaid renewal is asked for billing). The
 * confirm posts who came, and the row leaves the bench (the server stops listing it; the bay re-reads).
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
}

const REVISIT: WireBenchRow = {
  encounterId: "E-R", entryId: "Q-R", tokenNo: 31, seq: 1, doctorId: "D-RAO", doctorName: "Dr Nishant Rao", serviceDate: "2026-10-07",
  visitType: "revisit",
  patient: { requestedId: "P-R", id: "P-R", uhid: "UH-26-00031", name: "Kamla Devi", alias: null, restricted: false, administrativeGender: "female", dob: "1958-01-01" },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const NEW: WireBenchRow = {
  ...REVISIT, encounterId: "E-N", entryId: "Q-N", tokenNo: 32, seq: 2, visitType: "new",
  patient: { requestedId: "P-N", id: "P-N", uhid: "UH-26-00032", name: "Bablu Oraon", alias: null, restricted: false, administrativeGender: "male", dob: "1990-01-01" },
};
const RENEWAL: WireBenchRow = {
  ...REVISIT, encounterId: "E-W", entryId: "Q-W", tokenNo: 33, seq: 3, visitType: "renewal",
  patient: { requestedId: "P-W", id: "P-W", uhid: "UH-26-00033", name: "Sita Kumari", alias: null, restricted: false, administrativeGender: "female", dob: "1970-01-01" },
};
const pre = (patientId: string): WirePreStage => ({
  patientId, ageYears: 60, band: "adult", ranges: { sbp: { min: 90, max: 180 } }, noticeRanges: {},
  gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
  sealed: false, required: ["sbp", "dbp", "pulse"], notRoutine: [], last: null, carryCandidates: [], expectedFlags: [], feeUnpaid: false, feeBypass: null,
});

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  resetRealtimeClientForTests();
  setToken("t");
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("the vitals bay — guardian with reports, on a returning visit (revisit or renewal) only", () => {
  it("a revisit in hand shows the button; confirm posts the relation and name, and the row leaves the bench", async () => {
    let bench: WireBenchRow[] = [REVISIT, NEW];
    const posted: unknown[] = [];
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record", "opd.queue.read", "opd.vitals.history.read"], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/bench": () => ({ items: bench }),
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/opd/visits/E-R/prestage": pre("P-R"),
      "GET /api/opd/visits/E-N/prestage": pre("P-N"),
      "POST /api/opd/visits/E-R/patient-absent": (init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        bench = bench.filter((r) => r.encounterId !== "E-R");
        return { alreadyMarked: false, patientAbsent: { relation: "father", name: "Ramesh", by: "u-vd", at: "2026-10-07T04:00:00.000Z" } };
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-31")).toBeInTheDocument());

    /* A NEW visit in hand: no such button. */
    await user.type(screen.getByTestId("identify"), "32{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-N"));
    expect(screen.queryByTestId("patient-absent-open")).not.toBeInTheDocument();

    /* The revisit: the button, the small form, the post. */
    await user.clear(screen.getByTestId("identify"));
    await user.type(screen.getByTestId("identify"), "31{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-R"));
    await user.click(await screen.findByTestId("patient-absent-open"));
    expect(screen.getByTestId("patient-absent-confirm")).toBeDisabled(); // no relation yet
    await user.selectOptions(screen.getByTestId("patient-absent-relation"), "father");
    await user.type(screen.getByTestId("patient-absent-name"), "Ramesh");
    await user.click(screen.getByTestId("patient-absent-confirm"));

    await waitFor(() => expect(posted).toEqual([{ relation: "father", name: "Ramesh" }]));
    await waitFor(() => expect(screen.queryByTestId("bench-row-31")).not.toBeInTheDocument());
    expect(screen.getByTestId("bench-row-32")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
  });

  it("a refusal is rendered in words and the form stays open", async () => {
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record", "opd.queue.read"], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/bench": { items: [REVISIT] },
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/opd/visits/E-R/prestage": pre("P-R"),
    });
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const base = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/patient-absent")) {
        return new Response(JSON.stringify({ statusCode: 409, code: "consult_gate_refused", message: "this visit has not been billed yet — take the fee at the counter first" }), { status: 409 });
      }
      return base(input, init);
    });
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-31")).toBeInTheDocument());
    await user.type(screen.getByTestId("identify"), "31{Enter}");
    await user.click(await screen.findByTestId("patient-absent-open"));
    await user.selectOptions(screen.getByTestId("patient-absent-relation"), "mother");
    await user.click(screen.getByTestId("patient-absent-confirm"));
    expect((await screen.findByTestId("patient-absent-error")).textContent).toContain("not been billed");
    expect(screen.getByTestId("patient-absent-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("bench-row-31")).toBeInTheDocument();
  });

  it("an UNPAID RENEWAL in hand shows the button, and pressing it asks for billing; a new visit beside it does not", async () => {
    stubFetch({
      "GET /api/auth/me": { actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record", "opd.queue.read"], scoped: { department: {}, floor: {} } } },
      "GET /api/opd/bench": { items: [RENEWAL, NEW] },
      "GET /api/opd/queues/summary": { items: [] },
      "GET /api/opd/visits/E-W/prestage": { ...pre("P-W"), feeUnpaid: true },
      "GET /api/opd/visits/E-N/prestage": pre("P-N"),
    });
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const base = fetchSpy.getMockImplementation()!;
    const posted: string[] = [];
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/patient-absent")) {
        posted.push(String(input));
        return new Response(JSON.stringify({ statusCode: 409, code: "consult_gate_refused", message: "this visit has not been billed yet — take the fee at the counter first" }), { status: 409 });
      }
      return base(input, init);
    });
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-33")).toBeInTheDocument());

    await user.type(screen.getByTestId("identify"), "32{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-N"));
    expect(screen.queryByTestId("patient-absent-open")).not.toBeInTheDocument();

    await user.clear(screen.getByTestId("identify"));
    await user.type(screen.getByTestId("identify"), "33{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-W"));
    await user.click(await screen.findByTestId("patient-absent-open"));
    await user.selectOptions(screen.getByTestId("patient-absent-relation"), "mother");
    await user.click(screen.getByTestId("patient-absent-confirm"));
    expect((await screen.findByTestId("patient-absent-error")).textContent).toContain("not been billed");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("/opd/visits/E-W/patient-absent");
    expect(screen.getByTestId("bench-row-33")).toBeInTheDocument();
  });
});
