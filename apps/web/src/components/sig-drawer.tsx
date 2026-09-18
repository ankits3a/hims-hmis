import { useTranslation } from "react-i18next";

/**
 * ═══ THE SIG DRAWER — THREE TAPS INSTEAD OF THREE FIELDS (P26) ═══
 *
 * Owner, 2026-09-17: the prescription tab should let a doctor set how a drug is taken by tapping,
 * the way the reference UI does — frequency, food timing, duration, each one tap with a sensible
 * default already chosen.
 *
 * ═══ IT SITS IN FRONT OF THE LINE'S FIELDS AND WRITES INTO THEM ═══
 *
 * Phase doc ruling: an ACCELERATOR, never a gate. Every pill writes a value the line already
 * accepts — `frequency` is the shipped enum, `instructions` is the same free text, `durationDays`
 * the same number — and the line's own inputs stay visible and editable beside it. A doctor who
 * wants `1-0-0 for 4 days`, or "alternate days", or anything the pills do not offer, types it as
 * they always have, and the drawer has cost them nothing but a tap they did not take.
 *
 * That is why it renders INLINE rather than as a modal. A modal over the line would make the
 * preset list a gate in practice — every gap in it a prescription somebody has to dismiss a dialog
 * to write — and would put an overlay between the doctor and the fields they were already using.
 *
 * ═══ NO INDICATION PICKER, DELIBERATELY ═══
 *
 * The reference UI offers per-drug indications ("Acute Otitis Media", "Bacterial Sinusitis"). We
 * have no such data, and the bundle's own `prescribing_defaults.common_indications` was found to be
 * template-generated — an antiemetic carrying reflux indications, artificial tears carrying
 * pre-operative anaesthesia. Offering a doctor a guessed indication to attach to a prescription is
 * the kind of invention this project does not do. The indication belongs to the consultation note,
 * where a person wrote it.
 *
 * ═══ THE NOTATION IS THE LABEL, THE ENUM IS THE VALUE ═══
 *
 * `1-0-1` is how a prescription is said aloud in an Indian OPD and `BD` is what this system stores.
 * The pill shows both. Nothing new is stored, so every downstream reader — the print, the FHIR
 * bundle, the pharmacy queue — is untouched.
 */
export type SigPatch = { frequency?: string; instructions?: string; durationDays?: string };

/** Each pill's value is a member of the shipped `FREQUENCY_OPTIONS`; the dashes are presentation. */
const FREQUENCY_PILLS = [
  { value: "BD", notation: "1-0-1" },
  { value: "TDS", notation: "1-1-1" },
  { value: "OD", notation: "1-0-0" },
  { value: "QID", notation: "1-1-1-1" },
  { value: "HS", notation: "0-0-1" },
  { value: "SOS", notation: null },
  { value: "STAT", notation: null },
] as const;

/** Written into `instructions`, which is free text on the line and free text on the printed slip. */
const TIMING_PILLS = ["afterFood", "beforeFood", "withFood", "emptyStomach"] as const;

const DURATION_PILLS = [3, 5, 7, 10, 14, 30] as const;

export function SigDrawer({
  lineIndex, drugName, frequency, instructions, durationDays, onPatch, onClose,
}: {
  lineIndex: number;
  drugName: string;
  frequency: string;
  instructions: string;
  durationDays: string;
  onPatch: (patch: SigPatch) => void;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const id = `sig-${String(lineIndex)}`;

  /*
    THE SELECTED PILL USES THE HOUSE CLASSES, because the first draft invented `var(--brand)` — a
    token this design system does not define — and a browser walk showed the chosen pill rendering
    white on white. It was still in the DOM with `aria-pressed="true"`, so every test passed while
    the doctor could not see which frequency they had picked. `pri`/`sec` is the pair the skip
    dialog already uses for exactly this.
  */
  const pillClass = (selected: boolean): string => (selected ? "pri" : "sec");
  const pillStyle: React.CSSProperties = { padding: "3px 10px", fontSize: 11.5, borderRadius: 999 };
  const row: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" };
  const label: React.CSSProperties = { fontSize: 10.5, color: "var(--faint)", minWidth: 62 };

  return (
    <div
      data-testid={`${id}-drawer`}
      className="box"
      style={{
        marginTop: 7, padding: "9px 11px", display: "flex", flexDirection: "column", gap: 7,
        borderColor: "var(--line2)", background: "var(--card2, transparent)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{drugName}</span>
        <button
          type="button" className="sec" data-testid={`${id}-close`} onClick={onClose}
          style={{ padding: "1px 9px", fontSize: 11 }}
        >
          {t("sigDrawer.close")}
        </button>
      </div>

      <div style={row}>
        <span style={label}>{t("sigDrawer.frequency")}</span>
        {FREQUENCY_PILLS.map((f) => (
          <button
            key={f.value} type="button" data-testid={`${id}-freq-${f.value}`}
            aria-pressed={frequency === f.value}
            className={pillClass(frequency === f.value)} style={pillStyle}
            onClick={() => { onPatch({ frequency: f.value }); }}
          >
            {f.notation === null
              ? t(`opdConsult.frequencyOption.${f.value}`)
              : `${f.notation} (${f.value})`}
          </button>
        ))}
      </div>

      <div style={row}>
        <span style={label}>{t("sigDrawer.timing")}</span>
        {TIMING_PILLS.map((k) => {
          const text = t(`sigDrawer.timingOption.${k}`);
          return (
            <button
              key={k} type="button" data-testid={`${id}-timing-${k}`}
              aria-pressed={instructions === text}
              className={pillClass(instructions === text)} style={pillStyle}
              onClick={() => { onPatch({ instructions: instructions === text ? "" : text }); }}
            >
              {text}
            </button>
          );
        })}
      </div>

      <div style={row}>
        <span style={label}>{t("sigDrawer.duration")}</span>
        {DURATION_PILLS.map((d) => (
          <button
            key={d} type="button" data-testid={`${id}-days-${String(d)}`}
            aria-pressed={durationDays === String(d)}
            className={pillClass(durationDays === String(d))} style={pillStyle}
            onClick={() => { onPatch({ durationDays: durationDays === String(d) ? "" : String(d) }); }}
          >
            {t("sigDrawer.days", { n: d })}
          </button>
        ))}
      </div>

      {/* The honest line: these are shortcuts into the fields above, not a form of their own. */}
      <span style={{ fontSize: 10.5, color: "var(--faint)" }}>{t("sigDrawer.hint")}</span>
    </div>
  );
}
