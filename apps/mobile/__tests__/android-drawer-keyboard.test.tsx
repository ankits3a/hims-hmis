import { act, render, screen } from "@testing-library/react-native";
import { BackHandler, Keyboard, Platform, StyleSheet, TextInput as RNTextInput } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Drawer } from "../src/consult/sheets";
import { I18nProvider } from "../src/i18n";

/*
  ANDROID KEYBOARD OVER A CONSULT DRAWER (owner 2026-10-10, staging APK vc21: "keyboard not fixed" on the
  Notes and "Advice and follow-up" drawers). A Modal's dialog window is edge-to-edge since React Native 0.81:
  Android does not resize it, and padding it did not help on the phone. On Android the drawer is an overlay
  in the screen's own window, lifted by the keyboard's height; Back closes it.
*/
const realOS = Platform.OS;
const setOS = (os: string) => { (Platform as { OS: string }).OS = os; };
afterEach(() => setOS(realOS));

type Handler = (e: { endCoordinates: { height: number } }) => void;
function captureKeyboard(): Record<string, Handler> {
  const seen: Record<string, Handler> = {};
  jest.spyOn(Keyboard, "addListener").mockImplementation(((name: string, fn: Handler) => {
    seen[name] = fn;
    return { remove: () => undefined };
  }) as unknown as typeof Keyboard.addListener);
  return seen;
}

async function drawer(onClose = jest.fn()) {
  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 780 }, insets: { top: 24, left: 0, right: 0, bottom: 48 } }}>
      <I18nProvider>
        <Drawer title="Notes" testID="notes-drawer" onClose={onClose}><RNTextInput testID="box" /></Drawer>
      </I18nProvider>
    </SafeAreaProvider>,
  );
  return onClose;
}

describe("Android consult drawer and the keyboard", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is drawn in the screen's window, not a Modal", async () => {
    setOS("android");
    captureKeyboard();
    await drawer();
    expect(screen.queryByTestId("keyboard-sheet")).toBeNull(); // the KeyboardModal's wrapper
    expect(screen.getByTestId("drawer-overlay")).toContainElement(screen.getByTestId("box"));
  });

  it("rises by the keyboard's height plus the navigation bar, and drops when it closes", async () => {
    setOS("android");
    const kb = captureKeyboard();
    await drawer();
    const pad = () => StyleSheet.flatten(screen.getByTestId("drawer-overlay").props.style).paddingBottom;
    expect(pad()).toBe(0);
    await act(async () => kb.keyboardDidShow!({ endCoordinates: { height: 300 } }));
    expect(pad()).toBe(348);
    await act(async () => kb.keyboardDidHide!({ endCoordinates: { height: 0 } }));
    expect(pad()).toBe(0);
  });

  it("Back closes the drawer, as the Modal did", async () => {
    setOS("android");
    captureKeyboard();
    let back: (() => boolean) | null = null;
    jest.spyOn(BackHandler, "addEventListener").mockImplementation(((_n: string, fn: () => boolean) => {
      back = fn;
      return { remove: () => undefined };
    }) as unknown as typeof BackHandler.addEventListener);
    const onClose = await drawer();
    expect(back!()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("iPhone keeps the KeyboardModal", async () => {
    setOS("ios");
    await drawer();
    expect(screen.getByTestId("keyboard-sheet")).toContainElement(screen.getByTestId("box"));
    expect(screen.queryByTestId("drawer-overlay")).toBeNull();
  });
});
