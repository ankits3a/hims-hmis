import { useTranslation } from "react-i18next";

/**
 * TELE-CALL (owner 2026-10-09): *"use icon for telecall and not the text as we have limited screen
 * size."* One handset, drawn once, for every list an appointment appears in. It is an image with a
 * NAME ("Tele-call") — a screen reader and a test both find it — and it prints no word.
 */
const HANDSET = "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z";

/** The bare glyph, for a control that already says "Tele-call" in words beside it. */
export function TeleGlyph({ size = 15 }: { size?: number }): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={HANDSET} />
    </svg>
  );
}

/** The mark beside a tele-call appointment; renders nothing for any other appointment. */
export function TeleMark({ mode, size = 14 }: { mode: string | null | undefined; size?: number }): React.ReactElement | null {
  const { t } = useTranslation();
  if (mode !== "tele") return null;
  const name = t("opdAppt.tele");
  return (
    <svg
      role="img" aria-label={name} data-testid="tele-mark" viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
      style={{ color: "var(--blue)", flexShrink: 0, display: "inline-block", verticalAlign: "-2px" }}
    >
      <path d={HANDSET} />
    </svg>
  );
}
