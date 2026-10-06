import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { VitalsBay } from "../src/screens/vitals-bay";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  let v: string | null = JSON.stringify({ token: "t1", username: "asha.devi" });
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async () => v),
    setItemAsync: jest.fn(async (_k: string, val: string) => { v = val; }),
    deleteItemAsync: jest.fn(async () => { v = null; }),
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
  encounterId: "e4", entryId: "q4", tokenNo: 4, seq: 4, doctorId: "d1", doctorName: "Dr Chandan Kumar", serviceDate: "2026-10-06",
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
const KID_ROW = row({ encounterId: "e7", entryId: "q7", tokenNo: 7, seq: 7, patient: { requestedId: "p7", id: "p7", uhid: "U00110060", name: "Aarav Kumar", alias: null, restricted: false, administrativeGender: "male", dob: null } });

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
    expect(await screen.findByTestId("identify-error")).toHaveTextContent("99 is not on this bench — check the slip, or send them to the front desk");
  });

  it("reads a BP typed with a dash and a temperature typed in °F, before they are charted", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("4");
    await type("bp", "150-90");
    expect(screen.getByTestId("reads-bp")).toHaveTextContent("reads 150/90 mmHg");
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
    expect(screen.getByTestId("label-bp")).toHaveTextContent("BP *");
    expect(screen.getByTestId("label-tempC")).toHaveTextContent(/^Temp$/);
  });

  it("asks a child for no BP, and saves the chart without one", async () => {
    const s = server(base({ "POST /opd/visits/e7/vitals": () => ({ status: 201, body: { flags: [] } }) }));
    await mount(s.fetcher);
    await takeToken("7");
    expect(screen.getByTestId("label-bp")).toHaveTextContent(/^BP$/);
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
    expect(await screen.findByTestId("missing")).toHaveTextContent("Still needed: BP, SpO₂, Weight");
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
