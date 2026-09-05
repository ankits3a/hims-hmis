import type React from "react";
import { useTranslation } from "react-i18next";
import { slotClock } from "../lib/appointment-view";
import type { WireSlot } from "../lib/opd-api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE SLOT BOARD, SHARED BY DESK ONE AND THE APPOINTMENT SEAT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ═══ THE RULE THIS COMPONENT EXISTS TO KEEP ═══
 *
 * FREE, TAKEN AND YOURS ARE THREE DIFFERENT THINGS AND MUST LOOK LIKE THREE DIFFERENT THINGS.
 * Desk One's own comment states the failure: *"a greyed slot that might be either is how a desk
 * double-books"*, and before FD-22 an empty grid meant both "all taken, try the afternoon" and
 * "this doctor is not sitting that day" — two answers a clerk must be able to tell apart while a
 * patient waits.
 *
 * The signed-off artboard sharpens it once more, and the change is not decorative: TAKEN carries a
 * DASHED border. Free and taken differed only in fill, so the distinction lived entirely in a
 * colour difference of one wash step — invisible on a dim counter monitor, and invisible to a
 * clerk with any red-green deficiency. Dashed is a difference in SHAPE, which survives both.
 *
 * ═══ A CLICK SELECTS. IT DOES NOT BOOK. ═══
 *
 * A booking is a promise about a time and is made deliberately or not at all, so the grid holds a
 * selection and a separate button commits it. That is FD-22's ruling and it is why `onPick` is the
 * only thing this component does — it has no idea what booking means.
 */

export function SlotLegend(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", gap: 11, marginLeft: "auto" }}>
      {([
        ["free", "var(--card)", "var(--line)", "solid"],
        ["taken", "var(--wash)", "var(--line)", "dashed"],
        ["yours", "var(--green)", "var(--green)", "solid"],
      ] as const).map(([key, bg, border, style]) => (
        <span key={key} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: "var(--dim)" }}>
          <span style={{ width: 11, height: 11, borderRadius: 3, background: bg, border: `1px ${style} ${border}` }} />
          {t(`slotBoard.${key}`)}
        </span>
      ))}
    </div>
  );
}

export function SlotGrid(
  { slots, picked, onPick, disabled }: {
    slots: readonly WireSlot[];
    /** The ISO start of the selected slot — the artboard's "yours". */
    picked: string | null;
    onPick: (start: string) => void;
    disabled?: boolean;
  },
): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {slots.map((slot) => {
        const unavailable = slot.booked || slot.past;
        const isPicked = picked === slot.start;
        return (
          <button
            key={slot.start}
            type="button"
            data-testid={`slot-${unavailable ? "taken" : isPicked ? "picked" : "free"}`}
            /*
              `aria-pressed` and a real title, because the three states are carried in colour and
              border for a sighted clerk and in NOTHING AT ALL otherwise. A grid of 24 unlabelled
              times is unusable with a screen reader, and "taken" is the state whose absence causes
              the double-booking this component exists to prevent.
            */
            aria-pressed={isPicked}
            title={slot.past ? t("slotBoard.past") : slot.booked ? t("slotBoard.taken") : t("slotBoard.free")}
            className="mo"
            style={{
              height: 30, fontSize: 11.5, padding: "0 10px", borderRadius: 6,
              border: `1px ${slot.booked && !isPicked ? "dashed" : "solid"} ${isPicked ? "var(--green)" : "var(--line)"}`,
              background: isPicked ? "var(--green)" : unavailable ? "var(--wash)" : "var(--card)",
              color: isPicked ? "#fff" : unavailable ? "var(--faint)" : "var(--ink)",
              fontWeight: isPicked ? 700 : 400,
              textDecoration: slot.past ? "line-through" : undefined,
              cursor: unavailable ? "not-allowed" : "pointer",
            }}
            disabled={unavailable || disabled === true}
            onClick={() => { onPick(slot.start); }}
          >
            {slotClock(slot.start)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * WHY THE GRID IS EMPTY, SAID IN WORDS. The two reasons are completely different actions for the
 * clerk — try the afternoon, or try another doctor — and an empty box says neither.
 */
export function SlotBoardEmptyState(
  { loading, total, free }: { loading: boolean; total: number; free: number },
): React.ReactElement | null {
  const { t } = useTranslation();
  if (loading) return <span style={{ color: "var(--faint)", fontSize: 12 }}>{t("slotBoard.reading")}</span>;
  if (total === 0) {
    return (
      <span data-testid="no-session" style={{ color: "var(--dim)", fontSize: 12 }}>
        {t("slotBoard.noSession")}
      </span>
    );
  }
  if (free === 0) {
    return (
      <span data-testid="day-full" style={{ color: "var(--gold)", fontSize: 12 }}>
        {t("slotBoard.dayFull")}
      </span>
    );
  }
  return null;
}
