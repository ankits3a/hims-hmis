import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { _forgetLabModeForTests } from "../src/lab/mode";
import { QuickBench } from "../src/screens/lab-qbench";
import { QuickCollect } from "../src/screens/lab-qcollect";
import { QuickReports } from "../src/screens/lab-qreports";
import { SeatHome, _forgetHomeForTests } from "../src/screens/seat-home";
import { SessionProvider, useSession } from "../src/session";

/**
 * QUICK LAB ON THE PHONE (spec `SPEC-phone-quick-lab-2026-10-12.md`) — the web quick chain's three
 * steps on the same routes: collect, the bench's results form, and the reports' hand-over.
 */
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "lab.tech", since: new Date().toISOString() })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
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

type Reply = { status: number; body?: unknown };
type Route = (body: unknown, url: string) => Reply;

function server(perms: string[], routes: Record<string, Route>) {
  const calls: { key: string; body: unknown; url: string }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").replace(/\?.*$/, "")}`;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ key, body, url });
    if (key === "GET /auth/me") {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-me" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } }), { status: 200 });
    }
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const reply = r(body, url);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, of: (key: string) => calls.filter((c) => c.key === key) };
}

function Gate({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  return state.status === "signedIn" ? <>{children}</> : null;
}
async function mount(fetcher: typeof fetch, node: React.ReactNode, lang: "en" | "hi" = "en") {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><Gate>{node}</Gate></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

const RAM = { id: "p1", uhid: "UH00001", display: "Ram Kumar", administrativeGender: "male", dob: "1980-01-01" };
const SITA = { id: "p2", uhid: "UH00002", display: "Sita Devi", administrativeGender: "female", dob: "1990-05-05" };
const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const collectRow = (orderId: string, patient: typeof RAM, tests = [{ serviceId: "s-cbc", code: "CBC", nameEn: "Complete blood count" }]) => ({
  orderId, orderNo: `LO-${orderId}`, encounterNo: `V-${orderId}`, placedAt: ago(12), priority: "routine", patient, tests,
});
const row = (id: string, patient: typeof RAM, status: "waiting" | "draft" | "reported", over: Record<string, unknown> = {}) => ({
  id, status, patient, encounterNo: "V-1", tests: [{ serviceId: "s-lip", code: "LIPID", nameEn: "Lipid profile" }],
  collectedAt: ago(30), collectedBy: "u-p", reportedAt: status === "reported" ? ago(5) : null, reportedBy: null,
  orderId: "o1", orderNo: "LO-1", sampleNo: "S-0042", handedOverAt: null, handedOverBy: null, ...over,
});

/* ═══════════════════════════════ home: who sees the three ═══════════════════════════════ */

describe("quick lab on the home screen", () => {
  beforeEach(() => { _forgetHomeForTests(); _forgetLabModeForTests(); });

  it("shows the three screens while the lab runs Quick", async () => {
    const w = server(["lab.worklist.read", "lab.results.enter", "lab.reports.print"], { "GET /lab/desk/mode": () => ({ status: 200, body: { mode: "quick" } }) });
    await mount(w.fetcher, <SeatHome />);
    expect(await screen.findByTestId("seat-qcollect")).toHaveTextContent(/Quick Collect/);
    expect(screen.getByTestId("seat-qbench")).toHaveTextContent(/Quick Bench/);
    expect(screen.getByTestId("seat-qreports")).toHaveTextContent(/Quick Reports/);
    expect(w.of("GET /lab/desk/mode").length).toBeGreaterThan(0);
  });

  it("all three disappear when the lab runs Full", async () => {
    const w = server(["lab.worklist.read", "lab.results.enter", "lab.reports.print", "roster.read"], { "GET /lab/desk/mode": () => ({ status: 200, body: { mode: "full" } }) });
    await mount(w.fetcher, <SeatHome />);
    await screen.findByTestId("seat-onNow");
    await waitFor(() => expect(w.of("GET /lab/desk/mode").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByTestId("seat-qcollect")).toBeNull());
    expect(screen.queryByTestId("seat-qbench")).toBeNull();
    expect(screen.queryByTestId("seat-qreports")).toBeNull();
  });

  it("a failed mode read hides nothing", async () => {
    const w = server(["lab.worklist.read"], { "GET /lab/desk/mode": () => ({ status: 500, body: { message: "boom" } }) });
    await mount(w.fetcher, <SeatHome />);
    expect(await screen.findByTestId("seat-qcollect")).toBeTruthy();
  });

  it("a person with no lab grant is never asked about the mode and sees no lab screen", async () => {
    const w = server(["roster.read"], { "GET /lab/desk/mode": () => ({ status: 200, body: { mode: "quick" } }) });
    await mount(w.fetcher, <SeatHome />);
    await screen.findByTestId("seat-onNow");
    expect(screen.queryByTestId("seat-qcollect")).toBeNull();
    expect(w.of("GET /lab/desk/mode")).toHaveLength(0);
  });
});

/* ═══════════════════════════════ Quick Collect ═══════════════════════════════ */

describe("Quick Collect", () => {
  function world() {
    const state = { queue: [collectRow("o1", RAM), collectRow("o2", SITA, [{ serviceId: "s-lip", code: "LIPID", nameEn: "Lipid profile" }])] };
    const w = server(["lab.worklist.read"], {
      "GET /lab/quick/collect": () => ({ status: 200, body: state.queue }),
      "POST /lab/quick/collect/o1": () => { state.queue = state.queue.filter((q) => q.orderId !== "o1"); return { status: 201, body: row("r1", RAM, "waiting", { sampleNo: "S-0101" }) }; },
      "POST /lab/quick/collect/o2": () => { state.queue = state.queue.filter((q) => q.orderId !== "o2"); return { status: 201, body: row("r2", SITA, "waiting", { sampleNo: "S-0102" }) }; },
      "POST /patients/qr/verify": () => ({ status: 200, body: { ok: true, patient: { id: "p2", uhid: "UH00002", name: "Sita Devi" } } }),
    });
    return { ...w, state };
  }

  it("lists who waits for blood; tap, see the tests, Blood collected stamps the sample and moves them on", async () => {
    const w = world();
    await mount(w.fetcher, <QuickCollect />);
    expect(await screen.findByTestId("qc-row-o1")).toHaveTextContent(/Ram Kumar/);
    expect(screen.getByTestId("qc-row-o2")).toHaveTextContent(/Sita Devi/);
    await fireEvent.press(screen.getByTestId("qc-row-o1"));
    expect(await screen.findByTestId("qc-tests")).toHaveTextContent(/Complete blood count/);
    await fireEvent.press(screen.getByTestId("qc-collect"));
    expect(await screen.findByTestId("qc-done")).toHaveTextContent(/S-0101/);
    expect(w.of("POST /lab/quick/collect/o1")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("qc-row-o1")).toBeNull());
    expect(screen.getByTestId("qc-row-o2")).toBeTruthy();
  });

  it("a typed UHID opens that patient", async () => {
    const w = world();
    await mount(w.fetcher, <QuickCollect />);
    await screen.findByTestId("qc-row-o2");
    await fireEvent.changeText(screen.getByTestId("qc-find"), "uh00002");
    await fireEvent(screen.getByTestId("qc-find"), "submitEditing");
    expect(await screen.findByTestId("qc-tests")).toHaveTextContent(/Lipid profile/);
    expect(screen.getByTestId("qc-open")).toHaveTextContent(/Sita Devi/);
  });

  it("a scanned card is verified by the server, then opens that patient", async () => {
    const w = world();
    await mount(w.fetcher, <QuickCollect />);
    await screen.findByTestId("qc-row-o2");
    (globalThis as { __scan?: string }).__scan = "q1.signed-card-payload";
    await fireEvent.press(screen.getByTestId("qc-scan"));
    await fireEvent.press(await screen.findByTestId("fake-camera"));
    expect(await screen.findByTestId("qc-open")).toHaveTextContent(/Sita Devi/);
    expect(w.of("POST /patients/qr/verify")[0]!.body).toEqual({ payload: "q1.signed-card-payload" });
  });

  it("a patient not waiting for blood says so, briefly", async () => {
    const w = world();
    await mount(w.fetcher, <QuickCollect />);
    await screen.findByTestId("qc-row-o2");
    await fireEvent.changeText(screen.getByTestId("qc-find"), "UH99999");
    await fireEvent(screen.getByTestId("qc-find"), "submitEditing");
    expect(await screen.findByTestId("ql-note")).toHaveTextContent("Not waiting for blood");
  });

  it("Full mode on the server: a short note, no crash", async () => {
    const w = server(["lab.worklist.read"], { "GET /lab/quick/collect": () => ({ status: 409, body: { code: "lab_mode_off", message: "the lab runs full mode" } }) });
    await mount(w.fetcher, <QuickCollect />);
    expect(await screen.findByTestId("ql-error")).toHaveTextContent("Lab is in Full mode");
  });
});

/* ═══════════════════════════════ Quick Bench ═══════════════════════════════ */

const CATALOGUE = {
  tests: [{ serviceId: "s-lip", code: "LIPID", nameEn: "Lipid profile", analyteIds: ["a-tc", "a-hdl", "a-tg", "a-ldl"] }],
  analytes: [
    { analyteId: "a-tc", code: "TC", nameEn: "Total cholesterol", unit: "mg/dL", resultType: "numeric", decimals: 0, absurdLow: null, absurdHigh: null },
    { analyteId: "a-hdl", code: "HDL", nameEn: "HDL cholesterol", unit: "mg/dL", resultType: "numeric", decimals: 0, absurdLow: null, absurdHigh: null },
    { analyteId: "a-tg", code: "TG", nameEn: "Triglycerides", unit: "mg/dL", resultType: "numeric", decimals: 0, absurdLow: null, absurdHigh: null },
    { analyteId: "a-ldl", code: "LDL", nameEn: "LDL cholesterol", unit: "mg/dL", resultType: "formula", decimals: 0, absurdLow: null, absurdHigh: null, formula: "TC - HDL - TG / 5", formulaGuard: "TG < 400" },
  ],
};
const range = (analyteId: string, low: string | null, high: string | null) => ({ analyteId, low, high, text: null, criticalLow: null, criticalHigh: null, note: null });
const RANGES = { items: [range("a-tc", null, "200.0000"), range("a-hdl", "40", "60"), range("a-tg", null, "150"), range("a-ldl", null, "100")] };

describe("Quick Bench", () => {
  function world(over: { draft?: boolean; ldl?: boolean } = {}) {
    const base = row("r1", RAM, over.draft === true ? "draft" : "waiting");
    const tc = { analyteId: "a-tc", code: "TC", nameEn: "Total cholesterol", unit: "mg/dL", value: "190", low: null, high: "200", refText: null, flag: "N" };
    const ldl = { analyteId: "a-ldl", code: "LDL", nameEn: "LDL cholesterol", unit: "mg/dL", value: "120", low: null, high: "100", refText: null, flag: "H" };
    const report = { ...base, analyteIds: ["a-tc", "a-hdl", "a-tg", "a-ldl"], groups: [{ title: "Lipid profile", analyteIds: ["a-tc", "a-hdl", "a-tg", "a-ldl"] }], lines: over.draft === true ? (over.ldl === true ? [tc, ldl] : [tc]) : [], summary: "", collectedByName: null, reportedByName: null, hospital: { name: "", address: "", hotline: "", emergency: "", email: "", website: "" }, visitQrSvg: null };
    const state = { waiting: [base] as unknown[] };
    const w = server(["lab.results.enter"], {
      "GET /lab/quick/queue": () => ({ status: 200, body: { waiting: state.waiting, reportedToday: [] } }),
      "GET /lab/quick/catalogue": () => ({ status: 200, body: CATALOGUE }),
      "GET /lab/quick/reports/r1": () => ({ status: 200, body: report }),
      "GET /lab/quick/ranges": () => ({ status: 200, body: RANGES }),
      "PUT /lab/quick/reports/r1": (body) => {
        const complete = (body as { complete?: boolean }).complete === true;
        if (complete) state.waiting = [];
        return { status: 200, body: { ...report, status: complete ? "reported" : "draft" } };
      },
    });
    return { ...w, state };
  }

  async function openAndType(w: ReturnType<typeof world>) {
    await mount(w.fetcher, <QuickBench />);
    await fireEvent.press(await screen.findByTestId("qb-row-r1"));
    await screen.findByTestId("qb-input-a-tc");
    await waitFor(() => expect(screen.getByTestId("qb-range-a-tc")).toHaveTextContent(/≤ 200/));
    await fireEvent.changeText(screen.getByTestId("qb-input-a-tc"), "250");
    await fireEvent.changeText(screen.getByTestId("qb-input-a-hdl"), "45");
    await fireEvent.changeText(screen.getByTestId("qb-input-a-tg"), "150");
  }

  it("flags a value out of range, and a calculated value fills itself and cannot be typed", async () => {
    const w = world();
    await openAndType(w);
    expect(screen.getByTestId("qb-flag-a-tc")).toHaveTextContent("H");
    expect(screen.queryByTestId("qb-flag-a-hdl")).toBeNull();
    const ldl = screen.getByTestId("qb-input-a-ldl");
    expect(ldl.props.value).toBe("175");
    expect(ldl.props.editable).toBe(false);
    expect(screen.getByTestId("qb-flag-a-ldl")).toHaveTextContent("H");
    expect(screen.getByTestId("qb-range-a-hdl")).toHaveTextContent(/40 – 60/);
  });

  it("Save & Complete sends the typed values only — never the calculated one — and the report leaves the bench", async () => {
    const w = world();
    await openAndType(w);
    await fireEvent.press(screen.getByTestId("qb-complete"));
    expect(await screen.findByTestId("qb-done")).toHaveTextContent(/Ram Kumar/);
    const sent = w.of("PUT /lab/quick/reports/r1")[0]!.body as { lines: { analyteId: string; value: string }[]; summary: string; complete: boolean };
    expect(sent.complete).toBe(true);
    expect(sent.lines).toEqual([{ analyteId: "a-tc", value: "250" }, { analyteId: "a-hdl", value: "45" }, { analyteId: "a-tg", value: "150" }]);
    expect(sent.summary).toMatch(/Total cholesterol is high: 250 mg\/dL/);
    await waitFor(() => expect(screen.queryByTestId("qb-row-r1")).toBeNull());
  });

  it("Save draft keeps it on the bench", async () => {
    const w = world();
    await openAndType(w);
    await fireEvent.press(screen.getByTestId("qb-draft"));
    expect(await screen.findByTestId("qb-draft-saved")).toHaveTextContent(/Draft saved/);
    expect((w.of("PUT /lab/quick/reports/r1")[0]!.body as { complete: boolean }).complete).toBe(false);
    expect(screen.getByTestId("qb-input-a-tc")).toBeTruthy();
  });

  it("a draft reopens with what was typed", async () => {
    const w = world({ draft: true });
    await mount(w.fetcher, <QuickBench />);
    expect(await screen.findByTestId("qb-row-r1")).toHaveTextContent(/Draft/);
    await fireEvent.press(screen.getByTestId("qb-row-r1"));
    expect((await screen.findByTestId("qb-input-a-tc")).props.value).toBe("190");
  });

  it("a reopened draft carrying the server's LDL still never sends it back", async () => {
    const w = world({ draft: true, ldl: true });
    await mount(w.fetcher, <QuickBench />);
    await fireEvent.press(await screen.findByTestId("qb-row-r1"));
    await screen.findByTestId("qb-input-a-tc");
    await fireEvent.press(screen.getByTestId("qb-complete"));
    await screen.findByTestId("qb-done");
    const sent = w.of("PUT /lab/quick/reports/r1")[0]!.body as { lines: { analyteId: string }[] };
    expect(sent.lines.map((l) => l.analyteId)).toEqual(["a-tc"]);
  });

  it("Save & Complete waits for at least one value", async () => {
    const w = world();
    await mount(w.fetcher, <QuickBench />);
    await fireEvent.press(await screen.findByTestId("qb-row-r1"));
    await screen.findByTestId("qb-input-a-tc");
    await fireEvent.press(screen.getByTestId("qb-complete"));
    expect(w.of("PUT /lab/quick/reports/r1")).toHaveLength(0);
  });
});

/* ═══════════════════════════════ Quick Reports ═══════════════════════════════ */

describe("Quick Reports", () => {
  function world(perms: string[]) {
    const done = row("r2", SITA, "reported");
    const report = {
      ...done, analyteIds: ["a-tc", "a-hdl"], groups: [{ title: "Lipid profile", analyteIds: ["a-tc", "a-hdl"] }],
      lines: [
        { analyteId: "a-tc", code: "TC", nameEn: "Total cholesterol", unit: "mg/dL", value: "250", low: null, high: "200", refText: null, flag: "H" },
        { analyteId: "a-hdl", code: "HDL", nameEn: "HDL cholesterol", unit: "mg/dL", value: "45", low: "40", high: "60", refText: null, flag: "N" },
      ],
      summary: "Total cholesterol is high.", collectedByName: null, reportedByName: null,
      hospital: { name: "", address: "", hotline: "", emergency: "", email: "", website: "" }, visitQrSvg: null,
    };
    const state = { ready: [done] as unknown[] };
    return server(perms, {
      "GET /lab/quick/ready": () => ({ status: 200, body: { ready: state.ready, handedOverToday: [] } }),
      "GET /lab/quick/ready/r2": () => ({ status: 200, body: report }),
      "POST /lab/quick/reports/r2/hand-over": () => { state.ready = []; return { status: 201, body: { ...done, handedOverAt: ago(0) } }; },
      "POST /lab/quick/reports/r2/send-back": () => { state.ready = []; return { status: 201, body: { ...done, status: "draft" } }; },
    });
  }

  it("opens a read-only preview with the flags; Hand over marks it handed over", async () => {
    const w = world(["lab.reports.print", "lab.results.enter"]);
    await mount(w.fetcher, <QuickReports />);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    expect(await screen.findByTestId("qr-line-a-tc")).toHaveTextContent(/250 H/);
    expect(screen.getByTestId("qr-line-a-hdl")).toHaveTextContent(/40 – 60/);
    expect(screen.getByTestId("qr-preview")).toHaveTextContent(/Total cholesterol is high/);
    expect(screen.queryByTestId("qb-input-a-tc")).toBeNull();
    await fireEvent.press(screen.getByTestId("qr-handover"));
    expect(await screen.findByTestId("qr-done")).toHaveTextContent(/Sita Devi/);
    expect(w.of("POST /lab/quick/reports/r2/hand-over")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("qr-row-r2")).toBeNull());
  });

  it("Send back to bench posts send-back", async () => {
    const w = world(["lab.reports.print", "lab.results.enter"]);
    await mount(w.fetcher, <QuickReports />);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await fireEvent.press(await screen.findByTestId("qr-sendback"));
    expect(await screen.findByTestId("qr-done")).toHaveTextContent(/Sita Devi/);
    expect(w.of("POST /lab/quick/reports/r2/send-back")).toHaveLength(1);
    expect(w.of("POST /lab/quick/reports/r2/hand-over")).toHaveLength(0);
  });

  it("without the results grant there is no Send back", async () => {
    const w = world(["lab.reports.print"]);
    await mount(w.fetcher, <QuickReports />);
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    await screen.findByTestId("qr-handover");
    expect(screen.queryByTestId("qr-sendback")).toBeNull();
  });

  it("speaks Hindi", async () => {
    const w = world(["lab.reports.print"]);
    await mount(w.fetcher, <QuickReports />, "hi");
    await fireEvent.press(await screen.findByTestId("qr-row-r2"));
    expect(await screen.findByTestId("qr-handover")).not.toHaveTextContent(/Hand over/);
  });
});
