import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VitalsBay } from "./vitals-bay";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WirePreStage } from "../lib/opd-api";

/**
 * OWNER 2026-10-08 — the web vitals bay opens with four boxes and a "+": *"keep BP, Weight, height &
 * Pulse as the primary and add a '+' icon to add more vitals like RR, Temperature, Glucose"*; *"Move
 * SpO2 behind '+'. Add Glucose behind '+'."* The same book as the phone's (apps/mobile/__tests__/
 * vitals-plus.test.tsx), through the ASSEMBLED bay; the pre-stages are what the server sends after
 * the ruling (no SpO₂ demanded on an ordinary save).
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((ev: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
}

const ROW_A: WireBenchRow = {
  encounterId: "E-A", entryId: "Q-A", tokenNo: 9, seq: 1, doctorId: "D-1", doctorName: "Dr Chandan Kumar", serviceDate: "2026-10-08",
  patient: { requestedId: "P-A", id: "P-A", uhid: "U00110049", name: "Ram Pravesh Yadav", alias: null, restricted: false, administrativeGender: "male", dob: "1972-03-02" },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const ROW_K: WireBenchRow = { ...ROW_A, encounterId: "E-K", entryId: "Q-K", tokenNo: 3, seq: 2,
  patient: { ...ROW_A.patient!, requestedId: "P-K", id: "P-K", uhid: "U00110060", name: "Baby Anshu", dob: "2023-06-01" } };
const PRE_A: WirePreStage = {
  patientId: "P-A", ageYears: 54, band: "adult",
  ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } },
  noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,
  required: ["heightCm", "weightKg", "sbp", "dbp", "pulse"], notRoutine: [], last: null, carryCandidates: [], expectedFlags: [], feeUnpaid: false, feeBypass: null,
};
const PRE_K: WirePreStage = { ...PRE_A, patientId: "P-K", ageYears: 3, band: "child_1_5", required: ["heightCm", "weightKg", "pulse", "muacCm"], notRoutine: ["sbp", "dbp"] };
const CHART = {
  id: "V-1", encounterId: "E-A", patientId: "P-A", recordedAt: "2026-10-08T06:10:00.000Z", recordedBy: "u-vd", recordedByName: "Asha Devi", status: "active", emergency: false, notes: null,
  heightCm: 168, weightKg: 71.5, sbp: 148, dbp: 92, pulse: 84, rr: null, spo2: 97, tempC: 37.2, muacCm: null, glucoseMgDl: 186, glucoseTiming: "random",
  readings: { bp: { takes: [[148, 92]], source: "typed" }, glucoseMgDl: { takes: [186], source: "typed" } }, contextChips: [], carriedForward: [],
  band: "adult", ageYearsAtRecord: 54, dangerFlags: [], supersedesVitalsId: null, amendmentReason: null,
};

type Posted = { path: string; body: unknown };
let preA: WirePreStage = PRE_A;
afterEach(() => { preA = PRE_A; });

function stubBay(rows: WireBenchRow[], posted: Posted[] = []): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const json = (b: unknown): Response => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (key === "GET /api/auth/me") return json({ actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/opd/bench") return json({ items: rows });
    if (key === "GET /api/opd/queues/summary") return json({ items: [] });
    if (key === "GET /api/opd/visits/E-A/prestage") return json(preA);
    if (key === "GET /api/opd/visits/E-K/prestage") return json(PRE_K);
    if (key === "GET /api/opd/vitals/V-1") return json({ vitals: CHART });
    if (init?.method === "POST" && (path.endsWith("/vitals") || path.endsWith("/amend"))) {
      const body = JSON.parse(String(init.body)) as { glucoseMgDl?: number; glucoseTiming?: string };
      posted.push({ path, body });
      return json({ vitals: { ...CHART, id: "V-NEW", ...(path.endsWith("/amend") ? { glucoseMgDl: body.glucoseMgDl ?? null, glucoseTiming: body.glucoseTiming ?? null } : {}) }, flags: [], encounter: { id: "E" }, superseded: "V-1" });
    }
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => { vi.stubGlobal("WebSocket", FakeWebSocket); resetRealtimeClientForTests(); setToken("t"); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

async function take(tokenNo: number) {
  renderWithProviders(<VitalsBay />);
  await waitFor(() => expect(screen.getByTestId(`bench-row-${tokenNo}`)).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`bench-row-${tokenNo}`));
  await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId("plus-row")).toBeInTheDocument());
}
const boxes = (): string[] => within(screen.getByTestId("tiles")).getAllByTestId(/^tile-/).map((n) => n.getAttribute("data-testid")!.replace("tile-", ""));
const key = async (user: ReturnType<typeof userEvent.setup>, k: string, text: string) => { await user.click(screen.getByTestId(`input-${k}`)); await user.keyboard(`${text}{Enter}`); };
const fillFour = async (user: ReturnType<typeof userEvent.setup>) => { await key(user, "bp", "148/92"); await key(user, "pulse", "84"); await key(user, "weightKg", "71.5"); await key(user, "heightCm", "168"); };
const add = (k: string) => { fireEvent.click(screen.getByTestId("plus-row")); fireEvent.click(screen.getByTestId(`plus-add-${k}`)); };

describe("frame A — an adult, as the web bay opens", () => {
  it("shows exactly four boxes in the board's order; '+' lists SpO₂, temperature, glucose, breathing rate; and it saves with SpO₂ empty", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A, ROW_K], posted);
    const user = userEvent.setup();
    await take(9);
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
    expect(screen.getByTestId("plus-row").textContent).toContain("Add a reading");
    expect(screen.getByTestId("plus-names").textContent).toBe("SpO₂ · Temperature · Glucose · Breathing rate");
    expect(screen.queryByTestId("plus-list")).toBeNull();
    fireEvent.click(screen.getByTestId("plus-row"));
    expect(within(screen.getByTestId("plus-list")).getAllByTestId(/^plus-add-/).map((n) => n.getAttribute("data-testid"))).toEqual(["plus-add-spo2", "plus-add-tempC", "plus-add-glucoseMgDl", "plus-add-rr"]);
    fireEvent.click(screen.getByTestId("plus-row"));        // closes again
    expect(screen.queryByTestId("plus-list")).toBeNull();

    await fillFour(user);
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    const body = posted[0]!.body as { readings: Record<string, unknown>; emergency: boolean };
    expect(Object.keys(body.readings).sort()).toEqual(["bp", "heightCm", "pulse", "weightKg"]);
    expect(body.emergency).toBe(false);
  });
});

describe("frames B and C — readings added from '+'", () => {
  it("an added reading is an ordinary box and leaves the list; the row disappears when nothing remains; an empty added box can be removed, a filled one only after it is cleared", async () => {
    stubBay([ROW_A]);
    const user = userEvent.setup();
    await take(9);
    add("spo2"); add("glucoseMgDl");
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "glucoseMgDl"]);
    expect(screen.getByTestId("plus-names").textContent).toBe("Temperature · Breathing rate");
    expect(screen.queryByTestId("plus-list")).toBeNull();           // one click, and the list is gone
    add("tempC"); add("rr");
    expect(screen.queryByTestId("plus-row")).toBeNull();

    fireEvent.click(screen.getByTestId("remove-rr"));
    expect(screen.queryByTestId("tile-rr")).toBeNull();
    expect(screen.getByTestId("plus-names").textContent).toBe("Breathing rate");
    await key(user, "spo2", "97");
    expect(screen.getByTestId("value-spo2").textContent).toBe("97");
    expect(screen.queryByTestId("remove-spo2")).toBeNull();
    fireEvent.click(screen.getByTestId("clear-spo2"));
    expect(screen.getByTestId("value-spo2").textContent).toBe("—");
    fireEvent.click(screen.getByTestId("remove-spo2"));
    expect(screen.queryByTestId("tile-spo2")).toBeNull();
    expect(screen.queryByTestId("remove-bp")).toBeNull();
  });

  it("an SpO₂ that is entered still wears its danger tint", async () => {
    stubBay([ROW_A]);
    const user = userEvent.setup();
    await take(9);
    add("spo2");
    await key(user, "spo2", "86");
    expect(screen.getByTestId("tile-spo2").getAttribute("data-tint")).toBe("danger");
  });
});

describe("an SpO₂ that was taken is still judged", () => {
  it("a probe error is held and cannot be skipped: re-clip it, confirm it, or clear the box — never a silent save", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A], posted);
    const user = userEvent.setup();
    await take(9);
    await fillFour(user);
    add("spo2");
    await key(user, "spo2", "45");                                  // below the probe floor: held out of the chart
    expect(screen.getByTestId("held-spo2").textContent).toContain("45");
    fireEvent.click(screen.getByTestId("save"));
    expect(screen.getByTestId("missing").textContent).toContain("SpO₂");
    expect(posted).toHaveLength(0);
    fireEvent.click(screen.getByTestId("clear-spo2"));              // a named nurse decides: no SpO₂ today
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]!.body as { readings: Record<string, unknown> }).readings.spo2).toBeUndefined();
  });
});

describe("glucose on the web bay", () => {
  it("186 with no timing is not saved and the box says why; with Random it saves with its timing; 700 is refused on the box", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A], posted);
    const user = userEvent.setup();
    await take(9);
    await fillFour(user);
    add("glucoseMgDl");
    for (const g of ["fasting", "random", "after_food"]) expect(screen.getByTestId(`glucose-timing-${g}`).getAttribute("aria-pressed")).toBe("false");
    await key(user, "glucoseMgDl", "700");
    expect(screen.getByTestId("glucose-error").textContent).toBe("Glucose is a whole number from 20 to 600 mg/dL");
    expect(screen.getByTestId("value-glucoseMgDl").textContent).toBe("—");
    fireEvent.click(screen.getByTestId("save"));
    expect(posted).toHaveLength(0);

    await user.clear(screen.getByTestId("input-glucoseMgDl"));
    await key(user, "glucoseMgDl", "186");
    expect(screen.getByTestId("value-glucoseMgDl").textContent).toBe("186");
    expect(screen.getByTestId("tile-glucoseMgDl").getAttribute("data-tint")).toBe("");   // no colour, no verdict
    fireEvent.click(screen.getByTestId("save"));
    expect(screen.getByTestId("glucose-error").textContent).toBe("Choose when it was taken: fasting, random or after food");
    expect(posted).toHaveLength(0);

    fireEvent.click(screen.getByTestId("glucose-timing-random"));
    expect(screen.queryByTestId("glucose-error")).toBeNull();
    fireEvent.click(screen.getByTestId("save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ glucoseTiming: "random", readings: { glucoseMgDl: { takes: [186], source: "typed" } } });
  });
});

describe("frame D — readings that come up by themselves", () => {
  it("an emergency save still needs SpO₂: it comes up without '+', and the save goes once it is filled", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A], posted);
    const user = userEvent.setup();
    await take(9);
    await key(user, "bp", "170/100"); await key(user, "pulse", "104");
    expect(screen.queryByTestId("tile-spo2")).toBeNull();
    fireEvent.click(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(screen.getByTestId("tile-spo2")).toBeInTheDocument());
    expect(screen.getByTestId("missing").textContent).toContain("SpO₂");
    expect(posted).toHaveLength(0);
    await key(user, "spo2", "93");
    fireEvent.click(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ emergency: true, readings: { spo2: { takes: [93] } } });
  });

  it("a child under six: temperature and the arm band without '+', the amber line, the arm band required", async () => {
    const posted: Posted[] = [];
    stubBay([ROW_A, ROW_K], posted);
    const user = userEvent.setup();
    await take(3);
    expect(boxes()).toEqual(["weightKg", "heightCm", "pulse", "tempC", "muacCm"]);
    expect(screen.getByTestId("auto-note").textContent).toBe("Child under six: Temperature and Arm band (MUAC) are asked.");
    expect(screen.getByTestId("tile-muacCm").getAttribute("data-required")).toBe("true");
    expect(screen.getByTestId("tile-tempC").getAttribute("data-required")).toBe("false");
    expect(screen.getByTestId("plus-names").textContent).toBe("SpO₂ · Glucose · Breathing rate · Blood pressure");
    await key(user, "weightKg", "14"); await key(user, "heightCm", "92"); await key(user, "pulse", "100");
    fireEvent.click(screen.getByTestId("save"));
    expect(screen.getByTestId("missing").textContent).toContain("Arm band (MUAC)");
    expect(posted).toHaveLength(0);
  });

  it("a reading the server's protocol requires, or the last chart flagged, is there without '+'", async () => {
    preA = { ...PRE_A, required: [...PRE_A.required, "rr"], expectedFlags: [{ vital: "spo2", value: 86, bound: "min", limit: 90 }] };
    stubBay([ROW_A]);
    await take(9);
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "rr"]);
    expect(screen.getByTestId("auto-note").textContent).toBe("Asked for this patient: Breathing rate.");
    expect(screen.getByTestId("plus-names").textContent).toBe("Temperature · Glucose");
  });
});

describe("a saved chart, reopened on the web bay", () => {
  it("shows the saved SpO₂, temperature and glucose with its timing; a corrected glucose travels with a timing", async () => {
    const posted: Posted[] = [];
    stubBay([{ ...ROW_A, vitalsDone: true, vitalsId: "V-1" }], posted);
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-9")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-9"));
    await waitFor(() => expect(screen.getByTestId("amend-fields")).toBeInTheDocument());
    expect((screen.getByTestId("amend-spo2") as HTMLInputElement).value).toBe("97");
    expect((screen.getByTestId("amend-tempC") as HTMLInputElement).value).toBe("37.2");
    expect((screen.getByTestId("amend-glucoseMgDl") as HTMLInputElement).value).toBe("186");
    expect(screen.getByTestId("amend-glucose-timing-random").getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByTestId("amend-glucoseMgDl"), { target: { value: "168" } });
    fireEvent.click(screen.getByTestId("amend-glucose-timing-fasting"));
    fireEvent.change(screen.getByTestId("amend-reason"), { target: { value: "Typing error — wrong number keyed" } });
    fireEvent.click(screen.getByTestId("amend-save"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ glucoseMgDl: 168, glucoseTiming: "fasting", spo2: 97, tempC: 37.2, readings: { glucoseMgDl: { takes: [168] } } });
  });
});
