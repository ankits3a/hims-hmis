import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "../lib/api";
import { renderWithProviders } from "../test-utils";
import { MyReach } from "./my-reach";

/**
 * ═══ PHASE O T4 — `/me/reach`, AND THE THREE STATES A TOGGLE WOULD HIDE ═══
 *
 * A push switch that is only "on" or "off" says the same thing to a person whose browser
 * cannot do push at all, a person who has never been asked, and a person who has said no and
 * whose browser will never ask again. Each needs different words and a different button, and
 * that distinction is the reason this screen exists rather than a checkbox on another one.
 */
const SETTINGS = {
  language: "en" as const,
  ladder: ["web_push", "whatsapp", "sms"] as ("web_push" | "whatsapp" | "sms")[],
  quietExempt: false,
  sharedPhone: false,
  consentAt: null,
  isOwnProfile: false,
  pushSubscriptions: [] as { id: string; endpoint: string; userAgent: string | null; createdAt: string }[],
  vapidPublicKey: "BPublicKey",
};

function mockApi(settings: Record<string, unknown> = SETTINGS, seen: { body: string }[] = []): { body: string }[] {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.includes("/api/auth/me")) {
      return new Response(JSON.stringify({ actor: { type: "user", id: "u-1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (init?.method === "POST") {
      seen.push({ body: typeof init.body === "string" ? init.body : "" });
      return new Response(JSON.stringify(settings), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(settings), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return seen;
}

/** jsdom has no Notification and no service worker: that IS the "unsupported" case. */
function grantPushSupport(permission: "default" | "granted" | "denied"): void {
  vi.stubGlobal("Notification", { permission, requestPermission: () => Promise.resolve(permission) });
  vi.stubGlobal("PushManager", function PushManager() { /* presence is the whole API this reads */ });
  Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
}

describe("MyReach", () => {
  beforeEach(() => { setToken("tok-1"); });
  afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

  it("shows the ladder in order and the language, and saves a language change", async () => {
    const seen = mockApi();
    renderWithProviders(<MyReach />);

    const ladder = await screen.findByTestId("reach-ladder");
    expect(ladder.textContent).toBe("BrowserWhatsAppSMS");

    await userEvent.click(screen.getByTestId("reach-language-hi"));
    await waitFor(() => { expect(seen).toHaveLength(1); });
    expect(JSON.parse(seen[0]!.body)).toEqual({ language: "hi" });
  });

  it("refuses to remove the LAST channel — a person nothing can reach looks exactly like a quiet one", async () => {
    const seen = mockApi({ ...SETTINGS, ladder: ["web_push"] });
    renderWithProviders(<MyReach />);

    await screen.findByTestId("reach-ladder");
    await userEvent.click(screen.getByTestId("reach-channel-web_push"));

    expect(await screen.findByTestId("reach-error")).toHaveTextContent("at least one channel");
    expect(seen).toHaveLength(0); // and nothing was sent
  });

  it("says the browser cannot do push at all, rather than offering a button that cannot work", async () => {
    mockApi();
    renderWithProviders(<MyReach />);
    // jsdom supplies no Notification and no service worker — the iPhone-before-install case.
    expect(await screen.findByTestId("reach-push-state")).toHaveTextContent("cannot show notifications");
    expect(screen.queryByTestId("reach-push-toggle")).not.toBeInTheDocument();
  });

  it("says the person has BLOCKED it and where to change that — the browser will not re-ask", async () => {
    grantPushSupport("denied");
    mockApi();
    renderWithProviders(<MyReach />);
    expect(await screen.findByTestId("reach-push-state")).toHaveTextContent("blocked notifications");
    // No button: tapping one could not prompt, and a button that silently does nothing is worse
    // than a sentence saying where the setting lives.
    expect(screen.queryByTestId("reach-push-toggle")).not.toBeInTheDocument();
  });

  it("says push is not configured for the hospital when no VAPID key exists", async () => {
    grantPushSupport("default");
    mockApi({ ...SETTINGS, vapidPublicKey: null });
    renderWithProviders(<MyReach />);
    expect(await screen.findByTestId("reach-push-state")).toHaveTextContent("not switched on for this hospital");
    expect(screen.queryByTestId("reach-push-toggle")).not.toBeInTheDocument();
  });

  it("names the OTHER browsers, which is how somebody learns why a push reached nobody", async () => {
    grantPushSupport("granted");
    mockApi({
      ...SETTINGS,
      pushSubscriptions: [
        { id: "s1", endpoint: "https://fcm.test/phone", userAgent: "Chrome on Android", createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "s2", endpoint: "https://fcm.test/desk", userAgent: null, createdAt: "2026-08-01T00:00:00.000Z" },
      ],
    });
    renderWithProviders(<MyReach />);

    const state = await screen.findByTestId("reach-push-state");
    expect(state).toHaveTextContent("On, in 2 browsers.");
    const list = screen.getByTestId("reach-push-browsers");
    expect(list.textContent).toContain("Chrome on Android");
    expect(list.textContent).toContain("An unnamed browser");
  });
});
