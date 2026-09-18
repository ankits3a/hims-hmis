import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * ═══ THE SIG PANEL — HOW A DRUG IS TAKEN, SAID ONCE ═══
 *
 * Owner, 2026-09-17 (P26): set how a drug is taken by tapping — frequency, food timing, duration,
 * each one tap with a sensible default already chosen.
 *
 * P26 shipped those taps as a DRAWER in front of the line's own Frequency select, Days box and
 * Instructions box, and kept all three visible so a doctor could still type what the taps did not
 * offer. Owner, 2026-09-18, looking at the deployed screen: Frequency and the rest are on it twice
 * — do we need both? No. A fact shown in two controls reads as two facts, and a doctor cannot tell
 * which one the prescription will print. So this panel is now the ONLY control for the three facts,
 * and it carries its own way out for everything the taps do not offer:
 *
 *   How often     — the seven taps, and `Other`, which opens a box for `1-0-0`, `q6h`, `weekly`.
 *                   Free text is what the column always was (the scribe slip writes it free) and
 *                   `pharmacy/qty.ts` already reads triplets and `qNh`.
 *   With food     — four taps. They own the FIRST clause of `instructions`; the Instructions box
 *                   below owns the rest, so "After food" is never on screen twice.
 *   For how long  — six taps, and `Other`, which opens a number box.
 *
 * NOTHING NEW IS STORED. `frequency`, `durationDays` and `instructions` are the fields the line has
 * always posted, and the print, the FHIR bundle and the pharmacy queue read them unchanged.
 *
 * ═══ ALWAYS OPEN, UNDER ITS OWN LINE ═══
 *
 * The drawer opened only when a drug was PICKED from the list. As the only control, that would
 * leave a hand-typed line with no way to say how often — and a hand-typed line is legal for ever
 * (16a design law 1). So every line has one, inside that line's own block.
 *
 * ═══ ONE TAB STOP PER ROW ═══
 *
 * Each row is a radio group with a roving tab stop: Tab reaches the row once, the arrow keys move
 * the choice. Twenty-odd buttons in the tab order would have made the keyboard path (§15) slower
 * than the select it replaced.
 *
 * ═══ NO INDICATION PICKER, DELIBERATELY ═══
 *
 * The reference UI offers per-drug indications. We have no such data, and the bundle's own
 * `prescribing_defaults.common_indications` was found to be template-generated — an antiemetic
 * carrying reflux indications. The indication belongs to the consultation note, where a person
 * wrote it.
 */
export type SigPatch = { frequency?: string; instructions?: string; durationDays?: string };

/** `1-0-1` is how a prescription is said aloud in an Indian OPD; `BD` is what this system stores. */
const FREQUENCY_PILLS = [
  { value: "BD", notation: "1-0-1" },
  { value: "TDS", notation: "1-1-1" },
  { value: "OD", notation: "1-0-0" },
  { value: "QID", notation: "1-1-1-1" },
  { value: "HS", notation: "0-0-1" },
  { value: "SOS", notation: null },
  { value: "STAT", notation: null },
] as const;
const FREQUENCY_VALUES: readonly string[] = FREQUENCY_PILLS.map((f) => f.value);

const TIMING_PILLS = ["afterFood", "beforeFood", "withFood", "emptyStomach"] as const;

const DURATION_PILLS = [3, 5, 7, 10, 14, 30] as const;
const DURATION_VALUES: readonly string[] = DURATION_PILLS.map(String);

/** The clause separator between the food timing and the doctor's own note, as printed. */
const SEP = ", ";

/**
 * `instructions` is ONE free-text column. The timing taps own its first clause when that clause is
 * exactly one of their texts; everything else is the doctor's note. A note typed by hand that
 * happens to begin with "After food, " is read the same way, which is what it means.
 */
export function splitInstructions(instructions: string, timings: readonly string[]): { timing: string | null; note: string } {
  for (const t of timings) {
    if (instructions === t) return { timing: t, note: "" };
    if (instructions.startsWith(t + SEP)) return { timing: t, note: instructions.slice(t.length + SEP.length) };
  }
  return { timing: null, note: instructions };
}

export function joinInstructions(timing: string | null, note: string): string {
  if (timing === null) return note;
  return note === "" ? timing : timing + SEP + note;
}

type Pill = { key: string; text: string; testId: string };

/**
 * A row of taps that behaves as a radio group. `clearable` rows let a second tap on the chosen pill
 * clear it (a wrong tap costs one tap); the frequency row is not clearable, because a line must
 * say how often.
 */
function PillRow({
  label, pills, selected, clearable, onPick,
}: {
  label: string;
  pills: Pill[];
  selected: string | null;
  clearable: boolean;
  onPick: (key: string | null) => void;
}): React.ReactElement {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = pills.findIndex((p) => p.key === selected);
  const stop = chosen === -1 ? 0 : chosen;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const from = refs.current.findIndex((b) => b === e.target);
    if (from === -1) return;
    let to: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (from + 1) % pills.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (from - 1 + pills.length) % pills.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = pills.length - 1;
    else return;
    e.preventDefault();
    refs.current[to]?.focus();
    onPick(pills[to]!.key);
  };

  /*
    THE SELECTED PILL USES THE HOUSE CLASSES. P26's first draft invented `var(--brand)` — a token
    this design system does not define — and a browser walk showed the chosen pill white on white
    while every test passed. `pri`/`sec` is the pair the skip dialog already uses.
  */
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown} style={ROW}>
      <span style={LABEL} aria-hidden="true">{label}</span>
      {pills.map((p, n) => {
        const on = p.key === selected;
        return (
          <button
            key={p.key} ref={(el) => { refs.current[n] = el; }}
            type="button" role="radio" aria-checked={on} data-testid={p.testId}
            tabIndex={n === stop ? 0 : -1}
            className={on ? "pri" : "sec"} style={PILL}
            onClick={() => { onPick(on ? (clearable ? null : p.key) : p.key); }}
          >
            {p.text}
          </button>
        );
      })}
    </div>
  );
}

const ROW: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" };
const LABEL: React.CSSProperties = { fontSize: 10.5, color: "var(--faint)", minWidth: 74 };
const PILL: React.CSSProperties = { padding: "3px 10px", fontSize: 11.5, borderRadius: 999 };
const BOX: React.CSSProperties = { padding: "3px 8px", fontSize: 12.5 };

export function SigPanel({
  lineIndex, frequency, instructions, durationDays, frequencyError, daysError, onPatch,
}: {
  lineIndex: number;
  frequency: string;
  instructions: string;
  durationDays: string;
  frequencyError?: string;
  daysError?: string;
  onPatch: (patch: SigPatch) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const id = `sig-${String(lineIndex)}`;

  const timingTexts = TIMING_PILLS.map((k) => t(`sigDrawer.timingOption.${k}`));
  const { timing, note } = splitInstructions(instructions, timingTexts);

  /* A value the taps do not hold is an `Other` value — including one a scribe slip or the co-pilot
     wrote in, which the doctor must be able to see and edit. */
  const freqOther = !FREQUENCY_VALUES.includes(frequency);
  const [daysOpen, setDaysOpen] = useState(false);
  const daysOther = daysOpen || (durationDays !== "" && !DURATION_VALUES.includes(durationDays));

  /* Focus follows a TAP on Other, never a render: a line loaded with 21 days must not steal focus. */
  const focusNext = useRef<"freq" | "days" | null>(null);
  const freqInput = useRef<HTMLInputElement>(null);
  const daysInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusNext.current === "freq") freqInput.current?.focus();
    if (focusNext.current === "days") daysInput.current?.focus();
    focusNext.current = null;
  });

  const other = t("sigDrawer.other");

  return (
    <div
      data-testid={`${id}-panel`}
      style={{ margin: "0 0 11px", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 7, border: "1px solid var(--line2)", borderRadius: 8 }}
    >
      <PillRow
        label={t("sigDrawer.frequency")}
        pills={[
          ...FREQUENCY_PILLS.map((f) => ({
            key: f.value,
            text: f.notation === null ? t(`opdConsult.frequencyOption.${f.value}`) : `${f.notation} (${f.value})`,
            testId: `${id}-freq-${f.value}`,
          })),
          { key: "other", text: other, testId: `${id}-freq-other` },
        ]}
        selected={freqOther ? "other" : frequency}
        clearable={false}
        onPick={(k) => {
          if (k === "other") {
            if (!freqOther) { focusNext.current = "freq"; onPatch({ frequency: "" }); }
            return;
          }
          if (k !== null) onPatch({ frequency: k });
        }}
      />
      {freqOther && (
        <div style={{ ...ROW, paddingLeft: 79 }}>
          <input
            ref={freqInput} id={`f-lines.${String(lineIndex)}.frequency`} data-field
            aria-label={t("opdConsult.frequency")} placeholder={t("sigDrawer.frequencyPlaceholder")}
            className="rounded border" style={{ ...BOX, width: 260, maxWidth: "100%" }}
            value={frequency} onChange={(e) => { onPatch({ frequency: e.target.value }); }}
          />
        </div>
      )}
      {frequencyError !== undefined && <p role="alert" style={{ margin: 0, paddingLeft: 79, fontSize: 11.5, color: "var(--red)" }}>{frequencyError}</p>}

      <PillRow
        label={t("sigDrawer.timing")}
        pills={TIMING_PILLS.map((k, n) => ({ key: timingTexts[n]!, text: timingTexts[n]!, testId: `${id}-timing-${k}` }))}
        selected={timing}
        clearable
        onPick={(k) => { onPatch({ instructions: joinInstructions(k, note) }); }}
      />

      <PillRow
        label={t("sigDrawer.duration")}
        pills={[
          ...DURATION_PILLS.map((d) => ({ key: String(d), text: t("sigDrawer.days", { n: d }), testId: `${id}-days-${String(d)}` })),
          { key: "other", text: other, testId: `${id}-days-other` },
        ]}
        selected={daysOther ? "other" : (durationDays === "" ? null : durationDays)}
        clearable
        onPick={(k) => {
          if (k === "other") {
            setDaysOpen(true);
            focusNext.current = "days";
            if (DURATION_VALUES.includes(durationDays)) onPatch({ durationDays: "" });
            return;
          }
          setDaysOpen(false);
          onPatch({ durationDays: k ?? "" });
        }}
      />
      {daysOther && (
        <div style={{ ...ROW, paddingLeft: 79 }}>
          <input
            ref={daysInput} id={`f-lines.${String(lineIndex)}.durationDays`} data-field
            type="number" min={1} step={1} aria-label={t("opdConsult.durationDays")}
            className="rounded border" style={{ ...BOX, width: 80 }}
            value={durationDays} onChange={(e) => { onPatch({ durationDays: e.target.value }); }}
          />
          <span style={{ fontSize: 11.5, color: "var(--dim)" }}>{t("sigDrawer.daysUnit")}</span>
        </div>
      )}
      {daysError !== undefined && <p role="alert" style={{ margin: 0, paddingLeft: 79, fontSize: 11.5, color: "var(--red)" }}>{daysError}</p>}

      <div style={ROW}>
        <label htmlFor={`f-lines.${String(lineIndex)}.instructions`} style={LABEL}>{t("opdConsult.instructions")}</label>
        <input
          id={`f-lines.${String(lineIndex)}.instructions`} data-field
          placeholder={t("sigDrawer.notePlaceholder")}
          className="rounded border" style={{ ...BOX, flex: "1 1 200px", minWidth: 0 }}
          value={note} onChange={(e) => { onPatch({ instructions: joinInstructions(timing, e.target.value) }); }}
        />
      </div>
    </div>
  );
}
