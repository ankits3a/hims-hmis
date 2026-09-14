import { useEffect, useRef, useState } from "react";
import { expandSnippet, keywordEndingAt } from "./snippets";
import type { SnippetContext, SnippetStop } from "./snippets";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * AUTO-EXPANSION AND TAB STOPS, FOR ANY TEXT FIELD ON THE CONSULT SCREEN
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-09-14: Raycast-style snippets — a keyword that expands as you type, and Tab to move
 * through what is left to fill.
 *
 * ═══ WHY TAB IS SAFE TO TAKE HERE, AND ONLY HERE ═══
 *
 * Tab moves focus, and a field that swallowed it would trap a doctor who navigates by keyboard.
 * So it is intercepted ONLY while stops are outstanding — the few seconds after an expansion — and
 * the LAST Tab of a snippet is deliberately not swallowed: it leaves the field, so the gesture ends
 * where the doctor expects it to. Escape abandons the stops and gives Tab straight back.
 *
 * ═══ THE STOPS MOVE AS THE DOCTOR TYPES ═══
 *
 * Filling stop 1 makes stops 2 and 3 slide along by however much was typed. They are therefore
 * shifted on every edit rather than recomputed — recomputing would need markers left in the text,
 * and a marker that escapes into `opd_encounters.advice` is a marker printed on a patient's slip.
 * Nothing this hook does is ever stored: expansion happens at insert time and what remains is
 * ordinary text.
 */
export type SnippetDef = { keyword: string | null; body: string };

type FieldEl = HTMLInputElement | HTMLTextAreaElement;

export function useSnippets({
  value, onChange, snippets, context, enabled = true,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Every snippet the doctor may trigger here. One body per keyword — the language is chosen when it is saved. */
  snippets: SnippetDef[];
  context: SnippetContext;
  enabled?: boolean;
}): {
  ref: React.RefObject<FieldEl | null>;
  stops: SnippetStop[];
  stopIndex: number;
  onChangeValue: (next: string, caret: number) => void;
  onKeyDown: (e: React.KeyboardEvent<FieldEl>) => void;
  onBlur: () => void;
  /** Insert a body at the caret without a keyword — what a TAPPED template does. */
  insert: (body: string) => void;
} {
  const ref = useRef<FieldEl | null>(null);
  const [stops, setStops] = useState<SnippetStop[]>([]);
  const [stopIndex, setStopIndex] = useState(-1);
  /* A controlled field cannot have its selection set until React has painted the new value. */
  const pendingSel = useRef<{ start: number; end: number } | null>(null);
  /*
    ═══ THE TICK EXISTS BECAUSE TAB DOES NOT CHANGE THE TEXT ═══

    The selection below is applied by an effect, because a controlled field cannot have its caret
    moved until React has painted the new value. Keying that effect on `value` alone looked right
    and silently broke Tab: moving between blanks changes the CARET and not one character of text,
    so the effect never ran, the caret stayed where typing had left it, and the next word landed
    against the previous one — "2 tabletstwice daily". The stop arithmetic was correct the whole
    time, which is what made it look like an off-by-one.
  */
  const [selTick, setSelTick] = useState(0);
  /*
    ═══ THE PREVIOUS VALUE IS HELD IN A REF, AND THE CLOSURE WOULD HAVE BEEN WRONG ═══

    The shift below needs the length of the text BEFORE this edit. Reading `value` from the render
    closure looked equivalent and is not: keystrokes arrive faster than React re-renders, so two
    edits in one frame both measure against the same stale string and the later stops drift by the
    difference. It showed up as a Tab landing one character early — "2 tabletstwice daily" — which
    is exactly the kind of off-by-one that reads as a cosmetic glitch and is a wrong sentence on a
    patient's slip.
  */
  const lastValue = useRef(value);

  useEffect(() => {
    const sel = pendingSel.current;
    const el = ref.current;
    if (sel === null || el === null) return;
    pendingSel.current = null;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
  }, [value, selTick]);

  const land = (list: SnippetStop[], i: number): void => {
    const stop = list[i];
    if (stop === undefined) return;
    setStopIndex(i);
    /* A stop with a DEFAULT arrives selected, so the first keystroke replaces it. */
    pendingSel.current = { start: stop.start, end: stop.end };
    setSelTick((n) => n + 1);
  };

  const applyExpansion = (next: string, start: number, caret: number, body: string): void => {
    const { text, stops: raw } = expandSnippet(body, context);
    const merged = next.slice(0, start) + text + next.slice(caret);
    const shifted = raw.map((s) => ({ ...s, start: s.start + start, end: s.end + start }));
    onChange(merged);
    lastValue.current = merged;
    setStops(shifted);
    if (shifted.length > 0) {
      land(shifted, 0);
    } else {
      setStopIndex(-1);
      pendingSel.current = { start: start + text.length, end: start + text.length };
      setSelTick((n) => n + 1);
    }
  };

  const onChangeValue = (next: string, caret: number): void => {
    if (enabled) {
      const keywords = snippets.map((s) => s.keyword).filter((k): k is string => k !== null && k !== "");
      const hit = keywordEndingAt(next, caret, keywords);
      if (hit !== null) {
        const def = snippets.find((s) => s.keyword === hit.keyword);
        if (def !== undefined) { applyExpansion(next, hit.start, caret, def.body); return; }
      }
    }
    /*
      An ordinary edit. Everything after the point of the edit slides by the same amount, so the
      stops the doctor has not reached yet stay on the words they were put beside.
    */
    const delta = next.length - lastValue.current.length;
    if (stops.length > 0 && delta !== 0) {
      /* `caret` is where the edit ENDED; an insertion of k began k characters earlier. */
      const editedAt = caret - Math.max(delta, 0);
      setStops((cur) => cur.map((s) => (s.start >= editedAt ? { ...s, start: s.start + delta, end: s.end + delta } : s)));
    }
    lastValue.current = next;
    onChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<FieldEl>): void => {
    if (stops.length === 0) return;
    if (e.key === "Escape") {
      /* Hand Tab back at once. A doctor who wants out should not have to tab through the rest. */
      setStops([]); setStopIndex(-1);
      return;
    }
    if (e.key !== "Tab" || e.shiftKey) return;
    const next = stopIndex + 1;
    if (next >= stops.length) {
      /* The last Tab LEAVES. Swallowing it would strand a keyboard user in the field. */
      setStops([]); setStopIndex(-1);
      return;
    }
    e.preventDefault();
    land(stops, next);
  };

  const insert = (body: string): void => {
    lastValue.current = value;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    applyExpansion(value, caret, caret, body);
  };

  /* Stale stops on a field the doctor has left are a Tab that does something surprising later. */
  const onBlur = (): void => { setStops([]); setStopIndex(-1); };

  return { ref, stops, stopIndex, onChangeValue, onKeyDown, onBlur, insert };
}
