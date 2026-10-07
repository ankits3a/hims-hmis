import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Index from "../app/index";
import { I18nProvider } from "../src/i18n";
import { SessionProvider } from "../src/session";
import { _forgetDeviceForTests } from "../src/device";

jest.mock("expo-secure-store", () => {
  // Keyed, like the real store: the session and the phone's own id (M6a) live under different keys.
  const store = new Map<string, string>();
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
    __reset: () => { store.clear(); },
    __get: (k: string) => store.get(k) ?? null,
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: (...a: unknown[]) => mockPush(...a), back: jest.fn() }) }));

type Route = (init: RequestInit | undefined) => { status: number; body?: unknown };

function server(routes: Record<string, Route>) {
  const calls: string[] = [];
  const f = jest.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(/^https?:\/\/[^/]+\/api/, "")}`;
    calls.push(key);
    const r = routes[key];
    if (r === undefined) return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
    const { status, body } = r(init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return { fetcher: f as unknown as typeof fetch, calls };
}

const ME = {
  actor: { type: "user", id: "01J" },
  permissions: { hospital: ["opd.vitals.record", "roster.read"], scoped: { department: {}, floor: {} } },
};

async function mount(fetcher: typeof fetch) {
  return await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <I18nProvider>
        <SessionProvider fetcher={fetcher}>
          <Index />
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>,
  );
}

async function signIn(username = "asha.devi", password = "correct horse") {
  await screen.findByTestId("username");
  await fireEvent.changeText(screen.getByTestId("username"), username);
  await fireEvent.changeText(screen.getByTestId("password"), password);
  await fireEvent.press(screen.getByTestId("sign-in"));
}

describe("sign-in flow", () => {
  beforeEach(() => {
    (jest.requireMock("expo-secure-store") as { __reset: () => void }).__reset();
    _forgetDeviceForTests();
    mockPush.mockClear();
  });

  /*
    ═══ M6a — THIS PHONE (owner 2026-10-06: staff use personal phones) ═══
  */
  it("the sign-in names this phone: an id made once per install, what the phone says it is, and the build — never a secret", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { fetcher } = server({
      "POST /auth/login": (init) => { bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>); return { status: 200, body: { token: "t1" } }; },
      "GET /auth/me": () => ({ status: 200, body: ME }),
      "POST /auth/logout": () => ({ status: 204 }),
    });
    await mount(fetcher);
    await signIn();
    await fireEvent.press(await screen.findByTestId("logout"));
    await signIn();
    await screen.findByTestId("seat-vitals");
    expect(bodies).toHaveLength(2);
    const first = bodies[0]!.device as { deviceId: string; appVersion: string };
    // The shape the server's `deviceClaimSchema` accepts.
    expect(first.deviceId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(first.appVersion).toMatch(/^\d+\.\d+\.\d+ \(\d+\)$/);
    expect(Object.keys(bodies[0]!).sort()).toEqual(["device", "password", "username"]);
    // Logging out clears the session, NOT the phone's id: the second sign-in is the same phone.
    expect((bodies[1]!.device as { deviceId: string }).deviceId).toBe(first.deviceId);
    const store = jest.requireMock("expo-secure-store") as { __get: (k: string) => string | null };
    expect(store.__get("hmis.device")).toBe(first.deviceId);
    // The session remembers when this phone signed in, for the Account screen.
    expect(typeof (JSON.parse(store.__get("hmis.session")!) as { since?: string }).since).toBe("string");
  });

  it("the third phone is told so in words — which phones hold the places, and who can free one — not 'wrong password'", async () => {
    const { fetcher } = server({
      "POST /auth/login": () => ({ status: 409, body: { code: "phone_limit_reached", message: "x", limit: 2, phones: [{ model: "Redmi Note 12", lastSeenAt: "2026-10-06T05:00:00.000Z" }, { model: null, lastSeenAt: "2026-10-05T05:00:00.000Z" }] } }),
    });
    await mount(fetcher);
    await signIn();
    const said = await screen.findByTestId("login-error");
    expect(said).toHaveTextContent("You are already signed in on 2 other phones (Redmi Note 12, a phone). Ask the administrator to sign one out — Users, then Phones — and sign in again.");
    expect(screen.getByTestId("username")).toBeTruthy();
  });

  it("a phone the administrator signed out returns to sign-in when it is next opened, says why it might be, and drops the dead token", async () => {
    const store = jest.requireMock("expo-secure-store") as { setItemAsync: (k: string, v: string) => Promise<void>; __get: (k: string) => string | null };
    await store.setItemAsync("hmis.session", JSON.stringify({ token: "t-signed-out", username: "asha.devi", since: "2026-10-06T03:30:00.000Z" }));
    // The server no longer knows this token: every call with it is a 401.
    const { fetcher, calls } = server({ "GET /auth/me": () => ({ status: 401, body: { message: "Unauthorized" } }) });
    await mount(fetcher);
    expect(await screen.findByTestId("expired")).toHaveTextContent("You are signed out — your session ended, or an administrator signed this phone out. Sign in again.");
    expect(calls).toEqual(["GET /auth/me"]);
    expect(store.__get("hmis.session")).toBeNull();
    expect(screen.getByTestId("username")).toBeTruthy();
  });

  it("the home screen leads to 'This phone and my account'", async () => {
    const { fetcher } = server({
      "POST /auth/login": () => ({ status: 200, body: { token: "t1" } }),
      "GET /auth/me": () => ({ status: 200, body: ME }),
    });
    await mount(fetcher);
    await signIn();
    await fireEvent.press(await screen.findByTestId("account-open"));
    expect(mockPush).toHaveBeenCalledWith("/account");
  });

  it("signs in and offers only the screens the role allows", async () => {
    const { fetcher, calls } = server({
      "POST /auth/login": () => ({ status: 200, body: { token: "t1" } }),
      "GET /auth/me": () => ({ status: 200, body: ME }),
    });
    await mount(fetcher);
    await signIn();
    expect(await screen.findByTestId("seat-vitals")).toBeTruthy();
    expect(screen.getByTestId("seat-onNow")).toBeTruthy();
    expect(screen.queryByTestId("seat-counter")).toBeNull();
    expect(screen.getByTestId("signed-in-as")).toHaveTextContent("Signed in as asha.devi");
    // …one read that is not the API: the update feed, asked quietly when the home screen opens (M3)…
    expect(calls.slice(0, 2)).toEqual(["POST /auth/login", "GET /auth/me"]);
    expect(calls).toContain("GET https://stagehmis.crkmch.com/app/hmis-staff-staging-latest.json");
    // …and the home's own reads (app home, 2026-10-07): only what this role's screens already read, plus the person's own day.
    const home = calls.slice(2).filter((c) => !c.startsWith("GET https://"));
    expect(home.map((c) => c.split("?")[0]).sort()).toEqual([
      "GET /alerts", "GET /me/brief", "GET /me/brief", "GET /me/brief", "GET /me/desk", "GET /me/team", "GET /opd/bench", "GET /roster/my-duties",
    ]);
  });

  it("says the web's own words for a wrong password and stays on sign-in", async () => {
    const { fetcher } = server({ "POST /auth/login": () => ({ status: 401, body: { message: "Unauthorized" } }) });
    await mount(fetcher);
    await signIn();
    expect(await screen.findByTestId("login-error")).toHaveTextContent("Sign-in failed — check the username and password");
  });

  it("takes an administrator-issued password to the forced change, then home", async () => {
    let changed = false;
    const { fetcher } = server({
      "POST /auth/login": () => ({ status: 200, body: { token: "t1" } }),
      "GET /auth/me": () => (changed ? { status: 200, body: ME } : { status: 403, body: { message: "password_change_required" } }),
      "POST /auth/change-password": (init) => {
        const b = JSON.parse(String(init?.body)) as { currentPassword: string };
        if (b.currentPassword !== "issued-pass") return { status: 403, body: { message: "current_password_incorrect" } };
        changed = true;
        return { status: 204 };
      },
    });
    await mount(fetcher);
    await signIn("asha.devi", "issued-pass");
    await screen.findByTestId("current");
    await fireEvent.changeText(screen.getByTestId("current"), "wrong");
    await fireEvent.changeText(screen.getByTestId("next"), "a long new password");
    await fireEvent.changeText(screen.getByTestId("again"), "a long new password");
    await fireEvent.press(screen.getByTestId("change"));
    expect(await screen.findByTestId("change-error")).toHaveTextContent("The current password is wrong");
    await fireEvent.changeText(screen.getByTestId("current"), "issued-pass");
    await fireEvent.press(screen.getByTestId("change"));
    expect(await screen.findByTestId("seat-vitals")).toBeTruthy();
  });

  it("refuses mismatched new passwords without calling the server", async () => {
    const { fetcher, calls } = server({
      "POST /auth/login": () => ({ status: 200, body: { token: "t1" } }),
      "GET /auth/me": () => ({ status: 403, body: { message: "password_change_required" } }),
    });
    await mount(fetcher);
    await signIn();
    await screen.findByTestId("current");
    await fireEvent.changeText(screen.getByTestId("current"), "x");
    await fireEvent.changeText(screen.getByTestId("next"), "aaaaaaaaaaaa");
    await fireEvent.changeText(screen.getByTestId("again"), "bbbbbbbbbbbb");
    await fireEvent.press(screen.getByTestId("change"));
    expect(await screen.findByTestId("change-error")).toHaveTextContent("The two new passwords do not match");
    expect(calls).not.toContain("POST /auth/change-password");
  });

  it("logs out on the server and returns to sign-in", async () => {
    const { fetcher, calls } = server({
      "POST /auth/login": () => ({ status: 200, body: { token: "t1" } }),
      "GET /auth/me": () => ({ status: 200, body: ME }),
      "POST /auth/logout": () => ({ status: 204 }),
    });
    await mount(fetcher);
    await signIn();
    await fireEvent.press(await screen.findByTestId("logout"));
    await waitFor(() => expect(screen.getByTestId("username")).toBeTruthy());
    expect(calls).toContain("POST /auth/logout");
  });

  it("switches to Hindi", async () => {
    const { fetcher } = server({});
    await mount(fetcher);
    await screen.findByTestId("username");
    await fireEvent.press(screen.getByTestId("lang-toggle"));
    expect(await screen.findByText("अपनी सीट पर साइन इन करें")).toBeTruthy();
  });

  it("opens a stored session only after the phone confirms the person", async () => {
    const store = jest.requireMock("expo-secure-store") as { setItemAsync: (k: string, v: string) => Promise<void> };
    await store.setItemAsync("hmis.session", JSON.stringify({ token: "t9", username: "asha.devi" }));
    const la = jest.requireMock("expo-local-authentication") as Record<string, jest.Mock>;
    la.hasHardwareAsync!.mockResolvedValue(true);
    la.isEnrolledAsync!.mockResolvedValue(true);
    la.authenticateAsync!.mockResolvedValueOnce({ success: false }).mockResolvedValueOnce({ success: true });
    const { fetcher, calls } = server({ "GET /auth/me": () => ({ status: 200, body: ME }) });
    await mount(fetcher);
    expect(await screen.findByTestId("unlock")).toBeTruthy();
    expect(await screen.findByTestId("unlock-failed")).toBeTruthy();
    expect(calls).toEqual([]); // the token is not used until the phone says yes
    await fireEvent.press(screen.getByTestId("unlock"));
    expect(await screen.findByTestId("seat-vitals")).toBeTruthy();
    expect(screen.getByTestId("signed-in-as")).toHaveTextContent("Signed in as asha.devi");
    la.hasHardwareAsync!.mockResolvedValue(false);
    la.isEnrolledAsync!.mockResolvedValue(false);
  });
});
