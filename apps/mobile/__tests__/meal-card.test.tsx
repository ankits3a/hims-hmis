import { render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider, translate } from "../src/i18n";
import { MealCardLine, MealCardScreen } from "../src/canteen/meal-card";
import { SessionProvider, useSession } from "../src/session";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>([["hmis.session", JSON.stringify({ token: "t1", username: "nurse.a", since: "2026-10-07T03:30:00.000Z" })]]);
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, val: string) => { store.set(k, val); }),
    deleteItemAsync: jest.fn(async (k: string) => { store.delete(k); }),
  };
});
jest.mock("expo-local-authentication", () => ({ hasHardwareAsync: jest.fn(async () => false), isEnrolledAsync: jest.fn(async () => false), authenticateAsync: jest.fn(async () => ({ success: true })) }));
jest.mock("expo-haptics", () => ({ notificationAsync: jest.fn(async () => undefined), NotificationFeedbackType: { Success: "success" } }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

/** CN-1 (#977) — the staff meal card: the server's QR rows drawn as they are, the staff code under them; no card, a line. */
const t = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const CARD = { token: "CNTS1.x.1.9999999999.sig", expiresAt: new Date(Date.now() + 60_000).toISOString(), staffCode: "N-101", category: "Nursing", qr: ["1010", "0101", "1100", "0011"] };

function server(card: { status: number; body?: unknown }) {
  return jest.fn(async (url: string) => {
    const path = url.replace(/^https?:\/\/[^/]+\/api/, "");
    if (path === "/auth/me") return new Response(JSON.stringify({ actor: { type: "user", id: "u1" }, permissions: { hospital: [], scoped: { department: {}, floor: {} } } }), { status: 200 });
    if (path === "/canteen/my-card") return new Response(card.body === undefined ? null : JSON.stringify(card.body), { status: card.status });
    return new Response(JSON.stringify({ message: "not_found" }), { status: 404 });
  }) as unknown as typeof fetch;
}
function Gate() { const { state } = useSession(); return state.status !== "signedIn" ? null : <MealCardScreen />; }
const mount = async (fetcher: typeof fetch) => await render(
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 780 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
    <I18nProvider><SessionProvider fetcher={fetcher}><Gate /></SessionProvider></I18nProvider>
  </SafeAreaProvider>,
);

describe("staff meal card", () => {
  it("draws the server's QR and the staff code", async () => {
    await mount(server({ status: 200, body: CARD }));
    await waitFor(() => expect(screen.getByTestId("meal-card-code")).toHaveTextContent("N-101"));
    expect(screen.getByTestId("meal-card-qr")).toBeTruthy();
    expect(screen.getByText("Nursing")).toBeTruthy();
  });

  it("no card: a line, no QR", async () => {
    await mount(server({ status: 400, body: { code: "staff_card_invalid" } }));
    await waitFor(() => expect(screen.getByText("No meal card. Ask finance.")).toBeTruthy());
    expect(screen.queryByTestId("meal-card-qr")).toBeNull();
  });

  it("the home line shows only for a person with a card", async () => {
    await render(<MealCardLine t={t} has={false} onOpen={jest.fn()} />);
    expect(screen.queryByTestId("home-meal-card")).toBeNull();
    await screen.unmount();
    await render(<MealCardLine t={t} has onOpen={jest.fn()} />);
    expect(screen.getByTestId("home-meal-card")).toHaveTextContent(/^Meal card/);
  });
});
