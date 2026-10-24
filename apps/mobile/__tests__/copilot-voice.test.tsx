import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { CopilotScreen } from "../src/screens/copilot";
import { ASK_SECONDS, VOICE_WORDS } from "../src/copilot/voice";
import { SessionProvider, useSession } from "../src/session";

/**
 * #590 (plan E1.7) — SPEAKING A QUESTION, AS IT WILL BE ONCE RULING R-2 IS GIVEN. `VOICE_ASK` is forced on
 * here (the build has it off: ask-widget-link.test.tsx). Done means: the transcript shows in the box for
 * editing, and nothing is asked until the person taps Ask. The recorder is faked; the server is faked.
 */
jest.mock("../src/copilot/voice", () => ({ ...jest.requireActual<object>("../src/copilot/voice"), VOICE_ASK: true }));
const mockRecorder = { allow: jest.fn(async () => true), start: jest.fn(async () => undefined), take: jest.fn(), discard: jest.fn(async () => undefined) };
jest.mock("../src/consult/recorder", () => ({ useVoiceRecorder: () => mockRecorder }));
jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

type Route = { status: number; body?: unknown };
function server(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    calls.push({ key, body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined });
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-asha" }, permissions: { hospital: ["opd.queue.read"], scoped: { department: {}, floor: {} } } }), { status: 200 });
    const r = routes[key] ?? (key === "GET /copilot/notice" ? { status: 200, body: { seen: true } } : undefined);
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls, asked: () => calls.filter((c) => c.key === "POST /copilot/ask") };
}
function Gate({ listen }: { listen: boolean }) { const { state } = useSession(); return state.status !== "signedIn" ? null : <CopilotScreen listen={listen} />; }
const mount = async (fetcher: typeof fetch, listen = false) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate listen={listen} /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);
const CLIP = { audio: "AAAA", mimeType: "audio/mp4", seconds: 3 };
const QUEUE = { answer: { key: "copilot.answer.queueShortest", params: { doctor: "Dr Rao", waiting: 4, minutes: 20 } }, source: "phrasebook", intent: "queue_depth", askId: "a1" };

beforeEach(() => {
  for (const f of Object.values(mockRecorder)) f.mockClear();
  mockRecorder.allow.mockImplementation(async () => true);
  mockRecorder.take.mockImplementation(async () => CLIP);
});

describe("with R-2: speak, read and edit, then Ask", () => {
  it("the transcript lands in the box for editing; nothing is asked until Ask is tapped", async () => {
    const s = server({ "POST /speech/transcribe": { status: 200, body: { text: "  which doctor has the shortest queue  ", auditId: "v1" } }, "POST /copilot/ask": { status: 200, body: QUEUE } });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-voice-start"));
    expect(mockRecorder.allow).toHaveBeenCalledTimes(1);
    expect(mockRecorder.start).toHaveBeenCalledTimes(1);
    await fireEvent.press(await screen.findByTestId("copilot-voice-stop"));

    await waitFor(() => expect(screen.getByTestId("copilot-input").props.value).toBe("which doctor has the shortest queue"));
    expect(s.calls.filter((c) => c.key === "POST /speech/transcribe").map((c) => c.body)).toEqual([{ audio: "AAAA", language: "en" }]);
    expect(screen.getByTestId("copilot-voice-note")).toHaveTextContent(VOICE_WORDS.en.check);
    expect(s.asked()).toEqual([]);

    await fireEvent.changeText(screen.getByTestId("copilot-input"), "which doctor has the shortest queue today");
    expect(s.asked()).toEqual([]);
    await fireEvent.press(screen.getByTestId("copilot-ask"));
    await screen.findByTestId("copilot-answer-1");
    expect(s.asked().map((c) => c.body)).toEqual([{ question: "which doctor has the shortest queue today", screen: "phone", source: "typed" }]);
  });

  it("from the widget's mic it listens at once, without a tap", async () => {
    const s = server({});
    await mount(s.fetcher, true);
    await screen.findByTestId("copilot-voice-stop");
    expect(mockRecorder.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("copilot-input").props.autoFocus).toBe(false);
  });

  it("what was heard follows a question already half typed", async () => {
    const s = server({ "POST /speech/transcribe": { status: 200, body: { text: "for Dr Rao", auditId: "v1" } } });
    await mount(s.fetcher);
    await fireEvent.changeText(await screen.findByTestId("copilot-input"), "queue ");
    await fireEvent.press(screen.getByTestId("copilot-voice-start"));
    await fireEvent.press(await screen.findByTestId("copilot-voice-stop"));
    await waitFor(() => expect(screen.getByTestId("copilot-input").props.value).toBe("queue for Dr Rao"));
    expect(s.asked()).toEqual([]);
  });

  it("nothing heard: says so, sends nothing, leaves the box alone", async () => {
    mockRecorder.take.mockImplementation(async () => null);
    const s = server({});
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-voice-start"));
    await fireEvent.press(await screen.findByTestId("copilot-voice-stop"));
    expect(await screen.findByTestId("copilot-voice-note")).toHaveTextContent(VOICE_WORDS.en.nothingHeard);
    expect(s.calls.filter((c) => c.key === "POST /speech/transcribe")).toEqual([]);
    expect(screen.getByTestId("copilot-input").props.value).toBe("");
  });

  it("the server's speech service is off (503): says speaking is not available; the box stays empty", async () => {
    const s = server({ "POST /speech/transcribe": { status: 503, body: { message: "speech_not_configured" } } });
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-voice-start"));
    await fireEvent.press(await screen.findByTestId("copilot-voice-stop"));
    expect(await screen.findByTestId("copilot-voice-note")).toHaveTextContent(VOICE_WORDS.en.unavailable);
    expect(screen.getByTestId("copilot-input").props.value).toBe("");
    expect(s.asked()).toEqual([]);
  });

  it("the phone refuses the microphone: says where to allow it, records nothing", async () => {
    mockRecorder.allow.mockImplementation(async () => false);
    const s = server({});
    await mount(s.fetcher);
    await fireEvent.press(await screen.findByTestId("copilot-voice-start"));
    expect(await screen.findByTestId("copilot-voice-note")).toHaveTextContent(VOICE_WORDS.en.micRefused);
    expect(mockRecorder.start).not.toHaveBeenCalled();
  });

  it(`stops by itself at ${String(ASK_SECONDS)} seconds — the push-to-talk limit the server leaves to the phone`, async () => {
    jest.useFakeTimers();
    try {
      const s = server({ "POST /speech/transcribe": { status: 200, body: { text: "dues today", auditId: "v1" } } });
      await mount(s.fetcher);
      await fireEvent.press(await screen.findByTestId("copilot-voice-start"));
      await screen.findByTestId("copilot-voice-stop");
      expect(mockRecorder.take).not.toHaveBeenCalled();
      await act(async () => { jest.advanceTimersByTime(ASK_SECONDS * 1000 + 300); });
      expect(mockRecorder.take).toHaveBeenCalledTimes(1);
      expect(mockRecorder.take.mock.calls[0]?.[0]).toBeLessThanOrEqual(ASK_SECONDS);
    } finally {
      jest.useRealTimers();
    }
  });

  it("the copilot's own words, in English and Hindi, carry the same keys and none is empty", () => {
    expect(Object.keys(VOICE_WORDS.hi).sort()).toEqual(Object.keys(VOICE_WORDS.en).sort());
    for (const lang of ["en", "hi"] as const) for (const v of Object.values(VOICE_WORDS[lang])) expect(v.trim()).not.toBe("");
  });
});
