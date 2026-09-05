import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VitalsBay } from "./vitals-bay";
import { renderWithProviders } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WireEscalationView, WirePreStage, WireVitals } from "../lib/opd-api";

/**
 * VD-2 T5 — THE SEVEN STORIES AS ONE ASSEMBLY (method §5A.3).
 *
 * `2026-08-31-EXECUTE-PROMPT-vitals-desk.md`: *"a tester, using only the app, in one sitting"* runs
 * seven stories; *"if those seven run without narration, the phase series is done."* Every task
 * proved its own story in its own file; this file drives the ASSEMBLED bay through all seven in
 * order, against ONE stateful stub server whose bench, charts, bench states and protocol states
 * move the way VD-1's server moves them, with three patients so nothing can bleed unnoticed.
 * The registration series paid three phases to learn that a component test proves the component.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((ev: { data: string }) => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.readyState = 3; this.onclose?.(); }
}
const row = (encounterId: string, tokenNo: number, seq: number, id: string, uhid: string, name: string, dob: string, doctor: [string, string]): WireBenchRow => ({
  encounterId, entryId: `Q-${encounterId}`, tokenNo, seq, doctorId: doctor[0], doctorName: doctor[1], serviceDate: "2026-09-02",
  patient: { requestedId: id, id, uhid, name, alias: null, restricted: false, administrativeGender: "female", dob },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
});
const RAO: [string, string] = ["D-RAO", "Dr Nishant Rao"]; const TOPPO: [string, string] = ["D-TOPPO", "Dr Sneha Toppo"];
const JUNE = { vitalsId: "V-S0", recordedAt: "2026-06-11T04:00:00.000Z", serviceDate: "2026-06-11", heightCm: 151, weightKg: 62, sbp: 132, dbp: 84, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, muacCm: null };
const PRE: Record<string, WirePreStage> = {
  "E-S": { patientId: "P-S", ageYears: 55, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], notRoutine: [], last: JUNE, carryCandidates: ["heightCm"], expectedFlags: [] },
  "E-G": { patientId: "P-G", ageYears: 61, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], notRoutine: [], last: null, carryCandidates: [], expectedFlags: [{ vital: "sbp", value: 0, bound: "max", limit: 180, severity: "danger" }] },
  "E-M": { patientId: "P-M", ageYears: 4, band: "child_1_5", ranges: { sbp: { min: 75, max: 130 }, dbp: { min: 45, max: 85 }, pulse: { min: 70, max: 150 }, rr: { min: 20, max: 40 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: { tempC: { max: 37.9 } }, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "tempC", "spo2", "pulse", "muacCm"], notRoutine: ["sbp", "dbp"], last: null, carryCandidates: [], expectedFlags: [] },
  "E-K": { patientId: "P-K", ageYears: 46, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], notRoutine: [], last: JUNE, carryCandidates: [], expectedFlags: [] },
  "E-R": { patientId: "P-R", ageYears: 76, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "sbp", "dbp", "tempC", "spo2", "pulse"], notRoutine: [], last: null, carryCandidates: [], expectedFlags: [] },
};

type Call = { key: string; body: unknown };
type Server = { rows: WireBenchRow[]; charts: Record<string, WireVitals[]>; esc: Map<string, WireEscalationView>; calls: Call[] };
function serve(): Server {
  const S: Server = {
    rows: [
      row("E-S", 118, 1, "P-S", "UH-23-04417", "Sunita Devi", "1971-03-02", RAO),
      row("E-G", 121, 2, "P-G", "UH-26-00121", "Ganesh Oraon", "1965-01-01", RAO),
      row("E-M", 130, 3, "P-M", "UH-26-00130", "Munna", "2022-06-01", TOPPO),
      row("E-K", 133, 4, "P-K", "UH-26-00133", "Kamla", "1980-01-01", RAO),
      row("E-R", 134, 5, "P-R", "UH-26-00134", "Ramdeo", "1950-01-01", RAO),
    ],
    charts: {}, esc: new Map(), calls: [],
  };
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const encOf = (path: string): string => /\/opd\/visits\/([^/]+)\//.exec(path)?.[1] ?? "";
  let seq = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (init?.method === "POST") S.calls.push({ key, body });
    if (key === "GET /api/auth/me") return json({ actor: { type: "user", id: "sister-kavita" }, permissions: { hospital: ["opd.vitals.record", "opd.visits.read", "opd.queue.read", "opd.vitals.history.read"], scoped: { department: {}, floor: {} } } });
    if (key === "GET /api/opd/bench") return json({ items: S.rows.map((r) => ({ ...r, escalation: S.esc.get(r.encounterId)?.state ?? "none" })) });
    if (key === "GET /api/opd/queues/summary") return json({ items: [] });
    if (key === "GET /api/opd/departments") return json({ code: "forbidden" }, 403);
    if (key === "GET /api/opd/config") return json({ code: "forbidden" }, 403);
    if (key === "POST /api/patients/qr/verify") {
      const payload = String(body.payload);
      const r = S.rows.find((x) => payload === `q1.${x.patient!.id}.${x.patient!.uhid}.1.sig`);
      return json(r === undefined ? { ok: false, reason: "invalid_signature" } : { ok: true, patient: { id: r.patient!.id, uhid: r.patient!.uhid, name: r.patient!.name, administrativeGender: "female", dob: null } });
    }
    const enc = encOf(path);
    if (key.endsWith("/prestage")) return PRE[enc] !== undefined ? json(PRE[enc]) : json({ code: "unknown_encounter" }, 404);
    if (key.endsWith("/escalation")) return json({ escalation: S.esc.get(enc) ?? null });
    if (key.endsWith("/escalation/recheck")) {
      if (Number(body.sbp ?? 0) <= 180) return json({ statusCode: 409, code: "escalation_not_warranted", message: "inside the band" }, 409);
      const v: WireEscalationView = { entryId: `Q-${enc}`, state: "recheck_demanded", escalatedAt: null, escalatedFromClass: null, escalationBy: null, cancelMsRemaining: 0 };
      S.esc.set(enc, v); return json(v);
    }
    if (key.endsWith("/escalation/escalate")) {
      if (S.esc.get(enc)?.state !== "recheck_demanded") return json({ statusCode: 409, code: "escalation_state_conflict", message: "one danger reading demands the other arm" }, 409);
      const v: WireEscalationView = { entryId: `Q-${enc}`, state: "escalated", escalatedAt: new Date().toISOString(), escalatedFromClass: 3, escalationBy: null, cancelMsRemaining: 10_000 };
      S.esc.set(enc, v); return json(v);
    }
    if (key.endsWith("/escalation/cancel")) {
      const v: WireEscalationView = { entryId: `Q-${enc}`, state: "cancelled", escalatedAt: null, escalatedFromClass: 3, escalationBy: "sister-kavita", cancelMsRemaining: 0 };
      S.esc.set(enc, v); return json(v);
    }
    if (key.endsWith("/bench-state")) {
      const r = S.rows.find((x) => x.encounterId === enc)!;
      r.benchState = body.state as WireBenchRow["benchState"]; r.recallAt = body.state === "resting" ? "2026-09-02T04:35:00.000Z" : null;
      return json(r);
    }
    if (key.endsWith("/vitals") && init?.method === "POST") {
      seq += 1;
      const b = body as Record<string, number | null | undefined>;
      const v: WireVitals = { id: `V-${enc}-${seq}`, encounterId: enc, patientId: PRE[enc]!.patientId,
        heightCm: (b.heightCm as number | null | undefined) ?? (body.readings as { heightCm?: { takes: number[] } })?.heightCm?.takes.at(-1) ?? null,
        weightKg: (body.readings as { weightKg?: { takes: number[] } })?.weightKg?.takes.at(-1) ?? null,
        sbp: (body.readings as { bp?: { takes: [number, number][] } })?.bp?.takes.at(-1)?.[0] ?? null, dbp: (body.readings as { bp?: { takes: [number, number][] } })?.bp?.takes.at(-1)?.[1] ?? null,
        pulse: (body.readings as { pulse?: { takes: number[] } })?.pulse?.takes.at(-1) ?? null, rr: (body.readings as { rr?: { takes: number[] } })?.rr?.takes.at(-1) ?? null,
        spo2: (body.readings as { spo2?: { takes: number[] } })?.spo2?.takes.at(-1) ?? null, tempC: (body.readings as { tempC?: { takes: number[] } })?.tempC?.takes.at(-1) ?? null,
        muacCm: (body.readings as { muacCm?: { takes: number[] } })?.muacCm?.takes.at(-1) ?? null, notes: null,
        ageYearsAtRecord: PRE[enc]!.ageYears, band: PRE[enc]!.band, dangerFlags: [], recordedBy: "sister-kavita", recordedAt: "2026-09-02T04:40:00.000Z",
        readings: body.readings, contextChips: body.contextChips ?? [], carriedForward: (body.carriedForward as string[] | undefined) ?? [], supersedesVitalsId: null, amendmentReason: null, status: "active", emergency: body.emergency === true };
      S.charts[enc] = [v];
      const r = S.rows.find((x) => x.encounterId === enc)!; r.vitalsDone = true; r.vitalsId = v.id; r.benchState = null; r.recallAt = null;
      const flags = [];
      if (v.sbp !== null && v.sbp > 180) flags.push({ vital: "sbp", value: v.sbp, bound: "max", limit: 180, severity: "danger" });
      if (v.tempC !== null && v.tempC > 37.9 && PRE[enc]!.band !== "adult") flags.push({ vital: "tempC", value: v.tempC, bound: "max", limit: 37.9, severity: "notice" });
      if (v.muacCm !== null && v.muacCm < 11.5) flags.push({ vital: "muacCm", value: v.muacCm, bound: "min", limit: 11.5, severity: "danger" });
      return json({ vitals: v, flags, encounter: { id: enc } });
    }
    if (key.endsWith("/vitals")) return json({ items: S.charts[enc] ?? [] });
    const gv = /\/opd\/vitals\/([^/]+)$/.exec(path);
    if (gv !== null && init?.method !== "POST") {
      const v = Object.values(S.charts).flat().find((x) => x.id === gv[1]);
      return v === undefined ? json({ code: "unknown_vitals" }, 404) : json({ vitals: v });
    }
    const am = /\/opd\/vitals\/([^/]+)\/amend/.exec(path);
    if (am !== null) {
      const prior = Object.values(S.charts).flat().find((v) => v.id === am[1])!;
      const b = body as Record<string, number | null> & { reason: string };
      const next: WireVitals = { ...prior, id: `${prior.id}-a`, weightKg: b.weightKg ?? null, heightCm: b.heightCm ?? null, sbp: b.sbp ?? null, dbp: b.dbp ?? null, pulse: b.pulse ?? null, rr: b.rr ?? null, spo2: b.spo2 ?? null, tempC: b.tempC ?? null, muacCm: b.muacCm ?? null,
        supersedesVitalsId: prior.id, amendmentReason: b.reason, recordedAt: "2026-09-02T04:52:00.000Z" };
      S.charts[prior.encounterId] = [{ ...prior, status: "superseded" }, next];
      S.rows.find((x) => x.encounterId === prior.encounterId)!.vitalsId = next.id;
      return json({ vitals: next, flags: [], superseded: prior.id });
    }
    return new Response("{}", { status: 404 });
  }));
  return S;
}

beforeEach(() => { vi.stubGlobal("WebSocket", FakeWebSocket); resetRealtimeClientForTests(); setToken("t"); sessionStorage.clear(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

/**
 * ═══ FD-25 — AN EXPLICIT BUDGET, BECAUSE THE DEFAULT ONE WAS ALWAYS GOING TO TIP ═══
 *
 * This test renders a whole vitals bay and drives SEVEN stories across THREE patients in one go —
 * deliberately, because the claim it makes is that they work in sequence on one mounted screen, and
 * seven separate tests would not make that claim.
 *
 * It costs about 3.3 s alone against vitest's 5 s default, which is 67% of budget with nothing else
 * running. The web suite runs its files in PARALLEL, so the real figure is 3.3 s plus whatever the
 * rest of the suite is doing to the box — and when FD-25 added two screen suites it went to 5.06 s
 * and failed. Nothing about this test got slower; the headroom was spent by its neighbours.
 *
 * MEASURED BEFORE CHANGING ANYTHING: alone it passes at 3.34 s, so this is contention and not a
 * regression in the bay. The remedy is a budget that matches what the test IS rather than a global
 * timeout raise, which would hide the next one of these from everybody. 15 s is four times the
 * measured cost — room for a loaded box, and still short enough that a genuine hang fails the run
 * rather than stalling it.
 */
it("the seven stories run in order on one bay, three patients, without narration", async () => {
  const S = serve();
  const user = userEvent.setup();
  renderWithProviders(<VitalsBay />);
  await waitFor(() => expect(screen.getByTestId("bench-row-130")).toBeInTheDocument());
  const posted = (suffix: string): Call[] => S.calls.filter((c) => c.key.endsWith(suffix));

  // ── 1 · Three doors, one lane. Scan → Sunita pre-staged (file, June vitals, band, carry). Then the token, then the UHID.
  await user.type(screen.getByTestId("identify"), "q1.P-S.UH-23-04417.1.sig{Enter}");
  await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-S"));
  await waitFor(() => expect(screen.getByTestId("prestage-last")).toBeInTheDocument());
  expect(screen.getByTestId("prestage-last").textContent).toContain("151");
  expect(screen.getByTestId("prestage-carry")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
  await user.type(screen.getByTestId("identify"), "121{Enter}");
  await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-G"));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
  await user.type(screen.getByTestId("identify"), "uh-26-00130{Enter}");
  await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-M"));
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());

  // ── 5 (first half) + 2 · Sunita: carried height locked; the typing lane at speed; the scale is dead so weight is typed;
  //     4.8 is held at the slipped-digit gate; the save → bold ✓ naming her and Dr Rao; the bench row wears the tick.
  fireEvent.click(screen.getByTestId("bench-row-118"));
  await waitFor(() => expect(screen.getByTestId("capture")).toBeInTheDocument());
  expect(screen.getByTestId("carried-heightCm").textContent).toContain("151");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
  await user.keyboard("128/84{Enter}78{Enter}97{Enter}36.8{Enter}16{Enter}");
  expect(document.activeElement).toBe(screen.getByTestId("input-weightKg"));
  await user.keyboard("4.8{Enter}");
  expect(screen.getByTestId("mirror").getAttribute("data-kind")).toBe("slipped_digit");
  expect(screen.getByTestId("value-weightKg").textContent).toBe("—");
  fireEvent.click(screen.getByTestId("mirror-fix"));
  expect(screen.getByTestId("value-weightKg").textContent).toBe("48");
  const keysBefore = Number(/^(\d+) keys/.exec(screen.getByTestId("keys").textContent!)![1]);
  expect(keysBefore).toBe(19);   // 128/84 · 78 · 97 · 36.8 · 16 · 4.8 — nineteen characters, ⏎ is not a key the score counts
  fireEvent.click(screen.getByTestId("save"));
  await waitFor(() => expect(screen.getByTestId("saved-banner")).toBeInTheDocument());
  expect(screen.getByTestId("saved-banner").textContent).toContain("Sunita Devi");
  expect(screen.getByTestId("saved-banner").textContent).toContain("Dr Nishant Rao");
  expect((posted("/vitals")[0]!.body as { carriedForward: string[]; heightCm: number }).carriedForward).toEqual(["heightCm"]);
  await waitFor(() => expect(screen.getByTestId("bench-row-118").getAttribute("data-state")).toBe("done"));

  // ── 3 · Ganesh: 208/126 → brick, the other arm demanded; 214/132 → class 0 by the agent, ten-second CANCEL; cancel restores; Save & send NOW.
  fireEvent.click(screen.getByTestId("bench-row-121"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));   // "heavy head": the cuff first
  await user.keyboard("208/126{Enter}");
  await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("recheck_demanded"));
  expect(screen.getByTestId("tile-bp").getAttribute("data-tint")).toBe("danger");
  expect(screen.queryByTestId("rest-offer")).not.toBeInTheDocument();
  await user.click(screen.getByTestId("input-bp")); await user.keyboard("214/132{Enter}");
  await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("escalated"));
  expect(screen.getByTestId("protocol-countdown")).toBeInTheDocument();
  fireEvent.click(screen.getByTestId("protocol-cancel"));
  await waitFor(() => expect(screen.getByTestId("protocol").getAttribute("data-state")).toBe("cancelled"));
  await user.click(screen.getByTestId("input-pulse")); await user.keyboard("104{Enter}");
  await user.click(screen.getByTestId("input-spo2")); await user.keyboard("95{Enter}");
  fireEvent.click(screen.getByTestId("save-emergency"));
  await waitFor(() => expect(screen.getByTestId("saved-banner").textContent).toContain("Ganesh Oraon"));
  expect((posted("/vitals")[1]!.body as { readings: { bp: { takes: unknown } }; emergency: boolean }).readings.bp.takes).toEqual([[208, 126], [214, 132]]);
  expect((posted("/vitals")[1]!.body as { emergency: boolean }).emergency).toBe(true);
  expect(screen.getByTestId("saved-danger").textContent).toContain("sbp 214");

  // ── 6 · Munna, 4: the band flips — MUAC required (SAM zone), BP not routine, 38.4 a NOTICE to the doctor ahead of the call.
  fireEvent.click(screen.getByTestId("bench-row-130"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-tempC")));
  expect(screen.getByTestId("not-routine-bp")).toBeInTheDocument();
  expect(screen.getByTestId("tile-muacCm").getAttribute("data-required")).toBe("true");
  await user.keyboard("38.4{Enter}");
  expect(screen.getByTestId("tile-tempC").getAttribute("data-tint")).toBe("notice");
  await user.click(screen.getByTestId("input-pulse")); await user.keyboard("110{Enter}");
  await user.click(screen.getByTestId("input-spo2")); await user.keyboard("97{Enter}");
  await user.click(screen.getByTestId("input-weightKg")); await user.keyboard("12.1{Enter}");
  expect(screen.queryByTestId("mirror")).not.toBeInTheDocument();       // above the paediatric bands the weight gate is silent
  await user.click(screen.getByTestId("input-heightCm")); await user.keyboard("95{Enter}");
  await user.click(screen.getByTestId("input-muacCm")); await user.keyboard("11.0{Enter}");
  expect(screen.getByTestId("tile-muacCm").getAttribute("data-tint")).toBe("sam");
  fireEvent.click(screen.getByTestId("save"));
  await waitFor(() => expect(screen.getByTestId("saved-banner").textContent).toContain("Munna"));
  expect(screen.getByTestId("saved-notice").textContent).toContain("tempC 38.4");
  expect(screen.getByTestId("saved-banner").textContent).toContain("Dr Sneha Toppo");

  // ── 4 · Rest-and-recheck: Kamla, 172/104 against June's 132 — elevated, not dangerous — to the rest chairs with the recall on the bench.
  fireEvent.click(screen.getByTestId("bench-row-133"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
  await user.keyboard("172/104{Enter}");
  await waitFor(() => expect(screen.getByTestId("rest-offer")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("rest-go"));
  await waitFor(() => expect(screen.getByTestId("rest-banner")).toBeInTheDocument());
  expect(posted("/bench-state")[0]!.body).toMatchObject({ state: "resting", restMinutes: 5 });
  await waitFor(() => expect(screen.getByTestId("bench-row-133").getAttribute("data-state")).toBe("resting"));
  expect(screen.getByTestId("bench-row-133").textContent).toContain("10:05");   // the recall time lives on the bench
  // the recall fires; she is re-identified; the first reading is held; both takes go as a pair
  fireEvent.click(screen.getByTestId("bench-row-133"));
  await waitFor(() => expect(screen.getByTestId("held-first-take")).toBeInTheDocument());
  await user.click(screen.getByTestId("input-bp")); await user.keyboard("128/82{Enter}");
  expect(screen.getByTestId("pair-bp").textContent).toBe("172/104 · 128/82");
  await user.keyboard("80{Enter}98{Enter}36.7{Enter}16{Enter}62{Enter}151{Enter}");   // 151 against June's 151: no shrinking-adult gate
  fireEvent.click(screen.getByTestId("save"));
  await waitFor(() => expect(screen.getByTestId("saved-banner").textContent).toContain("Kamla"));
  expect((posted("/vitals")[3]!.body as { readings: { bp: { takes: unknown } } }).readings.bp.takes).toEqual([[172, 104], [128, 82]]);

  // ── 5 (second half) · Ramdeo: SpO₂ 45 on a talking patient is held OUT of the chart until it survives a re-clip.
  fireEvent.click(screen.getByTestId("bench-row-134"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("input-bp")));
  await user.click(screen.getByTestId("input-spo2")); await user.keyboard("45{Enter}");
  expect(screen.getByTestId("mirror").getAttribute("data-kind")).toBe("probe_error");
  expect(screen.getByTestId("value-spo2").textContent).toBe("—");
  fireEvent.click(screen.getByTestId("mirror-retake"));
  await user.keyboard("96{Enter}");
  expect(screen.getByTestId("value-spo2").textContent).toBe("96");
  expect(screen.getByTestId("held-spo2").textContent).toContain("45");
  fireEvent.keyDown(window, { key: "Escape" });   // he walks off to the toilet; nothing charted, nothing bleeds
  await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());

  // ── 7 · Amend after save: Sunita's ✓ row re-opens; weight 48 → 62 (the scale came back); the trail keeps the old value with the name and the clock.
  fireEvent.click(screen.getByTestId("bench-row-118"));
  await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
  expect((screen.getByTestId("amend-weightKg") as HTMLInputElement).value).toBe("48");
  await user.clear(screen.getByTestId("amend-weightKg")); await user.type(screen.getByTestId("amend-weightKg"), "62");
  fireEvent.keyDown(window, { key: "Escape" });   // Esc abandons with the saved chart untouched
  await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
  expect(posted("/amend")).toHaveLength(0);
  fireEvent.click(screen.getByTestId("bench-row-118"));
  await waitFor(() => expect(screen.getByTestId("amend")).toBeInTheDocument());
  expect((screen.getByTestId("amend-weightKg") as HTMLInputElement).value).toBe("48");
  await user.clear(screen.getByTestId("amend-weightKg")); await user.type(screen.getByTestId("amend-weightKg"), "62");
  await user.type(screen.getByTestId("amend-reason"), "scale back in service — re-weighed");
  fireEvent.click(screen.getByTestId("amend-save"));
  await waitFor(() => expect(screen.getByTestId("amend-trail")).toBeInTheDocument());
  expect(screen.getByTestId("trail-weightKg").textContent).toContain("48 → 62");
  expect(screen.getByTestId("trail-weightKg").textContent).toContain("sister-kavita");
  expect(screen.getByTestId("saved-banner").textContent).toContain("Amended Sunita Devi");
  expect(posted("/amend")).toHaveLength(1);

  // The whole sitting: five charts, one amendment, one rest, one escalation with its cancel — and nothing narrated.
  expect(posted("/vitals")).toHaveLength(4);
  expect(posted("/escalation/recheck")).toHaveLength(1);
  expect(posted("/escalation/escalate")).toHaveLength(1);
  expect(posted("/escalation/cancel")).toHaveLength(1);
  await act(async () => { /* settle */ });
}, 15_000);
