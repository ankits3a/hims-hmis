import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import "./office-page.css";

/**
 * ═══ GAP-CLOSURE B5 — THE PIECES EVERY FOLDED PAGE OF THE OFFICE IS DRAWN WITH ═══
 *
 * B3 folded fourteen old screens into the office's header menu as they were: each still opened with
 * its own page heading, a register form above its list and, on two of them, filter tabs. The owner-
 * approved Menu artboard (`docs/design/2026-09-28-pharmacy-office/Menu.dc.html`) says what a page
 * inside the office is instead: "One list, no filter tabs … A form to add something opens as a sheet
 * from a key (N new), never as a form above the list. The same paper-and-pine look as the desk."
 *
 * These are the shared parts of that sentence, so each page says it the same way: the heading and its
 * one-line lead (the look of the rebuilt Cold chain, ADR and Returns pages), the "New … N" button and
 * its key, and the list box the rows sit in (`office-page.css`, Paper & Pine tokens, scoped to
 * `.pof-legacy`). The heading is the page's `<h1>` — the office's header carries the brand, not a
 * heading — drawn at the rebuilt pages' size.
 */
export function OfficeHead({ title, lead, children }: {
  title: string; lead?: React.ReactNode; children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="ofp-head">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        {lead !== undefined && lead !== null && <p className="max-w-3xl text-sm text-muted-foreground">{lead}</p>}
      </div>
      {children !== undefined && <div className="ofp-acts">{children}</div>}
    </div>
  );
}

/** The page's one "add" act, with its key. The keycap is hidden from the accessible name. */
export function NewButton({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }): React.ReactElement {
  return (
    <Button type="button" onClick={onClick} data-testid={testId}>
      {label} <kbd aria-hidden="true" className="ofp-kb">N</kbd>
    </Button>
  );
}

/**
 * `N` opens the page's "new" sheet — not while the person is typing, not with a modifier held, and
 * not while a sheet is already open (the office's own keys stand aside the same way).
 */
export function useNewKey(onNew: (() => void) | null): void {
  const ref = useRef(onNew);
  useEffect(() => { ref.current = onNew; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (ref.current === null || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== "n" && e.key !== "N") return;
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (document.querySelector("[role=dialog]") !== null) return;
      e.preventDefault();
      ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** A form field's look inside the office: the rebuilt pages' 36 px control. */
export const fieldCls = "h-9 w-full rounded-md border bg-background px-2 text-sm";
export const labelCls = "flex min-w-0 flex-col gap-1 text-sm";
