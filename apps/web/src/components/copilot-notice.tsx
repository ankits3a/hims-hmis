import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { copilotNoticeState, dismissNotice, subscribeCopilotNotice } from "../lib/copilot-notice";

/** The one-line staff notice, drawn once at the root. The store and its reasoning: `lib/copilot-notice.ts`. */
export function CopilotNoticeHost(): React.ReactElement | null {
  const now = useSyncExternalStore(subscribeCopilotNotice, copilotNoticeState, copilotNoticeState);
  const { t } = useTranslation();
  if (now !== "showing") return null;
  return (
    <div
      role="alertdialog"
      aria-label={t("copilot.notice.text")}
      data-testid="copilot-notice"
      style={{
        position: "fixed", left: 16, right: 16, bottom: 16, zIndex: 1000, maxWidth: 560, margin: "0 auto",
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderRadius: 12,
        background: "var(--card, #fff)", color: "var(--ink, #132420)", border: "1px solid var(--line, #dfe7e1)",
        boxShadow: "0 6px 24px rgba(0,0,0,.18)", fontSize: 14, lineHeight: "20px",
      }}
    >
      <span style={{ flex: 1 }}>{t("copilot.notice.text")}</span>
      <button
        type="button"
        data-testid="copilot-notice-ok"
        onClick={dismissNotice}
        style={{
          font: "inherit", fontWeight: 600, minHeight: 36, padding: "0 16px", borderRadius: 9, cursor: "pointer",
          background: "var(--green, #0e6b4e)", border: "1px solid var(--green, #0e6b4e)", color: "#fff",
        }}
      >
        {t("copilot.notice.ok")}
      </button>
    </div>
  );
}
