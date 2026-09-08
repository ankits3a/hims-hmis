import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BenchRail, VitalsBay, classifyDoor, matchOnBench } from "./vitals-bay";
import { renderWithProviders, stubFetch } from "../test-utils";
import { setToken } from "../lib/api";
import { resetRealtimeClientForTests } from "../lib/realtime";
import type { WireBenchRow, WireDoctorSummary, WirePreStage } from "../lib/opd-api";
import { usePatientInHand } from "../lib/patient-in-hand";

/**
 * VD-2 T1 — story 1: three doors, one lane, and NOTHING BLEEDS BETWEEN PEOPLE.
 *
 * Every assembled test here puts TWO patients through the bay (phase doc D8): the registration
 * series proved a component test proves the component and a one-patient screen test cannot tell
 * "cleared" from "hidden" (RC-4 R21 — the state survived and would have reappeared under the next
 * patient). So the assertions after Escape are made BEFORE the next patient is taken, and the
 * assertions under the next patient name the previous patient's values as absent.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  simulateAuthed(): void { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: "authed", userId: "u-vd" }) }); }
}

const ROW_A: WireBenchRow = {
  encounterId: "E-A", entryId: "Q-A", tokenNo: 118, seq: 1, doctorId: "D-RAO", doctorName: "Dr Nishant Rao", serviceDate: "2026-09-02",
  patient: { requestedId: "P-A", id: "P-A", uhid: "UH-23-04417", name: "Sunita Devi", alias: null, restricted: false, administrativeGender: "female", dob: "1971-03-02" },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
};
const ROW_B: WireBenchRow = {
  ...ROW_A, encounterId: "E-B", entryId: "Q-B", tokenNo: 121, seq: 2,
  patient: { requestedId: "P-B", id: "P-B", uhid: "UH-26-00121", name: "Ganesh Oraon", alias: null, restricted: false, administrativeGender: "male", dob: "1965-01-01" },
};
const ROW_C: WireBenchRow = {
  ...ROW_A, encounterId: "E-C", entryId: "Q-C", tokenNo: 125, seq: 3, doctorId: "D-TOPPO", doctorName: "Dr Sneha Toppo",
  patient: { requestedId: "P-C", id: "P-C", uhid: "UH-26-00125", name: null, alias: "Patient 4F2", restricted: true, administrativeGender: "female", dob: null },
  benchState: "resting", recallAt: "2026-09-02T04:27:00.000Z", recallDue: true,
};
const PRE_A: WirePreStage = {
  patientId: "P-A", ageYears: 55, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: ["heightCm", "weightKg", "sbp", "dbp", "pulse", "rr", "spo2", "tempC"], notRoutine: [],
  last: { vitalsId: "V-A0", recordedAt: "2026-06-11T04:00:00.000Z", serviceDate: "2026-06-11", heightCm: 151, weightKg: 62, sbp: 132, dbp: 84, pulse: 78, rr: 16, spo2: 98, tempC: 36.8, muacCm: null },
  carryCandidates: ["heightCm"], expectedFlags: [],
};
const PRE_B: WirePreStage = { patientId: "P-B", ageYears: 61, band: "adult", ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, rr: { min: 8, max: 30 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } }, noticeRanges: {}, gates: { adultWeightFloorKg: 25, heightDeltaCm: 3, spo2ProbeFloorPct: 75 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 }, sealed: false,required: PRE_A.required, notRoutine: [], last: null, carryCandidates: [], expectedFlags: [] };
const SUMMARY: WireDoctorSummary[] = [{
  doctor: { id: "D-RAO", userId: "u-rao", displayName: "Dr Nishant Rao", registrationNo: null, departmentId: "DEP-GM", specialty: null, active: true, createdBy: "x", createdAt: "", updatedBy: "x", updatedAt: "" },
  sessionId: "S1", status: "in", waitingCount: 6, waitingVitalsCount: 1, nowServing: 117, scheduledToday: true, roomCode: "3", avgConsultMinutes: 6,
} as WireDoctorSummary];

function stubBay(rows: WireBenchRow[]): void {
  stubFetch({
    "GET /api/auth/me": { actor: { type: "user", id: "u-vd" }, permissions: { hospital: ["opd.vitals.record", "opd.queue.read", "opd.vitals.history.read"], scoped: { department: {}, floor: {} } } },
    "GET /api/opd/bench": { items: rows },
    "GET /api/opd/queues/summary": { items: SUMMARY },
    "GET /api/opd/visits/E-A/prestage": PRE_A,
    "GET /api/opd/visits/E-B/prestage": PRE_B,
    "POST /api/patients/qr/verify": (init?: RequestInit) => {
      const payload = (JSON.parse(String(init?.body)) as { payload: string }).payload;
      if (payload === "q1.P-B.UH-26-00121.1.sig") return { ok: true, patient: { id: "P-B", uhid: "UH-26-00121", name: "Ganesh Oraon", administrativeGender: "male", dob: null } };
      return { ok: false, reason: "invalid_signature" };
    },
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  resetRealtimeClientForTests();
  setToken("t");
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

describe("classifyDoor / matchOnBench — the three doors are one input", () => {
  it("digits are a token, `q1.` is a card, anything else is a UHID (case-folded)", () => {
    expect(classifyDoor("  121 ")).toEqual({ kind: "token", tokenNo: 121 });
    expect(classifyDoor("q1.P-B.UH-26-00121.1.sig")).toEqual({ kind: "scan", payload: "q1.P-B.UH-26-00121.1.sig" });
    expect(classifyDoor("uh-23-04417")).toEqual({ kind: "uhid", uhid: "UH-23-04417" });
    expect(classifyDoor("   ")).toBeNull();
  });
  it("matches on the bench by token, by UHID and by verified patient id, and misses honestly", () => {
    const rows = [ROW_A, ROW_B, ROW_C];
    expect(matchOnBench(rows, { kind: "token", tokenNo: 121 })?.encounterId).toBe("E-B");
    expect(matchOnBench(rows, { kind: "uhid", uhid: "UH-23-04417" })?.encounterId).toBe("E-A");
    expect(matchOnBench(rows, { kind: "patient", patientId: "P-C" })?.encounterId).toBe("E-C");
    expect(matchOnBench(rows, { kind: "token", tokenNo: 999 })).toBeNull();
  });
});

describe("BenchRail — states the nurse must not walk past", () => {
  it("names a restricted patient by alias only, and lights a due recall", () => {
    renderWithProviders(<BenchRail rows={[ROW_C, ROW_A]} inHandEncounterId={null} onTake={() => {}} />);
    const c = screen.getByTestId("bench-row-125");
    expect(c.textContent).toContain("Patient 4F2");
    expect(c.textContent).not.toContain("UH-26-00125");
    expect(c.getAttribute("data-state")).toBe("due");
    expect(screen.getByTestId("bench-row-118").getAttribute("data-state")).toBe("waiting");
    // seq order, not token order, is the bench's order
    const rows = screen.getAllByTestId(/bench-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual(["bench-row-118", "bench-row-125"]);
  });
});

describe("VD-2 T1 — the ASSEMBLED bay, two patients, three doors (method §5A.3)", () => {
  it("token door → A pre-staged; Escape clears the desk BEFORE B; scan door → B, and A's June chart is gone", async () => {
    stubBay([ROW_A, ROW_B, ROW_C]);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    expect(screen.getByTestId("valve-pill").textContent).toContain("bench 3");
    expect(screen.getByTestId("valve-pill").textContent).toContain("callable 1");
    expect(screen.getByTestId("session-empty")).toBeInTheDocument();

    // Door 1 — the token number, typed.
    await user.type(screen.getByTestId("identify"), "118{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-A"));
    await waitFor(() => expect(screen.getByTestId("prestage-last")).toBeInTheDocument());
    expect(screen.getByTestId("prestage-last").textContent).toContain("151");
    expect(screen.getByTestId("prestage-carry").textContent).toContain("Height");
    expect(screen.getByTestId("bench-row-118").getAttribute("aria-pressed")).toBe("true");
    expect(sessionStorage.getItem("hmis.inHand")).toContain("E-A");

    // Escape OUTSIDE a field clears the desk — asserted NOW, before anyone else is taken (R21).
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("prestage-last")).not.toBeInTheDocument();
    expect(sessionStorage.getItem("hmis.inHand")).toBeNull();
    expect(screen.getByTestId("bench-row-118").getAttribute("aria-pressed")).toBe("false");
    expect((screen.getByTestId("identify") as HTMLInputElement).value).toBe("");

    // Door 3 — the scanner types a card payload into the same box.
    await user.type(screen.getByTestId("identify"), "q1.P-B.UH-26-00121.1.sig{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-B"));
    await waitFor(() => expect(screen.getByTestId("prestage-none")).toBeInTheDocument());
    expect(screen.queryByTestId("prestage-last")).not.toBeInTheDocument();   // A's 151 does not follow B
    expect(screen.queryByTestId("prestage-carry")).not.toBeInTheDocument();
    expect(screen.getByTestId("session").textContent).toContain("Ganesh Oraon");
    expect(screen.getByTestId("session").textContent).not.toContain("Sunita");
  });

  it("UHID door → A; a token that is not on the bench says so and leaves A in hand; a bad scan says why", async () => {
    stubBay([ROW_A, ROW_B]);
    const user = userEvent.setup();
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());

    await user.type(screen.getByTestId("identify"), "uh-23-04417{Enter}");
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-A"));

    await user.clear(screen.getByTestId("identify"));
    await user.type(screen.getByTestId("identify"), "999{Enter}");
    await waitFor(() => expect(screen.getByTestId("identify-error").textContent).toContain("999 is not on this bench"));
    expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-A");

    await user.clear(screen.getByTestId("identify"));
    await user.type(screen.getByTestId("identify"), "q1.P-X.UH.1.forged{Enter}");
    await waitFor(() => expect(screen.getByTestId("identify-error").textContent).toContain("did not verify"));
    expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-A");
  });

  it("clicking a bench row takes that patient; a row whose chart cannot be pre-staged says so rather than showing another's", async () => {
    stubBay([ROW_A, ROW_C]);
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-125")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("prestage-last")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-125"));           // E-C has no prestage stub → 404
    await waitFor(() => expect(screen.getByTestId("session").getAttribute("data-encounter")).toBe("E-C"));
    await waitFor(() => expect(screen.getByTestId("prestage-failed")).toBeInTheDocument());
    expect(screen.queryByTestId("prestage-last")).not.toBeInTheDocument();
    expect(screen.getByTestId("session").textContent).toContain("Patient 4F2");
    expect(screen.getByTestId("session").textContent).not.toContain("UH-26-00125");   // CLOSE pass 1: alias, never name or UHID
  });

  it("subscribes to one queue topic per doctor on the bench, and the root wears the paper-and-pine scope", async () => {
    stubBay([ROW_A, ROW_B, ROW_C]);
    renderWithProviders(<VitalsBay />);
    await waitFor(() => expect(screen.getByTestId("bench-row-125")).toBeInTheDocument());
    /*
      FD-25 — THIS ASSERTED `data-seat="vitals-bay"`, WHICH IS NOW GONE AND SHOULD BE.

      That attribute was the seat's ALIAS LAYER: `styles.css` used it to re-map shadcn's token names
      onto the paper-and-pine values for a screen built on shadcn components. Bay One no longer has
      any — `grep -c "@/components/ui"` across all four `vitals-bay*.tsx` files returns 0 — so the
      block styled nothing and the attribute opted into nothing. Both are deleted, which is exactly
      what FD-9 did to `appointment-seat` and `registration-screen` when those screens moved.

      The claim the test was making is still worth making, so it is made about the thing that is now
      load-bearing: the root carries `.pp`, which is where the palette actually comes from.
    */
    expect(screen.getByTestId("vitals-bay").className).toContain("pp");
    expect(screen.getByTestId("vitals-bay").getAttribute("data-seat")).toBeNull();
    // the doctor filter is built from the bench itself — no masters route
    const doctor = screen.getByTestId("doctor") as HTMLSelectElement;
    expect([...doctor.options].map((o) => o.textContent)).toEqual(["All doctors on the bench", "Dr Nishant Rao", "Dr Sneha Toppo"]);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    const ws = FakeWebSocket.instances[0]!;
    ws.simulateAuthed();
    await waitFor(() => expect(ws.sent.join("\n")).toContain("queue:D-RAO:"));
    expect(ws.sent.join("\n")).toContain("queue:D-TOPPO:");
  });
});

/** A sibling that releases the shared session from OUTSIDE the bay — the strip's button, the palette taking someone else. */
function Releaser(): React.ReactElement {
  const { release } = usePatientInHand();
  return <button type="button" data-testid="release-elsewhere" onClick={release}>release</button>;
}

describe("VD-2 T1 — the road that does NOT pass clearDesk (RC-4 R26/R27's lesson)", () => {
  it("a release from another component empties the session column and the pre-stage with it", async () => {
    stubBay([ROW_A, ROW_B]);
    renderWithProviders(<><Releaser /><VitalsBay /></>);
    await waitFor(() => expect(screen.getByTestId("bench-row-118")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("bench-row-118"));
    await waitFor(() => expect(screen.getByTestId("prestage-last")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("release-elsewhere"));
    await waitFor(() => expect(screen.getByTestId("session-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("prestage-last")).not.toBeInTheDocument();
    expect(screen.getByTestId("bench-row-118").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the alias layer and the route pin move with the screen", () => {
  /**
   * ═══ FD-25 — INVERTED, THE WAY THE ROUTE PIN BELOW WAS INVERTED, AND FOR THE SAME REASON ═══
   *
   * This asserted that Bay One shared `styles.css`'s `[data-seat=…]` block with the registration
   * counter. That block re-maps SHADCN's token names onto the paper-and-pine values, for screens
   * built on shadcn components. Bay One no longer has one — `grep -c "@/components/ui"` across all
   * four `vitals-bay*.tsx` files returns 0 — so the block styled nothing under that root and the
   * attribute opted into nothing. Both are deleted, exactly as FD-9 deleted `appointment-seat` and
   * `registration-screen` when those screens moved to `.pp`.
   *
   * THE MUTANT IT KILLS IS UNCHANGED and that is the whole point of inverting rather than deleting:
   * a seat given its OWN COPY of the palette. The old form caught that by requiring Bay One to be
   * inside the shared block; this one catches it by requiring that the tokens are defined in
   * exactly one file, whatever any seat does. It is the stronger claim — it would also have caught
   * a copy made under a name this test had never heard of.
   */
  it("Bay One has no palette of its own — the tokens are defined once, in paper-pine.css", () => {
    /*
      COMMENTS STRIPPED FIRST, and this caught itself: `styles.css` now carries a comment EXPLAINING
      why `[data-seat="vitals-bay"]` was removed, and the first version of this assertion matched
      that explanation and failed. A guard that fires on the documentation of its own subject is the
      same false positive `i18n-keys.test.ts` hit on `rx-print.tsx`, and the same fix applies: read
      the selectors, not the prose.
    */
    const css = readFileSync(resolve(__dirname, "../styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/\[data-seat="vitals-bay"\]/);

    /* The one definition, and the only one. `.pp` is in its selector list; the bay wears `.pp`. */
    /* Stripped for the same reason, and it caught itself the same way: that file's header explains
       that it holds the ONLY `--paper:` definition, and the explanation counted as a second one. */
    const palette = readFileSync(resolve(__dirname, "../styles/paper-pine.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(palette).toMatch(/\.pp,/);
    expect((palette.match(/--paper:/g) ?? []).length).toBe(1);
  });
  /**
   * ═══ FD-5 / OWNER RULING 2026-09-02 — THE BAY *IS* `/opd/vitals` NOW ═══
   *
   * VD-2 D1 mounted Bay One at `/opd/vitals/bay` BESIDE the shipped `opd-vitals.tsx`, and this row
   * pinned that arrangement. The owner has ruled the same way they ruled for the counter — "keep
   * the new design not the old one" — so the old screen is deleted and the bay took the path.
   *
   * The row is INVERTED rather than deleted: what has to stay true is that there is exactly ONE
   * vitals route and ONE nav entry, and that the bay is what they point at. A second `/opd/vitals/*`
   * route growing back is the two-doors problem this ruling exists to end, so it is asserted as an
   * absence.
   *
   * ═══ PHASE 11i T9 — THE ASSERTION NAMED AN INSTANCE, NOT THE PROPERTY, AND WENT RED WHILE THE
   *     RULE IT PROTECTS WAS STILL SATISFIED ═══
   *
   * It read `expect(src).not.toContain('path: "/opd/vitals/bay"')` — the absence of a STRING. Its
   * own title says what it means: *no second vitals path*, i.e. no second SCREEN mounted under a
   * vitals URL. To a substring check a redirect and a mounted screen are indistinguishable, so
   * when 11i T9 added a `beforeLoad` redirect at that path — no component, no nav row, no manifest
   * entry, a forwarding address for the bookmarks production has been serving since 2 September,
   * removed one release after the laboratory opens — this row went red and the ruling it guards
   * was never in question.
   *
   * This is `deploy-parity`'s seed-ordering defect, found in the same phase, running the other
   * way. There, a pinned PAIR stayed green while the rule (`seed-roles` runs last) was broken;
   * here, a pinned STRING goes red while the rule holds. A text assertion cannot tell the thing it
   * names from the thing it means, and the symptom it produces is a coin toss.
   *
   * So it now asserts the property: **exactly one route MOUNTS a vitals screen, and any other
   * `/opd/vitals/*` route carries no component at all.** A real second bay fails it; a forwarding
   * address does not.
   */
  it("router.tsx mounts the BAY at /opd/vitals, with one nav row and no second vitals SCREEN", () => {
    const src = readFileSync(resolve(__dirname, "../router.tsx"), "utf8");
    expect(src).toContain('path: "/opd/vitals",');
    expect(src).toContain("component: VitalsBay");
    expect(src).toMatch(/to: "\/opd\/vitals", label: "nav\.opdVitals", permission: "opd\.vitals\.record"/);
    expect(src).not.toContain("nav.vitalsBay");
    // THE KILL for the old screen coming back: nothing may import it again.
    expect(src).not.toContain("screens/opd-vitals");

    // The bay is mounted ONCE. A second `component: VitalsBay` anywhere is a second door by any
    // path, which is the thing the ruling is actually about.
    expect((src.match(/component: VitalsBay/g) ?? []).length).toBe(1);

    /*
      And every OTHER `/opd/vitals/*` route is componentless. `createRoute({ … })` blocks are read
      whole rather than by substring, so "declares this path" and "mounts a screen at it" are two
      different questions again — which is the whole correction above.
    */
    const blocks = [...src.matchAll(/createRoute\(\{([\s\S]*?)\n\}\);/g)].map((m) => m[1] ?? "");
    expect(blocks.length).toBeGreaterThan(20); // non-vacuous: the parser found the route table
    const vitalsBlocks = blocks.filter((b) => /path: "\/opd\/vitals/.test(b));
    expect(vitalsBlocks).toHaveLength(2); // the bay, and T9's forwarding address
    const mounting = vitalsBlocks.filter((b) => /\bcomponent:/.test(b));
    expect(mounting).toHaveLength(1);
    expect(mounting[0]).toMatch(/path: "\/opd\/vitals",/);
    const forwarding = vitalsBlocks.filter((b) => !/\bcomponent:/.test(b));
    expect(forwarding[0]).toMatch(/redirect\(\{ to: "\/opd\/vitals", search \}\)/);
  });
});
