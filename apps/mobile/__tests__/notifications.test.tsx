import { readFileSync } from "fs";
import { join } from "path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "../src/i18n";
import { NotificationsProvider, PUSH_CATEGORIES, PUSH_LINK_CARD, PUSH_LINK_SEAT, SERVER_TIMEOUT_MS, _forgetOfferForTests, statusOf } from "../src/notifications";
import { noteOf, permissionOf, type PushNote, type PushPermission, type PushPhone } from "../src/push-phone";
import { AccountScreen } from "../src/screens/account";
import { NotificationsScreen } from "../src/screens/notifications";
import { SeatHome } from "../src/screens/seat-home";
import { SessionProvider, useSession } from "../src/session";
import en from "../src/locales/en.json";
import hi from "../src/locales/hi.json";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "asha.devi", since: "2026-10-06T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
    __delete: (k: string) => { store.delete(k); },
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush, back: jest.fn() }) }));

/**
 * M6b — NOTIFICATIONS ON THIS PHONE. The phone's side of it, against a phone that is a fake and a
 * server that is a function: what is asked and when, what the server is told, and what each state
 * is called on screen.
 */
const ME = (perms: string[]) => ({ actor: { type: "user", id: "u1" }, permissions: { hospital: perms, scoped: { department: {}, floor: {} } } });
const ADDRESS = "fGx1:APA91b-this-phones-fcm-address-0123456789";

type Server = { configured: boolean; registered: boolean; muted: string[]; categories: string[] };
type Opts = {
  failWrites?: boolean;
  /** What `GET /auth/phone/notifications` does instead of answering: a status, "network" (no signal) or "hang" (never answers). */
  read?: number | "network" | "hang" | null;
  /** The session names no phone until `POST /auth/phone/link` succeeds. `link` is that route's status. */
  unlinked?: boolean; link?: number;
};
function server(start: Partial<Server> = {}, perms: string[] = ["roster.read"], opts: Opts = {}) {
  const state: Server = { configured: true, registered: false, muted: [], categories: ["alert", "roster"], ...start };
  const calls: { key: string; body: unknown }[] = [];
  const o = { ...opts };
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "").split("?")[0] ?? ""}`;
    if (url.includes("/auth/phone/notifications")) knows.push(url.split("?knows=")[1] ?? "");
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ key, body });
    if (key === "GET /auth/me") return new Response(JSON.stringify(ME(perms)), { status: 200 });
    if (key === "POST /auth/phone/link") {
      if ((o.link ?? 200) !== 200) return new Response(JSON.stringify({ code: o.link === 409 ? "phone_limit_reached" : "x" }), { status: o.link });
      o.unlinked = false;
      return new Response(JSON.stringify({ linked: true }), { status: 200 });
    }
    if (key === "GET /auth/phone/notifications") {
      if (o.unlinked === true) return new Response(JSON.stringify({ code: "not_a_phone" }), { status: 409 });
      if (o.read === "network") throw new TypeError("Network request failed");
      if (o.read === "hang") return new Promise<Response>(() => undefined);
      if (typeof o.read === "number") return new Response(JSON.stringify({ message: "x" }), { status: o.read });
      return new Response(JSON.stringify(state), { status: 200 });
    }
    if (key === "PUT /auth/phone/notifications") {
      if (opts.failWrites === true) throw new TypeError("Network request failed");
      const b = body as { token?: string; muted?: string[] };
      if (b.token !== undefined) state.registered = true;
      if (b.muted !== undefined) state.muted = b.muted;
      return new Response(JSON.stringify(state), { status: 200 });
    }
    if (key === "DELETE /auth/phone/notifications") { state.registered = false; return new Response(JSON.stringify(state), { status: 200 }); }
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  });
  return { fetcher: f as unknown as typeof fetch, calls, state, keys: () => calls.map((c) => c.key), opts: o };
}

function phone(start: { inBuild?: boolean; permission?: PushPermission; answer?: PushPermission; token?: string | null; openedWith?: string | null } = {}) {
  let permission = start.permission ?? "undetermined";
  const heard: { received?: (n: PushNote) => void; opened?: (l: string) => void; token?: (t: string) => void } = {};
  const order: string[] = [];
  const asked = jest.fn(async () => { order.push("ask"); permission = start.answer ?? "granted"; return permission; });
  const channels = jest.fn(async (_labels: Record<string, string>) => { order.push("channels"); });
  const p: PushPhone = {
    inBuild: start.inBuild ?? true,
    permission: async () => permission,
    ask: asked,
    token: async () => (start.token === undefined ? ADDRESS : start.token),
    channels,
    onToken: (cb) => { heard.token = cb; return () => undefined; },
    onReceived: (cb) => { heard.received = cb; return () => undefined; },
    onOpened: (cb) => { heard.opened = cb; return () => undefined; },
    openedWith: async () => start.openedWith ?? null,
  };
  return { p, asked, channels, heard, order, allowInSettings: () => { permission = "granted"; } };
}

function Gate({ what }: { what: "home" | "settings" | "account" }) {
  const { state } = useSession();
  if (state.status !== "signedIn") return null;
  return what === "home" ? <SeatHome /> : what === "settings" ? <NotificationsScreen /> : <AccountScreen />;
}
const CLAIM = { deviceId: "dddddddddddddddddddddddddddddddd", model: "Redmi Note 12", os: "Android 14", appVersion: "0.8.1 (9)" };
let comeToFront: () => void = () => undefined;
async function mount(fetcher: typeof fetch, p: PushPhone, what: "home" | "settings" | "account" = "settings", lang: "en" | "hi" = "en", claim: (() => Promise<typeof CLAIM | null>) = async () => CLAIM) {
  const foreground = (cb: () => void) => { comeToFront = cb; return () => undefined; };
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider initial={lang}><SessionProvider fetcher={fetcher}><NotificationsProvider phone={p} foreground={foreground} claim={claim}><Gate what={what} /></NotificationsProvider></SessionProvider></I18nProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockPush.mockClear();
  _forgetOfferForTests();
  for (const k of ["hmis.push.offer", "hmis.push.wanted", "hmis.push.received"]) (jest.requireMock("expo-secure-store") as { __delete: (k: string) => void }).__delete(k);
});

/** What the phone said it knows, on every read of its notification state (app home round 2: `?knows=`). */
const knows: string[] = [];

describe("notifications on this phone (M6b)", () => {
  it("names each state from four facts, and 'on' needs all of them", () => {
    const on = { configured: true, registered: true, muted: [], categories: [] };
    expect(statusOf(false, "ok", on, "granted")).toBe("notInBuild");
    expect(statusOf(true, "checking", null, "granted")).toBe("unknown");
    expect(statusOf(true, "unreachable", null, "granted")).toBe("unreachable");
    expect(statusOf(true, "error", null, "granted")).toBe("serverError");
    expect(statusOf(true, "notLinked", null, "granted")).toBe("notLinked");
    expect(statusOf(true, "ok", { ...on, configured: false }, "granted")).toBe("serverOff");
    expect(statusOf(true, "ok", on, "denied")).toBe("denied");
    expect(statusOf(true, "ok", { ...on, registered: false }, "granted")).toBe("off");
    expect(statusOf(true, "ok", on, "undetermined")).toBe("off");
    expect(statusOf(true, "ok", on, "granted")).toBe("on");
  });

  it("a build without the hospital's Firebase project asks the person nothing and the server nothing", async () => {
    const s = server();
    const ph = phone({ inBuild: false });
    await mount(s.fetcher, ph.p, "home");
    expect(await screen.findByTestId("signed-in-as")).toBeTruthy();
    expect(screen.queryByTestId("push-offer")).toBeNull();
    expect(s.keys()).not.toContain("GET /auth/phone/notifications");
    expect(ph.asked).not.toHaveBeenCalled();
  });

  it("the phone tells the server which categories it can draw, so 'Approvals' is offered only to a build that has the words", async () => {
    knows.length = 0;
    const s2 = server({ configured: true, registered: false, muted: [], categories: [...PUSH_CATEGORIES] });
    await mount(s2.fetcher, phone().p, "settings");
    await waitFor(() => expect(knows.length).toBeGreaterThan(0));
    expect(new Set(knows)).toEqual(new Set([PUSH_CATEGORIES.join(",")]));
    expect(PUSH_CATEGORIES).toContain("approvals");
  });

  it("a server with no Firebase key yet: said in words, nothing offered, nothing asked", async () => {
    const s = server({ configured: false });
    const ph = phone();
    await mount(s.fetcher, ph.p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Not set up at the hospital yet"));
    expect(screen.queryByTestId("push-enable")).toBeNull();
    expect(ph.asked).not.toHaveBeenCalled();
  });

  it("the home screen offers ONCE, says what a notification will not contain, and only then may the phone's prompt open", async () => {
    const s = server();
    const ph = phone();
    await mount(s.fetcher, ph.p, "home");
    const offer = await screen.findByTestId("push-offer");
    expect(offer).toHaveTextContent(/never shows a patient’s name, number or result/);
    expect(ph.asked).not.toHaveBeenCalled(); // the system prompt has NOT opened by itself
    await fireEvent.press(screen.getByTestId("push-offer-on"));
    await waitFor(() => expect(s.state.registered).toBe(true));
    expect(ph.asked).toHaveBeenCalledTimes(1);
    expect(s.calls.find((c) => c.key === "PUT /auth/phone/notifications")?.body).toEqual({ token: ADDRESS, language: "en" });
    // One Android channel per category, named in the person's language.
    expect(ph.channels).toHaveBeenCalledWith({ alert: "Alerts", roster: "Duty roster", queue: "Your queue", reminder: "Duty reminders", approvals: "Approvals" });
    await waitFor(() => expect(screen.queryByTestId("push-offer")).toBeNull());
  });

  it("'Not now' is remembered: the offer does not come back", async () => {
    const s = server();
    const ph = phone();
    const first = await mount(s.fetcher, ph.p, "home");
    await fireEvent.press(await screen.findByTestId("push-offer-later"));
    await waitFor(() => expect(screen.queryByTestId("push-offer")).toBeNull());
    expect(ph.asked).not.toHaveBeenCalled();
    expect(s.keys()).not.toContain("PUT /auth/phone/notifications");
    first.unmount();
  });

  it("the person refuses the phone's prompt: nothing is sent, it says so, and the way back is the phone's settings", async () => {
    const s = server();
    const ph = phone({ answer: "denied" });
    await mount(s.fetcher, ph.p, "settings");
    await fireEvent.press(await screen.findByTestId("push-enable"));
    expect(await screen.findByTestId("push-problem")).toHaveTextContent("The phone did not allow notifications. Nothing was changed.");
    expect(s.keys()).not.toContain("PUT /auth/phone/notifications");
    expect(screen.getByTestId("push-status")).toHaveTextContent("Blocked in this phone’s settings");
    expect(screen.getByTestId("push-settings")).toBeTruthy();
  });

  it("Firebase gives no address, or the server is not reached: nothing is claimed to be on", async () => {
    const s = server();
    await mount(s.fetcher, phone({ permission: "granted", token: null }).p, "settings");
    await fireEvent.press(await screen.findByTestId("push-enable"));
    expect(await screen.findByTestId("push-problem")).toHaveTextContent(/Google did not give this phone a notification address/);
    expect(screen.getByTestId("push-status")).toHaveTextContent("Off on this phone");
  });

  it("an unreached server on 'Turn on' leaves it off and says nothing was changed", async () => {
    const s = server({}, ["roster.read"], { failWrites: true });
    await mount(s.fetcher, phone().p, "settings");
    await fireEvent.press(await screen.findByTestId("push-enable"));
    expect(await screen.findByTestId("push-problem")).toHaveTextContent("That did not reach the server. Nothing was changed — try again.");
    expect(screen.getByTestId("push-status")).toHaveTextContent("Off on this phone");
  });

  it("already on: opening the app refreshes the address quietly, each kind has its own switch, and 'Turn off' tells the server", async () => {
    const s = server({ registered: true });
    const ph = phone({ permission: "granted" });
    await mount(s.fetcher, ph.p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent(/^On$/));
    expect(s.calls.filter((c) => c.key === "PUT /auth/phone/notifications")[0]?.body).toEqual({ token: ADDRESS, language: "en" });
    expect(ph.asked).not.toHaveBeenCalled();
    // The switches are the server's list of what is raised today, and nothing the server did not name.
    expect(screen.getByTestId("push-category-alert")).toBeTruthy();
    expect(screen.getByTestId("push-category-roster")).toBeTruthy();
    expect(screen.queryByTestId("push-category-queue")).toBeNull();
    expect(screen.queryByTestId("push-category-reminder")).toBeNull();
    await fireEvent(screen.getByTestId("push-category-roster"), "valueChange", false);
    await waitFor(() => expect(s.state.muted).toEqual(["roster"]));
    await fireEvent(screen.getByTestId("push-category-roster"), "valueChange", true);
    await waitFor(() => expect(s.state.muted).toEqual([]));
    expect(screen.getByTestId("push-quiet")).toHaveTextContent(/Do Not Disturb is respected/);
    await fireEvent.press(screen.getByTestId("push-disable"));
    await waitFor(() => expect(s.keys()).toContain("DELETE /auth/phone/notifications"));
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Off on this phone"));
  });

  /** §3i (owner 2026-10-07) — the server now raises four kinds; a reminder is its own switch, so silencing it silences nothing else. */
  it("a duty reminder and the doctor's queue each have a switch with words — and switching reminders off leaves the roster on", async () => {
    const s = server({ registered: true, categories: ["alert", "roster", "queue", "reminder"] });
    await mount(s.fetcher, phone({ permission: "granted" }).p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent(/^On$/));
    expect(screen.getByTestId("push-categories")).toBeTruthy();
    expect(screen.getByText("Duty reminders")).toBeTruthy();
    expect(screen.getByText(/^A duty of yours starts in an hour/)).toBeTruthy();
    expect(screen.getByText("Your queue")).toBeTruthy();
    expect(screen.getByText(/^Patients are ready and you are not in/)).toBeTruthy();
    expect(screen.queryByText(/mobile\.push/)).toBeNull();
    await fireEvent(screen.getByTestId("push-category-reminder"), "valueChange", false);
    await waitFor(() => expect(s.state.muted).toEqual(["reminder"]));
    expect(screen.getByTestId("push-category-roster").props.value).toBe(true);
    expect(screen.getByTestId("push-category-queue").props.value).toBe(true);
  });

  it("a reminder that arrives while the app is open is named a reminder and opens My duties", async () => {
    const ph = phone({ permission: "granted" });
    await mount(server({ registered: true }).fetcher, ph.p, "home");
    await waitFor(() => expect(ph.heard.received).toBeDefined());
    await waitFor(() => ph.heard.received?.({ category: "reminder", link: "myDuties", title: "HMIS", body: "You have a duty coming up. Open HMIS to see it." }));
    expect(await screen.findByTestId("push-banner-kind")).toHaveTextContent("Duty reminders");
    await fireEvent.press(screen.getByTestId("push-banner"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "myDuties" } });
  });

  it("the account screen says where notifications stand and whether screenshots are blocked in this build", async () => {
    const s = server({ registered: true });
    await mount(s.fetcher, phone({ permission: "granted" }).p, "account");
    await waitFor(() => expect(screen.getByTestId("account-notifications-status")).toHaveTextContent(/^On$/));
    // jest runs the staging configuration: screenshots are allowed there, and it says so.
    expect(screen.getByTestId("account-screenshots")).toHaveTextContent("Allowed in this staging build (test data only)");
    await fireEvent.press(screen.getByTestId("account-notifications"));
    expect(mockPush).toHaveBeenCalledWith("/notifications");
  });

  it("a notification while the app is open is a banner in the app; tapping it opens that screen", async () => {
    const s = server({ registered: true });
    const ph = phone({ permission: "granted" });
    await mount(s.fetcher, ph.p, "home");
    await waitFor(() => expect(ph.heard.received).toBeDefined());
    await waitFor(() => ph.heard.received?.({ category: "roster", link: "onNow", title: "HMIS", body: "The duty board needs you. Open HMIS to see it." }));
    expect(await screen.findByTestId("push-banner-kind")).toHaveTextContent("Duty roster");
    expect(screen.getByTestId("push-banner-body")).toHaveTextContent("The duty board needs you. Open HMIS to see it.");
    await fireEvent.press(screen.getByTestId("push-banner"));
    expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "onNow" } });
    await waitFor(() => expect(screen.queryByTestId("push-banner")).toBeNull());
  });

  it("a tap opens only a screen this person may open — anything else, or an unknown word, is home", async () => {
    const s = server({ registered: true }, ["opd.vitals.record"]); // no roster.read, no opd.consult
    const ph = phone({ permission: "granted" });
    await mount(s.fetcher, ph.p, "home");
    await waitFor(() => expect(ph.heard.opened).toBeDefined());
    ph.heard.opened?.("onNow");
    expect(mockPush).toHaveBeenLastCalledWith("/");
    ph.heard.opened?.("a-word-from-next-year");
    expect(mockPush).toHaveBeenLastCalledWith("/");
  });

  it("the tap that STARTED the app is honoured once", async () => {
    const s = server({ registered: true }, ["roster.read"]);
    await mount(s.fetcher, phone({ permission: "granted", openedWith: "myDuties" }).p, "home");
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith({ pathname: "/seat/[key]", params: { key: "myDuties" } }));
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it("Firebase rotates the address: the server is told the new one", async () => {
    const s = server({ registered: true });
    const ph = phone({ permission: "granted" });
    await mount(s.fetcher, ph.p, "settings");
    await waitFor(() => expect(ph.heard.token).toBeDefined());
    const before = s.calls.length;
    ph.heard.token?.("fGx2:APA91b-a-NEW-address-after-rotation-9876543210");
    await waitFor(() => expect(s.calls.slice(before).find((c) => c.key === "PUT /auth/phone/notifications")?.body).toEqual({ token: "fGx2:APA91b-a-NEW-address-after-rotation-9876543210", language: "en" }));
  });

  it("is said in Hindi, and the server is told the phone's language", async () => {
    const s = server();
    await mount(s.fetcher, phone().p, "settings", "hi");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("इस फ़ोन पर बंद"));
    await fireEvent.press(screen.getByTestId("push-enable"));
    await waitFor(() => expect(s.calls.find((c) => c.key === "PUT /auth/phone/notifications")?.body).toEqual({ token: ADDRESS, language: "hi" }));
  });
});

/**
 * THE OWNER'S PHONE, 2026-10-06 — two faults, both reproduced here before they were fixed.
 *  (1) "The notification screen says Checking…": an app updated in place kept a session that named
 *      no phone; the server answered `not_a_phone` and the screen waited for ever.
 *  (2) "I allowed it in the app settings, the app still says the same": Android 13+ reports
 *      `denied` before it has ever asked, so the app showed "blocked" without prompting, and it
 *      never looked at the permission again after the person came back from the settings.
 */
describe("never stuck, and never deaf to the phone's settings (owner's phone, 2026-10-06)", () => {
  it("Android 13+: 'denied, may ask again' is NOT a refusal — only 'may not ask again' is", () => {
    expect(permissionOf({ status: "denied", canAskAgain: true })).toBe("undetermined"); // a fresh install
    expect(permissionOf({ status: "denied", canAskAgain: false })).toBe("denied");
    expect(permissionOf({ status: "undetermined" })).toBe("undetermined");
    expect(permissionOf({ status: "granted" })).toBe("granted");
    expect(permissionOf({ status: "denied", granted: true })).toBe("granted");
  });

  it("'Turn on' makes the notification channels BEFORE it asks — Android 13 shows no prompt to an app with no channel", async () => {
    const s = server();
    const ph = phone();
    await mount(s.fetcher, ph.p, "settings");
    await fireEvent.press(await screen.findByTestId("push-enable"));
    await waitFor(() => expect(s.state.registered).toBe(true));
    expect(ph.order.indexOf("channels")).toBeGreaterThanOrEqual(0);
    expect(ph.order.indexOf("channels")).toBeLessThan(ph.order.indexOf("ask"));
  });

  it("blocked in settings → the person allows it there and comes back → the app registers by itself and says On", async () => {
    const s = server();
    const ph = phone({ permission: "denied" });
    await mount(s.fetcher, ph.p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Blocked in this phone’s settings"));
    const settings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    await fireEvent.press(screen.getByTestId("push-settings")); // goes to Android's settings…
    expect(settings).toHaveBeenCalled();
    settings.mockRestore();
    ph.allowInSettings();                                        // …allows HMIS there…
    await waitFor(() => { comeToFront(); expect(s.state.registered).toBe(true); }); // …and returns to the app
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent(/^On$/));
    expect(s.calls.find((c) => c.key === "PUT /auth/phone/notifications")?.body).toEqual({ token: ADDRESS, language: "en" });
    expect(screen.queryByTestId("push-problem")).toBeNull();
    expect(ph.asked).not.toHaveBeenCalled(); // no second prompt: the settings were the answer
  });

  it("'I have allowed it — check again' does the same by hand; while it is still blocked it says so and stays", async () => {
    const s = server();
    const ph = phone({ permission: "denied", answer: "denied" });
    await mount(s.fetcher, ph.p, "settings");
    await fireEvent.press(await screen.findByTestId("push-allowed"));
    expect(await screen.findByTestId("push-problem")).toHaveTextContent("The phone did not allow notifications. Nothing was changed.");
    expect(s.state.registered).toBe(false);
    ph.allowInSettings();
    await fireEvent.press(screen.getByTestId("push-allowed"));
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent(/^On$/));
    expect(s.state.registered).toBe(true);
  });

  it("coming back to the app does NOT switch notifications on for somebody who never asked for them", async () => {
    const s = server();
    const ph = phone({ permission: "granted" });
    await mount(s.fetcher, ph.p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Off on this phone"));
    comeToFront();
    await waitFor(() => expect(s.keys().filter((k) => k === "GET /auth/phone/notifications").length).toBeGreaterThanOrEqual(2));
    expect(s.keys()).not.toContain("PUT /auth/phone/notifications");
  });

  it("a session that names no phone is LINKED to this one and carries on — nobody is signed out", async () => {
    const s = server({}, ["roster.read"], { unlinked: true });
    await mount(s.fetcher, phone().p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Off on this phone"));
    expect(s.calls.find((c) => c.key === "POST /auth/phone/link")?.body).toEqual({ device: CLAIM });
    expect(screen.getByTestId("push-diag-linked")).toHaveTextContent("Yes");
    expect(screen.getByTestId("push-enable")).toBeTruthy();
  });

  it("when it cannot be linked it says what to do — and the third phone is told why", async () => {
    const s = server({}, ["roster.read"], { unlinked: true, link: 409 });
    await mount(s.fetcher, phone().p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("This phone is not linked to your sign-in"));
    expect(screen.getByTestId("push-status-why")).toHaveTextContent(/Log out and sign in again/);
    expect(screen.getByTestId("push-problem")).toHaveTextContent(/already signed in on two other phones/);
    expect(screen.getByTestId("push-diag-linked")).toHaveTextContent("No");
    expect(screen.queryByTestId("push-enable")).toBeNull();
  });

  it("no signal: it says so, and 'Check again' recovers", async () => {
    const s = server({}, ["roster.read"], { read: "network" });
    await mount(s.fetcher, phone().p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Could not reach the server"));
    expect(screen.getByTestId("push-diag-server")).toHaveTextContent("No — no answer");
    s.opts.read = null;
    await fireEvent.press(screen.getByTestId("push-retry"));
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Off on this phone"));
  });

  it("a server error is named as one — never left as 'Checking…'", async () => {
    for (const code of [404, 500]) {
      const s = server({}, ["roster.read"], { read: code });
      const view = await mount(s.fetcher, phone().p, "settings");
      await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("The server did not answer properly"));
      expect(screen.getByTestId("push-retry")).toBeTruthy();
      await view.unmount();
    }
  });

  it("a server that never answers is given twelve seconds, then the screen says it could not be reached", async () => {
    expect(SERVER_TIMEOUT_MS).toBe(12_000);
    jest.useFakeTimers();
    try {
      const s = server({}, ["roster.read"], { read: "hang" });
      await mount(s.fetcher, phone().p, "settings");
      await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Checking…"));
      await act(async () => { await jest.advanceTimersByTimeAsync(SERVER_TIMEOUT_MS + 50); });
      await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent("Could not reach the server"));
    } finally { jest.useRealTimers(); }
  });

  it("the diagnosis reads Yes all the way down when everything is right, and shows the last test", async () => {
    const s = server({ registered: true, lastTestAt: "2026-10-06T12:30:00.000Z", lastSentAt: "2026-10-06T12:30:00.000Z" } as Partial<Server>);
    await mount(s.fetcher, phone({ permission: "granted" }).p, "settings");
    await waitFor(() => expect(screen.getByTestId("push-status")).toHaveTextContent(/^On$/));
    for (const line of ["build", "server", "linked", "canSend", "permission", "address", "serverHasIt"]) {
      expect(screen.getByTestId(`push-diag-${line}`)).toHaveTextContent("Yes");
    }
    expect(screen.getByTestId("push-diag-lastTest")).toHaveTextContent("Tuesday 6 October, 18:00");
    expect(screen.getByTestId("push-diag-lastReceived")).toHaveTextContent("Never");
  });

  it("Google gives no address: the diagnosis names that link, not the server", async () => {
    const s = server();
    await mount(s.fetcher, phone({ permission: "granted", token: null }).p, "settings");
    await fireEvent.press(await screen.findByTestId("push-enable"));
    expect(await screen.findByTestId("push-problem")).toHaveTextContent(/Google did not give this phone a notification address/);
    expect(screen.getByTestId("push-diag-address")).toHaveTextContent("No — Google did not answer");
    expect(screen.getByTestId("push-diag-server")).toHaveTextContent("Yes");
  });
});

describe("the phone and the server use the same words (M6b)", () => {
  const core = readFileSync(join(__dirname, "../../core/src/kernel/push/phone-push.ts"), "utf8");
  const list = (name: string): string[] => JSON.parse((new RegExp(`export const ${name} = (\\[[^\\]]*\\]) as const;`).exec(core)?.[1] ?? "[]")) as string[];

  it("categories and links are the server's own lists, and every one has its words in both languages", () => {
    expect([...PUSH_CATEGORIES]).toEqual(list("PUSH_CATEGORIES"));
    expect([...Object.keys(PUSH_LINK_SEAT), ...Object.keys(PUSH_LINK_CARD)].sort()).toEqual(list("PUSH_LINKS").sort());
    for (const dict of [en, hi]) {
      for (const c of PUSH_CATEGORIES) {
        expect(dict.mobile.push.category[c]).toBeTruthy();
        expect(dict.mobile.push.categoryHint[c]).toBeTruthy();
      }
      for (const st of ["unknown", "notInBuild", "unreachable", "serverError", "notLinked", "serverOff", "off", "denied", "on"] as const) {
        expect(dict.mobile.push.status[st]).toBeTruthy();
        expect(dict.mobile.push.why[st]).toBeTruthy();
      }
    }
  });

  it("reads a notification's two words wherever Android put them", () => {
    // App open: expo puts the data on the content.
    expect(noteOf({ request: { content: { title: "HMIS", body: "x", data: { category: "roster", link: "onNow" } } } })).toEqual({ category: "roster", link: "onNow", title: "HMIS", body: "x" });
    // App closed, tapped from the tray: the words are in the FCM message.
    expect(noteOf({ request: { content: { title: null, body: null, data: null }, trigger: { remoteMessage: { data: { category: "alert", link: "home" }, notification: { title: "HMIS", body: "y" } } } } }))
      .toEqual({ category: "alert", link: "home", title: "HMIS", body: "y" });
    expect(noteOf({ request: { content: {} } })).toEqual({ category: "", link: "", title: "", body: "" });
  });
});

describe("screenshots (M6b)", () => {
  afterEach(() => { jest.resetModules(); });

  it("the staging build blocks nothing", async () => {
    const prevent = jest.fn(async () => undefined);
    jest.doMock("expo-screen-capture", () => ({ preventScreenCaptureAsync: prevent }));
    const { SCREENSHOTS_BLOCKED, guardScreen } = jest.requireActual("../src/privacy") as typeof import("../src/privacy");
    expect(SCREENSHOTS_BLOCKED).toBe(false);
    await guardScreen();
    expect(prevent).not.toHaveBeenCalled();
  });

  it("the production build sets the secure flag on the app's window — and a phone where that fails still opens", async () => {
    const prevent = jest.fn(async () => undefined);
    jest.isolateModules(() => {
      jest.doMock("../src/config", () => ({ IS_PRODUCTION: true }));
      jest.doMock("expo-screen-capture", () => ({ preventScreenCaptureAsync: prevent }));
    });
    let privacy!: typeof import("../src/privacy");
    jest.isolateModules(() => {
      jest.doMock("../src/config", () => ({ IS_PRODUCTION: true }));
      jest.doMock("expo-screen-capture", () => ({ preventScreenCaptureAsync: prevent }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      privacy = require("../src/privacy") as typeof import("../src/privacy");
    });
    expect(privacy.SCREENSHOTS_BLOCKED).toBe(true);
    await privacy.guardScreen();
    expect(prevent).toHaveBeenCalledWith("hmis");
    prevent.mockRejectedValueOnce(new Error("native module missing"));
    await expect(privacy.guardScreen()).resolves.toBeUndefined();
  });
});
