import { useEffect, useRef } from "react";
import type React from "react";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE MODAL, ON THE DESIGN SYSTEM, BECAUSE `@/components/ui/dialog` IS NOT ALLOWED HERE
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The consult screen mounts two dialogs: the allergy / interaction / duplicate override, and the
 * printed e-Rx. Both were shadcn, and the definition of done for an FD-25 screen forbids a single
 * `@/components/ui/*` import — not out of purity but because a half-converted screen is worse than
 * an unconverted one (commit 9af37bf: "the two type systems sit in one column and the seam is
 * exactly where the eye goes").
 *
 * ═══ WHAT THIS KEEPS FROM THE THING IT REPLACES ═══
 *
 * A dialog is not a styled box; it is a set of promises to somebody who cannot use a mouse. Those
 * promises are kept here explicitly rather than inherited:
 *
 *   · `role="dialog"` + `aria-modal` + `aria-labelledby` pointing at the real title element.
 *   · ESCAPE CLOSES. On a clinical screen this matters more than usual: the override dialog opens
 *     because a prescription was refused, and a doctor who cannot dismiss it cannot get back to the
 *     line they were fixing.
 *   · FOCUS MOVES IN on open — to the first field, or the panel itself when it has none — so the
 *     next keystroke goes where the reader is looking, and a screen reader announces the dialog
 *     rather than continuing to read the page behind it.
 *   · FOCUS RETURNS on close, to whatever had it before. Losing focus to `<body>` after an override
 *     is what makes a keyboard user re-tab through an entire prescription form.
 *
 * The one thing deliberately NOT copied is a focus TRAP. A trap needs a full tab-cycle implement-
 * ation to be correct, and a half-built one that catches Tab but drops Shift+Tab is worse than
 * none: it locks a keyboard user inside a panel they cannot leave. Escape works, focus is placed,
 * and the panel sits above an inert overlay.
 */
export function DeskModal({
  open,
  onClose,
  title,
  titleId = "desk-modal-title",
  children,
  width = 560,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleId?: string;
  children: React.ReactNode;
  width?: number;
  testId?: string;
}): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  /**
   * ═══ CLOSE PASS 1, CRITICAL — `onClose` MUST NOT BE IN THE FOCUS EFFECT'S DEPS ═══
   *
   * It was, and every call site passes an inline arrow, so the effect re-ran on EVERY parent render.
   * On the consult screen the override reasons are state in the parent, so each keystroke inside the
   * dialog re-rendered it, ran the cleanup (focus back to the opener) and then the setup (focus to
   * the dialog's FIRST field).
   *
   * With two hits — one interaction and one duplicate, which is an ordinary refusal — a doctor
   * typing into the second reason box had every character after the first land in the FIRST box.
   * `confirmOverride` then refuses for a missing reason. The multi-hit override was uncompletable
   * except one click per character, on the screen where the refusal is the entire point.
   *
   * The handler is held in a ref so the Escape listener always calls the CURRENT one while the
   * effect itself depends only on `open` — which is the only thing that should move focus.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    /* The first field if there is one — an override dialog exists to be typed into. */
    const first = panel?.querySelector<HTMLElement>("input, textarea, select, button");
    (first ?? panel)?.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      /*
        ═══ CLOSE PASS 1 — THE DIALOG'S ESCAPE IS THE DIALOG'S ALONE ═══

        `stopImmediatePropagation`, not merely `preventDefault`. The consult screen registers its own
        window Escape handler for a two-stage "once back to the queue, twice release the patient",
        and both listeners are bubble-phase on `window`, so one press was reaching both: the dialog
        closed AND stage two was armed, invisibly. The doctor's next Escape — an entirely ordinary
        second press when a modal seems not to have gone — released the patient and reset the
        prescription form they were in the middle of fixing.

        A modal owns the Escape key while it is open. That is what being modal means.
      */
      e.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnTo.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 60, display: "flex", alignItems: "flex-start",
        justifyContent: "center", padding: "6vh 16px", background: "rgba(19, 36, 32, .38)",
      }}
      /* A click on the ground closes; a click on the panel must not bubble into it. */
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="box"
        {...(testId === undefined ? {} : { "data-testid": testId })}
        style={{ width: "100%", maxWidth: width, maxHeight: "88vh", overflowY: "auto", padding: "18px 20px", boxShadow: "0 18px 48px rgba(19,36,32,.22)" }}
      >
        <h2 id={titleId} style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 700 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
