import { fireEvent, screen } from "@testing-library/react";
import { KeyboardProvider } from "./keyboard";
import { PaletteProvider } from "../components/command-palette";
import { renderWithProviders } from "../test-utils";

/**
 * THE GLOBAL KEYBOARD MAP — AND UNTIL RC-3 §6.4 THERE WAS NO TEST FILE FOR IT AT ALL.
 *
 * `keyboard.tsx` has shipped eight global shortcuts since Plan 07b and the only part of it any test
 * touched was `shouldOpenPalette`, which it extracted precisely so it could be asserted in
 * isolation. The other seven bindings — every `Alt+<letter>` a desk uses to move around the
 * application — were unasserted, so this file starts by pinning what already shipped and then adds
 * the one RC-3's close review ruled in.
 *
 * `useNavigate` is mocked rather than mounted: a `RouterProvider` is not needed to prove which
 * destination a keystroke asks for, and `registration-desk.test.tsx:14` and `login.test.tsx:13`
 * already established this shape in the repo.
 */
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, useSearch: () => ({}) }));

function mountMap(): void {
  renderWithProviders(
    <PaletteProvider>
      <KeyboardProvider>
        <input data-testid="a-field" />
      </KeyboardProvider>
    </PaletteProvider>,
  );
}

describe("the global keyboard map", () => {
  beforeEach(() => navigate.mockClear());

  /**
   * THE CENSUS FIRST (§2.49). Every assertion below is about ONE binding; if the provider stopped
   * handling keys at all, each of those would fail for a reason unrelated to what it tests. This
   * pins that the map is live and non-vacuous before anything else is claimed about it.
   */
  it("reads a NON-VACUOUS map — the shipped Alt bindings still reach their screens", () => {
    mountMap();
    for (const [key, to] of [["m", "/merge"], ["a", "/approvals"], ["d", "/opd/desk"], ["p", "/opd/appointments"]] as const) {
      navigate.mockClear();
      fireEvent.keyDown(window, { key, altKey: true });
      expect({ key, to: navigate.mock.calls[0]?.[0]?.to }).toEqual({ key, to });
    }
  });

  /**
   * ═══ RC-3 §6.4, RULED — `Alt+N` IS THE NEW-PATIENT CHORD ═══
   *
   * Desk One specifies `Ctrl+N` and **Chrome does not deliver it to the page** (non-overridable,
   * new window); Firefox opens a window regardless of `preventDefault`. So the seat shipped a
   * handler for a keystroke its browser eats. `Alt+N` was free and needed no invention — this map
   * already binds seven `Alt+<letter>` actions, so the convention chose the letter.
   */
  it("Alt+N opens the new-patient form, at the same destination F2 already reaches", () => {
    mountMap();
    fireEvent.keyDown(window, { key: "n", altKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: { new: true } });

    // F2 is NOT replaced. It is on the legend the shipped counter already prints, and retraining a
    // desk to fix a problem it does not have is a cost with no benefit.
    navigate.mockClear();
    fireEvent.keyDown(window, { key: "F2" });
    expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: { new: true } });
  });

  /**
   * THE KILL FOR F5's ROOT COMPLAINT, and the reason this binding is global rather than seat-local.
   *
   * The seat's `Ctrl+N` sat below a typing guard while its search box carries `autoFocus` — so the
   * shortcut was dead at the one moment a clerk wants it: having searched, found nobody, and read
   * the "Register new" line. `Alt+<letter>` produces no character, so the global map guards none of
   * them, and the door opens from inside the field where the clerk's hands already are.
   */
  it("fires from INSIDE a focused text field — which is where the clerk's hands are", () => {
    mountMap();
    const field = screen.getByTestId("a-field");
    field.focus();
    fireEvent.keyDown(field, { key: "n", altKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: { new: true } });
  });

  it("a bare N is not a shortcut — it is a letter somebody is typing", () => {
    mountMap();
    fireEvent.keyDown(screen.getByTestId("a-field"), { key: "n" });
    expect(navigate).not.toHaveBeenCalled(); // THE KILL for a modifier-less binding
  });
});
