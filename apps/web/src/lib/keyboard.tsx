import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";

function isTypingTarget(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** Global desk shortcuts (§15 keyboard-first). Mounted once in the authed layout. */
export function KeyboardProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const navigate = useNavigate();
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
      if (e.key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-search-input]")?.focus();
      } else if (e.key === "F2") {
        e.preventDefault();
        void navigate({ to: "/registration" });
      } else if (e.altKey && (e.key === "m" || e.key === "M")) {
        e.preventDefault();
        void navigate({ to: "/merge" });
      } else if (e.altKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        void navigate({ to: "/approvals" });
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
  }, [navigate]);
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
    </footer>
  );
}
