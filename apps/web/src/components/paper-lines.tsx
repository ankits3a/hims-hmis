import { useRef } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { DrugField } from "./drug-field";
import type { NicknameContext } from "../lib/suggest-signals";
import type { WireHeldAlert, WireRxLine } from "../lib/opd-api";
import { RX_FREQUENCIES, snapFrequency } from "../../../../packages/contracts/src/rx-line";

/**
 * ═══ THE PRESCRIPTION, TYPED FROM PAPER — ONE EDITOR FOR THE SCRIBE AND THE DOCTOR (owner 2026-10-06) ═══
 *
 * The desk scribe types what the doctor wrote; the doctor, if they choose to look, corrects what
 * the scribe typed. Both edit the SAME line the consultation screen issues (`WireRxLine`, the
 * catalogue typeahead `DrugField` with its `medicineId`), so the safety checks see a typed line
 * exactly as they see a doctor's.
 *
 * KEYBOARD FIRST. The scribe types forty slips an afternoon:
 *   · Tab walks medicine → dose → frequency → days → route → instructions → the next line;
 *   · Enter on any field of a line ADDS a line below and lands in its medicine box
 *     (in the medicine box with a suggestion highlighted, Enter picks the suggestion instead);
 *   · Backspace in an EMPTY medicine box removes that line and steps back;
 *   · ↓ / ↑ walk the medicine suggestions.
 * The remove button is out of the tab order on purpose — Tab never lands on a destructive key.
 *
 * WARNINGS ARE SHOWN, NOT CLEARED, unless `reasons` is given. The scribe's table shows each warning
 * and says the line will be held for the doctor. The doctor's table (`reasons`) puts a reason box
 * under a hard warning, because clearing one is the prescriber's judgement and nobody else's.
 */
export const EMPTY_LINE: WireRxLine = {
  drug: "", dose: "", route: "oral", frequency: "", durationDays: null, instructions: null, noSubstitution: false,
};

/* Decision 0050 P0 — the ONE closed set every screen writes (`contracts/rx-line.ts`), and one common "other". */
const FREQUENCIES = [...RX_FREQUENCIES, "Once a week"] as const;
const ROUTES = ["oral", "topical", "inhaled", "eye", "ear", "nasal", "IM", "IV", "SC", "rectal", "sublingual"] as const;

/** A line somebody has started: it has a medicine name. Blank editor rows are not lines. */
export function startedLines(lines: WireRxLine[]): { line: WireRxLine; at: number }[] {
  return lines.map((line, at) => ({ line, at })).filter((x) => x.line.drug.trim() !== "");
}

/** What the server will refuse for: a started line with no dose or no frequency. Indexes into `lines`. */
export function incompleteAt(lines: WireRxLine[]): number[] {
  return startedLines(lines).filter((x) => x.line.dose.trim() === "" || x.line.frequency.trim() === "" || x.line.route.trim() === "").map((x) => x.at);
}

/** The lines as the server takes them: started ones only, trimmed. */
export function cleanLines(lines: WireRxLine[]): WireRxLine[] {
  return startedLines(lines).map(({ line }) => ({
    ...line,
    drug: line.drug.trim(), dose: line.dose.trim(), route: line.route.trim(),
    instructions: line.instructions === null || line.instructions.trim() === "" ? null : line.instructions.trim(),
    /* The paper said "1-0-1"; the record says BD. Whatever is not plainly one of the set stays as typed. */
    frequency: snapFrequency(line.frequency),
    /* Decision 0050 P0 — a line on this table was typed from the doctor's paper, whoever corrects it after. */
    source: "paper" as const,
  }));
}

/** One warning in the reader's language — built from the server's fields, with its sentence as the fallback. */
export function alertText(t: TFunction, a: WireHeldAlert): string {
  if (a.kind === "allergy" && a.substance !== undefined) return t("paper.alert.allergy", { substance: a.substance });
  if (a.kind === "interaction" && a.saltPair !== undefined) return t("paper.alert.interaction", { a: a.saltPair[0], b: a.saltPair[1] });
  if (a.kind === "duplicate" && a.moiety !== undefined) return t("paper.alert.duplicate", { moiety: a.moiety });
  return a.text;
}

export function PaperLinesEditor({
  idPrefix, lines, onChange, alerts, reasons, onReason, disabled = false, nicknames,
}: {
  /** Which screen and visit a learned nickname's tap or cross belongs to (decision 0051); absent, the field offers none. */
  nicknames?: NicknameContext;
  idPrefix: string;
  lines: WireRxLine[];
  onChange: (next: WireRxLine[]) => void;
  /** Warnings by index into `lines`. */
  alerts: ReadonlyMap<number, WireHeldAlert[]>;
  /** The doctor's reasons by index into `lines`. Absent on the scribe's table: a scribe clears nothing. */
  reasons?: ReadonlyMap<number, string>;
  onReason?: (at: number, reason: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const { t } = useTranslation();
  const table = useRef<HTMLDivElement | null>(null);
  const doctor = reasons !== undefined;

  const patch = (i: number, change: Partial<WireRxLine>): void => {
    onChange(lines.map((l, j) => (j === i ? { ...l, ...change } : l)));
  };
  /*
    THE FOCUS MOVES IN THE SAME KEYSTROKE (browser walk, 2026-10-06). The first version moved it on
    a timer, and a scribe typing at speed — or a scanner — put the first letter of the next medicine
    into the field they had just left: "5" days became "5p", which is not a number, and the days
    were silently gone. So the new row is rendered synchronously and focused before this handler
    returns; there is no instant at which the next keystroke has nowhere right to land.
  */
  const commitAndFocus = (next: WireRxLine[], i: number): void => {
    flushSync(() => { onChange(next); });
    table.current?.querySelector<HTMLInputElement>(`#${idPrefix}-drug-${String(i)}`)?.focus();
  };
  const addAfter = (i: number): void => {
    if ((lines[i]?.drug ?? "").trim() === "") return; // an empty line is not a reason for another one
    commitAndFocus([...lines.slice(0, i + 1), { ...EMPTY_LINE }, ...lines.slice(i + 1)], i + 1);
  };
  const remove = (i: number): void => {
    commitAndFocus(lines.length === 1 ? [{ ...EMPTY_LINE }] : lines.filter((_, j) => j !== i), Math.max(0, i - 1));
  };
  const onRowKey = (i: number) => (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) { e.preventDefault(); addAfter(i); }
  };

  return (
    <div className="pl" ref={table} data-testid={`${idPrefix}-lines`}>
      <datalist id={`${idPrefix}-freqs`}>{FREQUENCIES.map((f) => <option key={f} value={f} />)}</datalist>
      <datalist id={`${idPrefix}-routes`}>{ROUTES.map((r) => <option key={r} value={r} />)}</datalist>
      <div className="pl-head" aria-hidden="true">
        <span>{t("paper.lines.medicine")}</span><span>{t("paper.lines.dose")}</span><span>{t("paper.lines.frequency")}</span>
        <span>{t("paper.lines.days")}</span><span>{t("paper.lines.route")}</span><span>{t("paper.lines.instructions")}</span><span />
      </div>
      {lines.map((l, i) => {
        const mine = alerts.get(i) ?? [];
        const hard = mine.filter((a) => a.hard);
        const started = l.drug.trim() !== "";
        const missDose = started && l.dose.trim() === "";
        const missFreq = started && l.frequency.trim() === "";
        return (
          <div key={i} className="pl-row" data-testid={`${idPrefix}-line-${String(i)}`} data-held={hard.length > 0 && !doctor ? "true" : undefined}>
            <div className="pl-cells">
              <label className="pl-c drug">
                <span className="pl-l">{t("paper.lines.medicine")}</span>
                <div
                  onKeyDown={(e) => {
                    if (e.key === "Backspace" && l.drug === "" && lines.length > 1) { e.preventDefault(); remove(i); }
                  }}
                >
                  <DrugField
                    {...(nicknames === undefined ? {} : { nicknames })}
                    inputId={`${idPrefix}-drug-${String(i)}`}
                    value={l.drug}
                    placeholder={t("paper.lines.medicineHint")}
                    onText={(text) => { patch(i, { drug: text, medicineId: null }); }}
                    onPick={(hit) => { patch(i, { drug: hit.name, medicineId: hit.id }); }}
                    onEnter={() => { addAfter(i); }}
                  />
                </div>
              </label>
              <label className="pl-c">
                <span className="pl-l">{t("paper.lines.dose")}</span>
                <input
                  className="in" data-testid={`${idPrefix}-dose-${String(i)}`} value={l.dose} disabled={disabled}
                  aria-invalid={missDose} placeholder={t("paper.lines.doseHint")}
                  onChange={(e) => { patch(i, { dose: e.target.value }); }} onKeyDown={onRowKey(i)}
                />
              </label>
              <label className="pl-c">
                <span className="pl-l">{t("paper.lines.frequency")}</span>
                <input
                  className="in" data-testid={`${idPrefix}-freq-${String(i)}`} value={l.frequency} disabled={disabled}
                  list={`${idPrefix}-freqs`} aria-invalid={missFreq} placeholder="BD"
                  onChange={(e) => { patch(i, { frequency: e.target.value }); }}
                  /* Leaving the box snaps "1-0-1", "bd", "twice daily" to BD; a sentence of the doctor's own is left alone. */
                  onBlur={() => { const snapped = snapFrequency(l.frequency); if (snapped !== l.frequency) patch(i, { frequency: snapped }); }}
                  onKeyDown={onRowKey(i)}
                />
              </label>
              <label className="pl-c days">
                <span className="pl-l">{t("paper.lines.days")}</span>
                <input
                  className="in" data-testid={`${idPrefix}-days-${String(i)}`} inputMode="numeric" disabled={disabled}
                  value={l.durationDays === null ? "" : String(l.durationDays)}
                  onChange={(e) => {
                    /* A keystroke that is not a digit is IGNORED, never allowed to erase the number already there. */
                    const v = e.target.value.trim();
                    if (v === "") patch(i, { durationDays: null });
                    else if (/^\d{1,3}$/.test(v) && Number(v) > 0) patch(i, { durationDays: Number(v) });
                  }}
                  onKeyDown={onRowKey(i)}
                />
              </label>
              <label className="pl-c">
                <span className="pl-l">{t("paper.lines.route")}</span>
                <input
                  className="in" data-testid={`${idPrefix}-route-${String(i)}`} value={l.route} disabled={disabled}
                  list={`${idPrefix}-routes`}
                  onChange={(e) => { patch(i, { route: e.target.value }); }} onKeyDown={onRowKey(i)}
                />
              </label>
              <label className="pl-c notes">
                <span className="pl-l">{t("paper.lines.instructions")}</span>
                <input
                  className="in" data-testid={`${idPrefix}-notes-${String(i)}`} value={l.instructions ?? ""} disabled={disabled}
                  placeholder={t("paper.lines.instructionsHint")}
                  onChange={(e) => { patch(i, { instructions: e.target.value }); }} onKeyDown={onRowKey(i)}
                />
              </label>
              <button
                type="button" className="pl-x" tabIndex={-1} disabled={disabled}
                data-testid={`${idPrefix}-drop-${String(i)}`} aria-label={t("paper.lines.remove", { n: i + 1 })}
                onClick={() => { remove(i); }}
              >×</button>
            </div>
            {(missDose || missFreq) && (
              <p className="pl-miss" data-testid={`${idPrefix}-miss-${String(i)}`}>{t("paper.lines.needsDose")}</p>
            )}
            {mine.map((a, k) => (
              <p
                key={k} className={a.hard ? "pl-alert hard" : "pl-alert"} role={a.hard ? "alert" : "status"}
                data-testid={`${idPrefix}-alert-${String(i)}-${String(k)}`}
              >
                <b>{a.hard ? (doctor ? t("paper.alert.needsReason") : t("paper.alert.held")) : t("paper.alert.noted")}</b>
                <span>{alertText(t, a)}</span>
              </p>
            ))}
            {doctor && hard.length > 0 && (
              <label className="pl-reason">
                <span>{t("paper.alert.reasonLabel")}</span>
                <input
                  className="in" data-testid={`${idPrefix}-reason-${String(i)}`} value={reasons.get(i) ?? ""}
                  placeholder={t("paper.alert.reasonHint")}
                  onChange={(e) => { onReason?.(i, e.target.value); }}
                />
              </label>
            )}
          </div>
        );
      })}
      <button
        type="button" className="sec pl-add" disabled={disabled} data-testid={`${idPrefix}-add`}
        onClick={() => { commitAndFocus([...lines, { ...EMPTY_LINE }], lines.length); }}
      >{t("paper.lines.add")} <span className="kb">⏎</span></button>
    </div>
  );
}
