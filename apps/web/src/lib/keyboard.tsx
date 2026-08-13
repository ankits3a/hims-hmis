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
    </footer>
  );
}
