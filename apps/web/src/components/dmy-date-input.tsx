import { useEffect, useState } from "react";
import type React from "react";

/**
 * ═══ UX-AUDIT 2026-09-29 · BOARD — A DATE TYPED IN INDIAN ORDER ═══
 *
 * `<input type="date">` renders in the BROWSER's locale, and the counter machines run en-US: 12 March
 * showed as "03/12/1955", which an Indian clerk reads as 3 December (board finding 5). No shared
 * date field existed (Desk One's registration also uses the native control), so this is the one:
 * the clerk reads and types DD-MM-YYYY (`-`, `/` or `.` between the parts), and the form receives the
 * ISO calendar date `YYYY-MM-DD` the API takes — or the raw text while it is not yet a real date, so
 * a form validator can refuse it rather than a half-typed date silently becoming a different one.
 */
export function isoToDmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m === null ? iso : `${m[3]}-${m[2]}-${m[1]}`;
}

/** DD-MM-YYYY (or D/M/YYYY, D.M.YYYY) → `YYYY-MM-DD` when it names a real calendar day; otherwise null. */
export function dmyToIso(text: string): string | null {
  const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s*$/.exec(text);
  if (m === null) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y)}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function DmyDateInput({
  value, onChange, id, readOnly, className, style, ...rest
}: {
  /** `YYYY-MM-DD`, or "" for none. */
  value: string;
  /** The ISO date when the text is a real day, "" when cleared, else the raw text (invalid). */
  onChange: (next: string) => void;
  id?: string;
  readOnly?: boolean;
  className?: string;
  style?: React.CSSProperties;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">): React.ReactElement {
  const [text, setText] = useState(() => isoToDmy(value));
  // Follow the value when it changes from outside (a form reset), not while the clerk is typing it.
  useEffect(() => {
    if (dmyToIso(text) !== value && !(value === "" && text.trim() === "")) setText(isoToDmy(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an outside change of `value` re-seeds the text
  }, [value]);
  return (
    <input
      {...rest}
      id={id}
      className={className}
      style={style}
      type="text"
      inputMode="numeric"
      placeholder="DD-MM-YYYY"
      autoComplete="off"
      readOnly={readOnly}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        onChange(next.trim() === "" ? "" : dmyToIso(next) ?? next);
      }}
    />
  );
}
