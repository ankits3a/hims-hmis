import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { usePalette } from "../components/command-palette";
import { usePatientInHand } from "./patient-in-hand";

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/**
 * PLAN 11h T8 / DD7 — the palette-open DECISION, extracted so it can be asserted and mutated on
 * its own rather than only through a mounted router.
 *
 * The guard is the whole of it: `/` and `Ctrl+K` open the palette from anywhere EXCEPT while
 * somebody is typing, where a `/` is a character in a consultation note and `Ctrl+K` may belong to
 * the field. Dropping that check is the obvious wrong implementation, and it is silent — the
 * palette opens, the keystroke vanishes from the note, and the clinician retypes it.
 */
export function shouldOpenPalette(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">,
  target: EventTarget | null,
): boolean {
  const wants =
    (e.key === "/" && !e.ctrlKey && !e.metaKey) ||
    ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey));
  return wants && !isTypingTarget(target);
}

/** Global desk shortcuts (§15 keyboard-first). Mounted once in the authed layout. */
export function KeyboardProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const navigate = useNavigate();
  const { open } = usePalette();
  const { inHand } = usePatientInHand();
  useEffect(() => {
    /**
     * `/opd/vitals` and `/opd/consult` are registered by later tasks, but their shortcuts live here
     * (this is the only task that owns keyboard.tsx). The router's generated path union therefore
     * does not know them yet, so those two — and only those two — are navigated as plain strings.
     * The navigation itself is correct at runtime; it is the compile-time union that is behind.
     */
    const goUnregistered = (to: string): void => {
      void navigate({ to } as unknown as Parameters<typeof navigate>[0]);
    };
    const onKey = (e: KeyboardEvent): void => {
      // The decision lives in `shouldOpenPalette` (above) so it can be mutated in isolation.
      if (shouldOpenPalette(e, e.target)) {
        e.preventDefault();
        open();
      } else if (e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        void navigate({ to: "/merge" });
      } else if (e.altKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        void navigate({ to: "/approvals" });
      } else if (e.altKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        /**
         * PLAN 07b T2 — A SHORTCUT IS AN ACTION ON THE PATIENT IN HAND, NOT A DESTINATION.
         *
         * `Alt+B` went to a BARE `/billing`, so a clerk mid-walk-in landed on an empty counter and
         * re-found the patient they were already serving. With a visit in hand it now carries the
         * encounter, which is the same rail the token slip uses. With nobody in hand the bare route
         * is still correct — that is a cashier opening the counter, not a handoff.
         */
        void navigate(
          inHand?.encounterId != null
            ? { to: "/billing", search: { encounterId: inHand.encounterId } }
            : { to: "/billing" },
        );
      } else if (e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        void navigate({ to: "/opd/desk" });
      } else if (e.altKey && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        goUnregistered("/opd/vitals");
      } else if (e.altKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        goUnregistered("/opd/consult");
      } else if (e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        void navigate({ to: "/opd/appointments" });
      } else if ((e.key === "n" || e.key === "N") && (e.altKey || e.ctrlKey || e.metaKey)) {
        /**
         * ═══ FD-3 / OWNER RULING 2026-09-02 — `Ctrl+N` IS THE NEW-PATIENT CHORD, AND `Alt+N`
         *     STAYS BESIDE IT BECAUSE THE BROWSER MAY EAT THE FIRST ONE ═══
         *
         * The owner ruled: *"CTRL + N should replace F2. F2 will be dedicated to pull agent."* So
         * `Ctrl+N` is bound here, first-class, and `F2` no longer navigates anywhere (see the
         * reservation note below).
         *
         * ═══ WHY `Alt+N` IS STILL IN THIS CONDITION, AND WHY THAT IS NOT HEDGING ═══
         *
         * `Ctrl+N` is on Chrome's NON-OVERRIDABLE shortcut list: in an ordinary tab the browser
         * opens a new window and the `keydown` never reaches the page, so `preventDefault()` has
         * nothing to prevent. Firefox behaves the same. This is not a preference and it is not
         * fixable in application code — RC-3 shipped a `Ctrl+N` handler once and its close review
         * found it unreachable in the browser this hospital actually runs, which is why `Alt+N` was
         * ruled in as the replacement.
         *
         * `Ctrl+N` DOES reach the page in two configurations, and they are the ones a hospital
         * counter should be in anyway: **an installed PWA** and **Chrome launched with `--app=` or
         * in kiosk mode**. Both strip the browser chrome that owns the chord. So the owner's ruling
         * is honoured exactly as given for the deployment they are heading towards, and `Alt+N` is
         * the guarantee that a clerk on a plain tab is never left with NO working chord at all —
         * which is what binding `Ctrl+N` alone would have produced on the desks that exist today.
         *
         * One condition, three modifiers: `Cmd+N` is included for the same reason `shouldOpenPalette`
         * accepts `metaKey` — a Mac at the administrator's desk should not be a different product.
         */
        e.preventDefault();
        void navigate({ to: "/registration", search: { new: true } });
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
       */
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, open, inHand]);
  return <>{children}</>;
}

/**
 * FD-3 — THE LEGEND IS THE ONLY PLACE A DESK LEARNS THESE, so it moves in the same edit as the map.
 *
 * `shortcuts.search` now names `Ctrl+K` beside `/`. Both have opened the universal search since
 * 11h — `shouldOpenPalette` accepts either — and the legend advertised only the slash, so the chord
 * the owner asked for was already there and simply invisible. `shortcuts.new` names `Ctrl+N` with
 * `Alt+N` after it, in that order, because the first is the ruling and the second is the one that
 * survives a plain Chrome tab. `F2` is gone from the row: it is reserved for the agent and
 * advertising a key that does nothing is worse than not advertising it.
 */
export function ShortcutLegend(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <footer className="no-print flex gap-4 border-t px-4 py-1 text-xs text-neutral-500">
      <span>{t("shortcuts.search")}</span>
      <span>{t("shortcuts.new")}</span>
      <span>{t("shortcuts.merge")}</span>
      <span>{t("shortcuts.approvals")}</span>
      <span>{t("shortcuts.opdDesk")}</span>
      <span>{t("shortcuts.opdVitals")}</span>
      <span>{t("shortcuts.opdConsult")}</span>
      <span>{t("shortcuts.opdAppointments")}</span>
      <span>{t("shortcuts.billing")}</span>
    </footer>
  );
}
