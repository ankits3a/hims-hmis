import type React from "react";

/**
 * ═══ FD-25 T0 — THE FRONT DESK'S FIELD PRIMITIVES, IN ONE PLACE ═══
 *
 * `Field`, `Picker` and `Fold` were written inside `screens/desk-one/stages.tsx` when Desk One was
 * the only screen that had a form. Three seats now have forms — registration, appointment and
 * billing — and the artboards draw the same three controls on all of them, because they are one
 * design language and not three.
 *
 * They are lifted rather than copied for the reason `desk-one.css` states in its own header: ONE
 * DEFINITION. A copied `Fold` is a fold whose closed body stays in the tab order six months from
 * now on one screen and not the other, and nobody finds out until a clerk tabs into a field that is
 * not on the screen.
 *
 * These are presentational and hold no state of their own. They depend on the `.d1`/`.pp`
 * primitives — `.in`, `.tag`, `.box`, `.mo` — so a screen that mounts them must wear one of those
 * scopes; `components/paper-screen.tsx` is the supported way to do that.
 */

export function Field(
  { label, value, onChange, mono, placeholder, type, testId, width, autoFocus, inputMode, onKeyDown, id }: {
    label: string; value: string; onChange: (v: string) => void;
    mono?: boolean; placeholder?: string; type?: string; testId: string; width?: number;
    autoFocus?: boolean; inputMode?: "text" | "numeric" | "tel"; id?: string;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  },
): React.ReactElement {
  return (
    <div style={width === undefined ? undefined : { width }}>
      {/*
        A REAL <label htmlFor> when the caller gives an id. `.tag` is a visual class and carries no
        association of its own — a screen reader gets nothing from a styled div, and neither does
        `getByLabelText`. The counter's existing fields pass a testId and no id, so they are
        unchanged; new screens pass both.
      */}
      {id === undefined
        ? <div className="tag" style={{ marginBottom: 5 }}>{label}</div>
        : <label className="tag" htmlFor={id} style={{ display: "block", marginBottom: 5 }}>{label}</label>}
      <input
        {...(id === undefined ? {} : { id })}
        className={mono === true ? "in mo" : "in"}
        data-testid={testId}
        type={type ?? "text"}
        {...(inputMode === undefined ? {} : { inputMode })}
        {...(autoFocus === true ? { autoFocus: true } : {})}
        placeholder={placeholder}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        {...(onKeyDown === undefined ? {} : { onKeyDown })}
      />
    </div>
  );
}

export function Picker(
  { label, value, onChange, options, testId, id }: {
    label: string; value: string; onChange: (v: string) => void;
    options: readonly (readonly [string, string])[]; testId: string; id?: string;
  },
): React.ReactElement {
  return (
    <div>
      {id === undefined
        ? <div className="tag" style={{ marginBottom: 5 }}>{label}</div>
        : <label className="tag" htmlFor={id} style={{ display: "block", marginBottom: 5 }}>{label}</label>}
      <select
        {...(id === undefined ? {} : { id })}
        className="in"
        data-testid={testId}
        value={value}
        onChange={(e) => { onChange(e.target.value); }}
        style={{ height: 40 }}
      >
        <option value="">—</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
}

/**
 * A FOLD, AND WHY EVERY EXTRA FIELD IS BEHIND ONE.
 *
 * The two demands on a registration screen are real and opposite: a queue of walk-ins needs a name
 * and a sex, and a planned admission needs the whole record. Answering only the second is how a
 * registration screen becomes the thing clerks route around. So the fast path is four fields and
 * untouched, and everything else opens on request — closed by default, and NEVER IN THE TAB ORDER
 * UNTIL IT IS OPEN, which is the Keymap's own law: "Tab must never stop at a field that is not on
 * screen, and it must never skip one that is." A closed fold renders no body at all, which is the
 * only implementation of that rule that cannot drift out of true.
 */
export function Fold(
  { title, hint, open, onToggle, testId, children, accent, state, stateTone }: {
    title: string; hint?: string; open: boolean; onToggle: () => void;
    testId: string; children: React.ReactNode; accent?: boolean;
    /** The right-hand pill: "not linked", "none on file", "ordinary record". */
    state?: string;
    stateTone?: "plain" | "on" | "gd";
  },
): React.ReactElement {
  return (
    <div
      className="box"
      style={{
        marginTop: 9, overflow: "hidden",
        borderColor: accent === true ? "var(--gold-line)" : undefined,
        background: accent === true ? "var(--gold-soft)" : undefined,
      }}
    >
      <button
        type="button"
        data-testid={testId}
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 9, width: "100%",
          padding: "9px 13px", background: "none", border: 0, textAlign: "left", cursor: "pointer",
        }}
      >
        <span className="mo" style={{ fontSize: 11, color: "var(--dim)", width: 10 }}>{open ? "−" : "+"}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{title}</span>
        {hint === undefined ? null : (
          <span style={{ fontSize: 11, color: "var(--dim)" }}>{hint}</span>
        )}
        {state === undefined ? null : (
          <span
            className={`pill${stateTone === "on" ? " on" : stateTone === "gd" ? " gd" : ""}`}
            style={{ marginLeft: "auto" }}
          >
            {state}
          </span>
        )}
      </button>
      {open ? (
        <div style={{ padding: "3px 13px 13px", borderTop: "1px solid var(--line2)" }}>{children}</div>
      ) : null}
    </div>
  );
}

export const GRID2 = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 13 } as const;
export const GRID3 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 11, marginTop: 11 } as const;
export const GRID4 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 11, marginTop: 11 } as const;

/**
 * The artboard's 40px-tall segmented choice — Female/Male/Other, Father/Mother/Other. It is three
 * buttons rather than a `<select>` because at a counter the answer is always visible and one press
 * away, and because the artboard draws it that way on every seat.
 *
 * `role="radiogroup"` and `aria-checked` are not decoration: a segmented control built from bare
 * buttons is announced as three unrelated buttons, and a clerk on a screen reader cannot tell which
 * one is chosen. The visual state is `.pill.on`; the semantic state is here.
 */
export function Segmented<T extends string>(
  { label, value, onChange, options, testId, id }: {
    label: string; value: T | ""; onChange: (v: T) => void;
    options: readonly (readonly [T, string])[]; testId: string; id?: string;
  },
): React.ReactElement {
  return (
    <div>
      <div className="tag" style={{ marginBottom: 5 }} id={id}>{label}</div>
      <div role="radiogroup" aria-labelledby={id} style={{ display: "flex", gap: 7 }}>
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            data-testid={`${testId}-${v}`}
            onClick={() => { onChange(v); }}
            className={value === v ? "pill on" : "pill"}
            style={{ height: 40, flexGrow: 1, justifyContent: "center", fontSize: 12.5 }}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The guardian's four authority switches. A TOGGLE, not a radio — they are independent, and the
 * artboard's footnote says so in as many words: "Consent is not the same as billing — the two are
 * separate switches on purpose."
 */
export function TogglePills<K extends string>(
  { label, value, onChange, options, testId }: {
    label: string;
    value: Readonly<Record<K, boolean>>;
    onChange: (key: K, next: boolean) => void;
    options: readonly (readonly [K, string])[];
    testId: string;
  },
): React.ReactElement {
  return (
    <div>
      <div className="tag" style={{ marginBottom: 5 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center", minHeight: 40 }}>
        {options.map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="switch"
            aria-checked={value[k]}
            data-testid={`${testId}-${k}`}
            onClick={() => { onChange(k, !value[k]); }}
            className={value[k] ? "pill on" : "pill"}
          >
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — TABS, WITH THE SEMANTICS THAT MAKE THEM TABS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `Segmented` above looks almost identical and is the wrong component here: it publishes
 * `role="radiogroup"` / `role="radio"`, which says "pick one of these values". A tab strip says
 * something different — "this is which of several panels you are looking at" — and a screen reader
 * announces the two differently, as it should.
 *
 * The difference is not academic on the consult screen. Note, Prescription and History are three
 * views of one patient, and the doctor's suite drives them with `getByRole("tab", …)` because that
 * is what a doctor's screen reader will call them too.
 *
 * ARROW KEYS move between tabs, which is the ARIA tab pattern and is also simply how anybody who
 * types expects a tab strip to behave. Tab itself moves OUT of the strip and into the panel — that
 * is the point of the roving tabindex, and it is why a doctor tabbing through a prescription does
 * not have to walk past three headings first.
 */
export function TabStrip<T extends string>(
  { label, value, onChange, options, testId }: {
    label: string; value: T; onChange: (v: T) => void;
    options: readonly (readonly [T, string])[]; testId?: string;
  },
): React.ReactElement {
  const move = (delta: number): void => {
    const i = options.findIndex(([v]) => v === value);
    const next = options[(i + delta + options.length) % options.length];
    if (next !== undefined) onChange(next[0]);
  };
  return (
    <div
      role="tablist" aria-label={label}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      style={{ display: "flex", gap: 6, borderBottom: "1px solid var(--line)", paddingBottom: 9 }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
      }}
    >
      {options.map(([v, l]) => (
        <button
          key={v} type="button" role="tab" id={`tab-${v}`} aria-selected={value === v} aria-controls={`tabpanel-${v}`}
          /* The roving tabindex: one stop for the whole strip, not one per tab. */
          tabIndex={value === v ? 0 : -1}
          className={value === v ? "pill on" : "pill"}
          style={{ fontSize: 12.5 }}
          onClick={() => { onChange(v); }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * FD-25 — THE TABLE, WHICH IS A REAL `<table>` AND NOT A GRID OF DIVS
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `@/components/ui/table` is five wrappers around the five HTML elements, and that is what makes it
 * safe to replace: the semantics that matter — `role="table"`, `role="row"`, header association —
 * come from the elements themselves, not from the wrapper. FD-23's commit message records what
 * happens when a restyle forgets that: `role="table"` and `role="tab"` were dropped on the first
 * pass and only the existing tests noticed.
 *
 * So these are the same five elements with the design system's rules on them, in one definition
 * rather than repeated inline across four tabs. `DeskTable` wraps itself in an `overflow-x: auto`
 * box: an admin table is the widest thing on any of these screens, and a page body that scrolls
 * sideways is a page that has lost its left edge.
 */
export function DeskTable({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): React.ReactElement {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, ...style }}>{children}</table>
    </div>
  );
}
export function DeskTHead({ children }: { children: React.ReactNode }): React.ReactElement {
  return <thead>{children}</thead>;
}
export function DeskTBody({ children }: { children: React.ReactNode }): React.ReactElement {
  return <tbody>{children}</tbody>;
}
export function DeskTR({ children }: { children: React.ReactNode }): React.ReactElement {
  return <tr style={{ verticalAlign: "top" }}>{children}</tr>;
}
export function DeskTH({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <th className="tag" style={{ textAlign: "left", padding: "0 14px 7px 0", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap" }}>
      {children}
    </th>
  );
}
export function DeskTD({ children, className, style }: { children?: React.ReactNode; className?: string; style?: React.CSSProperties }): React.ReactElement {
  return (
    <td className={className} style={{ padding: "8px 14px 8px 0", borderBottom: "1px solid var(--line)", ...style }}>
      {children}
    </td>
  );
}
