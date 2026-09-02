import { fireEvent, screen } from "@testing-library/react";
import { KeyboardProvider, ShortcutLegend } from "./keyboard";
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
  it("reads a NON-VACUOUS map — Ctrl+N still reaches its screen", () => {
    mountMap();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(navigate.mock.calls[0]?.[0]?.to).toBe("/registration");
  });

  /**
   * ═══ FD-5 / OWNER RULING — THE SEVEN PARKED CHORDS REACH NOTHING ═══
   *
   *   > "park them for now and redesign them as new"
   *
   * `Alt+M`, `Alt+A`, `Alt+D`, `Alt+V`, `Alt+C`, `Alt+P` and `Alt+B` navigated to six screens and,
   * in `Alt+B`'s case, carried the encounter in hand. None of them appears in any signed-off
   * design; they grew by convention. They are out of the map and out of the legend until the
   * redesign, and this row is what stops one of them quietly growing back — a future task that
   * wants `Alt+D` has to delete a named assertion and read why it was parked.
   *
   * `Alt+N` is NOT in this list and must not be: it is the plain-tab half of the new-patient chord
   * (Chrome eats `Ctrl+N` in an ordinary tab), which is a different thing from a parked navigation.
   */
  it("the seven parked Alt chords navigate NOWHERE until they are redesigned", () => {
    mountMap();
    for (const key of ["m", "a", "d", "v", "c", "p", "b"] as const) {
      navigate.mockClear();
      fireEvent.keyDown(window, { key, altKey: true });
      expect({ key, calls: navigate.mock.calls.length }).toEqual({ key, calls: 0 });
    }
  });

  /**
   * ═══ FD-3 / OWNER RULING 2026-09-02 — `Ctrl+N` IS THE NEW-PATIENT CHORD ═══
   *
   *   > "CTRL + N should replace F2. F2 will be dedicated to pull agent."
   *
   * RC-3 §6.4 had ruled the other way — `Alt+N`, because **Chrome does not deliver `Ctrl+N` to the
   * page** in an ordinary tab (it is on the non-overridable list: new window) and Firefox opens a
   * window regardless of `preventDefault`. That browser fact has not changed and is not fixable
   * here. What the owner's ruling changes is which chord the product NAMES, and both are bound:
   * `Ctrl+N` is the ruling and reaches the page in an installed PWA or a kiosk/`--app=` window,
   * `Alt+N` is the one that survives a plain tab. Binding only `Ctrl+N` would have left the desks
   * that exist today with no working chord at all.
   */
  it("Ctrl+N opens the new-patient form — the owner's chord", () => {
    mountMap();
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: { new: true } });
  });

  it("Alt+N reaches the same door — the chord that survives a plain Chrome tab", () => {
    mountMap();
    fireEvent.keyDown(window, { key: "n", altKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: { new: true } });
  });

  it("Cmd+N too — a Mac at the administrator's desk is not a different product", () => {
    mountMap();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    expect(navigate).toHaveBeenCalledWith({ to: "/registration", search: { new: true } });
  });

  /**
   * ═══ THE RESERVATION, AS AN ASSERTION RATHER THAN A COMMENT ═══
   *
   * `F2` navigated to the new-patient form until this change. The owner has dedicated it to the
   * agent surface, which is not built (RC-6; `agent_ledger` is still a comment) — so the correct
   * state today is that `F2` reaches NOTHING and is advertised NOWHERE.
   *
   * This row is what makes that a reservation rather than an oversight: a future task that wants a
   * spare function key has to delete a named, explained assertion to take this one.
   */
  it("F2 is RESERVED for the agent — it navigates nowhere and the legend does not offer it", () => {
    mountMap();
    fireEvent.keyDown(window, { key: "F2" });
    expect(navigate).not.toHaveBeenCalled();
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

  /**
   * FD-3 — THE LEGEND IS PART OF THE MAP, because it is the only place a desk learns any of this.
   * A binding changed without its label is a shortcut nobody discovers; a label changed without its
   * binding is a lie printed along the bottom of every screen. Asserted together, in one row.
   */
  it("the legend teaches exactly what the map binds — Ctrl+K search, Ctrl+N new, and no F2", () => {
    renderWithProviders(
      <PaletteProvider>
        <KeyboardProvider><ShortcutLegend /></KeyboardProvider>
      </PaletteProvider>,
    );
    const legend = screen.getByRole("contentinfo");
    expect(legend).toHaveTextContent("Ctrl+K");
    expect(legend).toHaveTextContent("Ctrl+N");
    expect(legend).toHaveTextContent("Alt+N");
    // THE KILL for a legend that still trains the desk to press a reserved key.
    expect(legend.textContent).not.toContain("F2");
    /*
     * FD-5 — and it must not advertise a PARKED chord either. The strings stay in the locale files
     * on purpose (the redesign should not have to re-translate seven labels); what must not happen
     * is the footer teaching a desk a chord the map no longer answers.
     */
    for (const parked of ["Alt+M", "Alt+A", "Alt+D", "Alt+V", "Alt+C", "Alt+P", "Alt+B"]) {
      expect(legend.textContent).not.toContain(parked);
    }
  });
});
