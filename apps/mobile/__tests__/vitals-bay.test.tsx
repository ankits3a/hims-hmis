import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { VitalsBay } from "../src/screens/vitals-bay";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  // Keyed, like the real store: the swipe hint keeps its count beside the session token.
  const m = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha.devi" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => m.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { m.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { m.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock("expo-haptics", () => ({
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
  notificationAsync: jest.fn(async () => undefined),
}));
// The camera, reduced to what the bay uses of it: a granted permission and one read.
jest.mock("expo-camera", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    useCameraPermissions: () => [{ granted: true, canAskAgain: true }, jest.fn()],
    CameraView: ({ onBarcodeScanned }: { onBarcodeScanned: (r: { data: string }) => void }) =>
      React.createElement(Pressable, { testID: "fake-camera", onPress: () => onBarcodeScanned({ data: (globalThis as { __scan?: string }).__scan ?? "" }) },
        React.createElement(Text, null, "camera")),
  };
});

type Reply = { status: number; body?: unknown } | "offline";
type Route = (init: RequestInit | undefined) => Reply;

function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    calls.push({ key, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(init);
    if (reply === "offline") throw new TypeError("Network request failed");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

const ME = { actor: { type: "user", id: "01J" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } };
const row = (over: Record<string, unknown>) => ({
  encounterId: "e4", entryId: "q4", tokenNo: 4, seq: 4, visitNo: "V2610060004", departmentCode: "MED", doctorId: "d1", doctorName: "Dr Chandan Kumar", serviceDate: "2026-10-06",
  patient: { requestedId: "p4", id: "p4", uhid: "U00110049", name: "Geeta Devi", alias: null, restricted: false, administrativeGender: "female", dob: null },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
  ...over,
});
const ADULT = {
  patientId: "p4", ageYears: 42, band: "adult",
  ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } },
  noticeRanges: {}, gates: { adultWeightFloorKg: 20, heightDeltaCm: 5, spo2ProbeFloorPct: 70 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
  sealed: false, required: ["sbp", "dbp", "pulse", "spo2", "weightKg"], notRoutine: [], feeUnpaid: false, feeBypass: null,
  last: null, carryCandidates: [], expectedFlags: [],
};
const CHILD = { ...ADULT, patientId: "p7", ageYears: 8, band: "child_6_12", required: ["pulse", "spo2", "weightKg"], ranges: { pulse: { min: 70, max: 130 }, spo2: { min: 92 } } };
const KID_ROW = row({ encounterId: "e7", entryId: "q7", tokenNo: 7, seq: 7, visitNo: "V2610060007", departmentCode: "PED", patient: { requestedId: "p7", id: "p7", uhid: "U00110060", name: "Aarav Kumar", alias: null, restricted: false, administrativeGender: "male", dob: null } });

function base(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/bench": () => ({ status: 200, body: { items: [row({}), KID_ROW] } }),
    "GET /opd/queues/summary": () => ({ status: 200, body: { items: [{ waitingVitalsCount: 3 }] } }),
    "GET /opd/visits/e4/prestage": () => ({ status: 200, body: ADULT }),
    "GET /opd/visits/e7/prestage": () => ({ status: 200, body: CHILD }),
    "GET /opd/visits/e4/escalation": () => ({ status: 200, body: { escalation: null } }),
    "GET /opd/visits/e7/escalation": () => ({ status: 200, body: { escalation: null } }),
    ...extra,
  };
}

function Gate() {
  const { state } = useSession();
  return state.status === "signedIn" ? <VitalsBay /> : null;
}
async function mount(fetcher: typeof fetch) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}
async function takeToken(n: string) {
  await fireEvent.changeText(await screen.findByTestId("identify"), n);
  await fireEvent.press(screen.getByTestId("begin"));
  await screen.findByTestId("tiles");
}
/** OWNER 2026-10-08 — a reading behind "+" is one tap away: open the sheet, tap it. */
async function add(key: string) {
  await fireEvent.press(screen.getByTestId("plus-row"));
  await fireEvent.press(await screen.findByTestId(`plus-add-${key}`));
}
async function type(key: string, text: string) {
  await fireEvent.changeText(screen.getByTestId(`input-${key}`), text);
}
async function commit(key: string, text: string) {
  await type(key, text);
  await fireEvent(screen.getByTestId(`input-${key}`), "submitEditing");
}

describe("the vitals bay on a phone", () => {
  it("lists the bench and takes a patient by token number", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    expect(await screen.findByTestId("bench-row-4")).toHaveTextContent(/Geeta Devi/);
    expect(screen.getByTestId("bench-state-4")).toHaveTextContent("waiting");
    expect(screen.getByTestId("bench-asof")).toBeTruthy();
    await takeToken("4");
    expect(screen.getByTestId("who-name")).toHaveTextContent("Geeta Devi");
    expect(screen.queryByTestId("identify")).toBeNull();
  });

  it("says so, in the web bay's words, when the token is not on the bench", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await fireEvent.changeText(await screen.findByTestId("identify"), "99");
    await fireEvent.press(screen.getByTestId("begin"));
    expect(await screen.findByTestId("identify-error")).toHaveTextContent("Token #99 is not on today's bench — check the slip, or send them to the front desk");
  });

  /** Owner 2026-10-06, on a real phone: he typed the visit number on the slip and was told "not on this bench". */
  it("takes the patient by the visit number printed on the slip", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await fireEvent.changeText(await screen.findByTestId("identify"), "v2610060004");
    await fireEvent.press(screen.getByTestId("begin"));
    expect(await screen.findByTestId("who-name")).toHaveTextContent("Geeta Devi");
  });

  it("takes the patient when the prescription sheet's QR — the bare visit number — is scanned", async () => {
    (globalThis as { __scan?: string }).__scan = "V2610060007";
    const s = server(base());
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("who-name")).toHaveTextContent("Aarav Kumar");
    expect(s.of("POST /patients/qr/verify")).toEqual([]);
  });

  it("says why a visit number is not on today's bench, in the server's reason", async () => {
    const s = server(base({ "GET /opd/bench/locate": () => ({ status: 200, body: { onBench: false, visitNo: "V2610050003", reason: "other_day", serviceDate: "2026-10-05" } }) }));
    await mount(s.fetcher);
    await fireEvent.changeText(await screen.findByTestId("identify"), "V2610050003");
    await fireEvent.press(screen.getByTestId("begin"));
    expect(await screen.findByTestId("identify-error")).toHaveTextContent("Visit V2610050003 is from 05-Oct-2026, not today — send them to the front desk for today's visit");
  });

  it("reads a BP typed with a dash and a temperature typed in °F, before they are charted", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("4");
    await type("bp", "150-90");
    expect(screen.getByTestId("reads-bp")).toHaveTextContent("reads 150/90 mmHg");
    await add("tempC");
    await type("tempC", "101.2");
    expect(screen.getByTestId("reads-tempC")).toHaveTextContent("101.2 °F = 38.4 °C");
    await commit("tempC", "101.2");
    expect(screen.getByTestId("value-tempC")).toHaveTextContent("38.4");
    expect(screen.getByTestId("temp-typed-f")).toHaveTextContent("typed 101.2 °F");
  });

  it("stars what the server's band requires: BP for an adult, never temperature", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("4");
    expect(screen.getByTestId("label-bp")).toHaveTextContent("Blood pressure *");
    await add("tempC");
    expect(screen.getByTestId("label-tempC")).toHaveTextContent(/^Temperature$/);
  });

  it("asks a child for no BP, and saves the chart without one", async () => {
    const s = server(base({ "POST /opd/visits/e7/vitals": () => ({ status: 201, body: { flags: [] } }) }));
    await mount(s.fetcher);
    await takeToken("7");
    expect(screen.queryByTestId("tile-bp")).toBeNull();          // not asked: behind "+", and never starred when brought out
    await add("bp");
    expect(screen.getByTestId("label-bp")).toHaveTextContent(/^Blood pressure$/);
    await fireEvent.press(screen.getByTestId("remove-bp"));
    await type("pulse", "96");
    await type("spo2", "98");
    await type("weightKg", "24");
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("saved-banner")).toHaveTextContent(/Saved Aarav Kumar — sent to Dr Chandan Kumar's board/);
    const body = s.of("POST /opd/visits/e7/vitals")[0]!.body as { readings: Record<string, unknown>; emergency: boolean };
    expect(body.emergency).toBe(false);
    expect(Object.keys(body.readings).sort()).toEqual(["pulse", "spo2", "weightKg"]);
  });

  it("names what is still needed and sends nothing", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await takeToken("4");
    await type("pulse", "88");
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("missing")).toHaveTextContent("Still needed: Blood pressure, SpO₂, Weight");
    expect(s.of("POST /opd/visits/e4/vitals")).toEqual([]);
  });

  it("marks a danger value in words and asks the server, which demands the other arm", async () => {
    const s = server(base({
      "POST /opd/visits/e4/escalation/recheck": () => ({ status: 201, body: { entryId: "q4", state: "recheck_demanded", escalatedAt: null, escalatedFromClass: null, escalationBy: null, cancelMsRemaining: 0 } }),
    }));
    await mount(s.fetcher);
    await takeToken("4");
    await commit("bp", "196/124");
    expect(screen.getByTestId("tint-bp")).toHaveTextContent("outside band — danger");
    expect(await screen.findByTestId("protocol-demand")).toHaveTextContent("Danger reading — the OTHER ARM, now. Rest is refused at danger numbers.");
    expect(s.of("POST /opd/visits/e4/escalation/recheck")[0]!.body).toEqual({ sbp: 196, dbp: 124 });
  });

  it("saves, says who went to which doctor, and clears the desk for the next person", async () => {
    const s = server(base({ "POST /opd/visits/e4/vitals": () => ({ status: 201, body: { flags: [] } }) }));
    await mount(s.fetcher);
    await takeToken("4");
    await commit("bp", "150-90");
    await type("pulse", "88");
    await type("spo2", "97");
    await add("tempC");
    await type("tempC", "98.6");
    await type("weightKg", "61.5");
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("saved-banner")).toHaveTextContent(/Saved Geeta Devi — sent to Dr Chandan Kumar's board/);
    const body = s.of("POST /opd/visits/e4/vitals")[0]!.body as { readings: Record<string, { takes: unknown[] }> };
    expect(body.readings.bp!.takes).toEqual([[150, 90]]);
    expect(body.readings.tempC!.takes).toEqual([37]);
    expect(body.readings.weightKg!.takes).toEqual([61.5]);
    expect(await screen.findByTestId("identify")).toBeTruthy(); // the desk is clear
    expect((jest.requireMock("expo-haptics") as { notificationAsync: jest.Mock }).notificationAsync).toHaveBeenCalledWith("success");
  });

  /** Owner 2026-10-07 (#531) — the phone bay offers what the web bay offers, on a revisit only. */
  it("guardian with reports: a revisit skips the bay — who came is asked, the server is told, the desk clears", async () => {
    const s = server(base({
      "GET /opd/bench": () => ({ status: 200, body: { items: [row({ visitType: "revisit" }), KID_ROW] } }),
      "POST /opd/visits/e4/patient-absent": () => ({ status: 201, body: { patientAbsent: { relation: "father", name: "Ramesh", by: "01J", at: "2026-10-07T05:00:00Z" }, alreadyMarked: false } }),
    }));
    await mount(s.fetcher);
    await takeToken("4");
    await fireEvent.press(screen.getByTestId("patient-absent-open"));
    expect(screen.getByTestId("patient-absent-dialog")).toHaveTextContent(/The patient did not come — a guardian brought the reports/);
    await fireEvent.press(screen.getByTestId("patient-absent-confirm")); // nobody chosen yet: nothing is sent
    expect(s.of("POST /opd/visits/e4/patient-absent")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("patient-absent-relation-father"));
    await fireEvent.changeText(screen.getByTestId("patient-absent-name"), "  Ramesh ");
    await fireEvent.press(screen.getByTestId("patient-absent-confirm"));
    expect(await screen.findByTestId("guardian-banner")).toHaveTextContent(/Geeta Devi — Sent to the doctor — guardian with reports, vitals not taken\./);
    expect(s.of("POST /opd/visits/e4/patient-absent")[0]!.body).toEqual({ relation: "father", name: "Ramesh" });
    expect(s.of("POST /opd/visits/e4/vitals")).toHaveLength(0);
    expect(await screen.findByTestId("identify")).toBeTruthy(); // the desk is clear
  });

  // Owner 2026-10-07 — a RENEWAL (past the follow-up window) is offered too, and an unpaid one asks for billing.
  it("guardian with reports: not offered on a new visit; an unpaid renewal is offered and asked to bill first; a lost send stays on screen", async () => {
    let mode: "refuse" | "offline" = "refuse";
    const s = server(base({
      "GET /opd/bench": () => ({ status: 200, body: { items: [row({ visitType: "new" }), { ...KID_ROW, visitType: "renewal" }] } }),
      "POST /opd/visits/e7/patient-absent": () => (mode === "offline" ? "offline" : { status: 409, body: { code: "consult_gate_refused", message: "consult_gate_refused" } }),
    }));
    await mount(s.fetcher);
    await takeToken("4");
    expect(screen.queryByTestId("patient-absent-open")).toBeNull();
    await fireEvent.press(screen.getByTestId("clear-desk"));
    await takeToken("7");
    await fireEvent.press(screen.getByTestId("patient-absent-open"));
    await fireEvent.press(screen.getByTestId("patient-absent-relation-mother"));
    await fireEvent.press(screen.getByTestId("patient-absent-confirm"));
    expect(await screen.findByTestId("patient-absent-error")).toHaveTextContent(/has not been billed yet/);
    mode = "offline";
    await fireEvent.press(screen.getByTestId("patient-absent-confirm"));
    await waitFor(() => { expect(screen.getByTestId("patient-absent-error")).toHaveTextContent(/did not reach the server/); });
    expect(screen.queryByTestId("guardian-banner")).toBeNull();
    expect(screen.getByTestId("who-name")).toHaveTextContent("Aarav Kumar");
  });

  it("never queues a save: with no network the numbers stay, the line says nothing was sent, and Save works again", async () => {
    let online = false;
    const s = server(base({ "POST /opd/visits/e4/vitals": () => (online ? { status: 201, body: { flags: [] } } : "offline") }));
    await mount(s.fetcher);
    await takeToken("4");
    await commit("bp", "128/82");
    await type("pulse", "76");
    await type("spo2", "99");
    await type("weightKg", "58");
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("capture-error")).toHaveTextContent(/Not saved — the server could not be reached\. Nothing was sent\./);
    expect(screen.getByTestId("value-bp")).toHaveTextContent("128/82");
    expect(screen.getByTestId("value-pulse")).toHaveTextContent("76");
    expect(screen.queryByTestId("saved-banner")).toBeNull();
    online = true;
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("saved-banner")).toBeTruthy();
    expect(s.of("POST /opd/visits/e4/vitals")).toHaveLength(2);
  });

  it("says the fee gate in the nurse's language and names the way through", async () => {
    const s = server(base({ "POST /opd/visits/e4/vitals": () => ({ status: 409, body: { code: "consult_gate_refused", message: "the vitals desk is gated: fee_unsettled" } }) }));
    await mount(s.fetcher);
    await takeToken("4");
    await commit("bp", "128/82");
    await type("pulse", "76");
    await type("spo2", "99");
    await type("weightKg", "58");
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("capture-error")).toHaveTextContent(/Not billed yet — the counter has not taken this visit's fee/);
  });

  it("holds a slipped-digit weight until the nurse says which it was", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("4");
    await commit("weightKg", "6.8");
    expect(await screen.findByTestId("mirror")).toHaveTextContent(/6.8 kg on an adult/);
    expect(screen.getByTestId("value-weightKg")).toHaveTextContent("—");
    await fireEvent.press(screen.getByTestId("mirror-fix"));
    expect(screen.getByTestId("value-weightKg")).toHaveTextContent("68");
  });

  it("takes a scanned card through the server's check to the patient in hand", async () => {
    (globalThis as { __scan?: string }).__scan = "q1.p7.U00110060.1.sig";
    const s = server(base({ "POST /patients/qr/verify": () => ({ status: 200, body: { ok: true, patient: { id: "p7", uhid: "U00110060", name: "Aarav Kumar" } } }) }));
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("who-name")).toHaveTextContent("Aarav Kumar");
    expect(s.of("POST /patients/qr/verify")[0]!.body).toEqual({ payload: "q1.p7.U00110060.1.sig" });
  });

  it("refuses a copied card with the server's reason", async () => {
    (globalThis as { __scan?: string }).__scan = "q1.bad";
    const s = server(base({ "POST /patients/qr/verify": () => ({ status: 200, body: { ok: false, reason: "invalid_signature" } }) }));
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("identify-error")).toHaveTextContent("That card did not verify — a copied or edited code");
  });

  /* ═══ §3i (owner 2026-10-07) — a saved chart is corrected on the phone, on the web bay's own routes and rules ═══ */

  const CHART = {
    id: "v1", recordedAt: "2026-10-06T06:10:00.000Z", recordedByName: "Asha Devi", status: "active", emergency: false, notes: null,
    heightCm: 158, weightKg: 62, sbp: 150, dbp: 90, pulse: 88, rr: null, spo2: 97, tempC: null, muacCm: null,
    readings: { bp: { takes: [[150, 90]], source: "typed" }, pulse: { takes: [88], source: "typed" }, heightCm: { takes: [158], source: "typed" } },
    contextChips: [], carriedForward: ["heightCm"],
  };
  const charted = (extra: Record<string, Route> = {}) => server(base({
    "GET /opd/bench": () => ({ status: 200, body: { items: [row({ vitalsDone: true, vitalsId: "v1" })] } }),
    "GET /opd/vitals/v1": () => ({ status: 200, body: { vitals: CHART } }),
    ...extra,
  }));
  const openAmend = async (s: ReturnType<typeof server>) => {
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("bench-row-4"));
    await fireEvent.press(await screen.findByTestId("amend-open"));
    await screen.findByTestId("amend-fields");
  };

  it("amend: a copy of the saved chart, nothing sent without a reason, and the correction carries the readings and what was carried", async () => {
    const s = charted({ "POST /opd/vitals/v1/amend": () => ({ status: 201, body: { vitals: { ...CHART, id: "v2", sbp: 140 }, flags: [], superseded: "v1" } }) });
    await openAmend(s);
    expect(screen.getByTestId("amend-sbp").props.value).toBe("150");
    expect(screen.getByTestId("amend-save")).toBeDisabled(); // nothing changed yet
    await fireEvent.changeText(screen.getByTestId("amend-sbp"), "140");
    expect(screen.getByTestId("amend-was-sbp")).toHaveTextContent("was 150");
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amend-error")).toHaveTextContent("An amendment needs a reason — it is the record");
    expect(s.of("POST /opd/vitals/v1/amend")).toHaveLength(0);

    await fireEvent.press(screen.getByTestId("amend-reason-otherArm"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    await waitFor(() => expect(s.of("POST /opd/vitals/v1/amend")).toHaveLength(1));
    expect(s.of("POST /opd/vitals/v1/amend")[0]!.body).toMatchObject({
      sbp: 140, dbp: 90, pulse: 88, heightCm: 158, rr: null, tempC: null,
      reason: "Rechecked on the other arm", emergency: false,
      readings: { bp: { takes: [[140, 90]], source: "typed" }, pulse: { takes: [88], source: "typed" } },
      carriedForward: ["heightCm"],
    });
    expect(await screen.findByTestId("amended-banner")).toHaveTextContent(/Corrected for Geeta Devi — SBP 150 → 140/);
    expect(screen.queryByTestId("amend")).toBeNull();
  });

  it("amend: a correction that does not reach the server stays on screen and says the saved chart stands — then goes on a second tap", async () => {
    let up = false;
    const s = charted({ "POST /opd/vitals/v1/amend": () => (up ? { status: 201, body: { vitals: { ...CHART, id: "v2", pulse: 78 }, flags: [], superseded: "v1" } } : "offline") });
    await openAmend(s);
    await fireEvent.changeText(screen.getByTestId("amend-pulse"), "78");
    await fireEvent.changeText(screen.getByTestId("amend-reason"), "counted again for a full minute");
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amend-error")).toHaveTextContent(/Nothing was changed — the saved chart stands/);
    expect(screen.getByTestId("amend-pulse").props.value).toBe("78");
    expect(screen.queryByTestId("amended-banner")).toBeNull();
    up = true;
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amended-banner")).toBeTruthy();
    expect(s.of("POST /opd/vitals/v1/amend").map((c) => (c.body as { reason: string }).reason)).toEqual(["counted again for a full minute", "counted again for a full minute"]);
  });

  it("amend: a carried value needs its own re-measure reason, a gate the server raises is confirmed here, and °F is read for the temperature", async () => {
    let n = 0;
    const s = charted({
      "POST /opd/vitals/v1/amend": () => {
        n += 1;
        return n === 1
          ? { status: 422, body: { code: "vitals_gate", message: "held", detail: { gates: [{ key: "heightCm", kind: "shrinking_adult", value: 150, message: "height 150 against 158 — re-measure once before it becomes true" }] } } }
          : { status: 201, body: { vitals: { ...CHART, id: "v2", heightCm: 150, tempC: 38.5 }, flags: [], superseded: "v1" } };
      },
    });
    await openAmend(s);
    await fireEvent.changeText(screen.getByTestId("amend-heightCm"), "150");
    await fireEvent.changeText(screen.getByTestId("amend-tempC"), "101.3");
    await fireEvent.press(screen.getByTestId("amend-reason-remeasured"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    // Height was CARRIED FORWARD: the phone asks for the re-measure reason before it sends anything.
    expect(await screen.findByTestId("amend-unlock-heightCm")).toBeTruthy();
    expect(s.of("POST /opd/vitals/v1/amend")).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("amend-unlock-heightCm-yearly_remeasure_due"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    await fireEvent.press(await screen.findByTestId("amend-gate-confirm-heightCm"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amended-banner")).toBeTruthy();
    const sent = s.of("POST /opd/vitals/v1/amend").map((c) => c.body as Record<string, unknown>);
    expect(sent[0]).toMatchObject({ heightCm: 150, tempC: 38.5, unlockReasons: { heightCm: "yearly_remeasure_due" }, carriedForward: [] });
    expect(sent[0]!.overrides).toBeUndefined();
    expect(sent[1]).toMatchObject({ overrides: { heightCm: "confirmed_after_remeasure" } });
  });

  it("amend: a temperature that is neither °C nor °F is refused before anything is sent; 'Leave it' sends nothing", async () => {
    const s = charted();
    await openAmend(s);
    await fireEvent.changeText(screen.getByTestId("amend-tempC"), "60");
    await fireEvent.press(screen.getByTestId("amend-reason-keyed"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amend-error")).toHaveTextContent(/°C \(like 37.2\) or °F/);
    await fireEvent.press(screen.getByTestId("amend-leave"));
    expect(await screen.findByTestId("already-charted")).toBeTruthy();
    expect(s.calls.filter((c) => c.key.startsWith("POST"))).toHaveLength(0);
  });

  it("shows the unpaid mark and the saved chart's note on a row already charted", async () => {
    const s = server(base({
      "GET /opd/bench": () => ({ status: 200, body: { items: [row({ vitalsDone: true, vitalsId: "v1" })] } }),
      "GET /opd/visits/e4/prestage": () => ({ status: 200, body: { ...ADULT, feeUnpaid: true } }),
    }));
    await mount(s.fetcher);
    expect(await screen.findByTestId("bench-state-4")).toHaveTextContent("✓ with doctor");
    await fireEvent.press(screen.getByTestId("bench-row-4"));
    expect(await screen.findByTestId("already-charted")).toBeTruthy();
    expect(await screen.findByTestId("unpaid-mark")).toHaveTextContent(/NOT PAID/);
    expect(screen.queryByTestId("tiles")).toBeNull();
  });

  it("keeps the last bench and stamps its time when a re-read fails", async () => {
    jest.useFakeTimers();
    try {
      let ok = true;
      const s = server(base({ "GET /opd/bench": () => (ok ? { status: 200, body: { items: [row({})] } } : "offline") }));
      await mount(s.fetcher);
      await act(async () => { await jest.advanceTimersByTimeAsync(50); });
      expect(screen.getByTestId("bench-row-4")).toBeTruthy();
      ok = false;
      await act(async () => { await jest.advanceTimersByTimeAsync(5_100); });
      expect(screen.getByTestId("bench-failed")).toHaveTextContent(/No connection — the bench is shown as of \d\d:\d\d/);
      expect(screen.getByTestId("bench-row-4")).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it("offers a rest for an elevated first BP and sends the patient to the chairs", async () => {
    const s = server(base({
      "POST /opd/visits/e4/bench-state": () => ({ status: 201, body: row({ benchState: "resting", recallAt: "2026-10-06T05:00:00.000Z" }) }),
    }));
    await mount(s.fetcher);
    await takeToken("4");
    await commit("bp", "168/96");
    expect(await screen.findByTestId("rest-offer")).toHaveTextContent(/Elevated, not dangerous — 5 minutes on the rest chairs/);
    await fireEvent.press(screen.getByTestId("rest-go"));
    expect(await screen.findByTestId("rest-banner")).toHaveTextContent("To the rest chairs: Geeta Devi — recall at 10:30. The desk is clear.");
    expect(s.of("POST /opd/visits/e4/bench-state")[0]!.body).toEqual({ state: "resting", restMinutes: 5, note: "first reading 168/96" });
  });

  it("speaks Hindi", async () => {
    const { fetcher } = server(base());
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <I18nProvider initial="hi"><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getByText("आपके सामने कौन है?")).toBeTruthy());
    expect(screen.getByText("वाइटल्स बे")).toBeTruthy();
  });
});
