import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";
import { I18nProvider, translate } from "../src/i18n";
import { ReminderCard } from "../src/reminders/card";
import { dayChoices, formInstant, readTime, whenText } from "../src/reminders/model";
import { RemindersScreen } from "../src/screens/reminders";
import { PUSH_LINK_ROUTE } from "../src/notifications";
import { SessionProvider, useSession } from "../src/session";
import type { ReminderRow } from "../src/reminders/model";

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
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

/**
 * E1.2 — PERSONAL REMINDERS on the phone (decision 0064; spec /opt/hmis-context/SPEC-reminders-2026-10-11.md).
 * The screen talks to a faked server; every "now" is passed in, so no date here is read from the clock.
 */
const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
// Saturday 17 October 2026, 10:00 IST.
const NOW = Date.parse("2026-10-17T10:00:00.000+05:30");
const ROW = (over: Partial<ReminderRow> = {}): ReminderRow => ({ id: "r1", text: "see bed 12", dueAt: "2026-10-17T16:00:00.000+05:30", repeat: "none", createdAt: "2026-10-17T04:00:00.000Z", ...over });

type Route = { status: number; body?: unknown };
function server(routes: Record<string, Route | ((body: unknown) => Route)>) {
  const calls: { key: string; body: unknown }[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ key, body });
    if (key === "GET /auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u-asha" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200 });
    const hit = routes[key];
    const r = typeof hit === "function" ? hit(body) : hit;
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}
function Gate() { const { state } = useSession(); return state.status !== "signedIn" ? null : <RemindersScreen nowMs={() => NOW} />; }
const mount = async (fetcher: typeof fetch) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);

describe("E1.2 reminders — what a typed time means", () => {
  it("reads a time the way people type it, and refuses what is not one", () => {
    expect(readTime("16:00")).toBe("16:00");
    expect(readTime("9")).toBe("09:00");
    expect(readTime("9.30")).toBe("09:30");
    expect(readTime("0930")).toBe("09:30");
    expect(readTime("24:00")).toBeNull();
    expect(readTime("4 pm")).toBeNull();
  });

  it("the form's instant is IST; no words, no time and a time already gone are each refused", () => {
    expect(formInstant("see bed 12", "2026-10-17", "16:00", NOW)).toEqual({ at: "2026-10-17T10:30:00.000Z" });
    expect(formInstant("  ", "2026-10-17", "16:00", NOW)).toEqual({ problem: "text" });
    expect(formInstant("x", "2026-10-17", "", NOW)).toEqual({ problem: "time" });
    expect(formInstant("x", "2026-10-17", "09:00", NOW)).toEqual({ problem: "past" });
  });

  it("offers today and the six days after it, and says a next time in a few words", () => {
    const days = dayChoices(NOW);
    expect(days.map((d) => d.day)).toEqual(["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
    expect(days[2]!.weekday).toBe(1);
    expect(whenText(t, "2026-10-17T16:00:00.000+05:30", NOW)).toBe("Today 16:00");
    expect(whenText(t, "2026-10-18T09:00:00.000+05:30", NOW)).toBe("Tomorrow 09:00");
    expect(whenText(t, "2026-10-19T09:00:00.000+05:30", NOW)).toBe("Mon 19 · 09:00");
    // Late evening UTC is already the next IST day.
    expect(whenText(t, "2026-10-17T20:00:00.000Z", NOW)).toBe("Tomorrow 01:30");
  });

  it("every reminders label is one short line with no sentence, in English and Hindi, with the same keys", () => {
    const leaves = (o: unknown, p = ""): [string, string][] => (typeof o === "string" ? [[p, o]] : Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${p}.${k}`)));
    const enL = leaves(en.reminders); const hiL = leaves(hi.reminders);
    expect(hiL.map(([k]) => k)).toEqual(enL.map(([k]) => k));
    for (const [, s] of [...enL, ...hiL]) {
      const shown = s.replace(/\{\{(\w+)\}\}/g, (_m, v: string) => ({ time: "09:00", day: "Wed", date: "19", when: "Mon 19 · 09:00" } as Record<string, string>)[v] ?? v);
      expect([shown, shown.length <= 34]).toEqual([shown, true]);
      expect([shown, /[.।!?]/.test(s)]).toEqual([shown, false]);
    }
    expect(en.mobile.push.category.personal).toBe("My reminders");
  });
});

describe("E1.2 reminders — the home line", () => {
  it("reads the next reminder in one line, or offers to add one", async () => {
    const onOpen = jest.fn();
    await render(<ReminderCard t={t} items={[ROW(), ROW({ id: "r2", dueAt: "2026-10-18T09:00:00.000+05:30" })]} onOpen={onOpen} nowMs={NOW} />);
    expect(screen.getByTestId("reminders-card-next")).toHaveTextContent("Today 16:00 · see bed 12");
    expect(screen.getByTestId("reminders-card-more")).toHaveTextContent("+1");
    await fireEvent.press(screen.getByTestId("reminders-card"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await screen.unmount();
    await render(<ReminderCard t={t} items={[]} onOpen={jest.fn()} nowMs={NOW} />);
    expect(screen.getByTestId("reminders-card-add")).toHaveTextContent("+ Reminder");
    await screen.unmount();
    await render(<ReminderCard t={t} items={null} onOpen={jest.fn()} nowMs={NOW} />);
    expect(screen.getByTestId("reminders-card-add")).toBeTruthy(); // an older server or no signal: still a way in
  });

  it("a tapped reminder notification opens the Reminders screen", () => {
    expect(PUSH_LINK_ROUTE.reminders).toBe("reminders");
  });
});

describe("E1.2 reminders — the screen", () => {
  beforeEach(() => { mockPush.mockReset(); });

  it("lists my reminders with when and how often, and Cancel cancels that one", async () => {
    let items = [ROW(), ROW({ id: "r2", text: "OPD review", dueAt: "2026-10-19T09:00:00.000+05:30", repeat: "mon_sat" })];
    const s = server({
      "GET /reminders": () => ({ status: 200, body: { items } }),
      "POST /reminders/r2/cancel": () => { items = items.filter((r) => r.id !== "r2"); return { status: 200, body: { id: "r2", cancelled: true } }; },
    });
    await mount(s.fetcher);
    expect(await screen.findByTestId("reminder-r2-when")).toHaveTextContent("Mon 19 · 09:00 · Mon–Sat");
    expect(screen.getByTestId("reminder-r1-when")).toHaveTextContent("Today 16:00");
    await fireEvent.press(screen.getByTestId("reminder-r2-cancel"));
    await waitFor(() => expect(screen.queryByTestId("reminder-r2")).toBeNull());
    expect(s.calls.map((c) => c.key)).toContain("POST /reminders/r2/cancel");
  });

  it("saves the words, the IST instant of the chosen day and time, and the repeat", async () => {
    let items: ReminderRow[] = [];
    const s = server({
      "GET /reminders": () => ({ status: 200, body: { items } }),
      "POST /reminders": (b) => { const r = ROW({ id: "r9", text: "ward round", dueAt: (b as { at: string }).at, repeat: "weekly" }); items = [r]; return { status: 201, body: r }; },
    });
    await mount(s.fetcher);
    expect(await screen.findByTestId("reminders-none")).toHaveTextContent("No reminders");
    await fireEvent.changeText(screen.getByTestId("reminder-text"), "  ward round ");
    await fireEvent.press(screen.getByTestId("reminder-day-2")); // Monday 19
    await fireEvent.changeText(screen.getByTestId("reminder-time"), "9");
    await fireEvent.press(screen.getByTestId("reminder-repeat-weekly"));
    await fireEvent.press(screen.getByTestId("reminder-save"));
    expect(await screen.findByTestId("reminder-saved")).toHaveTextContent("Set for Mon 19 · 09:00");
    expect(s.calls.find((c) => c.key === "POST /reminders")?.body).toEqual({ text: "ward round", at: "2026-10-19T03:30:00.000Z", repeat: "weekly" });
    expect(await screen.findByTestId("reminder-r9")).toBeTruthy();
  });

  it("says why it did not save: a past time before asking, the server's limit after", async () => {
    const s = server({ "GET /reminders": { status: 200, body: { items: [] } }, "POST /reminders": { status: 409, body: { message: "reminder_limit" } } });
    await mount(s.fetcher);
    await screen.findByTestId("reminders-none");
    await fireEvent.changeText(screen.getByTestId("reminder-text"), "x");
    await fireEvent.changeText(screen.getByTestId("reminder-time"), "08:00");
    await fireEvent.press(screen.getByTestId("reminder-save"));
    expect(await screen.findByTestId("reminder-problem")).toHaveTextContent("That time has gone");
    expect(s.calls.map((c) => c.key)).not.toContain("POST /reminders");
    await fireEvent.changeText(screen.getByTestId("reminder-time"), "18:00");
    await fireEvent.press(screen.getByTestId("reminder-save"));
    expect(await screen.findByTestId("reminder-problem")).toHaveTextContent("20 reminders is the most");
  });
});
