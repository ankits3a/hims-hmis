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
      } else if (e.key === "F2") {
        e.preventDefault();
        // ?new=true (read by RegistrationDesk) opens the new-patient form directly, matching the
        // "F2 New patient" legend — navigating to the bare route was a no-op when already there.
        void navigate({ to: "/registration", search: { new: true } });
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, open, inHand]);
  return <>{children}</>;
}

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
