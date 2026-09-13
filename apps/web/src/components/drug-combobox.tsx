import { useEffect, useId, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useDebounced } from "../lib/format";

/**
 * THE PRESCRIBER'S DRUG FIELD — free text that can also search the formulary.
 *
 * === FREE TYPING IS ALWAYS LEGAL, AND THAT IS DESIGN LAW 1 ===
 *
 * Prescribing is never blocked by formulary coverage. This is an input the doctor can type anything
 * into; the list is an offer. If the request 403s, times out, or returns nothing, the field still
 * works exactly as the plain text box it replaces — which is why the list is rendered from query
 * DATA and never gated on query state.
 *
 * === WHAT A PICK WRITES, AND WHAT IT DELIBERATELY DOES NOT ===
 *
 * A pick writes the drug NAME. It does not write `medicineId`, because there are no branded
 * medicines and because setting it on an uncurated catalogue makes coverage report a formulary that
 * is working while nothing is checked (see `modules/formulary/suggest.ts` for the measured
 * argument). It NULLS `medicineId` on every change, exactly as the plain field did — C1's rule that
 * typing over a picked name must drop the id, kept rather than re-derived.
 *
 * === TAB PICKS. THAT IS NOT A DETAIL ===
 *
 * A doctor filling a prescription moves Drug -> Dose -> Frequency with Tab, and will hit Tab with
 * a row highlighted far more often than Enter. If Tab only moved focus, the highlighted row would
 * be silently discarded and the typed fragment kept — the field would look like it worked.
 *
 * This repo has already paid for that exact assumption once: 901 green tests all pressed Enter over
 * a two-stage input where only Enter promoted a value, and the Tab path charted nothing. So Tab
 * commits the active row AND advances, and it has its own test.
 */

export interface DrugSuggestion {
  genericId: string;
  name: string;
  doseForm: string;
  route: string;
  composition: string | null;
  matchedOn: "prefix" | "contains";
}

/** Mirrors the server's floor (`MIN_QUERY_CHARS`); below it the component does not even ask. */
const MIN_CHARS = 3;
const DEBOUNCE_MS = 250;

export function DrugCombobox({
  name,
  medicineIdName,
  label,
  testId,
}: {
  /** Form path of the drug text, e.g. `lines.0.drug`. */
  name: string;
  /** Form path of the medicine id to null on every change, e.g. `lines.0.medicineId`. */
  medicineIdName: string;
  label: string;
  testId: string;
}): React.ReactElement {
  const { register, setValue, watch } = useFormContext();
  const typed = String(watch(name) ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debounced = useDebounced(typed, DEBOUNCE_MS);
  const q = debounced.trim();

  const suggest = useQuery({
    queryKey: ["formulary", "suggest", q],
    queryFn: () => api<{ items: DrugSuggestion[] }>(
      "GET", `/formulary/suggest?q=${encodeURIComponent(q)}`,
    ),
    enabled: q.length >= MIN_CHARS,
    retry: false,
  });
  const items = suggest.data?.items ?? [];
  const showList = open && q.length >= MIN_CHARS;

  // A new result set must not leave the cursor pointing past the end of the list.
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => () => { if (blurTimer.current !== null) clearTimeout(blurTimer.current); }, []);

  function commit(hit: DrugSuggestion): void {
    setValue(name, hit.name, { shouldDirty: true, shouldValidate: true });
    setValue(medicineIdName, null, { shouldDirty: true });
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!showList || items.length === 0) return;
    const hit = items[active];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      // preventDefault or Enter submits the consultation form from inside the drug field.
      e.preventDefault();
      if (hit !== undefined) commit(hit);
    } else if (e.key === "Tab") {
      // NOT prevented: the pick happens AND focus advances to Dose, which is the whole point.
      if (hit !== undefined) commit(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <label className="block text-sm font-medium" htmlFor={`f-${name}`}>{label}</label>
      <input
        id={`f-${name}`}
        data-field
        data-testid={testId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && items.length > 0 ? `${listId}-${String(active)}` : undefined}
        autoComplete="off"
        className="w-full rounded border px-2 py-1"
        {...register(name, {
          onChange: () => {
            setValue(medicineIdName, null, { shouldDirty: true });
            setOpen(true);
          },
        })}
        onKeyDown={onKeyDown}
        onFocus={() => { setOpen(true); }}
        onBlur={() => {
          // A click on an option fires blur BEFORE the option's own handler, so closing
          // synchronously would unmount the row the doctor is clicking.
          blurTimer.current = setTimeout(() => { setOpen(false); }, 120);
        }}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          style={{
            position: "absolute", zIndex: 20, left: 0, right: 0, margin: 0, padding: 0,
            listStyle: "none", maxHeight: 260, overflowY: "auto",
            background: "#fff", border: "1px solid #d4d4d8", borderRadius: 4,
          }}
        >
          {items.length === 0 && (
            /*
              NOT an error, and deliberately not styled as one. An unmatched drug is the normal case
              on a formulary that is still being filled, and the doctor's typed text stands.
            */
            <li style={{ padding: "6px 8px", fontSize: 12, color: "#71717a" }}>
              {suggest.isError
                ? "Formulary unavailable — type the drug name"
                : "Not in the formulary — type the drug name"}
            </li>
          )}
          {items.map((hit, i) => (
            <li
              key={hit.genericId}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              data-testid={`${testId}-opt-${String(i)}`}
              onMouseDown={(e) => {
                // mousedown, not click: click lands after blur has already closed the list.
                e.preventDefault();
                commit(hit);
              }}
              onMouseEnter={() => { setActive(i); }}
              style={{
                padding: "6px 8px", cursor: "pointer", fontSize: 13,
                background: i === active ? "#eef2ff" : "transparent",
              }}
            >
              <div style={{ fontWeight: 500 }}>{hit.name}</div>
              {/*
                Dose form is NOT decoration: 774 groups of generics share an identical composition
                line, and dose form resolves 97.7% of those collisions. A row without it can show
                the doctor two entries that claim to be the same drug.
              */}
              <div style={{ fontSize: 11, color: "#71717a" }}>
                {hit.doseForm}{hit.route === "" ? "" : ` · ${hit.route}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
