import { useEffect, useRef, useState } from "react";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE TAG FIELD — WHAT THE DOCTOR TYPED, KEPT EXACTLY, WITH HELP OFFERED BESIDE IT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: *"if doctor start writing 'fev' and auto suggestion will appear as 'fever'.
 * The doctor has to either press forward button to complete the word or select from the auto
 * suggested tags … If doctor types 'fever' and presses enter, 'fever' will be added a tag EXACTLY
 * AS THE DOCTOR WROTE. The doctor could simply click on 'x' cross to delete the tag."*
 *
 * ═══ THE RULE THAT DECIDES EVERY KEYSTROKE HERE ═══
 *
 * **Enter commits the doctor's own text, never the suggestion.** A field that silently swaps
 * `fever with chills` for its nearest vocabulary entry is a field that edits a clinical record
 * behind the person signing it — and the day it guesses wrong, the note says something the doctor
 * did not write. So:
 *
 *   · `Enter`  — commits the raw input, verbatim, whatever the list is showing.
 *   · `→`      — accepts the ghost completion INTO the input (still not committed; the doctor can
 *                keep typing). Only ever a PREFIX remainder, so no letters appear behind the caret.
 *   · a tap    — commits that suggestion, because tapping it IS choosing it.
 *   · `⌫`      — edits the draft and ONLY the draft. It never takes back a committed tag, however
 *                long it is held; see the block on `onKeyDown` for the held-key failure that rule
 *                exists to prevent (owner, 2026-09-14).
 *
 * ═══ WHY A COMPONENT RATHER THAN A FIELD ═══
 *
 * Chief complaint is the first of four (diagnosis, advice and advised investigations follow, each
 * with a different suggester and some gated on the co-pilot being on). One implementation means
 * the keystroke contract above is the same in all four — a doctor learns `Enter` once.
 *
 * The VALUE stays a plain string on the wire and in `opd_encounters.chief_complaint`: tags are
 * joined with ", " and split back on load. Nothing downstream — the print, the e-Rx, the timeline,
 * the MRD coder's screen — learns a new shape, which is what makes this a field change and not a
 * schema one.
 */
/**
 * ═══ THE SEPARATOR IS A MIDDLE DOT, AND A COMMA WOULD HAVE BEEN A BUG ═══
 *
 * The first draft joined on ", " and a test caught what that costs on the very first realistic
 * complaint: *"fever since 3 days, worse at night"* came back as TWO tags, one of them the fragment
 * "worse at night". The rule this field exists to keep is "exactly as the doctor wrote", and a
 * doctor writes commas.
 *
 * ` · ` keeps every property that mattered: the stored value is still one readable string, so the
 * printed slip, the timeline, the e-Rx and the MRD coder's screen are untouched — and it is a
 * character a doctor does not type, so a tag can contain anything else at all. A complaint written
 * before this field existed splits into exactly one tag holding its whole prose, which is the
 * correct reading of an old note rather than a migration.
 */
export const TAG_SEPARATOR = " · ";

export function splitTags(value: string): string[] {
  return value.split(TAG_SEPARATOR).map((t) => t.trim()).filter((t) => t !== "");
}
export function joinTags(tags: string[]): string {
  return tags.join(TAG_SEPARATOR);
}

export type TagSuggestion = { term: string; hint?: string | null };

export function TagField({
  id, label, value, onChange, suggest, placeholder, disabled = false, hint, adornTag,
}: {
  id: string;
  label: string;
  /** The stored string. The component owns no value of its own — it edits this one. */
  value: string;
  onChange: (next: string) => void;
  /**
   * Returns what to offer for the current input, and the ghost remainder when a prefix match
   * exists. Returning `{items: [], ghost: null}` is a complete answer — a field with no suggester
   * (or a suggester the doctor has switched off) still takes tags, which is the point.
   */
  suggest: (q: string) => Promise<{ items: TagSuggestion[]; ghost: string | null }>;
  placeholder?: string;
  disabled?: boolean;
  hint?: string | null;
  /**
   * Something the CALLER draws inside one tag, after its words — the diagnosis field's eye pills
   * (board "Ophthal"). The field stays a plain list of strings; what a tag means is the caller's.
   */
  adornTag?: (tagText: string, index: number) => React.ReactNode;
}): React.ReactElement {
  const tags = splitTags(value);
  const [draft, setDraft] = useState("");
  const [items, setItems] = useState<TagSuggestion[]>([]);
  const [ghost, setGhost] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /* The draft the last response was for — a slow answer to an old prefix must not overwrite a new one. */
  const asked = useRef("");

  useEffect(() => {
    const q = draft.trim();
    asked.current = q;
    if (disabled || q.length < 2) { setItems([]); setGhost(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void suggest(q)
        .then((r) => {
          if (!live || asked.current !== q) return;
          setItems(r.items);
          setGhost(r.ghost);
        })
        .catch(() => { if (live) { setItems([]); setGhost(null); } });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [draft, disabled]);

  const commit = (text: string): void => {
    const t = text.trim();
    if (t === "") return;
    // A repeat is a no-op rather than a duplicate chip; comparison folds case, the STORED tag does not.
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) onChange(joinTags([...tags, t]));
    setDraft("");
    setItems([]);
    setGhost(null);
  };

  const remove = (i: number): void => {
    onChange(joinTags(tags.filter((_, n) => n !== i)));
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter") {
      /* The doctor's own words, verbatim. The suggestion list is not consulted — see the header. */
      e.preventDefault();
      commit(draft);
      return;
    }
    if (e.key === "ArrowRight" && ghost !== null) {
      /* Only at the very end of the input: mid-string, `→` is a cursor move and must stay one. */
      const el = e.currentTarget;
      if (el.selectionStart === draft.length && el.selectionEnd === draft.length) {
        e.preventDefault();
        setDraft(draft + ghost);
        setGhost(null);
      }
      return;
    }
    /*
      ═══ THERE IS DELIBERATELY NO `Backspace` BRANCH HERE ═══

      There was one, and it removed the last tag on an empty input — "the standard chip gesture",
      borrowed from the way Gmail treats recipient chips. Owner, 2026-09-14: *"if the backspace is
      pressed for little longer the earlier chip also gets removed. This is not good. Because of
      this doctor has to retype again and again."*

      THE MECHANISM, because it is the general lesson: there was no `e.repeat` guard. One held key
      deleted the draft character by character and then — with no pause and no boundary — carried
      straight on into the committed tags at the keyboard's repeat rate, thirty a second. Deleting
      TEXT YOU ARE TYPING and deleting DATA YOU COMMITTED are different acts, and auto-repeat walked
      from one into the other without the doctor doing anything new.

      THE BORROWING WAS WRONG ON ITS OWN TERMS TOO. A recipient chip is `bob@x.com` and costs three
      seconds to retype. A chip here is *"fever since 3 days, worse at night"* — and on the
      diagnosis field it carries an ICD-10 code, so losing the chip loses `J06.9` and the doctor has
      to find it through the typeahead again. This field exists because the owner asked that the
      doctor *"not need to type much"*; a gesture that makes him retype defeats the field.

      A GUARD ON `e.repeat` WOULD HAVE FIXED THE HELD KEY AND NOT THE RULE. One deliberate press
      would still take back a committed phrase, and the doctor would still have to know that an
      empty input changes what Backspace means. So the rule has one meaning per gesture instead:
      **Enter commits, × removes.** Nothing on this field can destroy a committed tag by accident.

      Removal stays reachable without the mouse: each × is a real button sitting before the input in
      tab order, so Shift+Tab lands on the last one (`F5c`).
    */
  };

  return (
    <div>
      <label className="tag" style={{ display: "block", marginBottom: 5 }} htmlFor={id}>{label}</label>
      <div
        data-testid={`${id}-field`}
        onClick={() => inputRef.current?.focus()}
        className="in"
        style={{
          height: "auto", minHeight: 40, display: "flex", flexWrap: "wrap", alignItems: "center",
          gap: 5, padding: "5px 7px", cursor: "text",
        }}
      >
        {tags.map((tagText, i) => (
          <span key={`${tagText}-${String(i)}`} data-testid={`${id}-tag-${String(i)}`} className="pill on" style={{ height: 25, fontSize: 12, fontWeight: 600 }}>
            {tagText}
            {adornTag?.(tagText, i)}
            <button
              type="button" aria-label={`Remove ${tagText}`} data-testid={`${id}-remove-${String(i)}`}
              onClick={(e) => { e.stopPropagation(); remove(i); }}
              style={{ border: 0, background: "none", cursor: "pointer", padding: 0, marginLeft: 1, color: "inherit", fontSize: 13, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        ))}
        {/*
          THE GHOST IS PAINTED UNDER THE INPUT, not inserted into it: the value stays exactly what
          the doctor typed, so an Enter at any moment commits their text and not ours. The mono
          face and the input's own metrics have to agree, which is why both sit at 13px.
        */}
        <span style={{ position: "relative", flexGrow: 1, minWidth: 120, display: "inline-flex" }}>
          {ghost !== null && (
            <span aria-hidden="true" data-testid={`${id}-ghost`} style={{ position: "absolute", left: 0, top: 0, height: 26, display: "flex", alignItems: "center", fontSize: 13, color: "var(--faint)", pointerEvents: "none", whiteSpace: "pre" }}>
              <span style={{ visibility: "hidden" }}>{draft}</span>{ghost}
            </span>
          )}
          <input
            id={id} ref={inputRef} value={draft} disabled={disabled}
            onChange={(e) => { setDraft(e.target.value); }}
            onKeyDown={onKeyDown}
            placeholder={tags.length === 0 ? placeholder : undefined}
            style={{ flexGrow: 1, minWidth: 120, height: 26, border: 0, outline: "none", background: "transparent", fontSize: 13, padding: 0, color: "inherit" }}
          />
        </span>
      </div>

      {items.length > 0 && (
        <div data-testid={`${id}-suggestions`} style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
          {items.map((s) => (
            <button
              key={s.term} type="button" className="sec" data-testid={`${id}-suggest-${s.term}`}
              style={{ height: 26, fontSize: 12, padding: "0 10px" }}
              onClick={() => { commit(s.term); inputRef.current?.focus(); }}
            >
              {s.term}
              {s.hint !== undefined && s.hint !== null && (
                <span className="mo" style={{ fontSize: 10, color: "var(--faint)" }}>{s.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {hint !== undefined && hint !== null && hint !== "" && (
        <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--faint)" }}>{hint}</p>
      )}
    </div>
  );
}
