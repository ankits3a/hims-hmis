import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { usePalette } from "../components/command-palette";

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/**
 * ═══ FD-7 T7 / OWNER RULING 2026-09-03 — `Ctrl+K` IS GONE, AND THAT IS THE POINT ═══
 *
 *   > "no shortcut should overlap chrome browser or any browser internal shortcut keys"
 *
 * `Ctrl+K` focuses Chrome's address bar in search mode. FD-3 had added it to the legend one day
 * earlier at the owner's own request, and this ruling overturns that — the owner was told so. It is
 * removed from the opener, not merely from the legend: a chord the browser eats is a chord that
 * teaches the desk the software is broken.
 *
 * `/` STAYS, and the exception is deliberate rather than an oversight. It is not a Chrome shortcut,
 * and Chrome is the browser this hospital runs. Firefox binds `/` to Quick Find — but unlike
 * `Ctrl+N`, Quick Find IS suppressible from the page, and `preventDefault()` below does suppress it.
 * That is the whole distinction the ruling turns on: a key the page can still claim is safe to
 * claim; a key the browser takes before the page sees it is not.
 *
 * The typing guard is unchanged and is still the part most likely to be got wrong silently: a `/`
 * inside a consultation note is a character, not a command.
 */
export function shouldOpenPalette(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">,
  target: EventTarget | null,
): boolean {
  return e.key === "/" && !e.ctrlKey && !e.metaKey && !isTypingTarget(target);
}

/**
 * ═══ THE FIVE FUNCTION KEYS NO BROWSER CLAIMS ═══
 *
 * F1 help · F3 find · F5 reload · F6 address bar · F10 menu · F11 fullscreen · F12 devtools. That
 * leaves exactly these five, and the desk is built on them plus Tab, Enter, Escape and bare digits.
 * `browserSafeKey` is exported so the map can be asserted against it rather than against a list a
 * reviewer has to check by eye — see `keyboard.test.tsx`'s census row.
 */
export const BROWSER_FREE_FUNCTION_KEYS = ["F2", "F4", "F7", "F8", "F9"] as const;

/**
 * Every key combination the application binds must pass this. It is a PREDICATE rather than a
 * comment because §4d's rule is exactly the kind that decays: the next task to want a shortcut
 * reaches for `Ctrl+<letter>` because that is what applications do, and nothing would stop it.
 */
export function browserSafeKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  // Ctrl/Cmd + a letter or digit is a browser command almost without exception (Ctrl+1…9 switches
  // tabs). The ONE survivor the desk uses is Ctrl+Enter, which no browser claims.
  if (e.ctrlKey || e.metaKey) return e.key === "Enter";
  if (/^F\d{1,2}$/.test(e.key)) return (BROWSER_FREE_FUNCTION_KEYS as readonly string[]).includes(e.key);
  return true;
}

    /**
     * ═══ FD-5 / OWNER RULING 2026-09-02 — THE SEVEN `Alt+<letter>` CHORDS ARE PARKED ═══
     *
     *   > "park them for now and redesign them as new"
     *
     * Removed from the live map and from the legend, NOT quietly forgotten. What was here, and
     * what each reached, so the redesign starts from the record rather than from archaeology:
     *
     *     Alt+M  /merge                    the duplicate-merge review
     *     Alt+A  /approvals                the approvals inbox
     *     Alt+D  /opd/desk                 the supervisor's OPD board
     *     Alt+V  /opd/vitals               the vitals desk (Bay One serves this path now)
     *     Alt+C  /opd/consult              the doctor's consultation screen
     *     Alt+P  /opd/appointments         the appointment book
     *     Alt+B  /billing, CARRYING the encounter in hand when there is one — that last part is
     *            the only one of the seven that was an ACTION rather than a destination (07b T2),
     *            and it is the property the redesign should not lose: a clerk mid-walk-in landed
     *            on a loaded counter rather than an empty one.
     *
     * WHY PARKED RATHER THAN KEPT. None of the seven appears in any signed-off design. Desk One
     * defines `Ctrl+K`, `Ctrl+N`, `Ctrl+Enter`, `Esc` and `1/2/3` and covers the COUNTER; it never
     * claimed whole-application navigation, so these grew by convention instead of by design and
     * the owner has sent them back to be designed.
     *
     * WHAT THIS COSTS TODAY, STATED PLAINLY: those six screens are mouse-only until the redesign
     * lands. `Ctrl+K` reaches every one of them by name — it searches screens as well as patients
     * — so nothing is unreachable from the keyboard, it is two keystrokes and a word rather than
     * one chord.
     */
/** Global desk shortcuts (§15 keyboard-first). Mounted once in the authed layout. */
export function KeyboardProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const navigate = useNavigate();
  const { open } = usePalette();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The decision lives in `shouldOpenPalette` (above) so it can be mutated in isolation.
      if (shouldOpenPalette(e, e.target)) {
        e.preventDefault();
        open();
      } else if (e.key === "F4") {
        /**
         * ═══ FD-7 T7 / OWNER RULING 2026-09-03 — `F4`, NOT `Ctrl+N` ═══
         *
         * FD-3 bound `Ctrl+N` at the owner's request and this file said, in its own comment, that
         * Chrome does not deliver it: `Ctrl+N` is on the NON-OVERRIDABLE list, so in an ordinary tab
         * the keydown never reaches the page. **The chord the owner asked for has never worked in
         * the browser the hospital runs.** `Alt+N` was added beside it as the half that does work,
         * which left one door with two names, one of them dead.
         *
         * The 03-Sep ruling — "no shortcut should overlap chrome browser or any browser internal
         * shortcut keys" — settles it: `F4` is one of the five function keys no browser claims, it
         * reaches the page in every configuration, and it is one key rather than two.
         *
         * `Ctrl+N` and `Alt+N` are BOTH gone. A named test stops either growing back.
         */
        e.preventDefault();
        void navigate({ to: "/registration", search: { new: true } });
      } else if (e.key === "F7") {
        /**
         * `F7` — THE BOOK. §4d's own assignment, and the first of the parked navigation chords to
         * come back, on a key the browser leaves alone rather than on `Alt+P`. It is a destination
         * that exists today, which is why it is here and `F8`/`F9` are not (see below).
         */
        e.preventDefault();
        void navigate({ to: "/opd/appointments" });
      }
      /**
       * ═══ `F2` IS RESERVED, AND ITS ABSENCE FROM THIS CHAIN IS THE RESERVATION ═══
       *
       * `F2` used to be bound here to the same new-patient navigation as `Alt+N` — two chords for
       * one door, which the owner has now spent on something better: *"F2 will be dedicated to pull
       * agent."* The agent surface is not built (RC-6; `agent_ledger` is still a comment), so there
       * is nothing for `F2` to call yet.
       *
       * It is left UNBOUND rather than bound to a no-op with `preventDefault()`. A key that is
       * intercepted and then does nothing is indistinguishable, at a counter, from a key that is
       * broken; an unbound `F2` does what `F2` does in every browser — nothing — and the legend no
       * longer advertises it, so nobody is trained to press it before it means something.
       *
       * THE RESERVATION IS THIS COMMENT PLUS `keyboard.test.tsx`'s row asserting `F2` navigates
       * nowhere. A future task that wants a spare function key has to delete a named assertion to
       * take this one, which is the point.
       *
       * ═══ `F8` AND `F9` ARE NOT HERE, DELIBERATELY ═══
       *
       * §4d assigns `F8` take payment and `F9` reprint. Those are SEAT ACTIONS, not navigation, and
       * unlike `F4` and `F7` they are not a re-mapping of something that already works — "take
       * payment" as a keystroke does not exist on any screen yet. Binding a global key to an action
       * nothing implements would put a dead key on the legend, which is the precise mistake `F2` is
       * being kept off the legend to avoid. They belong to the task that builds the actions (T6).
       */
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, open]);
  return <>{children}</>;
}

/**
 * THE LEGEND IS THE ONLY PLACE A DESK LEARNS THESE, so it moves in the same edit as the map — and
 * FD-7 T7 moves it again, because FD-3's row is now teaching two chords the browser eats.
 *
 * It advertises exactly what the map binds and nothing else: `/` search, `F4` new patient, `F7` the
 * book, `Ctrl+⏎` confirm, `Esc` release. `Ctrl+K` and `Ctrl+N` are gone from both. `F2` stays off it
 * while it is reserved and unbound — advertising a key that does nothing is worse than not
 * advertising it, and that rule is why `F8`/`F9` are not here either.
 */
export function ShortcutLegend(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <footer className="no-print flex gap-4 border-t px-4 py-1 text-xs text-neutral-500">
      <span>{t("shortcuts.search")}</span>
      <span>{t("shortcuts.new")}</span>
      <span>{t("shortcuts.book")}</span>
      <span>{t("shortcuts.confirm")}</span>
      <span>{t("shortcuts.release")}</span>
    </footer>
  );
}
