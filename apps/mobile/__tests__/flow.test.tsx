import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Index from "../app/index";
import { I18nProvider } from "../src/i18n";
import { SessionProvider } from "../src/session";

jest.mock("expo-secure-store", () => {
  let v: string | null = null;
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async () => v),
    setItemAsync: jest.fn(async (_k: string, val: string) => { v = val; }),
    deleteItemAsync: jest.fn(async () => { v = null; }),
    __reset: () => { v = null; },
  };
});
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

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
  beforeEach(() => (jest.requireMock("expo-secure-store") as { __reset: () => void }).__reset());

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
    expect(calls).toEqual(["POST /auth/login", "GET /auth/me"]);
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
