import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import webEn from "../../web/src/locales/en.json";
import webHi from "../../web/src/locales/hi.json";
import { I18nProvider, translate } from "../src/i18n";
import { CHIPS, SEAT_CHIPS, answerText, chipsFor, sayParams } from "../src/copilot/model";
import { CopilotScreen } from "../src/screens/copilot";
import { SessionProvider, useSession } from "../src/session";
import { Band } from "../src/ui";
import CopilotPage from "../app/copilot";
import type { EffectivePermissions } from "../src/seats";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
const mockPush = jest.fn();
jest.mock("expo-router", () => {
  const { createElement } = jest.requireActual<typeof import("react")>("react");
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    useRouter: () => ({ push: mockPush, back: jest.fn() }),
    Redirect: ({ href }: { href: string }) => createElement(Text, { testID: "redirect" }, href),
  };
});

/**
 * E1.3 — THE COPILOT ON THE PHONE (decision 0064; spec /opt/hmis-context/SPEC-copilot-phone-2026-10-11.md).
 * The screen talks to a faked server. Nothing is read from the clock.
 */
type Route = { status: number; body?: unknown };
const PERMS = (hospital: string[]): EffectivePermissions => ({ hospital, scoped: { department: {}, floor: {} } });

function server(routes: Record<string, Route | ((body: unknown) => Route)>, opts: { hospital?: string[]; signedOut?: boolean } = {}) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ key, body });
    if (key === "GET /auth/me") {
      if (opts.signedOut === true) return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-asha" }, permissions: PERMS(opts.hospital ?? ["opd.vitals.record", "opd.queue.read", "roster.read"]) }), { status: 200 });
    }
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(body) : hit;
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}
function Gate() { const { state } = useSession(); return state.status !== "signedIn" ? null : <CopilotScreen />; }
const mount = async (fetcher: typeof fetch, node: React.ReactNode = <Gate />) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}>{node}</SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);
const QUEUE = { answer: { key: "copilot.answer.queueShortest", params: { doctor: "Dr Rao", waiting: 4, minutes: 20 } }, source: "phrasebook", intent: "queue_depth" };

describe("E1.3 — every web answer says the same on the phone", () => {
  const webSays = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{\{(\w+)\}\}/g, (_m, v: string) => String(vars[v] ?? ""));
  it("carries every copilot.answer / when / notice key of the web, word for word, in English and Hindi", () => {
    expect(en.copilot.answer).toEqual(webEn.copilot.answer);
    expect(hi.copilot.answer).toEqual(webHi.copilot.answer);
    expect(en.copilot.when).toEqual(webEn.copilot.when);
    expect(hi.copilot.when).toEqual(webHi.copilot.when);
    expect(en.copilot.notice).toEqual(webEn.copilot.notice);
    expect(hi.copilot.notice).toEqual(webHi.copilot.notice);
  });

  it("each answer key renders the web's sentence with its params filled", () => {
    for (const [lang, web] of [["en", webEn], ["hi", webHi]] as const) {
      const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
      for (const [k, tpl] of Object.entries(web.copilot.answer)) {
        const vars = Object.fromEntries([...tpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => [m[1]!, `v-${m[1]!}`]));
        const said = answerText({ answer: { key: `copilot.answer.${k}`, params: vars }, source: "phrasebook", intent: null }, t, lang);
        expect([k, said]).toEqual([k, webSays(tpl, vars)]);
        expect(said).not.toContain("copilot.answer.");
      }
    }
  });

  it("says a roster day and instant as the web's sayParams does", () => {
    const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
    expect(sayParams("copilot.answer.rosterMyNext", { day: "2026-10-17", from: "20:00", till: "08:00", post: "SR", unit: "MU1" }, t, "en").day).toBe("Saturday 17 Oct");
    expect(sayParams("copilot.answer.rosterWhoIsOn", { when: "now", here: "" }, t, "en")).toEqual({ when: "right now", here: "nobody" });
    expect(sayParams("copilot.answer.rosterWhoIsOn", { when: "2026-10-17T16:30:00Z" }, t, "en").when).toBe("on Saturday 17 Oct at 22:00");
    expect(sayParams("copilot.answer.stockOnShelf", { expiry: "2028-01-31" }, t, "en")).toEqual({ expiry: "2028-01-31" });
  });

  it("every phone label is one short line with no sentence, with the same keys in Hindi", () => {
    const leaves = (o: unknown, p = ""): [string, string][] => (typeof o === "string" ? [[p, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`)));
    const enL = leaves(en.copilotPhone); const hiL = leaves(hi.copilotPhone);
    expect(hiL.map(([k]) => k)).toEqual(enL.map(([k]) => k));
    for (const [, s] of [...enL, ...hiL]) {
      expect([s, s.length <= 26]).toEqual([s, true]);
      expect([s, /[.।!]/.test(s)]).toEqual([s, false]);
    }
  });
});

describe("E1.3 — each seat's three chips", () => {
  it("every seat names three chips, and every chip has its label in both languages", () => {
    for (const list of Object.values(SEAT_CHIPS)) expect(list).toHaveLength(3);
    for (const c of Object.keys(CHIPS)) {
      expect(translate("en", `copilotPhone.chip.${c}`)).not.toContain("copilotPhone");
      expect(translate("hi", `copilotPhone.chip.${c}`)).not.toContain("copilotPhone");
    }
  });

  it("offers only chips the person may ask, seat by seat, at most three, with My day report to fill", () => {
    expect(chipsFor(PERMS(["opd.consult", "opd.queue.read", "roster.read"]))).toEqual(["queue", "myDuty", "myNight"]);
    expect(chipsFor(PERMS(["opd.visits.open", "opd.queue.read", "roster.read"]))).toEqual(["queue", "myDuty", "myDay"]);
    expect(chipsFor(PERMS(["roster.read"]))).toEqual(["myDuty", "myNight", "myDay"]);
    // A vitals nurse without the roster: the queue, then the day report — never a chip that would be refused.
    expect(chipsFor(PERMS(["opd.vitals.record", "opd.queue.read"]))).toEqual(["queue", "myDay"]);
    expect(chipsFor(PERMS(["opd.vitals.record"]))).toEqual(["myDay"]);
    expect(chipsFor(PERMS([]))).toEqual(["myDay"]);
    // Scoped grants count, as they do for seats.
    expect(chipsFor({ hospital: [], scoped: { department: { d1: ["opd.consult", "opd.queue.read"] }, floor: {} } })).toEqual(["queue", "myDay"]);
  });
});

describe("E1.3 — the screen", () => {
  beforeEach(() => { mockPush.mockReset(); });

  it("a chip asks with source=chip and screen=phone and no terms; typed asks with source=typed; the answer is the web's sentence", async () => {
    const s = server({ "GET /copilot/notice": { status: 200, body: { seen: true } }, "POST /copilot/ask": { status: 200, body: { ...QUEUE, askId: "a1" } } });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-chip-queue"));
    expect(await screen.findByTestId("copilot-answer-1")).toHaveTextContent("Shortest open line is Dr Rao — 4 waiting, about 20 minutes.");
    await fireEvent.changeText(screen.getByTestId("copilot-input"), "  kitni der lagegi  ");
    await fireEvent.press(screen.getByTestId("copilot-ask"));
    await screen.findByTestId("copilot-answer-2");
    const asks = s.calls.filter((c) => c.key === "POST /copilot/ask").map((c) => c.body);
    expect(asks).toEqual([
      { question: "Shortest line?", screen: "phone", source: "chip" },
      { question: "kitni der lagegi", screen: "phone", source: "typed" },
    ]);
    expect(screen.getByTestId("copilot-input").props.value).toBe("");
  });

  it("Wrong sends my ask's id once and says so; an answer without an id has no Wrong", async () => {
    let n = 0;
    const s = server({
      "GET /copilot/notice": { status: 200, body: { seen: true } },
      "POST /copilot/ask": () => { n += 1; return { status: 200, body: n === 1 ? { ...QUEUE, askId: "a1" } : QUEUE }; },
      "POST /copilot/feedback": { status: 204 },
    });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-chip-queue"));
    await fireEvent.press(await screen.findByTestId("copilot-wrong-1"));
    expect(await screen.findByTestId("copilot-wrong-done-1")).toHaveTextContent("Marked wrong");
    expect(s.calls.filter((c) => c.key === "POST /copilot/feedback").map((c) => c.body)).toEqual([{ askId: "a1", wrong: true }]);
    await fireEvent.press(screen.getByTestId("copilot-chip-queue"));
    await screen.findByTestId("copilot-answer-2");
    expect(screen.queryByTestId("copilot-wrong-2")).toBeNull();
  });

  it("I did not understand has no Wrong (it is already counted as not understood)", async () => {
    const s = server({
      "GET /copilot/notice": { status: 200, body: { seen: true } },
      "POST /copilot/ask": { status: 200, body: { answer: { key: "copilot.answer.notUnderstood", params: {} }, source: "none", intent: null, askId: "a3" } },
    });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-chip-queue"));
    expect(await screen.findByTestId("copilot-answer-1")).toHaveTextContent(webEn.copilot.answer.notUnderstood);
    expect(screen.queryByTestId("copilot-wrong-1")).toBeNull();
  });

  it("the day report is the web's sentence plus where the full report is", async () => {
    const s = server({
      "GET /copilot/notice": { status: 200, body: { seen: true } },
      "POST /copilot/ask": { status: 200, body: { answer: { key: "copilot.answer.dayReportProvisional", params: { date: "2026-10-17", sections: 2 }, payload: { sections: [] } }, source: "phrasebook", intent: "my_day_report", askId: "a9" } },
    });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-chip-myDuty"));
    expect(await screen.findByTestId("copilot-answer-1")).toHaveTextContent(webEn.copilot.answer.dayReportProvisional.replace("{{date}}", "2026-10-17").replace("{{sections}}", "2"));
    expect(screen.getByTestId("copilot-report-1")).toHaveTextContent("Full report on computer");
  });

  it("no signal says so, in a few words", async () => {
    const s = server({ "GET /copilot/notice": { status: 200, body: { seen: true } } });
    (s.fetcher as unknown as jest.Mock).mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ actor: { type: "user", id: "u" }, permissions: PERMS(["opd.queue.read", "opd.vitals.record"]) }), { status: 200 });
      if (init?.method === "POST") throw new TypeError("Network request failed");
      return new Response(JSON.stringify({ seen: true }), { status: 200 });
    });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-chip-queue"));
    expect(await screen.findByTestId("copilot-answer-1")).toHaveTextContent("No signal");
  });
});

describe("E1.3 — the staff notice (decision 0065)", () => {
  it("shows before the first ask when the server says unseen; OK records it on the server and it goes", async () => {
    const s = server({ "GET /copilot/notice": { status: 200, body: { seen: false } }, "POST /copilot/notice": { status: 204 } });
    await mount(s.fetcher);
    expect(await screen.findByTestId("copilot-notice-text")).toHaveTextContent(webEn.copilot.notice.text);
    await fireEvent.press(screen.getByTestId("copilot-notice-ok"));
    await waitFor(() => expect(screen.queryByTestId("copilot-notice")).toBeNull());
    expect(s.calls.map((c) => c.key)).toContain("POST /copilot/notice");
  });

  it("once dismissed (server says seen) it never shows", async () => {
    const s = server({ "GET /copilot/notice": { status: 200, body: { seen: true } } });
    await mount(s.fetcher);
    await screen.findByTestId("copilot-chip-queue");
    await waitFor(() => expect(s.calls.map((c) => c.key)).toContain("GET /copilot/notice"));
    expect(screen.queryByTestId("copilot-notice")).toBeNull();
  });
});

describe("E1.3 — the keyboard, the header and signing in", () => {
  it("the input row sits inside the screen's KeyboardScrollView (the vc24 rule)", async () => {
    const s = server({ "GET /copilot/notice": { status: 200, body: { seen: true } } });
    await mount(s.fetcher);
    const input = await screen.findByTestId("copilot-input");
    let node: typeof input | null = input;
    let scroll: typeof input | null = null;
    while (node !== null) { if (node.props.testID === "copilot") { scroll = node; break; } node = node.parent; }
    expect(scroll?.props.testID).toBe("copilot");
    expect(String(scroll?.type)).toMatch(/ScrollView/);
    const src = readFileSync(join(__dirname, "..", "src", "screens", "copilot.tsx"), "utf8");
    const open = src.indexOf("<KeyboardScrollView"); const row = src.indexOf("copilot-input-row"); const close = src.indexOf("</KeyboardScrollView>");
    expect(open).toBeGreaterThan(0);
    expect(open < row && row < close).toBe(true);
  });

  it("the header offers the copilot beside the scan mark when signed in, and not on the copilot screen itself", async () => {
    const s = server({ "GET /copilot/notice": { status: 200, body: { seen: true } } });
    function Head() { const { state } = useSession(); return state.status !== "signedIn" ? null : <Band />; }
    await mount(s.fetcher, <Head />);
    await fireEvent.press(await screen.findByTestId("band-copilot"));
    expect(mockPush).toHaveBeenCalledWith("/copilot");
    await screen.unmount();
    await mount(s.fetcher);
    await screen.findByTestId("copilot-chips");
    expect(screen.queryByTestId("band-copilot")).toBeNull();
    expect(screen.getByTestId("band-scan")).toBeTruthy();
  });

  it("signed out, /copilot sends the person to sign in", async () => {
    const s = server({}, { signedOut: true });
    await mount(s.fetcher, <CopilotPage />);
    expect(await screen.findByTestId("redirect")).toHaveTextContent("/");
  });
});
