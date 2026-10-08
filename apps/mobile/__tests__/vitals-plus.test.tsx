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


/**
 * OWNER 2026-10-08 — the phone's vitals screen opens with four boxes and a "+": *"keep BP, Weight,
 * height & Pulse as the primary and add a '+' icon to add more vitals like RR, Temperature,
 * Glucose"*; *"Move SpO2 behind '+'. Add Glucose behind '+'."* Board: /boards/2026-10-08-scan-vitals,
 * frames A–D. The pre-stages here are what the server sends AFTER the ruling (no SpO₂ demanded).
 */
const ME = { actor: { type: "user", id: "01J" }, permissions: { hospital: ["opd.vitals.record"], scoped: { department: {}, floor: {} } } };
const row = (over: Record<string, unknown>) => ({
  encounterId: "e9", entryId: "q9", tokenNo: 9, seq: 9, visitNo: "V2610080009", departmentCode: "MED", doctorId: "d1", doctorName: "Dr Chandan Kumar", serviceDate: "2026-10-08",
  patient: { requestedId: "p9", id: "p9", uhid: "U00110049", name: "Ram Pravesh Yadav", alias: null, restricted: false, administrativeGender: "male", dob: null },
  benchState: null, recallAt: null, vitalsDone: false, vitalsId: null, escalation: "none", cancelMsRemaining: 0, recallDue: false,
  ...over,
});
const ADULT = {
  patientId: "p9", ageYears: 54, band: "adult",
  ranges: { sbp: { min: 90, max: 180 }, dbp: { min: 60, max: 110 }, pulse: { min: 50, max: 120 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } },
  noticeRanges: {}, gates: { adultWeightFloorKg: 20, heightDeltaCm: 5, spo2ProbeFloorPct: 70 }, muacBands: { samUnderCm: 11.5, mamUnderCm: 12.5 },
  sealed: false, required: ["heightCm", "weightKg", "sbp", "dbp", "pulse"], notRoutine: [], feeUnpaid: false, feeBypass: null,
  last: null, carryCandidates: [], expectedFlags: [],
};
const BABY = {
  ...ADULT, patientId: "p3", ageYears: 3, band: "child_1_5", required: ["heightCm", "weightKg", "pulse", "muacCm"], notRoutine: ["sbp", "dbp"],
  ranges: { pulse: { min: 70, max: 150 }, spo2: { min: 90 }, tempC: { min: 35, max: 39.5 } },
};
const BABY_ROW = row({ encounterId: "e3", entryId: "q3", tokenNo: 3, seq: 3, visitNo: "V2610080003", departmentCode: "PED", patient: { requestedId: "p3", id: "p3", uhid: "U00110060", name: "Baby Anshu", alias: null, restricted: false, administrativeGender: "female", dob: null } });

function base(extra: Record<string, Route> = {}): Record<string, Route> {
  return {
    "GET /auth/me": () => ({ status: 200, body: ME }),
    "GET /opd/bench": () => ({ status: 200, body: { items: [row({}), BABY_ROW] } }),
    "GET /opd/queues/summary": () => ({ status: 200, body: { items: [{ waitingVitalsCount: 2 }] } }),
    "GET /opd/visits/e9/prestage": () => ({ status: 200, body: ADULT }),
    "GET /opd/visits/e3/prestage": () => ({ status: 200, body: BABY }),
    "GET /opd/visits/e9/escalation": () => ({ status: 200, body: { escalation: null } }),
    "GET /opd/visits/e3/escalation": () => ({ status: 200, body: { escalation: null } }),
    "POST /opd/visits/e9/vitals": () => ({ status: 201, body: { vitals: { id: "v9" }, flags: [] } }),
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
async function commit(key: string, text: string) {
  await fireEvent.changeText(screen.getByTestId(`input-${key}`), text);
  await fireEvent(screen.getByTestId(`input-${key}`), "submitEditing");
}
const ALL = ["bp", "pulse", "weightKg", "heightCm", "spo2", "tempC", "glucoseMgDl", "rr", "muacCm"];
/** The boxes on screen, in the order they are drawn. */
const boxes = (): string[] => screen.getAllByTestId(/^tile-/).map((n) => String(n.props.testID).replace("tile-", ""));
async function add(key: string) {
  await fireEvent.press(screen.getByTestId("plus-row"));
  await fireEvent.press(await screen.findByTestId(`plus-add-${key}`));
}
async function fillFour() {
  await commit("bp", "148-92"); await commit("pulse", "84"); await commit("weightKg", "71.5"); await commit("heightCm", "168");
}
const POST = "POST /opd/visits/e9/vitals";

describe("frame A — an adult, as it opens", () => {
  it("shows exactly four boxes, in the board's order, and a '+' row naming what is behind it", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("9");
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm"]);
    for (const k of ALL.slice(4)) expect(screen.queryByTestId(`tile-${k}`)).toBeNull();
    expect(screen.getByTestId("plus-row")).toHaveTextContent(/Add a reading/);
    expect(screen.getByTestId("plus-names")).toHaveTextContent("SpO₂ · Temperature · Glucose · Breathing rate");
    expect(screen.getByTestId("label-bp")).toHaveTextContent("Blood pressure *");
    expect(screen.queryByTestId("auto-note")).toBeNull();
  });

  it("saves with the four filled and SpO₂ empty", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await takeToken("9");
    await fillFour();
    await fireEvent.press(screen.getByTestId("save"));
    await waitFor(() => expect(s.of(POST)).toHaveLength(1));
    const body = s.of(POST)[0]!.body as { readings: Record<string, unknown>; emergency: boolean; glucoseTiming?: string };
    expect(Object.keys(body.readings).sort()).toEqual(["bp", "heightCm", "pulse", "weightKg"]);
    expect(body.emergency).toBe(false);
    expect(body.glucoseTiming).toBeUndefined();
    expect(await screen.findByTestId("saved-banner")).toHaveTextContent(/Ram Pravesh Yadav/);
  });
});

describe("frames B and C — '+' tapped, and readings added", () => {
  it("the sheet lists SpO₂, temperature, glucose and breathing rate — one tap each; an added reading is a box and leaves the list", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("9");
    await fireEvent.press(screen.getByTestId("plus-row"));
    const sheet = await screen.findByTestId("plus-sheet");
    expect(sheet).toHaveTextContent(/oxygen, finger probe/);
    expect(screen.getAllByTestId(/^plus-add-/).map((n) => String(n.props.testID).replace("plus-add-", ""))).toEqual(["spo2", "tempC", "glucoseMgDl", "rr"]);
    await fireEvent.press(screen.getByTestId("plus-add-spo2"));
    expect(screen.queryByTestId("plus-sheet")).toBeNull();          // one tap, and the sheet is gone
    await add("glucoseMgDl");
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "glucoseMgDl"]);
    expect(screen.getByTestId("plus-names")).toHaveTextContent("Temperature · Breathing rate");
    await add("tempC"); await add("rr");
    expect(screen.queryByTestId("plus-row")).toBeNull();            // nothing remains: the row is gone
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "tempC", "glucoseMgDl", "rr"]);
  });

  it("an added box left empty can be removed; one holding a value cannot, until the value is cleared", async () => {
    const { fetcher } = server(base());
    await mount(fetcher);
    await takeToken("9");
    await add("rr");
    await fireEvent.press(screen.getByTestId("remove-rr"));
    expect(screen.queryByTestId("tile-rr")).toBeNull();
    expect(screen.getByTestId("plus-names")).toHaveTextContent(/Breathing rate/);

    await add("spo2");
    await commit("spo2", "97");
    expect(screen.getByTestId("value-spo2")).toHaveTextContent("97");
    expect(screen.queryByTestId("remove-spo2")).toBeNull();
    await fireEvent.press(screen.getByTestId("clear-spo2"));
    expect(screen.getByTestId("value-spo2")).toHaveTextContent("—");
    await fireEvent.press(screen.getByTestId("remove-spo2"));
    expect(screen.queryByTestId("tile-spo2")).toBeNull();
    // the four the protocol requires are never removable
    expect(screen.queryByTestId("remove-bp")).toBeNull();
    expect(screen.queryByTestId("clear-bp")).toBeNull();
  });

  it("an SpO₂ that is entered still wears its danger tint", async () => {
    const { fetcher } = server(base({ "POST /opd/visits/e9/escalation/recheck": () => ({ status: 201, body: { entryId: "q9", state: "recheck_demanded", escalatedAt: null, escalatedFromClass: null, escalationBy: null, cancelMsRemaining: 0 } }) }));
    await mount(fetcher);
    await takeToken("9");
    await add("spo2");
    await commit("spo2", "86");
    expect(await screen.findByTestId("tint-spo2")).toBeTruthy();
  });
});

describe("an SpO₂ that was taken is still judged", () => {
  it("a probe error is held and cannot be skipped: re-clip it, confirm it, or clear the box — never a silent save", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await takeToken("9");
    await fillFour();
    await add("spo2");
    await commit("spo2", "45");                                     // below the probe floor: held out of the chart
    expect(screen.getByTestId("held-spo2")).toHaveTextContent(/45/);
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("missing")).toHaveTextContent("Still needed: SpO₂");
    expect(s.of(POST)).toHaveLength(0);
    await fireEvent.press(screen.getByTestId("clear-spo2"));        // a named nurse decides: no SpO₂ today
    await fireEvent.press(screen.getByTestId("save"));
    await waitFor(() => expect(s.of(POST)).toHaveLength(1));
    expect((s.of(POST)[0]!.body as { readings: Record<string, unknown> }).readings.spo2).toBeUndefined();
  });
});

describe("glucose — a whole number and when it was taken", () => {
  it("186 with no timing is not saved and the box says why; with 'Random' it is saved with its timing", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await takeToken("9");
    await fillFour();
    await add("glucoseMgDl");
    for (const k of ["fasting", "random", "after_food"]) expect(screen.getByTestId(`glucose-timing-${k}`).props.accessibilityState.selected).toBe(false);
    await commit("glucoseMgDl", "186");
    expect(screen.getByTestId("value-glucoseMgDl")).toHaveTextContent("186");
    expect(screen.queryByTestId("tint-glucoseMgDl")).toBeNull();     // no colour, no verdict
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("glucose-error")).toHaveTextContent("Choose when it was taken: fasting, random or after food");
    expect(s.of(POST)).toHaveLength(0);

    await fireEvent.press(screen.getByTestId("glucose-timing-random"));
    expect(screen.queryByTestId("glucose-error")).toBeNull();
    await fireEvent.press(screen.getByTestId("save"));
    await waitFor(() => expect(s.of(POST)).toHaveLength(1));
    expect(s.of(POST)[0]!.body).toMatchObject({ glucoseTiming: "random", readings: { glucoseMgDl: { takes: [186], source: "typed" } } });
  });

  it("700 is refused on the box itself and nothing is sent", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await takeToken("9");
    await fillFour();
    await add("glucoseMgDl");
    await fireEvent.press(screen.getByTestId("glucose-timing-fasting"));
    await commit("glucoseMgDl", "700");
    expect(screen.getByTestId("glucose-error")).toHaveTextContent("Glucose is a whole number from 20 to 600 mg/dL");
    expect(screen.getByTestId("value-glucoseMgDl")).toHaveTextContent("—");
    expect(screen.queryByTestId("capture-error")).toBeNull();        // the box's own message, not the bar's
    await fireEvent.press(screen.getByTestId("save"));
    expect(s.of(POST)).toHaveLength(0);
  });
});

describe("frame D — readings that come up by themselves", () => {
  it("an emergency save still needs SpO₂: it comes up without '+', marked, and the save goes once it is filled", async () => {
    const s = server(base());
    await mount(s.fetcher);
    await takeToken("9");
    await commit("bp", "208-126"); await commit("pulse", "104");
    expect(screen.queryByTestId("tile-spo2")).toBeNull();
    await fireEvent.press(screen.getByTestId("save-emergency"));
    expect(await screen.findByTestId("tile-spo2")).toBeTruthy();
    expect(screen.getByTestId("missing")).toHaveTextContent(/SpO₂/);
    expect(s.of(POST)).toHaveLength(0);
    await commit("spo2", "91");
    await fireEvent.press(screen.getByTestId("save-emergency"));
    await waitFor(() => expect(s.of(POST)).toHaveLength(1));
    expect(s.of(POST)[0]!.body).toMatchObject({ emergency: true, readings: { spo2: { takes: [91] } } });
  });

  it("a child under six: temperature and the arm band are there without '+', the amber line says why, and the arm band is required", async () => {
    const s = server(base({ "POST /opd/visits/e3/vitals": () => ({ status: 201, body: { vitals: { id: "v3" }, flags: [] } }) }));
    await mount(s.fetcher);
    await takeToken("3");
    expect(boxes()).toEqual(["weightKg", "heightCm", "pulse", "tempC", "muacCm"]);
    expect(screen.getByTestId("auto-note")).toHaveTextContent("Child under six: Temperature and Arm band (MUAC) are asked.");
    expect(screen.getByTestId("label-muacCm")).toHaveTextContent("Arm band (MUAC) *");
    expect(screen.getByTestId("label-tempC")).toHaveTextContent(/^Temperature$/);   // asked, never mandatory (owner 2026-10-05)
    expect(screen.getByTestId("plus-names")).toHaveTextContent("SpO₂ · Glucose · Breathing rate · Blood pressure");
    await commit("weightKg", "14"); await commit("heightCm", "92"); await commit("pulse", "100");
    await fireEvent.press(screen.getByTestId("save"));
    expect(await screen.findByTestId("missing")).toHaveTextContent(/Arm band \(MUAC\)/);
    expect(s.of("POST /opd/visits/e3/vitals")).toHaveLength(0);
    await commit("muacCm", "13.4");
    await fireEvent.press(screen.getByTestId("save"));
    await waitFor(() => expect(s.of("POST /opd/visits/e3/vitals")).toHaveLength(1));
  });

  it("a reading the server's protocol requires, or the last chart flagged, is there without '+'", async () => {
    const { fetcher } = server(base({
      "GET /opd/visits/e9/prestage": () => ({ status: 200, body: { ...ADULT, required: [...ADULT.required, "rr"], expectedFlags: [{ vital: "spo2", value: 86, bound: "min", limit: 90 }] } }),
    }));
    await mount(fetcher);
    await takeToken("9");
    expect(boxes()).toEqual(["bp", "pulse", "weightKg", "heightCm", "spo2", "rr"]);
    expect(screen.getByTestId("label-rr")).toHaveTextContent("Breathing rate *");
    expect(screen.getByTestId("label-spo2")).toHaveTextContent(/^SpO₂$/);
    expect(screen.getByTestId("auto-note")).toHaveTextContent("Asked for this patient: Breathing rate.");
    expect(screen.getByTestId("plus-names")).toHaveTextContent("Temperature · Glucose");
  });
});

describe("a saved chart, reopened", () => {
  const CHART = {
    id: "v1", recordedAt: "2026-10-08T06:10:00.000Z", recordedByName: "Asha Devi", status: "active", emergency: false, notes: null,
    heightCm: 168, weightKg: 71.5, sbp: 148, dbp: 92, pulse: 84, rr: null, spo2: 97, tempC: 37.2, muacCm: null, glucoseMgDl: 186, glucoseTiming: "random",
    readings: { bp: { takes: [[148, 92]], source: "typed" }, spo2: { takes: [97], source: "typed" }, glucoseMgDl: { takes: [186], source: "typed" } },
    contextChips: [], carriedForward: [],
  };
  it("shows the saved SpO₂, temperature and glucose with its timing — and a corrected glucose travels with a timing", async () => {
    const s = server(base({
      "GET /opd/bench": () => ({ status: 200, body: { items: [row({ vitalsDone: true, vitalsId: "v1" })] } }),
      "GET /opd/vitals/v1": () => ({ status: 200, body: { vitals: CHART } }),
      "POST /opd/vitals/v1/amend": () => ({ status: 201, body: { vitals: { ...CHART, id: "v2", glucoseMgDl: 168, glucoseTiming: "fasting" }, flags: [], superseded: "v1" } }),
    }));
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("bench-row-9"));
    await fireEvent.press(await screen.findByTestId("amend-open"));
    await screen.findByTestId("amend-fields");
    expect(screen.getByTestId("amend-spo2").props.value).toBe("97");
    expect(screen.getByTestId("amend-tempC").props.value).toBe("37.2");
    expect(screen.getByTestId("amend-glucoseMgDl").props.value).toBe("186");
    expect(screen.getByTestId("amend-glucose-timing-random").props.accessibilityState.selected).toBe(true);

    // the timing alone is a correction
    expect(screen.getByTestId("amend-save")).toBeDisabled();
    await fireEvent.press(screen.getByTestId("amend-glucose-timing-fasting"));
    expect(screen.getByTestId("amend-save")).not.toBeDisabled();
    await fireEvent.changeText(screen.getByTestId("amend-glucoseMgDl"), "168");
    await fireEvent.press(screen.getByTestId("amend-reason-keyed"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    await waitFor(() => expect(s.of("POST /opd/vitals/v1/amend")).toHaveLength(1));
    expect(s.of("POST /opd/vitals/v1/amend")[0]!.body).toMatchObject({
      glucoseMgDl: 168, glucoseTiming: "fasting", spo2: 97, tempC: 37.2,
      readings: { glucoseMgDl: { takes: [168], source: "typed" } },
    });
    expect(await screen.findByTestId("amended-banner")).toHaveTextContent(/Glucose 186 → 168/);
  });

  it("a glucose typed into a correction with no timing chosen is not sent", async () => {
    const s = server(base({
      "GET /opd/bench": () => ({ status: 200, body: { items: [row({ vitalsDone: true, vitalsId: "v1" })] } }),
      "GET /opd/vitals/v1": () => ({ status: 200, body: { vitals: { ...CHART, glucoseMgDl: null, glucoseTiming: null, readings: {} } } }),
    }));
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("bench-row-9"));
    await fireEvent.press(await screen.findByTestId("amend-open"));
    await fireEvent.changeText(await screen.findByTestId("amend-glucoseMgDl"), "700");
    await fireEvent.press(screen.getByTestId("amend-reason-keyed"));
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amend-error")).toHaveTextContent(/whole number from 20 to 600/);
    await fireEvent.changeText(screen.getByTestId("amend-glucoseMgDl"), "186");
    await fireEvent.press(screen.getByTestId("amend-save"));
    expect(await screen.findByTestId("amend-error")).toHaveTextContent(/Choose when it was taken/);
    expect(s.of("POST /opd/vitals/v1/amend")).toHaveLength(0);
  });
});

describe("in Hindi", () => {
  it("the '+' row and the glucose chips are translated", async () => {
    const { fetcher } = server(base());
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
        <I18nProvider initial="hi"><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
      </SafeAreaProvider>,
    );
    await takeToken("9");
    expect(screen.getByTestId("plus-row")).toHaveTextContent(/रीडिंग जोड़ें/);
    await add("glucoseMgDl");
    expect(screen.getByTestId("glucose-timing-fasting")).toHaveTextContent("खाली पेट");
  });
});
